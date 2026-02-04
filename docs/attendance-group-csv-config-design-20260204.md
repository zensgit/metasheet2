# Attendance: Groups + CSV + Config (Design)

Date: 2026-02-04

## Goals
- Provide attendance **group management** (org → group → members).
- Support **CSV import** with DingTalk-style headers and field mapping.
- Allow **default + user-configurable rules** with automatic rule set selection.
- Keep import flow resilient via commit tokens and legacy fallback.

## Data Model
- `attendance_groups`
  - `id`, `org_id`, `name`, `code`, `timezone`, `rule_set_id`, `description`, timestamps
- `attendance_group_members`
  - `id`, `org_id`, `group_id`, `user_id`, timestamps
- `attendance_import_batches`
  - `id`, `org_id`, `source`, `status`, `rows`, timestamps
- `attendance_import_tokens`
  - `token`, `org_id`, `user_id`, `expires_at`, `created_at`

## Rule Resolution (per row)
1. If `ruleSetId` is provided in the import payload → use it.
2. Else if `attendance_group` / `考勤组` field is present and mapped → use the group's `rule_set_id`.
3. Else → fall back to the org default rule set.

## CSV Import Flow
1. **Prepare**
   - `POST /api/attendance/import/prepare`
   - Returns a commit token (persisted in DB).
2. **Preview**
   - `POST /api/attendance/import/preview`
   - Parses CSV, applies mapping, runs rule selection, returns preview rows.
3. **Commit**
   - `POST /api/attendance/import/commit`
   - Uses commit token (required if `ATTENDANCE_IMPORT_REQUIRE_TOKEN=1`).
4. **Fallback**
   - If commit endpoint or token is unavailable, UI can fall back to legacy `POST /api/attendance/import`.

### CSV Mapping Notes
- DingTalk CSV has metadata rows; `headerRowIndex: 2` is required.
- `attendance_group` / `考勤组` fields drive automatic rule selection.
- `csvOptions` supports delimiter, timezone, and header row controls.

## UI / Admin Console
- **Groups**: create/update/delete, bind `rule_set_id`.
- **Members**: add/remove user IDs per group.
- **Import**: prepare/preview/commit, batch history, item viewer, rollback.

## Config Defaults vs User Overrides
- **Defaults**: built-in rule templates and mappings.
- **User Config**: custom rule sets + group-level binding.
- **Per-import Overrides**: `ruleSetId`, `csvOptions`, `timezone` supplied in payload.

## Non-goals (for this phase)
- Full payroll calculation and settlement flows.
- External calendar/holiday sync (covered in separate docs).
