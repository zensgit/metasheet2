import type { Request } from 'express'
import { normalizePermissionCodes, deriveCapabilities, type ResolvedRequestAccess } from './access'
import { canReadWithSheetGrant, filterReadableSheetRowsForAccess, hasRecordPermissionAssignments, loadRecordPermissionScopeMap, loadViewPermissionScopeMap, loadFieldPermissionScopeMap, loadRowLevelReadDenyEnabledStrict, resolveSheetCapabilitiesForAccess, type QueryFn } from './permission-service'
import { deriveRecordPermissions, deriveViewPermissions, deriveFieldPermissions } from './permission-derivation'
import { serializeFieldRow } from './field-codecs'
import { isHiddenSystemSheet } from './system-sheet-predicate'
import { isElearningProjectionSheetIdCandidate } from './elearning-projection-constants'
import type { GuardLookups } from '../rbac/rbac'
import { readStrictPrincipal } from '../rbac/strict-principal'

export type ResourceDecision = 'allow' | 'deny' | 'unknown'
export type SheetContextResult = { visibility: ResourceDecision; context: ResourceDecision }
const unknown: SheetContextResult = { visibility: 'unknown', context: 'unknown' }
export class ResourceCheckUnavailable extends Error {}

async function requestAccess(req: Request, lookups: GuardLookups): Promise<ResolvedRequestAccess> {
  const user = req.user
  const userId = user?.id?.toString() || ''
  const roles = normalizePermissionCodes(user?.roles)
  const tokenPermissions = normalizePermissionCodes(user?.perms)
  const resolved = normalizePermissionCodes(user?.permissions)
  const isAdminRole = user?.role === 'admin' || roles.includes('admin')
  const direct = tokenPermissions.length ? tokenPermissions : resolved
  const tenant = typeof req.authenticatedTenantId === 'string' && req.authenticatedTenantId.trim()
    ? { authenticatedTenantId: req.authenticatedTenantId.trim() } : {}
  if (!userId || isAdminRole || direct.length) return { userId, permissions: direct, isAdminRole, ...tenant }
  return { userId, permissions: await lookups.listPermissions(userId), isAdminRole: await lookups.isAdmin(userId), ...tenant }
}

