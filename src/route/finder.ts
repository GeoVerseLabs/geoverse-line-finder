import { createAlgorithmRegistry, type AlgorithmRegistry } from '../algorithm/registry';
import { SearchScratch } from '../algorithm/scratch';
import type { Heuristic, PathAlgorithm } from '../algorithm/types';
import { buildGraph, type GraphOptions } from '../graph/build';
import { RoutingGraph } from '../graph/graph';
import { isPosition } from '../graph/topology';
import type { HeapConstructor } from '../heap/heap';
import {
  findSnapCandidates,
  sameAnchor,
  snapWaypoints,
  type SnapCandidate,
  type SnapMode,
  type SnapOptions,
} from '../snap/snap';
import type { NetworkCollection, Position, WaypointInput } from '../types';
import { assemblePieces, edgePiece, partialCost, type RouteSection } from './assemble';
import { QueryGraph } from './query-graph';

export interface LineFinderOptions<P = unknown> extends GraphOptions<P> {
  /** Default engine for {@link LineFinder.route}. Default `'astar'`. */
  algorithm?: string | PathAlgorithm;
  /** Engine registry; defaults to a fresh registry holding the built-in `dijkstra` and `astar`. */
  algorithms?: AlgorithmRegistry;
  /** Priority queue used by the engines. Default {@link FourAryHeap}. */
  heap?: HeapConstructor;
  /** Default snapping behaviour, overridable per route. */
  snap?: SnapOptions;
}

export interface RouteOptions {
  algorithm?: string | PathAlgorithm;
  snap?: SnapOptions;
  /**
   * Prepend the raw start input and append the raw end input as straight connectors when they differ
   * from their snapped locations. Geometry only: `weight` and `distance` cover the network part.
   */
  connectors?: boolean;
}

export interface SnappedWaypoint {
  /** The coordinate that was asked for. */
  input: Position;
  /** Where it attached to the network. */
  location: Position;
  /** Distance between the two (metric units). */
  distance: number;
  component: number;
  featureIndex: number;
}

export interface RouteLeg<P = unknown> {
  /** Waypoint indices joined by this leg. */
  from: number;
  to: number;
  path: Position[];
  weight: number;
  distance: number;
  sections: RouteSection<P>[];
  /** Engine statistics for this leg. */
  settled: number;
  relaxed: number;
}

export interface RouteSuccess<P = unknown> {
  ok: true;
  /** Full route geometry; coordinates may be shared with the input network — copy before mutating. */
  path: Position[];
  /** Total cost (the quantity that was minimised). */
  weight: number;
  /** Total length along the network (metric units). */
  distance: number;
  legs: RouteLeg<P>[];
  waypoints: SnappedWaypoint[];
  algorithm: string;
}

export type RouteFailureReason = 'INVALID_INPUT' | 'SNAP_FAILED' | 'DISCONNECTED' | 'UNREACHABLE';

export interface RouteFailure {
  ok: false;
  reason: RouteFailureReason;
  message: string;
  waypointIndex?: number;
  legIndex?: number;
  waypoints?: SnappedWaypoint[];
  algorithm: string;
}

export type RouteResult<P = unknown> = RouteSuccess<P> | RouteFailure;

export interface NearestResult {
  location: Position;
  distance: number;
  component: number;
  featureIndex: number;
}

type LegCore<P> = Omit<RouteLeg<P>, 'from' | 'to'>;

function toPosition(input: unknown): Position | null {
  if (isPosition(input)) return input;
  if (input && typeof input === 'object') {
    const o = input as { type?: unknown; geometry?: unknown; coordinates?: unknown };
    const geometry = (o.type === 'Feature' ? o.geometry : o) as {
      type?: unknown;
      coordinates?: unknown;
    } | null;
    if (geometry && geometry.type === 'Point' && isPosition(geometry.coordinates))
      return geometry.coordinates;
  }
  return null;
}

