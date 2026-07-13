'use strict'

// #3751 stock-prep MVP T2 — persist ALREADY-NORMALIZED ERP/K3 material-master intake rows (the shape
// stock-preparation-readonly-intake.cjs's normalizeStockPreparationReadonlyIntake().erpMaterials
// produces, or an equivalent sample/fixture) into the internal erp_material_master CACHE table.
//
// Why this module exists (four-source audit): stock-preparation-confirm-writes.cjs:335 already QUERIES
// erp_material_master (`queryAllRecords(materialTarget.scoped, {})`) to feed generateMaterialMappingCandidates,
// and stock-preparation-generation-runtime.cjs does the same to feed generateStockPreparationMvp — both
// EXPECT the table to be populated. stock-preparation-sync-run-plan.cjs's design-grounded run_type
// vocabulary has always reserved 'erp_material_sync' as its OWN run type (distinct from 'plm_sync'), and
// stock-preparation-readonly-intake.cjs already normalizes an `erpMaterials` row set. But until this
// module, NOTHING ever wrote a row into erp_material_master — every module that reads it was reading an
// eternally-empty table (persist repo audit: zero createRecord/patchRecord call anywhere referenced
// MATERIAL_OBJECT_ID before this file).
//
// Design choice (why a NEW module, not an extra `erpMaterials` field bolted onto
// persistStockPreparationSyncRun): a PLM BOM-snapshot sync run and an ERP/K3 material-master sync are
// DIFFERENT run types over DIFFERENT source systems on DIFFERENT cadences — planBomSnapshotSyncRun
// requires a projectId/syncRunId/snapshotBatchId/expansionResult that have nothing to do with the ERP
// material catalog (K3/ERP material masters are not scoped to one PLM project's BOM snapshot at all;
// see stock-preparation-readonly-source-run.cjs's runErpMaterialReadonlySource, which likewise takes NO
// projectId — "a field accepted and then ignored is an invitation to believe it scopes something", the
// same principle http-routes.cjs already states for the ERP source-run request allowlist). Forcing ERP
// material persistence through the BOM-snapshot committer would mean inventing a throwaway
// project/batch/line context just to satisfy an unrelated plan's required fields. Symmetry with the
// LANDED precedent instead means: mirror how stock-preparation-generation-runtime.cjs earns its OWN
// 'prep_generate' run type in its OWN module (never bolted onto sync-run-persist) — this module earns
// 'erp_material_sync' the same way.
//
// HARD boundary (mirrors stock-preparation-sync-run-persist.cjs / confirm-writes.cjs / generation-runtime.cjs):
//   - admin-gated + fail-closed: assertAdminPermission runs BEFORE any provisioning / records access.
//   - internal-only: every createRecord / patchRecord / queryRecords goes through a scoped API bound to
//     a resolved MVP sheet whose objectId is in the frozen 9-table set (createTargetScopedRecordsApi),
//     which ALSO resolves the frozen template's logical->physical fieldId map through
//     provisioning.resolveFieldIds (#4160/#4163) — this module speaks ONLY the templates' logical keys,
//     never a physical id. There is NO external ERP / K3 write, NO apply-writer import, NO K3
//     Save/Submit/Audit, NO auto-creation of an ERP material in any external system, NO raw SQL, and NO
//     fetch / live HTTP I/O of any kind (externalWrite stays false — this module lands ALREADY-fetched,
//     already-normalized intake rows into the internal cache; it does not itself read K3/ERP).
//   - upsert, not immutable snapshot: erp_material_master is a CACHE, not a versioned snapshot, and every
//     one of its fields is plm_system (STOCK_PREPARATION_MVP_TABLE_TEMPLATES: zero human_preserved
//     fields on this template) — so a re-sync FULLY refreshes a row (explicit-clear: every declared
//     field absent from the fresh row is nulled, mirroring generation-runtime.cjs's prep-line refresh),
//     never partially. The upsert key is derived from the frozen template's OWN keyFields[0], never a
//     hardcoded 'erpMaterialId' literal, so a future keyFields change cannot silently drift this module.
//   - the run record earns the design's reserved 'erp_material_sync' run type (create-if-absent / patch
//     status-if-changed, mirroring generation-runtime.cjs's run-record handling — a re-run of the SAME
//     syncRunId updates the ledger's verdict rather than duplicating a row).
//   - values-free evidence: counts / statuses / modes / field-key NAMES / public objectId constants /
//     booleans only — never an erpMaterialCode, erpMaterialName, spec, unit symbol, or internal id.
// (Every boundary token named above appears ONLY in this prose header — never as code.)

