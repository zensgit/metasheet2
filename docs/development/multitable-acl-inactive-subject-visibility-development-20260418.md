# Multitable ACL Inactive Subject Visibility Development 2026-04-18

## Goal

Surface inactive users directly inside the multitable ACL management UI so operators can distinguish live governance subjects from disabled identities without inspecting another admin page.

## Scope

- show `Inactive user` on sheet ACL rows and candidate results when the subject is a disabled user
- show `Inactive user` on record ACL rows and candidate results for the same case
- keep the slice frontend-only and reuse the existing `isActive` data already returned by the APIs

## Files Changed

- `apps/web/src/multitable/components/MetaSheetPermissionManager.vue`
- `apps/web/src/multitable/components/MetaRecordPermissionManager.vue`
- `apps/web/tests/multitable-sheet-permission-manager.spec.ts`
- `apps/web/tests/multitable-record-permission-manager.spec.ts`

## Implementation Notes

1. Added a lightweight `subjectIsInactive(...)` helper in both managers.
2. Rendered an inline `Inactive user` lifecycle pill only when:
   - `subjectType === 'user'`
   - `isActive === false`
3. Kept role and member-group rendering unchanged.
4. Reused existing hydrated entry/candidate payloads instead of changing backend contracts.

## Why This Slice

Current multitable ACL APIs already hydrate `isActive`, but the management UI did not expose it. That created a governance blind spot: disabled users looked the same as active users in sheet and record permission surfaces, which made stale access review harder than necessary.
