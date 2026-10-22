# Attendance report calendar boundaries — 2026-10-22

Refs #6001. Baseline: main `4c78e75a0d1a96743c0b5b0ee9c8e8f059e99e3d`.

Reports use the existing loaded-record timezone context: a single valid IANA
zone across the currently loaded records. This is not a census of all report
pages and must not be described as an organization-wide timezone.

- Compute this week (Monday–Sunday), this month, last month, this quarter,
  and the initial today-minus-30-calendar-days range from that IANA calendar.
  UTC arithmetic operates only on date-only keys, never on elapsed local days.
- Before records resolve a zone, preserve the existing initial browser range
  but label that source explicitly. Disable automatic presets without a unique
  valid record zone. Manual dates remain available. No invented UTC/rule fallback.
- Align the pristine initial range once after records load; preserve a user's
  edits even during loading. Refetch all report aggregates and records after
  alignment. A preset captures its zone before refresh clears the old records.
- Initial requests may discover record context using the explicitly labelled
  browser range. Only the aligned reload is final evidence for an automatic
  attendance-calendar range; unavailable/mixed contexts retain explicit copy.
- A response for the old target cannot align the new target. Dataset freshness
  remains tied to the request snapshot; stale exports stay blocked. Manual date
  edits for the same target can still be replaced with a calendar shortcut.
- Do not change overview/server-clock semantics, report permissions, backend
  date validation, scheduler, or any feature flags.

## Gates

| Gate | Required evidence |
| --- | --- |
| Baseline reproduction | Real mounted view fails date/preset assertions |
| Calendar unit | UTC+14/-12, month/year/quarter/week, leap day, DST |
| View integration | Aligned default and all presets, source copy, mixed/invalid/missing, edits during request, export/filter neighbors |
| Mutation | Replacing IANA calendar with browser/UTC gives named assertion failures, restore |
| Web wiring | Domain guard and required web runner both execute new tests |
| Quality | pnpm validate:all; required web lane; exact-head required CI |
| UI | Synthetic local render/screenshot, no real UAT |

Keep Draft. Stream/lifecycle OFF. No merge, deployment, real UAT or 50004.

## Local validation at the reviewed source

- Baseline mounted view: 11 assertion failures (date boundaries, disabled state
  and new explanatory copy); no runtime/setup failure counted as a reproduction.
- Follow-up query-target race: one named assertion failure before its fix; the
  13 filtered cases were excluded, not passed.
- Focused and neighboring checks: 8 files, 114/114, zero excluded.
- UTC-substitution mutation: 9 named failures and 7 controls. Removing the
  request-snapshot guard: one named failure, 14 excluded. Both restored exactly.
- Restored new suites: 31/31; America/New_York process repeat: 31/31.
- Focused ESLint and `pnpm validate:all`: exit 0 (plugin, lint, backend and
  frontend/verification type checks).
- Synthetic Chrome component preview: aligned default, preset and unresolved-zone
  checks passed; desktop/mobile screenshots use the real application style sources.
  No live backend/provider was contacted; no real UAT is implied.
- Full required web lane: initial run stopped on the unchanged approval member-bar
  positive control at its existing 15-second timeout (788 other assertions passed
  in that batch). The same failure reproduced standalone (26/27 passed). Moving
  the component import into test collection preserves every assertion and the
  15-second limit; member-bar/current-node now pass 36/36 and instance-consistency
  passes 39/39. Full-lane, follow-up quality and exact-head CI remain pending
  until their terminal results are recorded in the PR.
