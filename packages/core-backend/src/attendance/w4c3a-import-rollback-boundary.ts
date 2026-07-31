import {
  AttendanceW4AuthorizationError,
  createAuthorizedAttendanceWriteContextV1,
  recheckAttendanceActorLivenessInTransactionV1,
  type AttendanceActorPostureV1,
  type AuthorizedAttendanceWriteContextV1,
} from './w4c0-authorization'
import {
  acquireAttendanceCalculationRolloutLock,
  acquireAttendanceCalculationTargetLocks,
  acquireAttendanceResultOperationLocks,
  createVerifiedAttendanceCalculationTargetIdentityV1,
  createVerifiedAttendanceOperationIdentityV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  rehydrateVerifiedAttendanceOrgIdentityV1,
  resolveSegmentCalculationPosture,
  type AttendanceW4TransactionClientV1,
} from './w4c0-identity'
import { AttendanceW4OperationError } from './w4c0-operation-contract'
import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import { runAttendanceResultOperationTransactionV1 } from './w4c0-operation-registry'
import {
  AttendanceLegacyPlanEnqueueError,
  recheckAttendanceFullImportAuthorizationInTransactionV1,
} from './w4c3a-legacy-plan-enqueue'
import {
  AttendanceImportRollbackError,
  createCoreAttendanceImportRollbackAuthorizationPortV1,
  createFrozenAttendanceImportRollbackCommandV1,
  deriveAttendanceImportRollbackSourceJobIdentitiesV1,
  lockAttendanceImportRollbackSourceJobsV1,
  readAttendanceImportRollbackSourceJobsV1,
  rollbackAttendanceImportInExistingTransactionV1,
  type AttendanceImportRollbackAuthorizationRecheckInputV1,
  type AttendanceImportRollbackResultV1,
  type AttendanceImportRollbackSourceJobCandidateV1,
} from './w4c3a-import-rollback'

export interface AttendanceImportRollbackRequestV1 {
  readonly orgId: string
  readonly batchId: string
  readonly actorId: string
  readonly tokenSubjectUserId: string
}

export type AttendanceImportRollbackBoundaryResultV1 =
  | Readonly<{
      kind: 'legacy'
      id: string
      deleted: number
      status: 'rolled_back'
    }>
  | Readonly<{
      kind: 'w4'
      id: string
      affected: number
      restored: number
      retired: number
      status: 'rolled_back'
    }>

export interface AttendanceImportRollbackBoundaryV1 {
  rollbackImportBatchV1(
    input: AttendanceImportRollbackRequestV1,
  ): Promise<AttendanceImportRollbackBoundaryResultV1>
}

export interface AttendanceImportRollbackBoundaryDependenciesV1 {
  acquireConnection(): Promise<{
    client: AttendanceW4TransactionClientV1
    release(): void
  }>
}

interface RollbackTargetFactV1 {
  readonly attendanceRecordId: string
  readonly userId: string
  readonly workDate: string
}

interface SourceAuthorizationV1 {
  readonly actorId: string
  readonly actorPosture: string
  readonly tokenSubjectUserId: string | null
  readonly subjectScope: unknown
}

interface DurableBatchV1 extends SourceAuthorizationV1 {
  readonly entrypoint: 'import_batch' | 'integration_batch'
  readonly commandFingerprint: string
  readonly itemCount: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ROLLBACK_COMMAND_NAMESPACE = '945a6a45-eb4c-4f3a-8aad-0dd278aa2b0c'
const ROLLBACK_ITEM_OPERATION_NAMESPACE = '48400374-f47e-42c2-a647-e8d637592f03'
const ROLLBACK_CALCULATION_NAMESPACE = 'de4e2568-a6f6-4584-89a3-d85eaa4eff95'
const LEGACY_TARGET_USER_NAMESPACE = 'e1115f83-9d66-4fd3-8758-852da8ed096a'

function fail(code: ConstructorParameters<typeof AttendanceImportRollbackError>[0]): never {
  throw new AttendanceImportRollbackError(code)
}

function requireExactInput(input: unknown): AttendanceImportRollbackRequestV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  }
  const row = input as Record<string, unknown>
  const keys = Object.getOwnPropertyNames(row).sort()
  const expected = ['actorId', 'batchId', 'orgId', 'tokenSubjectUserId']
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    Object.getOwnPropertySymbols(row).length !== 0
  ) {
    fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(row, key)
    if (!descriptor || !('value' in descriptor)) fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  }
  const orgId = parseCanonicalAttendanceRolloutOrgKeyV1(row.orgId) as string
  if (typeof row.batchId !== 'string' || !UUID.test(row.batchId)) {
    fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  }
  if (typeof row.actorId !== 'string' || row.actorId.length === 0) {
    fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  }
  if (
    typeof row.tokenSubjectUserId !== 'string' ||
    row.tokenSubjectUserId.length === 0 ||
    row.tokenSubjectUserId !== row.actorId
  ) {
    fail('IMPORT_ROLLBACK_AUTHORIZATION_STALE')
  }
  return Object.freeze({
    orgId,
    batchId: row.batchId.toLowerCase(),
    actorId: row.actorId,
    tokenSubjectUserId: row.tokenSubjectUserId,
  })
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0)),
  ).sort()
}

