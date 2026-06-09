# 一天多班次 design-lock（SHOULD / schema-first）

Date: 2026-06-09
Baseline: `origin/main` @ `db6b128e`
Status: design-lock only; no runtime, schema, UI, scheduler, or staging change in this PR.

## 0. Why This Exists

The H2 tracker has finished all MUST items and the SHOULD item 自动对班 A0/A1.
The next useful attendance gap is **一天多班次**: an admin should be able to
assign more than one shift to the same user on the same work date, such as a
morning shift plus an evening shift.

This cannot be treated as "just allow two rows" because multiple existing
surfaces currently resolve a single effective shift:

- assignment create/update blocks any overlapping shift or rotation assignment
  through `findAttendanceScheduleAssignmentConflict`;
- `loadShiftAssignment` reads one row with `ORDER BY ... LIMIT 1`;
- effective-calendar, planned-minutes compliance, auto-shift matching, records,
  summary, and workbench views assume one effective assignment per user/day in
  several places.

Therefore v1 is a schema-first, resolver-first feature. It becomes ✅ only when
the storage, effective-calendar, compliance, admin UI, reverse tests, and one
staging smoke all agree on the same multi-slot semantics.

## 1. Current Grounding

| Area | Current state | Design consequence |
| --- | --- | --- |
| DB schema | `attendance_shift_assignments` has no slot column and no user/day unique constraint in the base migration. | The one-shift behavior is runtime policy, not just a DB unique to drop. |
| Conflict guard | `findAttendanceScheduleAssignmentConflict` returns the first active overlapping shift or rotation row for the user/date range. | Multi-shift needs a new conflict predicate: same slot conflicts, compatible different slots may coexist, rotation remains exclusive in v1. |
| Single-day resolver | `loadShiftAssignment` returns `LIMIT 1`; range loaders return arrays but downstream often chooses the single effective row. | Need a multi-slot resolver instead of sprinkling more rows into existing single-row readers. |
| Compliance cap | `enforceShiftComplianceCap` uses planned-minutes projection. The current projection was deliberately aligned with effective-calendar semantics. | Multi-slot planned minutes must be summed through the same projection, not hand-rolled. |
| Records/report | `attendance_records` remains one row per user/day, with first/last punch and derived metrics. | v1 should not add record slots. Metrics can remain first-to-last unless a later multi-segment metrics design is locked. |
| Report punch slots | Existing report fields expose punch slot 1/2/3 from record/meta. | v1 max 3 schedule slots is enough and avoids pretending the report surface is unbounded. |
| Auto shift | A0/A1 explicitly excludes multi-slot matching. | Auto-shift must keep one-slot matching until a separate extension handles multiple candidate shifts. |

## 2. Product Scope

### In

- Org-level setting enables **multiple shift assignments per user/day**.
- Admin may create up to three assignment slots for the same user/date.
- Each slot references one existing `attendance_shifts` row.
- Different slots may coexist only when their shift time windows do not overlap.
- Planned minutes for compliance/report planning is the sum of all active slots
  for the user/day.
- Default behavior remains one shift per user/day.

### Out

- No automatic creation of multiple slots from punches.
- No multi-slot 自动对班 in this line.
- No overnight multi-slot in v1.
- No multi-segment attendance record table in v1.
- No payroll-calculation engine changes.
- No mobile employee self-selection of a slot.
- No shift publication/draft lifecycle. That is a separate SHOULD item.

## 3. Data Model

The storage delta is a nullable-then-defaulted DB column:

- `attendance_shift_assignments.slot_index smallint NOT NULL DEFAULT 0`

API surface:

- expose `slotIndex` / `slot_index`;
- valid values: `0`, `1`, `2`;
- `0` is the legacy default slot;
- existing assignments backfill to `0`.

Do not use `slot` as the DB column name. `slot_index` is explicit and avoids
confusion with report punch slots or UI layout slots.

Migration discipline: the tracker still warns that hot-table schema changes
around `attendance_shift_assignments` should be batched when possible. M0 may
ship `slot_index` as a standalone latent column only if the pre-flight confirms
the adjacent `status`, `locked_at`, and shift-constraint schema items are not
ready to batch; otherwise coordinate those DDL changes into one migration set.

### Indexing / constraint

V1 should not rely on a partial unique index only on `(org_id, user_id,
start_date, slot_index)`, because assignments can cover date ranges and overlap
without sharing the same `start_date`.

Required v1 guard:

- keep the per-user advisory/transaction lock already used by assignment writes;
- in the transaction, reject active assignment date-range overlap for the same
  `slot_index`;
- reject active assignment date-range overlap when the different slot's shift
  time window overlaps this slot's shift time window;
- reject any overlap with an active rotation assignment. Rotation + multi-slot
  coexistence is out of scope for v1.

Optional DB hardening for a later slice:

- evaluate a `btree_gist` exclusion constraint over `(org_id, user_id,
  slot_index, daterange(start_date, coalesce(end_date, '9999-12-31'), '[]'))`
  for same-slot overlap. Do not add it in the first implementation slice unless
  migration replay and staging alignment are explicitly planned.

## 4. Effective Schedule Semantics

For a user/day, the effective direct-shift schedule becomes:

