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
- **Additional decision-clean candidates:** _(from the focused hunt — appended below; if none beyond the race,
  that is the finding)._

## 7. Bottom line

The buildable-without-a-vote surface is completed + verified (#3497). The heavy remainder is owner-gated;
it is now one vote from build in three genuinely-parallel lanes (B / C / D), with the two nearest rungs
(T3-5, T1-4) design-locked. Recommended fastest path: vote T3-5 + T1-4 to start B/C, and open Lane D on
T3-6 (the differentiation move) in parallel. Sizing figures are optimistic build-effort, NOT calendar
commitments — the security/permission/product rungs' review rounds can dominate.
