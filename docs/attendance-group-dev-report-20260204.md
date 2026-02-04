# Attendance Groups - Dev Report

Date: 2026-02-04

## Scope
- Add Attendance Group data model + admin APIs.
- Add Attendance Group management UI (create/edit/delete, bind rule set).
- Expose group names to holiday override filters for better operator feedback.

## Changes
- Backend
  - Migration: `packages/core-backend/src/db/migrations/zzzz20260204123000_create_attendance_groups.ts`
    - `attendance_groups`
    - `attendance_group_members`
  - Attendance plugin routes:
    - `GET /api/attendance/groups`
    - `POST /api/attendance/groups`
    - `PUT /api/attendance/groups/:id`
    - `DELETE /api/attendance/groups/:id`
- Frontend
  - `apps/web/src/views/AttendanceView.vue`
    - New “Attendance groups” admin section
    - Group form (name/code/timezone/rule set/description)
    - Group list table (edit/delete)
    - Override hint: known attendance groups displayed

## Notes
- The group CRUD is independent from import pipelines; CSV imports can still pass `attendance_group` for rule/override matching.
- Group-to-user assignment is tracked in DB but not exposed in UI yet.
- Rule set binding is stored on the group record; future logic can use it to auto-select rule sets during imports.
