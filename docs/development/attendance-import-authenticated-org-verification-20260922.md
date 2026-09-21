# Attendance import authenticated-organization verification

Status: **SOURCE AUDIT IN PROGRESS / OWNER DECISIONS OPEN / IMPLEMENTATION NOT STARTED**

Baseline: `origin/main@cd42eaf7455f03dd99021a02c47c42f1f3db6484`.

Companion draft:
`docs/development/attendance-import-authenticated-org-design-lock-20260922.md`.

## 1. Scope and evidence class

This report records source-level business and security review. It is not a code
gate, CI result, staging result or authorization to implement. All runtime test,
mutation, publication and deployment rows remain NOT RUN.

The canonical checkout was not modified. Review and documents use isolated
worktree `codex/attendance-qa-org-scope-20260921`.

## 2. Baseline checks

| Check | Result |
| --- | --- |
| Fresh worktree baseline | PASS: HEAD equals `origin/main` at `cd42eaf7455f03dd99021a02c47c42f1f3db6484` |
| #4688 / W4C-3a duplication check | PASS: `9ce340e0f feat(attendance): complete W4C-3a import and rollback (#4688)` is in `origin/main` |
| Historical #5676 status | Draft branch inspected as hypothesis; not treated as current authorization or transferable gate evidence |
| Independent adversarial source review | COMPLETE: found the RATIFIED template-preferences conflict, omitted routes and OpenAPI/actor-identity gaps; this revision records them as blockers rather than choosing silently |
| Runtime edits | NONE |
| Database/staging/flags | NOT RUN / NOT CHANGED |

## 3. Source trace

| Layer | Anchor | Observed behavior |
| --- | --- | --- |
| JWT identity | `packages/core-backend/src/auth/jwt-middleware.ts` around authenticated tenant assignment | Verified token tenant is copied to `req.authenticatedTenantId` before legacy header fallback. |
| Generic org resolver | `plugins/plugin-attendance/index.cjs:getOrgId` around L6477 | Body/query organization takes precedence; then user/workspace/header; finally default org. |
| Authenticated org resolver | `plugins/plugin-attendance/index.cjs:getAuthenticatedOrgId` around L6487 | Uses user/workspace/token tenant and returns null when absent, but does not assert that every alias equals the verified token tenant. It is not sufficient by itself. |
| Strict record-read identity | `plugins/plugin-attendance/lib/attendance-record-read-identity.cjs` | Requires authenticated user and token tenant, then checks body/query/header/user/workspace aliases for equality. This is the closest existing precedent, not yet the import-lifecycle implementation. |
| Import actor | `resolveAttendanceSchedulerScopeActor` and `resolveAttendanceImportActor` around L25726/L26243 | Uses generic user/org resolvers; admin/import permissions are checked independently of authenticated tenant binding. |
| Artifact upload | `/api/attendance/import/upload-artifact` around L31458 | Uses generic organization and user resolvers before persisting an organization-owned artifact. |
| Template preferences | routes around L41420/L41442 and the RATIFIED template-preferences lock | Intentionally accept request organization for multi-organization administration; this conflicts with a universal session-org-only rewrite. |
| Upload | `/api/attendance/import/upload` around L41498 | Uses request-selected org for filesystem path and metadata ownership. |
| Prepare and synchronous preview/commit | routes around L41565/L41597/L42139 | Commit token and data access use request-selected org. |
| Async enqueue | routes around L42521/L42674 | Uses the import payload and current generic org resolution; creates org-owned jobs. |
| Job and batch readers | routes around L42865/L43602-L43717 | Current main uses generic org resolution. |
| Legacy synchronous import | `POST /api/attendance/import` around L42893 | Uses generic organization resolution and belongs to the same ownership inventory. |
| Rollback | `/api/attendance/import/rollback/:id` around L43861 | Already uses authenticated user/token subject/org and values-free refusal semantics. |
| Integration administration/sync | routes from around L43115 | Also use generic organization and actor resolvers, but carry separate external-integration contracts; this draft records them as a distinct residual, not an implicit shared-resolver change. |
| UI session identity | `AttendanceView.vue` around L12406 and `useSessionOrg.ts` | Auth principal change marks page stale; org switching issues a replacement token. |
| UI import lifecycle | `AttendanceView.vue` around L20089-L20500 plus `useAttendanceAdminImportWorkflow.ts` and `useAttendanceAdminImportBatches.ts` | Prepare/preview carry payload org, current job polling omits org, and editable page org and session org are distinct state. Both extracted composables remain part of the final implementation audit. |
| OpenAPI | `packages/openapi/src/paths/attendance.yml` around L3728-L3913 and `packages/openapi/src/base.yml` around L1406 | The documented template/upload/prepare/preview/commit/async/job/legacy routes do not define selector-as-assertion semantics. Upload-artifact, template preferences, batch/detail/items/export and rollback are absent from the current contract. `AttendanceImportRequest.orgId` remains an unconstrained tenant field. |
| Strict workflow credential | `.github/workflows/attendance-strict-gates-prod.yml` around L256-L294 | One `ATTENDANCE_ADMIN_*` credential resolves to `AUTH_TOKEN` and is reused by API smoke and browser flows. The workflow does not prove that this principal is delegated rather than platform-admin. |
| Strict provisioning | `scripts/ops/attendance-run-gates.sh` around L154-L172 | Optional provisioning uses the same `AUTH_TOKEN` to assign employee, approver and attendance-admin roles before the same run exercises product behavior. Bootstrap authority and business-test authority are not separated. |
| Strict API smoke | `scripts/ops/attendance-smoke-api.mjs` around L399-L455 and L515-L847 | The smoke verifies tenant and feature mode, then runs admin/import lifecycle operations, but does not reject a platform-admin principal. A green run can therefore mask delegated-admin contract gaps. |

