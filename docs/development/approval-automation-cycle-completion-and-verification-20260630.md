# Approval & Process-Automation — cycle audit, completion & verification (2026-06-30)

> A code-grounded re-audit of the line against current `main` (HEAD `f14be042e`), the decision-clean work
> completed this cycle (with verification), one newly-found latent defect surfaced for a decision, and the
> remaining backlog with a recommended GO order. **Honest headline:** the *ratified-buildable* feature set is
> exhausted — every remaining rung is owner-gated by an open security/permission/destructive/product/migration
> decision (re-confirmed against code, not just docs). So this cycle completes the **decision-clean hardenings**
> (which need no owner decision) and teees up the gated rungs for a one-word GO.

## 1. Where the line stands (code-verified, not doc-trusted)

A 4-reader audit verified each capability against the actual code (greps + file:line), not the planning docs.

**Shipped + verified on `main`:**

| Capability | PR | Evidence |
|---|---|---|
| T2-3 person/team analytics | #3387 | `routes/approval-metrics.ts` /people (`approvals:analytics`) + /teams (`approvals:admin`); migration `…090000` |
| T1-1 node-SLA **slice-1 (remind only)** | #3404 | `NODE_TIMEOUT_SUPPORTED_EFFECTS = {'remind'}` (ApprovalProductService:311); deadline cols on `approval_metrics`; leader scanner |
| T2-4 N-of-M threshold | #3406 | `'threshold'` mode + `approvalThreshold`; dual fail-closed N>M (executor 422 + runtime backstop) |
| T2-5 timezone scheduling | #3401 | `automation-timezone.ts` (IANA fail-closed, DST fire-once/skip); UTC byte-identical |
| date_field floating-day fix | #3417 | `floatingCalendarDay` literal-day; date-only widened SQL bounds (HEAD is this commit) |
| T0-2 W7 resultWriteback **backend** | #3384 | approved-path backwrite + `statusField/approverField/completedAtField` validation (automation-service.ts) |
| R2 redaction (public path) / R3 editor | #3382 | bridge `redactHiddenFormFields`; `webhook.received` removed from the editor selectable set |

**Partial-by-design / latent (verified):** T1-1 slice-2 (transfer/jump/auto_* still publish-rejected); R2 is a
*latent* gap — `toUnifiedApprovalDTO` returns `form_snapshot` verbatim, redaction lives only on the public
bridge path; `webhook.received` remains a runtime-inert trigger enum entry (kept until T1-2).

## 2. Completed this cycle (decision-clean — no owner decision required)

All three are pure correctness/robustness on shipped code, built + verified, merge-ready on branch
`claude/approval-automation-audit-20260630`:

- **(1a) `offsetDays` save cap** (`5f5253049`). The save validator accepted any non-negative integer, so an
  absurd value (1e12) overflowed the candidate-range `new Date(ms).toISOString()` with a `RangeError` and
  aborted the **whole scan** for the rule. Added `MAX_DATE_REMINDER_OFFSET_DAYS = 36500` (~100y) fail-closed
  at save. *Verify:* unit (range OK at cap) + real-DB `DR-VAL` (createRule rejects 1e12).
- **(1b) Runtime degrade-not-throw** (`54655c0f1`). The save cap only guards the API path; a **persisted**
  out-of-range offset (direct-DB / pre-cap) still threw at scan. Added a magnitude clamp in the pure functions
  (mirrors the junk-tz "degrade, never throw" posture) → bounded output, never an aborting `RangeError`.
  *Verify:* unit golden updated — 1e12 now degrades (no throw), clamped result equals the at-cap bounds.
- **(2) Deterministic analytics Top-N** (`54655c0f1`). `byTemplate` / `byPeople` / `byTeams` used
  `ORDER BY COUNT(*) DESC LIMIT 100` with no tie-break → nondeterministic which buckets survive the cut. Added
  the group key as a secondary ASC sort. *Verify:* 16 approval-metrics unit + 3 people/teams real-DB green.

**Cycle verification total:** tsc 0 · 39 date-reminder unit · 16 approval-metrics unit · 19 + 3 real-DB green.

## 3. Newly-found latent defect — surfaced for a decision (NOT auto-fixed)

