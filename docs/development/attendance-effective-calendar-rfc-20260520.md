# Attendance Effective Calendar RFC

Date: 2026-05-20
Status: Draft for review
Scope: RFC only. No runtime code, migration, route, UI, or test change in this slice.

## 1. Current State

The current attendance calendar model has three separate semantics that are easy to confuse:

| Area | Current evidence | Current meaning |
| --- | --- | --- |
| Request overlay source | `packages/core-backend/src/db/types.ts:1052-1062`, `packages/core-backend/src/db/migrations/zzzz20260120110000_add_attendance_request_types.ts:5-22` | Current runtime request types are `missed_check_in`, `missed_check_out`, `time_correction`, `leave`, `overtime`. The migration `down()` at lines 25-33 restores the old three-type constraint. |
| Holiday table shape | `packages/core-backend/src/db/migrations/zzzz20260114120000_add_attendance_scheduling_tables.ts:57-73` | `attendance_holidays` is one row per `(org_id, holiday_date)`. There is no source/origin column and the unique index prevents stacking national and manual base rows on the same date. |
| Holiday DTO | `plugins/plugin-attendance/index.cjs:7414-7424` | Holidays are mapped to only two states: `holiday` or `working_day_override`. |
| Workday calculation | `plugins/plugin-attendance/index.cjs:9903-9923`, `plugins/plugin-attendance/index.cjs:10085-10110` | `resolveWorkContext` chooses rotation shift, shift assignment, or default rule, then hard-overrides `isWorkingDay` with the org-level holiday row if one exists. |
| Holiday policy filters | `plugins/plugin-attendance/index.cjs:8326-8359` | The existing holiday-policy filter supports day index, users, attendance groups, roles, and role tags. |
| Holiday policy application | `plugins/plugin-attendance/index.cjs:8399-8452`, call sites at `plugins/plugin-attendance/index.cjs:13905`, `18546`, `19387`, `20371`, `21110` | `holidayPolicy` changes work/payroll metrics, not the date-level effective workday used by `resolveWorkContext`. |
| Holiday policy name requirement | `plugins/plugin-attendance/index.cjs:9116-9164`, `plugins/plugin-attendance/index.cjs:11825-11849` | `holidayPolicy.overrides[]` requires `name`, so it cannot cleanly represent pure date/range calendar overrides. |
| Holiday sync writer | `plugins/plugin-attendance/index.cjs:8594-8621`, `8721-8762`, `23640-23678` | `/api/attendance/holidays/sync` currently upserts into the same table and counts only returned insert/update rows as applied. |
| Admin holiday CRUD | `plugins/plugin-attendance/index.cjs:23705-23840` | Manual create/update/delete also writes `attendance_holidays` directly. |
| Business trip report source | `plugins/plugin-attendance/index.cjs:845`, `3981`, `4298-4299`; `apps/web/src/views/AttendanceView.vue:8064`, `8136-8137` | Business trip exists as attendance record/report minutes, not as an `attendance_requests.request_type`. |
| Calendar consumers | `apps/web/src/multitable/views/MultitableWorkbench.vue:2817-2824`, `apps/web/src/views/attendance/useAttendanceAdminScheduling.ts:768-779`, `apps/web/src/composables/useCalendarDays.ts:157-202` | Frontend calendar views consume `/api/attendance/holidays` and shared `useCalendarDays`; they do not receive scoped effective layers or personal overlays. |

Conclusion: `attendance_holidays` is currently an org-level base table, `holidayPolicy` is a payroll/work-hours adjustment layer, and personal leave/overtime overlays are separate request data. The effective-calendar design must keep those semantics separate.

## 2. Data Model Diff

### 2.1 `attendance_holidays.origin`

Add a minimal origin column to the base holiday table:

```sql
ALTER TABLE attendance_holidays
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'manual';

ALTER TABLE attendance_holidays
  ADD CONSTRAINT attendance_holidays_origin_check
  CHECK (origin IN ('national', 'manual'));
```

Rules:

- `origin = 'national'`: rows written by `/api/attendance/holidays/sync`.
- `origin = 'manual'`: rows written by admin create/update or existing historical rows.
- Existing rows are backfilled by the `DEFAULT 'manual'`.
- The unique index remains `(org_id, holiday_date)`. This RFC intentionally does not support two base rows on the same org/date.
- Organization, group, role, and user differences must not be modeled by additional `attendance_holidays` rows. They belong in `settings.calendarPolicy.overrides[]`.

Rationale: `origin` protects manual base rows from national sync. It is not a full provenance/lineage model and should not be named `provenance`.

### 2.2 `settings.calendarPolicy.overrides[]`

Add a separate calendar policy under attendance settings:

```ts
interface AttendanceCalendarPolicy {
  overrides?: CalendarPolicyOverride[]
}

interface CalendarPolicyOverride {
  id?: string
  name?: string
  date?: string
  from?: string
  to?: string
  match?: 'contains' | 'equals' | 'regex'
  dayIndexStart?: number
  dayIndexEnd?: number
  dayIndexList?: number[]
  filters?: ScopeFilters
  effective: {
    isWorkingDay: boolean
    label?: string
    source: 'org' | 'group' | 'role' | 'user'
  }
}

interface ScopeFilters {
  userIds?: string[]
  userNames?: string[]
  excludeUserIds?: string[]
  excludeUserNames?: string[]
  attendanceGroups?: string[]
  roles?: string[]
  roleTags?: string[]
}
```

Boundary against `holidayPolicy.overrides[]`:

| Setting | Semantics | Example |
| --- | --- | --- |
| `calendarPolicy.overrides[]` | Date-level effective workday and display source | Production group works only 3 of 5 national holiday days. |
| `holidayPolicy.overrides[]` | Work/payroll metric behavior on holiday days | Holiday first day counts as 8 hours, overtime approval adds time. |

Do not extend `holidayPolicy.overrides[]` with `dateOverride`. That would mix calendar validity with payroll calculation and create two admin surfaces for the same date.

### 2.3 Shared Scope Matching

Extract the scope matching part of `matchHolidayOverrideFilters` into a shared helper:

```ts
function matchScopeFilters(filters: ScopeFilters | null | undefined, context: ScopeContext): boolean
```

`matchScopeFilters(filters, context)` and day-index matching MUST share one predicate each. Both `holidayPolicy.*` and `calendarPolicy.*` resolvers MUST call those predicates directly. No duplicate scope or day-index implementations are allowed.

## 3. Holiday Sync Contract

### 3.1 Writer Rule

`/api/attendance/holidays/sync` writes only `origin = 'national'` rows.

Recommended SQL shape:

```sql
INSERT INTO attendance_holidays
  (id, org_id, holiday_date, name, is_working_day, origin)
VALUES ...
ON CONFLICT (org_id, holiday_date) DO UPDATE
SET name = EXCLUDED.name,
    is_working_day = EXCLUDED.is_working_day,
    origin = 'national',
    updated_at = now()
WHERE attendance_holidays.origin = 'national'
RETURNING holiday_date;
```

For `overwrite = false`, use `ON CONFLICT (org_id, holiday_date) DO NOTHING`.

Important counter semantics:

- `totalApplied`: actual inserted or updated `national` rows returned by SQL.
- `totalSkipped`: fetched rows skipped because `overwrite = false` prevented an update.
- `totalIgnored`: fetched rows ignored because a conflicting `manual` base row already exists and must be protected.
- `manual` conflicts must not be counted as applied.
- Admin response, year-level `results[]`, and `holidaySync.lastRun` should expose `totalApplied`, `totalSkipped`, and `totalIgnored` once the runtime slice adds them.

Implementation note: distinguishing `totalIgnored` from `totalSkipped` requires a pre-pass query over conflicting dates. `RETURNING` from the upsert is sufficient for `totalApplied`, but it cannot identify manual rows filtered by `WHERE attendance_holidays.origin = 'national'`.

