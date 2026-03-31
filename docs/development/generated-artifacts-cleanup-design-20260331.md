# Generated Artifacts Cleanup Design

日期：2026-03-31

## 目标

把 `repo-baseline-reconciliation` 已经识别出的纯生成物噪声从主工作树里清掉，优先降低 dirty tree 体积，再继续处理真实源码和文档 backlog。

本轮只处理以下目录：

- `.claude/worktrees/tender-elion`
- `output/releases`
- `output/repo-baseline-reconciliation`

## 原因

在上一轮基线规划结果里，最大的 candidate group 是：

- `generated-artifacts-and-vendor-churn = 51`

它不是业务改动，而是：

- Claude 临时工作树
- attendance on-prem 打包产物
- reconciliation report 运行产物

如果不先清掉这些内容，后续任何真实 slice 都会被噪声淹没。

## 设计原则

### 1. 只删生成物，不碰源码 backlog

本轮明确不处理：

- `docs/development/dingtalk-*`
- `docs/deployment/dingtalk-*`
- `scripts/openapi-check.mjs`

这些路径仍然是后续真正需要切片的源码/文档 backlog，不属于“生成物清理”。

### 2. 只删当前已确认的临时目录

`.claude/` 不是整体删除，只清：

- `.claude/worktrees/tender-elion`

避免误删用户还可能在使用的其他本地 Claude 工作内容。

### 3. 清理后立即重跑 baseline

删除生成物后，要立刻重新跑：

- `pnpm print:git-baseline-report:json`
- `pnpm plan:repo-baseline-reconciliation`

确认 dirty tree 的实际下降幅度，以及剩余 candidate groups 的真实排序。

## 预期结果

清理后，dirty tree 应从以 `output/**` 和 `.claude/**` 为主，收敛成：

- Claude task pack 文档档案
- DingTalk rollout 设计/部署/验证文档
- `scripts/openapi-check.mjs`

也就是把“生成物噪声”与“真实 backlog”完全分层。

## 非目标

- 不提交删除后的二进制或打包产物
- 不修改任何运行时代码
- 不处理 `claude-task-pack-archives`
- 不处理 `dingtalk-rollout-docs-backlog`

## 结论

这一轮的作用不是新增功能，而是把总工作树从“混着大量本地产物”推进到“只剩真实待收口文件”，让后续 baseline 工作重新可控。
