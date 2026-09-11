import { localScale } from '../geo/metric';
import { projectToSegment, type SegmentProjection } from '../geo/segment';
import type { RoutingGraph } from '../graph/graph';
import type { Position } from '../types';

export type SnapMode = 'edge' | 'vertex' | 'node' | 'exact';
export type SnapConnectivity = 'connected' | 'nearest';

export interface SnapOptions {
  /**
   * - `'edge'` (default): project onto the nearest segment — the waypoint may fall between vertices;
   * - `'vertex'`: nearest network vertex (shape points included);
   * - `'node'`: nearest junction or dead end;
   * - `'exact'`: the coordinate must already be a network vertex (within `tolerance`), which is how
   *   geojson-path-finder and terra-route behave.
   */
  mode?: SnapMode;
  /** Reject locations farther than this from the input (metric units). Default `Infinity`. */
  maxDistance?: number;
  /**
   * `'connected'` (default): when the nearest locations of the waypoints fall in different network
   * components, use nearby locations in a component shared by all waypoints (least total snap distance)
   * instead of failing. `'nearest'`: always take the nearest location.
   */
  connectivity?: SnapConnectivity;
  /** How many nearest segments/vertices to examine per waypoint when looking for other components. Default `64`. */
  searchLimit?: number;
}

/** Where a snapped location attaches to the graph. */
export type Anchor =
  | { readonly kind: 'node'; readonly node: number }
  /** Strictly inside a chain: `position` = segment index + fraction, in `(0, segmentCount)`. */
  | { readonly kind: 'chain'; readonly chain: number; readonly position: number };

export interface SnapCandidate {
  anchor: Anchor;
  point: Position;
  distance: number;
  component: number;
  /** Source feature of the snapped segment; -1 at a junction shared by several features. */
  featureIndex: number;
}

export function anchorAt(graph: RoutingGraph<unknown>, chain: number, position: number): Anchor {
  if (position <= 0) return { kind: 'node', node: graph.chains.from[chain] };
  if (position >= graph.segmentCountOf(chain)) return { kind: 'node', node: graph.chains.to[chain] };
  return { kind: 'chain', chain, position };
}

export function anchorComponent(graph: RoutingGraph<unknown>, anchor: Anchor): number {
  return anchor.kind === 'node' ? graph.nodes.component[anchor.node] : graph.chains.component[anchor.chain];
}

export function sameAnchor(a: Anchor, b: Anchor): boolean {
  if (a.kind === 'node') return b.kind === 'node' && a.node === b.node;
  return b.kind === 'chain' && a.chain === b.chain && a.position === b.position;
}

function vertexCandidate(
  graph: RoutingGraph<unknown>,
  vertex: number,
): { anchor: Anchor; point: Position; featureIndex: number } {
  const { node, chain, chainPos, positions } = graph.vertices;
  if (node[vertex] >= 0)
    return { anchor: { kind: 'node', node: node[vertex] }, point: positions[vertex], featureIndex: -1 };
  const c = chain[vertex];
  return {
    anchor: { kind: 'chain', chain: c, position: chainPos[vertex] },
    point: positions[vertex],
    featureIndex: graph.segments.feature[graph.chains.segStart[c] + chainPos[vertex]],
  };
}

/**
 * Nearest snap locations for one point, in ascending distance, keeping only the nearest location of each
 * network component, until `maxComponents` components were found or `searchLimit` items were examined.
 */
