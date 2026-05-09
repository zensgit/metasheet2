# Multitable System Fields Frontend Verification - 2026-04-30

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-system-fields.spec.ts \
  tests/multitable-field-manager.spec.ts \
  tests/multitable-record-drawer.spec.ts \
  tests/multitable-form-view.spec.ts \
  --reporter=dot
```

Result:

```text
Test Files  4 passed (4)
Tests       34 passed (34)
```

Note: Vitest printed `WebSocket server error: Port is already in use`; the test process still exited `0` and all targeted tests passed.

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result: exit `0`.

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-grid-link-renderer.spec.ts \
  tests/multitable-multiselect-field.spec.ts \
  --reporter=dot
```

Result:

```text
Test Files  2 passed (2)
Tests       10 passed (10)
```

```bash
git diff --check
```

Result: clean.

## Coverage

### New Tests

`apps/web/tests/multitable-system-fields.spec.ts`

- `formatFieldDisplay()` formats `createdTime` as datetime and keeps `createdBy` as actor id.
- `MetaCellRenderer` uses a dedicated system-field branch.
- `MetaCellEditor` direct-mount fallback is read-only and formatted.
- `MetaGridTable` does not enter edit mode for a system field even with `canEdit=true`.
- `MetaFieldManager` lists all four system field types and emits a create payload without `property`.

### Regression Tests

`apps/web/tests/multitable-field-manager.spec.ts`

- Existing field-manager configuration behavior remains green.
- New system-field create option does not regress select/multiSelect/link/attachment validation flows.

`apps/web/tests/multitable-record-drawer.spec.ts`

- Drawer editable and read-only branches remain green after system-field edit guard changes.

`apps/web/tests/multitable-form-view.spec.ts`

- Form view display and attachment regressions remain green.
- System fields are displayed read-only and omitted from submit payloads.

## Manual Verification Notes

Recommended staging smoke after deploy:

1. Create a multitable field with type `createdTime`.
2. Create a record.
3. Confirm the created-time value appears in grid, row expansion, record drawer, and form/detail view.
4. Double-click the created-time cell and confirm no editor opens.
5. Repeat for `modifiedTime`, `createdBy`, and `modifiedBy`.

## Known Limits

- Actor fields display raw user ids until a user display-name map is wired into the multitable view payload.
- `autoNumber` remains intentionally unshipped.
