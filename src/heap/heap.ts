/**
 * Min-priority queue of integer values keyed by numbers.
 *
 * Engines reuse one heap instance across queries, so `clear()` is mandatory. Implementations should
 * break ties by insertion order to keep routes stable between runs.
 */
export interface Heap {
  insert(key: number, value: number): void;
  /** Removes and returns the value with the smallest key, or `-1` when empty. */
  extractMin(): number;
  /** Smallest key, or `Infinity` when empty. */
  peekMinKey(): number;
  size(): number;
  clear(): void;
}

export type HeapConstructor = new () => Heap;