- zero direct assignments: no direct shift;
- one direct assignment: current behavior;
- multiple direct assignments: sorted by `slot_index ASC`, then
  `work_start_time ASC`, then `created_at ASC`.

Each returned slot contains:

- assignment id;
- slot index;
- shift id/name;
- start/end time;
- timezone;
- planned minutes.

The single-shift compatibility field may continue returning slot `0` or the
first sorted slot for old consumers, but any surface that claims multi-shift
support must read the multi-slot array.

`GET /api/attendance/effective-calendar` should add a stable field, for example:

```json
{
  "effective": {
    "source": "shift_assignment",
    "slots": [
      { "slotIndex": 0, "shiftId": "...", "plannedMinutes": 240 },
      { "slotIndex": 1, "shiftId": "...", "plannedMinutes": 240 }
    ],
    "plannedMinutes": 480
  }
}
```

Do not silently hide extra slots behind the old single `shift` field.
If this response is part of the OpenAPI contract, M2 must update the contract
and generated artifacts in the same slice.

## 5. Records, Summary, And Metrics

V1 does **not** introduce multiple `attendance_records` rows per day.

For actual attendance metrics:

- `first_in_at` and `last_out_at` remain the day-level first/last punch;
- `work_minutes` remains the current first-to-last derived metric;
- no split-break deduction is introduced in this line.

For planned schedule metrics:

- planned minutes must sum all effective slots;
- shift-compliance caps must evaluate the summed planned minutes;
- comprehensive-hours planned reporting must reuse the same summed projection.

This means v1 is a scheduling/planned-load feature, not a full multi-segment
payroll engine. That limitation must be visible in the tracker and UI copy.
It also does not change the record-side first/last semantics or the S2
internal/outdoor in-out merge policy; multi-shift is a schedule-side feature.

## 6. Write Paths To Cover

The implementation must cover all assignment writers, not just the visible
manual POST route:

- `POST /api/attendance/assignments`
- `PUT /api/attendance/assignments/:id`
- fixed-schedule apply / rebuild paths
- auto-shift A1 apply

Rotation assignments remain mutually exclusive with direct multi-shift slots in
v1. If a user/day has an active rotation assignment, direct shift slot creation
must still fail with the existing conflict family.

Fixed-schedule apply may default to `slotIndex=0`. It does not need to generate
multiple slots in v1, but it must not delete or overwrite other slots unless the
operator explicitly targets them in a later design.

Auto-shift A1 remains single-slot:

- it may only apply when no active direct/rotation assignment covers the
  user/day;
- it writes `slotIndex=0`;
- multi-slot matching is separate.

## 7. Admin UI

V1 admin UI should be explicit and quiet:

- a setting card: "允许一天多班次", default off;
- assignment editor exposes slot index only when the setting is on;
- schedule/workbench cells render stacked small shift chips for slots 0-2;
- no "apply all slots" bulk action in the first slice.

The UI copy must not promise payroll-grade split-shift calculations. Use wording
like "用于排班计划与合规上限；实际出勤仍按当日打卡记录汇总。"

## 8. Tests

Required real-DB tests before ✅:

1. default setting off: second overlapping assignment for the same day still
   returns the current conflict response;
2. setting on: two non-overlapping slots for the same user/day persist;
3. same slot overlap is rejected;
4. different slot but overlapping shift time window is rejected;
5. rotation overlap remains rejected;
6. planned minutes / shift-compliance cap sums both slots;
7. effective-calendar returns the multi-slot array and summed planned minutes;
8. fixed-schedule apply writes slot 0 and does not clobber an existing non-zero
   slot;
9. auto-shift A1 stays single-slot and does not create a second slot;
10. admin UI can create/render two slots and preserves the exact API payload.

Staging smoke:

- enable the org setting;
- create morning and evening shifts;
- assign both to the same synthetic user/date in different slots;
- assert effective-calendar shows two slots and planned minutes are summed;
- assert a cap below the summed minutes blocks a third/updated save;
- cleanup residue = 0.

## 9. Slice Plan

| Slice | Scope | Status |
| --- | --- | --- |
| D0 | This design-lock + tracker backfill | ✅ this PR |
| M0 | Latent setting + `slot_index` migration + mapping, default no behavior change | 🔒 |
| M1 | Conflict guard + assignment POST/PUT accepts `slotIndex`, real-DB tests | 🔒 |
| M2 | Effective-calendar/planned-minutes projection sums slots | 🔒 |
| M3 | Fixed-apply and auto-shift compatibility guards | 🔒 |
| M4 | Admin UI stacked slots + editor controls | 🔒 |
| M5 | Staging smoke + tracker ✅ closeout | 🔒 |

## 10. Completion Bar

一天多班次 stays 🟡 until all of these are true:

- schema is migrated and replay-validated;
- default org settings preserve current one-shift behavior;
- manual assignment create/update supports slots with conflict protection;
- planned minutes and shift-compliance cap sum all effective slots;
- effective-calendar exposes slots without hiding them behind a single shift;
- fixed-schedule and auto-shift paths keep their locked single-slot semantics;
- admin UI can configure/render slots;
- staging smoke passes with residue 0.

Only then may the tracker row flip to ✅.
