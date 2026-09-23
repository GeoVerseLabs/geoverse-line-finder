import { localScale } from '../geo/metric';
import { projectToSegment, type SegmentProjection } from '../geo/segment';
import type { Position } from '../types';
import type { RoutingGraph } from './graph';
import { REPAIR_DANGLE, REPAIR_MERGE, type GroupKey } from './topology';
import { NO_GROUP } from './vertex-store';

export interface DiagnosticsOptions {
  /** Dead ends at most this far from another segment are near misses (metric units). Default `1`. */
  nearMissDistance?: number;
  /** Maximum items per list; the rest is only counted. Default `1000`. */
  limit?: number;
}

export interface DiagnosticList<T> {
  items: T[];
  /** Items found, including those beyond `limit`. */
  total: number;
  truncated: number;
}

export interface DangleReport {
  location: Position;
  node: number;
  featureIndex: number;
  featureId: string | number | undefined;
  /** Distance to the nearest segment of another chain in the same group (`Infinity` when none). */
  nearestDistance: number;
  nearestFeatureIndex: number;
}

export interface RepairReport {
  kind: 'merge' | 'dangle' | 'split';
  location: Position;
  /** The two features involved (merged coordinate / existing vertex, dead end / target, crossing pair). */
  featureIndices: [number, number];
  /** Distance bridged (0 for splits). */
  gap: number;
}

export interface ComponentReport {
  id: number;
  nodes: number;
  length: number;
  /** `[minX, minY, maxX, maxY]` of the component's vertices. */
  bbox: [number, number, number, number];
  group: GroupKey | undefined;
}

export interface InvalidCoordinateReport {
  featureIndex: number;
  partIndex: number;
  coordinateIndex: number;
}

export interface OverlapReport {
  /** Features of two collinear segments that overlap without being noded. */
  featureIndices: [number, number];
  location: Position;
  length: number;
}

export interface GraphDiagnostics {
  /** Dead ends (nodes touching a single chain). */
  dangles: DiagnosticList<DangleReport>;
  /** Dead ends within `nearMissDistance` of another segment: probably meant to connect. */
  nearMisses: DiagnosticList<DangleReport>;
  /** Merges, dangle snaps and splits made while building; `null` unless built with `diagnostics: true`. */
  repairs: DiagnosticList<RepairReport> | null;
  components: DiagnosticList<ComponentReport>;
  /** `null` unless built with `diagnostics: true`. */
  invalidCoordinates: DiagnosticList<InvalidCoordinateReport> | null;
  /** Collinear overlapping segments, which no repair connects. */
  overlaps: DiagnosticList<OverlapReport>;
}

class Collector<T> implements DiagnosticList<T> {
  items: T[] = [];
  total = 0;
  truncated = 0;
  constructor(private readonly limit: number) {}
  push(item: T): void {
    this.total++;
    if (this.items.length < this.limit) this.items.push(item);
    else this.truncated++;
  }
  toJSON(): DiagnosticList<T> {
    return { items: this.items, total: this.total, truncated: this.truncated };
  }
}

