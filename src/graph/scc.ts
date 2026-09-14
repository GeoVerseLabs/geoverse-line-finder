/** Strongly connected components of the directed search graph. */
export interface StrongComponents {
  readonly count: number;
  /** Component id per node. */
  readonly node: Int32Array;
  /** Nodes per component. */
  readonly size: Int32Array;
  /** Component with the most nodes, or -1 for an empty graph. */
  readonly largest: number;
}

/**
 * Tarjan's algorithm over a CSR adjacency, written iteratively: an explicit call stack keeps it safe on
 * graphs with hundreds of thousands of nodes, where the recursive textbook version overflows.
 */
export function strongComponents(count: number, offsets: Int32Array, targets: Int32Array): StrongComponents {
  const index = new Int32Array(count).fill(-1);
  const low = new Int32Array(count);
  const onStack = new Uint8Array(count);
  const stack = new Int32Array(count);
  const callNode = new Int32Array(count);
  const callEdge = new Int32Array(count);
  const node = new Int32Array(count).fill(-1);
  let sp = 0;
  let counter = 0;
  let components = 0;

  for (let root = 0; root < count; root++) {
    if (index[root] !== -1) continue;
    let depth = 1;
    callNode[0] = root;
    callEdge[0] = offsets[root];
    index[root] = low[root] = counter++;
    stack[sp++] = root;
    onStack[root] = 1;
    while (depth > 0) {
      const v = callNode[depth - 1];
      const e = callEdge[depth - 1];
      if (e < offsets[v + 1]) {
        callEdge[depth - 1] = e + 1;
        const w = targets[e];
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack[sp++] = w;
          onStack[w] = 1;
          callNode[depth] = w;
          callEdge[depth] = offsets[w];
          depth++;
        } else if (onStack[w] && index[w] < low[v]) {
          low[v] = index[w];
        }
        continue;
      }
      if (low[v] === index[v]) {
        let w: number;
        do {
          w = stack[--sp];
          onStack[w] = 0;
          node[w] = components;
        } while (w !== v);
        components++;
      }
      depth--;
      if (depth > 0) {
        const u = callNode[depth - 1];
        if (low[v] < low[u]) low[u] = low[v];
      }
    }
  }

  const size = new Int32Array(components);
  for (let n = 0; n < count; n++) size[node[n]]++;
  let largest = -1;
  for (let c = 0; c < components; c++) if (largest === -1 || size[c] > size[largest]) largest = c;
  return { count: components, node, size, largest };
}
