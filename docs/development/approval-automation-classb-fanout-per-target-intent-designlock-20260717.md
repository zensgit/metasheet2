# Class-B fan-out actions — per-target outbound intent key (design lock, PROPOSED)

**Status: PROPOSED 2026-07-17 (zero runtime code; awaiting owner ratify).** This document has NO ratify authority of its own. It extends the RATIFIED classification lock
`approval-automation-retry-action-classification-designlock-20260712.md` (§3 two-phase intent/outcome) to the two Class-B actions that FAN OUT to N recipients. It changes nothing for the already-landed single-send actions.

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
  `sha256(JSON.stringify(['dingtalk_user', dingtalkUserId]))` for person sends; `sha256(JSON.stringify(['dingtalk_chat', openConversationId]))` for group sends. JSON-array encoding (not delimiter concat) for injectivity, mirroring `deriveOutboundIdempotencyKey`. NEVER a display name, NEVER the local user id (the DINGTALK-side id is the delivery target), NEVER order-dependent (each target keys independently; resolution order is irrelevant).
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

### 2.3 Runtime semantics (per action execution, flag ON)
1. **Resolve targets first** (the existing recipient-resolution code), THEN loop targets. For each target, run the landed two-phase primitives with the per-target key:
   `claimOutboundIntent → skip_sent / skip_unknown / proceed / retry_failed → send to THIS target once → classifyOutboundResult (dingtalk transport tiers, unchanged) → recordOutboundOutcome` (same `status='pending'` single-writer guard; same crash-flip `pending→outcome_unknown`).
2. **A retry re-attempts ONLY `failed` (definite pre-dispatch) targets.** `sent` and `outcome_unknown` targets skip — per-target, which is the entire point.
3. **Aggregate step result** (values-free): `success` iff every target `sent`; otherwise `failed` with per-class COUNTS only (`{sent: n, outcome_unknown: m, failed: k}`) — no recipient identifiers in the step error (the intent rows carry the hashed keys; the existing per-target telemetry ledgers keep their role for operator drill-down).
4. **Partial-crash recovery is per-target by construction**: a crash after target 3 of 7 leaves targets 1–3 with terminal rows and 4–7 unclaimed; the retry claims 4–7 fresh, flips any orphaned `pending` (a crash mid-send of target 4) to `outcome_unknown`, and never re-sends 1–3.
5. **Bound**: N is bounded by the recipient resolution (existing config caps); no unbounded fan-out is introduced. The loop is sequential (matches the current send loop; no new concurrency surface, so no new lease/fence obligation — V7/V8/V9 posture unchanged from #4441).

## 3. Alternatives considered (rejected)
- **One coarsened intent per action** — the §1 dilemma; rejected.
- **A separate per-target table** — duplicates the state machine, splits the operator surface, and forces every reader to join two tables; the `''` sentinel keeps one substrate with zero landed-behavior change.
- **Per-target keys inside `action_key`** (fold the target into the §2.1 triple) — corrupts the shared identity that the Class-A claim / RULE_CHANGED fingerprint / applied-ledger all key on (`action_key` must stay the ACTION's identity, not the delivery's).

## 4. Verification obligations (RED-before, when implemented)
- **G-F1** partial-crash: 7 targets, crash after 3 → retry sends EXACTLY 4 (per-target counts asserted on the intent table).
- **G-F2** mixed outcomes: {2 sent, 1 outcome_unknown, 1 failed} → retry re-attempts ONLY the failed one; the unknown one never re-sends.
- **G-F3** sentinel coexistence: a single-send action's `''` row and a fan-out's per-target rows coexist under the widened UNIQUE without cross-talk.
- **G-F4** identity stability: same recipient resolved in a different order / with a changed display name → SAME `target_key` (order-independence + no-PII probes).
- **G-F5** flag-OFF byte-identical: both actions' legacy paths unchanged.
- Mutation-proofs on: the per-target skip (neutralize → duplicate send caught), the aggregate success condition, and the `''`-sentinel scoping.

## 5. Out of scope
- Any change to the five landed single-send wirings.
- Auto-resend of `outcome_unknown` (still forbidden; S3 human redelivery path unchanged).
- Concurrency/lease for the send loop (sequential; inherits the S6/event-fires serialization posture).
