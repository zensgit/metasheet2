# Platform role assignment: single-caller transaction boundary

## Status and scope

Design candidate; implementation must wait for independent design acceptance. This is engineering scope for the existing POST /api/admin/users/:userId/roles/assign route, not owner-policy ratification, full role-writer closure, B2 readiness or deployment approval.

Keep the complete existing role allowset, including admin and namespace main-admin roles. Do not adapt unassign, delegation, attendance, batch, registration, projection, purge or role deletion. No new flag, schema, permission source, UI capability, generic authority framework or takeover caller is introduced. Main owns implementation; this checkpoint changes documentation only.

## Source checkpoint

The inspected source checkpoint has HEAD e0c5107389cad93259d03fc4414366c94a0b5079 plus working-tree changes; HEAD alone is not the reviewed source pin. Paths below are relative to packages/core-backend:

- src/routes/admin-users.ts, single assign ~L6168: the current transaction already takes the action-role SHARE before complete sorted actor/target admission locks and user-row locks, checks role version, target and actor, then calls the shared writer.
- src/admin/platform-actor-authority.ts, assertPlatformActorAuthority ~L46: the current locked authority is valid account state plus raw role admin OR live admin membership. Its ordinary role query does not itself retain the membership positive edge.
- src/rbac/role-assignment.ts, assignUserRoles ~L564: the existing INSERT and fresh-appointment delegated-audience cleanup share the supplied executor. The optional executor and other production callers remain.
- src/routes/admin-users.ts, syncLegacyAdminProfile ~L3005: the existing users UPDATE is shared by four logical assign/unassign paths.
- src/rbac/authorization-input-lock.ts: self-built GRANT_ROLE already supports planned role SHARE and subject locks. Missing-role rejection at entry is not generalized from CONSUME to membership intents. Registered takeover callers remain unchanged.

Implementation and review must repin the actual source, not infer behavior from pending registry status.

## Minimal implementation shape

All paths in this section are relative to packages/core-backend.

| File | Bounded purpose |
|---|---|
| New src/admin/platform-role-assign-command.ts | One exported data-only command; private frozen-context checks and membership-edge stabilization; fixed self-built transaction body |
| Existing src/routes/admin-users.ts | Replace only the single assign route's DB transaction with that command; retain request preparation, mappings and post-commit effects |
| New src/admin/role-row-contract.ts, only as needed | Relocate the existing RoleRowMissingError, RoleModifiedError, lockRoleRowForShare and its private timestamp conversion unchanged; old callers and the command share the same classes and helper, not copies |
| New src/admin/legacy-admin-profile.ts, only as needed | Relocate the original syncLegacyAdminProfile and query type unchanged so a sibling command can invoke the fixed existing update |
| Existing src/rbac/authorization-input-writers.ts, only if that relocation occurs | Change W-08's source path only; preserve its symbol, single statement, intent, pending status and the complete logical caller union |

The command API is:
assignPlatformUserRoleCommand(input: Readonly<{ actorId: string; userId: string; roleId: string; expectedUpdatedAt: number | null }>): Promise<RoleAssignmentResult>.

expectedUpdatedAt is the route's existing parsed epoch value or null, not a second parser or a new request field. Return the existing result shape only; expose no token, plan, executor or query capability. Accept no tx, runner, hook, scope, authority/work callback or arbitrary command kind.

Preserve the existing shared assignUserRoles and cleanup DML rather than duplicating INSERT/cleanup sites. If helper relocation is necessary, move its implementation, not redesign it. The legacy helper's logical callers remain delegated assign, delegated unassign, single assign and single unassign; only the single assign call moves inside the command. Do not add a callback parameter to the public command to reach a route-private helper. Other routes receive only the mechanical imports required by relocation.

## Plan, locks and authority

