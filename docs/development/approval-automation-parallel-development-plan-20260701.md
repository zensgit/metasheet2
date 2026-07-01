# Approval & Process-Automation — un-completed items, parallel-development plan & verification (2026-07-01)

> Deep review of what remains on the line (against main `dabd5217b`), classified by gating, and **sequenced
> into parallel lanes** so work can be distributed across sessions without collision. **Honest framing:** the
> substantial remainder is owner-gated (design-lock-first) or already being worked by parallel sessions — so
> "complete all development" is realized by *ratifying + distributing the lanes*, not by one session building
> everything. This doc is the coordination map + the design-lock readiness state; per-item verification is
> noted per lane.

## 1. Current state (shipped on main)
- **Tier-1:** T2-3 analytics, T1-1 node-SLA slice-1 (remind-only), T2-4 threshold mode, T2-5 timezone,
  date_field floating-day fix. **Cycle hardenings:** offsetDays save-cap + runtime clamp, analytics Top-N
  tie-break. **W7** approved-path resultWriteback (backend).
- **R1-A (SSRF):** `validateEgressUrl` egress guard + `isBlockedEgressIp` classifier (mapped/NAT64/6to4/Teredo/
  ISATAP-`0000:5efe`/IPv4-compatible), `#3437` landed; further guard hardening in flight (`#3443` NAT64 merge).
  **Not wired** to `BPMNWorkflowEngine.ts:550` yet — that's R1-B.

## 2. Un-completed items — gating

