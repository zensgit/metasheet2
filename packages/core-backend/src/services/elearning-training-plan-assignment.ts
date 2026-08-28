/**
 * Transactional L2 training-plan assignment.
 *
 * The audience is resolved exactly once. One immutable assignment is then
 * created for every item in the pinned published plan version, with the same
 * member set and deadline. Same-key replays read the frozen group and never
 * consult current directory state.
 */
import { createHash, randomUUID } from 'node:crypto'

import {
  ElearningAudienceResolverError,
  resolveElearningAudienceMembers,
  type ElearningAudienceQueryable,
  type ElearningAudienceRule,
} from './elearning-audience-resolver'
import {
  ELEARNING_BATCH_ASSIGNMENT_MEMBER_LIMIT,
  normalizeElearningBatchAssignmentRules,
} from './elearning-batch-assignment'

export const ELEARNING_TRAINING_PLAN_ASSIGNMENT_REQUEST_DOMAIN =
  'elearning.training-plan.assignment.request.v1' as const
export const ELEARNING_TRAINING_PLAN_ASSIGNMENT_CHILD_DOMAIN =
  'elearning.training-plan.assignment.child.v1' as const
export const ELEARNING_TRAINING_PLAN_ASSIGNMENT_HASH_VERSION = 1 as const
export const ELEARNING_TRAINING_PLAN_ASSIGNMENT_COURSE_LIMIT = 100 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ElearningTrainingPlanAssignmentErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'plan_unavailable'
  | 'course_unavailable'
  | 'subject_not_found'
  | 'unsupported_subject'
  | 'empty_audience'
  | 'audience_too_large'
  | 'conflict'
  | 'unavailable'

export class ElearningTrainingPlanAssignmentError extends Error {
  constructor(readonly code: ElearningTrainingPlanAssignmentErrorCode) {
    super(code)
    this.name = 'ElearningTrainingPlanAssignmentError'
  }
}

export interface ElearningTrainingPlanAssignmentQueryable
  extends ElearningAudienceQueryable {}

export interface ElearningTrainingPlanAssignmentDb
  extends ElearningTrainingPlanAssignmentQueryable {
  transaction<T>(
    handler: (tx: ElearningTrainingPlanAssignmentQueryable) => Promise<T>,
  ): Promise<T>
}

export interface AssignElearningTrainingPlanInput {
  orgId: string
  actorId: string
  planId: string
  sourceKey: string
  deadline?: string | Date | null
  rules: unknown
}

export interface ElearningTrainingPlanAssignmentResult {
  planAssignmentId: string
  planVersionId: string
  assignmentCount: number
  memberCount: number
  duplicate: boolean
}

interface CanonicalPlanAssignmentRequest {
  planId: string
  deadline: string | null
  rules: ElearningAudienceRule[]
}

interface LockedPlanItem {
  itemId: string
  courseVersionId: string
}

function fail(code: ElearningTrainingPlanAssignmentErrorCode): never {
  throw new ElearningTrainingPlanAssignmentError(code)
}

function requireText(value: unknown, max = 512): string {
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) fail('invalid_input')
  return trimmed
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function storedText(value: unknown): string {
  if (typeof value !== 'string' || value === '') fail('unavailable')
  return value
}

function storedUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('unavailable')
  return value.toLowerCase()
}

function asSafeCount(value: unknown): number {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail('unavailable')
    return Number(value)
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail('unavailable')
    return value
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) fail('unavailable')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) fail('unavailable')
  return parsed
}

function normalizeDeadline(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail('invalid_input')
    return value.toISOString()
  }
  if (typeof value !== 'string' || value.trim() === '') fail('invalid_input')
  const parsed = new Date(value.trim())
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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function canonicalizeElearningTrainingPlanAssignmentRequest(
  input: CanonicalPlanAssignmentRequest,
): string {
  return canonicalize({
    deadline: input.deadline,
    domain: ELEARNING_TRAINING_PLAN_ASSIGNMENT_REQUEST_DOMAIN,
    planId: input.planId,
    rules: input.rules,
    version: ELEARNING_TRAINING_PLAN_ASSIGNMENT_HASH_VERSION,
  })
}

