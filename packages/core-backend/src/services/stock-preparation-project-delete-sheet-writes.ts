import { createHash } from 'node:crypto'
import { getObjectSheetId } from '../multitable/provisioning'
import { bumpSheetPermissionVersions, verifyAuthorizationVersionTriggerPosture } from '../multitable/authz-version-protocol'

type RowTransaction = { query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> }
type SheetSelection = { recordIds: readonly string[] }

export interface ProjectDeleteSheetSelection {
  dedicatedSheetId: string | null
  selected: ReadonlyMap<string, SheetSelection>
}

type PermissionRows = 'record_permissions' | 'field_permissions' | 'spreadsheet_permissions' | 'meta_fields'
export interface ProjectDeleteSheetWrites {
  deleteDependency(table: PermissionRows): Promise<number>
  deleteDedicatedSheet(): Promise<number>
}

function refuse(reason: 'UNAVAILABLE' | 'AMBIGUOUS' | 'STALE'): never {
  const code = 'STOCK_PREPARATION_PROJECT_DELETE_' + reason
  throw Object.assign(new Error(code), { status: reason === 'UNAVAILABLE' ? 503 : 409, code })
}

const recordScope = `sheet_id = $1 OR (sheet_id, record_id) IN
  (SELECT * FROM unnest($2::text[], $3::text[]))`
const permissionSql = {
  record_permissions: `DELETE FROM public.record_permissions WHERE ${recordScope} RETURNING 1`,
  field_permissions: 'DELETE FROM public.field_permissions WHERE sheet_id = $1 RETURNING 1',
  spreadsheet_permissions: 'DELETE FROM public.spreadsheet_permissions WHERE sheet_id = $1 RETURNING 1',
  meta_fields: 'DELETE FROM public.meta_fields WHERE sheet_id = $1 RETURNING 1',
} as const

// Created only by the host after live administrator/membership authorization. Bind the writer to
// the existing transaction and its verified selection. Each method has a fixed table + predicate.
export async function prepareProjectDeleteSheetWrites(
  tx: RowTransaction, tenantId: string, projectNo: string, plan: ProjectDeleteSheetSelection,
): Promise<ProjectDeleteSheetWrites> {
  const [session] = await tx.query("SELECT current_setting('session_replication_role') <> 'replica' AS origin")
  if (session?.origin !== true) refuse('UNAVAILABLE')
  const dedicated = plan.dedicatedSheetId
  const sheetIds: string[] = []
  const recordIds: string[] = []
  for (const [sheet, { recordIds: records }] of plan.selected) {
    for (const id of records) { sheetIds.push(sheet); recordIds.push(id) }
  }
  const params = [dedicated, sheetIds, recordIds]
  const permissionSheets = await tx.query(`SELECT DISTINCT sheet_id FROM public.record_permissions WHERE ${recordScope}`, params)
  const affected = new Set(permissionSheets.map(row => String(row.sheet_id)))
  if (dedicated) affected.add(dedicated)
  if (affected.size) {
    const client = { query: async (sql: string, args?: unknown[]) => ({ rows: await tx.query(sql, args) }) }
    if (!(await verifyAuthorizationVersionTriggerPosture(client)).ok) refuse('UNAVAILABLE')
    const stage = tenantId + ':integration-core'
    const objectId = 'plm_stock_preparation_sandbox_p_' + createHash('sha256').update(tenantId + ':' + projectNo).digest('hex').slice(0, 24)
    const expected = getObjectSheetId(stage, objectId)
    if (dedicated && dedicated !== expected) refuse('AMBIGUOUS')
    const baseId = 'base_integration-core_sp_' + createHash('sha1').update(tenantId + ':stock-preparation').digest('hex').slice(0, 24)
    // Canonical sheet order, before the D21 version rows and before the record/field locks. A
    // dedicated parent is physically deleted; on shared parents only existing permissions change.
    for (const id of [...affected].sort()) {
      const rows = await tx.query(`SELECT s.id FROM public.meta_sheets s
        LEFT JOIN public.plugin_multitable_object_registry o ON o.sheet_id = s.id
        LEFT JOIN public.meta_bases b ON b.id = s.base_id
        WHERE s.id = $1 AND ((o.project_id = $2 AND o.plugin_name = 'plugin-integration-core')
          OR (o.sheet_id IS NULL AND b.id = $3 AND b.owner_id IS NULL AND b.workspace_id IS NULL AND b.deleted_at IS NULL))
        AND ($1::text IS DISTINCT FROM $4::text OR (o.object_id = $5 AND EXISTS (
          SELECT 1 FROM public.integration_stock_prep_project_target t WHERE t.sheet_id = s.id
          AND t.tenant_id = $6 AND t.project_no = $7 AND t.object_id = o.object_id)))
        ${id === dedicated ? 'FOR UPDATE' : 'FOR KEY SHARE'} OF s NOWAIT`,
        [id, stage, baseId, dedicated, objectId, tenantId, projectNo])
      if (rows.length !== 1) refuse('AMBIGUOUS')
    }
    await bumpSheetPermissionVersions(client, [...affected])
  }
  return {
    async deleteDependency(table) {
      if (!Object.hasOwn(permissionSql, table)) refuse('AMBIGUOUS')
      const result = await tx.query(permissionSql[table], table === 'record_permissions' ? params : [dedicated])
      return result.length
    },
    async deleteDedicatedSheet() {
      if (!dedicated) refuse('AMBIGUOUS')
      return (await tx.query('DELETE FROM public.meta_sheets WHERE id = $1 RETURNING 1', [dedicated])).length
    },
  }
}
