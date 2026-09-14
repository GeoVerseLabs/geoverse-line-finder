import { FourAryHeap } from '../heap/four-ary-heap';
import { bestFirstSearch } from './best-first';
import { notFound, type SearchScratch } from './scratch';
import type { PathAlgorithm, SearchRequest, SearchResult } from './types';

interface BackwardState {
  g: Float64Array;
  prevNode: Int32Array;
  prevEdge: Int32Array;
  seen: Uint32Array;
  closed: Uint32Array;
  heap: FourAryHeap;
  stamp: number;
}

const states = new WeakMap<SearchScratch, BackwardState>();

function backwardState(scratch: SearchScratch): BackwardState {
  const size = scratch.g.length;
  let state = states.get(scratch);
  if (!state || state.g.length !== size || scratch.stamp < state.stamp) {
    state = {
      g: new Float64Array(size),
      prevNode: new Int32Array(size),
      prevEdge: new Int32Array(size),
      seen: new Uint32Array(size),
      closed: new Uint32Array(size),
      heap: state?.heap ?? new FourAryHeap(),
      stamp: 0,
    };
    states.set(scratch, state);
  }
  state.stamp = scratch.stamp;
  state.heap.clear();
  return state;
}

/**
 * Bidirectional Dijkstra: searches forward from the source and backward from the target and stops once the
 * two frontiers cannot improve the best meeting point. Useful when no heuristic is available (hop counts,
 * custom metrics without an embedding). Needs the graph's reverse adjacency; multi-target requests and
 * graphs without it fall back to plain Dijkstra.
 */
export const bidirectionalDijkstra: PathAlgorithm = {
  name: 'bidijkstra',
  usesHeuristic: false,
  capabilities: { multiTarget: true, budget: true },
  search(request: SearchRequest): SearchResult {
    const { graph, source, target, scratch } = request;
    if (request.targets || request.maxCost !== undefined || !graph.reverseOffsets) {
      return bestFirstSearch(request, null);
    }
    const stamp = scratch.begin(graph.nodeCount);
    if (source === target)
      return { found: true, cost: 0, nodes: [source], edges: [], settled: 1, relaxed: 0 };
    const back = backwardState(scratch);
    const { g, prevNode, prevEdge, seen, closed, heap } = scratch;
    const { baseNodeCount, offsets, targets, costs, baseEdgeCount } = graph;
    const { overlayCount, overlayFrom, overlayTo, overlayCost } = graph;
    const rOffsets = graph.reverseOffsets;
    const rSources = graph.reverseSources!;
    const rCosts = graph.reverseCosts!;
    const rEdges = graph.reverseEdgeIds!;
    const maxSettled = request.maxSettled ?? Infinity;

    g[source] = 0;
    seen[source] = stamp;
    prevNode[source] = -1;
    prevEdge[source] = -1;
    heap.insert(0, source);
    back.g[target] = 0;
    back.seen[target] = stamp;
    back.prevNode[target] = -1;
    back.prevEdge[target] = -1;
    back.heap.insert(0, target);

    let best = Infinity;
    let meet = -1;
    let settled = 0;
    let relaxed = 0;
    let budgetExceeded = false;

    while (heap.size() > 0 || back.heap.size() > 0) {
      const kf = heap.peekMinKey();
      const kb = back.heap.peekMinKey();
      if (kf + kb >= best) break;
      if (settled >= maxSettled) {
        budgetExceeded = true;
        break;
      }
      if (kf <= kb) {
        const node = heap.extractMin();
        if (closed[node] === stamp) continue;
        closed[node] = stamp;
        settled++;
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
            if (back.seen[to] === stamp && cand + back.g[to] < best) {
              best = cand + back.g[to];
              meet = to;
            }
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
          if (back.seen[to] === stamp && cand + back.g[to] < best) {
            best = cand + back.g[to];
            meet = to;
          }
        }
        if (back.seen[node] === stamp && gn + back.g[node] < best) {
          best = gn + back.g[node];
          meet = node;
        }
      } else {
        const node = back.heap.extractMin();
        if (back.closed[node] === stamp) continue;
        back.closed[node] = stamp;
        settled++;
        const gn = back.g[node];
        const bg = back.g;
        const bseen = back.seen;
        if (node < baseNodeCount) {
          for (let k = rOffsets[node], end = rOffsets[node + 1]; k < end; k++) {
            const from = rSources[k];
            const cand = gn + rCosts[k];
            if (bseen[from] === stamp && cand >= bg[from]) continue;
            bg[from] = cand;
            bseen[from] = stamp;
            back.prevNode[from] = node;
            back.prevEdge[from] = rEdges[k];
            back.heap.insert(cand, from);
            relaxed++;
            if (seen[from] === stamp && cand + g[from] < best) {
              best = cand + g[from];
              meet = from;
            }
          }
        }
        for (let k = 0; k < overlayCount; k++) {
          if (overlayTo[k] !== node) continue;
          const from = overlayFrom[k];
          const cand = gn + overlayCost[k];
          if (bseen[from] === stamp && cand >= bg[from]) continue;
          bg[from] = cand;
          bseen[from] = stamp;
          back.prevNode[from] = node;
          back.prevEdge[from] = baseEdgeCount + k;
          back.heap.insert(cand, from);
          relaxed++;
          if (seen[from] === stamp && cand + g[from] < best) {
            best = cand + g[from];
            meet = from;
          }
        }
      }
    }

    if (meet < 0)
      return budgetExceeded ? { ...notFound(settled, relaxed), budgetExceeded } : notFound(settled, relaxed);
    const nodes: number[] = [];
    const edges: number[] = [];
    for (let v = meet; v !== source; v = prevNode[v]) {
      nodes.push(v);
      edges.push(prevEdge[v]);
    }
    nodes.push(source);
    nodes.reverse();
    edges.reverse();
    for (let v = meet; v !== target;) {
      edges.push(back.prevEdge[v]);
      v = back.prevNode[v];
      nodes.push(v);
    }
    return { found: true, cost: best, nodes, edges, settled, relaxed };
  },
};
