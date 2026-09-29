# Changelog

🌐 [简体中文](CHANGELOG.md) ｜ English

This project follows [Semantic Versioning](https://semver.org/); while in 0.x, minor versions may contain breaking changes.

## 0.3.0 — 2026-09-29

With default options (no `group` / `levels` / `nodeId` / `pointConnector`) the output is still bit-identical to 0.1.0 (golden tests unchanged), and the built graph — vertex numbering, segment order, chains, CSR, R-tree, diagnostics — is byte-for-byte what it was before the changes (new golden graphs in `test/graph-golden.test.ts`, 24 networks and configurations). The changes below only affect connectivity groups, level semantics, snap constraints and the new options.

### Performance: faster graph builds

On the 135k-coordinate OSM network, graph builds relative to 0.2.0: **2.05×** as fast with default options, 1.99× with the OSM travel-time weight, 1.45× with `tolerance: 1.1`, 1.58× with `snapDangles + splitIntersections` (7 samples, each the mean of 5 consecutive builds, built artefacts on both sides, no overlapping ranges; a second 5-sample run gave 2.16 / 2.07 / 1.30 / 1.50×; `pnpm bench:features --only build --against <0.2.0's dist/index.js>`, see [docs/BENCHMARK.en.md](docs/BENCHMARK.en.md) §5.7). The output is unchanged.

- **Vertex deduplication**: the nested `Map`s are replaced by an open-addressing hash table whose keys and occupancy bitmap live in flat typed arrays; exact mode hashes the coordinates' bit patterns (`-0` and `+0` are the same coordinate, as before), tolerance mode hashes grid cells, and the cells of the 3×3 neighbourhood that do not exist cost one lookup in a small bitmap.
- **R-tree packing**: sorting by Hilbert value is now a stable 8-bit radix sort instead of a comparison sort calling a closure per comparison; the order is exactly that of sorting by (Hilbert value, index).
- **Preallocation**: topology and chain compaction preallocate typed arrays from known bounds instead of `push` followed by `Int32Array.from`; the whole repair stage is skipped when no repair is requested; the graph shares the vertex store's trimmed coordinate arrays; the default length weight no longer builds a `WeightContext` per segment.
- Deserialising (`RoutingGraph.fromTransferable`) likewise builds the hash table directly over the received buffers instead of inserting every vertex into nested `Map`s.

### Added: connecting by node id (explicit topology)

- **`nodeId` build option**: `(properties, { featureIndex, feature, part, index, last, position }) => id | null | undefined`. Coordinates with the same id in the same group are one vertex, however far apart they are (the vertex keeps the first position seen); coordinates returning `null` / `undefined` merge by position and `tolerance` as before. An id seen for the first time takes over a vertex **without an id** at its position, so data with and without ids connects; **different ids never merge**, so an OSM overpass (the bridge and the road below share no node) is not joined by coincident coordinates. Ids are scoped by connectivity group; the interior coordinates of connector features are not passed to `nodeId`.
- With `diagnostics: true`, an id merge that bridges a gap is reported as a `merge` repair with the gap's width — a quick way to find id clashes or coordinate drift.
- Ids that agree with the coordinates build a graph byte for byte identical to the coordinates alone (differential tests on the GPF network, random grids with repairs, multi-level buildings and the 135k-coordinate OSM network, each with every coordinate keyed and with a random half of the features keyed).
- `stats.nodeIds`: vertices carrying an id.

### Added: point features as vertical connectors

- **`pointConnector` build option**: `(properties, featureIndex, feature) => { groups, boardCost?, perLevelCost?, direction? } | null` expands a `Point` feature (an OSM `highway=elevator` tagged `level=0;1;2`) into an all-stops-connected vertical connector with exactly the cost semantics of `verticalConnectors` (a test asserts both build byte-identical graphs apart from the segments' source feature). The connector keeps the point's index and properties: the ride's `featureIndex` / `id` / `properties` point back at the point, and nothing is appended to `graph.features`.
- Its stops attach to each floor by the point's node id (`nodeId`) first, then by position / `tolerance`; `graph.diagnostics().connectorEnds` reports stops that did not land (naming the point).
- The stops of `verticalConnectors` accept a `nodeId` as well.
- `stats.pointConnectors`: points turned into connectors; they no longer count in `stats.skippedFeatures`.

### Added: multi-level routing

The full story is in [docs/MULTI_LEVEL.en.md](docs/MULTI_LEVEL.en.md). The engine contract (`SearchGraph` / `PathAlgorithm`) is unchanged, so custom engines are unaffected.

- **`levels` build option**: gives every connectivity group a storey number `ordinal`, an optional `elevation` and a `name`; either a record keyed by `String(groupKey)` or a function. Without it nothing is switched on.
- **Level-aware A\* bound**: `h(u)` gains `perLevel · distance(ord(u), the target's level range)`. `perLevel` is derived per **connector run** rather than per compacted chain, with an admissibility argument, randomised differential tests and a property test. On a 30-storey synthetic building one vertical trip settles 30 nodes instead of 883 (`pnpm bench:features --only levels`); when the target is also far away in plan the gain is small — see §7.2 of the guide for why. `graph.heuristic.perLevel` exposes it.
- **`verticalConnectors` build option**: declare lifts, stair shafts and escalators by their stops; they expand to all-stops-connected links. One ride is **one** section costing `boardCost + |Δordinal| × perLevelCost` — floor-by-floor connector features charge the boarding once per hop instead. `direction: 'up' | 'down'` expresses a one-way escalator.
- **`WeightContext` gains `fromGroup` / `toGroup` / `rise`**: `rise` is the climb along the digitised direction (interpolated by length inside a connector), so stairs can be written as `ctx.distance + 8 * Math.max(ctx.rise, 0)`.
- **Levels in the result** (only with `levels`): `sections[].level`, `legs[].levels` (one per path coordinate), `legs[].transitions`, `levelChanges`, `verticalDistance`. Consecutive connector sections with no same-level section between them merge into **one** passage, so a floor-by-floor lift taken F1→F2→F3 reads as a single `1 → 3`.
- **`toLevelFeatures(result)`**: a separate export (tree-shaken when unused) that splits a route into per-level `LineString`s, connector `LineString`s and passage `Point`s — the direct input for rendering an indoor map one floor at a time.
- **`output: { z: 'elevation' }` route option**: writes the height into the third coordinate (`path` then holds copies).
- **Level diagnostics**: `connectorEnds` (a connector end that never joined its floor), `levelReachability` (which components each level lies in and which levels it reaches), `missingOrdinals` (groups without an ordinal, which switch the level bound off).
- **Serialisation format 2**: graphs with `levels` or `verticalConnectors` are written as `formatVersion: 2` (three extra buffers for level ordinals, level elevations and per-vertex elevations, with level names and the synthesised features in the header); everything else still writes 1. Readers accept both, and an older build fails loudly on 2. Deserialising needs only the input features — the synthesised connector features come back from the header.
- The playground gains a **multi-level** scenario: floor switching, per-level drawing and clickable passage markers; its lift is a point feature turned into a vertical connector by `pointConnector`.
- The playground gets a map engine: longitude / latitude scenarios now use **MapLibre GL JS on an OpenFreeMap basemap** (loaded on demand, falling back to a plain background when the basemap is unreachable), and a new **Gothenburg OSM network (135k coordinates)** scenario builds its graph in the browser and shows how long that took, with driving (`createSpeedWeight` + `osmDirection`) and walking profiles each building their own graph. Planar scenarios keep the SVG canvas.

### Fixed

- **`snap.group` crowded out by other floors**: the group constraint used to filter after scanning, and the other floors it filtered out counted towards `searchLimit` (default 64). When the target floor's corridors were farther away than those of other floors (dense podium, sparse tower), three floors were enough for a false `SNAP_FAILED` / `FILTERED`. A group-constrained snap now scans only that group's segments / vertices / nodes (per-group R-trees, built lazily), and returns what a full scan with the same constraint and no scan limit would (checked by a randomised comparison test).
- **Connector interiors counted as the start floor**: the steps and landings of a staircase used to belong to the start group, so they merged with start-floor vertices at the same coordinate (the floor could shortcut into the middle of the stairs), were joined to the start floor by `splitIntersections` / `snapDangles`, short-circuited switchbacks where they overlap in plan, and start-floor waypoints could snap onto the middle of the stairs. Interior coordinates now **belong to no group**: they are not merged or repaired, and no `group` constraint accepts them; the inside of a segment whose ends lie in different groups belongs to no group either.

### Added

- Snap failure detail `detail: 'SCAN_LIMIT'`: the `searchLimit` nearest locations were all excluded by constraints and allowed ones may lie farther away (previously reported as `FILTERED`) — raise `searchLimit`.
- `graph.vertexGroup()` / `segmentGroup()` / `groupSpatialIndex()`.

- **`sections[].start/end` were off by one with `connectors: 'legs'`**: the straight connector prepended to `leg.path` did not shift the section indices, so they pointed at the wrong coordinates. `sections`, `transitions` and `levels` now all index `leg.path` consistently.

### Changed

- The interior coordinates of connectors can no longer be snapped to with `mode: 'exact'`, and `graph.findVertex()` does not find them.
- Candidate `group`: `undefined` on a staircase (an interior coordinate, or inside a segment between groups); it used to take one end's group depending on the chain direction.
- Topology diagnostics: connectors are no longer reported as collinear overlaps (stairs stacked floor above floor are drawn that way); near misses of dead ends only consider segments lying entirely in their group, matching the `snapDangles` repair.
- `stats` gains `verticalConnectors` (the number of synthesised features); with `verticalConnectors` set, `stats.features` and `graph.features.length` include them.
- `GRAPH_FORMAT_VERSION` changed from 1 to 2 (the newest format this build writes); `GRAPH_FORMAT_VERSIONS` lists every format it reads. Graphs without level semantics still write 1.
- The stop positions of `verticalConnectors` are now validated: an invalid position throws a `TypeError` (it used to create a NaN vertex).
- Graphs serialised by 0.2.0 get the new counters (`verticalConnectors` / `pointConnectors` / `nodeIds`) filled in as 0 when deserialised.
- **Size gate raised**: consumer 29 000 → 35 500 B, IIFE 30 500 → 38 000 B. Measured 0.2.0 → 0.3.0: consumer 27 759 → 34 581 B, IIFE 29 663 → 36 906 B gzip — about +4.8 KB for the level layer (per-group indexes, level semantics), +1.7 KB for the faster build (hash-table vertex store, radix sort, preallocation) and +0.3 KB for node ids and point connectors. All of it sits on the `buildGraph` / `LineFinder` path and cannot be tree-shaken; the result converter `toLevelFeatures` is a separate export and does not count unless used.

## 0.2.0 — 2026-09-14

With default options the output is bit-identical to 0.1.0 (pinned by golden-output tests); the few behaviour changes and upgrade advice are in [docs/UPGRADING.en.md](docs/UPGRADING.en.md).

### Added

- **Snap candidates and constraints**: `snap.candidates` / `distinctBy` / `featureIds` / `filter` / `group`, per-waypoint options `{ coordinates, snap }`, `finder.candidates()`; candidate descriptions carry touching features, side, measure and group; snap failures carry a `detail` (`NONE_WITHIN` / `FILTERED` / `NOT_A_VERTEX`).
- **Optimal selection**: `snap.selection: 'optimal'` (a layered dynamic programme with one multi-source, multi-target search per layer), snap costs `snap.cost` / `costMode`, pass-through waypoints `passThrough`; `debug.candidates` reports why each candidate was or was not used.
- **Visible, capped relocation**: `waypoints[i].nearestDistance` / `relocation` / `relocated` / `candidateRank` / `candidatesConsidered`, `snap.maxRelocation` (`DISCONNECTED` with `detail: 'RELOCATION_LIMIT'` when it blocks).
- **Strongly connected components**: `connectivity: 'reachable'`, `graph.strongComponents()` (iterative Tarjan).
- **Failure policies**: `onFailure: 'fail' | 'skip' | 'straight'`, `skip.leading` / `skip.max`, `straightCost`; results gain `skipped` / `complete` / `legs[i].kind`, and the failure reason `ALL_SKIPPED`.
- **Connectors and totals**: `connectors: 'legs'`, `totals.includeSnapWeight` / `includeConnectorDistance`, and the breakdown `networkWeight` / `snapWeight` / `networkDistance` / `connectorDistance` / `straightDistance`.
- **Search budgets**: `budget.maxCost` / `maxSettled` (`UNREACHABLE` with `detail: 'BEYOND_MAX_COST'` / `BUDGET_EXCEEDED`).
- **One-to-many and cost matrices**: `finder.oneToMany()`, `finder.matrix()`.
- **Linear referencing**: `sections[i].fromMeasure` / `toMeasure` / `partIndex`, `sectionsDetail: 'feature' | 'measure' | 'segment'`, `graph.measureAt()`.
- **Topology diagnostics**: the build option `diagnostics` and `graph.diagnostics()`: dangling ends, near misses, repair log, component bounding boxes, invalid coordinate locations, collinear overlaps.
- **Connectivity groups and free edges**: the build options `group` (floors, overpasses; connectors return `[startGroup, endGroup]`) and `zeroWeight: 'free'`; `graph.findVertex(x, y, group)`.
- **Engines**: directed ALT landmarks with `prepareLandmarks()` / `LandmarkTable` / `LineFinderOptions.landmarks`; bidirectional Dijkstra `bidirectionalDijkstra` (name `'bidijkstra'`).
- **Engine contract extensions (backward compatible)**: `capabilities.multiTarget` / `budget`, `SearchRequest.targets` / `maxCost` / `maxSettled`, `SearchResult.targetPaths` / `budgetExceeded`, the optional overlay adjacency `overlayFirst` / `overlayNext` and reverse adjacency `reverseOffsets` and friends; heuristics may return `Infinity`. The library falls back automatically for custom engines that declare no capabilities.
- **Serialisation**: `graph.toTransferable()` / `RoutingGraph.fromTransferable()` (zero-copy views, optionally `SharedArrayBuffer`s); landmark tables are transferable too.

### Changed

- With a geographic metric, coordinates outside the longitude/latitude range or segments crossing ±180° now throw a `RangeError` at build time (they silently produced wrong distances before).
- The query overlay no longer has a fixed capacity or a fixed number of virtual nodes; `SearchGraph.nodeCount` and the overlay arrays may change between queries.
- The type declarations work with TypeScript 5.0 and later (0.1.0 needed 5.7).

### Fixed

- `stats.danglesSnapped` did not count dead ends with a zero gap (lying exactly on a segment: connected, but counted as 0).

### Performance and size

- Graph builds and queries with default options take as long as in 0.1.0 (overlapping ranges over several rounds).
- ALT with 8 landmarks makes edge-snapped A\* queries about 2× faster on the OSM travel-time network and about 1.6× faster with distance weights; landmark preparation takes about 40 ms.
- Optimal selection with 4 candidates per waypoint takes about twice as long as nearest selection on the synthetic warehouse.
- A minified bundle importing only `LineFinder` is about 27.8 KB gzip and the IIFE about 29.7 KB gzip (0.1.0's IIFE: 13.0 KB), guarded by the size gate.
- Numbers and how to reproduce them: [docs/BENCHMARK.en.md](docs/BENCHMARK.en.md).

### Project

- Tests: golden outputs of 0.1.0 (default options bit-identical), optimal selection against a brute force, strongly connected components against mutual reachability, landmark tables against a naive full search, serialisation round trips, and a synthetic warehouse fixture.
- Gates: a public API report (`etc/`), a bundle-size gate, a CI matrix compiling the declarations with TypeScript 5.0 / 5.4 / 5.7 / 5.9, and a worker round trip in the dist smoke test.
- Benchmarks: `pnpm bench:features`, with the 0.1.0 release from npm as the baseline.
- Documentation: README, ARCHITECTURE and BENCHMARK updated, UPGRADING added (Chinese and English).

## 0.1.0 — 2026-09-11

First release, open-sourced under the Apache License 2.0.

### Added

- `LineFinder`: weighted shortest paths on GeoJSON line networks (`LineString` / `MultiLineString`), between two points or through several waypoints in order.
- Weights: the geojson-path-finder weight-function contract (number / `{ forward, backward }` / falsy = impassable), plus `context.distance`;
  `createPropertyWeight`, `createSpeedWeight` and `osmDirection` presets; negative weights throw `RangeError`.
- Engines: `AlgorithmRegistry` with the built-in `astar` and `dijkstra`; custom engines plug in through the `PathAlgorithm` / `SearchGraph` contract; the priority queue is replaceable.
- Metrics: `haversine` (default), `cheap-ruler`, `euclidean` or a custom `Metric`; the A\* heuristic is admissible for any weight.
- Connectivity repair: `tolerance` merges vertices by real distance, `snapDangles` connects dangling ends, `splitIntersections` splits crossings; degree-2 vertices are compacted into chains.
- Snapping: `edge` / `vertex` / `node` / `exact` modes, `maxDistance`, connectivity-aware assignment; a standalone `nearest()`.
- Results: `legs`, `sections` grouped by source feature, `waypoints`, failure reasons as a discriminated union, `toLineString()`.
- Builds: ESM, CommonJS, type declarations and an IIFE bundle (global `GeoVerseLineFinder`).
- Project: GitHub Actions CI (full gate on Node 20 / 22, dist smoke test on Node 18 / 20 / 22) and tag-triggered releases with npm provenance; documentation in Chinese (primary) and English.
