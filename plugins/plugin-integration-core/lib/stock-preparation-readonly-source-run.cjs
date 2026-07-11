'use strict'

const { executeConfiguredRead } = require('./read-source-read-runtime.cjs')
const {
  normalizeStockPreparationReadonlyIntake,
} = require('./stock-preparation-readonly-intake.cjs')
const { isPlainObject, optionalString } = require('./stock-preparation-common.cjs')

const REQUIRED_PERMISSION = 'admin'
const SOURCE_PAGE_SIZE = 500
const K3_WEBAPI_SOURCE_PAGE_SIZE = 10
const SOURCE_MAX_PAGES = 10

const PLM_SOURCE_KINDS = new Set([
  'plm:yuantus-wrapper',
  'data-source:sql-readonly',
  'bridge:legacy-sql-readonly',
])
const ERP_SOURCE_KINDS = new Set([
  'erp:k3-wise-webapi',
  'erp:k3-wise-sqlserver',
  'data-source:sql-readonly',
  'bridge:legacy-sql-readonly',
])
const SOURCE_CHANNELS = Object.freeze({
  'plm:yuantus-wrapper': 'plm',
  'erp:k3-wise-webapi': 'erp_k3',
  'erp:k3-wise-sqlserver': 'erp_k3',
  'data-source:sql-readonly': 'data_source',
  'bridge:legacy-sql-readonly': 'bridge_agent',
})

class StockPreparationReadonlySourceRunError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationReadonlySourceRunError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationReadonlySourceRunError(
      422,
      'SOURCE_RUN_CONFIG_INVALID',
      'stock-preparation source-run input is invalid',
      { field },
    )
  }
  return normalized
}

function positiveInteger(value, field) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new StockPreparationReadonlySourceRunError(
      422,
      'SOURCE_RUN_CONFIG_INVALID',
      'stock-preparation source-run input is invalid',
      { field },
    )
  }
  return parsed
}

function ensureDependencies(input) {
  if (!isPlainObject(input)) {
    throw new StockPreparationReadonlySourceRunError(
      422,
      'SOURCE_RUN_CONFIG_INVALID',
      'stock-preparation source-run input must be an object',
    )
  }
  if (input.permission !== REQUIRED_PERMISSION) {
    throw new StockPreparationReadonlySourceRunError(
      403,
      'SOURCE_RUN_PERMISSION_DENIED',
      'stock-preparation source runs require admin permission',
      { requiredPermission: REQUIRED_PERMISSION },
    )
  }
  if (!input.preparedRead || !input.preparedRead.plan) {
    throw new StockPreparationReadonlySourceRunError(
      422,
      'SOURCE_RUN_CONFIG_INVALID',
      'approved configured read is required',
      { field: 'preparedRead' },
    )
  }
  if (!isPlainObject(input.system) || typeof input.createAdapter !== 'function') {
    throw new StockPreparationReadonlySourceRunError(
      422,
      'SOURCE_RUN_CONFIG_INVALID',
      'configured source runtime is incomplete',
      { field: 'sourceRuntime' },
    )
  }
}

function sourceChannel(kind) {
  return SOURCE_CHANNELS[kind] || 'unknown'
}

function assertSourceKind(system, allowed, runType) {
  const kind = optionalString(system && system.kind)
  if (!kind || !allowed.has(kind)) {
    throw new StockPreparationReadonlySourceRunError(
      409,
      'SOURCE_RUN_KIND_NOT_ALLOWED',
      'configured source kind is not allowed for this stock-preparation run',
      { runType, sourceChannel: sourceChannel(kind) },
    )
  }
  return kind
}

function containerRows(data, alias) {
  const containers = isPlainObject(data && data.containers) ? data.containers : {}
  const entry = containers[alias]
  if (!entry || !Array.isArray(entry.records)) {
    throw new StockPreparationReadonlySourceRunError(
      422,
      'SOURCE_RUN_CONTAINER_MISSING',
      'configured source did not produce the required mapped container',
      { container: alias },
    )
  }
  return entry.records
}

