import {
  createPropertyWeight,
  createSpeedWeight,
  osmDirection,
  type NetworkCollection,
} from '../../../../src';
import type { FeatureStyle } from '../lib/view';
import type { Scenario } from './types';

export interface OsmProps {
  highway: string;
  oneway?: string;
  junction?: string;
  maxspeed?: string;
  name?: string;
}

async function load(): Promise<NetworkCollection<OsmProps>> {
  const res = await fetch(`${import.meta.env.BASE_URL}data/gothenburg.json`);
  if (!res.ok) throw new Error(`Failed to load gothenburg.json: ${res.status}`);
  return (await res.json()) as NetworkCollection<OsmProps>;
}

/** km/h by road class; `_link` ramps drive at 70 %. Anything else (footways, steps…) is not for cars. */
const SPEED: Record<string, number> = {
  motorway: 110,
  trunk: 90,
  primary: 70,
  secondary: 60,
  tertiary: 50,
  unclassified: 40,
  road: 40,
  residential: 30,
  service: 20,
  living_street: 10,
};

function carSpeed(p: OsmProps): number | undefined {
  const posted = Number.parseFloat(p.maxspeed ?? '');
  if (posted > 0) return posted;
  const link = p.highway.endsWith('_link');
  const speed = SPEED[link ? p.highway.slice(0, -5) : p.highway];
  return speed === undefined ? undefined : link ? speed * 0.7 : speed;
}

/** Not walkable: motorways and trunk roads (and their ramps), and roads under construction. */
const NO_FOOT = /^(motorway|trunk)(_link)?$|^construction$/;

const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary']);

function roadStyle(p: OsmProps, drivable: boolean): FeatureStyle {
  if (MAJOR.has(p.highway.replace(/_link$/, ''))) return { stroke: '#b45309', width: 3, opacity: 0.85 };
  if (drivable) return { stroke: '#64748b', width: 1.6, opacity: 0.75 };
  return { stroke: '#94a3b8', width: 1, opacity: 0.35 };
}

export const gothenburgScenario: Scenario<OsmProps> = {
  id: 'gothenburg',
  title: '哥德堡 OSM 路网 · 13.5 万坐标',
  view: 'map',
  blurb:
    '瑞典哥德堡市中心的 OpenStreetMap 路网（2 万条线、13.5 万个坐标，geojson-path-finder 的大型测试数据），' +
    '底图是 OpenFreeMap。整张图在你的浏览器里建出来——建图耗时就在上方。"驾车"用 createSpeedWeight + osmDirection' +
    '（按道路等级与限速算秒，尊重单向），步道、台阶不可通行；"步行"按距离、不走高速。切换出行方式会重建一张图，' +
    '这就是"一个剖面一张图"。点不在可通行道路上时，默认的 connectivity: "connected" 会把它挪到能连通的最近处（结果里标 relocated）；' +
    '步行图碎成几百个分量（站台、孤立小路），所以这里把吸附扫描上限 snap.searchLimit 从默认 64 调到 256。',
  network: load,
  graphOptions: {},
  profiles: [
    {
      id: 'car',
      label: '驾车 · 通行时间（秒，单向）',
      graphOptions: {
        weight: createSpeedWeight<OsmProps>({ speed: carSpeed, direction: osmDirection }),
      },
      styleOf: (p) => roadStyle(p, carSpeed(p) !== undefined),
      unit: '秒',
    },
    {
      id: 'walk',
      label: '步行 · 距离（米）',
      graphOptions: {
        weight: createPropertyWeight<OsmProps>({ factor: (p) => (NO_FOOT.test(p.highway) ? null : 1) }),
      },
      styleOf: (p) => roadStyle(p, !NO_FOOT.test(p.highway)),
      unit: '米',
    },
  ],
  // The walking graph falls apart into hundreds of small components (platforms, isolated paths): the default
  // 64 nearest candidates can all lie in pieces the other waypoint cannot reach, so scan further.
  defaultRouteOptions: { snap: { searchLimit: 256 } },
  styleOf: (p) => roadStyle(p, carSpeed(p) !== undefined),
  features: { diagnostics: true },
  presets: [
    {
      label: '示例：中央车站（Nils Ericsonsgatan）→ 利瑟贝里（Örgrytevägen）',
      waypoints: [
        [11.96939, 57.71035],
        [11.99496, 57.69769],
      ],
    },
    {
      label: '示例：跨河 · 林德霍尔门 → 老城（Järntorget）',
      waypoints: [
        [11.9385, 57.70835],
        [11.95199, 57.70007],
      ],
    },
  ],
};
