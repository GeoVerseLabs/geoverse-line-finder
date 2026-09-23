# geoverse-line-finder 架构说明

🌐 简体中文 ｜ [English](ARCHITECTURE.en.md)

> 面向维护者：为什么这样设计、各层边界在哪、怎么扩展。使用方式见 [README](../README.md)，性能数据见 [BENCHMARK](./BENCHMARK.md)，版本差异见 [UPGRADING](./UPGRADING.md)。

## 1. 调研结论：两个参考库各自强在哪、缺在哪

| 维度     | terra-route 0.0.18                                                                       | geojson-path-finder 2.1.0                                                   | 本库取舍                                                                |
| -------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 图存储   | CSR（`Int32Array` 偏移/邻接 + `Float64Array` 权重），坐标去重用 `Map<lng, Map<lat, id>>` | 对象套对象（`Record<string, Record<string, number>>`），键是 `"x,y"` 字符串 | **CSR + 嵌套 Map**（取 terra-route），可序列化后跨线程共享              |
| 搜索     | A\* + 四叉堆 + 按查询打戳的 scratch 缓冲 + ALT 地标（第 256 次查询后启用）               | Dijkstra（tinyqueue），每个队列状态都拷贝整条路径数组                       | **A\* / Dijkstra / 双向 Dijkstra 可切换，可选有向 ALT 地标**            |
| 权重     | **不支持**（边权 = 距离）                                                                | `weight(a, b, props)` → 数字 / `{forward, backward}` / 假值 = 不可通行      | **完整兼容 GPF 契约**，另加 `context.distance`、声明式预设与零代价语义  |
| 单向     | 不支持（无向图）                                                                         | 支持                                                                        | 有向 CSR + 强连通分量                                                   |
| 连通条件 | 坐标必须**完全相同**                                                                     | `tolerance` 舍入合并（默认 1e-5°），格边界两侧的近点会漏合并                | **按真实距离的网格合并** + 悬挂端点修复 + 可选交叉打断 + 连通分组       |
| 起终点   | 必须是路网顶点，否则插入孤点后返回 `null`                                                | 必须是路网顶点，否则 `undefined`                                            | **四种吸附模式 + 多候选、硬约束与全程择优**                             |
| 图压缩   | 无                                                                                       | 度 2 顶点压缩 + 查询期"幽灵节点"（直接改写图，查询间共享可变状态）          | **链压缩 + 查询期只读叠加层**                                           |
| 途经点   | 无                                                                                       | 无                                                                          | **全程择优（分层动态规划）或逐段求解**，失败可跳过或以直线兜底          |
| 结果     | 仅几何                                                                                   | `path` + `weight` + 可选 `edgeDatas`（需写 reducer）                        | 几何 + 权重 + 长度 + 分段 + 按要素聚合的 `sections`（带里程）+ 合计分项 |
| 数据质量 | 无                                                                                       | 无                                                                          | 拓扑诊断：悬挂端点、近距离未接通、修复记录、共线重叠                    |

**两个实测发现**（都有测试钉住，见 `test/gpf-parity.test.ts`）：

1. GPF 自带测试里的终点 `[8.44651, 59.513920000000006]` 本身就是它 1e-5° 舍入的产物，真实顶点是 `[8.44650646, 59.51392406]`（相距约 0.5 m）。所以"终点必须是顶点"这个约束在它自己的测试里也是靠容差蒙混过去的——这正是本库默认做线段吸附的理由。
2. GPF 在它自带的 large-network.json（OSM 单向路网）上，60 个随机点对里有 7 对返回**合法但非最短**的路线（多 0.02%～2.9%）。根因与验证过程见 §8。

## 2. 分层与数据流

