# 排班发布/草稿 design-lock（SHOULD / draft-pending-published）

Date: 2026-06-09
Baseline: `origin/main` @ `c74cdc6f3`
Status: design-lock only; no runtime, schema, frontend, OpenAPI, migration, scheduler, or staging change in this PR.

## 0. Why This Exists

The H2 tracker has closed the MUST items and has started SHOULD scheduling
maturity. 自动对班 A0/A1 is staging-proven, 一天多班次 is design-locked, and
the next SHOULD item is **排班发布/草稿**.

Today an assignment write is immediately effective:

- manual `POST/PUT /api/attendance/assignments` inserts or updates an active
  row and emits the existing assignment event;
- fixed-schedule apply writes active managed rows directly;
- auto-shift A1 selected apply writes active rows directly with
  `producer_type='auto_shift_match'`;
- effective-calendar and planned-minutes readers consume active assignment rows
  without a publication lifecycle.

That is workable for a simple editor, but not for a mature scheduling workflow:
admins need to stage a future roster, review conflicts and compliance, then
publish a locked schedule fact that downstream attendance, reminders, reports,
and payroll-adjacent logic can trust.

## 1. Current Grounding

| Area | Current state | Design consequence |
| --- | --- | --- |
| Assignment schema | `attendance_shift_assignments` contains identity/window/activity and producer metadata, but no lifecycle status. Existing rows have no draft/publish distinction. | Migration must default legacy rows to published/effective. No backfill inference beyond that default. |
| Mapping | `mapAssignmentRow` exposes assignment identity, active flag, and producer metadata. | Publish metadata should be mapped alongside producer metadata without changing producer identity. |
| Write locks | `acquireAttendanceScheduleAssignmentLock` takes a per-org/per-user advisory transaction lock. | Publish must lock users in the same discipline before flipping any row effective. |
| Conflict guard | `findAttendanceScheduleAssignmentConflict` rejects active overlapping direct/rotation assignments. | The guard must become status-aware: published rows conflict; draft/pending rows are non-effective and only conflict inside their own draft set. |
| Effective calendar | `loadShiftAssignment` returns one active assignment with `ORDER BY ... LIMIT 1`; range readers feed the same effective-calendar/planned-minutes chain. | Effective readers must filter to `publish_status='published'`; drafts and pending rows must be invisible. Multi-slot follow-up must then layer on published slots only. |
| Edit window | Assignment create/update/delete and rotation create/update/delete enforce `shiftEditPolicy`; auto-shift A1 also checks affected work dates before apply. | Draft save, pending transition, and publish must not create a side door around the edit window. |
| Compliance | `enforceShiftComplianceCap` runs after writes and before commit, using planned-minutes projection. Fixed apply and auto-shift A1 call it too. | Publish is the effective write moment for drafts, so compliance must run inside the publish transaction after rows become published and before commit. |
| Fixed apply | `applyAttendanceGroupFixedSchedule` writes managed rows with producer metadata and then enforces compliance. | Default fixed apply remains immediate published for zero regression; a future draft mode must preserve producer metadata and publish through the shared transition. |
| Auto shift | A1 selected apply stamps `producer_type='auto_shift_match'`, deterministic `producer_key=userId:workDate`, and `producer_run_id`. | A1 remains immediate published unless a later explicit draft mode is added; publication must not overwrite or retag auto-shift provenance. |

## 2. Product Scope

### In

- Store assignment lifecycle as `draft`, `pending`, or `published`.
- Default legacy/current assignment writes remain published/effective.
- Admin can create a draft schedule set that is not effective until published.
- Admin can freeze a draft into pending, run publish preflight, and publish it
  transactionally.
- Published rows are locked schedule facts; direct edits require an explicit
  later correction/revision path, not silent mutation.
- Effective-calendar, shift-compliance planned load, unscheduled truth,
  reminders, and reports consume only published rows.
- Publish uses the existing per-user lock, conflict guard, edit-window guard,
  compliance guard, scheduler-scope permission checks, and producer metadata.

### Out

- No approval workflow for schedule publication.
- No scheduled future publish job.
- No mobile employee acknowledgement/read receipt.
- No publish notification delivery or C5 external channel.
- No automatic rewrite of existing published rows from draft.
- No hard delete of published rows.
- No OpenAPI or frontend implementation in this PR.
- No multi-slot runtime work in this PR; this design only states how lifecycle
  status composes with the separate multi-slot design.

