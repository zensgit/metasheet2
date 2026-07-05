# 审批参与面候选人目录端点（B3-04）· DESIGN-LOCK — 2026-07-05

> **需求门**（demand gate，已具名）：四个审批参与面的选人今天在生产上不可用或不可自助——
> ① 转交对话框硬编码假人（`ApprovalDetailView.vue` ~:408）；② 加签对话框同（~:442）；
> ③ 发起表单 `user` 字段假选项（`ApprovalNewView.vue` ~:137）；④ 我的委托手填
> `delegateeUserId`（`MyDelegationView.vue` ~:38）。既有目录查询
> `/api/approval-templates/directory/users` 被 `approvalTemplateAdminGuard`
> （`approval-templates:manage` OR `approvals:admin-templates`）保护——只适合模板作者，
> 普通审批动作/自助委托不可及。
>
> **治理门**（governance gate）：不建新目录基建——复用既有 `searchDirectoryUsers` 的
> 最小暴露形状、active-only 与 limit clamp；复用 `rbacGuardAny` 守卫组合子。

## Decision

新端点 **`GET /api/approvals/directory/users?q=&limit=`**：

1. **返回形状**：沿用 `searchDirectoryUsers` 的最小暴露 `{ id, name, email }`，
   active-only，limit clamp（默认 20，上限沿用既有实现）。不新增任何字段
   （职级/部门/手机等一律不进此端点——需要更多字段时另立门）。
2. **权限口径（owner 修正后定稿）**：`authenticate + rbacGuardAny(['approvals:read',
   'approvals:write', 'approvals:act'])` —— 审批参与面所需的**最小并集**。
   仅 `approvals:act` 会漏掉发起表单选人（write 持有者）与自助委托（read/write 持有者）；
   `approval-templates:manage` 面向作者不适用。既有作者端点保持不动（两端点并存，
   守卫语义各自明确）。
3. **安全边界**：这是**候选人目录，不是授权事实**。选中某人不代表可转交给该人/
   可委托给该人——真正的动作仍由既有服务端校验兜底：`dispatchAction`（受理人/
   目标校验）、`createApproval`（表单校验）、delegation create（委托校验）。
   端点自身零写路径、零审批数据暴露（只回目录三元组）。
4. **前端首批接线（四处，随同一 PR）**：转交对话框、加签对话框、`ApprovalNew`
   `user` 字段、`MyDelegation` delegatee picker——全部换 remote 搜索选择器
   （复刻模板作者面既有 typeahead 交互），硬编码假人删除。
5. **测试锁**：端点——三种权限各自可达 + 全无时 403 + limit clamp + q 过滤 +
   inactive 排除；前端——四处选择器接线 + 假人字面量消失的静态断言（tripwire）；
   动作兜底不弱化——转交给目录中选出的**非受理候选**仍被引擎拒（证明目录≠授权）。

## Out of scope

- 角色/部门目录、分页/头像/组织树（另立门）。
- T3-6 per-row `visibility_scope`（战略大刀，独立 design-lock，不与本小刀混合）。

## Checklist

- ✅ D-0 本锁（owner 权限口径修正已并入）
- ⬜ D-1 端点 + 守卫 + 测试
- ⬜ D-2 四处前端接线 + tripwire
