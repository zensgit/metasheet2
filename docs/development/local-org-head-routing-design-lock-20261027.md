# Native local department-head routing — 2026-10-27

Status: Draft / HOLD. User direction: MetaSheet must own its organization; DingTalk may match/bind to it.
Basis: origin/main5193da4c5667418a8bd9fa40a9a80021cdcac077; prior canonical-org plan §1/§5.4 and MVP done-gate25–27.
This increment closes the backend native-head relation gap. A usable organization-management UI and explicit external-binding application remain required follow-ups, not claimed delivered by this backend slice.

## Model and authority

Retain the single directory architecture/provider=local canonical anchor. No second org tree or title-based authorization.
Add directory_account_departments.is_department_head boolean NOT NULL DEFAULT false and a partial department index. It is independent of is_manager: direct manager and department head can be different people. No backfill or migration of provider raw. Existing rows default false and external sync never sets it.

Use a sibling src/directory/local-directory-department-head.ts service. Writer export setLocalMembershipDepartmentHead(orgId, {directoryAccountId,directoryDepartmentId}, enabled) returns outcome updated|not_found|archived. Getter export getLocalMembershipDepartmentHead uses the same IDs and returns its local row or null. Reader export resolveLocalDepartmentHead(integrationId, departmentExternalId, requesterLocalId, query) returns {localDepartment:boolean,headId?:string}. A local integration returns localDepartment=true even when the requested department is missing/inactive or no eligible head exists, so a local raw blob is never an alternative source. A disabled local integration resolves no head. The existing requester/legacy raw SQL statements stay byte-identical; a bounded read-only local-scope probe is added before raw fallback, not a claim of unchanged query counts. The sole writer updates an existing local membership within the existing server-resolved org. Validate account/integration/provider/org first and lock account before department in one transaction; require same integration, local providers, active integration and active account/department at the write point. Out of scope/missing404, archived409; do not create membership, bootstrap an anchor, change direct-manager flags, raw, user_orgs, permissions or existing primary semantics.

New dedicated admin GET/PATCH /api/admin/directory/local/memberships/:membershipId/department-head. GET payload is {membership:{id,accountId,departmentId,isDepartmentHead,readOnly}}; PATCH success returns {membership:{id,accountId,departmentId,isDepartmentHead}}. Existing jsonOk envelope remains {ok:true,data:...}. membershipId is the existing accountUUID:departmentUUID. PATCH body is exactly {isDepartmentHead:boolean}; wrong types/unknown keys/forged org/corp IDs400 before write. Require platform admin. GET is read-only and returns the stored flag plus readOnly for archived account/department. Existing PATCH /memberships/:id isPrimary XOR isManager contract remains byte-identical. Fixed audit action for this new mutation, no user values in errors/audit diagnostics.

## Resolution

Resolve local department ownership and candidates through a SELECT anchored to the chosen integration and department, with local-provider and same-integration checks. A local department is authoritative even with no eligible head: never fabricate provider raw for it or borrow another integration's head. Local head candidates must have an active local account, linked active local user and active same-org membership; exclude the requester by local user ID, including alias accounts. Multiple eligible flags use stable external-account-ID/account-ID order; not name/title/update-time guessing.

Single dept_head and every level of the dept-head chain use the same local selection. Preserve the existing parent walk, max depth, cycle stop, deduplication and continue-past-empty semantics. DingTalk/non-local departments retain the original raw-list selection and its order. Direct-manager and manager-chain behavior are unchanged in this increment; native manager-chain parity remains an explicit residual, not silently redefined.

Existing approval instances retain requester/assignee snapshots. Newly created approvals under an explicit local canonical policy can resolve direct_manager then dept_head without any DingTalk account. A directory-head change must not rewrite an in-flight instance; a new instance observes the new head. No automatic policy switch or external writes.

## Required proof

- Migration apply, second replay/no pending, defaultfalse/notnull/boolean/index catalog checks; down/up on an owned empty-of-fixtures clone only; preserve is_manager and protected constraints.
- Original resolver with legal new head-flag fixture: named expected head is missing (red); old local direct-manager control passes. No missing-module/missing-column/setup-failure credit.
- Real isolated PG native local direct-manager/head distinct, local no-head raw-poison ignored, self/alias/unlinked/inactive/membership-loss, same-user cross-org/integration and DingTalk compatibility.
- Actual scoped admin route set/unset/read, strict invalid-body/ID/403/404/409 negatives, raw/direct-manager/primary/membership snapshots unchanged, deterministic archive-vs-set lock barrier.
- Actual main approval create/advance with local canonical policy: two-step manager/head, in-flight frozen head vs newly created instance after role change. No full real-user UAT claim; only synthetic identities/providers.
- Matching mutations of native head authority/predicate/flag/self exclusion and write bounds must red with valid controls; exact restore. Do not weaken budget/assertions or mutate protected constraints.
- Existing affected resolver unit/head-chain neighbors and narrow manager/B6 compatibility; no repeat of unchanged full227 battery.
- Dedicated whole-file EXPECT_DB1 native CI plus no-DB exclusion and a wiring contract, actual exact-head checks/logs/sourceclean/final body. No frontend test claim.
- Production quality, explicit incremental lint, independent source review and main raw evidence audit.

## Boundaries and residuals

No merge/Ready/deploy/R71/tag/release/business config changes; Stream/lifecycle/external writes OFF, real UAT/50004 excluded, historical08PUT INCONCLUSIVE.
No online organization read/write, real demo-person mapping, blanket act grants, template publication or auto-binding. Existing local-account enrollment/offboarding guard is not weakened. Active-member enrollment UX, native organization UI, native manager-chain parity and explicit binding-application workflow remain open parent work.

## Concurrent integration status refinement

The writer locks its same-org local integration `FOR SHARE OF i` before the existing account-before-department row-lock order, and binds the account to that locked integration. A disable that commits first yields not_found/404 without changing the head bit; a writer that locks first completes before a competing disable can update integration status. This serializes this new endpoint only; the existing B3 manager writer is unchanged. Original candidate actual200/true after committed disable and matching correctness red/control are retained.

Fixture provisioning rejects a pre-existing disabled-only default local anchor before creating any identity, rather than reviving it. This is an explicit fixture precondition, never a skip or product enrollment change. Dedicated native source now declares20 cases: sentinel1 and19 controlled DB/HTTP cases. Earlier17-case and focused phases remain separate evidence.
