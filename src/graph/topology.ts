import { localScale, type Metric } from '../geo/metric';
import {
  intersectSegments,
  projectToSegment,
  type SegmentIntersection,
  type SegmentProjection,
} from '../geo/segment';
import { PackedRTree } from '../spatial/rtree';
import type { GeometryLike, NetworkCollection, Position } from '../types';
import { VertexStore } from './vertex-store';

export interface NetworkScan {
  coordinates: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  maxAbsLat: number;
}

/** Returns the coordinate arrays of a routable geometry, or `null` for anything else. */
export function lineParts(geometry: GeometryLike | null | undefined): readonly unknown[] | null {
  if (!geometry || typeof geometry !== 'object') return null;
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates)) return geometry.coordinates;
  return null;
}

export function isPosition(value: unknown): value is Position {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]);
}

export function scanNetwork(network: NetworkCollection<unknown>): NetworkScan {
  let coordinates = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const feature of network.features) {
    const parts = lineParts(feature?.geometry);
    if (!parts) continue;
    for (const part of parts) {
      if (!Array.isArray(part)) continue;
      for (const c of part) {
        if (!isPosition(c)) continue;
        coordinates++;
        if (c[0] < minX) minX = c[0];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[1] > maxY) maxY = c[1];
      }
    }
  }
  const maxAbsLat = coordinates > 0 ? Math.max(Math.abs(minY), Math.abs(maxY)) : 0;
  return { coordinates, minX, minY, maxX, maxY, maxAbsLat };
}

export interface TopologyOptions {
  tolerance: number;
  snapDangles: number;
  splitIntersections: boolean;
  maxAbsLat: number;
}

/** Undirected segment soup after vertex merging and connectivity repair. */
export interface Topology {
  store: VertexStore;
  /** Final vertex id for every stored vertex (identity unless it was merged away by repair). */
  remap: Int32Array;
  segA: Int32Array;
  segB: Int32Array;
  segFeature: Int32Array;
  lineFeatures: number;
  skippedFeatures: number;
  invalidCoordinates: number;
  coordinates: number;
  mergedVertices: number;
  danglesSnapped: number;
  intersectionsSplit: number;
}

export function buildTopology(
  network: NetworkCollection<unknown>,
  metric: Metric,
  options: TopologyOptions,
): Topology {
  const store = new VertexStore({
    tolerance: options.tolerance,
    geographic: metric.geographic,
    maxAbsLat: options.maxAbsLat,
  });
  const segA: number[] = [];
  const segB: number[] = [];
  const segF: number[] = [];
  let lineFeatures = 0;
  let skippedFeatures = 0;
  let invalidCoordinates = 0;
  let coordinates = 0;

  const features = network.features;
  for (let fi = 0; fi < features.length; fi++) {
    const parts = lineParts(features[fi]?.geometry);
    if (!parts) {
      skippedFeatures++;
      continue;
    }
    lineFeatures++;
    for (const part of parts) {
      if (!Array.isArray(part)) continue;
      let prev = -1;
      for (const c of part) {
        if (!isPosition(c)) {
          // An invalid coordinate breaks the line instead of bridging across it.
          invalidCoordinates++;
          prev = -1;
          continue;
        }
        coordinates++;
        const id = store.getOrAdd(c);
        if (prev !== -1 && id !== prev) {
          segA.push(prev);
          segB.push(id);
          segF.push(fi);
        }
        prev = id;
      }
    }
  }

  const mergedVertices = store.merged;
  const repair = new ConnectivityRepair(store, segA, segB, metric, options.tolerance);
  const danglesSnapped = options.snapDangles > 0 ? repair.snapDangles(options.snapDangles) : 0;
  const intersectionsSplit = options.splitIntersections ? repair.splitIntersections() : 0;
  const result = repair.apply(segF);

  return {
    store,
    remap: repair.remapTable(),
    segA: result.a,
    segB: result.b,
    segFeature: result.f,
    lineFeatures,
    skippedFeatures,
    invalidCoordinates,
    coordinates,
    mergedVertices,
    danglesSnapped,
    intersectionsSplit,
  };
}

