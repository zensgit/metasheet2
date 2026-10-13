import { describe, expect, it } from 'vitest'
import { formatLocaleTimeInput, parseLocaleTimeInput } from '../src/views/attendance/attendanceLocaleTime'

describe('attendance locale time typing', () => {
  it('keeps a 24-hour value and accepts typed clock text', () => {
    expect(parseLocaleTimeInput('9:00')).toBe('09:00')
    expect(parseLocaleTimeInput('18:00')).toBe('18:00')
    expect(parseLocaleTimeInput('9:00上午')).toBe('09:00')
    expect(parseLocaleTimeInput('6:00 下午')).toBe('18:00')
    expect(parseLocaleTimeInput('9:00 AM')).toBe('09:00')
    expect(formatLocaleTimeInput('09:00', 'zh')).toBe('9:00 上午')
    expect(formatLocaleTimeInput('18:00', 'zh')).toBe('6:00 下午')
    expect(formatLocaleTimeInput('18:45', 'en')).toBe('6:45 PM')
  })
})