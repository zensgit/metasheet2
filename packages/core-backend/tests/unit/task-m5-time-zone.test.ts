/**
 * Task E (M5 pure layer) — results that must not depend on the process time zone (D15).
 *
 * Civil-date stepping, weekdays, the recurrence step and the attachment storage-key month are all
 * computed with UTC arithmetic. When the test runner itself is in UTC (as CI is), a regression to
 * LOCAL getters or setters gives exactly the same answers and no ordinary cell can see it. These
 * cells therefore switch the process time zone (`process.env.TZ`, which Node applies at once) to
 * zones on both sides of UTC — a local-time regression shows up only east of UTC for some code paths
 * and only west of it for others — and restore it afterwards. A control cell proves each switch took
 * effect, so the cells cannot pass vacuously.
 */
import { describe, expect, it } from 'vitest'
import { deriveTaskAttachmentStorageKey } from '../../src/tasks/task-attachments'
import { addCivilDays, civilDayDiff, civilWeekday } from '../../src/tasks/task-civil-date'
import { nextOccurrenceDueDate } from '../../src/tasks/task-recurrence'

/** Zones east and west of UTC, with their UTC offset on 2026-10-07 as `getTimezoneOffset` reports it. */
const ZONES = [
  { zone: 'Asia/Taipei', offsetMinutes: -480 },
  { zone: 'Pacific/Kiritimati', offsetMinutes: -840 },
  { zone: 'America/Chicago', offsetMinutes: 300 },
  { zone: 'Pacific/Pago_Pago', offsetMinutes: 660 },
] as const

/** Runs `fn` with the process time zone set to `zone`, then restores the previous setting. */
function inTimeZone<T>(zone: string, fn: () => T): T {
  const saved = process.env.TZ
  process.env.TZ = zone
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env.TZ
    else process.env.TZ = saved
  }
}

const PROBE_INSTANT = new Date('2026-10-07T00:00:00.000Z')

/** Every civil date of 2026 in order, built from month lengths alone (no Date involved). */
const DAYS_2026: string[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].flatMap((length, m) =>
  Array.from({ length }, (_, d) => `2026-${String(m + 1).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}`),
)

describe('task E — results independent of the process time zone (D15)', () => {
  describe.each(ZONES)('under $zone', ({ zone, offsetMinutes }) => {
    it('control: the local clock really is offset from UTC while the zone is set, and is restored after', () => {
      const before = PROBE_INSTANT.getTimezoneOffset()
      expect(inTimeZone(zone, () => PROBE_INSTANT.getTimezoneOffset())).toBe(offsetMinutes)
      expect(PROBE_INSTANT.getTimezoneOffset()).toBe(before)
    })

    it('civilWeekday: every day of 2026 (2026-01-01 is a Thursday)', () => {
      const weekdays = inTimeZone(zone, () => DAYS_2026.map((day) => civilWeekday(day)))
      expect(weekdays).toEqual(DAYS_2026.map((_, i) => (4 + i) % 7))
    })

    it('addCivilDays and civilDayDiff: every day of 2026, one and 40 days on, and back', () => {
      const results = inTimeZone(zone, () =>
        DAYS_2026.slice(0, DAYS_2026.length - 40).map((day, i) => [
          addCivilDays(day, 1) === DAYS_2026[i + 1],
          addCivilDays(day, 40) === DAYS_2026[i + 40],
          addCivilDays(DAYS_2026[i + 40], -40) === day,
          civilDayDiff(day, DAYS_2026[i + 40]) === 40,
        ]),
      )
      expect(results.flat().every(Boolean)).toBe(true)
    })

    it('addCivilDays: a year below 100 and the two calendar ends', () => {
      inTimeZone(zone, () => {
        expect(addCivilDays('0050-03-01', 1)).toBe('0050-03-02')
        expect(addCivilDays('0099-12-31', 1)).toBe('0100-01-01')
        expect(addCivilDays('0001-01-02', -1)).toBe('0001-01-01')
        expect(addCivilDays('9999-12-30', 1)).toBe('9999-12-31')
      })
    })

    it('nextOccurrenceDueDate: weekly on Monday from a Wednesday, and the monthly month-end clamp', () => {
      inTimeZone(zone, () => {
        expect(nextOccurrenceDueDate({ freq: 'weekly', interval: 1, byWeekday: [1] }, '2026-10-07', '2026-10-07')).toBe('2026-10-12')
        expect(nextOccurrenceDueDate({ freq: 'weekly', interval: 1, byWeekday: [5] }, '2026-10-05', '2026-10-05')).toBe('2026-10-09')
        expect(nextOccurrenceDueDate({ freq: 'monthly', interval: 1 }, '2026-01-31', '2026-01-31')).toBe('2026-02-28')
      })
    })

    it('deriveTaskAttachmentStorageKey: the UTC month on both sides of a month boundary', () => {
      inTimeZone(zone, () => {
        // 2026-10-31 20:00 UTC is already November east of UTC; 2026-11-01 04:30 UTC is still October west of it.
        expect(deriveTaskAttachmentStorageKey('text/csv', new Date('2026-10-31T20:00:00.000Z'), 'k')).toBe('task-attachments/2026-10/k.csv')
        expect(deriveTaskAttachmentStorageKey('text/csv', new Date('2026-11-01T04:30:00.000Z'), 'k')).toBe('task-attachments/2026-11/k.csv')
      })
    })
  })
})
