import { sameAnchor, searchCandidates, type Candidate } from '../snap/snap';
import {
  assemblePieces,
  partialCost,
  piecesDistance,
  type ChainPiece,
  type SectionsDetail,
} from './assemble';
import { planWaypoint, waypointOutput, type WaypointSpec } from './compose';
import { candidateAcceptor } from './options';
import { linkFrom, linkTo, pathPieces, runSearch, type RouteContext } from './search';
import type { RouteLeg, SnappedWaypoint } from './types';

/** Above this many targets the A* bound to the nearest target costs more than it saves. */
const HEURISTIC_TARGETS = 16;

export interface SnappedPoint {
  spec: WaypointSpec;
  candidate: Candidate | null;
  output: SnappedWaypoint | null;
}

/** Nearest allowed location of a point, with its public description. */
export function snapPoint(ctx: RouteContext<unknown>, spec: WaypointSpec): SnappedPoint {
  const { snap, context, input } = spec;
  const set = searchCandidates(ctx.graph, input[0], input[1], {
    mode: snap.mode,
    maxDistance: snap.maxDistance,
    limit: 1,
    searchLimit: snap.searchLimit,
    distinct: 'chain',
    accept: candidateAcceptor(ctx.graph, snap, context),
    group: snap.group,
  });
  const candidate = set.list[0] ?? null;
  if (!candidate) return { spec, candidate, output: null };
  const wp = planWaypoint(spec);
  wp.arrive = wp.depart = candidate;
  wp.snapped = wp.used = true;
  wp.nearestDistance = candidate.distance;
  wp.considered = 1;
  return { spec, candidate, output: waypointOutput(wp) };
}

export interface ManyCore<P> {
  weights: number[];
  distances: number[];
  legs: (RouteLeg<P> | null)[] | null;
  settled: number;
  relaxed: number;
}

/** Costs from one snapped source to many snapped targets with a single search tree. */
export function solveOneToMany<P>(
  ctx: RouteContext<P>,
  source: Candidate,
  targets: readonly SnappedPoint[],
  paths: boolean,
  detail: SectionsDetail,
): ManyCore<P> {
  const { graph, query: q } = ctx;
  const count = targets.length;
  const weights = new Array<number>(count).fill(Infinity);
  const distances = new Array<number>(count).fill(Infinity);
  const legs: (RouteLeg<P> | null)[] | null = paths ? new Array(count).fill(null) : null;
  const piecesOf: (ChainPiece[] | null)[] = new Array(count).fill(null);

  q.reset();
  let sourceNode: number;
  if (source.anchor.kind === 'node') {
    sourceNode = source.anchor.node;
  } else {
    sourceNode = q.virtualSource;
    linkFrom(ctx, sourceNode, source.anchor.chain, source.anchor.position);
  }
  const targetNode = new Int32Array(count).fill(-1);
  const unique: number[] = [];
  const goals: Candidate[] = [];
  for (let t = 0; t < count; t++) {
    const candidate = targets[t].candidate;
    if (!candidate || candidate.component !== source.component) continue;
    if (sameAnchor(source.anchor, candidate.anchor)) {
      weights[t] = 0;
      piecesOf[t] = [];
      continue;
    }
    const anchor = candidate.anchor;
    if (anchor.kind === 'node') {
      targetNode[t] = anchor.node;
    } else {
      const v = q.addVirtual();
      linkTo(ctx, v, anchor.chain, anchor.position);
      if (source.anchor.kind === 'chain' && source.anchor.chain === anchor.chain) {
        const from = source.anchor.position;
        q.add(
          sourceNode,
          v,
          anchor.chain,
          from,
          anchor.position,
          partialCost(graph, anchor.chain, from, anchor.position),
        );
      }
      targetNode[t] = v;
    }
    if (!unique.includes(targetNode[t])) unique.push(targetNode[t]);
    goals.push(candidate);
  }

  let settled = 0;
  let relaxed = 0;
  if (unique.length > 0) {
    const bounded = unique.length <= HEURISTIC_TARGETS ? goals : [];
    const result = runSearch(ctx, sourceNode, -1, unique, bounded, ctx.maxCost, [source]);
    settled = result.settled;
    relaxed = result.relaxed;
    for (let t = 0; t < count; t++) {
      if (targetNode[t] < 0) continue;
      const path = result.targetPaths?.[unique.indexOf(targetNode[t])];
      if (!path || path.cost > ctx.maxCost) continue;
      weights[t] = path.cost;
      piecesOf[t] = pathPieces(ctx, path.edges, 0).pieces;
    }
  }

  for (let t = 0; t < count; t++) {
    const pieces = piecesOf[t];
    if (!pieces) continue;
    distances[t] = piecesDistance(graph, pieces);
    if (legs) {
      const assembled = assemblePieces(graph, pieces, detail);
      legs[t] = {
        from: 0,
        to: t,
        path: assembled.path.length > 0 ? assembled.path : [source.point],
        weight: weights[t],
        distance: assembled.distance,
        sections: assembled.sections,
        settled,
        relaxed,
        kind: 'network',
        connectorDistance: 0,
      };
    }
  }
  return { weights, distances, legs, settled, relaxed };
}
