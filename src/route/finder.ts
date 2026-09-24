import {
  LandmarkTable,
  landmarkHeuristic,
  prepareLandmarks,
  type LandmarkOptions,
} from '../algorithm/landmarks';
import { createAlgorithmRegistry, type AlgorithmRegistry } from '../algorithm/registry';
import { SearchScratch } from '../algorithm/scratch';
import type { Heuristic, PathAlgorithm } from '../algorithm/types';
import { buildGraph, type GraphOptions } from '../graph/build';
import { RoutingGraph } from '../graph/graph';
import type { HeapConstructor } from '../heap/heap';
import {
  searchCandidates,
  type Anchor,
  type CandidateInfo,
  type SnapCandidate,
  type SnapMode,
  type SnapOptions,
  type WaypointRole,
} from '../snap/snap';
import type { NetworkCollection, WaypointInput } from '../types';
import type { SectionsDetail } from './assemble';
import { composeRoute, type PolicyOptions, type WaypointSpec } from './compose';
import { snapPoint, solveOneToMany, type SnappedPoint } from './many';
import { planNearest } from './nearest';
import { planOptimal } from './optimal';
import { candidateAcceptor, readWaypoint, resolveSnap } from './options';
import { QueryGraph } from './query-graph';
import type { RouteContext } from './search';
import type {
  CandidateOptions,
  ConnectorMode,
  ManyOptions,
  ManyResult,
  MatrixResult,
  NearestResult,
  RouteFailure,
  RouteFailureReason,
  RouteOptions,
  RouteResult,
  SearchBudget,
} from './types';

export type {
  CandidateOptions,
  CandidateReport,
  CandidateStatus,
  ConnectorMode,
  FailurePolicy,
  ManyOptions,
  ManyResult,
  MatrixResult,
  NearestResult,
  RouteFailure,
  RouteFailureDetail,
  RouteFailureReason,
  RouteLeg,
  RouteOptions,
  RouteResult,
  RouteSuccess,
  SearchBudget,
  SkippedWaypoint,
  SnappedWaypoint,
  WaypointAccess,
} from './types';

