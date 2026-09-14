/**
 * Benchmarks for the 0.2.0 features.
 *
 *   pnpm bench:features [--rounds 5] [--pairs 300] [--only regression,alt,bidirectional,optimal,quality]
 *
 * - regression: default configurations against the published 0.1.0 (npm alias `glf-baseline`);
 * - alt: A* with and without landmarks; bidirectional: Dijkstra variants without a heuristic;
 * - optimal: nearest vs. optimal selection on the synthetic warehouse (292 tasks × 8 waypoints);
 * - quality: how much optimal selection saves over nearest snapping (counts, not timings).
 *
 * Every timed scenario rebuilds each contestant per round, runs one warm-up round and rotates the order.
 * Read the [min–max] ranges: overlapping ranges are noise.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import * as baseline from 'glf-baseline';
import {
  LineFinder,
  bidirectionalDijkstra,
  createPropertyWeight,
  prepareLandmarks,
  type Metric,
  type NetworkCollection,
  type Position,
  type RouteOptions,
} from '../src';
import { LEVEL_FACTOR, warehouseNetwork, warehouseTasks, type AisleProps } from '../test/fixtures/warehouse';
import { osmWeight, type OsmProps } from './osm-weight';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const ROUNDS = Math.max(3, Number(arg('rounds', '5')));
const PAIRS = Number(arg('pairs', '300'));
const ONLY = new Set(arg('only', 'regression,alt,bidirectional,optimal,quality').split(','));

function dataDir(): string {
  const candidates = [
    arg('data', ''),
    process.env.GLF_BENCH_DATA ?? '',
    'D:/workspace/item/gis-project/item-gis-bam/node_modules/geojson-path-finder/test',
    join(dirname(require.resolve('geojson-path-finder/package.json')), 'test'),
  ];
  const dir = candidates.find((d) => d && existsSync(join(d, 'large-network.json')));
  if (!dir) throw new Error('large-network.json not found; pass --data <dir>.');
  return dir;
}

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
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (xs: number[], digits = 1) =>
  `${median(xs).toFixed(digits)} [${Math.min(...xs).toFixed(digits)}–${Math.max(...xs).toFixed(digits)}]`;
const gc = (globalThis as { gc?: () => void }).gc;

type Finder = { route(points: Position[], options?: object): { ok: boolean; weight?: number } };

interface Contestant {
  name: string;
  init(): Finder;
  options?: object;
}

interface Scenario {
  id: string;
  title: string;
  queries: Position[][];
  contestants: Contestant[];
  /** Whether all contestants must return the same weights. */
  sameWeights: boolean;
}

interface Result {
  name: string;
  initMs: number[];
  totalMs: number[];
  perQueryUs: number[];
  found: number;
  mismatches: number;
}

function run(s: Scenario): Result[] {
  const results: Result[] = s.contestants.map((c) => ({
    name: c.name,
    initMs: [],
    totalMs: [],
    perQueryUs: [],
    found: 0,
    mismatches: 0,
  }));
  const weights: (number | null)[][] = s.contestants.map(() => []);
  for (let round = 0; round <= ROUNDS; round++) {
    const order = s.contestants.map((_, i) => (i + round) % s.contestants.length);
    for (const i of order) {
      const c = s.contestants[i];
      gc?.();
      const t0 = performance.now();
      const finder = c.init();
      const t1 = performance.now();
      const times: number[] = [];
      const w: (number | null)[] = [];
      for (const q of s.queries) {
        const q0 = performance.now();
        const r = finder.route(q, c.options);
        times.push((performance.now() - q0) * 1000);
        w.push(r.ok ? (r.weight ?? null) : null);
      }
      const t2 = performance.now();
      if (round === 0) continue;
      results[i].initMs.push(t1 - t0);
      results[i].totalMs.push(t2 - t1);
      results[i].perQueryUs.push(...times);
      weights[i] = w;
    }
    process.stdout.write(round === 0 ? '  warm-up done\n' : `  round ${round}/${ROUNDS}\n`);
  }
  results.forEach((r, i) => {
    r.found = weights[i].filter((w) => w !== null).length;
    if (!s.sameWeights) return;
    weights[i].forEach((w, q) => {
      const ref = weights[0][q];
      if (
        (w === null) !== (ref === null) ||
        (w !== null && ref !== null && Math.abs(w - ref) > 1e-9 * Math.max(1, ref))
      ) {
        r.mismatches++;
      }
    });
  });
  return results;
}

