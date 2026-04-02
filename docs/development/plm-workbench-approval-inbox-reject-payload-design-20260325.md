# PLM Workbench Approval Inbox Reject Payload Design

## 背景

[ApprovalInboxView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/ApprovalInboxView.vue) 的 `Reject` 动作之前直接把输入框内容只作为 `comment` 发给后端：

- `approve`: `{ comment }`
- `reject`: 也还是 `{ comment }`

但后端 [approvals.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend/src/routes/approvals.ts) 的 `/api/approvals/:id/reject` 明确要求 `reason`，`comment` 只是可选补充。

## 问题

结果就是：

1. 用户在 inbox 里填写拒绝备注
2. 点击 `Reject`
3. 后端仍返回 `400 Rejection reason is required`

前端把“拒绝原因”错误建模成了可选备注，所以这条路径本身不可用。

## 设计

把 inbox action payload 收成纯 helper：

1. 新增 [approvalInboxActionPayload.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/approvalInboxActionPayload.ts)
   - `normalizeApprovalInboxComment(comment)`
   - `canSubmitApprovalInboxAction(action, comment)`
   - `buildApprovalInboxActionPayload(action, comment)`

2. `approve`
   - 保持原语义
   - comment 为空时发空对象
   - comment 非空时发 `{ comment }`

3. `reject`
   - 输入框内容视为拒绝原因
   - 前端要求非空
   - payload 同时发：
     - `reason`
     - `comment`

4. `ApprovalInboxView.vue` 同步 UX
   - `Reject` 按钮在 comment 为空时直接禁用
   - placeholder 改成 `Optional for approve, required for reject`
   - `performAction()` 在前端先做一次 submit gate，避免继续把空 reject 打到后端

## 结果

- inbox `Reject` 不再稳定 400
- reject 的提交条件和后端合同一致
- approve / reject 的 request payload 语义不再混用
