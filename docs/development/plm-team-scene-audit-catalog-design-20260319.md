# PLM Team Scene Audit Catalog Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`

## Goal

把现有 `PLM workbench` 的团队视图能力继续产品化，让“团队默认场景”不再只是一个隐藏在管理动作里的开关，而是一个可见、可过滤、可审计的协作能力。

## Scope

1. 后端为 workbench 团队视图的 `set default / clear default` 补正式审计事件。
2. 前端审计页支持过滤和展示这类默认场景审计。
3. 产品页增加 `团队场景目录`，直接复用现有 workbench 团队视图数据，支持：
   - 默认优先排序
   - owner 维度筛选
   - 一键应用团队场景
   - 一键复制团队场景链接
   - 跳到默认场景审计页

## Design

### 1. 审计模型扩展

- 在现有 PLM collaborative audit 模型上扩展，不新建第二套审计表。
- 新增资源类型：
  - `plm-team-view-default`
- 新增动作：
  - `set-default`
  - `clear-default`
- 默认场景审计复用 `operation_audit_logs`，并在 `meta` 里记录：
  - `tenantId`
  - `ownerUserId`
  - `kind`
  - `viewName`
  - `processedKinds`
  - `processedTotal`

### 2. 路由接线

- `POST /api/plm-workbench/views/team/:id/default`
- `DELETE /api/plm-workbench/views/team/:id/default`
- `POST /api/plm-workbench/views/team` with `isDefault: true`

这三处都可能改变默认团队场景，所以都写入 `plm-team-view-default` 审计事件。

### 3. 审计页对齐

- 审计 query-state 允许新的 `action/resourceType` 组合进入 URL。
- 审计 saved views 的合法状态白名单同步放开。
- 审计页筛选下拉和标签函数同步支持：
  - `Set default`
  - `Clear default`
  - `Team default scene`

### 4. 产品页团队场景目录

- 不引入新接口，直接复用 `workbenchTeamViews`。
- 只展示未归档团队场景。
- 排序规则：
  - 默认场景优先
  - 其余按 `updatedAt / createdAt` 逆序
- 产品页额外提供 owner 过滤，避免团队场景数量增长后失控。

## Expected Result

- `团队默认场景` 的设定/清除有正式审计。
- 产品页可以把团队场景当作显式目录，而不是仅通过通用 `团队视图` 管理块间接访问。
- 审计页和产品页围绕“团队场景”形成闭环。
