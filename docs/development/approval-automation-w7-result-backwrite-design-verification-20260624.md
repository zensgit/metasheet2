# W7-1 — Approval-result backwrite (审批结果写回): design + verification

Completes the approval↔automation line: when an automation-started approval completes, the approval
**result is written back to the source record** (e.g. 采购审批通过 → 写回采购表 approval_status /
approved_by / approved_at). This was the last demand-gated item on the run-governance track (W7-0
event contract shipped; W7-1 runtime was gated).

## Design — reuse the existing bridge; declared FIXED mapping; no expression templating

The approval↔automation bridge already exists (W6-1, #2469): a `start_approval` action suspends the
automation; the approval completion event resumes it (`handleApprovalCompletionEvent`, with the
action-fingerprint drift guard). W7-1 adds, on that seam:

1. **A declared `resultWriteback` mapping on the `start_approval` action config** — a *fixed* outcome→
   field map: `{ statusField?, approverField?, completedAtField? }` (≥1, each a non-empty source field
   id). The admin picks **which source field receives `outcome` / `approver` / `completedAt`** — not a
   template expression. Validated at rule-save (`validateStartApprovalConfig`).
2. **On resume (approved branch), the bridge writes the mapped values to the source record** —
   `outcome = transition.toStatus`, `approver = actor?.id ?? null`, `completedAt = occurredAt` — taken
   **from the completion event only**, through the record **lock guard** (`ensureRecordNotLocked`).

### Why this shape (the security posture — the reason it was gated)
The obvious-looking alternative — add `{{ steps.X.output.* }}` templating to the `update_record`
writer — was **rejected**. It would open arbitrary-expression interpolation into *every* write path
(re-litigating the redaction / values-free / cross-base-write-gate work the rest of this track
established), to serve one feature. Instead W7-1 is **values-constrained**: the write carries only
fixed outcome values from the event, mapped to admin-chosen fields — never a user-authored string into
the writer. Additional inherited guarantees:
- **Drift-guarded:** the mapping lives in the `start_approval` action config, so the resume-time
  action-fingerprint check already rejects a mapping swapped after the approval suspended.
- **Lock-respecting:** the backwrite goes through `ensureRecordNotLocked` (an automation does not
  implicitly own a record lock — B1 doctrine); a locked/missing record logs + skips, never crashes the
  resume (the automation's remaining actions still run).
- **Null-safe:** `approver` is null on auto/system approval (written null, not crashed).
- **Same-base, approval-only:** writes the source record that started the approval; rejection-path
  backwrite (the non-approved path currently *fails* the automation) is a named follow-up.

## Verification
- **End-to-end, real-DB** (`multitable-automation-start-approval.test.ts`): seed a record → automation
  `start_approval` with `resultWriteback` → approve via `ApprovalProductService.dispatchAction` →
  resume → assert the **source record now carries** `approval_status='approved'`,
  `approved_by=<approver>`, `approved_at=<timestamp>`. Green locally against Postgres.
- **Validation unit** (`automation-v1.test.ts`): a valid mapping is accepted; an empty mapping and a
  non-string field target are rejected at rule-save (values-constrained — no object/expression).
- **No regression:** full start-approval integration suite **12/12** (incl. W7-1a); backend **tsc clean**.

## W7-1a — semantic parity (shipped follow-up to the core write)
The core write (above) landed the DB write, but a code-semantics review surfaced two gaps the core
silently left — both now closed:
- **Tail-action visibility (recordData merge):** the backwrite ran *after* the resume snapshotted
  `recordData`, so tail actions (send_webhook / update_record / …) read the *pre-approval* record. Fix:
  `writeApprovalResultBack` returns the patch and the resume merges it into `recordData` before
  building the tail context — so "审批通过 → 写回状态 → 据此发通知/继续自动化" sees the just-written status.
- **Realtime / chaining parity:** the bare write emitted no `multitable.record.updated` + no realtime
  fan-out (unlike `update_record`). Fix: the backwrite now emits the event +
  `publishMultitableSheetRealtime`, **depth-guarded** (`_automationDepth + 1`) so a backwrite-driven
  record.updated cascade can't run away.
- **Verification:** a W7-1a integration test asserts a tail `send_webhook`'s `recordData` carries the
  backwrite AND that `multitable.record.updated` fired with the change — start-approval suite 12/12.

## Named follow-ups (gated, not silently skipped)
- **Rejection backwrite** — write `status='rejected'` on the non-approved path. That path currently
  fails the automation by design (fingerprint + bridge governance); resume-and-write on rejection is a
  real behavior change with its own governance implications.
- **Cross-base backwrite** — write to a different base's record (today: the same-base source record).
  Would route through the existing `evaluateCrossBaseWrite` gate, like `update_record`.
- **Field-exists validation** against the target sheet schema (today the write is schemaless `jsonb`
  merge, so any field id is accepted — consistent with `update_record`).
