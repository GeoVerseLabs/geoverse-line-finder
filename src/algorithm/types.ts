import type { SearchScratch } from './scratch';

/**
 * What an engine searches over: the immutable base graph in CSR form plus a small per-query overlay
 * (virtual nodes for waypoints and candidates that sit between nodes, and their edges).
 *
 * Node ids `< baseNodeCount` are base nodes and have CSR adjacency; ids `≥ baseNodeCount` are virtual.
 * Edge ids `< baseEdgeCount` index the CSR arrays; overlay edge `k` has id `baseEdgeCount + k`.
 * An engine must consider, for every expanded node, its CSR edges (when it is a base node) **and** every
 * overlay edge whose `overlayFrom` equals it — either by scanning all overlay edges or through the optional
 * `overlayFirst` / `overlayNext` adjacency, which lists the same edges in the same ascending order.
 */
export interface SearchGraph {
  readonly baseNodeCount: number;
  /** Base plus virtual nodes: the size engines must allocate state for. */
  readonly nodeCount: number;
  readonly offsets: Int32Array;
  readonly targets: Int32Array;
  readonly costs: Float64Array;
  readonly baseEdgeCount: number;
  readonly overlayCount: number;
  readonly overlayFrom: Int32Array;
  readonly overlayTo: Int32Array;
  readonly overlayCost: Float64Array;
  /** First overlay edge leaving `node`, or `-1` (optional, 0.2.0). Continue with `overlayNext[k]`. */
  overlayFirst?(node: number): number;
  /** Next overlay edge with the same `overlayFrom`, or `-1` (present whenever `overlayFirst` is). */
  readonly overlayNext?: Int32Array;
  /**
   * Optional reverse CSR of the base graph (0.2.0): edges ending at node `n` are entries
   * `[reverseOffsets[n], reverseOffsets[n + 1])` with their source node, cost and forward edge id.
   */
  readonly reverseOffsets?: Int32Array;
  readonly reverseSources?: Int32Array;
  readonly reverseCosts?: Float64Array;
  readonly reverseEdgeIds?: Int32Array;
}

/**
 * Lower bound of the remaining cost from `node` to the query target(s). `Infinity` means the target cannot
 * be reached from `node`; engines may drop such nodes.
 */
export type Heuristic = (node: number) => number;

export interface SearchRequest {
  graph: SearchGraph;
  source: number;
  /** Target node; ignored when `targets` is given. */
  target: number;
  /** Provided when the engine declares `usesHeuristic` and the graph supports one; otherwise `null`. */
  heuristic: Heuristic | null;
  /** Reusable per-finder buffers (see {@link SearchScratch}). */
  scratch: SearchScratch;
  /**
   * Several targets at once (engines declaring `capabilities.multiTarget`): the search runs until all of
   * them are settled and reports each in `targetPaths`. The heuristic is then a bound to the nearest one.
   */
  targets?: ArrayLike<number>;
  /** Paths costlier than this are not needed (engines declaring `capabilities.budget`). */
  maxCost?: number;
  /** Give up after settling this many nodes; the result then carries `budgetExceeded: true`. */
  maxSettled?: number;
}

export interface TargetPath {
  cost: number;
  nodes: number[];
  edges: number[];
}

export interface SearchResult {
  found: boolean;
  /** Total cost of the path; `Infinity` when not found. With `targets`: the cheapest target reached. */
  cost: number;
  /** Nodes from source to target inclusive; empty when not found. */
  nodes: number[];
  /** Edge ids between consecutive nodes (`nodes.length - 1` of them). */
  edges: number[];
  /** Nodes expanded (popped with a final label). */
  settled: number;
  /** Successful edge relaxations. */
  relaxed: number;
  /** With `targets`: one entry per requested target, in order; `null` when it was not reached. */
  targetPaths?: (TargetPath | null)[];
  /** `true` when the search stopped at `maxSettled` rather than by exhausting or reaching its targets. */
  budgetExceeded?: boolean;
}

/** Optional request fields an engine understands. Without them the library emulates or ignores them. */
export interface AlgorithmCapabilities {
  /** Honours `SearchRequest.targets` (otherwise the library runs one search per target). */
  readonly multiTarget?: boolean;
  /** Honours `maxCost` and `maxSettled` (otherwise they are ignored). */
  readonly budget?: boolean;
}

/**
 * A shortest-path engine. Register custom engines (bidirectional Dijkstra, ALT, contraction hierarchies…)
 * with an {@link AlgorithmRegistry} and select them by name per query.
 */
export interface PathAlgorithm {
  readonly name: string;
  /** Whether the engine consumes `SearchRequest.heuristic`. */
  readonly usesHeuristic: boolean;
  readonly capabilities?: AlgorithmCapabilities;
  search(request: SearchRequest): SearchResult;
}
