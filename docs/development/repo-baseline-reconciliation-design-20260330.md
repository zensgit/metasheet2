# Repo Baseline Reconciliation Design

日期：2026-03-30

## 目标

把当前主工作树里“已经被既有 slice 覆盖的 dirty 文件”和“还没进入任何 slice 的剩余 dirty 文件”拆开，不再靠人工从几百个文件里肉眼判断下一步。

本轮不直接做新的 Git deliver，而是补一个稳定的 reconciliation planner，给后续收口提供统一入口。

## 问题

当前仓库本轮实测状态是：

- `ahead 0 / behind 0`
- `dirty=true`
- `dirtyPathCount=88`
- 主要噪声集中在 `.claude/**` 和 `output/releases/**`

此前已经完成正式 Git 收口的只有两条：

- `directory-migration-baseline`
- `dingtalk-directory-featureline`

但主工作树里仍然混着：

- 已属于这两条 slice 的 dirty 文件
- 还没切出去的 attendance / auth / plm / workflow 业务改动
- `output/`、`packages/openapi/dist/`、插件 `node_modules/` 这类生成物噪声

## 设计原则

### 1. 先做规划，不直接改 Git 状态

工具只读 `git status` 和 `scripts/ops/git-slices.mjs`，不会 stage、commit、rebase，也不会改当前 index。

同时补回一个更基础的只读入口：

- `scripts/ops/git-baseline-report.mjs`

它负责输出 branch / upstream / ahead / behind / dirty buckets，不承担 candidate grouping。

### 2. 优先复用既有 slice 定义

planner 不自己发明新的“已完成范围”，而是直接以 `SLICES` 为唯一事实源，先判断 dirty 文件是否已被既有 slice 覆盖。

如果当前工作树里没有 `scripts/ops/git-slices.mjs`，planner 会自动退化到 `fallback-empty`：

- `sliceCatalogSource = "fallback-empty"`
- `slices = {}`
- 继续做剩余 dirty tree 的候选分组

这样即使总基线工具链没有完整回落到当前工作树，reconciliation 也不会直接失明。

### 3. 剩余 dirty 文件只做候选分组

对尚未被 slice 覆盖的路径，先做“候选组”归类，而不是直接宣称已经形成新 slice。

### 4. 输出同时面向机器和人

同时输出：

- JSON：供 verifier 和后续 slice 规划脚本使用
- Markdown 摘要：供人快速看下一步该怎么拆

## 新增入口

脚本：

- `scripts/ops/git-baseline-report.mjs`
- `scripts/ops/git-reconciliation-plan.mjs`

根脚本：

- `pnpm print:git-baseline-report`
- `pnpm print:git-baseline-report:json`
- `pnpm verify:repo-baseline-reconciliation`
- `pnpm print:repo-baseline-reconciliation`
- `pnpm plan:repo-baseline-reconciliation`

## 输出结构

核心输出字段：

- 当前分支 / upstream / `ahead` / `behind`
- `dirtyPathCount`
- `coveredDirtyCount`
- `uncoveredDirtyCount`
- `coveredSlices`
- `multiSliceCoveredPaths`
- `candidateGroups`
- `suggestions`

## 当前候选组规则

- `generated-artifacts-and-vendor-churn`
- `claude-task-pack-archives`
- `dingtalk-runtime-contract-followups`
- `reconciliation-tooling-and-entrypoints`
- `dingtalk-rollout-docs-backlog`
- `attendance-auth-followups`
- `plm-workflow-followups`
- `runtime-contracts-and-observability`
- `git-and-remote-ops-followups`
- `docs-backlog-and-rollout-notes`
- `misc-followups`

排序目标是：

1. 先识别生成物和清理项
2. 再拆出 Claude 任务包档案和 DingTalk 合同/测试 follow-up
3. 单独识别 reconciliation 工具链自身
4. 最后保留手工补判组

## verify 语义

`--verify` 不要求仓库 clean。

它只验证 planner 自身是否闭环：

- `coveredDirtyCount + uncoveredDirtyCount == dirtyPathCount`
- 所有 uncovered paths 都落进某个 candidate group

只有分类断裂时 verify 才失败。

## 本轮实际结论

在当前工作树里，planner 的最新输出是：

- `coveredDirtyCount = 0`
- `uncoveredDirtyCount = 88`
- `generated-artifacts-and-vendor-churn = 51`
- `claude-task-pack-archives = 14`
- `dingtalk-runtime-contract-followups = 10`
- `reconciliation-tooling-and-entrypoints = 5`
- `dingtalk-rollout-docs-backlog = 6`
- `git-and-remote-ops-followups = 1`

这里 `output/repo-baseline-reconciliation/**` 自身也会进入 dirty tree，因此 planner 属于“会把自己的产物纳入事实面”的自举型工具。当前结论不变：下一步最优先的不是再开新的业务 slice，而是先把生成物噪声、Claude 任务包档案和 DingTalk 合同/测试改动继续拆开。

## 与下一步协作的关系

### Slice A：repo-baseline-reconciliation

由 Codex 直接执行：

- 用 planner 先把剩余 dirty tree 拆清
- 决定下一条业务 slice 的真实边界

### Slice B：dingtalk-ops-hardening

由 Claude Code 执行、Codex 验证：

- planner 先告诉我们哪些路径不能再碰
- Claude 只在允许范围内实现 DingTalk 运营强化

## 非目标

- 不自动创建新 Git slice
- 不自动 stage dirty 文件
- 不自动提交到 GitHub
- 不替代既有 `git-slice-*` 交付链

## 结论

这次补的是“总基线收口前的统一导航层”。先把 dirty tree 的事实拆清，再做下一条 slice，比继续直接叠功能更稳。
