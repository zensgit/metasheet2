# Approval & Process-Automation — development plan & gated TODO (2026-06-29)

> **For review.** This is the actionable plan derived from the code-grounded refresh audit
> (`docs/research/approval-automation-refresh-audit-20260629.md`, which holds the evidence + the
> benchmark rationale). This doc states MetaSheet capability requirements in our own terms (brand-neutral);
> the competitor mapping lives in the audit.
>
> **This document authorizes nothing.** Every item is a separate, demand-gated opt-in; items with
> non-trivial semantics are **design-lock-first** (a design doc + this-style TODO must land and be
> approved before any runtime/UI code). Status markers:
> **🔒** gated — needs an explicit owner GO · **⬜** GO'd, not started · **🟡** in progress · **✅** shipped.
> Sizes: **S** ≈ ≤1–2 PRs contained · **M** ≈ a small arc · **L** ≈ a multi-PR arc with its own design-lock.

## Where we are (one line)
Core is **done**: baseline 9/9, P1 3✅+1🔶, automation engine mature (8/9 triggers live, 12+2 actions,
full scheduler/jobs/suspend-resume/conditions/retry/depth/idempotency), W6 + W7 approved-path shipped.
Frontier = P2 (0✅/3🔶/3⬜), P3 (1✅/2🔶/2⬜), the S-band, a short parity list, and a risk-triage track.

---

## Track R — Risk triage (fix/decide; independent of the feature ladder, do NOT wait on it)

These are not "build-next" features — they are exposures/decisions the audit surfaced. Recommend tickets now.

- [ ] **🔒 R1 — BPMN runtime governance + SSRF containment.** `/api/workflow` (deploy/start/complete) is
  mounted `authenticate`-only (no RBAC) and `executeServiceTask` runs an `http` task as a real `fetch()`
  to a process-supplied URL → authenticated-SSRF; the legacy `BPMNWorkflowEngine` is an un-governed
  executable runtime (breaks the "designer = preview-only" convergence fence). *(Script task is sandboxed
  — not RCE.)* **Action:** gate the route behind an explicit permission or feature-flag it off; allowlist/
  constrain service-task fetch targets. Same action enforces the convergence fence. **Size M · design-lock
  (security) first.**
- [ ] **🔒 R2 — Approval hidden-field redaction hardening.** `getApproval` returns the un-redacted
  snapshot; `hidden` redaction lives in a separate read-layer module. **Action:** regression-test every
  approval read path through the redaction layer (or push redaction into the snapshot getter). **Size S.**
- [ ] **🔒 R3 — `webhook.received` inert trigger.** Editor-selectable + validated + persisted but never
  fires (no event map / no ingestion route). **Action:** remove it from the selectable set now (**Size S**),
  or build the real inbound endpoint (= T1-2, **Size M**). Until then the UI advertises a trap.

---

## Track 0 — Finish-lines (close already-built capability; cheap, high-trust)

- [ ] **🔒 T0-1 — W6 deployed operator sign-off.** Owner decision on PR #3373: accept the in-process seam
  as ship evidence, or require the deployed staging smoke first. **No dev** — a governance close-out.
