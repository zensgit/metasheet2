# Attendance Rule Classification (System vs Org vs User)

Date: 2026-02-02

## System-Level (Product / Plugin Core)
These should live in the core attendance plugin because they are generic and reusable:
- Data hygiene & monthly cleanup (backup then purge by month).
- Import pipeline (CSV/DingTalk JSON -> normalized rows -> preview -> commit).
- Approval workflow ingestion (dedupe by businessId, handle revoke/cancel, retry on fetch failure).
- Time-range validation (month boundaries, cross-month approvals).
- Generic metrics: work minutes, late/early, leave, overtime, absenteeism, missing punches.
- Rule engine execution & safe fallbacks (invalid config -> non-blocking).

## Organization-Level (Configurable Templates / Policies)
These should be stored as org templates or rule sets because they vary by company:
- Role/group mapping (e.g., driver / security role IDs, attendance groups).
- Attendance group naming (e.g., 单休办公 / 车间 / 后勤).
- Default hours or overtime for specific groups (e.g., security default 8h, driver rest-day overtime).
- Approval process codes (overtime / leave / trip flows).
- Shift patterns and rotation schedules.
- Payroll cycle templates and anchor dates.

## User-Level (Overrides)
These should be user-specific rules or overrides:
- Special fixed hours for named users (e.g., 10h shift for a single user).
- Temporary exceptions for specific dates/users (e.g., manual adjustments).

## Practical Mapping (What we implemented)
- System templates now include baseline + common role/group templates; org-specific rules can be copied into the template library and edited.
- Placeholder template for special user overrides is provided; replace `__USER_ID__` with real IDs when needed.
