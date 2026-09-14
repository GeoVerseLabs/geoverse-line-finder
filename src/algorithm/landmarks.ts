import type { RoutingGraph } from '../graph/graph';
import { FourAryHeap } from '../heap/four-ary-heap';
import { partialCost } from '../route/assemble';
import type { Anchor } from '../snap/snap';
import type { Heuristic } from './types';

export type LandmarkStrategy = 'farthest' | 'planar';

export interface LandmarkOptions {
  /** Landmarks to place (1–64). Default 8. */
  count?: number;
  /**
   * `'farthest'` (default): each next landmark maximises the round-trip distance to the ones already chosen.
   * `'planar'`: the farthest node from the centre in each of `count` angular sectors. Or explicit node ids.
   */
  strategy?: LandmarkStrategy | readonly number[];
  /** Landmarks used per query, chosen by their bound at the query's origins. Default 4. */
  active?: number;
}

export const LANDMARK_FORMAT = 'geoverse-line-finder/landmarks';

export interface TransferableLandmarks {
  format: typeof LANDMARK_FORMAT;
  formatVersion: number;
  count: number;
  nodeCount: number;
  edgeCount: number;
  active: number;
  buffers: [nodes: ArrayBufferLike, fromLandmark: ArrayBufferLike, toLandmark: ArrayBufferLike];
}

/**
 * Exact network distances to and from a few landmark nodes (ALT, "A*, landmarks, triangle inequality"). For
 * a directed graph both directions are needed: `d(v,t) ≥ d(L,t) − d(L,v)` and `d(v,t) ≥ d(v,L) − d(t,L)`.
 * Tied to one graph and one weighting; build a new table when either changes.
 */
export class LandmarkTable {
  readonly count: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly active: number;
  /** Landmark node ids. */
  readonly nodes: Int32Array;
  /** `d(L, v)` at `[L · nodeCount + v]` (`Infinity` when unreachable). */
  readonly fromLandmark: Float64Array;
  /** `d(v, L)` at `[L · nodeCount + v]`. */
  readonly toLandmark: Float64Array;

  constructor(parts: {
    nodeCount: number;
    edgeCount: number;
    active: number;
    nodes: Int32Array;
    fromLandmark: Float64Array;
    toLandmark: Float64Array;
  }) {
    this.count = parts.nodes.length;
    this.nodeCount = parts.nodeCount;
    this.edgeCount = parts.edgeCount;
    this.active = Math.max(1, Math.min(parts.active, this.count || 1));
    this.nodes = parts.nodes;
    this.fromLandmark = parts.fromLandmark;
    this.toLandmark = parts.toLandmark;
  }

  /** Whether the table was built for a graph of this shape. */
  matches(graph: RoutingGraph<unknown>): boolean {
    return graph.nodes.count === this.nodeCount && graph.edges.count === this.edgeCount;
  }

  toTransferable(): TransferableLandmarks {
    const copy = (a: Int32Array | Float64Array) => a.slice().buffer;
    return {
      format: LANDMARK_FORMAT,
      formatVersion: 1,
      count: this.count,
      nodeCount: this.nodeCount,
      edgeCount: this.edgeCount,
      active: this.active,
      buffers: [copy(this.nodes), copy(this.fromLandmark), copy(this.toLandmark)],
    };
  }

  static fromTransferable(data: TransferableLandmarks): LandmarkTable {
    if (!data || data.format !== LANDMARK_FORMAT) throw new TypeError('Not a serialised landmark table.');
    if (data.formatVersion !== 1)
      throw new RangeError(`Unsupported landmark format version ${String(data.formatVersion)}.`);
    const size = data.count * data.nodeCount;
    const [nodes, from, to] = data.buffers;
    if (nodes.byteLength !== data.count * 4 || from.byteLength !== size * 8 || to.byteLength !== size * 8) {
      throw new RangeError('Serialised landmark buffers have unexpected sizes.');
    }
    return new LandmarkTable({
      nodeCount: data.nodeCount,
      edgeCount: data.edgeCount,
      active: data.active,
      nodes: new Int32Array(nodes as ArrayBuffer),
      fromLandmark: new Float64Array(from as ArrayBuffer),
      toLandmark: new Float64Array(to as ArrayBuffer),
    });
  }
}