function roleValues(value: unknown): string[] {
  if (Array.isArray(value)) return stringArray(value)
  if (typeof value !== 'string' || value.length === 0) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) return stringArray(parsed)
  } catch {
    // The legacy users.role column also accepts a plain role name.
  }
  return [value]
}

function subjectScopeCoversTargets(scope: unknown, targets: readonly RollbackTargetFactV1[]): boolean {
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) return false
  const row = scope as { kind?: unknown; userId?: unknown; userIds?: unknown }
  const targetUsers = Array.from(new Set(targets.map((target) => target.userId)))
  if (targetUsers.length === 0) return true
  if (row.kind === 'self') {
    return typeof row.userId === 'string' && targetUsers.every((userId) => userId === row.userId)
  }
  if (row.kind === 'explicit_users') {
    const allowed = new Set(stringArray(row.userIds))
    return targetUsers.length > 0 && targetUsers.every((userId) => allowed.has(userId))
  }
  return row.kind === 'org_scheduler'
}

async function actorRoles(
  trx: AttendanceW4TransactionClientV1,
  actorId: string,
): Promise<{ roles: string[]; roleTags: string[] }> {
  const result = await trx.query(
    `SELECT to_jsonb(u)->'role' AS legacy_role,
            COALESCE(array_agg(DISTINCT ur.role_id) FILTER (WHERE ur.role_id IS NOT NULL), '{}') AS role_ids,
            COALESCE(array_agg(DISTINCT r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS role_names
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
      WHERE u.id = $1
      GROUP BY u.id`,
    [actorId],
  )
  if (result.rows.length !== 1) fail('IMPORT_ROLLBACK_AUTHORIZATION_STALE')
  const row = result.rows[0]
  const roles = Array.from(
    new Set([
      ...roleValues(row.legacy_role),
      ...stringArray(row.role_ids),
      ...stringArray(row.role_names),
    ]),
  ).sort()
  return { roles, roleTags: [...roles] }
}

async function isPlatformAdmin(
  trx: AttendanceW4TransactionClientV1,
  actorId: string,
): Promise<boolean> {
  const result = await trx.query(
    `SELECT 1
       FROM users u
      WHERE u.id = $1
        AND u.is_active = true
        AND COALESCE(u.activation_status, 'activated') = 'activated'
        AND EXISTS (
          SELECT 1 FROM user_roles ur
           WHERE ur.user_id = u.id AND ur.role_id = 'admin'
        )`,
    [actorId],
  )
  return result.rows.length === 1
}

async function hasAttendanceAdminPermission(
  trx: AttendanceW4TransactionClientV1,
  actorId: string,
): Promise<boolean> {
  const result = await trx.query(
    `SELECT 1
       WHERE EXISTS (
         SELECT 1 FROM user_permissions
          WHERE user_id = $1
            AND permission_code IN ('attendance:admin', 'attendance:*', '*:*')
       )
       OR EXISTS (
         SELECT 1
           FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id
          WHERE ur.user_id = $1
            AND rp.permission_code IN ('attendance:admin', 'attendance:*', '*:*')
       )
       OR EXISTS (
         SELECT 1 FROM users u
          WHERE u.id = $1
            AND COALESCE(to_jsonb(u)->'permissions', '[]'::jsonb) ?| ARRAY[
              'attendance:admin', 'attendance:*', '*:*'
            ]
       )
       LIMIT 1`,
    [actorId],
  )
  return result.rows.length === 1
}

function isExpectedAuthorizationDenial(error: unknown): boolean {
  return (
    error instanceof AttendanceW4AuthorizationError ||
    error instanceof AttendanceW4OperationError ||
    error instanceof AttendanceLegacyPlanEnqueueError
  )
}

async function canUseFullImportAuthorization(
  trx: AttendanceW4TransactionClientV1,
  input: AttendanceImportRollbackRequestV1,
  targets: readonly RollbackTargetFactV1[],
): Promise<boolean> {
  const auth = createAuthorizedAttendanceWriteContextV1({
    actorId: input.actorId,
    actorPosture: 'delegated_import',
    tokenSubjectUserId: input.tokenSubjectUserId,
    orgId: input.orgId,
    subjectScope: {
      kind: 'explicit_users',
      userIds: Array.from(new Set(targets.map((target) => target.userId))),
    },
    capability: 'import',
    sourceRef: `attendance-import-rollback-preflight:${input.batchId}`,
  })
  try {
    await recheckAttendanceFullImportAuthorizationInTransactionV1(trx, auth)
    return true
  } catch (error) {
    if (isExpectedAuthorizationDenial(error)) return false
    throw error
  }
}

