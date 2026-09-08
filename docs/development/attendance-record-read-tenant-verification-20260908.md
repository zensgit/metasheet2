# Attendance record/calendar tenant boundary repair

Status: IMPLEMENTING / not accepted or published.

Base: `bf48046781704406246cac3bb8293dad27b94375`.
The new empty branch was fast-forwarded from `17173f639` after a remote-main
race, before product edits. The intervening five approval CI/test paths did not
overlap this repair. The independent full-app worktree and its original canary
RED remain preserved.

## Authority and scope

The owner-authorized full-app objective requires same-organization isolation.
The coordinator explicitly approved this bounded P1 repair after a real login,
Reports UI and private-DB canary proved foreign-row disclosure. ACP-1B OD-ATC-12A
defines same-org apply authority, but is not claimed to specify every read API.

Only the common GET records/calendar handler changes. Global getOrgId,
withPermission, shared auth, schema, roles and flags are unchanged. The helper
reads hydrated `req.user.id` and `req.authenticatedTenantId`. JWT middleware
sets the latter before a legacy header fallback may modify `user.tenantId`;
therefore `user.tenantId` must never fill missing authenticated tenant context.
Present org selectors must be exact strings equal to the authenticated tenant.
Headers cannot establish identity. Same-org query.userId remains a target
subject to existing other-user permissions, not an actor override.

Missing actor: 401. Missing/conflicting tenant or selector: 403, fixed error
code/message without supplied values. No platform-admin cross-tenant exception.

## Evidence so far

- Original real full-app canary: status 200, one foreign row, exact canary match,
  login actor foreign membership count zero. All data belonged to the private
  invocation; cleanup databases/backends/ports=0.
- Unit suite: 58/58 PASS under Node 20, default backend discovery.
- Discriminating mutation: remove selector/tenant equality while retaining type
  validation; 6 foreign-selector tests FAIL, 52 PASS. Helper restored afterward.
- Real database records/calendar matrix: pending.
- Original full-app canary on exact combined candidate: pending.
- Full integration, typecheck/lint, final mutation and publication: pending.

The five-file product repair must be published separately from full-app test
assets. Exact product and combined-test commits will be recorded after those
checkpoints exist. No Ready/merge/dispatch/deployment/production authorization.
