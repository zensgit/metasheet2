# Attendance Import: Groups + CSV + User Configuration (Design)

Date: 2026-02-05

## Goals
- Allow CSV imports to **auto-create attendance groups** and **auto-assign group members**.
- Accept **user map JSON** so CSVs with employee numbers can resolve to platform user IDs.
- Keep rules **default + user configurable** by tying group creation to rule sets and holiday override policies.

## Scope
- Frontend (Admin → Attendance → Import):
  - Add user map upload + key/source field inputs.
  - Add group sync options (auto-create, auto-assign, group rule set, timezone).
- Backend (Attendance plugin):
  - Extend import payload schema to accept `groupSync`.
  - Create group/membership sync helpers.
  - Attach group warnings + sync stats to preview/commit responses.

## Data Flow
1. **Admin uploads CSV** (DingTalk daily summary) and optionally **user map JSON**.
2. UI builds payload:
   - `csvText` + `csvOptions`
   - `userMap` (resolved from JSON)
   - `userMapKeyField` + `userMapSourceFields`
   - `groupSync` options
3. Backend:
   - Parses CSV rows → `workDate`, `fields`.
   - Resolves `userId` via `userMap`.
   - If `groupSync.autoCreate`, ensures missing groups exist.
   - If `groupSync.autoAssignMembers`, writes `attendance_group_members`.
   - Applies rule-set resolution via group mapping.

## Payload Additions
```json
{
  "groupSync": {
    "autoCreate": true,
    "autoAssignMembers": true,
    "ruleSetId": "<optional-rule-set-id>",
    "timezone": "Asia/Shanghai"
  },
  "userMap": {
    "A001": { "userId": "...", "empNo": "A001" }
  },
  "userMapKeyField": "工号",
  "userMapSourceFields": ["empNo", "工号", "姓名"]
}
```

## Rule Configuration (Default + Custom)
- Default rule templates remain under the attendance engine template library.
- **User config** lives in:
  - Rule sets (`/api/attendance/rule-sets`) for per-org policies.
  - Holiday overrides (Admin → Attendance → Settings) for holiday/day-index rules.
  - Group-specific filters in overrides: `attendanceGroups`, `roles`, `roleTags`, `userIds`.

### Example: Spring Festival Subsidy (6-day configurable)
Use **Holiday Overrides**:
- `name: 春节`, `match: contains`
- `dayIndexStart: 1`, `dayIndexEnd: 6`
- `firstDayBaseHours: 8` (or configurable)
- `attendanceGroups: 车间,仓储,食堂,保安` (custom list)
- `excludeUserNames`: specific exempted users
This keeps the “6-day” logic **configurable, not hard-coded**.

## Non-Goals
- No change to core punch logic or approval workflow.
- No UI for bulk role mapping beyond user map and group sync in this iteration.

## Files Updated
- `plugins/plugin-attendance/index.cjs`
- `apps/web/src/views/AttendanceView.vue`

