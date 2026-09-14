# Changelog

🌐 简体中文 ｜ [English](CHANGELOG.en.md)

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)；0.x 期间，次版本号可能包含不兼容变更。

## 0.2.0 — 2026-09-14

默认配置下的输出与 0.1.0 逐位相同（由金样本测试锁定）；个别行为变化与升级建议见 [docs/UPGRADING.md](docs/UPGRADING.md)。

### 新增

- **吸附候选与约束**：`snap.candidates` / `distinctBy` / `featureIds` / `filter` / `group`，逐点选项 `{ coordinates, snap }`，`finder.candidates()`；候选描述含关联要素、侧向、里程与分组；吸附失败带 `detail`（`NONE_WITHIN` / `FILTERED` / `NOT_A_VERTEX`）。
- **全程择优**：`snap.selection: 'optimal'`（分层动态规划，每层一次多源多汇搜索）、吸附代价 `snap.cost` / `costMode`、穿越式途经点 `passThrough`；`debug.candidates` 报告每个候选被选中或落选的原因。
- **吸附迁移可见、可限**：`waypoints[i].nearestDistance` / `relocation` / `relocated` / `candidateRank` / `candidatesConsidered`，`snap.maxRelocation`（受限时 `DISCONNECTED` 带 `detail: 'RELOCATION_LIMIT'`）。
- **强连通分量**：`connectivity: 'reachable'`，`graph.strongComponents()`（迭代版 Tarjan）。
- **失败策略**：`onFailure: 'fail' | 'skip' | 'straight'`、`skip.leading` / `skip.max`、`straightCost`；结果新增 `skipped` / `complete` / `legs[i].kind`，失败原因新增 `ALL_SKIPPED`。
- **连接段与合计口径**：`connectors: 'legs'`，`totals.includeSnapWeight` / `includeConnectorDistance`，分项 `networkWeight` / `snapWeight` / `networkDistance` / `connectorDistance` / `straightDistance`。
- **搜索预算**：`budget.maxCost` / `maxSettled`（`UNREACHABLE` + `detail: 'BEYOND_MAX_COST'` / `BUDGET_EXCEEDED`）。
- **一对多与代价矩阵**：`finder.oneToMany()`、`finder.matrix()`。
- **线性参照**：`sections[i].fromMeasure` / `toMeasure` / `partIndex`，`sectionsDetail: 'feature' | 'measure' | 'segment'`，`graph.measureAt()`。
- **拓扑诊断**：建图选项 `diagnostics`，`graph.diagnostics()`：悬挂端点、近距离未接通、修复记录、分量外包框、非法坐标位置、共线重叠。
- **连通分组与零代价边**：建图选项 `group`（楼层、立交；连接要素返回 `[起点组, 终点组]`）、`zeroWeight: 'free'`；`graph.findVertex(x, y, group)`。
- **引擎**：有向 ALT 地标 `prepareLandmarks()` / `LandmarkTable` / `LineFinderOptions.landmarks`；双向 Dijkstra `bidirectionalDijkstra`（名称 `'bidijkstra'`）。
- **引擎契约扩展（向后兼容）**：`capabilities.multiTarget` / `budget`，`SearchRequest.targets` / `maxCost` / `maxSettled`，`SearchResult.targetPaths` / `budgetExceeded`，可选的叠加层邻接 `overlayFirst` / `overlayNext` 与反向邻接 `reverseOffsets` 等；启发式可以返回 `Infinity`。未声明能力的自定义引擎由库自动回退。
- **序列化**：`graph.toTransferable()` / `RoutingGraph.fromTransferable()`（零拷贝视图，可用 `SharedArrayBuffer`）；地标表同样可传输。

### 变更

- 地理度量下坐标超出经纬度范围或线段跨越 ±180° 经线时，建图抛 `RangeError`（此前静默算出错误距离）。
- 查询叠加层的容量与虚拟节点数不再固定，`SearchGraph.nodeCount` 与叠加层数组可能在查询之间变化。
- 类型声明兼容 TypeScript 5.0 及以上（0.1.0 需要 5.7）。

### 修复

- `stats.danglesSnapped` 未计入缝隙为 0 的悬挂端点（端点恰好落在线段上时连接已建立，但计数为 0）。

### 性能与体积

- 默认配置下的建图与查询耗时与 0.1.0 持平（多轮区间重叠）。
- ALT（8 个地标）在 OSM 通行时间路网上把线段吸附的 A\* 查询提速约 2 倍，距离权重下约 1.6 倍；地标准备约 40 ms。
- 全程择优（每点 4 个候选）在合成仓库上的耗时约为最近选择的 2 倍。
- 压缩打包只引入 `LineFinder` 约 27.8 KB gzip，IIFE 约 29.7 KB gzip（0.1.0 的 IIFE 为 13.0 KB），由体积门禁把关。
- 数据与复现方法见 [docs/BENCHMARK.md](docs/BENCHMARK.md)。

### 工程

- 测试：0.1.0 金样本（默认配置逐位相同）、全程择优与暴力枚举对拍、强连通分量与可达性对拍、地标表与朴素全图搜索对拍、序列化往返，以及合成仓库 fixture。
- 门禁：公开 API 报告（`etc/`）、体积门禁、CI 中 TypeScript 5.0 / 5.4 / 5.7 / 5.9 的声明编译矩阵、产物冒烟新增 Worker 往返。
- 基准：`pnpm bench:features`，以 npm 上发布的 0.1.0 为对照。
- 文档：README、ARCHITECTURE、BENCHMARK 更新，新增 UPGRADING（均为中英双语）。

## 0.1.0 — 2026-09-11

首个版本，以 Apache-2.0 协议开源。

### 新增

- `LineFinder`：GeoJSON 线网络（`LineString` / `MultiLineString`）上的带权最短路，支持两点与按顺序的多途经点。
- 权重：兼容 geojson-path-finder 的权重函数契约（数字 / `{ forward, backward }` / 假值不可通行），额外提供 `context.distance`；
  `createPropertyWeight`、`createSpeedWeight`、`osmDirection` 预设；负权重抛 `RangeError`。
- 引擎：`AlgorithmRegistry` 与内置 `astar`、`dijkstra`；`PathAlgorithm` / `SearchGraph` 契约可接入自定义引擎；优先队列可替换。
- 度量：`haversine`（默认）、`cheap-ruler`、`euclidean` 或自定义 `Metric`；A\* 启发式对任意权重可采纳。
- 连通修复：`tolerance` 按真实距离合并顶点、`snapDangles` 连接悬挂端点、`splitIntersections` 打断交叉；度 2 顶点压缩成链。
- 吸附：`edge` / `vertex` / `node` / `exact` 四种模式、`maxDistance`、连通性感知分配；单独的 `nearest()`。
- 结果：`legs`、按来源要素聚合的 `sections`、`waypoints`、判别联合的失败原因、`toLineString()`。
- 产物：ESM、CommonJS、类型声明，以及 IIFE（全局 `GeoVerseLineFinder`）。
- 工程：GitHub Actions 的 CI（Node 20 / 22 全部门禁，Node 18 / 20 / 22 产物冒烟）与打 tag 发布（npm provenance）；中英文文档，中文为主。
