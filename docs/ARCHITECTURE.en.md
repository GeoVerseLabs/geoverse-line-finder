# geoverse-line-finder architecture

🌐 [简体中文](ARCHITECTURE.md) ｜ English

> For maintainers: why it is built this way, where the layer boundaries are and how to extend it. Usage is in the [README](../README.en.md), measurements in [BENCHMARK](./BENCHMARK.en.md), version differences in [UPGRADING](./UPGRADING.en.md).

## 1. Research: what each reference library does well and where it falls short

| Aspect          | terra-route 0.0.18                                                                                                    | geojson-path-finder 2.1.0                                                                                       | This library                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Graph storage   | CSR (`Int32Array` offsets/adjacency + `Float64Array` weights); coordinates deduplicated with `Map<lng, Map<lat, id>>` | nested objects (`Record<string, Record<string, number>>`) keyed by `"x,y"` strings                              | **CSR + nested Map** (from terra-route), serialisable and shareable across threads                                 |
| Search          | A\* + 4-ary heap + per-query stamped scratch buffers + ALT landmarks (enabled after the 256th query)                  | Dijkstra (tinyqueue); every queue entry copies the whole path array                                             | **switchable A\* / Dijkstra / bidirectional Dijkstra, optional directed ALT landmarks**                            |
| Weights         | **not supported** (edge cost = distance)                                                                              | `weight(a, b, props)` → number / `{forward, backward}` / falsy = impassable                                     | **fully compatible with the GPF contract**, plus `context.distance`, declarative presets and zero-cost semantics   |
| One-way streets | not supported (undirected graph)                                                                                      | supported                                                                                                       | directed CSR + strongly connected components                                                                       |
| Connectivity    | coordinates must be **identical**                                                                                     | `tolerance` rounding (default 1e-5°); close points on either side of a rounding boundary are never merged       | **real-distance grid merging** + dangling-end repair + optional crossing splits + connectivity groups              |
| Start / end     | must be network vertices, otherwise an isolated node is added and `null` returned                                     | must be network vertices, otherwise `undefined`                                                                 | **four snapping modes + several candidates, hard constraints and cost-optimal selection**                          |
| Compaction      | none                                                                                                                  | degree-2 compaction + query-time "phantom nodes" (the graph is rewritten; mutable state shared between queries) | **chain compaction + read-only query overlay**                                                                     |
| Waypoints       | none                                                                                                                  | none                                                                                                            | **optimal selection over all waypoints (layered dynamic programme) or leg by leg**, with skip / straight fallbacks |
| Result          | geometry only                                                                                                         | `path` + `weight` + optional `edgeDatas` (needs a reducer)                                                      | geometry + weight + length + legs + `sections` grouped by feature (with measures) + total breakdown                |
| Data quality    | none                                                                                                                  | none                                                                                                            | topology diagnostics: dangling ends, near misses, repair log, collinear overlaps                                   |

**Two findings from measurements** (both pinned by tests in `test/gpf-parity.test.ts`):

1. The end point `[8.44651, 59.513920000000006]` in GPF's own test suite is itself a product of its 1e-5° rounding; the real vertex is `[8.44650646, 59.51392406]`, about 0.5 m away. So even GPF's own tests only meet "the end must be a vertex" thanks to tolerance — which is exactly why this library snaps to segments by default.
2. On its own large-network.json (OSM, one-way streets) GPF returns **valid but non-shortest** routes for 7 of 60 random pairs (0.02%–2.9% longer). Root cause and verification in §8.

## 2. Layers and data flow

