import { describe, expect, it } from 'vitest';
import {
  createPropertyWeight,
  createSpeedWeight,
  directional,
  osmDirection,
  type WeightResult,
} from '../src';
import { normalizeWeight } from '../src/weight/weight';

const norm = (value: WeightResult) => {
  const out = { forward: NaN, backward: NaN };
  normalizeWeight(value, out, 'test');
  return out;
};

const ctx = { distance: 100, featureIndex: 0, feature: { geometry: null } };

describe('normalizeWeight (geojson-path-finder contract)', () => {
  it('numbers apply to both directions', () => {
    expect(norm(5)).toEqual({ forward: 5, backward: 5 });
  });

  it('falsy, NaN and Infinity mean impassable', () => {
    for (const v of [0, NaN, Infinity, null, undefined, false] as WeightResult[]) {
      expect(norm(v)).toEqual({ forward: Infinity, backward: Infinity });
    }
  });

  it('objects give per-direction costs; a missing direction is impassable', () => {
    expect(norm({ forward: 3 })).toEqual({ forward: 3, backward: Infinity });
    expect(norm({ forward: 2, backward: 4 })).toEqual({ forward: 2, backward: 4 });
    expect(norm({ backward: NaN, forward: 0 })).toEqual({ forward: Infinity, backward: Infinity });
  });

  it('rejects negative and non-numeric costs loudly', () => {
    expect(() => norm(-1)).toThrow(RangeError);
    expect(() => norm({ backward: -2 })).toThrow(RangeError);
    expect(() => norm('7' as never)).toThrow(TypeError);
  });
});

describe('weight presets', () => {
  it('createPropertyWeight scales the length and applies direction', () => {
    const w = createPropertyWeight<{ f: number; dir?: 'forward' }>({
      factor: (p) => p.f,
      direction: (p) => p.dir ?? 'both',
    });
    expect(w([0, 0], [1, 0], { f: 2 }, ctx)).toBe(200);
    expect(w([0, 0], [1, 0], { f: 2, dir: 'forward' }, ctx)).toEqual({ forward: 200 });
    expect(norm(w([0, 0], [1, 0], { f: 0 }, ctx))).toEqual({ forward: Infinity, backward: Infinity });
  });

  it('createSpeedWeight returns seconds', () => {
    const w = createSpeedWeight<{ kmh?: number }>({ speed: (p) => p.kmh });
    expect(w([0, 0], [1, 0], { kmh: 36 }, ctx)).toBeCloseTo(10, 12);
    expect(w([0, 0], [1, 0], {}, ctx)).toBeNull();
  });

  it('directional()', () => {
    expect(directional(4, 'both')).toBe(4);
    expect(directional(4, 'backward')).toEqual({ backward: 4 });
    expect(directional(4, 'none')).toBeNull();
  });

  it('osmDirection follows OSM tagging', () => {
    expect(osmDirection({ oneway: 'yes' })).toBe('forward');
    expect(osmDirection({ oneway: '-1' })).toBe('backward');
    expect(osmDirection({ oneway: 'no', junction: 'roundabout' })).toBe('both');
    expect(osmDirection({ junction: 'roundabout' })).toBe('forward');
    expect(osmDirection({ highway: 'residential' })).toBe('both');
    expect(osmDirection(null)).toBe('both');
  });
});
