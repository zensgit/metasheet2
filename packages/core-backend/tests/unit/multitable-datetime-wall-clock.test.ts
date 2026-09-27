/**
 * 客户反馈 2026-09-24 #4c（日期时间显示），裁定见 PR #6074 — server-side wall-clock parsing / formatting
 * (PR #6083 review S1 / B1 / S6 / N1 / N3 / N7).
 *
 * Pins:
 *   - a zone-less string is a wall clock in the GIVEN zone, never the process zone (out-of-process probes
 *     under TZ=UTC and TZ=America/New_York agree byte-for-byte; the old `new Date(text)` control diverges);
 *   - a string with its own zone keeps its absolute meaning;
 *   - the accepted spellings (full-width digits / colon, 年月日, `/` and `.`, `T`, seconds, millis) and the
 *     rejected ones (mixed separators, impossible dates, free text);
 *   - the DST rule of the ONE shared converter: gap → post-transition instant, overlap → earlier instant, and
 *     the hours after a transition that the old single-pass converter got wrong;
 *   - years 0000–0099 survive a round trip (no 19xx remap);
 *   - export format ↔ import parse round-trips to the same instant.
 */
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dateTimeMinuteKey,
  dateTimeValueToUtcMs,
  formatDateTimeValue,
  formatDateTimeWallClock,
  normalizeDateTimeText,
  parseDateTimeText,
} from '../../src/multitable/date-time-wall-clock'
import { utcMsFromParts, zonedWallClockToUtcMs } from '../../src/multitable/automation-timezone'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TESTS_DIR, '../../../..')
const TSX_CLI = path.resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const PROBE_SCRIPT = path.resolve(TESTS_DIR, '../helpers/dateTimeWallClockTzProbe.ts')

const SH = 'Asia/Shanghai'
const NY = 'America/New_York'
const STORED = '2026-09-24T01:00:00.000Z' // 09:00 Beijing

function instant(text: string, tz: string, requireTime = false): string {
  const parsed = parseDateTimeText(text, tz, { requireTime })
  if (parsed.kind !== 'instant') return parsed.kind
  return new Date(parsed.ms).toISOString()
}

describe('normalizeDateTimeText', () => {
  it('maps full-width digits / punctuation and 年月日 / 时分 words to the ASCII grammar', () => {
    expect(normalizeDateTimeText('２０２６－０９－２４　０９：００')).toBe('2026-09-24 09:00')
    expect(normalizeDateTimeText('2026年9月24日 9:30')).toBe('2026-9-24 9:30')
    expect(normalizeDateTimeText('2026年9月24日9时30分')).toBe('2026-9-24 9:30')
    expect(normalizeDateTimeText('2026年09月24日 09时05分15秒')).toBe('2026-09-24 09:05:15')
    expect(normalizeDateTimeText('  2026/09/24   09:00  ')).toBe('2026/09/24 09:00')
    expect(normalizeDateTimeText(null)).toBe('')
  })
})

