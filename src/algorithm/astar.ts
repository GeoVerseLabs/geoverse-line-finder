import { bestFirstSearch } from './best-first';
import type { PathAlgorithm } from './types';

/**
 * A* search. With the built-in heuristic (metric embedding × minimum cost-per-length, see
 * `graph/build.ts`) it is admissible and consistent for **any** weight function, so it returns the same
 * optimal cost as Dijkstra while settling far fewer nodes. Closed nodes are re-opened if a custom,
 * merely admissible heuristic ever finds them a cheaper label, so optimality never depends on
 * consistency. Without a heuristic it degenerates to Dijkstra. Supports multiple targets and budgets.
 */
export const astar: PathAlgorithm = {
  name: 'astar',
  usesHeuristic: true,
  capabilities: { multiTarget: true, budget: true },
  search: (request) => bestFirstSearch(request, request.heuristic),
};
