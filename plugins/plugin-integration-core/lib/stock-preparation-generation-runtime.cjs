'use strict'

// #3751 stock-prep MVP — GENERATION run + EXCEPTION resolution (the W4 write half). Wires the landed
// generateStockPreparationMvp engine behind a route: feed it the CONFIRMED inputs (snapshot lines +
// mappings + unit rules + ERP master), persist draft prep-lines and blocking exceptions into the
// internal MVP tables with a run record, and expose single/bulk human exception resolution.
//
// HARD boundary (mirrors stock-preparation-confirm-writes.cjs / sync-run-persist.cjs):
//   - admin-gated + fail-closed BEFORE any provisioning / records access.
//   - internal-only: every read/write goes through createTargetScopedRecordsApi over the frozen
//     9-table set — NO external ERP / K3 / PLM write, NO apply-writer import, NO raw SQL, NO fetch.
//   - THE INVARIANT (server-side, never frontend-only): unresolved BLOCKING exceptions block the
//     ready state. `ready` is computed HERE as engineStatus==='ready' AND zero unresolved blocking
//     exceptions for the batch (pre-existing ones included). Nothing downstream can bypass it.
//   - human resolution is server-stamped: resolvedBy is the route-derived operator identity and
//     resolvedAt is stamped here — neither is ever body-sourced. An existing exception row is NEVER
//     patched by the generation run (create-only for NEW exceptionIds; resolution fields preserved).
//   - prep lines are working rows: re-running generation UPSERTS them by stockPrepLineId (create new,
//     patch existing with the freshly computed grounded row) — snapshots stay immutable; prep lines
//     deliberately refresh so confirms show up. The line template carries no human_preserved fields.
//   - bulk resolve carries the SAME-REASON gate (#3890): every target must share ONE exceptionType.
//   - MVP-conservative severity posture: BLOCKING exceptions can only be resolved with an explicit
//     resolution action (all engine exceptions are blocking today) — no ignore/defer bypass (OD6).
//   - who/when run stamps stay unset (parity with the sync-run committer: deterministic, owner-open).
//   - values-free evidence: counts / statuses / field-key NAMES / objectId constants / booleans /
//     sha16 handles only — never a drawing number, quantity, unit symbol, or exception message.
// (Every boundary token named above appears ONLY in this prose header — never as code.)

const {
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
  STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS,
} = require('./stock-preparation-templates.cjs')
const { createTargetScopedRecordsApi } = require('./stock-preparation-table-actions.cjs')
const { generateStockPreparationMvp } = require('./stock-preparation-mvp-generation.cjs')
const { optionalString, isPlainObject } = require('./stock-preparation-common.cjs')

const REQUIRED_PERMISSION = 'admin'
const READ_PAGE_LIMIT = 500
const READ_MAX_PAGES = 50
const MAX_BULK_RESOLVE = 200

// Closed vocabularies (design doc §8; the select option-sets are admin-supplied at option-sync time,
// so the fail-closed contract lives here).
const RESOLUTION_ACTIONS = Object.freeze(['mapping_confirmed', 'unit_rule_confirmed', 'accepted_change', 'manual_hold'])
const RESOLUTION_ACTION_SET = new Set(RESOLUTION_ACTIONS)
const EXCEPTION_STATUS_OPEN = 'open'
const EXCEPTION_STATUS_RESOLVED = 'resolved'
const BLOCKING_SEVERITY = 'blocking'
const GENERATION_RUN_TYPE = 'generation'

class StockPreparationGenerationRuntimeError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationGenerationRuntimeError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function templateByRole(role) {
  const template = STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((entry) => entry.role === role)
  if (!template) {
    throw new StockPreparationGenerationRuntimeError(500, 'GENERATION_TEMPLATE_MISSING', `frozen MVP template for role ${role} is missing`, { role })
  }
  return template
}

