# T3A Core Table Chrome i18n Development Plan

- **Date**: 2026-05-19
- **Type**: development plan / implementation-ready design
- **Status**: Read-only design packet. Implementation requires explicit operator approval.
- **Preceded by**:
  - `docs/development/multitable-t3-meta-i18n-scout-20260519.md`
  - `docs/development/multitable-workbench-i18n-t2-development-20260519.md`
  - `docs/development/multitable-workbench-i18n-t2-verification-20260519.md`
- **Goal**: localize the highest-frequency multitable table surface to zh-CN without changing table behavior, API contracts, schema, migrations, K3 paths, or plugin integration code.

---

## 1. Executive Summary

T3A should localize the core table chrome only:

- `MetaToolbar.vue`: fields, sort, filter, group, search, row count, density, print/import/export, new-record controls.
- `MetaGridTable.vue`: grid aria label, bulk action bar, empty states, group no-value label, comment aria labels, pagination, loading label.
- `MetaCellEditor.vue`: only shallow static edit affordances that are visible inside grid cells.
- New typed label module: `apps/web/src/multitable/utils/meta-core-labels.ts`.
- Tests: label helper unit spec plus focused toolbar/grid/cell render assertions in zh-CN and en.

Do not translate user data: field names, option values, view names, record values, group values, user names, ids, URLs, emails, or backend-provided free-form error messages.

This is intentionally smaller than "T3 all". The goal is to make the everyday table path feel Chinese after H-series and T2, while leaving manager panels, record drawer, comments, import, automation, and dynamic Workbench toasts to later T3 slices.

---

## 2. Code Scout Evidence

### 2.1 Files Read

Current implementation was inspected directly:

```text
apps/web/src/multitable/components/MetaToolbar.vue
apps/web/src/multitable/components/MetaGridTable.vue
apps/web/src/multitable/components/cells/MetaCellEditor.vue
apps/web/src/multitable/components/MetaFieldHeader.vue
apps/web/src/multitable/utils/workbench-labels.ts
apps/web/tests/meta-toolbar-filter-builder.spec.ts
apps/web/tests/multitable-grid.spec.ts
apps/web/tests/multitable-workbench-view.spec.ts
```

### 2.2 Existing Test Surface

| File | Current Role | T3A Use |
|---|---|---|
| `apps/web/tests/meta-toolbar-filter-builder.spec.ts` | Mounts real `MetaToolbar` with reactive state; already checks filter controls, typed defaults, dirty apply copy. | Extend with locale-aware zh-CN/en assertions. |
| `apps/web/tests/multitable-grid.spec.ts` | Tests `useMultitableGrid` composable, not `MetaGridTable` component. | Keep as regression only; do not overload it with component i18n. |
| `apps/web/tests/multitable-workbench-view.spec.ts` | Full Workbench mount. T2 render assertions now reliable after #1671. | Do not use for T3A except optional smoke; focused component specs are cheaper and clearer. |

### 2.3 Existing Label Pattern

`apps/web/src/multitable/utils/workbench-labels.ts` is the closest precedent:

- Explicit `en` + `zh` mapping.
- Typed key union.
- Helper functions for interpolated strings.
- Components read `useLocale().isZh`.
- Template usage can rely on computed auto-unwrapping; script usage must use `.value`.

T3A should follow this pattern but should not keep expanding `workbench-labels.ts`. The Workbench label module should remain the T2 shell module. T3A needs a separate core-table label module.

---

## 3. Scope

### 3.1 In Scope

