import { describe, expect, it } from 'vitest';
import { LineFinder, buildGraph, type NetworkFeature, type Position } from '../src';
import { fc, line } from './helpers';

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
