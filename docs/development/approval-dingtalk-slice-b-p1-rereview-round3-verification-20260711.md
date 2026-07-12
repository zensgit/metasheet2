# DingTalk Approval Card (Slice-B) — P1-1 re-review **round 3** design + verification

**PR:** #4112 · branch `claude/dt-card-p1-node-epoch-binding` · flag `DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED` **default OFF**
**Status:** fixes applied + mutation-verified on a real DB; **not merged** (owner landing decision) · **Stream flag stays OFF · U1–U13 UAT held**
**Trigger:** owner REQUEST-CHANGES (real-DB probe), round 3.

This round closes the four findings the owner reproduced against the round-2 code. Each fix is
pinned by a **RED-before** real-DB golden, and the two load-bearing goldens are **mutation-verified**
(reintroduce the vulnerability → the golden goes RED).

---

## Findings & fixes

### P1 — migration backfill re-authorized a legacy card into a fresh round *(the critical one)*

**Owner repro:** a pre-column card (`sent`, `entry_epoch=NULL`) for `(instance, node, recipient)`;
then a **fresh** same-node/same-recipient active seat at a new epoch (9). The round-2 backfill step-1
("infer the epoch from the unique live seat that exists now") adopted epoch 9 → the legacy card became
`sent` + `entry_epoch=9` → **actionable in a round it never belonged to** (same-node re-entry reopened).

**Root cause:** a pre-column card has **no provable original-round anchor**. Inferring the epoch from
the *current* unique seat is unsound — a legitimate fresh round presents exactly one live non-null-epoch
seat, indistinguishable from the card's real (lost) round.

**Fix:** `backfillDingTalkApprovalCardDeliveryEpochs` → **`supersedeLegacyDingTalkApprovalCardDeliveries`**
(supersede-only). Every legacy `sent` + NULL-epoch card is **superseded** at migrate time — no epoch
recovery, ever. Fail-closed: the card stops working and the recipient re-approves via web. This retires
**all** in-flight legacy cards (near-zero impact: pre-GA, flag OFF) but **never** re-authorizes one.
Migration import + doc + `db/types.ts` comment updated.

- File: `packages/core-backend/src/integrations/dingtalk/approval-card-deliveries.ts`
- File: `packages/core-backend/src/db/migrations/zzzz20260711120000_add_entry_epoch_to_dingtalk_approval_card_deliveries.ts`
- Golden (replaced the *vulnerable* one that encoded "infer from unique seat" as correct):
  `tests/integration/dingtalk-approval-card-deliveries.db.test.ts` — owner's exact repro → legacy card
  `superseded`, `entry_epoch` stays NULL (not 9), unclaimable; orphan superseded; idempotent.
- **Mutation-verified:** restore the seat-inference step-1 → golden RED
  (`expected [Array(1)] to deeply equal [Array(2)]` — legacy backfilled to 9, not superseded).

### P2 — required `test (20.x)` was RED (5/11 callback db cases)

**Cause:** the callback db fixture helper never stamped the live seat epoch, so the strict binding staled
**every deliverable card** — 5 cases that should execute/engine-reject turned `stale`.

**Fix:** `liveSeatEpoch(instance, node, recipient)` helper reads the active seat's `entry_epoch` and
stamps it on every **deliverable** card (`newSentDelivery` + the 3 inline `markSent` cards in the DT-R2
and corp-B cases). Pending/failed negatives keep NULL (unactionable by `send_status` alone — correct).

- File: `packages/core-backend/tests/integration/dingtalk-approval-card-callback.db.test.ts`
- Result: **callback db 11/11** (was 6/11).

### P2 — the committed "TOCTOU headline" was sequential, not a two-transaction interleaving

**Cause:** the round-2 headline advanced N1→N2 *first*, then called `dispatchAction` — it proves the
guard **exists** but not that it lives **inside** the lock (a guard moved outside would still observe the
already-committed advance). It could not defend against a future refactor that validates the binding
outside the `FOR UPDATE`.

**Fix:** added a **real two-transaction interleaving** golden. A dedicated connection **holds** the
`approval_instances` row `FOR UPDATE` and advances N1→N2 **in-txn** while a concurrent node1-card
`dispatchAction` is **parked behind that lock** — proven genuinely blocked via
`pg_stat_activity.wait_event_type='Lock'` (not a timer; throws if it never blocks, so it can't silently
degrade to the sequential case). On commit, the parked dispatch re-reads under its own lock → **409
STALE**, **0 node2 approve records**.

- File: `packages/core-backend/tests/integration/approval-card-delivery-wrapper.db.test.ts`
- **Mutation-verified (the decisive one):** move the guard to evaluate a **pre-lock snapshot** of
  `current_node_key` + active assignments (models "guard outside the lock") →
  **interleaving RED while the sequential HEADLINE stays GREEN** — proving the interleaving golden
  catches a regression the sequential test cannot.

### P3 — stale comments

Row-type + input-type doc comments in `approval-card-deliveries.ts` and `db/types.ts` still described the
deleted permissive NULL dual-read ("NULL skips the epoch clause / binds on node+assignee alone"). Updated
to strict fail-closed.

---

## Verification (real Postgres)

Method: `DATABASE_URL=postgresql://localhost:5432/<db>` · `pnpm --filter @metasheet/core-backend db:migrate`
· `vitest --config vitest.integration.config.ts run`. Unit suite: `pnpm --filter @metasheet/core-backend test`.

