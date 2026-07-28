import { createHash } from 'node:crypto'

import type { Request } from 'express'

import {
  normalizePermissionCodes,
  resolveRequestAccess,
  type MultitableCapabilities,
  type ResolvedRequestAccess,
} from './access'
import {
  resolveSheetCapabilitiesForAccess,
  type MultitableCapabilityOrigin,
  type QueryFn,
  type SheetPermissionScope,
} from './permission-service'

function intersectCapabilities(
  requestCapabilities: MultitableCapabilities,
  databaseCapabilities: MultitableCapabilities,
): MultitableCapabilities {
  return {
    canRead: requestCapabilities.canRead && databaseCapabilities.canRead,
    canCreateRecord: requestCapabilities.canCreateRecord && databaseCapabilities.canCreateRecord,
    canEditRecord: requestCapabilities.canEditRecord && databaseCapabilities.canEditRecord,
    canDeleteRecord: requestCapabilities.canDeleteRecord && databaseCapabilities.canDeleteRecord,
    canManageFields: requestCapabilities.canManageFields && databaseCapabilities.canManageFields,
    canManageSheetAccess: requestCapabilities.canManageSheetAccess && databaseCapabilities.canManageSheetAccess,
    canManageViews: requestCapabilities.canManageViews && databaseCapabilities.canManageViews,
    canComment: requestCapabilities.canComment && databaseCapabilities.canComment,
    canManageAutomation: requestCapabilities.canManageAutomation && databaseCapabilities.canManageAutomation,
    canExport: requestCapabilities.canExport && databaseCapabilities.canExport,
    canSendNotification: requestCapabilities.canSendNotification && databaseCapabilities.canSendNotification,
  }
}

const DENIED_CAPABILITIES: MultitableCapabilities = {
  canRead: false,
  canCreateRecord: false,
  canEditRecord: false,
  canDeleteRecord: false,
  canManageFields: false,
  canManageSheetAccess: false,
  canManageViews: false,
  canComment: false,
  canManageAutomation: false,
  canExport: false,
  canSendNotification: false,
}

const AUTHORITY_LOCK_FUNCTION = 'metasheet_try_recovery_authority_user'
const AUTHORITY_ROLE_LOCK_FUNCTION = 'metasheet_try_recovery_authority_role'
const AUTHORITY_GROUP_LOCK_FUNCTION = 'metasheet_try_recovery_authority_group'
export const RECOVERY_AUTHORITY_BUSY_MARKER = 'METASHEET_RECOVERY_AUTHORITY_BUSY'

const RECOVERY_AUTHORITY_TABLES = [
  'field_permissions',
  'platform_member_group_members',
  'record_permissions',
  'role_permissions',
  'spreadsheet_permissions',
  'user_permissions',
  'user_roles',
  'users',
] as const

const triggerArgsHex = (...args: string[]): string =>
  Buffer.from(args.map((arg) => `${arg}\0`).join('')).toString('hex')

