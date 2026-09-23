import { localScale } from '../geo/metric';
import { projectToSegment, type SegmentProjection } from '../geo/segment';
import type { RoutingGraph } from '../graph/graph';
import type { GroupKey } from '../graph/topology';
import { partialCost } from '../route/assemble';
import type { NetworkFeature, Position } from '../types';

export type SnapMode = 'edge' | 'vertex' | 'node' | 'exact';
/**
 * How waypoints are placed when their nearest locations cannot all be routed between (nearest selection).
 * `'connected'` shares one weakly connected component, `'reachable'` one strongly connected component (every
 * leg then exists even on one-way networks), `'nearest'` never moves a waypoint.
 */
export type SnapConnectivity = 'connected' | 'nearest' | 'reachable';
/** `'nearest'`: each waypoint takes its nearest allowed location. `'optimal'`: the cheapest combination overall. */
export type SnapSelection = 'nearest' | 'optimal';
/** Which snap costs count: none, leaving the origin and reaching the destination, or also both at every via. */
export type SnapCostMode = 'none' | 'ends' | 'arrive-depart';
/**
 * Candidates kept per waypoint: the nearest per chain and source feature (`'chain'`, default), per source
 * feature, or per weakly connected component. A junction counts once.
 */
export type CandidateDistinct = 'chain' | 'feature' | 'component';
export type WaypointRole = 'origin' | 'via' | 'destination';
/** Side of the source feature's digitised direction the input point lies on. */
export type CandidateSide = 'left' | 'right' | 'on';

