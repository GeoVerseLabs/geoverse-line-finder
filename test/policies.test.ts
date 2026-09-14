import { describe, expect, it } from 'vitest';
import { LineFinder, buildGraph, createPropertyWeight, type Position } from '../src';
import { LEVEL_FACTOR, warehouseNetwork, warehouseTasks, type AisleProps } from './fixtures/warehouse';
import { fc, line } from './helpers';

// Ladder with a detached island east of it.
const network = fc([
  line(
    [
      [0, 0],
      [10, 0],
      [20, 0],
    ],
    {},
    'south',
  ),
  line(
    [
      [0, 10],
      [10, 10],
      [20, 10],
    ],
    {},
    'north',
  ),
  line(
    [
      [0, 0],
      [0, 10],
    ],
    {},
    'west',
  ),
  line(
    [
      [20, 0],
      [20, 10],
    ],
    {},
    'east',
  ),
  line(
    [
      [100, 0],
      [110, 0],
    ],
    {},
    'island',
  ),
]);
const finder = new LineFinder(network, { metric: 'euclidean', snap: { connectivity: 'nearest' } });
const A: Position = [2, 1]; // snaps to (2,0) on the south line
const X: Position = [105, 1]; // snaps onto the island: unreachable
const B: Position = [20, 5];
const C: Position = [5, 10];
const FAR: Position = [500, 500];

describe('onFailure', () => {
  it("'fail' (default) keeps the 0.1.0 behaviour", () => {
    expect(finder.route([A, X, B, C])).toMatchObject({ ok: false, reason: 'UNREACHABLE', legIndex: 0 });
  });

  it("'skip' drops an unreachable waypoint and continues from the last good one", () => {
    const r = finder.route([A, X, B, C], { onFailure: 'skip' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.legs.map((l) => [l.from, l.to])).toEqual([
      [0, 2],
      [2, 3],
    ]);
    expect(r.skipped).toMatchObject([{ index: 1, reason: 'UNREACHABLE' }]);
    expect(r.complete).toBe(false);
    expect(r.waypoints[1]).toMatchObject({ used: false, snapped: true });
    const direct = finder.route([A, B, C]);
    expect(direct.ok && r.weight).toBeCloseTo(direct.ok ? direct.weight : NaN, 12);
  });

  it("'straight' bridges the gap with straight legs", () => {
    const r = finder.route([A, X, B], { onFailure: 'straight', straightCost: (d) => 2 * d });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.legs.map((l) => l.kind)).toEqual(['straight', 'straight']);
    expect(r.legs[0].path).toEqual([
      [2, 0],
      [105, 0],
    ]);
    expect(r.straightDistance).toBeCloseTo(103 + Math.hypot(85, 5), 9);
    expect(r.weight).toBeCloseTo(2 * r.straightDistance, 9);
    expect(r.legs[0].sections).toEqual([]);
  });

  it('snap failures: leading, max and ALL_SKIPPED', () => {
    expect(finder.route([FAR, A, B], { onFailure: 'skip', snap: { maxDistance: 20 } })).toMatchObject({
      ok: false,
      reason: 'SNAP_FAILED',
      waypointIndex: 0,
    });
    const leading = finder.route([FAR, A, B], {
      onFailure: 'skip',
      skip: { leading: true },
      snap: { maxDistance: 20 },
    });
    expect(leading.ok && leading.legs.map((l) => [l.from, l.to])).toEqual([[1, 2]]);
    expect(finder.route([A, X, X, B], { onFailure: 'skip', skip: { max: 1 } })).toMatchObject({
      ok: false,
      reason: 'UNREACHABLE',
      waypointIndex: 2,
    });
    expect(finder.route([A, X, X], { onFailure: 'skip' })).toMatchObject({
      ok: false,
      reason: 'ALL_SKIPPED',
    });
    const straight = finder.route([A, FAR, B], { onFailure: 'straight', snap: { maxDistance: 20 } });
    expect(straight.ok && straight.waypoints[1]).toMatchObject({ snapped: false, location: FAR });
    expect(straight.ok && straight.legs[0].path).toEqual([[2, 0], FAR]);
  });

  it('works the same in optimal selection', () => {
    // Without maxRelocation, free snapping would simply move X 85 m back onto the main network.
    const free = finder.route([A, X, B], { snap: { selection: 'optimal', candidates: 2 } });
    expect(free.ok && free.waypoints[1].relocation).toBeGreaterThan(80);
    const snap = { selection: 'optimal' as const, candidates: 2, maxRelocation: 5 };
    const skip = finder.route([A, X, B, C], { onFailure: 'skip', snap });
    expect(skip.ok && skip.legs.map((l) => [l.from, l.to])).toEqual([
      [0, 2],
      [2, 3],
    ]);
    const straight = finder.route([A, X, B], { onFailure: 'straight', snap });
    expect(straight.ok && straight.legs.map((l) => l.kind)).toEqual(['straight', 'straight']);
    expect(finder.route([A, X, B], { snap })).toMatchObject({
      ok: false,
      reason: 'UNREACHABLE',
      legIndex: 0,
    });
    expect(finder.route([A, FAR, B], { snap: { ...snap, maxDistance: 20 } })).toMatchObject({
      ok: false,
      reason: 'SNAP_FAILED',
      waypointIndex: 1,
    });
  });
});

