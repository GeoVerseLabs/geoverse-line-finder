# Changelog

🌐 [简体中文](CHANGELOG.md) ｜ English

This project follows [Semantic Versioning](https://semver.org/); while in 0.x, minor versions may contain breaking changes.

## 0.1.0 — Unreleased

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
