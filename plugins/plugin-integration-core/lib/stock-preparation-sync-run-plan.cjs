'use strict'

// #3751 stock-prep MVP — READONLY BOM-snapshot SYNC-RUN PLAN orchestrator.
//
// Given an already-produced PLM BOM expansion result (readonly, passed in) and an optional prior
// snapshot batch, this composes the LANDED pure engines into a single "sync run PLAN":
//   1. map expansion output -> snapshot lines (stock-preparation-expansion-snapshot-mapper.cjs),
//   2. shape an immutable-by-design snapshot BATCH plan row (status 'draft', never 'active'),
//   3. shape a sync-RUN plan row keyed to the run template's field ids,
//   4. diff the new lines vs a prior batch's lines (stock-preparation-snapshot-diff.cjs), and
//   5. SURFACE (never silently drop) flags for missing-child-BOM / incomplete / duplicate-path-key /
//      lines lacking a design qty or unit — all as VALUES-FREE evidence (counts / status names /
//      field-key names / booleans / public objectId + read-plan constants only).
//
// HARD boundary — this module is PURE and DETERMINISTIC. It computes a PLAN and PERSISTS NOTHING. It
// imports ONLY the landed pure engines (mapper / diff / frozen templates / common helpers). It does
// NOT read PLM (the expansion is passed in), and it has NO records / write API, NO createRecord /
// patchRecord, NO apply-writer, NO K3 / ERP / SQL, and NO fetch / HTTP / live I/O of any kind. Any
// who/when stamp (startedAt / finishedAt / createdAt / createdBy) is a persistence-time concern and is
// deliberately left unset here so the plan stays deterministic and free of invented timestamps or
// identity; the separate persistence slice fills those. (The tokens named in this header comment appear
// ONLY here, in prose, to document the boundary — never as code.)

const {
  mapExpansionRowsToSnapshotLines,
  LINE_STATUSES,
} = require('./stock-preparation-expansion-snapshot-mapper.cjs')
const { planBomSnapshotDiff } = require('./stock-preparation-snapshot-diff.cjs')
const { STOCK_PREPARATION_MVP_TABLE_TEMPLATES } = require('./stock-preparation-templates.cjs')
const { optionalString, isPlainObject } = require('./stock-preparation-common.cjs')

const REQUIRED_PERMISSION = 'admin'

// Design-grounded enum literals (docs/development/stock-preparation-mvp-design-20260707.md):
//   snapshot_status ∈ {draft, active, superseded, rejected} — a freshly planned batch is 'draft'
//     (immutable-by-design; a plan NEVER promotes to 'active').
//   run_type ∈ {plm_sync, erp_material_sync, mapping_match, unit_match, prep_generate} — a BOM
//     snapshot sync run is 'plm_sync'.
//   status ∈ {running, succeeded, failed, partial} — a computed plan reports 'partial' when any flag
//     surfaced (the snapshot carries incomplete/duplicate/missing data), else 'succeeded'.
const SNAPSHOT_STATUS_DRAFT = 'draft'
const RUN_TYPE_PLM_SYNC = 'plm_sync'
const RUN_STATUS_SUCCEEDED = 'succeeded'
const RUN_STATUS_PARTIAL = 'partial'

// Open-Decision: incrementing the snapshot version needs the persistence layer to know the prior max
// for a project; a pure plan cannot, so it defaults to the neutral first-version 1 when the caller
// does not supply one.
const DEFAULT_SNAPSHOT_VERSION = 1

class StockPreparationSyncRunPlanError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationSyncRunPlanError'
    this.status = status
    this.code = code
    this.details = details
  }
}

