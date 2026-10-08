/**
 * Transactional L2 audience batch assignment.
 *
 * Rules are canonicalized before the transaction, then resolved once from
 * current same-org directory state. The resulting members are immutable
 * assignment facts; idempotent replays never resolve the audience again.
 */
import { createHash, randomUUID } from 'node:crypto'

import {
  ElearningAudienceResolverError,
  normalizeElearningAudienceRules,
  resolveElearningAudienceMembers,
  type ElearningAudienceQueryable,
  type ElearningAudienceRule,
} from './elearning-audience-resolver'
import { elearningDirectAssignmentLockKey } from './elearning-direct-assignment'

export const ELEARNING_BATCH_ASSIGNMENT_REQUEST_DOMAIN =
  'elearning.assignment.batch.request.v1' as const
export const ELEARNING_BATCH_ASSIGNMENT_REQUEST_HASH_VERSION = 1 as const
export const ELEARNING_BATCH_ASSIGNMENT_MEMBER_LIMIT = 10_000 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ElearningBatchAssignmentErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'course_unavailable'
  | 'subject_not_found'
  | 'unsupported_subject'
  | 'empty_audience'
  | 'audience_too_large'
  | 'conflict'
  | 'unavailable'

export class ElearningBatchAssignmentError extends Error {
  constructor(readonly code: ElearningBatchAssignmentErrorCode) {
    super(code)
    this.name = 'ElearningBatchAssignmentError'
  }
}

export interface ElearningBatchAssignmentQueryable extends ElearningAudienceQueryable {}

export interface ElearningBatchAssignmentDb extends ElearningBatchAssignmentQueryable {
  transaction<T>(handler: (tx: ElearningBatchAssignmentQueryable) => Promise<T>): Promise<T>
}

export interface AssignElearningBatchInput {
  orgId: string
  actorId: string
  courseVersionId: string
  sourceKey: string
  deadline?: string | Date | null
  rules: unknown
}

export interface ElearningBatchAssignmentResult {
  assignmentId: string
  memberCount: number
  duplicate: boolean
}

function fail(code: ElearningBatchAssignmentErrorCode): never {
  throw new ElearningBatchAssignmentError(code)
}

function requireText(value: unknown): string {
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

function canonicalize(value: unknown): string {
  const walk = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(walk)
    if (candidate && typeof candidate === 'object') {
      return Object.fromEntries(
        Object.keys(candidate as Record<string, unknown>)
          .sort()
          .map((key) => [key, walk((candidate as Record<string, unknown>)[key])]),
      )
    }
    return candidate
  }
  return JSON.stringify(walk(value ?? null))
}

function ruleKey(rule: ElearningAudienceRule): string {
  return `${rule.subjectType}:${rule.subjectRef ?? ''}:${rule.includeChildren ? '1' : '0'}`
}

