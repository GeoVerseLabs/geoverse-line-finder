import type { PathAlgorithm } from '../algorithm/types';
import type { CandidateInfo, SnapMode, SnapOptions } from '../snap/snap';
import type { Position } from '../types';
import type { LevelKey, LevelTransition, RouteSection, SectionsDetail } from './assemble';

/** What to do with a waypoint that cannot be snapped or reached. */
export type FailurePolicy = 'fail' | 'skip' | 'straight';
/** Straight connectors from the raw inputs: at the route's two ends, or around every leg. */
export type ConnectorMode = 'ends' | 'legs';

/** Limits for each search a query runs. */
export interface SearchBudget {
  /** A leg costlier than this counts as unreachable (`detail: 'BEYOND_MAX_COST'`). */
  maxCost?: number;
  /** Give up after settling this many nodes in one search (`reason: 'BUDGET_EXCEEDED'`). */
  maxSettled?: number;
}

export interface RouteOptions {
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
  /** Shape of the output geometry. */
  output?: {
    /**
     * `'elevation'`: write the level height into the third coordinate of every path position (copies
     * them instead of reusing the network's). Needs `levels` with elevations. Default: off.
     */
    z?: 'elevation';
  };
  debug?: {
    /** Report every candidate of every waypoint with the reason it was or was not used. */
    candidates?: boolean;
  };
}

export type CandidateStatus = 'SELECTED' | 'FILTERED' | 'RELOCATION' | 'UNREACHABLE' | 'NOT_SELECTED';

export interface CandidateReport extends CandidateInfo {
  readonly status: CandidateStatus;
}

/** The candidate a pass-through waypoint was entered or left by. */
export interface WaypointAccess {
  location: Position;
  distance: number;
  featureIndex: number;
  featureId: string | number | undefined;
  candidateRank: number;
  snapCost: number;
}

export interface SnappedWaypoint {
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

export interface RouteLeg<P = unknown> {
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
  /** With `levels`: the level of every coordinate of `path` (`null` inside a connector). */
  levels?: LevelKey[];
  /** With `levels`: the passages between levels along this leg. */
  transitions?: LevelTransition[];
}

export interface SkippedWaypoint {
  index: number;
  reason: RouteFailureReason;
  detail?: RouteFailureDetail;
  message: string;
}

export interface RouteSuccess<P = unknown> {
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
  /** With `levels`: the number of levels crossed, summed over every passage. */
  levelChanges?: number;
  /** With level elevations: the height climbed and descended along the route. */
  verticalDistance?: number;
}

export type RouteFailureReason =
  'INVALID_INPUT' | 'SNAP_FAILED' | 'DISCONNECTED' | 'UNREACHABLE' | 'ALL_SKIPPED' | 'BUDGET_EXCEEDED';

export type RouteFailureDetail =
  /** Nothing within `snap.maxDistance`. */
  | 'NONE_WITHIN'
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

export interface RouteFailure {
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

export type RouteResult<P = unknown> = RouteSuccess<P> | RouteFailure;

export interface NearestResult {
  location: Position;
  distance: number;
  component: number;
  featureIndex: number;
}

export interface ManyOptions {
  algorithm?: string | PathAlgorithm;
  /** Nearest selection is used; `connectivity`, `selection` and cost options do not apply. */
  snap?: SnapOptions;
  budget?: SearchBudget;
  /** Also return each route as a leg (geometry and sections). Default `false`. */
  paths?: boolean;
  sectionsDetail?: SectionsDetail;
}

export interface ManyResult<P = unknown> {
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

export interface MatrixResult {
  ok: true;
  origins: (SnappedWaypoint | null)[];
  destinations: (SnappedWaypoint | null)[];
  /** `weights[i][j]`: origin `i` to destination `j`; `Infinity` when unreachable or unsnapped. */
  weights: number[][];
  distances: number[][];
  algorithm: string;
}

export interface CandidateOptions extends SnapOptions {
  /** Role passed to `filter` / `cost`. Default `'origin'`. */
  role?: 'origin' | 'via' | 'destination';
}

export type { SnapMode };
