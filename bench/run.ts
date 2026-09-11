/**
 * Three-library routing benchmark on geojson-path-finder's own test networks.
 *
 *   pnpm bench [--data <dir>] [--rounds 5] [--pairs 300] [--only network,large,osm]
 *
 * Every round rebuilds each library from scratch (init time) and then routes the same seeded pairs (routing
 * time). One warm-up round is discarded. Read the spread, not a single number: a difference that sits
 * inside the min–max range of both sides is noise.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { LineFinder, haversineDistance, type NetworkCollection, type Position } from '../src';
import { osmWeight, type OsmProps } from './osm-weight';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ---- CLI -------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const ROUNDS = Math.max(3, Number(arg('rounds', '5')));
const PAIRS = Number(arg('pairs', '300'));
const ONLY = new Set(arg('only', 'network,large,osm').split(','));

function resolveDataDir(): string {
  const candidates = [
    arg('data', ''),
    process.env.GLF_BENCH_DATA ?? '',
    'D:/workspace/item/gis-project/item-gis-bam/node_modules/geojson-path-finder/test',
    join(dirname(require.resolve('geojson-path-finder/package.json')), 'test'),
  ];
  const dir = candidates.find((d) => d && existsSync(join(d, 'network.json')));
  if (!dir) throw new Error('geojson-path-finder test data not found; pass --data <dir>.');
  return dir;
}

// ---- competitors -----------------------------------------------------------------------------------
interface GpfInstance {
  findPath(a: unknown, b: unknown): { path: Position[]; weight: number } | undefined;
}
type GpfCtor = new (network: unknown, options?: unknown) => GpfInstance;
const gpfModule = require('geojson-path-finder') as { default?: GpfCtor } & GpfCtor;
const GeoJsonPathFinder: GpfCtor = gpfModule.default ?? gpfModule;

interface TerraInstance {
  buildRouteGraph(network: unknown): void;
  getRoute(a: unknown, b: unknown): { geometry: { coordinates: Position[] } } | null;
}
const { TerraRoute } = require('terra-route') as { TerraRoute: new () => TerraInstance };

const point = (c: Position) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: c },
  properties: {},
});
const lengthMeters = (path: Position[]) => {
  let d = 0;
  for (let i = 0; i + 1 < path.length; i++)
    d += haversineDistance(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);
  return d;
};

/** One contestant: `init` builds from scratch, `route` answers one pair with a comparable scalar. */
interface Contestant {
  name: string;
  init(): unknown;
  /** Returns the comparable cost of the route (same unit for every contestant of a scenario), or null. */
  route(instance: unknown, a: Position, b: Position): number | null;
}

interface Scenario {
  id: string;
  title: string;
  network: NetworkCollection<OsmProps>;
  pairs: [Position, Position][];
  unit: string;
  contestants: Contestant[];
}

// ---- helpers ---------------------------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lineStringsOnly(network: NetworkCollection<OsmProps>): NetworkCollection<OsmProps> {
  return {
    type: 'FeatureCollection',
    features: network.features.filter((f) => f.geometry?.type === 'LineString'),
  };
}

/**
 * Distinct random vertex pairs from the largest component of the graph built with the scenario's own
 * weight — otherwise a travel-time scenario would mostly sample footways its weight declares impassable.
 */
