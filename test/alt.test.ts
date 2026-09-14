import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { osmWeight, type OsmProps } from '../bench/osm-weight';
import {
  LandmarkTable,
  LineFinder,
  bidirectionalDijkstra,
  buildGraph,
  prepareLandmarks,
  type Metric,
  type NetworkCollection,
  type Position,
  type RoutingGraph,
} from '../src';
import { findGpfData } from './data';
import { gridWeight, mulberry32, randomGrid } from './helpers';

/** O(N²) Dijkstra over the graph's CSR (or its reverse), independent of the library's searches. */
function naiveDistances(graph: RoutingGraph<unknown>, source: number, reverse: boolean): Float64Array {
  const N = graph.nodes.count;
  const dist = new Float64Array(N).fill(Infinity);
  const done = new Uint8Array(N);
  dist[source] = 0;
  const { offsets, targets, costs } = graph.edges;
  for (;;) {
    let u = -1;
    for (let v = 0; v < N; v++) if (!done[v] && dist[v] < Infinity && (u < 0 || dist[v] < dist[u])) u = v;
    if (u < 0) break;
    done[u] = 1;
    if (!reverse) {
      for (let e = offsets[u]; e < offsets[u + 1]; e++)
        dist[targets[e]] = Math.min(dist[targets[e]], dist[u] + costs[e]);
    } else {
      for (let w = 0; w < N; w++) {
        for (let e = offsets[w]; e < offsets[w + 1]; e++)
          if (targets[e] === u) dist[w] = Math.min(dist[w], dist[u] + costs[e]);
      }
    }
  }
  return dist;
}

describe('ALT landmarks', () => {
  it('store exact distances to and from every landmark', () => {
    const graph = buildGraph(randomGrid(mulberry32(3), 6, { oneway: 0.3 }), {
      metric: 'euclidean',
      weight: gridWeight,
    });
    for (const strategy of ['farthest', 'planar'] as const) {
      const table = prepareLandmarks(graph, { count: 4, strategy });
      expect(table.count).toBeGreaterThan(0);
      const N = graph.nodes.count;
      for (let L = 0; L < table.count; L++) {
        const from = naiveDistances(graph, table.nodes[L], false);
        const to = naiveDistances(graph, table.nodes[L], true);
        for (let v = 0; v < N; v++) {
          expect(table.fromLandmark[L * N + v]).toBeCloseTo(from[v], 9);
          expect(table.toLandmark[L * N + v]).toBeCloseTo(to[v], 9);
        }
      }
    }
    expect(prepareLandmarks(graph, { strategy: [0, 1] }).nodes).toEqual(Int32Array.from([0, 1]));
    expect(() => prepareLandmarks(graph, { count: 0 })).toThrow(RangeError);
    expect(() => prepareLandmarks(graph, { strategy: [-1] })).toThrow(RangeError);
  });

  it('give identical optimal results with fewer settled nodes', () => {
    let settledPlain = 0;
    let settledAlt = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const rand = mulberry32(40 + seed);
      const plain = new LineFinder(randomGrid(rand, 14, { oneway: 0.2 }), {
        metric: 'euclidean',
        weight: gridWeight,
      });
      const alt = new LineFinder(plain.graph, { landmarks: { count: 6, active: 3 } });
      for (let q = 0; q < 20; q++) {
        const points: Position[] = [0, 1].map(() => [rand() * 130, rand() * 130]);
        const a = plain.route(points, { snap: { connectivity: 'nearest' } });
        const b = alt.route(points, { snap: { connectivity: 'nearest' } });
        expect(b.ok).toBe(a.ok);
        if (!a.ok || !b.ok) continue;
        expect(b.weight).toBeCloseTo(a.weight, 9);
        settledPlain += a.legs[0].settled;
        settledAlt += b.legs[0].settled;
      }
      const points: Position[] = [0, 1, 2].map(() => [rand() * 130, rand() * 130]);
      const optimal = {
        snap: { selection: 'optimal' as const, costMode: 'ends' as const },
        totals: { includeSnapWeight: true },
      };
      const oa = plain.route(points, optimal);
      const ob = alt.route(points, optimal);
      expect(ob.ok).toBe(oa.ok);
      if (oa.ok && ob.ok) expect(ob.weight).toBeCloseTo(oa.weight, 9);
      const ma = plain.oneToMany(points[0], points.slice(1));
      const mb = alt.oneToMany(points[0], points.slice(1));
      if (ma.ok && mb.ok) mb.weights.forEach((w, i) => expect(w).toBeCloseTo(ma.weights[i], 9));
    }
    expect(settledAlt).toBeLessThan(settledPlain);
  });

  it('round-trips and refuses a table of another graph', () => {
    const rand = mulberry32(9);
    const finder = new LineFinder(randomGrid(rand, 8), {
      metric: 'euclidean',
      weight: gridWeight,
      landmarks: { count: 3 },
    });
    const table = LandmarkTable.fromTransferable(structuredClone(finder.landmarks!.toTransferable()));
    const again = new LineFinder(finder.graph, { landmarks: table });
    const points: Position[] = [
      [3, 4],
      [66, 70],
    ];
    const a = finder.route(points);
    const b = again.route(points);
    expect(b.ok && a.ok && b.weight).toBe(a.ok ? a.weight : NaN);
    const other = buildGraph(randomGrid(mulberry32(10), 5), { metric: 'euclidean' });
    expect(() => new LineFinder(other, { landmarks: table })).toThrow(/different graph/);
  });

  const LARGE = findGpfData('large-network.json');
  it.skipIf(!LARGE)('speed up the large one-way OSM network without changing any weight', () => {
    const network = JSON.parse(readFileSync(LARGE!, 'utf8')) as NetworkCollection<OsmProps>;
    const plain = new LineFinder(network, { weight: (a, b, p) => osmWeight(a, b, p) });
    const alt = new LineFinder(plain.graph, { landmarks: { count: 8 } });
    const { graph } = plain;
    const rand = mulberry32(21);
    let settledPlain = 0;
    let settledAlt = 0;
    let compared = 0;
    for (let i = 0; i < 40; i++) {
      const pick = (): Position => {
        const v = Math.floor(rand() * graph.vertices.count);
        const p = graph.vertices.positions[v];
        return [p[0] + (rand() - 0.5) * 2e-4, p[1] + (rand() - 0.5) * 2e-4];
      };
      const points = [pick(), pick()];
      const a = plain.route(points, { snap: { connectivity: 'nearest' } });
      const b = alt.route(points, { snap: { connectivity: 'nearest' } });
      expect(b.ok).toBe(a.ok);
      if (!a.ok || !b.ok) continue;
      expect(Math.abs(b.weight - a.weight) / Math.max(1, a.weight)).toBeLessThan(1e-9);
      settledPlain += a.legs[0].settled;
      settledAlt += b.legs[0].settled;
      compared++;
    }
    expect(compared).toBeGreaterThan(10);
    expect(settledAlt).toBeLessThan(settledPlain);
  });
});

