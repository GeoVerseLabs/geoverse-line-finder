export { LineFinder } from './route/finder';
export type {
  CandidateOptions,
  CandidateReport,
  CandidateStatus,
  ConnectorMode,
  FailurePolicy,
  LineFinderOptions,
  ManyOptions,
  ManyResult,
  MatrixResult,
  NearestResult,
  RouteFailure,
  RouteFailureDetail,
  RouteFailureReason,
  RouteLeg,
  RouteOptions,
  RouteResult,
  RouteSuccess,
  SearchBudget,
  SkippedWaypoint,
  SnappedWaypoint,
  WaypointAccess,
} from './route/finder';
export type { LevelKey, LevelTransition, RouteSection, SectionsDetail } from './route/assemble';
export { toLineString, type RouteSummary } from './route/geojson';
export { toLevelFeatures } from './route/level-features';
export type {
  LevelFeature,
  LevelFeatureCollection,
  LevelFeatureKind,
  LevelFeatureProperties,
} from './route/level-features';

export { buildGraph, type GraphOptions, type GraphSettings } from './graph/build';
export { RoutingGraph } from './graph/graph';
export type {
  ChainTable,
  ComponentTable,
  DiagnosticsLog,
  EdgeTable,
  GraphStats,
  NodeChainTable,
  NodeTable,
  ReverseEdgeTable,
  SegmentTable,
  VertexTable,
} from './graph/graph';
export type { StrongComponents } from './graph/scc';
export type { GroupFunction, GroupKey } from './graph/topology';
export type {
  ConnectorDirection,
  LevelInfo,
  LevelTable,
  LevelsOption,
  VerticalConnector,
} from './graph/levels';

export type {
  ComponentReport,
  ConnectorEndReport,
  DangleReport,
  DiagnosticList,
  DiagnosticsOptions,
  GraphDiagnostics,
  InvalidCoordinateReport,
  LevelReachability,
  OverlapReport,
  RepairReport,
} from './graph/diagnostics';
export { GRAPH_FORMAT, GRAPH_FORMAT_VERSION, GRAPH_FORMAT_VERSIONS } from './graph/serialize';
export type { DeserializeOptions, GraphHeader, SerializeOptions, TransferableGraph } from './graph/serialize';

export { AlgorithmRegistry, builtinAlgorithms, createAlgorithmRegistry } from './algorithm/registry';
export { astar } from './algorithm/astar';
export { dijkstra } from './algorithm/dijkstra';
export { bidirectionalDijkstra } from './algorithm/bidirectional';
export { LandmarkTable, prepareLandmarks } from './algorithm/landmarks';
export type { LandmarkOptions, LandmarkStrategy, TransferableLandmarks } from './algorithm/landmarks';
export { SearchScratch, reconstructPath } from './algorithm/scratch';
export type {
  AlgorithmCapabilities,
  Heuristic,
  PathAlgorithm,
  SearchGraph,
  SearchRequest,
  SearchResult,
  TargetPath,
} from './algorithm/types';

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
  ZeroWeight,
} from './weight/weight';

export type {
  CandidateCost,
  CandidateDistinct,
  CandidateFilter,
  CandidateInfo,
  CandidateSide,
  SnapConnectivity,
  SnapCostMode,
  SnapMode,
  SnapOptions,
  SnapSelection,
  WaypointContext,
  WaypointRole,
  WaypointSnapOptions,
} from './snap/snap';

export type {
  GeometryLike,
  LineStringFeature,
  NetworkCollection,
  NetworkFeature,
  PointFeature,
  PointGeometry,
  Position,
  WaypointInput,
  WaypointObject,
} from './types';
