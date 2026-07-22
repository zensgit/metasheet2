/**
 * FWB-0 Layer 2 — transaction-local authorization for record-link only.
 *
 * Why this module exists (P1 review):
 *   Shared request/user-keyed helpers that call global-pool `isAdmin` / `listUserPermissions`
 *   (with cache) are not safe as final record-link authority: passing a txn `queryFn` into a
 *   helper that still hits the global pool does NOT bind admin/permission reads to the approval
 *   transaction, so a concurrent revoke can be masked by cache or a separate autocommit connection.
 *
 * Authoritative record-link path: `resolveBaseReadableForUserOnQuery` /
 * `resolveSheetCapabilitiesForUserOnQuery` / `resolveRecordLinkTargetAuthOnQuery` — every
 * permission/admin/owner/scope read goes through the supplied `QueryFn` with **no global cache**.
 * This module does NOT reintroduce weaker global-pool base-read wrappers.
 *
 * Core authority shape (P2): missing base / missing sheet / mismatch / unreadable always execute
 * the same ordered authority stages (base lookup + admin + permission codes + owner eval + sheet
 * scope). The system-owned projection fence may add read-plane probes for a non-admin target;
 * callers must not treat query count as an existence-hiding boundary. Evaluation fails closed.
 */
import {
  BASE_READ_PERMISSION_CODES,
  loadApprovalProjectionParticipantSheetIds,
  loadApprovalProjectionSheetIds,
  loadSheetPermissionScopeMap,
  type QueryFn,
} from '../multitable/permission-service'
import { restrictApprovalProjectionCapabilitiesPerRow } from '../multitable/approval-projection-constants'
import {
  deriveCapabilities,
  applyContextSheetSchemaWriteGrant,
  type MultitableCapabilities,
} from '../multitable/sheet-capabilities'

/** Ordered stages for base-authority probes (always all four, even when base is missing). */
export const RECORD_LINK_BASE_AUTH_STAGES = [
  'base_lookup',
  'admin_role',
  'permission_codes',
  'owner_eval',
] as const

/** Ordered stages for the dual base+sheet target gate used by picker + submit. */
export const RECORD_LINK_TARGET_AUTH_STAGES = [
  'sheet_membership',
  'base_lookup',
  'admin_role',
  'permission_codes',
  'owner_eval',
  'sheet_scope',
  'sheet_cap_eval',
] as const

export type RecordLinkBaseAuthStage = (typeof RECORD_LINK_BASE_AUTH_STAGES)[number]
export type RecordLinkTargetAuthStage = (typeof RECORD_LINK_TARGET_AUTH_STAGES)[number]

function pushStage(transcript: string[] | undefined, stage: string): void {
  transcript?.push(stage)
}

/**
 * Admin check via the supplied query only (user_roles). No global pool, no cache.
 */
export async function isAdminOnQuery(query: QueryFn, userId: string): Promise<boolean> {
  const normalized = userId.trim()
  if (!normalized) return false
  try {
    const res = await query(
      'SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2 LIMIT 1',
      [normalized, 'admin'],
    )
    return res.rows.length > 0
  } catch {
    return false
  }
}

/**
 * Effective permission codes via the supplied query only:
 *   user_permissions ∪ role_permissions ∪ legacy users.permissions
 * No global pool, no cache, no namespace-admission side channel (multitable codes are
 * non-namespaced; record-link only needs multitable/spreadsheet grants).
 */
