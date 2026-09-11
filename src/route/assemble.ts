import type { RoutingGraph } from '../graph/graph';
import type { Position } from '../types';

/** Traversal of `chain` from fractional position `start` to `end` (reverse when `end < start`). */
export interface ChainPiece {
  chain: number;
  start: number;
  end: number;
}

/** A run of the path that comes from one source feature — e.g. one street. */
export interface RouteSection<P = unknown> {
  featureIndex: number;
  id: string | number | undefined;
  properties: P | undefined;
  /** First and last index (inclusive) into the owning leg's `path`. */
  start: number;
  end: number;
  distance: number;
  weight: number;
}

/** Cost of a partial chain traversal; costs are assumed uniform along each segment. */
export function partialCost(graph: RoutingGraph<unknown>, chain: number, start: number, end: number): number {
  if (start === end) return 0;
  const base = graph.chains.segStart[chain];
  const forward = end > start;
  const lo = forward ? start : end;
  const hi = forward ? end : start;
  const costs = forward ? graph.segments.forward : graph.segments.backward;
  let total = 0;
  for (let i = Math.floor(lo), last = Math.ceil(hi); i < last; i++) {
    const overlap = Math.min(hi, i + 1) - Math.max(lo, i);
    if (overlap <= 0) continue;
    const cost = costs[base + i];
    if (cost === Infinity) return Infinity;
    total += overlap * cost;
  }
  return total;
}

/** Piece for a base CSR edge. */
export function edgePiece(graph: RoutingGraph<unknown>, edge: number): ChainPiece {
  const ref = graph.edges.ref[edge];
  const chain = ref >>> 1;
  const n = graph.segmentCountOf(chain);
  return ref & 1 ? { chain, start: n, end: 0 } : { chain, start: 0, end: n };
}

export interface AssembledPath<P> {
  path: Position[];
  distance: number;
  weight: number;
  sections: RouteSection<P>[];
}

/** Turns chain traversals into coordinates, length and per-feature sections. */
export function assemblePieces<P>(graph: RoutingGraph<P>, pieces: readonly ChainPiece[]): AssembledPath<P> {
  const path: Position[] = [];
  const sections: RouteSection<P>[] = [];
  const { feature, length, forward, backward } = graph.segments;
  let distance = 0;
  let weight = 0;

  const emit = (
    chain: number,
    slot: number,
    from: number,
    to: number,
    fraction: number,
    cost: number,
  ): void => {
    if (path.length === 0) path.push(graph.pointAt(chain, from));
    path.push(graph.pointAt(chain, to));
    const d = fraction * length[slot];
    const w = fraction * cost;
    distance += d;
    weight += w;
    const featureIndex = feature[slot];
    const index = path.length - 1;
    const last = sections[sections.length - 1];
    if (last && last.featureIndex === featureIndex && last.end === index - 1) {
      last.end = index;
      last.distance += d;
      last.weight += w;
    } else {
      const source = graph.features[featureIndex];
      sections.push({
        featureIndex,
        id: source.id,
        properties: source.properties,
        start: index - 1,
        end: index,
        distance: d,
        weight: w,
      });
    }
  };

  for (const { chain, start, end } of pieces) {
    if (start === end) continue;
    const base = graph.chains.segStart[chain];
    if (end > start) {
      for (let i = Math.floor(start), last = Math.ceil(end); i < last; i++) {
        const a = Math.max(start, i);
        const b = Math.min(end, i + 1);
        if (b > a) emit(chain, base + i, a, b, b - a, forward[base + i]);
      }
    } else {
      for (let i = Math.ceil(start) - 1, last = Math.floor(end); i >= last; i--) {
        const a = Math.min(start, i + 1);
        const b = Math.max(end, i);
        if (a > b) emit(chain, base + i, a, b, a - b, backward[base + i]);
      }
    }
  }
  return { path, distance, weight, sections };
}
