/**
 * 人工补充行 B2 — a STATEFUL fake Postgres for the manual-row unit suites (routes, delete exemption, /context).
 *
 * It holds stock-preparation template sheets built from the PLUGIN's own frozen template (35 columns, the stanza the
 * target provisioning writes, the lock the project-sheet marking writes) with physical ids derived exactly as the host
 * derives them (provisioning.ts getObjectFieldId over the host registry row), the host registry
 * (`plugin_multitable_object_registry`) and the plugin registry (`integration_stock_prep_project_target`, 087), records,
 * the trash and per-subject `field_permissions` rows. It answers the statements the real univer-meta router and the
 * record services issue on these paths; anything else gets an empty result. `transaction` rolls the records and the
 * trash back when its handler throws, so "nothing was written" is observable. Failure injection: a thrown host or
 * plugin registry read (with a chosen SQLSTATE), and a hook that changes a sheet the moment the create / patch
 * transaction re-reads it (to prove the in-transaction re-checks).
 *
 * ADR §12 (slice P1): it also holds the row policy — a sheet's row-level read flag and per-user `'none'`
 * record_permissions (`recordDenies`) — and answers the two FIXED parent-picker statements
 * (multitable/stock-preparation-manual-row-parent-options.ts) by evaluating them in JS over its records, from the very
 * parameter list the route sent (`evaluateParentOptionsStatement` / `evaluateParentDependentsStatement` below: a null
 * column id reads nothing, the denied ids are excluded before anything is grouped or counted, and the search text is
 * folded by the same `LOWER` as the columns — `setDatabaseCtype` picks which database that is). The statements' own
 * SQL is proven on real Postgres by the registered real-DB cases; here the route's gates, read sets and parameters are.
 *
 * Every value is synthetic.
 */
import { createRequire } from 'node:module'

import { vi } from 'vitest'

import { getObjectFieldId, getObjectSheetId } from '../../src/multitable/provisioning'
import { MANUAL_ROW_PARENT_DEPENDENTS_SQL, MANUAL_ROW_PARENT_OPTIONS_SQL } from '../../src/multitable/stock-preparation-manual-row-parent-options'

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
  /** `meta_sheets.row_level_read_permissions_enabled` (default off: a `'none'` record_permission is then inert). */
  rowLevelReadDeny?: boolean
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

// ── the two fixed parent-picker statements, evaluated over the fake's records ──────────────────────────────
//
// Each function reads ONLY what the statement's parameters let the real statement read, in the statement's own order
// of operations: a column whose id parameter is null is never looked at; the denied record ids and the active filter
// cut the rows before anything is grouped, counted or capped.

const PARENT_OPTIONS_STATEMENT = collapse(MANUAL_ROW_PARENT_OPTIONS_SQL)
const PARENT_DEPENDENTS_STATEMENT = collapse(MANUAL_ROW_PARENT_DEPENDENTS_SQL)

/** BTRIM(text, chars): strips any of `chars` from both ends. */
function sqlBtrim(value: string, chars: string): string {
  let start = 0
  let end = value.length
  while (start < end && chars.includes(value[start]!)) start += 1
  while (end > start && chars.includes(value[end - 1]!)) end -= 1
  return value.slice(start, end)
}

/** `data -> $n` as text when the JSON value is a string; NULL for a null column id or any other JSON type. */
function jsonStringCell(data: Record<string, unknown>, columnId: unknown): string | null {
  if (typeof columnId !== 'string') return null
  const value = data[columnId]
  return typeof value === 'string' ? value : null
}

