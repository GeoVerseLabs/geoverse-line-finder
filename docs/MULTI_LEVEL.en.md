# Multi-level routing

[中文](MULTI_LEVEL.md) · [README](../README.en.md) · [Architecture](ARCHITECTURE.en.md) · [Upgrading](UPGRADING.en.md)

Indoor routing and "networks that overlap in the plane" are two different problems. 0.2.0 already kept floors from leaking into each other (`group`) and let a lift be passable (`zeroWeight: 'free'`), but the library knew nothing about floors themselves: a group key was an opaque string with no order above or below it and no height. Three things follow from that — A\* cannot tell that twelve storeys are still to go, the result does not say where the route changed level, and rendering one floor at a time has nothing to work from.

This release adds that **level semantics** layer. The engine contract (`SearchGraph` / `PathAlgorithm`) is untouched, so custom engines are unaffected, and a network built without `levels` produces byte-identical results.

---

## 1. What is new

| Capability                      | Entry point                                                                          | Problem it solves                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Level metadata                  | `levels` (build option)                                                              | Groups gain a storey number, a height and a display name                                                |
| Level-aware A\* bound           | Automatic (`graph.heuristic.perLevel`)                                               | A long climb no longer floods the start and intermediate floors: 883 → 30 settled nodes over 30 storeys |
| Declarative vertical connectors | `verticalConnectors` (build option)                                                  | One ride is one section, and the boarding cost is charged once, not per floor                           |
| Pricing by climb                | `rise` / `fromGroup` / `toGroup` on `WeightContext`                                  | Stairs can be priced by the actual climb rather than by their plan length                               |
| Levels in the result            | `section.level`, `leg.levels`, `leg.transitions`, `levelChanges`, `verticalDistance` | Where the route changes level, by how many storeys, and how much it climbs                              |
| Per-level rendering             | `toLevelFeatures(result)` (separate export, tree-shaken when unused)                 | An indoor map shows one floor at a time; this is its direct input                                       |
| z output                        | `output: { z: 'elevation' }`                                                         | Path coordinates carry the height, ready for a 3D view                                                  |
| Level diagnostics               | `diagnostics().connectorEnds / levelReachability / missingOrdinals`                  | Lifts that never reached their floor, levels that cannot reach each other, levels without an ordinal    |
| Format 2 serialisation          | `toTransferable()` switches automatically                                            | Level data and synthesised connectors travel to a worker with the graph                                 |

> One older behaviour was fixed along the way: with `connectors: 'legs'`, `sections[].start/end` did not move with the connector prepended to the leg and pointed at the wrong coordinates. `sections`, `transitions` and `levels` now all index `leg.path` consistently. See [Upgrading](UPGRADING.en.md).

---

## 2. Five-minute start

```ts
import { LineFinder, toLevelFeatures } from 'geoverse-line-finder';

const finder = new LineFinder(building, {
  metric: 'euclidean', // indoor data is usually projected (metres)
  splitIntersections: true, // noding happens within each floor; connectors are skipped

  // 1) which vertices may connect: the floor groups; a connector returns [startGroup, endGroup]
  group: (p) => (p.kind === 'corridor' ? p.floor : [p.from, p.to]),

  // 2) what each group is vertically (new)
  levels: (g) => (typeof g === 'number' ? { ordinal: g, elevation: (g - 1) * 4, name: `F${g}` } : undefined),

  // 3) a lift is a zero-length line: give it a fixed positive cost (not 0)
  weight: (a, b, p, ctx) => (p.kind === 'corridor' ? ctx.distance : 12),
});

const route = finder.route([
  { coordinates: [8, 8], snap: { group: 1 } },
  { coordinates: [46, 21], snap: { group: 4 } },
]);

if (route.ok) {
  route.levelChanges; // 3 storeys crossed
  route.verticalDistance; // 12 m climbed
  route.legs[0].transitions; // [{ fromLevel: 1, toLevel: 4, levelChange: 3, start, end, featureIndices, weight, distance }]
  toLevelFeatures(route); // a FeatureCollection split by level, ready to draw
}
```

**Three things that are easy to forget:**

1. Without `levels` nothing changes — no level fields, no level bound. It is the switch.
2. A zero-length lift with the default weight of `0` is **impassable**. Give it a fixed positive cost (recommended) or set `zeroWeight: 'free'` (but then the level bound degenerates to 0, see §7).
3. Both ends of a connector must really join the floor network: identical coordinates, or `tolerance` / `snapDangles`. `diagnostics().connectorEnds` tells you whether they did (§8).

---

## 3. Modelling the data

The three forms below can be mixed freely in one graph.

### 3.1 Floor features

Ordinary `LineString` / `MultiLineString` features whose `group` is the floor key. Floors may overlap exactly in plan: a vertex is identified by "group + coordinate", and merging, `tolerance`, `snapDangles` and `splitIntersections` all stay inside a group.