describe('parseDateTimeText — zone-less text is a wall clock in the given zone', () => {
  it('reads the canonical and the typed spellings as Beijing wall clocks', () => {
    for (const text of [
      '2026-09-24 09:00',
      '2026-09-24T09:00',
      '2026/9/24 9:00',
      '2026.09.24 09:00',
      '2026-09-24 09:00:00',
      '2026-09-24T09:00:00.000',
      '2026年9月24日 9:00',
      '2026年9月24日9时0分',
      '２０２６－０９－２４ ０９：００',
    ]) {
      expect(instant(text, SH), text).toBe(STORED)
    }
    expect(instant('2026-09-24 09:00:30', SH)).toBe('2026-09-24T01:00:30.000Z')
  })

  it('a bare date is midnight in the zone for imports / API, but rejected when the time is required (editors)', () => {
    expect(instant('2026-09-24', SH)).toBe('2026-09-23T16:00:00.000Z')
    expect(instant('2026-09-24', SH, true)).toBe('invalid')
  })

  it('keeps the absolute meaning of a string that names its zone', () => {
    expect(instant('2026-09-24T01:00:00.000Z', SH)).toBe(STORED)
    expect(instant('2026-09-24T01:00:00Z', NY)).toBe(STORED)
    expect(instant('2026-09-24T09:00:00+08:00', NY)).toBe(STORED)
    expect(instant('2026-09-24 09:00+0800', NY)).toBe(STORED)
    expect(instant('2026-09-23T21:00:00.500-04:00', SH)).toBe('2026-09-24T01:00:00.500Z')
    // Not in the ISO grammar but carries GMT — absolute, so Date.parse is safe.
    expect(instant('Thu, 24 Sep 2026 01:00:00 GMT', SH)).toBe(STORED)
    expect(parseDateTimeText('2026-09-24T01:00:00Z', SH)).toMatchObject({ kind: 'instant', hasZone: true })
    expect(parseDateTimeText('2026-09-24 09:00', SH)).toMatchObject({ kind: 'instant', hasZone: false })
  })

  it('rejects mixed separators (N7), impossible dates and zone-less free text; blank is empty', () => {
    for (const text of ['2026-09/24 09:00', '2026/09.24 09:00', '2026.09-24 09:00', '2026-02-30 09:00', '2026-13-01 09:00', '2026-09-24 24:00', '2026-09-24 09:60', 'tomorrow 9am', 'Sep 24 2026 09:00', '2026-09-24 9:00 PM', '20260924']) {
      expect(parseDateTimeText(text, SH), text).toEqual({ kind: 'invalid' })
    }
    expect(parseDateTimeText('', SH)).toEqual({ kind: 'empty' })
    expect(parseDateTimeText('   ', SH)).toEqual({ kind: 'empty' })
    expect(parseDateTimeText(undefined, SH)).toEqual({ kind: 'empty' })
  })

  it('reads the same wall clock in another zone as a different instant', () => {
    expect(instant('2026-09-24 09:00', NY)).toBe('2026-09-24T13:00:00.000Z')
    expect(instant('2026-09-24 10:00', 'Asia/Tokyo')).toBe(STORED)
    expect(instant('2026-09-24 06:45', 'Asia/Kathmandu')).toBe(STORED)
  })
})

describe('DST rule of the ONE shared converter (zonedWallClockToUtcMs)', () => {
  const ny = (y: number, mo: number, d: number, h: number, mi: number) =>
    new Date(zonedWallClockToUtcMs({ year: y, month: mo, day: d, hour: h, minute: mi, second: 0 }, NY)).toISOString()
  const berlin = (y: number, mo: number, d: number, h: number, mi: number) =>
    new Date(zonedWallClockToUtcMs({ year: y, month: mo, day: d, hour: h, minute: mi, second: 0 }, 'Europe/Berlin')).toISOString()

  it('spring-forward GAP → the post-transition instant (02:30 EST = 07:30Z, shown as 03:30 EDT)', () => {
    expect(ny(2026, 3, 8, 2, 30)).toBe('2026-03-08T07:30:00.000Z')
    expect(formatDateTimeWallClock(Date.parse('2026-03-08T07:30:00.000Z'), NY)).toBe('2026-03-08 03:30')
    // Berlin 2026-03-29 02:00 CET → 03:00 CEST: 02:30 → 01:30Z = 03:30 CEST.
    expect(berlin(2026, 3, 29, 2, 30)).toBe('2026-03-29T01:30:00.000Z')
  })

  it('fall-back OVERLAP → the earlier instant (01:30 EDT = 05:30Z, not 06:30Z)', () => {
    expect(ny(2026, 11, 1, 1, 30)).toBe('2026-11-01T05:30:00.000Z')
    // Berlin 2026-10-25 03:00 CEST → 02:00 CET: 02:30 → 00:30Z (CEST), not 01:30Z (CET).
    expect(berlin(2026, 10, 25, 2, 30)).toBe('2026-10-25T00:30:00.000Z')
  })

  it('is exact for the hours AFTER a transition that the old single-pass converter got wrong', () => {
    expect(ny(2026, 3, 8, 3, 30)).toBe('2026-03-08T07:30:00.000Z') // was 08:30Z
    expect(ny(2026, 3, 8, 6, 0)).toBe('2026-03-08T10:00:00.000Z') // was 11:00Z
    expect(ny(2026, 11, 1, 2, 0)).toBe('2026-11-01T07:00:00.000Z') // was 06:00Z
    expect(ny(2026, 11, 1, 5, 0)).toBe('2026-11-01T10:00:00.000Z')
    // And unchanged well away from the edges, both sides.
    expect(ny(2026, 7, 1, 9, 0)).toBe('2026-07-01T13:00:00.000Z')
    expect(ny(2026, 12, 1, 9, 0)).toBe('2026-12-01T14:00:00.000Z')
    expect(ny(2026, 3, 7, 12, 0)).toBe('2026-03-07T17:00:00.000Z')
    expect(ny(2026, 3, 9, 12, 0)).toBe('2026-03-09T16:00:00.000Z')
  })

  it('every wall clock in a full DST day round-trips through the formatter (except the non-existent gap hour)', () => {
    for (const day of [8, 1]) {
      const month = day === 8 ? 3 : 11
      for (let hour = 0; hour < 24; hour += 1) {
        for (const minute of [0, 30]) {
          if (month === 3 && hour === 2) continue // the gap hour does not exist
          const ms = zonedWallClockToUtcMs({ year: 2026, month, day, hour, minute, second: 0 }, NY)
          expect(formatDateTimeWallClock(ms, NY)).toBe(`2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`)
        }
      }
    }
  })
})

