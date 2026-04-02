# PLM Workbench Approval History Version Parity Design

## Background

审批 approve/reject 路由当前写入的是 `approval_records.from_version` 和 `approval_records.to_version`。

`/api/approvals/:id/history` 仍然读取 legacy `version` 列，导致历史 API 返回的版本信息在当前写路径下长期为空或不完整。

## Problem

- 历史 route 读取 `version`，但当前写路径不再维护它。
- 审批历史真实保存了版本迁移，却没有通过 API 回到前端。
- 这会让审批冲突排查、版本变更审计和后续前端展示失去完整版本上下文。

## Decision

- history route 改为返回：
  - `from_version`
  - `to_version`
  - `version = COALESCE(to_version, version)`
- 保留 `version` 字段，兼容现有客户端；同时把完整迁移字段一起暴露给新客户端。

## Expected Result

- 新写入的审批历史会带完整版本迁移。
- 老客户端继续读取 `version` 不会回退。
- 后续如果前端需要展示 `from -> to`，无需再改后端 route 契约。
