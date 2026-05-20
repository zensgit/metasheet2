# T3B1 — Record Drawer + Form View i18n Design

- **Date**: 2026-05-20
- **Type**: implementation-ready design packet
- **Status**: design only; no code is authorized by this document alone
- **Preceded by**:
  - `docs/development/multitable-t3a-core-table-i18n-development-20260519.md`
  - `docs/development/multitable-t3a2-cell-editor-i18n-verification-20260519.md`
- **Goal**: localize the record-detail and form-edit chrome that users hit after T3A1/T3A2, without changing APIs, storage, K3 paths, backend behavior, or user-authored data.

---

## 1. Decision Summary

| Scout Finding | Decision |
|---|---|
| F-T3B-A module organization | Use per-surface modules. T3B1 creates `meta-record-labels.ts` for Record Drawer + Form View. T3B2 creates comment labels. T3B3 creates link-picker labels. Do not keep growing `meta-core-labels.ts` for record/comment/link chrome. |
| F-T3B-B attachment code duplication | Refactor Record Drawer + Form View to reuse the T3A2 attachment label helpers, with one small optional `Add files` variant. Do not duplicate the ternary chains again. |
| F-T3B-C `utils/link-fields.ts` English helpers | T3B1 changes only `linkActionLabel(field, count, isZh = false)`. `linkPickerTitle` and `linkPickerSearchPlaceholder` stay for T3B3. Existing callers keep English by default unless they pass `isZh`. |
| F-T3B-D native `confirm()` | Use `confirm(recordLabel('form.discardConfirm', isZh.value))`. Do not build a custom modal in T3B1. |
| F-T3B-E slice size | Split T3B into three PRs: T3B1 record/form, T3B2 comments, T3B3 link picker. T3B1 is first. |

This keeps T3B1 reviewable while still removing the real code smell discovered in the scout: Record Drawer and Form View currently duplicate attachment hint/activity/fallback logic that T3A2 already made testable.

Scout result: the T3B1 scope has no known unreachable/dead keys after excluding T3B2 comments and T3B3 link picker. This is intentionally stricter than T3A2, where the unreachable `Choose linked records...` fallback was documented and skipped.

---

## 2. Files In Scope

| File | Role |
|---|---|
| `apps/web/src/multitable/components/MetaRecordDrawer.vue` | Record detail drawer, tabs, watch/comment/action buttons, field editors, attachment controls, history states. |
| `apps/web/src/multitable/components/MetaFormView.vue` | Form edit surface, field editors, attachment controls, reset/discard confirm. |
| `apps/web/src/multitable/utils/meta-record-labels.ts` | New T3B1 label module for record/form chrome. |
| `apps/web/src/multitable/utils/meta-core-labels.ts` | Extend T3A2 attachment helper with optional `addFiles` multi-file variant; keep existing default behavior for MetaCellEditor. |
| `apps/web/src/multitable/utils/link-fields.ts` | Add optional `isZh = false` to `linkActionLabel` only. |
| `apps/web/tests/meta-record-drawer-i18n.spec.ts` | New focused render tests for Record Drawer. |
| `apps/web/tests/meta-form-view-i18n.spec.ts` | New focused render tests for Form View. |
| `apps/web/tests/multitable-core-i18n.spec.ts` and `apps/web/tests/link-fields-i18n.spec.ts` | Helper coverage for `Add files` variant and `linkActionLabel(..., isZh)`. |
| `docs/development/multitable-t3b1-record-form-i18n-verification-20260520.md` | Verification packet after implementation. |

Out of scope for T3B1:

- `MetaCommentsDrawer.vue`, `MetaCommentComposer.vue`, `MetaCommentAffordance.vue`, `MetaCommentActionChip.vue` -> T3B2.
- `MetaLinkPicker.vue`, `linkPickerTitle`, `linkPickerSearchPlaceholder` -> T3B3.
- `MetaImportModal.vue` -> later import-modal slice. It calls `linkActionLabel`, but default `isZh = false` keeps current English behavior.
- `MetaCellEditor.vue` link fallback -> remains as T3A2 recorded unless T3B3 intentionally changes link-picker/link-label behavior.
- Backend free-form errors, validation messages, field names, option values, record values, user names, attachment filenames, IDs.