## 3. Status Semantics

Use API status values:

- `draft`
- `pending`
- `published`

Recommended DB column name:

- `attendance_shift_assignments.publish_status text NOT NULL DEFAULT 'published'`

Use `publish_status`, not a generic `status`, because the codebase already has
several unrelated status fields (`attendance_records.status`, approval status,
delivery status). The tracker may keep saying `status` as shorthand, but the
runtime column should be explicit.

Recommended companion columns:

- `publish_batch_id uuid null`
- `publish_requested_at timestamptz null`
- `publish_requested_by text null`
- `published_at timestamptz null`
- `published_by text null`
- `locked_at timestamptz null`
- `reopened_from_assignment_id uuid null`

Rules:

| Status | Effective? | Editable? | Counts toward compliance/reminders/reports? | Meaning |
| --- | --- | --- | --- | --- |
| `draft` | No | Yes, through draft routes only | No | Admin staging copy. Can be reviewed, changed, deleted, or abandoned. |
| `pending` | No | No, except cancel back to draft | No | Frozen candidate set after publish request/preflight. It prevents accidental edits while publish is in progress. |
| `published` | Yes | No direct mutation in v1 | Yes | Trusted schedule fact used by downstream attendance logic. |

Legacy rows:

- migration default is `published`;
- set `locked_at = COALESCE(updated_at, created_at, now())` only if the migration
  explicitly decides to backfill lock evidence; otherwise null `locked_at` on a
  published legacy row still means effective but pre-lock-era;
- producer metadata stays unchanged.

`is_active=false` remains a soft-deactivation flag. An inactive row is never
effective, regardless of `publish_status`.

## 4. Read Semantics

Every runtime reader that determines the real schedule must filter direct shift
assignments to:

```sql
COALESCE(is_active, true) = true
AND publish_status = 'published'
```

Required consumers:

- single-day assignment resolver;
- range assignment prefetch used by effective-calendar;
- planned-minutes projection used by `shiftCompliance`;
- `isUserScheduledForDate` and any unscheduled reminder/punch-policy truth;
- advanced scheduling workbench effective counts;
- report/read surfaces that claim effective schedule facts.

Admin list/read routes may include draft and pending rows, but they must expose
status explicitly and provide filters. Self-service/employee-facing schedule
reads should default to published only.

Draft and pending rows must not make a user "scheduled" for unscheduled punch
policy or unscheduled reminders.

## 5. Publish Transition

Recommended route shape for runtime slice:

```text
POST /api/attendance/schedule-publications
```

Input should identify a bounded set of draft assignment IDs or a draft batch:

```json
{
  "assignmentIds": ["..."],
  "preflightOnly": false
}
```

Transition:

1. Load all target rows for the org and require `publish_status='draft'`.
2. Validate scheduler-scope permission for every target user/date.
3. Enforce `shiftEditPolicy` for every affected `startDate` and `endDate`
   boundary. The publish route is not allowed to bypass the edit window.
4. Acquire per-user schedule assignment locks in stable sorted order.
5. Re-read target rows inside the transaction; if any row changed, return
   `409 SCHEDULE_PUBLISH_STALE_DRAFT`.
6. Mark rows `pending` with `publish_batch_id`, `publish_requested_at`, and
   `publish_requested_by`.
7. Re-run conflict detection against published direct and rotation assignments.
   Draft/pending rows outside the current batch do not count as effective
   conflicts, but overlapping pending batches for the same user/date should
   return `409 SCHEDULE_PUBLISH_PENDING_CONFLICT`.
8. Flip the batch to `published`, set `published_at`, `published_by`, and
   `locked_at`.
9. Run `enforceShiftComplianceCap` for every affected user over the touched date
   windows after the flip and before commit.
10. Commit only if every row passes conflict, edit-window, and compliance checks.

If any validation fails, the transaction rolls back and no row remains pending.
`preflightOnly=true` must run the same checks without changing row status.

V1 should not publish by updating an existing published row in place. Replacing
a published schedule fact requires a later correction/revision design that
defines supersession semantics, downstream recomputation, and audit copy.

## 6. Edit Locks And Corrections

Published rows are schedule facts, not ordinary editable drafts.

V1 lock rules:

- `draft` rows can be edited or deleted only through draft-aware routes.
- `pending` rows cannot be edited; they can only be canceled back to draft if
  the same edit-window and permission checks pass.
- `published` rows cannot be directly `PUT` mutated through the ordinary
  assignment update route.
