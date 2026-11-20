# Attendance role writers — transaction boundary design lock

Date: 2026-11-17. Status: DESIGN RELEASE, not implementation. Own HEAD `e0c5107389cad93259d03fc4414366c94a0b5079`. Origin/main `4a44bee478cc6f5080e264a58dbaa21ea57ba8c3`. Model observed for this lock: Grok 4.7. No effort flag was exposed.

This lock closes only the four global handlers in `packages/core-backend/src/routes/attendance-admin.ts`: batch assign `1237`, batch unassign `1316`, single assign `1449`, single unassign `1514`. P1e and P3a stay accepted and unread. No org writer, no new namespace, no engine edit, no takeover, no `MAINTENANCE`.

## Facts the lock preserves

`P1F-MAIN-BASELINE.md`: one owned whole-file run was 4 passed / 1 failed / 0 skipped. The new case called all four handlers on one missing `attendance_compat_*` role. Each returned 200 with the expected body and membership; the role row stayed absent. The only failure is the final parent-order assertion: assign shares the four templates and omits the custom id; revoke already shares that id. Savepoints, not the future default root. Neighbor unit baseline: 94 pass / 0 fail across role-boundary 49, revocation-atomicity 17, recovery-routes 28.

`normalizeBatchUserIds` (`599–612`) trims, drops blanks and duplicates, and never fills `invalidUserIds`. `UUID_RE` (`80`) is not used there. `USER_IDS_INVALID` stays, currently unreachable. Single routes trim the path and use `USER_ID_REQUIRED` only. Do not add a UUID rejection.

`resolveAttendanceRoleAssignment` (`314–337`) plus `roleIdMatchesNamespace` (`namespace-admission.ts:125–129`) admit `attendance` and `attendance_*`, including a custom id. `deriveAttendanceRoleAssignmentScope` (`288–297`) maps `global` to `{ kind: 'platform-admin-in-namespaces', namespaces: ['attendance'] }` and throws 403 `ORG_SCOPED_ROLE_WRITE_UNAVAILABLE` otherwise.

`assignUserRoles` (`role-assignment.ts:564–602`) inserts `ON CONFLICT DO NOTHING`. For this scope `assertDelegatedRoleCodesAssignable` (`551`) returns before any role read. `unassignUserRoles` (`605–637`) deletes. Migration `20250924190000_create_rbac_tables.ts:32–49` creates `user_roles` with a composite primary key and no roles foreign key. Missing custom and missing template parents stay accepted. Do not call `requireRoleRows`, do not throw on `missing`, and do not map a missing parent to 404. Held versus missing is metadata on `tx.roleRows` only. Role birth and content writers stay outside this slice. Full B2 stays HOLD.

Targets: `visibleUserPredicate` is `deleted_at` and `purged_at` null (`user-visibility.ts:5–8`). Global `resolveBatchUsers` (`764–770`) does not filter `is_active` in SQL; `is_active === false` becomes 404 `USER_TARGET_NOT_FOUND` (`793–804`), same code as missing or foreign. `activation_status` is not a target predicate. Pending activation stays writable. Inactive stays refused. No recycle exception.

Actor gates stay two, in this order, and are not collapsed:

1. Locked S0, `assertPlatformActorAuthority` (`platform-actor-authority.ts:46–71`), default mode: active, activated, not deleted or purged, then raw `users.role === 'admin'` OR a live `user_roles` admin row. Token claim is not S0. Do not pass `requireLiveRbacAdmin`.
2. Locked scope: legacy request claim OR `rbac/service.ts:isAdmin` (`33–37`), which reads the admin membership only. A raw-admin row with a false claim and no admin edge fails this clause with the existing 403 `FORBIDDEN` / `Platform admin access required for global user scope`, after S0 has passed.

`isAdmin` false plus a true claim still passes scope. A true claim does not skip S0.

## One business root

`ConnectionPool.transaction` holds its connection for the whole callback (`P1F-MAIN-BASELINE.md`). `withAuthorizationInputTransaction` uses `poolManager.get().transaction` (`authorization-input-lock.ts:391–393`). The command must not be called inside `pg.transaction` or any other open pool transaction. The route stops wrapping these four handlers in `transaction()`.

The only business root is the command's default `withAuthorizationInputTransaction` (`887`): `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`, shared world lock, no R1, no `platformAdminInvariant`, no `caller`, no `identityRead`, no exclusive world. Then every declared parent `SELECT id FROM roles WHERE id = $1 FOR SHARE` (`106`), then sorted actor-union-targets admission locks, then user-row `FOR UPDATE`. `GRANT_ROLE` and `REVOKE_ROLE` record a missing parent and continue (`651–667`). No `afterAcquire`, no injected runner, and no new before-lock hook.

