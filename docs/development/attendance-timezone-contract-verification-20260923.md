# Attendance timezone contract — verification (2026-09-23)

> Design: `docs/development/attendance-timezone-contract-design-20260923.md`
> Issues: #5999, #6001, #6003
> Base: `main` @ `261835ad2`
> Evidence: local vitest. Host clock is UTC, so browser-local and `Asia/Shanghai` calendar days are distinguishable. Values-free.

## Verdict

PASS for the three timezone-family claims in this change:

- Auto-absence `runAt` is armed with `computeNextRunTime` in each org default-rule IANA zone, including a DST spring-forward.
- Report presets and the pristine default from/to use the unique record `workday_context.timezone`. Reports mode does not call `/api/attendance/rules/me`.
- CSV 10- and 13-digit date epochs become the punch work date in that attendance zone. A missing zone is not a UTC day slice.

Not a merge, deploy, or product-acceptance verdict.

#5962 (overview 「工作时间」 raw IANA vs offset label) is left for a follow-up. It is display-only and an existing overview spec pins the raw IANA string.

## Commands and results

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-timezone-contract.test.ts --watch=false
# Test Files  1 passed (1)
# Tests  4 passed (4)

pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendance-report-calendar.spec.ts \
  tests/attendance-reports-analytics.spec.ts \
  tests/attendance-selfservice-dashboard.spec.ts
# Test Files  3 passed (3)
# Tests  98 passed (98)
```

The self-service file includes the existing assertion that a report row without a historical timezone does not substitute `/api/attendance/rules/me`. That assertion failed on an earlier draft that loaded the signed-in rule from reports mode, and passed after that fallback was removed.

`[Vue warn] injection "Symbol(router)" not found` in these AttendanceView mounts is pre-existing and did not fail a test.

## What each test pins

| Claim | Pin |
| --- | --- |
| Shanghai `00:15` is `16:15Z` the same UTC date, not `setUTCHours` on the next UTC day | `computeAutoAbsenceNextRunAt` |
| `America/Los_Angeles` just after `2026-03-08T08:16Z` next-runs at `2026-03-09T07:15Z` (PDT), not +24h | same |
| Two orgs arm two delays (15 min and 15h15m), not one process-local 24h timer | `scheduleAutoAbsence` fake timers |
| Epoch `2026-09-22T16:30Z` is `2026-09-23` in Shanghai and `2026-09-22` in UTC; `YYYY-MM-DD` stays literal; no zone yields null plus `CSV date epoch requires an attendance IANA timezone` | `normalizeCsvWorkDate` / `iterateImportRowsFromCsv` |
| Rule-set override beats org default; without `ruleSetId`, org default beats payload and group | `resolveImportCsvCalendarTimeZone` |
| `2026-09-27T16:30Z` this-week is `2026-09-28..2026-10-04` in Shanghai and `2026-09-21..2026-09-27` in UTC | `attendance-report-calendar.spec.ts` |
| Same instant, this-month / last-month / this-quarter follow the Shanghai calendar (October / September / Q4) | same |
| Default window is 30 calendar days, not `now - 30 * 24h` | same |
| Reports UI applies that Shanghai week and default window from record timezone, and preset buttons stay enabled | `attendance-reports-analytics.spec.ts` |

## Not verified here

- No browser pass of the admin settings card. The run-at hint is static copy in the admin settings template (`data-auto-absence-timezone-hint`). Scheduling behavior is covered by the plugin unit test.
- Full `pnpm test` / `pnpm validate:all` was not run. The change is confined to the attendance plugin, the report calendar helper, and the two Vue surfaces above.
- Holiday auto-sync was not modified. It remains the reference `computeNextRunTime` path.

## Open questions

- #5962 stays out. Overview 「工作时间」 still prints the raw IANA id; other blocks use the offset label.
- Backend `resolveAttendanceDateRange` still falls back to a UTC `toISOString` day when from/to are omitted (#5964). The report page sends explicit date-only bounds.
- `payload.timezone` does not override punch `rule.timezone`. Epoch days follow the punch rule zone so a time-only punch stays on the same calendar day. If the import form timezone should win, punch parsing has to change with it.
- A per-day shift timezone that differs from the default rule is not applied when converting a CSV epoch to `workDate`. The work date is the key used to load that shift.
- Auto-absence lookback still steps `offset * 24h` and then `toWorkDate`. A DST day can change which calendar day is scanned. Unchanged.
- Report rows with no unique valid `workday_context.timezone` keep the browser-local initial from/to and disable presets. They do not call `/api/attendance/rules/me`.
- The first report fetch can still use that browser-local window. After rows load, a pristine from/to is replaced once and the report reloads.
- Holiday sync still uses a 24h `setInterval` after the first IANA delay. Auto-absence re-plans with `computeNextRunTime` after every tick.
