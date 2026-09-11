# geoverse-line-finder

🌐 [简体中文](README.md) ｜ English

[![CI](https://github.com/GeoVerseLabs/geoverse-line-finder/actions/workflows/ci.yml/badge.svg)](https://github.com/GeoVerseLabs/geoverse-line-finder/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/geoverse-line-finder)](https://www.npmjs.com/package/geoverse-line-finder)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

A zero-dependency TypeScript library for shortest paths on GeoJSON line networks (`LineString` / `MultiLineString`):

- **Configurable weights**: weight functions fully compatible with geojson-path-finder (the same cost both ways / `{ forward, backward }` per direction / falsy = impassable), plus a length context and declarative presets;
- **Switchable engines**: built-in A* and Dijkstra, selectable per query by name, and you can register your own;
- **Snapping and connectivity**: start and end points need not be network vertices (they are projected onto the nearest segment); at build time nearby vertices can be merged, dangling ends repaired and crossings split; at query time waypoints are snapped with the network's connected components in mind;
- **Two points or many waypoints**: one call returns the whole route, per-leg results and `sections` grouped by source feature.

The routing core follows [terra-route](https://github.com/JamesLMilner/terra-route) (CSR adjacency, 4-ary heap, reusable scratch buffers); the weight configuration follows [geojson-path-finder](https://github.com/perliedman/geojson-path-finder). Works in browsers, Web Workers and Node.

## Install

```bash
pnpm add geoverse-line-finder
```

Ships both ESM and CommonJS (Node ≥ 18). Without a bundler, load it with a `<script>` tag; the global is `GeoVerseLineFinder`:

```html
<script src="https://unpkg.com/geoverse-line-finder@0.1.0"></script>
<script>
  const finder = new GeoVerseLineFinder.LineFinder(roads);
</script>
```

## Quick start

```ts
import { LineFinder, toLineString } from 'geoverse-line-finder';

const finder = new LineFinder(roads); // roads: FeatureCollection<LineString>

// Two points: they need not be network vertices; by default they snap to the nearest segment
const route = finder.route([
  [116.397, 39.908],
  [116.41, 39.92],
]);
if (route.ok) {
  console.log(route.distance, 'm'); // length along the network
  console.log(route.path); // coordinates
  map.addGeoJSON(toLineString(route)); // GeoJSON LineString
} else {
  console.warn(route.reason, route.message); // SNAP_FAILED / DISCONNECTED / UNREACHABLE / INVALID_INPUT
}

// Several waypoints, visited in the given order
const tour = finder.route([start, via1, via2, end], { algorithm: 'dijkstra' });
tour.ok && tour.legs.forEach((leg) => console.log(leg.from, '→', leg.to, leg.weight));
```

## Weights

The signature matches geojson-path-finder's, plus a `context` argument (`distance` is the precomputed segment length, in the metric's unit):

```ts
const finder = new LineFinder(roads, {
  weight: (a, b, props, { distance }) => {
    if (props.highway === 'footway') return 0; // impassable
    const seconds = distance / ((props.maxspeed ?? 30) / 3.6);
    return props.oneway === 'yes' ? { forward: seconds } : seconds; // one-way
  },
});
```

| Return value                                              | Meaning                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| positive number                                           | the same cost in both directions                                             |
| `{ forward, backward }`                                   | forward = along the digitised a→b order; a missing direction is impassable   |
| `0` / `NaN` / `Infinity` / `null` / `undefined` / `false` | impassable                                                                   |
| negative number                                           | throws `RangeError` (negative costs silently break shortest-path algorithms) |

Presets:

```ts
import { createPropertyWeight, createSpeedWeight, osmDirection } from 'geoverse-line-finder';

createPropertyWeight({
  factor: (p) => ({ primary: 0.8, residential: 1.2 })[p.highway] ?? 1,
  direction: osmDirection,
});
createSpeedWeight({ speed: (p) => Number(p.maxspeed) || 30, direction: osmDirection }); // seconds
```

## Engines

```ts
finder.route(points, { algorithm: 'astar' }); // default
finder.route(points, { algorithm: 'dijkstra' });

// Register a custom engine (implement PathAlgorithm, see docs/ARCHITECTURE.en.md §4)
finder.registerAlgorithm(myBidirectionalDijkstra);
finder.route(points, { algorithm: 'bidirectional-dijkstra' });
```

The A* heuristic is admissible for **any** weight (metric embedding × the network-wide minimum cost-per-length ratio), so A* returns the same optimal cost as Dijkstra while expanding fewer nodes.

## Snapping and connectivity

Build time (`new LineFinder(network, options)`):

| Option               | Default       | Description                                                                                                             |
| -------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `metric`             | `'haversine'` | `'haversine'` (lng/lat degrees, meters), `'cheap-ruler'`, `'euclidean'` (projected coordinates) or a custom metric      |
| `tolerance`          | `0`           | vertices closer than this are merged into one (by real distance; geojson-path-finder's default of 1e-5° is about 1.1 m) |
| `snapDangles`        | `0`           | connect dangling ends to the nearest segment within this distance                                                       |
| `splitIntersections` | `false`       | split lines where they cross or touch without a shared vertex (this also joins overpasses — enable deliberately)        |
| `compact`            | `true`        | collapse degree-2 vertices into chains: identical results, faster search                                                |

Query time (`route(points, { snap })`):

| Option         | Default       | Description                                                                                                                                                                     |
| -------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`         | `'edge'`      | `'edge'` project onto the nearest segment · `'vertex'` nearest vertex · `'node'` nearest junction / dead end · `'exact'` must be a vertex                                       |
| `maxDistance`  | `Infinity`    | anything farther fails with `SNAP_FAILED`                                                                                                                                       |
| `connectivity` | `'connected'` | when the waypoints' nearest locations lie in components that are not connected, use nearby locations in a component all of them can reach; `'nearest'` always takes the nearest |

`finder.nearest(point)` returns the nearest network location on its own, e.g. for interactive snapping hints.

## Result

```ts
interface RouteSuccess {
  ok: true;
  path: Position[]; // the whole route
  weight: number; // total cost that was minimised
  distance: number; // total length along the network
  legs: RouteLeg[]; // per leg: path / weight / distance / sections / settled
  waypoints: { input; location; distance; component; featureIndex }[];
  algorithm: string;
}
```

`leg.sections` groups the path by source feature (with `properties`, its index range in `leg.path`, length and cost) — handy for listing the streets along a route.

## Migrating from geojson-path-finder

| geojson-path-finder                                    | geoverse-line-finder                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `new PathFinder(geojson, { weight, tolerance: 1e-5 })` | `new LineFinder(geojson, { weight, tolerance: 1.1 })` (tolerance is now in meters) |
| `findPath(a, b)` → `{ path, weight } \| undefined`     | `findPath(a, b)` / `route([a, b])` → `{ ok, path, weight, … }`                     |
| start and end must be vertices                         | segment snapping by default; `snap: { mode: 'exact' }` restores the old behaviour  |
| default weight = kilometers                            | default weight = meters (the metric's unit)                                        |
| `edgeDataReducer` / `edgeDataSeed`                     | `leg.sections` (no configuration needed)                                           |
| `pathToGeoJSON(path)`                                  | `toLineString(route)`                                                              |

## Performance and correctness

- All structures are flat typed arrays; queries reuse scratch buffers and only touch the nodes they visit.
- The tests include randomized differential testing against a naive reference implementation, every assertion from geojson-path-finder's own suite, and pair-by-pair comparison with an independent referee on geojson-path-finder's 135k-coordinate one-way OSM network.
- CI (GitHub Actions) runs the full gate on Node 20 / 22 and loads the built package on Node 18 / 20 / 22; pushing a `vX.Y.Z` tag publishes to npm — see [docs/RELEASE.en.md](docs/RELEASE.en.md).
- Measurements and how to reproduce them: [docs/BENCHMARK.en.md](docs/BENCHMARK.en.md); design notes: [docs/ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md).

```bash
pnpm test        # unit + differential + parity tests
pnpm bench       # three-library benchmark (geojson-path-finder test data, ≥ 3 rounds)
pnpm bench:gpf   # root-cause experiment for geojson-path-finder's non-shortest routes
pnpm check       # typecheck + lint + format + tests (coverage ratchet) + build + dist smoke test
```

## License

[Apache-2.0](LICENSE); copyright and attribution in [NOTICE](NOTICE). Borrowed code and ideas (MIT / ISC) are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
