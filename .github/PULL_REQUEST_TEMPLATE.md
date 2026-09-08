# Pull Request

English template. 中文模板请见 `.github/PULL_REQUEST_TEMPLATE.zh-CN.md`。
Guides: `AGENTS.md` (includes Local Dev & Troubleshooting).

## Purpose
- What does this change do? Why now?

## Changes
- Summary of key changes (code, routes, contracts)

## Validation
- Commands run (build/tests):
  - `pnpm install --frozen-lockfile`
  - `pnpm -F @metasheet/core-backend test`
  - `NODE_ENV=test pnpm -F @metasheet/core-backend test:integration`
- Contract check (if applicable): `curl -s http://localhost:8900/api/plugins | jq`

## Risks & Rollback
- Potential impact and how to revert

## Checklist
- [ ] One concern per PR; minimal unrelated changes
- [ ] Lockfile committed and CI green
- [ ] Followed coding style (ESM, TS, 2-space indent)
- [ ] Docs updated if needed
- [ ] Local troubleshooting consulted when needed
  - See `AGENTS.md` → "Local Dev & Troubleshooting"
  - One‑shot fix: `bash scripts/fix-local-core-backend.sh`
- [ ] **If monitoring/alerting config changed**: Confirmed routing and thresholds are correct
  - Applies to: `weekly_metrics.yaml`, `scripts/collect-security-metrics.sh`, Prometheus/Grafana configs
  - Verify: Alert routes point to correct channels, thresholds match SLA requirements
  - See: `.github/CODEOWNERS` for dual approval requirement

## 保证型 / 被 pin 文件 PR 的硬门
- [ ] **改了被 pin 的文件必跑 provenance 测试**：改动落在 `lib/sealed-export/sealed-export-package-provenance.cjs` 清单内（含 review 修正、rebase 合并产生的改动）
  - 涉及文件示例：`plugins/plugin-integration-core/index.cjs`、`lib/http-routes.cjs`、`lib/sealed-export/*`、`package.json`、`pnpm-lock.yaml`、`.github/workflows/plugin-tests.yml`
  - 重打 pin：更新 `lib/sealed-export/vectors/s6a-package-provenance-pins.json`
  - 本地验证：`node __tests__/sealed-export-package-provenance.test.cjs`
  - Windows 检出注意：按 LF 字节校验（`git show HEAD:<path> | sha256sum`），工作副本可能是 CRLF
- [ ] **保证型 PR 合并前必过对抗核验**：PR 声称 “fail-closed / 只读 / 租户隔离 / owner 限定 / 不扩大写入口” 等保证时
  - 需要独立于作者的反驳记录：守卫去掉后哪个测试会红的变异证据
  - 需要自问并记录：哪种降级变异测试抓不到
  - 把以上结论写进 PR 描述
- [ ] **被 pin 文件的 PR 一气呵成**：rebase 到最新 main → 重打 pin → 等 integration-guard 与 S5 两条腿绿 → 立即合并
  - 不要在绿了之后放置数小时：main 每几小时就会再动一次被 pin 文件，会再次冲突
