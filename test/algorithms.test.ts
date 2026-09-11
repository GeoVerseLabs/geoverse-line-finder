import { describe, expect, it } from 'vitest';
import {
  AlgorithmRegistry,
  LineFinder,
  astar,
  createAlgorithmRegistry,
  dijkstra,
  type Heap,
  type PathAlgorithm,
  type Position,
} from '../src';
import { ReferenceGraph, gridWeight, mulberry32, randomGrid } from './helpers';

function pathCost(ref: ReferenceGraph<unknown>, path: Position[]): number {
  let total = 0;
  for (let i = 0; i + 1 < path.length; i++) total += ref.edgeCost(path[i], path[i + 1]);
  return total;
}

describe('engines agree with a naive reference on random networks', () => {
  for (let seed = 1; seed <= 12; seed++) {
    it(`random grid #${seed} (weights, one-ways, closures; compact and flat graphs)`, () => {
      const rand = mulberry32(seed);
      const network = randomGrid(rand, 9);
      const ref = new ReferenceGraph(network, gridWeight);
      const compact = new LineFinder(network, { metric: 'euclidean', weight: gridWeight });
      const flat = new LineFinder(network, { metric: 'euclidean', weight: gridWeight, compact: false });
      const vertices = ref
        .vertices()
        .filter((v) => compact.graph.isLiveVertex(compact.graph.findVertex(v[0], v[1])));
      let found = 0;
      for (let q = 0; q < 30; q++) {
        const a = vertices[Math.floor(rand() * vertices.length)];
        const b = vertices[Math.floor(rand() * vertices.length)];
        const expected = ref.shortest(a, b);
        for (const finder of [compact, flat]) {
          for (const algorithm of ['dijkstra', 'astar']) {
            const r = finder.route([a, b], { algorithm, snap: { mode: 'exact' } });
            if (expected === Infinity) {
              expect(r.ok, `${algorithm} ${a}→${b} should fail`).toBe(false);
              continue;
            }
            expect(r.ok, `${algorithm} ${a}→${b}`).toBe(true);
            if (!r.ok) continue;
            expect(r.weight).toBeCloseTo(expected, 6);
            expect(pathCost(ref, r.path)).toBeCloseTo(expected, 6);
            expect(r.path[0]).toEqual(a);
            expect(r.path[r.path.length - 1]).toEqual(b);
          }
        }
        if (expected < Infinity) found++;
      }
      expect(found).toBeGreaterThan(5);
    });
  }

  it('A* settles fewer nodes than Dijkstra for the same optimal costs', () => {
    const rand = mulberry32(99);
    const network = randomGrid(rand, 30, { oneway: 0.05, blocked: 0 });
    const finder = new LineFinder(network, { metric: 'euclidean', weight: gridWeight });
    const vertices = new ReferenceGraph(network, gridWeight).vertices();
    let settledA = 0;
    let settledD = 0;
    for (let q = 0; q < 40; q++) {
      const pair = [
        vertices[Math.floor(rand() * vertices.length)],
        vertices[Math.floor(rand() * vertices.length)],
      ];
      const d = finder.route(pair, { algorithm: 'dijkstra', snap: { mode: 'exact' } });
      const a = finder.route(pair, { algorithm: 'astar', snap: { mode: 'exact' } });
      expect(a.ok).toBe(d.ok);
      if (!a.ok || !d.ok) continue;
      expect(a.weight).toBeCloseTo(d.weight, 9);
      settledA += a.legs[0].settled;
      settledD += d.legs[0].settled;
    }
    expect(settledA).toBeLessThan(settledD);
  });
});

describe('AlgorithmRegistry', () => {
  it('holds the built-ins and resolves names or objects', () => {
    const registry = createAlgorithmRegistry();
    expect(registry.names()).toEqual(['dijkstra', 'astar']);
    expect(registry.resolve('astar')).toBe(astar);
    expect(registry.resolve(dijkstra)).toBe(dijkstra);
    expect(() => registry.resolve('nope')).toThrow(/Unknown algorithm "nope"/);
  });

  it('guards against accidental overrides and malformed engines', () => {
    const registry = new AlgorithmRegistry([dijkstra]);
    expect(() => registry.register(dijkstra)).toThrow(/already registered/);
    const custom = { ...dijkstra };
    expect(registry.register(custom, { replace: true }).get('dijkstra')).toBe(custom);
    expect(() => registry.register({ name: '', usesHeuristic: false } as unknown as PathAlgorithm)).toThrow(
      TypeError,
    );
    expect(registry.unregister('dijkstra')).toBe(true);
    expect(registry.has('dijkstra')).toBe(false);
  });

  it('rejects an unknown default algorithm at construction time', () => {
    expect(
      () => new LineFinder(randomGrid(mulberry32(1), 3), { metric: 'euclidean', algorithm: 'nope' }),
    ).toThrow(/Unknown algorithm/);
  });
});

