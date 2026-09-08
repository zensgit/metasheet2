# Attendance record/calendar tenant boundary repair

Status: locally verified repair / not published; full-app acceptance remains incomplete.

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
- Real database records/calendar matrix: PASS twice with Node 20.20.2 and
  private PostgreSQL 15. Each invocation ran the new real-login identity test,
  then the whole `attendance-plugin.test.ts`: 166/166 PASS. The second run
  includes the cleanup-error reporting adjustment described below. Each private
  cluster was stopped and removed, with zero backend/port/database residue.
- Exact combined `1bbf1efd27f86dac27e71a133c7a4ec1db7b40bf` full-app baseline:
  PASS. Real login, catalog sync, record sync, grid proposal, review/apply and
  Reports return succeed; foreign canary returns 403, zero rows, no exact canary
  match, and the login actor has no foreign membership. Revoked apply is 403
  with an unchanged data snapshot. Cleanup: databases/backends/ports=0.
- Backend `tsc --noEmit`: PASS; this configured check excludes tests and is not
  claimed as test-file type coverage. `git diff --check`: PASS.
- Dedicated unit lint: zero errors/warnings. Owning integration-file lint:
  zero errors, 169 pre-existing warnings (base has the same warning count).
  Explicit `--no-ignore --parser-options '{"project":null}'` was necessary:
  repository lint normally ignores tests and its TS project excludes them.
  This is a syntax/rule lint check, not type-aware test checking. The initially
  introduced `no-unsafe-finally` error was fixed by collecting verification and
  cleanup failures and throwing after cleanup, preserving both error classes.

## Exact local evidence and commands

Product checkpoint: `48a613b9ba5b6e6addddfd814bee8e021413ce6c`.
Combined verification adds a true merge of frozen #5559
`5f006a9e0cc4ba5dce2e7f2b77495f0452cf3ada`, then cherry-picks the three-file
full-app checkpoint `fcbca50df546bdaf7430694ff8306d335ef546d5`.
The inherited three #5559 files were verified byte-equivalent. No combined
test assets belong in this five-file repair PR. The subsequent change only
adjusts the dedicated test's error reporting, not the verified runtime bytes.

Commands (Node 20, backend working directory; DB URLs supplied exclusively by
the owned private-cluster harness):

```sh
vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t 'pins attendance records and calendar reads'
vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts
tsc --noEmit
eslint --no-ignore --parser-options '{"project":null}' tests/unit/attendance-record-read-identity.test.ts tests/integration/attendance-plugin.test.ts
```

Local ignored evidence directories:
`tmp/p1-integration-9451d2390aa743d09211b97c8b2db88b` (first pass),
`tmp/p1-integration-a6651225668f4985a3a78575198ec493` (final test adjustment).
The combined full-app screenshots are in
`tmp/acp-full-64b7b2736c894193b7770d91b7709e7f` in the separate combined worktree.
They contain only synthetic fixture values, not customer records. The narrow
Inspector and desktop Reports screenshots were visually inspected; the latter
shows Normal=1 and Late=0 but does not itself frame the detailed record row.

## Remaining delivery and acceptance boundaries

Remote-main readback moved to `2794494f0258835911186fc976fa4f4089ed72c8` during
local verification. Pre-publication reconciliation completed as true merge
`eebec391c05a7e50e0e70d89a033b836fd5f3968`, ordered parents
`977105772c3237d15d7a2d82bfcf3e7f4f7cffd5` then that exact main. Its 15
stock-preparation changes do not overlap the five repair paths; those five
paths were byte-equivalent to the verified checkpoint. Post-merge identity
unit tests pass 58/58; backend typecheck and diff-check pass. The 166/166 and
combined canary evidence are inherited by runtime/test byte equivalence, not
misreported as additional database reruns. Open attendance PR review found no
second implementation of this tenant-read repair. Publication/readback pending.
Full-app custom-field preservation, repeat controls, API-error classification,
final screenshots and complete verification remain separate unfinished work;
this repair's baseline pass must not be called full application UAT acceptance.

The five-file product repair must be published separately from full-app test
assets. Exact product and combined-test commits will be recorded after those
checkpoints exist. No Ready/merge/dispatch/deployment/production authorization.
