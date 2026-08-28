import { createHash } from 'node:crypto'

import {
  createElearningDocumentCompletionPolicy,
  type ElearningDocumentCompletionPolicy,
  type ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION,
  evaluateElearningDocumentCompletion,
} from './elearning-document-completion-policy'
import {
  createElearningDocumentProgressSnapshotFromEvaluation,
  type ElearningDocumentAccessBasis,
  type ElearningDocumentProgressSnapshot,
  normalizeElearningDocumentAccessBasis,
  normalizeElearningDocumentProgressSnapshotForPolicy,
} from './elearning-document-progress'

/**
 * Transactional L1 document session start/resume service.
 *
 * The adapter must re-evaluate current course access and serialize starts for
 * one org+user+item. A successful new start creates the session, sequence-zero
 * event, and initial progress in the same transaction.
 */

export const ELEARNING_DOCUMENT_START_EVENT_DIGEST_DOMAIN =
  'elearning.document.start.v1' as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INPUT_KEYS = ['courseVersionItemId', 'orgId', 'userId'] as const
const MAX_ACTOR_LENGTH = 256

export type ElearningDocumentSessionErrorCode = 'invalid_input' | 'unavailable'

export class ElearningDocumentSessionError extends Error {
  constructor(readonly code: ElearningDocumentSessionErrorCode) {
    super(code)
    this.name = 'ElearningDocumentSessionError'
  }
}

export interface StartElearningDocumentSessionInput {
  readonly courseVersionItemId: string
  readonly orgId: string
  readonly userId: string
}

export interface ElearningDocumentActiveSession {
  readonly progress: ElearningDocumentProgressSnapshot
  readonly sessionId: string
}

export interface ElearningDocumentSessionAuthority {
  readonly accessBasis: ElearningDocumentAccessBasis
  readonly activeSession: ElearningDocumentActiveSession | null
  readonly completion: ElearningDocumentProgressSnapshot | null
  readonly courseVersionId: string
  readonly courseVersionItemId: string
  readonly documentMediaId: string
  readonly policyVersion: typeof ELEARNING_DOCUMENT_COMPLETION_POLICY_VERSION
  readonly serverPageCount: number
  readonly thresholdBps: number
}

export interface ElearningDocumentSessionResult
  extends ElearningDocumentProgressSnapshot {
  readonly created: boolean
  readonly sessionId: string | null
}

export interface ElearningDocumentSessionTransaction {
  /**
   * Must re-evaluate current access and serialize org+user+item starts on a
   * stable DB authority before returning activeSession=null.
   */
  lockAccessibleDocumentForSessionStart(input: {
    readonly courseVersionItemId: string
    readonly orgId: string
    readonly userId: string
  }): Promise<ElearningDocumentSessionAuthority | null>

  createDocumentSession(input: {
    readonly accessBasis: ElearningDocumentAccessBasis
    readonly courseVersionId: string
    readonly courseVersionItemId: string
    readonly orgId: string
    readonly startedAt: string
    readonly userId: string
  }): Promise<string>

  appendDocumentStartEvent(input: {
    readonly courseVersionId: string
    readonly courseVersionItemId: string
    readonly eventDigest: string
    readonly orgId: string
    readonly receivedAt: string
    readonly sequence: 0
    readonly sessionId: string
    readonly userId: string
  }): Promise<void>

  upsertDocumentProgress(input: {
    readonly accessBasis: ElearningDocumentAccessBasis
    readonly courseVersionId: string
    readonly courseVersionItemId: string
    readonly orgId: string
    readonly snapshot: ElearningDocumentProgressSnapshot
    readonly userId: string
  }): Promise<void>
}

export interface ElearningDocumentSessionStore {
  transaction<T>(
    handler: (tx: ElearningDocumentSessionTransaction) => Promise<T>,
  ): Promise<T>
}

interface NormalizedAuthority {
  readonly accessBasis: ElearningDocumentAccessBasis
  readonly activeSession: ElearningDocumentActiveSession | null
  readonly completion: ElearningDocumentProgressSnapshot | null
  readonly courseVersionId: string
  readonly policy: ElearningDocumentCompletionPolicy
}

function fail(code: ElearningDocumentSessionErrorCode): never {
  throw new ElearningDocumentSessionError(code)
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
    if (error instanceof ElearningDocumentSessionError) throw error
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

function requireInputUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function requireStoreUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('unavailable')
  return value.toLowerCase()
}

function canonicalizeInput(input: unknown): StartElearningDocumentSessionInput {
  const values = readExactObject(input)
  return Object.freeze({
    courseVersionItemId: requireInputUuid(values.courseVersionItemId),
    orgId: requireActor(values.orgId),
    userId: requireActor(values.userId),
  })
}

function nowIso(now: () => Date): string {
  const value = now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('unavailable')
  return value.toISOString()
}

