# Multitable Staging Runner Report Fallback

## Context

`pilotRunner` / `localRunner` 已经支持 `runMode=staging`，但 `handoff` 和 `release-bound` 的缺省 runner report 路径仍然写死为：

- `smoke/local-report.json`
- `smoke/local-report.md`

这在两种 staging 场景下会产生错误恢复路径：

1. readiness/handoff payload 没显式带 `report` / `reportMd`
2. `release-bound` 从 `handoff.json` 回推出 smoke artifact basename

结果是 staging 流程会继续去找 `local-report.*`，而不是真实的 `staging-report.*`。

## Design

### 1. Make handoff fallback honor runner mode

在 [multitable-pilot-handoff.mjs](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-handoff.mjs) 里：

- `runMode=local` -> fallback `smoke/local-report.json|md`
- `runMode=staging` -> fallback `smoke/staging-report.json|md`

### 2. Make release-bound basename fallback honor runner mode

在 [multitable-pilot-release-bound.sh](/Users/huazhou/Downloads/Github/metasheet2-multitable-next/scripts/ops/multitable-pilot-release-bound.sh) 里：

- 从 `handoff.json` 取 runner 时，如果 `report/reportMd` 缺失：
  - `runMode=local` -> basename fallback `local-report.json|md`
  - `runMode=staging` -> basename fallback `staging-report.json|md`

这样顶层 `report.md` / operator replay output 就不会再把 staging artifact 写成 local 名字。

## Verification

### Focused node tests

执行：

```bash
node --test \
  scripts/ops/multitable-pilot-handoff.test.mjs \
  scripts/ops/multitable-pilot-release-bound.test.mjs
```

新增覆盖：

- staging readiness 没显式 `report/reportMd` 时，handoff 会复制：
  - `smoke/staging-report.json`
  - `smoke/staging-report.md`
- staging handoff 没显式 `report/reportMd` 时，release-bound 顶层 markdown 会回显：
  - `staging-report.json`
  - `staging-report.md`

### Syntax / build

执行：

```bash
node --check scripts/ops/multitable-pilot-handoff.mjs
bash -n scripts/ops/multitable-pilot-release-bound.sh
pnpm --filter @metasheet/web build
```

预期：

- handoff mjs 语法通过
- release-bound shell 语法通过
- focused ops tests 通过
- web build 通过

## Outcome

现在 staging 的 pilot artifact 链在这条“半缺省/恢复”路径上也已经自洽：

- readiness -> handoff
- handoff -> release-bound

不会再出现 artifact 真是 `staging-report.*`，但上层摘要和 helper 仍写成 `local-report.*` 的错配。
