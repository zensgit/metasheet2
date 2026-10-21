'use strict'

const assert = require('node:assert/strict')

const {
  createStockPreparationRuntimePersist,
  isStockPreparationRuntimePersistFailure,
} = require('../lib/sealed-export/stock-preparation-runtime-persist.cjs')
const {
  isTrustedSealedExportError,
} = require('../lib/sealed-export/failure-vocabulary.cjs')

function contextFixture(calls) {
  const records = {
    async createRecord(input) {
      calls.push(['createRecord', input])
      return { data: input.data, id: `record-${calls.length}` }
    },
    async patchRecord(input) {
      calls.push(['patchRecord', input])
      return { data: input.changes, id: input.recordId }
    },
    async queryRecords(input) {
      calls.push(['queryRecords', input])
      return []
    },
    async runStockPreparationPersistUnitOfWork(_scope, callback) {
      calls.push(['unitOfWork'])
      return callback(records)
    },
  }
  return {
    api: {
      multitable: {
        provisioning: {
          async findObjectSheet({ objectId, projectId }) {
            calls.push(['findObjectSheet', { objectId, projectId }])
            return { id: `sheet-${objectId}` }
          },
          async resolveFieldIds({ objectId }) {
            calls.push(['resolveFieldIds', { objectId }])
            const templates = require('../lib/stock-preparation-templates.cjs')
            const template =
              templates.STOCK_PREPARATION_MVP_TABLE_TEMPLATES
                .find((entry) => entry.objectId === objectId)
            return Object.fromEntries(
              template.fields.map((field) => [
                field.id,
                `${objectId}-${field.id}`,
              ]),
            )
          },
        },
        records,
      },
    },
  }
}

function decodedFixture() {
  return {
    request: {
      projectId: 'project-1',
      snapshotBatchId: 'batch-1',
      snapshotVersion: 1,
      sourceProjectNo: 'source-project-1',
      syncRunId: 'sync-1',
    },
    intake: {
      bomSnapshotBatches: [{
        projectId: 'project-1',
        snapshotBatchId: 'batch-1',
        snapshotVersion: 1,
        sourceSystem: 'sqlserver.sealed_snapshot.v1',
        syncRunId: 'sync-1',
      }],
      bomSnapshotLines: [{
        bomLevel: 0,
        childDrawingNo: 'child-1',
        childVersion: null,
        designQty: 1,
        designUnit: 'EA',
        lineStatus: 'active',
        parentDrawingNo: null,
        parentVersion: null,
        pathKey: 'path-1',
        projectId: 'project-1',
        snapshotBatchId: 'batch-1',
        snapshotLineId: 'line-1',
        sourceFingerprint: `sha256:${'1'.repeat(64)}`,
      }],
      projects: [{
        lastSyncRunId: 'sync-1',
        projectId: 'project-1',
        projectName: null,
        sourceProjectNo: 'source-project-1',
        sourceSystem: 'sqlserver.sealed_snapshot.v1',
      }],
      rowErrors: [],
      runRecord: { runId: 'sync-1' },
    },
  }
}

async function main() {
  const calls = []
  const persist = createStockPreparationRuntimePersist({
    context: contextFixture(calls),
  })
  const result = await persist({
    decoded: decodedFixture(),
    scope: { tenantId: 'tenant-1', workspaceId: null },
  })
  assert.equal(result.externalWrite, false)
  assert.equal(result.persisted, true)
  assert.equal(Object.isFrozen(result), true)
  assert.ok(calls.some(([name]) => name === 'unitOfWork'))
  for (const [, input] of calls.filter(([name]) => name === 'findObjectSheet')) {
    assert.equal(input.projectId, 'tenant-1:integration-core')
  }

  assert.throws(
    () => createStockPreparationRuntimePersist({ context: {} }),
    (error) => isTrustedSealedExportError(error)
      && error.reason === 'SEALED_EXPORT_INTERNAL_ERROR',
  )

  const conflictContext = contextFixture([])
  conflictContext.api.multitable.records.runStockPreparationPersistUnitOfWork =
    async () => {
      const {
        StockPreparationSyncRunPersistError,
      } = require('../lib/stock-preparation-sync-run-persist.cjs')
      throw new StockPreparationSyncRunPersistError(
        409,
        'PERSIST_IDEMPOTENCY_CONFLICT',
        'business-value-must-not-cross-the-boundary',
        { businessField: 'business-value' },
      )
    }
  const remintingPersist = createStockPreparationRuntimePersist({
    context: conflictContext,
  })
  await assert.rejects(
    () => remintingPersist({
      decoded: decodedFixture(),
      scope: { tenantId: 'tenant-1', workspaceId: null },
    }),
    (error) => {
      assert.equal(isStockPreparationRuntimePersistFailure(error), true)
      assert.equal(error.status, 409)
      assert.equal(error.code, 'STOCK_PREPARATION_PERSIST_CONFLICT')
      assert.equal(error.message, 'stock-preparation internal persist was refused')
      assert.deepEqual(error.details, {})
      assert.equal(
        JSON.stringify(error).includes('business-value'),
        false,
      )
      return true
    },
  )
  await nonFirstPartyThrowKeepsIdentity()
  await snapshotTableDriftIsRemintedUnprocessableBeforeAnyWrite()
  console.log('sealed-export-s6a-runtime-persist.test.cjs OK')
}

