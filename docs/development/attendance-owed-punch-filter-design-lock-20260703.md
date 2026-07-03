# Owed-punch anomaly filter design-lock (RATIFIED)

> Status: **RATIFIED** on 2026-07-03 after owner review. This is a
> post-H2 humanization design lock only.
> It does not authorize runtime, staging, production enablement, or closing any
> staging umbrella.
>
> Grounding baseline: `origin/main@ffa05d987` on 2026-07-03.

## 0. Goal

Give attendance admins a first-class **Owed punch only** view inside the existing
anomalies table, so the operator can focus on employees who genuinely owe a
check-in / check-out action instead of scanning all abnormal rows.

The runtime must reuse the same owed-punch semantics as the shipped manual
missed-punch reminder line. This slice is a read/filter UX refinement over
existing attendance facts; it must not enqueue notifications, create requests,
edit records, or perform batch corrections.

## 1. Grounded current state

The current main branch has two related but separate surfaces:

1. **Raw anomaly list.** `GET /api/attendance/anomalies` is a user-scoped read
   route. It excludes `normal`, `off`, and `adjusted`, requires workdays, and
   returns rows with `workdayContext`, `leaveMinutes`, `overtimeMinutes`,
   request summary, and `suggestedRequestType`. The frontend `loadAnomalies()`
   calls this route and the overview table renders the `anomalies` array
   directly. There is no dedicated owed-punch filter control on this table.
2. **Manual missed-punch reminder candidates.**
   `GET /api/attendance/manual-missed-punch-reminders/candidates` is an
   org/date candidate-pool route for the reminder workflow. It uses a
   records-backed owed-punch predicate: workday attendance records whose status
   is `partial` with a missing side or `absent`, then filters scoped actors
   before pagination and annotates pending requests / default selection.

The second surface proves the candidate semantics already exist. The missing
piece is making that semantic available as a normal read/filter affordance in
the primary anomalies table.

## 2. v1 Contract

### 2.1 Authoritative classifier, not template heuristics

The runtime PR must introduce a single owed-punch classifier used by both:

- `/api/attendance/anomalies` when `filter=owed_punch`; and
- the manual missed-punch reminder candidate route.

The frontend must not infer owed-punch status by hand from display labels or
localized copy. A row is included only if the backend classifier marks it
owed-punch under the same facts that the reminder route would accept.

The classifier output should be explicit enough for the UI and tests:

```ts
{
  owedPunch: boolean
  missingSide: 'check_in' | 'check_out' | 'both' | null
  owedPunchReason?: string
}
```

`owedPunchReason` is diagnostic copy / test evidence; it is not a new policy
surface and must not be used for authorization.

### 2.2 Predicate

v1 is records-backed and deliberately does not scan for users with no
attendance record row. A row is owed-punch only when all of these hold:

- org/date/user match the requested read;
- `COALESCE(is_workday, true) = true`;
- the status is one of:
  - `partial` and at least one punch side is missing; or
  - `absent` for a workday record;
- the row is not already `normal`, `off`, or `adjusted`;
- pending requests do not hide the row, but the UI must preserve the existing
  pending-request chip so the admin can avoid acting on someone who already
  filed a fix.

If runtime grounding proves full-day leave / business-trip / out-of-office rows
can still surface as `absent` instead of being materialized as `adjusted` /
`off`, the same PR must extend the classifier from existing approved-request or
record-meta facts. It must not paper over that case with a frontend-only
exception.

### 2.3 Route shape

Extend the existing anomaly read route with an enum-strict optional filter:

```text
GET /api/attendance/anomalies?filter=owed_punch
```

Allowed values:

- omitted / `all`: current behavior, byte-for-byte compatible except for the
  additive classifier fields on returned rows;
- `owed_punch`: return only owed-punch rows.

Pagination and `total` must be computed after the filter is applied. A client
side filter over the current page is not sufficient, because it would create
under-filled pages and false totals.

Authority remains exactly the existing anomalies read authority:

- requester can read self;
- reading another user still requires the existing `canAccessOtherUsers`
  branch;
- this route does not grant scheduler-scope `remind` authority and cannot
  enqueue notifications.

### 2.4 Frontend UX

Add a compact segmented / chip control in the anomalies card:

- **All anomalies** (default): current list.
- **Owed punch only**: reloads anomalies with `filter=owed_punch`.

