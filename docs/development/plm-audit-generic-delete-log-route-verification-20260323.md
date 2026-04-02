# PLM Audit Generic Delete Log-Route Verification

## Scope

验证顶部 generic `Delete` 不再只清空 `teamViewId`，而是和 lifecycle `Delete` 一样切到显式的 `delete` audit log route。

## Checks

- team-view audit route builder focused regression
- workspace type-check
- PLM audit regression suite

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewAudit.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- `pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewAudit.spec.ts`
  - `1` file / `4` tests passed
- `pnpm --filter @metasheet/web type-check`
  - passed
- `pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `46` files / `299` tests passed

## Verified Outcome

- generic `Delete` now delegates to the shared lifecycle delete path
- single-view delete log routes keep `teamViewId: ''` and preserve `returnToPlmPath`
- delete actions consistently land on explicit delete audit logs instead of leaving the page in the previous log/followup route
