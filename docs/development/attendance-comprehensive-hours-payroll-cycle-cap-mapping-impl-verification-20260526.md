# Comprehensive-Hours `payroll_cycle` Cap-Mapping — V1 Coarse Impl Verification — 2026-05-26

Implements the V1 **coarse** mapping locked in
`attendance-comprehensive-hours-payroll-cycle-cap-mapping-design-20260526.md` (#1887). Runtime
slice only: no JOIN, no template-config read, **no migration / route / UI / write path**, and the
precise template-window validation (design §7) is **deliberately not** implemented (deferred
opt-in). All edits are in `plugins/plugin-attendance/index.cjs` + one unit-test file.

## What landed (matches design §3/§4)

1. **Producer carries `templateId`.** `resolveAttendanceReportPeriodSyncPeriod` now emits
   `templateId: cycle.templateId || null` on the `payroll_cycle` period (mirrors `cycleId`).
   Presence of a templateId is the (coarse) monthly-cadence signal; absence → no cap.
2. **Span guard.** `attendancePayrollCycleWithinMonthlySpan(from, to)` — valid dates, `from ≤ to`,
   inclusive span `≤ 62` days (`ATTENDANCE_PAYROLL_CYCLE_MONTHLY_MAX_SPAN_DAYS`). 62 is the
   conservative ceiling for a structurally-monthly template (`end_month_offset ∈ {0,1}`).
3. **Builder branch** (`buildAttendanceComprehensiveHoursPeriodSummaryValues`):
   - `date_range` → existing bridge → resolver (unchanged, `org_default_by_cycle_type`).
   - `payroll_cycle` **and** `templateId` **and** span ≤ 62 → resolve the **`month`** org default,
     stamped `source = payroll_cycle_template_monthly`.
   - everything else (missing/unknown type, templateId-less, oversized) → `nullValues`
     (fail-closed unchanged).
4. **Resolver source label.** `resolveAttendanceComprehensiveHoursCap` gained an optional
   `sourceLabel` (default `org_default_by_cycle_type`); cap minutes + `effective_key`
   (= `hash(capDefaults)`) are unchanged, so a cap edit re-syncs payroll rows exactly like
   date-range rows. Source literals locked as exported consts.

## Accepted imprecision (design §3, locked by test P5b)

The cycle create route (`index.cjs` POST `/api/attendance/payroll-cycles`) uses body
`startDate`/`endDate` as-is and validates only `start ≤ end`; it does **not** verify the dates
match the template window. So a templateId-bearing cycle with hand-entered, ≤62d dates that are
**not** a real monthly period **still** receives the `month` cap. This is a conscious coarse-
heuristic trade-off — blast radius is one reporting metric (`comprehensive_hours_excess_minutes`
in the snapshot), never a calc-chain or enforcement decision. The precise upgrade (read template +
verify via `resolvePayrollWindow`) is design §7, a separate opt-in.

## Tests — `attendance-comprehensive-hours-control.test.ts` (39 passed, 11 new)

| # | Case | Expected | Result |
| --- | --- | --- | --- |
| P1 | template + span≤62 + month cap set | excess vs month cap, `source=payroll_cycle_template_monthly` | ✅ |
| P2 | cross-month 26th→25th | bridge → `custom_range`/null (asserted), payroll branch → month | ✅ |
| P3 | month cap unset | null | ✅ |
| P4 | `templateId` null/undefined | null (+ PR6-block anchor at line ~673) | ✅ |
| P5 | span > 62d | null | ✅ |
| P5b | in-span but date-mismatched cycle | **still month** (documented imprecision) | ✅ |
| span guard | ≤62 inclusive / 63 / reversed / invalid | true / false / false / false | ✅ |
| source lock | literal `payroll_cycle_template_monthly` ≠ default | locked | ✅ |
| P8 | `date_range` path | unchanged, default source | ✅ |
| **wire** | **producer emits `templateId`** (real `resolveAttendanceReportPeriodSyncPeriod`, mocked db) | `tpl-9` carried; `null` when row null | ✅ |
| P7 | cap edit re-syncs a `payroll_cycle` row (real sync) | `created` then `patched` w/ new cap | ✅ |

The **wire** test is mandatory per the wire-vs-fixture rule: P1–P8/P5b use synthetic periods and
cannot catch a producer that forgets to emit `templateId` (cf. the #1781 `dayIndex` drift).

Adjacent suites unaffected: `attendance-report-field-catalog.test.ts` 32/32.

## Boundaries (unchanged from design)

No migration, no new settings/config (reuses the `month` cap), no template `config` read, no new
route, no UI, no `attendance_*`/`meta_*` raw write (snapshot writes go through the multitable
records API only — re-asserted by the existing PR6 "no raw INSERT/UPDATE/DELETE" test). Deferred:
precise template-window validation (§7), quarterly/yearly cadence (§6), per-cycle override.

## Cross-references

- `attendance-comprehensive-hours-payroll-cycle-cap-mapping-design-20260526.md` (#1887) — design-lock.
- `attendance-comprehensive-hours-pr6-value-plumbing-verification-20260525.md` (#1833) — the value-plumbing this extends.
- `[[attendance-multitable-report-boundary]]`, `[[staged-opt-in-lineage]]`, `[[k3-poc-stage1-lock-no-new-fronts]]`.
