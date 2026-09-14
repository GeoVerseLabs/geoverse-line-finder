import type { NetworkCollection } from '../../../../src';
import type { Scenario } from './types';

export interface RoadProps {
  id: number;
  lastUpdate: string;
}

async function load(): Promise<NetworkCollection<RoadProps>> {
  const res = await fetch(`${import.meta.env.BASE_URL}data/network.json`);
  if (!res.ok) throw new Error(`Failed to load network.json: ${res.status}`);
  return (await res.json()) as NetworkCollection<RoadProps>;
}

export const gpfScenario: Scenario<RoadProps> = {
  id: 'gpf',
  title: '真实路网 · 线段吸附与诊断',
  blurb:
    '挪威一小片真实路网（geojson-path-finder 自带测试数据，44 条线，经纬度坐标）。默认线段吸附（edge snap）' +
    '让途经点可以落在线段中间，不必是已有顶点。点两下地图看路线；"运行诊断"调用 graph.diagnostics() 列出' +
    '未接通的端点（悬挂端点，红色 ×）——这是 0.2.0 的 R7。',
  network: load,
  graphOptions: { diagnostics: true },
  defaultRouteOptions: { sectionsDetail: 'measure' },
  styleOf: () => ({ stroke: '#475569', width: 2.5, opacity: 0.8 }),
  latScale: Math.cos((59.5 * Math.PI) / 180),
  features: { diagnostics: true, measures: true },
  presets: [
    {
      label: '示例：沿主干线',
      waypoints: [
        [8.4446, 59.4895],
        [8.4465, 59.5139],
      ],
    },
  ],
};
