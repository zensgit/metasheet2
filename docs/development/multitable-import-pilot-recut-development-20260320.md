# Multitable Import Pilot Recut Development

Date: 2026-03-20
Base: `origin/main` at `fe3e4c9ab853f7ee3a41920a1320fb7155629519`
Branch: `recut/multitable-import-main`

## Scope

Recut the frontend-only CSV/TSV import slice from legacy multitable work into current `main` without pulling attachment, backend, migration, or OpenAPI changes.

Included paths:

- `apps/web/src/multitable/components/MetaImportModal.vue`
- `apps/web/src/multitable/import/bulk-import.ts`
- `apps/web/src/multitable/import/delimited.ts`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `apps/web/tests/multitable-import.spec.ts`

## Behavior

- Adds a modal flow for selecting CSV/TSV files and mapping import fields.
- Parses delimited files in the browser and normalizes rows before submission.
- Imports rows through the existing multitable record creation path on current `main`.
- Reports partial import failures instead of collapsing the whole batch into a single generic error.

## Exclusions

This recut explicitly excludes:

- attachment uploads
- backend route changes
- migrations
- OpenAPI regeneration
- pilot/on-prem docs and workflow files

Those remain separate follow-up work because current `main` still lacks the backend attachment/form-context implementation required for an end-to-end attachment slice.
