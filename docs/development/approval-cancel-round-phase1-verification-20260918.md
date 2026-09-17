# Approval Cancel-Round Phase 1 — Verification (2026-09-18, finalized)

**Bottom line up front, so it cannot be missed by skimming to a later table**: Part A below
(round 3) reported one test this lane authored as currently RED on that tree —
`apps/web/tests/approvalBatchTransferView.spec.ts`'s FE/BE sync-pin guard for outlet #12 (§A4)
under-extracting the backend's error-code union because of a regex defect — and, per that round's
"不改代码" instruction, reported it rather than fixing it, leaving checklist item 15 not closed.
**Round 4 (Part C, below) fixes exactly that regex** (this round's task explicitly authorizes and
requires the fix, unlike round 3's) plus a stale, now-false source comment the gate review
(`impl-gate-C-slice1-round1-20260918.md`, P1-A/P2-A) additionally caught in the same file family.
Checklist item 15 is now **closed**. See Part C for the fix, the exact required-lane rerun, and two
fresh mutation probes proving the fix (and the new assertions it required) are load-bearing. Part A
and Part B are preserved verbatim below as the historical record of what round 3 actually observed;
read the supersession notes inline rather than the original text where the two disagree.

This document is finalized in three layers, kept separate rather than merged into one narrative:

- **Part A (round 3, 2026-09-18)**: a fresh rerun against the private DB **`metasheet2_lock_c`**
  (per instruction — not a freshly-created virgin DB), the full 17-item supplementary-checklist
  walk, a live mutation ledger with genuine backup→edit→run→restore→cmp cycles run in this pass, the
  lock's verification-table rows mapped to test file + case name + lane, and — because the task
  requires reporting defects rather than silently fixing them — two findings this pass surfaced on
  the current tree that were not in the prior record (§A2's shared-DB residue, §A4's red FE guard).
- **Part B (preserved, round 2, 2026-09-18 earlier)**: the existing content of this file at the time
  this task started, kept **verbatim, not discarded**, as the record of round 2's own virgin-DB rerun
  (against `metasheet2_lock_c_virgin`, HEAD `296a47acb`). Its numbers are **not** carried forward as
  today's evidence — Part A supersedes it for "is it green right now" (see the supersession notes
  added at the top of Part B's §9/§10) — but its narrative (the virgin-migration proof, the Q-B/Q-C
  census construction story, the decision-3 boundary reasoning) remains correct and is not restated.
- **Part C (round 4, 2026-09-18, this pass)**: the fix for §A4's red FE guard (P1-A of the
  independent gate review `impl-gate-C-slice1-round1-20260918.md`), bundled with that same review's
  P2-A (a stale, now-false source comment in the same file family). Part A and Part B are **not**
  edited in place — read together with the supersession notes this pass adds at each affected
  spot (BLUF above, §A4, the FE-sync-pin row in §A6, item 15 in §A8, and the BLOCKING bullet in
  §A9) rather than treating the original prose as current.

HEAD at the time of Part A: `b2f2d3ac3` (after this same commit's design-MD sibling; no code
changes are part of this commit — see §A3's mutation ledger for the two temporary, fully-restored
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

**Disposition, as recorded in round 3 — this is a BLOCKING open item, not a closed one**: per the
task's "不改代码" rule (applied here without carving out test files this lane itself authored, since
the instruction drew no such line), the regex was **not** fixed. This means **checklist item 15 is
NOT closed**: the lock's own requirement for outlet #12 ("同 PR 必改三处…同步钉") includes a *working*
sync guard, and this one currently cannot prove what it exists to prove. The underlying FE/BE data
(the union member, the label map entry) are correct — only the guard is broken — but a broken guard
is not a substitute for a working one, and this document does not present it as such. Reported here
as a CONFIRMED defect for the door review to register and fix (the minimal fix would let the
repeated group also skip a `/** ... */` block, or split the match on the closing `*/` before
applying the per-literal `matchAll`) — a fix that touches only this test file, not the FE/BE code it
verifies. See §A9 for this item restated as the lead blocking entry, and see the note this adds to
Part B's §9/§10 below (this finding also means the "second finding" this pass required is §A2,
immediately above — the two genuine findings this pass surfaced are §A2 and this section, not a
separate third section).

> **SUPERSEDED for currency, not for validity (round 4 / Part C note)**: the door review this
> paragraph asked for happened (`impl-gate-C-slice1-round1-20260918.md`, finding P1-A) and confirmed
> this exact root cause byte-for-byte, plus that it sits in the `web-tests` **required** branch
> check (a narrower but real correction to §A6's original "apps/web default job" lane label — see
> the note on that row). Part C below applies the minimal fix this paragraph names (strip
> `/\*[\s\S]*?\*\//g` before matching, not the split-on-`*/` alternative) and reruns green. The root
> cause and severity analysis above remain accurate as a record of what round 3 found; only the
> "not fixed" / "BLOCKING" verdict is superseded — **checklist item 15 is now closed.**