describe('connectors and totals', () => {
  it("'legs' wraps every leg in connectors and totals can include them", () => {
    const points: Position[] = [
      [5, 3],
      [15, 7],
      [2, 9],
    ];
    const plain = finder.route(points);
    const legs = finder.route(points, { connectors: 'legs', totals: { includeConnectorDistance: true } });
    expect(plain.ok && legs.ok).toBe(true);
    if (!plain.ok || !legs.ok) return;
    expect(legs.legs[0].path[0]).toEqual([5, 3]);
    expect(legs.legs[0].path[legs.legs[0].path.length - 1]).toEqual([15, 7]);
    expect(legs.legs[1].path[0]).toEqual([15, 7]);
    expect(legs.legs[0].connectorDistance).toBeCloseTo(3 + 3, 12);
    expect(legs.connectorDistance).toBeCloseTo(3 + 3 + 3 + 1, 12);
    expect(legs.distance).toBeCloseTo(plain.distance + legs.connectorDistance, 12);
    expect(legs.networkDistance).toBeCloseTo(plain.distance, 12);
    expect(legs.path[0]).toEqual([5, 3]);
    const ends = finder.route(points, { connectors: 'ends' });
    expect(ends.ok && ends.connectorDistance).toBeCloseTo(3 + 1, 12);
  });

  it('snap costs enter the weight only when asked', () => {
    const points: Position[] = [
      [5, 3],
      [15, 7],
      [2, 9],
    ];
    const ends = finder.route(points, { snap: { costMode: 'ends' } });
    const both = finder.route(points, {
      snap: { costMode: 'arrive-depart', cost: 2 },
      totals: { includeSnapWeight: true },
    });
    expect(ends.ok && both.ok).toBe(true);
    if (!ends.ok || !both.ok) return;
    expect(ends.snapWeight).toBeCloseTo(3 + 1, 12);
    expect(ends.weight).toBe(ends.networkWeight);
    expect(both.snapWeight).toBeCloseTo(2 * (3 + 3 + 3 + 1), 12);
    expect(both.weight).toBeCloseTo(both.networkWeight + both.snapWeight, 12);
    expect(both.waypoints.map((w) => w.snapCost)).toEqual([6, 12, 2]);
  });
});

describe('relocation (R3)', () => {
  const weight = createPropertyWeight<AisleProps>({ factor: (p) => LEVEL_FACTOR[p.roadLevel] });
  const raw = new LineFinder(warehouseNetwork(false), { weight });
  const tasks = warehouseTasks(40);

  it('the default connected snapping moves waypoints and says so', () => {
    let moved = 0;
    for (const task of tasks) {
      const r = raw.route(task.map((w) => w.coordinates));
      if (!r.ok) continue;
      for (const w of r.waypoints) {
        expect(w.relocation).toBeCloseTo(w.distance - w.nearestDistance, 12);
        if (w.relocation > 5) {
          moved++;
          expect(w.relocated).toBe(true);
        }
      }
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('maxRelocation caps the move', () => {
    let ok = 0;
    let limited = 0;
    for (const task of tasks) {
      for (let i = 0; i + 1 < task.length; i++) {
        const r = raw.route([task[i].coordinates, task[i + 1].coordinates], { snap: { maxRelocation: 5 } });
        if (!r.ok) {
          expect(['DISCONNECTED', 'UNREACHABLE']).toContain(r.reason);
          if (r.detail === 'RELOCATION_LIMIT') limited++;
          continue;
        }
        ok++;
        for (const w of r.waypoints) expect(w.relocation).toBeLessThanOrEqual(5);
      }
    }
    expect(ok).toBeGreaterThan(0);
    expect(limited).toBeGreaterThan(0);
  });
});

describe('budgets', () => {
  it('maxSettled stops a search and maxCost bounds a leg', () => {
    expect(finder.route([A, B], { budget: { maxSettled: 1 } })).toMatchObject({
      ok: false,
      reason: 'BUDGET_EXCEEDED',
    });
    expect(finder.route([A, B], { budget: { maxCost: 5 } })).toMatchObject({
      ok: false,
      reason: 'UNREACHABLE',
      detail: 'BEYOND_MAX_COST',
    });
    const r = finder.route([A, B], { budget: { maxCost: 1000, maxSettled: 1000 } });
    expect(r.ok).toBe(true);
    expect(() => finder.route([A, B], { budget: { maxCost: -1 } })).toThrow(RangeError);
  });
});

describe("connectivity: 'reachable' on one-way networks", () => {
  // A one-way loop (clockwise) plus a one-way spur leaving it: the spur's end can be reached but never left.
  const oneway = fc([
    line(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      { oneway: true },
      'loop',
    ),
    line(
      [
        [10, 0],
        [30, 0],
      ],
      { oneway: true },
      'spur',
    ),
  ]);
  const weight = (_a: Position, _b: Position, p: { oneway?: boolean }, ctx: { distance: number }) =>
    p.oneway ? { forward: ctx.distance } : ctx.distance;

  it('moves a waypoint off a dead-end spur so every leg exists', () => {
    const f = new LineFinder(oneway, { metric: 'euclidean', weight });
    const points: Position[] = [
      [25, 1],
      [5, 11],
    ];
    expect(f.route(points)).toMatchObject({ ok: false, reason: 'UNREACHABLE' });
    const r = f.route(points, { snap: { connectivity: 'reachable' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.waypoints[0].featureId).toBe('loop');
    expect(f.graph.strongComponents().count).toBeGreaterThan(1);
  });
});

describe('input guards', () => {
  it('rejects projected coordinates with a geographic metric', () => {
    const mercator = fc([
      line([
        [1_300_000, 6_700_000],
        [1_300_100, 6_700_000],
      ]),
    ]);
    expect(() => buildGraph(mercator)).toThrow(/euclidean/);
    expect(buildGraph(mercator, { metric: 'euclidean' }).stats.segments).toBe(1);
  });

  it('rejects segments crossing the antimeridian', () => {
    const crossing = fc([
      line([
        [179.9, 10],
        [-179.9, 10],
      ]),
    ]);
    expect(() => buildGraph(crossing)).toThrow(/antimeridian/);
  });
});
