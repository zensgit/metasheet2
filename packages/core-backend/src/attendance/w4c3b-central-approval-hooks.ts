/**
 * W4C-3b Stage R0 — central approval classification + org-bound authorization.
 *
 * Scope (lock §12.5 / P17 / P19 / P22 / P26):
 *  - Classify attendance instances from locked workflow_key + request join.
 *  - published_definition_id never excludes attendance.
 *  - Lock request before deriving org; caller org / JSON snapshots cannot widen.
 *  - P26 bulk reassign: closed actor/target matrix + audit witness for platform-admin.
 *  - Other central terminal/assignment-mutation paths fail closed before DML
 *    (no invented reconciliation / plugin effects yet).
 *
 * Does not edit plugin-attendance or claim later request/result adapters.
 */

export const ATTENDANCE_APPROVAL_WORKFLOW_KEY = 'attendance.request'
export const ATTENDANCE_REQUEST_BUSINESS_KEY_PREFIX = 'attendance-request:'

/** Values-free typed codes for central attendance guards. */
export const W4C3B_CENTRAL_APPROVAL_ERROR_CODES = Object.freeze({
  /** Attendance instance reached a central mutation/terminal path that R0 does not implement. */
  ATTENDANCE_CENTRAL_MUTATION_UNSUPPORTED: 'ATTENDANCE_CENTRAL_MUTATION_UNSUPPORTED',
} as const)

export type W4c3bCentralApprovalErrorCode =
  (typeof W4C3B_CENTRAL_APPROVAL_ERROR_CODES)[keyof typeof W4C3B_CENTRAL_APPROVAL_ERROR_CODES]

export class AttendanceCentralApprovalError extends Error {
  readonly statusCode: number
  readonly code: W4c3bCentralApprovalErrorCode

  constructor(code: W4c3bCentralApprovalErrorCode, statusCode: number, message: string) {
    super(message)
    this.name = 'AttendanceCentralApprovalError'
    this.code = code
    this.statusCode = statusCode
  }
}

export type W4c3bQueryClient = {
  query: (
    sql: string,
    params?: readonly unknown[] | unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>
}

export type W4c3bApprovalInstanceRef = {
  id: string
  workflow_key?: string | null
  business_key?: string | null
  published_definition_id?: string | null
  status?: string | null
  version?: number | null
  current_node_key?: string | null
}

export type LockedAttendanceRequestForCentralV1 = Readonly<{
  requestId: string
  orgId: string
  status: string
  approvalInstanceId: string | null
  userId: string | null
}>

export type AttendanceInstanceClassificationV1 =
  | { kind: 'not_attendance' }
  | {
      kind: 'attendance'
      /** Request row could not be locked/joined — treat as attendance but unauthorizable. */
      request: LockedAttendanceRequestForCentralV1 | null
    }

export type AttendanceReassignActorPostureV1 = 'platform_admin' | 'org_admin'

export type AttendanceReassignAuditWitnessV1 = Readonly<{
  kind: 'w4c3b_attendance_reassign'
  orgId: string
  requestId: string
  actorPosture: AttendanceReassignActorPostureV1
  actorId: string
  targetUserId: string
  instanceId: string
  instanceVersion: number
}>

export type AttendanceReassignAuthResultV1 =
  | {
      ok: true
      request: LockedAttendanceRequestForCentralV1
      actorPosture: AttendanceReassignActorPostureV1
      auditWitness: AttendanceReassignAuditWitnessV1
    }
  | {
      ok: false
      /** Explicit unauthorized IDs share the not-found skip shape. */
      skipReason: 'not-found' | 'target-user-invalid'
    }

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Parse business_key `attendance-request:<uuid>` → request id (null if malformed). */
export function parseAttendanceRequestIdFromBusinessKey(businessKey: unknown): string | null {
  const key = asText(businessKey)
  if (!key || !key.startsWith(ATTENDANCE_REQUEST_BUSINESS_KEY_PREFIX)) return null
  const id = key.slice(ATTENDANCE_REQUEST_BUSINESS_KEY_PREFIX.length).trim()
  // RFC 4122 8-4-4-4-12 (case-insensitive); identity compare stays string equality on stored id.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return null
  }
  return id
}

