import { describe, expect, it } from 'vitest'

import {
  ELEARNING_NEW_HIRE_AUTO_ASSIGNMENT_DOMAIN,
  ElearningNewHireAutoAssignmentPolicyError,
  planElearningNewHireAutoAssignment,
} from '../../src/services/elearning-new-hire-auto-assignment-policy'

const SENTINEL = 'secret-new-hire-value'
const PROGRAM_ID = '10000000-0000-4000-8000-000000000001'
const PLAN_ID = '10000000-0000-4000-8000-000000000002'
const OTHER_PROGRAM_ID = '10000000-0000-4000-8000-000000000003'
const OTHER_PLAN_ID = '10000000-0000-4000-8000-000000000004'
const USER_ID = 'user-1'

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    activatedAt: '2026-08-01T00:00:00Z',
    audienceMatched: true,
    enabled: true,
    membershipActive: true,
    membershipCreatedAt: '2026-08-02T00:00:00Z',
    orgId: 'org-1',
    planId: PLAN_ID,
    programId: PROGRAM_ID,
    userActive: true,
    userId: USER_ID,
    ...overrides,
  }
}

function expectInvalid(value: unknown): void {
  try {
    planElearningNewHireAutoAssignment(value)
    throw new Error('expected new-hire auto-assignment policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningNewHireAutoAssignmentPolicyError)
    const policyError = error as ElearningNewHireAutoAssignmentPolicyError
    expect(policyError.code).toBe('invalid_input')
    expect(policyError.message).toBe('invalid_input')
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning new-hire auto-assignment policy', () => {
  it('returns one immutable single-user training-plan assignment request', () => {
    const result = planElearningNewHireAutoAssignment(candidate({
      activatedAt: '2026-08-01T08:00:00+08:00',
      orgId: ' org-1 ',
      planId: PLAN_ID.toUpperCase(),
      programId: PROGRAM_ID.toUpperCase(),
      userId: ' user-1 ',
    }))
    expect(result).toEqual({
      activatedAt: '2026-08-01T00:00:00.000Z',
      membershipCreatedAt: '2026-08-02T00:00:00.000Z',
      outcome: 'ready',
      planId: PLAN_ID,
      programId: PROGRAM_ID,
      rules: [{
        includeChildren: false,
        subjectRef: USER_ID,
        subjectType: 'user',
      }],
      sourceKey: expect.stringMatching(/^elearning-new-hire-v1:[a-f0-9]{64}$/),
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.rules)).toBe(true)
    expect(result.rules.every(Object.isFrozen)).toBe(true)
    expect(ELEARNING_NEW_HIRE_AUTO_ASSIGNMENT_DOMAIN).toBe(
      'elearning.new_hire.auto_assignment.v1',
    )
  })

  it('keeps the effect identity stable across retries, offsets, and plan edits', () => {
    const first = planElearningNewHireAutoAssignment(candidate())
    const replay = planElearningNewHireAutoAssignment(candidate({
      membershipCreatedAt: '2026-08-02T08:00:00+08:00',
      planId: OTHER_PLAN_ID,
    }))
    expect(replay.sourceKey).toBe(first.sourceKey)
    expect(replay.planId).toBe(OTHER_PLAN_ID)
  })

  it('separates effects by organization, program, user, and first membership instant', () => {
    const plans = [
      candidate(),
      candidate({ orgId: 'org-2' }),
      candidate({ programId: OTHER_PROGRAM_ID }),
      candidate({ userId: 'user-2' }),
      candidate({ membershipCreatedAt: '2026-08-03T00:00:00Z' }),
    ].map(planElearningNewHireAutoAssignment)
    expect(new Set(plans.map((plan) => plan.sourceKey)).size).toBe(plans.length)
  })

  it('accepts membership created exactly when the program becomes active', () => {
    const result = planElearningNewHireAutoAssignment(candidate({
      membershipCreatedAt: '2026-08-01T00:00:00Z',
    }))
    expect(result.outcome).toBe('ready')
    expect(result.sourceKey).not.toBeNull()
  })

  it('never creates an effect for disabled programs', () => {
    expect(planElearningNewHireAutoAssignment(candidate({ enabled: false }))).toEqual({
      activatedAt: '2026-08-01T00:00:00.000Z',
      membershipCreatedAt: '2026-08-02T00:00:00.000Z',
      outcome: 'disabled',
      planId: PLAN_ID,
      programId: PROGRAM_ID,
      rules: [],
      sourceKey: null,
    })
  })

  it('never creates an effect for an inactive membership or inactive user', () => {
    for (const overrides of [
      { membershipActive: false },
      { userActive: false },
      { membershipActive: false, userActive: false },
    ]) {
      const result = planElearningNewHireAutoAssignment(candidate(overrides))
      expect(result).toMatchObject({
        outcome: 'inactive_member',
        rules: [],
        sourceKey: null,
      })
    }
  })

  it('does not backfill members who joined before program activation', () => {
    const result = planElearningNewHireAutoAssignment(candidate({
      membershipCreatedAt: '2026-07-31T23:59:59.999Z',
    }))
    expect(result).toMatchObject({
      outcome: 'preexisting_member',
      rules: [],
      sourceKey: null,
    })
  })

  it('leaves unmatched candidates effect-free so late directory data can be retried', () => {
    const result = planElearningNewHireAutoAssignment(candidate({
      audienceMatched: false,
    }))
    expect(result).toMatchObject({
      outcome: 'audience_not_matched',
      rules: [],
      sourceKey: null,
    })
  })

  it('rejects invalid and open inputs values-free', () => {
    for (const value of [
      null,
      {},
      { ...candidate(), extra: SENTINEL },
      candidate({ activatedAt: '2026-08-01 00:00:00' }),
      candidate({ membershipCreatedAt: '2026-02-30T00:00:00Z' }),
      candidate({ audienceMatched: 'yes' }),
      candidate({ enabled: 'yes' }),
      candidate({ membershipActive: 1 }),
      candidate({ userActive: null }),
      candidate({ orgId: '' }),
      candidate({ orgId: '\ud800' }),
      candidate({ orgId: `org-${SENTINEL}\0` }),
      candidate({ planId: 'plan-1' }),
      candidate({ programId: 'program-1' }),
      candidate({ userId: '' }),
      candidate({ userId: '\udc00' }),
    ]) expectInvalid(value)
  })

  it('rejects accessors and non-enumerable input fields without leaking values', () => {
    const getter = { ...candidate() }
    Object.defineProperty(getter, 'userId', {
      enumerable: true,
      get() {
        throw new Error(SENTINEL)
      },
    })
    expectInvalid(getter)

    const hidden = { ...candidate() }
    Object.defineProperty(hidden, 'hidden', { value: SENTINEL })
    expectInvalid(hidden)
  })
})
