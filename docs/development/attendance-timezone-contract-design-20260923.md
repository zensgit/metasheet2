# Attendance timezone contract (2026-09-23)

One attendance calendar: the IANA zone already used for punch work dates. Presets, CSV epoch days, and auto-absence `runAt` use that zone. They do not use the process-local clock or a bare UTC day from `Date#toISOString().slice(0, 10)`.

No new timezone settings surface. Holiday auto-sync stays the reference scheduler (`computeNextRunTime` + an explicit IANA zone).

## Source of truth

| Surface | Zone |
| --- | --- |
| Punch work date | `rule.timezone` via `toWorkDate` / `parseImportedPunchDateTime` |
| Auto-absence `runAt` | Each org’s default rule IANA (`loadDefaultRule`). Invalid identifiers fall back to `DEFAULT_RULE.timezone` (`UTC`), not the host TZ. |
| Report presets and the default from/to | The unique `workday_context.timezone` on the loaded report rows (the zone punch stored on those work dates). If rows are empty, mixed, or any row has no valid zone, presets stay off. Reports do not call `/api/attendance/rules/me` to fill that gap. |
| CSV date-column epoch | The import rule zone punch will bind: rule-set `rule.timezone` when `payload.ruleSetId` has a valid override, else the org default rule zone. If that zone is not a valid IANA id, `payload.timezone`, then `payload.groupSync.timezone`. If none resolve, the epoch is not a work date. |

`YYYY-MM-DD` (and the other non-epoch date shapes) stay calendar literals. They are not re-zoned.

## #5999 auto-absence

`scheduleAutoAbsence` groups orgs by default-rule IANA and arms one timeout per zone with `computeNextRunTime` (same helper as `scheduleHolidaySync`). After each tick it plans again from the zone, so the next fire stays on that zone’s wall clock across DST. It does not use `Date#setHours` or a fixed 24h interval.

`runAt` remains the single settings clock (`HH:mm`). The settings card states that this clock is each org’s default rule zone. There is no per-job timezone field.

Lookback still steps `offset * 24h` and then converts with `toWorkDate(rule.timezone)`. That day selection is unchanged.

## #6001 report ranges

`buildAttendanceReportRangePreset` / `buildAttendanceReportDefaultRange` (`apps/web/src/views/attendance/attendanceReportCalendar.ts`) compute date-only bounds with `Intl` parts in the attendance zone:

- Week starts Monday.
- Default window is 30 calendar days through today in that zone (not `now - 30 * 24h` in the browser zone).

After the report rows load, a still-pristine from/to is replaced with the 30-day window in that unique record zone and the report reloads once. A user edit or a preset click stops that replacement. Preset buttons stay disabled until the loaded rows share one valid zone. Calling `/api/attendance/rules/me` from reports mode is intentionally not the fallback: an incomplete record timezone must not be replaced by the signed-in rule.

## #6003 CSV epoch days

`normalizeCsvWorkDate` maps 10- and 13-digit epochs with `toWorkDate(instant, zone)`. It does not slice `toISOString()`. A missing zone yields a null work date and `workDateWarning` (`CSV date epoch requires an attendance IANA timezone`), which the import skip path already surfaces.

Per-day shift timezones that differ from the default rule are not applied to the epoch day: the work date is the key used to load that shift. Punch time-only values then bind to the work date with `rule.timezone`.

## Out of scope

- #5962 overview 「工作时间」 raw IANA vs `formatTimezoneLabel`. Display only; not this calendar contract.
- Backend `resolveAttendanceDateRange` UTC fallback when from/to are omitted (#5964). The report page sends explicit date-only bounds.
- `payload.timezone` does not override punch `rule.timezone`. Epoch days follow the punch rule zone so the work date and a time-only punch stay on the same calendar day.
