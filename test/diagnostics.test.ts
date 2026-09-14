import { describe, expect, it } from 'vitest';
import { buildGraph, createPropertyWeight } from '../src';
import { LEVEL_FACTOR, warehouseNetwork, type AisleProps } from './fixtures/warehouse';
import { fc, line } from './helpers';

const tee = (gap: number) =>
  fc([
    line(
      [
        [0, 0],
        [20, 0],
      ],
      {},
      'main',
    ),
    line(
      [
        [10, gap],
        [10, 10],
      ],
      {},
      'branch',
    ),
  ]);

describe('graph.diagnostics()', () => {
  it('locates dead ends and near misses', () => {
    const d = buildGraph(tee(0.3), { metric: 'euclidean' }).diagnostics({ nearMissDistance: 0.5 });
    expect(d.dangles.total).toBe(4);
    expect(d.nearMisses.items).toHaveLength(1);
    expect(d.nearMisses.items[0]).toMatchObject({
      location: [10, 0.3],
      featureId: 'branch',
      nearestFeatureIndex: 0,
    });
    expect(d.nearMisses.items[0].nearestDistance).toBeCloseTo(0.3, 12);
    expect(d.repairs).toBeNull();
    expect(d.invalidCoordinates).toBeNull();
    expect(d.components.total).toBe(2);
    expect(d.components.items[0].bbox).toHaveLength(4);
  });

  it('logs repairs when the graph is built with diagnostics: true', () => {
    const d = buildGraph(tee(0.3), {
      metric: 'euclidean',
      snapDangles: 0.5,
      diagnostics: true,
    }).diagnostics();
    expect(d.repairs!.items).toMatchObject([{ kind: 'dangle', location: [10, 0], featureIndices: [1, 0] }]);
    expect(d.repairs!.items[0].gap).toBeCloseTo(0.3, 12);
    expect(d.nearMisses.total).toBe(0);
    expect(d.components.total).toBe(1);
  });

  it('agrees with the statistics on the unnormalised warehouse', () => {
    const weight = createPropertyWeight<AisleProps>({ factor: (p) => LEVEL_FACTOR[p.roadLevel] });
    const raw = buildGraph(warehouseNetwork(false), { weight, diagnostics: true });
    expect(raw.diagnostics().components.total).toBe(raw.stats.components);
    const split = buildGraph(warehouseNetwork(false), {
      weight,
      splitIntersections: true,
      diagnostics: true,
    });
    expect(split.stats.intersectionsSplit).toBe(200);
    const repairs = split.diagnostics({ limit: 5 }).repairs!;
    expect(repairs).toMatchObject({ total: 200, truncated: 195 });
    expect(repairs.items).toHaveLength(5);
    expect(repairs.items.every((r) => r.kind === 'split')).toBe(true);
    expect(split.diagnostics().components.total).toBe(1);
  });

  it('reports merges, invalid coordinates and collinear overlaps', () => {
    const network = fc([
      line(
        [
          [0, 0],
          [10, 0],
        ],
        {},
        'a',
      ),
      line(
        [
          [10.2, 0],
          [20, 0],
        ],
        {},
        'b',
      ),
      line(
        [
          [0, 5],
          [NaN, 5],
          [10, 5],
        ],
        {},
        'broken',
      ),
      line(
        [
          [30, 0],
          [40, 0],
        ],
        {},
        'c',
      ),
      line(
        [
          [35, 0],
          [45, 0],
        ],
        {},
        'd',
      ),
    ]);
    const d = buildGraph(network, { metric: 'euclidean', tolerance: 0.5, diagnostics: true }).diagnostics();
    expect(d.repairs!.items).toMatchObject([{ kind: 'merge', location: [10.2, 0], featureIndices: [1, 0] }]);
    expect(d.repairs!.items[0].gap).toBeCloseTo(0.2, 9);
    expect(d.invalidCoordinates!.items).toEqual([{ featureIndex: 2, partIndex: 0, coordinateIndex: 1 }]);
    expect(d.overlaps.total).toBe(1);
    expect([...d.overlaps.items[0].featureIndices].sort()).toEqual([3, 4]);
    expect(d.overlaps.items[0].length).toBeCloseTo(5, 9);
    expect(() => buildGraph(network).diagnostics({ limit: -1 })).toThrow(RangeError);
  });
});
