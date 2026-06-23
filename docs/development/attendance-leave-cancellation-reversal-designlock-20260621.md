# Design-lock (PROPOSED): Attendance leave cancellation + balance reversal (销假)

> **Status**: PROPOSED next-arc candidate (non-Codex lane #7 from the v3 benchmark). Owner picks #7 vs #5
> and 拍板s the reversal semantics (§3) before build. Codex's lane is makeup-punch / mobile-self-service —
> this does not overlap it. MetaSheet's own 口径; no competitor names.
> **Scope**: complete the leave lifecycle — when an **approved** leave is cancelled, **reverse the
> balance that was deducted**, instead of leaving the employee silently short. This is the reserved
> re-entry point the annual-leave engine deferred ("撤销首版不自动反冲但不静默错账").
> **Grounding**: `origin/main`. Reuses the shipped leave-balance ledger: `attendance_leave_balances`
> (FIFO lots: `remaining_minutes`, `status`, `expires_at`) + `attendance_leave_balance_events`
> (`event_type`, signed `delta_minutes`, `source_type`, `source_id`) + `deductLeaveBalance(trx, …)`
> (the deduct path, `index.cjs`). The ledger is the #1 annual-leave family's surface — **coordinate the
> touch with that lane** (or sequence behind it).

---

## 1. The decision — what cancellation v1 is

A leave that was approved and deducted can be cancelled (employee withdraws, or admin cancels). v1
makes cancellation **balance-correct**: the deducted minutes are returned to the **same lots** they came
from, via a **reverse event**, so the ledger stays auditable and the employee is made whole. No new
grant logic, no new lot — a signed inverse of the original deduction, keyed to the original leave.

| Sub-approach | Behavior | Cost | v1? |
|---|---|---|---|
| **Auto-reverse (chosen)** | cancel an approved leave → a `reverse` event restores the deducted lots, idempotently, keyed to the leave's `source_id` | small — inverts `deductLeaveBalance` over the same lots | **yes** |
| Manual-only (the #1 v1 fallback) | cancellation records nothing to the ledger; an admin manually adjusts | — | superseded by this lock |
| Partial cancellation | reverse only part of a multi-day leave | larger (proration) | **out** (full-cancel only v1) |

## 2. Contract

- **Trigger**: a cancellation action on an **approved** leave request (the request transitions
  `approved → cancelled`). The exact request/approval wiring is build-time and **coordinated with the
  #1 annual-leave family** (it owns the leave-request model). Only an approved+deducted leave reverses;
  a pending (un-deducted) leave cancels with **no** ledger event.
- **Reverse event**: a new `attendance_leave_balance_events` row with `event_type='reverse'`, a
  **positive** `delta_minutes` (the previously-deducted amount), `source_type` = the leave's, and
  `source_id` = the **original leave's id** (so the reverse is traceable to, and dedup-keyed by, the
  deduction it undoes). The matching lots' `remaining_minutes` are incremented (and `status` flipped
  back to `active` if they were exhausted).
- **Lots restored = the lots originally deducted** (resolve via the original deduction's events for that
  `source_id`), in reverse FIFO, each capped at what it gave. Never restore more than was deducted; never
  exceed a lot's original `amount_minutes`.

## 3. Reversal semantics — THE owner decision (§3)

Three sub-decisions to 拍板:

| # | Question | Recommended v1 | Why |
|---|---|---|---|
| 3a | **Expired lot** — a lot that gave minutes has since `expires_at`-expired. Restore to it? | **No** — do not un-expire; the expired portion is **not restored**. **As-built durable record:** the unrecoverable amount is permanently auditable as **`Σdeduct − Σreverse` for the leave's `source_id`** over the immutable events ledger (the deduct event stays; no reverse is written for the expired portion → the gap *is* the durable record), and is also surfaced in the cancel response for immediate visibility. *(No separate "note" event: the events table has no note column, and a zero/marker event would violate the delta-sign CHECK — the deduct-minus-reverse derivation is the durable representation.)* | Un-expiring a lot would resurrect already-forfeited balance; silently dropping would mis-account. The deduct/reverse events are immutable, so the unrecoverable amount stays permanently reconstructable. |
| 3b | **Idempotency** — cancel fired twice (retry, double-click) | **dedup on `(source_id, event_type='reverse')`** — a reverse already present → no-op | the deduction is keyed by `source_id`; the reverse must be too, or a double-fire double-credits |
| 3c | **Authority** — who may cancel? | employee may withdraw **their own** approved leave; admin may cancel any (no elevation — same gate as the leave action) | mirrors the approval gate; no new capability |

If you'd rather keep the conservative "no auto-reverse" for longer, that's a redirect — but then cancellation must still **flag** the un-reversed deduction (never silently leave the employee short), which is strictly more code than just doing the reverse. Hence the recommendation to do the reverse now.

## 4. Boundaries / non-goals

- **Reverse-only** — no new grant/accrual logic; inverts an existing deduction over its own lots.
- **Full cancellation only** — partial/proration is out of v1.
- **Rides the #1 ledger** — touches `attendance_leave_balance_events` + the lot rows; **coordinate with /
  sequence behind the annual-leave family** to avoid a #2945-style collision. No change to grant/accrual/
  expiry code.
- **No payroll / no external write.**

## 5. Verification plan (real-DB)

- approve a leave (deducts lots A,B) → cancel → A,B `remaining_minutes` restored to pre-deduction; a
  `reverse` event with positive delta + the leave's `source_id` lands; status flips back to `active`.
- **idempotency**: cancel twice → exactly one `reverse` event, balance restored once.
- **expired-lot (3a)**: a lot that gave minutes expired before cancel → only the still-valid portion
  restored; the reverse event records the unrecoverable-expired amount; balance never exceeds what was
  deducted.
- **pending leave**: cancel an un-deducted (pending) leave → no ledger event.
- **authority**: a non-owner / non-admin cannot cancel someone else's leave (403, no reverse).
- regression: grant / accrual / deduct / expiry paths unchanged.

## 6. Governance

design-lock → **owner picks #7 (vs #5) + 拍板s §3 (3a/3b/3c)** → build (reverse-event + cancellation
action + tests; coordinate the ledger touch with the #1 family) → real-DB verification → staging smoke.
PROPOSED until the owner selects it. MetaSheet's own 口径; the runtime carries no competitor names.
