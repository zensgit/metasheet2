import { describe, expect, it } from 'vitest'
import {
  ElearningWatchChallengeScheduleError,
  createElearningWatchChallengeSchedule,
  resolveElearningWatchChallengeDue,
} from '../../src/services/elearning-watch-challenge-schedule'

const SENTINEL = 'secret-policy-revision'

function policy(overrides: Record<string, unknown> = {}) {
  return {
    challengeCount: 3,
    entropy: [0, 39_999, 39_999],
    minimumVideoDurationMs: 60_000,
    policyRevision: 'policy-v1',
    responseWindowMs: 120_000,
    videoDurationMs: 120_000,
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected challenge schedule error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningWatchChallengeScheduleError)
    const scheduleError = error as ElearningWatchChallengeScheduleError
    expect(scheduleError.code).toBe(code)
    expect(scheduleError.message).toBe(code)
    expect(scheduleError.cause).toBeUndefined()
    expect(`${scheduleError.message}\n${scheduleError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning watch challenge schedule', () => {
  it('creates deterministic stratified checkpoints strictly inside the video', () => {
    const schedule = createElearningWatchChallengeSchedule(policy())
    expect(schedule).toEqual({
      checkpoints: [
        { ordinal: 1, targetTrustedMs: 1 },
        { ordinal: 2, targetTrustedMs: 79_999 },
        { ordinal: 3, targetTrustedMs: 119_999 },
      ],
      mode: 'scheduled',
      policyRevision: 'policy-v1',
      responseWindowMs: 120_000,
      videoDurationMs: 120_000,
    })
    expect(Object.isFrozen(schedule)).toBe(true)
    expect(Object.isFrozen(schedule.checkpoints)).toBe(true)
    expect(schedule.checkpoints.every(Object.isFrozen)).toBe(true)
  })

  it('accepts the contract maxima of ten challenges and a 120 second window', () => {
    const schedule = createElearningWatchChallengeSchedule(policy({
      challengeCount: 10,
      entropy: Array.from({ length: 10 }, (_, index) => index),
      videoDurationMs: 600_000,
    }))
    expect(schedule.checkpoints).toHaveLength(10)
    expect(schedule.responseWindowMs).toBe(120_000)
    expect(schedule.checkpoints.map((row) => row.ordinal)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ])
  })

  it('rejects policies above either contract maximum', () => {
    expectCode(() => createElearningWatchChallengeSchedule(policy({
      challengeCount: 11,
      entropy: Array.from({ length: 11 }, () => 0),
    })), 'invalid_policy')
    expectCode(() => createElearningWatchChallengeSchedule(policy({
      responseWindowMs: 120_001,
    })), 'invalid_policy')
  })

  it('exempts videos below the explicit threshold but schedules at the boundary', () => {
    const exempt = createElearningWatchChallengeSchedule(policy({
      entropy: [],
      videoDurationMs: 59_999,
    }))
    expect(exempt.mode).toBe('short_video_exempt')
    expect(exempt.checkpoints).toEqual([])

    const boundary = createElearningWatchChallengeSchedule(policy({
      entropy: [0, 0, 0],
      videoDurationMs: 60_000,
    }))
    expect(boundary.mode).toBe('scheduled')
    expect(boundary.checkpoints).toHaveLength(3)
  })

  it('supports an explicit zero-challenge policy without consuming entropy', () => {
    const schedule = createElearningWatchChallengeSchedule(policy({
      challengeCount: 0,
      entropy: [],
    }))
    expect(schedule.mode).toBe('disabled')
    expect(schedule.checkpoints).toEqual([])
    expect(resolveElearningWatchChallengeDue(schedule, {
      issuedCount: 0,
      trustedMs: Number.MAX_SAFE_INTEGER,
    })).toBeNull()
  })

  it('requires one bounded server entropy value for every scheduled checkpoint', () => {
    for (const entropy of [
      [],
      [0, 1],
      [0, 1, 2, 3],
      [0, 1, -1],
      [0, 1, 0.5],
      [0, 1, 0x1_0000_0000],
      'entropy',
    ]) {
      expectCode(() => createElearningWatchChallengeSchedule(policy({ entropy })), 'invalid_entropy')
    }
    expectCode(() => createElearningWatchChallengeSchedule(policy({
      entropy: [0],
      videoDurationMs: 1,
      challengeCount: 1,
      minimumVideoDurationMs: 1,
    })), 'insufficient_duration')
  })

  it('resolves each checkpoint only at or after its trusted-watch target', () => {
    const schedule = createElearningWatchChallengeSchedule(policy())
    expect(resolveElearningWatchChallengeDue(schedule, {
      issuedCount: 1,
      trustedMs: 79_998,
    })).toBeNull()

    const due = resolveElearningWatchChallengeDue(schedule, {
      issuedCount: 1,
      trustedMs: 79_999,
    })
    expect(due).toEqual({
      ordinal: 2,
      policyRevision: 'policy-v1',
      responseWindowMs: 120_000,
      targetTrustedMs: 79_999,
    })
    expect(Object.keys(due ?? {})).toEqual([
      'ordinal', 'policyRevision', 'responseWindowMs', 'targetTrustedMs',
    ])
    expect(Object.isFrozen(due)).toBe(true)
    expect(resolveElearningWatchChallengeDue(schedule, {
      issuedCount: 3,
      trustedMs: 120_000,
    })).toBeNull()
  })

  it('pins the policy revision into schedule and due DTOs', () => {
    const schedule = createElearningWatchChallengeSchedule(policy({
      policyRevision: '  revision-v7  ',
    }))
    expect(schedule.policyRevision).toBe('revision-v7')
    expect(resolveElearningWatchChallengeDue(schedule, {
      issuedCount: 0,
      trustedMs: schedule.checkpoints[0].targetTrustedMs,
    })?.policyRevision).toBe('revision-v7')
  })

  it('rejects malformed policy, duration, and due inputs with values-free errors', () => {
    for (const input of [
      null,
      [],
      {},
      policy({ extra: SENTINEL }),
      policy({ challengeCount: -1 }),
      policy({ minimumVideoDurationMs: 0 }),
      policy({ responseWindowMs: 0 }),
      policy({ videoDurationMs: 0 }),
      policy({ videoDurationMs: Number.MAX_SAFE_INTEGER + 1 }),
      policy({ policyRevision: SENTINEL + '\0' }),
      policy({ policyRevision: '\ud800' }),
    ]) {
      expectCode(() => createElearningWatchChallengeSchedule(input), (
        input && typeof input === 'object' && 'policyRevision' in input
        && ((input as { policyRevision?: unknown }).policyRevision === SENTINEL + '\0'
          || (input as { policyRevision?: unknown }).policyRevision === '\ud800')
      ) ? 'invalid_policy' : 'invalid_input')
    }

    const schedule = createElearningWatchChallengeSchedule(policy())
    for (const due of [
      null,
      {},
      { issuedCount: 0, trustedMs: 1, extra: SENTINEL },
      { issuedCount: -1, trustedMs: 1 },
      { issuedCount: 4, trustedMs: 120_000 },
      { issuedCount: 0, trustedMs: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expectCode(() => resolveElearningWatchChallengeDue(schedule, due), 'invalid_input')
    }
  })

  it('fails closed on hostile input accessors', () => {
    const throwing = Object.defineProperty(policy(), 'policyRevision', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => createElearningWatchChallengeSchedule(throwing), 'invalid_input')
    expectCode(() => createElearningWatchChallengeSchedule(new Proxy(policy(), {
      ownKeys(): never { throw new Error(SENTINEL) },
    })), 'invalid_input')
  })
})
