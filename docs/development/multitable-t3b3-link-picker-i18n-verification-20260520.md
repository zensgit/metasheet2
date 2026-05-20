# T3B3 — Link Picker i18n Verification

- **Date**: 2026-05-20
- **Scope**: `MetaLinkPicker.vue`, `link-fields.ts` picker helper branches, and the new `meta-link-picker-labels.ts` label module.
- **Design packet**: `docs/development/multitable-t3b3-link-picker-i18n-design-20260520.md`
- **Status**: implemented and locally verified.

## Implementation Summary

- Added `apps/web/src/multitable/utils/meta-link-picker-labels.ts` for picker-owned static chrome and selected-count formatting.
- Extended `linkPickerTitle(field, isZh = false)` and `linkPickerSearchPlaceholder(field, isZh = false)` while preserving English defaults for existing callers.
- Wired `MetaLinkPicker.vue` to `useLocale()` for:
  - title and search placeholder,
  - selected header / clear,
  - loading / empty / load more,
  - footer count / cancel / confirm,
  - close button aria-label,
  - FE-owned fallback load error.
- Preserved raw data: field names, linked record display labels, record IDs, and backend/API error messages remain untranslated.

## Boundary Check

| Area | Result |
|---|---|
| Backend/API | Not touched |
| Link picker payload / confirm semantics | Not changed |
| `attendance_*` / migrations | Not touched |
| `meta_*` direct writes | Not touched |
| `MetaImportModal.vue` | Not touched |
| `MetaCellEditor.vue` unreachable link fallback comment | Not touched |

## Test Coverage Added

| File | Coverage |
|---|---|
| `apps/web/tests/meta-link-picker-labels.spec.ts` | Picker static keys and selected-count helper |
| `apps/web/tests/link-fields-i18n.spec.ts` | Title/search helpers in EN and zh-CN, absent-field fallback, raw field names |
| `apps/web/tests/meta-link-picker-i18n.spec.ts` | zh-CN record/person picker chrome, empty/fallback-error states, English regression |

## Verification Commands

```bash
NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/link-fields-i18n.spec.ts \
  tests/meta-link-picker-labels.spec.ts \
  tests/meta-link-picker-i18n.spec.ts \
  tests/multitable-link-picker.spec.ts \
  tests/meta-record-drawer-i18n.spec.ts \
  tests/meta-form-view-i18n.spec.ts \
  tests/meta-cell-editor-i18n.spec.ts \
  tests/meta-comments-drawer-i18n.spec.ts \
  tests/meta-comment-composer-i18n.spec.ts --watch=false
```

Result: PASS, 62 tests across 9 files.

```bash
pnpm --filter @metasheet/web type-check
```

Result: PASS.

```bash
pnpm --filter @metasheet/web build
```

Result: PASS. Vite emitted existing chunk-size / dynamic-import warnings only.

```bash
git diff --check
```

Result: PASS.

## Acceptance Notes

- Record-link picker title/search zh-CN: `选择关联记录 — {field.name}` / `搜索记录...`.
- Person picker title/search zh-CN: `选择人员 — {field.name}` / `搜索人员...`.
- Field names remain raw, including Chinese-authored field names.
- Selected count uses `${n} selected` in English and `已选择 ${n} 条` in zh-CN.
- API error messages are raw; only the component fallback for non-Error throws localizes to `加载记录失败`.
