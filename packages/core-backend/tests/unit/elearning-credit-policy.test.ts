import { describe, expect, it } from 'vitest'
import {
  canonicalizeElearningCreditEffect,
  computeElearningCreditAward,
  elearningCreditDay,
  ELEARNING_CREDIT_BEHAVIORS,
  ElearningCreditPolicyError,
  hashElearningCreditEffect,
  normalizeElearningCreditBehavior,
  normalizeElearningCreditOccurredAt,
  normalizeElearningCreditRuleSnapshot,
  normalizeElearningCreditTimeZone,
  type ElearningCreditEffectInput,
} from '../../src/services/elearning-credit-policy'

const baseEffect = (over: Partial<ElearningCreditEffectInput> = {}): ElearningCreditEffectInput => ({
  behavior: 'pass_exam',
  effectKey: 'attempt:attempt-a',
  occurredAt: '2026-03-08T06:59:59.000Z',
  orgId: 'org-credit-a',
  reference: { attemptId: 'attempt-a', source: { kind: 'exam', version: 1 } },
  userId: 'user-credit-a',
  ...over,
})

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningCreditPolicyError)
    const policyError = error as ElearningCreditPolicyError
    expect(policyError.code).toBe(code)
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain('org-credit-a')
  }
}

describe('elearning credit policy', () => {
  it('accepts only the closed behavior set', () => {
    expect(ELEARNING_CREDIT_BEHAVIORS).toEqual([
      'login',
      'complete_course',
      'complete_plan',
      'pass_exam',
      'submit_survey',
      'complete_map',
      'complete_offline',
      'manual_adjust',
    ])
    for (const behavior of ELEARNING_CREDIT_BEHAVIORS) {
      expect(normalizeElearningCreditBehavior(behavior)).toBe(behavior)
    }
    expectCode(() => normalizeElearningCreditBehavior('bonus'), 'invalid_behavior')
  })

  it('normalizes only absolute timestamps to canonical UTC', () => {
    expect(normalizeElearningCreditOccurredAt('2026-01-02T10:04:05+08:00'))
      .toBe('2026-01-02T02:04:05.000Z')
    expect(normalizeElearningCreditOccurredAt(new Date('2026-01-02T02:04:05.123Z')))
      .toBe('2026-01-02T02:04:05.123Z')
    expectCode(() => normalizeElearningCreditOccurredAt('2026-01-02T10:04:05'), 'invalid_occurred_at')
    expectCode(() => normalizeElearningCreditOccurredAt('2026-02-30T10:04:05Z'), 'invalid_occurred_at')
    expectCode(() => normalizeElearningCreditOccurredAt('not-a-date'), 'invalid_occurred_at')
  })

  it('validates real IANA time zones without a host-timezone fallback', () => {
    expect(normalizeElearningCreditTimeZone('US/Pacific')).toBe('America/Los_Angeles')
    expect(normalizeElearningCreditTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expectCode(() => normalizeElearningCreditTimeZone('Mars/Olympus'), 'invalid_time_zone')
  })

  it('derives the local credit day across midnight and DST boundaries', () => {
    expect(elearningCreditDay('2026-01-01T15:59:59.000Z', 'Asia/Shanghai')).toBe('2026-01-01')
    expect(elearningCreditDay('2026-01-01T16:00:00.000Z', 'Asia/Shanghai')).toBe('2026-01-02')
    expect(elearningCreditDay('2026-03-08T06:59:59.000Z', 'America/New_York')).toBe('2026-03-08')
    expect(elearningCreditDay('2026-03-08T07:00:00.000Z', 'America/New_York')).toBe('2026-03-08')
    expect(elearningCreditDay('2026-11-01T05:30:00.000Z', 'America/New_York')).toBe('2026-11-01')
    expect(elearningCreditDay('2026-11-01T06:30:00.000Z', 'America/New_York')).toBe('2026-11-01')
  })

  it('awards up to an optional positive daily cap', () => {
    expect(computeElearningCreditAward({
      behavior: 'pass_exam', requestedPoints: 10, awardedToday: 0, dailyCap: 10,
    })).toEqual({
      requestedPoints: 10, awardedPoints: 10, remainingDailyCap: 0, status: 'awarded',
    })
    expect(computeElearningCreditAward({
      behavior: 'pass_exam', requestedPoints: 10, awardedToday: 7, dailyCap: 10,
    })).toEqual({
      requestedPoints: 10, awardedPoints: 3, remainingDailyCap: 0, status: 'capped',
    })
    expect(computeElearningCreditAward({
      behavior: 'pass_exam', requestedPoints: 1, awardedToday: 10, dailyCap: 10,
    })).toEqual({
      requestedPoints: 1, awardedPoints: 0, remainingDailyCap: 0, status: 'exhausted',
    })
    expect(computeElearningCreditAward({
      behavior: 'login', requestedPoints: 4, awardedToday: 99,
    })).toEqual({
      requestedPoints: 4, awardedPoints: 4, remainingDailyCap: null, status: 'awarded',
    })
  })

  it('permits negative manual adjustments without spending positive daily-cap room', () => {
    expect(computeElearningCreditAward({
      behavior: 'manual_adjust', requestedPoints: -6, awardedToday: 8, dailyCap: 10,
    })).toEqual({
      requestedPoints: -6, awardedPoints: -6, remainingDailyCap: 2, status: 'adjusted',
    })
    expectCode(() => computeElearningCreditAward({
      behavior: 'pass_exam', requestedPoints: -1, awardedToday: 0,
    }), 'invalid_input')
    expectCode(() => computeElearningCreditAward({
      behavior: 'login', requestedPoints: 1, awardedToday: 0, dailyCap: 0,
    }), 'invalid_input')
  })

  it('normalizes the server-selected rule snapshot separately from request identity', () => {
    expect(normalizeElearningCreditRuleSnapshot('pass_exam', {
      dailyCap: 20,
      id: 'rule-pass-exam',
      points: 10,
      timeZone: 'US/Pacific',
      version: 2,
    })).toEqual({
      dailyCap: 20,
      id: 'rule-pass-exam',
      points: 10,
      timeZone: 'America/Los_Angeles',
      version: 2,
    })
    expectCode(() => normalizeElearningCreditRuleSnapshot('pass_exam', {
      dailyCap: 0,
      id: 'rule-pass-exam',
      points: 10,
      timeZone: 'UTC',
      version: 1,
    }), 'invalid_input')
  })

  it('deep-sorts the versioned effect payload and changes the hash for logical changes', () => {
    const first = baseEffect({ reference: { z: 1, a: { second: 2, first: 1 } } })
    const reordered = baseEffect({ reference: { a: { first: 1, second: 2 }, z: 1 } })
    const canonical = canonicalizeElearningCreditEffect(first)

    expect(canonical).toBe(canonicalizeElearningCreditEffect(reordered))
    expect(hashElearningCreditEffect(first)).toBe(hashElearningCreditEffect(reordered))
    expect(canonical).toContain('"domain":"elearning.credit.effect.v1"')
    expect(canonical).toContain('"version":1')
    expect(hashElearningCreditEffect(first)).not.toBe(hashElearningCreditEffect(baseEffect({
      effectKey: 'attempt:attempt-b',
      reference: first.reference,
    })))
    expect(hashElearningCreditEffect(first)).not.toBe(hashElearningCreditEffect(baseEffect({
      occurredAt: '2026-03-08T07:00:00.000Z',
      reference: first.reference,
    })))
    expect(hashElearningCreditEffect(first)).not.toBe(hashElearningCreditEffect(baseEffect({
      reference: { z: 1, a: { first: 1, second: 3 } },
    })))
  })

  it('rejects ambiguous or unbounded effect metadata', () => {
    const sparse: unknown[] = []
    sparse.length = 1

    expectCode(() => canonicalizeElearningCreditEffect(baseEffect({
      reference: { sparse } as never,
    })), 'invalid_input')
    expectCode(() => canonicalizeElearningCreditEffect(baseEffect({
      effectKey: ' ',
    })), 'invalid_input')
  })
})
