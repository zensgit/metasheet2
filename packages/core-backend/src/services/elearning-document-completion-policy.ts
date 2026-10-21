import { createHash } from 'node:crypto'

/**
 * Pure L1 document completion policy.
 *
 * The adapter must supply a page count extracted by a trusted server-side
 * document probe and an aggregate of persisted page_view events. The client
 * never supplies a completed flag. This evaluator only derives completion and
 * a compact, versioned evidence summary from those server-owned facts.
 */

export const ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION =
  'document-pages-v1' as const
export const ELEARNING_DOCUMENT_COMPLETION_EVALUATOR_VERSION =
  'elearning-document-eval-v1' as const
export const ELEARNING_DOCUMENT_COMPLETION_DIGEST_DOMAIN =
  'elearning.document.completion.v1' as const
export const ELEARNING_DOCUMENT_MAX_PAGES = 100_000 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const POLICY_KEYS = [
  'courseVersionItemId',
  'documentMediaId',
  'policyVersion',
  'serverPageCount',
  'thresholdBps',
] as const
const OBSERVATION_KEYS = ['viewedPages'] as const

export class ElearningDocumentCompletionPolicyError extends Error {
  constructor(readonly code: 'invalid_input') {
    super(code)
    this.name = 'ElearningDocumentCompletionPolicyError'
  }
}

declare const normalizedElearningDocumentCompletionPolicy: unique symbol

export interface ElearningDocumentCompletionPolicy {
  readonly courseVersionItemId: string
  readonly documentMediaId: string
  readonly policyVersion: typeof ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION
  readonly serverPageCount: number
  readonly thresholdBps: number
  readonly [normalizedElearningDocumentCompletionPolicy]: true
}

export interface ElearningDocumentPageRange {
  readonly endPage: number
  readonly startPage: number
}

export interface ElearningDocumentCompletionEvaluation {
  readonly assurance: 'server_verified_page_count'
  readonly completed: boolean
  readonly courseVersionItemId: string
  readonly documentMediaId: string
  readonly evaluatorVersion: typeof ELEARNING_DOCUMENT_COMPLETION_EVALUATOR_VERSION
  readonly evidenceDigest: string
  readonly policyVersion: typeof ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION
  readonly requiredPageCount: number
  readonly serverPageCount: number
  readonly thresholdBps: number
  readonly viewedPageCount: number
  readonly viewedPageRanges: readonly ElearningDocumentPageRange[]
}

function fail(): never {
  throw new ElearningDocumentCompletionPolicyError('invalid_input')
}

function readExactObject(
  input: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail()
  try {
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail()
    const sorted = (keys as string[]).sort()
    if (
      sorted.length !== expectedKeys.length
      || sorted.some((key, index) => key !== expectedKeys[index])
    ) fail()
    return Object.fromEntries(
      expectedKeys.map((key) => [key, (input as Record<string, unknown>)[key]]),
    )
  } catch (error) {
    if (error instanceof ElearningDocumentCompletionPolicyError) throw error
    fail()
  }
}

function readDensePageArray(input: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(input) || input.length > ELEARNING_DOCUMENT_MAX_PAGES) fail()
    if (Reflect.ownKeys(input).length !== input.length + 1) fail()
    const values: unknown[] = []
    for (let index = 0; index < input.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(input, index)) fail()
      values.push(input[index])
    }
    return values
  } catch (error) {
    if (error instanceof ElearningDocumentCompletionPolicyError) throw error
    fail()
  }
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail()
  return value.toLowerCase()
}

function requireInteger(value: unknown, min: number, max: number): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < min
    || value > max
  ) fail()
  return value
}

