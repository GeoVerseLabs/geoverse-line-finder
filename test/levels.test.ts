import { describe, expect, it } from 'vitest';
import {
  LineFinder,
  RoutingGraph,
  bidirectionalDijkstra,
  buildGraph,
  toLevelFeatures,
  type GraphOptions,
  type NetworkCollection,
  type NetworkFeature,
  type Position,
  type RouteResult,
  type VerticalConnector,
} from '../src';
import {
  FLOOR_HEIGHT,
  buildingGroup,
  buildingWeight,
  expensiveCorridorBuilding,
  gridTower,
  randomBuilding,
  type BuildingProps,
} from './fixtures/building';
import { fc, line, mulberry32 } from './helpers';

/** Floors of crossing 20 m corridors, stacked exactly, joined by a lift that stops at every floor. */
function tower(floors: number): NetworkCollection<BuildingProps> {
  const features: NetworkFeature<BuildingProps>[] = [];
  for (let f = 1; f <= floors; f++) {
    features.push(
      line(
        [
          [0, 10],
          [20, 10],
        ],
        { kind: 'corridor', floor: f, factor: 1 },
        `ew-F${f}`,
      ),
      line(
        [
          [10, 0],
          [10, 20],
        ],
        { kind: 'corridor', floor: f, factor: 1 },
        `ns-F${f}`,
      ),
    );
  }
  for (let f = 1; f < floors; f++) {
    features.push(
      line(
        [
          [10, 10],
          [10, 10],
        ],
        { kind: 'elevator', from: f, to: f + 1, cost: 4 },
        `E:${f}-${f + 1}`,
      ),
    );
  }
  return fc(features);
}

function towerOptions(elevation = true): GraphOptions<BuildingProps> {
  return {
    metric: 'euclidean',
    splitIntersections: true,
    weight: buildingWeight,
    group: buildingGroup,
    zeroWeight: 'free',
    levels: (g) =>
      typeof g === 'number'
        ? { ordinal: g, elevation: elevation ? (g - 1) * FLOOR_HEIGHT : undefined, name: `F${g}` }
        : undefined,
  };
}

const towerFinder = (floors: number, elevation = true) =>
  new LineFinder(tower(floors), towerOptions(elevation));

