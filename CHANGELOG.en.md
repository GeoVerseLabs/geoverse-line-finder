# Changelog

🌐 [简体中文](CHANGELOG.md) ｜ English

This project follows [Semantic Versioning](https://semver.org/); while in 0.x, minor versions may contain breaking changes.

## Unreleased

With default options (no `group`) the output is still bit-identical to 0.1.0 (golden tests unchanged). The changes below only affect connectivity groups and snap constraints.

### Fixed

- **`snap.group` crowded out by other floors**: the group constraint used to filter after scanning, and the other floors it filtered out counted towards `searchLimit` (default 64). When the target floor's corridors were farther away than those of other floors (dense podium, sparse tower), three floors were enough for a false `SNAP_FAILED` / `FILTERED`. A group-constrained snap now scans only that group's segments / vertices / nodes (per-group R-trees, built lazily), and returns what a full scan with the same constraint and no scan limit would (checked by a randomised comparison test).
- **Connector interiors counted as the start floor**: the steps and landings of a staircase used to belong to the start group, so they merged with start-floor vertices at the same coordinate (the floor could shortcut into the middle of the stairs), were joined to the start floor by `splitIntersections` / `snapDangles`, short-circuited switchbacks where they overlap in plan, and start-floor waypoints could snap onto the middle of the stairs. Interior coordinates now **belong to no group**: they are not merged or repaired, and no `group` constraint accepts them; the inside of a segment whose ends lie in different groups belongs to no group either.

### Added

- Snap failure detail `detail: 'SCAN_LIMIT'`: the `searchLimit` nearest locations were all excluded by constraints and allowed ones may lie farther away (previously reported as `FILTERED`) — raise `searchLimit`.
- `graph.vertexGroup()` / `segmentGroup()` / `groupSpatialIndex()`.

### Changed

- The interior coordinates of connectors can no longer be snapped to with `mode: 'exact'`, and `graph.findVertex()` does not find them.
- Candidate `group`: `undefined` on a staircase (an interior coordinate, or inside a segment between groups); it used to take one end's group depending on the chain direction.
- Topology diagnostics: connectors are no longer reported as collinear overlaps (stairs stacked floor above floor are drawn that way); near misses of dead ends only consider segments lying entirely in their group, matching the `snapDangles` repair.
- Size: +0.7 KB gzip (per-group indexes, scan truncation), still within the gate.

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