- Published rows may be soft-deactivated only through an explicit correction
  route in a later design. That route must run `shiftEditPolicy`, acquire the
  same locks, and emit audit evidence.

The current immediate-write routes should preserve zero regression by creating
`published` rows until the draft feature is explicitly enabled. Once draft mode
exists, the UI must make the mode explicit; it must not silently switch existing
admin saves from published to draft.

## 7. Interaction With `shiftEditPolicy`

`shiftEditPolicy` remains the authoritative edit-window guard.

Required checks:

- draft create/update/delete: check affected dates, matching current assignment
  route behavior;
- pending transition: check all target dates;
- publish: check all target dates again inside the route flow;
- cancel pending back to draft: check all target dates;
- future correction/unpublish: check the published row's existing dates and the
  next affected dates.

The reason to check both draft save and publish is simple: draft save preserves
current route behavior, while publish is the moment a non-effective plan becomes
an effective schedule fact. No status transition may become a back door around
the modification window.

## 8. Interaction With `shiftCompliance`

Draft and pending rows are invisible to compliance caps. They can have a
preflight warning, but they must not block other published schedule writes.

Publish is the hard gate:

- after rows are flipped to published inside the transaction, call the existing
  `enforceShiftComplianceCap` helper for every affected user/date range;
- any `SHIFT_COMPLIANCE_CAP_EXCEEDED` rolls back the whole publish batch;
- no partial publish is allowed in v1;
- the error response should include the same granularity/cap/projected payload
  as existing assignment saves.

This preserves the completed H2 MUST contract: compliance is enforced at the
moment schedule facts become effective.

## 9. Fixed Apply Semantics

Existing fixed-schedule apply remains immediate published by default:

- current API behavior and staging evidence must not regress;
- rows keep `producer_type='attendance_group_fixed_schedule'`;
- publish columns default to published/locked for new immediate rows once the
  migration exists.

Future fixed draft mode may be added only behind an explicit parameter such as
`mode='draft'`. It must:

- use the same preview/apply classifier;
- write draft rows with the same producer metadata;
- never claim unmanaged/manual rows;
- publish through the shared transition;
- let managed rebuild/clear decide whether it targets draft, pending, published,
  or an explicit status filter.

Managed clear/rebuild must never soft-deactivate a published row just because a
draft with the same producer key exists.

## 10. Auto-Shift Provenance

Auto-shift A1 selected apply remains immediate published by default:

- it already re-runs eligibility and matching inside the transaction;
- it already checks edit window and compliance;
- it already uses `producer_type='auto_shift_match'`, deterministic
  `producer_key=userId:workDate`, and `producer_run_id`.

When publish columns exist, A1-created rows should set:

- `publish_status='published'`;
- `published_at=now()`;
- `published_by` to the actor when available;
- `locked_at=now()`.

Do not fold auto-shift suggestions into the draft/pending lifecycle by default.
A future "stage selected auto-shift suggestions as draft" mode must be a
separate opt-in and must not change the existing A1 staging-proven contract.

## 11. Multi-Slot Composition

The separate 一天多班次 design introduces `slot_index`. Publication composes as:

- only published slots are effective;
- draft/pending slots may overlap published slots while being edited, but publish
  rejects any conflict against the published effective set;
- conflict semantics at publish time are the multi-slot semantics when
  `slot_index` exists: same slot overlap rejects; different slot requires
  non-overlapping shift windows; rotation remains exclusive in v1;
- if `publish_status`, `slot_index`, and `locked_at` are all ready near the same
  time, batch the hot-table migration instead of adding one ALTER per slice.

Until multi-slot runtime lands, publish should preserve the current single
effective assignment rule.

## 12. Error Contract

Recommended errors:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `SCHEDULE_PUBLISH_STALE_DRAFT` | 409 | Draft changed between preflight/read and transaction publish. |
| `SCHEDULE_PUBLISH_PENDING_CONFLICT` | 409 | Another pending batch overlaps this user/date. |
| `SCHEDULE_PUBLISH_CONFLICT` | 409 | Would conflict with an existing published shift/rotation assignment. |
| `SCHEDULE_PUBLISH_ALREADY_PUBLISHED` | 409 | Target row is already published. |
| `SCHEDULE_PUBLISH_LOCKED` | 422 | Caller attempted to mutate pending/published rows through draft routes. |
| `SHIFT_EDIT_WINDOW_EXCEEDED` | 422 | Existing edit-window guard blocked the target date. |
| `SHIFT_COMPLIANCE_CAP_EXCEEDED` | 422 | Existing compliance guard blocked the projected published load. |

