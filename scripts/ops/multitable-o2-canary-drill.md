# O-2 canary drill runbook — L4 (sheet revert) / L5 (PIT reset)

> Companion to `docs/development/multitable-timemachine-o2-enablement-ladder-20260819.md`
> (the ladder). **The ladder governs; this runbook executes nothing by itself.** It is an
> operator checklist: every step is either (a) a read-only SQL observation an operator runs
> against a database they are already authorized to reach, or (b) a manual operator action /
> an EXISTING workflow dispatch that is explicitly **OWNER-GATED** — meaning it must not be
> performed without the per-rung owner authorization the ladder §3 requires (owner 亲笔:
> exact content + target environment + level). This document introduces **no new
> remote-reaching automation** and grants no authorization.
>
> Observation queries referenced as Q1…Q8 live in `scripts/ops/multitable-o2-observation.sql`
> (read-only by construction; self-tested by `scripts/ops/multitable-o2-observation.test.mjs`).

## 0. Scope and hard rules

- Applies to ladder rungs **L4** (`MULTITABLE_ENABLE_SHEET_REVERT`, staging canary) and
  **L5** (`MULTITABLE_ENABLE_PIT_RESET`, staging canary). L7+ production reruns use the same
  checklist with a **separate** canary org and a **separate** owner authorization per rung.
- **Named synthetic org only.** The canary org, its users, sheets, and records are created
  for the drill and contain **no customer data**. Its identifiers are written into the drill
  log *before* the drill starts and pasted into the `EDIT ME` lists of Q3/Q8.
- Flag changes themselves are **not** part of this runbook — they are the rung's own
  owner/ops action (ladder §2/§3). This runbook covers the drill performed *after* the rung's
  flag is on.
- Any step marked ⛔ STOP that fails ⇒ freeze the ladder at the current rung (ladder §3),
  record the evidence, do not proceed.

## 1. Preconditions (verify, do not assume)

- [ ] Rung posture confirmed on the target host. OWNER-GATED: dispatch the existing
  containment workflow `.github/workflows/multitable-recovery-flag-containment-check.yml`
  (`gh workflow run` with `mode=postdeploy-full`, correct `target`) — dispatching it reaches
  the deploy host over ssh, so it requires owner authorization like every dispatch here.
  Expected: the flag legs red **exactly** on the set of flags this rung declares open
  (ladder §3 — 差一个即回滚), schema leg green.
- [ ] Q1 returns 9 rows, all `enabled_state = 'O'` (triggers were enabled at L1; a mixed
  posture here is an immediate ⛔ STOP — partial enablement is fail-closed by design).
- [ ] Q2 returns 6 rows (authority functions present).
- [ ] Q7 returns 0 rows (no sheet parked in `fencing`/`applying`/`paused_retryable`).
- [ ] Drill log opened: date, rung, host, owner-authorization reference (comment link),
  canary org/sheet/user ids.

## 2. Baseline snapshot (read-only)