function normalizeAuthority(
  authority: ElearningDocumentSessionAuthority,
  input: StartElearningDocumentSessionInput,
): NormalizedAuthority {
  if (requireStoreUuid(authority.courseVersionItemId) !== input.courseVersionItemId) {
    fail('unavailable')
  }
  const policy = createElearningDocumentCompletionPolicy({
    courseVersionItemId: input.courseVersionItemId,
    documentMediaId: requireStoreUuid(authority.documentMediaId),
    policyVersion: authority.policyVersion,
    serverPageCount: authority.serverPageCount,
    thresholdBps: authority.thresholdBps,
  })
  const completion = authority.completion === null
    ? null
    : normalizeElearningDocumentProgressSnapshotForPolicy(
      authority.completion,
      policy,
    )
  let activeSession: ElearningDocumentActiveSession | null = null
  if (authority.activeSession !== null) {
    const progress = normalizeElearningDocumentProgressSnapshotForPolicy(
      authority.activeSession.progress,
      policy,
    )
    if (progress.status !== 'in_progress') fail('unavailable')
    activeSession = Object.freeze({
      progress,
      sessionId: requireStoreUuid(authority.activeSession.sessionId),
    })
  }
  if (completion !== null && activeSession !== null) fail('unavailable')
  return Object.freeze({
    accessBasis: normalizeElearningDocumentAccessBasis(authority.accessBasis),
    activeSession,
    completion,
    courseVersionId: requireStoreUuid(authority.courseVersionId),
    policy,
  })
}

function startEventDigest(input: {
  courseVersionId: string
  courseVersionItemId: string
  orgId: string
  policy: ElearningDocumentCompletionPolicy
  sessionId: string
  startedAt: string
  userId: string
}): string {
  return createHash('sha256').update(JSON.stringify({
    courseVersionId: input.courseVersionId,
    courseVersionItemId: input.courseVersionItemId,
    domain: ELEARNING_DOCUMENT_START_EVENT_DIGEST_DOMAIN,
    documentMediaId: input.policy.documentMediaId,
    orgId: input.orgId,
    policyVersion: input.policy.policyVersion,
    serverPageCount: input.policy.serverPageCount,
    sessionId: input.sessionId,
    startedAt: input.startedAt,
    thresholdBps: input.policy.thresholdBps,
    userId: input.userId,
  }), 'utf8').digest('hex')
}

function publicResult(
  snapshot: ElearningDocumentProgressSnapshot,
  created: boolean,
  sessionId: string | null,
): ElearningDocumentSessionResult {
  return Object.freeze({
    completedAt: snapshot.completedAt,
    created,
    evidenceDigest: snapshot.evidenceDigest,
    requiredPageCount: snapshot.requiredPageCount,
    serverPageCount: snapshot.serverPageCount,
    sessionId,
    status: snapshot.status,
    thresholdBps: snapshot.thresholdBps,
    viewedPageCount: snapshot.viewedPageCount,
    viewedPageRanges: snapshot.viewedPageRanges,
  })
}

export async function startElearningDocumentSession(
  store: ElearningDocumentSessionStore,
  rawInput: unknown,
  now: () => Date = () => new Date(),
): Promise<ElearningDocumentSessionResult> {
  const input = canonicalizeInput(rawInput)
  try {
    return await store.transaction(async (tx) => {
      const rawAuthority = await tx.lockAccessibleDocumentForSessionStart(input)
      if (!rawAuthority) fail('unavailable')
      const authority = normalizeAuthority(rawAuthority, input)
      if (authority.completion) {
        if (authority.completion.status !== 'completed') fail('unavailable')
        return publicResult(authority.completion, false, null)
      }
      if (authority.activeSession) {
        return publicResult(
          authority.activeSession.progress,
          false,
          authority.activeSession.sessionId,
        )
      }

      const startedAt = nowIso(now)
      const sessionId = requireStoreUuid(await tx.createDocumentSession({
        accessBasis: authority.accessBasis,
        courseVersionId: authority.courseVersionId,
        courseVersionItemId: input.courseVersionItemId,
        orgId: input.orgId,
        startedAt,
        userId: input.userId,
      }))
      const snapshot = createElearningDocumentProgressSnapshotFromEvaluation(
        evaluateElearningDocumentCompletion(
          authority.policy,
          { viewedPages: [] },
        ),
      )
      await tx.appendDocumentStartEvent({
        courseVersionId: authority.courseVersionId,
        courseVersionItemId: input.courseVersionItemId,
        eventDigest: startEventDigest({
          courseVersionId: authority.courseVersionId,
          courseVersionItemId: input.courseVersionItemId,
          orgId: input.orgId,
          policy: authority.policy,
          sessionId,
          startedAt,
          userId: input.userId,
        }),
        orgId: input.orgId,
        receivedAt: startedAt,
        sequence: 0,
        sessionId,
        userId: input.userId,
      })
      await tx.upsertDocumentProgress({
        accessBasis: authority.accessBasis,
        courseVersionId: authority.courseVersionId,
        courseVersionItemId: input.courseVersionItemId,
        orgId: input.orgId,
        snapshot,
        userId: input.userId,
      })
      return publicResult(snapshot, true, sessionId)
    })
  } catch (error) {
    if (error instanceof ElearningDocumentSessionError) throw error
    fail('unavailable')
  }
}
