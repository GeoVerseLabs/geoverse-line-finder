import { localScale, type Metric } from '../geo/metric';
import {
  intersectSegments,
  projectToSegment,
  type SegmentIntersection,
  type SegmentProjection,
} from '../geo/segment';
import { PackedRTree } from '../spatial/rtree';
import type { GeometryLike, NetworkCollection, NetworkFeature, Position } from '../types';
import { NO_GROUP, VertexStore } from './vertex-store';

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

/** A connectivity group key. */
export type GroupKey = string | number;

/**
 * Assigns a feature to a connectivity group (`null`/`undefined` = the default group), or to two groups as a
 * connector: `[startGroup, endGroup]` puts the first coordinate of every part into `startGroup` and the last
 * into `endGroup` — an elevator is a zero-length line whose two ends are in different floors. The interior
 * coordinates of a connector (the steps of a staircase) belong to no group: they are never merged with
 * other vertices, repaired, or matched by a `group` constraint.
 */
export type GroupFunction<P = unknown> = (
  properties: P,
  featureIndex: number,
  feature: NetworkFeature<P>,
) => GroupKey | readonly [GroupKey, GroupKey] | null | undefined;

/** A node identifier from the source data: an OSM node id, an OpenSidewalks `_id`, a GTFS `stop_id`… */
export type NodeKey = string | number;

/** Where a coordinate sits, for {@link NodeIdFunction}. */
export interface NodeIdContext<P = unknown> {
  readonly featureIndex: number;
  readonly feature: NetworkFeature<P>;
  /** Part index within a MultiLineString (`0` for a LineString or a point). */
  readonly part: number;
  /** Coordinate index within the part. */
  readonly index: number;
  /** `index` is the last coordinate of the part. */
  readonly last: boolean;
  readonly position: Position;
}

/**
 * Explicit topology: the node id of a coordinate, or `null` / `undefined` for none. Coordinates with the same
 * id (in the same connectivity group) are one vertex, however far apart they are; a coordinate without an id
 * is matched by its position (`tolerance`), as without this option. An id seen for the first time takes over
 * a vertex without an id at its position, so both kinds of data connect — but a vertex never takes a second
 * id: two ids at one position stay two vertices (a bridge over a road). Called for every valid coordinate
 * except the interior of a connector feature (see {@link GroupFunction}), and for the point of a
 * `pointConnector`.
 */
export type NodeIdFunction<P = unknown> = (
  properties: P,
  context: NodeIdContext<P>,
) => NodeKey | null | undefined;

/** Checks a node id returned by user code: `null` / `undefined` or a string / finite number. */
export function checkNodeKey(key: unknown, where: string): key is NodeKey {
  if (key === null || key === undefined) return false;
  if (typeof key === 'string' || (typeof key === 'number' && Number.isFinite(key))) return true;
  throw new TypeError(`Node ids must be strings or finite numbers, got ${String(key)} for ${where}.`);
}

export interface TopologyOptions {
  tolerance: number;
  snapDangles: number;
  splitIntersections: boolean;
  maxAbsLat: number;
  group?: GroupFunction<unknown>;
  nodeId?: NodeIdFunction<unknown>;
  /** Keep a log of repairs and invalid coordinates for `RoutingGraph.diagnostics()`. */
  recordDiagnostics?: boolean;
  /** Extra segments injected after the network's own (vertical connectors); see {@link SyntheticSegment}. */
  synthetic?: readonly SyntheticSegment[];
  /** Valid coordinates of the network ({@link NetworkScan.coordinates}); sizes the arrays up front. */
  coordinates?: number;
}

/**
 * A segment that is not digitised in the network: both ends join (or create) a vertex of their group, and
 * its costs are taken as given instead of from the weight function.
 */
