# Multitable Gantt Self-Table Dependency Field · Design

> Date: 2026-05-07
> Scope: Gantt dependency field tightening follow-up after PR #1409
> Branch: `codex/multitable-gantt-self-table-dependency-20260507`

## Context

PR #1409 narrowed Gantt dependency fields from `link | multiSelect | string` to `link`, but the original Feishu parity plan required `dependencyFieldId` to be a self-table link field. A cross-table link is still a link, but it cannot reliably draw arrows in the current Gantt view because the rendered task set only contains records from the active sheet.

## Design

This follow-up applies the same self-table constraint in three places:

1. Frontend config normalization
   - `resolveGanttViewConfig()` now accepts an optional `sheetId`.
   - A configured dependency field is kept only when it is a link whose `property.foreignSheetId` (or compatible aliases) equals the active sheet id.
   - Without a sheet id, the function keeps the old link-only behavior for existing isolated unit tests and non-render callers.

2. Frontend selectable fields
   - `MetaGanttView` receives `sheetId` from `MultitableWorkbench` and only lists self-table link fields in the dependency dropdown.
   - `MetaViewManager` already has `sheetId`; its Gantt dependency dropdown now uses the same helper.

3. Backend write guard
   - `POST /api/multitable/views` and `PATCH /api/multitable/views/:viewId` validate Gantt `config.dependencyFieldId` before persisting.
   - The guard reads the field from `meta_fields` for the target sheet and requires:
     - `type === 'link'`
     - `property.foreignSheetId === view.sheet_id`
   - Invalid configs return `400 VALIDATION_ERROR`.

## Key Decision

The canonical target sheet property remains `foreignSheetId`; aliases `foreignDatasheetId` and `datasheetId` are supported where the existing field-codec path already normalizes them.

## Out Of Scope

- No generic view-config schema framework is introduced.
- No backend validation is added for every Gantt config property.
- No Hierarchy drag-to-reparent work is included.
- No migration is required; stale stored configs are scrubbed by frontend normalization and rejected on the next explicit Gantt config save.

## Files

- `apps/web/src/multitable/utils/view-config.ts`
- `apps/web/src/multitable/components/MetaGanttView.vue`
- `apps/web/src/multitable/components/MetaViewManager.vue`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `packages/core-backend/src/routes/univer-meta.ts`
- `apps/web/tests/multitable-gantt-view.spec.ts`
- `apps/web/tests/multitable-view-manager.spec.ts`
- `apps/web/tests/multitable-workbench-view.spec.ts`
- `packages/core-backend/tests/integration/multitable-view-config.api.test.ts`