/**
 * Classify from a already-FOR UPDATE-locked approval_instances row.
 * published_definition_id is intentionally ignored (adversarial fixture must still classify).
 * Locks the matching attendance_requests row FOR UPDATE before returning org.
 */
export async function classifyAndLockAttendanceRequestForInstance(
  client: W4c3bQueryClient,
  instance: W4c3bApprovalInstanceRef,
): Promise<AttendanceInstanceClassificationV1> {
  const workflowKey = asText(instance.workflow_key)
  if (workflowKey !== ATTENDANCE_APPROVAL_WORKFLOW_KEY) {
    return { kind: 'not_attendance' }
  }

  const requestIdFromBusinessKey = parseAttendanceRequestIdFromBusinessKey(instance.business_key)
  const locked = await client.query(
    `SELECT id::text AS id,
            org_id::text AS org_id,
            status::text AS status,
            approval_instance_id::text AS approval_instance_id,
            user_id::text AS user_id
       FROM attendance_requests
      WHERE (
              ($1::text IS NOT NULL AND id::text = $1::text)
              OR approval_instance_id = $2::text
            )
        AND (
              approval_instance_id IS NULL
              OR approval_instance_id = $2::text
            )
      ORDER BY
        CASE WHEN $1::text IS NOT NULL AND id::text = $1::text THEN 0 ELSE 1 END,
        created_at ASC NULLS LAST
      LIMIT 1
      FOR UPDATE`,
    [requestIdFromBusinessKey, instance.id],
  )

  if (locked.rows.length !== 1) {
    return { kind: 'attendance', request: null }
  }

  const row = locked.rows[0]
  const requestId = asText(row.id)
  const orgId = asText(row.org_id)
  if (!requestId || !orgId) {
    return { kind: 'attendance', request: null }
  }

  return {
    kind: 'attendance',
    request: {
      requestId,
      orgId,
      status: asText(row.status) ?? 'pending',
      approvalInstanceId: asText(row.approval_instance_id),
      userId: asText(row.user_id),
    },
  }
}

/** True when the locked instance is attendance-owned (including orphaned join). */
export function isAttendanceClassification(
  classification: AttendanceInstanceClassificationV1,
): boolean {
  return classification.kind === 'attendance'
}

/**
 * Fail closed for central paths that terminalize or mutate assignments but are
 * not the P26 reassign contract (R0 does not invent plugin reconciliation).
 * Call after instance FOR UPDATE and before any instance/assignment/record DML.
 */
export async function assertAttendanceCentralMutationFailClosed(
  client: W4c3bQueryClient,
  instance: W4c3bApprovalInstanceRef,
): Promise<void> {
  const classification = await classifyAndLockAttendanceRequestForInstance(client, instance)
  if (classification.kind === 'not_attendance') return
  throw new AttendanceCentralApprovalError(
    W4C3B_CENTRAL_APPROVAL_ERROR_CODES.ATTENDANCE_CENTRAL_MUTATION_UNSUPPORTED,
    409,
    'Attendance approval cannot be mutated through this path',
  )
}

async function isActiveActivatedUser(
  client: W4c3bQueryClient,
  userId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM users
      WHERE id = $1
        AND COALESCE(is_active, TRUE) = TRUE
        AND COALESCE(activation_status, 'activated') = 'activated'
      LIMIT 1`,
    [userId],
  )
  return result.rows.length === 1
}

async function isActiveOrgMember(
  client: W4c3bQueryClient,
  userId: string,
  orgId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM user_orgs
      WHERE user_id = $1
        AND org_id = $2
        AND COALESCE(is_active, TRUE) = TRUE
      LIMIT 1`,
    [userId, orgId],
  )
  return result.rows.length === 1
}

/**
 * Lock target users + exact user_orgs membership for attendance reassign (P26).
 * Stable order: users row FOR UPDATE, then user_orgs (user_id, org_id) FOR UPDATE.
 * Predicate rechecked under those locks so concurrent deprovision/membership removal
 * cannot race a successful reassignment.
 */
