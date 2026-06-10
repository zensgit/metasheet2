# 临时班次 design-lock（SHOULD / one-off overlay）

Date: 2026-06-09
Baseline: `origin/main` @ `c74cdc6f3`
Status: design-lock only; no runtime, schema, UI, OpenAPI, scheduler, or staging change in this PR.

## 0. Why This Exists

The H2 tracker has closed the MUST items, shipped 自动对班 A0/A1, and locked the
multi-shift-day direction. The next scheduling gap is **临时班次**: an admin needs
to change one user's planned shift for one specific date without rebuilding the
person's fixed schedule, rotation, or future schedule pattern.

This is not a full dispatch / swap-shift system. V1 is a one-off scheduling
override with clear conflict rules, lifecycle, UI copy, and smoke criteria.

## 1. Current Grounding

| Area | Current state | Design consequence |
| --- | --- | --- |
| Shift catalog | `attendance_shifts` stores reusable shift definitions. Assignment rows point at a `shift_id`. | Do not create one catalog row per temporary day. Temp shift should reference an existing shift definition. |
| Assignment storage | `attendance_shift_assignments` is the hot write table used by manual assignment, fixed-apply, and auto-shift A1. | Temp shift belongs on the assignment path as metadata / kind, not as a parallel temp table. |
| Conflict guard | `findAttendanceScheduleAssignmentConflict` rejects active date-range overlap across direct shift and rotation assignments. | Temp replacement needs an explicit overlay exception; otherwise a one-day override cannot coexist with the schedule it is meant to replace. |
| Effective resolver | `resolveWorkContext` currently prefers rotation, then direct shift, then rule. `loadShiftAssignment` returns one direct assignment with `LIMIT 1`. | Temp shift must deliberately change resolver precedence for its exact date; this cannot be a UI-only label. |
| Multi-shift neighbor | `attendance-multi-shift-day-design-lock-20260609.md` locks `slot_index` and up to three direct slots. | Temp shift must target one slot and must not invent a second slot model. |
| Publish/draft neighbor | The tracker lists 排班发布/草稿 before 临时班次 and warns that `status`, `locked_at`, and `slot_index` should be batched when possible. | Temp lifecycle should reuse assignment status once it exists; it should not build a separate draft/publish mechanism. |
| Fixed-apply / auto-shift | Fixed-apply and auto-shift A1 both insert `attendance_shift_assignments` with provenance and compliance checks. | Temp rows must be preserved by those writers and must count as "scheduled" for auto-shift eligibility. |

## 2. Product Scope

### In

- One user, one work date, one targeted slot.
- Reference an existing active `attendance_shifts` row.
- Mark the assignment as temporary with reason / operator metadata.
- Support **replace** semantics for a regular direct assignment, fixed-applied
  assignment, or auto-shift assignment on that date.
- Reject rotation replacement in v1 with stable error code
  `TEMP_SHIFT_ROTATION_REPLACEMENT_UNSUPPORTED`.
- Enforce the existing edit window, scheduler-scope permissions, and
  shift-compliance caps.
- Preserve fixed schedules, rotation rules, and auto-shift provenance; the temp
  row overlays the date instead of mutating the source schedule.
- Wait for assignment publish/draft status before runtime implementation.

### Out

- No new `attendance_shifts` row per temp day.
- No employee self-service shift swap.
- No approval workflow for requesting a temporary shift.
- No recurring temporary shift pattern.
- No payroll-grade split-shift engine.
- No multi-day temp range in v1.
- No `add` mode in v1. Add-mode is deferred until multi-shift M0-M5 is
  staging-proven.
- No rotation replacement in v1. Rotation overrides need a separate design that
  proves resolver precedence.
- No immediate-active interim. That requires a separate owner-approved interim
  design if the product owner later wants it.
- No independent temp-shift draft/publish lifecycle apart from the assignment
  lifecycle.

## 3. Design Decision: Assignment Metadata, Not Separate Shift Rows

Temporary shift is a kind of assignment row.

Locked contract:

- `attendance_shifts` remains the reusable shift catalog.
- `attendance_shift_assignments` gets temp metadata when the row is a one-off
  override.
- The temp row always has `start_date = end_date = workDate`.
- The temp row points to the replacement `shift_id`.
- The replaced schedule is not split, deleted, or rewritten.

Suggested schema shape, to batch with the adjacent hot-table fields if they are
ready:

```sql
assignment_kind text NOT NULL DEFAULT 'regular'
temporary_mode text NULL
temporary_replaces_kind text NULL
temporary_replaces_assignment_id uuid NULL
temporary_reason text NULL
temporary_created_by text NULL
temporary_created_at timestamptz NULL
```