async function targetFacts(
  trx: AttendanceW4TransactionClientV1,
  orgId: string,
  target: RollbackTargetFactV1,
): Promise<Record<string, string[]>> {
  const attendanceGroups = await trx.query(
    `SELECT DISTINCT group_id::text AS value
       FROM attendance_group_members
      WHERE org_id = $1 AND user_id = $2 AND group_id IS NOT NULL`,
    [orgId, target.userId],
  )
  const scheduleGroups = await trx.query(
    `SELECT DISTINCT m.schedule_group_id::text AS schedule_group_id, g.department_ref
       FROM attendance_schedule_group_members m
       JOIN attendance_schedule_groups g
         ON g.id = m.schedule_group_id
        AND g.org_id = m.org_id
        AND COALESCE(g.is_active, true) = true
      WHERE m.org_id = $1
        AND m.user_id = $2
        AND COALESCE(m.effective_from, DATE '0001-01-01') <= $3::date
        AND COALESCE(m.effective_to, m.effective_from, DATE '9999-12-31') >= $3::date`,
    [orgId, target.userId, target.workDate],
  )
  const targetRoleContext = await actorRoles(trx, target.userId)
  return {
    scheduleGroupIds: scheduleGroups.rows
      .map((row) => row.schedule_group_id)
      .filter((value): value is string => typeof value === 'string'),
    attendanceGroupIds: attendanceGroups.rows
      .map((row) => row.value)
      .filter((value): value is string => typeof value === 'string'),
    userIds: [target.userId],
    departments: scheduleGroups.rows
      .map((row) => row.department_ref)
      .filter((value): value is string => typeof value === 'string'),
    roles: targetRoleContext.roles,
    roleTags: targetRoleContext.roleTags,
  }
}

function scopeMatchesFacts(scope: unknown, facts: Record<string, string[]>): boolean {
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) return false
  const row = scope as Record<string, unknown>
  let constrained = false
  for (const key of [
    'scheduleGroupIds',
    'attendanceGroupIds',
    'userIds',
    'departments',
    'roles',
    'roleTags',
  ]) {
    const allowed = stringArray(row[key])
    if (allowed.length === 0) continue
    constrained = true
    const actual = new Set(facts[key] ?? [])
    if (!allowed.some((value) => actual.has(value))) return false
  }
  return constrained
}

async function delegatedScopeCoversTargets(
  trx: AttendanceW4TransactionClientV1,
  input: AttendanceImportRollbackRequestV1,
  targets: readonly RollbackTargetFactV1[],
): Promise<boolean> {
  const actor = await actorRoles(trx, input.actorId)
  const scopes = await trx.query(
    `SELECT subject_type, subject_ref, actions, scope
       FROM attendance_scheduler_scopes
      WHERE org_id = $1
        AND is_active = true
        AND 'import' = ANY(actions)
        AND (
          (subject_type = 'user' AND subject_ref = $2)
          OR (subject_type = 'role' AND subject_ref = ANY($3::text[]))
          OR (subject_type = 'role_tag' AND subject_ref = ANY($4::text[]))
        )
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST`,
    [input.orgId, input.actorId, actor.roles, actor.roleTags],
  )
  if (scopes.rows.length === 0 || targets.length === 0) return false
  for (const target of targets) {
    const facts = await targetFacts(trx, input.orgId, target)
    if (!scopes.rows.some((scope) => scopeMatchesFacts(scope.scope, facts))) return false
  }
  return true
}

async function recheckRequestActorLiveness(
  trx: AttendanceW4TransactionClientV1,
  request: AttendanceImportRollbackRequestV1,
): Promise<void> {
  const actorContext = createAuthorizedAttendanceWriteContextV1({
    actorId: request.actorId,
    actorPosture: 'delegated_import',
    tokenSubjectUserId: request.tokenSubjectUserId,
    orgId: request.orgId,
    subjectScope: { kind: 'self', userId: request.actorId },
    capability: 'rollback',
    sourceRef: `attendance-import-rollback-authentication:${request.batchId}`,
  })
  await recheckAttendanceActorLivenessInTransactionV1(trx, actorContext).catch((error) => {
    if (isExpectedAuthorizationDenial(error)) fail('IMPORT_ROLLBACK_AUTHORIZATION_STALE')
    throw error
  })
}

