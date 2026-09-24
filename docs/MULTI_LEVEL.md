# 多楼层路径规划

[English](MULTI_LEVEL.en.md) · [README](../README.md) · [架构说明](ARCHITECTURE.md) · [升级指南](UPGRADING.md)

室内导航与"平面重叠的路网"是两回事。0.2.0 已经能让楼层互不串线（`group`）、让电梯可通行（`zeroWeight: 'free'`），但库对"楼层"本身一无所知：分组键只是不透明的字符串，没有上下顺序，也没有标高。于是有三件事做不了——A\* 不知道"还差 12 层"，结果里看不出在哪儿换的层，按楼层渲染无从下手。

这一版补上的就是这层**楼层语义**。引擎契约（`SearchGraph` / `PathAlgorithm`）一行没动，自定义引擎不受影响；不配 `levels` 的路网与以前逐位相同。

---

## 一、这一版新增了什么

| 能力                | 入口                                                                                 | 解决的问题                                                 |
| ------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| 楼层元数据          | `levels`（建图选项）                                                                 | 分组有了楼层序号、标高和显示名                             |
| 楼层感知的 A\* 下界 | 自动启用（`graph.heuristic.perLevel`）                                               | 竖向长途不再把起点层和中间层铺满，30 层实测展开数 883 → 30 |
| 声明式竖向连接器    | `verticalConnectors`（建图选项）                                                     | 一次乘坐 = 一段，上下梯代价只计一次，不再逐层重复计        |
| 按爬升计价          | `WeightContext` 的 `rise` / `fromGroup` / `toGroup`                                  | 楼梯可以按真实爬升定价，而不是按平面长度                   |
| 结果里的楼层        | `section.level`、`leg.levels`、`leg.transitions`、`levelChanges`、`verticalDistance` | 看得出在哪儿换层、换了几层、爬升多少                       |
| 按层渲染            | `toLevelFeatures(result)`（独立导出，不用就被摇掉）                                  | 室内地图一次只显示一层，这是直接输入                       |
| 输出 z              | `output: { z: 'elevation' }`                                                         | 路径坐标带上标高，可直接喂三维视图                         |
| 楼层诊断            | `diagnostics().connectorEnds / levelReachability / missingOrdinals`                  | 电梯没接上楼层、哪些层互相不可达、哪些层缺序号             |
| 序列化 v2           | `toTransferable()` 自动切换                                                          | 楼层信息与合成连接器随图一起过 Worker                      |

> 除此之外还修了一处旧行为：带 `connectors: 'legs'` 时，`sections[].start/end` 之前没有跟着前置连接段一起平移，指到的是错位的坐标；现在 `sections`、`transitions`、`levels` 与 `leg.path` 三者下标一致。详见 [升级指南](UPGRADING.md)。

---

## 二、五分钟上手

```ts
import { LineFinder, toLevelFeatures } from 'geoverse-line-finder';

// 路网：每层的走廊 + 把楼层接起来的连接要素（电梯 / 楼梯 / 扶梯）
const finder = new LineFinder(building, {
  metric: 'euclidean', // 室内一般是投影坐标（米）
  splitIntersections: true, // 只在各楼层内部打断，连接要素不参与

  // 1）哪些顶点能连在一起：楼层分组；连接要素返回 [起点组, 终点组]
  group: (p) => (p.kind === 'corridor' ? p.floor : [p.from, p.to]),

  // 2）这一组是第几层、标高多少（新增）
  levels: (g) => (typeof g === 'number' ? { ordinal: g, elevation: (g - 1) * 4, name: `F${g}` } : undefined),

  // 3）电梯是零长度线，给它一个固定正代价（不要用 0）
  weight: (a, b, p, ctx) => (p.kind === 'corridor' ? ctx.distance : 12),
});

const route = finder.route([
  { coordinates: [8, 8], snap: { group: 1 } }, // F1 的某个点
  { coordinates: [46, 21], snap: { group: 4 } }, // F4 的某个点
]);

if (route.ok) {
  route.levelChanges; // 3：一共跨了 3 层
  route.verticalDistance; // 12：爬升合计 12 m
  route.legs[0].transitions; // [{ fromLevel: 1, toLevel: 4, levelChange: 3, start, end, featureIndices, weight, distance }]
  toLevelFeatures(route); // 按层拆好的 FeatureCollection，直接丢给渲染
}
```

