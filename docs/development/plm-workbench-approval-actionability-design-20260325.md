# PLM Workbench Approval Actionability Design

## 背景

`PLM approvals` 面板之前只按 `status === pending` 显示 `通过 / 拒绝`：

- [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue)

这会带来两个问题：

1. 非审批人也会看到可点击的审批动作。
2. `approveApproval / rejectApproval` 本身没有前端 guard，只要按钮被触发就会直接发 mutation。

## 问题

当前 approvals 列表并不稳定携带 `approver_id`。

- 有些返回会直接带 `approver_id`
- 也有一些返回只在 approval history 里暴露 `user_id`

如果前端仍然只看 `pending`，就会继续把“是否是待处理”误当成“当前用户是否可处理”。

## 设计

不新增后端接口，前端统一引入一层 `approval actionability` 合同：

1. 新增纯 helper [plmApprovalActionability.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmApprovalActionability.ts)
   - `resolvePlmApprovalActorIds(storage)`
     - 从 `plm_token / auth_token / jwt` 里解析当前 actor ids
     - 支持 `userId / user_id / sub / id / uid / username / preferred_username / email`
   - `getPlmApprovalApproverId(entry)`
     - 统一读取 `approver_id / approverId / user_id / userId`
   - `canActOnPlmApproval(entry, actorIds, historyEntries?)`
     - 先要求审批本身仍是 `pending`
     - 优先使用 row 上的 `approver_id`
     - row 缺审批人信息时，回退到 approval history 里的 pending `user_id`

2. `PlmProductView.vue` 维护 actionability cache
   - `loadApprovals()` 后后台预解析 pending approvals
   - row 自带 `approver_id` 时直接判定
   - row 缺审批人信息时，按需拉 `getApprovalHistory()` 做一次 history fallback
   - actor 变化或 approval 列表变化时会裁掉 stale cache

3. UI 和 mutation 同时收口
   - `PlmApprovalsPanel.vue` 不再按 `isApprovalPending()` 显示按钮
   - 改为按 `canActOnApproval()` 显示
   - `approveApproval / rejectApproval` 在真正发请求前会再次解析 actionability，避免旁路调用

4. 不改运行时 query / team-view 合同
   - 这轮只修 approvals actionability
   - 不改 approvals route state、team view state 或 audit/workbench 保存合同

## 结果

- 非审批人不再因为 row 处于 `pending` 就看到 `通过 / 拒绝`
- row 缺 `approver_id` 时，仍可通过 history fallback 保留审批人的操作能力
- mutation 层也不再依赖 UI 按钮本身做权限隔离
