import { describe, expect, it } from 'vitest'

const { hasReversedLivePunchOrder } = require('../../../../plugins/plugin-attendance/lib/attendance-live-punch-order.cjs')

describe('live punch projection chronology', () => {
  it('compares instants across timezone offsets, rather than wall-clock strings', () => {
    expect(hasReversedLivePunchOrder({ first_in_at: '2026-08-19T10:30:00+08:00', last_out_at: '2026-08-18T18:00:00-07:00' })).toBe(true)
    expect(hasReversedLivePunchOrder({ first_in_at: '2026-08-19T10:30:00+08:00', last_out_at: '2026-08-19T03:00:00-07:00' })).toBe(false)
  })

  it('keeps checkout-only, checkin-only, equal-time and overnight punches admissible', () => {
    const inAt = new Date('2026-08-19T22:00:00+08:00')
    expect(hasReversedLivePunchOrder({ first_in_at: null, last_out_at: inAt })).toBe(false)
    expect(hasReversedLivePunchOrder({ first_in_at: inAt, last_out_at: null })).toBe(false)
    expect(hasReversedLivePunchOrder({ first_in_at: inAt, last_out_at: inAt })).toBe(false)
    expect(hasReversedLivePunchOrder({ first_in_at: inAt, last_out_at: new Date('2026-08-20T06:00:00+08:00') })).toBe(false)
  })
})
