# 发布清单

> 发布到 npm 是对外动作：按工作区规范，**只有在用户明确指示后**才执行下面的第 6 步。

## 一次性准备

- [x] npm 包名 `geoverse-line-finder` 未被占用（2026-09-11 查询返回 404）。
- [ ] 在 GitHub 建仓 `GeoVerseLabs/geoverse-line-finder`（与 map-server / sar / kb / live 同一组织），`git remote add origin` 后推送 `main`。
      `package.json` 的 `repository` / `homepage` / `bugs` 已按此地址填写；托管位置若不同，三处一起改。
- [ ] `npm whoami` 确认发布账号，且账号已开启 2FA（npm 对新包发布要求）。

## 每次发版

1. 更新 `CHANGELOG.md`：把"未发布"改成版本号与日期。
2. 改 `package.json` 的 `version`（或 `npm version <patch|minor|major> --no-git-tag-version`），提交 `chore(release): vX.Y.Z`。
3. `pnpm check`：两份 tsconfig 类型检查 → lint → 格式检查 → 测试与覆盖率棘轮 → 构建。
4. `pnpm check:package`：publint（`package.json` 字段与产物一致性）+ attw（ESM / CJS / 各种 `moduleResolution` 下的类型解析）。
5. `npm pack --dry-run`：清单只应包含 `dist/` 下的 ESM / CJS / d.ts / IIFE 与 `README.md`、`CHANGELOG.md`、`LICENSE`、
   `THIRD_PARTY_NOTICES.md`、`package.json`；不应出现 sourcemap、测试夹具或 `bench/`。
6. `npm publish`（`prepublishOnly` 会自动再跑一遍第 3、4 步，任何一步失败即中止）。
7. `git tag vX.Y.Z && git push origin main --follow-tags`。

## 产物说明

| 文件                                  | 用途                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `dist/index.js` / `index.d.ts`        | ESM（`import`），可读代码                                               |
| `dist/index.cjs` / `index.d.cts`      | CommonJS（`require`）                                                   |
| `dist/geoverse-line-finder.global.js` | 压缩的 IIFE，全局 `GeoVerseLineFinder`；`unpkg` / `jsdelivr` 字段指向它 |

包内不带 sourcemap：ESM / CJS 本身可读，带上会让包体积翻几倍。运行时零依赖。
