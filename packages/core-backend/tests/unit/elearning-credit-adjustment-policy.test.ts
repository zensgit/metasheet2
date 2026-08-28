import { describe, expect, it } from 'vitest'
import {
  ELEARNING_CREDIT_EFFECT_HASH_VERSION,
  ElearningCreditPolicyError,
  hashElearningCreditEffect,
} from '../../src/services/elearning-credit-policy'
import {
  normalizeElearningCreditManualAdjustment,
} from '../../src/services/elearning-credit-adjustment-policy'

const baseInput = () => ({
  actorId: 'actor-secret-a',
  effectKey: 'manual:adjust-secret-a',
  occurredAt: '2026-04-01T10:00:00+08:00',
  orgId: 'org-secret-a',
  points: 5,
  reason: 'reason-secret-a',
  userId: 'user-secret-a',
})

const baseEffect = (over: Record<string, unknown> = {}) => ({
  behavior: 'manual_adjust' as const,
  effectKey: 'manual:adjust-secret-a',
  occurredAt: '2026-04-01T02:00:00.000Z',
  orgId: 'org-secret-a',
  reference: { actorId: 'actor-secret-a', points: 5, reason: 'reason-secret-a' },
  userId: 'user-secret-a',
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
    const surface = `${policyError.message}\n${policyError.stack ?? ''}`
    expect(surface).not.toContain('secret')
  }
}

