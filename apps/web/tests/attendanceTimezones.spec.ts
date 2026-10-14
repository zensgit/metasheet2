import { describe, expect, it } from 'vitest'
import { formatTimezoneLabel } from '../src/utils/timezones'
import {
  buildTimezoneOptionEntries,
  buildTimezoneOptionGroups,
  formatTimezoneOffsetLabel,
  formatTimezoneOptionLabel,
  parseTimezoneOffsetQuery,
  timezoneChoiceMatchesQuery,
} from '../src/views/attendance/attendanceTimezones'

describe('attendanceTimezones', () => {
  it('uses Chinese place names only when the locale asks for them', () => {
    const at = new Date('2026-06-01T00:00:00Z')
    expect(formatTimezoneLabel('Asia/Shanghai', at)).toBe('UTC+08:00 · Asia/Shanghai')
    expect(formatTimezoneLabel('Asia/Shanghai', at, 'zh')).toBe('UTC+08:00 · 北京')
    expect(formatTimezoneLabel('Asia/Taipei', at, 'zh')).toBe('UTC+08:00 · 台北')
    expect(formatTimezoneLabel('Europe/Berlin', at, 'zh')).toBe('UTC+02:00 · 柏林')
  })

  it('formats UTC offsets for supported timezones', () => {
    expect(formatTimezoneOffsetLabel('UTC')).toBe('UTC+00:00')
    expect(formatTimezoneOffsetLabel('Asia/Shanghai')).toBe('UTC+08:00')
  })

  it('builds timezone labels with UTC offsets', () => {
    expect(formatTimezoneOptionLabel('Asia/Shanghai')).toBe('Asia/Shanghai (UTC+08:00)')
    expect(formatTimezoneOptionLabel('Asia/Shanghai', new Date('2026-06-01T00:00:00Z'), 'zh')).toBe('北京 (UTC+08:00)')
    expect(formatTimezoneOptionLabel('Asia/Taipei', new Date('2026-06-01T00:00:00Z'), 'zh')).toBe('台北 (UTC+08:00)')

    const options = buildTimezoneOptionEntries('Asia/Shanghai')
    const selected = options.find((item) => item.value === 'Asia/Shanghai')
    expect(selected).toEqual({
      value: 'Asia/Shanghai',
      label: 'Asia/Shanghai (UTC+08:00)',
    })
  })

  it('parses offset queries used by the shared timezone field', () => {
    expect(parseTimezoneOffsetQuery('+0')).toBe(0)
    expect(parseTimezoneOffsetQuery('-8')).toBe(-480)
    expect(parseTimezoneOffsetQuery('+08')).toBe(480)
    expect(parseTimezoneOffsetQuery('UTC+8')).toBe(480)
    expect(parseTimezoneOffsetQuery('UTC-5')).toBe(-300)
    expect(parseTimezoneOffsetQuery('0')).toBe(0)
    expect(parseTimezoneOffsetQuery('+5:30')).toBe(330)
    expect(parseTimezoneOffsetQuery('Shanghai')).toBeNull()
  })

  it('matches a timezone choice by offset equality or by city and IANA text', () => {
    const shanghai = { value: 'Asia/Shanghai', label: '北京 (UTC+08:00)' }
    const kolkata = { value: 'Asia/Kolkata', label: '加尔各答 (UTC+05:30)' }
    expect(timezoneChoiceMatchesQuery(shanghai, '+8')).toBe(true)
    expect(timezoneChoiceMatchesQuery(shanghai, 'UTC+8')).toBe(true)
    expect(timezoneChoiceMatchesQuery(shanghai, '8')).toBe(true)
    expect(timezoneChoiceMatchesQuery(kolkata, '+5:30')).toBe(true)
    expect(timezoneChoiceMatchesQuery(shanghai, '8')).toBe(true)
    expect(timezoneChoiceMatchesQuery({ value: 'Pacific/Kiritimati', label: 'UTC+14:00' }, '8')).toBe(false)
    expect(timezoneChoiceMatchesQuery(shanghai, '北京')).toBe(true)
    expect(timezoneChoiceMatchesQuery(shanghai, 'shanghai')).toBe(true)
    expect(timezoneChoiceMatchesQuery(shanghai, 'Not/AZone')).toBe(false)
  })

  it('groups timezone options into common and regional buckets', () => {
    const groups = buildTimezoneOptionGroups('America/New_York')

    expect(groups[0]?.id).toBe('common')
    expect(groups[0]?.labelEn).toBe('Common timezones')
    expect(groups[0]?.options.some((item) => item.value === 'America/New_York')).toBe(true)
    expect(groups.some((group) => group.id === 'Asia')).toBe(true)
    expect(groups.some((group) => group.id === 'Europe')).toBe(true)
  })
})
