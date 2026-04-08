import {
  normalizeJson,
  normalizeJsonArray,
  serializeFieldRow,
  type MultitableField,
} from './field-codecs'

export type MultitableLoaderQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type MultitableSheetRow = {
  id: string
  baseId: string | null
  name: string
  description: string | null
}

export type MultitableViewConfig = {
  id: string
  sheetId: string
  name: string
  type: string
  filterInfo?: Record<string, unknown>
  sortInfo?: Record<string, unknown>
  groupInfo?: Record<string, unknown>
  hiddenFieldIds?: string[]
  config?: Record<string, unknown>
}

export async function loadSheetRow(
  query: MultitableLoaderQueryFn,
  sheetId: string,
): Promise<MultitableSheetRow | null> {
  const result = await query(
    'SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL',
    [sheetId],
  )
  const row = (result.rows as any[])[0]
  if (!row) return null
  return {
    id: String(row.id),
    baseId: typeof row.base_id === 'string' ? row.base_id : null,
    name: String(row.name),
    description: typeof row.description === 'string' ? row.description : null,
  }
}

export async function loadFieldsForSheet(
  pool: { query: MultitableLoaderQueryFn },
  sheetId: string,
  cache?: Map<string, MultitableField[]>,
): Promise<MultitableField[]> {
  const cached = cache?.get(sheetId)
  if (cached) return cached

  const fieldRes = await pool.query(
    'SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC',
    [sheetId],
  )
  const fields = (fieldRes.rows as any[]).map((f: any) => serializeFieldRow(f))
  cache?.set(sheetId, fields)
  return fields
}

export async function tryResolveView(
  pool: { query: MultitableLoaderQueryFn },
  viewId: string,
  cache?: Map<string, MultitableViewConfig>,
): Promise<MultitableViewConfig | null> {
  const cached = cache?.get(viewId)
  if (cached) return cached

  const result = await pool.query(
    'SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1',
    [viewId],
  )
  if (result.rows.length === 0) return null

  const row: any = result.rows[0]
  const view: MultitableViewConfig = {
    id: String(row.id),
    sheetId: String(row.sheet_id),
    name: String(row.name),
    type: String(row.type ?? 'grid'),
    filterInfo: normalizeJson(row.filter_info),
    sortInfo: normalizeJson(row.sort_info),
    groupInfo: normalizeJson(row.group_info),
    hiddenFieldIds: normalizeJsonArray(row.hidden_field_ids),
    config: normalizeJson(row.config),
  }
  cache?.set(viewId, view)
  return view
}
