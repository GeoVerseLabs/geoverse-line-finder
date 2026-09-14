# Benchmark and diagnostic scripts

🌐 [简体中文](README.md) ｜ English

| Script                                 | Purpose                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm bench` (`run.ts`)                | compares geoverse-line-finder / geojson-path-finder 2.1.0 / terra-route 0.0.18                                |
| `pnpm bench:features` (`features.ts`)  | 0.2.0 features: default configuration against 0.1.0, ALT landmarks, bidirectional Dijkstra, optimal selection |
| `pnpm bench:gpf` (`gpf-root-cause.ts`) | reproduces geojson-path-finder's non-shortest routes and verifies the root cause                              |
| `osm-weight.ts`                        | the OSM travel-time weight from GPF's tests, ported verbatim and shared by both sides                         |

## Data

geojson-path-finder's own test networks, looked up in this order: `--data <dir>` → the `GLF_BENCH_DATA` environment variable →
a maintainer's local copy (a hard-coded path that is simply skipped when absent) → `node_modules/geojson-path-finder/test` from this
repository's devDependencies (the npm package ships its test directory, so it works on any machine).

| File                 | Size                                                                                                               | Used by                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `network.json`       | 44 lines / 932 coordinates                                                                                         | the `network` scenario                              |
| `large-network.json` | 20,120 lines / 135k coordinates (Gothenburg OSM, including 107 polygons that are filtered out before benchmarking) | the `large` and `osm` scenarios, feature benchmarks |

The 0.1.0 baseline in `features.ts` is the package published on npm, installed as the devDependency alias `glf-baseline`; the warehouse scenarios use the synthetic warehouse from `test/fixtures/warehouse.ts`.

## Usage

```bash
pnpm bench                                   # 5 rounds of 300 pairs by default
pnpm bench -- --rounds 7 --pairs 500
pnpm bench -- --only osm                     # any of network,large,osm
pnpm bench:features                          # all of regression,alt,bidirectional,optimal,quality
pnpm bench:features -- --only alt,optimal
NODE_OPTIONS=--expose-gc pnpm bench          # force a GC before every run to reduce noise
```

Every round **rebuilds** each contestant from scratch (init) and then runs the same seeded queries; one extra warm-up round is
discarded, and the execution order rotates every round. Results go to `bench/results/<timestamp>.{md,json}` and
`bench/results/features-<timestamp>.md` (git-ignored).

## Two hard rules before drawing conclusions

1. **At least 3 rounds; read distributions, not single numbers**: a difference whose `[min–max]` ranges overlap is noise and must not be written up as a result.
2. **Never run alongside other heavy work** (tests, builds, another benchmark); mind the laptop power mode, and state the machine and Node version with every conclusion.

The `worse than best` column counts pairs where a library's cost exceeds the best cost among all contestants (relative 1e-6), and `weight mismatches` counts queries whose weight differs from the first contestant's; both are correctness signals, not performance ones.
terra-route has no weights, so it only takes part in the shortest-distance scenarios and its cost is re-measured from the returned geometry with haversine.
