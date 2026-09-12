# Attendance import scope follow-up: development

Status: local implementation and verification; no merge or deployment authorization implied.

## Baseline and scope

- Base: `1c22d3b328f377dface03b222bf57d09f4b7dec0`.
- Publication catch-up: `9fb29831c33abba5eac1a5d64adbe62d915676c2`; the intervening change is two takeover documents, with no repair-path overlap. Fresh checks and independent review are required on the resulting PR head.
- Follows the prepare-token organization fix in PR #5673, merge `23fd5942bbd58f4a45aaa11440e76b6e3532e35f`.
- Refs #4556. This work does not change its acceptance contract or authorize closure.
- Staging run `34684405380` proved preview/commit can succeed while later job polling, batch reads and CSV export fail for a nondefault synthetic organization. Business rollback was not reached in that run.

## Contract

The five import job/batch GET handlers now use the existing authenticated record-read identity boundary. Optional organization selectors must match the authenticated tenant; they cannot select another tenant, including for a platform administrator. Missing authenticated tenancy refuses access. Rollback continues to use authenticated session organization and ignores body/query organization. This is a scoped read-side correction, not a claim that every import write/integration route has been audited or changed.

1. Async preview and commit polling retain the payload organization; manual refresh/resume reuse the recorded job organization, not a subsequently changed selector. Older job responses without `orgId` retain the request organization.
2. Batch details, full-impact pagination, CSV export and export fallback use the selected batch organization. When metadata lacks it, the list request organization is retained. Before rollback, a fresh `/api/auth/me` must match the target organization; missing, mismatched or expired sessions refuse before POST, without automatic session switching or redirect. No organization is placed in the rollback body. Explicit rollback options are the fallback before the last list organization.
3. Pagination/export capture scope before awaiting, so a concurrent list change does not retarget later pages. Callers may omit the optional selector, but the five server readers still require authenticated tenancy; no literal default organization is introduced.
4. Post-import batch reload uses the imported payload/job organization.
5. Ops probes carry their configured organization through job/batch reads and exports, validate the authenticated organization before writes and revalidate before rollback. Strict verification navigates to Overview and expands its actual request-tools details panel before filling the date control through normal UI interaction.

## Implementation

- `apps/web/src/views/AttendanceView.vue`: live async job polling, scope retention and batch reload.
- `apps/web/src/views/attendance/useAttendanceAdminImportWorkflow.ts`: same correction in the extracted workflow, which is not treated as proof of the live shell.
- `apps/web/src/views/attendance/useAttendanceAdminImportBatches.ts`: batch organization resolution, selected-scope retention, scoped requests and fixed-scope pagination.
- Existing specs cover both the mounted live shell and composables. The batch spec is added to the explicit required-web batch; it already exists in the domain web guard.
- OpenAPI job GET documents optional matching `orgId`; regenerated dist and SDK agree. Existing endpoint URLs, role permissions, schemas, migrations and flags are unchanged.
- Five existing plugin readers (job, batch list/detail/items/export) share `resolveAttendanceRecordReadIdentity`; the existing records/calendar logic is not altered. This supersedes the earlier incorrect claim that role permission alone established organization authorization.
- A new backend unit suite invokes the real registered plugin handlers with deterministic query doubles. Permission bypass isolates the tenant boundary; same-org positives and mismatched/missing identity negatives verify the selected SQL scope or no import SQL. It is not a real-PostgreSQL result.
- Five existing real-PostgreSQL positive fixtures that cross the corrected GET readers now mint their test JWT with the fixture's known organization. The production resolver remains fail-closed; pure-write fixtures were deliberately left unchanged. This is test identity repair, not a permission bypass or product fallback.
- `attendance-smoke-api.mjs`, `attendance-import-perf.mjs` and the production-flow verifier retain organization scope. The small shared `attendance-import-scope.mjs` validates the `/auth/me` envelope using the backend's authenticated organization precedence.
- The existing strict contract suite exercises both polling functions, session refusal and its positive control, batch URL expressions, and request-panel navigation. These are local function/contract tests, not remote browser acceptance.

## Review correction

Independent review caught an initial incorrect rollback assumption: adding `orgId` to its body cannot affect the session-scoped backend. That patch was removed and replaced by the session precheck above. The first new negative tests also used an unsupported local Vitest matcher; the assertions were split. A second review required suppressing the API wrapper's automatic unauthorized redirect so the neutral refusal remains on-page.

Fresh CI on `c9eddbd032f60ee3a54c8ea1097b6ea7ae3f8262` exposed five older positive fixtures whose dev tokens omitted `tenantId`. The corrected readers therefore refused them with 403 before their intended 404/200 assertions. Commit `0c18c87a5cc6523f43b5c1fc1b7731c09fba548d` adds the already-known fixture organization to exactly those token sources. It does not weaken the authenticated-tenant boundary.

## Delivery boundaries

Approval/workflow automation can continue independent development and isolated testing. Main merges and shared staging changes retain their own authorization. A future attendance staging retest must pin its deployed product SHA, use isolated synthetic organizations and keep rollout/shadow flags OFF. This patch does not itself run that retest.

Public staging DNS remains a separate operational blocker. A runner hosts mapping from the earlier run was functional-test transport, not a DNS repair. No DNS, staging, production, credentials or scheduler settings were changed here.

See the companion verification MD for measured results and remaining gates.
