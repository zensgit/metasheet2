import { describe, expect, it } from 'vitest'
import {
  buildTimezoneOptionEntries,
  formatTimezoneOffsetLabel,
  formatTimezoneOptionLabel,
} from '../src/views/attendance/attendanceTimezones'

describe('attendanceTimezones', () => {
  it('formats UTC offsets for supported timezones', () => {
    expect(formatTimezoneOffsetLabel('UTC')).toBe('UTC+00:00')
    expect(formatTimezoneOffsetLabel('Asia/Shanghai')).toBe('UTC+08:00')
  })

  it('builds timezone labels with UTC offsets', () => {
    expect(formatTimezoneOptionLabel('Asia/Shanghai')).toBe('Asia/Shanghai (UTC+08:00)')

    const options = buildTimezoneOptionEntries('Asia/Shanghai')
    const selected = options.find((item) => item.value === 'Asia/Shanghai')
    expect(selected).toEqual({
      value: 'Asia/Shanghai',
      label: 'Asia/Shanghai (UTC+08:00)',
    })
  })
})
