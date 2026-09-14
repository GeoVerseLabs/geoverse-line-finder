import type { NetworkFeature, Position } from '../types';

export interface WeightContext<P = unknown> {
  /** Length of the segment measured with the finder's metric (meters for geographic metrics). */
  readonly distance: number;
  readonly featureIndex: number;
  readonly feature: NetworkFeature<P>;
}

/** Per-direction costs. A missing or falsy direction is impassable. */
export interface DirectionalWeight {
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
export type WeightResult = number | DirectionalWeight | null | undefined | false;

/**
 * Cost of travelling one network segment from `a` to `b`. Signature-compatible with
 * geojson-path-finder's `weight(a, b, properties)`; the extra `context` exposes the pre-computed
 * segment length so time-based weights need not re-measure it.
 */
export type WeightFunction<P = unknown> = (
  a: Position,
  b: Position,
  properties: P,
  context: WeightContext<P>,
) => WeightResult;

export type TravelDirection = 'both' | 'forward' | 'backward' | 'none';

/** Mutable output of {@link normalizeWeight}. `Infinity` marks an impassable direction. */
export interface NormalizedWeight {
  forward: number;
  backward: number;
}

/**
 * What a weight of `0` means: `'impassable'` (default, the geojson-path-finder contract) or `'free'` — a
 * zero-cost passage such as a connector between levels.
 */
export type ZeroWeight = 'impassable' | 'free';

function toCost(value: unknown, where: string, zeroIsFree: boolean): number {
  if (typeof value === 'number') {
    if (value > 0 && value < Infinity) return value;
    if (value < 0) throw new RangeError(`Negative weight ${value} returned for ${where}.`);
    if (value === 0 && zeroIsFree) return 0;
    return Infinity; // 0 (by default), NaN and +Infinity all mean "cannot pass"
  }
  if (value === null || value === undefined || value === false) return Infinity;
  throw new TypeError(`Unsupported weight value ${JSON.stringify(value)} returned for ${where}.`);
}

export function normalizeWeight(
  value: WeightResult,
  out: NormalizedWeight,
  where: string,
  zeroIsFree = false,
): void {
  if (typeof value === 'object' && value !== null) {
    out.forward = toCost(value.forward, where, zeroIsFree);
    out.backward = toCost(value.backward, where, zeroIsFree);
  } else {
    const cost = toCost(value, where, zeroIsFree);
    out.forward = cost;
    out.backward = cost;
  }
}

/** Default weight: the metric length of the segment (the shortest path). */
export const distanceWeight: WeightFunction = (_a, _b, _properties, context) => context.distance;

/** Wraps a cost with a travel-direction restriction. */
export function directional(cost: number, direction: TravelDirection): WeightResult {
  switch (direction) {
    case 'both':
      return cost;
    case 'forward':
      return { forward: cost };
    case 'backward':
      return { backward: cost };
    default:
      return null;
  }
}

export interface PropertyWeightOptions<P> {
  /** Multiplier on the segment length. Falsy/NaN makes the segment impassable. Defaults to `1`. */
  factor?: (properties: P) => number | null | undefined;
  /** Direction restriction derived from the properties. Defaults to `'both'`. */
  direction?: (properties: P) => TravelDirection;
}

/** Declarative weight: `length × factor(properties)`, optionally one-way. */
export function createPropertyWeight<P>(options: PropertyWeightOptions<P> = {}): WeightFunction<P> {
  const { factor, direction } = options;
  return (_a, _b, properties, context) => {
    const f = factor ? factor(properties) : 1;
    if (typeof f !== 'number') return null;
    return directional(context.distance * f, direction ? direction(properties) : 'both');
  };
}

export interface SpeedWeightOptions<P> {
  /** Travel speed in km/h. Falsy/NaN makes the segment impassable. */
  speed: (properties: P) => number | null | undefined;
  direction?: (properties: P) => TravelDirection;
}

/** Travel time in seconds (assumes a metric in meters): `length / (speed / 3.6)`. */
export function createSpeedWeight<P>(options: SpeedWeightOptions<P>): WeightFunction<P> {
  const { speed, direction } = options;
  return (_a, _b, properties, context) => {
    const kmh = speed(properties);
    if (typeof kmh !== 'number' || !(kmh > 0)) return null;
    return directional(context.distance / (kmh / 3.6), direction ? direction(properties) : 'both');
  };
}

/**
 * OpenStreetMap one-way semantics: `oneway=yes|true|1` → forward, `oneway=-1|reverse` → backward,
 * `junction=roundabout|circular` → forward unless `oneway=no`.
 */
export function osmDirection(properties: unknown): TravelDirection {
  if (properties === null || typeof properties !== 'object') return 'both';
  const p = properties as Record<string, unknown>;
  const oneway = p.oneway;
  if (oneway === '-1' || oneway === 'reverse' || oneway === -1) return 'backward';
  if (oneway === 'yes' || oneway === 'true' || oneway === '1' || oneway === true || oneway === 1)
    return 'forward';
  if (oneway === 'no' || oneway === 'false' || oneway === '0' || oneway === false) return 'both';
  if (p.junction === 'roundabout' || p.junction === 'circular') return 'forward';
  return 'both';
}
