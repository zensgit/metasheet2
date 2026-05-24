# Attendance Advanced Scheduling Benchmark Matrix - Development

Date: 2026-05-23
Branch: `codex/attendance-advanced-scheduling-benchmark-matrix-20260523`
Scope: docs-only product / engineering decision matrix.

## Summary

This document turns the DingTalk advanced-scheduling research into a current
MetaSheet execution matrix. It is intentionally **not** a backlog that starts
new write-path work. Its job is to answer:

1. What DingTalk advanced scheduling capabilities do we already cover?
2. Where do we partially cover the same user need through a different MetaSheet
   architecture?
3. Which gaps are safe read-only follow-ups?
4. Which gaps are new scheduling write paths and must not begin without a fresh
   explicit opt-in?

The immediate recommendation is:

- Keep PR5 comprehensive-hours production observation running to completion.
- Do not start comprehensive-hours PR6 reporting / multitable snapshot by
  default.
- For advanced scheduling, continue only with docs or read-only diagnostics
  unless the user explicitly authorizes a write-path slice.

## Source Basis

| Source | Use |
| --- | --- |
| `docs/research/dingtalk-advanced-scheduling-vs-metasheet2-20260522.md` | Primary DingTalk text extraction and 12-chapter capability inventory. |
| `docs/development/attendance-advanced-scheduling-readonly-workbench-*.md` | Current shipped read-only scheduling workbench boundary. |
| `docs/development/attendance-advanced-scheduling-workbench-truncation-verification-20260522.md` | Follow-up that made detail-row truncation visible. |
| `docs/development/attendance-advanced-scheduling-workbench-aggregate-accuracy-verification-20260522.md` | Follow-up that moved top metrics and per-group coverage to full aggregate counts. |
| `docs/operations/attendance-advanced-scheduling-workbench-runbook.md` | Operator-facing guidance for the shipped read-only workbench. |
| `docs/development/attendance-advanced-scheduling-workbench-runbook-verification-20260524.md` | Docs-only verification for the operator runbook. |
| `docs/development/attendance-comprehensive-hours-pr0-pr5-closeout-20260523.md` | Comprehensive-hours PR0-PR5 closeout and PR6 deferral discipline. |
| `plugins/plugin-attendance/index.cjs` | Current route/schema evidence for scheduling groups, scheduler scopes, shift/rotation assignments, read-only workbench, and comprehensive-hours preview. |
| `apps/web/src/views/AttendanceView.vue` | Current admin UI evidence for advanced scheduling read-only workbench and comprehensive-hours controls. |

Important source limitation: the DingTalk handbook screenshots were not
available in the local text extraction. The current research is strong enough
for capability mapping, but not for pixel-level UI cloning or exact default
field/value replication.

## Current MetaSheet Scheduling Surface

