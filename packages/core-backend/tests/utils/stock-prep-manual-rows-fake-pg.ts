/**
 * 人工补充行 B2 — a STATEFUL fake Postgres for the manual-row unit suites (routes, delete exemption, /context).
 *
 * It holds stock-preparation template sheets built from the PLUGIN's own frozen template (33 columns, the stanza the
 * target provisioning writes, the lock the project-sheet marking writes) with physical ids derived exactly as the host
 * derives them (provisioning.ts getObjectFieldId over the host registry row), the host registry
 * (`plugin_multitable_object_registry`) and the plugin registry (`integration_stock_prep_project_target`, 087), records,
 * the trash and per-subject `field_permissions` rows. It answers the statements the real univer-meta router and the
 * record services issue on these paths; anything else gets an empty result. `transaction` rolls the records and the
 * trash back when its handler throws, so "nothing was written" is observable. Failure injection: a thrown host or
 * plugin registry read (with a chosen SQLSTATE), and a hook that changes a sheet the moment the create / patch
 * transaction re-reads it (to prove the in-transaction re-checks).
 *
 * Every value is synthetic.
 */
import { createRequire } from 'node:module'

import { vi } from 'vitest'

import { getObjectFieldId, getObjectSheetId } from '../../src/multitable/provisioning'

const requireCjs = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const templates = requireCjs('../../../../plugins/plugin-integration-core/lib/stock-preparation-templates.cjs') as any

export const MR_TENANT_ID = 'tenant_mrb2_unit'
export const MR_PROJECT_ID = `${MR_TENANT_ID}:integration-core`
export const MR_PLUGIN = 'plugin-integration-core'
export const MR_BASE_ID = 'base_mrb2_unit'
export const MR_PROJECT_NO = 'SYN-MRB2-0001'
export const MR_ENV_OBJECT = 'plm_stock_preparation_main'
export const MR_SWITCH = 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'

export type TemplateField = { id: string; label: string; type: string; ownership: string; required?: boolean; key?: boolean; preserveOnRefresh?: boolean }
export const TEMPLATE_FIELDS = templates.STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields as TemplateField[]
export const PLM_SYSTEM_LOGICAL_IDS = TEMPLATE_FIELDS.filter((f) => f.ownership === 'plm_system').map((f) => f.id)

export type FakeFieldRow = { id: string; sheet_id: string; name: string; type: string; property: Record<string, unknown>; order: number }
export type FakeRecord = {
  id: string
  sheet_id: string
  data: Record<string, unknown>
  version: number
  created_by: string | null
  modified_by: string | null
  locked: boolean
  locked_by: string | null
}
export type FakeTrash = {
  id: string
  record_id: string
  sheet_id: string
  base_id: string | null
  data: Record<string, unknown>
  original_version: number
  created_by: string | null
  deleted_by: string | null
  deleted_at: string
}
export type FakeTarget = { status: string; projectNo?: unknown; tenantId?: unknown; objectId?: unknown; sheetId?: unknown }
export type FakeSheet = {
  key: string
  sheetId: string
  objectId: string
  projectId: string
  /** The host registry row's plugin; null = no host registry row at all. */
  plugin: string | null
  /** The plugin registry (087) row; null = none. */
  target: FakeTarget | null
  fields: FakeFieldRow[]
}

export type SheetOptions = {
  objectId: string
  plugin?: string | null
  projectId?: string
  /** Default: an active row with MR_PROJECT_NO. */
  target?: FakeTarget | null
  /** Which template columns carry humanWriteLock: every plm_system column (default), none, or the listed logical ids. */
  locked?: 'plm' | 'none' | string[]
  /** Raw value of the switch on the key column; leave the key out of the options to keep it absent. */
  policy?: unknown
  /** Logical template ids left off the sheet. */
  omit?: string[]
  /** Extra columns (physical id given). */
  extra?: Array<{ id: string; name: string; type: string; property: Record<string, unknown> }>
  /** A second `key: true` column. */
  secondKey?: boolean
  /** No stockPreparation stanza anywhere (an ordinary sheet with the same column ids). */
  noStanza?: boolean
}

const SELECT_OPTIONS = [{ value: 'SYN-A' }, { value: 'SYN-B' }]

export function physicalOf(sheet: Pick<FakeSheet, 'projectId' | 'objectId'>, logical: string): string {
  return getObjectFieldId(sheet.projectId, sheet.objectId, logical)
}

