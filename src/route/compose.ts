import type { RoutingGraph } from '../graph/graph';
import type {
  Candidate,
  CandidateInfo,
  CandidateSet,
  SnapCostMode,
  SnapMode,
  WaypointContext,
} from '../snap/snap';
import type { Position } from '../types';
import {
  assemblePieces,
  levelTransitions,
  type ChainPiece,
  type LevelKey,
  type LevelTransition,
  type SectionsDetail,
} from './assemble';
import { snapCostOf, type ResolvedSnap } from './options';
import type {
  CandidateReport,
  CandidateStatus,
  ConnectorMode,
  FailurePolicy,
  RouteFailureDetail,
  RouteFailureReason,
  RouteLeg,
  RouteSuccess,
  SkippedWaypoint,
  SnappedWaypoint,
  WaypointAccess,
} from './types';

export interface WaypointSpec {
  input: Position;
  snap: ResolvedSnap;
  context: WaypointContext;
}

export interface PolicyOptions {
  policy: FailurePolicy;
  leading: boolean;
  maxSkips: number;
  straightCost: (distance: number) => number;
  debug: boolean;
}

export interface PlanWaypoint {
  readonly input: Position;
  readonly context: WaypointContext;
  readonly snap: ResolvedSnap;
  snapped: boolean;
  used: boolean;
  arrive: Candidate | null;
  depart: Candidate | null;
  nearestDistance: number;
  considered: number;
  arriveCost: number;
  departCost: number;
  reports: CandidateReport[] | null;
}

export interface PlanLeg {
  from: number;
  to: number;
  kind: 'network' | 'straight';
  pieces: ChainPiece[];
  weight: number;
  settled: number;
  relaxed: number;
  start: Position;
  end: Position;
}

export interface Plan {
  ok: true;
  waypoints: PlanWaypoint[];
  legs: PlanLeg[];
  skipped: SkippedWaypoint[];
}

export interface PlanFailure {
  ok: false;
  reason: RouteFailureReason;
  message: string;
  detail?: RouteFailureDetail;
  waypointIndex?: number;
  legIndex?: number;
  waypoints?: SnappedWaypoint[];
  skipped?: SkippedWaypoint[];
}

