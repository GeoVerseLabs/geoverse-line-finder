import type { NetworkCollection, NetworkFeature, Position, VerticalConnector } from '../../../../src';
import type { Scenario } from './types';

export interface LevelProps {
  kind: 'corridor' | 'stairs' | 'escalator' | 'elevator';
  /** Corridors only. */
  floor?: number;
  /** Connectors only. */
  from?: number;
  to?: number;
  name?: string;
}

const FLOORS = [1, 2, 3, 4];
const FLOOR_HEIGHT = 4;

function line(coords: Position[], id: string, properties: LevelProps): NetworkFeature<LevelProps> {
  return { type: 'Feature', id, properties, geometry: { type: 'LineString', coordinates: coords } };
}

/**
 * A four-storey office block, 60 x 40 m. Every floor has the same ring corridor so that the plans overlap
 * exactly (which is what makes stacked floors hard); the spurs differ per floor so switching levels is
 * visible. Three ways up, priced differently: a lift core (declared through `verticalConnectors`, so one
 * ride is one section however many floors it spans), a staircase with a landing, and a one-way escalator.
 */
function network(): NetworkCollection<LevelProps> {
  const features: NetworkFeature<LevelProps>[] = [];
  for (const f of FLOORS) {
    const p = (kind: LevelProps['kind'], name: string): LevelProps => ({ kind, floor: f, name });
    // Ring corridor, cut at the points the connectors land on so that they really join the floor.
    features.push(
      line(
        [
          [5, 5],
          [30, 5],
          [55, 5],
        ],
        `s-F${f}`,
        p('corridor', '南廊'),
      ),
      line(
        [
          [5, 35],
          [30, 35],
          [55, 35],
        ],
        `n-F${f}`,
        p('corridor', '北廊'),
      ),
      line(
        [
          [5, 5],
          [5, 20],
          [5, 35],
        ],
        `w-F${f}`,
        p('corridor', '西廊'),
      ),
      line(
        [
          [55, 5],
          [55, 20],
          [55, 35],
        ],
        `e-F${f}`,
        p('corridor', '东廊'),
      ),
      // Lift lobby spur: from the south corridor up to the lift core at (30, 20).
      line(
        [
          [30, 5],
          [30, 20],
        ],
        `lobby-F${f}`,
        p('corridor', '电梯厅'),
      ),
      // Stair head spur, on the west side.
      line(
        [
          [5, 20],
          [14, 20],
        ],
        `stair-spur-F${f}`,
        p('corridor', '楼梯口'),
      ),
    );
    // A different office spur per floor, so each level plan is recognisable.
    const spur: Position[] =
      f % 2 === 1
        ? [
            [30, 35],
            [30, 24],
          ]
        : [
            [44, 5],
            [44, 22],
            [55, 22],
          ];
    features.push(line(spur, `office-${f}`, p('corridor', `F${f} 办公区`)));
  }

  for (let f = 1; f < FLOORS.length + 1 - 1; f++) {
    // Staircase: a flight with a landing. Its middle coordinate belongs to no floor.
    features.push(
      line(
        [
          [14, 20],
          [18, 24],
          [14, 20],
        ],
        `stairs-${f}-${f + 1}`,
        { kind: 'stairs', from: f, to: f + 1, name: `楼梯 F${f}→F${f + 1}` },
      ),
    );
  }
  // One-way escalator, up only, F1 -> F2 -> F3 (no escalator to F4).
  for (const f of [1, 2]) {
    features.push(
      line(
        [
          [55, 20],
          [48, 20],
        ],
        `escalator-${f}-${f + 1}`,
        { kind: 'escalator', from: f, to: f + 1, name: `扶梯 F${f}→F${f + 1}（只上行）` },
      ),
    );
  }
  return { type: 'FeatureCollection', features };
}

const lift: VerticalConnector<LevelProps> = {
  id: 'lift-core',
  kind: 'elevator',
  stops: FLOORS.map((f) => ({ group: f, position: [30, 20] as Position })),
  // One ride costs 8 (waiting, in and out) plus 2 per floor - whether it stops on the way or not.
  boardCost: 8,
  perLevelCost: 2,
  properties: { kind: 'elevator', name: '核心筒电梯' },
};

const CONNECTOR_COLOR = '#f59e0b';

export const multiLevelScenario: Scenario<LevelProps> = {
  id: 'multi-level',
  title: '多楼层 · 电梯 / 楼梯 / 扶梯',
  blurb:
    '四层办公楼，各层平面完全重叠，只有 group 把它们分开；levels 再告诉库"这一组是第几层、标高多少"。' +
    '三种上下方式代价不同：核心筒电梯（verticalConnectors 声明，一次乘坐 = 一段，8 + 2/层）、' +
    '西侧楼梯（按爬升计价）、东侧扶梯（只上行）。用楼层按钮切层，途经点会带上 snap.group 落在当前层；' +
    '结果按 toLevelFeatures 分层绘制——当前层实线、其他层淡显、换层段橙色虚线，点橙色方块可跳到它通向的楼层。',
  network: network(),
  graphOptions: {
    metric: 'euclidean',
    splitIntersections: true,
    group: (p) => (p.kind === 'corridor' ? p.floor! : ([p.from!, p.to!] as const)),
    levels: (g) =>
      typeof g === 'number' ? { ordinal: g, elevation: (g - 1) * FLOOR_HEIGHT, name: `F${g}` } : undefined,
    verticalConnectors: [lift],
    weight: (_a, _b, p, ctx) => {
      if (p.kind === 'corridor') return ctx.distance;
      // Stairs: the treads plus 6 per metre climbed; going down is cheaper.
      if (p.kind === 'stairs') return ctx.distance + 6 * Math.max(ctx.rise, 0) + 2 * Math.max(-ctx.rise, 0);
      if (p.kind === 'escalator') return { forward: 12 };
      return ctx.distance;
    },
  },
  defaultRouteOptions: {},
  latScale: 1,
  levels: {
    floors: FLOORS.map((f) => ({ key: f, label: `F${f}` })),
    floorOf: (p) => (p.kind === 'corridor' ? (p.floor ?? null) : null),
  },
  styleOf: (p, _i, context) => {
    if (p.kind !== 'corridor') {
      return { stroke: CONNECTOR_COLOR, width: 3, dash: '5,4', opacity: 0.9 };
    }
    const active = context?.level === undefined || context.level === p.floor;
    return {
      stroke: active ? '#0f766e' : '#94a3b8',
      width: active ? 4 : 2,
      opacity: active ? 1 : 0.18,
    };
  },
  features: { levels: true, diagnostics: true },
  presets: [
    {
      label: '示例：F1 西南角 → F4 办公区（电梯一次到顶）',
      waypoints: [
        [8, 8],
        [46, 21],
      ],
      levels: [1, 4],
    },
    {
      label: '示例：F1 → F2 楼梯更近（电梯要绕到核心筒）',
      waypoints: [
        [6, 18],
        [8, 22],
      ],
      levels: [1, 2],
    },
    {
      label: '示例：F3 → F1 扶梯不能下行，改走电梯',
      waypoints: [
        [52, 20],
        [52, 20],
      ],
      levels: [3, 1],
    },
  ],
};