---

## 3. Label Module Plan

Create:

```text
apps/web/src/multitable/utils/meta-record-labels.ts
```

Pattern follows `workbench-labels.ts` and `meta-core-labels.ts`:

```ts
export type MetaRecordLabelKey =
  | 'record.title'
  | 'record.previous'
  | 'record.next'
  | 'record.watch'
  | 'record.watching'
  | 'record.watchTitle'
  | 'record.unwatchTitle'
  | 'record.comments'
  | 'record.workflow'
  | 'record.workflowTitle'
  | 'record.permissions'
  | 'record.permissionsTitle'
  | 'record.delete'
  | 'record.close'
  | 'record.tabsAria'
  | 'record.details'
  | 'record.history'
  | 'record.historyLoading'
  | 'record.historyUnavailable'
  | 'record.historyEmpty'
  | 'record.historyActionCreated'
  | 'record.historyActionDeleted'
  | 'record.historyActionUpdated'
  | 'record.errorHistoryLoad'
  | 'record.errorWatchLoad'
  | 'record.errorWatchUpdate'
  | 'record.noRecord'
  | 'form.loading'
  | 'form.readOnly'
  | 'form.discardConfirm'
  | 'form.save'
  | 'form.saving'
  | 'form.create'
  | 'form.reset'
```

Use helpers for dynamic strings:

| Helper | EN | ZH | Data Handling |
|---|---|---|---|
| `commentOnField(fieldName, isZh)` | `Comment on Status` | `评论 Status` | `fieldName` remains raw. |
| `historyActor(actorId, isZh)` | `by user_1` | `由 user_1` | `actorId` remains raw. |
| `requiredField(fieldName, isZh)` | `${fieldName} is required` | `${fieldName} 为必填项` | `fieldName` remains raw. |

Record/form share one module because they are both record-detail/form-edit surfaces and share many field-editor strings. Comments and link picker get separate modules in later slices.

`Comments for {field}` already exists as `commentForField(fieldName, isZh)` in `meta-core-labels.ts` for `MetaGridTable`. T3B1 must reuse that helper in `MetaFormView` instead of introducing a second field-comment helper.

---

## 4. Exact T3B1 Chrome Targets

### 4.1 `MetaRecordDrawer.vue`

| Current EN | Proposed ZH | Notes |
|---|---|---|
| Record Detail | 记录详情 | Static title. |
| Previous record | 上一条记录 | aria-label only. |
| Next record | 下一条记录 | aria-label only. |
| Watch this record | 关注此记录 | title. |
| Unwatch this record | 取消关注此记录 | title. |
| Watch | 关注 | button text. |
| Watching | 已关注 | button text. |
| Comments | 评论 | title and chip label pass-through. |
| Open workflow designer | 打开工作流设计器 | title. |
| Workflow | 工作流 | visible button suffix. |
| Record Permissions | 记录权限 | title. |
| Permissions | 权限 | visible button suffix. |
| Delete | 删除 | button. |
| Close record drawer | 关闭记录抽屉 | aria-label. |
| Record drawer sections | 记录抽屉分区 | tablist aria-label. |
| Details | 详情 | tab. |
| History | 历史 | tab. |
| Comment on {field} | 评论 {field} | `field` raw. |
| Scan or enter barcode | 扫描或输入条码 | Reuse T3A2 key. |
| Enter address | 输入地址 | Reuse T3A2 key. |
| Add files | 添加文件 | New attachment variant. |
| Clear all | 全部清除 | Reuse T3A2 `cell.clearAll`. |
| Removing... / Clearing... / Uploading... | 正在移除... / 正在清空... / 正在上传... | Reuse T3A2 helper. |
| Failed to upload/remove/clear attachment(s) | 附件上传/移除/清空失败 | Reuse T3A2 fallback keys. Backend `error.message` remains raw. |
| Loading history... | 正在加载历史... | Static. |
| History unavailable for this record. | 此记录的历史不可用。 | Static. |
| No history yet. | 暂无历史。 | Static. |
| Created | 已创建 | `record.historyActionCreated`; `historyActionLabel()` is frontend-owned stable chrome. |
| Deleted | 已删除 | `record.historyActionDeleted`; `historyActionLabel()` is frontend-owned stable chrome. |
| Updated | 已更新 | `record.historyActionUpdated`; `historyActionLabel()` is frontend-owned stable chrome. |
| by {actorId} | 由 {actorId} | `actorId` raw. |
| Failed to load history | 加载历史失败 | Frontend fallback in `error?.message ?? ...`. |
| Failed to load watch status | 加载关注状态失败 | Frontend fallback in `error?.message ?? ...`. |
| Failed to update watch status | 更新关注状态失败 | Frontend fallback in `error?.message ?? ...`. |
| No record selected | 未选择记录 | Static empty state. |