export function samePoint(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export function planWaypoint(spec: WaypointSpec): PlanWaypoint {
  return {
    input: spec.input,
    context: spec.context,
    snap: spec.snap,
    snapped: false,
    used: false,
    arrive: null,
    depart: null,
    nearestDistance: NaN,
    considered: 0,
    arriveCost: 0,
    departCost: 0,
    reports: null,
  };
}

/** Why a waypoint got no candidate. */
export function snapFailureDetail(set: CandidateSet, mode: SnapMode): RouteFailureDetail {
  if (set.truncated && set.filtered > 0) return 'SCAN_LIMIT';
  if (set.filtered > 0 || set.otherGroups) return 'FILTERED';
  return mode === 'exact' ? 'NOT_A_VERTEX' : 'NONE_WITHIN';
}

export function snapFailureMessage(
  index: number,
  detail: RouteFailureDetail,
  maxDistance: number,
  searchLimit: number,
): string {
  if (detail === 'NOT_A_VERTEX') return `Waypoint #${index} is not a vertex of the network.`;
  if (detail === 'FILTERED') {
    return `Every network location near waypoint #${index} was removed by its snap constraints (featureIds, filter or group).`;
  }
  if (detail === 'SCAN_LIMIT') {
    return `The ${searchLimit} nearest locations of waypoint #${index} fail its snap constraints; raise snap.searchLimit.`;
  }
  const where = maxDistance === Infinity ? '' : ` within ${maxDistance}`;
  return `No network location found for waypoint #${index}${where}.`;
}

/** Candidate reports with statuses (debug). */
export function candidateReports(
  accepted: readonly Candidate[],
  rejected: readonly CandidateInfo[],
  status: (candidate: Candidate) => CandidateStatus,
): CandidateReport[] {
  return [
    ...accepted.map((c) => ({ ...c.info, status: status(c) })),
    ...rejected.map((info) => ({ ...info, status: 'FILTERED' as const })),
  ].sort((a, b) => a.distance - b.distance);
}

function access(candidate: Candidate, snapCost: number): WaypointAccess {
  return {
    location: candidate.point,
    distance: candidate.distance,
    featureIndex: candidate.featureIndex,
    featureId: candidate.info.featureId,
    candidateRank: candidate.info.rank,
    snapCost,
  };
}

export function waypointOutput(wp: PlanWaypoint): SnappedWaypoint {
  const c = wp.arrive ?? wp.depart;
  const out: SnappedWaypoint = {
    input: wp.input,
    location: c ? c.point : wp.input,
    distance: c ? c.distance : 0,
    component: c ? c.component : -1,
    featureIndex: c ? c.featureIndex : -1,
    featureId: c ? c.info.featureId : undefined,
    measure: c ? c.info.measure : NaN,
    snapped: wp.snapped,
    used: wp.used,
    nearestDistance: c ? wp.nearestDistance : NaN,
    relocation: c ? c.distance - wp.nearestDistance : 0,
    relocated: c ? c.info.rank > 0 : false,
    candidateRank: c ? c.info.rank : -1,
    candidatesConsidered: wp.considered,
    snapCost: wp.arriveCost + wp.departCost,
  };
  if (wp.arrive && wp.depart && wp.arrive !== wp.depart) {
    out.arrive = access(wp.arrive, wp.arriveCost);
    out.depart = access(wp.depart, wp.departCost);
  }
  if (wp.reports) out.candidates = wp.reports;
  return out;
}

/**
 * Snap costs by `costMode`: leaving the first used waypoint and reaching the last one (`'ends'`), plus
 * reaching and leaving every used via waypoint (`'arrive-depart'`).
 */
export function applySnapCosts(waypoints: readonly PlanWaypoint[], costMode: SnapCostMode): void {
  for (const w of waypoints) {
    w.arriveCost = 0;
    w.departCost = 0;
  }
  if (costMode === 'none') return;
  const used = waypoints.filter((w) => w.used);
  used.forEach((w, i) => {
    const first = i === 0;
    const last = i === used.length - 1;
    const via = !first && !last;
    if ((first || (via && costMode === 'arrive-depart')) && w.depart) {
      w.departCost = snapCostOf(w.snap, w.depart.info, w.context);
    }
    if ((last || (via && costMode === 'arrive-depart')) && w.arrive) {
      w.arriveCost = snapCostOf(w.snap, w.arrive.info, w.context);
    }
  });
}

export interface ComposeOptions {
  connectors: false | ConnectorMode;
  includeSnapWeight: boolean;
  includeConnectorDistance: boolean;
  sectionsDetail: SectionsDetail;
  /** Write level elevations into the third coordinate of the output path. */
  z: boolean;
  algorithm: string;
}

/** Turns a plan into the public result: geometry, legs, totals and per-waypoint details. */
export function composeRoute<P>(
  graph: RoutingGraph<P>,
  plan: Plan,
  options: ComposeOptions,
): RouteSuccess<P> {
  const { metric } = graph;
  const inputs = plan.waypoints.map((w) => w.input);
  const legs: RouteLeg<P>[] = [];
  const path: Position[] = [];
  let weight = 0;
  let distance = 0;
  let networkWeight = 0;
  let networkDistance = 0;
  let straightDistance = 0;
  let connectorDistance = 0;
  let complete = plan.skipped.length === 0;
  const withLevels = graph.levels !== null;
  let levelChanges = 0;
  let verticalDistance = 0;

  for (const pl of plan.legs) {
    let legPath: Position[];
    let legDistance: number;
    let sections: RouteLeg<P>['sections'];
    let legLevels: LevelKey[] | null = null;
    let transitions: LevelTransition[] | null = null;
    if (pl.kind === 'network') {
      const assembled = assemblePieces(graph, pl.pieces, options.sectionsDetail, options.z);
      legPath = assembled.path.length > 0 ? assembled.path : [pl.start];
      legDistance = assembled.distance;
      sections = assembled.sections;
      if (assembled.levels) {
        legLevels = assembled.levels.length > 0 ? assembled.levels : [graph.groupKeys[0]];
        transitions = levelTransitions(graph, sections, legLevels);
        verticalDistance += assembled.verticalDistance;
      }
    } else {
      complete = false;
      legPath = samePoint(pl.start, pl.end) ? [pl.start] : [pl.start, pl.end];
      legDistance = metric.distance(pl.start, pl.end);
      sections = [];
      // A straight bridge has no network locations, so it carries no level information.
      if (withLevels) legLevels = legPath.map(() => null);
      transitions = [];
    }
    let legConnector = 0;
    if (options.connectors === 'legs') {
      const a = inputs[pl.from];
      const b = inputs[pl.to];
      const head = legPath[0];
      const tail = legPath[legPath.length - 1];
      const withConnectors: Position[] = [];
      let shift = 0;
      if (!samePoint(a, head)) {
        withConnectors.push(a);
        legConnector += metric.distance(a, head);
        shift = 1;
      }
      withConnectors.push(...legPath);
      if (!samePoint(tail, b)) {
        withConnectors.push(b);
        legConnector += metric.distance(tail, b);
      }
      legPath = withConnectors;
      // Path indices stay usable: everything that points into the leg path moves with the connector.
      if (shift > 0) {
        for (const section of sections) {
          section.start += shift;
          section.end += shift;
        }
        if (transitions) {
          for (const transition of transitions) {
            transition.start += shift;
            transition.end += shift;
          }
        }
      }
      // A connector runs in the plane between the input point and its snapped location: same level.
      if (legLevels && legLevels.length > 0) {
        if (shift > 0) legLevels.unshift(legLevels[0]);
        while (legLevels.length < legPath.length) legLevels.push(legLevels[legLevels.length - 1]);
      }
    }
    if (transitions) for (const t of transitions) levelChanges += Math.abs(t.levelChange);
    const leg: RouteLeg<P> = {
      from: pl.from,
      to: pl.to,
      path: legPath,
      weight: pl.weight,
      distance: legDistance,
      sections,
      settled: pl.settled,
      relaxed: pl.relaxed,
      kind: pl.kind,
      connectorDistance: legConnector,
    };
    if (legLevels) leg.levels = legLevels;
    if (transitions) leg.transitions = transitions;
    legs.push(leg);
    weight += pl.weight;
    distance += legDistance;
    if (pl.kind === 'network') {
      networkWeight += pl.weight;
      networkDistance += legDistance;
    } else {
      straightDistance += legDistance;
    }
    connectorDistance += legConnector;

    if (path.length === 0) {
      for (const p of legPath) path.push(p);
      continue;
    }
    const last = path[path.length - 1];
    let j = 0;
    if (samePoint(last, legPath[0])) {
      j = 1;
    } else {
      // A pass-through waypoint left at another candidate than it was entered: go through the input point.
      const via = inputs[pl.from];
      if (!samePoint(last, via) && !samePoint(via, legPath[0])) {
        path.push(via);
        connectorDistance += metric.distance(last, via) + metric.distance(via, legPath[0]);
      }
    }
    for (; j < legPath.length; j++) path.push(legPath[j]);
  }

  if (options.connectors === 'ends' && path.length > 0) {
    const first = inputs[plan.legs[0]?.from ?? 0];
    const last = inputs[plan.legs[plan.legs.length - 1]?.to ?? inputs.length - 1];
    if (!samePoint(first, path[0])) {
      connectorDistance += metric.distance(first, path[0]);
      path.unshift(first);
    }
    if (!samePoint(last, path[path.length - 1])) {
      connectorDistance += metric.distance(path[path.length - 1], last);
      path.push(last);
    }
  }

  let snapWeight = 0;
  for (const w of plan.waypoints) snapWeight += w.arriveCost + w.departCost;
  if (options.includeSnapWeight) weight += snapWeight;
  if (options.includeConnectorDistance) distance += connectorDistance;

  const totals: Pick<RouteSuccess<P>, 'levelChanges' | 'verticalDistance'> = {};
  if (withLevels) {
    totals.levelChanges = levelChanges;
    if (graph.vertices.elevation) totals.verticalDistance = verticalDistance;
  }
  return {
    ...totals,
    ok: true,
    path,
    weight,
    distance,
    legs,
    waypoints: plan.waypoints.map(waypointOutput),
    algorithm: options.algorithm,
    networkWeight,
    snapWeight,
    networkDistance,
    connectorDistance,
    straightDistance,
    complete,
    skipped: plan.skipped,
  };
}
