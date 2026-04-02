# PLM Workbench Default Reapply Verification

## Focus

Verify that default targets can be auto-applied again after a user explicitly switches to a non-default target and that explicit target later becomes stale.

## Added Coverage

- [/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)
  - re-applies the default workbench team view after an explicit target becomes stale
- [/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
  - re-applies the default team preset after an explicit preset becomes stale

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts tests/usePlmTeamFilterPresets.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- `tests/usePlmTeamViews.spec.ts tests/usePlmTeamFilterPresets.spec.ts`: `72` tests passed
- `pnpm --filter @metasheet/web type-check`: passed
- `pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`: `53` files / `393` tests passed
