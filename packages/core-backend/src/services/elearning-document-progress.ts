import { createHash } from 'node:crypto'

import {
  createElearningDocumentCompletionPolicy,
  elearningDocumentRequiredPageCount,
  type ElearningDocumentCompletionPolicy,
  type ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION,
  type ElearningDocumentCompletionEvaluation,
  type ElearningDocumentPageRange,
  evaluateElearningDocumentCompletion,
} from './elearning-document-completion-policy'
import { normalizeElearningDocumentMediaAuthority } from './elearning-document-media-authority'

/**
 * Transactional L1 document page-view command service.
 *
 * The persistence adapter owns current-access evaluation, the server-probed
 * page count, row locking, request claims, and append-only writes. This service
 * owns canonical input, idempotency identity, page aggregation, completion
 * evaluation, and the order of effects inside one transaction.
 */

export const ELEARNING_DOCUMENT_PAGE_VIEW_REQUEST_DOMAIN =
  'elearning.document.page-view.v1' as const
export const ELEARNING_DOCUMENT_PAGE_VIEW_REQUEST_HASH_VERSION = 1 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_RE = /^[a-f0-9]{64}$/
const INPUT_KEYS = [
  'courseVersionItemId',
  'orgId',
  'pageNumber',
  'requestId',
  'sessionId',
  'userId',
] as const
const MAX_ACTOR_LENGTH = 256

export type ElearningDocumentProgressErrorCode =
  | 'conflict'
  | 'invalid_input'
  | 'unavailable'

export class ElearningDocumentProgressError extends Error {
  constructor(readonly code: ElearningDocumentProgressErrorCode) {
    super(code)
    this.name = 'ElearningDocumentProgressError'
  }
}

export interface RecordElearningDocumentPageViewInput {
  readonly courseVersionItemId: string
  readonly orgId: string
  readonly pageNumber: number
  readonly requestId: string
  readonly sessionId: string
  readonly userId: string
}

export type ElearningDocumentAccessBasis =
  | {
    readonly assignmentMemberId: string
    readonly kind: 'assignment'
  }
  | {
    readonly kind: 'visibility'
    readonly scopeRevisionRuleId: string
  }

export interface ElearningDocumentProgressSnapshot {
  readonly completedAt: string | null
  readonly evidenceDigest: string | null
  readonly requiredPageCount: number
  readonly serverPageCount: number
  readonly status: 'completed' | 'in_progress'
  readonly thresholdBps: number
  readonly viewedPageCount: number
  readonly viewedPageRanges: readonly ElearningDocumentPageRange[]
}

export interface ElearningDocumentPageViewResult
  extends ElearningDocumentProgressSnapshot {
  readonly replayed: boolean
}

export interface ElearningDocumentAuthority {
  readonly accessBasis: ElearningDocumentAccessBasis
  readonly completion: ElearningDocumentProgressSnapshot | null
  readonly courseVersionId: string
  readonly courseVersionItemId: string
  readonly documentMediaId: string
  readonly documentMediaKind: 'document'
  readonly documentMediaStatus: 'ready'
  readonly documentPageCountAuthority: 'server_probe'
  readonly policyVersion: typeof ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION
  readonly serverPageCount: number
  readonly sessionId: string
  readonly thresholdBps: number
}

export type ElearningDocumentPageViewClaim =
  | { readonly kind: 'claimed' }
  | {
    readonly kind: 'existing'
    readonly requestHash: string
    readonly result: ElearningDocumentProgressSnapshot
  }

export interface ElearningDocumentPageViewTransaction {
  /**
   * Must re-evaluate current course/version/access state, verify that the
   * active session belongs to the same org+user+item, and serialize that
   * progress before returning. Null means fail-closed denial.
   */
  lockAccessibleDocumentForUpdate(input: {
    readonly courseVersionItemId: string
    readonly orgId: string
    readonly sessionId: string
    readonly userId: string
  }): Promise<ElearningDocumentAuthority | null>