function samePoint(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
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
export class LineFinder<P = unknown> {
  readonly graph: RoutingGraph<P>;
  readonly algorithms: AlgorithmRegistry;
  private readonly defaultAlgorithm: string | PathAlgorithm;
  private readonly defaultSnap: SnapOptions;
  private readonly scratch: SearchScratch;
  private readonly query: QueryGraph;

  /** Accepts a network (built with `options`) or a prebuilt {@link RoutingGraph} to share between finders. */
  constructor(network: NetworkCollection<P> | RoutingGraph<P>, options: LineFinderOptions<P> = {}) {
    this.graph = network instanceof RoutingGraph ? network : buildGraph(network, options);
    this.algorithms = options.algorithms ?? createAlgorithmRegistry();
    this.defaultAlgorithm = options.algorithm ?? 'astar';
    this.algorithms.resolve(this.defaultAlgorithm);
    this.defaultSnap = { ...options.snap };
    this.scratch = new SearchScratch(options.heap);
    this.query = new QueryGraph(this.graph);
  }

  /** Registers an engine on this finder's registry (chainable). */
  registerAlgorithm(algorithm: PathAlgorithm, options?: { replace?: boolean }): this {
    this.algorithms.register(algorithm, options);
    return this;
  }

  /** Two-point convenience for {@link route}. */
  findPath(start: WaypointInput, end: WaypointInput, options?: RouteOptions): RouteResult<P> {
    return this.route([start, end], options);
  }

  /** Nearest network location to a point, or `null` when none is within `maxDistance`. */
  nearest(
    point: WaypointInput,
    options: { mode?: SnapMode; maxDistance?: number } = {},
  ): NearestResult | null {
    const p = toPosition(point);
    if (!p) throw new TypeError('Expected a position, Point geometry or Point feature.');
    const mode = options.mode ?? this.defaultSnap.mode ?? 'edge';
    const maxDistance = options.maxDistance ?? this.defaultSnap.maxDistance ?? Infinity;
    const [c] = findSnapCandidates(this.graph, p[0], p[1], mode, maxDistance, 1, 1);
    return c
      ? { location: c.point, distance: c.distance, component: c.component, featureIndex: c.featureIndex }
      : null;
  }

  /**
   * Route through `waypoints` in the given order (two or more). Each consecutive pair is one leg; the
   * route fails as a whole if any leg is impossible, reporting which one.
   */
  route(waypoints: readonly WaypointInput[], options: RouteOptions = {}): RouteResult<P> {
    const algorithm = this.algorithms.resolve(options.algorithm ?? this.defaultAlgorithm);
    const fail = (
      reason: RouteFailureReason,
      message: string,
      extra: Partial<Omit<RouteFailure, 'ok' | 'reason' | 'message' | 'algorithm'>> = {},
    ): RouteFailure => ({ ok: false, reason, message, ...extra, algorithm: algorithm.name });

    if (!Array.isArray(waypoints) || waypoints.length < 2) {
      return fail('INVALID_INPUT', 'A route needs at least two waypoints.');
    }
    const inputs: Position[] = [];
    for (let i = 0; i < waypoints.length; i++) {
      const p = toPosition(waypoints[i]);
      if (!p)
        return fail('INVALID_INPUT', `Waypoint #${i} is not a position, Point or Point feature.`, {
          waypointIndex: i,
        });
      inputs.push(p);
    }

    const snapped = snapWaypoints(this.graph, inputs, { ...this.defaultSnap, ...options.snap });
    if (!snapped.ok) return fail(snapped.reason, snapped.message, { waypointIndex: snapped.waypointIndex });
    const snaps = snapped.snaps;
    const waypointsOut: SnappedWaypoint[] = snaps.map((s, i) => ({
      input: inputs[i],
      location: s.point,
      distance: s.distance,
      component: s.component,
      featureIndex: s.featureIndex,
    }));

    const legs: RouteLeg<P>[] = [];
    for (let i = 0; i + 1 < snaps.length; i++) {
      const leg = this.solveLeg(snaps[i], snaps[i + 1], algorithm);
      if (!leg) {
        return fail('UNREACHABLE', `No path from waypoint #${i} to waypoint #${i + 1}.`, {
          legIndex: i,
          waypoints: waypointsOut,
        });
      }
      legs.push({ from: i, to: i + 1, ...leg });
    }

    const path: Position[] = [];
    let weight = 0;
    let distance = 0;
    for (const leg of legs) {
      weight += leg.weight;
      distance += leg.distance;
      // Consecutive legs meet at the shared waypoint location: drop the duplicate.
      for (let j = path.length > 0 ? 1 : 0; j < leg.path.length; j++) path.push(leg.path[j]);
    }
    if (options.connectors) {
      const first = inputs[0];
      const last = inputs[inputs.length - 1];
      if (!samePoint(first, path[0])) path.unshift(first);
      if (!samePoint(last, path[path.length - 1])) path.push(last);
    }
    return { ok: true, path, weight, distance, legs, waypoints: waypointsOut, algorithm: algorithm.name };
  }

  private solveLeg(a: SnapCandidate, b: SnapCandidate, algorithm: PathAlgorithm): LegCore<P> | null {
    if (sameAnchor(a.anchor, b.anchor)) {
      return { path: [a.point], weight: 0, distance: 0, sections: [], settled: 0, relaxed: 0 };
    }
    const graph = this.graph;
    const q = this.query;
    const chains = graph.chains;
    q.reset();

    let source: number;
    if (a.anchor.kind === 'node') {
      source = a.anchor.node;
    } else {
      source = q.virtualSource;
      const { chain, position } = a.anchor;
      const n = graph.segmentCountOf(chain);
      q.add(source, chains.from[chain], chain, position, 0, partialCost(graph, chain, position, 0));
      q.add(source, chains.to[chain], chain, position, n, partialCost(graph, chain, position, n));
    }
    let target: number;
    if (b.anchor.kind === 'node') {
      target = b.anchor.node;
    } else {
      target = q.virtualTarget;
      const { chain, position } = b.anchor;
      const n = graph.segmentCountOf(chain);
      q.add(chains.from[chain], target, chain, 0, position, partialCost(graph, chain, 0, position));
      q.add(chains.to[chain], target, chain, n, position, partialCost(graph, chain, n, position));
      if (a.anchor.kind === 'chain' && a.anchor.chain === chain) {
        const start = a.anchor.position;
        q.add(source, target, chain, start, position, partialCost(graph, chain, start, position));
      }
    }

    if (!this.mayConnect(source, target)) return null;
    const heuristic = algorithm.usesHeuristic ? this.heuristicTo(b.point) : null;
    const result = algorithm.search({ graph: q, source, target, heuristic, scratch: this.scratch });
    if (!result.found) return null;

    const pieces = result.edges.map((e) =>
      e < q.baseEdgeCount ? edgePiece(graph, e) : q.piece(e - q.baseEdgeCount),
    );
    const assembled = assemblePieces(graph, pieces);
    return {
      path: assembled.path.length > 0 ? assembled.path : [a.point],
      weight: result.cost,
      distance: assembled.distance,
      sections: assembled.sections,
      settled: result.settled,
      relaxed: result.relaxed,
    };
  }

  /** Cheap reject: can the source's reachable nodes and the target's feeding nodes share a component? */
  private mayConnect(source: number, target: number): boolean {
    const q = this.query;
    const N = this.graph.nodes.count;
    const component = this.graph.nodes.component;
    const from: number[] = [];
    const to: number[] = [];
    if (source < N) from.push(component[source]);
    if (target < N) to.push(component[target]);
    for (let k = 0; k < q.overlayCount; k++) {
      const a = q.overlayFrom[k];
      const b = q.overlayTo[k];
      if (a === source && b === target) return true;
      if (a === source && b < N) from.push(component[b]);
      if (b === target && a < N) to.push(component[a]);
    }
    return from.some((c) => to.includes(c));
  }

  private heuristicTo(targetPoint: Position): Heuristic | null {
    const { dims, scale } = this.graph.heuristic;
    if (!(scale > 0)) return null;
    const N = this.graph.nodes.count;
    const emb = this.graph.nodes.embedding;
    const t = new Float64Array(dims);
    this.graph.metric.embed!(targetPoint[0], targetPoint[1], t, 0);
    // Virtual nodes get 0, which is trivially admissible.
    if (dims === 3) {
      const tx = t[0];
      const ty = t[1];
      const tz = t[2];
      return (node) => {
        if (node >= N) return 0;
        const o = node * 3;
        const dx = emb[o] - tx;
        const dy = emb[o + 1] - ty;
        const dz = emb[o + 2] - tz;
        return scale * Math.sqrt(dx * dx + dy * dy + dz * dz);
      };
    }
    if (dims === 2) {
      const tx = t[0];
      const ty = t[1];
      return (node) => {
        if (node >= N) return 0;
        const dx = emb[2 * node] - tx;
        const dy = emb[2 * node + 1] - ty;
        return scale * Math.sqrt(dx * dx + dy * dy);
      };
    }
    return (node) => {
      if (node >= N) return 0;
      let sum = 0;
      for (let d = 0, o = node * dims; d < dims; d++) {
        const diff = emb[o + d] - t[d];
        sum += diff * diff;
      }
      return scale * Math.sqrt(sum);
    };
  }
}
