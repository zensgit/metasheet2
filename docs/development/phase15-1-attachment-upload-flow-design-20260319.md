# Phase 15.1 — Attachment Upload Real Flow: Design & Verification

**Date**: 2026-03-19
**Branch**: `codex/multitable-fields-views-linkage-automation-20260312`
**Scope**: Frontend only — 5 component files + 1 test file

---

## 1. Problem Statement

Phase 15 added the attachment field type with UI scaffolding, but the upload flow was **broken end-to-end**:

```
BEFORE (broken):
  file selected → f.name string stored → filename sent as "attachment ID" → backend rejects

AFTER (fixed):
  file selected → uploadAttachment() called → real attachment ID returned → ID stored → ID sent via patchCell/submitForm
```

The backend contract (`POST /api/multitable/attachments`) and the API client method (`client.uploadAttachment()`) already existed — the problem was that **nothing connected them** to the UI components.

---

## 2. Architecture: `uploadFn` Prop Pattern

We pass an upload function down from `MultitableWorkbench` via props (same pattern as `linkSummaries`, `canEdit`, etc.):

```
MultitableWorkbench (creates uploadFn from workbench.client.uploadAttachment)
  ├── MetaGridTable (accepts uploadFn prop, forwards to MetaCellEditor)
  │     └── MetaCellEditor (calls uploadFn, emits attachment IDs)
  ├── MetaFormView (calls uploadFn in onFormFileSelect, stores IDs in formData)
  └── MetaRecordDrawer (calls uploadFn, emits patch with ID array)
```

### Why prop-drilling over provide/inject?

- Follows existing codebase patterns (consistency)
- Only 2 levels deep in the worst case
- Explicit data flow — easier to trace and test
- Graceful degradation: if no `uploadFn`, falls back to filename-only behavior

---

## 3. Files Modified

### 3.1 `MetaCellEditor.vue` — Upload on file select/drop

**Changes**:
- Added `uploadFn?: (file: File) => Promise<MetaAttachment>` prop
- Added `uploading` ref for loading state
- New `uploadFiles(files)` async helper:
  - If `uploadFn` provided: upload each file sequentially → collect IDs → merge with existing → emit
  - If no `uploadFn`: fallback to old filename behavior
  - Error handling: silently catches failures, leaves cell unchanged
- `onFileSelect` / `onFileDrop` now delegate to `uploadFiles`
- Template: file input disabled during upload, "Uploading..." text shown

### 3.2 `MetaGridTable.vue` — Prop passthrough

**Changes**:
- Added `uploadFn` to props interface
- Pass `:upload-fn="props.uploadFn"` to both `MetaCellEditor` instances (grouped rows + flat rows)

### 3.3 `MetaFormView.vue` — Upload in form context

**Changes**:
- Added `uploadFn` prop
- Added `uploadingFields` ref (`Set<string>`) for per-field loading state
- `onFormFileSelect` made async:
  - If `uploadFn`: upload files → store IDs in `formData[fieldId]`
  - Fallback: store filenames
- Template: file input disabled during upload, "Uploading..." shown per field
- Submit button disabled while any field is uploading

### 3.4 `MetaRecordDrawer.vue` — Editable attachment section

**Changes**:
- Added `uploadFn` prop
- Added `uploadingFieldId` ref for loading state
- Attachment section now shows:
  - Existing chips with remove (×) button when `canEdit`
  - File input + "Add file" below chips
  - "Uploading..." indicator during upload
- New `onDrawerFileSelect`: upload → emit `patch` with merged ID array
- New `onRemoveAttachment`: emit `patch` with filtered ID array

### 3.5 `MultitableWorkbench.vue` — Upload function creation

**Changes**:
- Created `uploadAttachmentFn` wrapper:
  ```ts
  async function uploadAttachmentFn(file: File): Promise<MetaAttachment> {
    return workbench.client.uploadAttachment(file, {
      sheetId: workbench.activeSheetId.value || undefined,
    })
  }
  ```
- Passed `:upload-fn="uploadAttachmentFn"` to `MetaGridTable`, `MetaFormView`, `MetaRecordDrawer`

### 3.6 `multitable-phase15.spec.ts` — 18 new tests

