# Attendance Comprehensive Working Hours Control RFC

Date: 2026-05-22
Status: Draft for review
Scope: RFC / TODO only. No runtime code, migration, route, UI, test, staging, or production operation in this slice.

## Summary

DingTalk advanced scheduling research identified `综合工时制` as the lowest-cost high-value gap in the scheduling domain: monthly, quarterly, or yearly total-hour caps with either weak control (warn only) or strong control (block schedule save). MetaSheet already has the pieces needed to build this safely:

- attendance rules and rule sets
- shift and rotation assignments
- effective-calendar resolution
- payroll cycles
- period summary formulas and `attendance_report_period_summaries`
- read-only advanced scheduling workbench diagnostics

This RFC defines a staged path for comprehensive working-hours control without opening the locked advanced-scheduling write-path roadmap. The first runtime slice should be read-only calculation and preview. Any save-blocking behavior is a later explicit opt-in because it touches schedule write paths.

## Product Semantics

Comprehensive working-hours control answers one question:

> For a person or scoped group, does planned or actual working time exceed the allowed cap within a configured control period?

Two metric families must remain separate:

| Metric | Meaning | Primary source | Use |
| --- | --- | --- | --- |
| Planned scheduled minutes | Minutes implied by effective shift / rotation / assignment for future or draft schedules | schedule assignments + effective calendar | Pre-save preview and schedule planning |
| Actual attendance minutes | Minutes already recorded or approved for completed days | attendance records, approvals, period summary | Post-period compliance report |

The product must not silently use actual attendance minutes to block future schedule saves, and must not use planned minutes as payroll facts. Planned and actual checks may share policy definitions, but their producer functions must stay separate.

## Existing Anchors

| Anchor | Current role |
| --- | --- |
| `attendance_rule_sets` | Candidate home for org/group rule policy references, but this RFC does not require storing cap policy there in v1. |
| `attendance_groups` / `attendance_schedule_groups` | Candidate scope targets. Attendance groups are payroll/attendance grouping; schedule groups are DingTalk-style scheduling pools. |
| `resolveEffectiveCalendar` and calendar-policy docs | Determines workday / holiday semantics for day-level schedule planning. |
| `loadAttendanceSummary()` | Existing actual attendance period summary producer. |
| `attendance_report_period_summaries` | Rebuildable multitable snapshot for actual period reporting. It must not become the source of truth for enforcement. |
| `GET /api/attendance/advanced-scheduling/workbench` | Read-only scheduling diagnostic surface. It can show warnings later, but must not gain write controls under this RFC. |

## Data Model Concept

Future runtime PRs may introduce a policy shape like:

```ts
interface ComprehensiveHoursPolicy {
  id: string
  name: string
  enabled: boolean
  scope: ComprehensiveHoursScope
  period: ComprehensiveHoursPeriod
  capMinutes: number
  metric: 'planned' | 'actual'
  enforcement: 'warn' | 'block'
  effectiveFrom?: string
  effectiveTo?: string
}

interface ComprehensiveHoursScope {
  org?: boolean
  attendanceGroupIds?: string[]
  scheduleGroupIds?: string[]
  userIds?: string[]
}

interface ComprehensiveHoursPeriod {
  type: 'month' | 'quarter' | 'year' | 'payroll_cycle' | 'custom_range'
  cycleId?: string
  from?: string
  to?: string
}
```

Open design choice for implementation:

- Option A: store policies in attendance settings JSON. This is fastest, migration-free, and suitable for preview-only v1.
- Option B: create a dedicated `attendance_comprehensive_hours_policies` table. This is better for many scoped policies, audit, and effective dating, but it is a new migration.

Recommendation: start runtime with Option A only if the first slice is read-only preview. Move to Option B before strong control or many customer-scoped policies.

## Boundary

| Boundary | Decision |
| --- | --- |
| New migration | Not in this RFC slice. Future strong-control policy storage may need one. |
| `attendance_*` fact writes | Not in this RFC slice. Future writer must not mutate attendance records. |
| Direct `meta_*` writes | Forbidden. |
| Multitable writes | Not part of enforcement. Optional evidence snapshots must remain rebuildable. |
| Advanced scheduling grid edit | Out of scope. |
| Excel import / copy-paste / temporary shift / dispatch | Out of scope. |
| Data Factory / Bridge Agent | Out of scope. |
| Save blocking | Out of scope until explicit customer opt-in or GATE decision. |

Read-only diagnostics, preview calculations, docs, and tests remain allowed attendance-kernel hardening.

## Period Semantics

| Period | v1 status | Notes |
| --- | --- | --- |
| Month | Required for first runtime preview. |
| Quarter | Required for first runtime preview. |
| Year | Required for first runtime preview because DingTalk calls out annual comprehensive-hours controls. |
| Payroll cycle | Recommended after date-range preview because MetaSheet already has payroll cycles. |
| Custom range | Useful for operator verification and tests; should not be the only product mode. |

Period resolution must be deterministic and timezone-stable. Date inputs should resolve to inclusive local dates, then compute minutes by work date. The source fingerprint for any future snapshot must include policy id/version, period key, user id, and producer kind (`planned` or `actual`).

## Planned-Minutes Producer

The planned-minutes producer must not reuse `loadAttendanceSummary()`. It should read schedule primitives and effective calendars:

1. Resolve target users from scope.
2. For each work date, resolve effective schedule source:
   - direct shift assignment
   - rotation assignment
   - default rule / rule set
   - effective calendar holiday/workday override
3. Convert the resolved shift/day to planned minutes.
4. Aggregate by user and period.
5. Return cap comparison:
   - `plannedMinutes`
   - `capMinutes`
   - `remainingMinutes`
   - `excessMinutes`
   - `status: ok | warning | violation`

