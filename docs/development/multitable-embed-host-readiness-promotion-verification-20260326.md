# Multitable Embed Host Readiness Promotion Verification

## Scope Verified

本轮验证的是 embed host 证据从 smoke 报告提升为正式 readiness / pilot runbook 口径后的收口质量，而不是再次重跑整套 embed host runtime。

验证范围包括：

- `scripts/ops/multitable-pilot-readiness.mjs`
- `scripts/ops/multitable-pilot-readiness.test.mjs`
- `docs/deployment/multitable-internal-pilot-runbook-20260319.md`
- 新的 `Embed Host Navigation Protection` summary 分组

## Commands

在 `/Users/huazhou/Downloads/Github/metasheet2-multitable-next` 实际执行：

```bash
pnpm verify:multitable-pilot:readiness:test
node --check scripts/ops/multitable-pilot-readiness.mjs
```

## Results

### Readiness regression suite

`pnpm verify:multitable-pilot:readiness:test` 通过：

- `5 tests passed`

覆盖内容包括：

- gate report 缺失时默认失败
- gate report 记录 failed step 时 readiness 失败
- `REQUIRE_GATE_REPORT=false` 时允许 ad hoc 本地检查
- embed host protocol evidence 只出现部分 checks 时 readiness 失败
- embed host navigation protection evidence 只出现部分 checks 时 readiness 失败

### Script syntax

`node --check scripts/ops/multitable-pilot-readiness.mjs` 通过。

说明新增的：

- `summarizeEmbedHostNavigationProtection(...)`
- `overallOk` 收敛
- readiness markdown/json 输出

都没有引入语法级问题。

## Operator-facing outcome

`multitable-internal-pilot-runbook-20260319.md` 已同步提升 pilot 口径：

- 现在不只检查 `Embed Host Protocol Evidence`
- 还要求 `Embed Host Navigation Protection`

对应的新 evidence 集为：

- `ui.embed-host.form-ready`
- `ui.embed-host.form-draft`
- `ui.embed-host.navigate.blocked-dialog`
- `ui.embed-host.navigate.blocked`
- `ui.embed-host.navigate.confirm-dialog`
- `ui.embed-host.navigate.confirmed`
- `api.embed-host.discard-unsaved-form-draft`

## Notes

这轮没有重复实跑完整 embed-host live smoke。

原因是：

- live smoke 是否可跑取决于本地 API/Web 环境
- readiness promotion 的核心风险在“新 evidence 分组是否被正确汇总并要求”，这一点由 `readiness.test` 已直接覆盖

embed host runtime 本体的 focused 回归和 build 已在上一轮 slice 中通过，并记载于：

- `/Users/huazhou/Downloads/Github/metasheet2-multitable-next/docs/development/multitable-embed-host-protocol-slice-verification-20260326.md`

## Outcome

embed host 的 blocked / confirmed 导航保护，现在已经不是“smoke 里有这几个检查”，而是：

- readiness 会汇总它
- readiness 会在证据不完整时失败
- pilot runbook 会要求它通过

这意味着这组验证已经正式进入 multitable 的发布/联调准入面。
