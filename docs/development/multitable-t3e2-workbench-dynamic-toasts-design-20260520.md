# T3E-2 Workbench Dynamic Toasts/Fallbacks i18n Design

Date: 2026-05-20
Branch: docs/multitable-t3e2-workbench-dynamic-toasts-design-20260520
Status: design/scout only; no implementation code changes yet

## 1. Decision Summary

T3E-2 localizes Workbench-owned dynamic toast/fallback/confirm chrome that remains after T2 and T3E-1.

| Decision | Outcome |
| --- | --- |
| Scope | `MultitableWorkbench.vue` script-level dynamic chrome: fallback errors, confirms, external-context notices, import/bulk-delete count messages |
| Label home | Extend existing `workbench-labels.ts`; do not create a new Workbench dynamic-label module |
| Raw boundary | Runtime/server/user data remains raw: `e.message`, `grid.error.value`, `commentsState.error.value`, `workbench.error.value`, import failure messages, record IDs, field names |
| Deferred | `MetaBulkEditDialog` result/error wiring and `ConditionalFormattingDialog` stay T3E-3; automation stays T3D |
| Implementation gate | Design MD review first; implementation + verification MD later; stop before push |

## 2. Files In Scope

Implementation files:

| File | Planned change |
| --- | --- |
| `apps/web/src/multitable/views/MultitableWorkbench.vue` | Replace Workbench-owned fallback strings with `workbenchLabel()` or interpolation helpers |
| `apps/web/src/multitable/utils/workbench-labels.ts` | Add static keys and dynamic helpers for T3E-2 |

Test/doc files:

| File | Planned change |
| --- | --- |
| `apps/web/tests/multitable-workbench-i18n.spec.ts` | Extend static key list and helper coverage |
| `apps/web/tests/multitable-workbench-view.spec.ts` | Run as regression; update only if existing English default assertions are touched |
| `docs/development/multitable-t3e2-workbench-dynamic-toasts-design-20260520.md` | This design plan |
| `docs/development/multitable-t3e2-workbench-dynamic-toasts-verification-20260520.md` | To be created during implementation |

## 3. Preflight Grep

Use quoted patterns to avoid shell glob expansion:

```bash
rg -n 'show(Success|Error)\(|window\.confirm\(|formSuccessMessage|bulkEditDialog\.resultMessage|Record not found|Import failed|record\\(s\\)|Failed to' \
  apps/web/src/multitable/views/MultitableWorkbench.vue
```

Current scout found the active Workbench-owned residual clusters around:

| Area | Lines |
| --- | --- |
| timeline / hierarchy / drawer / form / comments / links | `1375`, `1404`, `1493`, `1539`, `1548`, `1577`, `1618` |
| field/view/sheet/base/context | `1651`, `1659`, `1667`, `1693`, `1733`, `1741`, `1752`, `1789`, `1800`, `1803`, `1831`, `2017`, `2083`, `2085`, `2140`, `2147` |
| import/export | `2282`, `2288`, `2290`, `2292`, `2296`, `2299`, `2304`, `2307`, `2326`, `2405` |
| bulk delete / deep link / init | `2517`, `2518`, `2615`, `2993` |
| deferred bulk-edit result/error | `2566`, `2569`, `2571`, `2579` |

Implementation must rerun the grep before editing and account for every hit as one of:

1. localized in T3E-2,
2. raw pass-through by design,
3. deferred to T3E-3/T3D.

## 4. Exact Targets

### 4.1 Static Fallback Keys

Add static `WorkbenchLabelKey` entries for Workbench-owned fallback strings:

| Source | EN | zh-CN |
| --- | --- | --- |
| timeline patch fallback | `Failed to update timeline dates` | `更新时间线日期失败` |
| hierarchy reparent fallback | `Failed to update hierarchy parent` | `更新层级父记录失败` |
| form submit fallback | `Form submit failed` | `表单提交失败` |
| comment update fallback | `Failed to update comment` | `更新评论失败` |
| comment add fallback | `Failed to add comment` | `添加评论失败` |
| comment resolve fallback | `Failed to resolve comment` | `解决评论失败` |
| comment delete fallback | `Failed to delete comment` | `删除评论失败` |
| link picker fallback | `Failed to update linked records` | `更新关联记录失败` |
| field create fallback | `Failed to create field` | `创建字段失败` |
| field update fallback | `Failed to update field` | `更新字段失败` |
| field delete fallback | `Failed to delete field` | `删除字段失败` |
| view create fallback | `Failed to create view` | `创建视图失败` |
| view update fallback | `Failed to update view` | `更新视图失败` |
| view delete fallback | `Failed to delete view` | `删除视图失败` |
| sheet access refresh fallback | `Failed to refresh sheet access` | `刷新 Sheet 权限失败` |
| sheet create permission | `Sheet creation requires multitable write access.` | `创建 Sheet 需要多维表写入权限。` |
| sheet create sync fallback | `Created sheet but failed to refresh workbench context` | `Sheet 已创建，但刷新工作台上下文失败` |
| sheet create fallback | `Failed to create sheet` | `创建 Sheet 失败` |
| base load fallback | `Failed to load base` | `加载 Base 失败` |
| context sync fallback | `Failed to sync workbench context` | `同步工作台上下文失败` |
| external context busy notice | `Host multitable context change is waiting for the current save or import to finish.` | `宿主多维表上下文变更正在等待当前保存或导入完成。` |
| external context unsaved notice | `Host multitable context changed while unsaved drafts are open. Resolve or discard changes to continue.` | `宿主多维表上下文已变更。请处理或放弃未保存草稿后继续。` |
| base create permission | `Base creation requires multitable write access.` | `创建 Base 需要多维表写入权限。` |
| base create fallback | `Failed to create base` | `创建 Base 失败` |
| import cancelled | `Import cancelled` | `导入已取消` |
| import fallback | `Import failed` | `导入失败` |
| Excel export fallback | `Excel export failed` | `Excel 导出失败` |
| bulk delete fallback | `Bulk delete failed` | `批量删除失败` |
| workbench init fallback | `Failed to initialize workbench` | `初始化工作台失败` |

Naming suggestion:

```ts
| 'toast.timelineDatesUpdateFailed'
| 'toast.hierarchyParentUpdateFailed'
| 'toast.formSubmitFailed'
| 'toast.commentUpdateFailed'
| 'toast.commentAddFailed'
| 'toast.commentResolveFailed'
| 'toast.commentDeleteFailed'
| 'toast.linkedRecordsUpdateFailed'
| 'toast.fieldCreateFailed'
| 'toast.fieldUpdateFailed'
| 'toast.fieldDeleteFailed'
| 'toast.viewCreateFailed'
| 'toast.viewUpdateFailed'
| 'toast.viewDeleteFailed'
| 'toast.sheetAccessRefreshFailed'
| 'toast.sheetCreateBlocked'
| 'toast.sheetRefreshFailed'
| 'toast.sheetCreateFailed'
| 'toast.baseLoadFailed'
| 'toast.contextSyncFailed'
| 'toast.externalContextBusy'
| 'toast.externalContextUnsaved'
| 'toast.baseCreateBlocked'
| 'toast.baseCreateFailed'
| 'toast.importCancelled'
| 'toast.importFailed'
| 'toast.excelExportFailed'
| 'toast.bulkDeleteFailed'
| 'toast.workbenchInitFailed'
```

### 4.2 Confirm Keys

Native confirm dialogs are browser-rendered, but the text is Workbench chrome and should be localized.

| Source | EN | zh-CN |
| --- | --- | --- |
| `confirmDiscardContextChanges()` | `Discard unsaved changes before leaving the current sheet or view?` | `离开当前 Sheet 或视图前放弃未保存的更改吗？` |
| `confirmDiscardRecordChanges()` | `Discard unsaved record changes?` | `放弃未保存的记录更改吗？` |
| `confirmPageLeave()` busy branch | `Leave the multitable while the current save or import is still running?` | `当前保存或导入仍在进行，确定离开多维表吗？` |
| `confirmPageLeave()` dirty branch | `Discard unsaved multitable changes before leaving this page?` | `离开此页面前放弃未保存的多维表更改吗？` |

