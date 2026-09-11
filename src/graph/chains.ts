/** Raw output of {@link buildChains}: plain arrays, converted to typed arrays by the graph builder. */
export interface ChainBuild {
  count: number;
  /** Start / end vertex id of every chain. */
  from: number[];
  to: number[];
  /** Chain `c` owns chain-ordered segment slots `[segStart[c], segStart[c + 1])`. */
  segStart: number[];
  /** Topology segment id per slot. */
  segRef: number[];
  /** 1 when the slot traverses its segment against the digitised direction. */
  segRev: number[];
  /** Vertices along every chain; chain `c` occupies `[segStart[c] + c, segStart[c + 1] + c]`. */
  vertices: number[];
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
  for (let s = 0; s < S; s++) {
    if (!alive[s]) continue;
    degree[segA[s]]++;
    degree[segB[s]]++;
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

  const used = new Uint8Array(S);
  const out: ChainBuild = {
    count: 0,
    from: [],
    to: [],
    segStart: [0],
    segRef: [],
    segRev: [],
    vertices: [],
    junction,
  };

  const walk = (start: number, firstSegment: number): void => {
    out.from.push(start);
    out.vertices.push(start);
    let v = start;
    let s = firstSegment;
    for (;;) {
      used[s] = 1;
      const rev = segA[s] === v ? 0 : 1;
      const next = rev ? segA[s] : segB[s];
      out.segRef.push(s);
      out.segRev.push(rev);
      out.vertices.push(next);
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
    out.to.push(out.vertices[out.vertices.length - 1]);
    out.segStart.push(out.segRef.length);
    out.count++;
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
  return out;
}
