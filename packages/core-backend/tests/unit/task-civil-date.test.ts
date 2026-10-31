import { describe, expect, it } from 'vitest'
import { addCivilDays, civilDayDiff, civilWeekday, daysInCivilMonth } from '../../src/tasks/task-civil-date'

describe('task-civil-date', () => {
  describe('addCivilDays', () => {
    it('adds whole days inside a month', () => {
      expect(addCivilDays('2026-10-07', 1)).toBe('2026-10-08')
      expect(addCivilDays('2026-10-07', 0)).toBe('2026-10-07')
    })
    it('rolls over month and year ends', () => {
      expect(addCivilDays('2026-01-31', 1)).toBe('2026-02-01')
      expect(addCivilDays('2026-12-31', 1)).toBe('2027-01-01')
      expect(addCivilDays('2026-03-01', -1)).toBe('2026-02-28')
      expect(addCivilDays('2024-03-01', -1)).toBe('2024-02-29')
    })
    it('steps across a leap day and a whole leap year', () => {
      expect(addCivilDays('2024-02-28', 1)).toBe('2024-02-29')
      expect(addCivilDays('2024-01-01', 366)).toBe('2025-01-01')
      expect(addCivilDays('2026-10-07', -365)).toBe('2025-10-07')
    })
    it('is not shifted by daylight-saving dates (pure UTC day arithmetic)', () => {
      // US and EU DST transition dates, both directions.
      expect(addCivilDays('2026-03-08', 1)).toBe('2026-03-09')
      expect(addCivilDays('2026-11-01', 1)).toBe('2026-11-02')
      expect(addCivilDays('2026-03-29', 1)).toBe('2026-03-30')
      expect(addCivilDays('2026-10-25', 1)).toBe('2026-10-26')
    })
    // Date.UTC maps years 0–99 to 1900–1999; the module must not.
    it('keeps a year below 100 as written (no 19xx remapping)', () => {
      expect(addCivilDays('0050-03-01', 1)).toBe('0050-03-02')
      expect(addCivilDays('0099-12-31', 1)).toBe('0100-01-01')
      expect(addCivilDays('0001-01-02', -1)).toBe('0001-01-01')
    })
    it('a result before 0001-01-01 or after 9999-12-31 is a RangeError', () => {
      expect(() => addCivilDays('0001-01-01', -1)).toThrow(RangeError)
      expect(() => addCivilDays('9999-12-31', 1)).toThrow(RangeError)
      expect(() => addCivilDays('2026-10-07', 1e15)).toThrow(RangeError)
    })
    it('rejects a non-string date with TypeError', () => {
      expect(() => addCivilDays(20261007 as unknown as string, 1)).toThrow(TypeError)
      expect(() => addCivilDays(undefined as unknown as string, 1)).toThrow(TypeError)
    })
    it('rejects an unreal or non-canonical date with RangeError (never rolls over)', () => {
      expect(() => addCivilDays('2026-02-30', 1)).toThrow(RangeError)
      expect(() => addCivilDays('2026-3-8', 1)).toThrow(RangeError)
      expect(() => addCivilDays(' 2026-03-08', 1)).toThrow(RangeError)
      expect(() => addCivilDays('2026-03-08T00:00:00Z', 1)).toThrow(RangeError)
      expect(() => addCivilDays('x', 1)).toThrow(RangeError)
    })
    it('rejects non-integer day counts', () => {
      expect(() => addCivilDays('2026-10-07', '1' as unknown as number)).toThrow(TypeError)
      expect(() => addCivilDays('2026-10-07', 1.5)).toThrow(RangeError)
      expect(() => addCivilDays('2026-10-07', Number.NaN)).toThrow(RangeError)
      expect(() => addCivilDays('2026-10-07', Number.POSITIVE_INFINITY)).toThrow(RangeError)
    })
  })

  describe('civilDayDiff', () => {
    it('is to − from in whole days', () => {
      expect(civilDayDiff('2026-10-07', '2026-10-07')).toBe(0)
      expect(civilDayDiff('2026-10-07', '2026-10-10')).toBe(3)
      expect(civilDayDiff('2026-10-10', '2026-10-07')).toBe(-3)
      expect(civilDayDiff('2024-02-28', '2024-03-01')).toBe(2)
      expect(civilDayDiff('2026-02-28', '2026-03-01')).toBe(1)
      expect(civilDayDiff('2026-01-31', '2027-01-31')).toBe(365)
    })
    it('is the inverse of addCivilDays', () => {
      for (const days of [-400, -31, -1, 0, 1, 29, 59, 366, 1000]) {
        expect(civilDayDiff('2026-10-07', addCivilDays('2026-10-07', days))).toBe(days)
      }
    })
    it('rejects bad dates', () => {
      expect(() => civilDayDiff('2026-02-30', '2026-03-01')).toThrow(RangeError)
      expect(() => civilDayDiff('2026-03-01', null as unknown as string)).toThrow(TypeError)
    })
  })

  describe('civilWeekday', () => {
    it('uses 0 = Sunday … 6 = Saturday', () => {
      expect(civilWeekday('1970-01-01')).toBe(4) // Thursday
      expect(civilWeekday('2000-01-01')).toBe(6) // Saturday
      expect(civilWeekday('2026-10-07')).toBe(3) // Wednesday
      expect(civilWeekday('2026-10-11')).toBe(0) // Sunday
      expect(civilWeekday('2026-10-12')).toBe(1) // Monday
    })
    it('handles a year below 100 without remapping', () => {
      expect(civilWeekday('0050-03-01')).toBe(2)
    })
    it('rejects bad input', () => {
      expect(() => civilWeekday('2026-13-01')).toThrow(RangeError)
      expect(() => civilWeekday(7 as unknown as string)).toThrow(TypeError)
    })
  })

  describe('daysInCivilMonth', () => {
    it('applies the Gregorian leap rule', () => {
      expect(daysInCivilMonth(2024, 2)).toBe(29)
      expect(daysInCivilMonth(2026, 2)).toBe(28)
      expect(daysInCivilMonth(1900, 2)).toBe(28)
      expect(daysInCivilMonth(2000, 2)).toBe(29)
    })
    it('knows the 30- and 31-day months', () => {
      expect([1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => daysInCivilMonth(2026, m))).toEqual([
        31, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
      ])
    })
    it('rejects out-of-range or non-integer arguments', () => {
      expect(() => daysInCivilMonth(2026, 0)).toThrow(RangeError)
      expect(() => daysInCivilMonth(2026, 13)).toThrow(RangeError)
      expect(() => daysInCivilMonth(0, 1)).toThrow(RangeError)
      expect(() => daysInCivilMonth(10000, 1)).toThrow(RangeError)
      expect(() => daysInCivilMonth(2026, 1.5)).toThrow(RangeError)
      expect(() => daysInCivilMonth('2026' as unknown as number, 1)).toThrow(TypeError)
    })
  })
})