There is no second `transaction()` for preflight. Nesting is forbidden. A sequential read-only `transaction()` is also forbidden.

## Preflight, relocated

Composition, one function in the route, `preflightAttendanceGlobalRoleWrite(req, userIds)`, called by all four handlers after parse succeeds:

- `resolveAttendanceAdminUserScope(req, query, false)` on the pool `query` export. Same SQL. `lockMembership` false, so no `FOR SHARE`.
- `deriveAttendanceRoleAssignmentScope` on that result. Org, unknown scope, unauthenticated, and non-admin global throw before the command.
- `resolveBatchUsers(userIds, scope, query, false)` then `assertAllRoleTargetsEligible`.

Parse refusals (`ROLE_REQUIRED`, `ROLE_OUT_OF_SCOPE`, `USER_ID_REQUIRED`, `USER_IDS_REQUIRED`, unreachable `USER_IDS_INVALID`) stay before this function and before any SQL.

Compatibility, explicit:

- HTTP status, code, and message for those refusals stay. An active org member still ends at `ORG_SCOPED_ROLE_WRITE_UNAVAILABLE` after the unlocked membership select. A non-member still ends at org `FORBIDDEN`.
- Those paths no longer `begin` or `rollback`. Spies on `pg.transaction` see no call. The org boundary test (`role-assignment-boundary.test.ts:1250`) must stub pool `query`, not the transaction client, or an empty pool result becomes membership `FORBIDDEN` and hides the derive refusal.
- Each preflight statement can take a transient `AccessShareLock` until that statement ends. It takes no row `FOR SHARE` / `FOR UPDATE` and no advisory lock. The old preflight held its transaction, and that `AccessShareLock`, until commit or rollback. The gap before the root no longer holds it.
- Read-committed snapshots are not shared with the root. A target or actor edge can change in the gap. The locked recheck refuses with the same 404 or 403 body, and the root rolls back with no membership write.

## Commands

New module `packages/core-backend/src/admin/attendance-role-commands.ts`. Two public functions, data only:

- `assignAttendanceGlobalRolesCommand({ actorId, userIds, roleId, legacyAdminClaim, includeProfile })`
- `unassignAttendanceGlobalRolesCommand({ actorId, userIds, roleId, legacyAdminClaim, includeProfile })`

No `req`, `tx`, `query`, `plan`, `scope`, runner, or callback field. `legacyAdminClaim` is the boolean `hasLegacyAdminClaim(req)` at the route. `includeProfile` is true only for the two single routes. The guard pins those four call expressions. A literal `true` claim or an extra argument is a guard failure. S0 does not read the boolean.

Route builds `actorId` with `getAttendanceAdminRequestUserId` and passes the already normalized id list, order preserved. The entry sorts a deduped actor-union-targets set for R3 and R5. Actor equal to a target is one subject.

Frozen plan, both witness lists equal that sorted subject list:

- Assign intent `GRANT_ROLE`. `roleIds` is the sorted code-unit union of `attendance_admin`, `attendance_approver`, `attendance_employee`, `attendance_importer`, and `roleId`. A template final id stays length 4. A custom id is added, never substituted for a template. The command keeps those four literals in one frozen array. A unit oracle compares them to `Object.values(ATTENDANCE_ROLE_TEMPLATES)` role ids sorted. Do not import the route (cycle). Do not move the public template catalogue.
- Revoke intent `REVOKE_ROLE`. `roleIds` is exactly `[roleId]`. Templates are not added. This matches today's revoke share.

Inside `work`, after `assertContext` (open brand, `tx.plan` identical to the frozen plan, frozen lists, exact ids, every declared parent `held` or `missing`, admission witnesses present):

