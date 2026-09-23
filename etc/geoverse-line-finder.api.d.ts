interface VertexStoreOptions {
    /** Merge distance in metric units (meters for geographic metrics). `0` = exact coordinate identity. */
    tolerance: number;
    geographic: boolean;
    /** Largest |latitude| in the network; sizes the longitude cells so no neighbour is ever missed. */
    maxAbsLat: number;
}
/**
 * Deduplicates network coordinates into vertex ids.
 *
 * Exact mode uses a nested `Map<x, Map<y, id>>` (no string keys — the trick that makes terra-route's
 * build fast). Tolerance mode uses a uniform grid whose cells are at least `tolerance` wide and checks the
 * 3×3 neighbourhood with a real distance, unlike geojson-path-finder's coordinate rounding, which fails to
 * merge two points that straddle a rounding boundary however close they are.
 *
 * Vertices live in connectivity groups (`0` unless the graph uses `group`): only vertices of the same group
 * ever merge, so stacked floors or a bridge above a road stay apart.
 */
declare class VertexStore {
    readonly x: number[];
    readonly y: number[];
    /** Original coordinate objects, kept for faithful output (including any z value). */
    readonly positions: Position[];
    /** Group index of every vertex. */
    readonly group: number[];
    /** Number of coordinates that were merged into an already known vertex. */
    merged: number;
    /** Distance to the vertex matched by the last successful {@link find} (`0` for identical coordinates). */
    lastDistance: number;
    private readonly tolerance;
    private readonly geographic;
    private readonly exact;
    private readonly grid;
    private readonly cellX;
    private readonly cellY;
    constructor(options: VertexStoreOptions);
    get size(): number;
    /** Returns the id of the vertex at (or within tolerance of) `position`, creating it when absent. */
    getOrAdd(position: Position, group?: number): number;
    /** Looks a coordinate up without inserting; `-1` when no vertex of `group` matches. */
    find(px: number, py: number, group?: number): number;
    /**
     * Adds a vertex unconditionally (split points computed during connectivity repair). A {@link NO_GROUP}
     * vertex is not indexed, so {@link find} never returns it and nothing merges into it.
     */
    append(px: number, py: number, position: Position, group?: number): number;
}

/** A connectivity group key. */
type GroupKey = string | number;
/**
 * Assigns a feature to a connectivity group (`null`/`undefined` = the default group), or to two groups as a
 * connector: `[startGroup, endGroup]` puts the first coordinate of every part into `startGroup` and the last
 * into `endGroup` — an elevator is a zero-length line whose two ends are in different floors. The interior
 * coordinates of a connector (the steps of a staircase) belong to no group: they are never merged with
 * other vertices, repaired, or matched by a `group` constraint.
 */
type GroupFunction<P = unknown> = (properties: P, featureIndex: number, feature: NetworkFeature<P>) => GroupKey | readonly [GroupKey, GroupKey] | null | undefined;
/** Column-wise repair log (see `graph/diagnostics.ts`). */
interface RepairLog {
    kind: number[];
    x: number[];
    y: number[];
    featureA: number[];
    featureB: number[];
    gap: number[];
}

type SnapMode = 'edge' | 'vertex' | 'node' | 'exact';
/**
 * How waypoints are placed when their nearest locations cannot all be routed between (nearest selection).
 * `'connected'` shares one weakly connected component, `'reachable'` one strongly connected component (every
 * leg then exists even on one-way networks), `'nearest'` never moves a waypoint.
 */
type SnapConnectivity = 'connected' | 'nearest' | 'reachable';
/** `'nearest'`: each waypoint takes its nearest allowed location. `'optimal'`: the cheapest combination overall. */
type SnapSelection = 'nearest' | 'optimal';
/** Which snap costs count: none, leaving the origin and reaching the destination, or also both at every via. */
type SnapCostMode = 'none' | 'ends' | 'arrive-depart';
/**
 * Candidates kept per waypoint: the nearest per chain and source feature (`'chain'`, default), per source
 * feature, or per weakly connected component. A junction counts once.
 */
type CandidateDistinct = 'chain' | 'feature' | 'component';
type WaypointRole = 'origin' | 'via' | 'destination';
/** Side of the source feature's digitised direction the input point lies on. */
type CandidateSide = 'left' | 'right' | 'on';
/** A place where a waypoint could attach to the network. */
interface CandidateInfo<P = unknown> {
    readonly location: Position;
    /** Distance from the input point (metric units). */
    readonly distance: number;
    /** Feature of the snapped segment; -1 at a junction found in `vertex` / `node` mode. */
    readonly featureIndex: number;
    /** Every source feature touching the location (junctions touch several). */
    readonly featureIndices: readonly number[];
    /** `id` (or `properties.id`) of `featureIndex`'s feature, or of the first touching feature. */
    readonly featureId: string | number | undefined;
    readonly feature: NetworkFeature<P> | undefined;
    readonly side: CandidateSide;
    /** Measure along that feature (metric length from the start of its part). */
    readonly measure: number;
    readonly component: number;
    /**
     * Connectivity group of the location; `undefined` in the default group and on connectors between groups
     * (a location on a staircase belongs to no floor, so no `group` constraint matches it).
     */
    readonly group: GroupKey | undefined;
    /** Position among the accepted candidates of this waypoint, nearest first. */
    readonly rank: number;
}
interface WaypointContext {
    /** Index in the route's waypoint list. */
    readonly index: number;
    readonly input: Position;
    readonly role: WaypointRole;
}
/** Hard constraint: `false` removes the candidate. Express preferences through `cost`, never through filters. */
type CandidateFilter = (candidate: CandidateInfo, context: WaypointContext) => boolean;
/** Cost of travelling between the input point and the candidate once (weight units, finite, ≥ 0). */
type CandidateCost = (candidate: CandidateInfo, context: WaypointContext) => number;
/** Snapping options that may differ per waypoint (`{ coordinates, snap }` inputs). */
interface WaypointSnapOptions {
    /** Reject locations farther than this from the input (metric units). Default `Infinity`. */
    maxDistance?: number;
    /** Candidates kept per waypoint (1–16). Default 1, or 4 with `selection: 'optimal'`. */
    candidates?: number;
    /** Default `'chain'`. */
    distinctBy?: CandidateDistinct;
    /** Only features whose `id` or `properties.id` is listed may be used. */
    featureIds?: readonly (string | number)[];
    filter?: CandidateFilter;
    /** A number is a factor on the snap distance (default `1`); a function returns the cost directly. */
    cost?: number | CandidateCost;
    /** Candidates farther than the nearest allowed one by more than this are not used. Default `Infinity`. */
    maxRelocation?: number;
    /** A via waypoint may be entered from one candidate and left from another (optimal selection). */
    passThrough?: boolean;
    /** Only locations in this connectivity group. */
    group?: GroupKey;
}
interface SnapOptions extends WaypointSnapOptions {
    /**
     * - `'edge'` (default): project onto the nearest segment — the waypoint may fall between vertices;
     * - `'vertex'`: nearest network vertex (shape points included);
     * - `'node'`: nearest junction or dead end;
     * - `'exact'`: the coordinate must already be a network vertex (within `tolerance`), which is how
     *   geojson-path-finder and terra-route behave.
     */
    mode?: SnapMode;
    /**
     * Nearest selection only. `'connected'` (default): when the nearest locations of the waypoints fall in
     * different components, use nearby locations in a component shared by all waypoints (least total snap
     * distance) instead of failing — this moves waypoints; see `relocation` in the result and `maxRelocation`.
     */
    connectivity?: SnapConnectivity;
    /** How many nearest segments/vertices to examine per waypoint (filtered ones included). Default `64`. */
    searchLimit?: number;
    /** Default `'nearest'`. `'optimal'` ignores `connectivity`. */
    selection?: SnapSelection;
    /** Default `'none'`: snap costs neither drive selection nor enter the totals. */
    costMode?: SnapCostMode;
}

