# Platform role unassignment transaction boundary

## Scope and acceptance

Candidate for independent design review before implementation. Adapt only the existing POST /api/admin/users/:userId/roles/unassign database transaction. Keep the already accepted assign command unchanged; do not introduce a generic role-command framework or migrate delegation, attendance, batch, purge, projection, registration or role deletion here. W01/W02/W03/W08 and namespace-admission writers remain pending, not globally converted by this caller.

Existing source checkpoint: HEAD e0c5107389cad93259d03fc4414366c94a0b5079 plus locally verified P1c/P1d changes. Current assign and the original shared role writer are references, not a replacement for reading the actual unassign route and last-administrator predicate. All source and test evidence must be repinned for this increment. No flag, schema, login capability or production-owner policy is added.

## Preserve the existing accepted set

- Retain authenticate/ensurePlatformAdmin, String/trim processing, required-field order and profile precheck. Do not apply the separate direct-permission canonical-ID policy to this route.
- Retain writable-target rules: missing/recycled/purged refused; inactive or pending targets remain writable.
- Keep default locked authority: active, activated, non-recycled actor with raw admin OR live RBAC admin membership. Do not substitute is_admin, token or wildcard, add a disabled-raw-role veto, or narrow to membership-only.
- Admin removal must retain the exact isLastSignInPlatformAdmin semantics, including its distinct self/backup predicates. Do not reinterpret it as password, provider or complete usable-session verification. Keep LAST_PLATFORM_ADMIN409 and the original refusal priority ahead of target/actor checks.
- A missing role parent still permits removal of an existing orphan membership. Do not require a held row for that branch, create a role, trim stored historical rows or change unrelated orphan data.
- Retain the exact unassignUserRoles/W03 cleanup, namespace derivation, disableNamespaceAdmissionsWithoutRoles special attendance opt-out and legacy admin demotion. Do not supersede deprovision evidence, grant admission or mutate another user's access.

## Closed command and fixed lock plan

New src/admin/platform-role-unassign-command.ts exports only unassignPlatformUserRoleCommand({ actorId, userId, roleId }). It accepts data only, not tx/runner/plan/scope/work/hook callbacks; returns { blocked:true } or { blocked:false, membership, disabledNamespaces } without transaction capabilities. Snapshot scalar inputs before awaiting and build a fresh deeply frozen context/plan for fixed platform-role-unassign and REVOKE_ROLE.

The plan declares the action role, the complete sorted/deduplicated actor-target union in users, admission subjects and both witness lists, and platformAdminInvariant:true exactly when roleId is admin. Use the default self-built entry: RC, R0 shared, optional R1, action-role R2R SHARE, complete R3, complete R5. No takeover, world upgrade, identity slot, late discovered parent lock or arbitrary callback extension to the core engine.

Validate genuine open brand bound to tx, exact per-call plan/action/intent/world/freeze and expected complete subject/role/R1 shape. Planned roleRows must contain exactly the action role and an actual held or missing result. After normal missing-target/actor refusals, a successful mutation requires both actual held user rows and actual user/admission witnesses; born cannot substitute. Missing parent is an explicit compatible branch, not a forged held claim.

The old route evaluates its last-admin check immediately after R1, before parent/subject acquisition. The new self-built entry acquires its entire immutable plan before invoking work. **Explicit engineering difference:** a busy parent or subject may now preempt the old last-admin refusal, and that refusal can occur while these already-declared locks are held. No accepted write is expanded and the business check still runs first inside work, under the original R1 through commit. This candidate does not claim identical lock traffic or contention timing. Independent review must refute concrete wait cycles against existing status/recycle/admin-demotion paths before acceptance; do not add a generic early-work callback merely to preserve no-op lock traffic.