const {
  STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS,
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
} = require('./stock-preparation-templates.cjs')
const { createTargetScopedRecordsApi } = require('./stock-preparation-table-actions.cjs')
const { optionalString, isPlainObject } = require('./stock-preparation-common.cjs')

const REQUIRED_PERMISSION = 'admin'
const READ_PAGE_LIMIT = 500
const READ_MAX_PAGES = 50

// Design-grounded enum literal (docs/development/stock-preparation-mvp-design-20260707.md §runs;
// stock-preparation-sync-run-plan.cjs's header comment reserves the SAME closed vocabulary):
//   run_type ∈ {plm_sync, erp_material_sync, mapping_match, unit_match, prep_generate}.
const ERP_MATERIAL_SYNC_RUN_TYPE = 'erp_material_sync'
const RUN_STATUS_SUCCEEDED = 'succeeded'
const RUN_STATUS_PARTIAL = 'partial'

class StockPreparationErpMaterialSyncError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationErpMaterialSyncError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function templateByRole(role) {
  const template = STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((entry) => entry.role === role)
  if (!template) {
    throw new StockPreparationErpMaterialSyncError(500, 'ERP_MATERIAL_SYNC_TEMPLATE_MISSING', `frozen MVP template for role ${role} is missing`, { role })
  }
  return template
}

// Object id / field ids / key field come straight from the FROZEN templates — nothing invented here.
// The key field in particular is READ from the template (owner directive: never hardcode
// 'erpMaterialId' — a future keyFields change to the template must not silently drift this module).
const MVP_OBJECT_ID_SET = new Set(STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS)
const MATERIAL_TEMPLATE = templateByRole('erp_material_master')
const RUN_TEMPLATE = templateByRole('run_record')
const MATERIAL_OBJECT_ID = MATERIAL_TEMPLATE.objectId
const RUN_OBJECT_ID = RUN_TEMPLATE.objectId
const MATERIAL_KEY_FIELD = MATERIAL_TEMPLATE.keyFields[0] // 'erpMaterialId' — read, not hardcoded.
const RUN_KEY_FIELD = RUN_TEMPLATE.keyFields[0] // 'runId'
const MATERIAL_FIELD_IDS = Object.freeze(MATERIAL_TEMPLATE.fields.map((field) => field.id))
const RUN_FIELD_IDS = Object.freeze(RUN_TEMPLATE.fields.map((field) => field.id))
// Every field the template requires (INCLUDES the key field) — read from the template's OWN
// requiredFields, never hand-duplicated, so erpMaterialInternalId (required-but-not-key; confirm-writes
// matches candidates on it) can never be silently dropped from the required-completeness check below.
const MATERIAL_REQUIRED_FIELD_IDS = Object.freeze(MATERIAL_TEMPLATE.requiredFields.slice())

function assertAdminPermission(permission) {
  if (permission !== REQUIRED_PERMISSION) {
    throw new StockPreparationErpMaterialSyncError(
      403,
      'ERP_MATERIAL_SYNC_PERMISSION_DENIED',
      'stock-preparation ERP material sync requires admin permission',
      { requiredPermission: REQUIRED_PERMISSION },
    )
  }
}

// #4160: resolveFieldIds is REQUIRED, not optional — the scoped records API translates the frozen
// templates' logical keys to the physical fieldIds the records service actually accepts, and it
// resolves that map through this API. A provisioning facade without it fails closed here.
function ensureProvisioning(provisioning) {
  if (!provisioning || typeof provisioning.findObjectSheet !== 'function' || typeof provisioning.resolveFieldIds !== 'function') {
    throw new StockPreparationErpMaterialSyncError(
      503,
      'ERP_MATERIAL_SYNC_PROVISIONING_API_UNAVAILABLE',
      'stock-preparation ERP material sync requires multitable.provisioning findObjectSheet/resolveFieldIds',
      { requiredMethods: ['findObjectSheet', 'resolveFieldIds'] },
    )
  }
  return provisioning
}

function ensureRecordsApi(recordsApi) {
  if (!recordsApi || typeof recordsApi.queryRecords !== 'function' ||
    typeof recordsApi.createRecord !== 'function' || typeof recordsApi.patchRecord !== 'function') {
    throw new StockPreparationErpMaterialSyncError(
      501,
      'ERP_MATERIAL_SYNC_RECORDS_API_UNAVAILABLE',
      'stock-preparation ERP material sync requires multitable.records queryRecords/createRecord/patchRecord',
      { requiredMethods: ['queryRecords', 'createRecord', 'patchRecord'] },
    )
  }
  return recordsApi
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationErpMaterialSyncError(422, 'ERP_MATERIAL_SYNC_CONFIG_INVALID', `${field} is required`, { field })
  }
  return normalized
}

