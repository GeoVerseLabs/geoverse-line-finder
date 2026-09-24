import { resolveMetric, type MetricOption } from '../geo/metric';
import { PackedRTree } from '../spatial/rtree';
import type { NetworkCollection, NetworkFeature, Position } from '../types';
import {
  distanceWeight,
  normalizeWeight,
  type NormalizedWeight,
  type WeightFunction,
  type ZeroWeight,
} from '../weight/weight';
import { buildChains } from './chains';
import { RoutingGraph, type GraphStats } from './graph';
import {
  resolveLevels,
  type ConnectorDirection,
  type LevelInfo,
  type LevelTable,
  type LevelsOption,
  type VerticalConnector,
} from './levels';
import {
  buildTopology,
  scanNetwork,
  type GroupFunction,
  type GroupKey,
  type SyntheticSegment,
} from './topology';

export interface GraphOptions<P = unknown> {
  /** Distance measure. Default `'haversine'` (coordinates in degrees, distances in meters). */
  metric?: MetricOption;
  /** Segment cost (geojson-path-finder compatible). Default: segment length. */
  weight?: WeightFunction<P>;
  /**
   * Vertices closer than this (metric units) are merged into one. Default `0`: only identical
   * coordinates connect. geojson-path-finder's default 1e-5 deg is roughly 1.1 m.
   */
  tolerance?: number;
  /** Connect dead ends to the nearest segment within this distance (metric units). Default `0` (off). */
  snapDangles?: number;
  /** Node segments that cross or touch without a shared vertex. Default `false`. */
  splitIntersections?: boolean;
  /** Collapse degree-2 vertices into chains (faster search, identical results). Default `true`. */
  compact?: boolean;
  /**
   * Connectivity groups for non-planar networks (floors, bridges over roads): vertices, repairs and
   * snapping never join different groups; connector features (`[startGroup, endGroup]`) link them.
   */
  group?: GroupFunction<P>;
  /**
   * What each group is vertically (storey number, height, display name). It switches on the level-aware
   * A* bound, `WeightContext.rise` and the level fields of a route; without it `group` only means
   * connectivity. See {@link LevelsOption}.
   */
  levels?: LevelsOption;
  /**
   * Lift shafts, staircases and escalators declared by their stops instead of digitised: every pair of
   * stops becomes one connection, so a boarding cost is charged once per ride instead of once per floor.
   * `perLevelCost` and `direction` need `levels`.
   */
  verticalConnectors?: readonly VerticalConnector<P>[];
  /** What a weight of `0` means. Default `'impassable'` (geojson-path-finder contract); `'free'` for connectors. */
  zeroWeight?: ZeroWeight;
  /** Record repairs and invalid coordinates so that `graph.diagnostics()` can locate them. Default `false`. */
  diagnostics?: boolean;
}

/** Build settings kept on the graph (for diagnostics, serialisation and snapping). */
export interface GraphSettings {
  readonly tolerance: number;
  readonly snapDangles: number;
  readonly splitIntersections: boolean;
  readonly compact: boolean;
  readonly zeroWeight: ZeroWeight;
  readonly maxAbsLat: number;
}

function nonNegative(value: number | undefined, name: string): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !(value >= 0) || value === Infinity) {
    throw new RangeError(`Option "${name}" must be a finite number >= 0, got ${String(value)}.`);
  }
  return value;
}

/** Turns the `levels` option into one lookup by group key. */
export function levelLookup(
  option: LevelsOption,
): (key: GroupKey | undefined) => LevelInfo | null | undefined {
  if (typeof option === 'function') return option;
  if (option === null || typeof option !== 'object') {
    throw new TypeError('Option "levels" must be a record of LevelInfo or a function.');
  }
  return (key) => (key === undefined ? undefined : option[String(key)]);
}

function rideCost(
  direction: ConnectorDirection,
  rising: boolean,
  boardCost: number,
  perLevelCost: number,
  levelsCrossed: number,
): number {
  if (direction === 'up' && !rising) return Infinity;
  if (direction === 'down' && rising) return Infinity;
  return boardCost + perLevelCost * levelsCrossed;
}

interface ResolvedConnectors<P> {
  features: NetworkFeature<P>[];
  segments: SyntheticSegment[];
}

/**
 * Expands every {@link VerticalConnector} into one connection per pair of stops ("all stops connected"):
 * a ride between two floors is a single section whose cost counts the boarding once, however many floors
 * lie between them. Floor-by-floor connector features charge it once per hop instead.
 */
