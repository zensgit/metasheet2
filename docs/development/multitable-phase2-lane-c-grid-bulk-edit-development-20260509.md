# Multitable Phase 2 Lane C — Grid Bulk Edit · Development

> Date: 2026-05-09
> Branch: `codex/multitable-phase2-grid-bulk-edit-20260509`
> Base: `origin/main@c74c15a2b`
> Spec: PR #1448 (`docs(multitable): plan Feishu phase 2 lanes`), Lane C

## Background

Lane C from #1448 turns the existing grid selection + `patchRecords` plumbing into a user-facing bulk-edit flow. Pre-PR: the only bulk action was `Delete selected`; users could not change a value on many records in one shot.

## Scope

### In

1. New shared helper `isFieldBulkEditable(field, canEdit, fieldPermission)` in `apps/web/src/multitable/utils/field-permissions.ts`.
2. New SFC `apps/web/src/multitable/components/MetaBulkEditDialog.vue` — modal dialog with field picker (filtered by the helper) + `MetaCellEditor` for value entry + per-mode behavior.
3. New emit `bulk-edit` on `MetaGridTable.vue` plus two bulk-bar buttons (`Set field`, `Clear field`) gated by a new `canBulkEdit` prop.
4. New composable method `bulkPatch({ fieldId, value, recordIds })` on `useMultitableGrid.ts` — builds the `changes` array with `expectedVersion: row.version` and dispatches a single `patchRecords` request.
5. `MultitableWorkbench.vue` mounts the dialog, wires the emit, calls `grid.bulkPatch(...)`, surfaces the result via existing toast helpers.
6. Three spec files exercising:
   - `multitable-grid-bulk-edit.spec.ts` — bulk-bar buttons / gating / emit shape (5 tests)
   - `multitable-bulk-edit-dialog.spec.ts` — picker filtering / apply emit / disabled states / error rendering (11 tests)
   - `multitable-grid.spec.ts` — composable `bulkPatch` request shape, version-conflict propagation, and skipping records absent from `rows.value` (3 tests added; total 38)

### Out

- **Per-record partial-success UI**: backend `patchRecords` runs in a single DB transaction (`record-write-service.ts:518`) and aborts on the first `VersionConflictError` / `RecordValidationError`. Surfacing a "X succeeded, Y failed" breakdown requires a new backend mode that doesn't exist today; **scoped explicitly to a follow-up backend PR (Codex-owned)**. Frontend already uses a forward-compatible return shape (`{ updated: string[]; failed: Array<{recordId, reason}> }`) so when backend grows partial-success, the dialog can render it without re-shape.
- **Multi-field bulk edit in one dialog** — explicit non-goal in #1448.
- **Bulk edits across filtered-out records or all pages** — explicit non-goal in #1448.
- **Spreadsheet-like drag-fill** — explicit non-goal in #1448.
- **Bulk edit for `attachment` / `link`** — these need attachment-upload + link-picker UIs that are heavier than this slice; the helper excludes them. Documented as a known limitation.
- **Lane B** — Codex-owned per #1448.

## K3 PoC Stage 1 Lock

- Does NOT modify `plugins/plugin-integration-core/*`.
- No migration / OpenAPI dist / runtime changes outside the multitable workbench.
- Does NOT touch DingTalk / public-form / Gantt / Hierarchy / formula / automation runtime.

## Implementation notes

### Helper extraction (advisor item 1)

`MetaRecordDrawer.vue:361` already has a `canEditField(fieldId)` that depends on row-specific state (`rowActions?.canEdit`) and per-field permission overrides. For bulk edit the question is field-level (not row-level) — does the sheet allow edit + is this field writable + is it a derived/system/hidden field — so we extracted a NEW pure helper rather than refactoring drawer's row-aware check. The two checks intentionally serve different surfaces; they share the underlying `isSystemField` utility. Documented here so the duplication is pre-cleared.

### Forward-compatible return shape (advisor item 2)

```ts
type BulkPatchResult = { updated: string[]; failed: Array<{ recordId: string; reason: string }> }
```

Today: `failed` is always empty (transactions are all-or-nothing — full success or thrown error). When backend grows partial-success, the same shape carries per-record failures with no consumer change.

### Conflict / error path (advisor item 3)

Workbench's `onBulkEditApply`:
- Wraps `grid.bulkPatch(...)` in `try/catch`.
- On `VERSION_CONFLICT`: surfaces "Some records were modified elsewhere. Reload and retry. (<server message>)" via `bulkEditDialog.error` + `showError`.
- On non-version errors: displays the original message.
- On success: closes the dialog and shows a success toast.