export async function lockAndValidateAttendanceReassignTarget(
  client: W4c3bQueryClient,
  targetUserId: string,
  orgId: string,
): Promise<boolean> {
  // 1) users row — exclusive lock before membership.
  const userLock = await client.query(
    `SELECT id::text AS id,
            COALESCE(is_active, TRUE) AS is_active,
            COALESCE(activation_status, 'activated') AS activation_status
       FROM users
      WHERE id = $1
      FOR UPDATE`,
    [targetUserId],
  )
  if (userLock.rows.length !== 1) return false
  const userRow = userLock.rows[0]
  // node-pg returns native booleans; tolerate string 't' from alternate drivers.
  const userActive = userRow.is_active === true || userRow.is_active === 't'
  if (!userActive) return false
  if (asText(userRow.activation_status) !== 'activated') return false

  // 2) exact membership row — exclusive lock after users (stable order).
  const membershipLock = await client.query(
    `SELECT user_id::text AS user_id,
            org_id::text AS org_id,
            COALESCE(is_active, TRUE) AS is_active
       FROM user_orgs
      WHERE user_id = $1
        AND org_id = $2
      FOR UPDATE`,
    [targetUserId, orgId],
  )
  if (membershipLock.rows.length !== 1) return false
  const mem = membershipLock.rows[0]
  return mem.is_active === true || mem.is_active === 't'
}

/** DB-backed global platform-admin posture (user_roles.role_id = 'admin' + live user). */
export async function isDbBackedPlatformAdmin(
  client: W4c3bQueryClient,
  userId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM users u
      WHERE u.id = $1
        AND COALESCE(u.is_active, TRUE) = TRUE
        AND COALESCE(u.activation_status, 'activated') = 'activated'
        AND EXISTS (
          SELECT 1 FROM user_roles ur
           WHERE ur.user_id = u.id AND ur.role_id = 'admin'
        )
      LIMIT 1`,
    [userId],
  )
  return result.rows.length === 1
}

async function userHasPermissionFamily(
  client: W4c3bQueryClient,
  userId: string,
  codes: readonly string[],
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       WHERE EXISTS (
         SELECT 1 FROM user_permissions
          WHERE user_id = $1
            AND permission_code = ANY($2::text[])
       )
       OR EXISTS (
         SELECT 1
           FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id
          WHERE ur.user_id = $1
            AND rp.permission_code = ANY($2::text[])
       )
       OR EXISTS (
         SELECT 1 FROM users u
          WHERE u.id = $1
            AND COALESCE(to_jsonb(u)->'permissions', '[]'::jsonb) ?| $2::text[]
       )
       LIMIT 1`,
    [userId, [...codes]],
  )
  return result.rows.length === 1
}

const APPROVALS_ADMIN_FAMILY = Object.freeze(['approvals:admin', 'approvals:*', '*:*'] as const)
const ATTENDANCE_ADMIN_FAMILY = Object.freeze(['attendance:admin', 'attendance:*', '*:*'] as const)

/** Org-local actor: live + membership + both approvals:admin and attendance:admin families. */
export async function actorHasOrgLocalAttendanceReassignAuthority(
  client: W4c3bQueryClient,
  actorId: string,
  orgId: string,
): Promise<boolean> {
  if (!(await isActiveActivatedUser(client, actorId))) return false
  if (!(await isActiveOrgMember(client, actorId, orgId))) return false
  const hasApprovalsAdmin = await userHasPermissionFamily(client, actorId, APPROVALS_ADMIN_FAMILY)
  if (!hasApprovalsAdmin) return false
  const hasAttendanceAdmin = await userHasPermissionFamily(client, actorId, ATTENDANCE_ADMIN_FAMILY)
  return hasAttendanceAdmin
}

/**
 * @deprecated Prefer lockAndValidateAttendanceReassignTarget inside a write txn.
 * Unlocked snapshot check retained only for discovery-style non-mutating reads.
 */
export async function targetEligibleForAttendanceReassign(
  client: W4c3bQueryClient,
  targetUserId: string,
  orgId: string,
): Promise<boolean> {
  if (!(await isActiveActivatedUser(client, targetUserId))) return false
  return isActiveOrgMember(client, targetUserId, orgId)
}

/**
 * Authorize bulk reassign for a classified attendance instance.
 * Caller must already hold FOR UPDATE on approval_instances and the locked request.
 * Locks target users + user_orgs under FOR UPDATE before success (stable order).
 * Caller org / requester JSON never widen access.
 */
