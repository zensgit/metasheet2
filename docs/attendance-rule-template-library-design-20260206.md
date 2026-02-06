# Attendance Rule Template Library (Design)

## Goal
Provide a built-in, user-configurable template library for attendance rules so admins can start from system templates, customize them, and persist a reusable library. The library is versioned with rollback support.

## Scope
- Frontend admin UX to view system templates, edit a library JSON, validate schema, and save.
- Backend endpoints to read/save/restore the library.
- Version history with rollback.

## UI/UX
Location: Attendance admin console → after “Rule Sets” and before “Attendance groups”.

Components:
- **System templates (read-only)** text area
- **Library templates (JSON)** text area
- **Template versions** table with Restore action
- Actions
  - `Reload templates`
  - `Copy system to library`
  - `Save library`

## Data Flow
- `GET /api/attendance/rule-templates`
  - Response:
    - `data.system` array
    - `data.library` array
    - `data.versions` array (metadata only)
- `PUT /api/attendance/rule-templates`
  - Payload: `{ templates: [...] }`
  - Creates a new version snapshot.
- `POST /api/attendance/rule-templates/restore`
  - Payload: `{ versionId }`
  - Restores a previous version and creates a new version snapshot.

## Validation
Frontend schema validation ensures:
- each template has `name` (string)
- `rules` is an array of objects
- `params` (if present) is an array of objects with `key`

If validation fails, the UI shows the first few errors in the status banner.

## Versioning & Rollback
- Versions stored in `attendance_rule_template_versions` with:
  - `org_id`, `version`, `templates`, `created_at`, `created_by`, `source_version_id`
- Restore uses the selected version’s templates and records a new version.

## File References
- `apps/web/src/views/AttendanceView.vue`
- `plugins/plugin-attendance/index.cjs`
- `packages/core-backend/migrations/056_create_attendance_rule_template_versions.sql`
