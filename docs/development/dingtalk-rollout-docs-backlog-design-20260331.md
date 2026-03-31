# DingTalk Rollout Docs Backlog Design

日期：2026-03-31

## 目标

把当前剩余的 6 份 DingTalk rollout 设计 / 验证 / 部署文档单独收口，不再让它们与源码 backlog 混在一起。

本轮只处理：

- `docs/deployment/dingtalk-oauth-backend-deploy-20260330.md`
- `docs/deployment/dingtalk-ops-hardening-deploy-20260330.md`
- `docs/development/dingtalk-oauth-backend-design-20260330.md`
- `docs/development/dingtalk-oauth-backend-verification-20260330.md`
- `docs/development/dingtalk-ops-hardening-design-20260330.md`
- `docs/development/dingtalk-ops-hardening-verification-20260330.md`

## 背景

经过：

- 生成物清理
- Claude task pack 归档
- DingTalk runtime contracts follow-up

当前主工作树已经压到只剩：

- 6 份 DingTalk rollout 文档
- `scripts/openapi-check.mjs`

这 6 份文档对应两条已经通过验收的业务线：

1. `dingtalk-ops-hardening`
2. `dingtalk-oauth-backend`

因此它们应被视为正式工程文档，而不是临时 dirty 文件。

## 设计原则

### 1. 设计 / 验证 / 部署三类文档一次收口

这 6 份文件虽然分属不同子类型，但都属于同一批 DingTalk rollout 交付资产：

- design
- verification
- deployment

一次提交比拆成 3 个更符合它们的实际使用关系。

### 2. 不重写内容，只正式纳管

这些文档已经在前面的修复和 on-prem rollout 中被反复使用并验证。

本轮不新增产品逻辑，只做：

- 版本控制纳管
- verification index 接线
- backlog 清理

### 3. 与 Claude task pack 归档保持分层

这条 slice 不再带入：

- `docs/development/*claude-task-pack*`
- `docs/development/*claude-verification-template*`

因为那些已经在上一条 archive slice 中完成。

## 非目标

- 不修改 DingTalk 运行时代码
- 不修改 smoke 脚本
- 不处理 `scripts/openapi-check.mjs`
- 不新增新的 rollout 文档

## 结论

这条 slice 的作用是把 DingTalk rollout 正式文档面彻底落库。完成后，主工作树应只剩 `scripts/openapi-check.mjs` 这一条工具 follow-up。