Allowed values:

- `assignment_kind`: `regular | temporary`
- `temporary_mode`: `replace`
- `temporary_replaces_kind`: `shift | rule`

Do not overload `producer_type` for this. Producer metadata answers "who created
or owns this row" (`attendance_group_fixed_schedule`, `auto_shift_match`);
temporary status answers "how this row participates in the effective schedule".
A future workflow-created temp row may still carry producer metadata separately.

## 4. Effective Schedule Semantics

For a user/date/slot, precedence becomes:

1. published / active temporary assignment for that exact date and slot;
2. rotation assignment result for that date;
3. regular direct shift assignment for that date and slot;
4. default rule / calendar-policy fallback.

V1 temp shift is replace-only. It shadows the effective direct/rule row in slot
`0` for that date only. It does not create another slot.

If the current effective schedule is rotation, v1 returns
`TEMP_SHIFT_ROTATION_REPLACEMENT_UNSUPPORTED`. A later rotation override design
must prove resolver precedence before temp-over-rotation is allowed.

Effective-calendar must expose the temporary nature instead of hiding it behind
the old single shift field. The multi-shift shape can extend with metadata:

```json
{
  "slotIndex": 0,
  "shiftId": "shift-temp",
  "assignmentKind": "temporary",
  "temporaryMode": "replace",
  "temporaryReason": "customer onsite support",
  "replaces": {
    "kind": "shift",
    "assignmentId": "assignment-regular"
  }
}
```

Old single-shift consumers may keep reading the effective first slot, but any UI
that claims temp-shift support must render the temp marker and the replaced
shift hint.

## 5. Lifecycle

Temporary shift lifecycle is assignment lifecycle:

- create as draft / pending / published according to the assignment publish
  model;
- runtime implementation must wait until assignment publish/draft status exists;
- this design lock forbids an immediate-active interim;
- publish makes the temp shift visible to employee effective-calendar and
  planned-minute projections;
- cancel soft-deactivates the temp row and restores the underlying effective
  schedule for that date;
- edit is allowed only inside the existing shift edit window and must re-run
  conflict and compliance guards;
- after `locked_at` or edit-window closure, only explicit admin unlock/follow-up
  work may change the row.

No separate temp status such as `temp_pending` is allowed. Use the same status
values as regular assignments.

## 6. Conflict Rules

The conflict helper must become temp-aware. Required behavior:

| Scenario | Result |
| --- | --- |
| temp replace of same user/date/slot regular direct assignment | allowed; regular assignment remains stored but is shadowed for that date |
| temp replace of fixed-applied row | allowed; fixed provenance remains intact |
| temp replace of auto-shift row | allowed; auto-shift provenance remains intact |
| temp replace of rotation result | reject with `TEMP_SHIFT_ROTATION_REPLACEMENT_UNSUPPORTED` |
| second temp replace for same user/date/slot | reject |
| temp add request | reject with `TEMP_SHIFT_ADD_MODE_DEFERRED` until multi-shift M0-M5 is staging-proven |
| temp with open-ended or multi-day range | reject |
| regular/fixed/auto writer overlaps an existing temp date | allowed only when the temp remains the effective overlay and the writer reports the preserved temp date in preview/details |

Draft/publish interaction:

- published rows conflict with published rows;
- draft temp rows conflict inside the draft batch/preview layer but do not affect
  employee effective-calendar;
- publishing a batch must re-run the conflict guard against current published
  rows and current temp overlays.

## 7. Compatibility With Adjacent SHOULD Items

### Multi-shift slots

Temp shift uses `slot_index`; it does not define a separate "temporary slot".
If `slot_index` is not yet in the table, temp-shift implementation should wait
or batch the migration. Shipping temp before slot semantics would create a
second single-day conflict model and make the later multi-shift migration harder.

V1 uses replace semantics only. `add` mode is deferred until multi-shift M0-M5 is
staging-proven, then may ship as a follow-up slice using the established
slot/non-overlap guard.

### Publish / draft

Temp shift must be implemented after the assignment `status` design. Temp rows
publish/cancel exactly like regular assignment rows.

No immediate-active interim is part of this design. If the product owner later
wants that bridge, open a separate interim design before any runtime work.

### Fixed-apply / rebuild / clear

Fixed-apply and rebuild must not delete or rewrite temp rows.

Expected behavior:

- preview reports preserved temporary overlays in a separate count, e.g.
  `temporaryOverrides[]`;