  /** Unique authority: org+user+item+requestId. */
  claimPageViewRequest(input: {
    readonly courseVersionItemId: string
    readonly orgId: string
    readonly requestHash: string
    readonly requestHashVersion: typeof ELEARNING_DOCUMENT_PAGE_VIEW_REQUEST_HASH_VERSION
    readonly requestId: string
    readonly sessionId: string
    readonly userId: string
  }): Promise<ElearningDocumentPageViewClaim>

  listViewedPages(input: {
    readonly courseVersionItemId: string
    readonly orgId: string
    readonly userId: string
  }): Promise<readonly number[]>

  appendPageView(input: {
    readonly courseVersionId: string
    readonly courseVersionItemId: string
    readonly orgId: string
    readonly pageNumber: number
    readonly receivedAt: string
    readonly requestHash: string
    readonly requestHashVersion: typeof ELEARNING_DOCUMENT_PAGE_VIEW_REQUEST_HASH_VERSION
    readonly requestId: string
    readonly sessionId: string
    readonly userId: string
  }): Promise<void>

  /**
   * Must use an org+user+item uniqueness authority. On conflict it returns the
   * DB-fresh immutable completion snapshot instead of creating a second row.
   */
  appendCompletionEvidenceIfAbsent(input: {
    readonly accessBasis: ElearningDocumentAccessBasis
    readonly completedAt: string
    readonly courseVersionId: string
    readonly courseVersionItemId: string
    readonly documentMediaId: string
    readonly evaluation: ElearningDocumentCompletionEvaluation
    readonly orgId: string
    readonly userId: string
  }): Promise<ElearningDocumentProgressSnapshot>

  upsertProgress(input: {
    readonly accessBasis: ElearningDocumentAccessBasis
    readonly courseVersionId: string
    readonly courseVersionItemId: string
    readonly orgId: string
    readonly snapshot: ElearningDocumentProgressSnapshot
    readonly userId: string
  }): Promise<void>

  storePageViewRequestResult(input: {
    readonly courseVersionItemId: string
    readonly orgId: string
    readonly requestId: string
    readonly result: ElearningDocumentProgressSnapshot
    readonly userId: string
  }): Promise<void>
}

export interface ElearningDocumentProgressStore {
  transaction<T>(
    handler: (tx: ElearningDocumentPageViewTransaction) => Promise<T>,
  ): Promise<T>
}

function fail(code: ElearningDocumentProgressErrorCode): never {
  throw new ElearningDocumentProgressError(code)
}

function readExactObject(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_input')
  }
  try {
    const keys = Reflect.ownKeys(input)
    if (keys.some((key) => (
      typeof key !== 'string'
      || !Object.prototype.propertyIsEnumerable.call(input, key)
    ))) fail('invalid_input')
    const sorted = (keys as string[]).sort()
    if (
      sorted.length !== INPUT_KEYS.length
      || sorted.some((key, index) => key !== INPUT_KEYS[index])
    ) fail('invalid_input')
    return Object.fromEntries(
      INPUT_KEYS.map((key) => [key, (input as Record<string, unknown>)[key]]),
    )
  } catch (error) {
    if (error instanceof ElearningDocumentProgressError) throw error
    fail('invalid_input')
  }
}

function requireActor(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (text === '' || text.length > MAX_ACTOR_LENGTH || text.includes('\0')) {
    fail('invalid_input')
  }
  return text
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function requirePositiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    fail('invalid_input')
  }
  return value
}

function canonicalizeInput(input: unknown): RecordElearningDocumentPageViewInput {
  const values = readExactObject(input)
  return Object.freeze({
    courseVersionItemId: requireUuid(values.courseVersionItemId),
    orgId: requireActor(values.orgId),
    pageNumber: requirePositiveInteger(values.pageNumber),
    requestId: requireUuid(values.requestId),
    sessionId: requireUuid(values.sessionId),
    userId: requireActor(values.userId),
  })
}

function requestHash(input: RecordElearningDocumentPageViewInput): string {
  return createHash('sha256').update(JSON.stringify({
    courseVersionItemId: input.courseVersionItemId,
    domain: ELEARNING_DOCUMENT_PAGE_VIEW_REQUEST_DOMAIN,
    orgId: input.orgId,
    pageNumber: input.pageNumber,
    sessionId: input.sessionId,
    userId: input.userId,
  }), 'utf8').digest('hex')
}

