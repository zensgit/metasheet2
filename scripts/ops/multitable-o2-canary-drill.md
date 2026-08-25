# O-2 canary drill runbook — L4 (sheet revert) / L5 (PIT reset)

> Companion to `docs/development/multitable-timemachine-o2-enablement-ladder-20260819.md`
> (the ladder). **The ladder governs; this runbook executes nothing by itself.** It is an
> operator checklist: every step is either (a) a read-only SQL observation an operator runs
> against a database they are already authorized to reach, or (b) a manual operator action /
> an EXISTING workflow dispatch that is explicitly **OWNER-GATED** — meaning it must not be
> performed without the per-rung owner authorization the ladder's E1.3 authorization form
> requires (owner 亲笔: exact content + target environment + level, or the single
> `AUTHORIZE-STAGING-L2-L5 <E1 exact SHA>` batch form). This document introduces **no new
> remote-reaching automation** and grants no authorization.
>
> **Ladder status (read before drilling L2-C/L3/L4/L5): the ladder's 修正案 E1 — the only
> executable L2→L5 order — is `PROPOSED`, not yet ratified.** Every step below this point
> (§3 L2-C, §4 L4, §5 L5) is `HOLD / DO NOT EXECUTE` until an owner ratifies E1 with an
> exact-SHA `RATIFY-E1 <sha>` or issues `AUTHORIZE-STAGING-L2-L5 <E1 exact SHA>` (ladder
> E1.3). This runbook describes what each step will do and check once authorized; it is not
> itself the authorization.
>
> **Containment tool status (2026-08-24, #5151): rung-aware, POSITIVE per-posture PASS —
> not "expected red".** `multitable-recovery-flag-containment-check.yml` takes a fixed
> `posture` choice (`inert` / `l1-armed` / `l2-fence` / `l2-checkpoint` / `l3-strict` /
> `l4-revert` / `l5-reset`) and PASSes only when running env, next-restart Compose, the 9
> triggers, the 6 authority-function fingerprints, and the meta_links FK-absence check all
> match that posture's own exact expected shape — never by an operator reading a red result
> as "that's fine, this rung is supposed to look broken". Every containment dispatch below
> names the exact `posture` for the rung being drilled and the exact PASS sentinel the tool
> emits; there is no red-is-expected step left in this runbook.
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
  owner/ops action (ladder E1.1 sequence + E1.3 authorization form; ladder §5 for rollback).
  This runbook covers the drill performed *after* the rung's flag is on and its
  `postdeploy-full` posture PASS is in hand.
- Any step marked ⛔ STOP that fails ⇒ freeze the ladder at the current rung (ladder §3's
  fail-stop rule, which continues to apply regardless of E1's ratify status), record the
  evidence, do not proceed.

## 1. Preconditions (verify, do not assume)

- [ ] Rung posture confirmed on the target host. OWNER-GATED: dispatch the existing
  containment workflow `.github/workflows/multitable-recovery-flag-containment-check.yml`
  (`gh workflow run` with `mode=postdeploy-full`, the correct `target`, and
  `posture=l4-revert` before opening §4's L4 drill or `posture=l5-reset` before opening §5's
  L5 drill — `l5-reset`'s exact-active-flag set is a strict superset of `l4-revert`'s, so it
  is also the correct posture to re-check once L5 is open). **Expected: a POSITIVE PASS**,
  not a red result read as "expected" — the workflow fails closed on any mismatch, including
  a flag this rung's posture declares OFF turning up on:
  - `mode=postdeploy-full` → the workflow's literal sentinel line
    `VERDICT: PASS (postdeploy-full) — exact ladder posture '<posture>' matches running/next-restart flags and database recovery schema matches its expected trigger posture`.
  - `mode=predeploy-flags` (schema leg intentionally not verified; use only when the
    postdeploy image/schema isn't deployed yet) → the distinct sentinel
    `VERDICT: PASS (predeploy-flags) — exact ladder posture '<posture>' matches running AND next-restart flags; database recovery schema NOT verified in this mode`.

  Any other output — including a FAIL that merely happens to be red on the flags this rung
  opens — is a mismatch: ⛔ STOP per §0's hard rule, do not read it as confirming the
  posture.
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

## 3. L2-C drill — named canary trust-checkpoint provisioning

> **HOLD / DO NOT EXECUTE until E1 is ratified** (see the ladder-status note at the top of
> this document). L2-C is a **transient provisioning step, not a standing rung**: per ladder
> E1.1 item 2, it is entered only to mint one trust checkpoint on the named canary sheet,
> then exited immediately back to `l2-fence`. It is a prerequisite for §4 (L4 revert) and §5
> (L5 reset): both `handleExactAnchorPreview`'s trust-substrate check and `resolveExactAnchor`'s
> covering-checkpoint gate refuse every anchor on a sheet with no active checkpoint, so a
> revert/reset canary drilled without this step cannot get past `RECOVERY_TRUST_REQUIRED` /
> `NO_COVERING_CHECKPOINT` regardless of which later flags are on.

### 3.1 Prerequisites (verify before dispatching activation)

- [ ] Fence is already on: `MULTITABLE_ENABLE_WRITER_FENCE=true` on the target host (this is
  the `l2-fence` posture this rung sits inside — activation additionally requires it at the
  route layer: `univer-meta.ts`'s `POST /sheets/:sheetId/trust-checkpoint-activate` handler
  checks `TRUST_CHECKPOINT_FENCE_REQUIRED` (~`univer-meta.ts:10171`, gate on
  `isWriterFenceEnabled()`) and refuses **409** before touching the DB if the fence is off.
- [ ] Activation flag is on for this transient window only:
  `MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION=true`. Without it the route refuses
  **403** `TRUST_CHECKPOINT_ACTIVATION_DISABLED` (~`univer-meta.ts:10164`) before any auth or
  DB work — a values-free, no-oracle refusal.
- [ ] Owner-designated canary sheet only. A parallel lane is introducing
  `MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST` (unset ⇒ refuse-all) to make this
  enforced at the route rather than by operator discipline alone; until that lane lands,
  the discipline is manual — do not provision a checkpoint on any sheet outside the drill
  log's declared canary set, and never on a customer sheet. Re-read that env var's actual
  gate shape once the parallel lane merges — this runbook does not assume its error code or
  status.
- [ ] Confirm posture before dispatching: containment `mode=postdeploy-full`,
  `posture=l2-fence` → PASS (§1's sentinel), on the canary host only.

### 3.2 Provision the checkpoint

- [ ] OWNER-GATED (D2 sheet-admin write, one fenced transaction — design lock §3): mint the
  checkpoint with `POST /sheets/:sheetId/trust-checkpoint-activate` (no body) against the
  canary sheet, using a sheet-admin (`canManageSheetAccess`) actor.
  - Expected refusals if a prerequisite is missing (fail closed, nothing written in every
    case): **403** `TRUST_CHECKPOINT_ACTIVATION_DISABLED` (activation flag off), **409**
    `TRUST_CHECKPOINT_FENCE_REQUIRED` (writer fence off), **409** `HISTORY_INCOMPLETE`
    (a trashed-only record with unattributable vintage — `CheckpointUnattributableTrashError`,
    owner P1 fail-closed abort), **409** `RECOVERY_IN_PROGRESS` (a recovery holds the sheet's
    writer-fence lease right now — retry once it completes), **409** `ACTIVATION_CONFLICT`
    (a racing second activation won the one-active partial-unique first — retry to supersede).
  - Expected success: **200** with `{ checkpointId, trustedSinceSeq, baselineCount }`. Record
    all three in the drill log verbatim (values-free elsewhere, but these three identifiers
    ARE the checkpoint evidence ladder E1.1 item 2 requires).
- [ ] Confirm posture immediately after: containment `mode=postdeploy-full`,
  `posture=l2-checkpoint` → PASS (activation flag observed ON, alongside fence).
- [ ] Remove the activation flag from the environment and restart (or however the target's
  next-restart config is normally applied) — this is the "immediately restore OFF" half of
  E1.1 item 2. It must not be left in standing configuration.
- [ ] Re-confirm posture: containment `mode=postdeploy-full`, `posture=l2-fence` → PASS
  (activation flag observed OFF again, fence still ON). This is the exit criterion for L2-C:
  a checkpoint now exists for the canary sheet, and the environment is back to `l2-fence`.

## 4. L4 drill — sheet revert canary

> **HOLD / DO NOT EXECUTE until E1 is ratified.** Requires §3 (L2-C) already completed for
> this canary sheet — an anchor drilled here without an active covering checkpoint refuses
> `NO_COVERING_CHECKPOINT` regardless of the flags below.

### 4.1 Seed and mint

- [ ] In the canary org, create/refresh the canary sheet with a known record set; write the
  expected post-revert state into the drill log *before* executing anything.
- [ ] Mint a revert preview: `POST /api/.../sheets/:sheetId/revert-preview` (route registered
  in `packages/core-backend/src/routes/univer-meta.ts`, `handleExactAnchorPreview`). Record
  the preview's anchor summary in the drill log.

### 4.2 Precise-anchor revert success

- [ ] Execute with the freshly-minted token: `POST /api/.../sheets/:sheetId/revert-execute`.
  Expected: success response; sheet content equals the pre-declared expected state.
- [ ] Q6: burn count for the canary sheet increased by **exactly 1** (one execute = one burn
  row, burned inside the apply's own transaction). Any burn row for a **non-canary** sheet
  at any point in the drill window is ⛔ STOP (unauthorized destructive apply).
- [ ] Q7: 0 rows again after completion (fence state cleared).
- [ ] Replay control: re-POST the **same** token → must refuse (anti-replay burn ledger,
  `meta_recovery_token_burns` PK). Evidence anchor:
  `packages/core-backend/tests/integration/multitable-exact-anchor-apply-realdb.test.ts`.

### 4.3 Preview-drift abort — positive control

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

### 4.4 Busy/backoff behaviour (lease contention)

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

### 4.5 Foreign-fence link-in concurrent write — no-40P01 check (ladder §4)

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

#### 4.5a Second link-in shape: an FK **into a platform-auth table** (found 2026-08-20)

The scenario above exercises the multitable-side shape (`meta_links` → drill-sheet records). A
**different** instance of the same residual class exists on the platform side and must be drilled
too, because it touches a table the ladder's own triggers sit on:

`approval_usable_member_groups.created_by` carries an FK to **`users.id`**
(`packages/core-backend/src/db/migrations/zzzz20260818120000_create_approval_usable_member_groups.ts`).
Inserting into that table therefore takes a `KEY SHARE` lock on a `users` row — and `users` is one
of the eight platform-auth tables whose recovery-authority trigger is ENABLED from L1 onward. That
is exactly the ladder §4 shape (FK `KEY SHARE` vs row-level `FOR UPDATE`), reached through a
**different, non-multitable** write path that the 4.5 scenario does not cover.

- [ ] While a revert/reset is executing (so recovery holds its exclusive lease and the authority
  triggers are live), drive an approval write that inserts into `approval_usable_member_groups`
  (i.e. a member-group usability change on the canary org) in a loop.
- [ ] Expected: same criterion as 4.5 — the approval writer may see a transient retryable 409/busy,
  but **Q4 `deadlocks` delta = 0**; neither side deadlocks.
- [ ] ⛔ STOP on any nonzero delta. Note in the drill record which of 4.5 / 4.5a produced it — they
  are different lock shapes and a fix for one does not imply the other.
- [ ] Applicability check first: this table only exists once the approval migration above is
  applied. If the target host is behind on it, record 4.5a as **NOT RUN (table absent)** rather
  than as passed — an absent table cannot deadlock, and reading that as a pass would be exactly
  the empty-read trap.

### 4.6 Trash / link state check

- [ ] Paste the canary sheet ids into Q8's `EDIT ME` list and run it.
  Expected: `dangling_links` = 0 rows (or rows with count 0) for the canary set;
  `trash_rows` matches the drill ledger exactly (every trash row explained by a deliberate
  drill delete/revert). Any unexplained trash row or any dangling link ⇒ ⛔ STOP.
- [ ] Restore-path spot check: restore one drill-trashed record and verify it returns with
  its original timestamps (trash table preserves `original_created_at`/`original_updated_at`).

### 4.7 Close the L4 window

- [ ] Re-run the full observation file; verify: Q6 total burns == ledger, Q7 empty,
  Q4 deadlock delta 0, Q5 still empty (0 rows — if not, the observation kit's sink
  inventory is stale; update it before trusting counts).
- [ ] Record the Q4 AFTER values; compute and log deltas.
- [ ] Confirm posture one more time: containment `mode=postdeploy-full`, `posture=l4-revert`
  → PASS.
- [ ] Drill log completed and attached to the rung's observation-window evidence (ladder
  E1.1 item 4's L4 criteria). Advancing to L5 is a **separate owner authorization** — nothing
  in this runbook grants it.

## 5. L5 drill — PIT reset canary

> **HOLD / DO NOT EXECUTE until E1 is ratified.** Requires §3 (L2-C) already completed for
> this canary sheet, same as L4 — the covering checkpoint is a sheet-level trust floor, not a
> per-rung one, so L5 does not repeat checkpoint provisioning if §3/§4 already ran it for this
> sheet.

Same discipline as §4 with the reset endpoints
(`POST /api/.../sheets/:sheetId/reset-preview` / `reset-execute`), confirming posture
`l5-reset` throughout instead of `l4-revert`:

- [ ] §4.1–§4.2 analogue: pre-declared expected post-reset state; precise-anchor reset
  succeeds; exactly one new Q6 burn per execute; replay refused.
- [ ] §4.3 analogue: preview-drift abort positive control (mutate after minting → execute
  must refuse, no burn, no data change). ⛔ STOP if it applies.
- [ ] §4.4 analogue: busy/backoff under held lease; Q7 `paused_retryable` handling.
- [ ] §4.5 **repeated for reset**: link-in concurrent-write, Q4 deadlock delta 0
  (the ladder §4 requirement covers both L4 and L5).
- [ ] §4.6 analogue: trash/link state; dangling links 0.
- [ ] §4.7 analogue: close the window (confirm `posture=l5-reset` PASS); L6 soak entry is a
  separate owner authorization.

## 6. Abort / rollback of a drill

- A failed drill never "rolls itself forward": follow ladder §5 —
  flag-level removal (rung's flag off, restart, next-lower rung's — or `l1-armed`'s —
  `posture` for a precise positive-PASS re-verification) or, for a full stand-down, the
  trigger-level DISABLE script verified against `posture=inert`. Both are host-touching
  operator actions. OWNER-GATED: any ssh session or workflow dispatch used to perform or
  verify the rollback (including re-running the containment workflow) requires owner
  authorization.
- After rollback: Q1 must show the declared posture (9× 'D' after a full stand-down),
  Q7 must be empty, containment must PASS at the landed rung's exact `posture` (or
  `posture=inert` after a full stand-down), and the canary org's data is deleted or reset by
  the operator.

## 7. Evidence-anchor index (all repo-relative, all existing)

| Drill step | Anchor |
|---|---|
| Precise-anchor apply, replay refusal, preview-drift gates | `packages/core-backend/tests/integration/multitable-exact-anchor-apply-realdb.test.ts` |
| Recovery plan/preview correctness | `packages/core-backend/tests/integration/multitable-exact-anchor-recovery-plan-realdb.test.ts`, `packages/core-backend/tests/integration/multitable-exact-anchor-recovery-realdb.test.ts` |
| Route wiring of preview/execute endpoints | `packages/core-backend/tests/integration/multitable-exact-anchor-route-wiring-realdb.test.ts` |
| Lease backoff bounded / fresh-attempt semantics | `packages/core-backend/tests/integration/multitable-recovery-lease-backoff-realdb.test.ts` |
| Authority lease stability + fail-closed unavailable | `packages/core-backend/tests/integration/multitable-recovery-authority-stability-realdb.test.ts`, `packages/core-backend/tests/integration/multitable-recovery-authority-unavailable-failclosed-realdb.test.ts` |
| Foreign-fence availability, deadlock-freedom (§4.5) | `packages/core-backend/tests/integration/multitable-recovery-foreign-fence-availability-realdb.test.ts` |
| Trust-checkpoint activation route + fence/flag gating (§3 L2-C) | `packages/core-backend/src/routes/univer-meta.ts` (`POST /sheets/:sheetId/trust-checkpoint-activate`, ~L10162), `packages/core-backend/src/multitable/history-trust-checkpoint.ts` (`activateCheckpoint`, `selectCheckpointByAnchorSeq`) |
| 40001→409 classifier + census + per-surface behaviour legs | `packages/core-backend/src/db/recovery-conflict.ts`, `packages/core-backend/tests/unit/recovery-conflict-census.test.ts`, `packages/core-backend/tests/integration/recovery-conflict-classifier-realdb.test.ts` |
| Register-path atomicity under 40001 | `packages/core-backend/tests/integration/auth-register-atomicity.db.test.ts` |
| Trigger/function inertness fingerprints (containment) | `scripts/ops/multitable-recovery-schema-containment.mjs` |
| Observation queries + their self-test | `scripts/ops/multitable-o2-observation.sql`, `scripts/ops/multitable-o2-observation.test.mjs` |
