import type { Metric } from '../geo/metric';
import { PackedRTree } from '../spatial/rtree';
import type { NetworkFeature, Position } from '../types';
import type { VertexStore } from './vertex-store';

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
  /** Dead ends connected by `snapDangles`. */
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

export interface ComponentTable {
  readonly count: number;
  readonly nodes: Int32Array;
  /** Total chain length per component (metric units). */
  readonly length: Float64Array;
  /** Component with the greatest total length, or -1 for an empty graph. */
  readonly largest: number;
}

export interface RoutingGraphParts<P> {
  metric: Metric;
  features: readonly NetworkFeature<P>[];
  stats: GraphStats;
  vertices: VertexTable;
  nodes: NodeTable;
  chains: ChainTable;
  segments: SegmentTable;
  edges: EdgeTable;
  components: ComponentTable;
  heuristic: { dims: number; scale: number };
  segmentIndex: PackedRTree;
  store: VertexStore;
  remap: Int32Array;
}

/**
 * Immutable, query-independent routing graph. Everything is stored in flat typed arrays so a graph can be
 * built once and shared by any number of {@link LineFinder} instances (or engines).
 */
export class RoutingGraph<P = unknown> {
  readonly metric: Metric;
  readonly features: readonly NetworkFeature<P>[];
  readonly stats: Readonly<GraphStats>;
  readonly vertices: VertexTable;
  readonly nodes: NodeTable;
  readonly chains: ChainTable;
  readonly segments: SegmentTable;
  readonly edges: EdgeTable;
  readonly components: ComponentTable;
  /** A* support: embedding dimension and the admissible cost-per-metric-unit scale (0 = unavailable). */
  readonly heuristic: { readonly dims: number; readonly scale: number };
  /** R-tree over chain segments, used for snapping. */
  readonly segmentIndex: PackedRTree;
  private readonly store: VertexStore;
  private readonly remap: Int32Array;
  private vertexTree: { tree: PackedRTree; items: Int32Array } | null = null;
  private nodeTree: PackedRTree | null = null;

  constructor(parts: RoutingGraphParts<P>) {
    this.metric = parts.metric;
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

  /** Whether a vertex is part of the routable graph. */
  isLiveVertex(vertex: number): boolean {
    return this.vertices.node[vertex] >= 0 || this.vertices.chain[vertex] >= 0;
  }

  /** Vertex at (or within `tolerance` of) a coordinate, after connectivity repair; -1 when none. */
  findVertex(x: number, y: number): number {
    const v = this.store.find(x, y);
    return v === -1 ? -1 : this.remap[v];
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
}
