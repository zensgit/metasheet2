# PLM Workbench Approval History Version Parity Verification

## Scope

- `packages/core-backend/src/routes/approval-history.ts`
- `packages/core-backend/tests/unit/approval-history-routing.test.ts`

## Checks

1. history route 读取 `from_version` / `to_version`。
2. history route 继续返回兼容字段 `version`。
3. 原分页 envelope 和 mounted route 行为不回退。

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm exec vitest run tests/unit/approval-history-routing.test.ts
pnpm build
```

## Result

- focused backend route tests:
  - `pnpm exec vitest run tests/unit/approval-history-routing.test.ts`
  - `1` file / `2` tests passed
- `packages/core-backend` build:
  - `pnpm build`
  - passed
