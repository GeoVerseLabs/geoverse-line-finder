import type { NetworkCollection, NetworkFeature, Position, WeightFunction } from '../../../../src';
import type { Scenario } from './types';

export interface StreetProps {
  factor: number;
  oneway: -1 | 0 | 1;
}

/** Deterministic LCG so the generated network is stable across builds. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const STEP = 20;
const LINES = 4; // grid points at 0, 20, 40, 60
const SPAN = (LINES - 1) * STEP;

function grid(): NetworkCollection<StreetProps> {
  const rand = lcg(7);
  const features: NetworkFeature<StreetProps>[] = [];
  let id = 0;
  const segment = (a: Position, b: Position) => {
    if (rand() < 0.14) return; // dropped street: creates detours and dead ends
    const oneway = rand() < 0.12 ? (rand() < 0.5 ? 1 : -1) : 0;
    features.push({
      type: 'Feature',
      id: `street-${id++}`,
      properties: { factor: 0.7 + rand() * 1.6, oneway },
      geometry: { type: 'LineString', coordinates: [a, b] },
    });
  };
  for (let row = 0; row < LINES; row++) {
    for (let col = 0; col < LINES - 1; col++) {
      segment([col * STEP, row * STEP], [(col + 1) * STEP, row * STEP]);
    }
  }
  for (let col = 0; col < LINES; col++) {
    for (let row = 0; row < LINES - 1; row++) {
      segment([col * STEP, row * STEP], [col * STEP, (row + 1) * STEP]);
    }
  }
  // A small cluster off to the side, connected to nothing: onFailure has something to do.
  const ix = SPAN + 45;
  features.push({
    type: 'Feature',
    id: 'island-a',
    properties: { factor: 1, oneway: 0 },
    geometry: {
      type: 'LineString',
      coordinates: [
        [ix, 10],
        [ix + 18, 10],
      ],
    },
  });
  features.push({
    type: 'Feature',
    id: 'island-b',
    properties: { factor: 1, oneway: 0 },
    geometry: {
      type: 'LineString',
      coordinates: [
        [ix + 9, 10],
        [ix + 9, 28],
      ],
    },
  });
  return { type: 'FeatureCollection', features };
}

const weight: WeightFunction<StreetProps> = (_a, _b, p, ctx) => {
  const cost = ctx.distance * p.factor;
  if (p.oneway === 1) return { forward: cost };
  if (p.oneway === -1) return { backward: cost };
  return cost;
};

export const gridScenario: Scenario<StreetProps> = {
  id: 'grid',
  title: '街道网格 · 多途经点与失败策略',
  blurb:
    '随机生成但固定种子的街道网格：有的路段被删掉（绕行）、有的单向（细箭头方向）。右上角一小段孤立道路' +
    '（island-a/b）与主网不连通。依次点 3 个以上途经点；点到孤立段时，切换 onFailure 看整条路线是失败、' +
    '跳过（skip，锚点不动、继续下一个）还是补一段直线（straight）——这是 0.2.0 的 R2。',
  network: grid(),
  graphOptions: { metric: 'euclidean', weight },
  defaultRouteOptions: { onFailure: 'fail', snap: { connectivity: 'nearest' } },
  styleOf: (p) => ({
    stroke: p.oneway !== 0 ? '#7c3aed' : '#334155',
    width: 2 + p.factor,
    dash: p.oneway !== 0 ? '6,3' : undefined,
    opacity: 0.85,
  }),
  latScale: 1,
  features: { failurePolicy: true },
  minWaypoints: 3,
  presets: [
    {
      label: '示例：途经孤立段',
      waypoints: [
        [5, 5],
        [SPAN + 54, 15],
        [SPAN, SPAN],
      ],
    },
  ],
};