Do not translate:

- Field names and option values.
- Backend `error.message` values remain raw when present. Static frontend fallback strings are localized using the same pattern as T3A2 (`error?.message ?? l('cell.uploadFailed')`): the state variables `historyError` and `subscriptionError` need no special handling beyond changing their catch-block fallback expression to `?? recordLabel(...)`.

### 4.2 `MetaFormView.vue`

| Current EN | Proposed ZH | Notes |
|---|---|---|
| Loading... | 正在加载... | Static loading state. |
| This form is read-only | 此表单为只读 | Static banner. |
| Comments for {field} | {field} 的评论 | `field` raw. |
| Scan or enter barcode | 扫描或输入条码 | Reuse T3A2 key. |
| Enter address | 输入地址 | Reuse T3A2 key. |
| Yes / No | 是 / 否 | Reuse T3A2 keys. |
| Add files | 添加文件 | New attachment variant. |
| Upload a new file to replace the current one | 上传新文件以替换当前文件 | Reuse T3A2 helper. |
| Upload a file | 上传文件 | Reuse T3A2 helper. |
| Clear all | 全部清除 | Reuse T3A2 key. |
| Removing... / Clearing... / Uploading... | 正在移除... / 正在清空... / 正在上传... | Reuse T3A2 helper. |
| Failed to upload/remove/clear attachment(s) | 附件上传/移除/清空失败 | Reuse T3A2 fallback keys. |
| Saving... | 正在保存... | Submit button while `submitting`. |
| Save | 保存 | Submit button when editing an existing record. |
| Create | 创建 | Submit button when creating a record. |
| Reset | 重置 | Existing-record reset button. |
| Discard unsaved changes? | 放弃未保存的更改吗？ | Native `confirm()` text only. |
| `{field.name} is required` | `{field.name} 为必填项` | `field.name` raw. |

Do not translate:

- `successMessage`, `errorMessage`, `fieldErrors`, backend validation messages.
- URL/email/phone examples.
- Field names, option values, record values, attachment filenames.

---

## 5. Attachment Helper Refactor

Current T3A2 helper:

```ts
attachmentActionHint(allowsMultiple, hasExisting, isZh)
```

T3B1 should extend it with a backwards-compatible optional fourth argument:

```ts
type AttachmentActionMode = 'drop' | 'add'

attachmentActionHint(
  allowsMultiple: boolean,
  hasExisting: boolean,
  isZh: boolean,
  mode: AttachmentActionMode = 'drop',
)
```

Expected behavior:

| Case | `mode='drop'` | `mode='add'` |
|---|---|---|
| multiple allowed | Drop files or click to browse / 拖拽文件或点击选择 | Add files / 添加文件 |
| single + existing | Upload a new file to replace the current one / 上传新文件以替换当前文件 | same |
| single + empty | Upload a file / 上传文件 | same |

Why optional mode instead of a new helper:

- Keeps T3A2 `MetaCellEditor` behavior unchanged by default.
- Lets Record Drawer and Form View remove duplicate ternaries.
- Unit tests can prove both modes.

Keep fallback error keys in `meta-core-labels.ts` for now:

- `cell.uploadFailed`
- `cell.removeFailed`
- `cell.clearFailed`
- `cell.clearAll`

This is the one intentional cross-surface reuse. A future cleanup can move shared attachment labels into `meta-attachment-labels.ts`, but T3B1 should not spend review budget on a module move.

---

## 6. Link Helper Scope

Change only:

```ts
linkActionLabel(field, count, isZh = false)
```

T3B1 call sites:

- `MetaRecordDrawer.vue` passes `isZh.value`.
- `MetaFormView.vue` passes `isZh.value`.

Call sites intentionally unchanged:

- `MetaCellEditor.vue` continues default English until link-picker/link-label work is revisited.
- `MetaImportModal.vue` continues default English; import modal is not a T3B1 target.

Current call-site audit:

```text
apps/web/src/multitable/components/MetaFormView.vue: linkActionLabel(field, count)
apps/web/src/multitable/components/MetaRecordDrawer.vue: linkActionLabel(field, count)
apps/web/src/multitable/components/MetaImportModal.vue: linkActionLabel(field, selectedSummaries.length)
apps/web/src/multitable/components/cells/MetaCellEditor.vue: linkActionLabel as formatLinkActionLabel
```

Only the first two pass `isZh.value` in T3B1. The other two rely on `isZh = false`.

T3B1 zh decisions:

| Case | EN | ZH |
|---|---|---|
| person count 0 | Choose people... | 选择人员... |
| person count 1 | Edit person (1) | 编辑人员 (1) |
| person count N | Edit people (N) | 编辑人员 (N) |
| record count 0 | Choose linked records... | 选择关联记录... |
| record count 1 | Edit linked record (1) | 编辑关联记录 (1) |
| record count N | Edit linked records (N) | 编辑关联记录 (N) |

Do not change in T3B1:

- `linkPickerTitle`
- `linkPickerSearchPlaceholder`
- `MetaLinkPicker.vue`

Those belong to T3B3 because the picker has its own selected/clear/loading/empty/count/footer strings and should be reviewed as one surface.

---

## 7. Test Plan

### 7.1 Helper Tests

Add/extend:

```text
apps/web/tests/multitable-core-i18n.spec.ts
apps/web/tests/link-fields-i18n.spec.ts
```

Assertions:

- Existing T3A1/T3A2 helper tests remain green.
- `attachmentActionHint(..., mode='drop')` remains exactly T3A2 behavior.
- `attachmentActionHint(..., mode='add')` returns `Add files` / `添加文件` for multi-file.
- `linkActionLabel(field, count)` without `isZh` is identical to current English.
- `linkActionLabel(field, count, true)` returns all six zh cases above.
- `commentForField(fieldName, isZh)` is reused from `meta-core-labels.ts` for `MetaFormView` aria text.
- Record history action labels cover `Created` / `Deleted` / `Updated`.

### 7.2 Record Drawer Render Tests

Create:

```text
apps/web/tests/meta-record-drawer-i18n.spec.ts
```

Mount strategy:

- Focused component mount using Vue `createApp`, matching T3A2 style.
- Mount/teardown pattern: use `apps/web/tests/meta-cell-editor-i18n.spec.ts` as the canonical `createApp` + `container` + `app?.unmount()` + `container?.remove()` + locale-reset shape.
- Set `useLocale().setLocale('zh-CN')` and `en`.
- Provide minimum record, fields, permissions/capabilities needed to show:
  - header title/actions
  - details/history tabs
  - barcode/location placeholders
  - attachment controls
  - link button label
  - comment aria label

Required assertions:

- zh contains `记录详情`, `关注`, `详情`, `历史`, `扫描或输入条码`, `输入地址`, `添加文件`, `全部清除`.
- zh contains history action labels `已创建`, `已删除`, `已更新` when corresponding revision actions are rendered.
- zh does not contain the replaced English strings in the same mounted path.
- en still contains current English defaults.
- Field names and option values stay raw.
- Backend/free-form error prop text stays raw when injected.