Within work:
1. Validate context and, for admin, assert R1 was declared before calling the original isLastSignInPlatformAdmin. A blocked result returns before shared business DML, audit or cache invalidation.
2. Preserve writable-target refusal before actor authority. Use actual locked actor and the existing default helper, preserving its original ordinary role read and SQL-error behavior.
3. When authority depends on membership rather than raw admin, reread the exact actor/admin child edge FOR SHARE. Use the same explicit local 5000ms lock/10000ms statement budget: save, set, read, restore on success/no edge; on SQL failure rollback without restore SQL in an aborted transaction. Raw-admin still succeeds without an admin edge.
4. Revalidate fixed context and actual subjects/witnesses, then call the unchanged shared unassignUserRoles with fixed platform-admin scope and executor:tx. A held action parent remains held; a missing parent must not be acquired late if it appears after entry. No parent-gap lock is claimed; global role birth/content closure remains separate.
5. In that same root transaction call listRoleNamespaces and disableNamespaceAdmissionsWithoutRoles through tx.query with the original source/revokedRoleId, then the unchanged syncLegacyAdminProfile(false) for admin. Preserve zero-row behavior and affected/cleanup counts.

The command performs no post-commit effects. Keep route order after confirmed whole COMMIT: blocked409 or cleanup audit -> invalidate -> business audit -> snapshot -> original success body. No unknown-COMMIT replay; a post-commit readback failure does not roll back the revoke. Reuse the existing recovery-marker409 family and generic fixed ROLE_UNASSIGN_FAILED/correlation handling. Add only this route's exact AUTHORIZATION_INPUT_BUSY409 body used by assign; entry/work 40P01/non-marker40001/55P03/57014 may map to that family. Do not broaden other routes' error helpers or schema-optional behavior.

## Files and verification

Minimal source changes: the new closed command and this route's command import/transaction replacement/busy catch. Reuse existing role writer, actor predicate, last-admin predicate and legacy helper without modifying them. Extend exact source guards to the new producer and preserve all assign/import/census controls and the full legacy caller union. Do not duplicate SQL writer sites or mark shared writers converted.

Tests: new focused unit/PG files plus whole neighboring admin-users, last-admin/recycle, role-assignment, namespace-admission, recovery, writer guards and unchanged assign suites. Adapt old fixtures to actual new entry locks; preserve their policy/body assertions. Any retired assertion about no parent/subject traffic on last-admin refusal must be replaced by explicit R1-before-parent/full-subject and zero-business-DML assertions, not deleted silently.

| Gate | Discriminating evidence |
|---|---|
| Design | Non-author review of this exact candidate and the actual R1/predicate/consumer routes, no implementation before acceptance |
| Compatibility | Last-admin self/backup distinction, admin role missing/orphan removal, original target/actor rules and precedence, zero-row revoke, main-admin audiences, attendance opt-out, exact errors and effect order |
| Runtime boundary | Real entry and one-fault fake/closed/cross-plan/wrong intent/world/R1/subject/witness cases; fixed immutable inputs, no exported runtime capability or production runner injection |
| Atomic PG | Actual command/shared writer/root COMMIT; membership, both cleanup tables, admission and legacy rollback together; effect-before-commit and acknowledgement/readback failures |
| Physical PG | R1 blocks before parent/subjects; concurrent admin removals cannot both remove the last eligible admin; parent held/missing branches, independent actual R3/R5, raw/member actor changes and CONSUME; same-transaction self admin child upgrade without deadlock |
| Mixed writers | Existing status/recycle/admin-demotion lock prefix and predicate retained; observe actual blocking PIDs/keys rather than final completion or treating busy retry as a fix |
| Required wiring | New PG whole file in approval real-DB lane and default exclusion, EXPECT_DB sentinel, exact-once/wrong-lane/omission negatives; unit enters real unit lane; preserve both sides of lists/digests |
| Final | Relevant tests then combined gate once; semantic-red/precise-source-restore-green on new guards and physical acquisitions; source tsc; independent code review; report local/remote/environment limits separately |

Implementation and test work may run in disjoint files. One owner edits shared route/guard/CI files; no simultaneous source mutation or heavy test execution against a moving candidate. No commit, push, deployment, staging, provider or real-account operation follows from this lock.
