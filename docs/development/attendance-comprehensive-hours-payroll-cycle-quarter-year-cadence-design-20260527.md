# Comprehensive-Hours `payroll_cycle` Quarter/Year Cadence - Design Lock - 2026-05-27

**Status:** design-lock (docs-only). This document does **not** unlock implementation.
The implementation would require a schema/config change on payroll templates, so it must be
a separate explicit opt-in with its own review, migration plan, tests, and rollback note.

**Scope:** extend the already-shipped payroll-cycle cap mapping so a payroll-cycle period can
resolve `quarter` or `year` cap defaults when, and only when, the payroll template explicitly
declares that cadence and the cycle dates match that template window.

Verified against `plugins/plugin-attendance/index.cjs` and payroll migration at `d5026a04f`.

## 1. Current edge

The current chain is complete for monthly payroll templates:

- #1887 design-lock established `payroll_cycle -> month` mapping because current payroll
  templates are structurally monthly.
- #1894 shipped the first coarse implementation.
- #1900 replaced the coarse gate with precise template-window validation:
  `templateId && templateWindowMatches === true && span <= 62d` (`plugins/plugin-attendance/index.cjs:12215-12218`).

The remaining §6 gap is quarterly/yearly payroll cadence. Today the table does not model that:

- `attendance_payroll_templates` has `start_day`, `end_day`, and `end_month_offset`, but no
  cadence field (`packages/core-backend/src/db/migrations/zzzz20260128120000_create_attendance_rule_sets_and_payroll.ts:43-47`).
- The migration constrains `end_month_offset IN (0, 1)`, which only represents same-month or
  cross-month windows (`...create_attendance_rule_sets_and_payroll.ts:61-63`).
- `resolvePayrollWindow` computes one window from those day/offset fields (`plugins/plugin-attendance/index.cjs:7132-7153`).
- `/api/attendance/payroll-cycles/generate` advances anchors by one month per generated cycle
  (`plugins/plugin-attendance/index.cjs:24840-24843`).

So current runtime correctly treats a verified payroll cycle as **monthly**. It has no source of
truth that could safely say "quarterly" or "yearly".

## 2. Required decision - explicit cadence, never span inference

Quarter/year support must start by adding an explicit template cadence:

```
attendance_payroll_templates.cadence:
  'month' | 'quarter' | 'year'
```

This is load-bearing. The implementation must **not** infer cadence from cycle span, cap value,
cycle name, generated metadata, or `end_month_offset` alone.

Why: span inference would recreate the V1 coarse-heuristic class. A hand-entered 80-100 day
cycle might be a quarterly pay period, a data error, or a special correction window. Reporting
must fail closed unless the template says the cadence and the cycle dates match the template's
generated window.

Legacy behavior:

- Existing templates backfill/default to `cadence='month'`.
- Existing monthly snapshot behavior and the source label `payroll_cycle_template_monthly`
  remain unchanged.

## 3. Schema contract for the eventual impl

Recommended migration shape:

1. Add `attendance_payroll_templates.cadence varchar(16) NOT NULL DEFAULT 'month'`.
2. Add/replace a CHECK that allows only `month`, `quarter`, `year`.
3. Replace the old offset CHECK with a cadence-aware constraint.

Recommended offset contract:

| cadence | allowed `end_month_offset` | examples |
| --- | --- | --- |
| `month` | `0` or `1` | `1..31` calendar month, `26..25` cross-month |
| `quarter` | `2` or `3` | calendar quarter, rolling quarter |
| `year` | `11` or `12` | calendar year, rolling year |

The offset still means "how many months after the resolved start month the end day lands in".
This preserves the current `resolvePayrollWindow` mental model while letting quarter/year
windows be represented without a second table.

Implementation detail to lock in review: route normalization should choose the cadence-matching
default offset when omitted:

- If `endDay >= startDay`: `offset = cadenceMonths - 1`.
- If `endDay < startDay`: `offset = cadenceMonths`.

Do not just relax `end_month_offset` to a wide numeric range. Without the cadence enum, the cap
mapping would still have to guess.

## 4. Window generation contract

The eventual runtime should generalize, not fork, the current `resolvePayrollWindow` flow:

```
cadenceMonths('month')   = 1
cadenceMonths('quarter') = 3
cadenceMonths('year')    = 12
```

For one cycle window:

- Use the existing anchor convention: anchor on the cycle start month/date.
- Compute the expected start from `start_day`.
- Compute the expected end from `end_month_offset` and `end_day`.
- Require `templateWindowMatches === true` before any cap resolves.
- Replace the existing monthly-only `span <= 62d` guard with cadence-aware validation. Keeping
  that fixed guard in a generalized quarter/year branch would silently stale-null valid
  quarterly/yearly cycles even when the template window matches.

For generated cycles:

- `/api/attendance/payroll-cycles/generate` currently advances by `addMonthsToDate(anchorBase, i)`.
- The cadence-aware version must advance by `addMonthsToDate(anchorBase, i * cadenceMonths)`.
- `count=4` quarterly cycles should cover four quarter windows, not four monthly windows.
- `count=1` behavior remains equivalent for monthly templates.

Manual create/update remains allowed to carry explicit `startDate`/`endDate`, but reporting cap
mapping must fail closed when those dates do not match the declared template cadence/window.
Route-level blocking of mismatched manual cycles is a separate product decision and is not
required for this reporting slice.

