import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { osmWeight, type OsmProps } from '../bench/osm-weight';
import { LineFinder, type NetworkCollection, type Position } from '../src';
import { findGpfData, gpfFixture as fixture } from './data';
import { ReferenceGraph, mulberry32 } from './helpers';

/**
 * Mirrors geojson-path-finder's own test-suite (test/path.spec.js) on the same fixtures, then compares
 * both libraries pair by pair on its large one-way OSM network when that file is available.
 */

// geojson-path-finder's default weight is turf distance in kilometres.
const km = (_a: Position, _b: Position, _p: unknown, ctx: { distance: number }) => ctx.distance / 1000;
const planar = (a: Position, b: Position) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('geojson-path-finder test-suite parity', () => {
  it('complex network: 220 coordinates, ≈ 6.3751 km (tolerance ≈ its 1e-5° rounding)', () => {
    const finder = new LineFinder(fixture('network.json'), { weight: km, tolerance: 1.1 });
    for (const algorithm of ['astar', 'dijkstra']) {
      const r = finder.route(
        [
          [8.44460166, 59.48947469],
          [8.44651, 59.513920000000006],
        ],
        {
          algorithm,
          snap: { mode: 'exact' },
        },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.path).toHaveLength(220);
      expect(r.weight).toBeCloseTo(6.3751, 4);
    }
  });

  it('the rounded end coordinate is not a network vertex without tolerance, but edge snapping recovers', () => {
    const exact = new LineFinder(fixture('network.json'), { weight: km });
    const start = [8.44460166, 59.48947469];
    const end = [8.44651, 59.513920000000006];
    expect(exact.route([start, end], { snap: { mode: 'exact' } })).toMatchObject({
      ok: false,
      reason: 'SNAP_FAILED',
    });
    const snapped = exact.route([start, end]);
    expect(snapped.ok).toBe(true);
    // The real vertex is [8.44650646, 59.51392406], about half a metre from the rounded coordinate.
    expect(snapped.ok && snapped.waypoints[1].distance).toBeLessThan(1);
  });

  it('does not remove vertices from result (66.json)', () => {
    const r = new LineFinder(fixture('66.json'), {
      metric: 'euclidean',
      weight: (a, b) => planar(a, b),
      tolerance: 1,
    }).route(
      [
        [0, 0],
        [15, 12],
      ],
      { snap: { mode: 'exact' } },
    );
    expect(r.ok && r.path).toHaveLength(7);
    expect(r.ok && r.weight).toBeCloseTo(21.9574, 4);
  });

  it('handles a network without forks, repeatedly (advent24.json)', () => {
    const finder = new LineFinder(fixture('advent24.json'), { metric: 'euclidean' });
    for (let i = 0; i < 3; i++) {
      const r = finder.route(
        [
          [1, 1],
          [9, 1],
        ],
        { snap: { mode: 'exact' } },
      );
      expect(r.ok && r.weight).toBe(8);
    }
  });

  it('one-way network: forward only', () => {
    const network = {
      type: 'FeatureCollection' as const,
      features: [
        [
          [0, 0],
          [1, 0],
        ],
        [
          [1, 0],
          [1, 1],
        ],
      ].map((c) => ({
        type: 'Feature' as const,
        geometry: { type: 'LineString', coordinates: c },
        properties: {},
      })),
    };
    const finder = new LineFinder(network, { weight: (_a, _b, _p, ctx) => ({ forward: ctx.distance }) });
    expect(
      finder.route([
        [0, 0],
        [1, 1],
      ]).ok,
    ).toBe(true);
    expect(
      finder.route([
        [1, 1],
        [0, 0],
      ]),
    ).toMatchObject({ ok: false, reason: 'UNREACHABLE' });
  });

  it('points that are not vertices fail in exact mode', () => {
    const r = new LineFinder(fixture('network.json')).route(
      [
        [8.3, 59.3],
        [8.5, 59.6],
      ],
      { snap: { mode: 'exact' } },
    );
    expect(r).toMatchObject({ ok: false, reason: 'SNAP_FAILED' });
  });

  it('captures traversed feature data (edgeDataReducer equivalent)', () => {
    const finder = new LineFinder(fixture('network.json'), { weight: km, tolerance: 1.1 });
    const r = finder.route(
      [
        [8.44460166, 59.48947469],
        [8.44651, 59.513920000000006],
      ],
      { snap: { mode: 'exact' } },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.legs[0].sections.map((s) => s.properties?.id);
    expect(ids).toContain(2001);
    expect(ids.every((id) => typeof id === 'number')).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------------

const LARGE = findGpfData('large-network.json');

describe.skipIf(!LARGE)('large one-way OSM network: independent referee and geojson-path-finder', () => {
  it('is optimal on every pair and never worse than geojson-path-finder', async () => {
    const network = JSON.parse(readFileSync(LARGE!, 'utf8')) as NetworkCollection<OsmProps>;
    const mod = (await import('geojson-path-finder')) as unknown as { default: unknown };
    type Gpf = new (
      n: unknown,
      o: unknown,
    ) => { findPath(a: unknown, b: unknown): { weight: number } | undefined };
    const PathFinder = ((mod.default as { default?: Gpf }).default ?? mod.default) as Gpf;
    const gpf = new PathFinder(network, { weight: osmWeight, tolerance: 1e-9 });
    const finder = new LineFinder(network, { weight: (a, b, p) => osmWeight(a, b, p) });
    const referee = new ReferenceGraph(network, (a, b, p) => osmWeight(a, b, p));
    const rel = (x: number, y: number) => Math.abs(x - y) / Math.max(1, Math.abs(y));

    const { graph } = finder;
    const largest = graph.components.largest;
    const pool: Position[] = [];
    for (let v = 0; v < graph.vertices.count; v++) {
      const node = graph.vertices.node[v];
      const chain = graph.vertices.chain[v];
      const component =
        node >= 0 ? graph.nodes.component[node] : chain >= 0 ? graph.chains.component[chain] : -1;
      if (component === largest) pool.push(graph.vertices.positions[v]);
    }
    const rand = mulberry32(42);
    const point = (c: Position) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: c },
      properties: {},
    });
    let compared = 0;
    let gpfSuboptimal = 0;
    for (let i = 0; i < 60; i++) {
      const a = pool[Math.floor(rand() * pool.length)];
      const b = pool[Math.floor(rand() * pool.length)];
      const expected = referee.shortest(a, b);
      const theirs = gpf.findPath(point(a), point(b));
      expect(theirs !== undefined, `pair ${i} reachability (geojson-path-finder)`).toBe(expected < Infinity);
      for (const algorithm of ['astar', 'dijkstra']) {
        const ours = finder.route([a, b], { algorithm, snap: { mode: 'exact' } });
        expect(ours.ok, `pair ${i} ${algorithm}`).toBe(expected < Infinity);
        if (!ours.ok) continue;
        expect(rel(ours.weight, expected), `pair ${i} ${algorithm}`).toBeLessThan(1e-9);
        if (theirs) expect(ours.weight).toBeLessThanOrEqual(theirs.weight * (1 + 1e-9));
      }
      if (expected < Infinity) compared++;
      if (theirs && rel(theirs.weight, expected) > 1e-9) gpfSuboptimal++;
    }
    expect(compared).toBeGreaterThan(40);
    // geojson-path-finder 2.1.0 returns valid but longer-than-optimal routes for some pairs here (its graph
    // compaction never replaces an existing edge with a cheaper bypass). Pinned so an upgrade is noticed.
    expect(gpfSuboptimal).toBeGreaterThan(0);
  });
});
