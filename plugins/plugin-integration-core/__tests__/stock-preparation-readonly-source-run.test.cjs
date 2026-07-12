'use strict'

// #3889: approved readonly sources feed the existing pure intake contract. The core keeps normalized
// rows as an internal data plane; the public projector returns only values-free shape evidence.

const assert = require('node:assert/strict')
const path = require('node:path')

const { validateReadSourceConfig } = require(path.join(__dirname, '..', 'lib', 'read-source-config.cjs'))
const { prepareConfiguredRead } = require(path.join(__dirname, '..', 'lib', 'read-source-read-runtime.cjs'))
const {
  publicReadonlySourceRunResult,
  K3_WEBAPI_SOURCE_PAGE_SIZE,
  SOURCE_MAX_PAGES,
  SOURCE_PAGE_SIZE,
  StockPreparationReadonlySourceRunError,
  runErpMaterialReadonlySource,
  runPlmBomReadonlySource,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-readonly-source-run.cjs'))
// The completeness rules are only worth anything against the adapters we actually ship, so the paging
// proofs below drive the REAL Bridge Agent adapter and the REAL Yuantus PLM wrapper — a hand-written mock
// would have happily agreed with whatever the feeder assumed.
const {
  createBridgeAgentReadonlyAdapter,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'bridge-agent-readonly-adapter.cjs'))
const {
  createYuantusPlmWrapperAdapter,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'plm-yuantus-wrapper.cjs'))

const SECRET = 'RAW_SOURCE_SECRET_3889'

function preparedRead(requiredKind, fieldMap) {
  const validation = validateReadSourceConfig({
    version: 1,
    systemId: 'private_system_reference_3889',
    requiredKind,
    object: 'stock-preparation-source',
    mode: 'list_page',
    readPath: '/readonly/stock-preparation',
    readMethod: 'POST',
    operations: ['read'],
    containerPaths: ['Rows'],
    fieldMap,
  })
  assert.equal(validation.valid, true, JSON.stringify(validation.errors))
  return prepareConfiguredRead({ config: validation.normalized })
}

function sourceRuntime(kind, read) {
  const reads = []
  const writes = []
  return {
    reads,
    writes,
    system: {
      id: 'private_runtime_system_3889',
      kind,
      credentials: { password: `credential_${SECRET}` },
      config: {},
    },
    createAdapter() {
      return {
        async read(request) {
          reads.push(request)
          return read(request)
        },
        async upsert(input) { writes.push(['upsert', input]) },
        async save(input) { writes.push(['save', input]) },
        async submit(input) { writes.push(['submit', input]) },
        async audit(input) { writes.push(['audit', input]) },
      }
    },
  }
}

function assertValuesFree(value) {
  const serialized = JSON.stringify(value)
  for (const forbidden of [
    SECRET,
    'private_system_reference_3889',
    'private_runtime_system_3889',
    'PLM-DRAWING-SECRET',
    'ERP-MATERIAL-SECRET',
    'SOURCE-PROJECT-SECRET',
  ]) {
    assert.ok(!serialized.includes(forbidden), `public evidence must not expose ${forbidden}`)
  }
}

async function testPlmFeedsPureIntakeAcrossCursorPages() {
  const runtime = sourceRuntime('plm:yuantus-wrapper', (request) => {
    const secondPage = request.cursor === 'offset:1'
    return {
      records: [{}],
      nextCursor: secondPage ? null : 'offset:1',
      done: secondPage,
      raw: {
        Rows: [secondPage
          ? { path: '/root/part-2', childCode: 'PART-2', quantity: 3, unit: 'pcs' }
          : { path: '/root/part-1', childCode: 'PLM-DRAWING-SECRET', quantity: 2, unit: SECRET }],
      },
    }
  })
  const result = await runPlmBomReadonlySource({
    permission: 'admin',
    projectId: 'business_project_1',
    sourceProjectNo: 'SOURCE-PROJECT-SECRET',
    projectName: `Project ${SECRET}`,
    syncRunId: 'plm_source_run_1',
    snapshotBatchId: 'plm_snapshot_1',
    snapshotVersion: 1,
    actor: 'operator_1',
    preparedRead: preparedRead('plm:yuantus-wrapper', [
      { source: 'path', target: 'pathKey' },
      { source: 'childCode', target: 'childDrawingNo' },
      { source: 'quantity', target: 'designQty' },
      { source: 'unit', target: 'designUnit' },
    ]),
    ...runtime,
  })

  assert.equal(result.sourceRun, 'plm_bom')
  assert.equal(result.status, 'ready')
  assert.equal(result.mode, 'dry_run')
  assert.equal(result.evidence.sourceRows, 2)
  assert.equal(result.evidence.pages, 2)
  assert.equal(result.evidence.intake.result.projectRows, 1)
  assert.equal(result.evidence.intake.result.bomSnapshotBatches, 1)
  assert.equal(result.evidence.intake.result.bomSnapshotLines, 2)
  assert.equal(result.evidence.intake.result.rowErrors, 0)
  assert.equal(result.evidence.internalWriteExecuted, false)
  assert.equal(result.evidence.externalWriteExecuted, false)
  assert.equal(result.evidence.productionWrite, false)
  assert.equal(result.evidence.k3SaveSubmitAudit, false)
  assert.equal(result.evidence.rawSql, false)
  assert.equal(result.evidence.sourcePayloadRowsInEvidence, false)
  assert.equal(result.evidence.privateConfigIdInEvidence, false)
  assert.equal(result.evidence.credentialsInEvidence, false)
  assert.equal(result.evidence.rawPayloadReturned, false)
  assert.equal(result.intake.projects.length, 1)
  assert.equal(result.intake.bomSnapshotBatches.length, 1)
  assert.equal(result.intake.bomSnapshotLines.length, 2)
  assert.equal(result.intake.bomSnapshotLines[0].childDrawingNo, 'PLM-DRAWING-SECRET')
  assert.equal(runtime.reads.length, 2)
  assert.equal(runtime.reads[0].limit, SOURCE_PAGE_SIZE)
  assert.equal(runtime.reads[1].cursor, 'offset:1')
  assert.equal(runtime.writes.length, 0)
  // Completeness is PROVEN, and the evidence says how: the last page came back short of the bound the
  // adapter applied. `sourceTotalKnown` reflects reality (this source declared no total) instead of
  // being computed and thrown away.
  assert.equal(result.evidence.completenessProof, 'short_page')
  assert.equal(result.evidence.sourceTotalKnown, false)
  assert.equal(result.evidence.sourcePageSizeRequested, SOURCE_PAGE_SIZE)
  assert.equal(result.evidence.sourcePageSizeEffective, SOURCE_PAGE_SIZE)
  assert.equal(result.evidence.sourceRowsTruncated, false)
  const publicResult = publicReadonlySourceRunResult(result)
  assert.equal(Object.prototype.hasOwnProperty.call(publicResult, 'intake'), false)
  assertValuesFree(publicResult)
}

