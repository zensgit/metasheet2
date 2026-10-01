# Attendance cross-org write slices

Re-verification of non-import attendance **write** routes that take the organization from request-controlled input. Read-only against `main` except for the slice implemented with this note.

| Item | Value |
| --- | --- |
| Main SHA | `4189aa096a8a8054315bb97db79dfbac1823954e` |
| Prior tip named in the task | `4189aa096` (same commit) |
| Audit SHA | `f2d5331d605d1e155f8dd5ffe7f880be9f93480f` |
| Plugin delta `f2d5331d..4189aa096` | none (`plugins/plugin-attendance`, `attendance-admin.ts`, `jwt-middleware.ts` are identical) |

`getOrgId` is still `plugins/plugin-attendance/index.cjs:6477-6484`:

```text
body.orgId ?? query.orgId ?? user.orgId ?? user.workspaceId ?? x-org-id ?? 'default'
```

`??` does not skip `""`. A normal JWT sets `req.authenticatedTenantId` from the verified `tenantId` claim (`packages/core-backend/src/auth/jwt-middleware.ts:101-104`) and `user.tenantId`. It does not set `user.orgId`. `getOrgId` never reads `tenantId` or `authenticatedTenantId`. `withPermission` checks a permission code (or platform `user_roles.role_id = 'admin'`) and does not bind an org (`index.cjs:23726-23797`).

## Re-verified P0 count

Independent pass: every `context.api.http.addRoute` write (116 of 190 routes) whose handler calls `getOrgId`, then drop routes that already require the actor's active membership (or an equivalent subject/counterparty check) before a foreign org is applied.

| Bucket | Audit | This pass on `4189aa096` |
| --- | --- | --- |
| P0 import / integration writes | 12 | 12 (unchanged, still `getOrgId`; not edited here) |
| P0 other writes | 30 | 30 |
| P0 total | 42 | **42** |

No extra non-import P0 write was found. No audit P0 write has moved off `getOrgId` on this main. Audit `file:line` values are the `getOrgId` statement; they still match because the plugin file did not change. Tables below also cite the route registration line.

Differences from the audit, none of which change the count:

- Draft #6051's head is now `abfb1f824` (`cursor/attendance-roster-org-gate-0a5d`), not the `d0c8133d7` head the audit diffed. Its PR text says the import chain uses `getAuthenticatedOrgId` and a blank claim no longer hides the token tenant. That code is **not on this main**. All 12 import/integration writes below still call `getOrgId`. They stay in #6051.
- Rule-set and rule-template writes are already pinned with `resolveAttendanceGroupRouteActorContext` (`index.cjs:41018`, `41098`, `41195`, `40817`, `40847`). They are calculation config and they are not part of the hole.
- Leave-type writes, payroll-template writes, import template-prefs PUT, and `POST /api/attendance/report-fields/sync` still call `getOrgId`. The audit classifies them P2. They are not in the 42 and not in these slices.
- `POST /api/attendance/auto-shift-matching/preview` and `POST /api/attendance/report-fields/formula/preview` call `getOrgId` and do not persist a config row. They stay P1 / P2.

### Import / integration P0 (out of scope, #6051)

Org resolution for each row is `getOrgId(req)` unless noted. Permission is the route wrapper.

| Method + path | Route line | `getOrgId` line | Permission |
| --- | --- | --- | --- |
| `POST /api/attendance/import/upload-artifact` | 31456 | 31460 | import or admin |
| `POST /api/attendance/import/upload` | 41496 | 41500 | import or admin |
| `POST /api/attendance/import/prepare` | 41563 | 41567 | prepare gate, after `getOrgId` |
| `POST /api/attendance/import/preview` | 41595 | 41605 | prepare gate |
| `POST /api/attendance/import/commit` | 42137 | 42147 | prepare gate |
| `POST /api/attendance/import/preview-async` | 42519 | 42534 | import or admin |
| `POST /api/attendance/import/commit-async` | 42672 | 42687 | import or admin, and `fullImport` |
| `POST /api/attendance/import` | 42891 | 42901 | prepare gate, after `getOrgId` |
| `POST /api/attendance/integrations` | 43159 | 43168 | `attendance:admin` |
| `PUT /api/attendance/integrations/:id` | 43197 | 43206 | `attendance:admin` |
| `DELETE /api/attendance/integrations/:id` | 43259 | 43263 | `attendance:admin` |
| `POST /api/attendance/integrations/:id/sync` | 43335 | 43344 | import or admin; `resolveAttendanceImportActor` runs after `getOrgId` |

