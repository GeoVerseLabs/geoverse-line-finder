import { anchorStrongKey, searchCandidates, type Candidate, type CandidateInfo } from '../snap/snap';
import {
  applySnapCosts,
  candidateReports,
  planWaypoint,
  snapFailureDetail,
  snapFailureMessage,
  waypointOutput,
  type Plan,
  type PlanFailure,
  type PlanLeg,
  type PlanWaypoint,
  type PolicyOptions,
  type WaypointSpec,
} from './compose';
import { candidateAcceptor, type ResolvedSnap } from './options';
import { solvePair, type RouteContext } from './search';
import type { RouteFailureDetail, RouteFailureReason, SkippedWaypoint } from './types';

/**
 * Nearest selection: every waypoint takes its nearest allowed location (moved to a shared component with
 * `connectivity: 'connected' | 'reachable'` when needed), then consecutive waypoints are joined leg by leg.
 */
export function planNearest(
  ctx: RouteContext<unknown>,
  routeSnap: ResolvedSnap,
  specs: readonly WaypointSpec[],
  policy: PolicyOptions,
): Plan | PlanFailure {
  const { graph } = ctx;
  const n = specs.length;
  const connected = routeSnap.connectivity !== 'nearest' && n > 1 && routeSnap.mode !== 'exact';
  const strong = connected && routeSnap.connectivity === 'reachable';
  const waypoints = specs.map(planWaypoint);
  const lists: Candidate[][] = [];
  const rejected: CandidateInfo[][] = [];
  const failures: ({ detail: RouteFailureDetail; message: string } | null)[] = [];

  for (let i = 0; i < n; i++) {
    const { snap, context, input } = specs[i];
    const sink: CandidateInfo[] | undefined = policy.debug ? [] : undefined;
    const set = searchCandidates(graph, input[0], input[1], {
      mode: snap.mode,
      maxDistance: snap.maxDistance,
      limit: connected ? 16 : snap.candidates,
      searchLimit: snap.searchLimit,
      distinct: connected ? (strong ? 'strong' : 'component') : snap.distinctBy,
      accept: candidateAcceptor(graph, snap, context),
      group: snap.group,
      rejected: sink,
    });
    lists.push(set.list);
    rejected.push(sink ?? []);
    waypoints[i].considered = set.list.length;
    if (set.list.length > 0) {
      waypoints[i].nearestDistance = set.list[0].distance;
      failures.push(null);
      continue;
    }
    const detail = snapFailureDetail(set, snap.mode);
    const message = snapFailureMessage(i, detail, snap.maxDistance, snap.searchLimit);
    if (policy.policy === 'fail' || (policy.policy === 'skip' && i === 0 && !policy.leading)) {
      return { ok: false, reason: 'SNAP_FAILED', message, detail, waypointIndex: i };
    }
    failures.push({ detail, message });
  }

  // --- selection ---------------------------------------------------------------------------------
  const choice: (Candidate | null)[] = lists.map((list) => list[0] ?? null);
  const active = lists.map((list, i) => (list.length > 0 ? i : -1)).filter((i) => i >= 0);
  if (connected && active.length > 1) {
    const keys = lists.map((list) =>
      list.map((c) => (strong ? anchorStrongKey(graph, c.anchor) : c.component)),
    );
    const firstKey = keys[active[0]][0];
    if (!active.every((i) => keys[i][0] === firstKey && firstKey >= 0)) {
      let bestKey = -1;
      let bestTotal = Infinity;
      let relocationBlocked = false;
      const head = lists[active[0]];
      for (let k = 0; k < head.length; k++) {
        const key = keys[active[0]][k];
        if (key < 0) continue;
        let total = 0;
        let complete = true;
        for (const i of active) {
          const m = keys[i].indexOf(key);
          if (m < 0) {
            complete = false;
            break;
          }
          const match = lists[i][m];
          if (match.distance - lists[i][0].distance > specs[i].snap.maxRelocation) {
            complete = false;
            relocationBlocked = true;
            break;
          }
          total += match.distance;
        }
        if (complete && total < bestTotal) {
          bestTotal = total;
          bestKey = key;
        }
      }
      if (bestKey !== -1) {
        for (const i of active) choice[i] = lists[i][keys[i].indexOf(bestKey)];
      } else if (policy.policy === 'fail') {
        return relocationBlocked
          ? {
              ok: false,
              reason: 'DISCONNECTED',
              detail: 'RELOCATION_LIMIT',
              message:
                'The waypoints can only share a network component by moving some of them farther than snap.maxRelocation.',
            }
          : {
              ok: false,
              reason: 'DISCONNECTED',
              message: 'The waypoints lie on network components that are not connected to each other.',
            };
      }
    }
  }

  for (let i = 0; i < n; i++) {
    const wp: PlanWaypoint = waypoints[i];
    wp.arrive = wp.depart = choice[i];
    wp.snapped = choice[i] !== null;
    if (policy.debug) {
      wp.reports = candidateReports(lists[i], rejected[i], (c) =>
        c === choice[i] ? 'SELECTED' : 'NOT_SELECTED',
      );
    }
  }

  // --- legs --------------------------------------------------------------------------------------
  const legs: PlanLeg[] = [];
  const skipped: SkippedWaypoint[] = [];
  const skip = (
    index: number,
    reason: RouteFailureReason,
    message: string,
    detail?: RouteFailureDetail,
  ): PlanFailure | null => {
    skipped.push(detail ? { index, reason, detail, message } : { index, reason, message });
    if (skipped.length > policy.maxSkips) {
      return {
        ok: false,
        reason,
        detail,
        message: `More than skip.max = ${policy.maxSkips} waypoints could not be used. Last: ${message}`,
        waypointIndex: index,
        skipped,
      };
    }
    return null;
  };
  const straight = (from: number, to: number): PlanLeg => {
    const start = choice[from]?.point ?? specs[from].input;
    const end = choice[to]?.point ?? specs[to].input;
    const length = graph.metric.distance(start, end);
    const weight = policy.straightCost(length);
    if (!(weight >= 0 && weight < Infinity)) {
      throw new RangeError(`straightCost must return a finite number ≥ 0, got ${String(weight)}.`);
    }
    return { from, to, kind: 'straight', pieces: [], weight, settled: 0, relaxed: 0, start, end };
  };

  let anchor = -1;
  for (let j = 0; j < n; j++) {
    const failure = failures[j];
    if (anchor === -1) {
      if (failure && policy.policy === 'skip') {
        const stop = skip(j, 'SNAP_FAILED', failure.message, failure.detail);
        if (stop) return stop;
        continue;
      }
      anchor = j;
      waypoints[j].used = true;
      continue;
    }
    if (failure) {
      if (policy.policy === 'skip') {
        const stop = skip(j, 'SNAP_FAILED', failure.message, failure.detail);
        if (stop) return stop;
        continue;
      }
      legs.push(straight(anchor, j));
      waypoints[j].used = true;
      anchor = j;
      continue;
    }
    if (!choice[anchor]) {
      legs.push(straight(anchor, j));
      waypoints[j].used = true;
      anchor = j;
      continue;
    }
    const outcome = solvePair(ctx, choice[anchor]!, choice[j]!);
    if (outcome.ok) {
      legs.push({
        from: anchor,
        to: j,
        kind: 'network',
        pieces: outcome.pieces,
        weight: outcome.weight,
        settled: outcome.settled,
        relaxed: outcome.relaxed,
        start: choice[anchor]!.point,
        end: choice[j]!.point,
      });
      waypoints[j].used = true;
      anchor = j;
      continue;
    }
    const detail: RouteFailureDetail | undefined = outcome.beyondMaxCost ? 'BEYOND_MAX_COST' : undefined;
    const message =
      outcome.reason === 'BUDGET_EXCEEDED'
        ? `Search budget exhausted between waypoint #${anchor} and waypoint #${j}.`
        : `No path from waypoint #${anchor} to waypoint #${j}.`;
    if (policy.policy === 'fail') {
      return {
        ok: false,
        reason: outcome.reason,
        message,
        ...(detail ? { detail } : {}),
        legIndex: anchor,
        waypoints: waypoints.map(waypointOutput),
      };
    }
    if (policy.policy === 'skip') {
      const stop = skip(j, outcome.reason, message, detail);
      if (stop) return stop;
      continue;
    }
    legs.push(straight(anchor, j));
    waypoints[j].used = true;
    anchor = j;
  }

  if (legs.length === 0) {
    return {
      ok: false,
      reason: 'ALL_SKIPPED',
      message: 'No leg could be planned: every waypoint after the first usable one was skipped.',
      skipped,
      waypoints: waypoints.map(waypointOutput),
    };
  }
  applySnapCosts(waypoints, routeSnap.costMode);
  return { ok: true, waypoints, legs, skipped };
}