- [ ] Run the full observation file:
  `psql "$DATABASE_URL" -f scripts/ops/multitable-o2-observation.sql`
  (operator's own authorized DB access; the file itself contains only SELECTs).
- [ ] Record Q4's `xact_commit` / `xact_rollback` / `deadlocks` / `stats_reset` values in
  the drill log — **all later criteria are deltas against this snapshot**, and a changed
  `stats_reset` voids the window.
- [ ] Record Q6 baseline burn count for the canary sheet (normally 0 before the first drill).

## 3. L4 drill — sheet revert canary

### 3.1 Seed and mint

- [ ] In the canary org, create/refresh the canary sheet with a known record set; write the
  expected post-revert state into the drill log *before* executing anything.
- [ ] Mint a revert preview: `POST /api/.../sheets/:sheetId/revert-preview` (route registered
  in `packages/core-backend/src/routes/univer-meta.ts`, `handleExactAnchorPreview`). Record
  the preview's anchor summary in the drill log.

### 3.2 Precise-anchor revert success

- [ ] Execute with the freshly-minted token: `POST /api/.../sheets/:sheetId/revert-execute`.
  Expected: success response; sheet content equals the pre-declared expected state.
- [ ] Q6: burn count for the canary sheet increased by **exactly 1** (one execute = one burn
  row, burned inside the apply's own transaction). Any burn row for a **non-canary** sheet
  at any point in the drill window is ⛔ STOP (unauthorized destructive apply).
- [ ] Q7: 0 rows again after completion (fence state cleared).
- [ ] Replay control: re-POST the **same** token → must refuse (anti-replay burn ledger,
  `meta_recovery_token_burns` PK). Evidence anchor:
  `packages/core-backend/tests/integration/multitable-exact-anchor-apply-realdb.test.ts`.

### 3.3 Preview-drift abort — positive control

This step exists to prove the abort path is **live** in this environment, not just in CI.

- [ ] Mint a fresh preview; then, *after* minting, mutate one canary record through the
  normal write path (so reality no longer matches the preview).
- [ ] Execute with that now-stale token. Expected: **refusal** (preview-drift abort; the
  refusal family is `ApplyRefusalError('preview-drift', …)` in
  `packages/core-backend/src/multitable/exact-anchor-recovery-execute.ts`), **no** data
  change, **no** new Q6 burn row.
- [ ] ⛔ STOP if the execute *succeeds*: the drill's positive control failed — the abort
  path is not protecting this environment. Evidence anchors:
  `packages/core-backend/tests/integration/multitable-exact-anchor-apply-realdb.test.ts`
  (P25 preview-drift gates),
  `packages/core-backend/tests/integration/multitable-exact-anchor-recovery-realdb.test.ts`.

### 3.4 Busy/backoff behaviour (lease contention)

- [ ] While an operator session holds a canary-subject platform write open (e.g. a
  long-running permission change in a transaction), execute a revert. Expected: either
  success after backoff (bounded ladder: `RECOVERY_LEASE_BACKOFF_MAX_ATTEMPTS` fresh
  attempts) or a **named retryable refusal** — never an unclassified 500, never a hang.
  Concurrently sample Q3/Q3b (`\watch 5`) and attach one nonzero sample to the drill log.
- [ ] If exhaustion parks the sheet: Q7 shows `paused_retryable` → re-run the recovery or
  clear per the state machine; a *persisting* Q7 row after the drill window is ⛔ STOP.
  Evidence anchors:
  `packages/core-backend/tests/integration/multitable-recovery-lease-backoff-realdb.test.ts`,
  `packages/core-backend/tests/integration/multitable-recovery-authority-stability-realdb.test.ts`,
  `packages/core-backend/tests/integration/multitable-recovery-authority-unavailable-failclosed-realdb.test.ts`.
- [ ] Platform-write side of the same window: a platform-auth write refused by the held
  lease must surface as the retryable 409 (`RECOVERY_AUTHORITY_BUSY`), not a 500 — check the
  app response the operator sees. (409 counts have **no DB sink** — see the sink inventory
  in the observation file; the count evidence is the app/proxy log, and reading host logs is
  OWNER-GATED like any ssh access.) Evidence anchors:
  `packages/core-backend/tests/unit/recovery-conflict-census.test.ts` (+ the
  `recovery-conflict-surfaces-routes-*.test.ts` behaviour legs),
  `packages/core-backend/tests/integration/recovery-conflict-classifier-realdb.test.ts`.

### 3.5 Foreign-fence link-in concurrent write — no-40P01 check (ladder §4)

The ladder registers the foreign-fence shared-lookup residual and **requires** this step at
L4/L5: one link-in concurrent-write scenario confirming no deadlock.

- [ ] Prepare a second canary sheet ("link-in sheet") with a link field whose records link
  into the drill sheet (`meta_links.foreign_record_id` → drill-sheet records; note there is
  deliberately **no FK** on that column).
- [ ] Start a revert execute on the drill sheet while a concurrent writer session updates
  the link-in sheet's linked records in a loop (normal app write path).
- [ ] Expected: both sides complete — the writer may see transient retryable busy but never
  40P01; the revert succeeds or refuses retryably. **Criterion: Q4 `deadlocks` delta over
  the drill window = 0.** (Q4's `deadlocks` counts SQLSTATE 40P01 exactly; the counter was
  positively controlled against a constructed deadlock when this kit was authored.)
- [ ] ⛔ STOP on any nonzero deadlock delta; attach Q3b samples. Evidence anchor:
  `packages/core-backend/tests/integration/multitable-recovery-foreign-fence-availability-realdb.test.ts`
  (P22 fence availability + deadlock-freedom).

### 3.6 Trash / link state check

- [ ] Paste the canary sheet ids into Q8's `EDIT ME` list and run it.
  Expected: `dangling_links` = 0 rows (or rows with count 0) for the canary set;
  `trash_rows` matches the drill ledger exactly (every trash row explained by a deliberate
  drill delete/revert). Any unexplained trash row or any dangling link ⇒ ⛔ STOP.
- [ ] Restore-path spot check: restore one drill-trashed record and verify it returns with
  its original timestamps (trash table preserves `original_created_at`/`original_updated_at`).

### 3.7 Close the L4 window

- [ ] Re-run the full observation file; verify: Q6 total burns == ledger, Q7 empty,
  Q4 deadlock delta 0, Q5 still empty (0 rows — if not, the observation kit's sink
  inventory is stale; update it before trusting counts).
- [ ] Record the Q4 AFTER values; compute and log deltas.
- [ ] Drill log completed and attached to the rung's observation-window evidence (ladder §2
  L4 criteria). Advancing to L5 is a **separate owner authorization** — nothing in this
  runbook grants it.

## 4. L5 drill — PIT reset canary

Same discipline as §3 with the reset endpoints
(`POST /api/.../sheets/:sheetId/reset-preview` / `reset-execute`):

- [ ] §3.1–§3.2 analogue: pre-declared expected post-reset state; precise-anchor reset
  succeeds; exactly one new Q6 burn per execute; replay refused.
- [ ] §3.3 analogue: preview-drift abort positive control (mutate after minting → execute
  must refuse, no burn, no data change). ⛔ STOP if it applies.
- [ ] §3.4 analogue: busy/backoff under held lease; Q7 `paused_retryable` handling.
- [ ] §3.5 **repeated for reset**: link-in concurrent-write, Q4 deadlock delta 0
  (the ladder §4 requirement covers both L4 and L5).
- [ ] §3.6 analogue: trash/link state; dangling links 0.
- [ ] §3.7 analogue: close the window; L6 soak entry is a separate owner authorization.

## 5. Abort / rollback of a drill

- A failed drill never "rolls itself forward": follow ladder §5 —
  flag-level removal (rung's flag off, restart, `predeploy-flags` verification) or, for a
  full stand-down, the trigger-level DISABLE script. Both are host-touching operator
  actions. OWNER-GATED: any ssh session or workflow dispatch used to perform or verify the
  rollback (including re-running the containment workflow) requires owner authorization.
- After rollback: Q1 must show the declared posture (9× 'D' after a full stand-down),
  Q7 must be empty, and the canary org's data is deleted or reset by the operator.

## 6. Evidence-anchor index (all repo-relative, all existing)

| Drill step | Anchor |
|---|---|
| Precise-anchor apply, replay refusal, preview-drift gates | `packages/core-backend/tests/integration/multitable-exact-anchor-apply-realdb.test.ts` |
| Recovery plan/preview correctness | `packages/core-backend/tests/integration/multitable-exact-anchor-recovery-plan-realdb.test.ts`, `packages/core-backend/tests/integration/multitable-exact-anchor-recovery-realdb.test.ts` |
| Route wiring of preview/execute endpoints | `packages/core-backend/tests/integration/multitable-exact-anchor-route-wiring-realdb.test.ts` |
| Lease backoff bounded / fresh-attempt semantics | `packages/core-backend/tests/integration/multitable-recovery-lease-backoff-realdb.test.ts` |
| Authority lease stability + fail-closed unavailable | `packages/core-backend/tests/integration/multitable-recovery-authority-stability-realdb.test.ts`, `packages/core-backend/tests/integration/multitable-recovery-authority-unavailable-failclosed-realdb.test.ts` |
| Foreign-fence availability, deadlock-freedom (§3.5) | `packages/core-backend/tests/integration/multitable-recovery-foreign-fence-availability-realdb.test.ts` |
| 40001→409 classifier + census + per-surface behaviour legs | `packages/core-backend/src/db/recovery-conflict.ts`, `packages/core-backend/tests/unit/recovery-conflict-census.test.ts`, `packages/core-backend/tests/integration/recovery-conflict-classifier-realdb.test.ts` |
| Register-path atomicity under 40001 | `packages/core-backend/tests/integration/auth-register-atomicity.db.test.ts` |
| Trigger/function inertness fingerprints (containment) | `scripts/ops/multitable-recovery-schema-containment.mjs` |
| Observation queries + their self-test | `scripts/ops/multitable-o2-observation.sql`, `scripts/ops/multitable-o2-observation.test.mjs` |