async function testErpK3FeedsMaterialCacheShape() {
  const runtime = sourceRuntime('erp:k3-wise-webapi', (request) => {
    const pageIndex = request.options.listPageIndex
    const start = (pageIndex - 1) * 10
    const pageCount = pageIndex === 1 ? 10 : 2
    const rows = Array.from({ length: pageCount }, (_, index) => ({
      FItemID: String(1001 + start + index),
      FNumber: start + index === 0 ? 'ERP-MATERIAL-SECRET' : `MAT-${start + index + 1}`,
      FName: start + index === 0 ? `Material ${SECRET}` : `Material ${start + index + 1}`,
    }))
    return {
      records: rows.map(() => ({})),
      raw: { Rows: rows },
      done: true,
      metadata: { dataRowCount: 12, dataPageIndex: pageIndex },
    }
  })
  const result = await runErpMaterialReadonlySource({
    permission: 'admin',
    syncRunId: 'erp_source_run_1',
    actor: 'operator_1',
    preparedRead: preparedRead('erp:k3-wise-webapi', [
      { source: 'FItemID', target: 'erpMaterialInternalId' },
      { source: 'FNumber', target: 'erpMaterialCode' },
      { source: 'FName', target: 'erpMaterialName' },
    ]),
    ...runtime,
  })

  assert.equal(result.sourceRun, 'erp_material')
  assert.equal(result.status, 'ready')
  assert.equal(result.evidence.intake.result.erpMaterialRows, 12)
  assert.equal(result.evidence.intake.result.rowErrors, 0)
  assert.equal(runtime.reads.length, 2)
  assert.equal(runtime.reads[0].limit, 10, 'K3 retains its existing page-size guard')
  assert.equal(runtime.reads[0].options.listPageIndex, 1)
  assert.equal(runtime.reads[1].options.listPageIndex, 2)
  assert.equal(runtime.writes.length, 0)
  assert.equal(result.intake.erpMaterials.length, 12)
  assert.equal(result.intake.erpMaterials[0].erpMaterialCode, 'ERP-MATERIAL-SECRET')
  const publicResult = publicReadonlySourceRunResult(result)
  assert.equal(Object.prototype.hasOwnProperty.call(publicResult, 'intake'), false)
  assertValuesFree(publicResult)
}

async function testMissingRequiredMappingFailsClosed() {
  const runtime = sourceRuntime('erp:k3-wise-webapi', () => ({
    records: [{}],
    raw: { Rows: [{ FNumber: 'ERP-MATERIAL-SECRET', FName: `Material ${SECRET}` }] },
  }))

  await assert.rejects(
    () => runErpMaterialReadonlySource({
      permission: 'admin',
      syncRunId: 'erp_source_run_bad_shape',
      preparedRead: preparedRead('erp:k3-wise-webapi', [
        { source: 'FNumber', target: 'erpMaterialCode' },
        { source: 'FName', target: 'erpMaterialName' },
      ]),
      ...runtime,
    }),
    (error) => {
      assert.ok(error instanceof StockPreparationReadonlySourceRunError)
      assert.equal(error.code, 'SOURCE_RUN_REQUIRED_SHAPE_MISSING')
      assert.equal(error.details.rowErrors, 1)
      assert.deepEqual(error.details.byRowErrorType, { missing_material_internal_id: 1 })
      assertValuesFree(error)
      return true
    },
  )
  assert.equal(runtime.writes.length, 0)
}

async function testBridgeAndConfiguredDataSourceKindsFeedTheSameContract() {
  const bridge = sourceRuntime('bridge:legacy-sql-readonly', () => ({
    records: [{}],
    raw: { Rows: [{ path: '/root/bridge-part', childCode: 'BRIDGE-PART', quantity: 1 }] },
    done: true,
  }))
  const plm = await runPlmBomReadonlySource({
    permission: 'admin',
    projectId: 'business_project_bridge',
    sourceProjectNo: 'bridge_project',
    syncRunId: 'bridge_source_run_1',
    snapshotBatchId: 'bridge_snapshot_1',
    snapshotVersion: 1,
    preparedRead: preparedRead('bridge:legacy-sql-readonly', [
      { source: 'path', target: 'pathKey' },
      { source: 'childCode', target: 'childDrawingNo' },
      { source: 'quantity', target: 'designQty' },
    ]),
    ...bridge,
  })
  assert.equal(plm.evidence.sourceChannel, 'bridge_agent')
  assert.equal(plm.evidence.intake.result.bomSnapshotLines, 1)
  assert.equal(bridge.writes.length, 0)

  const dataSource = sourceRuntime('data-source:sql-readonly', () => ({
    records: [{}],
    raw: { Rows: [{ id: 'material_internal_1', code: 'MAT-DS-1' }] },
    done: true,
  }))
  const erp = await runErpMaterialReadonlySource({
    permission: 'admin',
    syncRunId: 'data_source_run_1',
    preparedRead: preparedRead('data-source:sql-readonly', [
      { source: 'id', target: 'erpMaterialInternalId' },
      { source: 'code', target: 'erpMaterialCode' },
    ]),
    ...dataSource,
  })
  assert.equal(erp.evidence.sourceChannel, 'data_source')
  assert.equal(erp.evidence.intake.result.erpMaterialRows, 1)
  assert.equal(dataSource.writes.length, 0)
}