function nowIso(now: () => Date): string {
  const value = now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('unavailable')
  return value.toISOString()
}

export function createElearningDocumentProgressSnapshotFromEvaluation(
  evaluation: ElearningDocumentCompletionEvaluation,
): ElearningDocumentProgressSnapshot {
  if (evaluation.completed) fail('unavailable')
  return Object.freeze({
    completedAt: null,
    evidenceDigest: null,
    requiredPageCount: evaluation.requiredPageCount,
    serverPageCount: evaluation.serverPageCount,
    status: 'in_progress' as const,
    thresholdBps: evaluation.thresholdBps,
    viewedPageCount: evaluation.viewedPageCount,
    viewedPageRanges: evaluation.viewedPageRanges,
  })
}

function publicResult(
  snapshot: ElearningDocumentProgressSnapshot,
  replayed: boolean,
): ElearningDocumentPageViewResult {
  return Object.freeze({
    completedAt: snapshot.completedAt,
    evidenceDigest: snapshot.evidenceDigest,
    replayed,
    requiredPageCount: snapshot.requiredPageCount,
    serverPageCount: snapshot.serverPageCount,
    status: snapshot.status,
    thresholdBps: snapshot.thresholdBps,
    viewedPageCount: snapshot.viewedPageCount,
    viewedPageRanges: snapshot.viewedPageRanges,
  })
}

function requireStoreUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('unavailable')
  return value.toLowerCase()
}

export function normalizeElearningDocumentAccessBasis(
  value: unknown,
): ElearningDocumentAccessBasis {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('unavailable')
  }
  const source = value as Record<string, unknown>
  const keys = Reflect.ownKeys(source).sort()
  if (source.kind === 'assignment') {
    if (
      keys.length !== 2
      || keys[0] !== 'assignmentMemberId'
      || keys[1] !== 'kind'
    ) fail('unavailable')
    return Object.freeze({
      assignmentMemberId: requireStoreUuid(source.assignmentMemberId),
      kind: 'assignment' as const,
    })
  }
  if (source.kind === 'visibility') {
    if (
      keys.length !== 2
      || keys[0] !== 'kind'
      || keys[1] !== 'scopeRevisionRuleId'
    ) fail('unavailable')
    return Object.freeze({
      kind: 'visibility' as const,
      scopeRevisionRuleId: requireStoreUuid(source.scopeRevisionRuleId),
    })
  }
  fail('unavailable')
}

function requireAuthority(
  authority: ElearningDocumentAuthority,
  input: RecordElearningDocumentPageViewInput,
): {
  accessBasis: ElearningDocumentAccessBasis
  courseVersionId: string
  documentMediaId: string
  serverPageCount: number
  sessionId: string
} {
  if (requireStoreUuid(authority.courseVersionItemId) !== input.courseVersionItemId) {
    fail('unavailable')
  }
  const sessionId = requireStoreUuid(authority.sessionId)
  if (sessionId !== input.sessionId) fail('unavailable')
  const media = normalizeElearningDocumentMediaAuthority({
    documentMediaId: authority.documentMediaId,
    documentMediaKind: authority.documentMediaKind,
    documentMediaStatus: authority.documentMediaStatus,
    documentPageCountAuthority: authority.documentPageCountAuthority,
    serverPageCount: authority.serverPageCount,
  })
  return {
    accessBasis: normalizeElearningDocumentAccessBasis(authority.accessBasis),
    courseVersionId: requireStoreUuid(authority.courseVersionId),
    documentMediaId: media.documentMediaId,
    serverPageCount: media.serverPageCount,
    sessionId,
  }
}