Required interaction behavior:

- switching filters clears stale rows/loading state before the fetch resolves;
- the reload status includes both the active filter and the row count;
- edit-result actions remain available/disabled by the existing
  `attendanceResultEditDisabledReason()` path, not by the filter;
- create-request prefill still goes through the existing request form and
  `POST /api/attendance/requests` path;
- no notification enqueue happens from this filter. Reminders stay in the
  manual reminder panel.

The filter is useful even before a future batch action because it narrows the
operator's view without changing the write surface.

## 3. Boundaries

This design lock explicitly does not authorize:

- any C5 notification producer or reminder send;
- any batch correction runtime from the batch-anomaly design;
- any new cross-employee anomaly pool beyond the existing route authority;
- synthetic no-record scans;
- settings writes, migrations, staging smoke, or production enablement;
- closing the attendance staging umbrella.

Relationship to adjacent lines:

- Manual missed-punch reminders remain the write-to-outbox operation. This
  filter reuses their candidate semantics but does not replace the reminder UI.
- Batch anomaly processing remains a separate design. If it later needs an
  owed-punch subset, it should consume the same classifier rather than
  duplicating the predicate.
- MP request UX remains separate. This filter may make it easier to choose a
  row before creating a request, but it never bypasses makeup-punch policy.

## 4. Implementation Slices

| Slice | Scope | Notes |
|---|---|---|
| OF-0 | This design lock | docs-only, ratified before runtime |
| OF-1 | Backend classifier + anomaly route filter | shared classifier, `filter=owed_punch`, route tests, HMR parity test |
| OF-2 | Frontend anomaly card control | segmented/chip control, stale-clear, web-guard coverage |
| OF-3 | Optional closeout note | update humanization ledger only after OF-1/2 land |

OF-1 and OF-2 may land in one small runtime PR if the diff stays narrow. If the
backend route filter touches pagination or authority in a risky way, split them.

## 5. Verification Plan

Backend / route:

- default `/api/attendance/anomalies` behavior remains compatible: omitted
  filter returns the same row set plus additive classifier fields;
- invalid filter value returns 400 and does not fall back to all rows;
- `filter=owed_punch` includes:
  - `partial` with missing check-in;
  - `partial` with missing check-out;
  - `partial` with both sides missing if that record shape is present;
  - `absent` workday rows;
- `filter=owed_punch` excludes:
  - `late`, `early_leave`, and `late_early` rows with both punch sides present;
  - `normal`, `off`, and `adjusted`;
  - non-workday rows;
  - any full-day leave / business-trip / out-of-office row if runtime grounding
    proves it can otherwise appear as an `absent` row;
- pagination total is computed after filtering;
- cross-user read authority is unchanged;
- HMR parity: for the same org/user/date and an admin actor, the owed-punch
  record ids from the anomaly route match the manual missed-punch reminder
  candidate route, modulo the reminder route's extra scheduler-scope and
  pending-selection annotations.

Frontend:

- default tab renders all anomaly rows and does not pass `filter=owed_punch`;
- owed-punch tab passes `filter=owed_punch` and renders only returned rows;
- switching filters clears stale rows before the new response paints;
- pending request chips remain visible on owed-punch rows;
- create-request and edit-result actions keep their existing behavior;
- no call is made to `/api/attendance/manual-missed-punch-reminders/enqueue` or
  any notification-delivery write route when toggling the filter;
- the relevant spec is wired into the attendance web guard and cannot be a
  skip-shaped green.

Docs / process:

- keep runtime changes in a separate PR after this RATIFIED design lock;
- runtime PR body must avoid bare closing keywords for any umbrella issue that
  outlives the PR.

## 6. Owner Decisions

Ratified defaults:

1. **Route filter instead of client-only filtering.** This keeps totals and
   pagination honest.
2. **Shared backend classifier.** HMR candidate route and anomalies filter must
   converge on one predicate.
3. **Records-backed v1.** No synthetic missing-record scan until a separate
   read-surface design names the population and authorization model.
4. **Pending requests remain visible.** They are not selected/sent by default in
   the reminder flow, but the read filter should still show the row with the
   pending chip so admins understand why they may not need to act.

If ratified, OF-1/2 runtime can be built as the next small read/UI slice while
the staging window remains independently operator-gated.