const MVP_OBJECT_ID_SET = new Set(STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS)
const BATCH_OBJECT_ID = templateByRole('bom_snapshot_batch').objectId
const LINE_OBJECT_ID = templateByRole('bom_snapshot_line').objectId
const RUN_OBJECT_ID = templateByRole('run_record').objectId
const MATERIAL_OBJECT_ID = templateByRole('erp_material_master').objectId
const MAPPING_OBJECT_ID = templateByRole('material_mapping').objectId
const RULE_OBJECT_ID = templateByRole('unit_conversion_rule').objectId
const PREP_LINE_TEMPLATE = templateByRole('stock_preparation_line')
const EXCEPTION_TEMPLATE = templateByRole('exception_confirmation')
const RUN_TEMPLATE = templateByRole('run_record')
const PREP_LINE_OBJECT_ID = PREP_LINE_TEMPLATE.objectId
const EXCEPTION_OBJECT_ID = EXCEPTION_TEMPLATE.objectId
const PREP_LINE_KEY_FIELD = PREP_LINE_TEMPLATE.keyFields[0] // 'stockPrepLineId'
const EXCEPTION_KEY_FIELD = EXCEPTION_TEMPLATE.keyFields[0] // 'exceptionId'
const RUN_KEY_FIELD = RUN_TEMPLATE.keyFields[0] // 'runId'
const PREP_LINE_FIELD_IDS = PREP_LINE_TEMPLATE.fields.map((field) => field.id)
const EXCEPTION_FIELD_IDS = EXCEPTION_TEMPLATE.fields.map((field) => field.id)
const RUN_FIELD_IDS = RUN_TEMPLATE.fields.map((field) => field.id)
// The human_preserved resolution trio the GENERATION run must never write (resolve stamps them).
const EXCEPTION_HUMAN_FIELD_IDS = Object.freeze(['resolutionAction', 'resolvedBy', 'resolvedAt'])

function assertAdminPermission(permission) {
  if (permission !== REQUIRED_PERMISSION) {
    throw new StockPreparationGenerationRuntimeError(
      403,
      'GENERATION_PERMISSION_DENIED',
      'stock-preparation generation runtime requires admin permission',
      { requiredPermission: REQUIRED_PERMISSION },
    )
  }
}

function ensureProvisioning(provisioning) {
  if (!provisioning || typeof provisioning.findObjectSheet !== 'function') {
    throw new StockPreparationGenerationRuntimeError(
      503,
      'GENERATION_PROVISIONING_API_UNAVAILABLE',
      'stock-preparation generation runtime requires multitable.provisioning.findObjectSheet',
      { requiredMethods: ['findObjectSheet'] },
    )
  }
  return provisioning
}

function ensureRecordsApi(recordsApi) {
  if (!recordsApi || typeof recordsApi.queryRecords !== 'function' ||
    typeof recordsApi.createRecord !== 'function' || typeof recordsApi.patchRecord !== 'function') {
    throw new StockPreparationGenerationRuntimeError(
      501,
      'GENERATION_RECORDS_API_INVALID',
      'stock-preparation generation runtime requires multitable.records queryRecords/createRecord/patchRecord',
      { requiredMethods: ['queryRecords', 'createRecord', 'patchRecord'] },
    )
  }
  return recordsApi
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationGenerationRuntimeError(422, 'GENERATION_CONFIG_INVALID', `${field} is required`, { field })
  }
  return normalized
}

async function resolveScopedTarget(recordsApi, provisioning, targetProjectId, objectId) {
  if (!MVP_OBJECT_ID_SET.has(objectId)) {
    throw new StockPreparationGenerationRuntimeError(
      500,
      'GENERATION_TARGET_OBJECT_ID_INVALID',
      'generation-runtime target objectId is not a stock-preparation MVP table',
      { objectId },
    )
  }
  const sheet = await provisioning.findObjectSheet({ projectId: targetProjectId, objectId })
  const sheetId = optionalString(sheet && sheet.id)
  if (!sheetId) {
    throw new StockPreparationGenerationRuntimeError(
      409,
      'GENERATION_TARGET_NOT_PROVISIONED',
      'stock-preparation MVP target table is not provisioned; provision the MVP tables first',
      { objectId },
    )
  }
  return { objectId, sheetId, scoped: createTargetScopedRecordsApi(recordsApi, { sheetId, objectId }) }
}