1. S0 on `tx.locked.get(actorId)`. Failure is `PlatformActorAuthorityLost` (`403`, `FORBIDDEN`, `Admin access required`).
2. If `legacyAdminClaim === false` OR the locked actor role is not `admin`, share the positive admin edge: save timeouts, set the existing `5000` / `10000` window (`111–112`), `SELECT role_id FROM user_roles WHERE user_id = $1 AND role_id = 'admin' FOR SHARE`, restore on success or on an empty result. A statement failure does not restore; the aborted root surfaces as `AuthorizationInputBusyError`. Do not stabilize only when the raw role is not admin. A false claim shares the edge even for a raw-admin row.
3. Scope recheck. False claim and an empty share: throw `AttendanceAdminUserScopeError` with the existing global `FORBIDDEN` body. Do not call that an authority loss. True claim skips `isAdmin`. False claim and a held share: call `isAdmin(actorId, tx.query)`; false throws the same scope error. True claim and a non-admin raw role whose share is empty: `PlatformActorAuthorityLost`. That empty share is the edge-loss guard. It refuses a case the old unlocked second read could still have passed on claim alone. It does not admit anyone new. Steady state without contention keeps today's order and bodies: S0, then this scope clause, then targets, then writes.
4. Target recheck: `resolveBatchUsers(userIds, { kind: 'global' }, tx.query, true)` and `assertAllRoleTargetsEligible`. Same 404. `FOR SHARE OF u` while the entry holds `FOR UPDATE` is the original locked re-read, not a new parent and not a rank below R2. Pending activation still passes. Inactive, missing, deleted, and purged still 404.
5. Writer scope is `const roleWriteScope = deriveAttendanceRoleAssignmentScope({ kind: 'global' })` inside each command, then the existing helper with `executor: tx`. No scope parameter. One assign call for the whole id list. One unassign call for the whole list, then `disableNamespaceAdmissionsWithoutRoles` per target in code-unit order, not for the actor unless the actor is a target. `listRoleNamespaces(roleId, tx.query)` stays. `attendance_employee` opt-out stays inside that helper (`626–628`). No second role-row lock in `work`.

Assign returns the helper result, the locked target projection, and, when `includeProfile` is true, `fetchUserProfile` on `tx.query` before commit. A profile throw rolls the batch back. A null profile stays null on the 200, as today. Unassign returns the same shape. `rowCount`, `affectedUserIds`, and `delegatedAdminScopeCleanup` are the helper's values. The route keeps `withLimit(200)`, unchanged-id order, and the batch keys (`requested`, `eligible`, empty missing and inactive on success, `items`).

Post-commit stays in the route, only after the root returns: `auditDelegatedAdminScopeCleanup` (its own catch logs and does not 500), then single `fetchUserRoleIds`, `listUserPermissions`, and `isRbacAdmin`. A throw there is the existing 500 (`ROLE_ASSIGN_FAILED`, `ROLE_UNASSIGN_FAILED`, or the batch codes) and does not replay commit. `attendance_admin` audience cleanup remains inside the helpers on this root (W-03). Duplicate assign stays `ON CONFLICT DO NOTHING`.

Route catch order stays scope, authority lost, role-assignment refused, recovery conflict, then `AuthorizationInputBusyError` mapped with `jsonError` to 409 `AUTHORIZATION_INPUT_BUSY`, message `Authorization inputs are busy; retry this change.`, details `{ retryable: true }`. The accepted transaction boundary's LR-8 busy family applies to eligible acquisition and awaited-work failures: `55P03`, `57014`, `40P01`, and non-marker `40001`. Thus a membership DML deadlock changes from the old 500 to this retryable 409; the boundary is not acquisition-only. Exact recovery-marker `40001` remains the distinct recovery 409. Genuine non-busy errors such as `XX000` keep the route-specific 500. The kernel's exception after work has returned without a previously heard connection error, including uncertain COMMIT acknowledgment, is unchanged; post-commit read failures also keep their existing 500 and never replay a write. No automatic retry is added. Parent, R3, R5, and the admin-edge share use the per-acquisition entry window, not a whole-transaction time budget.

## Helper port

Move unchanged into `packages/core-backend/src/admin/attendance-role-target-read.ts`: `AttendanceAdminUserScope`, `AttendanceAdminUserScopeError`, `deriveAttendanceRoleAssignmentScope`, `resolveBatchUsers`, `assertAllRoleTargetsEligible`, and the attendance `fetchUserProfile` SQL (`499–522`). Route re-exports `deriveAttendanceRoleAssignmentScope`. `resolveAttendanceAdminUserScope` stays in the route because it reads `req`. The command imports the helper module and `isAdmin`, not the route.

`role-assignment-boundary.test.ts:1175–1248` today requires four `assignUserRoles` / `unassignUserRoles` calls in the route, each `scope: roleWriteScope` bound from `deriveAttendanceRoleAssignmentScope(scope)`. Retarget that scan: the route has zero of those calls and still calls derive on the preflight scope in each handler; the command has exactly one assign and one unassign, each bound from `deriveAttendanceRoleAssignmentScope({ kind: 'global' })`. Keep the derive behavior tests (`1199`, `1207`). A constant or injected scope in the command fails the positive control. Do not leave the DML in the route to satisfy the old scan.

## Writers and allowlists