## A6. Lock verification-table → test file + case name + lane (full mapping)

Anchors are the lock's own §14.3 outlet table (lock:359-376) plus §14.1's judgment I/I″, §5's I3/I6,
and §14.2's 判据 III. "Lane" = the CI step this test file runs under (all seven `.db.test.ts` files
share one lane; the two `.test.ts` files run in the default no-DB unit-test job).

| Lock item | Test file | Case name (verbatim) | Lane |
|---|---|---|---|
| 判据 I (创建期写入正确谓词) | `approval-cancel-round-creation.db.test.ts` | `writes the dedicated instance, one pending round row, and an active seat for the original approver` | `approval-real-db-integration` (required, 20.x) |
| 判据 I (两向), **reverse direction** — 经公开 `createApproval` ⇒ 谓词假 (Part D / round 5 fix, gate P1-B row 3) | `approval-cancel-round-creation.db.test.ts` | assertion inside the same `writes the dedicated instance, ...` case (`isCancelRoundInstance(originalInstanceRow.rows[0]!)).toBe(false)`) | same |
| I3 (`uq_approval_rounds_pending_document`) | `approval-cancel-round-creation.db.test.ts` | `§5 I3 — a second cancel round cannot be started while one is pending (uq_approval_rounds_pending_document)` | same |
| §4 / §5 I3 / 判据 III 负控 — **the index itself**, bypassing the app-layer precheck (Part D / round 5 fix, gate P1-B row 4) | `approval-cancel-round-creation.db.test.ts` | `§4 / §5 I3 / §14.2 判据 III 负控 — the partial unique index itself is load-bearing, independent of the app-layer precheck (bypass createCancelRoundInstance and INSERT a second pending round directly ⇒ 23505)` | same |
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
| 判据 III, **正控 2** — 非原 requester revoke ⇒ 403 `APPROVAL_REVOKE_FORBIDDEN` (Part D / round 5 fix, gate P1-B row 1) | `approval-cancel-round-redemption.db.test.ts` | `判据 III 正控 2 (§14.2, §6 "仅原 requester"): a non-original-requester actor cannot revoke the cancel-round instance (403 APPROVAL_REVOKE_FORBIDDEN — NOT the create-time CANCEL_ROUND_REQUESTER_ONLY, a different code on a different path, §14.1 note)` | same |
| §14.1 seed evidence — reject without `comment` ⇒ 400 `REJECT_COMMENT_REQUIRED` (Part D / round 5 fix, gate P1-B row 2) | `approval-cancel-round-redemption.db.test.ts` | `§14.1 seed evidence: reject without a comment is rejected with the named error code (400 REJECT_COMMENT_REQUIRED, not a bare 400), proving the comment gate is present for the cancel-round node` | same |
| Q-A lock order | `approval-cancel-round-lock-order-census.db.test.ts` | `§9-4 order (class-00 then instance row): a rollout holder BLOCKS a later instance-row acquisition, which proceeds once released` + reversed-order + positive-control siblings | same |
| Q-B lock order | `approval-cancel-round-lock-order-census.db.test.ts` | `candidate order (class-11 then attendance_requests row): a target-lock holder BLOCKS a later row acquisition, which proceeds once released` + reversed + positive-control siblings | same |
| Q-C lock order | `approval-cancel-round-lock-order-census.db.test.ts` | `ABSENCE: createCancelRoundInstance never references the record-link row-auth lock (mechanical scan, re-read fresh)` + two POSITIVE CONTROL siblings proving the harness can force a real `40P01` | same |
| CI wiring (lane decision 1) | `approval-cancel-round-ci-wiring.test.ts` | 6 cases (see §A1.2) | default unit job |
| Plugin mirror constant (lane decision 2) | `approval-cancel-round-plugin-mirror-constant.test.ts` | 9 cases (see §A1.2) | default unit job |
| FE sync pin (§14.3 #12, checklist item 15) | `apps/web/tests/approvalBatchTransferView.spec.ts` | `names every skip code the server declares, and falls back for an unrecognised one` | ~~apps/web default job — currently RED, see §A4~~ **SUPERSEDED (round 4 / Part C): lane corrected to `web-tests` (required, no-paths-filter check on `main`'s branch protection — this row's original lane label was itself wrong, per gate finding P1-A), and GREEN after Part C's fix. See Part C.** |

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
| 15 | FE sync pin must read backend source, not hand-transcribe | ~~Structurally closed..., but the guard itself is currently RED due to a regex defect — see §A4. Not "done", reported as a live finding.~~ **SUPERSEDED (round 4 / Part C): fixed and GREEN. The guard is a `readFileSync` source pin (not hand-transcribed), it strips block comments before matching so the `cancel_round`/`error` members are no longer skipped, both FE files it checks against already carried `cancel_round`, and two new assertions pin the dedicated skip-reason copy specifically (not just "non-empty"). See Part C.** |
| 16 | §5 I6 "撤销不限次" needs an explicit acceptance row | **Closed.** `approval-cancel-round-redemption.db.test.ts`'s `chain (§5 I6, 撤销不限次)` case is exactly this row; §A3 Mutation 2 proves it is load-bearing (disabling the round-close write turns it red). |
| 17 | §14.1 CJS mirror constant / §14.3 legacy-catch-500 mutation / §2-G2 time anchor — "zero mapping" in the taskbook | **Two of three closed, one N/A for this slice.** §14.1 CJS mirror constant: closed — pinned by `approval-cancel-round-plugin-mirror-constant.test.ts`'s 9 cases, green fresh in §A1.2 (no separate mutation was run against the mirror constant specifically in this pass; the 9 cases already include the "positive control: a renamed/absent identifier would fail" case, which is itself a mutation-shaped assertion). §14.3 legacy-catch-500 mutation: **closed and re-verified live in this pass** — §A3 Mutation 1 is exactly this mutation (disable outlet #7's pass-through ⇒ observe 500 instead of 409), run fresh, not merely cited. §2-G2 time anchor (the amend-only "generation" time-anchor field): **N/A to this slice** — G2 applies to amend rounds, out of scope per lock §7 (see design MD §1.1); this slice's `approval_rounds` schema has no amend-specific columns to anchor. |

