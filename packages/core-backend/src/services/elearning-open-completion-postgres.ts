import { createHash, randomUUID } from 'node:crypto'

import {
  ElearningCourseAccessError,
  resolveElearningCourseAccess,
  type ElearningCourseAccessQueryable,
} from './elearning-course-access'
import {
  createElearningContentRevision,
  type ElearningContentRevision,
  type ElearningContentRevisionItemType,
} from './elearning-content-revision-policy'
import {
  ELEARNING_OPEN_COMPLETION_EVALUATOR_VERSION,
  createElearningOpenCompletionPolicy,
  evaluateElearningOpenCompletion,
  type ElearningOpenCompletionAssurance,
  type ElearningOpenCompletionEventKind,
  type ElearningOpenCompletionPolicyVersion,
} from './elearning-open-completion-policy'

export const ELEARNING_OPEN_REQUEST_DOMAIN =
  'elearning.open.completion.request.v1' as const
export const ELEARNING_OPEN_REQUEST_HASH_VERSION = 1 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACTOR_MAX = 256
const INPUT_KEYS = ['itemId', 'orgId', 'requestId', 'userId'] as const

export type ElearningOpenCompletionStoreErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'forbidden'
  | 'course_withdrawn'
  | 'unsupported_item'
  | 'conflict'
  | 'unavailable'

export class ElearningOpenCompletionStoreError extends Error {
  constructor(readonly code: ElearningOpenCompletionStoreErrorCode) {
    super(code)
    this.name = 'ElearningOpenCompletionStoreError'
  }
}

export interface ElearningOpenCompletionQueryable extends ElearningCourseAccessQueryable {}

export interface ElearningOpenCompletionDb {
  transaction<T>(
    handler: (tx: ElearningOpenCompletionQueryable) => Promise<T>,
  ): Promise<T>
}

export interface RecordElearningOpenCompletionInput {
  orgId: string
  userId: string
  requestId: string
  itemId: string
}

export interface ElearningOpenCompletionResult {
  itemId: string
  itemType: ElearningContentRevisionItemType
  title: string
  articleHtml: string | null
  externalUrl: string | null
  status: 'completed'
  completedAt: string
  assurance: ElearningOpenCompletionAssurance
}

interface CanonicalOpenInput {
  orgId: string
  userId: string
  requestId: string
  itemId: string
}

interface ContentItemAuthority {
  courseVersionId: string
  itemId: string
  itemType: ElearningContentRevisionItemType
  revision: ElearningContentRevision
  policyVersion: ElearningOpenCompletionPolicyVersion
}

interface StoredEvent {
  id: string
  eventKind: ElearningOpenCompletionEventKind
  eventDigest: string
  completedAt: string
  assurance: ElearningOpenCompletionAssurance
}

