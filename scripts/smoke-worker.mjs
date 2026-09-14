// Worker half of the dist smoke test: rebuilds a transferred graph and routes on it.
import { parentPort } from 'node:worker_threads';
import { LineFinder, RoutingGraph } from '../dist/index.js';

parentPort.on('message', (data) => {
  const route = new LineFinder(RoutingGraph.fromTransferable(data)).route([
    [2, 1],
    [9, 8],
  ]);
  parentPort.postMessage(route.ok ? route.weight : null);
});
