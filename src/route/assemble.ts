import type { RoutingGraph } from '../graph/graph';
import type { GroupKey } from '../graph/topology';
import { NO_GROUP } from '../graph/vertex-store';
import type { Position } from '../types';

/**
 * Where a location sits vertically: a group key for a level, `undefined` for the default group, and
 * `null` inside a connector — a lift car or a flight of stairs belongs to no level.
 */
export type LevelKey = GroupKey | undefined | null;

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
  /**
   * Level the section runs on, with `levels`: the connectivity group of its locations, or `null` for a
   * connector (a lift, a staircase, a ramp). Absent when the graph was built without `levels`.
   */
  level?: GroupKey | null;
}

/** One passage between two levels: a lift ride, a flight of stairs, an escalator. */
export interface LevelTransition {
  fromLevel: GroupKey | undefined;
  toLevel: GroupKey | undefined;
  /** Signed ordinal difference (positive upwards); `0` when an ordinal is unknown. */
  levelChange: number;
  /** First and last index (inclusive) into the owning leg's `path`. */
  start: number;
  end: number;
  /** Connector features the passage is made of (a lift taken past several floors merges into one). */
  featureIndices: number[];
  weight: number;
  distance: number;
}

/**
 * Groups the connector sections of one leg into passages. Consecutive connector sections with no
 * same-level section between them are one passage, so a floor-by-floor lift (F1-F2, F2-F3) reads as a
 * single ride from F1 to F3 — which is what a rider experiences and what `levelChanges` counts.
 */
export function levelTransitions<P>(
  graph: RoutingGraph<P>,
  sections: readonly RouteSection<P>[],
  levels: readonly LevelKey[],
): LevelTransition[] {
  const out: LevelTransition[] = [];
  const ordinalOf = (key: LevelKey): number =>
    key === null ? NaN : graph.groupOrdinal(graph.groupIndex(key));
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].level !== null) continue;
    let j = i;
    let weight = 0;
    let distance = 0;
    const featureIndices: number[] = [];
    while (j < sections.length && sections[j].level === null) {
      weight += sections[j].weight;
      distance += sections[j].distance;
      if (!featureIndices.includes(sections[j].featureIndex)) featureIndices.push(sections[j].featureIndex);
      j++;
    }
    const start = sections[i].start;
    const end = sections[j - 1].end;
    const fromLevel = levels[start];
    const toLevel = levels[end];
    const change = ordinalOf(toLevel) - ordinalOf(fromLevel);
    out.push({
      fromLevel: fromLevel === null ? undefined : fromLevel,
      toLevel: toLevel === null ? undefined : toLevel,
      levelChange: Number.isFinite(change) ? change : 0,
      start,
      end,
      featureIndices,
      weight,
      distance,
    });
    i = j - 1;
  }
  return out;
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
  /** With `levels`: the level of every path coordinate (`null` inside a connector). */
  levels: LevelKey[] | null;
  /** With level elevations: the climbed and descended height along the path. */
  verticalDistance: number;
}

/**
 * Turns chain traversals into coordinates, length and per-feature sections. With `levels` it also labels
 * every coordinate with its level and measures the vertical travel; `z` writes the height into the
 * output coordinates, which then are copies instead of the network's own position objects.
 */
export function assemblePieces<P>(
  graph: RoutingGraph<P>,
  pieces: readonly ChainPiece[],
  detail: SectionsDetail = 'feature',
  z = false,
): AssembledPath<P> {
  const path: Position[] = [];
  const sections: RouteSection<P>[] = [];
  const { feature, length, forward, backward, measureStart, measureEnd, part } = graph.segments;
  const cv = graph.chains.vertices;
  const withLevels = graph.levels !== null;
  const levels: LevelKey[] | null = withLevels ? [] : null;
  const sectionLevel: number[] = [];
  const elevation = graph.vertices.elevation;
  const writeZ = z && elevation !== null;
  let distance = 0;
  let weight = 0;
  let verticalDistance = 0;
  let lastElevation = NaN;

  /** Group index of a location at `pos` on segment `slot` (whose own span is `[local, local + 1]`). */
  const groupAt = (chain: number, slot: number, local: number, pos: number): number => {
    if (!graph.vertices.group) return 0;
    if (pos === local) return graph.vertexGroup(cv[slot + chain]);
    if (pos === local + 1) return graph.vertexGroup(cv[slot + chain + 1]);
    return graph.segmentGroup(slot);
  };
  const heightAt = (chain: number, slot: number, local: number, pos: number): number => {
    if (!elevation) return NaN;
    const a = elevation[cv[slot + chain]];
    const f = pos - local;
    if (f === 0) return a;
    const b = elevation[cv[slot + chain + 1]];
    return f === 1 ? b : a + (b - a) * f;
  };
  const push = (chain: number, slot: number, local: number, pos: number): void => {
    const point = graph.pointAt(chain, pos);
    const height = withLevels ? heightAt(chain, slot, local, pos) : NaN;
    path.push(writeZ && !Number.isNaN(height) ? [point[0], point[1], height] : point);
    if (levels) {
      const g = groupAt(chain, slot, local, pos);
      levels.push(g === NO_GROUP ? null : graph.groupKeys[g]);
      if (!Number.isNaN(height) && !Number.isNaN(lastElevation) && path.length > 1) {
        verticalDistance += Math.abs(height - lastElevation);
      }
      lastElevation = height;
    }
  };

  const emit = (
    chain: number,
    slot: number,
    local: number,
    from: number,
    to: number,
    fraction: number,
    cost: number,
  ): void => {
    if (path.length === 0) push(chain, slot, local, from);
    push(chain, slot, local, to);
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
      if (withLevels && sectionLevel[sections.length - 1] !== graph.segmentGroup(slot)) {
        sectionLevel[sections.length - 1] = NO_GROUP;
      }
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
      if (withLevels) sectionLevel.push(graph.segmentGroup(slot));
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
  if (withLevels) {
    for (let i = 0; i < sections.length; i++) {
      const g = sectionLevel[i];
      sections[i].level = g === NO_GROUP ? null : graph.groupKeys[g];
    }
  }
  return { path, distance, weight, sections, levels, verticalDistance };
}
