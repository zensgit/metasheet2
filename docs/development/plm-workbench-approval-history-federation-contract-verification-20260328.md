# PLM Workbench Approval History Federation Contract Verification

## Scope

- `packages/openapi/dist-sdk/client.ts`
- `packages/openapi/dist-sdk/client.d.ts`
- `packages/openapi/dist-sdk/client.js`
- `apps/web/src/services/PlmService.ts`
- `apps/web/tests/plmService.spec.ts`
- `packages/openapi/dist-sdk/tests/client.test.ts`

## Checks

1. SDK `getApprovalHistory()` 返回类型包含 `approvalId/items/total`。
2. `PlmService.getApprovalHistory()` 不再把 federation response 错误收窄成只有 `items`。
3. runtime focused tests 继续验证 SDK 和前端 service 都能拿到完整 envelope。

## Validation Commands

- `pnpm --filter @metasheet/web exec vitest run tests/plmService.spec.ts`
- `pnpm exec vitest run packages/openapi/dist-sdk/tests/client.test.ts`
- `cd packages/openapi/dist-sdk && pnpm build`
