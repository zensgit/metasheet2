# Admin console issues 4/5 — role and permission correctness

- Date: 2026-10-14
- Slice: design-lock ordered slice 1 only (`docs/development/admin-console-issues-1-5-design-lock-20261014.md`)
- Baseline: `ec8d97cc481d3c6835a97c197a93cd00d10151e2` (current main)
- Branch: `codex/admin-issues-permission-correctness-20261014`
- Runtime: this worktree. No product vitest run here. Parent owns Mac synthetic DB/browser. No install, commit, push, PR, merge, deploy, or flags.

Reports are not proof. Causes below are from baseline source plus focused synthetic tests. Items 1/2/3 were not edited.

## 1. Reproduction (code, then tests)

| Report | Reproduced? | Cause on baseline `ec8d97` |
| --- | --- | --- |
| Selected role lacks membership hint | Yes | Role dropdown had no held/not-held hint. `selectUser` cleared `selectedRoleId`. Chips elsewhere did not describe the selected catalog id. `UserManagementView.vue` ~873–884, `selectUser` ~2430. |
| Role action feedback hard to see | Yes | `updateRole` wrote only page-top `setStatus('角色已分配' \| '角色已撤销')`. Controls sit at the bottom. Baseline ~3062–3080. |
| Revoke leaves membership | Yes as silent success / readback; **no** as a failed `DELETE` of an existing `user_roles` row | Writer is `DELETE FROM user_roles WHERE role_id = $2 AND user_id = ANY($1::text[]) RETURNING user_id` (`rbac/role-assignment.ts:621`). 0-row DELETE still returned HTTP 200 with snapshot. UI always said 角色已撤销 and applied `payload.data` without checking `roles`. No `roleHeld` / `membershipChanged`. Async apply used live `selectedUserId`. Catalog `memberCount` was not refreshed (`loadUsers` only). |
| Direct grant disappears on the permission page | Yes | Grant writes `INSERT INTO user_permissions ... ON CONFLICT DO NOTHING` (`permissions.ts:167`). GET `/api/permissions/user/:userId` returned only `listUserPermissions` (direct ∪ role ∪ legacy, then namespace-admission filter). UI labeled that list 已授予权限 / 暂无直接权限 (`PermissionManagementView.vue` baseline ~62–69, ~200, ~319). A namespaced grant without role-derived namespace **and** `user_namespace_admissions.enabled` is persisted and then filtered out of `permissions`. |

Non-reproduced writer gap: an existing `user_roles` row surviving that DELETE. Leftover membership in this slice is 0-row DELETE + UI treating 200 as revoke success, or a later selected user receiving the in-flight snapshot.

Admission was not auto-enabled. `listUserPermissions` / `filterPermissionCodesByNamespaceAdmission` were not bypassed.

## 2. What changed

Display-only inspection plus UI/readback. Authorization aggregator unchanged.

- `inspectUserPermissionGrants` is a display-only source split so the admin page can show a persisted grant that admission filtered out of authorization. It is not a second authorization path: three SELECTs, then the same admission filter. `effective` matches filtered authorization. `blockedByNamespaceAdmission` is merged minus effective. No cache write. No admission INSERT/UPDATE. Schema-unavailable inspection returns `unavailable: true` rather than healthy empty grants (`RBAC_OPTIONAL=1`); other DB errors still throw.
- GET `/api/permissions/user/:userId` derives `permissions` and `effective` from that one fresh inspection. It does not call `listUserPermissions`, so a warm/stale authorization memo cannot mix into the readback. Unavailable inspection is HTTP 200 with `degraded: true` / `unavailable: true`. `/me` and template apply stay on the authorization aggregator. No tenant/org predicate was added; the other-user gate remains `isAdmin`.
- `invalidateUserPerms` bumps a per-user generation so an in-flight `listUserPermissions` miss cannot store pre-revoke codes in the memo. Authorization semantics stay fail-closed: live `userHasPermission` still queries, optional-schema auth still returns empty/deny.
- Grant still inserts `user_permissions` only (`permissions.ts:167`).
- Assign/unassign add `roleHeld` and `membershipChanged` (`admin-users.ts:5025`, `5091`). HTTP 200 on 0-row DELETE is unchanged; flags carry persisted state.
- Helpers extracted from the large views: `apps/web/src/views/adminUserRoleAction.ts`, `adminPermissionGrantDisplay.ts`.
- User management: selected-role membership hint beside the dropdown; local success/failure; initiating `userId` captured; snapshot applied only if still selected; still-held unassign is an error; `loadRoles()` after a write.
- Permission management: 直接授予 / 角色继承 / 生效权限 / 未生效（命名空间准入）. Grant that is direct but blocked says 未自动开通准入. Inherited-only revoke 404 is an error, not success. Empty `effective: []` is kept empty (not treated as missing).