describe('bidirectional Dijkstra', () => {
  it('matches Dijkstra on one-way grids, with snapped endpoints and in every planner', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const rand = mulberry32(60 + seed);
      const finder = new LineFinder(randomGrid(rand, 9, { oneway: 0.25 }), {
        metric: 'euclidean',
        weight: gridWeight,
      }).registerAlgorithm(bidirectionalDijkstra);
      for (let q = 0; q < 15; q++) {
        const points: Position[] = [0, 1, 2].map(() => [rand() * 80, rand() * 80]);
        const a = finder.route(points, { algorithm: 'dijkstra', snap: { connectivity: 'nearest' } });
        const b = finder.route(points, { algorithm: 'bidijkstra', snap: { connectivity: 'nearest' } });
        expect(b.ok).toBe(a.ok);
        if (a.ok && b.ok) {
          expect(b.weight).toBeCloseTo(a.weight, 9);
          expect(b.distance).toBeCloseTo(a.distance, 9);
        }
        const optimal = { snap: { selection: 'optimal' as const }, algorithm: 'bidijkstra' };
        const oa = finder.route(points, { ...optimal, algorithm: 'dijkstra' });
        const ob = finder.route(points, optimal);
        expect(ob.ok).toBe(oa.ok);
        if (oa.ok && ob.ok) expect(ob.weight).toBeCloseTo(oa.weight, 9);
      }
    }
  });

  it('settles fewer nodes than Dijkstra when there is no heuristic', () => {
    const noEmbedding: Metric = {
      name: 'planar-no-embedding',
      geographic: false,
      embedDims: 0,
      distance: (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]),
    };
    const rand = mulberry32(123);
    const finder = new LineFinder(randomGrid(rand, 40, { oneway: 0, blocked: 0 }), {
      metric: noEmbedding,
      weight: gridWeight,
    }).registerAlgorithm(bidirectionalDijkstra);
    let plain = 0;
    let bi = 0;
    for (let q = 0; q < 30; q++) {
      const points: Position[] = [0, 1].map(() => [rand() * 390, rand() * 390]);
      const a = finder.route(points, { algorithm: 'dijkstra' });
      const b = finder.route(points, { algorithm: 'bidijkstra' });
      if (!a.ok || !b.ok) continue;
      expect(b.weight).toBeCloseTo(a.weight, 9);
      plain += a.legs[0].settled;
      bi += b.legs[0].settled;
    }
    expect(bi).toBeLessThan(plain);
  });
});
