import { searchCandidates, type Candidate, type CandidateInfo } from '../snap/snap';
import type { Position } from '../types';
import { partialCost, type ChainPiece } from './assemble';
import {
  applySnapCosts,
  candidateReports,
  planWaypoint,
  snapFailureMessage,
  waypointOutput,
  type Plan,
  type PlanFailure,
  type PlanLeg,
  type PolicyOptions,
  type WaypointSpec,
} from './compose';
import { candidateAcceptor, snapCostOf, type ResolvedSnap } from './options';
import { linkFrom, linkTo, pathPieces, runSearch, type RouteContext } from './search';
import type { CandidateStatus, RouteFailureDetail, RouteFailureReason, SkippedWaypoint } from './types';

/** One option of a layer: a network candidate, or the raw input of an unsnappable waypoint (`cand: null`). */
interface Option {
  cand: Candidate | null;
  point: Position;
  /** Snap cost of this candidate (0 with `costMode: 'none'`). */
  raw: number;
}

interface LegChoice {
  kind: 'network' | 'straight';
  pieces: ChainPiece[];
  weight: number;
  /** Departure option index in the previous layer. */
  from: number;
}

interface Layer {
  wp: number;
  options: Option[];
  /** Best total cost to reach each option (arrival), without its own snap costs. */
  net: Float64Array;
  /** Best total cost to leave each option (departure). */
  depart: Float64Array;
  /** Arrival option → departure option of the previous layer. */
  prevArr: Int32Array;
  /** Departure option → arrival option of this layer. */
  prevDep: Int32Array;
  legs: (LegChoice | null)[];
  settled: number;
  relaxed: number;
  budget: boolean;
}

/**
 * Optimal selection: a layered dynamic programme over the waypoints' candidates. Each layer transition is one
 * multi-source, multi-target search (a virtual super-source seeded with the best cost of leaving each
 * candidate of the previous layer), so a via waypoint is entered and left at the same candidate unless it
 * passes through, and the chosen combination minimises network weight plus the snap costs of `costMode`.
 */