function resolveVerticalConnectors<P>(
  connectors: readonly VerticalConnector<P>[],
  featureOffset: number,
  levels: ((key: GroupKey | undefined) => LevelInfo | null | undefined) | null,
): ResolvedConnectors<P> {
  const features: NetworkFeature<P>[] = [];
  const segments: SyntheticSegment[] = [];
  connectors.forEach((connector, ci) => {
    const where = `verticalConnectors[${ci}]`;
    if (!connector || typeof connector !== 'object' || !Array.isArray(connector.stops)) {
      throw new TypeError(`${where} must be an object with a "stops" array.`);
    }
    const stops = connector.stops;
    if (stops.length < 2) throw new RangeError(`${where} needs at least two stops.`);
    const direction = connector.direction ?? 'both';
    if (direction !== 'both' && direction !== 'up' && direction !== 'down') {
      throw new RangeError(`${where}.direction must be "both", "up" or "down", got ${String(direction)}.`);
    }
    const boardCost = connector.boardCost ?? 0;
    const perLevelCost = connector.perLevelCost ?? 0;
    for (const [name, value] of [
      ['boardCost', boardCost],
      ['perLevelCost', perLevelCost],
    ] as const) {
      if (typeof value !== 'number' || !(value >= 0) || value === Infinity) {
        throw new RangeError(`${where}.${name} must be a finite number >= 0, got ${String(value)}.`);
      }
    }
    const ordinals = stops.map((stop, si) => {
      if (!stop || typeof stop !== 'object' || !Array.isArray(stop.position)) {
        throw new TypeError(`${where}.stops[${si}] must be { group, position }.`);
      }
      if (typeof stop.group !== 'string' && typeof stop.group !== 'number') {
        throw new TypeError(`${where}.stops[${si}].group must be a string or number.`);
      }
      const info = levels ? levels(stop.group) : null;
      const ordinal = info ? info.ordinal : NaN;
      if (!Number.isFinite(ordinal) && (perLevelCost > 0 || direction !== 'both')) {
        throw new RangeError(
          `${where}.stops[${si}] is in group ${String(stop.group)}, which has no level ordinal; ` +
            'perLevelCost and a direction restriction need one (set the "levels" option).',
        );
      }
      return ordinal;
    });
    const coordinates: Position[][] = [];
    const featureIndex = featureOffset + ci;
    for (let i = 0; i < stops.length; i++) {
      for (let j = i + 1; j < stops.length; j++) {
        if (stops[i].group === stops[j].group) continue; // one stop per level; a self-link is not a ride
        const span = Math.abs(ordinals[j] - ordinals[i]);
        const crossed = Number.isFinite(span) ? span : 0;
        const rising = ordinals[j] > ordinals[i];
        const forward = rideCost(direction, rising, boardCost, perLevelCost, crossed);
        const backward = rideCost(direction, !rising, boardCost, perLevelCost, crossed);
        if (forward === Infinity && backward === Infinity) continue;
        segments.push({
          featureIndex,
          part: coordinates.length,
          from: stops[i].position,
          fromGroup: stops[i].group,
          to: stops[j].position,
          toGroup: stops[j].group,
          forward,
          backward,
        });
        coordinates.push([stops[i].position, stops[j].position]);
      }
    }
    features.push({
      type: 'Feature',
      id: connector.id,
      geometry: { type: 'MultiLineString', coordinates },
      properties: (connector.properties !== undefined
        ? connector.properties
        : { kind: connector.kind ?? 'connector' }) as P,
    });
  });
  return { features, segments };
}

/**
 * Builds the routing graph: topology -> connectivity repair -> weights -> chain compaction -> directed CSR ->
 * components -> heuristic data -> spatial index.
 */
