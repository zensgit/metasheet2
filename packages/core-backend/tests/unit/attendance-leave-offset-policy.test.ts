import { describe, expect, it } from 'vitest'

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceLeaveOffsetForTests as {
  LEAVE_DEDUCTION_POOLS: readonly string[]
  LEAVE_DEDUCTION_INSUFFICIENT_MODES: readonly string[]
  normalizeLeaveBalanceDeductionPolicySetting: (raw: unknown) => {
    enabled: boolean
    rules: Array<{ requestLeaveType: string; deductFrom: string[]; insufficient: string }>
  }
}

describe('#加班银行 v1-2a — LeaveOffsetPolicy normalizer (LATENT, enum-strict)', () => {
  const norm = helpers.normalizeLeaveBalanceDeductionPolicySetting

  it('default dormant: empty/garbage → { enabled:false, rules:[] }', () => {
    expect(norm(undefined)).toEqual({ enabled: false, rules: [] })
    expect(norm({})).toEqual({ enabled: false, rules: [] })
    expect(norm('x')).toEqual({ enabled: false, rules: [] })
  })

  it('keeps valid rules; deductFrom enum-strict + de-duped; insufficient defaults to block', () => {
    const r = norm({ enabled: true, rules: [
      { requestLeaveType: 'annual', deductFrom: ['annual'], insufficient: 'block' },
      { requestLeaveType: 'comp_time', deductFrom: ['comp_time'] },
      { requestLeaveType: 'personal_leave', deductFrom: ['comp_time', 'annual', 'comp_time'], insufficient: 'partial_unpaid_absence' },
    ] })
    expect(r.enabled).toBe(true)
    expect(r.rules).toEqual([
      { requestLeaveType: 'annual', deductFrom: ['annual'], insufficient: 'block' },
      { requestLeaveType: 'comp_time', deductFrom: ['comp_time'], insufficient: 'block' },
      { requestLeaveType: 'personal_leave', deductFrom: ['comp_time', 'annual'], insufficient: 'partial_unpaid_absence' },
    ])
  })

  it('drops invalid rules (no requestLeaveType, no valid pool, unknown pool/insufficient → defaults)', () => {
    const r = norm({ rules: [
      { deductFrom: ['comp_time'] },                                  // no requestLeaveType → dropped
      { requestLeaveType: 'x', deductFrom: ['bogus'] },               // no valid pool → dropped
      { requestLeaveType: 'y', deductFrom: ['unpaid', 42, 'bogus'] }, // keeps only 'unpaid'
      { requestLeaveType: 'z', deductFrom: ['annual'], insufficient: 'nope' }, // bad insufficient → block
    ] })
    expect(r.rules).toEqual([
      { requestLeaveType: 'y', deductFrom: ['unpaid'], insufficient: 'block' },
      { requestLeaveType: 'z', deductFrom: ['annual'], insufficient: 'block' },
    ])
  })

  it('the pool + insufficient vocabularies are the bounded enums', () => {
    expect([...helpers.LEAVE_DEDUCTION_POOLS].sort()).toEqual(['annual', 'comp_time', 'unpaid'])
    expect([...helpers.LEAVE_DEDUCTION_INSUFFICIENT_MODES].sort()).toEqual(['block', 'partial_unpaid_absence'])
  })
})
