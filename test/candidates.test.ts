import { describe, expect, it } from 'vitest';
import { LineFinder } from '../src';
import { LEVEL_FACTOR, toLngLat, warehouseNetwork, type AisleProps } from './fixtures/warehouse';
import { fc, line } from './helpers';
import { createPropertyWeight } from '../src';

// main:   (0,0) ─────── (10,0) ─────── (20,0)
//                          │ branch
//                        (10,10)
const tee = fc([
  line(
    [
      [0, 0],
      [20, 0],
    ],
    { name: 'main' },
    'main',
  ),
  line(
    [
      [10, 0],
      [10, 10],
    ],
    { name: 'branch' },
    'branch',
  ),
]);

describe('candidates()', () => {
  // splitIntersections nodes the T so (10,0) is a junction of both features.
  const finder = new LineFinder(tee, { metric: 'euclidean', splitIntersections: true });

  it('lists allowed locations nearest first with feature, side and measure', () => {
    const list = finder.candidates([4, 3]);
    expect(list.length).toBeGreaterThan(1);
    expect(list.map((c) => c.rank)).toEqual(list.map((_c, i) => i));
    expect(list[0]).toMatchObject({
      location: [4, 0],
      distance: 3,
      featureId: 'main',
      side: 'left',
      measure: 4,
      rank: 0,
    });
    expect(finder.candidates([4, -3])[0].side).toBe('right');
    const branch = list.find((c) => c.featureId === 'branch')!;
    expect(branch.location).toEqual([10, 3]);
    expect(branch.measure).toBe(3);
    for (let i = 1; i < list.length; i++)
      expect(list[i].distance).toBeGreaterThanOrEqual(list[i - 1].distance);
  });

  it('describes a junction with every touching feature, so featureIds do not reject it', () => {
    const [junction] = finder.candidates([10, -1], { mode: 'node' });
    expect(junction.location).toEqual([10, 0]);
    expect(junction.featureIndex).toBe(-1);
    expect([...junction.featureIndices].sort()).toEqual([0, 1]);
    const onlyBranch = finder.candidates([10, -1], { mode: 'node', featureIds: ['branch'] });
    expect(onlyBranch[0].location).toEqual([10, 0]);
  });

  it('applies featureIds, filter and per-point options as hard constraints', () => {
    expect(
      finder.candidates([4, 3], { featureIds: ['branch'] }).every((c) => c.featureIndices.includes(1)),
    ).toBe(true);
    const leftOnly = finder.candidates([4, 3], { filter: (c) => c.side !== 'right' });
    expect(leftOnly.every((c) => c.side !== 'right')).toBe(true);
    const perPoint = finder.candidates({ coordinates: [4, 3], snap: { featureIds: ['branch'] } });
    expect(perPoint[0].featureId).toBe('branch');
  });

  it('reports FILTERED when constraints remove every location', () => {
    const r = finder.route([[4, 3], { coordinates: [15, 1], snap: { featureIds: ['nope'] } }]);
    expect(r).toMatchObject({ ok: false, reason: 'SNAP_FAILED', detail: 'FILTERED', waypointIndex: 1 });
    const far = finder.route(
      [
        [4, 3],
        [15, 1],
      ],
      { snap: { maxDistance: 0.5 } },
    );
    expect(far).toMatchObject({ ok: false, reason: 'SNAP_FAILED', detail: 'NONE_WITHIN', waypointIndex: 0 });
  });

  it('validates candidate options', () => {
    expect(() => finder.candidates([0, 0], { candidates: 0 })).toThrow(RangeError);
    expect(() => finder.candidates([0, 0], { candidates: 17 })).toThrow(RangeError);
    expect(() =>
      finder.route(
        [
          [0, 0],
          [1, 0],
        ],
        { snap: { cost: -1 } },
      ),
    ).toThrow(RangeError);
    expect(() =>
      finder.route(
        [
          [0, 0],
          [1, 0],
        ],
        { snap: { selection: 'best' as never } },
      ),
    ).toThrow(RangeError);
    expect(() => finder.candidates('x' as never)).toThrow(TypeError);
  });
});

describe('constraints on the synthetic warehouse', () => {
  const finder = new LineFinder(warehouseNetwork(), {
    weight: createPropertyWeight<AisleProps>({ factor: (p) => LEVEL_FACTOR[p.roadLevel] }),
  });
  // A location facing side aisle 10 (1.9 m away) whose back aisle 11 is closer (1.7 m).
  const location = toLngLat(10 * 3.6 + 1.9, 30);
  const target = toLngLat(40 * 3.6 - 1.5, 90);

  it('the nearest location is behind the rack without constraints', () => {
    const r = new LineFinder(finder.graph).route([location, target], { snap: { connectivity: 'nearest' } });
    expect(r.ok && r.waypoints[0].featureId).toBe('side-11-s');
  });

  it('featureIds keep the location on its facing aisle (nearest and optimal selection)', () => {
    for (const selection of ['nearest', 'optimal'] as const) {
      // costMode 'ends': with free snapping (the default 'none') optimal selection would happily jump 30 m to
      // the junction of aisle 10 with the main aisle, which also belongs to the allowed feature.
      const r = finder.route([{ coordinates: location, snap: { featureIds: ['side-10'] } }, target], {
        snap: { selection, connectivity: 'nearest', costMode: 'ends' },
      });
      expect(r.ok, selection).toBe(true);
      if (!r.ok) continue;
      // (Haversine distances of cheap-ruler-placed points differ from the planar metres by ~0.2 %.)
      expect(r.waypoints[0].featureId).toBe('side-10-s');
      expect(r.waypoints[0].distance).toBeCloseTo(1.9, 1);
      expect(r.waypoints[0].nearestDistance).toBe(r.waypoints[0].distance);
    }
  });
});
