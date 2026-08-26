import type { ElearningAudienceRule } from './elearning-audience-resolver'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const ELEARNING_ADMIN_SCOPE_LIMIT = 100
export const ELEARNING_ADMIN_ACCESS_REASON_MAX = 500
export const ELEARNING_OBJECT_ACTIONS = ['assign', 'scope', 'track'] as const

export type ElearningObjectAction = (typeof ELEARNING_OBJECT_ACTIONS)[number]
export type ElearningAdminAccessErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'forbidden'
  | 'scope_required'
  | 'target_out_of_scope'
  | 'unavailable'

export class ElearningAdminAccessError extends Error {
  constructor(readonly code: ElearningAdminAccessErrorCode) {
    super(code)
    this.name = 'ElearningAdminAccessError'
  }
}

export interface ElearningAdminAccessQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningAdminAccessDb extends ElearningAdminAccessQueryable {
  transaction<T>(
    handler: (tx: ElearningAdminAccessQueryable) => Promise<T>,
  ): Promise<T>
}

export interface ElearningAdminScopeInput {
  departmentId: string
  includeChildren: boolean
}

export interface ReplaceElearningAdminScopesInput {
  orgId: string
  actorId: string
  targetUserId: string
  reason: string
  scopes: unknown
}

export interface ReplaceElearningAdminScopesResult {
  targetUserId: string
  scopeCount: number
  duplicate: boolean
}

export type ElearningObjectRef =
  | { courseId: string; trainingPlanId?: never }
  | { courseId?: never; trainingPlanId: string }

export interface ReplaceElearningObjectAclInput {
  orgId: string
  actorId: string
  isGlobalAdmin: boolean
  object: ElearningObjectRef
  granteeUserId: string
  reason: string
  actions: unknown
}

export interface ReplaceElearningObjectAclResult {
  objectType: 'course' | 'training_plan'
  objectId: string
  granteeUserId: string
  actions: ElearningObjectAction[]
  duplicate: boolean
}

export interface AuthorizeElearningObjectActionInput {
  orgId: string
  actorId: string
  isGlobalAdmin: boolean
  object: ElearningObjectRef
  action: ElearningObjectAction
}

export interface LockElearningAdminAuthorizationInput {
  orgId: string
  actorId: string
  object: ElearningObjectRef
}

function fail(code: ElearningAdminAccessErrorCode): never {
  throw new ElearningAdminAccessError(code)
}

function requireText(value: unknown, max = 256): string {
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) fail('invalid_input')
  return trimmed
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function requireReason(value: unknown): string {
  return requireText(value, ELEARNING_ADMIN_ACCESS_REASON_MAX)
}

function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('invalid_input')
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): void {
  const allowed = new Set(required)
  if (Object.keys(value).some((key) => !allowed.has(key))) fail('invalid_input')
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    fail('invalid_input')
  }
}

function storedText(value: unknown): string {
  if (typeof value !== 'string' || value === '') fail('unavailable')
  return value
}

function storedUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('unavailable')
  return value.toLowerCase()
}

function storedBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') fail('unavailable')
  return value
}

function asSafeCount(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail('unavailable')
    return value
  }
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail('unavailable')
    return Number(value)
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) fail('unavailable')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) fail('unavailable')
  return parsed
}

function objectRef(value: ElearningObjectRef): {
  objectType: 'course' | 'training_plan'
  objectId: string
} {
  if (!isPlainObject(value)) fail('invalid_input')
  const hasCourse = Object.prototype.hasOwnProperty.call(value, 'courseId')
  const hasPlan = Object.prototype.hasOwnProperty.call(value, 'trainingPlanId')
  if (hasCourse === hasPlan) fail('invalid_input')
  if (hasCourse) {
    requireExactKeys(value, ['courseId'])
    return { objectType: 'course', objectId: requireUuid(value.courseId) }
  }
  requireExactKeys(value, ['trainingPlanId'])
  return {
    objectType: 'training_plan',
    objectId: requireUuid(value.trainingPlanId),
  }
}

function isAction(value: unknown): value is ElearningObjectAction {
  return typeof value === 'string'
    && (ELEARNING_OBJECT_ACTIONS as readonly string[]).includes(value)
}