export function planOptimal(
  ctx: RouteContext<unknown>,
  routeSnap: ResolvedSnap,
  specs: readonly WaypointSpec[],
  policy: PolicyOptions,
): Plan | PlanFailure {
  const { graph } = ctx;
  const n = specs.length;
  const costMode = routeSnap.costMode;
  const waypoints = specs.map(planWaypoint);
  const optionsOf: Option[][] = [];
  const accepted: Candidate[][] = [];
  const rejected: CandidateInfo[][] = [];
  const failures: ({ detail: RouteFailureDetail; message: string } | null)[] = [];

  for (let i = 0; i < n; i++) {
    const { snap, context, input } = specs[i];
    const sink: CandidateInfo[] | undefined = policy.debug ? [] : undefined;
    const set = searchCandidates(graph, input[0], input[1], {
      mode: snap.mode,
      maxDistance: snap.maxDistance,
      limit: snap.candidates,
      searchLimit: snap.searchLimit,
      distinct: snap.distinctBy,
      accept: candidateAcceptor(graph, snap, context),
      group: snap.group,
      rejected: sink,
    });
    accepted.push(set.list);
    rejected.push(sink ?? []);
    const nearest = set.list.length > 0 ? set.list[0].distance : NaN;
    const kept = set.list.filter((c) => c.distance - nearest <= snap.maxRelocation);
    waypoints[i].nearestDistance = nearest;
    waypoints[i].considered = kept.length;
    optionsOf.push(
      kept.map((cand) => ({
        cand,
        point: cand.point,
        raw: costMode === 'none' ? 0 : snapCostOf(snap, cand.info, context),
      })),
    );
    if (kept.length > 0) {
      failures.push(null);
      continue;
    }
    const detail: RouteFailureDetail =
      set.filtered > 0 ? 'FILTERED' : snap.mode === 'exact' ? 'NOT_A_VERTEX' : 'NONE_WITHIN';
    const message = snapFailureMessage(i, detail, snap.maxDistance);
    if (policy.policy === 'fail' || (policy.policy === 'skip' && i === 0 && !policy.leading)) {
      return { ok: false, reason: 'SNAP_FAILED', message, detail, waypointIndex: i };
    }
    failures.push({ detail, message });
  }

  const viaArrive = (o: Option) => (costMode === 'arrive-depart' ? o.raw : 0);
  const viaDepart = viaArrive;
  const endCost = (o: Option) => (costMode === 'none' ? 0 : o.raw);

  const layers: Layer[] = [];
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

  let prev: Layer | null = null;
  for (let j = 0; j < n; j++) {
    let options = optionsOf[j];
    const failure = failures[j];
    if (failure) {
      if (policy.policy === 'skip') {
        const stop = skip(j, 'SNAP_FAILED', failure.message, failure.detail);
        if (stop) return stop;
        continue;
      }
      options = [{ cand: null, point: specs[j].input, raw: 0 }];
    }
    if (!prev) {
      const m = options.length;
      const layer: Layer = {
        wp: j,
        options,
        net: new Float64Array(m),
        depart: Float64Array.from(options, endCost),
        prevArr: new Int32Array(m).fill(-1),
        prevDep: Int32Array.from(options, (_o, d) => d),
        legs: options.map(() => null),
        settled: 0,
        relaxed: 0,
        budget: false,
      };
      layers.push(layer);
      prev = layer;
      continue;
    }

    const layer = transition(ctx, prev, j, options, policy);
    if (!layer.net.some((v) => v < Infinity)) {
      const reason: RouteFailureReason = layer.budget ? 'BUDGET_EXCEEDED' : 'UNREACHABLE';
      const detail: RouteFailureDetail | undefined =
        !layer.budget && ctx.maxCost < Infinity ? 'BEYOND_MAX_COST' : undefined;
      const message =
        reason === 'BUDGET_EXCEEDED'
          ? `Search budget exhausted between waypoint #${prev.wp} and waypoint #${j}.`
          : `No path from waypoint #${prev.wp} to waypoint #${j}.`;
      if (policy.policy === 'fail') {
        for (let i = 0; i < n; i++) {
          waypoints[i].arrive = waypoints[i].depart = optionsOf[i][0]?.cand ?? null;
          waypoints[i].snapped = waypoints[i].arrive !== null;
        }
        return {
          ok: false,
          reason,
          message,
          ...(detail ? { detail } : {}),
          legIndex: prev.wp,
          waypoints: waypoints.map(waypointOutput),
        };
      }
      const stop = skip(j, reason, message, detail);
      if (stop) return stop;
      continue;
    }

    const m = options.length;
    if (specs[j].snap.passThrough) {
      let best = -1;
      let bestCost = Infinity;
      for (let d = 0; d < m; d++) {
        const arrive = layer.net[d] + viaArrive(options[d]);
        if (arrive < bestCost) {
          bestCost = arrive;
          best = d;
        }
      }
      for (let e = 0; e < m; e++) {
        layer.depart[e] = bestCost + viaDepart(options[e]);
        layer.prevDep[e] = best;
      }
    } else {
      for (let d = 0; d < m; d++) {
        layer.depart[d] = layer.net[d] + viaArrive(options[d]) + viaDepart(options[d]);
        layer.prevDep[d] = d;
      }
    }
    layers.push(layer);
    prev = layer;
  }

  if (layers.length < 2) {
    for (let i = 0; i < n; i++) {
      waypoints[i].arrive = waypoints[i].depart = optionsOf[i][0]?.cand ?? null;
      waypoints[i].snapped = waypoints[i].arrive !== null;
    }
    return {
      ok: false,
      reason: 'ALL_SKIPPED',
      message: 'No leg could be planned: every waypoint after the first usable one was skipped.',
      skipped,
      waypoints: waypoints.map(waypointOutput),
    };
  }

  // --- choose and backtrack ------------------------------------------------------------------------
  const L = layers.length;
  const last = layers[L - 1];
  let best = -1;
  let bestScore = Infinity;
  for (let d = 0; d < last.options.length; d++) {
    const score = last.net[d] + endCost(last.options[d]);
    if (score < bestScore) {
      bestScore = score;
      best = d;
    }
  }
  const arrival = new Int32Array(L);
  const departure = new Int32Array(L);
  arrival[L - 1] = best;
  departure[L - 1] = best;
  for (let l = L - 1; l > 0; l--) {
    const e = layers[l].prevArr[arrival[l]];
    departure[l - 1] = e;
    arrival[l - 1] = l - 1 === 0 ? e : layers[l - 1].prevDep[e];
  }

  for (let i = 0; i < n; i++) {
    const nearestCand = optionsOf[i][0]?.cand ?? null;
    waypoints[i].arrive = waypoints[i].depart = nearestCand;
    waypoints[i].snapped = nearestCand !== null;
  }
  const legs: PlanLeg[] = [];
  const chosen = new Map<number, Set<Candidate>>();
  const unreachable = new Map<number, Set<Candidate>>();
  for (let l = 0; l < L; l++) {
    const layer = layers[l];
    const wp = waypoints[layer.wp];
    wp.used = true;
    wp.arrive = layer.options[arrival[l]].cand;
    wp.depart = layer.options[departure[l]].cand;
    wp.snapped = wp.arrive !== null;
    chosen.set(layer.wp, new Set([wp.arrive, wp.depart].filter((c): c is Candidate => c !== null)));
    if (l > 0) {
      unreachable.set(
        layer.wp,
        new Set(layer.options.filter((o, d) => o.cand && layer.net[d] === Infinity).map((o) => o.cand!)),
      );
      const leg = layer.legs[arrival[l]]!;
      const before = layers[l - 1];
      legs.push({
        from: before.wp,
        to: layer.wp,
        kind: leg.kind,
        pieces: leg.pieces,
        weight: leg.weight,
        settled: layer.settled,
        relaxed: layer.relaxed,
        start: before.options[departure[l - 1]].point,
        end: layer.options[arrival[l]].point,
      });
    }
  }

  if (policy.debug) {
    for (let i = 0; i < n; i++) {
      const kept = new Set(optionsOf[i].map((o) => o.cand));
      waypoints[i].reports = candidateReports(accepted[i], rejected[i], (c): CandidateStatus => {
        if (chosen.get(i)?.has(c)) return 'SELECTED';
        if (!kept.has(c)) return 'RELOCATION';
        if (unreachable.get(i)?.has(c)) return 'UNREACHABLE';
        return 'NOT_SELECTED';
      });
    }
  }

  applySnapCosts(waypoints, costMode);
  return { ok: true, waypoints, legs, skipped };
}

