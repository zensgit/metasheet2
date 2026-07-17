# Class-B fan-out actions — per-target outbound intent key (design lock, PROPOSED)

**Status: PROPOSED 2026-07-17, rev 2 (zero runtime code; awaiting owner ratify).** This document has NO ratify authority of its own. It extends the RATIFIED classification lock
`approval-automation-retry-action-classification-designlock-20260712.md` (§3 two-phase intent/outcome) to the two Class-B actions that FAN OUT to N recipients. It changes nothing for the already-landed single-send actions.

> **Rev 2 (2026-07-17, adversarial review round — 3 P2 + 2 P3, all incorporated):** (P2-1) person
> `target_key` now includes the corp dimension (`integrationId`) — DingTalk userids are corp-scoped, and
> the rev-1 tuple collapsed same-numbered users of different corps into one key = silent recipient drop.
> (P2-2) group `target_key` now keys on `destinationId` — rev 1 named `openConversationId`, a field that
> does not exist anywhere in the codebase (the as-built group action delivers via
> `dingtalk_group_destinations.webhook_url` keyed by the internal destination id). (P2-3) the person
> runtime model is rewritten: rev 1 prescribed a per-target send loop, but the LANDED person send is
> BATCHED (grouped by integration, chunks of 100, one `asyncsend_v2` per chunk returning one `task_id` —
> no per-recipient transport outcome exists). Rev 2 keeps the batched send byte-identical and defines
> per-BATCH claim + batch-level outcome stamped onto every target in that batch (§2.3a); unbatching was
> rejected as a flag-ON behavior change with rate-limit consequences. (P3) §2.2 now states the
> migration↔primitive lockstep obligation; §2.3 adds an explicit named fan-out bound.

## 1. Problem (found while wiring #4443)

