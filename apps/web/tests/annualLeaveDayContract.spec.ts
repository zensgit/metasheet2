import { describe, expect, it } from 'vitest'
import {
  annualLeaveExceedsTypeDayMessage,
  annualLeaveMinutesExceedTypeDay,
  annualLeaveSettleStatusCopy,
  isAnnualLeaveSettleErrorCode,
} from '../src/views/attendance/annualLeaveDayContract'

const en = (english: string) => english

describe('annual leave day contract', () => {
  it('blocks only annual requests longer than the leave-type day', () => {
    expect(annualLeaveMinutesExceedTypeDay({ code: 'annual', defaultMinutesPerDay: 480 }, 540)).toBe(true)
    expect(annualLeaveMinutesExceedTypeDay({ code: 'annual', defaultMinutesPerDay: 480 }, 480)).toBe(false)
    expect(annualLeaveMinutesExceedTypeDay({ code: 'annual', defaultMinutesPerDay: 480 }, 240)).toBe(false)
    expect(annualLeaveMinutesExceedTypeDay({ code: 'sick', defaultMinutesPerDay: 480 }, 540)).toBe(false)
    expect(annualLeaveMinutesExceedTypeDay({ code: 'annual', defaultMinutesPerDay: 480 }, null)).toBe(false)
  })

  it('keeps the server settle sentence and names the two day rulers', () => {
    expect(isAnnualLeaveSettleErrorCode('ANNUAL_LEAVE_MULTI_DAY_UNSUPPORTED')).toBe(true)
    expect(isAnnualLeaveSettleErrorCode('COMP_TIME_BALANCE_INSUFFICIENT')).toBe(false)
    const submit = annualLeaveSettleStatusCopy(
      'Annual leave is single-day in v1: requested minutes exceed one standard work day',
      'request-submit',
      en,
    )
    expect(submit.message).toContain('single-day in v1')
    expect(submit.hint).toContain('was not saved')
    expect(submit.hint).toContain('policy standard day')
    const resolve = annualLeaveSettleStatusCopy('Annual leave balance insufficient: requested 480 min, available 0 min', 'request-resolve', en)
    expect(resolve.message).toContain('requested 480 min')
    expect(resolve.hint).toContain('did not change')
  })

  it('states the leave-type day in the submit block', () => {
    expect(annualLeaveExceedsTypeDayMessage(480, 540, en)).toContain('480')
    expect(annualLeaveExceedsTypeDayMessage(480, 540, en)).toContain('540')
  })
})