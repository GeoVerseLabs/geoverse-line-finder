import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { osmWeight, type OsmProps } from '../bench/osm-weight';
import {
  LineFinder,
  RoutingGraph,
  buildGraph,
  type GraphOptions,
  type NetworkCollection,
  type NetworkFeature,
  type NodeIdContext,
  type NodeIdFunction,
  type Position,
} from '../src';
import { findGpfData, gpfFixture } from './data';
import { randomBuilding, type BuildingProps } from './fixtures/building';
import { fc, gridWeight, line, mulberry32, randomGrid, type GridProps } from './helpers';

/** Every table and index of two graphs, byte for byte, and their stats apart from `nodeIds`. */
function expectSameGraph(a: RoutingGraph<unknown>, b: RoutingGraph<unknown>): void {
  const da = a.toTransferable();
  const db = b.toTransferable();
  const { nodeIds: _a, ...sa } = da.header.stats;
  const { nodeIds: _b, ...sb } = db.header.stats;
  expect(sb).toEqual(sa);
  expect(db.header.layout).toEqual(da.header.layout);
  expect(db.header.heuristic).toEqual(da.header.heuristic);
  expect(db.header.groupKeys).toEqual(da.header.groupKeys);
  da.header.layout.forEach(([name], i) => {
    const x = new Uint8Array(da.buffers[i] as ArrayBuffer);
    const y = new Uint8Array(db.buffers[i] as ArrayBuffer);
    expect(Buffer.compare(x, y), name).toBe(0);
  });
  expect(b.diagnostics()).toEqual(a.diagnostics());
}

/** Connectivity checks must not let snapping move a waypoint into another component. */
const strict = { snap: { connectivity: 'nearest' } } as const;

/** Ids that say nothing the coordinates do not already say. */
const coordinateId: NodeIdFunction<unknown> = (_p, { position }) => `${position[0]},${position[1]}`;

/** The same ids, but only on the features `keep` selects (the others fall back to coordinates). */
function someIds(keep: (featureIndex: number) => boolean): NodeIdFunction<unknown> {
  return (p, ctx) => (keep(ctx.featureIndex) ? coordinateId(p, ctx) : undefined);
}

describe('nodeId: ids that agree with the coordinates change nothing', () => {
  const cases: [string, () => NetworkCollection<unknown>, GraphOptions<unknown>][] = [
    ['gpf network', () => gpfFixture('network.json'), {}],
    ['gpf network, diagnostics', () => gpfFixture('network.json'), { diagnostics: true }],
    ['random grid', () => randomGrid(mulberry32(3), 10, { blocked: 0.05 }), { metric: 'euclidean' }],
    [
      'random grid with repairs',
      () => randomGrid(mulberry32(4), 10, { blocked: 0.05 }),
      { metric: 'euclidean', snapDangles: 2, splitIntersections: true, diagnostics: true },
    ],
  ];
  for (const [name, network, options] of cases) {
    it(`${name}: every coordinate keyed, and half of the features keyed`, () => {
      const plain = buildGraph(network(), options);
      expectSameGraph(plain, buildGraph(network(), { ...options, nodeId: coordinateId }));
      const rand = mulberry32(name.length);
      const picked = network().features.map(() => rand() < 0.5);
      const mixed = buildGraph(network(), { ...options, nodeId: someIds((fi) => picked[fi]) });
      expectSameGraph(plain, mixed);
      expect(mixed.stats.nodeIds).toBeGreaterThan(0);
      expect(mixed.stats.nodeIds).toBeLessThan(mixed.store.size);
    });
  }

  it('multi-level buildings: ids are scoped by group like coordinates, connector interiors keep none', () => {
    for (const seed of [1, 2, 3]) {
      const b = randomBuilding(mulberry32(seed), { floors: 4, express: true, stairs: 2, elevation: true });
      const options = { ...b.graphOptions, diagnostics: true } as GraphOptions<unknown>;
      const plain = buildGraph(b.network, options);
      const seen: NodeIdContext<unknown>[] = [];
      const keyed = buildGraph(b.network, {
        ...options,
        nodeId: (p, ctx) => {
          seen.push(ctx);
          return coordinateId(p, ctx);
        },
      });
      expectSameGraph(plain, keyed);
      // The landing in the middle of every staircase is never offered to nodeId.
      const stairs = b.network.features.filter((f) => (f.properties as BuildingProps).kind === 'stairs');
      expect(stairs.length).toBeGreaterThan(0);
      for (const f of stairs) {
        const fi = b.network.features.indexOf(f);
        expect(seen.filter((c) => c.featureIndex === fi).map((c) => c.index)).toEqual([0, 2]);
      }
    }
  });

  const LARGE = findGpfData('large-network.json');
  it.skipIf(!LARGE)('large OSM network (13.5 × 10⁴ coordinates)', () => {
    const network = JSON.parse(readFileSync(LARGE!, 'utf8')) as NetworkCollection<OsmProps>;
    const options: GraphOptions<OsmProps> = { weight: (a, b, p) => osmWeight(a, b, p) };
    const plain = buildGraph(network, options) as RoutingGraph<unknown>;
    const keyed = buildGraph(network, { ...options, nodeId: someIds((fi) => fi % 3 !== 0) });
    expectSameGraph(plain, keyed as RoutingGraph<unknown>);
  });
});

