# T3E-3 Bulk Edit + Conditional Formatting i18n Design

Date: 2026-05-21
Branch: docs/multitable-t3e3-bulk-formatting-i18n-design-20260521
Status: design draft; no implementation yet

## 1. Decision Summary

T3E-3 localizes the remaining dialog-level multitable chrome that is still visible after T3E-2:

| Decision | Choice | Reason |
| --- | --- | --- |
| Scope | `MetaBulkEditDialog.vue` + Workbench `bulkEditDialog.*` parent messages + `ConditionalFormattingDialog.vue` | These are the two T3E-3 residual surfaces; bulk dialog parent-generated success/error messages must ship with the dialog |
| PR shape | One PR | Two dialogs plus parent helpers are still smaller than T3D and share the same "dialog residual" verification surface |
| Bulk label home | New `meta-bulk-edit-labels.ts` with `bulk.*` keys/helpers | `MetaBulkEditDialog` is a modal overlay like `MetaImportModal`, not inline grid chrome; per-dialog module keeps discovery clear and avoids bloating `meta-core-labels.ts` |
| Conditional-formatting label home | Extend `meta-manager-labels.ts` with `formatting.*` keys/helpers | Conditional formatting is opened from `MetaViewManager`; `view.discardFormattingConfirm` already lives in manager labels |
| Shared manager actions | Reuse `managerLabel('action.cancel'/'action.remove')` only inside `ConditionalFormattingDialog.vue` | Stays within manager domain; do not redeclare manager shared action keys |
| Raw values | Preserve field names, select option values, record IDs, failure reasons, backend/runtime `e.message`, color hex values | User/authored/runtime data must not be translated |
| A11y | Localize existing `aria-label`/placeholder text; do not add new a11y attributes | Localizing text that screen readers already read is required i18n behavior; the boundary forbids adding new a11y attributes or changing interaction semantics |
| Deferred | T3D automation and final audit remain deferred | No automation/rule-editor/log-viewer work in this PR |

## 2. Files In Scope

Implementation:

| File | Planned change |
| --- | --- |
| `apps/web/src/multitable/utils/meta-bulk-edit-labels.ts` | New typed EN/ZH label module for `MetaBulkEditDialog.vue` and Workbench parent-generated bulk result messages |
| `apps/web/src/multitable/utils/meta-manager-labels.ts` | Add `formatting.*` keys and conditional-formatting operator/color helpers |
| `apps/web/src/multitable/components/MetaBulkEditDialog.vue` | Use `useLocale()` + `bulkEditLabel`/bulk helpers; localize visible text and existing aria labels |
| `apps/web/src/multitable/views/MultitableWorkbench.vue` | Replace parent-generated `bulkEditDialog.error/resultMessage` strings with bulk helpers |
| `apps/web/src/multitable/components/ConditionalFormattingDialog.vue` | Use `useLocale()` + `managerLabel`/formatting helpers; localize visible text, placeholders, existing aria labels, and dirty confirm |

Tests/docs:

| File | Planned change |
| --- | --- |
| `apps/web/tests/meta-bulk-edit-labels.spec.ts` | New helper/key spec for bulk edit labels, whitespace-sensitive helpers, and raw-boundary behavior |
| `apps/web/tests/multitable-manager-panels-i18n.spec.ts` | Add conditional-formatting manager helper tests or render smoke if cheap |
| `apps/web/tests/multitable-bulk-edit-dialog.spec.ts` | Preserve EN baseline and add zh-CN render/raw/a11y assertions |
| `apps/web/tests/conditional-formatting-dialog-i18n.spec.ts` | New direct render spec for zh-CN/EN conditional-formatting dialog chrome |
| `docs/development/multitable-t3e3-bulk-formatting-i18n-verification-20260521.md` | Verification report after implementation |

Out of scope:

| Surface | Reason |
| --- | --- |
| T3D automation manager/rule editor/log viewer | Larger rule-domain surface; requires separate design MD |
| Final multitable i18n audit | Best after T3D and this slice land |
| Backend/contracts/migrations/attendance/K3 | K3 PoC stage-1 lock; this is frontend i18n only |

## 3. Preflight Grep

Before implementation, run:

```bash
rg -n "Set field for selected records|Clear field for selected records|Pick a field|No bulk-editable|Field to update|choose a field|Will clear|Set value|Bulk edit failed|Some records were modified elsewhere|record\\(s\\) failed|record\\(s\\) updated|record\\(s\\) cleared|Conditional formatting rules|Conditional formatting|No rules yet|Add a rule|Color|Apply to whole row|Enabled|Up|Down|Remove|Save rules|Discard unsaved formatting rules|between|is today|is overdue|is in last N days|is in next N days|is checked|is unchecked|does not contain|is empty|is not empty|\\(pick\\)|Pick color|min|max|#RRGGBB" \
  apps/web/src/multitable apps/web/tests
```

