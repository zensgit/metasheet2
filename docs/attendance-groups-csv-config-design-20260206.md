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

## Why This Matters

- Prevents hidden runtime 500s in common CSV import cases.
- Ensures the three core features are covered by automated integration checks, not only manual UI steps.
- Reduces regressions when rule-template and import logic evolve.

