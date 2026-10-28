# Attendance import authenticated-organization design lock

Status: **DRAFT / NOT RATIFIED / NO RUNTIME AUTHORIZATION**

Baseline: `origin/main@cd42eaf7455f03dd99021a02c47c42f1f3db6484`.

Refs: #4556, historical Draft PR #5676. This document does not authorize Ready,
merge, deployment, migration, flags, staging, soak, production/customer data, or
closure of #4556.

## 1. Problem statement

Prior staging reporting says that a non-default synthetic organization completed
the import write path while later async job and batch reads failed. That report
has not been reproduced on this baseline and is a hypothesis for the eventual
staging gate, not durable proof. Source inspection nevertheless shows that a
narrow caller fix which adds `orgId` to follow-up URLs is insufficient: current
runtime organization selection is not uniform across the import lifecycle.

`plugins/plugin-attendance/index.cjs:getOrgId` gives request body/query selectors
precedence over the authenticated user and header. The import upload, prepare,
preview, commit, async enqueue, job and batch paths use this resolver at multiple
sites. By contrast, rollback already uses `getAuthenticatedOrgId`, and JWT
middleware preserves the verified token tenant in `req.authenticatedTenantId`.
That helper is still weaker than the record-read boundary: it may accept
user/workspace aliases without proving that every supplied alias equals the
token tenant.

Historical Draft PR #5676 changes five GET readers to the authenticated record
read boundary but explicitly does not audit the write/integration routes. Porting
it as-is would produce a split contract: reads use authenticated tenancy while
prepare/preview/commit/upload can still select an organization from request data.

## 2. Existing authoritative and current constraints

The following are inputs to this draft, not newly invented permissions:

1. W4C-3a is already in main as `9ce340e0f` (#4688). The durable amendment says
   a full import is organization/key-wide for authorized full importers and that
   cross-organization callers must not observe or replay it.
2. The tracker keeps async import jobs, batches, rollback, templates, uploads and
   integrations admin/importer-only until a separate scheduler-scope design is
   ratified. A scheduler-scoped actor passing synchronous prepare/preview does
   not thereby gain async job/batch/rollback authority.
3. Current record-read behavior treats authenticated token organization as the
   tenant identity and optional selectors as equality assertions. It does not
   grant a platform administrator an implicit cross-tenant exception.
4. Current rollback resolves authenticated user, token subject and authenticated
   organization, then scopes the host rollback port with those identities.
5. `AttendanceView.vue` freezes the page to the auth principal through
   `provideAttendanceSessionGuard`; a session-organization switch marks the page
   stale and requires reload. This is the current safe behavior for an import in
   progress.
6. The RATIFIED template-preferences lock intentionally treats organization as
   a request parameter for legitimate multi-organization administration. That
   contract conflicts with a universal session-organization-only rule and may
   not be silently rewritten by this draft.

## 3. Proposed business contract

These rules are proposed for owner ratification before runtime implementation.

### 3.1 Organization authority

1. For the core import lifecycle, tenant authority is the verified token tenant
   copied to `req.authenticatedTenantId`, not whichever value happens to be on
   `req.user`. Body/query `orgId`, `x-org-id`, `x-tenant-id`, `req.user.orgId`
   and `req.user.workspaceId` are optional aliases only. When present, each must
   equal the token tenant.
2. A selector conflict returns values-free `403 FORBIDDEN` before reading an
   upload, job, batch, record, rule set or other organization-owned source.
3. Missing authenticated organization returns values-free `403 FORBIDDEN`; it
   must not fall back to `DEFAULT_ORG_ID` or an unverified header.
4. Platform administrators do not implicitly pierce tenant isolation. In this
   slice they must switch to an explicit session organization before import.
   A global import mode would be a separate capability and design lock.
5. The import actor is `req.user.id`. `x-user-id` may only assert equality and
   cannot replace the authenticated actor on this lifecycle.
6. Neither generic `getOrgId` nor current `getAuthenticatedOrgId` by itself
   implements this contract. Implementation must use a narrow import-lifecycle
   resolver equivalent to the strict record-read identity boundary; global
   resolver semantics remain unchanged.

### 3.2 Resource lifecycle and ownership

1. Upload, commit token, async job and batch freeze `org_id` at creation from the
   authenticated organization.
2. Preview/commit may reference only uploads and commit tokens with that same
   frozen organization and authenticated actor contract.
3. Job polling, batch list/detail/items/export and rollback derive organization
   again from the current authenticated session and query by both resource id and
   organization. They do not trust organization echoed by an earlier response.
4. A valid actor in organization A requesting an identifier owned by organization
   B receives values-free `404 NOT_FOUND`; the response does not reveal that the
   foreign resource exists.
5. Authorized full importers in the same organization may observe and operate on
   organization-wide full-import batches according to the W4C-3a contract. This
   is not creator-only ownership.
6. Rollback remains session-bound. Body/query organization is ignored as an
   authority and, if supplied, must match the authenticated organization before
   the resource lookup.
7. Changing session organization invalidates in-memory job/batch state. The user
   reloads and re-enters the import surface under the new session; an old job id
   must not be silently retargeted.

### 3.3 Roles

| Actor | Synchronous prepare/preview/commit | Async job/batch/export/rollback | Cross-org selector | Expected result |
| --- | --- | --- | --- | --- |
| Same-org platform admin | Allowed after explicit session-org selection | Allowed | Denied | 2xx or resource result |
| Same-org `attendance:admin` | Allowed | Allowed | Denied | 2xx or resource result |
| Same-org `attendance:import` actor | Allowed | Allowed where the current admin/importer contract permits | Denied | 2xx or resource result |
| Scheduler-scoped actor without central import/admin grant | Existing synchronous scoped behavior only | Denied until separately ratified | Denied | `403` on async surfaces |
| Authenticated actor in another org | Denied | Hidden | Denied | selector conflict `403`; foreign id `404` |
| Missing authenticated user | Denied | Denied | N/A | `401` |
| Missing authenticated org | Denied | Denied | N/A | `403`; no default/header fallback |

### 3.4 Status and error semantics

| Condition | Status | Information boundary |
| --- | --- | --- |
| No authenticated user | `401` | No organization/resource lookup |
| Missing authenticated organization | `403` | No default org and no import lookup |
| Body/query/header organization conflicts with session | `403` | Values-free; before source/resource SQL or file access |
| Authenticated org matches, malformed resource UUID | `400` | Existing validation contract; no resource SQL |
| Well-formed job/batch id absent from current org | `404` | Same body for nonexistent and foreign-org ids |
| Role lacks async import permission | `403` | Does not reveal resource existence |
| Stale/invalid rollback actor or token subject | Existing values-free `403` | No rollback mutation |

### 3.5 Strict QA principal separation

1. The bearer used for import, admin-surface and browser assertions is a
   tenant-bound delegated `attendance:admin`, not a platform administrator.
2. If setup needs platform authority to create the synthetic user or assign its
   role, that bootstrap credential is a separate input. It is never forwarded to
   import smoke, Playwright or evidence generation.
3. Before side effects, `/auth/me` must prove the delegated principal's exact
   tenant and non-platform posture. A platform-admin bearer fails the strict run;
   changing its label or environment-variable name is not evidence.
4. The delegated principal and a second-organization synthetic principal provide
   the positive and negative controls. Setup success under the bootstrap bearer
   cannot substitute for either business assertion.

## 4. UI and ops behavior

1. The import surface may display an organization selector, but the selector is
   not authority. It must match the session organization before prepare, upload,
   preview, commit, polling, batch reads, export or rollback.
2. Job and batch responses may retain `orgId` for display and consistency checks.
   Clients must not use it to override a later authenticated session.
3. The existing session guard stays load-bearing. After a session-org switch the
   page is inert until reload; polling and rollback do not continue under the new
   principal.
4. Strict and import QA use a delegated same-org synthetic admin/importer plus a
   second synthetic organization negative. Elevating the actor to platform admin
   is not an acceptable way to make the test pass.
5. QA cleanup is scoped to the isolated synthetic organization and reports
   append-only evidence separately from mutable residue.

## 5. Minimal implementation boundary after ratification

1. Add one import-specific authenticated actor resolver; do not change global
   `getOrgId` semantics in this slice.
2. Apply it to the complete core lifecycle inventory: template/template.csv,
   upload-artifact, upload, prepare, preview, commit, preview-async,
   commit-async, job polling, legacy `POST /api/attendance/import`, batch
   list/detail/items/export and rollback. Every in-scope route must use the same
   token-tenant and authenticated-actor contract.
3. Template preferences remain outside the runtime change until OD-IA-4 amends
   or preserves their RATIFIED multi-organization contract. Integration
   administration and integration sync remain outside this slice under OD-IA-5;
   both surfaces must be listed as residuals rather than changed incidentally
   through a shared resolver.
4. Preserve existing role/scheduler-scope decisions; do not broaden scheduler
   async access.
5. Update OpenAPI for every documented in-scope route and add the currently
   undocumented in-scope routes. `AttendanceImportRequest.orgId` must be defined
   as an equality assertion, not tenant authority.
6. Update `AttendanceView.vue`, both extracted import composables and ops probes
   only where needed to preserve the frozen lifecycle and session-stale
   behavior.
7. Do not add migrations or flags unless the implementation proves they are
   unavoidable; none are expected from this contract.

## 6. Completion gates

1. Business matrix above is ratified or every changed row has an explicit owner
   decision.
2. Two-organization real-PostgreSQL tests cover upload/token/job/batch/rollback
   ownership, same-org positive controls and cross-org negatives.
3. Each alias source (body, query, `x-org-id`, `x-tenant-id`, user org,
   workspace org and `x-user-id`) has a mismatch negative proving zero import
   SQL/file access.
4. Platform-admin positive requires explicit session organization; no hidden
   global bypass exists.
5. Scheduler-scoped-only actor remains denied on async/batch/rollback routes.
6. UI tests cover org retention, session switch invalidation, polling, export and
   rollback. New specs are wired into both attendance web guard and required web
   tests.
7. Ops strict/import probes run with delegated org scope and a second-org
   negative; platform-admin elevation mutation must fail the contract test.
8. Guard mutations independently restore request-selector authority on a write
   route and a read route; each matching test must turn red.
9. Focused checks, neighbors, OpenAPI build/guard and exact-head independent
   review report zero P1/P2 before any Ready or merge request.
10. A mechanical route inventory accounts for every `/api/attendance/import*`
    route as in-scope, explicitly deferred, or proven organization-neutral. A
    newly added route without a classification fails closed.
11. Strict QA has separate bootstrap and exercise credentials. A wiring mutation
    that passes the bootstrap credential to API smoke or Playwright must fail.

## 7. Owner decisions still open

| ID | Decision | Recommended value | Why it is not silently chosen |
| --- | --- | --- | --- |
| OD-IA-1 | Platform admin imports by explicit session-org switch, or add an explicit global import mode | Explicit session-org switch | Existing import/OpenAPI behavior accepts request `orgId`, while record-read precedent forbids implicit cross-tenant access. |
| OD-IA-2 | Tokens/callers without authenticated tenant fail closed, or retain a bounded legacy compatibility path | Fail closed for all import lifecycle routes | Existing test fixtures and older scripts have relied on missing tenant/default/header behavior. Changing them is intentional compatibility work. |
| OD-IA-3 | Scheduler-scoped actors gain async job/batch/rollback access | Keep deferred | The current tracker explicitly defers this capability pending a separate design lock. |
| OD-IA-4 | Replace the RATIFIED request-selected organization contract for template preferences with token-tenant authority | Do not change in this slice; prepare a separate amendment if product intent changed | The existing template-preferences lock explicitly supports multi-organization administration. This draft cannot override it. |
| OD-IA-5 | Include integration administration/sync in this lifecycle repair | Defer to a separate integration tenancy audit | Those routes also use generic organization and actor resolvers, but they have distinct credentials and external-I/O contracts. Pulling them into this repair would expand the security and business surface. |