Do not mix approval leave/overtime request minutes into planned minutes unless a later product decision explicitly defines how approved requests change planned schedule capacity.

## Actual-Minutes Producer

The actual-minutes producer may reuse existing period summary paths:

1. `loadAttendanceSummary(db, orgId, userId, from, to)` for a single user.
2. Existing approved leave/overtime subtype aggregation where relevant.
3. Existing summary formula output for reporting, not for enforcement.

Actual compliance should be reported as a post-period signal. It can warn managers that a person exceeded comprehensive-hours policy after attendance is recorded, but it should not be used to block schedule saves retroactively.

## Public Interface Roadmap

### PR0 - RFC docs (this slice)

Deliver this plan and verification record. No runtime code.

### PR1 - Read-only calculator helpers

Add pure helpers for:

- period resolution: month / quarter / year / custom range
- planned-minutes aggregation from existing schedule primitives
- actual-minutes aggregation via `loadAttendanceSummary()`
- cap comparison and stable response shape

No route and no UI yet. Unit tests only.

### PR2 - Preview route

Add:

```text
POST /api/attendance/comprehensive-hours/preview
```

Contract:

- `attendance:admin`
- body: `{ policyDraft, scope, period, metric }`
- returns per-user and aggregate comparisons
- degraded schema paths return explicit `DB_NOT_READY` / `degraded` fields, not silent zeroes
- no writes

### PR3 - Admin read-only preview UI

Add an admin panel that can:

- choose period mode and scope
- enter cap minutes/hours
- switch planned vs actual metric
- display warnings/violations
- link to read-only advanced scheduling workbench and period summaries where useful

No save-blocking and no schedule writes.

### PR4 - Weak-control warning on schedule save

Only after explicit opt-in. Add a warning path to schedule save/preview flows:

- warn when planned minutes exceed policy
- let admin continue
- log a clear operation event

This PR must restate the authorization source because it touches write-path UX.

### PR5 - Strong-control block-save guard

Only after explicit customer demand or GATE decision. Add backend enforcement to schedule write paths:

- block when `enforcement='block'` and planned excess exists
- preserve conflict-guard and scheduler-scope checks
- return machine-readable violation details
- test every route that can create planned schedule minutes

### PR6 - Reporting and multitable snapshot

Optional. Add rebuildable reporting surfaces:

- comprehensive-hours actual report
- planned-vs-actual variance report
- optional private multitable snapshot

This must remain report-only and must not become a fact source.

## Review Contract for Future Runtime PRs

Ask Claude for independent review when PR1 or later arrives. Review should check:

1. Planned producer and actual producer are not conflated.
2. Preview route is read-only until PR4/PR5 is explicitly authorized.
3. No multitable formula or view reads `attendance_*` directly.
4. No direct `meta_*` writes.
5. No new `attendance_*` migration unless the PR explicitly owns policy storage.
6. Period resolution is deterministic for month/quarter/year/payroll/custom modes.
7. Missing schema or missing assignments do not silently return all-zero success without a degraded signal.
8. Strong-control save blocking is absent unless the user explicitly opted in for that PR.

## Test Plan by Stage

| Stage | Required tests |
| --- | --- |
| PR1 helpers | month/quarter/year boundaries, leap year, inclusive dates, planned minutes per shift, calendar holiday skip/override, cap comparison. |
| PR2 preview route | 400 validation, admin guard, planned vs actual metric separation, empty scope, missing schedule schema degraded, stable sort, no writes. |
| PR3 UI | period/scope controls, planned/actual toggle, warning rendering, degraded rendering, no save/block controls. |
| PR4 weak warning | warning appears on impacted save preview, continue path works, operation log records warning, non-impacted saves unchanged. |
| PR5 strong block | blocked save returns violation details, every write path covered, scheduler-scope and conflict guard still run, disabled policy is inert. |
| PR6 report snapshot | rebuildable snapshot, source fingerprint excludes synced_at, duplicate row-key handling if multitable is used. |

## Verification Commands for Runtime PRs

For code PRs touching this domain:

```bash
node --check plugins/plugin-attendance/index.cjs

pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-advanced-scheduling-workbench.test.ts \
  tests/unit/attendance-scheduling-assignment-conflict.test.ts \
  tests/unit/attendance-report-field-catalog.test.ts \
  tests/unit/attendance-report-field-formula-engine.test.ts \
  --reporter=dot

NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run \
  tests/attendance-admin-regressions.spec.ts \
  tests/attendance-admin-anchor-nav.spec.ts \
  --watch=false

pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/core-backend build
git diff --check
```

Docs-only PR0 only needs markdown diff review, staged secret scan, and `git diff --check`.

## Open Questions

| Question | Recommendation |
| --- | --- |
| Where should policies be stored? | Settings JSON for read-only preview; dedicated table before strong control. |
| Should caps be per user or aggregate team cap? | Start per user; aggregate team cap is a later staffing-capacity feature. |
| Should leave reduce planned cap? | Defer. Leave affects actual attendance and availability, but policy treatment varies by customer. |
| Should overtime approvals increase cap? | Defer. Treat as actual-hours reporting first, not planned-cap mutation. |
| Can schedule groups own policies? | Yes, but only after scheduler-scope semantics are stable. |
| Can payroll cycles be the default period? | Yes for payroll reporting; month/quarter/year remain required to match comprehensive-hours regulation language. |

## Out of Scope

- Human-cost / revenue ratio (`人件费率`)
- schedule grid editing
- copy/paste scheduling
- Excel schedule import/export
- temporary line-draw shifts
- dispatch / cross-group support scheduling
- AI or optimized scheduling suggestions
- payroll calculation engine

These are adjacent DingTalk advanced-scheduling capabilities, not prerequisites for comprehensive working-hours preview.
