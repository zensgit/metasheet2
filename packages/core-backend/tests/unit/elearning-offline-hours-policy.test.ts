import { describe, expect, it } from 'vitest'

import {
  ELEARNING_OFFLINE_HOURS_DOMAIN,
  ElearningOfflineHoursPolicyError,
  createElearningOfflineHoursPolicy,
  deriveElearningOfflineHours,
} from '../../src/services/elearning-offline-hours-policy'

const SENTINEL = 'secret-offline-hours-value'

function attendancePolicy() {
  return {
    attendanceMode: 'session',
    policyRevision: 'attendance-v1',
    targets: [
      {
        checkInWindow: {
          closesAt: '2026-08-28T09:30:00.000Z',
          opensAt: '2026-08-28T08:30:00.000Z',
        },
        checkOutWindow: {
          closesAt: '2026-08-28T12:30:00.000Z',
          opensAt: '2026-08-28T11:30:00.000Z',
        },
        endsAt: '2026-08-28T12:00:00.000Z',
        startsAt: '2026-08-28T09:00:00.000Z',
        targetKey: 'session-1',
      },
      {
        checkInWindow: {
          closesAt: '2026-08-29T09:30:00.000Z',
          opensAt: '2026-08-29T08:30:00.000Z',
        },
        checkOutWindow: {
          closesAt: '2026-08-29T12:30:00.000Z',
          opensAt: '2026-08-29T11:30:00.000Z',
        },
        endsAt: '2026-08-29T12:00:00.000Z',
        startsAt: '2026-08-29T09:00:00.000Z',
        targetKey: 'session-2',
      },
    ],
  }
}

function hoursPolicy(overrides: Record<string, unknown> = {}) {
  return {
    creditedMinutes: 360,
    hoursPolicyRevision: 'hours-v1',
    ...overrides,
  }
}

function state(
  targetKey: string,
  checkedInAt: string | null,
  checkedOutAt: string | null,
) {
  return {
    checkedInAt,
    checkedOutAt,
    policyRevision: 'attendance-v1',
    targetKey,
  }
}