export function hashElearningTrainingPlanAssignmentRequest(
  input: CanonicalPlanAssignmentRequest,
): string {
  return sha256(canonicalizeElearningTrainingPlanAssignmentRequest(input))
}

export function deriveElearningTrainingPlanChildSourceKey(input: {
  orgId: string
  parentSourceKey: string
  planVersionId: string
  planItemId: string
}): string {
  const digest = sha256(canonicalize({
    domain: ELEARNING_TRAINING_PLAN_ASSIGNMENT_CHILD_DOMAIN,
    orgId: input.orgId,
    parentSourceKey: input.parentSourceKey,
    planItemId: input.planItemId,
    planVersionId: input.planVersionId,
    version: 1,
  }))
  return `elearning-plan-item-v1:${digest}`
}

export function hashElearningTrainingPlanChildRequest(input: {
  parentSourceKey: string
  planVersionId: string
  planItemId: string
  courseVersionId: string
  deadline: string | null
  rules: ElearningAudienceRule[]
}): string {
  return sha256(canonicalize({
    courseVersionId: input.courseVersionId,
    deadline: input.deadline,
    domain: ELEARNING_TRAINING_PLAN_ASSIGNMENT_CHILD_DOMAIN,
    parentSourceKey: input.parentSourceKey,
    planItemId: input.planItemId,
    planVersionId: input.planVersionId,
    rules: input.rules,
    version: 1,
  }))
}

export function elearningTrainingPlanAssignmentLockKey(
  orgId: string,
  sourceKey: string,
): string {
  return `elearning-training-plan-assignment:${orgId}:${sourceKey}`
}

function snapshotMatches(value: unknown, rules: ElearningAudienceRule[]): boolean {
  return Array.isArray(value) && canonicalize(value) === canonicalize(rules)
}

function mapAudienceError(error: ElearningAudienceResolverError): never {
  if (error.code === 'invalid_input') fail('invalid_input')
  if (error.code === 'subject_not_found') fail('subject_not_found')
  if (error.code === 'unsupported_subject') fail('unsupported_subject')
  fail('unavailable')
}

function replayResult(
  row: Record<string, unknown>,
  requestHash: string,
  rules: ElearningAudienceRule[],
): ElearningTrainingPlanAssignmentResult {
  if (
    storedText(row.request_hash) !== requestHash
    || asSafeCount(row.request_hash_version)
      !== ELEARNING_TRAINING_PLAN_ASSIGNMENT_HASH_VERSION
  ) {
    fail('conflict')
  }
  if (!snapshotMatches(row.target_snapshot, rules)) fail('unavailable')
  const assignmentCount = asSafeCount(row.course_count)
  const memberCount = asSafeCount(row.member_count)
  if (
    assignmentCount < 1
    || assignmentCount > ELEARNING_TRAINING_PLAN_ASSIGNMENT_COURSE_LIMIT
    || memberCount < 1
    || memberCount > ELEARNING_BATCH_ASSIGNMENT_MEMBER_LIMIT
  ) {
    fail('unavailable')
  }
  return {
    planAssignmentId: storedUuid(row.id),
    planVersionId: storedUuid(row.training_plan_version_id),
    assignmentCount,
    memberCount,
    duplicate: true,
  }
}

function parsePlanItems(
  rows: Array<Record<string, unknown>>,
): LockedPlanItem[] {
  if (
    rows.length < 1
    || rows.length > ELEARNING_TRAINING_PLAN_ASSIGNMENT_COURSE_LIMIT
  ) {
    fail('unavailable')
  }
  return rows.map((row, index) => {
    if (asSafeCount(row.position) !== index + 1) fail('unavailable')
    if (
      storedText(row.course_status) !== 'active'
      || storedText(row.version_status) !== 'published'
    ) {
      fail('course_unavailable')
    }
    return {
      itemId: storedUuid(row.item_id),
      courseVersionId: storedUuid(row.course_version_id),
    }
  })
}

