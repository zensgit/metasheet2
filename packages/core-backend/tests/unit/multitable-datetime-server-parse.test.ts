/**
 * 客户反馈 2026-09-24 #4c — the server write path for dateTime values (PR #6083 review S1).
 *
 * `validateDateTimeValue` / `coerceBatch1Value` are what grid paste, CSV/XLSX import, form prefill and REST all
 * reach. Pins: a zone-less string is read in the FIELD zone (explicit non-'UTC' `property.timezone`, else the
 * instance business timezone from MULTITABLE_BUSINESS_TIMEZONE, else Asia/Shanghai) — never the process zone;
 * an absolute string keeps its instant; the accepted spellings; and the fail-closed rejections.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { coerceBatch1Value, validateDateTimeValue } from '../../src/multitable/field-codecs'
import { resolveDateTimeFieldTimeZone } from '../../src/multitable/business-timezone'

const ENV_KEY = 'MULTITABLE_BUSINESS_TIMEZONE'
const STORED = '2026-09-24T01:00:00.000Z' // 09:00 Beijing

describe('resolveDateTimeFieldTimeZone — the field zone rule', () => {
  let previous: string | undefined
  beforeEach(() => { previous = process.env[ENV_KEY]; delete process.env[ENV_KEY] })
  afterEach(() => { if (previous === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = previous })

  it('explicit non-UTC field zone wins; "UTC" (the sanitizer stamp), absent, junk → business zone → default', () => {
    expect(resolveDateTimeFieldTimeZone({ timezone: 'Asia/Tokyo' })).toBe('Asia/Tokyo')
    expect(resolveDateTimeFieldTimeZone({ timezone: ' Europe/Berlin ' })).toBe('Europe/Berlin')
    expect(resolveDateTimeFieldTimeZone({ timezone: 'Etc/UTC' })).toBe('Etc/UTC')
    expect(resolveDateTimeFieldTimeZone({ timezone: 'UTC' })).toBe('Asia/Shanghai')
    expect(resolveDateTimeFieldTimeZone({ timezone: 'Not/AZone' })).toBe('Asia/Shanghai')
    expect(resolveDateTimeFieldTimeZone({})).toBe('Asia/Shanghai')
    expect(resolveDateTimeFieldTimeZone(undefined)).toBe('Asia/Shanghai')
    expect(resolveDateTimeFieldTimeZone(null)).toBe('Asia/Shanghai')
    process.env[ENV_KEY] = 'Asia/Kathmandu'
    expect(resolveDateTimeFieldTimeZone({ timezone: 'UTC' })).toBe('Asia/Kathmandu')
    expect(resolveDateTimeFieldTimeZone({ timezone: 'Asia/Tokyo' })).toBe('Asia/Tokyo')
  })
})

describe('validateDateTimeValue — zone-less strings are business wall clocks', () => {
  let previous: string | undefined
  beforeEach(() => { previous = process.env[ENV_KEY]; delete process.env[ENV_KEY] })
  afterEach(() => { if (previous === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = previous })

  it('parses the wall-clock spellings in Asia/Shanghai by default', () => {
    for (const text of ['2026-09-24 09:00', '2026-09-24T09:00', '2026-09-24T09:00:00.000', '2026/9/24 9:00', '2026年9月24日 9:00', '２０２６－０９－２４ ０９：００']) {
      expect(validateDateTimeValue(text, 'fld'), text).toBe(STORED)
      expect(validateDateTimeValue(text, 'fld', { timezone: 'UTC' }), text).toBe(STORED)
    }
    expect(validateDateTimeValue('2026-09-24', 'fld')).toBe('2026-09-23T16:00:00.000Z') // bare date = business midnight
  })

  it('honours an explicit field zone, then the env business zone', () => {
    expect(validateDateTimeValue('2026-09-24 10:00', 'fld', { timezone: 'Asia/Tokyo' })).toBe(STORED)
    process.env[ENV_KEY] = 'Asia/Kathmandu'
    expect(validateDateTimeValue('2026-09-24 06:45', 'fld')).toBe(STORED)
    expect(validateDateTimeValue('2026-09-24 06:45', 'fld', { timezone: 'UTC' })).toBe(STORED)
    expect(validateDateTimeValue('2026-09-24 10:00', 'fld', { timezone: 'Asia/Tokyo' })).toBe(STORED)
  })

  it('keeps absolute inputs, numbers and Dates exactly (pre-existing contract)', () => {
    expect(validateDateTimeValue('2026-05-06T10:30:00+08:00', 'fld')).toBe('2026-05-06T02:30:00.000Z')
    expect(validateDateTimeValue(STORED, 'fld')).toBe(STORED)
    expect(validateDateTimeValue(Date.UTC(2026, 4, 6, 2, 30, 0), 'fld')).toBe('2026-05-06T02:30:00.000Z')
    expect(validateDateTimeValue(new Date(STORED), 'fld')).toBe(STORED)
    expect(validateDateTimeValue(null, 'fld')).toBeNull()
    expect(validateDateTimeValue('', 'fld')).toBeNull()
    expect(validateDateTimeValue('   ', 'fld')).toBeNull()
  })

  it('rejects what it cannot read, fail-closed, with the existing error shapes', () => {
    expect(() => validateDateTimeValue('not-a-date', 'fld')).toThrow(/Invalid DateTime/)
    expect(() => validateDateTimeValue('2026-09/24 09:00', 'fld')).toThrow(/Invalid DateTime/) // mixed separators
    expect(() => validateDateTimeValue('Sep 24 2026 09:00', 'fld')).toThrow(/Invalid DateTime/) // zone-less, not in grammar
    expect(() => validateDateTimeValue('2026-02-30 09:00', 'fld')).toThrow(/Invalid DateTime/)
    expect(() => validateDateTimeValue({ iso: '2026-05-06' }, 'fld')).toThrow(/DateTime value must/)
    expect(() => validateDateTimeValue(Number.NaN, 'fld')).toThrow(/Invalid DateTime/)
    expect(() => validateDateTimeValue(new Date('x'), 'fld')).toThrow(/Invalid DateTime/)
  })

  it('coerceBatch1Value passes the field property through (the zone rule reaches every write path)', () => {
    expect(coerceBatch1Value('dateTime', undefined, 'fld', '2026-09-24 09:00')).toBe(STORED)
    expect(coerceBatch1Value('dateTime', { timezone: 'UTC' }, 'fld', '2026-09-24 09:00')).toBe(STORED)
    expect(coerceBatch1Value('dateTime', { timezone: 'Asia/Tokyo' }, 'fld', '2026-09-24 10:00')).toBe(STORED)
    expect(coerceBatch1Value('dateTime', undefined, 'fld', '2026-05-06T10:30:00+08:00')).toBe('2026-05-06T02:30:00.000Z')
    expect(coerceBatch1Value('dateTime', undefined, 'fld', '')).toBeNull()
  })
})