function assertKnownSourceNotExceeded(sourceTotal, receivedRows) {
  if (Number.isInteger(sourceTotal) && receivedRows > sourceTotal) {
    throw new StockPreparationReadonlySourceRunError(
      502,
      'SOURCE_RUN_PAGINATION_INCONSISTENT',
      'configured readonly source returned more rows than its declared row count',
      { receivedRows, sourceTotal },
    )
  }
}

function assertKnownSourceComplete(sourceTotal, receivedRows) {
  assertKnownSourceNotExceeded(sourceTotal, receivedRows)
  if (Number.isInteger(sourceTotal) && receivedRows < sourceTotal) {
    throw new StockPreparationReadonlySourceRunError(
      502,
      'SOURCE_RUN_PAGINATION_INCOMPLETE',
      'configured readonly source ended before its declared row count',
      { receivedRows, sourceTotal },
    )
  }
}

async function readAllMappedRows({ preparedRead, system, createAdapter }) {
  if (preparedRead.plan.mode === 'resolver_lookup') {
    throw new StockPreparationReadonlySourceRunError(
      422,
      'SOURCE_RUN_MODE_NOT_SUPPORTED',
      'resolver lookup cannot feed a stock-preparation source run',
      { mode: 'resolver_lookup' },
    )
  }

  const rows = []
  let headerRows = []
  const seenCursors = new Set()
  const pageSize = preparedRead.plan.requiredKind === 'erp:k3-wise-webapi'
    ? K3_WEBAPI_SOURCE_PAGE_SIZE
    : SOURCE_PAGE_SIZE
  const usesPageIndex = preparedRead.plan.mode === 'list_page'
    && preparedRead.plan.requiredKind === 'erp:k3-wise-webapi'
  let cursor = null

  for (let page = 1; page <= SOURCE_MAX_PAGES; page += 1) {
    const execution = usesPageIndex
      ? { rowCap: pageSize, pageIndex: page }
      : { rowCap: pageSize, cursor }
    let outcome
    try {
      outcome = await executeConfiguredRead(
        preparedRead,
        { system, createAdapter },
        execution,
      )
    } catch (_error) {
      throw new StockPreparationReadonlySourceRunError(
        502,
        'SOURCE_RUN_READ_FAILED',
        'configured readonly source run failed',
        { errorType: 'source_runtime' },
      )
    }
    if (!outcome || !outcome.evidence || outcome.evidence.ok !== true || !outcome.data) {
      throw new StockPreparationReadonlySourceRunError(
        502,
        'SOURCE_RUN_READ_FAILED',
        'configured readonly source run failed',
        {
          errorCode: optionalString(outcome && outcome.evidence && outcome.evidence.errorCode) || 'unknown',
          errorType: optionalString(outcome && outcome.evidence && outcome.evidence.errorType) || 'unknown',
        },
      )
    }

    const pageRows = preparedRead.plan.mode === 'detail_with_lines'
      ? containerRows(outcome.data, 'lines')
      : containerRows(outcome.data, 'primary')
    if (page === 1 && preparedRead.plan.mode === 'detail_with_lines') {
      headerRows = containerRows(outcome.data, 'header')
    }
    rows.push(...pageRows)

    const sourceTotal = outcome.page && outcome.page.sourceTotalCount
    if (Number.isInteger(sourceTotal)) {
      assertKnownSourceNotExceeded(sourceTotal, rows.length)
    }
    if (Number.isInteger(sourceTotal) && rows.length === sourceTotal) {
      return { rows, headerRows, pages: page, sourceTotalKnown: true }
    }
    if (usesPageIndex) {
      if (pageRows.length < pageSize) {
        assertKnownSourceComplete(sourceTotal, rows.length)
        return { rows, headerRows, pages: page, sourceTotalKnown: Number.isInteger(sourceTotal) }
      }
      continue
    }
    if (outcome.page && outcome.page.done === true) {
      assertKnownSourceComplete(sourceTotal, rows.length)
      return { rows, headerRows, pages: page, sourceTotalKnown: Number.isInteger(sourceTotal) }
    }

    const nextCursor = optionalString(outcome.page && outcome.page.nextCursor)
    if (!nextCursor) {
      assertKnownSourceComplete(sourceTotal, rows.length)
      return { rows, headerRows, pages: page, sourceTotalKnown: Number.isInteger(sourceTotal) }
    }
    if (seenCursors.has(nextCursor)) {
      throw new StockPreparationReadonlySourceRunError(
        502,
        'SOURCE_RUN_CURSOR_LOOP',
        'configured readonly source repeated a pagination cursor',
      )
    }
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }

  throw new StockPreparationReadonlySourceRunError(
    422,
    'SOURCE_RUN_RESULT_TOO_LARGE',
    'configured readonly source exceeded the bounded page limit',
    { maxPages: SOURCE_MAX_PAGES, pageSize },
  )
}

