import type { Request } from 'express'
import { poolManager } from './db/connection-pool'
import { loadFieldsForSheet, tryResolveView } from '../multitable/loaders'
import { deriveFieldPermissions, deriveRecordPermissions, isFieldPermissionHidden } from '../multitable/permission-derivation'
import {
  hasRecordPermissionAssignments, loadDeniedRecordIds, loadFieldPermissionScopeMap, loadRecordPermissionScopeMap,
  loadRowLevelReadDenyEnabled, resolveSheetReadableCapabilities, type QueryFn,
} from '../multitable/permission-service'
import { resolvePeopleSheetReadBound } from '../multitable/people-sheet-read-bound'
import {
  collectLeafConditions, evaluateFilterNode, evaluateMetaFilterCondition, parseMetaFilterInfo, pruneFilterNode,
  resolveEffectiveFieldType,
} from '../routes/univer-meta'
import type { YidaSheetSourceDependencies } from './yida-sheet-source'

/**
 * Host wiring of the YiDa sheet source (Y2) to the actual multitable permission primitives. The caller's
 * request supplies the actor; every check below is the caller's own RBAC (no plugin scope, no admin bypass
 * beyond what the multitable read path itself grants an admin role).
 */
export function createYidaSheetSourceHostDependencies(): YidaSheetSourceDependencies {
  const query: QueryFn = (sql, params) => {
    const pool = poolManager.get()
    return pool.query(sql, params) as ReturnType<QueryFn>
  }
  type Capabilities = Parameters<typeof deriveRecordPermissions>[1] & Parameters<typeof deriveFieldPermissions>[1]
  return Object.freeze({
    async resolveAccess(req: Request, sheetId: string) {
      const { access, capabilities, sheetLiveness } = await resolveSheetReadableCapabilities(req, query, sheetId)
      const bound = await resolvePeopleSheetReadBound(query, sheetId)
      return Object.freeze({ userId: access.userId ?? null, isAdminRole: access.isAdminRole === true,
        canRead: capabilities.canRead === true, canExport: capabilities.canExport === true,
        live: sheetLiveness === 'live', bounded: bound.bounded === true, capabilities })
    },
    async loadFields(sheetId: string) {
      return (await loadFieldsForSheet(query, sheetId, new Map())).map(field =>
        Object.freeze({ id: field.id, type: field.type, property: field.property }))
    },
    async readableFieldIds(sheetId, userId, fields, capabilities) {
      const visible = fields.filter(field => !isFieldPermissionHidden(field as Parameters<typeof isFieldPermissionHidden>[0]))
      const fieldScopeMap = await loadFieldPermissionScopeMap(query, sheetId, userId)
      const permissions = deriveFieldPermissions(visible as Parameters<typeof deriveFieldPermissions>[0],
        capabilities as Capabilities, { hiddenFieldIds: [], fieldScopeMap })
      return new Set(visible.filter(field => permissions[field.id]?.visible !== false).map(field => field.id))
    },
    async loadView(viewId: string) {
      const view = await tryResolveView(query, viewId, new Map())
      return view ? Object.freeze({ sheetId: view.sheetId, filterInfo: view.filterInfo }) : null
    },
    async loadRecords(sheetId: string, limit: number) {
      const result = await query('SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC LIMIT $2',
        [sheetId, limit])
      return (result.rows as Array<{ id: unknown; data: unknown }>).map(row => {
        let data = row.data
        if (typeof data === 'string') { try { data = JSON.parse(data) } catch { data = {} } }
        return Object.freeze({ id: String(row.id), data })
      })
    },
    async readableRecordIds(sheetId, userId, isAdminRole, recordIds, capabilities) {
      const caps = capabilities as Capabilities
      if (isAdminRole || recordIds.length === 0) return new Set(recordIds)
      const rowLevelDeny = await loadRowLevelReadDenyEnabled(query, sheetId)
      const denied = rowLevelDeny ? await loadDeniedRecordIds(query, sheetId, userId, recordIds) : new Set<string>()
      const assigned = await hasRecordPermissionAssignments(query, sheetId)
      const scopeMap = assigned ? await loadRecordPermissionScopeMap(query, sheetId, [...recordIds], userId) : new Map()
      return new Set(recordIds.filter(recordId => !denied.has(recordId)
        && (scopeMap.size === 0 || deriveRecordPermissions(recordId, caps, scopeMap, rowLevelDeny).canRead)))
    },
    // Source binding (design baseline v2.3 §7.2): the project-sheet registry (migration 087) row that names this
    // sheet for the REQUEST's verified tenant, active only. The tenant is the authenticated one, never a header.
    async resolveProjectSheet(req: Request, sheetId: string) {
      const tenantId = req.authenticatedTenantId
      if (typeof tenantId !== 'string' || !tenantId) return null
      const result = await query('SELECT project_no FROM integration_stock_prep_project_target WHERE tenant_id = $1 AND sheet_id = $2 AND status = $3 LIMIT 2',
        [tenantId, sheetId, 'active'])
      const rows = result.rows as Array<{ project_no: unknown }>
      if (rows.length !== 1 || typeof rows[0].project_no !== 'string' || !rows[0].project_no) return null
      return Object.freeze({ projectNo: rows[0].project_no })
    },
    filter: Object.freeze({
      parse: (filterInfo: unknown) => parseMetaFilterInfo(filterInfo),
      prune: (node, keep) => pruneFilterNode(node as Parameters<typeof pruneFilterNode>[0], keep),
      leaves: node => collectLeafConditions(node as Parameters<typeof collectLeafConditions>[0]),
      evaluate: (node, leaf) => evaluateFilterNode(node as Parameters<typeof evaluateFilterNode>[0],
        leaf as Parameters<typeof evaluateFilterNode>[1]),
      leafMatches: (fieldType, value, leaf) => evaluateMetaFilterCondition(fieldType as Parameters<typeof evaluateMetaFilterCondition>[0],
        value, leaf as Parameters<typeof evaluateMetaFilterCondition>[2]),
      effectiveType: field => resolveEffectiveFieldType(field),
    }),
  }) as YidaSheetSourceDependencies
}