function fail(code: ElearningOpenCompletionStoreErrorCode): never {
  throw new ElearningOpenCompletionStoreError(code)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireExactKeys(value: Record<string, unknown>): void {
  const keys = Object.keys(value).sort()
  if (keys.length !== INPUT_KEYS.length || keys.some((key, index) => key !== INPUT_KEYS[index])) {
    fail('invalid_input')
  }
}

function requireActor(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const actor = value.trim()
  if (actor === '' || actor.length > ACTOR_MAX || actor.includes('\0')) fail('invalid_input')
  return actor
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function storedUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('unavailable')
  return value.toLowerCase()
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asPositiveInt(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : null
  return number !== null && Number.isSafeInteger(number) && number > 0
    ? number
    : null
}

function asIso(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === 'string') {
    const timestamp = Date.parse(value)
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString()
  }
  fail('unavailable')
}

export function canonicalizeElearningOpenCompletionInput(
  input: unknown,
): CanonicalOpenInput {
  if (!isPlainObject(input)) fail('invalid_input')
  requireExactKeys(input)
  return {
    orgId: requireActor(input.orgId),
    userId: requireActor(input.userId),
    requestId: requireUuid(input.requestId),
    itemId: requireUuid(input.itemId),
  }
}

function requestHash(input: CanonicalOpenInput, version: number): string {
  if (version !== ELEARNING_OPEN_REQUEST_HASH_VERSION) fail('unavailable')
  return createHash('sha256').update(JSON.stringify({
    domain: ELEARNING_OPEN_REQUEST_DOMAIN,
    itemId: input.itemId,
    userId: input.userId,
    version,
  }), 'utf8').digest('hex')
}

function mapAccessError(error: ElearningCourseAccessError): never {
  if (error.code === 'not_found') fail('not_found')
  if (error.code === 'withdrawn') fail('course_withdrawn')
  if (error.code === 'denied' || error.code === 'unsupported_version') fail('forbidden')
  fail('unavailable')
}

async function loadItemAuthority(
  tx: ElearningOpenCompletionQueryable,
  input: CanonicalOpenInput,
): Promise<ContentItemAuthority> {
  const item = await tx.query(
    `/* elearning-open-completion:load-item */
     SELECT course_version_id, item_type,
            article_revision_id, external_link_revision_id,
            completion_policy_version
       FROM elearning_course_version_items
      WHERE org_id = $1 AND id = $2
        AND item_type IN ('article', 'external_link')
      FOR SHARE`,
    [input.orgId, input.itemId],
  )
  const itemRow = item.rows[0]
  if (!itemRow) fail('not_found')
  const courseVersionId = storedUuid(itemRow.course_version_id)
  let access: Awaited<ReturnType<typeof resolveElearningCourseAccess>>
  try {
    access = await resolveElearningCourseAccess(tx, {
      orgId: input.orgId,
      userId: input.userId,
      courseVersionId,
    })
  } catch (error) {
    if (error instanceof ElearningCourseAccessError) mapAccessError(error)
    fail('unavailable')
  }
  if (access.courseVersionId !== courseVersionId) fail('unavailable')

  const itemType = asText(itemRow.item_type)
  if (itemType !== 'article' && itemType !== 'external_link') fail('unsupported_item')
  const contentRevisionId = itemType === 'article'
    ? storedUuid(itemRow.article_revision_id)
    : storedUuid(itemRow.external_link_revision_id)
  const revisionResult = await tx.query(
    `/* elearning-open-completion:load-revision */
     SELECT id, item_type, title, article_html, external_url, content_digest
       FROM elearning_content_revisions
      WHERE org_id = $1 AND id = $2 AND item_type = $3
      FOR SHARE`,
    [input.orgId, contentRevisionId, itemType],
  )
  const revisionRow = revisionResult.rows[0]
  if (!revisionRow) fail('unavailable')
  let revision: ElearningContentRevision
  try {
    revision = createElearningContentRevision({
      articleHtml: revisionRow.article_html ?? null,
      contentRevisionId: revisionRow.id,
      externalUrl: revisionRow.external_url ?? null,
      itemType: revisionRow.item_type,
      title: revisionRow.title,
    })
  } catch {
    fail('unavailable')
  }
  if (revision.contentDigest !== asText(revisionRow.content_digest)) fail('unavailable')
  let policy
  try {
    policy = createElearningOpenCompletionPolicy({
      contentRevisionId,
      courseVersionItemId: input.itemId,
      itemType,
      policyVersion: itemRow.completion_policy_version,
    })
  } catch {
    fail('unsupported_item')
  }
  return {
    courseVersionId,
    itemId: input.itemId,
    itemType,
    revision,
    policyVersion: policy.policyVersion,
  }
}

async function loadAndVerifyEvent(
  tx: ElearningOpenCompletionQueryable,
  input: CanonicalOpenInput,
  authority: ContentItemAuthority,
  eventId: string,
): Promise<StoredEvent> {
  const result = await tx.query(
    `/* elearning-open-completion:load-event */
     SELECT id, event_kind, event_digest, server_received_at,
            course_version_id, course_version_item_id, item_type,
            content_revision_id, user_id
       FROM elearning_open_completion_events
      WHERE org_id = $1 AND id = $2
      FOR SHARE`,
    [input.orgId, eventId],
  )
  const row = result.rows[0]
  if (!row) fail('unavailable')
  if (
    storedUuid(row.course_version_id) !== authority.courseVersionId
    || storedUuid(row.course_version_item_id) !== authority.itemId
    || storedUuid(row.content_revision_id) !== authority.revision.contentRevisionId
    || asText(row.item_type) !== authority.itemType
    || asText(row.user_id) !== input.userId
  ) fail('unavailable')
  const eventIdValue = storedUuid(row.id)
  const eventKind = asText(row.event_kind)
  const completedAt = asIso(row.server_received_at)
  let evaluation
  try {
    evaluation = evaluateElearningOpenCompletion(
      createElearningOpenCompletionPolicy({
        contentRevisionId: authority.revision.contentRevisionId,
        courseVersionItemId: authority.itemId,
        itemType: authority.itemType,
        policyVersion: authority.policyVersion,
      }),
      { eventId: eventIdValue, eventKind, serverReceivedAt: completedAt },
    )
  } catch {
    fail('unavailable')
  }
  if (!evaluation.completed || evaluation.evidenceDigest !== asText(row.event_digest)) {
    fail('unavailable')
  }
  return {
    id: eventIdValue,
    eventKind: evaluation.eventKind,
    eventDigest: evaluation.evidenceDigest,
    completedAt: evaluation.completedAt ?? fail('unavailable'),
    assurance: evaluation.assurance,
  }
}

function resultFrom(
  authority: ContentItemAuthority,
  event: StoredEvent,
): ElearningOpenCompletionResult {
  return {
    itemId: authority.itemId,
    itemType: authority.itemType,
    title: authority.revision.title,
    articleHtml: authority.revision.articleHtml,
    externalUrl: authority.revision.externalUrl,
    status: 'completed',
    completedAt: event.completedAt,
    assurance: event.assurance,
  }
}

function isRequestUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; constraint?: unknown }
  return candidate.code === '23505'
    && candidate.constraint === 'elearning_open_completion_requests_org_user_source_uniq'
}