/** Best arrival cost at every option of waypoint `j` from the departure costs of `prev`. */
function transition(
  ctx: RouteContext<unknown>,
  prev: Layer,
  j: number,
  options: Option[],
  policy: PolicyOptions,
): Layer {
  const m = options.length;
  const layer: Layer = {
    wp: j,
    options,
    net: new Float64Array(m).fill(Infinity),
    depart: new Float64Array(m).fill(Infinity),
    prevArr: new Int32Array(m).fill(-1),
    prevDep: new Int32Array(m).fill(-1),
    legs: options.map(() => null),
    settled: 0,
    relaxed: 0,
    budget: false,
  };
  const pseudo = prev.options.some((o) => !o.cand) || options.some((o) => !o.cand);
  if (!pseudo) networkTransition(ctx, prev, layer);
  if (policy.policy === 'straight' && (pseudo || !layer.net.some((v) => v < Infinity))) {
    for (let d = 0; d < m; d++) {
      for (let c = 0; c < prev.options.length; c++) {
        const base = prev.depart[c];
        if (!(base < Infinity)) continue;
        const length = ctx.graph.metric.distance(prev.options[c].point, options[d].point);
        const weight = policy.straightCost(length);
        if (!(weight >= 0 && weight < Infinity)) {
          throw new RangeError(`straightCost must return a finite number ≥ 0, got ${String(weight)}.`);
        }
        if (base + weight < layer.net[d]) {
          layer.net[d] = base + weight;
          layer.prevArr[d] = c;
          layer.legs[d] = { kind: 'straight', pieces: [], weight, from: c };
        }
      }
    }
  }
  return layer;
}