export async function assignElearningTrainingPlan(
  db: ElearningTrainingPlanAssignmentDb,
  input: AssignElearningTrainingPlanInput,
): Promise<ElearningTrainingPlanAssignmentResult> {
  const orgId = requireText(input.orgId, 256)
  const actorId = requireText(input.actorId, 256)
  const planId = requireUuid(input.planId)
  const sourceKey = requireText(input.sourceKey)
  const deadline = normalizeDeadline(input.deadline)

  let rules: ElearningAudienceRule[]
  try {
    rules = normalizeElearningBatchAssignmentRules(input.rules)
  } catch (error) {
    if (error instanceof ElearningAudienceResolverError) mapAudienceError(error)
    if (error instanceof ElearningTrainingPlanAssignmentError) throw error
    fail('invalid_input')
  }

  const requestHash = hashElearningTrainingPlanAssignmentRequest({
    planId,
    deadline,
    rules,
  })

  return db.transaction(async (tx) => {
    try {
      await tx.query(
        `/* elearning-training-plan-assign:lock */
         SELECT pg_advisory_xact_lock(hashtext($1))`,
        [elearningTrainingPlanAssignmentLockKey(orgId, sourceKey)],
      )

      const existing = await tx.query(
        `/* elearning-training-plan-assign:load-existing */
         SELECT
           id,
           training_plan_version_id,
           request_hash,
           request_hash_version,
           target_snapshot,
           course_count,
           member_count
         FROM elearning_training_plan_assignments
         WHERE org_id = $1 AND source_key = $2
         FOR UPDATE`,
        [orgId, sourceKey],
      )
      if (existing.rows[0]) {
        return replayResult(existing.rows[0], requestHash, rules)
      }

      const plan = await tx.query(
        `/* elearning-training-plan-assign:lock-plan */
         SELECT status, active_version_id
         FROM elearning_training_plans
         WHERE org_id = $1 AND id = $2
         FOR SHARE`,
        [orgId, planId],
      )
      const planRow = plan.rows[0]
      if (!planRow) fail('not_found')
      if (storedText(planRow.status) !== 'active') fail('plan_unavailable')
      const planVersionId = storedUuid(planRow.active_version_id)

      const planVersion = await tx.query(
        `/* elearning-training-plan-assign:lock-plan-version */
         SELECT status
         FROM elearning_training_plan_versions
         WHERE org_id = $1
           AND training_plan_id = $2
           AND id = $3
         FOR SHARE`,
        [orgId, planId, planVersionId],
      )
      if (storedText(planVersion.rows[0]?.status) !== 'published') {
        fail('plan_unavailable')
      }

      const itemRows = await tx.query(
        `/* elearning-training-plan-assign:lock-items */
         SELECT
           item.id AS item_id,
           item.course_version_id,
           item.position,
           course.status AS course_status,
           course_version.status AS version_status
         FROM elearning_training_plan_items item
         JOIN elearning_course_versions course_version
           ON course_version.org_id = item.org_id
          AND course_version.id = item.course_version_id
         JOIN elearning_courses course
           ON course.org_id = course_version.org_id
          AND course.id = course_version.course_id
         WHERE item.org_id = $1
           AND item.training_plan_version_id = $2
         ORDER BY item.position ASC
         FOR SHARE OF item, course_version, course`,
        [orgId, planVersionId],
      )
      const items = parsePlanItems(itemRows.rows)

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
        `/* elearning-training-plan-assign:lock-members */
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
      const lockedIds = lockedMembers.rows.map((row) => storedText(row.id))
      if (
        lockedIds.length !== members.length
        || lockedIds.some((memberId, index) => memberId !== members[index])
      ) {
        fail('unavailable')
      }

      const planAssignmentId = randomUUID()
      await tx.query(
        `/* elearning-training-plan-assign:insert-group */
         INSERT INTO elearning_training_plan_assignments (
           id,
           org_id,
           training_plan_id,
           training_plan_version_id,
           source_key,
           request_hash,
           request_hash_version,
           deadline,
           assigned_by,
           target_snapshot,
           member_ids,
           course_count,
           member_count
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::text[], $12, $13
         )`,
        [
          planAssignmentId,
          orgId,
          planId,
          planVersionId,
          sourceKey,
          requestHash,
          ELEARNING_TRAINING_PLAN_ASSIGNMENT_HASH_VERSION,
          deadline,
          actorId,
          JSON.stringify(rules),
          members,
          items.length,
          members.length,
        ],
      )

      for (const item of items) {
        const assignmentId = randomUUID()
        const childSourceKey = deriveElearningTrainingPlanChildSourceKey({
          orgId,
          parentSourceKey: sourceKey,
          planVersionId,
          planItemId: item.itemId,
        })
        const childRequestHash = hashElearningTrainingPlanChildRequest({
          parentSourceKey: sourceKey,
          planVersionId,
          planItemId: item.itemId,
          courseVersionId: item.courseVersionId,
          deadline,
          rules,
        })
        await tx.query(
          `/* elearning-training-plan-assign:insert-assignment */
           INSERT INTO elearning_assignments (
             id,
             org_id,
             course_version_id,
             source_key,
             request_hash,
             request_hash_version,
             deadline,
             assigned_by,
             target_snapshot
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [
            assignmentId,
            orgId,
            item.courseVersionId,
            childSourceKey,
            childRequestHash,
            ELEARNING_TRAINING_PLAN_ASSIGNMENT_HASH_VERSION,
            deadline,
            actorId,
            JSON.stringify(rules),
          ],
        )
        const insertedMembers = await tx.query(
          `/* elearning-training-plan-assign:insert-members */
           INSERT INTO elearning_assignment_members (
             id, org_id, assignment_id, course_version_id, user_id, source
           )
           SELECT gen_random_uuid(), $1, $2, $3, member.user_id, 'rule'
           FROM unnest($4::text[]) AS member(user_id)
           ORDER BY member.user_id ASC`,
          [orgId, assignmentId, item.courseVersionId, members],
        )
        if (insertedMembers.rowCount !== members.length) fail('unavailable')
        await tx.query(
          `/* elearning-training-plan-assign:insert-link */
           INSERT INTO elearning_training_plan_assignment_items (
             id,
             org_id,
             training_plan_assignment_id,
             training_plan_version_id,
             training_plan_item_id,
             course_version_id,
             assignment_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            randomUUID(),
            orgId,
            planAssignmentId,
            planVersionId,
            item.itemId,
            item.courseVersionId,
            assignmentId,
          ],
        )
      }

      return {
        planAssignmentId,
        planVersionId,
        assignmentCount: items.length,
        memberCount: members.length,
        duplicate: false,
      }
    } catch (error) {
      if (error instanceof ElearningTrainingPlanAssignmentError) throw error
      fail('unavailable')
    }
  })
}

/**
 * Execute on a transaction already owned by the caller.
 *
 * This is intentionally a thin entry point over the canonical writer: the
 * caller can lock additional eligibility facts first, while assignment
 * validation, advisory locking, idempotency, and inserts stay byte-for-byte in
 * the same implementation. The supplied queryable must be bound to the active
 * transaction; this function never commits or rolls it back.
 */
export async function assignElearningTrainingPlanInTransaction(
  tx: ElearningTrainingPlanAssignmentQueryable,
  input: AssignElearningTrainingPlanInput,
): Promise<ElearningTrainingPlanAssignmentResult> {
  return assignElearningTrainingPlan(
    {
      query: (sql, params) => tx.query(sql, params),
      transaction: async (handler) => handler(tx),
    },
    input,
  )
}
