import { describe, expect, it } from 'vitest';
import { LineFinder, type Position } from '../src';
import { fc, gridWeight, line, mulberry32, randomGrid, sum } from './helpers';

describe('linear referencing (sections with measures)', () => {
  const bend = fc([
    line(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      {},
      'bend',
    ),
    line(
      [
        [10, 10],
        [30, 10],
      ],
      {},
      'east',
    ),
  ]);
  const finder = new LineFinder(bend, { metric: 'euclidean' });

  it('reports measures along the digitised direction, decreasing when travelling against it', () => {
    const forward = finder.route([
      [2, 1],
      [20, 11],
    ]);
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;
    expect(forward.legs[0].sections.map((s) => [s.id, s.fromMeasure, s.toMeasure, s.partIndex])).toEqual([
      ['bend', 2, 20, 0],
      ['east', 0, 10, 0],
    ]);
    const backward = finder.route([
      [20, 11],
      [2, 1],
    ]);
    expect(backward.ok && backward.legs[0].sections.map((s) => [s.id, s.fromMeasure, s.toMeasure])).toEqual([
      ['east', 10, 0],
      ['bend', 20, 2],
    ]);
  });

  it("'segment' detail returns one section per traversed segment", () => {
    const r = finder.route(
      [
        [2, 1],
        [10, 5],
      ],
      { sectionsDetail: 'segment' },
    );
    expect(r.ok && r.legs[0].sections.map((s) => [s.fromMeasure, s.toMeasure])).toEqual([
      [2, 10],
      [10, 15],
    ]);
  });

  it('keeps measures continuous across splitIntersections', () => {
    const crossing = fc([
      line(
        [
          [0, 0],
          [20, 0],
        ],
        {},
        'a',
      ),
      line(
        [
          [10, -10],
          [10, 10],
        ],
        {},
        'b',
      ),
    ]);
    const f = new LineFinder(crossing, { metric: 'euclidean', splitIntersections: true });
    const r = f.route(
      [
        [1, 0],
        [19, 0],
      ],
      { sectionsDetail: 'measure' },
    );
    expect(r.ok && r.legs[0].sections.map((s) => [s.id, s.fromMeasure, s.toMeasure])).toEqual([['a', 1, 19]]);
  });

  it('splits at part changes and ring seams in measure detail only', () => {
    const multi = fc([
      {
        type: 'Feature' as const,
        id: 'multi',
        properties: {},
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [0, 0],
              [10, 0],
            ],
            [
              [10, 0],
              [20, 0],
            ],
          ],
        },
      },
    ]);
    const f = new LineFinder(multi, { metric: 'euclidean' });
    const points: Position[] = [
      [5, 0],
      [15, 0],
    ];
    const byFeature = f.route(points);
    expect(byFeature.ok && byFeature.legs[0].sections).toHaveLength(1);
    const byMeasure = f.route(points, { sectionsDetail: 'measure' });
    expect(
      byMeasure.ok && byMeasure.legs[0].sections.map((s) => [s.partIndex, s.fromMeasure, s.toMeasure]),
    ).toEqual([
      [0, 5, 10],
      [1, 0, 5],
    ]);

    const ring = new LineFinder(
      fc([
        line(
          [
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
            [0, 0],
          ],
          {},
          'ring',
        ),
      ]),
      { metric: 'euclidean' },
    );
    const seam = ring.route(
      [
        [0, 5],
        [5, 0],
      ],
      { sectionsDetail: 'measure' },
    );
    expect(seam.ok && seam.legs[0].sections.map((s) => [s.fromMeasure, s.toMeasure])).toEqual([
      [35, 40],
      [0, 5],
    ]);
  });

  it('Σ|toMeasure − fromMeasure| equals the distance (measure detail, no merging)', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const rand = mulberry32(700 + seed);
      const network = randomGrid(rand, 8);
      const f = new LineFinder(network, { metric: 'euclidean', weight: gridWeight });
      for (let q = 0; q < 10; q++) {
        const pts: Position[] = [0, 1, 2].map(() => [rand() * 70, rand() * 70]);
        const r = f.route(pts, { sectionsDetail: 'measure', snap: { connectivity: 'nearest' } });
        if (!r.ok) continue;
        for (const leg of r.legs) {
          const measured = sum(leg.sections.map((s) => Math.abs(s.toMeasure - s.fromMeasure)));
          expect(measured).toBeCloseTo(leg.distance, 9);
        }
      }
    }
  });
});