export function buildGraph<P>(network: NetworkCollection<P>, options: GraphOptions<P> = {}): RoutingGraph<P> {
  if (!network || typeof network !== 'object' || !Array.isArray(network.features)) {
    throw new TypeError('Expected a GeoJSON FeatureCollection with a "features" array.');
  }
  const tolerance = nonNegative(options.tolerance, 'tolerance');
  const snapDangles = nonNegative(options.snapDangles, 'snapDangles');
  const zeroWeight = options.zeroWeight ?? 'impassable';
  if (zeroWeight !== 'impassable' && zeroWeight !== 'free') {
    throw new RangeError(`Option "zeroWeight" must be "impassable" or "free", got ${String(zeroWeight)}.`);
  }
  if (options.group !== undefined && typeof options.group !== 'function') {
    throw new TypeError('Option "group" must be a function.');
  }
  const lookup = options.levels !== undefined ? levelLookup(options.levels) : null;

  const scan = scanNetwork(network);
  let minX = scan.minX;
  let minY = scan.minY;
  let maxX = scan.maxX;
  let maxY = scan.maxY;
  let resolved: ResolvedConnectors<P> | null = null;
  if (options.verticalConnectors !== undefined) {
    if (!Array.isArray(options.verticalConnectors)) {
      throw new TypeError('Option "verticalConnectors" must be an array.');
    }
    resolved = resolveVerticalConnectors(options.verticalConnectors, network.features.length, lookup);
    // Stops take part in the bounding box: they size the merge grid and the reference latitude.
    for (const link of resolved.segments) {
      for (const p of [link.from, link.to]) {
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
      }
    }
  }
  const known = scan.coordinates > 0 || (resolved !== null && resolved.segments.length > 0);
  const referenceLat = known ? (minY + maxY) / 2 : 0;
  const maxAbsLat = known ? Math.max(Math.abs(minY), Math.abs(maxY)) : 0;
  const metric = resolveMetric(options.metric, referenceLat);
  if (metric.geographic && known && (minX < -180 || maxX > 180 || minY < -90 || maxY > 90)) {
    throw new RangeError(
      `Coordinates span [${minX}, ${maxX}] x [${minY}, ${maxY}], outside the ` +
        `[-180, 180] x [-90, 90] range of the geographic metric "${metric.name}". Projected coordinates ` +
        'need metric: "euclidean".',
    );
  }
  const topo = buildTopology(network, metric, {
    tolerance,
    snapDangles,
    splitIntersections: options.splitIntersections === true,
    maxAbsLat,
    group: options.group as GroupFunction<unknown> | undefined,
    recordDiagnostics: options.diagnostics === true,
    synthetic: resolved ? resolved.segments : undefined,
  });

  const features: readonly NetworkFeature<P>[] = resolved
    ? [...network.features, ...resolved.features]
    : network.features;
  const rawLevels = lookup ? resolveLevels(topo.groupKeys, lookup) : null;

  // --- segment geometry and measures ---------------------------------------------------------------
  const store = topo.store;
  const S = topo.segA.length;
  const segFwd = new Float64Array(S);
  const segBwd = new Float64Array(S);
  const segLen = new Float64Array(S);
  const alive = new Uint8Array(S);
  // Measures accumulate the segment lengths along each feature part (topology keeps segments in that order),
  // so they add up exactly to route distances, merges and splits included.
  const segMeasureA = new Float64Array(S);
  const segMeasureB = new Float64Array(S);
  let measure = 0;
  let measureFeature = -1;
  let measurePart = -1;
  for (let s = 0; s < S; s++) {
    const distance = metric.distance(store.positions[topo.segA[s]], store.positions[topo.segB[s]]);
    if (topo.segFeature[s] !== measureFeature || topo.segPart[s] !== measurePart) {
      measure = 0;
      measureFeature = topo.segFeature[s];
      measurePart = topo.segPart[s];
    }
    segMeasureA[s] = measure;
    measure += distance;
    segMeasureB[s] = measure;
    segLen[s] = distance;
  }

  // --- part runs -----------------------------------------------------------------------------------
  // A run is a maximal stretch of consecutive segments of one feature part that really share vertices end
  // to end (an invalid coordinate breaks a part into several runs). Connector runs - those whose two ends
  // sit in different groups - are the unit the level bound is derived from, and the stretch along which
  // the elevation of group-less interior vertices is interpolated. Deriving the bound per chain instead
  // would be wrong: chain compaction merges a connector with the corridors it meets.
  const runStart: number[] = [];
  if (rawLevels) {
    for (let s = 0; s < S; s++) {
      if (
        s === 0 ||
        topo.segFeature[s] !== topo.segFeature[s - 1] ||
        topo.segPart[s] !== topo.segPart[s - 1] ||
        topo.segA[s] !== topo.segB[s - 1]
      ) {
        runStart.push(s);
      }
    }
    runStart.push(S);
  }

  // --- elevation per vertex ------------------------------------------------------------------------
  const V = store.size;
  let vertexElevation: Float64Array | null = null;
  if (rawLevels && rawLevels.hasElevation) {
    vertexElevation = new Float64Array(V).fill(NaN);
    for (let v = 0; v < V; v++) {
      const g = store.group[v];
      if (g >= 0) vertexElevation[v] = rawLevels.elevation[g];
    }
    for (let r = 0; r + 1 < runStart.length; r++) {
      const s0 = runStart[r];
      const s1 = runStart[r + 1];
      const a = topo.segA[s0];
      const b = topo.segB[s1 - 1];
      const ea = vertexElevation[a];
      const eb = vertexElevation[b];
      if (!Number.isFinite(ea) || !Number.isFinite(eb) || ea === eb) {
        // Nothing to interpolate between; a flat run leaves its interior at the group elevation anyway.
        if (Number.isFinite(ea) && ea === eb) {
          for (let s = s0; s < s1 - 1; s++) {
            const v = topo.segB[s];
            if (Number.isNaN(vertexElevation[v])) vertexElevation[v] = ea;
          }
        }
        continue;
      }
      let total = 0;
      for (let s = s0; s < s1; s++) total += segLen[s];
      let along = 0;
      for (let s = s0; s < s1 - 1; s++) {
        along += segLen[s];
        const v = topo.segB[s];
        if (Number.isNaN(vertexElevation[v])) {
          vertexElevation[v] = total > 0 ? ea + ((eb - ea) * along) / total : ea;
        }
      }
    }
  }

  // --- weights -------------------------------------------------------------------------------------
  const weight = options.weight ?? (distanceWeight as WeightFunction<P>);
  const zeroIsFree = zeroWeight === 'free';
  const norm: NormalizedWeight = { forward: 0, backward: 0 };
  const grouped = topo.groupKeys.length > 1;
  const groupKeyOf = (vertex: number): GroupKey | undefined => {
    if (!grouped) return undefined;
    const g = store.group[vertex];
    return g >= 0 ? topo.groupKeys[g] : undefined;
  };
  const synthetic = resolved ? resolved.segments : null;
  let impassableSegments = 0;
  let oneWaySegments = 0;
  for (let s = 0; s < S; s++) {
    const link = synthetic && topo.segSynthetic[s] >= 0 ? synthetic[topo.segSynthetic[s]] : null;
    if (link) {
      // Vertical connectors carry their own budgeted cost; the weight function never sees them.
      norm.forward = link.forward;
      norm.backward = link.backward;
    } else {
      const a = topo.segA[s];
      const b = topo.segB[s];
      const pa = store.positions[a];
      const pb = store.positions[b];
      const featureIndex = topo.segFeature[s];
      const feature = features[featureIndex];
      const rise = vertexElevation ? vertexElevation[b] - vertexElevation[a] : 0;
      const raw = weight(pa, pb, feature.properties as P, {
        distance: segLen[s],
        featureIndex,
        feature,
        fromGroup: groupKeyOf(a),
        toGroup: groupKeyOf(b),
        rise: Number.isFinite(rise) ? rise : 0,
      });
      normalizeWeight(raw, norm, `feature #${featureIndex}`, zeroIsFree);
    }
    segFwd[s] = norm.forward;
    segBwd[s] = norm.backward;
    if (norm.forward === Infinity && norm.backward === Infinity) {
      impassableSegments++;
    } else {
      alive[s] = 1;
      if (norm.forward === Infinity || norm.backward === Infinity) oneWaySegments++;
    }
  }

  // --- level table ---------------------------------------------------------------------------------
  // A group that carries live vertices but no ordinal would make a level change look free, so it switches
  // the level term of the heuristic off for the whole graph (see `heuristic.perLevel`).
  let levels: LevelTable | null = null;
  if (rawLevels) {
    const live = new Uint8Array(topo.groupKeys.length);
    for (let s = 0; s < S; s++) {
      if (!alive[s]) continue;
      const ga = store.group[topo.segA[s]];
      const gb = store.group[topo.segB[s]];
      if (ga >= 0) live[ga] = 1;
      if (gb >= 0) live[gb] = 1;
    }
    const missing: number[] = [];
    for (let g = 0; g < live.length; g++) {
      if (live[g] && Number.isNaN(rawLevels.ordinal[g])) missing.push(g);
    }
    levels = { ...rawLevels, missing };
  }

  // --- chains and nodes ----------------------------------------------------------------------------
  const compact = options.compact !== false;
  const built = buildChains(V, topo.segA, topo.segB, alive, compact);
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
  const sMeasureStart = new Float64Array(K);
  const sMeasureEnd = new Float64Array(K);
  const sPart = new Int32Array(K);
  const sReversed = new Uint8Array(K);
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
      sMeasureStart[k] = rev ? segMeasureB[s] : segMeasureA[s];
      sMeasureEnd[k] = rev ? segMeasureA[s] : segMeasureB[s];
      sPart[k] = topo.segPart[s];
      sReversed[k] = rev;
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
  // h(v) = scale * |embed(v) - embed(target)| with scale = min over segments of cost / length is a lower
  // bound on any remaining cost. The tiny deflation absorbs floating point noise and the difference
  // between linear interpolation and the geodesic on partially traversed segments. A free (zero-cost)
  // segment of positive length makes the scale 0, which disables the heuristic.
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

  // Cheapest way to cross one level, over every connector run and every direction it can be taken:
  //   perLevel = min over runs of (cost - scale * |embed(a) - embed(b)|) / |ordinal(b) - ordinal(a)|.
  // Every path from u to a target splits into same-level stretches (cost >= scale * |de|) and whole
  // connector runs (cost >= scale * |de| + perLevel * |dOrdinal|), so
  // h(u) = scale * |embed(u) - embed(t)| + perLevel * distance(ordinal(u), target level range)
  // stays a lower bound. A single unknown ordinal anywhere would break that, hence `levels.missing`.
  let perLevel = 0;
  if (levels && levels.missing.length === 0 && dims > 0) {
    const ea = new Float64Array(dims);
    const eb = new Float64Array(dims);
    let best = Infinity;
    for (let r = 0; r + 1 < runStart.length; r++) {
      const s0 = runStart[r];
      const s1 = runStart[r + 1];
      const a = topo.segA[s0];
      const b = topo.segB[s1 - 1];
      const ga = store.group[a];
      const gb = store.group[b];
      if (ga < 0 || gb < 0) continue;
      const span = Math.abs(levels.ordinal[gb] - levels.ordinal[ga]);
      if (!(span > 0)) continue;
      let fwd = 0;
      let bwd = 0;
      for (let s = s0; s < s1; s++) {
        fwd += segFwd[s];
        bwd += segBwd[s];
      }
      metric.embed!(store.x[a], store.y[a], ea, 0);
      metric.embed!(store.x[b], store.y[b], eb, 0);
      let sum = 0;
      for (let d = 0; d < dims; d++) sum += (ea[d] - eb[d]) * (ea[d] - eb[d]);
      const geometric = scale * Math.sqrt(sum);
      for (const cost of [fwd, bwd]) {
        if (cost === Infinity) continue;
        const per = (cost - geometric) / span;
        if (per < best) best = per;
      }
    }
    if (best < Infinity) perLevel = Math.max(0, best * (1 - 1e-6));
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
    groups: topo.groupKeys.length,
    verticalConnectors: resolved ? resolved.features.length : 0,
  };

  return new RoutingGraph<P>({
    metric,
    referenceLat,
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
      group: grouped ? Int32Array.from(store.group) : null,
      elevation: vertexElevation,
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
    segments: {
      count: K,
      chain: sChain,
      forward: sFwd,
      backward: sBwd,
      length: sLen,
      feature: sFeature,
      measureStart: sMeasureStart,
      measureEnd: sMeasureEnd,
      part: sPart,
      reversed: sReversed,
    },
    edges: { count: M, offsets, targets, costs, ref },
    components: { count: componentCount, nodes: componentNodes, length: componentLength, largest },
    heuristic: { dims: scale > 0 ? dims : 0, scale, perLevel },
    segmentIndex,
    store,
    remap: topo.remap,
    groupKeys: topo.groupKeys,
    levels,
    syntheticFeatures: resolved ? resolved.features.length : 0,
    settings: {
      tolerance,
      snapDangles,
      splitIntersections: options.splitIntersections === true,
      compact,
      zeroWeight,
      maxAbsLat,
    },
    diagnosticsLog:
      topo.repairs && topo.invalid ? { repairs: topo.repairs, invalid: Int32Array.from(topo.invalid) } : null,
  });
}