| Check | Result |
|---|---|
| `tsc --noEmit` (core-backend) | clean |
| callback db (`dingtalk-approval-card-callback.db.test.ts`) | **11/11** (was 6/11) |
| deliveries db (`dingtalk-approval-card-deliveries.db.test.ts`) incl. P1 repro golden | pass |
| wrapper db (`approval-card-delivery-wrapper.db.test.ts`) incl. interleaving golden | **21/21** |
| P1 golden mutation (restore seat-inference) | **RED** → confirms teeth; restored GREEN |
| interleaving mutation (guard outside lock) | interleaving **RED** / headline **GREEN**; restored GREEN |
| full backend unit suite | **6177 passed / 0 failed** (1575 skipped, 633 files) |
| migration `up()` on a **fresh** DB (new code) | reaches `zzzz20260711120000` clean via `sql.raw`; unscoped supersede retired a seeded legacy card → `superseded / epoch=NULL` (NOT adopting the epoch-9 seat); idempotent |
| **CI on pushed head `5f49558b4`** | **all green** — `test (20.x)` **pass** (the check the owner saw fail on 5/11), `migration-replay` **pass**, `web-tests`/`test (18.x)`/`coverage`/`contracts×3`/`e2e` pass; only always-skipped Strict-E2E is skipping |
| independent Opus adversarial re-review (real-DB, refute-first) | **APPROVE — no P1/P2** (details below) |

_Counts are read from the actual run and from CI on the pushed head — no "pending == pass" (the round-2 mistake)._

### Independent Opus adversarial re-review — APPROVE (no P1/P2)

A separate Opus reviewer attacked head `5f49558b4` as a **real-DB refutation** (own worktree, real
Postgres 15.17, migrations applied), not a diff read. It could not break the strict node+epoch binding
on any path. What it actually executed:

- **43/43** author goldens + **7/7** independent adversarial repros + **5/5** parallel cross-branch
  repros — all PASS.
- **Independently reproduced the mutation teeth-proof**: guard→pre-lock snapshot → the interleaving
  goldens went **RED** (parked card approved the wrong round) while sequential/strict-epoch/NULL-epoch
  stayed GREEN; restored from backup (no `git checkout`), post-restore diff empty.
- **Migration `up()` end-to-end**: `db:rollback` → seed a legacy `sent`/NULL-epoch card → `db:migrate`
  → card `superseded`, epoch stayed NULL (the real unscoped `sql.raw` path, fail-closed). Also verified
  `outcome_unknown` NULL-epoch cards are swept.
- Drove a **post-migration** NULL-epoch card DIRECTLY into `dispatchAction` → STALE 409, 0 approves (a
  path the author goldens didn't cover). Callback delegates to the same wrapper → same fail-closed.
- **Parallel `joinMode:all` (the resolved advisor gap #3):** the cross-branch attack is foreclosed at
  **two independent live layers** — template validation rejects the same user on two branches
  (`VALIDATION_ERROR`), and the active-seat unique index `idx_approval_assignments_active_unique`
  (per-instance) blocks a second live seat (`23505`) — so a recipient is live on at most one branch, and
  the round-3 `actorBranchNodeKey` guard approves only the actor's own branch (0 cross-branch approves).
- Cross-corp P1-2 not regressed (callback refuses NULL `integration_id` outright).

Deliverable: `/tmp/pr4112-rev3-adversarial-20260711.md`.

### P3 (non-blocking) — the reviewer's two findings

- **P3-2 (doc drift) — FIXED this round.** `ApprovalCardDeliveryAction.ts` and `ApprovalProductService.ts`
  comments still said legacy cards are "backfilled … else superseded" / "the migration failed to
  backfill"; round-3 is supersede-only. Comments corrected (code was already correct). (My round-3 grep
  missed these because an over-clever `grep -iv "supersede"` filter excluded lines containing both words.)
- **P3-1 (defense-in-depth, offered as a follow-up).** The in-txn guard does not additionally assert
  `card_state='sent'`. The reviewer proved this **not exploitable** three ways: the wrapper is the sole
  producer of a `dingtalk_card` channelOrigin and does the `card_state` pre-read; the HTTP route builds
  `ApprovalActionRequest` from an explicit field list that excludes `channelOrigin`; and seat
  deactivation independently blocks replay double-approve. Recommended as a small standalone hardening
  PR (add `AND card_state='sent'` to the guard's delivery read + a golden) rather than widening this
  security chokepoint under the landing wire — owner's call.

## Holds (owner constraints, unchanged)

- **`DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED` stays OFF; U1–U13 UAT and production enablement held.**
- **#4112 not merged** — awaiting explicit owner landing go.
- On go: merge #4112 → rebase+merge #4116 (P1-2 corp-scoping) → rebase #4118 last (resolve the
  `interactive-card-callback.ts` conflict against #4116 + combined regression) → merge; then fix the
  Slice-B UAT doc (`im_robot`→`IM_ROBOT`, add `DINGTALK_INTERACTIVE_CARD_STREAM_INTEGRATION_ID`,
  add the corp-provenance U-case) — still before any UAT execution.

## Deferred (documented, non-blocking)

- **P3-2** — a recipient active on two parallel branches could bind the wrong branch and *false-stale* a
  legitimate card until the sibling resolves. Strictly safer than main (fail-closed vs wrong-branch
  approval) and an unusual topology.