export function normalizeElearningBatchAssignmentRules(rules: unknown): ElearningAudienceRule[] {
  if (!Array.isArray(rules) || rules.length > 100) fail('invalid_input')
  const deduplicated = new Map<string, ElearningAudienceRule>()
  for (const raw of rules) {
    const normalized = normalizeElearningAudienceRules([raw])[0]
    deduplicated.set(ruleKey(normalized), normalized)
  }
  return [...deduplicated.values()].sort((left, right) => {
    const leftKey = ruleKey(left)
    const rightKey = ruleKey(right)
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}

export function canonicalizeElearningBatchAssignmentRequest(input: {
  courseVersionId: string
  deadline: string | null
  rules: ElearningAudienceRule[]
}): string {
  return canonicalize({
    courseVersionId: input.courseVersionId,
    deadline: input.deadline,
    domain: ELEARNING_BATCH_ASSIGNMENT_REQUEST_DOMAIN,
    rules: input.rules,
    version: ELEARNING_BATCH_ASSIGNMENT_REQUEST_HASH_VERSION,
  })
}

export function hashElearningBatchAssignmentRequest(input: {
  courseVersionId: string
  deadline: string | null
  rules: ElearningAudienceRule[]
}): string {
  return createHash('sha256')
    .update(canonicalizeElearningBatchAssignmentRequest(input), 'utf8')
    .digest('hex')
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asSafeInt(value: unknown): number | null {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return Number(value)
  }
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function mapAudienceError(error: ElearningAudienceResolverError): never {
  if (error.code === 'invalid_input') fail('invalid_input')
  if (error.code === 'subject_not_found') fail('subject_not_found')
  if (error.code === 'unsupported_subject') fail('unsupported_subject')
  fail('unavailable')
}

function snapshotMatches(value: unknown, rules: ElearningAudienceRule[]): boolean {
  return Array.isArray(value) && canonicalize(value) === canonicalize(rules)
}

export async function assignElearningBatch(
  db: ElearningBatchAssignmentDb,
  input: AssignElearningBatchInput,
): Promise<ElearningBatchAssignmentResult> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  const courseVersionId = requireUuid(input.courseVersionId)
  const sourceKey = requireText(input.sourceKey)
  const deadline = normalizeDeadline(input.deadline)

  let rules: ElearningAudienceRule[]
  try {
    rules = normalizeElearningBatchAssignmentRules(input.rules)
  } catch (error) {
    if (error instanceof ElearningAudienceResolverError) mapAudienceError(error)
    if (error instanceof ElearningBatchAssignmentError) throw error
    fail('unavailable')
  }

  const requestHash = hashElearningBatchAssignmentRequest({
    courseVersionId,
    deadline,
    rules,
  })

  return db.transaction(async (tx) => {
    try {
      await tx.query(
        `/* elearning-batch-assign:lock */
         SELECT pg_advisory_xact_lock(hashtext($1))`,
        [elearningDirectAssignmentLockKey(orgId, sourceKey)],
      )

      const existing = await tx.query(
        `/* elearning-batch-assign:load-existing */
         SELECT id, request_hash, request_hash_version, target_snapshot
           FROM elearning_assignments
          WHERE org_id = $1 AND source_key = $2
          FOR UPDATE`,
        [orgId, sourceKey],
      )
      const existingRow = existing.rows[0]
      if (existingRow) {
        const assignmentId = asText(existingRow.id)
        if (
          !assignmentId
          || asText(existingRow.request_hash) !== requestHash
          || asSafeInt(existingRow.request_hash_version)
            !== ELEARNING_BATCH_ASSIGNMENT_REQUEST_HASH_VERSION
        ) {
          fail('conflict')
        }
        if (!snapshotMatches(existingRow.target_snapshot, rules)) fail('unavailable')
        const count = await tx.query(
          `/* elearning-batch-assign:count-members */
           SELECT count(*)::text AS member_count
             FROM elearning_assignment_members
            WHERE org_id = $1
              AND assignment_id = $2
              AND course_version_id = $3
              AND source = 'rule'`,
          [orgId, assignmentId, courseVersionId],
        )
        const memberCount = asSafeInt(count.rows[0]?.member_count)
        if (
          memberCount === null
          || memberCount < 1
          || memberCount > ELEARNING_BATCH_ASSIGNMENT_MEMBER_LIMIT
        ) {
          fail('unavailable')
        }
        return { assignmentId, memberCount, duplicate: true }
      }

      const course = await tx.query(
        `/* elearning-batch-assign:lock-course */
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
      if (
        asText(courseRow.course_status) !== 'active'
        || asText(courseRow.version_status) !== 'published'
      ) {
        fail('course_unavailable')
      }

      let members: string[]
      try {
        members = await resolveElearningAudienceMembers(tx, {
          orgId,
          rules,
          maxMembers: ELEARNING_BATCH_ASSIGNMENT_MEMBER_LIMIT + 1,
        })
      } catch (error) {
        if (error instanceof ElearningAudienceResolverError) mapAudienceError(error)
        throw error
      }
      if (members.length === 0) fail('empty_audience')
      if (members.length > ELEARNING_BATCH_ASSIGNMENT_MEMBER_LIMIT) {
        fail('audience_too_large')
      }

      const lockedMembers = await tx.query(
        `/* elearning-batch-assign:lock-members */
         SELECT platform_user.id
           FROM users platform_user
           JOIN user_orgs membership
             ON membership.user_id = platform_user.id
            AND membership.org_id = $1
            AND membership.is_active = TRUE
          WHERE platform_user.id = ANY($2::text[])
            AND platform_user.is_active = TRUE
          ORDER BY platform_user.id ASC
          FOR SHARE OF platform_user, membership`,
        [orgId, members],
      )
      const lockedIds = lockedMembers.rows.map((row) => asText(row.id))
      const expectedMemberIds = new Set(members)
      if (
        lockedIds.length !== members.length
        || lockedIds.some((userId) => userId === null || !expectedMemberIds.has(userId))
      ) {
        fail('unavailable')
      }

      const assignmentId = randomUUID()
      await tx.query(
        `/* elearning-batch-assign:insert-assignment */
         INSERT INTO elearning_assignments (
           id, org_id, course_version_id, source_key, request_hash, request_hash_version,
           deadline, assigned_by, target_snapshot
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          assignmentId,
          orgId,
          courseVersionId,
          sourceKey,
          requestHash,
          ELEARNING_BATCH_ASSIGNMENT_REQUEST_HASH_VERSION,
          deadline,
          actorId,
          JSON.stringify(rules),
        ],
      )
      const inserted = await tx.query(
        `/* elearning-batch-assign:insert-members */
         INSERT INTO elearning_assignment_members (
           id, org_id, assignment_id, course_version_id, user_id, source
         )
         SELECT gen_random_uuid(), $1, $2, $3, audience.user_id, 'rule'
           FROM unnest($4::text[]) AS audience(user_id)
          ORDER BY audience.user_id ASC`,
        [orgId, assignmentId, courseVersionId, members],
      )
      if (inserted.rowCount !== members.length) fail('unavailable')
      return { assignmentId, memberCount: members.length, duplicate: false }
    } catch (error) {
      if (error instanceof ElearningBatchAssignmentError) throw error
      fail('unavailable')
    }
  })
}
