import { describe, expect, it } from 'vitest'
import { buildTimezoneOptions, formatTimezoneLabel, formatUtcOffset } from '../src/utils/timezones'

describe('timezones utils', () => {
  const winterReference = new Date('2026-01-15T12:00:00.000Z')

  it('formats utc offsets with zero-padded hours and minutes', () => {
    expect(formatUtcOffset(330)).toBe('UTC+05:30')
    expect(formatUtcOffset(-420)).toBe('UTC-07:00')
    expect(formatUtcOffset(0)).toBe('UTC+00:00')
  })

  it('formats timezone labels for known zones', () => {
    expect(formatTimezoneLabel('UTC', winterReference)).toBe('UTC+00:00 · UTC')
    expect(formatTimezoneLabel('', winterReference)).toBe('--')
  })

  it('builds options from preferred timezones without crashing on invalid values', () => {
    const options = buildTimezoneOptions(
      ['UTC', 'Invalid/Zone', 'Asia/Shanghai', 'UTC'],
      winterReference,
    )

    expect(options.some((option) => option.value === 'UTC')).toBe(true)
    expect(options.some((option) => option.value === 'Asia/Shanghai')).toBe(true)
    expect(options.some((option) => option.value === 'Invalid/Zone')).toBe(false)
    expect(options.filter((option) => option.value === 'UTC')).toHaveLength(1)
  })
})
