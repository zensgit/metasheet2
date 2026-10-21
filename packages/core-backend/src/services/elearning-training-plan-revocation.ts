/**
 * Atomic termination of every obligation created by one training-plan run.
 *
 * A plan assignment owns one frozen cohort across all child assignments. The
 * group revocation triplet is written first, every child member is revoked in
 * the same transaction, and a deferred database trigger refuses partial work.
 */
import { ELEARNING_REVOCATION_REASON_MAX } from './elearning-assignment-lifecycle'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ElearningTrainingPlanRevocationErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'unavailable'

export class ElearningTrainingPlanRevocationError extends Error {
  constructor(readonly code: ElearningTrainingPlanRevocationErrorCode) {
    super(code)
    this.name = 'ElearningTrainingPlanRevocationError'
  }
}

export interface ElearningTrainingPlanRevocationQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningTrainingPlanRevocationDb
  extends ElearningTrainingPlanRevocationQueryable {
  transaction<T>(
    handler: (tx: ElearningTrainingPlanRevocationQueryable) => Promise<T>,
  ): Promise<T>
}

export interface RevokeElearningTrainingPlanAssignmentInput {
  orgId: string
  actorId: string
  planAssignmentId: string
  reason: string
}

export interface ElearningTrainingPlanRevocationResult {
  planAssignmentId: string
  revoked: true
  revokedMemberCount: number
  duplicate: boolean
}

function fail(code: ElearningTrainingPlanRevocationErrorCode): never {
  throw new ElearningTrainingPlanRevocationError(code)
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

function requireReason(value: unknown): string {
  const reason = requireText(value)
  if (reason.length > ELEARNING_REVOCATION_REASON_MAX) fail('invalid_input')
  return reason
}

function storedText(value: unknown): string {
  if (typeof value !== 'string' || value === '') fail('unavailable')
  return value
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

function expectedMemberFacts(row: Record<string, unknown>): number {
  const courseCount = asSafeCount(row.course_count)
  const memberCount = asSafeCount(row.member_count)
  if (courseCount < 1 || courseCount > 100 || memberCount < 1 || memberCount > 10_000) {
    fail('unavailable')
  }
  const total = courseCount * memberCount
  if (!Number.isSafeInteger(total) || total < 1 || total > 1_000_000) fail('unavailable')
  return total
}

export function elearningTrainingPlanRevocationLockKey(
  orgId: string,
  planAssignmentId: string,
): string {
  return `elearning-training-plan-revoke:${orgId}:${planAssignmentId}`
}

export async function revokeElearningTrainingPlanAssignment(
  db: ElearningTrainingPlanRevocationDb,
  input: RevokeElearningTrainingPlanAssignmentInput,
): Promise<ElearningTrainingPlanRevocationResult> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  const planAssignmentId = requireUuid(input.planAssignmentId)
  const reason = requireReason(input.reason)

  return db.transaction(async (tx) => {
    try {
      await tx.query(
        `/* elearning-training-plan-revoke:lock */
         SELECT pg_advisory_xact_lock(hashtext($1))`,
        [elearningTrainingPlanRevocationLockKey(orgId, planAssignmentId)],
      )
      const loaded = await tx.query(
        `/* elearning-training-plan-revoke:load */
         SELECT id, course_count, member_count, revoked_at, revocation_reason
         FROM elearning_training_plan_assignments
         WHERE org_id = $1 AND id = $2
         FOR UPDATE`,
        [orgId, planAssignmentId],
      )
      const row = loaded.rows[0]
      if (!row) fail('not_found')
      const revokedMemberCount = expectedMemberFacts(row)
      if (row.revoked_at != null) {
        if (storedText(row.revocation_reason) !== reason) fail('conflict')
        return {
          planAssignmentId,
          revoked: true,
          revokedMemberCount,
          duplicate: true,
        }
      }

      const revokedGroup = await tx.query(
        `/* elearning-training-plan-revoke:group */
         UPDATE elearning_training_plan_assignments
         SET revoked_at = now(), revoked_by = $3, revocation_reason = $4
         WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL
         RETURNING id`,
        [orgId, planAssignmentId, actorId, reason],
      )
      if (revokedGroup.rowCount !== 1) fail('unavailable')

      const revokedMembers = await tx.query(
        `/* elearning-training-plan-revoke:members */
         WITH revoked AS (
           UPDATE elearning_assignment_members member
           SET
             revoked_at = plan_assignment.revoked_at,
             revoked_by = plan_assignment.revoked_by,
             revocation_reason = plan_assignment.revocation_reason
           FROM elearning_training_plan_assignment_items link,
                elearning_training_plan_assignments plan_assignment
           WHERE plan_assignment.org_id = $1
             AND plan_assignment.id = $2
             AND link.org_id = plan_assignment.org_id
             AND link.training_plan_assignment_id = plan_assignment.id
             AND member.org_id = link.org_id
             AND member.assignment_id = link.assignment_id
             AND member.revoked_at IS NULL
           RETURNING member.id
         )
         SELECT count(*)::bigint AS revoked_count FROM revoked`,
        [orgId, planAssignmentId],
      )
      if (asSafeCount(revokedMembers.rows[0]?.revoked_count) !== revokedMemberCount) {
        fail('unavailable')
      }

      return {
        planAssignmentId,
        revoked: true,
        revokedMemberCount,
        duplicate: false,
      }
    } catch (error) {
      if (error instanceof ElearningTrainingPlanRevocationError) throw error
      fail('unavailable')
    }
  })
}
