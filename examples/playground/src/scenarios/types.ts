import type { GraphOptions, NetworkCollection, Position, RouteOptions } from '../../../../src';
import type { FeatureStyle } from '../lib/svg';

export interface ScenarioPreset {
  label: string;
  waypoints: Position[];
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
}

export interface Scenario<P = unknown> {
  id: string;
  title: string;
  blurb: string;
  /** Network + finder options; `network` may be a loader for data fetched at runtime. */
  network: NetworkCollection<P> | (() => Promise<NetworkCollection<P>>);
  graphOptions: GraphOptions<P>;
  defaultRouteOptions: RouteOptions;
  styleOf: (props: P, featureIndex: number) => FeatureStyle;
  /** Geographic coordinates need a longitude compression factor (`cos(reference latitude)`); planar data uses 1. */
  latScale?: number;
  features: ScenarioFeatures;
  presets: ScenarioPreset[];
  minWaypoints?: number;
}
