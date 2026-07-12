'use strict'

// External-API read self-service S3-1 — config-driven read executor (data-plane field-map extraction).
// Mock adapter/system only — no real network, no persistence, no route, no write path.

const assert = require('node:assert/strict')
const path = require('node:path')

const { validateReadSourceConfig } = require(path.join(__dirname, '..', 'lib', 'read-source-config.cjs'))
const {
  ReadSourceProbeContractError,
} = require(path.join(__dirname, '..', 'lib', 'read-source-probe-contract.cjs'))
const probeRuntime = require(path.join(__dirname, '..', 'lib', 'read-source-probe-runtime.cjs'))
const {
  prepareConfiguredRead,
  executeConfiguredRead,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'read-source-read-runtime.cjs'))

const { ReadSourceProbeRuntimeError } = probeRuntime

function normalizedConfig(mode, overrides = {}) {
  const cfg = {
    version: 1,
    systemId: 'sys_1',
    requiredKind: 'erp:k3-wise-webapi',
    object: mode === 'detail_with_lines' ? 'material-bom' : 'material',
    mode,
    readPath: '/K3API/Material/GetDetail',
    readMethod: 'POST',
    operations: ['read'],
    fieldMap: [
      { source: 'FSigmaField', target: 'colGamma' },
      { source: 'FUnitRef.FDeltaCode', target: 'colDelta' },
      { source: 'FAbsentField', target: 'colAbsent' },
    ],
  }
  if (mode === 'single_record') {
    cfg.keyField = 'FNumber'
    cfg.containerPaths = ['Data']
  }
  if (mode === 'list_page') {
    cfg.readPath = '/K3API/Material/GetList'
    cfg.containerPaths = ['Data.Data', 'Data.DATA']
  }
  if (mode === 'detail_with_lines') {
    cfg.readPath = '/K3API/BOM/GetDetail'
    cfg.keyField = 'FBillNo'
    cfg.headerContainerPaths = ['Data.Page1']
    cfg.lineContainerPaths = ['Data.Page2']
  }
  if (mode === 'resolver_lookup') {
    cfg.keyField = 'FMaterialId'
    cfg.containerPaths = ['Data.Rows']
    // R2-supported resolver_lookup config shape; the executor now accepts this mode and threads the
    // normalized config into the R1 evaluator.
    cfg.resolverRule = 'exactly_one'
    cfg.fieldMap = [{ source: 'FItemID', target: 'item_id' }]
  }
  Object.assign(cfg, overrides)
  const result = validateReadSourceConfig(cfg)
  assert.equal(result.valid, true, `${mode} fixture must validate: ${JSON.stringify(result.errors)}`)
  return result.normalized
}

const STORED_SYSTEM = Object.freeze({
  id: 'sys_1',
  tenantId: 'tenant_1',
  kind: 'erp:k3-wise-webapi',
  role: 'target',
  credentials: Object.freeze({ bearerToken: 'secret-token' }),
  config: Object.freeze({
    baseUrl: 'https://k3host.internal',
    objects: Object.freeze({
      material: Object.freeze({ operations: Object.freeze(['upsert']), savePath: '/K3API/Material/Save' }),
    }),
  }),
})

function mockDeps({ read, system = STORED_SYSTEM } = {}) {
  const state = { adapterSystems: [], readArgs: [], writeCalls: [] }
  const deps = {
    system,
    createAdapter(adapterSystem) {
      state.adapterSystems.push(adapterSystem)
      return {
        async read(request) {
          state.readArgs.push(request)
          return read(request)
        },
        async upsert(input) { state.writeCalls.push(['upsert', input]); return {} },
        async save(input) { state.writeCalls.push(['save', input]); return {} },
      }
    },
  }
  return { deps, state }
}

// The separation invariant: these strings belong to the DATA plane (mapped values / fieldMap names /
// raw row content / supplied key) and must never appear in the values-free evidence.
const DATA_PLANE_SENTINELS = Object.freeze([
  'SIGMA-VALUE', 'DELTA-CODE', 'UNMAPPED-VALUE', 'FSigmaField', 'FDeltaCode', 'FAbsentField',
  'colGamma', 'colDelta', 'colAbsent', 'FUnwantedField', 'M-001', 'PBOM-001', 'k3host', 'secret-token',
])