| Surface | File | In-Scope Strings |
|---|---|---|
| Toolbar shell | `MetaToolbar.vue` | `Grid toolbar`, `Fields`, `Sort`, `Filter`, `Group`, `Rows`, `Fit`, `Print`, `Import`, `Export CSV`, `Export XLSX`, `+ New Record` |
| Sort panel | `MetaToolbar.vue` | `+ Add sort`, `Apply` |
| Filter panel | `MetaToolbar.vue` | `Where`, `all`, `any`, `conditions match`, `Filter field`, `Filter operator`, `Filter value`, `no value needed`, `Choose option...`, `No options`, `checked / true`, `unchecked / false`, `+ Add filter`, `Clear all`, `Apply filter changes`, `Apply filters`, `Filter changes are staged until applied.` |
| Field type labels | `MetaToolbar.vue` | `text`, `long text`, `number`, `checkbox`, `select`, `multi-select`, `date` |
| Filter placeholders | `MetaToolbar.vue` | `Enter a number`, `Pick a date`, `Enter filter text` |
| Group panel | `MetaToolbar.vue` | `None` |
| Undo/search/density aria/title | `MetaToolbar.vue` | `Undo`, `Redo`, `Search records...`, `Search records`, `Clear search`, `Row height`, `Auto-fit columns`, `Print grid`, `Import records`, `Export Excel` |
| Row count/density labels | `MetaToolbar.vue` | `{n} rows`, `Compact`, `Normal`, `Expanded` |
| Grid root and bulk bar | `MetaGridTable.vue` | `Data grid`, `{n} selected`, `Set field`, `Clear field`, `Delete selected`, `Clear`, relevant aria labels |
| Empty states | `MetaGridTable.vue` | `No records yet`, `Click + New Record to add your first row`, `No matching records`, `Try a different search term` |
| Row expand/comment aria | `MetaGridTable.vue` | `Collapse row`, `Expand row`, `Comments for row {n}`, `Comments for {field}` |
| Group no-value label | `MetaGridTable.vue` | `(No value)` |
| Pagination/loading | `MetaGridTable.vue` | `Prev`, `Next`, `Loading data` |
| Shallow cell editor strings | `MetaCellEditor.vue` | `Editing`, `Scan or enter barcode`, `Enter address`, `Yes`, `No`, `Clear`, link button fallback, attachment action hints, upload activity labels, fallback attachment errors |

### 3.2 Out of Scope

| Surface | Reason |
|---|---|
| `MetaRecordDrawer.vue`, `MetaFormView.vue`, comments drawer/composer/link picker | T3B. These are record-detail and form-edit surfaces, not core table chrome. |
| `MetaFieldManager.vue`, `MetaViewManager.vue`, permission/share/API manager panels | T3C. Larger admin surface with higher wording risk. |
| `MetaAutomationManager.vue`, automation rule editor/log viewers | T3D. DingTalk and automation semantics need dedicated review. |
| `MultitableWorkbench.vue` dynamic toasts and `templateLibraryError` | T3E. Dynamic pluralization/backend fallback needs separate helpers and tests. |
| `MetaImportModal.vue`, `MetaBulkEditDialog.vue`, conditional formatting | T3C/T3E. These are modal workflows, not default table chrome. |
| Field names, option labels, group values, view names, record values | User data; must remain as authored. |
| Backend error messages or validation messages from services | Do not translate free-form backend text in T3A. Only map stable frontend-owned strings. |
| `MetaFieldHeader.vue` field type icon map | Mostly icons/data labels. Do not change unless adding aria labels later. |

### 3.3 MetaCellEditor Boundary

`MetaCellEditor.vue` is included only because it appears inline inside the grid when users edit a cell. Keep T3A limited to shallow, static user-facing text:

- Include: placeholders, boolean `Yes/No`, rating `Clear`, Yjs chip label `Editing`, attachment static action hints, activity labels, fallback error strings.
- Do not redesign attachment upload errors.
- Do not translate option values in select/multi-select.
- Do not translate URL/email/phone example placeholders; they are example data formats, not UI copy.
- If the implementation becomes noisy, split `MetaCellEditor` into a follow-up T3A2 and keep initial T3A to `MetaToolbar` + `MetaGridTable`.

---

## 4. Proposed Label Module

Create:

```text
apps/web/src/multitable/utils/meta-core-labels.ts
```

Pattern:

```ts
export type MetaCoreLabelKey =
  | 'toolbar.aria'
  | 'toolbar.fields'
  // ...

const META_CORE_LABELS: Record<MetaCoreLabelKey, { en: string; zh: string }> = {
  'toolbar.fields': { en: 'Fields', zh: '字段' },
}

export function metaCoreLabel(key: MetaCoreLabelKey, isZh: boolean): string {
  const entry = META_CORE_LABELS[key]
  return isZh ? entry.zh : entry.en
}
```

Helper functions:

| Helper | English | Chinese | Notes |
|---|---|---|---|
| `rowCount(n, isZh)` | `1 row`, `N rows` | `N 行` | Fix existing English-only `{n} rows`; keep plural correct in en. |
| `selectedCount(n, isZh)` | `1 selected`, `N selected` | `已选择 N 条` | Bulk bar. |
| `commentForRow(rowNumber, isZh)` | `Comments for row 3` | `第 3 行评论` | Row number is UI-generated. |
| `commentForField(fieldName, isZh)` | `Comments for Status` | `Status 的评论` | Field name remains untranslated. |
| `groupNoValue(isZh)` | `(No value)` | `(无值)` | Data group fallback only. |
| `filterFieldTypeLabel(type, isZh)` | `long text` | `长文本` | Stable field type labels only. |
| `filterValuePlaceholder(type, isZh)` | `Enter a number` | `输入数字` | Stable frontend placeholders. |
| `linkButtonFallback(isZh)` | `Choose linked records...` | `选择关联记录...` | Only fallback; `formatLinkActionLabel` output may need separate T3B work if field-specific. |
| `attachmentActionHint(allowsMultiple, hasExisting, isZh)` | current three variants | Chinese variants | Keep logic in helper for testability. |
| `attachmentActivityLabel(activity, isZh)` | `Uploading...` etc. | Chinese variants | Include `uploading/removing/clearing`. |

Why helpers instead of keys for dynamic strings:

- Avoid ad-hoc template string assembly in components.
- Keep en pluralization and zh non-plural behavior tested in one place.
- Make field/user data interpolation explicit and auditable.

---

## 5. Exact Key Table

### 5.1 Static Toolbar Keys

| Key | EN | ZH |
|---|---|---|
| `toolbar.aria` | Grid toolbar | 表格工具栏 |
| `toolbar.fields` | Fields | 字段 |
| `toolbar.sort` | Sort | 排序 |
| `toolbar.addSort` | + Add sort | + 添加排序 |
| `toolbar.apply` | Apply | 应用 |
| `toolbar.filter` | Filter | 筛选 |
| `toolbar.where` | Where | 当 |
| `toolbar.all` | all | 全部 |
| `toolbar.any` | any | 任一 |
| `toolbar.conditionsMatch` | conditions match | 条件匹配 |
| `toolbar.noValueNeeded` | no value needed | 无需填写值 |
| `toolbar.chooseOption` | Choose option... | 选择选项... |
| `toolbar.noOptions` | No options | 无可用选项 |
| `toolbar.checkedTrue` | checked / true | 已勾选 / true |
| `toolbar.uncheckedFalse` | unchecked / false | 未勾选 / false |
| `toolbar.addFilter` | + Add filter | + 添加筛选 |
| `toolbar.clearAll` | Clear all | 全部清除 |
| `toolbar.applyFilterChanges` | Apply filter changes | 应用筛选更改 |
| `toolbar.applyFilters` | Apply filters | 应用筛选 |
| `toolbar.stagedHint` | Filter changes are staged until applied. | 筛选更改将在应用后生效。 |
| `toolbar.group` | Group | 分组 |
| `toolbar.none` | None | 无 |
| `toolbar.undo` | Undo | 撤销 |
| `toolbar.redo` | Redo | 重做 |
| `toolbar.searchPlaceholder` | Search records... | 搜索记录... |
| `toolbar.searchAria` | Search records | 搜索记录 |
| `toolbar.clearSearch` | Clear search | 清除搜索 |
| `toolbar.rowHeight` | Row height | 行高 |
| `toolbar.rows` | Rows | 行 |
| `toolbar.autoFitColumns` | Auto-fit columns | 自动适应列宽 |
| `toolbar.fit` | Fit | 适应 |
| `toolbar.print` | Print | 打印 |
| `toolbar.printGrid` | Print grid | 打印表格 |
| `toolbar.importRecords` | Import records | 导入记录 |
| `toolbar.import` | Import | 导入 |
| `toolbar.exportCsv` | Export CSV | 导出 CSV |
| `toolbar.exportExcel` | Export Excel | 导出 Excel |
| `toolbar.exportExcelXlsx` | Export Excel (.xlsx) | 导出 Excel (.xlsx) |
| `toolbar.exportXlsx` | Export XLSX | 导出 XLSX |
| `toolbar.newRecord` | + New Record | + 新建记录 |

### 5.2 Density Keys

| Key | EN | ZH |
|---|---|---|
| `density.compact` | Compact | 紧凑 |
| `density.normal` | Normal | 标准 |
| `density.expanded` | Expanded | 宽松 |

### 5.3 Field Type Labels