/** A place where a waypoint could attach to the network. */
export interface CandidateInfo<P = unknown> {
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

export interface WaypointContext {
  /** Index in the route's waypoint list. */
  readonly index: number;
  readonly input: Position;
  readonly role: WaypointRole;
}

/** Hard constraint: `false` removes the candidate. Express preferences through `cost`, never through filters. */
export type CandidateFilter = (candidate: CandidateInfo, context: WaypointContext) => boolean;
/** Cost of travelling between the input point and the candidate once (weight units, finite, ≥ 0). */
export type CandidateCost = (candidate: CandidateInfo, context: WaypointContext) => number;

/** Snapping options that may differ per waypoint (`{ coordinates, snap }` inputs). */
export interface WaypointSnapOptions {
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

export interface SnapOptions extends WaypointSnapOptions {
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

/** Where a snapped location attaches to the graph. */
export type Anchor =
  | { readonly kind: 'node'; readonly node: number }
  /** Strictly inside a chain: `position` = segment index + fraction, in `(0, segmentCount)`. */
  | { readonly kind: 'chain'; readonly chain: number; readonly position: number };

export interface SnapCandidate {
  anchor: Anchor;
  point: Position;
  distance: number;
  component: number;
  /** Source feature of the snapped segment; -1 at a junction shared by several features. */
  featureIndex: number;
}

export interface Candidate extends SnapCandidate {
  /** Public description (built on first access). */
  readonly info: CandidateInfo;
  /** Position among the accepted candidates of its waypoint, nearest first. */
  rank: number;
}

export function anchorAt(graph: RoutingGraph<unknown>, chain: number, position: number): Anchor {
  if (position <= 0) return { kind: 'node', node: graph.chains.from[chain] };
  if (position >= graph.segmentCountOf(chain)) return { kind: 'node', node: graph.chains.to[chain] };
  return { kind: 'chain', chain, position };
}

export function anchorComponent(graph: RoutingGraph<unknown>, anchor: Anchor): number {
  return anchor.kind === 'node' ? graph.nodes.component[anchor.node] : graph.chains.component[anchor.chain];
}

export function sameAnchor(a: Anchor, b: Anchor): boolean {
  if (a.kind === 'node') return b.kind === 'node' && a.node === b.node;
  return b.kind === 'chain' && a.chain === b.chain && a.position === b.position;
}

/**
 * Strongly connected component shared by everything the anchor can reach and be reached from, or -1 when
 * the location is not inside one (e.g. partway along a one-way chain between two components).
 */
export function anchorStrongKey(graph: RoutingGraph<unknown>, anchor: Anchor): number {
  const scc = graph.strongComponents().node;
  if (anchor.kind === 'node') return scc[anchor.node];
  const { chain, position } = anchor;
  const from = graph.chains.from[chain];
  const to = graph.chains.to[chain];
  if (scc[from] !== scc[to]) return -1;
  const n = graph.segmentCountOf(chain);
  const reached =
    partialCost(graph, chain, 0, position) < Infinity || partialCost(graph, chain, n, position) < Infinity;
  const leaves =
    partialCost(graph, chain, position, n) < Infinity || partialCost(graph, chain, position, 0) < Infinity;
  return reached && leaves ? scc[from] : -1;
}

interface Hit {
  anchor: Anchor;
  point: Position;
  /** Legacy feature index of the hit (-1 for junctions in vertex / node mode). */
  featureIndex: number;
  /** Chain and position the hit was found on (-1 for node hits in vertex / node mode). */
  chain: number;
  position: number;
  /** Segment slot the hit was projected on, or -1. */
  slot: number;
}

function buildInfo(
  graph: RoutingGraph<unknown>,
  x: number,
  y: number,
  hit: Hit,
  distance: number,
): CandidateInfo {
  const { chains, segments, vertices } = graph;
  let chain = hit.chain;
  let position = hit.position;
  let features: number[];
  let group: number;
  if (hit.anchor.kind === 'node') {
    const node = hit.anchor.node;
    group = graph.vertexGroup(graph.nodes.vertex[node]);
    features = graph.nodeFeatures(node);
    if (chain < 0) {
      const incident = graph.nodeChains();
      const k = incident.offsets[node];
      if (k < incident.offsets[node + 1]) {
        chain = incident.chains[k];
        position = incident.atStart[k] ? 0 : graph.segmentCountOf(chain);
      }
    }
  } else {
    const base = chains.segStart[chain];
    const i = Math.floor(position);
    group =
      i === position ? graph.vertexGroup(chains.vertices[base + chain + i]) : graph.segmentGroup(base + i);
    features =
      i === position
        ? [...new Set([segments.feature[base + i - 1], segments.feature[base + i]])]
        : [segments.feature[base + i]];
  }
  if (hit.featureIndex >= 0 && features[0] !== hit.featureIndex) {
    features = [hit.featureIndex, ...features.filter((f) => f !== hit.featureIndex)];
  }
  const primary = hit.featureIndex >= 0 ? hit.featureIndex : (features[0] ?? -1);

  let side: CandidateSide = 'on';
  let measure = NaN;
  if (chain >= 0) {
    const n = graph.segmentCountOf(chain);
    const slot = hit.slot >= 0 ? hit.slot : chains.segStart[chain] + Math.min(Math.floor(position), n - 1);
    const local = slot - chains.segStart[chain];
    const { measureStart, measureEnd } = segments;
    measure = measureStart[slot] + (position - local) * (measureEnd[slot] - measureStart[slot]);
    if (distance > 0) {
      const a = chains.vertices[slot + chain];
      const b = chains.vertices[slot + chain + 1];
      const { sx, sy } = localScale(graph.metric, y);
      const dx = (vertices.x[b] - vertices.x[a]) * sx;
      const dy = (vertices.y[b] - vertices.y[a]) * sy;
      let cross = dx * (y - vertices.y[a]) * sy - dy * (x - vertices.x[a]) * sx;
      if (segments.reversed[slot]) cross = -cross;
      side = cross > 0 ? 'left' : cross < 0 ? 'right' : 'on';
    }
  }
  return {
    location: hit.point,
    distance,
    featureIndex: hit.featureIndex,
    featureIndices: features,
    featureId: primary >= 0 ? graph.featureId(primary) : undefined,
    feature: primary >= 0 ? graph.features[primary] : undefined,
    side,
    measure,
    component: anchorComponent(graph, hit.anchor),
    group: group >= 0 ? graph.groupKeys[group] : undefined,
    rank: 0,
  };
}

/** A candidate whose public description is computed on first access. */
class LazyCandidate implements Candidate {
  rank = 0;
  private cached: CandidateInfo | null;

  constructor(
    private readonly graph: RoutingGraph<unknown>,
    private readonly x: number,
    private readonly y: number,
    private readonly hit: Hit,
    readonly distance: number,
    readonly component: number,
    info: CandidateInfo | null,
  ) {
    this.cached = info;
  }

  get anchor(): Anchor {
    return this.hit.anchor;
  }

  get point(): Position {
    return this.hit.point;
  }

  get featureIndex(): number {
    return this.hit.featureIndex;
  }

