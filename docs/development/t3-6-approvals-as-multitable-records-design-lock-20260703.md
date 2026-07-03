# T3-6 — Approval data as first-class multitable records · DESIGN-LOCK (PROPOSED) · 2026-07-03

> **Status: PROPOSED design-lock — awaiting the T3-6 votes** in
> `approval-automation-third-batch-ballot-20260702.md` (Q1–Q10). This turns the ballot decisions into an
> implementable architecture. **No runtime until voted GO.** T3-6 is the differentiation move: once approval
> data is a multitable read-model, **飞书-grade reporting / dashboards / views / formulas come for free** on the
> existing multitable analytics — instead of a bespoke approval-reporting module. **Re-automation ON the
> projected rows is deliberately v1-OUT** and specified as a gated follow-up (§6a) — see the P1 decision.
>
> **Rev 2 (review):** adds §6a (does the projection write emit `record.*` automation events — the decision
> that gates the "re-automation" claim and its security surface, P1) and §6b (the deterministic reconcile/
> backfill mechanism that keeps the read-model consistent after a best-effort failure, P2).

## 1. Shape — one-way materialized read-model projection

The **approval engine stays the system of record** (Q1). Multitable receives a **one-way projection**: each
approval instance is materialized as a row in a **system-managed sheet**, updated on lifecycle events. No
write-back path from multitable to the engine (the row is a read-model; editing it never mutates the approval).

## 2. Trigger + coupling (Q2, build-contract honesty)

Two projection points — and the coupling is named, not hidden:
- **create** → insert the projected row (pending). Requires an **explicit create hook** in the approval
  create path (`ApprovalProductService.createApproval`) — completion events only fire on terminal outcomes, so
  a create-only pending instance would never project without it. **Auto-approve-at-create** must land on the
  SAME row (create-then-terminal in one transaction → insert-then-update the one row, not two).
- **terminal** (approved/rejected/revoked/cancelled) → update the row's status/outcome/approver/completedAt.
  Reuse the existing `ApprovalCompletionEventV1` bus (`emitApprovalCompletionEvent`) — the same events T1-3 and
  the W6/W7 bridge already consume. In-flight node progress is **out of scope** (waits for a separate
  intermediate-event slice, Q2).

## 3. Projected columns — allowlisted system fields only (Q4, Q6, Q9)

First slice projects **value-constrained system columns only**, never `form_snapshot` (a separate PII-redaction
review gates any form projection — Q4/Q7): `requestNo`, `templateId`/`templateName`, `status`/`outcome` (all
terminal outcomes projected to a neutral read-model — Q9; W7 source-record semantics stay separate),
`requesterId`, `approverId` (raw id strings in v1 — person/link cells are a follow-up, Q6), `createdAt`,
`completedAt`, `currentNodeKey` (nullable). No new record-reference `FormFieldType` (Q8).

## 4. Instance↔record link (Q5) + idempotency

A dedicated **side mapping table** `approval_record_projection (instance_id TEXT PK, base_id, sheet_id,
record_id, projected_version INT)` — unique on `instance_id`. Do **not** add a column to every `meta_records`
row (Q5). Projection is **idempotent**: keyed on the instance id (upsert the mapped record) and guarded by the
event id / a monotonic `projected_version` so an at-least-once redelivery of create/terminal is a no-op (reuse
the **T2-6 `meta_automation_event_fires` claim pattern**, or the `projected_version` compare).

## 5. Sheet provisioning + visibility (Q3, Q10)

**One system-owned base/sheet per template family**, provisioned **lazily** on first projection (Q10;
cross-base projection is a non-goal in the first slice). The sheet is **admin/owner-scoped, system-managed**
(Q3) — per-row approval `visibility_scope` inheritance is a separate slice. The sheet's schema is derived from
§3's fixed column set (system-created, not user-authored).

## 6. Build contract (reviewer must-fixes)

- Explicit **create hook** — do not rely on completion events for the pending-create row.
- **Auto-approve-at-create** maps to the SAME projected row as ordinary create-then-terminal.
- **Name the coupling**: this DOES add an approval-side create hook — state it; the projection is not
  "zero approval coupling".
- **PII**: project only the §3 allowlist; full-form projection is gated behind the Q7 erasure/legal-hold policy.
- **Idempotent** under redelivery (§4); a re-projected event never creates a duplicate row.
- Projection failures are **best-effort** (never fail the parent approval flow — mirror the metrics/W7
  best-effort posture); made consistent by the reconcile mechanism in §6b (not merely "noted").

## 6a. Does the projection write emit `record.*` automation events? — DECISION (P1)

The projection writes rows into a multitable sheet. Whether that write goes **through the automation event
bus** (firing `record.created` / `record.updated`) is a load-bearing decision that gates both the
"re-automation" claim and a real security/loop surface — it must be decided here, not defaulted in code.