export function normalizeElearningObjectActions(value: unknown): ElearningObjectAction[] {
  if (!Array.isArray(value) || value.length > ELEARNING_OBJECT_ACTIONS.length) {
    fail('invalid_input')
  }
  const actions = value.map((item) => {
    if (!isAction(item)) fail('invalid_input')
    return item
  }).sort()
  if (new Set(actions).size !== actions.length) fail('invalid_input')
  return actions
}

export function normalizeElearningAdminScopes(value: unknown): ElearningAdminScopeInput[] {
  if (!Array.isArray(value) || value.length > ELEARNING_ADMIN_SCOPE_LIMIT) {
    fail('invalid_input')
  }
  const scopes = value.map((item) => {
    if (!isPlainObject(item)) fail('invalid_input')
    requireExactKeys(item, ['departmentId', 'includeChildren'])
    return {
      departmentId: requireUuid(item.departmentId),
      includeChildren: requireBoolean(item.includeChildren),
    }
  }).sort((left, right) => left.departmentId.localeCompare(right.departmentId))
  if (new Set(scopes.map((scope) => scope.departmentId)).size !== scopes.length) {
    fail('invalid_input')
  }
  return scopes
}

function normalizeUserIds(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) {
    fail('invalid_input')
  }
  const normalized = value.map((item) => requireText(item)).sort()
  if (new Set(normalized).size !== normalized.length) fail('invalid_input')
  return normalized
}

function sameAdminScopes(
  rows: Array<Record<string, unknown>>,
  scopes: ElearningAdminScopeInput[],
): boolean {
  if (rows.length !== scopes.length) return false
  return rows.every((row, index) => (
    storedUuid(row.directory_department_id) === scopes[index]?.departmentId
    && storedBoolean(row.include_children) === scopes[index]?.includeChildren
  ))
}

function sameActions(
  rows: Array<Record<string, unknown>>,
  actions: ElearningObjectAction[],
): boolean {
  if (rows.length !== actions.length) return false
  return rows.every((row, index) => storedText(row.action) === actions[index])
}

export function elearningAdminScopeLockKey(
  orgId: string,
  targetUserId: string,
): string {
  return `elearning-admin-scopes:${orgId}:${targetUserId}`
}

export function elearningObjectAclLockKey(
  orgId: string,
  objectType: 'course' | 'training_plan',
  objectId: string,
  granteeUserId: string,
): string {
  return `elearning-object-acl:${orgId}:${objectType}:${objectId}:${granteeUserId}`
}

async function requireActiveMembership(
  db: ElearningAdminAccessQueryable,
  orgId: string,
  userId: string,
): Promise<void> {
  const result = await db.query(
    `/* elearning-admin-access:active-membership */
     SELECT 1
     FROM users platform_user
     JOIN user_orgs membership
       ON membership.user_id = platform_user.id
      AND membership.org_id = $1
      AND membership.is_active = TRUE
     WHERE platform_user.id = $2
       AND platform_user.is_active = TRUE
     FOR SHARE OF platform_user, membership`,
    [orgId, userId],
  )
  if (result.rows.length !== 1) fail('not_found')
}

async function loadObjectOwner(
  db: ElearningAdminAccessQueryable,
  orgId: string,
  ref: { objectType: 'course' | 'training_plan'; objectId: string },
): Promise<string> {
  const table = ref.objectType === 'course'
    ? 'elearning_courses'
    : 'elearning_training_plans'
  const result = await db.query(
    `/* elearning-admin-access:load-object */
     SELECT created_by
     FROM ${table}
     WHERE org_id = $1 AND id = $2
     FOR SHARE`,
    [orgId, ref.objectId],
  )
  if (!result.rows[0]) fail('not_found')
  return storedText(result.rows[0].created_by)
}