/**
 * Minimal structural GeoJSON types.
 *
 * They are deliberately loose so that objects typed with `@types/geojson` (or plain parsed JSON)
 * are accepted as-is, without the library taking a dependency on any typings package.
 */

/** `[x, y]` or `[x, y, z]`. Only x/y take part in routing; z is carried through to output coordinates. */
type Position = number[];
interface GeometryLike {
    readonly type: string;
    readonly coordinates?: unknown;
}
interface PointGeometry {
    readonly type: 'Point';
    readonly coordinates: Position;
}
interface PointFeature {
    readonly type: 'Feature';
    readonly geometry: PointGeometry;
    readonly properties?: unknown;
}
/** A feature of the routing network. `LineString` and `MultiLineString` geometries are routable; others are skipped. */
interface NetworkFeature<P = unknown> {
    readonly type?: 'Feature';
    readonly id?: string | number;
    readonly geometry: GeometryLike | null;
    readonly properties?: P;
}
interface NetworkCollection<P = unknown> {
    readonly type?: 'FeatureCollection';
    readonly features: readonly NetworkFeature<P>[];
}
/** A waypoint with its own snapping options, which override the route's `snap` options for this point. */
interface WaypointObject {
    readonly coordinates: Position;
    readonly snap?: WaypointSnapOptions;
}
/**
 * Anything accepted as a waypoint: a bare position, a Point geometry, a Point feature, or an object
 * `{ coordinates, snap }` (a Point geometry or feature may also carry `snap`).
 */
type WaypointInput = Position | (PointGeometry & {
    readonly snap?: WaypointSnapOptions;
}) | (PointFeature & {
    readonly snap?: WaypointSnapOptions;
}) | WaypointObject;
interface LineStringFeature<P> {
    type: 'Feature';
    geometry: {
        type: 'LineString';
        coordinates: Position[];
    };
    properties: P;
}

/** Mean Earth radius (IUGG), identical to the one used by turf. */
declare const EARTH_RADIUS_M = 6371008.8;
/**
 * A distance measure for the network.
 *
 * `distance` gives edge lengths and snap distances. `embed`, when present, maps a coordinate into R^k
 * such that the Euclidean distance between two embeddings **never exceeds** `distance` between the
 * coordinates. That lower bound is what makes the A* heuristic admissible, so a metric without an
 * embedding simply disables the heuristic (A* then behaves like Dijkstra).
 */
interface Metric {
    readonly name: string;
    /** `true` → coordinates are `[lng, lat]` degrees and distances are meters. */
    readonly geographic: boolean;
    distance(a: Position, b: Position): number;
    /** Dimension written by `embed`; `0` when the metric offers no admissible embedding. */
    readonly embedDims: number;
    embed?(x: number, y: number, out: Float64Array, offset: number): void;
}
type MetricOption = 'haversine' | 'cheap-ruler' | 'euclidean' | Metric;
/** Great-circle distance in meters. */
declare function haversineDistance(lng1: number, lat1: number, lng2: number, lat2: number): number;
/**
 * Haversine metric. Its embedding is the 3D point on the sphere: the chord `2R·√h` is never longer
 * than the arc `2R·asin(√h)`, so the heuristic is admissible and consistent, and costs no trigonometry
 * per evaluation.
 */
declare const haversineMetric: Metric;
/**
 * Mapbox cheap-ruler approximation around a reference latitude (meters). Accurate for city-scale
 * networks and noticeably cheaper than haversine. The embedding ignores antimeridian wrapping, so do
 * not use it for networks that cross ±180°.
 */
declare function cheapRulerMetric(referenceLat: number): Metric;
/** Plain planar distance, for projected coordinates (meters, feet, pixels…). */
declare const euclideanMetric: Metric;

/**
 * Static packed Hilbert R-tree over axis-aligned boxes (layout after flatbush, ISC).
 *
 * Built once, queried many times. Besides window search it offers an exact best-first nearest-item
 * iterator: boxes are ordered by their scaled box distance (a lower bound) and items by an exact
 * distance supplied by the caller, so items come out in true ascending distance order.
 */
declare class PackedRTree {
    readonly numItems: number;
    readonly nodeSize: number;
    private readonly levelBounds;
    private readonly boxes;
    private readonly indices;
    private pos;
    private minX;
    private minY;
    private maxX;
    private maxY;
    private readonly queue;
    private readonly stack;
    constructor(numItems: number, nodeSize?: number, data?: {
        boxes: Float64Array;
        indices: Uint32Array;
    });
    /** A finished tree over previously built arrays (see {@link data}); the arrays are used, not copied. */
    static fromData(numItems: number, nodeSize: number, boxes: Float64Array, indices: Uint32Array): PackedRTree;
    /** The tree's backing arrays, for serialisation. */
    data(): {
        boxes: Float64Array;
        indices: Uint32Array;
    };
    add(minX: number, minY: number, maxX: number, maxY: number): number;
    finish(): void;
    /** Calls `visit` for every item whose box intersects the window. */
    search(minX: number, minY: number, maxX: number, maxY: number, visit: (index: number) => void): void;
    /**
     * Visits items in ascending exact distance from `(qx, qy)`.
     *
     * Coordinate deltas are multiplied by `sx`/`sy` before measuring, and `itemDistance` must return the
     * exact distance in the same scaled space (never below the box distance). Iteration stops when
     * `visit` returns `false` or the next distance exceeds `maxDistance`.
     */
    nearest(qx: number, qy: number, sx: number, sy: number, itemDistance: (index: number) => number, visit: (index: number, distance: number) => boolean, maxDistance?: number): void;
}

