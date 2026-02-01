# Attendance Framework Development Report (2026-02-01)

## Summary
Expanded the attendance framework with a shared rule-template library, payroll cycle auto-generation, and standardized import profiles plus missing-field safeguards.

## Delivery by Day
### Day 1 — Inventory + Plan
- Added 7-day plan and gap list.
- File: `docs/attendance-framework-7day-plan-20260201.md`

### Day 2 — Rule framework + templates
- Added engine template param schema validation.
- Enforced rule-set engine config validation on create/update (with error details).
- Files:
  - `plugins/plugin-attendance/engine/schema.cjs`
  - `plugins/plugin-attendance/index.cjs`

### Day 3 — Import/mapping pipeline
- Merged userMap profile fields into import evaluation (attendanceGroup/department/role/roleTags/etc).
- Enhanced value resolver to fall back to user profiles when row fields are missing.
- Updated import template example to show profile usage.
- File: `plugins/plugin-attendance/index.cjs`

### Day 4 — Payroll cycles
- Auto-corrected cross-month cycles when endDay < startDay.
- Allowed payroll cycles to resolve from default template if templateId missing but anchorDate provided.
- Enabled anchorDate-based recompute on cycle update.
- File: `plugins/plugin-attendance/index.cjs`

### Day 5 — Admin UI
- Import preview now shows User column and uses unique key (userId + workDate).
- Added hint text for supported userMap profile fields.
- File: `apps/web/src/views/AttendanceView.vue`

### Day 6 — Template library + payroll generation + import standardization
- Added org-level rule-template library endpoints and cache; system templates + library merged in rule-set template response.
- UI now supports template library (list/apply/delete) and “save custom template to library”.
- Added payroll cycle generation endpoint (template + anchor + count) and UI generator.
- Import template now exposes mapping profiles; preview/commit skip rows missing userId/workDate and record skipped rows in batch meta.
- Files:
  - `plugins/plugin-attendance/index.cjs`
  - `apps/web/src/views/AttendanceView.vue`

## Git Commits
- `docs(attendance): add 7-day framework plan`
- `feat(attendance): validate rule set engine config`
- `feat(attendance): merge user profile into import`
- `feat(attendance): improve payroll cycle resolution`
- `feat(attendance): improve import preview UI`
- `chore(attendance): add template library + payroll generator + import profiles`
