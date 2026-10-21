// Worker half of the dist smoke test: rebuilds a transferred graph (buffers or a binary file) and routes on it.
import { parentPort } from 'node:worker_threads';
import { LineFinder, RoutingGraph, graphFromBinary } from '../dist/index.js';

parentPort.on('message', (data) => {
  const graph =
    data instanceof ArrayBuffer ? graphFromBinary(data).graph : RoutingGraph.fromTransferable(data);
  const route = new LineFinder(graph).route([
    [2, 1],
    [9, 8],
  ]);
  parentPort.postMessage(route.ok ? route.weight : null);
});
