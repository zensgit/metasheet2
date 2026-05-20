# T3C2 - Base Picker i18n Design

- **Date**: 2026-05-20
- **Type**: small implementation slice
- **Status**: implemented; paired verification in `docs/development/multitable-t3c2-base-picker-i18n-verification-20260520.md`
- **Preceded by**:
  - `docs/development/multitable-t3c-import-modal-i18n-design-20260520.md`
- **Goal**: localize `MetaBasePicker.vue` chrome while preserving base names, icons, ordering, selection, create, and favorite behavior.

## Scope

This slice covers the base switcher only:

| Surface | Localized |
|---|---|
| No active base fallback | `Select Base` / `选择多维表` |
| Search input | placeholder |
| Base badges | favorite and recent badges |
| Favorite toggle | aria-label, with base name interpolated raw |
| Empty state | no matching bases |
| Create input | placeholder |

## Boundaries

Out of scope:

- Workbench routing, base loading, favorite persistence, recent ordering, and create/select event behavior.
- Backend, API routes, OpenAPI, migrations, `attendance_*`, or direct `meta_*` writes.
- User data: base names and icons remain raw.
- Larger manager surfaces such as field/view/permission managers.

## Implementation Notes

- Added `apps/web/src/multitable/utils/meta-base-picker-labels.ts` as a small per-surface label module.
- `MetaBasePicker.vue` now reads `useLocale().isZh` and calls:
  - `basePickerLabel(...)` for static copy.
  - `favoriteAriaLabel(base.name, base.isFavorite, isZh)` for favorite toggle aria text.
- This also fixes the pre-existing mixed-locale default where English UI showed Chinese `收藏` / `最近打开` badges. Default English now renders `Favorite` / `Recent`; zh-CN preserves `收藏` / `最近打开`.

## Acceptance

- zh-CN renders localized picker chrome.
- English/default locale renders English picker chrome.
- Base names and icons are not translated.
- Favorite toggle remains click-isolated and does not select the base.
- No BasePicker event payloads or local-state helpers changed.