Acceptance:

| Category | Expected result |
| --- | --- |
| T3E-3 call-sites | Every planned source string maps to a real call-site in `MetaBulkEditDialog.vue`, `MultitableWorkbench.vue`, or `ConditionalFormattingDialog.vue` |
| Existing tests | EN baseline assertions updated, not deleted without replacement |
| Raw values | Field names, option values, color values, record IDs, and failure reasons stay raw |
| Deferred | Any remaining hits after implementation must be either label definitions/tests or explicitly deferred |

Reuse-key reachability check:

```bash
rg -n "'view\\.discardFormattingConfirm'|'action\\.conditionalFormatting'|'action\\.cancel'|'action\\.remove'" \
  apps/web/src/multitable/utils/meta-manager-labels.ts
```

These four keys must exist before implementation and should be cited in the verification MD:

| Key | Purpose |
| --- | --- |
| `action.conditionalFormatting` | Confirms T3C-1 already placed conditional formatting in manager label domain |
| `view.discardFormattingConfirm` | Dirty confirm string already exists and should be reused |
| `action.cancel` | Shared manager action reused by `ConditionalFormattingDialog.vue` |
| `action.remove` | Shared manager action reused by `ConditionalFormattingDialog.vue` |

## 4. Label Module Plan

### 4.1 `meta-bulk-edit-labels.ts` Bulk Keys

Add a new scoped module because `MetaBulkEditDialog` is structurally closer to `MetaImportModal` than to inline grid/cell chrome:

- It is a modal overlay invoked by Workbench.
- It operates on grid records but is visually independent from the grid table.
- Future readers will naturally look for `meta-bulk-edit-labels.ts`, matching the existing `meta-import-labels.ts` pattern.
- `meta-core-labels.ts` remains the cross-surface core-table module for toolbar/grid/cell-editor/presence primitives, not an arbitrary home for every grid-related modal.

Module shape:

```ts
export type MetaBulkEditLabelKey = ...
export function bulkEditLabel(key: MetaBulkEditLabelKey, isZh: boolean): string
```

| Key/helper | EN | zh-CN | Notes |
| --- | --- | --- | --- |
| `bulk.titleSet` | `Set field for selected records` | `为所选记录设置字段` | Dialog title + aria label |
| `bulk.titleClear` | `Clear field for selected records` | `清空所选记录的字段` | Dialog title + aria label |
| `bulk.field` | `Field` | `字段` | Label |
| `bulk.fieldAria` | `Field to update` | `要更新的字段` | Existing aria-label |
| `bulk.chooseField` | `(choose a field)` | `（选择字段）` | Empty option |
| `bulk.noEditableFields` | `No bulk-editable fields are available for the current selection.` | `当前选择没有可批量编辑的字段。` | Empty state |
| `bulk.value` | `Value` | `值` | Set mode label |
| `bulk.action` | `Action` | `操作` | Clear mode label |
| `bulk.close` | `Close` | `关闭` | Existing close-button aria-label |
| `bulk.cancel` | `Cancel` | `取消` | Bulk dialog is not a manager panel, so use scoped key |
| `bulk.submitSet` | `Set value` | `设置值` | Primary button, set mode |
| `bulk.submitClear` | `Clear` | `清空` | Primary button, clear mode |
| `bulk.errorFailed` | `Bulk edit failed` | `批量编辑失败` | Fallback only; `e.message` stays raw first |

Bulk helpers:

| Helper | EN | zh-CN | Raw boundary |
| --- | --- | --- | --- |
| `bulkSummary(mode: 'set' | 'clear', count: number, isZh: boolean)` | `Pick a field and a value to set on 3 selected records.` / `Pick a field to clear on 3 selected records.` | `选择字段和值，应用到 3 条所选记录。` / `选择要在 3 条所选记录中清空的字段。` | Count only |
| `bulkClearHintPrefix(count: number, isZh: boolean)` + `bulkClearHintSuffix(count: number, isZh: boolean)` | `Will clear ` + ` on 3 records.` | `将在 3 条记录中清空 ` + `。` | Keeps `<strong>{{ selectedField.name }}</strong>` raw and visually emphasized |
| `bulkSuccess(count: number, mode: 'set' | 'clear', isZh: boolean)` | `3 records updated` / `3 records cleared` | `已更新 3 条记录` / `已清空 3 条记录` | Count only |
| `bulkPartialSuccess(updated: number, requested: number, mode: 'set' | 'clear', isZh: boolean)` | `2 of 3 records updated` | `3 条记录中已更新 2 条` | Count only |
| `bulkFailure(failed: number, requested: number, sampleFailures: string, isZh: boolean)` | `1 of 3 record failed (rec_1: conflict)` or `1 of 3 record failed` | `3 条记录中有 1 条失败（rec_1: conflict）` or `3 条记录中有 1 条失败` | `sampleFailures` raw; empty string must not produce empty parentheses |
| `bulkVersionConflict(message: string, isZh: boolean)` | `Some records were modified elsewhere. Reload and retry. (${message})` or `Some records were modified elsewhere. Reload and retry.` | `部分记录已在其他位置修改。请重新加载后重试。（${message}）` or `部分记录已在其他位置修改。请重新加载后重试。` | `message` raw; empty string must not produce empty parentheses |

Implementation note:

- Use real English pluralization (`record` vs `records`), not `record(s)`.
- Keep `sampleFailures` assembly in Workbench as raw `${recordId}: ${reason}` and pass the joined raw string into the helper.
- Preserve `<strong>{{ selectedField.name }}</strong>` in the clear hint by using prefix/suffix helpers instead of returning HTML from a helper.
- `bulkClearHintPrefix/Suffix` return values include intentional leading/trailing whitespace that MUST NOT be trimmed; specs must assert byte-exact output:
  `bulkClearHintPrefix(3, false) === 'Will clear '`,
  `bulkClearHintSuffix(3, false) === ' on 3 records.'`,
  `bulkClearHintPrefix(3, true) === '将在 3 条记录中清空 '`,
  `bulkClearHintSuffix(3, true) === '。'`.
- `bulkFailure(...)` and `bulkVersionConflict(...)` must conditionally append parentheses only when their raw detail string is non-empty.

### 4.2 `meta-manager-labels.ts` Conditional Formatting Keys

Add `formatting.*` keys under the manager domain.

| Key/helper | EN | zh-CN | Notes |
| --- | --- | --- | --- |
| `formatting.title` | `Conditional formatting` | `条件格式` | Header |
| `formatting.ariaTitle` | `Conditional formatting rules` | `条件格式规则` | Existing dialog aria-label |
| `formatting.close` | `Close` | `关闭` | Existing close-button aria-label |
| `formatting.empty` | `No rules yet. Add a rule to color cells or rows based on field values.` | `暂无规则。添加规则后，可根据字段值为单元格或整行着色。` | Empty state |
| `formatting.minPlaceholder` | `min` | `最小值` | Existing placeholder |
| `formatting.maxPlaceholder` | `max` | `最大值` | Existing placeholder |
| `formatting.pickOption` | `(pick)` | `（选择）` | Empty option for select values |
| `formatting.color` | `Color` | `颜色` | Label |
| `formatting.applyToRow` | `Apply to whole row` | `应用到整行` | Checkbox |
| `formatting.enabled` | `Enabled` | `启用` | Checkbox |
| `formatting.up` | `▲ Up` | `▲ 上移` | Keep arrow glyph |
| `formatting.down` | `▼ Down` | `▼ 下移` | Keep arrow glyph |
| `formatting.addRule` | `+ Add rule` | `+ 添加规则` | Primary action |
| `formatting.noFieldsHint` | `Add fields to the sheet to create formatting rules.` | `请先向 Sheet 添加字段，再创建格式规则。` | Empty field hint |
| `formatting.saveRules` | `Save rules` | `保存规则` | Footer primary action |

Reuse existing manager keys:

| Existing key | Current EN/ZH | Consumer |
| --- | --- | --- |
| `action.cancel` | `Cancel` / `取消` | Dialog footer |
| `action.remove` | `Remove` / `移除` | Rule remove button |
| `view.discardFormattingConfirm` | `Discard unsaved formatting rules?` / `放弃未保存的格式规则吗？` | Dirty close confirm |

Helpers:

| Helper | EN | zh-CN | Raw boundary |
| --- | --- | --- | --- |
| `formattingOperatorLabel(operator, fieldType, isZh)` | Existing labels by field type | Localized labels by field type | Operator enum value stays raw |
| `formattingPickColor(color, isZh)` | `Pick color ${color}` | `选择颜色 ${color}` | Color hex raw |

