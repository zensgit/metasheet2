/**
 * Out-of-process "server timezone" probe for multitable date-time parsing (客户反馈 2026-09-24 #4c, PR #6083
 * review S1). Run as its OWN process with an explicit `TZ` in its environment (see
 * multitable-datetime-wall-clock.test.ts): Node reads `TZ` once at startup, which is the only reliable way to
 * put the code under test in a different process zone.
 *
 * Prints ONE JSON line: what this process's zone is, what the NEW zone-aware parsers produce, and — computed
 * here, NOT through the module under test — what the OLD `new Date(text)` path produced, so the spec can prove
 * the probe really sees a zone change.
 */
import { formatDateTimeValue, parseDateTimeText } from '../../src/multitable/date-time-wall-clock'
import { coerceBatch1Value, validateDateTimeValue } from '../../src/multitable/field-codecs'

const WALL = '2026-09-24 09:00' // 09:00 Beijing = 2026-09-24T01:00:00.000Z
const STORED = '2026-09-24T01:00:00.000Z'

const parsed = parseDateTimeText(WALL, 'Asia/Shanghai')

process.stdout.write(
  JSON.stringify({
    tzEnv: process.env.TZ ?? null,
    offsetMinutes: new Date(STORED).getTimezoneOffset(),
    businessTimezoneEnv: process.env.MULTITABLE_BUSINESS_TIMEZONE ?? null,
    // NEW path — must be identical in every process zone.
    parsed: parsed.kind === 'instant' ? new Date(parsed.ms).toISOString() : parsed.kind,
    validated: validateDateTimeValue(WALL, 'fld_dt'),
    validatedIsoLocal: validateDateTimeValue('2026-09-24T09:00:00.000', 'fld_dt'),
    validatedChinese: validateDateTimeValue('2026年9月24日 9:00', 'fld_dt'),
    coerced: coerceBatch1Value('dateTime', { timezone: 'UTC' }, 'fld_dt', WALL),
    formatted: formatDateTimeValue(STORED, 'Asia/Shanghai'),
    roundTrip: validateDateTimeValue(formatDateTimeValue(STORED, 'Asia/Shanghai'), 'fld_dt'),
    // OLD path — independently computed negative control (the pre-fix `new Date(value)`).
    oldParsed: new Date(WALL).toISOString(),
  }),
)
