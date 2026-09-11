# geoverse-line-finder architecture

🌐 [简体中文](ARCHITECTURE.md) ｜ English

> For maintainers: why it is built this way, where the layer boundaries are and how to extend it. Usage is in the [README](../README.en.md), measurements in [BENCHMARK](./BENCHMARK.en.md).

## 1. Research: what each reference library does well and where it falls short

| Aspect          | terra-route 0.0.18                                                                                                    | geojson-path-finder 2.1.0                                                                                       | This library                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Graph storage   | CSR (`Int32Array` offsets/adjacency + `Float64Array` weights); coordinates deduplicated with `Map<lng, Map<lat, id>>` | nested objects (`Record<string, Record<string, number>>`) keyed by `"x,y"` strings                              | **CSR + nested Map** (from terra-route)                                                     |
| Search          | A\* + 4-ary heap + per-query stamped scratch buffers + ALT landmarks (enabled after the 256th query)                  | Dijkstra (tinyqueue); every queue entry copies the whole path array                                             | **switchable A\* / Dijkstra**; heap and scratch reuse from terra-route                      |
| Weights         | **not supported** (edge cost = distance)                                                                              | `weight(a, b, props)` → number / `{forward, backward}` / falsy = impassable                                     | **fully compatible with the GPF contract**, plus `context.distance` and declarative presets |
| One-way streets | not supported (undirected graph)                                                                                      | supported                                                                                                       | directed CSR                                                                                |
| Connectivity    | coordinates must be **identical**                                                                                     | `tolerance` rounding (default 1e-5°); close points on either side of a rounding boundary are never merged       | **real-distance grid merging** + dangling-end repair + optional crossing splits             |
| Start / end     | must be network vertices, otherwise an isolated node is added and `null` returned                                     | must be network vertices, otherwise `undefined`                                                                 | **four snapping modes**, projecting onto the nearest segment by default                     |
| Compaction      | none                                                                                                                  | degree-2 compaction + query-time "phantom nodes" (the graph is rewritten; mutable state shared between queries) | **chain compaction + read-only query overlay**                                              |
| Waypoints       | none                                                                                                                  | none                                                                                                            | **multi-waypoint routes, solved leg by leg**                                                |
| Result          | geometry only                                                                                                         | `path` + `weight` + optional `edgeDatas` (needs a reducer)                                                      | geometry + weight + length + legs + `sections` grouped by feature                           |

**Two findings from measurements** (both pinned by tests in `test/gpf-parity.test.ts`):

1. The end point `[8.44651, 59.513920000000006]` in GPF's own test suite is itself a product of its 1e-5° rounding; the real vertex is `[8.44650646, 59.51392406]`, about 0.5 m away. So even GPF's own tests only meet "the end must be a vertex" thanks to tolerance — which is exactly why this library snaps to segments by default.
2. On its own large-network.json (OSM, one-way streets) GPF returns **valid but non-shortest** routes for 7 of 60 random pairs (0.02%–2.9% longer). Root cause and verification in §7.

## 2. Layers and data flow

```
NetworkCollection ──► topology.ts ──► build.ts ─────────────────────────► RoutingGraph (read-only, shareable)
  (LineString /        │ extract segments        │ call the weight function → forward/backward
   MultiLineString)    │ VertexStore merging      │ chains.ts: degree-2 vertices → chains
                       │ ConnectivityRepair       │ directed CSR (only the directions a whole chain allows)
                       │  · snapDangles           │ weakly connected components (union-find)
                       │  · splitIntersections    │ A* heuristic data (embedding + minimum cost ratio)
                       └────────────────────────► │ segment R-tree (for snapping)

LineFinder.route(waypoints)
  ├─ snap.ts        candidates per waypoint (nearest per component) → connectivity-aware assignment
  ├─ per leg:
  │    query-graph.ts  overlay: points inside a chain become virtual nodes + partial chain edges (base graph untouched)
  │    mayConnect      component-based early rejection
  │    PathAlgorithm   dijkstra / astar / user-registered engines
  │    assemble.ts     edge sequence → coordinates / length / sections
  └─ join the leg geometries, sum weight / distance
```