1. Keep authenticate, ensurePlatformAdmin, current String/trim processing, required fields, expectedUpdatedAt parser and outer role/profile prechecks. The direct-permission target narrowing does not apply here.
2. Copy all scalar command inputs before awaiting. Build a fresh, deeply frozen context with a fixed platform-role-assign action and GRANT_ROLE intent. Its frozen plan names the action role and the complete actor/target union in userIds, admissionUserIds and both witness lists. Deduplicate actor=target and sort by code units. Do not consume or modify a CONSUME role-discovery plan.
3. Use the default self-built entry, without runner/options injection: READ COMMITTED, R0 shared, action-role R2R SHARE, the complete R3 batch, then the complete R5 batch. No role discovery after R5, lower-rank supplementation, world upgrade, identity slot, R1 or takeover is added.
4. Before business DML, assert a genuine open brand bound to tx itself, exact per-call tx.plan identity, fixed action/intent, shared world, exact expected subjects/role and actual admission witnesses. Require the action role's actual state to be held and actual held R5 rows/witnesses for both actor and target; plan claims and born rows are not substitutes. False, closed, cross-call or mismatched contexts are protocol failures, not normal missing-user results.
5. Preserve the existing callback refusal order: action-role existence/version, writable target, then actor authority. A genuine entry with an absent role throws the shared RoleRowMissingError; a genuine absent target/actor uses the original target/authority errors. Successful DML still requires both actual held rows. Do not add an inspection API or change common-lock missing semantics.
6. With the action parent already verified held, reuse the original role-row/version helper. Repeating its SHARE for that same held role is not acquiring a newly discovered parent after R5. Preserve no-token behavior, timestamp parsing/comparison, null stored timestamp mismatch and shared error-class identity. Do not duplicate the original error classes or introduce a second version algorithm.
7. Preserve requireWritableTarget behavior: missing target is refused, deleted/purged targets are refused, inactive or pending targets remain allowed. Do not import attendance target rules or direct-permission recycle semantics.
8. Reuse the current assertPlatformActorAuthority default predicate unchanged, on the actual locked actor through tx: actor exists, active===true, activated, not deleted/purged; raw role admin OR live user_roles.admin. Retain its original role read and SQL-error behavior. Do not add a raw-disabled rejection or substitute is_admin, token-only or wildcard authority.
9. If the accepted authority depends on membership rather than raw role admin, reread the exact actor/admin positive edge through tx with FOR SHARE. No edge now means the same PlatformActorAuthorityLost refusal. Raw-admin authorization remains valid without that edge and is stabilized by actor R5; do not narrow it to membership-only. This extra read locks no role parent.
10. Entry timeouts have been restored before work. The new membership SHARE has its own transaction-local 5000ms lock and 10000ms statement window: read old settings, set the window, query, restore on success/no edge. SQL failure propagates without restore SQL in an aborted transaction. No Promise.race, client-side cancellation fiction or request-total deadline claim.
11. Only the closed command reaches this fixed sequence. Its business call is assignUserRoles with the same target, role, fixed platform-admin scope and executor:tx. No pool-side DML. Keep ON CONFLICT behavior, affected counts and fresh main-admin department/member-group cleanup in that transaction. An admin appointment also runs the unchanged legacy profile update there, even when the membership insert is a no-op.

This retains the original authority predicate and requires no new production-owner policy choice. Scope acceptance is not owner ratification.

## Effects and HTTP

Wait for the entire transaction Promise, including COMMIT, before the original order: auditDelegatedAdminScopeCleanup, invalidateUserPerms, business audit, fetchUserAccessSnapshot, original response. The command performs none of these effects. Preserve empty disabledNamespaces, roleHeld and membershipChanged computation. SQL failure cannot commit a partial membership/cleanup/profile change. Unknown COMMIT is not automatically replayed or described as a confirmed rollback; a post-commit audit/readback failure cannot undo the write.