function samplePairs(
  network: NetworkCollection<OsmProps>,
  count: number,
  seed: number,
  options: ConstructorParameters<typeof LineFinder<OsmProps>>[1] = {},
): [Position, Position][] {
  const { graph } = new LineFinder(network, options);
  const pool: Position[] = [];
  for (let v = 0; v < graph.vertices.count; v++) {
    const node = graph.vertices.node[v];
    const chain = graph.vertices.chain[v];
    const c = node >= 0 ? graph.nodes.component[node] : chain >= 0 ? graph.chains.component[chain] : -1;
    if (c === graph.components.largest) pool.push(graph.vertices.positions[v]);
  }
  const rand = mulberry32(seed);
  const pairs: [Position, Position][] = [];
  while (pairs.length < count) {
    const a = pool[Math.floor(rand() * pool.length)];
    const b = pool[Math.floor(rand() * pool.length)];
    if (a[0] !== b[0] || a[1] !== b[1]) pairs.push([a, b]);
  }
  return pairs;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const gc = (globalThis as { gc?: () => void }).gc;

// ---- contestants per scenario ------------------------------------------------------------------------
const km = (_a: Position, _b: Position, _p: unknown, ctx: { distance: number }) => ctx.distance / 1000;

function geoverse(
  name: string,
  options: ConstructorParameters<typeof LineFinder<OsmProps>>[1],
  routeOptions: object,
  network: NetworkCollection<OsmProps>,
  toUnit = (w: number) => w,
): Contestant {
  return {
    name,
    init: () => new LineFinder(network, options),
    route: (f, a, b) => {
      const r = (f as LineFinder<OsmProps>).route([a, b], routeOptions);
      return r.ok ? toUnit(r.weight) : null;
    },
  };
}

function gpf(name: string, options: object, network: NetworkCollection<OsmProps>): Contestant {
  return {
    name,
    init: () => new GeoJsonPathFinder(network, options),
    route: (f, a, b) => (f as GpfInstance).findPath(point(a), point(b))?.weight ?? null,
  };
}

function terra(network: NetworkCollection<OsmProps>): Contestant {
  return {
    name: 'terra-route 0.0.18 (A*+ALT)',
    init: () => {
      const t = new TerraRoute();
      t.buildRouteGraph(network);
      return t;
    },
    route: (t, a, b) => {
      const r = (t as TerraInstance).getRoute(point(a), point(b));
      return r ? lengthMeters(r.geometry.coordinates) / 1000 : null;
    },
  };
}

function buildScenarios(dir: string): Scenario[] {
  const scenarios: Scenario[] = [];
  const small = lineStringsOnly(JSON.parse(readFileSync(join(dir, 'network.json'), 'utf8')));
  const large = existsSync(join(dir, 'large-network.json'))
    ? lineStringsOnly(JSON.parse(readFileSync(join(dir, 'large-network.json'), 'utf8')))
    : null;

  if (ONLY.has('network')) {
    scenarios.push({
      id: 'network',
      title: 'network.json — shortest distance',
      network: small,
      pairs: samplePairs(small, PAIRS, 1),
      unit: 'km',
      contestants: [
        geoverse('geoverse A*', { weight: km }, { algorithm: 'astar', snap: { mode: 'exact' } }, small),
        geoverse(
          'geoverse Dijkstra',
          { weight: km },
          { algorithm: 'dijkstra', snap: { mode: 'exact' } },
          small,
        ),
        geoverse('geoverse A* + edge snap', { weight: km }, { algorithm: 'astar' }, small),
        gpf('geojson-path-finder 2.1.0', { tolerance: 1e-9 }, small),
        terra(small),
      ],
    });
  }
  if (large && ONLY.has('large')) {
    scenarios.push({
      id: 'large',
      title: 'large-network.json — shortest distance (all highway types)',
      network: large,
      pairs: samplePairs(large, PAIRS, 2),
      unit: 'km',
      contestants: [
        geoverse('geoverse A*', { weight: km }, { algorithm: 'astar', snap: { mode: 'exact' } }, large),
        geoverse(
          'geoverse Dijkstra',
          { weight: km },
          { algorithm: 'dijkstra', snap: { mode: 'exact' } },
          large,
        ),
        geoverse('geoverse A* + edge snap', { weight: km }, { algorithm: 'astar' }, large),
        gpf('geojson-path-finder 2.1.0', { tolerance: 1e-9 }, large),
        terra(large),
      ],
    });
  }
  if (large && ONLY.has('osm')) {
    const weight = (a: Position, b: Position, p: OsmProps) => osmWeight(a, b, p);
    scenarios.push({
      id: 'osm',
      title: 'large-network.json — OSM travel time, one-way (geojson-path-finder test weight)',
      network: large,
      pairs: samplePairs(large, PAIRS, 3, { weight }),
      unit: 's',
      contestants: [
        geoverse('geoverse A*', { weight }, { algorithm: 'astar', snap: { mode: 'exact' } }, large),
        geoverse('geoverse Dijkstra', { weight }, { algorithm: 'dijkstra', snap: { mode: 'exact' } }, large),
        geoverse('geoverse A* + edge snap', { weight }, { algorithm: 'astar' }, large),
        gpf('geojson-path-finder 2.1.0', { weight: osmWeight, tolerance: 1e-9 }, large),
      ],
    });
  }
  return scenarios;
}

// ---- runner ----------------------------------------------------------------------------------------
interface Result {
  name: string;
  initMs: number[];
  routeMs: number[];
  perQueryUs: number[];
  found: number;
  /** Pairs whose cost exceeds the best cost any contestant found (relative 1e-6). */
  worseThanBest: number;
  costs: (number | null)[];
}

function runScenario(s: Scenario): Result[] {
  const results: Result[] = s.contestants.map((c) => ({
    name: c.name,
    initMs: [],
    routeMs: [],
    perQueryUs: [],
    found: 0,
    worseThanBest: 0,
    costs: [],
  }));
  for (let round = 0; round <= ROUNDS; round++) {
    const warmup = round === 0;
    // Rotate the order every round so no contestant always runs on a warm (or cold) JIT/GC state.
    const order = s.contestants.map((_, i) => (i + round) % s.contestants.length);
    for (const i of order) {
      const c = s.contestants[i];
      const res = results[i];
      gc?.();
      const t0 = performance.now();
      const instance = c.init();
      const t1 = performance.now();
      const costs: (number | null)[] = [];
      const times: number[] = [];
      for (const [a, b] of s.pairs) {
        const q0 = performance.now();
        costs.push(c.route(instance, a, b));
        times.push((performance.now() - q0) * 1000);
      }
      const t2 = performance.now();
      if (warmup) continue;
      res.initMs.push(t1 - t0);
      res.routeMs.push(t2 - t1);
      res.perQueryUs.push(...times);
      res.costs = costs;
    }
    process.stdout.write(warmup ? '  warm-up done\n' : `  round ${round}/${ROUNDS}\n`);
  }
  for (let p = 0; p < s.pairs.length; p++) {
    const values = results.map((r) => r.costs[p]).filter((v): v is number => v !== null);
    const best = values.length ? Math.min(...values) : null;
    for (const r of results) {
      const v = r.costs[p];
      if (v !== null) r.found++;
      if (v !== null && best !== null && v > best * (1 + 1e-6)) r.worseThanBest++;
    }
  }
  return results;
}

const fmt = (xs: number[], digits = 0) =>
  `${median(xs).toFixed(digits)} [${Math.min(...xs).toFixed(digits)}–${Math.max(...xs).toFixed(digits)}]`;

function report(s: Scenario, results: Result[]): string {
  const lines = [
    `### ${s.title}`,
    '',
    `${s.network.features.length} line features · ${s.pairs.length} pairs · ${ROUNDS} rounds (+1 warm-up) · cost unit ${s.unit}`,
    '',
    '| library | init ms, median [min–max] | routing ms, median [min–max] | per query µs p50 / p95 | found | worse than best |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of results) {
    lines.push(
      `| ${r.name} | ${fmt(r.initMs, 1)} | ${fmt(r.routeMs, 1)} | ${percentile(r.perQueryUs, 50).toFixed(0)} / ${percentile(r.perQueryUs, 95).toFixed(0)} | ${r.found}/${s.pairs.length} | ${r.worseThanBest} |`,
    );
  }
  return lines.join('\n');
}

const dataDir = resolveDataDir();
const header = [
  `# geoverse-line-finder benchmark`,
  '',
  `- data: \`${dataDir}\``,
  `- node ${process.version} · ${cpus()[0]?.model ?? 'unknown CPU'} · ${new Date().toISOString()}${gc ? ' · gc between runs' : ''}`,
  '',
].join('\n');
console.log(header);
const sections: string[] = [header];
const json: Record<string, unknown> = {
  dataDir,
  node: process.version,
  cpu: cpus()[0]?.model,
  rounds: ROUNDS,
  scenarios: {},
};
for (const scenario of buildScenarios(dataDir)) {
  console.log(`## ${scenario.title}`);
  const results = runScenario(scenario);
  const text = report(scenario, results);
  console.log(`\n${text}\n`);
  sections.push(text, '');
  (json.scenarios as Record<string, unknown>)[scenario.id] = results.map(
    ({ costs: _costs, perQueryUs, ...rest }) => ({
      ...rest,
      p50Us: percentile(perQueryUs, 50),
      p95Us: percentile(perQueryUs, 95),
    }),
  );
}
const outDir = join(here, 'results');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify(json, null, 2));
writeFileSync(join(outDir, `${stamp}.md`), sections.join('\n'));
console.log(`results written to bench/results/${stamp}.{json,md}`);
