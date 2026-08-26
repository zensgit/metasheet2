/**
 * Durable L2 notification intent creation.
 *
 * This internal service does not scan assignments, register a route, or call a
 * channel. Until a default-OFF producer is wired, the ledger remains inert.
 * A future producer must supply orgId from authenticated/job context and own
 * the canonical reminder-window sourceKey; neither may come from client input.
 */
import { createHash, randomUUID } from 'node:crypto'

export const ELEARNING_NOTIFICATION_REQUEST_DOMAIN =
  'elearning.notification.delivery.request.v1' as const
export const ELEARNING_NOTIFICATION_REQUEST_HASH_VERSION = 1 as const
export const ELEARNING_NOTIFICATION_PAYLOAD_MAX_BYTES = 16 * 1024
export const ELEARNING_NOTIFICATION_LOCK_NAMESPACE =
  'elearning-notification-delivery' as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CANONICAL_UTC_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export type ElearningNotificationDeliveryErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'not_eligible'
  | 'conflict'
  | 'unavailable'

export class ElearningNotificationDeliveryError extends Error {
  constructor(readonly code: ElearningNotificationDeliveryErrorCode) {
    super(code)
    this.name = 'ElearningNotificationDeliveryError'
  }
}

export interface ElearningNotificationDeliveryQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningNotificationDeliveryDb
  extends ElearningNotificationDeliveryQueryable {
  transaction<T>(
    handler: (tx: ElearningNotificationDeliveryQueryable) => Promise<T>,
  ): Promise<T>
}

export interface EnqueueElearningNotificationDeliveryInput {
  /** Authoritative authenticated org or persisted job.org_id. */
  orgId: string
  assignmentMemberId: string
  recipientUserId: string
  /** Producer-owned business identity, not an externally supplied token. */
  sourceKey: string
  dueAt: string | Date
  payload: unknown
}

export interface EnqueueElearningNotificationDeliveryResult {
  deliveryId: string
  status: ElearningNotificationDeliveryStatus
  duplicate: boolean
}

export type ElearningNotificationDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'retrying'
  | 'failed'
  | 'outcome_unknown'

function fail(code: ElearningNotificationDeliveryErrorCode): never {
  throw new ElearningNotificationDeliveryError(code)
}

function assertSupportedText(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0) fail('invalid_input')
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        fail('invalid_input')
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('invalid_input')
    }
  }
}

function requireText(value: unknown, max = 512): string {
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) fail('invalid_input')
  assertSupportedText(trimmed)
  return trimmed
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function normalizeTimestamp(value: unknown): string {
  if (
    !(value instanceof Date)
    && (typeof value !== 'string' || !CANONICAL_UTC_TIMESTAMP_RE.test(value))
  ) {
    fail('invalid_input')
  }
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) fail('invalid_input')
  const normalized = date.toISOString()
  if (
    !CANONICAL_UTC_TIMESTAMP_RE.test(normalized)
    || (typeof value === 'string' && value !== normalized)
  ) {
    fail('invalid_input')
  }
  return normalized
}

function compareCanonicalKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeJson(value: unknown, depth = 0): unknown {
  if (depth > 16) fail('invalid_input')
  if (value === null || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    assertSupportedText(value)
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_input')
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) fail('invalid_input')
    return Array.from({ length: value.length }, (_, index) => {
      if (!Object.prototype.hasOwnProperty.call(value, index)) fail('invalid_input')
      return normalizeJson(value[index], depth + 1)
    })
  }
  if (!value || typeof value !== 'object') fail('invalid_input')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail('invalid_input')
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 256) fail('invalid_input')
  for (const [key] of entries) assertSupportedText(key)
  return Object.fromEntries(
    entries
      .sort(([left], [right]) => compareCanonicalKeys(left, right))
      .map(([key, candidate]) => [key, normalizeJson(candidate, depth + 1)]),
  )
}

function serializeCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') {
    assertSupportedText(value)
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_input')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeCanonicalJson(item)).join(',')}]`
  }
  if (!value || typeof value !== 'object') fail('invalid_input')
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareCanonicalKeys(left, right))
  return `{${entries.map(([key, candidate]) => {
    assertSupportedText(key)
    return `${JSON.stringify(key)}:${serializeCanonicalJson(candidate)}`
  }).join(',')}}`
}

export function normalizeElearningNotificationPayload(
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_input')
  }
  const normalized = normalizeJson(value)
  const serialized = JSON.stringify(normalized)
  if (Buffer.byteLength(serialized, 'utf8') > ELEARNING_NOTIFICATION_PAYLOAD_MAX_BYTES) {
    fail('invalid_input')
  }
  return normalized as Record<string, unknown>
}

export function canonicalizeElearningNotificationRequest(input: {
  assignmentMemberId: string
  dueAt: string
  payload: Record<string, unknown>
  recipientUserId: string
}): string {
  return serializeCanonicalJson({
    assignmentMemberId: input.assignmentMemberId,
    channel: 'platform',
    domain: ELEARNING_NOTIFICATION_REQUEST_DOMAIN,
    dueAt: input.dueAt,
    kind: 'assignment_reminder',
    payload: normalizeJson(input.payload),
    recipientRole: 'learner',
    recipientUserId: input.recipientUserId,
    version: ELEARNING_NOTIFICATION_REQUEST_HASH_VERSION,
  })
}

