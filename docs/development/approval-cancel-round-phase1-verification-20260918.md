# Approval Cancel-Round Phase 1 — Verification (2026-09-18, finalized)

This document is finalized in two layers, kept separate rather than merged into one narrative:

- **Part A (this pass, 2026-09-18)**: a fresh rerun against the private DB **`metasheet2_lock_c`**
  (per instruction — not a freshly-created virgin DB), the full 17-item supplementary-checklist
  walk, a live mutation ledger with genuine backup→edit→run→restore→cmp cycles run in this pass, the
  lock's verification-table rows mapped to test file + case name + lane, and — because the task
  requires reporting defects rather than silently fixing them — two findings this pass surfaced on
  the current tree that were not in the prior record.
- **Part B (preserved, round 2, 2026-09-18 earlier)**: the existing content of this file at the time
  this task started, kept **verbatim, not discarded**, as the record of round 2's own virgin-DB rerun
  (against `metasheet2_lock_c_virgin`, HEAD `296a47acb`). Its numbers are **not** carried forward as
  today's evidence — Part A supersedes it for "is it green right now" — but its narrative (the
  virgin-migration proof, the Q-B/Q-C census construction story, the decision-3 boundary reasoning)
  remains correct and is not restated.

HEAD at the time of Part A: `b2f2d3ac3` (after this same commit's design-MD sibling; no code
changes are part of this commit — see §3's mutation ledger for the two temporary, fully-restored
edits made and reverted *during* this verification pass, confirmed byte-identical by `cmp`).

---

# Part A — this pass (2026-09-18)

## A0. Provenance discipline

Every command below was actually run in this pass, against `metasheet2_lock_c` (verified
`psql -l` lists it; `packages/core-backend`'s own migration runner reports "Applied: 409, Pending: 0"
against it before any test ran — i.e., this DB is fully migrated, not stale, but it is **not
virgin**: it carries schema and fixture-row residue from many earlier rounds of work on this and
other branches, as the task instruction anticipated by naming this specific DB rather than asking
for a fresh one). No number below is copied from a prior commit message or from Part B.

## A1. Fresh reruns — commands verbatim, result lines verbatim

### A1.1 The seven `approval-cancel-round-*.db.test.ts` files

```
DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c \
EXPECT_DB=1 \
npx vitest --config vitest.integration.config.ts run \
  tests/integration/approval-cancel-round-lock-order-census.db.test.ts \
  tests/integration/approval-cancel-round-creation.db.test.ts \
  tests/integration/approval-cancel-round-redemption.db.test.ts \
  tests/integration/approval-cancel-round-seat-guards.db.test.ts \
  tests/integration/approval-cancel-round-attendance-fk-migration.db.test.ts \
  tests/integration/approval-cancel-round-outlet-guards.db.test.ts \
  tests/integration/approval-cancel-round-node-timeout-effect.db.test.ts

 Test Files  7 passed (7)
      Tests  44 passed (44)
EXIT:0
```

### A1.2 The two new unit tests

```
DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c \
EXPECT_DB=1 \
npx vitest run \
  tests/unit/approval-cancel-round-ci-wiring.test.ts \
  tests/unit/approval-cancel-round-plugin-mirror-constant.test.ts

 Test Files  2 passed (2)
      Tests  15 passed (15)
EXIT:0
```
(9 cases in `approval-cancel-round-plugin-mirror-constant.test.ts` + 6 in
`approval-cancel-round-ci-wiring.test.ts` = 15, confirmed by `grep -c "it(" <each file>`.)

### A1.3 Sentinel census (mechanical, all seven files, not "the ones I looked at")

```
$ grep -l "EXPECT_DB === '1'" tests/integration/approval-cancel-round-*.db.test.ts | wc -l
7
```

### A1.4 s6a provenance pin

```
$ node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
✔ sealed-export-package-provenance.test.cjs (396.6ms)
tests 1, pass 1, fail 0
```

### A1.5 Typecheck

```
$ npx tsc --noEmit -p .
(no output — clean)
EXIT:0
```

### A1.6 DML-inventory collector census (all four attendance census pins, re-run fresh)

```
$ node --test scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs
tests 60
pass 60
fail 0
```

### A1.7 Q1c attendance fixture-pairing spot-check, on `metasheet2_lock_c`

```
DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c \
ATTENDANCE_TEST_DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c \
EXPECT_DB=1 \
npx vitest --config vitest.integration.config.ts run \
  tests/integration/attendance-approval-action-authorization.db.test.ts \
  tests/integration/attendance-approval-flow-dynamic-kind-s7-1.db.test.ts \
  tests/integration/attendance-decision-trace-w5-0.db.test.ts \
  tests/integration/attendance-plugin.test.ts \
  tests/integration/attendance-result-edit.test.ts \
  tests/integration/attendance-w4c3b-central-approval.db.test.ts \
  tests/integration/attendance-w4c3b-request-snapshots.db.test.ts

 Test Files  1 failed | 6 passed (7)
      Tests  2 failed | 296 passed (298)
EXIT:1
```

**This is a genuinely different result from Part B's rerun on `metasheet2_lock_c_virgin`** (which
reported 7/7 files, 298/298 tests). Both failures are inside `attendance-plugin.test.ts`:
`auto shift matching preview > auto-writes one high-confidence suggestion with ledger provenance
and skips repeat ticks` (`appliedCount` expected `0`, got `1`) and `W4C-3a reproduces the committed
legacy-import-v1 governing-SHA golden` (`Expected one async idempotent replay, received 2`). See §A2
for the isolation that traces this to shared-DB residue, not to this lane's code.

## A2. Investigation: is the `metasheet2_lock_c` attendance-plugin.test.ts failure a defect in this slice?

This required an actual isolation, not an assumption — memory `feedback_dead_code_defect_is_not_a_live_vulnerability`
and the project's own established characteristic ("`attendance-plugin.test.ts` 在 virgin DB 是有效
oracle") both point at DB-state sensitivity being the likely cause, but "likely" is not "verified",
so the isolation was actually run:

**Step 1 — is either failing test near a line this lane touched?**
```
$ git diff 89f1ecdee...HEAD -- packages/core-backend/tests/integration/attendance-plugin.test.ts
```
shows exactly one hunk, at line ~17275 (adding `workflow_key`/`approval_workflow_key` to an
INSERT fixture). Both failing tests (`auto shift matching preview` around line 11806,
`W4C-3a...golden` around line 20199-20386) are thousands of lines away from that hunk — not
downstream of this lane's edit by any call-graph proximity a diff review can rule out by inspection
alone, hence step 2.