async function resolveRollbackActorPosture(
  trx: AttendanceW4TransactionClientV1,
  request: AttendanceImportRollbackRequestV1,
  source: SourceAuthorizationV1,
  targets: readonly RollbackTargetFactV1[],
): Promise<AttendanceActorPostureV1> {
  await recheckRequestActorLiveness(trx, request)
  if (await isPlatformAdmin(trx, request.actorId)) return 'platform_admin'

  const preliminary = createAuthorizedAttendanceWriteContextV1({
    actorId: request.actorId,
    actorPosture: 'delegated_import',
    tokenSubjectUserId: request.tokenSubjectUserId,
    orgId: request.orgId,
    subjectScope:
      targets.length === 0
        ? { kind: 'self', userId: request.actorId }
        : {
            kind: 'explicit_users',
            userIds: Array.from(new Set(targets.map((target) => target.userId))),
          },
    capability: 'rollback',
    sourceRef: `attendance-import-rollback:${request.batchId}`,
  })
  await recheckAttendanceActorLivenessInTransactionV1(trx, preliminary).catch((error) => {
    if (isExpectedAuthorizationDenial(error)) fail('IMPORT_ROLLBACK_AUTHORIZATION_STALE')
    throw error
  })

  if (await hasAttendanceAdminPermission(trx, request.actorId)) return 'attendance_admin'
  if (!subjectScopeCoversTargets(source.subjectScope, targets)) {
    fail('IMPORT_ROLLBACK_AUTHORIZATION_STALE')
  }
  if (request.actorId !== source.actorId) fail('IMPORT_ROLLBACK_AUTHORIZATION_STALE')
  if (targets.length === 0) return 'delegated_import'
  if (await canUseFullImportAuthorization(trx, request, targets)) return 'delegated_import'
  if (!(await delegatedScopeCoversTargets(trx, request, targets))) {
    fail('IMPORT_ROLLBACK_AUTHORIZATION_STALE')
  }
  return 'delegated_import'
}

function mintRollbackAuthorization(
  request: AttendanceImportRollbackRequestV1,
  targets: readonly RollbackTargetFactV1[],
  actorPosture: AttendanceActorPostureV1,
): AuthorizedAttendanceWriteContextV1 {
  return createAuthorizedAttendanceWriteContextV1({
    actorId: request.actorId,
    actorPosture,
    tokenSubjectUserId: request.tokenSubjectUserId,
    orgId: request.orgId,
    subjectScope: {
      kind: 'explicit_users',
      userIds: Array.from(new Set(targets.map((target) => target.userId))),
    },
    capability: 'rollback',
    sourceRef: `attendance-import-rollback:${request.batchId}`,
  })
}

async function loadLegacyBatch(
  trx: AttendanceW4TransactionClientV1,
  request: AttendanceImportRollbackRequestV1,
  lock = false,
): Promise<{ createdBy: string; status: string } | null> {
  const result = await trx.query(
    `SELECT created_by, status
      FROM attendance_import_batches
      WHERE id = $1::uuid AND org_id = $2
      ${lock ? 'FOR UPDATE' : ''}`,
    [request.batchId, request.orgId],
  )
  if (result.rows.length === 0) return null
  if (result.rows.length !== 1 || typeof result.rows[0].created_by !== 'string') {
    fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  }
  return {
    createdBy: result.rows[0].created_by,
    status: String(result.rows[0].status ?? ''),
  }
}

async function loadLegacySourceAuthorization(
  trx: AttendanceW4TransactionClientV1,
  request: AttendanceImportRollbackRequestV1,
): Promise<{ createdBy: string } | null> {
  const result = await trx.query(
    `SELECT created_by
       FROM attendance_import_batches
      WHERE id = $1::uuid AND org_id = $2`,
    [request.batchId, request.orgId],
  )
  if (result.rows.length === 0) return null
  if (result.rows.length !== 1 || typeof result.rows[0].created_by !== 'string') {
    fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  }
  return { createdBy: result.rows[0].created_by }
}

async function loadDurableBatch(
  trx: AttendanceW4TransactionClientV1,
  request: AttendanceImportRollbackRequestV1,
): Promise<DurableBatchV1 | null> {
  const result = await trx.query(
    `SELECT entrypoint, actor_id, actor_posture, token_subject_user_id,
            subject_scope, command_fingerprint, item_count
       FROM attendance_result_operation_batches
      WHERE org_id = $1
        AND batch_command_id = $2::uuid
        AND entrypoint IN ('import_batch', 'integration_batch')`,
    [request.orgId, request.batchId],
  )
  if (result.rows.length === 0) return null
  if (result.rows.length !== 1) fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  const row = result.rows[0]
  if (
    (row.entrypoint !== 'import_batch' && row.entrypoint !== 'integration_batch') ||
    typeof row.actor_id !== 'string' ||
    typeof row.actor_posture !== 'string' ||
    typeof row.command_fingerprint !== 'string' ||
    !Number.isSafeInteger(row.item_count)
  ) {
    fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  }
  return {
    entrypoint: row.entrypoint,
    actorId: row.actor_id,
    actorPosture: row.actor_posture,
    tokenSubjectUserId:
      typeof row.token_subject_user_id === 'string' ? row.token_subject_user_id : null,
    subjectScope: row.subject_scope,
    commandFingerprint: row.command_fingerprint,
    itemCount: Number(row.item_count),
  }
}