`updateNamedRole` (平台管理员 / 考勤管理员 shortcuts) now uses the same captured initiating IDs, `describeRoleMembershipWrite` readback, local `roleActionFeedback`, and target-bound `loadMemberAdmission` as `updateRole`. Leftover disable is 仍持有角色, not 已关闭. An in-flight shortcut response is not applied onto a later selected user.

## 3. Tests added

Positive / negative coverage:

- Revoke persisted+effective: DELETE `rowCount` 1 → `roleHeld: false`, `membershipChanged: true`, remaining `permissions` from the snapshot.
- Leftover membership: DELETE `rowCount` 0 + snapshot still holds the role → `roleHeld: true`, `membershipChanged: false`, HTTP 200. UI maps that to error 仍持有角色, not 角色已撤销.
- Direct vs inherited vs effective vs blocked; `inspect.effective` equals `listUserPermissions`; inspect SELECTs only.
- Namespaced grant writes `user_permissions` and never `user_namespace_admissions`.
- Scope deny follows the existing GET boundary: platform-admin may read another user by `userId` (this route has no tenant/org partition; global platform-admin may cross tenants). A non-admin GET of another user is 403 at `isAdmin`, before list/inspect.
- Role selection none/held/not-held; initiating-user race (delay unassign, switch user, do not apply snapshot).
- Named-role shortcut leftover disable of `admin` still held → error 仍持有角色 admin, chip stays 已开通, no 已关闭. Shortcut race: delay disable, switch to Bravo, Alpha snapshot is not applied.
- Permission write race (delay grant, switch user); inherited-only 404 copy.
- GET user readback ignores a stale `listUserPermissions` memo; `permissions` equals inspect `effective`.
- Inspector `42P01` with `RBAC_OPTIONAL=1` is `unavailable`, not healthy empty. Optional admission fallback that would fail-open authorization is reported `unavailable` on inspect instead of proven effective/empty. Generic DB error and `42P01` with optional off propagate. Route generic error is 500.
- In-flight deferred union: first pool read returns `workflow:read` only after `invalidateUserPerms`; pending resolves `[]` (not the pre-revoke codes); a poisoned later union is not consulted (`cacheHits` of empty); live `userHasPermission` deny.
- Degraded UI: empty grant sections are not shown as 暂无 or `0 项` (counts say 未读); write readback refuses to treat unavailable sources as revoke success, including fail-open looking arrays.
- F3 AuthService: next `verifyToken` and fresh `login` skip `attendance_employee` INSERT and do not merge `attendance:read` when attendance admission is `enabled=false` / `source=role_unassigned`, or when the admission SELECT is `42P01`. Eligible empty admission still bootstraps. Recovery census still omits unpersisted codes. Register still inserts in the create transaction.

Files:

- `apps/web/tests/userManagementRoleMembership.spec.ts`
- `apps/web/tests/permissionManagementView.spec.ts`
- `packages/core-backend/tests/unit/rbac-namespace-admission.test.ts` (two inspect cases)
- `packages/core-backend/tests/unit/permissions-routes.test.ts` (GET breakdown, 403, namespaced grant)
- `packages/core-backend/tests/unit/admin-users-routes.test.ts` (attendance_employee unassign flags)