function transition(overrides: Record<string, unknown> = {}) {
  return {
    afterAttendanceStates: [
      state('session-1', '2026-08-28T09:00:00.000Z', '2026-08-28T12:00:00.000Z'),
      state('session-2', '2026-08-29T09:00:00.000Z', '2026-08-29T12:00:00.000Z'),
    ],
    beforeAttendanceStates: [
      state('session-1', '2026-08-28T09:00:00.000Z', '2026-08-28T12:00:00.000Z'),
      state('session-2', '2026-08-29T09:00:00.000Z', null),
    ],
    trainingKey: 'offline-training-1',
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected offline hours policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningOfflineHoursPolicyError)
    const policyError = error as ElearningOfflineHoursPolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning offline hours policy', () => {
  it('emits one stable total-hours intent on authoritative completion', () => {
    const first = deriveElearningOfflineHours(
      attendancePolicy(),
      hoursPolicy(),
      transition(),
    )
    const replay = deriveElearningOfflineHours(
      attendancePolicy(),
      hoursPolicy(),
      transition(),
    )
    expect(first).toEqual(replay)
    expect(first).toEqual({
      attendancePolicyRevision: 'attendance-v1',
      completedAt: '2026-08-29T12:00:00.000Z',
      completedNow: true,
      hourEffects: [{
        completedAt: '2026-08-29T12:00:00.000Z',
        creditedMinutes: 360,
        effectKey: expect.stringMatching(
          new RegExp(`^${ELEARNING_OFFLINE_HOURS_DOMAIN}:[a-f0-9]{64}$`),
        ),
        kind: 'learning_hours',
        reference: {
          attendancePolicyRevision: 'attendance-v1',
          hoursPolicyRevision: 'hours-v1',
          trainingKey: 'offline-training-1',
        },
      }],
      hoursPolicyRevision: 'hours-v1',
    })
    expect(first.hourEffects[0].effectKey).toBe(
      `${ELEARNING_OFFLINE_HOURS_DOMAIN}:06eeae9f60547bfcc082690aa904abfca44e602c504c832f9fbd4a869dc0ad08`,
    )
  })

  it('keeps effect identity stable across policy changes and distinct by training', () => {
    const first = deriveElearningOfflineHours(
      attendancePolicy(),
      hoursPolicy(),
      transition(),
    )
    const amended = deriveElearningOfflineHours(
      attendancePolicy(),
      hoursPolicy({ creditedMinutes: 420, hoursPolicyRevision: 'hours-v2' }),
      transition(),
    )
    expect(amended.hourEffects[0].effectKey).toBe(first.hourEffects[0].effectKey)
    expect(amended.hourEffects[0]).toMatchObject({
      creditedMinutes: 420,
      reference: { hoursPolicyRevision: 'hours-v2' },
    })

    const otherTraining = deriveElearningOfflineHours(
      attendancePolicy(),
      hoursPolicy(),
      transition({ trainingKey: 'offline-training-2' }),
    )
    expect(otherTraining.hourEffects[0].effectKey)
      .not.toBe(first.hourEffects[0].effectKey)
  })

  it('supports an explicit no-hours policy without hiding completion', () => {
    const decision = deriveElearningOfflineHours(
      attendancePolicy(),
      hoursPolicy({ creditedMinutes: null }),
      transition(),
    )
    expect(decision).toMatchObject({
      completedAt: '2026-08-29T12:00:00.000Z',
      completedNow: true,
      hourEffects: [],
    })
  })

  it('does not emit before completion or for an already durable completion', () => {
    const partial = transition().beforeAttendanceStates
    expect(deriveElearningOfflineHours(
      attendancePolicy(),
      hoursPolicy(),
      transition({ afterAttendanceStates: partial }),
    )).toMatchObject({ completedAt: null, completedNow: false, hourEffects: [] })

    const completed = transition().afterAttendanceStates
    expect(deriveElearningOfflineHours(
      attendancePolicy(),
      hoursPolicy(),
      transition({
        afterAttendanceStates: completed,
        beforeAttendanceStates: completed,
      }),
    )).toMatchObject({ completedAt: null, completedNow: false, hourEffects: [] })
  })

  it('inherits attendance monotonicity, policy revision, and state-shape guards', () => {
    const completed = transition().afterAttendanceStates
    expectCode(() => deriveElearningOfflineHours(
      attendancePolicy(),
      hoursPolicy(),
      transition({
        afterAttendanceStates: transition().beforeAttendanceStates,
        beforeAttendanceStates: completed,
      }),
    ), 'invalid_transition')
    expectCode(() => deriveElearningOfflineHours(
      attendancePolicy(),
      hoursPolicy(),
      transition({
        afterAttendanceStates: completed.map((snapshot, index) => (
          index === 0 ? { ...snapshot, policyRevision: 'attendance-v2' } : snapshot
        )),
      }),
    ), 'invalid_transition')
  })

  it('returns deeply immutable policy, decision, effect, and reference', () => {
    const policy = createElearningOfflineHoursPolicy(hoursPolicy())
    const decision = deriveElearningOfflineHours(
      attendancePolicy(),
      hoursPolicy(),
      transition(),
    )
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(decision)).toBe(true)
    expect(Object.isFrozen(decision.hourEffects)).toBe(true)
    expect(Object.isFrozen(decision.hourEffects[0])).toBe(true)
    expect(Object.isFrozen(decision.hourEffects[0].reference)).toBe(true)
  })

  it('rejects malformed policy and transition values-free', () => {
    for (const input of [
      null,
      {},
      hoursPolicy({ creditedMinutes: 0 }),
      hoursPolicy({ creditedMinutes: -1 }),
      hoursPolicy({ creditedMinutes: 1.5 }),
      hoursPolicy({ creditedMinutes: Number.MAX_SAFE_INTEGER + 1 }),
      hoursPolicy({ hoursPolicyRevision: `${SENTINEL}\0` }),
      hoursPolicy({ extra: SENTINEL }),
    ]) {
      expectCode(() => createElearningOfflineHoursPolicy(input), 'invalid_policy')
    }
    expectCode(() => deriveElearningOfflineHours(
      { ...attendancePolicy(), attendanceMode: SENTINEL },
      hoursPolicy(),
      transition(),
    ), 'invalid_policy')
    expectCode(() => deriveElearningOfflineHours(
      attendancePolicy(),
      hoursPolicy(),
      transition({ trainingKey: `${SENTINEL}\0` }),
    ), 'invalid_input')

    const throwing = Object.defineProperty(transition(), 'trainingKey', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => deriveElearningOfflineHours(
      attendancePolicy(),
      hoursPolicy(),
      throwing,
    ), 'invalid_input')
  })
})