// Resolve ONE MVP objectId to a scoped, sheet-bound, logical-field-speaking records API (mirror of
// sync-run-persist.cjs / confirm-writes.cjs / generation-runtime.cjs's resolveScopedTarget).
async function resolveScopedTarget(recordsApi, provisioning, targetProjectId, objectId) {
  if (!MVP_OBJECT_ID_SET.has(objectId)) {
    // Defense-in-depth: the material/run objectIds come from frozen templates, so this only fires if
    // the frozen set drifts — never persist to a non-MVP object.
    throw new StockPreparationErpMaterialSyncError(
      500,
      'ERP_MATERIAL_SYNC_TARGET_OBJECT_ID_INVALID',
      'ERP material sync target objectId is not a stock-preparation MVP table',
      { objectId },
    )
  }
  const sheet = await provisioning.findObjectSheet({ projectId: targetProjectId, objectId })
  const sheetId = optionalString(sheet && sheet.id)
  if (!sheetId) {
    throw new StockPreparationErpMaterialSyncError(
      409,
      'ERP_MATERIAL_SYNC_TARGET_NOT_PROVISIONED',
      'stock-preparation MVP target table is not provisioned; provision the MVP tables before sync',
      { objectId },
    )
  }
  const scoped = await createTargetScopedRecordsApi(recordsApi, { sheetId, objectId }, { provisioning, projectId: targetProjectId })
  return { objectId, sheetId, scoped }
}

function recordData(record) {
  if (isPlainObject(record) && isPlainObject(record.data)) return record.data
  return isPlainObject(record) ? record : {}
}

function readCell(record, key) {
  return recordData(record)[key]
}

// Bounded scan (parity with confirm-writes.cjs / generation-runtime.cjs): page until a short page or
// fail closed on the bound.
async function queryAllRecords(scoped, filters) {
  const rows = []
  for (let page = 0; page < READ_MAX_PAGES; page += 1) {
    const pageRows = await scoped.queryRecords({ filters, limit: READ_PAGE_LIMIT, offset: page * READ_PAGE_LIMIT })
    if (!Array.isArray(pageRows)) {
      throw new StockPreparationErpMaterialSyncError(500, 'ERP_MATERIAL_SYNC_RECORDS_API_INVALID', 'queryRecords must return an array')
    }
    rows.push(...pageRows)
    if (pageRows.length < READ_PAGE_LIMIT) return rows
  }
  throw new StockPreparationErpMaterialSyncError(422, 'ERP_MATERIAL_SYNC_READS_RESULT_TOO_LARGE', 'stock-preparation ERP material read exceeded the page bound', { maxPages: READ_MAX_PAGES })
}

