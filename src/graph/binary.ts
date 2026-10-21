import { LandmarkTable } from '../algorithm/landmarks';
import type { NetworkFeature } from '../types';
import type { GraphStats, RoutingGraph } from './graph';
import {
  GRAPH_FORMAT,
  checkGraphFormat,
  graphFromViews,
  graphParts,
  type DeserializeOptions,
  kindOf,
  type GraphHeader,
  type Typed,
} from './serialize';

/**
 * One self-contained file for a prebuilt graph, to publish next to the data (CDN, IndexedDB, a Worker's
 * response) so a client loads the graph instead of building it.
 *
 * ```text
 * 0   8  magic "GVLFGRPH"
 * 8   4  u32 container version (GRAPH_BINARY_VERSION)
 * 12  4  u32 flags (bit 0 / bit 1: the header / features JSON tags non-finite numbers and -0)
 * 16  4  u32 header byte length H
 * 20  4  reserved (0)
 * 24  H  header JSON (UTF-8): graph header, aliases, landmark sizes, the caller's `meta`
 *        then, each starting on an 8-byte boundary: the source features as JSON (UTF-8) when stored, the
 *        graph's arrays in `header.graph.header.layout` order, then the landmark nodes, d(L, v) and d(v, L);
 *        arrays are little-endian
 * ```
 *
 * Features sit outside the header so that {@link inspectBinaryGraph} reads `meta` without parsing them, and a
 * caller that passes its own features skips them entirely.
 */
export const GRAPH_BINARY_MAGIC = 'GVLFGRPH';
/** Container version this build writes and reads (the graph inside carries its own format version). */
export const GRAPH_BINARY_VERSION = 1;

const PRELUDE = 24;
const TAGGED = 1;
const FEATURES_TAGGED = 2;
const TAG = '$gvlfNumber';
const ELEMENT_SIZE = { f64: 8, i32: 4, u32: 4, u8: 1 } as const;
// The host's UTF-8 codecs when it has them (Node, browsers, workers, Deno, Bun; src/ is compiled without host
// typings, so they are typed here). Bare engines — a `vm` context, QuickJS — fall back to ECMAScript built-ins.
const host = globalThis as unknown as {
  TextEncoder?: new () => { encode(text: string): Uint8Array };
  TextDecoder?: new () => { decode(bytes: Uint8Array): string };
};

/** @internal */
export function encodeUtf8(text: string): Uint8Array {
  if (host.TextEncoder) return new host.TextEncoder().encode(text);
  return Uint8Array.from(unescape(encodeURIComponent(text)), (c) => c.charCodeAt(0));
}