```
NetworkCollection ──► topology.ts ─────────────────► build.ts ──────────────────────► RoutingGraph（只读、可共享、可序列化）
  (LineString /        │ 抽取线段（按要素/部分/坐标序） │ 权重 → forward/backward          │ 惰性：强连通分量、反向 CSR、节点-链索引、
   MultiLineString)    │ VertexStore 按连通分组合并     │ 沿要素部分累计里程                │       顶点 / 节点 R 树
                       │ 坐标范围与反经线守卫           │ chains.ts：度 2 顶点压缩成链      │ diagnostics() / toTransferable()
                       │ ConnectivityRepair（不跨组）   │ 有向 CSR、弱连通分量
                       │  · snapDangles                 │ A* 启发式数据（嵌入 + 最小代价比）
                       │  · splitIntersections          │ 线段 R 树（吸附用）
                       │ 修复日志（diagnostics: true）  │

LineFinder.route(waypoints, options)
  ├─ options.ts     途经点解析（含 { coordinates, snap }）、选项校验与逐点合并
  ├─ snap.ts        候选：R 树最近邻 → 锚点 → 关联要素 / 侧向 / 里程 → 去重 → 硬约束
  ├─ nearest.ts     最近选择：连通性分配 → 逐段 solvePair → 失败策略
  │  optimal.ts     全程择优：分层动态规划，每层一次多源多汇搜索，穿越式途经点，失败策略
  ├─ search.ts      叠加层接线、分量快速拒绝、调用引擎（多汇 / 预算的能力回退）
  │    query-graph.ts  叠加层：动态容量、虚拟节点、种子边、按起点的邻接链表
  │    PathAlgorithm   astar / dijkstra / bidijkstra / 用户引擎；启发式可叠加 ALT 地标
  └─ compose.ts     assemble.ts 组装几何与 sections → 连接段、合计分项、途经点明细
LineFinder.oneToMany / matrix ──► many.ts（一次多汇搜索得到一对多代价）
```

### 2.1 目录

| 路径                        | 职责                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `src/types.ts`              | 结构化的最小 GeoJSON 类型（不依赖 `@types/geojson`，但与之兼容）与途经点输入类型          |
| `src/geo/metric.ts`         | 度量：haversine / cheap-ruler / euclidean / 自定义；`embed` 提供可采纳启发式              |
| `src/geo/segment.ts`        | 点到线段投影、线段求交                                                                    |
| `src/heap/`                 | `Heap` 接口 + 四叉堆（来自 terra-route，MIT）                                             |
| `src/spatial/rtree.ts`      | 静态 Hilbert 打包 R 树（布局来自 flatbush，ISC），精确距离的最佳优先最近邻；可从数组重建  |
| `src/graph/vertex-store.ts` | 按连通分组的顶点去重/合并                                                                 |
| `src/graph/topology.ts`     | 线段抽取、输入守卫、连通性修复（union-find 合并 + 按 t 排序的拆分请求）、修复日志         |
| `src/graph/chains.ts`       | 度 2 压缩                                                                                 |
| `src/graph/build.ts`        | 构建管线：权重、里程、链、CSR、分量、启发式数据、R 树                                     |
| `src/graph/graph.ts`        | 只读图（扁平 TypedArray）与惰性派生索引                                                   |
| `src/graph/scc.ts`          | 迭代版 Tarjan 强连通分量                                                                  |
| `src/graph/diagnostics.ts`  | 拓扑诊断                                                                                  |
| `src/graph/serialize.ts`    | 图的可传输格式                                                                            |
| `src/weight/weight.ts`      | GPF 兼容权重契约 + 预设                                                                   |
| `src/algorithm/`            | 引擎契约、scratch、共享的 best-first 内核、Dijkstra、A\*、双向 Dijkstra、ALT 地标、注册表 |
| `src/snap/snap.ts`          | 候选模型、锚点、强连通键                                                                  |
| `src/route/`                | 选项、叠加层、搜索接线、两种选择器、一对多、结果组装、`LineFinder` 门面、GeoJSON 输出     |

`src/` 禁止依赖 Node 内置模块（ESLint 规则 + 不带 Node 类型的 `tsconfig.lib.json` 双重把关），浏览器 / Worker / Node 通用；运行时零依赖。

## 3. 权重

契约与 GPF 完全一致，已有的 GPF 权重函数可直接传入：