/** `data ->> $n`: the cell as text (a JSON string unquoted, a number / boolean as its text); NULL when absent or null. */
function jsonTextCell(data: Record<string, unknown>, columnId: unknown): string | null {
  if (typeof columnId !== 'string') return null
  const value = data[columnId]
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/** ORDER BY … COLLATE "C": byte order of the UTF-8 text. */
function compareC(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/**
 * SQL `LOWER()` is the DATABASE's: what it folds depends on the database's LC_CTYPE, and neither model below is
 * JavaScript's `toLowerCase()` over the whole text. The candidate statement folds the column and the search text with
 * the SAME one, which is the property the suites pin — whichever model is active.
 *   'C'     LC_CTYPE "C" (`initdb --locale=C`, as this repository's own provisioning does): ASCII letters only.
 *   'utf8'  a libc UTF-8 locale: every character on its own (`towlower`) — no context rule, so a capital sigma is
 *           always σ, where JavaScript writes the word-final ς.
 */
export type FakeDatabaseCtype = 'C' | 'utf8'
export const SQL_LOWER: Readonly<Record<FakeDatabaseCtype, (text: string) => string>> = Object.freeze({
  C: (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase()),
  utf8: (text: string) => Array.from(text, (character) => Array.from(character.toLowerCase())[0] ?? character).join(''),
})

export function evaluateParentOptionsStatement(
  records: Iterable<Pick<FakeRecord, 'id' | 'sheet_id' | 'data'>>,
  params: unknown[],
  ctype: FakeDatabaseCtype = 'utf8',
): Array<{ code: string; name: string | null; kind: 'parent' | 'component'; child_count: number | null }> {
  const [sheetId, codeId, nameId, parentCodeId, parentNameId, activeId, denied, trimChars, search, cap] = params
  const deniedIds = new Set(asIds(denied))
  const chars = String(trimChars)
  const nonBlank = (value: string | null): value is string => value !== null && sqlBtrim(value, chars) !== ''
  const texts = [...records]
    .filter((record) => record.sheet_id === sheetId
      && (activeId === null || jsonTextCell(record.data, activeId) === 'true')
      && !deniedIds.has(record.id))
    .map((record) => ({
      code: jsonStringCell(record.data, codeId),
      name: jsonStringCell(record.data, nameId),
      parentCode: jsonStringCell(record.data, parentCodeId),
      parentName: jsonStringCell(record.data, parentNameId),
    }))
  // `parent_names`: the rows per (父组件图号, 父组件名称); `parents`: one row per 图号 — the name most rows use (then the
  // byte-smallest; a row without a name does not vote), and every row counted.
  const parentNames = new Map<string, { code: string; uses: Map<string, number>; child_count: number }>()
  for (const row of texts) {
    if (!nonBlank(row.parentCode)) continue
    const entry = parentNames.get(row.parentCode) ?? { code: row.parentCode, uses: new Map<string, number>(), child_count: 0 }
    entry.child_count += 1
    if (nonBlank(row.parentName)) entry.uses.set(row.parentName, (entry.uses.get(row.parentName) ?? 0) + 1)
    parentNames.set(row.parentCode, entry)
  }
  const parents = [...parentNames.values()].map((entry) => ({
    code: entry.code,
    name: [...entry.uses.entries()].sort((a, b) => b[1] - a[1] || compareC(a[0], b[0]))[0]?.[0] ?? null,
    child_count: entry.child_count,
  }))
  const parentCodes = new Set(parents.map((entry) => entry.code))
  const components = new Map<string, { code: string; name: string | null }>()
  for (const row of texts) {
    if (!nonBlank(row.code) || parentCodes.has(row.code)) continue
    const name = nonBlank(row.name) ? row.name : null
    components.set(JSON.stringify([row.code, name]), { code: row.code, name })
  }
  const items = [
    ...parents.map((entry) => ({ ...entry, kind: 'parent' as const })),
    ...[...components.values()].map((entry) => ({ ...entry, kind: 'component' as const, child_count: null })),
  ]
  // `strpos(LOWER(column), LOWER($9)) > 0`: the search text arrives as typed and is folded here, by the same LOWER.
  const lower = SQL_LOWER[ctype]
  const typed = String(search)
  const needle = lower(typed)
  return items
    .filter((item) => typed === '' || lower(item.code).includes(needle) || lower(item.name ?? '').includes(needle))
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'parent' ? -1 : 1)
      || compareC(a.code, b.code)
      || (a.name === b.name ? 0 : a.name === null ? -1 : b.name === null ? 1 : compareC(a.name, b.name)))
    .slice(0, Number(cap))
}

export function evaluateParentDependentsStatement(
  records: Iterable<Pick<FakeRecord, 'id' | 'sheet_id' | 'data' | 'created_by'>>,
  params: unknown[],
): number {
  const [sheetId, recordId, parentCodeId, ownCode, keyId, keyPrefix, trimChars, denied] = params
  const deniedIds = new Set(asIds(denied))
  const chars = String(trimChars)
  const wanted = sqlBtrim(String(ownCode), chars)
  return [...records].filter((record) => {
    if (record.sheet_id !== sheetId || record.id === recordId || deniedIds.has(record.id)) return false
    const parentCode = jsonTextCell(record.data, parentCodeId)
    if (parentCode === null || sqlBtrim(parentCode, chars) !== wanted) return false
    if (jsonTextCell(record.data, keyId) !== `${String(keyPrefix)}${record.id}`) return false
    return typeof record.created_by === 'string' && sqlBtrim(record.created_by, chars) !== ''
  }).length
}

