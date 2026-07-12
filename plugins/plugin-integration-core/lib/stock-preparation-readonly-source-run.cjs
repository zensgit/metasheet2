'use strict'

const { executeConfiguredRead } = require('./read-source-read-runtime.cjs')
const {
  normalizeStockPreparationReadonlyIntake,
} = require('./stock-preparation-readonly-intake.cjs')
const { isPlainObject, optionalString } = require('./stock-preparation-common.cjs')

const REQUIRED_PERMISSION = 'admin'
// TRUSTED_EXECUTION_MAX_ROW_CAP (read-source-read-runtime.cjs) is the hard ceiling for any page we may
// request; the cursor-paging kinds honour a limit that large, so this is the page they get.
const SOURCE_PAGE_SIZE = 1000
// bridge-agent-readonly-adapter.cjs MAX_ADAPTER_LIMIT — the largest config.maxLimit the agent accepts.
// The agent CLAMPS us to its own config.maxLimit (default 20) whatever we ask for, and reports what it
// applied in metadata.limit, so the requested size is only an upper bound here.
const BRIDGE_SOURCE_PAGE_SIZE = 500
// k3-wise-webapi-adapter.cjs DEFAULT_MATERIAL_LIST_MAX_LIMIT — the LIST read THROWS above it.
const K3_WEBAPI_SOURCE_PAGE_SIZE = 10
const SOURCE_MAX_PAGES = 10

// The paging capability of each supported kind, DERIVED FROM THE ADAPTERS THEMSELVES — not from what we
// would like them to do. Re-read the adapter before changing any row:
//
//   plm:yuantus-wrapper         plm-yuantus-wrapper.cjs read(): honours request.limit and pages a BOM
//                               tree by offset cursor (nextCursor = offset+limit while lines remain).
//   data-source:sql-readonly    data-source-sql-readonly-source-adapter.cjs read(): honours request.limit
//                               and returns an offset cursor on every full page.
//   bridge:legacy-sql-readonly  bridge-agent-readonly-adapter.cjs read(): CLAMPS the limit to
//                               config.maxLimit (default 20) and NEVER sends a cursor — the /query/:object
//                               body is {limit, filters} only. It cannot page. At all.
//   erp:k3-wise-sqlserver       k3-wise-sqlserver-executor.cjs: clamps over-max limits and always returns
//                               { nextCursor: null, done: true }. No continuation of any kind.
//   erp:k3-wise-webapi          k3-wise-webapi-adapter.cjs: LIST reads reject cursors and page by
//                               options.listPageIndex (bounded 1..10), capped at 10 rows per page.
//
// `pagination: 'none'` is not a nicety — it means a full page from that kind can NEVER be continued, so
// completeness can never be proven and the run must fail closed rather than ingest a truncated snapshot.
const SOURCE_KIND_CAPABILITIES = Object.freeze({
  'plm:yuantus-wrapper': Object.freeze({ pageSize: SOURCE_PAGE_SIZE, pagination: 'cursor' }),
  'data-source:sql-readonly': Object.freeze({ pageSize: SOURCE_PAGE_SIZE, pagination: 'cursor' }),
  'erp:k3-wise-sqlserver': Object.freeze({ pageSize: SOURCE_PAGE_SIZE, pagination: 'none' }),
  'bridge:legacy-sql-readonly': Object.freeze({ pageSize: BRIDGE_SOURCE_PAGE_SIZE, pagination: 'none' }),
  'erp:k3-wise-webapi': Object.freeze({ pageSize: K3_WEBAPI_SOURCE_PAGE_SIZE, pagination: 'page_index' }),
})

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
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() ? Number(value) : Number.NaN)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
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

// The paging capability of the CONFIGURED kind. page-index paging only exists on the K3 LIST dialect, so
// any other mode on that kind falls back to "cannot continue" rather than to a fictitious page index.
function sourceCapability(plan) {
  const capability = SOURCE_KIND_CAPABILITIES[plan.requiredKind]
  if (!capability) {
    throw new StockPreparationReadonlySourceRunError(
      409,
      'SOURCE_RUN_KIND_NOT_ALLOWED',
      'configured source kind is not allowed for this stock-preparation run',
      { sourceChannel: sourceChannel(plan.requiredKind) },
    )
  }
  const pagination = capability.pagination === 'page_index' && plan.mode !== 'list_page'
    ? 'none'
    : capability.pagination
  return { pageSize: capability.pageSize, pagination }
}

