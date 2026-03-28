# PLM Workbench Archived Management Hard Gating Verification

## Scope

Verify that archived collaborative entries remain non-manageable for share/rename/transfer/default actions even when explicit permissions stay enabled.

## Focused Coverage

- Added a helper-level regression in `apps/web/tests/usePlmCollaborativePermissions.spec.ts`:
  - archived entry with explicit `canShare/canRename/canTransfer/canSetDefault/canClearDefault = true`
  - verifies helper and composable actionability all stay `false`

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/usePlmCollaborativePermissions.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Result

- Focused helper regression: pass
- Frontend type-check: pass
- Full PLM frontend suite: pass
