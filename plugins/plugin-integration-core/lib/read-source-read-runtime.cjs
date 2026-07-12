'use strict'

// External-API read self-service — S3-1: config-driven read EXECUTOR (pure module, #1709).
//
// Two-tier model (S0 direction lock): the runtime tier consumes an ALREADY-APPROVED, S1-normalized
// read-source config and supplies ONLY the preset-declared named key input — never a raw endpoint, filter,
// body, or response path. This module is the DATA-PLANE counterpart of the S2-b probe (evidence-only):
// the config's fieldMap carries mapped field VALUES into the authorized caller context, while the EVIDENCE
// plane stays values-free (same vocabulary as the probe). The two planes never mix: mapped values, fieldMap
// names, raw rows, and the supplied key can appear ONLY under `data`, never under `evidence`.
//
// Scope fence: pure functions + injected deps. No route, no persistence, no approved-config lookup (the
// route wiring is the next gated slice and passes an already-loaded config + system in), no write path,
// no new credential path. Outbound mechanics are the PROMOTED S2-b builders — the probe and the configured
// read build the same overlay and the same request, and classify errors identically, by construction.

const { createHash } = require('node:crypto')
const { isSafeRelativeReadPath } = require('./read-source-config.cjs')
const {
  READ_SOURCE_PROBE_TIMEOUT_MS,
  ReadSourceProbeContractError,
  normalizeReadSourceProbeContract,
  readSourceProbeEvidence,
} = require('./read-source-probe-contract.cjs')
const {
  ReadSourceProbeRuntimeError,
  buildReadSourceProbeOverlayPreset,
  buildReadSourceProbeRequest,
  classifyProbeErrorCode,
  normalizeReadSourceProbeInputs,
} = require('./read-source-probe-runtime.cjs')
// R2 (#1709): resolver_lookup runtime = the R1 pure evaluator, wired here (standalone only). The evaluator
// owns all multiplicity-rule selection + values-free evidence; this executor only supplies the outbound
// keyed read + the config, then returns the evaluator's { evidence, data } verbatim.
const { evaluateResolver } = require('./read-source-resolver-evaluator.cjs')
// BL2 (#1709): when the by-material BOM-list preset fails in the shared resolver evaluator, the generic
// resolver code is remapped to the preset's registered family (BL0 error taxonomy) — exact-key map only.
const {
  K3WISE_BOM_LIST_BY_MATERIAL_PRESET,
  K3_WISE_BOM_LIST_BY_MATERIAL_RESOLVER_CODE_MAP,
} = require('./read-source-bom-list-by-material-contract.cjs')
const { applyReadSmokePresetOverlay } = require('./read-smoke.cjs')

const CONFIGURED_READ_BODY_KEYS = Object.freeze(['config', 'inputs'])
const TRUSTED_EXECUTION_MAX_ROW_CAP = 1000
const TRUSTED_EXECUTION_MAX_PAGE_INDEX = 10

// Where a configured read takes its ROWS from.
//
// `raw_containers` (default, unchanged): walk the config's containerPaths over the adapter's UNPROCESSED
// upstream payload. This is what the probe shows an operator when they author a config, so it stays the
// default for the probe route, composition hops and the resolver.
//
// `adapter_records`: take the rows from `readResult.records` — the adapter's OWN row plane, after it has
// normalized, flattened and PAGINATED them. The two planes are NOT the same shape, and for some adapters
// they are not even the same data:
//   - plm-yuantus-wrapper flattens a BOM *tree* (flattenBomNode) and applies offset paging on `records`;
//     `raw` stays the tree root, so a containerPaths walk over `raw` sees ONE node for a 2,500-line BOM.
//   - data-source:sql-readonly never sets `raw` at all — its rows exist only in `records`.
// A trusted feeder that INGESTS business rows must therefore read the record plane; walking `raw` silently
// bypasses the adapter's whole normalization + pagination layer.
const RAW_CONTAINERS = 'raw_containers'
const ADAPTER_RECORDS = 'adapter_records'