Preserve the existing required-field/version-input errors, role/profile precheck precedence, target errors, PlatformActorAuthorityLost, shared RoleRowMissingError, ROLE_MODIFIED status/body/retryable detail and the existing recovery marker's separate 409 family. Keep the original generic ROLE_ASSIGN_FAILED response, including its established optional correlationId; do not introduce schema-optional success. New non-busy protocol errors use that generic failure path.

Add only this route's authorization-input busy mapping, with the exact fixed response:
409 { ok: false, error: { code: 'AUTHORIZATION_INPUT_BUSY', message: 'Authorization inputs are busy; retry this change.', details: { retryable: true } } }.

The entry classifies work/entry SQLSTATE 40P01, non-marker 40001, 55P03 and 57014 into this typed family; recovery-marker 40001 remains recovery conflict, not this family. Additional entry locks can report busy before an old callback check; do not claim all contention/error timing is unchanged. Preserve ROLE_MODIFIED and recovery mappings before generic handling; handle typed busy before generic failure. Do not broaden shared response helpers for unrelated routes. New errors/evidence expose no cause, busyReason or user values.

## Registry and delivery limits

W-01/W-02/W-03 remain pending, as does W-08 if relocated. Other production callers and the legacy optional-executor API have not become contract writers. Keep the single user_roles writer-file boundary, file/table/verb census, named-site checks, every existing statement and all unrelated statuses. Do not duplicate DML, double-register a site or add a cast/compatibility overload to manufacture converted status.

Add exact static import/call guards for this one data-only producer, fixed entry/intent/context and executor:tx wiring. Relocation permits only the existing caller union plus its replacement command call. Reject rogue/default/namespace/dynamic/moved/duplicate calls, arbitrary callbacks/options, omitted target/parent plans and pool bypasses. These are bounded source guards, not a SQL sandbox.

## Gates before implementation acceptance

| Gate | Required evidence |
|---|---|
| Independent design | Review this bounded contract first; no implementation before design acceptance |
| Focused unit/routes | New tests/unit/platform-role-assign-command.test.ts plus whole admin-users-routes, role-assignment-boundary, role-delegation-admin-role-hardening, attendance-admin-role-revocation-atomicity, recovery-RBAC and writer guard neighbors; preserve their assertions and actual execution |
| Compatibility | Original request/version/role/target/actor ordering and exact bodies; raw-admin without membership, membership-only, is_admin/token/wildcard negatives, original disabled-role predicate, inactive/pending/recycle targets, actor=target, duplicate grant, fresh/existing main-admin cleanup and admin legacy update |
| Runtime/atomicity | Real entry tokens; false/closed/wrong plan/intent/action/missing actual parent/R3/R5 and born-only negatives; full input snapshot; no effects before confirmed COMMIT, SQL rollback, unknown COMMIT and post-commit readback failure |
| Real PostgreSQL | New tests/integration/platform-role-assign-transaction.db.test.ts, actual registered handler→command→shared writer and root transaction; actor edge/raw-role changes, parent edit/delete and target/CONSUME interference in both arrival orders, crossed actors, exact persisted cleanup/profile effects, SHARE timeout/restoration/release; observe pg_locks/pg_blocking_pids, not sleep |
| Mixed callers | Overlapping existing unassign, batch update, purge and protected role deletion; record actual FK/trigger shape and waiting positions; do not mask a concrete cycle with retry or weaken schema |
| CI/contract | Whole new PG file once in approval-db/approval-real-db-integration and once in default exclude, with EXPECT_DB sentinel; deletion/duplication/wrong-lane controls; preserve existing list/step/digest union. Unit enters the actual unit lane. If busy responses require API metadata, update only this existing operation in the implementation slice |
| Independent validation | Single-fault semantic-red/source-byte-restore-green controls for proof, wiring, role/version, authority SHARE, cleanup/profile atomicity and effects; final source tsc and exact pins; independent code review. Report local units, PG and remote CI separately |

No gate above is claimed executed by this design checkpoint. The result is one bounded caller, not whole W-01 closure, another capability line or permission to enable flags, commit, publish or deploy.
