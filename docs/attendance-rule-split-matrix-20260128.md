# Attendance Rules: System vs Org Custom Matrix (2026-01-28)

This matrix separates **platform-default** behaviors from **org-specific** policy logic. The goal is to keep the core engine stable while exposing a configurable DSL for special cases (security/driver, single-rest workshop, etc.).

## 1) System (Platform Default)
These should be **built-in** and always on:
- Workday vs holiday calculation (calendar/holiday table).
- Late/early/partial/absent status based on rule-set time window.
- Work minutes rounding (rule-set `roundingMinutes`).
- Leave / overtime minutes integration for summaries.
- Payroll cycles & cross-month window support.
- Import mapping + status normalization.
- Approval workflow + audit logging.

## 2) Org/Department Policy (Configurable DSL)
These vary by org and should be **policy rules** (rule-set `policies`):
- **Security staff**: holiday attendance counts as overtime.
- **Security staff**: daily attendance forced to 8h.
- **Driver**: rest day with any punch => overtime 8h.
- **Attendance group**: “单休车间 + 休息 + 出差” => overtime 8h.
- Entry/resign cutoffs (e.g., set work hours to 0 after resign date).
- Special attendance group definitions (单双休/单休办公/单休车间).

## 3) User-Specific Exceptions
These should be **per-user overrides** or user-group policies:
- Special user schedules (e.g., user `16256197521696414` 10.5h rule).
- Any exception keyed by a single userId or small list of userIds.

## 4) Mapping of Current Rules to DSL
| Rule Source | Suggested Location | Example DSL Condition |
|---|---|---|
| Security staff daily 8h | Policy DSL | `userGroup: security` + `setWorkMinutes: 480` |
| Security holiday overtime | Policy DSL | `userGroup: security` + `isHoliday: true` + `addOvertimeMinutes: 480` |
| Driver rest-day overtime | Policy DSL | `userGroup: driver` + `fieldEquals.shift: 休息` |
| Single-rest workshop on trip | Policy DSL | `fieldEquals.attendance_group: 单休车间` + `fieldContains.related_approval: 出差` |
| Late penalty | Policy DSL | `metricGte.lateMinutes: 15` + `addLeaveMinutes: 30` |

## 5) Data Requirements for DSL
Fields that must be mapped (CSV/JSON imports):
- `attendance_group` (考勤组)
- `plan_detail` / `attendance_class`
- `attend_result`
- Punch times/results (`1_on_duty_user_check_time`, etc.)
- `related_approval` (if used for travel / approvals)

## 6) Recommendation
Keep the **core engine minimal**, and encode all exceptions in DSL so each customer can copy + edit policy JSON without code changes.
