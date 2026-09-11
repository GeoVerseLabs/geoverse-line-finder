# Benchmark and diagnostic scripts

🌐 [简体中文](README.md) ｜ English

| Script                                 | Purpose                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm bench` (`run.ts`)                | compares geoverse-line-finder / geojson-path-finder 2.1.0 / terra-route 0.0.18        |
| `pnpm bench:gpf` (`gpf-root-cause.ts`) | reproduces geojson-path-finder's non-shortest routes and verifies the root cause      |
| `osm-weight.ts`                        | the OSM travel-time weight from GPF's tests, ported verbatim and shared by both sides |

## Data

geojson-path-finder's own test networks, looked up in this order: `--data <dir>` → the `GLF_BENCH_DATA` environment variable →
a maintainer's local copy (a hard-coded path that is simply skipped when absent) → `node_modules/geojson-path-finder/test` from this
repository's devDependencies (the npm package ships its test directory, so it works on any machine).

| File                 | Size                                                                                                               | Used by                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `network.json`       | 44 lines / 932 coordinates                                                                                         | the `network` scenario          |
| `large-network.json` | 20,120 lines / 135k coordinates (Gothenburg OSM, including 107 polygons that are filtered out before benchmarking) | the `large` and `osm` scenarios |

## Usage

```bash
pnpm bench                              # 5 rounds of 300 pairs by default
pnpm bench -- --rounds 7 --pairs 500
pnpm bench -- --only osm                # any of network,large,osm
NODE_OPTIONS=--expose-gc pnpm bench     # force a GC before every run to reduce noise
```

Every round **rebuilds** each library from scratch (init) and then routes the same seeded pairs (routing); one extra warm-up round is
discarded, and the execution order rotates every round. Results go to `bench/results/<timestamp>.{md,json}` (git-ignored).

## Two hard rules before drawing conclusions

1. **At least 3 rounds; read distributions, not single numbers**: a difference whose `[min–max]` ranges overlap is noise and must not be written up as a result.
2. **Never run alongside other heavy work** (tests, builds, another benchmark); mind the laptop power mode, and state the machine and Node version with every conclusion.

The `worse than best` column counts pairs where a library's cost exceeds the best cost among all contestants (relative 1e-6); it is a
correctness signal, not a performance one. terra-route has no weights, so it only takes part in the shortest-distance scenarios and its
cost is re-measured from the returned geometry with haversine.
