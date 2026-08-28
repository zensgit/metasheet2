import { describe, expect, it } from 'vitest'

import {
  ELEARNING_OFFLINE_REWARD_DOMAIN,
  ElearningOfflineRewardPolicyError,
  createElearningOfflineRewardPolicy,
  deriveElearningOfflineRewards,
} from '../../src/services/elearning-offline-reward-policy'

const SENTINEL = 'secret-offline-reward-value'

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

function rewardPolicy(overrides: Record<string, unknown> = {}) {
  return {
    certificateTemplateRevisionId: 'certificate-template-v1',
    creditEnabled: true,
    rewardPolicyRevision: 'reward-v1',
    ...overrides,
  }
}

function attendanceState(
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
      attendanceState(
        'session-1',
        '2026-08-28T09:00:00.000Z',
        '2026-08-28T12:00:00.000Z',
      ),
      attendanceState(
        'session-2',
        '2026-08-29T09:00:00.000Z',
        '2026-08-29T12:00:00.000Z',
      ),
    ],
    beforeAttendanceStates: [
      attendanceState(
        'session-1',
        '2026-08-28T09:00:00.000Z',
        '2026-08-28T12:00:00.000Z',
      ),
      attendanceState(
        'session-2',
        '2026-08-29T09:00:00.000Z',
        null,
      ),
    ],
    trainingKey: 'offline-training-1',
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected offline reward policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningOfflineRewardPolicyError)
    const policyError = error as ElearningOfflineRewardPolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning offline reward policy', () => {
  it('emits stable credit and certificate intents only on completion transition', () => {
    const first = deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy(),
      transition(),
    )
    const replay = deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy(),
      transition(),
    )

    expect(first).toEqual(replay)
    expect(first).toEqual({
      attendancePolicyRevision: 'attendance-v1',
      certificateEffects: [{
        certificateTemplateRevisionId: 'certificate-template-v1',
        completedAt: '2026-08-29T12:00:00.000Z',
        effectKey: expect.stringMatching(
          new RegExp(`^${ELEARNING_OFFLINE_REWARD_DOMAIN}:[a-f0-9]{64}$`),
        ),
        kind: 'certificate',
        reference: {
          attendancePolicyRevision: 'attendance-v1',
          rewardPolicyRevision: 'reward-v1',
          trainingKey: 'offline-training-1',
        },
      }],
      completedAt: '2026-08-29T12:00:00.000Z',
      completedNow: true,
      creditEffects: [{
        behavior: 'complete_offline',
        completedAt: '2026-08-29T12:00:00.000Z',
        effectKey: expect.stringMatching(
          new RegExp(`^${ELEARNING_OFFLINE_REWARD_DOMAIN}:[a-f0-9]{64}$`),
        ),
        kind: 'credit',
        reference: {
          attendancePolicyRevision: 'attendance-v1',
          rewardPolicyRevision: 'reward-v1',
          trainingKey: 'offline-training-1',
        },
      }],
      rewardPolicyRevision: 'reward-v1',
    })
    expect(first.creditEffects[0].effectKey)
      .not.toBe(first.certificateEffects[0].effectKey)
    expect(first.creditEffects[0].effectKey).toBe(
      `${ELEARNING_OFFLINE_REWARD_DOMAIN}:7f1220a4112a392887783ffd57b0fd6b27a1e8e40aafc95ef189ba32dd99db19`,
    )
  })

  it('keeps one-time effect identities stable across reward policy amendments', () => {
    const first = deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy(),
      transition(),
    )
    const amended = deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy({
        certificateTemplateRevisionId: 'certificate-template-v2',
        rewardPolicyRevision: 'reward-v2',
      }),
      transition(),
    )
    expect(amended.creditEffects[0].effectKey).toBe(first.creditEffects[0].effectKey)
    expect(amended.certificateEffects[0].effectKey)
      .toBe(first.certificateEffects[0].effectKey)
    expect(amended.creditEffects[0].reference.rewardPolicyRevision).toBe('reward-v2')
    expect(amended.certificateEffects[0].certificateTemplateRevisionId)
      .toBe('certificate-template-v2')

    const otherTraining = deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy(),
      transition({ trainingKey: 'offline-training-2' }),
    )
    expect(otherTraining.creditEffects[0].effectKey)
      .not.toBe(first.creditEffects[0].effectKey)
  })

  it('supports independently disabled credit and certificate rewards', () => {
    const noCredit = deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy({ creditEnabled: false }),
      transition(),
    )
    expect(noCredit.creditEffects).toEqual([])
    expect(noCredit.certificateEffects).toHaveLength(1)

    const noCertificate = deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy({ certificateTemplateRevisionId: null }),
      transition(),
    )
    expect(noCertificate.creditEffects).toHaveLength(1)
    expect(noCertificate.certificateEffects).toEqual([])

    const neither = deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy({
        certificateTemplateRevisionId: null,
        creditEnabled: false,
      }),
      transition(),
    )
    expect(neither).toMatchObject({
      certificateEffects: [],
      completedAt: '2026-08-29T12:00:00.000Z',
      completedNow: true,
      creditEffects: [],
    })
  })

  it('uses the latest required exit as event-time completion for delayed evidence', () => {
    const afterAttendanceStates = transition().afterAttendanceStates
    const delayedEarlierSession = deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy(),
      transition({
        afterAttendanceStates,
        beforeAttendanceStates: [
          attendanceState(
            'session-1',
            '2026-08-28T09:00:00.000Z',
            null,
          ),
          attendanceState(
            'session-2',
            '2026-08-29T09:00:00.000Z',
            '2026-08-29T12:00:00.000Z',
          ),
        ],
      }),
    )
    expect(delayedEarlierSession.completedNow).toBe(true)
    expect(delayedEarlierSession.completedAt).toBe('2026-08-29T12:00:00.000Z')
    expect(delayedEarlierSession.creditEffects[0].completedAt)
      .toBe('2026-08-29T12:00:00.000Z')
  })

  it('supports one training-level attendance target', () => {
    const target = attendancePolicy().targets[0]
    const policy = {
      attendanceMode: 'training',
      policyRevision: 'attendance-v1',
      targets: [target],
    }
    const decision = deriveElearningOfflineRewards(
      policy,
      rewardPolicy(),
      transition({
        afterAttendanceStates: [attendanceState(
          'session-1',
          '2026-08-28T09:00:00.000Z',
          '2026-08-28T12:00:00.000Z',
        )],
        beforeAttendanceStates: [attendanceState(
          'session-1',
          '2026-08-28T09:00:00.000Z',
          null,
        )],
      }),
    )
    expect(decision).toMatchObject({
      completedAt: '2026-08-28T12:00:00.000Z',
      completedNow: true,
    })
  })

  it('does not emit effects before completion or after completion is already durable', () => {
    const partialAfter = [
      attendanceState(
        'session-1',
        '2026-08-28T09:00:00.000Z',
        '2026-08-28T12:00:00.000Z',
      ),
      attendanceState(
        'session-2',
        '2026-08-29T09:00:00.000Z',
        null,
      ),
    ]
    const partial = deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy(),
      transition({ afterAttendanceStates: partialAfter }),
    )
    expect(partial).toMatchObject({
      certificateEffects: [],
      completedAt: null,
      completedNow: false,
      creditEffects: [],
    })

    const completed = transition().afterAttendanceStates
    const alreadyCompleted = deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy(),
      transition({
        afterAttendanceStates: completed,
        beforeAttendanceStates: completed,
      }),
    )
    expect(alreadyCompleted).toMatchObject({
      certificateEffects: [],
      completedAt: null,
      completedNow: false,
      creditEffects: [],
    })
  })

  it('is independent of attendance-state array order', () => {
    const baseline = deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy(),
      transition(),
    )
    const input = transition()
    const reordered = deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy(),
      transition({
        afterAttendanceStates: [...input.afterAttendanceStates].reverse(),
        beforeAttendanceStates: [...input.beforeAttendanceStates].reverse(),
      }),
    )
    expect(reordered).toEqual(baseline)
  })

  it('rejects attendance regressions and mutation of prior evidence', () => {
    const completed = transition().afterAttendanceStates
    expectCode(() => deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy(),
      transition({
        afterAttendanceStates: transition().beforeAttendanceStates,
        beforeAttendanceStates: completed,
      }),
    ), 'invalid_transition')

    expectCode(() => deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy(),
      transition({
        afterAttendanceStates: [
          attendanceState(
            'session-1',
            '2026-08-28T09:01:00.000Z',
            '2026-08-28T12:00:00.000Z',
          ),
          completed[1],
        ],
      }),
    ), 'invalid_transition')
  })

  it('returns deeply immutable policy, decision, references, and effects', () => {
    const policy = createElearningOfflineRewardPolicy(rewardPolicy())
    const decision = deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy(),
      transition(),
    )
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(decision)).toBe(true)
    expect(Object.isFrozen(decision.creditEffects)).toBe(true)
    expect(Object.isFrozen(decision.certificateEffects)).toBe(true)
    expect(decision.creditEffects.every(Object.isFrozen)).toBe(true)
    expect(decision.certificateEffects.every(Object.isFrozen)).toBe(true)
    expect(Object.isFrozen(decision.creditEffects[0].reference)).toBe(true)
    expect(Object.isFrozen(decision.certificateEffects[0].reference)).toBe(true)
  })

  it('fails closed with values-free errors for malformed policy and evidence', () => {
    for (const [policyInput, code] of [
      [null, 'invalid_policy'],
      [{}, 'invalid_policy'],
      [rewardPolicy({ creditEnabled: 'true' }), 'invalid_policy'],
      [rewardPolicy({ certificateTemplateRevisionId: '' }), 'invalid_policy'],
      [rewardPolicy({ extra: SENTINEL }), 'invalid_policy'],
    ] as const) {
      expectCode(() => createElearningOfflineRewardPolicy(policyInput), code)
    }

    expectCode(() => deriveElearningOfflineRewards(
      { ...attendancePolicy(), attendanceMode: SENTINEL },
      rewardPolicy(),
      transition(),
    ), 'invalid_policy')
    expectCode(() => deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy(),
      transition({ extra: SENTINEL }),
    ), 'invalid_input')
    expectCode(() => deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy(),
      transition({ trainingKey: `${SENTINEL}\0` }),
    ), 'invalid_input')
    const mismatchedRevision = transition().afterAttendanceStates.map((state, index) => (
      index === 0 ? { ...state, policyRevision: 'attendance-v2' } : state
    ))
    expectCode(() => deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy(),
      transition({ afterAttendanceStates: mismatchedRevision }),
    ), 'invalid_transition')
    expectCode(() => deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy(),
      transition({
        afterAttendanceStates: [
          attendanceState('session-1', null, null),
          attendanceState('session-2', null, null),
        ],
      }),
    ), 'invalid_transition')

    const throwing = Object.defineProperty(transition(), 'trainingKey', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => deriveElearningOfflineRewards(
      attendancePolicy(),
      rewardPolicy(),
      throwing,
    ), 'invalid_input')
  })
})