- 正数：双向同价；`{ forward, backward }`：分方向（forward = 数字化方向 a→b）；
- `0`、`NaN`、`Infinity`、`null`、`undefined`、`false`：该方向不可通行；
- **负数直接抛 `RangeError`**（GPF 会把负权原样喂给 Dijkstra，结果静默错误）。

增强点：

- 第 4 个参数 `context = { distance, featureIndex, feature }`，`distance` 是已按度量算好的线段长度，时间型权重不必再算一遍距离。
- 预设：`createPropertyWeight`（长度 × 系数，可单向）、`createSpeedWeight`（km/h → 秒）、`osmDirection`（OSM oneway/roundabout 语义）。
- `zeroWeight: 'free'` 让 `0` 表示零代价通行（楼层间的零长度连接边需要它）；默认仍是不可通行，保持 GPF 兼容。
- 查询期代价按线段内均匀分布计算：吸附点在线段内部时，部分代价 = 比例 × 线段代价。

## 4. 算法引擎

### 4.1 契约

```ts
interface PathAlgorithm {
  name: string;
  usesHeuristic: boolean;
  capabilities?: { multiTarget?: boolean; budget?: boolean };
  search(request: SearchRequest): SearchResult;
}
interface SearchRequest {
  graph: SearchGraph;
  source: number;
  target: number;
  heuristic: Heuristic | null;
  scratch: SearchScratch;
  targets?: ArrayLike<number>; // 多汇：全部定标后停止
  maxCost?: number; // 不需要比它更贵的路径
  maxSettled?: number; // 最多定标这么多节点
}
interface SearchResult {
  found;
  cost;
  nodes;
  edges;
  settled;
  relaxed;
  targetPaths?;
  budgetExceeded?;
}
```

- `SearchGraph` = 基图 CSR + 叠加层数组。节点号 `< baseNodeCount` 有 CSR 邻接；每展开一个节点，还要处理 `overlayFrom === node` 的叠加边——可以全量扫描，也可以用可选的 `overlayFirst(node)` / `overlayNext` 链表，两者给出**相同顺序**的边。可选的 `reverseOffsets` / `reverseSources` / `reverseCosts` / `reverseEdgeIds` 提供基图的反向邻接（惰性构建）。
- 启发式可以返回 `Infinity`，表示该节点到不了目标，引擎可以不入队。
- **回退**：没有声明 `multiTarget` 的引擎，多汇请求由库拆成逐个目标的单汇搜索；没有声明 `budget` 的引擎，`maxCost` 由库在结果上校验，`maxSettled` 不生效。0.1.0 写的引擎因此无需修改。
- 注册：每个 `LineFinder` 持有自己的 `AlgorithmRegistry`（预装 `dijkstra`、`astar`），`registerAlgorithm()` 追加；`route(..., { algorithm })` 也可直接传引擎对象。`test/algorithms.test.ts` 用只依赖公开契约的 Bellman-Ford 引擎、`test/optimal.test.ts` 用没有任何能力声明的朴素引擎证明扩展点够用。
- 堆可换：`new LineFinder(net, { heap: MyHeap })`。

内置 `dijkstra` 与 `astar` 共用 `best-first.ts` 内核：惰性删除；堆内并列按插入顺序打破，结果稳定；闭节点在被更优标号时重开（零启发式下不可能触发）；多汇时用 `scratch.targetMark` 计数，全部定标即停；`maxCost` 在堆顶键超过它时停止（键是完整路径代价的下界），`maxSettled` 限制工作量。叠加边多于 8 条时才用邻接链表，否则直接扫描——两者顺序相同，所以对 0.1.0 的两点查询连 `settled` / `relaxed` 都逐位一致（见 §8 金样本）。

### 4.2 A\* 启发式为什么对任意权重都可采纳

`h(v) = scale · ‖embed(v) − embed(target)‖`，其中

- `embed` 由度量提供，保证欧氏距离 ≤ 度量距离：haversine 用球面三维坐标（弦长 `2R√h` ≤ 弧长 `2R·asin√h`，且每次求值无三角函数）；cheap-ruler / 平面度量用缩放后的平面坐标。
- `scale = min(线段代价 / 线段长度)`，对所有线段、两个方向取最小，再乘 `1 − 1e-6` 吸收浮点噪声与部分线段插值误差。