```
NetworkCollection ──► topology.ts ─────────────────────► build.ts ─────────────────────► RoutingGraph (read-only, shareable, serialisable)
  (LineString /        │ extract segments (feature/part/     │ weights → forward/backward     │ lazy: strong components, reverse CSR,
   MultiLineString)    │   coordinate order)                 │ measures along each part       │       node→chain index, vertex/node R-trees
                       │ VertexStore merging per group       │ chains.ts: degree-2 → chains   │ diagnostics() / toTransferable()
                       │ coordinate-range / antimeridian     │ directed CSR, weak components
                       │   guards                            │ A* heuristic data
                       │ ConnectivityRepair (within groups)  │ segment R-tree (for snapping)
                       │ repair log (diagnostics: true)      │

LineFinder.route(waypoints, options)
  ├─ options.ts     waypoint parsing (incl. { coordinates, snap }), option validation and per-waypoint merging
  ├─ snap.ts        candidates: R-tree nearest → anchor → touching features / side / measure → dedupe → constraints
  ├─ nearest.ts     nearest selection: connectivity assignment → solvePair per leg → failure policy
  │  optimal.ts     optimal selection: layered DP, one multi-source multi-target search per layer, pass-through, failure policy
  ├─ search.ts      overlay wiring, component-based early rejection, engine calls (multi-target / budget fallbacks)
  │    query-graph.ts  overlay: growable, virtual nodes, seed edges, per-node adjacency lists
  │    PathAlgorithm   astar / dijkstra / bidijkstra / user engines; heuristics may add ALT landmarks
  └─ compose.ts     assemble.ts builds geometry and sections → connectors, total breakdown, waypoint details
LineFinder.oneToMany / matrix ──► many.ts (one-to-many costs from a single multi-target search)
```

### 2.1 Directory