| Suite | Count | Coverage |
|-------|-------|----------|
| upload flow — MetaCellEditor | 4 | calls uploadFn, emits IDs not filenames, preserves existing, handles error |
| upload flow — MetaFormView | 4 | stores IDs in formData, tracks uploading state, preserves existing, handles error |
| upload flow — MetaRecordDrawer | 3 | upload emits patch with IDs, remove emits filtered array, tracks uploading state |
| upload-then-patch integration | 4 | patchCell sends IDs, FormData correctness, delete URL, multi-file sequential |
| attachment hydration | 3 | summaries update, renderer uses summaries over IDs, empty renders dash |

---

## 4. Data Flow Trace

### Grid Cell Edit Flow
```
1. User double-clicks attachment cell → startEdit()
2. MetaCellEditor renders with file input
3. User selects file(s) → onFileSelect()
4. uploadFiles() called:
   a. uploading = true, input disabled
   b. For each file: await uploadFn(file) → MetaAttachment { id, filename, ... }
   c. Collect all IDs
   d. Merge with existing modelValue IDs
   e. emit('update:modelValue', mergedIds)
   f. emit('confirm')
5. MetaGridTable.confirmEdit() → emit('patch-cell', recordId, fieldId, mergedIds, version)
6. MultitableWorkbench.onPatchCell() → grid.patchCell() → API call with real IDs
```

### Form Submit Flow
```
1. User selects file in form attachment field
2. onFormFileSelect() called:
   a. uploadingFields.add(fieldId), submit button disabled
   b. For each file: await uploadFn(file) → collect IDs
   c. formData[fieldId] = [...existingIds, ...newIds]
   d. uploadingFields.delete(fieldId)
3. User clicks Submit → onSubmit()
4. emit('submit', formData) — formData now contains real attachment IDs
5. MultitableWorkbench.onFormSubmit() → client.submitForm() with real IDs
```

### Drawer Patch Flow
```
1. User selects file in drawer attachment field
2. onDrawerFileSelect() called:
   a. uploadingFieldId = fieldId
   b. await uploadFn(file) → collect IDs
   c. emit('patch', fieldId, [...existingIds, ...newIds])
   d. uploadingFieldId = null
3. MultitableWorkbench.onDrawerPatch() → grid.patchCell() with real IDs
```

---

## 5. Error Handling

| Scenario | Behavior |
|----------|----------|
| Upload network error | `catch` silently → cell/form unchanged, uploading state cleared |
| No `uploadFn` prop | Graceful fallback to filename-only behavior |
| Partial upload failure (2 of 3 files) | IDs collected up to failure point are discarded; no partial emit |
| Upload during form submit | Submit button disabled while `uploadingFields.size > 0` |

---

## 6. Verification Results

### Test Results
```
✓ apps/web/tests/multitable-phase15.spec.ts  (48 tests) — ALL PASS
  - 30 existing tests: no regressions
  - 18 new upload flow tests: all pass

✓ apps/web/tests/multitable-*.spec.ts  (288 tests) — ALL PASS
  - No regressions across entire multitable test suite
```

### Manual Verification Checklist

- [ ] Grid: double-click attachment cell → select file → verify `uploadAttachment` API call in Network tab
- [ ] Grid: verify cell value contains attachment ID (e.g., `att_xxx`) not filename
- [ ] Grid: drag & drop file onto attachment cell → same upload flow
- [ ] Form: select file in attachment field → verify "Uploading..." appears
- [ ] Form: verify submit button disabled during upload
- [ ] Form: verify formData contains IDs after upload completes
- [ ] Drawer: click file input → verify upload → verify patch emitted with IDs
- [ ] Drawer: click × on attachment chip → verify attachment removed from array
- [ ] Error: disconnect network → select file → verify graceful failure (no crash, cell unchanged)
- [ ] Multi-file: select 3 files at once → verify all 3 uploaded sequentially → all 3 IDs stored

---

## 7. Backward Compatibility

- Components without `uploadFn` prop continue to work (filename fallback)
- No changes to backend routes or OpenAPI spec
- No changes to `MetaAttachment` type or API client
- Existing tests unaffected
