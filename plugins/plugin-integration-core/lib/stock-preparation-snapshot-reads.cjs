'use strict'

// #3751 stock-prep MVP — READONLY snapshot-batch LIST + DIFF read endpoints (backs FE view 2,
// "BOM Snapshot Batch & Diff"; contract = apps/web/src/services/integration/stockPreparation/
// bomSnapshotDiff.ts).
//
// This module READS the internal, MetaSheet-provisioned MVP tables (bom_snapshot_batch /
// bom_snapshot_line / run_record / exception_confirmation) through the multitable RECORDS api and
// returns the values-free summary shapes the FE declares. It is structurally READ-ONLY:
//   - it calls ONLY recordsApi.queryRecords — never createRecord / patchRecord / delete,
//   - it never reads PLM and never touches K3 / ERP / any external system / SQL / fetch / HTTP,
//   - every read target objectId is asserted to be a member of the FROZEN MVP object-id set,
//   - it is admin-gated (fail-closed) and returns only counts / status enums / internal MetaSheet
//     handles (snapshotBatchId / baseSnapshotBatchId / syncRunId / projectId) / booleans — never a
//     drawing number, quantity, unit, path key, version, or fingerprint value.
// (The forbidden-write tokens named in this header appear ONLY here, in prose, to document the
// boundary — never as code.)
//
// PROJECT-SCOPE SPLIT (load-bearing): the MVP tables are provisioned under the INTERNAL STAGING
// project (`${tenantId}:integration-core`, via resolveIntegrationStagingProjectId in the route), NOT
// under the business project. So a read uses TWO distinct project ids:
//   - `targetProjectId`   locates the provisioned sheet   -> findObjectSheet({ projectId: targetProjectId, ... })
//   - `businessProjectId` filters/echoes the PLM project   -> queryRecords filters { projectId: businessProjectId }
// Passing the business project to findObjectSheet would fail to find the tables (a real bug).

const {
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
  STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS,
} = require('./stock-preparation-templates.cjs')
const { planBomSnapshotDiff, CHANGE_TYPES } = require('./stock-preparation-snapshot-diff.cjs')
const { optionalString, isPlainObject } = require('./stock-preparation-common.cjs')
const {
  StockPreparationTargetProvisioningError,
  __internals: { assertAdminPermission },
} = require('./stock-preparation-target-provisioning.cjs')

// Bounded pagination for the readonly scans. A single frozen MVP snapshot batch / line set is small;
// these bounds only guard against an unexpectedly huge sheet (fail closed rather than scan forever).
const READ_PAGE_LIMIT = 500
const READ_MAX_PAGES = 50

// Design-grounded blocking marker (docs/development/stock-preparation-mvp-design-20260707.md §8:
// exception `severity` ∈ {info, warning, blocking}; the generation engine emits severity 'blocking').
// This is a READ of a stored enum value, not an invented rule.
const BLOCKING_EXCEPTION_SEVERITY = 'blocking'

// planBomSnapshotDiff requires a non-empty previousSnapshotBatchId. When a batch has no immutable
// predecessor we still diff its lines against an EMPTY prior (every current line surfaces as `added`),
// so we pass this sentinel purely to satisfy the engine — it only ever rides the engine's internal
// diffId hashing / values-free evidence booleans and NEVER appears in the returned summary.
const NO_PREDECESSOR_SENTINEL = 'stockprep_no_predecessor'

function templateByRole(role) {
  const template = STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((entry) => entry.role === role)
  if (!template) {
    throw new StockPreparationTargetProvisioningError(
      500,
      'SNAPSHOT_READS_TEMPLATE_MISSING',
      `frozen MVP template for role ${role} is missing`,
      { role },
    )
  }
  return template
}

// Object-id constants come straight from the FROZEN MVP templates (never a hardcoded string), so a
// read target can only ever be one of the provisioned MVP tables.
const BATCH_OBJECT_ID = templateByRole('bom_snapshot_batch').objectId
const LINE_OBJECT_ID = templateByRole('bom_snapshot_line').objectId
const RUN_OBJECT_ID = templateByRole('run_record').objectId
const EXCEPTION_OBJECT_ID = templateByRole('exception_confirmation').objectId
const MVP_OBJECT_ID_SET = new Set(STOCK_PREPARATION_MVP_REQUIRED_OBJECT_IDS)

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationTargetProvisioningError(422, 'SNAPSHOT_READS_CONFIG_INVALID', `${field} is required`, { field })
  }
  return normalized
}