```sql
SELECT holiday_date, origin
FROM attendance_holidays
WHERE org_id = $1
  AND holiday_date = ANY($2::date[]);
```

Use that pre-pass to classify existing manual conflicts before the insert/upsert. Then derive:

- `totalIgnored`: incoming rows whose date already has `origin = 'manual'`.
- `totalSkipped`: incoming rows not applied because `overwrite = false` and the existing row is not ignored.
- `totalApplied`: rows returned by the insert/upsert.

Forward-compatible `holidaySync.lastRun` shape:

```ts
interface HolidaySyncLastRun {
  ranAt?: string
  success?: boolean
  years?: number[]
  totalFetched?: number
  totalApplied?: number
  totalSkipped?: number
  totalIgnored?: number
  error?: string | null
}
```

### 3.2 Required Sync Tests

The migration/runtime PR for `origin` must include these integration cases:

| Case | Setup | Expected |
| --- | --- | --- |
| Empty table sync | No row for synced dates. | Inserts all rows with `origin = 'national'`; applied equals synced count. |
| National row update | Existing `origin = 'national'` row on same date, incoming name or `isWorkingDay` changes, `overwrite = true`. | Row updates and remains `origin = 'national'`; applied increments. |
| Manual row conflict | Existing `origin = 'manual'` row on same date, `overwrite = true`. | Manual row is unchanged; sync does not error; ignored increments; applied does not increment. |
| Manual deleted then sync | Existing manual row is deleted, then same date appears in sync. | New `origin = 'national'` row is inserted. |
| `overwrite = false` | Existing national row on same date, incoming data changes. | Old national row remains unchanged; applied does not increment; skipped increments. |
| Backfill/default | Historical row exists before migration; admin creates a new row after migration; sync sees same dates. | Historical and admin rows are `manual`; sync never downgrades them to `national`. |

## 4. EffectiveCalendarResolver

### 4.1 Inputs

```ts
interface EffectiveCalendarInput {
  orgId: string
  from: string
  to: string
  userId?: string
  groupId?: string
  orgOnly?: boolean
}
```

Mode rules:

| Mode | Resolves | Does not resolve |
| --- | --- | --- |
| `userId` | Base holidays, org/group/role/user calendar policies, rotation/shift/default working days, personal request overlays. | Other users' overlays. |
| `groupId` | Base holidays and group-level calendar policies. | User-bound rotation/shift assignment and personal overlays. |
| `orgOnly=true` | Base holidays and org-level calendar policies. | Group/role/user filters, rotation/shift assignment, personal overlays. |

Requests must provide exactly one mode: `userId`, `groupId`, or `orgOnly=true`.

### 4.2 Layer Order

For each date:

1. Resolve base workday from rotation shift, shift assignment, or default rule when `userId` is provided.
2. Apply `attendance_holidays` base row when present.
   - `origin = 'national'` yields source `national`.
   - `origin = 'manual'` yields source `manual`.
3. Apply matched `calendarPolicy.overrides[]` in deterministic order.
   - Recommended source priority: `org`, then `group`, then `role`, then `user`.
   - Later, more specific layers may override `effective.isWorkingDay`.
4. Add personal overlays without merging them into effective workday.

### 4.3 Time Zone Rule

Holiday dates are date-only. Rotation and shift rules can carry a time zone. Effective-calendar date interpretation should use:

```text
rotation.shift.timezone -> shift.timezone -> rule.timezone -> org/default timezone
```

Cross-time-zone employees are not automatically converted to a different holiday date. The resolver evaluates the date in the user/group context time zone selected by the chain above.

### 4.4 Output Shape