Required web lane: tokens `permissionManagementView` and `userManagementRoleMembership` inserted on the exec list (case-insensitive order). Manifest regenerated with `node scripts/ops/required-web-lane-token-manifest.mjs --write` (608 tokens, match). Existing tokens retained.

Domain guard two-point gap: the same two spec tokens plus source/spec path filters were added to `.github/workflows/approval-web-guard.yml` in both `pull_request.paths` and `push.paths` (UNION preserved) and on the targeted vitest run line. No new workflow. Required-script half was already present.

## 4. Static checks run here

```
node scripts/ops/required-web-lane-token-manifest.mjs --write
node scripts/ops/required-web-lane-token-manifest.mjs
bash -n apps/web/scripts/run-required-web-tests.sh
git diff --check -- <touched tracked files>
```

Manifest matches from the earlier required-lane pass. This remaining-gap pass did not re-run the manifest (required script unchanged), did not install, and did not run vitest, tsc, or a browser. Domain-guard UNION is two path-list copies plus the targeted run-line tokens; a python substring scan of that run line found no collision with the two new tokens.

## 5. Remaining tests for the parent Mac

```
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/rbac-namespace-admission.test.ts \
  tests/unit/permissions-routes.test.ts \
  tests/unit/admin-users-routes.test.ts \
  tests/unit/attendanceSelfServiceBackfill.test.ts \
  tests/unit/AuthService.test.ts \
  tests/unit/required-web-lane-token-manifest-guard.test.ts \
  tests/unit/required-web-lane-registration-shape.test.ts \
  --watch=false --reporter=dot

pnpm --filter @metasheet/web exec vitest run \
  tests/userManagementRoleMembership.spec.ts \
  tests/permissionManagementView.spec.ts \
  tests/userManagementView.spec.ts \
  tests/run-required-web-tests-shape.spec.ts \
  --watch=false --reporter=dot
```

Native qualification (actual DB/browser, restore/shutdown) stays with the parent. This slice did not change the security model to make chips green.

## 6. Modified paths

