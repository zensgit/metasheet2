# Multitable System Fields Frontend Development - 2026-04-30

## Scope

This slice closes the frontend half of Phase 4 system fields after the backend seam in PR #1280.

Implemented field types:

- `createdTime`
- `modifiedTime`
- `createdBy`
- `modifiedBy`

Out of scope:

- `autoNumber`; still deferred until persistent sequence allocation exists.
- User display-name resolution for `createdBy` / `modifiedBy`; the UI displays the backend-projected actor id for now.

## Design

### Shared Type and Helper

Added the four system field types to `MetaFieldType`.

Added `apps/web/src/multitable/utils/system-fields.ts` as the single frontend helper for:

- system field type detection,
- system field create-type detection,
- readonly field-manager hint text.

This keeps edit guards consistent across grid, record drawer, form view, and field manager.

### Display Formatting

`formatFieldDisplay()` now treats:

- `createdTime` and `modifiedTime` as datetime display values,
- `createdBy` and `modifiedBy` as actor-id display values.

Invalid datetime strings intentionally fall back to raw display, matching the existing `date` behavior.

### Readonly Surfaces

System fields are explicitly read-only on the frontend:

- `MetaGridTable` refuses edit mode for system fields even when `canEdit=true`.
- `MetaCellEditor` direct mounts fall through to a formatted readonly span.
- `MetaRecordDrawer` excludes system fields from editable branch conditions.
- `MetaFormView` treats system fields as read-only and uses shared display formatting in the fallback path.
- `MetaFormView` omits system fields from submit payloads so an update to another field does not resend generated metadata and trip backend readonly validation.

Backend remains authoritative; this frontend guard only prevents avoidable UI writes before they hit the server.

### Field Manager

`MetaFieldManager` now exposes the four allowed system field types in the create dropdown.

They do not open a config panel and emit create payloads without `property`, because their values are generated from record metadata.

The add form shows a system-field hint so users know the created field is read-only.

### Icons

`MetaFieldHeader` and `MetaFieldManager` now include icons for system fields. `MetaFieldHeader` also received missing icons for several existing advanced field types so those columns no longer fall back to `?`.

## Files Changed

- `apps/web/src/multitable/types.ts`
- `apps/web/src/multitable/utils/system-fields.ts`
- `apps/web/src/multitable/utils/field-display.ts`
- `apps/web/src/multitable/components/cells/MetaCellRenderer.vue`
- `apps/web/src/multitable/components/cells/MetaCellEditor.vue`
- `apps/web/src/multitable/components/MetaGridTable.vue`
- `apps/web/src/multitable/components/MetaRecordDrawer.vue`
- `apps/web/src/multitable/components/MetaFormView.vue`
- `apps/web/src/multitable/components/MetaFieldManager.vue`
- `apps/web/src/multitable/components/MetaFieldHeader.vue`
- `apps/web/tests/multitable-system-fields.spec.ts`
- `apps/web/tests/multitable-form-view.spec.ts`
- `docs/development/multitable-feishu-rc-todo-20260430.md`

## Residual Follow-ups

- Add display-name resolution for actor ids once user-directory lookup is available in the multitable view payload.
- Revisit `autoNumber` after backend sequence allocation is designed.