export function hashElearningNotificationRequest(input: {
  assignmentMemberId: string
  dueAt: string
  payload: Record<string, unknown>
  recipientUserId: string
}): string {
  return createHash('sha256')
    .update(canonicalizeElearningNotificationRequest(input), 'utf8')
    .digest('hex')
}

export function elearningNotificationDeliveryLockKey(
  orgId: string,
  sourceKey: string,
): string {
  return JSON.stringify([orgId, sourceKey])
}

function storedText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function storedUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value)
    ? value.toLowerCase()
    : null
}

function storedSafeInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return Number(value)
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function storedStatus(value: unknown): ElearningNotificationDeliveryStatus | null {
  return value === 'pending'
    || value === 'sending'
    || value === 'sent'
    || value === 'retrying'
    || value === 'failed'
    || value === 'outcome_unknown'
    ? value
    : null
}

export async function enqueueElearningNotificationDelivery(
  db: ElearningNotificationDeliveryDb,
  input: EnqueueElearningNotificationDeliveryInput,
): Promise<EnqueueElearningNotificationDeliveryResult> {
  const orgId = requireText(input.orgId, 256)
  const assignmentMemberId = requireUuid(input.assignmentMemberId)
  const recipientUserId = requireText(input.recipientUserId, 256)
  const sourceKey = requireText(input.sourceKey)
  const dueAt = normalizeTimestamp(input.dueAt)
  const payload = normalizeElearningNotificationPayload(input.payload)
  const requestHash = hashElearningNotificationRequest({
    assignmentMemberId,
    dueAt,
    payload,
    recipientUserId,
  })

  try {
    return await db.transaction(async (tx) => {
      await tx.query(
        `/* elearning-notification-delivery:lock */
         SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [
          ELEARNING_NOTIFICATION_LOCK_NAMESPACE,
          elearningNotificationDeliveryLockKey(orgId, sourceKey),
        ],
      )

      const existing = await tx.query(
        `/* elearning-notification-delivery:load-existing */
         SELECT id, request_hash, request_hash_version, status
           FROM elearning_notification_deliveries
          WHERE org_id = $1 AND source_key = $2
          FOR UPDATE`,
        [orgId, sourceKey],
      )
      if (existing.rows[0]) {
        const row = existing.rows[0]
        const deliveryId = storedUuid(row.id)
        const status = storedStatus(row.status)
        if (!deliveryId || !status) fail('unavailable')
        if (
          storedText(row.request_hash) !== requestHash
          || storedSafeInt(row.request_hash_version)
            !== ELEARNING_NOTIFICATION_REQUEST_HASH_VERSION
        ) {
          fail('conflict')
        }
        return { deliveryId, status, duplicate: true }
      }

      const member = await tx.query(
        `/* elearning-notification-delivery:load-member */
         SELECT member.user_id,
                member.revoked_at,
                assignment.deadline,
                course.status AS course_status
           FROM elearning_assignment_members member
           JOIN elearning_assignments assignment
             ON assignment.org_id = member.org_id
            AND assignment.id = member.assignment_id
           JOIN elearning_course_versions course_version
             ON course_version.org_id = assignment.org_id
            AND course_version.id = assignment.course_version_id
           JOIN elearning_courses course
             ON course.org_id = course_version.org_id
            AND course.id = course_version.course_id
          WHERE member.org_id = $1 AND member.id = $2
          FOR SHARE OF member, assignment, course_version, course`,
        [orgId, assignmentMemberId],
      )
      const memberRow = member.rows[0]
      if (!memberRow) fail('not_found')
      const courseStatus = storedText(memberRow.course_status)
      if (
        storedText(memberRow.user_id) !== recipientUserId
        || memberRow.revoked_at != null
        || memberRow.deadline == null
        || (courseStatus !== 'active' && courseStatus !== 'archived')
      ) {
        fail('not_eligible')
      }

      const deliveryId = randomUUID()
      await tx.query(
        `/* elearning-notification-delivery:insert */
         INSERT INTO elearning_notification_deliveries (
           id,
           org_id,
           assignment_member_id,
           kind,
           source_key,
           request_hash,
           request_hash_version,
           recipient_role,
           recipient_user_id,
           channel,
           payload,
           due_at,
           next_attempt_at
         ) VALUES (
           $1, $2, $3, 'assignment_reminder', $4, $5, $6,
           'learner', $7, 'platform', $8::jsonb, $9::timestamptz, $9::timestamptz
         )`,
        [
          deliveryId,
          orgId,
          assignmentMemberId,
          sourceKey,
          requestHash,
          ELEARNING_NOTIFICATION_REQUEST_HASH_VERSION,
          recipientUserId,
          JSON.stringify(payload),
          dueAt,
        ],
      )

      return { deliveryId, status: 'pending' as const, duplicate: false }
    })
  } catch (error) {
    if (error instanceof ElearningNotificationDeliveryError) throw error
    fail('unavailable')
  }
}
