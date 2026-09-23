import { describe, expect, it } from 'vitest';
import { LineFinder, RoutingGraph, buildGraph, type NetworkFeature, type Position } from '../src';
import { fc, line, mulberry32 } from './helpers';

interface FloorProps {
  floor?: string;
  elevator?: boolean;
}

/** The same cross on two floors stacked exactly on top of each other, plus an elevator at (10,10). */
function building(withElevator: boolean) {
  const features: NetworkFeature<FloorProps>[] = [];
  for (const floor of ['1', '2']) {
    features.push(
      line(
        [
          [0, 10],
          [20, 10],
        ],
        { floor },
        `ew-${floor}`,
      ),
    );
    features.push(
      line(
        [
          [10, 0],
          [10, 20],
        ],
        { floor },
        `ns-${floor}`,
      ),
    );
  }
  if (withElevator) {
    features.push(
      line(
        [
          [10, 10],
          [10, 10],
        ],
        { elevator: true },
        'elevator',
      ),
    );
  }
  return fc(features);
}

const group = (p: FloorProps) => (p.elevator ? (['1', '2'] as const) : p.floor);

describe('connectivity groups (non-planar networks)', () => {
  it('without groups, repairs join the floors', () => {
    const graph = buildGraph(building(false), { metric: 'euclidean', splitIntersections: true });
    expect(graph.stats.components).toBe(1);
  });

  it('with groups, merging and splitIntersections stay inside each floor', () => {
    const graph = buildGraph(building(false), { metric: 'euclidean', splitIntersections: true, group });
    expect(graph.stats).toMatchObject({ components: 2, groups: 3, intersectionsSplit: 2 });
  });

  it('a connector feature links floors; a zero weight can be declared free', () => {
    const blocked = new LineFinder(building(true), { metric: 'euclidean', splitIntersections: true, group });
    expect(blocked.graph.stats.components).toBe(2); // zero-length connector = weight 0 = impassable by default
    const finder = new LineFinder(building(true), {
      metric: 'euclidean',
      splitIntersections: true,
      group,
      zeroWeight: 'free',
    });
    expect(finder.graph.stats.components).toBe(1);
    const start: Position = [2, 11];
    const r = finder.route([
      { coordinates: start, snap: { group: '1' } },
      { coordinates: [10, 18], snap: { group: '2' } },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.weight).toBeCloseTo(8 + 8, 9);
    expect(r.waypoints[0].featureId).toBe('ew-1');
    expect(r.waypoints[1].featureId).toBe('ns-2');
    expect(r.legs[0].sections.map((s) => s.id)).toEqual(['ew-1', 'elevator', 'ns-2']);
  });

  it('exact snapping and candidates respect the group', () => {
    const finder = new LineFinder(building(true), { metric: 'euclidean', group, zeroWeight: 'free' });
    expect(finder.candidates([5, 10], { group: '2' }).every((c) => c.group === '2')).toBe(true);
    expect(finder.graph.findVertex(0, 10, '2')).not.toBe(finder.graph.findVertex(0, 10, '1'));
    expect(() => buildGraph(building(false), { group: 5 as never })).toThrow(TypeError);
  });
});

interface LevelProps {
  floor?: number;
  from?: number;
  to?: number;
}

const levelGroup = (p: LevelProps) => (p.floor !== undefined ? p.floor : ([p.from!, p.to!] as const));

/** Floors below `top` carry a dense 5 m grid; the top floor only a ring corridor along the edge. */
function podiumTower(top: number) {
  const features: NetworkFeature<LevelProps>[] = [];
  for (let f = 1; f < top; f++) {
    for (let i = 0; i < 20; i++) {
      features.push(
        line(
          [
            [0, i * 5],
            [95, i * 5],
          ],
          { floor: f },
          `h${i}-F${f}`,
        ),
      );
      features.push(
        line(
          [
            [i * 5, 0],
            [i * 5, 95],
          ],
          { floor: f },
          `v${i}-F${f}`,
        ),
      );
    }
  }
  features.push(
    line(
      [
        [0, 0],
        [95, 0],
        [95, 95],
        [0, 95],
        [0, 0],
      ],
      { floor: top },
      `ring-F${top}`,
    ),
  );
  return fc(features);
}

describe('group-constrained snapping scans only its group', () => {
  it('finds the top floor behind denser floors within the default searchLimit', () => {
    const finder = new LineFinder(podiumTower(3), {
      metric: 'euclidean',
      group: levelGroup,
      splitIntersections: true,
    });
    const c = finder.candidates([30, 32], { group: 3, candidates: 1 });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ featureId: 'ring-F3', group: 3 });
    expect(c[0].distance).toBeCloseTo(30, 9);
    const r = finder.route([
      { coordinates: [30, 32], snap: { group: 3 } },
      { coordinates: [2, 90], snap: { group: 3 } },
    ]);
    expect(r.ok).toBe(true);
  });

  it('returns what an unlimited scan with the same constraint would (edge, vertex, node)', () => {
    const finder = new LineFinder(podiumTower(4), {
      metric: 'euclidean',
      group: levelGroup,
      splitIntersections: true,
    });
    const random = mulberry32(7);
    for (const mode of ['edge', 'vertex', 'node'] as const) {
      for (let q = 0; q < 40; q++) {
        const p: Position = [random() * 110 - 5, random() * 110 - 5];
        const floor = 1 + Math.floor(random() * 4);
        const fast = finder.candidates(p, { mode, group: floor, candidates: 4 });
        const slow = finder.candidates(p, {
          mode,
          candidates: 4,
          searchLimit: 1e9,
          filter: (info) => info.group === floor,
        });
        expect(fast.map((c) => c.distance.toFixed(9))).toEqual(slow.map((c) => c.distance.toFixed(9)));
        expect(fast.every((c) => c.group === floor)).toBe(true);
      }
    }
  });

  it('keeps the failure details: other floors in reach → FILTERED, nothing in reach → NONE_WITHIN', () => {
    const finder = new LineFinder(podiumTower(3), { metric: 'euclidean', group: levelGroup });
    const route = (group: number | string, maxDistance: number) =>
      finder.route(
        [
          { coordinates: [30, 32], snap: { group, maxDistance } },
          { coordinates: [2, 90], snap: { group: 3 } },
        ],
        { snap: { connectivity: 'nearest' } },
      );
    expect(route(3, 10)).toMatchObject({ ok: false, reason: 'SNAP_FAILED', detail: 'FILTERED' });
    expect(route('nope', 10)).toMatchObject({ ok: false, reason: 'SNAP_FAILED', detail: 'FILTERED' });
    const far = finder.route([
      { coordinates: [300, 300], snap: { group: 3, maxDistance: 10 } },
      { coordinates: [2, 90], snap: { group: 3 } },
    ]);
    expect(far).toMatchObject({ ok: false, reason: 'SNAP_FAILED', detail: 'NONE_WITHIN' });
  });

  it('reports SCAN_LIMIT when the scan budget, not the constraint, ran out', () => {
    const finder = new LineFinder(podiumTower(3), {
      metric: 'euclidean',
      group: levelGroup,
      splitIntersections: true,
    });
    const waypoints = [
      { coordinates: [30, 32] as Position, snap: { featureIds: ['ring-F3'] } },
      { coordinates: [2, 90] as Position },
    ];
    const limited = finder.route(waypoints);
    expect(limited).toMatchObject({ ok: false, reason: 'SNAP_FAILED', detail: 'SCAN_LIMIT' });
    if (!limited.ok) expect(limited.message).toMatch(/searchLimit/);
    expect(finder.route(waypoints, { snap: { searchLimit: 1e6 } }).ok).toBe(true);
  });
});

