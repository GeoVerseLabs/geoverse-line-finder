import { describe, expect, it } from 'vitest';
import { EARTH_RADIUS_M, cheapRulerMetric, euclideanMetric, haversineMetric, type Metric } from '../src';
import { resolveMetric } from '../src/geo/metric';
import { mulberry32 } from './helpers';

function embedDistance(metric: Metric, a: number[], b: number[]): number {
  const ea = new Float64Array(metric.embedDims);
  const eb = new Float64Array(metric.embedDims);
  metric.embed!(a[0], a[1], ea, 0);
  metric.embed!(b[0], b[1], eb, 0);
  let s = 0;
  for (let i = 0; i < metric.embedDims; i++) s += (ea[i] - eb[i]) ** 2;
  return Math.sqrt(s);
}

describe('metrics', () => {
  it('haversine: one degree of latitude on the IUGG sphere', () => {
    expect(haversineMetric.distance([0, 0], [0, 1])).toBeCloseTo((EARTH_RADIUS_M * Math.PI) / 180, 6);
    expect(haversineMetric.distance([13.4, 52.5], [13.4, 52.5])).toBe(0);
  });

  it('embeddings are lower bounds of their metric (A* admissibility)', () => {
    const rand = mulberry32(5);
    for (let i = 0; i < 2000; i++) {
      const a = [rand() * 360 - 180, rand() * 170 - 85];
      const b = [
        a[0] + (rand() - 0.5) * (i % 2 ? 0.2 : 120),
        Math.max(-85, Math.min(85, a[1] + (rand() - 0.5) * 40)),
      ];
      const d = haversineMetric.distance(a, b);
      expect(embedDistance(haversineMetric, a, b)).toBeLessThanOrEqual(d * (1 + 1e-12) + 1e-9);
    }
    const ruler = cheapRulerMetric(40);
    for (let i = 0; i < 500; i++) {
      const a = [116 + rand(), 39.5 + rand()];
      const b = [116 + rand(), 39.5 + rand()];
      expect(embedDistance(ruler, a, b)).toBeCloseTo(ruler.distance(a, b), 6);
      expect(embedDistance(euclideanMetric, a, b)).toBeCloseTo(euclideanMetric.distance(a, b), 12);
    }
  });

  it('cheap ruler agrees with haversine at city scale', () => {
    const rand = mulberry32(9);
    const ruler = cheapRulerMetric(59.5);
    for (let i = 0; i < 500; i++) {
      const a = [8.44 + rand() * 0.05, 59.48 + rand() * 0.05];
      const b = [8.44 + rand() * 0.05, 59.48 + rand() * 0.05];
      const h = haversineMetric.distance(a, b);
      if (h < 1) continue;
      expect(Math.abs(ruler.distance(a, b) - h) / h).toBeLessThan(0.01);
    }
  });

  it('resolves metric options', () => {
    expect(resolveMetric(undefined, 0).name).toBe('haversine');
    expect(resolveMetric('euclidean', 0)).toBe(euclideanMetric);
    expect(resolveMetric('cheap-ruler', 30).name).toBe('cheap-ruler');
    const custom = resolveMetric(
      {
        name: 'manhattan',
        geographic: false,
        embedDims: 2,
        distance: (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]),
      },
      0,
    );
    expect(custom.embedDims).toBe(0); // no embed() → no heuristic
    expect(() => resolveMetric('nope' as never, 0)).toThrow(/Unknown metric/);
  });
});
