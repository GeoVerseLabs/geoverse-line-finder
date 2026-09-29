import { describe, expect, it } from 'vitest';
import {
  LineFinder,
  RoutingGraph,
  bidirectionalDijkstra,
  buildGraph,
  type ConnectorDirection,
  type GraphOptions,
  type NetworkCollection,
  type NetworkFeature,
  type PointConnectorFunction,
  type Position,
  type RouteOptions,
  type VerticalConnector,
} from '../src';
import { fc, line, mulberry32 } from './helpers';

interface Props {
  kind: 'corridor' | 'elevator' | 'escalator' | 'kiosk';
  floor?: number;
  /** Lifts: the floors served, as an OSM `level=1;2;3` tag would give them. */
  level?: string;
  board?: number;
  perLevel?: number;
  direction?: ConnectorDirection;
  factor?: number;
}

const point = <T extends Props>(coordinates: Position, properties: T, id?: string): NetworkFeature<T> => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates },
  properties,
});

const parseLevels = (tag: string) => tag.split(';').map(Number);

const pointConnector: PointConnectorFunction<Props> = (p) =>
  p.kind === 'elevator' || p.kind === 'escalator'
    ? { groups: parseLevels(p.level!), boardCost: p.board, perLevelCost: p.perLevel, direction: p.direction }
    : null;

/** The same lifts, declared by their stops instead of mapped as points. */
function declared(network: NetworkCollection<Props>): VerticalConnector<Props>[] {
  return network.features
    .filter((f) => f.geometry?.type === 'Point' && pointConnector(f.properties!, 0, f))
    .map((f) => {
      const p = f.properties!;
      const position = (f.geometry as { coordinates: Position }).coordinates;
      return {
        id: f.id,
        stops: parseLevels(p.level!).map((group) => ({ group, position })),
        boardCost: p.board,
        perLevelCost: p.perLevel,
        direction: p.direction,
        properties: p,
      };
    });
}

/**
 * Floors of a corridor grid (junctions share coordinates), lifts at random lattice points serving a random
 * run of floors with random costs, the odd up-only escalator core, and kiosks that are just points.
 */
function building(seed: number, floors = 5, size = 4, spacing = 10): NetworkCollection<Props> {
  const rand = mulberry32(seed);
  const at = (i: number, j: number): Position => [i * spacing, j * spacing];
  const features: NetworkFeature<Props>[] = [];
  for (let f = 1; f <= floors; f++) {
    for (let j = 0; j < size; j++) {
      const row = Array.from({ length: size }, (_, i) => at(i, j));
      features.push(line(row, { kind: 'corridor', floor: f, factor: 0.5 + rand() * 2 }, `h${j}F${f}`));
    }
    for (let i = 0; i < size; i++) {
      const column = Array.from({ length: size }, (_, j) => at(i, j));
      features.push(line(column, { kind: 'corridor', floor: f, factor: 0.5 + rand() * 2 }, `v${i}F${f}`));
    }
    features.push(point(at(Math.floor(rand() * size), Math.floor(rand() * size)), { kind: 'kiosk' }));
  }
  for (let e = 0; e < 3; e++) {
    const lo = 1 + Math.floor(rand() * (floors - 1));
    const hi = lo + 1 + Math.floor(rand() * (floors - lo));
    const served = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k).join(';');
    features.push(
      point(
        at(Math.floor(rand() * size), Math.floor(rand() * size)),
        {
          kind: e === 2 ? 'escalator' : 'elevator',
          level: served,
          board: 2 + rand() * 20,
          perLevel: rand() * 4,
          direction: e === 2 ? 'up' : 'both',
        },
        `L${e}`,
      ),
    );
  }
  return fc(features);
}

const options: GraphOptions<Props> = {
  metric: 'euclidean',
  group: (p) => p.floor,
  levels: (g) => (typeof g === 'number' ? { ordinal: g, elevation: 4 * g } : undefined),
  weight: (_a, _b, p, ctx) => ctx.distance * (p.factor ?? 1),
};