export interface SyntheticSegment {
  /** Source feature: a synthesised one past the end of the input collection, or a point connector. */
  featureIndex: number;
  part: number;
  from: Position;
  fromGroup: GroupKey;
  /** Node id of the `from` stop (joins by id first, like a network coordinate). */
  fromKey?: NodeKey;
  to: Position;
  toGroup: GroupKey;
  toKey?: NodeKey;
  forward: number;
  backward: number;
}

export const REPAIR_MERGE = 0;
export const REPAIR_DANGLE = 1;
export const REPAIR_SPLIT = 2;

/** Column-wise repair log (see `graph/diagnostics.ts`). */
export interface RepairLog {
  kind: number[];
  x: number[];
  y: number[];
  featureA: number[];
  featureB: number[];
  gap: number[];
}

/** Undirected segment soup after vertex merging and connectivity repair. */
export interface Topology {
  store: VertexStore;
  /** Final vertex id for every stored vertex (identity unless it was merged away by repair). */
  remap: Int32Array;
  segA: Int32Array;
  segB: Int32Array;
  segFeature: Int32Array;
  /**
   * Part index within a MultiLineString (`0` for LineStrings). Segments come out in feature, part and
   * coordinate order (splits in parameter order), which is what measures are accumulated along.
   */
  segPart: Int32Array;
  /** Index into `options.synthetic` for injected segments, `-1` for segments of the input network. */
  segSynthetic: Int32Array;
  /** Group keys by index; index 0 is the default group (`undefined`). */
  groupKeys: (GroupKey | undefined)[];
  lineFeatures: number;
  skippedFeatures: number;
  invalidCoordinates: number;
  coordinates: number;
  mergedVertices: number;
  danglesSnapped: number;
  intersectionsSplit: number;
  repairs: RepairLog | null;
  /** `(featureIndex, partIndex, coordinateIndex)` triples of invalid coordinates, when recording. */
  invalid: number[] | null;
}