describe('nodeId: ids decide where coordinates cannot', () => {
  /**
   * The same grid twice: exact shared junctions, and every feature's coordinates jittered independently so
   * that no two features share a coordinate any more. Ids naming the original junctions restore it.
   */
  it('reconnects junctions whose coordinates disagree slightly', () => {
    const network = randomGrid(mulberry32(21), 9, { blocked: 0 });
    const rand = mulberry32(22);
    const jitter = (c: Position): Position => [c[0] + (rand() - 0.5) * 1e-3, c[1] + (rand() - 0.5) * 1e-3];
    const jittered = fc(
      network.features.map((f) => ({
        ...f,
        geometry: {
          type: 'LineString',
          coordinates: (f.geometry as { coordinates: Position[] }).coordinates.map(jitter),
        },
      })) as NetworkFeature<GridProps>[],
    );
    const original = (fi: number, index: number) =>
      (network.features[fi].geometry as { coordinates: Position[] }).coordinates[index];
    const nodeId: NodeIdFunction<GridProps> = (_p, { featureIndex, index }) =>
      original(featureIndex, index).join(',');

    const options: GraphOptions<GridProps> = { metric: 'euclidean', weight: gridWeight, diagnostics: true };
    const truth = new LineFinder(network, options);
    const broken = new LineFinder(jittered, options);
    const fixed = new LineFinder(jittered, { ...options, nodeId });

    // Coordinates alone fall apart into one component per feature…
    expect(broken.graph.stats.components).toBe(jittered.features.length);
    // … the ids give back the original topology.
    for (const key of ['vertices', 'nodes', 'chains', 'edges', 'components', 'mergedVertices'] as const) {
      expect(fixed.graph.stats[key], key).toBe(truth.graph.stats[key]);
    }
    // Every id merge bridged a gap, and the diagnostics say how wide.
    const repairs = fixed.graph.diagnostics().repairs!;
    expect(repairs.total).toBe(fixed.graph.stats.mergedVertices);
    expect(repairs.items.every((r) => r.kind === 'merge' && r.gap > 0 && r.gap < 2e-3)).toBe(true);

    const q = mulberry32(23);
    let routed = 0;
    for (let i = 0; i < 40; i++) {
      const a: Position = [q() * 80, q() * 80];
      const b: Position = [q() * 80, q() * 80];
      const r1 = truth.route([a, b], strict);
      const r2 = fixed.route([a, b], strict);
      expect(r2.ok).toBe(r1.ok);
      if (r1.ok && r2.ok) {
        routed++;
        // Only the jitter separates the two: at most 1e-3 per coordinate on paths of a few dozen vertices.
        expect(Math.abs(r2.weight - r1.weight)).toBeLessThan(0.2);
      }
    }
    expect(routed).toBeGreaterThan(30);
  });

  /** An overpass: both ways have a node at the crossing, but not the same node. */
  const overpass = () =>
    fc([
      line(
        [
          [0, 5],
          [5, 5],
          [10, 5],
        ],
        { ids: ['a1', 'a2', 'a3'] },
        'road',
      ),
      line(
        [
          [5, 0],
          [5, 5],
          [5, 10],
        ],
        { ids: ['b1', 'b2', 'b3'] },
        'bridge',
      ),
    ]);
  const byIds: NodeIdFunction<{ ids?: string[] }> = (p, { index }) => p.ids?.[index];

  it('keeps two ids at one position apart (a bridge over a road)', () => {
    const inferred = new LineFinder(overpass(), { metric: 'euclidean' });
    expect(inferred.graph.stats.components).toBe(1);
    const explicit = new LineFinder(overpass(), { metric: 'euclidean', nodeId: byIds });
    expect(explicit.graph.stats.components).toBe(2);
    expect(explicit.graph.stats.nodeIds).toBe(6);
    const r = explicit.route(
      [
        [0, 5],
        [5, 10],
      ],
      strict,
    );
    expect(r.ok).toBe(false);
  });

  it('lets coordinates without ids join the first vertex at their position, in any order', () => {
    const ramp = line(
      [
        [5, 5],
        [8, 8],
      ],
      {},
      'ramp',
    );
    for (const features of [
      [...overpass().features, ramp],
      [ramp, ...overpass().features],
    ]) {
      const finder = new LineFinder(fc(features), { metric: 'euclidean', nodeId: byIds });
      expect(finder.graph.stats.components).toBe(2);
      // The ramp meets whichever way owns [5, 5]: the road when the road comes first, and when the ramp
      // comes first the road's node takes over the ramp's vertex, so it is the road again.
      const road = finder.route(
        [
          [0, 5],
          [8, 8],
        ],
        strict,
      );
      expect(road.ok).toBe(true);
      const bridge = finder.route(
        [
          [5, 0],
          [8, 8],
        ],
        strict,
      );
      expect(bridge.ok).toBe(false);
    }
  });

  it('keeps the first position of an id and logs the gap it bridges', () => {
    const network = fc([
      line(
        [
          [0, 0],
          [10, 0],
        ],
        { u: 'A', v: 'B' },
      ),
      line(
        [
          [10, 3],
          [20, 0],
        ],
        { u: 'B', v: 'C' },
      ),
    ]);
    const endpoints: NodeIdFunction<{ u: string; v: string }> = (p, { index, last }) =>
      index === 0 ? p.u : last ? p.v : undefined;
    const finder = new LineFinder(network, { metric: 'euclidean', nodeId: endpoints, diagnostics: true });
    expect(finder.graph.stats).toMatchObject({ components: 1, nodeIds: 3, mergedVertices: 1 });
    const repairs = finder.graph.diagnostics().repairs!;
    expect(repairs.items).toEqual([{ kind: 'merge', location: [10, 3], featureIndices: [1, 0], gap: 3 }]);
    const r = finder.route([
      [0, 0],
      [20, 0],
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The vertex stays where the id was first seen.
    expect(r.path).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
    expect(r.weight).toBeCloseTo(20, 9);
  });

  it('within tolerance, a new id takes over a vertex without one but never one with another id', () => {
    const network = fc([
      line(
        [
          [0, 0],
          [10, 0],
        ],
        { ids: [null, null] },
      ),
      line(
        [
          [10.3, 0],
          [20, 0],
        ],
        { ids: ['X', null] },
      ),
      line(
        [
          [10.2, 0.1],
          [10, 10],
        ],
        { ids: ['Y', null] },
      ),
    ]);
    const nodeId: NodeIdFunction<{ ids: (string | null)[] }> = (p, { index }) => p.ids[index];
    const finder = new LineFinder(network, { metric: 'euclidean', tolerance: 0.5, nodeId });
    // X takes over the unkeyed end at [10, 0]; Y is within tolerance of it too, but that vertex has an id now.
    expect(finder.graph.stats.components).toBe(2);
    expect(
      finder.route(
        [
          [0, 0],
          [20, 0],
        ],
        strict,
      ).ok,
    ).toBe(true);
    expect(
      finder.route(
        [
          [0, 0],
          [10, 10],
        ],
        strict,
      ).ok,
    ).toBe(false);
    // Without ids the three ends merge by tolerance.
    expect(new LineFinder(network, { metric: 'euclidean', tolerance: 0.5 }).graph.stats.components).toBe(1);
  });

  it('scopes ids by group: one node id on two floors is two vertices', () => {
    type P = { floor?: number; from?: number; to?: number };
    const network = fc<P>([
      line(
        [
          [0, 0],
          [5, 0],
        ],
        { floor: 1 },
      ),
      line(
        [
          [0, 0],
          [5, 0],
        ],
        { floor: 2 },
      ),
      // A zero-length lift between the two floors at the corridors' end node.
      line(
        [
          [5, 0],
          [5, 0],
        ],
        { from: 1, to: 2 },
      ),
    ]);
    const nodeId: NodeIdFunction<P> = (_p, { index, last }) => (index === 0 ? 'start' : last ? 'lift' : null);
    const group = (p: P) => (p.floor ?? [p.from!, p.to!]) as number | [number, number];
    const withLift = new LineFinder(network, { metric: 'euclidean', group, nodeId, zeroWeight: 'free' });
    expect(withLift.graph.stats.nodeIds).toBe(4); // start and lift, on each floor
    expect(withLift.graph.stats.components).toBe(1);
    const noLift = new LineFinder(fc(network.features.slice(0, 2)), { metric: 'euclidean', group, nodeId });
    expect(noLift.graph.stats.components).toBe(2);
  });

  it('passes the position of every coordinate, part by part', () => {
    const seen: [number, number, boolean, Position][] = [];
    buildGraph(
      fc([
        {
          type: 'Feature',
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [2, 0],
              ],
              [
                [5, 5],
                [6, 6],
              ],
            ],
          },
          properties: {},
        },
      ]),
      {
        metric: 'euclidean',
        nodeId: (_p, { part, index, last, position }) => {
          seen.push([part, index, last, position]);
          return undefined;
        },
      },
    );
    expect(seen).toEqual([
      [0, 0, false, [0, 0]],
      [0, 1, false, [1, 0]],
      [0, 2, true, [2, 0]],
      [1, 0, false, [5, 5]],
      [1, 1, true, [6, 6]],
    ]);
  });

  it('serialises: the ids shape the graph, the graph does not keep them', () => {
    const graph = buildGraph(overpass(), { metric: 'euclidean', nodeId: byIds });
    const copy = RoutingGraph.fromTransferable(graph.toTransferable(), { features: overpass().features });
    expect(copy.stats).toEqual(graph.stats);
    expect(copy.findVertex(5, 5)).toBe(graph.findVertex(5, 5));
    expect(
      new LineFinder(copy).route(
        [
          [0, 5],
          [5, 10],
        ],
        strict,
      ).ok,
    ).toBe(false);
  });

  it('validates what it is given', () => {
    const net = overpass();
    expect(() => buildGraph(net, { nodeId: 'ids' as never })).toThrow(TypeError);
    for (const bad of [NaN, Infinity, {}, [1], true]) {
      expect(() => buildGraph(net, { metric: 'euclidean', nodeId: () => bad as never })).toThrow(TypeError);
    }
    // null and undefined mean "no id".
    expect(buildGraph(net, { metric: 'euclidean', nodeId: () => null }).stats.nodeIds).toBe(0);
  });
});
