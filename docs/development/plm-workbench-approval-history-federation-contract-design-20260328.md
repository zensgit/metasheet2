# PLM Workbench Approval History Federation Contract Design

## Problem

federation `approval_history` 的真实返回已经稳定是：

- `approvalId`
- `items`
- `total`

但 SDK 和前端 `PlmService` 仍把它声明成只有 `items` 的 payload。这样 runtime 明明存在的数据，会被类型系统直接吞掉，调用方只能靠宽泛类型才能拿到 `approvalId/total`。

## Design

- 在 `packages/openapi/dist-sdk/client.ts` 里新增显式 `PlmApprovalHistoryResponse<T>`。
- `getApprovalHistory()` 改成返回 `Promise<PlmApprovalHistoryResponse<T>>`。
- `apps/web/src/services/PlmService.ts` 同步透传这份完整 response，而不是继续错误收窄成只有 `items`。
- focused tests 直接断言 `approvalId/total/items` 被完整保留。

## Expected Outcome

federation runtime、SDK 和前端 service 对 `approval_history` 的返回形状重新一致，调用方可以稳定使用 `approvalId/total/items`，不再被错误的窄类型误导。
