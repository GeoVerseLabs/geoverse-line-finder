import { resolveMetric, type MetricOption } from '../geo/metric';
import { PackedRTree } from '../spatial/rtree';
import type { NetworkCollection } from '../types';
import {
  distanceWeight,
  normalizeWeight,
  type NormalizedWeight,
  type WeightFunction,
} from '../weight/weight';
import { buildChains } from './chains';
import { RoutingGraph, type GraphStats } from './graph';
import { buildTopology, scanNetwork } from './topology';

export interface GraphOptions<P = unknown> {
  /** Distance measure. Default `'haversine'` (coordinates in degrees, distances in meters). */
  metric?: MetricOption;
  /** Segment cost (geojson-path-finder compatible). Default: segment length. */
  weight?: WeightFunction<P>;
  /**
   * Vertices closer than this (metric units) are merged into one. Default `0`: only identical
   * coordinates connect. geojson-path-finder's default 1e-5° is roughly 1.1 m.
   */
  tolerance?: number;
  /** Connect dead ends to the nearest segment within this distance (metric units). Default `0` (off). */
  snapDangles?: number;
  /** Node segments that cross or touch without a shared vertex. Default `false`. */
  splitIntersections?: boolean;
  /** Collapse degree-2 vertices into chains (faster search, identical results). Default `true`. */
  compact?: boolean;
}

function nonNegative(value: number | undefined, name: string): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !(value >= 0) || value === Infinity) {
    throw new RangeError(`Option "${name}" must be a finite number ≥ 0, got ${String(value)}.`);
  }
  return value;
}

/**
 * Builds the routing graph: topology → connectivity repair → weights → chain compaction → directed CSR →
 * components → heuristic data → spatial index.
 */
