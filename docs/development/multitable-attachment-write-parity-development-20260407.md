# Multitable Attachment Write Parity Development

Date: 2026-04-07
Branch: `codex/multitable-attachment-write-parity-20260407`

## Scope

This slice removes the remaining global `multitable:write` hard gate from multitable attachment write routes and aligns them with sheet-scoped permissions.

Routes covered:

- `POST /api/multitable/attachments`
- `DELETE /api/multitable/attachments/:attachmentId`

## Runtime changes

- Removed route-level `rbacGuard('multitable', 'write')` from attachment upload and delete.
- Kept the existing sheet capability checks based on `resolveSheetCapabilities(...)`.
- Preserved record-level ownership checks for bound attachments through `ensureRecordWriteAllowed(...)`.
- Added a draft attachment delete guard:
  - `spreadsheet:write` can delete any draft attachment in the sheet.
  - `spreadsheet:write-own` can delete a draft attachment only when `multitable_attachments.created_by` matches the current actor.

## Test coverage added

- upload allowed with sheet `spreadsheet:write` and no global multitable permission
- upload allowed with sheet `spreadsheet:write-own` and no global multitable permission
- delete allowed with sheet `spreadsheet:write` and no global multitable permission
- draft delete allowed with sheet `spreadsheet:write-own` when the attachment creator matches
- draft delete rejected with sheet `spreadsheet:write-own` when the attachment creator differs

## Notes

- This slice does not change sheet/base/share authoring surfaces.
- This slice does not broaden schema-management permissions.
- Local `pnpm install` updated plugin `node_modules` links in the worktree; those changes are intentionally excluded from commit scope.