Dialog has a dedicated `error` prop the parent flows in; when present, the dialog renders `.meta-bulk-edit__error` so failures cannot silently disappear (within the all-or-nothing constraint).

### Value editor reuse (advisor item 4)

Tried `MetaCellEditor` directly with only `field` + `modelValue`. Its `recordId` is documented optional ("When absent, the Yjs opt-in cannot engage; the editor falls back to the existing REST path") so it works for primitive types out of the box. Attachment / link types are excluded from the picker, so the editor never has to render their record-bound branches inside the dialog.

The cut here vs. spec ("Value editor reuses field-specific editor behavior **where practical**"): `MetaCellEditor` is reused for every field type the picker exposes — `string`, `longText`, `number`, `boolean`, `date`, `dateTime`, `select`, `multiSelect`, `currency`, `percent`, `rating`, `url`, `email`, `phone`, `barcode`, `location`. Excluded types are listed under Known limitations.

### Capabilities plumbing (advisor item 5)

Mirrors the drawer's path:

```
Workbench
  ├── effectiveRowActions.canEdit  ──>  :can-edit
  ├── effectiveFieldPermissions     ──>  :field-permissions
  └── scopedAllFields               ──>  :fields
```

`canBulkEdit` on `MetaGridTable` is bound to the same `effectiveRowActions.canEdit` so the bar buttons appear iff the user has sheet-level edit. The dialog applies the field-level filter via the helper.

## Files changed

| File | Change |
|---|---|
| `apps/web/src/multitable/utils/field-permissions.ts` | Add `isFieldBulkEditable` + `NON_BULK_EDITABLE_TYPES` set; import `isSystemField`. |
| `apps/web/src/multitable/components/MetaBulkEditDialog.vue` | New SFC, ~150 lines incl. style. |
| `apps/web/src/multitable/components/MetaGridTable.vue` | Add `canBulkEdit?: boolean` prop, two bulk-bar buttons, `bulk-edit` emit, `onBulkEdit(mode)` handler. |
| `apps/web/src/multitable/composables/useMultitableGrid.ts` | Add `bulkPatch(...)` method (~30 lines) + expose in return. |
| `apps/web/src/multitable/views/MultitableWorkbench.vue` | Import + mount `MetaBulkEditDialog`, dialog state via `reactive`, three handlers (`onBulkEditRequest` / `onBulkEditCancel` / `onBulkEditApply`), `:can-bulk-edit="effectiveRowActions.canEdit"` on grid, `@bulk-edit="onBulkEditRequest"` listener. |
| `apps/web/tests/multitable-grid-bulk-edit.spec.ts` | New, 5 tests on bulk-bar UX. |
| `apps/web/tests/multitable-bulk-edit-dialog.spec.ts` | New, 11 tests on dialog. |
| `apps/web/tests/multitable-grid.spec.ts` | Add 3 `bulkPatch` composable tests. |
| `docs/development/multitable-phase2-lane-c-grid-bulk-edit-development-20260509.md` | This file. |
| `docs/development/multitable-phase2-lane-c-grid-bulk-edit-verification-20260509.md` | Companion verification. |

## Known limitations

1. **All-or-nothing transactions** — see Out-of-scope above. Following backend changes can surface per-record failures via the existing `failed[]` field.
2. **Attachment / link bulk edit** excluded — needs additional UI (file uploader / link picker) beyond the dialog's MetaCellEditor reuse. Filed implicitly as a follow-up via the explicit `NON_BULK_EDITABLE_TYPES` set in `field-permissions.ts`.
3. **No undo for bulk edits** — single-cell edits push to `editHistory`; bulk does not. Reasoning: bulk undo is itself a bulk write that may conflict; the simpler "show conflict on retry, refresh, repeat" loop is the same UX the rest of the app already presents. Filed as follow-up if user feedback warrants.
4. **MetaRecordDrawer's row-aware `canEditField` is not unified** with the new field-level helper because the two answer different questions (per-row vs. sheet-level). Deliberate per advisor review.

## Cross-references

- Backend transaction guarantee: `packages/core-backend/src/multitable/record-write-service.ts:518` (transactional patch) and `:548–550` (`VersionConflictError` throws aborts the batch).
- Existing single-cell edit precedent: `apps/web/src/multitable/composables/useMultitableGrid.ts:499–552` (`patchCell`).
- Existing bulk-delete precedent: `apps/web/src/multitable/views/MultitableWorkbench.vue:2411` (`onBulkDelete`).
- Drawer's row-aware permission check: `apps/web/src/multitable/components/MetaRecordDrawer.vue:361` (`canEditField`).
- Lane A audit (sibling PR): #1449.
- Phase 2 plan: #1448.