// The sealed runtime rides the SAME persist module as the mvp-persist route, so it inherits the MVP
// snapshot-table field existence probe (stock-preparation-sync-run-persist.cjs
// `assertMvpTargetFieldsExist`): a host whose DB-backed read says a snapshot table is missing
// template columns refuses 422 TARGET_SCHEMA_INCOMPLETE before the unit-of-work opens. On this
// boundary that is reminted — NO new vocabulary — as the existing 422
// STOCK_PREPARATION_PERSIST_UNPROCESSABLE, values-free (no column name crosses), and with zero
// records I/O behind it.
async function snapshotTableDriftIsRemintedUnprocessableBeforeAnyWrite() {
  const calls = []
  const context = contextFixture(calls)
  const MISSING = ['pathKey', 'designQty', 'designUnit', 'totalQuantity', 'sourceFingerprint']
  context.api.multitable.provisioning.resolveExistingObjectFieldIds = async ({ objectId, fieldIds }) => {
    calls.push(['resolveExistingObjectFieldIds', { objectId }])
    const gone = objectId === 'plm_stock_preparation_bom_snapshot_line' ? MISSING : []
    return Object.fromEntries(fieldIds.filter((id) => !gone.includes(id)).map((id) => [id, `${objectId}-${id}`]))
  }
  const persist = createStockPreparationRuntimePersist({ context })
  await assert.rejects(
    () => persist({
      decoded: decodedFixture(),
      scope: { tenantId: 'tenant-1', workspaceId: null },
    }),
    (error) => {
      assert.equal(isStockPreparationRuntimePersistFailure(error), true)
      assert.equal(error.status, 422)
      assert.equal(error.code, 'STOCK_PREPARATION_PERSIST_UNPROCESSABLE')
      assert.deepEqual(error.details, {})
      for (const column of MISSING) {
        assert.equal(JSON.stringify(error).includes(column), false, `values-free: ${column} must not cross the boundary`)
      }
      return true
    },
  )
  assert.equal(calls.some(([name]) => name === 'resolveExistingObjectFieldIds'), true, 'the DB-backed read was consulted')
  assert.equal(calls.some(([name]) => name === 'unitOfWork'), false, 'the unit-of-work never opened')
  assert.equal(calls.some(([name]) => name === 'createRecord' || name === 'patchRecord' || name === 'queryRecords'), false, 'zero records I/O')
  for (const [, input] of calls.filter(([name]) => name === 'resolveExistingObjectFieldIds')) {
    assert.ok(['plm_stock_preparation_bom_snapshot_batch', 'plm_stock_preparation_bom_snapshot_line'].includes(input.objectId), 'judged in write order up to the refused table')
  }
}

// R14: a NON-first-party throw out of the persist unit-of-work must keep its identity.
// Before this, remintPersistFailure returned null for anything that was not a
// StockPreparationSyncRunPersistError, the caller rethrew the RAW error, privateBoundary in
// runtime-core did not recognise it, and it collapsed into SEALED_EXPORT_INTERNAL_ERROR — served as a
// bare 503 on a run whose generation was already ACTIVE (dispatched run 30890457411).
async function nonFirstPartyThrowKeepsIdentity() {
  const rawContext = contextFixture([])
  const CANARY = 'multitable-internal-detail-must-not-cross-the-boundary'
  rawContext.api.multitable.records.runStockPreparationPersistUnitOfWork =
    async () => {
      // Deliberately NOT a StockPreparationSyncRunPersistError — this is the whole point.
      const err = new Error(CANARY)
      err.code = 'SOME_UPSTREAM_CODE'
      throw err
    }
  const rawPersist = createStockPreparationRuntimePersist({ context: rawContext })
  await assert.rejects(
    () => rawPersist({
      decoded: decodedFixture(),
      scope: { tenantId: 'tenant-1', workspaceId: null },
    }),
    (error) => {
      // The discriminating assertion. Before the fix this was a trusted sealed-export
      // SEALED_EXPORT_INTERNAL_ERROR (or the raw Error), never a persist failure.
      assert.equal(isStockPreparationRuntimePersistFailure(error), true)
      assert.equal(error.status, 503, 'status must be UNCHANGED — this fix is identity, not behaviour')
      assert.equal(error.code, 'STOCK_PREPARATION_PERSIST_FAILED')
      // values-free: the upstream detail must not ride out on the boundary error.
      assert.equal(String(error.message).includes(CANARY), false)
      assert.equal(JSON.stringify(error).includes(CANARY), false)
      return true
    },
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
