# Comprehensive-Hours `payroll_cycle` Cap-Mapping — Design Lock — 2026-05-26

**Status:** design-lock (docs-only). **Does NOT unlock implementation.** No runtime change, no
migration, no new settings/config, no `attendance_*`/`meta_*` write. It locks the contract by
which a `payroll_cycle` period resolves a comprehensive-hours cap; the implementation is a
separate, explicit opt-in. Verified against `plugins/plugin-attendance/index.cjs` and the
payroll migration at `a8ca0917f`.

## 1. The gap

Today a `payroll_cycle` period resolves **no** comprehensive-hours cap. The value-plumbing
fail-closes at `index.cjs:12140` (`if (!period || period.periodType !== 'date_range') return
nullValues`) and the cap resolver (`:12093`) only keys `month`/`quarter`/`year`. So a
period-summary row for a payroll cycle stale-nulls the `comprehensive_hours_*` columns. This is
the most visible V1 gap (#1825/#1833 deferred it as "cycle-template mapping").

## 2. Load-bearing fact — payroll templates are structurally **monthly**

`attendance_payroll_templates` defines a pay window by `start_day` / `end_day` /
`end_month_offset`, constrained by CHECKs in `migrations/zzzz20260128120000_create_attendance_rule_sets_and_payroll.ts`:

```
CHECK (start_day BETWEEN 1 AND 31)      -- :55
CHECK (end_day   BETWEEN 1 AND 31)      -- :59
CHECK (end_month_offset IN (0, 1))      -- :63   ← the load-bearing constraint
```

`end_month_offset ∈ {0,1}` means a template spans at most one month-boundary: a same-month
window (offset 0) or a cross-month window (offset 1, e.g. the 26th→25th pay period). There is
**no** quarterly/yearly cadence field. So every payroll cycle is, by schema, a **monthly**
period. That makes `month` the correct comprehensive-hours cycle-type for a payroll cycle —
and notably it maps cross-month pay periods (26th→25th) to `month` correctly, where the
existing date-range bridge (`:12067`) would mis-map them to `custom_range` → null.

## 3. V1 mapping (locked)

A `payroll_cycle` period resolves the **`month`** org-default cap
(`attendance.settings.comprehensiveHours.capDefaults.month`), with two guards:

1. **Template presence required.** `template_id` is nullable (`onDelete('set null')`, migration
   `:80`); a cycle with no template (or whose template was deleted) makes **no** monthly-cadence
   claim → resolve `null`. V1 does **not** read the template's config (no JOIN, no new query) —
   the *presence* of a `templateId` is the cadence assertion the CHECK at `:63` guarantees.
2. **Span sanity guard.** If the cycle span `endDate − startDate + 1 > 62` days → `null`. A
   data-anomaly cycle (hand-edited to span multiple months) must not receive a `month` cap. 62
   is the legitimate maximum for a monthly template (`start_day=1, end_day=31, offset=1` →
   ~58–59 days; 62 leaves headroom without admitting genuinely non-monthly spans).

Resolved result for a payroll cycle that passes both guards:
- `capMinutes` = the `month` org default (positive int, or `null` if `month` is unset → stale-null).
- `source` = **`payroll_cycle_template_monthly`** — distinct from `org_default_by_cycle_type` so later analysis can tell a payroll-mapped cap from a calendar-month-mapped one even though the number is identical today.

## 4. Producer / resolver contract (for the impl, not this PR)

- **Carry `period.templateId`** on `payroll_cycle` periods (mirrors the existing `period.cycleId`). The producer (`resolveAttendanceReportPeriodSyncPeriod`, `:3442`, which already loads `attendance_payroll_cycles` at `:3462` and emits `periodType:'payroll_cycle'` at `:3472`) populates it from the loaded cycle row (`mapPayrollCycleRow.templateId`, `:7997`). Absence → `null` cap. This keeps the resolver single-arg.
- **Lift point** — `buildAttendanceComprehensiveHoursPeriodSummaryValues` (`:12131`), the gate at `:12140` becomes:
  ```
  if (period?.periodType === 'date_range')   → existing date-range bridge → resolver
  else if (period?.periodType === 'payroll_cycle'
           && period.templateId
           && cycleSpanDays(period) <= 62)   → resolve month cap, source=payroll_cycle_template_monthly
  else                                       → nullValues   (fail-closed unchanged)
  ```
- **Fingerprint payload** (companion fields, same path as #1833):
  ```
  { comprehensive_hours_cap_minutes: <month cap>,
    comprehensive_hours_cap_source: 'payroll_cycle_template_monthly',
    comprehensive_hours_cap_effective_key: <hash of capDefaults> }
  ```
  So a cap edit re-syncs payroll-cycle rows exactly like date-range rows.

## 5. Boundaries

Docs-only. No migration, no new settings/config (reuses the existing `month` cap), no read of
template `config`, no runtime change, no `attendance_*`/`meta_*` write, no new route. The
fail-closed default is preserved (anything not matching the locked rule → `null`). The impl is
a separate opt-in subject to the stage-1 lock.

## 6. Forward gate

The mapping's premise is the `end_month_offset IN (0,1)` CHECK (`:63`). **If a future migration
relaxes that CHECK** (e.g. to admit quarterly/yearly cadences), this `payroll_cycle → month`
mapping must be revisited — that schema change is the signal to extend the mapping (see §7).

## 7. Explicit deferred (each a separate opt-in)

- Quarterly / yearly payroll cadence (no template support today; gated on §6).
- Per-template or per-cycle cap override (would need a new settings/config shape — out of scope).
- Reading the template's `config` to derive cadence (V1 uses presence-only).
- Effective-dating + retroactive recompute (inherited deferral from `[[cap-policy design]]`).
- Cycles without a resolvable template → remain `null` (no fabricated cadence).

## 8. Test matrix (for the eventual impl)

| # | Case | Expected |
| --- | --- | --- |
| P1 | payroll_cycle, has template, span ≤62d, `month` cap set | `excess` against month cap; `source=payroll_cycle_template_monthly` |
| P2 | cross-month pay period (26th→25th), template, `month` cap set | resolves `month` (not custom_range/null) |
| P3 | payroll_cycle, `month` cap unset | `null` (stale-null) |
| P4 | payroll_cycle, `templateId == null` | `null` |
| P5 | payroll_cycle, span > 62d (anomaly) | `null` |
| P6 | quarterly/yearly (future) | `null` until §6 extension |
| P7 | cap edit → `effective_key` changes → payroll-cycle row re-syncs | patched on next sync |
| P8 | date_range path unchanged | existing bridge behavior intact |

## 9. Cross-references

- `docs/development/attendance-comprehensive-hours-cap-policy-persistence-design-20260525.md` — resolver contract + the original "cycle-template mapping" deferral this closes.
- `docs/development/attendance-comprehensive-hours-pr6-value-plumbing-verification-20260525.md` (#1833) — the value-plumbing + fail-closed gate this extends.
- `docs/development/attendance-comprehensive-hours-reporting-closeout-20260525.md` — capability closeout / limits.
- `[[attendance-multitable-report-boundary]]`, `[[staged-opt-in-lineage]]`, `[[k3-poc-stage1-lock-no-new-fronts]]`.
