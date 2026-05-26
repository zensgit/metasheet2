# Advanced-Scheduling Rule-Set Preview-Divergence Diagnostic — Design + Verification — 2026-05-26

Read-only enhancement to the existing `GET /api/attendance/advanced-scheduling/workbench`:
a 6th diagnostic that surfaces a known **preview-semantics divergence** — a `groupId`-mode
preview applies the linked attendance group's `rule_set`, while the per-user
`effective-calendar` calc-chain intentionally does not. Informational only; it changes no
calculation. Verified against `plugins/plugin-attendance/index.cjs` at the PR head.

## Scope / non-scope

- **In:** one `info` diagnostic (`schedule_group_rule_set_preview_divergence`) + one read-only `SELECT` in the workbench route.
- **Out (unchanged):** no new route (the existing GET is enhanced), no UI edit (frontend renders diagnostics generically), no migration, no writer, no POST/PUT/PATCH/DELETE. **The auto-absence / working-hours / comprehensive-hours / effective-calendar calc-chains are untouched.**
- **This PR takes no position** on whether the userId calc-chain *should* adopt the group rule_set. That is a separate product/compliance decision; this slice only makes the existing divergence visible.

## The divergence (evidence)

In the scheduling preview resolver:

- **`mode === 'groupId'`** (`index.cjs:11452`): when the resolved attendance group has a `ruleSetId`, it loads the rule_set config and applies `groupRule = buildAttendanceRuleWithRuleSetOverride(defaultRule, ruleSetConfig)` (`:11462`) — the **rule_set override is applied**.
- **`mode === 'userId'`** (`index.cjs:11445`): loads the user's scope context + assignments + overlays; it does **not** apply any group rule_set override — the per-user effective-calendar resolution follows existing boundaries.

So a schedule group whose linked attendance group carries a rule_set will preview differently
by group than the actual per-user effective-calendar resolves. The diagnostic surfaces that.

## Data signal (read-only)

- `attendance_schedule_groups.attendance_group_id` → `attendance_groups.rule_set_id` (both columns already exist; no migration).
- Route adds: `SELECT id FROM attendance_groups WHERE org_id = $1 AND rule_set_id IS NOT NULL` (query form A — simplest; `attendance_groups` is small and the builder intersects against the active schedule groups anyway). Org-scoped, read-only.
- Builder (`buildAttendanceAdvancedSchedulingWorkbench`): new optional input `ruleSetAttendanceGroupIds` (defaults to `[]` → backward compatible). `scheduleGroupsWithRuleSetOverride` (`:7626`) = active schedule groups whose `attendanceGroupId` is in that set. If any, emit the diagnostic (`:7677`), appended **last** in the diagnostics array (preserves the existing order assertion).

## The diagnostic

- `code: schedule_group_rule_set_preview_divergence`, **`severity: info`** (it fires on every well-configured org that uses rule_sets — `warning` would be permanent noise; matches `user_mixed_assignment_kinds` which is `info` for the same by-design reason).
- `message`: "Schedule groups link to an attendance group with a rule_set override; group-mode preview applies the rule_set, while per-user effective-calendar resolution still follows existing boundaries (by design — calc chain unchanged)."
- `count` + `scheduleGroupIds` of the affected active schedule groups.

## Frontend

No change. `AttendanceView.vue` (`:4432`) renders diagnostics in a generic `v-for` loop —
`{{ diagnostic.message }} · {{ diagnostic.count }}`, keyed by `code`, with no fix button — so
the new diagnostic appears automatically with its server message. Verified by reading the
template; no FE diff and (by requirement) no fix affordance.

## Tests (workbench test file, 8/8; 4 new)

- **Positive:** schedule group whose `attendanceGroupId ∈ ruleSetAttendanceGroupIds` → diagnostic present, `severity:info`, `count:1`, correct `scheduleGroupIds`, message contains "by design".
- **Negative:** linked attendance group not in the rule_set set → diagnostic absent (no false positive).
- **Backward compat:** no `ruleSetAttendanceGroupIds` input, and group without `attendanceGroupId` → diagnostic absent; the existing diagnostics-order assertion still passes.
- **Source guard:** the new query matches the read-only `SELECT … rule_set_id IS NOT NULL`; the workbench GET handler **region** contains no `INSERT INTO`/`UPDATE`/`DELETE FROM` (scoped to the handler — the file legitimately writes `attendance_groups` elsewhere via group sync).

## Verification run

- `attendance-advanced-scheduling-workbench.test.ts`: 8/8 (existing 4 unchanged + 4 new).
- Full core-backend unit suite: 2320/2320.
- `tsc` (build:cache): clean.

## Cross-references

- `docs/operations/attendance-advanced-scheduling-workbench-runbook.md` — the workbench operator runbook (this adds one diagnostic to it).
- `[[attendance-multitable-report-boundary]]`, `[[skip-when-unreachable-blind-spot]]`.
