# Attendance-admin role revocation atomicity — A1

Date: 2026-10-14. Owned worktree: `admin-issues-20261014/metasheet2`.
Worktree HEAD at edit: `a6e84bf754e0`. It contains `1ea63964ef62dc3cb74102d22cc1c9d8f7961260`.
Scope: actionable A1 in `artifacts/admin-issues-20261014/sol-atomicity-independent-review.md`.

This is an uncommitted route repair, not native qualification or bounded R2/R3 closure.
The reviewed admin-users lock and witness stay as they are. No runtime, PostgreSQL cluster,
install, SSH, customer document, network call, commit, push, pull request or deployment
was started by this slice.

## Contract and implementation

Both attendance-admin unassign entries already opened one transaction, resolved the caller
scope, and refused ineligible targets before `unassignUserRoles`. They did not take
`lockNamespaceAdmissionWrites` and did not call `disableNamespaceAdmissionsWithoutRoles`.
That left the same missing-row and in-flight INSERT window the admin-users entries already
close.

Inside that existing transaction, after the scope and eligible-target checks and before the
membership DELETE:

- The single entry locks `namespace-admission:<userId>`, deletes through `unassignUserRoles`
  on the transaction client, then writes the revoke witness.
- The batch entry copies the requested target ids, sorts that copy, and locks every target
  before any membership DELETE. It then deletes once for the original id list. Each witness
  runs on that same client and returns before the callback returns. The pool commits only
  after the callback resolves, so every witness is inside the transaction.
- Each witness passes `source: 'role_unassigned'`, `revokedRoleId` equal to the role being
  removed, and `namespaces` from `listRoleNamespaces(roleId, client.query)`. The second
  argument is `client.query`, not the pool `query`.
- A witness or DELETE error still leaves the callback. The existing pool wrapper rolls the
  transaction back. `sendIfRecoveryConflict` still maps the recovery-authority marker to
  retryable 409. Any other error keeps `ROLE_UNASSIGN_FAILED` or `BATCH_ROLE_UNASSIGN_FAILED`.

Actor, delegated, and org target guards are unchanged. Org scope still throws
`ORG_SCOPED_ROLE_WRITE_UNAVAILABLE` before the lock. An out-of-scope role id still returns
403 before a transaction starts. A missing or inactive target still returns 404 before the
lock. Responses, post-commit `auditDelegatedAdminScopeCleanup`, and the single-entry
permission readback are unchanged. This route does not call `invalidateUserPerms`; cache
invalidation remains the separately owned service work and was not edited.

No admission enablement, flag, migration, or general RBAC refactor was added. Assign routes
were not changed. `unassignUserRoles` remains an inline call with
`scope: roleWriteScope` derived from `deriveAttendanceRoleAssignmentScope(scope)` at each of
the four existing writer sites.

## Exact changed files

| File | Change |
| --- | --- |
| `packages/core-backend/src/routes/attendance-admin.ts` | Lock and revoke witness on the existing single and batch unassign transactions. |
| `packages/core-backend/tests/unit/attendance-admin-role-revocation-atomicity.test.ts` | New route-call coverage. Handlers are invoked. Source text is not the oracle. |
| `docs/development/attendance-admin-role-revocation-atomicity-development-verification-20261014.md` | This note. |

Frontend, service, and cache files owned by the other Grok session were not edited.
`admin-users.ts`, `namespace-admission.ts`, `AuthService.ts`, CI workflows, and the existing
admin-users revocation note were not edited.

## Route-call coverage in the new unit file

The cases call the registered POST handlers with a transaction double. The real
`lockNamespaceAdmissionWrites`, `listRoleNamespaces`, and
`disableNamespaceAdmissionsWithoutRoles` helpers run against that double.

- Scope deny with no mutation: out-of-scope role id (no transaction), org-scoped caller,
  missing target, non-admin global actor, and unauthenticated actor. No lock, DELETE,
  witness, or commit.
- Single ordering and client identity: begin, target resolve, lock, DELETE, role-namespace
  read, remaining-role read, witness, profile, commit. Lock key, role id, and witness
  parameters are `namespace-admission:user-1`, `attendance_employee`, and
  `[user-1, attendance, role_unassigned, admin-1, false]`. Those statements are on the
  transaction client. The response shape is unchanged.
