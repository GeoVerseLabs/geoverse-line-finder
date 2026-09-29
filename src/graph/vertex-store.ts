import { METERS_PER_DEGREE } from '../geo/metric';
import type { Position } from '../types';
import type { NodeKey } from './topology';

const RAD = Math.PI / 180;
const NONE = -1;

export interface VertexStoreOptions {
  /** Merge distance in metric units (meters for geographic metrics). `0` = exact coordinate identity. */
  tolerance: number;
  geographic: boolean;
  /** Largest |latitude| in the network; sizes the longitude cells so no neighbour is ever missed. */
  maxAbsLat: number;
  /** Expected number of vertices (the arrays grow past it when needed). */
  capacity?: number;
}

/**
 * Group index of vertices that belong to no connectivity group: the interior coordinates of connector
 * features (the steps of a staircase between two floors). They are never merged, looked up or repaired.
 */
export const NO_GROUP = -1;

// Bit patterns of two doubles, for hashing.
const F64 = new Float64Array(2);
const U32 = new Uint32Array(F64.buffer);

function mix(h: number, k: number): number {
  k = Math.imul(k, 0xcc9e2d51);
  h ^= Math.imul((k << 15) | (k >>> 17), 0x1b873593);
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

/**
 * MurmurHash3 of a key `(a, b, group)`. Grid cells are integers, almost always within 32 bits, and take a
 * shortcut; coordinates are hashed by their bit patterns, with `+ 0` folding -0 into +0 so the hash agrees
 * with `===` (and with the `Map` keys this store used before).
 */
function hash(a: number, b: number, group: number): number {
  let h: number;
  if (a === (a | 0) && b === (b | 0)) {
    h = mix(mix(group, a), b);
  } else {
    F64[0] = a + 0;
    F64[1] = b + 0;
    h = mix(mix(mix(mix(group, U32[0]), U32[1]), U32[2]), U32[3]);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

function resized<T extends Float64Array | Int32Array | Uint8Array>(array: T, length: number): T {
  const out = new (array.constructor as new (n: number) => T)(length);
  out.set(array.subarray(0, Math.min(array.length, length)));
  return out;
}

/**
 * Deduplicates network coordinates into vertex ids.
 *
 * One open-addressing hash table over flat typed arrays (no string keys, no nested maps). Exact mode keys it
 * by the coordinates; tolerance mode by grid cells at least `tolerance` wide, each the head of a list of its
 * vertices, and checks the 3×3 neighbourhood with a real distance — unlike geojson-path-finder's coordinate
 * rounding, which fails to merge two points that straddle a rounding boundary however close they are.
 *
 * Vertices live in connectivity groups (`0` unless the graph uses `group`): only vertices of the same group
 * ever merge, so stacked floors or a bridge above a road stay apart. The first vertex at a location owns it:
 * lookups return it, whatever else is appended there later.
 */
export class VertexStore {
  /**
   * Coordinates and group of every vertex; only the first {@link size} entries are meaningful. Entries never
   * change once appended and growing copies them, so an array read earlier still holds every vertex that
   * existed at that time.
   */
  x: Float64Array;
  y: Float64Array;
  group: Int32Array;
  /** Original coordinate objects, kept for faithful output (including any z value). */
  readonly positions: Position[] = [];
  /** Number of coordinates that were merged into an already known vertex. */
  merged = 0;
  /** Distance to the vertex matched by the last successful {@link find} (`0` for identical coordinates). */
  lastDistance = 0;
  /** Number of vertices that carry a node id. */
  keyedCount = 0;

  private count = 0;
  private readonly tolerance: number;
  private readonly geographic: boolean;
  /** Grid cell size (tolerance mode). */
  private readonly cellX: number = 0;
  private readonly cellY: number = 0;
  /**
   * The hash table. Slot `s` is in use when bit `s` of `used` is set; its key is `keys[3s..3s+2]` (coordinates
   * or cell, and group) and `head[s]` is the vertex that owns the location (exact mode) or the first vertex
   * of the cell, the others following through `next` (tolerance mode).
   */
  private used: Int32Array;
  private keys: Float64Array;
  private head: Int32Array;
  private next: Int32Array;
  private mask: number;
  private entries = 0;
  /** Vertex of every node id, per group (see {@link getOrAddKeyed}); only while building. */
  private ids: Map<NodeKey, number>[] | null = null;
  /** 1 for vertices that carry a node id. */
  private keyed: Uint8Array | null = null;

  constructor(options: VertexStoreOptions, arrays?: { x: Float64Array; y: Float64Array; group: Int32Array }) {
    this.tolerance = options.tolerance > 0 ? options.tolerance : 0;
    this.geographic = options.geographic;
    const capacity = arrays ? arrays.x.length : Math.max(16, Math.ceil(options.capacity ?? 0));
    this.x = arrays ? arrays.x : new Float64Array(capacity);
    this.y = arrays ? arrays.y : new Float64Array(capacity);
    this.group = arrays ? arrays.group : new Int32Array(capacity);
    this.next = new Int32Array(this.tolerance > 0 ? capacity : 0);
    let size = 16;
    while (size < capacity) size *= 2;
    this.used = new Int32Array(size >>> 5 || 1);
    this.keys = new Float64Array(size * 3);
    this.head = new Int32Array(size);
    this.mask = size - 1;
    if (this.tolerance > 0) {
      const minCos = this.geographic ? Math.max(Math.cos(Math.min(options.maxAbsLat, 89.9) * RAD), 1e-6) : 1;
      const perUnit = this.geographic ? METERS_PER_DEGREE : 1;
      this.cellX = this.tolerance / (perUnit * minCos);
      this.cellY = this.tolerance / perUnit;
    }
  }

  /**
   * A store over existing vertex arrays (a deserialised graph). The arrays are used, not copied, and
   * indexed in vertex order, so every location is owned by the same vertex as in the store that built them.
   */
  static fromArrays(
    options: VertexStoreOptions,
    x: Float64Array,
    y: Float64Array,
    group: Int32Array | null,
    positions: readonly Position[],
  ): VertexStore {
    const store = new VertexStore(options, { x, y, group: group ?? new Int32Array(x.length) });
    for (let id = 0; id < x.length; id++) {
      store.positions.push(positions[id]);
      store.count = id + 1;
      store.index(id);
    }
    return store;
  }

  get size(): number {
    return this.count;
  }

  /** Returns the id of the vertex at (or within tolerance of) `position`, creating it when absent. */
  getOrAdd(position: Position, group = 0): number {
    const px = position[0];
    const py = position[1];
    if (this.tolerance === 0) {
      // One probe: either the owner of the location or the free slot it goes into.
      const slot = this.probe(px, py, group);
      if (this.inUse(slot)) {
        this.merged++;
        this.lastDistance = 0;
        return this.head[slot];
      }
      const id = this.push(px, py, position, group);
      this.claim(slot, px, py, group, id);
      return id;
    }
    const found = this.find(px, py, group);
    if (found !== NONE) {
      this.merged++;
      return found;
    }
    return this.append(px, py, position, group);
  }

  /**
   * Returns the vertex of node id `key` in `group`, whatever its coordinates. A key seen for the first time
   * takes over a vertex without a key at this location (exact, or within tolerance), so that coordinates
   * without ids still meet it, and otherwise starts a new vertex; it never joins a vertex carrying another
   * key, however close. {@link lastDistance} is the gap bridged (for the merge log).
   */
  getOrAddKeyed(position: Position, group: number, key: NodeKey): number {
    const px = position[0];
    const py = position[1];
    const byKey = ((this.ids ??= [])[group] ??= new Map());
    let id = byKey.get(key);
    if (id !== undefined) {
      this.merged++;
      const sx = this.geographic ? METERS_PER_DEGREE * Math.max(Math.cos(py * RAD), 1e-6) : 1;
      const sy = this.geographic ? METERS_PER_DEGREE : 1;
      this.lastDistance = Math.hypot((px - this.x[id]) * sx, (py - this.y[id]) * sy);
      return id;
    }
    id = this.find(px, py, group, true);
    if (id !== NONE) this.merged++;
    else id = this.append(px, py, position, group);
    if (!this.keyed || this.keyed.length <= id)
      this.keyed = resized(this.keyed ?? new Uint8Array(0), this.x.length);
    this.keyed[id] = 1;
    this.keyedCount++;
    byKey.set(key, id);
    return id;
  }

  /**
   * Looks a coordinate up without inserting; `-1` when no vertex of `group` matches. `unkeyed` skips vertices
   * that carry a node id.
   */
  find(px: number, py: number, group = 0, unkeyed = false): number {
    if (group < 0) return NONE;
    const keyed = unkeyed ? this.keyed : null;
    if (this.tolerance === 0) {
      const slot = this.probe(px, py, group);
      // A vertex without a key always owns its location: every later coordinate there joins it.
      if (!this.inUse(slot) || (keyed && keyed[this.head[slot]])) return NONE;
      this.lastDistance = 0;
      return this.head[slot];
    }
    const cx = Math.floor(px / this.cellX);
    const cy = Math.floor(py / this.cellY);
    const sy = this.geographic ? METERS_PER_DEGREE : 1;
    const sx = this.geographic ? METERS_PER_DEGREE * Math.max(Math.cos(py * RAD), 1e-6) : 1;
    const tol2 = this.tolerance * this.tolerance;
    let best = NONE;
    let bestD2 = Infinity;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        const slot = this.probe(gx, gy, group);
        if (!this.inUse(slot)) continue;
        // Candidates are compared by (distance, id), so the order of a cell's list does not matter.
        for (let id = this.head[slot]; id !== NONE; id = this.next[id]) {
          if (keyed && keyed[id]) continue;
          const dx = (px - this.x[id]) * sx;
          const dy = (py - this.y[id]) * sy;
          const d2 = dx * dx + dy * dy;
          if (d2 <= tol2 && (d2 < bestD2 || (d2 === bestD2 && id < best))) {
            best = id;
            bestD2 = d2;
          }
        }
      }
    }
    if (best !== NONE) this.lastDistance = Math.sqrt(bestD2);
    return best;
  }

  /**
   * Adds a vertex unconditionally (split points computed during connectivity repair). A {@link NO_GROUP}
   * vertex is not indexed, so {@link find} never returns it and nothing merges into it.
   */
  append(px: number, py: number, position: Position, group = 0): number {
    const id = this.push(px, py, position, group);
    this.index(id);
    return id;
  }

  /**
   * Cuts the arrays down to {@link size}, so that a finished graph can share them, and drops the node-id
   * index, which only matters while building.
   */
  trim(): void {
    this.ids = null;
    this.keyed = null;
    this.x = resized(this.x, this.count);
    this.y = resized(this.y, this.count);
    this.group = resized(this.group, this.count);
  }

  private push(px: number, py: number, position: Position, group: number): number {
    const id = this.count++;
    if (id === this.x.length) {
      const capacity = Math.max(16, id * 2);
      this.x = resized(this.x, capacity);
      this.y = resized(this.y, capacity);
      this.group = resized(this.group, capacity);
      if (this.tolerance > 0) this.next = resized(this.next, capacity);
    }
    this.x[id] = px;
    this.y[id] = py;
    this.group[id] = group;
    this.positions.push(position);
    return id;
  }

  /** Indexes vertex `id` (already pushed) unless it is group-less or, in exact mode, its location is owned. */
  private index(id: number): void {
    const group = this.group[id];
    if (group < 0) return;
    let a = this.x[id];
    let b = this.y[id];
    if (this.tolerance > 0) {
      a = Math.floor(a / this.cellX);
      b = Math.floor(b / this.cellY);
    }
    const slot = this.probe(a, b, group);
    if (!this.inUse(slot)) this.claim(slot, a, b, group, id);
    else if (this.tolerance > 0) {
      this.next[id] = this.head[slot];
      this.head[slot] = id;
    }
  }

  private inUse(slot: number): boolean {
    return (this.used[slot >>> 5] & (1 << (slot & 31))) !== 0;
  }

  /** The slot holding key `(a, b, group)`, or the free slot where it belongs. */
  private probe(a: number, b: number, group: number): number {
    const keys = this.keys;
    let slot = hash(a, b, group) & this.mask;
    while (
      this.inUse(slot) &&
      !(keys[3 * slot] === a && keys[3 * slot + 1] === b && keys[3 * slot + 2] === group)
    ) {
      slot = (slot + 1) & this.mask;
    }
    return slot;
  }

  /** Takes a free slot for a key, keeping the table at most half full. */
  private claim(slot: number, a: number, b: number, group: number, id: number): void {
    this.used[slot >>> 5] |= 1 << (slot & 31);
    this.keys[3 * slot] = a;
    this.keys[3 * slot + 1] = b;
    this.keys[3 * slot + 2] = group;
    this.head[slot] = id;
    if (this.tolerance > 0) this.next[id] = NONE;
    if (++this.entries * 2 <= this.head.length) return;
    const { used, keys, head } = this;
    const size = head.length * 2;
    this.used = new Int32Array(size >>> 5);
    this.keys = new Float64Array(size * 3);
    this.head = new Int32Array(size);
    this.mask = size - 1;
    for (let s = 0; s < head.length; s++) {
      if (!(used[s >>> 5] & (1 << (s & 31)))) continue;
      const to = this.probe(keys[3 * s], keys[3 * s + 1], keys[3 * s + 2]);
      this.used[to >>> 5] |= 1 << (to & 31);
      this.keys.set(keys.subarray(3 * s, 3 * s + 3), 3 * to);
      this.head[to] = head[s];
    }
  }
}
