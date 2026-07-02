# Approval & Process-Automation — remaining-items plan, development & verification (2026-07-03)

> `/goal` deliverable: deep-review the line, sequence the remaining items for **parallel development**,
> complete everything genuinely buildable, and record dev + verification. **Discipline honored:** gated
> runtime is NOT blind-built on presumed votes; instead every remaining rung is made **one vote from build**
> (design-lock / build-spec), and the decision-clean work is completed + verified this batch.

## 1. Shipped / queued in this batch (code-verified, base through #3441 `a206a5bb` + this PR)

Engine parity with 钉钉/飞书 approval is ~85% — the recent burst closed most of it:
- **Correctness/security:** T2-4 re-entry quorum fix + cascade regression (#3446/#3453) · R1 SSRF egress
  default-closed complete (#3437/#3443/#3447/#3451/#3460) · **node-timeout deadline-clear race fix (#3497,
  this batch)**.
- **Automation triggers/actions:** T2-6 dedup ledger (#3450) · T1-3 approval.completed trigger (#3467) ·
  T1-2 signed inbound webhook (#3489) · T3-4 W7 rejection backwrite (#3474) · T0-3 delete_record editor
  (#3477).
- **Approval engine:** T1-1 slice-2 transfer/jump timeout effects (#3468) · T2-1+2 scoped admins + handover
  (#3490).
- **UX:** rule editor exposes approval.completed + webhook.received (#3495) · **approval-center batch
  approve/reject + list-level urge (#3496, open)**.

## 2. Remaining items — gating (authoritative)

| Item | Subsystem | Size | Gating | Made-ready this batch |
|---|---|---|---|---|
| **node-timeout deadline-clear race** | approval metrics | S | **decision-clean → BUILT (#3497)** | ✅ shipped-for-review |
| **T3-5** W7 cross-base backwrite | automation (Lane C) | L | design-lock-first (owner) | **design-lock #3-5 doc** |
| **T1-4** node field-perms authoring | approval (Lane B) | M | owner-vote-needed | **build-spec doc** |
| **T3-2** business-calendar SLA | product | L | owner-vote-needed (3rd ballot) | reuse-attendance note |
| **T3-3** node signature/compliance | approval | M-L | owner-vote-needed (declared-inert first) | 3rd ballot |
| **T3-1** mobile approval | product | L | owner-vote-needed (blocked on notif hub) | 3rd ballot |
| **T3-6** approvals-as-multitable-records | product | L | owner-vote-needed (**the 超越 move**) | 3rd ballot |
| **A3** egress destination authorization | BPMN | S | governance-only (config/ops, not code) | — |

## 3. Parallel-development plan (lanes — concurrent, hot-file-sequential within a lane)

- **Lane B — approval engine** (`ApprovalProductService.ts` hot): T1-4 field-perms authoring (on vote) →
  T3-3 signature (declared-inert first).
- **Lane C — automation engine** (`automation-service.ts` hot): T3-5 cross-base backwrite (on vote,
  design-lock ready).
- **Lane D — product/heavy** (separate surfaces, fully parallel): T3-6 approvals-as-records (highest
  differentiation — unlocks 飞书-grade reporting + re-automation for free), T3-2 calendar-SLA (reuse the
  attendance effective-calendar substrate → L drops toward M), T3-1 mobile (responsive pass; native blocked
  on a notification hub).
- **Lane A — BPMN:** A3 is governance-only — no code slice; authorize a destination when a named integration
  needs it.

Dependency notes: T3-2 → T1-1 node-SLA (met) · T3-5/T3-3 sit on their hot files so stay sequential within
their lanes · Lane D items share no runtime hot file → genuinely parallel.

## 4. Completed this batch (decision-clean — no owner vote) + verification

**node-timeout deadline-clear race (#3497)** — `recordNodeDecision`'s unconditional instance-wide deadline
clear raced the next node's activation write (both unawaited post-commit best-effort), silently losing the
new node's timeout. Fixed by scoping the clear to `approval_instances.current_node_key` (= the next node
post-commit → the clear is a safe no-op once advanced). **Verify:** tsc 0 · real-DB `approval-node-sla-remind`
5/5 incl. a new fail-first race-guard test; **RED-before confirmed** (unconditional clear reverted → the
advanced node's fresh deadline is wiped → test fails). **Broader regression:** `approval-node-timeout-effects`
13/13 + `approval-nofm-threshold` 5/5 green (the shared metrics path is unaffected).

_(Additional decision-clean items surfaced by the review workflow are appended in §6.)_

## 5. Made one-vote-from-build this batch (authorized design, no runtime)

- **T3-5 design-lock** (`w7-cross-base-resultwriteback-design-lock-20260703.md`) — register Q1–Q5 + the 5
  reviewer must-fixes turned into a build contract + fail-first verification plan. Reuses the ratified
  executor cross-base gate; literal target triple; trigger-actor authority fail-closed. **On T3-5 vote → build
  Lane C.**
- **T1-4 build-spec** (`t1-4-node-field-permissions-authoring-build-spec-20260703.md`) — folds the owner
  hidden/readonly steer + reconciles it with the register Q2 hidden-only default (the one vote to settle);
  hidden enforced (echo-redaction), readonly persisted-but-runtime-inert (T1-4b later). **On T1-4 vote →
  build Lane B.**

## 6. Review findings (adversarial workflow + focused hunt)

- **Shipped-state: CONFIRMED.** All 11 recently-shipped items are genuinely present on origin/main with live
  `file:symbol` anchors (verified against git objects, not merge-commit ancestry).
- **The node-timeout deadline race: INDEPENDENTLY CONFIRMED** as live, with the same call-site evidence
  (`ApprovalProductService.ts` 5072/5077 approve, 4614/4616 reject/return, 4181/4183 timeout-jump; both emits
  fire-and-forget via `safeMetricsCall`), the single per-instance deadline column → last-writer-wins race, and
  the recommended fix = **exactly** the conditional node-scoped clear shipped in #3497. My fix is validated by
  an independent adversarial pass.
- **Additional decision-clean bug FOUND + FIXED (#3499): a SECOND T2-4 threshold quorum bypass.** The
  focused adversarial hunt found that my earlier re-entry fix (#3446) was incomplete: the cutoff only matched
  return/jump records that *named* the threshold node X, missing re-entry *through* X (a return/jump to an
  upstream ancestor, then forward approval back down to X — the forward step is an `approve` at the upstream
  node with `nextNodeKey=X`, which the cutoff never inspected → `cutoff=NULL` → whole-node fallback → stale
  votes re-counted → single-vote quorum bypass). Fixed by keying the cutoff off the entry *transition* into X
  (`nextNodeKey=X AND nodeKey<>X` OR `targetNodeKey/toNodeKey=X`). **Verify:** real-DB 6/6 incl. a new
  fail-first `N1→X(2-of-3)→N3` through-re-entry test, RED-before confirmed; prior re-entry + cascade `>=`
  regression + timeout-effects 13/13 green. Decision-clean (the round-scoped semantics were already the chosen
  intent).
- **Other surfaces verified CLEAN by the hunt:** inbound webhook (HMAC/timestamp-window/uniform-reject/secret
  redaction incl. redacted-placeholder round-trip rejection, per-ruleId rate limiter), T1-3 approval.completed
  (dual authz re-checked at fire, fail-closed, ledger-idempotent), W7 non-approved backwrite (opt-in,
  lock-fail-closed), SLA scheduler (per-row isolation, single-shot, in-txn deadline re-verify), T2-1+2 bulk
  reassign (`FOR UPDATE`, skips, ≤200 cap, N>M fail-closed). No other decision-clean defect surfaced.
- **OPEN VERIFY-ITEM (potential 4th vector, NOT yet fixed):** the `#3499` cutoff keys off an `approve` record
  whose `nextNodeKey` literally equals X. If an **intermediate condition/cc node sits between the upstream
  return target and X** (`N1 → condition → X`, a linear flow), the upstream approve's `nextNodeKey` may be the
  *condition* node (immediate successor), not X — in which case `cutoff=NULL` → whole-node fallback → the
  through-X bypass could survive for that graph shape. **Not spiraled into a 4th reactive fix this turn**
  (advisor guidance); logged as a verify-item feeding the structural decision below.

## 6b. STRUCTURAL owner-decision — durable round-scoping vs reactive patching

This is the **3rd patch to the same cutoff heuristic** (#3446 name-X · #3453 same-version cascade · #3499
through-X), and the verify-item above may be a 4th. Reconstructing "which round am I in" by pattern-matching
`nextNodeKey`/`targetNodeKey`/`toNodeKey` across append-only records is inherently whack-a-mole. The register's
originally-proposed **Option B (`nodeEntryEpoch`)** — a per-node-entry epoch stamped at activation and carried
on each approve record, so the tally filters `metadata.nodeEntryEpoch = <current>` — makes round-scoping
**provably complete** regardless of entry vector, at the cost of one schema/stamping change (#3446 deferred it
as "simpler without it"). **Owner decision:** keep patching the cutoff heuristic reactively, OR do the one
`nodeEntryEpoch` migration that closes the class. Recommend the epoch; it retires this whole bug family
(and the verify-item) in one ratified change.

## 7. Bottom line

The buildable-without-a-vote surface is completed + verified — **two decision-clean bugs found + fixed this
batch: the node-timeout deadline-clear race (#3497, merged) and a second T2-4 threshold quorum bypass (#3499)**
— plus a broader-surface hunt that verified the rest of the recently-shipped runtime clean. The heavy remainder
is owner-gated;
it is now one vote from build in three genuinely-parallel lanes (B / C / D), with the two nearest rungs
(T3-5, T1-4) design-locked. Recommended fastest path: vote T3-5 + T1-4 to start B/C, and open Lane D on
T3-6 (the differentiation move) in parallel. Sizing figures are optimistic build-effort, NOT calendar
commitments — the security/permission/product rungs' review rounds can dominate.
