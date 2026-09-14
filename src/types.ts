/**
 * Minimal structural GeoJSON types.
 *
 * They are deliberately loose so that objects typed with `@types/geojson` (or plain parsed JSON)
 * are accepted as-is, without the library taking a dependency on any typings package.
 */
import type { WaypointSnapOptions } from './snap/snap';

/** `[x, y]` or `[x, y, z]`. Only x/y take part in routing; z is carried through to output coordinates. */
export type Position = number[];

export interface GeometryLike {
  readonly type: string;
  readonly coordinates?: unknown;
}

export interface PointGeometry {
  readonly type: 'Point';
  readonly coordinates: Position;
}

export interface PointFeature {
  readonly type: 'Feature';
  readonly geometry: PointGeometry;
  readonly properties?: unknown;
}

/** A feature of the routing network. `LineString` and `MultiLineString` geometries are routable; others are skipped. */
export interface NetworkFeature<P = unknown> {
  readonly type?: 'Feature';
  readonly id?: string | number;
  readonly geometry: GeometryLike | null;
  readonly properties?: P;
}

export interface NetworkCollection<P = unknown> {
  readonly type?: 'FeatureCollection';
  readonly features: readonly NetworkFeature<P>[];
}

/** A waypoint with its own snapping options, which override the route's `snap` options for this point. */
export interface WaypointObject {
  readonly coordinates: Position;
  readonly snap?: WaypointSnapOptions;
}

/**
 * Anything accepted as a waypoint: a bare position, a Point geometry, a Point feature, or an object
 * `{ coordinates, snap }` (a Point geometry or feature may also carry `snap`).
 */
export type WaypointInput =
  | Position
  | (PointGeometry & { readonly snap?: WaypointSnapOptions })
  | (PointFeature & { readonly snap?: WaypointSnapOptions })
  | WaypointObject;

export interface LineStringFeature<P> {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: Position[] };
  properties: P;
}
