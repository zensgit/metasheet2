# Multitable Field And View ACL Template Governance Development

## Summary
- Added subject-scoped bulk template actions to `MetaSheetPermissionManager` for field-level and view-level ACL governance.
- Administrators can now take an existing sheet subject and apply one field permission template to every field in the sheet.
- Administrators can also apply one view permission template to every view in the sheet.

## Why This Slice
- The previous stacked slices made field/view overrides manageable one row at a time.
- The main remaining governance pain was operator throughput:
  - many fields
  - many views
  - one subject at a time
- This slice improves ACL administration without adding a new permission model or changing backend semantics.

## Runtime Changes

### Field Template Bulk Apply
- In the field permissions tab, every current sheet subject now gets a bulk template row.
- Available field template values:
  - `Default`
  - `Hidden`
  - `Read-only`
- Clicking `Apply to all fields` reuses the existing field-permission authoring API for every field on the active sheet.
- `Default` uses `{ remove: true }`, so the bulk action clears overrides instead of persisting explicit default-shaped rows.

### View Template Bulk Apply
- In the view permissions tab, every current sheet subject now gets a bulk template row.
- Available view template values:
  - `None`
  - `Read`
  - `Write`
  - `Admin`
- Clicking `Apply to all views` reuses the existing view-permission authoring API for every view on the active sheet.

### UI Notes
- The template rows are scoped to current sheet subjects only.
- No new subject discovery flow was added.
- Existing one-by-one field/view editing remains unchanged.
- Existing orphan override handling remains unchanged.

## Files
- `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`
- `apps/web/tests/multitable-sheet-permission-manager.spec.ts`

## Out Of Scope
- No backend API change
- No migration
- No new ACL subject type
- No record-level bulk template flow in this slice