const RECOVERY_AUTHORITY_TRIGGER_SPECS = [
  {
    tableName: 'field_permissions',
    triggerName: 'trg_field_permissions_recovery_authority_lock',
    triggerType: 31,
    functionName: 'metasheet_recovery_authority_subject_trigger',
    argumentHex: triggerArgsHex('subject_type', 'subject_id'),
    updateColumns: [],
  },
  {
    tableName: 'platform_member_group_members',
    triggerName: 'trg_member_group_members_recovery_authority_lock',
    triggerType: 31,
    functionName: 'metasheet_recovery_authority_user_trigger',
    argumentHex: triggerArgsHex('user_id'),
    updateColumns: [],
  },
  {
    tableName: 'record_permissions',
    triggerName: 'trg_record_permissions_recovery_authority_lock',
    triggerType: 31,
    functionName: 'metasheet_recovery_authority_subject_trigger',
    argumentHex: triggerArgsHex('subject_type', 'subject_id'),
    updateColumns: [],
  },
  {
    tableName: 'role_permissions',
    triggerName: 'trg_role_permissions_recovery_authority_lock',
    triggerType: 31,
    functionName: 'metasheet_recovery_role_permission_trigger',
    argumentHex: '',
    updateColumns: [],
  },
  {
    tableName: 'spreadsheet_permissions',
    triggerName: 'trg_spreadsheet_permissions_recovery_authority_lock',
    triggerType: 31,
    functionName: 'metasheet_recovery_authority_subject_trigger',
    argumentHex: triggerArgsHex('subject_type', 'subject_id'),
    updateColumns: [],
  },
  {
    tableName: 'user_permissions',
    triggerName: 'trg_user_permissions_recovery_authority_lock',
    triggerType: 31,
    functionName: 'metasheet_recovery_authority_user_trigger',
    argumentHex: triggerArgsHex('user_id'),
    updateColumns: [],
  },
  {
    tableName: 'user_roles',
    triggerName: 'trg_user_roles_recovery_authority_lock',
    triggerType: 31,
    functionName: 'metasheet_recovery_authority_user_trigger',
    argumentHex: triggerArgsHex('user_id'),
    updateColumns: [],
  },
  {
    tableName: 'users',
    triggerName: 'trg_users_recovery_authority_lock_lifecycle',
    triggerType: 15,
    functionName: 'metasheet_recovery_authority_user_trigger',
    argumentHex: triggerArgsHex('id'),
    updateColumns: [],
  },
  {
    tableName: 'users',
    triggerName: 'trg_users_recovery_authority_lock_update',
    triggerType: 19,
    functionName: 'metasheet_recovery_authority_user_trigger',
    argumentHex: triggerArgsHex('id'),
    updateColumns: ['role', 'permissions', 'is_active'],
  },
] as const

const RECOVERY_AUTHORITY_FUNCTION_SPECS = [
  {
    functionName: 'metasheet_try_recovery_authority_group',
    identityArguments: 'authority_group_id text, exclusive boolean',
    resultType: 'boolean',
    bodyFingerprint: '2b05cf30cf3826e71237b0cfb3bddee449f971d47545ab865db2bfb333f36e55',
  },
  {
    functionName: 'metasheet_try_recovery_authority_role',
    identityArguments: 'authority_role_id text, exclusive boolean',
    resultType: 'boolean',
    bodyFingerprint: '43f71bb45b5f52b72e3762efbf61edfff4bd3687ead686bc7c61188c858a1a65',
  },
  {
    functionName: 'metasheet_try_recovery_authority_user',
    identityArguments: 'authority_user_id text, exclusive boolean',
    resultType: 'boolean',
    bodyFingerprint: 'a15e99d0cf593b61d859c19cf942ded5ab8b7a504b43bd7de4cb413fcfbb5d36',
  },
  {
    functionName: 'metasheet_recovery_authority_subject_trigger',
    identityArguments: '',
    resultType: 'trigger',
    bodyFingerprint: '29e5495ffded31696eb75189643d58799535c2403b3594fc55a3689b366020a5',
  },
  {
    functionName: 'metasheet_recovery_authority_user_trigger',
    identityArguments: '',
    resultType: 'trigger',
    bodyFingerprint: '0ab8b5f37a91d8dc6aa400380172108cce96cc4565bfd757adb8394df30cd83c',
  },
  {
    functionName: 'metasheet_recovery_role_permission_trigger',
    identityArguments: '',
    resultType: 'trigger',
    bodyFingerprint: '58cb1351c583ff273c54b64371c7420fc9ded14e11109a09659e9ffd4c466fc1',
  },
] as const

export type RecoveryAuthorityLeaseResult = 'ready' | 'busy' | 'unavailable'

export function isRecoveryAuthorityBusyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const pg = error as { code?: unknown; message?: unknown }
  return pg.code === '40001' && pg.message === RECOVERY_AUTHORITY_BUSY_MARKER
}

function normalizedIds(ids: Iterable<string>): string[] {
  return [...new Set([...ids].map((id) => id.trim()).filter(Boolean))].sort()
}

function isAuthoritySubstrateUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return ['42P01', '42501', '42883'].includes(
    String((error as { code?: unknown }).code ?? ''),
  )
}

function isAuthorityLeaseBusy(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    String((error as { code?: unknown }).code ?? '') === '55P03'
  )
}