/** @internal */
export function decodeUtf8(bytes: Uint8Array): string {
  if (host.TextDecoder) return new host.TextDecoder().decode(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return decodeURIComponent(escape(binary));
}

// Annotated so that Rollup (which cannot prove `new Uint16Array` pure) drops it with the rest of this module
// when nothing here is imported; esbuild drops it either way.
const hostLittleEndian = /* @__PURE__ */ (() => new Uint8Array(new Uint16Array([1]).buffer)[0] === 1)();

export interface BinaryGraphOptions {
  /** ALT landmarks to store with the graph, so clients skip preparing them too. */
  landmarks?: LandmarkTable | null;
  /**
   * Store the source features (as JSON) so the file alone gives `sections[].properties` / `id` and feature
   * details in `candidates()`. Off by default: publish the GeoJSON separately, or route without properties.
   */
  features?: boolean;
  /**
   * The caller's metadata (JSON), returned by {@link graphFromBinary} and {@link inspectBinaryGraph} — say the
   * data version, a hash of the build options and the build time — so a service can tell a stale file from a
   * fresh one without loading the graph.
   */
  meta?: Readonly<Record<string, unknown>> | null;
}

/** What {@link graphFromBinary} returns: the graph, the landmarks stored with it and the caller's `meta`. */
export interface BinaryGraph<P = unknown> {
  graph: RoutingGraph<P>;
  landmarks: LandmarkTable | null;
  meta: Readonly<Record<string, unknown>> | null;
}

/** What {@link inspectBinaryGraph} reads from a file's header. */
export interface BinaryGraphInfo {
  /** Container version (see {@link GRAPH_BINARY_VERSION}). */
  version: number;
  /** Format version of the graph inside (see `GRAPH_FORMAT_VERSIONS`). */
  formatVersion: number;
  meta: Readonly<Record<string, unknown>> | null;
  metric: string;
  stats: Readonly<GraphStats>;
  /** Stored landmarks (0 when none). */
  landmarks: number;
  /** Whether the source features are stored. */
  features: boolean;
  /** Size of the complete file, to check for truncation before loading. */
  byteLength: number;
}

interface BinaryHeader {
  graph: { format: typeof GRAPH_FORMAT; formatVersion: number; header: GraphHeader };
  /** `[i, j]`: layout entry `i` has the same bytes as the earlier entry `j` and is not stored again. */
  aliases: [number, number][];
  landmarks: { count: number; nodeCount: number; edgeCount: number; active: number } | null;
  /** Byte length of the features JSON section, or `null` when the features are not stored. */
  features: number | null;
  meta: Readonly<Record<string, unknown>> | null;
}

const align = (n: number) => (n + 7) & ~7;

function sameBytes(a: Typed, b: Typed): boolean {
  if (a.constructor !== b.constructor || a.length !== b.length) return false;
  const p = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const q = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
  return true;
}

/**
 * Replaces `vertices.positions` (x, y, z per vertex) with the z values alone — or nothing, on a flat graph —
 * when every position repeats `vertices.x` / `vertices.y` bit for bit, as it does for graphs `buildGraph` makes.
 */
function withoutRepeatedPositions(graph: RoutingGraph<unknown>, parts: [string, Typed][]): [string, Typed][] {
  const { x, y, count } = graph.vertices;
  // A deserialised graph whose positions are made from x / y already knows, and has no array to scan.
  let hasZ = graph.positionZ ? graph.positionZ.some((z) => !Number.isNaN(z)) : false;
  if (graph.positionZ === undefined) {
    const positions = graph.vertices.positions;
    for (let v = 0; v < count; v++) {
      const p = positions[v];
      if (!Object.is(p[0], x[v]) || !Object.is(p[1], y[v])) return parts;
      if (p.length > 2 && !Number.isNaN(p[2])) hasZ = true;
    }
  }
  const out: [string, Typed][] = [];
  for (const [name, array] of parts) {
    if (name !== 'vertices.positions') out.push([name, array]);
    else if (hasZ) {
      const z = new Float64Array(count);
      for (let v = 0; v < count; v++) z[v] = array[3 * v + 2];
      out.push(['vertices.z', z]);
    }
  }
  return out;
}

/** JSON with non-finite numbers and -0 tagged; `tagged` reports whether any were. */
function toJson(value: unknown): { bytes: Uint8Array; tagged: boolean } {
  let tagged = false;
  const text = JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0))) {
      tagged = true;
      return { [TAG]: Object.is(v, -0) ? '-0' : String(v) };
    }
    return v;
  });
  return { bytes: encodeUtf8(text), tagged };
}

/** Parses {@link toJson} output; the reviver only runs when something was tagged. */
function fromJson(bytes: Uint8Array, tagged: boolean): unknown {
  const text = decodeUtf8(bytes);
  if (!tagged) return JSON.parse(text);
  return JSON.parse(text, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>)[TAG] === 'string'
      ? Number((value as Record<string, string>)[TAG])
      : value,
  );
}

/** Reverses the bytes of every `size`-byte element in place (big-endian hosts only). */
function swap(bytes: Uint8Array, size: number): void {
  if (size > 1) for (let i = 0; i < bytes.length; i += size) bytes.subarray(i, i + size).reverse();
}

/**
 * Packs a graph (and optionally its landmarks, source features and the caller's metadata) into one versioned
 * binary file. Costs are baked in: the file is tied to the weighting and options the graph was built with.
 */
export function graphToBinary(graph: RoutingGraph<unknown>, options: BinaryGraphOptions = {}): Uint8Array {
  return encodeGraph(graph, options, hostLittleEndian);
}

