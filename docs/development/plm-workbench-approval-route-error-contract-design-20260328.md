# PLM Workbench Approval Route Error Contract Design

## Problem

`/api/approvals/:id/approve` 和 `/api/approvals/:id/reject` 的 direct route 只把 optimistic-lock 错误做成了结构化 `ok:false/error:{code,message}`，但其它真实分支还在返回 legacy 顶层字符串 `error`：

- `401` user id 缺失
- `404` approval 不存在
- `400` 非 pending 状态 / reject reason 缺失
- `500` 通用失败

这导致 runtime 和 OpenAPI/前端反馈链继续分叉。

## Design

- 在 `packages/core-backend/src/routes/approvals.ts` 新增统一的 `approvalErrorResponse(code, message)` helper。
- `approve/reject` 的所有 route-owned 错误分支都改成统一结构化 envelope。
- `packages/openapi/src/paths/approvals.yml` 为这两个 route 补齐真实存在的 `404` 和 `503` 响应声明。

## Expected Outcome

direct approval route 的 runtime/source/frontend error contract 重新一致，不再混用“冲突结构化、其它顶层字符串”的双轨错误语义。
