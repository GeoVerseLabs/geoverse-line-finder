import type { Metric } from '../geo/metric';
import { PackedRTree } from '../spatial/rtree';
import type { NetworkFeature, Position } from '../types';
import type { GraphSettings } from './build';
import { diagnoseGraph, type DiagnosticsOptions, type GraphDiagnostics } from './diagnostics';
import type { LevelTable } from './levels';
import { strongComponents, type StrongComponents } from './scc';
import {
  graphFromTransferable,
  graphToTransferable,
  type DeserializeOptions,
  type SerializeOptions,
  type TransferableGraph,
} from './serialize';
import type { GroupKey, RepairLog } from './topology';
import { NO_GROUP, type VertexStore } from './vertex-store';

export interface GraphStats {
  /** Features in the input collection. */
  features: number;
  /** Features with a `LineString` / `MultiLineString` geometry. */
  lineFeatures: number;
  /** Features skipped because their geometry is not routable (points, polygons, null…). */
  skippedFeatures: number;
  /** Non-finite or malformed coordinates; each one breaks its line. */
  invalidCoordinates: number;
  /** Valid input coordinates. */
  coordinates: number;
  /** Distinct vertices that belong to at least one passable segment. */
  vertices: number;
  /** Input coordinates merged into an existing vertex (exact duplicates or within `tolerance`). */
  mergedVertices: number;
  /** Dead ends connected by `snapDangles` (including dead ends that already touched a segment). */
  danglesSnapped: number;
  /** Crossings / touches noded by `splitIntersections`. */
  intersectionsSplit: number;
  /** Segments after repair. */
  segments: number;
  /** Segments impassable in both directions (dropped). */
  impassableSegments: number;
  /** Segments passable in exactly one direction. */
  oneWaySegments: number;
  /** Graph nodes (junctions and dead ends). */
  nodes: number;
  /** Chains of segments between nodes. */
  chains: number;
  /** Directed edges in the search graph. */
  edges: number;
  /** Weakly connected components. */
  components: number;
  largestComponentNodes: number;
  /** Connectivity groups (1 unless the `group` option is used). */
  groups: number;
  /** Features synthesised from `verticalConnectors` (appended after the input collection). */
  verticalConnectors: number;
}

export interface VertexTable {
  readonly count: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Output coordinate of each vertex (the original input object where one exists). */
  readonly positions: readonly Position[];
  /** Node id, or -1 for interior chain vertices and dead vertices. */
  readonly node: Int32Array;
  /** Chain id for interior chain vertices, -1 otherwise. */
  readonly chain: Int32Array;
  /** Vertex index within its chain (interior vertices only). */
  readonly chainPos: Int32Array;
  /**
   * Group index per vertex (see {@link RoutingGraph.groupKeys}), `-1` for the interior of connector features;
   * `null` when the graph has one group.
   */
  readonly group: Int32Array | null;
  /**
   * Height of every vertex, from the `levels` elevations and interpolated by length inside a connector;
   * `NaN` where unknown, `null` when no level carries an elevation.
   */
  readonly elevation: Float64Array | null;
}

export interface NodeTable {
  readonly count: number;
  readonly vertex: Int32Array;
  readonly component: Int32Array;
  /** Metric embedding (`heuristic.dims` values per node) for the A* heuristic. */
  readonly embedding: Float64Array;
}

export interface ChainTable {
  readonly count: number;
  readonly from: Int32Array;
  readonly to: Int32Array;
  /** Chain `c` owns segment slots `[segStart[c], segStart[c + 1])`; length `count + 1`. */
  readonly segStart: Int32Array;
  /** Vertex ids along chains; chain `c` starts at `segStart[c] + c`. */
  readonly vertices: Int32Array;
  /** Cost of traversing the whole chain from→to / to→from (`Infinity` = impassable). */
  readonly forward: Float64Array;
  readonly backward: Float64Array;
  readonly length: Float64Array;
  readonly component: Int32Array;
}

export interface SegmentTable {
  readonly count: number;
  readonly chain: Int32Array;
  /** Cost along / against the chain direction. */
  readonly forward: Float64Array;
  readonly backward: Float64Array;
  readonly length: Float64Array;
  readonly feature: Int32Array;
  /**
   * Measure at the segment's start / end in chain direction: metric length along the source feature's part
   * from its first coordinate, accumulated over the graph's segments (after merging and splitting), so
   * measures add up exactly to route distances. Gaps left by invalid coordinates add no length.
   */
  readonly measureStart: Float64Array;
  readonly measureEnd: Float64Array;
  /** Part index within a MultiLineString (0 for LineStrings). */
  readonly part: Int32Array;
  /** 1 when the chain runs against the feature's digitised direction on this segment. */
  readonly reversed: Uint8Array;
}

