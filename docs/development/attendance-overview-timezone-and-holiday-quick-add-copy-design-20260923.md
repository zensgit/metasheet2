# Attendance overview timezone label and holiday quick-add copy

Date: 2026-09-23
Issues: #5962, #5979
Base: `origin/main` (independent of other open attendance fix PRs)

## Problem

Two display bugs on current attendance UI. Neither changes punch, settlement, or calendar-policy calculation.

1. **#5962.** Employee overview 「工作时间」 prints the raw IANA id from `runtimeRule.timezone` (`UTC`, `Asia/Shanghai`). Summary, calendar, request, and anomaly hints on the same page print `formatTimezoneLabel` (`UTC+00:00 · UTC`, `UTC+08:00 · Asia/Shanghai`). A default-rule `UTC` therefore looks like a different zone from the sibling `UTC+00:00 · UTC` hint.
2. **#5979.** Schedule-group holiday quick-add validation copy says 「有效天数」 / `valid day counts`. The form has no such field. The inputs are 「基础休息天数」 / `Base rest days` and 「目标休息天数」 / `Target rest days`.

## Decision

### Timezone presentation (#5962)

Use the existing offset label. Do not add a timezone setting and do not change `DEFAULT_RULE.timezone`.

`formatTimezoneLabel` in `apps/web/src/utils/timezones.ts` is already what overview hints use through `displayTimezone` (`UTC±HH:MM · IANA`). The work-window line uses that same helper:

- Recognized zone: `{start}-{end} · {formatTimezoneLabel(zone)}`
  - `UTC` → `09:00-18:00 · UTC+00:00 · UTC`
  - `Asia/Shanghai` → `09:00-18:00 · UTC+08:00 · Asia/Shanghai`
- The clock range stays before the first `·`, so overview chrome (`workWindowShortLabel`, `suggestOffDutyTime`) still reads only the clock window.
- Empty or unrecognized zone: omit the suffix. Context hints keep their existing 「规则时区不可用」 sentence. The work window does not fall back to a raw IANA string.

The timezone token on the work window is then the same string as the token inside summary, calendar, request, and anomaly hints for that rule zone.

### Holiday quick-add copy (#5979)

Change only the incomplete-form `statusMessage` pair in `AttendanceCalendarPolicyQuickAdd.vue`. Leave `buildHolidayLengthCalendarPolicyOverride` alone.

| Case | Copy |
| --- | --- |
| Other invalid input, target rest days not greater than base | Name, group, base rest days, and target rest days |
| Other invalid input while target rest days is greater than base | Those fields, plus a valid base rest start date |

Field labels stay 「基础休息天数」 / 「目标休息天数」 / 「基础休息起始日期」. The start-date hint already uses those names. No new field and no new hint dialect.

## Non-goals

- Punch contract, settlement timezone, or the platform default rule zone.
- Calendar-policy override semantics, including longer-rest date math.
- A new user-facing timezone preference.
