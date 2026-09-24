# geoverse-line-finder

🌐 简体中文 ｜ [English](README.en.md)

[![CI](https://github.com/GeoVerseLabs/geoverse-line-finder/actions/workflows/ci.yml/badge.svg)](https://github.com/GeoVerseLabs/geoverse-line-finder/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/geoverse-line-finder)](https://www.npmjs.com/package/geoverse-line-finder)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

在 GeoJSON 线网络（`LineString` / `MultiLineString`）上求最短路径的零依赖 TypeScript 库：

- **可配置权重**：与 geojson-path-finder 完全兼容的权重函数（双向同价 / `{ forward, backward }` 分方向 / 假值不可通行），外加长度上下文与声明式预设；
- **可切换引擎**：内置 A\*（可选 ALT 地标加速）、Dijkstra 与双向 Dijkstra，按名称逐次切换，也可注册自己的引擎；
- **吸附**：起终点不必是路网顶点；每个途经点可给出多个候选，用 `featureIds` / `filter` / `group` 表达"哪里能接入"的硬约束，再按"吸附代价 + 路网代价"全程择优；吸附位置的迁移可见、可限；
- **多途经点**：一次调用得到整条路线与分段结果；不可达的点可跳过或以直线兜底；支持穿越式途经点、逐段连接段与一对多代价矩阵；
- **数据质量与部署**：路径带沿要素的里程（线性参照），建图可定位悬挂端点、近距离未接通与修复记录；楼层/立交可分组；图可序列化后放进 Worker。

路径主体借鉴 [terra-route](https://github.com/JamesLMilner/terra-route)（CSR 邻接、四叉堆、scratch 复用），权重配置借鉴 [geojson-path-finder](https://github.com/perliedman/geojson-path-finder)。浏览器、Web Worker、Node 通用。

**🗺️ [在线示例](https://GeoVerseLabs.github.io/geoverse-line-finder/)**——点地图放途经点，实时看候选吸附、全程择优（nearest / optimal 叠加对比）、失败策略（skip / straight）与拓扑诊断；源码在 [`examples/playground/`](examples/playground/)，本地跑：`pnpm demo:dev`。

## 安装

```bash
pnpm add geoverse-line-finder
```

同时提供 ESM 与 CommonJS（Node ≥ 18，类型声明需要 TypeScript ≥ 5.0）。不经打包器时可直接用 `<script>` 引入，全局变量为 `GeoVerseLineFinder`：

```html
<script src="https://unpkg.com/geoverse-line-finder@0.2.0"></script>
<script>
  const finder = new GeoVerseLineFinder.LineFinder(roads);
</script>
```

## 快速开始

```ts
import { LineFinder, toLineString } from 'geoverse-line-finder';

const finder = new LineFinder(roads); // roads: FeatureCollection<LineString>

// 两点：起终点不必是路网顶点，默认投影到最近线段
const route = finder.route([
  [116.397, 39.908],
  [116.41, 39.92],
]);
if (route.ok) {
  console.log(route.distance, 'm'); // 沿路网长度
  console.log(route.path); // 坐标串
  map.addGeoJSON(toLineString(route)); // GeoJSON LineString
} else {
  // INVALID_INPUT / SNAP_FAILED / DISCONNECTED / UNREACHABLE / ALL_SKIPPED / BUDGET_EXCEEDED
  console.warn(route.reason, route.detail, route.message);
}

// 多途经点：按给定顺序依次经过
const tour = finder.route([start, via1, via2, end], { algorithm: 'dijkstra' });
tour.ok && tour.legs.forEach((leg) => console.log(leg.from, '→', leg.to, leg.weight));
```

从 0.1.0 升级：默认配置下的输出与 0.1.0 逐位相同，个别行为变化见 [docs/UPGRADING.md](docs/UPGRADING.md)。

## 权重

权重函数签名与 geojson-path-finder 相同，多一个 `context` 参数（`distance` 为已算好的线段长度，单位同度量）：

```ts
const finder = new LineFinder(roads, {
  weight: (a, b, props, { distance }) => {
    if (props.highway === 'footway') return 0; // 不可通行
    const seconds = distance / ((props.maxspeed ?? 30) / 3.6);
    return props.oneway === 'yes' ? { forward: seconds } : seconds; // 单向
  },
});
```

| 返回值                                              | 含义                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| 正数                                                | 两个方向同价                                                     |
| `{ forward, backward }`                             | forward = 沿数字化方向 a→b；缺省的方向不可通行                   |
| `0`                                                 | 不可通行（默认）；建图选项 `zeroWeight: 'free'` 时表示零代价通行 |
| `NaN` / `Infinity` / `null` / `undefined` / `false` | 不可通行                                                         |
| 负数                                                | 抛 `RangeError`（负权会让最短路算法静默出错）                    |

预设：

```ts
import { createPropertyWeight, createSpeedWeight, osmDirection } from 'geoverse-line-finder';

createPropertyWeight({
  factor: (p) => ({ primary: 0.8, residential: 1.2 })[p.highway] ?? 1,
  direction: osmDirection,
});
createSpeedWeight({ speed: (p) => Number(p.maxspeed) || 30, direction: osmDirection }); // 秒
```

## 引擎

```ts
import { LineFinder, bidirectionalDijkstra, prepareLandmarks } from 'geoverse-line-finder';

finder.route(points, { algorithm: 'astar' }); // 默认
finder.route(points, { algorithm: 'dijkstra' });

// 双向 Dijkstra：没有可用启发式时（跳数权重、没有 embed 的自定义度量）比 Dijkstra 展开更少
finder.registerAlgorithm(bidirectionalDijkstra);
finder.route(points, { algorithm: 'bidijkstra' });

// ALT 地标：大型有向/时间权重路网上加速 A*，默认关闭
const fast = new LineFinder(roads, { weight, landmarks: { count: 8 } });
// 或者先算好、在多个 finder / Worker 之间共享
const table = prepareLandmarks(fast.graph, { count: 8 });
const other = new LineFinder(fast.graph, { landmarks: table });
```

A\* 的启发式对**任意**权重都可采纳（度量嵌入 × 全网最小"代价/长度"比），因此与 Dijkstra 给出相同的最优代价，只是展开的节点更少；地标只会让下界更紧，结果不变。自定义引擎实现 `PathAlgorithm` 即可，见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §4。

## 建图选项

`new LineFinder(network, options)` / `buildGraph(network, options)`：

| 选项                 | 默认           | 说明                                                                                                |
| -------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `metric`             | `'haversine'`  | `'haversine'`（经纬度，米）、`'cheap-ruler'`、`'euclidean'`（投影坐标）或自定义                     |
| `tolerance`          | `0`            | 相距不超过该距离的顶点合并为一个（按真实距离判断；geojson-path-finder 默认 1e-5° ≈ 1.1 m）          |
| `snapDangles`        | `0`            | 把悬挂端点接到该距离内最近的线段上                                                                  |
| `splitIntersections` | `false`        | 在未共点的交叉/接触处打断（会把立交也接上：用 `group` 分开）                                        |
| `compact`            | `true`         | 度 2 顶点压缩成链，结果不变、搜索更快                                                               |
| `group`              | —              | 连通分组（楼层、立交层）：合并、修复与吸附都不跨组，连接要素返回 `[起点组, 终点组]`（见多楼层一节） |
| `levels`             | —              | 每个分组的楼层序号 / 标高 / 显示名：开启楼层下界、`rise` 与结果里的楼层字段                         |
| `verticalConnectors` | —              | 按停靠站声明的电梯 / 楼梯井：一次乘坐 = 一段，候梯代价只计一次                                      |
| `zeroWeight`         | `'impassable'` | 权重 `0` 的含义；`'free'` 让电梯这类零长度连接边零代价可通行                                        |
| `diagnostics`        | `false`        | 记录修复与非法坐标，供 `graph.diagnostics()` 定位                                                   |
| `landmarks`          | —              | ALT 地标（`LineFinder` 专有），见上节                                                               |

地理度量下，坐标超出 `[-180, 180] × [-90, 90]`（多半是误传了投影坐标）或线段跨越 ±180° 经线时，建图直接抛 `RangeError`，不再静默算出错误距离。

## 吸附

查询期（`route(points, { snap })`，也可放在 `new LineFinder(net, { snap })` 里作默认值）：

| 选项            | 默认                | 说明                                                                                                           |
| --------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `mode`          | `'edge'`            | `'edge'` 投影到最近线段 · `'vertex'` 最近顶点 · `'node'` 最近路口/端点 · `'exact'` 必须是顶点                  |
| `maxDistance`   | `Infinity`          | 候选的搜索半径，超出即 `SNAP_FAILED`（`detail: 'NONE_WITHIN'`）                                                |
| `selection`     | `'nearest'`         | `'nearest'` 各取最近的允许位置；`'optimal'` 在所有候选组合中取"吸附代价 + 路网代价"最小的一组                  |
| `candidates`    | 1（`optimal` 时 4） | 每个途经点保留的候选数，1–16                                                                                   |
| `distinctBy`    | `'chain'`           | 候选去重粒度：每条链上每个来源要素 / 每个要素 / 每个连通分量各留最近的一个                                     |
| `featureIds`    | —                   | 只允许接入这些要素（按 `feature.id` 或 `properties.id`）；路口候选只要有一条关联要素在列表里就算允许           |
| `filter`        | —                   | `(candidate, context) => boolean`，返回 `false` 即排除                                                         |
| `group`         | —                   | 只接入该连通分组；只扫描该组的线段/顶点，别的楼层再密也不占用 `searchLimit`                                    |
| `cost`          | `1`                 | 吸附代价：数字是吸附距离的系数，函数直接返回代价（与权重同单位）                                               |
| `costMode`      | `'none'`            | 哪些吸附代价计入：`'ends'` 起点离开 + 终点到达；`'arrive-depart'` 另加每个途经点的到达与离开                   |
| `maxRelocation` | `Infinity`          | 选中的位置比最近允许位置远出的上限                                                                             |
| `passThrough`   | `false`             | 途经点可以从一个候选进、另一个候选出（`optimal`，适合两侧都能进出的地堆位）                                    |
| `connectivity`  | `'connected'`       | 仅 `nearest`：最近位置分属不连通分量时移到共同的弱连通分量；`'reachable'` 要求同一强连通分量；`'nearest'` 不移 |
| `searchLimit`   | `64`                | 每个途经点最多检查的索引项（被约束过滤掉的也计数）；扫满仍无允许位置时报 `detail: 'SCAN_LIMIT'`，应调大它      |

**约束与偏好要分开**：`featureIds` / `filter` / `group` 是"能不能接入"的硬约束；"更愿意走哪条"应当写进权重或 `cost`，不要用 `filter` 表达偏好。每个途经点可以单独给选项，覆盖整条路线的设置：

```ts
finder.route(
  [
    { coordinates: location, snap: { featureIds: [aisleId] } }, // 这个库位只能从它朝向的通道进出
    [lng, lat],
    { coordinates: floorSpot, snap: { passThrough: true } },
    end,
  ],
  { snap: { selection: 'optimal', costMode: 'arrive-depart', maxRelocation: 20 } },
);
```

`optimal` 的注意事项：

- `costMode: 'none'`（默认）时吸附不计代价，择优会倾向"抄近路"——吸附腿是直线，比沿路网走更短。建议使用 `'ends'` / `'arrive-depart'`，并按业务设 `maxRelocation`。
- 在有单向路的路网上收益明显（最近的那条路方向不对，要绕很远），数据见 [docs/BENCHMARK.md](docs/BENCHMARK.md)。
- `connectivity` 在 `optimal` 下不生效：不连通的组合代价是无穷大，自然被排除。

默认的 `connectivity: 'connected'` 会在需要时把途经点挪到别的分量上，结果里 `waypoints[i].relocation` 给出多挪了多远，`maxRelocation` 可以设上限。不希望挪动时用 `'nearest'`。

候选与最近位置可以单独查询：

```ts
finder.nearest(point); // 最近的路网位置
finder.candidates(point, { candidates: 8, featureIds: ['A-12'] }); // 约束后的候选，含 side / measure / featureIndices
```

## 多途经点与失败策略

```ts
finder.route(points, {
  onFailure: 'skip', // 'fail'（默认，整体失败）/ 'skip'（跳过，锚点不变）/ 'straight'（直线兜底）
  skip: { leading: true, max: 3 }, // 起点吸附失败也跳过；跳过超过 3 个则整体失败
  straightCost: (d) => d * 2, // 直线段的权重
  connectors: 'legs', // true/'ends'：整条路线首尾加连接段；'legs'：每一段两端都加
  totals: { includeSnapWeight: true, includeConnectorDistance: true },
  budget: { maxCost: 3600, maxSettled: 200_000 }, // 超出即 UNREACHABLE(BEYOND_MAX_COST) / BUDGET_EXCEEDED
  debug: { candidates: true }, // 每个候选为何被选中或落选
});
```

- `skip`：某个点吸附失败或从当前锚点不可达，就记入 `skipped` 并尝试下一个点，锚点保持不变；一段都没有时返回 `ALL_SKIPPED`。
- `straight`：失败的段用吸附位置（没有时用输入坐标）之间的直线代替，`legs[i].kind === 'straight'`，长度计入 `straightDistance`。
- 穿越式途经点的进出位置不同时，路线几何经过输入点，这两小段计入 `connectorDistance`。

## 结果

```ts
interface RouteSuccess {
  ok: true;
  path: Position[]; // 整条路线
  weight: number; // 被最小化的总代价（含 snapWeight 需 totals.includeSnapWeight）
  distance: number; // 各段长度之和（含 connectorDistance 需 totals.includeConnectorDistance）
  legs: RouteLeg[]; // path / weight / distance / sections / settled / relaxed / kind / connectorDistance
  waypoints: SnappedWaypoint[]; // 与输入一一对应
  networkWeight: number;
  snapWeight: number;
  networkDistance: number;
  connectorDistance: number;
  straightDistance: number;
  complete: boolean; // 没有跳过、没有直线段
  skipped: { index; reason; detail?; message }[];
  algorithm: string;
}
```

`waypoints[i]`：`input`、`location`、`distance`、`component`、`featureIndex`、`featureId`、`measure`，以及 `snapped` / `used`、`nearestDistance` / `relocation` / `relocated`、`candidateRank` / `candidatesConsidered`、`snapCost`，穿越式途经点另有 `arrive` / `depart`。

`leg.sections` 把路径按来源要素聚合，含 `properties`、在 `leg.path` 中的下标区间、长度、代价与里程（见下节）。

## 一对多与代价矩阵

```ts
const many = finder.oneToMany(depot, customers, { paths: true }); // 一棵搜索树
many.ok && many.weights; // 不可达为 Infinity
const matrix = finder.matrix(origins, destinations); // weights[i][j]
```

## 线性参照（沿要素的里程）

每个 section 带 `fromMeasure` / `toMeasure`（沿来源要素、从其所在部分的首坐标起算的长度，递减表示逆着数字化方向走）与 `partIndex`：

```ts
const r = finder.route(points, { sectionsDetail: 'measure' });
// 热力按 10 m 分桶：floor(measure / 10)，无需几何叠加
```

- `'feature'`（默认）：与 0.1.0 相同的按要素聚合；
- `'measure'`：在 part 切换或里程不连续处（例如穿过环线起点）再断开，保证 `Σ|toMeasure − fromMeasure|` 等于长度；
- `'segment'`：每个线段一个 section。

里程沿要素在顶点合并、打断之后的几何累计，因此与路线长度严格一致；非法坐标造成的断开处不计长度。

## 拓扑诊断

```ts
const graph = buildGraph(aisles, { snapDangles: 0.5, splitIntersections: true, diagnostics: true });
const d = graph.diagnostics({ nearMissDistance: 1, limit: 500 });
d.dangles; // 悬挂端点：坐标、要素、到最近其他线段的距离
d.nearMisses; // 距离其他线段 ≤ nearMissDistance 却没接上的端点
d.repairs; // merge / dangle / split 修复记录（需 diagnostics: true）
d.components; // 各连通分量：节点数、长度、外包框、分组
d.invalidCoordinates; // 非法坐标的位置（需 diagnostics: true）
d.overlaps; // 共线重叠却未打断的线段
```

每一项都是 `{ items, total, truncated }`，超过 `limit` 的只计数。

## 多楼层（非平面路网）

楼层、立交在平面上重叠时，用 `group` 把它们分开、用连接要素相连；再用 `levels` 告诉库"这一组是第几层、标高多少"：

```ts
const finder = new LineFinder(building, {
  metric: 'euclidean',
  splitIntersections: true, // 只在各楼层内部打断
  group: (p) => (p.kind === 'corridor' ? p.floor : [p.from, p.to]),
  levels: (g) => (typeof g === 'number' ? { ordinal: g, elevation: (g - 1) * 4, name: `F${g}` } : undefined),
  weight: (a, b, p, ctx) => (p.kind === 'corridor' ? ctx.distance : 12), // 电梯给固定正代价，别用 0
  verticalConnectors: [
    // 声明式电梯：一次乘坐 = 一段，候梯代价只计一次
    {
      id: 'lift',
      stops: [1, 2, 3, 4].map((f) => ({ group: f, position: [30, 20] })),
      boardCost: 8,
      perLevelCost: 2,
    },
  ],
});

const route = finder.route([
  { coordinates: a, snap: { group: 1 } },
  { coordinates: b, snap: { group: 4 } },
]);
route.levelChanges; //  3：跨了 3 层
route.verticalDistance; // 12：爬升合计
route.legs[0].transitions; // 每一次换层：起止楼层、有符号层数差、在 path 里的下标、连接要素
toLevelFeatures(route); // 按层拆好的 FeatureCollection，室内地图按层渲染的直接输入
```

连接要素只有首尾坐标属于楼层（首坐标进起点组、末坐标进终点组）；中间坐标（楼梯的踏步、折返平台）**不属于任何组**：不与楼层上的顶点合并、不参与修复，也不会被带 `group` 约束的途经点吸附上去。所以楼梯要在首尾两端接上楼层——端点与楼层顶点坐标一致，或靠 `tolerance` / `snapDangles` 在同层内接上；接没接上用 `graph.diagnostics().connectorEnds` 查。

配了 `levels` 还会自动启用**楼层感知的 A\* 下界**：30 层楼里一趟竖向行程的展开节点数实测从 883 降到 30。不配 `levels` 则一切照旧——楼层字段不出现，下界不启用，输出与 0.1.0 逐位相同。

完整说明（数据建模、代价语义、按层渲染、性能边界与排错）见 **[docs/MULTI_LEVEL.md](docs/MULTI_LEVEL.md)**。

## Worker 与序列化

```ts
// 主线程
const data = graph.toTransferable(); // 或 { shared: true } 用 SharedArrayBuffer 共享
worker.postMessage(data, data.buffers);

// Worker
const graph = RoutingGraph.fromTransferable(data, { features }); // features 可选，用于 sections.properties
const finder = new LineFinder(graph);
```

地标表同样可以 `table.toTransferable()` / `LandmarkTable.fromTransferable()`。使用自定义度量对象时，反序列化需要传入同名的 `metric`。

## 从 geojson-path-finder 迁移

| geojson-path-finder                                    | geoverse-line-finder                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| `new PathFinder(geojson, { weight, tolerance: 1e-5 })` | `new LineFinder(geojson, { weight, tolerance: 1.1 })`（容差改为米） |
| `findPath(a, b)` → `{ path, weight } \| undefined`     | `findPath(a, b)` / `route([a, b])` → `{ ok, path, weight, … }`      |
| 起终点必须是顶点                                       | 默认线段吸附；要旧行为用 `snap: { mode: 'exact' }`                  |
| 默认权重 = 公里                                        | 默认权重 = 米（`metric` 单位）                                      |
| `edgeDataReducer` / `edgeDataSeed`                     | `leg.sections`（无需配置）                                          |
| `pathToGeoJSON(path)`                                  | `toLineString(route)`                                               |

## 性能与正确性

- 全部结构为扁平 TypedArray；查询复用 scratch 缓冲，只触碰访问到的节点。
- 测试含：0.1.0 输出的金样本（默认配置逐位相同）、与朴素参考实现的随机差分、全程择优与"枚举全部候选组合"的暴力对拍、强连通分量与可达性的对拍、GPF 自带测试的全部断言，以及在 GPF 的 13.5 万坐标 OSM 单向路网上与独立裁判逐对比对。
- CI 在 Node 20 / 22 上跑全部门禁（含体积门禁与公开 API 报告），在 Node 18 / 20 / 22 上直接加载构建产物并做 Worker 往返，并用 TypeScript 5.0 / 5.4 / 5.7 / 5.9 编译使用方代码；推送 `vX.Y.Z` tag 自动发布，见 [docs/RELEASE.md](docs/RELEASE.md)。
- 实测数据与复现方法见 [docs/BENCHMARK.md](docs/BENCHMARK.md)；设计说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；多楼层专题见 [docs/MULTI_LEVEL.md](docs/MULTI_LEVEL.md)。

```bash
pnpm test             # 单元 + 差分 + 对拍 + 金样本
pnpm bench            # 三库基准（geojson-path-finder 测试数据，≥3 轮）
pnpm bench:features   # 0.2.0 功能基准：对 0.1.0 回归、ALT、双向 Dijkstra、全程择优
pnpm check            # 类型检查 + lint + 格式 + 测试（覆盖率棘轮）+ 构建 + 产物冒烟 + 体积 + API 报告
pnpm check:types      # 声明文件在 TypeScript 5.0 / 5.4 / 5.7 / 5.9 下编译
```

## 许可

[Apache-2.0](LICENSE)，版权与归属说明见 [NOTICE](NOTICE)。借用的代码与思路（MIT / ISC）见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
