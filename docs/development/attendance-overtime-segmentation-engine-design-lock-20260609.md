# 加班三段引擎 design-lock（SHOULD / runtime rule engine）

Date: 2026-06-09
Baseline: `origin/main` @ `c74cdc6f3`
Status: design-lock only; no runtime, schema, UI, OpenAPI, scheduler, or staging change in this PR.

## 0. Why This Exists

The H2 tracker still lists **加班三段引擎** as unfinished: current overtime reporting
can show workday / rest-day / holiday labels, but the classification is not a
runtime overtime rule engine.

Today:

- overtime requests persist one approved `metadata.minutes` value;
- `attendance_overtime_rules` only has generic min / rounding / max / active
  fields;
- summary aggregation sums approved overtime minutes without a day-type split;
- record report fields derive `workday_overtime_duration` and
  `restday_overtime_duration` from `attendance_records.is_workday`;
- `holiday_overtime_duration` reads record metadata keys that are not produced by
  an approval-time segmentation engine;
- custom formula fields can display derived overtime labels, but formulas are a
  report projection, not the attendance fact source.

The design goal is to move the three-way split into a deterministic runtime
engine that executes on overtime approval / record settlement and feeds requests,
records, summary, report fields, and comp-time from the same source of truth.

## 1. Current Grounding

| Area | Current state | Design consequence |
| --- | --- | --- |
| Overtime request write | Generic `/api/attendance/requests` resolves `requestType='overtime'`, applies one `applyOvertimeRule(minutes, rule)`, and stores one `metadata.minutes` total. | The three-way split must attach to the request draft / final approval path, not only to report display. |
| Overtime rules | `attendance_overtime_rules` stores `min_minutes`, `rounding_minutes`, `max_minutes_per_day`, `requires_approval`, `is_active`. | Existing rules are not day-type policies. Runtime needs a per-day-type policy layer or a versioned config snapshot. |
| Effective day truth | `resolveWorkContext` and `resolveEffectiveCalendar` already combine shift / rotation / default rule, holiday rows, and `calendarPolicy.overrides`. | Do not create a second holiday/rest-day classifier. The overtime engine must consume the same effective-calendar verdict. |
| Holiday policy | `holidayPolicy` can adjust holiday first-day work minutes and warnings, while `calendarPolicy` answers whether a date is working. | Overtime day type must use calendar truth first; holiday first-day display math is not the segmentation source. |
| Records | `attendance_records` remains one row per user/day; `overtime_minutes` is the total approved overtime for that day. | V1 keeps total compatibility while adding segment metadata / values; it does not create per-segment record rows. |
| Summary/report | `loadAttendanceSummary` sums approved request minutes by request type; built-in report fields derive workday/rest-day from `is_workday`, and holiday from optional metadata. | Summary and report fields must switch to engine-produced segment totals when the runtime slice lands. |
| Dynamic subtype fields | Rule-specific fields aggregate by `metadata.overtimeRule.id`. | Rule subtype totals stay orthogonal to day-type totals; do not overload rule id to mean day type. |
| Formula fields | Record and summary formulas are projections with guardrails; they do not write attendance facts. | Formula-derived labels must remain optional display/report logic, never the source for runtime overtime segmentation. |
| Comp-time | Final overtime approval may grant `comp_time` from `requestMetadata.minutes` when `compTimeFromOvertime.enabled=true`. | Comp-time must consume the segmentation engine output, with default 1:1 total behavior preserved. |

## 2. Product Scope

### In

- Classify approved overtime into exactly three day-type buckets:
  `workday`, `restday`, `holiday`.
- Use effective-calendar as the day-type source of truth.
- Persist a versioned segmentation snapshot on the overtime request metadata.
- Feed records, summary, report fields, period/report sync, and comp-time from
  that snapshot.
- Keep existing total overtime minutes backward-compatible.
- Add reverse tests proving formula-derived fields are not the runtime source.

### Out

- No payroll engine, overtime pay multiplier, or wage calculation.
- No legal compliance calculator.
- No multi-day / cross-midnight overtime segmentation in v1.
- No cross-midnight overtime acceptance in v1; such requests are rejected.
- No multi-slot overtime attribution in this line.
- No new mobile experience.
- No automatic approval or approval-flow redesign.
- No schema, runtime, frontend, or OpenAPI change in this design-lock PR.

## 3. Day-Type Source Of Truth

The engine must expose one helper, conceptually:

```ts
resolveOvertimeDayType({ orgId, userId, workDate }) =>
  { dayType, effectiveCalendarSnapshot, decision }
```

Rules:

1. Resolve the user/date through the same path as attendance calculation:
   `resolveWorkContext` for write-time settlement, or a shared prefetch helper
   aligned with `resolveEffectiveCalendar` for batch/report paths.
2. If `effective.isWorkingDay === true`, day type is `workday`.
3. If `effective.isWorkingDay === false` and the effective-calendar layer stack
   contains a non-working holiday row for the date, day type is `holiday`.
4. If `effective.isWorkingDay === false` and there is no holiday row, day type is
   `restday`.
