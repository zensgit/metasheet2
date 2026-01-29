# Attendance Framework Final Development Report (2026-01-28)

## Overview
Delivered a reusable attendance framework layer with rule sets, payroll cycles, DingTalk mapping scaffolding, admin UI management, and exports. This builds a **generic platform** that can host business modules like Attendance or PLM/ECO consistently.

## Key Capabilities
### 1) Rule Sets & Configuration
- Rule-set CRUD with JSON config and validation.
- Template endpoint for DingTalk mapping scaffolds.
- Rule-set preview using scheduling context (rules/shifts/rotation/holiday).

### 2) Payroll Cycles
- Payroll templates (supports cross-month cycles, e.g., 25 → next month 6).
- Payroll cycles (manual or template-based + anchor date).
- Payroll cycle summary JSON + CSV export.

### 3) Rule Engine v1 Enhancements
- Status impact from approved leave/overtime.
- Summary includes leave/overtime minutes + late/early minutes.
- Records list enriched with leave/overtime minutes.
- **Policy engine (configurable)**: rule-set `policies` allow org-specific overrides (role/shift/holiday/field-based).
- Import preview/import can now apply policies and surface warnings.
- Policy template added: `docs/attendance-dingtalk-policies-template.json`.
- Rule-set config sample added: `docs/attendance-dingtalk-rule-set-config.json`.
- Policy DSL extended with numeric comparisons and additive actions (see `docs/attendance-rule-dsl-spec-20260128.md`).
- Status normalization supports prefix matching via `statusMap` (see `docs/attendance-status-map-20260129.json`, expanded for leave/travel cases).

### 4) Admin UI
- Rule sets, payroll templates, payroll cycles management.
- Summary load + CSV export.
- Records table now shows leave/overtime minutes.

### 5) Data Import (DingTalk / Manual)
- Import template endpoint + preview/import APIs.
- Import UI section with JSON payload editor and preview.
- Supports rule-set mapping + basic status normalization.
- Policy evaluation runs during preview/import (warnings + applied policies surfaced).
- Added DingTalk CSV -> import payload script (`scripts/attendance/dingtalk-csv-to-import.mjs`) with BOM handling, date-range filters, and userId mapping.
- Expanded DingTalk CSV column alias map to cover all exported columns: `docs/dingtalk-columns-alias-20260128.json`.
- Added statusMap payload support in CSV import script (`--status-map`).
- Added status normalization option for long `attend_result` strings (`--normalize-status`).
- Merged DingTalk column-value samples into `docs/dingtalk-column-vals-merged-20260128.json` for reference.

### 6) OpenAPI + Tests
- Schemas and endpoints updated for new attendance framework APIs.
- Integration test extended for new endpoints.

## Major Endpoints Added
- `/api/attendance/rule-sets`
- `/api/attendance/rule-sets/template`
- `/api/attendance/rule-sets/preview`
- `/api/attendance/import/template`
- `/api/attendance/import/preview`
- `/api/attendance/import`
- `/api/attendance/payroll-templates`
- `/api/attendance/payroll-cycles`
- `/api/attendance/payroll-cycles/:id/summary`
- `/api/attendance/payroll-cycles/:id/summary/export`

## Files Updated
- Backend
  - `plugins/plugin-attendance/index.cjs`
  - `packages/core-backend/src/db/migrations/zzzz20260128120000_create_attendance_rule_sets_and_payroll.ts`
  - `packages/core-backend/src/db/types.ts`
  - `packages/core-backend/tests/integration/attendance-plugin.test.ts`
- Frontend
- `apps/web/src/views/AttendanceView.vue`
- OpenAPI
  - `packages/openapi/src/base.yml`
  - `packages/openapi/src/paths/attendance.yml`
- Docs
  - `docs/attendance-rule-dsl-spec-20260128.md`
  - `docs/attendance-rule-split-matrix-20260128.md`
  - `docs/framework-business-carrier-20260128.md`
  - `docs/dingtalk-column-vals-merged-20260128.json`

## Notes
- Record-level leave/overtime minutes are computed on read via a batch query per date range.
- Rule-set preview uses rule/shift/holiday context but does not yet apply complex break or overtime rules.
- Import now supports policy overrides via rule-set config; complex overtime/leave logic should be encoded in policy rules.

## Recommended Next Steps
- Add per-day leave/overtime impact on work minutes if required by payroll rules.
- Implement visual mapping validator UI (field mapping hints + validation results).
- Run integration tests once DB is available.
- Expand import to persist raw source metadata if needed.