// The page bound the ADAPTER APPLIED, which is the only one a full-page test may be judged against. The
// Bridge Agent clamps our 500 to its config.maxLimit (default 20) and says so in metadata.limit; measuring
// "full page" against the 500 WE asked for makes the guard structurally unable to fire (20 >= 500 is false)
// and a 5,000-row source silently becomes a 20-row `ready` snapshot. An adapter claiming a LARGER page than
// we requested is not believed: the smaller bound is the fail-closed direction (it calls a page full sooner,
// which then demands a proven continuation).
function effectivePageSize(outcome, requestedPageSize) {
  const applied = outcome.page && outcome.page.effectiveLimit
  if (!Number.isInteger(applied) || applied < 1) return requestedPageSize
  return Math.min(applied, requestedPageSize)
}

// Rows in the RAW container as the adapter returned them, BEFORE executeConfiguredRead sliced it to
// rowCap. null for a single-object container (single_record header), which cannot be truncated.
function rawContainerRowCount(outcome, alias) {
  const counts = outcome.page && outcome.page.rawRowCounts
  const count = isPlainObject(counts) ? counts[alias] : null
  return Number.isInteger(count) ? count : null
}

// Read every mapped row of an approved readonly source, and PROVE the result is the whole source.
//
// Completeness is only ever proven two ways:
//   short_page     the adapter returned FEWER rows than the page bound it applied — it had no more to give;
//   declared_total the rows we collected match the row count the SOURCE ITSELF declared.
// Everything else fails closed. In particular an adapter's `done: true` is NEVER evidence of completeness:
// the Bridge Agent and the K3 SQL-Server executor return done:true unconditionally, including on a page
// they just clamped. A snapshot we cannot prove complete is never handed to the intake contract.
async function readAllMappedRows({ preparedRead, system, createAdapter }) {
  if (preparedRead.plan.mode === 'resolver_lookup') {
    throw new StockPreparationReadonlySourceRunError(
      422,
      'SOURCE_RUN_MODE_NOT_SUPPORTED',
      'resolver lookup cannot feed a stock-preparation source run',
      { mode: 'resolver_lookup' },
    )
  }

  const capability = sourceCapability(preparedRead.plan)
  const pageSize = capability.pageSize
  const usesPageIndex = capability.pagination === 'page_index'
  const supportsCursor = capability.pagination === 'cursor'
  const rowsAlias = preparedRead.plan.mode === 'detail_with_lines' ? 'lines' : 'primary'
  const rows = []
  let headerRows = []
  const seenCursors = new Set()
  let cursor = null
  let declaredSourceTotal = null
  let appliedPageSize = pageSize

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

    // A source that ignored our page bound and handed back MORE rows than we asked for was silently
    // truncated by the executor's rowCap slice. Refuse it by name — "too large" is a different fact from
    // "we cannot prove this is complete", and an operator must not have to guess which one happened.
    const rawRowCount = rawContainerRowCount(outcome, rowsAlias)
    if (rawRowCount !== null && rawRowCount > pageSize) {
      throw new StockPreparationReadonlySourceRunError(
        422,
        'SOURCE_RUN_RESULT_TOO_LARGE',
        'configured readonly source returned more rows in one page than the feeder accepts',
        { receivedRows: rawRowCount, pageSize },
      )
    }

    const pageRows = containerRows(outcome.data, rowsAlias)
    if (page === 1 && preparedRead.plan.mode === 'detail_with_lines') {
      headerRows = containerRows(outcome.data, 'header')
    }
    rows.push(...pageRows)

    appliedPageSize = effectivePageSize(outcome, pageSize)
    const pageIsFull = pageRows.length >= appliedPageSize

    const reportedSourceTotal = outcome.page && outcome.page.sourceTotalCount
    if (Number.isInteger(reportedSourceTotal)) {
      if (declaredSourceTotal !== null && declaredSourceTotal !== reportedSourceTotal) {
        throw new StockPreparationReadonlySourceRunError(
          502,
          'SOURCE_RUN_PAGINATION_INCONSISTENT',
          'configured readonly source changed its declared row count during paging',
          {
            previousSourceTotal: declaredSourceTotal,
            sourceTotal: reportedSourceTotal,
          },
        )
      }
      declaredSourceTotal = reportedSourceTotal
      assertKnownSourceNotExceeded(declaredSourceTotal, rows.length)
    }
    const sourceTotal = declaredSourceTotal
    const nextCursor = optionalString(outcome.page && outcome.page.nextCursor)
    if (!usesPageIndex && outcome.page && outcome.page.done === true && nextCursor) {
      throw new StockPreparationReadonlySourceRunError(
        502,
        'SOURCE_RUN_PAGINATION_INCONSISTENT',
        'configured readonly source returned a terminal page with a continuation cursor',
      )
    }

    // PROOF 1 — the source declared its own row count and we hold exactly that many rows.
    if (Number.isInteger(sourceTotal) && rows.length === sourceTotal) {
      if (!usesPageIndex && nextCursor) {
        throw new StockPreparationReadonlySourceRunError(
          502,
          'SOURCE_RUN_PAGINATION_INCONSISTENT',
          'configured readonly source returned a continuation cursor after its declared row count',
        )
      }
      return completeRead(rows, headerRows, page, 'declared_total', true, pageSize, appliedPageSize)
    }

    // A continuation the adapter actually OFFERED is always followed — even on a short page, where the
    // cursor is the source saying "there is more" (PLM's wrapper emits one from a declared total). Note
    // this is not the mirror image of distrusting `done: true`: following an offered cursor can only ever
    // find rows we would otherwise have dropped, and the loop is bounded by seenCursors + SOURCE_MAX_PAGES.
    // A kind that cannot SEND a cursor (bridge, k3 sqlserver) can never follow one, whatever it echoes.
    if (!usesPageIndex && supportsCursor && nextCursor) {
      if (seenCursors.has(nextCursor)) {
        throw new StockPreparationReadonlySourceRunError(
          502,
          'SOURCE_RUN_CURSOR_LOOP',
          'configured readonly source repeated a pagination cursor',
        )
      }
      seenCursors.add(nextCursor)
      cursor = nextCursor
      continue
    }

    // PROOF 2 — a short page with no continuation on offer: the adapter returned fewer rows than the bound
    // it itself applied, so it had nothing more to give. (Falling short of a DECLARED total still fails
    // closed inside assertKnownSourceComplete.)
    if (!pageIsFull) {
      assertKnownSourceComplete(sourceTotal, rows.length)
      return completeRead(
        rows,
        headerRows,
        page,
        'short_page',
        Number.isInteger(sourceTotal),
        pageSize,
        appliedPageSize,
      )
    }

    // Full page and nothing left to prove it with. The page-index dialect still has pages in its budget;
    // every other kind is out of moves and must NOT report a snapshot it cannot vouch for.
    if (usesPageIndex) continue
    throw new StockPreparationReadonlySourceRunError(
      502,
      'SOURCE_RUN_COMPLETENESS_UNPROVABLE',
      'configured readonly source filled its page and offers no way to prove there is nothing more',
      {
        receivedRows: rows.length,
        pageSize,
        effectivePageSize: appliedPageSize,
        pagination: capability.pagination,
        cursorReturned: Boolean(nextCursor),
      },
    )
  }

  // Every page in the budget came back full: the source has at least this many rows and may have more.
  throw new StockPreparationReadonlySourceRunError(
    422,
    'SOURCE_RUN_RESULT_TOO_LARGE',
    'configured readonly source exceeded the bounded page limit',
    { maxPages: SOURCE_MAX_PAGES, pageSize, effectivePageSize: appliedPageSize, receivedRows: rows.length },
  )
}