// Fail closed if a read target is not a frozen MVP objectId (a mutation that swapped the target away
// from the MVP set is killed here rather than reading an arbitrary sheet).
function assertMvpObjectId(objectId) {
  if (!MVP_OBJECT_ID_SET.has(objectId)) {
    throw new StockPreparationTargetProvisioningError(
      500,
      'SNAPSHOT_READS_OBJECT_ID_NOT_MVP',
      'snapshot read target objectId is not a frozen stock-preparation MVP table',
      { objectId },
    )
  }
  return objectId
}

// READONLY records-api guard: only queryRecords is required (no write methods are needed or used).
function ensureReadOnlyRecordsApi(recordsApi) {
  if (!recordsApi || typeof recordsApi.queryRecords !== 'function') {
    throw new StockPreparationTargetProvisioningError(
      501,
      'SNAPSHOT_READS_RECORDS_API_UNAVAILABLE',
      'stock-preparation snapshot reads require multitable.records.queryRecords',
      { requiredMethods: ['queryRecords'] },
    )
  }
  return recordsApi
}

function ensureProvisioningApi(provisioning) {
  if (!provisioning || typeof provisioning.findObjectSheet !== 'function') {
    throw new StockPreparationTargetProvisioningError(
      501,
      'SNAPSHOT_READS_PROVISIONING_API_UNAVAILABLE',
      'stock-preparation snapshot reads require multitable.provisioning.findObjectSheet',
      { requiredMethods: ['findObjectSheet'] },
    )
  }
  return provisioning
}

// Records may arrive as { data: {...} } or as a flat object; read the logical cell from whichever
// carries it (mirrors the table-action reader idiom).
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

// Locate a frozen MVP sheet by objectId (asserting the objectId is in the MVP set first), using the
// STAGING targetProjectId. Returns the sheet ({ id }) or null when the internal table has not been
// provisioned yet (tables may be empty — callers degrade gracefully).
async function findMvpSheet(provisioning, targetProjectId, objectId) {
  assertMvpObjectId(objectId)
  const sheet = await provisioning.findObjectSheet({ projectId: targetProjectId, objectId })
  return sheet && sheet.id ? sheet : null
}

// Bounded readonly scan: page queryRecords until a short page (last page) or the page bound is hit.
async function queryAllRecords(recordsApi, sheetId, filters) {
  const rows = []
  for (let page = 0; page < READ_MAX_PAGES; page += 1) {
    const pageRows = await recordsApi.queryRecords({
      sheetId,
      filters,
      limit: READ_PAGE_LIMIT,
      offset: page * READ_PAGE_LIMIT,
    })
    if (!Array.isArray(pageRows)) {
      throw new StockPreparationTargetProvisioningError(
        500,
        'SNAPSHOT_READS_RECORDS_API_INVALID',
        'queryRecords must return an array',
        { sheetId },
      )
    }
    rows.push(...pageRows)
    if (pageRows.length < READ_PAGE_LIMIT) return rows
  }
  throw new StockPreparationTargetProvisioningError(
    422,
    'SNAPSHOT_READS_RESULT_TOO_LARGE',
    'stock-preparation snapshot read exceeded the page bound',
    { maxPages: READ_MAX_PAGES },
  )
}

// A batch is `incomplete` when the multi-step persist path (batch row -> lines -> run row) did not
// finish: zero lines OR no matching run row. A batch row alone is NOT proof of completeness — an
// orphaned batch (crash mid-commit) must not be presented as normal.
function batchSummary(batchRecord, lineCount, runPresent) {
  return {
    snapshotBatchId: optionalString(readCell(batchRecord, 'snapshotBatchId')),
    snapshotVersion: toNumber(readCell(batchRecord, 'snapshotVersion')) || 0,
    snapshotStatus: optionalString(readCell(batchRecord, 'snapshotStatus')),
    syncRunId: optionalString(readCell(batchRecord, 'syncRunId')),
    lineCount,
    // Presence of the createdAt stamp only — never the timestamp value itself (values-free).
    createdAtPresent: optionalString(readCell(batchRecord, 'createdAt')) !== null,
    incomplete: lineCount === 0 || runPresent !== true,
  }
}