| Path                        | Responsibility                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`              | minimal structural GeoJSON types (no dependency on `@types/geojson`, but compatible) and waypoint input types                   |
| `src/geo/metric.ts`         | metrics: haversine / cheap-ruler / euclidean / custom; `embed` provides the admissible heuristic                                |
| `src/geo/segment.ts`        | point-to-segment projection, segment intersection                                                                               |
| `src/heap/`                 | `Heap` interface + 4-ary heap (from terra-route, MIT)                                                                           |
| `src/spatial/rtree.ts`      | static packed Hilbert R-tree (layout from flatbush, ISC) with exact-distance best-first nearest search; rebuildable from arrays |
| `src/graph/vertex-store.ts` | vertex deduplication / merging per connectivity group                                                                           |
| `src/graph/topology.ts`     | segment extraction, input guards, connectivity repair (union-find merges + split requests sorted by t), repair log              |
| `src/graph/chains.ts`       | degree-2 compaction                                                                                                             |
| `src/graph/build.ts`        | build pipeline: weights, measures, chains, CSR, components, heuristic data, R-tree                                              |
| `src/graph/graph.ts`        | read-only graph (flat typed arrays) and lazy derived indexes                                                                    |
| `src/graph/scc.ts`          | iterative Tarjan strongly connected components                                                                                  |
| `src/graph/diagnostics.ts`  | topology diagnostics                                                                                                            |
| `src/graph/serialize.ts`    | transferable graph format                                                                                                       |
| `src/weight/weight.ts`      | GPF-compatible weight contract + presets                                                                                        |
| `src/algorithm/`            | engine contract, scratch, shared best-first core, Dijkstra, A\*, bidirectional Dijkstra, ALT landmarks, registry                |
| `src/snap/snap.ts`          | candidate model, anchors, strong-component keys                                                                                 |
| `src/route/`                | options, overlay, search wiring, both selectors, one-to-many, result assembly, `LineFinder` facade, GeoJSON output              |

`src/` must not depend on Node built-ins (enforced twice: an ESLint rule and a `tsconfig.lib.json` without Node typings), so it runs in browsers, workers and Node; there are no runtime dependencies.

## 3. Weights

The contract matches GPF exactly, so existing GPF weight functions can be passed in unchanged:

- a positive number: the same cost both ways; `{ forward, backward }`: per direction (forward = the digitised a→b order);
- `0`, `NaN`, `Infinity`, `null`, `undefined`, `false`: impassable in that direction;
- **negative numbers throw `RangeError`** (GPF feeds negative costs to Dijkstra unchanged, with silently wrong results).

Additions:

- A 4th argument `context = { distance, featureIndex, feature }`; `distance` is the segment length already measured with the metric, so time-based weights need not measure it again.
- Presets: `createPropertyWeight` (length × factor, optionally one-way), `createSpeedWeight` (km/h → seconds), `osmDirection` (OSM oneway/roundabout semantics).
- `zeroWeight: 'free'` makes `0` a free passage (needed for zero-length connectors between floors); by default it stays impassable for GPF compatibility.
- At query time costs are spread uniformly along a segment: when a snapped point lies inside a segment, the partial cost = fraction × segment cost.

## 4. Engines

### 4.1 Contract

```ts
interface PathAlgorithm {
  name: string;
  usesHeuristic: boolean;
  capabilities?: { multiTarget?: boolean; budget?: boolean };
  search(request: SearchRequest): SearchResult;
}
interface SearchRequest {
  graph: SearchGraph;
  source: number;
  target: number;
  heuristic: Heuristic | null;
  scratch: SearchScratch;
  targets?: ArrayLike<number>; // multi-target: stop once all are settled
  maxCost?: number; // paths costlier than this are not needed
  maxSettled?: number; // settle at most this many nodes
}
interface SearchResult {
  found;
  cost;
  nodes;
  edges;
  settled;
  relaxed;
  targetPaths?;
  budgetExceeded?;
}
```

- `SearchGraph` = base-graph CSR + overlay arrays. Node ids `< baseNodeCount` have CSR adjacency; for every expanded node an engine must also handle the overlay edges whose `overlayFrom === node` — by scanning them all, or through the optional `overlayFirst(node)` / `overlayNext` lists, which yield the **same edges in the same order**. The optional `reverseOffsets` / `reverseSources` / `reverseCosts` / `reverseEdgeIds` expose the base graph's reverse adjacency (built lazily).
- A heuristic may return `Infinity`: the node cannot reach the target and need not be queued.
- **Fallbacks**: for engines without `multiTarget`, the library splits multi-target requests into one search per target; for engines without `budget`, `maxCost` is checked on the result and `maxSettled` has no effect. Engines written for 0.1.0 therefore keep working unchanged.
- Registration: every `LineFinder` owns an `AlgorithmRegistry` pre-filled with `dijkstra` and `astar`; `registerAlgorithm()` adds more, and `route(..., { algorithm })` also accepts an engine object. `test/algorithms.test.ts` (a Bellman-Ford engine written only against the public contract) and `test/optimal.test.ts` (a naive engine declaring no capabilities) prove the extension point is sufficient.
- Pluggable heap: `new LineFinder(net, { heap: MyHeap })`.

The built-in `dijkstra` and `astar` share the `best-first.ts` core: lazy deletion; ties in the heap break by insertion order, so results are stable; a closed node is re-opened when it gets a cheaper label (impossible with a zero heuristic); multi-target searches count targets with `scratch.targetMark` and stop once all are settled; `maxCost` stops when the heap's smallest key exceeds it (keys are lower bounds of complete path costs) and `maxSettled` caps the work. The adjacency lists are used only when there are more than 8 overlay edges; below that a scan is faster — both visit edges in the same order, which is why two-point queries match 0.1.0 bit for bit, down to `settled` / `relaxed` (the golden outputs in §8).

### 4.2 Why the A\* heuristic is admissible for any weight

`h(v) = scale · ‖embed(v) − embed(target)‖`, where

- `embed` comes from the metric and guarantees that Euclidean distance ≤ metric distance: haversine uses 3D points on the sphere (chord `2R√h` ≤ arc `2R·asin√h`, with no trigonometry per evaluation); cheap-ruler and planar metrics use scaled planar coordinates.
- `scale = min(segment cost / segment length)` over all segments and both directions, multiplied by `1 − 1e-6` to absorb floating-point noise and interpolation error on partially traversed segments.

Hence any path cost ≥ scale × path length ≥ scale × straight-line distance ≥ h: admissible and consistent. When weights are unrelated to distance (hop counts, say) or a positive-length segment costs nothing, the scale approaches or equals 0 and A\* degrades towards Dijkstra, but results stay optimal. A custom metric without `embed` disables the heuristic. With several targets the bound is `min_t h_t(v)`, and a minimum of consistent potentials is still consistent.

### 4.3 Directed ALT landmarks

`prepareLandmarks(graph, { count, strategy, active })` places landmarks in the largest weakly connected component and runs one forward and one reverse full search per landmark L, giving `d(L,v)` and `d(v,L)` (`LandmarkTable`, `2 · count · N` `Float64` values). Strategies: `'farthest'` (default: each new landmark maximises the round-trip distance to those already chosen), `'planar'` (the farthest node from the centre in each sector) or explicit node ids.

Query-time bounds (triangle inequality, valid when both terms are finite):

- `d(v,t) ≥ d(L,t) − d(L,v)`; `d(v,t) ≥ d(v,L) − d(t,L)`;
- if `d(t,L)` is finite but `d(v,L) = ∞`, t can reach L and v cannot, so v cannot reach t: the bound is `Infinity` and the node is pruned (one-way "traps" disappear in one step).

A target inside a chain can only be entered and left through the chain's ends, so `d(L,T) = min(d(L,from) + partial cost, d(L,to) + partial cost)` (and the reverse) is **exact** and loses no bound quality. Each query uses the `active` landmarks (default 4) with the best bound at its origins, because more landmarks tighten the bound but make every evaluation O(K) and can end up slower. The final bound is `max(geometric, ALT × (1 − 1e-9))`: the maximum of two consistent potentials is consistent and the shrink absorbs floating-point error. Nodes outside the largest component have no landmark distances; those terms are skipped and the geometric bound remains. A table belongs to one graph and weighting (`matches()` checks node and edge counts) and can move to a worker with `toTransferable()`.

### 4.4 Bidirectional Dijkstra

`bidirectionalDijkstra` (name `'bidijkstra'`) expands forward from the source and backward from the target (the base graph's reverse CSR + an incoming list for overlay edges), always on the side with the smaller key. Whenever a side improves a node already reached by the other side, the best meeting cost μ is updated; the search stops once the two heap tops sum to at least μ. If one side runs dry, μ is already optimal (every node reachable on that side is settled, including the other side's start). Multi-target requests or a `maxCost` fall back to the single-direction core. It pays off when no heuristic is available; see BENCHMARK for the numbers.

## 5. Snapping

### 5.1 Build time: connect what should be connected

| Technique           | Option                              | How                                                                                                                                                                                                           | Why                                                                                                  |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Vertex merging      | `tolerance` (meters / planar units) | grid cells ≥ tolerance; check the 3×3 neighbourhood with the real distance; longitude cells widened for the network's highest latitude; merges only within a group                                            | GPF's rounding cannot merge two points that straddle a rounding boundary, even 0.02 m apart (tested) |
| Dangling-end repair | `snapDangles`                       | a degree-1 vertex snaps to the nearest segment within the threshold (ignoring its own segment and its only neighbour's segments, so short spurs don't fold back), and that segment is split at the projection | the common "almost connected" T-junction in digitised data                                           |
| Crossing splits     | `splitIntersections`                | R-tree candidate pairs; X crossings get a new vertex, T touches reuse the existing endpoint; connectors (ends in different groups) take no part                                                               | data without shared vertices at junctions; keep overpasses and floors apart with `group`             |

All merges go into a union-find and all splits become `(t, vertex)` requests that are applied in one go at the end — detection always works on the original segment ids, so nothing shifts while it is being examined. A dead end with a zero gap (lying exactly on a segment) leaves the union-find unchanged, but its split creates the connection, so it counts in `danglesSnapped`.

**Input guards**: with a geographic metric, coordinates outside the longitude/latitude range (usually projected coordinates passed by mistake) or consecutive coordinates more than 180° of longitude apart (an antimeridian crossing, which neither the R-tree, the projection nor the cheap-ruler embedding supports) throw a `RangeError` instead of silently producing wrong distances.

### 5.2 Candidate model

`searchCandidates` is the single entry point for all snapping (`nearest()`, `candidates()`, both selectors, one-to-many):

1. **Hits**: `edge` mode walks the segment R-tree best-first by exact distance and projects; `vertex` / `node` use the lazily built vertex / node R-trees; `exact` looks the coordinate up in the `VertexStore` (optionally within a group). With a `group` constraint the scan uses that group's lazily built R-tree instead (`graph.groupSpatialIndex()`: segments with at least one end in the group, or its vertices or nodes), so other floors neither use up the scan nor hide this floor's candidates; when the group has nothing within reach, one probe of the whole network tells `FILTERED` (only other floors nearby) from `NONE_WITHIN`. Each hit has an anchor (a node, or a chain and a position along it), its chain and its segment slot.
2. **Description** (`CandidateInfo`): the touching features (for a node anchor, the features at the ends of all incident chains; for a vertex inside a chain, the features of the segments before and after it), the primary feature's `featureId`, the side relative to the **digitised direction** (a cross product in the locally scaled plane, negated where the chain runs against the digitisation), the measure along the primary feature, the component and the group.
3. **Deduplication**: `'chain'` keys on "chain + source feature" — one compacted chain can string several features together (a loop of aisles is a single chain), and each of them is a distinct way onto the network; node anchors key on the node. There are also `'feature'`, `'component'`, and an internal strong-component key.
4. **Constraints**: `maxDistance` → the dedupe key is new → `group` / `featureIds` (intersected with the set of touching features, so junctions are not wrongly rejected) / `filter`. Rejected candidates **do not consume** the dedupe key or the count, but they count towards `searchLimit`, so strict constraints cannot make the scan run away; when the scan is used up without an allowed location the failure is `SCAN_LIMIT` (rather than `FILTERED`), a hint to raise `searchLimit`.
5. **Order**: a stable sort by distance, ties kept in spatial-index order (deterministic); `rank` is the resulting position.

### 5.3 Nearest selection and connectivity

With `selection: 'nearest'` every waypoint takes its nearest allowed location, then `connectivity` assigns:

- `'connected'` (default): each waypoint keeps its nearest candidate per weakly connected component (at most 16). If the nearest candidates already share a component they are used as they are; otherwise the component in which **every** waypoint has a candidate, and no waypoint moves more than `maxRelocation` beyond its nearest one, with the smallest total snap distance wins. If there is none the result is `DISCONNECTED` (`detail: 'RELOCATION_LIMIT'` when `maxRelocation` was the obstacle).
- `'reachable'`: the same assignment by **strongly connected component**. An anchor at a node takes the node's SCC; an anchor inside a chain belongs to it only if both chain ends are in that SCC and the point can be reached from and can leave to a chain end. Waypoints in one SCC guarantee that every leg exists, so one-way networks no longer produce "same weak component but unreachable".
- `'nearest'`: never moves anything.

Strongly connected components come lazily from the **iterative** Tarjan in `scc.ts` (an explicit call stack: a 200,000-node one-way path does not overflow the stack, tested). The default configuration keeps 0.1.0's scan order and stopping condition, hence its bit-identical output.

### 5.4 An overlay instead of phantom nodes

A point inside a chain becomes a virtual node joined to the chain's end nodes by partial-chain edges. Two-point queries keep 0.1.0's numbering (source = `N`, target = `N+1`); optimal selection and one-to-many request more virtual nodes with `addVirtual()` and use **seed edges** (`chain = -1`, no geometry) so that a virtual super-source can start from several places at once. Capacity doubles on demand; the outgoing edges of every node are linked in insertion order. The base graph is never modified, therefore:

- one `RoutingGraph` can be shared by several `LineFinder`s (`new LineFinder(graph)`);
- queries cannot contaminate each other (GPF writes its phantom nodes into `compactedVertices` and removes them in a `finally`).

### 5.5 Optimal selection: a layered dynamic programme

With `selection: 'optimal'` every waypoint keeps up to `candidates` candidates (default 4), drops those more than `maxRelocation` beyond its nearest one, and a dynamic programme runs along the waypoints:

- **Layers**: one per waypoint; each option has an arrival cost `net[d]` (without its own snap cost) and a departure cost `depart[e]`. In the origin layer `depart = the origin snap cost`.
- **Snap costs**: `raw = cost(candidate)`; `'ends'` counts leaving the origin and reaching the destination; `'arrive-depart'` also counts reaching and leaving every via; `'none'` counts nothing.
- **A transition is one multi-source, multi-target search**: a virtual super-source S has seed edges to every candidate of the previous layer that can be left (cost `depart[c]`; a candidate inside a chain gets a virtual node first, linked to the chain's ends), and every candidate of this layer is a target (a virtual node when inside a chain, with direct partial-chain edges from candidates on the same chain). A shortest path from S in this graph is exactly `min_c depart[c] + net(c → d)`, so **one search yields the optimum for every target of the layer**; the first edge of each target path is a seed edge and tells which c it came from. The heuristic bounds the distance to the nearest target of the layer, and the previous layer's candidates are the origins ALT uses to pick landmarks.
- **Departure**: without pass-through `depart[d] = net[d] + arrive cost(d) + depart cost(d)`, entering and leaving at the same candidate; for a `passThrough` via, `depart[e] = min_d(net[d] + arrive cost(d)) + depart cost(e)`, O(K).
- **Destination and backtracking**: the smallest `net[d] + destination arrive cost(d)` wins; `prevArr` / `prevDep` give every layer's arrival and departure candidates; each leg's `weight` is re-summed from 0 over the path's edges, matching two-point queries.
- **Failures**: when no option of a layer is reachable, `'fail'` reports `UNREACHABLE`; `'skip'` drops that waypoint and transitions from the previous layer again; `'straight'` completes the transition with straight costs. A waypoint that cannot be snapped becomes, under `'straight'`, a pseudo-option at its input that only takes part in straight transitions.
- **Determinism**: seeds enter the overlay in candidate rank order and heap ties are first-in first-out, so equal input gives equal output.
- **Cost**: n − 1 multi-target searches and O(K) memory per layer; engines without multi-target support take K searches per layer.
- **"Cutting corners"**: snap legs are straight lines and shorter than the way along the network. With `costMode: 'none'` snapping is free, so optimal selection systematically picks distant candidates to shorten the network part — that follows from the objective, it is not a bug. The documentation recommends `'ends'` / `'arrive-depart'` together with `maxRelocation`.

`test/optimal.test.ts` compares the total cost with a brute force over every candidate combination and a naive Dijkstra that shares no code, on random grids and with pass-through waypoints.

## 6. Route assembly and failure policies

With nearest selection the legs are solved one by one from an anchor that starts at the first usable waypoint:

- For a waypoint that cannot be snapped or reached, `'fail'` (default) returns the failure at once, as 0.1.0 did; `'skip'` records it in `skipped`, keeps the anchor and tries the next waypoint (an unsnappable origin is skipped only with `skip.leading`); `'straight'` emits a `kind: 'straight'` leg (preferring snapped locations as end points) with weight `straightCost(length)`.
- More skips than `skip.max` fail the route; no leg at all gives `ALL_SKIPPED`.
- Search budgets: hitting `maxSettled` gives `BUDGET_EXCEEDED`; exceeding `maxCost` counts as unreachable (`detail: 'BEYOND_MAX_COST'`).

`compose.ts` turns a plan into the public result:

- Leg geometries are joined at shared waypoints without duplicates; where a pass-through waypoint is entered and left at different candidates, the geometry goes through the input point and those two pieces count as `connectorDistance`.
- `connectors: true` / `'ends'` adds connectors at the route's ends; `'legs'` makes every leg run from input to input. Connectors are geometry only unless `totals.includeConnectorDistance`; `snapWeight` enters `weight` only with `totals.includeSnapWeight`.
- `weight` = the sum of leg weights (plus the optional parts), `distance` likewise; `networkWeight`, `networkDistance`, `straightDistance` and `complete` are reported as well.
- `waypoints` align with the input, with `snapped` / `used`, `nearestDistance` / `relocation`, `candidateRank`, `snapCost` and optional candidate reports (`SELECTED` / `FILTERED` / `RELOCATION` / `UNREACHABLE` / `NOT_SELECTED`).
- Failures are a discriminated union, not exceptions (`reason` + optional `detail` + indices); only configuration errors (unknown engine, negative weight, invalid options) throw.

`oneToMany` snaps the source and every target to their nearest allowed locations and gets all weights from one multi-target search (targets in other components are excluded first, and the A\* bound is used only for up to 16 targets); `matrix` runs it once per origin.

## 7. Graph data model

### 7.1 Measures (linear referencing)

The topology stage emits segments in "feature → part → coordinate" order, with the pieces of a split segment ordered by t, so the segments of each feature part are contiguous and ordered. The build accumulates segment lengths along each part in the same loop that evaluates weights, giving start and end measures per segment, which are stored in chain direction as `segments.measureStart` / `measureEnd` (with `part` and `reversed`). Therefore:

- Measures follow the geometry **after** merging and splitting and add up exactly to route lengths (`Σ|toMeasure − fromMeasure| = distance`, property-tested); gaps left by invalid coordinates add no length.
- No distance is computed twice for measures. A first implementation re-measured the original coordinates, which made graph builds about 10 % slower in the benchmark; reusing the lengths from the weight loop brought the build back to 0.1.0's time.

`sectionsDetail` decides how sections are cut: `'feature'` matches 0.1.0 (merged by feature), `'measure'` also splits where the part changes or the measure jumps (e.g. through the start of a ring), `'segment'` returns one section per segment.

### 7.2 Connectivity groups

A vertex is identified by "group + coordinate": the `VertexStore` keeps a separate exact map or grid per group, and merging and both repairs happen within a group only. A connector feature, for which `group` returns `[startGroup, endGroup]`, puts the first coordinate of every part into the start group and the last into the end group, so an elevator drawn as a zero-length line becomes a segment between two distinct vertices. The interior coordinates (the steps and landings of a staircase) belong to **no group** (`-1`): they are not indexed by the `VertexStore` and never merge with another vertex (only an immediately repeated coordinate is reused), and both repairs and the overlap diagnostic skip them; a location inside a segment whose ends lie in different groups belongs to no group either, so no `group` constraint accepts it. A staircase therefore neither merges with the floor vertices it passes over nor short-circuits where a switchback overlaps itself in plan. Its length is 0 and so is its default weight, which means impassable: it needs `zeroWeight: 'free'` or a fixed custom weight. Candidate descriptions carry the group, and per-waypoint `snap.group` and `findVertex(x, y, group)` restrict to one.

### 7.3 Topology diagnostics

With `diagnostics: true` the build also logs repairs (merge / dangling end / split, with location, the two features involved and the gap) and where invalid coordinates are; without it there is no extra cost. `graph.diagnostics()` computes lazily on the final topology: dangling ends (nodes touching one chain) and their distance to the nearest other chain of the same group, near misses, per-component bounding boxes, and collinear overlaps from R-tree candidate pairs. Each list honours `limit` and reports how many items were cut.

### 7.4 Serialisation

`toTransferable()` copies every table, the R-tree arrays, the group keys and the diagnostics log into standalone `ArrayBuffer`s (`SharedArrayBuffer`s with `shared: true`), with a header carrying the format name, version and a layout by name; the original graph is untouched and the buffers can be the `postMessage` transfer list. `fromTransferable()` checks the format, the version and every buffer's byte length, restores the tables as **zero-copy** typed-array views, rebuilds the `VertexStore` by appending the vertices in their original order (so ids and merging behave identically) and restores the R-tree with `PackedRTree.fromData`. Built-in metrics are rebuilt from their name and reference latitude; a custom metric must be passed in by the caller under the same name. Feature properties are not serialised; pass the original features when `sections.properties` is needed. Landmark tables serialise separately.

## 8. Correctness, and the root cause of GPF's non-shortest routes

Tests come in layers (`pnpm test`):

1. **Golden outputs**: `test/fixtures/golden-0.1.0.json` was generated by 0.1.0 on the GPF networks, random grids (with repairs and without compaction), the synthetic warehouse and the large OSM network; with default options every result field that existed in 0.1.0 (including `settled` / `relaxed`) must stay bit-identical.
2. **Unit**: heap, R-tree (against brute force), metrics (embedding lower-bound property), vertex merging, weight contract, strongly connected components (against mutual reachability), landmark tables (against a naive full search).
3. **Differential**: on random grids (cost factors 0.5–2.5, one-way streets, closures, jittered shape points) Dijkstra / A\* × compacted / flat are compared pair by pair with a naive reference implementation that **shares no code**, and every returned path is re-priced edge by edge; for segment snapping the snapped points are inserted into the reference network first; optimal selection (with pass-through) is compared with a brute force; ALT, bidirectional Dijkstra and one-to-many agree with the built-ins query by query.
4. **Parity**: every assertion of GPF's own test suite; on large-network.json the results match an independent referee exactly and are never worse than GPF.
5. **Engineering**: dist smoke test (ESM / CJS / IIFE + worker round trip), a consumer compiled with TypeScript 5.0 / 5.4 / 5.7 / 5.9, the public API report (`etc/`), the bundle-size gate and the coverage ratchet.

**Root cause of GPF's non-shortest routes** (investigated 2026-09-11): when GPF compacts a degree-2 vertex, `compact()` in `compactor.ts` adds the bypass edge only if the two neighbours are **not yet** connected:

```js
if (!neighbor[otherNeighborKey] && weightFromNeighbor) { neighbor[otherNeighborKey] = weightFromNeighbor + vertex[otherNeighborKey]; … }
```

If a more expensive direct edge already exists (a parallel road, the opposite carriageway of a one-way pair), the cheaper bypass is dropped and the shortest path disappears from the compacted graph. The verification is the "root-cause experiment" in `docs/BENCHMARK.en.md`: for the same pairs, GPF's own Dijkstra on the **uncompacted** graph is always optimal, and so is GPF with only this guard relaxed. This library's chain compaction only strings degree-2 vertices together and never builds "neighbour bypasses"; parallel chains are all kept as multi-edges, so the problem cannot occur.

## 9. Known limitations and roadmap

- Networks crossing the ±180° meridian are not supported: since 0.2.0 the build rejects them.
- `splitIntersections` does not handle collinear overlaps (`diagnostics().overlaps` lists them); when three lines meet at one point with `tolerance = 0`, the floating-point intersections may not be bit-identical, so combine it with a tiny tolerance.
- Vertex merging keeps the first vertex as the representative and is not transitive (with A≈B and B≈C but A≉C, C is not merged into A), so feature order can affect the topology; `diagnostics` shows every merge.
- Landmarks are only placed in the largest weakly connected component; queries elsewhere keep their results and simply are not accelerated.
- Bidirectional Dijkstra falls back to a single-direction search for multi-target requests and `maxCost`.
- Serialisation keeps the first three coordinate dimensions; custom metrics must be supplied again when deserialising.
- Roadmap (not scheduled, driven by demand): the side of the road relative to travel direction (the overlay can split candidates by direction without another contract change), waypoint ordering on top of cost matrices, incremental graph updates (at odds with the read-only graph; reconsider when interactive builds exceed 50 ms), antimeridian support, conservative Float32 landmark storage and per-component landmarks. Explicitly out of scope: GPS map matching and turn costs.