| Field Type | EN | ZH |
|---|---|---|
| `string` | text | 文本 |
| `longText` | long text | 长文本 |
| `number` | number | 数字 |
| `boolean` | checkbox | 复选框 |
| `select` | select | 单选 |
| `multiSelect` | multi-select | 多选 |
| `date` | date | 日期 |
| fallback | original type | original type | Unknown/custom values stay as-is. |

### 5.4 Filter Placeholder Helpers

| Field Type | EN | ZH |
|---|---|---|
| `number` | Enter a number | 输入数字 |
| `date` | Pick a date | 选择日期 |
| fallback | Enter filter text | 输入筛选文本 |

### 5.5 Grid Static Keys

| Key | EN | ZH |
|---|---|---|
| `grid.aria` | Data grid | 数据表格 |
| `grid.setField` | Set field | 设置字段 |
| `grid.setFieldAria` | Set field on selected records | 为所选记录设置字段 |
| `grid.clearField` | Clear field | 清空字段 |
| `grid.clearFieldAria` | Clear field on selected records | 清空所选记录的字段 |
| `grid.deleteSelected` | Delete selected | 删除所选 |
| `grid.deleteSelectedAria` | Delete selected records | 删除所选记录 |
| `grid.clear` | Clear | 清除 |
| `grid.clearSelection` | Clear selection | 清除选择 |
| `grid.noRecordsTitle` | No records yet | 暂无记录 |
| `grid.noRecordsHintPrefix` | Click | 点击 |
| `grid.noRecordsHintAction` | + New Record | + 新建记录 |
| `grid.noRecordsHintSuffix` | to add your first row | 添加第一行 |
| `grid.noMatchingTitle` | No matching records | 没有匹配的记录 |
| `grid.noMatchingHint` | Try a different search term | 试试其他搜索词 |
| `grid.collapseRow` | Collapse row | 收起行 |
| `grid.expandRow` | Expand row | 展开行 |
| `grid.prev` | Prev | 上一页 |
| `grid.next` | Next | 下一页 |
| `grid.loading` | Loading data | 正在加载数据 |

Note: the current empty hint uses an inline `<strong>+ New Record</strong>`. Implementation should preserve emphasis while localizing the sentence. It can use three label segments or a small helper.

### 5.6 Cell Editor Keys

| Key / Helper | EN | ZH | Notes |
|---|---|---|---|
| `cell.editing` | Editing | 正在编辑 | Yjs presence chip label. |
| `cell.barcodePlaceholder` | Scan or enter barcode | 扫描或输入条码 | Static placeholder. |
| `cell.locationPlaceholder` | Enter address | 输入地址 | Static placeholder. |
| `cell.yes` | Yes | 是 | Boolean editor. |
| `cell.no` | No | 否 | Boolean editor. |
| `cell.clear` | Clear | 清除 | Rating clear. |
| `cell.noAttachments` | No attachments | 无附件 | Passed to `MetaAttachmentList`. |
| `cell.clearAll` | Clear all | 全部清除 | Attachment action. |
| `attachmentActionHint(...)` | current three variants | Chinese variants | Helper. |
| `attachmentActivityLabel(...)` | Removing/Clearing/Uploading... | 正在移除/清空/上传... | Helper. |
| `cell.uploadFailed` | Failed to upload attachment | 附件上传失败 | Fallback only. |
| `cell.removeFailed` | Failed to remove attachment | 附件移除失败 | Fallback only. |
| `cell.clearFailed` | Failed to clear attachments | 附件清空失败 | Fallback only. |

Do not localize these in T3A:

| Existing Text | Reason |
|---|---|
| `https://example.com` | Format example, not UI chrome. |
| `name@example.com` | Format example, not UI chrome. |
| `+86 138 0000 0000` | Format example, already locale-relevant. |
| Select/multi-select option text | User/data value. |
| `formatLinkActionLabel` output | Comes from link-field utility; if it contains English, handle in T3B with link picker/drawer. |
| `validateAttachmentSelection(...)` message | Field-config validation layer, not shallow chrome. |

---

## 6. Component Wiring Plan

### 6.1 Common Import Pattern

In `MetaToolbar.vue`, `MetaGridTable.vue`, and optional `MetaCellEditor.vue`:

```ts
import { useLocale } from '../../composables/useLocale'
import { metaCoreLabel, rowCount } from '../utils/meta-core-labels'

const { isZh } = useLocale()
const l = (key: MetaCoreLabelKey) => metaCoreLabel(key, isZh.value)
```

Path examples must be adjusted by file location:

- From `components/MetaToolbar.vue`: `../utils/meta-core-labels`, `../../composables/useLocale`
- From `components/MetaGridTable.vue`: `../utils/meta-core-labels`, `../../composables/useLocale`
- From `components/cells/MetaCellEditor.vue`: `../../utils/meta-core-labels`, `../../../composables/useLocale`

### 6.2 Template Usage

Preferred:

```vue
<button>{{ l('toolbar.fields') }}</button>
```

Acceptable for helpers:

```vue
<span>{{ rowCount(totalRows, isZh) }}</span>
```

Vue templates auto-unwrap computed refs, so `isZh` is fine in templates. In script/computed functions, use `isZh.value`.

### 6.3 Script Computed Usage

Examples:

```ts
const applyButtonLabel = computed(() =>
  props.sortFilterDirty
    ? metaCoreLabel('toolbar.applyFilterChanges', isZh.value)
    : metaCoreLabel('toolbar.applyFilters', isZh.value),
)

function getFilterFieldTypeLabel(fieldId: string): string {
  const type = getFieldType(fieldId)
  return filterFieldTypeLabel(type, isZh.value)
}
```

### 6.4 Preserve Data-Layer Values

Do not wrap these:

```vue
{{ field.name }}
{{ option.label }}
{{ option.value }}
{{ group.label }} // except the special fallback group "(No value)"
{{ row.data[field.id] }}
```

Only the fallback group label should be localized:

```ts
label: key === '__ungrouped__' ? groupNoValue(isZh.value) : key
```

If grouping values include English user data, they must remain exactly as stored.

---

## 7. Test Plan

### 7.1 New Label Spec

Create:

```text
apps/web/tests/multitable-core-i18n.spec.ts
```

Coverage:

| Case | Assertions |
|---|---|
| Static labels | `metaCoreLabel('toolbar.fields', true) === '字段'`; `false === 'Fields'`. |
| Row count | en `1 row` / `2 rows`; zh `1 行` / `2 行`. |
| Selected count | en `1 selected` / `2 selected`; zh `已选择 1 条` / `已选择 2 条`. |
| Comment aria helpers | field name remains raw: `Status 的评论`, not translated. |
| Field type helper | known labels translate; unknown type returns original. |
| Attachment helpers | all three action hints and three activity states covered. |

### 7.2 MetaToolbar Render Spec

Extend `apps/web/tests/meta-toolbar-filter-builder.spec.ts` rather than creating a second toolbar harness.

Capability-gated strings must be made reachable explicitly. The existing `mountToolbar()` helper currently passes `canCreateRecord: true` and `canExport: true`, which is why `Import`, `Export CSV`, `Export XLSX`, and `+ New Record` render. If the helper is refactored or a new harness is introduced, the T3A render tests must set:

```ts
canCreateRecord: true
canExport: true
```

Do not assert capability-gated strings from a mount where those capabilities are false or omitted. This is the same class of false-negative risk as the T2 Workbench `Workflow` / `Automations` gating issue.

New cases:

| Case | Setup | Assertions |
|---|---|---|
| zh-CN toolbar shell | `useLocale().setLocale('zh-CN')`, mount with `canCreateRecord: true`, `canExport: true` | Contains `字段`, `排序`, `筛选`, `分组`, `搜索记录`, `导出 CSV`, `+ 新建记录`; does not contain `Fields` / `Search records...`. |
| en toolbar shell | `useLocale().setLocale('en')` | Existing English strings still render. |
| zh-CN filter panel | Open filter panel with select/boolean fields | Contains `当`, `全部`, `条件匹配`, `无可用选项` or `选择选项...`, `已勾选 / true`, `未勾选 / false`, `添加筛选`. |
| zh-CN dirty apply copy | `sortFilterDirty: true` | Contains `应用筛选更改`, `筛选更改将在应用后生效。` |

After each test, reset:

```ts
useLocale().setLocale('en')
```

### 7.3 MetaGridTable Render Spec

Create focused component spec:

```text
apps/web/tests/meta-grid-table-i18n.spec.ts
```

Do not use full Workbench mount. Directly mount `MetaGridTable` with an explicit, real prop set. Do not rely on "minimal props" by guesswork.

Baseline mount props:

```ts
{
  rows,
  visibleFields,
  sortRules: [],
  loading: false,
  currentPage: 1,
  totalPages: 1,
  startIndex: 0,
  canEdit: true,
  canDelete: true,
  canBulkEdit: true,
  enableMultiSelect: true,
  searchText: '',
  rowDensity: 'normal',
  groupField: null,
  fieldReadOnlyIds: [],
  rowActionOverrides: {},
  columnWidths: {},
  linkSummaries: {},
  attachmentSummaries: {},
  canComment: true,
  commentPresence: {},
}
```

Bulk-delete assertions are capability-gated by `canDelete`; bulk set/clear assertions are gated by `canBulkEdit`; selection UI is gated by `enableMultiSelect`. If any of those props are false or omitted, do not assert the gated strings.

`apps/web/tests/multitable-grid.spec.ts` currently targets the `useMultitableGrid` composable rather than `MetaGridTable` component render. Treat it as a regression check only after confirming that remains true at implementation time.

Cases:

| Case | Setup | Assertions |
|---|---|---|
| zh-CN empty grid | rows `[]`, visible fields `[Title]`, loading false | Contains `暂无记录`, `点击`, `+ 新建记录`, `添加第一行`; root aria-label `数据表格`. |
| en empty grid | locale en | Contains `No records yet`, `+ New Record`. |
| zh-CN search empty | `searchText: 'abc'`, rows `[]` | Contains `没有匹配的记录`, `试试其他搜索词`. |
| zh-CN bulk bar | rows with selectable ids, enable multi-select, simulate checkbox selection | Contains `已选择 1 条`, `设置字段`, `清空字段`, `删除所选`, `清除`; aria labels localized. |
| zh-CN pagination/loading | totalPages > 1 and loading true | Contains `上一页`, `下一页`; loading aria-label `正在加载数据`. |
| no user-data translation | field name `Status`, group value `Needs Review` | These remain raw while fallback `(No value)` becomes `(无值)`. |

### 7.4 MetaCellEditor Render Spec

Add to an existing cell editor spec if appropriate, or create:

```text
apps/web/tests/meta-cell-editor-i18n.spec.ts
```

Cases:

| Case | Assertions |
|---|---|
| boolean zh/en | `是/否` in zh, `Yes/No` in en. |
| barcode/location placeholders | zh placeholders render in zh. |
| rating clear | zh `清除`, en `Clear`. |
| attachment fallback chrome | `无附件`, `上传文件`, `全部清除` where visible. |
| option values untouched | select option value `todo` remains `todo`. |

If this spec grows too much, defer `MetaCellEditor` implementation to T3A2 and keep this MD as the boundary record.

### 7.5 Validation Commands

Required focused checks:

The file paths above are repository-relative. The commands below run through `pnpm --filter @metasheet/web exec`, so Vitest's working directory is `apps/web`; spec paths must be package-relative (`tests/...`), not `apps/web/tests/...`.

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-core-i18n.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/meta-toolbar-filter-builder.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/meta-grid-table-i18n.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/meta-cell-editor-i18n.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check origin/main..HEAD
```

If `MetaCellEditor` is deferred, omit its spec command and explicitly record the deferral in verification MD.

Optional broader web test check:

```bash
pnpm --filter @metasheet/web test
```

This is useful after #1671, but T3A should not block solely on unrelated pre-existing web test failures if focused and CI checks are green.

### 7.6 Implementation Preflight Grep

Before writing code, verify each planned key has a current call-site. Do not create dead keys from the design table.

Required grep pass:

```bash
rg -n "Fields|Sort|Filter|Group|Rows|Fit|Print|Import|Export CSV|Export XLSX|\\+ New Record|Search records|No records yet|No matching records|Prev|Next|Loading data|Scan or enter barcode|Enter address|No attachments|Failed to upload attachment" \
  apps/web/src/multitable/components/MetaToolbar.vue \
  apps/web/src/multitable/components/MetaGridTable.vue \
  apps/web/src/multitable/components/cells/MetaCellEditor.vue