Tracked:

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/src/views/PermissionManagementView.vue`
- `packages/core-backend/src/rbac/service.ts`
- `packages/core-backend/src/rbac/namespace-admission.ts`
- `packages/core-backend/src/routes/permissions.ts`
- `packages/core-backend/src/routes/admin-users.ts`
- `packages/core-backend/src/auth/AuthService.ts`
- `packages/core-backend/tests/unit/rbac-namespace-admission.test.ts`
- `packages/core-backend/tests/unit/permissions-routes.test.ts`
- `packages/core-backend/tests/unit/admin-users-routes.test.ts`
- `packages/core-backend/tests/unit/AuthService.test.ts`
- `apps/web/scripts/run-required-web-tests.sh`
- `apps/web/scripts/run-required-web-tests.tokens`
- `.github/workflows/approval-web-guard.yml`

New:

- `apps/web/src/views/adminUserRoleAction.ts`
- `apps/web/src/views/adminPermissionGrantDisplay.ts`
- `apps/web/tests/userManagementRoleMembership.spec.ts`
- `apps/web/tests/permissionManagementView.spec.ts`
- `packages/core-backend/src/auth/attendanceSelfServiceBackfill.ts`
- `packages/core-backend/tests/unit/attendanceSelfServiceBackfill.test.ts`
- `docs/development/admin-console-issues-4-5-role-permission-correctness-development-verification-20261014.md`

Unchanged on purpose: `rbac/role-assignment.ts` writer, admission writers, GET `/api/permissions/me`, `PRODUCT_MODE`, register transaction insert, items 1/2/3, design lock. `listUserPermissions` still aggregates the same sources and still fail-closes optional-schema to `[]`. F3 reads `user_namespace_admissions` for namespace `attendance` directly; it does not call `listUserNamespaceAdmissionSnapshots` (that helper synthesizes enabled when the table is missing).

## 7. Remaining gaps (truthful)

- Writer leftover when a `user_roles` row exists and DELETE does not remove it: not reproduced; SQL left as-is.
- **F2 implemented:** inspector `42P01` on grant sources, unread `user_namespace_admissions` / role-context under optional fallback, and GET `/api/permissions/user/:userId` when `unavailable`, return `degraded`/`unavailable` empty lists. Authorization `listUserPermissions` still fail-opens namespaced codes when the optional admission table is missing. Generic `57P01` and optional-off `42P01` still fail closed (throw / HTTP 500). The UI shows 未读, not 暂无* / `0 项`, and write readback refuses that state as success. `RBAC_OPTIONAL` default is unchanged.
- GET `/me` and template-apply JSON are still effective-only lists on the authorization aggregator.
- 60s `listUserPermissions` cache remains the authorization memo for `/me`, JWT profile refresh, and similar. Inspect does not write it. Grant/revoke/assign/unassign still `invalidateUserPerms`. Cache entries carry the per-user generation. One invalidation during a miss retries once and caches that retry only while its generation is still current, so the pre-revoke codes are not a later hit. A second invalidation during that retry fails closed the current caller with `[]` and does not cache the retry. Optional-schema errors still return `[]` from the existing catch. R2/R3 revocation atomicity stays with Astra and is not closed here.
- **F3 implemented (parent native still open):** live baseline `ec8d97` next `GET /api/auth/me` after revoke reinserted `attendance_employee` (`user_roles` 0→1) while admission stayed `enabled=false` and the auth profile contained `attendance:read` (`artifacts/admin-issues-20261014/baseline-next-auth-reproduction.json`). `resolveRbacProfile` now SELECTs that attendance admission row before backfill. Explicit disabled / `role_unassigned` / unread admission skip assign and skip merging attendance permissions. Eligible never-revoked (no admission row) still bootstraps. No new flag, migration, or `PRODUCT_MODE` change.
- No live admin-console browser pass in this worktree (no app/DB here). Vue mount specs cover the changed controls, including the named-role shortcut leftover/race and degraded inspection copy.
- Items 1/2/3 (password copy, field picker, paginated role members) are later slices.
- Design-lock “second tenant/scope deny” is the existing `isAdmin` other-user gate on GET `/api/permissions/user/:userId`. This slice does not add a tenant/org partition; platform-admin may read another user by `userId`.
- Product vitest was not run in this worktree. Parent Mac still owns native qualification, including a warm/in-flight memo through the actual guard after revocation.

## 8. R1 and R4–R6 repair (2026-10-14, same worktree)

Independent review P2s R1 and R4/R5/R6 only. R2/R3 stay open for Astra in the disjoint auth, admission, and admin-user files. This pass did not edit those files, `routes/permissions.ts`, or `routes/admin-users.ts`. No new flag, migration, or capability.

- R1: `listUserPermissions` still retries once after a generation change. If the retry generation also changes, the current caller gets `[]` and neither the revoked codes nor that empty result are cached. The next caller is a miss. The new unit case defers both unions, invalidates twice, asserts `[]` is uncached, and calls the actual `rbacGuard('workflow:read')` for the empty profile and for a profile that still carries the revoked code.
- R4: user and permission selection clear the snapshot, then apply success or the error only for the same read generation and subject. A→B→A and a late read of the earlier subject do not paint the current selection. Role shortcuts and permission actions stay disabled until that snapshot matches.
- R5: a grant/revoke ack is accepted only with `success: true`, the requested `userId`, the requested code, and no degraded/unavailable flag. Role apply requires the snapshot user id, string-array roles and permissions, boolean `isAdmin`, boolean `roleHeld`, boolean `membershipChanged`, and `changedRoleId`. Invalid JSON, a partial source array, a wrong subject, and an old empty effective list are not verified success. Unknown source stays 未知, not 暂无直接授予.
- R6: a healthy inspection becomes 未读 after a degraded or HTTP 500 readback, and after a failed refresh or selection. Template completion copy is used only when the readback subject matches and the source arrays are known. Attendance legacy `GET /api/permissions/user/:id` in `AttendanceView.vue` and `useAttendanceAdminProvisioning.ts` treats `degraded` / `unavailable` as not a loaded grant set, so the caller does not announce 已加载 0 项权限.

Regression coverage added in the existing specs: helper cases for the ack, role payload, source breakdown, and template status; mounted cases for A→B→A, failed selection, malformed role JSON, degraded and 500 readback, refresh/select failure, old effective, degraded ack, invalid JSON, wrong subject, and degraded template readback.

The blocked-grant and inherited-revoke sentences keep a space after the user id (`用户 user-1 的直接授予`). The existing helper and mounted asserts stay on that spaced phrase. Sibling permission sentences in the same helper use the same space. This pass did not re-run Vitest.

Static check in this pass: `git diff --check` on the repair paths below. No shell script changed, so `bash -n` was not run. Vitest, type-check, lint, native DB, and browser were not run here. Parent Mac still owns those gates. This section does not claim those gates passed.

Repair paths:

- `packages/core-backend/src/rbac/service.ts`
- `packages/core-backend/tests/unit/rbac-namespace-admission.test.ts`
- `apps/web/src/views/adminUserRoleAction.ts`
- `apps/web/src/views/adminPermissionGrantDisplay.ts`
- `apps/web/src/views/UserManagementView.vue`
- `apps/web/src/views/PermissionManagementView.vue`
- `apps/web/src/views/AttendanceView.vue`
- `apps/web/src/views/attendance/useAttendanceAdminProvisioning.ts`
- `apps/web/tests/userManagementRoleMembership.spec.ts`
- `apps/web/tests/permissionManagementView.spec.ts`
- `docs/development/admin-console-issues-4-5-role-permission-correctness-development-verification-20261014.md`

## 9. Sol cache UI correction (2026-10-14)

Source review `artifacts/admin-issues-20261014/sol-cache-ui-correction-review.md` against frozen `a6e84bf754`, edited on HEAD `22cc8cd9fc`. Five UI findings only. No backend, flag, migration, or attendance-admin A1 files.

- Role assign/unassign and the named-role shortcuts capture the access-read generation. A finished write applies only while that generation and subject are still current, so A→B→A cannot put the older snapshot over the newer read. A rejected body or a failed write clears that same current snapshot; role chips and role/admin shortcuts unmount with the unread state.
- A degraded or malformed permission acknowledgement clears the inspection only for its initiating generation.
- Refresh marks the selected inspection unread before the user list or catalog request. A catalog 500 leaves that unread state and does not wait for a new access GET.
- Template apply reports completion only after HTTP success, a non-degraded `success`/`ok` flag, and a body whose `userId`, `template.id`, string `permissions`, and boolean `isAdmin` match the request. `{ ok: false }`, invalid JSON, and `{ ok: true, degraded: true }` stay errors. Readback copy is unchanged.
- Legacy attendance fallback in both consumers accepts `{ userId, permissions, isAdmin }` without a source breakdown, including an explicit empty array. `{}`, another subject's arrays, a non-array, HTTP 500, invalid JSON, and a rejected fetch clear permissions, admin, roles, and loaded state instead of announcing 已加载 0 项权限.

NOT RUN: vitest, type-check, lint, build, native DB, browser. Static check this pass: `git diff --check` on the paths below.

Parent:

```
pnpm --filter @metasheet/web exec vitest run \
  tests/userManagementRoleMembership.spec.ts \
  tests/permissionManagementView.spec.ts \
  tests/attendanceLegacyPermissionPayload.spec.ts \
  tests/useAttendanceAdminProvisioning.spec.ts \
  --watch=false --reporter=dot