于是任意路径代价 ≥ scale × 路径长度 ≥ scale × 直线距离 ≥ h，既可采纳又一致。权重与距离无关（例如按跳数）或存在零代价的正长度线段时 scale 趋近或等于 0，A\* 退化得接近 Dijkstra，但结果依旧最优。自定义度量没有 `embed` 时启发式关闭。多个目标时取到最近目标的下界 `min_t h_t(v)`，最小值仍然一致。

### 4.3 有向 ALT 地标

`prepareLandmarks(graph, { count, strategy, active })` 在最大弱连通分量里选点，对每个地标 L 各跑一次正向、一次反向的全图搜索，得到 `d(L,v)` 与 `d(v,L)`（`LandmarkTable`，内存 `2 · count · N` 个 `Float64`）。选点策略：`'farthest'`（默认，每个新地标使到已选地标的往返距离最大）、`'planar'`（按扇区取离中心最远的节点）或显式节点列表。

查询期下界（三角不等式，两项都有限时成立）：

- `d(v,t) ≥ d(L,t) − d(L,v)`；`d(v,t) ≥ d(v,L) − d(t,L)`；
- 若 `d(t,L)` 有限而 `d(v,L) = ∞`：t 能到 L 而 v 不能，所以 v 到不了 t，返回 `Infinity`，直接剪枝（单向路网的"陷阱"一次排除）。

目标在链内部时，它只能经由链两端进出，因此 `d(L,T) = min(d(L,from) + 部分代价, d(L,to) + 部分代价)`（反向同理）是**精确值**，不损失下界质量。每个查询按"对起点的下界贡献"选前 `active` 个地标（默认 4），因为地标越多下界越紧，但每次求值 O(K)，可能反而更慢。最终 `h = max(几何下界, ALT 下界 × (1 − 1e-9))`：两个一致势函数取最大仍一致，收缩吸收浮点误差。不在最大分量里的节点没有地标距离，相应项被跳过，退回几何下界。表与图、权重一一对应（`matches()` 校验节点数与边数），可 `toTransferable()` 传入 Worker。

### 4.4 双向 Dijkstra

`bidirectionalDijkstra`（名称 `'bidijkstra'`）同时从源点沿正向、从目标沿反向（基图反向 CSR + 叠加层的入边表）扩展，每次扩展键较小的一侧；任一侧给某节点更新标号且该节点已被另一侧访问时更新最佳相遇代价 μ，两侧堆顶键之和 ≥ μ 时停止。某一侧耗尽时 μ 已经最优（该侧可达的每个节点都已定标，含对方的起点）。多汇请求或给了 `maxCost` 时退回单向内核。它在没有可用启发式时有价值，是否值得用见 BENCHMARK。

## 5. 吸附

### 5.1 建图期：让该连的连上

| 手段         | 选项                         | 做法                                                                                                | 为什么                                                                    |
| ------------ | ---------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 顶点合并     | `tolerance`（米 / 平面单位） | 网格单元 ≥ 容差，查 3×3 邻域并用真实距离判定；经度方向按路网最高纬度放大单元；只在同一分组内合并    | GPF 的舍入法对"骑在舍入边界两侧"的两点无能为力，哪怕相距 0.02 m（有测试） |
| 悬挂端点修复 | `snapDangles`                | 度 1 顶点吸到阈值内最近线段（排除自身线段及其唯一邻点的线段，免得短支线折回自身），线段在投影处拆分 | 数字化时常见的"差一点没接上"的 T 字路口                                   |
| 交叉打断     | `splitIntersections`         | R 树找候选对，X 交叉建新顶点、T 形接触用现成端点拆分；连接要素（两端分组不同）不参与                | 数据未在交叉处共点；立交与楼层用 `group` 分开                             |

所有合并记在 union-find、所有拆分记成 `(t, vertex)` 请求，最后一次性应用——检测阶段始终基于原始线段编号，不会因边改边查而错位。缝隙为 0 的悬挂端点（端点恰好落在线段上）虽然 union 不变，但拆分建立了连接，同样计入 `danglesSnapped`。

