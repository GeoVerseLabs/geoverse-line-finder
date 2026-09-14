// Loads the built package (ESM, CommonJS and the IIFE bundle) on the current Node version and routes
// through each, then moves a graph into a worker thread. CI runs it on Node 18 / 20 / 22 against artefacts
// built once on Node 22, without installing anything: the package has no runtime dependencies, so a bare
// Node must be enough.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const line = (coordinates) => ({
  type: 'Feature',
  geometry: { type: 'LineString', coordinates },
  properties: {},
});
const network = {
  type: 'FeatureCollection',
  features: [
    line([
      [0, 0],
      [10, 0],
    ]),
    line([
      [10, 0],
      [10, 10],
    ]),
  ],
};

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  readFileSync(new URL('../dist/geoverse-line-finder.global.js', import.meta.url), 'utf8'),
  sandbox,
);

const builds = {
  esm: await import('../dist/index.js'),
  cjs: require('../dist/index.cjs'),
  iife: sandbox.GeoVerseLineFinder,
};

let failed = false;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  failed ||= !ok;
};

for (const [name, lib] of Object.entries(builds)) {
  // (2,1) snaps to (2,0) and (9,8) to (10,8): 8 along the first line, then 8 along the second.
  // Optimal selection with snap costs finds the cheaper (2,0) → (9,0): 1 + 7 + 8 = 16 (vs 1 + 16 + 1 = 18).
  const finder = new lib.LineFinder(network, { metric: 'euclidean' });
  const route = finder.route([
    [2, 1],
    [9, 8],
  ]);
  const optimal = finder.route(
    [
      [2, 1],
      [9, 8],
    ],
    { snap: { selection: 'optimal', costMode: 'ends' }, totals: { includeSnapWeight: true } },
  );
  check(
    name,
    route.ok &&
      Math.abs(route.weight - 16) < 1e-9 &&
      lib.toLineString(route)?.geometry.coordinates.length === 3 &&
      optimal.ok &&
      Math.abs(optimal.weight - 16) < 1e-9 &&
      optimal.snapWeight === 9,
  );
}

// A graph serialised on the main thread, transferred, rebuilt and queried in a worker.
const graph = new builds.esm.LineFinder(network, { metric: 'euclidean' }).graph;
const data = graph.toTransferable();
const worker = new Worker(new URL('./smoke-worker.mjs', import.meta.url));
const weight = await new Promise((resolve, reject) => {
  worker.once('message', resolve);
  worker.once('error', reject);
  worker.postMessage(data, data.buffers);
});
await worker.terminate();
check('worker', weight === 16);

console.log(`node ${process.version}: dist smoke test ${failed ? 'FAILED' : 'passed'}`);
if (failed) process.exit(1);
