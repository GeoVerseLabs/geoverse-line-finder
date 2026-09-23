# geoverse-line-finder

🌐 [简体中文](README.md) ｜ English

[![CI](https://github.com/GeoVerseLabs/geoverse-line-finder/actions/workflows/ci.yml/badge.svg)](https://github.com/GeoVerseLabs/geoverse-line-finder/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/geoverse-line-finder)](https://www.npmjs.com/package/geoverse-line-finder)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

A zero-dependency TypeScript library for shortest paths on GeoJSON line networks (`LineString` / `MultiLineString`):

- **Configurable weights**: weight functions fully compatible with geojson-path-finder (the same cost both ways / `{ forward, backward }` per direction / falsy = impassable), plus a length context and declarative presets;
- **Switchable engines**: built-in A\* (optionally accelerated with ALT landmarks), Dijkstra and bidirectional Dijkstra, selectable per query by name, and you can register your own;
- **Snapping**: waypoints need not be network vertices; each waypoint can have several candidates, hard constraints (`featureIds` / `filter` / `group`) say where it may attach, and the combination with the lowest snap cost + network cost can be chosen for the whole route; relocations are reported and can be capped;
- **Many waypoints**: one call returns the route and its legs; unreachable waypoints can be skipped or bridged by straight legs; pass-through waypoints, per-leg connectors and one-to-many cost matrices are supported;
- **Data quality and deployment**: routes carry measures along their features (linear referencing); a graph can locate dangling ends, near misses and repairs; floors and overpasses can be kept apart with groups; graphs serialise for Web Workers.

The routing core follows [terra-route](https://github.com/JamesLMilner/terra-route) (CSR adjacency, 4-ary heap, reusable scratch buffers); the weight configuration follows [geojson-path-finder](https://github.com/perliedman/geojson-path-finder). Works in browsers, Web Workers and Node.

**🗺️ [Live demo](https://GeoVerseLabs.github.io/geoverse-line-finder/)** — click the map to place waypoints and watch candidate constraints, optimal selection (nearest vs. optimal overlaid), failure policies (skip / straight) and topology diagnostics update live. Source in [`examples/playground/`](examples/playground/); run it locally with `pnpm demo:dev`.

## Install

```bash
pnpm add geoverse-line-finder
```

Ships both ESM and CommonJS (Node ≥ 18; the type declarations need TypeScript ≥ 5.0). Without a bundler, load it with a `<script>` tag; the global is `GeoVerseLineFinder`:

```html
<script src="https://unpkg.com/geoverse-line-finder@0.2.0"></script>
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
  // INVALID_INPUT / SNAP_FAILED / DISCONNECTED / UNREACHABLE / ALL_SKIPPED / BUDGET_EXCEEDED
  console.warn(route.reason, route.detail, route.message);
}

// Several waypoints, visited in the given order
const tour = finder.route([start, via1, via2, end], { algorithm: 'dijkstra' });
tour.ok && tour.legs.forEach((leg) => console.log(leg.from, '→', leg.to, leg.weight));
```

Upgrading from 0.1.0: with default options the output is bit-identical to 0.1.0; the few behaviour changes are listed in [docs/UPGRADING.en.md](docs/UPGRADING.en.md).

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

| Return value                                        | Meaning                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------- |
| positive number                                     | the same cost in both directions                                                |
| `{ forward, backward }`                             | forward = along the digitised a→b order; a missing direction is impassable      |
| `0`                                                 | impassable (default); a free passage with the build option `zeroWeight: 'free'` |
| `NaN` / `Infinity` / `null` / `undefined` / `false` | impassable                                                                      |
| negative number                                     | throws `RangeError` (negative costs silently break shortest-path algorithms)    |

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
import { LineFinder, bidirectionalDijkstra, prepareLandmarks } from 'geoverse-line-finder';

finder.route(points, { algorithm: 'astar' }); // default
finder.route(points, { algorithm: 'dijkstra' });

// Bidirectional Dijkstra: expands fewer nodes than Dijkstra when no heuristic is available
// (hop-count weights, custom metrics without an embedding)
finder.registerAlgorithm(bidirectionalDijkstra);
finder.route(points, { algorithm: 'bidijkstra' });

// ALT landmarks: faster A* on large directed or time-weighted networks; off by default
const fast = new LineFinder(roads, { weight, landmarks: { count: 8 } });
// or prepare once and share between finders / workers
const table = prepareLandmarks(fast.graph, { count: 8 });
const other = new LineFinder(fast.graph, { landmarks: table });
```

The A\* heuristic is admissible for **any** weight (metric embedding × the network-wide minimum cost-per-length ratio), so A\* returns the same optimal cost as Dijkstra while expanding fewer nodes; landmarks only tighten the bound and never change the result. Custom engines implement `PathAlgorithm`, see [docs/ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md) §4.

## Build options

`new LineFinder(network, options)` / `buildGraph(network, options)`:

| Option               | Default        | Description                                                                                                                                 |
| -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `metric`             | `'haversine'`  | `'haversine'` (lng/lat degrees, meters), `'cheap-ruler'`, `'euclidean'` (projected coordinates) or a custom metric                          |
| `tolerance`          | `0`            | vertices closer than this are merged into one (by real distance; geojson-path-finder's default of 1e-5° is about 1.1 m)                     |
| `snapDangles`        | `0`            | connect dangling ends to the nearest segment within this distance                                                                           |
| `splitIntersections` | `false`        | split lines where they cross or touch without a shared vertex (this also joins overpasses — keep them apart with `group`)                   |
| `compact`            | `true`         | collapse degree-2 vertices into chains: identical results, faster search                                                                    |
| `group`              | —              | connectivity groups (floors, overpass levels): merging, repairs and snapping never cross groups; connectors return `[startGroup, endGroup]` |
| `zeroWeight`         | `'impassable'` | what a weight of `0` means; `'free'` makes zero-length connectors such as elevators free to pass                                            |
| `diagnostics`        | `false`        | record repairs and invalid coordinates for `graph.diagnostics()`                                                                            |
| `landmarks`          | —              | ALT landmarks (`LineFinder` only), see above                                                                                                |

With a geographic metric, coordinates outside `[-180, 180] × [-90, 90]` (usually projected coordinates passed by mistake) and segments crossing the ±180° meridian now throw a `RangeError` at build time instead of silently producing wrong distances.

## Snapping

Query time (`route(points, { snap })`, or defaults in `new LineFinder(net, { snap })`):

| Option          | Default              | Description                                                                                                                                                                |
| --------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`          | `'edge'`             | `'edge'` project onto the nearest segment · `'vertex'` nearest vertex · `'node'` nearest junction / dead end · `'exact'` must be a vertex                                  |
| `maxDistance`   | `Infinity`           | search radius for candidates; anything farther fails with `SNAP_FAILED` (`detail: 'NONE_WITHIN'`)                                                                          |
| `selection`     | `'nearest'`          | `'nearest'` takes each waypoint's nearest allowed location; `'optimal'` the combination with the lowest snap cost + network cost                                           |
| `candidates`    | 1 (4 with `optimal`) | candidates kept per waypoint, 1–16                                                                                                                                         |
| `distinctBy`    | `'chain'`            | one candidate per chain and source feature / per feature / per connected component                                                                                         |
| `featureIds`    | —                    | only these features may be used (by `feature.id` or `properties.id`); a junction qualifies if any feature touching it is listed                                            |
| `filter`        | —                    | `(candidate, context) => boolean`; `false` removes the candidate                                                                                                           |
| `group`         | —                    | only locations in this connectivity group; only that group's segments / vertices are scanned, so denser floors never use up `searchLimit`                                  |
| `cost`          | `1`                  | snap cost: a number multiplies the snap distance, a function returns the cost directly (weight units)                                                                      |
| `costMode`      | `'none'`             | which snap costs count: `'ends'` leaving the origin + reaching the destination; `'arrive-depart'` also reaching and leaving every via                                      |
| `maxRelocation` | `Infinity`           | how much farther than the nearest allowed location the chosen one may be                                                                                                   |
| `passThrough`   | `false`              | a via may be entered at one candidate and left at another (`optimal`; floor locations reachable from both sides)                                                           |
| `connectivity`  | `'connected'`        | `nearest` only: move waypoints into a shared weakly connected component when needed; `'reachable'` requires one strongly connected component; `'nearest'` never moves them |
| `searchLimit`   | `64`                 | index items examined per waypoint (filtered ones included); when they are used up without an allowed location the failure has `detail: 'SCAN_LIMIT'` — raise it            |

**Keep constraints and preferences apart**: `featureIds` / `filter` / `group` are hard constraints on where a waypoint may attach; which way is preferable belongs in the weight or in `cost` — do not express preferences with `filter`. Every waypoint can override the route's options:

```ts
finder.route(
  [
    { coordinates: location, snap: { featureIds: [aisleId] } }, // this location is only reachable from the aisle it faces
    [lng, lat],
    { coordinates: floorSpot, snap: { passThrough: true } },
    end,
  ],
  { snap: { selection: 'optimal', costMode: 'arrive-depart', maxRelocation: 20 } },
);
```

About `optimal`:

- With `costMode: 'none'` (the default) snapping is free, so optimal selection tends to "cut corners": a snap leg is a straight line and shorter than the way along the network. Use `'ends'` / `'arrive-depart'` and a `maxRelocation` that fits your data.
- It pays off most on networks with one-way streets (the nearest road runs the wrong way and forces a long detour); see [docs/BENCHMARK.en.md](docs/BENCHMARK.en.md).
- `connectivity` does not apply: combinations across components cost infinity and drop out by themselves.

The default `connectivity: 'connected'` moves waypoints into another component when necessary; `waypoints[i].relocation` says how far beyond the nearest location it went and `maxRelocation` caps it. Use `'nearest'` to never move waypoints.

Candidates and the nearest location can be queried on their own:

```ts
finder.nearest(point); // nearest network location
finder.candidates(point, { candidates: 8, featureIds: ['A-12'] }); // constrained candidates with side / measure / featureIndices
```

## Many waypoints and failure policies

```ts
finder.route(points, {
  onFailure: 'skip', // 'fail' (default, the route fails) / 'skip' (drop it, keep the anchor) / 'straight' (bridge it)
  skip: { leading: true, max: 3 }, // also skip an unsnappable origin; fail after more than 3 skips
  straightCost: (d) => d * 2, // weight of a straight leg
  connectors: 'legs', // true/'ends': connectors at the route's ends; 'legs': around every leg
  totals: { includeSnapWeight: true, includeConnectorDistance: true },
  budget: { maxCost: 3600, maxSettled: 200_000 }, // UNREACHABLE (BEYOND_MAX_COST) / BUDGET_EXCEEDED beyond
  debug: { candidates: true }, // why each candidate was or was not used
});
```

- `skip`: a waypoint that cannot be snapped, or reached from the current anchor, goes to `skipped` and the next one is tried from the same anchor; with no leg at all the result is `ALL_SKIPPED`.
- `straight`: a failed leg becomes a straight line between the snapped locations (or the inputs), with `legs[i].kind === 'straight'`; its length goes to `straightDistance`.
- When a pass-through waypoint is entered and left at different candidates, the geometry goes through the input point and those two short pieces count as `connectorDistance`.

## Result

```ts
interface RouteSuccess {
  ok: true;
  path: Position[]; // the whole route
  weight: number; // total cost that was minimised (plus snapWeight with totals.includeSnapWeight)
  distance: number; // total length of the legs (plus connectorDistance with totals.includeConnectorDistance)
  legs: RouteLeg[]; // path / weight / distance / sections / settled / relaxed / kind / connectorDistance
  waypoints: SnappedWaypoint[]; // one per input waypoint
  networkWeight: number;
  snapWeight: number;
  networkDistance: number;
  connectorDistance: number;
  straightDistance: number;
  complete: boolean; // nothing skipped, no straight legs
  skipped: { index; reason; detail?; message }[];
  algorithm: string;
}
```

`waypoints[i]`: `input`, `location`, `distance`, `component`, `featureIndex`, `featureId`, `measure`, plus `snapped` / `used`, `nearestDistance` / `relocation` / `relocated`, `candidateRank` / `candidatesConsidered`, `snapCost`, and `arrive` / `depart` for pass-through waypoints.

`leg.sections` groups the path by source feature, with `properties`, its index range in `leg.path`, length, cost and measures (next section).

## One-to-many and cost matrices

```ts
const many = finder.oneToMany(depot, customers, { paths: true }); // a single search tree
many.ok && many.weights; // Infinity where unreachable
const matrix = finder.matrix(origins, destinations); // weights[i][j]
```

## Linear referencing (measures along features)

Every section carries `fromMeasure` / `toMeasure` (length along its source feature from the first coordinate of its part; decreasing when travelling against the digitised direction) and `partIndex`:

```ts
const r = finder.route(points, { sectionsDetail: 'measure' });
// heat maps in 10 m buckets: floor(measure / 10), no geometric overlay needed
```

- `'feature'` (default): grouped by feature exactly as in 0.1.0;
- `'measure'`: also split where the part changes or the measure jumps (e.g. through the start of a ring), so `Σ|toMeasure − fromMeasure|` equals the length;
- `'segment'`: one section per segment.

Measures accumulate along each feature's geometry after vertex merging and splitting, so they add up exactly to route lengths; gaps left by invalid coordinates add no length.

## Topology diagnostics

```ts
const graph = buildGraph(aisles, { snapDangles: 0.5, splitIntersections: true, diagnostics: true });
const d = graph.diagnostics({ nearMissDistance: 1, limit: 500 });
d.dangles; // dangling ends: location, feature, distance to the nearest other segment
d.nearMisses; // ends within nearMissDistance of another segment that still do not connect
d.repairs; // merge / dangle / split records (needs diagnostics: true)
d.components; // connected components: nodes, length, bounding box, group
d.invalidCoordinates; // where invalid coordinates are (needs diagnostics: true)
d.overlaps; // collinear overlapping segments that nothing splits
```

Each is `{ items, total, truncated }`; items beyond `limit` are only counted.

## Groups (non-planar networks)

When floors or overpasses overlap in the plane, keep them apart with `group` and join them with connector features:

```ts
const finder = new LineFinder(building, {
  group: (p) => (p.elevator ? [p.fromFloor, p.toFloor] : p.floor),
  zeroWeight: 'free', // an elevator is a zero-length line: let it pass for free (or give it a fixed weight)
  splitIntersections: true, // splits happen within each floor only
});
finder.route([
  { coordinates: a, snap: { group: 'F1' } },
  { coordinates: b, snap: { group: 'F3' } },
]);
```

Only the ends of a connector belong to floors (the first coordinate to the start group, the last to the end group). Its interior coordinates — the steps and landings of a staircase — **belong to no group**: they never merge with floor vertices, take no part in repairs, and a waypoint with a `group` constraint never snaps onto them. So attach both ends of a staircase to its floors: give them the coordinates of floor vertices, or let `tolerance` / `snapDangles` connect them within the floor.

## Workers and serialisation

```ts
// main thread
const data = graph.toTransferable(); // or { shared: true } for SharedArrayBuffers
worker.postMessage(data, data.buffers);

// worker
const graph = RoutingGraph.fromTransferable(data, { features }); // features are optional (sections.properties)
const finder = new LineFinder(graph);
```

Landmark tables work the same way: `table.toTransferable()` / `LandmarkTable.fromTransferable()`. A graph built with a custom metric object needs that `metric` again when it is deserialised.

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
- Tests include golden outputs of 0.1.0 (default options stay bit-identical), randomized differential testing against a naive reference implementation, optimal selection against a brute force over every candidate combination, strongly connected components against mutual reachability, every assertion from geojson-path-finder's own suite, and pair-by-pair comparison with an independent referee on geojson-path-finder's 135k-coordinate one-way OSM network.
- CI runs the full gate on Node 20 / 22 (including a bundle-size gate and a public API report), loads the built package on Node 18 / 20 / 22 including a worker round trip, and compiles a consumer against the declarations with TypeScript 5.0 / 5.4 / 5.7 / 5.9; pushing a `vX.Y.Z` tag publishes to npm — see [docs/RELEASE.en.md](docs/RELEASE.en.md).
- Measurements and how to reproduce them: [docs/BENCHMARK.en.md](docs/BENCHMARK.en.md); design notes: [docs/ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md).

```bash
pnpm test             # unit + differential + brute force + golden outputs
pnpm bench            # three-library benchmark (geojson-path-finder test data, ≥ 3 rounds)
pnpm bench:features   # 0.2.0 features: regression against 0.1.0, ALT, bidirectional Dijkstra, optimal selection
pnpm check            # typecheck + lint + format + tests (coverage ratchet) + build + dist smoke test + size + API report
pnpm check:types      # declarations compile with TypeScript 5.0 / 5.4 / 5.7 / 5.9
```

## License

[Apache-2.0](LICENSE); copyright and attribution in [NOTICE](NOTICE). Borrowed code and ideas (MIT / ISC) are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