**输入守卫**：地理度量下坐标超出经纬度范围（通常是误传了投影坐标）或相邻坐标经度差超过 180°（跨反经线，R 树、投影与 cheap-ruler 嵌入都不支持）时抛 `RangeError`，而不是静默算出错误距离。

### 5.2 候选模型

`searchCandidates` 是所有吸附的唯一入口（`nearest()`、`candidates()`、两种选择器、一对多）：

1. **命中**：`edge` 模式沿线段 R 树按精确距离最佳优先遍历并投影；`vertex` / `node` 用惰性构建的顶点 / 节点 R 树；`exact` 直接查 `VertexStore`（可限定分组）。带 `group` 约束时改扫该组的惰性 R 树（`graph.groupSpatialIndex()`：至少一端在该组的线段、该组的顶点或节点），其他楼层既不占扫描数，也挡不住本层的候选；本层范围内一无所获时再对全网探一次，用来区分 `FILTERED`（附近只有别的楼层）与 `NONE_WITHIN`。每个命中带锚点（节点，或链 + 链上位置）、所在链与线段槽位。
2. **描述**（`CandidateInfo`）：关联要素（节点锚点取所有关联链端的要素，链内部顶点取前后两段的要素）、主要素的 `featureId`、相对**数字化方向**的侧向（局部缩放平面上的叉积，链方向与数字化方向相反时取反）、沿主要素的里程、分量与分组。
3. **去重**：`'chain'` 按"链 + 来源要素"——压缩后的一条链可能串起多个要素（例如一圈通道只有一条链），每个要素都是一种接入方式；节点锚点按节点。另有 `'feature'`、`'component'`，以及内部使用的强连通键。
4. **约束**：`maxDistance` → 去重键未出现过 → `group` / `featureIds`（按关联要素集合求交，路口不会被误拒）/ `filter`。被约束拒绝的候选**不占用**去重键和数量上限，但计入 `searchLimit` 的扫描数，以免约束很严时无限扫描；扫满仍无一可用时失败原因为 `SCAN_LIMIT`（而不是 `FILTERED`），提示调大 `searchLimit`。
5. **排序**：按距离稳定排序，并列保持空间索引顺序（确定），`rank` 即名次。

### 5.3 最近选择与连通性

`selection: 'nearest'` 时每个途经点取最近的允许位置，再按 `connectivity` 分配：

- `'connected'`（默认）：每个途经点按弱连通分量各留最近候选（最多 16 个）。若最近候选已同属一个分量就照常使用；否则挑一个**所有途经点都有候选**、且每个途经点多挪的距离不超过 `maxRelocation` 的分量，使总吸附距离最小。找不到时报 `DISCONNECTED`（被 `maxRelocation` 挡住时 `detail: 'RELOCATION_LIMIT'`）。
- `'reachable'`：同样的分配，但按**强连通分量**：锚点在节点上取该节点的 SCC；在链内部时，只有链两端同属一个 SCC、且该点既能从链端到达又能离开到链端时才算属于它。所有途经点落在同一个 SCC 意味着每一段都一定存在，单向路网上也不会出现"同一弱分量却不可达"。
- `'nearest'`：从不挪动。

强连通分量由 `scc.ts` 的**迭代版** Tarjan 惰性计算（显式调用栈，20 万节点的单向长链也不会栈溢出，有测试）。默认配置沿用 0.1.0 的扫描顺序与提前停止条件，因此输出逐位相同。

### 5.4 叠加层代替幽灵节点

落在链内部的点变成虚拟节点，与链两端节点以部分链边相连。两点查询沿用 0.1.0 的编号（源 = `N`，汇 = `N+1`）；全程择优与一对多用 `addVirtual()` 申请更多虚拟节点，并用**种子边**（`chain = -1`，没有几何）让虚拟超级源同时从多个位置出发。容量按需翻倍；每个起点的出边以链表串起、保持插入顺序。基图从不被修改，所以：