function buildFields(sheetId: string, projectId: string, objectId: string, options: SheetOptions): FakeFieldRow[] {
  const omit = new Set(options.omit ?? [])
  const lockSet = options.locked === 'none'
    ? new Set<string>()
    : Array.isArray(options.locked) ? new Set(options.locked) : new Set(PLM_SYSTEM_LOGICAL_IDS)
  const rows: FakeFieldRow[] = []
  TEMPLATE_FIELDS.forEach((field, order) => {
    if (omit.has(field.id)) return
    const property: Record<string, unknown> = {}
    if (field.required) property.validation = [{ type: 'required' }]
    if (!options.noStanza) {
      property.stockPreparation = { ownership: field.ownership, preserveOnRefresh: field.preserveOnRefresh === true, required: field.required === true, key: field.key === true }
    }
    if (lockSet.has(field.id)) property.humanWriteLock = 'plm_system'
    if (field.type === 'select') property.options = SELECT_OPTIONS
    if (field.key && Object.prototype.hasOwnProperty.call(options, 'policy')) property.stockPreparationManualRows = options.policy
    rows.push({ id: getObjectFieldId(projectId, objectId, field.id), sheet_id: sheetId, name: field.label, type: field.type, property, order })
  })
  if (options.secondKey) {
    rows.push({
      id: getObjectFieldId(projectId, objectId, 'secondKeySynthetic'),
      sheet_id: sheetId,
      name: 'Second Key',
      type: 'string',
      property: { stockPreparation: { ownership: 'plm_system', preserveOnRefresh: false, required: false, key: true }, humanWriteLock: 'plm_system' },
      order: rows.length,
    })
  }
  for (const extra of options.extra ?? []) rows.push({ ...extra, sheet_id: sheetId, order: rows.length })
  return rows
}

const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim()
const asIds = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [])

