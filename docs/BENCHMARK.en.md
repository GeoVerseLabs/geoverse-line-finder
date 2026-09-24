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

## 5. 0.2.0 feature benchmarks (`pnpm bench:features`)

> 2026-09-14, same machine and method as above; the 0.1.0 baseline is the package published on npm (devDependency alias `glf-baseline`). The comparison with 0.1.0 uses the **built** package (`dist/`), so run `pnpm build` first; running the sources under tsx makes graph builds look about 20 % slower.

### 5.1 Default configuration vs 0.1.0 (9 rounds)

| Scenario                                     | Version | Init ms             | All queries ms      | Per query µs p50 / p95 | Found | Weight mismatches |
| -------------------------------------------- | ------- | ------------------- | ------------------- | ---------------------- | ----- | ----------------- |
| large-network distance, edge snapping        | 0.1.0   | 236.4 [183.6–249.4] | 284.4 [197.9–310.9] | 671 / 2495             | 300   | 0                 |
|                                              | 0.2.0   | 251.2 [204.0–287.1] | 338.3 [208.6–367.4] | 781 / 2921             | 300   | 0                 |
| large-network OSM travel time, edge snapping | 0.1.0   | 202.3 [181.7–231.5] | 222.2 [208.6–274.1] | 619 / 1940             | 291   | 0                 |
|                                              | 0.2.0   | 234.4 [195.4–250.6] | 232.1 [218.1–256.4] | 621 / 2040             | 291   | 0                 |
| synthetic warehouse, 292 tasks × 8 waypoints | 0.1.0   | 1.4 [1.0–2.4]       | 81.4 [68.2–96.2]    | 239 / 560              | 292   | 0                 |
|                                              | 0.2.0   | 1.5 [0.9–2.4]       | 91.9 [66.1–104.0]   | 260 / 582              | 292   | 0                 |

- Every pair of ranges overlaps, so by our rules **no slowdown is concluded**; weights match query by query, and the golden-output tests additionally keep paths and `settled` / `relaxed` bit-identical.
- The distance scenario shows the largest median gap, so it was re-checked with an alternating micro benchmark in one process (300 pairs, 12 rounds): 0.1.0 took 304.5 [197.3–327.7] ms and 0.2.0 317.6 [208.3–339.1] ms, with the same 1,166,663 settled nodes — noise again.
- Two real costs the benchmark caught during development were fixed: measures first re-measured the original coordinates, making builds about 10 % slower (they now reuse the lengths from the weight loop); candidate descriptions (touching features, side, measure) were first built for every hit (they are now built on demand).

### 5.2 Directed ALT landmarks (5 rounds, edge snapping, init includes landmark preparation)

| Weight          | Engine                   | Init ms             | All queries ms          | Per query µs p50 / p95 | Found |
| --------------- | ------------------------ | ------------------- | ----------------------- | ---------------------- | ----- |
| OSM travel time | A\*                      | 198.8 [184.8–224.9] | 223.3 [169.1–244.3]     | 533 / 1959             | 293   |
|                 | A\* + ALT (8, active 4)  | 220.3 [198.1–293.7] | **106.7** [102.0–118.2] | 234 / 1033             | 293   |
|                 | A\* + ALT (16, active 4) | 272.9 [252.1–312.6] | 97.8 [69.3–123.0]       | 215 / 915              | 293   |
| distance        | A\*                      | 209.1 [174.8–286.2] | 283.8 [278.5–296.4]     | 666 / 2805             | 295   |
|                 | A\* + ALT (8, active 4)  | 370.5 [324.4–392.4] | **172.3** [160.4–183.0] | 389 / 1679             | 295   |
|                 | A\* + ALT (16, active 4) | 388.7 [328.2–484.5] | 158.2 [142.0–167.5]     | 375 / 1399             | 295   |

- Against the acceptance criteria of the directed ALT design: 8 landmarks make the OSM travel-time scenario 2.09× faster (≥ 2×, non-overlapping) and the distance scenario 1.65× faster (it must not get slower); preparing 8 landmarks on the OSM graph takes 37.9 [33.5–43.5] ms and 1.6 MB (limits: ≤ 300 ms, ≤ 10 MB). All weights match plain A\*.
- 16 landmarks are only about 10 % faster than 8 while doubling preparation time and memory, hence the defaults: 8 landmarks, 4 active per query.

### 5.3 Bidirectional Dijkstra without a heuristic (9 rounds, custom metric without an embedding)

| Engine                 | Init ms             | All queries ms          | Per query µs p50 / p95 | Found |
| ---------------------- | ------------------- | ----------------------- | ---------------------- | ----- |
| Dijkstra               | 263.8 [180.2–365.2] | 727.0 [711.6–827.9]     | 2390 / 5305            | 297   |
| bidirectional Dijkstra | 243.4 [185.6–415.8] | **652.0** [514.1–710.2] | 1859 / 4651            | 297   |

- About 10 % faster overall and about 20 % faster at the median query; with 9 rounds the ranges just separate (with 5 rounds they still overlapped by 2.5 ms) — a small but real gain. A\* with an embedding is far faster, so this is a registrable option, not the default engine.
- The first implementation called a closure per relaxation and looked up a `Map` per expansion and was 1.7× slower than one-directional Dijkstra; the numbers above come after inlining those loops.