- 同一个 `RoutingGraph` 可被多个 `LineFinder` 共享（`new LineFinder(graph)`）；
- 查询间不会相互污染（GPF 的幽灵节点直接写进 `compactedVertices`，靠 `finally` 删除）。

### 5.5 全程择优：分层动态规划

`selection: 'optimal'` 时，每个途经点保留至多 `candidates` 个候选（默认 4），剔除比最近候选远出 `maxRelocation` 以上的，再按途经点顺序做动态规划：

- **层**：每个途经点一层，每个选项有到达代价 `net[d]`（不含自身吸附代价）与离开代价 `depart[e]`。起点层 `depart = 起点吸附代价`。
- **吸附代价**：`raw = cost(candidate)`；`'ends'` 只计起点离开、终点到达；`'arrive-depart'` 另计途经点的到达与离开；`'none'` 全为 0。
- **层间转移 = 一次多源多汇搜索**：虚拟超级源 S 以种子边连到上一层每个可离开的候选（代价 `depart[c]`；候选在链内部时先连到它的虚拟节点，再连到链两端），本层每个候选作为一个目标（在链内部时为虚拟节点，同链候选之间补直连的部分链边）。在这张图上从 S 出发的最短路恰好是 `min_c depart[c] + net(c → d)`，所以**一次搜索给出本层所有目标的最优值**；每条目标路径的第一条边是种子边，据此得知来自哪个 c。启发式取到本层候选的最小下界，并以上一层候选作为 ALT 选地标的起点。
- **离开**：非穿越式 `depart[d] = net[d] + 到达代价(d) + 离开代价(d)`，进出同一个候选；`passThrough` 的途经点 `depart[e] = min_d(net[d] + 到达代价(d)) + 离开代价(e)`，O(K)。
- **终点与回溯**：取 `net[d] + 终点到达代价(d)` 最小者，沿 `prevArr` / `prevDep` 回溯出每层的到达与离开候选；每段的 `weight` 按路径边重新从 0 求和，与两点查询口径一致。
- **失败**：某层全部不可达时，`'fail'` 报 `UNREACHABLE`；`'skip'` 丢弃该途经点、保留上一层继续转移；`'straight'` 以直线代价补全转移。吸附失败的途经点在 `'straight'` 下作为坐标即输入点的伪候选，只参与直线转移。
- **确定性**：种子按候选名次加入叠加层，堆内并列先进先出，因此同样输入得到同样输出。
- **代价**：n − 1 次多汇搜索，每层 O(K) 内存；不支持多汇的引擎会被拆成每层 K 次搜索。
- **"抄近路"**：吸附腿是直线，比沿路网走更短。`costMode: 'none'` 时吸附免费，择优会系统性地选择远处的候选来缩短路网段——这是目标函数本身的结果，不是缺陷。文档建议配合 `'ends'` / `'arrive-depart'` 与 `maxRelocation` 使用。

`test/optimal.test.ts` 用"枚举全部候选组合 + 不共享代码的朴素 Dijkstra"的暴力参照，在随机网格上（含穿越式途经点）逐条比对总代价。

## 6. 路线组装与失败策略

最近选择下各段逐段求解，锚点从第一个可用途经点开始：

- 吸附失败或不可达的途经点，`'fail'`（默认）立即返回失败，与 0.1.0 相同；`'skip'` 记入 `skipped`、锚点不变并尝试下一个点（起点吸附失败时只有 `skip.leading` 才跳过）；`'straight'` 生成 `kind: 'straight'` 的直线段（端点优先取吸附位置），权重为 `straightCost(length)`。
- 跳过数超过 `skip.max` 时整体失败；一段都没有时返回 `ALL_SKIPPED`。
- 搜索预算：`maxSettled` 触发时为 `BUDGET_EXCEEDED`；超过 `maxCost` 视为不可达（`detail: 'BEYOND_MAX_COST'`）。

`compose.ts` 把规划结果变成公开结果：

