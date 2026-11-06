import { deriveCapabilities, type ResolvedRequestAccess } from '../multitable/access'
import {
  AUTHORIZATION_PROTOCOL_GAPS, AUTHORIZATION_VERSION_CONFLICT_SQLSTATES, isAuthorizationVersionConflict, lockAuthorizationVersionsForAdmission,
} from '../multitable/authz-version-protocol'
import { loadFieldsForSheet } from '../multitable/loaders'
import { resolvePeopleSheetReadBound } from '../multitable/people-sheet-read-bound'
import { deriveFieldPermissions, deriveRecordPermissions, isFieldPermissionHidden } from '../multitable/permission-derivation'
import {
  hasRecordPermissionAssignments, loadDeniedRecordIds, loadFieldPermissionScopeMap, loadRecordPermissionScopeMap,
  loadRowLevelReadDenyEnabled, resolveSheetCapabilitiesForAccess, type QueryFn,
} from '../multitable/permission-service'
import {
  reauthorizeYidaSourceBinding, type YidaSourceReauthorizationDependencies, type YidaSourceReauthorizationQueryable,
  type YidaSourceReauthorizationVerdict,
} from './yida-sheet-source'

/**
 * Host wiring of the in-transaction re-authorization (design baseline v2.3 §7.2, D21; slice Y5) to the SAME
 * multitable permission primitives the draft-time sheet source uses (`yida-sheet-source-host.ts`), bound to the
 * caller's transaction instead of the pool. The actor is the service's trusted context (authentication plus the
 * live-authority rows it locked); the codes and admin-ness come from the rows the D21 helper locked on this `trx`.
 * Nothing here reads a request, the token or the RBAC cache: `resolveSheetCapabilitiesForAccess` is the entry that
 * takes an ALREADY-ADJUDICATED access snapshot (the recovery route's transaction-bound precedent), and the sheet
 * capability derivation it applies (`deriveCapabilities`) is the one every multitable read runs.
 *
 * Namespace admission does not shape these checks: `multitable:*` is not an admission-controlled resource
 * (`rbac/namespace-admission.ts deriveGrantNamespaces`), so the filter `listUserPermissions` applies cannot
 * remove a code the four checks consume; the locked codes are used unfiltered (pinned by the unit suite).
 *
 * Inputs of check 2 that no version row covers, and why none of them can move under an admission (Y5a review LOW):
 *   - `meta_sheets.base_id` (the approval-projection fence, `loadApprovalProjectionSheetIds`, and its per-row deny):
 *     no runtime writer changes an existing sheet's base (the only `SET base_id` on `meta_sheets` is the historical
 *     data migration `zzzz20260318110000`); a projection sheet is created as one and is never a registered project sheet;
 *   - the e-learning projection fence (`loadElearningProjectionSheetOrgMap`) applies only to `sht_el_stats_…` sheet ids,
 *     which the project-sheet registry (check 1) never names;
 *   - the stock-prep stamps (overview kind, grid-export closure) are `meta_sheets.system_kind` / `grid_export_closure`,
 *     which ARE watched columns of the sheet-layer trigger.
 * A raw SQL change of the first two is an operational act outside the protocol, like a `session_replication_role`
 * window: the send switch stays off while it happens.
 */
type Capabilities = Parameters<typeof deriveRecordPermissions>[1] & Parameters<typeof deriveFieldPermissions>[1]
const CONFLICT_SQLSTATES: ReadonlySet<string> = new Set(AUTHORIZATION_VERSION_CONFLICT_SQLSTATES)
/** The protocol's typed conflict, or a raw driver error of THIS transaction whose SQLSTATE is a lock conflict. */
function isLockConflict(error: unknown): boolean {
  if (isAuthorizationVersionConflict(error)) return true
  if (!error || typeof error !== 'object') return false
  const code = Object.getOwnPropertyDescriptor(error, 'code')
  return Boolean(code && Object.hasOwn(code, 'value') && typeof code.value === 'string' && CONFLICT_SQLSTATES.has(code.value))
}
const REGISTRY_FOR_SHARE_SQL = 'SELECT sheet_id, status FROM integration_stock_prep_project_target WHERE tenant_id = $1 AND project_no = $2 FOR SHARE'
const SESSION_REPLICATION_ROLE_SQL = "SELECT current_setting('session_replication_role') AS role"

function queryOf(trx: YidaSourceReauthorizationQueryable): QueryFn {
  return (sql, params) => trx.query(sql, params)
}