async function tryExclusiveAuthorityLocks(
  query: QueryFn,
  functionName: string,
  ids: readonly string[],
): Promise<boolean> {
  if (ids.length === 0) return true
  const result = await query(
    `WITH ordered AS MATERIALIZED (
       SELECT subject_id
         FROM unnest($1::text[]) AS subjects(subject_id)
        ORDER BY subject_id
     )
     SELECT ${functionName}(subject_id, TRUE) AS acquired
       FROM ordered
      ORDER BY subject_id`,
    [ids],
  )
  return (result.rows as Array<{ acquired?: unknown }>).every((row) => row.acquired === true)
}

function normalizeFunctionBody(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function functionBodyFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeFunctionBody(value)))
    .digest('hex')
}

function sortCanonical<T>(values: T[]): T[] {
  return values.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  )
}

async function hasCanonicalAuthoritySubstrate(query: QueryFn): Promise<boolean> {
  const triggerState = await query(
    `WITH expected(table_name, trigger_name) AS (
       SELECT * FROM unnest($1::text[], $2::text[])
     )
     SELECT expected.table_name,
            expected.trigger_name,
            trg.tgenabled AS enabled,
            trg.tgtype::int AS trigger_type,
            function_namespace.nspname AS function_schema,
            function_proc.proname AS function_name,
            encode(trg.tgargs, 'hex') AS argument_hex,
            COALESCE(
              ARRAY(
                SELECT attribute.attname::text
                  FROM unnest(trg.tgattr::smallint[]) WITH ORDINALITY AS selected(attnum, position)
                  JOIN pg_catalog.pg_attribute attribute
                    ON attribute.attrelid = trg.tgrelid
                   AND attribute.attnum = selected.attnum
                 ORDER BY selected.position
              ),
              ARRAY[]::text[]
            ) AS update_columns
       FROM expected
       LEFT JOIN pg_catalog.pg_class relation
         ON relation.oid = to_regclass('public.' || expected.table_name)
       LEFT JOIN pg_catalog.pg_trigger trg
         ON trg.tgrelid = relation.oid
        AND trg.tgname = expected.trigger_name
        AND NOT trg.tgisinternal
       LEFT JOIN pg_catalog.pg_proc function_proc
         ON function_proc.oid = trg.tgfoid
       LEFT JOIN pg_catalog.pg_namespace function_namespace
         ON function_namespace.oid = function_proc.pronamespace`,
    [
      RECOVERY_AUTHORITY_TRIGGER_SPECS.map((spec) => spec.tableName),
      RECOVERY_AUTHORITY_TRIGGER_SPECS.map((spec) => spec.triggerName),
    ],
  )
  const actualTriggers = sortCanonical(
    (triggerState.rows as Array<Record<string, unknown>>).map((row) => ({
      tableName: String(row.table_name ?? ''),
      triggerName: String(row.trigger_name ?? ''),
      enabled: String(row.enabled ?? ''),
      triggerType: Number(row.trigger_type ?? -1),
      functionSchema: String(row.function_schema ?? ''),
      functionName: String(row.function_name ?? ''),
      argumentHex: String(row.argument_hex ?? ''),
      updateColumns: Array.isArray(row.update_columns)
        ? row.update_columns.map(String)
        : [],
    })),
  )
  const expectedTriggers = sortCanonical(
    RECOVERY_AUTHORITY_TRIGGER_SPECS.map((spec) => ({
      tableName: spec.tableName,
      triggerName: spec.triggerName,
      enabled: 'O',
      triggerType: spec.triggerType,
      functionSchema: 'public',
      functionName: spec.functionName,
      argumentHex: spec.argumentHex,
      updateColumns: [...spec.updateColumns],
    })),
  )
  if (JSON.stringify(actualTriggers) !== JSON.stringify(expectedTriggers)) return false

  const functionState = await query(
    `WITH expected(function_name, identity_arguments) AS (
       SELECT * FROM unnest($1::text[], $2::text[])
     )
     SELECT expected.function_name,
            expected.identity_arguments,
            pg_catalog.pg_get_function_result(function_proc.oid) AS result_type,
            language.lanname AS language,
            function_proc.prosecdef AS security_definer,
            function_proc.provolatile AS volatility,
            function_proc.prosrc AS body
       FROM expected
       LEFT JOIN pg_catalog.pg_namespace function_namespace
         ON function_namespace.nspname = 'public'
       LEFT JOIN pg_catalog.pg_proc function_proc
         ON function_proc.pronamespace = function_namespace.oid
        AND function_proc.proname = expected.function_name
        AND pg_catalog.pg_get_function_identity_arguments(function_proc.oid) = expected.identity_arguments
       LEFT JOIN pg_catalog.pg_language language
         ON language.oid = function_proc.prolang`,
    [
      RECOVERY_AUTHORITY_FUNCTION_SPECS.map((spec) => spec.functionName),
      RECOVERY_AUTHORITY_FUNCTION_SPECS.map((spec) => spec.identityArguments),
    ],
  )
  const actualFunctions = sortCanonical(
    (functionState.rows as Array<Record<string, unknown>>).map((row) => ({
      functionName: String(row.function_name ?? ''),
      identityArguments: String(row.identity_arguments ?? ''),
      resultType: String(row.result_type ?? ''),
      language: String(row.language ?? ''),
      securityDefiner: row.security_definer === true,
      volatility: String(row.volatility ?? ''),
      bodyFingerprint: functionBodyFingerprint(row.body),
    })),
  )
  const expectedFunctions = sortCanonical(
    RECOVERY_AUTHORITY_FUNCTION_SPECS.map((spec) => ({
      functionName: spec.functionName,
      identityArguments: spec.identityArguments,
      resultType: spec.resultType,
      language: 'plpgsql',
      securityDefiner: false,
      volatility: 'v',
      bodyFingerprint: spec.bodyFingerprint,
    })),
  )
  return JSON.stringify(actualFunctions) === JSON.stringify(expectedFunctions)
}