// Deterministic newest-first ordering (highest snapshotVersion first; snapshotBatchId breaks ties).
function orderBatches(summaries) {
  return summaries.slice().sort((left, right) => {
    if (right.snapshotVersion !== left.snapshotVersion) return right.snapshotVersion - left.snapshotVersion
    return String(left.snapshotBatchId || '').localeCompare(String(right.snapshotBatchId || ''))
  })
}

/**
 * List the immutable BOM snapshot batches for a (business) project.
 * `targetProjectId`   — STAGING project the MVP tables were provisioned under (locates the sheets).
 * `businessProjectId` — PLM business project id; FILTERS the batch rows and is ECHOED back.
 * Empty / unprovisioned batch sheet => { projectId, batchCount: 0, batches: [] }.
 */
async function listSnapshotBatches({ recordsApi, provisioning, targetProjectId, businessProjectId, permission } = {}) {
  assertAdminPermission(permission)
  const api = ensureReadOnlyRecordsApi(recordsApi)
  const prov = ensureProvisioningApi(provisioning)
  const stagingProjectId = requiredString(targetProjectId, 'targetProjectId')
  const projectId = requiredString(businessProjectId, 'businessProjectId')

  const batchSheet = await findMvpSheet(prov, stagingProjectId, BATCH_OBJECT_ID)
  if (!batchSheet) {
    return { projectId, batchCount: 0, batches: [] }
  }
  const lineSheet = await findMvpSheet(prov, stagingProjectId, LINE_OBJECT_ID)
  const runSheet = await findMvpSheet(prov, stagingProjectId, RUN_OBJECT_ID)

  const batchRows = await queryAllRecords(api, batchSheet.id, { projectId })
  const summaries = []
  for (const batchRow of batchRows) {
    const snapshotBatchId = optionalString(readCell(batchRow, 'snapshotBatchId'))
    const syncRunId = optionalString(readCell(batchRow, 'syncRunId'))
    let lineCount = 0
    if (lineSheet && snapshotBatchId) {
      const lineRows = await queryAllRecords(api, lineSheet.id, { snapshotBatchId })
      lineCount = lineRows.length
    }
    let runPresent = false
    if (runSheet && syncRunId) {
      const runRows = await queryAllRecords(api, runSheet.id, { runId: syncRunId })
      runPresent = runRows.length > 0
    }
    summaries.push(batchSummary(batchRow, lineCount, runPresent))
  }
  const batches = orderBatches(summaries)
  return { projectId, batchCount: batches.length, batches }
}

function changeCountsFromEvidence(diff) {
  const byChangeType = (diff && diff.evidence && diff.evidence.result && diff.evidence.result.byChangeType) || {}
  return {
    added: byChangeType[CHANGE_TYPES.ADDED] || 0,
    removed: byChangeType[CHANGE_TYPES.REMOVED] || 0,
    quantityChanged: byChangeType[CHANGE_TYPES.QUANTITY_CHANGED] || 0,
    unitChanged: byChangeType[CHANGE_TYPES.UNIT_CHANGED] || 0,
    versionChanged: byChangeType[CHANGE_TYPES.VERSION_CHANGED] || 0,
    pathChanged: byChangeType[CHANGE_TYPES.PATH_CHANGED] || 0,
    missingChildBom: byChangeType[CHANGE_TYPES.MISSING_CHILD_BOM] || 0,
    fingerprintChanged: byChangeType[CHANGE_TYPES.SOURCE_FINGERPRINT_CHANGED] || 0,
  }
}

// Predecessor rule: the batch (same business project) with the HIGHEST snapshotVersion strictly LESS
// than the current batch's version. null when the current version is unknown or nothing precedes it.
function pickPredecessor(batchRows, currentSnapshotBatchId, currentVersion) {
  if (currentVersion === null) return null
  let best = null
  let bestVersion = null
  for (const row of batchRows) {
    const snapshotBatchId = optionalString(readCell(row, 'snapshotBatchId'))
    if (!snapshotBatchId || snapshotBatchId === currentSnapshotBatchId) continue
    const version = toNumber(readCell(row, 'snapshotVersion'))
    if (version === null || version >= currentVersion) continue
    if (bestVersion === null || version > bestVersion) {
      bestVersion = version
      best = snapshotBatchId
    }
  }
  return best
}

/**
 * Values-free diff of a snapshot batch against its immutable predecessor batch.
 * The batch id arrives from the route PATH. `targetProjectId` (STAGING) locates the MVP tables; the
 * business project used to scope the predecessor search is read from the current batch row itself (the
 * FE diff call carries no projectId), falling back to `businessProjectId` when the batch row is absent.
 */
