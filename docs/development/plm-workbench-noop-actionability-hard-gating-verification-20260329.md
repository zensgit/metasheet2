# PLM Workbench No-op Actionability Hard Gating Verification

## Focused Verification

- Extend `tests/usePlmCollaborativePermissions.spec.ts`
- Seed entries with stale explicit permissions that disagree with current state
- Verify:
  - archived entries cannot archive
  - non-archived entries cannot restore
  - default entries cannot set default again
  - non-default entries cannot clear default

## Regression Coverage

- Keep the existing archived management hard-gating test green
- Keep legacy `permissions.canManage` override flows green
- Run full PLM frontend regressions

## Commands

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmCollaborativePermissions.spec.ts`
- `pnpm --filter @metasheet/web type-check`
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