- Batch ordering, client identity, and deterministic locks: request order
  `user-z`, `user-a`, `user-m` locks and writes witnesses as `user-a`, `user-m`, `user-z`.
  The DELETE and `affectedUserIds` keep the request order. The last witness is before commit.
- Witness failure: a `23514` witness error rolls the callback back, does not commit, and
  returns the existing 500 code for that entry.
- Recovery 409: the single entry raises the recovery marker on DELETE after the lock; the
  batch entry raises it on the witness INSERT. Both return the uniform retryable 409 and
  do not commit.

An empty `role_permissions` read is intentional. The attendance witness row is produced only
when `revokedRoleId` is `attendance_employee`, which is the real helper's opt-out rule.

## Executed local checks

1. `git diff --check` on the route and the new unit file: PASS (no whitespace errors).
2. Node `v25.9.0` `stripTypeScriptTypes(..., { mode: 'transform' })`: the route and the new
   unit file parsed. This is syntax checking, not a TypeScript type check.
3. Static writer-shape count on the route source: 4 `assignUserRoles` / `unassignUserRoles`
   calls, 4 `roleWriteScope` bindings, each binding
   `deriveAttendanceRoleAssignmentScope(scope)`, 2 lock sites, 2 witness sites, 2
   `listRoleNamespaces` sites, 0 `grantNamespaceAdmissions` sites.

Vitest, PostgreSQL, HTTP, browser, CI, and typecheck were not run.

## Pending parent qualification

| Gate | Status |
| --- | --- |
| New route unit file, plus the existing attendance boundary and recovery-census neighbors | Not run here |
| Admin-users 295-unit, 11-PG, 3-register, and migrated API receipts | Prior parent evidence for the other entries. They do not exercise these handlers |
| No-row revoke followed by verifyToken / fresh login on these two entries | Pending parent API |
| Deferred eligible bootstrap versus an attendance-admin revoke witness | Pending parent PostgreSQL |
| CI wiring, full typecheck, runtime, artifacts, final review | Parent-owned. Not claimed |

Suggested parent command, using the already-owned toolchain:

```sh
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-admin-role-revocation-atomicity.test.ts tests/unit/role-assignment-boundary.test.ts tests/unit/recovery-conflict-surfaces-routes-rbac.test.ts
```

Bounded R2/R3 completion is not claimed. A1 is implemented in the two attendance-admin
unassign entries only.

## Parent follow-up qualification — d7be3a83a2

Frozen source `d7be3a83a217875187fd6edcebe3b9a1177da5ff` matched the Mac full tree and changed-path digests. Targeted backend10files331tests, frontend4files137tests, native revocation11tests and registration3tests passed with zero failures/skips. The earlier frontend fixture timing failures were corrected by waiting for rendered selected-subject detail, without changing the product behavior.

Sol independent bounded A1 review passed source inspection at this SHA. Full442-migration synthetic real-auth API exercised attendance-admin single and batch unassign: absent-row witness persisted, old-token verification and fresh login did not re-add membership, non-admin other-subject write returned403 without mutation. A real PostgreSQL trigger failed the last sorted batch witness with23514; both membership deletes and the earlier witness rolled back physically. After removing this synthetic-only trigger, batch success and both subjects' next-auth/fresh-login checks passed. See `artifacts/admin-issues-20261014/sol-attendance-unassign-a1-review.md` and source-specific receipt `attendance-admin-api-d7be3a83a2.json`.

E667 validate:all passed after correcting only owned runtime PATH; this does not qualify later source. R1 second-invalidation mutation at a6e84bf754 failed the matching assertion and restored exact original bytes. UI review at a6 still HOLD for five readback/selection/copy-state corrections; that separate Grok task remains active. Full first-slice browser/quality/mutation/final review remain pending. Overall DOCX goal not complete. No public push, PR or deployment.

Post-run d7 cleanup completed: owned backend stopped and all445 table counts/content hashes equal the restored4-user/0-session baseline. Three additional route mutations (single lock, batch locks, revoke witness) each failed matching assertions; every original source byte was restored. The source SHA remains d7, not this later documentation commit.
