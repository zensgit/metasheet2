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
- **Part D (round 5)**: closes the gate review's P1-B (four missing acceptance rows). **Part E
  (round 6)**: closes P3-C (two unrun mutations) and P3-D (`policy_snapshot_at_create.definitionPolicy`
  had zero assertion). **Part F (round 7)**: docs-only — fixes the P3-A wording gap and discloses
  P2-B into the design MD (both left OPEN, owner-gated), and adds **§F3**, the single authoritative
  per-finding disposition table for all nine gate findings. **If you want "is finding X closed right
  now," read §F3, not the closing paragraph of whichever Part you happen to be in** — those paragraphs
  are each correct only for their own pass.

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
| §4 `policy_snapshot_at_create.definitionPolicy` (原样冻结原单据策略) — Part E / round 6 fix, gate P3-D | `approval-cancel-round-creation.db.test.ts` | assertion inside the same `writes the dedicated instance, ...` case (`expect(roundRows.rows[0].policy_snapshot_at_create.definitionPolicy).toEqual(originalInstanceRow.rows[0]!.policy_snapshot)`); fixture publishes the original with `allowRevoke: false`, deliberately different from the cancel round's own `allowRevoke: true`, so the deep-equal cannot pass on the wrong source | same |
| 判据 I (两向), **reverse direction** — 经公开 `createApproval` ⇒ 谓词假 (Part D / round 5 fix, gate P1-B row 3) | `approval-cancel-round-creation.db.test.ts` | assertion inside the same `writes the dedicated instance, ...` case (`isCancelRoundInstance(originalInstanceRow.rows[0]!)).toBe(false)`) | same |
| I3 (`uq_approval_rounds_pending_document`) | `approval-cancel-round-creation.db.test.ts` | `§5 I3 — a second cancel round cannot be started while one is pending (uq_approval_rounds_pending_document)` | same |
| §4 / §5 I3 / 判据 III 负控 — **the index itself**, bypassing the app-layer precheck (Part D / round 5 fix, gate P1-B row 4) | `approval-cancel-round-creation.db.test.ts` | `§4 / §5 I3 / §14.2 判据 III 负控 — the partial unique index itself is load-bearing, independent of the app-layer precheck (bypass createCancelRoundInstance and INSERT a second pending round directly ⇒ 23505)` | same |
| §6 仅原 requester (WI-16) | `approval-cancel-round-creation.db.test.ts` | `WI-16 — only the original requester may start a cancel round (403 CANCEL_ROUND_REQUESTER_ONLY)` | same |
| Outlet #14 (suite gate) | `approval-cancel-round-creation.db.test.ts` | `§14.3 #14 (WI-6) — suite="forbidden" is rejected before any write (CancelRoundSuiteForbiddenError 409)` | same |
| Outlet #2 (`adminJump`) | `approval-cancel-round-outlet-guards.db.test.ts` | `#2 adminJump — a cancel-round instance is rejected 409 CANCEL_ROUND_OUTLET_FORBIDDEN; a genuine downstream jump on an ordinary instance still succeeds` | same |
| Outlets #4/#6 (action gate) | `approval-cancel-round-outlet-guards.db.test.ts` | `#4/#6 dispatchAction action gate — a cancel-round instance rejects 'handle' and 'return' 409 CANCEL_ROUND_OUTLET_FORBIDDEN; 'comment' (an allowed action) still succeeds` | same |
| §14.2 允许集 — COMPLEMENT half, member-level (round-4 gate P2-1 closure; round-5 gate P3-3 adds this row) | `approval-cancel-round-outlet-guards.db.test.ts` | `§9-9 allow-set MEMBER pin — every ApprovalActionType NOT in the ratified allow-set {approve,reject,revoke,comment} is rejected 409 CANCEL_ROUND_OUTLET_FORBIDDEN, enumerated mechanically over the exported union (not hand-listed)` | same |
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
| §14.1 seed evidence — node `approvalMode` explicit value `'all'` (会签), not `normalizeApprovalMode`'s undefined-fallback (Part G / round-2-gate fix, gate P2-1) | `approval-cancel-round-redemption.db.test.ts` | assertion inside the same `§14.1 seed evidence: reject without a comment ...` case, reading the same already-fetched published-definition row (`expect(cancelApprovalNode?.config?.approvalMode).toBe('all')`) | same |
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
- **§14.2 allow-set member-level pin — open before this pass, the COMPLEMENT half CLOSED by it
  (round 4 / Part J); the MEMBERSHIP half's `approve` slot separately identified as still
  undiscriminated, deferred to C-2 (P3 hygiene round, 2026-09-19, gate round-5 P3-1 — see Part K)**:
  this bullet did not exist in §A9 before gate round 4; the gate's own P2-1 finding (reason 3) was
  precisely that this gap had NO entry here, so a reader of this "honest open list" would have
  concluded there was no gap. Before this fix, the ratified §9-9 allow-set
  {approve,reject,revoke,comment} had ZERO discriminative power at the MEMBER level — the 47/47
  acceptance suite only ever dispatched `'handle'`/`'return'`, so widening
  `CANCEL_ROUND_ALLOWED_ACTIONS` to also permit `'transfer'` (a verb the ratify header names
  explicitly as forbidden, and which lock §9-11/C-3 couples to closing the revoke window) left the
  entire suite green (`impl-gate-C-slice1-round4-20260918.md` P2-1, mutation R4-M5). Fixed by a new
  mechanical-enumeration test in `approval-cancel-round-outlet-guards.db.test.ts` ("§9-9 allow-set
  MEMBER pin") that iterates the real exported `APPROVAL_ACTION_TYPES` union — not a hand-listed
  literal of the three ratify-named verbs, which would drift on the next verb added to that union —
  and asserts every member outside a locally-declared copy of the ratified allow-set is rejected 409
  `CANCEL_ROUND_OUTLET_FORBIDDEN`. Reran the same widening mutation post-fix, individually for all
  three ratify-named verbs (`'transfer'`, `'add_sign'`, `'reduce_sign'`, each its own `cp`-backed
  mutation): each time the new test goes red specifically at that verb (400 `VALIDATION_ERROR` where
  409 `CANCEL_ROUND_OUTLET_FORBIDDEN` was expected), the other 6 tests in the file stay green, and the
  file's total
  goes from 6→7 tests / the suite total from 47→48. **Checklist item closed for the COMPLEMENT
  half** — the five verbs the allow-set must reject (`transfer`/`add_sign`/`reduce_sign`/`return`/
  `handle`). See Part J.
  **Narrowing (P3 hygiene round, 2026-09-19, gate round-5 P3-1)**: the MEMBERSHIP half is a
  per-member 2×2, not a single bit this fix flips closed. Gate round-5 measured all four allow-set
  members individually (R5-M7…M10): removing `comment`/`revoke`/`reject` each turns the suite red
  (load-bearing), but removing `approve` leaves all 48 tests green — because the `approve` outlet is
  judgment II's own dispatch path, which this C-1 slice does not implement (design MD §1.1, Decision
  3, deferred to C-2). So `approve`'s presence in `CANCEL_ROUND_ALLOWED_ACTIONS` is, from this
  slice's own acceptance suite's point of view, an unverified member, not a pinned one. This gap
  predates this pass — gate round 5 is the first to name it — and its closure is deferred to C-2's
  own acceptance table (a "approve outlet, member-level pin" row, alongside judgment II itself), not
  to this slice. See Part K.
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
the two backend unit tests, `packages/core-backend`'s typecheck, and ~~the 38 sibling `*-ci-wiring`
guards~~ **the 45 sibling `*-ci-wiring` guards — SUPERSEDED, round-3 gate finding P2-2 / Part H2:
"38" was wrong the moment it was written here, not a later drift; the true population, mechanically
enumerated (`find . -path ./node_modules -prune -o -name "*ci-wiring*" -print | grep -v node_modules
| wc -l` → 45), is 45** — none of the files this pass's commit touched are backend/DB or CI-config
code, so none of those suites exercise anything this pass changed. Verified with a *scoped* diff
against the code directories those suites cover, not the raw file count (the raw diff includes this
document itself, which is not code):
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

---

# Part E — round 6 fix (2026-09-18, this pass)

**Scope of this pass**: close the gate review's **P3-C** finding (`impl-gate-C-slice1-round1-20260918.md`,
dated 2026-09-18) — the two lock-named mutations that had never been run — and its **P3-D** finding —
`policy_snapshot_at_create`'s `definitionPolicy` half had zero assertion anywhere in the corpus (only
`roundPolicy` was checked). HEAD before this pass's commit: `3a70b7639` (the head left by Part D's own
D2 self-correction). This pass does **not** touch P2-B (seed-visibility disclosure, code fix is
owner-gated per the review's own §6/§9 framing), P3-A (挂点位置措辞, docs + owner备案), P3-B (two `wip`
commits — dropping them from an already-pushed branch needs a rebase/force-push this lane's hard rules
forbid; its only legal form here is a PR-body merge-method note, deferred to the PR-open step), or
P3-E (the review itself registers this as "not a deduction," so there is nothing to fix). Those four
remain open for a subsequent step.

Unlike Part D, neither finding here named a missing acceptance ROW (an assertion that should exist but
doesn't) — P3-C named two assertions that already exist but had never been run against a mutation to
show they discriminate, and P3-D named a real gap (zero assertion) closed by one new deep-equal line
plus its own mutation. All three probes were run against the SAME private DB the rest of this document
uses, `metasheet2_lock_c` — not a fresh/virgin database — since none of them touches DDL or seed
content, only application code and one already-migrated row's JSON payload.

## E1. P3-C, item 1 — §14.1 mutation: seed `allowRevoke` governs the revoke gate at `ApprovalProductService.ts:10554`

Lock text (§14.1, verbatim, quoted by the gate review): "mutation: seed `allowRevoke=false` ⇒ 红"
(the seed's `allowRevoke` is 判据 III's revoke-half front door; before this pass only the POSITIVE
200-succeeds evidence existed — `redemption.db.test.ts`'s chain test and 正控 2's own positive-control
step — and the gate review named this as "没有把这道门打掉看红").

Read the enforcement site first, to confirm this key has no fallback layer (unlike D2's
`commentRequired`, which DOES fall back to the instance snapshot and was confounded because of it):
`ApprovalProductService.ts:10554` reads `if (!runtimeGraph.policy.allowRevoke)` directly off
`runtimeGraph`, itself `asRuntimeGraph(runtime.runtime_graph)` from a **fresh**
`SELECT * FROM approval_published_definitions WHERE id = instance.published_definition_id` issued
inside the same request (line ~9933) — no snapshot fallback exists for this key anywhere in the
resolver chain. So a DB-row mutation on the published definition's `runtime_graph.policy.allowRevoke`
is a clean, unconfounded probe of this exact chokepoint, not a repeat of D2's confound.

Probe (DB-row mutation, `psql`-backup → `jsonb_set` → rerun → restore → `diff`, the same discipline
Part D's D2 self-correction used and for the identical reason — the seed is materialized into this row
at migration time, not re-read from `approval-cancel-round-published-definition.ts` per test run):

```
$ psql -d metasheet2_lock_c -tAc "select runtime_graph::text from approval_published_definitions
    where id='00000000-0000-4000-8000-000000000003'" > /tmp/gate-c-slice1-backups/pd-cancel-round-runtime-graph.pre-allowrevoke.json
$ psql -d metasheet2_lock_c -c "UPDATE approval_published_definitions
    SET runtime_graph = jsonb_set(runtime_graph, '{policy,allowRevoke}', 'false')
    WHERE id='00000000-0000-4000-8000-000000000003'"
$ npx vitest --config vitest.integration.config.ts run tests/integration/approval-cancel-round-redemption.db.test.ts --reporter=dot
 Test Files  1 failed (1)
      Tests  4 failed | 2 passed (6)
```

Four tests turned red, all at their revoke step:
- `chain (§5 I6, 撤销不限次)`: `expected 409 to be 200` — round-1 revoke, the test's own positive
  evidence for `allowRevoke=true`, is exactly what breaks.
- `判据 III 正控 2 (...)`: `expected 409 to be 403` — **this is a finding, not just a confirmation**:
  the allowRevoke gate at `:10554` runs BEFORE the requester-identity check at `:10556`, so with
  `allowRevoke=false` the impostor's revoke attempt gets `409 APPROVAL_REVOKE_DISABLED` instead of the
  `403 APPROVAL_REVOKE_FORBIDDEN` this test (added in Part D, D1) asserts — meaning 正控 2's own 403
  assertion is itself downstream of, and depends on, `allowRevoke` being `true`. Worth a one-line note
  in the test's own comment for a future reader, but not a defect: the ORDER (allowRevoke gate first,
  identity check second) is the shipped chokepoint order, and 正控 2 only ever runs it with the seed's
  real (`true`) value, so its own assertion is unaffected in normal operation.
- `DISCRIMINATING CONTROL: ... keyed on engine_instance_id ...`: `expected 409 to be 200` — its own
  revoke-succeeds half breaks the same way as the chain test's round 1.
- `erratum (... a broken one-round-per-instance invariant ...)`: `expected 'APPROVAL_REVOKE_DISABLED'
  to be 'CANCEL_ROUND_INVARIANT_VIOLATION'` — the allowRevoke gate fires before this test's own
  invariant-violation branch is ever reached.

Restore:
```
$ psql -d metasheet2_lock_c -c "UPDATE approval_published_definitions
    SET runtime_graph = '<pre-mutation JSON text>'::jsonb
    WHERE id='00000000-0000-4000-8000-000000000003'"
$ diff pd-cancel-round-runtime-graph.pre-allowrevoke.json pd-cancel-round-runtime-graph.post-restore.json
(empty)
$ npx vitest --config vitest.integration.config.ts run tests/integration/approval-cancel-round-redemption.db.test.ts --reporter=dot
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

No new permanent assertion was needed: unlike D2's `commentRequired`, there is no explicit-vs-default
distinction possible for `allowRevoke` (absent and `false` are handled identically — fail-closed — by
the single direct read at `:10554`), so the existing positive assertions ARE the full acceptance
surface for this key; this probe only had to demonstrate they discriminate, which it now has, four
times over.

## E2. P3-C, item 2 — §14.1 负控 I′: rewriting the dedicated path's `workflow_key` literal to the public path's ⇒ Judgment I positive assertions turn red

Lock text (§14.1, verbatim, quoted by the gate review): "负控 I′:专用路径改写 `'approval-product-template'`
⇒ 正向红". This is the mirror of Part D's D3/D4 (which mutated the PUBLIC path's literal to the
DEDICATED value and watched the REVERSE-direction assertion turn red); I′ mutates the DEDICATED path's
own literal to the PUBLIC value and watches the FORWARD-direction assertions turn red.

Source mutation (`cp`-backup → edit → run → restore → `cmp`):
```
$ cp packages/core-backend/src/services/ApprovalProductService.ts /tmp/gate-c-slice1-backups/ApprovalProductService.ts.p3c2.bak
```
`ApprovalProductService.ts:8455`, inside `createCancelRoundInstance`'s own INSERT parameter list —
changed the `workflow_key` binding from the shared constant to the public path's own hardcoded
literal:
```diff
-          APPROVAL_CANCEL_ROUND_WORKFLOW_KEY,
+          'approval-product-template',
```
(Mutating the shared `APPROVAL_CANCEL_ROUND_WORKFLOW_KEY` constant itself, rather than this one call
site's use of it, would have been the wrong probe — both `isCancelRoundInstance`'s predicate and this
writer read the SAME symbol, so they would move together and nothing would turn red. The lock's own
"改写" wording is about the WRITER's literal specifically, matching the mirror shape of D3/D4's public-
path probe.)

```
$ npx vitest --config vitest.integration.config.ts run tests/integration/approval-cancel-round-creation.db.test.ts --reporter=dot -t "writes the dedicated instance"
 Test Files  1 failed (1)
      Tests  1 failed | 5 skipped (6)
AssertionError: expected 'approval-product-template' to be 'approval.cancel-round'
  at creation.db.test.ts:236 — expect(instance!.workflow_key).toBe(APPROVAL_CANCEL_ROUND_WORKFLOW_KEY)
```
red at exactly the Judgment I positive assertion (line 236); the very next line
(`isCancelRoundInstance(instance!)).toBe(true)`) would have failed identically had the first assertion
not already stopped the test.

**Cleanup note (not a defect in the probe, a consequence of a live test failing mid-fixture)**: this
mutation causes the test to abort BEFORE its own `createdRoundIds.add(...)` call runs, so the
`approval_rounds` row the mutated write still created was left un-tracked for the test's `afterAll`
cleanup, which then hit `23503` (the round's `document_id` FK) trying to delete the now-untracked
original document instance. Identified and deleted the two orphaned rows by id
(`approval_rounds` id `apr_5bf3bb58-...`, `approval_instances` ids `e8529d86-...` /
`bf42e5f0-...`) directly via `psql` before restoring the source file, confirmed zero remaining rows
referencing either id, then restored:
```
$ cp /tmp/gate-c-slice1-backups/ApprovalProductService.ts.p3c2.bak packages/core-backend/src/services/ApprovalProductService.ts
$ cmp /tmp/gate-c-slice1-backups/ApprovalProductService.ts.p3c2.bak packages/core-backend/src/services/ApprovalProductService.ts
(identical)
$ npx vitest --config vitest.integration.config.ts run tests/integration/approval-cancel-round-creation.db.test.ts --reporter=dot
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

## E3. P3-D — `policy_snapshot_at_create.definitionPolicy` had zero assertion; now deep-equal against the original document's own frozen `policy_snapshot` (with a first draft caught and fixed as confounded, before this pass returned)

Lock text (§4, v5.4, verbatim): `policy_snapshot_at_create` = `{ definitionPolicy: <原样>,
roundPolicy: { windowDays, suite } }`. The gate review found `creation.db.test.ts:262-268` asserted
the `roundPolicy` half (key set, `suite`, `windowDays`) but made **zero** assertion — "连「键存在」都
没有" — about `definitionPolicy`.

Per the advisor's caution before writing this: a `toBeDefined()` or key-existence check would be a
narrow predicate passing by construction (any non-null value satisfies it). The first draft instead
read the ORIGINAL document's own `policy_snapshot` column directly, BEFORE `createCancelRoundInstance`
runs, and deep-equaled it against `policy_snapshot_at_create.definitionPolicy` AFTER:
```ts
expect(roundRows.rows[0].policy_snapshot_at_create.definitionPolicy).toEqual(
  originalInstanceRow.rows[0]!.policy_snapshot,
)
```
This assertion's `{}`-mutation probe (`cp`-backup → edit → run → restore → `cmp`) on the exact
assignment the lock names (`ApprovalProductService.ts:8505`) reds correctly:
```diff
-            definitionPolicy: original.policy_snapshot,
+            definitionPolicy: {},
```
```
AssertionError: expected {} to deeply equal { allowRevoke: true, sourceOfTruth: 'platform', …(0) }
```