Status stays `pending` for W-01, W-02, W-03, W-15, W-17. Do not mark them converted.

Call sites read in `src` this session. `assignUserRoles`: 9 today (attendance 2, `admin-users` 2, platform assign 1, batch 2, `AuthService` 1, directory-sync 1). After: attendance 0, command 1, the other 7 unchanged. `unassignUserRoles`: 7 today (attendance 2 plus one each in `admin-users`, recycle, platform unassign, `roles`, batch). After: 6. `disableNamespaceAdmissionsWithoutRoles`: 6 today (attendance 2 plus recycle, platform unassign, batch, `admin-users`). After: 5. W-15 `grantNamespaceAdmissions` remains the `admin-users` site only.

Contract edges added, exact tuples, no wildcard: the command file to `../rbac/authorization-input-brand` once and `../rbac/authorization-input-lock` twice (value import and type import); the route to `../rbac/authorization-input-lock` once for `AuthorizationInputBusyError`. No brand import on the route. Guard rejects a second declaration, dynamic import, namespace import, alias, pool executor, hook call, empty or reordered parent list, revoke parents other than the action id, `platformAdminInvariant`, `requireRoleRows`, and a scope parameter. Platform command source pins stay byte-identical.

Remove `lockAttendanceTemplateRoleRows` and `lockAttendanceRoleWriteSubjects` when nothing calls them, and drop the route imports of `lockSharedAccessSubjects`, `assertPlatformActorAuthority`, `assignUserRoles`, and `unassignUserRoles`. Keep `PlatformActorAuthorityLost` on the route catch.

## Gates

Unit, not run in this phase:

- New `tests/unit/attendance-role-commands.test.ts` through the real command and the default entry seam. Parse refusals issue no `query` and no root. Scope and target refusals may issue unlocked pool selects and must not issue world, role share, admission, user `FOR UPDATE`, or membership DML.
- Raw-admin with false claim and no edge: S0 passes, scope `FORBIDDEN`, no write. Raw-admin with false claim and an edge: admin-edge share is in the statement list. Member-only actor with the edge writes. Member-only without the edge: authority lost before scope.
- Assign plan contains the custom id plus four templates, sorted. Revoke plan is the action id only. Missing parent still takes the success return, with `roleRows` `missing`, and no 404.
- One root: a throw on the second target's admission disable rolls back the membership statement. Post-commit list failure does not open another root.
- Mutated brand, thawed plan, and a guard-text edit fail closed.
- Revocation-atomicity event lists change from `begin` plus locks to pool preflight plus the entry root. Update those pins only.
- Recovery file `recovery-conflict-surfaces-routes-rbac.test.ts` keeps four census titles and the exact recovery-marker 40001 body. Inject on the `poolManager` client the entry uses, not the old production `pg.transaction` root; answer its actual protocol and lock statements. Keep the two original membership-deadlock stimuli with exact busy 409 expectations; separately prove `XX000` retains each original 500 and non-marker `40001` is busy, not recovery. Assert one attempt, no successful commit or post-commit effects. Do not add a runner, kernel bypass, or retry loop.

PostgreSQL file, bytes and execution owned by main: `tests/integration/attendance-role-writers-transaction.db.test.ts`. Top-level `EXPECT_DB` sentinel, same shape as `platform-role-unassign-transaction.db.test.ts:72–74` (sentinel fails closed when `EXPECT_DB` is `1` and `DATABASE_URL` is empty; business `describe` skips without a URL). One quoted exclude in `packages/core-backend/vitest.config.ts`. One backslash line in `.github/workflows/plugin-tests.yml` job `approval-db` step `approval-real-db-integration`, immediately after `platform-role-unassign-transaction.db.test.ts`. `scripts/ops/plugin-tests-parallel-contract.test.mjs` strips that line before the frozen step hash and has one ownership test: exactly one occurrence, remove / duplicate / move throw. Do not add it to `DB_SPECS` in `authorization-input-lock.test.ts:62–65`.

Main's physical cases, not claimed here: R2 parent order including a missing custom id, R3, R5, admin-edge share, no `CONSUME` missing refusal, rollback, source-statement fault, batch all-or-none. The existing template whole file stays main's oracle; do not edit it in the implementation slice to turn the red green by weakening the assertion. The product change makes that assertion match.

## Out of scope

No install, commit, push, PR, deploy, staging, provider, real accounts, or flag enablement. No HTTP, auth, or CI claim. W-01 and the other callers above remain open. Directory, batch, purge, birth, and role-content writers are untouched. The 84 dirty paths are untouched apart from this new lock file.