**三件容易忘的事**：

1. `levels` 不配就什么都不会变——楼层字段不出现，楼层下界不启用。它是开关。
2. 零长度电梯的默认权重 0 = 不可通行。要么给固定正代价（推荐），要么 `zeroWeight: 'free'`（但那样楼层下界会退化为 0，见 §七）。
3. 连接要素的首尾必须真的接上楼层网络：坐标与楼层顶点一致，或者靠 `tolerance` / `snapDangles` 接上。接没接上用 `diagnostics().connectorEnds` 查（§八）。

---

## 三、数据怎么建模

三种方式可以混用，一张图里可以同时有。

### 3.1 楼层要素

普通 `LineString` / `MultiLineString`，`group` 返回楼层键。各层平面完全重叠没关系——顶点身份是"分组 + 坐标"，合并、`tolerance`、`snapDangles`、`splitIntersections` 都只在同组内发生。

### 3.2 连接要素（逐跳）

`group` 返回 `[起点组, 终点组]` 的要素。每个部分的**首坐标进起点组、末坐标进终点组，中间坐标不属于任何组**：

| 部位             | 所属组 | 会与楼层顶点合并 | 参与修复 | 带 `group` 约束的途经点能吸附上去 |
| ---------------- | ------ | ---------------- | -------- | --------------------------------- |
| 首坐标           | 起点组 | 会               | 会       | 能                                |
| 中间坐标（踏步） | 无     | 不会             | 不会     | 不能                              |
| 末坐标           | 终点组 | 会               | 会       | 能                                |

```ts
// 电梯：零长度线，两端在不同楼层
line(
  [
    [10, 10],
    [10, 10],
  ],
  { kind: 'elevator', from: 1, to: 2 },
);

// 楼梯：带平面投影与中间平台，中间坐标不属于任何层
line(
  [
    [14, 20],
    [18, 24],
    [14, 20],
  ],
  { kind: 'stairs', from: 1, to: 2 },
);

// 扶梯：只上行 —— 在 weight 里返回 { forward: cost }
line(
  [
    [55, 20],
    [48, 20],
  ],
  { kind: 'escalator', from: 1, to: 2 },
);
```

**逐跳建模的代价语义问题**：F1→F2、F2→F3 两个电梯要素，走 F1→F3 会把"候梯 + 进出"这类一次性代价**计两次**，而且一次乘坐被拆成两段。楼梯、扶梯本来就是一段一段走的，逐跳没问题；电梯建议用下面的声明式写法。

### 3.3 竖向连接器（声明式，推荐用于电梯）

```ts
verticalConnectors: [
  {
    id: 'lift-core',
    kind: 'elevator',
    stops: [1, 2, 3, 4].map((f) => ({ group: f, position: [30, 20] })),
    boardCost: 8, // 一次乘坐的固定代价：候梯 + 进出
    perLevelCost: 2, // 每跨一层
    direction: 'both', // 'up' / 'down' 可表达单向扶梯
    properties: { kind: 'elevator', name: '核心筒电梯' },
  },
];
```

库把它展开成**站间全连**：每一对停靠站生成一条连接，代价 `boardCost + |Δ楼层序号| × perLevelCost`。所以 F1→F4 是 `8 + 3×2 = 14` 的**一段**，而不是三段各算一次候梯。

- 展开出来的要素追加在输入要素之后（`graph.features` 变长，`stats.verticalConnectors` 是它们的数量），`sections[].featureIndex` / `properties` 指向它。
- 停靠点的坐标会像普通端点一样并入该层的顶点：与楼层顶点坐标一致就直接合并，否则会成为孤立点（`connectorEnds` 会报出来）。
- `perLevelCost` 或 `direction` 用到了楼层序号，所以这两项要求对应分组在 `levels` 里有 `ordinal`，否则建图直接报错。
- n 个停靠站产生 n(n−1)/2 条线段。30 层 × 4 部电梯约 1 700 条，室内规模没问题；超过约 60 站的井道再考虑别的建模。

