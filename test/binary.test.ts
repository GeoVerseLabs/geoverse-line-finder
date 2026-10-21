import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GRAPH_BINARY_MAGIC,
  GRAPH_BINARY_VERSION,
  GRAPH_FORMAT_VERSION,
  LineFinder,
  RoutingGraph,
  buildGraph,
  graphFromBinary,
  graphToBinary,
  inspectBinaryGraph,
  prepareLandmarks,
  type Metric,
  type Position,
  type RouteOptions,
  type TransferableGraph,
} from '../src';
import { decodeGraph, decodeUtf8, encodeGraph, encodeUtf8 } from '../src/graph/binary';
import { fc, gridWeight, line, mulberry32, randomGrid } from './helpers';

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

/** Every buffer of the graph's transferable form, as bytes, with the header beside them. */
function snapshot(graph: RoutingGraph<unknown>) {
  const data = graph.toTransferable();
  return {
    header: data.header,
    formatVersion: data.formatVersion,
    buffers: data.buffers.map((b) => Array.from(new Uint8Array(b as ArrayBuffer))),
  };
}

function headerOf(file: Uint8Array): {
  aliases: [number, number][];
  graph: { header: { layout: unknown[] } };
} {
  const length = new DataView(file.buffer, file.byteOffset).getUint32(16, true);
  return JSON.parse(new TextDecoder().decode(file.subarray(24, 24 + length))) as never;
}

const grid = () => randomGrid(mulberry32(11), 8, { blocked: 0.03 });
const gridOptions = { metric: 'euclidean' as const, weight: gridWeight };