/** Locates the topology problems that `stats` only counts. */
export function diagnoseGraph(
  graph: RoutingGraph<unknown>,
  options: DiagnosticsOptions = {},
): GraphDiagnostics {
  const nearMissDistance = options.nearMissDistance ?? 1;
  const limit = options.limit ?? 1000;
  if (!(nearMissDistance >= 0))
    throw new RangeError(`nearMissDistance must be ≥ 0, got ${String(nearMissDistance)}.`);
  if (!(limit >= 0)) throw new RangeError(`limit must be ≥ 0, got ${String(limit)}.`);
  const { chains, segments, vertices, nodes, metric } = graph;
  const X = vertices.x;
  const Y = vertices.y;
  const groupOf = (vertex: number) => (vertices.group ? vertices.group[vertex] : 0);

  // --- dangles and near misses --------------------------------------------------------------------------
  const dangles = new Collector<DangleReport>(limit);
  const nearMisses = new Collector<DangleReport>(limit);
  const incident = graph.nodeChains();
  const proj: SegmentProjection = { t: 0, x: 0, y: 0 };
  for (let n = 0; n < nodes.count; n++) {
    if (incident.offsets[n + 1] - incident.offsets[n] !== 1) continue;
    const k = incident.offsets[n];
    const own = incident.chains[k];
    const slot = incident.atStart[k] ? chains.segStart[own] : chains.segStart[own + 1] - 1;
    const v = nodes.vertex[n];
    const px = X[v];
    const py = Y[v];
    const group = groupOf(v);
    const { sx, sy } = localScale(metric, py);
    let nearest = -1;
    // Same rule as the `snapDangles` repair: only segments lying entirely in the dead end's group, and none
    // for the group-less interior of a connector.
    if (group !== NO_GROUP)
      graph.segmentIndex.nearest(
        px,
        py,
        sx,
        sy,
        (s) => {
          const c = segments.chain[s];
          if (c === own) return Infinity;
          if (graph.segmentGroup(s) !== group) return Infinity;
          const a = chains.vertices[s + c];
          const b = chains.vertices[s + c + 1];
          return projectToSegment(px, py, X[a], Y[a], X[b], Y[b], sx, sy, proj);
        },
        (s) => {
          nearest = s;
          return false;
        },
      );
    let nearestDistance = Infinity;
    if (nearest >= 0) {
      const c = segments.chain[nearest];
      const a = chains.vertices[nearest + c];
      const b = chains.vertices[nearest + c + 1];
      projectToSegment(px, py, X[a], Y[a], X[b], Y[b], sx, sy, proj);
      nearestDistance = metric.distance(vertices.positions[v], [proj.x, proj.y]);
    }
    const featureIndex = segments.feature[slot];
    const report: DangleReport = {
      location: vertices.positions[v],
      node: n,
      featureIndex,
      featureId: graph.featureId(featureIndex),
      nearestDistance,
      nearestFeatureIndex: nearest >= 0 ? segments.feature[nearest] : -1,
    };
    dangles.push(report);
    if (nearestDistance <= nearMissDistance) nearMisses.push(report);
  }

  // --- repairs and invalid coordinates -----------------------------------------------------------------
  let repairs: Collector<RepairReport> | null = null;
  let invalidCoordinates: Collector<InvalidCoordinateReport> | null = null;
  const log = graph.diagnosticsLog;
  if (log) {
    repairs = new Collector(limit);
    const r = log.repairs;
    for (let i = 0; i < r.kind.length; i++) {
      repairs.push({
        kind: r.kind[i] === REPAIR_MERGE ? 'merge' : r.kind[i] === REPAIR_DANGLE ? 'dangle' : 'split',
        location: [r.x[i], r.y[i]],
        featureIndices: [r.featureA[i], r.featureB[i]],
        gap: r.gap[i],
      });
    }
    invalidCoordinates = new Collector(limit);
    for (let i = 0; i < log.invalid.length; i += 3) {
      invalidCoordinates.push({
        featureIndex: log.invalid[i],
        partIndex: log.invalid[i + 1],
        coordinateIndex: log.invalid[i + 2],
      });
    }
  }

  // --- components --------------------------------------------------------------------------------------
  const components = new Collector<ComponentReport>(limit);
  const count = graph.components.count;
  const bbox = new Float64Array(count * 4);
  for (let c = 0; c < count; c++) bbox.set([Infinity, Infinity, -Infinity, -Infinity], c * 4);
  const group = new Int32Array(count).fill(-1);
  const extend = (component: number, vertex: number) => {
    const o = component * 4;
    if (X[vertex] < bbox[o]) bbox[o] = X[vertex];
    if (Y[vertex] < bbox[o + 1]) bbox[o + 1] = Y[vertex];
    if (X[vertex] > bbox[o + 2]) bbox[o + 2] = X[vertex];
    if (Y[vertex] > bbox[o + 3]) bbox[o + 3] = Y[vertex];
    if (group[component] < 0) group[component] = groupOf(vertex);
  };
  for (let n = 0; n < nodes.count; n++) extend(nodes.component[n], nodes.vertex[n]);
  for (let c = 0; c < chains.count; c++) {
    const base = chains.segStart[c] + c;
    const last = chains.segStart[c + 1] + c;
    for (let i = base + 1; i < last; i++) extend(chains.component[c], chains.vertices[i]);
  }
  for (let c = 0; c < count; c++) {
    components.push({
      id: c,
      nodes: graph.components.nodes[c],
      length: graph.components.length[c],
      bbox: [bbox[c * 4], bbox[c * 4 + 1], bbox[c * 4 + 2], bbox[c * 4 + 3]],
      group: graph.groupKeys[Math.max(0, group[c])],
    });
  }

  // --- collinear overlaps ------------------------------------------------------------------------------
  const overlaps = new Collector<OverlapReport>(limit);
  const eps = graph.settings.tolerance > 0 ? graph.settings.tolerance : 1e-6;
  for (let s = 0; s < segments.count; s++) {
    // Connectors run between groups (stacked staircases coincide in plan): they never count as overlaps.
    const sGroup = graph.segmentGroup(s);
    if (sGroup === NO_GROUP) continue;
    const c = segments.chain[s];
    const a = chains.vertices[s + c];
    const b = chains.vertices[s + c + 1];
    const { sx, sy } = localScale(metric, Y[a]);
    const ux = (X[b] - X[a]) * sx;
    const uy = (Y[b] - Y[a]) * sy;
    const len = Math.hypot(ux, uy);
    if (!(len > eps)) continue;
    const padX = eps / sx;
    const padY = eps / sy;
    graph.segmentIndex.search(
      Math.min(X[a], X[b]) - padX,
      Math.min(Y[a], Y[b]) - padY,
      Math.max(X[a], X[b]) + padX,
      Math.max(Y[a], Y[b]) + padY,
      (t) => {
        if (t <= s) return;
        const ct = segments.chain[t];
        const p = chains.vertices[t + ct];
        const q = chains.vertices[t + ct + 1];
        if (graph.segmentGroup(t) !== sGroup) return;
        // Both ends of t within eps of the infinite line through s …
        const off = (vx: number, vy: number) => Math.abs(ux * (vy - Y[a]) * sy - uy * (vx - X[a]) * sx) / len;
        if (off(X[p], Y[p]) > eps || off(X[q], Y[q]) > eps) return;
        // … and their projections overlapping s by more than eps.
        const along = (vx: number, vy: number) => (ux * (vx - X[a]) * sx + uy * (vy - Y[a]) * sy) / len;
        const t0 = along(X[p], Y[p]);
        const t1 = along(X[q], Y[q]);
        const lo = Math.max(0, Math.min(t0, t1));
        const hi = Math.min(len, Math.max(t0, t1));
        if (hi - lo <= eps) return;
        const mid = (lo + hi) / 2 / len;
        overlaps.push({
          featureIndices: [segments.feature[s], segments.feature[t]],
          location: [X[a] + (X[b] - X[a]) * mid, Y[a] + (Y[b] - Y[a]) * mid],
          length: hi - lo,
        });
      },
    );
  }

  return {
    dangles: dangles.toJSON(),
    nearMisses: nearMisses.toJSON(),
    repairs: repairs ? repairs.toJSON() : null,
    components: components.toJSON(),
    invalidCoordinates: invalidCoordinates ? invalidCoordinates.toJSON() : null,
    overlaps: overlaps.toJSON(),
  };
}