describe('years 0000–0099 (N3)', () => {
  it('utcMsFromParts keeps year 99 as 0099, where Date.UTC would say 1999', () => {
    expect(new Date(utcMsFromParts(99, 1, 1)).toISOString()).toBe('0099-01-01T00:00:00.000Z')
    expect(new Date(Date.UTC(99, 0, 1)).toISOString()).toBe('1999-01-01T00:00:00.000Z') // the trap
    expect(new Date(utcMsFromParts(0, 12, 31, 23, 59, 59)).toISOString()).toBe('0000-12-31T23:59:59.000Z')
  })

  it('a year-0099 wall clock parses, formats and round-trips without a 19xx remap', () => {
    // Fixed-offset zone: Asia/Shanghai in year 99 is on LMT (+08:05:43 per tzdata), which is correct but
    // would make the absolute value below hard to read.
    expect(instant('0099-01-01 08:00', 'Etc/GMT-8')).toBe('0099-01-01T00:00:00.000Z')
    expect(formatDateTimeValue('0099-01-01T00:00:00.000Z', 'Etc/GMT-8')).toBe('0099-01-01 08:00')
    expect(instant('0099-01-01T00:00:00.000Z', SH)).toBe('0099-01-01T00:00:00.000Z')
    // The wall clock itself round-trips in any zone (LMT seconds cancel out), and stays in year 0099.
    const ms = zonedWallClockToUtcMs({ year: 99, month: 1, day: 1, hour: 8, minute: 0, second: 0 }, SH)
    expect(new Date(ms).getUTCFullYear()).toBe(98) // 08:00 LMT on Jan 1 0099 is Dec 31 0098 in UTC — not 1998
    expect(formatDateTimeWallClock(ms, SH)).toBe('0099-01-01 08:00')
  })
})

