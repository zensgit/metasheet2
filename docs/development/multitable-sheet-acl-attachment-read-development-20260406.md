# Multitable Sheet ACL Attachment Read Development

Date: 2026-04-06

## Scope

- Extend sheet ACL read parity to `GET /api/multitable/attachments/:attachmentId`.
- Reuse existing sheet-readable capability resolution instead of adding a route-specific ACL path.
- Keep attachment delete and all write surfaces unchanged.

## Changes

### Backend route

- Updated [univer-meta.ts](/private/tmp/metasheet2-attachment-read-parity-20260406/packages/core-backend/src/routes/univer-meta.ts) so attachment download no longer depends on route-level `rbacGuard('multitable', 'read')`.
- Attachment lookup now reads `sheet_id` in the primary `multitable_attachments` query.
- The route now resolves access with `resolveSheetReadableCapabilities(...)`.
- Authenticated users with sheet-scoped `spreadsheet:read` or `spreadsheet:write-own` can download attachments even when they do not hold global `multitable:read`.
- Unauthenticated requests now match the rest of the read-parity surfaces and return `401`.

### Integration coverage

- Extended [multitable-attachments.api.test.ts](/private/tmp/metasheet2-attachment-read-parity-20260406/packages/core-backend/tests/integration/multitable-attachments.api.test.ts).
- Added a narrow mocked storage path for download-only parity tests so the slice can verify ACL behavior without requiring global write/read just to seed files.
- Added coverage for:
  - sheet `spreadsheet:read` grant can download
  - sheet `spreadsheet:write-own` grant can download
  - non-readable sheet grant is still rejected

## Notes

- This slice intentionally does not change attachment upload/delete semantics.
- This slice intentionally does not widen any write path or manager surface.
