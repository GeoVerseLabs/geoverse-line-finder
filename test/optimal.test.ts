import { describe, expect, it } from 'vitest';
import {
  LineFinder,
  createPropertyWeight,
  type PathAlgorithm,
  type Position,
  type RouteOptions,
} from '../src';
import { LEVEL_FACTOR, warehouseNetwork, warehouseTasks, type AisleProps } from './fixtures/warehouse';
import { ReferenceGraph, fc, gridWeight, insertVertex, line, mulberry32, randomGrid } from './helpers';

// Main (cheap, factor 1) along y = 0, Side (expensive, factor 3) along y = 3.5, joined by two subs.
const corridor = fc([
  line(
    [
      [0, 0],
      [100, 0],
    ],
    { factor: 1 },
    'main',
  ),
  line(
    [
      [0, 3.5],
      [100, 3.5],
    ],
    { factor: 3 },
    'side',
  ),
  line(
    [
      [0, 0],
      [0, 3.5],
    ],
    { factor: 1 },
    'sub-w',
  ),
  line(
    [
      [100, 0],
      [100, 3.5],
    ],
    { factor: 1 },
    'sub-e',
  ),
]);
const factorWeight = createPropertyWeight<{ factor: number }>({ factor: (p) => p.factor });

describe('optimal selection: both directions of access are cost-driven', () => {
  const finder = new LineFinder(corridor, { metric: 'euclidean', weight: factorWeight });
  const start: Position = [50, 2]; // 1.5 from Side, 2.0 from Main
  const end: Position = [90, -1]; // near Main
  const options: RouteOptions = {
    snap: { selection: 'optimal', costMode: 'ends' },
    totals: { includeSnapWeight: true },
  };

  it('AC1 high → low: leaves the nearer Side aisle for Main when that is cheaper overall', () => {
    const nearest = finder.route([start, end], {
      snap: { costMode: 'ends' },
      totals: { includeSnapWeight: true },
    });
    const optimal = finder.route([start, end], options);
    expect(nearest.ok && optimal.ok).toBe(true);
    if (!nearest.ok || !optimal.ok) return;
    expect(nearest.waypoints[0].featureId).toBe('side');
    expect(optimal.waypoints[0]).toMatchObject({ featureId: 'main', candidateRank: 1, relocated: true });
    expect(optimal.waypoints[0].relocation).toBeCloseTo(0.5, 12);
    expect(optimal.weight).toBeCloseTo(40 + 2 + 1, 9);
    expect(optimal.snapWeight).toBeCloseTo(3, 9);
    expect(optimal.networkWeight).toBeCloseTo(40, 9);
    expect(optimal.weight).toBeLessThan(nearest.weight);
  });

  it('AC2 low → high: the reverse query picks the mirrored candidates at the same cost', () => {
    const forward = finder.route([start, end], options);
    const backward = finder.route([end, start], options);
    expect(forward.ok && backward.ok).toBe(true);
    if (!forward.ok || !backward.ok) return;
    expect(backward.waypoints[1].featureId).toBe('main');
    expect(backward.weight).toBeCloseTo(forward.weight, 9);
  });
});

describe('AC4 consistency and AC6 defaults on the warehouse', () => {
  const finder = new LineFinder(warehouseNetwork(), {
    weight: createPropertyWeight<AisleProps>({ factor: (p) => LEVEL_FACTOR[p.roadLevel] }),
  });
  const tasks = warehouseTasks(12);

  it('without passThrough every via is entered and left at the same candidate', () => {
    for (const task of tasks) {
      const r = finder.route(
        task.map((w) => w.coordinates),
        {
          snap: { selection: 'optimal', costMode: 'arrive-depart', candidates: 4 },
          totals: { includeSnapWeight: true },
        },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.legs).toHaveLength(7);
      for (const w of r.waypoints) {
        expect(w.arrive).toBeUndefined();
        expect(w.depart).toBeUndefined();
      }
      for (let i = 0; i + 1 < r.legs.length; i++) {
        const end = r.legs[i].path[r.legs[i].path.length - 1];
        expect(r.legs[i + 1].path[0]).toEqual(end);
      }
      const nearest = finder.route(
        task.map((w) => w.coordinates),
        { snap: { costMode: 'arrive-depart', connectivity: 'nearest' }, totals: { includeSnapWeight: true } },
      );
      expect(nearest.ok && r.weight <= nearest.weight + 1e-9).toBe(true);
    }
  });

  it('reports candidate decisions with debug.candidates', () => {
    const r = finder.route(
      tasks[0].slice(0, 3).map((w) => w.coordinates),
      { snap: { selection: 'optimal', costMode: 'ends' }, debug: { candidates: true } },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const w of r.waypoints) {
      const statuses = w.candidates!.map((c) => c.status);
      expect(statuses).toContain('SELECTED');
      expect(
        statuses.every((s) =>
          ['SELECTED', 'NOT_SELECTED', 'UNREACHABLE', 'RELOCATION', 'FILTERED'].includes(s),
        ),
      ).toBe(true);
    }
  });
});