/**
 * Acquire a commit-held, per-subject authority lease for exact-anchor recovery.
 *
 * The caller supplies the actor plus every person value the recovery may write. Once their user keys
 * are held exclusively, user-role and member-group assignment rows cannot change; the discovered role
 * and group keys are then acquired in the global user -> role -> group order. All acquisitions are
 * try-locks. A concurrent writer/recovery produces `busy` and a full transaction rollback, never a
 * blocking advisory edge.
 *
 * The migration leaves all writer triggers disabled. Runtime first takes ROW EXCLUSIVE on the eight
 * authority tables. That mode remains compatible with ordinary DML and concurrent recoveries, while
 * conflicting with trigger DDL's SHARE ROW EXCLUSIVE lock. Runtime then verifies every enabled
 * trigger's event shape, function/arguments, and the six executable function fingerprints. Function
 * replacement is a privileged deployment boundary rather than something a table lock can freeze;
 * operators must not deploy this substrate while recovery is executing.
 */
export async function acquireRecoveryAuthorityLease(
  query: QueryFn,
  userIds: Iterable<string>,
): Promise<RecoveryAuthorityLeaseResult> {
  const ids = normalizedIds(userIds)
  if (ids.length === 0) return 'unavailable'
  try {
    await query(
      `LOCK TABLE ${RECOVERY_AUTHORITY_TABLES.join(
        ', ',
      )} IN ROW EXCLUSIVE MODE NOWAIT`,
    )
    if (!(await hasCanonicalAuthoritySubstrate(query))) return 'unavailable'

    if (!(await tryExclusiveAuthorityLocks(query, AUTHORITY_LOCK_FUNCTION, ids))) return 'busy'

    const assignedRoles = await query(
      `SELECT DISTINCT role_id
         FROM user_roles
        WHERE user_id = ANY($1::text[])
        ORDER BY role_id`,
      [ids],
    )
    const roleIds = normalizedIds(
      (assignedRoles.rows as Array<{ role_id?: unknown }>).flatMap((row) =>
        typeof row.role_id === 'string' ? [row.role_id] : [],
      ),
    )
    if (!(await tryExclusiveAuthorityLocks(query, AUTHORITY_ROLE_LOCK_FUNCTION, roleIds))) return 'busy'

    const assignedGroups = await query(
      `SELECT DISTINCT group_id::text AS group_id
         FROM platform_member_group_members
        WHERE user_id = ANY($1::text[])
        ORDER BY group_id::text`,
      [ids],
    )
    const groupIds = normalizedIds(
      (assignedGroups.rows as Array<{ group_id?: unknown }>).flatMap((row) =>
        typeof row.group_id === 'string' ? [row.group_id] : [],
      ),
    )
    if (!(await tryExclusiveAuthorityLocks(query, AUTHORITY_GROUP_LOCK_FUNCTION, groupIds))) return 'busy'
    return 'ready'
  } catch (error) {
    if (isAuthorityLeaseBusy(error)) return 'busy'
    if (isAuthoritySubstrateUnavailable(error)) return 'unavailable'
    throw error
  }
}

