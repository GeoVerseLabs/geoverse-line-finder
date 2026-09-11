import { notFound, reconstructPath } from './scratch';
import type { PathAlgorithm, SearchRequest, SearchResult } from './types';

const zero = (): number => 0;

/**
 * A* search. With the built-in heuristic (metric embedding × minimum cost-per-length, see
 * `graph/build.ts`) it is admissible and consistent for **any** weight function, so it returns the same
 * optimal cost as Dijkstra while settling far fewer nodes. Closed nodes are re-opened if a custom,
 * merely admissible heuristic ever finds them a cheaper label, so optimality never depends on
 * consistency. Without a heuristic it degenerates to Dijkstra.
 */
export const astar: PathAlgorithm = {
  name: 'astar',
  usesHeuristic: true,
  search({ graph, source, target, heuristic, scratch }: SearchRequest): SearchResult {
    const h = heuristic ?? zero;
    const stamp = scratch.begin(graph.nodeCount);
    const { g, prevNode, prevEdge, seen, closed, heap } = scratch;
    const { baseNodeCount, offsets, targets, costs, baseEdgeCount } = graph;
    const { overlayCount, overlayFrom, overlayTo, overlayCost } = graph;

    g[source] = 0;
    seen[source] = stamp;
    prevNode[source] = -1;
    prevEdge[source] = -1;
    heap.insert(h(source), source);
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
          if (closed[to] === stamp) closed[to] = 0;
          g[to] = cand;
          seen[to] = stamp;
          prevNode[to] = node;
          prevEdge[to] = e;
          heap.insert(cand + h(to), to);
          relaxed++;
        }
      }
      for (let k = 0; k < overlayCount; k++) {
        if (overlayFrom[k] !== node) continue;
        const to = overlayTo[k];
        const cand = gn + overlayCost[k];
        if (seen[to] === stamp && cand >= g[to]) continue;
        if (closed[to] === stamp) closed[to] = 0;
        g[to] = cand;
        seen[to] = stamp;
        prevNode[to] = node;
        prevEdge[to] = baseEdgeCount + k;
        heap.insert(cand + h(to), to);
        relaxed++;
      }
    }

    if (closed[target] !== stamp) return notFound(settled, relaxed);
    const { nodes, edges } = reconstructPath(scratch, source, target);
    return { found: true, cost: g[target], nodes, edges, settled, relaxed };
  },
};