**Decision (v1): NO — the projection write does NOT emit `record.*` automation events.** It is a direct,
system-path materialization (record-service write with the event emission suppressed / bypassed), so:
- the "for free" benefit is precisely scoped to **reporting / dashboards / views / formulas / analytics** over
  the projected data — NOT auto-triggering record automations;
- there is **no projection→automation loop** (a `record.created` rule on the system sheet cannot fire, so it
  cannot `start_approval` → new approval → projection → … );
- no `_automationDepth` threading, no source-marker, no dedup, no per-rule permission reconciliation needed in
  v1.

**Gated follow-up (v2 "re-automation on projected rows"), if later voted:** emitting events would require ALL
of — a **source marker** (`triggerEvent._projectionSource='approval'`) so downstream rules can distinguish a
projection write from a user edit; a **loop/depth guard** (seed `_automationDepth`, and forbid `start_approval`
on the system sheet's rules) to break projection→approval→projection cycles; a **T2-6 dedup key**
(`approval.projection:{instanceId}:{projected_version}`) so a re-projection is not a re-fire; and a
**permission boundary** (whose authority runs those rules on a system-owned sheet). Until that is designed and
voted, the projection is event-silent. *(This resolves the doc's earlier over-broad "re-automation for free".)*

## 6b. Reconcile / backfill — deterministic self-heal (P2)

Best-effort projection means a create or terminal write can be lost (transient DB error, a missed event). The
read-model must be **self-healing**, not permanently drifted:

- **`reconcileApprovalProjection(instanceId)`** — reads the AUTHORITATIVE state from `approval_instances` (+
  `approval_records` for the outcome/approver/timestamps) and re-derives the §3 columns, then **idempotent
  upsert** into the mapped record **guarded by `projected_version`**: write only if the source's version is
  newer than the mapping row's `projected_version` (so a concurrent live projection is never clobbered). Creates
  the mapping + record if absent.
- **Sweep** — a periodic scan (mirror the SLA scanner / T2-6 retention sweep, leader-gated) that finds
  instances whose `approval_instances.version > projection.projected_version`, or terminal instances with no
  mapping row, and reconciles them. Plus an **on-demand admin endpoint** to reconcile one instance or a full
  template family.
- **Observability** — the mapping row carries `projected_version`, `last_projected_at`, `last_error`; a drift
  metric (`approval_projection_stale_total`) surfaces rows behind their source. So a lost write is visibly
  caught and repaired on the next sweep instead of silently rotting the report.

## 7. Verification plan (fail-first)

- **create** → a projected row appears in the system sheet with pending status + the §3 columns; the mapping
  row links instance→record.
- **terminal** (each of approved/rejected/revoked/cancelled) → the SAME row updates outcome/approver/
  completedAt; no second row.
- **auto-approve-at-create** → exactly one row, terminal.
- **redelivery** of create and of terminal → no duplicate row / no double-update (idempotent).
- **no write-back**: editing the projected record does not mutate the approval instance.
- **visibility**: the system sheet is admin/owner-scoped; a non-admin cannot read it in the first slice.
- **best-effort**: a forced projection failure does not fail the approval transition.
- **event-silence (§6a)**: a projection create/update fires NO `record.created`/`record.updated` automation —
  assert that an automation rule on the system sheet does NOT execute when a projection row is written/updated.
- **reconcile (§6b)**: delete/stale a mapped row (simulate a lost write), run `reconcileApprovalProjection`
  (and the sweep) → the row is restored to the authoritative §3 columns; run it again → no change (idempotent
  by `projected_version`); a concurrent newer live projection is not clobbered.

## 8. Open owner decisions (the ballot votes + the two rev-2 decisions)

Q1–Q10 in the third-batch ballot — load-bearing: Q2 (accept the explicit create-hook coupling), Q4/Q7
(allowlist-only now; form/PII gated), Q5 (side mapping table). **Plus the two decisions this rev makes
explicit:** **P1 (§6a)** — projection is event-SILENT in v1 (re-automation gated to a v2 with source-marker +
loop-guard + dedup + permission); **P2 (§6b)** — a deterministic `projected_version`-guarded reconcile
job/endpoint + sweep is part of v1, not a "noted" afterthought. Recommend adopting all as proposed.

## 9. Status / next step

PROPOSED. On the T3-6 votes → implement in **Lane D** (a new projection service subscribing to the completion
bus + the new create hook + record-service; a migration for the mapping table + the system sheet provisioning),
fail-first + real-DB per §7, PR-for-review. This is the highest-differentiation remaining item — it converts
the approval line's analytics story from "build a reporting module" to "reuse multitable".
