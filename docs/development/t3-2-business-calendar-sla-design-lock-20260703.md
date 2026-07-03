# T3-2 — Business/work-day calendar wired to approval SLA · DESIGN-LOCK (PROPOSED) · 2026-07-03

> **Status: PROPOSED design-lock — awaiting the T3-2 votes** in
> `approval-automation-third-batch-ballot-20260702.md` (Q1–Q10). Turns the ballot into an implementable
> architecture. **No runtime until voted GO.** Depends on T1-1 node-SLA (shipped) and reuses the attendance
> **effective-calendar** substrate through a port — approval never reads `attendance_*` directly (respects the
> attendance↔approval domain boundary).

## 1. Boundary — a port, not a table read (Q1)

Add a **`WorkdayCalendarPort`** interface in `core-backend` (a hexagonal port). The **attendance plugin
registers a provider** (adapter) that wraps `resolveEffectiveCalendar`. Approval SLA depends only on the port;
it **never queries `attendance_*` tables** and has no compile-time dependency on the attendance plugin.

```ts
interface WorkdayCalendarPort {
  // Resolve the working-time context for an org, as of a snapshot instant (Q3).
  resolve(orgId: string, asOf: Date): Promise<WorkdayCalendar | null> // null → provider has no calendar for org
}
interface WorkdayCalendar {
  timezone: string
  isWorkingDay(dayIso: string): boolean          // day mask / holidays
  nonCountingWindows: RecurringWindow[]           // recurring intra-day windows / day masks (Q6, v1)
}
```
When the attendance plugin is absent or unregistered, no provider is bound → the SLA path **fails open**
(§4).

## 2. Org mapping (Q2)

At instance start, resolve `sla_calendar_org_id` from the requester/org snapshot and **persist it on
`approval_metrics`**. Fall back to the literal `default` org only when no explicit org mapping exists. A
foreign/unauthorized org is guarded (the provider decides; approval passes the resolved org, never raw
attendance ids).

## 3. Deadline computation (Q3, Q5, Q6, Q10)

At node activation (extends T1-1 `recordNodeActivation`'s deadline stamp): if the node's SLA is
**calendar-typed** (opt-in — §5), compute `sla_due_at` by walking forward from `activatedAt`, counting **only
minutes on a working day AND outside every non-counting window**, in the provider's **timezone** (Q5: provider
tz → `APP_TIMEZONE` → UTC; persist the resolved tz on metrics for audit). **Snapshot at start (Q3)** — the
calendar is resolved `asOf` the activation instant, so later holiday/calendar edits never move an already-armed
deadline. Cap the forward search at **366 days (Q10)**; if no deadline is found, clamp to the cap and log.

## 4. Fail-open (Q4)

Provider absent, provider throws, or org unresolved → **fall back to natural elapsed arithmetic** (today's UTC
wall-clock `sla_hours` computation), **log**, and **never** block approval creation or silently disable SLA
tracking. The SLA still arms on the elapsed-time deadline; only the business-calendar refinement is skipped.

## 5. Schema + opt-in + backward compatibility (Q7, Q8)

- **Migration:** add nullable `sla_calendar_org_id`, `sla_timezone`, `sla_due_at` (+ an SLA-unit discriminator)
  columns on `approval_metrics`, and a **new partial index** on `sla_due_at` for the calendar scan. **Keep the
  legacy `sla_hours` branch + its scan index** — do NOT drop the current index until cutover is proven (build
  contract). No backfill for historical rows (Q7).
- **Opt-in (Q8):** a template carrying only `sla_hours` stays **byte-identical** to today's UTC wall-clock SLA.
  Calendar logic activates only when a node/template explicitly declares a calendar-typed SLA. Absent →
  unchanged.

## 6. Breach / scan (Q9)

The node-timeout / SLA scanner rebases overdue detection on the actual `sla_due_at` (calendar path) or
`sla_hours` elapsed (legacy path). Business-time-formatted breach strings ("2 business days overdue") are a
**follow-up**, not this rung.

## 7. Verification plan (fail-first, build contract)

- **Real-path fail-first:** assert the deadline through the **real approval start + `recordNodeActivation`
  metrics SQL path** (a registered fake `WorkdayCalendarPort` provider), NOT a hand-built deadline. A
  calendar that makes a weekend non-working pushes `sla_due_at` past the naive elapsed instant. RED-before:
  no port → the naive elapsed deadline.
- **Provider absence / error → fail-open:** unregistered or throwing provider → the elapsed-arithmetic
  deadline arms; approval creation succeeds; a log is emitted; SLA is not silently disabled.
- **Foreign-org guarding:** an org the provider rejects → guarded (no cross-org calendar leak).
- **Legacy `sla_hours` fallback:** a template with only `sla_hours` → byte-identical UTC wall-clock deadline;
  the legacy scan index still serves it (assert the fallback predicate uses an index).
- **Snapshot:** a calendar edit after activation does not move an armed `sla_due_at`.
- **366-day cap:** an all-non-working calendar clamps + logs.

## 8. Open owner decisions

Q1–Q10 in the ballot. Load-bearing: **Q1** (the port boundary — approval must not read `attendance_*`), **Q4**
(fail-open, never block), **Q8** (calendar is explicit opt-in; legacy byte-identical). Recommend adopting the
proposed defaults.

## 9. Status / next step

PROPOSED. On the T3-2 votes → implement in **Lane D** (a `WorkdayCalendarPort` in core-backend + the
attendance-plugin provider registration + the calendar deadline computation extending T1-1 + a migration),
fail-first + real-DB per §7, PR-for-review. Reusing the attendance effective-calendar substrate through the
port drops this from a from-scratch L toward an M.