```ts
interface EffectiveCalendarDay {
  date: string
  base: {
    isWorkingDay: boolean
    source: 'rule' | 'shift' | 'rotation' | 'national' | 'manual'
    holidayId?: string
    name?: string
  }
  effective: {
    isWorkingDay: boolean
    source: 'national' | 'manual' | 'org' | 'group' | 'role' | 'user' | 'rule' | 'shift' | 'rotation'
    label?: string
    policyId?: string
  }
  layers: Array<{
    kind: 'base_rule' | 'holiday' | 'calendar_policy'
    source: 'rule' | 'shift' | 'rotation' | 'national' | 'manual' | 'org' | 'group' | 'role' | 'user'
    isWorkingDay: boolean
    label?: string
    refId?: string
  }>
  overlays: EffectiveCalendarOverlay[]
}

interface EffectiveCalendarOverlay {
  kind: 'personal_leave' | 'overtime' | 'attendance_correction' | 'business_trip' | 'training'
  source: 'attendance_requests' | 'attendance_records' | 'reserved'
  requestType?: 'leave' | 'overtime' | 'missed_check_in' | 'missed_check_out' | 'time_correction'
  minutes?: number
  status?: string
  label?: string
  refId?: string
}
```

`base.source` is the holiday row `origin` when an `attendance_holidays` row exists; otherwise it is the profile source selected from rotation, shift assignment, or rule. `effective.policyId` is the matched `CalendarPolicyOverride.id`; it is absent when the effective result comes from the base layer.

Overlay source mapping:

| Overlay kind | Source | Current status |
| --- | --- | --- |
| `personal_leave` | Approved `attendance_requests` with `request_type = 'leave'` | Implementable in read-only resolver. |
| `overtime` | Approved `attendance_requests` with `request_type = 'overtime'` | Implementable in read-only resolver. |
| `attendance_correction` | Approved `attendance_requests` with `missed_check_in`, `missed_check_out`, or `time_correction` | Implementable in read-only resolver if the UI wants correction markers. |
| `business_trip` | `attendance_records` report/meta minutes such as `business_trip_minutes` | Reserved for a later record-backed overlay. Do not add `business_trip` to `attendance_requests.request_type`. |
| `training` | No current source | Reserved only. Requires a new source before implementation. |

Overlays are additive:

- Do not merge, offset, or resolve conflicts between overlays in the backend.
- Return all overlays for the day.
- Sort deterministically by `date`, then `createdAt`, then `id`; where no `createdAt` exists, use stable source priority plus `id`.
- UI owns combined display such as "4h leave + 3h overtime".

## 5. HTTP API Contract

Add a read-only endpoint in the resolver slice:

```text
GET /api/attendance/effective-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&userId=...
GET /api/attendance/effective-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&groupId=...
GET /api/attendance/effective-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&orgOnly=true
```

Response:

```json
{
  "ok": true,
  "data": {
    "mode": "user",
    "from": "2026-10-01",
    "to": "2026-10-07",
    "timezone": "Asia/Shanghai",
    "items": [
      {
        "date": "2026-10-01",
        "base": { "isWorkingDay": false, "source": "national", "name": "国庆节" },
        "effective": { "isWorkingDay": false, "source": "national", "label": "国庆节" },
        "layers": [
          { "kind": "holiday", "source": "national", "isWorkingDay": false, "label": "国庆节" }
        ],
        "overlays": []
      }
    ]
  }
}
```

Validation:

- `from` and `to` are required and must be valid date-only values.
- Enforce a bounded range, for example 366 days max.
- Exactly one mode must be selected.
- `userId` mode requires access to the target user.
- `groupId` mode requires attendance admin permission.
- `orgOnly` mode requires attendance read/admin permission according to existing route conventions.
- Writes to `settings.calendarPolicy.overrides[]` require `attendance:admin`, matching other attendance settings writes.

Performance note: Step 3 resolves per-user-per-day calendar data for monthly UI ranges in real time. Batch use cases such as more than 500 users over monthly ranges should be treated as Phase 2 materialization/cache work, not as part of the read-only endpoint slice.

## 6. Regression Contract Tests

### 6.1 Read-Only Equivalence

The resolver slice must prove it does not drift from current calculation in the baseline case:

> For any `userId` and date without `calendarPolicy.overrides[]` and without personal overlay, `effectiveCalendar.items[n].effective.isWorkingDay` must equal `resolveWorkContext(...).isWorkingDay`.

