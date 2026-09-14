# 基准与诊断脚本

🌐 简体中文 ｜ [English](README.en.md)

| 脚本                                   | 用途                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm bench` (`run.ts`)                | geoverse-line-finder / geojson-path-finder 2.1.0 / terra-route 0.0.18 三库对比 |
| `pnpm bench:features` (`features.ts`)  | 0.2.0 功能：默认配置对 0.1.0 回归、ALT 地标、双向 Dijkstra、全程择优开销与收益 |
| `pnpm bench:gpf` (`gpf-root-cause.ts`) | 复现 geojson-path-finder 次优路线并验证根因                                    |
| `osm-weight.ts`                        | GPF 测试用的 OSM 通行时间权重，原样移植，双方共用同一个函数                    |

## 数据

使用 geojson-path-finder 自带的测试路网，按以下顺序查找：`--data <dir>` → 环境变量 `GLF_BENCH_DATA` →
`D:/workspace/item/gis-project/item-gis-bam/node_modules/geojson-path-finder/test` → 本仓 devDependency 里的
`node_modules/geojson-path-finder/test`（npm 包自带 test 目录，所以换机器也能跑）。

| 文件                 | 规模                                                                  | 用在                      |
| -------------------- | --------------------------------------------------------------------- | ------------------------- |
| `network.json`       | 44 条线 / 932 坐标                                                    | `network` 场景            |
| `large-network.json` | 20120 条线 / 13.5 万坐标（哥德堡 OSM，含 107 个面要素，基准前过滤掉） | `large`、`osm` 与功能基准 |

`features.ts` 的 0.1.0 对照组是 npm 上发布的包，以别名 `glf-baseline` 装在 devDependencies 里；仓库场景使用 `test/fixtures/warehouse.ts` 生成的合成仓库。

## 用法

```bash
pnpm bench                                   # 默认 5 轮、每轮 300 对
pnpm bench -- --rounds 7 --pairs 500
pnpm bench -- --only osm                     # network,large,osm 任选
pnpm bench:features                          # regression,alt,bidirectional,optimal,quality 全部
pnpm bench:features -- --only alt,optimal
NODE_OPTIONS=--expose-gc pnpm bench          # 每次运行前强制 GC，降低噪声
```

每一轮都**从零构建**各参赛方（init）再跑同一批固定种子的查询；另有 1 轮热身不计入；每轮轮换执行顺序。
结果写入 `bench/results/<时间戳>.{md,json}` 与 `bench/results/features-<时间戳>.md`（已 gitignore）。

## 下结论前的两条硬规矩

1. **至少 3 轮，看分布而不是单个数**：两组 `[min–max]` 区间重叠的差异就是噪声，不能写成结论。
2. **别和其他重负载并行跑**（测试、构建、另一个基准），笔记本注意电源模式；结论要写明机器与 Node 版本。

`worse than best` 列统计该库在多少点对上的代价高于所有参与者中的最优值（相对误差 1e-6），`weight mismatches` 列统计与第一个参赛方权重不一致的查询数：它们是正确性信号而非性能信号。
terra-route 不支持权重，只参与"最短距离"场景，其代价由返回几何按 haversine 重算。
