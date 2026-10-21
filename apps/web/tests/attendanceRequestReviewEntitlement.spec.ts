import { describe, expect, it } from 'vitest'
import {
  canReviewAttendanceRequestRow,
  isAttendanceRequestPending,
} from '../src/views/attendance/attendanceRequestReviewEntitlement'

describe('isAttendanceRequestPending', () => {
  it('is true for a lowercase pending status', () => {
    expect(isAttendanceRequestPending({ status: 'pending' })).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isAttendanceRequestPending({ status: 'Pending' })).toBe(true)
  })

  it('is false for every non-pending status', () => {
    expect(isAttendanceRequestPending({ status: 'approved' })).toBe(false)
    expect(isAttendanceRequestPending({ status: 'rejected' })).toBe(false)
    expect(isAttendanceRequestPending({ status: 'cancelled' })).toBe(false)
  })

  it('is false when status is missing or blank', () => {
    expect(isAttendanceRequestPending({})).toBe(false)
    expect(isAttendanceRequestPending({ status: null })).toBe(false)
    expect(isAttendanceRequestPending({ status: '' })).toBe(false)
  })
})

describe('canReviewAttendanceRequestRow', () => {
  it('allows a pending request owned by someone else', () => {
    const row = { status: 'pending', user_id: 'other-user' }
    expect(canReviewAttendanceRequestRow(row, 'viewer', false)).toBe(true)
  })

  it('reads the camelCase userId fallback the same way', () => {
    const row = { status: 'pending', userId: 'other-user' }
    expect(canReviewAttendanceRequestRow(row, 'viewer', false)).toBe(true)
  })

  it('refuses a pending request owned by the viewer themselves', () => {
    const row = { status: 'pending', user_id: 'viewer' }
    expect(canReviewAttendanceRequestRow(row, 'viewer', false)).toBe(false)
  })

  it('refuses a non-pending request even when owned by someone else', () => {
    const row = { status: 'approved', user_id: 'other-user' }
    expect(canReviewAttendanceRequestRow(row, 'viewer', false)).toBe(false)
  })

  it('fails closed when the row carries no owner id at all', () => {
    const row = { status: 'pending' }
    expect(canReviewAttendanceRequestRow(row, 'viewer', false)).toBe(false)
  })

  it('fails closed when the viewer id has not resolved yet (null actor)', () => {
    const row = { status: 'pending', user_id: 'other-user' }
    expect(canReviewAttendanceRequestRow(row, null, false)).toBe(false)
    expect(canReviewAttendanceRequestRow(row, undefined, false)).toBe(false)
    expect(canReviewAttendanceRequestRow(row, '', false)).toBe(false)
  })

  it('honors the deep-link focus override even for a self-owned or ownerless pending row', () => {
    expect(canReviewAttendanceRequestRow({ status: 'pending', user_id: 'viewer' }, 'viewer', true)).toBe(true)
    expect(canReviewAttendanceRequestRow({ status: 'pending' }, 'viewer', true)).toBe(true)
  })

  it('never honors the focus override for a non-pending row', () => {
    expect(canReviewAttendanceRequestRow({ status: 'approved', user_id: 'other-user' }, 'viewer', true)).toBe(false)
  })
})
