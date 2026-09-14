import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src';
import { strongComponents } from '../src/graph/scc';
import { fc, gridWeight, line, mulberry32, randomGrid } from './helpers';

function reachable(n: number, offsets: Int32Array, targets: Int32Array, from: number): Uint8Array {
  const seen = new Uint8Array(n);
  const stack = [from];
  seen[from] = 1;
  while (stack.length) {
    const u = stack.pop()!;
    for (let e = offsets[u]; e < offsets[u + 1]; e++) {
      if (!seen[targets[e]]) {
        seen[targets[e]] = 1;
        stack.push(targets[e]);
      }
    }
  }
  return seen;
}

describe('strongly connected components', () => {
  for (let seed = 1; seed <= 6; seed++) {
    it(`match mutual reachability (random one-way grid #${seed})`, () => {
      const graph = buildGraph(randomGrid(mulberry32(seed), 7, { oneway: 0.4 }), {
        metric: 'euclidean',
        weight: gridWeight,
      });
      const N = graph.nodes.count;
      const { offsets, targets } = graph.edges;
      const scc = graph.strongComponents();
      const reach = Array.from({ length: N }, (_v, u) => reachable(N, offsets, targets, u));
      for (let u = 0; u < N; u++) {
        for (let v = 0; v < N; v++) {
          expect(scc.node[u] === scc.node[v]).toBe(reach[u][v] === 1 && reach[v][u] === 1);
        }
      }
      expect(scc.size.reduce((a, b) => a + b, 0)).toBe(N);
    });
  }

  it('is iterative: a 200 000-node one-way path does not overflow the stack', () => {
    const n = 200_000;
    const offsets = new Int32Array(n + 1);
    const targets = new Int32Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      offsets[i + 1] = i + 1;
      targets[i] = i + 1;
    }
    offsets[n] = n - 1;
    const scc = strongComponents(n, offsets, targets);
    expect(scc.count).toBe(n);
    const cycle = targets.slice();
    const closed = new Int32Array(n);
    closed.set(cycle);
    closed[n - 1] = 0;
    const ringOffsets = new Int32Array(n + 1);
    for (let i = 0; i <= n; i++) ringOffsets[i] = i;
    expect(strongComponents(n, ringOffsets, closed).count).toBe(1);
  });

  it('reverse edges mirror the forward adjacency', () => {
    const graph = buildGraph(
      fc([
        line([
          [0, 0],
          [1, 0],
          [2, 0],
        ]),
        line([
          [1, 0],
          [1, 1],
        ]),
      ]),
      { metric: 'euclidean' },
    );
    const reverse = graph.reverseEdges();
    const { offsets, targets } = graph.edges;
    let count = 0;
    for (let u = 0; u < graph.nodes.count; u++) {
      for (let e = offsets[u]; e < offsets[u + 1]; e++) {
        const v = targets[e];
        let found = false;
        for (let k = reverse.offsets[v]; k < reverse.offsets[v + 1]; k++) {
          if (reverse.sources[k] === u && reverse.edges[k] === e) found = true;
        }
        expect(found).toBe(true);
        count++;
      }
    }
    expect(reverse.sources.length).toBe(count);
  });
});