export async function replaceElearningAdminScopes(
  db: ElearningAdminAccessDb,
  input: ReplaceElearningAdminScopesInput,
): Promise<ReplaceElearningAdminScopesResult> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  const targetUserId = requireText(input.targetUserId)
  const reason = requireReason(input.reason)
  const scopes = normalizeElearningAdminScopes(input.scopes)

  return db.transaction(async (tx) => {
    try {
      await tx.query(
        `/* elearning-admin-scopes:lock */
         SELECT pg_advisory_xact_lock(hashtext($1))`,
        [elearningAdminScopeLockKey(orgId, targetUserId)],
      )
      await requireActiveMembership(tx, orgId, actorId)
      await requireActiveMembership(tx, orgId, targetUserId)

      if (scopes.length > 0) {
        const departments = await tx.query(
          `/* elearning-admin-scopes:departments */
           SELECT department.id, department.integration_id, integration.provider
           FROM directory_departments department
           JOIN directory_integrations integration
             ON integration.id = department.integration_id
            AND integration.org_id = $1
            AND integration.status = 'active'
           WHERE department.id = ANY($2::uuid[])
             AND department.is_active = TRUE
           ORDER BY department.id ASC
           FOR SHARE OF department, integration`,
          [orgId, scopes.map((scope) => scope.departmentId)],
        )
        if (departments.rows.length !== scopes.length) fail('not_found')
      }

      const current = await tx.query(
        `/* elearning-admin-scopes:load-current */
         SELECT id, directory_department_id, include_children
         FROM elearning_admin_scopes
         WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL
         ORDER BY directory_department_id ASC
         FOR UPDATE`,
        [orgId, targetUserId],
      )
      if (sameAdminScopes(current.rows, scopes)) {
        return { targetUserId, scopeCount: scopes.length, duplicate: true }
      }

      const desired = new Map(scopes.map((scope) => [scope.departmentId, scope]))
      const currentByDepartment = new Map(current.rows.map((row) => [
        storedUuid(row.directory_department_id),
        row,
      ]))
      const revokeIds = current.rows
        .filter((row) => {
          const departmentId = storedUuid(row.directory_department_id)
          const next = desired.get(departmentId)
          return !next || storedBoolean(row.include_children) !== next.includeChildren
        })
        .map((row) => storedUuid(row.id))
      if (revokeIds.length > 0) {
        const revoked = await tx.query(
          `/* elearning-admin-scopes:revoke */
           UPDATE elearning_admin_scopes
           SET revoked_at = now(), revoked_by = $3, revocation_reason = $4
           WHERE org_id = $1 AND id = ANY($2::uuid[]) AND revoked_at IS NULL
           RETURNING id`,
          [orgId, revokeIds, actorId, reason],
        )
        if (revoked.rowCount !== revokeIds.length) fail('unavailable')
      }

      for (const scope of scopes) {
        const currentRow = currentByDepartment.get(scope.departmentId)
        if (currentRow && storedBoolean(currentRow.include_children) === scope.includeChildren) {
          continue
        }
        const inserted = await tx.query(
          `/* elearning-admin-scopes:insert */
           INSERT INTO elearning_admin_scopes (
             org_id,
             user_id,
             directory_integration_id,
             directory_provider,
             directory_department_id,
             include_children,
             granted_by
           )
           SELECT
             $1,
             $2,
             department.integration_id,
             integration.provider,
             department.id,
             $4,
             $5
           FROM directory_departments department
           JOIN directory_integrations integration
             ON integration.id = department.integration_id
            AND integration.org_id = $1
            AND integration.status = 'active'
           WHERE department.id = $3
             AND department.is_active = TRUE
           RETURNING id`,
          [orgId, targetUserId, scope.departmentId, scope.includeChildren, actorId],
        )
        if (inserted.rowCount !== 1) fail('unavailable')
      }

      return { targetUserId, scopeCount: scopes.length, duplicate: false }
    } catch (error) {
      if (error instanceof ElearningAdminAccessError) throw error
      fail('unavailable')
    }
  })
}

