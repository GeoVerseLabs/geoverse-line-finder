import type { NetworkCollection, NetworkFeature, Position, WeightFunction, WeightResult } from '../src';

export type Props = Record<string, unknown>;

/** Deterministic PRNG so property tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LineFeature<P> extends NetworkFeature<P> {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: Position[] };
  properties: P;
}

export function line<P = Props>(
  coordinates: Position[],
  properties?: P,
  id?: string | number,
): LineFeature<P> {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'LineString', coordinates },
    properties: (properties ?? {}) as P,
  };
}

export function fc<P>(features: NetworkFeature<P>[]): NetworkCollection<P> {
  return { type: 'FeatureCollection', features };
}

export interface GridProps {
  factor: number;
  oneway: -1 | 0 | 1;
  blocked: boolean;
}

export interface GridOptions {
  keep?: number;
  oneway?: number;
  blocked?: number;
  diagonal?: number;
}

/**
 * Random planar grid (spacing 10). Rows and columns are cut into polylines of 1–4 lattice steps with a
 * jittered shape point in the middle of every step, so there are plenty of degree-2 vertices to compact.
 * Properties carry a cost factor, a one-way flag and an occasional impassable flag.
 */
export function randomGrid(
  rand: () => number,
  n: number,
  options: GridOptions = {},
): NetworkCollection<GridProps> {
  const keep = options.keep ?? 0.85;
  const onewayP = options.oneway ?? 0.15;
  const blockedP = options.blocked ?? 0.03;
  const diagonalP = options.diagonal ?? 0.15;
  const features: LineFeature<GridProps>[] = [];
  const props = (): GridProps => ({
    factor: 0.5 + rand() * 2,
    oneway: rand() < onewayP ? (rand() < 0.5 ? 1 : -1) : 0,
    blocked: rand() < blockedP,
  });
  const jitter = () => Math.round((rand() - 0.5) * 6);
  const run = (point: (i: number) => Position, mid: (i: number) => Position) => {
    let i = 0;
    while (i < n - 1) {
      const end = Math.min(n - 1, i + 1 + Math.floor(rand() * 4));
      if (rand() < keep) {
        const coords: Position[] = [point(i)];
        for (let k = i; k < end; k++) coords.push(mid(k), point(k + 1));
        features.push(line(coords, props()));
      }
      i = end;
    }
  };
  for (let y = 0; y < n; y++) {
    run(
      (i) => [i * 10, y * 10],
      (i) => [i * 10 + 5, y * 10 + jitter()],
    );
  }
  for (let x = 0; x < n; x++) {
    run(
      (i) => [x * 10, i * 10],
      (i) => [x * 10 + jitter(), i * 10 + 5],
    );
  }
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      if (rand() < diagonalP)
        features.push(
          line(
            [
              [x * 10, y * 10],
              [x * 10 + 10, y * 10 + 10],
            ],
            props(),
          ),
        );
    }
  }
  return fc(features);
}

export const gridWeight: WeightFunction<GridProps> = (_a, _b, p, ctx) => {
  if (p.blocked) return 0;
  const cost = ctx.distance * p.factor;
  if (p.oneway === 1) return { forward: cost };
  if (p.oneway === -1) return { backward: cost };
  return cost;
};

export const planarDistance = (a: Position, b: Position): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

const key = (p: Position) => `${p[0]},${p[1]}`;
const toCost = (v: unknown): number => (typeof v === 'number' && v > 0 && v < Infinity ? v : Infinity);

function directedCosts(w: WeightResult): [number, number] {
  if (w && typeof w === 'object') return [toCost(w.forward), toCost(w.backward)];
  const c = toCost(w);
  return [c, c];
}

/**
 * Deliberately naive reference: uncompacted segment graph keyed by exact coordinates, O(V²) Dijkstra.
 * Independent of every data structure in `src/`.
 */
export class ReferenceGraph<P> {
  readonly adjacency = new Map<string, Map<string, number>>();