const strict: RouteOptions = { snap: { connectivity: 'nearest' } };

describe('pointConnector', () => {
  it('builds the same graph as the equivalent verticalConnectors, without synthesising features', () => {
    for (const seed of [1, 2, 3, 4]) {
      const network = building(seed);
      const byPoint = buildGraph(network, { ...options, pointConnector, diagnostics: true });
      const byStops = buildGraph(network, {
        ...options,
        verticalConnectors: declared(network),
        diagnostics: true,
      });

      expect(byPoint.stats.pointConnectors).toBe(3);
      expect(byPoint.stats.verticalConnectors).toBe(0);
      expect(byStops.stats.verticalConnectors).toBe(3);
      expect(byPoint.features).toBe(network.features);
      expect(byPoint.syntheticFeatures).toBe(0);
      // Five kiosks stay skipped; the lifts are not.
      expect(byPoint.stats.skippedFeatures).toBe(5);
      expect(byStops.stats.skippedFeatures).toBe(8);
      expect(byPoint.heuristic).toEqual(byStops.heuristic);
      expect(byPoint.heuristic.perLevel).toBeGreaterThan(0);

      // Everything but the source feature of the rides is identical.
      const a = byPoint.toTransferable();
      const b = byStops.toTransferable();
      expect(a.header.layout).toEqual(b.header.layout);
      a.header.layout.forEach(([name], i) => {
        if (name === 'segments.feature') return;
        const same = Buffer.compare(
          new Uint8Array(a.buffers[i] as ArrayBuffer),
          new Uint8Array(b.buffers[i] as ArrayBuffer),
        );
        expect(same, name).toBe(0);
      });
      const liftIndex = (id: string) => network.features.findIndex((f) => f.id === id);
      const feature = new Int32Array(a.buffers[a.header.layout.findIndex(([n]) => n === 'segments.feature')]);
      const ridesByPoint = [...new Set(feature)].filter((f) => f >= network.features.length);
      expect(ridesByPoint).toEqual([]);
      expect(feature).toContain(liftIndex('L0'));
    }
  });

  it('routes like verticalConnectors: A*, Dijkstra and bidirectional Dijkstra agree', () => {
    let changes = 0;
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const network = building(seed, 6);
      const byPoint = new LineFinder(network, { ...options, pointConnector }).registerAlgorithm(
        bidirectionalDijkstra,
      );
      const byStops = new LineFinder(network, { ...options, verticalConnectors: declared(network) });
      const rand = mulberry32(seed * 7);
      for (let q = 0; q < 25; q++) {
        const from = { coordinates: [rand() * 30, rand() * 30], snap: { group: 1 + Math.floor(rand() * 6) } };
        const to = { coordinates: [rand() * 30, rand() * 30], snap: { group: 1 + Math.floor(rand() * 6) } };
        const astar = byPoint.route([from, to], strict);
        const reference = byStops.route([from, to], { ...strict, algorithm: 'dijkstra' });
        expect(astar.ok).toBe(reference.ok);
        if (!astar.ok || !reference.ok) continue;
        expect(astar.weight).toBeCloseTo(reference.weight, 9);
        expect(astar.levelChanges).toBe(reference.levelChanges);
        expect(astar.path).toEqual(reference.path);
        for (const algorithm of ['dijkstra', 'bidijkstra'] as const) {
          const other = byPoint.route([from, to], { ...strict, algorithm });
          expect(other.ok && other.weight).toBeCloseTo(astar.weight, 9);
        }
        changes += astar.levelChanges ?? 0;
      }
    }
    // Not a vacuous pass: plenty of the routes ride a lift.
    expect(changes).toBeGreaterThan(40);
  });

  it('points the ride back at the point feature', () => {
    const network = fc<Props>([
      line(
        [
          [0, 0],
          [10, 0],
        ],
        { kind: 'corridor', floor: 1 },
      ),
      line(
        [
          [0, 0],
          [10, 0],
        ],
        { kind: 'corridor', floor: 3 },
      ),
      point([10, 0], { kind: 'elevator', level: '1;2;3', board: 30, perLevel: 5 }, 'lift-A'),
      point([5, 0], { kind: 'kiosk' }),
    ]);
    const finder = new LineFinder(network, { ...options, pointConnector });
    const r = finder.route([
      { coordinates: [0, 0], snap: { group: 1 } },
      { coordinates: [0, 0], snap: { group: 3 } },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.weight).toBeCloseTo(10 + 30 + 2 * 5 + 10, 9);
    const ride = r.legs[0].sections.filter((s) => s.level === null);
    expect(ride).toHaveLength(1);
    expect(ride[0]).toMatchObject({ featureIndex: 2, id: 'lift-A', properties: { kind: 'elevator' } });
    expect(r.legs[0].transitions).toMatchObject([{ fromLevel: 1, toLevel: 3, levelChange: 2 }]);
    // Floor 2 has no network: its stop is a dead end the diagnostics point at, on the lift feature.
    const ends = finder.graph.diagnostics().connectorEnds!;
    expect(ends.items).toEqual([{ location: [10, 0], featureIndex: 2, featureId: 'lift-A', level: 2 }]);
  });

  it('honours direction, and needs ordinals for it', () => {
    const network = fc<Props>([
      line(
        [
          [0, 0],
          [10, 0],
        ],
        { kind: 'corridor', floor: 1 },
      ),
      line(
        [
          [0, 0],
          [10, 0],
        ],
        { kind: 'corridor', floor: 2 },
      ),
      point([10, 0], { kind: 'escalator', level: '1;2', board: 3, direction: 'up' }),
    ]);
    const finder = new LineFinder(network, { ...options, pointConnector });
    const up = finder.route(
      [
        { coordinates: [0, 0], snap: { group: 1 } },
        { coordinates: [0, 0], snap: { group: 2 } },
      ],
      strict,
    );
    const down = finder.route(
      [
        { coordinates: [0, 0], snap: { group: 2 } },
        { coordinates: [0, 0], snap: { group: 1 } },
      ],
      strict,
    );
    expect(up.ok).toBe(true);
    expect(down.ok).toBe(false);
    expect(() => buildGraph(network, { ...options, levels: undefined, pointConnector })).toThrow(RangeError);
  });

  /**
   * OSM style: the footways of each level end at the lift node, which has an id; their coordinates are
   * 30 cm off the lift point (digitised separately), so only the id connects them.
   */
  describe('with node ids', () => {
    type OsmProps = Props & { nodes?: (string | null)[]; node?: string };
    const osm = (): NetworkCollection<OsmProps> =>
      fc<OsmProps>([
        ...[0, 1, 2].map((level) =>
          line<OsmProps>(
            [
              [0, 0],
              [9.7, 0],
            ],
            { kind: 'corridor', floor: level, nodes: [`w${level}`, 'lift'] },
          ),
        ),
        point<OsmProps>([10, 0], { kind: 'elevator', level: '0;1;2', board: 10, node: 'lift' }, 'lift'),
      ]);
    const osmOptions: GraphOptions<OsmProps> = {
      ...(options as GraphOptions<OsmProps>),
      pointConnector: pointConnector as PointConnectorFunction<OsmProps>,
      diagnostics: true,
    };
    const trip = [
      { coordinates: [0, 0], snap: { group: 0 } },
      { coordinates: [0, 0], snap: { group: 2 } },
    ];

    it('joins every level at the lift node', () => {
      const finder = new LineFinder(osm(), {
        ...osmOptions,
        nodeId: (p, { index }) => (p.node !== undefined ? p.node : p.nodes?.[index]),
      });
      expect(finder.graph.diagnostics().connectorEnds!.total).toBe(0);
      expect(finder.graph.stats.nodeIds).toBe(6); // w0..w2 and the lift node on each level
      const r = finder.route(trip, strict);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.weight).toBeCloseTo(9.7 + 10 + 9.7, 9);
    });

    it('without ids, the stops are left hanging and the diagnostics say so', () => {
      const finder = new LineFinder(osm(), osmOptions);
      expect(finder.graph.diagnostics().connectorEnds!.total).toBe(3);
      expect(finder.route(trip, strict).ok).toBe(false);
    });

    it('declared stops can name the node too', () => {
      const network = osm();
      const finder = new LineFinder(fc(network.features.slice(0, 3)), {
        ...(options as GraphOptions<OsmProps>),
        nodeId: (p, { index }) => p.nodes?.[index],
        verticalConnectors: [
          { stops: [0, 1, 2].map((group) => ({ group, position: [10, 0], nodeId: 'lift' })), boardCost: 10 },
        ],
      });
      const r = finder.route(trip, strict);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.weight).toBeCloseTo(9.7 + 10 + 9.7, 9);
    });
  });

  it('serialises: the points stay input features', () => {
    const network = building(21);
    const graph = buildGraph(network, { ...options, pointConnector });
    const data = graph.toTransferable();
    expect(data.formatVersion).toBe(2);
    expect(data.header.synthetic).toBeNull();
    const copy = RoutingGraph.fromTransferable<Props>(data, { features: network.features });
    expect(copy.stats).toEqual(graph.stats);
    const trip = [
      { coordinates: [0, 0], snap: { group: 1 } },
      { coordinates: [30, 30], snap: { group: 5 } },
    ];
    expect(new LineFinder(copy).route(trip)).toEqual(new LineFinder(graph).route(trip));
  });

  it('validates what it is given', () => {
    const network = fc<Props>([
      line(
        [
          [0, 0],
          [1, 0],
        ],
        { kind: 'corridor', floor: 1 },
      ),
      point([0, 0], { kind: 'elevator', level: '1;2' }),
    ]);
    const build = (fn: unknown) => () => buildGraph(network, { ...options, pointConnector: fn as never });
    expect(build('lift')).toThrow(TypeError);
    expect(build(() => 3)).toThrow(TypeError);
    expect(build(() => ({ groups: 1 }))).toThrow(TypeError);
    expect(build(() => ({ groups: [1] }))).toThrow(RangeError);
    expect(build(() => ({ groups: [1, {}] }))).toThrow(TypeError);
    expect(build(() => ({ groups: [1, 2], boardCost: -1 }))).toThrow(RangeError);
    expect(build(() => ({ groups: [1, 2], direction: 'sideways' }))).toThrow(RangeError);
    const broken = fc<Props>([
      {
        ...point([0, 0], { kind: 'elevator', level: '1;2' }),
        geometry: { type: 'Point', coordinates: [NaN, 0] },
      },
    ]);
    expect(() => buildGraph(broken, { ...options, pointConnector })).toThrow(TypeError);
    // Declared stops are checked the same way now.
    expect(() =>
      buildGraph(network, {
        ...options,
        verticalConnectors: [
          {
            stops: [
              { group: 1, position: [NaN, 0] },
              { group: 2, position: [0, 0] },
            ],
          },
        ],
      }),
    ).toThrow(TypeError);
    expect(() =>
      buildGraph(network, {
        ...options,
        verticalConnectors: [
          {
            stops: [
              { group: 1, position: [0, 0], nodeId: {} as never },
              { group: 2, position: [0, 0] },
            ],
          },
        ],
      }),
    ).toThrow(TypeError);
    // Returning null leaves the point out, as before.
    expect(buildGraph(network, { ...options, pointConnector: () => null }).stats).toMatchObject({
      pointConnectors: 0,
      skippedFeatures: 1,
    });
  });
});