/** Engine written only against the public SearchGraph contract — proves the extension point is sufficient. */
const bellmanFord: PathAlgorithm = {
  name: 'bellman-ford',
  usesHeuristic: false,
  search({ graph, source, target }) {
    const n = graph.nodeCount;
    const dist = new Float64Array(n).fill(Infinity);
    const prevNode = new Int32Array(n).fill(-1);
    const prevEdge = new Int32Array(n).fill(-1);
    dist[source] = 0;
    let relaxed = 0;
    const relax = (u: number, v: number, cost: number, edge: number) => {
      if (dist[u] + cost < dist[v]) {
        dist[v] = dist[u] + cost;
        prevNode[v] = u;
        prevEdge[v] = edge;
        relaxed++;
        return true;
      }
      return false;
    };
    for (let round = 0; round < n; round++) {
      let changed = false;
      for (let u = 0; u < n; u++) {
        if (dist[u] === Infinity) continue;
        if (u < graph.baseNodeCount) {
          for (let e = graph.offsets[u]; e < graph.offsets[u + 1]; e++)
            changed = relax(u, graph.targets[e], graph.costs[e], e) || changed;
        }
        for (let k = 0; k < graph.overlayCount; k++) {
          if (graph.overlayFrom[k] === u)
            changed = relax(u, graph.overlayTo[k], graph.overlayCost[k], graph.baseEdgeCount + k) || changed;
        }
      }
      if (!changed) break;
    }
    if (dist[target] === Infinity)
      return { found: false, cost: Infinity, nodes: [], edges: [], settled: 0, relaxed };
    const nodes = [target];
    const edges: number[] = [];
    for (let v = target; v !== source; v = prevNode[v]) {
      edges.unshift(prevEdge[v]);
      nodes.unshift(prevNode[v]);
    }
    return { found: true, cost: dist[target], nodes, edges, settled: n, relaxed };
  },
};

class BinaryHeap implements Heap {
  private items: [number, number, number][] = [];
  private seq = 0;
  insert(key: number, value: number) {
    this.items.push([key, this.seq++, value]);
    this.items.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  extractMin() {
    return this.items.length ? this.items.shift()![2] : -1;
  }
  peekMinKey() {
    return this.items.length ? this.items[0][0] : Infinity;
  }
  size() {
    return this.items.length;
  }
  clear() {
    this.items = [];
    this.seq = 0;
  }
}

describe('pluggable engines and heaps', () => {
  const rand = mulberry32(2024);
  const network = randomGrid(rand, 7);
  const points: Position[] = [];
  for (let i = 0; i < 12; i++) points.push([rand() * 60, rand() * 60]);

  it('a custom engine registered on a finder matches the built-ins, including snapped endpoints', () => {
    const finder = new LineFinder(network, { metric: 'euclidean', weight: gridWeight }).registerAlgorithm(
      bellmanFord,
    );
    for (let i = 0; i + 1 < points.length; i++) {
      const pair = [points[i], points[i + 1]];
      const reference = finder.route(pair, { algorithm: 'dijkstra' });
      const custom = finder.route(pair, { algorithm: 'bellman-ford' });
      const inline = finder.route(pair, { algorithm: bellmanFord });
      expect(custom.ok).toBe(reference.ok);
      expect(inline.ok).toBe(reference.ok);
      if (reference.ok && custom.ok && inline.ok) {
        expect(custom.weight).toBeCloseTo(reference.weight, 9);
        expect(custom.distance).toBeCloseTo(reference.distance, 9);
        expect(custom.algorithm).toBe('bellman-ford');
      }
    }
  });

  it('a custom heap gives identical results', () => {
    const standard = new LineFinder(network, { metric: 'euclidean', weight: gridWeight });
    const custom = new LineFinder(standard.graph, { heap: BinaryHeap });
    for (let i = 0; i + 1 < points.length; i++) {
      const a = standard.route([points[i], points[i + 1]]);
      const b = custom.route([points[i], points[i + 1]]);
      expect(b.ok).toBe(a.ok);
      if (a.ok && b.ok) {
        expect(b.weight).toBeCloseTo(a.weight, 9);
        expect(b.path).toEqual(a.path);
      }
    }
  });
});
