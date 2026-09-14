import type { RoutingGraph } from '../graph/graph';
import type { GroupKey } from '../graph/topology';
import { isPosition } from '../graph/topology';
import type {
  CandidateCost,
  CandidateDistinct,
  CandidateFilter,
  CandidateInfo,
  SnapConnectivity,
  SnapCostMode,
  SnapMode,
  SnapOptions,
  SnapSelection,
  WaypointContext,
  WaypointSnapOptions,
} from '../snap/snap';
import type { Position } from '../types';

export interface ParsedWaypoint {
  position: Position;
  snap?: WaypointSnapOptions;
}

/** Accepts a position, a Point geometry or feature, or `{ coordinates, snap }`; `null` otherwise. */
export function readWaypoint(input: unknown): ParsedWaypoint | null {
  if (isPosition(input)) return { position: input };
  if (!input || typeof input !== 'object') return null;
  const o = input as { type?: unknown; geometry?: unknown; coordinates?: unknown; snap?: unknown };
  let position: Position | null = null;
  if (o.type === 'Feature') {
    const g = o.geometry as { type?: unknown; coordinates?: unknown } | null;
    if (g && g.type === 'Point' && isPosition(g.coordinates)) position = g.coordinates;
  } else if ((o.type === 'Point' || o.type === undefined) && isPosition(o.coordinates)) {
    position = o.coordinates;
  }
  if (!position) return null;
  return o.snap && typeof o.snap === 'object'
    ? { position, snap: o.snap as WaypointSnapOptions }
    : { position };
}

export interface ResolvedSnap {
  mode: SnapMode;
  maxDistance: number;
  connectivity: SnapConnectivity;
  searchLimit: number;
  selection: SnapSelection;
  costMode: SnapCostMode;
  candidates: number;
  distinctBy: CandidateDistinct;
  featureIds: ReadonlySet<string | number> | null;
  filter: CandidateFilter | null;
  cost: number | CandidateCost;
  maxRelocation: number;
  passThrough: boolean;
  group: GroupKey | undefined;
}

function oneOf<T extends string>(value: T | undefined, allowed: readonly T[], fallback: T, name: string): T {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) {
    throw new RangeError(
      `${name} must be one of ${allowed.map((a) => `"${a}"`).join(', ')}, got ${String(value)}.`,
    );
  }
  return value;
}

/** Merges a waypoint's own options over the route's and validates everything once. */
export function resolveSnap(base: SnapOptions, own?: WaypointSnapOptions): ResolvedSnap {
  const o: SnapOptions = own ? { ...base, ...own } : base;
  const mode = (o.mode ?? 'edge') as SnapMode;
  if (!['edge', 'vertex', 'node', 'exact'].includes(mode))
    throw new RangeError(`Unknown snap mode "${String(mode)}".`);
  const maxDistance = o.maxDistance ?? Infinity;
  if (!(maxDistance >= 0)) throw new RangeError(`snap.maxDistance must be ≥ 0, got ${String(maxDistance)}.`);
  const selection = oneOf(o.selection, ['nearest', 'optimal'], 'nearest', 'snap.selection');
  const candidates = o.candidates ?? (selection === 'optimal' ? 4 : 1);
  if (!Number.isInteger(candidates) || candidates < 1 || candidates > 16) {
    throw new RangeError(`snap.candidates must be an integer from 1 to 16, got ${String(candidates)}.`);
  }
  const maxRelocation = o.maxRelocation ?? Infinity;
  if (!(maxRelocation >= 0))
    throw new RangeError(`snap.maxRelocation must be ≥ 0, got ${String(maxRelocation)}.`);
  const cost = o.cost ?? 1;
  if (typeof cost === 'number' ? !(cost >= 0 && cost < Infinity) : typeof cost !== 'function') {
    throw new RangeError(`snap.cost must be a finite number ≥ 0 or a function, got ${String(cost)}.`);
  }
  if (o.filter !== undefined && typeof o.filter !== 'function')
    throw new TypeError('snap.filter must be a function.');
  if (o.featureIds !== undefined && !Array.isArray(o.featureIds)) {
    throw new TypeError('snap.featureIds must be an array of feature ids.');
  }
  return {
    mode,
    maxDistance,
    connectivity: oneOf(
      o.connectivity,
      ['connected', 'nearest', 'reachable'],
      'connected',
      'snap.connectivity',
    ),
    searchLimit: Math.max(1, Math.floor(o.searchLimit ?? 64)),
    selection,
    costMode: oneOf(o.costMode, ['none', 'ends', 'arrive-depart'], 'none', 'snap.costMode'),
    candidates,
    distinctBy: oneOf(o.distinctBy, ['chain', 'feature', 'component'], 'chain', 'snap.distinctBy'),
    featureIds: o.featureIds ? new Set(o.featureIds) : null,
    filter: o.filter ?? null,
    cost,
    maxRelocation,
    passThrough: o.passThrough === true,
    group: o.group,
  };
}

/** The hard constraints of a waypoint as one predicate, or `null` when it has none. */
export function candidateAcceptor(
  graph: RoutingGraph<unknown>,
  snap: ResolvedSnap,
  context: WaypointContext,
): ((info: CandidateInfo) => boolean) | null {
  const { featureIds, filter, group } = snap;
  if (!featureIds && !filter && group === undefined) return null;
  const allowed = (f: number): boolean => {
    const feature = graph.features[f];
    if (!feature) return false;
    if (feature.id !== undefined && featureIds!.has(feature.id)) return true;
    const props = feature.properties as { id?: unknown } | null | undefined;
    const id = props && typeof props === 'object' ? props.id : undefined;
    return (typeof id === 'string' || typeof id === 'number') && featureIds!.has(id);
  };
  return (info) =>
    (group === undefined || info.group === group) &&
    (!featureIds || info.featureIndices.some(allowed)) &&
    (!filter || filter(info, context) === true);
}

/** Evaluates a waypoint's snap cost for a candidate. */
export function snapCostOf(snap: ResolvedSnap, info: CandidateInfo, context: WaypointContext): number {
  const value = typeof snap.cost === 'number' ? info.distance * snap.cost : snap.cost(info, context);
  if (!(value >= 0 && value < Infinity)) {
    throw new RangeError(
      `snap.cost must return a finite number ≥ 0, got ${String(value)} for waypoint #${context.index}.`,
    );
  }
  return value;
}