function completeRead(rows, headerRows, pages, completenessProof, sourceTotalKnown, pageSize, appliedPageSize) {
  return {
    rows,
    headerRows,
    pages,
    completenessProof,
    sourceTotalKnown,
    pageSizeRequested: pageSize,
    pageSizeEffective: appliedPageSize,
  }
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
      // How completeness was PROVEN for this snapshot — never an assumption, and never the adapter's own
      // `done` flag. 'short_page': the source returned fewer rows than the page bound it applied.
      // 'declared_total': the collected rows matched the row count the source declared. A run that can
      // prove neither never reaches this projector (SOURCE_RUN_COMPLETENESS_UNPROVABLE / _TOO_LARGE).
      completenessProof: source.completenessProof,
      sourceTotalKnown: source.sourceTotalKnown,
      // The page we asked for vs the page the ADAPTER applied. They differ whenever a source clamps us
      // (Bridge Agent -> config.maxLimit), which is exactly when a truncated read looks complete.
      sourcePageSizeRequested: source.pageSizeRequested,
      sourcePageSizeEffective: source.pageSizeEffective,
      // Proven, not asserted: a page whose raw container exceeded the accepted size fails closed above.
      sourceRowsTruncated: false,
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
  BRIDGE_SOURCE_PAGE_SIZE,
  ERP_SOURCE_KINDS,
  K3_WEBAPI_SOURCE_PAGE_SIZE,
  PLM_SOURCE_KINDS,
  SOURCE_KIND_CAPABILITIES,
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
    effectivePageSize,
    rawContainerRowCount,
    readAllMappedRows,
    sourceCapability,
    sourceChannel,
  },
}