export function buildGraph<P>(network: NetworkCollection<P>, options: GraphOptions<P> = {}): RoutingGraph<P> {
  if (!network || typeof network !== 'object' || !Array.isArray(network.features)) {
    throw new TypeError('Expected a GeoJSON FeatureCollection with a "features" array.');
  }
  const tolerance = nonNegative(options.tolerance, 'tolerance');
  const snapDangles = nonNegative(options.snapDangles, 'snapDangles');
  const scan = scanNetwork(network);
  const metric = resolveMetric(options.metric, scan.coordinates > 0 ? (scan.minY + scan.maxY) / 2 : 0);
  const topo = buildTopology(network, metric, {
    tolerance,
    snapDangles,
    splitIntersections: options.splitIntersections === true,
    maxAbsLat: scan.maxAbsLat,
  });

  // --- weights -------------------------------------------------------------------------------------
  const store = topo.store;
  const S = topo.segA.length;
  const segFwd = new Float64Array(S);
  const segBwd = new Float64Array(S);
  const segLen = new Float64Array(S);
  const alive = new Uint8Array(S);
  const weight = options.weight ?? (distanceWeight as WeightFunction<P>);
  const features = network.features;
  const norm: NormalizedWeight = { forward: 0, backward: 0 };
  let impassableSegments = 0;
  let oneWaySegments = 0;
  for (let s = 0; s < S; s++) {
    const pa = store.positions[topo.segA[s]];
    const pb = store.positions[topo.segB[s]];
    const featureIndex = topo.segFeature[s];
    const feature = features[featureIndex];
    const distance = metric.distance(pa, pb);
    const raw = weight(pa, pb, feature.properties as P, { distance, featureIndex, feature });
    normalizeWeight(raw, norm, `feature #${featureIndex}`);
    segFwd[s] = norm.forward;
    segBwd[s] = norm.backward;
    segLen[s] = distance;
    if (norm.forward === Infinity && norm.backward === Infinity) {
      impassableSegments++;
    } else {
      alive[s] = 1;
      if (norm.forward === Infinity || norm.backward === Infinity) oneWaySegments++;
    }
  }

  // --- chains and nodes ----------------------------------------------------------------------------
  const V = store.size;
  const built = buildChains(V, topo.segA, topo.segB, alive, options.compact !== false);
  const vertexNode = new Int32Array(V).fill(-1);
  const nodeVertexList: number[] = [];
  for (let v = 0; v < V; v++) {
    if (built.junction[v]) {
      vertexNode[v] = nodeVertexList.length;
      nodeVertexList.push(v);
    }
  }
  const N = nodeVertexList.length;
  const nodeVertex = Int32Array.from(nodeVertexList);

  const C = built.count;
  const K = built.segRef.length;
  const chainFrom = new Int32Array(C);
  const chainTo = new Int32Array(C);
  const segStart = Int32Array.from(built.segStart);
  const chainVertices = Int32Array.from(built.vertices);
  const chainFwd = new Float64Array(C);
  const chainBwd = new Float64Array(C);
  const chainLen = new Float64Array(C);
  const sChain = new Int32Array(K);
  const sFwd = new Float64Array(K);
  const sBwd = new Float64Array(K);
  const sLen = new Float64Array(K);
  const sFeature = new Int32Array(K);
  const vertexChain = new Int32Array(V).fill(-1);
  const vertexChainPos = new Int32Array(V).fill(-1);

  for (let c = 0; c < C; c++) {
    chainFrom[c] = vertexNode[built.from[c]];
    chainTo[c] = vertexNode[built.to[c]];
    let fw = 0;
    let bw = 0;
    let len = 0;
    for (let k = segStart[c]; k < segStart[c + 1]; k++) {
      const s = built.segRef[k];
      const rev = built.segRev[k];
      const f = rev ? segBwd[s] : segFwd[s];
      const b = rev ? segFwd[s] : segBwd[s];
      sChain[k] = c;
      sFwd[k] = f;
      sBwd[k] = b;
      sLen[k] = segLen[s];
      sFeature[k] = topo.segFeature[s];
      fw += f;
      bw += b;
      len += segLen[s];
    }
    chainFwd[c] = fw;
    chainBwd[c] = bw;
    chainLen[c] = len;
    const base = segStart[c] + c;
    const n = segStart[c + 1] - segStart[c];
    for (let i = 1; i < n; i++) {
      const v = chainVertices[base + i];
      vertexChain[v] = c;
      vertexChainPos[v] = i;
    }
  }

  // --- directed CSR --------------------------------------------------------------------------------
  const offsets = new Int32Array(N + 1);
  for (let c = 0; c < C; c++) {
    if (chainFrom[c] === chainTo[c]) continue; // a loop never shortens a path between two nodes
    if (chainFwd[c] < Infinity) offsets[chainFrom[c] + 1]++;
    if (chainBwd[c] < Infinity) offsets[chainTo[c] + 1]++;
  }
  for (let n = 0; n < N; n++) offsets[n + 1] += offsets[n];
  const M = offsets[N];
  const targets = new Int32Array(M);
  const costs = new Float64Array(M);
  const ref = new Int32Array(M);
  const cursor = offsets.slice(0, N);
  for (let c = 0; c < C; c++) {
    const from = chainFrom[c];
    const to = chainTo[c];
    if (from === to) continue;
    if (chainFwd[c] < Infinity) {
      const e = cursor[from]++;
      targets[e] = to;
      costs[e] = chainFwd[c];
      ref[e] = c << 1;
    }
    if (chainBwd[c] < Infinity) {
      const e = cursor[to]++;
      targets[e] = from;
      costs[e] = chainBwd[c];
      ref[e] = (c << 1) | 1;
    }
  }

  // --- weakly connected components (via passable chains only) ---------------------------------------
  const parent = new Int32Array(N);
  for (let n = 0; n < N; n++) parent[n] = n;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let c = 0; c < C; c++) {
    if (chainFrom[c] === chainTo[c] || (chainFwd[c] === Infinity && chainBwd[c] === Infinity)) continue;
    const ra = find(chainFrom[c]);
    const rb = find(chainTo[c]);
    if (ra !== rb) parent[ra] = rb;
  }
  const nodeComponent = new Int32Array(N);
  const labelOfRoot = new Int32Array(N).fill(-1);
  let componentCount = 0;
  for (let n = 0; n < N; n++) {
    const r = find(n);
    if (labelOfRoot[r] === -1) labelOfRoot[r] = componentCount++;
    nodeComponent[n] = labelOfRoot[r];
  }
  const componentNodes = new Int32Array(componentCount);
  for (let n = 0; n < N; n++) componentNodes[nodeComponent[n]]++;
  const componentLength = new Float64Array(componentCount);
  const chainComponent = new Int32Array(C);
  for (let c = 0; c < C; c++) {
    const comp = nodeComponent[chainFrom[c]];
    chainComponent[c] = comp;
    componentLength[comp] += chainLen[c];
  }
  let largest = -1;
  for (let k = 0; k < componentCount; k++) {
    if (
      largest === -1 ||
      componentLength[k] > componentLength[largest] ||
      (componentLength[k] === componentLength[largest] && componentNodes[k] > componentNodes[largest])
    ) {
      largest = k;
    }
  }

  // --- A* heuristic data ---------------------------------------------------------------------------
  // h(v) = scale · |embed(v) − embed(target)| with scale = min over segments of cost / length is a lower
  // bound on any remaining cost. The tiny deflation absorbs floating point noise and the difference
  // between linear interpolation and the geodesic on partially traversed segments.
  let minRatio = Infinity;
  for (let k = 0; k < K; k++) {
    const len = sLen[k];
    if (!(len > 0)) continue;
    if (sFwd[k] < Infinity && sFwd[k] / len < minRatio) minRatio = sFwd[k] / len;
    if (sBwd[k] < Infinity && sBwd[k] / len < minRatio) minRatio = sBwd[k] / len;
  }
  const dims = metric.embedDims;
  const scale = dims > 0 && minRatio < Infinity ? minRatio * (1 - 1e-6) : 0;
  const embedding = new Float64Array(scale > 0 ? N * dims : 0);
  if (scale > 0) {
    for (let n = 0; n < N; n++) {
      const v = nodeVertex[n];
      metric.embed!(store.x[v], store.y[v], embedding, n * dims);
    }
  }

  // --- spatial index over chain segments -----------------------------------------------------------
  const vx = Float64Array.from(store.x);
  const vy = Float64Array.from(store.y);
  const segmentIndex = new PackedRTree(K);
  for (let k = 0; k < K; k++) {
    const c = sChain[k];
    const a = chainVertices[k + c];
    const b = chainVertices[k + c + 1];
    segmentIndex.add(
      Math.min(vx[a], vx[b]),
      Math.min(vy[a], vy[b]),
      Math.max(vx[a], vx[b]),
      Math.max(vy[a], vy[b]),
    );
  }
  segmentIndex.finish();

  let liveVertices = 0;
  for (let v = 0; v < V; v++) if (vertexNode[v] >= 0 || vertexChain[v] >= 0) liveVertices++;

  const stats: GraphStats = {
    features: features.length,
    lineFeatures: topo.lineFeatures,
    skippedFeatures: topo.skippedFeatures,
    invalidCoordinates: topo.invalidCoordinates,
    coordinates: topo.coordinates,
    vertices: liveVertices,
    mergedVertices: topo.mergedVertices,
    danglesSnapped: topo.danglesSnapped,
    intersectionsSplit: topo.intersectionsSplit,
    segments: S,
    impassableSegments,
    oneWaySegments,
    nodes: N,
    chains: C,
    edges: M,
    components: componentCount,
    largestComponentNodes: largest >= 0 ? componentNodes[largest] : 0,
  };

  return new RoutingGraph<P>({
    metric,
    features,
    stats,
    vertices: {
      count: V,
      x: vx,
      y: vy,
      positions: store.positions,
      node: vertexNode,
      chain: vertexChain,
      chainPos: vertexChainPos,
    },
    nodes: { count: N, vertex: nodeVertex, component: nodeComponent, embedding },
    chains: {
      count: C,
      from: chainFrom,
      to: chainTo,
      segStart,
      vertices: chainVertices,
      forward: chainFwd,
      backward: chainBwd,
      length: chainLen,
      component: chainComponent,
    },
    segments: { count: K, chain: sChain, forward: sFwd, backward: sBwd, length: sLen, feature: sFeature },
    edges: { count: M, offsets, targets, costs, ref },
    components: { count: componentCount, nodes: componentNodes, length: componentLength, largest },
    heuristic: { dims: scale > 0 ? dims : 0, scale },
    segmentIndex,
    store,
    remap: topo.remap,
  });
}
