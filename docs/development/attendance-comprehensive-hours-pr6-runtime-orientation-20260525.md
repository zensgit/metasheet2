# Comprehensive-Hours PR6 — Runtime Orientation Finding — 2026-05-25

**Status:** orientation only (docs-only, no code). **Verdict: the first PR6 value-plumbing
micro-slice is BLOCKED on a missing prerequisite** — a persisted comprehensive-hours cap
policy that does not exist and that PR6's own boundary contract (#1819) forbids building
inside PR6.

This document records what a read-only orientation pass found *before* any implementation,
so the slice is not opened half-way and then stalled. It answers the four orientation
questions and closes with an explicit slice-size verdict. It does **not** decide the path
forward (cap-policy persistence vs park) — that is a separate opt-in.

Verified against `plugins/plugin-attendance/index.cjs` at `0c0a27de1`.

---

## 1. What orientation confirmed (the favorable half)

The period-summary snapshot **already has the catalog-driven dynamic value-column path**,
mirroring the daily producer. A new comprehensive-hours catalog code *can* structurally
reach `attendance_report_period_summaries` with no new mechanism:

- `syncAttendanceReportPeriodSummary` `:3509`
- reads the shared catalog: `buildAttendanceReportFieldCatalogResponse(...)` `:3528`
- resolves managed formula fields: `resolveAttendanceReportPeriodSummaryManagedFormulaFields(catalog.items)` `:3533`
- builds dynamic value columns: `buildAttendanceReportPeriodSummaryValueColumns(valueFields)` `:3536`
- provisions them via the same upsert: `ensureObject({ fields: [...base, ...valueColumns] })` `:3543`
- fills each column from the enriched summary: `getAttendancePeriodSummaryFieldValue(summaryWithFormulas, column.id)` `:3595` (inside the value loop `:3590`), getter def `:3391`, enrichment `enrichAttendanceSummaryWithFormulaValues` `:4623`

So the value-column mechanism is **not** the blocker. The grain is also correct: period
summaries are keyed user+period, matching `buildAttendanceComprehensiveHoursComparison`'s
user+period semantics (`:11910`) — daily records would be the wrong home.

## 2. The blocker (the disqualifying half)

`comprehensive_hours_excess_minutes = actual − cap`. The **cap exists only in a live
request** — there is no persisted comprehensive-hours policy anywhere:

- The cap is read only from request input / a request-supplied `policyDraft`: `normalizeAttendanceComprehensiveHoursCapMinutes` `:12001`.
- Missing cap is a hard error, not a fallback to a stored value: `INVALID_CAP — "Comprehensive hours preview requires a positive capMinutes or capHours value."` `:12029`.
- There is **no comprehensive-hours migration** and **no settings/cycle/group store** that holds a cap (confirmed by grep: the cap is never read from any persisted source).
- Consistent with PR0–PR5: comprehensive-hours is a **stateless, request-time** preview + save-time control feature; even the PR5 strong-control mode was non-persisted.

A background period-summary sync runs with **no cap**, so it cannot compute excess /
remaining / status. And **every comprehensive-hours-*distinct* metric depends on the cap** —
there is no cap-free comprehensive-hours value to snapshot.

## 3. Slice-size verdict: NOT small — blocked

The first micro-slice is not merely "large"; it is gated behind a feature that does not
exist and that PR6's contract forbids building inside PR6:

| Prerequisite the slice needs | #1819 boundary it collides with |
| --- | --- |
| Persist a cap (per user / group / cycle) → new policy or settings table | **#2 No new migration** |
| Let admins set the cap → policy CRUD UI | **#8 No UI / no presentation decision** |

Orientation succeeded exactly as intended: the prerequisite is caught **before** any code,
not half-way through.

---

## 4. The four orientation questions, answered

**(a) Which functions would change — *once unblocked*.** Minimal and localized:
- The period value loop in `syncAttendanceReportPeriodSummary` `:3590-3596` (a comprehensive-hours value would be injected into `summaryWithFormulas` so `getAttendancePeriodSummaryFieldValue` `:3595` picks it up by code — same pattern as `reportSubtypeMinutes` is merged in).
- A comprehensive-hours comparison call (`buildAttendanceComprehensiveHoursComparison` `:11910`) **plus a cap source** — the missing piece.
- The catalog seed (a new `comprehensive_hours` category in `ATTENDANCE_REPORT_FIELD_CATEGORIES` `:361` + one field entry) so the column is managed/provisioned.
- Tests (see (d)).

No change to the period descriptor, the value-column builder, the fingerprint, or the route.

**(b) What must NOT change (boundaries carried from #1819):**
- ❌ daily `attendance_report_records`
- ❌ any route (`/report-period-summaries/sync` accepted as-is)
- ❌ UI / report layout
- ❌ any migration (any table)
- ❌ no new writer / parallel producer
- ❌ no allUsers / batch comprehensive-hours — compute is explicit-users-only: `ALL_USERS_NOT_SUPPORTED — "allUsers belongs to a later batch slice."` `:11971`

**(c) First metric locked:** `comprehensive_hours_excess_minutes` — numeric, easy to assert,
exercises fingerprint + value plumbing, less presentation ambiguity than `status`.

**(d) Test landing points (for the eventual impl slice):**
- **T1** period wire round-trip (real wire, not fixture): sync a user+period with a known cap → query the multitable record back → assert the `comprehensive_hours_excess_minutes` column equals expected.
- **T3** `source_fingerprint` inclusion: changing the computed value changes the period source fingerprint; `synced_at` alone does not.
- **T5** no-parallel-producer guard: no new `sync.*[Cc]omprehensive` writer.
- **Gap to note:** there is no dedicated period-summary sync test file today; the closest report test is `packages/core-backend/tests/unit/attendance-report-field-catalog.test.ts`. The impl slice would add a period-summary sync test target.

---

## 5. Recommended sequencing (not decided here)

The honest order is: **comprehensive-hours cap-policy persistence is the real prerequisite,
and it is a separate decision that deliberately crosses #1819's no-migration boundary** — so
it must be its own opt-in, not smuggled into PR6 reporting. Once a cap is persisted, the
reporting value-plumbing slice becomes genuinely small (the value-column path in §1 is
already there).

This document does not start that work. Open options (each a separate opt-in):
1. A cap-policy-persistence design-lock (scopes a migration + how caps are set).
2. Park PR6 reporting until there is a concrete need for persisted caps.

---

## 6. Cross-references

- `docs/development/attendance-comprehensive-hours-pr6-snapshot-boundary-20260525.md` — the boundary contract (#1819) whose #2/#8 the prerequisite collides with.
- `docs/development/attendance-comprehensive-hours-pr0-pr5-closeout-20260523.md` — establishes comprehensive-hours as stateless preview/control.
- `[[attendance-multitable-report-boundary]]` — period summaries are the correct grain for period aggregates.
- `[[staged-opt-in-lineage]]` — cap-persistence and PR6 impl are each separate opt-ins.
- `[[k3-poc-stage1-lock-no-new-fronts]]` — any cap-persistence write path re-opens a runtime surface under the stage-1 lock; decide deliberately.
