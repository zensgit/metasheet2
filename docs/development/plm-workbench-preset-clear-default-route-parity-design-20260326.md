# PLM Workbench Preset Clear-Default Route Parity Design

## 背景

`team preset` 的前端已经把 archived preset 的 `clear default` 禁掉，但后端 `DELETE /api/plm-workbench/filter-presets/team/:id/default` 仍缺少和 `team view` 同级的 route guard。

## 问题

- preset clear-default route 只按 `id` 查找
- route 没有限定 `tenant_id` 和 `scope = team`
- route 也没有 archived guard
- 结果是 direct API caller 仍可能对 archived preset 执行 `clear default`

## 设计决策

- 与 `team view clear-default` route 对齐
- 查找 preset 时补上 `tenant_id` 和 `scope = team`
- archived preset 直接返回 `409`
- 错误文案采用 preset 版本，避免和 team view 混淆

## 实现

- 在 `packages/core-backend/src/routes/plm-workbench.ts`
  - `DELETE /api/plm-workbench/filter-presets/team/:id/default`
  - 读取当前 `tenantId`
  - lookup 增加 `where('tenant_id', '=', tenantId)` 与 `where('scope', '=', 'team')`
  - `preset.owner_user_id !== currentUserId` 之后新增 `preset.archived_at` guard

## 预期结果

- archived team preset 不再能通过 API 清除默认态
- preset clear-default route 和 team view clear-default route 语义一致
- tenant/scope parity 不再落后于相邻 route
