'use strict'

// #3889: approved readonly sources feed the existing pure intake contract. The core keeps normalized
// rows as an internal data plane; the public projector returns only values-free shape evidence.

const assert = require('node:assert/strict')
const path = require('node:path')

const { validateReadSourceConfig } = require(path.join(__dirname, '..', 'lib', 'read-source-config.cjs'))
const { prepareConfiguredRead } = require(path.join(__dirname, '..', 'lib', 'read-source-read-runtime.cjs'))
const {
  publicReadonlySourceRunResult,
  SOURCE_PAGE_SIZE,
  StockPreparationReadonlySourceRunError,
  runErpMaterialReadonlySource,
  runPlmBomReadonlySource,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-readonly-source-run.cjs'))

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
  assert.equal(runtime.reads[0].limit, 500)
  assert.equal(runtime.reads[1].cursor, 'offset:1')
  assert.equal(runtime.writes.length, 0)
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
    (error) => error instanceof StockPreparationReadonlySourceRunError
      && error.code === 'SOURCE_RUN_PAGINATION_AMBIGUOUS'
      && error.details.receivedRows === SOURCE_PAGE_SIZE,
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

async function main() {
  await testPlmFeedsPureIntakeAcrossCursorPages()
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