describe('format ↔ parse (export ↔ import) round trip', () => {
  it('formats a stored instant as YYYY-MM-DD HH:mm in the zone and parses it back to the same minute', () => {
    expect(formatDateTimeValue(STORED, SH)).toBe('2026-09-24 09:00')
    expect(formatDateTimeValue(STORED, NY)).toBe('2026-09-23 21:00')
    expect(formatDateTimeValue('2026-09-24T13:05:00.000Z', SH)).toBe('2026-09-24 21:05') // 24h, never 09:05 PM
    expect(formatDateTimeValue('2026-09-23T16:00:00.000Z', SH)).toBe('2026-09-24 00:00') // midnight is 00
    for (const iso of [STORED, '2026-12-31T15:59:00.000Z', '2026-03-08T07:30:00.000Z', '2026-11-01T05:30:00.000Z']) {
      for (const tz of [SH, NY, 'Asia/Kathmandu', 'Europe/Berlin']) {
        expect(instant(formatDateTimeValue(iso, tz)!, tz), `${iso} via ${tz}`).toBe(iso)
      }
    }
  })

  it('reads stored numbers / Dates / zone-less strings; junk formats as null (caller keeps the raw cell)', () => {
    expect(dateTimeValueToUtcMs(Date.parse(STORED), SH)).toBe(Date.parse(STORED))
    expect(dateTimeValueToUtcMs(new Date(STORED), SH)).toBe(Date.parse(STORED))
    expect(dateTimeValueToUtcMs('2026-09-24 09:00', SH)).toBe(Date.parse(STORED))
    expect(dateTimeValueToUtcMs(null, SH)).toBeNull()
    expect(dateTimeValueToUtcMs('', SH)).toBeNull()
    expect(dateTimeValueToUtcMs({ iso: STORED }, SH)).toBeNull()
    expect(formatDateTimeValue('not a date', SH)).toBeNull()
  })

  it('minute key floors to the displayed precision', () => {
    expect(dateTimeMinuteKey('2026-09-24T01:00:30.000Z', SH)).toBe(dateTimeMinuteKey('2026-09-24 09:00', SH))
    expect(dateTimeMinuteKey('2026-09-24T01:01:00.000Z', SH)).toBe(dateTimeMinuteKey('2026-09-24 09:00', SH)! + 1)
    expect(dateTimeMinuteKey('junk', SH)).toBeNull()
  })
})

describe('independent of the PROCESS timezone (out-of-process probes)', { timeout: 90_000 }, () => {
  interface Probe {
    tzEnv: string | null
    offsetMinutes: number
    parsed: string
    validated: string | null
    validatedIsoLocal: string | null
    validatedChinese: string | null
    coerced: unknown
    formatted: string | null
    roundTrip: string | null
    oldParsed: string
  }
  function runProbe(tz: string): Probe {
    const stdout = execFileSync(process.execPath, [TSX_CLI, PROBE_SCRIPT], {
      env: { ...process.env, TZ: tz, MULTITABLE_BUSINESS_TIMEZONE: '' },
      encoding: 'utf8',
      timeout: 80_000,
    })
    return JSON.parse(stdout) as Probe
  }
  const expectedOffset: Record<string, number> = { UTC: 0, 'America/New_York': 240, 'Asia/Shanghai': -480 }

  it.each(Object.keys(expectedOffset))('under TZ=%s the zone-less wall clock 2026-09-24 09:00 is 01:00Z (Beijing), and the old path diverges', (tz) => {
    const r = runProbe(tz)
    expect(r.tzEnv).toBe(tz)
    expect(r.offsetMinutes).toBe(expectedOffset[tz]) // the probe really ran in that zone
    expect(r.parsed).toBe(STORED)
    expect(r.validated).toBe(STORED)
    expect(r.validatedIsoLocal).toBe(STORED)
    expect(r.validatedChinese).toBe(STORED)
    expect(r.coerced).toBe(STORED)
    expect(r.formatted).toBe('2026-09-24 09:00')
    expect(r.roundTrip).toBe(STORED)
    // Negative control: `new Date('2026-09-24 09:00')` reads the process zone — the S1 bug the probe can see.
    const oldExpected: Record<string, string> = {
      UTC: '2026-09-24T09:00:00.000Z',
      'America/New_York': '2026-09-24T13:00:00.000Z',
      'Asia/Shanghai': STORED,
    }
    expect(r.oldParsed).toBe(oldExpected[tz])
  })
})