export async function replaceElearningObjectAcl(
  db: ElearningAdminAccessDb,
  input: ReplaceElearningObjectAclInput,
): Promise<ReplaceElearningObjectAclResult> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  const granteeUserId = requireText(input.granteeUserId)
  const reason = requireReason(input.reason)
  if (typeof input.isGlobalAdmin !== 'boolean') fail('invalid_input')
  const ref = objectRef(input.object)
  const actions = normalizeElearningObjectActions(input.actions)

  return db.transaction(async (tx) => {
    try {
      await tx.query(
        `/* elearning-object-acl:lock */
         SELECT pg_advisory_xact_lock(hashtext($1))`,
        [elearningObjectAclLockKey(
          orgId,
          ref.objectType,
          ref.objectId,
          granteeUserId,
        )],
      )
      await requireActiveMembership(tx, orgId, actorId)
      const ownerId = await loadObjectOwner(tx, orgId, ref)
      if (!input.isGlobalAdmin && ownerId !== actorId) fail('forbidden')
      await requireActiveMembership(tx, orgId, granteeUserId)

      const objectColumn = ref.objectType === 'course' ? 'course_id' : 'training_plan_id'
      const current = await tx.query(
        `/* elearning-object-acl:load-current */
         SELECT id, action
         FROM elearning_object_acl
         WHERE org_id = $1
           AND ${objectColumn} = $2
           AND grantee_user_id = $3
           AND revoked_at IS NULL
         ORDER BY action ASC
         FOR UPDATE`,
        [orgId, ref.objectId, granteeUserId],
      )
      if (sameActions(current.rows, actions)) {
        return {
          objectType: ref.objectType,
          objectId: ref.objectId,
          granteeUserId,
          actions,
          duplicate: true,
        }
      }

      const desired = new Set(actions)
      const currentActions = new Set(current.rows.map((row) => storedText(row.action)))
      const revokeIds = current.rows
        .filter((row) => !desired.has(storedText(row.action) as ElearningObjectAction))
        .map((row) => storedUuid(row.id))
      if (revokeIds.length > 0) {
        const revoked = await tx.query(
          `/* elearning-object-acl:revoke */
           UPDATE elearning_object_acl
           SET revoked_at = now(), revoked_by = $3, revocation_reason = $4
           WHERE org_id = $1 AND id = ANY($2::uuid[]) AND revoked_at IS NULL
           RETURNING id`,
          [orgId, revokeIds, actorId, reason],
        )
        if (revoked.rowCount !== revokeIds.length) fail('unavailable')
      }

      for (const action of actions) {
        if (currentActions.has(action)) continue
        const inserted = await tx.query(
          `/* elearning-object-acl:insert */
           INSERT INTO elearning_object_acl (
             org_id,
             course_id,
             training_plan_id,
             grantee_user_id,
             action,
             granted_by
           ) VALUES (
             $1,
             $2,
             $3,
             $4,
             $5,
             $6
           )
           RETURNING id`,
          [
            orgId,
            ref.objectType === 'course' ? ref.objectId : null,
            ref.objectType === 'training_plan' ? ref.objectId : null,
            granteeUserId,
            action,
            actorId,
          ],
        )
        if (inserted.rowCount !== 1) fail('unavailable')
      }

      return {
        objectType: ref.objectType,
        objectId: ref.objectId,
        granteeUserId,
        actions,
        duplicate: false,
      }
    } catch (error) {
      if (error instanceof ElearningAdminAccessError) throw error
      fail('unavailable')
    }
  })
}

export async function authorizeElearningObjectAction(
  db: ElearningAdminAccessQueryable,
  input: AuthorizeElearningObjectActionInput,
): Promise<void> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  if (typeof input.isGlobalAdmin !== 'boolean' || !isAction(input.action)) {
    fail('invalid_input')
  }
  const ref = objectRef(input.object)
  await requireActiveMembership(db, orgId, actorId)
  const ownerId = await loadObjectOwner(db, orgId, ref)
  if (input.isGlobalAdmin || ownerId === actorId) return

  const objectColumn = ref.objectType === 'course' ? 'course_id' : 'training_plan_id'
  const result = await db.query(
    `/* elearning-admin-access:object-action */
     SELECT 1
     FROM elearning_object_acl
     WHERE org_id = $1
       AND ${objectColumn} = $2
       AND grantee_user_id = $3
       AND action = $4
       AND revoked_at IS NULL
       LIMIT 1`,
    [orgId, ref.objectId, actorId, input.action],
  )
  if (result.rows.length !== 1) fail('forbidden')
}

/**
 * Serializes one business operation with concurrent changes to the actor's
 * management scope and object ACL. Call inside the same transaction that
 * performs the protected operation, before evaluating either permission.
 */
export async function lockElearningAdminAuthorization(
  db: ElearningAdminAccessQueryable,
  input: LockElearningAdminAuthorizationInput,
): Promise<void> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  const ref = objectRef(input.object)
  const keys = [
    elearningAdminScopeLockKey(orgId, actorId),
    elearningObjectAclLockKey(
      orgId,
      ref.objectType,
      ref.objectId,
      actorId,
    ),
  ].sort()
  for (const key of keys) {
    await db.query(
      `/* elearning-admin-access:operation-lock */
       SELECT pg_advisory_xact_lock(hashtext($1))`,
      [key],
    )
  }
}

