# playground

geoverse-line-finder 的互动示例站点，部署在 GitHub Pages（`gh-pages` 分支，见 `.github/workflows/pages.yml`）。
🌐 English: a small interactive demo site for the library, deployed to GitHub Pages via the `gh-pages` branch.

## 本地运行

```bash
pnpm demo:dev       # 开发服务器，热更新（先生成哥德堡数据）
pnpm demo:build     # 构建到 examples/playground/dist（类型检查 → 生成数据 → 构建）
pnpm demo:preview   # 预览构建产物
pnpm demo:data      # 只重新生成 public/data/gothenburg.json
```

直接从仓库根的 `src/` 导入库（见 `vite.config.ts`），不需要先 `pnpm build`——改了 `src/` 里的代码，刷新页面就能看到。

## 结构

| 路径                                            | 内容                                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`                                    | 页面骨架：头部、场景 tab、SVG 画布 + MapLibre 地图容器、控制面板、结果面板                                                                                                                                                                                                        |
| `src/app.ts`                                    | 全部交互逻辑：场景切换、剖面切换（重建图并显示建图耗时）、点击加途经点、调用 `LineFinder`、组装叠加层                                                                                                                                                                             |
| `src/lib/view.ts`                               | 画布接口 `MapView`（`setNetwork` / `setOverlay` / `onClick` / `focus`）与叠加层类型，两种画布共用                                                                                                                                                                                 |
| `src/lib/svg-view.ts` · `svg.ts` · `project.ts` | SVG 画布：原生 DOM 画路网、路线、途经点、候选、诊断与换层标记，不依赖任何地图库；平面数据用它                                                                                                                                                                                     |
| `src/lib/maplibre-view.ts`                      | 地图画布：MapLibre GL JS + [OpenFreeMap](https://openfreemap.org/) 底图，路网与叠加层都是 GeoJSON 图层；打开地图场景时才按需加载；底图不可达时退回纯色背景，示例照常可用                                                                                                          |
| `src/scenarios/*.ts`                            | 五个场景：`warehouse`（候选约束 + 全程择优）、`gothenburg`（13.5 万坐标 OSM 路网上的浏览器内建图，驾车 / 步行两个剖面）、`multi-level`（多楼层：楼层切换、按层绘制、点要素电梯 + `pointConnector`、楼梯、扶梯）、`grid`（多途经点失败策略）、`gpf`（真实小路网，线段吸附 + 诊断） |
| `scripts/prepare-gothenburg.mjs`                | 从 devDependency geojson-path-finder 的 `large-network.json` 生成 `public/data/gothenburg.json`（只保留线要素与权重用到的标签，约 6 MB、gzip 1.2 MB）；该文件不入库，`demo:dev` / `demo:build` 会先生成它                                                                         |
| `public/data/network.json`                      | `test/fixtures/gpf/network.json` 的副本，供 `gpf` 场景运行时 `fetch`                                                                                                                                                                                                              |

## 加场景

实现 `src/scenarios/types.ts` 里的 `Scenario` 接口（网络 + 建图选项 + 默认路由选项 + 样式函数 + 要展示哪些控件 + 预设点对），
在 `src/scenarios/index.ts` 的数组里注册即可，`app.ts` 不需要改。经纬度数据设 `view: 'map'` 放到地图上；同一张路网有几种出行方式时给 `profiles`（每个剖面一套建图选项与样式，切换即重建）。

多楼层场景额外给出 `levels`（楼层列表 + 每个要素属于哪层）并打开 `features.levels`：界面会出现楼层按钮，新途经点带上当前层的 `snap.group`，路线经 `toLevelFeatures` 按层绘制（当前层实线、其他层淡显、换层段虚线），点换层标记跳到它通向的楼层。`styleOf` 的第三个参数 `context.level` 是当前显示的楼层。

## 为什么选它们

- **经纬度数据上地图，平面数据留在 SVG**：真实路网放到底图上才看得出吸附、单向与跨河这些"在哪儿"的问题；仓库、楼层平面、合成网格是平面坐标，配底图只会误导。两种画布实现同一个 `MapView` 接口，场景代码不区分。
- **MapLibre GL JS + OpenFreeMap**：开源、无需密钥；MapLibre 约 280 kB gzip，单独成块，只在打开地图场景时加载。MapLibre 6 按自身模块位置找 worker，打包后那个位置不存在——所以用 Vite 的 `?worker&url` 构建 worker 并 `setWorkerUrl`（见 `maplibre-view.ts`、`vite.config.ts` 的 `worker.format`）。
- **数据归属**：哥德堡路网来自 OpenStreetMap（© OpenStreetMap 贡献者，ODbL 1.0），地图右下角与数据文件的 `copyright` 字段都注明了出处；底图 © OpenMapTiles / OpenStreetMap。
- **直接引入 `src/`，不引入构建产物**：demo 与源码不会脱节；GitHub Pages 每次随 `main` 重新构建（见工作流），始终反映最新代码。
