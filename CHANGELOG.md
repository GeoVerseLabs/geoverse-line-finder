# Changelog

🌐 简体中文 ｜ [English](CHANGELOG.en.md)

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)；0.x 期间，次版本号可能包含不兼容变更。

## 未发布

默认配置（不用 `group` / `levels`）下的输出仍与 0.1.0 逐位相同（金样本测试不变）。以下只影响使用连通分组、楼层语义或吸附约束的场景。

### 新增：多楼层语义

完整说明见 [docs/MULTI_LEVEL.md](docs/MULTI_LEVEL.md)。引擎契约（`SearchGraph` / `PathAlgorithm`）没有变化，自定义引擎不受影响。

- **`levels` 建图选项**：给每个连通分组一个楼层序号 `ordinal`、可选标高 `elevation` 与显示名 `name`；可以是按 `String(groupKey)` 查的对象，也可以是函数。不配就什么都不启用。
- **楼层感知的 A\* 下界**：`h(u)` 增加 `perLevel · dist(ord(u), 目标楼层区间)` 一项。`perLevel` 按**连接器段**（而非链压缩后的链）推导，并有可采纳性论证、随机差分与性质测试。30 层合成楼栋上一趟竖向行程的展开节点数 883 → 30（`pnpm bench:features --only levels`）；目标在平面上也很远时收益很小，原因与边界见文档 §7.2。`graph.heuristic.perLevel` 可读。
- **`verticalConnectors` 建图选项**：按停靠站声明电梯 / 楼梯井 / 扶梯，展开为站间全连。一次乘坐是**一段**，代价 `boardCost + |Δ楼层| × perLevelCost`——逐跳连接要素会把候梯代价按层重复计。支持 `direction: 'up' | 'down'` 表达单向扶梯。
- **`WeightContext` 增加 `fromGroup` / `toGroup` / `rise`**：`rise` 是沿数字化方向的标高差（连接器中段按长度插值），楼梯可以写成 `ctx.distance + 8 * Math.max(ctx.rise, 0)`。
- **结果里的楼层**（仅在配了 `levels` 时出现）：`sections[].level`、`legs[].levels`（与 `path` 逐点对应）、`legs[].transitions`、`levelChanges`、`verticalDistance`。相邻连接器段之间没有同层段时合并为**一次**换层，所以逐跳电梯 F1→F2→F3 读出来是一次 `1 → 3`。
- **`toLevelFeatures(result)`**：独立导出（不用就被摇掉），把路线拆成按层的 `LineString`、换层段的 `LineString` 与换层点的 `Point`，室内地图按层渲染的直接输入。
- **`output: { z: 'elevation' }` 路由选项**：把标高写进路径坐标第三维（此时 `path` 是复制出来的坐标）。
- **楼层诊断**：`connectorEnds`（连接器端点没接上本层）、`levelReachability`（各层落在哪些连通分量、能到哪些层）、`missingOrdinals`（缺序号、会关掉楼层下界的分组）。
- **序列化格式 2**：有 `levels` 或 `verticalConnectors` 的图写 `formatVersion: 2`（楼层序号 / 标高 / 逐顶点标高三个缓冲区，头部带楼层名与合成要素），其余仍写 1；读取端两版都收，旧版读到 2 会明确报错。反序列化时传入输入要素即可，合成出来的连接器要素随头部一起回来。
- 示例站新增 **"多楼层 · 电梯 / 楼梯 / 扶梯"** 场景：楼层切换、按层绘制、可点击的换层标记。

### 修复

- **`snap.group` 被别的楼层挤出扫描范围**：分组约束原先是扫描后过滤，被过滤的其他楼层也计入 `searchLimit`（默认 64）。目标楼层的通道比其他楼层远时（下层密、上层稀），3 层就会误报 `SNAP_FAILED` / `FILTERED`。现在带 `group` 时只扫描该组的线段 / 顶点 / 节点（按组惰性建 R 树），结果与"全网扫描 + 同一约束 + 不限扫描数"一致（有随机对拍测试）。
- **连接要素的中间坐标被算进起点楼层**：楼梯的踏步 / 折返平台原先属于起点组，会与起点楼层上同坐标的顶点合并（楼层可以从楼梯中段"抄近路"），会被 `splitIntersections` / `snapDangles` 接到起点楼层，折返楼梯会在平面重合处自己短路，起点楼层的途经点也能吸附到楼梯中段。现在中间坐标**不属于任何组**：不合并、不修复，任何 `group` 约束都不接受；两端分组不同的线段内部同样不属于任何组。

### 新增

- 吸附失败细节 `detail: 'SCAN_LIMIT'`：`searchLimit` 个最近位置全被约束排除、更远处可能有允许位置时报它（原先混在 `FILTERED` 里），提示调大 `searchLimit`。
- `graph.vertexGroup()` / `segmentGroup()` / `groupSpatialIndex()`。

- **`connectors: 'legs'` 下 `sections[].start/end` 错位**：前置的直线连接段插入 `leg.path` 后，段落下标没有跟着平移，指到的是错位的坐标。现在 `sections`、`transitions` 与 `levels` 的下标都与 `leg.path` 一致。

### 变更

- 连接要素的中间坐标不再能被 `mode: 'exact'` 吸附，`graph.findVertex()` 也找不到它们。
- 候选描述 `group`：落在楼梯中段（中间坐标或两端不同组的线段内部）时为 `undefined`，原先按链方向取某一端的组。
- 拓扑诊断：连接要素不再报共线重叠（逐层重叠的楼梯本来就是这样画的）；悬挂端点的近距离未接通只看整段都在同组的线段，与 `snapDangles` 修复口径一致。
- `stats` 新增 `verticalConnectors`（展开出来的合成要素数量）；配了 `verticalConnectors` 时 `stats.features` 与 `graph.features.length` 包含它们。
- `GRAPH_FORMAT_VERSION` 由 1 改为 2（这一版能写的最新格式），新增 `GRAPH_FORMAT_VERSIONS`（能读的全部格式）。没有楼层语义的图仍写 1。
- **体积门禁上调**：consumer 29 000 → 33 500 B、IIFE 30 500 → 36 000 B。实测 27.8 → 31.8 KB / 29.7 → 34.0 KB gzip，多出来的 4.1 KB 全部是这一版的楼层层（分组索引 +0.7 KB、楼层语义 +3.4 KB）。结果转换 `toLevelFeatures` 是独立导出，不使用的话不计入。

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
