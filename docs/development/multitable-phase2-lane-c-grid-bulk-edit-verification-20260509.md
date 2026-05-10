# Multitable Phase 2 Lane C — Grid Bulk Edit · Verification

> Companion to `multitable-phase2-lane-c-grid-bulk-edit-development-20260509.md`

## Acceptance bullets → evidence

| Acceptance bullet (#1448) | Where validated |
|---|---|
| Bulk bar offers "Set field" and "Clear field" only when selected records exist | `multitable-grid-bulk-edit.spec.ts` — *renders Set field and Clear field buttons when canBulkEdit and selection are present*; *does not render Set/Clear buttons when there is no selection* |
| Field picker excludes read-only/system fields and fields the current user cannot write | `multitable-bulk-edit-dialog.spec.ts` — *field picker excludes system, derived, link, attachment, hidden, and readonly fields*; *field picker also respects explicit fieldPermissions readOnly map*; *field picker is empty when canEdit is false* |
| Value editor reuses field-specific editor behavior where practical | `MetaBulkEditDialog.vue` mounts `MetaCellEditor` for the picked field; covered indirectly by the apply-with-set-mode test |
| Apply path uses one `patchRecords` request with expected versions when available | `multitable-grid.spec.ts` — *bulkPatch sends one patchRecords request with expectedVersion per selected row* |
| UI reports success count (and conflict/failure count, scoped to backend support) | Workbench `onBulkEditApply` parses `result.updated`/`result.failed` and surfaces via dialog `resultMessage`/`error` props; smoke-tested by *renders an error message when the parent passes a conflict / failure* |
| Partial failures do not silently disappear (within all-or-nothing backend constraint) | Forward-compat shape `{ updated, failed }` documented; conflict surface validated by *bulkPatch propagates a VERSION_CONFLICT error so the caller can surface it* |
| Record history and subscription side effects remain consistent with normal batch writes | Backend `patchRecords` is reused unchanged — no new side-effect path |
| Existing bulk delete remains unchanged | `multitable-grid.spec.ts` regression: 38/38 (was 35; +3 new). Existing *Delete selected* button remains in `MetaGridTable.vue` bar — verified visually via *renders Set field and Clear field buttons when canBulkEdit and selection are present* (which also asserts `Delete selected` is still in the bar) |

## Test runs

### Vue typecheck

```
$ pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
(no output — clean)
```

### useMultitableGrid (bulkPatch added)

```
$ pnpm --filter @metasheet/web exec vitest run tests/multitable-grid.spec.ts --reporter=dot

 ✓ tests/multitable-grid.spec.ts  (38 tests) 172ms

 Test Files  1 passed (1)
      Tests  38 passed (38)
```

The three new bulkPatch tests (added to the existing `describe('useMultitableGrid', ...)`):

```
✓ bulkPatch sends one patchRecords request with expectedVersion per selected row
✓ bulkPatch propagates a VERSION_CONFLICT error so the caller can surface it
✓ bulkPatch skips recordIds not present in rows.value (no version available)
```

### MetaGridTable bulk-bar (new spec)

```
$ pnpm --filter @metasheet/web exec vitest run tests/multitable-grid-bulk-edit.spec.ts --reporter=dot

 ✓ tests/multitable-grid-bulk-edit.spec.ts  (5 tests) 29ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

Cases:

```
✓ renders Set field and Clear field buttons when canBulkEdit and selection are present
✓ hides Set/Clear field buttons when canBulkEdit is false
✓ clicking Set field emits bulk-edit with mode=set and current selection
✓ clicking Clear field emits bulk-edit with mode=clear and current selection
✓ does not render Set/Clear buttons when there is no selection
```

### Codex review fixes (2026-05-10)

Two bugs reported on PR #1451:

1. **Selection gate too tight** — `:enable-multi-select` was bound to `gridAllowsAnyDelete`, so users with `canEdit=true / canDelete=false` could not select rows for bulk edit. Fix: bind to `gridAllowsAnyDelete || effectiveRowActions.canEdit`. Also added an explanatory HTML comment above the `<MetaGridTable>` element so the gate's intent is durable in code.
2. **Auto-submit on select/boolean change** — `MetaCellEditor`'s `select` (line 124) and `boolean` (line 113) branches emit `confirm` on native `@change`. The dialog was wiring `@confirm="onApply"`, which would silently bulk-patch the moment a user opened the dropdown or toggled a checkbox. Fix: remove the `@confirm="onApply"` binding so the explicit "Set value" / "Clear" button is the only commit path. Added an HTML comment in the dialog template explaining why the binding is intentionally omitted.

Two new regression tests added to `multitable-bulk-edit-dialog.spec.ts`:

```
✓ does NOT auto-submit when a select-typed editor fires its native change (regression: Codex review on PR #1451)
✓ does NOT auto-submit when a boolean editor fires its native change
```

Total dialog spec count: 11 → 13.

### MetaBulkEditDialog (new spec)

```
$ pnpm --filter @metasheet/web exec vitest run tests/multitable-bulk-edit-dialog.spec.ts --reporter=dot

 ✓ tests/multitable-bulk-edit-dialog.spec.ts  (11 tests) 32ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
```

Cases:

```
✓ shows the set-mode title and summary when mode is set
✓ shows the clear-mode title when mode is clear
✓ field picker excludes system, derived, link, attachment, hidden, and readonly fields
✓ field picker also respects explicit fieldPermissions readOnly map
✓ field picker is empty when canEdit is false
✓ emits apply with set-mode payload after picking a field and value
✓ emits apply with clear-mode payload (value: null) without a value editor
✓ Apply is disabled in set mode until a value is entered
✓ renders an error message when the parent passes a conflict / failure
✓ disables Apply while busy is true (re-entrancy guard)
✓ emits cancel when the close button is clicked
```

## Diff hygiene

```
$ git diff --check origin/main..HEAD
(no output — clean)
```

## Pre-deployment checks

- [x] `vue-tsc -b --noEmit` clean across `@metasheet/web`.
- [x] `multitable-grid.spec.ts` regression: 38/38 (35 → 38; the +3 are bulkPatch tests).
- [x] `multitable-bulk-edit-dialog.spec.ts`: 11/11 new.
- [x] `multitable-grid-bulk-edit.spec.ts`: 5/5 new.
- [x] No DingTalk / public-form / Gantt / Hierarchy / formula / automation runtime / `plugins/plugin-integration-core/*` files touched.
- [x] No migration / OpenAPI dist / package script / env var changes.
- [x] Pre-existing `multitable-workbench-import-flow.spec.ts` failure (`window.localStorage.clear is not a function`) verified by `git stash` regression to be a happy-dom polyfill issue on `origin/main`, **not** caused by this PR.

## Result

Lane C MVP shipped. Bulk Set / Clear flow operational over the existing `patchRecords` path with optimistic locking. Forward-compatible result shape lets a follow-up backend PR (per-record partial success) light up new dialog UI without API rework. Lane A (longText) audit is sibling PR #1449; Lane B (real email transport) remains Codex-owned per #1448.