- 各段几何在共享的途经点处去重拼接；穿越式途经点进出位置不同时，经输入点连接，这两小段计入 `connectorDistance`。
- `connectors: true` / `'ends'` 在整条路线首尾加连接段；`'legs'` 让每段从输入点到输入点。连接段只是几何，`totals.includeConnectorDistance` 才计入 `distance`；`totals.includeSnapWeight` 才把 `snapWeight` 计入 `weight`。
- `weight` = 各段权重之和（再加可选分项），`distance` 同理；另给 `networkWeight`、`networkDistance`、`straightDistance`、`complete`。
- `waypoints` 与输入一一对应，含 `snapped` / `used`、`nearestDistance` / `relocation`、`candidateRank`、`snapCost`，以及可选的候选报告（`SELECTED` / `FILTERED` / `RELOCATION` / `UNREACHABLE` / `NOT_SELECTED`）。
- 失败走判别联合而非抛异常（`reason` + 可选 `detail` + 下标）；只有配置错误（未知引擎、负权重、非法选项）才抛。

`oneToMany` 对源点与所有目标各取最近的允许位置，用一次多汇搜索得到到每个目标的权重（先按分量排除明显不可达的目标，目标不超过 16 个时才用 A\* 下界）；`matrix` 对每个起点调用一次。

## 7. 图数据模型

### 7.1 里程（线性参照）

拓扑阶段按"要素 → 部分 → 坐标"的顺序输出线段，拆分的碎片按参数 t 排序，所以每个要素部分的线段连续且有序。建图时在计算权重的同一个循环里沿部分累计线段长度，得到每段起止里程，再按链方向写入 `segments.measureStart` / `measureEnd`（附 `part`、`reversed`）。于是：

- 里程沿合并、打断**之后**的几何累计，与路线长度严格一致（`Σ|toMeasure − fromMeasure| = distance`，有属性测试）；非法坐标造成的断开处不计长度。
- 不再为里程单独计算一遍距离。最初的实现沿原始坐标重算距离，基准实测建图因此多出约一成耗时，改为复用权重循环里的长度后与 0.1.0 持平。

`sectionsDetail` 决定 section 的切分：`'feature'` 与 0.1.0 相同（按要素合并），`'measure'` 另在 part 变化或里程不连续（如穿过环线起点）时断开，`'segment'` 逐段输出。

### 7.2 连通分组

顶点身份是"分组 + 坐标"：`VertexStore` 为每个分组维护独立的精确 Map 或网格，合并与两种修复只在同组内进行。`group` 返回 `[起点组, 终点组]` 的连接要素，把每个部分的首坐标放入起点组、末坐标放入终点组；电梯这种零长度线因此成为两个不同顶点之间的线段。中间坐标（楼梯的踏步、折返平台）属于**无组**（`-1`）：不进 `VertexStore` 索引、不与任何顶点合并（只复用紧邻的重复坐标），两种修复与共线重叠诊断都跳过它们；落在两端不同组的线段内部的位置同样不属于任何组，任何 `group` 约束都不接受。这样楼梯不会与它跨过的楼层顶点合并，折返楼梯也不会在平面重合处短路。它的长度为 0，默认权重为 0 即不可通行，所以需要 `zeroWeight: 'free'` 或自定义固定权重。候选描述带分组，逐点 `snap.group` 与 `findVertex(x, y, group)` 可限定分组。

### 7.3 拓扑诊断

`diagnostics: true` 时建图顺便记录修复（合并 / 悬挂端点 / 打断，含位置、涉及的两个要素与缝隙）与非法坐标的位置；不打开时没有额外开销。`graph.diagnostics()` 在最终拓扑上惰性计算悬挂端点（只连一条链的节点）及其到同组其他链的最近距离、近距离未接通、各分量的外包框，以及用 R 树候选对检测的共线重叠。每个列表受 `limit` 限制并报告截断数。

### 7.4 序列化