function table(s: Scenario, results: Result[]): string {
  const lines = [
    `### ${s.title}`,
    '',
    `${s.queries.length} queries · ${ROUNDS} rounds (+1 warm-up)`,
    '',
    '| contestant | init ms | all queries ms | per query µs p50 / p95 | found | weight mismatches |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of results) {
    lines.push(
      `| ${r.name} | ${fmt(r.initMs)} | ${fmt(r.totalMs)} | ${percentile(r.perQueryUs, 50).toFixed(0)} / ${percentile(r.perQueryUs, 95).toFixed(0)} | ${r.found}/${s.queries.length} | ${s.sameWeights ? r.mismatches : '—'} |`,
    );
  }
  return lines.join('\n');
}

// ---- data ------------------------------------------------------------------------------------------------
const dir = dataDir();
const raw = JSON.parse(readFileSync(join(dir, 'large-network.json'), 'utf8')) as NetworkCollection<OsmProps>;
const large: NetworkCollection<OsmProps> = {
  type: 'FeatureCollection',
  features: raw.features.filter((f) => f.geometry?.type === 'LineString'),
};
const osm = (a: Position, b: Position, p: OsmProps) => osmWeight(a, b, p);
const km = (_a: Position, _b: Position, _p: unknown, ctx: { distance: number }) => ctx.distance / 1000;

/** Pairs near vertices of the largest component (optionally offset, in degrees). */
function pairs(finder: LineFinder<OsmProps>, count: number, seed: number, offset: number): Position[][] {
  const { graph } = finder;
  const pool: Position[] = [];
  for (let v = 0; v < graph.vertices.count; v++) {
    const node = graph.vertices.node[v];
    const chain = graph.vertices.chain[v];
    const c = node >= 0 ? graph.nodes.component[node] : chain >= 0 ? graph.chains.component[chain] : -1;
    if (c === graph.components.largest) pool.push(graph.vertices.positions[v]);
  }
  const rand = mulberry32(seed);
  const pick = (): Position => {
    const p = pool[Math.floor(rand() * pool.length)];
    return offset > 0 ? [p[0] + (rand() - 0.5) * offset, p[1] + (rand() - 0.5) * offset] : p;
  };
  return Array.from({ length: count }, () => [pick(), pick()]);
}

const scenarios: Scenario[] = [];
const osmFinder = new LineFinder(large, { weight: osm });
const kmFinder = new LineFinder(large, { weight: km });

if (ONLY.has('regression')) {
  // Compare built artefacts: the published 0.1.0 against this repository's dist (run `pnpm build` first).
  // Running the source through tsx instead makes graph builds look ~20 % slower than the shipped code.
  const current = (await import(
    new URL('../dist/index.js', import.meta.url).href
  )) as typeof import('../src');
  for (const [id, weight, finder] of [
    ['large', km, kmFinder],
    ['osm', osm, osmFinder],
  ] as const) {
    scenarios.push({
      id: `regression-${id}`,
      title: `Default configuration vs 0.1.0 — large-network ${id === 'large' ? 'distance' : 'OSM travel time'}, edge snapping`,
      queries: pairs(finder, PAIRS, 11, 4e-4),
      sameWeights: true,
      contestants: [
        { name: '0.1.0', init: () => new baseline.LineFinder(large, { weight }) as unknown as Finder },
        { name: '0.2.0', init: () => new current.LineFinder(large, { weight }) as unknown as Finder },
      ],
    });
  }
  const warehouseWeight = createPropertyWeight<AisleProps>({ factor: (p) => LEVEL_FACTOR[p.roadLevel] });
  const net = warehouseNetwork();
  scenarios.push({
    id: 'regression-warehouse',
    title: 'Default configuration vs 0.1.0 — synthetic warehouse, 292 tasks × 8 waypoints',
    queries: warehouseTasks().map((t) => t.map((w) => w.coordinates)),
    sameWeights: true,
    contestants: [
      {
        name: '0.1.0',
        init: () => new baseline.LineFinder(net, { weight: warehouseWeight }) as unknown as Finder,
      },
      {
        name: '0.2.0',
        init: () => new current.LineFinder(net, { weight: warehouseWeight }) as unknown as Finder,
      },
    ],
  });
}

