import { createHash, type Hash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { osmWeight, type OsmProps } from '../bench/osm-weight';
import {
  buildGraph,
  createPropertyWeight,
  type GraphOptions,
  type GraphStats,
  type NetworkCollection,
  type Position,
  type RoutingGraph,
} from '../src';
import { findGpfData, gpfFixture } from './data';
import { randomBuilding, type BuildingOptions } from './fixtures/building';
import { LEVEL_FACTOR, warehouseNetwork, type AisleProps } from './fixtures/warehouse';
import { gridWeight, mulberry32, randomGrid } from './helpers';

/**
 * Golden graphs: every table, index and log `buildGraph` produces, hashed byte for byte through the serialised
 * form, plus the lazily built spatial indexes and the diagnostics. Build performance work must leave them
 * bit-identical — vertex numbering, segment order, R-tree packing and CSR order all decide which of several
 * equal routes a search returns, and none of that shows in a route-level test until two routes tie.
 *
 * Generated on `d2647f1` (0.2.0 + multi-level), before the 0.3.0 build optimisations. Regenerate on purpose
 * only: `UPDATE_GRAPH_GOLDEN=1 pnpm vitest run graph-golden`.
 */
const GOLDEN_URL = new URL('./fixtures/graph-golden.json', import.meta.url);
const UPDATE = process.env.UPDATE_GRAPH_GOLDEN === '1';
type Digest = Record<string, string>;
const golden: Record<string, Digest> = UPDATE
  ? {}
  : (JSON.parse(readFileSync(GOLDEN_URL, 'utf8')) as Record<string, Digest>);

const hex = (hash: Hash) => hash.digest('hex').slice(0, 16);
const hashJson = (value: unknown) => hex(createHash('sha256').update(JSON.stringify(value)));
const hashBytes = (...arrays: ArrayBufferView[]) => {
  const hash = createHash('sha256');
  for (const a of arrays) hash.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  return hex(hash);
};

/** The stats fields as of `d2647f1`, so that fields added later do not change the digest. */
function projectStats(s: Readonly<GraphStats>): unknown {
  return [
    s.features,
    s.lineFeatures,
    s.skippedFeatures,
    s.invalidCoordinates,
    s.coordinates,
    s.vertices,
    s.mergedVertices,
    s.danglesSnapped,
    s.intersectionsSplit,
    s.segments,
    s.impassableSegments,
    s.oneWaySegments,
    s.nodes,
    s.chains,
    s.edges,
    s.components,
    s.largestComponentNodes,
    s.groups,
    s.verticalConnectors,
  ];
}

function digestGraph(graph: RoutingGraph<unknown>): Digest {
  const data = graph.toTransferable();
  const h = data.header;
  const out: Digest = {
    header: hashJson({
      format: data.format,
      formatVersion: data.formatVersion,
      metric: h.metric,
      featureCount: h.featureCount,
      stats: projectStats(h.stats),
      settings: [
        h.settings.tolerance,
        h.settings.snapDangles,
        h.settings.splitIntersections,
        h.settings.compact,
        h.settings.zeroWeight,
        h.settings.maxAbsLat,
      ],
      heuristic: [h.heuristic.dims, h.heuristic.scale, h.heuristic.perLevel],
      groupKeys: h.groupKeys,
      levels: h.levels,
      synthetic: h.synthetic,
      largestComponent: h.largestComponent,
      rtree: h.rtree,
      layout: h.layout,
    }),
  };
  h.layout.forEach(([name], i) => {
    const buffer = data.buffers[i];
    out[name] = hashBytes(new Uint8Array(buffer as ArrayBuffer));
  });
  const vertexTree = graph.vertexSpatialIndex();
  const vertexData = vertexTree.tree.data();
  out['lazy.vertexTree'] = hashBytes(vertexData.boxes, vertexData.indices, vertexTree.items);
  const nodeData = graph.nodeSpatialIndex().data();
  out['lazy.nodeTree'] = hashBytes(nodeData.boxes, nodeData.indices);
  if (graph.vertices.group) {
    const parts: ArrayBufferView[] = [];
    for (let g = 0; g < graph.groupKeys.length; g++) {
      for (const kind of ['segment', 'vertex', 'node'] as const) {
        const entry = graph.groupSpatialIndex(kind, g);
        const d = entry.tree.data();
        parts.push(d.boxes, d.indices, entry.items);
      }
    }
    out['lazy.groupTrees'] = hashBytes(...parts);
  }
  out.diagnostics = hashJson(graph.diagnostics());
  return out;
}

type Case = { id: string; build: () => RoutingGraph<unknown>; skip?: boolean };
const cases: Case[] = [];
const add = <P>(id: string, network: () => NetworkCollection<P>, options: GraphOptions<P>, skip = false) =>
  cases.push({ id, skip, build: () => buildGraph(network(), options) as RoutingGraph<unknown> });

const km = (_a: Position, _b: Position, _p: unknown, ctx: { distance: number }) => ctx.distance / 1000;

add('gpf-network', () => gpfFixture('network.json'), {});
add('gpf-network-tolerance', () => gpfFixture('network.json'), {
  weight: km,
  tolerance: 1.1,
  diagnostics: true,
});
add('gpf-network-repair', () => gpfFixture('network.json'), {
  tolerance: 0.5,
  snapDangles: 3,
  splitIntersections: true,
  diagnostics: true,
});
add('gpf-66', () => gpfFixture('66.json'), {});
add('gpf-two-islands', () => gpfFixture('two-islands.json'), { diagnostics: true });
add('gpf-advent24', () => gpfFixture('advent24.json'), { metric: 'euclidean' });

for (const seed of [1, 2, 3]) {
  const grid = () => randomGrid(mulberry32(900 + seed), 12, { blocked: 0.04 });
  add(`grid-${seed}`, grid, { metric: 'euclidean', weight: gridWeight });
  add(`grid-${seed}-repair`, grid, {
    metric: 'euclidean',
    weight: gridWeight,
    tolerance: 0.5,
    snapDangles: 2,
    splitIntersections: true,
    diagnostics: true,
  });
  add(`grid-${seed}-tolerance-uncompacted`, grid, {
    metric: 'euclidean',
    weight: gridWeight,
    tolerance: 0.3,
    compact: false,
    zeroWeight: 'free',
  });
}

const warehouseWeight = createPropertyWeight<AisleProps>({ factor: (p) => LEVEL_FACTOR[p.roadLevel] });
add('warehouse', () => warehouseNetwork(true), { weight: warehouseWeight });
add('warehouse-raw-repair', () => warehouseNetwork(false), {
  weight: warehouseWeight,
  tolerance: 0.2,
  snapDangles: 0.5,
  splitIntersections: true,
  diagnostics: true,
});

const buildings: [string, BuildingOptions][] = [
  ['plain', {}],
  ['express-elevation', { floors: 6, express: true, elevation: true, escalators: 1 }],
  ['outdoor-free', { floors: 5, outdoor: true, freeElevator: true, stairs: 2 }],
  ['sparse-top', { floors: 4, sparseTop: true, size: 6, elevators: 3 }],
];
buildings.forEach(([name, options], i) => {
  cases.push({
    id: `building-${name}`,
    build: () => {
      const b = randomBuilding(mulberry32(40 + i), options);
      return buildGraph(b.network, { ...b.graphOptions, diagnostics: true }) as RoutingGraph<unknown>;
    },
  });
});

const LARGE = findGpfData('large-network.json');
const large = () => JSON.parse(readFileSync(LARGE!, 'utf8')) as NetworkCollection<OsmProps>;
add('large-network-osm', large, { weight: (a, b, p) => osmWeight(a, b, p) }, !LARGE);
add('large-network-repair', large, { snapDangles: 1, splitIntersections: true, diagnostics: true }, !LARGE);
add('large-network-tolerance', large, { tolerance: 1.1 }, !LARGE);

describe('golden graphs (building stays bit-identical)', () => {
  for (const c of cases) {
    it.skipIf(!!c.skip)(c.id, () => {
      const digest = digestGraph(c.build());
      if (UPDATE) {
        golden[c.id] = digest;
        return;
      }
      expect(
        golden[c.id],
        `graph golden "${c.id}" missing — regenerate with UPDATE_GRAPH_GOLDEN=1`,
      ).toBeDefined();
      expect(digest).toEqual(golden[c.id]);
    });
  }

  afterAll(() => {
    if (UPDATE) writeFileSync(GOLDEN_URL, `${JSON.stringify(golden, null, 1)}\n`);
  });
});
