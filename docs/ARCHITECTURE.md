# geoverse-line-finder 架构说明

🌐 简体中文 ｜ [English](ARCHITECTURE.en.md)

> 面向维护者：为什么这样设计、各层边界在哪、怎么扩展。使用方式见 [README](../README.md)，性能数据见 [BENCHMARK](./BENCHMARK.md)。

## 1. 调研结论：两个参考库各自强在哪、缺在哪

| 维度     | terra-route 0.0.18                                                                       | geojson-path-finder 2.1.0                                                   | 本库取舍                                                       |
| -------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 图存储   | CSR（`Int32Array` 偏移/邻接 + `Float64Array` 权重），坐标去重用 `Map<lng, Map<lat, id>>` | 对象套对象（`Record<string, Record<string, number>>`），键是 `"x,y"` 字符串 | **CSR + 嵌套 Map**（取 terra-route）                           |
| 搜索     | A\* + 四叉堆 + 按查询打戳的 scratch 缓冲 + ALT 地标（第 256 次查询后启用）               | Dijkstra（tinyqueue），每个队列状态都拷贝整条路径数组                       | **A\* / Dijkstra 可切换**，四叉堆与 scratch 复用取 terra-route |
| 权重     | **不支持**（边权 = 距离）                                                                | `weight(a, b, props)` → 数字 / `{forward, backward}` / 假值 = 不可通行      | **完整兼容 GPF 契约**，另加 `context.distance` 与声明式预设    |
| 单向     | 不支持（无向图）                                                                         | 支持                                                                        | 有向 CSR                                                       |
| 连通条件 | 坐标必须**完全相同**                                                                     | `tolerance` 舍入合并（默认 1e-5°），格边界两侧的近点会漏合并                | **按真实距离的网格合并** + 悬挂端点修复 + 可选交叉打断         |
| 起终点   | 必须是路网顶点，否则插入孤点后返回 `null`                                                | 必须是路网顶点，否则 `undefined`                                            | **四种吸附模式**，默认投影到最近线段                           |
| 图压缩   | 无                                                                                       | 度 2 顶点压缩 + 查询期"幽灵节点"（直接改写图，查询间共享可变状态）          | **链压缩 + 查询期只读叠加层**                                  |
| 途经点   | 无                                                                                       | 无                                                                          | **多途经点逐段求解**                                           |
| 结果     | 仅几何                                                                                   | `path` + `weight` + 可选 `edgeDatas`（需写 reducer）                        | 几何 + 权重 + 长度 + 分段 + 按要素聚合的 `sections`            |

**两个实测发现**（都有测试钉住，见 `test/gpf-parity.test.ts`）：

1. GPF 自带测试里的终点 `[8.44651, 59.513920000000006]` 本身就是它 1e-5° 舍入的产物，真实顶点是 `[8.44650646, 59.51392406]`（相距约 0.5 m）。所以"终点必须是顶点"这个约束在它自己的测试里也是靠容差蒙混过去的——这正是本库默认做线段吸附的理由。
2. GPF 在它自带的 large-network.json（OSM 单向路网）上，60 个随机点对里有 7 对返回**合法但非最短**的路线（多 0.02%～2.9%）。根因与验证过程见 §7。

## 2. 分层与数据流

```
NetworkCollection ──► topology.ts ──► build.ts ─────────────────────────► RoutingGraph（只读、可共享）
  (LineString /        │ 抽取线段                │ 调用权重函数 → forward/backward
   MultiLineString)    │ VertexStore 顶点合并     │ chains.ts：度 2 顶点压缩成链
                       │ ConnectivityRepair       │ 有向 CSR（链整体可通行的方向才成边）
                       │  · snapDangles           │ 弱连通分量（union-find）
                       │  · splitIntersections    │ A* 启发式数据（嵌入 + 最小代价比）
                       └────────────────────────► │ 线段 R 树（吸附用）

LineFinder.route(waypoints)
  ├─ snap.ts        每个途经点找候选（按分量各取最近）→ 连通性感知分配
  ├─ 逐段 leg：
  │    query-graph.ts  叠加层：落在链内部的点变成虚拟节点 + 部分链边（不改基图）
  │    mayConnect      分量快速拒绝
  │    PathAlgorithm   dijkstra / astar / 用户注册的引擎
  │    assemble.ts     边序列 → 坐标 / 长度 / sections
  └─ 拼接各段几何，汇总 weight / distance
```

