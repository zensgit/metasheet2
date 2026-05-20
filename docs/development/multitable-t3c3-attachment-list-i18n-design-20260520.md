# T3C3 - Attachment List i18n Design

- **Date**: 2026-05-20
- **Type**: small implementation slice
- **Status**: implemented; paired verification in `docs/development/multitable-t3c3-attachment-list-i18n-verification-20260520.md`
- **Preceded by**:
  - `docs/development/multitable-t3c-import-modal-i18n-design-20260520.md`
  - `docs/development/multitable-t3c2-base-picker-i18n-design-20260520.md`
- **Goal**: localize `MetaAttachmentList.vue` chrome while preserving attachment filenames, URLs, thumbnails, removal events, and caller-controlled empty labels.

## Scope

This slice covers the shared attachment-list component only:

| Surface | Localized |
|---|---|
| Image preview title | `Preview <filename>` / `预览 <filename>` |
| Remove button title | `Remove <filename>` / `移除 <filename>` |
| Lightbox original-file link | `Open original` / `打开原文件` |
| Lightbox close aria label | `Close attachment preview` / `关闭附件预览` |

## Boundaries

Out of scope:

- Attachment upload, delete, previewability, thumbnail selection, URL opening, and Teleport/lightbox behavior.
- Backend, API routes, OpenAPI, migrations, `attendance_*`, or direct `meta_*` writes.
- User data: attachment filenames, URLs, thumbnails, MIME-derived icons, and caller-provided `emptyLabel` remain raw.
- Attachment editor, import repair flows, and broader record-drawer chrome.

## Implementation Notes

- Added `apps/web/src/multitable/utils/meta-attachment-labels.ts` as a tiny per-surface label module.
- `MetaAttachmentList.vue` now reads `useLocale().isZh` and calls:
  - `attachmentLabel(...)` for static lightbox copy.
  - `previewAttachmentTitle(filename, isZh)` for preview button titles.
  - `removeAttachmentTitle(filename, isZh)` for removable attachment titles.
- The label helpers interpolate filenames without translating or normalizing them.

## Acceptance

- zh-CN renders localized attachment-list chrome.
- English/default locale remains backward-compatible.
- Attachment filenames remain raw in titles and lightbox content.
- Existing image preview, original-link, and remove event behavior remain unchanged.
