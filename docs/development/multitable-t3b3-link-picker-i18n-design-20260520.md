# T3B3 — Link Picker i18n Design

- **Date**: 2026-05-20
- **Type**: implementation-ready design packet
- **Status**: implemented; paired verification in `docs/development/multitable-t3b3-link-picker-i18n-verification-20260520.md`
- **Preceded by**:
  - `docs/development/multitable-t3b1-record-form-i18n-design-20260520.md`
  - `docs/development/multitable-t3b2-comments-i18n-design-20260520.md`
- **Goal**: localize the link-record picker modal without changing link payload semantics, search behavior, API calls, or selected record display data.

## Scope

| File | Role |
|---|---|
| `apps/web/src/multitable/components/MetaLinkPicker.vue` | Modal chrome: title/search placeholder, selected header, clear/loading/empty/load-more/count/footer, close aria, FE fallback error. |
| `apps/web/src/multitable/utils/link-fields.ts` | Extend existing `linkPickerTitle` and `linkPickerSearchPlaceholder` with optional `isZh=false`, preserving all existing English callers. |
| `apps/web/src/multitable/utils/meta-link-picker-labels.ts` | New picker-surface static labels and selected-count helper. |
| `apps/web/tests/link-fields-i18n.spec.ts` | Extend helper coverage for picker title/search. |
| `apps/web/tests/meta-link-picker-labels.spec.ts` | New label/helper unit spec. |
| `apps/web/tests/meta-link-picker-i18n.spec.ts` | New render spec for zh-CN/en picker chrome. |

Out of scope:

- Backend `/api/multitable/fields/:id/link-options` behavior.
- `MetaCellEditor.vue` unreachable fallback comment.
- `MetaImportModal.vue` link picker usage beyond receiving localized picker chrome when the modal opens.
- User-authored field names and linked record display values. Those stay raw in every locale.

## Labels

T3B3 creates `meta-link-picker-labels.ts` for modal-owned static chrome:

| Key | EN | ZH |
|---|---|---|
| `linkPicker.selected` | Selected | 已选择 |
| `linkPicker.clear` | Clear | 清除 |
| `linkPicker.loading` | Loading... | 正在加载... |
| `linkPicker.empty` | No records found | 未找到记录 |
| `linkPicker.loadMore` | Load more | 加载更多 |
| `linkPicker.cancel` | Cancel | 取消 |
| `linkPicker.confirm` | Confirm | 确认 |
| `linkPicker.close` | Close link picker | 关闭关联记录选择器 |
| `linkPicker.errorLoad` | Failed to load records | 加载记录失败 |

Helper:

- `selectedCount(n, isZh)` returns `${n} selected` in English and `已选择 ${n} 条` in zh-CN.

`link-fields.ts` keeps the picker title/search helper names and adds an optional locale parameter:

| Helper branch | EN | ZH |
|---|---|---|
| `linkPickerTitle(personField, false)` | `Select People — {field.name}` | — |
| `linkPickerTitle(personField, true)` | — | `选择人员 — {field.name}` |
| `linkPickerTitle(linkField, false)` | `Link Records — {field.name}` | — |
| `linkPickerTitle(linkField, true)` | — | `选择关联记录 — {field.name}` |
| `linkPickerSearchPlaceholder(personField, false)` | Search people... | — |
| `linkPickerSearchPlaceholder(personField, true)` | — | 搜索人员... |
| `linkPickerSearchPlaceholder(linkField, false)` | Search records... | — |
| `linkPickerSearchPlaceholder(linkField, true)` | — | 搜索记录... |

Field names remain raw user data, including Chinese-authored names.

## Component Wiring

`MetaLinkPicker.vue` imports `useLocale`, `linkPickerLabel`, and the new selected-count helper.

- `titleText = linkPickerTitle(props.field, isZh.value)`
- `searchPlaceholder = linkPickerSearchPlaceholder(props.field, isZh.value)`
- selected header/clear/loading/empty/load-more/cancel/confirm use `linkPickerLabel`.
- footer count uses `selectedCount(selected.size, isZh.value)`.
- close button keeps the `×` glyph but gains localized `aria-label`.
- `error?.message` stays raw. Only the component-owned fallback for non-Error throws uses `linkPicker.errorLoad`.

## Acceptance

- Existing picker behavior remains unchanged: open resets selection from `currentValue`, clear+confirm emits an empty array, person fields remain single-select.
- English remains the default for helpers when no `isZh` argument is passed.
- zh-CN render covers title/search, selected header, count, clear, empty, load-more, footer actions, close aria, and fallback load error.
- No API, backend, migration, `attendance_*`, or direct `meta_*` change.