async function testSourceRuntimeErrorsAreCoarse() {
  const runtime = sourceRuntime('erp:k3-wise-webapi', () => {
    throw new Error(`connection failed password=${SECRET}`)
  })
  await assert.rejects(
    () => runErpMaterialReadonlySource({
      permission: 'admin',
      syncRunId: 'erp_source_run_runtime_failure',
      preparedRead: preparedRead('erp:k3-wise-webapi', [
        { source: 'FItemID', target: 'erpMaterialInternalId' },
        { source: 'FNumber', target: 'erpMaterialCode' },
      ]),
      ...runtime,
    }),
    (error) => {
      assert.ok(error instanceof StockPreparationReadonlySourceRunError)
      assert.equal(error.code, 'SOURCE_RUN_READ_FAILED')
      assert.deepEqual(error.details, { errorCode: 'READ_SOURCE_PROBE_FAILED', errorType: 'Error' })
      assertValuesFree(error)
      return true
    },
  )
  assert.equal(runtime.writes.length, 0)
}

async function testDeclaredTotalCannotEndEarly() {
  const runtime = sourceRuntime('plm:yuantus-wrapper', () => ({
    records: [{}],
    raw: { Rows: [{ path: '/root/part-1', childCode: 'PART-1', quantity: 1 }] },
    done: true,
    metadata: { totalCount: 2 },
  }))
  await assert.rejects(
    () => runPlmBomReadonlySource({
      permission: 'admin',
      projectId: 'business_project_incomplete',
      sourceProjectNo: 'project_incomplete',
      syncRunId: 'plm_source_run_incomplete',
      snapshotBatchId: 'snapshot_incomplete',
      snapshotVersion: 1,
      preparedRead: preparedRead('plm:yuantus-wrapper', [
        { source: 'path', target: 'pathKey' },
        { source: 'childCode', target: 'childDrawingNo' },
        { source: 'quantity', target: 'designQty' },
      ]),
      ...runtime,
    }),
    (error) => error instanceof StockPreparationReadonlySourceRunError
      && error.code === 'SOURCE_RUN_PAGINATION_INCOMPLETE'
      && error.details.receivedRows === 1
      && error.details.sourceTotal === 2,
  )
  assert.equal(runtime.writes.length, 0)
}

async function testDeclaredTotalMustRemainStableAcrossPages() {
  let page = 0
  const runtime = sourceRuntime('plm:yuantus-wrapper', () => {
    page += 1
    return {
      records: [{}],
      raw: { Rows: [{ path: `/root/part-${page}`, childCode: `PART-${page}`, quantity: 1 }] },
      nextCursor: page === 1 ? 'offset:1' : null,
      done: page > 1,
      metadata: { totalCount: page === 1 ? 2 : 3 },
    }
  })
  await assert.rejects(
    () => runPlmBomReadonlySource({
      permission: 'admin',
      projectId: 'business_project_changed_total',
      sourceProjectNo: 'project_changed_total',
      syncRunId: 'plm_source_run_changed_total',
      snapshotBatchId: 'snapshot_changed_total',
      snapshotVersion: 1,
      preparedRead: preparedRead('plm:yuantus-wrapper', [
        { source: 'path', target: 'pathKey' },
        { source: 'childCode', target: 'childDrawingNo' },
        { source: 'quantity', target: 'designQty' },
      ]),
      ...runtime,
    }),
    (error) => error instanceof StockPreparationReadonlySourceRunError
      && error.code === 'SOURCE_RUN_PAGINATION_INCONSISTENT'
      && error.details.previousSourceTotal === 2
      && error.details.sourceTotal === 3,
  )
  assert.equal(runtime.writes.length, 0)
}

async function testDeclaredTotalRemainsBindingWhenLaterPageOmitsIt() {
  let page = 0
  const runtime = sourceRuntime('plm:yuantus-wrapper', () => {
    page += 1
    return {
      records: [{}],
      raw: { Rows: [{ path: `/root/part-${page}`, childCode: `PART-${page}`, quantity: 1 }] },
      nextCursor: page === 1 ? 'offset:1' : null,
      done: page > 1,
      metadata: page === 1 ? { totalCount: 3 } : {},
    }
  })
  await assert.rejects(
    () => runPlmBomReadonlySource({
      permission: 'admin',
      projectId: 'business_project_missing_total',
      sourceProjectNo: 'project_missing_total',
      syncRunId: 'plm_source_run_missing_total',
      snapshotBatchId: 'snapshot_missing_total',
      snapshotVersion: 1,
      preparedRead: preparedRead('plm:yuantus-wrapper', [
        { source: 'path', target: 'pathKey' },
        { source: 'childCode', target: 'childDrawingNo' },
        { source: 'quantity', target: 'designQty' },
      ]),
      ...runtime,
    }),
    (error) => error instanceof StockPreparationReadonlySourceRunError
      && error.code === 'SOURCE_RUN_PAGINATION_INCOMPLETE'
      && error.details.receivedRows === 2
      && error.details.sourceTotal === 3,
  )
  assert.equal(runtime.writes.length, 0)
}

