# PLM Workbench Approval Inbox Version Payload Design

## Problem

后端审批动作已经切到 optimistic locking，`approve / reject` 都要求请求体里带 `version`。

但 [ApprovalInboxView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/ApprovalInboxView.vue) 仍然只提交 comment/reason，没有把当前列表行里的 `approval.version` 带进 payload，所以 inbox 上的审批动作会稳定命中：

- `400 APPROVAL_VERSION_REQUIRED`

## Target

让 approval inbox 的 `approve / reject` 与后端 optimistic-lock contract 对齐：始终带上当前行版本号。

## Design

1. 在 [approvalInboxActionPayload.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/approvalInboxActionPayload.ts) 中把 `buildApprovalInboxActionPayload(...)` 改成强制接收 `version`。
2. payload 统一包含：
   - `version`
   - `comment`（approve 可选）
   - `reason + comment`（reject 必填 comment 时双写）
3. 在 [ApprovalInboxView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/ApprovalInboxView.vue) 的 `performAction(...)` 中：
   - 先从当前 approvals 列表里按 id 找到行
   - 读取 `approval.version`
   - 缺失时直接报错，不发请求
   - 成功时把 version 传给 payload helper

## Non-Goals

- 不改变 approve/reject 的文案。
- 不改后端 optimistic-locking 响应结构。
- 不额外引入 ApprovalInbox 组件级 UI 测试。