export function createManualRowsFakePool() {
  const sheets = new Map<string, FakeSheet>()
  const records = new Map<string, FakeRecord>()
  const trash = new Map<string, FakeTrash>()
  const fieldPermissions: Array<{ sheetId: string; fieldId: string; userId: string; visible: boolean; readOnly: boolean }> = []
  /** `record_permissions` rows with access_level 'none' (a read deny, live only where the sheet's flag is on). */
  const recordDenies: Array<{ sheetId: string; recordId: string; userId: string }> = []
  const sqlLog: Array<{ sql: string; params: unknown[] }> = []
  const failures: { hostRegistry: { code?: string; message: string } | null; target: { code?: string; message: string } | null } = { hostRegistry: null, target: null }
  /** Called when a create / patch transaction re-reads the sheet's fields: lets a case change the sheet in between. */
  let onTransactionFieldRead: ((sheet: FakeSheet) => void) | null = null
  /** Called when the edit recheck locks the record FOR UPDATE. */
  let onRecordLockForUpdate: ((record: FakeRecord) => void) | null = null
  /** One-shot: the rows the candidate statement answers with INSTEAD of its evaluation (to prove the route's own mask). */
  let parentOptionsRowsOverride: unknown[] | null = null
  /** The LC_CTYPE this fake database folds text with in SQL `LOWER()` (see SQL_LOWER). */
  let databaseCtype: FakeDatabaseCtype = 'utf8'
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

    // ── the two fixed parent-picker statements (before every generic `meta_records` matcher below) ──
    if (q === PARENT_OPTIONS_STATEMENT) {
      if (parentOptionsRowsOverride) {
        const override = parentOptionsRowsOverride
        parentOptionsRowsOverride = null
        return rows(override)
      }
      return rows(evaluateParentOptionsStatement(records.values(), params, databaseCtype))
    }
    if (q === PARENT_DEPENDENTS_STATEMENT) return rows([{ dependents: evaluateParentDependentsStatement(records.values(), params) }])

    // ── the row policy: the sheet's read-deny flag and the actor's 'none' record_permissions ──
    if (q.startsWith('SELECT row_level_read_permissions_enabled AS enabled, base_id FROM meta_sheets WHERE id = $1')) {
      const s = sheets.get(p(0))
      return rows(s ? [{ enabled: s.rowLevelReadDeny === true, base_id: MR_BASE_ID }] : [])
    }
    if (q.startsWith('SELECT 1 FROM record_permissions WHERE sheet_id = $1')) {
      return rows(recordDenies.some((deny) => deny.sheetId === p(0)) ? [{ '?column?': 1 }] : [])
    }
    if (q.includes('FROM record_permissions rp')) {
      // Both shapes key on ($1 user, $2 sheet) and optionally narrow to `rp.record_id = ANY($3)`.
      const wanted = /rp\.record_id = ANY\(\$3/.test(q) ? new Set(asIds(params[2])) : null
      const hits = recordDenies.filter((deny) => deny.userId === p(0) && deny.sheetId === p(1) && (wanted === null || wanted.has(deny.recordId)))
      return rows(hits.map((deny) => ({ record_id: deny.recordId, access_level: 'none' })))
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
    recordDenies,
    sqlLog,
    failures,
    addSheet,
    addRecord,
    phys,
    setOnTransactionFieldRead(hook: ((sheet: FakeSheet) => void) | null) { onTransactionFieldRead = hook },
    setOnRecordLockForUpdate(hook: ((record: FakeRecord) => void) | null) { onRecordLockForUpdate = hook },
    overrideParentOptionsRows(rowsToReturn: unknown[] | null) { parentOptionsRowsOverride = rowsToReturn },
    setDatabaseCtype(ctype: FakeDatabaseCtype) { databaseCtype = ctype },
    statements(pattern: RegExp) { return sqlLog.filter((entry) => pattern.test(entry.sql)) },
    reset() {
      sheets.clear()
      records.clear()
      trash.clear()
      fieldPermissions.length = 0
      recordDenies.length = 0
      sqlLog.length = 0
      failures.hostRegistry = null
      failures.target = null
      onTransactionFieldRead = null
      onRecordLockForUpdate = null
      parentOptionsRowsOverride = null
      databaseCtype = 'utf8'
    },
  }
}

export type ManualRowsFakePg = ReturnType<typeof createManualRowsFakePool>
