import { describe, expect, it } from 'vitest'

import {
  CANCEL_ROUND_ALLOWED_SEAT_ARMS,
  cancelRoundSeatArmsWithinFence,
} from '../../src/services/ApprovalProductService'

/**
 * 撤销锁增补 P-11 (c) — lock §14.1 seat-arm fence (RATIFY 追记 2026-09-28): a cancel round's seats may
 * only be `user` / `role` arms; `source_queue` is excluded. The creation path refuses (registered code,
 * before any write) whenever this predicate is false — its real-DB witness lives in the attendance
 * entry suite; this file pins the predicate itself, both directions.
 */
describe('cancel-round seat-arm fence', () => {
  it('the allowed set is exactly the two person arms', () => {
    expect([...CANCEL_ROUND_ALLOWED_SEAT_ARMS].sort()).toEqual(['role', 'user'])
  })

  it('user and role seats pass', () => {
    expect(cancelRoundSeatArmsWithinFence([{ assignmentType: 'user' }])).toBe(true)
    expect(cancelRoundSeatArmsWithinFence([{ assignmentType: 'user' }, { assignmentType: 'role' }])).toBe(true)
  })

  it.each([['source_queue'], ['permission'], [''], [undefined], [null]])(
    'a seat of arm %s anywhere in the set fails the fence',
    (arm) => {
      expect(cancelRoundSeatArmsWithinFence([{ assignmentType: 'user' }, { assignmentType: arm }])).toBe(false)
      expect(cancelRoundSeatArmsWithinFence([{ assignmentType: arm }])).toBe(false)
    },
  )
})
