import { notFound, reconstructPath } from './scratch';
import type { Heuristic, SearchRequest, SearchResult, TargetPath } from './types';

/** Below this many overlay edges a plain scan beats the adjacency lists. Both visit edges in the same order. */
const OVERLAY_SCAN_LIMIT = 8;

/**
 * The shared label-setting core of the built-in engines: A* with `heuristic`, Dijkstra without.
 *
 * - Lazy deletion; ties in the heap break by insertion order, so results are stable.
 * - A closed node is re-opened if a (merely admissible) heuristic ever finds it a cheaper label, so
 *   optimality never depends on consistency. With a zero heuristic this branch cannot trigger.
 * - Nodes with an infinite estimate cannot reach the target and are never queued.
 * - Multi-target (`targets`): runs until every target is settled; `maxCost` stops once the smallest key
 *   exceeds it (keys are lower bounds of complete path costs); `maxSettled` caps the work.
 */
export function bestFirstSearch(request: SearchRequest, heuristic: Heuristic | null): SearchResult {
  const { graph, source, scratch } = request;
  const h = heuristic;
  const stamp = scratch.begin(graph.nodeCount);
  const { g, prevNode, prevEdge, seen, closed, targetMark, heap } = scratch;
  const { baseNodeCount, offsets, targets, costs, baseEdgeCount } = graph;
  const { overlayCount, overlayFrom, overlayTo, overlayCost } = graph;
  const next = overlayCount > OVERLAY_SCAN_LIMIT && graph.overlayFirst ? graph.overlayNext : undefined;
  const maxCost = request.maxCost ?? Infinity;
  const maxSettled = request.maxSettled ?? Infinity;
  const multi = request.targets;
  const target = multi ? -1 : request.target;

  let remaining = 1;
  if (multi) {
    remaining = 0;
    for (let i = 0; i < multi.length; i++) {
      const t = multi[i];
      if (targetMark[t] !== stamp) {
        targetMark[t] = stamp;
        remaining++;
      }
    }
  }

  g[source] = 0;
  seen[source] = stamp;
  prevNode[source] = -1;
  prevEdge[source] = -1;
  let settled = 0;
  let relaxed = 0;
  let budgetExceeded = false;
  const h0 = h ? h(source) : 0;
  if (h0 < Infinity && h0 <= maxCost && remaining > 0) heap.insert(h0, source);

  while (heap.size() > 0) {
    if (maxCost < Infinity && heap.peekMinKey() > maxCost) break;
    const node = heap.extractMin();
    if (closed[node] === stamp) continue;
    if (settled >= maxSettled) {
      budgetExceeded = true;
      break;
    }
    closed[node] = stamp;
    settled++;
    if (multi) {
      if (targetMark[node] === stamp) {
        targetMark[node] = 0;
        if (--remaining === 0) break;
      }
    } else if (node === target) {
      break;
    }
    const gn = g[node];

    if (node < baseNodeCount) {
      for (let e = offsets[node], end = offsets[node + 1]; e < end; e++) {
        const to = targets[e];
        const cand = gn + costs[e];
        if (seen[to] === stamp && cand >= g[to]) continue;
        let key = cand;
        if (h) {
          const estimate = h(to);
          if (estimate === Infinity) continue;
          key += estimate;
        }
        if (key > maxCost) continue;
        if (closed[to] === stamp) closed[to] = 0;
        g[to] = cand;
        seen[to] = stamp;
        prevNode[to] = node;
        prevEdge[to] = e;
        heap.insert(key, to);
        relaxed++;
      }
    }
    if (next) {
      for (let k = graph.overlayFirst!(node); k !== -1; k = next[k]) {
        const to = overlayTo[k];
        const cand = gn + overlayCost[k];
        if (seen[to] === stamp && cand >= g[to]) continue;
        let key = cand;
        if (h) {
          const estimate = h(to);
          if (estimate === Infinity) continue;
          key += estimate;
        }
        if (key > maxCost) continue;
        if (closed[to] === stamp) closed[to] = 0;
        g[to] = cand;
        seen[to] = stamp;
        prevNode[to] = node;
        prevEdge[to] = baseEdgeCount + k;
        heap.insert(key, to);
        relaxed++;
      }
    } else {
      for (let k = 0; k < overlayCount; k++) {
        if (overlayFrom[k] !== node) continue;
        const to = overlayTo[k];
        const cand = gn + overlayCost[k];
        if (seen[to] === stamp && cand >= g[to]) continue;
        let key = cand;
        if (h) {
          const estimate = h(to);
          if (estimate === Infinity) continue;
          key += estimate;
        }
        if (key > maxCost) continue;
        if (closed[to] === stamp) closed[to] = 0;
        g[to] = cand;
        seen[to] = stamp;
        prevNode[to] = node;
        prevEdge[to] = baseEdgeCount + k;
        heap.insert(key, to);
        relaxed++;
      }
    }
  }

  if (multi) {
    const targetPaths: (TargetPath | null)[] = [];
    let best: TargetPath | null = null;
    for (let i = 0; i < multi.length; i++) {
      const t = multi[i];
      if (closed[t] !== stamp) {
        targetPaths.push(null);
        continue;
      }
      const { nodes, edges } = reconstructPath(scratch, source, t);
      const path: TargetPath = { cost: g[t], nodes, edges };
      targetPaths.push(path);
      if (!best || path.cost < best.cost) best = path;
    }
    const base = best
      ? { found: true, cost: best.cost, nodes: best.nodes, edges: best.edges, settled, relaxed }
      : notFound(settled, relaxed);
    return budgetExceeded ? { ...base, targetPaths, budgetExceeded } : { ...base, targetPaths };
  }
  if (closed[target] !== stamp) {
    return budgetExceeded ? { ...notFound(settled, relaxed), budgetExceeded } : notFound(settled, relaxed);
  }
  const { nodes, edges } = reconstructPath(scratch, source, target);
  return { found: true, cost: g[target], nodes, edges, settled, relaxed };
}