interface WeightContext<P = unknown> {
    /** Length of the segment measured with the finder's metric (meters for geographic metrics). */
    readonly distance: number;
    readonly featureIndex: number;
    readonly feature: NetworkFeature<P>;
}
/** Per-direction costs. A missing or falsy direction is impassable. */
interface DirectionalWeight {
    forward?: number | null | false;
    backward?: number | null | false;
}
/**
 * What a weight function may return — the geojson-path-finder contract:
 * - a positive number: the same cost in both directions;
 * - `{ forward, backward }`: per-direction cost (forward = along the digitised a→b order);
 * - `0`, `NaN`, `Infinity`, `null`, `undefined`, `false`: impassable (for that direction).
 * Negative costs are rejected with a `RangeError`: they would silently break Dijkstra and A*.
 */
type WeightResult = number | DirectionalWeight | null | undefined | false;
/**
 * Cost of travelling one network segment from `a` to `b`. Signature-compatible with
 * geojson-path-finder's `weight(a, b, properties)`; the extra `context` exposes the pre-computed
 * segment length so time-based weights need not re-measure it.
 */
type WeightFunction<P = unknown> = (a: Position, b: Position, properties: P, context: WeightContext<P>) => WeightResult;
type TravelDirection = 'both' | 'forward' | 'backward' | 'none';
/**
 * What a weight of `0` means: `'impassable'` (default, the geojson-path-finder contract) or `'free'` — a
 * zero-cost passage such as a connector between levels.
 */
type ZeroWeight = 'impassable' | 'free';
/** Default weight: the metric length of the segment (the shortest path). */
declare const distanceWeight: WeightFunction;
/** Wraps a cost with a travel-direction restriction. */
declare function directional(cost: number, direction: TravelDirection): WeightResult;
interface PropertyWeightOptions<P> {
    /** Multiplier on the segment length. Falsy/NaN makes the segment impassable. Defaults to `1`. */
    factor?: (properties: P) => number | null | undefined;
    /** Direction restriction derived from the properties. Defaults to `'both'`. */
    direction?: (properties: P) => TravelDirection;
}
/** Declarative weight: `length × factor(properties)`, optionally one-way. */
declare function createPropertyWeight<P>(options?: PropertyWeightOptions<P>): WeightFunction<P>;
interface SpeedWeightOptions<P> {
    /** Travel speed in km/h. Falsy/NaN makes the segment impassable. */
    speed: (properties: P) => number | null | undefined;
    direction?: (properties: P) => TravelDirection;
}
/** Travel time in seconds (assumes a metric in meters): `length / (speed / 3.6)`. */
declare function createSpeedWeight<P>(options: SpeedWeightOptions<P>): WeightFunction<P>;
/**
 * OpenStreetMap one-way semantics: `oneway=yes|true|1` → forward, `oneway=-1|reverse` → backward,
 * `junction=roundabout|circular` → forward unless `oneway=no`.
 */
declare function osmDirection(properties: unknown): TravelDirection;

interface GraphOptions<P = unknown> {
    /** Distance measure. Default `'haversine'` (coordinates in degrees, distances in meters). */
    metric?: MetricOption;
    /** Segment cost (geojson-path-finder compatible). Default: segment length. */
    weight?: WeightFunction<P>;
    /**
     * Vertices closer than this (metric units) are merged into one. Default `0`: only identical
     * coordinates connect. geojson-path-finder's default 1e-5° is roughly 1.1 m.
     */
    tolerance?: number;
    /** Connect dead ends to the nearest segment within this distance (metric units). Default `0` (off). */
    snapDangles?: number;
    /** Node segments that cross or touch without a shared vertex. Default `false`. */
    splitIntersections?: boolean;
    /** Collapse degree-2 vertices into chains (faster search, identical results). Default `true`. */
    compact?: boolean;
    /**
     * Connectivity groups for non-planar networks (floors, bridges over roads): vertices, repairs and
     * snapping never join different groups; connector features (`[startGroup, endGroup]`) link them.
     */
    group?: GroupFunction<P>;
    /** What a weight of `0` means. Default `'impassable'` (geojson-path-finder contract); `'free'` for connectors. */
    zeroWeight?: ZeroWeight;
    /** Record repairs and invalid coordinates so that `graph.diagnostics()` can locate them. Default `false`. */
    diagnostics?: boolean;
}
/** Build settings kept on the graph (for diagnostics, serialisation and snapping). */
interface GraphSettings {
    readonly tolerance: number;
    readonly snapDangles: number;
    readonly splitIntersections: boolean;
    readonly compact: boolean;
    readonly zeroWeight: ZeroWeight;
    readonly maxAbsLat: number;
}
/**
 * Builds the routing graph: topology → connectivity repair → weights → chain compaction → directed CSR →
 * components → heuristic data → spatial index.
 */
declare function buildGraph<P>(network: NetworkCollection<P>, options?: GraphOptions<P>): RoutingGraph<P>;

