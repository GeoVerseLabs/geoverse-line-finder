import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { osmWeight, type OsmProps } from '../bench/osm-weight';
import {
  LineFinder,
  createPropertyWeight,
  type GraphStats,
  type NearestResult,
  type NetworkCollection,
  type Position,
  type RouteOptions,
  type RouteResult,
} from '../src';
import { findGpfData, gpfFixture } from './data';
import { LEVEL_FACTOR, warehouseNetwork, warehouseTasks, type AisleProps } from './fixtures/warehouse';
import { gridWeight, mulberry32, randomGrid } from './helpers';

/**
 * Golden outputs of 0.1.0. Default configurations must keep producing **bit-identical** results for every
 * field that existed in 0.1.0, including engine statistics (which pin the search order). New fields are
 * ignored by the projection below. Regenerate only on purpose: `UPDATE_GOLDEN=1 pnpm vitest run golden`.
 */
const GOLDEN_URL = new URL('./fixtures/golden-0.1.0.json', import.meta.url);
const UPDATE = process.env.UPDATE_GOLDEN === '1';
type Golden = Record<string, string[]>;
const golden: Golden = UPDATE ? {} : (JSON.parse(readFileSync(GOLDEN_URL, 'utf8')) as Golden);

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

function project(r: RouteResult<unknown>): unknown {
  const waypoint = (w: {
    input: Position;
    location: Position;
    distance: number;
    component: number;
    featureIndex: number;
  }) => ({
    input: w.input,
    location: w.location,
    distance: w.distance,
    component: w.component,
    featureIndex: w.featureIndex,
  });
  if (!r.ok) {
    return {
      ok: false,
      reason: r.reason,
      message: r.message,
      waypointIndex: r.waypointIndex,
      legIndex: r.legIndex,
      waypoints: r.waypoints?.map(waypoint),
      algorithm: r.algorithm,
    };
  }
  return {
    ok: true,
    path: r.path,
    weight: r.weight,
    distance: r.distance,
    legs: r.legs.map((leg) => ({
      from: leg.from,
      to: leg.to,
      path: leg.path,
      weight: leg.weight,
      distance: leg.distance,
      sections: leg.sections.map((s) => ({
        featureIndex: s.featureIndex,
        id: s.id,
        start: s.start,
        end: s.end,
        distance: s.distance,
        weight: s.weight,
      })),
      settled: leg.settled,
      relaxed: leg.relaxed,
    })),
    waypoints: r.waypoints.map(waypoint),
    algorithm: r.algorithm,
  };
}

function projectNearest(n: NearestResult | null): unknown {
  return (
    n && { location: n.location, distance: n.distance, component: n.component, featureIndex: n.featureIndex }
  );
}

function projectStats(s: Readonly<GraphStats>): unknown {
  // The 0.1.0 fields in their original order. danglesSnapped is excluded: 0.2.0 fixes its count (zero-width
  // gaps were not counted).
  return {
    features: s.features,
    lineFeatures: s.lineFeatures,
    skippedFeatures: s.skippedFeatures,
    invalidCoordinates: s.invalidCoordinates,
    coordinates: s.coordinates,
    vertices: s.vertices,
    mergedVertices: s.mergedVertices,
    intersectionsSplit: s.intersectionsSplit,
    segments: s.segments,
    impassableSegments: s.impassableSegments,
    oneWaySegments: s.oneWaySegments,
    nodes: s.nodes,
    chains: s.chains,
    edges: s.edges,
    components: s.components,
    largestComponentNodes: s.largestComponentNodes,
  };
}

type Case = { id: string; run: () => unknown[]; skip?: boolean };

function bbox(network: NetworkCollection<unknown>): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const f of network.features) {
    const g = f.geometry as { type: string; coordinates: Position[] };
    if (g?.type !== 'LineString') continue;
    for (const [x, y] of g.coordinates) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return [minX, minY, maxX, maxY];
}

const km = (_a: Position, _b: Position, _p: unknown, ctx: { distance: number }) => ctx.distance / 1000;

const cases: Case[] = [];

cases.push({
  id: 'gpf-network',
  run: () => {
    const network = gpfFixture('network.json');
    const finder = new LineFinder(network, { weight: km, tolerance: 1.1 });
    const [minX, minY, maxX, maxY] = bbox(network);
    const rand = mulberry32(11);
    const point = (): Position => [minX + rand() * (maxX - minX), minY + rand() * (maxY - minY)];
    const out: unknown[] = [projectStats(finder.graph.stats)];
    const variants: RouteOptions[] = [
      {},
      { algorithm: 'dijkstra' },
      { connectors: true },
      { snap: { mode: 'vertex' } },
      { snap: { mode: 'node' } },
      { snap: { connectivity: 'nearest', maxDistance: 200 } },
    ];
    for (const options of variants) {
      for (let i = 0; i < 12; i++) {
        const n = 2 + (i % 3);
        out.push(project(finder.route(Array.from({ length: n }, point), options)));
      }
    }
    out.push(
      project(
        finder.route(
          [
            [8.44460166, 59.48947469],
            [8.44651, 59.513920000000006],
          ],
          { snap: { mode: 'exact' } },
        ),
      ),
    );
    for (let i = 0; i < 10; i++) out.push(projectNearest(finder.nearest(point())));
    return out;
  },
});