async function loadAuthorizationTargets(
  trx: AttendanceW4TransactionClientV1,
  request: AttendanceImportRollbackRequestV1,
): Promise<RollbackTargetFactV1[]> {
  const result = await trx.query(
    `SELECT source.user_id, source.work_date::text AS work_date,
            source.attendance_record_id
       FROM (
         SELECT i.user_id::text AS user_id, i.work_date,
                COALESCE(i.record_id::text, i.id::text) AS attendance_record_id
           FROM attendance_import_items i
          WHERE i.org_id = $1 AND i.batch_id = $2::uuid
            AND i.user_id IS NOT NULL AND i.work_date IS NOT NULL
         UNION
         SELECT r.user_id::text, r.work_date, r.id::text
           FROM attendance_records r
          WHERE r.org_id = $1 AND r.source_batch_id = $2::uuid
       ) source
      ORDER BY source.user_id, source.work_date, source.attendance_record_id`,
    [request.orgId, request.batchId],
  )
  return result.rows.map((row) => ({
    attendanceRecordId: String(row.attendance_record_id),
    userId: String(row.user_id),
    workDate: String(row.work_date),
  }))
}

async function loadLegacyTargets(
  trx: AttendanceW4TransactionClientV1,
  request: AttendanceImportRollbackRequestV1,
): Promise<RollbackTargetFactV1[]> {
  const result = await trx.query(
    `SELECT DISTINCT r.id::text AS attendance_record_id,
            r.user_id::text AS user_id, r.work_date::text AS work_date
      FROM attendance_records r
      WHERE r.org_id = $1 AND r.source_batch_id = $2::uuid
      ORDER BY user_id, work_date, attendance_record_id`,
    [request.orgId, request.batchId],
  )
  return result.rows.map((row) => ({
    attendanceRecordId: String(row.attendance_record_id),
    userId: String(row.user_id),
    workDate: String(row.work_date),
  }))
}

async function loadW4Targets(
  trx: AttendanceW4TransactionClientV1,
  request: AttendanceImportRollbackRequestV1,
  batch: DurableBatchV1,
): Promise<RollbackTargetFactV1[]> {
  if (batch.entrypoint === 'import_batch') {
    const result = await trx.query(
      `SELECT DISTINCT r.id::text AS attendance_record_id,
              r.user_id::text AS user_id, r.work_date::text AS work_date
         FROM attendance_import_items i
         JOIN attendance_records r
           ON r.org_id = i.org_id
          AND r.id = i.record_id
        WHERE i.org_id = $1 AND i.batch_id = $2::uuid
        ORDER BY user_id, work_date, attendance_record_id`,
      [request.orgId, request.batchId],
    )
    const targets = result.rows.map((row) => ({
      attendanceRecordId: String(row.attendance_record_id),
      userId: String(row.user_id),
      workDate: String(row.work_date),
    }))
    if (targets.length === 0) fail('IMPORT_ROLLBACK_BATCH_CHANGED')
    return targets
  }
  const result = await trx.query(
    `SELECT DISTINCT r.id::text AS attendance_record_id,
            r.user_id::text AS user_id, r.work_date::text AS work_date
       FROM attendance_result_operations o
       JOIN attendance_records r
         ON r.org_id = o.org_id
        AND r.id = o.resolved_record_id
      WHERE o.org_id = $1
        AND o.entrypoint = $2
        AND o.batch_command_id = $3::uuid
        AND o.state = 'completed'
        AND o.resolved_record_id IS NOT NULL
        AND o.resolved_calculation_id IS NOT NULL
      ORDER BY user_id, work_date, attendance_record_id`,
    [request.orgId, batch.entrypoint, request.batchId],
  )
  const targets = result.rows.map((row) => ({
    attendanceRecordId: String(row.attendance_record_id),
    userId: String(row.user_id),
    workDate: String(row.work_date),
  }))
  if (targets.length === 0) fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  return targets
}

async function legacyDeleteEligible(
  trx: AttendanceW4TransactionClientV1,
  request: AttendanceImportRollbackRequestV1,
): Promise<boolean> {
  const result = await trx.query(
    `SELECT
       NOT EXISTS (
         SELECT 1 FROM attendance_result_operation_batches
          WHERE org_id = $1 AND batch_command_id = $2::uuid
       )
       AND NOT EXISTS (
         SELECT 1 FROM attendance_result_operations
          WHERE org_id = $1 AND batch_command_id = $2::uuid
       )
       AND NOT EXISTS (
         SELECT 1 FROM attendance_record_calculations
          WHERE org_id = $1 AND source_batch_id = $2::uuid
       )
       AND NOT EXISTS (
         SELECT 1 FROM attendance_records
          WHERE org_id = $1 AND source_batch_id = $2::uuid
            AND (current_calculation_id IS NOT NULL OR projection_owner = 'w4')
       )
       AND NOT EXISTS (
         SELECT 1 FROM attendance_import_rollback_closures
          WHERE org_id = $1 AND batch_id = $2::uuid
       )
       AND NOT EXISTS (
         SELECT 1 FROM attendance_import_jobs
          WHERE org_id = $1 AND batch_id = $2::uuid
            AND status NOT IN ('completed', 'failed')
       ) AS eligible`,
    [request.orgId, request.batchId],
  )
  return result.rows.length === 1 && result.rows[0].eligible === true
}