interface DiagnosticsOptions {
    /** Dead ends at most this far from another segment are near misses (metric units). Default `1`. */
    nearMissDistance?: number;
    /** Maximum items per list; the rest is only counted. Default `1000`. */
    limit?: number;
}
interface DiagnosticList<T> {
    items: T[];
    /** Items found, including those beyond `limit`. */
    total: number;
    truncated: number;
}
interface DangleReport {
    location: Position;
    node: number;
    featureIndex: number;
    featureId: string | number | undefined;
    /** Distance to the nearest segment of another chain in the same group (`Infinity` when none). */
    nearestDistance: number;
    nearestFeatureIndex: number;
}
interface RepairReport {
    kind: 'merge' | 'dangle' | 'split';
    location: Position;
    /** The two features involved (merged coordinate / existing vertex, dead end / target, crossing pair). */
    featureIndices: [number, number];
    /** Distance bridged (0 for splits). */
    gap: number;
}
interface ComponentReport {
    id: number;
    nodes: number;
    length: number;
    /** `[minX, minY, maxX, maxY]` of the component's vertices. */
    bbox: [number, number, number, number];
    group: GroupKey | undefined;
}
interface InvalidCoordinateReport {
    featureIndex: number;
    partIndex: number;
    coordinateIndex: number;
}
interface OverlapReport {
    /** Features of two collinear segments that overlap without being noded. */
    featureIndices: [number, number];
    location: Position;
    length: number;
}
interface GraphDiagnostics {
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

/** Strongly connected components of the directed search graph. */
interface StrongComponents {
    readonly count: number;
    /** Component id per node. */
    readonly node: Int32Array;
    /** Nodes per component. */
    readonly size: Int32Array;
    /** Component with the most nodes, or -1 for an empty graph. */
    readonly largest: number;
}

declare const GRAPH_FORMAT = "geoverse-line-finder/graph";
declare const GRAPH_FORMAT_VERSION = 1;
type ArrayKind = 'f64' | 'i32' | 'u32' | 'u8';
/** Plain, structured-clone friendly form of a {@link RoutingGraph}. */
interface TransferableGraph {
    format: typeof GRAPH_FORMAT;
    formatVersion: number;
    header: GraphHeader;
    /** One buffer per `header.layout` entry. Pass them as the transfer list of `postMessage`. */
    buffers: ArrayBufferLike[];
}
interface GraphHeader {
    metric: {
        name: string;
        referenceLat: number;
    };
    featureCount: number;
    stats: GraphStats;
    settings: GraphSettings;
    heuristic: {
        dims: number;
        scale: number;
    };
    groupKeys: (GroupKey | null)[];
    largestComponent: number;
    rtree: {
        numItems: number;
        nodeSize: number;
    };
    layout: [name: string, kind: ArrayKind, length: number][];
}
interface SerializeOptions {
    /** Copy into `SharedArrayBuffer`s so several workers can read one graph without copies. */
    shared?: boolean;
}
interface DeserializeOptions<P> {
    /** Source features, for `sections[].properties` / `id` and `candidates()` feature details. */
    features?: readonly NetworkFeature<P>[];
    /** Required when the graph was built with a custom metric object. */
    metric?: Metric;
}

interface GraphStats {
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
}
interface VertexTable {
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
}
interface NodeTable {
    readonly count: number;
    readonly vertex: Int32Array;
    readonly component: Int32Array;
    /** Metric embedding (`heuristic.dims` values per node) for the A* heuristic. */
    readonly embedding: Float64Array;
}
interface ChainTable {
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
interface SegmentTable {
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
interface EdgeTable {
    readonly count: number;
    /** Length `nodes.count + 1`. */
    readonly offsets: Int32Array;
    readonly targets: Int32Array;
    readonly costs: Float64Array;
    /** `(chain << 1) | reversed` for every edge. */
    readonly ref: Int32Array;
}
/** Incoming adjacency: for node `n`, entries `[offsets[n], offsets[n + 1])` are edges ending at `n`. */
interface ReverseEdgeTable {
    readonly offsets: Int32Array;
    readonly sources: Int32Array;
    readonly costs: Float64Array;
    /** Forward edge id of every entry. */
    readonly edges: Int32Array;
}
/** Chains touching each node: entries `[offsets[n], offsets[n + 1])`; `atStart` = the chain starts there. */
interface NodeChainTable {
    readonly offsets: Int32Array;
    readonly chains: Int32Array;
    readonly atStart: Uint8Array;
}
interface ComponentTable {
    readonly count: number;
    readonly nodes: Int32Array;
    /** Total chain length per component (metric units). */
    readonly length: Float64Array;
    /** Component with the greatest total length, or -1 for an empty graph. */
    readonly largest: number;
}
/** Recorded by `buildGraph` with `diagnostics: true`. */
interface DiagnosticsLog {
    readonly repairs: RepairLog;
    /** `(featureIndex, partIndex, coordinateIndex)` triples. */
    readonly invalid: Int32Array;
}
interface RoutingGraphParts<P> {
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
    heuristic: {
        dims: number;
        scale: number;
    };
    segmentIndex: PackedRTree;
    store: VertexStore;
    remap: Int32Array;
    groupKeys: readonly (GroupKey | undefined)[];
    settings: GraphSettings;
    diagnosticsLog: DiagnosticsLog | null;
}
/**
 * Immutable, query-independent routing graph. Everything is stored in flat typed arrays so a graph can be
 * built once and shared by any number of {@link LineFinder} instances (or engines). Derived indexes
 * (strong components, reverse adjacency, spatial indexes over vertices and nodes) are built lazily.
 */
declare class RoutingGraph<P = unknown> {
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
    /** A* support: embedding dimension and the admissible cost-per-metric-unit scale (0 = unavailable). */
    readonly heuristic: {
        readonly dims: number;
        readonly scale: number;
    };
    /** R-tree over chain segments, used for snapping. */
    readonly segmentIndex: PackedRTree;
    /** Connectivity group keys by index; index 0 is the default group (`undefined`). */
    readonly groupKeys: readonly (GroupKey | undefined)[];
    readonly settings: GraphSettings;
    /** @internal */
    readonly diagnosticsLog: DiagnosticsLog | null;
    /** @internal */
    readonly store: VertexStore;
    /** @internal */
    readonly remap: Int32Array;
    private vertexTree;
    private nodeTree;
    private groupTrees;
    private scc;
    private reverse;
    private incident;
    constructor(parts: RoutingGraphParts<P>);
    segmentCountOf(chain: number): number;
    /** Coordinate at fractional `position` (segment index + t) along `chain`. */
    pointAt(chain: number, position: number): Position;
    /** Measure along the source feature at fractional `position` of `chain` (see {@link SegmentTable}). */
    measureAt(chain: number, position: number): number;
    /** `feature.id`, falling back to `properties.id`. */
    featureId(featureIndex: number): string | number | undefined;
    /** Group index of a key, or -1. `undefined` is the default group 0. */
    groupIndex(key: GroupKey | undefined): number;
    /** Whether a vertex is part of the routable graph. */
    isLiveVertex(vertex: number): boolean;
    /** Group index of a vertex: 0 in a single-group graph, `-1` inside a connector. */
    vertexGroup(vertex: number): number;
    /**
     * Group index of the locations strictly inside segment `slot`: the group of both its ends, or
     * `-1` for a segment of a connector (its ends lie in different groups or in none).
     */
    segmentGroup(slot: number): number;
    /**
     * Vertex at (or within `tolerance` of) a coordinate, after connectivity repair; -1 when none. Without
     * `group` every group is searched in order.
     */
    findVertex(x: number, y: number, group?: GroupKey): number;
    /** Lazily built R-tree over all live vertices (for `snap.mode = 'vertex'`). */
    vertexSpatialIndex(): {
        tree: PackedRTree;
        items: Int32Array;
    };
    /** Lazily built R-tree over graph nodes (for `snap.mode = 'node'`). */
    nodeSpatialIndex(): PackedRTree;
    /**
     * Lazily built R-tree over what can hold a location of group index `group`: segments with at least one end
     * in it, or its live vertices, or its nodes. `items` maps tree items to segment slots, vertex ids or node
     * ids. A group-constrained snap scans this instead of the whole network, so locations of other groups
     * (floors stacked on top of each other) neither cost scan budget nor hide the allowed ones.
     */
    groupSpatialIndex(kind: 'segment' | 'vertex' | 'node', group: number): {
        tree: PackedRTree;
        items: Int32Array;
    };
    /** Strongly connected components of the directed graph (computed once, lazily). */
    strongComponents(): StrongComponents;
    /** Incoming adjacency (computed once, lazily). */
    reverseEdges(): ReverseEdgeTable;
    /** Chains touching each node, passable or not (computed once, lazily). */
    nodeChains(): NodeChainTable;
    /**
     * Locates dead ends, near misses, components, collinear overlaps and — when built with
     * `diagnostics: true` — every repair and invalid coordinate.
     */
    diagnostics(options?: DiagnosticsOptions): GraphDiagnostics;
    /**
     * Serialises the graph into plain buffers that `postMessage` can transfer (or share with `shared: true`).
     * Features are not included: pass them to {@link fromTransferable} when sections need their properties.
     */
    toTransferable(options?: SerializeOptions): TransferableGraph;
    /** Rebuilds a graph from {@link toTransferable} output without copying the buffers. */
    static fromTransferable<P = unknown>(data: TransferableGraph, options?: DeserializeOptions<P>): RoutingGraph<P>;
    /** Source features touching a node (in chain order, without duplicates). */
    nodeFeatures(node: number): number[];
}

/**
 * Min-priority queue of integer values keyed by numbers.
 *
 * Engines reuse one heap instance across queries, so `clear()` is mandatory. Implementations should
 * break ties by insertion order to keep routes stable between runs.
 */
interface Heap {
    insert(key: number, value: number): void;
    /** Removes and returns the value with the smallest key, or `-1` when empty. */
    extractMin(): number;
    /** Smallest key, or `Infinity` when empty. */
    peekMinKey(): number;
    size(): number;
    clear(): void;
}
type HeapConstructor = new () => Heap;

/**
 * Per-finder search state reused across queries (the terra-route trick): typed arrays are allocated once
 * and validated with a generation stamp instead of being cleared, so a query only touches the nodes it
 * actually visits.
 */
declare class SearchScratch {
    /** Best known cost per node; valid only where `seen[node] === stamp`. */
    g: Float64Array;
    prevNode: Int32Array;
    prevEdge: Int32Array;
    seen: Uint32Array;
    /** `closed[node] === stamp` once the node is settled. */
    closed: Uint32Array;
    /** `targetMark[node] === stamp` while `node` is a still unsettled target of a multi-target search. */
    targetMark: Uint32Array;
    stamp: number;
    readonly heap: Heap;
    constructor(heap?: HeapConstructor);
    /** Prepares buffers for `size` nodes and returns the stamp identifying this query. */
    begin(size: number): number;
}
/** Walks predecessor links from `target` back to `source`. */
declare function reconstructPath(scratch: SearchScratch, source: number, target: number): {
    nodes: number[];
    edges: number[];
};

/**
 * What an engine searches over: the immutable base graph in CSR form plus a small per-query overlay
 * (virtual nodes for waypoints and candidates that sit between nodes, and their edges).
 *
 * Node ids `< baseNodeCount` are base nodes and have CSR adjacency; ids `≥ baseNodeCount` are virtual.
 * Edge ids `< baseEdgeCount` index the CSR arrays; overlay edge `k` has id `baseEdgeCount + k`.
 * An engine must consider, for every expanded node, its CSR edges (when it is a base node) **and** every
 * overlay edge whose `overlayFrom` equals it — either by scanning all overlay edges or through the optional
 * `overlayFirst` / `overlayNext` adjacency, which lists the same edges in the same ascending order.
 */
interface SearchGraph {
    readonly baseNodeCount: number;
    /** Base plus virtual nodes: the size engines must allocate state for. */
    readonly nodeCount: number;
    readonly offsets: Int32Array;
    readonly targets: Int32Array;
    readonly costs: Float64Array;
    readonly baseEdgeCount: number;
    readonly overlayCount: number;
    readonly overlayFrom: Int32Array;
    readonly overlayTo: Int32Array;
    readonly overlayCost: Float64Array;
    /** First overlay edge leaving `node`, or `-1` (optional, 0.2.0). Continue with `overlayNext[k]`. */
    overlayFirst?(node: number): number;
    /** Next overlay edge with the same `overlayFrom`, or `-1` (present whenever `overlayFirst` is). */
    readonly overlayNext?: Int32Array;
    /**
     * Optional reverse CSR of the base graph (0.2.0): edges ending at node `n` are entries
     * `[reverseOffsets[n], reverseOffsets[n + 1])` with their source node, cost and forward edge id.
     */
    readonly reverseOffsets?: Int32Array;
    readonly reverseSources?: Int32Array;
    readonly reverseCosts?: Float64Array;
    readonly reverseEdgeIds?: Int32Array;
}
/**
 * Lower bound of the remaining cost from `node` to the query target(s). `Infinity` means the target cannot
 * be reached from `node`; engines may drop such nodes.
 */
type Heuristic = (node: number) => number;
interface SearchRequest {
    graph: SearchGraph;
    source: number;
    /** Target node; ignored when `targets` is given. */
    target: number;
    /** Provided when the engine declares `usesHeuristic` and the graph supports one; otherwise `null`. */
    heuristic: Heuristic | null;
    /** Reusable per-finder buffers (see {@link SearchScratch}). */
    scratch: SearchScratch;
    /**
     * Several targets at once (engines declaring `capabilities.multiTarget`): the search runs until all of
     * them are settled and reports each in `targetPaths`. The heuristic is then a bound to the nearest one.
     */
    targets?: ArrayLike<number>;
    /** Paths costlier than this are not needed (engines declaring `capabilities.budget`). */
    maxCost?: number;
    /** Give up after settling this many nodes; the result then carries `budgetExceeded: true`. */
    maxSettled?: number;
}
interface TargetPath {
    cost: number;
    nodes: number[];
    edges: number[];
}
interface SearchResult {
    found: boolean;
    /** Total cost of the path; `Infinity` when not found. With `targets`: the cheapest target reached. */
    cost: number;
    /** Nodes from source to target inclusive; empty when not found. */
    nodes: number[];
    /** Edge ids between consecutive nodes (`nodes.length - 1` of them). */
    edges: number[];
    /** Nodes expanded (popped with a final label). */
    settled: number;
    /** Successful edge relaxations. */
    relaxed: number;
    /** With `targets`: one entry per requested target, in order; `null` when it was not reached. */
    targetPaths?: (TargetPath | null)[];
    /** `true` when the search stopped at `maxSettled` rather than by exhausting or reaching its targets. */
    budgetExceeded?: boolean;
}
/** Optional request fields an engine understands. Without them the library emulates or ignores them. */
interface AlgorithmCapabilities {
    /** Honours `SearchRequest.targets` (otherwise the library runs one search per target). */
    readonly multiTarget?: boolean;
    /** Honours `maxCost` and `maxSettled` (otherwise they are ignored). */
    readonly budget?: boolean;
}
/**
 * A shortest-path engine. Register custom engines (bidirectional Dijkstra, ALT, contraction hierarchies…)
 * with an {@link AlgorithmRegistry} and select them by name per query.
 */
interface PathAlgorithm {
    readonly name: string;
    /** Whether the engine consumes `SearchRequest.heuristic`. */
    readonly usesHeuristic: boolean;
    readonly capabilities?: AlgorithmCapabilities;
    search(request: SearchRequest): SearchResult;
}

type LandmarkStrategy = 'farthest' | 'planar';
interface LandmarkOptions {
    /** Landmarks to place (1–64). Default 8. */
    count?: number;
    /**
     * `'farthest'` (default): each next landmark maximises the round-trip distance to the ones already chosen.
     * `'planar'`: the farthest node from the centre in each of `count` angular sectors. Or explicit node ids.
     */
    strategy?: LandmarkStrategy | readonly number[];
    /** Landmarks used per query, chosen by their bound at the query's origins. Default 4. */
    active?: number;
}
declare const LANDMARK_FORMAT = "geoverse-line-finder/landmarks";
interface TransferableLandmarks {
    format: typeof LANDMARK_FORMAT;
    formatVersion: number;
    count: number;
    nodeCount: number;
    edgeCount: number;
    active: number;
    buffers: [nodes: ArrayBufferLike, fromLandmark: ArrayBufferLike, toLandmark: ArrayBufferLike];
}
/**
 * Exact network distances to and from a few landmark nodes (ALT, "A*, landmarks, triangle inequality"). For
 * a directed graph both directions are needed: `d(v,t) ≥ d(L,t) − d(L,v)` and `d(v,t) ≥ d(v,L) − d(t,L)`.
 * Tied to one graph and one weighting; build a new table when either changes.
 */
declare class LandmarkTable {
    readonly count: number;
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly active: number;
    /** Landmark node ids. */
    readonly nodes: Int32Array;
    /** `d(L, v)` at `[L · nodeCount + v]` (`Infinity` when unreachable). */
    readonly fromLandmark: Float64Array;
    /** `d(v, L)` at `[L · nodeCount + v]`. */
    readonly toLandmark: Float64Array;
    constructor(parts: {
        nodeCount: number;
        edgeCount: number;
        active: number;
        nodes: Int32Array;
        fromLandmark: Float64Array;
        toLandmark: Float64Array;
    });
    /** Whether the table was built for a graph of this shape. */
    matches(graph: RoutingGraph<unknown>): boolean;
    toTransferable(): TransferableLandmarks;
    static fromTransferable(data: TransferableLandmarks): LandmarkTable;
}
/** Computes a {@link LandmarkTable}: two full searches per landmark, placed in the largest component. */
declare function prepareLandmarks(graph: RoutingGraph<unknown>, options?: LandmarkOptions): LandmarkTable;

declare const builtinAlgorithms: readonly PathAlgorithm[];
/** Named set of engines. Each {@link LineFinder} owns one, pre-filled with the built-ins. */
declare class AlgorithmRegistry {
    private readonly algorithms;
    constructor(initial?: Iterable<PathAlgorithm>);
    /** Adds an engine. Re-registering a name throws unless `replace` is set. */
    register(algorithm: PathAlgorithm, options?: {
        replace?: boolean;
    }): this;
    unregister(name: string): boolean;
    has(name: string): boolean;
    get(name: string): PathAlgorithm | undefined;
    names(): string[];
    /** Accepts a registered name or an engine object. */
    resolve(algorithm: string | PathAlgorithm): PathAlgorithm;
}
declare function createAlgorithmRegistry(): AlgorithmRegistry;

/**
 * How sections are grouped: `'feature'` (default) merges consecutive pieces of one source feature,
 * `'measure'` additionally splits where the part or the measure is not continuous (so that
 * `Σ |toMeasure − fromMeasure|` equals the distance), `'segment'` returns every traversed segment.
 */
type SectionsDetail = 'feature' | 'measure' | 'segment';
/** A run of the path that comes from one source feature — e.g. one street. */
interface RouteSection<P = unknown> {
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

/** What to do with a waypoint that cannot be snapped or reached. */
type FailurePolicy = 'fail' | 'skip' | 'straight';
/** Straight connectors from the raw inputs: at the route's two ends, or around every leg. */
type ConnectorMode = 'ends' | 'legs';
/** Limits for each search a query runs. */
interface SearchBudget {
    /** A leg costlier than this counts as unreachable (`detail: 'BEYOND_MAX_COST'`). */
    maxCost?: number;
    /** Give up after settling this many nodes in one search (`reason: 'BUDGET_EXCEEDED'`). */
    maxSettled?: number;
}
interface RouteOptions {
    algorithm?: string | PathAlgorithm;
    snap?: SnapOptions;
    /**
     * Add straight connectors from the raw inputs to the snapped locations: `true` / `'ends'` at the start and
     * end of the route, `'legs'` around every leg. Geometry only unless `totals.includeConnectorDistance`.
     */
    connectors?: boolean | ConnectorMode;
    /**
     * `'fail'` (default): the whole route fails. `'skip'`: drop the waypoint and continue from the last good
     * one. `'straight'`: bridge the gap with a straight leg.
     */
    onFailure?: FailurePolicy;
    skip?: {
        /** Also skip an origin that cannot be snapped (default `false`: the route fails). */
        leading?: boolean;
        /** Fail once more waypoints than this were skipped. Default `Infinity`. */
        max?: number;
    };
    /** Weight of a straight leg of the given length. Default: the length. */
    straightCost?: (distance: number) => number;
    totals?: {
        /** Add `snapWeight` to `weight`. Default `false`. */
        includeSnapWeight?: boolean;
        /** Add `connectorDistance` to `distance`. Default `false`. */
        includeConnectorDistance?: boolean;
    };
    budget?: SearchBudget;
    sectionsDetail?: SectionsDetail;
    debug?: {
        /** Report every candidate of every waypoint with the reason it was or was not used. */
        candidates?: boolean;
    };
}
type CandidateStatus = 'SELECTED' | 'FILTERED' | 'RELOCATION' | 'UNREACHABLE' | 'NOT_SELECTED';
interface CandidateReport extends CandidateInfo {
    readonly status: CandidateStatus;
}
/** The candidate a pass-through waypoint was entered or left by. */
interface WaypointAccess {
    location: Position;
    distance: number;
    featureIndex: number;
    featureId: string | number | undefined;
    candidateRank: number;
    snapCost: number;
}
interface SnappedWaypoint {
    /** The coordinate that was asked for. */
    input: Position;
    /** Where it attached to the network (the input itself when it could not be snapped). */
    location: Position;
    /** Distance between the two (metric units). */
    distance: number;
    component: number;
    featureIndex: number;
    featureId: string | number | undefined;
    /** Measure along the snapped feature. */
    measure: number;
    /** `false` when no allowed location was found (possible with `onFailure: 'skip' | 'straight'`). */
    snapped: boolean;
    /** `false` when the waypoint was skipped. */
    used: boolean;
    /** Distance to the nearest allowed location. */
    nearestDistance: number;
    /** `distance − nearestDistance`: how far selection moved the waypoint beyond its nearest location. */
    relocation: number;
    /** `true` when the chosen location is not the nearest candidate. */
    relocated: boolean;
    /** Rank of the chosen candidate among the waypoint's candidates, nearest = 0. */
    candidateRank: number;
    candidatesConsidered: number;
    /** Snap costs counted for this waypoint (see `snap.costMode`). */
    snapCost: number;
    /** Pass-through waypoints entered and left at different candidates. */
    arrive?: WaypointAccess;
    depart?: WaypointAccess;
    /** With `debug.candidates`. */
    candidates?: CandidateReport[];
}
interface RouteLeg<P = unknown> {
    /** Waypoint indices joined by this leg. */
    from: number;
    to: number;
    path: Position[];
    weight: number;
    distance: number;
    sections: RouteSection<P>[];
    /** Engine statistics for this leg (shared by all candidates of a layer in optimal selection). */
    settled: number;
    relaxed: number;
    /** `'straight'` legs bridge a failure (`onFailure: 'straight'`) and have no sections. */
    kind: 'network' | 'straight';
    /** Connector length included in `path` (with `connectors: 'legs'`). */
    connectorDistance: number;
}
interface SkippedWaypoint {
    index: number;
    reason: RouteFailureReason;
    detail?: RouteFailureDetail;
    message: string;
}
interface RouteSuccess<P = unknown> {
    ok: true;
    /** Full route geometry; coordinates may be shared with the input network — copy before mutating. */
    path: Position[];
    /** Total cost (the quantity that was minimised), plus `snapWeight` with `totals.includeSnapWeight`. */
    weight: number;
    /** Total length of the legs, plus `connectorDistance` with `totals.includeConnectorDistance`. */
    distance: number;
    legs: RouteLeg<P>[];
    /** One entry per input waypoint. */
    waypoints: SnappedWaypoint[];
    algorithm: string;
    /** Weight of the network legs. */
    networkWeight: number;
    /** Snap costs counted by `snap.costMode`. */
    snapWeight: number;
    networkDistance: number;
    /** Length of the straight connectors in `path`. */
    connectorDistance: number;
    /** Length of straight legs. */
    straightDistance: number;
    /** No waypoint was skipped and no leg is straight. */
    complete: boolean;
    skipped: SkippedWaypoint[];
}
type RouteFailureReason = 'INVALID_INPUT' | 'SNAP_FAILED' | 'DISCONNECTED' | 'UNREACHABLE' | 'ALL_SKIPPED' | 'BUDGET_EXCEEDED';
type RouteFailureDetail = 
/** Nothing within `snap.maxDistance`. */
'NONE_WITHIN'
/** Locations existed but the waypoint's constraints (`featureIds`, `filter`, `group`) removed them all. */
 | 'FILTERED'
/**
 * The `snap.searchLimit` nearest locations were all removed by the waypoint's constraints; allowed ones may
 * lie farther away — raise `searchLimit`.
 */
 | 'SCAN_LIMIT'
/** `mode: 'exact'` and the coordinate is not a vertex. */
 | 'NOT_A_VERTEX'
/** A shared component exists but only beyond `snap.maxRelocation`. */
 | 'RELOCATION_LIMIT'
/** No path within `budget.maxCost`. */
 | 'BEYOND_MAX_COST';
interface RouteFailure {
    ok: false;
    reason: RouteFailureReason;
    message: string;
    detail?: RouteFailureDetail;
    waypointIndex?: number;
    legIndex?: number;
    waypoints?: SnappedWaypoint[];
    skipped?: SkippedWaypoint[];
    algorithm: string;
}
type RouteResult<P = unknown> = RouteSuccess<P> | RouteFailure;
interface NearestResult {
    location: Position;
    distance: number;
    component: number;
    featureIndex: number;
}
interface ManyOptions {
    algorithm?: string | PathAlgorithm;
    /** Nearest selection is used; `connectivity`, `selection` and cost options do not apply. */
    snap?: SnapOptions;
    budget?: SearchBudget;
    /** Also return each route as a leg (geometry and sections). Default `false`. */
    paths?: boolean;
    sectionsDetail?: SectionsDetail;
}
interface ManyResult<P = unknown> {
    ok: true;
    source: SnappedWaypoint;
    /** `null` for targets that could not be snapped. */
    targets: (SnappedWaypoint | null)[];
    /** Network weight to every target; `Infinity` when unreachable. */
    weights: number[];
    distances: number[];
    /** With `paths: true`. */
    legs?: (RouteLeg<P> | null)[];
    settled: number;
    relaxed: number;
    algorithm: string;
}
interface MatrixResult {
    ok: true;
    origins: (SnappedWaypoint | null)[];
    destinations: (SnappedWaypoint | null)[];
    /** `weights[i][j]`: origin `i` to destination `j`; `Infinity` when unreachable or unsnapped. */
    weights: number[][];
    distances: number[][];
    algorithm: string;
}
interface CandidateOptions extends SnapOptions {
    /** Role passed to `filter` / `cost`. Default `'origin'`. */
    role?: 'origin' | 'via' | 'destination';
}

interface LineFinderOptions<P = unknown> extends GraphOptions<P> {
    /** Default engine for {@link LineFinder.route}. Default `'astar'`. */
    algorithm?: string | PathAlgorithm;
    /** Engine registry; defaults to a fresh registry holding the built-in `dijkstra` and `astar`. */
    algorithms?: AlgorithmRegistry;
    /** Priority queue used by the engines. Default {@link FourAryHeap}. */
    heap?: HeapConstructor;
    /** Default snapping behaviour, overridable per route and per waypoint. */
    snap?: SnapOptions;
    /**
     * ALT landmarks for faster A* (off by default): a table from {@link prepareLandmarks}, or its options to
     * build one now (two full searches per landmark). Worth it for large directed or time-weighted networks.
     */
    landmarks?: LandmarkTable | LandmarkOptions;
}
/**
 * Shortest paths on a GeoJSON line network.
 *
 * ```ts
 * const finder = new LineFinder(roads, { weight: createSpeedWeight({ speed: (p) => p.maxspeed }) });
 * const route = finder.route([start, via, end], { algorithm: 'dijkstra' });
 * if (route.ok) console.log(route.distance, route.path);
 * ```
 */
declare class LineFinder<P = unknown> {
    readonly graph: RoutingGraph<P>;
    readonly algorithms: AlgorithmRegistry;
    /** Landmark table used by heuristic engines, if any. */
    readonly landmarks: LandmarkTable | null;
    private readonly defaultAlgorithm;
    private readonly defaultSnap;
    private readonly scratch;
    private readonly query;
    /** Accepts a network (built with `options`) or a prebuilt {@link RoutingGraph} to share between finders. */
    constructor(network: NetworkCollection<P> | RoutingGraph<P>, options?: LineFinderOptions<P>);
    /** Registers an engine on this finder's registry (chainable). */
    registerAlgorithm(algorithm: PathAlgorithm, options?: {
        replace?: boolean;
    }): this;
    /** Two-point convenience for {@link route}. */
    findPath(start: WaypointInput, end: WaypointInput, options?: RouteOptions): RouteResult<P>;
    /** Nearest network location to a point, or `null` when none is within `maxDistance`. */
    nearest(point: WaypointInput, options?: {
        mode?: SnapMode;
        maxDistance?: number;
    }): NearestResult | null;
    /**
     * The allowed snap locations of a point, nearest first, after the constraints of `options` (and of a
     * `{ coordinates, snap }` input). Returns up to `candidates` (default 16) — for diagnostics or custom logic.
     */
    candidates(point: WaypointInput, options?: CandidateOptions): CandidateInfo[];
    /**
     * Route through `waypoints` in the given order (two or more). Each consecutive pair is one leg. By default
     * the route fails as a whole if any waypoint cannot be snapped or reached, reporting which one; see
     * `onFailure`, and `snap.selection` for choosing locations by total cost instead of distance.
     */
    route(waypoints: readonly WaypointInput[], options?: RouteOptions): RouteResult<P>;
    /**
     * Weights (and optionally routes) from one point to many, with a single search tree. Every point snaps
     * to its nearest allowed location.
     */
    oneToMany(source: WaypointInput, targets: readonly WaypointInput[], options?: ManyOptions): ManyResult<P> | RouteFailure;
    /** Weight matrix between origins and destinations (one search per origin). */
    matrix(origins: readonly WaypointInput[], destinations: readonly WaypointInput[], options?: ManyOptions): MatrixResult | RouteFailure;
    private snapMany;
    private context;
    /** Geometric bound, strengthened by landmarks when the finder has them. */
    private heuristicFor;
    /** Admissible, consistent bound to the nearest of `points` (virtual nodes get 0). */
    private geometricHeuristic;
}

interface RouteSummary {
    weight: number;
    distance: number;
    algorithm: string;
    legs: {
        weight: number;
        distance: number;
    }[];
}
/** Converts a successful route to a GeoJSON LineString feature; `null` for failures. */
declare function toLineString<P>(result: RouteResult<P>): LineStringFeature<RouteSummary> | null;

/**
 * A* search. With the built-in heuristic (metric embedding × minimum cost-per-length, see
 * `graph/build.ts`) it is admissible and consistent for **any** weight function, so it returns the same
 * optimal cost as Dijkstra while settling far fewer nodes. Closed nodes are re-opened if a custom,
 * merely admissible heuristic ever finds them a cheaper label, so optimality never depends on
 * consistency. Without a heuristic it degenerates to Dijkstra. Supports multiple targets and budgets.
 */
declare const astar: PathAlgorithm;

/**
 * Dijkstra's algorithm with lazy deletion, stopping as soon as the target (or every target) is settled.
 * Works with any non-negative costs and needs no heuristic, which makes it the reference engine.
 */
declare const dijkstra: PathAlgorithm;

/**
 * Bidirectional Dijkstra: searches forward from the source and backward from the target and stops once the
 * two frontiers cannot improve the best meeting point. Useful when no heuristic is available (hop counts,
 * custom metrics without an embedding). Needs the graph's reverse adjacency; multi-target requests and
 * graphs without it fall back to plain Dijkstra.
 */
declare const bidirectionalDijkstra: PathAlgorithm;

/**
 * 4-ary min-heap with stable tie-breaking on insertion order.
 *
 * Adapted from terra-route (MIT, James Milner): parallel arrays instead of node objects, and a shallower
 * tree than a binary heap, which suits the insert-heavy workload of shortest-path search.
 * Parent(i) = (i - 1) >> 2, children(i) = 4i + 1 … 4i + 4.
 */
declare class FourAryHeap implements Heap {
    private keys;
    private values;
    private order;
    private length;
    private counter;
    insert(key: number, value: number): void;
    extractMin(): number;
    peekMinKey(): number;
    size(): number;
    clear(): void;
    private siftDown;
}

export { type AlgorithmCapabilities, AlgorithmRegistry, type CandidateCost, type CandidateDistinct, type CandidateFilter, type CandidateInfo, type CandidateOptions, type CandidateReport, type CandidateSide, type CandidateStatus, type ChainTable, type ComponentReport, type ComponentTable, type ConnectorMode, type DangleReport, type DeserializeOptions, type DiagnosticList, type DiagnosticsLog, type DiagnosticsOptions, type DirectionalWeight, EARTH_RADIUS_M, type EdgeTable, type FailurePolicy, FourAryHeap, GRAPH_FORMAT, GRAPH_FORMAT_VERSION, type GeometryLike, type GraphDiagnostics, type GraphHeader, type GraphOptions, type GraphSettings, type GraphStats, type GroupFunction, type GroupKey, type Heap, type HeapConstructor, type Heuristic, type InvalidCoordinateReport, type LandmarkOptions, type LandmarkStrategy, LandmarkTable, LineFinder, type LineFinderOptions, type LineStringFeature, type ManyOptions, type ManyResult, type MatrixResult, type Metric, type MetricOption, type NearestResult, type NetworkCollection, type NetworkFeature, type NodeChainTable, type NodeTable, type OverlapReport, type PathAlgorithm, type PointFeature, type PointGeometry, type Position, type PropertyWeightOptions, type RepairReport, type ReverseEdgeTable, type RouteFailure, type RouteFailureDetail, type RouteFailureReason, type RouteLeg, type RouteOptions, type RouteResult, type RouteSection, type RouteSuccess, type RouteSummary, RoutingGraph, type SearchBudget, type SearchGraph, type SearchRequest, type SearchResult, SearchScratch, type SectionsDetail, type SegmentTable, type SerializeOptions, type SkippedWaypoint, type SnapConnectivity, type SnapCostMode, type SnapMode, type SnapOptions, type SnapSelection, type SnappedWaypoint, type SpeedWeightOptions, type StrongComponents, type TargetPath, type TransferableGraph, type TransferableLandmarks, type TravelDirection, type VertexTable, type WaypointAccess, type WaypointContext, type WaypointInput, type WaypointObject, type WaypointRole, type WaypointSnapOptions, type WeightContext, type WeightFunction, type WeightResult, type ZeroWeight, astar, bidirectionalDijkstra, buildGraph, builtinAlgorithms, cheapRulerMetric, createAlgorithmRegistry, createPropertyWeight, createSpeedWeight, dijkstra, directional, distanceWeight, euclideanMetric, haversineDistance, haversineMetric, osmDirection, prepareLandmarks, reconstructPath, toLineString };
