# Attendance Framework Final Report (2026-01-28)

## Scope
Build a reusable attendance framework (rule sets, payroll cycles, imports, policies) that supports business plugins (Attendance / PLM) while keeping org-specific rules configurable.

## Development Summary
- Rule set CRUD + JSON config + template scaffolds for DingTalk mapping.
- Policy engine (rule-set `policies`) for conditional overrides (user/group/shift/holiday/field-based) with warnings + applied policies surfaced in preview/import.
- Payroll templates and payroll cycles (supports跨月计薪周期，例如 25 → 次月 6).
- Import preview/import APIs + admin UI section; mapping hints for `plan_detail`, `attendance_class`, `attendance_approve`, `attendance_group`.
- Records + summary enrichment (leave/overtime minutes, status normalization).
- OpenAPI schema updates and integration test coverage for new endpoints.

## Verification Summary
### API / Server
- Import preview succeeded for 2 users; saved payload + server results.
- Import succeeded for 2 users (10 rows); summary saved.
- Records API returned 5 rows per user for 2025-12-01 → 2025-12-05.

### UI (MCP)
- `/attendance` loaded with admin token; admin sections visible.
- User `09141829115765` (2025-12-01 → 2025-12-05):
  - Summary: Total days 5, Total minutes 2400, Early leave 222.
  - Records: 5 rows, status `Early leave`.
- User `0613271732687725` (same range):
  - Summary: Total days 5, Total minutes 0, Absent 5.
  - Records: 5 rows, status `Absent`.
- Note: UI requires setting date range + User ID to match imported data.

## Artifacts
- Rule plan / configs:
  - `docs/attendance-dingtalk-rule-plan-20260128.md`
  - `docs/attendance-dingtalk-rule-set-config.json`
  - `docs/attendance-dingtalk-policies-template.json`
  - `docs/dingtalk-attendance-merged-20260128.json`
- Import payloads/results:
  - `docs/attendance-import-preview-payload.json`
  - `docs/attendance-import-preview-server-summary.json`
  - `docs/attendance-import-server-summary.json`
  - `docs/attendance-records-server-09141829115765.json`
  - `docs/attendance-records-server-0613271732687725.json`
- Verification report:
  - `docs/attendance-framework-final-verification-report-20260128.md`
- Development report:
  - `docs/attendance-framework-final-development-report-20260128.md`

## Not Run / Gaps
- Full integration suite (`pnpm --filter @metasheet/core-backend test:integration`) not executed.
- Policy preview/import UI smoke not re-run after latest policy changes (API was validated).

## Recommended Next Steps
- Add per-day leave/overtime impact on work minutes if needed by payroll rules.
- Add UI mapping validation (field mapping hints + validation errors).
- Re-run policy preview/import UI after token refresh.

