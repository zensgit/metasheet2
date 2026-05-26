# Comprehensive-Hours Reporting — Closeout (#1819 → #1833) — 2026-05-25

Clean closeout for the comprehensive-hours **reporting / multitable snapshot** capability.
This is the capstone for the design→runtime→snapshot chain that followed the PR0–PR5
preview/control work (`attendance-comprehensive-hours-pr0-pr5-closeout-20260523.md`). It
records the final lineage, what is delivered, how to configure it, the known limits, and the
future opt-ins — so the next UI / override work starts from a documented edge and does not
re-litigate the boundary.

**Disposition:** this capability is closed at value-plumbing V1. The remaining items
(effective-dating, group/user override, payroll_cycle mapping, UI) are explicit
**product / compliance decisions**, not kernel-polish — each needs its own opt-in (§6). No
further automatic advancement.

## 1. Final lineage

| Link | PR | Delivered |
| --- | --- | --- |
| Boundary contract | #1819 | Locked: reuse the existing report-records snapshot substrate; no new writer / migration / `meta_*` write / UI; snapshot is a rebuildable projection; attendance compute must not read the snapshot. |
| Runtime orientation | #1823 | Found the disqualifying prerequisite: comprehensive-hours was stateless (no persisted cap), so a background sync had nothing to compute. The period value-column path already existed. |
| Cap-policy design-lock | #1825 | Locked the resolver contract `(orgId,userId,period) → {capMinutes,source,fingerprintPayload}|null`, org-default-by-cycle-type, the period-type bridge, and fingerprint-via-companion-fields. |
| Cap-policy impl V1 | #1829 | Cap persistable / resolvable / fingerprintable: `attendance.settings.comprehensiveHours.capDefaults`, the resolver, the bridge, `effective_key`. Not wired to any producer. |
| Value-plumbing V1 | #1833 | Wired the resolver into the period sync; `comprehensive_hours_excess_minutes` + cap companion fields flow into `attendance_report_period_summaries` with passive re-sync. |

## 2. Delivered capability (end-to-end)

An admin sets an org-default comprehensive-hours cap per cycle-type. The period-summary sync
then computes, per user per period, the minutes worked beyond that cap and writes it (with
cap provenance) into the private `attendance_report_period_summaries` multitable object, where
multitable views / formulas can analyze it read-only. A cap change re-syncs affected rows on
the next sync pass. No new route, no UI, no migration, no new producer; daily records and
preview behavior are unchanged.

Columns written to the period snapshot (`ATTENDANCE_COMPREHENSIVE_HOURS_PERIOD_VALUE_COLUMNS`, `plugins/plugin-attendance/index.cjs:12080`):

- `comprehensive_hours_excess_minutes` — `max(0, actualMinutes − cap)` for the period.
- `comprehensive_hours_cap_minutes` — the resolved cap.
- `comprehensive_hours_cap_source` — provenance label (`org_default_by_cycle_type`).
- `comprehensive_hours_cap_effective_key` — config-revision marker (content hash of the cap defaults).

## 3. How to configure the cap (existing settings route — no UI)

There is no dedicated UI. Caps are set through the **existing** settings endpoint:

```
PUT /api/attendance/settings        (permission: attendance:admin)
Content-Type: application/json

{
  "comprehensiveHours": {
    "capDefaults": {
      "month":   10560,   // minutes (e.g. 176h); positive integer or null
      "quarter": 31680,
      "year":    126720
    }
  }
}
```

- Units are **minutes**; each value is a positive integer or `null` (unset). Validation lives in the route's zod `settingsSchema` (`index.cjs:14288`) and the `normalizeSettings` normalizer.
- The update is a **deep-merge** of `capDefaults` — sending only `{ "month": N }` preserves the existing `quarter`/`year`.
- `GET /api/attendance/settings` returns the current values.

## 4. How it flows (resolution + re-sync)

1. The period sync (`syncAttendanceReportPeriodSummary`, `index.cjs:3519`) bridges the period's `date_range` window to a cycle-type (`bridgeAttendanceDateRangeToComprehensiveHoursPeriod`): exact natural month/quarter/year → that type; anything else → `custom_range`.
2. `resolveAttendanceComprehensiveHoursCap` (`index.cjs:12054`) returns the org default for `month`/`quarter`/`year`, else `null`.
3. `buildAttendanceComprehensiveHoursPeriodSummaryValues` (`index.cjs:12092`) is **fail-closed**: only `periodType === 'date_range'` proceeds; `payroll_cycle` / `custom_range` / any other type / unset cap → all four columns **stale-null**. Excess reuses the shared `buildAttendanceComprehensiveHoursComparison` math (no parallel computation).
4. The values are set into the row's `logical` payload **after** the catalog value loop and **before** the source fingerprint (`Object.assign(logical, comprehensiveHoursValues)`, `index.cjs:3625`), so the cap value / source / `effective_key` are hashed into `source_fingerprint`. A cap edit changes `effective_key` → the fingerprint diverges → the row patches on the next sync (**passive re-sync**). Existing pre-PR6 rows re-sync once automatically because the new keys diverge the fingerprint.

## 5. Known limitations (current edges)

- **Global, not per-org/group/user.** `attendance.settings` is a single global config; `org_default_by_cycle_type` is the source *label* for that global default. The resolver carries `orgId`/`userId` for forward-compat but ignores them in V1.
- **Only `month` / `quarter` / `year`,** and only when a period's `date_range` window aligns exactly to a natural calendar month/quarter/year. Non-aligned windows → `custom_range` → null.
- **`payroll_cycle` periods never resolve a cap in V1** (stale-null) — no cycle-type mapping yet.
- **One metric only:** `comprehensive_hours_excess_minutes`. No status/violation/remaining columns.
- **No effective-dating:** `effective_key` is a config-revision marker, not a date. Changing a cap re-computes all periods on next sync (no per-period historical cap, no retroactive-recompute policy).
- **No UI:** caps are API-only via the settings route.
- **Producer-level test coverage:** the sync is exercised via mock-multitable + mock-db (the integration harness does not wire multitable); see `attendance-comprehensive-hours-pr6-value-plumbing-verification-20260525.md`.

## 6. Future opt-ins (each a separate product / compliance decision)

Listed so the boundary is not lost; none is in scope without an explicit opt-in:

- **Per-org / attendance-group / per-user cap override** (likely needs a table + admin surface).
- **Effective-dating + retroactive-recompute policy** (caps are a compliance artifact; changing one retroactively alters computed violations).
- **`payroll_cycle` cycle-template mapping** so payroll cycles resolve a cap.
- **Additional metrics** beyond excess (e.g. status / remaining / cap-utilization).
- **UI surfacing** of the cap configuration and/or the snapshot columns.

## 7. Cross-references

- `docs/development/attendance-comprehensive-hours-pr0-pr5-closeout-20260523.md` — the preview/control half (PR0–PR5).
- `docs/development/attendance-comprehensive-hours-pr6-snapshot-boundary-20260525.md` (#1819).
- `docs/development/attendance-comprehensive-hours-pr6-runtime-orientation-20260525.md` (#1823).
- `docs/development/attendance-comprehensive-hours-cap-policy-persistence-design-20260525.md` (#1825).
- `docs/development/attendance-comprehensive-hours-pr6-value-plumbing-verification-20260525.md` (#1833).
- `[[attendance-multitable-report-boundary]]`, `[[staged-opt-in-lineage]]`, `[[k3-poc-stage1-lock-no-new-fronts]]`.
