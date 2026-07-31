'use strict'

const assert = require('node:assert/strict')

const {
  SealedExportError,
} = require('../lib/sealed-export/failure-vocabulary.cjs')
const {
  BINDING_TABLE,
  RUN_TABLE,
  createStockPreparationRuntimeStore,
} = require(
  '../lib/sealed-export/stock-preparation-runtime-store.cjs'
)
const {
  AUTHORITY_STATE_TABLE,
} = require('../lib/sealed-export/sealed-export-signer-authority-store.cjs')

const NOW_MS = Date.parse('2026-07-31T00:00:00.000Z')
const SCOPE = Object.freeze({
  tenantId: 'tenant-s6a',
  workspaceId: null,
})

function cloneTables(tables) {
  return new Map(
    [...tables].map(([table, rows]) => [
      table,
      rows.map((row) => structuredClone(row)),
    ]),
  )
}

function matches(row, where) {
  return Object.keys(where).every((field) => (
    (row[field] ?? null) === (where[field] ?? null)
  ))
}

function createMemoryDb() {
  let tables = new Map([
    [BINDING_TABLE, [{
      approved_config_version_id: 'config-s6a-v1',
      binding_id: 'binding-s6a',
      binding_version: 'binding-s6a-v1',
      canonical_object_version: 'stock-preparation-bom.v1',
      config_content_key: 'config-content-s6a',
      expires_at: '2099-01-01T00:00:00.000Z',
      external_system_id: 'system-s6a',
      object_key: 'stock-preparation-bom',
      relation_id: 'sqlserver.relation.rowid_payload.v1',
      role_binding_fingerprint: 'role-binding-s6a',
      status: 'ACTIVE',
      system_content_key: 'system-content-s6a',
      table_ref: 'dbo.stock_prep_sealed_rows',
      tenant_domain_binding: 'tenant-domain-s6a',
      tenant_id: SCOPE.tenantId,
      workspace_id: null,
    }]],
    [AUTHORITY_STATE_TABLE, [{
      binding_current: true,
      binding_expires_at: '2099-01-01T00:00:00.000Z',
      qualification_current: true,
      qualification_digest: 'b'.repeat(64),
      qualification_expires_at: '2099-01-01T00:00:00.000Z',
      role_binding_fingerprint: 'role-binding-s6a',
      signer_expires_at: '2099-01-01T00:00:00.000Z',
      signer_key_id: 'a'.repeat(64),
      signer_status: 'ACTIVE',
      system_content_key: 'system-content-s6a',
      tenant_domain_binding: 'tenant-domain-s6a',
      tenant_id: SCOPE.tenantId,
      workspace_id: null,
    }]],
    [RUN_TABLE, []],
  ])

  function apiFor(target) {
    return Object.freeze({
      async insertOne(table, rawRow) {
        const rows = target.get(table)
        if (!rows) throw new Error('unknown table')
        if (
          table === RUN_TABLE
          && rows.some((row) => (
            row.tenant_id === rawRow.tenant_id
            && (row.workspace_id ?? null) === (rawRow.workspace_id ?? null)
            && row.operation_id === rawRow.operation_id
          ))
        ) {
          throw new Error('duplicate operation')
        }
        const now = new Date(NOW_MS).toISOString()
        const row = table === RUN_TABLE
          ? {
              activated_at: null,
              actor_id: null,
              artifact_directory: null,
              binding_id: null,
              business_line_count: null,
              captured_at: null,
              chunk_paths: null,
              completed_at: null,
              created_at: now,
              export_request_envelope: null,
              failure_reason: null,
              generation_id: null,
              generation_verified_at: null,
              ingestion_session_id: null,
              ingested_at: null,
              manifest: null,
              manifest_digest: null,
              operation_id: null,
              run_id: null,
              source_read_count: 1,
              status: null,
              stock_preparation_run_id: null,
              tenant_id: null,
              updated_at: now,
              workspace_id: null,
              ...structuredClone(rawRow),
            }
          : structuredClone(rawRow)
        rows.push(row)
        return [structuredClone(row)]
      },
      async selectOne(table, where) {
        const row = target.get(table)?.find((candidate) => matches(candidate, where))
        return row ? structuredClone(row) : null
      },
      async selectOneForUpdate(table, where) {
        return this.selectOne(table, where)
      },
      async updateRow(table, patch, where) {
        const row = target.get(table)?.find((candidate) => matches(candidate, where))
        if (!row) return []
        Object.assign(row, structuredClone(patch), {
          updated_at: new Date(NOW_MS).toISOString(),
        })
        return [structuredClone(row)]
      },
    })
  }

  return Object.freeze({
    async insertOne(...args) {
      return apiFor(tables).insertOne(...args)
    },
    async selectOne(...args) {
      return apiFor(tables).selectOne(...args)
    },
    async selectOneForUpdate(...args) {
      return apiFor(tables).selectOneForUpdate(...args)
    },
    async updateRow(...args) {
      return apiFor(tables).updateRow(...args)
    },
    async transaction(callback) {
      const candidate = cloneTables(tables)
      const result = await callback(apiFor(candidate))
      tables = candidate
      return result
    },
    mutateRun(operationId, mutate) {
      const row = tables.get(RUN_TABLE).find(
        (candidate) => candidate.operation_id === operationId,
      )
      mutate(row)
    },
    rows(table) {
      return structuredClone(tables.get(table))
    },
  })
}

