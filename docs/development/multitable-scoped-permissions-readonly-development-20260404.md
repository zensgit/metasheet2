# Multitable Scoped Permissions Readonly Development

Date: 2026-04-04

## Summary

This slice makes multitable scoped field permissions materially useful instead of mirroring only coarse record edit capability.

The backend now marks fields as `readOnly` when they are:

- computed fields (`formula`, `lookup`, `rollup`)
- explicitly configured as readonly via field property (`readonly` or `readOnly`)

This behavior is now consistent across:

- `GET /api/multitable/context`
- `GET /api/multitable/form-context`
- `GET /api/multitable/records/:recordId`
- `GET /api/multitable/view` via `meta.permissions.fieldPermissions`

## Implementation

### Backend permission derivation

Updated `packages/core-backend/src/routes/univer-meta.ts`:

- added `isFieldAlwaysReadOnly()`
- changed `deriveFieldPermissions()` to combine coarse write capability with field-level readonly semantics

The new rule is:

`permission.readOnly = coarseReadOnly || computedField || explicitReadonlyProperty`

### Tests

Added backend integration coverage:

- `packages/core-backend/tests/integration/multitable-context.api.test.ts`
  - verifies context field permissions for computed and explicit readonly fields
- `packages/core-backend/tests/integration/multitable-record-form.api.test.ts`
  - verifies the same behavior across form context and record context

Added frontend consumer coverage:

- `apps/web/tests/multitable-record-drawer.spec.ts`
  - verifies scoped field permissions render a readonly field as display-only even when row editing is otherwise allowed

## Notes

- No API contract change was needed.
- No OpenAPI source or generated artifact changed.
- No frontend runtime component behavior had to be rewritten because form/grid/drawer already consume `fieldPermissions.readOnly`; this slice makes the backend feed them better data.
- Worktree-local plugin `node_modules` symlink noise from `pnpm install --ignore-scripts` was intentionally excluded from this change.