// Local, self-contained admin gate (parity with the target-provisioning gate but with no dependency on
// a provisioning module). A mutation that drops this call is test-killable via the 403 case.
function assertAdminPermission(permission) {
  if (permission !== REQUIRED_PERMISSION) {
    throw new StockPreparationSyncRunPlanError(
      403,
      'SYNC_RUN_PLAN_PERMISSION_DENIED',
      'stock-preparation sync-run plan requires admin permission',
      { requiredPermission: REQUIRED_PERMISSION },
    )
  }
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationSyncRunPlanError(422, 'SYNC_RUN_PLAN_CONFIG_INVALID', `${field} is required`, { field })
  }
  return normalized
}

function templateByRole(role) {
  const template = STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((entry) => entry.role === role)
  if (!template) {
    throw new StockPreparationSyncRunPlanError(
      500,
      'SYNC_RUN_PLAN_TEMPLATE_MISSING',
      `frozen MVP template for role ${role} is missing`,
      { role },
    )
  }
  return template
}

// Ground the plan-row shapes in the FROZEN MVP templates: the batch / line / run object ids and their
// field-id sets come straight from the templates, so nothing here invents a field name.
const BATCH_TEMPLATE = templateByRole('bom_snapshot_batch')
const LINE_TEMPLATE = templateByRole('bom_snapshot_line')
const RUN_TEMPLATE = templateByRole('run_record')
const BATCH_FIELD_IDS = Object.freeze(BATCH_TEMPLATE.fields.map((entry) => entry.id))
const LINE_FIELD_IDS = Object.freeze(LINE_TEMPLATE.fields.map((entry) => entry.id))
const RUN_FIELD_IDS = Object.freeze(RUN_TEMPLATE.fields.map((entry) => entry.id))
const BATCH_FIELD_ID_SET = new Set(BATCH_FIELD_IDS)
const RUN_FIELD_ID_SET = new Set(RUN_FIELD_IDS)

