# PLM Audit Scene Reapply Action Verification

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Scope

Verified:

- the audit scene summary card can expose a dedicated `reapply-scene` action
- owner-context and scene-context summaries now prefer scene reapply over token-primary reuse
- inactive owner-shortcut summaries still keep the owner-pivot action
- `PlmAuditView.vue` routes `reapply-scene` to `restoreAuditSceneQuery()`

## Updated Files

- `apps/web/src/views/plmAuditSceneSummary.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSceneSummary.spec.ts`
- `docs/development/plm-audit-scene-reapply-action-design-20260320.md`

## Focused Validation

Commands:

```bash
pnpm --filter @metasheet/web exec vitest run --watch=false tests/plmAuditSceneSummary.spec.ts tests/plmAuditSceneCopy.spec.ts tests/plmAuditSceneToken.spec.ts
pnpm --filter @metasheet/web exec vue-tsc -b
```

Results:

- focused Vitest passed
  - `3 files / 19 tests`
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
  - `50 files / 253 tests`
- `pnpm --filter @metasheet/web type-check` passed
- `pnpm --filter @metasheet/web lint` passed
- `pnpm --filter @metasheet/web build` passed