// Ground a row to ONLY the frozen template field ids, dropping null/undefined (the records service
// rejects an unknown fieldId — see createTargetScopedRecordsApi's #4160 translation layer).
function groundRow(fieldIds, row) {
  const out = {}
  for (const key of fieldIds) {
    const value = row ? row[key] : undefined
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

// A grounded row is upsertable only when every template-required field (key INCLUDED) actually landed
// after grounding — an intake row silently missing erpMaterialCode/erpMaterialInternalId is a caller/
// upstream-intake defect, not something this module invents a value for; it is skipped and counted,
// never crashes the whole sync (one bad row must not sink the other N good ones).
function isUpsertable(grounded) {
  return MATERIAL_REQUIRED_FIELD_IDS.every((fieldId) => optionalString(grounded[fieldId]) !== null)
}

// Upsert every ERP material row: query the CURRENT cache once, index it by the template's OWN key
// field, then for each input row either createRecord (key unseen) or patchRecord (key seen) with an
// EXPLICIT-CLEAR refresh — every declared field absent from the fresh row is nulled in the patch
// `changes`, mirroring generation-runtime.cjs's prep-line refresh (review #4024 P2-1): a re-sync can
// never leave a hybrid row (e.g. a stale erpSpec under a freshly-rebound erpMaterialCode). The
// in-loop index update (existingByKey.set right after each write) means a duplicate key WITHIN the same
// input array is treated as a second write to the SAME row, never a double-create.
async function upsertErpMaterials(scoped, erpMaterials) {
  const existingRecords = await queryAllRecords(scoped, {})
  const existingByKey = new Map(
    existingRecords
      .map((record) => ({ record, key: optionalString(readCell(record, MATERIAL_KEY_FIELD)) }))
      .filter((entry) => entry.key)
      .map((entry) => [entry.key, entry.record]),
  )

  let created = 0
  let patched = 0
  let skippedInvalid = 0
  for (const row of erpMaterials) {
    const grounded = groundRow(MATERIAL_FIELD_IDS, isPlainObject(row) ? row : {})
    if (!isUpsertable(grounded)) {
      skippedInvalid += 1
      continue
    }
    const key = grounded[MATERIAL_KEY_FIELD]
    const existing = existingByKey.get(key)
    if (existing) {
      const changes = { ...grounded }
      delete changes[MATERIAL_KEY_FIELD]
      for (const fieldId of MATERIAL_FIELD_IDS) {
        if (fieldId === MATERIAL_KEY_FIELD) continue
        if (!(fieldId in changes)) changes[fieldId] = null
      }
      const patchedRecord = await scoped.patchRecord({ recordId: existing.id, changes })
      existingByKey.set(key, patchedRecord)
      patched += 1
    } else {
      const createdRecord = await scoped.createRecord({ data: grounded })
      existingByKey.set(key, createdRecord)
      created += 1
    }
  }
  return { created, patched, skippedInvalid }
}

// Create-if-absent / patch-status-if-changed for the run record (mirrors generation-runtime.cjs's run
// handling exactly): a genuine re-run of the SAME syncRunId updates the ledger's verdict rather than
// duplicating a row; who/when stamps stay unset (parity with sync-run-persist.cjs / generation-runtime.cjs
// — an owner-deferred decision, not an oversight; see their headers).
async function upsertRunRecord(scoped, runId, runStatus) {
  const existing = await scoped.queryRecords({ filters: { [RUN_KEY_FIELD]: runId }, limit: 2, offset: 0 })
  if (!Array.isArray(existing)) {
    throw new StockPreparationErpMaterialSyncError(500, 'ERP_MATERIAL_SYNC_RECORDS_API_INVALID', 'queryRecords must return an array')
  }
  if (existing.length > 1) {
    throw new StockPreparationErpMaterialSyncError(500, 'ERP_MATERIAL_SYNC_KEY_AMBIGUOUS', 'run record key matched more than one row', { [RUN_KEY_FIELD]: runId })
  }
  if (existing.length === 0) {
    await scoped.createRecord({ data: groundRow(RUN_FIELD_IDS, { runId, runType: ERP_MATERIAL_SYNC_RUN_TYPE, status: runStatus }) })
    return { mode: 'created' }
  }
  const record = existing[0]
  if (optionalString(readCell(record, 'status')) === runStatus) {
    return { mode: 'unchanged' }
  }
  await scoped.patchRecord({ recordId: record.id, changes: { status: runStatus } })
  return { mode: 'patched' }
}

// Values-free sync evidence: counts / statuses / modes / field-key NAMES / public objectId constants /
// booleans only. The input rows legitimately carry ERP business values (that IS the cached data), but
// NOTHING of that reaches this evidence.
function buildEvidence({ created, patched, skippedInvalid, plannedMaterialCount, runId, runStatus, runSync }) {
  return {
    persisted: created > 0 || patched > 0,
    mode: created > 0 ? 'created' : (patched > 0 ? 'refreshed' : 'skipped_empty'),
    created: { materials: created, run: runSync.mode === 'created' ? 1 : 0 },
    patched: { materials: patched, run: runSync.mode === 'patched' ? 1 : 0 },
    skipped: { materials: skippedInvalid },
    plannedMaterialCount,
    runIdPresent: Boolean(runId),
    runType: ERP_MATERIAL_SYNC_RUN_TYPE,
    runStatus,
    runSyncMode: runSync.mode,
    targets: {
      material: { objectId: MATERIAL_OBJECT_ID, fieldKeys: MATERIAL_FIELD_IDS.slice(), keyField: MATERIAL_KEY_FIELD },
      run: { objectId: RUN_OBJECT_ID, fieldKeys: RUN_FIELD_IDS.slice(), keyField: RUN_KEY_FIELD },
    },
    targetObjectIds: [MATERIAL_OBJECT_ID, RUN_OBJECT_ID],
    valuesFree: true,
  }
}

// ── the syncer ────────────────────────────────────────────────────────────────────────────────────
// Persist ALREADY-NORMALIZED ERP material rows into the internal erp_material_master cache table —
// admin-gated, internal-only, upsert (refresh, not immutable), values-free. Returns
// { persisted, mode, created, patched, skipped, evidence }.
async function persistStockPreparationErpMaterialSync(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationErpMaterialSyncError(422, 'ERP_MATERIAL_SYNC_CONFIG_INVALID', 'input must be an object')
  }
  const { context, permission, recordsApi: recordsApiInput, provisioning: provisioningInput, targetProjectId: targetProjectIdInput, syncRunId, erpMaterials: erpMaterialsInput } = input

  // 1. admin gate FIRST — fail-closed before ANY provisioning / records access.
  assertAdminPermission(permission)
  const provisioning = ensureProvisioning(
    provisioningInput ||
      (context && context.api && context.api.multitable && context.api.multitable.provisioning),
  )
  const recordsApi = ensureRecordsApi(
    recordsApiInput ||
      (context && context.api && context.api.multitable && context.api.multitable.records),
  )

  // 2. this run is NOT project-scoped (the ERP material master is a tenant-level cache, not a per-PLM-
  //    project snapshot) — only the STAGING targetProjectId is required, server-derived by the route
  //    from the auth tenant, never request-sourced (parity with every sibling committer).
  const targetProjectId = optionalString(targetProjectIdInput)
  if (!targetProjectId) {
    throw new StockPreparationErpMaterialSyncError(422, 'ERP_MATERIAL_SYNC_CONFIG_INVALID', 'targetProjectId (internal staging project) is required for table resolution', { field: 'targetProjectId' })
  }
  const runId = requiredString(syncRunId, 'syncRunId')

  if (erpMaterialsInput !== undefined && !Array.isArray(erpMaterialsInput)) {
    throw new StockPreparationErpMaterialSyncError(422, 'ERP_MATERIAL_SYNC_CONFIG_INVALID', 'erpMaterials must be an array', { field: 'erpMaterials' })
  }
  const erpMaterials = Array.isArray(erpMaterialsInput) ? erpMaterialsInput : []
  for (const [index, row] of erpMaterials.entries()) {
    if (!isPlainObject(row)) {
      throw new StockPreparationErpMaterialSyncError(422, 'ERP_MATERIAL_SYNC_CONFIG_INVALID', `erpMaterials[${index}] must be an object`, { field: `erpMaterials[${index}]` })
    }
  }

  // 3. resolve BOTH MVP sheets up front UNDER THE STAGING PROJECT (fail-closed if ANY is unprovisioned).
  const materialTarget = await resolveScopedTarget(recordsApi, provisioning, targetProjectId, MATERIAL_OBJECT_ID)
  const runTarget = await resolveScopedTarget(recordsApi, provisioning, targetProjectId, RUN_OBJECT_ID)

  // 4. upsert every material row (create-or-refresh by the template's OWN key field).
  const { created, patched, skippedInvalid } = await upsertErpMaterials(materialTarget.scoped, erpMaterials)

  // 5. the run record earns 'erp_material_sync' — 'partial' when any input row was unusable, else
  //    'succeeded' (mirrors sync-run-plan.cjs's status derivation: partial-if-flags-else-succeeded).
  const runStatus = skippedInvalid > 0 ? RUN_STATUS_PARTIAL : RUN_STATUS_SUCCEEDED
  const runSync = await upsertRunRecord(runTarget.scoped, runId, runStatus)

  const evidence = buildEvidence({ created, patched, skippedInvalid, plannedMaterialCount: erpMaterials.length, runId, runStatus, runSync })
  return {
    persisted: evidence.persisted,
    mode: evidence.mode,
    created: evidence.created,
    patched: evidence.patched,
    skipped: evidence.skipped,
    runId,
    runStatus,
    evidence,
  }
}

module.exports = {
  REQUIRED_PERMISSION,
  MATERIAL_OBJECT_ID,
  MATERIAL_KEY_FIELD,
  RUN_OBJECT_ID,
  RUN_KEY_FIELD,
  ERP_MATERIAL_SYNC_RUN_TYPE,
  RUN_STATUS_SUCCEEDED,
  RUN_STATUS_PARTIAL,
  StockPreparationErpMaterialSyncError,
  persistStockPreparationErpMaterialSync,
  __internals: {
    assertAdminPermission,
    ensureProvisioning,
    ensureRecordsApi,
    resolveScopedTarget,
    queryAllRecords,
    groundRow,
    isUpsertable,
    upsertErpMaterials,
    upsertRunRecord,
    buildEvidence,
    MVP_OBJECT_ID_SET,
    MATERIAL_FIELD_IDS,
    MATERIAL_REQUIRED_FIELD_IDS,
    RUN_FIELD_IDS,
  },
}
