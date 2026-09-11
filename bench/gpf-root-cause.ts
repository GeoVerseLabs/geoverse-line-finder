/**
 * Reproduces geojson-path-finder 2.1.0 returning longer-than-optimal routes on its own large-network.json
 * and pins the cause to one line of its graph compaction.
 *
 *   pnpm bench:gpf [--data <dir>] [--pairs 60]
 *
 * For each random vertex pair (from the largest component), four answers are compared with an independent
 * referee (uncompacted directed graph, plain Dijkstra — test/helpers.ts):
 *   gpf            geojson-path-finder as published
 *   gpfUncompacted its own Dijkstra run on its *uncompacted* vertex graph   → isolates compaction
 *   gpfPatched     geojson-path-finder with ONE guard in compactor.js relaxed so that a cheaper bypass may
 *                  replace an existing edge                                 → isolates that line
 *   ours           geoverse-line-finder
 */
import { existsSync, readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { LineFinder, type NetworkCollection, type Position } from '../src';
import { ReferenceGraph, mulberry32 } from '../test/helpers';
import { osmWeight, type OsmProps } from './osm-weight';

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const gpfRoot = dirname(require.resolve('geojson-path-finder/package.json'));
const dataFile = [
  arg('data', ''),
  process.env.GLF_BENCH_DATA ?? '',
  'D:/workspace/item/gis-project/item-gis-bam/node_modules/geojson-path-finder/test',
  join(gpfRoot, 'test'),
]
  .filter(Boolean)
  .map((d) => join(d, 'large-network.json'))
  .find((f) => existsSync(f));
if (!dataFile) throw new Error('large-network.json not found; pass --data <dir>.');
const PAIRS = Number(arg('pairs', '60'));

type Gpf = { findPath(a: unknown, b: unknown): { weight: number } | undefined; graph: { vertices: unknown } };
type GpfCtor = new (network: unknown, options: unknown) => Gpf;
const load = (): GpfCtor => {
  const m = require('geojson-path-finder') as { default?: GpfCtor } & GpfCtor;
  return m.default ?? m;
};
const gpfDijkstra = (
  require(join(gpfRoot, 'dist/cjs/dijkstra.js')) as {
    default: (g: unknown, a: string, b: string) => [number, string[]] | undefined;
  }
).default;
const roundCoord = (
  require(join(gpfRoot, 'dist/cjs/round-coord.js')) as { default: (c: Position, t: number) => Position }
).default;
const { defaultKey } = require(join(gpfRoot, 'dist/cjs/topology.js')) as {
  defaultKey: (c: Position) => string;
};

const network = JSON.parse(readFileSync(dataFile, 'utf8')) as NetworkCollection<OsmProps>;
const options = { weight: osmWeight, tolerance: 1e-9 };
const gpf = new (load())(network, options);

// Swap in a patched compactGraph. preprocess() reads `compactor_1.default` at call time, so replacing the
// cached module's export affects every PathFinder constructed afterwards.
const compactorFile = join(gpfRoot, 'dist/cjs/compactor.js');
const guard = 'if (!neighbor[otherNeighborKey] && weightFromNeighbor) {';
const relaxed =
  'if (weightFromNeighbor && (!neighbor[otherNeighborKey] || neighbor[otherNeighborKey] > weightFromNeighbor + vertex[otherNeighborKey])) {';
const source = readFileSync(compactorFile, 'utf8');
if (!source.includes(guard))
  throw new Error('Guard line not found — geojson-path-finder changed; revisit this experiment.');
type InternalModule = Module & { _compile(code: string, file: string): void; paths: string[] };
const patched = new Module(compactorFile) as InternalModule;
patched.filename = compactorFile;
patched.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(
  dirname(compactorFile),
);
patched._compile(source.replace(guard, relaxed), compactorFile);
(require.cache[compactorFile]!.exports as { default: unknown }).default = (
  patched.exports as { default: unknown }
).default;
const gpfPatched = new (load())(network, options);

const weight = (a: Position, b: Position, p: OsmProps) => osmWeight(a, b, p);
const finder = new LineFinder(network, { weight });
const referee = new ReferenceGraph(network, weight);

const { graph } = finder;
const pool: Position[] = [];
for (let v = 0; v < graph.vertices.count; v++) {
  const node = graph.vertices.node[v];
  const chain = graph.vertices.chain[v];
  const c = node >= 0 ? graph.nodes.component[node] : chain >= 0 ? graph.chains.component[chain] : -1;
  if (c === graph.components.largest) pool.push(graph.vertices.positions[v]);
}
const rand = mulberry32(42);
const point = (c: Position) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: c },
  properties: {},
});
const rel = (x: number, y: number) => (x === y ? 0 : Math.abs(x - y) / Math.max(1, Math.abs(y)));
const counts = { pairs: 0, reachable: 0, gpf: 0, gpfUncompacted: 0, gpfPatched: 0, ours: 0 };
const rows: string[] = [];
for (let i = 0; i < PAIRS; i++) {
  const a = pool[Math.floor(rand() * pool.length)];
  const b = pool[Math.floor(rand() * pool.length)];
  counts.pairs++;
  const best = referee.shortest(a, b);
  if (best === Infinity) continue;
  counts.reachable++;
  const answers = {
    gpf: gpf.findPath(point(a), point(b))?.weight ?? Infinity,
    gpfUncompacted:
      gpfDijkstra(
        gpf.graph.vertices,
        defaultKey(roundCoord(a, 1e-9)),
        defaultKey(roundCoord(b, 1e-9)),
      )?.[0] ?? Infinity,
    gpfPatched: gpfPatched.findPath(point(a), point(b))?.weight ?? Infinity,
    ours: (() => {
      const r = finder.route([a, b], { snap: { mode: 'exact' } });
      return r.ok ? r.weight : Infinity;
    })(),
  };
  let flagged = false;
  for (const [name, value] of Object.entries(answers) as [keyof typeof answers, number][]) {
    if (rel(value, best) > 1e-9) {
      counts[name]++;
      flagged = true;
    }
  }
  if (flagged) {
    rows.push(
      `| ${i} | ${best.toFixed(1)} | ${answers.gpf.toFixed(1)} (+${(((answers.gpf - best) / best) * 100).toFixed(2)}%) | ${answers.gpfUncompacted.toFixed(1)} | ${answers.gpfPatched.toFixed(1)} | ${answers.ours.toFixed(1)} |`,
    );
  }
}
console.log(`data: ${dataFile}\n`);
console.log(
  '| pair | referee (s) | geojson-path-finder | GPF, uncompacted graph | GPF, one-line patch | geoverse |',
);
console.log('| --- | --- | --- | --- | --- | --- |');
console.log(rows.join('\n'));
console.log('\nsub-optimal answers per variant:', counts);
