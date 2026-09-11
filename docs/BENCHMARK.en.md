# Benchmarks and correctness measurements

🌐 [简体中文](BENCHMARK.md) ｜ English

> 2026-09-11 · Intel Core Ultra 9 185H · Node v22.12.0 · `NODE_OPTIONS=--expose-gc` · 5 rounds + 1 warm-up per scenario; every round rebuilds from scratch and rotates the execution order · data: geojson-path-finder's own test networks.
> Tables show **median [min–max]**; a difference whose ranges overlap is treated as noise and no conclusion is drawn. Reproduce with `pnpm bench` (`--only osm` runs a single scenario).

## Contestants

| Name                      | Configuration                                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| geoverse A\* / Dijkstra   | `snap.mode: 'exact'`: like the other libraries, inputs must be network vertices                                                                                                         |
| geoverse A\* + edge snap  | default segment snapping: one extra R-tree nearest search + overlay per waypoint                                                                                                        |
| geojson-path-finder 2.1.0 | `tolerance: 1e-9`, so its topology matches the other libraries (only identical coordinates connect)                                                                                     |
| terra-route 0.0.18        | A\* + ALT landmarks (enabled after the 256th query); no weights, so it only joins the shortest-distance scenarios and its cost is re-measured from the returned geometry with haversine |

The "non-shortest" column counts pairs where a library's cost exceeds the best cost among all contestants (relative 1e-6). This library matches an independent referee pair by pair in its tests (`test/gpf-parity.test.ts`), so a non-zero value means that library returned a non-shortest route.

## 1. network.json — shortest distance

44 lines, 932 coordinates; only 17 nodes remain after compaction.

| Library                  | Init ms           | 300 routes ms      | Per query µs p50 / p95 | Found | Non-shortest |
| ------------------------ | ----------------- | ------------------ | ---------------------- | ----- | ------------ |
| geoverse A\*             | 1.9 [1.7–2.9]     | 12.9 [10.9–15.6]   | 34 / 110               | 300   | 0            |
| geoverse Dijkstra        | 1.8 [1.2–2.6]     | **8.3** [7.1–13.8] | 21 / 74                | 300   | 0            |
| geoverse A\* + edge snap | 1.5 [1.2–2.1]     | 21.0 [17.9–23.6]   | 47 / 142               | 300   | 0            |
| geojson-path-finder      | 10.6 [8.9–11.5]   | 20.5 [18.4–24.5]   | 60 / 117               | 300   | 0            |
| terra-route              | **0.4** [0.4–0.7] | 17.6 [16.0–19.2]   | 38 / 169               | 300   | 0            |

On a graph this small the A\* heuristic does not pay for itself and Dijkstra is fastest; both stay outside terra-route's range. Segment snapping dominates a single query here (two nearest searches + overlay ≈ 27 µs).

## 2. large-network.json — shortest distance (all highway types)

20,120 lines, 135k coordinates (Gothenburg, OSM; the 107 polygon features are filtered out before benchmarking).

| Library                  | Init ms                 | 300 routes ms             | Per query µs p50 / p95 | Found | Non-shortest |
| ------------------------ | ----------------------- | ------------------------- | ---------------------- | ----- | ------------ |
| geoverse A\*             | 310.0 [283.5–350.0]     | **306.3** [287.0–337.0]   | 705 / 2948             | 300   | 0            |
| geoverse Dijkstra        | 304.1 [248.5–353.1]     | 692.7 [681.6–733.7]       | 2282 / 4824            | 300   | 0            |
| geoverse A\* + edge snap | 207.1 [194.7–301.4]     | 327.3 [310.4–377.1]       | 781 / 2975             | 300   | 0            |
| geojson-path-finder      | 2798.3 [2724.1–2869.1]  | 11574.0 [11431.0–12882.6] | 39143 / 80185          | 300   | **41**       |
| terra-route              | **112.8** [105.6–118.9] | 1410.8 [1291.2–1433.2]    | 2964 / 13280           | 300   | 0            |

- Routing: A\* is about 4.6× faster than terra-route and 38× faster than geojson-path-finder, with non-overlapping ranges, and 2.3× faster than this library's Dijkstra.
- Init: about 9× faster than geojson-path-finder and 2.7× slower than terra-route — this library also evaluates weights, compacts chains and computes components, the A\* embedding and the R-tree.
- The first three rows run **exactly the same init code**, yet their medians range from 207 to 310 ms: live evidence that a single round proves nothing. The routing gap between segment snapping and exact mode (327 vs 306) overlaps as well, so no conclusion is drawn.
- geojson-path-finder returns non-shortest routes for 41 of 300 pairs even with **pure distance** weights; root cause in §4.