Naming suggestion:

```ts
| 'confirm.discardContextChanges'
| 'confirm.discardRecordChanges'
| 'confirm.pageLeaveBusy'
| 'confirm.pageLeaveDirty'
```

Comment draft confirm is already handled by `commentLabel('comment.discardDraftConfirm', isZh.value)` and is out of scope.

### 4.3 Dynamic Helpers

Add interpolation helpers in `workbench-labels.ts`. These are not `WorkbenchLabelKey` entries.

| Helper | EN behavior | zh-CN behavior | Raw boundary |
| --- | --- | --- | --- |
| `formSubmitSuccess(mode: 'create' \| 'update', isZh: boolean)` | `Record created` / `Changes saved` | `记录已创建` / `更改已保存` | mode is Workbench submit result enum |
| `recordsImported(count, isZh)` | pluralized `${n} record(s) imported` | `${n} 条记录已导入` | count only |
| `recordsFailedToImport(count, rowNumbers, firstError, isZh)` | `${n} record(s) failed to import (row 2, row 3). ${firstError}` | `${n} 条记录导入失败（第 2 行，第 3 行）。${firstError}` | `firstError` raw |
| `duplicateRowsSkipped(count, isZh)` | pluralized `${n} duplicate row(s) were skipped` | `${n} 条重复行已跳过` | count only |
| `recordsDeleted(count, isZh)` | pluralized `${n} record(s) deleted` | `${n} 条记录已删除` | count only |
| `recordNotFound(recordId, isZh)` | `Record not found: ${recordId}` | `未找到记录：${recordId}` | `recordId` raw |

Implementation detail for import failures:

```ts
const failedRowNumbers = actualFailures.slice(0, 3).map((failure) => failure.rowIndex + 2)
showError(recordsFailedToImport(result.failed, failedRowNumbers, result.firstError ?? '', isZh.value))
```

The row numbers are UI-generated and safe to format. The error text remains raw.

### 4.4 T2 Static Key Disposition

T3E-2 must not leave dead static keys behind.

| Existing key | Current call-site | T3E-2 disposition |
| --- | --- | --- |
| `toast.formSubmitted` | `onFormSubmit()` after `formSuccessMessage.value = result.mode === 'create' ? 'Record created' : 'Changes saved'` | Retire from `WorkbenchLabelKey` and `WORKBENCH_LABELS`; replace the toast with `formSubmitSuccess(result.mode, isZh.value)` so the toast and `formSuccessMessage` share the same mode-specific copy |
| `toast.recordDeleted` | `onDeleteRecord()` single-record delete only | Keep. `recordsDeleted(count, isZh)` is for bulk delete only; the single-record delete toast remains semantically distinct |

Implementation must update `ALL_KEYS` in `multitable-workbench-i18n.spec.ts` in lockstep. If a static key is retired, remove it from both the union and the exhaustive test list.

## 5. Raw / Do-Not-Translate Boundary

These values must remain raw and should not get labels/helpers in T3E-2:

| Value | Reason |
| --- | --- |
| `e.message` / `error?.message` / `err?.message` | Runtime/server detail; localized fallback only behind `??` |
| `grid.error.value` | Composable/runtime error value; pass through |
| `commentsState.error.value` | Comment service/runtime error value; pass through |
| `workbench.error.value` | Workbench composable runtime error; pass through |
| `result.firstError` | Import row failure text; pass through |
| `actualFailures[].message` / `failure.reason` | Row-specific/import/bulk failure detail; pass through |
| `recordId` in deep-link fallback | Identifier; interpolate raw |
| field names / view names / base names / tokens | User/data content; pass through |
| thrown link import errors at `1152` / `1174` | Data-specific validation that flows into import failure details; pass through as raw error message |

## 6. Deferred From T3E-2

| Deferred | Reason |
| --- | --- |
| `bulkEditDialog.error` and `bulkEditDialog.resultMessage` (`2566`, `2569`, `2571`, `2579`) | Parent-generated messages are tied to `MetaBulkEditDialog`; keep with T3E-3 |
| `MetaBulkEditDialog.vue` chrome | T3E-3 scope |
| `ConditionalFormattingDialog.vue` chrome and confirm | T3E-3 scope |
| `MetaAutomationManager` / rule editor / log viewer | T3D scope; enum semantics heavier |
| Final global grep/audit | After T3D/T3E residual slices complete |