- apply/rebuild can create or refresh the regular fixed row underneath;
- effective-calendar still returns the temp row on the temp date;
- clear only affects rows owned by `producer_type='attendance_group_fixed_schedule'`;
  it must not clear temp rows.

### Auto-shift A1

Auto-shift A1 remains single-slot and non-temp:

- temp rows count as scheduled, so auto-shift preview/apply skips that user/date;
- auto-shift must not overwrite an existing temp row;
- if auto-shift creates a regular assignment for a date that already has a
  preserved temp overlay, the temp row remains effective for that date.

## 8. Admin UI Copy

Use clear operational copy, not payroll promises.

Recommended labels:

- action: `添加临时班次`
- mode label: `替换当天原班次`
- date helper: `仅影响所选日期，不修改固定排班或轮班规则。`
- publish helper: `发布后员工可见；草稿不会影响实际考勤计划。`
- compliance helper: `保存时仍会校验排班修改窗和工时上限。`
- add-mode helper, if a disabled affordance is shown: `新增当天班次需等待一天多班次完成后开放。`

Avoid wording like "自动调度", "换班", "算薪已拆段", or "永久调整".

## 9. Test Matrix Before Runtime ✅

Backend real-DB tests:

1. default regular assignment behavior remains unchanged;
2. temp create rejects multi-day or open-ended range;
3. temp replace shadows a regular direct row for one date and restores it after
   soft-cancel;
4. temp replace shadows fixed-applied row without changing producer metadata;
5. temp replace shadows auto-shift row without changing producer metadata;
6. temp replace of rotation rejects with
   `TEMP_SHIFT_ROTATION_REPLACEMENT_UNSUPPORTED`;
7. second temp for same user/date/slot rejects;
8. temp add rejects with `TEMP_SHIFT_ADD_MODE_DEFERRED`;
9. runtime create/publish rejects if assignment status support is absent;
10. planned minutes and shift-compliance use the effective temp shift on the temp
    date;
11. publish batch revalidates stale temp conflicts;
12. fixed-apply preview/apply preserves temp overlays;
13. auto-shift preview/apply skips temp-covered user/date;
14. scheduler-scope actor without write scope receives 403;
15. edit-window violation returns the existing edit-window error family.

Frontend tests:

1. assignment editor opens "添加临时班次" with workDate only;
2. replace mode shows the original shift being replaced;
3. add mode is hidden or disabled with deferred copy;
4. draft/published marker renders using assignment status;
5. temp chip is visible in effective-calendar / scheduling cell;
6. UI payload includes `assignmentKind='temporary'`, mode, workDate, slotIndex,
   shiftId, and reason; it does not create a new shift definition.

Staging smoke:

1. create a synthetic scheduled-shift user, regular shift, and replacement shift;
2. create/publish a one-day temp replace row;
3. assert effective-calendar returns the replacement shift with temporary
   metadata and planned minutes;
4. cancel the temp row and assert the original schedule returns;
5. create a fixed-applied row, create a temp replace override, rerun fixed rebuild, and
   assert the temp row remains effective;
6. run auto-shift preview/apply on the temp-covered date and assert it skips;
7. cleanup residue = 0 for users, shifts, assignments, groups, events, and
   records created by the smoke.

## 10. Slice Plan

| Slice | Scope | Status |
| --- | --- | --- |
| T0 | This design-lock + tracker backfill | ✅ this PR |
| T1 | Wait for / batch with `slot_index` / assignment `status` / `locked_at`; temp metadata mapping only, default no behavior change | 🔒 |
| T2 | Replace-only temp-aware conflict guard + create/cancel routes, edit-window/scope/compliance tests | 🔒 |
| T3 | Effective-calendar / planned-minutes resolver precedence | 🔒 |
| T4 | Fixed-apply and auto-shift compatibility tests + diagnostics | 🔒 |
| T5 | Admin UI for replace-only temp row + frontend tests | 🔒 |
| T6 | Staging smoke and tracker closeout | 🔒 |
| T7 | Deferred add-mode after multi-shift M0-M5 staging proof, using slot/non-overlap guard | 🔒 separate follow-up |

## 11. Locked Runtime Boundaries

These are not open decisions for v1:

1. V1 rejects rotation replacement with
   `TEMP_SHIFT_ROTATION_REPLACEMENT_UNSUPPORTED`. Rotation overrides require a
   separate rotation-override design that proves resolver precedence.
2. V1 is replace-only. `add` mode is deferred until multi-shift M0-M5 is
   staging-proven, and then can be a follow-up slice using the slot/non-overlap
   guard.
3. V1 waits for assignment publish/draft status. There is no immediate-active
   interim in this design; an interim path requires a separate owner-approved
   design later.
