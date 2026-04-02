# PLM Audit Team View Scene Reapply Verification

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Scope

Verified:

- team-view local context notes can emit `reapply-scene`
- active owner-context notes prefer scene reapply
- active and inactive scene-context notes prefer scene reapply
- inactive owner-shortcut notes keep owner pivot
- `PlmAuditView.vue` treats `reapply-scene` as scene-query restore

## Updated Files

- `apps/web/src/views/plmAuditTeamViewContext.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewContext.spec.ts`
- `docs/development/plm-audit-team-view-scene-reapply-design-20260320.md`

## Focused Validation

Commands:

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/plmAuditTeamViewContext.spec.ts tests/plmAuditSceneCopy.spec.ts tests/plmAuditSavedViewSummary.spec.ts tests/plmAuditSceneSummary.spec.ts
pnpm --filter @metasheet/web exec vue-tsc -b
```

Results:

- focused Vitest passed
  - `4 files / 24 tests`
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
  - `50 files / 255 tests`
- `pnpm --filter @metasheet/web type-check` passed
- `pnpm --filter @metasheet/web lint` passed
- `pnpm --filter @metasheet/web build` passed