export function createManualRowsFakePool() {
  const sheets = new Map<string, FakeSheet>()
  const records = new Map<string, FakeRecord>()
  const trash = new Map<string, FakeTrash>()
  const fieldPermissions: Array<{ sheetId: string; fieldId: string; userId: string; visible: boolean; readOnly: boolean }> = []
  const sqlLog: Array<{ sql: string; params: unknown[] }> = []
  const failures: { hostRegistry: { code?: string; message: string } | null; target: { code?: string; message: string } | null } = { hostRegistry: null, target: null }
  /** Called when a create / patch transaction re-reads the sheet's fields: lets a case change the sheet in between. */
  let onTransactionFieldRead: ((sheet: FakeSheet) => void) | null = null
  /** Called when the edit recheck locks the record FOR UPDATE. */
  let onRecordLockForUpdate: ((record: FakeRecord) => void) | null = null
  let trashSeq = 0

  function addSheet(key: string, options: SheetOptions): FakeSheet {
    const projectId = options.projectId ?? MR_PROJECT_ID
    const sheetId = getObjectSheetId(projectId, options.objectId)
    const sheet: FakeSheet = {
      key,
      sheetId,
      objectId: options.objectId,
      projectId,
      plugin: options.plugin === undefined ? MR_PLUGIN : options.plugin,
      target: options.target === undefined ? { status: 'active', projectNo: MR_PROJECT_NO } : options.target,
      fields: buildFields(sheetId, projectId, options.objectId, options),
    }
    sheets.set(sheetId, sheet)
    return sheet
  }

  function phys(sheet: FakeSheet, logical: string): string {
    return physicalOf(sheet, logical)
  }

  function addRecord(sheet: FakeSheet, id: string, logicalData: Record<string, unknown>, createdBy: string | null, physicalData: Record<string, unknown> = {}): FakeRecord {
    const data: Record<string, unknown> = { ...physicalData }
    for (const [logical, value] of Object.entries(logicalData)) data[phys(sheet, logical)] = value
    const record: FakeRecord = { id, sheet_id: sheet.sheetId, data, version: 1, created_by: createdBy, modified_by: createdBy, locked: false, locked_by: null }
    records.set(id, record)
    return record
  }

  function fieldRows(sheet: FakeSheet) {
    return sheet.fields.map((field) => ({ ...field, property: structuredClone(field.property) }))
  }

  function recordRow(record: FakeRecord) {
    return { ...record, data: structuredClone(record.data), locked_at: null, created_at: null, updated_at: null }
  }

  function thrown(failure: { code?: string; message: string }) {
    return Object.assign(new Error(failure.message), failure.code ? { code: failure.code } : {})
  }

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const q = collapse(sql)
    sqlLog.push({ sql: q, params })
    const rows = (list: unknown[]) => ({ rows: list, rowCount: list.length })
    const p = (i: number) => String(params?.[i] ?? '')

    // ── the two registries ──
    if (q.includes('FROM plugin_multitable_object_registry')) {
      if (failures.hostRegistry) throw thrown(failures.hostRegistry)
      let hits = [...sheets.values()].filter((s) => s.plugin && asIds(params[0]).includes(s.sheetId))
      if (/plugin_name = \$2/.test(q)) hits = hits.filter((s) => s.plugin === params[1])
      return rows(hits.map((s) => ({ '?column?': 1, sheet_id: s.sheetId, project_id: s.projectId, object_id: s.objectId, plugin_name: s.plugin })))
    }
    if (q.includes('FROM integration_stock_prep_project_target')) {
      if (failures.target) throw thrown(failures.target)
      const s = sheets.get(p(0))
      if (!s || !s.target) return rows([])
      const t = s.target
      return rows([{
        sheet_id: t.sheetId === undefined ? s.sheetId : t.sheetId,
        project_no: t.projectNo === undefined ? MR_PROJECT_NO : t.projectNo,
        status: t.status,
        object_id: t.objectId === undefined ? s.objectId : t.objectId,
        tenant_id: t.tenantId === undefined ? MR_TENANT_ID : t.tenantId,
      }])
    }

    // ── sheets / bases / views ──
    if (/^SELECT deleted_at FROM meta_sheets WHERE id = \$1( FOR UPDATE)?$/.test(q)) return rows(sheets.has(p(0)) ? [{ deleted_at: null }] : [])
    if (q.startsWith('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) return rows(sheets.has(p(0)) ? [{ id: p(0) }] : [])
    if (q.startsWith('SELECT 1 FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) return rows(sheets.has(p(0)) ? [{ '?column?': 1 }] : [])
    if (q.startsWith('SELECT base_id FROM meta_sheets WHERE id = $1')) return rows(sheets.has(p(0)) ? [{ base_id: MR_BASE_ID }] : [])
    const sheetRow = (s: FakeSheet) => ({
      id: s.sheetId, base_id: MR_BASE_ID, name: s.key, description: null, system_kind: null, copied_from_kind: null, copied_at: null, copied_from_sheet_id: null,
      base_ref_id: MR_BASE_ID, base_name: 'MRB2', base_icon: null, base_color: null, base_owner_id: null, base_workspace_id: null,
    })
    if (/FROM meta_bases WHERE id = \$1 AND deleted_at IS NULL/.test(q)) {
      return rows(p(0) === MR_BASE_ID ? [{ id: MR_BASE_ID, name: 'MRB2', icon: null, color: null, owner_id: null, workspace_id: null }] : [])
    }
    if (/FROM meta_sheets WHERE base_id = \$1 AND deleted_at IS NULL/.test(q)) return rows(p(0) === MR_BASE_ID ? [...sheets.values()].map(sheetRow) : [])
    if (q.includes('FROM meta_sheets') && (q.includes('WHERE s.id = $1') || q.includes('WHERE id = $1'))) {
      const s = sheets.get(p(0))
      return rows(s ? [sheetRow(s)] : [])
    }
    if (q.includes('FROM meta_bases')) return rows(p(0) === MR_BASE_ID ? [{ id: MR_BASE_ID, name: 'MRB2', workspace_id: null }] : [])
    if (/FROM meta_views WHERE sheet_id = \$1 ORDER BY created_at ASC$/.test(q)) {
      const s = sheets.get(p(0))
      return rows(s ? [{ id: `vw_mrb2_${s.key}`, sheet_id: s.sheetId, name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }] : [])
    }

    // ── fields ──
    if (q.includes('FROM field_permissions fp')) {
      const userId = p(0)
      const sheetId = p(1)
      return rows(fieldPermissions.filter((fp) => fp.sheetId === sheetId && fp.userId === userId).map((fp) => ({ field_id: fp.fieldId, visible: fp.visible, read_only: fp.readOnly })))
    }
    if (q.startsWith('SELECT id, name, type, property FROM meta_fields WHERE sheet_id = $1')) {
      // RecordService.createRecord's in-transaction re-read.
      const s = sheets.get(p(0))
      if (s && onTransactionFieldRead) { const hook = onTransactionFieldRead; onTransactionFieldRead = null; hook(s) }
      return rows(s ? fieldRows(s).map(({ id, name, type, property }) => ({ id, name, type, property })) : [])
    }
    if (q.startsWith('SELECT id, property FROM meta_fields WHERE sheet_id = $1 AND id = ANY')) {
      const s = sheets.get(p(0))
      const ids = asIds(params[1])
      return rows(s ? fieldRows(s).filter((f) => ids.includes(f.id)).map(({ id, property }) => ({ id, property })) : [])
    }
    if (q.startsWith('SELECT id, property FROM meta_fields WHERE sheet_id = $1')) {
      const s = sheets.get(p(0))
      if (s && onTransactionFieldRead) { const hook = onTransactionFieldRead; onTransactionFieldRead = null; hook(s) }
      return rows(s ? fieldRows(s).map(({ id, property }) => ({ id, property })) : [])
    }
    if (/FROM meta_fields WHERE sheet_id = \$1/.test(q)) {
      const s = sheets.get(p(0))
      return rows(s ? fieldRows(s) : [])
    }
    if (/FROM meta_fields WHERE id = \$1/.test(q)) {
      for (const s of sheets.values()) {
        const f = s.fields.find((field) => field.id === p(0))
        if (f) return rows([{ ...f, property: structuredClone(f.property) }])
      }
      return rows([])
    }

    // ── trash ──
    if (q.startsWith('SELECT COUNT(*)::int AS n FROM meta_records_trash WHERE sheet_id = $1')) return rows([{ n: [...trash.values()].filter((t) => t.sheet_id === p(0)).length }])
    if (q.startsWith('SELECT * FROM meta_records_trash WHERE sheet_id = $1')) return rows([...trash.values()].filter((t) => t.sheet_id === p(0)))
    if (q.startsWith('SELECT * FROM meta_records_trash WHERE record_id = $1')) {
      const t = [...trash.values()].find((row) => row.record_id === p(0))
      return rows(t ? [t] : [])
    }
    if (q.startsWith('SELECT * FROM meta_records_trash WHERE id = $1 FOR UPDATE')) return rows([...trash.values()].filter((t) => t.id === p(0)))
    if (q.startsWith('SELECT sheet_id FROM meta_records_trash WHERE record_id = $1')) {
      const t = [...trash.values()].find((row) => row.record_id === p(0))
      return rows(t ? [{ sheet_id: t.sheet_id }] : [])
    }
    if (q.startsWith('INSERT INTO meta_records_trash')) {
      trashSeq += 1
      const id = `trash_mrb2_${trashSeq}`
      trash.set(id, {
        id, record_id: p(0), sheet_id: p(1), base_id: params[2] === null ? null : p(2), data: JSON.parse(p(3)), original_version: Number(params[4] ?? 1),
        created_by: (params[5] as string | null) ?? null, deleted_by: (params[6] as string | null) ?? null, deleted_at: '2026-10-30T00:00:00.000Z',
      })
      return { rows: [], rowCount: 1 }
    }
    if (q.startsWith('DELETE FROM meta_records_trash')) {
      for (const [id, t] of [...trash.entries()]) if (t.id === p(0) || t.record_id === p(0)) trash.delete(id)
      return { rows: [], rowCount: 1 }
    }

    // ── records ──
    if (q.startsWith('INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by) VALUES ($1, $2, $3::jsonb, 1, $4, $4)')) {
      records.set(p(0), { id: p(0), sheet_id: p(1), data: JSON.parse(p(2)), version: 1, created_by: (params[3] as string | null) ?? null, modified_by: (params[3] as string | null) ?? null, locked: false, locked_by: null })
      return rows([{ version: 1 }])
    }
    if (q.startsWith('INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by, created_at, updated_at)')) {
      records.set(p(0), { id: p(0), sheet_id: p(1), data: JSON.parse(p(2)), version: 1, created_by: (params[3] as string | null) ?? null, modified_by: (params[4] as string | null) ?? null, locked: false, locked_by: null })
      return rows([{ version: 1 }])
    }
    if (q.startsWith('UPDATE meta_records SET data = data || $1::jsonb')) {
      const r = records.get(p(2))
      if (!r || r.sheet_id !== p(1)) return rows([])
      r.data = { ...r.data, ...JSON.parse(p(0)) }
      r.version += 1
      r.modified_by = (params[3] as string | null) ?? null
      return rows([{ version: r.version }])
    }
    if (q.startsWith('DELETE FROM meta_records WHERE id = $1')) {
      records.delete(p(0))
      return { rows: [], rowCount: 1 }
    }
    if (q.startsWith('SELECT id, created_by FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])')) {
      const ids = asIds(params[1])
      return rows([...records.values()].filter((r) => r.sheet_id === p(0) && ids.includes(r.id)).map((r) => ({ id: r.id, created_by: r.created_by })))
    }
    if (q.startsWith('SELECT 1 FROM meta_records WHERE sheet_id = $1 AND data ->> $2 = $3')) {
      return rows([...records.values()].some((r) => r.sheet_id === p(0) && String(r.data[p(1)] ?? '') === p(2)) ? [{ '?column?': 1 }] : [])
    }
    if (q.startsWith('SELECT DISTINCT data ->> $2 AS plm_key FROM meta_records')) {
      const keys = new Set(asIds(params[2]))
      const live = [...records.values()].filter((r) => r.sheet_id === p(0) && keys.has(String(r.data[p(1)] ?? ''))).map((r) => String(r.data[p(1)]))
      return rows([...new Set(live)].map((plm_key) => ({ plm_key })))
    }
    if (q.startsWith('SELECT id, version, data, locked, locked_by, locked_at FROM meta_records WHERE sheet_id = $1 ORDER BY')) {
      return rows([...records.values()].filter((r) => r.sheet_id === p(0)).sort((a, b) => (a.id < b.id ? -1 : 1)).map(recordRow))
    }
    if (q.startsWith('SELECT 1 FROM meta_records WHERE id = $1 FOR UPDATE')) return rows(records.has(p(0)) ? [{ '?column?': 1 }] : [])
    if (q.includes('FROM meta_records') && q.includes('WHERE sheet_id = $1 AND id = $2')) {
      const r = records.get(p(1))
      if (!r || r.sheet_id !== p(0)) return rows([])
      if (q.startsWith('SELECT id, data, created_by FROM meta_records') && onRecordLockForUpdate) {
        const hook = onRecordLockForUpdate
        onRecordLockForUpdate = null
        hook(r)
      }
      return rows([recordRow(r)])
    }
    if (q.includes('FROM meta_records') && q.includes('WHERE id = $1')) {
      const r = records.get(p(0))
      if (!r || (q.includes('AND sheet_id = $2') && r.sheet_id !== p(1))) return rows([])
      return rows([recordRow(r)])
    }
    if (q.includes('FROM meta_records') && q.includes('id = ANY(')) {
      const idsParam = params.find((value) => Array.isArray(value))
      const ids = asIds(idsParam)
      const sheetParam = q.includes('sheet_id = $1') ? p(0) : null
      return rows([...records.values()].filter((r) => ids.includes(r.id) && (sheetParam === null || r.sheet_id === sheetParam)).map(recordRow))
    }

    if (/^(INSERT|UPDATE|DELETE)/.test(q)) return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })

  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => {
    const recordsBefore = structuredClone([...records.entries()])
    const trashBefore = structuredClone([...trash.entries()])
    try {
      return await fn({ query })
    } catch (err) {
      records.clear()
      for (const [id, r] of recordsBefore) records.set(id, r)
      trash.clear()
      for (const [id, t] of trashBefore) trash.set(id, t)
      throw err
    }
  })

  return {
    pool: { query, transaction },
    sheets,
    records,
    trash,
    fieldPermissions,
    sqlLog,
    failures,
    addSheet,
    addRecord,
    phys,
    setOnTransactionFieldRead(hook: ((sheet: FakeSheet) => void) | null) { onTransactionFieldRead = hook },
    setOnRecordLockForUpdate(hook: ((record: FakeRecord) => void) | null) { onRecordLockForUpdate = hook },
    statements(pattern: RegExp) { return sqlLog.filter((entry) => pattern.test(entry.sql)) },
    reset() {
      sheets.clear()
      records.clear()
      trash.clear()
      fieldPermissions.length = 0
      sqlLog.length = 0
      failures.hostRegistry = null
      failures.target = null
      onTransactionFieldRead = null
      onRecordLockForUpdate = null
    },
  }
}

export type ManualRowsFakePg = ReturnType<typeof createManualRowsFakePool>
