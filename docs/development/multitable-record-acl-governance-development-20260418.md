# Multitable Record ACL Governance Development

## Summary
- Built the next stacked slice on top of member-group ACL subjects by making record-level permission governance usable in the UI.
- Replaced raw `subjectId` entry for record grants with searchable permission candidates sourced from existing multitable sheet subjects.
- Hydrated record permission entries with human labels so current record grants show real people, member groups, and roles instead of bare IDs.

## Why This Slice
- The previous slice made `member-group` a valid multitable ACL subject.
- Record-level governance was still awkward because administrators had to type opaque subject IDs by hand.
- This slice makes row-level ACL practical for the same subject universe:
  - people
  - member groups
  - roles

## Runtime Changes

### Frontend Types And Client
- Extended `RecordPermissionEntry` to carry:
  - `label`
  - `subtitle`
  - `isActive`
- Added client-side normalization for hydrated record permission entries:
  - `apps/web/src/multitable/types.ts`
  - `apps/web/src/multitable/api/client.ts`

### Record Permission Manager
- Reworked `MetaRecordPermissionManager`:
  - removed raw free-text `subjectId` grant flow
  - added candidate search input
  - loads grant candidates from:
    - current sheet permission entries
    - existing sheet permission candidates
  - groups grant candidates into:
    - people
    - member groups
    - roles
  - filters out subjects that already have record-specific entries
- Current record entries now render:
  - hydrated label
  - subtitle
  - subject-type badge
- File:
  - `apps/web/src/multitable/components/MetaRecordPermissionManager.vue`

### Backend Record Permission Listing
- Extended `GET /api/multitable/sheets/:sheetId/records/:recordId/permissions` to hydrate subjects via joins against:
  - `users`
  - `roles`
  - `platform_member_groups`
- The record permission list response now includes:
  - `label`
  - `subtitle`
  - `isActive`
- File:
  - `packages/core-backend/src/routes/univer-meta.ts`

## Governance Semantics
- Record-level ACL still uses the existing access levels:
  - `read`
  - `write`
  - `admin`
- This slice does not widen access semantics; it only improves subject selection and current-entry visibility.
- Candidate sourcing intentionally follows the existing sheet ACL governance universe instead of inventing a second subject directory for record permissions.

## Test Updates
- Frontend:
  - `apps/web/tests/multitable-record-permission-manager.spec.ts`
- Backend:
  - `packages/core-backend/tests/integration/multitable-sheet-permissions.api.test.ts`

## Out Of Scope
- No field/view permission UX redesign in this slice
- No new member-group projection logic
- No cell-level ACL
- No deployment or migration changes