```

Paths:

- `apps/web/src/views/UserManagementView.vue`
- `apps/web/src/views/PermissionManagementView.vue`
- `apps/web/src/views/adminPermissionGrantDisplay.ts`
- `apps/web/src/views/AttendanceView.vue`
- `apps/web/src/views/attendance/useAttendanceAdminProvisioning.ts`
- `apps/web/src/views/attendance/readAttendanceLegacyPermissionPayload.ts`
- `apps/web/tests/userManagementRoleMembership.spec.ts`
- `apps/web/tests/permissionManagementView.spec.ts`
- `apps/web/tests/attendanceLegacyPermissionPayload.spec.ts`
- `docs/development/admin-console-issues-4-5-role-permission-correctness-development-verification-20261014.md`

## 10. Two UI residuals (2026-10-14)

Source review `artifacts/admin-issues-20261014/sol-ui-correction-and-field-scroll-review.md`, findings 1 and 2 only. Base named by the parent: `39e9929000`. No API, backend, flag, or attendance-legacy spec edit. `attendanceLegacyPermissionPayload.spec.ts` stays with the parent: its `'不能当作已加载'` assertion matches the generic substring `'已加载'`.

- `loadAll` still marks the selected inspection unread before the user list and catalog requests. The catch writes that unread snapshot only when `accessReadStillCurrent` matches the generation captured for that refresh. A catalog 500 on the same generation still leaves the unread inspection. A catalog 500 released after A→B→A does not replace the newer A inspection. The page status still reports the catalog failure.
- Template apply production parsing is unchanged. The mounted spec now clicks `apply-permission-template-button` and accepts the existing acknowledgement `{ success, userId, template, permissions, isAdmin }`. The template POST mock arms degraded, invalid JSON, foreign subject, and effective-only legacy readbacks. Healthy source breakdown reports `已按模板 现场模板 补齐权限`. Effective-only `{ userId, permissions, isAdmin }` keeps `workflow:read` and `未知` source labels and does not report completion. Degraded, invalid JSON, and foreign readbacks show `未读` / `身份未读` and disable grant and apply. Each case asserts `POST /api/admin/permission-templates/apply` and `GET /api/permissions/user/user-1`.

NOT RUN: vitest, type-check, lint, build, native DB, browser. Field scroll and the passed backend were not reopened.

Paths:

- `apps/web/src/views/PermissionManagementView.vue`
- `apps/web/tests/permissionManagementView.spec.ts`
- `docs/development/admin-console-issues-4-5-role-permission-correctness-development-verification-20261014.md`

## Final local qualification of items4/5

Frozen target `57a6f229a7e95ceb4c90bb6c0b6e2790e882bea4`: six frontend files155passed, zero failures/skips. The final template matrix actually selects a template before checking apply readiness and exercises all five template-button POST/GET cases. Sol independently accepted the two residual corrections at57; all previously reported source findings are closed by the bounded review chain under `artifacts/admin-issues-20261014`.

At production-byte-identical `7f103b5333`, ten backend files331passed and full `pnpm validate:all` passed (plugins, lint, type checking). `git diff 7f103b5333 57a6f229a7` contains only the test-helper ordering correction. Backend source and native integration specs are byte-identical to independently reviewed/qualified d7: native revocation11+registration3passed; single/batch realAPI tests include last-witness physical rollback and cross-subject403. Code qualification retains its actual execution SHA.

Full-product native Chromium with real synthetic login/backend at7f verified role selection/member hint, successful revoke feedback, old-token/fresh-login physical membership0 and revoke witness; direct grant stored/visible1 while disabled namespace stayedfalse and effective permission excluded the code. One controlled catalog500 was observed and awaited before checking unread identity/sources and disabled actions; healthy refresh restored evidence. Three screenshots recorded. Owned web/backend stopped and all445 table counts/content hashes restored to four users/zero sessions. This is synthetic local acceptance; no staging/customer/deployment claim.

Mutation sensitivity: R1 cache guard at a6; three transaction guards at d7; refresh-generation, template acknowledgement, and legacy-source clearing at57 all turned the matching tests red. The template-ack mutant failed by not reaching its expected guarded error state; the other two failed assertions. Every original byte was restored. Latestmain2fc0527 differs from initialec baseline only by two unrelated stock-prep documents; touched product code is unchanged. Reconciliation before public review remains required.

Items4/5 LOCAL PASS. Field-picker item2 separately LOCAL PASS. Password item1 and role-members/localization item3 are separate pending slices; the five-item goal is not complete. New public branches/PRs require owner authorization. PR material: `artifacts/admin-issues-20261014/admin-access-correctness-pr-body.md`.
