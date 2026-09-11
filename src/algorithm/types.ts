import type { SearchScratch } from './scratch';

/**
 * What an engine searches over: the immutable base graph in CSR form plus a tiny per-query overlay
 * (virtual source/target nodes for waypoints that snap between nodes, and their edges).
 *
 * Node ids `< baseNodeCount` are base nodes and have CSR adjacency; ids `≥ baseNodeCount` are virtual.
 * Edge ids `< baseEdgeCount` index the CSR arrays; overlay edge `k` has id `baseEdgeCount + k`.
 * An engine must consider, for every expanded node, its CSR edges (when it is a base node) **and** every
 * overlay edge whose `overlayFrom` equals it.
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
}

/** Admissible estimate of the remaining cost from `node` to the query target. */
export type Heuristic = (node: number) => number;

export interface SearchRequest {
  graph: SearchGraph;
  source: number;
  target: number;
  /** Provided when the engine declares `usesHeuristic` and the graph supports one; otherwise `null`. */
  heuristic: Heuristic | null;
  /** Reusable per-finder buffers (see {@link SearchScratch}). */
  scratch: SearchScratch;
}

export interface SearchResult {
  found: boolean;
  /** Total cost of the path; `Infinity` when not found. */
  cost: number;
  /** Nodes from source to target inclusive; empty when not found. */
  nodes: number[];
  /** Edge ids between consecutive nodes (`nodes.length - 1` of them). */
  edges: number[];
  /** Nodes expanded (popped with a final label). */
  settled: number;
  /** Successful edge relaxations. */
  relaxed: number;
}

/**
 * A shortest-path engine. Register custom engines (bidirectional Dijkstra, ALT, contraction hierarchies…)
 * with an {@link AlgorithmRegistry} and select them by name per query.
 */
export interface PathAlgorithm {
  readonly name: string;
  /** Whether the engine consumes `SearchRequest.heuristic`. */
  readonly usesHeuristic: boolean;
  search(request: SearchRequest): SearchResult;
}
