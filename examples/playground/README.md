# playground

geoverse-line-finder 的互动示例站点，部署在 GitHub Pages（`gh-pages` 分支，见 `.github/workflows/pages.yml`）。
🌐 English: a small interactive demo site for the library, deployed to GitHub Pages via the `gh-pages` branch.

## 本地运行

```bash
pnpm demo:dev       # 开发服务器，热更新
pnpm demo:build     # 构建到 examples/playground/dist（先做一次类型检查）
pnpm demo:preview   # 预览构建产物
```

直接从仓库根的 `src/` 导入库（见 `vite.config.ts`），不需要先 `pnpm build`——改了 `src/` 里的代码，刷新页面就能看到。

## 结构

| 路径                       | 内容                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.html`               | 页面骨架：头部、场景 tab、SVG 地图、控制面板、结果面板                                                                                                                        |
| `src/app.ts`               | 全部交互逻辑：场景切换、点击加途经点、调用 `LineFinder`、渲染结果                                                                                                             |
| `src/lib/project.ts`       | 数据坐标 ↔ SVG 坐标的投影（平面按比例缩放；地理坐标按参考纬度压缩经度）                                                                                                       |
| `src/lib/svg.ts`           | 用原生 DOM API 画路网、路线、途经点、候选、诊断标记、换层标记（不依赖任何地图库）                                                                                             |
| `src/scenarios/*.ts`       | 四个场景：`warehouse`（候选约束 + 全程择优）、`multi-level`（多楼层：楼层切换、按层绘制、电梯 / 楼梯 / 扶梯）、`grid`（多途经点失败策略）、`gpf`（真实路网，线段吸附 + 诊断） |
| `public/data/network.json` | `test/fixtures/gpf/network.json` 的副本，供 `gpf` 场景运行时 `fetch`                                                                                                          |

## 加场景

实现 `src/scenarios/types.ts` 里的 `Scenario` 接口（网络 + 建图选项 + 默认路由选项 + 样式函数 + 要展示哪些控件 + 预设点对），
在 `src/scenarios/index.ts` 的数组里注册即可，`app.ts` 不需要改。

多楼层场景额外给出 `levels`（楼层列表 + 每个要素属于哪层）并打开 `features.levels`：界面会出现楼层按钮，新途经点带上当前层的 `snap.group`，路线经 `toLevelFeatures` 按层绘制（当前层实线、其他层淡显、换层段虚线），点换层标记跳到它通向的楼层。`styleOf` 的第三个参数 `context.level` 是当前显示的楼层。

## 为什么选它们

- **一律用 SVG，不引入地图库**：数据规模小（演示用），SVG 足够，也顺带证明这个库本身不需要地图引擎就能可视化。
- **直接引入 `src/`，不引入构建产物**：demo 与源码不会脱节；GitHub Pages 每次随 `main` 重新构建（见工作流），始终反映最新代码。