Do not map publication validation failures to 500.

## 13. Test Matrix

Required before this SHOULD item can move to ✅:

1. migration replay: legacy rows default to published and effective;
2. source guard: effective-calendar and planned-minutes readers filter to
   published rows;
3. draft assignment is visible in admin draft list but invisible to
   effective-calendar;
4. draft row does not satisfy `isUserScheduledForDate`;
5. pending row is frozen and cannot be edited through ordinary assignment PUT;
6. publish preflight returns the same conflict/compliance result as publish
   without changing status;
7. publish flips all target rows from draft to published in one transaction;
8. publish conflict against existing published shift row rolls back all rows;
9. publish conflict against active rotation row rolls back all rows;
10. publish over cap returns `SHIFT_COMPLIANCE_CAP_EXCEEDED` and leaves rows
    non-published;
11. publish outside `shiftEditPolicy` window returns
    `SHIFT_EDIT_WINDOW_EXCEEDED`;
12. fixed-schedule apply default path still writes immediate published managed
    rows with existing producer metadata;
13. fixed-schedule draft mode, if implemented, writes draft managed rows and
    publishes through the shared transition;
14. auto-shift A1 default path still writes exactly one immediate published row
    with `producer_type='auto_shift_match'` and does not overwrite manual/import/
    fixed/rotation rows;
15. multi-slot compatibility test, once `slot_index` exists: only published
    slots count, and publish uses slot-aware conflicts;
16. frontend/admin test: existing save path remains immediate published unless
    the operator explicitly chooses draft mode;
17. audit/event test: publish emits bounded evidence with batch id and affected
    assignment ids; draft saves do not emit misleading "published" events;
18. negative source grep: no OpenAPI/generated SDK drift without the matching
    runtime slice.

## 14. Staging Smoke

Required staging smoke before ✅:

1. deploy runtime with publication feature flag/default settings off and confirm
   ordinary assignment create remains immediate published/effective;
2. enable draft mode for a synthetic org/admin;
3. create synthetic user, shift, and draft assignment for a future date;
4. assert effective-calendar and unscheduled truth still treat the day as
   unscheduled while draft/pending;
5. run preflight and assert no status mutation;
6. publish the draft and assert effective-calendar now returns the shift;
7. set a low `shiftCompliance` cap and prove a second draft publish rolls back
   with no published residue;
8. set a restrictive `shiftEditPolicy` and prove publish is blocked;
9. run fixed-apply and auto-shift A1 smoke paths enough to prove their default
   immediate-published behavior still works;
10. cleanup users/events/records/assignments/groups/shifts and assert residue 0.

## 15. Slice Plan

| Slice | Scope | Status |
| --- | --- | --- |
| D0 | This design-lock + tracker backfill | ✅ this PR |
| P0 | Migration batch decision with multi-slot `slot_index` / `publish_status` / `locked_at`; mapper/read filters latent, legacy published default | 🔒 |
| P1 | Draft CRUD + admin list filters, default existing routes still immediate published | 🔒 |
| P2 | Publish preflight + transactional pending->published transition with locks, conflict, edit-window, compliance | 🔒 |
| P3 | Fixed-apply / auto-shift compatibility tests and optional fixed draft mode decision | 🔒 |
| P4 | Admin UI publish flow + staging smoke | 🔒 |

## 16. Acceptance For This Design

This design is complete when it:

- chooses explicit `publish_status` semantics for draft/pending/published;
- keeps legacy/current writes published by default;
- makes draft and pending rows non-effective for all runtime schedule truth;
- defines the publish transaction and lock/guard order;
- preserves `shiftEditPolicy` and `shiftCompliance` as hard gates;
- keeps fixed-apply and auto-shift A1 provenance intact;
- records how publication composes with the separate multi-slot design;
- names the test matrix and staging smoke needed before ✅;
- changes only docs and tracker text.

## 17. Open Decisions For Runtime PRs

- Whether v1 needs a scheduled future publish job. This design says no.
- Whether v1 needs a published-row correction/supersession route. This design
  blocks direct mutation and defers correction to a later explicit design.
- Whether fixed-schedule draft mode ships with P1/P2 or remains a follow-up.
  Existing fixed apply must stay immediate published either way.