export async function listUserPermissionsOnQuery(
  query: QueryFn,
  userId: string,
): Promise<string[]> {
  const normalized = userId.trim()
  if (!normalized) return []
  try {
    const { rows } = await query(
      `SELECT DISTINCT permission_code AS code FROM (
         SELECT up.permission_code FROM user_permissions up WHERE up.user_id = $1
         UNION ALL
         SELECT rp.permission_code
           FROM user_roles ur
           JOIN role_permissions rp ON rp.role_id = ur.role_id
          WHERE ur.user_id = $1
       ) t`,
      [normalized],
    )
    const codes = (rows as Array<{ code?: unknown }>)
      .map((r) => (typeof r.code === 'string' ? r.code.trim() : ''))
      .filter(Boolean)
    let legacy: string[] = []
    try {
      const legacyRes = await query('SELECT permissions FROM users WHERE id = $1', [normalized])
      const raw = (legacyRes.rows[0] as { permissions?: unknown } | undefined)?.permissions
      if (Array.isArray(raw)) {
        legacy = raw
          .map((p) => (typeof p === 'string' ? p.trim() : ''))
          .filter(Boolean)
      }
    } catch {
      legacy = []
    }
    return Array.from(new Set([...codes, ...legacy]))
  } catch {
    return []
  }
}

/**
 * Deterministic lock order for every DB write-authority source the record-link create final path
 * actually consumes (readers: isAdminOnQuery, listUserPermissionsOnQuery,
 * resolveBaseReadableForUserOnQuery, resolveSheetCapabilitiesForUserOnQuery /
 * loadSheetPermissionScopeMap, sheet membership via meta_sheets).
 *
 * Multi-target create MUST use globally phased acquisition (see
 * `lockRecordLinkMultiTargetAuthorityPhasedOnQuery` /
 * `lockRecordLinkMultiTargetCreatePathOnQuery`):
 *   Phase 1 — ALL target meta_bases (sorted baseId)
 *   Phase 2 — ALL target meta_sheets (sorted sheetId)
 *   Phase 3 — actor-wide authority rows ONCE (user_roles → roles → role_permissions →
 *             user_permissions → users → platform_member_group_members)
 *   Phase 4 — spreadsheet_permissions for ALL target sheets (sorted sheetId)
 *   Phase 5 — (create only) row-auth advisory + meta_records FOR UPDATE per target
 *             in canonical (baseId, sheetId, recordId) order
 *   Phase 6 — re-read every authorization (no further lock acquisition)
 *
 * Why phases (not “sort candidates then lock per candidate”):
 *   Keep one canonical order across every caller and acquire every authority source before
 *   target-record write locks. Authority reads use FOR SHARE so peer creates remain compatible;
 *   the global phase order also avoids reintroducing a lock-order cycle if a source later needs
 *   an incompatible mode.
 *
 * Single-target `lockRecordLinkAuthorityRowsOnQuery` remains the convenience wrapper
 * (publish one pin, revoke writers) and uses the same phase order for one target.
 *
 * The projection participant read also consults meta_records, but it can only restore read/export
 * capability; it never restores create/edit/manage authority. The create path separately locks
 * and rechecks each selected target row. It is intentionally outside this authority lock list.
 *
 * Fail-closed: lock errors on core tables rethrow. Only undefined-table (42P01) for the
 * optional platform_member_group_members relation is soft. Final create write is DB/admin only.
 */
export const RECORD_LINK_AUTHORITY_LOCK_ORDER = [
  'meta_bases',
  'meta_sheets',
  'user_roles',
  'roles',
  'role_permissions',
  'user_permissions',
  'users',
  'platform_member_group_members',
  'spreadsheet_permissions',
] as const

/** Multi-target create-path lock phases (for tests / documentation). */
export const RECORD_LINK_MULTI_TARGET_LOCK_PHASES = [
  'target_bases',
  'target_sheets',
  'actor_authority',
  'sheet_grants',
  'row_auth_and_records',
] as const

export type RecordLinkCreateLockTarget = {
  baseId: string
  sheetId: string
  recordId: string
}

function isUndefinedTableError(err: unknown, tableName: string): boolean {
  const code = typeof (err as { code?: unknown })?.code === 'string'
    ? (err as { code: string }).code
    : null
  const message = typeof (err as { message?: unknown })?.message === 'string'
    ? (err as { message: string }).message
    : ''
  if (code === '42P01') return message.includes(tableName)
  return message.includes(`relation "${tableName}" does not exist`)
}