const PARAM_EPS = 1e-9;

/**
 * Topology repair on the raw segment soup. Merges are recorded in a union-find and splits as
 * `(t, vertex)` requests per segment; both are applied at once by {@link apply}, so every detection
 * pass works on the original, stable segment ids.
 */
class ConnectivityRepair {
  private readonly parent: number[] = [];
  private readonly splits = new Map<number, number[]>();

  constructor(
    private readonly store: VertexStore,
    private readonly segA: number[],
    private readonly segB: number[],
    private readonly metric: Metric,
    private readonly tolerance: number,
  ) {
    for (let i = 0; i < store.size; i++) this.parent.push(i);
  }

  find(v: number): number {
    const p = this.parent;
    while (p[v] !== v) {
      p[v] = p[p[v]];
      v = p[v];
    }
    return v;
  }

  /** Merges `from` into `into` (the survivor keeps its coordinate). */
  union(from: number, into: number): boolean {
    const a = this.find(from);
    const b = this.find(into);
    if (a === b) return false;
    this.parent[a] = b;
    return true;
  }

  private addVertex(x: number, y: number): number {
    const id = this.store.getOrAdd([x, y]);
    while (this.parent.length < this.store.size) this.parent.push(this.parent.length);
    return this.find(id);
  }

  private addSplit(segment: number, t: number, vertex: number): void {
    let list = this.splits.get(segment);
    if (!list) {
      list = [];
      this.splits.set(segment, list);
    }
    list.push(t, vertex);
  }

  private segmentTree(): PackedRTree {
    const X = this.store.x;
    const Y = this.store.y;
    const tree = new PackedRTree(this.segA.length);
    for (let s = 0; s < this.segA.length; s++) {
      const a = this.find(this.segA[s]);
      const b = this.find(this.segB[s]);
      tree.add(Math.min(X[a], X[b]), Math.min(Y[a], Y[b]), Math.max(X[a], X[b]), Math.max(Y[a], Y[b]));
    }
    tree.finish();
    return tree;
  }

  /**
   * Connects dead ends (degree-1 vertices) to the nearest segment within `maxDistance`: the segment is
   * split at the projection and the dead end is moved onto it. Segments touching the dead end or its
   * only neighbour are ignored, otherwise short spurs would fold back onto their own line.
   */
  snapDangles(maxDistance: number): number {
    const { segA, segB, metric } = this;
    const X = this.store.x;
    const Y = this.store.y;
    const V = this.store.size;
    const degree = new Int32Array(V);
    for (let s = 0; s < segA.length; s++) {
      degree[segA[s]]++;
      degree[segB[s]]++;
    }
    const neighbour = new Int32Array(V).fill(-1);
    for (let s = 0; s < segA.length; s++) {
      if (degree[segA[s]] === 1) neighbour[segA[s]] = segB[s];
      if (degree[segB[s]] === 1) neighbour[segB[s]] = segA[s];
    }
    const tree = this.segmentTree();
    const proj: SegmentProjection = { t: 0, x: 0, y: 0 };
    let snapped = 0;

    for (let v = 0; v < V; v++) {
      if (degree[v] !== 1 || this.find(v) !== v) continue;
      const u = neighbour[v];
      const px = X[v];
      const py = Y[v];
      const { sx, sy } = localScale(metric, py);
      let best = -1;
      tree.nearest(
        px,
        py,
        sx,
        sy,
        (s) => {
          const a = segA[s];
          const b = segB[s];
          if (a === v || b === v || a === u || b === u) return Infinity;
          return projectToSegment(px, py, X[a], Y[a], X[b], Y[b], sx, sy, proj);
        },
        (s) => {
          best = s;
          return false;
        },
        maxDistance,
      );
      if (best === -1) continue;

      const a = segA[best];
      const b = segB[best];
      projectToSegment(px, py, X[a], Y[a], X[b], Y[b], sx, sy, proj);
      const length = Math.hypot((X[b] - X[a]) * sx, (Y[b] - Y[a]) * sy);
      const eps = this.tolerance > 0 ? this.tolerance : PARAM_EPS * (length || 1);
      let target: number;
      if (proj.t * length <= eps) target = a;
      else if ((1 - proj.t) * length <= eps) target = b;
      else {
        target = this.addVertex(proj.x, proj.y);
        if (target !== this.find(a) && target !== this.find(b)) this.addSplit(best, proj.t, target);
      }
      if (this.union(v, target)) snapped++;
    }
    return snapped;
  }