describe('connector interiors belong to no group', () => {
  /** Floors 1 and 2; stairs from (40,40) on F1 over (42.5,42.5) to (40,45) on F2. */
  function stairs() {
    return fc<LevelProps>([
      line(
        [
          [0, 40],
          [40, 40],
          [42.5, 40],
          [60, 40],
        ],
        { floor: 1 },
        'corridor-F1',
      ),
      line(
        [
          [42.5, 30],
          [42.5, 40],
          [42.5, 42.5],
          [42.5, 50],
        ],
        { floor: 1 },
        'cross-F1',
      ),
      line(
        [
          [30, 45],
          [40, 45],
          [50, 45],
        ],
        { floor: 2 },
        'corridor-F2',
      ),
      line(
        [
          [40, 40],
          [42.5, 42.5],
          [40, 45],
        ],
        { from: 1, to: 2 },
        'stairs',
      ),
    ]);
  }

  it('a floor waypoint never snaps onto the stairs; without a group the stairs are a candidate', () => {
    const finder = new LineFinder(stairs(), { metric: 'euclidean', group: levelGroup });
    const onStairs: Position = [41, 41.2]; // right beside the first flight
    const f1 = finder.candidates(onStairs, { group: 1, candidates: 1 });
    expect(f1[0].featureId).not.toBe('stairs');
    const any = finder.candidates(onStairs, { candidates: 1 });
    expect(any[0]).toMatchObject({ featureId: 'stairs', group: undefined });
  });

  it('does not merge with a floor vertex it passes over, so the floor cannot shortcut into the stairs', () => {
    const finder = new LineFinder(stairs(), { metric: 'euclidean', group: levelGroup });
    const r = finder.route([
      { coordinates: [42.5, 45], snap: { group: 1 } },
      { coordinates: [40, 45], snap: { group: 2 } },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Down the cross corridor to (42.5, 40), along to the stair foot at (40, 40), then both flights.
    expect(r.weight).toBeCloseTo(5 + 2.5 + 2 * Math.hypot(2.5, 2.5), 9);
    expect(r.legs[0].sections.map((s) => s.id)).toEqual(['cross-F1', 'corridor-F1', 'stairs']);
  });

  it('is neither noded by splitIntersections nor folded onto its own flights', () => {
    // A switchback: out 10 m and back over the same line to the upper floor.
    const switchback = fc<LevelProps>([
      line(
        [
          [0, 0],
          [0, -10],
        ],
        { floor: 1 },
        'F1',
      ),
      line(
        [
          [0, 0],
          [0, -10],
        ],
        { floor: 2 },
        'F2',
      ),
      line(
        [
          [0, 0],
          [5, 0],
          [10, 0],
          [5, 0],
          [0, 0],
        ],
        { from: 1, to: 2 },
        'switchback',
      ),
      line(
        [
          [5, -3],
          [5, 3],
        ],
        { floor: 1 },
        'under-F1',
      ),
    ]);
    const finder = new LineFinder(switchback, {
      metric: 'euclidean',
      group: levelGroup,
      splitIntersections: true,
    });
    expect(finder.graph.stats.intersectionsSplit).toBe(0);
    const r = finder.route([
      { coordinates: [0, -10], snap: { group: 1 } },
      { coordinates: [0, -10], snap: { group: 2 } },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.weight).toBeCloseTo(10 + 20 + 10, 9);
  });

  it('stacked staircases are not reported as overlaps, and survive serialisation', () => {
    // Every floor: a corridor to the stair foot at (20, 0), round to the stair head at (20, 4) and on to (10, 4).
    const tower = fc<LevelProps>([
      ...[1, 2, 3].map((floor) =>
        line(
          [
            [0, 0],
            [20, 0],
            [20, 4],
            [10, 4],
          ],
          { floor },
          `F${floor}`,
        ),
      ),
      line(
        [
          [20, 0],
          [25, 2],
          [20, 4],
        ],
        { from: 1, to: 2 },
        'S1-2',
      ),
      line(
        [
          [20, 0],
          [25, 2],
          [20, 4],
        ],
        { from: 2, to: 3 },
        'S2-3',
      ),
    ]);
    const graph = buildGraph(tower, { metric: 'euclidean', group: levelGroup });
    expect(graph.diagnostics().overlaps.total).toBe(0);
    const copy = RoutingGraph.fromTransferable(graph.toTransferable(), { features: tower.features });
    const waypoints = [
      { coordinates: [0, 0] as Position, snap: { group: 1 } },
      { coordinates: [10, 4] as Position, snap: { group: 3 } },
    ];
    const a = new LineFinder(graph).route(waypoints);
    const b = new LineFinder(copy).route(waypoints);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.weight).toBe(a.weight);
      expect(b.path).toEqual(a.path);
    }
    expect(new LineFinder(copy).candidates([24, 2], { candidates: 1 })[0].group).toBeUndefined();
  });
});
