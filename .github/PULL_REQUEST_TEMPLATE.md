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

以下路径均相对于仓库根目录，命令均从仓库根目录执行。

- [ ] **改了被 pin 的文件必跑 provenance 测试**：以 `plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs` 的实际清单及 `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json` 为准（含 review 修正、rebase 合并产生的改动）。

  - 文件示例：`plugins/plugin-integration-core/index.cjs`、`plugins/plugin-integration-core/lib/http-routes.cjs`、`plugins/plugin-integration-core/package.json`、`pnpm-lock.yaml`、`.github/workflows/plugin-tests.yml`；示例不替代完整清单，也不表示同目录所有文件都被 pin。
  - 重打 pin：按最终候选内容更新 `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json`。
  - 完整验证：在符合 `.gitattributes` 的 LF 工作树中执行 `node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs`，校验实际候选树的字节；不得通过在哈希前归一化换行来放行不一致的文件。
  - Windows：先核对被 pin 文件的工作树换行；Windows PowerShell 5.1 不得用 `git show ... | sha256sum` 这类文本管道计算 blob 哈希，因为管道会改变字节。辅助排查单文件时，可明确在 Git Bash 中执行 `git show HEAD:plugins/plugin-integration-core/lib/http-routes.cjs | sha256sum`；它只校验该已提交文件，不能代替上述完整候选树验证。

- [ ] **保证型 PR 合并前必过对抗核验**：PR 声称 “fail-closed / 只读 / 租户隔离 / owner 限定 / 不扩大写入口” 等保证时

  - 需要独立于作者的反驳记录：守卫去掉后哪个测试会红的变异证据
  - 需要自问并记录：哪种降级变异测试抓不到
  - 把以上结论写进 PR 描述

- [ ] **被 pin 文件的 PR 在条件齐备后及时合并**：rebase 到最新 main → 按最终候选内容重打 pin 并重跑验证 → 确认全部 required checks 通过、所需审批与授权齐备，且已验证的候选 head 与 base 均未变化 → 及时合并。

  - `integration-guard` 与 S5 是本节重点检查项，不替代其他必需 CI、审批、合并权限或仓库授权要求。
  - 合并前 head 或 main/base 再次变化时，重新对齐最新 main、核对 pin 并重跑相关验证；此前的绿灯不能作为新候选的证据。