Required matrix:

| Case | Expected equivalence |
| --- | --- |
| Default rule working day | Resolver equals `resolveWorkContext`. |
| Default rule rest day | Resolver equals `resolveWorkContext`. |
| Shift assignment overrides default rule | Resolver equals `resolveWorkContext`. |
| Rotation shift overrides default rule | Resolver equals `resolveWorkContext`. |
| National/manual holiday row overrides profile working day | Resolver equals `resolveWorkContext`. |
| Working-day override holiday row overrides profile rest day | Resolver equals `resolveWorkContext`. |

### 6.2 Calendar Policy Tests

| Case | Expected |
| --- | --- |
| Org policy changes a national holiday to working day | `effective.source = 'org'`; base remains `national`. |
| Group policy applies to production group only | Production effective differs; sales group remains base. |
| Role policy applies by role/roleTags | Matching role changes; non-matching role does not. |
| User policy overrides group policy | `effective.source = 'user'`; layer chain includes both entries. |
| Day-index policy applies only to listed holiday day index | Matching day changes; adjacent day does not. |

### 6.3 Overlay Tests

| Case | Expected |
| --- | --- |
| Approved leave request | Adds `personal_leave` overlay from `attendance_requests`; does not change effective workday. |
| Approved overtime request | Adds `overtime` overlay from `attendance_requests`; does not change effective workday. |
| Correction request | Adds `attendance_correction` overlay if included in UI contract. |
| Leave and overtime on same date | Returns two overlays in deterministic order; backend does not merge. |

## 7. Implementation Plan

| Step | Content | Lane | Shape | Merge dependency |
| --- | --- | --- | --- | --- |
| 1 | RFC | docs | This docs-only PR | None |
| 2 | `attendance_holidays.origin` column, sync `ON CONFLICT` protection, counters, and sync test matrix | runtime | Migration + plugin sync writer + integration tests | After RFC review |
| 3 | `settings.calendarPolicy.overrides[]`, `matchScopeFilters`, `EffectiveCalendarResolver`, and read-only `/effective-calendar` API | runtime | Backend service/route/tests | After Step 2 because resolver reads `origin` |
| 4 | Frontend consumers use effective calendar | frontend | Type expansion, calendar colors, layer-chain tooltip in multitable Calendar view (`apps/web/src/multitable/components/MetaCalendarView.vue`), attendance calendar (`apps/web/src/views/AttendanceView.vue`), and holiday admin calendar (`apps/web/src/views/attendance/AttendanceHolidayDataSection.vue`) | Can start with Step 3 mock contract; merge after Step 3 lands |
| 5 | Calculation-chain cutover | runtime | `resolveWorkContext`/prefetch path uses resolver; `attendance_records.is_workday` remains materialized from resolver | Last, after read-only path proves stable |

Step 5 is intentionally last. Payroll/import/auto-absence should keep current `resolveWorkContext` behavior until the read-only resolver has contract coverage and frontend exposure.

## 8. Phase 2 Cutover Plan

When Step 5 starts:

1. Keep `attendance_records.is_workday` as materialized output.
2. Route both `resolveWorkContext` and `resolveWorkContextFromPrefetch` through a shared effective-calendar core for the holiday/calendar-policy branch.
3. Preserve current no-policy equivalence tests from Step 3.
4. Add payroll/import tests that prove metrics remain unchanged when no `calendarPolicy` is configured.
5. Add explicit tests where `calendarPolicy` changes `isWorkingDay`, then confirm import/payroll/auto-absence all observe the same result.

Do not cut over payroll calculation in the same PR that introduces `calendarPolicy`.

## 9. Non-Goals

- No `business_trip` request type.
- No `training` overlay implementation before a real data source exists.
- No multi-row holiday base table or changed `(org_id, holiday_date)` uniqueness.
- No calc-chain cutover in the read-only resolver slice.
- No direct multitable read/write of `attendance_*` facts from calendar UI.
- No change to current holiday-policy payroll semantics.
