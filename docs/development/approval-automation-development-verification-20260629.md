# Approval & Process-Automation — development & verification report (2026-06-29)

> Response to: "complete all development per the dev-plan/TODO, then give a dev & verification MD that
> reaches DingTalk/Feishu approval-&-automation parity." This report is **honest about what "complete
> all" can and cannot mean in one pass**, what shipped + how it was verified, and exactly what gates the
> rest. Companion artifacts: the **decision register** (`approval-automation-decision-register-20260629.md`),
> the **design-lock pack** (`approval-automation-design-lock-pack-20260629.md`), and the evidence base —
> the **refresh audit** (`docs/research/approval-automation-refresh-audit-20260629.md`).

## 1. The honest finding (why "complete all 20 rungs, merged" was not the deliverable)

A code-grounded design-lock workflow authored **and adversarially reviewed** all 17 remaining
heavy/decision rungs. The verdict: **every one is owner-gated — zero are decision-clean.** The reviewers
surfaced **135 open product/security/migration decisions** (4–11 per rung), each with a proposed default.
The code for a rung cannot be *correct* until those decisions are made — which is precisely why the
dev-plan marked these design-lock-first. So the truthful shape of "complete all development" is:

- **Ship the genuinely decision-clean code now** (done — §2), and
- **Bring every remaining rung to implementable design depth + surface its decisions** (done — the pack +
  register), so each is one owner-decision away from a build.

Forcing 20 merged PRs would have meant fabricating decisions only the owner can make, and landing
broken/unreviewed code. It was not done, by design.

## 2. Shipped + verified this session (real code, real tests)

| Item | PR | What | Verification |
|---|---|---|---|
| **T0-2 W7 resultWriteback UI** | **#3384** (reviewable) | exposes the shipped approved-path backwrite config in the `start_approval` editor — 3 pickers (`statusField`/`approverField`/`completedAtField`), preserve-current-value, omit-when-empty, explicit-carry + `requester` pass-through | `vue-tsc -b` clean · 116 specs (5 new) · **3 fail-first claims verified by revert** |
| **R3 inert-trigger removal** | **#3382** (reviewable) | drop `webhook.received` from the editor selectable set (runtime-inert → silently never fired); backend enum left intact | editor spec 100/100 (asserts not-selectable) |
| **R2 redaction regression** | **#3382** | DB-backed guard: `ApprovalBridgeService.getApproval` strips a `hidden` field, stored snapshot untouched; sentinel guards silent skip | real-DB 2/2, exercises the real redaction chain |

**Verification discipline:** every diff was reviewed by hand (not subagent self-report); tests assert the
real wire, not hand-built fixtures; fail-first tests were confirmed RED by reverting the change they
target. Both PRs are held **reviewable** (CI running) — not auto-merged.

**One honest deviation on T0-2 (needs your nod, in #3384):** the merged design-lock §5 framed the P2 test
as fail-first at *save*. Empirically, Vue `<select v-model>` retains the bound value when it leaves the
options, so `buildPayload` (reading the binding, not the DOM) carries a stale value regardless — the
genuine P2 lever is at the **DOM** (the stale value stays a present+marked option), which the test
asserts as fail-first, **plus** the save Guarantee (holds via binding-persistence). The implementation is
*more* correct than the lock's framing; flagged because it deviates from a lock you reviewed.

## 3. The gate to everything else — the decision register

All 17 remaining rungs are catalogued in the **decision register** with their open decisions + proposed
defaults. The fastest path to building any of them: **approve its proposed defaults (or override), and it
becomes design-lock-first buildable.** A few high-signal examples (full list in the register):

- **T0-3 expose `delete_record`** (7 decisions) — default: same-base trigger-record delete only, required
  anti-misdelete acknowledgement kept out of persisted config, no cross-base UI in v1.
- **T1-1 node-level SLA + timeout** (8) — the open call is the timeout effect set + invalidation semantics.
- **R1 BPMN governance + SSRF** (7) — the security containment approach (gate the route / allowlist
  service-task fetch); this is the discovered-risk ticket, recommend triaging first.
- **T3-4 W7 rejection backwrite** (6) — the product call: write-back-then-continue-tail vs -then-fail.

Caveat: **T1-3, T2-4, T3-6** had cited anchors the adversarial reviewer could not fully confirm — verify
the code references before building those three.

## 4. Parity verdict — *parity-ready plan + N shipped*, not "parity achieved"

Stated plainly, without inflating to match the request: **breadth is already near-parity** (the audit
showed the June work closed 会签/或签, 加签/减签, 抄送, conditional+formula routing, auto-approval merge,
admin-jump, dynamic manager-chain assignees, amount/formula fields, detail sub-forms, delegation, version
freeze). **This session** ships the contained depth items and brings **every** remaining rung to
implementable design depth with its decisions surfaced. **Full parity is not achieved** — it still
requires the L arcs (mobile approval, scoped-admins + handover, business-calendar-wired SLA,
signature/compliance, the S-band approval-as-records) plus the 135 named owner decisions. The honest
status is: **a complete, decision-ready plan to parity, with the decision-clean increment shipped.**

## 5. Recommended completion sequence (each a separate opt-in after its decisions land)

1. **Land the shipped increment:** confirm the T0-2 §5 deviation (#3384), merge #3384 + #3382.
2. **Triage the risk ticket R1** (BPMN governance/SSRF) — security, independent of features.
3. **First parity arc — T1-1 node-level SLA + timeout actions** (highest benchmark value, no hard deps)
   once its timeout-effect decisions are approved.
4. Then T1-2 inbound webhook · T1-3 `approval.*` trigger · T1-4 field-perms — per their registers.
5. Ops/admin (T2-*) and strategic L arcs (T3-*) as scoped, decision-led arcs.

Nothing in §5 is started by this report. Approve a rung's register entries and I'll produce its
design-lock then implementation, verified the same way as §2.