async function loadElearningAdminScopeCoverage(
  db: ElearningAdminAccessQueryable,
  orgId: string,
  actorId: string,
  userIds: readonly string[],
): Promise<{ scopeCount: number; targetCount: number; coveredCount: number }> {
  const result = await db.query(
    `/* elearning-admin-access:user-scope */
     WITH RECURSIVE active_scopes AS (
       SELECT
         scope.id AS scope_id,
         scope.directory_integration_id AS integration_id,
         scope.directory_department_id AS department_id,
         scope.include_children,
         ARRAY[scope.directory_department_id]::uuid[] AS path
       FROM elearning_admin_scopes scope
       JOIN directory_integrations integration
         ON integration.id = scope.directory_integration_id
        AND integration.org_id = scope.org_id
        AND integration.status = 'active'
       JOIN directory_departments department
         ON department.id = scope.directory_department_id
        AND department.integration_id = scope.directory_integration_id
        AND department.is_active = TRUE
       WHERE scope.org_id = $1
         AND scope.user_id = $2
         AND scope.revoked_at IS NULL
     ),
     allowed_departments AS (
       SELECT scope_id, integration_id, department_id, include_children, path
       FROM active_scopes
       UNION ALL
       SELECT
         parent.scope_id,
         parent.integration_id,
         child.id,
         parent.include_children,
         parent.path || child.id
       FROM allowed_departments parent
       JOIN directory_departments parent_department
         ON parent_department.id = parent.department_id
        AND parent_department.integration_id = parent.integration_id
       JOIN directory_departments child
         ON child.integration_id = parent.integration_id
        AND child.external_parent_department_id =
          parent_department.external_department_id
        AND child.is_active = TRUE
       WHERE parent.include_children = TRUE
         AND NOT child.id = ANY(parent.path)
     ),
     target_users AS (
       SELECT DISTINCT user_id
       FROM unnest($3::text[]) AS target(user_id)
     ),
     covered_users AS (
       SELECT DISTINCT target.user_id
       FROM target_users target
       JOIN users platform_user
         ON platform_user.id = target.user_id
        AND platform_user.is_active = TRUE
       JOIN user_orgs membership
         ON membership.user_id = platform_user.id
        AND membership.org_id = $1
        AND membership.is_active = TRUE
       JOIN directory_account_links link
         ON link.local_user_id = platform_user.id
        AND link.link_status = 'linked'
       JOIN directory_accounts account
         ON account.id = link.directory_account_id
        AND account.is_active = TRUE
       JOIN directory_account_departments account_department
         ON account_department.directory_account_id = account.id
       JOIN allowed_departments allowed
         ON allowed.department_id = account_department.directory_department_id
        AND allowed.integration_id = account.integration_id
     )
     SELECT
       (SELECT count(*)::bigint FROM active_scopes) AS scope_count,
       (SELECT count(*)::bigint FROM target_users) AS target_count,
       (SELECT count(*)::bigint FROM covered_users) AS covered_count`,
    [orgId, actorId, userIds],
  )
  const row = result.rows[0]
  if (!row) fail('unavailable')
  return {
    scopeCount: asSafeCount(row.scope_count),
    targetCount: asSafeCount(row.target_count),
    coveredCount: asSafeCount(row.covered_count),
  }
}

export async function assertElearningUsersWithinAdminScope(
  db: ElearningAdminAccessQueryable,
  input: {
    orgId: string
    actorId: string
    isGlobalAdmin: boolean
    userIds: readonly string[]
  },
): Promise<void> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  if (typeof input.isGlobalAdmin !== 'boolean') fail('invalid_input')
  const userIds = normalizeUserIds(input.userIds)
  if (input.isGlobalAdmin) return
  const coverage = await loadElearningAdminScopeCoverage(
    db,
    orgId,
    actorId,
    userIds,
  )
  if (coverage.scopeCount === 0) fail('scope_required')
  if (coverage.targetCount !== coverage.coveredCount) {
    fail('target_out_of_scope')
  }
}

export async function assertAnyElearningUserWithinAdminScope(
  db: ElearningAdminAccessQueryable,
  input: {
    orgId: string
    actorId: string
    isGlobalAdmin: boolean
    userIds: readonly string[]
  },
): Promise<void> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  if (typeof input.isGlobalAdmin !== 'boolean') fail('invalid_input')
  const userIds = normalizeUserIds(input.userIds)
  if (input.isGlobalAdmin) return
  const coverage = await loadElearningAdminScopeCoverage(
    db,
    orgId,
    actorId,
    userIds,
  )
  if (coverage.scopeCount === 0) fail('scope_required')
  if (coverage.coveredCount === 0) fail('target_out_of_scope')
}

