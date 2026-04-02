# PLM Workbench Approval Version Client Contract Design

## 背景

后端 `/api/approvals/:id/approve` 和 `/api/approvals/:id/reject` 已经切到 optimistic locking：

- 请求体必须带 `version`
- stale version 返回 `409 APPROVAL_VERSION_CONFLICT`

`ApprovalInboxView.vue` 已经按这套协议发送 `version`，但 `PlmProductView.vue` 仍在调用：

- `plmService.approveApproval({ approvalId, comment })`
- `plmService.rejectApproval({ approvalId, comment })`

同时，前端服务层和 SDK 还有一层 contract 漏口：

- `apps/web/src/services/PlmService.ts` 的 `ApprovalActionParams` 还没有 `version`
- `packages/openapi/dist-sdk/client.ts` 的 `PlmApprovalActionParams` 也没有 `version`
- SDK runtime body 也没有把 `version` 透传到 `approval_approve / approval_reject`

联邦与 adapter 还有后一段未对齐：

- `packages/core-backend/src/routes/federation.ts` 的 `PLMMutationSchema` 没声明 `version`
- approval mutate 分支仍按旧 contract 调 `adapter.approveApproval(id, comment?)`
- `packages/core-backend/src/data-adapters/PLMAdapter.ts` 的 `approveApproval / rejectApproval` 也还没接受 `version`

结果是产品页审批动作会稳定打到后端 `400 Approval version is required`，并且即使页面层补了 `version`，联邦 route 和 adapter 也会继续把它吞掉，整个 client -> federation -> adapter 链无法表达后端已经要求的新协议。

## 设计目标

1. `ApprovalInboxView` 和 `PlmProductView` 统一使用同一版 optimistic-lock payload 语义。
2. `PlmService`、`openapi/dist-sdk` 和页面层的审批参数合同保持一致。
3. 缺少有效 `version` 时，前端在本地就直接失败，不发无效请求。
4. federation mutate 和 `PLMAdapter` 也必须强制要求并透传 `version`，不能只修前端半截。

## 方案

### 1. 提供统一的 approval version 解析 helper

在 `approvalInboxActionPayload.ts` 中新增：

- `resolveApprovalActionVersion(input)`

语义：

- 接收 `number` 或可解析的字符串 version
- 只接受非负整数
- 无法解析时返回 `null`

这样 `ApprovalInboxView` 和 `PlmProductView` 都可以共用同一套 version 读取语义。

### 2. 页面层统一带上 version

`PlmProductView.vue` 的 `approveApproval()` 和 `rejectApproval()` 改成：

1. 先从 entry 里读 `version`
2. `version === null` 时直接报错 `审批版本不可用`
3. 调用 `plmService` 时显式传入 `version`

其中 `reject` 同时把输入映射成：

- `reason`
- `comment`

保持和 inbox payload、后端 reject route 的兼容语义一致。

### 3. 服务层和 SDK 一起补齐参数合同

`PlmService.ts` 与 `packages/openapi/dist-sdk/client.ts` 的 `ApprovalActionParams / PlmApprovalActionParams` 统一扩成：

- `approvalId: string`
- `version: number`
- `comment?: string`
- `reason?: string`

SDK runtime body 同步透传：

- `approval_approve` -> `approvalId + version + comment`
- `approval_reject` -> `approvalId + version + reason + comment`

同时补齐生成产物：

- `packages/openapi/dist-sdk/client.js`
- `packages/openapi/dist-sdk/client.d.ts`

避免 runtime 和类型声明重新漂移。

### 4. federation / adapter 端对齐 versioned approval mutate

`packages/core-backend/src/routes/federation.ts` 改成：

- `PLMMutationSchema` 显式接受 `version` 和 `reason`
- `approval_approve / approval_reject` 分支要求非负整数 `version`
- 缺少 `version` 时返回 `400 version is required for approval actions`
- reject 兼容 `comment ?? reason`

`packages/core-backend/src/data-adapters/PLMAdapter.ts` 改成：

- `approveApproval(approvalId, version, comment?)`
- `rejectApproval(approvalId, version, comment)`

并把 `version` 透传到真实上游 payload 与 mock-mode 响应。

## 结果

修复后：

- 产品页审批动作不再绕过 optimistic locking
- 前端服务层和 SDK 与后端审批协议重新一致
- inbox / product 两条审批入口都共享同一套 version / comment / reason 合同
- federation route、adapter、SDK runtime、SDK 类型声明都落在同一条 approval version contract 上
