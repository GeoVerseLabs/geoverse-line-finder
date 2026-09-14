import {
  createPropertyWeight,
  type NetworkCollection,
  type NetworkFeature,
  type Position,
} from '../../../../src';
import type { Scenario } from './types';

export interface AisleProps {
  id: string;
  roadLevel: 'Side' | 'Main' | 'Sub';
}

const SIDE_XS = [10, 25, 40, 55, 70];
const MAIN_YS = [5, 50, 95];
const Y0 = 5;
const Y1 = 95;
const X0 = 0;
const X1 = 80;

function line(
  coords: Position[],
  id: string,
  roadLevel: AisleProps['roadLevel'],
): NetworkFeature<AisleProps> {
  return {
    type: 'Feature',
    id,
    properties: { id, roadLevel },
    geometry: { type: 'LineString', coordinates: coords },
  };
}

function network(): NetworkCollection<AisleProps> {
  const features: NetworkFeature<AisleProps>[] = [
    ...SIDE_XS.map((x, i) =>
      line(
        [
          [x, Y0],
          [x, Y1],
        ],
        `side-${i + 1}`,
        'Side',
      ),
    ),
    ...MAIN_YS.map((y, i) =>
      line(
        [
          [X0, y],
          [X1, y],
        ],
        `main-${i + 1}`,
        'Main',
      ),
    ),
    line(
      [
        [X0, Y0],
        [X0, Y1],
      ],
      'sub-w',
      'Sub',
    ),
    line(
      [
        [X1, Y0],
        [X1, Y1],
      ],
      'sub-e',
      'Sub',
    ),
  ];
  return { type: 'FeatureCollection', features };
}

const COLORS: Record<AisleProps['roadLevel'], string> = { Side: '#94a3b8', Main: '#0f766e', Sub: '#0f766e' };
const WIDTHS: Record<AisleProps['roadLevel'], number> = { Side: 3, Main: 5, Sub: 4 };

export const warehouseScenario: Scenario<AisleProps> = {
  id: 'warehouse',
  title: '仓库通道 · 最近吸附 vs 全程择优',
  blurb:
    'Side（灰，窄，代价系数 3）比 Main / Sub（青，宽，代价系数 1）贵三倍。最近点吸附只看"离哪条线最近"；' +
    '全程择优（optimal selection）把吸附代价一起算进去，可能换到更远、但整体更省的入口——这正是 0.2.0 的 R1。' +
    '点两下地图放一对途经点，切到"对比 nearest / optimal"看两条路线分叉。',
  network: network(),
  graphOptions: {
    metric: 'euclidean',
    splitIntersections: true,
    weight: createPropertyWeight<AisleProps>({ factor: (p) => (p.roadLevel === 'Side' ? 3 : 1) }),
  },
  defaultRouteOptions: {
    snap: { selection: 'optimal', costMode: 'ends', candidates: 4 },
    totals: { includeSnapWeight: true },
  },
  styleOf: (p) => ({ stroke: COLORS[p.roadLevel], width: WIDTHS[p.roadLevel] }),
  features: { compareSelection: true, featureConstraint: true, measures: true },
  presets: [
    {
      label: '示例：11% 收益，换到 main-2',
      waypoints: [
        [24, 48],
        [10, 94],
      ],
    },
    {
      label: '示例：relocated，末端换到 sub-w',
      waypoints: [
        [12, 6],
        [68, 94],
      ],
    },
  ],
};