/** Candidate locations as the finder sees them, then an independent brute force over all combinations. */
function bruteForce(
  finder: LineFinder<unknown>,
  network: Parameters<typeof insertVertex>[0],
  points: Position[],
  k: number,
  factor: number,
  passThrough: boolean,
): number {
  const lists = points.map((p) => finder.candidates(p, { candidates: k }).map((c) => c.location));
  const costs = points.map((p) => finder.candidates(p, { candidates: k }).map((c) => c.distance * factor));
  let dense = network;
  for (const list of lists) for (const loc of list) dense = insertVertex(dense, loc);
  const ref = new ReferenceGraph(dense, gridWeight as never);
  const memo = new Map<string, number>();
  const net = (a: Position, b: Position) => {
    const key = `${a}|${b}`;
    if (!memo.has(key)) memo.set(key, ref.shortest(a, b));
    return memo.get(key)!;
  };
  let best = Infinity;
  const n = points.length;
  // choice[i] = [arrival, departure]
  const walk = (i: number, depart: number, total: number) => {
    if (total >= best) return;
    for (let a = 0; a < lists[i].length; a++) {
      const reach = i === 0 ? 0 : net(lists[i - 1][depart], lists[i][a]);
      if (reach === Infinity) continue;
      if (i === n - 1) {
        best = Math.min(best, total + reach + costs[i][a]);
        continue;
      }
      const leaves = i === 0 || !passThrough ? [a] : lists[i].map((_l, e) => e);
      for (const e of leaves) {
        const arriveCost = i === 0 ? 0 : costs[i][a];
        walk(i + 1, e, total + reach + arriveCost + costs[i][e]);
      }
    }
  };
  walk(0, 0, 0);
  return best;
}

describe('AC5 optimality: agrees with a brute force over every candidate combination', () => {
  for (let seed = 1; seed <= 6; seed++) {
    for (const passThrough of [false, true]) {
      it(`random grid #${seed}${passThrough ? ' (passThrough)' : ''}`, () => {
        const rand = mulberry32(3000 + seed);
        const network = randomGrid(rand, 6, { blocked: 0.03 });
        const factor = 1.5;
        const finder = new LineFinder(network, {
          metric: 'euclidean',
          weight: gridWeight,
        }) as LineFinder<unknown>;
        let compared = 0;
        for (let q = 0; q < 6; q++) {
          const points: Position[] = [0, 1, 2].map(() => [rand() * 50, rand() * 50]);
          const r = finder.route(points, {
            algorithm: q % 2 ? 'dijkstra' : 'astar',
            snap: {
              selection: 'optimal',
              candidates: 3,
              costMode: 'arrive-depart',
              cost: factor,
              passThrough,
            },
            totals: { includeSnapWeight: true },
          });
          const expected = bruteForce(finder, network, points, 3, factor, passThrough);
          if (expected === Infinity) {
            expect(r.ok).toBe(false);
            continue;
          }
          expect(r.ok, `query ${q}`).toBe(true);
          if (!r.ok) continue;
          expect(r.weight).toBeCloseTo(expected, 6);
          compared++;
        }
        expect(compared).toBeGreaterThan(0);
      });
    }
  }
});