async function testUnknownTotalCannotEndOnAnAmbiguousFullPage() {
  const rows = Array.from({ length: SOURCE_PAGE_SIZE }, (_, index) => ({
    id: `material_internal_${index}`,
    code: `MAT-${index}`,
  }))
  const runtime = sourceRuntime('data-source:sql-readonly', () => ({
    records: rows.map(() => ({})),
    raw: { Rows: rows },
    done: true,
  }))
  await assert.rejects(
    () => runErpMaterialReadonlySource({
      permission: 'admin',
      syncRunId: 'data_source_ambiguous_full_page',
      preparedRead: preparedRead('data-source:sql-readonly', [
        { source: 'id', target: 'erpMaterialInternalId' },
        { source: 'code', target: 'erpMaterialCode' },
      ]),
      ...runtime,
    }),
    // `done: true` on a page that exactly fills the applied bound proves nothing — and is precisely what a
    // clamping source reports. No total, no cursor, no proof: fail closed.
    (error) => error instanceof StockPreparationReadonlySourceRunError
      && error.code === 'SOURCE_RUN_COMPLETENESS_UNPROVABLE'
      && error.details.receivedRows === SOURCE_PAGE_SIZE
      && error.details.cursorReturned === false,
  )
  assert.equal(runtime.writes.length, 0)
}

async function testSnapshotVersionRejectsNonIntegerJsonTypesBeforeRead() {
  const runtime = sourceRuntime('plm:yuantus-wrapper', () => {
    throw new Error('adapter must not run')
  })
  for (const snapshotVersion of [true, false, 0, -1, 1.5, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      () => runPlmBomReadonlySource({
        permission: 'admin',
        projectId: 'business_project_bad_version',
        sourceProjectNo: 'project_bad_version',
        syncRunId: 'plm_source_run_bad_version',
        snapshotBatchId: 'snapshot_bad_version',
        snapshotVersion,
        preparedRead: preparedRead('plm:yuantus-wrapper', [
          { source: 'path', target: 'pathKey' },
          { source: 'childCode', target: 'childDrawingNo' },
          { source: 'quantity', target: 'designQty' },
        ]),
        ...runtime,
      }),
      (error) => error instanceof StockPreparationReadonlySourceRunError
        && error.code === 'SOURCE_RUN_CONFIG_INVALID'
        && error.details.field === 'snapshotVersion',
    )
  }
  assert.equal(runtime.reads.length, 0)
  assert.equal(runtime.writes.length, 0)
}

async function testDisallowedKindFailsBeforeAdapter() {
  const runtime = sourceRuntime('http', () => {
    throw new Error('adapter must not run')
  })
  await assert.rejects(
    () => runErpMaterialReadonlySource({
      permission: 'admin',
      syncRunId: 'erp_source_run_bad_kind',
      preparedRead: preparedRead('http', [
        { source: 'id', target: 'erpMaterialInternalId' },
        { source: 'code', target: 'erpMaterialCode' },
      ]),
      ...runtime,
    }),
    (error) => error instanceof StockPreparationReadonlySourceRunError
      && error.code === 'SOURCE_RUN_KIND_NOT_ALLOWED',
  )
  assert.equal(runtime.reads.length, 0)
  assert.equal(runtime.writes.length, 0)
}

// ---------------------------------------------------------------------------------------------------
// Completeness proofs, driven end-to-end through the REAL adapters.
// ---------------------------------------------------------------------------------------------------

// A read-source config whose containers point at the shape the REAL adapter puts in `raw`.
function realPreparedRead({ requiredKind, object, mode, containerPaths, fieldMap }) {
  const validation = validateReadSourceConfig({
    version: 1,
    systemId: 'private_system_reference_3889',
    requiredKind,
    object,
    mode,
    readPath: '/readonly/stock-preparation',
    readMethod: 'POST',
    operations: ['read'],
    containerPaths,
    fieldMap,
  })
  assert.equal(validation.valid, true, JSON.stringify(validation.errors))
  return prepareConfiguredRead({ config: validation.normalized })
}

const BOM_FIELD_MAP = [
  { source: 'path', target: 'pathKey' },
  { source: 'childCode', target: 'childDrawingNo' },
  { source: 'quantity', target: 'designQty' },
]

function bomRows(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    path: `/root/part-${offset + index}`,
    parentCode: 'ASSY-1',
    childCode: `PART-${offset + index}`,
    quantity: 1,
  }))
}

