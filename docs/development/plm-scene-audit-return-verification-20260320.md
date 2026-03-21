# PLM Scene Audit Return Verification

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Scope

Verified:

- the new `auditReturnTo` route state
- the product-to-audit return path wiring
- the returned workbench scene auto-focus/highlight hook

## Updated Files

- `apps/web/src/views/plmAuditQueryState.ts`
- `apps/web/src/views/plm/plmWorkbenchSceneAudit.ts`
- `apps/web/src/views/PlmProductView.vue`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditTeamViewAudit.ts`
- `apps/web/tests/plmWorkbenchSceneAudit.spec.ts`
- `apps/web/tests/plmAuditQueryState.spec.ts`
- `apps/web/tests/plmAuditTeamViewAudit.spec.ts`

## Focused Validation

Commands:

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/plmWorkbenchSceneAudit.spec.ts tests/plmAuditQueryState.spec.ts tests/usePlmProductPanel.spec.ts
pnpm --filter @metasheet/web lint
```

Results:

- focused Vitest passed
  - `3 files / 14 tests`
- lint passed

## Full Validation

Commands:

```bash
pnpm --filter @metasheet/web test
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web build
```

Results:

- `pnpm --filter @metasheet/web test` passed
  - `50 files / 252 tests`
- `pnpm --filter @metasheet/web type-check` passed
- `pnpm --filter @metasheet/web build` passed

## Environment Note

Validation was briefly blocked earlier by `ENOSPC` while the filesystem had about `106 MiB` free. After space recovered to roughly `333 MiB`, the full frontend validation completed successfully.
