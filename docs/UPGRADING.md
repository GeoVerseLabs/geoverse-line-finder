# 从 0.1.0 升级到 0.2.0

🌐 简体中文 ｜ [English](UPGRADING.en.md)

## 默认配置：输出不变

不改任何选项时，`route()` / `findPath()` / `nearest()` 的结果与 0.1.0 **逐位相同**：`path`、`weight`、`distance`、`legs`（含引擎统计 `settled` / `relaxed`）、`waypoints` 的原有字段，以及失败时的 `reason` / `message` / 下标。`test/golden.test.ts` 用 0.1.0 生成的金样本锁定了这一点，覆盖 GPF 路网、随机网格、合成仓库与 13.5 万坐标的 OSM 路网。

结果对象只是**多了字段**（`networkWeight`、`skipped`、`waypoints[i].relocation`、`sections[i].fromMeasure` 等），不影响原有读取方式。

## 行为变化

| 变化                                                                                     | 影响谁                                         | 怎么处理                                                                   |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| 地理度量下坐标超出 `[-180, 180] × [-90, 90]`，或线段跨越 ±180° 经线，建图抛 `RangeError` | 误把投影坐标交给默认的 haversine 的使用方      | 投影坐标用 `metric: 'euclidean'`；0.1.0 在这种输入下算出的距离本来就是错的 |
| `stats.danglesSnapped` 把"端点恰好落在线段上（缝隙为 0）"也计入                          | 用该计数做质检或断言的使用方                   | 以新计数为准；连通结果本身不变                                             |
| `RouteFailureReason` 新增 `'ALL_SKIPPED'` 与 `'BUDGET_EXCEEDED'`                         | 对 `reason` 做穷举 `switch` 的 TypeScript 代码 | 补上两个分支；它们只在使用 `onFailure: 'skip'` 或 `budget` 时出现          |
| `SnapConnectivity` 新增 `'reachable'`                                                    | 穷举该类型的代码                               | 同上                                                                       |

## 自定义引擎

`PathAlgorithm` / `SearchGraph` 契约向后兼容，0.1.0 写的引擎照常工作。需要注意：

- 叠加层不再固定为 8 条边、2 个虚拟节点，`nodeCount` 与叠加层数组在不同查询之间可能变化并重新分配。**每次 `search` 开始时读取**（原来的写法本来就是这样），不要跨查询缓存这些数组。
- 新增的可选字段都有回退：没有声明 `capabilities.multiTarget` 的引擎，全程择优与一对多会改为逐个目标调用；没有声明 `capabilities.budget` 的引擎，`maxCost` 由库在结果上校验，`maxSettled` 不生效。
- 启发式现在可能返回 `Infinity`（ALT 判定该节点到不了目标）；把它当作"不入队"处理即可，当作普通数值也不会出错。

## TypeScript

声明文件在 TypeScript 5.0–5.9、`skipLibCheck: false` 下都能编译（0.1.0 的声明需要 5.7 及以上）。

## 用上新能力（以仓库拣选路线为例）

1. **不希望吸附位置被挪动**：`snap: { connectivity: 'nearest', maxDistance: 100 }`；或保留默认并设 `maxRelocation`。
2. **货位只能从朝向的通道进出**：逐点 `{ coordinates, snap: { featureIds: [aisleId] } }`；等级偏好写进权重，不要写成过滤条件。
3. **按全程代价选择接入通道**：`snap: { selection: 'optimal', costMode: 'arrive-depart', maxRelocation: 20 }`，并用 `totals.includeSnapWeight` 让 `weight` 含吸附代价。
4. **不可达的点**：`onFailure: 'skip'`（多点规划接口）或 `'straight'`（历史轨迹、热力）。
5. **每段都要含连接段的距离口径**：`connectors: 'legs'` + `totals.includeConnectorDistance`。
6. **热力按 10 m 分段**：`sectionsDetail: 'measure'`，按 `floor(measure / 10)` 分桶。
7. **数据质检**：建图时 `diagnostics: true`，读 `graph.diagnostics()`。
8. **多楼层重叠**：`group` 按楼层分组，电梯作为连接要素并配合 `zeroWeight: 'free'` 或固定权重。
9. **多线程**：主线程 `graph.toTransferable()`，Worker 里 `RoutingGraph.fromTransferable()`。