// P1 — THE headline defect. The Bridge Agent adapter clamps every read to config.maxLimit (default 20)
// and its /query/:object body is {limit, filters}: it never sends a cursor, so the kind is STRUCTURALLY
// unable to page. A 5,000-row source used to arrive as 20 rows with status=ready and rowErrors=0, because
// the full-page guard compared 20 against the 500 the feeder had REQUESTED. The agent below is faithful to
// the real protocol: it honours the limit it is given and offers no cursor.
async function testBridgeClampedSourceCannotReportReady() {
  const agentRows = bomRows(5000)
  const queries = []
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url)
    const body = JSON.parse(options.body)
    queries.push({ pathname: parsed.pathname, body })
    // The real agent protocol: it honours the limit it is handed and offers no continuation.
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ records: agentRows.slice(0, body.limit), done: true })
      },
    }
  }
  const system = {
    id: 'private_runtime_system_3889',
    name: 'Readonly Bridge Agent',
    kind: 'bridge:legacy-sql-readonly',
    role: 'source',
    config: { baseUrl: 'http://127.0.0.1:19091/', sampleLimit: 3, maxLimit: 20 },
    credentials: { sharedSecret: `bridge_${SECRET}` },
  }

  await assert.rejects(
    () => runPlmBomReadonlySource({
      permission: 'admin',
      projectId: 'business_project_bridge_truncation',
      sourceProjectNo: 'bridge_project',
      syncRunId: 'bridge_source_run_truncated',
      snapshotBatchId: 'bridge_snapshot_truncated',
      snapshotVersion: 1,
      preparedRead: realPreparedRead({
        requiredKind: 'bridge:legacy-sql-readonly',
        object: 'bom_lines',
        mode: 'list_page',
        containerPaths: ['records'],
        fieldMap: BOM_FIELD_MAP,
      }),
      system,
      createAdapter: (adapterSystem) => createBridgeAgentReadonlyAdapter({ system: adapterSystem, fetchImpl }),
    }),
    (error) => {
      assert.ok(error instanceof StockPreparationReadonlySourceRunError)
      assert.equal(error.code, 'SOURCE_RUN_COMPLETENESS_UNPROVABLE', '5,000 rows must never come back "ready"')
      assert.equal(error.status, 502)
      // The proof: the agent applied ITS bound (20), not the one we asked for, and cannot be continued.
      assert.equal(error.details.receivedRows, 20)
      assert.equal(error.details.effectivePageSize, 20)
      assert.equal(error.details.pagination, 'none')
      assert.equal(error.details.cursorReturned, false)
      assertValuesFree(error)
      return true
    },
  )
  assert.equal(queries.length, 1, 'a kind that cannot page must not be asked for a second page')
  // The clamp is right there on the wire: the feeder asked for 500, the agent sent 20 — and the body has
  // no cursor field at all, which is why this kind can never continue.
  assert.equal(queries[0].body.limit, 20)
  assert.equal(Object.prototype.hasOwnProperty.call(queries[0].body, 'cursor'), false)
}

// A bridge source SMALL enough to fit under the clamp is provably complete and still works.
async function testBridgeSourceUnderTheClampStillSucceeds() {
  const agentRows = bomRows(7)
  const fetchImpl = async (url, options) => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ records: agentRows.slice(0, JSON.parse(options.body).limit), done: true })
    },
  })
  const result = await runPlmBomReadonlySource({
    permission: 'admin',
    projectId: 'business_project_bridge_small',
    sourceProjectNo: 'bridge_project',
    syncRunId: 'bridge_source_run_small',
    snapshotBatchId: 'bridge_snapshot_small',
    snapshotVersion: 1,
    preparedRead: realPreparedRead({
      requiredKind: 'bridge:legacy-sql-readonly',
      object: 'bom_lines',
      mode: 'list_page',
      containerPaths: ['records'],
      fieldMap: BOM_FIELD_MAP,
    }),
    system: {
      id: 'private_runtime_system_3889',
      kind: 'bridge:legacy-sql-readonly',
      role: 'source',
      config: { baseUrl: 'http://127.0.0.1:19091/', sampleLimit: 3, maxLimit: 20 },
      credentials: { sharedSecret: `bridge_${SECRET}` },
    },
    createAdapter: (adapterSystem) => createBridgeAgentReadonlyAdapter({ system: adapterSystem, fetchImpl }),
  })
  assert.equal(result.status, 'ready')
  assert.equal(result.evidence.sourceRows, 7)
  assert.equal(result.evidence.intake.result.bomSnapshotLines, 7)
  assert.equal(result.evidence.completenessProof, 'short_page')
  assert.equal(result.evidence.sourcePageSizeEffective, 20, 'the bound the agent applied, not the one we asked for')
  assertValuesFree(publicReadonlySourceRunResult(result))
}

// The probe request builder only puts `limit` on the LIST dialects, so a keyed (single_record /
// detail_with_lines) feeder used to reach the adapter with no page bound at all and the adapter fell back
// to its own default — for the Bridge Agent that is sampleLimit, i.e. THREE rows. A page bound the source
// never sees is fiction, and every completeness rule downstream is computed against fiction.
async function testKeyedModeSendsItsPageBoundToTheSource() {
  const agentRows = bomRows(25)
  const bodies = []
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body)
    bodies.push(body)
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ records: agentRows.slice(0, body.limit), done: true })
      },
    }
  }
  const validation = validateReadSourceConfig({
    version: 1,
    systemId: 'private_system_reference_3889',
    requiredKind: 'bridge:legacy-sql-readonly',
    object: 'bom_lines',
    mode: 'single_record',
    readPath: '/readonly/stock-preparation',
    readMethod: 'POST',
    operations: ['read'],
    containerPaths: ['records'],
    keyField: 'childCode',
    fieldMap: BOM_FIELD_MAP,
  })
  assert.equal(validation.valid, true, JSON.stringify(validation.errors))

  await assert.rejects(
    () => runPlmBomReadonlySource({
      permission: 'admin',
      projectId: 'business_project_keyed',
      sourceProjectNo: 'keyed_project',
      syncRunId: 'bridge_source_run_keyed',
      snapshotBatchId: 'bridge_snapshot_keyed',
      snapshotVersion: 1,
      preparedRead: prepareConfiguredRead({
        config: validation.normalized,
        inputs: { key: 'PART-1' },
      }),
      system: {
        id: 'private_runtime_system_3889',
        kind: 'bridge:legacy-sql-readonly',
        role: 'source',
        config: { baseUrl: 'http://127.0.0.1:19091/', sampleLimit: 3, maxLimit: 20 },
        credentials: { sharedSecret: `bridge_${SECRET}` },
      },
      createAdapter: (adapterSystem) => createBridgeAgentReadonlyAdapter({ system: adapterSystem, fetchImpl }),
    }),
    (error) => {
      assert.equal(error.code, 'SOURCE_RUN_COMPLETENESS_UNPROVABLE')
      // 20 = the bound the agent applied to OUR bound. 3 would mean the request carried no limit at all
      // and the agent fell back to its sample size.
      assert.equal(error.details.receivedRows, 20, 'the keyed request carried the feeder page bound')
      assert.equal(error.details.effectivePageSize, 20)
      return true
    },
  )
  assert.equal(bodies[0].limit, 20, 'a keyed read reaches the source with a real page bound, not its default')
}

