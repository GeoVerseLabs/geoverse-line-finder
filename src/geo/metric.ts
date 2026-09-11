import type { Position } from '../types';

/** Mean Earth radius (IUGG), identical to the one used by turf. */
export const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;
/** Meters per degree of latitude on the sphere of radius {@link EARTH_RADIUS_M}. */
export const METERS_PER_DEGREE = EARTH_RADIUS_M * RAD;

/**
 * A distance measure for the network.
 *
 * `distance` gives edge lengths and snap distances. `embed`, when present, maps a coordinate into R^k
 * such that the Euclidean distance between two embeddings **never exceeds** `distance` between the
 * coordinates. That lower bound is what makes the A* heuristic admissible, so a metric without an
 * embedding simply disables the heuristic (A* then behaves like Dijkstra).
 */
export interface Metric {
  readonly name: string;
  /** `true` → coordinates are `[lng, lat]` degrees and distances are meters. */
  readonly geographic: boolean;
  distance(a: Position, b: Position): number;
  /** Dimension written by `embed`; `0` when the metric offers no admissible embedding. */
  readonly embedDims: number;
  embed?(x: number, y: number, out: Float64Array, offset: number): void;
}

export type MetricOption = 'haversine' | 'cheap-ruler' | 'euclidean' | Metric;

/** Great-circle distance in meters. */
export function haversineDistance(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const p1 = lat1 * RAD;
  const p2 = lat2 * RAD;
  const s1 = Math.sin((p2 - p1) / 2);
  const s2 = Math.sin(((lng2 - lng1) * RAD) / 2);
  const h = s1 * s1 + Math.cos(p1) * Math.cos(p2) * s2 * s2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Haversine metric. Its embedding is the 3D point on the sphere: the chord `2R·√h` is never longer
 * than the arc `2R·asin(√h)`, so the heuristic is admissible and consistent, and costs no trigonometry
 * per evaluation.
 */
export const haversineMetric: Metric = {
  name: 'haversine',
  geographic: true,
  embedDims: 3,
  distance(a, b) {
    return haversineDistance(a[0], a[1], b[0], b[1]);
  },
  embed(x, y, out, offset) {
    const lat = y * RAD;
    const lng = x * RAD;
    const c = Math.cos(lat);
    out[offset] = EARTH_RADIUS_M * c * Math.cos(lng);
    out[offset + 1] = EARTH_RADIUS_M * c * Math.sin(lng);
    out[offset + 2] = EARTH_RADIUS_M * Math.sin(lat);
  },
};

/**
 * Mapbox cheap-ruler approximation around a reference latitude (meters). Accurate for city-scale
 * networks and noticeably cheaper than haversine. The embedding ignores antimeridian wrapping, so do
 * not use it for networks that cross ±180°.
 */
export function cheapRulerMetric(referenceLat: number): Metric {
  const RE = 6378137; // equatorial radius, meters
  const FE = 1 / 298.257223563;
  const E2 = FE * (2 - FE);
  const cosLat = Math.cos(referenceLat * RAD);
  const w2 = 1 / (1 - E2 * (1 - cosLat * cosLat));
  const w = Math.sqrt(w2);
  const m = RAD * RE;
  const kx = m * w * cosLat;
  const ky = m * w * w2 * (1 - E2);
  return {
    name: 'cheap-ruler',
    geographic: true,
    embedDims: 2,
    distance(a, b) {
      let dLng = a[0] - b[0];
      while (dLng < -180) dLng += 360;
      while (dLng > 180) dLng -= 360;
      const dx = dLng * kx;
      const dy = (a[1] - b[1]) * ky;
      return Math.sqrt(dx * dx + dy * dy);
    },
    embed(x, y, out, offset) {
      out[offset] = x * kx;
      out[offset + 1] = y * ky;
    },
  };
}

/** Plain planar distance, for projected coordinates (meters, feet, pixels…). */
export const euclideanMetric: Metric = {
  name: 'euclidean',
  geographic: false,
  embedDims: 2,
  distance(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
  },
  embed(x, y, out, offset) {
    out[offset] = x;
    out[offset + 1] = y;
  },
};

export function resolveMetric(option: MetricOption | undefined, referenceLat: number): Metric {
  if (option === undefined || option === 'haversine') return haversineMetric;
  if (option === 'cheap-ruler') return cheapRulerMetric(referenceLat);
  if (option === 'euclidean') return euclideanMetric;
  if (typeof option === 'object' && typeof option.distance === 'function') {
    const embedDims = typeof option.embed === 'function' ? option.embedDims | 0 : 0;
    return embedDims === option.embedDims ? option : { ...option, embedDims };
  }
  throw new TypeError(`Unknown metric: ${String(option)}`);
}

/**
 * Scale factors that turn coordinate deltas into approximate metric units near latitude `lat`
 * (a local equirectangular plane). Used for snapping and tolerance checks, where only relative
 * ordering and short distances matter.
 */
export function localScale(metric: Metric, lat: number): { sx: number; sy: number } {
  if (!metric.geographic) return { sx: 1, sy: 1 };
  return { sx: METERS_PER_DEGREE * Math.max(Math.cos(lat * RAD), 1e-6), sy: METERS_PER_DEGREE };
}