### 3.2 Connector features (floor by floor)

Features whose `group` returns `[startGroup, endGroup]`. In every part the **first coordinate goes to the start group, the last to the end group, and the interior coordinates belong to no group**:

| Part             | Group       | Merges with floor vertices | Takes part in repairs | A `group`-constrained waypoint can snap to it |
| ---------------- | ----------- | -------------------------- | --------------------- | --------------------------------------------- |
| First coordinate | start group | yes                        | yes                   | yes                                           |
| Interior (steps) | none        | no                         | no                    | no                                            |
| Last coordinate  | end group   | yes                        | yes                   | yes                                           |

```ts
// Lift: a zero-length line whose two ends are on different floors
line(
  [
    [10, 10],
    [10, 10],
  ],
  { kind: 'elevator', from: 1, to: 2 },
);

// Stairs: with a plan projection and a landing; the middle coordinate is on no floor
line(
  [
    [14, 20],
    [18, 24],
    [14, 20],
  ],
  { kind: 'stairs', from: 1, to: 2 },
);

// Escalator: up only — return { forward: cost } from the weight function
line(
  [
    [55, 20],
    [48, 20],
  ],
  { kind: 'escalator', from: 1, to: 2 },
);
```

**The cost problem with floor-by-floor lifts**: with an F1→F2 and an F2→F3 feature, a ride from F1 to F3 charges waiting and getting in and out **twice**, and one ride is reported as two sections. Stairs and escalators really are walked flight by flight, so they are fine; for lifts use the declarative form below.

### 3.3 Vertical connectors (declarative; recommended for lifts)

```ts
verticalConnectors: [
  {
    id: 'lift-core',
    kind: 'elevator',
    stops: [1, 2, 3, 4].map((f) => ({ group: f, position: [30, 20] })),
    boardCost: 8, // once per ride: waiting, in and out
    perLevelCost: 2, // per storey crossed
    direction: 'both', // 'up' / 'down' for one-way escalators
    properties: { kind: 'elevator', name: 'Core lift' },
  },
];
```

The library expands this into an **all-stops-connected** set of links: every pair of stops becomes one connection costing `boardCost + |Δordinal| × perLevelCost`. So F1→F4 is a **single** section costing `8 + 3×2 = 14`, not three sections each charging the boarding.

- The expanded features are appended after the input collection (`graph.features` grows; `stats.verticalConnectors` counts them) and `sections[].featureIndex` / `properties` point at them.
- A stop's coordinate joins its floor exactly like a digitised end coordinate: identical coordinates merge, otherwise it becomes an isolated vertex (which `connectorEnds` reports).
- `perLevelCost` and `direction` use ordinals, so those groups must have one in `levels`, or the build throws.
- n stops produce n(n−1)/2 segments. A 30-storey building with four lifts is about 1 700 — fine indoors. Above roughly 60 stops per shaft, consider a different model.

---

## 4. The `levels` option

```ts
interface LevelInfo {
  ordinal: number; // storey number: negative underground, adjacent floors differ by 1, a mezzanine may be 1.5
  elevation?: number; // height in metric units (usually metres)
  name?: string; // display name: "B1", "L3"
}

// Two forms
levels: { '1': { ordinal: 1, elevation: 0, name: 'Ground' }, '2': { ordinal: 2, elevation: 4 } }  // by String(groupKey)
levels: (g) => (typeof g === 'number' ? { ordinal: g, elevation: (g - 1) * 4 } : undefined)        // a function; also receives undefined (the default group)
```

- **`ordinal` drives the algorithm**: the level bound and `levelChange` are both computed from it.
- **`elevation` drives the physical quantities**: `WeightContext.rise`, `verticalDistance` and `output.z` all come from it. Without it, none of the three appear.
- Returning `undefined` / `null` means the group has no level semantics (outdoors, an atrium). That is allowed, but it has a cost — see §7.

---

## 5. Querying

```ts
finder.route(
  [
    { coordinates: a, snap: { group: 1 } }, // the floor of each waypoint
    { coordinates: b, snap: { group: 4 } },
  ],
  { output: { z: 'elevation' } }, // optional: write the height into the third coordinate
);
```

`snap.group` is a hard constraint, and it also selects **what is scanned**: only that group's segments, vertices or nodes. However dense the other floors are, they cost no scan budget (fixed in this release, see [Upgrading](UPGRADING.en.md)).

`output: { z: 'elevation' }` writes the height into the third coordinate, interpolated by length inside a connector. Note that `path` then holds **copies**, not the position objects of the input network.

---

## 6. Reading the result

These fields appear only when the graph was built with `levels`.

