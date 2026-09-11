import { describe, expect, it } from 'vitest';
import { LineFinder, buildGraph, toLineString, type NetworkCollection, type Position } from '../src';
import { ReferenceGraph, fc, gridWeight, insertVertex, line, mulberry32, randomGrid, sum } from './helpers';

interface LadderProps {
  name: string;
  oneway?: boolean;
}

// Ladder, planar units:
//   D(0,10) ── E(10,10) ── F(20,10)     north
//   │           │           │           west / mid / east
//   A(0,0) ─── B(10,0) ─── C(20,0)      south
const ladder = (southOneway = false): NetworkCollection<LadderProps> =>
  fc<LadderProps>([
    line(
      [
        [0, 0],
        [10, 0],
        [20, 0],
      ],
      { name: 'south', oneway: southOneway },
      'south',
    ),
    line(
      [
        [0, 10],
        [10, 10],
        [20, 10],
      ],
      { name: 'north' },
      'north',
    ),
    line(
      [
        [0, 0],
        [0, 10],
      ],
      { name: 'west' },
      'west',
    ),
    line(
      [
        [10, 0],
        [10, 10],
      ],
      { name: 'mid' },
      'mid',
    ),
    line(
      [
        [20, 0],
        [20, 10],
      ],
      { name: 'east' },
      'east',
    ),
  ]);

const onewayWeight = (_a: Position, _b: Position, p: { oneway?: boolean }, ctx: { distance: number }) =>
  p.oneway ? { forward: ctx.distance } : ctx.distance;