  get info(): CandidateInfo {
    this.cached ??= buildInfo(this.graph, this.x, this.y, this.hit, this.distance);
    (this.cached as { rank: number }).rank = this.rank;
    return this.cached;
  }
}

export interface CandidateSearch {
  mode: SnapMode;
  maxDistance: number;
  /** Stop after accepting this many. */
  limit: number;
  /** Stop after examining this many index items (accepted or not). */
  searchLimit: number;
  /** One candidate per chain / feature / weak component / strong component. */
  distinct: CandidateDistinct | 'strong';
  /** Hard constraints; `null` accepts everything. */
  accept: ((info: CandidateInfo) => boolean) | null;
  /**
   * The group constraint (also part of `accept`). It selects what is scanned: only the segments, vertices or
   * nodes of this group ({@link RoutingGraph.groupSpatialIndex}), and in exact mode the vertex lookup.
   */
  group?: GroupKey;
  /** Receives rejected candidates (debugging). */
  rejected?: CandidateInfo[];
}

export interface CandidateSet {
  /** Accepted candidates in ascending distance, `info.rank` = index. */
  list: Candidate[];
  /** Candidates removed by `accept`. */
  filtered: number;
  /** The scan stopped at `searchLimit` before `limit` candidates were accepted: farther ones were not examined. */
  truncated: boolean;
  /** Nothing of the constrained group was within reach, but locations of other groups were. */
  otherGroups: boolean;
}

/**
 * Nearest snap locations for one point, in ascending distance, keeping one per `distinct` key among the
 * accepted ones, until `limit` were accepted or `searchLimit` index items were examined. With a `group`
 * constraint only that group's part of the network is scanned.
 */
export function searchCandidates(
  graph: RoutingGraph<unknown>,
  x: number,
  y: number,
  s: CandidateSearch,
): CandidateSet {
  const input: Position = [x, y];
  const list: Candidate[] = [];
  const keys = new Set<number>();
  let scanned = 0;
  let filtered = 0;
  let truncated = false;
  // An unknown group key scans everything (and rejects everything), as the constraint alone would.
  const groupIndex = s.group !== undefined && graph.vertices.group ? graph.groupIndex(s.group) : -1;
  const offer = (hit: Hit): boolean => {
    scanned++;
    const distance = graph.metric.distance(input, hit.point);
    if (distance <= s.maxDistance) {
      let info: CandidateInfo | null = null;
      let key: number;
      switch (s.distinct) {
        case 'component':
          key = anchorComponent(graph, hit.anchor);
          break;
        case 'chain':
          // Per chain *and* source feature: a compacted chain can run through several features (a ring of
          // aisles is one chain), and each of them is a distinct way onto the network.
          key =
            hit.anchor.kind === 'node'
              ? -1 - hit.anchor.node
              : hit.anchor.chain * (graph.features.length + 1) + hit.featureIndex;
          break;
        case 'feature':
          info = buildInfo(graph, x, y, hit, distance);
          key = info.featureIndices[0] ?? -1;
          break;
        default:
          key = anchorStrongKey(graph, hit.anchor);
          if (key < 0) key = NaN; // not inside a strong component: never shares a key
      }
      if (!keys.has(key)) {
        // Descriptions are only built when a constraint needs one; otherwise lazily, for the few candidates
        // a result actually reports.
        if (s.accept) info ??= buildInfo(graph, x, y, hit, distance);
        if (!s.accept || s.accept(info!)) {
          list.push(new LazyCandidate(graph, x, y, hit, distance, anchorComponent(graph, hit.anchor), info));
          if (!Number.isNaN(key)) keys.add(key);
        } else {
          filtered++;
          s.rejected?.push(info!);
        }
      }
    }
    if (list.length >= s.limit) return false;
    if (scanned >= s.searchLimit) {
      truncated = true;
      return false;
    }
    return true;
  };
  // Tree distances are in a local equirectangular plane; leave a little slack before the exact check.
  const bound = s.maxDistance === Infinity ? Infinity : s.maxDistance * 1.05 + 1e-9;
  const { sx, sy } = localScale(graph.metric, y);
  const X = graph.vertices.x;
  const Y = graph.vertices.y;

  const vertexHit = (vertex: number): Hit => {
    const { node, chain, chainPos, positions } = graph.vertices;
    if (node[vertex] >= 0) {
      return {
        anchor: { kind: 'node', node: node[vertex] },
        point: positions[vertex],
        featureIndex: -1,
        chain: -1,
        position: 0,
        slot: -1,
      };
    }
    const c = chain[vertex];
    const slot = graph.chains.segStart[c] + chainPos[vertex];
    return {
      anchor: { kind: 'chain', chain: c, position: chainPos[vertex] },
      point: positions[vertex],
      featureIndex: graph.segments.feature[slot],
      chain: c,
      position: chainPos[vertex],
      slot,
    };
  };

  /** Visits the hits of the chosen index in ascending distance while `visit` returns `true`. */
  const scan = (restrict: boolean, visit: (hit: Hit) => boolean): void => {
    switch (s.mode) {
      case 'exact': {
        const v = graph.findVertex(x, y, s.group);
        if (v !== -1 && graph.isLiveVertex(v)) visit(vertexHit(v));
        break;
      }
      case 'edge': {
        const sub = restrict ? graph.groupSpatialIndex('segment', groupIndex) : null;
        const tree = sub ? sub.tree : graph.segmentIndex;
        const items = sub ? sub.items : null;
        const proj: SegmentProjection = { t: 0, x: 0, y: 0 };
        const segChain = graph.segments.chain;
        const feature = graph.segments.feature;
        const { vertices: cv, segStart } = graph.chains;
        tree.nearest(
          x,
          y,
          sx,
          sy,
          (i) => {
            const k = items ? items[i] : i;
            const c = segChain[k];
            const a = cv[k + c];
            const b = cv[k + c + 1];
            return projectToSegment(x, y, X[a], Y[a], X[b], Y[b], sx, sy, proj);
          },
          (i) => {
            const k = items ? items[i] : i;
            const c = segChain[k];
            const a = cv[k + c];
            const b = cv[k + c + 1];
            projectToSegment(x, y, X[a], Y[a], X[b], Y[b], sx, sy, proj);
            const position = k - segStart[c] + proj.t;
            return visit({
              anchor: anchorAt(graph, c, position),
              point: graph.pointAt(c, position),
              featureIndex: feature[k],
              chain: c,
              position,
              slot: k,
            });
          },
          bound,
        );
        break;
      }
      case 'vertex': {
        const { tree, items } = restrict
          ? graph.groupSpatialIndex('vertex', groupIndex)
          : graph.vertexSpatialIndex();
        tree.nearest(
          x,
          y,
          sx,
          sy,
          (i) => Math.hypot((x - X[items[i]]) * sx, (y - Y[items[i]]) * sy),
          (i) => visit(vertexHit(items[i])),
          bound,
        );
        break;
      }
      case 'node': {
        const sub = restrict ? graph.groupSpatialIndex('node', groupIndex) : null;
        const tree = sub ? sub.tree : graph.nodeSpatialIndex();
        const items = sub ? sub.items : null;
        const nodeVertex = graph.nodes.vertex;
        const positions = graph.vertices.positions;
        tree.nearest(
          x,
          y,
          sx,
          sy,
          (i) => {
            const v = nodeVertex[items ? items[i] : i];
            return Math.hypot((x - X[v]) * sx, (y - Y[v]) * sy);
          },
          (i) => {
            const n = items ? items[i] : i;
            return visit({
              anchor: { kind: 'node', node: n },
              point: positions[nodeVertex[n]],
              featureIndex: -1,
              chain: -1,
              position: 0,
              slot: -1,
            });
          },
          bound,
        );
        break;
      }
      default:
        throw new RangeError(`Unknown snap mode "${String(s.mode)}".`);
    }
  };

  const restrict = groupIndex >= 0 && s.mode !== 'exact';
  scan(restrict, offer);
  // Other groups were not scanned. When the group has nothing within reach, tell "only other floors are
  // here" (a constraint problem) apart from "nothing is here" with one probe of the whole network.
  let otherGroups = false;
  if (restrict && list.length === 0 && filtered === 0) {
    scan(false, (hit) => {
      otherGroups = graph.metric.distance(input, hit.point) <= s.maxDistance;
      return !otherGroups;
    });
  }
  list.sort((a, b) => a.distance - b.distance);
  for (let i = 0; i < list.length; i++) list[i].rank = i;
  return { list, filtered, truncated, otherGroups };
}