// Emit ONLY keys declared by the template's field-id set (grounding guard) and drop null/undefined so
// the plan row stays a clean partial (persistence-time fields intentionally absent).
function groundedRow(fieldIdSet, object, label) {
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (!fieldIdSet.has(key)) {
      throw new StockPreparationSyncRunPlanError(
        500,
        'SYNC_RUN_PLAN_FIELD_NOT_GROUNDED',
        `${label} plan row field ${key} is not declared by the frozen template`,
        { field: key },
      )
    }
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

function positiveFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

// Per-line + key-level flags computed over the mapped snapshot lines. Each is a COUNT; nothing is
// silently dropped. "lacking a design qty" mirrors the diff engine's invalid-qty semantics (absent or
// non-positive); "lacking a design unit" means no unit could be resolved (and none was defaulted).
function computeFlags(lines) {
  let missingChildBom = 0
  let incomplete = 0
  let missingDesignQty = 0
  let missingDesignUnit = 0
  let flaggedLineCount = 0
  const pathKeyCounts = new Map()
  for (const line of lines) {
    const isMissingChildBom = line && line.missingChildBom === true
    const isIncomplete = line && line.lineStatus === LINE_STATUSES.INCOMPLETE
    const lacksQty = !positiveFiniteNumber(line && line.designQty)
    const lacksUnit = !optionalString(line && line.designUnit)
    if (isMissingChildBom) missingChildBom += 1
    if (isIncomplete) incomplete += 1
    if (lacksQty) missingDesignQty += 1
    if (lacksUnit) missingDesignUnit += 1
    if (isMissingChildBom || isIncomplete || lacksQty || lacksUnit) flaggedLineCount += 1
    const pathKey = optionalString(line && line.pathKey)
    if (pathKey) pathKeyCounts.set(pathKey, (pathKeyCounts.get(pathKey) || 0) + 1)
  }
  let duplicatePathKeys = 0
  let duplicatePathKeyLines = 0
  for (const count of pathKeyCounts.values()) {
    if (count > 1) {
      duplicatePathKeys += 1
      duplicatePathKeyLines += count
    }
  }
  const hasFlags = flaggedLineCount > 0 || duplicatePathKeys > 0
  return {
    missingChildBom,
    incomplete,
    duplicatePathKeys,
    duplicatePathKeyLines,
    missingDesignQty,
    missingDesignUnit,
    flaggedLineCount,
    hasFlags,
  }
}

// Values-free run shape summaries (design lines 385-386 "values-free input/result summary"). Only
// counts / status names / booleans — never a raw id, drawing number, or project value.
function buildInputShape({ mappingEvidence, previousLinesCount, previousBatchProvided }) {
  return JSON.stringify({
    expansionRows: mappingEvidence.input.expansionRows,
    rowErrors: mappingEvidence.input.rowErrors,
    missingChildBomRowErrors: mappingEvidence.input.missingChildBomRowErrors,
    previousLines: previousLinesCount,
    previousBatchProvided,
  })
}

function buildResultShape({ mappingEvidence, snapshotStatus, flags, diffEvidence }) {
  return JSON.stringify({
    snapshotLines: mappingEvidence.result.lines,
    snapshotStatus,
    byLineStatus: mappingEvidence.result.byLineStatus,
    flags: {
      missingChildBom: flags.missingChildBom,
      incomplete: flags.incomplete,
      duplicatePathKeys: flags.duplicatePathKeys,
      missingDesignQty: flags.missingDesignQty,
      missingDesignUnit: flags.missingDesignUnit,
    },
    diff: diffEvidence
      ? { diffs: diffEvidence.result.diffs, byChangeType: diffEvidence.result.byChangeType }
      : null,
  })
}

function buildValuesFreeEvidence({
  mappingEvidence,
  diffEvidence,
  flags,
  snapshotStatus,
  runType,
  runStatus,
  snapshotVersionProvided,
  sourceSystemProvided,
  previousBatchProvided,
}) {
  return {
    snapshotBatch: {
      objectId: BATCH_TEMPLATE.objectId,
      snapshotStatus,
      snapshotVersionProvided,
      sourceSystemProvided,
      fieldKeys: BATCH_FIELD_IDS.slice(),
    },
    snapshotLine: {
      objectId: LINE_TEMPLATE.objectId,
      fieldKeys: LINE_FIELD_IDS.slice(),
    },
    syncRun: {
      objectId: RUN_TEMPLATE.objectId,
      runType,
      status: runStatus,
      fieldKeys: RUN_FIELD_IDS.slice(),
    },
    mapping: mappingEvidence,
    diff: diffEvidence || null,
    diffRan: Boolean(diffEvidence),
    previousBatchProvided,
    flags: { ...flags },
    valuesFree: true,
  }
}

// ── the orchestrator ────────────────────────────────────────────────────────────────────────────
// Compose the readonly plan. Persists nothing; returns all computed plan data + values-free evidence.
function planBomSnapshotSyncRun(input = {}) {
  if (!isPlainObject(input)) {
    throw new StockPreparationSyncRunPlanError(422, 'SYNC_RUN_PLAN_CONFIG_INVALID', 'input must be an object')
  }
  assertAdminPermission(input.permission)

  const projectId = requiredString(input.projectId, 'projectId')
  const syncRunId = requiredString(input.syncRunId, 'syncRunId')
  const snapshotBatchId = requiredString(input.snapshotBatchId, 'snapshotBatchId')
  const sourceSystem = optionalString(input.sourceSystem) // passthrough only — never invent a source
  const snapshotVersionProvided = input.snapshotVersion !== undefined && input.snapshotVersion !== null
  const snapshotVersion = snapshotVersionProvided ? input.snapshotVersion : DEFAULT_SNAPSHOT_VERSION
  const defaultDesignUnit = optionalString(input.defaultDesignUnit) || undefined
  const readPlan = isPlainObject(input.readPlan) ? input.readPlan : undefined
  const previousSnapshotBatchId = optionalString(input.previousSnapshotBatchId)
  const previousLines = input.previousLines

  // 1. expansion result -> snapshot lines (the mapper defaults + surfaces the read plan itself).
  const mapping = mapExpansionRowsToSnapshotLines(input.expansionResult, {
    snapshotBatchId,
    defaultDesignUnit,
    readPlan,
  })
  const snapshotLines = mapping.lines

  // 2. flags surfaced from the lines (never dropped).
  const flags = computeFlags(snapshotLines)

  // 3. run status derived from a SINGLE flag check (Open-Decision: partial-if-flags-else-succeeded).
  const runStatus = flags.hasFlags ? RUN_STATUS_PARTIAL : RUN_STATUS_SUCCEEDED

  // 4. diff vs the prior batch — only when both the prior lines AND the prior batch id are supplied.
  //    previousLines is passed through untouched (the diff engine spreads each row internally), so the
  //    old immutable snapshot is never mutated here.
  let diff = null
  if (previousLines !== undefined && previousLines !== null) {
    if (!previousSnapshotBatchId) {
      throw new StockPreparationSyncRunPlanError(
        422,
        'SYNC_RUN_PLAN_CONFIG_INVALID',
        'previousSnapshotBatchId is required to diff against previousLines',
        { field: 'previousSnapshotBatchId' },
      )
    }
    diff = planBomSnapshotDiff({
      previousSnapshotBatchId,
      currentSnapshotBatchId: snapshotBatchId,
      previousLines,
      currentLines: snapshotLines,
    })
  }
  const diffEvidence = diff ? diff.evidence : null

  // 5. batch plan row (keyed to the bom_snapshot_batch template; status 'draft', never 'active').
  const snapshotBatch = groundedRow(BATCH_FIELD_ID_SET, {
    snapshotBatchId,
    projectId,
    sourceSystem,
    snapshotVersion,
    syncRunId,
    snapshotStatus: SNAPSHOT_STATUS_DRAFT,
  }, 'snapshotBatch')

  // 6. sync-run plan row (keyed to the run_record template; counts ride the values-free shape strings).
  const syncRun = groundedRow(RUN_FIELD_ID_SET, {
    runId: syncRunId,
    runType: RUN_TYPE_PLM_SYNC,
    status: runStatus,
    inputShape: buildInputShape({
      mappingEvidence: mapping.evidence,
      previousLinesCount: Array.isArray(previousLines) ? previousLines.length : 0,
      previousBatchProvided: Boolean(previousSnapshotBatchId),
    }),
    resultShape: buildResultShape({
      mappingEvidence: mapping.evidence,
      snapshotStatus: SNAPSHOT_STATUS_DRAFT,
      flags,
      diffEvidence,
    }),
  }, 'syncRun')

  const evidence = buildValuesFreeEvidence({
    mappingEvidence: mapping.evidence,
    diffEvidence,
    flags,
    snapshotStatus: SNAPSHOT_STATUS_DRAFT,
    runType: RUN_TYPE_PLM_SYNC,
    runStatus,
    snapshotVersionProvided,
    sourceSystemProvided: Boolean(sourceSystem),
    previousBatchProvided: Boolean(previousSnapshotBatchId),
  })

  return { snapshotBatch, snapshotLines, syncRun, diff, flags, evidence }
}

module.exports = {
  REQUIRED_PERMISSION,
  SNAPSHOT_STATUS_DRAFT,
  RUN_TYPE_PLM_SYNC,
  RUN_STATUS_SUCCEEDED,
  RUN_STATUS_PARTIAL,
  DEFAULT_SNAPSHOT_VERSION,
  StockPreparationSyncRunPlanError,
  planBomSnapshotSyncRun,
  __internals: {
    assertAdminPermission,
    computeFlags,
    groundedRow,
    templateByRole,
    BATCH_TEMPLATE,
    LINE_TEMPLATE,
    RUN_TEMPLATE,
    BATCH_FIELD_IDS,
    LINE_FIELD_IDS,
    RUN_FIELD_IDS,
  },
}
