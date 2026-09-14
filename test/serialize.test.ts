import { describe, expect, it } from 'vitest';
import {
  GRAPH_FORMAT_VERSION,
  LineFinder,
  RoutingGraph,
  buildGraph,
  type Metric,
  type Position,
  type RouteOptions,
  type TransferableGraph,
} from '../src';
import { fc, gridWeight, line, mulberry32, randomGrid } from './helpers';

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('graph serialisation', () => {
  it('round-trips through structured clone with transferred buffers: identical results', () => {
    const network = randomGrid(mulberry32(5), 8, { blocked: 0.03 });
    const graph = buildGraph(network, {
      metric: 'euclidean',
      weight: gridWeight,
      tolerance: 0.5,
      snapDangles: 2,
      splitIntersections: true,
      diagnostics: true,
    });
    const data = graph.toTransferable();
    const cloned = structuredClone(data, { transfer: data.buffers as ArrayBuffer[] });
    expect(data.buffers.every((b) => b.byteLength === 0)).toBe(true);
    const copy = RoutingGraph.fromTransferable(cloned, { features: network.features });
    expect(copy.stats).toEqual(graph.stats);
    expect(copy.diagnostics()).toEqual(graph.diagnostics());

    const a = new LineFinder(graph);
    const b = new LineFinder(copy);
    const rand = mulberry32(6);
    const variants: RouteOptions[] = [
      {},
      { snap: { selection: 'optimal', costMode: 'ends' }, sectionsDetail: 'measure' },
      { snap: { mode: 'exact' } },
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

  it('keeps z values and groups; shares buffers on request', () => {
    const network = fc([
      line(
        [
          [0, 0, 1],
          [10, 0, 2],
        ],
        { floor: 1 },
      ),
      line(
        [
          [0, 0, 5],
          [10, 0, 6],
        ],
        { floor: 2 },
      ),
    ]);
    const graph = buildGraph(network, { metric: 'euclidean', group: (p: { floor: number }) => p.floor });
    const data = graph.toTransferable({ shared: true });
    expect(data.buffers.every((b) => b instanceof SharedArrayBuffer)).toBe(true);
    const copy = RoutingGraph.fromTransferable(data);
    expect(copy.groupKeys).toEqual(graph.groupKeys);
    const r = new LineFinder(copy).route([
      { coordinates: [2, 0], snap: { group: 2 } },
      { coordinates: [8, 0], snap: { group: 2 } },
    ]);
    expect(r.ok && r.path).toEqual([
      [2, 0, 5.2],
      [8, 0, 5.8],
    ]);
    // Without features, sections still work but carry no properties.
    expect(r.ok && r.legs[0].sections[0].properties).toBeUndefined();
  });

  it('needs the metric object for custom metrics and rejects foreign data', () => {
    const manhattan: Metric = {
      name: 'manhattan',
      geographic: false,
      embedDims: 0,
      distance: (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]),
    };
    const network = fc([
      line([
        [0, 0],
        [3, 4],
      ]),
    ]);
    const data = buildGraph(network, { metric: manhattan }).toTransferable();
    expect(() => RoutingGraph.fromTransferable(data)).toThrow(/manhattan/);
    expect(RoutingGraph.fromTransferable(data, { metric: manhattan }).stats.segments).toBe(1);
    expect(() =>
      RoutingGraph.fromTransferable({ ...data, format: 'nope' } as unknown as TransferableGraph),
    ).toThrow(TypeError);
    expect(() => RoutingGraph.fromTransferable({ ...data, formatVersion: GRAPH_FORMAT_VERSION + 1 })).toThrow(
      /version/,
    );
    const tampered = { ...data, buffers: [new ArrayBuffer(3), ...data.buffers.slice(1)] };
    expect(() => RoutingGraph.fromTransferable(tampered, { metric: manhattan })).toThrow(/size/);
    expect(() => RoutingGraph.fromTransferable(data, { metric: manhattan, features: [] })).toThrow(
      /features/,
    );
  });
});
