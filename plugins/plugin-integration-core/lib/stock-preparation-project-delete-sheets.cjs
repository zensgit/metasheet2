'use strict'

const { createHash } = require('node:crypto')
const {
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
  STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE,
  STOCK_PREPARATION_PROJECT_OVERVIEW_TABLE_TEMPLATE,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require('./stock-preparation-templates.cjs')
const {
  deriveStockPreparationProjectSheetObjectId, deriveStockPreparationBaseId,
  isStockPreparationProjectSheetObjectId,
} = require('./stock-preparation-own-base.cjs')
const { generationRunId } = require('./stock-preparation-mvp-generation.cjs')
const { isSandboxNamespaceObjectId } = require('./stock-preparation-target-provisioning.cjs')
const { planSheetDependencies, deleteSheetDependencies, DEPENDENCY_TABLES } = require('./stock-preparation-project-delete-sheet-dependencies.cjs')

const TARGETS = 'integration_stock_prep_project_target'
const OWNERS = 'plugin_multitable_object_registry'
const PLUGIN = 'plugin-integration-core'
const SHEET_LOCK_TABLES = Object.freeze([...new Set([
  TARGETS, OWNERS, 'meta_bases', 'meta_sheets', 'meta_fields', 'meta_records', 'meta_records_trash', ...DEPENDENCY_TABLES,
])])

// Only project-scoped MVP roles participate. Material masters, mapping and conversion rules
// are tenant reference data. Physical ids follow the host's provisioning.ts stableMetaId.
const roles = {
  project: ['projectRows', 'sourceProjectNo', 'projectId', 'lastSyncRunId'],
  bom_snapshot_batch: ['snapshotBatches', 'projectId', 'snapshotBatchId', 'syncRunId'],
  bom_snapshot_line: ['snapshotLines', 'snapshotBatchId', 'snapshotLineId'],
  stock_preparation_line: ['preparationLines', 'projectId', 'snapshotBatchId', 'snapshotLineId', 'stockPrepLineId', 'createdFromRunId'],
  exception_confirmation: ['exceptions', 'projectId', 'snapshotBatchId', 'snapshotLineId', 'stockPrepLineId'],
  run_record: ['runRows', 'runId', 'status'],
}
const shared = new Map(STOCK_PREPARATION_MVP_TABLE_TEMPLATES.filter(t => roles[t.role]).map(t => [t.objectId, roles[t.role]]))
shared.set(STOCK_PREPARATION_CONFIRMATION_DECISION_TABLE_TEMPLATE.objectId, ['confirmationDecisions', 'projectNo'])
shared.set(STOCK_PREPARATION_PROJECT_OVERVIEW_TABLE_TEMPLATE.objectId, ['overviewRows', 'projectNo'])
shared.set(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId, ['sharedPullRows', 'projectNo'])
const direct = new Set(['dedicatedRows', 'sharedPullRows', 'overviewRows', 'confirmationDecisions'])

function refuse(code = 'AMBIGUOUS') {
  const error = new Error('The project cannot be deleted in its current state.')
  error.status = 409
  error.code = 'STOCK_PREPARATION_PROJECT_DELETE_' + code
  throw error
}

function isReferenceObject(objectId) {
  return STOCK_PREPARATION_MVP_TABLE_TEMPLATES.some(t => t.objectId === objectId && !roles[t.role])
}

function physical(prefix, ...parts) {
  return prefix + '_' + createHash('sha1').update(parts.join(':')).digest('hex').slice(0, 24)
}

const digest = (row) => `encode(sha256(convert_to(${row}.xmin::text || ':' || to_jsonb(${row})::text, 'UTF8')), 'hex')`
const unique = (rows, key) => [...new Set(rows.map(row => row[key]).filter(Boolean))]

async function discover(tx, { tenantId, projectNo, boundTarget }) {
  const stage = tenantId + ':integration-core'
  const dedicatedObject = deriveStockPreparationProjectSheetObjectId(tenantId, projectNo)
  const dedicatedId = physical('sheet', stage, dedicatedObject)
  const scopeObjects = [...shared.keys(), dedicatedObject]
  const expected = new Set(scopeObjects.map(object => physical('sheet', stage, object)))
  const candidates = new Set(expected)
  if (boundTarget?.sheetId) candidates.add(boundTarget.sheetId)
  const registry = await tx.query(
    `SELECT sheet_id, object_id, ${digest('t')} AS hash FROM ${TARGETS} t WHERE tenant_id = $1 AND project_no = $2`,
    [tenantId, projectNo],
  )
  if (registry.length > 1 || registry.some(t => t.object_id !== dedicatedObject || t.sheet_id !== dedicatedId)) refuse()

  const rows = await tx.query(
    `SELECT s.id, s.name, s.deleted_at, b.id AS base_id, b.owner_id, b.workspace_id, b.deleted_at AS base_deleted_at, to_jsonb(s)->>'system_kind' AS system_kind, to_jsonb(s)->>'recovery_writer_state' AS writer_state,
            o.object_id, o.plugin_name, o.project_id,
            ${digest('s')} AS sheet_hash, ${digest('o')} AS owner_hash
       FROM meta_sheets s LEFT JOIN ${OWNERS} o ON o.sheet_id = s.id
       LEFT JOIN meta_bases b ON b.id = s.base_id
      WHERE s.id = ANY($1::text[]) OR (o.project_id = $2 AND
        (o.object_id = ANY($3::text[]) OR starts_with(o.object_id, 'plm_stock_preparation_sandbox')))
      ORDER BY s.id`,
    [[...candidates], stage, scopeObjects],
  )
  const sheets = []
  for (const row of rows) {
    const bound = row.id === boundTarget?.sheetId
    // A deployment-wide legacy binding can designate another tenant. Never read its contents.
    if (bound && row.project_id && row.project_id !== stage && !expected.has(row.id)) continue
    // Before the object registry existed, a deterministic id alone could also be supplied by a
    // user creating an ordinary sheet. Accept a bound legacy target only inside the tenant's
    // live, plugin-owned system base using the same base checks as provisioning.ensureSystemBase.
    if (bound && !row.object_id && !row.project_id && !row.plugin_name) {
      const objectId = boundTarget.objectId || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
      if (row.id !== physical('sheet', stage, objectId) || row.deleted_at || row.base_deleted_at ||
          row.base_id !== deriveStockPreparationBaseId(tenantId) || row.owner_id !== null || row.workspace_id !== null ||
          isStockPreparationProjectSheetObjectId(objectId) ||
          !(objectId === STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId || isSandboxNamespaceObjectId(objectId))) refuse()
      row.object_id = objectId
      row.owner_hash = 'verified-legacy-base:' + row.base_id
    } else if (row.project_id !== stage || row.plugin_name !== PLUGIN) refuse()
    if (isStockPreparationProjectSheetObjectId(row.object_id) && row.object_id !== dedicatedObject) {
      if (row.id === dedicatedId) refuse()
      continue
    }
    const isDedicated = row.object_id === dedicatedObject
    let descriptor = shared.get(row.object_id)
    if (isDedicated) descriptor = ['dedicatedRows', 'projectNo', 'idempotencyKey']
    else if (!descriptor && (bound || isSandboxNamespaceObjectId(row.object_id))) descriptor = ['sharedPullRows', 'projectNo']
    if (!descriptor) continue
    if (bound && !isDedicated && isReferenceObject(row.object_id)) refuse()
    if (physical('sheet', stage, row.object_id) !== row.id && !bound) refuse()
    if (isDedicated && (!registry.length || row.id !== dedicatedId || row.system_kind)) refuse()
    const [category, ...fields] = descriptor
    if (row.system_kind && !(category === 'overviewRows' && row.system_kind === 'stock_prep_overview')) refuse()
    const keyMap = Object.fromEntries(fields.map(key => [key, physical('fld', stage, row.object_id, key)]))
    if (bound && category === 'sharedPullRows') {
      const map = boundTarget.fieldIdMap || {}
      keyMap.projectNo = Object.keys(map).length ? map.projectNo : 'projectNo'
      if (typeof keyMap.projectNo !== 'string' || !keyMap.projectNo.trim()) refuse()
    }
    sheets.push({ ...row, category, fields: keyMap })
  }
  if (registry.length && !sheets.some(s => s.category === 'dedicatedRows')) refuse()
  if (sheets.length) {
    const metadata = await tx.query(
      `SELECT f.sheet_id, f.id, ${digest('f')} AS hash FROM meta_fields f
       WHERE f.sheet_id = ANY($1::text[]) AND f.id = ANY($2::text[]) ORDER BY f.id`,
      [sheets.map(s => s.id), sheets.flatMap(s => Object.values(s.fields))],
    )
    const columns = new Map(metadata.map(row => [row.id, row]))
    for (const sheet of sheets) {
      const ownerColumn = columns.get(Object.values(sheet.fields)[0])
      if (ownerColumn?.sheet_id !== sheet.id) refuse()
      sheet.columnHashes = Object.values(sheet.fields).map(id => columns.get(id)?.hash || 'absent')
    }
  }
  return { registry, sheets }
}

// SQL returns only scoped navigation keys and a content digest, including every column of a
// record. Reading the recycle bin prevents a previously deleted manual row from reappearing
// when the same deterministic sheet id is recreated. An incomplete ownership key on a shared
// table is a refusal, never an implicit match. Read scope is always the verified sheet id.
async function readRows(tx, sheet, filters, ownerKey, allowBlank = false) {
  const keys = Object.keys(sheet.fields)
  const params = [sheet.id, ...Object.values(sheet.fields)]
  const fieldParam = key => '$' + (2 + keys.indexOf(key)) + '::text'
  const clauses = []
  for (const [key, ids] of Object.entries(filters)) {
    if (!ids.length) continue
    params.push(ids)
    clauses.push(`btrim(r.data->>${fieldParam(key)}) = ANY($${params.length}::text[])`)
  }
  if (ownerKey && !allowBlank) {
    const key = fieldParam(ownerKey)
    clauses.push(`(jsonb_typeof(r.data->${key}) IS DISTINCT FROM 'string' OR btrim(r.data->>${key}) = '')`)
  }
  if (!clauses.length && !allowBlank) return []
  const columns = keys.map(key => `r.data->${fieldParam(key)} AS "${key}"`).join(', ')
  const read = (relation, trash) => tx.query(
    `SELECT r.id::text AS id, ${trash ? 'r.record_id' : 'r.id'} AS record_id, ${columns}, ${digest('r')} AS hash
       FROM ${relation} r WHERE r.sheet_id = $1 ${clauses.length ? 'AND (' + clauses.join(' OR ') + ')' : ''} ORDER BY r.id`,
    params,
  )
  const live = await read('meta_records', false)
  const trash = await read('meta_records_trash', true)
  const result = [...live.map(r => ({ ...r, trash: false })), ...trash.map(r => ({ ...r, trash: true }))]
  for (const row of result) {
    for (const key of keys) {
      if (row[key] == null) continue
      if (typeof row[key] !== 'string' || (row[key] && row[key] !== row[key].trim())) refuse()
    }
    if (ownerKey && !allowBlank && !row[ownerKey]) refuse()
  }
  return result
}

async function planSheets(tx, scope) {
  const { sheets, registry } = await discover(tx, scope)
  const ownedTargetSheetIds = sheets.filter(s => ['dedicatedRows', 'sharedPullRows'].includes(s.category)).map(s => s.id)
  const counts = Object.fromEntries([...new Set([...shared.values()].map(v => v[0]))].map(key => [key, 0]))
  Object.assign(counts, { dedicatedRows: 0, dedicatedSheets: registry.length, managedRegistrations: registry.length,
    projectTargets: registry.length, trashRows: 0, sheetDependencies: 0 })
  const selected = new Map()
  const selectedBySheet = new Map(sheets.map(s => [s.id, new Map()]))
  const select = (s, rows) => {
    const target = selectedBySheet.get(s.id)
    for (const row of rows) target.set((row.trash ? 'trash:' : 'live:') + row.id, row)
    return rows
  }
  const queryCategory = async (category, filters, owner) => {
    const s = sheets.find(sheet => sheet.category === category)
    if (!s) return []
    return select(s, await readRows(tx, s, filters, owner))
  }

  const projectNo = scope.projectNo
  for (const sheet of sheets.filter(s => direct.has(s.category))) {
    if (sheet.category === 'dedicatedRows') {
      const rows = await readRows(tx, sheet, {}, 'projectNo', true)
      if (rows.some(row => row.projectNo && row.projectNo !== projectNo)) refuse()
      for (const row of rows) {
        if (row.idempotencyKey?.startsWith('{')) {
          let identity
          try { identity = JSON.parse(row.idempotencyKey) } catch { refuse() }
          if (identity.projectNo !== projectNo) refuse()
        }
      }
      select(sheet, rows)
    } else {
      select(sheet, await readRows(tx, sheet, { projectNo: [projectNo] }, 'projectNo'))
    }
  }

  const projects = await queryCategory('projectRows', { sourceProjectNo: [projectNo] }, 'sourceProjectNo')
  if (projects.some(p => !p.projectId) || new Set(projects.map(p => p.projectId)).size > 1) refuse()
  const ids = unique(projects, 'projectId')
  const projectAliases = await queryCategory('projectRows', { projectId: ids }, null)
  if (projectAliases.some(p => p.sourceProjectNo !== projectNo)) refuse()
  const batches = await queryCategory('snapshotBatches', { projectId: ids }, 'projectId')
  if (batches.some(b => !b.snapshotBatchId)) refuse()
  const batchIds = unique(batches, 'snapshotBatchId')
  const lines = await queryCategory('snapshotLines', { snapshotBatchId: batchIds }, 'snapshotBatchId')
  const prep = await queryCategory('preparationLines', { projectId: ids }, 'projectId')
  const exceptions = await queryCategory('exceptions', { projectId: ids }, 'projectId')
  const prepIds = [...unique(prep, 'stockPrepLineId'), ...unique(exceptions, 'stockPrepLineId')]
  const allBatchIds = [...batchIds, ...unique(prep, 'snapshotBatchId'), ...unique(exceptions, 'snapshotBatchId')]
  const lineIds = [...unique(lines, 'snapshotLineId'), ...unique(prep, 'snapshotLineId'), ...unique(exceptions, 'snapshotLineId')]
  if (allBatchIds.some(key => !batchIds.includes(key))) refuse()
  const generationIds = batches.map(b => generationRunId(b.projectId, b.snapshotBatchId))
  const runIds = [...generationIds, ...unique(projects, 'lastSyncRunId'), ...unique(batches, 'syncRunId'), ...unique(prep, 'createdFromRunId')]
  // The same logical key can be hand-edited or duplicated on these shared tables.
  // Check the inverse edges as well as the forward reads before accepting a join as ownership.
  const batchRefs = await queryCategory('snapshotBatches', { snapshotBatchId: allBatchIds, syncRunId: runIds }, null)
  const lineRefs = await queryCategory('snapshotLines', { snapshotLineId: lineIds }, null)
  const prepRefs = await queryCategory('preparationLines', { stockPrepLineId: prepIds, snapshotBatchId: allBatchIds, snapshotLineId: lineIds, createdFromRunId: runIds }, null)
  const exceptionRefs = await queryCategory('exceptions', { stockPrepLineId: prepIds, snapshotBatchId: allBatchIds, snapshotLineId: lineIds }, null)
  const runRefs = await queryCategory('projectRows', { lastSyncRunId: runIds }, null)
  if ([...batchRefs, ...prepRefs, ...exceptionRefs].some(r => !ids.includes(r.projectId)) ||
      lineRefs.some(r => !batchIds.includes(r.snapshotBatchId)) || runRefs.some(r => r.sourceProjectNo !== projectNo)) refuse()
  const runs = await queryCategory('runRows', { runId: runIds }, null)
  if (runs.some(r => !r.trash && r.status === 'running')) refuse('BUSY')
  if (runs.some(r => !r.trash && !['succeeded', 'failed', 'partial'].includes(r.status))) refuse()

  const tables = []
  const evidence = registry.map(r => r.hash)
  const dedicatedSheetId = sheets.find(s => s.category === 'dedicatedRows')?.id || null
  for (const sheet of sheets) {
    const rows = [...selectedBySheet.get(sheet.id).values()].sort((a, b) => a.id.localeCompare(b.id))
    if (!rows.length && sheet.id !== dedicatedSheetId) continue
    if (sheet.writer_state) refuse('BUSY')
    const live = rows.filter(r => !r.trash)
    const trash = rows.filter(r => r.trash)
    counts[sheet.category] += live.length
    counts.trashRows += trash.length
    tables.push({ sheetId: sheet.id, name: sheet.name, kind: sheet.id === dedicatedSheetId ? 'dedicated' : 'shared', rowCount: live.length })
    evidence.push(sheet.id, sheet.owner_hash, sheet.sheet_hash, JSON.stringify(sheet.fields), ...sheet.columnHashes)
    for (const row of rows) evidence.push(row.hash)
    selected.set(sheet.id, { live: live.map(r => r.id), trash: trash.map(r => r.id), recordIds: unique(rows, 'record_id') })
  }
  const dependencies = await planSheetDependencies(tx, dedicatedSheetId, selected)
  counts.sheetDependencies = dependencies.count
  const identityPresent = Boolean(registry.length || counts.projectRows || counts.sharedPullRows)
  if (!identityPresent && selected.size) refuse()
  const fingerprint = createHash('sha256')
  for (const value of [...evidence, dependencies.hash]) fingerprint.update(value).update('\n')
  return { counts, tables, fingerprint: fingerprint.digest('hex'), identityPresent, ownedTargetSheetIds, dedicatedSheetId, selected, dependencies }
}

async function deleteSheets(tx, { tenantId, projectNo }, plan) {
  await deleteSheetDependencies(tx, plan.dedicatedSheetId, plan.selected, plan.dependencies)
  for (const [sheetId, selection] of plan.selected) {
    for (const [table, ids] of [['meta_records_trash', selection.trash], ['meta_records', selection.live]]) {
      if (!ids.length) continue
      const removed = await tx.query(`DELETE FROM ${table} WHERE sheet_id = $1 AND id = ANY($2::${table === 'meta_records_trash' ? 'uuid' : 'text'}[]) RETURNING 1`, [sheetId, ids])
      if (removed.length !== ids.length) refuse('STALE')
    }
  }
  if (!plan.dedicatedSheetId) return
  const sheetId = plan.dedicatedSheetId
  const target = await tx.query(`DELETE FROM ${TARGETS} WHERE tenant_id = $1 AND project_no = $2 AND sheet_id = $3 RETURNING 1`, [tenantId, projectNo, sheetId])
  const owner = await tx.query(`DELETE FROM ${OWNERS} WHERE project_id = $1 AND object_id = $2 AND plugin_name = $3 AND sheet_id = $4 RETURNING 1`,
    [tenantId + ':integration-core', deriveStockPreparationProjectSheetObjectId(tenantId, projectNo), PLUGIN, sheetId])
  if (target.length !== 1 || owner.length !== 1) refuse('STALE')
  const removed = await tx.query('DELETE FROM meta_sheets WHERE id = $1 RETURNING 1', [sheetId])
  if (removed.length !== 1) refuse('STALE')
}

async function existsProjectRoot(tx, scope) {
  const { sheets, registry } = await discover(tx, scope)
  if (registry.length) return true
  for (const sheet of sheets) {
    const key = sheet.category === 'projectRows' ? 'sourceProjectNo' : 'projectNo'
    if (sheet.category !== 'projectRows' && sheet.category !== 'sharedPullRows') continue
    const found = await tx.query(
      'SELECT 1 FROM meta_records WHERE sheet_id = $1 AND data->>$2::text = $3 LIMIT 1',
      [sheet.id, sheet.fields[key], scope.projectNo],
    )
    if (found.length) return true
  }
  return false
}

module.exports = { planSheets, deleteSheets, existsProjectRoot, SHEET_LOCK_TABLES }
