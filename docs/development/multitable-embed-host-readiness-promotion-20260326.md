# Multitable Embed Host Readiness Promotion

## Context

上一轮已经把 embed host 的真实浏览器 smoke 提升到了两层：

1. applied 主路径
2. dirty form 下的 blocked / confirmed 导航保护

但这些检查还只存在于 `smoke/report.json`。

这意味着 release gate 虽然会执行它们，readiness / handoff / runbook 却还没有把它们提升成正式 acceptance bar。结果就是：

- smoke 里已经有更强的证据
- readiness 仍只要求旧的 applied protocol set
- pilot 签收口径落后于真实验证能力

这轮的目标就是把这条差距收平。

## Goal

让新的 embed host blocking/confirm smoke 不再只是“脚本里有”，而是正式进入：

- `scripts/ops/multitable-pilot-readiness.mjs`
- `scripts/ops/multitable-pilot-readiness.test.mjs`
- `docs/deployment/multitable-internal-pilot-runbook-20260319.md`

## Design

### 1. Keep applied protocol and navigation protection as two separate evidence groups

这轮没有把所有 `ui.embed-host.*` 混成一个列表，而是拆成两组：

1. `Embed Host Protocol Evidence`
   - ready
   - state query
   - generated request id
   - applied navigation
   - explicit request id
   - final state query

2. `Embed Host Navigation Protection`
   - form ready
   - form draft
   - blocked dialog
   - blocked navigate result
   - confirm dialog
   - confirmed navigate result
   - API proof that confirmed leave only discards local draft

这样有两个好处：

- readiness 输出可读性更高
- 后续如果 host protocol 和 draft-protection 继续扩展，不会互相污染

### 2. Preserve the existing “required when present” policy

这轮仍然保留 embed host 证据的准入策略：

- 如果 smoke report 里没有任何 `ui.embed-host.*`，readiness 不会强制失败
- 一旦存在这组检查，就要求对应整套 evidence 全通过

这对 rollout 更稳：

- 旧 smoke 报告不会被新口径意外打挂
- 新 smoke 报告一旦开始产出这组证据，就必须完整

### 3. Promote the new blocking chain into pilot acceptance bar

runbook 现在明确写出 host draft-protection 的期望证据，而不是只写 protocol evidence。

Pilot checklist 也同步升级成：

- `Embed Host Protocol Evidence` 必须 PASS
- `Embed Host Navigation Protection` 也必须 PASS

## Implementation

### `scripts/ops/multitable-pilot-readiness.mjs`

新增：

- `summarizeEmbedHostNavigationProtection(report)`

新增 required-when-present checks：

- `ui.embed-host.form-ready`
- `ui.embed-host.form-draft`
- `ui.embed-host.navigate.blocked-dialog`
- `ui.embed-host.navigate.blocked`
- `ui.embed-host.navigate.confirm-dialog`
- `ui.embed-host.navigate.confirmed`
- `api.embed-host.discard-unsaved-form-draft`

并把：

- `embedHostNavigationProtection`

写入 readiness JSON 和 readiness markdown，同时纳入 `overallOk`。

### `scripts/ops/multitable-pilot-readiness.test.mjs`

新增一条 focused regression：

- 当 smoke 只包含部分 navigation-protection evidence 时
- readiness 必须 fail
- 且 `missingChecks` 必须准确指出缺失项

### `docs/deployment/multitable-internal-pilot-runbook-20260319.md`

更新：

- `Current Acceptance Bar`
- `Pilot Entry Checklist`

把 host draft-protection 明确写成 pilot sign-off 口径的一部分。

## Verification

实际执行：

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
node --test scripts/ops/multitable-pilot-readiness.test.mjs
node --check scripts/ops/multitable-pilot-readiness.mjs
```

同时保留本轮之前已经通过的 host/embed focused web 回归：

```bash
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-embed-host.spec.ts \
  tests/multitable-embed-route.spec.ts \
  tests/multitable-phase5.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  tests/multitable-form-view.spec.ts \
  tests/multitable-import-modal.spec.ts \
  tests/multitable-field-manager.spec.ts \
  tests/multitable-view-manager.spec.ts \
  --reporter=dot
pnpm --filter @metasheet/web build
```

## Outcome

multitable embed host 的 blocked/confirm live smoke 现在已经从“脚本级增强”提升成了正式 readiness/gate 证据。

后续只要这组 smoke 被跑出来：

- readiness 会要求它完整
- runbook 会要求它签收
- pilot handoff 不会再落后于真实验证能力
