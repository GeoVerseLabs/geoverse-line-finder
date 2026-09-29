import type { GraphOptions, GroupKey, NetworkCollection, Position, RouteOptions } from '../../../../src';
import type { FeatureStyle } from '../lib/view';

export interface ScenarioPreset {
  label: string;
  waypoints: Position[];
  /** Multi-level scenarios: the level each waypoint belongs to (`snap.group`). */
  levels?: GroupKey[];
}

export interface ScenarioFeatures {
  /** Show the nearest-vs-optimal overlay toggle and legend. */
  compareSelection?: boolean;
  /** Show the onFailure (skip/straight) control — needs a network with an unreachable pocket. */
  failurePolicy?: boolean;
  /** Show the "constrain to the clicked aisle" (snap.featureIds) toggle. */
  featureConstraint?: boolean;
  /** Show a "run diagnostics" button (dangling ends, components). */
  diagnostics?: boolean;
  /** Show per-leg section measures (R5 linear referencing). */
  measures?: boolean;
  /** Show the floor switcher and draw the route level by level (needs `Scenario.levels`). */
  levels?: boolean;
}

/** Multi-level scenarios: the floors to switch between, and which floor a feature belongs to. */
export interface ScenarioLevels<P> {
  floors: { key: GroupKey; label: string }[];
  /** The level of a feature, or `null` for a connector (a lift, stairs, an escalator). */
  floorOf: (props: P) => GroupKey | null;
}

/**
 * One way of travelling the same network (driving time, walking distance…): a graph of its own, built when
 * the profile is picked — "one graph per profile".
 */
export interface ScenarioProfile<P> {
  id: string;
  label: string;
  graphOptions: GraphOptions<P>;
  styleOf?: Scenario<P>['styleOf'];
  /** Unit of the weight, shown next to it. */
  unit?: string;
}

export interface Scenario<P = unknown> {
  id: string;
  title: string;
  blurb: string;
  /**
   * `'map'`: longitude / latitude data on a MapLibre map with an OpenFreeMap basemap. `'svg'` (default): the
   * plain SVG canvas, for planar data where a basemap would only mislead.
   */
  view?: 'svg' | 'map';
  /** Alternative graphs over the same network; the first is built on load. Overrides `graphOptions`. */
  profiles?: ScenarioProfile<P>[];
  /** Network + finder options; `network` may be a loader for data fetched at runtime. */
  network: NetworkCollection<P> | (() => Promise<NetworkCollection<P>>);
  graphOptions: GraphOptions<P>;
  defaultRouteOptions: RouteOptions;
  /** `context.level` is the floor currently shown, when the scenario has levels. */
  styleOf: (props: P, featureIndex: number, context?: { level?: GroupKey }) => FeatureStyle;
  levels?: ScenarioLevels<P>;
  /** Geographic coordinates need a longitude compression factor (`cos(reference latitude)`); planar data uses 1. */
  latScale?: number;
  features: ScenarioFeatures;
  presets: ScenarioPreset[];
  minWaypoints?: number;
}