for (const seed of [1, 2, 3, 4]) {
  cases.push({
    id: `random-grid-${seed}`,
    run: () => {
      const rand = mulberry32(500 + seed);
      const network = randomGrid(rand, 9, { blocked: 0.03 });
      const out: unknown[] = [];
      const finders = [
        new LineFinder(network, { metric: 'euclidean', weight: gridWeight }),
        new LineFinder(network, {
          metric: 'euclidean',
          weight: gridWeight,
          tolerance: 0.5,
          snapDangles: 2,
          splitIntersections: true,
        }),
        new LineFinder(network, { metric: 'euclidean', weight: gridWeight, compact: false }),
      ];
      const variants: RouteOptions[] = [
        {},
        { snap: { connectivity: 'nearest' } },
        { algorithm: 'dijkstra', connectors: true },
        { snap: { maxDistance: 3 } },
      ];
      for (const finder of finders) {
        out.push(projectStats(finder.graph.stats));
        for (const options of variants) {
          for (let q = 0; q < 8; q++) {
            const n = 2 + (q % 3);
            const pts: Position[] = Array.from({ length: n }, () => [rand() * 85 - 2, rand() * 85 - 2]);
            out.push(project(finder.route(pts, options)));
          }
        }
      }
      return out;
    },
  });
}

const warehouseWeight = createPropertyWeight<AisleProps>({ factor: (p) => LEVEL_FACTOR[p.roadLevel] });

cases.push({
  id: 'warehouse',
  run: () => {
    const tasks = warehouseTasks();
    const out: unknown[] = [];
    const normalized = new LineFinder(warehouseNetwork(true), { weight: warehouseWeight });
    out.push(projectStats(normalized.graph.stats));
    for (const task of tasks.slice(0, 40))
      out.push(project(normalized.route(task.map((w) => w.coordinates))));
    const raw = warehouseNetwork(false);
    const finders = [
      new LineFinder(raw, { weight: warehouseWeight }),
      new LineFinder(raw, { weight: warehouseWeight, snapDangles: 0.5 }),
      new LineFinder(raw, { weight: warehouseWeight, splitIntersections: true }),
    ];
    const variants: RouteOptions[] = [{}, { snap: { connectivity: 'nearest', maxDistance: 100 } }];
    for (const finder of finders) {
      out.push(projectStats(finder.graph.stats));
      for (const options of variants) {
        for (const task of tasks.slice(40, 60))
          out.push(
            project(
              finder.route(
                task.map((w) => w.coordinates),
                options,
              ),
            ),
          );
      }
    }
    return out;
  },
});

const LARGE = findGpfData('large-network.json');

cases.push({
  id: 'large-network-osm',
  skip: !LARGE,
  run: () => {
    const network = JSON.parse(readFileSync(LARGE!, 'utf8')) as NetworkCollection<OsmProps>;
    const finder = new LineFinder(network, { weight: (a, b, p) => osmWeight(a, b, p) });
    const { graph } = finder;
    const rand = mulberry32(77);
    const out: unknown[] = [projectStats(graph.stats)];
    const point = (): Position => {
      const v = Math.floor(rand() * graph.vertices.count);
      const p = graph.vertices.positions[v];
      return [p[0] + (rand() - 0.5) * 4e-4, p[1] + (rand() - 0.5) * 4e-4];
    };
    for (let i = 0; i < 30; i++) out.push(project(finder.route([point(), point()])));
    for (let i = 0; i < 10; i++)
      out.push(project(finder.route([point(), point(), point()], { algorithm: 'dijkstra' })));
    return out;
  },
});

describe('golden outputs of 0.1.0 (default configurations stay bit-identical)', () => {
  for (const c of cases) {
    it.skipIf(!!c.skip)(c.id, () => {
      const hashes = c.run().map(digest);
      if (UPDATE) {
        golden[c.id] = hashes;
        return;
      }
      expect(golden[c.id], `golden case "${c.id}" missing — regenerate with UPDATE_GOLDEN=1`).toBeDefined();
      expect(hashes.length).toBe(golden[c.id].length);
      hashes.forEach((h, i) => expect(h, `${c.id} #${i}`).toBe(golden[c.id][i]));
    });
  }

  afterAll(() => {
    if (UPDATE) writeFileSync(GOLDEN_URL, `${JSON.stringify(golden, null, 1)}\n`);
  });
});
