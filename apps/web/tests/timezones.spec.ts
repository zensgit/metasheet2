import { describe, expect, it } from 'vitest'
import {
  buildTimezoneOptions,
  createTimezoneDateAnchor,
  createTimezoneDateTimeAnchor,
  formatTimezoneLabel,
  formatUtcOffset,
  getTimezoneDateKey,
  shiftDateKey,
} from '../src/utils/timezones'

describe('timezone utilities', () => {
  it('formats utc offsets consistently', () => {
    expect(formatUtcOffset(480)).toBe('UTC+08:00')
    expect(formatUtcOffset(-330)).toBe('UTC-05:30')
    expect(formatUtcOffset(0)).toBe('UTC+00:00')
  })

  it('builds preferred timezone options with offset labels', () => {
    const fixedDate = new Date('2026-01-15T00:00:00.000Z')
    const options = buildTimezoneOptions(['Asia/Shanghai', 'UTC'], fixedDate)
    expect(options[0]?.value).toBe('Asia/Shanghai')
    expect(options[0]?.label).toBe('UTC+08:00 · Asia/Shanghai')
    expect(options.some(option => option.value === 'UTC')).toBe(true)
  })

  it('formats empty and concrete timezone labels', () => {
    const fixedDate = new Date('2026-01-15T00:00:00.000Z')
    expect(formatTimezoneLabel('', fixedDate)).toBe('--')
    expect(formatTimezoneLabel('Asia/Shanghai', fixedDate)).toBe('UTC+08:00 · Asia/Shanghai')
  })

  it('formats civil date keys in the requested timezone', () => {
    const fixedDate = new Date('2026-03-24T02:30:00.000Z')
    expect(getTimezoneDateKey('America/Los_Angeles', fixedDate)).toBe('2026-03-23')
    expect(getTimezoneDateKey('Asia/Shanghai', fixedDate)).toBe('2026-03-24')
  })

  it('creates timezone anchors that round-trip back to the same civil day', () => {
    const shanghaiAnchor = createTimezoneDateAnchor('Asia/Shanghai', '2026-03-24')
    const losAngelesAnchor = createTimezoneDateAnchor('America/Los_Angeles', '2026-03-23')
    expect(getTimezoneDateKey('Asia/Shanghai', shanghaiAnchor)).toBe('2026-03-24')
    expect(getTimezoneDateKey('America/Los_Angeles', losAngelesAnchor)).toBe('2026-03-23')
  })

  it('creates timezone datetime anchors from local datetime input', () => {
    expect(createTimezoneDateTimeAnchor('America/Los_Angeles', '2026-03-23T00:15').toISOString()).toBe(
      '2026-03-23T07:15:00.000Z',
    )
    expect(createTimezoneDateTimeAnchor('Asia/Shanghai', '2026-03-24T08:30').toISOString()).toBe(
      '2026-03-24T00:30:00.000Z',
    )
  })

  it('shifts date keys with civil-day arithmetic', () => {
    expect(shiftDateKey('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDateKey('2024-03-01', -1)).toBe('2024-02-29')
    expect(shiftDateKey('2026-12-31', 1)).toBe('2027-01-01')
  })
})
