# Release checklist

🌐 [简体中文](RELEASE.md) ｜ English

> Publishing to npm is an outward-facing action: version tags are pushed **only on the maintainer's explicit decision**.

## Pipelines

| Workflow                        | Trigger                               | What it does                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`      | push to `main`, pull requests, manual | `pnpm check` on Node 20 / 22 (types, lint, format, tests + coverage ratchet, build, dist smoke test), plus `pnpm check:package` on Node 22; then loads the built package on Node 18 / 20 / 22 **without installing anything** |
| `.github/workflows/release.yml` | push of a `vX.Y.Z` tag                | checks that the tag matches `package.json` and that both changelogs are dated → all checks → `npm publish --provenance` → a GitHub Release built from the matching sections of both changelogs                                |
| `.github/workflows/release.yml` | manual run                            | the same checks + `npm publish --dry-run`; **publishes nothing**, for rehearsals                                                                                                                                              |

## One-time setup

- [x] The npm name `geoverse-line-finder` is free (the registry returned 404 on 2026-09-11).
- [x] The `origin` remote is configured locally as `https://github.com/GeoVerseLabs/geoverse-line-finder.git`; first push: `git push -u origin main`.
- [x] Make the GitHub repository **public**: npm provenance only supports public repositories (checked 2026-09-29: the repository page answers 200 anonymously).
- [x] Create an npm granular access token with publish rights for this package only and store it as the repository secret `NPM_TOKEN` (checked 2026-09-29: 0.1.0 and 0.2.0 on npm both carry SLSA provenance, i.e. `release.yml` published them).
- [ ] (Optional) Add required reviewers to the `npm` environment under Settings → Environments so every release needs a manual approval; the environment is created automatically on the first run.
- [x] GitHub Pages is enabled (`gh-pages` branch; https://geoverselabs.github.io/geoverse-line-finder/ answers 200, checked 2026-09-29).
- [ ] (Optional) After the first release you can switch to npm Trusted Publishing (GitHub OIDC): register this repository and `release.yml` in the package settings on npm, upgrade npm in the workflow to 11.5 or later, then delete `NPM_TOKEN`.

## Every release

1. In both changelogs (`CHANGELOG.md` / `CHANGELOG.en.md`) replace "未发布 / Unreleased" with the date.
2. Bump `version` in `package.json` (or `npm version <patch|minor|major> --no-git-tag-version`) and commit `chore(release): vX.Y.Z`.
3. Run everything locally first: `pnpm check && pnpm check:package`, then `npm pack --dry-run` to review the file list.
4. Push `main` and wait for CI to turn green.
5. `git tag vX.Y.Z && git push origin vX.Y.Z` — the Release pipeline publishes and creates the GitHub Release.

## Release log

| Version | Date       | Commit / tag                                   | Notes                                                                                                                                                               |
| ------- | ---------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1.0   | 2026-09-11 | `v0.1.0` → `c9d208b`                           | first release                                                                                                                                                       |
| 0.2.0   | 2026-09-14 | `v0.2.0` → `46a5e26`                           | roadmap M0–M5                                                                                                                                                       |
| 0.3.0   | 2026-09-29 | `v0.3.0` → the `chore(release): v0.3.0` commit | multiple levels, faster builds, `nodeId` / `pointConnector`; playground map engine. `main` is pushed; pushing the tag (done by the maintainer) triggers the release |

After a release, check that `npm view geoverse-line-finder version` shows the new version, `npm view geoverse-line-finder@<version> dist.attestations` carries provenance, GitHub Releases lists it, and the Pages site shows the latest playground.

Emergency manual release: `npm publish` locally; `prepublishOnly` runs `pnpm check` and `pnpm check:package` first and aborts on any failure (manual releases carry no provenance).

## What the package contains

| File                                  | Purpose                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `dist/index.js` / `index.d.ts`        | ESM (`import`), readable code                                                                   |
| `dist/index.cjs` / `index.d.cts`      | CommonJS (`require`)                                                                            |
| `dist/geoverse-line-finder.global.js` | minified IIFE with the global `GeoVerseLineFinder`; the `unpkg` / `jsdelivr` fields point to it |

The package holds only `dist/`, the Chinese and English `README` and `CHANGELOG`, `LICENSE` (Apache-2.0), `NOTICE`, `THIRD_PARTY_NOTICES.md` and `package.json`.
It ships no sourcemaps (ESM / CJS are readable as they are, and maps would multiply the size) and has no runtime dependencies.