Bulk delete (`onBulkDelete`) is included in T3E-2 because it is a Workbench toast only and does not depend on `MetaBulkEditDialog`.

## 7. A11y Boundary

T3E-2 modifies script-level `showSuccess(...)`, `showError(...)`, and `window.confirm(...)` calls only.

No component template changes are planned, and no new `aria`, `title`, or `placeholder` attributes should be added. Native `window.confirm` dialogs remain browser-rendered; this slice localizes their text but does not attempt to add custom accessibility instrumentation.

## 8. Implementation Order

1. Rerun preflight grep and classify each hit into localized/raw/deferred.
2. Extend `WorkbenchLabelKey` and `WORKBENCH_LABELS` with the static fallback/confirm keys.
3. Add dynamic helpers: `formSubmitSuccess`, `recordsImported`, `recordsFailedToImport`, `duplicateRowsSkipped`, `recordsDeleted`, `recordNotFound`.
4. Wire `MultitableWorkbench.vue` fallbacks and confirm calls.
5. Leave all raw pass-through branches untouched except the localized fallback behind `??`.
6. Do not touch `bulkEditDialog` result/error or dialog components.
7. Extend `multitable-workbench-i18n.spec.ts`.
8. Add 1-2 Workbench render sentinel specs if existing mocks can reach the path without heavy harness churn.
9. Run targeted specs and regression spec.
10. Create verification MD and stop before push.

## 9. Test Plan

Primary tests:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-workbench-i18n.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  --watch=false
```

Type/build gates:

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

Diff hygiene:

```bash
git diff --check origin/main..HEAD
```

Expected assertions:

| Spec | Required coverage |
| --- | --- |
| `multitable-workbench-i18n.spec.ts` | All new static keys resolve to non-empty EN/ZH and differ |
| `multitable-workbench-i18n.spec.ts` | Helpers cover EN singular/plural and zh count forms |
| `multitable-workbench-i18n.spec.ts` | Raw values are preserved: `recordId`, `firstError`, template-style data not normalized |
| `multitable-workbench-view.spec.ts` | Existing Workbench behavior still passes; if an English string assertion exists, EN branch should keep it stable |

Sentinel render coverage target:

| Case | Purpose |
| --- | --- |
| zh-CN import failure fallback, if reachable with existing Workbench mocks | Proves at least one high-frequency dynamic fallback wire renders localized text through the real Workbench toast path |
| zh-CN bulk delete count or deep-link record-not-found, if import path is too heavy | Alternative low-churn sentinel for helper wiring; do not add data attributes to production code solely for this test |

If both sentinels require disproportionate harness churn, implementation may keep coverage helper-only, but verification MD must explicitly document that decision and list manual grep evidence for each Workbench wire.

## 10. Risk Register

| Risk | Mitigation |
| --- | --- |
| T3E-2 expands into bulk-edit/dialog scope | Hard defer `bulkEditDialog` result/error and all dialog chrome to T3E-3 |
| Accidentally translating backend/runtime errors | Only localize fallback branches after `??`; keep raw message variables first |
| Import failure helper hides row-specific details | Preserve `firstError` raw and only localize surrounding count/row chrome |
| Existing Workbench view tests assert English strings | EN branch stays byte-compatible where tests already assert English; run `multitable-workbench-view.spec.ts` |
| `workbench-labels.ts` grows large | Accept for this slice: all strings are Workbench shell chrome and existing module already owns T2/T3E-1 Workbench labels |

## 11. Approval Gate

Implementation can start when:

1. T3E-2 scope remains Workbench script-level dynamic chrome only.
2. `bulkEditDialog` result/error remains deferred to T3E-3.
3. No backend, contract, migration, attendance, K3, or manager dialog files are touched.
4. Raw pass-through boundaries in §5 are preserved.
5. Verification MD is produced and implementation stops before push.
