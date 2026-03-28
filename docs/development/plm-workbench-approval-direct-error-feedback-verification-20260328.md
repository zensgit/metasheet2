# PLM Workbench Approval Direct Error Feedback Verification

## Scope

- `apps/web/src/views/approvalInboxFeedback.ts`
- `apps/web/tests/plmApprovalInboxFeedback.spec.ts`

## Checks

1. `error.message` 结构化错误继续优先显示。
2. 顶层字符串 `error` 现在会被正确解析成用户可见文案。
3. 无法解析 payload 时仍回退到 `status statusText`。

## Validation Commands

- `pnpm --filter @metasheet/web exec vitest run tests/plmApprovalInboxFeedback.spec.ts`
- `pnpm --filter @metasheet/web type-check`
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
