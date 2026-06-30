# Approval & Process-Automation — Tier-1 completion & verification (as-built, 2026-06-30)

> The **as-built** design & verification record for the ratified Tier-1 rungs — what was actually
> implemented and how it was verified (the capstone to the pre-build specs #3397, ratify-plan #3396,
> decision register #3385). **Scope honesty:** Tier-1 is the *ratified* subset; the un-shipped Tier-2/3
> rungs are owner-decision-gated (security / permission / destructive / product) and remain
> design-lock-first pending ratification — not built on guesses. Parity verdict (unchanged): **ratified
> Tier-1 complete + verified; full DingTalk/Feishu parity still needs the Tier-2/3 arcs.**

## 1. The four ratified Tier-1 rungs — as built + verified

| Rung | PR | State | What shipped | Verification (real) |
|---|---|---|---|---|
| **T2-3** person/team analytics | #3387 | **merged** | `/api/approvals/metrics/people`+`/teams` over the existing metrics JOIN; **Q4 gating: `/people` → new `approvals:analytics` permission, `/teams` → `approvals:admin`** | tsc 0 · router unit 9/9 (incl. per-code 403/200) · real-DB integration 3/3 (dept wire-drift catch) |
| **T1-1** node-level SLA + `remind` | #3404 | **merged** | per-node timeout deadline on `approval_metrics` + leader-gated scanner → `remind` active assignees via dedicated `notifyNodeReminder`; publish-validation; covers first-node + transition-reached nodes | tsc 0 · metrics unit **16/16** (incl. P1a re-emit no-op lock) · real-DB integration **4/4** (single-shot, idempotency-P1a, first-node) |
| **T2-4** N-of-M threshold | #3406 | auto-merging | `'threshold'` node mode (N = distinct approvers, first-N-wins cancel, single-reject still rejects, linear-only); **N>M fail-closed at resolution + runtime backstop** | tsc 0 · 4 validation unit tests · real-DB integration **3/3** (2-of-3 resolves on 2nd, single-reject, **N>M→422 fail-closed**) |
| **T2-5** timezone scheduling | #3401 | reviewable (awaits owner timezone APPROVE) | cron + date-reminder tz-aware (DST fire-once/skip), fail-closed IANA validation, startup audit; UTC path byte-identical | tsc 0 · DST goldens green · automation-v1 211 · UTC-unchanged regression goldens |

**Verification discipline applied throughout:** every diff hand-reviewed (not subagent self-report); real-DB
tests assert the real wire (not hand-built fixtures); fail-first tests confirmed RED-before/green-after
(e.g. T2-4's N>M 201→422); CI-wiring added for every DATABASE_URL-gated test (both the no-DB exclude and
the approval real-DB whole-file list — no skip-green).

## 2. Defects caught + fixed during review (owner-found P1s + latent bugs)

- **T1-1 foundation P1a/P1b/P2** (owner review): deadline stamp made idempotent (re-emit no-op); v1 forbids
  node timeouts inside a parallel region (single scalar can't hold parallel deadlines); `markNodeTimeoutFired`
  clears effect too. **Decision recorded:** the deadline write is **best-effort + separate** (matches the
  all-best-effort metrics design), locked by unit tests.
- **T1-1 latent bug:** the node normalizer's strict whitelist was silently dropping `timeout` before
  publish/runtime — fixed (without it the feature was a no-op).
- **T2-4 P1 (owner review):** N>M (threshold exceeds the *resolved* approver count, e.g. a dynamic/role
  source resolving fewer than N) used to silently approve once assignments ran out — now **fail-closed at
  resolution** (`APPROVAL_THRESHOLD_UNREACHABLE`, 422) + a runtime backstop. Real-DB fail-first test locks it.

## 3. Known non-blocking follow-ups (tracked, not P1)

- **T2-4 role-member precision:** create-time reachability checks *resolved assignment slots*; an
  overlapping-role-member case (slots reachable but distinct actors < N) is still caught fail-closed by the
  runtime backstop (never a silent approve) — a more precise role-member expansion pre-check is a future UX
  improvement.
- **T1-1 slice 2:** `transfer`/`jump` timeout effects (state-mutating — reuse the dispatch with a
  `system:approval-timeout` actor) + the terminal `auto_approve`/`auto_reject` behind an explicit env flag.
- Node-timeout per-node storage (to lift the parallel-region restriction) — a future enhancement.

## 4. What remains un-shipped (and why it's gated, not incomplete)

The **Tier-2/3** rungs are owner-decision-gated by construction — each carries a security, permission,
destructive, or product decision that is the owner's to ratify, not mine to guess. Per the discipline held
all session, these are **design-lock-first even after a GO**:

- **Tier-2 (security/permission/destructive):** R1 BPMN/SSRF containment (a *live* exposure — recommend
  triaging first), inbound webhook, `approval.*` trigger, scoped-admins + handover, `delete_record`, W7
  cross-base.
- **Tier-3 (product/L-arcs):** W7 rejection backwrite, business-calendar SLA, signature, mobile, S-band.

Each is one ratification away from a design-lock, then a build — the register (#3385) holds the decisions +
recommended defaults; the ratify-plan (#3396) holds the order.

## 5. Verdict

**Ratified Tier-1 scope is complete and verified** (T2-3 + T1-1 merged; T2-4 auto-merging; T2-5 reviewable
pending the owner's timezone APPROVE). Breadth is near-parity; this arc closed the contained depth (analytics,
node-SLA reminders, N-of-M voting, timezone scheduling) on top of the prior arc (W7 UI, risk fixes). **Full
parity is not achieved** — it needs the owner-gated Tier-2/3 arcs, each ratified then built design-lock-first.
The honest stopping point: the authorized work is done; the remainder is gated on owner decisions, not
engineering readiness.