describe('level metadata', () => {
  it('is off by default: without `levels` nothing about levels appears in the result', () => {
    const { levels, ...plain } = towerOptions();
    void levels;
    const finder = new LineFinder(tower(3), plain);
    expect(finder.graph.levels).toBeNull();
    expect(finder.graph.heuristic.perLevel).toBe(0);
    const route = finder.route([
      { coordinates: [2, 10], snap: { group: 1 } },
      { coordinates: [10, 18], snap: { group: 3 } },
    ]);
    expect(route.ok).toBe(true);
    if (!route.ok) return;
    expect(route.levelChanges).toBeUndefined();
    expect(route.verticalDistance).toBeUndefined();
    expect(route.legs[0].levels).toBeUndefined();
    expect(route.legs[0].transitions).toBeUndefined();
    expect(route.legs[0].sections.every((s) => s.level === undefined)).toBe(true);
    const diag = finder.graph.diagnostics();
    expect(diag.connectorEnds).toBeNull();
    expect(diag.levelReachability).toBeNull();
    expect(diag.missingOrdinals).toBeNull();
  });

  it('labels every coordinate, section and passage of a route', () => {
    const finder = towerFinder(3);
    const route = finder.route([
      { coordinates: [2, 10], snap: { group: 1 } },
      { coordinates: [10, 18], snap: { group: 3 } },
    ]);
    expect(route.ok).toBe(true);
    if (!route.ok) return;
    expect(route.weight).toBeCloseTo(8 + 4 + 4 + 8, 9);
    expect(route.distance).toBeCloseTo(16, 9);
    const leg = route.legs[0];
    expect(leg.levels).toEqual([1, 1, 2, 3, 3]);
    expect(leg.levels!.length).toBe(leg.path.length);
    expect(leg.sections.map((s) => s.level)).toEqual([1, null, null, 3]);
    // The two floor-by-floor lift hops are one ride: nobody gets out on F2.
    expect(leg.transitions).toHaveLength(1);
    const t = leg.transitions![0];
    expect(t).toMatchObject({ fromLevel: 1, toLevel: 3, levelChange: 2, start: 1, end: 3, distance: 0 });
    expect(t.weight).toBeCloseTo(8, 9);
    expect(t.featureIndices).toHaveLength(2);
    expect(route.levelChanges).toBe(2);
    expect(route.verticalDistance).toBeCloseTo(2 * FLOOR_HEIGHT, 9);
  });

  it('counts a descent as a negative change and keeps `levelChanges` a total', () => {
    const finder = towerFinder(3);
    const route = finder.route([
      { coordinates: [10, 18], snap: { group: 3 } },
      { coordinates: [2, 10], snap: { group: 1 } },
    ]);
    expect(route.ok).toBe(true);
    if (!route.ok) return;
    expect(route.legs[0].transitions![0].levelChange).toBe(-2);
    expect(route.levelChanges).toBe(2);
  });

  it('accepts a record keyed by group and reports the level names', () => {
    const graph = buildGraph(tower(2), {
      ...towerOptions(),
      levels: { 1: { ordinal: 1, elevation: 0, name: 'Ground' }, 2: { ordinal: 2, elevation: 4 } },
    });
    expect(graph.levels).not.toBeNull();
    expect(graph.levels!.name[graph.groupIndex(1)]).toBe('Ground');
    expect(graph.groupOrdinal(graph.groupIndex(2))).toBe(2);
    expect(graph.levels!.hasElevation).toBe(true);
  });

  it('rejects malformed level metadata', () => {
    expect(() => buildGraph(tower(2), { ...towerOptions(), levels: 5 as never })).toThrow(TypeError);
    expect(() => buildGraph(tower(2), { ...towerOptions(), levels: () => ({ ordinal: NaN }) })).toThrow(
      RangeError,
    );
    expect(() =>
      buildGraph(tower(2), { ...towerOptions(), levels: () => ({ ordinal: 1, elevation: Infinity }) }),
    ).toThrow(RangeError);
  });
});

describe('level-aware A* bound', () => {
  it('prices one level from the connectors, not from the chains they were compacted into', () => {
    // A chain runs F2 corridor -> stairs -> the very expensive F1 corridor -> the cheap F1 loop. Per chain
    // the bound would be about 1030 per level, far above the real cost of stepping off the stairs.
    const { network, graphOptions } = expensiveCorridorBuilding();
    const finder = new LineFinder(network, graphOptions);
    expect(finder.graph.stats.nodes).toBeLessThanOrEqual(4); // the whole detour really is one chain
    expect(finder.graph.heuristic.perLevel).toBeGreaterThan(9);
    expect(finder.graph.heuristic.perLevel).toBeLessThan(11);
    const source = { coordinates: [20, 0] as Position, snap: { group: 2 } };
    const target = { coordinates: [5, 0] as Position, snap: { group: 1 } };
    const a = finder.route([source, target]);
    const d = finder.route([source, target], { algorithm: 'dijkstra' });
    expect(a.ok && d.ok).toBe(true);
    if (!a.ok || !d.ok) return;
    expect(a.weight).toBeCloseTo(d.weight, 9);
    expect(a.weight).toBeCloseTo(10 + 10 + 500, 9);
  });

  it('is switched off by a free connector, which makes a level crossing cost nothing', () => {
    const rand = mulberry32(7);
    const b = randomBuilding(rand, { floors: 4, size: 4, freeElevator: true });
    expect(buildGraph(b.network, b.graphOptions).heuristic.perLevel).toBe(0);
  });

  it('is switched off by a level without an ordinal, and says which one', () => {
    const rand = mulberry32(11);
    const b = randomBuilding(rand, { floors: 4, size: 4, outdoor: true });
    const graph = buildGraph(b.network, b.graphOptions);
    // Going up through the outdoor area would look free, so the bound has to go.
    expect(graph.heuristic.perLevel).toBe(0);
    expect(graph.diagnostics().missingOrdinals).toEqual(['outdoor']);
  });

  it('cuts the search on a tall building', () => {
    // 20 floors of 7x7 corridor grid, one lift, a trip straight up. Without the level term every floor
    // below the target looks equally close in plan, so A* spreads over all of them.
    const t = gridTower(20);
    const withLevels = new LineFinder(t.network, t.graphOptions);
    const { levels, ...without } = t.graphOptions;
    void levels;
    const plain = new LineFinder(t.network, without);
    expect(withLevels.graph.heuristic.perLevel).toBeCloseTo(4, 4);
    const points = [
      { coordinates: t.at(1, 1), snap: { group: 1 } },
      { coordinates: t.at(1, 1), snap: { group: 20 } },
    ];
    const a = withLevels.route(points);
    const c = plain.route(points);
    expect(a.ok && c.ok).toBe(true);
    if (!a.ok || !c.ok) return;
    expect(a.weight).toBeCloseTo(c.weight, 9);
    expect(a.legs[0].settled * 4).toBeLessThanOrEqual(c.legs[0].settled);
  });
});

