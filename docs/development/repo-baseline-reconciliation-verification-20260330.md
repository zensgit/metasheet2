# Repo Baseline Reconciliation Verification

日期：2026-03-30

## 范围

验证 reconciliation planner 是否满足：

- Git 工作树读取正常
- 已有 slice 覆盖判定正常
- 剩余 dirty tree 候选分组正常
- JSON / Markdown 输出正常
- `--verify` 校验语义正常

## 计划命令

```bash
node --check scripts/ops/git-baseline-report.mjs
node --check scripts/ops/git-reconciliation-plan.mjs
pnpm print:git-baseline-report:json
pnpm verify:repo-baseline-reconciliation
pnpm plan:repo-baseline-reconciliation
pnpm print:repo-baseline-reconciliation
claude -p "Review scripts/ops/git-reconciliation-plan.mjs and docs/development/dingtalk-ops-hardening-claude-task-pack-20260330.md for obvious issues only. Reply with 'No obvious issues.' or a short bullet list."
```

## 实际结果

### 1. 语法与入口

- `node --check scripts/ops/git-baseline-report.mjs`
  - 结果：通过
- `node --check scripts/ops/git-reconciliation-plan.mjs`
  - 结果：通过
- `package.json`
  - 已新增：
    - `print:git-baseline-report`
    - `print:git-baseline-report:json`
    - `verify:repo-baseline-reconciliation`
    - `print:repo-baseline-reconciliation`
    - `plan:repo-baseline-reconciliation`

### 2. baseline report

- `pnpm print:git-baseline-report:json`
  - 结果：通过
  - 关键输出：
    - `branch = codex/dingtalk-onprem-rollout-20260330`
    - `upstream = origin/codex/dingtalk-onprem-rollout-20260330`
    - `ahead = 0`
    - `behind = 0`
    - `changedFileCount = 88`
    - `modifiedTrackedCount = 5`
    - `untrackedCount = 83`
    - `dirtyBuckets = { apps: 3, claude: 1, docs: 23, output: 50, packages: 5, root: 1, scripts: 5 }`

### 3. verify

- `pnpm verify:repo-baseline-reconciliation`
  - 结果：通过
  - 关键输出：
    - `sliceCatalogSource = "fallback-empty"`
    - `branch = codex/dingtalk-onprem-rollout-20260330`
    - `upstream = origin/codex/dingtalk-onprem-rollout-20260330`
    - `ahead = 0`
    - `behind = 0`
    - `dirty = true`
    - `dirtyPathCount = 88`
    - `coveredDirtyCount = 0`
    - `uncoveredDirtyCount = 88`
    - `classification.verifyPassed = true`
  - 产物：
    - `output/repo-baseline-reconciliation/verify/report.json`
    - `output/repo-baseline-reconciliation/verify/summary.md`

### 4. print

- `pnpm print:repo-baseline-reconciliation`
  - 结果：通过
  - 人类摘要与 verify JSON 一致

### 5. current 规划产物

- `pnpm plan:repo-baseline-reconciliation`
  - 结果：通过
  - 关键输出：
    - `dirtyPathCount = 88`
    - `coveredDirtyCount = 0`
    - `uncoveredDirtyCount = 88`
    - `generated-artifacts-and-vendor-churn = 51`
    - `claude-task-pack-archives = 14`
    - `dingtalk-runtime-contract-followups = 10`
    - `reconciliation-tooling-and-entrypoints = 5`
    - `dingtalk-rollout-docs-backlog = 6`
    - `git-and-remote-ops-followups = 1`
  - 说明：
    - planner 自己会把 `output/repo-baseline-reconciliation/**` 产物计入 dirty tree
    - 每个 candidate group 现在都会输出 `stageCommand`
    - `.claude/**` bucket 已与 baseline report 对齐，不再落进 `root`
  - 产物：
    - `output/repo-baseline-reconciliation/current/report.json`
    - `output/repo-baseline-reconciliation/current/summary.md`

### 6. Claude Code 复核

- 首轮复核结果：
  - `scripts/ops/git-reconciliation-plan.mjs`
    - 指出内部 `slices` 变量 shadowing
  - `docs/development/dingtalk-ops-hardening-claude-task-pack-20260330.md`
    - 指出目标主机描述写死
- 修复后再次执行：
  - `claude -p "Review scripts/ops/git-reconciliation-plan.mjs and docs/development/dingtalk-ops-hardening-claude-task-pack-20260330.md for obvious issues only. Reply with either 'No obvious issues.' or a short bullet list of issues."`
  - 结果：`No obvious issues.`

### 7. 本轮结论

- planner 在当前真实工作树里可稳定运行
- `git-baseline-report.mjs` 已补回，旧文档引用的 baseline 命令重新可用
- 即使缺失 `scripts/ops/git-slices.mjs`，`fallback-empty` 模式仍然能稳定产出候选分组
- 当前最主要的 dirty 噪声来自 `.claude/**` 与 `output/releases/**`
- planner 自己写出的 `output/repo-baseline-reconciliation/**` 也会进入 dirty 统计，这是预期行为
- 当前下一条最清晰的真实业务收口线已经收敛为 `dingtalk-runtime-contract-followups`
- 下一步应优先继续拆清生成物、Claude 任务包档案与 DingTalk 合同改动，而不是直接从 dirty tree 新开更大的业务 slice
