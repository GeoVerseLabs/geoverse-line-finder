import { describe, expect, it } from 'vitest';
import { LineFinder, type Position } from '../src';
import { gridWeight, mulberry32, randomGrid } from './helpers';

describe('one-to-many and matrices', () => {
  for (let seed = 1; seed <= 4; seed++) {
    it(`agree with individual routes (random grid #${seed})`, () => {
      const rand = mulberry32(900 + seed);
      const network = randomGrid(rand, 8);
      const finder = new LineFinder(network, { metric: 'euclidean', weight: gridWeight });
      const source: Position = [rand() * 70, rand() * 70];
      const targets: Position[] = Array.from({ length: 20 }, () => [rand() * 70, rand() * 70]);
      for (const algorithm of ['astar', 'dijkstra']) {
        const many = finder.oneToMany(source, targets, { algorithm, paths: true });
        expect(many.ok).toBe(true);
        if (!many.ok) continue;
        targets.forEach((t, i) => {
          const single = finder.route([source, t], { algorithm, snap: { connectivity: 'nearest' } });
          if (!single.ok) {
            expect(many.weights[i]).toBe(Infinity);
            return;
          }
          expect(many.weights[i]).toBeCloseTo(single.weight, 9);
          expect(many.distances[i]).toBeCloseTo(single.distance, 9);
          expect(many.legs![i]!.distance).toBeCloseTo(single.distance, 9);
        });
      }
      const matrix = finder.matrix(targets.slice(0, 4), targets.slice(4, 9));
      expect(matrix.ok).toBe(true);
      if (!matrix.ok) return;
      for (let i = 0; i < 4; i++) {
        const row = finder.oneToMany(targets[i], targets.slice(4, 9));
        expect(row.ok && matrix.weights[i]).toEqual(row.ok && row.weights);
      }
    });
  }

  it('reports unsnappable points', () => {
    const finder = new LineFinder(randomGrid(mulberry32(1), 4), { metric: 'euclidean' });
    expect(finder.oneToMany([500, 500], [[5, 5]], { snap: { maxDistance: 10 } })).toMatchObject({
      ok: false,
      reason: 'SNAP_FAILED',
    });
    const r = finder.oneToMany([5, 5], [[500, 500]], { snap: { maxDistance: 10 } });
    expect(r.ok && r.targets[0]).toBeNull();
    expect(r.ok && r.weights[0]).toBe(Infinity);
    expect(finder.oneToMany('x' as never, [])).toMatchObject({ ok: false, reason: 'INVALID_INPUT' });
  });
});