/** Compressed sparse row adjacency of the directed search graph. */
export interface EdgeTable {
  readonly count: number;
  /** Length `nodes.count + 1`. */
  readonly offsets: Int32Array;
  readonly targets: Int32Array;
  readonly costs: Float64Array;
  /** `(chain << 1) | reversed` for every edge. */
  readonly ref: Int32Array;
}

/** Incoming adjacency: for node `n`, entries `[offsets[n], offsets[n + 1])` are edges ending at `n`. */
export interface ReverseEdgeTable {
  readonly offsets: Int32Array;
  readonly sources: Int32Array;
  readonly costs: Float64Array;
  /** Forward edge id of every entry. */
  readonly edges: Int32Array;
}

/** Chains touching each node: entries `[offsets[n], offsets[n + 1])`; `atStart` = the chain starts there. */
export interface NodeChainTable {
  readonly offsets: Int32Array;
  readonly chains: Int32Array;
  readonly atStart: Uint8Array;
}

export interface ComponentTable {
  readonly count: number;
  readonly nodes: Int32Array;
  /** Total chain length per component (metric units). */
  readonly length: Float64Array;
  /** Component with the greatest total length, or -1 for an empty graph. */
  readonly largest: number;
}

/** Recorded by `buildGraph` with `diagnostics: true`. */
export interface DiagnosticsLog {
  readonly repairs: RepairLog;
  /** `(featureIndex, partIndex, coordinateIndex)` triples. */
  readonly invalid: Int32Array;
}

export interface RoutingGraphParts<P> {
  metric: Metric;
  /** Latitude the metric was resolved for (cheap-ruler). */
  referenceLat: number;
  features: readonly NetworkFeature<P>[];
  stats: GraphStats;
  vertices: VertexTable;
  nodes: NodeTable;
  chains: ChainTable;
  segments: SegmentTable;
  edges: EdgeTable;
  components: ComponentTable;
  heuristic: { dims: number; scale: number; perLevel: number };
  segmentIndex: PackedRTree;
  store: VertexStore;
  remap: Int32Array;
  groupKeys: readonly (GroupKey | undefined)[];
  levels: LevelTable | null;
  syntheticFeatures: number;
  settings: GraphSettings;
  diagnosticsLog: DiagnosticsLog | null;
}

/**
 * Immutable, query-independent routing graph. Everything is stored in flat typed arrays so a graph can be
 * built once and shared by any number of {@link LineFinder} instances (or engines). Derived indexes
 * (strong components, reverse adjacency, spatial indexes over vertices and nodes) are built lazily.
 */
export class RoutingGraph<P = unknown> {
  readonly metric: Metric;
  /** Latitude the metric was resolved for (used by `'cheap-ruler'`). */
  readonly referenceLat: number;
  readonly features: readonly NetworkFeature<P>[];
  readonly stats: Readonly<GraphStats>;
  readonly vertices: VertexTable;
  readonly nodes: NodeTable;
  readonly chains: ChainTable;
  readonly segments: SegmentTable;
  readonly edges: EdgeTable;
  readonly components: ComponentTable;
  /**
   * A* support: embedding dimension, the admissible cost-per-metric-unit scale, and `perLevel` — the
   * cheapest cost of crossing one level over every connector (0 = no level term). All 0 = unavailable.
   */
  readonly heuristic: { readonly dims: number; readonly scale: number; readonly perLevel: number };
  /** R-tree over chain segments, used for snapping. */
  readonly segmentIndex: PackedRTree;
  /** Connectivity group keys by index; index 0 is the default group (`undefined`). */
  readonly groupKeys: readonly (GroupKey | undefined)[];
  /** Level metadata per group, or `null` when the graph was built without `levels`. */
  readonly levels: LevelTable | null;
  /** Features at the end of {@link features} that were synthesised from `verticalConnectors`. */
  readonly syntheticFeatures: number;
  readonly settings: GraphSettings;
  /** @internal */
  readonly diagnosticsLog: DiagnosticsLog | null;
  /** @internal */
  readonly store: VertexStore;
  /** @internal */
  readonly remap: Int32Array;
  private vertexTree: { tree: PackedRTree; items: Int32Array } | null = null;
  private nodeTree: PackedRTree | null = null;
  private groupTrees: Map<number, { tree: PackedRTree; items: Int32Array }> | null = null;
  private scc: StrongComponents | null = null;
  private reverse: ReverseEdgeTable | null = null;
  private incident: NodeChainTable | null = null;
  private ordinals: Float64Array | null = null;

