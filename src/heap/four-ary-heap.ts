import type { Heap } from './heap';

/**
 * 4-ary min-heap with stable tie-breaking on insertion order.
 *
 * Adapted from terra-route (MIT, James Milner): parallel arrays instead of node objects, and a shallower
 * tree than a binary heap, which suits the insert-heavy workload of shortest-path search.
 * Parent(i) = (i - 1) >> 2, children(i) = 4i + 1 … 4i + 4.
 */
export class FourAryHeap implements Heap {
  private keys: number[] = [];
  private values: number[] = [];
  private order: number[] = [];
  private length = 0;
  private counter = 0;

  insert(key: number, value: number): void {
    const keys = this.keys;
    const values = this.values;
    const order = this.order;
    let i = this.length++;
    const seq = this.counter++;
    while (i > 0) {
      const p = (i - 1) >>> 2;
      const pk = keys[p];
      if (key > pk || (key === pk && seq > order[p])) break;
      keys[i] = pk;
      values[i] = values[p];
      order[i] = order[p];
      i = p;
    }
    keys[i] = key;
    values[i] = value;
    order[i] = seq;
  }

  extractMin(): number {
    const n = this.length;
    if (n === 0) return -1;
    const min = this.values[0];
    const last = n - 1;
    this.length = last;
    if (last > 0) {
      this.keys[0] = this.keys[last];
      this.values[0] = this.values[last];
      this.order[0] = this.order[last];
      this.siftDown();
    }
    return min;
  }

  peekMinKey(): number {
    return this.length === 0 ? Infinity : this.keys[0];
  }

  size(): number {
    return this.length;
  }

  clear(): void {
    // Keep the backing arrays to avoid re-allocation between queries.
    this.length = 0;
    this.counter = 0;
  }

  private siftDown(): void {
    const n = this.length;
    const keys = this.keys;
    const values = this.values;
    const order = this.order;
    const key = keys[0];
    const value = values[0];
    const seq = order[0];
    let i = 0;
    for (;;) {
      const first = (i << 2) + 1;
      if (first >= n) break;
      let best = first;
      let bk = keys[first];
      let bo = order[first];
      const end = first + 4 < n ? first + 4 : n;
      for (let c = first + 1; c < end; c++) {
        const ck = keys[c];
        if (ck < bk || (ck === bk && order[c] < bo)) {
          best = c;
          bk = ck;
          bo = order[c];
        }
      }
      if (bk < key || (bk === key && bo < seq)) {
        keys[i] = bk;
        values[i] = values[best];
        order[i] = bo;
        i = best;
      } else {
        break;
      }
    }
    keys[i] = key;
    values[i] = value;
    order[i] = seq;
  }
}
