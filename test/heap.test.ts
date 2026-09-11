import { describe, expect, it } from 'vitest';
import { FourAryHeap } from '../src';
import { mulberry32 } from './helpers';

describe('FourAryHeap', () => {
  it('extracts values in non-decreasing key order and peekMinKey agrees', () => {
    const rand = mulberry32(1);
    const heap = new FourAryHeap();
    const keys: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const k = Math.floor(rand() * 500);
      keys.push(k);
      heap.insert(k, i);
    }
    const seen = new Set<number>();
    let previous = -Infinity;
    while (heap.size() > 0) {
      const k = heap.peekMinKey();
      const v = heap.extractMin();
      expect(keys[v]).toBe(k);
      expect(k).toBeGreaterThanOrEqual(previous);
      previous = k;
      seen.add(v);
    }
    expect(seen.size).toBe(2000);
  });

  it('breaks ties by insertion order', () => {
    const heap = new FourAryHeap();
    heap.insert(1, 10);
    heap.insert(1, 11);
    heap.insert(0, 5);
    heap.insert(1, 12);
    heap.insert(1, 13);
    heap.insert(1, 14);
    expect([1, 2, 3, 4, 5, 6].map(() => heap.extractMin())).toEqual([5, 10, 11, 12, 13, 14]);
  });

  it('reports the empty state and stays usable after clear()', () => {
    const heap = new FourAryHeap();
    expect(heap.extractMin()).toBe(-1);
    expect(heap.peekMinKey()).toBe(Infinity);
    heap.insert(3, 3);
    heap.insert(2, 2);
    heap.clear();
    expect(heap.size()).toBe(0);
    heap.insert(7, 70);
    expect(heap.extractMin()).toBe(70);
  });
});