  constructor(parts: RoutingGraphParts<P>) {
    this.metric = parts.metric;
    this.referenceLat = parts.referenceLat;
    this.features = parts.features;
    this.stats = parts.stats;
    this.vertices = parts.vertices;
    this.nodes = parts.nodes;
    this.chains = parts.chains;
    this.segments = parts.segments;
    this.edges = parts.edges;
    this.components = parts.components;
    this.heuristic = parts.heuristic;
    this.segmentIndex = parts.segmentIndex;
    this.store = parts.store;
    this.remap = parts.remap;
    this.groupKeys = parts.groupKeys;
    this.levels = parts.levels;
    this.syntheticFeatures = parts.syntheticFeatures;
    this.settings = parts.settings;
    this.diagnosticsLog = parts.diagnosticsLog;
  }

  segmentCountOf(chain: number): number {
    return this.chains.segStart[chain + 1] - this.chains.segStart[chain];
  }

  /** Coordinate at fractional `position` (segment index + t) along `chain`. */
  pointAt(chain: number, position: number): Position {
    const base = this.chains.segStart[chain] + chain;
    const i = Math.floor(position);
    const f = position - i;
    const verts = this.chains.vertices;
    const positions = this.vertices.positions;
    if (f === 0) return positions[verts[base + i]];
    const a = positions[verts[base + i]];
    const b = positions[verts[base + i + 1]];
    const out = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    if (a.length > 2 && b.length > 2) out.push(a[2] + (b[2] - a[2]) * f);
    return out;
  }

  /** Measure along the source feature at fractional `position` of `chain` (see {@link SegmentTable}). */
  measureAt(chain: number, position: number): number {
    const n = this.segmentCountOf(chain);
    const i = Math.min(Math.floor(position), n - 1);
    const slot = this.chains.segStart[chain] + i;
    const f = position - i;
    const { measureStart, measureEnd } = this.segments;
    return f === 0 ? measureStart[slot] : measureStart[slot] + f * (measureEnd[slot] - measureStart[slot]);
  }

  /** `feature.id`, falling back to `properties.id`. */
  featureId(featureIndex: number): string | number | undefined {
    const feature = this.features[featureIndex];
    if (!feature) return undefined;
    if (feature.id !== undefined) return feature.id;
    const props = feature.properties as { id?: unknown } | null | undefined;
    const id = props && typeof props === 'object' ? props.id : undefined;
    return typeof id === 'string' || typeof id === 'number' ? id : undefined;
  }

  /** Group index of a key, or -1. `undefined` is the default group 0. */
  groupIndex(key: GroupKey | undefined): number {
    return this.groupKeys.indexOf(key);
  }

  /** Whether a vertex is part of the routable graph. */
  isLiveVertex(vertex: number): boolean {
    return this.vertices.node[vertex] >= 0 || this.vertices.chain[vertex] >= 0;
  }

  /** Group index of a vertex: 0 in a single-group graph, `-1` inside a connector. */
  vertexGroup(vertex: number): number {
    return this.vertices.group ? this.vertices.group[vertex] : 0;
  }

  /** Storey number of a group index, or `NaN` without levels / for the connector interior (`-1`). */
  groupOrdinal(group: number): number {
    return this.levels && group >= 0 ? this.levels.ordinal[group] : NaN;
  }

  /** Group index of a location on `chain` at fractional `position` (`-1` inside a connector). */
  levelAt(chain: number, position: number): number {
    if (!this.vertices.group) return 0;
    const n = this.segmentCountOf(chain);
    const i = Math.min(Math.max(Math.floor(position), 0), n - 1);
    const base = this.chains.segStart[chain];
    if (position === i) return this.vertexGroup(this.chains.vertices[base + chain + i]);
    if (position === i + 1) return this.vertexGroup(this.chains.vertices[base + chain + i + 1]);
    return this.segmentGroup(base + i);
  }