async function deriveRollbackIds(
  trx: AttendanceW4TransactionClientV1,
  request: AttendanceImportRollbackRequestV1,
  targets: readonly RollbackTargetFactV1[],
): Promise<{
  rollbackOperationId: string
  correlationId: string
  targets: Array<{
    attendanceRecordId: string
    reversalOperationId: string
    reversalCalculationId: string
  }>
}> {
  const commandResult = await trx.query(
    `SELECT attendance_w4_uuidv5(
       $1::uuid, convert_to($2::text, 'UTF8'))::text AS rollback_operation_id`,
    [ROLLBACK_COMMAND_NAMESPACE, request.batchId],
  )
  if (commandResult.rows.length !== 1) fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  const rollbackOperationId = String(commandResult.rows[0].rollback_operation_id)
  const result = await trx.query(
    `SELECT
       attendance_w4_uuidv5(
         $1::uuid,
         convert_to($3::text, 'UTF8') || decode('00', 'hex') || convert_to(target_id::text, 'UTF8')
       )::text AS reversal_operation_id,
       attendance_w4_uuidv5(
         $2::uuid,
         convert_to($3::text, 'UTF8') || decode('00', 'hex') || convert_to(target_id::text, 'UTF8')
       )::text AS reversal_calculation_id,
       target_id::text AS attendance_record_id
      FROM unnest($4::uuid[]) AS target_id
      ORDER BY target_id`,
    [
      ROLLBACK_ITEM_OPERATION_NAMESPACE,
      ROLLBACK_CALCULATION_NAMESPACE,
      request.batchId,
      targets.map((target) => target.attendanceRecordId),
    ],
  )
  if (result.rows.length !== targets.length) fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  return {
    rollbackOperationId,
    correlationId: `attendance-import-rollback:${rollbackOperationId}`,
    targets: result.rows.map((row) => ({
      attendanceRecordId: String(row.attendance_record_id),
      reversalOperationId: String(row.reversal_operation_id),
      reversalCalculationId: String(row.reversal_calculation_id),
    })),
  }
}

function sourceFromAuthorizationInput(
  input: AttendanceImportRollbackAuthorizationRecheckInputV1,
): SourceAuthorizationV1 {
  return {
    actorId: input.sourceBatchActorId,
    actorPosture: input.sourceBatchActorPosture,
    tokenSubjectUserId: input.sourceBatchTokenSubjectUserId,
    subjectScope: input.sourceBatchSubjectScope,
  }
}