### 2.1 目录

| 路径                              | 职责                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `src/types.ts`                    | 结构化的最小 GeoJSON 类型（不依赖 `@types/geojson`，但与之兼容）               |
| `src/geo/metric.ts`               | 度量：haversine / cheap-ruler / euclidean / 自定义；`embed` 提供可采纳启发式   |
| `src/geo/segment.ts`              | 点到线段投影、线段求交                                                         |
| `src/heap/`                       | `Heap` 接口 + 四叉堆（来自 terra-route，MIT）                                  |
| `src/spatial/rtree.ts`            | 静态 Hilbert 打包 R 树（布局来自 flatbush，ISC），支持精确距离的最佳优先最近邻 |
| `src/graph/vertex-store.ts`       | 顶点去重/合并                                                                  |
| `src/graph/topology.ts`           | 线段抽取 + 连通性修复（union-find 合并 + 按 t 排序的线段拆分请求）             |
| `src/graph/chains.ts`             | 度 2 压缩                                                                      |
| `src/graph/build.ts` / `graph.ts` | 构建管线 / 只读图（全部是扁平 TypedArray）                                     |
| `src/weight/weight.ts`            | GPF 兼容权重契约 + 预设                                                        |
| `src/algorithm/`                  | 引擎接口、scratch、Dijkstra、A\*、注册表                                       |
| `src/snap/snap.ts`                | 吸附模式与连通性感知分配                                                       |
| `src/route/`                      | 叠加层、路径组装、`LineFinder` 门面、GeoJSON 输出                              |

`src/` 禁止依赖 Node 内置模块（ESLint 规则 + 不带 Node 类型的 `tsconfig.lib.json` 双重把关），浏览器 / Worker / Node 通用；运行时零依赖。

## 3. 权重（需求 1）

契约与 GPF 完全一致，已有的 GPF 权重函数可直接传入：

- 正数：双向同价；`{ forward, backward }`：分方向（forward = 数字化方向 a→b）；
- `0`、`NaN`、`Infinity`、`null`、`undefined`、`false`：该方向不可通行；
- **负数直接抛 `RangeError`**（GPF 会把负权原样喂给 Dijkstra，结果静默错误）。

增强点：

- 第 4 个参数 `context = { distance, featureIndex, feature }`，`distance` 是已按度量算好的线段长度，时间型权重不必再算一遍距离。
- 预设：`createPropertyWeight`（长度 × 系数，可单向）、`createSpeedWeight`（km/h → 秒）、`osmDirection`（OSM oneway/roundabout 语义）。
- 查询期代价按线段内均匀分布计算：吸附点在线段内部时，部分代价 = 比例 × 线段代价。

## 4. 算法引擎（需求 2）

```ts
interface PathAlgorithm {
  name: string;
  usesHeuristic: boolean;
  search(req: { graph: SearchGraph; source; target; heuristic; scratch }): SearchResult;
}
```

- `SearchGraph` = 基图 CSR + 叠加层数组。约定：节点号 `< baseNodeCount` 有 CSR 邻接；每展开一个节点，还要扫一遍 `overlayFrom === node` 的叠加边（最多 5 条）。
- 内置 `dijkstra`（参考引擎）与 `astar`。二者共享 `SearchScratch`：TypedArray 只分配一次，用 `Uint32` 代戳判断有效性，查询只触碰访问到的节点（terra-route 的做法，从 Uint8 戳改为 Uint32 以免每 255 次查询清零）。
- 注册：每个 `LineFinder` 持有自己的 `AlgorithmRegistry`（预装内置引擎），`registerAlgorithm()` 追加；`route(..., { algorithm })` 也可直接传引擎对象。`test/algorithms.test.ts` 用一个只依赖公开契约写成的 Bellman-Ford 引擎证明扩展点够用。
- 堆可换：`new LineFinder(net, { heap: MyHeap })`。

