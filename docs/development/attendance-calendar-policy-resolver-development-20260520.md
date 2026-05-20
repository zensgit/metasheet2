# Attendance Calendar Policy Resolver — Development Notes

Date: 2026-05-20
Branch: `runtime/attendance-calendar-policy-resolver-20260520`
Base: `origin/main@f8b9a5f2e`
Implements: RFC v3 (`docs/development/attendance-effective-calendar-rfc-20260520.md`)
Builds on: Step 2 PR #1698 (`12918362f`) which added `attendance_holidays.origin`.

## Scope

Step 3 of the effective-calendar slice. Read-only resolver that composes a
multi-layer calendar without touching the existing calculation chain
(`resolveWorkContext` / payroll / import / auto-absence). The cutover is Step 5.

Delivered:

- Shared `matchScopeFilters` and `matchDayIndexFilter` predicates (single source
  of truth for both `holidayPolicy.overrides[]` and `calendarPolicy.overrides[]`).
- `settings.calendarPolicy.overrides[]` schema + normalize + merge + zod.
- `EffectiveCalendarResolver` + `GET /api/attendance/effective-calendar` (read-only).
- Integration tests covering RFC §6.1/§6.2/§6.3 + RBAC + validation.

Not delivered (intentionally, per RFC §7 step 5):

- `resolveWorkContext` cutover. Payroll/import/auto-absence still use the
  pre-existing hard-override behavior.
- Materialization or batch resolver. Step 3 resolves per-user-per-day in real
  time; batch use cases (>500 users × monthly) are Phase 2.

## Key Code Anchors

| Concern | File:line (post-change) |
| --- | --- |
| Shared `matchDayIndexFilter` predicate | `plugins/plugin-attendance/index.cjs` near `matchHolidayOverrideFilters` (~8327) |
| Shared `matchScopeFilters` predicate (supports import `attendanceGroup` single-value + resolver `attendanceGroups` array; both paths use `matchListValue` so case/whitespace normalization is symmetric between import and resolver) | `plugins/plugin-attendance/index.cjs` next to `matchDayIndexFilter` |
| `matchHolidayOverrideFilters` refactor (now delegates to both shared predicates; behavior preserved) | `plugins/plugin-attendance/index.cjs` near 8327 |
| `DEFAULT_SETTINGS.calendarPolicy` | `plugins/plugin-attendance/index.cjs` near 57 |
| `normalizeCalendarPolicyOverrides` (drops invalid entries; generates `randomUUID()` for missing `id`) | `plugins/plugin-attendance/index.cjs` after `normalizeHolidayPolicyOverrides` |
| `normalizeSettings` wiring of `calendarPolicy` | `plugins/plugin-attendance/index.cjs` inside `normalizeSettings` |
| `mergeSettings` `calendarPolicy` branch | `plugins/plugin-attendance/index.cjs` inside `mergeSettings` |
| Zod `settingsSchema.calendarPolicy` | `plugins/plugin-attendance/index.cjs` next to `holidayPolicy` zod (~12050) |
| `resolveEffectiveCalendar` + `matchCalendarOverride` + `loadApprovedRequestsForOverlay` + `loadAttendanceScopeContextForUser` + `loadAttendanceGroupByIdOrCode` + helpers | `plugins/plugin-attendance/index.cjs` after `loadRotationAssignmentMapForUsersRange` |
| Route `GET /api/attendance/effective-calendar` | `plugins/plugin-attendance/index.cjs` just before holidays GET (~24131) |
| Integration tests (4 cases) | `packages/core-backend/tests/integration/attendance-plugin.test.ts` (appended at end of describe) |

## Design Pins

### Source priority (RFC §4.2)

```
base layers:    rule = shift = rotation = national = manual = 0
policy layers:  org = 1 < group = 2 < role = 3 < user = 4
```

Higher numeric priority wins. Equal priority: later array index of
`settings.calendarPolicy.overrides[]` wins (declaration-order tie-breaker).
Documented so that admin UI can promise stable behavior when two same-source
overrides target the same date.

### Mode → allowed sources