function uniqueSortedIds(ids: readonly string[]): string[] {
  const set = new Set<string>()
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id) set.add(id)
  }
  return Array.from(set).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function normalizeCreateLockTargets(
  targets: ReadonlyArray<RecordLinkCreateLockTarget>,
): RecordLinkCreateLockTarget[] {
  const seen = new Set<string>()
  const out: RecordLinkCreateLockTarget[] = []
  for (const t of targets) {
    const baseId = typeof t.baseId === 'string' ? t.baseId.trim() : ''
    const sheetId = typeof t.sheetId === 'string' ? t.sheetId.trim() : ''
    const recordId = typeof t.recordId === 'string' ? t.recordId.trim() : ''
    if (!baseId || !sheetId || !recordId) continue
    const key = `${baseId}\0${sheetId}\0${recordId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ baseId, sheetId, recordId })
  }
  out.sort((a, b) => {
    if (a.baseId !== b.baseId) return a.baseId < b.baseId ? -1 : 1
    if (a.sheetId !== b.sheetId) return a.sheetId < b.sheetId ? -1 : 1
    if (a.recordId !== b.recordId) return a.recordId < b.recordId ? -1 : 1
    return 0
  })
  return out
}

/** Phase 1: lock all target base rows in sorted baseId order. */
export async function lockRecordLinkTargetBasesOnQuery(
  query: QueryFn,
  baseIds: readonly string[],
): Promise<void> {
  for (const bid of uniqueSortedIds(baseIds)) {
    await query(`SELECT id FROM meta_bases WHERE id = $1 FOR SHARE`, [bid])
  }
}

/** Phase 2: lock all target sheet rows in sorted sheetId order. */
export async function lockRecordLinkTargetSheetsOnQuery(
  query: QueryFn,
  sheetIds: readonly string[],
): Promise<void> {
  for (const sid of uniqueSortedIds(sheetIds)) {
    await query(`SELECT id FROM meta_sheets WHERE id = $1 FOR SHARE`, [sid])
  }
}

/**
 * Phase 3: actor-wide authority rows once (shared across every target).
 * Returns roleIds + groupIds for subsequent sheet-grant locks.
 */
export async function lockRecordLinkActorAuthorityRowsOnQuery(
  query: QueryFn,
  userId: string,
): Promise<{ roleIds: string[]; groupIds: string[] }> {
  const uid = userId.trim()
  if (!uid) return { roleIds: [], groupIds: [] }

  const rolesRes = await query(
    `SELECT role_id FROM user_roles WHERE user_id = $1 FOR SHARE`,
    [uid],
  )
  const roleIds = (rolesRes.rows as Array<{ role_id?: unknown }>)
    .map((r) => (typeof r.role_id === 'string' ? r.role_id.trim() : ''))
    .filter(Boolean)

  if (roleIds.length > 0) {
    await query(
      `SELECT id, name FROM roles WHERE id = ANY($1::text[]) FOR SHARE`,
      [roleIds],
    )
    await query(
      `SELECT role_id, permission_code FROM role_permissions
       WHERE role_id = ANY($1::text[]) FOR SHARE`,
      [roleIds],
    )
  }

  await query(
    `SELECT permission_code FROM user_permissions WHERE user_id = $1 FOR SHARE`,
    [uid],
  )

  await query(
    `SELECT id FROM users WHERE id = $1 FOR SHARE`,
    [uid],
  )

  // Optional relation: must use a SAVEPOINT so a 42P01 does not abort the surrounding txn
  // (bare try/catch of a failed query still leaves the xact in aborted state → 25P02).
  let groupIds: string[] = []
  try {
    await query('SAVEPOINT record_link_actor_groups')
    try {
      const groupsRes = await query(
        `SELECT group_id FROM platform_member_group_members WHERE user_id = $1 FOR SHARE`,
        [uid],
      )
      groupIds = (groupsRes.rows as Array<{ group_id?: unknown }>)
        .map((r) => {
          if (typeof r.group_id === 'string') return r.group_id.trim()
          if (r.group_id != null) return String(r.group_id).trim()
          return ''
        })
        .filter(Boolean)
      await query('RELEASE SAVEPOINT record_link_actor_groups')
    } catch (err) {
      try {
        await query('ROLLBACK TO SAVEPOINT record_link_actor_groups')
      } catch {
        // ignore nested rollback failures; outer path rethrows non-optional errors
      }
      if (!isUndefinedTableError(err, 'platform_member_group_members')) throw err
      groupIds = []
    }
  } catch (err) {
    // SAVEPOINT itself failed (e.g. not in a transaction) — soft only for undefined table.
    if (!isUndefinedTableError(err, 'platform_member_group_members')) throw err
    groupIds = []
  }

  return { roleIds, groupIds }
}

/**
 * Phase 4: sheet-scoped grants for every target sheet (sorted sheetId), using the
 * actor role/group sets already locked in phase 3.
 */
export async function lockRecordLinkSheetGrantsOnQuery(
  query: QueryFn,
  input: {
    userId: string
    sheetIds: readonly string[]
    roleIds: readonly string[]
    groupIds: readonly string[]
  },
): Promise<void> {
  const uid = input.userId.trim()
  if (!uid) return
  for (const sid of uniqueSortedIds(input.sheetIds)) {
    await query(
      `SELECT sheet_id FROM spreadsheet_permissions
       WHERE sheet_id = $1
         AND (
           (subject_type = 'user' AND subject_id = $2)
           OR (subject_type = 'role' AND subject_id = ANY($3::text[]))
           OR (subject_type = 'member-group' AND subject_id = ANY($4::text[]))
         )
       FOR SHARE`,
      [sid, uid, input.roleIds, input.groupIds],
    )
  }
}

/**
 * Globally phased multi-target authority locks (phases 1–4). Does not lock row-auth /
 * meta_records — use `lockRecordLinkMultiTargetCreatePathOnQuery` for the full create path.
 *
 * @param options.interleavedPerCandidate — MUTATION ONLY. Restores the legacy per-candidate
 *   interleaving so phase-order tests can distinguish the production path. Never true in
 *   production; current shared authority locks make peer readers compatible either way.
 */
export async function lockRecordLinkMultiTargetAuthorityPhasedOnQuery(
  query: QueryFn,
  input: {
    userId: string
    targets: ReadonlyArray<{ baseId: string; sheetId: string }>
  },
  options: { interleavedPerCandidate?: boolean } = {},
): Promise<void> {
  const uid = input.userId.trim()
  if (!uid) return

  const pairs = input.targets
    .map((t) => ({
      baseId: typeof t.baseId === 'string' ? t.baseId.trim() : '',
      sheetId: typeof t.sheetId === 'string' ? t.sheetId.trim() : '',
    }))
    .filter((t) => t.baseId && t.sheetId)

  if (pairs.length === 0) return

  if (options.interleavedPerCandidate === true) {
    // Legacy interleaved order — retained only as a structural phase-order mutation.
    for (const t of pairs) {
      await lockRecordLinkAuthorityRowsOnQuery(query, {
        userId: uid,
        baseId: t.baseId,
        sheetId: t.sheetId,
      })
    }
    return
  }

  // Phase 1–2: all target bases, then all target sheets (canonical sorted ids).
  await lockRecordLinkTargetBasesOnQuery(query, pairs.map((p) => p.baseId))
  await lockRecordLinkTargetSheetsOnQuery(query, pairs.map((p) => p.sheetId))

  // Phase 3: actor-wide authority once.
  const { roleIds, groupIds } = await lockRecordLinkActorAuthorityRowsOnQuery(query, uid)

  // Phase 4: sheet grants for every target sheet.
  await lockRecordLinkSheetGrantsOnQuery(query, {
    userId: uid,
    sheetIds: pairs.map((p) => p.sheetId),
    roleIds,
    groupIds,
  })
}

/**
 * Full create-path multi-target lock (phases 1–5): authority phased + row-auth advisory +
 * meta_records FOR UPDATE in canonical target order. Callers re-read auth only AFTER this
 * resolves (phase 6). Preserves writer serialization with record_permissions PUT/DELETE
 * (same advisory + FOR UPDATE record_permissions).
 *
 * @param options.interleavedPerCandidate — MUTATION ONLY (see multi-target authority helper).
 */
export async function lockRecordLinkMultiTargetCreatePathOnQuery(
  query: QueryFn,
  input: {
    userId: string
    targets: ReadonlyArray<RecordLinkCreateLockTarget>
  },
  options: { interleavedPerCandidate?: boolean } = {},
): Promise<void> {
  const uid = input.userId.trim()
  if (!uid) return

  const targets = normalizeCreateLockTargets(input.targets)
  if (targets.length === 0) return

  if (options.interleavedPerCandidate === true) {
    const { acquireRecordLinkRowAuthLockOnQuery } = await import('./approval-record-link-row-auth-lock')
    for (const t of targets) {
      await lockRecordLinkAuthorityRowsOnQuery(query, {
        userId: uid,
        baseId: t.baseId,
        sheetId: t.sheetId,
      })
      await acquireRecordLinkRowAuthLockOnQuery(query, t.sheetId, t.recordId)
      await query(
        `SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE`,
        [t.recordId, t.sheetId],
      )
    }
    return
  }

  // Phases 1–4 (DEFAULT: global phases — not per-candidate interleave)
  await lockRecordLinkMultiTargetAuthorityPhasedOnQuery(query, {
    userId: uid,
    targets: targets.map((t) => ({ baseId: t.baseId, sheetId: t.sheetId })),
  })

  // Phase 5: row-auth + target records in canonical (baseId, sheetId, recordId) order.
  const { acquireRecordLinkRowAuthLockOnQuery } = await import('./approval-record-link-row-auth-lock')
  for (const t of targets) {
    await acquireRecordLinkRowAuthLockOnQuery(query, t.sheetId, t.recordId)
    await query(
      `SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE`,
      [t.recordId, t.sheetId],
    )
  }
}

/**
 * Single-target authority lock convenience (one pin). Same phase order as multi-target
 * for one base/sheet — used by publish single-pin paths and legacy callers.
 */
export async function lockRecordLinkAuthorityRowsOnQuery(
  query: QueryFn,
  input: { userId: string; baseId: string; sheetId: string },
): Promise<void> {
  const uid = input.userId.trim()
  const bid = input.baseId.trim()
  const sid = input.sheetId.trim()
  if (!uid) return

  if (bid) {
    await query(`SELECT id FROM meta_bases WHERE id = $1 FOR SHARE`, [bid])
  }
  if (sid) {
    await query(`SELECT id FROM meta_sheets WHERE id = $1 FOR SHARE`, [sid])
  }

  const { roleIds, groupIds } = await lockRecordLinkActorAuthorityRowsOnQuery(query, uid)

  if (sid) {
    await lockRecordLinkSheetGrantsOnQuery(query, {
      userId: uid,
      sheetIds: [sid],
      roleIds,
      groupIds,
    })
  }
}

function hasApprovalsWriteCode(codes: readonly string[]): boolean {
  return (
    codes.includes('approvals:write')
    || codes.includes('approvals:*')
    || codes.includes('*:*')
  )
}

type ApprovalDbIdentity = {
  user: {
    role?: unknown
    department?: unknown
    is_admin?: unknown
    is_active?: unknown
  } | undefined
  roles: Set<string>
}

/** One DB identity source for both final approvals:write and template visibility. */
async function loadApprovalDbIdentityOnQuery(query: QueryFn, uid: string): Promise<ApprovalDbIdentity> {
  const userResult = await query(
    `SELECT role, department, is_admin, is_active
     FROM users
     WHERE id = $1`,
    [uid],
  )
  const user = userResult.rows[0] as ApprovalDbIdentity['user']
  const roles = new Set<string>()
  if (typeof user?.role === 'string' && user.role.trim()) roles.add(user.role.trim())
  // A present disabled profile is authoritative; do not let stale normalized roles revive it.
  if (user?.is_active === false) return { user, roles }

  const roleResult = await query(
    `SELECT ur.role_id, r.name
     FROM user_roles ur
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1`,
    [uid],
  )
  for (const row of roleResult.rows as Array<{ role_id?: unknown; name?: unknown }>) {
    if (typeof row.role_id === 'string' && row.role_id.trim()) roles.add(row.role_id.trim())
    if (typeof row.name === 'string' && row.name.trim()) roles.add(row.name.trim())
  }
  return { user, roles }
}

/**
 * approvals:write at the final write boundary (txn-local DB/admin only).
 *
 * Default DENY. Empty DB permission codes never imply allow.
 *
 * Allow only when:
 *   1) admin role (via queryFn), or
 *   2) DB codes (user_permissions ∪ role_permissions ∪ legacy users.permissions) include
 *      approvals:write / approvals:* / *:*
 *
 * Intentionally does NOT accept request/JWT/actor.permissions as authority: those are often
 * DB-hydrated without provenance and can freeze stale write after a concurrent DB revoke.
 * Route-level JWT may still gate entry; the final create recheck is DB-only.
 */
export async function userHasApprovalsWriteOnQuery(
  query: QueryFn,
  userId: string,
): Promise<boolean> {
  const uid = userId.trim()
  if (!uid) return false
  // Match the DB-backed admin identities used by the template-visibility boundary and route
  // actor: users.is_admin, legacy users.role, user_roles role id, or joined role name. The actor
  // authority rows are already locked before this final check, so none of these reads can retain
  // a concurrently revoked admin grant.
  try {
    const identity = await loadApprovalDbIdentityOnQuery(query, uid)
    if (identity.user?.is_active === false) return false
    if (identity.user?.is_admin === true || identity.roles.has('admin')) return true
  } catch {
    // Fall through to explicit DB permission codes. Any read failure remains fail-closed.
  }
  const codes = await listUserPermissionsOnQuery(query, uid)
  return hasApprovalsWriteCode(codes)
}

/**
 * Rebuild the template-visibility actor from the supplied query only. The create path calls this
 * after locking the same actor authority rows, so request/JWT role, department and permission
 * snapshots cannot preserve a revoked template-manager bypass at the final write boundary.
 *
 * A missing `users` profile is not an authentication failure: dev/external identities can have
 * normalized user_roles/user_permissions without a local profile row. Such actors keep their
 * stable userId and DB grants, but have no profile-derived department/role/admin authority.
 */
export async function loadApprovalTemplateVisibilityActorOnQuery(
  query: QueryFn,
  userId: string,
): Promise<{
  userId: string
  departmentIds: string[]
  roles: string[]
  permissions: string[]
  isTemplateManager: boolean
} | null> {
  const uid = userId.trim()
  if (!uid) return null

  try {
    const { user, roles } = await loadApprovalDbIdentityOnQuery(query, uid)
    // A missing profile is valid for dev/external identities, but a present disabled profile is
    // authoritative and must not retain template visibility through role/permission rows.
    if (user?.is_active === false) return null

    const permissions = await listUserPermissionsOnQuery(query, uid)
    const isTemplateManager = user?.is_admin === true
      || roles.has('admin')
      || permissions.includes('approval-templates:manage')
      || permissions.includes('approvals:admin-templates')
      || permissions.includes('approvals:*')
      || permissions.includes('*:*')

    return {
      userId: uid,
      departmentIds: typeof user?.department === 'string' && user.department.trim()
        ? [user.department.trim()]
        : [],
      roles: [...roles],
      permissions,
      isTemplateManager,
    }
  } catch {
    return null
  }
}

/**
 * Base READ via queryFn only — constant-shape stages even when the base row is missing.
 * Missing base still runs admin_role + permission_codes before returning false.
 */
export async function resolveBaseReadableForUserOnQuery(
  query: QueryFn,
  userId: string | null | undefined,
  baseId: string,
  transcript?: string[],
): Promise<boolean> {
  const normalizedUserId = typeof userId === 'string' ? userId.trim() : ''
  const normalizedBaseId = baseId.trim()
  if (!normalizedUserId || !normalizedBaseId) {
    // Still emit a fixed-length stage list for empty identity/base so callers comparing
    // transcripts across outcomes are not confused by a shorter path.
    for (const stage of RECORD_LINK_BASE_AUTH_STAGES) pushStage(transcript, stage)
    return false
  }

  pushStage(transcript, 'base_lookup')
  let baseRow: { owner_id?: unknown } | undefined
  try {
    const baseRes = await query(
      'SELECT owner_id FROM meta_bases WHERE id = $1 AND deleted_at IS NULL',
      [normalizedBaseId],
    )
    baseRow = (baseRes.rows as Array<{ owner_id?: unknown }>)[0]
  } catch {
    baseRow = undefined
  }
  const baseExists = Boolean(baseRow)

  pushStage(transcript, 'admin_role')
  const admin = await isAdminOnQuery(query, normalizedUserId)

  pushStage(transcript, 'permission_codes')
  const codes = await listUserPermissionsOnQuery(query, normalizedUserId)
  const hasBaseRead = codes.some((code) => BASE_READ_PERMISSION_CODES.has(code))

  pushStage(transcript, 'owner_eval')
  const ownerId = typeof baseRow?.owner_id === 'string' ? baseRow.owner_id.trim() : ''
  const isOwner = Boolean(ownerId) && ownerId === normalizedUserId

  return baseExists && (admin || hasBaseRead || isOwner)
}

/**
 * Sheet canRead via queryFn only (admin + global codes + sheet-scoped grants).
 * Uses loadSheetPermissionScopeMap(query, …) — already queryFn-bound.
 */
export async function resolveSheetCapabilitiesForUserOnQuery(
  query: QueryFn,
  sheetId: string,
  userId: string,
  transcript?: string[],
  /**
   * Optional precomputed admin/codes from a prior constant-shape dual-gate stage so the
   * dual gate does not re-query admin/permissions (stage order stays one admin + one codes).
   */
  precomputed?: { isAdminRole: boolean; permissions: string[] },
): Promise<{
  isAdminRole: boolean
  capabilities: Pick<
    MultitableCapabilities,
    'canRead' | 'canEditRecord' | 'canCreateRecord' | 'canManageSheetAccess'
  >
  permissions: string[]
}> {
  const normalizedUserId = userId.trim()
  const normalizedSheetId = sheetId.trim()

  let isAdminRole = precomputed?.isAdminRole
  let permissions = precomputed?.permissions
  if (isAdminRole === undefined || permissions === undefined) {
    pushStage(transcript, 'admin_role')
    isAdminRole = await isAdminOnQuery(query, normalizedUserId)
    pushStage(transcript, 'permission_codes')
    permissions = await listUserPermissionsOnQuery(query, normalizedUserId)
  }

  pushStage(transcript, 'sheet_scope')
  let sheetScope
  try {
    const scopeMap = await loadSheetPermissionScopeMap(query, [normalizedSheetId], normalizedUserId)
    sheetScope = scopeMap.get(normalizedSheetId)
  } catch {
    sheetScope = undefined
  }

  pushStage(transcript, 'sheet_cap_eval')
  const baseCapabilities = deriveCapabilities(permissions, isAdminRole)
  let capabilities = applyContextSheetSchemaWriteGrant(baseCapabilities, sheetScope, isAdminRole)

  // Preserve the system-owned approval projection fence from the request-bound resolver. This
  // query-bound path is used at write boundaries, so dropping canManageSheetAccess here would let
  // a non-admin mutate projection record permissions merely by reaching the transactional path.
  if (!isAdminRole && (await loadApprovalProjectionSheetIds(query, [normalizedSheetId])).has(normalizedSheetId)) {
    const isParticipant = (
      await loadApprovalProjectionParticipantSheetIds(query, [normalizedSheetId], normalizedUserId)
    ).has(normalizedSheetId)
    capabilities = restrictApprovalProjectionCapabilitiesPerRow(
      capabilities,
      true,
      false,
      isParticipant,
    )
  }

  return {
    isAdminRole,
    capabilities: {
      canRead: capabilities.canRead === true,
      canEditRecord: capabilities.canEditRecord === true,
      canCreateRecord: capabilities.canCreateRecord === true,
      canManageSheetAccess: capabilities.canManageSheetAccess === true,
    },
    permissions,
  }
}

export type RecordLinkTargetAuthResult = {
  ok: boolean
  membershipOk: boolean
  baseReadable: boolean
  sheetReadable: boolean
  isAdminRole: boolean
  capabilities: { canRead: boolean; canEditRecord: boolean; canCreateRecord: boolean }
  /** Ordered stage names for parity tests (always RECORD_LINK_TARGET_AUTH_STAGES). */
  stages: string[]
}

/**
 * Dual base+sheet auth for a pinned (baseId, sheetId) target — constant-shape.
 * Always runs every stage in RECORD_LINK_TARGET_AUTH_STAGES regardless of membership /
 * missing base / unreadable outcomes. Public callers map any failure to one refuse shape.
 */
export async function resolveRecordLinkTargetAuthOnQuery(
  query: QueryFn,
  input: { userId: string; baseId: string; sheetId: string },
  transcript?: string[],
): Promise<RecordLinkTargetAuthResult> {
  const stages = transcript ?? []
  const userId = input.userId.trim()
  const baseId = input.baseId.trim()
  const sheetId = input.sheetId.trim()

  pushStage(stages, 'sheet_membership')
  let membershipOk = false
  try {
    const sheetRes = await query(
      `SELECT id, base_id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL`,
      [sheetId],
    )
    const sheetRow = sheetRes.rows[0] as { id?: unknown; base_id?: unknown } | undefined
    membershipOk =
      Boolean(sheetRow)
      && typeof sheetRow?.base_id === 'string'
      && sheetRow.base_id === baseId
  } catch {
    membershipOk = false
  }

  // Base authority — always all four stages (including when base is missing).
  pushStage(stages, 'base_lookup')
  let baseRow: { owner_id?: unknown } | undefined
  try {
    const baseRes = await query(
      'SELECT owner_id FROM meta_bases WHERE id = $1 AND deleted_at IS NULL',
      [baseId],
    )
    baseRow = (baseRes.rows[0] as { owner_id?: unknown } | undefined)
  } catch {
    baseRow = undefined
  }
  const baseExists = Boolean(baseRow)

  pushStage(stages, 'admin_role')
  const isAdminRole = userId ? await isAdminOnQuery(query, userId) : false

  pushStage(stages, 'permission_codes')
  const permissions = userId ? await listUserPermissionsOnQuery(query, userId) : []
  const hasBaseRead = permissions.some((code) => BASE_READ_PERMISSION_CODES.has(code))

  pushStage(stages, 'owner_eval')
  const ownerId = typeof baseRow?.owner_id === 'string' ? baseRow.owner_id.trim() : ''
  const isOwner = Boolean(ownerId) && Boolean(userId) && ownerId === userId
  const baseReadable = baseExists && (isAdminRole || hasBaseRead || isOwner)

  // Sheet capabilities — reuses admin/permissions already loaded (no second global hop).
  const sheetCaps = await resolveSheetCapabilitiesForUserOnQuery(
    query,
    sheetId,
    userId,
    stages,
    { isAdminRole, permissions },
  )
  const sheetReadable = sheetCaps.isAdminRole || sheetCaps.capabilities.canRead === true

  return {
    ok: membershipOk && baseReadable && sheetReadable,
    membershipOk,
    baseReadable,
    sheetReadable,
    isAdminRole: sheetCaps.isAdminRole,
    capabilities: sheetCaps.capabilities,
    stages,
  }
}
