# PLM Workbench Preset Set-Default Route Parity Design

## 背景

`team preset clear-default` 已经补到 `team view` route parity，但 `POST /api/plm-workbench/filter-presets/team/:id/default` 仍然只按 `id` 查找 preset。

## 问题

- set-default route lookup 缺少 `tenant_id`
- 也缺少 `scope = team`
- 这会让 preset default route 的 scoping 继续落后于
  - `team view set-default`
  - `team preset clear-default`

## 设计决策

- preset set-default route 与相邻 default routes 保持同一套 tenant/team scoping
- 不改 archived 语义，只补 lookup parity
- 用 focused route test 锁住 `tenant_id` 和 `scope` 条件

## 实现

- 在 `packages/core-backend/src/routes/plm-workbench.ts`
  - `POST /api/plm-workbench/filter-presets/team/:id/default`
  - 增加 `tenantId`
  - lookup 增加 `where('tenant_id', '=', tenantId)`
  - lookup 增加 `where('scope', '=', 'team')`

## 预期结果

- preset set-default route 不再只按裸 `id` 命中
- team preset default routes 的 tenant/team parity 收齐
- 后续 route 重构不会再把 scoped lookup 回退成 id-only