if (ONLY.has('alt')) {
  for (const [id, weight, finder] of [
    ['osm', osm, osmFinder],
    ['large', km, kmFinder],
  ] as const) {
    const nearest = { snap: { connectivity: 'nearest' } };
    scenarios.push({
      id: `alt-${id}`,
      title: `A* with landmarks — large-network ${id === 'osm' ? 'OSM travel time' : 'distance'}, edge snapping (init includes landmark preparation)`,
      queries: pairs(finder, PAIRS, 12, 4e-4),
      sameWeights: true,
      contestants: [
        { name: 'A*', init: () => new LineFinder(large, { weight }) as unknown as Finder, options: nearest },
        {
          name: 'A* + ALT (8, active 4)',
          init: () => new LineFinder(large, { weight, landmarks: { count: 8 } }) as unknown as Finder,
          options: nearest,
        },
        {
          name: 'A* + ALT (16, active 4)',
          init: () => new LineFinder(large, { weight, landmarks: { count: 16 } }) as unknown as Finder,
          options: nearest,
        },
      ],
    });
  }
}

if (ONLY.has('bidirectional')) {
  const noEmbedding: Metric = {
    name: 'haversine-no-embedding',
    geographic: true,
    embedDims: 0,
    distance: (a, b) => {
      const r = Math.PI / 180;
      const s1 = Math.sin(((b[1] - a[1]) * r) / 2);
      const s2 = Math.sin(((b[0] - a[0]) * r) / 2);
      const h = s1 * s1 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * s2 * s2;
      return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
    },
  };
  const init = () =>
    new LineFinder(large, { weight: km, metric: noEmbedding }).registerAlgorithm(
      bidirectionalDijkstra,
    ) as unknown as Finder;
  const nearest = { connectivity: 'nearest' };
  scenarios.push({
    id: 'bidirectional',
    title: 'No heuristic available (custom metric without embedding) — large-network distance, edge snapping',
    queries: pairs(kmFinder, PAIRS, 13, 4e-4),
    sameWeights: true,
    contestants: [
      { name: 'Dijkstra', init, options: { algorithm: 'dijkstra', snap: nearest } },
      { name: 'bidirectional Dijkstra', init, options: { algorithm: 'bidijkstra', snap: nearest } },
    ],
  });
}

if (ONLY.has('optimal')) {
  const warehouseWeight = createPropertyWeight<AisleProps>({ factor: (p) => LEVEL_FACTOR[p.roadLevel] });
  const net = warehouseNetwork();
  const tasks = warehouseTasks().map((t) => t.map((w) => w.coordinates));
  const common = { totals: { includeSnapWeight: true } };
  const option = (snap: RouteOptions['snap']): object => ({
    ...common,
    snap: { costMode: 'arrive-depart', ...snap },
  });
  const init = () => new LineFinder(net, { weight: warehouseWeight }) as unknown as Finder;
  scenarios.push({
    id: 'optimal-warehouse',
    title: 'Optimal selection overhead (AC7) — synthetic warehouse, 292 tasks × 8 waypoints',
    queries: tasks,
    sameWeights: false,
    contestants: [
      { name: 'nearest (connectivity nearest)', init, options: option({ connectivity: 'nearest' }) },
      { name: 'optimal, K = 1', init, options: option({ selection: 'optimal', candidates: 1 }) },
      { name: 'optimal, K = 4', init, options: option({ selection: 'optimal', candidates: 4 }) },
      { name: 'optimal, K = 8', init, options: option({ selection: 'optimal', candidates: 8 }) },
    ],
  });
}

