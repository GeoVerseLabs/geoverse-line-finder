import { FourAryHeap } from '../heap/four-ary-heap';
import type { Heap, HeapConstructor } from '../heap/heap';
import type { SearchResult } from './types';

/**
 * Per-finder search state reused across queries (the terra-route trick): typed arrays are allocated once
 * and validated with a generation stamp instead of being cleared, so a query only touches the nodes it
 * actually visits.
 */
export class SearchScratch {
  // Explicit element types: inferred fields would be emitted as `Float64Array<ArrayBuffer>`, which
  // TypeScript < 5.7 cannot read in the published declarations.
  /** Best known cost per node; valid only where `seen[node] === stamp`. */
  g: Float64Array = new Float64Array(0);
  prevNode: Int32Array = new Int32Array(0);
  prevEdge: Int32Array = new Int32Array(0);
  seen: Uint32Array = new Uint32Array(0);
  /** `closed[node] === stamp` once the node is settled. */
  closed: Uint32Array = new Uint32Array(0);
  /** `targetMark[node] === stamp` while `node` is a still unsettled target of a multi-target search. */
  targetMark: Uint32Array = new Uint32Array(0);
  stamp = 0;
  readonly heap: Heap;

  constructor(heap: HeapConstructor = FourAryHeap) {
    this.heap = new heap();
  }

  /** Prepares buffers for `size` nodes and returns the stamp identifying this query. */
  begin(size: number): number {
    if (size > this.g.length) {
      const capacity = Math.max(size, Math.ceil(this.g.length * 1.5));
      this.g = new Float64Array(capacity);
      this.prevNode = new Int32Array(capacity);
      this.prevEdge = new Int32Array(capacity);
      this.seen = new Uint32Array(capacity);
      this.closed = new Uint32Array(capacity);
      this.targetMark = new Uint32Array(capacity);
      this.stamp = 0;
    }
    if (this.stamp >= 0xfffffffe) {
      this.seen.fill(0);
      this.closed.fill(0);
      this.targetMark.fill(0);
      this.stamp = 0;
    }
    this.heap.clear();
    return ++this.stamp;
  }
}

/** Walks predecessor links from `target` back to `source`. */
export function reconstructPath(
  scratch: SearchScratch,
  source: number,
  target: number,
): { nodes: number[]; edges: number[] } {
  const nodes: number[] = [];
  const edges: number[] = [];
  let v = target;
  let guard = scratch.g.length + 1;
  while (v !== source) {
    if (guard-- <= 0 || v < 0) throw new Error('Corrupted predecessor chain.');
    nodes.push(v);
    edges.push(scratch.prevEdge[v]);
    v = scratch.prevNode[v];
  }
  nodes.push(source);
  nodes.reverse();
  edges.reverse();
  return { nodes, edges };
}

export function notFound(settled: number, relaxed: number): SearchResult {
  return { found: false, cost: Infinity, nodes: [], edges: [], settled, relaxed };
}
