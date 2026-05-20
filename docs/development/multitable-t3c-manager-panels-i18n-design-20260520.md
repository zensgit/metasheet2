# Multitable T3C Manager Panels I18n Design

Date: 2026-05-20

Branch: `codex/multitable-t3c-manager-panels-i18n-20260520`

## Scope

This slice localizes the first T3C manager-panel surface:

- `apps/web/src/multitable/components/MetaFieldManager.vue`
- `apps/web/src/multitable/components/MetaFieldValidationPanel.vue`
- `apps/web/src/multitable/components/MetaViewManager.vue`

The shared chrome strings live in:

- `apps/web/src/multitable/utils/meta-manager-labels.ts`

Field type display labels remain centralized in the T3A1 helper:

- `apps/web/src/multitable/utils/meta-core-labels.ts`

## Goals

1. Render field manager chrome in `zh-CN` while keeping English as the default locale.
2. Render view manager chrome in `zh-CN` while keeping English as the default locale.
3. Render field validation panel chrome in `zh-CN`.
4. Preserve user-authored data exactly as entered: field names, view names, sheet names, formulas, field IDs, MIME examples, and persisted enum values are not translated.
5. Keep existing event payloads, persistence shape, and validation behavior unchanged.

## Implementation

`meta-manager-labels.ts` follows the existing multitable i18n pattern: a small local helper maps stable keys to English and Chinese display strings and exposes helper formatters for dynamic manager copy.

Field type names are deliberately not duplicated in this helper. T3C extends and reuses `fieldTypeLabel()` from `meta-core-labels.ts` so the toolbar filter/group panels and field manager show the same user-facing terms. Existing T3A1 overlapping labels are preserved, including `boolean` -> `checkbox` / `复选框`, `string` -> `text` / `文本`, and `multiSelect` -> `multi-select` / `多选`.

The helper covers:

- Common manager actions: configure, rename, move, delete, cancel, reload, dismiss.
- Field manager labels, config labels, duplicate-name copy, delete confirmation, and blocking/warning copy.
- View manager labels, type labels, config labels, filter/sort/group labels, warning copy, and delete confirmation.
- Field validation labels for required, min/max, pattern, enum restriction, and preview.
- Additional field types needed by the field manager, added to `meta-core-labels.ts`: link, person, lookup, rollup, formula, attachment, currency, percent, rating, URL, email, phone, barcode, location, auto number, created time, modified time, created by, and modified by.

The components read `useLocale().isZh` and call the shared helper at render time. This keeps locale changes reactive and avoids duplicating labels across panels.

## Boundaries

Out of scope for this slice:

- Permission manager, share/form share manager, API manager, automation panels, import modal, and conditional-formatting dialog internals.
- Backend/API/OpenAPI changes.
- Data migrations.
- Formula catalog descriptions and function signatures.
- User-authored field/view/sheet names.
- Stored field type, view type, filter operator, aggregation, and config enum values.

## Regression Strategy

The new `multitable-manager-panels-i18n.spec.ts` asserts:

- `zh-CN` field manager chrome is rendered.
- `zh-CN` view manager chrome is rendered.
- `zh-CN` field validation chrome is rendered.
- Authored names remain raw in localized chrome.
- English manager chrome remains the default.

Existing field manager, view manager, and validation panel specs are kept in the verification set to prove behavior and emitted payloads remain unchanged.