**Step 2 — does the same file pass in full on a freshly migrated, otherwise-untouched database?**
```
$ dropdb --if-exists metasheet2_lock_c_check1 && createdb metasheet2_lock_c_check1
$ DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c_check1 npx tsx src/db/migrate.ts
  ... (all 409 migrations apply clean, ending at
  zzzz20260918110000_add_attendance_requests_approval_workflow_key)

$ DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c_check1 \
  ATTENDANCE_TEST_DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c_check1 \
  EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts

 Test Files  1 passed (1)
      Tests  166 passed (166)
```
Both previously-failing cases are inside this 166 (confirmed: `grep -c "auto-writes one
high-confidence suggestion" <log>` → 1, and the golden test's own name appears in the passing list).
The check DB was then dropped (`dropdb metasheet2_lock_c_check1`) — it was scratch, not left behind.

**Conclusion**: the two `metasheet2_lock_c` failures are **shared-DB residue from this lane's (and
possibly other branches') accumulated prior test runs against that long-lived private database**,
not a defect this slice's code introduced. This is disclosed here as a **finding about the test
environment**, not a code defect, and per the "不改代码" rule nothing was changed to fix it — the
fix, if any is wanted, is environment hygiene (a periodic `metasheet2_lock_c` reset), not a code
change, and is left to the door review to decide whether to act on.

## A3. Live mutation ledger (this pass — genuine backup → edit → run → restore → cmp cycles)

Two mutations were actually executed in this pass, not merely cited from a prior commit message.
Both follow: `cp <file> /tmp/<file>.bak` → edit → run the narrowly-targeted test → observe red →
`cp /tmp/<file>.bak <file>` → `cmp` (byte-identical) → `git status --short` (clean) → rerun to
confirm green again.

### Mutation 1 — outlet #7's legacy-catch pass-through (`routes/approvals.ts:3015-3017`)

- **Backup**: `cp src/routes/approvals.ts /tmp/approvals.ts.bak`
- **Edit**: commented out the `if (error instanceof CancelRoundOutletForbiddenError) return
  handleApprovalsError(...)` block (the lock-mandated pass-through for legacy `/approve`'s catch,
  which by default does not call `handleApprovalsError` and would 500 any `ServiceError`).
- **Run**:
  ```
  DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-outlet-guards.db.test.ts -t "#7 legacy"

  × #7 legacy POST /:id/approve — ...
    → {"ok":false,"error":{"code":"APPROVAL_APPROVE_FAILED","message":"Failed to approve request"}}:
      expected 500 to be 409
  Tests  1 failed | 5 skipped (6)
  EXIT:1
  ```
  Exactly the predicted failure mode: without the pass-through, the guard's `ServiceError` subclass
  falls through to the route's generic 500 handler instead of surfacing as 409
  `CANCEL_ROUND_OUTLET_FORBIDDEN`.
- **Restore**: `cp /tmp/approvals.ts.bak src/routes/approvals.ts`
- **cmp**: `cmp src/routes/approvals.ts /tmp/approvals.ts.bak` → no output (byte-identical);
  `git status --short src/routes/approvals.ts` → empty.
- **Re-run (confirm green)**: same command, same `-t` filter → `Tests 1 passed | 5 skipped (6)`.

### Mutation 2 — 判据 III's A4 round-close write (`ApprovalProductService.ts:10641-10653`)

- **Backup**: `cp src/services/ApprovalProductService.ts /tmp/ApprovalProductService.ts.bak`
- **Edit**: changed `if (isCancelRoundInstance(instance)) {` to `if (false &&
  isCancelRoundInstance(instance)) {` around the A4 (revoke) branch's round-close `UPDATE
  approval_rounds SET outcome = 'withdrawn' ...` — i.e., disabled the write that releases the
  pending-round slot on revoke.
- **Run**:
  ```
  DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-redemption.db.test.ts -t "撤销不限次"

  × chain (§5 I6, 撤销不限次): revoke terminates round 1 (withdrawn) -> ...
    → expected 'pending' to be 'withdrawn'
  Tests  1 failed | 3 skipped (4)
  EXIT:1
  ```
  This is the checklist item 16 acceptance row ("终结(拒/撤)后同一单据连发 N 轮不被次数拒") going red
  exactly at the point the round-close write is disabled — the round stays `pending` forever, which
  (per I3's partial unique index) would permanently block a fresh round on the same document.
- **Restore**: `cp /tmp/ApprovalProductService.ts.bak src/services/ApprovalProductService.ts`
- **cmp**: byte-identical (no output); `git status --short` for both files together → empty.
- **Re-run (confirm green)**: same command → `Tests 1 passed | 3 skipped (4)`.

**Tree state after both mutations**: `git status --short` at the repo root → empty (confirmed
above and again immediately before writing this document).

### Mutations recorded at earlier commits (not re-run in this pass — cited, not re-verified)

Per the task's ledger discipline, these are labeled by their commit, not folded into the "this pass"
ledger above:

| Mutation | Recorded at | What it proved |
|---|---|---|
| Drop one file from the CI required-step run-list | `e394c9e9c` | Both the new `approval-cancel-round-ci-wiring.test.ts` guard and the repo-wide `approval-ci-coverage-enumeration.test.ts` turn red; restored, `sha256` re-matched the pinned digest |
| Rename the plugin mirror constant identifier | `e630b6ca7` | The source-text regex pin (not just a value-equality check) fails |
| Env-flag mutation on outlet #3 | `af015de07` / `3482d99c0` | Flipping `APPROVAL_NODE_TIMEOUT_TERMINAL_EFFECTS` ON does not change the cancel-round outcome for an unrelated structural reason (the round graph has no timeout config) — corrected from an earlier overclaim in the same file's own commit history |
| Seat-guard catch-shape mutation (#12/#13) | `c67a171e6` | Removing the typed-skip catch causes the result to fall into the generic catch (`:8743-8749`/`:9156-9162`), losing the `reason: 'cancel_round'` label |
| Q-B/Q-C org-id isolation hardening | `296a47acb` | An org-scoping gap in the constructed census legs was found and closed; the commit message documents the before/after |

## A4. Genuine finding #1 (this pass) — FE sync-pin regex under-extracts the backend union

**Reproduction**:
```
$ cd apps/web && npx vitest run tests/approvalBatchTransferView.spec.ts

× 批量转交 outcome helpers > names every skip code the server declares, and falls back for an
  unrecognised one
  → expected [ 'cancel_round', 'error', …(6) ] to deeply equal [ 'not-assigned', 'not-found', …(4) ]
Test Files  1 failed (1)
     Tests  1 failed | 71 passed (72)
```

**Root cause, isolated** (not merely restated from the failure message):
```js
node -e '
const fs = require("fs")
const src = fs.readFileSync("packages/core-backend/src/services/ApprovalProductService.ts", "utf8")
const m = src.match(/export type ApprovalBulkReassignSkipReason\s*=\s*((?:\s*\|\s*'"'"'[^'"'"']+'"'"')+)/)
console.log(m[1])
'
→ "| 'not-found'\n  | 'not-pending'\n  | 'not-assigned'\n  | 'target-is-requester'\n
    | 'target-already-assignee'\n  | 'target-user-invalid'"
```
The backend's `ApprovalBulkReassignSkipReason` union (`ApprovalProductService.ts:386-403`) is
**eight** members — it correctly includes `'cancel_round'` and `'error'`. But between
`'target-user-invalid'` and `'cancel_round'` there is a multi-line `/** ... */` JSDoc comment
explaining the `cancel_round` literal's byte-exactness requirement. The sync-pin test's own
extraction regex (`apps/web/tests/approvalBatchTransferView.spec.ts`, the `readFileSync`-based guard
this lane itself added per lock §14.3 #12/checklist item 15) is `/export type
ApprovalBulkReassignSkipReason\s*=\s*((?:\s*\|\s*'[^']+')+)/` — the repeated group
`(?:\s*\|\s*'[^']+')+` requires each successive union member to be reachable via `\s*` (whitespace
only) immediately before the next `|`. The JSDoc comment breaks that: `\s*` cannot consume `/** ...
*/` text, so the regex's repetition **silently stops** after `'target-user-invalid'`, extracting only
six of the eight members and never reaching `'cancel_round'` or `'error'`.

**What this means, precisely — this is not the defect the test's own name suggests**:
- The **frontend already has** the `cancel_round` member in both `apps/web/src/approvals/api.ts:1665`
  and the label map `apps/web/src/approvals/batchTransfer.ts` (`cancel_round: { zh: '...',
  en: '...' }`, with its own lock-citing comment). The lock's three required same-PR edits (backend
  literal, FE union, FE label map) **are all present**.
- The failure is a **false negative in the sync-pin guard's own extraction mechanism**, not evidence
  the FE is out of sync. The guard is currently unable to prove the very thing it exists to prove,
  because its regex does not tolerate a comment between union members.
- **This is a real, currently-red test on this tree** (`apps/web/tests/approvalBatchTransferView.spec.ts`,
  reproduced above, present in this lane's own diff). It was not previously reported: Part B's own
  record does not mention running this file, and the goal document's checklist item 15 closure
  narrative (quoted in the design MD) describes the guard's *shape* being correct without having
  executed it.

**Disposition**: per the "不改代码" rule, the regex was **not** fixed. This is reported here as a
CONFIRMED defect (in the *test*, not in the shipped FE/BE code, which line up correctly) for the door
review to register and decide how to fix (the minimal fix would let the repeated group also skip a
`/** ... */` block, or split the match on the closing `*/` before applying the per-literal `matchAll`).

## A5. Genuine finding #2 (this pass) — see §A2 above (shared-DB residue, not a code defect)

Already covered in full in §A2; listed here only so the "两条私自发现" instruction has both findings
visible from one place.

## A6. Lock verification-table → test file + case name + lane (full mapping)

Anchors are the lock's own §14.3 outlet table (lock:359-376) plus §14.1's judgment I/I″, §5's I3/I6,
and §14.2's 判据 III. "Lane" = the CI step this test file runs under (all seven `.db.test.ts` files
share one lane; the two `.test.ts` files run in the default no-DB unit-test job).

| Lock item | Test file | Case name (verbatim) | Lane |
|---|---|---|---|
| 判据 I (创建期写入正确谓词) | `approval-cancel-round-creation.db.test.ts` | `writes the dedicated instance, one pending round row, and an active seat for the original approver` | `approval-real-db-integration` (required, 20.x) |
| I3 (`uq_approval_rounds_pending_document`) | `approval-cancel-round-creation.db.test.ts` | `§5 I3 — a second cancel round cannot be started while one is pending (uq_approval_rounds_pending_document)` | same |
| §6 仅原 requester (WI-16) | `approval-cancel-round-creation.db.test.ts` | `WI-16 — only the original requester may start a cancel round (403 CANCEL_ROUND_REQUESTER_ONLY)` | same |
| Outlet #14 (suite gate) | `approval-cancel-round-creation.db.test.ts` | `§14.3 #14 (WI-6) — suite="forbidden" is rejected before any write (CancelRoundSuiteForbiddenError 409)` | same |
| Outlet #2 (`adminJump`) | `approval-cancel-round-outlet-guards.db.test.ts` | `#2 adminJump — a cancel-round instance is rejected 409 CANCEL_ROUND_OUTLET_FORBIDDEN; a genuine downstream jump on an ordinary instance still succeeds` | same |
| Outlets #4/#6 (action gate) | `approval-cancel-round-outlet-guards.db.test.ts` | `#4/#6 dispatchAction action gate — a cancel-round instance rejects 'handle' and 'return' 409 CANCEL_ROUND_OUTLET_FORBIDDEN; 'comment' (an allowed action) still succeeds` | same |
| Outlet #7 (legacy approve) | `approval-cancel-round-outlet-guards.db.test.ts` | `#7 legacy POST /:id/approve — a cancel-round instance is rejected 409 CANCEL_ROUND_OUTLET_FORBIDDEN via handleApprovalsError; the row is unchanged` | same |
| Outlet #7′ (legacy reject) | `approval-cancel-round-outlet-guards.db.test.ts` | `#7′ legacy POST /:id/reject — a cancel-round instance is rejected 409 CANCEL_ROUND_OUTLET_FORBIDDEN via handleApprovalsError; the round stays pending, not orphaned` | same |
| Outlet #8 (Bridge) | `approval-cancel-round-outlet-guards.db.test.ts` | `#8 ApprovalBridgeService.dispatchAction — a half-formed cancel-round instance (no published_definition_id) fails isTemplateRuntimeInstance and is rejected 409 CANCEL_ROUND_OUTLET_FORBIDDEN by the generic bridge` | same |
| Outlet #3, oracle (transfer) | `approval-cancel-round-node-timeout-effect.db.test.ts` | `#3 two-part oracle (transfer): outcome literal skipped_cancel_round AND deadline actually consumed — proven by the REAL scanner predicate dropping the instance on round 2` | same |
| Outlet #3, oracle (jump) | `approval-cancel-round-node-timeout-effect.db.test.ts` | `#3 two-part oracle (jump): the same outcome+consumption pair holds for the OTHER scanned effect` | same |
| Outlet #3, positive control | `approval-cancel-round-node-timeout-effect.db.test.ts` | `positive control (same method, ordinary instance): an armed transfer timeout on a NON-cancel-round instance is actually applied — outlet #3 is not a blanket disable` | same |
| Outlet #3, env-flag disclosure | `approval-cancel-round-node-timeout-effect.db.test.ts` | `env flag inert: with APPROVAL_NODE_TIMEOUT_TERMINAL_EFFECTS flipped ON, the outcome for a cancel-round instance is unchanged — NOT proof isCancelRoundInstance is checked before the terminal-effects gate (...)` | same |
| Outlet #12 (bulkReassign seat) | `approval-cancel-round-seat-guards.db.test.ts` | `#12 bulkReassignApprovals — a cancel-round instance is skipped cancel_round, its seat untouched, while a sibling pending instance on the SAME assignee reassigns normally` | same |
| Outlet #13 (departure transfer seat) | `approval-cancel-round-seat-guards.db.test.ts` | `#13 applyApprovalDepartureTransfer — a cancel-round instance is skipped cancel_round, its seat untouched, while a sibling pending instance on the SAME departed user transfers to the manager` | same |
| Outlets #10/#11 (Q1c FK pairing) — preflight | `approval-cancel-round-attendance-fk-migration.db.test.ts` | `migration preflight: dangling reference aborts migration` | same |
| Outlets #10/#11 — pairing CHECK | `approval-cancel-round-attendance-fk-migration.db.test.ts` | `constraint: non-null approval_instance_id with NULL approval_workflow_key is rejected 23514 (atr_instance_key_pair)` | same |
| Outlets #10/#11 — not-cancel-round CHECK | `approval-cancel-round-attendance-fk-migration.db.test.ts` | `constraint: raw SQL pointing attendance_requests at a cancel round is rejected 23514 (atr_not_cancel_round)` | same |
| Outlet #11 depends on #10 | `approval-cancel-round-attendance-fk-migration.db.test.ts` | `#11 relies on #10: attendance_requests cannot point at a cancel round to begin with` | same |
| Five-writer census (§14.3 #10 "同 PR 改写") | `approval-cancel-round-attendance-fk-migration.db.test.ts` | `exactly 5 occurrences of approval_workflow_key exist in the plugin (census: no undocumented 6th writer, no dropped writer)` + 5 per-writer case names (`executeGenericRequestCreate…`, `executeOutdoorRequestCreate…`, `executeScheduleDispatchRequestCreate…`, `executeShiftSwapRequestCreate…`, `executeRequestPendingEdit…`) | same |
| 判据 III, A4 (revoke) | `approval-cancel-round-redemption.db.test.ts` | half of `chain (§5 I6, 撤销不限次): revoke terminates round 1 (withdrawn) -> a fresh round can start immediately -> reject terminates round 2 (rejected) -> a third round can start immediately` | same |
| 判据 III, A7 (reject) | `approval-cancel-round-redemption.db.test.ts` | other half of the same `chain (...)` case | same |
| §5 I6 (撤销不限次, explicit acceptance row — checklist item 16) | `approval-cancel-round-redemption.db.test.ts` | same `chain (...)` case — this is the row itself, not a separate test; see §A3 Mutation 2 for the live mutation proving it is load-bearing | same |
| 判据 III, keying discrimination | `approval-cancel-round-redemption.db.test.ts` | `DISCRIMINATING CONTROL: revoking one document's round does not touch a DIFFERENT document's own pending round (keyed on engine_instance_id, not "any pending round")` | same |
| 判据 III, implementer-erratum branch | `approval-cancel-round-redemption.db.test.ts` | `erratum (not a lock quote — implementer choice, flagged for owner registration): a broken ...` (`CANCEL_ROUND_INVARIANT_VIOLATION` path) | same |
| Q-A lock order | `approval-cancel-round-lock-order-census.db.test.ts` | `§9-4 order (class-00 then instance row): a rollout holder BLOCKS a later instance-row acquisition, which proceeds once released` + reversed-order + positive-control siblings | same |
| Q-B lock order | `approval-cancel-round-lock-order-census.db.test.ts` | `candidate order (class-11 then attendance_requests row): a target-lock holder BLOCKS a later row acquisition, which proceeds once released` + reversed + positive-control siblings | same |
| Q-C lock order | `approval-cancel-round-lock-order-census.db.test.ts` | `ABSENCE: createCancelRoundInstance never references the record-link row-auth lock (mechanical scan, re-read fresh)` + two POSITIVE CONTROL siblings proving the harness can force a real `40P01` | same |
| CI wiring (lane decision 1) | `approval-cancel-round-ci-wiring.test.ts` | 6 cases (see §A1.2) | default unit job |
| Plugin mirror constant (lane decision 2) | `approval-cancel-round-plugin-mirror-constant.test.ts` | 9 cases (see §A1.2) | default unit job |
| FE sync pin (§14.3 #12, checklist item 15) | `apps/web/tests/approvalBatchTransferView.spec.ts` | `names every skip code the server declares, and falls back for an unrecognised one` | apps/web default job — **currently RED, see §A4** |

## A7. Two-point wiring / trigger set / s6a — grep evidence (fresh, this tree)

**Excluded from the no-DB job** (`vitest.config.ts`): confirmed by both the mechanical guard
(`approval-cancel-round-ci-wiring.test.ts`'s own "excluded from the no-DB vitest.config.ts job" case,
green in §A1.2) and directly:
```
$ cd packages/core-backend && grep -c "approval-cancel-round" vitest.config.ts
7
```
(exactly the seven file-path exclusion entries, one per `.db.test.ts` file.)

**Included, whole-file, in the required step** (`.github/workflows/plugin-tests.yml`'s
`approval-real-db-integration` step, id used by `scripts/ops/ci-realdb-step-contract.mjs`):
```
$ grep -c "tests/integration/approval-cancel-round-.*\.db\.test\.ts \\\\" .github/workflows/plugin-tests.yml
7
```

**Not double-wired into the sibling multitable real-DB step**: confirmed by the guard's own "is NOT
also wired into the sibling multitable real-DB step" case (green above).

**Trigger set (paths)**: `plugin-tests.yml`'s `push` trigger paths include `packages/core-backend/**`
and `plugins/**` (`.github/workflows/plugin-tests.yml:10-11`) — broad enough to cover every file this
lane touches (migrations, service files, `index.cjs`); the `pull_request` trigger carries no `paths`
filter at all, so a PR touching only these files still triggers the workflow regardless.

**s6a pin**: unchanged this pass (`git diff --stat` on
`plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs` and its
vectors file shows no delta since the pin recorded in `e394c9e9c`); re-run in §A1.4, still green.

## A8. Supplementary checklist — all 17 items

| # | Item | Status |
|---|---|---|
| 1 | `t2-source-freeze-ci-wiring.test.mjs` closed-world / 45-sibling census | **Partially closed.** This lane's own CI-wiring guard is internally correct and mutation-tested (§A3 recorded ledger). The broader caution — a *different* sibling `*-ci-wiring` guard's own hardcoded array missing this lane's new files — was **not swept** in this lane (a 45-guard sweep is outside this slice's own scope); left for the pre-PR door review, as Part B already disclosed. |
| 2 | `vitest.config.ts` exclude vs. `plugin-tests.yml` inclusion, PR body must disclose | **Closed for content; PR-body disclosure is a PR-authoring step, not yet drafted** — no Draft PR has been opened for this slice at the time of this document (§A9 lists this as an open item). |
| 3 | s6a re-pin on `plugin-tests.yml` change | **Closed.** `e394c9e9c` re-pinned in the same commit as the workflow edit; §A7 confirms no drift since. |
| 4 | Error codes must be dedicated, not bare HTTP status | **Closed.** All 8 outlet-guard chokepoints assert `CANCEL_ROUND_OUTLET_FORBIDDEN`; the suite gate asserts `CANCEL_ROUND_SUITE_FORBIDDEN`; see the design MD §3 for the full code table, including the four implementer-erratum codes (also dedicated, not bare status). |
| 5 | Lane A: `section=` token 400 pair | **N/A — lane A item.** |
| 6 | Lane A: "1 落地" definition | **N/A — lane A item.** |
| 7 | Lane A: FE spec location (`apps/web/tests/`) | **N/A — lane A item, but confirms this lane's own new FE spec edit is in the right directory**: `apps/web/tests/approvalBatchTransferView.spec.ts` (existing file, edited, correct location). |
| 8 | Lane B: `NODE_ENV` assertion | **N/A — lane B item.** |
| 9 | Lane B: `MIGRATION_EXCLUDE` / triggers | **N/A — lane B item.** |
| 10 | Lane B: `validate-migration-exclude.sh` WARN-ONLY | **N/A — lane B item.** |
| 11 | Lane B: 判据 E algebra guard | **N/A — lane B item.** |
| 12 | Lane B: A0 reuse of existing suite | **N/A — lane B item.** |
| 13 | W7-R10 is a directory-ROOT list, not a file list | **Closed, by containment argument, not by a basename grep** (a basename grep would be structurally 0-hit by design and prove nothing). The migration file's own addendum (`zzzz20260918090000_create_approval_rounds.ts`, lines 1-59, quoted in the design MD §2.1) walks each of this lane's new/edited files against the three named roots: `plugin-attendance/index.cjs` falls under root 1, `w4c3b-central-approval-hooks.ts` under root 2, and the migrations / `ApprovalProductService.ts` / `ApprovalBridgeService.ts` / `routes/approvals.ts` correctly fall **outside** all three roots (schema DDL and approval-side service/route code, not attendance-side group-policy/frozen-context reference sites). |
| 14 | Four attendance census pins re-checked on push | **Closed, re-run fresh this pass** (§A1.6, 60/60, including "exact-head HEAD scan: zero new/unclassified/out-of-boundary attendance DML" and "hard zero-bypass: current-tree open-debt set is exactly empty"). |
| 15 | FE sync pin must read backend source, not hand-transcribe | **Structurally closed (the guard is a `readFileSync` source pin, not a hand-transcribed array, and both FE files it checks against already carry `cancel_round`), but the guard itself is currently RED due to a regex defect — see §A4. Not "done", reported as a live finding.** |
| 16 | §5 I6 "撤销不限次" needs an explicit acceptance row | **Closed.** `approval-cancel-round-redemption.db.test.ts`'s `chain (§5 I6, 撤销不限次)` case is exactly this row; §A3 Mutation 2 proves it is load-bearing (disabling the round-close write turns it red). |
| 17 | §14.1 CJS mirror constant / §14.3 legacy-catch-500 mutation / §2-G2 time anchor — "zero mapping" in the taskbook | **Two of three closed, one N/A for this slice.** §14.1 CJS mirror constant: closed, pinned by `approval-cancel-round-plugin-mirror-constant.test.ts` (9 cases, green in §A1.2), and independently re-verified live in this pass via Mutation 1's sibling reasoning (the legacy-catch pass-through, not the mirror constant itself, but the same "removing the guard turns the specific mutation red" discipline). §14.3 legacy-catch-500 mutation: **closed and re-verified live in this pass** — §A3 Mutation 1 is exactly this mutation (disable outlet #7's pass-through ⇒ observe 500 instead of 409), run fresh, not merely cited. §2-G2 time anchor (the amend-only "generation" time-anchor field): **N/A to this slice** — G2 applies to amend rounds, out of scope per lock §7 (see design MD §1.1); this slice's `approval_rounds` schema has no amend-specific columns to anchor. |

## A9. What remains open, unverified, or blocked (honest list — not silently closed)

- **判据 II / 判据 IV / `attendance-parity.db.test.ts`**: not implemented in this slice (design MD
  §1.1, unchanged from Part B's Decision 3). Deferred to C-2, per the goal document's own slice
  ordering.
- **The FE sync-pin regex defect (§A4)**: CONFIRMED red on the current tree. Not fixed (不改代码).
  Registered for door review; the underlying FE/BE data (the union members and label map) are
  actually correct — only the guard's own extraction is broken.
- **§14.3 outlet #9's negative control** (upsertPlmMirror constant assertion): the design MD §4 notes
  this is "not independently re-verified by a dedicated test in this slice beyond the creation test's
  own row read-back" — i.e., no dedicated mutation test exists for this specific outlet row; the
  creation test's positive assertion (`source_system='platform', external_approval_id=NULL`) stands,
  but no test constructs the counter-scenario the lock's own mutation column describes (creation path
  rewritten to `source_system='plm'` + non-null external id). Left open.
- **No HTTP route exists for `createCancelRoundInstance`** in this tree — a caller-facing entry point
  is not part of this slice's own checklist scope (per the goal document's C-1 definition) and is not
  added here; every acceptance test in §A6 calls the service method directly or drives it via a
  seeded fixture, not via an end-user-reachable route. Flagged so the door review does not assume a
  route exists.
- **PR-body disclosure items (checklist #1, #2)**: no Draft PR exists yet for this slice at the time
  of writing — the disclosure obligations these items name (the s6a/vitest-config override rationale,
  the 45-sibling-census caveat) are recorded here and in the design MD, ready to carry into a PR body
  when one is opened, but that carrying-over has not itself happened yet.
- **The lock's own `suite` production mapping (§9-5)**: this slice's `metadata.suite` read is a
  disclosed placeholder (design MD §1.1); no production-mapping table exists, and none is claimed
  here.
- **Q-A/Q-B/Q-C as a ratified (not merely suggested) lock order**: the census (§A6's lock-order rows)
  supports the suggested order and shows it does not deadlock while the reversed order deterministically
  does, but per the lock's own §13 framing ("review suggestions, NOT owner ratify") this document does
  not claim §9-4 is closed by this evidence.
- **CI evidence is local, not a CI-run confirmation**: every command above ran on local Postgres
  15.17 (Homebrew, aarch64-apple-darwin), matching Part B's own disclosure that `plugin-tests.yml`'s
  actual provisioner is PG 14 (`ankane/setup-postgres@v1`) — this gap predates and is not introduced
  or closed by this pass.

---

# Part B — preserved round-2 record (2026-09-18, earlier; HEAD `296a47acb`; DB `metasheet2_lock_c_virgin`)

> Everything below this line is the file's content **as it stood before this task started**,
> unmodified. Its own numbers (Test Files/Tests counts, `EXIT` codes) describe a run against
> `metasheet2_lock_c_virgin` at an earlier HEAD and are **not** re-asserted as today's state — Part A
> above is the current-state record. This section is kept because its narrative content (why the
> virgin rerun mattered, how Q-B/Q-C were actually constructed, the Decision-3 boundary reasoning) is
> still accurate and would be lost by deletion.

Branch: `feat/approval-cancel-round-phase1`, HEAD at time of writing: `296a47acb` (rebased onto
`main@89f1ecdee`). Design lock: `approval-change-request-design-lock-draft-20260915.md` (ratified).
Supplementary gate checklist: `impl-supplementary-gate-checklist-20260918.md`. Goal definition:
`goal-three-locks-full-implementation-20260918.md`.

## Scope of this document

This records the closure of the six items handed to round 2 of the lane (outlet-guard #3, CI-wiring
decision 1, plugin-mirror-constant decision 2, the 判据 II/IV / attendance-parity blocked-with-reason
decision 3, the Q-B/Q-C lock-order census construction, and this verification document's own virgin-DB
rerun). It is **not** a full lock-coverage audit — items in the supplementary checklist not named in
round 2's task (e.g. §2-G2's time anchor) are out of scope here and are left for the door-review that
precedes the Draft PR.

## 1. Item-by-item closure

| # | Item | Commit(s) | Evidence |
|---|---|---|---|
| 1 | Outlet-guard #3 (`applyNodeTimeoutEffect`) — two-part oracle (outcome literal `skipped_cancel_round` + deadline actually consumed), negative control = two-round scan hitting the same instance, env-flag read site | `af015de07`, `3482d99c0` | `approval-cancel-round-node-timeout-effect.db.test.ts`, §2 below |
| 2 | Decision 1 — CI wiring: promote the seven `approval-cancel-round-*.db.test.ts` files into the required `test (20.x)` step (`plugin-tests.yml`'s `approval-real-db-integration`), delete the standalone `approval-realdb-cancel-round.yml`, recompute the s6a `pluginTestsWorkflow` pin in the same commit, add `approval-cancel-round-ci-wiring.test.ts` | `e394c9e9c` | §3 below |
| 3 | Decision 2 — plugin-side mirror constant `APPROVAL_CANCEL_ROUND_WORKFLOW_KEY` in `plugin-attendance/index.cjs`, byte-identical to the core constant, pinned by a dedicated test, used for a defensive (behavior-adding-nothing) check | `e630b6ca7` | §4 below |
| 4 | Decision 3 — `attendance-parity.db.test.ts` and redemption 判据 II/IV are blocked-with-reason on slice 2 | (documentation-only, this file) | §5 below |
| 5 | Q-B / Q-C lock-order census, constructed with forward+reversed order and positive controls (not "could not construct") | `dc0943ae0`, `738f01d4a`, `af57d325c`, `296a47acb` | §6 below, and §2 test output |
| 6 | This verification document, including a virgin-DB rerun | this commit | §2, §7, §8 |

## 2. Fresh virgin-DB rerun (this commit)

**Honest baseline first**: every green result cited in this lane's prior commit messages (`0cbd79fbd`'s
"full attendance suite green", `6e2acba9c`'s DML-inventory 60/60, `e630b6ca7`'s "5 files, all green
(45 tests)") ran against the private DB `metasheet2_lock_c`, which had already accumulated schema
state and fixture rows from earlier rounds of this lane (and possibly other work) — it is **not**
virgin. This section is the fresh rerun the task required, against a database created and migrated
from empty in this same step:

```
createdb metasheet2_lock_c_virgin
DATABASE_URL=postgres://chouhua@localhost:5432/metasheet2_lock_c_virgin \
  pnpm --filter @metasheet/core-backend migrate
# → every migration in the repo runs from zero, ending at
#   zzzz20260918110000_add_attendance_requests_approval_workflow_key — no error, no skip.
```

**Order of execution** (recorded because it affects how "virgin" is read for each leg): the seven
`approval-cancel-round-*.db.test.ts` files and the two new unit tests ran against
`metasheet2_lock_c_virgin` **first, immediately after migration, before anything else touched the
database** — that leg is genuinely virgin end-to-end. The seven Q1c-fixture-pairing attendance files
(§7) ran **afterward, against the same already-migrated database**, which by then carried the row-level
residue the cancel-round suites had left behind (each of those suites cleans up its own rows in
`afterAll`, but the schema-completeness value of a virgin migration — the actual point of this exercise
— was already proven by the first leg; the second leg is not claimed as virgin, only as "ran clean
against a DB whose migrations were applied from empty").

**Config note** (two-point wiring, shown empirically, not just quoted from comments): invoking the seven
`.db.test.ts` files under the *default* `vitest.config.ts` collects and skips-to-zero all of them
(confirmed: a first attempt using the default config produced `Test Files 2 passed (2)` — only the two
`tests/unit/*.test.ts` files ran; all seven `tests/integration/*.db.test.ts` files were silently excluded
by `vitest.config.ts`'s exclude list, exactly the "excluded from the no-DB job" half of the two-point
contract). The required CI step invokes them with `--config vitest.integration.config.ts`, which is the
config actually used below.

### 2a. The seven `approval-cancel-round-*.db.test.ts` files + both new unit tests

```
DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c_virgin \
EXPECT_DB=1 \
npx vitest --config vitest.integration.config.ts run \
  tests/integration/approval-cancel-round-lock-order-census.db.test.ts \
  tests/integration/approval-cancel-round-creation.db.test.ts \
  tests/integration/approval-cancel-round-redemption.db.test.ts \
  tests/integration/approval-cancel-round-seat-guards.db.test.ts \
  tests/integration/approval-cancel-round-attendance-fk-migration.db.test.ts \
  tests/integration/approval-cancel-round-outlet-guards.db.test.ts \
  tests/integration/approval-cancel-round-node-timeout-effect.db.test.ts

  Test Files  7 passed (7)
       Tests  44 passed (44)
```

(The 44 already includes the lock-order-census file's 10 tests; a separate standalone rerun of just
that file, for readable verbose output, also shows `Test Files 1 passed (1)` / `Tests 10 passed (10)`
— it is the same suite, not additional coverage.)

```
DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c_virgin \
EXPECT_DB=1 \
npx vitest run \
  tests/unit/approval-cancel-round-ci-wiring.test.ts \
  tests/unit/approval-cancel-round-plugin-mirror-constant.test.ts

  Test Files  2 passed (2)
       Tests  15 passed (15)
```

**Sentinel census**: every one of the seven files carries the top-of-file
`itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL …')` guard, confirmed mechanically —
not just "the ones I happened to look at":

```
grep -l "EXPECT_DB === '1'" tests/integration/approval-cancel-round-*.db.test.ts | wc -l
7
```

**Combined new-test total for this leg**: 44 + 15 = **59** tests, 9 files, 0 failures, 0 skips (the
sentinel itself is a passing assertion in each file, already counted).

### 2b. s6a provenance pin (no drift on the current tree)

```
node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
✔ sealed-export-package-provenance.test.cjs (355.7ms)
ℹ tests 1, pass 1, fail 0
```

### 2c. Typecheck

```
npx tsc --noEmit -p .   → no output (clean)
```

## 3. Decision 1 — CI-wiring closure detail

`e394c9e9c` moved the seven files from the deleted standalone `approval-realdb-cancel-round.yml` into
`plugin-tests.yml`'s `approval-real-db-integration` step (the same step id
`REAL_DB_STEP_IDS.approval` used by `scripts/ops/ci-realdb-step-contract.mjs`), recomputed the s6a
`pluginTestsWorkflow` digest in the same commit, and added
`packages/core-backend/tests/unit/approval-cancel-round-ci-wiring.test.ts`.

**`scripts/ops/ci-realdb-step-contract.mjs` "processed per its own mechanism," as the task required**:
the supplementary checklist's premise (a hardcoded `FILES` array at `:99-102`) does **not** hold at this
head — that shape does not exist in the current file:

```
grep -n "FILES" scripts/ops/ci-realdb-step-contract.mjs
(0 matches)
```

Its exports (`REAL_DB_STEP_IDS`, a step-body parser) take the step id and a file path as **call-time**
arguments; the new guard supplies `REAL_DB_STEP_IDS.approval` and each of the seven file paths itself,
so there was no static list in that script to update. This is recorded here rather than silently
skipped, since a reviewer working from the checklist's literal line numbers will look for it and not
find it.

**What the new guard actually proves, and its limit**: `approval-cancel-round-ci-wiring.test.ts` pins,
for each of the seven files: excluded from the no-DB `vitest.config.ts` job; present exactly once as a
whole-file argument of the required step; absent from the sibling multitable real-DB step; and the
standalone workflow file confirmed deleted. Its own commit message records a mutation check (cp the
workflow file → drop one file from the run-list → both this guard and the repo-wide
`approval-ci-coverage-enumeration.test.ts` turn red → restore → `cmp` byte-identical to the pinned
sha256) — the closed-world protection this lane actually has is that repo-wide enumeration test, not a
new census of every `*-ci-wiring.test.ts` sibling (memory: `feedback_attendance_new_file_census_trio`,
supplementary checklist item 1's "45 个同族" caution). **A per-sibling census across all 45
`*-ci-wiring` guards was not performed in this lane** — that caution names a different failure mode
(a *sibling* guard's own hardcoded array missing this lane's new files) than what was checked here (this
lane's own guard being internally correct), and is left for the pre-PR door review, not claimed closed
by this document.

Confirmed unchanged since that commit: `git status` on the workflow file and the pin file is clean at
this HEAD (see `git diff --stat origin/main..HEAD` in the round-2 orientation step — no uncommitted
changes to either).

## 4. Decision 2 — plugin mirror constant closure detail

`e630b6ca7` added `APPROVAL_CANCEL_ROUND_WORKFLOW_KEY = 'approval.cancel-round'` to
`plugins/plugin-attendance/index.cjs` (CJS boundary; same convention as the existing
`ATTENDANCE_APPROVAL_WORKFLOW_KEY` mirror at `:159`), and a defensive assertion in
`upsertAttendanceApprovalInstance` — the single chokepoint feeding both #10's `attendance_requests`
FK-pairing write and #11's `approval_instances.workflow_key` write — rejecting a payload that targets
the cancel-round key. `approval-cancel-round-plugin-mirror-constant.test.ts` pins: both constants
independently equal the literal (not merely equal to each other — guards against a
both-undefined vacuous pass); a source-text regex pins the *same identifier name* in `index.cjs`, not
just an equal value under a renamed identifier; the assertion throws for the cancel-round key and is
inert for the real attendance key and for missing/null payloads; and the "assigned exactly once" grep
claim behind the "adds no behavior" argument is itself mechanically re-checked in the test, not just
asserted in prose. Rerun in §2a above: 9/9 (this file's own test count includes the plugin-mirror suite
plus the shared assertion tests).

This second edit to `index.cjs` was made **after** `6e2acba9c` had already closed the four attendance
census pins (supplementary checklist item 14) for the *first* round of `index.cjs`/migration edits;
`e630b6ca7`'s own commit message records a fresh run of
`scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs` (60/60) for this second edit, so the
census closure is not stale for it.

## 5. Decision 3 — blocked-with-reason (attendance-parity, redemption 判据 II/IV)

**Status: blocked-with-reason. Left for slice 2. Not re-scheduled inside this lane.**

- `attendance-parity.db.test.ts` was never created in this lane. The file header of
  `approval-cancel-round-attendance-fk-migration.db.test.ts` (~lines 42-54) records this with its own
  `SUPERSEDED (2026-09-18)` marker (memory: `feedback_supersession_marker_must_evaluate_not_void.md` —
  the marker is pinned to the specific claim, not used to void the whole paragraph): the *original*
  reason ("blocked on WI-10/11, which are themselves blocked on WI-0's Q-B/Q-C closing") is no longer
  true, since §6 below shows Q-B/Q-C are now constructed and green. The *current* reason is
  OWNER-SCOPE, not technical: 判据 II (final approve exercising C-1's real attendance cancellation) and
  判据 IV (C-3's system-side close) are named as a second-slice item in this lane's own handoff — "a
  main-session ruling, not a technical blocker this file can close" (file's own words) — restated there
  as blocked-with-reason, not as a residual WI-0 dependency.
- Redemption's 判据 II and 判据 IV halves are not implemented here.
  `approval-cancel-round-redemption.db.test.ts` is explicitly scoped in its own title to "判据 III
  only" and its header (and the sibling outlet-guards/seat-guards file headers) name II/IV as
  "depend[ing] on WI-10/11/12, not on this branch."

Mechanical confirmation these are genuinely absent, not silently done elsewhere:

```
find . -iname "*attendance-parity*" -not -path "*/node_modules/*"
(no output — the file does not exist anywhere in the tree)

grep -rn "判据 II\|判据 IV" packages/core-backend/tests/integration/approval-cancel-round-*.db.test.ts
# 12 hits total, across attendance-fk-migration/redemption/outlet-guards/seat-guards. Re-read
# individually: several (redemption.db.test.ts:9,19,20,99; outlet-guards.db.test.ts:475) are
# substring artifacts of the string "判据 III" (which literally contains "判据 II" as a character
# prefix — "III" starts with "II") appearing in comments/a describe() title about 判据 III, not a
# claim about II. The remainder (attendance-fk-migration:50-51; redemption:10-11,16; outlet-guards:41;
# seat-guards:21) are genuine header/doc comments naming 判据 II and IV as a second-slice item out of
# this branch's scope. None of the 12 is a passing test assertion exercising 判据 II or IV.
```

This decision closes the item as **documented and boundaried**, not as "done" — the goal-definition
document's full-lock-coverage bar for redemption and attendance-parity remains open and is explicitly
not claimed met by this lane.

## 6. Q-B / Q-C lock-order census — construction, not an absence claim

Earlier in this lane's history, a commit (`0c7c990ab`, then partially retracted in `738f01d4a`) had
floated "Q-B may not be constructible" as a shortcut. That shortcut was withdrawn (`738f01d4a`:
"withdraw a false Q-B absence shortcut in the lock-order census") and both Q-B and Q-C were then
actually constructed (`dc0943ae0` for Q-A's own slice, `af57d325c` for Q-B/Q-C, hardened in `296a47acb`
for org-id isolation and mutation-tested scan coverage). All three legs (Q-A, Q-B, Q-C) live in the one
file `approval-cancel-round-lock-order-census.db.test.ts`, rerun on the virgin DB in §2a above (10/10):

- **Q-A**: `approval_instances` row lock vs. attendance class-`00` rollout advisory lock. Forward order
  (class-00 then instance row) does not deadlock (positive control) and correctly blocks-then-proceeds;
  the reversed order deadlocks deterministically (`40P01`).
- **Q-B**: `attendance_requests` row lock vs. attendance class-`11` operational-bulk-target advisory
  lock. Same shape: candidate order blocks-then-proceeds and has a passing positive control; the
  reversed order deadlocks deterministically (`40P01`).
- **Q-C**: record-link `row-auth` advisory lock vs. attendance class-`00` rollout advisory lock.
  `createCancelRoundInstance` is confirmed to never reference the record-link row-auth lock at all (a
  mechanical, freshly-re-read source scan — not a stale grep against an old head), so there is no order
  to violate; two positive controls prove the harness itself *can* see both locks held simultaneously
  via `pg_locks` and *can* force them into a real `40P01` deadlock when taken in opposite orders in an
  unrelated pairing — i.e., the "ABSENCE" verdict is not "the test couldn't construct a race," it is "a
  race was constructible and deliberately shown not to apply here."

## 7. Q1c fixture-pairing files — virgin-DB spot-check (in scope: files this lane modified)

The seven attendance `.db.test.ts`/`.test.ts` files this lane modified for `approval_workflow_key` /
`workflow_key` fixture pairing (Q1c, closed for non-virgin DB in `0cbd79fbd`) were also rerun against
the same migrated database, immediately after §2a (see the ordering caveat in §2 — this leg is not
claimed virgin, only "ran clean post-migration"):

```
DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c_virgin \
ATTENDANCE_TEST_DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c_virgin \
EXPECT_DB=1 \
npx vitest --config vitest.integration.config.ts run \
  tests/integration/attendance-approval-action-authorization.db.test.ts \
  tests/integration/attendance-approval-flow-dynamic-kind-s7-1.db.test.ts \
  tests/integration/attendance-decision-trace-w5-0.db.test.ts \
  tests/integration/attendance-plugin.test.ts \
  tests/integration/attendance-result-edit.test.ts \
  tests/integration/attendance-w4c3b-central-approval.db.test.ts \
  tests/integration/attendance-w4c3b-request-snapshots.db.test.ts

  Test Files  7 passed (7)
       Tests  298 passed (298)
```

This is a spot-check of the files this lane touched, not a rerun of the full ~150-file attendance
real-DB corpus named in `plugin-tests.yml`'s `attendance-real-db-integration` step — that full-corpus
run is what `0cbd79fbd` already recorded (against non-virgin `metasheet2_lock_c`) and re-running the
entire corpus is outside the six items this round was scoped to.

## 8. Environment disclosure (local vs. CI, not a new finding)

Local Postgres used for every run in this document: `PostgreSQL 15.17 (Homebrew) on
aarch64-apple-darwin25.2.0`, database `metasheet2_lock_c_virgin`, `lc_collate = en_US.UTF-8`, libc
locale provider (`psql -l`). `plugin-tests.yml`'s `approval-real-db-integration` step provisions
Postgres via `ankane/setup-postgres@v1` with `postgres-version: 14`. This is a pre-existing
version-vs-local gap that predates this lane (this document did not introduce it and does not attempt
to close it); it is noted here only so a reader of this verification does not mistake "green on
15.17/Homebrew" for "green on CI's actual PG 14 provisioner."

## 9. Grand total, this document

| Leg | Files | Tests | DB state |
|---|---|---|---|
| Cancel-round `.db.test.ts` × 7 (incl. lock-order-census standalone rerun) | 7 | 44 | virgin, first leg |
| Cancel-round unit tests × 2 | 2 | 15 | virgin, first leg |
| s6a provenance pin | 1 | 1 | n/a (no DB) |
| Attendance Q1c-pairing spot-check × 7 | 7 | 298 | post-migration, not virgin (second leg) |
| **Total** | **17 files** | **358** | 0 failures, 0 skips reported as passes |

`npx tsc --noEmit -p .` clean. `git status` clean at HEAD `296a47acb` before this commit.

## 10. Checklist status

All six round-2 items are closed: five by prior commits (traced in §1's table with commit SHAs), the
sixth (this document) by the virgin-DB rerun recorded in §2/§7 above. Decision 3 is closed as
**blocked-with-reason**, not as delivered — §5 is the authoritative record for what remains open for
slice 2 (attendance-parity, redemption 判据 II/IV) and must not be read as "done."