/** Resource and capability layers for the registered context and record reads. */
export async function checkSheetContext(
  runQuery: QueryFn, req: Request, lookups: GuardLookups,
  subject: { kind: 'self' } | { kind: 'target'; userId: string },
  resource: { baseId: string; sheetId: string; recordId?: string; viewId?: string; fieldId?: string },
): Promise<SheetContextResult> {
  let count = 0
  const startedAt = Date.now()
  let queryFailed = false
  const query: QueryFn = async (sql, params) => {
    if (++count > 80 || Date.now() - startedAt > 5000) throw new ResourceCheckUnavailable()
    try {
      const result = await runQuery(sql, params)
      if (result.rows.length > 1000 || Date.now() - startedAt > 5000) throw new ResourceCheckUnavailable()
      return result
    } catch (error) {
      queryFailed = true
      throw error
    }
  }
  try {
    // Every graceful fallback traversed by this path must have its schema before it can prove allow.
    await query('SELECT id, base_id, deleted_at, description FROM meta_sheets LIMIT 0')
    await query('SELECT id, deleted_at FROM meta_bases LIMIT 0')
    await query('SELECT sheet_id, perm_code, subject_type, subject_id FROM spreadsheet_permissions LIMIT 0')
    await query('SELECT user_id, group_id FROM platform_member_group_members LIMIT 0')
    await query('SELECT user_id, role_id FROM user_roles LIMIT 0')
    if (resource.fieldId) {
      await query('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields LIMIT 0')
      await query('SELECT sheet_id, field_id, subject_type, subject_id, visible, read_only FROM field_permissions LIMIT 0')
    }
    if (resource.viewId) {
      await query('SELECT id, sheet_id FROM meta_views LIMIT 0')
      await query('SELECT view_id, permission, subject_type, subject_id FROM meta_view_permissions LIMIT 0')
    }
    if (resource.recordId) {
      await query('SELECT row_level_read_permissions_enabled, conditional_read_rules FROM meta_sheets LIMIT 0')
      await query('SELECT id, sheet_id, data, created_by FROM meta_records LIMIT 0')
      await query('SELECT id, sheet_id, type FROM meta_fields LIMIT 0')
      await query('SELECT sheet_id, record_id, access_level, subject_type, subject_id FROM record_permissions LIMIT 0')
    }
    const rows = await query(`SELECT s.id, s.description, to_jsonb(s)->>'system_kind' AS system_kind
      FROM meta_sheets s JOIN meta_bases b ON b.id = s.base_id
      WHERE s.id = $1 AND s.base_id = $2 AND s.deleted_at IS NULL AND b.deleted_at IS NULL`, [resource.sheetId, resource.baseId])
    const sheet = rows.rows[0] as { id: string; description?: unknown; system_kind?: unknown } | undefined
    if (!sheet || isHiddenSystemSheet(sheet)) return unknown
    const visible = async (access: ResolvedRequestAccess): Promise<boolean> => {
      const resolved = await resolveSheetCapabilitiesForAccess(query, resource.sheetId, access)
      if (queryFailed) throw new ResourceCheckUnavailable()
      if (resolved.sheetLiveness !== 'live') return false
      if (!canReadWithSheetGrant(deriveCapabilities(access.permissions, access.isAdminRole), resolved.sheetScope, access.isAdminRole)) return false
      if (!resolved.capabilities.canRead) return false
      const rows = await filterReadableSheetRowsForAccess(query, [sheet!], access)
      if (queryFailed) throw new ResourceCheckUnavailable()
      if (rows.length !== 1) return false
      if (resource.viewId) {
        const scopes = await loadViewPermissionScopeMap(query, [resource.viewId], access.userId)
        if (queryFailed) throw new ResourceCheckUnavailable()
        const view = deriveViewPermissions([{ id: resource.viewId }], resolved.capabilities, scopes)[resource.viewId]
        if (!view?.canAccess) return false
      }
      if (resource.recordId && !access.isAdminRole) {
        const assigned = await hasRecordPermissionAssignments(query, resource.sheetId)
        if (assigned) {
          const scope = await loadRecordPermissionScopeMap(query, resource.sheetId, [resource.recordId], access.userId)
          const flag = await loadRowLevelReadDenyEnabledStrict(query, resource.sheetId)
          if (queryFailed) throw new ResourceCheckUnavailable()
          if (scope.size && !deriveRecordPermissions(resource.recordId, resolved.capabilities, scope, flag).canRead) return false
        }
      }
      if (resource.fieldId) {
        const fields = await query('SELECT id, name, type, property, "order" FROM meta_fields WHERE id = $1 AND sheet_id = $2', [resource.fieldId, resource.sheetId])
        const raw = fields.rows[0]
        const field = raw ? serializeFieldRow(raw) : undefined
        // Formula and lookup values can be tainted by other sheets. Those require the full projection adapter.
        if (!field || !['string', 'number', 'select', 'date', 'boolean'].includes(field.type)) throw new ResourceCheckUnavailable()
        const scopes = await loadFieldPermissionScopeMap(query, resource.sheetId, access.userId)
        if (queryFailed) throw new ResourceCheckUnavailable()
        if (!deriveFieldPermissions([field], resolved.capabilities, { hiddenFieldIds: [], fieldScopeMap: scopes })[field.id]?.visible) return false
      }
      return true
    }
    const caller = await requestAccess(req, lookups)
    if (!caller.userId || !await visible(caller)) return unknown
    if (resource.viewId) {
      const view = await query('SELECT id FROM meta_views WHERE id = $1 AND sheet_id = $2', [resource.viewId, resource.sheetId])
      if (view.rows.length !== 1) return unknown
    }
    if (resource.recordId) {
      const record = await query('SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2', [resource.recordId, resource.sheetId])
      if (record.rows.length !== 1) return unknown
    }
    if (subject.kind === 'self') return { visibility: 'allow', context: 'allow' }
    if (process.env.RBAC_TOKEN_TRUST === 'true' || process.env.RBAC_TOKEN_TRUST === '1') return { visibility: 'allow', context: 'unknown' }
    const principal = await readStrictPrincipal(query, subject.userId)
    if (!principal) return { visibility: 'allow', context: 'unknown' }
    const admin = principal.role === 'admin' || await lookups.isAdmin(subject.userId)
    const permissions = await lookups.listPermissions(subject.userId)
    // A non-admin projection decision depends on that subject's authenticated tenant claim.
    if (!admin && isElearningProjectionSheetIdCandidate(resource.sheetId)) return { visibility: 'allow', context: 'unknown' }
    const target = { userId: subject.userId, permissions, isAdminRole: admin }
    return { visibility: 'allow', context: await visible(target) ? 'allow' : 'deny' }
  } catch {
    throw new ResourceCheckUnavailable()
  }
}
