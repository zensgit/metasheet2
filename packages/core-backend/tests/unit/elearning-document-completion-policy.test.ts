import { describe, expect, it } from 'vitest'

import {
  createElearningDocumentCompletionPolicy,
  ELEARNING_DOCUMENT_COMPLETION_DIGEST_DOMAIN,
  ELEARNING_DOCUMENT_COMPLETION_EVALUATOR_VERSION,
  ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION,
  ELEARNING_DOCUMENT_MAX_PAGES,
  elearningDocumentRequiredPageCount,
  ElearningDocumentCompletionPolicyError,
  evaluateElearningDocumentCompletion,
} from '../../src/services/elearning-document-completion-policy'

const SENTINEL = 'secret-document-value'
const ITEM_ID = '10000000-0000-4000-8000-000000000001'
const MEDIA_ID = '10000000-0000-4000-8000-000000000002'
const OTHER_ID = '10000000-0000-4000-8000-000000000003'

function policy(overrides: Record<string, unknown> = {}) {
  return {
    courseVersionItemId: ITEM_ID,
    documentMediaId: MEDIA_ID,
    policyVersion: ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION,
    serverPageCount: 10,
    thresholdBps: 9_000,
    ...overrides,
  }
}

function expectInvalid(action: () => unknown): void {
  try {
    action()
    throw new Error('expected document completion policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningDocumentCompletionPolicyError)
    const policyError = error as ElearningDocumentCompletionPolicyError
    expect(policyError.code).toBe('invalid_input')
    expect(policyError.message).toBe('invalid_input')
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning document completion policy', () => {
  it('derives completion from server page count and observed pages only', () => {
    const result = evaluateElearningDocumentCompletion(
      createElearningDocumentCompletionPolicy(policy({
        courseVersionItemId: ITEM_ID.toUpperCase(),
        documentMediaId: MEDIA_ID.toUpperCase(),
      })),
      { viewedPages: [10, 2, 1, 3, 4, 5, 6, 7, 8] },
    )
    expect(result).toEqual({
      assurance: 'server_verified_page_count',
      completed: true,
      courseVersionItemId: ITEM_ID,
      documentMediaId: MEDIA_ID,
      evaluatorVersion: ELEARNING_DOCUMENT_COMPLETION_EVALUATOR_VERSION,
      evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      policyVersion: ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION,
      requiredPageCount: 9,
      serverPageCount: 10,
      thresholdBps: 9_000,
      viewedPageCount: 9,
      viewedPageRanges: [
        { endPage: 8, startPage: 1 },
        { endPage: 10, startPage: 10 },
      ],
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.viewedPageRanges)).toBe(true)
    expect(result.viewedPageRanges.every(Object.isFrozen)).toBe(true)
    expect(ELEARNING_DOCUMENT_COMPLETION_DIGEST_DOMAIN).toBe(
      'elearning.document.completion.v1',
    )
  })

  it('keeps an under-threshold document in progress without a client completion input', () => {
    const result = evaluateElearningDocumentCompletion(
      createElearningDocumentCompletionPolicy(policy()),
      { viewedPages: [1, 2, 3, 4, 5, 6, 7, 8] },
    )
    expect(result).toMatchObject({
      completed: false,
      requiredPageCount: 9,
      viewedPageCount: 8,
    })
    expectInvalid(() => evaluateElearningDocumentCompletion(
      createElearningDocumentCompletionPolicy(policy()),
      { completed: true, viewedPages: [1, 2, 3, 4, 5, 6, 7, 8] },
    ))
  })

  it('normalizes page collections before computing evidence identity', () => {
    const normalizedPolicy = createElearningDocumentCompletionPolicy(policy())
    const reordered = evaluateElearningDocumentCompletion(
      normalizedPolicy,
      { viewedPages: [3, 1, 2, 2, 3] },
    )
    const canonical = evaluateElearningDocumentCompletion(
      normalizedPolicy,
      { viewedPages: [1, 2, 3] },
    )
    expect(reordered).toEqual(canonical)
    expect(canonical.viewedPageRanges).toEqual([{ endPage: 3, startPage: 1 }])
  })

  it('uses ceiling arithmetic for fractional page thresholds', () => {
    expect(elearningDocumentRequiredPageCount(3, 6_666)).toBe(2)
    expect(elearningDocumentRequiredPageCount(3, 6_667)).toBe(3)
    expect(elearningDocumentRequiredPageCount(1, 1)).toBe(1)
    expect(elearningDocumentRequiredPageCount(100_000, 10_000)).toBe(100_000)
  })

  it('binds evidence to item, media, policy, page count, and threshold', () => {
    const inputs = [
      policy(),
      policy({ courseVersionItemId: OTHER_ID }),
      policy({ documentMediaId: OTHER_ID }),
      policy({ serverPageCount: 11 }),
      policy({ thresholdBps: 8_000 }),
    ]
    const digests = inputs.map((input) => evaluateElearningDocumentCompletion(
      createElearningDocumentCompletionPolicy(input),
      { viewedPages: [1, 2, 3] },
    ).evidenceDigest)
    expect(new Set(digests).size).toBe(digests.length)
  })

  it('rejects pages outside the server-verified document range', () => {
    const normalizedPolicy = createElearningDocumentCompletionPolicy(policy())
    for (const viewedPages of [[0], [11], [1.5], ['1'], [Number.NaN]]) {
      expectInvalid(() => evaluateElearningDocumentCompletion(
        normalizedPolicy,
        { viewedPages },
      ))
    }
  })

  it('rejects invalid or open policy snapshots values-free', () => {
    for (const value of [
      null,
      {},
      { ...policy(), extra: SENTINEL },
      policy({ courseVersionItemId: 'item-1' }),
      policy({ documentMediaId: 'media-1' }),
      policy({ policyVersion: 'document-pages-v2' }),
      policy({ serverPageCount: 0 }),
      policy({ serverPageCount: ELEARNING_DOCUMENT_MAX_PAGES + 1 }),
      policy({ serverPageCount: 1.5 }),
      policy({ thresholdBps: 0 }),
      policy({ thresholdBps: 10_001 }),
    ]) expectInvalid(() => createElearningDocumentCompletionPolicy(value))
  })

  it('rejects sparse, oversized, decorated, and hostile page aggregates', () => {
    const normalizedPolicy = createElearningDocumentCompletionPolicy(policy())
    expectInvalid(() => evaluateElearningDocumentCompletion(
      normalizedPolicy,
      { viewedPages: new Array(2) },
    ))
    expectInvalid(() => evaluateElearningDocumentCompletion(
      createElearningDocumentCompletionPolicy(policy({
        serverPageCount: ELEARNING_DOCUMENT_MAX_PAGES,
      })),
      { viewedPages: new Array(ELEARNING_DOCUMENT_MAX_PAGES + 1).fill(1) },
    ))
    const decorated = [1, 2] as number[] & { extra?: string }
    decorated.extra = SENTINEL
    expectInvalid(() => evaluateElearningDocumentCompletion(
      normalizedPolicy,
      { viewedPages: decorated },
    ))
    const hostile = [1]
    Object.defineProperty(hostile, 0, {
      enumerable: true,
      get() {
        throw new Error(SENTINEL)
      },
    })
    expectInvalid(() => evaluateElearningDocumentCompletion(
      normalizedPolicy,
      { viewedPages: hostile },
    ))
  })

  it('does not retain mutable caller page arrays or policy objects', () => {
    const rawPolicy = policy()
    const viewedPages = [1, 2, 3]
    const normalizedPolicy = createElearningDocumentCompletionPolicy(rawPolicy)
    const before = evaluateElearningDocumentCompletion(normalizedPolicy, { viewedPages })
    viewedPages.push(4)
    rawPolicy.serverPageCount = 1
    expect(normalizedPolicy.serverPageCount).toBe(10)
    expect(before.viewedPageCount).toBe(3)
    expect(Object.isFrozen(normalizedPolicy)).toBe(true)
  })
})
