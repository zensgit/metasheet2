# Multitable automation cron parser — dev & verification (2026-06-28)

> Status: built + locally verified. Slice: post-light-up automation maturity follow-up after
> `schedule.date_field`, `form.submitted`, and `start_approval` landed on main.

## Scope

The previous automation scheduler treated `schedule.cron` as a small set of fixed intervals. That meant common
wall-clock cron expressions either drifted (`15 9 * * *` approximated as a cadence) or were rejected outright
(`0 12 1 */2 *`). This slice changes only the scheduler substrate:

- cron triggers now compute the next matching UTC minute and use a one-shot timeout that reschedules after firing;
- interval triggers and date-field scans continue using fixed `setInterval` cadences;
- both backend `triggerConfig.expression` and editor-emitted `triggerConfig.cron` are accepted as the expression source;
- no action execution, permissions, webhook ingress, destructive actions, or UI behavior changed.

## Supported v1 cron shape

Five-field UTC cron:

- minute, hour, day-of-month, month, day-of-week;
- `*`, `*/N`, `A-B`, `A,B`, and `A-B/N`;
- numeric fields only; day-of-week accepts `0` or `7` for Sunday;
- when both day-of-month and day-of-week are restricted, either can match (standard cron behavior).

Deferred: time-zone-aware scheduling, seconds field, named months/weekdays, `L`, `W`, `#`, and Quartz syntax.

## Verification

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts --reporter=dot`
  - 194/194 passed.
  - Added goldens:
    - complex cron (`0 12 1 */2 *`) registers instead of being treated as unsupported;
    - editor-emitted `triggerConfig.cron` registers;
    - `15 9 * * *` fires exactly at the next matching UTC wall-clock minute under fake timers;
    - list/range/step fields compute the expected next occurrence;
    - day-of-week `7` is treated as Sunday inside ranges;
    - invalid syntax still fail-closes to `null`.
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-scheduler-leader.test.ts tests/unit/automation-scheduler-metrics.test.ts --reporter=dot`
  - 10/10 passed.
- `pnpm --filter @metasheet/core-backend build`
  - TypeScript clean.