`toTransferable()` 把全部表、R 树数组、分组键与诊断日志拷贝进独立的 `ArrayBuffer`（`shared: true` 时为 `SharedArrayBuffer`），头部带格式名、版本与按名称的布局表；原图不受影响，缓冲区可以直接作为 `postMessage` 的转移列表。`fromTransferable()` 校验格式、版本与每个缓冲区的字节数，用类型化数组视图**零拷贝**恢复各表，按原顺序追加顶点重建 `VertexStore`（因此 id 与合并行为一致），用 `PackedRTree.fromData` 恢复 R 树。内置度量按名称与参考纬度重建，自定义度量必须由调用方传入同名对象；要素属性不序列化，需要 `sections.properties` 时传入原要素。地标表单独序列化。

## 8. 正确性保障与 GPF 次优问题的根因

测试分几层（`pnpm test`）：

1. **金样本**：`test/fixtures/golden-0.1.0.json` 由 0.1.0 生成，涵盖 GPF 路网、随机网格（含修复与不压缩）、合成仓库与大型 OSM 路网；默认配置下 0.1.0 已有的全部结果字段（含 `settled` / `relaxed`）必须逐位相同。
2. **单元**：堆、R 树（对拍暴力）、度量（嵌入下界性质）、顶点合并、权重契约、强连通分量（对拍互相可达性）、地标表（对拍朴素全图搜索）。
3. **差分**：随机网格（权重系数 0.5–2.5、单向、封路、抖动形状点）上，Dijkstra / A\* × 压缩 / 不压缩与一个**不共享任何代码**的朴素参考逐对比对代价，并逐边重算返回的路径；线段吸附场景把吸附点插回参考网络后再比对；全程择优（含穿越式）与暴力枚举对拍；ALT、双向 Dijkstra、一对多与内置引擎逐条一致。
4. **对齐**：复刻 GPF 自带测试的全部断言；在 large-network.json 上与独立裁判逐对相等，并断言永不劣于 GPF。
5. **工程**：产物冒烟（ESM / CJS / IIFE + Worker 往返）、TypeScript 5.0 / 5.4 / 5.7 / 5.9 编译使用方代码、公开 API 报告（`etc/`）、体积门禁、覆盖率棘轮。

**GPF 次优的根因**（2026-09-11 排查）：GPF 压缩度 2 顶点时，`compactor.ts` 的 `compact()` 只有在邻点之间**尚无**直连边时才添加旁路边：

```js
if (!neighbor[otherNeighborKey] && weightFromNeighbor) { neighbor[otherNeighborKey] = weightFromNeighbor + vertex[otherNeighborKey]; … }
```

若已有一条更贵的直连边（平行道路、单向对向车道），更便宜的旁路被丢弃，压缩后的图丢失了最短路。验证方式见 `docs/BENCHMARK.md` 的"根因实验"：对同样的点对，GPF 自己的 Dijkstra 跑**未压缩**图全部最优；只改这一行守卫后 GPF 的结果也全部最优。本库的链压缩只合并度 2 顶点、不做"邻点间旁路"式合并，平行链作为多重边全部保留，因此不存在该问题。

## 9. 已知限制与路线图

- 不支持跨 ±180° 经线的路网：0.2.0 起建图时直接报错。
- `splitIntersections` 不处理共线重叠（`diagnostics().overlaps` 会列出）；三条线交于同一点且 `tolerance = 0` 时，浮点求出的交点可能不完全相同，建议配合一个很小的容差。
- 顶点合并是"先到者为代表"，不做传递闭包（A≈B、B≈C 但 A≉C 时 C 不并入 A），因此要素顺序会影响拓扑；打开 `diagnostics` 可以看到每次合并。
- 地标只布在最大弱连通分量里；其他分量上的查询结果不变，只是不加速。
- 双向 Dijkstra 遇到多汇请求或 `maxCost` 时退回单向搜索。
- 序列化保留坐标的前三维；自定义度量需要调用方在反序列化时提供。
- 路线图（不排期，按需求触发）：按行驶方向的停靠侧（叠加层可按方向拆分候选，无需再改契约）、基于代价矩阵的途经点排序、增量扩图（与只读图冲突；交互式场景建图超过 50 ms 时再评估）、跨反经线支持、地标 Float32 保守存储与按分量布点。明确不做：GPS 轨迹地图匹配、转向代价。