export function createElearningDocumentCompletionPolicy(
  input: unknown,
): ElearningDocumentCompletionPolicy {
  const values = readExactObject(input, POLICY_KEYS)
  if (values.policyVersion !== ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION) fail()
  return Object.freeze({
    courseVersionItemId: requireUuid(values.courseVersionItemId),
    documentMediaId: requireUuid(values.documentMediaId),
    policyVersion: ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION,
    serverPageCount: requireInteger(
      values.serverPageCount,
      1,
      ELEARNING_DOCUMENT_MAX_PAGES,
    ),
    thresholdBps: requireInteger(values.thresholdBps, 1, 10_000),
  }) as ElearningDocumentCompletionPolicy
}

export function elearningDocumentRequiredPageCount(
  serverPageCount: number,
  thresholdBps: number,
): number {
  const pageCount = requireInteger(serverPageCount, 1, ELEARNING_DOCUMENT_MAX_PAGES)
  const threshold = requireInteger(thresholdBps, 1, 10_000)
  return Number((BigInt(pageCount) * BigInt(threshold) + 9_999n) / 10_000n)
}

function normalizeViewedPages(input: unknown, serverPageCount: number): readonly number[] {
  const pages = new Set<number>()
  for (const value of readDensePageArray(input)) {
    pages.add(requireInteger(value, 1, serverPageCount))
  }
  return Object.freeze([...pages].sort((left, right) => left - right))
}

function compactPageRanges(pages: readonly number[]): readonly ElearningDocumentPageRange[] {
  if (pages.length === 0) return Object.freeze([])
  const ranges: ElearningDocumentPageRange[] = []
  let startPage = pages[0]
  let endPage = pages[0]
  for (let index = 1; index < pages.length; index += 1) {
    const page = pages[index]
    if (page === endPage + 1) {
      endPage = page
      continue
    }
    ranges.push(Object.freeze({ endPage, startPage }))
    startPage = page
    endPage = page
  }
  ranges.push(Object.freeze({ endPage, startPage }))
  return Object.freeze(ranges)
}

function digest(input: {
  courseVersionItemId: string
  documentMediaId: string
  policyVersion: string
  serverPageCount: number
  thresholdBps: number
  viewedPages: readonly number[]
}): string {
  return createHash('sha256').update(JSON.stringify({
    courseVersionItemId: input.courseVersionItemId,
    documentMediaId: input.documentMediaId,
    domain: ELEARNING_DOCUMENT_COMPLETION_DIGEST_DOMAIN,
    evaluatorVersion: ELEARNING_DOCUMENT_COMPLETION_EVALUATOR_VERSION,
    policyVersion: input.policyVersion,
    serverPageCount: input.serverPageCount,
    thresholdBps: input.thresholdBps,
    viewedPages: input.viewedPages,
  }), 'utf8').digest('hex')
}

export function evaluateElearningDocumentCompletion(
  policy: ElearningDocumentCompletionPolicy,
  observation: unknown,
): ElearningDocumentCompletionEvaluation {
  const normalizedPolicy = createElearningDocumentCompletionPolicy(policy)
  const values = readExactObject(observation, OBSERVATION_KEYS)
  const viewedPages = normalizeViewedPages(
    values.viewedPages,
    normalizedPolicy.serverPageCount,
  )
  const requiredPageCount = elearningDocumentRequiredPageCount(
    normalizedPolicy.serverPageCount,
    normalizedPolicy.thresholdBps,
  )
  return Object.freeze({
    assurance: 'server_verified_page_count' as const,
    completed: viewedPages.length >= requiredPageCount,
    courseVersionItemId: normalizedPolicy.courseVersionItemId,
    documentMediaId: normalizedPolicy.documentMediaId,
    evaluatorVersion: ELEARNING_DOCUMENT_COMPLETION_EVALUATOR_VERSION,
    evidenceDigest: digest({ ...normalizedPolicy, viewedPages }),
    policyVersion: ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION,
    requiredPageCount,
    serverPageCount: normalizedPolicy.serverPageCount,
    thresholdBps: normalizedPolicy.thresholdBps,
    viewedPageCount: viewedPages.length,
    viewedPageRanges: compactPageRanges(viewedPages),
  })
}
