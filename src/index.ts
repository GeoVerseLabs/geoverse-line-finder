export { LineFinder } from './route/finder';
export type {
  LineFinderOptions,
  NearestResult,
  RouteFailure,
  RouteFailureReason,
  RouteLeg,
  RouteOptions,
  RouteResult,
  RouteSuccess,
  SnappedWaypoint,
} from './route/finder';
export type { RouteSection } from './route/assemble';
export { toLineString, type RouteSummary } from './route/geojson';

export { buildGraph, type GraphOptions } from './graph/build';
export { RoutingGraph } from './graph/graph';
export type {
  ChainTable,
  ComponentTable,
  EdgeTable,
  GraphStats,
  NodeTable,
  SegmentTable,
  VertexTable,
} from './graph/graph';

export { AlgorithmRegistry, builtinAlgorithms, createAlgorithmRegistry } from './algorithm/registry';
export { astar } from './algorithm/astar';
export { dijkstra } from './algorithm/dijkstra';
export { SearchScratch, reconstructPath } from './algorithm/scratch';
export type { Heuristic, PathAlgorithm, SearchGraph, SearchRequest, SearchResult } from './algorithm/types';

export { FourAryHeap } from './heap/four-ary-heap';
export type { Heap, HeapConstructor } from './heap/heap';

export {
  EARTH_RADIUS_M,
  cheapRulerMetric,
  euclideanMetric,
  haversineDistance,
  haversineMetric,
} from './geo/metric';
export type { Metric, MetricOption } from './geo/metric';

export {
  createPropertyWeight,
  createSpeedWeight,
  directional,
  distanceWeight,
  osmDirection,
} from './weight/weight';
export type {
  DirectionalWeight,
  PropertyWeightOptions,
  SpeedWeightOptions,
  TravelDirection,
  WeightContext,
  WeightFunction,
  WeightResult,
} from './weight/weight';

export type { SnapConnectivity, SnapMode, SnapOptions } from './snap/snap';

export type {
  GeometryLike,
  LineStringFeature,
  NetworkCollection,
  NetworkFeature,
  PointFeature,
  PointGeometry,
  Position,
  WaypointInput,
} from './types';
