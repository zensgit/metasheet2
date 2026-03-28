# PLM Workbench Approval History OpenAPI Parity Verification

## Scope

- `packages/openapi/src/paths/approvals.yml`
- `packages/openapi/dist/openapi.yaml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist-sdk/scripts/build.mjs`
- `packages/openapi/dist-sdk/package.json`
- `packages/openapi/dist-sdk/index.d.ts`

## Checks

1. `/api/approvals/{id}/history` 的 `200` 响应 source schema 变为 `ok + data.items/page/pageSize/total`。
2. `packages/openapi/dist-sdk/build` 可以直接成功，不再因为缺 `dist/sdk.ts` 失败。
3. regenerated `dist` 和 `dist-sdk` 不再把该接口声明成裸 `Pagination`。
4. 后端 route test 继续验证真实响应 envelope，没有 source/runtime 再次分叉。

## Validation Commands

- `cd packages/core-backend && pnpm exec vitest run tests/unit/approval-history-routing.test.ts`
- `pnpm exec vitest run packages/openapi/dist-sdk/tests/client.test.ts`
- `pnpm exec tsx packages/openapi/tools/build.ts`
- `cd packages/openapi/dist-sdk && pnpm build`