## A9. What remains open, unverified, or blocked (honest list — not silently closed)

- ~~BLOCKING — the FE sync-pin regex defect (§A4)~~ **RESOLVED (round 4 / Part C)**:
  `apps/web/tests/approvalBatchTransferView.spec.ts` was CONFIRMED red at round 3 (this lane's own
  diff), independently confirmed by the gate review (`impl-gate-C-slice1-round1-20260918.md` P1-A,
  which additionally traced the exact same root cause byte-for-byte and established it sits in the
  `web-tests` **required** branch-protection check, not the "apps/web default job" this document
  originally said). Part C fixes the extraction regex, adds a dedicated-copy assertion for
  `cancel_round` (P1-A's suggested closure line), and fixes the stale `api.ts` comment the same
  review flagged as P2-A. **Checklist item 15 is now closed.** See Part C for the rerun and mutation
  evidence.
- **判据 II / 判据 IV / `attendance-parity.db.test.ts`**: not implemented in this slice (design MD
  §1.1, unchanged from Part B's Decision 3). Deferred to C-2, per the goal document's own slice
  ordering.
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

> **SUPERSEDED for currency, not for validity (round 3 / Part A note)**: the "Attendance
> Q1c-pairing spot-check × 7 / 298" row below was true against `metasheet2_lock_c_virgin` at
> `296a47acb`. A fresh rerun of the same seven files against `metasheet2_lock_c` in Part A §A1.7
> shows **1 file failed, 2 tests failed (296 passed)** — traced in Part A §A2 to shared-DB residue
> in that long-lived database, not to a code regression (a freshly migrated isolated DB reruns all
> 166 of `attendance-plugin.test.ts` clean, including both previously-failing cases). The row below
> is left as originally written for historical accuracy; do not quote it as today's state — quote
> Part A §A1.7/§A2 instead.

| Leg | Files | Tests | DB state |
|---|---|---|---|
| Cancel-round `.db.test.ts` × 7 (incl. lock-order-census standalone rerun) | 7 | 44 | virgin, first leg |
| Cancel-round unit tests × 2 | 2 | 15 | virgin, first leg |
| s6a provenance pin | 1 | 1 | n/a (no DB) |
| Attendance Q1c-pairing spot-check × 7 | 7 | 298 | post-migration, not virgin (second leg) |
| **Total** | **17 files** | **358** | 0 failures, 0 skips reported as passes |

`npx tsc --noEmit -p .` clean. `git status` clean at HEAD `296a47acb` before this commit.

## 10. Checklist status

> **SUPERSEDED for currency, not for validity (round 3 / Part A note)**: "all six round-2 items are
> closed" was true at `296a47acb` for round 2's own six-item scope. Part A above performs the full
> 17-item supplementary-checklist walk this task additionally required and finds **one item (15,
> the FE sync-pin guard) currently red** — see Part A §A4/§A8/§A9. Read this section as "round 2's
> own six items, closed" — a narrower and still-true claim — not as "the checklist is fully closed."

All six round-2 items are closed: five by prior commits (traced in §1's table with commit SHAs), the
sixth (this document) by the virgin-DB rerun recorded in §2/§7 above. Decision 3 is closed as
**blocked-with-reason**, not as delivered — §5 is the authoritative record for what remains open for
slice 2 (attendance-parity, redemption 判据 II/IV) and must not be read as "done."

---

# Part C — round 4 fix (2026-09-18, this pass)

**Scope of this pass**: fix the two round-3 findings the independent gate review
(`impl-gate-C-slice1-round1-20260918.md`, dated 2026-09-18) confirmed as its **P1-A** and **P2-A**
— the only two findings this pass addresses. The review's other findings (P1-B's four missing
acceptance rows, P2-B's seed-visibility disclosure, P3-A through P3-E) are **not** touched here;
they remain open for a subsequent fix-round step and are not re-described in this section.
HEAD before this pass's commit: `95eccb89b` (the exact HEAD the gate review reviewed). This pass's
code changes touch exactly two files, both `apps/web`, neither backend/DB code:
`apps/web/tests/approvalBatchTransferView.spec.ts` and `apps/web/src/approvals/api.ts` — plus this
document (see §C3 for the distinction between "commit touches three paths" and "commit touches
zero backend/CI code," both of which are true and neither of which contradicts the other).

## C1. P1-A fix — the sync-pin's extraction regex now tolerates the JSDoc block between members

**Root cause** (already isolated correctly in round 3 — see Part A §A4 above, not restated in
full here): the regex `/export type ApprovalBulkReassignSkipReason\s*=\s*((?:\s*\|\s*'[^']+')+)/`
requires each successive `| '...'` union member to be reachable via whitespace-only (`\s*`)
before the next `|`. `ApprovalProductService.ts:386-405` has a multi-line `/** … */` JSDoc between
`'target-user-invalid'` and `'cancel_round'` explaining the latter's byte-exactness requirement;
`\s*` cannot cross that block, so the repeated group silently stopped at six of eight members and
never reached `'cancel_round'`/`'error'`.

**Fix, verbatim** (`apps/web/tests/approvalBatchTransferView.spec.ts`): strip block comments from
the source text *before* matching the union, so the whitespace-only assumption between remaining
tokens holds again:

```js
const serviceSrcNoComments = serviceSrc.replace(/\/\*[\s\S]*?\*\//g, '')
const unionMatch = serviceSrcNoComments.match(
  /export type ApprovalBulkReassignSkipReason\s*=\s*((?:\s*\|\s*'[^']+')+)/,
)
```

This is the first of the two minimal fixes Part A §A4 itself named ("let the repeated group also
skip a `/** … */` block") — chosen over the "split on `*/`" alternative because it is a single line
and does not need special-casing where the closing `*/` falls relative to a union member boundary.

Two assertions were added, not just the regex fix:
1. `expect(serverCodes).toContain('cancel_round')` — direct proof the comment-stripping did not
   just widen the match harmlessly; the specific member the JSDoc guards against being missed must
   actually be present in what got extracted.
2. `expect(describeSkipReason('cancel_round', true)).toBe('该审批处于撤销轮中，暂不可改派')` (+ the
   `.not.toBe('未转交（原因未知）')` and English-locale forms) — the lock's own §14.3 #12 FE
   acceptance line verbatim ("dedicated copy, not the unknown-reason fallback"). The pre-existing
   generic loop only asserted `describeSkipReason(code, false)).not.toBe('')`, which a regression
   that silently fell back to the (non-empty) unknown-reason copy would **not** have caught — see
   Mutation 2 below for the constructed proof of exactly that gap.

## C2. P2-A fix — the stale, self-contradicting comment in `api.ts`

`apps/web/src/approvals/api.ts:1646-1655`'s comment on the FE `ApprovalBulkReassignSkipReason`
type alias read (verbatim, before this fix): "ADDED HERE AHEAD OF the backend union member landing
(tracked separately; `ApprovalProductService.ts`'s own `ApprovalBulkReassignSkipReason` does not
declare it yet) … the pin is EXPECTED to fail until that backend PR lands." That was true at the
moment the comment was written, but the backend union has since declared `cancel_round` **on this
same branch** (`ApprovalProductService.ts:404`) — so the comment was both a stale historical claim
and, worse, an argument that pre-justified the P1-A red as "expected," exactly the pattern
`feedback_asserted_invariant_is_a_bug` / `feedback_source_text_assertions_are_not_behaviour` warn
about. Rewritten to state the current, true relationship (both sides declare the literal; the
sync-pin now verifies the two match byte-for-byte) rather than a landing sequence that already
happened.

## C3. Rerun evidence — the exact commands, this pass

Single file:
```
$ cd apps/web && npx vitest run tests/approvalBatchTransferView.spec.ts
 Test Files  1 passed (1)
      Tests  72 passed (72)
```

The gate review's exact `web-tests` required-lane invocation
(`apps/web/scripts/run-required-web-tests.sh:779`, run verbatim, not paraphrased):
```
$ npx vitest run approvalNavTodoBadge approvalNavDelegationEntry approvalBatchTransferView approvalNavBatchTransferEntry --reporter=dot
 Test Files  4 passed (4)
      Tests  107 passed (107)
```
This is the actual required-check content, not a proxy for it — it is line 779 of the script that
`.github/workflows/web-tests.yml`'s job `web-tests` runs, copied character-for-character.

**Not rerun this pass, by scope**: the seven `approval-cancel-round-*.db.test.ts` real-DB suites,
the two backend unit tests, `packages/core-backend`'s typecheck, and the 38 sibling `*-ci-wiring`
guards — none of the files this pass's commit touched are backend/DB or CI-config code, so none of
those suites exercise anything this pass changed. Verified with a *scoped* diff against the code
directories those suites cover, not the raw file count (the raw diff includes this document itself,
which is not code):
```
$ git diff 95eccb89b HEAD --name-only -- packages plugins .github
(empty)
```
The full (unscoped) `git diff 95eccb89b HEAD --name-only` is three paths — the two `apps/web` files
plus this document — which is the true count for "what did this commit touch," distinct from the
narrower "did it touch backend/CI code" claim the empty scoped diff above actually supports. A
subsequent step that also touches P1-B's backend acceptance rows must rerun the real-DB suites;
this step does not claim to have done so.

## C4. Mutation ledger — two probes, `cp`-backup → edit → run → restore → `cmp`, this pass

Backup directory `/tmp/gate-c-slice1-round1-backups/`. Each mutation run in isolation on the single
spec file; `git status --porcelain` was empty both before this pass's edits and after each restore.

| # | Mutated | Change | Observed red | Restore |
|---|---|---|---|---|
| P1 | `approvalBatchTransferView.spec.ts` | Reverted the comment-strip: matched `serviceSrc` directly instead of `serviceSrcNoComments` (i.e., undid exactly the C1 fix, nothing else) | `1 failed \| 71 passed (72)`; `AssertionError: expected [ 'not-found', 'not-pending', …(4) ] to include 'cancel_round'` — the new `toContain('cancel_round')` assertion catches the exact round-3 defect on its own, one line, no dependency on the later `toEqual` | `cmp` identical to backup |
| P2 | `batchTransfer.ts` | Kept the `cancel_round` key present (so the bidirectional sync-pin `toEqual` still passes) but set its value to the **fallback text itself** — `{ zh: '未转交（原因未知）', en: 'Not transferred (unrecognised reason)' }` — simulating a regression that silently degrades to the unknown-reason copy without removing the key | `1 failed \| 71 passed (72)`; `AssertionError: expected '未转交（原因未知）' to be '该审批处于撤销轮中，暂不可改派'` at the new dedicated-copy assertion — confirmed this is **not** caught by the pre-existing `describeSkipReason(code, false)).not.toBe('')` loop (that loop stays green under this mutation; only the new assertion reds), proving the new assertion adds real discriminating power rather than duplicating existing coverage | `cmp` identical to backup |

Full green rerun after both restores, confirmed in §C3 above (this is the same 72/72 and 107/107
run, taken after the restores, not before).

## C5. Working-tree discipline, this pass

- `git status --porcelain` was empty at the start of this pass (matching the gate-review HEAD
  `95eccb89b`'s clean state); immediately before committing, the three staged paths were
  `apps/web/src/approvals/api.ts`, `apps/web/tests/approvalBatchTransferView.spec.ts`, and this
  document; `git status --porcelain` is empty again after the commit (clean tree, nothing left
  uncommitted).
- Zero `git checkout --`; all mutation reverts were `cp`-restore + `cmp`-verified, per §C4.
- No lock file, no `reviews/` file, no `origin/main` state touched.

## C6. Checklist item 15 and gate findings P1-A/P2-A — final disposition

**Checklist item 15: CLOSED.** The sync-pin is green, reads backend source (not a hand-transcribed
array), tolerates the JSDoc comment between union members, and specifically pins the dedicated
`cancel_round` copy rather than only "some non-empty string."
**Gate finding P1-A: FIXED**, per §C1/§C3/§C4 (P1) above.
**Gate finding P2-A: FIXED**, per §C2 above.
Both fixes verified in the exact required-lane invocation the gate review traced to
`main`'s branch protection (§C3), not merely in isolation.

---

# Part D — round 5 fix (2026-09-18, this pass)

**Scope of this pass**: fix the gate review's **P1-B** finding
(`impl-gate-C-slice1-round1-20260918.md`, dated 2026-09-18) — the four lock-named acceptance rows
the review found present in the lock text but absent from every test file in this lane, and not
disclosed as open in either this document's §A6 mapping table or its §A9 "what remains open" list
(the review's own diagnosis: "验收集合不自洽" / `feedback_acceptance_criteria_set_must_be_self_consistent`).
This pass does **not** touch P2-B (seed-visibility disclosure) or P3-A through P3-E; those remain
open for a subsequent step. HEAD before this pass's commit: `cd2de9622` (the head left by Part C's
own follow-up correction).

Four rows, each closed by adding a real, currently-passing acceptance assertion — every gap was a
missing TEST, not a missing production behavior; no lock-anchored row required a source change.

## D1. 判据 III 正控 2 (§14.2, §6 "仅原 requester") — non-original-requester revoke ⇒ 403 APPROVAL_REVOKE_FORBIDDEN

Lock text (§14.2, verbatim): "正控 2:**非原 requester** 发起 revoke ⇒ 403 `APPROVAL_REVOKE_FORBIDDEN`
(§6「仅原 requester」的正向证据)". Gate review, AS OF its reviewed HEAD `95eccb89b` (before this pass):
a full-corpus grep for `APPROVAL_REVOKE_FORBIDDEN` in a cancel-round context returned **0** hits (the
only match anywhere, `approval-instance-readability-s1.db.test.ts`, is unrelated to cancel rounds).
Re-run fresh on this pass's tree, for the record — now **2** files, the pre-existing unrelated one
plus this pass's own new case:
```
$ grep -rln "APPROVAL_REVOKE_FORBIDDEN" packages/core-backend/tests apps/web/tests
packages/core-backend/tests/integration/approval-instance-readability-s1.db.test.ts
packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts
```

Added: `approval-cancel-round-redemption.db.test.ts`, new case `判据 III 正控 2 (...)`. Seeds a
pending cancel round (`seedPendingCancelRound`), issues `revoke` from a fresh, never-granted
`impostorId` actor, asserts `403` + `body.error.code === 'APPROVAL_REVOKE_FORBIDDEN'`, then asserts
the round is untouched (`outcome === 'pending'`, `ended_at === null`), then — POSITIVE CONTROL — the
true original requester still succeeds against the **same** round afterward
(`outcome === 'withdrawn'`), proving the guard is not vacuously green because the round was already
broken some other way.

Distinguished, in the test's own name and its lead comment, from `CANCEL_ROUND_REQUESTER_ONLY`
(create-time, WI-16, a **different** error code on a **different** path, already covered in
`creation.db.test.ts`) — the lock's own §14.1 note flags exactly this confusion as a trap ("两者混同
正是…陷阱").

## D2. §14.1 seed evidence — reject without `comment` ⇒ 400 REJECT_COMMENT_REQUIRED

Lock text (§14.1, verbatim): "mutation: ... 去掉 `comment` ⇒ 400 **`REJECT_COMMENT_REQUIRED`**
(断言错误码,不断言裸 400;证明评论门在场)". Gate review, AS OF its reviewed HEAD `95eccb89b` (before
this pass): a full-corpus grep for `REJECT_COMMENT_REQUIRED` in a cancel-round context returned **0**
hits (its 2 matches elsewhere, `approvals-bridge-routes.test.ts` and
`approval-comment-required.db.test.ts`, are unrelated suites). Re-run fresh on this pass's tree, for
the record — now **3** files, the two pre-existing unrelated ones plus this pass's own new case:
```
$ grep -rln "REJECT_COMMENT_REQUIRED" packages/core-backend/tests apps/web/tests
packages/core-backend/tests/unit/approvals-bridge-routes.test.ts
packages/core-backend/tests/integration/approval-comment-required.db.test.ts
packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts
```

Added: `approval-cancel-round-redemption.db.test.ts`, new case `§14.1 seed evidence: reject without
a comment ...`. Seeds a pending cancel round, issues `reject` from the resolved approver **without**
a `comment` field, asserts `400` + `body.error.code === 'REJECT_COMMENT_REQUIRED'`, asserts the
round is still `pending`/`ended_at === null`, then — POSITIVE CONTROL — the same reject **with** a
comment succeeds and terminates the round (`outcome === 'rejected'`).

**Self-correction, same pass, caught by advisor review before this step returned**: the HTTP
assertion above does NOT, by itself, discriminate the lock's actual requirement — "节点操作的评论要求
= 显式值 ... 不靠默认" (the node must carry the comment requirement EXPLICITLY, not rely on a
default). `effectiveCommentRequired` (`approval-effective-node-operations.ts:95-104`) falls back an
ABSENT node-level `commentRequired` to the instance's `policy_snapshot.rejectCommentRequired`, and an
absent snapshot value ALSO resolves to `'reject_only'` (`snapshotValue === false ? 'never' :
'reject_only'`) — so the 400 fires whether the seed wrote the key explicitly or omitted it entirely.
Confirmed by a live DB-row mutation probe (not a source-code `cp` probe, since the seed's
`runtime_graph` is materialized into `approval_published_definitions` at migration time, not
re-evaluated per test run): backed up the definition row's `runtime_graph` JSON
(`psql -tAc "select runtime_graph::text from approval_published_definitions where
id='00000000-0000-4000-8000-000000000003'"` to a file), `jsonb_set` the `cancel_approval` node's
`nodeOperationPolicy` to `{}` (removing the `commentRequired` key), reran the case — **stayed
green** (`1 passed`), confirming the HTTP-only assertion is confounded exactly as predicted. Restored
the row from the backed-up JSON text and re-`SELECT`ed it back into a second file; `diff` against the
original was empty.

**Fix, same commit**: added a direct read of the seed's own `approval_published_definitions` row at
the top of this test — `SELECT pd.runtime_graph FROM approval_instances i JOIN
approval_published_definitions pd ON pd.id = i.published_definition_id WHERE i.id = $1`, then
`expect(...cancel_approval node's config.nodeOperationPolicy.commentRequired).toBe('reject_only')` —
the same discipline as this lane's existing CJS mirror-constant pin, reading the actual seeded value
rather than inferring it from the HTTP response. Re-ran the SAME `jsonb_set`-to-`{}` mutation against
this updated test: now **red** at the new assertion (`expected undefined to be 'reject_only'`), then
restored the row again (`diff` empty a second time) and reran the full case clean. The combination of
this explicitness pin (proves the seed writes the value, not the default) plus the HTTP 400 (proves
the value is load-bearing at the reject gate) together satisfy the lock's full sentence; neither
alone would have.

## D3. 判据 I(两向), reverse direction — a publicly-created instance does NOT satisfy the cancel-round predicate

Lock text (§14.1, verbatim): "判据 I(两向):经专用路径 ⇒ 谓词真;**经公开 `createApproval` ⇒ 谓词假**。"
Gate review: the existing creation test only asserted the forward direction
(`isCancelRoundInstance(instance!)).toBe(true)` on the DEDICATED instance); no assertion anywhere in
the corpus covered the reverse direction on the ORIGINAL (publicly-created) instance.

Added: one assertion inside `approval-cancel-round-creation.db.test.ts`'s existing
`writes the dedicated instance, ...` case, immediately after the original document is created via
the public path and before the dedicated cancel-round instance is created:
```ts
const originalInstanceRow = await pool().query<{ workflow_key: string | null }>(
  `SELECT workflow_key FROM approval_instances WHERE id = $1`,
  [documentId],
)
expect(isCancelRoundInstance(originalInstanceRow.rows[0]!)).toBe(false)
```

**Discriminating-power mutation** (§14.3 #1's own 负控 — "公开路径写入轮次键 ⇒ 判据 I 反向红" — run
once as a probe, NOT committed as permanent code, since it would break every non-cancel-round
instance in the corpus): `cp`-backed up `ApprovalProductService.ts`, edited the SQL literal at line
8079 (the public `createApproval` INSERT's hardcoded `workflow_key` value) from
`'approval-product-template'` to `'approval.cancel-round'`, reran the single test:
```
$ DATABASE_URL=... EXPECT_DB=1 npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-creation.db.test.ts -t "writes the dedicated instance"
 × writes the dedicated instance, one pending round row, and an active seat for the original approver
   → expected true to be false
 Tests  1 failed | 5 skipped (6)
```
Restored via `cp` from the backup; `cmp` confirmed byte-identical to the pre-mutation file;
`git status --porcelain` empty immediately after restore. The new assertion has real discriminating
power — it is not vacuously true against this codebase.

## D4. §4 / §5 I3 / §14.2 判据 III 负控 — the partial unique index itself, not just the app-layer precheck

Lock text (§4): "部分唯一索引 `uq_approval_rounds_pending_document`... 与 C-3 配合才成立" plus §14.2's
own 判据 III 负控 phrasing ("同单据再发起 cancel 轮被唯一索引拒(断言 23505/409)"). Gate review: the
existing "§5 I3" test's own `CANCEL_ROUND_ALREADY_PENDING` assertion is produced entirely by
`createCancelRoundInstance`'s own pre-check (`APS:8377`, a plain `SELECT ... WHERE outcome='pending'`
issued before any INSERT) — the method's own code comment says as much ("this pre-check only turns
the common case into a named error instead of a raw constraint violation"). Deleting the index
outright would leave the existing test green, because the pre-check fires first every time a call
goes through the service. The index itself had zero acceptance.

Added: `approval-cancel-round-creation.db.test.ts`, new case
`§4 / §5 I3 / §14.2 判据 III 负控 — the partial unique index itself is load-bearing, ...`. After a
service-created pending round exists, the test **bypasses the service entirely** with a raw
`INSERT INTO approval_rounds (...) VALUES (..., 'pending', ...)` issued directly from the test's own
pool connection (never through `createCancelRoundInstance`, so the app-layer pre-check is never
consulted) targeting the same `document_id`. Asserts the raw insert rejects with
`error.code === '23505'` and `error.constraint === 'uq_approval_rounds_pending_document'` — the real
Postgres constraint violation, not the service's translated `CANCEL_ROUND_ALREADY_PENDING`. Then
asserts exactly one round row remains for the document (the failed statement left nothing behind)
and it is still the original pending row.

This test is directly constructible without any source mutation (bypassing the service via a raw
SQL insert is itself the discriminating mechanism), so no `cp`-backup probe was run for this row —
the test's own bypass IS the proof the index (not merely the pre-check) rejects the row.

## D5. Rerun evidence — the exact commands, this pass

```
$ cd packages/core-backend
$ DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-{lock-order-census,creation,redemption,seat-guards,attendance-fk-migration,outlet-guards,node-timeout-effect}.db.test.ts
 Test Files  7 passed (7)
      Tests  47 passed (47)
```
(Part B's own count was 44; +3 this pass — D1, D2, D4 are each a new `it()`; D3 is a new assertion
inside an already-existing case, so it does not add to the test count.)

```
$ npx tsc --noEmit -p .
TSC-EXIT:0     (no output)
```

**Not rerun this pass, by scope**: the two backend unit tests
(`approval-cancel-round-ci-wiring.test.ts`, `approval-cancel-round-plugin-mirror-constant.test.ts`)
and the FE spec — this pass touches only `approval-cancel-round-creation.db.test.ts` and
`approval-cancel-round-redemption.db.test.ts`, both already rerun above; neither of the unit-test
files nor the FE spec reads or is affected by either changed file:
```
$ git diff cd2de9622 HEAD --name-only
docs/development/approval-cancel-round-phase1-verification-20260918.md
packages/core-backend/tests/integration/approval-cancel-round-creation.db.test.ts
packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts
```
No `plugin-tests.yml`, `vitest.config.ts`, or any new file was touched — both changed files already
run inside the existing two-point wiring, so no s6a recompute is needed for this pass.

## D6. Mutation ledger — this pass

Backup directory `/tmp/gate-c-slice1-backups/`.

| # | Mutated | Change | Observed red | Restore |
|---|---|---|---|---|
| P1B-1 | `ApprovalProductService.ts` | Public `createApproval`'s hardcoded `workflow_key` SQL literal (line 8079) changed from `'approval-product-template'` to `'approval.cancel-round'` | `1 failed \| 5 skipped (6)`; `expected true to be false` at the new §D3 reverse-direction assertion | `cmp` identical to backup |
| P1B-2a | `approval_published_definitions.runtime_graph` row (DB-row probe, not source — see D2's self-correction) | `cancel_approval` node's `nodeOperationPolicy` set to `{}` via `jsonb_set`, dropping the explicit `commentRequired: 'reject_only'` key | Ran BEFORE the D2 fix's explicitness pin existed: `1 passed` — confirmed the confound (HTTP-only assertion stays green with the key gone) | `diff` against the pre-mutation `runtime_graph` JSON text, empty |
| P1B-2b | same row, same mutation, re-run AFTER the D2 fix's explicitness pin was added | (same `jsonb_set` to `{}`) | `1 failed \| 5 skipped (6)`; `expected undefined to be 'reject_only'` at the new pin — now catches it | `diff` against the pre-mutation `runtime_graph` JSON text, empty (second restore, second `diff`) |

D1 and D4's own POSITIVE CONTROL / bypass-construction steps (see D1/D4 above) serve the same
discriminating-power role for those two rows without a source mutation: D1's positive control proves
revoke genuinely still works on the same fixture immediately after the negative assertion, and D4's
raw-SQL bypass is itself the discriminating mechanism — no code deletion could make it "more red,"
since the constraint either exists in the schema or it does not. D2 needed an actual probe (P1B-2a/2b
above) because its first draft's HTTP-only assertion turned out NOT to discriminate the lock's real
requirement — see D2's self-correction paragraph.

## D7. Working-tree discipline, this pass

- `git status --porcelain` was empty at the start of this pass (matching HEAD `cd2de9622`'s clean
  state); the only paths staged before commit are the two `.db.test.ts` files plus this document;
  `git status --porcelain` is empty again after the commit.
- One `cp`-backup → edit → run → restore → `cmp` cycle on `ApprovalProductService.ts` source (§D3,
  P1B-1 in §D6). Two `psql`-backup → `jsonb_set` → run → restore → `diff` cycles on the
  `approval_published_definitions.runtime_graph` DB row (§D2's self-correction, P1B-2a/2b in §D6) —
  a DB-row mutation rather than a source-code one, since the seed is materialized into that row at
  migration time and is not re-read from `approval-cancel-round-published-definition.ts` per test
  run; each restore was diffed byte-for-byte against the pre-mutation `SELECT ...::text` capture.
  Zero `git checkout --` anywhere in either discipline.
- No lock file, no `reviews/` file, no `origin/main` state, no CI-config file, no migration file
  touched (the DB-row mutation above changed a row's data in the private `metasheet2_lock_c`
  database, not any migration file, and was fully restored).

## D8. §A6 / §A9 correction and gate finding P1-B — final disposition

**§A6 updated**: four new rows appended (二处 near the 判据 I / I3 cluster for D3/D4, 二处 near the
判据 III cluster for D1/D2), each cross-referenced to this Part D — the mapping table's own
self-consistency defect the gate review named is now closed for these four rows.
**§A9 unchanged**: none of the four rows was ever listed there (that omission was exactly the gate
finding), so there is nothing to remove; nothing new needs to be added to §A9 either, since all four
are now closed rather than deferred.

**Gate finding P1-B: FIXED** — all four missing acceptance rows (正控 2, `REJECT_COMMENT_REQUIRED`,
判据 I reverse direction, the partial unique index) now have real, currently-green,
discriminating-power-confirmed acceptance tests, per §D1-D4/D5/D6 above. The review's other findings
from the same round (P2-B, P3-A through P3-E) remain open, untouched by this pass.
