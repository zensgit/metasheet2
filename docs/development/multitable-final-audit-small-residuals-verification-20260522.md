# Multitable Final Audit Slice A Verification — Small Residuals

Date: 2026-05-22
Branch: `frontend/multitable-final-i18n-audit-20260522`
Base: `origin/main@a235a5c1e`

## DoD

- Final audit inventory exists: `docs/development/multitable-final-i18n-audit-20260522.md`.
- Slice A design exists: `docs/development/multitable-final-audit-small-residuals-design-20260522.md`.
- Five scoped residual groups are wired:
  - `MetaMentionPopover.vue` static chrome and extra-field suffix.
  - `MetaCellEditor.vue` reachable link action label.
  - `validateAttachmentSelection()` frontend fallback errors.
  - `resolvePeopleImportValue()` single-person limit fallback.
  - `formatFieldDisplay()` boolean/link/attachment summary fallbacks.
- Raw data remains raw: record labels, field names, file names, MIME types, person names, record IDs, and existing backend/composable errors are not translated.
- Deferred surfaces remain explicitly out of scope: visual/alt-view chrome, formula docs, API client fallbacks, backend/contract/migration/attendance/K3.

## Files Changed

Implementation:

- `apps/web/src/multitable/components/MetaMentionPopover.vue`
- `apps/web/src/multitable/components/cells/MetaCellEditor.vue`
- `apps/web/src/multitable/components/cells/MetaCellRenderer.vue`
- `apps/web/src/multitable/components/MetaFormView.vue`
- `apps/web/src/multitable/components/MetaRecordDrawer.vue`
- `apps/web/src/multitable/components/MetaCalendarView.vue`
- `apps/web/src/multitable/components/MetaGalleryView.vue`
- `apps/web/src/multitable/components/MetaTimelineView.vue`
- `apps/web/src/multitable/components/MetaKanbanView.vue`
- `apps/web/src/multitable/components/MetaHierarchyView.vue`
- `apps/web/src/multitable/components/MetaGanttView.vue`
- `apps/web/src/multitable/views/MultitableWorkbench.vue`
- `apps/web/src/multitable/utils/meta-comment-labels.ts`
- `apps/web/src/multitable/utils/field-display.ts`
- `apps/web/src/multitable/utils/field-config.ts`
- `apps/web/src/multitable/utils/people-import.ts`

Tests:

- `apps/web/tests/meta-comment-labels.spec.ts`
- `apps/web/tests/multitable-mention-popover.spec.ts`
- `apps/web/tests/meta-cell-editor-i18n.spec.ts`
- `apps/web/tests/multitable-people-import.spec.ts`
- `apps/web/tests/multitable-field-display-i18n.spec.ts`
- `apps/web/tests/multitable-field-config-i18n.spec.ts`

Docs:

- `docs/development/multitable-final-i18n-audit-20260522.md`
- `docs/development/multitable-final-audit-small-residuals-design-20260522.md`
- `docs/development/multitable-final-audit-small-residuals-verification-20260522.md`

## Test Evidence

Command:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/meta-comment-labels.spec.ts \
  tests/multitable-mention-popover.spec.ts \
  tests/meta-cell-editor-i18n.spec.ts \
  tests/multitable-people-import.spec.ts \
  tests/multitable-field-display-i18n.spec.ts \
  tests/multitable-field-config-i18n.spec.ts \
  tests/multitable-location-field.spec.ts \
  tests/multitable-number-format.spec.ts \
  tests/multitable-system-fields.spec.ts \
  --watch=false
```

Result:

```text
Test Files  9 passed (9)
Tests       49 passed (49)
```

Command:

```bash
pnpm --filter @metasheet/web run type-check
```

Result:

```text
> @metasheet/web@2.0.0-alpha.1 type-check
> vue-tsc -b
```

Exit code: 0.

Command:

```bash
pnpm --filter @metasheet/web build
```

Result:

```text
✓ 2420 modules transformed.
✓ built in 6.75s
```

Build warnings:

- Existing Vite warning: `WorkflowDesigner.vue` is both dynamically and statically imported.
- Existing Vite chunk-size warning for large bundles.

## Raw Boundary Checks

- `MetaMentionPopover`: record labels `Alpha` / `Beta` and field name `Title` remain raw in zh-CN render; only `Mentions`, `Close mentions`, `Unread`, and `+1 more` chrome localize.
- `MetaCellEditor`: link action uses `formatLinkActionLabel(field, count, isZh.value)`; field metadata remains raw.
- `validateAttachmentSelection`: MIME value such as `application/pdf` is interpolated raw.
- `resolvePeopleImportValue`: raw import value is interpolated raw after the localized prefix.
- `formatFieldDisplay`: linked record display names and attachment filenames remain raw when summaries exist.
- Existing backend/composable errors remain raw because Slice A only localizes frontend static fallbacks.

## Preflight / Deferred Confirmation

Preflight confirmed `apps/web/src/multitable/components/cells/` contains only:

- `MetaCellEditor.vue`
- `MetaCellRenderer.vue`

There are no separate `MetaSelectCellEditor.vue`, `MetaDateCellEditor.vue`, or `MetaLinkCellEditor.vue` variants to wire in Slice A.

Remaining visible residuals are intentionally deferred:

- Visual/alt-view chrome in Calendar/Gallery/Timeline/Gantt/Hierarchy/Kanban/Dashboard/Chart.
- Formula help/example strings.
- API client fallback messages.
- `formatLinkActionLabel` unreachable fallback branch in `MetaCellEditor.vue` remains English by design until a future refactor makes it reachable.

## Worktree Notes

This clean worktree initially had no `node_modules`, so `vitest` was not resolvable. To avoid `pnpm install` tracked symlink noise, `apps/web/node_modules` was linked to the main worktree dependency tree. The path is ignored and not part of the PR diff.