export interface LineFinderOptions<P = unknown> extends GraphOptions<P> {
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
 * Level span of a goal location: the one level it sits on, or the two levels a connector runs between when
 * the goal snapped into the middle of a staircase. A node whose ordinal is unknown yields `NaN`, which
 * switches the level term off for that goal.
 */
function goalOrdinalRange(graph: RoutingGraph<unknown>, anchor: Anchor): [number, number] {
  if (anchor.kind === 'node') {
    const o = graph.groupOrdinal(graph.vertexGroup(graph.nodes.vertex[anchor.node]));
    return [o, o];
  }
  const { chain, position } = anchor;
  const group = graph.levelAt(chain, position);
  if (group >= 0) {
    const o = graph.groupOrdinal(group);
    return [o, o];
  }
  const base = graph.chains.segStart[chain] + chain;
  const n = graph.segmentCountOf(chain);
  const i = Math.floor(position);
  let low = NaN;
  let high = NaN;
  for (let k = i; k >= 0; k--) {
    const g = graph.vertexGroup(graph.chains.vertices[base + k]);
    if (g >= 0) {
      low = graph.groupOrdinal(g);
      break;
    }
  }
  for (let k = i + 1; k <= n; k++) {
    const g = graph.vertexGroup(graph.chains.vertices[base + k]);
    if (g >= 0) {
      high = graph.groupOrdinal(g);
      break;
    }
  }
  if (Number.isNaN(low)) low = high;
  if (Number.isNaN(high)) high = low;
  return [Math.min(low, high), Math.max(low, high)];
}

function roleOf(index: number, count: number): WaypointRole {
  return index === 0 ? 'origin' : index === count - 1 ? 'destination' : 'via';
}

function resolveBudget(budget: SearchBudget | undefined): { maxCost: number; maxSettled: number } {
  const maxCost = budget?.maxCost ?? Infinity;
  const maxSettled = budget?.maxSettled ?? Infinity;
  if (!(maxCost >= 0)) throw new RangeError(`budget.maxCost must be ≥ 0, got ${String(maxCost)}.`);
  if (!(maxSettled >= 1)) throw new RangeError(`budget.maxSettled must be ≥ 1, got ${String(maxSettled)}.`);
  return { maxCost, maxSettled };
}

function resolveDetail(detail: SectionsDetail | undefined): SectionsDetail {
  if (detail === undefined) return 'feature';
  if (detail !== 'feature' && detail !== 'measure' && detail !== 'segment') {
    throw new RangeError(`sectionsDetail must be "feature", "measure" or "segment", got ${String(detail)}.`);
  }
  return detail;
}

function resolvePolicy(options: RouteOptions): PolicyOptions {
  const policy = options.onFailure ?? 'fail';
  if (policy !== 'fail' && policy !== 'skip' && policy !== 'straight') {
    throw new RangeError(`onFailure must be "fail", "skip" or "straight", got ${String(policy)}.`);
  }
  const maxSkips = options.skip?.max ?? Infinity;
  if (!(maxSkips >= 0)) throw new RangeError(`skip.max must be ≥ 0, got ${String(maxSkips)}.`);
  const straightCost = options.straightCost ?? ((d: number) => d);
  if (typeof straightCost !== 'function') throw new TypeError('straightCost must be a function.');
  return {
    policy,
    leading: options.skip?.leading === true,
    maxSkips,
    straightCost,
    debug: options.debug?.candidates === true,
  };
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
  /** Landmark table used by heuristic engines, if any. */
  readonly landmarks: LandmarkTable | null;
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
    const landmarks = options.landmarks;
    this.landmarks =
      landmarks instanceof LandmarkTable
        ? landmarks
        : landmarks
          ? prepareLandmarks(this.graph as RoutingGraph<unknown>, landmarks)
          : null;
    if (this.landmarks && !this.landmarks.matches(this.graph as RoutingGraph<unknown>)) {
      throw new RangeError('The landmark table was built for a different graph.');
    }
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
    const parsed = readWaypoint(point);
    if (!parsed) throw new TypeError('Expected a position, Point geometry or Point feature.');
    const [x, y] = parsed.position;
    const { list } = searchCandidates(this.graph, x, y, {
      mode: options.mode ?? this.defaultSnap.mode ?? 'edge',
      maxDistance: options.maxDistance ?? this.defaultSnap.maxDistance ?? Infinity,
      limit: 1,
      searchLimit: 1,
      distinct: 'component',
      accept: null,
    });
    const c = list[0];
    return c
      ? { location: c.point, distance: c.distance, component: c.component, featureIndex: c.featureIndex }
      : null;
  }

  /**
   * The allowed snap locations of a point, nearest first, after the constraints of `options` (and of a
   * `{ coordinates, snap }` input). Returns up to `candidates` (default 16) — for diagnostics or custom logic.
   */
  candidates(point: WaypointInput, options: CandidateOptions = {}): CandidateInfo[] {
    const parsed = readWaypoint(point);
    if (!parsed)
      throw new TypeError('Expected a position, Point geometry, Point feature or { coordinates }.');
    const { role, ...snapOptions } = options;
    const base: SnapOptions = { ...this.defaultSnap, ...snapOptions };
    base.candidates = options.candidates ?? parsed.snap?.candidates ?? 16;
    const snap = resolveSnap(base, parsed.snap ? { ...parsed.snap, candidates: base.candidates } : undefined);
    const context = { index: 0, input: parsed.position, role: role ?? 'origin' };
    const [x, y] = parsed.position;
    return searchCandidates(this.graph, x, y, {
      mode: snap.mode,
      maxDistance: snap.maxDistance,
      limit: snap.candidates,
      searchLimit: snap.searchLimit,
      distinct: snap.distinctBy,
      accept: candidateAcceptor(this.graph, snap, context),
      group: snap.group,
    }).list.map((c) => c.info);
  }