describe('binary graph files', () => {
  it('loads a graph that answers every query exactly like the one it was written from', () => {
    const network = grid();
    const graph = buildGraph(network, { ...gridOptions, tolerance: 0.5, diagnostics: true });
    const landmarks = prepareLandmarks(graph, { count: 4 });
    const file = graphToBinary(graph, { landmarks, features: true });
    expect(String.fromCharCode(...file.subarray(0, 8))).toBe(GRAPH_BINARY_MAGIC);
    expect(file.byteOffset).toBe(0);
    expect(file.byteLength).toBe(file.buffer.byteLength);

    const loaded = graphFromBinary<(typeof network.features)[number]['properties']>(file);
    expect(loaded.landmarks).not.toBeNull();
    expect(Array.from(loaded.landmarks!.fromLandmark)).toEqual(Array.from(landmarks.fromLandmark));
    expect(loaded.graph.features).toEqual(network.features);
    expect(loaded.graph.diagnostics()).toEqual(graph.diagnostics());

    const a = new LineFinder(graph, { landmarks });
    const b = new LineFinder(loaded.graph, { landmarks: loaded.landmarks! });
    const rand = mulberry32(12);
    const variants: RouteOptions[] = [
      {},
      { algorithm: 'dijkstra', sectionsDetail: 'measure' },
      { snap: { selection: 'optimal', costMode: 'ends' } },
      // Exact snapping looks vertices up by location: the lazily rebuilt vertex index.
      { snap: { mode: 'exact' } },
      { snap: { mode: 'vertex' } },
    ];
    for (let q = 0; q < 12; q++) {
      const points: Position[] = [0, 1, 2].map(() => [Math.round(rand() * 70), Math.round(rand() * 70)]);
      for (const options of variants)
        expect(plain(b.route(points, options))).toEqual(plain(a.route(points, options)));
    }
    expect(plain(b.candidates([33, 41]))).toEqual(plain(a.candidates([33, 41])));
    expect(
      plain(
        b.oneToMany(
          [10, 10],
          [
            [50, 50],
            [60, 5],
          ],
        ),
      ),
    ).toEqual(
      plain(
        a.oneToMany(
          [10, 10],
          [
            [50, 50],
            [60, 5],
          ],
        ),
      ),
    );
  });

  it('carries caller metadata, readable from the header alone', () => {
    const network = grid();
    const graph = buildGraph(network, gridOptions);
    const landmarks = prepareLandmarks(graph, { count: 3 });
    const meta = {
      dataVersion: 'aisles@2026-10-21T08:00Z',
      configHash: 'a1b2',
      builtAt: 1761033600000,
      ttl: Infinity,
    };
    for (const options of [{}, { landmarks }, { features: true }, { landmarks, features: true }]) {
      const file = graphToBinary(graph, { ...options, meta });
      const info = inspectBinaryGraph(file);
      expect(info).toMatchObject({
        version: GRAPH_BINARY_VERSION,
        formatVersion: 1,
        meta,
        metric: 'euclidean',
        landmarks: 'landmarks' in options ? 3 : 0,
        features: 'features' in options,
        byteLength: file.length,
      });
      expect(info.stats).toEqual(graph.stats);
      expect(graphFromBinary(file).meta).toEqual(meta);
      // The header is enough: a service can check the first bytes before reading the rest.
      const headerEnd = 24 + new DataView(file.buffer).getUint32(16, true);
      expect(inspectBinaryGraph(file.subarray(0, headerEnd)).meta).toEqual(meta);
    }
    expect(graphFromBinary(graphToBinary(graph)).meta).toBeNull();
    expect(inspectBinaryGraph(graphToBinary(graph)).meta).toBeNull();
    expect(() => inspectBinaryGraph(new Uint8Array(30))).toThrow(TypeError);
  });

  it('parses stored features only when the caller does not bring its own', () => {
    const network = grid();
    const graph = buildGraph(network, gridOptions);
    const file = graphToBinary(graph, { features: true });
    const headerEnd = (24 + new DataView(file.buffer).getUint32(16, true) + 7) & ~7;
    // Break the stored features: loading with the caller's features never reads them.
    const broken = file.slice();
    broken[headerEnd] = 0x7b; // '{' where '[' was
    broken[headerEnd + 1] = 0x7b;
    expect(() => graphFromBinary(broken)).toThrow(SyntaxError);
    const loaded = graphFromBinary(broken, { features: network.features }).graph;
    expect(loaded.features).toBe(network.features);
    expect(snapshot(loaded)).toEqual(snapshot(graph));
    expect(() => graphFromBinary(file.slice(0, headerEnd + 10))).toThrow(/truncated/);
  });

  it('views the file in place, and copies input that is not 8-byte aligned', () => {
    const graph = buildGraph(grid(), gridOptions);
    const file = graphToBinary(graph);
    const loaded = graphFromBinary(file.buffer).graph;
    expect(loaded.edges.costs.buffer).toBe(file.buffer);
    expect(snapshot(loaded)).toEqual(snapshot(graph));

    // A Node Buffer slice from the shared pool, say: same graph, from a private copy.
    const padded = new Uint8Array(file.length + 3);
    padded.set(file, 3);
    const shifted = graphFromBinary(padded.subarray(3)).graph;
    expect(shifted.edges.costs.buffer).not.toBe(padded.buffer);
    expect(snapshot(shifted)).toEqual(snapshot(graph));

    const shared = new SharedArrayBuffer(file.length);
    new Uint8Array(shared).set(file);
    expect(snapshot(graphFromBinary(shared).graph)).toEqual(snapshot(graph));
  });

  it('stores repeated tables once and positions only as z values', () => {
    const flat = buildGraph(grid(), { metric: 'euclidean' });
    const flatFile = graphToBinary(flat);
    const names = headerOf(flatFile).graph.header.layout.map((entry) => (entry as [string])[0]);
    expect(names).not.toContain('vertices.positions');
    expect(names).not.toContain('vertices.z');
    // Under the default weight both cost directions equal the lengths.
    const aliases = headerOf(flatFile).aliases.map(([i, j]) => [names[i], names[j]]);
    expect(aliases).toContainEqual(['segments.backward', 'segments.forward']);
    expect(aliases).toContainEqual(['segments.length', 'segments.forward']);
    expect(flatFile.length).toBeLessThan(graphToBinary(buildGraph(grid(), gridOptions)).length);
    expect(snapshot(graphFromBinary(flatFile).graph)).toEqual(snapshot(flat));

    const network = fc([
      line([
        [0, 0, 1],
        [10, 0, 2],
      ]),
      line([
        [10, 0],
        [10, 10],
      ]),
    ]);
    const mixed = buildGraph(network, { metric: 'euclidean' });
    const file = graphToBinary(mixed);
    const layout = headerOf(file).graph.header.layout.map((entry) => (entry as [string])[0]);
    expect(layout).toContain('vertices.z');
    const loaded = graphFromBinary(file).graph;
    expect(loaded.vertices.positions).toEqual(mixed.vertices.positions);
    expect(snapshot(loaded)).toEqual(snapshot(mixed));
  });

  it('keeps full positions when they do not repeat the vertex coordinates', () => {
    const graph = buildGraph(grid(), gridOptions);
    const data = graph.toTransferable();
    const i = data.header.layout.findIndex(([name]) => name === 'vertices.positions');
    new Float64Array(data.buffers[i] as ArrayBuffer)[0] += 1e-9;
    const odd = RoutingGraph.fromTransferable(data);
    const file = graphToBinary(odd);
    expect(headerOf(file).graph.header.layout.map((entry) => (entry as [string])[0])).toContain(
      'vertices.positions',
    );
    expect(graphFromBinary(file).graph.vertices.positions).toEqual(odd.vertices.positions);
  });

  it('carries levels, synthesised connectors and numbers JSON cannot spell', () => {
    const floor = (f: number) =>
      line(
        [
          [0, 0],
          [10, 0],
        ],
        { floor: f },
      );
    const network = fc([floor(1), floor(2)]);
    const graph = buildGraph(network, {
      metric: 'euclidean',
      group: (p: { floor: number }) => p.floor,
      levels: { 1: { ordinal: 0 }, 2: { ordinal: 1, name: 'Upper' } },
      verticalConnectors: [
        {
          id: 'lift',
          stops: [
            { group: 1, position: [10, 0] },
            { group: 2, position: [10, 0] },
          ],
          boardCost: 2,
          properties: { floor: NaN, capacity: Infinity, offset: -0 } as never,
        },
      ],
    });
    const file = graphToBinary(graph);
    expect(new DataView(file.buffer).getUint32(12, true) & 1).toBe(1);
    const loaded = graphFromBinary(file, { features: network.features }).graph;
    expect(snapshot(loaded)).toEqual(snapshot(graph));
    const props = loaded.features[2].properties as Record<string, number>;
    expect(props.floor).toBeNaN();
    expect(props.capacity).toBe(Infinity);
    expect(Object.is(props.offset, -0)).toBe(true);
    const trip = [
      { coordinates: [1, 0] as Position, snap: { group: 1 } },
      { coordinates: [9, 0] as Position, snap: { group: 2 } },
    ];
    const route = new LineFinder(loaded).route(trip);
    expect(route.ok && route.levelChanges).toBe(1);
    expect(plain(route)).toEqual(plain(new LineFinder(graph).route(trip)));

    // Plain numbers only: the header is parsed without a reviver.
    expect(new DataView(graphToBinary(buildGraph(grid(), gridOptions)).buffer).getUint32(12, true)).toBe(0);
  });

  it('round-trips on a big-endian host too', () => {
    const graph = buildGraph(grid(), { ...gridOptions, diagnostics: true });
    const landmarks = prepareLandmarks(graph, { count: 2 });
    const little = encodeGraph(graph, { landmarks }, true);
    const big = encodeGraph(graph, { landmarks }, false);
    // A big-endian host swaps its native arrays into the same little-endian file.
    expect(big).not.toEqual(little);
    const loaded = decodeGraph(big, {}, false);
    expect(snapshot(loaded.graph)).toEqual(snapshot(graph));
    expect(Array.from(loaded.landmarks!.toLandmark)).toEqual(Array.from(landmarks.toLandmark));
  });

  it('rejects foreign, newer, truncated or inconsistent files', () => {
    const graph = buildGraph(grid(), gridOptions);
    const file = graphToBinary(graph);
    expect(() => graphFromBinary(new Uint8Array(4))).toThrow(TypeError);
    expect(() => graphFromBinary(new TextEncoder().encode('{"type":"FeatureCollection"}'))).toThrow(
      /Not a geoverse-line-finder binary graph/,
    );

    const newer = file.slice();
    new DataView(newer.buffer).setUint32(8, GRAPH_BINARY_VERSION + 1, true);
    expect(() => graphFromBinary(newer)).toThrow(/version/);

    expect(() => graphFromBinary(file.slice(0, 40))).toThrow(/truncated/);
    expect(() => graphFromBinary(file.slice(0, file.length - 64))).toThrow(/truncated/);

    // The graph inside is checked like a transferable graph.
    const meta = headerOf(file) as unknown as { graph: TransferableGraph };
    meta.graph.formatVersion = GRAPH_FORMAT_VERSION + 1;
    const json = new TextEncoder().encode(JSON.stringify(meta));
    const rewritten = new Uint8Array(file.length + json.length);
    rewritten.set(file.subarray(0, 24));
    new DataView(rewritten.buffer).setUint32(16, json.length, true);
    rewritten.set(json, 24);
    expect(() => graphFromBinary(rewritten)).toThrow(/Unsupported graph format version/);

    const other = buildGraph(randomGrid(mulberry32(3), 5), gridOptions);
    expect(() => graphToBinary(graph, { landmarks: prepareLandmarks(other, { count: 2 }) })).toThrow(
      /different graph/,
    );
    expect(() => graphFromBinary(file, { features: [] })).toThrow(/features/);
  });

  describe('positions on demand', () => {
    afterEach(() => vi.restoreAllMocks());

    it('answers every query without creating an array per vertex', () => {
      const network = grid();
      const built = buildGraph(network, { ...gridOptions, diagnostics: true });
      for (const loaded of [
        graphFromBinary(graphToBinary(built), { features: network.features }).graph,
        RoutingGraph.fromTransferable(built.toTransferable(), { features: network.features }),
      ]) {
        expect(loaded.positionZ).toBeNull();
        const spy = vi.spyOn(loaded.vertices, 'positions', 'get');
        const a = new LineFinder(built);
        const b = new LineFinder(loaded);
        const rand = mulberry32(21);
        for (let q = 0; q < 8; q++) {
          const points: Position[] = [0, 1, 2].map(() => [rand() * 70, rand() * 70]);
          for (const options of [
            {},
            { snap: { mode: 'vertex' as const } },
            { snap: { mode: 'node' as const } },
            { snap: { mode: 'exact' as const } },
            { snap: { selection: 'optimal' as const }, sectionsDetail: 'measure' as const },
          ])
            expect(plain(b.route(points, options))).toEqual(plain(a.route(points, options)));
        }
        expect(plain(b.candidates([33, 41]))).toEqual(plain(a.candidates([33, 41])));
        expect(plain(b.nearest([12, 7]))).toEqual(plain(a.nearest([12, 7])));
        expect(plain(loaded.diagnostics())).toEqual(plain(built.diagnostics()));
        expect(snapshot(loaded)).toEqual(snapshot(built));
        // Re-encoding writes the same tables (the header differs only in the key order of `stats`).
        const again = graphToBinary(loaded);
        expect(again.length).toBe(graphToBinary(built).length);
        expect(snapshot(graphFromBinary(again).graph)).toEqual(snapshot(built));
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();

        // Still there for callers that read it: built once, equal to the original.
        const positions = loaded.vertices.positions;
        expect(positions).toEqual(built.vertices.positions);
        expect(loaded.vertices.positions).toBe(positions);
      }
    });

    it('makes z positions from the stored z values', () => {
      const network = fc([
        line([
          [0, 0, 1],
          [10, 0, 2],
        ]),
        line([
          [10, 0],
          [10, 10],
        ]),
      ]);
      const built = buildGraph(network, { metric: 'euclidean' });
      for (const loaded of [
        graphFromBinary(graphToBinary(built), { features: network.features }).graph,
        RoutingGraph.fromTransferable(built.toTransferable(), { features: network.features }),
      ]) {
        expect(loaded.positionZ).toBeInstanceOf(Float64Array);
        for (let v = 0; v < built.vertices.count; v++) expect(loaded.position(v)).toEqual(built.position(v));
        const trip: Position[] = [
          [2, 0],
          [10, 8],
        ];
        expect(plain(new LineFinder(loaded).route(trip))).toEqual(plain(new LineFinder(built).route(trip)));
      }
    });

    it('keeps an array per vertex when positions do not repeat the coordinates', () => {
      const built = buildGraph(grid(), gridOptions);
      const data = built.toTransferable();
      const i = data.header.layout.findIndex(([name]) => name === 'vertices.positions');
      new Float64Array(data.buffers[i] as ArrayBuffer)[0] += 1e-9;
      const odd = RoutingGraph.fromTransferable(data);
      expect(odd.positionZ).toBeUndefined();
      expect(odd.position(0)[0]).toBe(odd.vertices.x[0] + 1e-9);
      expect(odd.position(0)).toBe(odd.vertices.positions[0]);
    });
  });

  describe('without host text codecs (a bare vm context, QuickJS)', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('encodes and decodes UTF-8 exactly like the host codecs', () => {
      const text = `楼层 F2 · café 🚀 ${'路网'.repeat(20000)}`;
      const native = new TextEncoder().encode(text);
      vi.stubGlobal('TextEncoder', undefined);
      vi.stubGlobal('TextDecoder', undefined);
      expect(encodeUtf8(text)).toEqual(native);
      expect(native.length).toBeGreaterThan(0x8000);
      expect(decodeUtf8(native)).toBe(text);
    });

    it('still writes and reads graph files', () => {
      const network = fc([
        line(
          [
            [0, 0],
            [10, 0],
          ],
          { name: '主通道' },
        ),
      ]);
      const graph = buildGraph(network, { metric: 'euclidean' });
      const withHost = graphToBinary(graph, { features: true });
      vi.stubGlobal('TextEncoder', undefined);
      vi.stubGlobal('TextDecoder', undefined);
      const file = graphToBinary(graph, { features: true });
      expect(file).toEqual(withHost);
      expect(graphFromBinary(file).graph.features[0].properties).toEqual({ name: '主通道' });
    });
  });

  it('needs the metric object for custom metrics', () => {
    const manhattan: Metric = {
      name: 'manhattan',
      geographic: false,
      embedDims: 0,
      distance: (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]),
    };
    const file = graphToBinary(
      buildGraph(
        fc([
          line([
            [0, 0],
            [3, 4],
          ]),
        ]),
        { metric: manhattan },
      ),
    );
    expect(() => graphFromBinary(file)).toThrow(/manhattan/);
    expect(graphFromBinary(file, { metric: manhattan }).graph.stats.segments).toBe(1);
  });
});
