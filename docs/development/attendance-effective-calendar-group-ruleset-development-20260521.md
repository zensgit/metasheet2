# Attendance Effective Calendar Group Rule Set Development

Date: 2026-05-21
Branch: `codex/attendance-effective-calendar-group-ruleset-20260521`
Base: `origin/main@3a03b7cf6`

## Summary

This slice closes the effective-calendar `groupId` mode limitation where the
base profile always used the organization default attendance rule. When an
attendance group has `attendance_groups.rule_set_id`, `GET/POST
/api/attendance/effective-calendar` now uses that rule set's `config.rule` as
the group-mode base profile.

The change is intentionally read-only and resolver-scoped. It does not change
`userId` calculation-chain behavior, import commit behavior, punch writeback,
or any `attendance_*` schema.

## Delivered

- `loadAttendanceGroupByIdOrCode()` now loads `rule_set_id` and maps it to
  `ruleSetId`.
- Older environments that lack `attendance_groups.rule_set_id` fall back to the
  pre-existing group lookup shape instead of returning a false `Group not
  found`.
- The group-mode resolver treats missing rule-set schema as `null`, matching
  the resolver's read-only posture without changing other rule-set callers.
- `resolveEffectiveCalendar()` applies `normalizeRuleOverride(config.rule)` to
  the default rule when the current mode is `groupId` and the group has a rule
  set.
- `groupId` timezone output now follows the same chain with the derived group
  rule profile before the group fallback timezone.

## Boundary

- No migration.
- No direct `meta_*` writes.
- No settings storage shape change.
- No frontend change.
- No `userId` calc-chain cutover for group rule sets. That is a separate
  product decision because it would affect punch/import/payroll materialized
  facts, not just read-only group preview.

## Behavior

Before:

| Mode | Group has rule set? | Saturday with default Mon-Fri rule | Output |
| --- | --- | --- | --- |
| `groupId` | yes, `workingDays: [6]` | default says rest | rest day |

After:

| Mode | Group has rule set? | Saturday with group `workingDays: [6]` | Output |
| --- | --- | --- | --- |
| `groupId` | yes | group rule says work | working day |
| `groupId` | no | default Mon-Fri says rest | rest day |

Calendar-policy layering is unchanged: group-source `calendarPolicy` overrides
still apply on top of the base profile and can override the final effective
workday.

## Tests Added

- `uses a group rule-set rule as groupId effective-calendar base profile`
  - proves `attendance_rule_sets.config.rule.workingDays` drives the group-mode
    base/effective value;
  - proves rule-set timezone is used before group timezone;
  - proves the resolver actually queries the referenced rule set.
- `keeps groupId mode on the default rule when the group has no rule set`
  - proves no rule-set lookup runs;
  - preserves pre-existing default-rule behavior.

## Follow-Up

If the product wants an employee's group-bound rule set to become the default
`userId` rule for punch/import/payroll, that should be a separate calc-chain
slice with integration coverage. This slice only fixes the read-only group
preview surface documented as a v1 limitation.