---

## 四、`levels` 选项

```ts
interface LevelInfo {
  ordinal: number; // 楼层序号：地下为负，相邻楼层差 1，夹层可用 1.5
  elevation?: number; // 标高（度量单位，通常是米）
  name?: string; // 显示名："B1"、"L3"
}

// 两种写法
levels: { '1': { ordinal: 1, elevation: 0, name: 'Ground' }, '2': { ordinal: 2, elevation: 4 } }  // 按 String(groupKey) 查
levels: (g) => (typeof g === 'number' ? { ordinal: g, elevation: (g - 1) * 4 } : undefined)        // 函数，也会收到 undefined（默认组）
```

- **`ordinal` 决定算法行为**：楼层下界、`levelChange` 都按它算。
- **`elevation` 决定物理量**：`WeightContext.rise`、`verticalDistance`、`output.z` 都来自它。不配就没有这三项。
- 返回 `undefined` / `null` = 这一组没有楼层语义（室外、中庭这类）。允许，但有代价，见 §七。

---

## 五、查询

```ts
finder.route(
  [
    { coordinates: a, snap: { group: 1 } }, // 逐点指定楼层
    { coordinates: b, snap: { group: 4 } },
  ],
  { output: { z: 'elevation' } }, // 可选：路径坐标写入第三维
);
```

`snap.group` 是硬约束，而且**只扫描该组的线段 / 顶点 / 节点**——别的楼层再密也不占用 `searchLimit`（这一版的修复，见 [升级指南](UPGRADING.md)）。

`output: { z: 'elevation' }` 会把标高写进路径坐标的第三维；连接器中段按长度线性插值。注意这时 `path` 里是**复制出来的坐标数组**，不再是输入网络里的那些对象。

---

## 六、结果怎么读

只有建图配了 `levels` 才会出现这些字段。

```ts
route.levelChanges; // Σ|levelChange|：一共跨了几层
route.verticalDistance; // Σ|Δ标高|：爬升 + 下降合计（有 elevation 时才有）

const leg = route.legs[0];
leg.levels; // 与 leg.path 逐点对应：楼层键 / undefined（默认组）/ null（连接器内部）
leg.transitions; // 每一次换层
leg.sections[0].level; // 这一段在哪层；连接器段为 null
```

`LevelTransition`：

```ts
{
  fromLevel: 1,            // 换层前所在层
  toLevel: 4,              // 换层后所在层
  levelChange: 3,          // 有符号，上行为正
  start: 1, end: 3,        // 在 leg.path 里的下标区间（含端点）
  featureIndices: [12, 13],// 构成这次换层的连接要素
  weight: 14, distance: 0,
}
```

**换层合并规则**：相邻的连接器段之间没有同层段时，合并为**一次**换层。逐跳电梯 F1→F2→F3 中间不下梯，读出来就是一次 `1 → 3, levelChange: 2`——这才是乘客的体感，也是 `levelChanges` 计的数。

### 按层渲染

```ts
import { toLevelFeatures } from 'geoverse-line-finder';

const { features } = toLevelFeatures(route);
for (const f of features) {
  switch (f.properties.kind) {
    case 'path': // LineString，一段连续同层路径；properties.level 是楼层
      if (f.properties.level === currentFloor) drawSolid(f);
      else drawGhost(f); // 其他层淡显（或干脆不画）
      break;
    case 'connector': // LineString，一次换层；properties.level === null
      drawDashed(f); // 它不属于任何一层，画虚线
      break;
    case 'transition': // Point，换层起点；属性同 LevelTransition
      drawMarker(f, () => setFloor(f.properties.toLevel)); // 点一下跳到它通向的楼层
      break;
  }
}
```

每个要素都带 `legIndex`、`legKind` 和 `start` / `end`（`leg.path` 的下标区间），要回查原始数据很方便。失败的路线、或者没配 `levels` 的图，返回空集合。

---

## 七、性能：楼层感知的下界

### 7.1 它是什么