/** Single-source shortest distances over a CSR adjacency into `out[base + v]` (pre-filled with Infinity). */
function distancesFrom(
  count: number,
  offsets: Int32Array,
  adjacent: Int32Array,
  costs: Float64Array,
  source: number,
  out: Float64Array,
  base: number,
  heap: FourAryHeap,
): void {
  const done = new Uint8Array(count);
  out[base + source] = 0;
  heap.clear();
  heap.insert(0, source);
  while (heap.size() > 0) {
    const u = heap.extractMin();
    if (done[u]) continue;
    done[u] = 1;
    const du = out[base + u];
    for (let e = offsets[u]; e < offsets[u + 1]; e++) {
      const v = adjacent[e];
      const d = du + costs[e];
      if (d < out[base + v]) {
        out[base + v] = d;
        heap.insert(d, v);
      }
    }
  }
}

/** Computes a {@link LandmarkTable}: two full searches per landmark, placed in the largest component. */
export function prepareLandmarks(graph: RoutingGraph<unknown>, options: LandmarkOptions = {}): LandmarkTable {
  const N = graph.nodes.count;
  const requested = options.count ?? 8;
  if (!Number.isInteger(requested) || requested < 1 || requested > 64) {
    throw new RangeError(`landmarks.count must be an integer from 1 to 64, got ${String(requested)}.`);
  }
  const active = options.active ?? 4;
  if (!Number.isInteger(active) || active < 1)
    throw new RangeError(`landmarks.active must be a positive integer, got ${String(active)}.`);
  const { offsets, targets, costs } = graph.edges;
  const reverse = graph.reverseEdges();
  const heap = new FourAryHeap();
  const inLargest = (n: number) => graph.nodes.component[n] === graph.components.largest;
  const pool: number[] = [];
  for (let n = 0; n < N; n++) if (inLargest(n)) pool.push(n);

  const chosen: number[] = [];
  const forward: Float64Array[] = [];
  const backward: Float64Array[] = [];
  const measure = (node: number) => {
    const f = new Float64Array(N).fill(Infinity);
    const b = new Float64Array(N).fill(Infinity);
    distancesFrom(N, offsets, targets, costs, node, f, 0, heap);
    distancesFrom(N, reverse.offsets, reverse.sources, reverse.costs, node, b, 0, heap);
    return { f, b };
  };
  const add = (node: number, f?: Float64Array, b?: Float64Array) => {
    if (chosen.includes(node)) return;
    const d = f && b ? { f, b } : measure(node);
    chosen.push(node);
    forward.push(d.f);
    backward.push(d.b);
  };

  const strategy = options.strategy ?? 'farthest';
  if (Array.isArray(strategy)) {
    for (const node of strategy) {
      if (!Number.isInteger(node) || node < 0 || node >= N)
        throw new RangeError(`Landmark node ${String(node)} does not exist.`);
      add(node);
    }
  } else if (strategy === 'planar') {
    if (pool.length > 0) {
      const { x, y } = graph.vertices;
      let cx = 0;
      let cy = 0;
      for (const n of pool) {
        cx += x[graph.nodes.vertex[n]];
        cy += y[graph.nodes.vertex[n]];
      }
      cx /= pool.length;
      cy /= pool.length;
      const sx = graph.metric.geographic ? Math.cos((cy * Math.PI) / 180) : 1;
      const best = new Int32Array(requested).fill(-1);
      const far = new Float64Array(requested).fill(-1);
      for (const n of pool) {
        const dx = (x[graph.nodes.vertex[n]] - cx) * sx;
        const dy = y[graph.nodes.vertex[n]] - cy;
        const sector = Math.min(
          requested - 1,
          Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * requested),
        );
        const d = dx * dx + dy * dy;
        if (d > far[sector]) {
          far[sector] = d;
          best[sector] = n;
        }
      }
      for (const n of best) if (n >= 0) add(n);
    }
  } else if (strategy === 'farthest') {
    if (pool.length > 0) {
      const start = measure(pool[0]);
      const round = new Float64Array(N).fill(Infinity);
      const pick = (score: (n: number) => number) => {
        let node = -1;
        let top = -1;
        for (const n of pool) {
          if (chosen.includes(n)) continue;
          const s = score(n);
          if (s > top) {
            top = s;
            node = n;
          }
        }
        return node;
      };
      const finite = (a: number, b: number) =>
        a < Infinity && b < Infinity ? a + b : a < Infinity ? a : b < Infinity ? b : 0;
      let next = pick((n) => finite(start.f[n], start.b[n]));
      while (next >= 0 && chosen.length < requested) {
        const d = measure(next);
        add(next, d.f, d.b);
        for (const n of pool) round[n] = Math.min(round[n], finite(d.f[n], d.b[n]));
        next = pick((n) => round[n]);
      }
    }
  } else {
    throw new RangeError(`Unknown landmark strategy ${String(strategy)}.`);
  }

  const K = chosen.length;
  const fromLandmark = new Float64Array(K * N);
  const toLandmark = new Float64Array(K * N);
  for (let k = 0; k < K; k++) {
    fromLandmark.set(forward[k], k * N);
    toLandmark.set(backward[k], k * N);
  }
  return new LandmarkTable({
    nodeCount: N,
    edgeCount: graph.edges.count,
    active,
    nodes: Int32Array.from(chosen),
    fromLandmark,
    toLandmark,
  });
}

