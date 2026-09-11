// Loads the built package (ESM, CommonJS and the IIFE bundle) on the current Node version and routes
// once through each. CI runs it on Node 18 / 20 / 22 against artefacts built once on Node 22, without
// installing anything: the package has no runtime dependencies, so a bare Node must be enough.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

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
for (const [name, lib] of Object.entries(builds)) {
  // (2,1) snaps to (2,0) and (9,8) to (10,8): 8 along the first line, then 8 along the second.
  const route = new lib.LineFinder(network, { metric: 'euclidean' }).route([
    [2, 1],
    [9, 8],
  ]);
  const ok =
    route.ok &&
    Math.abs(route.weight - 16) < 1e-9 &&
    lib.toLineString(route)?.geometry.coordinates.length === 3;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  failed ||= !ok;
}
console.log(`node ${process.version}: dist smoke test ${failed ? 'FAILED' : 'passed'}`);
if (failed) process.exit(1);
