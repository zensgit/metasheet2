import { describe, expect, it } from 'vitest'
import {
  compareDateKeys,
  formatCalendarMonthLabel,
  formatLunarDayLabel,
  getCalendarVisibleRange,
  normalizeDateKey,
  toDateInput,
  toDateKey,
} from '../src/views/attendanceCalendarUtils'

describe('attendanceCalendarUtils', () => {
  it('formats date keys and inputs as yyyy-mm-dd', () => {
    const date = new Date(2026, 0, 23)
    expect(toDateKey(date)).toBe('2026-01-23')
    expect(toDateInput(date)).toBe('2026-01-23')
  })

  it('normalizes date keys from multiple formats', () => {
    expect(normalizeDateKey('2026-01-23')).toBe('2026-01-23')
    expect(normalizeDateKey('2026-01-23T10:00:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(normalizeDateKey('')).toBeNull()
    expect(normalizeDateKey('invalid-date')).toBeNull()
  })

  it('compares date keys in lexicographic date order', () => {
    expect(compareDateKeys('2026-01-23', '2026-01-23')).toBe(0)
    expect(compareDateKeys('2026-01-22', '2026-01-23')).toBeLessThan(0)
    expect(compareDateKeys('2026-01-24', '2026-01-23')).toBeGreaterThan(0)
  })

  it('calculates visible calendar grid range for monday-based week', () => {
    const range = getCalendarVisibleRange(new Date(2026, 1, 1))
    expect(range).toEqual({
      from: '2026-01-26',
      to: '2026-03-01',
    })
  })

  it('formats calendar month labels with timezone fallback', () => {
    const date = new Date('2026-02-01T00:00:00Z')
    const zh = formatCalendarMonthLabel(date, { locale: 'zh-CN', timeZone: 'Asia/Shanghai' })
    const en = formatCalendarMonthLabel(date, { locale: 'en-US', timeZone: 'UTC' })
    expect(zh.length).toBeGreaterThan(0)
    expect(en.length).toBeGreaterThan(0)

    const fallback = formatCalendarMonthLabel(date, { locale: 'zh-CN', timeZone: 'Invalid/TZ' })
    expect(fallback.length).toBeGreaterThan(0)
  })

  it('formats lunar day labels when enabled and recovers from invalid timezone', () => {
    const date = new Date('2026-02-01T12:00:00Z')
    expect(formatLunarDayLabel(date, { enabled: false, timeZone: 'Asia/Shanghai' })).toBeUndefined()

    const label = formatLunarDayLabel(date, { enabled: true, timeZone: 'Asia/Shanghai' })
    expect(label).toBeTruthy()
    expect(label).toMatch(/[初十廿卅正冬腊闰月]/)

    const fallbackLabel = formatLunarDayLabel(date, { enabled: true, timeZone: 'Invalid/TZ' })
    expect(fallbackLabel).toBeTruthy()
  })
})
