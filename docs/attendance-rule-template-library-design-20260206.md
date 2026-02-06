# Attendance Rule Template Library (Design)

## Goal
Provide a built-in, user-configurable template library for attendance rules so admins can start from system templates, customize them, and persist a reusable library without editing JSON directly on the backend.

## Scope
- Frontend admin UX to view system templates, edit a library JSON, and save.
- Reuse existing backend endpoint `/api/attendance/rule-templates` (GET/PUT).
- Keep changes additive and isolated to the attendance admin area.

## UI/UX
Location: Attendance admin console → after “Rule Sets” and before “Attendance groups”.

Components:
- **System templates (read-only)** text area
- **Library templates (JSON)** text area
- Actions
  - `Reload templates`
  - `Copy system to library`
  - `Save library`

## Data Flow
- `loadRuleTemplates()` calls `GET /api/attendance/rule-templates`.
  - Expected response:
    - `data.system` array
    - `data.library` array
- `saveRuleTemplates()` calls `PUT /api/attendance/rule-templates` with payload:
  - `{ templates: [...] }`

## Parsing / Validation
`parseTemplateLibrary()` accepts:
- JSON array
- Object with `templates` or `library` arrays
- Fails (returns null) if JSON is invalid or not array-like

On failure, UI shows status message: `Template library must be valid JSON array`.

## UX Safeguards
- Library text is stored separately from system templates to prevent accidental edits.
- Copy action lets admins bootstrap quickly from system templates.
- All actions show loading state and surface errors via existing status banner.

## File References
- `apps/web/src/views/AttendanceView.vue`
