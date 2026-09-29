import type { NetworkCollection, Position } from '../../../../src';

/** How one network feature is drawn. */
export interface FeatureStyle {
  stroke: string;
  width: number;
  dash?: string;
  opacity?: number;
}

export interface RouteLine {
  path: Position[];
  color: string;
  width?: number;
  dash?: string;
  label?: string;
}

export interface WaypointMark {
  input: Position;
  location?: Position;
  index: number;
  ok: boolean;
}

export interface CandidateMark {
  location: Position;
  selected: boolean;
}

export interface TransitionMark {
  location: Position;
  label: string;
  onClick?: () => void;
}

/** Everything drawn on top of the network; replaced as a whole on every recompute. */
export interface Overlay {
  routes?: RouteLine[];
  transitions?: TransitionMark[];
  waypoints?: WaypointMark[];
  candidates?: CandidateMark[];
  /** Dangling ends from `graph.diagnostics()`. */
  dangles?: Position[];
}

/**
 * A place to draw a scenario: the plain SVG canvas (planar data, floor plans) or a MapLibre map on an
 * OpenFreeMap basemap (longitude / latitude data). The app talks to both through this interface only.
 */
export interface MapView {
  show(): void;
  hide(): void;
  /**
   * Draws the network (points are drawn as small markers). `fit` frames the view on it — on a scenario
   * change, not when only the styling changes (switching floors).
   */
  setNetwork(
    network: NetworkCollection<unknown>,
    styleOf: (props: unknown, featureIndex: number) => FeatureStyle,
    fit: boolean,
  ): void;
  setOverlay(overlay: Overlay): void;
  /** Brings these locations into view (a map zooms to a preset route; the SVG canvas always shows everything). */
  focus?(locations: Position[]): void;
  /** Called with the clicked location in data coordinates. */
  onClick(handler: (location: Position) => void): void;
}

export function coordinateLists(network: NetworkCollection<unknown>): Position[][] {
  return network.features
    .map((f) => f.geometry as { type?: string; coordinates?: unknown } | null)
    .flatMap((g) =>
      g?.type === 'LineString'
        ? [g.coordinates as Position[]]
        : g?.type === 'MultiLineString'
          ? (g.coordinates as Position[][])
          : g?.type === 'Point'
            ? [[g.coordinates as Position]]
            : [],
    );
}