function normalizeIntake(input) {
  try {
    return normalizeStockPreparationReadonlyIntake(input)
  } catch (_error) {
    throw new StockPreparationReadonlySourceRunError(
      422,
      'SOURCE_RUN_INTAKE_INVALID',
      'mapped source rows could not be normalized by the stock-preparation intake contract',
    )
  }
}

function assertIntakeReady(intake, expectedField) {
  const result = intake && intake.evidence && intake.evidence.result
  if (!result || typeof result !== 'object') {
    throw new StockPreparationReadonlySourceRunError(
      500,
      'SOURCE_RUN_INTAKE_EVIDENCE_INVALID',
      'stock-preparation intake evidence is unavailable',
    )
  }
  if (result.rowErrors > 0) {
    throw new StockPreparationReadonlySourceRunError(
      422,
      'SOURCE_RUN_REQUIRED_SHAPE_MISSING',
      'mapped source rows do not satisfy the stock-preparation intake contract',
      {
        rowErrors: result.rowErrors,
        byRowErrorType: result.byRowErrorType || {},
        byRowErrorTable: result.byRowErrorTable || {},
      },
    )
  }
  if (!Number.isInteger(result[expectedField]) || result[expectedField] < 1) {
    throw new StockPreparationReadonlySourceRunError(
      422,
      'SOURCE_RUN_EMPTY',
      'configured source returned no mapped rows for the requested intake',
      { expectedShape: expectedField },
    )
  }
}

function buildSourceRunOutcome(sourceRun, channel, source, intake) {
  return {
    sourceRun,
    status: intake.status,
    mode: 'dry_run',
    // Internal data plane for backend consumers. HTTP must project through
    // publicReadonlySourceRunResult and never serialize these normalized business rows.
    intake,
    evidence: {
      sourceChannel: channel,
      configReferenceUsed: true,
      externalReadExecuted: true,
      pages: source.pages,
      sourceRows: source.rows.length,
      intake: intake.evidence,
      rawPayloadReturned: false,
      internalWriteExecuted: false,
      externalWriteExecuted: false,
      productionWrite: false,
      k3SaveSubmitAudit: false,
      plmExternalWrite: false,
      rawSql: false,
      sourcePayloadRowsInEvidence: false,
      privateConfigIdInEvidence: false,
      credentialsInEvidence: false,
      autoApply: false,
      valuesFree: true,
    },
  }
}

function publicReadonlySourceRunResult(outcome) {
  if (!isPlainObject(outcome) || !isPlainObject(outcome.evidence)) {
    throw new StockPreparationReadonlySourceRunError(
      500,
      'SOURCE_RUN_RESULT_INVALID',
      'stock-preparation source-run result is invalid',
    )
  }
  return {
    sourceRun: outcome.sourceRun,
    status: outcome.status,
    mode: outcome.mode,
    evidence: outcome.evidence,
  }
}