## 5. Cap mapping contract

The period producer continues to emit `periodType: 'payroll_cycle'` (`plugins/plugin-attendance/index.cjs:3472-3476`).
It must additionally carry the template cadence into the period payload, for example:

```
period.templateCadence = 'month' | 'quarter' | 'year' | null
period.templateWindowMatches = boolean
```

The builder rule becomes:

```
if periodType === 'date_range':
  existing natural date_range bridge

else if periodType === 'payroll_cycle'
  && templateId
  && templateWindowMatches === true
  && cadence-aware span/window guard passes
  && templateCadence in {'month','quarter','year'}:
    resolve capDefaults[templateCadence]
    source = payroll_cycle_template_<cadence>

else:
  stale-null all comprehensive_hours_* columns
```

Source-label contract:

| cadence | source label |
| --- | --- |
| `month` | `payroll_cycle_template_monthly` (existing, `plugins/plugin-attendance/index.cjs:12129`) |
| `quarter` | `payroll_cycle_template_quarterly` |
| `year` | `payroll_cycle_template_yearly` |

Distinct labels matter even when cap minute values happen to match. They let multitable analysis
and source fingerprints tell whether a cap came from calendar date-range mapping or payroll
template cadence mapping.

## 6. Fingerprint and re-sync

No new fingerprint mechanism is needed. The existing companion fields remain sufficient:

- `comprehensive_hours_cap_minutes`
- `comprehensive_hours_cap_source`
- `comprehensive_hours_cap_effective_key`

Effects:

- Changing `capDefaults.quarter` or `capDefaults.year` changes the effective key and/or cap
  value, so affected payroll-cycle rows patch on the next sync.
- Changing a template's cadence can change `cap_source` and cap minutes; that also changes the
  logical payload and therefore the source fingerprint.
- If a template edit makes an existing cycle no longer match its template window, the producer
  sets `templateWindowMatches=false`, and the row stale-nulls on next sync.

No active backfill job is part of the first implementation. Re-sync remains passive, consistent
with #1833/#1900.

## 7. Boundaries

This design deliberately does **not** include:

- No implementation in this PR.
- No UI.
- No per-cycle cap override.
- No group/user cap override.
- No effective-dated cap history or retroactive recompute policy.
- No enforcement or save blocking.
- No attendance compute reading from report snapshots.
- No raw `meta_*` write and no new report writer.
- No route-level prohibition on hand-entered payroll cycle dates.

The first impl, if opted in, is allowed to touch schema/route/test code for payroll templates and
the existing period-summary producer. It should not add a new reporting route or a parallel
snapshot writer.

## 8. Test matrix for the eventual impl

| # | Property | Required coverage |
| --- | --- | --- |
| QY1 | Legacy templates default to month | migration/unit assertion: old rows resolve `cadence='month'`; existing monthly tests still pass. |
| QY2 | Schema rejects ambiguous offsets | migration/schema test for allowed offset sets per cadence. |
| QY3 | Window resolver handles month/quarter/year | unit cases for calendar month, 26th-to-25th month, calendar quarter, rolling quarter, calendar year, rolling year. |
| QY4 | Generator advances by cadence | route/unit test: quarterly `count=4` advances anchors by 3 months; yearly by 12 months. |
| QY5 | Producer carries real cadence and match flag | wire-vs-fixture test through `resolveAttendanceReportPeriodSyncPeriod`, not a synthetic builder-only fixture. |
| QY6 | Builder maps each cadence to the correct cap | month -> month cap/monthly label; quarter -> quarter cap/quarterly label; year -> year cap/yearly label. |
| QY7 | Fail-closed cases | no template, missing template, invalid cadence, mismatched window, unset cap, oversized/impossible dates -> all null. |
| QY8 | Fingerprint re-sync | cap edit and cadence/source-label change both patch the period row on next sync. |
| QY9 | Date-range path unchanged | existing natural date_range month/quarter/year bridge still uses `org_default_by_cycle_type`. |
| QY10 | Boundary guards | no UI files, no new report writer, no raw `meta_*` write; migrations limited to payroll-template cadence support. |

QY5 is mandatory. Builder fixtures alone are not enough, because the historical drift class is
"producer forgot to serialize the field the builder expects".

## 9. Cross-references

- `docs/development/attendance-comprehensive-hours-payroll-cycle-cap-mapping-design-20260526.md` - #1887 design-lock; this document closes its §6 quarterly/yearly deferral at the design level only.
- `docs/development/attendance-comprehensive-hours-payroll-cycle-cap-mapping-impl-verification-20260526.md` - #1894 monthly V1 coarse impl.
- `docs/development/attendance-comprehensive-hours-payroll-cycle-cap-precise-window-verification-20260526.md` - #1900 precise template-window validation.
- `docs/development/attendance-comprehensive-hours-cap-policy-persistence-design-20260525.md` - cap resolver and capDefaults contract.
- `docs/development/attendance-comprehensive-hours-reporting-closeout-20260525.md` - reporting V1 closeout and future opt-in boundary.
- `[[attendance-multitable-report-boundary]]`, `[[staged-opt-in-lineage]]`, `[[k3-poc-stage1-lock-no-new-fronts]]`.