```ts
route.levelChanges; // Σ|levelChange|: storeys crossed in total
route.verticalDistance; // Σ|Δelevation|: climbed plus descended (only with elevations)

const leg = route.legs[0];
leg.levels; // one entry per coordinate of leg.path: floor key / undefined (default group) / null (inside a connector)
leg.transitions; // every passage between levels
leg.sections[0].level; // the floor a section runs on; null for a connector
```

`LevelTransition`:

```ts
{
  fromLevel: 1,
  toLevel: 4,
  levelChange: 3,           // signed, positive upwards
  start: 1, end: 3,         // inclusive index range into leg.path
  featureIndices: [12, 13], // the connector features the passage is made of
  weight: 14, distance: 0,
}
```

**Merge rule**: consecutive connector sections with no same-level section between them are **one** passage. A floor-by-floor lift taken from F1 to F3 without getting out on F2 reads as a single `1 → 3, levelChange: 2` — which is what the rider experiences, and what `levelChanges` counts.

### Rendering per level

```ts
import { toLevelFeatures } from 'geoverse-line-finder';

const { features } = toLevelFeatures(route);
for (const f of features) {
  switch (f.properties.kind) {
    case 'path': // LineString: a stretch that stays on one level; properties.level is that level
      if (f.properties.level === currentFloor) drawSolid(f);
      else drawGhost(f);
      break;
    case 'connector': // LineString: one passage; properties.level === null
      drawDashed(f); // it is on no level, so draw it dashed
      break;
    case 'transition': // Point where the passage starts; same fields as LevelTransition
      drawMarker(f, () => setFloor(f.properties.toLevel));
      break;
  }
}
```

Every feature carries `legIndex`, `legKind` and `start` / `end` (an index range into `leg.path`), so tracing back to the original data is easy. A failed route, or a graph without `levels`, returns an empty collection.

---

## 7. Performance: the level-aware bound

### 7.1 What it is

The A\* bound used to have only a plan term: `h(u) = scale · |e(u) − e(t)|`. Every point on the start floor is about equally far from the target in plan, so on a long climb h is nearly constant and the search floods the start and intermediate floors.

The new level term is:

```
h(u) = scale · |e(u) − e(t)|  +  perLevel · distance(ord(u), the target's level range)
```

`perLevel` is **the cheapest way to cross one storey**, derived at build time from every connector run:

```
perLevel = min over each connector run R and each passable direction of
           ( cost(R) − scale · |e(start) − e(end)| ) / |Δordinal(R)|
```

A "connector run" is one part of a connector feature from its start-group vertex to its end-group vertex (including the links expanded from `verticalConnectors`) — **not** a compacted chain. That distinction matters: chain compaction merges "a very expensive F1 corridor + the stairs + an F2 corridor" into one chain, and deriving the bound from that gives an absurdly large value that prunes the true shortest path. The counterexample is pinned down by a test (`prices one level from the connectors, not from the chains` in `test/levels.test.ts`).

`graph.heuristic.perLevel` exposes the value.

### 7.2 Measured (30 storeys, a 7 × 7 corridor grid per floor, 2 lifts, 1 350 nodes, `perLevel` = 4.00)

Settled nodes (`leg.settled`; deterministic, so one evaluation is enough):

| Trip                      | Dijkstra | A\* (plan bound only) | A\* + level bound | A\* + level + ALT(8) |
| ------------------------- | -------- | --------------------- | ----------------- | -------------------- |
| F1 → F5                   | 33       | 13                    | **5**             | 5                    |
| F1 → F10                  | 186      | 84                    | **10**            | 10                   |
| F1 → F20                  | 632      | 433                   | **20**            | 20                   |
| F1 → F30                  | 1 082    | 883                   | **30**            | 30                   |
| F1 → F30, opposite corner | 1 351    | 1 345                 | 1 231             | 1 223                |

Reproduce with `pnpm bench:features --only levels`.

**That last row is the honest limit of the method.** When the target is also far away in plan, there is almost nothing to gain — and the reason is not the level term but the plan term: the corridors form a Manhattan grid, where the straight-line bound is about √2 short of the real walking distance. The slack the geometric term leaves is enough to make most nodes still look like they are on a shortest path. ALT helps by 1 % here, because there simply are too many equal-cost routes. This is A\*'s standing difficulty with grid networks, not something the level layer introduces.

Trips that are mostly vertical — the great majority of indoor queries — gain an order of magnitude.

### 7.3 When the level bound switches itself off (`perLevel === 0`)

Two cases. Results stay correct in both; only the speed-up is lost.

1. **A free way to change level.** `zeroWeight: 'free'` on a zero-length lift really does make a storey free, so the bound can only be 0. **Give the lift a fixed positive cost.**
2. **A group that carries routable network but has no `ordinal`.** For example F3 → an outdoor area with no ordinal → F5 of another building: neither connector contributes to `perLevel`, so a level change could look free and the bound would no longer be admissible. **One such group switches the level term off for the whole graph.** `diagnostics().missingOrdinals` names them.

