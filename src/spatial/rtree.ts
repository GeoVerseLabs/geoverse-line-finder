import { FourAryHeap } from '../heap/four-ary-heap';

/**
 * Static packed Hilbert R-tree over axis-aligned boxes (layout after flatbush, ISC).
 *
 * Built once, queried many times. Besides window search it offers an exact best-first nearest-item
 * iterator: boxes are ordered by their scaled box distance (a lower bound) and items by an exact
 * distance supplied by the caller, so items come out in true ascending distance order.
 */
export class PackedRTree {
  readonly numItems: number;
  readonly nodeSize: number;
  private readonly levelBounds: number[];
  private readonly boxes: Float64Array;
  private readonly indices: Uint32Array;
  private pos = 0;
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  private readonly queue = new FourAryHeap();
  private readonly stack: number[] = [];

  constructor(numItems: number, nodeSize = 16) {
    this.numItems = Math.max(0, numItems | 0);
    this.nodeSize = Math.min(Math.max(nodeSize | 0, 2), 65535);
    let n = this.numItems;
    let numNodes = n;
    this.levelBounds = [n * 4];
    if (n > 0) {
      do {
        n = Math.ceil(n / this.nodeSize);
        numNodes += n;
        this.levelBounds.push(numNodes * 4);
      } while (n !== 1);
    }
    this.boxes = new Float64Array(numNodes * 4);
    this.indices = new Uint32Array(numNodes);
  }

  add(minX: number, minY: number, maxX: number, maxY: number): number {
    const index = this.pos >> 2;
    const boxes = this.boxes;
    this.indices[index] = index;
    boxes[this.pos++] = minX;
    boxes[this.pos++] = minY;
    boxes[this.pos++] = maxX;
    boxes[this.pos++] = maxY;
    if (minX < this.minX) this.minX = minX;
    if (minY < this.minY) this.minY = minY;
    if (maxX > this.maxX) this.maxX = maxX;
    if (maxY > this.maxY) this.maxY = maxY;
    return index;
  }

  finish(): void {
    if (this.pos >> 2 !== this.numItems) {
      throw new Error(`Added ${this.pos >> 2} items when expected ${this.numItems}.`);
    }
    const n = this.numItems;
    if (n === 0) return;
    const boxes = this.boxes;
    const indices = this.indices;

    if (n <= this.nodeSize) {
      indices[this.pos >> 2] = 0;
      boxes[this.pos++] = this.minX;
      boxes[this.pos++] = this.minY;
      boxes[this.pos++] = this.maxX;
      boxes[this.pos++] = this.maxY;
      return;
    }

    const width = this.maxX - this.minX || 1;
    const height = this.maxY - this.minY || 1;
    const hilbertValues = new Uint32Array(n);
    const hilbertMax = (1 << 16) - 1;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const x = Math.floor((hilbertMax * ((boxes[p] + boxes[p + 2]) / 2 - this.minX)) / width);
      const y = Math.floor((hilbertMax * ((boxes[p + 1] + boxes[p + 3]) / 2 - this.minY)) / height);
      hilbertValues[i] = hilbert(x, y);
    }
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => hilbertValues[a] - hilbertValues[b] || a - b);
    const sortedBoxes = new Float64Array(n * 4);
    const sortedIndices = new Uint32Array(n);
    for (let k = 0; k < n; k++) {
      const i = order[k];
      sortedBoxes[4 * k] = boxes[4 * i];
      sortedBoxes[4 * k + 1] = boxes[4 * i + 1];
      sortedBoxes[4 * k + 2] = boxes[4 * i + 2];
      sortedBoxes[4 * k + 3] = boxes[4 * i + 3];
      sortedIndices[k] = indices[i];
    }
    boxes.set(sortedBoxes, 0);
    indices.set(sortedIndices, 0);

    for (let level = 0, pos = 0; level < this.levelBounds.length - 1; level++) {
      const end = this.levelBounds[level];
      while (pos < end) {
        const nodeIndex = pos;
        let nMinX = boxes[pos++];
        let nMinY = boxes[pos++];
        let nMaxX = boxes[pos++];
        let nMaxY = boxes[pos++];
        for (let j = 1; j < this.nodeSize && pos < end; j++) {
          nMinX = Math.min(nMinX, boxes[pos++]);
          nMinY = Math.min(nMinY, boxes[pos++]);
          nMaxX = Math.max(nMaxX, boxes[pos++]);
          nMaxY = Math.max(nMaxY, boxes[pos++]);
        }
        indices[this.pos >> 2] = nodeIndex;
        boxes[this.pos++] = nMinX;
        boxes[this.pos++] = nMinY;
        boxes[this.pos++] = nMaxX;
        boxes[this.pos++] = nMaxY;
      }
    }
  }

  /** Calls `visit` for every item whose box intersects the window. */
  search(minX: number, minY: number, maxX: number, maxY: number, visit: (index: number) => void): void {
    if (this.numItems === 0) return;
    const boxes = this.boxes;
    const indices = this.indices;
    const leafEnd = this.numItems * 4;
    const stack = this.stack;
    stack.length = 0;
    let nodeIndex = boxes.length - 4;
    for (;;) {
      const end = Math.min(nodeIndex + this.nodeSize * 4, upperBound(nodeIndex, this.levelBounds));
      for (let pos = nodeIndex; pos < end; pos += 4) {
        if (maxX < boxes[pos] || maxY < boxes[pos + 1] || minX > boxes[pos + 2] || minY > boxes[pos + 3]) {
          continue;
        }
        const index = indices[pos >> 2];
        if (nodeIndex >= leafEnd) stack.push(index);
        else visit(index);
      }
      if (stack.length === 0) break;
      nodeIndex = stack.pop()!;
    }
  }

  /**
   * Visits items in ascending exact distance from `(qx, qy)`.
   *
   * Coordinate deltas are multiplied by `sx`/`sy` before measuring, and `itemDistance` must return the
   * exact distance in the same scaled space (never below the box distance). Iteration stops when
   * `visit` returns `false` or the next distance exceeds `maxDistance`.
   */
  nearest(
    qx: number,
    qy: number,
    sx: number,
    sy: number,
    itemDistance: (index: number) => number,
    visit: (index: number, distance: number) => boolean,
    maxDistance = Infinity,
  ): void {
    if (this.numItems === 0) return;
    const boxes = this.boxes;
    const indices = this.indices;
    const leafEnd = this.numItems * 4;
    const q = this.queue;
    q.clear();
    // Values: node groups are encoded as (childStart << 1), items as (index << 1) | 1.
    q.insert(0, (boxes.length - 4) << 1);
    while (q.size() > 0) {
      const key = q.peekMinKey();
      if (key > maxDistance) break;
      const value = q.extractMin();
      if (value & 1) {
        if (!visit(value >>> 1, key)) return;
        continue;
      }
      const nodeIndex = value >>> 1;
      const end = Math.min(nodeIndex + this.nodeSize * 4, upperBound(nodeIndex, this.levelBounds));
      const leaf = nodeIndex < leafEnd;
      for (let pos = nodeIndex; pos < end; pos += 4) {
        const dx = axisDistance(qx, boxes[pos], boxes[pos + 2]) * sx;
        const dy = axisDistance(qy, boxes[pos + 1], boxes[pos + 3]) * sy;
        const boxDistance = Math.sqrt(dx * dx + dy * dy);
        if (boxDistance > maxDistance) continue;
        const index = indices[pos >> 2];
        if (leaf) {
          const d = itemDistance(index);
          if (d <= maxDistance) q.insert(d, (index << 1) | 1);
        } else {
          q.insert(boxDistance, index << 1);
        }
      }
    }
  }
}

