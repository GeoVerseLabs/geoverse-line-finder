import { astar } from './astar';
import { dijkstra } from './dijkstra';
import type { PathAlgorithm } from './types';

export const builtinAlgorithms: readonly PathAlgorithm[] = [dijkstra, astar];

function assertAlgorithm(algorithm: PathAlgorithm): void {
  if (
    !algorithm ||
    typeof algorithm.name !== 'string' ||
    algorithm.name.length === 0 ||
    typeof algorithm.search !== 'function'
  ) {
    throw new TypeError('A path algorithm needs a non-empty "name" and a "search" function.');
  }
}

/** Named set of engines. Each {@link LineFinder} owns one, pre-filled with the built-ins. */
export class AlgorithmRegistry {
  private readonly algorithms = new Map<string, PathAlgorithm>();

  constructor(initial: Iterable<PathAlgorithm> = []) {
    for (const algorithm of initial) this.register(algorithm);
  }

  /** Adds an engine. Re-registering a name throws unless `replace` is set. */
  register(algorithm: PathAlgorithm, options: { replace?: boolean } = {}): this {
    assertAlgorithm(algorithm);
    if (this.algorithms.has(algorithm.name) && !options.replace) {
      throw new Error(
        `Algorithm "${algorithm.name}" is already registered; pass { replace: true } to override.`,
      );
    }
    this.algorithms.set(algorithm.name, algorithm);
    return this;
  }

  unregister(name: string): boolean {
    return this.algorithms.delete(name);
  }

  has(name: string): boolean {
    return this.algorithms.has(name);
  }

  get(name: string): PathAlgorithm | undefined {
    return this.algorithms.get(name);
  }

  names(): string[] {
    return [...this.algorithms.keys()];
  }

  /** Accepts a registered name or an engine object. */
  resolve(algorithm: string | PathAlgorithm): PathAlgorithm {
    if (typeof algorithm === 'object' && algorithm !== null) {
      assertAlgorithm(algorithm);
      return algorithm;
    }
    const found = this.algorithms.get(algorithm);
    if (!found) {
      throw new Error(`Unknown algorithm "${String(algorithm)}". Registered: ${this.names().join(', ')}.`);
    }
    return found;
  }
}

export function createAlgorithmRegistry(): AlgorithmRegistry {
  return new AlgorithmRegistry(builtinAlgorithms);
}
