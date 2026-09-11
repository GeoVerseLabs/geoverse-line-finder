import { describe, expect, it } from 'vitest';
import { LineFinder } from '../src';
import { fc, line } from './helpers';

// main:   (0,0) ─ (5,0) ─ (10,0) ─ (20,0)      (5,0) is a shape point, (10,0) a junction
//                          │
//                        (10,10)
// island: (0,50) ─ (5,50)                      separate component
const network = fc([
  line(
    [
      [0, 0],
      [5, 0],
      [10, 0],
      [20, 0],
    ],
    { name: 'main' },
  ),
  line(
    [
      [10, 0],
      [10, 10],
    ],
    { name: 'branch' },
  ),
  line(
    [
      [0, 50],
      [5, 50],
    ],
    { name: 'island' },
  ),
]);
const finder = new LineFinder(network, { metric: 'euclidean' });

describe('snapping modes', () => {
  it('edge (default) projects onto the nearest segment', () => {
    expect(finder.nearest([4, 3])).toEqual({
      location: [4, 0],
      distance: 3,
      component: expect.any(Number),
      featureIndex: 0,
    });
    expect(finder.nearest([12, 7])?.location).toEqual([10, 7]);
  });

  it('vertex picks the nearest network vertex, shape points included', () => {
    expect(finder.nearest([5.5, 2], { mode: 'vertex' })?.location).toEqual([5, 0]);
  });

  it('node picks the nearest junction or dead end', () => {
    expect(finder.nearest([5.5, 2], { mode: 'node' })?.location).toEqual([10, 0]);
  });

  it('exact requires a network vertex', () => {
    const miss = finder.route(
      [
        [0, 0],
        [4, 0],
      ],
      { snap: { mode: 'exact' } },
    );
    expect(miss).toMatchObject({ ok: false, reason: 'SNAP_FAILED', waypointIndex: 1 });
    const hit = finder.route(
      [
        [0, 0],
        [5, 0],
      ],
      { snap: { mode: 'exact' } },
    );
    expect(hit.ok && hit.weight).toBe(5);
  });

  it('maxDistance rejects far waypoints', () => {
    expect(
      finder.route(
        [
          [4, 30],
          [20, 0],
        ],
        { snap: { maxDistance: 5 } },
      ),
    ).toMatchObject({
      ok: false,
      reason: 'SNAP_FAILED',
      waypointIndex: 0,
    });
    expect(finder.nearest([4, 30], { maxDistance: 5 })).toBeNull();
  });
});

describe('connectivity-aware snapping', () => {
  it('moves a waypoint off an unconnected island when the others share a component', () => {
    const r = finder.route([
      [2, 45],
      [20, 1],
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.waypoints[0].location).toEqual([10, 10]);
    expect(r.waypoints[0].distance).toBeCloseTo(Math.hypot(8, 35), 9);
    expect(r.weight).toBeCloseTo(10 + 10, 9);
  });

  it('with connectivity "nearest" the same query is unreachable', () => {
    const r = finder.route(
      [
        [2, 45],
        [20, 1],
      ],
      { snap: { connectivity: 'nearest' } },
    );
    expect(r).toMatchObject({ ok: false, reason: 'UNREACHABLE', legIndex: 0 });
  });

  it('reports DISCONNECTED when no shared component is within reach', () => {
    const r = finder.route(
      [
        [2, 45],
        [20, 1],
      ],
      { snap: { maxDistance: 10 } },
    );
    expect(r).toMatchObject({ ok: false, reason: 'DISCONNECTED' });
  });

  it('keeps the nearest locations when they already agree, even on the island', () => {
    const r = finder.route([
      [1, 51],
      [4, 49],
    ]);
    expect(r.ok && r.path).toEqual([
      [1, 50],
      [4, 50],
    ]);
  });
});