## 3. large-network.json — OSM travel time, one-way (geojson-path-finder's own test weight)

The weight function is ported verbatim from geojson-path-finder's `test/osm-weight.js` (`bench/osm-weight.ts`) and both libraries call the same function; pairs are sampled from the largest component under this weight.

| Library                  | Init ms                | 300 routes ms           | Per query µs p50 / p95 | Found | Non-shortest |
| ------------------------ | ---------------------- | ----------------------- | ---------------------- | ----- | ------------ |
| geoverse A\*             | 264.9 [176.7–268.4]    | **206.0** [195.8–215.0] | 552 / 1678             | 293   | 0            |
| geoverse Dijkstra        | 261.0 [190.2–413.9]    | 285.4 [266.8–288.4]     | 880 / 1871             | 293   | 0            |
| geoverse A\* + edge snap | 229.8 [182.9–262.0]    | 226.7 [213.0–252.7]     | 633 / 1737             | 293   | 0            |
| geojson-path-finder      | 2708.8 [2675.5–2768.0] | 6678.5 [6574.8–6764.8]  | 21498 / 43935          | 293   | **42**       |

- Under time weights the heuristic is scaled by the fastest speed in the network and is weaker than in the distance scenario; A\* is still about 1.4× faster than Dijkstra (non-overlapping) and 32× faster than geojson-path-finder.
- **What snapping is worth**: a first version of this benchmark sampled points from the component of _all_ highway types, so many landed on footways this weight declares impassable — exact mode could route only 74/300 pairs, while the default segment snapping moved those points onto the nearest passable road and routed 292/300.

## 4. Root-cause experiment for geojson-path-finder's non-shortest routes (`pnpm bench:gpf`)

The same 60 random pairs (OSM time weight), compared with a naive referee that shares no code (uncompacted directed graph + Dijkstra):

| Variant                                                                          | Non-shortest |
| -------------------------------------------------------------------------------- | ------------ |
| geojson-path-finder 2.1.0 as published                                           | 7            |
| the same library's Dijkstra on its **uncompacted** vertex graph                  | 0            |
| one guard in `compactor` relaxed (a cheaper bypass may replace an existing edge) | 0            |
| geoverse-line-finder                                                             | 0            |

| Pair | Referee (s) | geojson-path-finder | Uncompacted graph | One-line patch | geoverse |
| ---- | ----------- | ------------------- | ----------------- | -------------- | -------- |
| 6    | 686.5       | 687.7 (+0.18%)      | 686.5             | 686.5          | 686.5    |
| 23   | 280.1       | 281.3 (+0.44%)      | 280.1             | 280.1          | 280.1    |
| 33   | 232.9       | 233.0 (+0.02%)      | 232.9             | 232.9          | 232.9    |
| 46   | 446.6       | 449.3 (+0.62%)      | 446.6             | 446.6          | 446.6    |
| 52   | 587.4       | 604.4 (+2.89%)      | 587.4             | 587.4          | 587.4    |
| 53   | 453.8       | 454.2 (+0.09%)      | 453.8             | 453.8          | 453.8    |
| 56   | 437.5       | 440.3 (+0.63%)      | 437.5             | 437.5          | 437.5    |

Conclusion: when geojson-path-finder compacts degree-2 vertices, `if (!neighbor[otherNeighborKey] && weightFromNeighbor)` adds a bypass only if the two neighbours have **no** edge yet; if a more expensive one exists (a parallel road, the opposite carriageway, or a longer chain compacted earlier), the cheaper bypass is dropped and the shortest path disappears from the compacted graph. Re-pricing its returned path with the referee gives exactly the weight it reports — the path is valid, just not the shortest. Versions 2.0.2 and 2.1.0 share this line.

## Reproducing

- Do not run it alongside tests, builds or another benchmark; mind the power mode on laptops.
- The data lookup order is in `bench/README.en.md`; on another machine the `node_modules/geojson-path-finder/test` shipped with the npm package works too.
- Raw output is saved to `bench/results/<timestamp>.{md,json}` (not committed).