| Area | Current state | Evidence |
| --- | --- | --- |
| Schedule groups | Shipped foundation tables/routes for schedule groups, group members, and scheduler scopes. | `attendance-advanced-scheduling-scope` tests and `plugins/plugin-attendance/index.cjs` scheduler-scope routes. |
| Shift / rotation assignments | Existing write routes for shifts, shift assignments, rotation rules, and rotation assignments. | `attendance_shift_assignments`, `attendance_rotation_assignments`, and existing admin sections. |
| Effective calendar | Resolver and preview/audit work has landed for group/rule-set context and holiday policy overlays. | `attendance-effective-calendar-*` docs. |
| Advanced scheduling overview | Read-only workbench shipped under the Scheduling rail. | `GET /api/attendance/advanced-scheduling/workbench`, `data-attendance-advanced-scheduling-workbench`. |
| Workbench truncation | Detail rows are capped samples but no longer silently mislead. | `metadata.truncation` / `metadata.sampling`, frontend truncation warning. |
| Workbench aggregate accuracy | Top metrics and per-group coverage use aggregate counts, not sample rows. | `summary.shiftAssignments` / `summary.rotationAssignments`, per-group `shiftAssignmentCount` / `rotationAssignmentCount`, and aggregate verification MD. |
| Workbench operator guidance | Operator runbook is now available for the read-only dashboard. | `docs/operations/attendance-advanced-scheduling-workbench-runbook.md` (#1804). |
| Comprehensive-hours control | PR0-PR5 shipped read-only preview, weak warning, and opt-in strong save control. | `attendance-comprehensive-hours-pr0-pr5-closeout-20260523.md`. |
| Scheduling write UX | Existing lower-level forms remain. Dense grid edit, copy/paste, Excel import, temporary shifts, and dispatch are not opened by the read-only workbench. | Read-only workbench development boundary. |

## DingTalk Advanced Scheduling Benchmark Matrix

| # | DingTalk capability | MetaSheet current posture | Status | Safe next action |
| --- | --- | --- | --- | --- |
| 1 | Small-organization / department-oriented schedule management | We have attendance groups and schedule groups, but no full department-tree scheduling cockpit. | Partial | Read-only grouping/coverage diagnostics are safe; department-tree edit UX requires opt-in. |
| 2 | Scheduling rules: compliance caps, one-day multi-shift, pre-entry-date guard, temporary shifts, punch restrictions, edit windows, post-leave modification rules, publish rules, unscheduled reminders | Pieces exist separately: rules/rule sets, assignment conflict guards, effective calendar, comprehensive-hours control. The full DingTalk-style rule cockpit is not present. | Partial | Only read-only rule coverage / missing-rule diagnostics are safe now. Rule editing/publish workflow is a new write path. |
| 3 | Scheduler delegation / scheduler roles | Scheduler scopes foundation exists, but full delegated scheduler UI and enforcement model are not yet a complete product surface. | Partial | Read-only scope diagnostics and role-coverage matrix are safe. Enforcement of scheduler scope on new bulk/grid writes requires explicit opt-in. |
| 4 | Schedule teams /班组 and Excel team import | Schedule groups exist and cover part of the use case; Excel team import/update is not a delivered scheduling workflow. | Partial | Docs/runbook or read-only import-readiness checks are safe. Excel write/import flow is a new write path. |
| 5 | Rotation cycle 2-31 days plus skip/advance behavior | Rotation rules exist and map closely to DingTalk cycle scheduling; skip/advance semantics require exact product confirmation. | Partial-to-strong | Read-only preview/audit of generated rotation calendars is safe. Changing generation semantics requires a product decision. |
| 6 | Dispatch / support: permanent, day-level, hourly support, shift swaps | Not present as a first-class dispatch object. | Missing | Do not start. This is a new product line with approval, cost allocation, and effective-calendar implications. |
| 7 | Hardware/device department binding | Not aligned with MetaSheet product direction. | Out of scope | Do not clone. If customer needs device-aware punch routing, handle as a separate integration RFC. |
| 8 | Scheduling permission settings with named permission scopes | Scheduler scopes foundation exists; full named permission profiles + management ranges are not a mature admin product. | Partial | Read-only scope audit and diagnostics are safe. Any enforcement or role-management UI must be explicit opt-in. |
| 9 | Operation logs | MetaSheet has broad audit surfaces; scheduling-specific operations can be queried but are not packaged as a DingTalk-like specialized log view. | Partial/advantage | Read-only scheduling operation log filter/view is a safe candidate. |
| 10 | Comprehensive-hours monthly/quarterly/yearly cap, weak or strong control | Shipped through PR0-PR5: read-only preview, strict input validation, admin UI, weak save warnings, opt-in strong save block. | Strong | Observe production heartbeat; do not start PR6 reporting/snapshot without opt-in. |
| 11 | Labor-cost ratio / 人件费率: hourly cost profile, forecast/actual revenue, cost-rate trend charts | Not present. This is commercial strategy work, not a scheduling polish task. | Missing | Do not start under current line. Consider only after customer demand or product RFC. |
| 12 | Dispatch attendance reports and cross-group hour allocation | Attendance report-records and period-summary multitable layers exist; dispatch-specific cross-group allocation is missing. | Partial | Read-only analytical design is safe. Snapshot writers or payroll-impacting allocation require opt-in. |

## Where MetaSheet Can Exceed DingTalk

The target is not to clone DingTalk. The stronger MetaSheet strategy is:

1. **Composable report layer**: attendance report records, period summaries,
   formulas, fingerprints, and multitable views give users a custom analytics
   surface rather than fixed vendor reports.
2. **Transparent read-only diagnostics first**: the advanced scheduling
   workbench can expose data-quality, scope, truncation, and coverage issues
   before any editor exists.
3. **Explicit control posture**: comprehensive-hours PR4/PR5 split weak warning
   from strong blocking through an opt-in toggle. Future scheduling controls
   should keep this staged pattern.
4. **Integration-neutral architecture**: do not copy DingTalk-specific salary
   push or hardware binding unless a customer integration requires it. Keep ERP
   and multitable reporting paths generic.

## Safe Follow-Up Candidates

These are safe because they preserve the current read-only or docs-only
boundary.

| Candidate | Type | Why safe | Suggested acceptance |
| --- | --- | --- | --- |
| Advanced scheduling operator runbook | docs-only | Landed as #1804; keep it current as the read-only workbench evolves. | Docs-only updates only, no runtime changes, no write-path implication. |
| Live read-only workbench evidence | ops/docs | Calls only `GET /api/attendance/advanced-scheduling/workbench` on staging/prod with an admin token; no writes. | Evidence MD with redacted payload shape and diagnostics counts. |
| Additional read-only diagnostics | backend read-only | Adds diagnostic codes only; no editor, no assignment mutation. | Tests assert GET-only route remains the only workbench route. |
| Scheduling operation-log filter | frontend/backend read-only | Reuses existing audit log data to show schedule/dispatch-related operations. | No new write route, no migration, no assignment change. |
| Rotation calendar preview audit | read-only | Helps validate cycle/skip semantics without changing generation. | Preview route or existing read-only section, explicit no-save copy. |

## Locked Until Explicit Opt-In

These are not safe to start automatically.

| Locked item | Why locked |
| --- | --- |
| Dense user x date scheduling grid with edits | New high-impact scheduling write UX. |
| Copy/paste, copy last week/month, Excel schedule import | Bulk write path, needs conflict guard and rollback design. |
| Temporary / line-drawn shifts | Creates shifts implicitly and changes assignment semantics. |
| One employee with multiple shifts per day | Likely schema/uniqueness and effective-calendar changes. |
| Publish workflow / draft assignments / approval-to-publish | Crosses scheduling, approval, and audit semantics. |
| Dispatch / shift swap / hourly support | New domain objects and payroll/report allocation implications. |
| Labor-cost ratio module | New commercial module with wage profile and revenue data. |
| Comprehensive-hours PR6 reporting / multitable snapshot | Explicitly deferred in the PR0-PR5 closeout doc. |

## Recommended Next Step

During the PR5 24-hour heartbeat window, the best next action is still
low-risk:

1. Let the heartbeat finish.
2. Treat the advanced scheduling operator runbook as complete (#1804) and keep
   any further work docs-only or read-only unless explicitly opted in.
3. If a code slice is desired after heartbeat PASS, pick one read-only
   diagnostic improvement and require a short design lock before coding.

No scheduling write path should start from this matrix alone.