async function getSnapshotDiff({ recordsApi, provisioning, targetProjectId, businessProjectId, snapshotBatchId, permission } = {}) {
  assertAdminPermission(permission)
  const api = ensureReadOnlyRecordsApi(recordsApi)
  const prov = ensureProvisioningApi(provisioning)
  const currentSnapshotBatchId = requiredString(snapshotBatchId, 'snapshotBatchId')
  const stagingProjectId = requiredString(targetProjectId, 'targetProjectId')

  const batchSheet = await findMvpSheet(prov, stagingProjectId, BATCH_OBJECT_ID)
  const lineSheet = await findMvpSheet(prov, stagingProjectId, LINE_OBJECT_ID)
  const exceptionSheet = await findMvpSheet(prov, stagingProjectId, EXCEPTION_OBJECT_ID)

  if (!batchSheet && !lineSheet && !exceptionSheet) {
    return {
      snapshotBatchId: currentSnapshotBatchId,
      baseSnapshotBatchId: null,
      changeCounts: changeCountsFromEvidence(null),
      blockingExceptionCount: 0,
    }
  }

  // Current batch row (locates the business project + current snapshot version).
  let currentBatchRow = null
  let projectId = optionalString(businessProjectId)
  let currentVersion = null
  if (batchSheet) {
    const currentRows = await queryAllRecords(api, batchSheet.id, { snapshotBatchId: currentSnapshotBatchId })
    currentBatchRow = currentRows[0] || null
    if (currentBatchRow) {
      projectId = optionalString(readCell(currentBatchRow, 'projectId')) || projectId
      currentVersion = toNumber(readCell(currentBatchRow, 'snapshotVersion'))
    }
  }

  // Predecessor = highest version strictly below the current, within the same business project.
  let baseSnapshotBatchId = null
  if (batchSheet && projectId) {
    const projectBatchRows = await queryAllRecords(api, batchSheet.id, { projectId })
    baseSnapshotBatchId = pickPredecessor(projectBatchRows, currentSnapshotBatchId, currentVersion)
  }

  // Lines for the current + predecessor batches (never mutated; passed straight to the diff engine).
  const currentLines = lineSheet
    ? (await queryAllRecords(api, lineSheet.id, { snapshotBatchId: currentSnapshotBatchId })).map(recordData)
    : []
  const previousLines = lineSheet && baseSnapshotBatchId
    ? (await queryAllRecords(api, lineSheet.id, { snapshotBatchId: baseSnapshotBatchId })).map(recordData)
    : []

  const diff = planBomSnapshotDiff({
    previousSnapshotBatchId: baseSnapshotBatchId || NO_PREDECESSOR_SENTINEL,
    currentSnapshotBatchId,
    previousLines,
    currentLines,
  })

  // blockingExceptionCount = exception rows linked to THIS batch (via the exception template's
  // snapshotBatchId link field) whose stored severity is 'blocking'. No status filtering (see the
  // Open-Decision noted in the PR): a resolved-but-blocking-severity row is still counted here.
  let blockingExceptionCount = 0
  if (exceptionSheet) {
    const exceptionRows = await queryAllRecords(api, exceptionSheet.id, { snapshotBatchId: currentSnapshotBatchId })
    for (const row of exceptionRows) {
      if (optionalString(readCell(row, 'severity')) === BLOCKING_EXCEPTION_SEVERITY) blockingExceptionCount += 1
    }
  }

  return {
    snapshotBatchId: currentSnapshotBatchId,
    baseSnapshotBatchId,
    changeCounts: changeCountsFromEvidence(diff),
    blockingExceptionCount,
  }
}

module.exports = {
  listSnapshotBatches,
  getSnapshotDiff,
  BATCH_OBJECT_ID,
  LINE_OBJECT_ID,
  RUN_OBJECT_ID,
  EXCEPTION_OBJECT_ID,
  BLOCKING_EXCEPTION_SEVERITY,
  __internals: {
    templateByRole,
    assertMvpObjectId,
    ensureReadOnlyRecordsApi,
    ensureProvisioningApi,
    recordData,
    readCell,
    toNumber,
    queryAllRecords,
    batchSummary,
    orderBatches,
    changeCountsFromEvidence,
    pickPredecessor,
    NO_PREDECESSOR_SENTINEL,
    READ_PAGE_LIMIT,
    READ_MAX_PAGES,
  },
}
