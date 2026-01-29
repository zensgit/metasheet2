# Attendance Framework Development Report (2026-01-28)

## Summary
Built the core framework layer for attendance so PLM/ECO or any future business module can reuse the same configuration + rule-set + payroll-cycle model. This adds the minimal schema and API surface for rule sets and payroll cycles, plus a preview endpoint for rule evaluation.

## Scope Delivered (1→2→3)
1. **Data model**
   - Added `attendance_rule_sets`, `attendance_payroll_templates`, `attendance_payroll_cycles` tables.
   - Added indexes and constraints to keep org-level uniqueness and valid ranges.
2. **Org configuration layer**
   - CRUD APIs for rule sets and payroll templates.
   - CRUD APIs for payroll cycles with template-based generation + manual override.
3. **Rule engine skeleton**
   - Added `/api/attendance/rule-sets/preview` to run a basic in/out pairing preview from uploaded events.
   - Designed to be extended with complex rule evaluation and external mappings (DingTalk/YiDa).

## Data Model Additions
### attendance_rule_sets
- `org_id`, `name`, `version`, `scope`, `config`, `is_default`
- `config` is JSON for user/org custom rules and external mappings.

### attendance_payroll_templates
- `start_day`, `end_day`, `end_month_offset`, `timezone`, `auto_generate`
- Supports **跨月周期** (e.g. 25 → next month 6) via `end_month_offset`.

### attendance_payroll_cycles
- `start_date`, `end_date`, `status`, `template_id`
- Can be created directly or generated from a template + anchor date, then manually adjusted.

## API Additions (Plugin)
### Rule Sets
- `GET /api/attendance/rule-sets`
- `POST /api/attendance/rule-sets`
- `PUT /api/attendance/rule-sets/:id`
- `DELETE /api/attendance/rule-sets/:id`
- `POST /api/attendance/rule-sets/preview` (rule engine skeleton)

### Payroll Templates
- `GET /api/attendance/payroll-templates`
- `POST /api/attendance/payroll-templates`
- `PUT /api/attendance/payroll-templates/:id`
- `DELETE /api/attendance/payroll-templates/:id`

### Payroll Cycles
- `GET /api/attendance/payroll-cycles`
- `POST /api/attendance/payroll-cycles`
- `PUT /api/attendance/payroll-cycles/:id`
- `DELETE /api/attendance/payroll-cycles/:id`

## Rule Separation (System vs Org vs User)
- **System (内置)**: in/out pairing, basic late/early/absent classification, default workday logic.
- **Org Config (组织级)**: shifts, holidays, overtime rules, payroll templates, default rule set.
- **User Custom (用户自定义)**: DingTalk field mapping, special approval workflows, role-based exceptions.

## Implementation Notes
- Rule set config stored as JSON to allow DingTalk/YiDa mapping without code changes.
- Payroll cycles support both **template generation** and **manual override**.
- All new endpoints are guarded by `attendance:admin` (preview uses `attendance:read`).

## Next Steps
- Extend rule-set preview to full evaluation (late/early/absence + overtime/leave).
- Add UI screens for rule-set management + payroll templates/cycles.
- Import adapters for DingTalk/YiDa with mapping validation.
