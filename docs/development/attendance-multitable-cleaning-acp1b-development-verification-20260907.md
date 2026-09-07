# ACP-1B development and verification

Status: IN PROGRESS / DRAFT-HOLD. This report is not completion or release evidence.

## Authority and baseline

Owner ratified OD-ATC-12A(a) in the owning task; the exact approved contract is
`attendance-multitable-cleaning-acp1b-apply-route-decision-20260907.md`.
OD-ATC-11R(a) remains the canonical-anchor authority. The coordination window
permits current-main synchronization and the ratified shared/DB/W4 implementation.

- Original implementation baseline: `2ba43e2d28fbe0fdb8961fa5af54abadb81ef608`.
- Preserved ten-file product checkpoint: `3ae07e303890398198f87cbb8241a8675f0e22ba`.
- Main synchronized: `cae4619032d9cd32aea5aec13297561f29ca1f6f`.
- True merge: `2488ef6687eacc18f510907d987c135b4bb7967e`, first parent checkpoint,
  second parent main. Six upstream paths had no intersection with ACP paths.
- Duplicate-row repair correction: `cec882918`.

## Delivered locally so far

The projection descriptor adds two user-owned proposal fields. The dedicated
policy accepts only literal boolean true and defaults off. The daily sync supplies
canonical identity through the attendance-only core port. The anchor migration
adds immutable identity, composite source constraints and nonempty-down refusal.
Duplicate rows now stop before managed first-row repair.

The apply route, locked W4 authorization/replay, pending-proposal UI, full migration
drift gates and required CI selection are not yet complete. No public PR has been
published for this implementation. No runtime flag has been enabled.

## Evidence and defects

Dependencies were restored with `pnpm install --frozen-lockfile --ignore-scripts
--prefer-offline`; no lockfile or manifest change. Node 24.14.1 and Node 20.20.2
each passed both dedicated unit files (40 tests). Backend `type-check` passed after
fixing an unknown-to-number narrowing error. This does not substitute for Node 18,
web, full W4 or required remote CI evidence.

The duplicate-row regression first failed against patch-first behavior. Removing
the new duplicate `continue` made the same test fail again; restoring it returned
40/40 green. The test preserves the exact versions and contents of both rows.

The new real-PostgreSQL test reproduced a separate runtime defect: PostgreSQL
returns DATE as a JavaScript Date, whereas the digest expects a canonical date
string. The refresh failed with the fixed values-free authority error. Selecting
`work_date::text` fixes this without timezone conversion. Removing the cast made
the database test fail again. The database suite also checks immutable identity,
populated-down refusal, replay, record-delete cascade and empty down/down/reapply.
It uses synthetic fixture tables; it does not yet prove actual route authorization
or W4 transactional behavior.

The suite uses only an explicit local `ATTENDANCE_TEST_DATABASE_URL`, creates a
unique `attendance_acp_` scratch database, closes its pool before dropping the
database, and asserts exact database residue zero. No application URL fallback.
Node20 repeated this initial database gate five times successfully. Final SQL
census reported zero `attendance_acp_` databases and zero matching active backends;
the task-owned local PostgreSQL instance was then stopped cleanly. This repeat
preceded the later selector fix and is not evidence for that later candidate.

## Outstanding adversarial review

### Latest local checkpoint (2026-09-07)

Anchor/migration checkpoint: `5d1ba2f87fd909d5e6236f373afab9c77dd5dcf2`.
Subsequent work adds the two-connection scope-read → concurrent CREATE → fence
regression. It proves a committed duplicate causes the old anchor to be revoked;
mutating the duplicate threshold to 1000 retains one anchor and makes the count
assertion RED. The restored Node20 suite passes 9/9. Per-test projection cleanup
also permits running these cases individually.

The pure operation-identity helper now derives a deterministic UUIDv5 from the
proposal digest and a separate stable source reference from organization/record.
The first new test failed while the helper was absent. Including the managed
fingerprint in the stable source reference made its resync-replay test RED;
restoration returned the dedicated unit suites to 41/41. This is identity planning
evidence only; no W4 apply or cleanup replay execution is claimed yet.

