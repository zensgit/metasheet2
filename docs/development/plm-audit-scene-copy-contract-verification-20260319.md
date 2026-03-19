# PLM Audit Scene Copy Contract Verification

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`

## Focused Validation

Command:

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/plmAuditSceneCopy.spec.ts \
  tests/plmAuditSceneToken.spec.ts \
  tests/plmAuditSceneInputToken.spec.ts \
  tests/plmAuditSceneSummary.spec.ts \
  tests/plmAuditSavedViewSummary.spec.ts \
  tests/plmAuditTeamViewContext.spec.ts \
  tests/plmAuditSceneSourceCopy.spec.ts
```

Purpose:

- verify semantic resolution
- verify copy strings are unchanged after centralization
- verify source labels and quick-action hints still match prior behavior

## Follow-up Validation

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`

## Scope Note

This slice only centralizes frontend copy and helper wiring. No backend, federation, SDK, or upstream PLM contract changed.

