import { resolveMetric, type Metric } from '../geo/metric';
import { PackedRTree } from '../spatial/rtree';
import type { NetworkFeature, Position } from '../types';
import type { GraphSettings } from './build';
import { RoutingGraph, type GraphStats } from './graph';
import type { GroupKey, RepairLog } from './topology';
import { VertexStore } from './vertex-store';

export const GRAPH_FORMAT = 'geoverse-line-finder/graph';
export const GRAPH_FORMAT_VERSION = 1;

type ArrayKind = 'f64' | 'i32' | 'u32' | 'u8';
type Typed = Float64Array | Int32Array | Uint32Array | Uint8Array;

/** Plain, structured-clone friendly form of a {@link RoutingGraph}. */
export interface TransferableGraph {
  format: typeof GRAPH_FORMAT;
  formatVersion: number;
  header: GraphHeader;
  /** One buffer per `header.layout` entry. Pass them as the transfer list of `postMessage`. */
  buffers: ArrayBufferLike[];
}

export interface GraphHeader {
  metric: { name: string; referenceLat: number };
  featureCount: number;
  stats: GraphStats;
  settings: GraphSettings;
  heuristic: { dims: number; scale: number };
  groupKeys: (GroupKey | null)[];
  largestComponent: number;
  rtree: { numItems: number; nodeSize: number };
  layout: [name: string, kind: ArrayKind, length: number][];
}

export interface SerializeOptions {
  /** Copy into `SharedArrayBuffer`s so several workers can read one graph without copies. */
  shared?: boolean;
}

export interface DeserializeOptions<P> {
  /** Source features, for `sections[].properties` / `id` and `candidates()` feature details. */
  features?: readonly NetworkFeature<P>[];
  /** Required when the graph was built with a custom metric object. */
  metric?: Metric;
}

const CTOR = { f64: Float64Array, i32: Int32Array, u32: Uint32Array, u8: Uint8Array } as const;

function kindOf(array: Typed): ArrayKind {
  if (array instanceof Float64Array) return 'f64';
  if (array instanceof Int32Array) return 'i32';
  if (array instanceof Uint32Array) return 'u32';
  return 'u8';
}

/** Serialises every table, index and log of a graph into standalone buffers (the graph itself is untouched). */
export function graphToTransferable(
  graph: RoutingGraph<unknown>,
  options: SerializeOptions = {},
): TransferableGraph {
  const { vertices, nodes, chains, segments, edges, components } = graph;
  const V = vertices.count;
  const positions = new Float64Array(V * 3);
  for (let v = 0; v < V; v++) {
    const p = vertices.positions[v];
    positions[3 * v] = p[0];
    positions[3 * v + 1] = p[1];
    positions[3 * v + 2] = p.length > 2 ? p[2] : NaN;
  }
  const rtree = graph.segmentIndex.data();
  const parts: [string, Typed][] = [
    ['vertices.x', vertices.x],
    ['vertices.y', vertices.y],
    ['vertices.node', vertices.node],
    ['vertices.chain', vertices.chain],
    ['vertices.chainPos', vertices.chainPos],
    ['vertices.positions', positions],
    ['nodes.vertex', nodes.vertex],
    ['nodes.component', nodes.component],
    ['nodes.embedding', nodes.embedding],
    ['chains.from', chains.from],
    ['chains.to', chains.to],
    ['chains.segStart', chains.segStart],
    ['chains.vertices', chains.vertices],
    ['chains.forward', chains.forward],
    ['chains.backward', chains.backward],
    ['chains.length', chains.length],
    ['chains.component', chains.component],
    ['segments.chain', segments.chain],
    ['segments.forward', segments.forward],
    ['segments.backward', segments.backward],
    ['segments.length', segments.length],
    ['segments.feature', segments.feature],
    ['segments.measureStart', segments.measureStart],
    ['segments.measureEnd', segments.measureEnd],
    ['segments.part', segments.part],
    ['segments.reversed', segments.reversed],
    ['edges.offsets', edges.offsets],
    ['edges.targets', edges.targets],
    ['edges.costs', edges.costs],
    ['edges.ref', edges.ref],
    ['components.nodes', components.nodes],
    ['components.length', components.length],
    ['remap', graph.remap],
    ['rtree.boxes', rtree.boxes],
    ['rtree.indices', rtree.indices],
  ];
  if (vertices.group) parts.push(['vertices.group', vertices.group]);
  const log = graph.diagnosticsLog;
  if (log) {
    const r = log.repairs;
    const table = new Float64Array(r.kind.length * 6);
    for (let i = 0; i < r.kind.length; i++)
      table.set([r.kind[i], r.x[i], r.y[i], r.featureA[i], r.featureB[i], r.gap[i]], i * 6);
    parts.push(['diagnostics.repairs', table], ['diagnostics.invalid', log.invalid]);
  }

  const shared = options.shared === true && typeof SharedArrayBuffer !== 'undefined';
  const layout: GraphHeader['layout'] = [];
  const buffers: ArrayBufferLike[] = [];
  for (const [name, array] of parts) {
    const buffer = shared ? new SharedArrayBuffer(array.byteLength) : new ArrayBuffer(array.byteLength);
    new Uint8Array(buffer).set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    layout.push([name, kindOf(array), array.length]);
    buffers.push(buffer);
  }
  return {
    format: GRAPH_FORMAT,
    formatVersion: GRAPH_FORMAT_VERSION,
    header: {
      metric: { name: graph.metric.name, referenceLat: graph.referenceLat },
      featureCount: graph.features.length,
      stats: { ...graph.stats },
      settings: { ...graph.settings },
      heuristic: { ...graph.heuristic },
      groupKeys: graph.groupKeys.map((k) => (k === undefined ? null : k)),
      largestComponent: components.largest,
      rtree: { numItems: graph.segmentIndex.numItems, nodeSize: graph.segmentIndex.nodeSize },
      layout,
    },
    buffers,
  };
}