// A PLM client that honours the wrapper's limit/offset contract (the wrapper passes both down).
function plmClient(lines, { honourBound = true } = {}) {
  const calls = []
  return {
    calls,
    async getProductBOM(productId, options) {
      calls.push({ productId, limit: options.limit, offset: options.offset })
      const offset = Number.isInteger(options.offset) ? options.offset : 0
      return { data: honourBound ? lines.slice(offset, offset + options.limit) : lines.slice() }
    },
  }
}

function plmSystem() {
  return {
    id: 'private_runtime_system_3889',
    kind: 'plm:yuantus-wrapper',
    role: 'source',
    config: { defaultProductId: 'PRODUCT-1' },
    credentials: { password: `credential_${SECRET}` },
  }
}

function plmPreparedRead() {
  return realPreparedRead({
    requiredKind: 'plm:yuantus-wrapper',
    object: 'bom',
    mode: 'list_page',
    containerPaths: ['data'],
    fieldMap: BOM_FIELD_MAP,
  })
}

async function runPlmBomWithRealWrapper(client, syncRunId) {
  return runPlmBomReadonlySource({
    permission: 'admin',
    projectId: 'business_project_plm_ceiling',
    sourceProjectNo: 'plm_project',
    syncRunId,
    snapshotBatchId: `snapshot_${syncRunId}`,
    snapshotVersion: 1,
    preparedRead: plmPreparedRead(),
    system: plmSystem(),
    createAdapter: (adapterSystem) => createYuantusPlmWrapperAdapter({
      system: adapterSystem,
      plmClient: client,
    }),
  })
}

// P2-1 — the 499-row ceiling. The executor slices each raw container to rowCap, so a BOM of EXACTLY the
// page size left a full-looking page behind and every BOM >= 500 lines died with a 502, unreachable by any
// configuration. A real 500+ line mechanical BOM is ordinary. Exactly-page-size must now succeed, and a
// page that genuinely overflows must fail as TOO_LARGE — "too big" is a different fact from "unprovable".
async function testPlmBomAtExactlyThePageSizeIsIngestedCompletely() {
  const exact = plmClient(bomRows(SOURCE_PAGE_SIZE))
  const result = await runPlmBomWithRealWrapper(exact, 'plm_source_run_exact_page')
  assert.equal(result.status, 'ready')
  assert.equal(result.evidence.sourceRows, SOURCE_PAGE_SIZE, 'a BOM of exactly one page is ingested whole')
  assert.equal(result.evidence.intake.result.bomSnapshotLines, SOURCE_PAGE_SIZE)
  assert.equal(result.evidence.intake.result.rowErrors, 0)
  assert.equal(result.evidence.completenessProof, 'short_page')
  assert.equal(result.evidence.sourceRowsTruncated, false)
  assert.equal(exact.calls[0].limit, SOURCE_PAGE_SIZE, 'the page bound actually reaches the source')

  // ... and a BOM larger than one page is paged to completion rather than truncated or rejected.
  const overOnePage = plmClient(bomRows(SOURCE_PAGE_SIZE + 250))
  const paged = await runPlmBomWithRealWrapper(overOnePage, 'plm_source_run_multi_page')
  assert.equal(paged.status, 'ready')
  assert.equal(paged.evidence.sourceRows, SOURCE_PAGE_SIZE + 250)
  assert.equal(paged.evidence.intake.result.bomSnapshotLines, SOURCE_PAGE_SIZE + 250)
  assert.equal(paged.evidence.pages, 2)
}

// A source that IGNORES the page bound and hands back more rows than the feeder accepts is exactly the
// case the executor's silent rowCap slice used to hide. It must be named, not guessed at.
async function testPlmSourceOverflowingOnePageFailsClosedAsTooLarge() {
  const flooding = plmClient(bomRows(SOURCE_PAGE_SIZE + 1), { honourBound: false })
  await assert.rejects(
    () => runPlmBomWithRealWrapper(flooding, 'plm_source_run_too_large'),
    (error) => {
      assert.ok(error instanceof StockPreparationReadonlySourceRunError)
      assert.equal(error.code, 'SOURCE_RUN_RESULT_TOO_LARGE')
      assert.equal(error.status, 422)
      assert.equal(error.details.receivedRows, SOURCE_PAGE_SIZE + 1)
      assert.equal(error.details.pageSize, SOURCE_PAGE_SIZE)
      assertValuesFree(error)
      return true
    },
  )
}

// PR body promise: cursor loops are detected. A source that keeps handing back the same cursor must not
// spin, and must not be believed.
async function testRepeatedCursorFailsClosed() {
  const runtime = sourceRuntime('data-source:sql-readonly', () => ({
    records: [{}],
    raw: { Rows: [{ id: 'material_internal_1', code: 'MAT-1' }] },
    nextCursor: 'offset:stuck',
    done: false,
  }))
  await assert.rejects(
    () => runErpMaterialReadonlySource({
      permission: 'admin',
      syncRunId: 'data_source_cursor_loop',
      preparedRead: preparedRead('data-source:sql-readonly', [
        { source: 'id', target: 'erpMaterialInternalId' },
        { source: 'code', target: 'erpMaterialCode' },
      ]),
      ...runtime,
    }),
    (error) => error instanceof StockPreparationReadonlySourceRunError
      && error.code === 'SOURCE_RUN_CURSOR_LOOP'
      && error.status === 502,
  )
  assert.equal(runtime.reads.length, 2, 'the repeated cursor is caught on the page that repeats it')
  assert.equal(runtime.writes.length, 0)
}

