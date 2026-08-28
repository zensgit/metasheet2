import { describe, expect, it } from 'vitest'
import {
  ElearningOfflineAttendancePolicyError,
  applyElearningOfflineAttendance,
  createElearningOfflineAttendancePolicy,
  evaluateElearningOfflineAttendanceCompletion,
} from '../../src/services/elearning-offline-attendance-policy'

const SENTINEL = 'secret-offline-value'

function target(targetKey: string, hourOffset = 0) {
  const hour = (value: number) => new Date(Date.UTC(
    2026,
    8,
    1,
    value + hourOffset,
  )).toISOString()
  return {
    checkInWindow: { closesAt: hour(10), opensAt: hour(8) },
    checkOutWindow: { closesAt: hour(14), opensAt: hour(11) },
    endsAt: hour(12),
    startsAt: hour(9),
    targetKey,
  }
}

function policy(overrides: Record<string, unknown> = {}) {
  return {
    attendanceMode: 'session',
    policyRevision: 'offline-v1',
    targets: [target('session-1'), target('session-2', 12)],
    ...overrides,
  }
}

function state(targetKey: string, overrides: Record<string, unknown> = {}) {
  return {
    checkedInAt: null,
    checkedOutAt: null,
    policyRevision: 'offline-v1',
    targetKey,
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected offline attendance policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningOfflineAttendancePolicyError)
    const policyError = error as ElearningOfflineAttendancePolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning offline attendance policy', () => {
  it('applies check-in then check-out and derives completion from timestamps', () => {
    const normalized = createElearningOfflineAttendancePolicy(policy())
    const checkedIn = applyElearningOfflineAttendance(normalized, state('session-1'), {
      action: 'check_in',
      now: '2026-09-01T09:00:00.000Z',
    })
    expect(checkedIn).toEqual({
      checkedInAt: '2026-09-01T09:00:00.000Z',
      checkedOutAt: null,
      completed: false,
      outcome: 'applied',
      policyRevision: 'offline-v1',
      status: 'checked_in',
      targetKey: 'session-1',
    })

    const checkedOut = applyElearningOfflineAttendance(normalized, state('session-1', {
      checkedInAt: checkedIn.checkedInAt,
    }), {
      action: 'check_out',
      now: '2026-09-01T12:00:00.000Z',
    })
    expect(checkedOut).toMatchObject({
      checkedOutAt: '2026-09-01T12:00:00.000Z',
      completed: true,
      outcome: 'applied',
      status: 'checked_out',
    })
  })

  it('uses half-open windows and returns stable denial outcomes', () => {
    const normalized = createElearningOfflineAttendancePolicy(policy())
    expect(applyElearningOfflineAttendance(normalized, state('session-1'), {
      action: 'check_in',
      now: '2026-09-01T07:59:59.999Z',
    }).outcome).toBe('window_not_open')
    expect(applyElearningOfflineAttendance(normalized, state('session-1'), {
      action: 'check_in',
      now: '2026-09-01T08:00:00.000Z',
    }).outcome).toBe('applied')
    expect(applyElearningOfflineAttendance(normalized, state('session-1'), {
      action: 'check_in',
      now: '2026-09-01T10:00:00.000Z',
    }).outcome).toBe('window_closed')
  })

  it('requires check-in before check-out and makes repeated actions idempotent', () => {
    const normalized = createElearningOfflineAttendancePolicy(policy())
    expect(applyElearningOfflineAttendance(normalized, state('session-1'), {
      action: 'check_out',
      now: '2026-09-01T12:00:00.000Z',
    }).outcome).toBe('check_in_required')

    const checkedIn = state('session-1', {
      checkedInAt: '2026-09-01T09:00:00.000Z',
    })
    expect(applyElearningOfflineAttendance(normalized, checkedIn, {
      action: 'check_in',
      now: '2026-09-01T09:30:00.000Z',
    })).toMatchObject({
      checkedInAt: '2026-09-01T09:00:00.000Z',
      outcome: 'already_applied',
    })

    const checkedOut = state('session-1', {
      checkedInAt: '2026-09-01T09:00:00.000Z',
      checkedOutAt: '2026-09-01T12:00:00.000Z',
    })
    expect(applyElearningOfflineAttendance(normalized, checkedOut, {
      action: 'check_out',
      now: '2026-09-01T13:00:00.000Z',
    })).toMatchObject({
      checkedOutAt: '2026-09-01T12:00:00.000Z',
      outcome: 'already_applied',
    })
  })

  it('rejects a stale checkout command when attendance windows overlap', () => {
    const normalized = createElearningOfflineAttendancePolicy(policy({
      targets: [{
        ...target('session-1'),
        checkOutWindow: {
          closesAt: '2026-09-01T14:00:00.000Z',
          opensAt: '2026-09-01T09:00:00.000Z',
        },
      }],
    }))
    const current = state('session-1', {
      checkedInAt: '2026-09-01T09:30:00.000Z',
    })
    expect(applyElearningOfflineAttendance(normalized, current, {
      action: 'check_out',
      now: '2026-09-01T09:00:00.000Z',
    })).toEqual({
      checkedInAt: '2026-09-01T09:30:00.000Z',
      checkedOutAt: null,
      completed: false,
      outcome: 'invalid_transition',
      policyRevision: 'offline-v1',
      status: 'checked_in',
      targetKey: 'session-1',
    })
  })

  it('requires every session target to be checked out before training completion', () => {
    const normalized = createElearningOfflineAttendancePolicy(policy())
    const partial = evaluateElearningOfflineAttendanceCompletion(normalized, {
      attendanceStates: [
        state('session-1', {
          checkedInAt: '2026-09-01T09:00:00.000Z',
          checkedOutAt: '2026-09-01T12:00:00.000Z',
        }),
        state('session-2'),
      ],
    })
    expect(partial).toEqual({
      completedTargetCount: 1,
      policyRevision: 'offline-v1',
      status: 'in_progress',
      totalTargetCount: 2,
    })

    const complete = evaluateElearningOfflineAttendanceCompletion(normalized, {
      attendanceStates: [
        state('session-2', {
          checkedInAt: '2026-09-01T21:00:00.000Z',
          checkedOutAt: '2026-09-02T00:00:00.000Z',
        }),
        state('session-1', {
          checkedInAt: '2026-09-01T09:00:00.000Z',
          checkedOutAt: '2026-09-01T12:00:00.000Z',
        }),
      ],
    })
    expect(complete).toMatchObject({ completedTargetCount: 2, status: 'completed' })
  })

  it('supports one training-level attendance target and rejects multiple targets', () => {
    const one = createElearningOfflineAttendancePolicy(policy({
      attendanceMode: 'training',
      targets: [target('training-1')],
    }))
    expect(one.targets).toHaveLength(1)
    expectCode(() => createElearningOfflineAttendancePolicy(policy({
      attendanceMode: 'training',
    })), 'invalid_policy')
  })

  it('rejects policy revision drift, unknown targets, and forged attendance history', () => {
    const normalized = createElearningOfflineAttendancePolicy(policy())
    expectCode(() => applyElearningOfflineAttendance(normalized, state('session-1', {
      policyRevision: 'offline-v2',
    }), { action: 'check_in', now: '2026-09-01T09:00:00.000Z' }), 'policy_mismatch')
    expectCode(() => applyElearningOfflineAttendance(normalized, state('unknown'), {
      action: 'check_in',
      now: '2026-09-01T09:00:00.000Z',
    }), 'unknown_target')
    expectCode(() => applyElearningOfflineAttendance(normalized, state('session-1', {
      checkedOutAt: '2026-09-01T12:00:00.000Z',
    }), { action: 'check_out', now: '2026-09-01T12:00:00.000Z' }), 'invalid_state')
    expectCode(() => applyElearningOfflineAttendance(normalized, state('session-1', {
      checkedInAt: '2026-09-01T07:00:00.000Z',
    }), { action: 'check_out', now: '2026-09-01T12:00:00.000Z' }), 'invalid_state')
  })

  it('rejects missing, duplicate, and extra completion targets', () => {
    const normalized = createElearningOfflineAttendancePolicy(policy())
    expectCode(() => evaluateElearningOfflineAttendanceCompletion(normalized, {
      attendanceStates: [state('session-1')],
    }), 'invalid_state')
    expectCode(() => evaluateElearningOfflineAttendanceCompletion(normalized, {
      attendanceStates: [state('session-1'), state('session-1')],
    }), 'invalid_state')
    expectCode(() => evaluateElearningOfflineAttendanceCompletion(normalized, {
      attendanceStates: [state('session-1'), state('unknown')],
    }), 'unknown_target')
  })

  it('rejects invalid policy chronology, duplicate targets, and malformed instants', () => {
    expectCode(() => createElearningOfflineAttendancePolicy(policy({
      targets: [target('session-1'), target('session-1')],
    })), 'invalid_policy')
    expectCode(() => createElearningOfflineAttendancePolicy(policy({
      targets: [{ ...target('session-1'), endsAt: '2026-09-01T09:00:00.000Z' }],
    })), 'invalid_policy')
    expectCode(() => createElearningOfflineAttendancePolicy(policy({
      targets: [{
        ...target('session-1'),
        checkOutWindow: {
          closesAt: '2026-09-01T09:00:00.000Z',
          opensAt: '2026-09-01T08:30:00.000Z',
        },
      }],
    })), 'invalid_policy')
    expectCode(() => createElearningOfflineAttendancePolicy(policy({
      policyRevision: '\ud800',
    })), 'invalid_policy')
    expectCode(() => createElearningOfflineAttendancePolicy(policy({
      targets: [{ ...target('session-1'), startsAt: '2026-09-01T09:00:00Z' }],
    })), 'invalid_policy')
  })

  it('rejects malformed shapes, sparse arrays, and hostile accessors values-free', () => {
    expectCode(() => createElearningOfflineAttendancePolicy(null), 'invalid_input')
    expectCode(() => createElearningOfflineAttendancePolicy({}), 'invalid_input')
    expectCode(() => createElearningOfflineAttendancePolicy(policy({
      extra: SENTINEL,
    })), 'invalid_input')
    expectCode(() => createElearningOfflineAttendancePolicy(policy({
      attendanceMode: 'unknown',
    })), 'invalid_policy')
    expectCode(() => createElearningOfflineAttendancePolicy(policy({
      targets: [],
    })), 'invalid_policy')
    expectCode(() => createElearningOfflineAttendancePolicy(policy({
      targets: new Array(1),
    })), 'invalid_input')

    const throwing = Object.defineProperty(policy(), 'policyRevision', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => createElearningOfflineAttendancePolicy(throwing), 'invalid_input')
    expectCode(() => createElearningOfflineAttendancePolicy(new Proxy(policy(), {
      ownKeys(): never { throw new Error(SENTINEL) },
    })), 'invalid_input')
  })

  it('returns deeply immutable policy and decision snapshots', () => {
    const normalized = createElearningOfflineAttendancePolicy(policy())
    const result = applyElearningOfflineAttendance(normalized, state('session-1'), {
      action: 'check_in',
      now: '2026-09-01T09:00:00.000Z',
    })
    expect(Object.isFrozen(normalized)).toBe(true)
    expect(Object.isFrozen(normalized.targets)).toBe(true)
    expect(normalized.targets.every((entry) => (
      Object.isFrozen(entry)
      && Object.isFrozen(entry.checkInWindow)
      && Object.isFrozen(entry.checkOutWindow)
    ))).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
  })
})