export function normalizeElearningDocumentProgressSnapshot(
  snapshot: ElearningDocumentProgressSnapshot,
): ElearningDocumentProgressSnapshot {
  if (
    snapshot.status !== 'completed'
    && snapshot.status !== 'in_progress'
  ) fail('unavailable')
  if (
    !Number.isSafeInteger(snapshot.serverPageCount)
    || !Number.isSafeInteger(snapshot.requiredPageCount)
    || !Number.isSafeInteger(snapshot.thresholdBps)
    || !Number.isSafeInteger(snapshot.viewedPageCount)
    || snapshot.serverPageCount < 1
    || snapshot.requiredPageCount < 1
    || snapshot.requiredPageCount > snapshot.serverPageCount
    || snapshot.thresholdBps < 1
    || snapshot.thresholdBps > 10_000
    || snapshot.viewedPageCount < 0
    || snapshot.viewedPageCount > snapshot.serverPageCount
    || (snapshot.status === 'completed'
      && snapshot.viewedPageCount < snapshot.requiredPageCount)
    || (snapshot.status === 'in_progress'
      && snapshot.viewedPageCount >= snapshot.requiredPageCount)
  ) fail('unavailable')
  if (snapshot.status === 'completed') {
    if (
      typeof snapshot.completedAt !== 'string'
      || !Number.isFinite(Date.parse(snapshot.completedAt))
      || typeof snapshot.evidenceDigest !== 'string'
      || !SHA256_RE.test(snapshot.evidenceDigest)
    ) fail('unavailable')
  } else if (snapshot.completedAt !== null || snapshot.evidenceDigest !== null) {
    fail('unavailable')
  }
  const ranges = requireStoredRanges(
    snapshot.viewedPageRanges,
    snapshot.serverPageCount,
    snapshot.viewedPageCount,
  )
  return Object.freeze({
    completedAt: snapshot.completedAt,
    evidenceDigest: snapshot.evidenceDigest,
    requiredPageCount: snapshot.requiredPageCount,
    serverPageCount: snapshot.serverPageCount,
    status: snapshot.status,
    thresholdBps: snapshot.thresholdBps,
    viewedPageCount: snapshot.viewedPageCount,
    viewedPageRanges: ranges,
  })
}

function requireStoredRanges(
  value: unknown,
  serverPageCount: number,
  viewedPageCount: number,
): readonly ElearningDocumentPageRange[] {
  if (!Array.isArray(value) || value.length > serverPageCount) fail('unavailable')
  const ranges: ElearningDocumentPageRange[] = []
  let previousEnd = 0
  let countedPages = 0
  for (const candidate of value) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      fail('unavailable')
    }
    const keys = Reflect.ownKeys(candidate).sort()
    if (
      keys.length !== 2
      || keys[0] !== 'endPage'
      || keys[1] !== 'startPage'
    ) fail('unavailable')
    const { endPage, startPage } = candidate as Record<string, unknown>
    if (
      typeof endPage !== 'number'
      || typeof startPage !== 'number'
      || !Number.isSafeInteger(endPage)
      || !Number.isSafeInteger(startPage)
      || startPage < 1
      || endPage < startPage
      || endPage > serverPageCount
      || startPage <= previousEnd + (ranges.length === 0 ? 0 : 1)
    ) fail('unavailable')
    countedPages += endPage - startPage + 1
    previousEnd = endPage
    ranges.push(Object.freeze({ endPage, startPage }))
  }
  if (countedPages !== viewedPageCount) fail('unavailable')
  return Object.freeze(ranges)
}

export function normalizeElearningDocumentProgressSnapshotForPolicy(
  snapshot: ElearningDocumentProgressSnapshot,
  policy: ElearningDocumentCompletionPolicy,
): ElearningDocumentProgressSnapshot {
  const normalized = normalizeElearningDocumentProgressSnapshot(snapshot)
  if (
    normalized.serverPageCount !== policy.serverPageCount
    || normalized.thresholdBps !== policy.thresholdBps
    || normalized.requiredPageCount !== elearningDocumentRequiredPageCount(
      policy.serverPageCount,
      policy.thresholdBps,
    )
  ) fail('unavailable')
  return normalized
}