A\* 的下界原本只有平面那一项：`h(u) = scale · |e(u) − e(t)|`。起点层上所有点在平面上离目标都差不多远，所以竖向长途时 h ≈ 常数，搜索会把起点层和中间层铺满。

新增的楼层项是：

```
h(u) = scale · |e(u) − e(t)|  +  perLevel · dist(ord(u), 目标所在楼层区间)
```

`perLevel` 是**跨一层最便宜要多少钱**，建图时从每一段连接器推导：

```
perLevel = min over 每个连接器段 R、每个可通行方向 of ( cost(R) − scale · |e(起点) − e(终点)| ) / |Δ楼层序号(R)|
```

这里的"连接器段"指一个连接要素的一个部分从起点组顶点到终点组顶点的整段（包括 `verticalConnectors` 展开出来的站间段），**不是链压缩后的链**。这点很关键：链压缩会把"很贵的 F1 走廊 + 楼梯 + F2 走廊"合成一条链，按链推导会得出离谱的大值，把真正的最短路剪掉。仓库里有专门固化这个反例的测试（`test/levels.test.ts` 里的 "prices one level from the connectors, not from the chains"）。

`graph.heuristic.perLevel` 可以直接读出来。

### 7.2 实测（30 层楼，每层 7×7 走廊网格，2 部电梯，1 350 个节点，`perLevel` = 4.00）

展开的节点数（`leg.settled`，确定性，跑一次即可）：

| 行程                 | Dijkstra | A\*（只有平面下界） | A\* + 楼层下界 | A\* + 楼层下界 + ALT(8) |
| -------------------- | -------- | ------------------- | -------------- | ----------------------- |
| F1 → F5              | 33       | 13                  | **5**          | 5                       |
| F1 → F10             | 186      | 84                  | **10**         | 10                      |
| F1 → F20             | 632      | 433                 | **20**         | 20                      |
| F1 → F30             | 1 082    | 883                 | **30**         | 30                      |
| F1 → F30，对角另一端 | 1 351    | 1 345               | 1 231          | 1 223                   |

复现：`pnpm bench:features --only levels`。

**最后一行是这套方法的真实边界，值得单独说**：目标在平面上也很远时，收益几乎没有。原因不在楼层项，而在平面项——走廊是曼哈顿网格，直线距离下界与真实步行距离差一个 √2 量级，几何项留下的松弛足以让"大部分节点看起来都还在最短路上"。这种场景要么靠 ALT（也只帮了 1%，因为等代价路径实在太多），要么接受它：这是网格路网对 A\* 的固有难点，不是楼层特性带来的。

竖向为主的行程——也就是室内导航的绝大多数查询——收益是一个数量级以上。

### 7.3 什么时候楼层下界会失效（`perLevel === 0`）

两种情况，都会让楼层项自动关掉（结果仍然正确，只是不加速）：

1. **有零代价的换层方式**。`zeroWeight: 'free'` 配上零长度电梯，跨一层就真的不要钱，下界只能是 0。**给电梯一个固定正代价**就好了。
2. **有分组带着可通行的路网却没有 `ordinal`**。比如 F3 经连接器到没有序号的室外，再经连接器上到 B 楼 F5——这两段连接器都不参与 `perLevel` 的推导，换层可能看起来"免费"，下界就不再可采纳。所以**只要有一个这样的分组，整张图的楼层项就关闭**。`diagnostics().missingOrdinals` 会告诉你是哪些分组。

另外，快速直达电梯（F1→F30 只要 30 秒）本来就是每层最便宜的换层方式，会把 `perLevel` 压得很低——这不是 bug，下界理应这么弱；此时靠 ALT。

### 7.4 按剖面建多张图

"无障碍路线不走楼梯"这类按查询变化的代价，做法是**每个剖面建一张图**，而不是在查询期加边掩码：

```ts
const walking = new LineFinder(building, { ...common, weight: walkWeight });
const stepFree = new LineFinder(building, { ...common, weight: stepFreeWeight }); // 楼梯返回 null
```

室内图很小（30 层约 1.3 万顶点，建图 0.1 s 量级），复制一份比给引擎契约加查询期状态划算得多，也不会和"热循环里不要闭包"的约束冲突。