### 4.1 A\* 启发式为什么对任意权重都可采纳

`h(v) = scale · ‖embed(v) − embed(target)‖`，其中

- `embed` 由度量提供，保证欧氏距离 ≤ 度量距离：haversine 用球面三维坐标（弦长 `2R√h` ≤ 弧长 `2R·asin√h`，且每次求值无三角函数）；cheap-ruler / 平面度量用缩放后的平面坐标。
- `scale = min(线段代价 / 线段长度)`，对所有线段、两个方向取最小，再乘 `1 − 1e-6` 吸收浮点噪声与部分线段插值误差。

于是任意路径代价 ≥ scale × 路径长度 ≥ scale × 直线距离 ≥ h，既可采纳又一致。权重与距离无关（例如按跳数）时 scale 很小，A\* 退化得接近 Dijkstra，但结果依旧最优。自定义度量没有 `embed` 时启发式关闭。A\* 仍保留"闭节点被更优标号时重开"的分支，确保即使日后接入只满足可采纳不满足一致的启发式也不失最优。

terra-route 的 ALT 地标没有搬过来：它基于无向图，有向图需要正反两套地标距离（`d(L,v)` 与 `d(v,L)`）。已在路线图中，作为启发式提供者接入即可，不影响现有接口。

## 5. 吸附与连通条件（需求 3）

### 5.1 建图期：让该连的连上

| 手段         | 选项                         | 做法                                                                                                | 为什么                                                                    |
| ------------ | ---------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 顶点合并     | `tolerance`（米 / 平面单位） | 网格单元 ≥ 容差，查 3×3 邻域并用真实距离判定；经度方向按路网最高纬度放大单元                        | GPF 的舍入法对"骑在舍入边界两侧"的两点无能为力，哪怕相距 0.02 m（有测试） |
| 悬挂端点修复 | `snapDangles`                | 度 1 顶点吸到阈值内最近线段（排除自身线段及其唯一邻点的线段，免得短支线折回自身），线段在投影处拆分 | 数字化时常见的"差一点没接上"的 T 字路口                                   |
| 交叉打断     | `splitIntersections`         | R 树找候选对，X 交叉建新顶点、T 形接触用现成端点拆分                                                | 数据未在交叉处共点；注意会把立交桥/隧道也接上，默认关                     |

所有合并记在 union-find、所有拆分记成 `(t, vertex)` 请求，最后一次性应用——检测阶段始终基于原始线段编号，不会因边改边查而错位。

### 5.2 查询期：吸附到哪

- `mode`：`edge`（默认，投影到最近线段）/ `vertex`（最近顶点，含形状点）/ `node`（最近路口或端点）/ `exact`（必须是顶点，兼容两参考库的行为）。
- `maxDistance`：超出即 `SNAP_FAILED`。
- 最近邻走 R 树的最佳优先遍历：盒距离是精确距离的下界，候选按**精确**距离出队，所以结果严格有序；地理坐标在查询点纬度上做局部等距矩形缩放。

### 5.3 连通性感知吸附

`connectivity: 'connected'`（默认）：每个途经点按分量各取最近候选（最多扫描 `searchLimit` 个条目）。若各途经点的最近候选同属一个分量，照常使用；否则挑一个**所有途经点都有候选**的分量、使总吸附距离最小。这只会改变"本来必然失败"的查询——不同分量之间本就不可能有路。`'nearest'` 则始终取最近点，失败时如实报 `UNREACHABLE`。

分量是弱连通（只经由整体可通行的链合并），因此"分量不同 ⇒ 不可达"是安全的快速拒绝；分量相同但因单向不可达时，由搜索给出 `UNREACHABLE`。

### 5.4 叠加层代替幽灵节点

途经点落在链内部 → 虚拟节点（源 = `N`，汇 = `N+1`），与链两端节点以部分链边相连；源汇在同一条链上时再加一条直达边（单向链上反向时这条边自然不可通行，路线会绕行，有测试）。基图从不被修改，所以：

