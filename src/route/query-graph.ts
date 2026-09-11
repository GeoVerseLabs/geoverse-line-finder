import type { SearchGraph } from '../algorithm/types';
import type { RoutingGraph } from '../graph/graph';
import type { ChainPiece } from './assemble';

// source→2 chain ends, 2 chain ends→target, source→target on a shared chain.
const CAPACITY = 8;

/**
 * The base graph plus a per-query overlay. A waypoint that snaps strictly inside a chain becomes a virtual
 * node (`baseNodeCount` for the source, `baseNodeCount + 1` for the target) joined to the chain's end
 * nodes by partial-chain edges. The base graph is never mutated, so graphs stay shareable and queries
 * cannot leak state into each other (unlike geojson-path-finder's phantom nodes).
 */
export class QueryGraph implements SearchGraph {
  readonly baseNodeCount: number;
  readonly nodeCount: number;
  readonly offsets: Int32Array;
  readonly targets: Int32Array;
  readonly costs: Float64Array;
  readonly baseEdgeCount: number;
  overlayCount = 0;
  readonly overlayFrom = new Int32Array(CAPACITY);
  readonly overlayTo = new Int32Array(CAPACITY);
  readonly overlayCost = new Float64Array(CAPACITY);
  private readonly overlayChain = new Int32Array(CAPACITY);
  private readonly overlayStart = new Float64Array(CAPACITY);
  private readonly overlayEnd = new Float64Array(CAPACITY);

  constructor(graph: RoutingGraph<unknown>) {
    this.baseNodeCount = graph.nodes.count;
    this.nodeCount = graph.nodes.count + 2;
    this.offsets = graph.edges.offsets;
    this.targets = graph.edges.targets;
    this.costs = graph.edges.costs;
    this.baseEdgeCount = graph.edges.count;
  }

  get virtualSource(): number {
    return this.baseNodeCount;
  }

  get virtualTarget(): number {
    return this.baseNodeCount + 1;
  }

  reset(): void {
    this.overlayCount = 0;
  }

  /** Adds a virtual edge traversing `chain` from position `start` to `end`. Impassable edges are skipped. */
  add(from: number, to: number, chain: number, start: number, end: number, cost: number): void {
    if (!(cost < Infinity)) return;
    if (this.overlayCount >= CAPACITY) throw new Error('Query overlay capacity exceeded.');
    const k = this.overlayCount++;
    this.overlayFrom[k] = from;
    this.overlayTo[k] = to;
    this.overlayCost[k] = cost;
    this.overlayChain[k] = chain;
    this.overlayStart[k] = start;
    this.overlayEnd[k] = end;
  }

  /** The chain traversal behind overlay edge `k`. */
  piece(k: number): ChainPiece {
    return { chain: this.overlayChain[k], start: this.overlayStart[k], end: this.overlayEnd[k] };
  }
}