describe('two-point routes', () => {
  const finder = new LineFinder(ladder(), { metric: 'euclidean' });

  it('joins two waypoints that snap inside different chains', () => {
    const r = finder.route([
      [5, 1],
      [15, 9],
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.weight).toBeCloseTo(20, 12);
    expect(r.distance).toBeCloseTo(20, 12);
    expect(r.path).toEqual([
      [5, 0],
      [10, 0],
      [10, 10],
      [15, 10],
    ]);
    expect(r.waypoints.map((w) => w.location)).toEqual([
      [5, 0],
      [15, 10],
    ]);
  });

  it('travels directly along a shared chain in either direction', () => {
    const forward = finder.findPath([2, 0], [8, 0]);
    const backward = finder.findPath([8, 0], [2, 0]);
    expect(forward.ok && forward.path).toEqual([
      [2, 0],
      [8, 0],
    ]);
    expect(backward.ok && backward.path).toEqual([
      [8, 0],
      [2, 0],
    ]);
    expect(forward.ok && forward.weight).toBeCloseTo(6, 12);
  });

  it('respects one-way restrictions even within a single chain', () => {
    const oneway = new LineFinder(ladder(true), { metric: 'euclidean', weight: onewayWeight });
    const withFlow = oneway.findPath([2, 0], [8, 0]);
    expect(withFlow.ok && withFlow.weight).toBeCloseTo(6, 12);
    const against = oneway.findPath([8, 0], [2, 0]);
    expect(against.ok && against.weight).toBeCloseTo(2 + 10 + 10 + 10 + 2, 12);
    expect(against.ok && against.path).toEqual([
      [8, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
      [2, 0],
    ]);
  });

  it('reports sections per source feature', () => {
    const r = finder.route([
      [0, 0],
      [20, 5],
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.weight).toBeCloseTo(25, 12);
    expect(r.legs[0].sections.map((s) => [s.id, s.start, s.end, s.distance])).toEqual([
      ['south', 0, 2, 20],
      ['east', 2, 3, 5],
    ]);
    expect(r.legs[0].sections[1].properties).toEqual({ name: 'east' });
  });

  it('preserves and interpolates z values', () => {
    const r = new LineFinder(
      fc([
        line([
          [0, 0, 5],
          [10, 0, 15],
        ]),
      ]),
      { metric: 'euclidean' },
    ).findPath([2, 0], [8, 0]);
    expect(r.ok && r.path).toEqual([
      [2, 0, 7],
      [8, 0, 13],
    ]);
  });
});

describe('multi-waypoint routes', () => {
  const finder = new LineFinder(ladder(), { metric: 'euclidean' });

  it('chains legs in order and concatenates geometry without duplicates', () => {
    const r = finder.route([
      [0, 0],
      [20, 0],
      [20, 10],
      [0, 10],
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.legs.map((l) => [l.from, l.to, l.weight])).toEqual([
      [0, 1, 20],
      [1, 2, 10],
      [2, 3, 20],
    ]);
    expect(r.weight).toBeCloseTo(50, 12);
    expect(r.distance).toBeCloseTo(sum(r.legs.map((l) => l.distance)), 12);
    expect(r.path).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
      [20, 10],
      [10, 10],
      [0, 10],
    ]);
  });

  it('allows repeated waypoints (zero-length legs)', () => {
    const r = finder.route([
      [0, 0],
      [0, 0],
      [10, 0],
    ]);
    expect(r.ok && r.legs.map((l) => l.weight)).toEqual([0, 10]);
    expect(r.ok && r.path).toEqual([
      [0, 0],
      [10, 0],
    ]);
  });

  it('names the failing leg', () => {
    const island = fc([
      ...ladder().features,
      line(
        [
          [100, 100],
          [110, 100],
        ],
        { name: 'island' },
      ),
    ]);
    const f = new LineFinder(island, { metric: 'euclidean' });
    expect(
      f.route(
        [
          [0, 0],
          [10, 0],
          [105, 100],
        ],
        { snap: { connectivity: 'nearest' } },
      ),
    ).toMatchObject({
      ok: false,
      reason: 'UNREACHABLE',
      legIndex: 1,
    });
    // Default connectivity pulls the last waypoint onto the main network instead.
    const rescued = f.route([
      [0, 0],
      [10, 0],
      [105, 100],
    ]);
    expect(rescued.ok && rescued.waypoints[2].location).toEqual([20, 10]);
  });

  it('can add straight connectors from the raw inputs', () => {
    const plain = finder.route([
      [5, 3],
      [15, 7],
    ]);
    const joined = finder.route(
      [
        [5, 3],
        [15, 7],
      ],
      { connectors: true },
    );
    expect(plain.ok && joined.ok).toBe(true);
    if (!plain.ok || !joined.ok) return;
    expect(joined.path).toEqual([[5, 3], ...plain.path, [15, 7]]);
    expect(joined.weight).toBe(plain.weight);
  });
});

describe('API surface', () => {
  const finder = new LineFinder(ladder(), { metric: 'euclidean' });

  it('validates waypoints', () => {
    expect(finder.route([[0, 0]])).toMatchObject({ ok: false, reason: 'INVALID_INPUT' });
    expect(finder.route([[0, 0], 'x' as never])).toMatchObject({
      ok: false,
      reason: 'INVALID_INPUT',
      waypointIndex: 1,
    });
    const features = finder.route([
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
      { type: 'Point', coordinates: [20, 0] },
    ]);
    expect(features.ok && features.weight).toBe(20);
  });

  it('converts results to GeoJSON', () => {
    const r = finder.route([
      [0, 0],
      [20, 0],
    ]);
    expect(toLineString(r)).toMatchObject({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [10, 0],
          [20, 0],
        ],
      },
      properties: { weight: 20, distance: 20, algorithm: 'astar', legs: [{ weight: 20, distance: 20 }] },
    });
    expect(
      toLineString(
        finder.route([
          [0, 0],
          [0, 0],
        ]),
      )?.geometry.coordinates,
    ).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(toLineString(finder.route([[0, 0]]))).toBeNull();
  });

  it('shares one immutable graph between finders', () => {
    const graph = buildGraph(ladder(), { metric: 'euclidean' });
    const edgesBefore = graph.edges.targets.slice();
    const a = new LineFinder(graph, { algorithm: 'dijkstra' });
    const b = new LineFinder(graph);
    const ra = a.route([
      [5, 1],
      [15, 9],
      [1, 1],
    ]);
    const rb = b.route([
      [5, 1],
      [15, 9],
      [1, 1],
    ]);
    expect(ra.ok && rb.ok && ra.weight === rb.weight).toBe(true);
    expect(graph.edges.targets).toEqual(edgesBefore);
  });
});

describe('edge-snapped routes agree with a reference on a densified network', () => {
  for (let seed = 1; seed <= 8; seed++) {
    it(`random grid #${seed}`, () => {
      const rand = mulberry32(1000 + seed);
      const network = randomGrid(rand, 8, { blocked: 0.02 });
      const finder = new LineFinder(network, { metric: 'euclidean', weight: gridWeight });
      for (let q = 0; q < 15; q++) {
        const inputs: Position[] = [0, 1, 2].map(() => [rand() * 70, rand() * 70]);
        const r = finder.route(inputs, { algorithm: q % 2 ? 'astar' : 'dijkstra' });
        if (!r.ok) {
          expect(['UNREACHABLE', 'DISCONNECTED']).toContain(r.reason);
          continue;
        }
        let dense = network;
        for (const w of r.waypoints) dense = insertVertex(dense, w.location);
        const ref = new ReferenceGraph(dense, gridWeight);
        r.legs.forEach((leg) => {
          const expected = ref.shortest(r.waypoints[leg.from].location, r.waypoints[leg.to].location);
          expect(leg.weight).toBeCloseTo(expected, 6);
          expect(sum(leg.sections.map((s) => s.weight))).toBeCloseTo(leg.weight, 6);
        });
      }
    });
  }
});
