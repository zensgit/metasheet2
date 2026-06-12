# Attendance Shift-Swap Design Lock

Date: 2026-06-12
Status: design lock only; no runtime, migration, route, API, UI, scheduler, or
staging change in this slice.

## 0. Why This Now

The H2/H2+/A2 scheduling core is closed, C5 real DingTalk delivery is waiting on
external staging configuration, and the `小组织挂部门` line is built through SO2
with SO3 waiting on staging credentials. The next independent OPTIONAL gap is
`换班`.

DingTalk's advanced scheduling benchmark describes dispatch and shift-swap as
OA-approved changes that can re-plan staff schedules after approval. MetaSheet
currently has the ingredients needed to do a narrow v1 safely:

- approval requests and approval flows;
- direct shift assignments with publish/draft lifecycle;
- `slot_index` for multi-shift days;
- `shiftEditPolicy`;
- `shiftCompliance` blocking caps;
- conflict detection through `findAttendanceScheduleAssignmentConflict`;
- temporary-shift overlay and fixed/auto producer provenance.

It does **not** have a first-class swap request object. This document locks the
smallest safe shift-swap line before any DDL or runtime work starts.

## 1. Current Grounding

| Existing asset | Current state | Design consequence |
| --- | --- | --- |
| `attendance_requests` | Single-user, single-work-date approval envelope; current request types are leave/overtime/corrections/outdoor punch. | Reuse it as the approval/status envelope, but do not hide swap details only in generic metadata. |
| Approval finalization | `resolveRequest` locks a request row and runs final-approval side effects inside the transaction. | Shift-swap writes must hook the same final-approval transaction and rollback the approval if schedule writes fail. |
| Assignment writers | Manual, draft publish, fixed apply/rebuild, auto-shift, temporary-shift publish all rely on guards around conflicts, edit windows, caps, publication, and provenance. | Swap approval must reuse the guarded assignment write path, not insert/update rows through a side door. |
| `slot_index` | Multi-shift days support slots `0..2` and per-slot conflict semantics. | Every swap target must name the exact assignment/slot; v1 never guesses "the user's shift for that day." |
| Temporary shifts | Temporary replacement rows intentionally overlay base rows and have their own cancel semantics. | V1 shift swap must reject temporary rows and rows currently covered by a temporary replacement. |
| Published rows | Published assignments can be locked; draft/pending rows are not effective. | V1 swaps only effective published assignments and never swaps draft/pending rows. `locked_at` is not a rejection by itself; approval finalization is the explicit post-publication mutation path. |
| Scheduler scopes | Scoped actors can dispatch within schedule-group/department/user boundaries. | Creation and admin review must use existing scope semantics; the system finalizer still writes only after approval. |

## 2. Owner Decisions Locked By This Document

1. **V1 means paired shift exchange, not the full dispatch domain.**
   `永久调度`, day-level support, hourly support, cross-group labor allocation,
   and dispatch reports remain separate designs.
2. **V1 supports a two-person, single-day assignment-to-assignment swap.** Each
   side gives one existing direct published assignment whose normalized
   `start_date` equals `end_date`, and receives the other side's shift
   assignment for that one work date/slot. The two assignments may be on the
   same work date or two different work dates. Open-ended or multi-day source
   assignments, more than two participants, partial-hour support, and many-row
   batch swaps are out of scope.
3. **V1 source assignments are direct, regular, manually-managed rows.** Reject
   rotation rows, fixed-schedule managed rows, auto-shift rows, temporary rows,
   draft/pending rows, inactive rows, and rows already covered by a temporary
   replacement. A published row with `locked_at` may be swapped only through the
   final approval writer locked below; ordinary edit/delete routes must remain
   locked. Later support for generated rows needs a separate provenance policy.
4. **Use `attendance_requests` as the approval envelope plus a structured swap
   detail table.** A metadata-only implementation is not acceptable because the
   swap needs counterparty consent, assignment snapshots, replacement IDs,
   idempotency, and searchable audit facts.
5. **Counterparty consent is separate from manager approval.** For a
   two-person swap, the counterparty must accept before final approval can write
   schedule rows. Admin override may be a later explicit policy; v1 should not
   silently bypass consent.
6. **Approval writes are atomic and guarded.** Final approval must lock the
   request, lock both source assignments, verify snapshots, perform the
   replacement, run edit-window/conflict/compliance guards in the same
   transaction, and only then mark the request approved.
7. **Events and records are not rewritten.** Shift-swap changes future effective
   schedules. It must not mutate historical `attendance_events` or
   `attendance_records`.
8. **No auto-reversal in v1.** Pending requests can be cancelled/rejected. After
   approval, reversal is a separate swap/correction workflow, not an automatic
   rollback button.

