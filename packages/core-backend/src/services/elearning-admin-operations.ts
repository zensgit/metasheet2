/**
 * Transactional authorization wrappers for delegated e-learning operations.
 *
 * Domain services remain focused on their state transitions. These wrappers
 * bind RBAC-derived global-admin context, object ACL, and management scope to
 * the same transaction as the protected read or write.
 */
import {
  assignElearningBatch,
  ElearningBatchAssignmentError,
  normalizeElearningBatchAssignmentRules,
  type AssignElearningBatchInput,
  type ElearningBatchAssignmentDb,
  type ElearningBatchAssignmentResult,
} from './elearning-batch-assignment'
import {
  assignElearningDirect,
  ElearningDirectAssignmentError,
  type AssignElearningDirectInput,
  type ElearningDirectAssignmentDb,
  type ElearningDirectAssignmentResult,
} from './elearning-direct-assignment'
import {
  listElearningAssignmentProgress,
  revokeElearningAssignmentMember,
  ElearningAssignmentLifecycleError,
  type ElearningAssignmentLifecycleDb,
  type ElearningAssignmentProgressResult,
  type ElearningAssignmentRevocationResult,
  type ListElearningAssignmentProgressInput,
  type RevokeElearningAssignmentMemberInput,
} from './elearning-assignment-lifecycle'
import {
  assertAnyElearningUserWithinAdminScope,
  assertElearningRulesWithinAdminScope,
  assertElearningUsersWithinAdminScope,
  authorizeElearningObjectAction,
  lockElearningAdminAuthorization,
  type ElearningAdminAccessQueryable,
  type ElearningObjectAction,
  type ElearningObjectRef,
} from './elearning-admin-access'
import {
  ElearningAudienceResolverError,
  validateElearningAudienceRules,
  type ElearningAudienceRule,
} from './elearning-audience-resolver'
import {
  setElearningCourseScope,
  ElearningScopeError,
  type ElearningScopeDb,
  type SetElearningCourseScopeInput,
  type SetElearningCourseScopeResult,
} from './elearning-scope'
import {
  assignElearningTrainingPlan,
  ElearningTrainingPlanAssignmentError,
  type AssignElearningTrainingPlanInput,
  type ElearningTrainingPlanAssignmentDb,
  type ElearningTrainingPlanAssignmentResult,
} from './elearning-training-plan-assignment'
import {
  revokeElearningTrainingPlanAssignment,
  ElearningTrainingPlanRevocationError,
  type ElearningTrainingPlanRevocationDb,
  type ElearningTrainingPlanRevocationResult,
  type RevokeElearningTrainingPlanAssignmentInput,
} from './elearning-training-plan-revocation'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ElearningAdminOperationQueryable
  extends ElearningAdminAccessQueryable {}

export interface ElearningAdminOperationDb
  extends ElearningAdminOperationQueryable {
  transaction<T>(
    handler: (tx: ElearningAdminOperationQueryable) => Promise<T>,
  ): Promise<T>
}

type GlobalAdminContext = { isGlobalAdmin: boolean }

export type AssignElearningDirectAuthorizedInput =
  AssignElearningDirectInput & GlobalAdminContext
export type AssignElearningBatchAuthorizedInput =
  AssignElearningBatchInput & GlobalAdminContext
export type ListElearningAssignmentProgressAuthorizedInput =
  ListElearningAssignmentProgressInput & { actorId: string } & GlobalAdminContext
export type RevokeElearningAssignmentMemberAuthorizedInput =
  RevokeElearningAssignmentMemberInput & GlobalAdminContext
export type SetElearningCourseScopeAuthorizedInput =
  SetElearningCourseScopeInput & GlobalAdminContext
export type AssignElearningTrainingPlanAuthorizedInput =
  AssignElearningTrainingPlanInput & GlobalAdminContext
export type RevokeElearningTrainingPlanAssignmentAuthorizedInput =
  RevokeElearningTrainingPlanAssignmentInput & GlobalAdminContext