`POST /api/attendance/import/rollback/:id` (`index.cjs:43869`) already uses `getAuthenticatedOrgId`. Not a finding.

## Non-import P0 slices

Slice 1 is the config surface: one `attendance:admin` code, a row insert/update/delete, no actor membership check. Later slices are operational writes. Several of those prefer `body.orgId` with `||` before `getOrgId`, so replacing only the helper call is not enough.

### Slice 1 — calculation and authorization config (this change)

These four entry points are one slice. They share the same permission, the same `getOrgId(req)` assignment, and no membership exception. Rule-sets and rule-templates are the rest of calculation config and are already pinned, so they are not in the slice.

Line numbers below are the pre-change locations on `4189aa096`. This branch replaces each of those `getOrgId` calls with `resolveAuthenticatedAttendanceOrg`.

| Method + path | Route line | Org resolution | Permission | Exception |
| --- | --- | --- | --- | --- |
| `PUT /api/attendance/rules/default` | 40594 | `getOrgId` at 40653, then `UPDATE`/`INSERT attendance_rules` | `attendance:admin` | none |
| `POST /api/attendance/overtime-rules` | 39030 | `getOrgId` at 39040 | `attendance:admin` | none |
| `PUT /api/attendance/overtime-rules/:id` | 39086 | `getOrgId` at 39096 | `attendance:admin` | none |
| `DELETE /api/attendance/overtime-rules/:id` | 39164 | `getOrgId` at 39168 | `attendance:admin` | none |
| `POST /api/attendance/approval-flows` | 39300 | `getOrgId` at 39315 | `attendance:admin` | none |
| `PUT /api/attendance/approval-flows/:id` | 39358 | `getOrgId` at 39371 | `attendance:admin` | none |
| `DELETE /api/attendance/approval-flows/:id` | 39434 | `getOrgId` at 39438 | `attendance:admin` | none |
| `POST /api/attendance/scheduler-scopes` | 46810 | `getOrgId` at 46819. Create/update schemas are `.strict()` and do not declare `orgId`, so a body `orgId` is 400 today; query and `x-org-id` still select the org | `attendance:admin` | none |
| `PUT /api/attendance/scheduler-scopes/:id` | 46861 | `getOrgId` at 46870 | `attendance:admin` | none |
| `DELETE /api/attendance/scheduler-scopes/:id` | 46925 | `getOrgId` at 46929 (soft-delete `UPDATE`) | `attendance:admin` | none |

`GET /api/attendance/rules/default` and `GET /api/attendance/approval-flows` already use `resolveAttendanceGroupRouteActorContext`. `GET` overtime-rules, `GET` one overtime rule, and `GET` one approval flow stay on `getOrgId` and are P1/P2 reads, out of scope.

### Slice 2 — annual leave balance writes

Target-user membership in the **claimed** org is not an actor-membership check. Actor `user_orgs` is not consulted (`index.cjs` comment near the manual-adjustment helper, audit citation `19878-19893`).

| Method + path | Route line | Org resolution | Permission | Exception |
| --- | --- | --- | --- | --- |
| `POST /api/attendance/annual-leave-manual-adjustment` | 50533 | `getOrgId` at 50559. Zod body has no `orgId`; the raw body is still read by `getOrgId` | `attendance:admin` | none |
| `POST /api/attendance/annual-leave-expiry-backfill` | 50589 | `getOrgId` at 50604 | `attendance:admin` | none |
| `POST /api/attendance/annual-leave-accrual/run` | 50619 | `getOrgId` at 50635 | `attendance:admin` | none |

### Slice 3 — payroll cycles

