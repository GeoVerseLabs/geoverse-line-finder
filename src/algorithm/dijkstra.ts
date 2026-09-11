import { notFound, reconstructPath } from './scratch';
import type { PathAlgorithm, SearchRequest, SearchResult } from './types';

/**
 * Dijkstra's algorithm with lazy deletion, stopping as soon as the target is settled. Works with any
 * non-negative costs and needs no heuristic, which makes it the reference engine.
 */
export const dijkstra: PathAlgorithm = {
  name: 'dijkstra',
  usesHeuristic: false,
  search({ graph, source, target, scratch }: SearchRequest): SearchResult {
    const stamp = scratch.begin(graph.nodeCount);
    const { g, prevNode, prevEdge, seen, closed, heap } = scratch;
    const { baseNodeCount, offsets, targets, costs, baseEdgeCount } = graph;
    const { overlayCount, overlayFrom, overlayTo, overlayCost } = graph;

    g[source] = 0;
    seen[source] = stamp;
    prevNode[source] = -1;
    prevEdge[source] = -1;
    heap.insert(0, source);
    let settled = 0;
    let relaxed = 0;

    while (heap.size() > 0) {
      const node = heap.extractMin();
      if (closed[node] === stamp) continue;
      closed[node] = stamp;
      settled++;
      if (node === target) break;
      const gn = g[node];

      if (node < baseNodeCount) {
        for (let e = offsets[node], end = offsets[node + 1]; e < end; e++) {
          const to = targets[e];
          const cand = gn + costs[e];
          if (seen[to] === stamp && cand >= g[to]) continue;
          g[to] = cand;
          seen[to] = stamp;
          prevNode[to] = node;
          prevEdge[to] = e;
          heap.insert(cand, to);
          relaxed++;
        }
      }
      for (let k = 0; k < overlayCount; k++) {
        if (overlayFrom[k] !== node) continue;
        const to = overlayTo[k];
        const cand = gn + overlayCost[k];
        if (seen[to] === stamp && cand >= g[to]) continue;
        g[to] = cand;
        seen[to] = stamp;
        prevNode[to] = node;
        prevEdge[to] = baseEdgeCount + k;
        heap.insert(cand, to);
        relaxed++;
      }
    }

    if (closed[target] !== stamp) return notFound(settled, relaxed);
    const { nodes, edges } = reconstructPath(scratch, source, target);
    return { found: true, cost: g[target], nodes, edges, settled, relaxed };
  },
};
