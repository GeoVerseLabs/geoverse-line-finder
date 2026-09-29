# 发布清单

🌐 简体中文 ｜ [English](RELEASE.en.md)

> 发布到 npm 是对外动作：按工作区规范，**只有在用户明确指示后**才推送版本 tag。

## 流水线

| Workflow                        | 触发                    | 做什么                                                                                                                                                                                |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`      | 推送到 `main`、PR、手动 | Node 20 / 22 上跑 `pnpm check`（类型、lint、格式、测试 + 覆盖率棘轮、构建、产物冒烟），Node 22 上加跑 `pnpm check:package`；再在 Node 18 / 20 / 22 上**不装任何依赖**直接加载构建产物 |
| `.github/workflows/release.yml` | 推送 `vX.Y.Z` tag       | 校验 tag 与 `package.json` 版本一致、两份 CHANGELOG 已写日期 → 全部检查 → `npm publish --provenance` → 以两份 CHANGELOG 的对应段落创建 GitHub Release                                 |
| `.github/workflows/release.yml` | 手动运行                | 同上全部检查 + `npm publish --dry-run`，**不会发布**，用于演练                                                                                                                        |

## 一次性准备

- [x] npm 包名 `geoverse-line-finder` 未被占用（2026-09-11 查询返回 404）。
- [x] 本地已配置远端 `origin = https://github.com/GeoVerseLabs/geoverse-line-finder.git`；首次推送：`git push -u origin main`。
- [x] GitHub 仓库设为 **public**：npm provenance 只支持公开仓库（2026-09-29 核实：匿名访问仓库页返回 200）。
- [x] 在 npm 创建发布用的 granular access token（只授予本包的 publish 权限），存为仓库 Secret `NPM_TOKEN`（2026-09-29 核实：npm 上 0.1.0 / 0.2.0 都带 SLSA provenance，即由 `release.yml` 发布成功）。
- [ ] （可选）Settings → Environments 里给 `npm` 环境配置审批人，发布前需人工批准；该环境在首次运行时自动创建。
- [x] GitHub Pages 已启用（`gh-pages` 分支，https://geoverselabs.github.io/geoverse-line-finder/ 返回 200，2026-09-29 核实）。
- [ ] （可选）首发之后可改用 npm Trusted Publishing（GitHub OIDC）：在 npm 包设置里登记本仓库与 `release.yml`，把工作流里的 npm 升到 11.5 以上后即可删除 `NPM_TOKEN`。

## 每次发版

1. 两份 CHANGELOG（`CHANGELOG.md` / `CHANGELOG.en.md`）把"未发布 / Unreleased"改成日期。
2. 改 `package.json` 的 `version`（或 `npm version <patch|minor|major> --no-git-tag-version`），提交 `chore(release): vX.Y.Z`。
3. 本地先过一遍：`pnpm check && pnpm check:package`，再 `npm pack --dry-run` 核对清单。
4. 推送 `main`，等 CI 变绿。
5. `git tag vX.Y.Z && git push origin vX.Y.Z`，Release 流水线自动发布并创建 GitHub Release。

## 发版记录

| 版本  | 日期       | 提交 / tag                               | 备注                                                                                                         |
| ----- | ---------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 0.1.0 | 2026-09-11 | `v0.1.0` → `c9d208b`                     | 首发                                                                                                         |
| 0.2.0 | 2026-09-14 | `v0.2.0` → `46a5e26`                     | 路线 M0–M5                                                                                                   |
| 0.3.0 | 2026-09-29 | `v0.3.0` → `chore(release): v0.3.0` 提交 | 多楼层、建图提速、`nodeId` / `pointConnector`；示例站接入地图引擎。`main` 已推送，tag 由维护者推送后触发发布 |

发布后核对：`npm view geoverse-line-finder version` 为新版本、`npm view geoverse-line-finder@<版本> dist.attestations` 带 provenance、GitHub Releases 出现对应条目、Pages 站点为最新示例。

应急手动发布：本地 `npm publish`，`prepublishOnly` 会先跑 `pnpm check` 与 `pnpm check:package`，任何一步失败即中止（手动发布不带 provenance）。

## 产物说明

| 文件                                  | 用途                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `dist/index.js` / `index.d.ts`        | ESM（`import`），可读代码                                               |
| `dist/index.cjs` / `index.d.cts`      | CommonJS（`require`）                                                   |
| `dist/geoverse-line-finder.global.js` | 压缩的 IIFE，全局 `GeoVerseLineFinder`；`unpkg` / `jsdelivr` 字段指向它 |

包内只有 `dist/`、中英两份 `README` 与 `CHANGELOG`、`LICENSE`（Apache-2.0）、`NOTICE`、`THIRD_PARTY_NOTICES.md` 和 `package.json`；
不带 sourcemap（ESM / CJS 本身可读，带上会让包体积翻几倍），运行时零依赖。
