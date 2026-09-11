import { describe, expect, it } from 'vitest';
import { VertexStore } from '../src/graph/vertex-store';

describe('VertexStore', () => {
  it('exact mode merges identical coordinates only', () => {
    const store = new VertexStore({ tolerance: 0, geographic: true, maxAbsLat: 60 });
    const a = store.getOrAdd([10, 59.5]);
    expect(store.getOrAdd([10, 59.5])).toBe(a);
    expect(store.getOrAdd([10, 59.5000001])).not.toBe(a);
    expect(store.getOrAdd([10, 59.5, 42])).toBe(a); // z does not take part in identity
    expect(store.merged).toBe(2);
    expect(store.find(10, 59.5)).toBe(a);
    expect(store.find(11, 59.5)).toBe(-1);
  });

  it('tolerance merges points that coordinate rounding would split', () => {
    // geojson-path-finder keys vertices by Math.round(c / 1e-5): these two points 0.02 m apart land in
    // different rounding cells and would never connect.
    expect(Math.round(10.0000049 / 1e-5)).not.toBe(Math.round(10.0000051 / 1e-5));
    const store = new VertexStore({ tolerance: 1, geographic: true, maxAbsLat: 60 });
    const a = store.getOrAdd([10.0000049, 59.5]);
    expect(store.getOrAdd([10.0000051, 59.5])).toBe(a);
  });

  it('does not merge beyond the tolerance, including along longitude at high latitude', () => {
    const store = new VertexStore({ tolerance: 1, geographic: true, maxAbsLat: 60 });
    const a = store.getOrAdd([10, 59.5]);
    // 3e-5° of longitude at 59.5° N is ≈ 1.69 m.
    expect(store.getOrAdd([10.00003, 59.5])).not.toBe(a);
    // 1.2e-5° of longitude is ≈ 0.68 m: merged even though it is > 1 m worth of longitude at the equator.
    expect(store.getOrAdd([10.000012, 59.5])).toBe(a);
  });

  it('chooses the nearest representative in planar mode', () => {
    const store = new VertexStore({ tolerance: 1, geographic: false, maxAbsLat: 0 });
    const a = store.append(0, 0, [0, 0]);
    const b = store.append(1.5, 0, [1.5, 0]);
    expect(store.getOrAdd([0.9, 0])).toBe(b);
    expect(store.getOrAdd([0.6, 0])).toBe(a);
    expect(store.getOrAdd([3, 3])).toBe(2);
  });
});