function axisDistance(k: number, min: number, max: number): number {
  return k < min ? min - k : k <= max ? 0 : k - max;
}

function upperBound(value: number, arr: number[]): number {
  let i = 0;
  let j = arr.length - 1;
  while (i < j) {
    const m = (i + j) >> 1;
    if (arr[m] > value) j = m;
    else i = m + 1;
  }
  return arr[i];
}

// Fast Hilbert curve index for 16-bit coordinates (from flatbush, ISC; originally by rawrunprotected).
function hilbert(x: number, y: number): number {
  let a = x ^ y;
  let b = 0xffff ^ a;
  let c = 0xffff ^ (x | y);
  let d = x & (y ^ 0xffff);

  let A = a | (b >> 1);
  let B = (a >> 1) ^ a;
  let C = (c >> 1) ^ (b & (d >> 1)) ^ c;
  let D = (a & (c >> 1)) ^ (d >> 1) ^ d;

  a = A;
  b = B;
  c = C;
  d = D;
  A = (a & (a >> 2)) ^ (b & (b >> 2));
  B = (a & (b >> 2)) ^ (b & ((a ^ b) >> 2));
  C ^= (a & (c >> 2)) ^ (b & (d >> 2));
  D ^= (b & (c >> 2)) ^ ((a ^ b) & (d >> 2));

  a = A;
  b = B;
  c = C;
  d = D;
  A = (a & (a >> 4)) ^ (b & (b >> 4));
  B = (a & (b >> 4)) ^ (b & ((a ^ b) >> 4));
  C ^= (a & (c >> 4)) ^ (b & (d >> 4));
  D ^= (b & (c >> 4)) ^ ((a ^ b) & (d >> 4));

  a = A;
  b = B;
  c = C;
  d = D;
  C ^= (a & (c >> 8)) ^ (b & (d >> 8));
  D ^= (b & (c >> 8)) ^ ((a ^ b) & (d >> 8));

  a = C ^ (C >> 1);
  b = D ^ (D >> 1);

  let i0 = x ^ y;
  let i1 = b | (0xffff ^ (i0 | a));

  i0 = (i0 | (i0 << 8)) & 0x00ff00ff;
  i0 = (i0 | (i0 << 4)) & 0x0f0f0f0f;
  i0 = (i0 | (i0 << 2)) & 0x33333333;
  i0 = (i0 | (i0 << 1)) & 0x55555555;

  i1 = (i1 | (i1 << 8)) & 0x00ff00ff;
  i1 = (i1 | (i1 << 4)) & 0x0f0f0f0f;
  i1 = (i1 | (i1 << 2)) & 0x33333333;
  i1 = (i1 | (i1 << 1)) & 0x55555555;

  return ((i1 << 1) | i0) >>> 0;
}
