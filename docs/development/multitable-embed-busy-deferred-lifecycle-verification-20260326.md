# Multitable Embed Busy Deferred Lifecycle Verification

## Scope Verified

本轮验证的是 embed-host busy/deferred lifecycle 从 smoke 到 artifact 的整条证据链：

- live smoke 脚本已接入 busy/deferred/superseded/replayed 路径
- readiness 会汇总并要求这组 evidence
- handoff 会提升这组 evidence
- release-bound 会提升这组 evidence
- runbook 会把这组 evidence 写进 pilot acceptance bar

## Commands

在 `/Users/huazhou/Downloads/Github/metasheet2-multitable-next` 实际执行：

```bash
node --check scripts/verify-multitable-live-smoke.mjs
node --check scripts/ops/multitable-pilot-readiness.mjs
node --check scripts/ops/multitable-pilot-handoff.mjs
bash -n scripts/ops/multitable-pilot-release-bound.sh
node --test \
  scripts/ops/multitable-pilot-readiness.test.mjs \
  scripts/ops/multitable-pilot-handoff.test.mjs \
  scripts/ops/multitable-pilot-release-bound.test.mjs
```

## Results

### Syntax / shell checks

通过：

- `node --check scripts/verify-multitable-live-smoke.mjs`
- `node --check scripts/ops/multitable-pilot-readiness.mjs`
- `node --check scripts/ops/multitable-pilot-handoff.mjs`
- `bash -n scripts/ops/multitable-pilot-release-bound.sh`

说明新增的 busy/deferred lifecycle wiring 没有引入脚本级语法错误。

### Ops regression suite

`node --test scripts/ops/multitable-pilot-readiness.test.mjs scripts/ops/multitable-pilot-handoff.test.mjs scripts/ops/multitable-pilot-release-bound.test.mjs` 通过：

- `8 tests passed`

覆盖包括：

- readiness 对 busy deferred replay 缺失 evidence 时失败
- handoff 将 `embedHostDeferredReplay` 提升到 `handoff.json` / `handoff.md`
- release-bound 将 `embedHostDeferredReplay` 提升到 `report.json` / `report.md`

## Notes

这轮没有声明已经完成真实环境里的 full live smoke run。

本轮完成的是：

- smoke script 逻辑接线
- readiness / handoff / release-bound promotion
- regression coverage

真实环境联调仍需要：

- 起 API/Web
- 实跑 `scripts/verify-multitable-live-smoke.mjs`

## Outcome

embed-host 的 async busy/deferred/superseded/replayed 生命周期现在已经不是隐藏在 smoke 里的附加信号，而是正式进入：

- readiness
- handoff
- release-bound
- pilot runbook

这意味着 multitable embed-host 的异步导航行为已经进入可发布、可交接、可签收的证据链。 