## 4. Refutation of the narrow repair

Historical Draft PR #5676 changes five GET readers to the authenticated record
read identity, carries organization through UI/ops follow-ups, and adds useful
same-org/mismatch/missing tests. Its own development document states that it is
only a read-side correction and does not claim that all import write/integration
routes were audited.

That limitation is material on current main:

1. upload chooses its storage path and metadata owner from `getOrgId`;
2. prepare binds the commit token to `getOrgId`;
3. preview/commit and async enqueue use `getOrgId` for organization-owned data;
4. only the follow-up GETs would move to authenticated tenancy;
5. rollback is already session-scoped;
6. upload-artifact and legacy synchronous import would remain on request-selected
   identity; and
7. integration administration/sync would remain an explicitly separate residual.

Therefore a direct port can make one lifecycle alternate between request-selected
and session-selected organizations. The old PR is reviewer input only; it is not
the implementation plan.

## 5. Business matrix to prove after ratification

| Case | Expected | Runtime evidence |
| --- | --- | --- |
| Delegated importer, same authenticated org | Full authorized lifecycle succeeds | NOT RUN |
| Same actor, any body/query/header/user/workspace alias points to org B | `403` before import source access | NOT RUN |
| Same-org actor requests foreign job/batch id | Values-free `404` | NOT RUN |
| Platform admin with explicit session org | Same contract as that org | NOT RUN |
| Platform admin supplies arbitrary org selector without switching session | `403` | NOT RUN |
| Scheduler-scoped-only actor uses async/batch/rollback | `403` pending separate ratification | NOT RUN |
| Session org switches while polling | Page becomes stale; no further request under new principal | NOT RUN |
| Same-org second full importer accesses org-wide batch | Allowed per W4C-3a | NOT RUN |
| Missing authenticated tenant | `403`, no default/header fallback | NOT RUN; owner compatibility decision open |
| Template-preferences request selects another administered org | Preserve or reject only after OD-IA-4 | NOT RUN; RATIFIED contract conflict open |
| Integration sync selects another org | No claim in this slice | NOT RUN; separate tenancy audit required |
| Strict smoke uses delegated tenant admin | Full lifecycle succeeds without platform-admin bypass | NOT RUN; current workflow does not prove principal posture |
| Strict smoke receives platform-admin exercise bearer | Fail before product side effects | NOT RUN; regression test required |

## 6. Planned verification commands

Commands will be copied from the final touched workflows after implementation;
the exact list is intentionally not claimed as executed. Expected minimum:

```sh
pnpm --filter @metasheet/core-backend exec vitest run <focused unit files>
NODE_ENV=test pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run <focused DB files>
pnpm --filter @metasheet/web exec vitest run --watch=false <focused import specs>
bash apps/web/scripts/run-required-web-tests.sh
node --test <strict/import ops contract tests>
pnpm openapi:build
pnpm openapi:guard
git diff --check
```

Required mutations:

1. restore body/query organization authority on one write route;
2. restore it on one read route;
3. remove selector mismatch refusal;
4. give scheduler-scoped-only actor async access;
5. elevate the strict synthetic actor to platform admin;
6. continue polling after session-principal change.
7. wire the bootstrap/platform credential into strict API smoke;
8. remove the delegated-principal posture check.

Each mutation must turn only its matching regression red, then be fully restored.

## 7. NOT RUN and residuals

- No runtime code or tests were changed.
- No PostgreSQL, browser, Windows package, staging, CI or deployment validation
  was run for this draft.
- No exact-head independent implementation gate exists yet.
- OD-IA-1 through OD-IA-5 are business/scope/compatibility decisions.
  Implementation must not start by silently choosing any of them.
- Historical CI and staging results from #5676 or the earlier candidate do not
  transfer to a future implementation head.
- The earlier staging failure is a reported observation only. It was not
  reproduced from this worktree and is not counted as current verification.
- Route inventory is not yet mechanically enforced. A future implementation
  must classify every `/api/attendance/import*` route before this report may be
  promoted from source-audit status.
