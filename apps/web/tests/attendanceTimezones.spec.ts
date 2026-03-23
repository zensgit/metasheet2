import { describe, expect, it } from 'vitest'
import {
  buildTimezoneOptionEntries,
  buildTimezoneOptionGroups,
  formatTimezoneOffsetLabel,
  formatTimezoneOptionLabel,
  formatTimezoneStatusLabel,
} from '../src/views/attendance/attendanceTimezones'

describe('attendanceTimezones', () => {
  it('formats UTC offsets for supported timezones', () => {
    expect(formatTimezoneOffsetLabel('UTC')).toBe('UTC+00:00')
    expect(formatTimezoneOffsetLabel('Asia/Shanghai')).toBe('UTC+08:00')
  })

  it('builds timezone labels with UTC offsets', () => {
    expect(formatTimezoneOptionLabel('Asia/Shanghai')).toBe('Asia/Shanghai (UTC+08:00)')
    expect(formatTimezoneStatusLabel('Asia/Shanghai')).toBe('UTC+08:00 · Asia/Shanghai')

    const options = buildTimezoneOptionEntries('Asia/Shanghai')
    const selected = options.find((item) => item.value === 'Asia/Shanghai')
    expect(selected).toEqual({
      value: 'Asia/Shanghai',
      label: 'Asia/Shanghai (UTC+08:00)',
    })
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