  /**
   * Route through `waypoints` in the given order (two or more). Each consecutive pair is one leg. By default
   * the route fails as a whole if any waypoint cannot be snapped or reached, reporting which one; see
   * `onFailure`, and `snap.selection` for choosing locations by total cost instead of distance.
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
    const parsed = [];
    for (let i = 0; i < waypoints.length; i++) {
      const p = readWaypoint(waypoints[i]);
      if (!p) {
        return fail('INVALID_INPUT', `Waypoint #${i} is not a position, Point or Point feature.`, {
          waypointIndex: i,
        });
      }
      parsed.push(p);
    }

    const snapOptions: SnapOptions = { ...this.defaultSnap, ...options.snap };
    const routeSnap = resolveSnap(snapOptions);
    const n = parsed.length;
    const specs: WaypointSpec[] = parsed.map((p, i) => ({
      input: p.position,
      snap: p.snap ? resolveSnap(snapOptions, p.snap) : routeSnap,
      context: { index: i, input: p.position, role: roleOf(i, n) },
    }));
    const policy = resolvePolicy(options);
    const connectors = options.connectors;
    if (
      connectors !== undefined &&
      typeof connectors !== 'boolean' &&
      connectors !== 'ends' &&
      connectors !== 'legs'
    ) {
      throw new RangeError(`connectors must be a boolean, "ends" or "legs", got ${String(connectors)}.`);
    }
    const sectionsDetail = resolveDetail(options.sectionsDetail);
    const z = options.output?.z;
    if (z !== undefined && z !== 'elevation') {
      throw new RangeError(`output.z must be "elevation", got ${String(z)}.`);
    }
    const ctx = this.context(algorithm, options.budget);

    const plan =
      routeSnap.selection === 'optimal'
        ? planOptimal(ctx, routeSnap, specs, policy)
        : planNearest(ctx, routeSnap, specs, policy);
    if (!plan.ok) {
      const { ok: _ok, reason, message, ...extra } = plan;
      return fail(reason, message, extra);
    }
    const connectorMode: false | ConnectorMode = connectors === true ? 'ends' : connectors || false;
    return composeRoute(this.graph, plan, {
      connectors: connectorMode,
      includeSnapWeight: options.totals?.includeSnapWeight === true,
      includeConnectorDistance: options.totals?.includeConnectorDistance === true,
      sectionsDetail,
      z: z === 'elevation',
      algorithm: algorithm.name,
    });
  }

  /**
   * Weights (and optionally routes) from one point to many, with a single search tree. Every point snaps
   * to its nearest allowed location.
   */
  oneToMany(
    source: WaypointInput,
    targets: readonly WaypointInput[],
    options: ManyOptions = {},
  ): ManyResult<P> | RouteFailure {
    const algorithm = this.algorithms.resolve(options.algorithm ?? this.defaultAlgorithm);
    const snapped = this.snapMany([source, ...targets], options, algorithm.name);
    if (!Array.isArray(snapped)) return snapped;
    const [origin, ...points] = snapped;
    if (!origin.candidate) {
      return {
        ok: false,
        reason: 'SNAP_FAILED',
        message: `No network location found for the source.`,
        waypointIndex: 0,
        algorithm: algorithm.name,
      };
    }
    const ctx = this.context(algorithm, options.budget);
    const core = solveOneToMany(
      ctx,
      origin.candidate,
      points,
      options.paths === true,
      resolveDetail(options.sectionsDetail),
    );
    const result: ManyResult<P> = {
      ok: true,
      source: origin.output!,
      targets: points.map((p) => p.output),
      weights: core.weights,
      distances: core.distances,
      settled: core.settled,
      relaxed: core.relaxed,
      algorithm: algorithm.name,
    };
    if (core.legs) result.legs = core.legs;
    return result;
  }

  /** Weight matrix between origins and destinations (one search per origin). */
  matrix(
    origins: readonly WaypointInput[],
    destinations: readonly WaypointInput[],
    options: ManyOptions = {},
  ): MatrixResult | RouteFailure {
    const algorithm = this.algorithms.resolve(options.algorithm ?? this.defaultAlgorithm);
    const snapped = this.snapMany([...origins, ...destinations], options, algorithm.name);
    if (!Array.isArray(snapped)) return snapped;
    const from = snapped.slice(0, origins.length);
    const to = snapped.slice(origins.length);
    const ctx = this.context(algorithm, options.budget);
    const weights: number[][] = [];
    const distances: number[][] = [];
    for (const origin of from) {
      if (!origin.candidate) {
        weights.push(to.map(() => Infinity));
        distances.push(to.map(() => Infinity));
        continue;
      }
      const core = solveOneToMany(ctx, origin.candidate, to, false, 'feature');
      weights.push(core.weights);
      distances.push(core.distances);
    }
    return {
      ok: true,
      origins: from.map((p) => p.output),
      destinations: to.map((p) => p.output),
      weights,
      distances,
      algorithm: algorithm.name,
    };
  }

