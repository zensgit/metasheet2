# Data Factory multitable UI entry - development notes - 2026-05-14

## Purpose

This slice makes the newly merged MetaSheet multitable adapters visible from the
Data Factory workbench.

The previous backend slices added:

- `metasheet:staging` as a source-only adapter for reading cleaned staging
  multitables;
- `metasheet:multitable` as a target-only adapter for writing cleansed output
  back into plugin-scoped multitables.

This change closes the operator-facing gap by allowing a staging multitable card
to be registered either as a dry-run source or as a multitable write target.

## UX behavior

Each installed staging dataset card now exposes three actions:

- open the multitable;
- use it as the dry-run source;
- use it as the target multitable.

The new target action creates or updates an external system with:

- `kind: metasheet:multitable`;
- `role: target`;
- `status: active`;
- `capabilities.write: true`;
- `capabilities.multitableTarget: true`;
- object configs derived from the installed staging descriptors and returned
  sheet/view/open-link metadata.

The target selector is updated immediately after the external system is saved,
and the target object/schema is hydrated from the descriptor so the operator can
continue into mapping, preview, dry-run, and save-only execution without
manually typing target object ids.

## Target object defaults

The UI derives conservative write defaults from descriptor fields:

- descriptors with `code` use keyed `upsert` on `code`;
- BOM-like descriptors with `parentCode` and `childCode` use keyed `upsert`
  on those fields, plus `sequence` when available;
- descriptors with `externalId` or `id` use that field as the key;
- descriptors without a stable key use append mode.

These defaults match the target adapter contract: configured object key fields
win over the runner's internal idempotency key, while `_integration_*` fields
remain filtered by the adapter unless an object explicitly opts into them.

## Files changed

- `apps/web/src/views/IntegrationWorkbenchView.vue`
  - added the target registration action;
  - added target-system id generation;
  - added target object config builders;
  - hydrated the target selector/object/schema after registration.
- `apps/web/src/services/integration/workbench.ts`
  - added optional `target` metadata on discovered objects.
- `apps/web/tests/IntegrationWorkbenchView.spec.ts`
  - covered visible `metasheet:multitable` adapter metadata;
  - covered target external-system payload shape and selected target state.

## Non-goals

- No backend API shape change.
- No new migration.
- No arbitrary user-owned sheet write permission.
- No formula/expert-mode mapping editor.
- No live external-system run in this slice.
