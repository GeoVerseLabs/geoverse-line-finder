import type { SearchScratch } from '../algorithm/scratch';
import type { Heuristic, PathAlgorithm, SearchRequest, SearchResult, TargetPath } from '../algorithm/types';
import type { RoutingGraph } from '../graph/graph';
import { sameAnchor, type SnapCandidate } from '../snap/snap';
import { edgePiece, partialCost, type ChainPiece } from './assemble';
import type { QueryGraph } from './query-graph';

/** Everything a planner needs to run searches for one query. */
export interface RouteContext<P = unknown> {
  readonly graph: RoutingGraph<P>;
  readonly query: QueryGraph;
  readonly scratch: SearchScratch;
  readonly algorithm: PathAlgorithm;
  /** Admissible bound to the nearest goal (`null` when unavailable or not wanted). */
  readonly heuristicFor: (
    goals: readonly SnapCandidate[],
    origins: readonly SnapCandidate[],
  ) => Heuristic | null;
  readonly maxCost: number;
  readonly maxSettled: number;
}

/**
 * Runs one search on the query graph. Multi-target requests are emulated with one search per target for
 * engines without that capability; budgets are only passed to engines that declare them.
 */
export function runSearch(
  ctx: RouteContext<unknown>,
  source: number,
  target: number,
  targets: readonly number[] | null,
  goals: readonly SnapCandidate[],
  maxCost: number,
  origins: readonly SnapCandidate[] = [],
): SearchResult {
  const { algorithm } = ctx;
  const capabilities = algorithm.capabilities;
  const request: SearchRequest = {
    graph: ctx.query,
    source,
    target,
    heuristic: algorithm.usesHeuristic ? ctx.heuristicFor(goals, origins) : null,
    scratch: ctx.scratch,
  };
  if (capabilities?.budget) {
    if (maxCost < Infinity) request.maxCost = maxCost;
    if (ctx.maxSettled < Infinity) request.maxSettled = ctx.maxSettled;
  }
  if (!targets) return algorithm.search(request);
  if (capabilities?.multiTarget) {
    request.targets = targets;
    return algorithm.search(request);
  }
  const targetPaths: (TargetPath | null)[] = [];
  let settled = 0;
  let relaxed = 0;
  let budgetExceeded = false;
  let best: TargetPath | null = null;
  for (const t of targets) {
    const r = algorithm.search({ ...request, target: t });
    settled += r.settled;
    relaxed += r.relaxed;
    budgetExceeded ||= r.budgetExceeded === true;
    const path = r.found ? { cost: r.cost, nodes: r.nodes, edges: r.edges } : null;
    targetPaths.push(path);
    if (path && (!best || path.cost < best.cost)) best = path;
  }
  return {
    found: best !== null,
    cost: best ? best.cost : Infinity,
    nodes: best ? best.nodes : [],
    edges: best ? best.edges : [],
    settled,
    relaxed,
    targetPaths,
    budgetExceeded,
  };
}

/** Edges from a virtual node to both ends of the chain it sits on. */
export function linkFrom(ctx: RouteContext<unknown>, virtual: number, chain: number, position: number): void {
  const { graph, query: q } = ctx;
  const n = graph.segmentCountOf(chain);
  q.add(virtual, graph.chains.from[chain], chain, position, 0, partialCost(graph, chain, position, 0));
  q.add(virtual, graph.chains.to[chain], chain, position, n, partialCost(graph, chain, position, n));
}

/** Edges from both ends of a chain to a virtual node sitting on it. */
export function linkTo(ctx: RouteContext<unknown>, virtual: number, chain: number, position: number): void {
  const { graph, query: q } = ctx;
  const n = graph.segmentCountOf(chain);
  q.add(graph.chains.from[chain], virtual, chain, 0, position, partialCost(graph, chain, 0, position));
  q.add(graph.chains.to[chain], virtual, chain, n, position, partialCost(graph, chain, n, position));
}

/** Pieces and summed cost of a search path's edges, starting at edge index `first`. */
export function pathPieces(
  ctx: RouteContext<unknown>,
  edges: readonly number[],
  first: number,
): { pieces: ChainPiece[]; weight: number } {
  const { graph, query: q } = ctx;
  const base = q.baseEdgeCount;
  const pieces: ChainPiece[] = [];
  let weight = 0;
  for (let i = first; i < edges.length; i++) {
    const e = edges[i];
    if (e < base) {
      weight += graph.edges.costs[e];
      pieces.push(edgePiece(graph, e));
    } else {
      weight += q.overlayCost[e - base];
      const piece = q.piece(e - base);
      if (piece) pieces.push(piece);
    }
  }
  return { pieces, weight };
}

/** Cheap reject: can the source's reachable nodes and the target's feeding nodes share a component? */
export function mayConnect(ctx: RouteContext<unknown>, source: number, target: number): boolean {
  const q = ctx.query;
  const N = ctx.graph.nodes.count;
  const component = ctx.graph.nodes.component;
  const from: number[] = [];
  const to: number[] = [];
  if (source < N) from.push(component[source]);
  if (target < N) to.push(component[target]);
  for (let k = 0; k < q.overlayCount; k++) {
    const a = q.overlayFrom[k];
    const b = q.overlayTo[k];
    if (a === source && b === target) return true;
    if (a === source && b < N) from.push(component[b]);
    if (b === target && a < N) to.push(component[a]);
  }
  return from.some((c) => to.includes(c));
}

export type PairOutcome =
  | { ok: true; pieces: ChainPiece[]; weight: number; settled: number; relaxed: number }
  | { ok: false; reason: 'UNREACHABLE' | 'BUDGET_EXCEEDED'; beyondMaxCost: boolean };

/** Shortest path between two snapped locations. */
export function solvePair(ctx: RouteContext<unknown>, a: SnapCandidate, b: SnapCandidate): PairOutcome {
  if (sameAnchor(a.anchor, b.anchor)) return { ok: true, pieces: [], weight: 0, settled: 0, relaxed: 0 };
  const { graph, query: q } = ctx;
  q.reset();

  let source: number;
  if (a.anchor.kind === 'node') {
    source = a.anchor.node;
  } else {
    source = q.virtualSource;
    linkFrom(ctx, source, a.anchor.chain, a.anchor.position);
  }
  let target: number;
  if (b.anchor.kind === 'node') {
    target = b.anchor.node;
  } else {
    target = q.virtualTarget;
    const { chain, position } = b.anchor;
    linkTo(ctx, target, chain, position);
    if (a.anchor.kind === 'chain' && a.anchor.chain === chain) {
      const start = a.anchor.position;
      q.add(source, target, chain, start, position, partialCost(graph, chain, start, position));
    }
  }

  const beyondMaxCost = ctx.maxCost < Infinity;
  if (!mayConnect(ctx, source, target)) return { ok: false, reason: 'UNREACHABLE', beyondMaxCost: false };
  const result = runSearch(ctx, source, target, null, [b], ctx.maxCost, [a]);
  if (!result.found || result.cost > ctx.maxCost) {
    return result.budgetExceeded
      ? { ok: false, reason: 'BUDGET_EXCEEDED', beyondMaxCost: false }
      : { ok: false, reason: 'UNREACHABLE', beyondMaxCost };
  }
  const { pieces } = pathPieces(ctx, result.edges, 0);
  return { ok: true, pieces, weight: result.cost, settled: result.settled, relaxed: result.relaxed };
}