- [ ] **🔒 T0-2 — W7 `resultWriteback` UI implementation.** The design-lock (#3375) is **merged**; implement
  per it: three optional source-field pickers (status/approver/completedAt), omit-when-empty, **preserve the
  current configured value in each picker** (P2 fix), explicit-carry in `buildActionPayload` (+ pass
  `requester` through), two fail-first round-trip tests. **Size S–M · design-lock done → ready on GO.**
- [ ] **🔒 T0-3 — Expose `delete_record` in the rule editor.** Full guarded executor support exists but it
  is backend-only. Add to the selectable set behind confirm + permission + anti-misdelete. **Size S.**

## Track 1 — High-frequency parity (contained)

- [ ] **🔒 T1-1 — Node-level SLA + timeout actions.** Per-node timeout with a defined effect set
  (remind / transfer / jump / auto-approve / auto-reject). Today SLA is template-level + remind only.
  **Highest parity value, no hard deps — recommended first feature arc after the finish-lines.**
  **Size M · design-lock-first** (timeout-effect + invalidation semantics).
- [ ] **🔒 T1-2 — Inbound webhook endpoint** (signed, audited) — makes `webhook.received` real (closes R3).
  **Size M · design-lock-first** (signature + trigger-audit contract).
- [ ] **🔒 T1-3 — `approval.*` automation trigger.** "On approval terminal (approved/rejected/…) → run an
  automation rule." The completion event already drives W6 resume; this exposes it as a first-class rule
  trigger. **Size M · design-lock-first** (trigger contract + loop/depth guard).
- [ ] **🔒 T1-4 — Finish P1-C node field-permissions.** `readonly`/`editable` runtime (today only `hidden`
  works) + authoring UI. **Size S–M · dep:** edit-form-at-node direction (snapshots are write-once at create).

## Track 2 — Operations & administration maturity

- [ ] **🔒 T2-1 — Scoped approval administrators (P3-A).** Separate template / process / data admin scopes
  vs today's flat perms. **Size L · design-lock-first** (permission model + migration).
- [ ] **🔒 T2-2 — Approval handover / bulk reassign (P3-B)** on leave/role-change. Today only per-instance
  manual transfer. **Size L · dep:** T2-1 permission model.
- [ ] **🔒 T2-3 — Person/team process analytics (finish P3-D).** Template/instance/breach metrics ship;
  add person/team drill-down views. **Size M.**
- [ ] **🔒 T2-4 — N-of-M threshold voting (P3-E).** Today modes are single/all/any only. **Size M ·
  design-lock-first** (node mode semantics + migration/tests).
- [ ] **🔒 T2-5 — Timezone-aware scheduling.** Cron + date-reminders are UTC-only; the `timezone` config is
  accepted but ignored. **Size S–M.**
- [ ] **🔒 T2-6 — Event-driven dedup ledger.** Only `schedule.date_field` is idempotent; a redelivered
  `record.*`/`form.submitted` re-runs side effects. **Size M.**

## Track 3 — Strategic / heavy

- [ ] **🔒 T3-1 — Mobile approval surface.** Web only today. **Size L.**
- [ ] **🔒 T3-2 — Business/work-day calendar wired to SLA** (multi-time-dimension, non-counting windows).
  The calendar exists (attendance) but is unwired. **Size L · dep:** T1-1 node-SLA.
- [ ] **🔒 T3-3 — Handwritten signature / compliance.** Absent. **Size M–L.**
- [ ] **🔒 T3-4 — W7 rejection backwrite.** **Size M · design-lock-first** — the open product call:
  rejected/cancelled/revoked → write-back-then-continue-tail vs write-back-then-fail.
- [ ] **🔒 T3-5 — W7 cross-base backwrite.** **Size M–L · design-lock-first** — security arc
  (perm / lock / audit / target-resolution re-lock); routes through the existing cross-base write gate.
- [ ] **🔒 T3-6 — S-band: approval data as first-class multitable records.** Strategic; broader than the
  narrow W7 bridge. **Size L · design-lock-first** (product-model decision).

---

## Sequencing & dependencies
- **Risk track R** runs in parallel and independent — triage now, don't queue behind features.
- **Track 0** = immediate finish-lines; **T0-2 is the readiest** (its design-lock already merged).
- **First feature arc after finish-lines → T1-1 (node-level SLA):** highest parity value, contained, no
  hard deps.
- **Hard deps:** T2-2 → T2-1 (permission model) · T3-2 → T1-1 (node-SLA).
- **Cleanup adjacency:** remove/guard the inert enum entries (`webhook.received`, `readonly`/`editable`,
  legacy `field.changed`/`notify`/`update_field`) so the contract stops advertising capability that does
  nothing — fold into the owning item (R3, T1-4) rather than a separate sweep.

## Discipline (carried from the capability ladder §8–9)
No generic "approval parity" epic; no three-engine merge; no live BPMN production-runtime *expansion* (R1
is about *containing* the existing one); no hidden approval→record writes; runtime ownership stays per the
convergence doctrine. Each item above is a separate explicit opt-in — **design-lock-first where marked, and
this doc starts none of them.**
