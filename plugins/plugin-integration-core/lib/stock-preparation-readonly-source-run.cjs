'use strict'

const { executeConfiguredRead } = require('./read-source-read-runtime.cjs')
const {
  normalizeStockPreparationReadonlyIntake,
} = require('./stock-preparation-readonly-intake.cjs')
const { isPlainObject, optionalString } = require('./stock-preparation-common.cjs')

const REQUIRED_PERMISSION = 'admin'
// The feeder ingests business rows, so it reads the ADAPTER'S row plane — the rows the adapter normalized,
// flattened and paged — never the unprocessed upstream payload. Walking the raw payload silently bypasses
// that entire layer: a PLM BOM *tree* presents as a single root node there (its 2,500 flattened lines exist
// only in the record plane), and data-source:sql-readonly has no raw payload at all.
const ROW_SOURCE = 'adapter_records'
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
//
// `limitContract` says HOW we learn the page bound the adapter actually applied. There is no default and no
// fallback: "we asked for 1000, so it must have been 1000" is the assumption that let a clamped 20-row page
// pass as a complete 5,000-row source in the first place.
//   'adapter_reported' — the adapter CLAMPS, and reports what it applied (bridge: metadata.limit). If a page
//                        arrives without that report we cannot know what bound was applied -> fail closed.
//   'honours_request'  — the adapter executes the limit we send, verbatim, and never silently lowers it.
//                        Each one below is asserted against its adapter source. If such an adapter ever DOES
//                        report a smaller applied limit we believe the smaller number (fail-closed direction).
const ADAPTER_REPORTED_LIMIT = 'adapter_reported'
const HONOURS_REQUESTED_LIMIT = 'honours_request'
const SOURCE_KIND_CAPABILITIES = Object.freeze({
  // read(): passes request.limit straight to the PLM client and slices the flattened BOM by it.
  'plm:yuantus-wrapper': Object.freeze({
    pageSize: SOURCE_PAGE_SIZE, pagination: 'cursor', limitContract: HONOURS_REQUESTED_LIMIT,
  }),
  // read(): selectOptions.limit = request.limit; the facade REJECTS an over-max limit, never clamps it.
  'data-source:sql-readonly': Object.freeze({
    pageSize: SOURCE_PAGE_SIZE, pagination: 'cursor', limitContract: HONOURS_REQUESTED_LIMIT,
  }),
  // executor limitPolicy: maxLimit 10000, overMax 'clamp' — our 1000 is far below the clamp point.
  'erp:k3-wise-sqlserver': Object.freeze({
    pageSize: SOURCE_PAGE_SIZE, pagination: 'none', limitContract: HONOURS_REQUESTED_LIMIT,
  }),
  // normalizeBridgeLimit(): Math.min(requested, config.maxLimit) — CLAMPS, and echoes it in metadata.limit.
  'bridge:legacy-sql-readonly': Object.freeze({
    pageSize: BRIDGE_SOURCE_PAGE_SIZE, pagination: 'none', limitContract: ADAPTER_REPORTED_LIMIT,
  }),
  // LIST read THROWS when request.limit exceeds maxListLimit — it can never quietly serve a smaller page.
  'erp:k3-wise-webapi': Object.freeze({
    pageSize: K3_WEBAPI_SOURCE_PAGE_SIZE, pagination: 'page_index', limitContract: HONOURS_REQUESTED_LIMIT,
  }),
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
  if (capability.limitContract !== ADAPTER_REPORTED_LIMIT && capability.limitContract !== HONOURS_REQUESTED_LIMIT) {
    throw new StockPreparationReadonlySourceRunError(
      409,
      'SOURCE_RUN_KIND_NOT_ALLOWED',
      'configured source kind declares no effective-page-size contract',
      { sourceChannel: sourceChannel(plan.requiredKind) },
    )
  }
  return { pageSize: capability.pageSize, pagination, limitContract: capability.limitContract }
}

// The page bound the ADAPTER APPLIED, which is the only one a full-page test may be judged against. The
// Bridge Agent clamps our 500 to its config.maxLimit (default 20) and says so in metadata.limit; measuring
// "full page" against the 500 WE asked for makes the guard structurally unable to fire (20 >= 500 is false)
// and a 5,000-row source silently becomes a 20-row `ready` snapshot.
//
// There is NO fallback to "well, we asked for N". A kind whose adapter clamps must report what it applied
// (limitContract 'adapter_reported'); if that report is missing, the applied bound is unknown and the page
// is unprovable — never assumed. A kind contracted to honour the request uses the request, and if it ever
// reports a SMALLER applied bound we believe the smaller number (the fail-closed direction: it calls a page
// full sooner, which then demands a proven continuation). A larger claim is never believed.
function effectivePageSize(outcome, requestedPageSize, limitContract) {
  const applied = outcome.page && outcome.page.effectiveLimit
  if (Number.isInteger(applied) && applied >= 1) return Math.min(applied, requestedPageSize)
  return limitContract === ADAPTER_REPORTED_LIMIT ? null : requestedPageSize
}

// Rows in the RAW container as the adapter returned them, BEFORE executeConfiguredRead sliced it to
// rowCap. null when the raw payload has no such array (the row plane is the adapter's `records`).
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
  // resolver_lookup resolves ONE key to ONE value: it has no row plane to feed an intake with.
  // detail_with_lines splits a payload into header + lines, which only exists in the RAW upstream shape —
  // and the raw shape is exactly the layer a feeder must not read (see ROW_SOURCE below). It is also
  // unreachable in practice: the probe request builder only ever sends the K3 `options.bomKey` dialect for
  // that mode, so the PLM wrapper rejects it outright. Refuse it rather than pretend to support it.
  if (preparedRead.plan.mode !== 'list_page' && preparedRead.plan.mode !== 'single_record') {
    throw new StockPreparationReadonlySourceRunError(
      422,
      'SOURCE_RUN_MODE_NOT_SUPPORTED',
      'this read mode cannot feed a stock-preparation source run',
      { mode: optionalString(preparedRead.plan.mode) || 'unknown' },
    )
  }

  const capability = sourceCapability(preparedRead.plan)
  const pageSize = capability.pageSize
  const usesPageIndex = capability.pagination === 'page_index'
  const supportsCursor = capability.pagination === 'cursor'
  const rowsAlias = 'primary'
  const rows = []
  const headerRows = []
  const fieldResolution = {}
  const seenCursors = new Set()
  const seenPages = new Set()
  let cursor = null
  let declaredSourceTotal = null
  let appliedPageSize = pageSize

  for (let page = 1; page <= SOURCE_MAX_PAGES; page += 1) {
    const execution = usesPageIndex
      ? { rowCap: pageSize, pageIndex: page, rowSource: ROW_SOURCE }
      : { rowCap: pageSize, cursor, rowSource: ROW_SOURCE }
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

    // The adapter's own count of the rows in this page, and what its metadata separately CLAIMS it
    // returned. Both are needed before a single row is trusted.
    const adapterRowCount = outcome.page && outcome.page.adapterRecordCount
    const reportedRowCount = outcome.page && outcome.page.reportedRecordCount
    if (!Number.isInteger(adapterRowCount)) {
      throw new StockPreparationReadonlySourceRunError(
        502,
        'SOURCE_RUN_SOURCE_SHAPE_UNVERIFIABLE',
        'configured readonly source returned no row plane to verify',
        { pageSize },
      )
    }

    // A source that ignored our page bound and handed back MORE rows than it accepts was silently truncated
    // by the executor's rowCap slice. Refuse it by name — "too large" is a different fact from "we cannot
    // prove this is complete", and an operator must not have to guess which one happened. Both planes are
    // checked: the adapter's rows, and the raw upstream container when the payload carries one.
    const rawRowCount = rawContainerRowCount(outcome, rowsAlias)
    const overflowRows = adapterRowCount > pageSize
      ? adapterRowCount
      : (rawRowCount !== null && rawRowCount > pageSize ? rawRowCount : null)
    if (overflowRows !== null) {
      throw new StockPreparationReadonlySourceRunError(
        422,
        'SOURCE_RUN_RESULT_TOO_LARGE',
        'configured readonly source returned more rows in one page than the feeder accepts',
        { receivedRows: overflowRows, pageSize },
      )
    }

    const pageRows = containerRows(outcome.data, rowsAlias)
    // The adapter's records array and the count its metadata CLAIMS must agree. (There is no third check
    // against the mapped row count: on the record plane the mapped rows ARE the adapter's rows, capped at
    // the same bound the overflow check above already enforced, so comparing them could never fail. The
    // BOM-tree divergence is prevented by reading the record plane at all — not by this comparison.)
    if (Number.isInteger(reportedRowCount) && reportedRowCount !== adapterRowCount) {
      throw new StockPreparationReadonlySourceRunError(
        502,
        'SOURCE_RUN_SOURCE_SHAPE_UNVERIFIABLE',
        'configured readonly source disagrees with itself about how many rows this page holds',
        { adapterRows: adapterRowCount, reportedRows: reportedRowCount },
      )
    }
    const pageFieldResolution = (outcome.page && outcome.page.fieldResolution) || {}
    for (const target of Object.keys(pageFieldResolution)) {
      fieldResolution[target] = (fieldResolution[target] || 0) + pageFieldResolution[target]
    }

    // Paging must be PROVEN to advance, not assumed. A K3 endpoint that ignores PageIndex (a custom view or
    // stored proc that honours Top but not PageIndex, and still returns ROWCOUNT) serves page 1 to all ten
    // requests; the duplicate rows then ADD UP to the total it declared and satisfy the strongest proof we
    // have. So: the source must echo back the page it applied, and it must be the page we asked for.
    if (usesPageIndex) {
      const echoedPageIndex = outcome.page && outcome.page.echoedPageIndex
      if (!Number.isInteger(echoedPageIndex) || echoedPageIndex !== page) {
        throw new StockPreparationReadonlySourceRunError(
          502,
          'SOURCE_RUN_PAGINATION_UNVERIFIED',
          'configured readonly source did not confirm which page it served',
          {
            requestedPageIndex: page,
            ...(Number.isInteger(echoedPageIndex) ? { echoedPageIndex } : { echoedPageIndex: null }),
          },
        )
      }
    }

    // ... and the page must actually be a different page. This catches every "pagination did not move"
    // shape at once, whatever the mechanism: a page index the source ignores, an offset cursor a client
    // drops on the floor, a bridge agent replaying its only page.
    const fingerprint = optionalString(
      outcome.page && outcome.page.rowFingerprints && outcome.page.rowFingerprints[rowsAlias],
    )
    if (!fingerprint) {
      throw new StockPreparationReadonlySourceRunError(
        502,
        'SOURCE_RUN_SOURCE_SHAPE_UNVERIFIABLE',
        'configured readonly source returned a page with no verifiable identity',
        { page },
      )
    }
    if (pageRows.length > 0) {
      if (seenPages.has(fingerprint)) {
        throw new StockPreparationReadonlySourceRunError(
          502,
          'SOURCE_RUN_PAGE_NOT_ADVANCING',
          'configured readonly source repeated a page it had already served',
          { page, receivedRows: rows.length },
        )
      }
      seenPages.add(fingerprint)
    }

    rows.push(...pageRows)

    const applied = effectivePageSize(outcome, pageSize, capability.limitContract)
    if (applied === null) {
      // The kind is contracted to report the bound it applied (it clamps), and did not. We cannot tell a
      // full page from a short one, so nothing about this read is provable.
      throw new StockPreparationReadonlySourceRunError(
        502,
        'SOURCE_RUN_COMPLETENESS_UNPROVABLE',
        'configured readonly source did not report the page bound it applied',
        { pageSize, receivedRows: rows.length, reason: 'effective_page_size_unknown' },
      )
    }
    appliedPageSize = applied
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
      assertEveryConfiguredFieldResolved(preparedRead.fieldMap, fieldResolution, rows.length)
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
      assertEveryConfiguredFieldResolved(preparedRead.fieldMap, fieldResolution, rows.length)
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

// A field the operator CONFIGURED must actually exist on the rows we read. `mapRecord` is per-field
// fail-soft: a source path that resolves nowhere quietly becomes null on every row, and the intake contract
// only requires a couple of columns — so a fieldMap written against the wrong plane, or with one typo'd
// field name, produced a 2,500-line BOM snapshot whose designQty and designUnit were null on EVERY row,
// reported as `ready` with rowErrors: 0. A configured field that resolved on NOT ONE row is a broken config,
// not an empty column. Values-free: target names (our own intake vocabulary) and counts only — never the
// source path, which names the external system's schema.
function assertEveryConfiguredFieldResolved(fieldMap, fieldResolution, receivedRows) {
  if (receivedRows < 1) return
  const unresolvedTargets = []
  for (const entry of fieldMap) {
    if (!Number.isInteger(fieldResolution[entry.target]) || fieldResolution[entry.target] < 1) {
      unresolvedTargets.push(entry.target)
    }
  }
  if (unresolvedTargets.length > 0) {
    throw new StockPreparationReadonlySourceRunError(
      422,
      'SOURCE_RUN_FIELD_MAP_UNRESOLVED',
      'configured fields do not exist on the rows this source actually returns',
      { unresolvedTargets: unresolvedTargets.sort(), receivedRows },
    )
  }
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

// Fail closed when the source's own rows say they belong to a different project than the run was scoped to.
// A row that carries no source project at all says nothing and is left to the intake contract; a row that
// NAMES a project must name this one.
function assertRowsStayInProjectScope(rows, sourceProjectNo, mappedProject) {
  const candidates = [mappedProject, ...rows]
  for (const row of candidates) {
    const rowProjectNo = optionalString(row && row.sourceProjectNo)
    if (rowProjectNo && rowProjectNo !== sourceProjectNo) {
      throw new StockPreparationReadonlySourceRunError(
        409,
        'SOURCE_RUN_PROJECT_SCOPE_MISMATCH',
        'configured source project does not match the requested project scope',
      )
    }
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
  // Project scope is enforced against every row the source actually returned, not just a header row. The
  // header only exists in detail_with_lines — a mode no usable PLM config can reach — so a guard that read
  // only the header could never fire on the live path: an approved config pointed at ANOTHER project's BOM
  // would have been ingested under this project's id without a word. Any row that names its source project
  // must name the one we asked for.
  assertRowsStayInProjectScope(source.rows, sourceProjectNo, mappedProject)

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
    readAllMappedRows,
    sourceCapability,
    sourceChannel,
  },
}