- 同一个 `RoutingGraph` 可被多个 `LineFinder` 共享（`new LineFinder(graph)`）；
- 查询间不会相互污染（GPF 的幽灵节点直接写进 `compactedVertices`，靠 `finally` 删除）。

## 6. 两点与多途经点（需求 4）

`route([p0, p1, …, pn])` 逐段求解，任何一段不可达即整体失败并给出 `legIndex`；各段几何在共享的途经点处去重拼接。结果：

```ts
{ ok: true, path, weight, distance, legs: [{ from, to, path, weight, distance, sections, settled, relaxed }], waypoints: [{ input, location, distance, component, featureIndex }], algorithm }
{ ok: false, reason: 'INVALID_INPUT' | 'SNAP_FAILED' | 'DISCONNECTED' | 'UNREACHABLE', message, waypointIndex?, legIndex? }
```

- 失败走判别联合而非抛异常；只有配置错误（未知引擎、负权重、非法选项）才抛。
- `sections` 把路径按来源要素聚合（带 `properties`），替代 GPF 需要手写 `edgeDataReducer/edgeDataSeed` 的做法。
- `connectors: true` 把原始起终点以直线接到吸附点上（仅几何，不计入 weight/distance）。
- 输出坐标在整数位置直接复用输入的坐标对象（保留 z）；链内插值点对 z 线性插值。

途经点顺序优化（TSP）不在本期范围，扩展时可在 `route` 之前基于一对多 Dijkstra 生成代价矩阵。

## 7. 正确性保障与 GPF 次优问题的根因

测试分三层（`pnpm test`）：

1. **单元**：堆、R 树（对拍暴力）、度量（嵌入下界性质）、顶点合并、权重契约。
2. **差分**：随机网格（权重系数 0.5–2.5、单向、封路、抖动形状点）上，Dijkstra / A\* × 压缩 / 不压缩四种组合与一个**不共享任何代码**的朴素参考实现逐对比对代价，并用参考实现重算返回路径逐边求和；线段吸附场景则把吸附点插入参考网络后再比对。
3. **对齐**：复刻 GPF 自带测试的全部断言；在 large-network.json（13.5 万坐标，OSM 单向，GPF 测试用的时间权重）上，60 个随机点对与独立裁判逐对相等，且永不劣于 GPF。

**GPF 次优的根因**（2026-09-11 排查）：GPF 压缩度 2 顶点时，`compactor.ts` 的 `compact()` 只有在邻点之间**尚无**直连边时才添加旁路边：

```js
if (!neighbor[otherNeighborKey] && weightFromNeighbor) { neighbor[otherNeighborKey] = weightFromNeighbor + vertex[otherNeighborKey]; … }
```

若已有一条更贵的直连边（平行道路、单向对向车道），更便宜的旁路被丢弃，压缩后的图丢失了最短路。验证方式见 `docs/BENCHMARK.md` 的"根因实验"：对同样的点对，GPF 自己的 Dijkstra 跑**未压缩**图全部最优；只改这一行守卫后 GPF 的结果也全部最优。本库的链压缩只合并度 2 顶点、不做"邻点间旁路"式合并，平行链作为多重边全部保留，因此不存在该问题。

## 8. 已知限制与路线图

- 不支持跨 ±180° 经线的路网（R 树与 cheap-ruler 嵌入都不处理回绕）。
- `splitIntersections` 不处理共线重叠；三条线交于同一点且 `tolerance = 0` 时，浮点求出的交点可能不完全相同，建议配合一个很小的容差。
- 顶点合并是"先到者为代表"，不做传递闭包（A≈B、B≈C 但 A≉C 时 C 不并入 A）。
- 路线图：有向 ALT 地标（需反向 CSR）、双向 Dijkstra、一对多代价矩阵与途经点排序、强连通分量用于吸附偏好、图序列化以便放进 Worker、增量更新（terra-route 的 `expandRouteGraph`）。
