# geoverse-line-finder

在 GeoJSON 线网络（`LineString` / `MultiLineString`）上求最短路径的零依赖 TypeScript 库：

- **可配置权重**：与 geojson-path-finder 完全兼容的权重函数（双向同价 / `{ forward, backward }` 分方向 / 假值不可通行），外加长度上下文与声明式预设；
- **可切换引擎**：内置 A* 与 Dijkstra，按名称逐次切换，也可注册自己的引擎；
- **吸附与连通**：起终点可以不在路网顶点上（投影到最近线段），建图期可合并近点、修复悬挂端点、打断交叉，查询期按连通分量智能吸附；
- **两点与多途经点**：一次调用得到整条路线、分段结果与按要素聚合的 `sections`。

路径主体借鉴 [terra-route](https://github.com/JamesLMilner/terra-route)（CSR 邻接、四叉堆、scratch 复用），权重配置借鉴 [geojson-path-finder](https://github.com/perliedman/geojson-path-finder)。浏览器、Web Worker、Node 通用。

## 安装

```bash
pnpm add geoverse-line-finder
```

同时提供 ESM 与 CommonJS（Node ≥ 18）。不经打包器时可直接用 `<script>` 引入，全局变量为 `GeoVerseLineFinder`：

```html
<script src="https://unpkg.com/geoverse-line-finder@0.1.0"></script>
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
  console.warn(route.reason, route.message); // SNAP_FAILED / DISCONNECTED / UNREACHABLE / INVALID_INPUT
}

// 多途经点：按给定顺序依次经过
const tour = finder.route([start, via1, via2, end], { algorithm: 'dijkstra' });
tour.ok && tour.legs.forEach((leg) => console.log(leg.from, '→', leg.to, leg.weight));
```

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

| 返回值                                                    | 含义                                           |
| --------------------------------------------------------- | ---------------------------------------------- |
| 正数                                                      | 两个方向同价                                   |
| `{ forward, backward }`                                   | forward = 沿数字化方向 a→b；缺省的方向不可通行 |
| `0` / `NaN` / `Infinity` / `null` / `undefined` / `false` | 不可通行                                       |
| 负数                                                      | 抛 `RangeError`（负权会让最短路算法静默出错）  |

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
finder.route(points, { algorithm: 'astar' }); // 默认
finder.route(points, { algorithm: 'dijkstra' });

// 注册自定义引擎（实现 PathAlgorithm 即可，见 docs/ARCHITECTURE.md §4）
finder.registerAlgorithm(myBidirectionalDijkstra);
finder.route(points, { algorithm: 'bidirectional-dijkstra' });
```

A* 的启发式对**任意**权重都可采纳（度量嵌入 × 全网最小"代价/长度"比），因此与 Dijkstra 给出相同的最优代价，只是展开的节点更少。

## 吸附与连通

建图期（`new LineFinder(network, options)`）：

| 选项                 | 默认          | 说明                                                                                       |
| -------------------- | ------------- | ------------------------------------------------------------------------------------------ |
| `metric`             | `'haversine'` | `'haversine'`（经纬度，米）、`'cheap-ruler'`、`'euclidean'`（投影坐标）或自定义            |
| `tolerance`          | `0`           | 相距不超过该距离的顶点合并为一个（按真实距离判断；geojson-path-finder 默认 1e-5° ≈ 1.1 m） |
| `snapDangles`        | `0`           | 把悬挂端点接到该距离内最近的线段上                                                         |
| `splitIntersections` | `false`       | 在未共点的交叉/接触处打断（会把立交也接上，按需开启）                                      |
| `compact`            | `true`        | 度 2 顶点压缩成链，结果不变、搜索更快                                                      |

查询期（`route(points, { snap })`）：

| 选项           | 默认          | 说明                                                                                          |
| -------------- | ------------- | --------------------------------------------------------------------------------------------- |
| `mode`         | `'edge'`      | `'edge'` 投影到最近线段 · `'vertex'` 最近顶点 · `'node'` 最近路口/端点 · `'exact'` 必须是顶点 |
| `maxDistance`  | `Infinity`    | 超出即 `SNAP_FAILED`                                                                          |
| `connectivity` | `'connected'` | 途经点最近位置分属不连通的分量时，改用都能到达的分量里的附近位置；`'nearest'` 始终取最近      |

`finder.nearest(point)` 单独返回最近的路网位置，可用于交互式吸附提示。

## 结果

```ts
interface RouteSuccess {
  ok: true;
  path: Position[]; // 整条路线
  weight: number; // 被最小化的总代价
  distance: number; // 沿路网总长度
  legs: RouteLeg[]; // 每段：path / weight / distance / sections / settled
  waypoints: { input; location; distance; component; featureIndex }[];
  algorithm: string;
}
```

`leg.sections` 把路径按来源要素聚合（含 `properties`、在 `leg.path` 中的下标区间、长度与代价），可直接用来列出途经道路名。

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
- 测试含与朴素参考实现的随机差分、GPF 自带测试的全部断言，以及在 GPF 的 13.5 万坐标 OSM 单向路网上与独立裁判逐对比对。
- 实测数据与复现方法见 [docs/BENCHMARK.md](docs/BENCHMARK.md)；设计说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

```bash
pnpm test        # 单元 + 差分 + 对齐测试
pnpm bench       # 三库基准（geojson-path-finder 测试数据，≥3 轮）
pnpm bench:gpf   # geojson-path-finder 次优路线的根因实验
pnpm check       # typecheck + lint + test + build
```

## 许可

MIT。借用的代码与思路见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