async function executeLegacyRollback(
  trx: AttendanceW4TransactionClientV1,
  request: AttendanceImportRollbackRequestV1,
  preflightBatch: { createdBy: string; status: string },
  preflightTargets: readonly RollbackTargetFactV1[],
  preflightJobs: readonly AttendanceImportRollbackSourceJobCandidateV1[],
): Promise<AttendanceImportRollbackBoundaryResultV1> {
  const ids = await deriveRollbackIds(trx, request, preflightTargets)
  const org = rehydrateVerifiedAttendanceOrgIdentityV1({
    orgId: request.orgId,
    acceptedWritePosture: 'legacy_projection_only',
  })
  if (
    preflightJobs.some(
      (job) => job.w4ContractVersion === 1 && job.acceptedWritePosture !== 'legacy_projection_only',
    )
  ) {
    fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  }
  const sourceBatchIdentity = createVerifiedAttendanceOperationIdentityV1({
    org,
    kind: 'batch',
    entrypoint: 'import_batch',
    source: { sourceKind: 'import_batch', batchCommandId: request.batchId },
  })
  const rollbackIdentities = [
    ids.rollbackOperationId,
    ...ids.targets.map((target) => target.reversalOperationId),
  ].map(
    (operationId) =>
      createVerifiedAttendanceOperationIdentityV1({
        org,
        kind: 'item',
        entrypoint: 'import_rollback',
        source: { sourceKind: 'direct_import_rollback', clientOperationId: operationId },
      }),
  )
  const operationIdentities = [
    sourceBatchIdentity,
    ...deriveAttendanceImportRollbackSourceJobIdentitiesV1(
      request.orgId,
      request.batchId,
      preflightJobs,
    ),
    ...rollbackIdentities,
  ]
  await acquireAttendanceResultOperationLocks(trx, operationIdentities)
  await trx.query(
    `SELECT entrypoint, operation_id::text
       FROM attendance_result_operations
      WHERE org_id = $1
        AND (
          (entrypoint = 'import_batch' AND batch_command_id = $2::uuid)
          OR (entrypoint = 'import_rollback' AND operation_id = ANY($3::uuid[]))
        )
      ORDER BY entrypoint, operation_id
      FOR UPDATE`,
    [
      request.orgId,
      request.batchId,
      [ids.rollbackOperationId, ...ids.targets.map((target) => target.reversalOperationId)],
    ],
  )
  await lockAttendanceImportRollbackSourceJobsV1(
    trx,
    request.orgId,
    request.batchId,
    preflightJobs,
  )

  const lockedBatch = await loadLegacyBatch(trx, request, true)
  if (
    !lockedBatch ||
    lockedBatch.createdBy !== preflightBatch.createdBy ||
    lockedBatch.status !== preflightBatch.status
  ) {
    fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  }
  await trx.query(
    `SELECT id::text
       FROM attendance_import_items
      WHERE org_id = $1 AND batch_id = $2::uuid
      ORDER BY id
      FOR UPDATE`,
    [request.orgId, request.batchId],
  )

  const lockUsersResult = await trx.query(
    `SELECT raw_user_id,
            CASE
              WHEN raw_user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                THEN lower(raw_user_id)
              ELSE attendance_w4_uuidv5(
                $1::uuid, convert_to(raw_user_id, 'UTF8'))::text
            END AS lock_user_id
       FROM unnest($2::text[]) AS raw_user_id
      ORDER BY raw_user_id`,
    [
      LEGACY_TARGET_USER_NAMESPACE,
      Array.from(new Set(preflightTargets.map((target) => target.userId))),
    ],
  )
  const lockUsers = new Map(
    lockUsersResult.rows.map((row) => [String(row.raw_user_id), String(row.lock_user_id)]),
  )
  const targetIdentities = preflightTargets.map((target) =>
    createVerifiedAttendanceCalculationTargetIdentityV1({
      org,
      userId: lockUsers.get(target.userId),
      workDate: target.workDate,
    }),
  )
  await acquireAttendanceCalculationTargetLocks(trx, targetIdentities)
  const lockedTargetsResult = await trx.query(
    `SELECT id::text AS attendance_record_id, user_id::text AS user_id,
            work_date::text AS work_date
      FROM attendance_records
      WHERE org_id = $1 AND source_batch_id = $2::uuid
      ORDER BY user_id, work_date, id
      FOR UPDATE`,
    [request.orgId, request.batchId],
  )
  const lockedTargets = lockedTargetsResult.rows.map((row) => ({
    attendanceRecordId: String(row.attendance_record_id),
    userId: String(row.user_id),
    workDate: String(row.work_date),
  }))
  if (
    canonicalAttendanceJsonV1(lockedTargets) !==
    canonicalAttendanceJsonV1(preflightTargets)
  ) {
    fail('IMPORT_ROLLBACK_BATCH_CHANGED')
  }
  const source: SourceAuthorizationV1 = {
    actorId: lockedBatch.createdBy,
    actorPosture: 'delegated_import',
    tokenSubjectUserId: lockedBatch.createdBy,
    subjectScope: {
      kind: 'explicit_users',
      userIds: Array.from(new Set(lockedTargets.map((target) => target.userId))),
    },
  }
  await resolveRollbackActorPosture(trx, request, source, lockedTargets)
  if (!(await legacyDeleteEligible(trx, request))) {
    fail('IMPORT_ROLLBACK_PREIMAGE_UNAVAILABLE')
  }
  if (lockedBatch.status === 'rolled_back') {
    return Object.freeze({
      kind: 'legacy',
      id: request.batchId,
      deleted: 0,
      status: 'rolled_back',
    })
  }
  await resolveRollbackActorPosture(trx, request, source, lockedTargets)
  const deleted = await trx.query(
    `DELETE FROM attendance_records
      WHERE source_batch_id = $1::uuid AND org_id = $2
      RETURNING id`,
    [request.batchId, request.orgId],
  )
  await trx.query(
    `UPDATE attendance_import_batches
        SET status = 'rolled_back', updated_at = now()
      WHERE id = $1::uuid AND org_id = $2`,
    [request.batchId, request.orgId],
  )
  return Object.freeze({
    kind: 'legacy',
    id: request.batchId,
    deleted: deleted.rows.length,
    status: 'rolled_back',
  })
}

async function executeW4Rollback(
  trx: AttendanceW4TransactionClientV1,
  request: AttendanceImportRollbackRequestV1,
  batch: DurableBatchV1,
  targets: readonly RollbackTargetFactV1[],
): Promise<AttendanceImportRollbackResultV1> {
  const actorPosture = await resolveRollbackActorPosture(trx, request, batch, targets)
  const authorization = mintRollbackAuthorization(request, targets, actorPosture)
  const ids = await deriveRollbackIds(trx, request, targets)
  const command = createFrozenAttendanceImportRollbackCommandV1({
    orgId: request.orgId,
    rollbackOperationId: ids.rollbackOperationId,
    sourceBatchEntrypoint: batch.entrypoint,
    sourceBatchId: request.batchId,
    expectedSourceBatchFingerprint: batch.commandFingerprint,
    authorization,
    correlationId: ids.correlationId,
    targets: ids.targets,
  })
  const authorizationPort = createCoreAttendanceImportRollbackAuthorizationPortV1(
    async (transaction, recheckInput) => {
      const recheckTargets = recheckInput.targets.map((target) => ({
        attendanceRecordId: target.attendanceRecordId,
        userId: target.userId,
        workDate: target.workDate,
      }))
      const posture = await resolveRollbackActorPosture(
        transaction,
        request,
        sourceFromAuthorizationInput(recheckInput),
        recheckTargets,
      )
      if (posture !== recheckInput.authorization.actorPosture) {
        fail('IMPORT_ROLLBACK_AUTHORIZATION_STALE')
      }
    },
  )
  return rollbackAttendanceImportInExistingTransactionV1(trx, command, authorizationPort)
}