// PR body promise: the page budget is bounded. A source that keeps offering fresh cursors is cut off at
// SOURCE_MAX_PAGES and fails closed — it is never ingested as a complete snapshot.
async function testBoundedPageBudgetFailsClosed() {
  let page = 0
  const runtime = sourceRuntime('data-source:sql-readonly', () => {
    page += 1
    return {
      records: [{}],
      raw: { Rows: [{ id: `material_internal_${page}`, code: `MAT-${page}` }] },
      nextCursor: `offset:${page}`,
      done: false,
    }
  })
  await assert.rejects(
    () => runErpMaterialReadonlySource({
      permission: 'admin',
      syncRunId: 'data_source_unbounded',
      preparedRead: preparedRead('data-source:sql-readonly', [
        { source: 'id', target: 'erpMaterialInternalId' },
        { source: 'code', target: 'erpMaterialCode' },
      ]),
      ...runtime,
    }),
    (error) => error instanceof StockPreparationReadonlySourceRunError
      && error.code === 'SOURCE_RUN_RESULT_TOO_LARGE'
      && error.details.maxPages === SOURCE_MAX_PAGES,
  )
  assert.equal(runtime.reads.length, SOURCE_MAX_PAGES, 'the page budget is a hard stop')
  assert.equal(runtime.writes.length, 0)
}

// P2-3 — the K3 WebAPI material channel really is bounded at 10 rows x 10 pages. At exactly its ceiling
// the behaviour must be honest in BOTH directions: with the ROWCOUNT total K3 actually returns, 100 rows
// are provably complete; without a total, a full 10th page proves nothing and must fail closed.
async function testK3MaterialCeilingBehaviourIsHonest() {
  const ceiling = K3_WEBAPI_SOURCE_PAGE_SIZE * SOURCE_MAX_PAGES
  const k3Rows = (pageIndex) => Array.from({ length: K3_WEBAPI_SOURCE_PAGE_SIZE }, (_, index) => {
    const row = (pageIndex - 1) * K3_WEBAPI_SOURCE_PAGE_SIZE + index
    return { FItemID: String(1001 + row), FNumber: `MAT-${row}`, FName: `Material ${row}` }
  })
  const fieldMap = [
    { source: 'FItemID', target: 'erpMaterialInternalId' },
    { source: 'FNumber', target: 'erpMaterialCode' },
    { source: 'FName', target: 'erpMaterialName' },
  ]

  const withTotal = sourceRuntime('erp:k3-wise-webapi', (request) => ({
    records: [],
    raw: { Rows: k3Rows(request.options.listPageIndex) },
    done: true,
    metadata: { dataRowCount: ceiling, dataPageIndex: request.options.listPageIndex },
  }))
  const result = await runErpMaterialReadonlySource({
    permission: 'admin',
    syncRunId: 'erp_source_run_ceiling',
    preparedRead: preparedRead('erp:k3-wise-webapi', fieldMap),
    ...withTotal,
  })
  assert.equal(result.status, 'ready')
  assert.equal(result.evidence.sourceRows, ceiling, 'K3 fills its whole budget when the total vouches for it')
  assert.equal(result.evidence.pages, SOURCE_MAX_PAGES)
  assert.equal(result.evidence.completenessProof, 'declared_total')
  assert.equal(result.evidence.sourceTotalKnown, true)

  const withoutTotal = sourceRuntime('erp:k3-wise-webapi', (request) => ({
    records: [],
    raw: { Rows: k3Rows(request.options.listPageIndex) },
    done: true,
  }))
  await assert.rejects(
    () => runErpMaterialReadonlySource({
      permission: 'admin',
      syncRunId: 'erp_source_run_ceiling_no_total',
      preparedRead: preparedRead('erp:k3-wise-webapi', fieldMap),
      ...withoutTotal,
    }),
    (error) => error instanceof StockPreparationReadonlySourceRunError
      && error.code === 'SOURCE_RUN_RESULT_TOO_LARGE'
      && error.details.receivedRows === ceiling,
  )
  assert.equal(withoutTotal.writes.length, 0)
}

// A source claiming MORE rows than it declared is inconsistent, not merely surprising.
async function testDeclaredTotalCannotBeExceeded() {
  const runtime = sourceRuntime('data-source:sql-readonly', () => ({
    records: [],
    raw: { Rows: [{ id: 'material_internal_1', code: 'MAT-1' }, { id: 'material_internal_2', code: 'MAT-2' }] },
    done: true,
    metadata: { totalCount: 1 },
  }))
  await assert.rejects(
    () => runErpMaterialReadonlySource({
      permission: 'admin',
      syncRunId: 'data_source_total_exceeded',
      preparedRead: preparedRead('data-source:sql-readonly', [
        { source: 'id', target: 'erpMaterialInternalId' },
        { source: 'code', target: 'erpMaterialCode' },
      ]),
      ...runtime,
    }),
    (error) => error instanceof StockPreparationReadonlySourceRunError
      && error.code === 'SOURCE_RUN_PAGINATION_INCONSISTENT'
      && error.details.receivedRows === 2
      && error.details.sourceTotal === 1,
  )
  assert.equal(runtime.writes.length, 0)
}