---

## 八、诊断与排错

```ts
const d = graph.diagnostics();
d.connectorEnds; // 连接器端点在本层没接上任何其他线段 —— 室内数据最常见的错
d.levelReachability; // 每层：落在哪些连通分量、能到哪些层、是否完全孤立
d.missingOrdinals; // 缺 ordinal 的分组（它们会关掉楼层下界）
```

| 症状                                                | 先查                                                                             |
| --------------------------------------------------- | -------------------------------------------------------------------------------- |
| 明明有电梯，跨层却报 `UNREACHABLE` / `DISCONNECTED` | `connectorEnds`：电梯端点大概率没落在楼层顶点上；再看 `levelReachability`        |
| 建图后 `stats.components` 比楼层数还多              | `levelReachability[].isolated`，以及 `dangles` / `nearMisses`                    |
| 跨层路线能出来，但 `graph.heuristic.perLevel === 0` | `missingOrdinals`；没有的话就是有零代价连接器（§7.3）                            |
| 途经点报 `SNAP_FAILED` / `FILTERED`                 | `snap.group` 写对了吗；落在楼梯中段的位置**不属于任何层**，带 `group` 约束不接受 |
| 途经点报 `SCAN_LIMIT`                               | 该层附近确实没有允许的位置，调大 `snap.searchLimit`                              |
| 结果里没有 `levelChanges`                           | 建图没配 `levels`                                                                |
| 有 `levelChanges` 没有 `verticalDistance`           | `levels` 里没有任何 `elevation`                                                  |

---

## 九、Worker 与序列化

有 `levels` 或 `verticalConnectors` 的图写 `formatVersion: 2`（新增楼层序号、标高、逐顶点标高三个缓冲区，以及头部的楼层名与合成要素）；没有的图仍然写 1，字节与 0.2.0 相同。读取端 1 和 2 都收。

```ts
// 主线程
const data = graph.toTransferable();
worker.postMessage(data, data.buffers);

// Worker：传输入要素就够了，合成出来的竖向连接器要素随头部一起回来
const graph = RoutingGraph.fromTransferable(data, { features: network.features });
```

旧版本读到 `formatVersion: 2` 会明确报错，不会静默丢掉楼层信息。

---

## 十、兼容性与限制

- **默认输出不变**：不配 `levels` 的路网与 0.1.0 / 0.2.0 逐位相同（金样本测试保证）。楼层字段只在开启时出现，`toLevelFeatures` 是独立导出，不用就被摇掉。
- **引擎契约不动**：`SearchGraph` / `PathAlgorithm` 没有变化，楼层下界在库内构造、经 `heuristic` 注入，自定义引擎不需要改。
- **体积**：核心路径 +4.1 KB gzip（consumer 27.8 → 31.8 KB，IIFE 29.7 → 34.0 KB）。
- **不做的事**：三维距离引擎；时间相关代价（电梯候梯时段、扶梯按时段换向）；转向代价；从 IMDF 这类纯面数据生成路网骨架。

---

## 十一、试一下

**在线示例站**：仓库的 [GitHub Pages](https://geoverselabs.github.io/geoverse-line-finder/) 里有 **"多楼层 · 电梯 / 楼梯 / 扶梯"** 这一页——四层办公楼，各层平面完全重叠，三种上下方式代价不同。

- 左上角楼层按钮切层，新放的途经点会带上当前层的 `snap.group`；
- 路线按 `toLevelFeatures` 分层绘制：当前层实线、其他层淡显、换层段橙色虚线；
- 点橙色方块直接跳到它通向的楼层；
- 右侧面板有 `levelChanges`、`verticalDistance` 和换层明细表；
- 三个预设分别演示：电梯一次到顶（一次乘坐 = 一段）、楼梯比绕去电梯近、扶梯只上行所以下楼改走电梯。

**本地跑**：

```bash
pnpm install
pnpm demo:dev          # http://localhost:5173
pnpm test -- levels    # 多楼层测试（含随机差分与可采纳性性质测试）
pnpm bench:features --only levels   # §7.2 那张表
```