export function buildTopology(
  network: NetworkCollection<unknown>,
  metric: Metric,
  options: TopologyOptions,
): Topology {
  const synthetic = options.synthetic;
  const syntheticCount = synthetic ? synthetic.length : 0;
  const coordinateCount = options.coordinates ?? scanNetwork(network).coordinates;
  const store = new VertexStore({
    tolerance: options.tolerance,
    geographic: metric.geographic,
    maxAbsLat: options.maxAbsLat,
    capacity: coordinateCount + 2 * syntheticCount,
  });
  // Every valid coordinate adds at most one segment, every synthetic link exactly one.
  const capacity = coordinateCount + syntheticCount;
  const segA = new Int32Array(capacity);
  const segB = new Int32Array(capacity);
  const segF = new Int32Array(capacity);
  const segP = new Int32Array(capacity);
  const segS = new Int32Array(capacity);
  let S = 0;
  let lineFeatures = 0;
  let skippedFeatures = 0;
  let invalidCoordinates = 0;
  let coordinates = 0;

  const recording = options.recordDiagnostics === true;
  const repairs: RepairLog | null = recording
    ? { kind: [], x: [], y: [], featureA: [], featureB: [], gap: [] }
    : null;
  const invalid: number[] | null = recording ? [] : null;
  /** First feature of every vertex (only kept while recording, for merge reports). */
  const vertexFeature: number[] = [];

  const groupKeys: (GroupKey | undefined)[] = [undefined];
  const groupIndex = new Map<GroupKey, number>();
  const groupOf = (key: GroupKey | null | undefined): number => {
    if (key === null || key === undefined) return 0;
    if (typeof key !== 'string' && typeof key !== 'number') {
      throw new TypeError(`Group keys must be strings or numbers, got ${String(key)}.`);
    }
    let index = groupIndex.get(key);
    if (index === undefined) {
      index = groupKeys.length;
      groupKeys.push(key);
      groupIndex.set(key, index);
    }
    return index;
  };
  const geographic = metric.geographic;
  const nodeId = options.nodeId;

  const features = network.features;
  for (let fi = 0; fi < features.length; fi++) {
    const feature = features[fi];
    const parts = lineParts(feature?.geometry);
    if (!parts) {
      skippedFeatures++;
      continue;
    }
    lineFeatures++;
    let startGroup = 0;
    let endGroup = 0;
    if (options.group) {
      const g = options.group(feature.properties, fi, feature);
      if (Array.isArray(g)) {
        startGroup = groupOf(g[0] as GroupKey);
        endGroup = groupOf(g[1] as GroupKey);
      } else {
        startGroup = endGroup = groupOf(g as GroupKey | null | undefined);
      }
    }
    const connector = startGroup !== endGroup;
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi];
      if (!Array.isArray(part)) continue;
      let firstValid = -1;
      let lastValid = -1;
      if (connector) {
        firstValid = part.findIndex(isPosition);
        for (let ci = part.length - 1; ci >= 0; ci--) {
          if (isPosition(part[ci])) {
            lastValid = ci;
            break;
          }
        }
      }
      let prev = -1;
      let prevPos: Position | null = null;
      for (let ci = 0; ci < part.length; ci++) {
        const c: unknown = part[ci];
        if (!isPosition(c)) {
          // An invalid coordinate breaks the line instead of bridging across it.
          invalidCoordinates++;
          invalid?.push(fi, pi, ci);
          prev = -1;
          continue;
        }
        if (geographic && prevPos && Math.abs(c[0] - prevPos[0]) > 180) {
          throw new RangeError(
            `Feature #${fi} has a segment spanning more than 180° of longitude (antimeridian crossing), ` +
              'which geographic metrics do not support.',
          );
        }
        coordinates++;
        if (connector && ci !== firstValid && ci !== lastValid) {
          // Interior of a connector: a vertex of its own (only a repeated coordinate reuses the previous one),
          // so a staircase neither merges with the floor it passes over nor folds onto its own flights.
          const id =
            prev !== -1 && c[0] === prevPos![0] && c[1] === prevPos![1]
              ? prev
              : store.append(c[0], c[1], c, NO_GROUP);
          if (repairs && id !== prev) vertexFeature.push(fi);
          if (prev !== -1 && id !== prev) {
            segA[S] = prev;
            segB[S] = id;
            segF[S] = fi;
            segP[S] = pi;
            segS[S++] = -1;
          }
          prev = id;
          prevPos = c;
          continue;
        }
        const before = store.size;
        const g = ci === lastValid ? endGroup : startGroup;
        let id: number;
        if (nodeId) {
          const key = nodeId(feature.properties, {
            featureIndex: fi,
            feature,
            part: pi,
            index: ci,
            last: ci === part.length - 1,
            position: c,
          });
          id = checkNodeKey(key, `coordinate ${ci} of feature #${fi}`)
            ? store.getOrAddKeyed(c, g, key)
            : store.getOrAdd(c, g);
        } else {
          id = store.getOrAdd(c, g);
        }
        if (repairs) {
          if (id === before) vertexFeature.push(fi);
          else if (store.lastDistance > 0) {
            logRepair(repairs, REPAIR_MERGE, c[0], c[1], fi, vertexFeature[id], store.lastDistance);
          }
        }
        if (prev !== -1 && id !== prev) {
          segA[S] = prev;
          segB[S] = id;
          segF[S] = fi;
          segP[S] = pi;
          segS[S++] = -1;
        }
        prev = id;
        prevPos = c;
      }
    }
  }

  // Vertical connectors: a stop joins the level it serves exactly like a digitised end coordinate, so
  // merging, `tolerance` and `snapDangles` attach it to the floor network in the usual way.
  // A stop with a node id joins by id first, like a network coordinate.
  const stop = (position: Position, group: GroupKey, key: NodeKey | undefined) =>
    key === undefined
      ? store.getOrAdd(position, groupOf(group))
      : store.getOrAddKeyed(position, groupOf(group), key);
  for (let i = 0; i < syntheticCount; i++) {
    const link = synthetic![i];
    const a = stop(link.from, link.fromGroup, link.fromKey);
    const b = stop(link.to, link.toGroup, link.toKey);
    if (a === b) continue;
    segA[S] = a;
    segB[S] = b;
    segF[S] = link.featureIndex;
    segP[S] = link.part;
    segS[S++] = i;
  }

  const mergedVertices = store.merged;
  let danglesSnapped = 0;
  let intersectionsSplit = 0;
  let result: SegmentArrays;
  let remap: Int32Array;
  if (options.snapDangles > 0 || options.splitIntersections) {
    const repair = new ConnectivityRepair(store, S, segA, segB, segF, metric, options.tolerance, repairs);
    if (options.snapDangles > 0) danglesSnapped = repair.snapDangles(options.snapDangles);
    if (options.splitIntersections) intersectionsSplit = repair.splitIntersections();
    result = repair.apply(segP, segS);
    remap = repair.remapTable();
  } else {
    // Nothing merges after the fact: every vertex is its own final vertex and no segment collapses.
    result = {
      a: segA.subarray(0, S),
      b: segB.subarray(0, S),
      f: segF.subarray(0, S),
      p: segP.subarray(0, S),
      s: segS.subarray(0, S),
    };
    remap = new Int32Array(store.size);
    for (let v = 0; v < remap.length; v++) remap[v] = v;
  }

  return {
    store,
    remap,
    segA: result.a,
    segB: result.b,
    segFeature: result.f,
    segPart: result.p,
    segSynthetic: result.s,
    groupKeys,
    lineFeatures,
    skippedFeatures,
    invalidCoordinates,
    coordinates,
    mergedVertices,
    danglesSnapped,
    intersectionsSplit,
    repairs,
    invalid,
  };
}

