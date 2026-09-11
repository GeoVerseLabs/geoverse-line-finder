import type { LineStringFeature } from '../types';
import type { RouteResult } from './finder';

export interface RouteSummary {
  weight: number;
  distance: number;
  algorithm: string;
  legs: { weight: number; distance: number }[];
}

/** Converts a successful route to a GeoJSON LineString feature; `null` for failures. */
export function toLineString<P>(result: RouteResult<P>): LineStringFeature<RouteSummary> | null {
  if (!result.ok) return null;
  // A LineString needs two positions; a route between identical waypoints is a single point.
  const coordinates = result.path.length === 1 ? [result.path[0], result.path[0]] : result.path;
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates },
    properties: {
      weight: result.weight,
      distance: result.distance,
      algorithm: result.algorithm,
      legs: result.legs.map((leg) => ({ weight: leg.weight, distance: leg.distance })),
    },
  };
}