async function rollbackInTransaction(
  trx: AttendanceW4TransactionClientV1,
  request: AttendanceImportRollbackRequestV1,
): Promise<AttendanceImportRollbackBoundaryResultV1> {
  const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(request.orgId)
  await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')
  await recheckRequestActorLiveness(trx, request)

  // P23 precedes every batch-status, preimage, and legacy-eligibility read.
  // These candidate reads contain only the minimum durable owner/scope facts
  // needed to decide whether the caller may inspect the rollback state.
  const legacySource = await loadLegacySourceAuthorization(trx, request)
  if (!legacySource) fail('IMPORT_ROLLBACK_NOT_FOUND')
  const legacySourceAuthority: SourceAuthorizationV1 = {
    actorId: legacySource.createdBy,
    actorPosture: 'delegated_import',
    tokenSubjectUserId: legacySource.createdBy,
    subjectScope: { kind: 'self', userId: legacySource.createdBy },
  }
  // Source authority must fail before any target-sensitive import-item or
  // attendance-record read. Target-range authorization is repeated below from
  // the minimal target projection before status/preimage/eligibility reads.
  await resolveRollbackActorPosture(trx, request, legacySourceAuthority, [])
  const authorizationTargets = await loadAuthorizationTargets(trx, request)
  const legacyAuthorizationSource: SourceAuthorizationV1 = {
    ...legacySourceAuthority,
    subjectScope: {
      kind: 'explicit_users',
      userIds: Array.from(new Set(authorizationTargets.map((target) => target.userId))),
    },
  }
  await resolveRollbackActorPosture(
    trx,
    request,
    legacyAuthorizationSource,
    authorizationTargets,
  )
  const durableBatch = await loadDurableBatch(trx, request)
  if (durableBatch) {
    await resolveRollbackActorPosture(trx, request, durableBatch, authorizationTargets)
  }

  const posture = await resolveSegmentCalculationPosture(trx, request.orgId)
  if (posture.writePosture === 'blocked') fail('IMPORT_ROLLBACK_CONFLICT')

  const legacyBatch = await loadLegacyBatch(trx, request)
  if (!legacyBatch) fail('IMPORT_ROLLBACK_NOT_FOUND')
  const sourceJobs = await readAttendanceImportRollbackSourceJobsV1(
    trx,
    request.orgId,
    request.batchId,
  )
  const eligible = await legacyDeleteEligible(trx, request)

  if (posture.writePosture === 'legacy_projection_only' && eligible) {
    const targets = await loadLegacyTargets(trx, request)
    return executeLegacyRollback(trx, request, legacyBatch, targets, sourceJobs)
  }

  if (!durableBatch) fail('IMPORT_ROLLBACK_PREIMAGE_UNAVAILABLE')
  const targets = await loadW4Targets(trx, request, durableBatch)
  const result = await executeW4Rollback(trx, request, durableBatch, targets)
  await trx.query(
    `UPDATE attendance_import_batches
        SET status = 'rolled_back', updated_at = now()
      WHERE id = $1::uuid AND org_id = $2`,
    [request.batchId, request.orgId],
  )
  return Object.freeze({
    kind: 'w4',
    id: request.batchId,
    affected: result.affected,
    restored: result.restored,
    retired: result.retired,
    status: 'rolled_back',
  })
}

export function createAttendanceImportRollbackBoundaryV1(
  dependencies: AttendanceImportRollbackBoundaryDependenciesV1,
): AttendanceImportRollbackBoundaryV1 {
  if (
    typeof dependencies !== 'object' ||
    dependencies === null ||
    typeof dependencies.acquireConnection !== 'function'
  ) {
    fail('IMPORT_ROLLBACK_COMMAND_INVALID')
  }
  return Object.freeze({
    async rollbackImportBatchV1(
      input: AttendanceImportRollbackRequestV1,
    ): Promise<AttendanceImportRollbackBoundaryResultV1> {
      const request = requireExactInput(input)
      const acquired = await dependencies.acquireConnection()
      try {
        return await runAttendanceResultOperationTransactionV1(acquired.client, (trx) =>
          rollbackInTransaction(trx, request),
        )
      } finally {
        acquired.release()
      }
    },
  })
}
