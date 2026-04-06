# Multitable Sheet ACL Summary/Link Options Development

## Scope
- Extend sheet ACL read parity to:
  - `GET /api/multitable/records-summary`
  - `GET /api/multitable/fields/:fieldId/link-options`
- Keep the slice read-only. No write-path, manager-surface, or attachment changes.

## Changes
- Replaced route-level `rbacGuard('multitable', 'read')` on the two target endpoints with route-local readable-scope checks in [univer-meta.ts](/private/tmp/metasheet2-read-summary-link-options-20260406/packages/core-backend/src/routes/univer-meta.ts).
- Reused the existing `resolveSheetReadableCapabilities()` helper so callers with no global `multitable:read` can still read when they have:
  - `spreadsheet:read`
  - `spreadsheet:write-own`
- For `link-options`, readable scope is enforced on both:
  - the source sheet that owns the link field
  - the foreign target sheet whose records are being listed
- Added integration coverage in [multitable-sheet-permissions.api.test.ts](/private/tmp/metasheet2-read-summary-link-options-20260406/packages/core-backend/tests/integration/multitable-sheet-permissions.api.test.ts) for:
  - positive `records-summary` read-grant access
  - positive `link-options` read-grant access
  - existing negative tests remain unchanged

## Notes
- This does not change `/attachments/:attachmentId`; attachment download ACL remains a separate slice.
- `write-own` only widens read eligibility here. It does not unlock writes, import/export, or field/view management.