### 5.4 Cost of optimal selection (AC7, 5 rounds, synthetic warehouse, 292 tasks × 8 waypoints)

| Configuration                                 | All queries ms      | Per query µs p50 / p95 | Found |
| --------------------------------------------- | ------------------- | ---------------------- | ----- |
| nearest selection (`connectivity: 'nearest'`) | 49.6 [47.8–57.0]    | 152 / 298              | 292   |
| optimal selection, K = 1                      | 60.7 [59.5–76.4]    | 194 / 388              | 292   |
| optimal selection, K = 4 (default)            | 100.2 [92.7–105.7]  | 291 / 716              | 292   |
| optimal selection, K = 8                      | 132.4 [126.9–154.5] | 403 / 937              | 292   |

K = 4 costs about 2.0× nearest selection (limit ≤ 5×). Optimal selection with K = 1 goes through the general multi-source, multi-target search and is about 20 % slower than nearest selection; the default configuration still takes the nearest-selection path (see 5.1).

### 5.5 What optimal selection saves over nearest snapping (counts from one evaluation, not timings)

300 random pairs per scenario (5–40 m off the road), comparing network cost plus the snap costs at both ends.

| Network                  | Snap cost           | Nearest unreachable, optimal reachable | Gain p50 / p90 / max    | Gain > 1 % / > 10 % |
| ------------------------ | ------------------- | -------------------------------------- | ----------------------- | ------------------- |
| OSM travel time, one-way | distance at 10 km/h | 7 / 300                                | 0.07% / 12.82% / 86.19% | 111 / 35            |
| distance (km), two-way   | distance            | 5 / 300                                | 0.24% / 2.17% / 36.90%  | 54 / 2              |

- On the one-way network the gain comes mostly from "the nearest road runs the wrong way" — the general value of optimal selection, unrelated to warehouses.
- In the two-way distance scenario the gain is small, and part of it is snap legs cutting corners in a straight line; that is why optimal selection with `costMode: 'none'` drifts towards distant candidates, and why `'ends'` / `'arrive-depart'` together with `maxRelocation` are recommended (ARCHITECTURE §5.5).

### 5.6 Level-aware A\* bound (`--only levels`, 5 rounds)

Synthetic building: 30 storeys, a 7 × 7 corridor grid per floor (5 m spacing, priced by length), two floor-by-floor lifts (4 per hop), 1 350 nodes in all, `perLevel` = 4.00. The trips go from F1 to the spot directly above on Fk, k = 2…30 — 29 queries.

Settled nodes (`leg.settled`; deterministic, so one evaluation):

| Trip                      | Dijkstra | A\* (plan bound only) | A\* + level bound | A\* + level + ALT(8) |
| ------------------------- | -------- | --------------------- | ----------------- | -------------------- |
| F1 → F5                   | 33       | 13                    | 5                 | 5                    |
| F1 → F10                  | 186      | 84                    | 10                | 10                   |
| F1 → F20                  | 632      | 433                   | 20                | 20                   |
| F1 → F30                  | 1 082    | 883                   | 30                | 30                   |
| F1 → F30, opposite corner | 1 351    | 1 345                 | 1 231             | 1 223                |

Timings (the 29 trips together):

| Engine                     | build ms       | all queries ms | per query µs p50 / p95 | weight mismatches |
| -------------------------- | -------------- | -------------- | ---------------------- | ----------------- |
| Dijkstra                   | 4.7 [3.9–5.3]  | 4.3 [3.9–5.4]  | 116 / 294              | 0                 |
| A\* (plan bound only)      | 4.1 [3.6–5.1]  | 3.5 [2.6–6.9]  | 103 / 342              | 0                 |
| A\* + level bound          | 4.3 [3.7–10.1] | 2.4 [2.0–3.4]  | 73 / 162               | 0                 |
| A\* + level bound + ALT(8) | 7.9 [6.8–10.5] | 2.7 [2.3–3.8]  | 85 / 185               | 0                 |

- The settled counts are the finding: on vertical trips the level bound brings the search down to about one node per storey, 883 → 30 for F1 → F30. RFC-0015's acceptance line was "at most 1/5 of A\*"; measured, it is 1/29.
- Only the comparison with Dijkstra has non-overlapping timing ranges (2.0–3.4 vs 3.9–5.4 ms). Against plan-only A\* the ranges overlap, which at this scale (about 100 µs per search) is noise. The searches are too quick for wall-clock to show much; the gap would appear on larger buildings or in batch queries such as one-to-many and matrices.
- **The last row is the limit**: when the target is also far away in plan there is almost nothing to gain. The cause is the plan term — on a Manhattan grid the straight-line bound falls about √2 short of the real walking distance, and that slack keeps most nodes looking like they are on a shortest path; ALT helps by about 1 %. This is A\*'s standing difficulty with grid networks, not something the level layer introduces.
- A free lift or a group without an `ordinal` degenerates `perLevel` to 0, which is then exactly the plan-only case (see [MULTI_LEVEL.en.md](MULTI_LEVEL.en.md) §7.3).

## Reproducing

- Do not run it alongside tests, builds or another benchmark; mind the power mode on laptops.
- The data lookup order is in `bench/README.en.md`; on another machine the `node_modules/geojson-path-finder/test` shipped with the npm package works too.
- Raw output is saved to `bench/results/<timestamp>.{md,json}` (not committed).