**Self-correction, same pass, caught by advisor review before this step returned** (same class of
defect as Part D's D2): the `{}`-mutation reds ANY wrong value, so it does not by itself prove the
assertion discriminates the lock's actual requirement, which is that `definitionPolicy` freezes the
**ORIGINAL document's** own policy — "distinct from the cancel round's OWN `policy_snapshot`
(`allowRevoke`)... which governs the ROUND's redemption mechanics, not the original document's
cancellability" (`ApprovalProductService.ts:8489-8492`, the code's own comment). Under the fixture as
first written, `publishOneNodeTemplate` always published the original with `policy: { allowRevoke:
true }`, and the cancel round's own seeded runtime policy (`buildCancelRoundRuntimeGraph`) is ALSO
`allowRevoke: true` — so `original.policy_snapshot` and `{ allowRevoke: runtimeGraph.policy.allowRevoke,
sourceOfTruth: 'platform' }` (the round's OWN policy snapshot, written a few lines above at
`ApprovalProductService.ts:8459` for the instance's own `policy_snapshot` column) are byte-identical
values. A swap-mutation probe confirms the confound directly (`cp`-backup → edit → run → restore →
`cmp`):
```diff
-            definitionPolicy: original.policy_snapshot,
+            definitionPolicy: { allowRevoke: runtimeGraph.policy.allowRevoke, sourceOfTruth: 'platform' },
```
```
$ npx vitest --config vitest.integration.config.ts run tests/integration/approval-cancel-round-creation.db.test.ts --reporter=dot -t "writes the dedicated instance"
 Test Files  1 passed (1)
      Tests  1 passed | 5 skipped (6)
```
**Stayed green** — the first-draft assertion cannot tell "froze the original's `policy_snapshot`" from
"froze the round's own", exactly the D2-shaped gap.

**Fix, same commit**: `publishOneNodeTemplate` (the test's own template-publish helper) gained an
optional `allowRevoke` parameter, defaulting to `true` for every pre-existing caller (`pending`,
`index`, `authz`, `suite` — all four unaffected), so the value stays exactly what those four tests
already exercise. Only the ONE caller in `writes the dedicated instance, ...` now passes `false`
explicitly, making the original document's own policy (`{ allowRevoke: false, sourceOfTruth:
'platform' }`) deliberately DIFFERENT from the cancel round's own seeded policy (`{ allowRevoke: true,
... }`), so the deep-equal can only pass if the source actually reads `original.policy_snapshot` and
not some other value that happens to coincide with it. Confirmed the other five assertions in the same
test (workflow_key, seat, round row shape, `roundPolicy`) are unaffected by publishing with
`allowRevoke: false` — none of them reads the original document's own `allowRevoke`, only the round's
own (already asserted correctly) and `roundPolicy`'s `suite`/`windowDays`.

Re-ran BOTH mutation probes against the corrected fixture, in isolation each (`cp`-backup → edit → run
→ restore → `cmp`):
```
$ cp packages/core-backend/src/services/ApprovalProductService.ts /tmp/gate-c-slice1-backups/ApprovalProductService.ts.p3d-v2.bak
```
1. `definitionPolicy: {}` — still **red**, now against the diverged expected value:
   ```
   AssertionError: expected {} to deeply equal { allowRevoke: false, sourceOfTruth: 'platform' }
   ```
2. The swap mutation (`definitionPolicy: { allowRevoke: runtimeGraph.policy.allowRevoke, ... }`) —
   now **red**, where it was green before the fixture fix:
   ```
   AssertionError: expected { allowRevoke: true, sourceOfTruth: 'platform' } to deeply equal
     { allowRevoke: false, sourceOfTruth: 'platform' }
   ```
Both mutations happen LATER in the test's control flow than E2's (after `createdRoundIds.add(...)`
already ran), so no orphaned-row cleanup was needed for either; confirmed zero stray rows anyway
before each restore. Restored and confirmed byte-identical after both probes:
```
$ cp /tmp/gate-c-slice1-backups/ApprovalProductService.ts.p3d-v2.bak packages/core-backend/src/services/ApprovalProductService.ts
$ cmp /tmp/gate-c-slice1-backups/ApprovalProductService.ts.p3d-v2.bak packages/core-backend/src/services/ApprovalProductService.ts
(identical)
```
Full six-test file green again after restore (see §E4).

**§A6 updated**: one new row appended (immediately after the existing 判据 I / roundPolicy row cluster,
cross-referenced to this Part E) — the mapping table carried no row at all for
`policy_snapshot_at_create.definitionPolicy` before this pass (it was never listed, the same shape of
omission Part D's D8 recorded for its own four rows, not a removal of an existing row).

## E4. Full-suite rerun, typecheck, and working-tree discipline, this pass

Full seven-file real-DB rerun after every probe (E1, E2, and BOTH of E3's — the first-draft `{}`
mutation and the swap-mutation that caught the confound) was restored:
```
$ DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-{lock-order-census,creation,redemption,seat-guards,attendance-fk-migration,outlet-guards,node-timeout-effect}.db.test.ts --reporter=dot
 Test Files  7 passed (7)
      Tests  47 passed (47)
```
(47, not 48 — E3's new assertion was added INSIDE an existing `it`, not as a new case, so the total
test count is unchanged from Part D's own 47/47.)

```
$ cd packages/core-backend && npx tsc --noEmit -p .
(no output, exit 0)
```

- `git status --porcelain` was empty at the start of this pass (matching HEAD `3a70b7639`'s clean
  state); the only paths staged before commit are `approval-cancel-round-creation.db.test.ts` (E3's
  new assertion plus the `publishOneNodeTemplate` fixture fix), `approval-cancel-round-redemption.db.test.ts`
  (E1's promised code comment on 正控 2), and this document; `git status --porcelain` is empty again
  after the commit.
- Three `cp`-backup → edit → run → restore → `cmp` cycles on `ApprovalProductService.ts` source (E2;
  E3's `{}` mutation; E3's swap mutation, run twice — once against the confounded fixture where it
  stayed green, once against the fixed fixture where it correctly reds) and one `psql`-backup →
  `jsonb_set` → run → restore → `diff` cycle on the `approval_published_definitions.runtime_graph` DB
  row (E1) — DB-row mutation for the same reason Part D's D2 used one (the seed is materialized at
  migration time, not re-read per test run). Zero `git checkout --` anywhere. E2's mutation left two
  orphaned rows as a side effect of the test aborting mid-fixture (not of the restore discipline) —
  identified, deleted by id, and confirmed zero remaining references before the source restore; see
  §E2's cleanup note. Confirmed zero stray rows after each of E3's mutations too (both land later in
  the test's control flow than E2's, past the point where the round row is registered for cleanup).
- No lock file, no `reviews/` file, no `origin/main` state, no CI-config file, no migration file, no
  `plugin-tests.yml` touched — nothing in this pass added a new `.db.test.ts` file or changed the
  real-DB two-point wiring, so no s6a recompute is required.

## E5. Gate findings P3-C and P3-D — final disposition

**Gate finding P3-C: CLOSED.** Both named mutations now run and are documented (§E1, §E2); neither
required a new permanent assertion beyond what already existed in the corpus — the gap was that their
discriminating power had never been demonstrated, and it now has been, with one incidental finding
recorded both here and as a code comment on the test it concerns (§E1: 正控 2's 403 is itself
downstream of `allowRevoke`, an ordering fact, not a defect).
**Gate finding P3-D: CLOSED** — `policy_snapshot_at_create.definitionPolicy` now has a deep-equal
acceptance assertion against the original document's own frozen `policy_snapshot`, confirmed
load-bearing by TWO source mutations, the second of which exists because the first draft's own
discriminating power was itself confounded and caught before this pass returned (§E3) — the same
class of self-correction Part D's D2 recorded, now repeated once more in this lane.
**Remaining open, unchanged by this pass**: P2-B (seed-visibility disclosure; its code half is
owner-gated per the review's own framing), P3-A (挂点位置措辞 correction + owner备案), P3-B (two `wip`
commits; legal closure form is a PR-body note, deferred to the PR-open step), P3-E (the review itself
registers this as not-a-deduction — no action item exists to close).

---

# Part F — round 7 fix (2026-09-18, this pass)

**Scope of this pass**: docs-only. Closes the wording half of the gate review's **P3-A** finding
(`impl-gate-C-slice1-round1-20260918.md`, dated 2026-09-18) and writes the disclosure half of its
**P2-B** finding into the design MD as the deployment note a future PR body must carry. HEAD before
this pass's commit: `8b8aa8a5e` (the head left by Part E's P3-D fix). Neither finding's *code* half
is touched here — P3-A's literal deviation from lock:344 is disclosed, not accepted or reordered
(the owner's interpretation call, not this document's); P2-B's `visibility_scope` narrowing is a
scope addition beyond lock §14.1 and stays owner-gated. This pass changes **only**
`approval-cancel-round-phase1-design-20260918.md`; no test file, no migration, no lock file, no
`plugin-tests.yml`, no `origin/main` state was touched, so there is nothing to add to the two-point
wiring, the s6a pin, or the sentinel census, and no new mutation to run — the design MD's own §5
already cites gate report mutation M2 for load-bearing evidence rather than re-deriving it.

## F1. Why this pass re-derived every line number instead of copying the gate report's

The gate report's P3-A/P2-B evidence is pinned to HEAD `95eccb89b`; six commits landed since
(`ee5905796` … `8b8aa8a5e`), all touching `ApprovalProductService.ts`. Per this design MD's own §0
provenance rule ("every citation here was re-read against the copy on disk at the time of writing"),
every line number this pass adds was re-read fresh against `8b8aa8a5e`, not carried over:

```
$ git rev-parse HEAD
8b8aa8a5ee9563a5344cd6b77bfebeaa78ece0ac
```

**判据 III sequence (P3-A), each boundary read individually, this pass:**
```
$ sed -n '10592p;10602p' .../ApprovalProductService.ts   # A4 status write bounds
$ sed -n '10603p;10613p' ...                              # A4 audit-row bounds
$ sed -n '10614p;10625p' ...                              # A4 completion-event build bounds
$ sed -n '10627p' ...                                     # A4 enqueue line
$ sed -n '10641p;10654p' ...                               # A4 round-write bounds
$ sed -n '10655p' ...                                      # A4 COMMIT line
$ sed -n '11079p;11088p;11090p;11104p;11105p;11116p;11118p;11128p;11141p;11142p' ...  # A7, same six checkpoints
```
Every line printed matched the design MD's new §5 table exactly (the opening/closing statement of
each of the six steps, both branches) — see the six-step table itself for the values, not repeated
here to avoid a second place they can drift out of sync.

**P2-B facts, re-verified against `8b8aa8a5e`, not assumed unchanged:**
```
$ git diff 95eccb89bc1ef37ce0a8eaee5a8d7e046e4da33d HEAD --stat -- \
    '*approval-cancel-round-published-definition*' \
    'packages/core-backend/src/db/migrations/'
(empty output)
```
Empty diff over both the specific seed-migration glob and the whole migrations directory between the
gate review's HEAD and this pass's own HEAD — the seed migration's column list and the unrelated
visibility-scope-default migration are byte-identical to what the gate review read. This pass cites
the gate review's psql evidence by provenance (`impl-gate-C-slice1-round1-20260918.md` §P2-B, HEAD
`95eccb89b`) rather than re-running `createdb`/`migrate` a third time for an unchanged fact, and
separately re-read the two source line citations that changed nothing (`applyTemplateVisibilityFilter`
and `listTemplates`'s own line spans are unchanged — same `grep -n` output as the gate report),
**catching and fixing one mis-citation of its own in the process**: the design MD's first draft of
this paragraph cited the `COALESCE(visibility_scope->>'type', 'all') = 'all'` unconditional-pass
condition at `:4483`; a fresh `sed -n '4469,4500p'` read shows `:4483` is a blank line and the
condition itself is at `:4485` (`conditions.push(` opens at `:4484`). Fixed before this pass's commit
— not left for a future round to catch, per this lane's own repeated self-correction discipline
(Parts C/D/E each record one of these).

## F2. Fresh full-suite rerun and typecheck, this pass (docs-only change, verified anyway)

No production or test file changed in this pass, so no regression was possible in principle — rerun
anyway, since "no code changed" is a claim this document makes about itself and the discipline this
lane has followed throughout is to verify claims, not assert them:
```
$ DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-{lock-order-census,creation,redemption,seat-guards,attendance-fk-migration,outlet-guards,node-timeout-effect}.db.test.ts --reporter=dot
 Test Files  7 passed (7)
      Tests  47 passed (47)
```
(47/47 — identical to Part E's own post-fix count; this pass added no new test case.)
```
$ cd packages/core-backend && npx tsc --noEmit -p .
(no output, exit 0)
```
`git status --porcelain` before this pass's edits: empty (matching HEAD `8b8aa8a5e`'s clean state,
per the harness's own pre-flight `git log`/`git status`). After this pass's edits and before commit,
the only path shown is `docs/development/approval-cancel-round-phase1-design-20260918.md` plus this
verification document itself — no `ApprovalProductService.ts`, no migration, no test file, no lock
file, no `plugin-tests.yml`. Zero `git checkout --`, zero `git reset --hard`, zero stash anywhere in
this pass (nothing was mutated that needed restoring — see F1's read-only `sed`/`grep` commands).

## F3. Authoritative per-finding disposition (all nine gate findings, one table, self-consistent)

Five earlier passes (Part C/D/E) each state their own scope-limited disposition correctly for the
pass they describe; none of those sentences is being rewritten or voided here (per
`feedback_supersession_marker_must_evaluate_not_void` — a scope marker retires a claim's *currency*,
not the sentence itself). This table is the single place that answers "what is true about finding
X **as of this document's own HEAD**, right now" — reading it should never require reconciling five
different "remains open" lists (§A9, and Parts C/D/E's own closing paragraphs) by hand.

| Finding | One-line description | Disposition (as of this pass) | Evidence |
|---|---|---|---|
| P1-A | FE sync-pin spec red, in a `main` required check, lane mis-recorded | **CLOSED** — regex fixed, dedicated assertion added, lane correction recorded | Part C, §C1/C3/C4/C6 |
| P2-A | Stale `api.ts` comment pre-justifying the P1-A red as "expected" | **CLOSED** — comment corrected | Part C, §C2/C6 |
| P1-B | Four lock-named acceptance rows absent (正控 2, `REJECT_COMMENT_REQUIRED`, 判据 I reverse, index-itself negative control) | **CLOSED** — all four added, fixtures reused | Part D, §D1-D4/D8 |
| P2-B | Seed leaves `visibility_scope` at its table default ⇒ template-center-visible, launchable "撤销审批" once applied | **DISCLOSED, OPEN, owner-gated** — deployment note now in design MD §9; `visibility_scope` narrowing is a scope addition beyond lock §14.1, decision left to owner; DDL is Draft-only, not applied anywhere today | This pass (§F1), design MD §9; original finding `impl-gate-C-slice1-round1-20260918.md` §P2-B |
| P3-A | Round-row write's actual hook point is after the status write, not before it, per lock:344's literal text | **Wording FIXED / deviation DISCLOSED, OPEN, owner 备案** — design MD §5 now states the true six-step sequence with current line numbers and names the literal deviation explicitly; no code reordered, no behavioral difference constructed by the gate reviewer or by this pass; whether to accept the deviation or reorder the write is an owner interpretation of lock:344 | This pass (§F1), design MD §5; original finding `impl-gate-C-slice1-round1-20260918.md` §P3-A |
| P3-B | Two `wip` commits still in branch history | **OPEN, blocked by two named hard rules, not by absence of an alternative** — dropping them from an already-pushed branch needs an interactive rebase, which needs a force-push (**this task's hard rules forbid force pushes, no exception clause**); the only other rule-compliant closure form is a PR-body merge-method note, which needs a Draft PR to exist (**this task's hard rules also forbid opening a PR**) — both routes are closed by rule, not by this lane failing to find one | Part E, §E5 (repeats Part D's D8 framing); not touched by this pass |
| P3-C | Two lock-named mutations (seed `allowRevoke=false`; 负控 I′ workflow-key rewrite) never run | **CLOSED** — both run and documented, one incidental ordering finding recorded | Part E, §E1/E2/E5 |
| P3-D | `policy_snapshot_at_create.definitionPolicy` had zero assertion | **CLOSED** — deep-equal assertion added, confirmed load-bearing by two mutations (first draft caught as confounded and fixed before the pass returned) | Part E, §E3/E5 |
| P3-E | This lane's own CI-wiring guard is a closed world over its own 7-file array | **Registered, no action item** — the gate review itself frames this as "not a deduction" (repo-wide convention shared by 45 sibling guards; cross-lane fix, not this slice's scope) | Gate report §3, P3-E; not touched by any pass |

**Net after this pass, 5+2+1+1 = 9 (grep the table above for the row count if this drifts)**: 5 of 9
findings CLOSED (P1-A, P2-A, P1-B, P3-C, P3-D), 2 disclosed-and-owner-gated with no code change made
(P2-B, P3-A), 1 blocked by this task's own hard rules (P3-B), 1 registered with no action item
(P3-E).

## F4. Relationship to §A9 and Parts C/D/E's own "remains open" paragraphs

§A9 (Part A, this document's earliest section) and the closing paragraphs of Parts C, D, and E each
say something true about "what remains open" **as of the pass they describe** — none of those five
statements is rewritten here. What changes is only which findings F3's own table now marks non-open:
§A9 predates the gate review, so most of its bullets are this lane's *own* pre-gate open items,
outside the gate's nine-finding set (判据 II/IV, outlet #9's negative control, the missing HTTP
route, the two supplementary-checklist PR-body items, the `suite` production mapping, Q-A/Q-B/Q-C's
ratify status, and the local-vs-CI PG-version gap — none of these is one of F3's nine rows). §A9's
**one** exception is its first bullet, the P1-A red — it names the gate review by ID and is already
updated in place by Part C (`~~BLOCKING~~ **RESOLVED (round 4 / Part C)**`), agreeing with F3's own
P1-A row; that bullet needed no further correction here, not because it predates the gate review
(it does not) but because Part C already reconciled it. Parts C/D/E's closing
paragraphs are each correct for their own pass and remain so; a reader who wants the **current**
status of any of the gate review's nine findings should read F3, not reconstruct it by walking
Parts C through F in order and mentally diffing five "remains open, unchanged by this pass" sentences
against each other.

## F5. Working-tree, commit, and branch discipline, this pass

- All work happened in the assigned worktree; no `git checkout --`, `git reset --hard`, or stash
  discard was used or needed (this pass is a pure-addition/pure-edit docs change, verified by F2's
  `git status --porcelain` reads, not by omission).
- No lock file (`approval-change-request-design-lock-draft-20260915.md`) was opened for editing.
- No PR was opened, no branch was merged or undrafted, no migration was applied to any database other
  than the pass's own read-only real-DB rerun against the already-migrated private `metasheet2_lock_c`
  (F2) — no `migrate.ts` invocation happened in this pass at all, since no new migration exists to run.
- This pass's own commit message and push follow the same conventions as Parts C/D/E.

---

# Part G — round 8 fix (2026-09-18, this pass)

**Scope of this pass**: a second independent gate review ran after Part F —
`impl-gate-C-slice1-round2-20260918.md` (審者 Opus, HEAD reviewed `7ef8e610e08b23181aece95ac4c82f4cde1f082f`,
verdict **DRAFT-READY**, 0 P1 / 1 P2 / 4 P3). This pass closes the one P2 finding (**P2-1**) and
records this document's disposition of the round's remaining findings; a separate commit in this
same pass closes the wording half of **P3-A** and disposes P3-B/P3-C/P3-D. HEAD before this pass's
first commit: `7ef8e610e` (the exact HEAD the round-2 review audited — nothing landed on the branch
between the review and this pass, confirmed by `git log -1` matching the review's own header).

## G1. P2-1 — §14.1 seed evidence: node `approvalMode` explicit value, the other half of the sentence Part D closed one half of

Lock §14.1 (v5.8, lock:335) states the node-config requirement as one sentence covering **two**
explicit values in the same breath: "节点 `approvalMode` 与席位数显式置值 … `approvalMode` 取会签
`'all'` … `normalizeApprovalMode` 对 undefined 回 `'single'` … seed 不靠默认." Part D's D2 closed the
sentence's `commentRequired` half (a sibling node-config key, same lock sentence family) with an
explicitness pin read from the seed's own materialized row. The `approvalMode` half was never given
the same treatment — the gate reviewer confirmed this by construction (mutation M9: deleting the key
from the seeded row left all 47 cases green), and by exhaustive grep (14 hits for `approvalMode` across
this lane's test files, all 14 inside locally-built fixture literals using `'single'`, none reading the
seed's own row).

**Fix, this pass**: `approval-cancel-round-redemption.db.test.ts`'s `§14.1 seed evidence: reject
without a comment ...` case already fetches the seeded `approval_published_definitions` row (that is
where D2's `commentRequired` pin lives) — this pass adds one more `expect` against the *same* fetched
row, not a new query and not a test-local fixture (the failure mode the gate's own note called out:
copying one of the 14 `'single'`-fixture hits would pin nothing):

```ts
expect(cancelApprovalNode?.config?.approvalMode).toBe('all')
```

Property path and value were re-derived at this pass's own HEAD, not copied from the gate report:

```
$ grep -n "approvalMode" packages/core-backend/src/db/seeds/approval-cancel-round-published-definition.ts
26:… `approvalMode: 'all'` (会签 — NOT the `normalizeApprovalMode` default …
83:          approvalMode: 'all',
$ psql metasheet2_lock_c -tAc "select runtime_graph->'nodes'->1->'config'->>'approvalMode' \
    from approval_published_definitions where id='00000000-0000-4000-8000-000000000003'"
all
```

**Full suite rerun, this pass, `metasheet2_lock_c` (already migrated, no `migrate.ts` invocation)**:

```
$ DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
      tests/integration/approval-cancel-round-{lock-order-census,creation,redemption,seat-guards,attendance-fk-migration,outlet-guards,node-timeout-effect}.db.test.ts
 Test Files  7 passed (7)
      Tests  47 passed (47)
```

Still 47, unchanged from Part D/E/F's count — this fix adds one assertion to an existing case, not a
new `it()` (the same accounting distinction P3-D's disposition below asks readers to keep straight).
Also reran the two unit tests (`Test Files 2 passed / Tests 15 passed`) and `tsc --noEmit -p .`
(`TSC-EXIT:0`).

**Mutation ledger (this pass) — G1-M1, the same M9 shape the gate reviewer used, so this row is
directly comparable to their finding**. Because the seed's `runtime_graph` is materialized into the
`approval_published_definitions` row at migration time (not re-evaluated per test run, same reason
D2's own mutation used a live-row probe rather than a source `cp`), the backup target is the row's
JSON text dumped to a file, not a source file:

```
$ psql metasheet2_lock_c -tAc "select runtime_graph::text from approval_published_definitions \
    where id='00000000-0000-4000-8000-000000000003'" > /tmp/gate-c-r2-fix-backups/runtime_graph.before.txt
$ psql metasheet2_lock_c -c "UPDATE approval_published_definitions \
    SET runtime_graph = runtime_graph #- '{nodes,1,config,approvalMode}' \
    WHERE id='00000000-0000-4000-8000-000000000003'"
$ DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run tests/integration/approval-cancel-round-redemption.db.test.ts
 1 failed | 5 passed
 × §14.1 seed evidence: reject without a comment ...
   → expected undefined to be 'all'
```

Red fires **only** at the newly added `approvalMode` assertion — no other assertion in the file turns
red — the same "red at exactly the added assertion, nothing else" shape Parts D/E's mutation ledgers
record. (Deliberately not citing a line number here: this document's own G3, two sections below,
closes a finding about a comment that went stale by citing a line number instead of a durable
description — repeating that shape in the same pass would be the wrong lesson to draw from it.)
Restored
from the backed-up JSON text and re-`SELECT`ed into a second file:

```
$ psql metasheet2_lock_c -c "UPDATE approval_published_definitions SET runtime_graph = \$\$<pasted JSON>\$\$::jsonb \
    WHERE id='00000000-0000-4000-8000-000000000003'"
$ diff /tmp/gate-c-r2-fix-backups/runtime_graph.before.txt /tmp/gate-c-r2-fix-backups/runtime_graph.after.txt
(empty)
```

Reran the full seven-suite set after restore: `Test Files 7 passed (7) / Tests 47 passed (47)`,
confirming the restore left no residue.

**§A6 mapping row added** for this assertion (see the table above, row immediately following the
`commentRequired` §14.1 seed-evidence row) — the gate's own critique of P2-1 was partly that it was
undisclosed, so the mapping table gets the row, not just this narrative section.

## G2. Disposition — the round-2 gate review's other four findings (P3-A/P3-B/P3-C/P3-D)

Detail for each finding is below (§G3-P3-A, §G4-P3-B, §G5-P3-C/P3-D); the authoritative one-table
summary is §G6. ~~All of this pass's changes — G1's test assertion, the two comment fixes, and the
design MD header narrowing — landed in a single commit; there is no second commit to point to.~~
**SUPERSEDED (round-3 gate finding P3-1, fixed in §I1): this sentence and §G7's "Two commits this
pass" a few paragraphs below flatly contradicted each other — one of them had to be wrong, and it was
this one.** The round-2 fix landed across two commits: `a166f5ca0` (G1's test assertion and mutation
ledger, both P3-A comment fixes, the design MD header narrowing, and this document's G1–G7 as first
drafted) and `6c5b06f7d` (three narrowing fixes to this Part's own prose, made after an advisor pass
and caught before push — see §G7 for what each one fixed). §G7's "two" was the correct count; this
sentence's "single commit" and "no second commit to point to" were written before `6c5b06f7d` landed
and never updated afterward.

---

## G3. P3-A (round-2, distinct from round-1's P3-A) — two production-comment `file:line` pointers wrong since the commit that introduced them

The gate review found two source-comment citations that never pointed at what they claimed, in
either this HEAD or the commit that introduced them (so not a drift — wrong from birth):

1. `ApprovalBridgeService.ts:1583`'s doc comment cited `ApprovalProductService.ts:9246` as the
   `AttendanceCentralApprovalError` absorption line; the real absorption check is at `APS:9637`
   (`if (error instanceof AttendanceCentralApprovalError) {`).
2. `apps/web/src/approvals/api.ts:1648`'s comment cited `APS:8561` as the `bulkReassignApprovals`
   `rejectIfCancelRound` guard call; the real call is at `APS:8916`. (`:8561` is the **lock's own
   baseline** line number for this guard, from before the lane's line numbers drifted — the comment
   had copied the lock's citation instead of reading the tree.)

**Re-derived fresh at this pass's own HEAD, not copied from the gate report**:

```
$ grep -n "instanceof AttendanceCentralApprovalError" packages/core-backend/src/services/ApprovalProductService.ts
9320:          if (error instanceof AttendanceCentralApprovalError) {
9637:        if (error instanceof AttendanceCentralApprovalError) {
$ grep -n "rejectIfCancelRound(instance, 'bulkReassignApprovals')" packages/core-backend/src/services/ApprovalProductService.ts
8916:          rejectIfCancelRound(instance, 'bulkReassignApprovals')
```

`:9637` (not `:9320`, the other `instanceof AttendanceCentralApprovalError` hit) is the correct
absorption line, verified against the comment's own words rather than against a name: the comment
says the failure mode is "silently absorbed into **`skipped_stale`**" — that is a specific outcome
literal, not a description of "some catch block somewhere". `:9320`'s catch (inside
`applyApprovalDepartureTransfer`, confirmed by `grep -n "async applyApprovalDepartureTransfer"` →
`:9217`, no closing brace/next method boundary between `:9217` and `:9320`) resolves to
`skipDepartureTransfer(instanceId, 'attendance-central-unsupported')` (`:9322`) — a **different**
named outcome. `:9637`'s catch (inside `applyNodeTimeoutEffect`, `:9568`) resolves to `return
'skipped_stale'` literally (`:9640`) — the exact string the comment names. Only one of the file's two
`instanceof AttendanceCentralApprovalError` hits produces the literal outcome the comment is warning
about, and it is the one this pass cites.

**Comment-text safety check before editing** (a comment-only change is not automatically inert — round
1's own P1-A was a sync-pin regex breaking on a comment block): grepped for any guard that parses
either file's source text.

```
$ grep -rn "readFileSync" apps/web/tests packages/core-backend/tests scripts/ops | grep -iE "api\.ts|ApprovalBridgeService"
(no output)
```

~~No hit — no sync-pin or source-text guard reads either file, so editing only the comment body is
safe.~~ **SUPERSEDED (round-3 gate finding P3-2, fixed in §I2): the grep's own shape is the problem,
not its result.** `grep -rn "readFileSync" … | grep -iE "api\.ts|ApprovalBridgeService"` can only ever
match a line where the literal token `readFileSync` and a filename co-occur — it is structurally
blind to a `read(...)` helper defined on one line and called with the filename on another, or to a
path built by joining a variable. Both shapes exist in this tree and both read one of the two files
this pass's comment edits touched; §I2 replaces this narrative with the actual guards found and rerun.

**Fix, this pass**: two one-line comment edits (no code, no behavior change):

- `ApprovalBridgeService.ts:1583`: `` `ApprovalProductService.ts:9246` `` → `` `ApprovalProductService.ts:9637` ``.
- `apps/web/src/approvals/api.ts:1648`: `` `APS:8561` `` → `` `APS:8916` ``.

**Design MD §0 header — narrowed, not re-asserted as a new universal claim**: the design MD's
provenance header claims "HEAD at time of writing `a32b2e015`" and "all citations re-derived against
this worktree's actual tree at HEAD". ~~The gate's P3-A (round 2) falsified the second clause for two
citations that were never in the design MD's own re-derivation pass (they are source-code comments,
not design-MD prose) — so the design MD's own claim about *its own* citations was not false~~ —
**SUPERSEDED (round-3 gate finding P2-1 / Part H1): that sentence is itself false and is retracted,
not narrowed.** Design MD §3.2 (design MD:206) independently repeats the same `ApprovalProductService.ts:9246`
citation as design-MD prose, not a source-code comment, and it was wrong for the identical reason the
two source comments were wrong (`:9246` is `applyApprovalDepartureTransfer`'s manager-resolution
catch, not `applyNodeTimeoutEffect`'s absorption branch at `:9637`). The round-2 gate's P3-A finding
therefore reached the design MD as well as the two comments; this document's defense of the design
MD's own citation was itself an error, fixed in Part H1, not a correct narrowing. Its staleness (the
"HEAD at time of writing" line lagging six commits, per Part F1's own observation) remained real
through this pass — **and is retired, not merely re-dated, by round-3's own fix pass**: Part H4 below
converts the header from a single pinned "HEAD as of" SHA (which goes stale on every subsequent pass,
this narrowing included) to a non-decaying "see the verification MD's own per-Part HEAD claims"
pointer, per the round-3 gate report's own §9 item 8 suggestion. This pass (round 2) updates the
design MD header's HEAD line to this pass's
own starting HEAD (`7ef8e610e`) and narrows the re-derivation clause to name what it actually covers:
prose citations inside the design MD, re-checked against the HEAD named in the same sentence — not a
claim that every source-code comment anywhere in the tree has been swept (that sweep is what the gate
review itself did, mechanically, over 121 citations across two documents; the design MD does not
duplicate that sweep and should not claim to).

**Rerun, this pass, `metasheet2_lock_c`**: full seven-suite set (`Test Files 7 passed (7) / Tests 47
passed (47)`, unchanged from G1's rerun — comment-only edits cannot move test counts) and `tsc
--noEmit -p .` (`TSC-EXIT:0`).

## G4. P3-B (round-2, same underlying finding as round-1's P3-B, now with a sourced answer)

The gate reviewer could not locate the two "hard rules" the earlier disposition (Part F5 / F3's own
P3-B row) cited as blocking closure of the two `wip` commits, and said so honestly — the goal file
and the lock's ratify header both *require* opening a Draft PR rather than forbidding it, and the
gate reviewer's own three readable authorization documents contain no force-push or no-PR
prohibition. **The reviewer was right that those three documents don't contain it — the source is a
fourth document the reviewer does not have: this implementation lane's own per-step task instruction**,
which states verbatim (this pass's own launch instructions): "不合并、不 undraft、不开 PR、不动
origin/main" and "提交…绝不…force". Those are this lane's *step-level* constraints, not the *slice's*
final-delivery contract — the goal file's Draft-PR requirement is a later step in the same lane
(opening the Draft PR is explicitly out of scope for the fix-round steps, in scope for the step that
follows fix-round closure), so the two are not in tension: the fix-round steps operate under a
narrower, temporary no-PR/no-force constraint than the slice's own eventual delivery form.

**Disposition: stays OPEN, but now *sourced*, not "cause unknown."** The two `wip` commits
(`8301a9178`, `f482f97e5`) remain in branch history; the two rule-compliant closure paths (interactive
rebase → needs force-push; PR-body merge-method note → needs a Draft PR to exist) both remain closed
under this lane's current step, for the reason now named above rather than left as "possibly a lane
instruction I cannot see." This finding **self-resolves at the lane's Draft-PR-opening step** (per
Part F3's original framing, still current) — no code or doc change in this pass closes it, because
none can under the constraint that produces it.

## G5. P3-C and P3-D (round-2) — corrections to the round-1 gate report and to this document's own accounting, no implementer action

- **P3-C**: round-2's own re-scan states the round-1 gate report's §1.6 "38 sibling `*-ci-wiring`
  guards, closed" undercounted the supplementary checklist's true population of 45 (missing 6
  `packages/core-backend/tests/unit/*-ci-wiring.test.ts` files and 1
  `plugins/plugin-integration-core/__tests__/sealed-export-s5-ci-wiring.test.cjs`, none matched by the
  round-1 glob). Round-2's own §1.7 already ran and closed all 45/45 (`476 + 17 + 1`, all green) —
  this is a correction to a **prior gate report's** wording, ~~not to this lane's implementation or to
  this verification document, which never claimed "38" anywhere (checked: `grep -n "38" docs/development/approval-cancel-round-phase1-verification-20260918.md` → no hit describing the
  sibling-guard count as 38)~~. **SUPERSEDED (round-3 gate finding P2-2 / Part H2): that parenthetical
  is itself false — this document's own Part C3 (line ~900, quoted verbatim above) does
  say "the 38 sibling `*-ci-wiring` guards", a hit the round-3 gate reviewer found by re-running the
  identical grep and getting a match. There *was* an action item: Part H2 corrects Part C3's "38" to
  "45" and records the correction here rather than repeating the false "no hit" claim.**
- **P3-D**: bookkeeping note that the "four lock-named acceptance rows" Part D closed materialized as
  3 new `it()` cases plus 2 assertions added to an existing case, not 4 new cases — flagged so a
  reader does not misread "four acceptance rows" as "four test functions." This pass's own G1 fix is
  the same shape (an assertion added to an existing case, not a new case) and states its own count
  explicitly above (still 47) for the same reason. **No action item beyond the wording precision
  already present in this document's own §A6/§A3 language** (which describes rows and cases
  separately rather than conflating them).

## G6. Authoritative disposition table — round-2 gate review's five findings

| Finding | One-line description | Disposition (as of this pass) | Evidence |
|---|---|---|---|
| P2-1 | `approvalMode` half of lock §14.1's node-config sentence had zero assertion | **CLOSED** — assertion added against the seed's own materialized row, mutation-confirmed (G1-M1) | This pass, §G1 |
| P3-A | Two production-comment `file:line` pointers wrong since introduction | ~~**CLOSED** — both comments corrected; design MD §0 header narrowed to a checkable claim~~ **SUPERSEDED (round-3 gate P2-1): that row understated the finding — the design MD had a THIRD, independent wrong citation of its own (design MD:206, `:9246` → `:9637`), not merely a "header" issue. Re-closed CLOSED in Part H1 with all three fix points listed.** | Round-2 fix, §G3; re-closed this pass, §H1 |
| P3-B | Two `wip` commits still in branch history | **OPEN, sourced** — this lane's own step instruction (no-PR, no-force) is the blocking rule the gate reviewer could not locate; self-resolves at the lane's Draft-PR-opening step | This pass, §G4; not touched by any code/doc change |
| P3-C | Round-1 gate report's own 38-vs-45 sibling-guard undercount | ~~**Registered, no implementer action** — a correction to a prior gate report's wording, already closed by the gate reviewer's own round-2 re-scan; this document never asserted 38~~ **SUPERSEDED (round-3 gate P2-2): the "never asserted 38" clause was itself false — Part C3 (line ~900) does say 38. Fixed to 45 in Part H2, this pass.** | Round-2 disposition, §G5; fixed this pass, §H2 |
| P3-D | "Four acceptance rows" materialized as 3 cases + 2 assertions, not 4 cases | **Registered, no implementer action** — wording-precision note; this pass's own G1 fix follows the same accounting discipline | This pass, §G5 |

**Net after this pass**: 2 of 5 findings CLOSED (P2-1, P3-A), 1 OPEN with its blocking rule now
sourced (P3-B, unchanged disposition, better-cited), 2 registered with no action item (P3-C, P3-D).
This mirrors Part F3's own table shape for round 1's nine findings — read this table for round 2's
current status rather than reconstructing it from §G1–§G5's narrative.

**SUPERSEDED for currency, not for validity (round-3 gate / Part H)**: this was an honest snapshot of
what round-2's own fix pass believed at the time — it is not retracted as a record of that belief.
Two of its premises turned out false (P3-A's "both comments corrected" undercounted a third citation
inside the design MD itself; P3-C's "no action item" rested on a grep the round-3 gate reviewer reran
and got a hit from). See §G6's table (now annotated) and Part H for the current, corrected status:
P3-A is CLOSED with three fix points, P3-C is fixed (one prose line), not merely "registered."

## G7. Working-tree, commit, and branch discipline, this pass

- All work happened in the assigned worktree (`wt-cancel-round`); no `git checkout --`,
  `git reset --hard`, or stash discard was used or needed.
- No lock file (`approval-change-request-design-lock-draft-20260915.md`) or `reviews/` document was
  opened for editing: `git diff --name-only origin/main..HEAD | grep -iE "review|lock-draft|\.claude"`
  → 0 hits, re-checked after this pass's commits.
- No PR was opened, no branch was merged or undrafted, no migration was applied anywhere (no new
  migration exists to run; `metasheet2_lock_c` was already migrated by an earlier pass) — the two DB
  mutation probes (G1-M1's `runtime_graph` edit) were row-level `UPDATE`s against the lane's own
  private DB, backed up and restored, not migrations.
- ~~Two commits this pass: one for G1 (P2-1's assertion + mutation ledger + this document's G1/§A6
  updates), one for G3–G6 (the two comment fixes, the design MD header narrowing, and this document's
  G2–G7).~~ **SUPERSEDED (round-3 gate finding P3-1, fixed in §I1): the count (two) was right; the
  split by content was wrong.** Both P3-A comment fixes and the design MD header narrowing landed in
  the **first** commit alongside G1, not the second. The true split: `a166f5ca0` (G1's P2-1 assertion
  and mutation ledger, both P3-A comment fixes, the design MD header narrowing, and this document's
  G1–G7 as first drafted) and `6c5b06f7d` (three narrowing fixes to this Part's own prose, caught by
  an advisor pass before push: G3's absorption-line claim backed by the mechanically distinguishing
  grep instead of a name-read, G1's mutation-ledger line-number reference replaced with a
  drift-immune description, and G2's dangling forward-reference to a nonexistent second commit
  replaced with a same-document pointer to G6). Both commits follow the same conventional-commit and
  push discipline as Parts C–F.

---

# Part H — round-3 gate fix (2026-09-18, this pass)

Fix-round response to `reviews/impl-gate-C-slice1-round3-20260918.md` (verdict NEEDS-FIX, 0 P1 / 2 P2
/ 5 P3, HEAD `6c5b06f7dc3de3a6b58e1abff09763c11e078d96`, base `origin/main` =
`89f1ecdee2c3b70205a318074824c834bc6a5c7e`, unmoved). This pass closes the round's two P2 findings
(both self-certification failures — a finding recorded CLOSED or "no action item" on the basis of a
sentence the round-3 gate reviewer showed to be false). It does not touch the five P3 findings; see
§H4 for their carried-forward disposition. **Docs-only pass: zero production or test code touched.**

## H1. P2-1 (round-3, CONFIRMED) — design MD:206's own `:9246` citation, independent of the two
source comments round-2 already fixed

**The finding, exactly as the round-3 gate stated it**: round-2's Part G3 recorded P3-A (round 2)
CLOSED on the strength of "both comments corrected" and a claim that the design MD's own citations
were never falsified because the two wrong pointers were "source-code comments, not design-MD prose."
That claim was false — the design MD has its own, independent citation of the identical wrong line
number, in its own prose, at §3.2 (design MD:206). Confirmed against this pass's own starting HEAD,
before this pass's fix (not the current, already-fixed file — a plain `grep` against the working tree
at the time of writing this sentence would already show the corrected `9637`):

```
$ git show 6c5b06f7d:docs/development/approval-cancel-round-phase1-design-20260918.md | grep -n "9246"
206:(`ApprovalProductService.ts:9246`, the `catch (error) { if (error instanceof
```

Re-derived fresh against this pass's own HEAD (not copied from either gate report):

```
$ grep -n "instanceof AttendanceCentralApprovalError" packages/core-backend/src/services/ApprovalProductService.ts
9320:          if (error instanceof AttendanceCentralApprovalError) {
9637:        if (error instanceof AttendanceCentralApprovalError) {
$ sed -n '9636,9641p' packages/core-backend/src/services/ApprovalProductService.ts
      } catch (error) {
        if (error instanceof AttendanceCentralApprovalError) {
          await consumeTimeout()
          await client.query('COMMIT')
          return 'skipped_stale'
        }
```

`:9246` is inside `applyApprovalDepartureTransfer`'s manager-resolution `catch` (a plain `catch {}`
with no `instanceof` check at all, resolving to a fail-closed no-manager outcome, `APS:9243-9250`) —
not the `applyNodeTimeoutEffect` absorption branch the design MD's sentence describes. The real
absorption branch is `:9637` (the `if`), whose body's `return 'skipped_stale'` lands at `:9640`. This
is the same wrong-line-number defect round-2's own P3-A found in the two source comments
(`ApprovalBridgeService.ts:1583`, `apps/web/src/approvals/api.ts:1648`, both already fixed in
`a166f5ca0`) — the design MD simply had a third, independent instance of it that round-2 missed
because it only swept the two comments the gate report named, not its own prose.

**Comment/prose-text safety check before editing** (same discipline as round-2's G3, rerun fresh, not
copied, and deliberately **not** scoped to a handful of test directories the way round-2's G3 was —
round-3's own P3-2 finding showed that a directory-scoped, `readFileSync`-co-occurrence grep is
structurally blind to `read('…')`-wrapped and variable-path guards; the fix is to widen the *scope*,
not just the *pattern*): does anything anywhere in the tree parse the design MD's own text as a
source-of-truth pin?

```
$ grep -rln "approval-cancel-round-phase1-design-20260918" . --exclude-dir=node_modules --exclude-dir=.git
docs/development/approval-cancel-round-phase1-verification-20260918.md
```

One hit, and it is this verification document itself — which cites the design MD's filename in prose
(exactly as this sentence does), not a test or script that opens the file to extract a behavioral
pin. Confirmed by a second, independent check for the shape P3-2 actually found (a directory walker
or `readFileSync`/`readdirSync` call built from a `docs/development` path fragment, which would not
name this file's basename at all):

```
$ grep -rln "readdirSync.*docs/development\|readFileSync.*docs/development\|join.*docs.*development" . --exclude-dir=node_modules --exclude-dir=.git
plugins/plugin-integration-core/__tests__/stock-preparation-handoff.test.cjs
docs/development/approval-cancel-round-phase1-verification-20260918.md
docs/development/platform-overall-design/stock-prep-onboarding-acceleration-20260901.md
scripts/ops/dingtalk-p4-final-closeout.mjs
scripts/ops/staging-attendance-manual-missed-punch-reminder-hmr5-smoke.test.mjs
scripts/ops/staging-attendance-makeup-punch-mp6-smoke.test.mjs
scripts/ops/staging-attendance-ae4-result-edit-smoke.test.mjs
scripts/ops/dingtalk-p4-final-closeout.test.mjs
scripts/ops/multitable-onprem-package-upgrade-inplace.test.mjs
scripts/ops/staging-attendance-overtime-bank-v18-smoke.test.mjs
scripts/ops/staging-attendance-report-digest-rd45-smoke.test.mjs
scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
```

12 hits. One is this verification document itself, matched because it quotes this very grep pattern
as prose (the command line immediately above) — the same self-matching trap §H1/§H2 already flag for
"9246" and "38"; not a code guard, discounted. The other 11 are all inspected below, not sampled:

| File | What it actually reads/writes | Names the design MD? |
|---|---|---|
| `stock-preparation-handoff.test.cjs:2472` | `path.join(..., 'docs', 'development', 'takeover-beiliao-20260821', '222-deploy-window-runbook-20260901.md')` | No — a differently-named runbook |
| `stock-prep-onboarding-acceleration-...md:66` | Markdown prose citing `docs/development/source-onboarding-self-service-design-20260830.md` §9; matched only because "join" (Chinese "join 计数") appears near an unrelated `docs/development/...` citation on the same line | No — not code at all |
| `dingtalk-p4-final-closeout.mjs:252` | `path.join(opts.docsOutputDir, ...)` — `docsOutputDir` is a CLI-provided **write** target for this script's own generated report, not a literal `docs/development` read | No |
| `staging-attendance-*-smoke.test.mjs` (hmr5, mp6, ae4, rd45, v18 — 5 files; rd45 reads two runbooks in one file, lines 33-34) | Each `readFileSync(join(here, '../../docs/development/<one specific, differently-named staging runbook>.md'))` | No — five files naming several different runbooks between them, none this design MD |
| `dingtalk-p4-final-closeout.test.mjs:188/208/262` | Writes/reads its own test-fixture file named `dingtalk-final-remote-smoke-development-<date>.md` inside a temp `docsDir` fixture, unrelated to the real `docs/development/` tree | No |
| `multitable-onprem-package-upgrade-inplace.test.mjs:44` | `path.join(repoRoot, 'docs/development/takeover-beiliao-20260821/222-deploy-window-runbook-20260901.md')` | No — same named runbook as the first row |
| `export-dingtalk-staging-evidence-packet.test.mjs:151` | `path.join(outputDir, 'docs/development/dingtalk-staging-execution-checklist-20260408.md')` — an output path this test writes an evidence copy to | No |

None of the 11 constructs a path toward `approval-cancel-round-phase1-design-20260918.md`, and none
walks `docs/development/` generically extracting citations from every file in it — each names one
specific, unrelated file (or, for `dingtalk-p4-final-closeout.mjs`, writes to a directory rather than
reading a named target from it). Editing the design MD's prose is behavior-inert.

**Fix, this pass**: one edit, `docs/development/approval-cancel-round-phase1-design-20260918.md:206`
— the design MD's *citation* changed from `ApprovalProductService.ts:9246` to
`ApprovalProductService.ts:9637`, and the bracketed description was rewritten to name the actual
branch (`if (error instanceof AttendanceCentralApprovalError) { … }` inside `applyNodeTimeoutEffect`,
whose `return 'skipped_stale'` lands at `:9640`) instead of the `catch (error) { if … }` paraphrase
that had conflated the two nearby lines. The edit also appended a trailing clause naming `:9246`'s
real identity (`applyApprovalDepartureTransfer`'s manager-resolution catch) so the historical error is
documented, not erased — which means a raw `grep -c "9246"` against the design MD still returns a
nonzero count after this fix, **by design**, the same way this Part's own prose and §G3/§G6's
retroactive annotations still name "9246" and "38" to describe what was wrong (a whole-document
occurrence count is the wrong instrument for either claim, exactly the shape of trap this document's
own §H1/§H2 are about). The checkable claim is narrower: the design MD's one *citation* line — the
`ApprovalProductService.ts:` reference immediately following "cites the exact absorption line" — now
names `9637`, not `9246`:

```
$ grep -n "cites the exact absorption line" -A1 docs/development/approval-cancel-round-phase1-design-20260918.md
205:(`ApprovalBridgeService.ts:1577-1584`) repeats the reasoning and cites the exact absorption line
206-(`ApprovalProductService.ts:9637`, the `if (error instanceof AttendanceCentralApprovalError) { … }`
```

**§G3 and §G6 corrected, not silently rewritten**: the false sentence in §G3 and the P3-A row in
§G6's table are struck through in place and annotated `SUPERSEDED (round-3 gate P2-1 / Part H1)`,
per this repo's own discipline that a supersession marker evaluates the specific sentence rather than
voiding the section around it. P3-A's disposition is re-affirmed **CLOSED**, now listing all three
fix points (the two source comments from round-2, plus this pass's design MD:206 edit) rather than
two.

**"A third, independent instance" — is it exactly three, not four or more?** A whole-tree sweep for
any other live citation of the wrong line number, run before asserting a specific count:

```
$ grep -rn "9246" . --exclude-dir=node_modules --exclude-dir=.git
```

Every hit is one of: (a) the two docs' own retraction/finding narrative (this Part, §G3, §G6 — all
past-tense, describing what was wrong, not asserting it as current), (b) one unrelated substring match
in a different document's `:29246` token (a five-digit line-number list in an unrelated attendance
design doc — `29246`, not `9246`), or (c) ~~design MD:209-210's~~ **design MD:216-217's** own
trailing clause (this pass's addition, also past-tense) — ~~209-210~~ **SUPERSEDED (gate round 4 /
`impl-gate-C-slice1-round4-20260918.md` P3-4): a LATER commit in this same pass (`74c6c2e96`) added
two lines to this section's header, pushing the trailing clause down from :209-210 to its current
:216-217; the citation here was written before that shift and never re-derived afterward. Re-checked
fresh: `grep -n "9246" docs/development/approval-cancel-round-phase1-design-20260918.md` → hits at
`:216` and `:217`, matching the wording quoted here. The count and classification below are
unaffected — only this one line-number pointer was stale.** Zero hits in any source file
(`packages/**`) or test file
(`**/*.test.*`, `**/*.spec.*`). The count is exactly three: the two comments round-2 fixed
(`a166f5ca0`) and this pass's design MD:206 fix — no fourth site exists.

**Header fix, this pass's second commit**: the design MD's own provenance header (the line the gate
report's §9 item 8 flagged as chronically stale, most recently one commit behind at round-3's own
HEAD) is rewritten from a single pinned "HEAD as of the round-8 fix pass … `7ef8e610e08b…`" SHA to a
pointer at the verification document's own per-Part HEAD claims, which do not go stale the way a
hardcoded SHA does. This closes round-3's P3-3 (see §H4) — landed in this pass's second commit
(alongside this section's own self-review corrections; see §H3), not the first commit that fixed
P2-1's design MD:206 citation, since the header rewrite was not part of the original round-3 fix and
was only added once the gate report's §9 item 8 suggestion was acted on during self-review.

**Rerun, this pass, `metasheet2_lock_c`** (docs-only change; rerun to confirm no incidental
regression, not because the edit could plausibly move a test):

```
$ DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-{lock-order-census,creation,redemption,seat-guards,attendance-fk-migration,outlet-guards,node-timeout-effect}.db.test.ts
 Test Files  7 passed (7)
      Tests  47 passed (47)
```

Unchanged from every prior pass's rerun of this same set (§G1, §G3). No mutation ledger for this
finding: the fix is a Markdown citation correction with a safety check (above) proving nothing parses
it as a behavioral pin, so there is no assertion for a mutation to falsify.

## H2. P2-2 (round-3, CONFIRMED) — Part C3's "38 sibling `*-ci-wiring` guards" line, and §G5's false
"never claimed 38" grep

**The finding, exactly as the round-3 gate stated it**: round-2's §G5 disposed of round-1's P3-C
("38 sibling guards, undercounted") by asserting this verification document "never claimed '38'
anywhere," citing a grep that supposedly produced no hit. The round-3 gate reran the identical grep
and got a hit:

```
$ grep -n "38" docs/development/approval-cancel-round-phase1-verification-20260918.md
900:the two backend unit tests, `packages/core-backend`'s typecheck, and the 38 sibling `*-ci-wiring`
```

Re-run fresh at this pass's own HEAD, same result before this pass's edit (confirming the round-3
gate's finding, not merely trusting the gate report's transcript):

```
$ git show 6c5b06f7d:docs/development/approval-cancel-round-phase1-verification-20260918.md | grep -n "38 sibling"
900:the two backend unit tests, `packages/core-backend`'s typecheck, and the 38 sibling `*-ci-wiring`
```

Part C3 (written during the round-1 fix pass, HEAD `95eccb89b`) does say "38," describing the
sibling-guard population as part of a "not rerun this pass, by scope" disclosure. §G5's "never
claimed 38 anywhere" was false, and the "No action item for this pass" conclusion that rested on it
does not hold — there was an action item: correcting the stale count.

**True population, mechanically enumerated, this pass** (same method as round-2's own §1.6/§1.7 and
round-3's §1.6, not re-typed from either report):

```
$ find . -path ./node_modules -prune -o -name "*ci-wiring*" -print | grep -v node_modules | wc -l
45
```

45, matching the supplementary checklist's own population count, quoted rather than assumed
(`reviews/impl-supplementary-gate-checklist-20260918.md:6`: "同族 `*-ci-wiring` 共 45 个") and
round-2/round-3's own closure of "45/45." **Was "38" simply stale drift, or wrong from the moment
Part C3 wrote it (HEAD `95eccb89b`)?** Checked, not assumed — the population was already 45 at that
exact HEAD, ~~before any of this lane's own `*-ci-wiring` files existed to inflate a later count~~
**SUPERSEDED (gate round 4 / `impl-gate-C-slice1-round4-20260918.md` P3-6): this parenthetical is
false — `95eccb89b`'s population of 45 already INCLUDES this lane's own new
`approval-cancel-round-ci-wiring.test.ts` (`git ls-tree -r 95eccb89b --name-only | grep -E
'ci-wiring' | grep -i cancel-round` → that one file, confirmed). The true pre-lane population, on
`origin/main`, is 44 (`git ls-tree -r origin/main --name-only | grep -cE '[^/]*ci-wiring[^/]*$'` →
`44`). The supported conclusion is unaffected — 44 ≠ 38, so "38" was still stale/wrong the moment
Part C3 wrote it, regardless of whether the comparison point is 44 or 45 — only the "before this
lane's own file existed" provenance claim about WHY the count is 45 was false; the file was already
counted in it.**:

```
$ git ls-tree -r 95eccb89b --name-only | grep -E '[^/]*ci-wiring[^/]*$' | wc -l
45
```

"38" was wrong the moment Part C3 wrote it — the round-1 gate report's own §1.6 explains why (its
glob missed 7 files that existed all along), not a later drift this lane introduced. (This pass does
not rerun all 45 — that was already done fresh in round-3's §1.6, one commit back, and nothing in
this pass's docs-only diff touches CI config or any `*-ci-wiring` test file, so there is nothing for
those suites to exercise differently. Scoped-diff check, same method as Part C3 used, pinned to this
pass's first commit rather than the moving `HEAD` symbol so the claim does not drift on a later
commit: `git diff 6c5b06f7d 74c6c2e96 --name-only -- packages plugins scripts .github` → empty,
~~re-checked against this pass's full commit range, not just its first commit.)~~ **SUPERSEDED
(gate round 4 / `impl-gate-C-slice1-round4-20260918.md` P3-3): this was NOT the full commit range —
two more commits (`dce9e16df`, `50fe83ebc`) landed after `74c6c2e96`, and this sentence's own claim
of "full commit range" was written before them and never updated. The re-derived full-range check,
pinned to this pass's actual last commit `50fe83ebc`, is
`git diff --name-only 6c5b06f7d 50fe83ebc -- packages plugins scripts .github apps` → `0` (rerun by
this fix pass); the substance — zero non-doc files touched across the whole pass — still holds, only
the "full range" claim about which commits were actually checked was false.)**

**Fix, this pass**: `docs/development/approval-cancel-round-phase1-verification-20260918.md:900` —
"the 38 sibling `*-ci-wiring` guards" → "the 45 sibling `*-ci-wiring` guards," struck through in place
(not silently overwritten) with a `SUPERSEDED (round-3 gate P2-2 / Part H2)` annotation naming the
correction and the grep that re-confirms it. §G5's P3-C bullet is corrected the same way: the false
"never claimed 38 anywhere" clause is struck and annotated, replaced with an honest statement that the
hit exists and was fixed this pass. §G6's P3-C table row is updated from "Registered, no implementer
action" to point at this fix.

A whole-document grep for "38 sibling" is **not** the right check here (it necessarily still matches
this Part's own retraction narrative and §G5's corrected bullet, both quoting the historical wrong
text in past tense to document the correction — the same instrument error §H1 flags for "9246"). The
scoped, correct check is line 900 itself:

```
$ sed -n '900p' docs/development/approval-cancel-round-phase1-verification-20260918.md
the two backend unit tests, `packages/core-backend`'s typecheck, and ~~the 38 sibling `*-ci-wiring`
guards~~ **the 45 sibling `*-ci-wiring` guards — SUPERSEDED, round-3 gate finding P2-2 / Part H2: …**
```

Line 900 no longer asserts "38" as the live population count; it is struck through and replaced with
"45," carrying the same `SUPERSEDED` marker used throughout this document.

## H3. Working-tree, commit, and branch discipline, this pass

- All work happened in the assigned worktree (`wt-cancel-round`) on the assigned branch
  (`feat/approval-cancel-round-phase1`); no `git checkout --`, `git reset --hard`, or stash discard
  was used or needed.
- No lock file or `reviews/` document was opened for editing this pass. Checked against this pass's
  own starting HEAD rather than `origin/main` (`origin/main` has not moved; the wider
  `origin/main..HEAD` diff is checked the same way in every earlier Part of this document), pinned to
  fixed commits rather than the moving `HEAD` symbol so the claim does not silently start covering a
  later, unrelated commit once this branch gets its next fix-round commit:
  `git diff --name-only 6c5b06f7d 74c6c2e96 | grep -iE "review|lock-draft|\.claude"` → 0 hits.
  ~~(scoped to `74c6c2e96`)~~ **SUPERSEDED (gate round 4 / `impl-gate-C-slice1-round4-20260918.md`
  P3-3, "same family" as the :2129 fix above): this check was also short two commits. Re-derived over
  the true full range: `git diff --name-only 6c5b06f7d 50fe83ebc | grep -iE "review|lock-draft|\.claude"`
  → 0 hits. The claim itself ("no lock file or `reviews/` document was opened for editing this
  pass") still holds; only the range the original check covered was incomplete.**
- No migration was applied anywhere in this pass (no new migration exists to run); the private DB
  (`metasheet2_lock_c`) was already migrated by an earlier pass and only read (test runs), never
  written outside those tests' own transactions.
- No PR opened, no branch merged or undrafted, no force-push.
- **This pass's commits are every commit on this branch after `6c5b06f7d`** (`git log --oneline
  6c5b06f7d..` lists them; each commit message states its own scope) — deliberately **not** a count
  pinned into this prose, the same lesson this pass already applied to the design MD's "HEAD as of"
  header (§H1's closing note): a self-count inside a document every one of its own commits edits
  cannot survive the next commit that edits it, and an earlier draft of this bullet said "two" when a
  third, self-review-of-the-self-review commit was already landing. In role terms: the first commit
  is the P2-1/P2-2 fixes and this Part H (H1-H4) as originally written; every commit after it is a
  self-review correction to a claim this Part itself made too loosely on an earlier writing (see each
  commit's own message for what it fixed). Every one of them is docs-only — verified before staging
  each commit via `git status --porcelain` / `git diff --stat` showing only the same two
  `docs/development/*.md` paths, and confirmed for the full range via
  `git diff --name-only 6c5b06f7d 74c6c2e96` ~~(currently the tip of this pass's commits): the same
  two files, zero others.~~ **SUPERSEDED (gate round 4 / `impl-gate-C-slice1-round4-20260918.md`
  P3-3): `74c6c2e96` stopped being the tip two commits before this sentence was ever read —
  `dce9e16df` and `50fe83ebc` landed after it (the irony: `dce9e16df`'s own stated purpose was
  fixing a self-count elsewhere in this very Part H, and it introduced this same defect on a
  sibling sentence — `feedback_generation_guard_must_be_applied_to_every_sibling_surface`).
  Re-derived over the true tip: `git diff --name-only 6c5b06f7d 50fe83ebc` → still exactly the same
  two `docs/development/*.md` paths, zero others. The substance holds; only the "currently the tip"
  self-reference was false.**
- Files touched, across this pass's commits: `docs/development/approval-cancel-round-phase1-design-20260918.md`
  (the §3.2/design MD:206 citation fix, the header rewrite, and the trailing historical clause) and
  `docs/development/approval-cancel-round-phase1-verification-20260918.md` (this Part H in full, the
  `SUPERSEDED` annotations to §G3/§G5/§G6, and the "Net after this pass" paragraph). Zero non-`.md`
  files across any of them. `git status --porcelain` is clean after each commit and push (no stray
  edits, no leftover mutation-probe state — none were run this pass; see §H1/§H2's own notes on why
  not).

## H4. What this pass does not close — carried forward, not silently dropped

The round-3 gate report's five P3 findings are **not** addressed by this pass; they are the scope of
a later fix-round step, not abandoned. (As written when this bullet list was first drafted — the
P3-3 bullet further down this same list is itself the fix for P3-3, and two more, P3-1/P3-2, are
fixed in a subsequent pass on this branch; see each bullet's own current text or `SUPERSEDED`
annotation for present state, not this introductory sentence.)

- ~~**P3-1** (Part G self-contradicts: §G2 says "single commit," §G7 says "Two commits this pass") —
  unresolved; needs both sentences reconciled against the true two-commit history
  (`a166f5ca0` + `6c5b06f7d`), per the gate's own §9 recipe. Not touched this pass.~~ **SUPERSEDED —
  fixed in a later pass on this branch, §I1**: this bullet was accurate when Part H was first
  written; it does not describe the document's current state. §I1 reconciles §G2 and §G7 against the
  true two-commit history and corrects the content split, not just the count.
- ~~**P3-2** (§G3's `readFileSync`-co-occurrence grep is structurally blind to `read('…')`-wrapped and
  variable-path guards, and two such guards exist in this tree reading the exact files G3 edited) —
  unresolved; §H1 above deliberately used a broader filename-based grep for its own safety check
  instead of repeating G3's narrower one, but does not yet go back and fix G3's own argument text.
  Not touched this pass.~~ **SUPERSEDED — fixed in a later pass on this branch, §I2**: §G3's own
  argument text is corrected there, naming the two guards and disclosing that one of them does not
  strip comments.
- **P3-3** (design MD header's "HEAD as of the round-8 fix pass … `7ef8e610e08b…`" is one commit
  behind this pass's own starting HEAD) — **fixed this pass, per the gate report's own §9 item 8
  suggestion** ("改成「见 git 历史」这种不会腐烂的写法"): the header no longer pins a single "HEAD as
  of" SHA at all (pinning *this* pass's HEAD would only recreate the identical self-reference problem
  the moment this pass's own commit lands — a header can never cite the SHA of the commit that writes
  it). It now points to "read the verification MD's own Part covering the pass in question," which
  does not decay on the next pass the way a hardcoded SHA does. See §H1's closing note.
- **P3-4** (two `wip` commits, closure depends on a lane instruction outside the gate reviewer's
  readable authorization chain) — not this implementer's to close; round-2's §G4 already recorded the
  correct disposition (self-resolves at the Draft-PR-opening step). No action item for any fix-round
  pass before that step exists.
- **P3-5** (§14.3 #9's mirror-override half, (b), still has no mutation run against it — only the
  positive-control half, (a), does, per round-3's own M6) — already disclosed as open in the design
  MD §4 and this document's §A9, consistent across all three gate rounds. Not a regression, not
  newly discovered; no action item beyond what is already on record.

This pass's own two fixes (§H1, §H2) are commit-scoped and complete against the round-3 gate's own
§9 closure criteria for P2-1 and P2-2. The round's zero P1 findings needed no action.

---

# Part I — round-3 gate's remaining two open P3 findings, fixed (later pass on this branch)

Part H (above) closed round-3's two P2 findings and one of its five P3 findings (P3-3) but explicitly
left P3-1, P3-2, P3-4, and P3-5 as carried forward (§H4). P3-4 and P3-5 already carried a correct
final disposition in §H4 ("not this implementer's to close" / "already disclosed, not a regression")
— nothing to fix there, only to leave standing. P3-1 and P3-2 did not: both named a live defect in
this document's own prose (§G2/§G7's self-contradiction; §G3's non-covering grep). This Part fixes
those two, in place at §G2/§G3/§G7 (not narrated separately here, to avoid the exact "narrative
covers the sentence instead of the sentence being fixed" failure this document has already flagged in
itself twice — see §G3's and §G5's `SUPERSEDED` annotations). **Docs-only: zero production or test
code touched.**

## I1. P3-1 (round-3) — §G2/§G7's commit-count self-contradiction, reconciled

**The finding**: §G2 said the round-2 fix "landed in a single commit; there is no second commit to
point to." §G7, a few dozen lines later in the same document, said "Two commits this pass." Both
cannot be true.

**Re-derived against this branch's actual history, not copied from either sentence**:
```
$ git show --stat a166f5ca0 | tail -6
 apps/web/src/approvals/api.ts                      |   2 +-
 ...approval-cancel-round-phase1-design-20260918.md |  32 ++-
 ...al-cancel-round-phase1-verification-20260918.md | 240 +++++++++++++++++++++
 .../src/services/ApprovalBridgeService.ts          |   2 +-
 .../approval-cancel-round-redemption.db.test.ts    |   8 +-
 5 files changed, 271 insertions(+), 13 deletions(-)
$ git show --stat 6c5b06f7d | tail -3
 ...al-cancel-round-phase1-verification-20260918.md | 31 ++++++++++++++--------
 1 file changed, 20 insertions(+), 11 deletions(-)
```
`a166f5ca0` touched both source comments (`ApprovalBridgeService.ts`, `api.ts`) and the design MD —
so the two P3-A comment fixes and the design MD header narrowing are in the **first** commit, not a
second one. `6c5b06f7d` touched only the verification MD, 31 lines — consistent with its own message
("Three narrowing fixes to the round-8 fix pass just committed"), i.e. it corrects three sentences
**inside** Part G, it does not add the comment fixes or header narrowing. So: two commits is the right
count (§G7), but §G7's own description of what landed in which commit was also wrong — it attributed
the comment fixes and header narrowing to the *second* commit ("one for G3–G6 … the two comment
fixes, the design MD header narrowing"), when they are in the first.

**Fix, this pass**: §G2 and §G7 both corrected in place (struck through, `SUPERSEDED` annotation
naming this finding and this Part, then the true two-commit split with per-commit content) rather
than silently rewritten — per this document's own established practice for a finding that turns out
to have been recorded wrong (see §G3/§G5's `SUPERSEDED` blocks, and memory
`feedback_supersession_marker_must_evaluate_not_void`: evaluate the specific false sentence, don't
void the whole section).

**Deliberately not restated as a hardcoded fact in this Part**: this Part does not itself assert "two
commits, split X/Y" as a freestanding claim outside of what §G2/§G7 now say — that would recreate a
second copy of the same claim for a future pass to find drifted from the first, the identical failure
shape `dce9e16df` diagnosed for the design MD's "HEAD as of" header and its own commit-count bullet.
§I1 points at §G2/§G7; it does not duplicate them.

**Rerun**: none required — no code or test file is touched by this fix (`git diff --stat` for this
commit, see §I3, shows only the verification MD). The seven-suite cancel-round set and `tsc --noEmit`
were rerun anyway, unchanged from every prior rerun this branch (`Test Files 7 passed (7) / Tests 47
passed (47)`; `TSC-EXIT:0`).

## I2. P3-2 (round-3) — §G3's safety-check grep replaced with the actual guards, named and rerun

**The finding**: §G3 justified editing two source comments with `grep -rn "readFileSync" … | grep
-iE "api\.ts|ApprovalBridgeService"` returning no hits, concluding "no sync-pin or source-text guard
reads either file." The grep's shape can only match a line where the literal token `readFileSync` and
a filename co-occur; it is blind to a `read(...)` helper whose body is on a different line from its
call site, or to a path built from a variable. Two such guards exist in this tree and both read one
of the two files §G3 edited:

```
$ grep -n "read('services/ApprovalBridgeService.ts')" packages/core-backend/tests/unit/approval-admin-capability.test.ts
366:    const arms = extractAdminArms(read('services/ApprovalBridgeService.ts'))
$ sed -n '343,345p' packages/core-backend/tests/unit/approval-admin-capability.test.ts
343:  function read(rel: string): string {
344:    return readFileSync(join(src, rel), 'utf8')
345:  }
$ grep -n "'src/approvals/api.ts'," apps/web/tests/approval-member-identity-coverage-enumeration.spec.ts
852:      'src/approvals/api.ts',
```

**Whether either guard could actually have been tripped by §G3's edits, checked directly rather than
assumed from "reads the file"**:

- `approval-admin-capability.test.ts`'s guard extracts SQL-arm shapes via
  `ADMIN_ARM_RE` against `source.replace(/\s+/g, ' ')` (`:356`) — **it does not strip comments before
  matching**, and says so in its own docblock: "a whole-file `toContain` … can be satisfied by a
  **DOCBLOCK** restating the arm" (`:350`). So "editing only the comment body is inherently inert" is
  **not a true general claim about this file** — a comment containing the `ADMIN_ARM_RE` SQL shape
  would turn this guard red regardless of being a comment. The edit §G3 actually made (a `file:line`
  citation number, `:9246` → `:9637`, inside a *different* docblock) does not contain that shape, so
  it stayed green for that reason, not for "comments are inert."
- `approval-member-identity-coverage-enumeration.spec.ts`'s guard at `:852` reads `api.ts` but its
  assertion (`:857-858`) checks for role-name-resolution identifiers
  (`ensureRoleNamesResolved|getResolvedRoleName|resolveApprovalDirectoryRoles|resolvedRoleNames`),
  unrelated in content to the `APS:8561`→`APS:8916` citation §G3 edited in that file — so this guard
  was never at risk from that specific edit, but again because of what it checks, not because
  comments are categorically safe.

**Actual safety evidence, rerun this pass** — the two guards that read these files, green:
```
$ npx vitest run tests/unit/approval-admin-capability.test.ts --reporter=dot
 Test Files  1 passed (1)   Tests  15 passed (15)
$ npx vitest run approval-member-identity-coverage-enumeration --reporter=dot
 Test Files  1 passed (1)   Tests  16 passed (16)
```
Both counts match the round-3 gate report's own P3-2 finding text verbatim
(`reviews/impl-gate-C-slice1-round3-20260918.md`, lines 294-295: "→ Test Files 1 passed / Tests 15
passed" / "16 passed") — this Part reruns the gate reviewer's own commands, not new ones. This
supersedes §G3's grep-based inertness argument with actual-guard evidence, and names the file where
"comment edits are inert" does not hold as a general property (`approval-admin-capability.test.ts`),
per the gate's own §9 item 7 instruction.

**Fix, this pass**: §G3's "No hit — … editing only the comment body is safe" sentence struck through
and annotated `SUPERSEDED`, pointing here.

**Rerun**: seven-suite cancel-round set and `tsc --noEmit`, unchanged (`Test Files 7 passed (7) /
Tests 47 passed (47)`; `TSC-EXIT:0`) — this fix touches only prose in the verification MD, no source
or test file.

## I3. Working-tree, commit, and branch discipline, this pass

- All work happened in the assigned worktree (`wt-cancel-round`) on the assigned branch; no
  `git checkout --`, `git reset --hard`, or stash discard was used or needed.
- No lock file or `reviews/` document was opened for editing: `git diff --name-only
  origin/main..HEAD | grep -iE "review|lock-draft|\.claude"` → 0 hits, checked after this pass's
  commit.
- No migration applied anywhere this pass (none exists to run); the private DB (`metasheet2_lock_c`)
  was written to by neither §I1 nor §I2 (docs-only) — it was read (never written outside those tests'
  own transactions) by the seven-suite integration rerun cited in §I1/§I2's own "Rerun" notes, the
  same suite set every earlier pass on this branch has used.
- No PR opened, no branch merged or undrafted, no force-push.
- Every commit in this pass is docs-only and touches only this one file — verified before staging
  each one via `git status --porcelain` / `git diff --stat`, and (for the pass as a whole, in case
  more than one commit lands) via `git diff --name-only dce9e16df..HEAD` (`git log --oneline
  dce9e16df..` lists the commits; each message states its own scope). Deliberately **not** a commit
  count pinned into this prose — the same lesson `dce9e16df`'s own message already drew from an
  earlier version of exactly this bullet ("a self-count inside a document every one of its own
  commits edits cannot survive the next commit that edits it") and §I1 applies to itself above.
  Neither source comment nor the design MD is touched by this pass's fixes (P3-1's fix corrects this
  document's *account* of what landed where in `a166f5ca0`/`6c5b06f7d`; it does not re-touch those
  files themselves).

## I4. Net status — round-3 gate report (`impl-gate-C-slice1-round3-20260918.md`) fully processed

Round-3's verdict was NEEDS-FIX, 0 P1 / 2 P2 / 5 P3 — re-derived from the report's own section
headings, not copied from its header line:
```
$ grep -cE "^### P[23]-" reviews/impl-gate-C-slice1-round3-20260918.md
7
```
~~(run from the worktree root)~~ **SUPERSEDED (gate round 4 / `impl-gate-C-slice1-round4-20260918.md`
P3-5): gate reports live under `~/.claude/projects/<proj>/reviews/`, NOT inside this repo's own
worktree — `reviews/impl-gate-C-slice1-round3-20260918.md` does not exist under the worktree root, so
this command as written cannot be reproduced there (`ls -d reviews` at the worktree root →
"No such file or directory"). The number itself is correct — run from the actual reviews directory,
`grep -cE "^### P[23]-" impl-gate-C-slice1-round3-20260918.md` → `7`, re-confirmed fresh by this fix
pass — only the path in the command as transcribed here was not reachable from the worktree it reads
as being run from.** Matching `grep -nE "^### P"` listing exactly P2-1, P2-2, P3-1, P3-2, P3-3, P3-4,
P3-5 and no others — 7, agreeing with the header's "2 P2 / 5 P3". Disposition after this Part:

| Finding | Status | Where |
|---|---|---|
| P2-1 | CLOSED | §H1 |
| P2-2 | CLOSED | §H2 |
| P3-1 | CLOSED | §I1 (this pass) |
| P3-2 | CLOSED | §I2 (this pass) |
| P3-3 | CLOSED | §H4 (design MD header converted to a non-decaying pointer) |
| P3-4 | Recorded, no implementer action — outside this document's readable authorization chain, self-resolves at the Draft-PR-opening step per round-2's §G4 | §H4 |
| P3-5 | Recorded, no implementer action — already disclosed as open across all three gate rounds, not a regression | §H4 |

Every finding the round-3 gate report named now has a terminal disposition recorded in this document:
five fixed (two P2, three P3), two P3 findings correctly recorded as open-and-not-actionable-here
rather than closed. This does not constitute a fourth gate pass approving the fixes — that is the
next independent reviewer's call, not this document's own.

---

# Part J — gate round 4 (`impl-gate-C-slice1-round4-20260918.md`) fully processed (fix round 1, this pass)

> Round 4 re-reviewed the round-3 FIX (this document's Part H/Part I), not new code from this lane —
> its own one-sentence framing: "这一条 P2 不是修复轮引入的回归…是我本轮新跑出来的实现侧覆盖缺口."
> Verdict: NEEDS-FIX, **0 P1 / 1 P2 / 6 P3** (`impl-gate-C-slice1-round4-20260918.md:10`).

## J1. P2-1 (round-4, CONFIRMED) — §9-9 allow-set had zero MEMBER-level discriminative power; fixed

**The gap** (gate §3, mutation R4-M5): `CANCEL_ROUND_ALLOWED_ACTIONS` implements the ratified §9-9
allow-set correctly (`{approve, reject, revoke, comment}`), and the lock-named negative-control
mutation ("remove the action-judgment call entirely") was already red per round-3's own M6/R4-M6. But
no test ever dispatched `'transfer'`, `'add_sign'`, or `'reduce_sign'` specifically — the existing
`#4/#6` acceptance only exercises `'handle'`/`'return'`. So *widening* the set (adding `'transfer'`
back in, the exact regression the ratify header exists to prevent) left all 47 acceptance tests
green — a silent break of the coupled §9-11/C-3 revoke-window invariant that the lock itself says
`transfer` also gates.

**Fix — one new test, mechanically enumerated, not hand-listed** (per
`feedback_trap_enumeration_does_not_converge`, explicitly named in the gate's own §9 fix guidance):
`packages/core-backend/tests/integration/approval-cancel-round-outlet-guards.db.test.ts`, new `it`
block titled `§9-9 allow-set MEMBER pin`, placed directly after the existing `#4/#6` test:

```ts
import { APPROVAL_ACTION_TYPES, type ApprovalActionRequest } from '../../src/types/approval-product'
// …
const RATIFIED_CANCEL_ROUND_ALLOWED_ACTIONS = new Set<string>(['approve', 'reject', 'revoke', 'comment'])
const forbiddenActions = APPROVAL_ACTION_TYPES.filter(
  (action) => !RATIFIED_CANCEL_ROUND_ALLOWED_ACTIONS.has(action),
)
expect(forbiddenActions.length).toBeGreaterThanOrEqual(5)
expect(forbiddenActions).toEqual(expect.arrayContaining(['transfer', 'add_sign', 'reduce_sign']))
for (const action of forbiddenActions) {
  // dispatch each one on a real cancel-round instance, assert 409 CANCEL_ROUND_OUTLET_FORBIDDEN,
  // assert the row (version, status) is unchanged
}
```

This iterates the REAL exported `ApprovalActionType` union (currently 9 members: approve, reject,
transfer, revoke, comment, return, add_sign, reduce_sign, handle), not a copy-pasted array of the
three ratify-named verbs — so a future verb added to `APPROVAL_ACTION_TYPES` is covered by this loop
without anyone remembering to edit this test (the exact failure mode
`finding_approval_action_verb_pinned_copy_blast_radius` warns about). The local
`RATIFIED_CANCEL_ROUND_ALLOWED_ACTIONS` copy holds its own ratified-literal value rather than
importing `ApprovalProductService`'s own `CANCEL_ROUND_ALLOWED_ACTIONS` constant — that constant is
module-private (never `export`ed), so declining to import it was never actually an available choice;
an independent literal copy is what keeps the test non-tautological against exactly the widening
regression it exists to catch (the guard-the-guard assertions above also fail loudly, rather than
passing vacuously, if the enumeration itself is ever tampered with). **Correction (P3 hygiene round,
2026-09-19, gate round-5 P3-5)**: this paragraph and the test's own doc comment previously said
"deliberately NOT imported", which reads as a declined choice; there was no such choice available
since the production constant was never exported. Same substance, corrected wording — see Part K.

**Implementation**: unchanged, per the gate's own §9 closure judgment ("实现不需要改") — the allow-set
literal was already correct; only the missing pin is added.

**Evidence, this pass** — private DB `metasheet2_lock_c`, dropped and recreated fresh
(`dropdb --if-exists` → `createdb` → migrate):

```
$ DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c npx tsx src/db/migrate.ts
MIGRATE-EXIT:0
$ grep -c "executed successfully" /tmp/c-migrate.log
409
```

Baseline (before the new test), seven-suite rerun on the virgin DB:
```
Test Files  7 passed (7)
     Tests  47 passed (47)
```

After adding the test, same seven suites:
```
Test Files  7 passed (7)
     Tests  48 passed (48)
```

`tsc --noEmit -p .` (packages/core-backend): `TSC-EXIT:0`, 0 lines of output.

**Mutation (repeats gate's own R4-M5, this pass's own run)** — `cp` backup, not `git checkout --`:
```
$ cp packages/core-backend/src/services/ApprovalProductService.ts /tmp/APS.orig.ts
```
Edit: add `'transfer'` as a fifth member of `CANCEL_ROUND_ALLOWED_ACTIONS` (the exact widening the
ratify header forbids). Rerun `approval-cancel-round-outlet-guards.db.test.ts` alone:
```
✓ #4/#6 dispatchAction action gate …
× §9-9 allow-set MEMBER pin …
  action=transfer: expected ServiceError: targetUserId is required for transfer { …(3) } to
  match object { statusCode: 409, code: 'CANCEL_ROUND_OUTLET_FORBIDDEN' }
  - Expected: { code: "CANCEL_ROUND_OUTLET_FORBIDDEN", statusCode: 409 }
  + Received: { code: "VALIDATION_ERROR", statusCode: 400 }
Test Files  1 failed (1)
     Tests  1 failed | 6 passed (7)
```
The new test goes red — and specifically on the widened action, not by coincidence: with the outlet
gate bypassed for `'transfer'`, execution falls through to the transfer-specific downstream
validation (`targetUserId is required for transfer`), which throws a DIFFERENT code/status
(`400 VALIDATION_ERROR`, not `409 CANCEL_ROUND_OUTLET_FORBIDDEN`). Because the assertion checks the
SPECIFIC status+code pair (not merely "did it reject"), it fails whenever the
`CANCEL_ROUND_OUTLET_FORBIDDEN` gate is not what's actually blocking the action — which is exactly
the invariant this test exists to pin, regardless of what secondary validation happens to also fire
once the primary gate is bypassed. The other 6 tests in the file (including `#4/#6`, which never
dispatches `'transfer'`) stay green — the mutation is not a blanket break, only a member-level one,
confirming the new test's discriminative power is genuinely additive over the pre-existing suite.

**Why `add_sign` and `reduce_sign` needed SEPARATE single-verb mutations, not just this one**: the
`for (const action of forbiddenActions)` loop's body is `await expect(promise).rejects.toMatchObject(...)`
— on a mismatch this throws synchronously, aborting the loop at the FIRST failing iteration.
`forbiddenActions`, filtered from `APPROVAL_ACTION_TYPES` preserving that array's declared order, is
`['transfer', 'return', 'add_sign', 'reduce_sign', 'handle']` — `'transfer'` is first. So the single
mutation above only proves `'transfer'` is pinned; it says nothing about `'add_sign'`/`'reduce_sign'`
individually (the gate report's own §8 flagged exactly this as "未分别跑" for those two verbs, and a
fix that inherited the same gap in its own evidence would repeat the finding it's closing). Two more
`cp`-backed single-verb mutations, run and restored the same way:

```
$ cp packages/core-backend/src/services/ApprovalProductService.ts /tmp/APS.orig2.ts
```
Add ONLY `'add_sign'` (not `'transfer'`) to the allow-set. Rerun the same file alone:
```
× §9-9 allow-set MEMBER pin …
  action=add_sign: expected ServiceError: targetUserIds is required f… { …(3) } to match object
  { statusCode: 409, code: 'CANCEL_ROUND_OUTLET_FORBIDDEN' }
  - Expected: { code: "CANCEL_ROUND_OUTLET_FORBIDDEN", statusCode: 409 }
  + Received: { code: "VALIDATION_ERROR", statusCode: 400 }
Test Files  1 failed (1)
     Tests  1 failed | 6 passed (7)
```
Red specifically at `action=add_sign` — the loop's earlier iterations (`'transfer'`, `'return'`,
still forbidden in this mutation) pass fine first, confirming the failure tracks the mutated member,
not a blanket break. Restore, `cmp` clean, rerun outlet-guards file green again. Repeat with ONLY
`'reduce_sign'` added:
```
× §9-9 allow-set MEMBER pin …
  action=reduce_sign: expected ServiceError: targetAssignmentUserId is r… { …(3) } to match object
  { statusCode: 409, code: 'CANCEL_ROUND_OUTLET_FORBIDDEN' }
  - Expected: { code: "CANCEL_ROUND_OUTLET_FORBIDDEN", statusCode: 409 }
  + Received: { code: "VALIDATION_ERROR", statusCode: 400 }
Test Files  1 failed (1)
     Tests  1 failed | 6 passed (7)
```
Red specifically at `action=reduce_sign` (`'transfer'`/`'return'`/`'add_sign'` pass first). All three
ratify-named verbs are now INDIVIDUALLY measured, not two of them inferred from the shared predicate
— closing the same gap in the fix's own evidence that the gate report disclosed in its own §8/§10 for
`'transfer'` alone.

Each of the three mutations was restored and verified byte-identical independently, immediately after
its own run (not batched at the end): `transfer`'s backup (`/tmp/APS.orig.ts`) restored and `cmp`
clean before the `add_sign` mutation was made; `add_sign`'s backup (`/tmp/APS.orig2.ts`) restored and
`cmp` clean (`RESTORE-CLEAN-1`) before the `reduce_sign` mutation reused that same clean baseline;
`reduce_sign`'s restore from the same backup was `cmp` clean (`RESTORE-CLEAN-2`). `git status
--porcelain` after all three restores:
```
 M packages/core-backend/tests/integration/approval-cancel-round-outlet-guards.db.test.ts
```
(the seed-file and this document's own edits, at the point these mutations were run, had not yet been
made — only the new test file shows as modified here). Only the intended test-file diff remains after
each restore; every mutation left zero trace on `ApprovalProductService.ts`. Post-restore, full
seven-suite rerun: `Test Files 7 passed (7)`, `Tests 48 passed (48)` — matches the post-fix baseline
above, confirming the restores did not silently change anything else.

**Disclosure**: §A9 above now carries a line for this gap and its closure (added this pass, following
the document's existing convention for a since-resolved BLOCKING item).

**Checklist item now closed.**

## J2. The six P3 findings — disposed "顺手" per the gate's own §9 items 3-8 (docs-only, no code)

| Gate finding | Disposition | Where |
|---|---|---|
| P3-1 (seed file: three stale baseline `file:line` pointers) | Fixed — replaced with an explanation of why the lock's baseline line numbers no longer match this tree's (+446 lines to `ApprovalProductService.ts`), plus a `grep` recipe to re-derive fresh pointers instead of a new literal that would just go stale again the same way. | `packages/core-backend/src/db/seeds/approval-cancel-round-published-definition.ts` (module doc comment) |
| P3-2 (seed file: false invariant — "empty array is more restrictive than absent") | Withdrawn — the window gate is `revokeBeforeNodeKeys?.length && …`, so an absent key and an empty array short-circuit identically (both fail-open); replaced with the correct statement and a pointer to R4-M3's real behavioural mutation as what actually pins the fail-open default. | same file, same comment block (kept as ONE edit since the false claim and the stale pointers share a paragraph, but the two defects — pointer-error vs. invariant-error — are called out separately per the gate's own instruction not to conflate them) |
| P3-3 (this document's own tip-pointer, `74c6c2e96`, stale by two commits at three sites) | Fixed at all three sites (verif:2129/2171/2187-area, pre-this-pass line numbers) — struck through and annotated `SUPERSEDED`, re-derived against the true tip `50fe83ebc`; the underlying substantive claims (docs-only, zero non-md files, same two files touched) all still hold, only the "which commits were checked" self-reference was false. | this document, this Part J entry + the three struck-through sites in §H3 |
| P3-4 (design MD's own `:9246`-context citation, `209-210` vs. actual `216-217`) | Fixed — struck through and annotated, re-derived: `grep -n "9246" design MD` → `:216`/`:217`. | this document, the §I2-area citation |
| P3-5 (a `reviews/…` grep in §I4 not reproducible from the worktree root) | Fixed — annotated that gate reports live under `~/.claude/projects/<proj>/reviews/`, not in this repo; the number itself (7) was already correct and is re-confirmed from the actual path. | this document, §I4 |
| P3-6 (§H2's false provenance parenthetical — "before this lane's own ci-wiring file existed") | Withdrawn — `95eccb89b`'s population of 45 already INCLUDES this lane's own new `approval-cancel-round-ci-wiring.test.ts`; the true pre-lane count (on `origin/main`) is 44. The supported conclusion ("38" was wrong from the start) is unaffected since 44 ≠ 38 either way. | this document, §H2 |

None of these six required any code change, any real-DB rerun, or any migration — all are corrections
to prose/comments this lane's own earlier passes wrote, confirmed against the current tree by fresh
`grep`/`git` commands quoted inline at each site (not re-typed from the gate report).

## J3. Working-tree, commit, and branch discipline, this pass

- All work happened in the assigned worktree (`wt-cancel-round`) on branch
  `feat/approval-cancel-round-phase1`; no `git checkout --`, `git reset --hard`, or stash discard was
  used or needed anywhere in this pass.
- The three mutations this pass ran (R4-M5 repeat for `'transfer'`, plus the two additional
  single-verb mutations for `'add_sign'` and `'reduce_sign'`, §J1) were each backed up with `cp`,
  restored with `cp`, and verified byte-identical with `cmp` individually — not batched at the end;
  `git status --porcelain` showed only the intended source-tree diff after each restore.
- No lock file or `reviews/` document is touched by this pass's commit(s) — checked with
  `git diff --name-only origin/main..HEAD | grep -iE "review|lock-draft|\.claude"` after the commit
  existed and before pushing (not asserted here in advance of that commit existing, per the same
  discipline this Part's own §J2/P3-3 entry names). Result: 0 hits.
- No migration was applied to any shared database; the only database touched
  (`metasheet2_lock_c`) is this lane's own private DB, dropped and recreated fresh by this pass
  (§J1) — never a shared or CI database.
- No PR opened, no branch merged or undrafted, no force-push, `origin/main` untouched.
- Files touched this pass:
  `packages/core-backend/tests/integration/approval-cancel-round-outlet-guards.db.test.ts` (the new
  §9-9 member-pin test), `packages/core-backend/src/db/seeds/approval-cancel-round-published-definition.ts`
  (P3-1/P3-2 comment fixes), `docs/development/approval-cancel-round-phase1-verification-20260918.md`
  (this Part J, the §A9 disclosure line, and the P3-3/P3-4/P3-5/P3-6 struck-through annotations).
  Zero other paths.

## J4. Net status — gate round 4 (`impl-gate-C-slice1-round4-20260918.md`) fully processed

| Finding | Status | Where |
|---|---|---|
| P2-1 | CLOSED | §J1 |
| P3-1 | CLOSED | §J2 |
| P3-2 | CLOSED | §J2 |
| P3-3 | CLOSED | §J2, §H3 (struck-through annotations) |
| P3-4 | CLOSED | §J2, §I2-area citation |
| P3-5 | CLOSED | §J2, §I4 |
| P3-6 | CLOSED | §J2, §H2 |

Every finding round 4 named now has a terminal disposition recorded in this document. This does not
constitute a fifth gate pass approving these fixes — that is the next independent reviewer's call,
not this document's own.

---

# Part K — P3 卫生轮(2026-09-19)

Processes every P3 gate round 5 (`impl-gate-C-slice1-round5-20260918.md`, 0 P1 / 0 P2 / 5 P3,
DRAFT-READY) left open, plus that report's own §9 ("若要把五条 P3 也清掉") suggested closures. Scope
this pass, per the running instruction: **zero production-code behavior change** — comments, MD,
test files, scripts/dev only. Start point this pass diffs against:
`74a387dad6a1b29acb596ab3992a634bc739eb9d` (this document's own round-5-gated HEAD, confirmed via
`git rev-parse HEAD` before any edit in this pass, not copied from the gate report's prose).

## K1. Disposition table

| # | 原文一句(round-5 gate) | 处置 |
|---|---|---|
| P3-1 | 成员钉只钉了补集;`approve` 的成员身份半边仍零判别力(§A9 的 "CLOSED by it" 措辞盖过了两半) | **CLOSED-MD** — §A9 bullet header and closing sentence narrowed to "COMPLEMENT half CLOSED"; `approve`'s undiscriminated membership named explicitly and deferred to C-2 alongside 判据 II. Part J's own `P2-1 \| CLOSED` verdict row is UNTOUCHED (that verdict — widening has no discriminative power — is genuinely closed; only the broader "member-level pin" phrasing needed narrowing, per `feedback_supersession_marker_must_evaluate_not_void`: the marker evaluates the one sentence, not the section). |
| P3-2 | 设计 MD 两处 `file:line` 指针(§3.3 `:4253-4264`,§7 `:4253-4272`)与本树不符,且不是漂移,是写错 | **CLOSED-MD** — both sites switched from a pinned line-literal to a re-derive `grep` command, per the gate's own recommended (and preferred) fix; the correct current-tree block (`:4251-4256` const / `:4258-4266` function) is also stated once, for a reader who wants the number without running the grep. §7's `:9928` call-site pointer — which the gate confirmed correct — is left untouched. |
| P3-3 | 验收映射表(§A6)没有新测试 `§9-9 allow-set MEMBER pin` 的行 | **CLOSED-MD** — one row added to §A6 immediately after the existing `Outlets #4/#6 (action gate)` row, verbatim test title copied from the test file (not retyped by hand), same `same` lane label as its sibling rows in that file. |
| P3-4 | PR #5851 body 仍停在第 2 轮,「门审要求 PR body 必写的九条」标题也未追平第 10/11 条 | **DEFERRED-owner 项** — this round's own hard rule forbids touching PR state or body (`不动 PR 状态与 body`); a PR-body edit is a publish-time action, not a test/comment/MD/scripts change. Not attempted. §K3 below carries forward the gate's suggested replacement text verbatim so whoever next updates the body does not have to re-derive it. |
| P3-5 | 新测试的 doc 注释("deliberately NOT imported")把一件做不到的事("导入" `CANCEL_ROUND_ALLOWED_ACTIONS`,该常量从未 `export`)写成了"有意不做" | **CLOSED-注释** — fixed at both sites that carried the phrase: the test file's own doc comment (`approval-cancel-round-outlet-guards.db.test.ts`) and this document's Part J narrative describing the same test (verif, §J2-area). Both now say the constant is module-private, so "importing" was never an available choice, while keeping the substantive point (an independent literal copy is the correct design, confirmed load-bearing by R5-M6) unchanged. |

## K2. §14.2 允许集 —— 完整 2×2,写死供下一轮引用(不必重导)

| 允许集成员 | 移除它 ⇒ | 本 lane 的钉 |
|---|---|---|
| `reject` | 红(2 例,redemption) | 有钉,round-5 R5-M10 |
| `revoke` | 红(4 例,redemption) | 有钉,round-5 R5-M9 |
| `comment` | 红(1 例,outlet-guards #4/#6) | 有钉,round-5 R5-M8 |
| `approve` | **绿(48/48)** | **无钉 — 判据 II 未在本切片实现,深钉延后到 C-2** |

补集半边(拒绝 `transfer`/`add_sign`/`reduce_sign`/`return`/`handle`)由 round-4/5 的 `§9-9 allow-set
MEMBER pin` 逐成员钉住(round-5 R5-M1…M5,五条全红)。

## K3. P3-4 的建议正文,原样搬运(供下一次更新 PR body 时直接用)

Round-5 gate §9 第 4 条 + 该报告结尾的建议引用文本,逐字未改动:

> §14.2 允许集的**补集半边**已有逐成员钉(`§9-9 allow-set MEMBER pin`,机械遍历
> `APPROVAL_ACTION_TYPES`),门审第 5 轮对 `transfer`/`add_sign`/`reduce_sign`/`return`/`handle`
> **五个动词逐个亲跑加宽 mutation,五条全红**;**成员半边**同样逐格测量(`reject`/`revoke`/`comment`
> 移除即红,**只有 `approve` 无钉**),`approve` 随判据 II 落 C-2(门审 P3-1)。

以及门审第 5 轮 §9 第 4 条本身:更新 PR body 的门审状态段(第 2 轮 → 第 5 轮 DRAFT-READY @
`74a387dad`),并把第 10/11 条按现状求值(第 11 条已因钉子落地而消解)。**本轮未执行**——见 K1
P3-4 处置理由。

## K4. §3.6 承接事项(round-5 gate,非 P3,本轮未处置)——如实点名,不当成已排空

Round-5 gate §3.6 named four carry-over items not counted as P-level and not new this round. This
pass's scope is the five *open P3s*, not these; they are named here only so they do not read as
silently dropped:
- §14.3 #9 (b) 半边(mirror 覆盖)——仍无可红断言,carry-over 未变。
- 两个 `wip:` 提交——squash 需要 force-push 到已推送的分支;本轮硬规矩禁止 force-push,未处置。
- 判据 II / 判据 IV / attendance-parity——C-2 范围,已披露,未处置。
- 锁文 mtime(`Sep 17 10:45`)vs 抬头 `RATIFIED 2026-09-18`——owner 求值项,未处置。

## K5. 撤回类改动 —— 全 lane population grep 扫描

Population = the two cancel-round MDs (`…-design-20260918.md`, `…-verification-20260918.md`) plus
the outlet-guards test file — the three files P3-1/P3-2/P3-3/P3-5's withdrawn phrasings could have
lived in.

```
$ grep -rn "deliberately NOT imported" docs/development/approval-cancel-round-phase1-verification-20260918.md \
    packages/core-backend/tests/integration/approval-cancel-round-outlet-guards.db.test.ts
```
Both remaining hits are inside the CORRECTIVE sentence itself (quoting the retracted phrase to name
what was fixed), not a standing claim. Zero hits assert the old (false) framing as fact.

```
$ grep -n "4253-4264\|4253-4272" docs/development/approval-cancel-round-phase1-design-20260918.md
```
Both remaining hits are inside the corrective annotation (naming the old, wrong numbers as what was
fixed). Zero hits use them as an active pointer.

**Repo-wide, for the record (not this lane's population)**: `4253-4272` also appears in
`docs/development/approval-remaining-dev-design-report-20260820.md:379`, describing a different
construct (`samePersonPolicy` widening predicate) in a different, unrelated document from a different
work item. Left untouched — out of this lane's scope, and touching an unrelated doc's line-number
citation is not this pass's mandate.

```
$ grep -n "CLOSED by it" docs/development/approval-cancel-round-phase1-verification-20260918.md
```
One hit, now reading "**the COMPLEMENT half** CLOSED by it" — the bare, unqualified form no longer
exists.

## K6. 本轮跑了什么(处女库,dropdb 收尾)

```
$ dropdb --if-exists metasheet2_p3hygiene_r5 && createdb metasheet2_p3hygiene_r5
$ DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_p3hygiene_r5 npx tsx src/db/migrate.ts
MIGRATE-EXIT:0   grep -c "executed successfully" → 409
$ DATABASE_URL=…metasheet2_p3hygiene_r5 EXPECT_DB=1 npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-{lock-order-census,creation,redemption,seat-guards,attendance-fk-migration,outlet-guards,node-timeout-effect}.db.test.ts
 Test Files  7 passed (7)   Tests  48 passed (48)   Duration  21.33s
$ npx vitest run tests/unit/approval-cancel-round-ci-wiring.test.ts tests/unit/approval-cancel-round-plugin-mirror-constant.test.ts
 Test Files  2 passed (2)   Tests  15 passed (15)
$ npx tsc --noEmit -p .    (packages/core-backend)
TSC-EXIT:0   wc -l → 0
$ dropdb metasheet2_p3hygiene_r5
```
Same 48/48 and 15/15 as round-5 gate's own baseline (§1.2/§1.3 of that report) — this pass's only
production-adjacent edit (the test-file doc-comment fix, P3-5) is confirmed non-behavioral by these
identical counts, not merely asserted so from reading the diff.

**Range exemption, stated not silently skipped** (same reasoning as round-5 gate §1.9): this pass
adds/renames zero real-DB test files and touches zero `.github/` files, so the two-point wiring
census, sentinels, `plugin-tests.yml` inclusion count, `*-ci-wiring` population (45), the DML
table-classification suite, and the s6a `plugin-tests.yml` digest pin all carry forward unchanged
from round-5 gate's own mechanical recount (§1.6/§1.7/§1.8/§1.9 of that report) — not rerun this
pass because nothing they guard against moved.

## K7. 改动面(机械可核)

```
$ git diff --stat 74a387dad6a1b29acb596ab3992a634bc739eb9d..HEAD
 docs/development/approval-cancel-round-phase1-design-20260918.md         |  10 +-
 docs/development/approval-cancel-round-phase1-verification-20260918.md   | 183 ++++++++++++++++++++-
 .../approval-cancel-round-outlet-guards.db.test.ts                       |  12 +-
 3 files changed, 192 insertions(+), 13 deletions(-)
```
Measured at `85473095c4f45d0010eb40f2523e91da0f72cb25` (the commit that carries K1-K6 of this Part
K). This Part K's own text is itself part of the 183-line verification-MD delta above — like Part
J's own diff-of-itself before it, the exact insertion count is intrinsically self-referential (this
sentence adds to the count it is describing), but the FILE LIST of 3 is not: it was fixed the moment
the source edits (P3-1/P3-2/P3-3/P3-5) stopped, before this document's own Part K prose was written.
A follow-up commit adding K7's own restored numbers (this block) and K6's softened wording (next
paragraph) adds a small further delta on top of the 192/13 above — see this document's own git log
for the exact split, not re-typed here to avoid yet another self-reference layer.
- `docs/development/approval-cancel-round-phase1-design-20260918.md` — P3-2 (2 sites, comment-style
  MD prose, no code).
- `docs/development/approval-cancel-round-phase1-verification-20260918.md` — P3-1, P3-3, P3-5
  (second site), plus this Part K.
- `packages/core-backend/tests/integration/approval-cancel-round-outlet-guards.db.test.ts` — P3-5
  (first site), a doc-comment-only edit inside the test file (`/** ... */` block, verified by the
  `git diff` hunk itself — every changed line falls between the `/**` and `*/` markers) — zero
  executable lines changed. The 48/48 rerun in K6 matches round-5 gate's own test COUNT baseline;
  this pass did not additionally diff the list of case names against that report (the diff hunk
  above is the stronger evidence for "comment only", not the test count).

Zero other files touched. Zero lock-file or `reviews/` touches
(`git diff --name-only origin/main..HEAD | grep -icE "review|lock-draft|\.claude"` → unchanged at
`0`, this pass added nothing to that population). Zero `origin/main` touches (this pass makes no
fetch of `main`, no push to it). Zero merge, undraft, PR-state, or PR-body change.

## K8. 未处置项(如实列,非本轮遗漏)

- P3-4 (PR body) — deferred, hard rule this round, §K1/§K3.
- §3.6 的四条 carry-over — deferred, out of this round's P3 scope, §K4 (named so as not to read as
  dropped).
- No new mutation probes were run this pass — every fact P3-1/P3-2/P3-3/P3-5 rely on
  (module-private-ness of `CANCEL_ROUND_ALLOWED_ACTIONS`, the real `:4251-4266` block, the verbatim
  test title, the 2×2 member table) was re-derived fresh this pass with `grep`/`sed -n` against the
  current tree (quoted inline above), not copied from the gate report's prose — but none of it is a
  NEW behavioral claim requiring a NEW mutation; round-5's own R5-M1…M10 (`impl-gate-C-slice1-round5-20260918.md`
  §4) remain the mutation evidence for the 2×2 table in K2, cited, not rerun.

# Part L — Codex 审阅 2026-09-19 修复(finding 1 席位再资格化 + finding 2 套件/窗口定域)

**Pass**: fix round for the two independently-verified Codex findings against this slice.
**Starting HEAD**: `c4dc4b9285260473cdc052c0f624cc2a72450c6f` (= `origin/feat/approval-cancel-round-phase1`
at fetch time; `git status --porcelain` empty before the first edit).
**Binding inputs** (read in full, not summarised from the task text):
`reviews/verify-codex-cancel-finding1-20260919.md`(CONFIRMED P1,修 C-1)、
`reviews/verify-codex-cancel-finding2-20260919.md`(CONFIRMED P2,策略函数+创建期守卫落 C-1)。
**Private virgin DBs**, all `createdb`-ed here and `dropdb`-ed at the end; no shared/staging/prod DB
was touched, no lock file was edited, no PR state changed:
`metasheet2_fix_c1`(功能与 mutation)、`metasheet2_fix_c1_old`(旧实现对照,用后即删)、
`metasheet2_fix_c1_full`(required `test (20.x)` 全量连跑)。

## L0. 两处任务书与绑定报告冲突,以报告为准(如实记录,不是漏做)

| 任务书 ① 的措辞 | 绑定报告的要求 | 本轮采用 | 理由 |
|---|---|---|---|
| detail 要能告诉管理员「**哪些席位**」 | finding-1 §5.2.2:**不得回显被停用者的 id/姓名**,`details` 只带可机核结构 | 报告 | 报告是绑定输入,且任务书自己引述的报告摘要里同样写着 "machine-checkable details only, never echoing ids";`validateAndFreezeRequesterChoices` 的既有纪律也是 values-free。「提示管理员」落在 message 与审计,不在错误体 |
| 原因枚举含 `left-org` | finding-1 §5.2.1:组织半边是**新谓词 / 合同新增 / owner 裁**;「若 owner 不裁,先只落在职半边并逐字记 OPEN」 | 报告 | 全仓今天没有任何按 `user_orgs` 做席位资格的谓词(见设计 MD §3.4);本轮无 owner 裁决,故 A 独立落地、B 记 OPEN,并留一条 `org_id IS NULL` 正控把 NULL 语义问题钉在明处 |

窗口越界的「阻断 vs 夹紧」二选一,按锁文措辞取**阻断**:lock:143 写的是 `windowDays ∈ [0, 上限]`、
「由模板管理员在上限内设」——上限是**可设值的定义域约束**,越界即配置错误;夹紧会把配置错误变成
「悄悄按 90 算」,与该句的可审性冲突,也与本仓「收窄修复 = 写路径拒绝」的既有纪律相反。
依据逐字写在设计 MD §3.4 与 `deriveCancelRoundRoundPolicy` 的 doc comment 里。

## L1. 改了什么(7 个文件)

| 文件 | 改动 |
|---|---|
| `src/services/ApprovalProductService.ts` | 常量改名 `CANCEL_ROUND_SUITE_DEFAULT_WINDOW_DAYS` → `CANCEL_ROUND_SUITE_WINDOW_DAY_CEILINGS`;新增 `CANCEL_ROUND_SUITES` 闭集与 `CANCEL_ROUND_DEFAULT_SUITE`;新增**唯一**派生函数 `deriveCancelRoundRoundPolicy`(枚举 + 范围,两处时点共用);新增 `assertCancelRoundSeatsEligibleInTxn`;`createCancelRoundInstance` 锁内接线(见设计 MD §3.4 的十步守卫序) |
| `tests/helpers/approval-schema-bootstrap.ts` | 新增导出 `ensureLocalUserRow`(TEST-ONLY);**未** bump `APPROVAL_SCHEMA_BOOTSTRAP_VERSION`——本轮零 DDL 改动,bump 会逼所有套件重跑 bootstrap |
| `tests/integration/approval-cancel-round-creation.db.test.ts` | 7 条新用例 + 会签夹具 + 零行 oracle;`authToken` 现在建 `users` 行 |
| 另 4 个 `approval-cancel-round-*.db.test.ts`(node-timeout-effect / outlet-guards / redemption / seat-guards) | 只改 `authToken` 建 `users` 行 + afterAll 清理(见 L2) |

### L2. 为什么 5 个夹具文件都要改:`dev-token` 不写 `users` 行

`GET /api/auth/dev-token`(`src/routes/auth.ts:63-110`)只签 JWT 并 `createUserSession`,**不插 `users` 行**。
修前基线库实测:跑完 7 个撤销轮套件后 `SELECT count(*) FROM users` = **0**。
新守卫复用的先例(`validateAndFreezeRequesterChoices` 的 company 基线)是**集合成员判定**——
`activeIds` 只装查回来的行,`ids.some(id => !activeIds.has(id))` 即拒——所以**查无此行天然 fail-closed**,
这不是本轮另加的规则。让缺行通过才是「另造更窄同类物」。生产审批人必然有 `users` 行(他要登录才能审批),
因此正确的修法是把夹具改成生产形状,而不是把守卫改成 fail-open。**这条是本轮唯一的跨文件外溢,已全量披露。**

未打补丁时的实测(证明这 5 个文件确实是全部人口,且改动确实必要):
```
7 files / 20 failed | 28 passed (48)   ← 仅加守卫、未改夹具
加 ensureLocalUserRow 后:7 files / 48 passed (48)   ← 与修前基线逐数相同,零附带行为变化
```

## L3. 验收行(新增 7 条,全部在既有文件 `approval-cancel-round-creation.db.test.ts` 内)

新增用例**没有新建真库测试文件**,因此四道钉(两点接线 / 哨兵 / `plugin-tests.yml` 清单 / ci-wiring 人口 /
ci-realdb-step-contract / s6a 钉)**人口未变**——机械核验见 L6。

| # | 用例(verbatim 前缀) | 锚点 | 断言 |
|---|---|---|---|
| P1 | `§2-G3 正控 P1 — every original approver is still eligible ⇒ the round is created with ONE SEAT PER APPROVER` | G3 半 A | 会签 2 席位:**数量等于原审批人数**且集合逐字相等(反「过滤后继续」的 oracle) |
| P2 | `§2-G3 正控 P2 — an original whose org_id IS NULL is NOT refused` | G3 半 B OPEN | `org_id IS NULL` 不被新门误杀;新实例 `org_id` 仍为 NULL;一行 pending 轮次 |
| N1 | `§2-G3 负控 N1 — a DEACTIVATED original approver blocks creation` | G3 半 A | 409 `CANCEL_ROUND_SEAT_INELIGIBLE`;`details` 逐字 `{ineligibleCount:1, reasons:['inactive']}`;键集恰为两键;`details`/`message` 均**不含**被拒者 id;`approval_rounds` / 专用 `approval_instances` / 其上的 `approval_assignments` **三张表零行** |
| N2 | `§2-G3 负控 N2 — the seat gate is the SHARED LOGIN gate, not a narrower is_active lookalike` | G3 半 A | 三腿逐一单变量:`pending_activation`(is_active 仍 TRUE)⇒ reasons `['pending_activation']`;`role='disabled'`(is_active 仍 TRUE)⇒ `['inactive']`;删 `users` 行 ⇒ `['not_found']`;每腿零行;**判别控制**:同一单据把行恢复后同一调用 201 |
| A | `lock:143 负控 A — windowDays outside [0, suite ceiling] blocks creation` | lock:143 | `91` / `-1` / `90.5` / 字符串 `"90"` 四腿各 409 `CANCEL_ROUND_WINDOW_OUT_OF_RANGE`、`details` 逐字 `{suite:'leave', ceiling:90}`、每腿零行;**判别控制**:同一单据 `windowDays=0` ⇒ 201 且快照逐字 `{suite:'leave', windowDays:0}` |
| B | `lock:143 正控 B — windowDays = 90 (the leave ceiling, inclusive) is accepted` | lock:143 | 上界闭区间可用;`policy_snapshot_at_create.roundPolicy` 逐字 `{suite:'leave', windowDays:90}` |
| C | `lock:143 正控 C — an out-of-domain suite tag ("Forbidden") is rejected` | lock:143 + §14.3 #14 | 409 `CANCEL_ROUND_SUITE_UNKNOWN`、`details.allowedSuites` 逐字四值、零行(这正是 finding-2 §6 在旧码上实测**走得过去**的那条路) |
| D | (既有)`§14.3 #14 (WI-6) — suite="forbidden" is rejected before any write` | §14.3 #14 | 保持绿——证明新枚举门没有把锁文唯一点名的创建期错误码改道 |

命令与结果(处女库 `metasheet2_fix_c1`,逐字):
```
$ DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_fix_c1 EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    $(ls tests/integration/approval-cancel-round-*.db.test.ts) --reporter=dot
 Test Files  7 passed (7)
      Tests  55 passed (55)          （修前基线同库同命令:48 passed (48);差 = 本轮 7 条）
$ npx tsc --noEmit
（无输出,EXIT 0）
```

## L4. Mutation 台账(cp 备份 → 改 → 单跑 → cp 还原 → cmp,逐条实跑)

备份件:`reviews/c1-fix-mutbak/ApprovalProductService.ts.backup`;每次还原后 `cmp` **identical**,
全部跑完后 `git status --porcelain` 只剩本轮的 7 个有意改动文件。逐条日志在 `reviews/c1-fix-mutbak/<MUT>.log`。

| Mutation | 做了什么 | 结果 | 变红的用例(逐字) |
|---|---|---|---|
| **M1-GUARD-DELETED** | 整段删掉 `assertCancelRoundSeatsEligibleInTxn` 调用 | 2 failed / 11 passed | N1、N2 |
| **M2-BLOCK-BECOMES-FILTER** | 把阻断换成「查 `is_active=TRUE` 后把不合格者过滤掉再继续」 | 2 failed / 11 passed | N1、N2 |
| **M4-DETAILS-ECHO-IDS** | 错误体 `details` 里加回被拒者 id 数组 | 1 failed / 12 passed | N1 |
| **M5-WINDOW-RANGE-DELETED** | 范围/类型判据恒假 | 1 failed / 12 passed | A |
| **M6-ENUM-FALLS-BACK-TO-DEFAULT** | 域外 suite 回落到默认 `leave`(= 修前行为) | 1 failed / 12 passed | C |

**M2 的判别力落点要说清楚,不要过强**:M2 下变红的是 **N1/N2 的「必须抛」+「三表零行」**两组断言,
**不是** P1 的「席位数 = 审批人数」——P1 的夹具两人都合格,过滤器在它身上是恒等变换。
P1 的精确计数断言是**纵深**(挡住「既过滤又仍然建单」的将来变体),不是本轮 M2 的承重探针。

**M3(把资格校验挪到 `FOR UPDATE` 之外)—— NOT COVERED,理由写明,不用顺序论证冒充竞态证据。**
`FOR UPDATE` 锁的是 `approval_instances` 的那一行,它**不**与 `UPDATE users SET is_active=FALSE`
互斥(不同表、无锁关系)。READ COMMITTED 下资格 SELECT 在事务内无论放前放后都取新快照,
「校验→INSERT」之间的窗口两种放法都存在。因此这条 mutation 在本谓词下**不可证伪**,本轮不构造竞态,
如实记 NOT COVERED。同时声明:放在同一把 `FOR UPDATE` 之下的要求**没有被削弱**——它保证的是与
WI-16 门、§14.3 #14 门、以及后续席位 INSERT 的**原子性**(期间没有第二个撤销轮创建能插进来)。

## L5. 旧实现对照(证明是 fixed,不是 never-broken)

`cp` 现源码留存 → `git show c4dc4b928:…/ApprovalProductService.ts > <同路径>` → 用**本轮的新用例**跑
**独立处女库** `metasheet2_fix_c1_old` → `cp` 还原 → `cmp` identical。
新用例**不 import** 任何本轮新增的服务端符号,所以旧码下的红是真红,不是模块解析错误。

```
$ git show c4dc4b928:packages/core-backend/src/services/ApprovalProductService.ts > <path>   # 12882 lines
$ DATABASE_URL=…/metasheet2_fix_c1_old EXPECT_DB=1 npx vitest --config vitest.integration.config.ts \
    run tests/integration/approval-cancel-round-creation.db.test.ts --reporter=dot
 FAIL  §2-G3 负控 N1 — a DEACTIVATED original approver blocks creation …
 FAIL  §2-G3 负控 N2 — the seat gate is the SHARED LOGIN gate, not a narrower is_active lookalike …
 FAIL  lock:143 负控 A — windowDays outside [0, suite ceiling] blocks creation …
 FAIL  lock:143 正控 C — an out-of-domain suite tag ("Forbidden") is rejected …
      Tests  4 failed | 9 passed (13)
$ cp <backup> <path> && cmp <backup> <path>   → identical
```

方向正确:**四条负控在旧码上红、在新码上绿**;三条正控(P1、P2、B)与 6 条既有用例**两边都绿**,
即新门没有误伤既有行为。日志:`reviews/c1-fix-mutbak/OLD-CODE-c4dc4b928.log`。
(该日志尾部另有一条 `approval_rounds_document_id_fkey` 的 teardown 报错——旧码在四条负控里**真的建出了轮次**,
夹具从未登记那些 id,afterAll 删原单据时被 FK 挡住。这条报错本身就是「旧码确实放行」的附带实证,
也是该对照必须跑在一次性库里的原因。)

## L6. 四道钉 / 接线人口:未变,机械核验

本轮**零新增真库测试文件**(新用例进既有的 `approval-cancel-round-creation.db.test.ts`),
故 `plugin-tests.yml` 未改 ⇒ s6a `pluginTestsWorkflow` 钉不动 ⇒ 不占合并串行化窗口。

```
$ cd packages/core-backend && grep -c "approval-cancel-round" vitest.config.ts          → 7   （两点接线之一,未变）
$ grep -c "tests/integration/approval-cancel-round-.*\.db\.test\.ts \\\\" .github/workflows/plugin-tests.yml → 7   （之二,未变）
$ grep -l "EXPECT_DB === '1'" tests/integration/approval-cancel-round-*.db.test.ts | wc -l → 7   （哨兵普查)
$ node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs  → pass 1 fail 0  （s6a 钉）
$ node --test scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs                        → pass 60 fail 0 （考勤四钉 DML 分类）
$ npx vitest run tests/unit/approval-cancel-round-ci-wiring.test.ts \
                 tests/unit/approval-cancel-round-plugin-mirror-constant.test.ts                  → 2 files / 15 passed
```
```
$ node --test scripts/ops/t2-source-freeze-ci-wiring.test.mjs                                     → exit 0  （闭世界 ci-wiring 守卫族的代表)
$ CI=true npx vitest run tests/unit/approval-ci-coverage-enumeration.test.ts                       → 1 file / 351 passed （审批 CI 覆盖枚举)
```
W7-R10 分类钉:本轮**未新增任何文件**,故三个 root 清单的归属集合未变(按补充清单第 13 条,
该钉是**目录 root 清单**,用文件基名 grep 必然 0 命中,不能当判据)。
`tests/helpers/approval-schema-bootstrap.ts` 属于多条 lane 的 `paths` 触发集,本轮对它是**纯新增导出**,
因此别的 lane 会被重跑——已在 PR body 说明,不是隐患。

## L7. finding 2 的「夹具改回合法窗口」在 C-1 是空集(机械,不是「我没看到」)

finding-2 §4 的 9 个依赖超限输入的 `it()` 块全部在 `approval-cancel-round-redemption.db.test.ts`
的 **C-2 版本**里。对本分支的**修前树**(钉住 SHA,不是「我没看到」)机械普查:
```
$ git grep -c "setDocumentWindowDays" c4dc4b928 -- packages plugins apps
（0 hits —— 那个夹具 helper 是 C-2 新增的,C-1 侧根本不存在）

$ git grep -n "windowDays" c4dc4b928 -- 'packages/core-backend/tests/integration/approval-cancel-round-*'
c4dc4b928:…/approval-cancel-round-creation.db.test.ts:298    （类型标注)
c4dc4b928:…/approval-cancel-round-creation.db.test.ts:300    （键集断言 ['suite','windowDays'])
c4dc4b928:…/approval-cancel-round-creation.db.test.ts:302    （expect(...).toBe(90) —— 合法,正是 leave 上限)
c4dc4b928:…/approval-cancel-round-redemption.db.test.ts:26   （注释,回指上面那条断言)

$ git grep -n '"suite"' c4dc4b928 -- packages plugins apps
c4dc4b928:…/approval-cancel-round-creation.db.test.ts:461    （'{"suite":"forbidden"}' —— 合法枚举值)
```
⇒ **C-1 侧没有任何依赖超限窗口的夹具**,无需改；那 9 个块的修复属于 C-2,本轮不越界去改另一分支的文件。
同理,finding-2 §8 C-1 第四条(最终评估复用同一函数、遇域外按 `blocked` 收口)的**调用点在 C-2**;
本轮在 C-1 侧履行的是它的前提:**只有一份派生函数**,且它的 doc comment 逐字写明 C-2 必须
catch-then-`blocked`、不得静默 `expired`。

## L8. 本轮仍然 OPEN / 未做(如实列)

- **G3 半 B(仍在该组织单元)**:owner 裁决项,未实现。理由、NULL 语义建议、以及它为什么不是
  「对齐普通路径」而是合同新增,写在设计 MD §3.4;一条常驻正控(P2)把 `org_id IS NULL` 钉在明处。
- **把普通创建路径对齐到登录门**:`validateAndFreezeRequesterChoices` 的 company 基线仍只看
  `is_active`,比共享登录门窄。加宽它是对已上线端点 `POST /api/approvals` 的行为变更,owner 裁,未做。
  本轮的分歧**写在账上**,不包装成「已对齐」。
- **三个新错误码未登记进锁文 §14.3**:锁文是 owner 亲写件,本轮不改。登记在设计 MD §3.1 + PR body,
  标 implementer erratum 交 owner,与 `CANCEL_ROUND_REQUESTER_ONLY` 同族。
- **M3(锁外校验)NOT COVERED**,理由见 L4。
- **既有 `actor_id` 空串/NULL 过滤**(`createCancelRoundInstance` 自己的 `.filter(...)`)是先于本轮存在的
  「过滤后继续」,本轮**不修**,已在设计 MD §3.4 披露,并附全部 `action='approve'` 写入方普查
  (核心 4 处 + Bridge 1 处 + 考勤插件 3 处,`actor_id` 全部来自真实操作人;自动通过在创建期写的是
  `action:'created'` 而非 `'approve'`)。

## L9. required `test (20.x)` 的全量 vitest / real-DB 步骤清单 —— 逐字复现、同库连跑

> **本节是第二版。第一版有一个真实的普查错误,连同它的修正一起留在 L9.4,不删。**

### L9.0 窗口与谓词(两者都被修正过)

**窗口**:`.github/workflows/plugin-tests.yml` 的 required `test` job = 文件第 **174-1908** 行
(下一个 job `after-sales-integration:` 起于第 **1909** 行)。
第一版把上界写成 1735,**漏掉了 1736-1908 共 173 行**,其中含一个真实的真库 vitest 步骤
`:1757 Run attendance integration tests`(带 `DATABASE_URL` + `ATTENDANCE_TEST_DATABASE_URL`)。
成因写在 L9.4。

**谓词**:第一版只取「run 块里含 `vitest`」。任务书要的是「全量 vitest **与 real-DB** 步骤」——
一个由 `node --test` 或只靠 `DATABASE_URL` 驱动的真库步骤满足后者而不满足前者。第二版把谓词放宽成
**run 块含 `vitest`** 或 **含 `node --test`** 或 **step 的 `env` 带 `DATABASE_URL`** 或 **run 块里出现
`DATABASE_URL`**,并额外强制纳入 `:1746 Stop core backend`(把 `:1694` 起的后台服务收掉,否则它会留在
本机上跑)。

**谓词是闭的 —— 这次先证,不再假定。** 抽取器只从 step 级(10 空格缩进)读 `env:`;
若 `jobs.test` 在 `steps:` 之前挂了**job 级** `env:`(4 空格缩进),一个既无 step 级 env、run 文本里
又不出现 `DATABASE_URL` 的 step 仍可能是真库 step,那样「74 是全部」就会重蹈 L9.4(a) 的覆辙。
逐字核过:
```
$ sed -n '174,196p' .github/workflows/plugin-tests.yml
  test:
    runs-on: ubuntu-latest
    strategy: { fail-fast: false, matrix: { node-version: [18.x, 20.x] } }
    steps:
      - name: Checkout repository
      …
```
`test:` 从 `runs-on` 直接走到 `strategy` 再到 `steps:`,**没有 job 级 `env:` 块** ⇒ 谓词闭合,
step 级 env + run 文本两处已覆盖全部 `DATABASE_URL` 来源。

⇒ 人口从 22 个 step 变成 **74 个**。

**执行方式**:每个 step 的 run 块原样落成一个 `.sh`,用 `bash -e -o pipefail` 跑(与 GH Actions 的默认
shell 一致),env 逐条照抄(`RBAC_BYPASS` / `RBAC_TOKEN_TRUST` / `PRODUCT_MODE` /
`METASHEET_REAL_DB_TEST_STEP` / `MIGRATION_EXCLUDE` / `HOST` / `PORT` …),按 job 内原顺序连跑,
只把 `DATABASE_URL` / `ATTENDANCE_TEST_DATABASE_URL` 换成本地私有库。
**同一个处女库 `metasheet2_fix_c1_full2` 连跑到底**;库由我 `createdb` 出来后**空着**,
由清单里的 `:1057 Run DB migrations` 这一步自己按 CI 同一条 `MIGRATION_EXCLUDE` 迁移(不是我手工迁的)。
逐 step 日志:`reviews/c1-fix-mutbak/required-20x-v2/*.log`;step 清单与逐 step env:同目录 `MANIFEST.txt`。

**两条环境保真项,都是为了对上 `(20.x)` 这三个字**:
- **`CI=true`**:GH Actions runner 环境自带,vitest 读它来决定「跑一次就退」。第一次试跑没加,
  `Run core-backend tests` 卡在 `Tests failed. Watching for file changes...`(那次的附带发现见 L9.4(b))。
- **node 20.20.2**(nvm),不是本机默认的 25.9.0;`pnpm` 仍用装出这份 `node_modules` 的 10.33.0
  (nvm 的 node 20 自带 pnpm 12,会以 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` 拒跑;CI 用
  `pnpm/action-setup` 钉 10.16.1,同一个大版本族)。**这一条不是形式主义**:在 node 25 上
  `:343 Integration Guard required-wiring contract` 会红,红的原因是该 step 的计数包装器
  `grep -Eo 'tests [0-9]+$'` 匹配不到 node 25 spec reporter 带 ANSI 的 `ℹ tests 62` 行——
  62 个子测试其实全过。换成 node 20 后同一步绿(`integration-guard contract: 62 subtests ran (floor 62).`)。
  即「运行器版本 ≠ 生产版本」会制造假红,也能制造假绿,这次是前者。

### L9.1 结果

- **`TZ=UTC`**(第二版跑完之后才发现的第三条):GH Actions runner 是 UTC,本机是 CST(UTC+8)。
  `:1757` 的 `attendance-shift-swap.test.ts` 有两条断言做
  `new Date(<DATE 列>).toISOString().slice(0,10)` —— DATE 列按本地午夜解析,再转 UTC 就**整体倒退一天**
  (`expected '2049-06-13' to be '2049-06-14'`)。**判别控制**:同一棵树、同一个库、同一个 step,
  只加 `TZ=UTC` 重跑 ⇒ 见 L9.1 的 RERUN 行。这与本轮 diff 无关(日期计算不在本切片的任何改动路径上),
  是第三条「运行器环境 ≠ CI 环境」的坑,和 `CI=true`、node 20 同族。

| step(行号) | exit | 结果 |
|---|---|---|
| :195 Global History flag manifest contract | 0 | # tests 127；# fail 0 |
| :200 W0 exact-anchor L6/L7 CI wiring contract | 0 | # tests 36；# fail 0 |
| :206 Time Machine D2a archive-catalog CI wiring contract | 0 | # tests 6；# fail 0 |
| :211 Production maintenance SSH host-identity contract | 0 | # tests 4；# fail 0 |
| :219 DingTalk production-readiness inventory contract | 0 | # fail 0；# tests 4；# fail 0 |
| :236 K3 WISE rehearsal driver contract | 0 | # tests 17；# fail 0 |
| :273 Run K3-line ops suites | 0 | # tests 80；# fail 0 |
| :291 Directory deprovision ledger CI-wiring contract | 0 | # tests 3；# fail 0 |
| :298 Directory activation source-lock CI-wiring contract | 0 | # tests 3；# fail 0 |
| :343 Integration Guard required-wiring contract | 0 | # tests 62；# fail 0 |
| :369 PB4-2 archive-read-only CI wiring contract | 0 | # tests 3；# fail 0 |
| :375 PB4-3 cycle-detection CI wiring contract | 0 | # tests 3；# fail 0 |
| :381 PB4-4 reactivation CI wiring contract | 0 | # tests 3；# fail 0 |
| :387 B4 department-bindings CI wiring contract | 0 | # tests 3；# fail 0 |
| :392 B5-a routing-policy CI wiring contract | 0 | # tests 3；# fail 0 |
| :398 E-learning V0.1 content/assessment CI wiring contract | 0 | # tests 8；# fail 0 |
| :404 E-learning L0 jobs CI wiring contract | 0 | # tests 6；# fail 0 |
| :409 E-learning L2 batch assignment CI wiring contract | 0 | # tests 4；# fail 0 |
| :415 E-learning L2 assignment lifecycle CI wiring contract | 0 | # tests 4；# fail 0 |
| :420 E-learning L2 training-plan CI wiring contract | 0 | # tests 4；# fail 0 |
| :425 E-learning L2 plan-assignment CI wiring contract | 0 | # tests 4；# fail 0 |
| :430 E-learning L2 admin-scope ACL CI wiring contract | 0 | # tests 4；# fail 0 |
| :436 E-learning L2 notification-delivery CI wiring contract | 0 | # tests 4；# fail 0 |
| :443 E-learning L2 notification-worker CI wiring contract | 0 | # tests 6；# fail 0 |
| :450 E-learning V0.1 media CI wiring contract | 0 | # tests 15；# fail 0 |
| :457 E-learning V0.1 auth/tenant/RBAC CI wiring contract | 0 | # tests 3；# fail 0 |
| :462 B5-b routing-resolver CI wiring contract | 0 | # tests 3；# fail 0 |
| :466 B5-b fail-close CI wiring contract | 0 | # tests 3；# fail 0 |
| :470 B5-c routing-routes CI wiring contract | 0 | # tests 3；# fail 0 |
| :474 B6 equivalence CI wiring contract | 0 | # tests 3；# fail 0 |
| :478 B7 reconciliation CI wiring contract | 0 | # tests 3；# fail 0 |
| :482 B7 round-2 CI wiring contract | 0 | # tests 4；# fail 0 |
| :488 T1 org-transfer CI wiring contract | 0 | # tests 3；# fail 0 |
| :494 T2 source-freeze CI wiring contract | 0 | # tests 6；# fail 0 |
| :504 T2-Gate collision-mechanism CI wiring contract | 0 | # tests 82；# fail 0 |
| :509 Stock-preparation P4 repair CI wiring contract | 0 | # tests 3；# fail 0 |
| :514 Approval data-closure CI wiring contract | 0 | # tests 12；# fail 0 |
| :537 DingTalk staging worker-drain CI wiring contract | 0 | # tests 2；# fail 0 |
| :540 DingTalk staging immutable worker-drain gate | 0 | # tests 43；# fail 0 |
| :573 Attendance W4C-2 CI wiring contract | 0 | # tests 262；# fail 0 |
| :579 Attendance W4C-3c tooling cleanup contracts | 0 | # tests 19；# fail 0 |
| :589 Prod health probe monitor contract | 0 | # tests 8；# fail 0 |
| :602 DingTalk OAuth-stability ARG_MAX payload-handoff regression | 0 | # tests 5；# fail 0 |
| :661 Time Machine D2 archive real-DB fail-not-skip behavior | 0 | # tests 1；# fail 0 |
| :670 Run attendance calculation-group W1 contract | 0 | # tests 6；# fail 0 |
| :674 Run attendance legacy membership audit contract | 0 | # tests 2；# fail 0 |
| :762 Run attendance calculation-group timeline and legacy audit units | 0 | Test Files 2 passed (2) |
| :772 Run attendance work-date resolver W2 unit | 0 | Test Files 2 passed (2) |
| :783 Run attendance shift segments W3 unit | 0 | Test Files 1 passed (1) |
| :793 Run attendance W4C-4 calculation detail and diff contracts | 0 | Test Files 2 passed (2)；# tests 3；# fail 0 |
| :812 Run attendance W4C-0 Stage D §8.4 and W4C-4 §12.7 inventory collectors | 0 | # tests 60；# fail 0 |
| :828 Run attendance window-runner pipeline contract | 0 | # tests 153；# fail 0 |
| :870 Run scripts/ops/__tests__ node:test suites | 0 | # tests 48；# fail 0 |
| :892 Run rich-text longText XSS write-sanitizer canaries | 0 | Test Files 1 passed (1) |
| :899 Run F3 storage-integrity canaries | 0 | Test Files 3 passed (3) |
| :911 Run B3-07 approval-attachment unit canaries | 0 | Test Files 8 passed (8) |
| :929 Run elearning V0.1 unit canaries | 0 | Test Files 106 passed (106)；Test Files 1 passed (1) |
| :1057 Run DB migrations | 0 | （该 step 不打印 vitest 汇总行；exit 即判据） |
| :1107 Run elearning V0.1 content/assessment schema gate | 0 | Test Files 41 passed (41) |
| :1160 Run elearning V0.1 media quota real-DB gate | 0 | Test Files 2 passed (2) |
| :1177 Run elearning V0.1 auth/tenant/RBAC gate | 0 | Test Files 1 passed (1) |
| :1191 Run sealed-export S3 private-ingestion real-DB proof | 0 | Test Files 1 passed (1) |
| :1202 Run sealed-export S4 generation-kernel real-DB proof | 0 | Test Files 1 passed (1) |
| :1213 Run required after-sales install integration | 0 | Test Files 1 passed (1) |
| :1229 Run BPMN timer job write-and-claim safety | 0 | Test Files 1 passed (1) |
| :1249 Run BPMN startProcess poller-disabled zero-residue | 0 | Test Files 1 passed (1) |
| :1266 Run real-app assembly guard | 0 | Test Files 1 passed (1) |
| :1285 Run snapshot-protection E2E | 0 | Test Files 1 passed (1) |
| :1295 Run multitable real-DB integration | 1 | Test Files 1 failed | 261 passed (262) |
| :1568 Run approval real-DB integration | 0 | Test Files 84 passed (84) |
| :1675 Run comment-reaction keystone | 0 | Test Files 1 passed (1) |
| :1694 Start core backend | 0 | （该 step 不打印 vitest 汇总行；exit 即判据） |
| :1746 Stop core backend | 0 | （该 step 不打印 vitest 汇总行；exit 即判据） |
| :1757 Run attendance integration tests | 1 | Test Files 1 failed | 123 passed (124) |


**清单跑完后,对两条红各做的重跑 / 控制(同一棵树;命令与 step 原文逐字相同,只加环境变量):**

| 重跑 / 控制 | 库 | 加了什么 | 结果 |
|---|---|---|---|
| `:1757` attendance integration | 同一个连跑库 | `TZ=UTC` | `1 failed \| 123 passed (124)`;**`attendance-shift-swap.test.ts` 转绿**(12/12),红转移到 `attendance-plugin.test.ts` 的 3 条 |
| `attendance-shift-swap.test.ts` 单文件 | 同一个连跑库 | `TZ=UTC` | `Test Files 1 passed (1) / Tests 12 passed (12)` —— TZ 是那两条红的唯一原因 |
| `:1757` attendance integration | **另开的处女库**(按 CI 同一条 `MIGRATION_EXCLUDE` 迁移) | `TZ=UTC` | **`exit=0` / `Test Files 124 passed (124)` / `Tests 1784 passed (1784)`** —— 整步全绿 |
| `:1295` multitable | 同一个连跑库 | `TZ=UTC` | `1 failed \| 261 passed (262)`,**又换了一个受害者**,见下 |

**`:1757` 的红:两个不同成因,都不是本轮引入。**
- `attendance-shift-swap.test.ts` 两条 = **本机 CST vs CI UTC**(见 L9.0 第三条),`TZ=UTC` 即绿。
- `attendance-plugin.test.ts` 三条 = **共享库残留**。这正是本文件 **§A2** 已经机械隔离过的同一现象:
  该文件「在 virgin DB 是有效 oracle」,在一个被前面几十个真库 step 反复写过的库上跑第三轮不是有效 oracle。
  §A2 当时的做法(新建库 + 全量迁移 + 单跑该文件 ⇒ 166/166)被本轮照做了一次,结果见上表第三行。
- 两者都与本切片无关:本轮 diff 不含任何日期计算、不含任何考勤源文件
  (`git diff --name-only` 的 9 个文件见 L9.4(c))。

**`:1295` 的红:三次跑、三个不同的受害用例,两次是同一种传输层错误 —— 环境,不是回归。**

| 跑次 | 失败用例 | 失败形态 |
|---|---|---|
| 第一版(node 25) | `multitable-dashboard-chart-authz.test.ts > R4 …` | `expected 401 to be 403` |
| 第二版(node 20) | `multitable-restore-per-field-realdb.test.ts > an empty fieldIds array is a 400 …` | `Error: socket hang up` / `ECONNRESET` |
| 第二版 + `TZ=UTC` 重跑 | `multitable-history-audit-log-realdb.test.ts > cap holder: sees the grant + reveal entries …` | `Error: socket hang up` / `ECONNRESET` |

每次都是 `1 failed | 261 passed (262)`,但**每次换人**。一个静态的 diff 不可能产生随机受害者;
262 个文件在一个共享库上并行、共用同一个进程内 HTTP 服务时,本机会掉连接。
**判别控制**(第一版那次做过):同一棵树、同一个库单独重跑当次失败的那个文件 ⇒
`Test Files 1 passed (1) / Tests 10 passed (10)`。
归类为本机并行度下的 shared-DB / 传输层抖动,**没有去修**(多维表线,不在本切片范围)。

**一句话结论**:74 个 step 里 **72 个 exit 0**;剩下 2 个的每一条红都被单变量控制归因到环境
(TZ、共享库残留、本机并行下的掉连接),**没有一条落在本切片改动的路径上**;
本切片自己的 lane `:1568` 在连跑中 `84 files / 902 passed | 10 skipped`,零失败。

### L9.2 本切片的 7 条新用例在哪一步跑

`:1568 Run approval real-DB integration` —— 该 step 的 run-list 尾部含七个
`approval-cancel-round-*.db.test.ts`(`grep -c "tests/integration/approval-cancel-round-.*\.db\.test\.ts \\\\"`
→ **7**),本轮的 7 条新用例全部在这一步里被执行。它与其余 73 个 step 共用同一个库、同一次连跑。

### L9.3 被第一版漏掉、第二版补进来的那个真库步骤

`:1757 Run attendance integration tests`(env:`DATABASE_URL` + `ATTENDANCE_TEST_DATABASE_URL`;
它在 `:1694 Start core backend (background)` 之后运行,本轮把 `:1746 Stop core backend` 一并强制纳入,
以免后台服务留在本机)。这是第一版窗口截断造成的漏项,不是「跑过但没记」。

### L9.4 第一版 L9 的错误,和它是怎么被抓到的(撤回,不删)

**(a) 窗口截断 —— 我自己的普查错误,已撤回。**
第一版用
```
$ awk 'NR>=174' .github/workflows/plugin-tests.yml | grep -n "^  [a-z0-9_-]*:$"
1:  test:
1736:  after-sales-integration:
```
然后把 `1736` 当成**文件行号**写进抽取器的上界。它其实是 **awk 输出内的相对行号**——
awk 从文件第 174 行开始输出,所以相对第 1736 行 = 文件第 **1909** 行。
于是 `test` job 的 **1736-1908** 这 173 行从未被扫过,而第一版 L9 却写着
「抽出**每一个** run 块里含 `vitest` 的 step」——那是一句当时没有证据支撑的绝对断言。
被漏掉的真东西:`:1757 Run attendance integration tests`(真库 vitest,带两个 DB env)。
**判据**:`sed -n '1909p'` 落在 `  after-sales-integration:` 上;
`awk 'NR>=1736 && NR<=1908' … | grep -E "^      - name:|vitest|DATABASE_URL"` 直接把那个 step 打出来。
第二版把窗口改成 174-1908、谓词放宽,重跑**整份清单**(不是只补跑那一个 step——
「同库连跑」的意义就在于整份清单在同一个库上按序跑完)。

**(b) 第一次试跑(未设 `CI=true`)时 `:842` 报的那条红,是一条先于本轮存在的跨套件竞态。**
报错是
`tests/unit/role-assignment-boundary.test.ts > user_roles has exactly one writer > every writer of
the table is the boundary module and nothing else` →
`ENOENT: no such file or directory, open '…/src/attendance/zz-nit3-untracked-scratch.ts'`
—— **不是集合不等,是读文件时文件没了**。机械定位:
- `tests/unit/role-assignment-boundary.test.ts:840-875`:`collectSweptFiles()` 在 describe 收集期做
  **裸文件系统遍历**(`fs.readdirSync`),随后用例再逐个 `fs.readFileSync`。
- `src/attendance/__tests__/w4c3a-rollout-control-inventory.test.ts:145-152`(用例
  "NIT-3: an untracked scratch file …"):在**同一棵树里** `fs.writeFileSync` 出
  `packages/core-backend/src/attendance/zz-nit3-untracked-scratch.ts`,`finally` 里 `rmSync` 删掉。
- 两者在 `pool: 'forks'` 下并行:遍历时文件在、读取时已删 ⇒ ENOENT。
- 前一个文件自己的 POSITIVE CONTROL 注释就写着「读到内存里改,**不往树上写**,那会 race sibling
  suites under `pool: 'forks'`」——兄弟文件的 NIT-3 用例正好破了这条约定。
- 加 `CI=true` 的干净重跑与第二版全量跑里,`:842` 均 exit 0。
⇒ 归类为**先于本轮存在的跨套件竞态**(本轮 diff 不向 `SWEEP_ROOTS` 增删任何文件,且失败形态是 ENOENT
而非谓词不等)。**没有去修**(角色边界线,不在本切片范围),作为一条新发现如实登记,交对应线裁决。

**(c) 第一版跑里 `:1295` multitable 的那条红(`multitable-dashboard-chart-authz.test.ts > R4 …`
`expected 401 to be 403`)**,归因见下,同样不是本轮引入:
- 我的 diff 共 9 个文件(`git diff --name-only`):2 个 MD、1 个服务、1 个测试 helper、
  5 个 `approval-cancel-round-*.db.test.ts`;改动全在 `createCancelRoundInstance` 及其两个新 helper 内;
  **零** multitable 源文件、**零**路由文件、**零** auth 源文件被修改(对 `../auth/user-activation`
  只是新增一条 `import` 去**读用**那个共享门,该模块本身一字未改)。
- 该 step 的 run-list 里**没有任何** `approval-cancel-round-*` 文件:`grep -c` → **0**;
  我改的 5 个夹具文件只在 `:1568` 跑,而 `:1568` 在 `:1295` **之后**。
- 我对 `tests/helpers/approval-schema-bootstrap.ts` 的改动是**纯新增一个导出函数**,
  `APPROVAL_SCHEMA_BOOTSTRAP_VERSION` 未 bump,对任何其他套件零行为差。
- **判别控制**:同一棵树、同一个库单独重跑该文件 ⇒ `Test Files 1 passed (1) / Tests 10 passed (10)`。
⇒ 262 个文件在一个共享库上并行跑时的跨套件干扰(本仓已知的 shared-DB fixture collision 家族)。
**没有去修**(多维表线,不在本切片范围)。

### L9.5 另外两条 required、但不属于「vitest / real-DB」人口的步骤,也跑了

```
$ CI=true pnpm lint        → exit 0      （plugin-tests.yml :832;node 25 与 node 20 各跑一次,均 0）
$ CI=true pnpm type-check  → exit 0      （plugin-tests.yml :837;同上)
```

## L10. 全量复跑之后落的唯一一处改动:错误文案(以及它自己的重验)

`CANCEL_ROUND_SEAT_INELIGIBLE` 的 message 原写「ask an administrator to **restore or replace** the
account」。**`replace` 是系统不提供的补救**:§14.3 #12/#13 对撤销轮直接拒绝
`bulkReassignApprovals` 与 `applyApprovalDepartureTransfer`,§14.2 也拒 `transfer`,
本切片更没有任何 HTTP 入口——面向管理员的提示不得承诺一个合同禁止的动作,
而且设计 MD §3.4 自己写的正是「替换不可能」,两处互相打架。改成只说 `restore`,
并在代码里把「为什么不写 replace」写成注释。

这处改动是在 L9 的全量复跑**之后**落的,所以它没有被那次连跑覆盖。**为它单独补的重验**
(改动只是一个字符串字面量,零断言读它):
```
$ npx tsc --noEmit                                                        → 无输出,EXIT 0
$ CI=true TZ=UTC DATABASE_URL=…/metasheet2_fix_c1_v2 EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    $(ls tests/integration/approval-cancel-round-*.db.test.ts)
 Test Files  7 passed (7)
      Tests  55 passed (55)          （另开的处女库 metasheet2_fix_c1_v2,全量迁移）
$ CI=true pnpm lint        (node 20) → exit 0
$ CI=true pnpm type-check  (node 20) → exit 0
```
如实标注,覆盖边界对称地写清楚:**`:1568` 那一步的 84 文件 / 902 用例、以及 L4 的五条 mutation
与 L5 的旧码对照,全部是在改这个字符串之前、对 `a77d848c0` 的服务端文件跑的**。
本行为差为零(改的只是一个字符串字面量加一段注释;没有任何断言读该 message 的文本,
N1 只断言它**不含**人名 id;M4 的锚点 `{ ineligibleCount,` 也一字未动),
但那些证据的覆盖范围仍然只到改动之前,这点不含糊 —— 上面这组重验就是为这段边界补的。

## L11. 清理

- 私有库全部 `dropdb`:`metasheet2_fix_c1`、`metasheet2_fix_c1_old`、`metasheet2_fix_c1_full`、
  `metasheet2_fix_c1_full2`、`metasheet2_fix_c1_att`、`metasheet2_fix_c1_v2`。
  未对任何共享 / staging / 生产库应用迁移。
- mutation 备份与逐条日志保留在 `reviews/c1-fix-mutbak/`(不是仓内文件)。
- 未合并、未 undraft、未开 PR、未动 PR 状态、未动 `origin/main`、未改锁文。
- `git stash` 全程未用(硬规矩);mutation 一律 `cp` 备份 → 改 → 单跑 → `cp` 还原 → `cmp`。

## L12. 保活 rebase 到 main 868c8d2b2

`origin/main` 在本轮开工前已合并 #5849(timemachine manual-capture),把分支起点从
`89f1ecdee2c3b70205a318074824c834bc6a5c7e` 推进到 `868c8d2b26424fcaa8405661a6999abb17ec6d93`
(120 个新提交,221 文件,+32982/-1322)。为不让 Draft PR #5851 落后过久,本节做一次纯保活
rebase(不改任何业务逻辑),把本分支的 57 个提交(旧 head `ba8a0133d`)重放到该新基点之上。

### 配方与结果

```
$ git fetch origin
$ git rebase origin/main
```

- 57 个提交里,只有 1 个在应用时产生真实内容冲突:`ci(approval): promote cancel-round
  real-DB suites into required test (20.x)`(旧 SHA `e394c9e9c`,rebase 后 `e7d863d65`)——
  它自己就是"把 plugin-tests.yml 里 approval-real-db-integration 步骤的 run-list 与
  s6a pin 的 evidenceFiles.pluginTestsWorkflow 一起改"的提交,而 main 侧的 120 个提交里
  也有改 `.github/workflows/plugin-tests.yml`(新增 timemachine 相关必需步骤)的提交,
  两侧都动了同一个文件、同一个被冻结摘要覆盖的 evidenceFiles 键,冲突精确落在
  `s6a-package-provenance-pins.json` 的 `pluginTestsWorkflow` 一行(其余键零冲突,自动合并)。
  `.github/workflows/plugin-tests.yml` 本身、`packages/core-backend/vitest.config.ts` 的
  exclude 块、新增的 `approval-cancel-round-ci-wiring.test.ts`、`approval-realdb-cancel-round.yml`
  的删除,均由 git 自动合并干净,未产生冲突标记。
- 其余 56 个提交(K1-K8、Part L 的 L0-L11 等文档/测试提交)与 main 新增的 120 个提交路径不重叠,
  全部无冲突自动重放。
- 冲突解决:先任取一侧(HEAD 侧的旧值)消解冲突标记,`git add`,`git rebase --continue`
  完成整条 rebase;随后按 L12.1 机械重算该键的正确值并单独提交(不属于 rebase 冲突消解本身,
  是 rebase 完成后的必需收尾步骤)。
- 全仓 grep 冲突标记(排除历史文档里作为**引用文本**出现的 `<<<<<<<`/`=======`/`>>>>>>>`,
  那些是 `claudedocs/`、`docs/merge-reports-2025-10/`、`packages/claudedocs/` 里 2025 年旧
  merge 报告的字面内容,经 `git diff --stat origin/main..HEAD -- <这些路径>` 确认本轮零改动
  ——即它们既不是本次 rebase 引入的,也不是残留冲突标记):
  `git grep -n "^<<<<<<<\|^=======$\|^>>>>>>>"` 命中的全部是这些历史文档,零命中在实际代码/配置文件。

### patch-id 交集核验

```
$ git log -p --no-merges origin/main..HEAD  | git patch-id --stable | sort > ours.txt   # 57 条
$ git log -p --no-merges <旧merge-base>..origin/main | git patch-id --stable | sort > main.txt  # 115 条
$ comm -12 <(awk '{print $1}' ours.txt) <(awk '{print $1}' main.txt) | wc -l
0
```

57 个本分支提交与 main 侧 115 个提交的 patch-id 交集为 **0**——本分支没有任何提交与 main
上已存在的改动重复(即 rebase 没有把 main 已经吸收的内容再摞一遍)。

### zzzz 迁移排序

本分支自带 3 件迁移(`packages/core-backend/src/db/migrations/`):
`zzzz20260918090000_create_approval_rounds.ts`、
`zzzz20260918100000_seed_approval_cancel_round_published_definition.ts`、
`zzzz20260918110000_add_attendance_requests_approval_workflow_key.ts`。
main 新增 5 件:`…120000_add_recovery_archive_section_checkpoints.ts`、
`…130000_create_recovery_archive_prepared_captures.ts`、
`…140000_create_recovery_archive_manual_requests.ts`、
`…20260919120000_add_attachment_blob_purge_claim.ts`、
`…20260919130000_extend_archive_nonce_object_identity.ts`。
按文件名时间戳排序,本分支的三件(`090000`/`100000`/`110000`,同为 0918)严格排在 main 五件
(`120000` 起,0918 与 0919)之前,时间戳零碰撞、零需要人工改名重排——迁移顺序天然正确。

### s6a pin 机械重算

冲突消解时先任取一侧(留下占位值),rebase 完成后按 `computePackageProvenancePinSet(repoRoot)`
(`plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs`)
机械重算整份 pin 集合,与活树 diff:

```
$ node -e "…computePackageProvenancePinSet(process.cwd())…" > /tmp/computed-pins.json
$ diff <(json.tool 活文件) <(json.tool computed-pins.json)
90c90
<     "pluginTestsWorkflow": "b048a17f…"   # 冲突消解时任取的占位值
---
>     "pluginTestsWorkflow": "ee9e4f49…"   # 机械重算的正确值
```

只有这一个键差,与提交 e394c9e9c 自己的记录("recomputed … confirmed to be the only key that
moved")一致——因为 rebase 后 `plugin-tests.yml` 的最终字节内容(main 的 timemachine 步骤
+ 本分支的 approval-real-db-integration 促升,两者都在文件里)与 e394c9e9c 提交时的字节内容
不同,digest 必然重算。写回该键后 diff 为空(exit 0)。新提交 `da2688a59`
(`chore(approval): recompute s6a pluginTestsWorkflow pin after main rebase`)记录此收尾,
不与冲突消解本身的提交合并。

守卫复跑(`plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs`,
其 `assert.deepEqual(live.evidenceFiles, frozen.evidenceFiles)` 覆盖包括 `pluginTestsWorkflow`
在内的全部 evidenceFiles 键,非部分核验):

```
$ node --test __tests__/sealed-export-package-provenance.test.cjs
✔ sealed-export-package-provenance.test.cjs
tests 1  pass 1  fail 0
```

MATCH。

### 处女私有库全量重验(`metasheet2_c1_rb`)

```
$ psql …/postgres -c "DROP DATABASE IF EXISTS metasheet2_c1_rb;"
$ psql …/postgres -c "CREATE DATABASE metasheet2_c1_rb OWNER metasheet;"
$ DATABASE_URL=postgresql://metasheet:metasheet123@localhost:5432/metasheet2_c1_rb \
    pnpm exec tsx src/db/migrate.ts
```

全部迁移(含本分支 3 件 + main 新增 5 件,共 98 条 `zzzz*` 迁移里最新的部分)执行成功,
零报错、零跳过。

```
$ DATABASE_URL=…/metasheet2_c1_rb EXPECT_DB=1 \
    pnpm exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-lock-order-census.db.test.ts \
    tests/integration/approval-cancel-round-creation.db.test.ts \
    tests/integration/approval-cancel-round-redemption.db.test.ts \
    tests/integration/approval-cancel-round-seat-guards.db.test.ts \
    tests/integration/approval-cancel-round-attendance-fk-migration.db.test.ts \
    tests/integration/approval-cancel-round-outlet-guards.db.test.ts \
    tests/integration/approval-cancel-round-node-timeout-effect.db.test.ts
 Test Files  7 passed (7)
      Tests  55 passed (55)

$ pnpm exec tsc --noEmit
(无输出,exit 0)

$ pnpm exec vitest run tests/unit/approval-cancel-round-ci-wiring.test.ts
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

全绿:7 个 real-DB 文件 / 55 用例(处女库,`metasheet2_c1_rb`,`main` 新迁移与本分支迁移
共存后的最终 schema)、`tsc --noEmit` 干净、`approval-cancel-round-ci-wiring.test.ts` 6/6
(两点接线 / run-list 去重 / 单例排他 / 独立 lane 已删除,均未因 rebase 走样)、
s6a 守卫 MATCH。私有库随后 `dropdb metasheet2_c1_rb`,未应用到任何共享库。

### 收尾

- `git push --force-with-lease` 一次(rebase 后允许);此后按硬规矩转普通 push。
- 未合并、未 undraft、未开/动 PR 状态、未动 `origin/main`、未应用迁移到共享/staging/生产库、
  未改设计锁文。
- 新 head:`da2688a591fcb929f72daac75cf56b3b906004c6`(57 个重放提交 + 1 个 pin 重算提交,
  共 58 个提交领先 `origin/main`)。

---

# Part M — 第 6 轮门审修复(2026-09-19)

门审报告:`reviews/impl-gate-C-slice1-round6-20260919.md`(NEEDS-FIX,1 P1 / 1 P2 / 2 P3)。
被审 head `ba8a0133d`;本轮起点 `6013343eb`(L12 的保活 rebase 之后,内容同源、SHA 不同)。
处女私有库 `metasheet2_fix_c1_r7`,结束 `dropdb`。工具链 node 20.20.2 + pnpm 10.33.0(shim 目录),
`CI=true`、`TZ=UTC` 全程。**未改锁文;未合并;未 undraft;未开/未动 PR 状态;未动 `origin/main`;
未对任何共享/staging/生产库应用迁移;全程未用 `git stash` / `git checkout -- <path>` / `git reset --hard`。**

## M0. 逐条处置

| 门审编号 | 级别 | 处置 |
|---|---|---|
| G6-1 | P1 | **已修** —— 席位推导丢弃 `system:` 哨兵;滤空后专用码 + 三条新验收 + 旧码对照 + 三条 mutation |
| G6-2 | P2 | **已撤回并重做** —— 设计 MD §3.4 的绝对断言整句撤回,普查按「调用点闭世界」重做,全分支零残留 |
| G6-3 | P3 | **已改口** —— `twoApproverNodeGraph` 注释 + P1 用例标题改成「纵深」,与 L4 的自我纠正对齐 |
| G6-4 | P3 | **已变成数据** —— `activation_invalid` 保留,新增一条读 `pg_constraint` / `information_schema` 的实测用例 |

## M1. G6-1 —— 我先在本 head 上复现,再修

门审是在 `ba8a0133d` 上复现的,我**不继承**它的观测。用一个临时探针
(`zzprobe-r7-autoapproval.db.test.ts`,只用来取证,已删、未提交、未接线)在 `6013343eb` 上跑真实 HTTP:

```
【形状 A:唯一审批人 = 提交人本人,mergeWithRequester:true(全自动)】
[PROBE] instance status            = approved
[PROBE] records                    = [{"action":"approve","actor_id":"system:auto-approval"},
                                      {"action":"created","actor_id":"pr-req-…"}]
[PROBE] cancel-round seat query    = [{"actor_id":"system:auto-approval"}]
[PROBE] createCancelRoundInstance -> THREW 409 CANCEL_ROUND_SEAT_INELIGIBLE
        details={"ineligibleCount":1,"reasons":["not_found"]}

【形状 B:自动通过节点 + 一名真人审批节点(真人真实 approve)】
[PROBE B] records right after create = [{"action":"approve","actor_id":"system:auto-approval"},
                                        {"action":"created","actor_id":"pr2-req-…"}]
[PROBE B] db status                  = approved
[PROBE B] cancel-round seat query    = [{"actor_id":"pr2-hum-…"},{"actor_id":"system:auto-approval"}]
[PROBE B] createCancelRoundInstance -> THREW 409 CANCEL_ROUND_SEAT_INELIGIBLE
        details={"ineligibleCount":1,"reasons":["not_found"]}
```

形状 B 是这条 P1 的要害:**单据有一名完全合格的真人审批人,照样永久发不起撤销轮**,
而错误文案让管理员去「restore」一个不存在也不该存在的账号。两条都在本 head 上确认,不是转述。

### 修法(§5.6 的形状,但第 2 条按实测改了)

1. `ApprovalAssigneeResolver.ts` 的 `isSystemSentinelActor` 由模块私有改为 **exported**;
   `ApprovalProductService.ts` import 它,用在撤销轮席位 `.filter(...)` 里。**复用,不另写 `startsWith`**。
   同时把兄弟席位推导 `loadPriorNodeApproverDeciders` 里那行行内 `id.startsWith('system:')` 换成同一个
   import —— 行为逐字不变,但「非用户命名空间」从此只有一个定义,不是三份会漂的拷贝。
   这处顺带改动**在设计 MD §8 点名登记**,不留作静默改动。
2. **门审 §5.6 第 2 条说「丢弃之后走 `initialAssignmentCount === 0` 的 fail-closed 背板」——
   这条我实测下来是错的,按实测改。** 席位为空时 `ApprovalGraphExecutor.resolveInitialState`
   在 `resolveFromNode` 的 `assignments.length === 0` 分支**直接抛 `400 APPROVAL_ASSIGNEE_EMPTY`**
   (专用定义故意不带 `emptyAssigneePolicy`),**根本到不了** `initialAssignmentCount` 的判断。
   照原话实现的话,全自动通过的单据会拿到一个**裸 400 通用码**,违反补充清单第 4 条。
   所以改成**显式前置检查**:滤空 ⇒ 409 `CANCEL_ROUND_NO_ELIGIBLE_APPROVER`,
   `details = { reason: 'no_human_approver' }`(类别,不是人)。
   **复用既有错误码,不铸第五个码** —— 依据是锁 §14.1「席位 = 原单的原审批人(N ≥ 1)」(lock:335)
   与判据 I″「至少一个活动席位」(lock:337),零席位的合同答案本来就是这个码。
   那条背板保留,但它的注释同步纠正:它真正守的是 `initial.status !== 'pending'` / 节点键不对,
   **不是**「审批轨迹为空」—— 原注释里那半句是错的,已在源码就地标成 round-6 勘误。
3. **`details` 的不对称是有理由的,写明了**:新前置检查带 `{ reason: 'no_human_approver' }`(可构造、有用例),
   背板**不带** —— 给一个没有任何用例能构造出来的分支加断言载荷,正是本仓禁止的「编造断言」。

### `not_found` 的重新定义(门审 §5.6 第 4 条)

**保留,但把它的人口写成数据,并且重新在本 head 上普查过**(门审是在 `ba8a0133d` 上跑的):

```
syntax 1  grep -rn  "DELETE FROM users"                packages/*/src plugins apps/*/src scripts  → 17(13 个文件,全在 scripts/ops/)
          同一条 grep 只打运行时目录 packages/*/src plugins apps/*/src                            → 0
syntax 2  grep -rnE "deleteFrom\(\s*['\"`]users['\"`]\s*\)"  packages plugins apps scripts        → 0
syntax 3  grep -rniE "delete[[:space:]]+from[[:space:]]+users\b"  同 syntax 1 路径                → 17(与 syntax 1 一致)
正控      同一条 grep 打 tests 树                                                                  → 294(证明 grep 本身有效)
```

⇒ 运行时不删用户(离职走 `is_active = FALSE`,`directory/deprovision-ledger.ts`);
丢弃哨兵之后,`not_found` 今天的含义**只剩**「一个被声称的真人、目录行不在了」,
由 N2(删 `users` 行)与 N4(证明丢弃没把真人一起吞掉)两条用例共同钉住。
这段话现在写在 `CANCEL_ROUND_SEAT_INELIGIBILITY_REASONS` 常量旁边,逐成员标注可达性与对应用例。

## M2. 新增验收(3 条,全部进既有的 `approval-cancel-round-creation.db.test.ts`)

**本轮零新增真库测试文件** ⇒ 两点接线 / 哨兵 / `plugin-tests.yml` 清单 / ci-wiring 人口 /
ci-realdb-step-contract / s6a 钉**全部不动**(M5 机械核验)。

| 用例 | 断言 |
|---|---|
| **正控 P3** 自动通过 + 一名合格真人 | 201;席位**恰为那一名真人**(数量 = 真人数 1,**不是** approve 行数 2);`approval_assignments` 与 `requester_snapshot` 里都搜不到 `system:auto-approval`;轮次 1 行 `pending` |
| **负控 N3** 全自动通过(零真人 approve 行) | 409 `CANCEL_ROUND_NO_ELIGIBLE_APPROVER`,`details` 逐字 `{reason:'no_human_approver'}`;**正向否定**三件:不是 `SEAT_INELIGIBLE`、文案不含 `restore`、不是 400 / `APPROVAL_ASSIGNEE_EMPTY`;values-free;三表零行 |
| **负控 N4** 自动通过 + 一名**已停用**真人 | 仍 409 `CANCEL_ROUND_SEAT_INELIGIBLE` / `reasons:['inactive']`(**不是** `not_found`、**不是** `NO_ELIGIBLE_APPROVER`、**不是**半个会签名单);零行;**同单据判别控制**:恢复 `is_active` 后同一调用 201 且席位恰为那一人 |

三条夹具都在 `autoApprovedFixture` 里**先断言哨兵确实在席位查询结果里**
(`expect(actorIds).toContain('system:auto-approval')` + 全集逐字相等)——
如果将来自动通过不再写 `action='approve'`,这三条会立刻变成显眼的红,而不是悄悄空转绿。

## M3. 旧实现对照(证明是 fixed,不是 never-broken)

`cp` 备份现源码 → `git show 6013343eb:<两个文件>` 覆盖 → 用**本轮新用例**跑同一个库 → `cp` 还原 → `cmp` identical。

```
旧实现:  3 failed | 14 passed (17)   ← 红的正是 P3 / N3 / N4
新实现:  17 passed (17)
```

## M4. Mutation 台账(cp 备份 → 改 → 单独跑 → cp 还原 → cmp identical)

备份 `/tmp/fix-c1-r7/mutbak/APS.FIXED.backup`、`AAR.FIXED.backup`;每条跑完 `cmp` **identical**。

| Mutation | 改了什么 | 结果 | 变红的用例 | 红的**原因**核对 |
|---|---|---|---|---|
| **R7-M1** | 去掉席位 `.filter` 里的 `!isSystemSentinelActor(id)` | 3 failed / 14 passed | P3、N3、N4 | 逐字 `409 CANCEL_ROUND_SEAT_INELIGIBLE` / `reasons:['not_found']` —— **就是 G6-1 这个缺陷本身**,不是偶然红 |
| **R7-M2** | 删掉滤空后的显式前置检查 | 1 failed / 16 passed | **只有 N3** | `expected 400 to be 409` —— 正是「没有前置检查就退化成执行器的裸 400」,**证明 409 由我的检查产出,不是执行器** |
| **R7-M3** | 把 §2-G3 阻断换成「过滤掉不合格者再继续,然后靠新的滤空检查回答」 | 3 failed / 14 passed | N1、N2、**N4** | N4 收到 `CANCEL_ROUND_NO_ELIGIBLE_APPROVER` 而不是 `SEAT_INELIGIBLE` —— **证明新加的滤空检查没有变成 filter-and-continue 的洗白通道** |
| **R7-M4a/b/c**(schema,打在私有库上) | a 删 CHECK / b 给 CHECK 加第三个值 / c 去掉 NOT NULL | 各 1 failed | G6-4 那条 | a `must exist: expected +0 to be 1`;b `must allow EXACTLY these two values`;c `expected 'YES' to be 'NO'` —— 三条腿各自独立承重 |

R7-M1 与 R7-M2 的判别力**是分开的**:M1 下 N1 仍绿(它自己的谓词没被碰),M2 下只有 N3 红。
两条各打中自己那一条轴,没有混淆。schema mutation 跑完已把 CHECK 与 NOT NULL 逐字恢复并复核
(`pg_get_constraintdef` 回到 `CHECK ((activation_status = ANY (ARRAY['pending_activation'::text, 'activated'::text])))`,
`is_nullable = NO`)。

**仍然 NOT COVERED,如实写明**:`FOR UPDATE` 之外的竞态(理由同 L4 末段,不用顺序论证冒充竞态证据);
把「丢弃哨兵」挪到事务外(同一条不可证伪性)。

## M5. G6-2 —— 普查重做(按调用点闭世界,不按字面量)

字面量 grep 是「×4」的产地,所以**不再用第二条字面量补救**,改成闭世界枚举:

| 闭世界方式 | 人口 | 能写 `approve` 的 |
|---|---|---|
| (i) 全部 `insertApprovalRecord(...)` 调用点(该 helper 是 `ApprovalProductService.ts` 的 `private`,全仓其它文件 0 调用点),逐个读它传的 `action` **表达式** | 28 | **5** |
| (ii) 全部裸 SQL `INSERT INTO approval_records`(大小写/空白容忍),分布在 `routes/approvals.ts` ×3、`approval-comment-service.ts`、`ApprovalBridgeService.ts`、`ApprovalProductService.ts`(helper 自己那条)、`plugin-attendance/index.cjs` ×3 | 9 | **3** |
| (iii) kysely `insertInto('approval_records')` | 0 | 0 |

> **锚点纪律(本轮新增)**:下面所有 `file:line` 都是在**已提交的 `5da9e5310`** 上机械重导的
> (脚本枚举 `insertApprovalRecord(` 调用点 + 读其 `action` 表达式,不是手抄)。
> 设计 MD §8 的旧锚点在本轮之前就已漂了 200 多行(`:4242` 的再导出实际在 `:4477`,
> `:8308-8542` 的创建方法实际开在 `:8543`),本轮的注释插入又加了几十行 —— 已全部重导并改成
> **符号为准、行号为辅**。核对时请按符号找,不要按行号找。

五个 helper 侧写入方 —— **五个,不是四个**:`:11483` / `:11521` / `:11664` / `:11863` 都是字面
`action: 'approve'` + `actorId: actor.userId`(真人),而 **`:12864`(`insertAutoApprovalEvents`)是
`action: skipped ? 'sign' : 'approve'` + `actorId: actorIdForAutoApprovalEvent(event)`** ——
三元表达式里没有那个字面量,字面量 grep 看不见它,而它是**全仓唯一产出合成 actor 的写入方**。
三个裸 SQL 侧写入方(`routes/approvals.ts:2966`、`ApprovalBridgeService.ts:1148`、
`plugin-attendance/index.cjs:37824`)都传真人。

**「×4」是怎么造出来的**:`grep -n "action: 'approve'"` 在该文件上 6 行,减去 `:11239`/`:11921`
两处 `buildCompletionEvent` 参数(实例级完成事件,不是审计行)= 4。算术自洽,且对 `:12864` 完全盲。

**顺带更正门审也没点到的一处**:被撤回那句引的三个 `plugin-attendance` 锚点里,
有两个在本 head 上根本不是 `approve` 写入方(是 `'revoke'` 与 `'reject'`)。

**如实披露的近失**:helper 自己那条 INSERT(`ApprovalProductService.ts:13143`)回落
`record.actorId || 'system'` —— **裸 `'system'`,不在 `system:` 命名空间里**,
`isSystemSentinelActor` 不会丢弃它。今天从任何 approve 写入方都不可达(五个都传非空 id),
两处传字面 `'system'` 的写 `action: 'sign'`(`:11877`/`:11896`),席位查询不读。
写在这里,是为了让将来「把 `'sign'` 改成 `'approve'`」或「传空 actor」被认出来是 G6-1 复发,而不是新谜案。

### 撤回传播 —— 全分支机械自扫,零残留

自扫是在**全分支**(`--exclude-dir=node_modules --exclude-dir=.git`)上跑的。
**计数在这里没有意义,因为这一节自己就会被自己的 grep 命中**(我第一版就是这么写的,数字当场对不上,
撤下改成按命中点分类)。分类如下,逐条给出它为什么不是「仍在正面主张」:

| 词条 | 命中点 | 性质 |
|---|---|---|
| `no synthetic-actor seat` | 设计 MD §3.4 撤回块内的引文 | 撤回对被撤句的原样引用 |
| | 本节下方 M6 的 PR-body 建议文本内的引文 | 同上 |
| | 本节这张表自己 | 自指 |
| `un-cancellable on that account` | 设计 MD §3.4 撤回块内的引文 / 本表 | 同上 |
| `known to be reachable` | 设计 MD §3.4 撤回块内的引文 / M6 引文 / 本表 | 同上 |
| `anti-filter oracle` | `approval-cancel-round-creation.db.test.ts` 的 G6-3 改口注释内的引文 / 本表 | 改口对旧措辞的原样引用 |
| `35197` / `35577` / `37793` | 设计 MD §3.4 撤回块内的引文 / 本表 | 撤回引用 |
| | `docs/attendance-production-go-no-go-20260211.md`、`docs/development/attendance-comprehensive-hours-pr0-pr5-closeout-20260523.md` 各若干 | **无关**:GitHub Actions run id 的数字巧合,不是审批锚点 |

⇒ **零处仍在正面主张这句话**;全部残留都是撤回/纠正文本对旧措辞的原样引用,
这正是撤回该有的形态(留档不删,免得下一轮看不懂改了什么)。

**PR #5851 body:只读核查过,body 里没有这句绝对断言的任何形式**
(`gh pr view 5851 --json body` 逐条 grep `synthetic-actor` / `×4` / `un-cancellable` / `35197` /
`anti-filter` / `census|writer|reachab|synthetic|auto-approv|seat`,只命中一条与本条无关的接线摘要行)。
⇒ 本轮**没有需要传播到 PR body 的撤回**。body 仍应在下次更新时补一行第 6 轮说明,文本见 M6。
**本轮未编辑 PR body,未动 PR 任何状态。**

## M6. 供下次更新 PR body 时直接用的一段(不在本轮编辑)

> 第 6 轮门审(`impl-gate-C-slice1-round6-20260919.md`,NEEDS-FIX 1 P1/1 P2/2 P3)已全部处置:
> P1 G6-1 —— 撤销轮席位推导此前不丢弃 `system:` 哨兵,任何走过一次「提交人本人自动通过」的已批准单据
> 永久发不起撤销轮(且提示管理员恢复一个不存在的账号);已复用既有 `isSystemSentinelActor` 丢弃哨兵,
> 滤空后 409 `CANCEL_ROUND_NO_ELIGIBLE_APPROVER` / `reason: no_human_approver`,新增 3 条真库验收
> (旧码下全红)+ 3 条源码 mutation + 3 条 schema mutation。
> P2 G6-2 —— 设计 MD §3.4 那句「no synthetic-actor seat is known to be reachable today」**整句撤回**,
> 普查改为按 `insertApprovalRecord` 调用点(28)+ 裸 SQL(9)+ kysely(0)闭世界重做,approve 写入方
> 5 个而非 4 个。P3 G6-3/G6-4 —— 注释改口;`activation_invalid` 的豁免理由变成读 `pg_constraint` /
> `information_schema` 的实测断言。

## M7. 接线 / 哨兵 / 清单 / s6a —— 人口未变,机械核验

```
vitest.config.ts 的 approval-cancel-round 命中                      → 7
plugin-tests.yml 的 approval-cancel-round 命中                       → 8 = 7 条 run-list 行 + 1 行注释(:1579)
带 EXPECT_DB 哨兵的 cancel-round 套件                                 → 7
磁盘上的 approval-cancel-round-*.db.test.ts                          → 7
ci-wiring 闭世界数组 CANCEL_ROUND_REALDB_FILES                        → 7(逐字未改)
approval-cancel-round-ci-wiring.test.ts                              → 6 passed
scripts/ops/t2-source-freeze-ci-wiring.test.mjs                      → 6 pass / 0 fail
sealed-export-s6a-product-runtime.test.cjs(s6a pin 守卫)             → 1 pass —— 本轮未改 plugin-tests.yml,pin 不动,不占合并串行化窗口
ci-realdb-step-contract.mjs 的 REAL_DB_STEP_IDS                      → 仍只有 approval / multitable 两个稳定 id,不枚举文件名 ⇒ 本轮无需改
W7-R10(补充清单第 13 条,目录 root 清单)                              → 本轮零新增文件,三个 root 的归属集合未变
```

## M8. 本切片自己的套件 + tsc

```
$ CI=true TZ=UTC DATABASE_URL=…/metasheet2_fix_c1_r7 EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run $(ls tests/integration/approval-cancel-round-*.db.test.ts)
 Test Files  7 passed (7)
      Tests  59 passed (59)        ← 55(上一轮)+ 4(本轮:P3 / N3 / N4 / G6-4)

$ npx tsc --noEmit
（无输出，EXIT 0）
```

## M9. required `test (20.x)` —— 逐字复现、整份清单同库连跑

### M9.1 人口在本 head 上**重新推导**(不沿用上一轮的 74)

`plugin-tests.yml` 在 `ba8a0133d..6013343eb` 的 diff 里(main 带来的改动),所以数字必须重算。
用 PyYAML 直接解析,不按行号切片:

```
job keys:                              ['runs-on', 'strategy', 'steps']
job-level env present:                 False            ← 谓词闭合的前提,独立复现
matrix node-version:                   ['18.x', '20.x']
total steps in jobs.test:              100              ← 上一轮是 99;main 加了一步,但它不在人口里
谓词选中(run 含 vitest | node --test | DATABASE_URL,或 step env 有 DATABASE_URL): 73
run-blocks containing ${{ expressions: 0
强制纳入 'Stop core backend':           1
────────────────────────────────────────
本轮重放人口:                           74
```

⇒ 分母从 99 变成 100,**人口仍是 74**,但这是我自己算出来的,不是继承的。

### M9.2 执行方式

每个 step 的 run 块原样落成 `.sh`,`bash -e -o pipefail` 跑(GH Actions 默认 shell),
step env 逐条照抄(仅把 CI 的 `metasheet_test` 改写成私有库),按 job 内原顺序
**在同一个处女库 `metasheet2_fix_c1_r7` 上连跑到底**;库由我 `createdb` 出来后**空着**,
由清单里的 `Run DB migrations` 自己按 CI 同一条 `MIGRATION_EXCLUDE` 迁移。
`CI=true`、`TZ=UTC`、node 20.20.2、pnpm 10.33.0。
逐 step 日志 `/tmp/fix-c1-r7/req20x/step-*.log`,清单 `MANIFEST.json`,结果 `RESULTS.json`。

### M9.3 结果:第一遍连跑 74 步里 73 步 exit 0(第 74 步见 M9.4,**未了结**)

| step | 名称 | rc | 观测 |
|---|---|---|---|
| 88 | 多维表真库 | **0** | `Test Files 262 passed (262)` / `Tests 2869 passed \| 2 skipped (2871)`,460.9s |
| **89** | **审批真库(本切片的 lane)** | **0** | `Test Files 84 passed (84)` / `Tests 906 passed \| 10 skipped (916)`,142.7s |
| 98 | 考勤真库 | **1** | `Test Files 1 failed \| 123 passed (124)` / `Tests 2 failed \| 1782 passed (1784)`,300.3s |
| 其余 71 步 | —— | 0 | —— |

> **「73/74」不要读成「已了结」。** 第 74 步(考勤)在本轮**三次**尝试里都是 rc=1,
> 每次受害者不同、每次都被同树处女库单跑证伪为非回归 —— 但整步一次全绿**没有做到**。
> 完整的三次账与判别控制在 M9.4;M10 里作为未了结项列着。

**本切片的 7 个套件在 step 89 连跑中逐一绿(逐字):**

```
✓ approval-cancel-round-creation.db.test.ts               (17 tests | 1 skipped)   977ms
✓ approval-cancel-round-lock-order-census.db.test.ts      (10 tests | 1 skipped)  4140ms
✓ approval-cancel-round-outlet-guards.db.test.ts           (7 tests | 1 skipped)   780ms
✓ approval-cancel-round-redemption.db.test.ts              (6 tests | 1 skipped)   565ms
✓ approval-cancel-round-node-timeout-effect.db.test.ts     (5 tests | 1 skipped)   846ms
✓ approval-cancel-round-seat-guards.db.test.ts             (3 tests | 1 skipped)   445ms
✓ approval-cancel-round-attendance-fk-migration.db.test.ts (11 tests | 1 skipped) 1013ms
```

(每个文件那 1 个 skipped 就是 `EXPECT_DB` 哨兵 —— 该 step 不设 `EXPECT_DB`,与 CI 同形;
`59 total − 7 skipped = 52 ran`,与 M8 里 `EXPECT_DB=1` 单独跑出的 `59 passed` 自洽。)
上一轮门审在**它的** `:1568`(审批 lane)上撞到过一次 `ECONNRESET`;本轮该 lane **rc=0**。

### M9.4 考勤那一步 —— 三次跑、三个不同受害者,逐个用判别控制排除,但**没有拿到一次干净的处女库全绿**

先把结论写在前面,免得「已解释」被读成「已了结」:
**本轮没有做到「考勤 step 在处女库上一次全绿」。** 我不把它记成绿,也不把它记成回归。
下面是三次跑的完整账,以及每一次红我做了什么判别控制。

| # | 条件 | rc | 红的文件 | 判别控制 |
|---|---|---|---|---|
| 1 | 处女库,`DATABASE_URL` **不带用户名**(我本机的写法) | 1 | `attendance-w4c3a-p08-child-process.db.test.ts`(2 条) | 失败形态是 `no PostgreSQL user name specified in startup packet` —— **传输层,零断言**。该文件 spawn 的子进程重新解析 URL 就没有用户名了(`psql` 靠 `$USER` 默认连得上,子进程连不上)。同树同库、URL 补上用户名后单跑该文件 ⇒ `1 passed / 2 passed` |
| 2 | **已被第 1 次跑过的库**,URL 带用户名 | 1 | `attendance-plugin.test.ts`(2 条) | 受害者换人了。这是本仓已知的「同一个库上第二次跑」残留家族(`attendance-plugin.test.ts` 在处女库上才是有效 oracle) |
| 3 | **重新 `dropdb`/`createdb` 的处女库**,URL 带用户名 | 1 | `attendance-w4c3a-p09-p10-p24-routes.db.test.ts` 的 `P06: authoritative exactly 5000 commits atomically`(1 条,`expected 500 to be 200`) | 受害者**又**换人了。同树、同样重建的处女库、单跑该文件 ⇒ `Test Files 1 passed / Tests 20 passed (20)` |

**三次跑、三个互不相同的受害者文件,每一个单跑都绿** —— 这是本机共享库 / 并行度下的抖动家族的签名
(第 6 轮门审自己在**它的**审批 step 上也撞到过同一种形态:`ECONNRESET`、受害者三次三个不同文件),
**不是一个静态 diff 能产生的**。三个受害者全在考勤线,**没有一个**含对撤销轮的断言。
本切片自己的 lane(step 89 审批真库)三次都不在其中,且 rc=0、7 个撤销轮套件全绿。

**我能承担的结论只到这里**:这一步的红**没有任何一次是断言意义上的回归**,每一次都被同树处女库单跑证伪;
但「整步一次全绿」**没有做到**,原因是我的本机重放台(URL 形状 + 共享库并行度)保真度不够,
不是树的问题。下次重放要照 CI 的 `postgres@` 形状写 URL,并且每次重放前重建库。

### M9.5 另外两条 required、不属于本人口的步骤

```
$ npx tsc --noEmit       → 无输出，EXIT 0（node 20.20.2 / pnpm 10.33.0）
```

最慢几步(秒):88 → 460.9、98 → 300.3、89 → 142.7、78 → 57.1、64 → 56.1、2 → 44.7。

## M10. 本轮仍然 OPEN / 未做(如实列,非遗漏)

- **G3 组织半边(「仍在该组织单元」)** —— 未实现,理由与上一轮逐字相同(全仓无 `user_orgs` 席位资格谓词;
  `org_id` nullable 的 NULL 语义未定),owner 裁决项;常驻正控 P2 仍把 `org_id IS NULL` 钉在明处。
- **把普通创建路径对齐到登录门** —— 已上线端点的行为变更,owner 裁决项,本轮仍不做。
- **三个(现为三个)错误码未登记进锁文 §14.3 表** —— 锁文 owner 所有,本轮未改锁文;
  `CANCEL_ROUND_NO_ELIGIBLE_APPROVER` 现在有两条臂(哨兵滤空 / 执行器初态异常),同一个码,已在设计 MD §3.1 写明。
- **`FOR UPDATE` 之外的竞态** —— NOT COVERED,理由见 M4 末。
- **判据 II / 判据 IV / 账侧等价 / legacy 事件三条** —— 属兑现期(C-2),本 head 无实现可测,零结论。
- **前端同步钉(补充清单第 15 条)** —— 本轮未碰 `apps/web`,未复核。
- **考勤 required step 未能在处女库上一次全绿** —— 三次跑三个不同受害者,逐个已用同树处女库单跑证伪(非回归),但「整步一次全绿」没做到;见 M9.4。
- **PR #5851 body 尚未写入第 6 轮说明** —— 文本备在 M6,本轮不编辑 PR。

## M11. 清理与纪律

- 临时探针 `zzprobe-r7-autoapproval.db.test.ts` 取证后**已删**,未提交、未接线。
- 两个被 mutation 碰过的源文件跑完全部 mutation 后 `cmp` **identical**;私有库的 CHECK / NOT NULL 已逐字恢复并复核。
- 处女私有库 `metasheet2_fix_c1_r7` 结束 `dropdb`(凭据见提交后的收尾)。
- 未改锁文;未合并;未 undraft;未开 PR;未动任何 PR 状态;未动 `origin/main`;
  未对任何共享 / staging / 生产库应用迁移;全程未用 `git stash` / `git checkout -- <path>` / `git reset --hard`;
  只删我自己建的东西(探针文件;本轮未新建 worktree)。

# Part N — §2-G3 第三句 候选读法 (a) 的第一次真库落地与实跑(2026-09-20)

> **⚠ 求值标记 —— 本 Part 写于 owner 裁决之前。** owner 已于 2026-09-20 裁定 **读法 (a) + 阻断**
> (原话见 **Part O** 抬头)。本 Part 里凡是记「legacy 语料上创建成功 / 席位 `[D]` / `P13(a)` 的
> `reasons` 是 `['inactive']`」的**状态断言**,以及所有**计数**,**均已失效,以 Part O 的实测为准**;
> 其余内容(夹具形状、哨兵、普查、C-2 锚点、§14.3 出口核、纪律记录)**仍然 OPERATIVE**。
> 不删本 Part —— 它是「当时的答案是什么」的记录,删掉就没法证明缺口是**被关掉的**而不是**从来没存在过**。

**状态:候选 PROPOSED,读法未裁。** 本 Part 记录的是「候选补丁 `reading-a` 被应用到分支上、第一次
编译 + 真库跑通」这件事本身的读数,**不是** owner 已裁读法 (a) 的记录。

> **求值标记(2026-09-20 硬化轮,勿整节作废)。** 本 Part 的**计数类读数**(七件套 70、`-creation` 28、
> 「11 条腿」、src `+41/−1`、两条 mutation 的 9/2 与 2/9)是**第一次实跑那个 head** 的读数,在**当前 head**
> 上已被 **Part N-H** 的重测取代 —— 逐条对照见 §NH5。本 Part 的**非计数结论**(§N2 的逐腿判别力说明、
> §N3 的承重归因、§N4 的缺口实测方向、§N5 的夹具修法)**仍然 OPERATIVE**;§N4 的结论在硬化轮被**补全**
> (补了「后果」那一半),不是被推翻;§N6 的 C-2 一条被**逐条勘误**(见该条)。锁文正文未改、设计 MD 里
half C 仍登记为 OPEN(§3.4),PR 未开、未合并、未 undraft。

- **分支**:`feat/approval-cancel-round-phase1-g3-reading-a`,基线 head
  `b8b71539a6a89e51331e2e4874f994498df15c55`(= `origin/feat/approval-cancel-round-phase1`,草案 PR #5851)。
- **候选来源**:`soak-working/c1-delegation-candidates-20260920/reading-a.patch`
  (`git apply --index` 干净落地,`--stat` = 2 文件 / +291 / −1,与该目录 README §2.1 逐字相符)。
  候选补丁**自称未编译、未运行**;本轮是它第一次被编译与执行。
- **库**:一次性私有库 `metasheet2_c1_deleg_a_20260920`(owner `ms2testbed`,非超级),
  `createdb` → 全量迁移 **414/414,EXIT=0** → 本轮全部跑动 → 收尾 `dropdb`。
  未对任何共享 / staging / 生产库、也未对 `metasheet_v2` / `metasheet_test` / `metasheet_testbed_*` 动过。

## N1. 跑了什么,数字

| 项 | 命令面 | 读数 |
|---|---|---|
| C-1 七件真库套件 | 7 个 `approval-cancel-round-*.db.test.ts`,`EXPECT_DB=1` 同库连跑 | **7 files / 70 tests passed,0 failed** |
| 委托相关既有套件(`grep approval_delegations` 的集成件) | `approval-delegation-seam` / `-api` / `-selfservice` / `approval-can-decide-current-node` / `approval-departure-transfer` / `approval-route-preview-substrate` | **6 files / 39 tests passed,0 failed** |
| 类型 | `packages/core-backend` `tsc --noEmit -p tsconfig.json` | **EXIT=0**(仓内 tsconfig `exclude` 掉 `**/*.test.ts`。测试文件另用一次性等价编译选项单独核过:该次调用共 **288 error,其中本文件 0**——288 条全部落在别的文件,因为这次临时调用没有 include 仓内的 `types/**/*` 全局类型扩展,不是本轮改动引入的) |
| 本条款用例总数 | `approval-cancel-round-creation.db.test.ts` 内 `§2-G3 第三句` | **11 条**(候选补丁自带 6 条 + 本轮补 5 条) |

七件套件的 70 条按文件拆:`-creation` **28**(候选前 17 + 候选 6 + 本轮 5)、`-lock-order-census` 10、
`-attendance-fk-migration` 11、`-outlet-guards` 7、`-redemption` 6、`-node-timeout-effect` 5、`-seat-guards` 3。

## N2. 11 条腿逐条(每条的断言都能区分「席位 = A」与「席位 = D」)

| 用例 | 构造 | 实测席位 / 结果 |
|---|---|---|
| 正控 P4(a) | A→D 委托**仍然有效** | `[A]` — 与读法 (b) 的唯一分歧腿((b) 答 `[D]`) |
| 正控 P5(a) | 委托已撤销(`active=FALSE`) | `[A]` |
| 正控 P6(a) | 委托窗口已过期(`end_at` 在过去) | `[A]` |
| 正控 P7(a) | 作用域不覆盖(`scope='template'` 指向别的模板) | `[A]` |
| 正控 P9(a) **本轮新增** | 作用域**正好命中**原单模板且仍有效 | `[A]`((b) 在这一腿答 `[D]`) |
| 负控 N5(a) | 委托有效 + 停权**原审批人 A** | 409 `CANCEL_ROUND_SEAT_INELIGIBLE`,`details = {ineligibleCount:1, reasons:['inactive']}`,零行,values-free |
| 正控 P8(a) | 委托有效 + 停权**被委托人 D** | 201,席位 `[A]`(与候选前实测正相反) |
| 正控 P10(a) **本轮新增** | 哨兵腿:自动审批节点(`system:auto-approval`)+ 被委托的人工节点 | 席位恰好 `[A]`;哨兵不在席位、不在 `requester_snapshot` |
| 负控 N6(a) **本轮新增** | 零席位腿:整单由自动化批完,库里另有一条有效委托行 | 409 `CANCEL_ROUND_NO_ELIGIBLE_APPROVER`,`details={reason:'no_human_approver'}`,零行 |
| 正控 P11(a) **本轮新增** | **G-3**:D 在节点 1 是 A 的代理、在节点 2 有自己的席位(两节点顺序模板) | 席位 `{A, D}` **两人** |
| 正控 P12(a) **本轮新增** | **G-4**:legacy `POST /api/approvals/:id/approve` 写的 approve 行(metadata 取自请求体,无 `nodeKey`) | 席位 `[D]` —— **不被还原**(见 §N4) |

关于 P9(a) 的判别力,如实写明其上限:读法 (a) **根本不调用** `resolveActiveDelegationMap`,所以
这一腿的绿**不构成**「templateId 作用域被正确处理」的任何证据;它证的是另一件事——
「今天完全有效且完全在作用域内的委托,席位也不再跟着它走」,而候选前的实测在这一腿答 `[D]`。
N6(a) 的判别力同理写明:它区分 A 与 D 的方式是**两者都不成立**(任一被坐下,创建就会成功、
`thrown` 为假、零行断言会红),它**不是**还原本身的 oracle。

## N3. Mutation 台账(`cp` 备份 → 改 → 跑 → `cp` 还原 → `cmp`;全程未用 `git checkout --` / `reset --hard`)

备份基准:候选落地后的 `ApprovalProductService.ts`,sha256
`12bf492615c2e4f205f58b330b03db780ff8e6a1c5384448adf801761bd2c5ce`;
基线(候选前)副本 sha256 `f35a38d43a6767ef65ce77555e91a80640eddb8554e403353c4d2a25bcefc7ea`
(= 独立验证报告 §附录记录的同一值,可独立复核)。

**M-A(G-1,任务书点名):把席位推导整段退回基线**(直接 `cp` 基线副本覆盖,不手写 mutant)。

- 读数:**9 failed / 2 passed**(11 条腿)。
- 红的原文(节选,逐字):
  - `P4(a)` — `AssertionError: expected [ Array(1) ] to deeply equal [ Array(1) ]` /
    `- "wi4-delA-g3dlg-valid-…"` `+ "wi4-delD-g3dlg-valid-…"`
  - `P11(a)` — `AssertionError: expected [ Array(1) ] to deeply equal [ …(2) ]` /
    `- "wi4-selA-g3dlg-sibling-…"`(只剩 `"wi4-selD-…"` 一人)
  - `P10(a)` — `expected [ 'wi4-aelD-g3dlg-sent-…' ] to deeply equal [ 'wi4-aelA-g3dlg-sent-…' ]`
  - `N5(a)` — `AssertionError: expected undefined to be truthy`(停权 A 在基线下**不阻断**)
- **没有红的两条,如实点名并说明为什么它们本来就不该红**:
  - `P12(a)`(legacy 无 `nodeKey`)断言的就是**今天的行为**(席位 = D),基线下自然同值 ⇒ 绿;
  - `N6(a)`(零席位)在两侧都走同一条零人类席位预检 ⇒ 绿。
  两条在这条 mutation 下是**非回归守卫**,不是承重 oracle。按本仓口径「mutation 只证承重」,
  这一句必须写出来,而不是把「新用例全红」当成结论。

**M-B(node_key 合取的独立 mutation;README §2.2 自称该合取从未被实测):只删
`AND a.node_key = r.metadata->>'nodeKey'` 一行,join 其余不动。**

- 读数:**2 failed / 9 passed** —— 红的恰好是 `P11(a)` 与 `P12(a)`,**方向相反**:
  - `P11(a)`:`expected [ Array(1) ] to deeply equal [ …(2) ]` —— D 自己在节点 2 的席位被折算给 A,
    `{A, D}` 塌成 `{A}`,**会签门槛真的降低**;
  - `P12(a)`:`- "wi4-delD-g3dlg-legacy-…"` `+ "wi4-delA-g3dlg-legacy-…"` —— 没有该合取,
    legacy 那条无 `nodeKey` 的 approve 行**反而**被还原成 A。
- 结论:该合取是**承重**的,且它的两个 oracle 在 M-A 下都不红 —— 只跑 M-A **证不了**它。
  这正是把 G-3 / G-4 单独建腿的理由。

**还原**:两条 mutation 各自跑完立刻 `cp` 还原并 `cmp` **identical**,sha256 回到
`12bf4926…`;`git status --porcelain` 只剩本轮有意的两份改动。

## N4. G-3 / G-4 实测(无论结果如何,照实)

任务点名要实测「一条 approve 记录 metadata 无 `nodeKey` 的 legacy 行」。**做法是走生产路径,不是手改表**:
用 legacy `POST /api/approvals/:id/approve` 端点批(该路由的 `metadata` 逐字取自请求体,
`routes/approvals.ts:2877-2879`,不传即 `{}`),因此那条 approve 行的 `metadata->>'nodeKey'` 是 NULL。

**实测结果:席位 = `[D]`(被委托人),该席位不被还原。** 即候选补丁 README §2.3 披露的缺口,
在真库上**被证实存在**,而不是停留在注释里的声明。方向上它退化成**候选前的行为**(永远不会给出更宽的
席位),已经写成常驻正控 `P12(a)`:将来若有人让这条被还原成 A,这条断言会红,缺口必须重新登记而不是
静默关闭。

**后果那一半(硬化轮 2026-09-20 补写,门审 P2-1;本段此前只写了席位身份)。** 席位停在 D 意味着
G3 **第三句**的资格闸跑的是 D,**不是读法 (a) 认定的席位持有人 A** —— 因此**原审批人 A 已停权的单据,
在这条语料上轮次照开**。闸本身没有被跳过:停权**被委托人 D** 仍然 409 阻断。三条读数(本 head 实测,
见 Part N-H §NH2):`N7(a)` legacy × 停权 A ⇒ **不抛、201、席位 `[D]`**;`N8(a)` 再叠「委托已撤销」⇒ 同上;
`P13(a)` legacy × 停权 D ⇒ **409 `CANCEL_ROUND_SEAT_INELIGIBLE`、`details={ineligibleCount:1,reasons:['inactive']}`、零行**。

同一轮也把 README §6.2 的 G-3 建成了腿(`P11(a)`,兄弟席位),**实测 `{A, D}` 两人**;
配合 M-B 的红,这条合取的取舍(不用 instance 级匹配)第一次有了读数而不是论证。

## N5. 本轮发现并修掉的一个夹具缺陷(不是候选补丁的语义问题,但会污染共享库)

`-creation` 文件的 `afterAll` 里,`approval_delegations` 的清理原本排在**最后**。M-A 那次红跑里,
`N5(a)` 的创建在 mutant 下**意外成功**,留下一条没有被登记进 `createdRoundIds` 的撤销轮;
随后 `DELETE FROM approval_instances` 撞 FK 报错:

```
error: update or delete on table "approval_instances" violates foreign key constraint
       "approval_rounds_document_id_fkey" on table "approval_rounds"   (23503)
```

整个 `afterAll` 就此中断,**11 条 'all'-scope 委托配置行全部留在库里**,随后
`approval-delegation-seam` 的 `expect(snap?.delegations).toEqual({[DELEGATOR]: DELEGATEE})` 多出
7 个键而红 —— 正是独立验证报告 §4 自己被污染过的那一族(报告 §6.2 G-6 也点名要求门审确认清理真的跑到)。

两处修法,都在夹具侧,不动被测代码:

1. 委托行的 DELETE **前移到 `afterAll` 的第一条**,与任何 FK 纠缠的表无关 —— 这些行是全局配置,
   会替换后续任何同名委托人的席位,传染性最强,必须与其它 DELETE 的成败解耦;
2. 新增 `registerUnexpectedlyCreatedRound(documentId, instanceId)`,负控腿**意外创建成功**时把
   实例与轮都登记进清理集合(`N5(a)` / `N6(a)` 已接线),从另一端堵同一个洞。

**修完后的复核不是论证而是重跑**:再跑一次 M-A(同样 9 failed / 2 passed),跑完
`select count(*) from approval_delegations` = **0**;随后委托六件套 **39/39 全绿**。

## N6. 本轮**没有**做的(如实列)

- **没有**裁读法。设计 MD §3.4 的 `G3 half C` 仍是 OPEN 条目,候选只以 PROPOSED 形态挂在它下面;
  `design-md-fragment-open-registration.md` 那条 OPEN 文本**没有**被候选段落取代——
  候选片段原文建议「删去 OPEN 条目」,本轮**不采纳**:读法未裁之前删掉一条 RATIFIED 条款的 OPEN 登记,
  就是把 owner 没做的决定洗成既成事实。两者并存,OPEN 在上、候选在下。
- **没有**实现读法 (b) / (a′) / 报告 §7 的 (b′)(失效即阻断 + 新错误码),也没有改 §14.3 出口表。
- ~~**没有**测 §4.2 披露的「同一个人既有角色席位又有被委托的 user 席位 ⇒ 席位数塌缩」~~
  —— **2026-09-20 硬化轮已补(门审 P3-2)**:`正控 P15(a)` 钉今天的答案(席位 **2 → 1**),**不预判裁决**;
  取舍本身仍是设计层的,**仍交 owner**,设计 MD §3.4 的登记保持 OPEN。
- **没有**测再入节点(`entry_epoch` 故意不在 join 里)会不会让同一 `(instance, node_key, assignee)`
  出现多行委托 assignment 而使席位集合**膨胀**;已按「已知镜像风险」登记,不声称不存在。
  **2026-09-20 硬化轮:本条 KEPT OPEN,并驳回了一个把它关掉的提议。** 门审 §P3-1 用三行普查推出
  「膨胀不可达」。三行普查本轮复核**属实**(逐条重跑,见 §NH4),**但推论有洞**:
  `ApprovalAssigneeResolver.ts` 自己的文档写明 `prior_node_approver`(Lock-1 §K3)是
  **「the one kind whose input is caller-supplied at activation rather than create-frozen」** ——
  15 种源里**至少这一种**的输入不是创建时冻结的,「跨 epoch 恒定」的前提对它不成立。
  故本轮**不写「不可达」**,只写「**普查没有证明不可达**,洞在 §K3」;构造草图见设计 MD §3.4 同条,
  标 **UNVERIFIED / NOT CONSTRUCTED THIS ROUND**。
- **没有**跑 required `test (20.x)` 全量清单(本轮只跑七件套 + 委托六件 + `tsc`)。
- **没有**动 C-2。**本条 2026-09-20 硬化轮勘误(门审 P2-2:原文三处全部过期/不成立,逐条改写为实测)。**
  原文为:「C-2 的 rebase 与重跑仍欠,且按候选 README §8 它一定会在同一段代码上冲突。」
  - **锚点错**:候选 README 的 `## 8` 是「本次交付**不**解除验证报告 §8 的 P2 阻塞」,与冲突无关;
    冲突说法在该 README `## 5` 与 `## 9` 第 8 步。(本分支基线提交 `b8b71539a6` 正是一次锚点勘误,同族复发。)
  - **祖先前提已过期**:实测 `git merge-base --is-ancestor b8b71539a6… origin/feat/approval-cancel-round-phase2`
    → **YES**;`git merge-base origin/feat/approval-cancel-round-phase2 6a81b6779b…` = **`b8b71539a6…`**。
    C-2 **已经**坐在当前 C-1 基线之上。
  - **「一定会冲突」未经证实**:实测 `git merge-tree --write-tree <C-1 head> origin/feat/approval-cancel-round-phase2`
    → **EXIT 0**,干净树 `c5e376b6a385b316e9e102a05d5088e153e808a0`(测于 phase2 head `6a40f0121a…`)。
  - **两句必须分开写,不能合并成一句**:**三方合并实测干净**;**逐提交重放(rebase)本轮未实跑**。
    `merge-tree` EXIT 0 **不蕴含** rebase 干净 —— 把两者合并成一句,与被勘误的「一定会冲突」是同一种过强声明。
  - **仍欠的是 rebase 后的重跑**,不是冲突解决。
  - **顺带(交 C-2 线)**:候选 README `## 9` 第 8 步把「`SELECT DISTINCT actor_id FROM approval_records`
    在 C-2 全文必须仍是**恰好 1 处**」当成「冲突有没有解反方向」的判据。该字面量在候选 head 上实测
    `grep -c` = **0**(新查询根本不含该串),在 phase2 head 上 = **1**;照此判据执行的人会把 0 读成「解反了」。
    判据须换成对**新查询**的正向锚点 ——(**2026-09-20 二次勘误:这条锚点本身也已失效**,
    owner 裁决后席位查询被整段重写,该字面量在 C-1 head 上同样是 0 处;**现行判据见本文件 §O6**)
    `COALESCE(a.metadata->>'delegatedFrom', r.actor_id)` ——
    候选 head 实测 **1** 处、phase2 head 实测 **0** 处。README 已同步勘误。
- **没有**合并、未 undraft、未开 PR、未改任何锁文、未对任何共享库应用迁移。

---

# Part N-H — 读法 (a) 候选的**硬化轮**(2026-09-20,门审第 1 轮 P2/P3 结清)

> **⚠ 求值标记 —— 本 Part 写于 owner 裁决之前。** owner 已于 2026-09-20 裁定 **读法 (a) + 阻断**
> (原话见 **Part O** 抬头)。本 Part 里凡是记「legacy 语料上创建成功 / 席位 `[D]` / `P13(a)` 的
> `reasons` 是 `['inactive']`」的**状态断言**,以及所有**计数**,**均已失效,以 Part O 的实测为准**;
> 其余内容(夹具形状、哨兵、普查、C-2 锚点、§14.3 出口核、纪律记录)**仍然 OPERATIVE**。
> 不删本 Part —— 它是「当时的答案是什么」的记录,删掉就没法证明缺口是**被关掉的**而不是**从来没存在过**。

**状态:候选仍是 PROPOSED,读法仍未裁。** 本 Part 记录的是「把门审
`impl-gate-C-slice1-g3-reading-a-round1-20260920.md` 的 **3 个 P2 + 2 个 P3** 做完」这件事的读数。
未合并、未 undraft、未开 PR、未改锁文正文、未对任何共享/staging/生产库应用迁移。

- **基线 head(硬化前)**:`6a81b6779bc5180971e32ca104f92b58dd789fc9`(= `origin/feat/approval-cancel-round-phase1-g3-reading-a`,fetch 后逐字核对)。
- **工作树**:一次性 detached 树,`node_modules` 软链 canonical;**库**:一次性私有库
  `metasheet2_c1_deleg_a_h_20260920`(owner `ms2testbed`,**非超级**),`createdb` → 全量迁移
  **414/414 EXIT=0** → **415 张 BASE TABLE** → 本轮全部跑动 → 收尾 `dropdb`。
- **纪律**:全程 `cp` 备份 → 改 → 跑 → `cp` 还原 → `cmp`;**未用** `git checkout -- <path>` /
  `reset --hard` / `stash`;未动任何别人的工作树/库。

## NH1. 五条 P2/P3 的处置(逐条)

| 门审项 | 处置 | 落点 |
|---|---|---|
| **P2-1a** 三处只写席位身份、没写后果 | **补写后果**(三处) | `ApprovalProductService.ts` seat 查询上方注释的 `ITS CONSEQUENCE` 段;设计 MD §3.4 第一条的 `ITS CONSEQUENCE`;本文件 §N4 的「后果那一半」 |
| **P2-1b** compound 格零覆盖 | **加三条常驻腿** | `负控 N7(a)` / `负控 N8(a)` / `负控 P13(a)`(`approval-cancel-round-creation.db.test.ts`) |
| **P2-2** §N6 对 C-2 的三句过期 | **逐条改写为实测** | 本文件 §N6 该条(锚点 / 祖先 / 「合并干净 ≠ 重放干净」拆成两句);候选 README §5 §9-8 同步勘误 |
| **P2-3** 兄弟界面未求值未登记 | **登记 + 正控用例** | 设计 MD §3.4 新增一条 OPEN(与 half B 同等待遇);`正控 P14(a)` |
| **P3-2** 席位塌缩零用例 | **加一条钉今天行为的腿** | `正控 P15(a)`;设计 MD §3.4 该条改写 |
| **P3-1** 「再入节点膨胀」建议关掉 | **不采纳,KEPT OPEN**(普查属实,推论有洞) | 设计 MD §3.4 该条 + 本文件 §N6 该条 |

**P2-1 的处置为什么是「登记 + 覆盖」而不是「实现 fallback」**,写在设计 MD §3.4 第一条:
`nodeKey IS NULL` 时退回 instance 级匹配**不是补上缺口,而是用一种错换另一种错,且换到哪一种取决于语料**
(两节点都走 legacy ⇒ 把 D 自己的兄弟席位折给 A;混合语料 ⇒ 反而给出正确的两席;**两格均为推演,
本轮 NOT CONSTRUCTED**);fail-closed 则需新错误码、须先进锁 §14.3。两者都属 owner 裁决。
本轮**未新增任何错误码**(§NH6 机械核)。

## NH2. 五条新腿的构造与实测读数

| 用例 | 构造(全部走生产路由,不手改表) | 实测 |
|---|---|---|
| `负控 N7(a)` | legacy `POST /:id/approve` 批(approve 行无 `nodeKey`)+ `UPDATE users SET is_active=FALSE` 停权**原审批人 A** | **不抛,轮次创建成功,席位 `[D]`** |
| `负控 N8(a)` | 同上 + 委托 `active=FALSE`(已撤销) | **不抛,轮次创建成功,席位 `[D]`** |
| `负控 P13(a)` | legacy 批 + 停权**被委托人 D**(= 未被还原的 actor) | **409 `CANCEL_ROUND_SEAT_INELIGIBLE`,`details={ineligibleCount:1,reasons:['inactive']}`,零行,values-free** |
| `正控 P14(a)` | `approval_a`(A,被委托给 D)→ `approval_b`(Lock-1 §K3 `prior_node_approver` 引用 `approval_a`),D 两处都批 | 兄弟界面席位 **`[D]`**(`delegatedFrom` 为空、`resolvedFrom.kind='prior_node_approver'`,**无还原**);同一张单据的撤销轮席位 **`{A, D}`** |
| `正控 P15(a)` | `approval_role`(`assigneeType:'role'`,角色 `admin`,**A 本人**批)→ `approval_user`(A,被委托给 D,**D** 批) | 撤销轮席位 **`[A]`**,**1 席**(基线为 `{A, D}` 两席) |

**N7/N8/P13 的定位,写明而不是含糊**:N7/N8 断言的是**今天的真实答案**,是**已登记缺口的钉子,不是期望行为**;
缺口若被关上它们会红,缺口必须**重新登记而不是静默关闭**(`P12(a)` 自己写的纪律,只是此前没覆盖到资格臂)。
承重的是 **P13(a)**,而它承的是**反驳**:门审 P2-1 的前提句是「资格闸对 legacy 语料**本来就不起作用**」,
`P13(a)` 实测 **409、零行** ⇒ 闸在这条语料上**被跑到了、也确实阻断**,只是跑在**未被还原的 actor** 身上,
而不是读法 (a) 认定的席位持有人 A。**这一句的边界照实写**:`assertCancelRoundSeatsEligibleInTxn`
只有一个调用点,**不存在可以单独 neuter 的「legacy 臂」**;把整个闸 neuter 掉会连 `N1/N2/N4/N5(a)` 一起红。
该 mutation(记 **M-C**)**本轮 NOT RUN**,所以本报告**不对**「闸被 neuter 之后谁会红」作任何断言;
门审自己那句「把它 neuter 掉,**70 条一条不红**」同样**未经证实**(表面上与 `N1/N2/N5(a)` 的 409 断言相抵触),
**留给下一轮实测**,本轮不据此加强也不据此削弱 P2-1 的定级。

**N8(a) 判别力的上限,照实写**:读法 (a) **根本不读**活的委托行(这条路径上 `resolveActiveDelegationMap`
零调用),所以 N8 与 N7 的差别落在一个**被测代码从不触碰的字段**上。它**不是**独立的第二个 oracle;
它钉的是锁文里最刺眼的那一格 —— 委托**已撤销**、委托人**已离职**,被委托人 D 仍然拿到撤销轮的决定权。

**P14(a) 的归因**:结构上它是 `P11(a)` 的兄弟(两节点 + 一条委托),因此在 M-B 下与 `P11(a)` **同向红**;
它**不是** `node_key` 合取的独立证据(见 §NH3 台账)。
**它测到的与它被用来支持的,分开写**:该腿**实测**的是「§K3 节点的席位 = 实际决定人 D,`delegatedFrom` 为空、
`resolvedFrom.kind = 'prior_node_approver'`,没有任何还原发生」;而「同实例内冻结映射仍在生效、
D 就是 A 在这张单据上的履职代理」是**建议不外推的理由**(语义判断),**不是**这条断言测到的东西 ——
D 本人不是委托人,所以 `delegatedFrom` 为空**也可以**被读成「映射在这条路径上压根没被查」。
理由归理由,读数归读数,owner 裁的是前者。

## NH3. 判别力(逐条反转 → 贴红)与 mutation 台账(**重测,非转抄**)

**判别力**:把 `-creation` 文件**复制**成一次性文件(**不改被测文件**),对**本轮 5 条新腿各反转一处**核心断言。
机械核:`diff` 恰好 **10 行 = 5 对**(每条新 `it()` 正好一处,无遗漏无重复)。

| 反转 | 读数 |
|---|---|
| `N7(a)`:`toEqual([delegateeD])` → `([delegatorA])` | **FAIL** `expected [ Array(1) ] to deeply equal [ Array(1) ]` |
| `N8(a)`:同上 | **FAIL** 同形 |
| `P13(a)`:`expect(thrown).toBeTruthy()` → `toBeFalsy()` | **FAIL** `expected ServiceError: A previous approver of this… to be falsy` |
| `P14(a)`:`toEqual([delegatorA, delegateeD])` → `([delegateeD])` | **FAIL** `expected [ …(2) ] to deeply equal [ Array(1) ]` |
| `P15(a)`:`toEqual([delegatorA])` → `([delegatorA, delegateeD])` | **FAIL** `expected [ Array(1) ] to deeply equal [ …(2) ]` |

- 反转组:**5 failed / 28 passed(33)**,逐条按用例名点名 ⇒ **5/5 全红,零条空转**。
- 控制组(未反转,同 head):**16 passed / 17 skipped(33)**。
- 一次性反转文件跑完立即删除;跑后 `select count(*) from approval_delegations` = **0**。

**Mutation(两条都**按门审 §5 的定义重跑**,不沿用 11 腿时代的 9/2 与 2/9)。**
备份基准 sha256 `6b6ac5320de96cd2e6372f4fcb37f8aa4b6335ddae871dc1649d2a082db94d2a`
(= 本轮注释补写**之后**的 `ApprovalProductService.ts`;补写**之前**为 `12bf4926…`,与门审报告 §5 逐字相符)。
每条施加后先 `diff` 确认**真的变了**(不做无效 mutation),跑完 `cp` 还原并 `cmp` **identical**。

| Mutation | 内容(机械核) | 预测 | 实测(`-creation` 全文件 33 条) |
|---|---|---|---|
| **M-A** | 整条 seat 查询退回基线 `SELECT DISTINCT actor_id …`(`diff` 10 行 = 9 换 1) | 11 红 / 5 绿 | **11 failed / 22 passed**;红的是 `P4 P5 P6 P7 N5 P8 P9 P11 P10 P14 P15`,绿的是 `P12 N6 N7 N8 P13` —— **与预测逐条相符** |
| **M-B** | **只删** `AND a.node_key = r.metadata->>'nodeKey'` 一行(`diff` 恰好 1 行) | 6 红 / 10 绿 | **6 failed / 27 passed**;红的是 `P11 P12 N7 N8 P13 P14` —— **与预测逐条相符** |

**两条 mutation 下本轮新腿的如实归因**:
- **M-A**:`N7/N8/P13` **不红**。原因与 `P12(a)` 同构 —— 它们断言的就是 legacy 语料上**今天的行为**,
  而基线在同一格给同一答案。**这三条在 M-A 下是非回归守卫,不是承重 oracle**,不能拿 M-A 的红来给它们背书。
  `P14/P15` **红**,承重。
- **M-B**:`N7/N8/P13` **全红**,原因是删掉该合取后 legacy 那条 approve 行**反而被还原成 A** ——
  即「缺口被意外关上」,正是这三条钉子被设计来捕捉的事件。`P14` 与 `P11` 同向红(D 自己的席位被折给 A)。
  `P15` **不红**(它的两条 approve 行里,角色那条的 actor 是 A 本人,本来就没有可 join 的 user 委托行)。

## NH4. 普查复核(门审 §P3-1 的三行,逐条重跑)

| 普查 | 门审读数 | 本轮重跑 |
|---|---|---|
| `delegatedFrom` 全仓写入方 | 唯一 `ApprovalAssigneeResolver.pushResolved` | `git grep -c` @src:`routes/approvals.ts` **2**、`ApprovalAssigneeResolver.ts` **4**、`ApprovalDelegationConfig.ts` **7**、`ApprovalProductService.ts` **8**、`types/approval-product.ts` **3** —— 与门审一致 |
| `resolveActiveDelegationMap` 生产调用点 | 唯一 `ApprovalProductService.ts:7947` | 命中 4 处:定义 `ApprovalDelegations.ts:33`、`import` `APS:137`、**调用 `APS:7947`(唯一)**、迁移文件里一句注释 —— 与门审一致 |
| 解析器纯函数 | `await` 0 / `async` 0 / `.query(` 0 | **0 / 0 / 0** —— 与门审一致 |

**三行属实,但推论「膨胀不可达」不成立地被得出**:见 §N6 该条与设计 MD §3.4 —— `prior_node_approver`
(Lock-1 §K3)按 `ApprovalAssigneeResolver.ts` 自己的文档是 **the one kind whose input is caller-supplied
at activation rather than create-frozen**,对它「跨 epoch 恒定」的前提不成立。本轮**不写「不可达」**,
只写「**普查没有证明不可达**」,并给出一条 **UNVERIFIED / NOT CONSTRUCTED THIS ROUND** 的构造草图。

## NH5. 本 head 的全部计数(逐条重测;Part N 的对应计数**由此取代**)

| 项 | Part N(第一次实跑) | **本 head(硬化后)** |
|---|---|---|
| C-1 七件真库套件 | 7 files / **70** passed | 7 files / **75** passed / 0 failed |
| `-creation` 单件 | 28 | **33** |
| `§2-G3 第三句` 过滤 | 11 passed / 17 skipped | **16 passed / 17 skipped(33)** |
| 委托邻居套件 | 6 files / 39 passed | **7 files / 54 passed / 0 failed**(六件 + `approval-prior-node-approver.db.test.ts`,因 P14 新触及该界面) |
| `tsc --noEmit -p tsconfig.json` | EXIT=0 | **EXIT=0,零输出** |
| 测试文件的类型核(仓内 tsconfig `exclude` 掉 `**/*.test.ts`,故另用一次性等价配置) | 288 error,本文件 0 | 一次性配置(`include` 加 `types/**/*` 与本测试文件、去掉 test 排除):共 **146 error**,**本文件 0**;146 条全部落在**其它**测试文件(`src/**/__tests__/**` 等),与本轮改动无关 |
| src diff vs 切片基线 `b8b71539a6` | +41 / −1 | **+55 / −1** |
| src diff vs 候选 head `6a81b6779b` | — | **+14 / −0,其中非注释行 0** ⇒ **相对候选零行为变化** |
| 测试件 diff vs `b8b71539a6` | +651 | **+1088** |

## NH6. 出口表(锁 §14.3)与 C-2 锚点:机械核

- src diff 的 `+` 行里:大写错误码字面量 **0**;`throw` / `ServiceError` / `Error(` **0**(`grep -cE`)。
  ⇒ **未新增出口、未新增错误码,§14.3 无需改动。**(P2-1 若将来走 fail-closed 修法会新增错误码,**那时**必须先进 §14.3 —— 属 owner。)
- C-2 锚点(实测,phase2 head `6a40f0121a36d7e54fde98088ca68212653403bf`):
  `merge-base` = **`b8b71539a6…`**;`--is-ancestor b8b71539a6… phase2` = **YES**;
  `merge-tree --write-tree` = **EXIT 0**,树 **`c5e376b6a385b316e9e102a05d5088e153e808a0`**;
  正向锚点 `COALESCE(a.metadata->>'delegatedFrom', r.actor_id)` 在**当时的**候选 head **1** 处 / phase2 head **0** 处
  (**已被 §O6 取代**:owner 裁决后席位查询整段重写,该字面量在当前 C-1 head 上是 **0** 处 ⇒ 零判别力);
  旧字面量 `SELECT DISTINCT actor_id FROM approval_records` 在候选 head **0** 处 / phase2 head **1** 处。
  **三方合并实测干净;逐提交重放(rebase)本轮未实跑** —— 两句分开写,不合并。

## NH7. 本轮**没有**做的(如实列)

- **没有**裁读法;设计 MD §3.4 的 `G3 half C` 仍是 OPEN,候选仍以 PROPOSED 挂在其下。
- **没有**实现 P2-1 的任何一种行为性修法(instance 级 fallback / fail-closed),理由见 §NH1;
  **没有**新增错误码,**没有**改锁文正文。
- **没有**实现读法 (b) / (a′) / (b′)。
- **没有**外推读法 (a) 到 `loadPriorNodeApproverDeciders`(登记为 OPEN,交 owner)。
- **没有**构造「再入节点 × §K3 ⇒ 席位膨胀」的证人(草图标 UNVERIFIED)。
- **没有**跑 **M-C**(把 `assertCancelRoundSeatsEligibleInTxn` 整条 neuter)。因此本报告**不**声称
  「闸被 neuter 之后哪几条会红」,也**不**替门审那句「把它 neuter 掉,70 条一条不红」背书或证伪。
- **没有**跑门审 §6 那组 `CI=true` core-backend 全量(它的 1124 files / 1115 passed / 8 failed 读数)。
  ⇒ **本轮的读数集合不足以按门审 §9「在同一 head 上重跑 §3/§4/§5/§6 四组」直接重裁**:
  §3/§4/§5 已重测(见上),**§6 只跑了 14 件真库套件 + `tsc`,未跑全量**。重裁前需补这一组。
- **没有**跑 required `test (20.x)` 全量清单(本轮跑七件套 + 委托邻居七件 + `tsc`)。
- **没有**合并、未 undraft、未开 PR、未对任何共享/staging/生产库应用迁移、未删任何不是本轮自己建的东西。

---

# Part O — owner 2026-09-20 裁决 **(a) + 阻断** 的落地与实跑

> **求值标记(勿整节作废)。** 本 Part 之前的 **Part N / Part N-H** 记录的是**候选 PROPOSED 阶段**的读数。
> owner 裁决之后,那两个 Part 里**只有下列三类断言失效**,其余(fixture 形状、哨兵、普查、C-2 锚点、
> §14.3 出口核、纪律记录)**全部 OPERATIVE**:
> 1. 「legacy 语料上创建成功、席位 `[D]`」这一类**状态断言**(§N4、§NH2 的 `N7(a)`/`N8(a)`/`P12(a)` 三行、
>    §NH3 台账里这三条腿的红绿) —— **被本 Part 的实测取代**;
> 2. 「`P13(a)` 的 `reasons` 是 `['inactive']`」—— 现在是 `['delegate_not_seat']`;
> 3. 所有**计数**(七件套 75 / `-creation` 33 / 五条新腿 / M-A、M-B、M-C 的红绿集合)—— 以本 Part 为准。
>
> 特别地:§NH1 里「**没有**实现 P2-1 的任何一种行为性修法」这句,其**求值结果**现在是
> 「owner 裁了第三种修法(阻断),已实现」—— 那句当时是**对的**,它记录的是「当时没有替 owner 选」,
> 不是「永远不做」。不删它,只在这里求值。

## O0. 取证基线

| 项 | 值 |
|---|---|
| 裁决前 head(= 门审第 2 轮 APPROVE 的那个) | `cc897234ebb8483a677f431ee58d4848216e1c43` |
| owner 裁决(逐字) | 「席位回原审批主体,并重验当前资格。原主体无法可靠还原或已失格则阻断,不静默回退给历史被委托人;补多人委托同一人的反例。」 |
| 工作树 | `…/scratchpad/wt-c1a-owner-a`(`--detach cc897234eb`,一次性;`node_modules` **12 处软链**自 canonical) |
| 库 | `metasheet2_c1_a_final_20260920`(`createdb -U postgres -O ms2testbed`,owner **非超级**),全量迁移 **EXIT=0**,**415 张 BASE TABLE**;`current_database()` 跑前实测 |
| 改动文件 | `ApprovalProductService.ts`、`approval-cancel-round-creation.db.test.ts`、design MD、verification MD(本节)。**锁文正文未改** |
| `ApprovalProductService.ts` sha256(实现后) | `36892fa26bde30bb4b3c836b3ec5c4b39db5a79007f4f8a454d11e331fe70dbc`(前两版 `2dbadf47…` / `a680a476…` 已被取代 —— 见 O1 的**两次**自我推翻) |
| `approval-cancel-round-creation.db.test.ts` sha256(实现后) | `9873538eebec5e921bec6334fd28c4f1f2de35c27379951437f702783485a31f` |
| 纪律 | 全程 `cp` 备份 → 改 → 跑 → `cp` 还原 → `cmp`;**未用** `git checkout -- <path>` / `reset --hard` / `stash` |

## O1. 「无法可靠还原」被写成谓词(不是散文)

席位推导逐 `approve` 行求值。哨兵(`isSystemSentinelActor`)**先丢**,再归属 —— 这个次序承重:
哨兵不是人,不可能是谁的代理,把它判成「无法还原」会让每一张自动审批过的历史单据变成 409
(`P10(a)` / `N3` / `N6(a)` 钉住它没有)。

**第一问先问 actor,不问行**:该 actor 在**本实例**上有没有过被委托席位?没有 ⇒ 任何还原都不适用,
席位 = actor 本人,这一行说什么都无所谓。这是爆炸半径的闸门(`P19(a)`)。有,才往下走:

| 行的形状(actor 在本实例上**有**被委托席位) | 结果 | 钉子 |
|---|---|---|
| **无** `nodeKey`;该 actor 的不同 `delegatedFrom` **>1** 个 | **阻断** `seat_unresolvable` | `N9(a)`(= owner 点名的多人委托同一人反例) |
| **无** `nodeKey`;**恰好 1** 个 | **阻断** `delegate_not_seat` | `P12(a)`、`N7(a)`、`N8(a)`、`P13(a)` |
| 有 `nodeKey`;它命中该 actor 自己的 **user** assignment 行**恰好 1** 条,该行 `delegatedFrom` 非空 | 席位 = 该原主体 | `P4(a)`–`P9(a)`、`P16(a)`、`P20(a)` |
| 有 `nodeKey`;命中**恰好 1** 条,该行 `delegatedFrom` 为空(= 自己的 user 席位) | 席位 = actor 本人 | `P11(a)`、`P18(a)` |
| 有 `nodeKey`;命中 **0** 条,但该节点的**非 user 席位**里有一条的角色**该 actor 按服务端记录确实在**(`user_roles` / `users.role`),**且**该节点的人类 approve 行数 ≤ 该节点的 assignment 行数 | 席位 = actor 本人 | **`P22(a)`**(第二次自我推翻的见证)、**`P23(a)`**、**`P24(a)`** |
| 有 `nodeKey`;命中 **0** 条,该节点有非 user 席位,但 actor **不在**其中任何一个角色里 | **阻断** `seat_unresolvable` | **`N15(a)`**(门审 FORGERY2:第三人批的角色节点)、**`N16(a)`**(角色只存在于 dev-token) |
| 有 `nodeKey`;命中 **0** 条,actor 在角色里,但该节点的 approve 行数 **>** 该节点的 assignment 行数 | **阻断** `seat_unresolvable` | **`N14(a)`**(门审 FORGERY:两条行压在一席上,会签 2→1) |
| 有 `nodeKey`;命中 **0** 条,且该节点在本单上**没有**非 user 席位(节点不存在,或是别人的 user 节点) | **阻断** `seat_unresolvable` | **`N11(a)`**(伪造节点)、**`N13(a)`**(指着第三人 E 的节点) |
| 有 `nodeKey`;命中 **>1** 条(节点再入改写了委托) | **阻断** `seat_unresolvable` | **`N17(a)`**(第 3 轮 P2-1 补腿;夹具级 INSERT 造 `is_active=FALSE` 孪生行,端到端未走) |
| (actor **没有**被委托席位,任何 `nodeKey`) | 席位 = actor 本人 | `P19(a)`(**爆炸半径闸门**) |

**⚠ 本轮的一次自我推翻,记在这里而不是抹掉。** 上面那张表的**第一版**把「行有 `nodeKey`」当成
「这行属于某个节点席位」的充分条件。这是错的,而且错得可以把**整组阻断**用一个垃圾字符串走过去:
legacy `POST /:id/approve` 把请求体的 `metadata` **逐字**写进 `approval_records.metadata`,
所以 `nodeKey` 是**调用方给的**,不是系统写的。**实测(修复前,真库,走 shipped 路由)**:
发 `{"metadata":{"nodeKey":"totally_made_up_node_that_never_existed"}}` ⇒ **不抛、席位 `[D]`** ——
裁决明文禁止的那个回退,代价是多打 8 个字。修法是**换判据而不是加过滤**:先问 actor 有没有被委托席位,
有才要求这个名字**在 assignment 表里有凭据**。`N11(a)` 是那个见证,`P20(a)`(传真实 `nodeKey` ⇒ 席位 `[A]`)
把红的原因归因到**凭据**而不是「legacy + metadata 一律拒」。
(这条洞是独立审阅提出、我构造复现后才改的;第一版已 push 的 head `81c2a8f3b6` 带着它。)

**⚠ 第二次自我推翻:凭据修法的第一版把一张完全诚实的单据判成了永久不可撤销。** 上面那条修法的
**第一个写法**是「`nodeKey` 必须命中该 actor 自己的 **user** assignment 行」。**实测(真库,全程
`/actions`、根本不碰 legacy 路由)**:一个人**在角色节点亲自决定** + **在 user 节点是 A 的代理**,
角色节点的席位行 `assignee_id` 是**角色**(`admin`)不是人 ⇒ 该 actor 在那里没有 user 行 ⇒ 判成
`seat_unresolvable` ⇒ **409、零行,这张单据永远开不出撤销轮**。第一版 commit(`81c2a8f3b6`)在同一格
答的是 `{A, D}`,所以这是一次**对基线的回归**,不是「更严格」。
判据因此改成两问:命中 0 条时,再看该节点在本单上有没有**非 user 席位** —— 有,说明 actor 是通过那种
席位决定的,而委托替换**只动 `assignmentType === 'user'` 的席位**(`pushResolved`),非 user 席位
**没有东西可还原**,也就不构成脱身路径 ⇒ 坐下 actor(`P22(a)`);没有,说明那个节点要么不存在、
要么是**别人的** user 节点,指着它不等于在那里有席位 ⇒ 阻断(`N13(a)`)。

**⚠ 第三次自我推翻(门审第 3 轮 P1 / P2-2):上一段那条「放宽的代价」写错了,而且被它描述的那一臂
本身是缺陷。** 旧文的原话是「被委托人指着真实存在的角色节点仍可能被按本人坐下……与 `P21(a)` 同族,
方向同样是『自己留席/自减席』而不是白拿别人的席位」。**两处都被真库实测证伪:**

- **方向相反。** 门审 FORGERY:被委托人把自己那条 legacy 行的 `nodeKey` 报成**角色节点**,两条 approve
  行一起折到角色节点上 ⇒ **A 一个席位都没有**、会签门槛 **2 → 1**。他拿走的正是裁决指派给 A 的那一席,
  与 `P21(a)` 的「把自己摘出去」**方向相反**。
- **连「在那个角色里」都不需要。** 门审 FORGERY2:角色节点由**第三人 E** 决定,被委托人既不是该角色成员、
  也从未决定过那个节点,**仅仅说出节点名字**就被坐下了 —— 这直接证伪了实现里那句承重注释
  (「the actor decided it through that seat」)。
- **而且它只有散文没有腿。** mutation `M-G`/`M-v`(把这一臂关掉)当时只红 `P22(a)`,即现有覆盖只钉了
  「**不得阻断**」一个方向,**没有任何用例钉「不得把被委托人坐下」**。

**修法(本轮落地,取最严)**:非 user 席位臂要放行,必须有**服务端凭据的两半**,缺任一半 ⇒ 阻断
(复用 `seat_unresolvable`,零新码):

1. **成员身份** —— 该节点的非 user 席位里,至少有一条的角色是该 actor 按**服务端写入的记录**持有的
   (`user_roles.role_id` ∪ `users.role`)。这不是另造判据:生产 token 的 `role` 声明就是从这个底座算出来的
   (`AuthService.createToken` 签 `role: user.role`,`resolveRbacProfile` 用 `users.role` + `user_roles`);
   `roles` **数组**声明只有**测试用**的 `GET /api/auth/dev-token` 会铸(`jwt.sign` 站点普查:
   `AuthService.createToken` 与 `routes/auth.ts` 两处,生产路径零处),所以夹具改成**生产形状**
   (`P22(a)` 现在往 `user_roles` 写那条成员记录)而不是把凭据做成 fail-open。
2. **基数** —— 该节点的**人类** approve 行数 ≤ 该节点的 assignment 行数。只有成员身份那一半挡不住
   FORGERY(那里 D 是**真**成员,只是把两条行压在一席上)。计数在 **TypeScript** 里做、在哨兵丢弃**之后**,
   不在 SQL 里做(SQL 里重写 `isSystemSentinelActor` 会把自动审批行算进预算,重开 G6-1)。

**落地前的 ratio 普查(门审点名的前置条件,实测)**:在七个 `approval-cancel-round-*.db.test.ts` 的语料上
用 INSERT 触发器抓全量,得 **60** 组 `(instance, node)`,其中 **58** 组在预算内(8 组 2 行/2 席、
48 + 2 组 1 行/1 席),**恰好 2 组**超预算且**两组都是故意造的不诚实夹具** —— `N11(a)` 的不存在节点
(1 行 / 0 席)与 `P21(a)` 的 legacy 改名(2 行 / 1 席);后者走的是 **user 席位臂**,本轮的基数合取
**故意不管**它(那条残留仍归 owner)。

**凭据的代价,写清楚(这是真代价,不是免责声明)**:成员身份是**当下**读的 —— 决定时刻的成员关系本仓
今天不落库,所以「当时在、现在不在」与「从来不在」在库里同形,**两者都阻断**。`N16(a)` 就是这条代价钉成
数据:一张与 `P22(a)` 逐字段同形的诚实单据,只因为 D 的 admin 身份只存在于 dev-token 里而阻断。
**爆炸半径(实测)**:凭据只对「在本实例上持有被委托席位」的 actor 生效(第一臂先返回),所以整个无委托语料
(`P19(a)`、`P15(a)` 以及所有没有委托的 legacy 单据)**不受影响**。要放宽,需要「决定时刻角色快照」或
「legacy 路由自己写 `nodeKey`」,**两条都是 owner 裁**,已登记设计 MD §3.4。

**仍然存在的残留,点名**:基数是**预算**不是身份 —— 角色节点若配了两个角色 id 就有两行席位、预算有富余,
一个**恰好**是其中某个角色成员的伪造者仍能两半都通过。`N15(a)` 故意跑在这种富余形状上(这正是它能
**隔离**成员身份那一半的原因),腿内注释点名了这条残留。

出口:**复用既有 `CANCEL_ROUND_SEAT_INELIGIBLE`**,`details = { ineligibleCount, reasons }` 形状不变,
只扩了 `reasons` 的词汇(+`seat_unresolvable`、+`delegate_not_seat`)。**零新增错误码**,锁 §14.3 无需改。
机械核:src diff 的 `+` 行里新增大写错误码字面量 **0**(`grep -c "'CANCEL_ROUND_[A-Z_]*'"` 只命中既有的
`CANCEL_ROUND_SEAT_INELIGIBLE`)。

**`original_ineligible` 没有加** —— 理由与请示写在 design MD §3.1 的实现者勘误块里,不在这里重复。
它的**行为**由既有词汇回答且被 `N5(a)` / `N10(a)` 实测(停权原主体 ⇒ `reasons: ['inactive']`)。

## O2. 本轮实跑台账(全部本地实跑,非转抄)

| 编号 | 内容 | 实测 |
|---|---|---|
| 七件真库套件 | `approval-cancel-round-*.db.test.ts`,`--config vitest.integration.config.ts`,`EXPECT_DB=1` | **7 files / 86 passed / 0 failed**(裁决前 75;+11 = 本轮新腿) |
| `-creation` 单件 | 同上 | **44 passed**(裁决前 33) |
| 委托邻居 7 件 | `approval-delegation-api` / `-seam` / `-selfservice`、`approval-departure-transfer`、`approval-node-entry-epoch`、`approval-bulk-reassign`、`approval-prior-node-approver` —— **本轮逐个点名,不写「六件」** | **7 files / 47 passed / 0 failed** |
| `tsc` | `npx tsc --noEmit -p tsconfig.json` | **EXIT=0,零输出**(注:该 tsconfig `exclude` 了 `**/*.test.ts`,所以它**不**覆盖测试文件 —— 写成读数,不当成「测试也类型检查过了」) |
| `CI=true` core-backend 全量(**第一版**,凭据修法之前) | 默认 `vitest.config.ts` | **1124 files / 1113 passed / 10 failed / 1 skipped**;16722 tests / 16671 passed / 25 failed / 5 skipped |
| `CI=true` core-backend 全量(**本 head**,角色凭据之后) | 同上 | **1124 files / 1116 passed / 7 failed / 1 skipped**;**16722 tests / 16675 passed / 21 failed / 5 skipped** —— 与凭据修法那一版**逐字相同**(同一 7 件、同一计数),两次独立整跑 |

**两次全量的失败集合本身会漂移,这件事就是「共享库干扰而非回归」的证据**:第一次的 10 件里,
`multitable-l4-canonical-fence-realdb` / `-w11-bridge-formula-freshness-realdb` / `-w13-fieldperm-writegate-bridge-realdb`
三件第二次**根本没红**,而它们第一次也**单跑全绿**。本 head 的 7 件 = 第一次那 10 件减去这三件。

**逐件除名,判据三条而不是两条:**

| 文件 | 判据一:token census(`createCancelRoundInstance\|cancel[._-]?round\|CANCEL_ROUND\|approval_rounds\|delegatedFrom\|approval_delegations\|SEAT_INELIGIBLE\|delegate_not_seat\|seat_unresolvable`) | 判据二:单跑 | 判据三:**在 BASE 源码上重跑**(`cp` 还原到 `cc897234eb` 原状,`git diff --stat` 空) |
|---|---|---|---|
| `approval-amount-total-check.api` | **0** | 仍红 | **BASE 同样红,计数逐字相同**(`Tests (3)`) |
| `approval-node-timeout-effects` | **0** | 仍红 | **BASE 同样红,`11 failed / 2 passed (13)` 逐字相同** |
| `approval-wp1-parallel-gateway` | **0** | 仍红 | **BASE 同样红** |
| `multitable-oapi2a-comments-write-realdb` | **0** | 仍红 | **BASE 同样红,`3 failed / 1 passed (4)` 逐字相同** |
| `multitable-l4-canonical-fence-realdb` | **0** | **单跑全绿** | 第二次全量**未红** ⇒ 共享库干扰 |
| `multitable-w11-bridge-formula-freshness-realdb` | **0** | **单跑全绿** | 同上 |
| `multitable-w13-fieldperm-writegate-bridge-realdb` | **0** | **单跑全绿** | 同上 |
| `sealed-export-s6a-runtime-authority.db` | **0** | `permission denied to create role`(**42501**,日志里 3 次) | 本任务硬约束所致(库 owner `ms2testbed` 非超级) |
| `sealed-export-s6a-grant-repair.db` | **0** | 同上 | 同上 |
| `sealed-export-s6a-authority-row-lock.db` | **0** | 同上 | 同上 |

**判据三是本轮新加的,也是唯一一条真正有判别力的**:前两条只能说明「看起来无关」,
**把我的改动撤回去再跑一遍**才能区分「本环境既有」与「我弄红的」。四件全部在 BASE 上以**逐字相同的计数**
失败 ⇒ 除名。(这也是本仓「证修复必须把旧实现也跑一遍」那条规矩的反向用法。)

**七个 cancel-round 文件不在这 1124 件里** —— 默认 `vitest.config.ts` 把它们整组 `exclude` 掉了,
所以全量那一组证的是「**其余**没有回归」,本轮 39 条腿由上面第二行覆盖。两组不重叠、不可互相替代。

## O3. 判别力(逐条反转 → 贴红)

把 `-creation` 复制成一次性文件 `zz-c1a-inversion-probe.db.test.ts`,**只改副本**,对本轮
新增/改写的 **10 条腿各反转一处核心断言**(`diff` 恰好 **22 行**改动 = 10 处 + describe 标题)。

**读数:10 failed / 29 passed (39)** —— 红的正是 `P12(a) N7(a) N8(a) P13(a) P16(a) N9(a) N10(a) P17(a) P18(a) P19(a)`,
**29 条未被触碰的老腿一条不红**(证明反转是定点的,不是把文件弄坏了)。跑完即 `rm`。

**第三轮反转(角色凭据的两条新腿,单独一次)**:`P22(a)` 的 `[A, D]` → `[D]`、`N13(a)` 的
`['seat_unresolvable']` → `['delegate_not_seat']`。读数 **2 failed / 42 passed (44)**,红的正是这两条。

**第二轮反转(凭据修法的三条新腿,单独一次)**:`N11(a)` 的 `['seat_unresolvable']` → `['delegate_not_seat']`、
`P20(a)` 的 `[A]` → `[D]`、`P21(a)` 的 `[A]` → `[D]`。读数 **3 failed / 39 passed (42)**,
红的正是这三条,其余 39 条不动。

反转的具体内容(每条一处,互不重叠;行号是副本里的):
`P12/N7/N8/P13` 把 `reasons: ['delegate_not_seat']` → `['inactive']`;
`N9` 把 `['seat_unresolvable']` → `['delegate_not_seat']`;`N10` 把 `['inactive']` → `['seat_unresolvable']`;
`P16` 把 `[A, B]` → `[D]`;`P17` 把 `[A]` → `[D]`;`P18` 把 `[A, C]` → `[D]`;`P19` 把 `[A]` → `[]`。

## O4. Mutation 台账(`cp` 备份 → 改 → 跑 → `cp` 还原 → `cmp`)

备份基准 sha256 `2dbadf47…`;每次施加前 `diff` 确认真的变了(不做无效 mutation)。

| 编号 | 内容(机械核) | 实测 | 还原 |
|---|---|---|---|
| **M-D**(裁决要求的那条)| 把 `delegate_not_seat` 臂**退回「席位 [D]」**(`unseatableRowCount += 1; reasons.add(...)` → `seatIds.push(actorId)`,`diff` 恰好 3 行) | **4 failed / 35 passed (39)** —— 红 `P12(a) N7(a) N8(a) P13(a)`;`N9(a)` **不红**(它走另一条臂) | `cmp` identical |
| **M-E** | 把 `seat_unresolvable`(无 `nodeKey` × >1 委托人)臂退回「席位 [D]」 | **1 failed / 38 passed (39)** —— 红**只有** `N9(a)` | `cmp` identical |
| **M-B** | 删 `node_delegators` 子查询里的 `AND a.node_key = r.metadata->>'nodeKey'`(`diff` 恰好 1 行) | **5 failed / 34 passed (39)** —— 红 `P11(a) P16(a) N9(a) N10(a) P14(a)` | `cmp` identical |
| **M-C** | `assertCancelRoundSeatsEligibleInTxn` 函数体首行插 `return`(`diff` 恰好 1 行) | **10 failed / 32 passed** (`-creation` + `-seat-guards` 两件 42 条) —— 红 `N1 N2 N4 N5(a) P12(a) N7(a) N8(a) P13(a) N9(a) N10(a)`(裁决前这条 mutation 只红 5 条) | `cmp` identical,sha256 回 `2dbadf47…` |

| **M-F**(凭据判据)| 把「命中必须恰好 1 条」退回修复前的「只看被委托行,>1 才拒」(`diff` 2 行) | **1 failed / 41 passed (42)** —— 红**只有** `N11(a)`,即那条伪造 `nodeKey` 的腿 | `cmp` identical,sha256 回 `a680a476…` |

| **M-G**(角色让路)| 把「该节点有非 user 席位 ⇒ 坐下 actor」那一臂关掉(`if (false)`) | **1 failed / 43 passed (44)** —— 红**只有** `P22(a)` | `cmp` identical |
| **M-H**(凭据阻断)| 把同一臂改成无条件放行(`if (true)`,= 根本不阻断) | **2 failed / 42 passed (44)** —— 红**只有** `N11(a)` 与 `N13(a)` | `cmp` identical,sha256 回 `36892fa2…` |

**M-G 与 M-H 是同一行的两个相反方向,一起把那一臂夹死**:关掉它,诚实的角色单据红(且**只有**它红);
放开它,两条伪造/冒名腿红(且**只有**它们红)。中间没有第三种答案能同时让四条腿绿。

**M-F 证明的事**:凭据判据是**独立承重**的,而且它的红**只落在**伪造腿上 ——
`P20(a)`(真实 `nodeKey`)在 M-F 下仍然绿,所以这条修法**没有**顺手把合法的 metadata 也拒掉。

**M-D 与 M-E 一起证明的事**:两条阻断臂**各自独立承重**,不是一条判据被写了两遍。
**M-C 证明的事**:新的阻断走的是**同一个出口**(唯一 throw 站点),neuter 掉它两类 reason 一起失效 ——
这正是「不另造第二个 throw 站点」这个设计选择的反向证据。

## O5. 本轮**没有**做的(如实列)

- **`seat_unresolvable` 的第二条臂(有 `nodeKey` × 同 `(instance, node, assignee)` 两个不同
  `delegatedFrom`)NOT CONSTRUCTED。** `idx_approval_assignments_active_unique` 是
  `WHERE is_active = true` 的部分唯一索引,造它需要一次真正的节点再入去改写委托。
  该 **reason 值**由 `N9(a)` 的另一条臂实测覆盖;**那条具体分支的行为是按代码推出的,不是实测的** —— 写清楚。
- **已登记的残留(二):凭据判据证不了「actor 是那个角色的成员」。** `approval_assignments` 对 role 席位
  只记角色 id,成员关系在决策时刻由 JWT 的 `roles` 判、不落库。所以被委托人指着**本单上真实存在的角色节点**
  仍可能被按「本人」坐下而不是被还原。方向与下一条同族(自己留席),**本轮不修**,已登记。
- **已登记的残留(一):凭据判据证得了「这个节点该 actor 真的有席位」,证不了「这一行结的就是那个节点」。**
  被委托人若**同时**在别的节点有自己的席位,可以在走 legacy 时把 `nodeKey` 报成**被委托的**那个节点 ⇒
  两条行都还原成 A、**他把自己从撤销轮里摘了出去**,会签 2 → 1(诚实同形单据 `P11(a)` 答 `{A, D}`)。
  **MEASURED,`负控 P21(a)` 钉住**。失败方向是「自己减席」而不是「白拿席位」,且要求该 actor 真的两头都有席位。
  修它要么让 legacy 路由自己写 `nodeKey`(shipped 端点的合同变更),要么按「席位数 vs approve 行数」对账
  (会误伤诚实语料)—— 两条都属 owner,本轮**不做**,已登记进设计 MD §3.4。
- **没有**把裁决外推到 `loadPriorNodeApproverDeciders`(设计 MD §3.4 的 OPEN 登记原样保留;`P14(a)` 仍钉今天的答案)。
- **没有**修「会签节点上多人委托同一人 ⇒ 建单时席位折叠」(`P17(a)` / `P18(a)` 钉今天的答案,
  新登记进设计 MD §3.4;修它要动 `pushResolved` 的 dedup 键,属 owner)。
- **没有**做 legacy × 委托 的**存量普查**(需要生产库,不在本轮授权内)。爆炸半径因此写成
  「谓词 + `P19(a)` 正控」,**不写成「影响很小」**。
- **没有**新增错误码、**没有**改锁文正文、**没有**合并 / undraft / 开 PR、**没有**对任何共享 / staging /
  生产库应用迁移或 DML(本轮只设 `DATABASE_URL` 指向一次性库;`ATTENDANCE_TEST_DATABASE_URL` 未设,
  仓内该变量只从 `process.env` 读、无硬编码默认;跑前 `psql` 核过 `current_database()`)。
- **没有**跑 required `test (20.x)` 的完整清单 / 前端套件 / 浏览器。
- **一次本轮自己造成、本轮自己清掉的夹具残留,如实记**:O1 的形状测量用了一个一次性探针文件,
  它插的 16 行 `approval_delegations`(`id LIKE 'pbdl%'`)没有 `afterAll`,
  于是委托邻居套件的 `approval-delegation-seam` 第一次跑**红了一条**。
  `DELETE ... WHERE id LIKE 'pbdl%'`(**只删我自己插的 16 行**,表回 **0 行**)之后重跑 **47/47 全绿**。
  这正是本仓 §N5 那条残留链的同族,**是我犯的,不是候选的语义问题** —— 记在这里而不是删掉。

## O6. C-2 锚点重测(**本轮必须重写的一条:旧的正向锚点现在恒为 0**)

> **求值标记(勿整节作废)。** 本节**取代** §N6 与 Part N-H §NH6 里关于 C-2 的**锚点与树 SHA**;
> 那两处的其余结论(「C-2 已坐在 C-1 基线之上」「三方合并实测干净」「逐提交重放未实跑」)
> 在本 head 上**重测仍然成立**,保持 OPERATIVE。

**先说为什么必须重写,而不是补个数字。** §N6 / README §9-8 给 C-2 的判据是:
「解完冲突之后跑正向锚点 `COALESCE(a.metadata->>'delegatedFrom', r.actor_id)`,在 C-2 全文必须**恰好 1 处**」。
那条锚点是**候选第一版**席位查询的字面量。裁决落地后席位查询被整段重写,**本 head 的 `ApprovalProductService.ts`
里该字面量是 0 处**(机械核,见下表)。照旧判据执行的人,在一次**完全正确**的重放之后会读到 **0**,
只能得出「解反了」—— 这正是那条判据当初被写出来要防的那个失效,**它自己现在犯了同一个错**。
(同族:旧的旧判据 `SELECT DISTINCT actor_id FROM approval_records` 也早已在 C-1 侧归零,§N6 已勘误过一次;
**一个会随实现变化的字面量做锚点,就会需要第二次、第三次勘误** —— 所以下面同时给出「怎么核」和
「锚点失效时该怎么办」,而不是只换一个新字面量。)

### O6.1 机械核(`git grep -c`,对象是 commit,不是工作树)

C-1 head = `8b29b4a2ce6b90d7fc49a052538dc713e12da224`;phase2 head = `6a40f0121a36d7e54fde98088ca68212653403bf`。
以下全部限定在 `packages/core-backend/src/services/ApprovalProductService.ts`:

| 字面量 | C-1 head | phase2 head | 判定 |
|---|---|---|---|
| `SELECT DISTINCT actor_id FROM approval_records`(**最早**的判据) | **0** | **1**(`:8808`) | 早已失效,§N6 勘误过 |
| `COALESCE(a.metadata->>'delegatedFrom', r.actor_id)`(**§N6 / README §9-8 现行判据**) | **0** | **0** | **本轮失效** —— 两头都是 0,零判别力 |
| `node_actor_user_seats` | **4** | **0** | **新判据** |
| `node_non_user_seat_count` | **4** | **0** | **新判据** |
| `instance_delegators` | **4** | **0** | **新判据** |

**⚠ 勘误(门审第 3 轮 P3-1):这里原来写的是「三个新 token 在整棵树上只出现在这一个文件里(各命中 1 个
文件)」—— 那是一句**自指快照**:写下它的那次提交(`61b37fd6ef`)把三个 token 的名字写进了这份 MD,于是
它一落地就把自己变成假的(实测:各命中 **2** 个文件)。快照换成**可复算判据**,不再写「只有一个文件」:

```
git grep -c '<token>' <head> -- packages/core-backend/src/services/   # 判据:恰好 1 个文件、各 4 次
git grep -c '<token>' <head> -- docs/ packages/core-backend/tests/     # 允许 >0:文档/测试引用不参与判据
```

判据**限定在 `packages/core-backend/src/services/` 路径下**,所以无论这份 MD、README 还是测试文件怎么引用
这些名字,判据的读数都不变 —— 稀释问题按构造消失,而不是靠一句「不会被稀释」的声明。
(本轮 token 名字随实现改了,见 §O7.4 的新表;核对**永远**以「当时 head 上现算」为准。)

### O6.2 C-2 重放后的判据(**取代** §N6 / README §9-8 的那一条)

1. **正向**:三个 token 在 C-2 的 `ApprovalProductService.ts` 里必须各按 **§O7.4 的表**出现,且都落在
   `createCancelRoundInstance` 体内。**⚠ 本条的 token 名单在本轮变了**(凭据修法把
   `node_non_user_seat_count` 换成了 `node_actor_role_seat_count` + `node_seat_row_count`)——
   这正是本节第 3 条预告的情形:**按当时 head 现算,不照抄**。
2. **反向**:`SELECT DISTINCT actor_id FROM approval_records` 必须**归 0**(phase2 侧那 1 处就是被覆盖的目标)。
   —— 正反两条一起,才能区分「合上了」与「把 C-1 的新代码丢了」;只有正向那条时,
   一次「两边都保留」的错误解法照样绿。
3. **锚点失效时怎么办(写出来,免得下一个人再补一次勘误)**:这三个 token 是**标识符**不是 SQL 字面量,
   但它们**仍然会随实现改名**。核对前先在**当时的 C-1 head** 上重跑 O6.1 那张表拿到当时的真值,
   **不要**照抄本节的数字;若三个 token 在 C-1 head 上也归 0,说明席位推导又被重写了,
   **应当重新推导锚点而不是判 C-2 解反了**。

### O6.3 合并事实(**已被 §O7.4 取代** —— 本节的表钉在 `8b29b4a2ce`,不是交付 head)

> **求值标记**:本节的**树 SHA 与 head** 已失效(门审第 3 轮 NIT-1:表头写「C-1 head `8b29b4a2ce…`」
> 而当时的交付 head 是 `61b37fd6ef`;本轮又前进了一次)。**结论性的那两句仍然 OPERATIVE**:
> 切片基线是 phase2 的祖先、三方合并干净。现行数值见 **§O7.4**,那里给的是**命令**而不是要背的常数。

| 项 | 实测(C-1 head `8b29b4a2ce…`) |
|---|---|
| `git merge-base --is-ancestor b8b71539a6… origin/feat/approval-cancel-round-phase2` | **YES** |
| `git merge-base <C-1 head> <phase2 head>` | **`b8b71539a6a89e51331e2e4874f994498df15c55`** |
| `git merge-tree --write-tree <C-1 head> <phase2 head>` | **EXIT 0**,树 **`805e6ca2cf6561a526cd0883512be3e56f122682`** |

**这个树 SHA 按构造随 C-1 head 变化**(§NH6 漏钉 head 已经造成过一次下游误读,门审第 2 轮 P3-A)。
它**只对 `8b29b4a2ce…` 有效**;C-1 head 一动就必须重算,**不要**拿本节的值去核别的 head。
**三方合并干净 ≠ 逐提交重放干净**:rebase **本轮仍未实跑**,两句分开写。

### O6.4 非版本化工作件的同步(门审第 2 轮 P3-B)

`~/.claude/projects/<proj>/soak-working/c1-delegation-candidates-20260920/README.md` **不在 git 下**,
任何门 / CI / reviewer 都取不到它。它的 §9-8 带着同一条已失效的 `COALESCE` 判据;本轮已就地勘误,
**但承重的一份是本节** —— 引用时以本节为准,README 只当本地便签。

---

# Part O-R4. 门审第 3 轮修复(2026-09-20/21):非 user 席位臂的服务端凭据

> **范围**:本节记录 **P1 / P2-1 / P2-2 / P3-1** 的修复与实测。读法 (a) **仍是候选**,owner 未裁;
> 本轮只把候选做到「不静默回退给历史被委托人」在**所有**语料下成立。**未合并、未 undraft、未开 PR。**

## O7.1 修了什么(逐条对门审)

| 门审条目 | 修法 | 承重腿 |
|---|---|---|
| **P1**(裁决未完整实现:非 user 席位臂可被请求体的 `nodeKey` 走过去)| 该臂放行需要**服务端凭据的两半**,缺任一半 ⇒ 阻断(复用 `seat_unresolvable`,**零新码**):①**成员身份**(该节点某条非 user 席位的角色,该 actor 按 `user_roles` / `users.role` 确实持有);②**基数**(该节点的**人类** approve 行数 ≤ 该节点的 assignment 行数,计数在 TS 里、在哨兵丢弃之后) | 负控 `N14(a)`(FORGERY)、`N15(a)`(FORGERY2)、`N16(a)`(严格性代价);正控 `P23(a)` / `P24(a)`(门槛 2 席的见证) |
| **P2-1**(`actorUserSeats.length > 1` 臂是未测守卫)| 按门审给的配方补腿:`is_active = FALSE` 的孪生席位行、同一 (instance, node, assignee)、不同 `delegatedFrom` | 负控 `N17(a)` —— mutation **M-vi 现在恰好红它一条** |
| **P2-2**(设计 MD `:515-517` 定性不准、且该臂只有散文没有腿)| 整段按实测重写(方向是**拿走别人的席位**、actor **不必**是角色成员、`M-v` 只钉了「不得阻断」一个方向);两个方向现在都有腿 | 设计 MD「The widening's own cost — REWRITTEN」段 + 上面四条新腿 |
| **P3-1**(§O6.1 的「只出现在这一个文件里」是自指快照)| 换成**路径限定的可复算判据**(`-- packages/core-backend/src/services/`),不再声明「不会被稀释」 | §O6.1 勘误段 |
| **NIT-1**(§O6.3 的表钉在上一个 head)| §O6.3 打求值标记,数值迁到 §O7.4,并且给**命令**而不是常数 | §O6.3 / §O7.4 |
| **(本轮自查,非门审条目)`source_queue` 席位**| 成员身份那一半只能命中**角色** id,`source_queue` 的 `assignee_id` 是权限/队列 token(桥写入,dispatch 按**权限**匹配)⇒ 该类单据现在**阻断**。**登记为缺口,不在本轮加宽**(加宽到权限是另一条 owner 裁,且需要自己的普查) | 源码 REGISTERED GAP 段 + 设计 MD;**今天没有腿**,写明 |
| **(本轮自查)`user_roles` 可达性**| 新 SQL 硬引用 `user_roles`;若该表缺失会把 409 契约答案变成 500。**实测论证见 §O7.5**,结论:不可达,**不加未测分支** | §O7.5 |

## O7.2 落地前的 ratio 普查(门审点名的前置条件)

门审 §1.5 要求「落地前必须先对现有 86 腿核 ratio」。做法:在一次性库上给 `approval_records` /
`approval_assignments` 装 **AFTER INSERT 触发器**把每一行镜像进两张 `zz_census_*` 表(因为各套件的
`afterAll` 会把语料删干净,跑完再查恒为 0 行),然后跑全部七个 `approval-cancel-round-*.db.test.ts`。

**两次读数,分开写(它们的语料不同,不能混用)**:

**(i) 落地前 —— 86 腿语料(门审点名的那次)**:**81 条 approve 行 / 142 条 assignment 行 → 60 组**;
**58 组在预算内**(8 组 2 行/2 席、50 组 1 行/1 席),**恰好 2 组超预算,且两组都是故意造的不诚实夹具** ——
`N11(a)` 的不存在节点(1 行 / 0 席)、`P21(a)` 的 legacy 改名(2 行 / 1 席)。

**(ii) 交付 head —— 92 腿语料(含本轮六条新腿,重跑一次)**:**92 条 approve 行 / 160 条 assignment 行 → 69 组**

| 该节点的人类 approve 行数 | 该节点的 assignment 行数 | 组数 | 判定 |
|---|---|---|---|
| 1 | 1 | 55 | 预算内(其中 4 组是**角色节点**) |
| 2 | 2 | 9 | 预算内(会签节点 8 组 + `N15(a)` 的两角色席位节点 1 组) |
| 1 | 2 | 2 | 预算内(`P24(a)` 的诚实版 + 兄弟) |
| 2 | 1 | 2 | **超预算** —— `P21(a)` 的 legacy 改名、**`N14(a)` 的伪造**(两条行压在一席上) |
| 1 | 0 | 1 | **超预算** —— `N11(a)` 的不存在节点 |

**66/69 在预算内;超预算的 3 组全部是故意造的不诚实夹具**(机械核:逐组 `actors` 列都是
`…selfdrop…` / `…g3cred-forgery…` / `…g3dlg-forged…` 三个夹具的 id)。
`P21(a)` 走的是 **user 席位臂**,本轮基数合取**故意不覆盖**它(那条残留仍归 owner,见设计 MD §3.4);
`N14(a)` 正是被这条合取挡住的那一组。

**做法**:在一次性库上给 `approval_records` / `approval_assignments` 装 **AFTER INSERT 触发器**把每一行
镜像进两张 `zz_census_*` 表(因为各套件的 `afterAll` 会把语料删干净,跑完再查恒为 0 行),跑完即
`DROP TRIGGER`;census 表留在一次性库里随库一起 `dropdb`。

## O7.3 实测台账(全部在一次性库 `metasheet2_c1_a_r2_20260921` 上;owner `ms2testbed`,非超级)

### 套件

| 跑 | 命令 | 结果 |
|---|---|---|
| 基线(改动前) | 七件 `approval-cancel-round-*.db.test.ts`,`EXPECT_DB=1` | **7 files / 86 passed** —— 与门审第 3 轮读数**逐字相符** |
| 交付(改动后) | 同上 | **7 files / 92 passed / 0 failed**(86 + 6 条新腿) |
| 创建件单跑 | 仅 `-creation` | **50 passed**(44 + 6) |
| 两个邻居件 | `approval-delegation-seam` + `approval-revoke-terminal-guard` | **2 files / 7 passed** |
| `tsc` | `npx tsc --noEmit -p tsconfig.json` | **EXIT 0**,0 行输出 |
| 全量 | `CI=true npx vitest run`(core-backend 默认 config) | **1124 files:1115 passed / 8 failed / 1 skipped**;**16722 tests:16674 passed / 22 failed / 5 skipped** |

**全量失败逐件除名**(机械核:`grep -c "FAIL.*cancel-round"` = **0**):

| 文件 | 原因 | 与本分支相关? |
|---|---|---|
| `approval-node-timeout-effects.test.ts` | 本环境既有(第 1/2/3 轮同读数) | **0** |
| `approval-wp1-parallel-gateway.api.test.ts` | 同上 | **0** |
| `approval-amount-total-check.api.test.ts` | dev-token fetch 无响应 | **0** |
| `multitable-oapi2a-comments-write-realdb.test.ts` | 同上 | **0** |
| `sealed-export-s6a-runtime-authority.db.test.ts` | `permission denied to create role` | **0** —— 本任务硬约束所致(库 owner 非超级) |
| `sealed-export-s6a-grant-repair.db.test.ts` | 同上 | **0** |
| `sealed-export-s6a-authority-row-lock.db.test.ts` | 同上 | **0** |
| `multitable-cross-base-link-optin.test.ts`(**比门审第 3 轮多出的第 8 件**)| 全量里首条失败是 `socket hang up` / `ECONNRESET`,后续 409;**单跑 18/18 全绿** ⇒ 并行/共享库 flake | **0** —— 机械核:该文件对 `ApprovalProductService` **零引用** |

### Mutation 网格(每个单点隔离;`cp` 备份 → 改 → 跑 → `cp` 还原 → `cmp` identical)

备份基准 sha256 `920c8152b5bcfd9843c253bdb416f3d365af51589f13407249936f39ded36e48`(本轮**改动后**的文件)。
**M-i…M-vi 沿用门审第 3 轮的编号并全部重跑(不回退),M-vii / M-viii 是本轮新加的两条合取专用格**:

| # | 改动 | 实测红 | 判定 |
|---|---|---|---|
| **M-i** | `delegate_not_seat` 臂 → 坐下 actor | **4 红**:`P12(a) N7(a) N8(a) P13(a)` | 与门审读数**逐条一致** |
| **M-ii** | 多委托人 × 无 `nodeKey` 臂 → 坐下 actor | **1 红**:只有 `N9(a)` | 一致 |
| **M-iii** | 末尾「名字无凭据」臂 → 坐下 actor | **5 红**:`N11(a) N13(a) N14(a) N15(a) N16(a)` | 门审时 2 红;本轮四条新腿也落在这条臂上 ⇒ 变 5,**不是回退** |
| **M-iv** | 删「该 actor 从无委托席位 ⇒ 本人」早退 | **2 红**:`P19(a) P15(a)` | 门审时 1 红。**这条 mutation 实测到的是**:早退一旦关掉,`P15(a)` 那个**无委托**的角色审批人也会去过凭据并被拒。**爆炸半径那句结论(「凭据只对持有被委托席位的 actor 生效」)来自早退臂在代码里的位置(它在凭据之前 `continue`),不是来自这条读数** —— 两句分开写,不让结论借断言的光 |
| **M-v** | 非 user 席位臂关掉(`if (false && …)`) | **2 红**:`P22(a) P23(a)` | 「不得阻断」方向仍被钉住 |
| **M-vi** | `actorUserSeats.length > 1` 臂 → 坐下 actor | **1 红**:只有 **`N17(a)`** | **P2-1 关闭**:门审时这里是 0 红(未测守卫) |
| **M-vii**(新)| 删 SQL 里的成员身份 `EXISTS`(= 退回「该节点有非 user 席位」) | **2 红**:`N15(a) N16(a)` | 成员身份那一半承重且已测 |
| **M-viii**(新)| 基数合取恒真(`nodeApproveRows <= nodeSeatBudget + 99`) | **1 红**:只有 **`N14(a)`** | 基数那一半承重且已测,**与成员身份那一半互相隔离** |

**两条新合取互不掩护**:M-vii 只红成员身份的腿、M-viii 只红基数的腿 —— 这正是
`N15(a)` 要跑在「角色节点配两个角色 id ⇒ 预算有富余」形状上的原因(否则基数那一半会替它挡住,
腿就失去对成员身份的判别力)。

### 判别力(逐条反转 → 贴红)

把 `-creation` 复制成一次性 `zz-c1a-r2-inversion-probe.db.test.ts`,对**六条新腿各反转一处核心断言**
(`diff` 恰好 **12 行** = 6 处):`N14/N15/N16/N17` 的 `['seat_unresolvable']` → `['delegate_not_seat']`、
`P23(a)` 的 `[A, D]` → `[D]`、`P24(a)` 的 `[A, E]` → `[E]`。
**读数:6 failed / 44 passed (50)**,红的正是这六条,**44 条未被触碰的老腿一条不红**。跑完即 `rm`,
交付时 `git status --short` 里没有它。

## O7.4 C-2 锚点与合并事实(在**交付 head** 上重算;给命令,不给要背的常数)

**判据是命令,不是数字** —— 数字只对它下面那一行点名的对象有效:

```
git grep -c '<token>' <C-1 head> -- packages/core-backend/src/services/
git merge-tree --write-tree <C-1 head> <phase2 head>
```

| token(限定 `packages/core-backend/src/services/`) | 实测(见本节末尾点名的 head) |
|---|---|
| `node_actor_user_seats` | **1 个文件 / 4 次** |
| `node_actor_role_seat_count`(**本轮新**) | **1 个文件 / 5 次** |
| `node_seat_row_count`(**本轮新**) | **1 个文件 / 4 次** |
| `instance_delegators` | **1 个文件 / 4 次** |
| `node_non_user_seat_count`(**已被替换**) | **1 个文件 / 1 次** —— 只剩注释里对旧写法的引用,**不再是锚点** |
| `SELECT DISTINCT actor_id FROM approval_records`(最早的判据) | **0** —— 反向判据:C-2 重放后必须仍是 0 |

**自指,写在明处**:本节的 token 计数是对**代码提交**测的;本文件最后一次提交只改 `docs/`,
不碰 `ApprovalProductService.ts`,所以上表**不因本节自己的落地而失效**(这正是 §O6.1 那句自指快照
栽过的地方)。**树 SHA 不同** —— 它按构造随**任何**提交变化,包括写下它的那一次;因此下面只登记
「在哪个对象上、用哪条命令、得到什么」,核对时**一律现算**。

**本节所有数值点名的对象**:**代码提交 `f05f7f6c035e69477861a0c11605293f64b045c7`**
(= 本轮最后一次改 `packages/core-backend/src/` 的提交;`ApprovalProductService.ts` 在该提交上的
blob sha256 = `237de2342640dbbd69b8921128f26e2a84fbaa64f749c21832891eae1038ecae`)。
本文件的 docs-only 提交在它之后,**不碰 `src/`**,所以上面的 token 表对**交付 head** 同样成立。

| 项 | 实测(对象 = `f05f7f6c03…`) |
|---|---|
| `git merge-base --is-ancestor b8b71539a6… origin/feat/approval-cancel-round-phase2` | **YES** |
| `git merge-base <C-1> <C-2>` | **`b8b71539a6a89e51331e2e4874f994498df15c55`** |
| **C-2** `git merge-tree --write-tree <C-1> 6a40f0121a…` | **EXIT 0**,树 **`5da51a31924c6605d92ab98454716dd8cc0e8eaf`** |
| **C2F**(`…-phase2-history-projection`,head `616049b711a5f0a57236474ae649fd1af91070a6`)同一命令 | **EXIT 0**,树 **`29b2c5ca2da1684cbc254fb377f7b9c6cdbc76b6`** |

**C-2 与 C2F 的三方合并在本轮交付的代码 head 上仍然干净。**
(对照:同两条命令在中间提交 `c92ebc0eeb…` 上是 `3476ebe146…` / `fdd6532475…` ——
**树 SHA 随每一次提交变化,这正是本节给命令而不给常数的原因**。)
**三方合并干净 ≠ 逐提交重放干净**:rebase **本轮同样未实跑**,两句分开写。

## O7.5 新依赖的可达性论证(`user_roles` 缺表会不会把 409 变成 500)

凭据的成员身份那一半在**同一条** SQL 里引用了 `user_roles` 与 `users`。Postgres 在**解析期**就会对不存在的
关系报错,所以「短路」救不了它 —— 缺表 = 整条查询抛错 = 这条路径上一个**新的** 500。本仓又确实有
「RBAC 表可能缺失」的降级契约(`RBAC_OPTIONAL=1` / `isDatabaseSchemaError` / `rbacDegraded`,
`rbac/service.ts`),所以这不是假想状态,必须论证而不是「接受并记住」。

**论证四条,全部机械核:**

1. **`users` 本来就是这条路径的硬依赖** —— 席位资格闸在同一个方法里读
   `SELECT id, is_active, role, activation_status FROM users …`(`ApprovalProductService.ts:571`)。
   本轮**新增**的依赖只有 `user_roles` 一张表。
2. **`user_roles` 由核心迁移 `20250924190000_create_rbac_tables.ts` 建,且从未被任何 lane 排除** ——
   `grep -rn MIGRATION_EXCLUDE .github/workflows/*.yml` 列出的排除集合里
   `create_rbac_tables` 命中数 = **0**(六个被排除的文件都是 plugin/event-bus/BPMN/gantt/view/user_orgs)。
3. **唯一设 `RBAC_OPTIONAL=1` 的 lane 是 `observability-e2e.yml`,而它先跑 `db:migrate`**
   (排除集合同上,不含 RBAC 迁移)⇒ 在那条 lane 上 `user_roles` **存在**。
4. **`createCancelRoundInstance` 在本 head 上零生产调用方**(无 HTTP 传输层),所以它在那条 lane 上
   根本不会被调用。

⇒ **不为缺表加一条今天不可达、且没有腿的分支**(那会是本仓「另造更窄同类物 / 未测守卫」的同族)。
**若将来 C-2 给它接上 HTTP、或出现一条不跑 RBAC 迁移的部署**,这条论证的第 3/4 条就失效,
必须在那一轮重新求值 —— 判据写在这里,不靠记忆。
