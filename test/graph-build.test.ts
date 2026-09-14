import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LineFinder, buildGraph, type NetworkCollection } from '../src';
import { fc, line } from './helpers';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/gpf/${name}`, import.meta.url), 'utf8')) as NetworkCollection;

describe('buildGraph', () => {
  const branchy = fc([
    line([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
    ]),
    line([
      [4, 0],
      [4, 1],
      [4, 2],
    ]),
    line([
      [4, 0],
      [5, 0],
      [6, 0],
    ]),
  ]);

  it('compacts degree-2 vertices into chains between junctions', () => {
    const { stats } = buildGraph(branchy, { metric: 'euclidean' });
    expect(stats).toMatchObject({ vertices: 9, segments: 8, nodes: 4, chains: 3, edges: 6, components: 1 });
  });

  it('can keep every vertex as a node (compact: false)', () => {
    const { stats } = buildGraph(branchy, { metric: 'euclidean', compact: false });
    expect(stats).toMatchObject({ nodes: 9, chains: 8, edges: 16 });
  });

  it('keeps pure cycles routable by promoting one vertex', () => {
    const ring = fc([
      line([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ]),
    ]);
    const finder = new LineFinder(ring, { metric: 'euclidean' });
    expect(finder.graph.stats).toMatchObject({ nodes: 1, chains: 1, edges: 0 });
    const direct = finder.route([
      [1, 0],
      [1, 1],
    ]);
    expect(direct.ok && direct.weight).toBeCloseTo(1, 12);
    const aroundCorner = finder.route([
      [0.5, 0],
      [0, 0.5],
    ]);
    expect(aroundCorner.ok && aroundCorner.weight).toBeCloseTo(1, 12);
  });

  it('finds the two islands of the geojson-path-finder fixture', () => {
    expect(buildGraph(fixture('two-islands.json')).stats.components).toBe(2);
  });

  it('skips non-line geometries, reads MultiLineStrings and breaks lines at invalid coordinates', () => {
    const network = fc([
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
        properties: {},
      },
      { type: 'Feature', geometry: null, properties: {} },
      {
        type: 'Feature',
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [0, 0],
              [1, 0],
            ],
            [
              [1, 0],
              [2, 0],
            ],
          ],
        },
        properties: {},
      },
      line([
        [5, 0],
        [6, 0],
        [NaN, 0],
        [7, 0],
        [8, 0],
      ]),
    ]);
    const { stats } = buildGraph(network, { metric: 'euclidean' });
    expect(stats).toMatchObject({
      lineFeatures: 2,
      skippedFeatures: 3,
      invalidCoordinates: 1,
      segments: 4,
      components: 3,
    });
  });

  it('drops impassable segments and counts one-way ones', () => {
    const network = fc([
      line(
        [
          [0, 0],
          [1, 0],
        ],
        { mode: 'open' },
      ),
      line(
        [
          [1, 0],
          [2, 0],
        ],
        { mode: 'oneway' },
      ),
      line(
        [
          [2, 0],
          [3, 0],
        ],
        { mode: 'closed' },
      ),
    ]);
    const { stats } = buildGraph(network, {
      metric: 'euclidean',
      weight: (_a, _b, p: { mode: string }, ctx) =>
        p.mode === 'closed' ? 0 : p.mode === 'oneway' ? { forward: ctx.distance } : ctx.distance,
    });
    // (3,0) dies with the closed segment, so (1,0) is left with degree 2 and is compacted away: one chain
    // (0,0)→(2,0) that is passable forward only.
    expect(stats).toMatchObject({
      segments: 3,
      impassableSegments: 1,
      oneWaySegments: 1,
      nodes: 2,
      edges: 1,
    });
  });

  it('merges near-coincident endpoints with a tolerance (meters)', () => {
    // ≈0.6 m gap between the two lines at 52° N.
    const network = fc([
      line([
        [13.0, 52.0],
        [13.001, 52.0],
      ]),
      line([
        [13.0010000089, 52.0],
        [13.002, 52.0],
      ]),
    ]);
    expect(buildGraph(network).stats.components).toBe(2);
    const merged = new LineFinder(network, { tolerance: 1 });
    expect(merged.graph.stats.components).toBe(1);
    expect(
      merged.route([
        [13.0, 52.0],
        [13.002, 52.0],
      ]).ok,
    ).toBe(true);
  });

  it('connects dead ends to nearby segments (snapDangles)', () => {
    const network = fc([
      line([
        [0, 0],
        [20, 0],
      ]),
      line([
        [10, 0.5],
        [10, 10],
      ]),
    ]);
    expect(buildGraph(network, { metric: 'euclidean' }).stats.components).toBe(2);
    expect(buildGraph(network, { metric: 'euclidean', snapDangles: 0.3 }).stats.components).toBe(2);
    const finder = new LineFinder(network, { metric: 'euclidean', snapDangles: 1 });
    expect(finder.graph.stats).toMatchObject({ danglesSnapped: 1, components: 1 });
    const route = finder.route(
      [
        [0, 0],
        [10, 10],
      ],
      { snap: { mode: 'exact' } },
    );
    expect(route.ok && route.weight).toBeCloseTo(20, 9);
    expect(route.ok && route.path).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  it('counts a dead end that already touches the segment (zero gap) as snapped', () => {
    const tee = (gap: number) =>
      fc([
        line([
          [0, 0],
          [20, 0],
        ]),
        line([
          [10, gap],
          [10, 10],
        ]),
      ]);
    for (const gap of [0, 0.3]) {
      expect(buildGraph(tee(gap), { metric: 'euclidean' }).stats.components).toBe(2);
      expect(buildGraph(tee(gap), { metric: 'euclidean', snapDangles: 0.5 }).stats).toMatchObject({
        components: 1,
        danglesSnapped: 1,
      });
    }
  });

  it('nodes crossings and exact touches (splitIntersections)', () => {
    // An X at (5,5) and a T where line 3 starts on line 1 at (2,2). (Line 3 stops at y = 6 so it does not
    // also touch line 2, x + y = 10.)
    const network = fc([
      line([
        [0, 0],
        [10, 10],
      ]),
      line([
        [0, 10],
        [10, 0],
      ]),
      line([
        [2, 2],
        [2, 6],
      ]),
    ]);
    expect(buildGraph(network, { metric: 'euclidean' }).stats.components).toBe(3);
    const finder = new LineFinder(network, { metric: 'euclidean', splitIntersections: true });
    expect(finder.graph.stats).toMatchObject({ intersectionsSplit: 2, components: 1 });
    const across = finder.route(
      [
        [0, 0],
        [0, 10],
      ],
      { snap: { mode: 'exact' } },
    );
    expect(across.ok && across.weight).toBeCloseTo(2 * Math.sqrt(50), 9);
    const tee = finder.route(
      [
        [2, 6],
        [0, 0],
      ],
      { snap: { mode: 'exact' } },
    );
    expect(tee.ok && tee.weight).toBeCloseTo(4 + 2 * Math.SQRT2, 9);
  });

  it('validates input and options', () => {
    expect(() => buildGraph({} as NetworkCollection)).toThrow(TypeError);
    expect(() => buildGraph(branchy, { tolerance: -1 })).toThrow(RangeError);
    expect(() => buildGraph(branchy, { weight: () => -3 })).toThrow(/feature #0/);
    const empty = buildGraph(fc([]));
    expect(empty.stats).toMatchObject({ nodes: 0, segments: 0, components: 0 });
    const route = new LineFinder(empty).route([
      [0, 0],
      [1, 1],
    ]);
    expect(route.ok || route.reason).toBe('SNAP_FAILED');
  });
});