export async function recordElearningOpenCompletion(
  db: ElearningOpenCompletionDb,
  input: RecordElearningOpenCompletionInput,
): Promise<ElearningOpenCompletionResult> {
  const canonical = canonicalizeElearningOpenCompletionInput(input)
  const hash = requestHash(canonical, ELEARNING_OPEN_REQUEST_HASH_VERSION)

  try {
    return await db.transaction(async (tx) => {
      await tx.query(
        `/* elearning-open-completion:lock-request */
         SELECT pg_advisory_xact_lock(hashtext($1))`,
        [`elearning-open:${canonical.orgId}:${canonical.userId}:${canonical.requestId}`],
      )
      const request = await tx.query(
        `/* elearning-open-completion:load-request */
         SELECT request_hash, request_hash_version, course_version_item_id,
                event_id, completion_evidence_id
           FROM elearning_open_completion_requests
          WHERE org_id = $1 AND user_id = $2 AND source_key = $3
          FOR UPDATE`,
        [canonical.orgId, canonical.userId, canonical.requestId],
      )
      const requestRow = request.rows[0]
      if (requestRow) {
        const storedHash = asText(requestRow.request_hash)
        const storedVersion = asPositiveInt(requestRow.request_hash_version)
        if (!storedHash || storedVersion === null) fail('unavailable')
        if (requestHash(canonical, storedVersion) !== storedHash) fail('conflict')
        if (storedUuid(requestRow.course_version_item_id) !== canonical.itemId) fail('conflict')
      }

      const authority = await loadItemAuthority(tx, canonical)
      if (requestRow) {
        const event = await loadAndVerifyEvent(
          tx,
          canonical,
          authority,
          storedUuid(requestRow.event_id),
        )
        const evidence = await tx.query(
          `/* elearning-open-completion:verify-request-evidence */
           SELECT id FROM elearning_completion_evidence
            WHERE org_id = $1 AND id = $2 AND user_id = $3
              AND course_version_item_id = $4 AND open_event_id = $5
            FOR SHARE`,
          [
            canonical.orgId,
            storedUuid(requestRow.completion_evidence_id),
            canonical.userId,
            canonical.itemId,
            event.id,
          ],
        )
        if (evidence.rows.length !== 1) fail('unavailable')
        return resultFrom(authority, event)
      }

      const timestampResult = await tx.query(
        `/* elearning-open-completion:server-time */
         SELECT clock_timestamp() AS server_received_at`,
      )
      const eventId = randomUUID()
      const serverReceivedAt = asIso(timestampResult.rows[0]?.server_received_at)
      let evaluation
      try {
        evaluation = evaluateElearningOpenCompletion(
          createElearningOpenCompletionPolicy({
            contentRevisionId: authority.revision.contentRevisionId,
            courseVersionItemId: authority.itemId,
            itemType: authority.itemType,
            policyVersion: authority.policyVersion,
          }),
          {
            eventId,
            eventKind: authority.itemType === 'article'
              ? 'article_open'
              : 'external_link_launch',
            serverReceivedAt,
          },
        )
      } catch {
        fail('unavailable')
      }
      if (!evaluation.completed || !evaluation.evidenceDigest || !evaluation.completedAt) {
        fail('unavailable')
      }
      const insertedEvent = await tx.query(
        `/* elearning-open-completion:claim-effect */
         INSERT INTO elearning_open_completion_events (
           id, org_id, user_id, course_version_id, course_version_item_id,
           item_type, content_revision_id, event_kind, event_digest,
           server_received_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (org_id, user_id, course_version_item_id) DO NOTHING
         RETURNING id`,
        [
          eventId,
          canonical.orgId,
          canonical.userId,
          authority.courseVersionId,
          authority.itemId,
          authority.itemType,
          authority.revision.contentRevisionId,
          evaluation.eventKind,
          evaluation.evidenceDigest,
          evaluation.completedAt,
        ],
      )
      const effectiveEventId = insertedEvent.rows[0]
        ? storedUuid(insertedEvent.rows[0].id)
        : storedUuid((await tx.query(
            `/* elearning-open-completion:load-effect */
             SELECT id FROM elearning_open_completion_events
              WHERE org_id = $1 AND user_id = $2 AND course_version_item_id = $3
              FOR SHARE`,
            [canonical.orgId, canonical.userId, authority.itemId],
          )).rows[0]?.id)
      const event = await loadAndVerifyEvent(
        tx,
        canonical,
        authority,
        effectiveEventId,
      )

      const basis = await resolveElearningCourseAccess(tx, {
        orgId: canonical.orgId,
        userId: canonical.userId,
        courseVersionId: authority.courseVersionId,
      })
      const evidenceId = randomUUID()
      const insertedEvidence = await tx.query(
        `/* elearning-open-completion:insert-evidence */
         INSERT INTO elearning_completion_evidence (
           id, org_id, assignment_member_id, scope_revision_rule_id,
           course_version_id, course_version_item_id, user_id, item_type,
           completion_policy_version, completion_threshold_bps,
           media_duration_ms, effective_ms, max_position_ms,
           content_revision_id, open_event_id, completion_assurance,
           event_digest, evaluator_version, completed_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           NULL, NULL, NULL, NULL, $10, $11, $12, $13, $14, $15
         )
         ON CONFLICT (org_id, user_id, course_version_item_id) DO NOTHING
         RETURNING id`,
        [
          evidenceId,
          canonical.orgId,
          basis.basis.assignmentMemberId,
          basis.basis.scopeRevisionRuleId,
          authority.courseVersionId,
          authority.itemId,
          canonical.userId,
          authority.itemType,
          authority.policyVersion,
          authority.revision.contentRevisionId,
          event.id,
          event.assurance,
          event.eventDigest,
          ELEARNING_OPEN_COMPLETION_EVALUATOR_VERSION,
          event.completedAt,
        ],
      )
      const effectiveEvidenceId = insertedEvidence.rows[0]
        ? storedUuid(insertedEvidence.rows[0].id)
        : storedUuid((await tx.query(
            `/* elearning-open-completion:load-evidence */
             SELECT id, open_event_id FROM elearning_completion_evidence
              WHERE org_id = $1 AND user_id = $2 AND course_version_item_id = $3
              FOR SHARE`,
            [canonical.orgId, canonical.userId, authority.itemId],
          )).rows[0]?.id)

      await tx.query(
        `/* elearning-open-completion:insert-request */
         INSERT INTO elearning_open_completion_requests (
           id, org_id, user_id, source_key, course_version_item_id,
           request_hash, request_hash_version, event_id, completion_evidence_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          randomUUID(),
          canonical.orgId,
          canonical.userId,
          canonical.requestId,
          authority.itemId,
          hash,
          ELEARNING_OPEN_REQUEST_HASH_VERSION,
          event.id,
          effectiveEvidenceId,
        ],
      )
      return resultFrom(authority, event)
    })
  } catch (error) {
    if (error instanceof ElearningOpenCompletionStoreError) throw error
    if (error instanceof ElearningCourseAccessError) mapAccessError(error)
    if (isRequestUniqueConflict(error)) fail('conflict')
    fail('unavailable')
  }
}
