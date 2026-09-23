import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const honesty = attendancePlugin.__attendanceRequestWriteHonestyForTests

const rule = { minMinutes: 30, roundingMinutes: 15, maxMinutesPerDay: 600 }

describe('attendance request write honesty (#5983, #5985)', () => {
  it('rejects leave create/update when the type requires an attachment and none is present', () => {
    expect(honesty.rejectLeaveAttachmentIfRequired(
      { requiresAttachment: true },
      null,
    )).toMatchObject({
      status: 422,
      code: 'LEAVE_ATTACHMENT_REQUIRED',
      field: 'attachmentUrl',
    })
    expect(honesty.rejectLeaveAttachmentIfRequired(
      { requiresAttachment: true },
      '   ',
    )?.code).toBe('LEAVE_ATTACHMENT_REQUIRED')
    expect(honesty.rejectLeaveAttachmentIfRequired(
      { requiresAttachment: true },
      '',
    )?.code).toBe('LEAVE_ATTACHMENT_REQUIRED')
  })

  it('accepts a trimmed attachment URL and ignores the flag when it is not exactly true', () => {
    expect(honesty.rejectLeaveAttachmentIfRequired(
      { requiresAttachment: true },
      ' https://files.example/note.pdf ',
    )).toBeNull()
    expect(honesty.rejectLeaveAttachmentIfRequired({ requiresAttachment: false }, null)).toBeNull()
    expect(honesty.rejectLeaveAttachmentIfRequired({ requiresAttachment: 'true' }, null)).toBeNull()
    expect(honesty.rejectLeaveAttachmentIfRequired(null, null)).toBeNull()
  })

  it('rejects overtime below the minimum instead of raising it', () => {
    const result = honesty.resolveOvertimeWriteMinutes(10, rule)
    expect(result).toMatchObject({
      ok: false,
      code: 'OVERTIME_MINUTES_BELOW_MIN',
      submittedMinutes: 10,
      limit: 30,
    })
    expect(honesty.applyOvertimeRule(10, rule)).toBe(30)
  })

  it('rejects overtime above the daily maximum instead of clamping it', () => {
    const result = honesty.resolveOvertimeWriteMinutes(700, rule)
    expect(result).toMatchObject({
      ok: false,
      code: 'OVERTIME_MINUTES_ABOVE_MAX',
      submittedMinutes: 700,
      limit: 600,
      roundedMinutes: null,
    })
    expect(honesty.applyOvertimeRule(700, rule)).toBe(600)
  })

  it('rejects when rounding would pass the daily maximum', () => {
    const tight = { minMinutes: 30, roundingMinutes: 15, maxMinutesPerDay: 110 }
    const result = honesty.resolveOvertimeWriteMinutes(106, tight)
    expect(result).toMatchObject({
      ok: false,
      code: 'OVERTIME_MINUTES_ABOVE_MAX',
      submittedMinutes: 106,
      limit: 110,
      roundedMinutes: 120,
    })
    expect(honesty.applyOvertimeRule(106, tight)).toBe(110)
  })

  it('rounds an in-range duration and matches applyOvertimeRule', () => {
    const result = honesty.resolveOvertimeWriteMinutes(47, {
      minMinutes: 30,
      roundingMinutes: 15,
      maxMinutesPerDay: 120,
    })
    expect(result).toEqual({ ok: true, minutes: 60 })
    expect(honesty.applyOvertimeRule(47, {
      minMinutes: 30,
      roundingMinutes: 15,
      maxMinutesPerDay: 120,
    })).toBe(60)
  })

  it('treats maxMinutesPerDay 0 as no daily cap and keeps exact multiples', () => {
    expect(honesty.resolveOvertimeWriteMinutes(90, {
      minMinutes: 30,
      roundingMinutes: 15,
      maxMinutesPerDay: 0,
    })).toEqual({ ok: true, minutes: 90 })
    expect(honesty.resolveOvertimeWriteMinutes(600, rule)).toEqual({ ok: true, minutes: 600 })
    expect(honesty.resolveOvertimeWriteMinutes(30, rule)).toEqual({ ok: true, minutes: 30 })
  })

  it('rejects an unsatisfiable rule before comparing the submitted minutes', () => {
    expect(honesty.resolveOvertimeWriteMinutes(30, {
      minMinutes: 600,
      roundingMinutes: 15,
      maxMinutesPerDay: 30,
    })).toMatchObject({
      ok: false,
      code: 'OVERTIME_RULE_BOUNDS_INVALID',
    })
  })

  it('wires the draft resolver to the reject helpers and not to applyOvertimeRule', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../../plugins/plugin-attendance/index.cjs'),
      'utf8',
    )
    const start = source.indexOf('async function resolveAttendanceRequestDraft')
    const end = source.indexOf('const resolveSchema', start)
    const draft = source.slice(start, end)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    expect(draft).toContain('resolveOvertimeWriteMinutes')
    expect(draft).toContain('rejectLeaveAttachmentIfRequired')
    expect(draft).not.toContain('applyOvertimeRule(')
  })
})