// R2 (#1709, owner-authorized 2026-07-03): resolver_lookup is now a supported runtime mode — its multiplicity
// selection semantics were designed (resolver design-lock) and implemented as the R1 pure evaluator, which
// this executor invokes. STANDALONE: called directly, the resolver resolves one key to one value and
// returns it to the caller, with no chaining here. The composition path (C-R3, merged) lives in
// read-source-composition-runtime.cjs and orchestrates this executor per hop, feeding one hop's resolved
// value into the next hop's key input. The other three modes keep the generic field-map data plane below.
const CONFIGURED_READ_SUPPORTED_MODES = Object.freeze(['single_record', 'list_page', 'detail_with_lines', 'resolver_lookup'])

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// Normalize the runtime-read input: S1-normalized config only (enforced by the S2-a contract normalizer's
// strict allowlist + config_not_normalized comparison), S2-b named-inputs discipline, PLUS the data-plane
// fail-closed rule: a configured read without a fieldMap has no data plane and is rejected outright.
function prepareConfiguredRead(body) {
  if (!isPlainObject(body)) {
    throw new ReadSourceProbeContractError('not_object')
  }
  if (!Object.keys(body).every((key) => CONFIGURED_READ_BODY_KEYS.includes(key))) {
    throw new ReadSourceProbeContractError('unexpected_field')
  }
  // A configured read IS a bounded, capped read — build the plan with boundedSmoke true so the plan and
  // its evidence say so consistently (no boundedSmoke:false + boundedSmokeExecuted:true contradiction).
  const plan = normalizeReadSourceProbeContract({ config: body.config, boundedSmoke: true })
  if (!CONFIGURED_READ_SUPPORTED_MODES.includes(plan.mode)) {
    throw new ReadSourceProbeContractError('mode_not_supported')
  }
  const fieldMap = body.config && body.config.fieldMap
  if (!Array.isArray(fieldMap) || fieldMap.length === 0) {
    throw new ReadSourceProbeContractError('field_map_required')
  }
  return Object.freeze({
    plan,
    fieldMap,
    // R2: the S1-normalized config (body.config is byte-equal to the validator's normalized output — the
    // S2-a contract's assertS1NormalizedConfig guarantees it) is threaded through for resolver_lookup, whose
    // evaluator consumes resolverRule / multiplicityRuleField / resolverSortDirection /
    // resolverDiscriminatorValue / containerPaths / fieldMap. The other modes ignore it.
    config: body.config,
    inputs: normalizeReadSourceProbeInputs(plan, body.inputs),
  })
}

// Own-property dotted walk that returns the VALUE (the probe's walk is shape-only and stays there).
// Prototype keys never resolve.
function walkOwnPath(root, path) {
  let current = root
  for (const segment of path.split('.')) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { resolved: false, value: null }
    }
    current = current[segment]
  }
  return { resolved: true, value: current }
}

function locateContainerValue(raw, paths) {
  for (const path of paths) {
    const { resolved, value } = walkOwnPath(raw, path)
    if (resolved) return { located: true, value }
  }
  return { located: false, value: null }
}

function classifyContainerShape(value) {
  if (Array.isArray(value)) return { type: 'array', arrayLength: value.length }
  if (value === null) return { type: 'null', arrayLength: null }
  const type = typeof value
  if (type === 'object') return { type: 'object', arrayLength: null }
  if (type === 'string' || type === 'number' || type === 'boolean') return { type, arrayLength: null }
  return { type: 'other', arrayLength: null }
}

// Data-plane projection: ONLY fieldMap targets appear on an output record — never the whole raw row,
// never an unmapped field. A source that does not resolve in the row maps to null (fail-soft per field;
// the container-level shape rules above stay fail-closed).
//
// `resolvedCounts` (optional) tallies, per TARGET, how many rows the mapping actually RESOLVED. Silently
// writing null for a source path that resolves nowhere is how a fieldMap written against one plane, or with
// one typo'd field name, produces a full page of rows whose business columns are all null — with no error
// anywhere. The tally lets a trusted caller notice. Counts only, keyed by target (our own intake vocabulary),
// never by source path (which names the external system's schema).
function mapRecord(row, fieldMap, resolvedCounts) {
  const record = {}
  for (const entry of fieldMap) {
    const { resolved, value } = walkOwnPath(row, entry.source)
    record[entry.target] = resolved ? value : null
    if (resolvedCounts && resolved) {
      resolvedCounts[entry.target] = (resolvedCounts[entry.target] || 0) + 1
    }
  }
  return record
}