### 7.3 Form View Render Tests

Create:

```text
apps/web/tests/meta-form-view-i18n.spec.ts
```

Mount strategy:

- Focused component mount using Vue `createApp`, matching T3A2 style.
- Mount/teardown pattern: use `apps/web/tests/meta-cell-editor-i18n.spec.ts` as the canonical `createApp` + `container` + `app?.unmount()` + `container?.remove()` + locale-reset shape.
- Set `useLocale().setLocale('zh-CN')` and `en`.

Required assertions:

- zh contains `此表单为只读`, `是`, `否`, `扫描或输入条码`, `输入地址`, `添加文件`.
- zh contains submit/reset labels `正在保存...`, `保存`, `创建`, `重置` in the appropriate render states.
- `confirm()` uses zh text when `setLocale('zh-CN')`.
- required-field validation uses `{field.name} 为必填项`, preserving raw field name.
- URL/email/phone placeholders remain raw examples.
- en still contains current English defaults.

### 7.4 Verification Commands

Run after implementation:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-core-i18n.spec.ts \
  tests/link-fields-i18n.spec.ts \
  tests/meta-record-drawer-i18n.spec.ts \
  tests/meta-form-view-i18n.spec.ts \
  tests/meta-cell-editor-i18n.spec.ts \
  tests/meta-toolbar-filter-builder.spec.ts \
  tests/meta-grid-table-i18n.spec.ts \
  --watch=false

pnpm --filter @metasheet/web exec vue-tsc --noEmit
git diff --check origin/main..HEAD
```

Path note: commands run through `--filter @metasheet/web exec`, so test paths are package-relative (`tests/...`), not repo-relative (`apps/web/tests/...`).

---

## 8. Implementation Order

1. Preflight grep: for each planned key in §3, verify a real call-site exists in `MetaRecordDrawer.vue` / `MetaFormView.vue` (no dead keys). Resolve any miss before writing the module.
2. Add `meta-record-labels.ts` with typed static labels and helpers.
3. Extend `attachmentActionHint` with optional `mode='drop' | 'add'`; add helper tests first.
4. Add optional `isZh = false` to `linkActionLabel`; add helper tests first.
5. Wire `MetaRecordDrawer.vue`.
6. Wire `MetaFormView.vue`.
7. Add focused render tests.
8. Write verification MD.
9. Rebase to latest `origin/main`, rerun focused tests + `vue-tsc` + diff-check.
10. Push/PR only after explicit operator go, consistent with T3A1/T3A2 discipline.

---

## 9. Risk Register

| Risk | Mitigation |
|---|---|
| Accidentally translating user data | Tests must assert field names, option values, record values, filenames, URL/email/phone examples remain raw. |
| `linkActionLabel` changes `MetaImportModal` behavior | Keep `isZh = false` default and only pass `true` from T3B1 components. |
| Attachment helper change breaks MetaCellEditor | Default `mode='drop'` preserves T3A2 behavior; T3A2 tests included in T3B1 focused run. |
| Record/Form mount tests become too heavy | Keep focused render tests with minimal props. Do not use full Workbench mount for T3B1. |
| Native confirm is not style-localized | Accepted by decision F-T3B-D; only the text is localized in T3B1. |
| T3B1 creeps into comments/link picker | Hard out-of-scope. Comments = T3B2. Link picker title/search/selected/footer = T3B3. |

---

## 10. Approval Gate

T3B1 implementation can start when the operator accepts:

- New `meta-record-labels.ts` module.
- Optional-mode extension of T3A2 `attachmentActionHint`.
- Optional `isZh = false` extension of `linkActionLabel`.
- Native `confirm(recordLabel('form.discardConfirm', isZh.value))`.
- T3B split: T3B1 first, T3B2 comments second, T3B3 link picker third.

Until then this MD is read-only planning and must not be treated as implementation authorization.