function networkTransition(ctx: RouteContext<unknown>, prev: Layer, layer: Layer): void {
  const { graph, query: q } = ctx;
  const components = new Set<number>();
  for (let c = 0; c < prev.options.length; c++) {
    if (prev.depart[c] < Infinity) components.add(prev.options[c].cand!.component);
  }
  if (!layer.options.some((o) => components.has(o.cand!.component))) return;

  q.reset();
  const source = q.virtualSource;
  const seedOf = new Map<number, number>();
  const sourceVirtual = new Int32Array(prev.options.length).fill(-1);
  const origins: Candidate[] = [];
  let maxDepart = 0;
  for (let c = 0; c < prev.options.length; c++) {
    const cost = prev.depart[c];
    if (!(cost < Infinity)) continue;
    maxDepart = Math.max(maxDepart, cost);
    origins.push(prev.options[c].cand!);
    const anchor = prev.options[c].cand!.anchor;
    let k: number;
    if (anchor.kind === 'node') {
      k = q.add(source, anchor.node, -1, 0, 0, cost);
    } else {
      const v = q.addVirtual();
      sourceVirtual[c] = v;
      k = q.add(source, v, -1, 0, 0, cost);
      linkFrom(ctx, v, anchor.chain, anchor.position);
    }
    seedOf.set(k, c);
  }

  const targetNode = new Int32Array(layer.options.length).fill(-1);
  const targets: number[] = [];
  const goals: Candidate[] = [];
  for (let d = 0; d < layer.options.length; d++) {
    const anchor = layer.options[d].cand!.anchor;
    if (anchor.kind === 'node') {
      targetNode[d] = anchor.node;
    } else {
      const v = q.addVirtual();
      linkTo(ctx, v, anchor.chain, anchor.position);
      for (let c = 0; c < prev.options.length; c++) {
        const from = prev.options[c].cand!.anchor;
        if (sourceVirtual[c] >= 0 && from.kind === 'chain' && from.chain === anchor.chain) {
          q.add(
            sourceVirtual[c],
            v,
            anchor.chain,
            from.position,
            anchor.position,
            partialCost(graph, anchor.chain, from.position, anchor.position),
          );
        }
      }
      targetNode[d] = v;
    }
    if (!targets.includes(targetNode[d])) targets.push(targetNode[d]);
    goals.push(layer.options[d].cand!);
  }

  const maxCost = ctx.maxCost < Infinity ? maxDepart + ctx.maxCost : Infinity;
  const result = runSearch(ctx, source, -1, targets, goals, maxCost, origins);
  layer.settled = result.settled;
  layer.relaxed = result.relaxed;
  layer.budget = result.budgetExceeded === true;
  for (let d = 0; d < layer.options.length; d++) {
    const path = result.targetPaths?.[targets.indexOf(targetNode[d])];
    if (!path || path.edges.length === 0) continue;
    const c = seedOf.get(path.edges[0] - q.baseEdgeCount);
    if (c === undefined) continue;
    const { pieces, weight } = pathPieces(ctx, path.edges, 1);
    if (weight > ctx.maxCost) continue;
    layer.net[d] = path.cost;
    layer.prevArr[d] = c;
    layer.legs[d] = { kind: 'network', pieces, weight, from: c };
  }
}
