// Type-level smoke test of the published declarations (never executed).
import {
  LineFinder,
  RoutingGraph,
  bidirectionalDijkstra,
  createPropertyWeight,
  prepareLandmarks,
  type CandidateInfo,
  type GraphDiagnostics,
  type ManyResult,
  type PathAlgorithm,
  type RouteFailure,
  type RouteOptions,
  type RouteResult,
  type SearchRequest,
  type TransferableGraph,
} from '../dist/index.js';

interface Props {
  level: 'Main' | 'Side';
  floor?: string;
}

const finder = new LineFinder<Props>(
  { type: 'FeatureCollection', features: [] },
  {
    metric: 'euclidean',
    weight: createPropertyWeight<Props>({ factor: (p) => (p.level === 'Main' ? 1.5 : 0.8) }),
    group: (p) => p.floor,
    zeroWeight: 'free',
    diagnostics: true,
  },
);

const options: RouteOptions = {
  snap: { selection: 'optimal', costMode: 'arrive-depart', candidates: 4, maxRelocation: 5 },
  onFailure: 'skip',
  skip: { leading: true, max: 2 },
  connectors: 'legs',
  totals: { includeSnapWeight: true },
  budget: { maxSettled: 10_000 },
  sectionsDetail: 'measure',
  debug: { candidates: true },
};

const result: RouteResult<Props> = finder.route(
  [[0, 0], { coordinates: [1, 1], snap: { featureIds: ['a'], passThrough: true } }, [2, 2]],
  options,
);
if (result.ok) {
  const measure: number = result.legs[0].sections[0].toMeasure;
  const relocated: boolean = result.waypoints[0].relocated;
  void [measure, relocated, result.skipped, result.snapWeight];
} else {
  const failure: RouteFailure = result;
  void failure.detail;
}

const candidates: CandidateInfo[] = finder.candidates([0, 0], { filter: (c) => c.side !== 'right' });
const diagnostics: GraphDiagnostics = finder.graph.diagnostics({ limit: 10 });
const transferable: TransferableGraph = finder.graph.toTransferable({ shared: true });
const copy: RoutingGraph<Props> = RoutingGraph.fromTransferable<Props>(transferable);
const many: ManyResult<Props> | RouteFailure = new LineFinder(copy, {
  landmarks: prepareLandmarks(copy, { count: 4 }),
}).oneToMany([0, 0], [[1, 1]], { paths: true });

const engine: PathAlgorithm = {
  name: 'custom',
  usesHeuristic: false,
  capabilities: { multiTarget: false },
  search: (request: SearchRequest) => bidirectionalDijkstra.search(request),
};
finder.registerAlgorithm(engine);

void [candidates, diagnostics, many];
