import type { RoutingGraph } from '../graph/graph';
import type { Position } from '../types';

/** Traversal of `chain` from fractional position `start` to `end` (reverse when `end < start`). */
export interface ChainPiece {
  chain: number;
  start: number;
  end: number;
}

/**
 * How sections are grouped: `'feature'` (default) merges consecutive pieces of one source feature,
 * `'measure'` additionally splits where the part or the measure is not continuous (so that
 * `Σ |toMeasure − fromMeasure|` equals the distance), `'segment'` returns every traversed segment.
 */
export type SectionsDetail = 'feature' | 'measure' | 'segment';

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
  /** Measure along the source feature where the section starts and ends (decreasing = against its direction). */
  fromMeasure: number;
  toMeasure: number;
  /** Part of a MultiLineString the section starts on (0 for LineStrings). */
  partIndex: number;
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

/** Metric length of chain traversals, without building coordinates. */
export function piecesDistance(graph: RoutingGraph<unknown>, pieces: readonly ChainPiece[]): number {
  const length = graph.segments.length;
  let distance = 0;
  for (const { chain, start, end } of pieces) {
    const base = graph.chains.segStart[chain];
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    for (let i = Math.floor(lo), last = Math.ceil(hi); i < last; i++) {
      const overlap = Math.min(hi, i + 1) - Math.max(lo, i);
      if (overlap > 0) distance += overlap * length[base + i];
    }
  }
  return distance;
}

export interface AssembledPath<P> {
  path: Position[];
  distance: number;
  weight: number;
  sections: RouteSection<P>[];
}

/** Turns chain traversals into coordinates, length and per-feature sections. */
export function assemblePieces<P>(
  graph: RoutingGraph<P>,
  pieces: readonly ChainPiece[],
  detail: SectionsDetail = 'feature',
): AssembledPath<P> {
  const path: Position[] = [];
  const sections: RouteSection<P>[] = [];
  const { feature, length, forward, backward, measureStart, measureEnd, part } = graph.segments;
  let distance = 0;
  let weight = 0;

  const emit = (
    chain: number,
    slot: number,
    local: number,
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
    const ms = measureStart[slot];
    const span = measureEnd[slot] - ms;
    const fromMeasure = ms + (from - local) * span;
    const toMeasure = ms + (to - local) * span;
    const index = path.length - 1;
    const last = sections[sections.length - 1];
    if (
      last &&
      detail !== 'segment' &&
      last.featureIndex === featureIndex &&
      last.end === index - 1 &&
      (detail === 'feature' ||
        (last.partIndex === part[slot] &&
          Math.abs(last.toMeasure - fromMeasure) <= 1e-9 * Math.max(1, Math.abs(fromMeasure))))
    ) {
      last.end = index;
      last.distance += d;
      last.weight += w;
      last.toMeasure = toMeasure;
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
        fromMeasure,
        toMeasure,
        partIndex: part[slot],
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
        if (b > a) emit(chain, base + i, i, a, b, b - a, forward[base + i]);
      }
    } else {
      for (let i = Math.ceil(start) - 1, last = Math.floor(end); i >= last; i--) {
        const a = Math.min(start, i + 1);
        const b = Math.max(end, i);
        if (a > b) emit(chain, base + i, i, a, b, a - b, backward[base + i]);
      }
    }
  }
  return { path, distance, weight, sections };
}