## 3. Data Model

SW1 should add a structured table such as `attendance_shift_swap_requests`
keyed by the parent `attendance_requests.id`:

- `request_id uuid primary key references attendance_requests(id)`;
- `org_id`;
- `requester_user_id`;
- `counterparty_user_id`;
- `counterparty_status text` (`pending`, `accepted`, `rejected`);
- `requester_assignment_id`;
- `counterparty_assignment_id`;
- `requester_work_date`;
- `counterparty_work_date`;
- source snapshots for both assignments:
  - `user_id`;
  - `shift_id`;
  - `slot_index`;
  - `start_date`;
  - `end_date`;
  - `publish_status`;
  - `producer_type`;
  - `assignment_kind`;
- replacement assignment ids, nullable until approval;
- `source_key text not null` with a unique `(org_id, source_key)` backstop;
- timestamps for consent and finalization.

The parent `attendance_requests` row should use a reserved request type, for
example `shift_swap`, with:

- `user_id = requester_user_id`;
- `work_date = least(requester_work_date, counterparty_work_date)` or the
  requester's source work date for compatibility;
- status owned by the approval lifecycle;
- metadata limited to display/audit hints, not the source of truth.

If the existing request-type migration path is reused, generic
`POST /api/attendance/requests` must not be allowed to fabricate a swap request.
Like `outdoor_punch`, shift swap needs a dedicated create route with
swap-specific validation. Current runtime uses `REQUEST_TYPES` both as the
allowlist and as the generic request-create validator, then hard-blocks
`outdoor_punch` after allowlist validation. SW1 must add the same explicit
generic-route rejection for `shift_swap`, and tests must cover both generic
create and generic update.

## 4. Product Semantics

### 4.1 Supported V1 Swap

Example:

- User A has a published manual assignment for Shift X on date D1/slot S1.
- User B has a published manual assignment for Shift Y on date D2/slot S2.
- A requests to exchange those two assignments.
- B accepts.
- The approval flow approves.
- The system deactivates the two source rows and creates two replacement rows:
  - A receives B's shift/date/slot;
  - B receives A's shift/date/slot.

The replacement rows are effective only after approval. Before approval, the
effective calendar remains unchanged.

### 4.2 Unsupported V1 Cases

Reject with stable errors:

- source row is draft, pending, inactive, or not found;
- source row is open-ended or spans more than one work date;
- source row is rotation-based;
- source row is a temporary assignment;
- source row is already replaced by a temporary overlay;
- source row is managed by fixed-schedule apply/rebuild;
- source row is produced by auto-shift;
- requester or counterparty is outside the actor's scheduler-scope;
- counterparty has not accepted;
- either date is outside `shiftEditPolicy`;
- resulting assignment conflicts with any third row;
- resulting planned load violates `shiftCompliance`;
- source snapshots no longer match when final approval runs.

`locked_at` alone is not an unsupported case. A locked published manual row may
be changed only by the approved swap finalizer, never by ordinary assignment
edit/delete routes.

### 4.3 Publication And Provenance

Replacement rows should be published immediately as part of final approval. They
must carry deterministic provenance:

- `producer_type = 'shift_swap'`;
- `producer_ref_id = request_id`;
- `producer_key = 'shift_swap:' || request_id || ':' || target_user_id || ':' ||
  work_date || ':' || slot_index`;
- `producer_run_id = request_id` or a generated finalization id.

The detail table must record both original assignment ids and both replacement
assignment ids. That table is the audit bridge for why the old rows were
deactivated and which rows replaced them.

## 5. Final-Approval Transaction

The approval hook must run before the parent request is marked `approved`.

Required shape:

1. Lock the parent request row `FOR UPDATE`; reject if status is not `pending`.
2. Load and lock the swap detail row.
3. Reject unless `counterparty_status='accepted'`.
4. Lock both source assignments in deterministic order.
5. Verify each source row still matches its stored snapshot and is still active.
6. Evaluate `shiftEditPolicy` for both source dates and both target dates.
7. Soft-deactivate the two source rows inside the transaction.
8. Insert the two replacement rows with deterministic `producer_key`.
9. Run conflict detection and `shiftCompliance` projection for both affected
   users/date ranges after the replacement rows are visible to the transaction.
10. Write replacement ids back to the swap detail table.
11. Mark the parent request approved.

If any guard fails, the transaction rolls back and the request remains pending.
There must be no "approval succeeds but schedule write fails later" state.

## 6. Permission And Scope

Creation:

- requester may create a swap for their own assignment if the employee
  self-service route is enabled;
- admin/scheduler actors may create on behalf of a user only within their
  scheduler-scope;