/** {@link graphToBinary} for a host of the given byte order (exported for tests). */
export function encodeGraph(
  graph: RoutingGraph<unknown>,
  options: BinaryGraphOptions,
  littleEndian: boolean,
): Uint8Array {
  const { formatVersion, header, parts } = graphParts(graph);
  const entries = withoutRepeatedPositions(graph, parts);
  // Byte-identical tables (forward / backward costs equal to the lengths under the default weight, say) are
  // stored once; the graph is read-only, so both names may view the same bytes.
  const aliases: [number, number][] = [];
  const arrays: ArrayBufferView[] = [];
  entries.forEach(([, array], i) => {
    const j = entries.findIndex(([, other], k) => k < i && sameBytes(other, array));
    if (j >= 0) aliases.push([i, j]);
    else arrays.push(array);
  });
  const landmarks = options.landmarks ?? null;
  if (landmarks) {
    if (!landmarks.matches(graph))
      throw new RangeError('The landmark table was built for a different graph.');
    arrays.push(landmarks.nodes, landmarks.fromLandmark, landmarks.toLandmark);
  }
  const inputCount = graph.features.length - graph.syntheticFeatures;
  const features = options.features ? toJson(graph.features.slice(0, inputCount)) : null;
  const head = toJson({
    graph: {
      format: GRAPH_FORMAT,
      formatVersion,
      header: { ...header, layout: entries.map(([name, array]) => [name, kindOf(array), array.length]) },
    },
    aliases,
    landmarks: landmarks && {
      count: landmarks.count,
      nodeCount: landmarks.nodeCount,
      edgeCount: landmarks.edgeCount,
      active: landmarks.active,
    },
    features: features && features.bytes.length,
    meta: options.meta ?? null,
  } satisfies BinaryHeader);

  let size = align(PRELUDE + head.bytes.length) + (features ? align(features.bytes.length) : 0);
  for (const a of arrays) size += align(a.byteLength);
  const out = new Uint8Array(size);
  for (let i = 0; i < 8; i++) out[i] = GRAPH_BINARY_MAGIC.charCodeAt(i);
  const view = new DataView(out.buffer);
  view.setUint32(8, GRAPH_BINARY_VERSION, true);
  view.setUint32(12, (head.tagged ? TAGGED : 0) | (features?.tagged ? FEATURES_TAGGED : 0), true);
  view.setUint32(16, head.bytes.length, true);
  out.set(head.bytes, PRELUDE);
  let offset = align(PRELUDE + head.bytes.length);
  if (features) {
    out.set(features.bytes, offset);
    offset += align(features.bytes.length);
  }
  for (const a of arrays) {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    out.set(bytes, offset);
    if (!littleEndian)
      swap(out.subarray(offset, offset + a.byteLength), (a as Float64Array).BYTES_PER_ELEMENT);
    offset += align(a.byteLength);
  }
  return out;
}

const asBytes = (data: ArrayBufferLike | ArrayBufferView) =>
  ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);

