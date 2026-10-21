/**
 * Out-of-process "browser timezone" probe for the surfaces PR #6083 deferred (客户反馈 2026-09-24 #4c follow-up):
 * calendar / timeline / Gantt day bucketing, event timestamps (history, logs, notifications, comments) and
 * lookup-of-dateTime display / export.
 *
 * Run as its OWN process with an explicit `TZ` (see multitable-datetime-deferred-surfaces.spec.ts): Node reads
 * `TZ` once at startup, the only reliable way to give the code under test a different "browser" zone (same
 * finding as multitableBusinessTzProbe.ts / dateOnlyTzProbe.ts).
 *
 * Prints ONE JSON line: this process's zone, what the NEW helpers produce, and — computed independently here,
 * NOT through the modules under test — what the OLD browser-local / UTC-day code produced, so the spec can prove
 * the probe really sees a zone change.
 */
import {
  businessTodayKey,
  dateTimeValueDayKey,
  formatBusinessTimestamp,
  getBusinessTimezone,
  zoneDayRangeUtcMs,
} from '../../src/multitable/utils/business-timezone'
import { dateTimeExportText, formatFieldDisplay, viewDayZone, viewTodayKey } from '../../src/multitable/utils/field-display'
import { evaluateRule } from '../../src/multitable/utils/conditional-formatting'
import { setLookupTargetFields } from '../../src/multitable/utils/lookup-target-fields'
import { configHistoryTime } from '../../src/multitable/utils/meta-config-history-labels'
import type { MetaField } from '../../src/multitable/types'

// 2026-09-24 01:00 北京时间 — the UTC day (09-23) and a New York browser's day (09-23) both differ from it.
const EARLY_MORNING = '2026-09-23T17:00:00.000Z'
// 2026-09-24 21:05:07 北京时间 — a 12-hour locale would print "9:05:07 PM".
const EVENING = '2026-09-24T13:05:07.000Z'

const dateTimeField = { id: 'fld_dt', name: 'When', type: 'dateTime', property: { timezone: 'UTC' } } as MetaField
const lookupField = {
  id: 'fld_lookup_dt',
  name: 'Due (lookup)',
  type: 'lookup',
  property: { linkFieldId: 'fld_link', targetFieldId: 'fld_due', foreignSheetId: 'sheet_orders' },
} as MetaField
setLookupTargetFields({ fld_lookup_dt: { type: 'dateTime', property: { timezone: 'UTC' } } })

const zone = viewDayZone(dateTimeField)

// 2026-09-24 01:30 北京时间 (UTC day 09-23): the conditional-formatting / view-today "now".
const NOW = Date.parse('2026-09-23T17:30:00.000Z')
// 2026-09-23 23:30 北京时间: YESTERDAY in the business zone, "today" by the UTC day and a New York browser's day.
const LATE_YESTERDAY = '2026-09-23T15:30:00.000Z'
const cfRule = (operator: string) => ({ id: 'r', order: 0, fieldId: 'f', operator, style: { backgroundColor: '#ff0000' }, enabled: true }) as never
const cfDateTimeField = { ...dateTimeField, id: 'f' } as MetaField
const cfDateField = { id: 'f', name: 'D', type: 'date' } as MetaField
const historyRange = zoneDayRangeUtcMs('2026-09-24')

// OLD paths, reproduced verbatim as the negative control.
function oldBrowserDayKey(value: string): string {
  const d = new Date(value)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

process.stdout.write(
  JSON.stringify({
    tzEnv: process.env.TZ ?? null,
    resolvedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offsetMinutes: new Date(EARLY_MORNING).getTimezoneOffset(),
    businessTimezone: getBusinessTimezone(),
    // NEW paths — must be identical in every process zone.
    viewDayZone: zone,
    calendarDay: zone ? dateTimeValueDayKey(EARLY_MORNING, zone) : null,
    calendarDayEvening: zone ? dateTimeValueDayKey(EVENING, zone) : null,
    businessToday: businessTodayKey(getBusinessTimezone(), Date.parse(EARLY_MORNING)),
    timestampMinute: formatBusinessTimestamp(EVENING),
    timestampSecond: formatBusinessTimestamp(EVENING, { precision: 'second' }),
    timestampDay: formatBusinessTimestamp(EARLY_MORNING, { precision: 'day' }),
    timestampPgText: formatBusinessTimestamp('2026-09-24 13:05:07.123456+00', { precision: 'second' }),
    historyTimeText: configHistoryTime(EVENING, true).slice(0, 19),
    lookupDisplay: formatFieldDisplay({ field: lookupField, value: [EARLY_MORNING, EVENING] }),
    lookupExport: dateTimeExportText(lookupField, [EARLY_MORNING, EVENING]),
    viewTodayDate: viewTodayKey({ type: 'date' }, NOW),
    cfDateTimeIsToday: evaluateRule(cfRule('is_today'), { f: LATE_YESTERDAY }, cfDateTimeField, { now: NOW }),
    cfDateTimeOverdue: evaluateRule(cfRule('is_overdue'), { f: LATE_YESTERDAY }, cfDateTimeField, { now: NOW }),
    cfDateIsToday: evaluateRule(cfRule('is_today'), { f: '2026-09-24' }, cfDateField, { now: NOW }),
    historyFrom: historyRange ? new Date(historyRange.startMs).toISOString() : null,
    historyTo: historyRange ? new Date(historyRange.endMs - 1).toISOString() : null,
    // OLD paths — independently computed negative control.
    oldUtcDay: new Date(EARLY_MORNING).toISOString().slice(0, 10),
    oldBrowserDay: oldBrowserDayKey(EARLY_MORNING),
    oldTimestamp: new Date(EVENING).toLocaleString('en-US'),
  }),
)
