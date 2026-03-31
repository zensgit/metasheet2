# Generated Artifacts Cleanup Verification

日期：2026-03-31

## 范围

验证本轮生成物清理是否满足：

- 目标目录已删除
- baseline dirty tree 明显下降
- 剩余 dirty paths 已收敛到真实 backlog

## 实际命令

```bash
rm -rf .claude/worktrees/tender-elion output/releases output/repo-baseline-reconciliation
git status --short | sed -n '1,120p'
pnpm print:git-baseline-report:json
pnpm plan:repo-baseline-reconciliation
```

## 实际结果

### 1. 目录清理

- 已删除：
  - `.claude/worktrees/tender-elion`
  - `output/releases`
  - `output/repo-baseline-reconciliation`

### 2. Git baseline

- 命令：`pnpm print:git-baseline-report:json`
- 结果：通过
- 关键输出：
  - `branch = codex/dingtalk-onprem-rollout-20260330`
  - `upstream = origin/codex/dingtalk-onprem-rollout-20260330`
  - `ahead = 0`
  - `behind = 0`
  - `dirty = true`
  - `changedFileCount = 21`
  - `modifiedTrackedCount = 0`
  - `untrackedCount = 21`
  - `dirtyBuckets = { docs: 20, scripts: 1 }`

### 3. Reconciliation plan

- 命令：`pnpm plan:repo-baseline-reconciliation`
- 结果：通过
- 关键输出：
  - `dirtyPathCount = 21`
  - `coveredDirtyCount = 0`
  - `uncoveredDirtyCount = 21`
  - `claude-task-pack-archives = 14`
  - `dingtalk-rollout-docs-backlog = 6`
  - `reconciliation-tooling-and-entrypoints = 1`

### 4. 效果对比

- 清理前：`dirtyPathCount = 72`
- 清理后：`dirtyPathCount = 21`
- 下降：`51`

这与上一轮 planner 识别出的 `generated-artifacts-and-vendor-churn = 51` 完全对齐，说明本轮删除范围准确，没有误伤真实 backlog。

## 结论

生成物清理已完成并生效。

当前主工作树已经不再被 `.claude/**` 和 `output/**` 主导，剩余内容只剩：

1. `claude-task-pack-archives`
2. `dingtalk-rollout-docs-backlog`
3. `scripts/openapi-check.mjs`

下一步应直接从这三组里继续切下一条独立 cleanup / docs slice。
