'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const os = require('node:os')
const path = require('node:path')

const {
  createStockPreparationRuntimeDatabase,
} = require('../lib/sealed-export/stock-preparation-runtime-database.cjs')
const {
  createStockPreparationSqlServerRuntime,
  isStockPreparationSqlServerRuntime,
  __internals: {
    mapRuntimeError,
  },
} = require('../lib/sealed-export/stock-preparation-sqlserver-runtime.cjs')
const {
  createStockPreparationRuntimePersist,
} = require('../lib/sealed-export/stock-preparation-runtime-persist.cjs')

async function main() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const signerKeyId = crypto
    .createHash('sha256')
    .update(publicKey.export({ format: 'der', type: 'spki' }))
    .digest('hex')
  const runtimeDatabase = createStockPreparationRuntimeDatabase({
    connectionString:
      'postgresql://driver-user:driver-password@127.0.0.1:1/unreachable?connect_timeout=1',
    expectedRole: 's6a-runtime',
  })
  try {
    const runtime = createStockPreparationSqlServerRuntime({
      artifactRoot: path.join(os.tmpdir(), 's6a-product-runtime-test'),
      evidenceKey: Buffer.alloc(32, 1),
      externalSystemRegistry: {
        async getExternalSystemForAdapter() {
          throw new Error('source must not load before runtime role verification')
        },
      },
      identityKey: Buffer.alloc(32, 2),
      persistStockPreparation: async () => {
        throw new Error('persist must not run before runtime role verification')
      },
      privateSignerMaterials: [{ privateKey, signerKeyId }],
      qualificationKeyring: {
        keyId: 'qualification-key-v1',
        secret: Buffer.alloc(32, 3),
      },
      runtimeDatabase,
    })
    assert.equal(isStockPreparationSqlServerRuntime(runtime), true)

    let caught
    try {
      await runtime.run({
        actor: 'operator',
        operationId: 'product-runtime-negative',
        tenantId: 'tenant',
        workspaceId: null,
      })
    } catch (error) {
      caught = error
    }
    assert.ok(caught)
    assert.equal(caught.name, 'StockPreparationSqlServerRuntimeError')
    assert.equal(caught.status, 503)
    assert.equal(caught.code, 'SEALED_EXPORT_INTERNAL_ERROR')
    assert.equal(
      caught.message,
      'stock-preparation sealed-snapshot run was refused',
    )
    assert.deepEqual(caught.details, {})
    const serialized = JSON.stringify(caught)
    assert.equal(serialized.includes('driver-user'), false)
    assert.equal(serialized.includes('driver-password'), false)
    assert.equal(serialized.includes('127.0.0.1'), false)
  } finally {
    await runtimeDatabase.close()
  }

  const conflictContext = {
    api: {
      multitable: {
        provisioning: {
          async findObjectSheet() {
            return { id: 'sheet' }
          },
          async resolveFieldIds({ objectId }) {
            const {
              STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
            } = require('../lib/stock-preparation-templates.cjs')
            const template = STOCK_PREPARATION_MVP_TABLE_TEMPLATES
              .find((entry) => entry.objectId === objectId)
            return Object.fromEntries(
              template.fields.map((field) => [
                field.id,
                `${objectId}-${field.id}`,
              ]),
            )
          },
        },
        records: {
          async createRecord() {},
          async patchRecord() {},
          async queryRecords() {
            return []
          },
          async runStockPreparationPersistUnitOfWork() {
            const {
              StockPreparationSyncRunPersistError,
            } = require('../lib/stock-preparation-sync-run-persist.cjs')
            throw new StockPreparationSyncRunPersistError(
              409,
              'PERSIST_IDEMPOTENCY_CONFLICT',
              'driver-and-business-value',
            )
          },
        },
      },
    },
  }
  const persist = createStockPreparationRuntimePersist({
    context: conflictContext,
  })
  let persistFailure
  try {
    await persist({
      decoded: {
        intake: {
          bomSnapshotBatches: [{
            projectId: 'project',
            snapshotBatchId: 'batch',
            snapshotVersion: 1,
            sourceSystem: 'sqlserver.sealed_snapshot.v1',
            syncRunId: 'sync',
          }],
          bomSnapshotLines: [{
            bomLevel: 0,
            childDrawingNo: 'child',
            childVersion: null,
            designQty: 1,
            designUnit: 'EA',
            lineStatus: 'active',
            parentDrawingNo: null,
            parentVersion: null,
            pathKey: 'root',
            projectId: 'project',
            snapshotBatchId: 'batch',
            snapshotLineId: 'line',
            sourceFingerprint: `sha256:${'1'.repeat(64)}`,
          }],
          projects: [{
            lastSyncRunId: 'sync',
            projectId: 'project',
            projectName: null,
            sourceProjectNo: 'source-project',
            sourceSystem: 'sqlserver.sealed_snapshot.v1',
          }],
          rowErrors: [],
          runRecord: { runId: 'sync' },
        },
        request: {
          projectId: 'project',
          snapshotBatchId: 'batch',
          snapshotVersion: 1,
          sourceProjectNo: 'source-project',
          syncRunId: 'sync',
        },
      },
      scope: { tenantId: 'tenant', workspaceId: null },
    })
  } catch (error) {
    persistFailure = error
  }
  assert.ok(persistFailure)
  const mappedPersistFailure = mapRuntimeError(persistFailure)
  assert.equal(mappedPersistFailure.status, 409)
  assert.equal(
    mappedPersistFailure.code,
    'STOCK_PREPARATION_PERSIST_CONFLICT',
  )
  assert.equal(
    mappedPersistFailure.message,
    'stock-preparation sealed-snapshot run was refused',
  )
  assert.deepEqual(mappedPersistFailure.details, {})
  assert.equal(
    JSON.stringify(mappedPersistFailure)
      .includes('driver-and-business-value'),
    false,
  )
  console.log('sealed-export-s6a-product-runtime.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