export async function authorizeAttendanceCentralReassign(
  client: W4c3bQueryClient,
  input: {
    instance: W4c3bApprovalInstanceRef
    request: LockedAttendanceRequestForCentralV1 | null
    actorId: string
    targetUserId: string
  },
): Promise<AttendanceReassignAuthResultV1> {
  const request = input.request
  if (!request) {
    return { ok: false, skipReason: 'not-found' }
  }

  // Actor: platform-admin override OR org-local dual permission + membership.
  let actorPosture: AttendanceReassignActorPostureV1 | null = null
  if (await isDbBackedPlatformAdmin(client, input.actorId)) {
    actorPosture = 'platform_admin'
  } else if (await actorHasOrgLocalAttendanceReassignAuthority(client, input.actorId, request.orgId)) {
    actorPosture = 'org_admin'
  } else {
    return { ok: false, skipReason: 'not-found' }
  }

  // Target: lock users then exact user_orgs membership (FOR UPDATE); recheck under locks.
  if (!(await lockAndValidateAttendanceReassignTarget(client, input.targetUserId, request.orgId))) {
    return { ok: false, skipReason: 'target-user-invalid' }
  }

  const instanceVersion = Number(input.instance.version ?? 0)
  const auditWitness: AttendanceReassignAuditWitnessV1 = Object.freeze({
    kind: 'w4c3b_attendance_reassign',
    orgId: request.orgId,
    requestId: request.requestId,
    actorPosture,
    actorId: input.actorId,
    targetUserId: input.targetUserId,
    instanceId: input.instance.id,
    instanceVersion: Number.isFinite(instanceVersion) ? instanceVersion : 0,
  })

  return {
    ok: true,
    request,
    actorPosture,
    auditWitness,
  }
}

/**
 * Discovery filter: drop attendance instances the actor cannot reassign.
 * Non-attendance ids pass through unchanged. Orphan attendance rows are excluded.
 * Does not use caller-supplied org or JSON snapshots.
 */
export async function filterBulkReassignDiscoveryForAttendance(
  client: W4c3bQueryClient,
  actorId: string,
  candidateIds: readonly string[],
): Promise<string[]> {
  if (candidateIds.length === 0) return []

  const isPlatformAdmin = await isDbBackedPlatformAdmin(client, actorId)

  const result = await client.query(
    `SELECT i.id::text AS id,
            i.workflow_key::text AS workflow_key,
            r.org_id::text AS org_id
       FROM approval_instances i
       LEFT JOIN attendance_requests r
         ON i.workflow_key = $2
        AND (
              (i.business_key IS NOT NULL
                AND i.business_key = ($3 || r.id::text))
              OR r.approval_instance_id = i.id
            )
      WHERE i.id = ANY($1::text[])`,
    [candidateIds, ATTENDANCE_APPROVAL_WORKFLOW_KEY, ATTENDANCE_REQUEST_BUSINESS_KEY_PREFIX],
  )

  const byId = new Map<string, { workflowKey: string | null; orgId: string | null }>()
  for (const row of result.rows) {
    const id = asText(row.id)
    if (!id) continue
    byId.set(id, {
      workflowKey: asText(row.workflow_key),
      orgId: asText(row.org_id),
    })
  }

  const kept: string[] = []
  for (const id of candidateIds) {
    const meta = byId.get(id)
    if (!meta) {
      // Unknown id: keep so per-instance path can emit not-found (byte-compatible for non-attendance).
      kept.push(id)
      continue
    }
    if (meta.workflowKey !== ATTENDANCE_APPROVAL_WORKFLOW_KEY) {
      kept.push(id)
      continue
    }
    // Attendance: require joinable org + authority.
    if (!meta.orgId) continue
    if (isPlatformAdmin) {
      kept.push(id)
      continue
    }
    if (await actorHasOrgLocalAttendanceReassignAuthority(client, actorId, meta.orgId)) {
      kept.push(id)
    }
  }
  return kept
}

/** Map hooks error → ServiceError-compatible shape for callers. */
export function attendanceCentralApprovalErrorToServiceFields(
  error: unknown,
): { statusCode: number; code: string; message: string } | null {
  if (error instanceof AttendanceCentralApprovalError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
    }
  }
  return null
}
