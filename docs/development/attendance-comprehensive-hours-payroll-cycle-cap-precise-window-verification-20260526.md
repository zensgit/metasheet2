# Comprehensive-Hours `payroll_cycle` Cap-Mapping — §7 Precise Template-Window Validation — 2026-05-26

Implements the deferred **§7 precise upgrade** from
`attendance-comprehensive-hours-payroll-cycle-cap-mapping-design-20260526.md` (#1887), replacing
the V1 **coarse** heuristic (templateId present + span≤62) shipped in the prior slice (#1894). A
`payroll_cycle` now maps to the `month` cap **only when its own dates match the window its
template would generate** — a templateId-bearing cycle with hand-entered, mismatched dates no
longer receives a cap. Runtime slice only: `plugins/plugin-attendance/index.cjs` + its unit suite
+ this doc. **No migration / route / UI / write path.**

## What changed vs V1 (#1894)

| | V1 coarse (#1894) | §7 precise (this slice) |
| --- | --- | --- |
| Gate | `templateId` present **and** span≤62 | `templateId` **and** `templateWindowMatches===true` **and** span≤62 |
| Date-mismatched, in-span, template-bound cycle | resolved `month` (documented imprecision) | **`null`** (no cap) |
| Template read | none (no JOIN) | reads `attendance_payroll_templates`, recomputes window |

## Implementation

1. **`verifyAttendancePayrollCycleTemplateWindow(db, orgId, cycle)`** (new, near `resolvePayrollWindow`):
   reads the cycle's template, recomputes the expected window via
   `resolvePayrollWindow(mapPayrollTemplateRow(row), parseDateInput(cycle.startDate))` (the same
   call the cycle-generation routes use), and returns `expected.startDate === cycle.startDate &&
   expected.endDate === cycle.endDate`. **Fail-closed**: no templateId, missing template row,
   unparseable dates, or any read/compute error → `false` (wrapped in `try/catch`), so an
   old/partial schema degrades to "unverified → no cap" instead of 503-ing the period sync.
2. **Producer** `resolveAttendanceReportPeriodSyncPeriod` calls the verifier and stamps
   `period.templateWindowMatches` (a boolean) alongside the existing `period.templateId`.
3. **Builder** `buildAttendanceComprehensiveHoursPeriodSummaryValues` payroll branch now requires
   `period.templateWindowMatches === true` (strict) in addition to `templateId` and the span
   guard. `templateWindowMatches` subsumes the coarse heuristic; the span guard is retained as
   cheap defense-in-depth (a matching monthly window is inherently ≤62d). `source` stays
   `payroll_cycle_template_monthly`; the `date_range` path is untouched.

## Anchor convention

The verifier anchors `resolvePayrollWindow` on the **cycle's start date** — identical to how the
create/generate routes (`index.cjs` ~:24678 / :24806 / :24917) derive a window. For a
template-generated cycle the start date sits on the template `start_day`, so the recomputed window
round-trips to the cycle's own dates → match. A hand-entered start that isn't on a template
boundary recomputes a different canonical window → no match.

## Tests — `attendance-comprehensive-hours-control.test.ts` (44 passed, +5 over #1894)

| # | Case | Expected |
| --- | --- | --- |
| P1 | template-verified (`templateWindowMatches:true`), in-span, month cap set | excess vs month cap, payroll source |
| P2 | cross-month 26th→25th, verified | bridge → custom_range/null (asserted); payroll branch → month |
| P3 | month cap unset | null |
| P4 | `templateId` null | null |
| P5 | span > 62d | null (span guard, even if verified) |
| **P5b** | **in-span but `templateWindowMatches:false`** | **null** (flipped from V1's `month` — the imprecision §7 removes) |
| **§7 gate** | `templateWindowMatches` false / undefined / truthy-non-true | null (strict `=== true`) |
| span guard | ≤62 / 63 / reversed / invalid | true/false/false/false |
| source lock | literal `payroll_cycle_template_monthly` ≠ default | locked |
| P8 | date_range path | unchanged, default source |
| **producer (match)** | real producer, template window matches | `templateWindowMatches === true` |
| **producer (mismatch)** | hand-entered dates ≠ template window | `false` |
| **producer (no template)** | `templateId` null | `templateId` null, `false` |
| **producer (template row gone)** | template missing | `false` (fail-closed) |
| **verify helper** | match / mismatch / no-template / **throwing db** | true / false / false / **false (catch)** |
| P7 | cap edit re-syncs a verified payroll_cycle row (real sync) | created → patched w/ new cap |

The producer + verify-helper tests are the wire-vs-fixture guard: the builder fixtures set
`templateWindowMatches` directly and cannot catch a producer that mis-computes or drops it.

## Production data effect (intentional)

Existing snapshot rows for templateId-bearing cycles whose dates do **not** match the template
window currently carry `comprehensive_hours_cap_minutes = <month value>` /
`cap_source = payroll_cycle_template_monthly` (granted by the V1 coarse rule). After this lands,
the next period sync flips those rows to **all-null**: `templateWindowMatches` becomes `false`, the
cap value/source change, the row `source_fingerprint` changes, and the existing fingerprint
re-sync mechanism patches the row (the same mechanism the date-range P7 / payroll P7 tests
exercise). This is the intended correction of the V1 imprecision, not a regression — no manual
backfill needed; rows self-correct on their next sync.

## Boundaries

Adds one `SELECT` on `attendance_payroll_templates` in the producer (read-only, fail-closed). No
migration, no new settings/route/UI, no raw `attendance_*`/`meta_*` write. Still deferred:
quarterly/yearly payroll cadence (design §6), per-cycle cap override.

## Cross-references

- `attendance-comprehensive-hours-payroll-cycle-cap-mapping-design-20260526.md` (#1887) — §7 is the upgrade this implements.
- `attendance-comprehensive-hours-payroll-cycle-cap-mapping-impl-verification-20260526.md` (#1894) — the V1 coarse slice this supersedes.
- `[[attendance-multitable-report-boundary]]`, `[[staged-opt-in-lineage]]`, `[[k3-poc-stage1-lock-no-new-fronts]]`.