export function createYidaSourceReauthorizationHostDependencies(): YidaSourceReauthorizationDependencies {
  return Object.freeze({
    async lockAuthority(trx, input) {
      const locked = await lockAuthorizationVersionsForAdmission(trx, { sheetIds: [input.sheetId], actorId: input.actorId,
        tenantId: input.tenantId, recordId: input.recordId })
      return Object.freeze({ permissionCodes: Object.freeze([...locked.authority.permissionCodes]), isAdmin: locked.authority.isAdmin === true,
        record: locked.record ? Object.freeze({ recordId: locked.record.recordId, sheetId: locked.record.sheetId, data: locked.record.data,
          deletedAt: locked.record.deletedAt }) : null })
    },
    isLockConflict,
    protocolGaps: AUTHORIZATION_PROTOCOL_GAPS,
    async sessionReplicationRole(trx) {
      const result = await trx.query(SESSION_REPLICATION_ROLE_SQL)
      const row = (result.rows as Array<{ role?: unknown }>)[0]
      return result.rows.length === 1 && typeof row?.role === 'string' ? row.role : ''
    },
    async lockProjectRegistration(trx, { tenantId, projectNo }) {
      const result = await trx.query(REGISTRY_FOR_SHARE_SQL, [tenantId, projectNo])
      const rows = result.rows as Array<{ sheet_id?: unknown; status?: unknown }>
      // The scope index (087) makes (tenant, project) unique; anything but one row is "not registered".
      if (rows.length !== 1 || typeof rows[0].sheet_id !== 'string' || typeof rows[0].status !== 'string') return null
      return Object.freeze({ sheetId: rows[0].sheet_id, status: rows[0].status })
    },
    async resolveSheetAccess(trx, { sheetId, userId, tenantId, permissions, isAdminRole }) {
      const query = queryOf(trx)
      const access: ResolvedRequestAccess = { userId, permissions: [...permissions], isAdminRole, authenticatedTenantId: tenantId }
      const { capabilities, sheetLiveness } = await resolveSheetCapabilitiesForAccess(query, sheetId, access)
      const bound = await resolvePeopleSheetReadBound(query, sheetId)
      return Object.freeze({ canRead: capabilities.canRead === true, canExport: capabilities.canExport === true,
        live: sheetLiveness === 'live', bounded: bound.bounded === true, capabilities })
    },
    async loadFields(trx, sheetId) {
      return (await loadFieldsForSheet(queryOf(trx), sheetId, new Map())).map(field =>
        Object.freeze({ id: field.id, type: field.type, property: field.property }))
    },
    async readableFieldIds(trx, sheetId, userId, fields, capabilities) {
      const visible = fields.filter(field => !isFieldPermissionHidden(field as Parameters<typeof isFieldPermissionHidden>[0]))
      const fieldScopeMap = await loadFieldPermissionScopeMap(queryOf(trx), sheetId, userId)
      const permissions = deriveFieldPermissions(visible as Parameters<typeof deriveFieldPermissions>[0],
        capabilities as Capabilities, { hiddenFieldIds: [], fieldScopeMap })
      return new Set(visible.filter(field => permissions[field.id]?.visible !== false).map(field => field.id))
    },
    async readableRecordIds(trx, sheetId, userId, isAdminRole, recordIds, capabilities) {
      const query = queryOf(trx), caps = capabilities as Capabilities
      if (isAdminRole || recordIds.length === 0) return new Set(recordIds)
      const rowLevelDeny = await loadRowLevelReadDenyEnabled(query, sheetId)
      const denied = rowLevelDeny ? await loadDeniedRecordIds(query, sheetId, userId, recordIds) : new Set<string>()
      const assigned = await hasRecordPermissionAssignments(query, sheetId)
      const scopeMap = assigned ? await loadRecordPermissionScopeMap(query, sheetId, [...recordIds], userId) : new Map()
      return new Set(recordIds.filter(recordId => !denied.has(recordId)
        && (scopeMap.size === 0 || deriveRecordPermissions(recordId, caps, scopeMap, rowLevelDeny).canRead)))
    },
  }) as YidaSourceReauthorizationDependencies
}

/** The service dependency: `(trx, actor, binding) => verdict`, closed over the host primitives above. */
export function createYidaSourceBindingReauthorizer(dependencies: YidaSourceReauthorizationDependencies = createYidaSourceReauthorizationHostDependencies()) {
  return (trx: YidaSourceReauthorizationQueryable, actor: unknown, binding: unknown): Promise<YidaSourceReauthorizationVerdict> =>
    reauthorizeYidaSourceBinding(trx, actor, binding, dependencies)
}

// `deriveCapabilities` is the multitable derivation `resolveSheetCapabilitiesForAccess` applies to the snapshot;
// re-exported for the unit suite's parity pin (locked codes in → the same capabilities a grid read derives).
export { deriveCapabilities as deriveYidaSourceSheetCapabilities }