5. A statutory makeup workday / working-day override is `workday` for overtime
   segmentation because the effective calendar says it is a working day.
6. A company or group rest override without a holiday row is `restday` in v1.
   Holiday premium / holiday classification for such days requires an explicit
   future override design.

This intentionally treats `calendarPolicy` as the verdict source and
`holidayPolicy` as work-minute / warning policy. The overtime engine must not
infer day type from labels, UI chips, formula names, or request reason text.

### Snapshot fields

The future runtime slice should persist a compact request metadata snapshot such
as:

```json
{
  "overtimeSegmentation": {
    "version": 1,
    "engine": "attendance_overtime_segmentation_v1",
    "workDate": "2026-10-01",
    "dayType": "holiday",
    "calendar": {
      "effectiveIsWorkingDay": false,
      "effectiveSource": "holiday-cn",
      "holidayName": "国庆节-1",
      "holidayDayIndex": 1,
      "policyId": null
    },
    "segments": {
      "workdayMinutes": 0,
      "restdayMinutes": 0,
      "holidayMinutes": 180
    },
    "totalMinutes": 180,
    "compTimeGrantMinutes": 180
  }
}
```

The exact JSON key can change during implementation, but the contract is
mandatory: downstream code reads a versioned engine snapshot, not formulas or
localized strings.

## 4. Runtime Rule Engine Contract

The first runtime implementation should be a small pure engine plus persistence
adapter:

1. **Normalize input minutes** using existing overtime rule min / rounding / max
   behavior. Preserve today’s total-minute semantics.
2. **Resolve day type** from §3.
3. **Allocate all v1 minutes to one bucket** because v1 requests are one
   `workDate`. Cross-date segmentation is deferred and must not be silently
   approximated.
4. **Return a deterministic result** with total minutes, three bucket minutes,
   day-type decision, and calendar fingerprint.
5. **Persist the result** on the overtime request metadata at creation/update and
   refresh it inside final approval before records / comp-time are written.

If a request has `requestedInAt` / `requestedOutAt` that crosses the work-date
boundary, v1 rejects it with stable validation code
`OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED`. Do not accept with warning and do not
auto-split across dates without a separate cross-day design.

### Policy shape

O1/O2 must use org settings JSON only. No schema migration, new table, or
`attendance_overtime_rules` column is allowed in the first runtime
implementation unless a later explicit schema design is opened. The v1 shape is
an org settings object:

```json
{
  "overtimeSegmentation": {
    "enabled": false,
    "mode": "classify",
    "rounding": {
      "workday": "use_overtime_rule",
      "restday": "use_overtime_rule",
      "holiday": "use_overtime_rule"
    }
  }
}
```

Defaults preserve current behavior:

- unset / disabled means existing total overtime behavior;
- when enabled, all three day types use the existing overtime rule for min /
  rounding / max;
- comp-time grant remains 1:1 total by default.
- per-day-type comp-time conversion rates are not accepted in O1/O2 config.

Later policy-rich variants, such as per-day-type caps or conversion rates, can
move to a table only after a separate schema/runtime design is opened.

## 5. Request Integration

Overtime request creation/update should still validate:

- valid overtime rule;
- positive minutes or valid requested interval;
- approval flow routing;
- duplicate request protections.

The future runtime slice must add:

- segmentation snapshot generation after `applyOvertimeRule`;
- snapshot refresh in the final approval transaction, so stale calendar/policy
  changes between request creation and final approval are handled deliberately;
- metadata diff visibility: response payload should include the snapshot or a
  normalized read model for admin audit.

Final approval order:

1. lock request / approval rows as today;
2. transition approval state;
3. for final approved overtime, recompute or validate the segmentation snapshot;
4. write request metadata with the final snapshot;
5. update attendance record using segment-aware approved minutes;
6. grant comp-time from the segment result if enabled.

This avoids a split-brain where records/report read one classification and
comp-time grants another.

## 6. Records, Summary, And Report Fields

### Daily record

`attendance_records.overtime_minutes` remains the total approved overtime
minutes for compatibility.

The runtime slice must also make segment totals available to record/report code,
either by record metadata or by a shared approved-minutes loader:

- `workdayOvertimeMinutes`
- `restdayOvertimeMinutes`
- `holidayOvertimeMinutes`

Report field behavior after runtime:

- `overtime_approval_duration` = total approved overtime minutes;
- `workday_overtime_duration` = engine workday bucket;
- `restday_overtime_duration` = engine restday bucket;
- `holiday_overtime_duration` = engine holiday bucket.

Do not keep deriving workday/rest-day buckets as
`is_workday ? total : 0` / `!is_workday ? total : 0` once the engine is enabled.
That old fallback is acceptable only for historical rows missing a segmentation
snapshot, and the fallback must be visible in tests.

### Summary

`loadAttendanceSummary` must aggregate the same segment values used by record
report fields. It should not run a separate SQL-only classifier using
`attendance_records.is_workday`, because holiday vs rest-day depends on the
effective-calendar layer stack.

### Report sync / period summary