Payroll **templates** are P2 and stay out.

| Method + path | Route line | Org resolution | Permission | Exception |
| --- | --- | --- | --- | --- |
| `POST /api/attendance/payroll-cycles` | 44321 | `getOrgId` at 44331 | `attendance:admin` | none |
| `POST /api/attendance/payroll-cycles/generate` | 44437 | `getOrgId` at 44447 | `attendance:admin` | none |
| `PUT /api/attendance/payroll-cycles/:id` | 44551 | `getOrgId` at 44561 | `attendance:admin` | none |
| `DELETE /api/attendance/payroll-cycles/:id` | 44699 | `getOrgId` at 44703 | `attendance:admin` | none |

### Slice 4 — auto-absence, holiday sync, auto-shift apply, reminders

`targetOrgId = parsed.data.orgId || getOrgId(req) || DEFAULT_ORG_ID` means a non-empty body org wins even if `getOrgId` is later replaced. The whole expression has to be pinned. `fullAdmin` from `attendance:admin` returns before any scheduler-scope row is required (`index.cjs:25732-25735`, `25804-25807`).

| Method + path | Route line | Org resolution | Permission | Exception |
| --- | --- | --- | --- | --- |
| `POST /api/attendance/auto-absence/run` | 49421 | `parsed.data.orgId \|\| getOrgId(req) \|\| DEFAULT_ORG_ID` at 49457 | `attendance:admin` | none |
| `POST /api/attendance/auto-absence/scheduled-runs/:runId/abandon` | 49511 | `parsedBody.data.orgId \|\| getOrgId(req) \|\| DEFAULT_ORG_ID` at 49530 | `attendance:admin` | none |
| `POST /api/attendance/holidays/sync` | 49565 | `getOrgId` at 49574. Holiday list/create/update/delete already use the group actor | `attendance:admin` | none |
| `POST /api/attendance/auto-shift-matching/apply` | 47543 | `getOrgId` at 47553, then `resolveAttendanceSchedulerScopeActor` (itself `getOrgId`). `fullAdmin` skips scope rows | `attendance:admin` | none |
| `POST /api/attendance/manual-missed-punch-reminders/enqueue` | 31002 | `getOrgId` at 31028. No `withPermission`. `loadAttendanceSchedulerScopesForAction('remind')`; `fullAdmin` skips scopes. Body schema is `.strict()` so body `orgId` is 400; query and header still select | none on the wrapper | none |

### Slice 5 — report sync and formula writes

| Method + path | Route line | Org resolution | Permission | Exception |
| --- | --- | --- | --- | --- |
| `POST /api/attendance/report-sync-jobs` | 49827 | `getOrgId` at 49832 | `attendance:admin` | none |
| `POST /api/attendance/report-sync-jobs/:id/run-next-page` | 49886 | `getOrgId` at 49891 | `attendance:admin` | none |
| `POST /api/attendance/report-sync-jobs/:id/cancel` | 49920 | `getOrgId` at 49925 | `attendance:admin` | none |
| `POST /api/attendance/report-records/sync` | 49978 | `getOrgId` at 49982 | `attendance:admin` | none |
| `POST /api/attendance/report-period-summaries/sync` | 50078 | `getOrgId` at 50082 | `attendance:admin` | none |
| `PATCH /api/attendance/report-fields/:code/formula` | 50243 | `getOrgId` at 50268 | `attendance:admin` | none |

### Slice 6 — shift-swap create and schedule-dispatch cancel

| Method + path | Route line | Org resolution | Permission | Exception |
| --- | --- | --- | --- | --- |
| `POST /api/attendance/shift-swap-requests` | 37151 | `getOrgId` at 37170. Cross-user create also allows global `canAccessOtherUsers` (`attendance:approve` or admin) | `attendance:write` | none for the actor's org |
| `POST /api/attendance/schedule-dispatch-requests/:id/cancel` | 37087 | `getOrgId` at 37091, then `resolveAttendanceSchedulerScopeActor` (`getOrgId`). `fullAdmin` skips scopes. List/create of this family already use the authenticated-org helper | no `withPermission`; scope actor | none |