function assertEvidenceValuesFree(evidence) {
  const text = JSON.stringify(evidence)
  for (const sentinel of DATA_PLANE_SENTINELS) {
    assert.ok(!text.includes(sentinel), `evidence must not leak ${sentinel}`)
  }
}

async function testPrepareFailClosed() {
  const config = normalizedConfig('single_record')
  // Strict body allowlist.
  assert.throws(
    () => prepareConfiguredRead({ config, inputs: { key: 'M-001' }, rawPath: '/etc/passwd' }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'unexpected_field',
  )
  assert.throws(
    () => prepareConfiguredRead('not-an-object'),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'not_object',
  )
  // Normalized-only: a merely-valid RAW config (untrimmed) is refused by the S2-a comparison.
  const raw = { ...config, systemId: ' sys_1 ', containerPaths: ['Data'], fieldMap: config.fieldMap.map((e) => ({ ...e })) }
  assert.throws(
    () => prepareConfiguredRead({ config: raw, inputs: { key: 'M-001' } }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'config_not_normalized',
  )
  // Data-plane rule: fieldMap is REQUIRED for a configured read (probe accepts its absence; this does not).
  const noFieldMap = normalizedConfig('single_record', { fieldMap: undefined })
  assert.equal(noFieldMap.fieldMap, undefined, 'fixture without fieldMap')
  assert.throws(
    () => prepareConfiguredRead({ config: noFieldMap, inputs: { key: 'M-001' } }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'field_map_required',
  )
  // Named-inputs discipline is the S2-b one (key required when keyField declared).
  assert.throws(
    () => prepareConfiguredRead({ config }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'key_required',
  )
  // R2 (#1709): resolver_lookup is now a SUPPORTED runtime mode (wired to the R1 evaluator) — prepare no
  // longer fail-closes it; the prepared object threads the normalized config for the evaluator.
  const resolverPrepared = prepareConfiguredRead({ config: normalizedConfig('resolver_lookup'), inputs: { key: 'M-001' } })
  assert.equal(resolverPrepared.plan.mode, 'resolver_lookup')
  assert.equal(resolverPrepared.config.resolverRule, 'exactly_one')
}

// R2 (#1709): resolver_lookup runs through the R1 evaluator — standalone, values-free, no write, no
// composition. The executor does the outbound keyed read and hands the raw response to evaluateResolver.
async function testResolverLookupRuntime() {
  const prepared = prepareConfiguredRead({ config: normalizedConfig('resolver_lookup'), inputs: { key: 'M-001' } })

  // exactly_one PASS: one candidate → resolved to the single output target+value.
  const one = mockDeps({
    read: (req) => ({
      records: [{}],
      raw: { Data: { Rows: [{ FItemID: 4242, FName: 'SIGMA-VALUE', FMaterialId: req.filters.FMaterialId }] } },
    }),
  })
  const ok = await executeConfiguredRead(prepared, one.deps)
  assert.equal(ok.evidence.ok, true)
  assert.equal(ok.evidence.rule, 'exactly_one')
  assert.equal(ok.evidence.resolved, true)
  assert.equal(ok.evidence.candidateCount, 1)
  // Data plane: ONLY the one resolver target+value — never a full row, container map, or downstream read.
  assert.deepEqual(ok.data, { resolver: { target: 'item_id', value: 4242 } })
  // No composition: the resolved value is not fed anywhere — exactly one outbound read, nothing chained.
  assert.equal(one.state.readArgs.length, 1)
  assert.deepEqual(one.state.readArgs[0], { object: 'material', filters: { FMaterialId: 'M-001' } })
  // No write: resolver is read-only.
  assert.equal(one.state.writeCalls.length, 0)
  // Values-free: the resolved value, candidate field names, and key never ride into evidence.
  const evText = JSON.stringify(ok.evidence)
  for (const leak of ['4242', 'FItemID', 'item_id', 'FMaterialId', 'SIGMA-VALUE', 'M-001']) {
    assert.ok(!evText.includes(leak), `resolver evidence must not leak ${leak}`)
  }

  // >1 candidate → AMBIGUOUS, data null (exactly_one keeps its own fail-closed detail, not silently first).
  const many = mockDeps({
    read: () => ({ records: [{}], raw: { Data: { Rows: [{ FItemID: 1 }, { FItemID: 2 }] } } }),
  })
  const amb = await executeConfiguredRead(prepared, many.deps)
  assert.equal(amb.evidence.ok, false)
  assert.equal(amb.evidence.errorCode, 'READ_SOURCE_RESOLVER_AMBIGUOUS')
  assert.equal(amb.evidence.ambiguous, true)
  assert.equal(amb.data, null)
  assert.equal(many.state.writeCalls.length, 0)

  // container missing → resolver coarse code, data null (no generic-mode leakage into resolver outcomes).
  const missing = mockDeps({ read: () => ({ records: [{}], raw: { Data: {} } }) })
  const miss = await executeConfiguredRead(prepared, missing.deps)
  assert.equal(miss.evidence.errorCode, 'READ_SOURCE_RESOLVER_CONTAINER_NOT_FOUND')
  assert.equal(miss.data, null)
}

async function testSingleRecordDataPlane() {
  const prepared = prepareConfiguredRead({ config: normalizedConfig('single_record'), inputs: { key: 'M-001' } })
  const { deps, state } = mockDeps({
    read: (req) => ({
      records: [{}],
      raw: {
        Data: {
          FSigmaField: 'SIGMA-VALUE',
          FUnitRef: { FDeltaCode: 'DELTA-CODE' },
          FUnwantedField: 'UNMAPPED-VALUE',
          FNumber: req.filters.FNumber,
        },
      },
    }),
  })
  const { evidence, data } = await executeConfiguredRead(prepared, deps)
  assert.equal(evidence.ok, true)
  assert.equal(evidence.containerLocated, true)
  assert.equal(evidence.boundedSmokeExecuted, true)
  assert.equal(evidence.recordCount, 1)
  assert.equal(evidence.capReached, false)
  assert.deepEqual(evidence.containers, { primary: { type: 'object', arrayLength: null } })
  // Exact data-plane projection: fieldMap targets ONLY; missing source → null; unmapped fields absent.
  assert.deepEqual(data, {
    containers: {
      primary: {
        records: [{ colGamma: 'SIGMA-VALUE', colDelta: 'DELTA-CODE', colAbsent: null }],
      },
    },
    recordCount: 1,
  })
  assertEvidenceValuesFree(evidence)
  // Same outbound discipline as the probe: keyed detail request, one read, no writes.
  assert.deepEqual(state.readArgs, [{ object: 'material', filters: { FNumber: 'M-001' } }])
  assert.equal(state.writeCalls.length, 0)
}

async function testListPageCapAndProjection() {
  const prepared = prepareConfiguredRead({ config: normalizedConfig('list_page') })
  const { deps, state } = mockDeps({
    read: () => ({
      records: [],
      raw: {
        Data: {
          Data: Array.from({ length: 12 }, (_, i) => ({ FSigmaField: `SIGMA-VALUE-${i}` })),
        },
      },
    }),
  })
  const { evidence, data } = await executeConfiguredRead(prepared, deps)
  assert.equal(evidence.ok, true)
  assert.deepEqual(evidence.containers, { primary: { type: 'array', arrayLength: 12 } })
  assert.equal(evidence.recordCount, 10, 'data plane is capped at the platform row cap')
  assert.equal(evidence.capReached, true)
  assert.equal(data.recordCount, 10)
  assert.equal(data.containers.primary.records.length, 10)
  assert.deepEqual(data.containers.primary.records[0], { colGamma: 'SIGMA-VALUE-0', colDelta: null, colAbsent: null })
  assertEvidenceValuesFree(evidence)
  assert.equal(state.readArgs[0].limit, 10)
  // No pageIndex input → no listPageIndex option (adapter default page 1, shipped behavior unchanged).
  assert.equal(state.readArgs[0].options.listPageIndex, undefined)
}

// Bounded LIST page input (#3703): list_page configured reads accept inputs.pageIndex (integer 1..10),
// which rides to the adapter as the dedicated listPageIndex option — the data plane itself is unchanged.
async function testListPageBoundedPageIndexInput() {
  const prepared = prepareConfiguredRead({ config: normalizedConfig('list_page'), inputs: { pageIndex: 3 } })
  const { deps, state } = mockDeps({
    read: () => ({ records: [], raw: { Data: { Data: [{ FSigmaField: 'SIGMA-VALUE-P3' }] } } }),
  })
  const { evidence, data } = await executeConfiguredRead(prepared, deps)
  assert.equal(evidence.ok, true)
  assert.equal(data.containers.primary.records.length, 1)
  assertEvidenceValuesFree(evidence)
  assert.equal(state.readArgs[0].options.listPageIndex, 3, 'bounded pageIndex reaches the adapter request option')
  assert.equal(state.readArgs[0].limit, 10, 'row cap unchanged by paging')

  // Bounds fail closed at input normalization — before any adapter/outbound.
  for (const badPage of [0, 11, -1, 1.5, '3', null, true, {}, [], Number.NaN]) {
    assert.throws(
      () => prepareConfiguredRead({ config: normalizedConfig('list_page'), inputs: { pageIndex: badPage } }),
      (error) => error instanceof ReadSourceProbeContractError && error.reason === 'page_index_invalid',
      `pageIndex ${JSON.stringify(badPage)} must fail closed`,
    )
  }
  // pageIndex on a non-list mode is rejected, never silently dropped.
  for (const mode of ['single_record', 'resolver_lookup']) {
    assert.throws(
      () => prepareConfiguredRead({ config: normalizedConfig(mode), inputs: { key: 'M-001', pageIndex: 2 } }),
      (error) => error instanceof ReadSourceProbeContractError && error.reason === 'page_index_not_allowed',
      `${mode} pageIndex must be rejected`,
    )
  }
  // keyField'd list_page: key + pageIndex compose.
  const keyed = prepareConfiguredRead({
    config: normalizedConfig('list_page', { keyField: 'FNumber' }),
    inputs: { key: 'M-001', pageIndex: 2 },
  })
  assert.deepEqual({ ...keyed.inputs }, { key: 'M-001', pageIndex: 2 })
}

async function testTrustedInternalPagingDoesNotWidenPublicDefaults() {
  const prepared = prepareConfiguredRead({ config: normalizedConfig('list_page') })
  const { deps, state } = mockDeps({
    read: (request) => ({
      records: Array.from({ length: request.limit }, () => ({})),
      raw: {
        Data: {
          Data: Array.from({ length: request.limit }, (_, i) => ({
            FSigmaField: `SIGMA-VALUE-${i}`,
          })),
          ROWCOUNT: 73,
          PAGEINDEX: request.options.listPageIndex,
        },
      },
      metadata: {
        returnedRecordCount: request.limit,
        dataRowCount: 73,
        dataPageIndex: request.options.listPageIndex,
      },
    }),
  })
  const outcome = await executeConfiguredRead(prepared, deps, { rowCap: 20, pageIndex: 4 })

  assert.equal(state.readArgs[0].limit, 20)
  assert.equal(state.readArgs[0].options.listPageIndex, 4)
  assert.equal(outcome.data.recordCount, 20)
  const { rowFingerprints, fieldResolution, ...pageCounts } = outcome.page
  // The tally is PROTOTYPE-FREE: a fieldMap target is operator-chosen and the validator accepts
  // `constructor` / `toString` / `valueOf`, so a plain {} would answer the lookup from Object.prototype and
  // report a field as resolved that resolved on no row at all.
  assert.equal(Object.getPrototypeOf(fieldResolution), null, 'the resolution tally must not inherit Object.prototype')
  assert.deepEqual({ ...fieldResolution }, { colGamma: 20 })
  assert.equal(fieldResolution.constructor, undefined, 'a prototype member name answers nothing')
  assert.deepEqual(pageCounts, {
    nextCursor: null,
    done: false,
    returnedRecordCount: 20,
    sourceTotalCount: 73,
    pageIndex: 4,
    // #3889 fix: the adapter-applied page bound (absent here) and the PRE-SLICE raw container length.
    effectiveLimit: null,
    rawRowCounts: { primary: 20 },
    // #3889 fix: the SOURCE's own page-index echo (never our requested value), plus two independent
    // witnesses of the page's row count — the adapter's records array and what its metadata claims.
    echoedPageIndex: 4,
    adapterRecordCount: 20,
    reportedRecordCount: 20,
  })
  // Page identity is computed from the rows the ADAPTER returned, never from the lossy fieldMap projection
  // of them (two pages differing only in an unmapped column are still two different pages).
  assert.match(rowFingerprints.primary, /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(outcome).includes('sourceTotalCount'), false, 'internal page metadata is non-enumerable')
  assertEvidenceValuesFree(outcome.evidence)
  assert.equal(JSON.stringify(outcome.evidence).includes('73'), false, 'source totals stay internal')
  assert.throws(
    () => __internals.normalizeTrustedExecution(prepared.plan, { rowCap: 1001 }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'execution_row_cap_invalid',
  )
  assert.throws(
    () => __internals.normalizeTrustedExecution(prepared.plan, { pageIndex: 11 }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'execution_page_index_invalid',
  )
  assert.deepEqual(
    __internals.normalizeTrustedExecution(prepared.plan, { cursor: 'offset:20' }).cursor,
    'offset:20',
    'trusted list execution may use cursor-based adapters',
  )
  assert.throws(
    () => __internals.normalizeTrustedExecution(prepared.plan, { cursor: 'offset:20', pageIndex: 2 }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'execution_pagination_conflict',
  )
  // The trusted-execution surface is a CLOSED allowlist: an unknown key is a rejected request, never a
  // silently ignored one (a typo'd `rowcap` must not quietly become the plan's default page).
  assert.throws(
    () => __internals.normalizeTrustedExecution(prepared.plan, { rowCap: 20, rowcap: 5000 }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'execution_options_unexpected_field',
  )
  assert.throws(
    () => __internals.normalizeTrustedExecution(prepared.plan, { rowSource: 'raw' }),
    (error) => error instanceof ReadSourceProbeContractError && error.reason === 'execution_row_source_invalid',
  )

  const keyed = prepareConfiguredRead({
    config: normalizedConfig('single_record'),
    inputs: { key: 'M-001' },
  })
  const cursorDeps = mockDeps({
    read: (request) => ({
      records: [{}],
      nextCursor: 'offset:20',
      done: false,
      raw: { Data: { FSigmaField: 'SIGMA-VALUE' } },
      metadata: { count: 1 },
    }),
  })
  const cursorOutcome = await executeConfiguredRead(keyed, cursorDeps.deps, {
    rowCap: 20,
    cursor: 'offset:10',
  })
  assert.equal(cursorDeps.state.readArgs[0].cursor, 'offset:10')
  // #3889 fix: a keyed (single_record) execution that NAMES a rowCap must send it. The probe builder only
  // sets `limit` on the list dialects, so this request used to reach the adapter with no limit at all and
  // the adapter fell back to its own default (Bridge: sampleLimit=3) — a page bound the source never saw.
  assert.equal(cursorDeps.state.readArgs[0].limit, 20, 'trusted rowCap reaches a non-list adapter request')
  assert.equal(cursorOutcome.page.nextCursor, 'offset:20')
  assert.equal(cursorOutcome.page.sourceTotalCount, null, 'per-page metadata.count is not a source total')
  assert.equal(JSON.stringify(cursorOutcome.evidence).includes('offset:'), false)
}

// #3889 fix: the executor slices each raw container to plan.rowCap. `page.rawRowCounts` is the ONLY
// signal that distinguishes "the source had exactly rowCap rows" from "the source had more and we
// truncated it" — both leave exactly rowCap mapped records behind. A feeder that cannot tell those apart
// reports a truncated snapshot as complete.
async function testInternalPageReportsPreSliceRawRowCountsAndAppliedLimit() {
  const prepared = prepareConfiguredRead({ config: normalizedConfig('list_page') })
  const { deps } = mockDeps({
    read: () => ({
      records: [],
      raw: { Data: { Data: Array.from({ length: 37 }, (_, i) => ({ FSigmaField: `SIGMA-${i}` })) } },
      // A clamping adapter (Bridge) reports the limit it ACTUALLY applied, not the one we asked for.
      metadata: { limit: 20 },
    }),
  })
  const outcome = await executeConfiguredRead(prepared, deps, { rowCap: 20 })
  assert.equal(outcome.data.recordCount, 20, 'mapped records are still rowCap-bounded')

  // The RECORD plane's internal page must be non-enumerable too — the raw plane's twin is asserted below,
  // and this is the plane the stock-preparation feeder actually eats. Its `page` carries source totals,
  // cursors, per-field resolution counts and row fingerprints: an accidental whole-outcome JSON response
  // must not be able to serialize any of it.
  const recordPlane = await executeConfiguredRead(prepared, deps, { rowCap: 20, rowSource: 'adapter_records' })
  assert.deepEqual(Object.keys(recordPlane), ['evidence', 'data'], 'the record-plane page is not an own enumerable key')
  const recordPlaneJson = JSON.stringify(recordPlane)
  for (const internal of ['rowFingerprints', 'fieldResolution', 'sourceTotalCount', 'nextCursor', 'adapterRecordCount']) {
    assert.ok(!recordPlaneJson.includes(internal), `record-plane page metadata must stay internal: ${internal}`)
  }
  assert.equal(recordPlane.page.rawRowCounts.primary, 37, 'the trusted caller can still read it')
  assert.equal(outcome.page.rawRowCounts.primary, 37, 'raw container length survives the rowCap slice')
  assert.equal(outcome.page.effectiveLimit, 20, 'the adapter-applied page bound is surfaced')
  assert.equal(outcome.evidence.capReached, true)
  assertEvidenceValuesFree(outcome.evidence)
}

async function testDetailWithLinesBothContainersMapped() {
  const prepared = prepareConfiguredRead({ config: normalizedConfig('detail_with_lines'), inputs: { key: 'PBOM-001' } })
  const { deps } = mockDeps({
    read: () => ({
      records: [],
      raw: {
        Data: {
          Page1: [{ FSigmaField: 'SIGMA-VALUE' }],
          Page2: [{ FUnitRef: { FDeltaCode: 'DELTA-CODE' } }, { FSigmaField: 'SIGMA-VALUE-L2' }],
        },
      },
    }),
  })
  const { evidence, data } = await executeConfiguredRead(prepared, deps)
  assert.equal(evidence.ok, true)
  assert.deepEqual(evidence.containers, {
    header: { type: 'array', arrayLength: 1 },
    lines: { type: 'array', arrayLength: 2 },
  })
  assert.equal(evidence.recordCount, 3, 'total mapped records across containers')
  assert.deepEqual(data.containers.header.records, [{ colGamma: 'SIGMA-VALUE', colDelta: null, colAbsent: null }])
  assert.deepEqual(data.containers.lines.records, [
    { colGamma: null, colDelta: 'DELTA-CODE', colAbsent: null },
    { colGamma: 'SIGMA-VALUE-L2', colDelta: null, colAbsent: null },
  ])
  assert.equal(data.recordCount, 3)
  assertEvidenceValuesFree(evidence)
}

async function testContainerMissingAndShapeMismatch() {
  const prepared = prepareConfiguredRead({ config: normalizedConfig('detail_with_lines'), inputs: { key: 'PBOM-001' } })
  const missing = mockDeps({ read: () => ({ records: [], raw: { Data: { Page1: [{}] } } }) })
  const missingOutcome = await executeConfiguredRead(prepared, missing.deps)
  assert.equal(missingOutcome.evidence.ok, false)
  assert.equal(missingOutcome.evidence.errorCode, 'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND')
  assert.equal(missingOutcome.evidence.containerLocated, false)
  assert.equal(missingOutcome.data, null, 'no data plane on container miss')

  const single = prepareConfiguredRead({ config: normalizedConfig('single_record'), inputs: { key: 'M-001' } })
  const scalar = mockDeps({ read: () => ({ records: [], raw: { Data: 'scalar SIGMA-VALUE here' } }) })
  const scalarOutcome = await executeConfiguredRead(single, scalar.deps)
  assert.equal(scalarOutcome.evidence.ok, false)
  assert.equal(scalarOutcome.evidence.errorCode, 'READ_SOURCE_PROBE_SHAPE_MISMATCH')
  assert.equal(scalarOutcome.data, null, 'no data plane on shape mismatch')
  assertEvidenceValuesFree(scalarOutcome.evidence)

  const noRaw = mockDeps({ read: () => ({ records: [{}] }) })
  const noRawOutcome = await executeConfiguredRead(single, noRaw.deps)
  assert.equal(noRawOutcome.evidence.errorCode, 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED')
  assert.equal(noRawOutcome.data, null)

  // Scalar/array entries INSIDE a row container are a shape mismatch, not rows — mapping them would
  // fabricate all-null records under ok:true.
  const list = prepareConfiguredRead({ config: normalizedConfig('list_page') })
  const scalarRows = mockDeps({ read: () => ({ records: [], raw: { Data: { Data: ['error SIGMA-VALUE', 42] } } }) })
  const scalarRowsOutcome = await executeConfiguredRead(list, scalarRows.deps)
  assert.equal(scalarRowsOutcome.evidence.ok, false)
  assert.equal(scalarRowsOutcome.evidence.errorCode, 'READ_SOURCE_PROBE_SHAPE_MISMATCH')
  assert.equal(scalarRowsOutcome.data, null, 'no fabricated all-null records from scalar rows')
  assertEvidenceValuesFree(scalarRowsOutcome.evidence)
}

async function testAdapterErrorsAreCoarseWithNullData() {
  const prepared = prepareConfiguredRead({ config: normalizedConfig('single_record'), inputs: { key: 'M-001' } })
  const cases = [
    [Object.assign(new Error('401 at https://k3host for M-001'), { name: 'K3WiseWebApiAdapterError', status: 401 }), 'READ_SOURCE_PROBE_AUTH_FAILED'],
    [Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' }), 'READ_SOURCE_PROBE_NETWORK_FAILED'],
    [Object.assign(new Error('business failed'), { name: 'K3WiseWebApiAdapterError', details: { code: 'K3_WISE_READ_BUSINESS_ERROR' } }), 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED'],
  ]
  for (const [error, expectedCode] of cases) {
    const { deps } = mockDeps({ read: () => { throw error } })
    const outcome = await executeConfiguredRead(prepared, deps)
    assert.equal(outcome.evidence.ok, false)
    assert.equal(outcome.evidence.errorCode, expectedCode)
    assert.equal(outcome.data, null)
    assertEvidenceValuesFree(outcome.evidence)
  }
}

async function testTimeoutInjectableAndPathReGuard() {
  const prepared = prepareConfiguredRead({ config: normalizedConfig('single_record'), inputs: { key: 'M-001' } })
  const hang = mockDeps({ read: () => new Promise(() => {}) })
  const timedOut = await executeConfiguredRead(prepared, { ...hang.deps, timeoutMs: 20 })
  assert.equal(timedOut.evidence.errorCode, 'READ_SOURCE_PROBE_TIMEOUT')
  assert.equal(timedOut.evidence.timeoutReached, true)
  assert.equal(timedOut.data, null)

  // Tampered plan (frozen plans cannot be edited; rebuild an unfrozen copy) → refused before any adapter.
  let adapterCreated = false
  for (const readPath of ['https://evil.example.com/x', '//evil.example.com/x', '/a/../admin', '/a/%2e%2e/admin']) {
    const outcome = await executeConfiguredRead(
      { plan: { ...prepared.plan, readPath }, fieldMap: prepared.fieldMap, inputs: prepared.inputs },
      { system: STORED_SYSTEM, createAdapter() { adapterCreated = true; throw new Error('must not be reached') } },
    )
    assert.equal(outcome.evidence.errorCode, 'READ_SOURCE_PROBE_REJECTED', `re-guard must reject ${JSON.stringify(readPath)}`)
    assert.equal(outcome.data, null)
  }
  assert.equal(adapterCreated, false, 'no adapter exists for a rejected readPath')

  await assert.rejects(
    () => executeConfiguredRead(prepared, {
      system: { ...STORED_SYSTEM, kind: 'generic:http' },
      createAdapter() { throw new Error('must not be reached') },
    }),
    (error) => error instanceof ReadSourceProbeRuntimeError && error.reason === 'kind_mismatch',
  )
}

// The projection is a sequence of writes. An entry that resolves NOWHERE must not erase a value another
// entry already read — that is data loss, not a sparse column — and the resolution tally must be derived
// from the row we actually EMIT, so it can never certify a column the row does not carry. (Duplicate targets
// are rejected by the config validator now; this keeps the projection itself honest regardless.)
function testMappingNeverErasesAResolvedValueAndTalliesWhatItEmits() {
  const duplicateTarget = [
    { source: 'quantity', target: 'designQty' }, // resolves
    { source: 'qty', target: 'designQty' },      // does not resolve
  ]
  const counts = {}
  assert.deepEqual(
    __internals.mapRecord({ quantity: 1 }, duplicateTarget, counts),
    { designQty: 1 },
    'an unresolved entry must not overwrite a value another entry read',
  )
  assert.deepEqual(counts, { designQty: 1 }, 'the tally matches the value actually emitted')

  const swappedCounts = {}
  assert.deepEqual(
    __internals.mapRecord({ quantity: 1 }, [duplicateTarget[1], duplicateTarget[0]], swappedCounts),
    { designQty: 1 },
    'and the result does not depend on the order the entries happen to be written in',
  )
  assert.deepEqual(swappedCounts, { designQty: 1 })

  // Resolved on NO entry -> null, and NOT tallied: the guard downstream must see a zero here.
  const missingCounts = {}
  assert.deepEqual(__internals.mapRecord({}, duplicateTarget, missingCounts), { designQty: null })
  assert.deepEqual(missingCounts, {}, 'a column no entry resolved is never certified as present')

  // An EXPLICIT null in the source is resolved: a present-but-empty column is a faithful representation.
  const nullCounts = {}
  assert.deepEqual(
    __internals.mapRecord({ quantity: null }, [duplicateTarget[0]], nullCounts),
    { designQty: null },
  )
  assert.deepEqual(nullCounts, { designQty: 1 })
}

async function main() {
  testMappingNeverErasesAResolvedValueAndTalliesWhatItEmits()
  await testPrepareFailClosed()
  await testResolverLookupRuntime()
  await testSingleRecordDataPlane()
  await testListPageCapAndProjection()
  await testListPageBoundedPageIndexInput()
  await testTrustedInternalPagingDoesNotWidenPublicDefaults()
  await testInternalPageReportsPreSliceRawRowCountsAndAppliedLimit()
  await testDetailWithLinesBothContainersMapped()
  await testContainerMissingAndShapeMismatch()
  await testAdapterErrorsAreCoarseWithNullData()
  await testTimeoutInjectableAndPathReGuard()

  // Promoted S2-b exports are the SAME functions as their __internals aliases (single source of truth).
  assert.equal(probeRuntime.buildReadSourceProbeOverlayPreset, probeRuntime.__internals.buildReadSourceProbeOverlayPreset)
  assert.equal(probeRuntime.buildReadSourceProbeRequest, probeRuntime.__internals.buildReadSourceProbeRequest)
  assert.equal(probeRuntime.classifyProbeErrorCode, probeRuntime.__internals.classifyProbeErrorCode)
  assert.equal(probeRuntime.normalizeReadSourceProbeInputs, probeRuntime.__internals.normalizeReadSourceProbeInputs)

  // Value-walk internals: own-property only, prototype keys never resolve.
  assert.deepEqual(__internals.walkOwnPath({ a: { b: 7 } }, 'a.b'), { resolved: true, value: 7 })
  assert.deepEqual(__internals.walkOwnPath({ a: {} }, 'a.constructor'), { resolved: false, value: null })
  assert.deepEqual(__internals.mapRecord({ x: 1 }, [{ source: 'x', target: 'y' }]), { y: 1 })

  console.log('read-source-read-runtime.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