function storedUuid(value: unknown): string | null {
  if (typeof value !== 'string' || !UUID_RE.test(value)) return null
  return value.toLowerCase()
}

function storedText(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  return value
}

function nestedDb(tx: ElearningAdminOperationQueryable): ElearningAdminOperationDb {
  return {
    query: (sql, params) => tx.query(sql, params),
    transaction: async <T>(
      handler: (inner: ElearningAdminOperationQueryable) => Promise<T>,
    ): Promise<T> => handler(tx),
  }
}

async function withSerializedAuthorization<T>(
  db: ElearningAdminOperationDb,
  handler: (tx: ElearningAdminOperationQueryable) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Object resolution can precede the object-specific advisory lock. Keep
    // statement snapshots fresh so authorization observes a writer that
    // committed before this operation acquired that lock.
    await tx.query(
      `/* elearning-admin-operations:read-committed */
       SET TRANSACTION ISOLATION LEVEL READ COMMITTED`,
    )
    return handler(tx)
  })
}

async function authorizeObject(
  tx: ElearningAdminOperationQueryable,
  input: {
    orgId: string
    actorId: string
    isGlobalAdmin: boolean
    object: ElearningObjectRef
    action: ElearningObjectAction
  },
): Promise<void> {
  await lockElearningAdminAuthorization(tx, input)
  await authorizeElearningObjectAction(tx, input)
}

async function loadCourseObjectByVersion(
  tx: ElearningAdminOperationQueryable,
  orgId: string,
  courseVersionId: string,
): Promise<ElearningObjectRef | null> {
  const result = await tx.query(
    `/* elearning-admin-operations:course-by-version */
     SELECT course.id AS course_id
     FROM elearning_course_versions version
     JOIN elearning_courses course
       ON course.org_id = version.org_id
      AND course.id = version.course_id
     WHERE version.org_id = $1 AND version.id = $2
     FOR SHARE OF version, course`,
    [orgId, courseVersionId],
  )
  const courseId = storedUuid(result.rows[0]?.course_id)
  return courseId ? { courseId } : null
}

async function loadAssignmentOperationTarget(
  tx: ElearningAdminOperationQueryable,
  input: { orgId: string; assignmentId: string; memberId?: string },
): Promise<{
  object: ElearningObjectRef
  userId: string | null
  userIds: string[]
} | null> {
  const params: unknown[] = [input.orgId, input.assignmentId]
  let memberJoin = ''
  let memberSelect = 'NULL::text AS user_id'
  if (input.memberId) {
    params.push(input.memberId)
    memberJoin = `JOIN elearning_assignment_members member
      ON member.org_id = assignment.org_id
     AND member.assignment_id = assignment.id
     AND member.id = $3`
    memberSelect = 'member.user_id AS user_id'
  }
  const result = await tx.query(
    `/* elearning-admin-operations:assignment-object */
     SELECT
       course.id AS course_id,
       plan_assignment.training_plan_id,
       ${memberSelect},
       ARRAY(
         SELECT DISTINCT roster.user_id
         FROM elearning_assignment_members roster
         WHERE roster.org_id = assignment.org_id
           AND roster.assignment_id = assignment.id
         ORDER BY roster.user_id ASC
       ) AS member_user_ids
     FROM elearning_assignments assignment
     JOIN elearning_course_versions version
       ON version.org_id = assignment.org_id
      AND version.id = assignment.course_version_id
     JOIN elearning_courses course
       ON course.org_id = version.org_id
      AND course.id = version.course_id
     ${memberJoin}
     LEFT JOIN elearning_training_plan_assignment_items plan_item
       ON plan_item.org_id = assignment.org_id
      AND plan_item.assignment_id = assignment.id
     LEFT JOIN elearning_training_plan_assignments plan_assignment
       ON plan_assignment.org_id = plan_item.org_id
      AND plan_assignment.id = plan_item.training_plan_assignment_id
     WHERE assignment.org_id = $1 AND assignment.id = $2
     FOR SHARE OF assignment, version, course`,
    params,
  )
  const row = result.rows[0]
  if (!row) return null
  const trainingPlanId = row.training_plan_id == null
    ? null
    : storedUuid(row.training_plan_id)
  const courseId = storedUuid(row.course_id)
  if ((!courseId && !trainingPlanId) || (row.training_plan_id != null && !trainingPlanId)) {
    return null
  }
  const userId = row.user_id == null ? null : storedText(row.user_id)
  if (input.memberId && !userId) return null
  if (!Array.isArray(row.member_user_ids)) return null
  const userIds = row.member_user_ids.map(storedText)
  if (
    userIds.length < 1
    || userIds.length > 10_000
    || userIds.some((candidate) => !candidate)
    || new Set(userIds).size !== userIds.length
  ) {
    return null
  }
  return {
    object: trainingPlanId ? { trainingPlanId } : { courseId: courseId! },
    userId,
    userIds: userIds as string[],
  }
}