export async function recordElearningDocumentPageView(
  store: ElearningDocumentProgressStore,
  rawInput: unknown,
  now: () => Date = () => new Date(),
): Promise<ElearningDocumentPageViewResult> {
  const input = canonicalizeInput(rawInput)
  const hash = requestHash(input)
  try {
    return await store.transaction(async (tx) => {
      const authority = await tx.lockAccessibleDocumentForUpdate({
        courseVersionItemId: input.courseVersionItemId,
        orgId: input.orgId,
        sessionId: input.sessionId,
        userId: input.userId,
      })
      if (!authority) fail('unavailable')
      const normalizedAuthority = requireAuthority(authority, input)
      const policy = createElearningDocumentCompletionPolicy({
        courseVersionItemId: input.courseVersionItemId,
        documentMediaId: normalizedAuthority.documentMediaId,
        policyVersion: authority.policyVersion,
        serverPageCount: normalizedAuthority.serverPageCount,
        thresholdBps: authority.thresholdBps,
      })
      if (input.pageNumber > policy.serverPageCount) fail('invalid_input')

      const claim = await tx.claimPageViewRequest({
        courseVersionItemId: input.courseVersionItemId,
        orgId: input.orgId,
        requestHash: hash,
        requestHashVersion: ELEARNING_DOCUMENT_PAGE_VIEW_REQUEST_HASH_VERSION,
        requestId: input.requestId,
        sessionId: input.sessionId,
        userId: input.userId,
      })
      if (claim.kind === 'existing') {
        if (claim.requestHash !== hash) fail('conflict')
        return publicResult(
          normalizeElearningDocumentProgressSnapshotForPolicy(claim.result, policy),
          true,
        )
      }

      if (authority.completion) {
        const existing = normalizeElearningDocumentProgressSnapshotForPolicy(
          authority.completion,
          policy,
        )
        if (existing.status !== 'completed') fail('unavailable')
        await tx.storePageViewRequestResult({
          courseVersionItemId: input.courseVersionItemId,
          orgId: input.orgId,
          requestId: input.requestId,
          result: existing,
          userId: input.userId,
        })
        return publicResult(existing, false)
      }

      const viewedPages = await tx.listViewedPages({
        courseVersionItemId: input.courseVersionItemId,
        orgId: input.orgId,
        userId: input.userId,
      })
      const evaluation = evaluateElearningDocumentCompletion(
        policy,
        { viewedPages: [...viewedPages, input.pageNumber] },
      )
      const receivedAt = nowIso(now)
      await tx.appendPageView({
        courseVersionId: normalizedAuthority.courseVersionId,
        courseVersionItemId: input.courseVersionItemId,
        orgId: input.orgId,
        pageNumber: input.pageNumber,
        receivedAt,
        requestHash: hash,
        requestHashVersion: ELEARNING_DOCUMENT_PAGE_VIEW_REQUEST_HASH_VERSION,
        requestId: input.requestId,
        sessionId: normalizedAuthority.sessionId,
        userId: input.userId,
      })

      const snapshot = evaluation.completed
        ? normalizeElearningDocumentProgressSnapshotForPolicy(
          await tx.appendCompletionEvidenceIfAbsent({
          accessBasis: normalizedAuthority.accessBasis,
          completedAt: receivedAt,
          courseVersionId: normalizedAuthority.courseVersionId,
          courseVersionItemId: input.courseVersionItemId,
          documentMediaId: normalizedAuthority.documentMediaId,
          evaluation,
          orgId: input.orgId,
          userId: input.userId,
          }),
          policy,
        )
        : createElearningDocumentProgressSnapshotFromEvaluation(evaluation)
      if (evaluation.completed && snapshot.status !== 'completed') fail('unavailable')

      await tx.upsertProgress({
        accessBasis: normalizedAuthority.accessBasis,
        courseVersionId: normalizedAuthority.courseVersionId,
        courseVersionItemId: input.courseVersionItemId,
        orgId: input.orgId,
        snapshot,
        userId: input.userId,
      })
      await tx.storePageViewRequestResult({
        courseVersionItemId: input.courseVersionItemId,
        orgId: input.orgId,
        requestId: input.requestId,
        result: snapshot,
        userId: input.userId,
      })
      return publicResult(snapshot, false)
    })
  } catch (error) {
    if (error instanceof ElearningDocumentProgressError) throw error
    fail('unavailable')
  }
}