describe('elearning credit adjustment policy', () => {
  it('produces a frozen exact-shape manual_adjust command', () => {
    const command = normalizeElearningCreditManualAdjustment(baseInput())
    expect(Object.keys(command).sort()).toEqual([
      'actorId',
      'behavior',
      'effectKey',
      'occurredAt',
      'orgId',
      'points',
      'reason',
      'requestHash',
      'requestHashVersion',
      'userId',
    ])
    expect(command).toMatchObject({
      actorId: 'actor-secret-a',
      behavior: 'manual_adjust',
      effectKey: 'manual:adjust-secret-a',
      occurredAt: '2026-04-01T02:00:00.000Z',
      orgId: 'org-secret-a',
      points: 5,
      reason: 'reason-secret-a',
      requestHashVersion: ELEARNING_CREDIT_EFFECT_HASH_VERSION,
      userId: 'user-secret-a',
    })
    expect(Object.isFrozen(command)).toBe(true)
    expect(() => {
      ;(command as { points: number }).points = 9
    }).toThrow(TypeError)
    expect(command.points).toBe(5)
  })

  it('trims text fields and canonicalizes occurredAt to UTC', () => {
    const command = normalizeElearningCreditManualAdjustment({
      ...baseInput(),
      actorId: '  actor-secret-a\t',
      orgId: ' org-secret-a ',
      reason: '  reason-secret-a  ',
      userId: '\nuser-secret-a ',
    })
    expect(command.actorId).toBe('actor-secret-a')
    expect(command.orgId).toBe('org-secret-a')
    expect(command.reason).toBe('reason-secret-a')
    expect(command.userId).toBe('user-secret-a')
    expect(command.occurredAt).toBe('2026-04-01T02:00:00.000Z')
    expect(normalizeElearningCreditManualAdjustment({
      ...baseInput(),
      occurredAt: new Date('2026-04-01T02:00:00.123Z'),
    }).occurredAt).toBe('2026-04-01T02:00:00.123Z')
  })

  it('accepts positive and negative adjustments without a balance or approval rule', () => {
    expect(normalizeElearningCreditManualAdjustment(baseInput()).points).toBe(5)
    expect(normalizeElearningCreditManualAdjustment({ ...baseInput(), points: -9 }).points).toBe(-9)
    expect(normalizeElearningCreditManualAdjustment({ ...baseInput(), points: 1 }).points).toBe(1)
    expectCode(() => normalizeElearningCreditManualAdjustment({ ...baseInput(), points: 0 }), 'invalid_input')
  })

  it('derives requestHash from the shared effect hash with the exact reference', () => {
    const command = normalizeElearningCreditManualAdjustment(baseInput())
    expect(command.requestHash).toBe(hashElearningCreditEffect(baseEffect()))
    expect(command.requestHash).toBe(hashElearningCreditEffect(baseEffect({
      reference: { reason: 'reason-secret-a', points: 5, actorId: 'actor-secret-a' },
    })))
    expect(command.requestHashVersion).toBe(1)
  })

  it('replays deterministically and changes the hash for any logical change', () => {
    const first = normalizeElearningCreditManualAdjustment(baseInput())
    const reorderedKeys = {
      userId: 'user-secret-a',
      reason: 'reason-secret-a',
      points: 5,
      orgId: 'org-secret-a',
      occurredAt: '2026-04-01T10:00:00+08:00',
      effectKey: 'manual:adjust-secret-a',
      actorId: 'actor-secret-a',
    }
    expect(normalizeElearningCreditManualAdjustment(reorderedKeys).requestHash)
      .toBe(first.requestHash)
    expect(normalizeElearningCreditManualAdjustment(baseInput()).requestHash)
      .toBe(first.requestHash)

    const variants: Array<Record<string, unknown>> = [
      { actorId: 'actor-secret-b' },
      { effectKey: 'manual:adjust-secret-b' },
      { occurredAt: '2026-04-01T10:00:01+08:00' },
      { orgId: 'org-secret-b' },
      { points: -5 },
      { points: 6 },
      { reason: 'reason-secret-b' },
      { userId: 'user-secret-b' },
    ]
    for (const variant of variants) {
      expect(normalizeElearningCreditManualAdjustment({ ...baseInput(), ...variant }).requestHash)
        .not.toBe(first.requestHash)
    }
  })

  it('rejects extra, missing, or non-string own keys', () => {
    expectCode(() => normalizeElearningCreditManualAdjustment({
      ...baseInput(), extra: 'secret-extra',
    }), 'invalid_input')
    for (const key of Object.keys(baseInput()) as Array<keyof ReturnType<typeof baseInput>>) {
      const missing = baseInput() as Record<string, unknown>
      delete missing[key]
      expectCode(() => normalizeElearningCreditManualAdjustment(missing), 'invalid_input')
    }
    expectCode(() => normalizeElearningCreditManualAdjustment({
      ...baseInput(), [Symbol('secret-symbol')]: 'secret-symbol-value',
    }), 'invalid_input')
  })

  it('rejects non-object, array, and null input', () => {
    for (const input of [null, undefined, 'org-secret-a', 5, true, [baseInput()]]) {
      expectCode(() => normalizeElearningCreditManualAdjustment(input), 'invalid_input')
    }
  })

  it('rejects malformed, empty, oversized, or non-string text fields', () => {
    for (const field of ['actorId', 'effectKey', 'orgId', 'reason', 'userId'] as const) {
      expectCode(() => normalizeElearningCreditManualAdjustment({
        ...baseInput(), [field]: 42,
      }), 'invalid_input')
      expectCode(() => normalizeElearningCreditManualAdjustment({
        ...baseInput(), [field]: '   ',
      }), 'invalid_input')
      expectCode(() => normalizeElearningCreditManualAdjustment({
        ...baseInput(), [field]: 'secret\u0000value',
      }), 'invalid_input')
      expectCode(() => normalizeElearningCreditManualAdjustment({
        ...baseInput(), [field]: 'secret\ud800value',
      }), 'invalid_input')
      expectCode(() => normalizeElearningCreditManualAdjustment({
        ...baseInput(), [field]: 'secret\udc00value',
      }), 'invalid_input')
      expectCode(() => normalizeElearningCreditManualAdjustment({
        ...baseInput(), [field]: `secret-${'x'.repeat(513)}`,
      }), 'invalid_input')
    }
    expect(normalizeElearningCreditManualAdjustment({
      ...baseInput(), reason: `secret-${'x'.repeat(505)}`,
    }).reason).toHaveLength(512)
    expect(normalizeElearningCreditManualAdjustment({
      ...baseInput(), reason: 'secret-ok-\ud83d\ude00',
    }).reason).toBe('secret-ok-\ud83d\ude00')
  })

  it('rejects zero, fractional, unsafe, or non-number points', () => {
    for (const points of [0, -0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '5']) {
      expectCode(() => normalizeElearningCreditManualAdjustment({ ...baseInput(), points }), 'invalid_input')
    }
  })

  it('rejects local, invalid, or non-absolute timestamps', () => {
    for (const occurredAt of [
      '2026-04-01T10:00:00',
      '2026-02-30T10:00:00Z',
      '2026-04-01 10:00:00Z',
      'not-a-date',
      1712345678,
      new Date(Number.NaN),
    ]) {
      expectCode(() => normalizeElearningCreditManualAdjustment({ ...baseInput(), occurredAt }), 'invalid_occurred_at')
    }
  })

  it('fails closed on hostile getters and proxies', () => {
    const throwingGetter = baseInput()
    Object.defineProperty(throwingGetter, 'points', {
      enumerable: true,
      get() { throw new Error('secret-getter-boom') },
    })
    expectCode(() => normalizeElearningCreditManualAdjustment(throwingGetter), 'invalid_input')

    expectCode(() => normalizeElearningCreditManualAdjustment(new Proxy(baseInput(), {
      ownKeys() { throw new Error('secret-ownkeys-boom') },
    })), 'invalid_input')
    expectCode(() => normalizeElearningCreditManualAdjustment(new Proxy(baseInput(), {
      get() { throw new Error('secret-get-boom') },
    })), 'invalid_input')
  })

  it('snapshots the enumerable key set exactly once', () => {
    let ownKeysCalls = 0
    const input = new Proxy(baseInput(), {
      ownKeys(target) {
        ownKeysCalls += 1
        return Reflect.ownKeys(target)
      },
    })
    expect(normalizeElearningCreditManualAdjustment(input).points).toBe(5)
    expect(ownKeysCalls).toBe(1)
  })

  it('reads each input value exactly once so the hash matches the returned fields', () => {
    let reads = 0
    const flaky = baseInput()
    Object.defineProperty(flaky, 'actorId', {
      enumerable: true,
      get() {
        reads += 1
        return reads === 1 ? 'actor-secret-a' : 'actor-secret-b'
      },
    })
    const command = normalizeElearningCreditManualAdjustment(flaky)
    expect(reads).toBe(1)
    expect(command.actorId).toBe('actor-secret-a')
    expect(command.requestHash).toBe(hashElearningCreditEffect(baseEffect()))
  })

  it('does not mutate or retain the input object', () => {
    const input = baseInput()
    const snapshot = { ...input }
    const command = normalizeElearningCreditManualAdjustment(input)
    expect(input).toEqual(snapshot)
    input.reason = 'reason-secret-b'
    input.points = -99
    expect(command.reason).toBe('reason-secret-a')
    expect(command.points).toBe(5)
  })

  it('keeps every failure code-only and values-free', () => {
    const cases: Array<[unknown, string]> = [
      [{ ...baseInput(), extra: 'secret-extra' }, 'invalid_input'],
      [{ ...baseInput(), reason: '  ' }, 'invalid_input'],
      [{ ...baseInput(), points: 0 }, 'invalid_input'],
      [{ ...baseInput(), occurredAt: '2026-04-01T10:00:00' }, 'invalid_occurred_at'],
      [null, 'invalid_input'],
    ]
    for (const [input, code] of cases) {
      try {
        normalizeElearningCreditManualAdjustment(input)
        throw new Error('expected policy error')
      } catch (error) {
        expect(error).toBeInstanceOf(ElearningCreditPolicyError)
        const policyError = error as ElearningCreditPolicyError
        expect(policyError.code).toBe(code)
        expect(policyError.message).toBe(code)
        const surface = `${policyError.message}\n${policyError.stack ?? ''}`
        expect(surface).not.toContain('secret')
        expect(surface).not.toContain('actor-secret-a')
        expect(surface).not.toContain('manual:adjust-secret-a')
      }
    }
  })
})