```

For each key:

| Outcome | Required Action |
|---|---|
| Call-site exists | Wire the key or helper. |
| Call-site does not exist | Do not implement the key; record it as removed from scope in verification MD. |
| Call-site is user/data value | Do not translate; record as intentionally preserved. |
| Call-site is capability-gated | Make it reachable in tests or exclude it from that assertion set. |

---

## 8. Acceptance Criteria

T3A is complete when all are true:

1. zh-CN locale renders localized toolbar/grid/cell-editor chrome for the in-scope strings.
2. en locale preserves existing English labels and behavior.
3. Field names, option values, group values, record values, IDs, URLs, email examples, phone examples, and backend error strings remain untranslated.
4. Sort/filter/group/search/bulk selection behavior is unchanged.
5. No API contract, backend route, migration, K3 adapter, plugin integration, or OpenAPI file changes.
6. New label helpers have unit coverage for pluralization/interpolation and unknown fallbacks.
7. Focused component tests cover both zh-CN and en render.
8. Verification MD records any intentionally deferred strings found by grep.

---

## 9. Implementation Order

Recommended commits:

| Commit | Scope |
|---|---|
| `docs(multitable): T3A core table i18n development plan` | This MD only, if not bundled with implementation. |
| `feat(multitable): add core table i18n label helpers` | `meta-core-labels.ts` + label helper tests. |
| `feat(multitable): localize toolbar and grid chrome` | `MetaToolbar.vue`, `MetaGridTable.vue`, toolbar/grid render tests. |
| `feat(multitable): localize shallow cell editor chrome` | `MetaCellEditor.vue` + cell editor render tests, only if kept in T3A. |
| `docs(multitable): T3A verification` | Verification MD with command output and deferred-string ledger. |

If keeping the PR smaller, split cell editor into a follow-up:

- T3A1: label module + toolbar + grid.
- T3A2: shallow cell editor chrome.

The safer default is T3A1 first if review bandwidth is limited.

---

## 10. Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Translating user data | High | Explicit non-translation list; tests include English field/option/group values that must remain unchanged. |
| Large `MetaCellEditor` scope creep | Medium | Keep only shallow static strings; defer attachments/link utility if noisy. |
| Existing tests assert English copy | Medium | Update tests deliberately; add en render assertions so English path stays stable. |
| Helper import path mistakes | Low | Use `vue-tsc --noEmit`; components live at different folder depths. |
| Pluralization mistakes | Low-medium | Helper unit tests for en singular/plural and zh count forms. |
| Label module sprawl | Medium | Keep T3A common table chrome only in `meta-core-labels.ts`; do not absorb manager/automation strings. |
| Accessibility label drift | Medium | Include aria/title labels in key table and render tests. |

---

## 11. Review Checklist

Reviewer should verify:

- `meta-core-labels.ts` contains no user-data mapping.
- Unknown field types fall back to the original type string.
- `MetaToolbar` still emits the same events and payloads.
- `MetaGridTable` still emits the same row selection, bulk, comment, and pagination events.
- `MetaCellEditor` still emits the same `update:modelValue`, `confirm`, `cancel`, `yjs-commit`, and `open-link-picker` events.
- No K3/integration-core/backend files are touched.
- Verification MD includes:
  - focused test results,
  - `vue-tsc` result,
  - build result,
  - `git diff --check`,
  - deferred string ledger for T3B/T3C/T3D/T3E leftovers.

---

## 12. Proposed PR Title and Body Skeleton

Title:

```text
feat(multitable): localize core table chrome to zh-CN (T3A)
```

Body outline:

```markdown
## What changed

- Added typed `meta-core-labels.ts` for core table UI strings.
- Localized `MetaToolbar` and `MetaGridTable` chrome to zh-CN while preserving en.
- [Optional] Localized shallow `MetaCellEditor` static chrome.
- Added zh/en render tests and helper unit tests.

## What this does not change

- No backend/API/OpenAPI/migration changes.
- No K3 or plugin-integration-core changes.
- Does not translate user data, field names, option values, group values, record values, URLs, ids, or backend free-form errors.
- Does not cover Meta* manager panels, automation, record drawer, comments, import, or dynamic Workbench toasts.

## Verification

- pnpm --filter @metasheet/web exec vitest run ...
- pnpm --filter @metasheet/web exec vue-tsc --noEmit
- pnpm --filter @metasheet/web build
- git diff --check origin/main..HEAD
```

---

## 13. Recommendation

Start implementation with **T3A1 only**:

1. Add `meta-core-labels.ts`.
2. Localize `MetaToolbar.vue`.
3. Localize `MetaGridTable.vue`.
4. Add label + toolbar + grid render tests.
5. Write verification MD.

Keep `MetaCellEditor.vue` as T3A2 unless the initial diff remains small. This avoids mixing cell attachment/link/Yjs edge cases into the first core-table PR while still giving zh-CN users the most visible improvement.
