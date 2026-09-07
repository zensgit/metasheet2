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