export function findSnapCandidates(
  graph: RoutingGraph<unknown>,
  x: number,
  y: number,
  mode: SnapMode,
  maxDistance: number,
  maxComponents: number,
  searchLimit: number,
): SnapCandidate[] {
  const input: Position = [x, y];
  const out: SnapCandidate[] = [];
  const components = new Set<number>();
  let scanned = 0;
  const offer = (anchor: Anchor, point: Position, featureIndex: number): boolean => {
    scanned++;
    const distance = graph.metric.distance(input, point);
    if (distance <= maxDistance) {
      const component = anchorComponent(graph, anchor);
      if (!components.has(component)) {
        components.add(component);
        out.push({ anchor, point, distance, component, featureIndex });
      }
    }
    return out.length < maxComponents && scanned < searchLimit;
  };
  // Tree distances are in a local equirectangular plane; leave a little slack before the exact check.
  const bound = maxDistance === Infinity ? Infinity : maxDistance * 1.05 + 1e-9;
  const { sx, sy } = localScale(graph.metric, y);
  const X = graph.vertices.x;
  const Y = graph.vertices.y;

  switch (mode) {
    case 'exact': {
      const v = graph.findVertex(x, y);
      if (v !== -1 && graph.isLiveVertex(v)) {
        const c = vertexCandidate(graph, v);
        offer(c.anchor, c.point, c.featureIndex);
      }
      break;
    }
    case 'edge': {
      const proj: SegmentProjection = { t: 0, x: 0, y: 0 };
      const segChain = graph.segments.chain;
      const feature = graph.segments.feature;
      const { vertices: cv, segStart } = graph.chains;
      graph.segmentIndex.nearest(
        x,
        y,
        sx,
        sy,
        (k) => {
          const c = segChain[k];
          const a = cv[k + c];
          const b = cv[k + c + 1];
          return projectToSegment(x, y, X[a], Y[a], X[b], Y[b], sx, sy, proj);
        },
        (k) => {
          const c = segChain[k];
          const a = cv[k + c];
          const b = cv[k + c + 1];
          projectToSegment(x, y, X[a], Y[a], X[b], Y[b], sx, sy, proj);
          const position = k - segStart[c] + proj.t;
          return offer(anchorAt(graph, c, position), graph.pointAt(c, position), feature[k]);
        },
        bound,
      );
      break;
    }
    case 'vertex': {
      const { tree, items } = graph.vertexSpatialIndex();
      tree.nearest(
        x,
        y,
        sx,
        sy,
        (i) => Math.hypot((x - X[items[i]]) * sx, (y - Y[items[i]]) * sy),
        (i) => {
          const c = vertexCandidate(graph, items[i]);
          return offer(c.anchor, c.point, c.featureIndex);
        },
        bound,
      );
      break;
    }
    case 'node': {
      const nodeVertex = graph.nodes.vertex;
      const positions = graph.vertices.positions;
      graph.nodeSpatialIndex().nearest(
        x,
        y,
        sx,
        sy,
        (n) => Math.hypot((x - X[nodeVertex[n]]) * sx, (y - Y[nodeVertex[n]]) * sy),
        (n) => offer({ kind: 'node', node: n }, positions[nodeVertex[n]], -1),
        bound,
      );
      break;
    }
    default:
      throw new RangeError(`Unknown snap mode "${String(mode)}".`);
  }
  return out.sort((a, b) => a.distance - b.distance);
}

export type SnapOutcome =
  | { ok: true; snaps: SnapCandidate[] }
  | { ok: false; reason: 'SNAP_FAILED' | 'DISCONNECTED'; waypointIndex?: number; message: string };

/**
 * Snaps all waypoints of a route. With `connectivity: 'connected'` the waypoints are placed in one
 * common component whenever their nearest locations disagree — a route between components can never
 * exist, so this only changes the outcome of queries that would otherwise fail.
 */
export function snapWaypoints(
  graph: RoutingGraph<unknown>,
  inputs: readonly Position[],
  options: SnapOptions,
): SnapOutcome {
  const mode = options.mode ?? 'edge';
  const maxDistance = options.maxDistance ?? Infinity;
  if (!(maxDistance >= 0)) throw new RangeError(`snap.maxDistance must be ≥ 0, got ${String(maxDistance)}.`);
  const connected =
    (options.connectivity ?? 'connected') === 'connected' && inputs.length > 1 && mode !== 'exact';
  const searchLimit = Math.max(1, Math.floor(options.searchLimit ?? 64));

  const lists: SnapCandidate[][] = [];
  for (let i = 0; i < inputs.length; i++) {
    const list = findSnapCandidates(
      graph,
      inputs[i][0],
      inputs[i][1],
      mode,
      maxDistance,
      connected ? 16 : 1,
      searchLimit,
    );
    if (list.length === 0) {
      const where = maxDistance === Infinity ? '' : ` within ${maxDistance}`;
      return {
        ok: false,
        reason: 'SNAP_FAILED',
        waypointIndex: i,
        message:
          mode === 'exact'
            ? `Waypoint #${i} is not a vertex of the network.`
            : `No network location found for waypoint #${i}${where}.`,
      };
    }
    lists.push(list);
  }
  if (!connected) return { ok: true, snaps: lists.map((list) => list[0]) };

  const first = lists[0][0].component;
  if (lists.every((list) => list[0].component === first)) {
    return { ok: true, snaps: lists.map((list) => list[0]) };
  }
  let bestComponent = -1;
  let bestTotal = Infinity;
  for (const candidate of lists[0]) {
    let total = candidate.distance;
    let complete = true;
    for (let i = 1; i < lists.length && complete; i++) {
      const match = lists[i].find((c) => c.component === candidate.component);
      if (match) total += match.distance;
      else complete = false;
    }
    if (complete && total < bestTotal) {
      bestTotal = total;
      bestComponent = candidate.component;
    }
  }
  if (bestComponent === -1) {
    return {
      ok: false,
      reason: 'DISCONNECTED',
      message: 'The waypoints lie on network components that are not connected to each other.',
    };
  }
  return { ok: true, snaps: lists.map((list) => list.find((c) => c.component === bestComponent)!) };
}
