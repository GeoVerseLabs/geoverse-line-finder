import { bestFirstSearch } from './best-first';
import type { PathAlgorithm } from './types';

/**
 * Dijkstra's algorithm with lazy deletion, stopping as soon as the target (or every target) is settled.
 * Works with any non-negative costs and needs no heuristic, which makes it the reference engine.
 */
export const dijkstra: PathAlgorithm = {
  name: 'dijkstra',
  usesHeuristic: false,
  capabilities: { multiTarget: true, budget: true },
  search: (request) => bestFirstSearch(request, null),
};
