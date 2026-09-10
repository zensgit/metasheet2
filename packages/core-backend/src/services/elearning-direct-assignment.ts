/**
 * Transactional V0.1 manual direct assignment (named pilot).
 * Visibility is not assignment. Valid assignment means an unrevoked member.
 * Deadline expiry does not revoke. Org is caller-supplied. Errors are values-free.
 */
import { createHash, randomUUID } from 'node:crypto'

export const ELEARNING_ASSIGNMENT_REQUEST_DOMAIN = 'elearning.assignment.request.v1' as const
export const ELEARNING_ASSIGNMENT_REQUEST_HASH_VERSION = 1 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ElearningDirectAssignmentErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'target_unavailable'
  | 'course_unavailable'
  | 'conflict'
  | 'unavailable'

export class ElearningDirectAssignmentError extends Error {
  constructor(readonly code: ElearningDirectAssignmentErrorCode) {
    super(code)
    this.name = 'ElearningDirectAssignmentError'
  }
}

export interface ElearningDirectAssignmentQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningDirectAssignmentDb extends ElearningDirectAssignmentQueryable {
  transaction<T>(handler: (tx: ElearningDirectAssignmentQueryable) => Promise<T>): Promise<T>
}

export interface AssignElearningDirectInput {
  orgId: string
  actorId: string
  targetUserId: string
  courseVersionId: string
  sourceKey: string
  deadline?: string | Date | null
}

export interface ElearningDirectAssignmentResult {
  assignmentId: string
  memberId: string
  duplicate: boolean
}

export function elearningDirectAssignmentLockKey(orgId: string, sourceKey: string): string {
  return `elearning-assign:${orgId}:${sourceKey}`
}

function canonicalize(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, walk((v as Record<string, unknown>)[k])]),
      )
    }
    return v
  }
  return JSON.stringify(walk(value ?? null))
}

export function canonicalizeElearningAssignmentRequest(input: {
  courseVersionId: string
  deadline: string | null
  targetUserId: string
}): string {
  return canonicalize({
    courseVersionId: input.courseVersionId,
    deadline: input.deadline,
    domain: ELEARNING_ASSIGNMENT_REQUEST_DOMAIN,
    targetUserId: input.targetUserId,
    version: ELEARNING_ASSIGNMENT_REQUEST_HASH_VERSION,
  })
}

export function hashElearningAssignmentRequest(input: {
  courseVersionId: string
  deadline: string | null
  targetUserId: string
}): string {
  return createHash('sha256')
    .update(canonicalizeElearningAssignmentRequest(input), 'utf8')
    .digest('hex')
}

function fail(code: ElearningDirectAssignmentErrorCode): never {
  throw new ElearningDirectAssignmentError(code)
}

function requireActor(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed === '') fail('invalid_input')
  return trimmed
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function normalizeDeadline(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail('invalid_input')
    return value.toISOString()
  }
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed === '') fail('invalid_input')
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) fail('invalid_input')
  return parsed.toISOString()
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value
}

function asSafeInt(value: unknown): number | null {
  if (typeof value === 'bigint') {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return Number(value)
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null
    return value
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^-?\d+$/.test(text)) return null
    const parsed = Number(text)
    if (!Number.isSafeInteger(parsed)) return null
    return parsed
  }
  return null
}

export async function assignElearningDirect(
  db: ElearningDirectAssignmentDb,
  input: AssignElearningDirectInput,
): Promise<ElearningDirectAssignmentResult> {
  const orgId = requireActor(input.orgId)
  const actorId = requireActor(input.actorId)
  const targetUserId = requireActor(input.targetUserId)
  const sourceKey = requireActor(input.sourceKey)
  const courseVersionId = requireUuid(input.courseVersionId)
  const deadline = normalizeDeadline(input.deadline)
  const requestHash = hashElearningAssignmentRequest({
    courseVersionId,
    deadline,
    targetUserId,
  })

  return db.transaction(async (tx) => {
    try {
      await tx.query(
        `/* elearning-assign:lock */
         SELECT pg_advisory_xact_lock(hashtext($1))`,
        [elearningDirectAssignmentLockKey(orgId, sourceKey)],
      )

      const existing = await tx.query(
        `/* elearning-assign:load-existing */
         SELECT id, request_hash, request_hash_version
           FROM elearning_assignments
          WHERE org_id = $1 AND source_key = $2
          FOR UPDATE`,
        [orgId, sourceKey],
      )
      const existingRow = existing.rows[0]
      if (existingRow) {
        const existingId = asText(existingRow.id)
        const existingHash = asText(existingRow.request_hash)
        if (!existingId || !existingHash) fail('unavailable')
        if (
          existingHash !== requestHash
          || asSafeInt(existingRow.request_hash_version) !== ELEARNING_ASSIGNMENT_REQUEST_HASH_VERSION
        ) {
          fail('conflict')
        }
        const member = await tx.query(
          `/* elearning-assign:load-member */
           SELECT id
             FROM elearning_assignment_members
            WHERE org_id = $1
              AND assignment_id = $2
              AND course_version_id = $3
              AND user_id = $4
              AND source = 'manual'
            LIMIT 1`,
          [orgId, existingId, courseVersionId, targetUserId],
        )
        const memberId = asText(member.rows[0]?.id)
        if (!memberId) fail('unavailable')
        return { assignmentId: existingId, memberId, duplicate: true }
      }

      const course = await tx.query(
        `/* elearning-assign:lock-course */
         SELECT v.status AS version_status, c.status AS course_status
           FROM elearning_course_versions v
           JOIN elearning_courses c
             ON c.org_id = v.org_id AND c.id = v.course_id
          WHERE v.org_id = $1 AND v.id = $2
          FOR SHARE OF c, v`,
        [orgId, courseVersionId],
      )
      const courseRow = course.rows[0]
      if (!courseRow) fail('not_found')
      if (asText(courseRow.course_status) !== 'active') fail('course_unavailable')
      if (asText(courseRow.version_status) !== 'published') fail('course_unavailable')

      const membership = await tx.query(
        `/* elearning-assign:load-membership */
         SELECT 1 AS ok
           FROM user_orgs uo
           JOIN users u ON u.id = uo.user_id
          WHERE uo.user_id = $1
            AND uo.org_id = $2
            AND uo.is_active = true
            AND u.is_active = true
          FOR SHARE OF u, uo`,
        [targetUserId, orgId],
      )
      if (!membership.rows[0]) fail('target_unavailable')

      const assignmentId = randomUUID()
      const memberId = randomUUID()
      await tx.query(
        `/* elearning-assign:insert-assignment */
         INSERT INTO elearning_assignments (
           id, org_id, course_version_id, source_key, request_hash, request_hash_version,
           deadline, assigned_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          assignmentId,
          orgId,
          courseVersionId,
          sourceKey,
          requestHash,
          ELEARNING_ASSIGNMENT_REQUEST_HASH_VERSION,
          deadline,
          actorId,
        ],
      )
      await tx.query(
        `/* elearning-assign:insert-member */
         INSERT INTO elearning_assignment_members (
           id, org_id, assignment_id, course_version_id, user_id, source
         ) VALUES ($1, $2, $3, $4, $5, 'manual')`,
        [memberId, orgId, assignmentId, courseVersionId, targetUserId],
      )
      return { assignmentId, memberId, duplicate: false }
    } catch (error) {
      if (error instanceof ElearningDirectAssignmentError) throw error
      fail('unavailable')
    }
  })
}