- both source assignments must belong to the same org.

Counterparty consent:

- only the counterparty user or a future explicit admin override can accept or
  reject the counterparty step;
- consent must be stored separately from approval status.

Approval:

- use the existing approval-flow permissions for final manager/admin approval;
- do not rely on requester scope during finalization;
- finalization still validates that both proposed rows are inside allowed org
  boundaries and that the source rows were not moved.

## 7. UI Surface

The first UI should be employee/admin operational, not a dense scheduling grid:

- "Shift swap requests" tab under the attendance scheduling area;
- create form:
  - requester assignment picker;
  - counterparty user;
  - counterparty assignment picker;
  - reason;
  - optional attachment/comment hook if the approval request surface already
    supports it;
- request detail:
  - before/after table for both users;
  - counterparty consent state;
  - approval state;
  - final replacement assignment ids after approval.

Copy must be precise:

- say "exchange two published manual assignments";
- do not promise hourly support, permanent dispatch, generated-row support,
  payroll allocation, or automatic reversal.

## 8. Implementation Slices

| Slice | Scope | Completion bar |
| --- | --- | --- |
| SW0 design lock | This document + tracker backfill | Docs-only PR; no runtime |
| SW1 schema/envelope | `shift_swap` request type, structured detail table, source-key uniqueness, read mapping; generic `/requests` cannot fabricate swap | Migration replay + real-DB route tests for create rejection/structured create |
| SW2 create/consent API | Dedicated create/cancel/read routes and counterparty accept/reject route; no schedule writes | Real-DB tests for scope, snapshot, consent, stale source rows |
| SW3 final approval writer | `resolveRequest` final-approval hook writes replacements through the guarded transaction | Real-DB approval tests for success, conflict rollback, cap rollback, edit-window rollback, idempotency |
| SW4 admin/employee UI | Request list/detail/create/consent UI with exact request bodies | Web tests; no silent picker truncation |
| SW5 staging closeout | Deploy, create and approve a two-user swap, verify effective-calendar, provenance, events unchanged, cleanup | PASS stamp + residue=0 before tracker can flip ✅ |

SW3 must not start before SW1/SW2 because approval finalization needs structured
snapshots and counterparty consent. SW4 can start after SW2, but it must not hide
the fact that final approval is unavailable until SW3.

## 9. Required Tests

Backend:

- generic `/requests` cannot create or update `shift_swap`;
- dedicated create route rejects missing/invalid assignment ids;
- source assignment must be active, published, regular, manual, same org, and
  single-day (`start_date=end_date`);
- locked published manual rows are swappable only through final approval, while
  ordinary edit/delete remains locked;
- fixed/auto/temporary/rotation/draft/pending/open-ended/multi-day rows are
  rejected;
- counterparty acceptance is required before final approval;
- final approval deactivates exactly the two source rows and creates exactly two
  replacement rows;
- replacement rows have deterministic `producer_type/ref_id/key/run_id`;
- repeat approval or worker retry does not create duplicate replacements;
- conflict on either target user/date rolls back the approval and leaves source
  rows active;
- `shiftCompliance` cap failure rolls back the approval and leaves source rows
  active;
- `shiftEditPolicy` failure rolls back the approval and leaves source rows
  active;
- events and records are unchanged.

Frontend:

- assignment pickers preserve already selected rows even when pagination/search
  does not return them;
- create sends exact structured ids, not display labels;
- counterparty accept/reject sends only the consent action and request id;
- final approved detail shows replacement ids and before/after rows;
- unsupported generated rows display disabled copy and cannot be selected.

Staging:

- seed two users and two published manual direct assignments;
- create swap request through the dedicated route;
- accept as the counterparty;
- approve through the real approval route;
- assert both effective-calendar days reflect the exchanged assignments;
- assert source rows inactive, replacement rows active with provenance;
- assert `attendance_events` and `attendance_records` for the users are
  unchanged;
- cleanup all seeded rows and assert residue=0.

## 10. Explicitly Out Of Scope

- Permanent dispatch / staff transfer.
- Day-level or hourly support across groups.
- Dispatch labor-cost allocation or dispatch reports.
- Generated-row swaps for fixed-schedule, auto-shift, or rotation assignments.
- Multi-party swaps.
- Automatic reversal after approval.
- Payroll-grade recalculation.
- DingTalk hardware/device-department binding.
- Mobile-native push; C5 notification delivery remains separate.

## 11. Tracker Status

After this document lands, `换班` moves from `⬜ 0` to `🟡 design-locked`.
It can only become ✅ after SW1-SW5 are merged and staging-proven. `调度`
remains `⬜ 0`, and `小组织挂部门` keeps its own SO3 staging gate.