function logRepair(
  log: RepairLog,
  kind: number,
  x: number,
  y: number,
  featureA: number,
  featureB: number,
  gap: number,
): void {
  log.kind.push(kind);
  log.x.push(x);
  log.y.push(y);
  log.featureA.push(featureA);
  log.featureB.push(featureB);
  log.gap.push(gap);
}

const PARAM_EPS = 1e-9;

interface SegmentArrays {
  a: Int32Array;
  b: Int32Array;
  f: Int32Array;
  p: Int32Array;
  s: Int32Array;
}

/**
 * Topology repair on the raw segment soup. Merges are recorded in a union-find and splits as
 * `(t, vertex)` requests per segment; both are applied at once by {@link apply}, so every detection
 * pass works on the original, stable segment ids. Repairs never connect different groups, and never touch
 * the group-less interior of connectors.
 */
class ConnectivityRepair {
  private parent: Int32Array;
  private readonly splits = new Map<number, number[]>();
  private splitCount = 0;
  private readonly grouped: boolean;

  /** Segments `[0, count)` of the arrays are the network; the arrays may be longer. */
  constructor(
    private readonly store: VertexStore,
    private readonly count: number,
    private readonly segA: Int32Array,
    private readonly segB: Int32Array,
    private readonly segF: Int32Array,
    private readonly metric: Metric,
    private readonly tolerance: number,
    private readonly log: RepairLog | null,
  ) {
    const V = store.size;
    this.parent = new Int32Array(Math.max(16, V + (V >> 2)));
    for (let i = 0; i < this.parent.length; i++) this.parent[i] = i;
    let grouped = false;
    for (let v = 0; v < V && !grouped; v++) grouped = store.group[v] !== 0;
    this.grouped = grouped;
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

  private addVertex(x: number, y: number, group: number): number {
    const id = this.store.getOrAdd([x, y], group);
    if (id >= this.parent.length) {
      const parent = new Int32Array(this.parent.length * 2);
      parent.set(this.parent);
      for (let i = this.parent.length; i < parent.length; i++) parent[i] = i;
      this.parent = parent;
    }
    return this.find(id);
  }

  private addSplit(segment: number, t: number, vertex: number): void {
    let list = this.splits.get(segment);
    if (!list) {
      list = [];
      this.splits.set(segment, list);
    }
    list.push(t, vertex);
    this.splitCount++;
  }

  private segmentTree(): PackedRTree {
    const X = this.store.x;
    const Y = this.store.y;
    const tree = new PackedRTree(this.count);
    for (let s = 0; s < this.count; s++) {
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
    const { segA, segB, segF, metric, grouped, count: S } = this;
    // Only vertices that exist now are read through these (see VertexStore.x).
    const X = this.store.x;
    const Y = this.store.y;
    const G = this.store.group;
    const V = this.store.size;
    const degree = new Int32Array(V);
    for (let s = 0; s < S; s++) {
      degree[segA[s]]++;
      degree[segB[s]]++;
    }
    const neighbour = new Int32Array(V).fill(-1);
    const ownSegment = new Int32Array(V).fill(-1);
    for (let s = 0; s < S; s++) {
      if (degree[segA[s]] === 1) {
        neighbour[segA[s]] = segB[s];
        ownSegment[segA[s]] = s;
      }
      if (degree[segB[s]] === 1) {
        neighbour[segB[s]] = segA[s];
        ownSegment[segB[s]] = s;
      }
    }
    const tree = this.segmentTree();
    const proj: SegmentProjection = { t: 0, x: 0, y: 0 };
    let snapped = 0;

    for (let v = 0; v < V; v++) {
      if (degree[v] !== 1 || this.find(v) !== v) continue;
      const u = neighbour[v];
      const gv = G[v];
      if (gv === NO_GROUP) continue; // a connector broken inside (invalid coordinate) is not repaired
      const px = X[v];
      const py = Y[v];
      const { sx, sy } = localScale(metric, py);
      let best = -1;
      let gap = 0;
      tree.nearest(
        px,
        py,
        sx,
        sy,
        (s) => {
          const a = segA[s];
          const b = segB[s];
          if (a === v || b === v || a === u || b === u) return Infinity;
          if (grouped && (G[a] !== gv || G[b] !== gv)) return Infinity;
          return projectToSegment(px, py, X[a], Y[a], X[b], Y[b], sx, sy, proj);
        },
        (s, distance) => {
          best = s;
          gap = distance;
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
      let split = false;
      if (proj.t * length <= eps) target = a;
      else if ((1 - proj.t) * length <= eps) target = b;
      else {
        target = this.addVertex(proj.x, proj.y, gv);
        if (target !== this.find(a) && target !== this.find(b)) {
          this.addSplit(best, proj.t, target);
          split = true;
        }
      }
      // A dead end lying exactly on the segment (zero gap) is already its own projection: the union is a
      // no-op, but the split still creates the connection, so it counts.
      if (this.union(v, target) || split) {
        snapped++;
        if (this.log)
          logRepair(this.log, REPAIR_DANGLE, proj.x, proj.y, segF[ownSegment[v]], segF[best], gap);
      }
    }
    return snapped;
  }

  /**
   * Nodes segments that cross (X) or touch (T) without sharing a vertex. Collinear overlaps are left
   * alone. Use it for data digitised without shared junction vertices — but note that it also joins
   * bridges and tunnels to whatever they pass over (put them in separate groups to prevent that).
   */
  splitIntersections(): number {
    const { segA, segB, segF, grouped, count: S } = this;
    // Split points created below are never read through these: they only become split requests, and no
    // existing vertex is merged into one of them in this pass (see VertexStore.x).
    const X = this.store.x;
    const Y = this.store.y;
    const G = this.store.group;
    const tree = this.segmentTree();
    const hit: SegmentIntersection = { t: 0, u: 0 };
    let count = 0;

    for (let i = 0; i < S; i++) {
      const a1 = this.find(segA[i]);
      const a2 = this.find(segB[i]);
      if (a1 === a2) continue;
      // Connectors (segments between groups, and their group-less interior) are never noded.
      if (grouped && (G[a1] !== G[a2] || G[a1] === NO_GROUP)) continue;
      const x1 = X[a1];
      const y1 = Y[a1];
      const x2 = X[a2];
      const y2 = Y[a2];
      tree.search(Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2), (j) => {
        if (j <= i) return;
        const b1 = this.find(segA[j]);
        const b2 = this.find(segB[j]);
        if (b1 === b2 || a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2) return;
        if (grouped && (G[b1] !== G[a1] || G[b2] !== G[a1])) return;
        if (!intersectSegments(x1, y1, x2, y2, X[b1], Y[b1], X[b2], Y[b2], hit)) return;
        const tInside = hit.t > PARAM_EPS && hit.t < 1 - PARAM_EPS;
        const uInside = hit.u > PARAM_EPS && hit.u < 1 - PARAM_EPS;
        let noded = false;
        if (tInside && uInside) {
          const v = this.addVertex(x1 + hit.t * (x2 - x1), y1 + hit.t * (y2 - y1), G[a1]);
          this.addSplit(i, hit.t, v);
          this.addSplit(j, hit.u, v);
          noded = true;
        } else if (tInside) {
          this.addSplit(i, hit.t, hit.u <= PARAM_EPS ? b1 : b2);
          noded = true;
        } else if (uInside) {
          this.addSplit(j, hit.u, hit.t <= PARAM_EPS ? a1 : a2);
          noded = true;
        } else if (this.union(hit.u <= PARAM_EPS ? b1 : b2, hit.t <= PARAM_EPS ? a1 : a2)) {
          noded = true;
        }
        if (noded) {
          count++;
          if (this.log) {
            logRepair(
              this.log,
              REPAIR_SPLIT,
              x1 + hit.t * (x2 - x1),
              y1 + hit.t * (y2 - y1),
              segF[i],
              segF[j],
              0,
            );
          }
        }
      });
    }
    return count;
  }

  /**
   * Applies merges and splits, returning the final segment arrays. Segments keep their input order and the
   * pieces of a split segment follow its direction, so each feature part stays contiguous and ordered.
   */
  apply(part: Int32Array, synthetic: Int32Array): SegmentArrays {
    // A segment with k split requests becomes at most k + 1 pieces.
    const capacity = this.count + this.splitCount;
    const outA = new Int32Array(capacity);
    const outB = new Int32Array(capacity);
    const outF = new Int32Array(capacity);
    const outP = new Int32Array(capacity);
    const outS = new Int32Array(capacity);
    let n = 0;
    const emit = (from: number, to: number, s: number) => {
      outA[n] = from;
      outB[n] = to;
      outF[n] = this.segF[s];
      outP[n] = part[s];
      outS[n++] = synthetic[s];
    };
    for (let s = 0; s < this.count; s++) {
      const a = this.find(this.segA[s]);
      const b = this.find(this.segB[s]);
      const list = this.splits.get(s);
      if (!list) {
        if (a !== b) emit(a, b, s);
        continue;
      }
      const pairs: [number, number][] = [];
      for (let k = 0; k < list.length; k += 2) pairs.push([list[k], list[k + 1]]);
      pairs.sort((p, q) => p[0] - q[0]);
      let prev = a;
      for (const [, vertex] of pairs) {
        const w = this.find(vertex);
        if (w !== prev) {
          emit(prev, w, s);
          prev = w;
        }
      }
      if (b !== prev) emit(prev, b, s);
    }
    return {
      a: outA.subarray(0, n),
      b: outB.subarray(0, n),
      f: outF.subarray(0, n),
      p: outP.subarray(0, n),
      s: outS.subarray(0, n),
    };
  }

  remapTable(): Int32Array {
    const table = new Int32Array(this.store.size);
    for (let v = 0; v < table.length; v++) table[v] = this.find(v);
    return table;
  }
}