async function refuses(action, reason) {
  let caught = null
  try {
    await action()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof SealedExportError)
  assert.equal(caught.reason, reason)
  return caught
}

async function main() {
  const db = createMemoryDb()
  let nextId = 1
  const store = createStockPreparationRuntimeStore({
    clock: () => NOW_MS,
    db,
    idGenerator: () => `run-s6a-${nextId++}`,
  })
  const binding = await store.loadActiveBinding(SCOPE)
  assert.equal(binding.bindingId, 'binding-s6a')
  assert.equal(Object.isFrozen(binding), true)
  assert.deepEqual(await store.loadCurrentAuthority(binding), {
    bindingExpiresAt: '2099-01-01T00:00:00.000Z',
    qualificationDigest: 'b'.repeat(64),
    qualificationExpiresAt: '2099-01-01T00:00:00.000Z',
    signerExpiresAt: '2099-01-01T00:00:00.000Z',
    signerKeyId: 'a'.repeat(64),
  })

  const capturing = await store.openRun({
    actor: 'operator-s6a',
    binding,
    operationId: 'operation-s6a',
    scope: SCOPE,
  })
  assert.deepEqual(capturing, {
    externalWrite: false,
    resumable: false,
    status: 'CAPTURING',
    valuesFree: true,
  })
  await refuses(
    () => store.openRun({
      actor: 'operator-s6a',
      binding,
      operationId: 'operation-s6a',
      scope: SCOPE,
    }),
    'SEALED_EXPORT_MANIFEST_REPLAYED',
  )
  assert.equal(db.rows(RUN_TABLE).length, 1)
  assert.equal(db.rows(RUN_TABLE)[0].source_read_count, 1)

  const captured = await store.markCaptured(capturing, {
    artifactDirectory: '/private/s6a/run-1',
    chunkPaths: ['/private/s6a/run-1/chunk-0'],
    envelope: { request: 'frozen' },
    manifest: { manifest: 'frozen' },
    manifestDigest: 'a'.repeat(64),
  })
  assert.equal(captured.status, 'CAPTURED')
  await refuses(
    () => store.markCaptured(capturing, {
      artifactDirectory: '/private/s6a/run-1',
      chunkPaths: ['/private/s6a/run-1/chunk-0'],
      envelope: { request: 'second-read' },
      manifest: { manifest: 'second-read' },
      manifestDigest: 'b'.repeat(64),
    }),
    'SEALED_EXPORT_MANIFEST_REPLAYED',
  )

  const resumed = await store.openRun({
    actor: 'operator-s6a',
    binding,
    operationId: 'operation-s6a',
    scope: SCOPE,
  })
  assert.equal(resumed.status, 'CAPTURED')
  const checkpoint = await store.readPrivateCheckpoint(resumed)
  assert.deepEqual(checkpoint, {
    actor: 'operator-s6a',
    artifactDirectory: '/private/s6a/run-1',
    chunkPaths: ['/private/s6a/run-1/chunk-0'],
    envelope: { request: 'frozen' },
    generationId: null,
    ingestionSessionId: null,
    manifest: { manifest: 'frozen' },
    manifestDigest: 'a'.repeat(64),
    status: 'CAPTURED',
    startedAt: '2026-07-31T00:00:00.000Z',
    stockPreparationRunId: null,
  })
  assert.equal(Object.isFrozen(checkpoint), true)
  assert.equal(Object.isFrozen(checkpoint.chunkPaths), true)

  const ingesting = await store.markIngestionStarted(resumed, 'session-s6a')
  assert.equal(ingesting.status, 'INGESTING')
  const ingestingReplay = await store.openRun({
    actor: 'operator-s6a',
    binding,
    operationId: 'operation-s6a',
    scope: SCOPE,
  })
  assert.equal(
    (await store.readPrivateCheckpoint(ingestingReplay)).ingestionSessionId,
    'session-s6a',
  )
  const ingested = await store.markIngested(ingestingReplay)
  const verified = await store.markGenerationVerified(
    ingested,
    'generation-s6a',
  )
  const activated = await store.markActivated(verified)
  const completed = await store.markCompleted(
    activated,
    'stock-prep-run-s6a',
    2,
  )
  assert.equal(completed.status, 'COMPLETED')
  assert.equal(completed.businessLineCount, 2)
  const completedReplay = await store.openRun({
    actor: 'operator-s6a',
    binding,
    operationId: 'operation-s6a',
    scope: SCOPE,
  })
  assert.equal(completedReplay.status, 'COMPLETED')
  assert.equal(completedReplay.businessLineCount, 2)
  assert.equal(
    (await store.readPrivateCheckpoint(completedReplay)).stockPreparationRunId,
    'stock-prep-run-s6a',
  )
  assert.equal(db.rows(RUN_TABLE)[0].business_line_count, 2)
  assert.equal(db.rows(RUN_TABLE)[0].source_read_count, 1)

  const failedCapture = await store.openRun({
    actor: 'operator-s6a',
    binding,
    operationId: 'operation-failed',
    scope: SCOPE,
  })
  await store.markCaptureFailed(
    failedCapture,
    'SEALED_EXPORT_SOURCE_SNAPSHOT_UNAVAILABLE',
  )
  await refuses(
    () => store.openRun({
      actor: 'operator-s6a',
      binding,
      operationId: 'operation-failed',
      scope: SCOPE,
    }),
    'SEALED_EXPORT_MANIFEST_REPLAYED',
  )

  const tamperCapture = await store.openRun({
    actor: 'operator-s6a',
    binding,
    operationId: 'operation-tamper',
    scope: SCOPE,
  })
  const tamperCaptured = await store.markCaptured(tamperCapture, {
    artifactDirectory: '/private/s6a/run-tamper',
    chunkPaths: ['/private/s6a/run-tamper/chunk-0'],
    envelope: { request: 'tamper' },
    manifest: { manifest: 'tamper' },
    manifestDigest: 'c'.repeat(64),
  })
  db.mutateRun('operation-tamper', (row) => {
    row.manifest = null
  })
  await refuses(
    () => store.readPrivateCheckpoint(tamperCaptured),
    'SEALED_EXPORT_INTERNAL_ERROR',
  )

  console.log('sealed-export-s6a-runtime-store.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