async function runPlmBomReadonlySource(input = {}) {
  ensureDependencies(input)
  const kind = assertSourceKind(input.system, PLM_SOURCE_KINDS, 'plm_bom')
  const projectId = requiredString(input.projectId, 'projectId')
  const sourceProjectNo = requiredString(input.sourceProjectNo, 'sourceProjectNo')
  const syncRunId = requiredString(input.syncRunId, 'syncRunId')
  const snapshotBatchId = requiredString(input.snapshotBatchId, 'snapshotBatchId')
  const snapshotVersion = positiveInteger(input.snapshotVersion, 'snapshotVersion')
  const startedAt = new Date().toISOString()
  const source = await readAllMappedRows({
    preparedRead: input.preparedRead,
    system: input.system,
    createAdapter: input.createAdapter,
  })
  const mappedProject = source.headerRows[0] || {}
  const mappedSourceProjectNo = optionalString(mappedProject.sourceProjectNo)
  if (mappedSourceProjectNo && mappedSourceProjectNo !== sourceProjectNo) {
    throw new StockPreparationReadonlySourceRunError(
      409,
      'SOURCE_RUN_PROJECT_SCOPE_MISMATCH',
      'configured source project does not match the requested project scope',
    )
  }

  const intake = normalizeIntake({
    sourceSystem: sourceChannel(kind),
    runId: syncRunId,
    startedAt,
    createdBy: optionalString(input.actor) || 'system',
    snapshotBatchId,
    snapshotVersion,
    sourceBomId: optionalString(mappedProject.sourceBomId) || undefined,
    projects: [{
      ...mappedProject,
      projectId,
      sourceProjectNo,
      projectName: optionalString(mappedProject.projectName)
        || optionalString(input.projectName)
        || undefined,
      sourceSystem: sourceChannel(kind),
    }],
    plmBomLines: source.rows.map((row) => ({ ...row, projectId })),
  })
  assertIntakeReady(intake, 'bomSnapshotLines')
  if (intake.evidence.result.projectRows < 1 || intake.evidence.result.bomSnapshotBatches < 1) {
    throw new StockPreparationReadonlySourceRunError(
      422,
      'SOURCE_RUN_REQUIRED_SHAPE_MISSING',
      'mapped PLM source did not produce the required project and snapshot shapes',
      { requiredShapes: { projectRows: 1, bomSnapshotBatches: 1 } },
    )
  }
  return buildSourceRunOutcome('plm_bom', sourceChannel(kind), source, intake)
}

async function runErpMaterialReadonlySource(input = {}) {
  ensureDependencies(input)
  const kind = assertSourceKind(input.system, ERP_SOURCE_KINDS, 'erp_material')
  const syncRunId = requiredString(input.syncRunId, 'syncRunId')
  const startedAt = new Date().toISOString()
  const source = await readAllMappedRows({
    preparedRead: input.preparedRead,
    system: input.system,
    createAdapter: input.createAdapter,
  })
  const intake = normalizeIntake({
    sourceSystem: sourceChannel(kind),
    runId: syncRunId,
    startedAt,
    createdBy: optionalString(input.actor) || 'system',
    erpMaterials: source.rows,
  })
  assertIntakeReady(intake, 'erpMaterialRows')
  return buildSourceRunOutcome('erp_material', sourceChannel(kind), source, intake)
}

module.exports = {
  ERP_SOURCE_KINDS,
  K3_WEBAPI_SOURCE_PAGE_SIZE,
  PLM_SOURCE_KINDS,
  SOURCE_MAX_PAGES,
  SOURCE_PAGE_SIZE,
  StockPreparationReadonlySourceRunError,
  publicReadonlySourceRunResult,
  runErpMaterialReadonlySource,
  runPlmBomReadonlySource,
  __internals: {
    assertKnownSourceComplete,
    assertKnownSourceNotExceeded,
    assertIntakeReady,
    buildSourceRunOutcome,
    readAllMappedRows,
    sourceChannel,
  },
}