`send_dingtalk_person_message` and `send_dingtalk_group_message` resolve their recipient config to **N independent per-recipient sends**. The landed two-phase substrate (`meta_automation_outbound_intent`, #4441) keys **one** intent per `(kind, root_execution_id, action_key)` — one at-most-once side effect per action identity. A fan-out cannot be represented by one intent without picking a wrong coarsening:

- **Coarsen to `outcome_unknown`** when any target is ambiguous → permanently blocks retry of targets that DEFINITELY failed pre-dispatch (lost sends, unrecoverable by automation).
- **Coarsen to `failed`** when any target failed → a retry re-runs the WHOLE action and re-sends to targets that were already delivered (duplicate messages — the exact effect `outcome_unknown` exists to forbid).

Both were rejected in #4443; the two actions were left un-wired (their existing per-target `outcome_unknown` telemetry ledgers remain the only guard). This lock defines the correct wiring.

## 2. Design: extend the intent identity with a per-target segment

### 2.1 Identity
Per-target intent key = `(kind, root_execution_id, action_key, target_key)` where:

- `action_key` — unchanged: the §2.1 triple over `{structuralPath, actionType, canonicalConfig}` (the whole action's identity, config included — so a recipient-list EDIT changes `action_key`, which is correct: it is a different action).
- `target_key` — the **resolved** recipient's stable identity, injectively encoded then hashed:
  `sha256(JSON.stringify(['dingtalk_user', integrationId, dingtalkUserId]))` for person sends —
  **the corp dimension is load-bearing**: DingTalk userids are corp-scoped (the executor's own
  DT-OPS-04 note; recipients carry `integrationId`; multi-corp audiences are supported), so a tuple
  without it collapses `corp1:1001` and `corp2:1001` into one key and the second claim returns
  `skip_sent` = a silently dropped recipient. `sha256(JSON.stringify(['dingtalk_group_destination',
  destinationId]))` for group sends — the as-built group action delivers per
  `dingtalk_group_destinations` row (webhook URL keyed by the internal `destinationId`); the
  destination id is the stable delivery identity (a webhook URL rotation is the SAME destination and
  must not resurrect a fresh send). JSON-array encoding (not delimiter concat) for injectivity,
  mirroring `deriveOutboundIdempotencyKey`. NEVER a display name, NEVER the local user id (the
  DingTalk-side delivery identity is what the send addresses), NEVER order-dependent (each target
  keys independently; resolution order is irrelevant).
- **Sentinel `''` (empty string) = whole-action intent** — what every already-landed single-send action writes. Single-send actions keep the sentinel; ONLY the two fan-out actions write non-empty `target_key`s. One substrate, no second table, no behavior change for landed wirings.

### 2.2 Schema (additive migration)
```
ALTER TABLE meta_automation_outbound_intent
  ADD COLUMN target_key text NOT NULL DEFAULT ''
    CONSTRAINT outbound_intent_target_key_shape CHECK (target_key = '' OR target_key ~ '^[0-9a-f]{16,64}$');
-- replace UNIQUE(kind, root_execution_id, action_key)
-- with    UNIQUE(kind, root_execution_id, action_key, target_key)
```
The flag has never been ON in any environment, so the table is empty at upgrade time in practice — but the migration must still be correct on a non-empty table: existing rows get `target_key=''` (their identity is unchanged; the widened UNIQUE is strictly weaker for them, and uniqueness among `''`-rows is exactly the old constraint). No backfill required, no data rewrite.

**Lockstep obligation (P3-1)**: widening the UNIQUE (`uq_outbound_intent_identity`) and updating
`claimOutboundIntent` MUST ship in the SAME slice — the primitive's `ON CONFLICT`/`WHERE` names the
index's column set, so a migration landing without the primitive change (or vice versa) breaks every
already-landed single-send Class-B claim at runtime (Postgres 42P10 on the conflict target). The slice's
goldens must include the landed single-send wirings running green against the widened schema.

### 2.3a Runtime semantics — person sends (BATCHED, flag ON)
The landed person send is batched and STAYS batched (grouped by integration, chunked ≤100, ONE
`asyncsend_v2` call per chunk returning ONE `task_id` — there is NO per-recipient transport outcome).
Rev 1's per-target send loop mis-described this surface; unbatching was REJECTED (a flag-ON behavior
change: ~100× more API calls, rate-limit exposure, and a semantics change line-item this lock has no
authority to make). The reconciliation is **per-target rows, per-BATCH claim + outcome**:

1. **Resolve targets first** (existing code), then FILTER by intent state: for each target, the claim
   decision (`skip_sent` / `skip_unknown` / `retry_failed` / fresh) is read per-target; only fresh +
   `retry_failed` targets enter the send set. Chunk the send set exactly as today.
2. **Per batch, immediately before its send**: ONE Tx-A claims that batch's per-target intents
   (INSERT pending, all rows in one transaction — the batch's claim is atomic). Then the ONE batched
   `asyncsend_v2` call. Then `classifyOutboundResult` on the batch-level transport result, and ONE
   Tx-B stamps the SAME outcome onto every `pending` row of that batch (same `status='pending'`
   single-writer guard).
3. **Outcome granularity is honestly batch-level**: one `task_id` = one transport verdict for the
   whole chunk. Per-recipient async task results are OUT of v1 scope (the existing per-target
   telemetry ledgers keep the operator drill-down role). The intent rows are per-target so that
   RETRY spans batch boundaries correctly, not to claim per-recipient transport truth v1 does not have.
4. **Crash windows (all doctrine-consistent, §8 Q-B fail-closed)**: crash BEFORE a batch's Tx-A → its
   targets are unclaimed → the retry claims and sends them fresh. Crash between Tx-A and Tx-B (incl.
   mid-send) → that batch's rows are orphaned `pending` → the next claim flips them
   `pending→outcome_unknown` (never auto-resent — ambiguity stays ambiguous). Batches are independent:
   a crash in batch 2 of 3 leaves batch 1 `sent`, batch 2 `outcome_unknown`, batch 3 fresh-sendable.
5. **A retry re-attempts ONLY `failed` (definite pre-dispatch) and never-claimed targets.** `sent` and
   `outcome_unknown` targets skip — per-target across batches, which is the entire point.

### 2.3b Runtime semantics — group sends (per-destination loop, flag ON)
The landed group action already loops destinations (one webhook POST per `dingtalk_group_destinations`
row) — a TRUE per-target loop. Each destination runs the landed two-phase primitives with its
per-target key: `claimOutboundIntent → send to THIS destination once → classifyOutboundResult →
recordOutboundOutcome`; crash-flip and skip semantics identical to the single-send wirings.

### 2.3c Shared
- **Aggregate step result** (values-free): `success` iff every target `sent`; otherwise `failed` with
  per-class COUNTS only (`{sent: n, outcome_unknown: m, failed: k}`) — no recipient identifiers in the
  step error (the intent rows carry hashed keys only).
- **Bound (P3-2)**: the implementation MUST enforce a named constant cap (`MAX_CLASSB_FANOUT_TARGETS`,
  value fixed at implementation ≥ every legitimate current audience) on the RESOLVED target count,
  failing the step closed (values-free count in the error) when exceeded — rev 1's "existing config
  caps" was not demonstrably present in code, so the cap is now an explicit implementation obligation
  with its own golden.
- The send loops stay sequential (no new concurrency surface, so no new lease/fence obligation —
  V7/V8/V9 posture unchanged from #4441).

## 3. Alternatives considered (rejected)
- **One coarsened intent per action** — the §1 dilemma; rejected.
- **A separate per-target table** — duplicates the state machine, splits the operator surface, and forces every reader to join two tables; the `''` sentinel keeps one substrate with zero landed-behavior change.
- **Per-target keys inside `action_key`** (fold the target into the §2.1 triple) — corrupts the shared identity that the Class-A claim / RULE_CHANGED fingerprint / applied-ledger all key on (`action_key` must stay the ACTION's identity, not the delivery's).

## 4. Verification obligations (RED-before, when implemented)
- **G-F1** person batch partial-crash: 7 targets in 3 batches (test-sized chunking), crash after batch 1's
  Tx-B → batch-1 targets `sent`; batches 2–3 unclaimed → retry sends EXACTLY those (per-target rows
  asserted on the intent table, zero re-send to batch 1).
- **G-F1b** person mid-batch crash: crash between a batch's Tx-A and Tx-B → that batch's targets flip
  `outcome_unknown` on the next run and are NEVER auto-resent; sibling batches unaffected.
- **G-F2** group mixed outcomes: {2 sent, 1 outcome_unknown, 1 failed} destinations → retry re-attempts
  ONLY the failed one; the unknown one never re-sends.
- **G-F3** sentinel coexistence: a single-send action's `''` row and a fan-out's per-target rows coexist
  under the widened UNIQUE without cross-talk; the landed single-send goldens run green against the
  widened schema (the §2.2 lockstep proof).
- **G-F4** identity stability: same recipient resolved in a different order / with a changed display
  name → SAME `target_key` (order-independence + no-PII probes).
- **G-F4b** cross-corp injectivity (P2-1 pin): two integrations with the SAME `dingtalkUserId` → TWO
  distinct `target_key`s, both delivered (neutralizing the `integrationId` tuple element must turn this
  RED).
- **G-F5** flag-OFF byte-identical: both actions' legacy paths unchanged (incl. the batched person path
  call-shape).
- **G-F6** fan-out cap: resolved targets over `MAX_CLASSB_FANOUT_TARGETS` → step fails closed with a
  values-free count, zero sends, zero intent rows.
- Mutation-proofs on: the per-target skip (neutralize → duplicate send caught), the aggregate success
  condition, the `''`-sentinel scoping, and the cross-corp tuple element (G-F4b).

## 5. Out of scope
- Any change to the five landed single-send wirings.
- Auto-resend of `outcome_unknown` (still forbidden; S3 human redelivery path unchanged).
- Concurrency/lease for the send loop (sequential; inherits the S6/event-fires serialization posture).