  private snapMany(
    points: readonly WaypointInput[],
    options: ManyOptions,
    algorithm: string,
  ): SnappedPoint[] | RouteFailure {
    const snapOptions: SnapOptions = { ...this.defaultSnap, ...options.snap };
    const routeSnap = resolveSnap(snapOptions);
    const ctx = this.context(this.algorithms.resolve(algorithm), options.budget);
    const out: SnappedPoint[] = [];
    for (let i = 0; i < points.length; i++) {
      const p = readWaypoint(points[i]);
      if (!p) {
        return {
          ok: false,
          reason: 'INVALID_INPUT',
          message: `Point #${i} is not a position, Point or Point feature.`,
          waypointIndex: i,
          algorithm,
        };
      }
      out.push(
        snapPoint(ctx, {
          input: p.position,
          snap: p.snap ? resolveSnap(snapOptions, p.snap) : routeSnap,
          context: { index: i, input: p.position, role: i === 0 ? 'origin' : 'destination' },
        }),
      );
    }
    return out;
  }

  private context(algorithm: PathAlgorithm, budget: SearchBudget | undefined): RouteContext<P> {
    const { maxCost, maxSettled } = resolveBudget(budget);
    return {
      graph: this.graph,
      query: this.query,
      scratch: this.scratch,
      algorithm,
      heuristicFor: (goals, origins) => this.heuristicFor(goals, origins),
      maxCost,
      maxSettled,
    };
  }

  /** Geometric bound, strengthened by landmarks when the finder has them. */
  private heuristicFor(goals: readonly SnapCandidate[], origins: readonly SnapCandidate[]): Heuristic | null {
    if (goals.length === 0) return null;
    const geometric = this.geometricHeuristic(goals);
    if (!this.landmarks || this.landmarks.count === 0) return geometric;
    return landmarkHeuristic(this.graph as RoutingGraph<unknown>, this.landmarks, goals, origins, geometric);
  }

  /**
   * Admissible, consistent bound to the nearest goal (virtual nodes get 0): the metric bound in the plane
   * plus, with `levels`, the cheapest cost of the levels still to be crossed. Without the level term a
   * search for a floor high above spreads over the whole start floor, because everything there looks
   * equally close in plan.
   */
  private geometricHeuristic(goals: readonly SnapCandidate[]): Heuristic | null {
    const { dims, scale, perLevel } = this.graph.heuristic;
    if (!(scale > 0) || goals.length === 0) return null;
    const N = this.graph.nodes.count;
    const emb = this.graph.nodes.embedding;
    const T = goals.length;
    const t = new Float64Array(dims * T);
    for (let i = 0; i < T; i++) {
      this.graph.metric.embed!(goals[i].point[0], goals[i].point[1], t, i * dims);
    }
    if (perLevel > 0) {
      const lo = new Float64Array(T);
      const hi = new Float64Array(T);
      let known = false;
      for (let i = 0; i < T; i++) {
        const [a, b] = goalOrdinalRange(this.graph as RoutingGraph<unknown>, goals[i].anchor);
        lo[i] = a;
        hi[i] = b;
        known ||= !Number.isNaN(a);
      }
      if (known) {
        const ordinal = this.graph.nodeOrdinals();
        return (node) => {
          if (node >= N) return 0;
          const o = ordinal[node];
          let best = Infinity;
          for (let i = 0; i < T; i++) {
            let sum = 0;
            for (let d = 0, p = node * dims, q = i * dims; d < dims; d++) {
              const diff = emb[p + d] - t[q + d];
              sum += diff * diff;
            }
            let h = scale * Math.sqrt(sum);
            // Distance from this node's storey to the goal's storey span, priced per level.
            if (!Number.isNaN(o) && !Number.isNaN(lo[i])) {
              const gap = o < lo[i] ? lo[i] - o : o > hi[i] ? o - hi[i] : 0;
              h += perLevel * gap;
            }
            if (h < best) best = h;
          }
          return best;
        };
      }
    }
    if (T === 1 && dims === 3) {
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
    if (T === 1 && dims === 2) {
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
      let best = Infinity;
      for (let i = 0; i < T; i++) {
        let sum = 0;
        for (let d = 0, o = node * dims, p = i * dims; d < dims; d++) {
          const diff = emb[o + d] - t[p + d];
          sum += diff * diff;
        }
        if (sum < best) best = sum;
      }
      return scale * Math.sqrt(best);
    };
  }
}
