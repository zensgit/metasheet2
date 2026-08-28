/**
 * Pure L6 AI-answer grounding boundary. Retrieval authorization happens before
 * this policy; provider calls, semantic entailment, persistence, and transport
 * stay outside. A passing result is only a grounded candidate.
 */

const MAX_ANSWER_LENGTH = 16 * 1024
const MAX_CITATIONS = 20
const MAX_KEY_LENGTH = 512

const POLICY_KEYS = ['policyRevision'] as const
const AUTHORITY_KEYS = ['authorizedChunks'] as const
const CHUNK_KEYS = ['chunkKey', 'contentDigest', 'courseVersionKey'] as const
const DRAFT_KEYS = ['answerText', 'citationChunkKeys'] as const

export type ElearningAiGroundingPolicyErrorCode =
  | 'invalid_authority'
  | 'invalid_policy'

export class ElearningAiGroundingPolicyError extends Error {
  constructor(readonly code: ElearningAiGroundingPolicyErrorCode) {
    super(code)
    this.name = 'ElearningAiGroundingPolicyError'
  }
}

declare const normalizedAiGroundingPolicy: unique symbol

export interface ElearningAiGroundingPolicy {
  readonly policyRevision: string
  readonly [normalizedAiGroundingPolicy]: true
}

export interface ElearningAiGroundingCitation {
  readonly chunkKey: string
  readonly contentDigest: string
  readonly courseVersionKey: string
}

export type ElearningAiGroundingAbstainReason =
  | 'invalid_draft'
  | 'no_authorized_context'
  | 'unsupported_citation'

export type ElearningAiGroundingDecision =
  | {
      readonly answerText: string
      readonly citations: readonly ElearningAiGroundingCitation[]
      readonly policyRevision: string
      readonly reason: null
      readonly status: 'grounded_candidate'
    }
  | {
      readonly answerText: null
      readonly citations: readonly ElearningAiGroundingCitation[]
      readonly policyRevision: string
      readonly reason: ElearningAiGroundingAbstainReason
      readonly status: 'abstain'
    }

function fail(code: ElearningAiGroundingPolicyErrorCode): never {
  throw new ElearningAiGroundingPolicyError(code)
}

function readExactObject(
  input: unknown,
  expectedKeys: readonly string[],
  code: ElearningAiGroundingPolicyErrorCode,
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(code)
  try {
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail(code)
    const sorted = (keys as string[]).sort()
    if (
      sorted.length !== expectedKeys.length
      || sorted.some((key, index) => key !== expectedKeys[index])
    ) fail(code)
    const values: Record<string, unknown> = {}
    for (const key of expectedKeys) values[key] = (input as Record<string, unknown>)[key]
    return values
  } catch (error) {
    if (error instanceof ElearningAiGroundingPolicyError) throw error
    fail(code)
  }
}

function readDenseArray(
  input: unknown,
  code: ElearningAiGroundingPolicyErrorCode,
): readonly unknown[] {
  try {
    if (!Array.isArray(input)) fail(code)
    if (Reflect.ownKeys(input).length !== input.length + 1) fail(code)
    const values: unknown[] = []
    for (let index = 0; index < input.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(input, index)) fail(code)
      values.push(input[index])
    }
    return values
  } catch (error) {
    if (error instanceof ElearningAiGroundingPolicyError) throw error
    fail(code)
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const point = value.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      return false
    }
  }
  return true
}

function readKey(
  input: unknown,
  code: ElearningAiGroundingPolicyErrorCode,
): string {
  if (typeof input !== 'string') fail(code)
  if (
    input === ''
    || input !== input.trim()
    || input.length > MAX_KEY_LENGTH
    || input.includes('\0')
    || !isWellFormedUnicode(input)
  ) fail(code)
  return input
}

export function createElearningAiGroundingPolicy(
  input: unknown,
): ElearningAiGroundingPolicy {
  const values = readExactObject(input, POLICY_KEYS, 'invalid_policy')
  return Object.freeze({
    policyRevision: readKey(values.policyRevision, 'invalid_policy'),
  }) as ElearningAiGroundingPolicy
}

