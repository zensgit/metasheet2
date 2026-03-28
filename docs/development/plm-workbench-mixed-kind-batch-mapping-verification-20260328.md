# PLM Workbench mixed-kind batch mapping verification

## Scope

- `apps/web/src/services/plm/plmWorkbenchClient.ts`
- `apps/web/tests/plmWorkbenchClient.spec.ts`

## Checks

1. `mapTeamView(...)` 优先读取返回项自己的 `kind`。
2. `batchPlmWorkbenchTeamViews('documents', ...)` 在 mixed payload 下仍能正确返回 `cad` 和 `approvals` 条目。
3. 现有 client 回归不受影响。

## Validation commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchClient.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```