export async function assertElearningRulesWithinAdminScope(
  db: ElearningAdminAccessQueryable,
  input: {
    orgId: string
    actorId: string
    isGlobalAdmin: boolean
    rules: readonly ElearningAudienceRule[]
  },
): Promise<void> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  if (typeof input.isGlobalAdmin !== 'boolean' || !Array.isArray(input.rules)) {
    fail('invalid_input')
  }
  if (input.isGlobalAdmin) return
  if (input.rules.length < 1 || input.rules.length > 100) fail('invalid_input')

  const userIds: string[] = []
  const departmentRules: Array<{ departmentId: string; includeChildren: boolean }> = []
  for (const rule of input.rules) {
    if (rule.subjectType === 'user') {
      userIds.push(requireText(rule.subjectRef))
      continue
    }
    if (rule.subjectType === 'department') {
      departmentRules.push({
        departmentId: requireUuid(rule.subjectRef),
        includeChildren: requireBoolean(rule.includeChildren),
      })
      continue
    }
    // Dynamic all/role/position rules could expand outside the granter's
    // department after a later directory sync. Only global admins may create
    // them until a persisted intersection policy exists.
    fail('target_out_of_scope')
  }

  if (userIds.length > 0) {
    await assertElearningUsersWithinAdminScope(db, {
      orgId,
      actorId,
      isGlobalAdmin: false,
      userIds: Array.from(new Set(userIds)).sort(),
    })
  }
  if (departmentRules.length === 0) return

  const result = await db.query(
    `/* elearning-admin-access:rule-scope */
     WITH RECURSIVE active_scopes AS (
       SELECT
         scope.id AS scope_id,
         scope.directory_integration_id AS integration_id,
         scope.directory_department_id AS department_id,
         scope.include_children AS can_include_children,
         ARRAY[scope.directory_department_id]::uuid[] AS path
       FROM elearning_admin_scopes scope
       JOIN directory_integrations integration
         ON integration.id = scope.directory_integration_id
        AND integration.org_id = scope.org_id
        AND integration.status = 'active'
       JOIN directory_departments department
         ON department.id = scope.directory_department_id
        AND department.integration_id = scope.directory_integration_id
        AND department.is_active = TRUE
       WHERE scope.org_id = $1
         AND scope.user_id = $2
         AND scope.revoked_at IS NULL
     ),
     allowed_departments AS (
       SELECT
         scope_id,
         integration_id,
         department_id,
         can_include_children,
         path
       FROM active_scopes
       UNION ALL
       SELECT
         parent.scope_id,
         parent.integration_id,
         child.id,
         parent.can_include_children,
         parent.path || child.id
       FROM allowed_departments parent
       JOIN directory_departments parent_department
         ON parent_department.id = parent.department_id
        AND parent_department.integration_id = parent.integration_id
       JOIN directory_departments child
         ON child.integration_id = parent.integration_id
        AND child.external_parent_department_id =
          parent_department.external_department_id
        AND child.is_active = TRUE
       WHERE parent.can_include_children = TRUE
         AND NOT child.id = ANY(parent.path)
     ),
     input_rules AS (
       SELECT department_id, include_children
       FROM jsonb_to_recordset($3::jsonb) AS input(
         department_id uuid,
         include_children boolean
       )
     ),
     covered_rules AS (
       SELECT DISTINCT input.department_id, input.include_children
       FROM input_rules input
       JOIN allowed_departments allowed
         ON allowed.department_id = input.department_id
        AND (
          input.include_children = FALSE
          OR allowed.can_include_children = TRUE
        )
     )
     SELECT
       (SELECT count(*)::bigint FROM active_scopes) AS scope_count,
       (SELECT count(*)::bigint FROM input_rules) AS rule_count,
       (SELECT count(*)::bigint FROM covered_rules) AS covered_count`,
    [
      orgId,
      actorId,
      JSON.stringify(departmentRules.map((rule) => ({
        department_id: rule.departmentId,
        include_children: rule.includeChildren,
      }))),
    ],
  )
  const row = result.rows[0]
  if (!row) fail('unavailable')
  if (asSafeCount(row.scope_count) === 0) fail('scope_required')
  if (asSafeCount(row.rule_count) !== asSafeCount(row.covered_count)) {
    fail('target_out_of_scope')
  }
}