function readAuthority(input: unknown): ReadonlyMap<string, ElearningAiGroundingCitation> {
  const values = readExactObject(input, AUTHORITY_KEYS, 'invalid_authority')
  const chunkInputs = readDenseArray(values.authorizedChunks, 'invalid_authority')
  const chunks = new Map<string, ElearningAiGroundingCitation>()
  for (const chunkInput of chunkInputs) {
    const chunkValues = readExactObject(chunkInput, CHUNK_KEYS, 'invalid_authority')
    const chunkKey = readKey(chunkValues.chunkKey, 'invalid_authority')
    const contentDigest = chunkValues.contentDigest
    if (typeof contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(contentDigest)) {
      fail('invalid_authority')
    }
    if (chunks.has(chunkKey)) fail('invalid_authority')
    chunks.set(chunkKey, Object.freeze({
      chunkKey,
      contentDigest,
      courseVersionKey: readKey(chunkValues.courseVersionKey, 'invalid_authority'),
    }))
  }
  return chunks
}

function tryReadDraft(input: unknown): {
  readonly answerText: string
  readonly citationChunkKeys: readonly string[]
} | null {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) return null
    const sorted = (keys as string[]).sort()
    if (
      sorted.length !== DRAFT_KEYS.length
      || sorted.some((key, index) => key !== DRAFT_KEYS[index])
    ) return null
    const draft = input as Record<string, unknown>
    if (typeof draft.answerText !== 'string') return null
    const answerText = draft.answerText.trim()
    if (
      answerText === ''
      || answerText.length > MAX_ANSWER_LENGTH
      || answerText.includes('\0')
      || !isWellFormedUnicode(answerText)
    ) return null
    if (!Array.isArray(draft.citationChunkKeys)) return null
    const citationInputs = draft.citationChunkKeys
    if (
      citationInputs.length === 0
      || citationInputs.length > MAX_CITATIONS
      || Reflect.ownKeys(citationInputs).length !== citationInputs.length + 1
    ) return null
    const citationChunkKeys: string[] = []
    const seen = new Set<string>()
    for (let index = 0; index < citationInputs.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(citationInputs, index)) return null
      const key = citationInputs[index]
      if (
        typeof key !== 'string'
        || key === ''
        || key !== key.trim()
        || key.length > MAX_KEY_LENGTH
        || key.includes('\0')
        || !isWellFormedUnicode(key)
        || seen.has(key)
      ) return null
      seen.add(key)
      citationChunkKeys.push(key)
    }
    return Object.freeze({
      answerText,
      citationChunkKeys: Object.freeze(citationChunkKeys),
    })
  } catch {
    return null
  }
}

function abstain(
  policyRevision: string,
  reason: ElearningAiGroundingAbstainReason,
): ElearningAiGroundingDecision {
  return Object.freeze({
    answerText: null,
    citations: Object.freeze([]),
    policyRevision,
    reason,
    status: 'abstain',
  })
}

/**
 * Accept a provider draft only when every cited chunk is in the service-built
 * authority set. Citation matching does not prove semantic entailment.
 */
export function evaluateElearningAiGrounding(
  policyInput: unknown,
  authorityInput: unknown,
  draftInput: unknown,
): ElearningAiGroundingDecision {
  const policy = createElearningAiGroundingPolicy(policyInput)
  const authority = readAuthority(authorityInput)
  if (authority.size === 0) return abstain(policy.policyRevision, 'no_authorized_context')

  const draft = tryReadDraft(draftInput)
  if (!draft) return abstain(policy.policyRevision, 'invalid_draft')

  const citations: ElearningAiGroundingCitation[] = []
  for (const chunkKey of draft.citationChunkKeys) {
    const citation = authority.get(chunkKey)
    if (!citation) return abstain(policy.policyRevision, 'unsupported_citation')
    citations.push(citation)
  }

  return Object.freeze({
    answerText: draft.answerText,
    citations: Object.freeze(citations),
    policyRevision: policy.policyRevision,
    reason: null,
    status: 'grounded_candidate',
  })
}
