# DingTalk Form Allowlist Active Users Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-form-allowlist-active-users-20260422`
- Scope: backend protected public-form allowlist validation

## Goal

Close the backend/API gap for DingTalk-protected public-form allowlists.

The frontend allowlist picker already marks inactive local users as unavailable. Before this slice, a direct API caller could still patch a protected form share config with an inactive local user ID in `allowedUserIds`.

## Implementation

- Updated the `PATCH /api/multitable/sheets/:sheetId/views/:viewId/form-share` route to load `users.is_active` while validating `allowedUserIds`.
- Kept the existing unknown-user rejection behavior.
- Added a new validation error for inactive allowed users:
  - `Inactive allowed users: <ids>`
- Added integration coverage for rejecting inactive local users before the form share config is persisted.
- Updated DingTalk operations and capability docs to document the active-user constraint.

## Files

- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/tests/integration/public-form-flow.test.ts`
- `docs/dingtalk-admin-operations-guide-20260420.md`
- `docs/dingtalk-capability-guide-20260420.md`

## Notes

- This does not change public-form submission semantics.
- This does not change member-group allowlists.
- This aligns direct API behavior with the existing frontend picker guardrail.
