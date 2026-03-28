# Multitable Attachment Functional Slice

Date: 2026-03-25
Repo: `/Users/huazhou/Downloads/Github/metasheet2-multitable-next`

## Context

The clean `multitable-next` worktree already had backend attachment routes and partial frontend upload plumbing, but the actual UI chain was still broken:

- `apiFetch()` still defaulted JSON content type semantics in a way that risked `FormData` upload requests.
- `uploadAttachment()` needed to tolerate nested `{ attachment }` payloads.
- grid state already had `attachmentSummaries`, but `MetaGridTable`, `MetaFormView`, `MetaRecordDrawer`, and `MultitableWorkbench` were not threading them through.
- form/drawer attachment fields only stored raw file names or IDs and did not provide a functional upload/remove surface.

## Design

### 1. Make attachment transport safe first

- `apps/web/src/utils/api.ts`
  - `authHeaders()` no longer injects `Content-Type`.
  - `apiFetch()` only auto-adds `application/json` for non-`FormData` bodies.
- `apps/web/src/multitable/api/client.ts`
  - `uploadAttachment()` now unwraps both direct `MetaAttachment` and nested `{ attachment: MetaAttachment }`.

This keeps upload behavior correct without changing existing JSON callers.

### 2. Promote attachment summaries to first-class frontend state

- `apps/web/src/multitable/types.ts`
  - added `attachmentSummaries` to view/record/form/patch result types
  - added attachment upload/delete function types
- `apps/web/src/multitable/composables/useMultitableGrid.ts`
  - tracks `attachmentSummaries`
  - consumes them from `loadViewData()`
  - merges them from patch results

This makes attachment rendering consistent with the existing `linkSummaries` pattern.

### 3. Finish the functional UI slice instead of waiting for richer UX

- `apps/web/src/multitable/components/cells/MetaCellRenderer.vue`
  - renders attachment summaries as linked chips
- `apps/web/src/multitable/components/cells/MetaCellEditor.vue`
  - uses `uploadFn`
  - emits persisted attachment IDs instead of file names
- `apps/web/src/multitable/components/MetaGridTable.vue`
  - passes `attachmentSummaries` and `uploadFn` into cell renderer/editor
- `apps/web/src/multitable/components/MetaFormView.vue`
  - adds upload / remove / clear-all behavior
  - renders summaries with `MetaAttachmentList`
- `apps/web/src/multitable/components/MetaRecordDrawer.vue`
  - adds the same upload / remove / clear-all behavior
- `apps/web/src/multitable/components/MetaAttachmentList.vue`
  - lightweight attachment list with link/open and image preview
- `apps/web/src/multitable/utils/field-config.ts`
  - attachment field property helpers for `maxFiles` and accepted MIME types

This deliberately stops at the smallest functional slice:

- uploads work
- summaries display correctly
- remove/clear work
- persisted values are attachment IDs

It does not try to port the larger old-branch presentation layer wholesale.

### 4. Thread the upload/summaries through the workbench shell

- `apps/web/src/multitable/views/MultitableWorkbench.vue`
  - provides `uploadAttachmentFn` / `deleteAttachmentFn`
  - passes `attachmentSummaries` into grid/form/drawer
  - preserves deep-linked record attachment summaries from:
    - `submitForm()`
    - `getRecord()`
    - `loadFormContext()`

That keeps standalone form mode and deep-link record mode functional, not just in-page grid rows.

## Verification

### Typecheck

Ran:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec tsc --noEmit --pretty false
```

Result:

- Passed

### Focused frontend regression

Ran:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web exec vitest run \
  tests/utils/api.test.ts \
  tests/multitable-client.spec.ts \
  tests/multitable-attachment-editor.spec.ts \
  tests/multitable-form-view.spec.ts \
  tests/multitable-link-picker.spec.ts \
  tests/multitable-workbench.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  --reporter=dot
```

Result:

- `7 files / 39 tests passed`

New coverage in this round:

- `tests/utils/api.test.ts`
  - verifies `FormData` does not get forced `application/json`
- `tests/multitable-client.spec.ts`
  - verifies nested attachment payload unwrapping
- `tests/multitable-attachment-editor.spec.ts`
  - verifies cell editor upload emits persisted attachment IDs
- `tests/multitable-form-view.spec.ts`
  - verifies form upload renders attachment summary and submits attachment IDs

### Build

Ran:

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-multitable-next
pnpm --filter @metasheet/web build
```

Result:

- Passed
- only existing Vite large chunk warnings remained

## Notes

- This round did not change backend logic; no new backend verification was needed beyond the already-green targeted multitable backend suite from the previous runtime-contract round.
- Real `verify:smoke` is still blocked by the local smoke environment not being up; this slice is validated via focused frontend regression plus build.
