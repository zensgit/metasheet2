# Multitable Final Gate Fixes Development

Date: 2026-04-07
Branch: `codex/multitable-pilot-gate-admin-users-20260407`

## Scope

This slice only fixes issues uncovered while running the final local delivery gates for the multitable pilot / on-prem line.

## Changes

1. Mounted the admin users router in the backend server bootstrap so `/api/admin/users` and related admin user endpoints are reachable at runtime.
2. Added an integration test that boots `MetaSheetServer` and asserts `/api/admin/access-presets` is served for an admin dev token.
3. Updated `multitable-view-config.api.test.ts` SQL mocks to reflect the current sheet ACL queries and the pre-delete `meta_views` lookup.
4. Updated `scripts/ops/multitable-pilot-ready-local.sh` so the grid profile stage builds and reuses a `vite preview` instance instead of profiling a cold dev-server startup path.

## Rationale

The delivery gates were blocked by three different classes of issues:

- a real runtime omission: admin user routes existed but were not mounted
- backend integration test drift after the sheet ACL work
- a local performance harness artifact, where `ui.grid.open` was measuring cold startup cost instead of real grid-open latency

The scope was intentionally kept narrow to unblock final delivery verification without extending the ACL model or changing product behavior beyond the missing route mount.
