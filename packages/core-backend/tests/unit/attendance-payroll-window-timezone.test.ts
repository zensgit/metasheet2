import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests

const monthlyTemplate = {
  startDay: 26,
  endDay: 25,
  endMonthOffset: 0,
}

describe('resolvePayrollWindow timezone contract', () => {
  it('keeps a YYYY-MM-DD anchor as a calendar literal in a west-of-UTC zone', () => {
    const window = helpers.resolvePayrollWindow(
      { ...monthlyTemplate, timezone: 'America/Los_Angeles' },
      '2026-09-26',
    )
    expect(window).toMatchObject({
      startDate: '2026-09-26',
      endDate: '2026-10-25',
      timeZone: 'America/Los_Angeles',
    })
  })

  it('keeps a UTC-midnight Date on the UTC calendar so cycle verification does not shift', () => {
    const window = helpers.resolvePayrollWindow(
      { ...monthlyTemplate, timezone: 'America/Los_Angeles' },
      new Date('2026-09-26T00:00:00.000Z'),
    )
    expect(window.startDate).toBe('2026-09-26')
    expect(window.endDate).toBe('2026-10-25')
  })

  it('uses the template IANA calendar for an instant that crosses the local month', () => {
    const instant = new Date('2026-09-25T16:30:00.000Z')
    const shanghai = helpers.resolvePayrollWindow(
      { ...monthlyTemplate, timezone: 'Asia/Shanghai' },
      instant,
    )
    const utc = helpers.resolvePayrollWindow(
      { ...monthlyTemplate, timezone: 'UTC' },
      instant,
    )
    expect(shanghai).toMatchObject({ startDate: '2026-09-26', endDate: '2026-10-25' })
    expect(utc).toMatchObject({ startDate: '2026-08-26', endDate: '2026-09-25' })
  })

  it('falls back to the org rule zone when the template timezone is missing', () => {
    const instant = new Date('2026-09-25T16:30:00.000Z')
    const window = helpers.resolvePayrollWindow(
      { ...monthlyTemplate, timezone: '' },
      instant,
      'Asia/Shanghai',
    )
    expect(window).toMatchObject({
      startDate: '2026-09-26',
      endDate: '2026-10-25',
      timeZone: 'Asia/Shanghai',
    })
  })

  it('does not replace an explicit UTC template with the rule fallback', () => {
    const instant = new Date('2026-09-25T16:30:00.000Z')
    const window = helpers.resolvePayrollWindow(
      { ...monthlyTemplate, timezone: 'UTC' },
      instant,
      'Asia/Shanghai',
    )
    expect(window).toMatchObject({
      startDate: '2026-08-26',
      endDate: '2026-09-25',
      timeZone: 'UTC',
    })
  })

  it('reads an ISO timestamp in the template zone instead of the UTC calendar', () => {
    const losAngeles = helpers.resolvePayrollWindow(
      { ...monthlyTemplate, timezone: 'America/Los_Angeles' },
      '2026-09-26T06:30:00.000Z',
    )
    expect(losAngeles).toMatchObject({ startDate: '2026-08-26', endDate: '2026-09-25' })
  })
})