describe('pass-through waypoints', () => {
  // Two parallel aisles 4 apart; a floor location between them, visited on the way from west to east.
  const aisles = fc([
    line(
      [
        [0, 0],
        [50, 0],
      ],
      {},
      'south',
    ),
    line(
      [
        [0, 4],
        [50, 4],
      ],
      {},
      'north',
    ),
    line(
      [
        [0, 0],
        [0, 4],
      ],
      {},
      'west',
    ),
    line(
      [
        [50, 0],
        [50, 4],
      ],
      {},
      'east',
    ),
  ]);
  const finder = new LineFinder(aisles, { metric: 'euclidean' });

  it('enters from one aisle and leaves from the other when that is cheaper, going through the input', () => {
    const route = [[10, -1], { coordinates: [25, 2], snap: { passThrough: true } }, [40, 5]];
    const r = finder.route(route, {
      snap: { selection: 'optimal', costMode: 'arrive-depart', candidates: 2 },
      totals: { includeSnapWeight: true },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const via = r.waypoints[1];
    expect(via.arrive?.featureId).toBe('south');
    expect(via.depart?.featureId).toBe('north');
    expect(r.path).toContainEqual([25, 2]);
    expect(r.weight).toBeCloseTo(1 + 15 + 2 + 2 + 15 + 1, 9);
    const without = finder.route(
      [
        [10, -1],
        [25, 2],
        [40, 5],
      ],
      {
        snap: { selection: 'optimal', costMode: 'arrive-depart', candidates: 2 },
        totals: { includeSnapWeight: true },
      },
    );
    expect(without.ok && without.weight).toBeGreaterThan(r.weight);
  });

  it('maxRelocation removes far candidates in optimal selection', () => {
    const r = finder.route(
      [
        [10, -1],
        [25, 1.5],
        [40, 5],
      ],
      {
        snap: { selection: 'optimal', candidates: 4, maxRelocation: 0.5 },
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const w of r.waypoints) expect(w.relocation).toBeLessThanOrEqual(0.5);
  });
});

/** Single-target engine without capabilities, written against the public contract only. */
const plainDijkstra: PathAlgorithm = {
  name: 'plain',
  usesHeuristic: false,
  search({ graph, source, target }) {
    const n = graph.nodeCount;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const edge = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    dist[source] = 0;
    let settled = 0;
    for (;;) {
      let u = -1;
      for (let v = 0; v < n; v++) if (!done[v] && dist[v] < Infinity && (u < 0 || dist[v] < dist[u])) u = v;
      if (u < 0 || u === target) break;
      done[u] = 1;
      settled++;
      const relax = (v: number, c: number, e: number) => {
        if (dist[u] + c < dist[v]) {
          dist[v] = dist[u] + c;
          prev[v] = u;
          edge[v] = e;
        }
      };
      if (u < graph.baseNodeCount)
        for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++)
          relax(graph.targets[e], graph.costs[e], e);
      for (let k = 0; k < graph.overlayCount; k++)
        if (graph.overlayFrom[k] === u)
          relax(graph.overlayTo[k], graph.overlayCost[k], graph.baseEdgeCount + k);
    }
    if (dist[target] === Infinity)
      return { found: false, cost: Infinity, nodes: [], edges: [], settled, relaxed: 0 };
    const nodes = [target];
    const edges: number[] = [];
    for (let v = target; v !== source; v = prev[v]) {
      edges.unshift(edge[v]);
      nodes.unshift(prev[v]);
    }
    return { found: true, cost: dist[target], nodes, edges, settled, relaxed: 0 };
  },
};

describe('engines without multi-target support', () => {
  it('optimal selection emulates multi-target searches and matches the built-ins', () => {
    const rand = mulberry32(77);
    const network = randomGrid(rand, 6);
    const finder = new LineFinder(network, { metric: 'euclidean', weight: gridWeight }).registerAlgorithm(
      plainDijkstra,
    );
    for (let q = 0; q < 8; q++) {
      const points: Position[] = [0, 1, 2].map(() => [rand() * 50, rand() * 50]);
      const options: RouteOptions = {
        snap: { selection: 'optimal', candidates: 3, costMode: 'ends' },
        totals: { includeSnapWeight: true },
      };
      const builtin = finder.route(points, options);
      const custom = finder.route(points, { ...options, algorithm: 'plain' });
      expect(custom.ok).toBe(builtin.ok);
      if (builtin.ok && custom.ok) expect(custom.weight).toBeCloseTo(builtin.weight, 9);
      const many = finder.oneToMany(points[0], points.slice(1), { algorithm: 'plain' });
      const manyBuiltin = finder.oneToMany(points[0], points.slice(1));
      if (many.ok && manyBuiltin.ok) expect(many.weights).toEqual(manyBuiltin.weights);
    }
  });
});