Operator label mapping:

| Operator/context | EN | zh-CN |
| --- | --- | --- |
| `gt` / `gte` / `lt` / `lte` | `>` / `>=` / `<` / `<=` | same raw symbols |
| `eq`, number/text | `=` | `=` |
| `neq`, number/text | `!=` | `!=` |
| `between` | `between` | `介于` |
| `contains` | `contains` | `包含` |
| `not_contains` | `does not contain` | `不包含` |
| `is_empty` | `is empty` | `为空` |
| `is_not_empty` | `is not empty` | `不为空` |
| `is_today` | `is today` | `是今天` |
| `is_overdue` | `is overdue` | `已逾期` |
| `is_in_last_n_days` | `is in last N days` | `最近 N 天内` |
| `is_in_next_n_days` | `is in next N days` | `未来 N 天内` |
| `is_true` | `is checked` | `已勾选` |
| `is_false` | `is unchecked` | `未勾选` |
| `eq`, select/multiSelect | `is` | `是` |
| `neq`, select/multiSelect | `is not` | `不是` |

Do not translate:

| Value | Reason |
| --- | --- |
| Select option values (`opt.value`) | User-authored data |
| Field names | User-authored schema |
| `#RRGGBB` placeholder | Format token, not prose |
| Palette hex values | Raw color data |
| Rule ids / persisted operator enum values | Contract data |

## 5. Exact Chrome Targets

### 5.1 `MetaBulkEditDialog.vue`

| Line | Current string | Plan |
| --- | --- | --- |
| L4/L115 | `Set field for selected records` / `Clear field for selected records` | `bulk.titleSet/titleClear` |
| L7 | `Close` | `bulk.close` |
| L14 | `Field` | `bulk.field` |
| L18 | `Field to update` | `bulk.fieldAria` |
| L21 | `(choose a field)` | `bulk.chooseField` |
| L28 | `No bulk-editable fields are available for the current selection.` | `bulk.noEditableFields` |
| L32 | `Value` | `bulk.value` |
| L50 | `Action` | `bulk.action` |
| L52 | `Will clear <field> on N record(s).` | `bulkClearHintPrefix(...)` + raw `<strong>{{ selectedField.name }}</strong>` + `bulkClearHintSuffix(...)` |
| L61 | `Cancel` | `bulk.cancel` |
| L121 | `Clear` / `Set value` | `bulk.submitClear/submitSet` |
| L116-L119 | Set/clear summaries | `bulkSummary(...)` |

### 5.2 `MultitableWorkbench.vue` Bulk Edit Parent Messages

| Line | Current string | Plan |
| --- | --- | --- |
| L2571 | `${failed} of ${requested} record(s) failed (...)` | `bulkFailure(failed, requested, sampleFailures, isZh.value)` |
| L2573 | `${updated} of ${requested} record(s) cleared/updated` | `bulkPartialSuccess(updated, requested, mode, isZh.value)` |
| L2576 | `${updated} of ${requested} record(s) updated` | Same helper with `mode='set'` |
| L2578 | `${updated} record(s) cleared/updated` | `bulkSuccess(updated, mode, isZh.value)` |
| L2586 | `Bulk edit failed` | `bulkEditLabel('bulk.errorFailed', isZh.value)` fallback after raw `e?.message` |
| L2588 | `Some records were modified elsewhere. Reload and retry. (${message})` | `bulkVersionConflict(message, isZh.value)` |

Raw boundary:

- Keep `failure.recordId` and `failure.reason` raw.
- Keep `e?.message` raw for non-version-conflict errors.
- Version conflict wraps the raw message in localized surrounding chrome.

### 5.3 `ConditionalFormattingDialog.vue`

| Line | Current string | Plan |
| --- | --- | --- |
| L3 | `Conditional formatting rules` | `formatting.ariaTitle` |
| L5 | `Conditional formatting` | `formatting.title` |
| L7 | `Close` | `formatting.close` |
| L11 | Empty state | `formatting.empty` |
| L39/L47 | `min` / `max` | `formatting.minPlaceholder/maxPlaceholder` |
| L52 | `(pick)` | `formatting.pickOption` |
| L80 | `Color` | `formatting.color` |
| L89 | `Pick color ${preset}` | `formattingPickColor(preset, isZh.value)` |
| L97 | `#RRGGBB` | Keep raw format token |
| L103 | `Apply to whole row` | `formatting.applyToRow` |
| L107 | `Enabled` | `formatting.enabled` |
| L116/L122 | `▲ Up` / `▼ Down` | `formatting.up/down` |
| L123 | `Remove` | `managerLabel('action.remove')` |
| L132 | `+ Add rule` | `formatting.addRule` |
| L133 | No fields hint | `formatting.noFieldsHint` |
| L136 | `Cancel` | `managerLabel('action.cancel')` |
| L137 | `Save rules` | `formatting.saveRules` |
| L370 | `Discard unsaved formatting rules?` | Existing `managerLabel('view.discardFormattingConfirm')` |
| L237-L284 | operator labels | `formattingOperatorLabel(...)` |