Slice 6 is not the record-operation exception. Accept/reject of a shift-swap stay on the counterparty check described below.

## Legitimate multi-org exceptions (must keep working)

These call `getOrgId` (or a selector) and then require the actor's active membership, or an equivalent subject/counterparty rule. Slice 1 does not change them. A later slice must not replace them with a token-only pin.

| Route | Route line | Why a foreign org can still be valid |
| --- | --- | --- |
| `POST /api/attendance/anomaly-result-edits` | 31540 | `getOrgId` at 31573 is passed into the record-operation boundary. `resolveRecordOperationAdminActorPosture` (`index.cjs:35872-35914`) requires an active `user_orgs` row for that org. Platform `user_roles.role_id = 'admin'` skips the membership check (`35902-35903`). A delegated `attendance:admin` who is not a member is 403. |
| `POST /api/attendance/records/:id/recompute` | 31673 | Same posture. |
| `POST /api/attendance/records/:id/ops-retirement` | 31736 | Same posture. |
| `POST /api/attendance/punch` | 30066 | When body, query, or `x-org-id` names an org, `resolvePunchOrgIdV1` requires that org in the caller's active `user_orgs` (`lib/attendance-punch-org-resolution.cjs:134-140`). No admin waiver. A request with **no** selector still uses `getOrgId` (often `'default'`) and does not membership-check that fallback. |
| `POST /api/attendance/report-records/:recordId/cleaning-apply` | 31532 | `assertAttendanceCleaningActor` requires an active `user_orgs` row for the `getOrgId` org, including for admins. |
| `POST /api/attendance/requests` | 36629 | The inserted `org_id` comes from `deriveApprovalInstanceOrgIdWithSelector`, which requires the subject to be an active member of a named org. Lock and duplicate checks still see `getOrgId` first. Not an arbitrary insert. |
| `PUT /api/attendance/requests/:id`, cancel, approve, reject | 37523, 38631, 38637, 38619, 38625 | `getOrgId` is computed inside the helpers and not used as the write org. Authority uses the stored request org plus actor membership. |
| `POST /api/attendance/shift-swap-requests/:id/accept` and `.../reject` | 37444, 37450 | Consent requires the actor to be `counterparty_user_id`. |
| `POST /api/attendance/shift-swap-requests/:id/cancel` | 37456 | Modern cancel requires membership in the **request row's** org, or the actor is the requester. |

Already pinned, not exceptions and not findings: group and schedule-group routes, fixed-schedule routes, shift list/writes, rotation rules and assignments, assignment and schedule-draft writes, schedule publications, holiday list and holiday writes other than `POST /holidays/sync`, `GET /api/attendance/records` and `GET /api/attendance/calendar` (`resolveAttendanceRecordReadIdentity`).

## Helper contract for slice 1

Match draft #6051's `getAuthenticatedOrgId` and `resolveAuthenticatedAttendanceOrg` (`cursor/attendance-roster-org-gate-0a5d` @ `abfb1f824`):

- Authenticated org is the first non-blank of `user.orgId`, `user.workspaceId`, `req.authenticatedTenantId`. A blank string does not hide a later claim.
- A non-blank body, query, or `x-org-id` value is only a consistency assertion. Any mismatch is **404** `NOT_FOUND` / `Organization not found`, same as #6051's import helper.
- Blank or whitespace-only selectors are ignored.
- No authenticated org is **403** `FORBIDDEN` / `Authenticated organization not found`.
- Do not fall through to `'default'` when a token tenant exists.

`getAuthenticatedOrgId` on this main previously used `??`, so `user.orgId === ''` hid `authenticatedTenantId` and the function returned null. Slice 1 updates that function to the #6051 loop. The two copies must be reconciled when #6051 merges; the bodies should stay the same.

`getAuthenticatedAttendanceGroupEffectivePolicyOrgId` in `packages/core-backend/src/routes/attendance-admin.ts:165-172` is a separate copy. It still uses `??` for `orgId` vs `workspaceId`. This slice does not change that TypeScript helper.

Import and integration routes are not switched to the helper here.
