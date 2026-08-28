import { describe, expect, it } from 'vitest'
import {
  ElearningLiveReceiptPolicyError,
  evaluateElearningLiveReceiptCompletion,
  normalizeElearningAdapterVerifiedLiveReceipt,
  normalizeElearningLiveReceiptPolicy,
} from '../../src/services/elearning-live-receipt-policy'

const SENTINEL = 'secret-live-receipt-value'

function policy(overrides: Record<string, unknown> = {}) {
  return {
    completionMode: 'live_or_replay',
    liveRequiredSeconds: 60,
    policyRevision: 'live-v1',
    replayRequiredSeconds: 120,
    ...overrides,
  }
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    courseVersionId: 'course-version-1',
    itemKey: 'live-item-1',
    orgId: 'org-1',
    policyRevision: 'live-v1',
    providerEventKey: 'event-1',
    providerKey: 'provider-1',
    userId: 'user-1',
    ...overrides,
  }
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    ...context(),
    measuredSeconds: 60,
    observedAt: '2026-08-28T00:00:00.000Z',
    providerReceiptKey: 'receipt-1',
    source: 'live',
    ...overrides,
  }
}

function evaluate(
  receipts: unknown[],
  policyOverrides: Record<string, unknown> = {},
  contextOverrides: Record<string, unknown> = {},
) {
  return evaluateElearningLiveReceiptCompletion(
    policy(policyOverrides),
    { expectedContext: context(contextOverrides), receipts },
  )
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected live receipt policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningLiveReceiptPolicyError)
    const policyError = error as ElearningLiveReceiptPolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.name).toBe('ElearningLiveReceiptPolicyError')
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning live receipt policy', () => {
  it('requires at least one adapter-verified receipt and returns a closed decision', () => {
    const result = evaluate([])
    expect(result).toEqual({
      completed: false,
      measuredSeconds: 0,
      policyRevision: 'live-v1',
      providerReceiptKey: null,
      reason: 'no_receipt',
      requiredSeconds: 60,
      source: null,
    })
    expect(Object.keys(result).sort()).toEqual([
      'completed',
      'measuredSeconds',
      'policyRevision',
      'providerReceiptKey',
      'reason',
      'requiredSeconds',
      'source',
    ])
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('uses inclusive live threshold boundaries and returns normalized evidence', () => {
    expect(evaluate([receipt({ measuredSeconds: 59 })])).toMatchObject({
      completed: false,
      measuredSeconds: 59,
      providerReceiptKey: 'receipt-1',
      reason: 'below_threshold',
      requiredSeconds: 60,
      source: 'live',
    })
    expect(evaluate([receipt({ measuredSeconds: 60 })])).toEqual({
      completed: true,
      measuredSeconds: 60,
      policyRevision: 'live-v1',
      providerReceiptKey: 'receipt-1',
      reason: 'completed',
      requiredSeconds: 60,
      source: 'live',
    })
    expect(evaluate([receipt({ measuredSeconds: Number.MAX_SAFE_INTEGER })]).completed).toBe(true)
  })

  it('disables replay in live_only and enables it only in live_or_replay', () => {
    const replay = receipt({
      measuredSeconds: 120,
      providerReceiptKey: 'replay-receipt',
      source: 'replay',
    })
    expect(evaluate([replay], { completionMode: 'live_only' })).toMatchObject({
      completed: false,
      measuredSeconds: 0,
      providerReceiptKey: null,
      reason: 'no_receipt',
      source: null,
    })
    expect(evaluate([replay])).toMatchObject({
      completed: true,
      measuredSeconds: 120,
      providerReceiptKey: 'replay-receipt',
      reason: 'completed',
      requiredSeconds: 120,
      source: 'replay',
    })
  })

  it('uses the maximum cumulative snapshot rather than summing snapshots', () => {
    const result = evaluate([
      receipt({ measuredSeconds: 40, providerReceiptKey: 'receipt-a' }),
      receipt({ measuredSeconds: 40, providerReceiptKey: 'receipt-b' }),
    ])
    expect(result).toMatchObject({
      completed: false,
      measuredSeconds: 40,
      providerReceiptKey: 'receipt-a',
      reason: 'below_threshold',
      requiredSeconds: 60,
      source: 'live',
    })
  })

  it('keeps cross-source incomplete evidence internally consistent', () => {
    const result = evaluate([
      receipt({ measuredSeconds: 30, providerReceiptKey: 'live-receipt' }),
      receipt({ measuredSeconds: 100, providerReceiptKey: 'replay-receipt', source: 'replay' }),
    ])
    expect(result).toEqual({
      completed: false,
      measuredSeconds: 100,
      policyRevision: 'live-v1',
      providerReceiptKey: 'replay-receipt',
      reason: 'below_threshold',
      requiredSeconds: 120,
      source: 'replay',
    })
  })

  it('uses a deterministic latest-time then receipt-key tie-break', () => {
    const result = evaluate([
      receipt({
        measuredSeconds: 60,
        observedAt: '2026-08-28T00:00:00.000Z',
        providerReceiptKey: 'receipt-z',
      }),
      receipt({
        measuredSeconds: 60,
        observedAt: '2026-08-28T00:00:01.000Z',
        providerReceiptKey: 'receipt-b',
      }),
      receipt({
        measuredSeconds: 60,
        observedAt: '2026-08-28T00:00:01.000Z',
        providerReceiptKey: 'receipt-a',
      }),
    ])
    expect(result.providerReceiptKey).toBe('receipt-a')
  })

  it('prefers live when live and replay independently qualify', () => {
    const result = evaluate([
      receipt({
        measuredSeconds: 120,
        providerReceiptKey: 'replay-receipt',
        source: 'replay',
      }),
      receipt({ measuredSeconds: 60 }),
    ])
    expect(result).toMatchObject({ providerReceiptKey: 'receipt-1', source: 'live' })
  })

  it('rejects duplicate receipt keys even when payloads match', () => {
    expectCode(() => evaluate([
      receipt(),
      receipt({ observedAt: '2026-08-28T00:00:01.000Z' }),
    ]), 'duplicate_provider_receipt_key')
    expectCode(() => evaluate([
      receipt(),
      receipt({ providerReceiptKey: 'receipt-1', measuredSeconds: 999, source: 'replay' }),
    ]), 'duplicate_provider_receipt_key')
  })

  it('rejects every receipt context dimension mismatch', () => {
    for (const key of [
      'orgId',
      'userId',
      'courseVersionId',
      'itemKey',
      'providerKey',
      'providerEventKey',
      'policyRevision',
    ]) {
      const mismatched = key === 'providerEventKey'
        ? receipt({ providerEventKey: 'event-other' })
        : receipt({ [key]: 'other-context' })
      expectCode(() => evaluate([mismatched]), 'receipt_context_mismatch')
    }
    expectCode(() => evaluate([receipt()], {}, { policyRevision: 'live-v2' }), 'policy_mismatch')
  })

  it('rejects malformed policy, context, receipt, and extra input shapes', () => {
    expectCode(() => normalizeElearningLiveReceiptPolicy(null), 'invalid_input')
    expectCode(() => normalizeElearningLiveReceiptPolicy({ ...policy(), extra: SENTINEL }), 'invalid_input')
    expectCode(() => normalizeElearningLiveReceiptPolicy({
      ...policy(), liveRequiredSeconds: 0,
    }), 'invalid_policy')
    expectCode(() => normalizeElearningLiveReceiptPolicy({
      ...policy(), replayRequiredSeconds: 1.5,
    }), 'invalid_policy')
    expectCode(() => evaluate([receipt()], {}, { extra: SENTINEL }), 'invalid_context')
    expectCode(() => normalizeElearningAdapterVerifiedLiveReceipt({ ...receipt(), extra: SENTINEL }), 'invalid_receipt')
    expectCode(() => evaluate([receipt(), undefined]), 'invalid_receipt')
    expectCode(() => evaluate(new Array(1)), 'invalid_input')
    expectCode(() => evaluate([receipt()], { completionMode: 'permissive' }), 'invalid_policy')
  })

  it('requires canonical UTC instants without offset normalization', () => {
    expect(normalizeElearningAdapterVerifiedLiveReceipt(receipt()).observedAt).toBe(
      '2026-08-28T00:00:00.000Z',
    )
    expectCode(() => normalizeElearningAdapterVerifiedLiveReceipt({
      ...receipt(), observedAt: '2026-08-28T08:00:00.000+08:00',
    }), 'invalid_receipt')
    expectCode(() => normalizeElearningAdapterVerifiedLiveReceipt({
      ...receipt(), observedAt: '2026-08-28T08:00:00',
    }), 'invalid_receipt')
    expectCode(() => normalizeElearningAdapterVerifiedLiveReceipt({
      ...receipt(), observedAt: '2026-02-30T00:00:00Z',
    }), 'invalid_receipt')
  })

  it('requires bounded keys and safe nonnegative measured seconds', () => {
    expectCode(() => normalizeElearningAdapterVerifiedLiveReceipt({
      ...receipt(), providerReceiptKey: '   ',
    }), 'invalid_receipt')
    expectCode(() => normalizeElearningAdapterVerifiedLiveReceipt({
      ...receipt(), providerReceiptKey: `key-${'x'.repeat(512)}`,
    }), 'invalid_receipt')
    for (const measuredSeconds of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '60']) {
      expectCode(() => normalizeElearningAdapterVerifiedLiveReceipt({ ...receipt(), measuredSeconds }), 'invalid_receipt')
    }
    expect(normalizeElearningAdapterVerifiedLiveReceipt({ ...receipt(), measuredSeconds: 0 }).measuredSeconds).toBe(0)
  })

  it('deeply freezes normalized policy and receipt without retaining caller objects', () => {
    const input = receipt()
    const normalizedPolicy = normalizeElearningLiveReceiptPolicy(policy())
    const normalizedReceipt = normalizeElearningAdapterVerifiedLiveReceipt(input)
    expect(Object.isFrozen(normalizedPolicy)).toBe(true)
    expect(Object.isFrozen(normalizedReceipt)).toBe(true)
    expect(() => {
      ;(normalizedReceipt as { measuredSeconds: number }).measuredSeconds = 99
    }).toThrow(TypeError)
    input.measuredSeconds = 99
    expect(normalizedReceipt.measuredSeconds).toBe(60)
    expect(normalizedPolicy.policyRevision).toBe('live-v1')
  })

  it('keeps hostile getter failures values-free', () => {
    const input = receipt()
    Object.defineProperty(input, 'measuredSeconds', {
      enumerable: true,
      get() { throw new Error(SENTINEL) },
    })
    expectCode(() => normalizeElearningAdapterVerifiedLiveReceipt(input), 'invalid_receipt')
    expectCode(() => evaluate(new Proxy([receipt()], {
      ownKeys() { throw new Error(SENTINEL) },
    })), 'invalid_input')
  })
})
