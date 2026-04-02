# PLM Audit Saved View Scene Reapply Verification

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Scope

Verified:

- saved-view scene-context badges can emit `reapply-scene`
- owner-context saved views with scene linkage prefer scene reapply
- active scene-context saved views prefer scene reapply
- inactive owner-shortcut saved views keep owner pivot
- scene-only saved views also expose scene reapply

## Updated Files

- `apps/web/src/views/plmAuditSceneCopy.ts`
- `apps/web/src/views/plmAuditSavedViewSummary.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSceneCopy.spec.ts`
- `apps/web/tests/plmAuditSavedViewSummary.spec.ts`

## Focused Validation

Commands:

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/plmAuditSavedViewSummary.spec.ts tests/plmAuditSceneCopy.spec.ts tests/plmAuditSceneSummary.spec.ts
pnpm --filter @metasheet/web exec vue-tsc -b
```

Results:

- focused Vitest passed
  - `3 files / 20 tests`
- `vue-tsc` passed

## Full Validation

Commands:

```bash
pnpm --filter @metasheet/web test
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web lint
pnpm --filter @metasheet/web build
```

Results:

- `pnpm --filter @metasheet/web test` passed
  - `50 files / 254 tests`
- `pnpm --filter @metasheet/web type-check` passed
- `pnpm --filter @metasheet/web lint` passed
- `pnpm --filter @metasheet/web build` passed