| Item | Subsystem | Status | Gating |
|---|---|---|---|
| **R1-B** DNS-pinned dispatcher + wiring + redirect re-validation | BPMN/workflow | unshipped | **ratified-buildable** (D0-D5 ratified, #3437 precondition met) — *being surveyed/worked by #3442/#3443* |
| ISATAP `0200:5efe` u/l-bit residual | BPMN (guard) | unshipped | decision-clean, tiny — in the egress-guard hot area (#3443) |
| **T2-4** threshold re-entry quorum-bypass fix | approval engine | unshipped | **needs-owner-decision** (round-scoping mechanism) — confirmed real bug |
| T1-1 slice-2 transfer/jump timeout effects | approval engine | unshipped | owner-gated (indirect jump→terminal carve-out; auto_* env-gated) |
| T2-1+2 scoped admins + handover | approval engine | unshipped | owner-gated (permission model + migration) |
| T1-4 node field-perms runtime | approval engine | unshipped | owner-gated (edit-form-at-node prerequisite) |
| T3-4 W7 rejection backwrite | automation/approval | unshipped | owner-gated (write-then-fail vs continue-tail; opt-in) |
| T3-5 W7 cross-base backwrite | automation/approval | unshipped | owner-gated (cross-base write-gate re-lock) |
| T0-3 delete_record editor | automation engine | unshipped | owner-gated (destructive, 7 decisions) |
| T1-2 inbound webhook | automation engine | unshipped | owner-gated (signature/replay/audit, 9 decisions) |
| T1-3 approval.* trigger | automation engine | unshipped | owner-gated (routing/loop/cross-tenant, 8 decisions) |
| T2-6 event-driven dedup ledger | automation engine | unshipped | owner-gated (substrate for T1-2/T1-3) |
| T3-2 business-calendar SLA · T3-3 signature · T3-1 mobile · T3-6 S-band | product/heavy | unshipped | owner-gated, L (T3-2 dep T1-1) |

## 3. Parallel-development lanes (the sequencing)

The line is **three largely-independent subsystems** — they can run **concurrently** in separate sessions.
The constraint is **hot files**: items sharing one runtime file must be **sequential within a lane** (parallel
edits to `ApprovalProductService.ts` / `automation-service.ts` collide).

- **Lane A — BPMN/workflow** (`BPMNWorkflowEngine.ts`, `routes/workflow*`, `guards/egress-guard.ts`):
  `R1-B` (dispatcher + wiring) + the `0200` guard residual. *Already in flight (#3442/#3443) — one session
  owns this; do not fork it.*
- **Lane B — approval engine** (`ApprovalProductService.ts` — HOT, so sequential): `T2-4 fix` → `T1-1 slice-2`
  → `T2-1+2` → `T1-4`. (`T3-4/T3-5` W7-backwrite touch `automation-service.ts`, see Lane C.)
- **Lane C — automation engine** (`automation-service.ts` — HOT, so sequential): `T2-6 dedup` (substrate) →
  `T1-3 approval-trigger` / `T1-2 webhook` → `T0-3 delete_record` → `T3-4`/`T3-5` W7-backwrite.
- **Lane D — product/heavy** (separate surfaces): `T3-1 mobile`, `T3-6 S-band`, `T3-2 business-calendar`
  (dep T1-1), `T3-3 signature`.

**Hard deps:** R1-B→#3437 (met) · T2-2→T2-1 (permission model) · T3-2→T1-1 (node-SLA) · T1-2/T1-3 lean on
T2-6 (dedup substrate). **Cross-lane collision risk:** Lane B and the W7 items in Lane C both eventually touch
approval-completion code — keep W7-backwrite in Lane C to avoid `ApprovalProductService`/`automation-service`
double-editing.

## 4. What's ready to build vs needs a decision
- **Ready now (ratified):** R1-B — owned by Lane A's in-flight session.
- **Needs one owner decision, then build:** **T2-4 fix** — the round-scoping mechanism (design-lock below).
- **Owner-gated (approve register defaults → then build):** everything else. The register (#3385) holds each
  rung's open decisions + proposed defaults; a per-rung "approve defaults" unlocks it.

## 5. T2-4 quorum-bypass fix — design-lock (the one confirmed bug ready for GO)

**Bug (confirmed, self-verified reachable):** the threshold tally `ApprovalProductService.ts:4179`
(`COUNT(DISTINCT actor_id) … WHERE action='approve' AND metadata->>'nodeKey'=$2`) is **not scoped to the
current node-entry round**. The 退回/return path (`~3996`) admits any previously-visited approval node —
including an already-resolved `threshold` node — and re-activation keeps the append-only prior approve
records, so on re-entry those stale votes count toward N. A 2-of-3 node where A+B already approved is then
re-satisfied by a **single** fresh vote.

**Mechanism options (this is the owner decision):**
- **A — created_at cutoff:** tally `created_at >= <current-entry instant>`. Simple but the entry instant is
  fragile (distinguishing current- vs prior-round assignment rows under append/deactivate semantics).
- **B — explicit entry epoch (recommended):** stamp `metadata.nodeEntryEpoch` on every approve record and
  tally `WHERE metadata->>'nodeEntryEpoch' = <current>`. Epoch = a monotonic per-node counter (or the instance
  `version` at (re-)activation) recorded at node entry. Robust, self-contained in `approval_records`,
  unambiguous; in-flight instances with no epoch → treated as the current/only round (backward-compatible).
- **C — supersede on re-entry:** mark prior approve records superseded (new column). Migration + mutating an
  audit log — heavier.

**Proposed default: B.** No reliance on best-effort metrics or created_at ordering; a natural extension of the
existing `metadata.nodeKey` stamping. **Owner confirms:** B vs A/C, and the epoch source (instance-version-at-
entry vs a dedicated counter). Edge locks: add-sign/reduce-sign within a round keep the same epoch; both the
first forward activation and each re-entry mint a fresh epoch.

**Fail-first verification (real-DB):** `threshold re-entry` test — 2-of-3 node, A+B approve → node resolves →
instance advances; 退回 back to it; one fresh approval → **assert the node does NOT resolve on the stale A+B
votes** (needs N fresh distinct approvers in the current round). RED on current code (satisfied by stale votes),
green after the epoch scoping. Plus regression: a normal single-entry 2-of-3 still resolves on the 2nd distinct
approval; the N>M fail-closed (`APPROVAL_THRESHOLD_UNREACHABLE`) path is unchanged.

**Status:** design-lock ready. This is a security-correctness fix in Lane B (approval engine), independent of
the in-flight R1/BPMN lane — buildable immediately on a one-word GO of Option B (or an override). On GO I build
it fail-first + real-DB verified, PR for review.

## 6. Recommendation
1. **Lane A (R1-B)** continues in its in-flight session (#3442/#3443) — the slice that closes the live SSRF.
2. **GO the T2-4 fix (Option B)** — I'll take Lane B and land it (confirmed security bug, no collision).
3. **Ratify register defaults per-rung** to unlock the owner-gated items, then distribute Lanes B/C/D across
   sessions (sequential within each lane by hot file). Recommended unlock order from the earlier audit:
   T2-6 (dedup substrate) → T1-3 (unblocks most) in Lane C; T1-1 slice-2 → T2-1+2 in Lane B; T0-3 (cheapest).