Separately, an express lift (F1→F30 in 30 seconds) really is the cheapest way to cross a storey and will push `perLevel` very low. That is not a bug — the bound ought to be that weak; use ALT there.

### 7.4 One graph per profile

For costs that change per query — "a step-free route avoids stairs" — build **one graph per profile** rather than masking edges at query time:

```ts
const walking = new LineFinder(building, { ...common, weight: walkWeight });
const stepFree = new LineFinder(building, { ...common, weight: stepFreeWeight }); // stairs return null
```

An indoor graph is small (about 13 000 vertices over 30 storeys, roughly 0.1 s to build), so a second copy is cheaper than adding query-time state to the engine contract — and it does not fight the "no closures in the hot loop" rule.

---

## 8. Diagnostics and troubleshooting

```ts
const d = graph.diagnostics();
d.connectorEnds; // a connector end that touches nothing else on its floor - the commonest fault in indoor data
d.levelReachability; // per level: which components it lies in, which levels it reaches, whether it is isolated
d.missingOrdinals; // groups without an ordinal (they switch the level bound off)
```

| Symptom                                                                     | Look at                                                                                                               |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| There is a lift, but crossing floors reports `UNREACHABLE` / `DISCONNECTED` | `connectorEnds` first (the lift end probably missed the floor vertex), then `levelReachability`                       |
| `stats.components` exceeds the number of floors                             | `levelReachability[].isolated`, plus `dangles` / `nearMisses`                                                         |
| Routes cross floors, but `graph.heuristic.perLevel === 0`                   | `missingOrdinals`; if empty, a zero-cost connector (§7.3)                                                             |
| A waypoint reports `SNAP_FAILED` / `FILTERED`                               | Is `snap.group` right? A location in the middle of a staircase is on **no** floor, so a `group` constraint rejects it |
| A waypoint reports `SCAN_LIMIT`                                             | There really is no allowed location nearby on that floor; raise `snap.searchLimit`                                    |
| No `levelChanges` in the result                                             | The graph was built without `levels`                                                                                  |
| `levelChanges` but no `verticalDistance`                                    | No level carries an `elevation`                                                                                       |

---

## 9. Workers and serialisation

A graph with `levels` or `verticalConnectors` is written as `formatVersion: 2` (three extra buffers — level ordinals, level elevations and per-vertex elevations — plus level names and the synthesised features in the header). Without them the format stays 1 and the bytes match 0.2.0. Readers accept both.

```ts
// Main thread
const data = graph.toTransferable();
worker.postMessage(data, data.buffers);

// Worker: pass the input features; the synthesised connector features come back from the header
const graph = RoutingGraph.fromTransferable(data, { features: network.features });
```

An older build reading `formatVersion: 2` fails loudly instead of silently dropping the level data.

---

## 10. Compatibility and limits

- **Default output is unchanged**: a network built without `levels` is byte-identical to 0.1.0 / 0.2.0 (guarded by golden-sample tests). Level fields appear only when it is on, and `toLevelFeatures` is a separate export that tree-shakes away.
- **The engine contract is untouched**: `SearchGraph` / `PathAlgorithm` did not change. The level bound is built inside the library and injected through `heuristic`, so custom engines need no changes.
- **Size**: +4.1 KB gzip on the core path (consumer 27.8 → 31.8 KB, IIFE 29.7 → 34.0 KB).
- **Out of scope**: a 3D distance engine; time-dependent costs (lift waiting by time of day, escalators reversing on a schedule); turn costs; deriving a network skeleton from polygon-only data such as IMDF.

---

## 11. Try it

**Online**: the repository's [GitHub Pages playground](https://geoverselabs.github.io/geoverse-line-finder/) has a **"多楼层 · 电梯 / 楼梯 / 扶梯"** (multi-level) tab — a four-storey office block whose floors overlap exactly, with three differently priced ways up.

- The floor buttons switch levels; new waypoints carry the current floor as `snap.group`.
- The route is drawn through `toLevelFeatures`: the current floor solid, the others ghosted, passages dashed in orange.
- Click an orange marker to jump to the floor that passage leads to.
- The right-hand panel shows `levelChanges`, `verticalDistance` and a table of passages.
- The three presets show: one lift ride all the way up (one ride = one section), stairs beating a walk to the lift core, and an up-only escalator forcing the lift on the way down.

**Locally**:

```bash
pnpm install
pnpm demo:dev          # http://localhost:5173
pnpm test -- levels    # the multi-level tests (random differential + admissibility property)
pnpm bench:features --only levels   # the table in §7.2
```