// "This is the last page" and "here is the next page" cannot both be true.
async function testTerminalPageWithCursorFailsClosed() {
  const runtime = sourceRuntime('data-source:sql-readonly', () => ({
    records: [],
    raw: { Rows: [{ id: 'material_internal_1', code: 'MAT-1' }] },
    nextCursor: 'offset:1',
    done: true,
  }))
  await assert.rejects(
    () => runErpMaterialReadonlySource({
      permission: 'admin',
      syncRunId: 'data_source_terminal_with_cursor',
      preparedRead: preparedRead('data-source:sql-readonly', [
        { source: 'id', target: 'erpMaterialInternalId' },
        { source: 'code', target: 'erpMaterialCode' },
      ]),
      ...runtime,
    }),
    (error) => error instanceof StockPreparationReadonlySourceRunError
      && error.code === 'SOURCE_RUN_PAGINATION_INCONSISTENT',
  )
  assert.equal(runtime.writes.length, 0)
}

// The feeder is admin-only at its own boundary, not merely at the route's.
async function testNonAdminPermissionFailsBeforeAnyRead() {
  const runtime = sourceRuntime('data-source:sql-readonly', () => {
    throw new Error('adapter must not run')
  })
  for (const permission of ['write', 'read', undefined, null, 'Admin']) {
    await assert.rejects(
      () => runErpMaterialReadonlySource({
        permission,
        syncRunId: 'erp_source_run_denied',
        preparedRead: preparedRead('data-source:sql-readonly', [
          { source: 'id', target: 'erpMaterialInternalId' },
          { source: 'code', target: 'erpMaterialCode' },
        ]),
        ...runtime,
      }),
      (error) => error instanceof StockPreparationReadonlySourceRunError
        && error.code === 'SOURCE_RUN_PERMISSION_DENIED'
        && error.status === 403,
    )
  }
  assert.equal(runtime.reads.length, 0, 'permission is checked before any external read')
  assert.equal(runtime.writes.length, 0)
}

// resolver_lookup resolves ONE key to ONE value — it has no row plane to feed an intake with.
async function testResolverLookupModeIsRejectedBeforeAnyRead() {
  const runtime = sourceRuntime('data-source:sql-readonly', () => {
    throw new Error('adapter must not run')
  })
  const validation = validateReadSourceConfig({
    version: 1,
    systemId: 'private_system_reference_3889',
    requiredKind: 'data-source:sql-readonly',
    object: 'materials',
    mode: 'resolver_lookup',
    readPath: '/readonly/stock-preparation',
    readMethod: 'POST',
    operations: ['read'],
    containerPaths: ['Rows'],
    keyField: 'code',
    resolverRule: 'exactly_one',
    fieldMap: [{ source: 'id', target: 'erpMaterialInternalId' }],
  })
  assert.equal(validation.valid, true, JSON.stringify(validation.errors))
  await assert.rejects(
    () => runErpMaterialReadonlySource({
      permission: 'admin',
      syncRunId: 'erp_source_run_resolver',
      preparedRead: prepareConfiguredRead({ config: validation.normalized, inputs: { key: 'M-001' } }),
      ...runtime,
    }),
    (error) => error instanceof StockPreparationReadonlySourceRunError
      && error.code === 'SOURCE_RUN_MODE_NOT_SUPPORTED'
      && error.details.mode === 'resolver_lookup',
  )
  assert.equal(runtime.reads.length, 0)
  assert.equal(runtime.writes.length, 0)
}

// An empty source is an empty source — never a "ready" snapshot with nothing in it.
async function testEmptySourceFailsClosed() {
  const runtime = sourceRuntime('data-source:sql-readonly', () => ({
    records: [],
    raw: { Rows: [] },
    done: true,
  }))
  await assert.rejects(
    () => runErpMaterialReadonlySource({
      permission: 'admin',
      syncRunId: 'data_source_empty',
      preparedRead: preparedRead('data-source:sql-readonly', [
        { source: 'id', target: 'erpMaterialInternalId' },
        { source: 'code', target: 'erpMaterialCode' },
      ]),
      ...runtime,
    }),
    (error) => error instanceof StockPreparationReadonlySourceRunError
      && error.code === 'SOURCE_RUN_EMPTY'
      && error.details.expectedShape === 'erpMaterialRows',
  )
  assert.equal(runtime.writes.length, 0)
}

async function main() {
  await testPlmFeedsPureIntakeAcrossCursorPages()
  await testBridgeClampedSourceCannotReportReady()
  await testBridgeSourceUnderTheClampStillSucceeds()
  await testKeyedModeSendsItsPageBoundToTheSource()
  await testPlmBomAtExactlyThePageSizeIsIngestedCompletely()
  await testPlmSourceOverflowingOnePageFailsClosedAsTooLarge()
  await testRepeatedCursorFailsClosed()
  await testBoundedPageBudgetFailsClosed()
  await testK3MaterialCeilingBehaviourIsHonest()
  await testDeclaredTotalCannotBeExceeded()
  await testTerminalPageWithCursorFailsClosed()
  await testNonAdminPermissionFailsBeforeAnyRead()
  await testResolverLookupModeIsRejectedBeforeAnyRead()
  await testEmptySourceFailsClosed()
  await testErpK3FeedsMaterialCacheShape()
  await testMissingRequiredMappingFailsClosed()
  await testBridgeAndConfiguredDataSourceKindsFeedTheSameContract()
  await testSourceRuntimeErrorsAreCoarse()
  await testDeclaredTotalCannotEndEarly()
  await testDeclaredTotalMustRemainStableAcrossPages()
  await testDeclaredTotalRemainsBindingWhenLaterPageOmitsIt()
  await testUnknownTotalCannotEndOnAnAmbiguousFullPage()
  await testSnapshotVersionRejectsNonIntegerJsonTypesBeforeRead()
  await testDisallowedKindFailsBeforeAdapter()
  console.log('stock-preparation readonly source-run tests: PASS')
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
})