The database suite now contains eight tests. Node 18.20.8 and Node 20.20.2 each
passed five consecutive runs on the same restored candidate, with PostgreSQL
15.17 and `RBAC_BYPASS=false`. These are migration/anchor tests, not HTTP permission
or W4 apply proof. Exact/prefix scratch database and backend counts were zero and
the owning PostgreSQL instance stopped cleanly after the final runs.

The migration now rejects catalog drift instead of replacing existing objects,
checks a pre-existing guard-function collision, and takes an exclusive table lock
inside the same transaction before count/drop. A two-connection test proves an
in-flight anchor INSERT commits before down counts and therefore makes down refuse.
Removing that lock made exactly this assertion fail; it was restored before repeats.

The catalog signature includes column collations, index access methods/opclasses/
collations, trigger names and function names/schema in addition to the structural
shape. Cross-major PostgreSQL rendering portability remains unverified; PG15 green
is not proof for PG14/16/17. Additional corruption/mutation cases remain pending.

Whole-group withholding now expands the caller's supplied IDs to all matching rows
using the registry project and existing `getObjectFieldId` implementation. A 56-row
fixture with only the first 50 supplied previously retained an anchor; it now clears
it. Refresh takes the existing create fence and locks all sheet rows in ID order
before checking the group and the canonical source. Concurrent CREATE/PATCH and
the later W4 lock-order interaction still require dedicated two-connection proof.

The review notes below retain the original findings; this checkpoint supersedes
their implementation status only where explicit evidence above is stated.

Sol independently confirmed the PostgreSQL date mismatch. Sol also found that
the plugin's duplicate query is capped at 50 and precedes a separate anchor
transaction. The core refresh must prove the entire duplicate group and concurrent
insertion behavior. This is an open P1; the current patch-first regression alone
does not close it.

Sol identified two further findings. The migration currently accepts a same-name
table without validating its catalog shape (open P1). The selector recognized only
`w4`, omitting the existing `w4_group` pointer-owning domain (P2). A new failing unit
case reproduced the latter; the implementation now reuses the existing domain
predicate and refuses an invalid current pointer instead of falling back to latest.
Both unit files and backend typecheck returned green; real-DB and mutation coverage
for this selector change remains pending.

Next gates: reproduce remaining review findings, enforce authoritative duplicate
census and migration drift refusal, implement locked W4 apply/replay, add dedicated
Vue UI/tests, run Node18/20 and isolated DB mutation matrix, then request only the
mechanical shared CI-selector coordination window. Publication remains Draft/HOLD.

## DB-fresh actor gate checkpoint (2026-09-08)

The attendance-owned authority helper now locks active user, same-org membership,
and existing grant rows before resolving DB-fresh attendance administrator access.
JWT identity alone and generic multitable write permission cannot grant approval.
The helper is not yet wired into the W4 apply route; this is not end-to-end proof.

Node20 dedicated PostgreSQL suite: 10/10 PASS, including wrong organization,
token-subject mismatch, generic-write-only actor, revoked membership, inactive
account and pending activation. Removing the attendance-specific permission guard
produced the expected RED (generic write incorrectly resolved); restoring it gave
10/10 PASS. Backend `tsc --noEmit` passed before the final test-only additions.

Read-only replay review found that existing generic W4 completed replay returns
before class-00/10/11 locks. ACP must not reuse this path without its locked
authorization and cleanup checks. Coordination interpreted the existing ratified
contract without new owner ratification: cleanup requires the original operation
actor plus current access; suspended ACP cleanup performs no new DML and retries
only after posture recovers. Cross-admin and suspended cleanup writes remain out
of this slice.

Registry now defers only an internal ACP manual-edit single-command decision with
the canonical source-reference format. Default callers retain ordinary fast replay,
including while suspended. Locked replay returns a frozen actual organization
witness only, not executable item witnesses. Boundary takes class-11 before the
cleanup hook and never executes, seals or enqueues that completed operation again.
The trusted plugin caller is still pending.