/** Rebuilds a graph from {@link graphToTransferable} output, viewing the buffers without copying them. */
export function graphFromTransferable<P = unknown>(
  data: TransferableGraph,
  options: DeserializeOptions<P> = {},
): RoutingGraph<P> {
  if (!data || data.format !== GRAPH_FORMAT)
    throw new TypeError('Not a serialised geoverse-line-finder graph.');
  if (data.formatVersion !== GRAPH_FORMAT_VERSION) {
    throw new RangeError(
      `Unsupported graph format version ${String(data.formatVersion)}; this build reads version ${GRAPH_FORMAT_VERSION}.`,
    );
  }
  const { header, buffers } = data;
  if (!Array.isArray(buffers) || buffers.length !== header.layout.length) {
    throw new RangeError('Serialised graph buffers do not match their layout.');
  }
  const arrays = new Map<string, Typed>();
  header.layout.forEach(([name, kind, length], i) => {
    const Ctor = CTOR[kind];
    if (!Ctor || buffers[i].byteLength !== length * Ctor.BYTES_PER_ELEMENT) {
      throw new RangeError(`Serialised graph buffer "${name}" has an unexpected size.`);
    }
    arrays.set(name, new Ctor(buffers[i] as ArrayBuffer, 0, length));
  });
  const get = <T extends Typed>(name: string): T => {
    const array = arrays.get(name);
    if (!array) throw new RangeError(`Serialised graph is missing "${name}".`);
    return array as T;
  };

  let metric: Metric;
  if (options.metric) {
    if (options.metric.name !== header.metric.name) {
      throw new RangeError(
        `Metric "${options.metric.name}" does not match the serialised "${header.metric.name}".`,
      );
    }
    metric = resolveMetric(options.metric, header.metric.referenceLat);
  } else if (['haversine', 'cheap-ruler', 'euclidean'].includes(header.metric.name)) {
    metric = resolveMetric(header.metric.name as 'haversine', header.metric.referenceLat);
  } else {
    throw new TypeError(
      `The graph uses the custom metric "${header.metric.name}"; pass it as options.metric.`,
    );
  }

  const V = header.stats.vertices >= 0 ? get<Float64Array>('vertices.x').length : 0;
  const raw = get<Float64Array>('vertices.positions');
  const x = get<Float64Array>('vertices.x');
  const y = get<Float64Array>('vertices.y');
  const group = arrays.has('vertices.group') ? get<Int32Array>('vertices.group') : null;
  const store = new VertexStore({
    tolerance: header.settings.tolerance,
    geographic: metric.geographic,
    maxAbsLat: header.settings.maxAbsLat,
  });
  const positions: Position[] = [];
  for (let v = 0; v < V; v++) {
    const z = raw[3 * v + 2];
    const p = Number.isNaN(z) ? [raw[3 * v], raw[3 * v + 1]] : [raw[3 * v], raw[3 * v + 1], z];
    positions.push(p);
    store.append(x[v], y[v], p, group ? group[v] : 0);
  }

  const features: readonly NetworkFeature<P>[] =
    options.features ??
    Array.from({ length: header.featureCount }, () => ({ geometry: null }) as NetworkFeature<P>);
  if (features.length !== header.featureCount) {
    throw new RangeError(`Expected ${header.featureCount} features, got ${features.length}.`);
  }

  let diagnosticsLog = null;
  if (arrays.has('diagnostics.repairs')) {
    const table = get<Float64Array>('diagnostics.repairs');
    const repairs: RepairLog = { kind: [], x: [], y: [], featureA: [], featureB: [], gap: [] };
    for (let i = 0; i < table.length; i += 6) {
      repairs.kind.push(table[i]);
      repairs.x.push(table[i + 1]);
      repairs.y.push(table[i + 2]);
      repairs.featureA.push(table[i + 3]);
      repairs.featureB.push(table[i + 4]);
      repairs.gap.push(table[i + 5]);
    }
    diagnosticsLog = { repairs, invalid: get<Int32Array>('diagnostics.invalid') };
  }

  const N = get<Int32Array>('nodes.vertex').length;
  const C = get<Int32Array>('chains.from').length;
  const K = get<Int32Array>('segments.chain').length;
  const M = get<Int32Array>('edges.targets').length;
  const segmentIndex = PackedRTree.fromData(
    header.rtree.numItems,
    header.rtree.nodeSize,
    get<Float64Array>('rtree.boxes'),
    get<Uint32Array>('rtree.indices'),
  );

  return new RoutingGraph<P>({
    metric,
    referenceLat: header.metric.referenceLat,
    features,
    stats: { ...header.stats },
    vertices: {
      count: V,
      x,
      y,
      positions,
      node: get('vertices.node'),
      chain: get('vertices.chain'),
      chainPos: get('vertices.chainPos'),
      group,
    },
    nodes: {
      count: N,
      vertex: get('nodes.vertex'),
      component: get('nodes.component'),
      embedding: get('nodes.embedding'),
    },
    chains: {
      count: C,
      from: get('chains.from'),
      to: get('chains.to'),
      segStart: get('chains.segStart'),
      vertices: get('chains.vertices'),
      forward: get('chains.forward'),
      backward: get('chains.backward'),
      length: get('chains.length'),
      component: get('chains.component'),
    },
    segments: {
      count: K,
      chain: get('segments.chain'),
      forward: get('segments.forward'),
      backward: get('segments.backward'),
      length: get('segments.length'),
      feature: get('segments.feature'),
      measureStart: get('segments.measureStart'),
      measureEnd: get('segments.measureEnd'),
      part: get('segments.part'),
      reversed: get('segments.reversed'),
    },
    edges: {
      count: M,
      offsets: get('edges.offsets'),
      targets: get('edges.targets'),
      costs: get('edges.costs'),
      ref: get('edges.ref'),
    },
    components: {
      count: get<Int32Array>('components.nodes').length,
      nodes: get('components.nodes'),
      length: get('components.length'),
      largest: header.largestComponent,
    },
    heuristic: { ...header.heuristic },
    segmentIndex,
    store,
    remap: get('remap'),
    groupKeys: header.groupKeys.map((k) => (k === null ? undefined : k)),
    settings: { ...header.settings },
    diagnosticsLog,
  });
}
