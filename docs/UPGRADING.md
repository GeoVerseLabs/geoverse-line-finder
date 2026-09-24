# 升级指南

🌐 简体中文 ｜ [English](UPGRADING.en.md)

## 从 0.2.0 升级到下一版（多楼层）

不用 `group` 的路网不受影响：默认配置的输出仍与 0.1.0 逐位相同。以下只影响使用连通分组、吸附约束或 `connectors: 'legs'` 的场景。

| 变化                                                                | 影响谁                                                    | 怎么处理                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 连接要素的**中间坐标不再属于起点楼层**                              | 用 `mode: 'exact'` 或 `findVertex()` 定位楼梯踏步的使用方 | 改用楼梯两端的坐标；踏步本来就不该属于任何一层（它会让楼层从楼梯中段"抄近路"）                            |
| 带 `group` 的吸附**只扫描该组**                                     | 依赖"被其他楼层挤掉"这一错误行为的使用方（不太可能）      | 通常是修复：原先 3 层就可能误报 `SNAP_FAILED`。行为与"全网扫描 + 同一约束 + 不限扫描数"一致               |
| 新增失败细节 `detail: 'SCAN_LIMIT'`                                 | 对 `detail` 做穷举 `switch` 的 TypeScript 代码            | 补一个分支；它原先混在 `FILTERED` 里                                                                      |
| 候选描述 `group` 在楼梯中段为 `undefined`                           | 用 `candidate.group` 判断楼层的使用方                     | 楼梯中段确实不属于任何层；要定位楼梯用 `featureIds` 或 `filter`                                           |
| `connectors: 'legs'` 时 `sections[].start/end` 会跟着前置连接段平移 | 用这些下标去索引 `leg.path` 的使用方                      | 这是修复：原先指到的是错位的坐标。现在 `sections` / `transitions` / `levels` 三者与 `leg.path` 下标一致   |
| `GRAPH_FORMAT_VERSION` 由 `1` 变为 `2`                              | 断言 `data.formatVersion === GRAPH_FORMAT_VERSION` 的代码 | 没有楼层语义的图仍写 `1`；要判断"能不能读"请用新增的 `GRAPH_FORMAT_VERSIONS.includes(v)`                  |
| `WeightContext` 新增 `fromGroup` / `toGroup` / `rise`               | 自己构造 `WeightContext` 字面量的测试代码                 | 补上三个字段；权重函数本身不受影响（多出来的字段不影响调用）                                              |
| 配了 `verticalConnectors` 时 `graph.features` 变长                  | 按 `featureIndex` 回查输入要素的使用方                    | 合成要素追加在输入之后，数量是 `stats.verticalConnectors`；反序列化传输入要素即可，合成要素随头部一起回来 |

**开启多楼层要做的事**（都不是必须的，不配 `levels` 就保持原样）：

1. 加 `levels`，给每个楼层分组一个 `ordinal`（以及可选的 `elevation`）；
2. 确认**没有零代价的换层方式**——零长度电梯请给固定正代价，否则楼层下界退化为 0；
3. 跑一次 `graph.diagnostics()`，看 `connectorEnds` 与 `missingOrdinals`；
4. 电梯改用 `verticalConnectors` 声明，避免候梯代价按层重复计。

详见 [多楼层路径规划](MULTI_LEVEL.md)。

## 从 0.1.0 升级到 0.2.0

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