Node20 registry whole-file: 13/13 PASS, including allow-new first claim,
missing/claimed/canceled locator refusal, original-actor congruence, membership
revocation, suspended ACP/ordinary controls, complete boundary 00/10/11 order,
ordinary boundary zero-lock replay, and two-stage decision drift. Removing the
missing-locator guard produced RED by wrongly claiming a new operation. Skipping
replay class-11 produced RED by observing two locks instead of three. Both mutations
were restored. Existing real-plugin W4 route neighbor: 32/32 PASS; its fixture
internally enables RBAC bypass, so this is NOT ACP strict-route permission evidence.

Dedicated anchor/authority PostgreSQL suite: 11/11 PASS after adding effective
sheet/proposal-field/row access, hidden/read-only fields, duplicates and deleted
sheet negatives, with positive recovery controls between denials. Existing grant
rows are locked and existing multitable permission logic is reused. The helper is
not yet wired to the public ACP route. Full route, cleanup CAS, concurrent grant
revocation and UI acceptance remain pending.

Subsequent refute-first review reproduced two additional P1 cases. Role-only admin
without the attendance permission family wrongly passed; it now fails. Attendance
namespace admission is resolved on the same transaction using existing pure
namespace derivation and actual role/admission rows, never the global-pool resolver;
missing/disabled namespace also fails. Existing wildcard semantics are preserved.

An actual second connection could INSERT a new field deny while the earlier
SERIALIZABLE transaction held all existing grant rows. Row locks alone therefore
did not prove authority stability. The ACP-only internal boundary entry now selects
a fixed SHARE NOWAIT relation fence immediately after BEGIN and before even the
first SELECT set_config. It locks the 14 explicitly named authority/schema/policy
relations in the registry wrapper; ordinary W4 entry does not take this fence.
This is table-wide serialization, NOT per-subject concurrency. It can temporarily
block unrelated grant, user, sheet-schema and settings writers. The runtime remains
default OFF and this performance limitation is part of release review.

Real PostgreSQL proof: deny committed immediately before the fence is observed and
refused; deny inserted while the fence is held waits; a pre-existing writer gives
fixed busy and rollback leaves zero relation ShareLocks. A mutation inserting
SELECT set_config before the fence recreates the old-snapshot wrong allowance and
turns the test RED. Restored Node20 combined registry/authority/W4 neighbor: 56/56
PASS. These still do not prove the not-yet-wired ACP HTTP apply or cleanup effects.

## SERIALIZABLE projection phantom and candidate repair (2026-09-08 local)

Integrated HEAD is `e88175d69c125fc28d72c6e14743471627771adf`, with product
checkpoint `7f218673f3bd0790ebaf39dbd3d9c9ae7639aa9d` as first parent and main
`976711b254d129e6c23bf8327c4be67018942ba3` as second parent. The following
evidence is from uncommitted follow-up work, not the earlier green checkpoint.

The actual SERIALIZABLE wrapper establishes its snapshot before the existing
transaction-scoped sheet fence. A second connection commits a duplicate projection
through the canonical create fence in that interval. The access check incorrectly
returns the projection instead of refusing. The dedicated regression was RED;
the earlier READ COMMITTED sync test did not cover this schedule.
There was no canonical attendance mutation in this reproduction.

Two Node20 / PostgreSQL15 experiments pass, but are not a production fix:

- A pre-BEGIN session lock on `hashtext(canonicalSheetFenceKey(sheetId))` excludes
  the writer's one-argument transaction lock. A two-int lock with the same hash
  does not conflict. Exact unlock allows the writer to proceed.
- A synthetic inverse-order holder demonstrates that initial try-lock success
  does not prevent a later wait cycle. A bounded lock timeout, rollback and exact
  unlock release the waiter; both backends then have zero advisory locks. This
  is a candidate-protocol hazard, not evidence that an existing W4 caller takes
  that synthetic lock or has a production deadlock.

The coordinator authorized a bounded production candidate within the existing
files. It now runs through the ACP-specific record boundary. No writer flag is
enabled. This is a transaction/source milestone, not HTTP apply or UI completion.

### Actual candidate order and resource gates

