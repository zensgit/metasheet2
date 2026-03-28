# Multitable Workbench Import Flow Hardening

Date: 2026-03-25

## Context

The multitable import slice in the clean `codex/multitable-next` worktree had already recovered the richer modal/result/repair flow, but the highest-level `MultitableWorkbench` path still needed two hardening steps:

1. A real workbench integration regression for mixed `preflight + backend retry + picker repair`.
2. Guardrails for unexpected workbench-side import failures and missing link resolvers.

Claude Code reviewer surfaced two concrete bugs worth fixing immediately:

- workbench-level import exceptions could leave `MetaImportModal` stuck in the `importing` spinner.
- `buildImportedRecords(...)` would pass raw CSV text through for link fields if no resolver existed.

## Design

### 1. Workbench import exceptions now degrade into retryable import results

File:
- `apps/web/src/multitable/views/MultitableWorkbench.vue`

`onBulkImport(...)` now converts unexpected exceptions into a synthetic `importResult` instead of only showing a toast and clearing `importSubmitting`.

That preserves:

- original `rowIndex` mapping
- existing preflight failures
- a retryable failure entry for each backend-attempted row

So the modal moves into the normal `result` step and the user can retry, instead of getting stuck in a disabled spinner.

### 2. Link fields without resolvers now fail fast during preflight

File:
- `apps/web/src/multitable/import/delimited.ts`

For `link` / `person` fields, the importer now requires a resolver. If the workbench has no resolver for the mapped field, the row becomes a preflight failure with a field-specific message.

This is safer than the old behavior, which would push raw CSV text through to backend `createRecord(...)` and produce confusing late failures or invalid payloads.

### 3. Result-step rendering key is now stable for build failures

File:
- `apps/web/src/multitable/components/MetaImportModal.vue`

`failedPreviewRows` no longer uses `failure.index` as the Vue key, because build failures do not always carry a backend failure index. The result list now keys by original row/field identity.

### 4. High-level workbench integration coverage is now richer than the old reference

File:
- `apps/web/tests/multitable-workbench-import-flow.spec.ts`

The workbench import-flow regression now covers:

- backend transient retry from the result step
- generic link ambiguity repaired through the real picker
- mixed `preflight ambiguity + backend transient failure`, preserving original row numbers across retry/rebuild
- unexpected workbench import throws degrading into a retryable result instead of a stuck spinner

This is above the old reference line because the generic linked-record repair and the mixed-failure recovery chain are both covered at workbench level, not only at modal level.

## Files Touched

- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `apps/web/src/multitable/import/delimited.ts`
- `apps/web/src/multitable/components/MetaImportModal.vue`
- `apps/web/tests/multitable-workbench-import-flow.spec.ts`
- `apps/web/tests/multitable-import.spec.ts`

## Verification

Commands run:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-workbench-import-flow.spec.ts \
  tests/multitable-import.spec.ts \
  tests/multitable-import-modal.spec.ts \
  tests/multitable-people-import.spec.ts \
  tests/multitable-link-picker.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  tests/multitable-field-manager.spec.ts \
  tests/multitable-form-view.spec.ts \
  --reporter=dot
pnpm --filter @metasheet/web build
```

Results:

- `tsc --noEmit`: passed
- focused Vitest: passed
- `@metasheet/web build`: passed

## Claude Code

Claude Code was invoked as reviewer for this slice. It produced actionable findings this round:

- workbench import exception -> stuck spinner
- link field without resolver -> unsafe raw payload fallback
- duplicate key risk in the result-step failure list

The first, second, and fifth findings were addressed here. The concurrency/backoff suggestions were left for a later performance-focused slice because they are broader behavioral changes than the correctness blockers fixed in this round.