Any report-record or period-summary sync that emits overtime fields must consume
the same segment values and include the segmentation version/fingerprint in its
source fingerprint. A calendar-policy change that changes day type must cause a
rebuildable snapshot to diverge rather than silently staying stale.

### Formula fields

Formula fields may reference segment fields after the runtime fields exist, but
formulas remain projections. Tests must prove deleting or changing a formula
field cannot change the runtime segment totals.

## 7. Comp-Time Interaction

Existing `compTimeFromOvertime` grants a `comp_time` lot during final overtime
approval using `requestMetadata.minutes`.

After this line, comp-time must use the segmentation result:

- default `compTimeGrantMinutes = totalMinutes`, preserving today’s 1:1 behavior;
- per-day-type conversion rates stay latent in v1; no bucket multiplier is
  applied unless a later runtime slice explicitly opts in;
- the grant lot and grant event remain idempotent by
  `source_key = overtime_conversion:{requestId}`;
- grant metadata should keep the segmentation version and bucket totals for
  audit;
- if segmentation fails, final approval must fail before any comp-time lot or
  record update is written.

No automatic reversal policy is introduced here; the existing comp-time reversal
boundary remains unchanged.

## 8. Tests

Required tests before this SHOULD item can become ✅:

| Layer | Required cases |
| --- | --- |
| Pure helper | workday, weekly rest day, statutory holiday, statutory makeup workday, calendarPolicy rest override, calendarPolicy work override, missing holiday row. |
| Request create/update | overtime request persists a versioned segmentation snapshot; invalid cross-date request is explicit; existing total minutes remain compatible. |
| Final approval | snapshot is recomputed/refreshed in the approval transaction; failed segmentation rolls back request status, record update, and comp-time grant. |
| Records | approved workday/restday/holiday overtime creates the same total `overtime_minutes` but different bucket values. |
| Summary | `/api/attendance/summary` returns total + three segment totals from engine output. |
| Report fields | built-ins use segment buckets; historical rows without snapshot use documented fallback; formula fields cannot alter engine totals. |
| Dynamic subtype | overtime-rule subtype totals still aggregate by rule id and do not replace day-type buckets. |
| Comp-time | grant amount uses `compTimeGrantMinutes`; duplicate approval still creates one lot and one grant event. |
| Effective calendar parity | engine day type matches `GET /api/attendance/effective-calendar` for the same user/date. |
| Permissions / degradation | missing calendar schema returns explicit degraded / `DB_NOT_READY`, never all-zero success. |

## 9. Staging Smoke

One staging smoke is required before tracker ✅:

1. enable the org setting / runtime flag for overtime segmentation;
2. create or reuse one overtime rule;
3. seed three synthetic user-days:
   - normal workday;
   - non-holiday rest day;
   - statutory holiday row with `is_working_day=false`;
4. create and approve one overtime request per day;
5. assert request metadata has `version`, `dayType`, and bucket totals;
6. assert daily records keep total overtime and expose the correct bucket;
7. assert summary/report fields show one bucket per request and no leakage into
   the other two;
8. enable `compTimeFromOvertime` for one run and assert the grant amount equals
   the engine `compTimeGrantMinutes`;
9. cleanup users, requests, records, holidays, comp-time lots/events, and
   settings; residue must be 0.

## 10. Slice Plan

| Slice | Scope | Status |
| --- | --- | --- |
| O0 | This design-lock + tracker backfill | ✅ this PR |
| O1 | Pure day-type resolver + overtime segmentation helper, tests only | ✅ implemented |
| O2 | Request create/update + final approval metadata snapshot, default off | ✅ implemented |
| O3 | Record / summary loaders consume segment buckets | ✅ implemented |
| O4 | Built-in report fields + report sync fingerprint use engine output | ✅ implemented |
| O5 | Comp-time consumes `compTimeGrantMinutes` + idempotence tests | ✅ implemented |
| O6 | Staging smoke + tracker ✅ closeout | 🟡 harness prepared; staging run pending |

## 11. Locked V1 Decisions

These decisions are pinned for O1/O2 and must not be re-litigated in the first
runtime PR:

- **Storage:** first runtime implementation uses org settings JSON only. No
  schema migration, new table, or overtime-rule column is allowed in O1/O2 unless
  a later explicit schema design is opened.
- **Cross-midnight:** cross-midnight overtime is rejected in v1 with stable
  validation code `OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED`. Do not accept with
  warning.
- **Company extra rest days:** company-specific extra rest days without holiday
  rows classify as `restday` in v1. Holiday premium/classification requires an
  explicit future override design.
- **Comp-time conversion:** per-day-type comp-time conversion rates stay latent.
  V1 remains a 1:1 total grant unless a later runtime slice opts in.

## 12. Completion Bar

加班三段引擎 remains 🟡 until all of these are true:

- day type is resolved through effective-calendar truth;
- request metadata has a versioned segmentation snapshot;
- record, summary, report fields, and report sync consume the same engine output;
- comp-time grants use the engine grant amount without breaking idempotence;
- formula-derived labels are proven non-authoritative;
- reverse tests cover workday / restday / holiday / makeup workday / overrides;
- staging smoke passes with residue 0.

Only then may the tracker row flip to ✅.