// Identity of a page, computed from the rows the ADAPTER returned — not from the fieldMap projection of
// them. The projection is lossy: two genuinely different pages that differ only in a column the config does
// not map would collide, and a paging feeder would wrongly call that a replayed page.
function fingerprintRows(rows) {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

function failureOutcome(plan, errorCode, errorType, extra) {
  return {
    evidence: readSourceProbeEvidence(plan, { ok: false, errorCode, errorType, ...extra }),
    data: null,
  }
}

function normalizeTrustedExecution(plan, input) {
  if (input === undefined || input === null) {
    return { plan, cursor: null, pageIndex: null, rowCapExplicit: false, rowSource: RAW_CONTAINERS }
  }
  if (!isPlainObject(input)) {
    throw new ReadSourceProbeContractError('execution_options_invalid')
  }
  if (!Object.keys(input).every((key) => ['rowCap', 'cursor', 'pageIndex', 'rowSource'].includes(key))) {
    throw new ReadSourceProbeContractError('execution_options_unexpected_field')
  }
  const rowSource = input.rowSource === undefined ? RAW_CONTAINERS : input.rowSource
  if (rowSource !== RAW_CONTAINERS && rowSource !== ADAPTER_RECORDS) {
    throw new ReadSourceProbeContractError('execution_row_source_invalid')
  }
  // The adapter's record plane is ONE flat page of rows. It cannot express the header/lines split that
  // detail_with_lines is, and resolver_lookup owns its own evaluator — neither may ask for it.
  if (rowSource === ADAPTER_RECORDS && plan.mode !== 'list_page' && plan.mode !== 'single_record') {
    throw new ReadSourceProbeContractError('execution_row_source_mode_not_supported')
  }
  const rowCap = input.rowCap === undefined ? plan.rowCap : Number(input.rowCap)
  if (!Number.isInteger(rowCap) || rowCap < 1 || rowCap > TRUSTED_EXECUTION_MAX_ROW_CAP) {
    throw new ReadSourceProbeContractError('execution_row_cap_invalid')
  }
  const cursor = input.cursor === undefined || input.cursor === null
    ? null
    : (typeof input.cursor === 'string' && input.cursor.length <= 512 ? input.cursor : undefined)
  if (cursor === undefined) {
    throw new ReadSourceProbeContractError('execution_cursor_invalid')
  }
  const pageIndex = input.pageIndex === undefined || input.pageIndex === null
    ? null
    : Number(input.pageIndex)
  if (
    pageIndex !== null
    && (!Number.isInteger(pageIndex) || pageIndex < 1 || pageIndex > TRUSTED_EXECUTION_MAX_PAGE_INDEX)
  ) {
    throw new ReadSourceProbeContractError('execution_page_index_invalid')
  }
  if (cursor !== null && pageIndex !== null) {
    throw new ReadSourceProbeContractError('execution_pagination_conflict')
  }
  if (plan.mode !== 'list_page' && pageIndex !== null) {
    throw new ReadSourceProbeContractError('execution_page_index_not_allowed')
  }
  return {
    plan: rowCap === plan.rowCap ? plan : Object.freeze({ ...plan, rowCap }),
    cursor,
    pageIndex,
    // A trusted feeder that NAMES its own page bound is entitled to have that bound reach the adapter.
    rowCapExplicit: input.rowCap !== undefined,
    rowSource,
  }
}

function buildExecutionRequest(plan, inputs, execution) {
  const request = buildReadSourceProbeRequest(plan, inputs)
  // The probe builder only sets `limit` for the list dialects (list_page / bom_list_by_material), so a
  // single_record / detail_with_lines execution would otherwise carry NO limit and the adapter would fall
  // back to its own default (PLM/SQL 1000, Bridge sampleLimit=3). A page bound the source never sees is
  // fiction — a caller that supplied an explicit rowCap gets it sent. Callers that supply no trusted
  // execution (probe route, composition hops) keep their exact previous request shape.
  if (execution.rowCapExplicit && request.limit === undefined) {
    request.limit = plan.rowCap
  }
  if (execution.cursor !== null) {
    request.cursor = execution.cursor
    if (isPlainObject(request.options) && Object.prototype.hasOwnProperty.call(request.options, 'listPageIndex')) {
      const options = { ...request.options }
      delete options.listPageIndex
      request.options = options
    }
  }
  if (execution.pageIndex !== null) {
    request.options = { ...(request.options || {}), listPageIndex: execution.pageIndex }
  }
  return request
}

function safeCount(...values) {
  for (const value of values) {
    const parsed = typeof value === 'string' && value.trim() ? Number(value) : value
    if (typeof parsed === 'number' && Number.isInteger(parsed) && parsed >= 0) return parsed
  }
  return null
}

function buildInternalPage(raced, request, mappedRecordCount, rawContainerRowCounts, rowPlane) {
  const metadata = isPlainObject(raced && raced.metadata) ? raced.metadata : {}
  return {
    nextCursor: typeof raced?.nextCursor === 'string' && raced.nextCursor.length <= 512
      ? raced.nextCursor
      : null,
    done: raced?.done === true,
    returnedRecordCount: safeCount(
      metadata.returnedRecordCount,
      Array.isArray(raced && raced.records) ? raced.records.length : null,
      mappedRecordCount,
    ),
    // Generic `metadata.count` is commonly the current page size (PLM/Bridge), not a source total.
    // Only explicitly total-shaped fields may terminate multi-page intake early.
    sourceTotalCount: safeCount(metadata.dataRowCount, metadata.totalCount),
    pageIndex: safeCount(metadata.dataPageIndex, metadata.requestedPageIndex, request?.options?.listPageIndex),
    // The page index the SOURCE echoed back — never our own requested value. `pageIndex` above falls back
    // to what we asked for, so it can never witness a source that ignores paging and serves page 1 forever;
    // a paging feeder must be able to tell "K3 says it applied page 7" from "we asked for page 7".
    echoedPageIndex: safeCount(metadata.dataPageIndex),
    // Rows in the adapter's OWN record plane for this page (post-normalization/flatten/paging), before any
    // rowCap slice. This is the adapter's answer to "how many rows does this page have"; a feeder that maps
    // a different number of rows out of the payload is not reading the source's rows.
    adapterRecordCount: Array.isArray(raced && raced.records) ? raced.records.length : null,
    // What the adapter's metadata CLAIMS it returned (no fallback): a third, independent witness of the
    // same count, so metadata that disagrees with the records array cannot pass unnoticed.
    reportedRecordCount: safeCount(metadata.returnedRecordCount),
    // The page bound the ADAPTER ACTUALLY APPLIED, which is not always the one we requested: the Bridge
    // Agent adapter silently clamps the request to config.maxLimit (default 20) and reports the applied
    // value here (bridge-agent-readonly-adapter.cjs metadata.limit). A paging feeder that judges "was this
    // page full?" against the REQUESTED size instead of this one can never detect a clamped source.
    effectiveLimit: safeCount(metadata.limit, metadata.effectiveLimit),
    // Row counts of the RAW containers as the adapter returned them — i.e. BEFORE the plan.rowCap slice
    // below. Without this a caller cannot tell "the source has exactly rowCap rows" from "the source had
    // more and we silently truncated it": both leave exactly rowCap mapped records.
    rawRowCounts: Object.freeze({ ...rawContainerRowCounts }),
    // Per-TARGET tally of how many rows each configured field actually RESOLVED on. A source path that
    // resolves nowhere maps to null on every row, silently — this is how a caller notices.
    fieldResolution: Object.freeze({ ...((rowPlane && rowPlane.fieldResolution) || {}) }),
    // Identity of the rows AS THE ADAPTER RETURNED THEM, never the lossy fieldMap projection of them.
    rowFingerprints: Object.freeze({ ...((rowPlane && rowPlane.rowFingerprints) || {}) }),
  }
}

// Row counts of the config's containers as they sit in the RAW upstream payload — i.e. before any rowCap
// slice, and independent of where the rows themselves came from. Used for overflow diagnostics only.
function rawContainerRowCounts(plan, raw) {
  const counts = {}
  if (!isPlainObject(raw)) return counts
  for (const container of plan.containers) {
    const { located, value } = locateContainerValue(raw, container.paths)
    counts[container.alias] = located && Array.isArray(value) ? value.length : null
  }
  return counts
}

// #3889 data plane over the adapter's OWN records: the rows the adapter normalized, flattened and paged.
// The fieldMap is applied to those records (for PLM's BOM lines the untouched upstream row remains reachable
// under `rawPayload.*`, which is how a config keeps addressing source fields the wrapper does not normalize).
function executeFromAdapterRecords(plan, fieldMap, raced, request) {
  const records = Array.isArray(raced && raced.records) ? raced.records : null
  if (!records) {
    return failureOutcome(plan, 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED', 'ReadSourceProbeRuntimeError')
  }
  const rows = records.slice(0, plan.rowCap)
  // Same fail-closed rule as the raw plane: a scalar inside the row plane is a shape mismatch, not a row.
  if (!rows.every(isPlainObject)) {
    return failureOutcome(plan, 'READ_SOURCE_PROBE_SHAPE_MISMATCH', 'ReadSourceProbeRuntimeError', {
      containers: { primary: classifyContainerShape(records) },
      containerLocated: true,
    })
  }
  const fieldResolution = {}
  const mapped = rows.map((row) => mapRecord(row, fieldMap, fieldResolution))
  const shapes = { primary: { type: 'array', arrayLength: records.length } }
  const evidence = readSourceProbeEvidence(plan, {
    ok: true,
    containers: shapes,
    containerLocated: true,
    boundedSmokeExecuted: true,
    timeoutReached: false,
    recordCount: mapped.length,
    capReached: records.length >= plan.rowCap,
  })
  const result = {
    evidence,
    data: { containers: { primary: { records: mapped } }, recordCount: mapped.length },
  }
  Object.defineProperty(result, 'page', {
    value: Object.freeze(buildInternalPage(
      raced,
      request,
      mapped.length,
      rawContainerRowCounts(plan, raced && raced.raw),
      { fieldResolution, rowFingerprints: { primary: fingerprintRows(rows) } },
    )),
    enumerable: false,
    writable: false,
  })
  return result
}

// Execute a configured read against an already-loaded, already-approved registered system. Contract-level
// problems throw (route maps to 4xx); read-level outcomes ALWAYS return { evidence, data } — evidence
// values-free in the probe vocabulary, data null on any failure. `timeoutMs` is dependency injection for
// tests only; the platform constants are never request-reachable.
async function executeConfiguredRead(
  prepared,
  { system, createAdapter, timeoutMs = READ_SOURCE_PROBE_TIMEOUT_MS },
  trustedExecution,
) {
  const { plan: preparedPlan, fieldMap, config, inputs } = prepared
  const execution = normalizeTrustedExecution(preparedPlan, trustedExecution)
  const plan = execution.plan
  // Execution-time defense-in-depth — same re-guard as the S2-b probe: no adapter, no outbound path for
  // a readPath that lost the config-time guarantee.
  if (!isSafeRelativeReadPath(plan.readPath)) {
    return failureOutcome(plan, 'READ_SOURCE_PROBE_REJECTED', 'ReadSourceProbeRuntimeError')
  }
  if (!isPlainObject(system) || system.kind !== plan.requiredKind) {
    throw new ReadSourceProbeRuntimeError('kind_mismatch')
  }

  const adapterSystem = applyReadSmokePresetOverlay(system, buildReadSourceProbeOverlayPreset(plan))
  const adapter = createAdapter(adapterSystem)
  const request = buildExecutionRequest(plan, inputs, execution)

  const TIMEOUT = Symbol('read-source-configured-read-timeout')
  let timer
  const readPromise = Promise.resolve().then(() => adapter.read(request))
  let raced
  try {
    raced = await Promise.race([
      readPromise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), timeoutMs) }),
    ])
  } catch (error) {
    clearTimeout(timer)
    return failureOutcome(plan, classifyProbeErrorCode(error), typeof error?.name === 'string' ? error.name : 'Error')
  }
  clearTimeout(timer)
  if (raced === TIMEOUT) {
    // Not aborted (the adapter surface takes no signal); swallow the eventual settlement so a late
    // rejection cannot become an unhandled rejection.
    readPromise.catch(() => {})
    return failureOutcome(plan, 'READ_SOURCE_PROBE_TIMEOUT', 'TimeoutError', { timeoutReached: true })
  }

  const raw = raced && raced.raw

  // #3889: the adapter's record plane. `raw` is OPTIONAL here (data-source:sql-readonly never sets it),
  // and is used only for the caller's overflow diagnostics, never for the rows themselves.
  if (execution.rowSource === ADAPTER_RECORDS) {
    return executeFromAdapterRecords(plan, fieldMap, raced, request)
  }

  if (!isPlainObject(raw)) {
    return failureOutcome(plan, 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED', 'ReadSourceProbeRuntimeError')
  }

  // R2 (#1709): resolver_lookup BYPASSES the generic field-map data plane below. The R1 evaluator locates the
  // candidate container, applies the config's multiplicity rule (exactly_one / first_when_sorted /
  // field_equals — each with its own fail-closed detail), and returns { evidence, data } where data carries
  // ONLY the one resolver output target+value. STANDALONE: called directly here, that value is returned to
  // the caller with no further chaining. The composition path (C-R3, merged, read-source-composition-runtime.cjs)
  // orchestrates this executor per hop instead of calling it standalone.
  if (plan.mode === 'resolver_lookup') {
    const outcome = evaluateResolver(config, raw, { rowCap: plan.rowCap })
    // BL2: surface the by-material BOM-list failure in its OWN registered family (BL0 taxonomy) so a
    // second-hop list failure never reads as a generic resolver failure during standalone diagnosis.
    // Exact-key map, evidence rebuilt frozen; the ok/data planes and every other evidence key are
    // untouched (the family codes are registered in the probe error-code set, so this stays values-free
    // under the same safeErrorCode discipline).
    if (
      plan.object === K3WISE_BOM_LIST_BY_MATERIAL_PRESET.object
      && plan.requiredKind === K3WISE_BOM_LIST_BY_MATERIAL_PRESET.requiredKind
      && outcome.evidence.ok === false
    ) {
      const mapped = K3_WISE_BOM_LIST_BY_MATERIAL_RESOLVER_CODE_MAP[outcome.evidence.errorCode]
      if (mapped !== undefined) {
        return { ...outcome, evidence: Object.freeze({ ...outcome.evidence, errorCode: mapped }) }
      }
    }
    return outcome
  }

  const shapes = {}
  const dataContainers = {}
  const rawRowCounts = {}
  const fieldResolution = {}
  const rowFingerprints = {}
  let containerLocated = true
  let shapeOk = true
  let recordCount = 0
  let capReached = false
  for (const container of plan.containers) {
    const { located, value } = locateContainerValue(raw, container.paths)
    if (!located) {
      shapes[container.alias] = { type: 'missing', arrayLength: null }
      rawRowCounts[container.alias] = null
      containerLocated = false
      continue
    }
    shapes[container.alias] = classifyContainerShape(value)
    rawRowCounts[container.alias] = Array.isArray(value) ? value.length : null
    let rows
    if (Array.isArray(value)) {
      rows = value.slice(0, plan.rowCap)
      if (value.length >= plan.rowCap) capReached = true
      // Fail-closed: scalar/array entries inside a row container are a shape mismatch, not a row — mapping
      // them would fabricate all-null records under ok:true.
      if (!rows.every(isPlainObject)) {
        shapeOk = false
        continue
      }
    } else if (isPlainObject(value)) {
      rows = [value]
    } else {
      shapeOk = false
      continue
    }
    const records = rows.map((row) => mapRecord(row, fieldMap, fieldResolution))
    rowFingerprints[container.alias] = fingerprintRows(rows)
    recordCount += records.length
    dataContainers[container.alias] = { records }
  }

  if (!containerLocated) {
    return failureOutcome(plan, 'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND', 'ReadSourceProbeRuntimeError', {
      containers: shapes,
      containerLocated: false,
    })
  }
  if (!shapeOk) {
    return failureOutcome(plan, 'READ_SOURCE_PROBE_SHAPE_MISMATCH', 'ReadSourceProbeRuntimeError', {
      containers: shapes,
      containerLocated: true,
    })
  }

  const evidence = readSourceProbeEvidence(plan, {
    ok: true,
    containers: shapes,
    containerLocated: true,
    // A configured read IS a bounded, capped read — the data plane above is rowCap-bounded per container.
    boundedSmokeExecuted: true,
    timeoutReached: false,
    recordCount,
    capReached,
  })
  const result = {
    evidence,
    data: { containers: dataContainers, recordCount },
  }
  // Internal-only continuation metadata. Non-enumerable by construction so even an accidental whole-
  // outcome JSON response cannot expose totals/cursors; trusted backend feeders can still read it.
  Object.defineProperty(result, 'page', {
    value: Object.freeze(buildInternalPage(raced, request, recordCount, rawRowCounts, {
      fieldResolution,
      rowFingerprints,
    })),
    enumerable: false,
    writable: false,
  })
  return result
}

module.exports = {
  prepareConfiguredRead,
  executeConfiguredRead,
  __internals: {
    locateContainerValue,
    mapRecord,
    normalizeTrustedExecution,
    walkOwnPath,
    TRUSTED_EXECUTION_MAX_PAGE_INDEX,
    TRUSTED_EXECUTION_MAX_ROW_CAP,
  },
}