async function loadPlanAssignmentTarget(
  tx: ElearningAdminOperationQueryable,
  orgId: string,
  planAssignmentId: string,
): Promise<{ object: ElearningObjectRef; userIds: string[] } | null> {
  const result = await tx.query(
    `/* elearning-admin-operations:plan-assignment-object */
     SELECT training_plan_id, member_ids
     FROM elearning_training_plan_assignments
     WHERE org_id = $1 AND id = $2
     FOR SHARE`,
    [orgId, planAssignmentId],
  )
  const row = result.rows[0]
  if (!row) return null
  const trainingPlanId = storedUuid(row.training_plan_id)
  if (!trainingPlanId || !Array.isArray(row.member_ids)) return null
  const userIds = row.member_ids.map(storedText)
  if (
    userIds.length < 1
    || userIds.length > 10_000
    || userIds.some((userId) => !userId)
    || new Set(userIds).size !== userIds.length
  ) {
    return null
  }
  return {
    object: { trainingPlanId },
    userIds: userIds as string[],
  }
}

export async function assignElearningDirectAuthorized(
  db: ElearningAdminOperationDb,
  input: AssignElearningDirectAuthorizedInput,
): Promise<ElearningDirectAssignmentResult> {
  return withSerializedAuthorization(db, async (tx) => {
    const object = await loadCourseObjectByVersion(tx, input.orgId, input.courseVersionId)
    if (!object) throw new ElearningDirectAssignmentError('not_found')
    await authorizeObject(tx, { ...input, object, action: 'assign' })
    await assertElearningUsersWithinAdminScope(tx, {
      ...input,
      userIds: [input.targetUserId],
    })
    return assignElearningDirect(nestedDb(tx) as ElearningDirectAssignmentDb, input)
  })
}

export async function assignElearningBatchAuthorized(
  db: ElearningAdminOperationDb,
  input: AssignElearningBatchAuthorizedInput,
): Promise<ElearningBatchAssignmentResult> {
  const rules = normalizeElearningBatchAssignmentRules(input.rules)
  return withSerializedAuthorization(db, async (tx) => {
    const object = await loadCourseObjectByVersion(tx, input.orgId, input.courseVersionId)
    if (!object) throw new ElearningBatchAssignmentError('not_found')
    await authorizeObject(tx, { ...input, object, action: 'assign' })
    await assertElearningRulesWithinAdminScope(tx, { ...input, rules })
    return assignElearningBatch(nestedDb(tx) as ElearningBatchAssignmentDb, input)
  })
}

export async function listElearningAssignmentProgressAuthorized(
  db: ElearningAdminOperationDb,
  input: ListElearningAssignmentProgressAuthorizedInput,
): Promise<ElearningAssignmentProgressResult> {
  return withSerializedAuthorization(db, async (tx) => {
    const target = await loadAssignmentOperationTarget(tx, input)
    if (!target) throw new ElearningAssignmentLifecycleError('not_found')
    await authorizeObject(tx, { ...input, object: target.object, action: 'track' })
    await assertAnyElearningUserWithinAdminScope(tx, {
      ...input,
      userIds: target.userIds,
    })
    return listElearningAssignmentProgress(
      nestedDb(tx) as ElearningAssignmentLifecycleDb,
      {
        ...input,
        scopeActorId: input.isGlobalAdmin ? null : input.actorId,
      },
    )
  })
}

