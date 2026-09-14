import type { SearchGraph } from '../algorithm/types';
import type { RoutingGraph } from '../graph/graph';
import type { ChainPiece } from './assemble';

const INITIAL_EDGES = 8;
const INITIAL_VIRTUAL = 8;

/**
 * The base graph plus a per-query overlay. A waypoint or candidate that sits strictly inside a chain becomes
 * a virtual node joined to the chain's end nodes by partial-chain edges; seed edges (without geometry) let a
 * virtual super-source start from several places at once. Node `baseNodeCount` and `baseNodeCount + 1` are
 * reserved for a two-point query's source and target; {@link addVirtual} hands out more.
 *
 * The base graph is never mutated, so graphs stay shareable and queries cannot leak state into each other
 * (unlike geojson-path-finder's phantom nodes). Capacity grows on demand; the per-node adjacency lists keep
 * edges in insertion order, identical to a full scan.
 */
export class QueryGraph implements SearchGraph {
  readonly baseNodeCount: number;
  readonly offsets: Int32Array;
  readonly targets: Int32Array;
  readonly costs: Float64Array;
  readonly baseEdgeCount: number;
  overlayCount = 0;
  overlayFrom: Int32Array = new Int32Array(INITIAL_EDGES);
  overlayTo: Int32Array = new Int32Array(INITIAL_EDGES);
  overlayCost: Float64Array = new Float64Array(INITIAL_EDGES);
  overlayNext: Int32Array = new Int32Array(INITIAL_EDGES);
  private overlayChain: Int32Array = new Int32Array(INITIAL_EDGES);
  private overlayStart: Float64Array = new Float64Array(INITIAL_EDGES);
  private overlayEnd: Float64Array = new Float64Array(INITIAL_EDGES);
  private virtualCount = 2;
  private stamp = 1;
  private headStamp: Uint32Array;
  private head: Int32Array;
  private tail: Int32Array;
  private readonly routing: RoutingGraph<unknown>;

  constructor(graph: RoutingGraph<unknown>) {
    this.routing = graph;
    this.baseNodeCount = graph.nodes.count;
    this.offsets = graph.edges.offsets;
    this.targets = graph.edges.targets;
    this.costs = graph.edges.costs;
    this.baseEdgeCount = graph.edges.count;
    const nodes = this.baseNodeCount + 2 + INITIAL_VIRTUAL;
    this.headStamp = new Uint32Array(nodes);
    this.head = new Int32Array(nodes);
    this.tail = new Int32Array(nodes);
  }

  get nodeCount(): number {
    return this.baseNodeCount + this.virtualCount;
  }

  /** Reverse adjacency of the base graph, built lazily on first use (bidirectional engines). */
  get reverseOffsets(): Int32Array {
    return this.routing.reverseEdges().offsets;
  }

  get reverseSources(): Int32Array {
    return this.routing.reverseEdges().sources;
  }

  get reverseCosts(): Float64Array {
    return this.routing.reverseEdges().costs;
  }

  get reverseEdgeIds(): Int32Array {
    return this.routing.reverseEdges().edges;
  }

  get virtualSource(): number {
    return this.baseNodeCount;
  }

  get virtualTarget(): number {
    return this.baseNodeCount + 1;
  }

  reset(): void {
    this.overlayCount = 0;
    this.virtualCount = 2;
    if (++this.stamp >= 0xfffffffe) {
      this.headStamp.fill(0);
      this.stamp = 1;
    }
  }

  /** A fresh virtual node id (valid until the next {@link reset}). */
  addVirtual(): number {
    const id = this.baseNodeCount + this.virtualCount++;
    if (id >= this.head.length) {
      const size = Math.max(id + 1, Math.ceil(this.head.length * 1.5));
      this.headStamp = grow(this.headStamp, new Uint32Array(size));
      this.head = grow(this.head, new Int32Array(size));
      this.tail = grow(this.tail, new Int32Array(size));
    }
    return id;
  }

  /**
   * Adds a virtual edge traversing `chain` from position `start` to `end` (`chain = -1` for a seed edge
   * without geometry). Impassable edges are skipped. Returns the overlay edge index, or `-1`.
   */
  add(from: number, to: number, chain: number, start: number, end: number, cost: number): number {
    if (!(cost < Infinity)) return -1;
    const k = this.overlayCount++;
    if (k >= this.overlayFrom.length) this.growEdges();
    this.overlayFrom[k] = from;
    this.overlayTo[k] = to;
    this.overlayCost[k] = cost;
    this.overlayChain[k] = chain;
    this.overlayStart[k] = start;
    this.overlayEnd[k] = end;
    this.overlayNext[k] = -1;
    if (this.headStamp[from] !== this.stamp) {
      this.headStamp[from] = this.stamp;
      this.head[from] = k;
    } else {
      this.overlayNext[this.tail[from]] = k;
    }
    this.tail[from] = k;
    return k;
  }

  overlayFirst(node: number): number {
    return this.headStamp[node] === this.stamp ? this.head[node] : -1;
  }

  /** The chain traversal behind overlay edge `k`; `null` for a seed edge. */
  piece(k: number): ChainPiece | null {
    const chain = this.overlayChain[k];
    return chain < 0 ? null : { chain, start: this.overlayStart[k], end: this.overlayEnd[k] };
  }

  private growEdges(): void {
    const size = this.overlayFrom.length * 2;
    this.overlayFrom = grow(this.overlayFrom, new Int32Array(size));
    this.overlayTo = grow(this.overlayTo, new Int32Array(size));
    this.overlayCost = grow(this.overlayCost, new Float64Array(size));
    this.overlayNext = grow(this.overlayNext, new Int32Array(size));
    this.overlayChain = grow(this.overlayChain, new Int32Array(size));
    this.overlayStart = grow(this.overlayStart, new Float64Array(size));
    this.overlayEnd = grow(this.overlayEnd, new Float64Array(size));
  }
}

function grow<T extends Int32Array | Uint32Array | Float64Array>(from: T, to: T): T {
  to.set(from);
  return to;
}
