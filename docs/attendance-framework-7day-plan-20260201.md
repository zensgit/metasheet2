# Attendance Framework 7-Day Plan (2026-02-01)

## Goal
Deliver a reusable attendance framework (rules + import + payroll cycles) that can host business modules (attendance, PLM/ECO, etc.). Focus is on configurable rules, robust data ingestion, and flexible payroll cycles.

## Current Inventory (Day 1 baseline)
### Backend (plugin-attendance)
- Core tables: events, records, requests, rules, shifts, assignments, holidays, rotations, leave types, overtime rules, approval flows.
- Rule engine:
  - Engine config + template library (`engine/*.cjs`) with system + custom templates.
  - Rule-set config schema supports mappings, approvals, payroll options, engine config, policy rules.
- Import pipeline:
  - Preview / prepare / commit flow, import batches + items, rollback.
  - Mapping support via rule-set config and per-import mapping payload.
- Payroll:
  - Payroll templates + payroll cycles with summary + CSV export.
  - Cycle window resolver (start_day/end_day/end_month_offset).
- Admin settings:
  - Auto absence, IP allowlist, geofence, min punch interval.

### Frontend (Attendance view)
- Summary + calendar + adjustment request UI.
- Admin sections for:
  - Rules / shifts / assignments / holidays / leave types / overtime rules / approval flows
  - Rotation rules + assignments
  - Rule sets + template editing + rule preview
  - Import preview + commit + batch review + rollback
  - Payroll templates + cycles + summary export

## Gaps / Risks
1) Data ingestion completeness
   - Need standardized mapping for DingTalk CSV/JSON + multi-user imports.
   - Missing user profile resolution (attendance_group, role tags, department) pipeline.
   - Error feedback and partial import recovery need to be clearer (row-level errors, recoverable states).

2) Rule engine usability
   - Configurable template parameters exist, but need a guided UI for mapping + rule preview using real data.
   - Rule-scope assignment (org/department/user/custom) needs enforcement rules + selection UI.

3) Payroll cycle flexibility
   - Template and manual cycles exist; need clear handling for cross-month, holiday carryover, and partial month computation.
   - Provide cycle generation for custom cutoffs (e.g., 1/26–2/06) and rules for next-month salary calculations.

4) Verification & automation
   - Ensure import/reconcile/rollback and payroll computations are covered by repeatable tests.

## 7-Day Delivery Plan
### Day 1 — Inventory + gap list
- Audit schema + endpoints + UI coverage.
- Confirm user-provided rule files / CSV/JSON examples and map to current data model.
- Produce this plan + backlog.

### Day 2 — Rule framework + templates
- Extend rule-set config validation and templates to cover user rules vs system rules.
- Add rule-template presets for common industries (security/driver/office).
- Improve preview API responses (warnings + computed metrics + applied policies).
- Update UI to surface rule-template selection and show preview diff.

### Day 3 — Import/mapping pipeline
- Build reusable mapping config for DingTalk JSON/CSV (field -> record/profile).
- Add mapping presets (CSV daily summary, DingTalk columns, custom JSON).
- Add row-level errors + warnings in preview.
- Add import batch meta (source, rule-set, mapping snapshot) for traceability.

### Day 4 — Payroll cycles
- Enhance cycle generation (template + manual adjustments).
- Add “cutoff day” support and cross-month carryover logic.
- Add payroll cycle summary improvements (per-group / per-role breakdown).

### Day 5 — Admin UI improvements
- Guided rule-set editor (mapping panel + template parameters + preview summary).
- Payroll cycle creation wizard (template + manual override).
- Import review UX: filter + status + snapshot download (already started).

### Day 6 — Verification automation
- API integration tests for import/preview/rollback + payroll cycles.
- Playwright UI acceptance for import batches + rule preview + payroll summary.
- Generate verification report + screenshots.

### Day 7 — Stabilization + delivery
- Fix remaining bugs + docs.
- Produce final dev/verification MD and handoff notes.

## Acceptance Criteria (end of Day 7)
- Import supports DingTalk CSV/JSON with mapping presets and row-level feedback.
- Rule engine supports system + custom templates with preview validation.
- Payroll cycles can compute cross-month cutoffs and export summaries.
- Automated verification (API + Playwright) and documentation delivered.