  constructor(
    network: NetworkCollection<P>,
    weight: WeightFunction<P>,
    distance: (a: Position, b: Position) => number = planarDistance,
  ) {
    network.features.forEach((feature, featureIndex) => {
      const geometry = feature.geometry as { type: string; coordinates: Position[] } | null;
      if (!geometry || geometry.type !== 'LineString') return;
      const coords = geometry.coordinates;
      for (let i = 0; i + 1 < coords.length; i++) {
        const a = coords[i];
        const b = coords[i + 1];
        if (key(a) === key(b)) continue;
        const [fwd, bwd] = directedCosts(
          weight(a, b, feature.properties as P, {
            distance: distance(a, b),
            featureIndex,
            feature,
            fromGroup: undefined,
            toGroup: undefined,
            rise: 0,
          }),
        );
        this.link(a, b, fwd);
        this.link(b, a, bwd);
      }
    });
  }

  private link(a: Position, b: Position, cost: number): void {
    const ka = key(a);
    const kb = key(b);
    if (!this.adjacency.has(ka)) this.adjacency.set(ka, new Map());
    if (!this.adjacency.has(kb)) this.adjacency.set(kb, new Map());
    if (cost === Infinity) return;
    const edges = this.adjacency.get(ka)!;
    edges.set(kb, Math.min(edges.get(kb) ?? Infinity, cost));
  }

  vertices(): Position[] {
    return [...this.adjacency.keys()].map((k) => k.split(',').map(Number));
  }

  edgeCost(a: Position, b: Position): number {
    return this.adjacency.get(key(a))?.get(key(b)) ?? Infinity;
  }

  shortest(start: Position, end: Position): number {
    const s = key(start);
    const t = key(end);
    if (!this.adjacency.has(s) || !this.adjacency.has(t)) return Infinity;
    const dist = new Map<string, number>([[s, 0]]);
    const done = new Set<string>();
    const queue = new MinQueue();
    queue.push(0, s);
    while (queue.size > 0) {
      const [d, k] = queue.pop();
      if (done.has(k)) continue;
      if (k === t) return d;
      done.add(k);
      for (const [nb, c] of this.adjacency.get(k)!) {
        const nd = d + c;
        if (nd < (dist.get(nb) ?? Infinity)) {
          dist.set(nb, nd);
          queue.push(nd, nb);
        }
      }
    }
    return Infinity;
  }
}

/** Plain binary heap, kept separate from `src/heap` so the referee shares no code with the library. */
class MinQueue {
  private items: [number, string][] = [];

  get size(): number {
    return this.items.length;
  }

  push(priority: number, value: string): void {
    const items = this.items;
    items.push([priority, value]);
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (items[p][0] <= items[i][0]) break;
      [items[p], items[i]] = [items[i], items[p]];
      i = p;
    }
  }

  pop(): [number, string] {
    const items = this.items;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && items[l][0] < items[m][0]) m = l;
        if (r < items.length && items[r][0] < items[m][0]) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i], items[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Returns a copy of the network with `point` inserted into the first segment it lies on. */
export function insertVertex<P>(
  network: NetworkCollection<P>,
  point: Position,
  eps = 1e-9,
): NetworkCollection<P> {
  const features = network.features.map((f) => {
    const g = f.geometry as { type: string; coordinates: Position[] };
    return { ...f, geometry: { type: g.type, coordinates: [...g.coordinates] } };
  });
  for (const f of features) {
    const coords = f.geometry.coordinates;
    for (let i = 0; i + 1 < coords.length; i++) {
      const [ax, ay] = coords[i];
      const [bx, by] = coords[i + 1];
      if (key(coords[i]) === key(point) || key(coords[i + 1]) === key(point)) return fc(features);
      const len = Math.hypot(bx - ax, by - ay);
      const cross = (bx - ax) * (point[1] - ay) - (by - ay) * (point[0] - ax);
      const dot = (point[0] - ax) * (bx - ax) + (point[1] - ay) * (by - ay);
      if (Math.abs(cross) <= eps * len * len && dot > 0 && dot < len * len) {
        coords.splice(i + 1, 0, point);
        return fc(features);
      }
    }
  }
  throw new Error(`Point ${key(point)} is not on the network.`);
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
