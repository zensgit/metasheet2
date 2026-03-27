# PLM Workbench Approval History Select Parity Verification

## Scope

- `packages/core-backend/src/routes/approval-history.ts`
- `packages/core-backend/tests/unit/approval-history-routing.test.ts`

## Checks

1. `/api/approvals/:id/history` 返回 `id`。
2. `/api/approvals/:id/history` 返回 `actor_name`。
3. 原分页 envelope、认证约束和 mounted route 行为不回退。

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm exec vitest run tests/unit/approval-history-routing.test.ts
pnpm build
```

## Result

- focused backend route tests:
  - `1` file / `2` tests passed
- `packages/core-backend` build:
  - passed