  /**
   * Nodes segments that cross (X) or touch (T) without sharing a vertex. Collinear overlaps are left
   * alone. Use it for data digitised without shared junction vertices — but note that it also joins
   * bridges and tunnels to whatever they pass over.
   */
  splitIntersections(): number {
    const { segA, segB } = this;
    const X = this.store.x;
    const Y = this.store.y;
    const tree = this.segmentTree();
    const hit: SegmentIntersection = { t: 0, u: 0 };
    let count = 0;

    for (let i = 0; i < segA.length; i++) {
      const a1 = this.find(segA[i]);
      const a2 = this.find(segB[i]);
      if (a1 === a2) continue;
      const x1 = X[a1];
      const y1 = Y[a1];
      const x2 = X[a2];
      const y2 = Y[a2];
      tree.search(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2), (j) => {
        if (j <= i) return;
        const b1 = this.find(segA[j]);
        const b2 = this.find(segB[j]);
        if (b1 === b2 || a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2) return;
        if (!intersectSegments(x1, y1, x2, y2, X[b1], Y[b1], X[b2], Y[b2], hit)) return;
        const tInside = hit.t > PARAM_EPS && hit.t < 1 - PARAM_EPS;
        const uInside = hit.u > PARAM_EPS && hit.u < 1 - PARAM_EPS;
        if (tInside && uInside) {
          const v = this.addVertex(x1 + hit.t * (x2 - x1), y1 + hit.t * (y2 - y1));
          this.addSplit(i, hit.t, v);
          this.addSplit(j, hit.u, v);
          count++;
        } else if (tInside) {
          this.addSplit(i, hit.t, hit.u <= PARAM_EPS ? b1 : b2);
          count++;
        } else if (uInside) {
          this.addSplit(j, hit.u, hit.t <= PARAM_EPS ? a1 : a2);
          count++;
        } else if (this.union(hit.u <= PARAM_EPS ? b1 : b2, hit.t <= PARAM_EPS ? a1 : a2)) {
          count++;
        }
      });
    }
    return count;
  }

  /** Applies merges and splits, returning the final segment arrays. */
  apply(segF: number[]): { a: Int32Array; b: Int32Array; f: Int32Array } {
    const outA: number[] = [];
    const outB: number[] = [];
    const outF: number[] = [];
    for (let s = 0; s < this.segA.length; s++) {
      const a = this.find(this.segA[s]);
      const b = this.find(this.segB[s]);
      const f = segF[s];
      const list = this.splits.get(s);
      if (!list) {
        if (a !== b) {
          outA.push(a);
          outB.push(b);
          outF.push(f);
        }
        continue;
      }
      const pairs: [number, number][] = [];
      for (let k = 0; k < list.length; k += 2) pairs.push([list[k], list[k + 1]]);
      pairs.sort((p, q) => p[0] - q[0]);
      let prev = a;
      for (const [, vertex] of pairs) {
        const w = this.find(vertex);
        if (w !== prev) {
          outA.push(prev);
          outB.push(w);
          outF.push(f);
          prev = w;
        }
      }
      if (b !== prev) {
        outA.push(prev);
        outB.push(b);
        outF.push(f);
      }
    }
    return { a: Int32Array.from(outA), b: Int32Array.from(outB), f: Int32Array.from(outF) };
  }

  remapTable(): Int32Array {
    const table = new Int32Array(this.store.size);
    for (let v = 0; v < table.length; v++) table[v] = this.find(v);
    return table;
  }
}