### 2.1 Directory

| Path                              | Responsibility                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/types.ts`                    | minimal structural GeoJSON types (no dependency on `@types/geojson`, but compatible with it)           |
| `src/geo/metric.ts`               | metrics: haversine / cheap-ruler / euclidean / custom; `embed` provides the admissible heuristic       |
| `src/geo/segment.ts`              | point-to-segment projection, segment intersection                                                      |
| `src/heap/`                       | `Heap` interface + 4-ary heap (from terra-route, MIT)                                                  |
| `src/spatial/rtree.ts`            | static packed Hilbert R-tree (layout from flatbush, ISC) with exact-distance best-first nearest search |
| `src/graph/vertex-store.ts`       | vertex deduplication / merging                                                                         |
| `src/graph/topology.ts`           | segment extraction + connectivity repair (union-find merges + segment split requests sorted by t)      |
| `src/graph/chains.ts`             | degree-2 compaction                                                                                    |
| `src/graph/build.ts` / `graph.ts` | build pipeline / read-only graph (all flat typed arrays)                                               |
| `src/weight/weight.ts`            | GPF-compatible weight contract + presets                                                               |
| `src/algorithm/`                  | engine contract, scratch, Dijkstra, A\*, registry                                                      |
| `src/snap/snap.ts`                | snapping modes and connectivity-aware assignment                                                       |
| `src/route/`                      | overlay, path assembly, `LineFinder` facade, GeoJSON output                                            |

`src/` must not depend on Node built-ins (enforced twice: an ESLint rule and a `tsconfig.lib.json` without Node typings), so it runs in browsers, workers and Node; there are no runtime dependencies.

## 3. Weights (requirement 1)

The contract matches GPF exactly, so existing GPF weight functions can be passed in unchanged:

- a positive number: the same cost both ways; `{ forward, backward }`: per direction (forward = the digitised a→b order);
- `0`, `NaN`, `Infinity`, `null`, `undefined`, `false`: impassable in that direction;
- **negative numbers throw `RangeError`** (GPF feeds negative costs to Dijkstra unchanged, with silently wrong results).

Additions:

- A 4th argument `context = { distance, featureIndex, feature }`; `distance` is the segment length already measured with the metric, so time-based weights need not measure it again.
- Presets: `createPropertyWeight` (length × factor, optionally one-way), `createSpeedWeight` (km/h → seconds), `osmDirection` (OSM oneway/roundabout semantics).
- At query time costs are spread uniformly along a segment: when a snapped point lies inside a segment, the partial cost = fraction × segment cost.

## 4. Engines (requirement 2)

```ts
interface PathAlgorithm {
  name: string;
  usesHeuristic: boolean;
  search(req: { graph: SearchGraph; source; target; heuristic; scratch }): SearchResult;
}
```

- `SearchGraph` = base-graph CSR + overlay arrays. Convention: node ids `< baseNodeCount` have CSR adjacency; for every expanded node an engine must also scan the overlay edges whose `overlayFrom === node` (at most 5).
- Built-ins: `dijkstra` (the reference engine) and `astar`. Both share `SearchScratch`: typed arrays are allocated once and validated with a `Uint32` generation stamp, so a query only touches the nodes it visits (terra-route's technique, widened from a Uint8 stamp to Uint32 to avoid clearing every 255 queries).
- Registration: every `LineFinder` owns an `AlgorithmRegistry` pre-filled with the built-ins; `registerAlgorithm()` adds more, and `route(..., { algorithm })` also accepts an engine object. `test/algorithms.test.ts` proves the extension point is sufficient with a Bellman-Ford engine written only against the public contract.
- Pluggable heap: `new LineFinder(net, { heap: MyHeap })`.

### 4.1 Why the A\* heuristic is admissible for any weight

`h(v) = scale · ‖embed(v) − embed(target)‖`, where

- `embed` comes from the metric and guarantees that Euclidean distance ≤ metric distance: haversine uses 3D points on the sphere (chord `2R√h` ≤ arc `2R·asin√h`, with no trigonometry per evaluation); cheap-ruler and planar metrics use scaled planar coordinates.
- `scale = min(segment cost / segment length)` over all segments and both directions, multiplied by `1 − 1e-6` to absorb floating-point noise and interpolation error on partially traversed segments.

Hence any path cost ≥ scale × path length ≥ scale × straight-line distance ≥ h: admissible and consistent. When weights are unrelated to distance (hop counts, say) the scale is tiny and A\* degrades towards Dijkstra, but results stay optimal. A custom metric without `embed` disables the heuristic. A\* still keeps the "re-open a closed node on a better label" branch, so it stays optimal even with a future heuristic that is admissible but not consistent.

terra-route's ALT landmarks were not carried over: they assume an undirected graph, whereas a directed graph needs two sets of landmark distances (`d(L,v)` and `d(v,L)`). It is on the roadmap and plugs in as a heuristic provider without changing the existing interfaces.

## 5. Snapping and connectivity (requirement 3)

### 5.1 Build time: connect what should be connected

| Technique           | Option                              | How                                                                                                                                                                                                           | Why                                                                                                   |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Vertex merging      | `tolerance` (meters / planar units) | grid cells ≥ tolerance; check the 3×3 neighbourhood with the real distance; longitude cells widened for the network's highest latitude                                                                        | GPF's rounding cannot merge two points that straddle a rounding boundary, even 0.02 m apart (tested)  |
| Dangling-end repair | `snapDangles`                       | a degree-1 vertex snaps to the nearest segment within the threshold (ignoring its own segment and its only neighbour's segments, so short spurs don't fold back), and that segment is split at the projection | the common "almost connected" T-junction in digitised data                                            |
| Crossing splits     | `splitIntersections`                | R-tree candidate pairs; X crossings get a new vertex, T touches reuse the existing endpoint                                                                                                                   | data without shared vertices at junctions; it also joins bridges and tunnels, so it is off by default |

All merges go into a union-find and all splits become `(t, vertex)` requests that are applied in one go at the end — detection always works on the original segment ids, so nothing shifts while it is being examined.

### 5.2 Query time: where to snap

- `mode`: `edge` (default, project onto the nearest segment) / `vertex` (nearest vertex, shape points included) / `node` (nearest junction or dead end) / `exact` (must be a vertex — how both reference libraries behave).
- `maxDistance`: anything farther fails with `SNAP_FAILED`.
- Nearest search is a best-first walk of the R-tree: the box distance lower-bounds the exact distance and candidates leave the queue by **exact** distance, so results are strictly ordered; geographic coordinates use a local equirectangular scaling at the query latitude.

### 5.3 Connectivity-aware snapping

`connectivity: 'connected'` (default): each waypoint collects its nearest candidate per component (scanning at most `searchLimit` items). If the nearest candidates of all waypoints share a component they are used as they are; otherwise the component in which **every** waypoint has a candidate and the total snap distance is smallest wins. This only changes queries that were bound to fail — there can never be a route between different components. `'nearest'` always takes the nearest location and reports `UNREACHABLE` honestly.

Components are weakly connected (merged only through chains passable as a whole), so "different component ⇒ unreachable" is a safe early rejection; when the component is shared but one-way streets make the target unreachable, the search reports `UNREACHABLE`.

### 5.4 An overlay instead of phantom nodes

A waypoint inside a chain becomes a virtual node (source = `N`, target = `N+1`) joined to the chain's end nodes by partial-chain edges; when source and target lie on the same chain a direct edge is added as well (on a one-way chain it is naturally impassable backwards and the route goes around — tested). The base graph is never modified, therefore:

- one `RoutingGraph` can be shared by several `LineFinder`s (`new LineFinder(graph)`);
- queries cannot contaminate each other (GPF writes its phantom nodes into `compactedVertices` and removes them in a `finally`).

## 6. Two points and many waypoints (requirement 4)

`route([p0, p1, …, pn])` is solved leg by leg; if any leg is unreachable the whole route fails with its `legIndex`, and leg geometries are joined at the shared waypoints without duplicates. Results:

```ts
{ ok: true, path, weight, distance, legs: [{ from, to, path, weight, distance, sections, settled, relaxed }], waypoints: [{ input, location, distance, component, featureIndex }], algorithm }
{ ok: false, reason: 'INVALID_INPUT' | 'SNAP_FAILED' | 'DISCONNECTED' | 'UNREACHABLE', message, waypointIndex?, legIndex? }
```

- Failures are a discriminated union, not exceptions; only configuration errors (unknown engine, negative weight, invalid options) throw.
- `sections` group the path by source feature (with `properties`), replacing GPF's hand-written `edgeDataReducer/edgeDataSeed`.
- `connectors: true` joins the raw start and end inputs to their snapped locations with straight lines (geometry only, not counted in weight/distance).
- At integer positions output coordinates reuse the input coordinate objects (z preserved); points interpolated inside a chain interpolate z linearly.

Optimising the waypoint order (TSP) is out of scope for now; it could be added in front of `route` on top of a one-to-many Dijkstra cost matrix.

## 7. Correctness, and the root cause of GPF's non-shortest routes

Three layers of tests (`pnpm test`):

1. **Unit**: heap, R-tree (against brute force), metrics (embedding lower-bound property), vertex merging, weight contract.
2. **Differential**: on random grids (cost factors 0.5–2.5, one-way streets, closures, jittered shape points) the four combinations Dijkstra / A\* × compacted / flat are compared pair by pair with a naive reference implementation that **shares no code**, and every returned path is re-priced edge by edge with the reference; for segment snapping the snapped points are inserted into the reference network before comparing.
3. **Parity**: every assertion of GPF's own test suite; on large-network.json (135k coordinates, OSM one-way, GPF's time weight) 60 random pairs match an independent referee exactly and are never worse than GPF.

**Root cause of GPF's non-shortest routes** (investigated 2026-09-11): when GPF compacts a degree-2 vertex, `compact()` in `compactor.ts` adds the bypass edge only if the two neighbours are **not yet** connected:

```js
if (!neighbor[otherNeighborKey] && weightFromNeighbor) { neighbor[otherNeighborKey] = weightFromNeighbor + vertex[otherNeighborKey]; … }
```

If a more expensive direct edge already exists (a parallel road, the opposite carriageway of a one-way pair), the cheaper bypass is dropped and the shortest path disappears from the compacted graph. The verification is the "root-cause experiment" in `docs/BENCHMARK.en.md`: for the same pairs, GPF's own Dijkstra on the **uncompacted** graph is always optimal, and so is GPF with only this guard relaxed. This library's chain compaction only strings degree-2 vertices together and never builds "neighbour bypasses"; parallel chains are all kept as multi-edges, so the problem cannot occur.

## 8. Known limitations and roadmap

- Networks crossing the ±180° meridian are not supported (neither the R-tree nor the cheap-ruler embedding handles wrap-around).
- `splitIntersections` does not handle collinear overlaps; when three lines meet at one point with `tolerance = 0`, the floating-point intersections may not be bit-identical, so combine it with a tiny tolerance.
- Vertex merging keeps the first vertex as the representative and is not transitive (with A≈B and B≈C but A≉C, C is not merged into A).
- Roadmap: directed ALT landmarks (needs a reverse CSR), bidirectional Dijkstra, a one-to-many cost matrix and waypoint ordering, strongly connected components as a snapping preference, graph serialisation for workers, incremental updates (terra-route's `expandRouteGraph`).