describe('level routing differential (A* / ALT / bidirectional vs Dijkstra)', () => {
  const cases: { name: string; options: Parameters<typeof randomBuilding>[1]; seed: number }[] = [
    { name: 'lifts and stairs', options: { floors: 5, size: 5 }, seed: 1 },
    { name: 'sparse top floor', options: { floors: 4, size: 6, sparseTop: true }, seed: 2 },
    { name: 'one-way escalators', options: { floors: 5, size: 5, escalators: 1 }, seed: 3 },
    { name: 'express lift', options: { floors: 6, size: 5, express: true }, seed: 4 },
    { name: 'free lift (no bound)', options: { floors: 4, size: 5, freeElevator: true }, seed: 5 },
    { name: 'outdoor level without an ordinal', options: { floors: 4, size: 5, outdoor: true }, seed: 6 },
    {
      name: 'everything at once',
      options: { floors: 6, size: 5, escalators: 1, express: true, outdoor: true, elevation: true },
      seed: 7,
    },
  ];

  for (const { name, options, seed } of cases) {
    it(`agrees on every pair: ${name}`, () => {
      const rand = mulberry32(seed);
      const b = randomBuilding(rand, options);
      const finder = new LineFinder(b.network, b.graphOptions).registerAlgorithm(bidirectionalDijkstra);
      const alt = new LineFinder(finder.graph, { landmarks: { count: 6, active: 3 } }).registerAlgorithm(
        bidirectionalDijkstra,
      );
      const span = (b.size - 1) * b.spacing;
      const pick = () => {
        const group = b.floors[Math.floor(rand() * b.floors.length)];
        return { coordinates: [rand() * span, rand() * span] as Position, snap: { group } };
      };
      let compared = 0;
      for (let k = 0; k < 40; k++) {
        const points = [pick(), pick()];
        const reference = finder.route(points, { algorithm: 'dijkstra' });
        for (const [label, result] of [
          ['astar', finder.route(points)],
          ['alt', alt.route(points)],
          ['bidirectional', finder.route(points, { algorithm: 'bidijkstra' })],
        ] as const) {
          expect(`${label}:${result.ok}`).toBe(`${label}:${reference.ok}`);
          if (result.ok && reference.ok) {
            expect(Math.abs(result.weight - reference.weight)).toBeLessThan(1e-9 * (1 + reference.weight));
          }
        }
        if (reference.ok) compared++;
      }
      expect(compared).toBeGreaterThan(10); // the buildings really are routable
    });
  }

  it('never over-estimates the remaining cost (admissibility property)', () => {
    const rand = mulberry32(21);
    const b = randomBuilding(rand, { floors: 5, size: 4, escalators: 1 });
    const graph = new LineFinder(b.network, b.graphOptions).graph;
    const { dims, scale, perLevel } = graph.heuristic;
    expect(perLevel).toBeGreaterThan(0);
    const ordinals = graph.nodeOrdinals();
    const emb = graph.nodes.embedding;
    const bound = (from: number, to: number) => {
      let sum = 0;
      for (let d = 0; d < dims; d++) {
        const diff = emb[from * dims + d] - emb[to * dims + d];
        sum += diff * diff;
      }
      let h = scale * Math.sqrt(sum);
      if (!Number.isNaN(ordinals[from]) && !Number.isNaN(ordinals[to])) {
        h += perLevel * Math.abs(ordinals[from] - ordinals[to]);
      }
      return h;
    };
    // Exact node-to-node costs from a plain Dijkstra over the public CSR: no snapping, no engine.
    const { offsets, targets, costs } = graph.edges;
    const shortest = (source: number): Float64Array => {
      const dist = new Float64Array(graph.nodes.count).fill(Infinity);
      const done = new Uint8Array(graph.nodes.count);
      dist[source] = 0;
      for (;;) {
        let u = -1;
        for (let n = 0; n < dist.length; n++) {
          if (!done[n] && dist[n] < (u < 0 ? Infinity : dist[u])) u = n;
        }
        if (u < 0) break;
        done[u] = 1;
        for (let e = offsets[u]; e < offsets[u + 1]; e++) {
          const v = targets[e];
          if (dist[u] + costs[e] < dist[v]) dist[v] = dist[u] + costs[e];
        }
      }
      return dist;
    };
    let checked = 0;
    for (let k = 0; k < 8; k++) {
      const source = Math.floor(rand() * graph.nodes.count);
      const dist = shortest(source);
      for (let to = 0; to < dist.length; to++) {
        if (!(dist[to] < Infinity)) continue;
        expect(bound(source, to)).toBeLessThanOrEqual(dist[to] * (1 + 1e-9) + 1e-9);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('keeps the result invariants on every route', () => {
    const rand = mulberry32(31);
    const b = randomBuilding(rand, { floors: 5, size: 5, escalators: 1, express: true, elevation: true });
    const finder = new LineFinder(b.network, b.graphOptions);
    const span = (b.size - 1) * b.spacing;
    let routes = 0;
    for (let k = 0; k < 40; k++) {
      const pick = () => ({
        coordinates: [rand() * span, rand() * span] as Position,
        snap: { group: b.floors[Math.floor(rand() * b.floors.length)] },
      });
      const result: RouteResult<BuildingProps> = finder.route([pick(), pick(), pick()]);
      if (!result.ok) continue;
      routes++;
      let changes = 0;
      for (const leg of result.legs) {
        expect(leg.levels).toHaveLength(leg.path.length);
        for (const t of leg.transitions!) {
          expect(t.start).toBeGreaterThanOrEqual(0);
          expect(t.end).toBeLessThan(leg.path.length);
          expect(t.end).toBeGreaterThan(t.start);
          expect(t.featureIndices.length).toBeGreaterThan(0);
          changes += Math.abs(t.levelChange);
        }
        // Every section is on one level or is a connector; a level section never spans a passage.
        for (const section of leg.sections) {
          if (section.level === null) continue;
          for (let i = section.start; i <= section.end; i++) {
            expect(leg.levels![i]).toBe(section.level);
          }
        }
      }
      expect(result.levelChanges).toBe(changes);
      const collection = toLevelFeatures(result);
      const covered = collection.features
        .filter((f) => f.geometry.type === 'LineString')
        .reduce((sum, f) => sum + (f.geometry.coordinates as Position[]).length - 1, 0);
      const segments = result.legs.reduce((sum, leg) => sum + leg.path.length - 1, 0);
      expect(covered).toBe(segments);
      expect(collection.features.filter((f) => f.properties.kind === 'transition')).toHaveLength(
        result.legs.reduce((sum, leg) => sum + leg.transitions!.length, 0),
      );
    }
    expect(routes).toBeGreaterThan(10);
  });
});

describe('vertical connectors', () => {
  const stops = (floors: number[]) => floors.map((f) => ({ group: f, position: [10, 10] as Position }));

  function express(connector: Partial<VerticalConnector<BuildingProps>> = {}) {
    const network = fc(
      [1, 2, 3, 4].flatMap((f) => [
        line(
          [
            [0, 10],
            [10, 10],
            [20, 10],
          ],
          { kind: 'corridor', floor: f, factor: 1 } as BuildingProps,
          `ew-F${f}`,
        ),
      ]),
    );
    return new LineFinder(network, {
      ...towerOptions(),
      splitIntersections: false,
      verticalConnectors: [
        {
          id: 'lift',
          kind: 'elevator',
          stops: stops([1, 2, 3, 4]),
          boardCost: 5,
          perLevelCost: 1,
          ...connector,
        } as VerticalConnector<BuildingProps>,
      ],
    });
  }

  it('charges the boarding once per ride, not once per floor', () => {
    const finder = express();
    expect(finder.graph.stats.verticalConnectors).toBe(1);
    const route = finder.route([
      { coordinates: [2, 10], snap: { group: 1 } },
      { coordinates: [18, 10], snap: { group: 4 } },
    ]);
    expect(route.ok).toBe(true);
    if (!route.ok) return;
    // 8 along F1, one ride of 5 + 3 x 1, 8 along F4 - and the ride is a single section.
    expect(route.weight).toBeCloseTo(8 + 8 + 8, 9);
    expect(route.legs[0].transitions).toHaveLength(1);
    expect(route.legs[0].transitions![0]).toMatchObject({ fromLevel: 1, toLevel: 4, levelChange: 3 });
    const ride = route.legs[0].sections.filter((s) => s.level === null);
    expect(ride).toHaveLength(1);
    expect(ride[0].properties).toMatchObject({ kind: 'elevator' });
    expect(route.levelChanges).toBe(3);
  });

  it('honours a one-way direction', () => {
    const up = express({ direction: 'up' });
    const down = up.route([
      { coordinates: [2, 10], snap: { group: 4 } },
      { coordinates: [18, 10], snap: { group: 1 } },
    ]);
    expect(down.ok).toBe(false);
    const rise = up.route([
      { coordinates: [2, 10], snap: { group: 1 } },
      { coordinates: [18, 10], snap: { group: 4 } },
    ]);
    expect(rise.ok).toBe(true);
  });

  it('validates its input', () => {
    expect(() => express({ stops: stops([1]) })).toThrow(RangeError);
    expect(() => express({ stops: 'x' as never })).toThrow(TypeError);
    expect(() => express({ boardCost: -1 })).toThrow(RangeError);
    expect(() => express({ direction: 'sideways' as never })).toThrow(RangeError);
    // perLevelCost needs ordinals: a group the `levels` option does not know has none.
    expect(() => express({ stops: [...stops([1, 2]), { group: 'roof', position: [10, 10] }] })).toThrow(
      RangeError,
    );
  });
});

describe('weights, elevation and z output', () => {
  /** Stairs priced by climb: `distance + 8 * rise`, which needs the interpolated vertex elevations. */
  it('gives the weight function the groups and the climb of every segment', () => {
    const seen: { kind: string; from: unknown; to: unknown; rise: number }[] = [];
    const finder = new LineFinder(
      fc([
        line(
          [
            [0, 0],
            [10, 0],
          ],
          { kind: 'corridor', floor: 1, factor: 1 } as BuildingProps,
          'F1',
        ),
        line(
          [
            [14, 0],
            [24, 0],
          ],
          { kind: 'corridor', floor: 2, factor: 1 } as BuildingProps,
          'F2',
        ),
        // Four equal steps from F1 (0 m) to F2 (4 m): the climb is spread along the flight by length.
        line(
          [
            [10, 0],
            [11, 0],
            [12, 0],
            [13, 0],
            [14, 0],
          ],
          { kind: 'stairs', from: 1, to: 2 } as BuildingProps,
          'stairs',
        ),
      ]),
      {
        metric: 'euclidean',
        group: buildingGroup,
        levels: (g) => (typeof g === 'number' ? { ordinal: g, elevation: (g - 1) * 4 } : undefined),
        weight: (_a, _b, p, ctx) => {
          seen.push({ kind: p.kind, from: ctx.fromGroup, to: ctx.toGroup, rise: ctx.rise });
          return p.kind === 'corridor' ? ctx.distance : ctx.distance + 8 * Math.max(ctx.rise, 0);
        },
      },
    );
    const stairs = seen.filter((s) => s.kind === 'stairs');
    expect(stairs).toHaveLength(4);
    expect(stairs[0]).toMatchObject({ from: 1, to: undefined });
    expect(stairs[3]).toMatchObject({ from: undefined, to: 2 });
    // The 4 m climb is spread over the four steps by length: 1 / 1 / 1 / 1 m each.
    expect(stairs.map((s) => Number(s.rise.toFixed(6)))).toEqual([1, 1, 1, 1]);
    const route = finder.route([
      { coordinates: [1, 0], snap: { group: 1 } },
      { coordinates: [23, 0], snap: { group: 2 } },
    ]);
    expect(route.ok).toBe(true);
    if (!route.ok) return;
    // 9 along F1, the flight (4 m of treads + 8 x 4 m of climb), 9 along F2.
    expect(route.weight).toBeCloseTo(9 + (4 + 32) + 9, 9);
    expect(route.verticalDistance).toBeCloseTo(4, 9);
  });

  it('writes the height into the third coordinate on request', () => {
    const finder = towerFinder(3);
    const points = [
      { coordinates: [2, 10] as Position, snap: { group: 1 } },
      { coordinates: [10, 18] as Position, snap: { group: 3 } },
    ];
    const plain = finder.route(points);
    const withZ = finder.route(points, { output: { z: 'elevation' } });
    expect(plain.ok && withZ.ok).toBe(true);
    if (!plain.ok || !withZ.ok) return;
    expect(plain.path.every((p) => p.length === 2)).toBe(true);
    expect(withZ.path.map((p) => p[2])).toEqual([0, 0, 4, 8, 8]);
    expect(withZ.path.map((p) => [p[0], p[1]])).toEqual(plain.path.map((p) => [p[0], p[1]]));
    expect(() => finder.route(points, { output: { z: 'nope' as never } })).toThrow(RangeError);
  });

  it('omits verticalDistance when no level carries an elevation', () => {
    const finder = towerFinder(3, false);
    const route = finder.route([
      { coordinates: [2, 10], snap: { group: 1 } },
      { coordinates: [10, 18], snap: { group: 3 } },
    ]);
    expect(route.ok).toBe(true);
    if (!route.ok) return;
    expect(route.levelChanges).toBe(2);
    expect(route.verticalDistance).toBeUndefined();
  });
});

describe('levels alongside the other route options', () => {
  it('keeps path indices and the level array aligned when legs get connectors', () => {
    const finder = towerFinder(3);
    const points = [
      { coordinates: [2, 12] as Position, snap: { group: 1 } },
      { coordinates: [12, 18] as Position, snap: { group: 3 } },
    ];
    const route = finder.route(points, { connectors: 'legs' });
    expect(route.ok).toBe(true);
    if (!route.ok) return;
    const leg = route.legs[0];
    expect(leg.path[0]).toEqual([2, 12]);
    expect(leg.levels).toHaveLength(leg.path.length);
    expect(leg.levels![0]).toBe(1);
    expect(leg.levels![leg.levels!.length - 1]).toBe(3);
    // Section and transition indices still point at the right coordinates of the leg path.
    for (const section of leg.sections) {
      if (section.level === null) continue;
      expect(leg.levels![section.start]).toBe(section.level);
      expect(leg.levels![section.end]).toBe(section.level);
    }
    for (const t of leg.transitions!) {
      expect(leg.levels![t.start]).toBe(t.fromLevel);
      expect(leg.levels![t.end]).toBe(t.toLevel);
    }
  });

  it('marks a straight bridge as belonging to no level', () => {
    const finder = towerFinder(2);
    const route = finder.route(
      [
        { coordinates: [2, 10] as Position, snap: { group: 1 } },
        { coordinates: [200, 200] as Position, snap: { group: 1, maxDistance: 1 } },
        { coordinates: [18, 10] as Position, snap: { group: 2 } },
      ],
      { onFailure: 'straight' },
    );
    expect(route.ok).toBe(true);
    if (!route.ok) return;
    const straight = route.legs.filter((l) => l.kind === 'straight');
    expect(straight.length).toBeGreaterThan(0);
    for (const leg of straight) {
      expect(leg.levels).toHaveLength(leg.path.length);
      expect(leg.levels!.every((l) => l === null)).toBe(true);
      expect(leg.transitions).toEqual([]);
    }
  });

  it('labels the legs of oneToMany as well', () => {
    const finder = towerFinder(3);
    const many = finder.oneToMany([2, 10], [[10, 18]], { paths: true, snap: { group: 1 } });
    expect('ok' in many && many.ok).toBe(true);
    if (!('legs' in many) || !many.legs) return;
    const leg = many.legs[0];
    expect(leg).not.toBeNull();
    expect(leg!.levels).toHaveLength(leg!.path.length);
    expect(leg!.transitions!.length).toBeGreaterThanOrEqual(0);
  });
});

describe('toLevelFeatures', () => {
  it('splits a route into per-level lines, connector lines and passage points', () => {
    const route = towerFinder(3).route([
      { coordinates: [2, 10], snap: { group: 1 } },
      { coordinates: [10, 18], snap: { group: 3 } },
    ]);
    expect(route.ok).toBe(true);
    if (!route.ok) return;
    const { features } = toLevelFeatures(route);
    expect(features.map((f) => f.properties.kind)).toEqual(['path', 'connector', 'path', 'transition']);
    expect(features[0].properties.level).toBe(1);
    expect(features[0].geometry.coordinates).toEqual([
      [2, 10],
      [10, 10],
    ]);
    expect(features[1].properties).toMatchObject({ level: null, fromLevel: 1, toLevel: 3, levelChange: 2 });
    expect(features[2].properties.level).toBe(3);
    expect(features[3].geometry).toEqual({ type: 'Point', coordinates: [10, 10] });
  });

  it('returns nothing for a failed route or a graph without levels', () => {
    expect(
      toLevelFeatures({ ok: false, reason: 'SNAP_FAILED', message: '', algorithm: 'astar' }).features,
    ).toHaveLength(0);
    const { levels, ...plain } = towerOptions();
    void levels;
    const route = new LineFinder(tower(2), plain).route([
      { coordinates: [2, 10], snap: { group: 1 } },
      { coordinates: [18, 10], snap: { group: 1 } },
    ]);
    expect(toLevelFeatures(route).features).toHaveLength(0);
  });
});

describe('level diagnostics', () => {
  it('finds connector ends that never reached their floor', () => {
    const network = fc([
      line(
        [
          [0, 0],
          [10, 0],
          [20, 0],
        ],
        { kind: 'corridor', floor: 1, factor: 1 } as BuildingProps,
        'F1',
      ),
      line(
        [
          [0, 0],
          [20, 0],
        ],
        { kind: 'corridor', floor: 2, factor: 1 } as BuildingProps,
        'F2',
      ),
      // The lift lands 3 m off the F2 corridor: connected on F1, dangling on F2.
      line(
        [
          [10, 0],
          [10, 3],
        ],
        { kind: 'elevator', from: 1, to: 2, cost: 4 } as BuildingProps,
        'lift',
      ),
    ]);
    const graph = buildGraph(network, { ...towerOptions(), splitIntersections: true });
    const diag = graph.diagnostics();
    expect(diag.connectorEnds!.total).toBe(1);
    expect(diag.connectorEnds!.items[0]).toMatchObject({ featureId: 'lift', level: 2 });
    expect(diag.connectorEnds!.items[0].location).toEqual([10, 3]);
  });

  it('reports which levels reach which', () => {
    const network = fc([
      ...[1, 2, 3].map((f) =>
        line(
          [
            [0, 0],
            [20, 0],
          ],
          { kind: 'corridor', floor: f, factor: 1 } as BuildingProps,
          `F${f}`,
        ),
      ),
      line(
        [
          [10, 0],
          [10, 0],
        ],
        { kind: 'elevator', from: 1, to: 2, cost: 4 } as BuildingProps,
        'lift',
      ),
    ]);
    const graph = buildGraph(network, { ...towerOptions(), splitIntersections: true });
    const reach = graph.diagnostics().levelReachability!;
    const byLevel = new Map(reach.map((r) => [r.level, r]));
    expect(byLevel.get(1)!.connectedTo).toEqual([2]);
    expect(byLevel.get(2)!.connectedTo).toEqual([1]);
    expect(byLevel.get(3)!.isolated).toBe(true);
    expect(byLevel.get(3)!.ordinal).toBe(3);
  });
});

describe('serialisation of levels', () => {
  it('stays at format 1 without levels and moves to format 2 with them', () => {
    const { levels, ...plain } = towerOptions();
    void levels;
    expect(buildGraph(tower(2), plain).toTransferable().formatVersion).toBe(1);
    expect(buildGraph(tower(2), towerOptions()).toTransferable().formatVersion).toBe(2);
  });

  it('round-trips levels, elevations, the per-level bound and synthesised connectors', () => {
    const rand = mulberry32(5);
    const b = randomBuilding(rand, { floors: 4, size: 4, express: true, elevation: true });
    const finder = new LineFinder(b.network, b.graphOptions);
    const data = finder.graph.toTransferable();
    // A worker passes the input collection; the synthesised connector features come back from the header.
    const copy = RoutingGraph.fromTransferable<BuildingProps>(data, { features: b.network.features });
    expect(copy.features).toHaveLength(finder.graph.features.length);
    expect(copy.syntheticFeatures).toBe(1);
    expect(copy.levels!.ordinal).toEqual(finder.graph.levels!.ordinal);
    expect(copy.levels!.elevation).toEqual(finder.graph.levels!.elevation);
    expect(copy.levels!.name).toEqual(finder.graph.levels!.name);
    expect(copy.heuristic.perLevel).toBe(finder.graph.heuristic.perLevel);
    expect(copy.vertices.elevation).toEqual(finder.graph.vertices.elevation);

    const points = [
      { coordinates: b.at(0, 0), snap: { group: 1 } },
      { coordinates: b.at(3, 3), snap: { group: 4 } },
    ];
    const before = finder.route(points);
    const after = new LineFinder(copy).route(points);
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.weight).toBeCloseTo(before.weight, 12);
    expect(after.levelChanges).toBe(before.levelChanges);
    expect(after.verticalDistance).toBeCloseTo(before.verticalDistance!, 12);
    expect(after.legs[0].levels).toEqual(before.legs[0].levels);
  });

  it('still accepts the whole feature list, and refuses an unknown version', () => {
    const rand = mulberry32(9);
    const b = randomBuilding(rand, { floors: 3, size: 4, express: true });
    const graph = buildGraph(b.network, b.graphOptions);
    const data = graph.toTransferable();
    const copy = RoutingGraph.fromTransferable<BuildingProps>(data, { features: graph.features });
    expect(copy.features).toHaveLength(graph.features.length);
    expect(() => RoutingGraph.fromTransferable({ ...data, formatVersion: 3 })).toThrow(RangeError);
    expect(() => RoutingGraph.fromTransferable(data, { features: b.network.features.slice(1) })).toThrow(
      RangeError,
    );
  });
});
