# Attendance Groups + CSV + Config Design Update (2026-02-06)

## Scope

This update focuses on validating and hardening the three agreed capabilities:

1. Attendance groups (`/api/attendance/groups` + member management)
2. CSV import path with group sync (`groupSync.autoCreate` / `groupSync.autoAssignMembers`)
3. Default + user-configurable rule template library (`/api/attendance/rule-templates`, restore by version)

## What Was Added

### 1) Integration coverage expansion

`packages/core-backend/tests/integration/attendance-plugin.test.ts` now additionally verifies:

- attendance group create/list/member APIs
- CSV import with `groupSync.autoCreate=true` and `groupSync.autoAssignMembers=true`
- automatic group creation from CSV `考勤组` field
- auto member assignment into created group
- rule-template library save/save/restore flow
- template version restore by `versionId`

### 2) Bug fix found during coverage

In `plugins/plugin-attendance/index.cjs`, `ensureAttendanceGroups()` used:

- `timezone = options?.timezone ?? null`

When `groupSync.autoCreate` is enabled and no timezone is provided, this inserted `NULL` into `attendance_groups.timezone` (NOT NULL), causing import failure (500).

Fixed to:

- `timezone = options?.timezone ?? DEFAULT_RULE.timezone`

This aligns behavior with table constraints and expected default semantics.

### 3) Import template + UI hardening (ruleSetId placeholder)

During UI acceptance, `POST /api/attendance/import/preview` could fail with a validation error when the template payload contained:

- `ruleSetId: "<ruleSetId>"`

Because the API validates `ruleSetId` as a UUID, the placeholder must never be sent as-is.

Fixes:

- Backend (`plugins/plugin-attendance/index.cjs`): template `payloadExample` is now valid out-of-the-box:
  - `ruleSetId` removed (optional; set via UI when needed)
  - `entries: []` and `userMap: {}` to avoid accidentally importing demo rows
- Frontend (`apps/web/src/views/AttendanceView.vue`): `buildImportPayload()` now:
  - always honors the rule-set selector (overrides any existing `payload.ruleSetId`)
  - deletes invalid `payload.ruleSetId` strings when no rule set is selected
- Integration (`packages/core-backend/tests/integration/attendance-plugin.test.ts`): asserts template payload does not ship invalid placeholder UUIDs.

## Why This Matters

- Prevents hidden runtime 500s in common CSV import cases.
- Ensures the three core features are covered by automated integration checks, not only manual UI steps.
- Reduces regressions when rule-template and import logic evolve.

## Remote Runtime Gap Identified

During remote acceptance against `http://142.171.239.56:8081`:

- `groupSync.autoCreate=true` without timezone still returns `500` on `/api/attendance/import`.
- The same payload passes when adding `groupSync.timezone = "Asia/Shanghai"`.

This indicates deployed runtime has not fully aligned with the local fix:

- expected: fallback to `DEFAULT_RULE.timezone`
- observed: still requires explicit timezone to avoid insert failure

## Verification Utility Improvement

To support reproducible UI acceptance evidence, `scripts/verify-attendance-import-ui.mjs` now supports:

- `UI_SCREENSHOT_PATH` (optional)

When provided, the script saves a full-page screenshot after record verification, enabling script-level proof for release checks.