const SHRINK = 1 - 1e-9;

/**
 * ALT bound to the nearest goal, combined (max) with a geometric bound. Goals and origins are snapped anchors:
 * a goal inside a chain is reached only through the chain's ends, so its landmark distances are exact.
 * Returns `Infinity` for nodes that provably cannot reach any goal.
 */
export function landmarkHeuristic(
  graph: RoutingGraph<unknown>,
  table: LandmarkTable,
  goals: readonly { anchor: Anchor }[],
  origins: readonly { anchor: Anchor }[],
  geometric: Heuristic | null,
): Heuristic {
  const N = table.nodeCount;
  const K = table.count;
  const F = table.fromLandmark;
  const B = table.toLandmark;
  const T = goals.length;
  const toGoal = new Float64Array(T * K); // d(L, goal)
  const fromGoal = new Float64Array(T * K); // d(goal, L)
  for (let t = 0; t < T; t++) {
    const anchor = goals[t].anchor;
    if (anchor.kind === 'node') {
      for (let L = 0; L < K; L++) {
        toGoal[t * K + L] = F[L * N + anchor.node];
        fromGoal[t * K + L] = B[L * N + anchor.node];
      }
      continue;
    }
    const { chain, position } = anchor;
    const n = graph.segmentCountOf(chain);
    const a = graph.chains.from[chain];
    const b = graph.chains.to[chain];
    const inFromA = partialCost(graph, chain, 0, position);
    const inFromB = partialCost(graph, chain, n, position);
    const outToA = partialCost(graph, chain, position, 0);
    const outToB = partialCost(graph, chain, position, n);
    for (let L = 0; L < K; L++) {
      toGoal[t * K + L] = Math.min(F[L * N + a] + inFromA, F[L * N + b] + inFromB);
      fromGoal[t * K + L] = Math.min(outToA + B[L * N + a], outToB + B[L * N + b]);
    }
  }

  const bound = (v: number, L: number, t: number): number => {
    const o = L * N + v;
    const g = t * K + L;
    let h = 0;
    if (fromGoal[g] < Infinity && B[o] < Infinity) h = Math.max(h, B[o] - fromGoal[g]);
    if (toGoal[g] < Infinity && F[o] < Infinity) h = Math.max(h, toGoal[g] - F[o]);
    return h;
  };

  let active = Array.from({ length: K }, (_v, L) => L);
  if (table.active < K && origins.length > 0) {
    const nodes: number[] = [];
    for (const { anchor } of origins) {
      if (anchor.kind === 'node') nodes.push(anchor.node);
      else nodes.push(graph.chains.from[anchor.chain], graph.chains.to[anchor.chain]);
    }
    const score = active.map((L) => {
      let s = 0;
      for (const u of nodes) for (let t = 0; t < T; t++) s = Math.max(s, bound(u, L, t));
      return s;
    });
    active = active.sort((p, q) => score[q] - score[p] || p - q).slice(0, table.active);
  }
  const act = Int32Array.from(active);
  const A = act.length;

  return (v) => {
    if (v >= N) return 0;
    let best = Infinity;
    for (let t = 0; t < T; t++) {
      let h = 0;
      for (let i = 0; i < A; i++) {
        const L = act[i];
        const o = L * N + v;
        const g = t * K + L;
        const tl = fromGoal[g];
        if (tl < Infinity) {
          const vl = B[o];
          if (vl === Infinity) {
            h = Infinity; // v cannot reach L, but the goal can: v cannot reach the goal
            break;
          }
          if (vl - tl > h) h = vl - tl;
        }
        const lt = toGoal[g];
        const lv = F[o];
        if (lt < Infinity && lv < Infinity && lt - lv > h) h = lt - lv;
      }
      if (h < best) best = h;
    }
    if (best === Infinity) return Infinity;
    best *= SHRINK;
    const geo = geometric ? geometric(v) : 0;
    return geo > best ? geo : best;
  };
}