  /** Height of a location on `chain`, interpolated inside the segment; `NaN` when unknown. */
  elevationAt(chain: number, position: number): number {
    const elevation = this.vertices.elevation;
    if (!elevation) return NaN;
    const n = this.segmentCountOf(chain);
    const i = Math.min(Math.max(Math.floor(position), 0), n - 1);
    const base = this.chains.segStart[chain] + chain;
    const a = elevation[this.chains.vertices[base + i]];
    const f = position - i;
    if (f === 0) return a;
    const b = elevation[this.chains.vertices[base + i + 1]];
    return f === 1 ? b : a + (b - a) * f;
  }

  /** Storey number of every node (computed once, lazily); `NaN` where unknown. */
  nodeOrdinals(): Float64Array {
    if (!this.ordinals) {
      const out = new Float64Array(this.nodes.count).fill(NaN);
      if (this.levels) {
        for (let n = 0; n < out.length; n++)
          out[n] = this.groupOrdinal(this.vertexGroup(this.nodes.vertex[n]));
      }
      this.ordinals = out;
    }
    return this.ordinals;
  }

  /**
   * Group index of the locations strictly inside segment `slot`: the group of both its ends, or
   * `-1` for a segment of a connector (its ends lie in different groups or in none).
   */
  segmentGroup(slot: number): number {
    const group = this.vertices.group;
    if (!group) return 0;
    const c = this.segments.chain[slot];
    const a = group[this.chains.vertices[slot + c]];
    return a === group[this.chains.vertices[slot + c + 1]] ? a : NO_GROUP;
  }

  /**
   * Vertex at (or within `tolerance` of) a coordinate, after connectivity repair; -1 when none. Without
   * `group` every group is searched in order.
   */
  findVertex(x: number, y: number, group?: GroupKey): number {
    if (group !== undefined) {
      const g = this.groupIndex(group);
      const v = g < 0 ? -1 : this.store.find(x, y, g);
      return v === -1 ? -1 : this.remap[v];
    }
    for (let g = 0; g < this.groupKeys.length; g++) {
      const v = this.store.find(x, y, g);
      if (v !== -1) return this.remap[v];
    }
    return -1;
  }

  /** Lazily built R-tree over all live vertices (for `snap.mode = 'vertex'`). */
  vertexSpatialIndex(): { tree: PackedRTree; items: Int32Array } {
    if (!this.vertexTree) {
      const { x, y, count } = this.vertices;
      const items: number[] = [];
      for (let v = 0; v < count; v++) if (this.isLiveVertex(v)) items.push(v);
      const tree = new PackedRTree(items.length);
      for (const v of items) tree.add(x[v], y[v], x[v], y[v]);
      tree.finish();
      this.vertexTree = { tree, items: Int32Array.from(items) };
    }
    return this.vertexTree;
  }

  /** Lazily built R-tree over graph nodes (for `snap.mode = 'node'`). */
  nodeSpatialIndex(): PackedRTree {
    if (!this.nodeTree) {
      const { x, y } = this.vertices;
      const { vertex, count } = this.nodes;
      const tree = new PackedRTree(count);
      for (let n = 0; n < count; n++) {
        const v = vertex[n];
        tree.add(x[v], y[v], x[v], y[v]);
      }
      tree.finish();
      this.nodeTree = tree;
    }
    return this.nodeTree;
  }

  /**
   * Lazily built R-tree over what can hold a location of group index `group`: segments with at least one end
   * in it, or its live vertices, or its nodes. `items` maps tree items to segment slots, vertex ids or node
   * ids. A group-constrained snap scans this instead of the whole network, so locations of other groups
   * (floors stacked on top of each other) neither cost scan budget nor hide the allowed ones.
   */
  groupSpatialIndex(
    kind: 'segment' | 'vertex' | 'node',
    group: number,
  ): { tree: PackedRTree; items: Int32Array } {
    const key = group * 3 + (kind === 'segment' ? 0 : kind === 'vertex' ? 1 : 2);
    this.groupTrees ??= new Map();
    let entry = this.groupTrees.get(key);
    if (entry) return entry;
    const { x, y } = this.vertices;
    const cv = this.chains.vertices;
    const segChain = this.segments.chain;
    const nodeVertex = this.nodes.vertex;
    // Item i spans vertices ends(i) = [a, b] (a === b for vertices and nodes).
    let a = 0;
    let b = 0;
    const ends = (i: number): void => {
      if (kind === 'segment') {
        a = cv[i + segChain[i]];
        b = cv[i + segChain[i] + 1];
      } else a = b = kind === 'vertex' ? i : nodeVertex[i];
    };
    const count =
      kind === 'segment' ? this.segments.count : kind === 'vertex' ? this.vertices.count : this.nodes.count;
    const items: number[] = [];
    for (let i = 0; i < count; i++) {
      ends(i);
      if (kind === 'vertex' && !this.isLiveVertex(i)) continue;
      if (this.vertexGroup(a) === group || this.vertexGroup(b) === group) items.push(i);
    }
    const tree = new PackedRTree(items.length);
    for (const i of items) {
      ends(i);
      tree.add(Math.min(x[a], x[b]), Math.min(y[a], y[b]), Math.max(x[a], x[b]), Math.max(y[a], y[b]));
    }
    tree.finish();
    entry = { tree, items: Int32Array.from(items) };
    this.groupTrees.set(key, entry);
    return entry;
  }