/**
 * Read the actor's current database authority without the process-wide RBAC cache or JWT claims.
 * `multitable`, `spreadsheet(s)`, and `workflow` are non-namespaced resources, so the namespace
 * admission filter cannot change any capability used by exact-anchor recovery.
 */
export async function loadDatabaseFreshRecoveryAccess(
  query: QueryFn,
  userId: string,
): Promise<ResolvedRequestAccess> {
  const normalizedUserId = userId.trim()
  if (!normalizedUserId) return { userId: '', permissions: [], isAdminRole: false }

  const userResult = await query(
    `SELECT role, permissions, COALESCE(is_active, TRUE) AS is_active,
            EXISTS (
              SELECT 1 FROM user_roles
               WHERE user_id = $1 AND role_id = 'admin'
            ) AS rbac_admin
       FROM users
      WHERE id = $1`,
    [normalizedUserId],
  )
  const user = userResult.rows[0] as {
    role?: unknown
    permissions?: unknown
    is_active?: unknown
    rbac_admin?: unknown
  } | undefined
  if (!user || user.is_active === false || user.role === 'disabled') {
    return { userId: normalizedUserId, permissions: [], isAdminRole: false }
  }

  const permissionResult = await query(
    `SELECT DISTINCT permission_code AS code
       FROM (
         SELECT permission_code
           FROM user_permissions
          WHERE user_id = $1
         UNION ALL
         SELECT rp.permission_code
           FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id
          WHERE ur.user_id = $1
       ) AS effective_permissions`,
    [normalizedUserId],
  )
  const rbacPermissions = (permissionResult.rows as Array<{ code?: unknown }>)
    .map((row) => (typeof row.code === 'string' ? row.code : ''))
    .filter(Boolean)
  const legacyPermissions = Array.isArray(user.permissions)
    ? normalizePermissionCodes(user.permissions)
    : []

  return {
    userId: normalizedUserId,
    permissions: Array.from(new Set([...rbacPermissions, ...legacyPermissions])),
    isAdminRole: user.role === 'admin' || user.rbac_admin === true,
  }
}

export type RecoverySheetAuthority = {
  access: ResolvedRequestAccess
  capabilities: MultitableCapabilities
  capabilityOrigin: MultitableCapabilityOrigin
  sheetScope?: SheetPermissionScope
}

/**
 * Resolve recovery authority as the intersection of request claims and transaction-fresh database
 * authority. Current sheet-scoped grants are evaluated by the shared policy resolver on both sides;
 * a fresh grant may therefore work normally, while a stale global/admin claim can never widen access.
 */
export async function resolveRecoverySheetAuthority(
  req: Request,
  query: QueryFn,
  sheetId: string,
): Promise<RecoverySheetAuthority> {
  const requestAccess = await resolveRequestAccess(req)
  if (!requestAccess.userId) {
    return {
      access: requestAccess,
      capabilities: DENIED_CAPABILITIES,
      capabilityOrigin: { source: 'global-rbac', hasSheetAssignments: false },
    }
  }

  const databaseAccess = await loadDatabaseFreshRecoveryAccess(query, requestAccess.userId)
  const [requestResolved, databaseResolved] = await Promise.all([
    resolveSheetCapabilitiesForAccess(query, sheetId, requestAccess),
    resolveSheetCapabilitiesForAccess(query, sheetId, databaseAccess),
  ])
  const access: ResolvedRequestAccess = {
    userId: requestAccess.userId,
    permissions: databaseAccess.permissions,
    isAdminRole: requestAccess.isAdminRole && databaseAccess.isAdminRole,
  }
  return {
    access,
    capabilities: intersectCapabilities(requestResolved.capabilities, databaseResolved.capabilities),
    capabilityOrigin: databaseResolved.capabilityOrigin,
    ...(databaseResolved.sheetScope ? { sheetScope: databaseResolved.sheetScope } : {}),
  }
}
