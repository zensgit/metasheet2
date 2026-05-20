# T3C - Import Modal i18n Design

- **Date**: 2026-05-20
- **Type**: small implementation slice
- **Status**: implemented; paired verification in `docs/development/multitable-t3c-import-modal-i18n-verification-20260520.md`
- **Preceded by**:
  - `docs/development/multitable-t3b3-link-picker-i18n-design-20260520.md`
  - `docs/development/multitable-t3b4-alt-view-comment-chip-i18n-design-20260520.md`
- **Goal**: localize the record import modal chrome without changing import behavior, parsing, repair flow, or backend contracts.

## Scope

This slice covers `MetaImportModal.vue` only:

| Area | Localized |
|---|---|
| Paste step | title, hint, file drop copy, placeholder, cancel/preview buttons |
| Preview step | restored-draft banner, detected-row hint, skip option, reconcile action, back/import buttons, overflow row count |
| Importing step | progress text and cancel-import button |
| Result/repair step | success/warning summary, failed-row guidance, row/fix labels, empty-row fallback, repair actions, close button |
| Frontend-owned fallback errors | no rows, file too large, read fallback, spreadsheet empty, truncated XLSX warning |
| Linked-record repair button | `linkActionLabel(field, count, isZh.value)` |

## Boundaries

Out of scope:

- Import parsing, XLSX mapping, record building, retry behavior, draft persistence, and link picker data fetching.
- Backend, API routes, OpenAPI, migrations, attendance tables, and direct `meta_*` writes.
- User-authored data: imported headers, cell values, field names, selected linked-record display values, option values, file contents, and backend/import failure messages remain raw.
- Full field/view manager i18n and broader workbench chrome beyond the import modal.

## Implementation Notes

- Added `apps/web/src/multitable/utils/meta-import-labels.ts` as a per-surface label module, matching the existing T3B modules.
- `MetaImportModal.vue` now reads `useLocale().isZh` and uses:
  - `importLabel(...)` for static copy.
  - helper functions for count/field-name interpolation.
  - raw interpolation for field names, imported data, and failure messages.
- The modal now passes locale into `linkActionLabel`, while the helper's default remains English for legacy callers that intentionally omit the third argument.

## Acceptance

- zh-CN renders localized import modal chrome across paste, preview, importing, and result/repair states.
- English/default locale remains backward-compatible.
- Imported table data and backend failure strings are not translated.
- The existing import flow and picker repair behavior remain unchanged.
