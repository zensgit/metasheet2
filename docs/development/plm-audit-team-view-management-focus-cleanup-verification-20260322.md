# PLM Audit Team View Management Focus Cleanup Verification

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Scope

Verify that stale lifecycle-management focus no longer survives source pivots and that the cleanup stays aligned with the existing recommendation/saved-view attention rules.

## Focused Checks

Commands:

```bash
cd apps/web
pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts tests/plmAuditTeamViewCatalog.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts
pnpm --filter @metasheet/web type-check
```

Checks:

- transient attention reducer can clear source-only, management-only, or all focus
- recommendation catalog cleanup still works
- collaboration followup source focus still works
- integrated `PlmAuditView.vue` keeps compiling after the shared attention cleanup

## Full PLM Frontend Regression

Command:

```bash
cd apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Result:

- `43` test files passed
- `237` tests passed

## Results

- `cd apps/web && pnpm exec vitest run tests/plmAuditSavedViewAttention.spec.ts tests/plmAuditTeamViewCatalog.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts`
  - passed, `3 files / 34 tests`
- `pnpm --filter @metasheet/web type-check`
  - passed
- `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - passed, `43 files / 237 tests`

## Verified Paths

1. `focus-source -> saved-view source highlight` clears stale management focus first
2. `saved-view context quick action` clears previous management/source focus
3. `Apply saved view` clears previous management/source focus
4. `Apply filters` clears previous management/source focus
5. `Reset filters` clears previous management/source focus
6. pagination changes clear previous management/source focus

## Notes

- This slice is frontend-only.
- No backend, API, or route serialization contract changed.
- No browser-level UI replay was added; confidence comes from helper coverage, targeted PLM regression coverage, and `vue-tsc`.