The ACP boundary performs an idle probe and same-client non-authorizing lookup of
the daily and catalog sheets. Each attempt acquires session locks in actual signed
PG key order, deduplicating hashes, then begins SERIALIZABLE. Its first transaction
statement locks the fixed **16** relations (the original 14 plus leave/overtime
definitions) in SHARE NOWAIT mode. The boundary rechecks the exact sheet scope in
that snapshot before normal W4 class-00, class-10 and class-11 processing. Only
after target locking does the adapter enter source/projection/anchor row locking.

Mechanical caller audit: RecordService create takes the same one-argument fence
with writer flags OFF; the optional link plan is null in that posture. Attendance
sync's anchor refresh/withhold ports open separate short pool transactions, not a
W4-held callback. Ordinary W4 execute does not request either ACP fence. The
bounded independent callgraph/resource/snapshot review found no new P1; its P2
about optional sheet IDs is closed by mandatory paired options and pre-query
refusal tests. The source-seed actor pre-read is a separate short transaction;
its temporary FOR SHARE locks do not survive into W4 or grant authority to apply.

Every attempt releases only its recorded session locks in reverse order, including
partial busy, body refusal and 40001 retry. Existing same-backend locks are refused
without changing their reentrant count. Lost acquisition/BEGIN/COMMIT/ROLLBACK or
unlock results produce an uncertain-connection error; actual boundary tests prove
pg `release(error)` destroys that client. The boundary maps this to fixed 503
`ATTENDANCE_CLEANING_OUTCOME_UNKNOWN`, never a blind apply retry or raw error.

The original duplicate test is now GREEN on the real wrapper. Removing its session
acquisition makes the original wrong allowance RED again. Catalog insertion is
observed; a concurrent catalog edit triggers 40001 and one whole-attempt retry.
Removing catalog FOR UPDATE yields one attempt instead of two (RED). Removing the
two definition-table fences independently makes both in-flight-definition refusal
tests RED. All mutations are restored.

Restored Node20 combined scope is **71/71**: dedicated authority 26, registry 13,
existing plugin W4 HTTP neighbors 32. Node18 dedicated authority + registry is
**39/39**, not the full 71. Backend type-check and diff-check pass. Focused source
ESLint exits zero with 0 errors and 22 warnings in `src/index.ts`; no auto-fix.
The existing 32 HTTP tests are not the still-unimplemented ACP apply endpoint.
The intermediate catalog fixture collision was a test cleanup defect, corrected by
removing its own two physical fields; it was retained as a failed run, not counted
as a product concurrency defect. The full synthetic migration DB remains task-owned
and running for the next route tests; only per-suite scratch DB residue is cleared.

Remaining before publication: real ACP HTTP adapter and exact business fingerprint/
dual-CAS checks, canonical apply plus durable cleanup-only replay, user-visible UI,
final repeated gates and required CI selector union, final isolated DB cleanup.

## Exact current file census

1. `docs/development/attendance-multitable-cleaning-acp1b-apply-route-decision-20260907.md`
2. `docs/development/attendance-multitable-cleaning-acp1b-development-verification-20260907.md`
3. `packages/core-backend/src/attendance/attendance-multitable-cleaning-authority.ts`
4. `packages/core-backend/src/db/migrations/zzzz20260907110000_create_attendance_report_projection_anchors.ts`
5. `packages/core-backend/src/db/types.ts`
6. `packages/core-backend/src/index.ts`
7. `packages/core-backend/src/types/plugin.ts`
8. `packages/core-backend/tests/unit/attendance-report-cleaning-proposal.test.ts`
9. `packages/core-backend/tests/unit/attendance-report-field-catalog.test.ts`
10. `packages/core-backend/tests/integration/attendance-report-cleaning-proposal.db.test.ts`
11. `plugins/plugin-attendance/index.cjs`
12. `plugins/plugin-attendance/lib/attendance-report-cleaning-proposal.cjs`
13. `packages/core-backend/src/attendance/w4c0-operation-registry.ts`
14. `packages/core-backend/src/attendance/w4c3c-record-operation-boundary.ts`
15. `packages/core-backend/tests/integration/attendance-w4c0-operation-registry.db.test.ts`
