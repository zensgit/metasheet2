# Comprehensive-Hours PR6 — Value-Plumbing (V1) Design + Verification — 2026-05-25

Minimal runtime slice that wires the #1829 cap resolver into the
`attendance_report_period_summaries` period sync, surfacing **one** period-level metric
(`comprehensive_hours_excess_minutes`) plus the three cap companion fields. Verified
against `plugins/plugin-attendance/index.cjs` at the PR head.

## Scope (and explicit non-scope)

**In:** compute and write, per period-summary row, the comprehensive-hours excess against
a persisted org-default cap (resolved via #1829), with cap provenance carried so a cap edit
re-syncs the row.

**Out (unchanged):** no new route, no UI, no migration, no new writer/producer, daily
`attendance_report_records` untouched, preview behavior unchanged, no attendance-group /
per-user override, no effective-dating, no `payroll_cycle` cap derivation.

## Design

System-managed value columns, not catalog-authored (so no catalog seed / migration):

- `ATTENDANCE_COMPREHENSIVE_HOURS_PERIOD_VALUE_COLUMNS` (`index.cjs:12080`) — 4 columns: `comprehensive_hours_excess_minutes` (number), `comprehensive_hours_cap_minutes` (number), `comprehensive_hours_cap_source` (string), `comprehensive_hours_cap_effective_key` (string).
- `buildAttendanceComprehensiveHoursPeriodSummaryValues(settings, orgId, userId, period, actualMinutes)` (`:12092`) — fail-closed: only an explicit `date_range` that bridges (`bridgeAttendanceDateRangeToComprehensiveHoursPeriod` `:12028`) to an aligned `month`/`quarter`/`year` with a configured org default (`resolveAttendanceComprehensiveHoursCap` `:12054`) yields a cap; `payroll_cycle`, `custom_range`, missing `periodType`, and unset cap all **stale-null** all four columns. Excess uses the shared `buildAttendanceComprehensiveHoursComparison` math (no parallel computation).

Sync wiring in `syncAttendanceReportPeriodSummary` (`:3519`):

- The 4 columns are appended to the provisioned set (`allValueColumns` `:3550`) so `ensureObject` creates them and `resolveFieldIds`/`logicalIds` map them — they ride the **existing** provisioning + record-write path. They are **not** added to `valueFields`, so the field-config fingerprint is unaffected (these are system columns, not catalog config).
- The computed values are set into `logical` via `Object.assign(logical, comprehensiveHoursValues)` (`:3625`) **after** the catalog value loop and **before** `buildAttendanceReportPeriodSummarySourceFingerprint(logical)`. So the cap value / source / effective_key are hashed into `source_fingerprint` → a cap edit changes the fingerprint → the row patches on the next sync (passive re-sync). Existing pre-PR6 rows re-sync once automatically because `logical` now carries four extra keys.

## Boundaries held

| Boundary (#1819 / #1825) | How |
| --- | --- |
| No new writer / parallel producer | Reuses `syncAttendanceReportPeriodSummary`; source guard asserts no `sync*Comprehensive*` producer. |
| No migration | Columns are provisioned via the existing multitable `ensureObject`, not SQL; no `migrations/` change. |
| No raw `meta_*` write | All snapshot writes go through `records.createRecord`/`patchRecord`; test asserts zero `INSERT/UPDATE/DELETE` and no `meta_` / snapshot-table SQL. |
| No route / UI | None added. |
| Daily records untouched | Only the period sync changed. |
| `payroll_cycle` deferred | Fail-closed to null in V1 (cycle-template mapping is a future opt-in). |

## Test coverage

`packages/core-backend/tests/unit/attendance-comprehensive-hours-control.test.ts`, 28/28
(7 new under "comprehensive-hours period value-plumbing (PR6)"):

| Requirement | Test |
| --- | --- |
| Value logic incl. stale-null | value helper: aligned cap → excess; no-cap / payroll_cycle / non-aligned / missing-type → all-null |
| **stale-null through the real sync** | no org default → `createRecord` data has all 4 columns null |
| Computed write | cap configured → `createRecord` data has excess + companion fields |
| **cap fingerprint re-sync** | capture-and-replay: sync#1 create → feed stored data back → unchanged cap = skipped → changed cap = `patchRecord` with new excess/cap |
| Existing-row migration | pre-PR6 record (no comp-hours keys, stale fingerprint) → patched on first new sync |
| **no parallel producer / no raw meta** | zero `INSERT/UPDATE/DELETE`; no `meta_`/snapshot-table SQL; writes only via records API; source guard for `sync*Comprehensive*`; wiring + ordering source guard |

### Test-level honesty (what the mock does and does not cover)

The real producer `syncAttendanceReportPeriodSummary` is exercised via **mock-multitable +
mock-db** (the mock captures the actual write payload the producer emits). The integration
harness (`attendance-plugin.test.ts`) does not currently wire the multitable plugin, so an
HTTP-level test against real `provisioning.ensureObject` / `records.createRecord` is **not**
added in this slice — that path would only ever hit the `degraded` branch there. This is the
producer-level wire (field assembly + fingerprint + create/patch/skip decision), which is
the right level for this change; drift between the producer and the multitable record API is
out of scope here and is covered by the multitable plugin's own tests. This is **not** the
same as the #1829 cap-policy integration test, which hit real Postgres + real HTTP — that
was a settings round-trip; this slice's writes target multitable provisioning, which the
harness lacks.

## Verification run

- `attendance-comprehensive-hours-control.test.ts`: 28/28.
- Full core-backend unit suite: 2309/2309.
- `tsc` (build:cache): clean.
- Mock-db uses a hard-fail default (`throw` on unmocked query) so a missing mock surfaces as a failure, not a silent `[]`.

## Cross-references

- `docs/development/attendance-comprehensive-hours-pr6-snapshot-boundary-20260525.md` (#1819) — boundary contract.
- `docs/development/attendance-comprehensive-hours-pr6-runtime-orientation-20260525.md` (#1823) — established this as the post-cap-policy slice.
- `docs/development/attendance-comprehensive-hours-cap-policy-persistence-design-20260525.md` (#1825) — resolver contract + period-type bridge + fingerprint-via-companion-fields.
- cap-policy impl V1 (#1829) — the resolver/bridge this slice consumes.
- `[[attendance-multitable-report-boundary]]`, `[[staged-opt-in-lineage]]`, `[[feedback_metasheet2_skip_when_unreachable_blind_spot]]`.

## Not done (future opt-ins)

Per-org / attendance-group / per-user cap override; effective-dating + retroactive recompute;
`payroll_cycle` cap derivation (cycle-template mapping); additional comprehensive-hours
metrics beyond `excess_minutes`; any UI surfacing of these columns.