**T2-4 threshold re-entry quorum bypass** *(reachability self-verified, not reader-trusted).* The threshold
tally `COUNT(DISTINCT actor_id) … WHERE instance_id=$1 AND action='approve' AND metadata->>'nodeKey'=$2`
(ApprovalProductService ~4178) is **not scoped to the current node-entry round**. The **return (退回) path**
(`~3996`) admits any *previously-visited* approval node as a target — which an already-resolved `threshold`
node is — and on return `deactivateAllActiveAssignments` + `resolveReturnToNode` re-activate it while the prior
`approve` records stay (records are append-only; nothing clears them). So a 2-of-3 node where A+B approved,
then someone 退回s back to it, is re-satisfied by a **single** fresh approval on the 2 stale votes (the tally
reads `priorDistinct(A,B)=2 + 1`). *(Admin-jump can't trigger this — `isReachableDownstream` only goes
forward; the return path is the reachable vector.)* A quorum bypass in a voting mechanism — security-relevant.

This is **owner-gated** because the fix is a vote-scoping *semantic* choice, not a one-liner. **Proposed
default:** scope the tally to approvals at/after the node's latest activation (`node_breakdown[].activatedAt`
is already recorded), and reconcile with add-sign/reduce-sign. I can land it as a fail-first real-DB test
(RED on current code) + the fix in one PR on your GO. *(Analogous to the date-field P2 you caught — a real
bug found by review, held for a ratified fix rather than guessed.)*

## 4. The remaining backlog is entirely owner-gated — recommended GO order

All 13 un-shipped rungs were re-validated against code: each still carries a live open decision (none entered
the ratify→ship pipeline). Recommended order for your next GO, each one design-lock-first:

1. **R1 — BPMN governance + SSRF containment** *(LIVE EXPOSURE — do first).* `/api/workflow` is mounted
   `authenticate`-only (no RBAC) and `BPMNWorkflowEngine` runs a process-supplied `fetch()` (authenticated
   SSRF). This is an exposure, not a feature gap. **Recommend GO #1.**
2. **T0-3 — expose `delete_record` in the editor** *(cheapest, S).* Executor exists; needs confirm + permission
   + anti-misdelete + same-base-only + the `validateCrossBaseWriteConfig` delete/lock extension.
3. **T2-6 — event-driven dedup ledger** *(substrate).* `record.*`/`form.submitted` rules re-run side effects on
   redelivery; this is the idempotency substrate several later rungs lean on. Do just before T1-3.
4. **T1-3 — `approval.*` automation trigger** *(unblocks the most).* Exposes the completion event as a
   first-class rule trigger; carries the routing-key / templateId-null / loop-depth / cross-tenant decisions.
5. **T1-1 slice-2 — transfer/jump timeout effects** — the transfer + direct-jump core is decision-clean against
   the ratified T1-1 defaults (config `transferToUserId`/`jumpToNodeKey`, actor `system:approval-timeout`,
   `metadata.timeoutEffect`, reuse `buildTransferAssignments`/`resolveReturnToNode`; parallel-region already
   rejected; direct jump-to-terminal already blocked). **One open carve-out:** an *indirect* jump to an
   approval node that then auto-completes (e.g. `mergeWithRequester`) cascades to terminal — effectively a
   timeout auto-approve. Proposed default: treat that cascade as a terminal effect → keep it behind the same
   `auto_approve`/`auto_reject` env gate. Design-lock that carve-out, then it's GO-ready.
6. Then **T1-4** (node field-perms authoring + readonly/editable runtime; dep: edit-form-at-node) ·
   **T3-4** (W7 rejection backwrite; product call: write-then-fail vs write-then-continue) ·
   **T3-5** (W7 cross-base; security arc through the cross-base write gate) ·
   **T1-2** (inbound webhook; signature/replay/audit contract) ·
   **T2-1+2** (scoped admins + handover; permission model + migration) ·
   **T3-2** (business-calendar SLA; cross-domain wiring, dep T1-1) · **T3-3** (signature) ·
   **T3-1** (mobile; blocked on a notification hub) · **T3-6** (S-band approval-as-records; product-model).

Design-locks for all of these already exist in the design-lock pack (#3385) + decision register (#3385); each
is one ratification (approve-defaults or override) away from a build.

## 5. Verdict

The authorized, decision-clean work is **done and verified** (three hardenings, merge-ready). The line is at a
clean gate: no ratified-buildable feature remains un-built, one real defect is surfaced for your decision, and
the gated backlog is prioritized with R1 flagged as a live exposure to triage first. Nothing here was
auto-built past an owner decision — the state-mutating and security/permission/destructive rungs stay
design-lock-first, awaiting your GO.