/** Checks the prelude and parses the header; `end` is where the header's padding ends. */
function readHeader(bytes: Uint8Array): { header: BinaryHeader; flags: number; end: number } {
  if (bytes.length < PRELUDE || String.fromCharCode(...bytes.subarray(0, 8)) !== GRAPH_BINARY_MAGIC) {
    throw new TypeError('Not a geoverse-line-finder binary graph.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(8, true);
  if (version !== GRAPH_BINARY_VERSION) {
    throw new RangeError(
      `Unsupported binary graph version ${version}; this build reads version ${GRAPH_BINARY_VERSION}.`,
    );
  }
  const flags = view.getUint32(12, true);
  const headerLength = view.getUint32(16, true);
  if (PRELUDE + headerLength > bytes.length) throw new RangeError('Binary graph is truncated.');
  const header = fromJson(
    bytes.subarray(PRELUDE, PRELUDE + headerLength),
    (flags & TAGGED) !== 0,
  ) as BinaryHeader;
  checkGraphFormat(header.graph);
  return { header, flags, end: align(PRELUDE + headerLength) };
}

/**
 * Reads a file's header — the caller's `meta`, the graph's stats and what is stored — without loading the
 * graph or parsing stored features. Only the bytes up to the end of the header are needed, so a service can
 * check a file (or the first kilobytes of a download) before committing to it.
 */
export function inspectBinaryGraph(data: ArrayBufferLike | ArrayBufferView): BinaryGraphInfo {
  const { header, end } = readHeader(asBytes(data));
  const g = header.graph.header;
  const aliased = new Set(header.aliases.map(([i]) => i));
  let byteLength = end + (header.features === null ? 0 : align(header.features));
  g.layout.forEach(([, kind, length], i) => {
    if (!aliased.has(i)) byteLength += align(length * ELEMENT_SIZE[kind]);
  });
  const l = header.landmarks;
  if (l) byteLength += align(l.count * 4) + 2 * align(l.count * l.nodeCount * 8);
  return {
    version: GRAPH_BINARY_VERSION,
    formatVersion: header.graph.formatVersion,
    meta: header.meta,
    metric: g.metric.name,
    stats: g.stats,
    landmarks: l ? l.count : 0,
    features: header.features !== null,
    byteLength,
  };
}

/**
 * Loads a file written by {@link graphToBinary}. The graph views the bytes in place — keep them unchanged
 * and do not transfer them while the graph is in use. Input that is not 8-byte aligned (a Node `Buffer` from
 * the shared pool, say) is copied once. Stored features are used unless `options.features` is given, in which
 * case they are not even parsed.
 */
export function graphFromBinary<P = unknown>(
  data: ArrayBufferLike | ArrayBufferView,
  options: DeserializeOptions<P> = {},
): BinaryGraph<P> {
  return decodeGraph(data, options, hostLittleEndian);
}

/** {@link graphFromBinary} for a host of the given byte order (exported for tests). */
export function decodeGraph<P>(
  data: ArrayBufferLike | ArrayBufferView,
  options: DeserializeOptions<P>,
  littleEndian: boolean,
): BinaryGraph<P> {
  let bytes = asBytes(data);
  if (bytes.byteOffset % 8 !== 0) bytes = bytes.slice();
  const { header: stored, flags, end } = readHeader(bytes);
  const header = stored.graph.header;
  let offset = end;
  let features: NetworkFeature<P>[] | undefined;
  if (stored.features !== null) {
    if (offset + stored.features > bytes.length) throw new RangeError('Binary graph is truncated.');
    if (!options.features) {
      features = fromJson(
        bytes.subarray(offset, offset + stored.features),
        (flags & FEATURES_TAGGED) !== 0,
      ) as NetworkFeature<P>[];
    }
    offset += align(stored.features);
  }
  /** Where the next stored array of `byteLength` bytes sits: a view in place, or a byte-swapped copy. */
  const next = (byteLength: number, size: number): [ArrayBufferLike, number] => {
    const start = offset;
    offset += align(byteLength);
    if (start + byteLength > bytes.length) throw new RangeError('Binary graph is truncated.');
    if (littleEndian) return [bytes.buffer, bytes.byteOffset + start];
    const copy = bytes.slice(start, start + byteLength);
    swap(copy, size);
    return [copy.buffer, 0];
  };
  const alias = new Map(stored.aliases);
  const located: ([ArrayBufferLike, number] | null)[] = [];
  const graph = graphFromViews<P>(
    header,
    (i, byteLength) => {
      const j = alias.get(i);
      if (j !== undefined) {
        const [, kind, length] = header.layout[j];
        // Entries are located in order, so the target is already known.
        return header.layout[i][1] === kind && header.layout[i][2] === length ? located[j] : null;
      }
      const length = header.layout[i][2];
      return (located[i] = next(byteLength, length ? byteLength / length : 1));
    },
    features ? { ...options, features } : options,
  );

  let landmarks: LandmarkTable | null = null;
  const l = stored.landmarks;
  if (l) {
    const size = l.count * l.nodeCount;
    const nodes = next(l.count * 4, 4);
    const from = next(size * 8, 8);
    const to = next(size * 8, 8);
    landmarks = new LandmarkTable({
      nodeCount: l.nodeCount,
      edgeCount: l.edgeCount,
      active: l.active,
      nodes: new Int32Array(nodes[0] as ArrayBuffer, nodes[1], l.count),
      fromLandmark: new Float64Array(from[0] as ArrayBuffer, from[1], size),
      toLandmark: new Float64Array(to[0] as ArrayBuffer, to[1], size),
    });
    if (!landmarks.matches(graph as RoutingGraph<unknown>)) {
      throw new RangeError('The stored landmark table does not match the stored graph.');
    }
  }
  return { graph, landmarks, meta: stored.meta };
}
