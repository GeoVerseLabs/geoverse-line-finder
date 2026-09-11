# Changelog

🌐 简体中文 ｜ [English](CHANGELOG.en.md)

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)；0.x 期间，次版本号可能包含不兼容变更。

## 0.1.0 — 未发布

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