// ---- output --------------------------------------------------------------------------------------------
const header = [
  '# geoverse-line-finder feature benchmark',
  '',
  `- data: \`${dir}\``,
  `- node ${process.version} · ${cpus()[0]?.model ?? 'unknown CPU'} · ${new Date().toISOString()}${gc ? ' · gc between runs' : ''}`,
  '',
].join('\n');
console.log(header);
const sections: string[] = [header];

for (const s of scenarios) {
  console.log(`## ${s.title}`);
  const text = table(s, run(s));
  console.log(`\n${text}\n`);
  sections.push(text, '');
}

if (ONLY.has('alt')) {
  const times: number[] = [];
  for (let i = 0; i <= ROUNDS; i++) {
    const t0 = performance.now();
    const table = prepareLandmarks(osmFinder.graph, { count: 8 });
    if (i > 0) times.push(performance.now() - t0);
    if (i === ROUNDS) {
      const text = `Landmark preparation on the OSM travel-time graph, count 8: ${fmt(times)} ms · ${((table.fromLandmark.byteLength + table.toLandmark.byteLength) / 1048576).toFixed(1)} MB`;
      console.log(text);
      sections.push(text, '');
    }
  }
}

if (ONLY.has('quality')) {
  const lines = ['### Optimal selection vs nearest snapping (weights, one evaluation, not a timing)', ''];
  const rand = mulberry32(14);
  const point = (finder: LineFinder<OsmProps>): Position => {
    const { graph } = finder;
    for (;;) {
      const k = Math.floor(rand() * graph.segments.count);
      const c = graph.segments.chain[k];
      if (graph.chains.component[c] !== graph.components.largest) continue;
      const a = graph.vertices.positions[graph.chains.vertices[k + c]];
      const b = graph.vertices.positions[graph.chains.vertices[k + c + 1]];
      const t = rand();
      const offset = 5 + rand() * 35;
      const angle = rand() * 2 * Math.PI;
      const lat = a[1] + (b[1] - a[1]) * t;
      return [
        a[0] + (b[0] - a[0]) * t + (offset * Math.cos(angle)) / (111195 * Math.cos((lat * Math.PI) / 180)),
        lat + (offset * Math.sin(angle)) / 111195,
      ];
    }
  };
  lines.push(
    '| network | snap cost | nearest unreachable, optimal reachable | gain p50 / p90 / max | gain > 1 % / > 10 % |',
  );
  lines.push('| --- | --- | --- | --- | --- |');
  for (const [label, finder, cost] of [
    ['OSM travel time, one-way', osmFinder, 1 / (10 / 3.6)],
    ['distance (km), two-way', kmFinder, 1 / 1000],
  ] as const) {
    let rescued = 0;
    const gains: number[] = [];
    for (let i = 0; i < PAIRS; i++) {
      const points = [point(finder), point(finder)];
      const snap = { costMode: 'ends' as const, cost, maxDistance: 60 };
      const nearest = finder.route(points, {
        snap: { ...snap, connectivity: 'nearest' },
        totals: { includeSnapWeight: true },
      });
      const optimal = finder.route(points, {
        snap: { ...snap, selection: 'optimal', candidates: 4 },
        totals: { includeSnapWeight: true },
      });
      if (!optimal.ok) continue;
      if (!nearest.ok) {
        rescued++;
        continue;
      }
      gains.push((nearest.weight - optimal.weight) / nearest.weight);
    }
    const pct = (x: number) => `${(x * 100).toFixed(2)} %`;
    lines.push(
      `| ${label} | ${label.startsWith('OSM') ? 'distance at 10 km/h' : 'distance'} | ${rescued} / ${PAIRS} | ${pct(percentile(gains, 50))} / ${pct(percentile(gains, 90))} / ${pct(Math.max(...gains))} | ${gains.filter((g) => g > 0.01).length} / ${gains.filter((g) => g > 0.1).length} |`,
    );
  }
  const text = lines.join('\n');
  console.log(`\n${text}\n`);
  sections.push(text, '');
}

const outDir = join(here, 'results');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(join(outDir, `features-${stamp}.md`), sections.join('\n'));
console.log(`results written to bench/results/features-${stamp}.md`);
