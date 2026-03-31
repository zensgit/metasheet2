# Claude Task Pack Archives Design

日期：2026-03-31

## 目标

把 `repo-baseline-reconciliation` 已识别出的 `claude-task-pack-archives` 独立收口，不再让这些执行包模板长期漂浮在 dirty tree 中。

本轮只处理 14 份 Claude Code 执行包 / 验收模板文档：

- OAuth backend
- OAuth backend repair-1
- OAuth backend repair-2
- on-prem rollout
- ops hardening
- ops hardening repair
- ops hardening repair-2

每组各 1 份 task pack + 1 份 verification template。

## 背景

上一轮 baseline planner 的真实输出中：

- `claude-task-pack-archives = 14`

这 14 个文件都不是运行时代码，也不是待实现功能，而是我们在“Claude 执行、Codex 验收”协作模式下沉淀出的过程文档。

如果不单独收口，它们会持续混在业务 backlog 和部署文档里，干扰下一条真实 slice 的判断。

## 设计原则

### 1. 只收执行包与模板

本轮只提交：

- `docs/development/*claude-task-pack-20260330.md`
- `docs/development/*claude-verification-template-20260330.md`

不连带：

- `docs/development/dingtalk-*-design-20260330.md`
- `docs/development/dingtalk-*-verification-20260330.md`
- `docs/deployment/dingtalk-*.md`

这样 archive slice 和 rollout/docs backlog 保持清晰分层。

### 2. 保留原始文件名，不搬迁路径

这些文档已经在多轮协作中被直接引用：

- 由用户转发给 Claude
- 由 Codex 在验收中反复引用
- 已写入 `verification-index.md`

因此本轮不改文件名、不改目录结构，只把它们正式纳入版本控制。

### 3. 把协作模式沉淀为可追溯资产

这些 task pack 和 verification template 不是一次性聊天草稿，而是：

- 写边界定义
- 命令清单
- 验收口径
- repair 迭代记录

收口后，它们应被视为正式工程文档，而不是临时垃圾。

## 范围

### OAuth backend

- `docs/development/dingtalk-oauth-backend-claude-task-pack-20260330.md`
- `docs/development/dingtalk-oauth-backend-claude-verification-template-20260330.md`
- `docs/development/dingtalk-oauth-backend-repair1-claude-task-pack-20260330.md`
- `docs/development/dingtalk-oauth-backend-repair1-claude-verification-template-20260330.md`
- `docs/development/dingtalk-oauth-backend-repair2-claude-task-pack-20260330.md`
- `docs/development/dingtalk-oauth-backend-repair2-claude-verification-template-20260330.md`

### On-prem rollout

- `docs/development/dingtalk-onprem-rollout-claude-task-pack-20260330.md`
- `docs/development/dingtalk-onprem-rollout-claude-verification-template-20260330.md`

### Ops hardening

- `docs/development/dingtalk-ops-hardening-claude-task-pack-20260330.md`
- `docs/development/dingtalk-ops-hardening-claude-verification-template-20260330.md`
- `docs/development/dingtalk-ops-hardening-repair-claude-task-pack-20260330.md`
- `docs/development/dingtalk-ops-hardening-repair-claude-verification-template-20260330.md`
- `docs/development/dingtalk-ops-hardening-repair2-claude-task-pack-20260330.md`
- `docs/development/dingtalk-ops-hardening-repair2-claude-verification-template-20260330.md`

## 非目标

- 不处理 rollout 设计 / 验证 / 部署文档 backlog
- 不修改 `scripts/openapi-check.mjs`
- 不新增运行时代码
- 不再生成新的 task pack

## 结论

这条 slice 的价值不在功能，而在把“Claude 执行 / Codex 验收”这一套协作资产正式落库，避免它们继续作为未归档噪声留在总工作树里。