function recordData(record) {
  if (isPlainObject(record) && isPlainObject(record.data)) return record.data
  return isPlainObject(record) ? record : {}
}

function readCell(record, key) {
  return recordData(record)[key]
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

async function queryAllRecords(scoped, filters) {
  const rows = []
  for (let page = 0; page < READ_MAX_PAGES; page += 1) {
    const pageRows = await scoped.queryRecords({ filters, limit: READ_PAGE_LIMIT, offset: page * READ_PAGE_LIMIT })
    if (!Array.isArray(pageRows)) {
      throw new StockPreparationGenerationRuntimeError(500, 'GENERATION_RECORDS_API_INVALID', 'queryRecords must return an array')
    }
    rows.push(...pageRows)
    if (pageRows.length < READ_PAGE_LIMIT) return rows
  }
  throw new StockPreparationGenerationRuntimeError(422, 'GENERATION_READS_RESULT_TOO_LARGE', 'stock-preparation generation read exceeded the page bound', { maxPages: READ_MAX_PAGES })
}

async function findByKeyField(scoped, keyField, keyValue, notFoundCode, subject) {
  const rows = await scoped.queryRecords({ filters: { [keyField]: keyValue }, limit: 2, offset: 0 })
  if (!Array.isArray(rows)) {
    throw new StockPreparationGenerationRuntimeError(500, 'GENERATION_RECORDS_API_INVALID', 'queryRecords must return an array')
  }
  if (rows.length === 0) {
    throw new StockPreparationGenerationRuntimeError(404, notFoundCode, `${subject} was not found`, { [keyField]: keyValue })
  }
  if (rows.length > 1) {
    throw new StockPreparationGenerationRuntimeError(500, 'GENERATION_KEY_AMBIGUOUS', `${subject} key matched more than one row`, { [keyField]: keyValue })
  }
  return rows[0]
}

function groundRow(fieldIds, row, excludeFields = []) {
  const excluded = new Set(excludeFields)
  const out = {}
  for (const key of fieldIds) {
    if (excluded.has(key)) continue
    const value = row ? row[key] : undefined
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

// The same completeness predicate as the confirm modules: an explicit snapshotBatchId must exist,
// belong to the business project, and be COMPLETE (run row + non-empty lines); otherwise the LATEST
// complete batch of the project is picked. An orphaned mid-commit batch never feeds generation.
async function resolveCompleteBatchLines(api, prov, targetProjectId, projectId, snapshotBatchId) {
  const batchTarget = await resolveScopedTarget(api, prov, targetProjectId, BATCH_OBJECT_ID)
  const lineTarget = await resolveScopedTarget(api, prov, targetProjectId, LINE_OBJECT_ID)
  const runTarget = await resolveScopedTarget(api, prov, targetProjectId, RUN_OBJECT_ID)

  async function runPresent(batchRow) {
    const syncRunId = optionalString(readCell(batchRow, 'syncRunId'))
    if (!syncRunId) return false
    const runRows = await queryAllRecords(runTarget.scoped, { runId: syncRunId })
    return runRows.length > 0
  }

  if (snapshotBatchId) {
    const rows = await queryAllRecords(batchTarget.scoped, { snapshotBatchId })
    const batchRow = rows[0]
    if (!batchRow || optionalString(readCell(batchRow, 'projectId')) !== projectId) {
      throw new StockPreparationGenerationRuntimeError(404, 'GENERATION_BATCH_NOT_FOUND', 'snapshot batch was not found for this project', { snapshotBatchId })
    }
    if (!(await runPresent(batchRow))) {
      throw new StockPreparationGenerationRuntimeError(409, 'GENERATION_BATCH_INCOMPLETE', 'snapshot batch is incomplete (no run record)', { snapshotBatchId })
    }
    const lines = await queryAllRecords(lineTarget.scoped, { snapshotBatchId })
    if (lines.length === 0) {
      throw new StockPreparationGenerationRuntimeError(409, 'GENERATION_BATCH_INCOMPLETE', 'snapshot batch is incomplete (no lines)', { snapshotBatchId })
    }
    return { snapshotBatchId, lines: lines.map(recordData), runTarget }
  }

  const projectBatches = await queryAllRecords(batchTarget.scoped, { projectId })
  const ordered = projectBatches
    .map((row) => ({ row, id: optionalString(readCell(row, 'snapshotBatchId')), version: toNumber(readCell(row, 'snapshotVersion')) || 0 }))
    .filter((entry) => entry.id)
    .sort((left, right) => (right.version - left.version) || String(left.id).localeCompare(String(right.id)))
  for (const entry of ordered) {
    if (!(await runPresent(entry.row))) continue
    const lines = await queryAllRecords(lineTarget.scoped, { snapshotBatchId: entry.id })
    if (lines.length === 0) continue
    return { snapshotBatchId: entry.id, lines: lines.map(recordData), runTarget }
  }
  throw new StockPreparationGenerationRuntimeError(404, 'GENERATION_BATCH_NOT_FOUND', 'no complete snapshot batch exists for this project', { projectId })
}

function isUnresolvedBlocking(data) {
  return optionalString(data.severity) === BLOCKING_SEVERITY && optionalString(data.status) !== EXCEPTION_STATUS_RESOLVED
}

// ── generation run ────────────────────────────────────────────────────────────────────────────────
// Feed the engine the batch lines + ALL confirmation substrate rows, then persist:
//   prep lines   — UPSERT by stockPrepLineId (grounded; working rows deliberately refresh),
//   exceptions   — CREATE-ONLY for new exceptionIds (existing rows keep their human resolution),
//   run record   — create-only (stable engine runId; a replay leaves the original run row).
// Returns the INVARIANT verdict: ready === engine 'ready' AND zero unresolved blocking exceptions.
async function runStockPreparationGeneration(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationGenerationRuntimeError(422, 'GENERATION_CONFIG_INVALID', 'input must be an object')
  }
  const { permission, recordsApi, provisioning: provisioningInput, context } = input
  assertAdminPermission(permission)
  const prov = ensureProvisioning(
    provisioningInput || (context && context.api && context.api.multitable && context.api.multitable.provisioning),
  )
  const api = ensureRecordsApi(recordsApi)
  const targetProjectId = requiredString(input.targetProjectId, 'targetProjectId')
  const projectId = requiredString(input.projectId, 'projectId')
  const snapshotBatchId = optionalString(input.snapshotBatchId)

  const batchContext = await resolveCompleteBatchLines(api, prov, targetProjectId, projectId, snapshotBatchId)
  const materialTarget = await resolveScopedTarget(api, prov, targetProjectId, MATERIAL_OBJECT_ID)
  const mappingTarget = await resolveScopedTarget(api, prov, targetProjectId, MAPPING_OBJECT_ID)
  const ruleTarget = await resolveScopedTarget(api, prov, targetProjectId, RULE_OBJECT_ID)
  const prepLineTarget = await resolveScopedTarget(api, prov, targetProjectId, PREP_LINE_OBJECT_ID)
  const exceptionTarget = await resolveScopedTarget(api, prov, targetProjectId, EXCEPTION_OBJECT_ID)

  const existingPrepLineRecords = await queryAllRecords(prepLineTarget.scoped, { snapshotBatchId: batchContext.snapshotBatchId })
  const existingPrepLinesById = new Map(
    existingPrepLineRecords
      .map((record) => ({ record, id: optionalString(readCell(record, PREP_LINE_KEY_FIELD)) }))
      .filter((entry) => entry.id)
      .map((entry) => [entry.id, entry.record]),
  )
  const existingExceptionRecords = await queryAllRecords(exceptionTarget.scoped, { snapshotBatchId: batchContext.snapshotBatchId })
  const existingExceptionIds = new Set(
    existingExceptionRecords.map((record) => optionalString(readCell(record, EXCEPTION_KEY_FIELD))).filter(Boolean),
  )

  const generated = generateStockPreparationMvp({
    projectId,
    snapshotBatchId: batchContext.snapshotBatchId,
    bomSnapshotLines: batchContext.lines,
    erpMaterials: (await queryAllRecords(materialTarget.scoped, {})).map(recordData),
    materialMappings: (await queryAllRecords(mappingTarget.scoped, {})).map(recordData),
    unitConversionRules: (await queryAllRecords(ruleTarget.scoped, {})).map(recordData),
    existingStockPreparationLines: existingPrepLineRecords.map(recordData),
  })

  // Persist prep lines: upsert by key (create new / patch existing with the fresh grounded row).
  let linesCreated = 0
  let linesPatched = 0
  for (const line of generated.lines) {
    const stockPrepLineId = optionalString(line[PREP_LINE_KEY_FIELD])
    if (!stockPrepLineId) continue
    const grounded = groundRow(PREP_LINE_FIELD_IDS, line)
    const existing = existingPrepLinesById.get(stockPrepLineId)
    if (existing) {
      const changes = { ...grounded }
      delete changes[PREP_LINE_KEY_FIELD]
      await prepLineTarget.scoped.patchRecord({ recordId: existing.id, changes })
      linesPatched += 1
    } else {
      await prepLineTarget.scoped.createRecord({ data: grounded })
      linesCreated += 1
    }
  }

  // Persist exceptions: CREATE-ONLY for new ids; the resolution trio is structurally stripped so a
  // generation run can never stamp (or clobber) a human resolution.
  let exceptionsCreated = 0
  let exceptionsSkipped = 0
  for (const exception of generated.exceptions) {
    const exceptionId = optionalString(exception[EXCEPTION_KEY_FIELD])
    if (!exceptionId || existingExceptionIds.has(exceptionId)) {
      exceptionsSkipped += 1
      continue
    }
    await exceptionTarget.scoped.createRecord({ data: groundRow(EXCEPTION_FIELD_IDS, exception, EXCEPTION_HUMAN_FIELD_IDS) })
    existingExceptionIds.add(exceptionId)
    exceptionsCreated += 1
  }

  // Run record: create-only on the engine's stable runId (a replay keeps the original row).
  const runId = optionalString(generated.runId)
  let runCreated = 0
  if (runId) {
    const existingRun = await batchContextRunLookup(batchContext.runTarget.scoped, runId)
    if (!existingRun) {
      await batchContext.runTarget.scoped.createRecord({
        data: groundRow(RUN_FIELD_IDS, {
          runId,
          runType: GENERATION_RUN_TYPE,
          status: generated.status === 'blocked' ? 'failed' : 'succeeded',
        }),
      })
      runCreated = 1
    }
  }

  // THE INVARIANT: recount unresolved blocking exceptions AFTER persistence (pre-existing unresolved
  // rows included) — ready can never be reported while any of them remains.
  const exceptionRowsNow = await queryAllRecords(exceptionTarget.scoped, { snapshotBatchId: batchContext.snapshotBatchId })
  const unresolvedBlockingExceptionCount = exceptionRowsNow.filter((record) => isUnresolvedBlocking(recordData(record))).length
  const ready = generated.status === 'ready' && unresolvedBlockingExceptionCount === 0

  return {
    persisted: linesCreated + linesPatched + exceptionsCreated + runCreated > 0,
    mode: linesCreated + exceptionsCreated + runCreated > 0 ? 'created' : (linesPatched > 0 ? 'refreshed' : 'skipped_existing'),
    snapshotBatchId: batchContext.snapshotBatchId,
    runId,
    status: generated.status,
    ready,
    unresolvedBlockingExceptionCount,
    created: { lines: linesCreated, exceptions: exceptionsCreated, run: runCreated },
    patched: { lines: linesPatched },
    skipped: { exceptions: exceptionsSkipped },
    evidence: {
      ...generated.evidence,
      persistence: {
        lines: { created: linesCreated, patched: linesPatched, target: { objectId: PREP_LINE_OBJECT_ID } },
        exceptions: { created: exceptionsCreated, skipped: exceptionsSkipped, target: { objectId: EXCEPTION_OBJECT_ID }, humanFieldsExcluded: EXCEPTION_HUMAN_FIELD_IDS.slice() },
        run: { created: runCreated, target: { objectId: RUN_OBJECT_ID } },
      },
      ready,
      unresolvedBlockingExceptionCount,
      valuesFree: true,
    },
  }
}

async function batchContextRunLookup(scopedRun, runId) {
  const rows = await scopedRun.queryRecords({ filters: { [RUN_KEY_FIELD]: runId }, limit: 1, offset: 0 })
  if (!Array.isArray(rows)) {
    throw new StockPreparationGenerationRuntimeError(500, 'GENERATION_RECORDS_API_INVALID', 'queryRecords must return an array')
  }
  return rows[0] || null
}

// ── single exception resolve ──────────────────────────────────────────────────────────────────────
// Patch is EXACTLY { status:'resolved', resolutionAction, resolvedBy, resolvedAt } — server-stamped.
async function resolveStockPreparationException(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationGenerationRuntimeError(422, 'GENERATION_CONFIG_INVALID', 'input must be an object')
  }
  const { permission, recordsApi, provisioning: provisioningInput, context } = input
  assertAdminPermission(permission)
  const prov = ensureProvisioning(
    provisioningInput || (context && context.api && context.api.multitable && context.api.multitable.provisioning),
  )
  const api = ensureRecordsApi(recordsApi)
  const targetProjectId = requiredString(input.targetProjectId, 'targetProjectId')
  const exceptionId = requiredString(input.exceptionId, 'exceptionId')
  const resolvedBy = requiredString(input.resolvedBy, 'resolvedBy')
  const resolutionAction = optionalString(input.resolutionAction)
  if (!resolutionAction || !RESOLUTION_ACTION_SET.has(resolutionAction)) {
    throw new StockPreparationGenerationRuntimeError(400, 'EXCEPTION_RESOLUTION_ACTION_INVALID', 'resolutionAction must be one of the resolution-action vocabulary', { field: 'resolutionAction' })
  }

  const exceptionTarget = await resolveScopedTarget(api, prov, targetProjectId, EXCEPTION_OBJECT_ID)
  const record = await findByKeyField(exceptionTarget.scoped, EXCEPTION_KEY_FIELD, exceptionId, 'EXCEPTION_NOT_FOUND', 'stock-preparation exception')
  const data = recordData(record)
  if (optionalString(data.status) === EXCEPTION_STATUS_RESOLVED) {
    return { persisted: false, mode: 'skipped_already_resolved', exceptionId, evidence: resolveEvidence('skipped_already_resolved') }
  }
  const resolvedAt = new Date().toISOString()
  await exceptionTarget.scoped.patchRecord({
    recordId: record.id,
    changes: { status: EXCEPTION_STATUS_RESOLVED, resolutionAction, resolvedBy, resolvedAt },
  })
  return { persisted: true, mode: 'resolved', exceptionId, evidence: resolveEvidence('resolved') }
}

// ── bulk resolve (same-reason gate) ───────────────────────────────────────────────────────────────
// #3890: a bulk action must target ONE shared exceptionType — mixed batches are refused outright
// (fail-closed BEFORE any patch), and the id list is bounded.
async function bulkResolveStockPreparationExceptions(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationGenerationRuntimeError(422, 'GENERATION_CONFIG_INVALID', 'input must be an object')
  }
  const { permission, recordsApi, provisioning: provisioningInput, context } = input
  assertAdminPermission(permission)
  const prov = ensureProvisioning(
    provisioningInput || (context && context.api && context.api.multitable && context.api.multitable.provisioning),
  )
  const api = ensureRecordsApi(recordsApi)
  const targetProjectId = requiredString(input.targetProjectId, 'targetProjectId')
  const resolvedBy = requiredString(input.resolvedBy, 'resolvedBy')
  const resolutionAction = optionalString(input.resolutionAction)
  if (!resolutionAction || !RESOLUTION_ACTION_SET.has(resolutionAction)) {
    throw new StockPreparationGenerationRuntimeError(400, 'EXCEPTION_RESOLUTION_ACTION_INVALID', 'resolutionAction must be one of the resolution-action vocabulary', { field: 'resolutionAction' })
  }
  const exceptionIds = Array.isArray(input.exceptionIds) ? input.exceptionIds.map((value) => optionalString(value)).filter(Boolean) : []
  if (exceptionIds.length === 0) {
    throw new StockPreparationGenerationRuntimeError(400, 'EXCEPTION_BULK_IDS_INVALID', 'exceptionIds must be a non-empty array of ids', { field: 'exceptionIds' })
  }
  if (exceptionIds.length > MAX_BULK_RESOLVE) {
    throw new StockPreparationGenerationRuntimeError(422, 'EXCEPTION_BULK_TOO_LARGE', 'bulk resolve exceeds the id bound', { maxIds: MAX_BULK_RESOLVE })
  }
  const uniqueIds = [...new Set(exceptionIds)]

  const exceptionTarget = await resolveScopedTarget(api, prov, targetProjectId, EXCEPTION_OBJECT_ID)
  // Load EVERY target first — the same-reason gate and missing-id gate run BEFORE any patch.
  const records = []
  for (const exceptionId of uniqueIds) {
    const record = await findByKeyField(exceptionTarget.scoped, EXCEPTION_KEY_FIELD, exceptionId, 'EXCEPTION_NOT_FOUND', 'stock-preparation exception')
    records.push({ exceptionId, record })
  }
  const types = new Set(records.map((entry) => optionalString(readCell(entry.record, 'exceptionType')) || 'unknown'))
  if (types.size > 1) {
    throw new StockPreparationGenerationRuntimeError(409, 'EXCEPTION_BULK_MIXED_TYPES', 'bulk resolve targets must share one exceptionType (same-reason gate)', { typeCount: types.size })
  }

  const resolvedAt = new Date().toISOString()
  let resolved = 0
  let skipped = 0
  for (const entry of records) {
    if (optionalString(readCell(entry.record, 'status')) === EXCEPTION_STATUS_RESOLVED) {
      skipped += 1
      continue
    }
    await exceptionTarget.scoped.patchRecord({
      recordId: entry.record.id,
      changes: { status: EXCEPTION_STATUS_RESOLVED, resolutionAction, resolvedBy, resolvedAt },
    })
    resolved += 1
  }
  return {
    persisted: resolved > 0,
    mode: resolved > 0 ? 'resolved' : 'skipped_already_resolved',
    resolved,
    skipped,
    exceptionType: [...types][0],
    evidence: { ...resolveEvidence(resolved > 0 ? 'resolved' : 'skipped_already_resolved'), resolved, skipped, valuesFree: true },
  }
}

function resolveEvidence(mode) {
  return { subject: 'exception', mode, target: { objectId: EXCEPTION_OBJECT_ID, keyField: EXCEPTION_KEY_FIELD }, valuesFree: true }
}

module.exports = {
  REQUIRED_PERMISSION,
  RESOLUTION_ACTIONS,
  PREP_LINE_OBJECT_ID,
  EXCEPTION_OBJECT_ID,
  StockPreparationGenerationRuntimeError,
  runStockPreparationGeneration,
  resolveStockPreparationException,
  bulkResolveStockPreparationExceptions,
  __internals: {
    assertAdminPermission,
    ensureProvisioning,
    ensureRecordsApi,
    resolveScopedTarget,
    resolveCompleteBatchLines,
    queryAllRecords,
    findByKeyField,
    groundRow,
    isUnresolvedBlocking,
    MVP_OBJECT_ID_SET,
    PREP_LINE_FIELD_IDS,
    EXCEPTION_FIELD_IDS,
    EXCEPTION_HUMAN_FIELD_IDS,
    MAX_BULK_RESOLVE,
  },
}