export async function revokeElearningAssignmentMemberAuthorized(
  db: ElearningAdminOperationDb,
  input: RevokeElearningAssignmentMemberAuthorizedInput,
): Promise<ElearningAssignmentRevocationResult> {
  return withSerializedAuthorization(db, async (tx) => {
    const target = await loadAssignmentOperationTarget(tx, input)
    if (!target?.userId) throw new ElearningAssignmentLifecycleError('not_found')
    await authorizeObject(tx, { ...input, object: target.object, action: 'assign' })
    await assertElearningUsersWithinAdminScope(tx, {
      ...input,
      userIds: [target.userId],
    })
    return revokeElearningAssignmentMember(
      nestedDb(tx) as ElearningAssignmentLifecycleDb,
      input,
    )
  })
}

function scopeValidationError(error: ElearningAudienceResolverError): ElearningScopeError {
  if (error.code === 'invalid_input') return new ElearningScopeError('invalid_input')
  if (error.code === 'subject_not_found') return new ElearningScopeError('subject_not_found')
  if (error.code === 'unsupported_subject') return new ElearningScopeError('unsupported_subject')
  return new ElearningScopeError('unavailable')
}

export async function setElearningCourseScopeAuthorized(
  db: ElearningAdminOperationDb,
  input: SetElearningCourseScopeAuthorizedInput,
): Promise<SetElearningCourseScopeResult> {
  return withSerializedAuthorization(db, async (tx) => {
    const object: ElearningObjectRef = { courseId: input.courseId }
    await authorizeObject(tx, { ...input, object, action: 'scope' })
    let rules: ElearningAudienceRule[]
    try {
      rules = await validateElearningAudienceRules(tx, input)
    } catch (error) {
      if (error instanceof ElearningAudienceResolverError) {
        throw scopeValidationError(error)
      }
      throw error
    }
    await assertElearningRulesWithinAdminScope(tx, { ...input, rules })
    return setElearningCourseScope(nestedDb(tx) as ElearningScopeDb, input)
  })
}

export async function assignElearningTrainingPlanAuthorized(
  db: ElearningAdminOperationDb,
  input: AssignElearningTrainingPlanAuthorizedInput,
): Promise<ElearningTrainingPlanAssignmentResult> {
  let rules: ElearningAudienceRule[]
  try {
    rules = normalizeElearningBatchAssignmentRules(input.rules)
  } catch {
    throw new ElearningTrainingPlanAssignmentError('invalid_input')
  }
  return withSerializedAuthorization(db, async (tx) => {
    const object: ElearningObjectRef = { trainingPlanId: input.planId }
    await authorizeObject(tx, { ...input, object, action: 'assign' })
    await assertElearningRulesWithinAdminScope(tx, { ...input, rules })
    return assignElearningTrainingPlan(
      nestedDb(tx) as ElearningTrainingPlanAssignmentDb,
      input,
    )
  })
}

export async function revokeElearningTrainingPlanAssignmentAuthorized(
  db: ElearningAdminOperationDb,
  input: RevokeElearningTrainingPlanAssignmentAuthorizedInput,
): Promise<ElearningTrainingPlanRevocationResult> {
  return withSerializedAuthorization(db, async (tx) => {
    const target = await loadPlanAssignmentTarget(tx, input.orgId, input.planAssignmentId)
    if (!target) throw new ElearningTrainingPlanRevocationError('not_found')
    await authorizeObject(tx, { ...input, object: target.object, action: 'assign' })
    await assertElearningUsersWithinAdminScope(tx, {
      ...input,
      userIds: target.userIds,
    })
    return revokeElearningTrainingPlanAssignment(
      nestedDb(tx) as ElearningTrainingPlanRevocationDb,
      input,
    )
  })
}