| Mode | Allowed `effective.source` | Profile (base) | Overlays |
| --- | --- | --- | --- |
| `userId` | `org` / `group` / `role` / `user` | `rotation.shift` ?? `shift.assignment` ?? `defaultRule` | `personal_leave` / `overtime` / `attendance_correction` from `attendance_requests` (approved) |
| `groupId` | `group` only | `defaultRule` | none |
| `orgOnly` | `org` only | `defaultRule` | none |

`groupId` does **not** apply org-level overrides; this is the strict reading
of RFC §4.1 (mode resolves only group-level policies on top of base holidays).

### Time-zone chain (RFC §4.3)

```
rotation.timezone -> shift.timezone -> defaultRule.timezone -> group.timezone -> 'UTC'
```

Date-only holidays are not auto-converted across timezones.

### Normalize semantics

`normalizeCalendarPolicyOverrides` is intentionally **silent-drop** (no thrown
error) for invalid raw entries:

- No constraint provided (must declare at least one of `date` / `from`+`to` /
  `name` / `dayIndex*`).
- Missing or non-boolean `effective.isWorkingDay`.
- `effective.source = 'group'` without non-empty `filters.attendanceGroups`.
- `effective.source = 'role'` without non-empty `filters.roles` or
  `filters.roleTags`.
- `effective.source = 'user'` without non-empty `filters.userIds` or
  `filters.userNames`.

Each surviving override is assigned `id: randomUUID()` if missing. Once
persisted, the id is stable across reads (`normalize` preserves existing `id`).

## Known Limitations (v1)

1. **`role` / `roleTags` filters do not fire in resolver mode.** The current DB
   schema has no attendance-scoped user profile table that backs role /
   roleTags. `buildHolidayPolicyContext` populates them from import rows /
   profileSnapshots; the resolver has no equivalent source. `calendarPolicy.overrides[]`
   with `effective.source = 'role'` remain **valid config** (normalize keeps
   them) but `effective-calendar` will not match them. The filter remains useful
   for `holidayPolicy.overrides[]` in payroll/import paths. The integration
   test `role/roleTags override is valid config but silently inert in resolver
   mode` guards this contract so a future "role context" loader does not
   silently begin firing without a deliberate decision.
2. **`groupId` mode does not apply group `rule_set` working days.** Base
   profile is the org's `attendance_rules` default rule. `attendance_groups.rule_set_id`
   is ignored by the v1 resolver. Document for future Step 5 or a separate slice.
3. **Performance.** Per-user-per-day resolution executed in real time. For
   batch reports over >500 users × monthly ranges, plan a cache/materialization
   slice (Phase 2). The route bounds inclusive range to ≤ 366 days.

## Overlay Mapping

| `attendance_requests.request_type` | Overlay `kind` | Overlay `source` |
| --- | --- | --- |
| `leave` | `personal_leave` | `attendance_requests` |
| `overtime` | `overtime` | `attendance_requests` |
| `missed_check_in` / `missed_check_out` / `time_correction` | `attendance_correction` | `attendance_requests` |

`business_trip` and `training` are reserved per RFC §4.4; not implemented
because there is no current data source in `attendance_requests.request_type`
(business trip lives in `attendance_records` report fields; training has no
source yet). Implementing either requires its own slice and is out of scope.

## API Surface

```
GET /api/attendance/effective-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&userId=...
GET /api/attendance/effective-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&groupId=...
GET /api/attendance/effective-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&orgOnly=true
```

- `from` / `to` are **required**; missing or invalid → 400.
- Range > 366 days → 400.
- Exactly one mode must be provided → 400 otherwise.
- `userId` mode: requester must be self **or** have `attendance:approve` /
  `attendance:admin` (resolved by `canAccessOtherUsers`).
- `groupId` mode: requires `attendance:admin`.
- `orgOnly` mode: only requires the outer `attendance:read` gate.
- `groupId` that does not exist → 404.

Response shape conforms to RFC §4.4 (`mode` / `from` / `to` / `timezone` /
`items[]` with `base` / `effective` / `layers[]` / `overlays[]`).

`PUT /api/attendance/settings` accepts `calendarPolicy` via the existing
settings update path; `mergeSettings` was extended so a partial PATCH does not
shallow-merge away nested overrides arrays.

## Holiday Sync Boundary

This slice does not change `attendance_holidays.origin` semantics or
`/api/attendance/holidays/sync`. Manual rows remain protected per Step 2;
calendarPolicy overrides live in settings, not in `attendance_holidays`.