  /** Strongly connected components of the directed graph (computed once, lazily). */
  strongComponents(): StrongComponents {
    this.scc ??= strongComponents(this.nodes.count, this.edges.offsets, this.edges.targets);
    return this.scc;
  }

  /** Incoming adjacency (computed once, lazily). */
  reverseEdges(): ReverseEdgeTable {
    if (!this.reverse) {
      const N = this.nodes.count;
      const { offsets, targets, costs, count } = this.edges;
      const rOffsets = new Int32Array(N + 1);
      for (let e = 0; e < count; e++) rOffsets[targets[e] + 1]++;
      for (let n = 0; n < N; n++) rOffsets[n + 1] += rOffsets[n];
      const cursor = rOffsets.slice(0, N);
      const sources = new Int32Array(count);
      const rCosts = new Float64Array(count);
      const edges = new Int32Array(count);
      for (let n = 0; n < N; n++) {
        for (let e = offsets[n]; e < offsets[n + 1]; e++) {
          const k = cursor[targets[e]]++;
          sources[k] = n;
          rCosts[k] = costs[e];
          edges[k] = e;
        }
      }
      this.reverse = { offsets: rOffsets, sources, costs: rCosts, edges };
    }
    return this.reverse;
  }

  /** Chains touching each node, passable or not (computed once, lazily). */
  nodeChains(): NodeChainTable {
    if (!this.incident) {
      const N = this.nodes.count;
      const { from, to, count } = this.chains;
      const offsets = new Int32Array(N + 1);
      for (let c = 0; c < count; c++) {
        offsets[from[c] + 1]++;
        offsets[to[c] + 1]++;
      }
      for (let n = 0; n < N; n++) offsets[n + 1] += offsets[n];
      const cursor = offsets.slice(0, N);
      const chains = new Int32Array(offsets[N]);
      const atStart = new Uint8Array(offsets[N]);
      for (let c = 0; c < count; c++) {
        let k = cursor[from[c]]++;
        chains[k] = c;
        atStart[k] = 1;
        k = cursor[to[c]]++;
        chains[k] = c;
      }
      this.incident = { offsets, chains, atStart };
    }
    return this.incident;
  }

  /**
   * Locates dead ends, near misses, components, collinear overlaps and — when built with
   * `diagnostics: true` — every repair and invalid coordinate.
   */
  diagnostics(options?: DiagnosticsOptions): GraphDiagnostics {
    return diagnoseGraph(this as RoutingGraph<unknown>, options);
  }

  /**
   * Serialises the graph into plain buffers that `postMessage` can transfer (or share with `shared: true`).
   * Features are not included: pass them to {@link fromTransferable} when sections need their properties.
   */
  toTransferable(options?: SerializeOptions): TransferableGraph {
    return graphToTransferable(this as RoutingGraph<unknown>, options);
  }

  /** Rebuilds a graph from {@link toTransferable} output without copying the buffers. */
  static fromTransferable<P = unknown>(
    data: TransferableGraph,
    options?: DeserializeOptions<P>,
  ): RoutingGraph<P> {
    return graphFromTransferable(data, options);
  }

  /** Source features touching a node (in chain order, without duplicates). */
  nodeFeatures(node: number): number[] {
    const { offsets, chains, atStart } = this.nodeChains();
    const { segStart } = this.chains;
    const feature = this.segments.feature;
    const out: number[] = [];
    for (let k = offsets[node]; k < offsets[node + 1]; k++) {
      const c = chains[k];
      const f = feature[atStart[k] ? segStart[c] : segStart[c + 1] - 1];
      if (!out.includes(f)) out.push(f);
    }
    return out;
  }
}
