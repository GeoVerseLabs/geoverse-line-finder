/** Output of {@link buildChains}; every array has its exact final length. */
export interface ChainBuild {
  count: number;
  /** Start / end vertex id of every chain. */
  from: Int32Array;
  to: Int32Array;
  /** Chain `c` owns chain-ordered segment slots `[segStart[c], segStart[c + 1])`. */
  segStart: Int32Array;
  /** Topology segment id per slot. */
  segRef: Int32Array;
  /** 1 when the slot traverses its segment against the digitised direction. */
  segRev: Uint8Array;
  /** Vertices along every chain; chain `c` occupies `[segStart[c] + c, segStart[c + 1] + c]`. */
  vertices: Int32Array;
  /** 1 for vertices that became graph nodes. */
  junction: Uint8Array;
}

/**
 * Collapses runs of degree-2 vertices into chains between junctions (vertices of degree ≠ 2), the
 * compaction idea from geojson-path-finder. Every shortest path between junctions is preserved because
 * a degree-2 vertex can only be passed straight through; interior points stay reachable through the
 * per-query overlay (see `route/query-graph.ts`). Pure cycles without any junction get an arbitrary
 * vertex promoted to junction so no part of the network is lost.
 */
export function buildChains(
  vertexCount: number,
  segA: Int32Array,
  segB: Int32Array,
  alive: Uint8Array,
  compact: boolean,
): ChainBuild {
  const V = vertexCount;
  const S = segA.length;
  const degree = new Int32Array(V);
  let live = 0;
  for (let s = 0; s < S; s++) {
    if (!alive[s]) continue;
    degree[segA[s]]++;
    degree[segB[s]]++;
    live++;
  }
  const incOffset = new Int32Array(V + 1);
  for (let v = 0; v < V; v++) incOffset[v + 1] = incOffset[v] + degree[v];
  const incident = new Int32Array(incOffset[V]);
  const cursor = incOffset.slice(0, V);
  for (let s = 0; s < S; s++) {
    if (!alive[s]) continue;
    incident[cursor[segA[s]]++] = s;
    incident[cursor[segB[s]]++] = s;
  }

  const junction = new Uint8Array(V);
  for (let v = 0; v < V; v++) {
    if (degree[v] > 0 && (!compact || degree[v] !== 2)) junction[v] = 1;
  }

  // Every live segment lands in exactly one chain, and a chain holds at least one segment.
  const from = new Int32Array(live);
  const to = new Int32Array(live);
  const segStart = new Int32Array(live + 1);
  const segRef = new Int32Array(live);
  const segRev = new Uint8Array(live);
  const vertices = new Int32Array(2 * live);
  let count = 0;
  let slots = 0;
  let vertexCursor = 0;

  const used = new Uint8Array(S);
  const walk = (start: number, firstSegment: number): void => {
    from[count] = start;
    vertices[vertexCursor++] = start;
    let v = start;
    let s = firstSegment;
    let next: number;
    for (;;) {
      used[s] = 1;
      const rev = segA[s] === v ? 0 : 1;
      next = rev ? segA[s] : segB[s];
      segRef[slots] = s;
      segRev[slots++] = rev;
      vertices[vertexCursor++] = next;
      if (junction[next]) break;
      const o = incOffset[next];
      const other = incident[o] === s ? incident[o + 1] : incident[o];
      if (used[other]) {
        // Unreachable for well-formed input; promote rather than loop forever.
        junction[next] = 1;
        break;
      }
      v = next;
      s = other;
    }
    to[count++] = next;
    segStart[count] = slots;
  };

  for (let v = 0; v < V; v++) {
    if (!junction[v]) continue;
    for (let k = incOffset[v]; k < incOffset[v + 1]; k++) {
      const s = incident[k];
      if (!used[s]) walk(v, s);
    }
  }
  for (let s = 0; s < S; s++) {
    if (alive[s] && !used[s]) {
      junction[segA[s]] = 1;
      walk(segA[s], s);
    }
  }
  return {
    count,
    from: from.slice(0, count),
    to: to.slice(0, count),
    segStart: segStart.slice(0, count + 1),
    segRef,
    segRev,
    vertices: vertices.slice(0, vertexCursor),
    junction,
  };
}
