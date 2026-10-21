/**
 * Out-of-process "browser timezone" probe for multitable date-times (客户反馈 2026-09-24 #4c).
 *
 * Run as its OWN process with an explicit `TZ` in its environment (see
 * multitable-datetime-business-tz.spec.ts): Node reads `TZ` once at startup, which is the only reliable
 * way to give the code under test a different "browser" zone — mutating `process.env.TZ` inside an
 * already-running vitest worker does not reliably re-derive ICU's zone (same finding as
 * dateOnlyTzProbe.ts / GATE-5047 P2-1).
 *
 * Prints ONE JSON line: what this process's zone actually is, what the NEW business-timezone helpers
 * produce, and — computed independently here, NOT through the module under test — what the OLD
 * browser-local code produced, so the spec can prove the probe really sees a zone change.
 */
import {
  dateTimeInputValue,
  dateTimeValueFromInput,
  formatFieldDisplay,
} from '../../src/multitable/utils/field-display'
import { dateTimeZoneHint, getBusinessTimezone } from '../../src/multitable/utils/business-timezone'
import type { MetaField } from '../../src/multitable/types'

const STORED = '2026-09-24T01:00:00.000Z' // 09:00 Beijing
const dateTimeField = { id: 'fld_dt', name: 'When', type: 'dateTime', property: { timezone: 'UTC' } } as MetaField
const bareDateTimeField = { id: 'fld_dt2', name: 'When', type: 'dateTime' } as MetaField
const createdTimeField = { id: 'fld_ct', name: 'Created', type: 'createdTime' } as MetaField
const modifiedTimeField = { id: 'fld_mt', name: 'Modified', type: 'modifiedTime' } as MetaField

// The pre-fix browser-local editor helpers, reproduced verbatim as the negative control.
function oldDateTimeInputValue(value: string): string {
  const date = new Date(value)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
function oldDateTimeValueFromLocalInput(value: string): string {
  return new Date(value).toISOString()
}
function oldCreatedTimeDisplay(value: string): string {
  return new Date(value).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

process.stdout.write(
  JSON.stringify({
    tzEnv: process.env.TZ ?? null,
    resolvedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offsetMinutes: new Date(STORED).getTimezoneOffset(),
    businessTimezone: getBusinessTimezone(),
    // NEW path — must be identical in every process zone.
    display: formatFieldDisplay({ field: dateTimeField, value: STORED }),
    displayBareField: formatFieldDisplay({ field: bareDateTimeField, value: STORED }),
    displayAfternoon: formatFieldDisplay({ field: dateTimeField, value: '2026-09-24T13:05:00.000Z' }),
    displayMidnight: formatFieldDisplay({ field: dateTimeField, value: '2026-09-23T16:00:00.000Z' }),
    displayCreatedTime: formatFieldDisplay({ field: createdTimeField, value: STORED }),
    displayModifiedTime: formatFieldDisplay({ field: modifiedTimeField, value: '2026-09-24T15:59:00.000Z' }),
    inputValue: dateTimeInputValue(STORED),
    parsed: dateTimeValueFromInput('2026-09-24 09:00'),
    parsedT: dateTimeValueFromInput('2026-09-24T09:00'),
    roundTrip: dateTimeValueFromInput(dateTimeInputValue(STORED)),
    hintZh: dateTimeZoneHint(getBusinessTimezone(), true),
    hintEn: dateTimeZoneHint(getBusinessTimezone(), false),
    // OLD path — independently computed negative control.
    oldInputValue: oldDateTimeInputValue(STORED),
    oldParsed: oldDateTimeValueFromLocalInput('2026-09-24T09:00'),
    oldCreatedTime: oldCreatedTimeDisplay(STORED),
  }),
)