## 6. Implementation Order

1. Preflight grep from §3 and resolve any missing call-site before code changes.
2. Add `meta-bulk-edit-labels.ts` with `bulk.*` keys and helpers.
3. Extend `meta-manager-labels.ts` with `formatting.*` keys and helper functions.
4. Wire `MetaBulkEditDialog.vue` to `useLocale()` and bulk edit labels.
5. Wire Workbench `bulkEditDialog.*` parent messages to `meta-bulk-edit-labels.ts` helpers.
6. Wire `ConditionalFormattingDialog.vue` to `useLocale()` and manager formatting labels.
7. Add/extend helper specs, including byte-exact whitespace tests for `bulkClearHintPrefix/Suffix` and empty-detail tests for `bulkFailure` / `bulkVersionConflict`.
8. Extend `multitable-bulk-edit-dialog.spec.ts` for zh-CN render, EN baseline, raw field names, and existing aria labels.
9. Add `conditional-formatting-dialog-i18n.spec.ts` for zh-CN render, EN baseline, raw field/option/hex values, operator labels, existing aria labels, and dirty confirm text. Operator coverage must include at least number, text, select, multiSelect, boolean, and date field types with representative operators; specifically assert select/multiSelect `eq` renders `is` / `是`, while number `eq` remains `=`.
10. Run validation commands from §8.
11. Write verification MD with exact PASS lines and residual grep classification.
12. Commit targeted files only; stop before push.

## 7. Risk Register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Helper/domain leakage: using manager labels from bulk edit | Medium | Bulk edit labels live in dedicated `meta-bulk-edit-labels.ts`; conditional formatting remains manager domain |
| Raw failure details accidentally translated | Medium | Parent Workbench helpers accept raw `sampleFailures` and raw `message`; specs assert raw record IDs/reasons remain |
| Conditional operator labels lose field-type-specific wording | Medium | `formattingOperatorLabel(operator, fieldType, isZh)` includes select-specific `is/is not` and symbol-preserving numeric/text variants |
| CSS/data selector trap | Low | Neither dialog uses display text in `data-*`; class names remain raw/static |
| A11y drift | Low | Only localize existing `aria-label`/placeholder strings; spec asserts counts/values for representative labels |
| Existing tests depend on English copy | Medium | Update tests lockstep; keep EN baseline assertions so English behavior remains explicit |
| New module churn | Low | One new module is intentional because bulk edit is a modal overlay, following `meta-import-labels.ts` precedent |

## 8. Validation Plan

Commands use package-relative spec paths because `pnpm --filter @metasheet/web exec` runs in `apps/web`.

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/meta-bulk-edit-labels.spec.ts \
  tests/multitable-manager-panels-i18n.spec.ts \
  tests/multitable-bulk-edit-dialog.spec.ts \
  tests/conditional-formatting-dialog-i18n.spec.ts \
  --watch=false

pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check origin/main..HEAD
```

Optional regression checks if implementation touches Workbench parent messages substantially:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-workbench-view.spec.ts \
  -t "bulk" \
  --watch=false
```

Known baseline from T3E-2 remains out of scope:

- Full `multitable-workbench-view.spec.ts` currently has a workflow-designer feature-flag baseline failure on `origin/main`; do not fix it in T3E-3.

## 9. Approval Gate

T3E-3 is implementation-ready when review accepts:

1. Bulk edit labels under new `meta-bulk-edit-labels.ts`, not `meta-core-labels.ts` or `meta-manager-labels.ts`.
2. Conditional formatting labels under `meta-manager-labels.ts`, including operator/color helpers.
3. Parent Workbench `bulkEditDialog.error/resultMessage` included in T3E-3 scope.
4. Raw boundaries in §4-§5.
5. Test plan in §8, especially direct dialog render specs and helper specs.

## 10. Deferred After T3E-3

| Deferred | Trigger |
| --- | --- |
| T3D automation | Start with design MD after T3E-3 lands |
| Final global audit | Run after T3D and T3E-3 complete |
