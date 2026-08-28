import { describe, expect, it } from 'vitest'

import {
  ElearningAiGroundingPolicyError,
  createElearningAiGroundingPolicy,
  evaluateElearningAiGrounding,
} from '../../src/services/elearning-ai-grounding-policy'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)
const SENTINEL = 'secret-ai-grounding-value'

function policy(overrides: Record<string, unknown> = {}) {
  return { policyRevision: 'ai-grounding-v1', ...overrides }
}

function authority(overrides: Record<string, unknown> = {}) {
  return {
    authorizedChunks: [
      {
        chunkKey: 'chunk-a',
        contentDigest: DIGEST_A,
        courseVersionKey: 'course-version-1',
      },
      {
        chunkKey: 'chunk-b',
        contentDigest: DIGEST_B,
        courseVersionKey: 'course-version-2',
      },
    ],
    ...overrides,
  }
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    answerText: '  Refer only to the authorized lessons.  ',
    citationChunkKeys: ['chunk-b', 'chunk-a'],
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected AI grounding policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningAiGroundingPolicyError)
    const policyError = error as ElearningAiGroundingPolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning AI grounding policy', () => {
  it('creates an exact immutable policy', () => {
    const result = createElearningAiGroundingPolicy(policy())
    expect(result).toEqual({ policyRevision: 'ai-grounding-v1' })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('returns a grounded candidate with only authorized citation metadata', () => {
    const result = evaluateElearningAiGrounding(policy(), authority(), draft())
    expect(result).toEqual({
      answerText: 'Refer only to the authorized lessons.',
      citations: [
        {
          chunkKey: 'chunk-b',
          contentDigest: DIGEST_B,
          courseVersionKey: 'course-version-2',
        },
        {
          chunkKey: 'chunk-a',
          contentDigest: DIGEST_A,
          courseVersionKey: 'course-version-1',
        },
      ],
      policyRevision: 'ai-grounding-v1',
      reason: null,
      status: 'grounded_candidate',
    })
    expect(Reflect.ownKeys(result)).toEqual([
      'answerText',
      'citations',
      'policyRevision',
      'reason',
      'status',
    ])
    expect(JSON.stringify(result)).not.toContain('retrievedText')
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.citations)).toBe(true)
    expect(result.citations.every(Object.isFrozen)).toBe(true)
  })

  it('abstains when the server supplied no authorized context', () => {
    expect(evaluateElearningAiGrounding(
      policy(),
      authority({ authorizedChunks: [] }),
      draft(),
    )).toEqual({
      answerText: null,
      citations: [],
      policyRevision: 'ai-grounding-v1',
      reason: 'no_authorized_context',
      status: 'abstain',
    })
  })

  it('abstains when the model supplies no citations', () => {
    expect(evaluateElearningAiGrounding(
      policy(),
      authority(),
      draft({ citationChunkKeys: [] }),
    )).toMatchObject({
      answerText: null,
      citations: [],
      reason: 'invalid_draft',
      status: 'abstain',
    })
  })

  it('abstains without partial output for unknown citations', () => {
    expect(evaluateElearningAiGrounding(
      policy(),
      authority(),
      draft({ citationChunkKeys: ['chunk-a', 'chunk-not-authorized'] }),
    )).toEqual({
      answerText: null,
      citations: [],
      policyRevision: 'ai-grounding-v1',
      reason: 'unsupported_citation',
      status: 'abstain',
    })
  })

  it('treats malformed or duplicate model citations as an invalid draft', () => {
    for (const input of [
      null,
      {},
      draft({ answerText: '   ' }),
      draft({ answerText: `valid${SENTINEL}\0` }),
      draft({ answerText: 'x'.repeat(16 * 1024 + 1) }),
      draft({ citationChunkKeys: ['chunk-a', 'chunk-a'] }),
      draft({ citationChunkKeys: [' chunk-a'] }),
      draft({ citationChunkKeys: Array.from({ length: 21 }, (_, index) => `chunk-${index}`) }),
      { ...draft(), extra: SENTINEL },
    ]) {
      expect(evaluateElearningAiGrounding(policy(), authority(), input)).toMatchObject({
        answerText: null,
        citations: [],
        reason: 'invalid_draft',
        status: 'abstain',
      })
    }
  })

  it('turns hostile model output into abstention rather than an exception', () => {
    const throwing = Object.defineProperty(draft(), 'answerText', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expect(evaluateElearningAiGrounding(policy(), authority(), throwing)).toMatchObject({
      answerText: null,
      reason: 'invalid_draft',
      status: 'abstain',
    })
  })

  it('rejects duplicate, malformed, or non-canonical authority entries', () => {
    const first = authority().authorizedChunks[0]
    for (const input of [
      authority({ authorizedChunks: [first, first] }),
      authority({ authorizedChunks: [{ ...first, contentDigest: DIGEST_A.toUpperCase() }] }),
      authority({ authorizedChunks: [{ ...first, chunkKey: ' chunk-a' }] }),
      authority({ authorizedChunks: [{ ...first, extra: SENTINEL }] }),
      { ...authority(), extra: SENTINEL },
    ]) {
      expectCode(() => evaluateElearningAiGrounding(policy(), input, draft()), 'invalid_authority')
    }
  })

  it('rejects malformed policies with values-free errors', () => {
    for (const input of [
      null,
      {},
      policy({ policyRevision: '' }),
      policy({ policyRevision: `${SENTINEL}\0` }),
      { ...policy(), extra: SENTINEL },
    ]) {
      expectCode(() => evaluateElearningAiGrounding(input, authority(), draft()), 'invalid_policy')
    }
  })

  it('keeps abstention results deeply immutable and closed-shaped', () => {
    const result = evaluateElearningAiGrounding(
      policy(),
      authority(),
      draft({ citationChunkKeys: ['unknown-chunk'] }),
    )
    expect(Reflect.ownKeys(result)).toEqual([
      'answerText',
      'citations',
      'policyRevision',
      'reason',
      'status',
    ])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.citations)).toBe(true)
  })
})
