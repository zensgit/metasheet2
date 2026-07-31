'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const canonicalCodec = require('../lib/sealed-export/canonical-json.cjs')
const contracts = require('../lib/sealed-export/contracts.cjs')
const {
  SealedExportError,
} = require('../lib/sealed-export/failure-vocabulary.cjs')
const {
  SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
} = require('../lib/sealed-export/sqlserver-sealed-snapshot-action.cjs')
const {
  SOURCE_CONFIG_KEY,
  deriveStockPreparationSqlServerSourceAnchors,
} = require(
  '../lib/sealed-export/stock-preparation-sqlserver-source-authority.cjs'
)
const {
  createStockPreparationRuntimeCore,
} = require('../lib/sealed-export/stock-preparation-runtime-core.cjs')

const NOW_MS = Date.parse('2026-07-31T00:00:00.000Z')
const IDENTITY_KEY = crypto
  .createHash('sha256')
  .update('s6a-runtime-core-identity')
  .digest()

function sourceSystem() {
  return {
    capabilities: {},
    config: {
      [SOURCE_CONFIG_KEY]: {
        database: 'PDM',
        encrypt: true,
        instanceName: null,
        port: 1433,
        server: 'sqlserver.internal',
        trustServerCertificate: false,
      },
    },
    createdAt: null,
    credentials: {
      [SOURCE_CONFIG_KEY]: {
        password: 'private-password',
        user: 'readonly_user',
      },
    },
    id: 'system-s6a',
    kind: 'data-source:sql-readonly',
    lastError: null,
    lastTestedAt: null,
    name: 'S6A source',
    projectId: null,
    role: 'source',
    status: 'active',
    tenantId: 'tenant-s6a',
    updatedAt: null,
    workspaceId: null,
  }
}

function bindingDraft() {
  return {
    approvedConfigVersionId: 'config-s6a-v1',
    bindingVersion: 'binding-s6a-v1',
    canonicalObjectVersion: 'stock-preparation-bom.v1',
    externalSystemId: 'system-s6a',
    objectKey: 'stock-preparation-bom',
    relationId: 'sqlserver.relation.rowid_payload.v1',
    tableRef: 'dbo.stock_prep_sealed_rows',
    tenantId: 'tenant-s6a',
    workspaceId: null,
  }
}

function runtimeBinding() {
  const draft = bindingDraft()
  const derived = deriveStockPreparationSqlServerSourceAnchors({
    binding: draft,
    externalSystem: sourceSystem(),
    identityKey: IDENTITY_KEY,
  })
  return Object.freeze({
    ...draft,
    ...derived.anchors,
    bindingId: 'binding-row-s6a',
    expiresAt: '2099-01-01T00:00:00.000Z',
  })
}

function payload(index) {
  return {
    bomLevel: index === 0 ? 0 : 1,
    childDrawingNo: `CHILD-${index + 1}`,
    childVersion: null,
    designQty: '1.5',
    designUnit: 'EA',
    lineStatus: 'active',
    parentDrawingNo: index === 0 ? null : 'CHILD-1',
    parentVersion: null,
    pathKey: `root/${index + 1}`,
    projectId: 'project-s6a',
    projectName: 'Project S6A',
    snapshotBatchId: 'batch-s6a',
    snapshotVersion: 1,
    sourceBomId: 'bom-s6a',
    sourceProjectNo: 'P-S6A',
    syncRunId: 'sync-run-s6a',
  }
}

function sourceRows() {
  return [0, 1].map((index) => {
    const payloadText = canonicalCodec
      .tryCanonicalJson(payload(index))
      .bytes
      .toString('utf8')
    return {
      payload: payloadText,
      payloadVersion: 1,
      rowId: index + 1,
    }
  })
}

async function buildCapturePackage(root, envelope, rows = sourceRows()) {
  const chunkPaths = []
  const chunks = []
  for (let index = 0; index < rows.length; index += 1) {
    const rowText = canonicalCodec.tryCanonicalJson(rows[index]).bytes
    const bytes = Buffer.concat([rowText, Buffer.from('\n')])
    const chunkPath = path.join(root, `chunk-${index}.jsonl`)
    await fs.writeFile(chunkPath, bytes)
    chunkPaths.push(chunkPath)
    chunks.push({
      byteCount: bytes.length,
      chunkDigest: crypto.createHash('sha256').update(bytes).digest('hex'),
      chunkIndex: index,
    })
  }
  const allBytes = Buffer.concat(
    await Promise.all(chunkPaths.map((chunkPath) => fs.readFile(chunkPath))),
  )
  const manifest = {
    agentImplementationVersion: 's6a-test-agent',
    agentProtocolVersion: 's6a-test-protocol',
    canonicalRowsetMultiplicityDigest:
      crypto.createHash('sha256').update('rowset').digest('hex'),
    canonicalizationVersion:
      canonicalCodec.SEALED_EXPORT_CANONICALIZATION_VERSION,
    captureCompletionTimestamp: '2026-07-31T00:00:00.000Z',
    chunks,
    encodingVersion: 'canonical-jsonl-v1',
    exportRequestEnvelopeDigest:
      contracts.computeExportRequestEnvelopeDigest(envelope),
    manifestExpiry: envelope.expiry,
    signature: Buffer.alloc(64).toString('base64'),
    signatureAlgorithm: 'ED25519',
    signerKeyId: 'a'.repeat(64),
    sourceCaptureIdentity: 's6a-test-capture',
    sourceCaptureProofClass: 'SOURCE_SNAPSHOT_TXN',
    sourceSchemaDigest: SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
    totalBytes: allBytes.length,
    totalRows: rows.length,
    wholeArtifactByteDigest:
      crypto.createHash('sha256').update(allBytes).digest('hex'),
  }
  return {
    actionId: 'sealed_snapshot',
    artifact: {
      chunkPaths,
      directory: root,
    },
    evidence: {
      dataStreamReadCount: 1,
    },
    manifest,
    manifestDigest: contracts.computeManifestDigest(manifest),
  }
}

function createRuntimeStore(
  binding,
  { interruptFirstMarkIngested = false } = {},
) {
  let state = null
  let markIngestedInterrupted = false
  let authorityRefused = false

  function handle() {
    return Object.freeze({
      ...(state.status === 'COMPLETED'
        ? { businessLineCount: state.businessLineCount }
        : {}),
      externalWrite: false,
      resumable: state.status !== 'CAPTURING',
      status: state.status,
      valuesFree: true,
    })
  }

  return Object.freeze({
    async loadActiveBinding() {
      return binding
    },
    async loadCurrentAuthority() {
      if (authorityRefused) {
        throw new Error('simulated expired runtime authority')
      }
      return Object.freeze({
        bindingExpiresAt: '2099-01-01T00:00:00.000Z',
        qualificationDigest: 'b'.repeat(64),
        qualificationExpiresAt: '2099-01-01T00:00:00.000Z',
        signerExpiresAt: '2099-01-01T00:00:00.000Z',
        signerKeyId: 'a'.repeat(64),
      })
    },
    refuseAuthority() {
      authorityRefused = true
    },
    async openRun({ actor, operationId }) {
      if (state === null) {
        state = {
          actor,
          operationId,
          startedAt: '2026-07-31T00:00:00.000Z',
          status: 'CAPTURING',
        }
      }
      return handle()
    },
    async markCaptureFailed(_handle, reason) {
      state.status = 'CAPTURE_FAILED'
      state.failureReason = reason
      return handle()
    },
    async markCaptured(_handle, capture) {
      Object.assign(state, structuredClone(capture), { status: 'CAPTURED' })
      return handle()
    },
    async markIngestionStarted(_handle, sessionId) {
      state.ingestionSessionId = sessionId
      state.status = 'INGESTING'
      return handle()
    },
    async markIngested() {
      if (
        interruptFirstMarkIngested
        && !markIngestedInterrupted
      ) {
        markIngestedInterrupted = true
        throw new Error(
          'simulated process interruption after upload completion',
        )
      }
      state.status = 'INGESTED'
      return handle()
    },
    async markGenerationVerified(_handle, generationId) {
      state.generationId = generationId
      state.status = 'GENERATION_VERIFIED'
      return handle()
    },
    async markActivated() {
      state.status = 'ACTIVATED'
      return handle()
    },
    async markCompleted(
      _handle,
      stockPreparationRunId,
      businessLineCount,
    ) {
      state.businessLineCount = businessLineCount
      state.stockPreparationRunId = stockPreparationRunId
      state.status = 'COMPLETED'
      return handle()
    },
    async readPrivateCheckpoint() {
      return Object.freeze(structuredClone({
        actor: state.actor,
        artifactDirectory: state.artifactDirectory ?? null,
        chunkPaths: state.chunkPaths ?? null,
        envelope: state.envelope ?? null,
        generationId: state.generationId ?? null,
        ingestionSessionId: state.ingestionSessionId ?? null,
        manifest: state.manifest ?? null,
        manifestDigest: state.manifestDigest ?? null,
        startedAt: state.startedAt,
        status: state.status,
        stockPreparationRunId: state.stockPreparationRunId ?? null,
      }))
    },
    snapshot() {
      return structuredClone(state)
    },
  })
}

function createPipeline(rows, { interruptFirstUpload = false } = {}) {
  const accepted = new Set()
  let interrupted = false
  let uploadComplete = false
  const activationResults = new WeakSet()
  const descriptors = new WeakSet()
  return Object.freeze({
    ingestionService: Object.freeze({
      async createSession() {
        return { sessionId: 'session-s6a' }
      },
      async resumeSession() {
        if (uploadComplete) {
          return {
            acceptedChunkIndexes: [...accepted],
            artifactDigestVerified: true,
            status: 'UPLOAD_COMPLETE',
          }
        }
        return {
          acceptedChunkIndexes: [...accepted],
          status: 'UPLOADING',
        }
      },
      async submitChunk({ chunkIndex }) {
        accepted.add(chunkIndex)
        if (interruptFirstUpload && !interrupted) {
          interrupted = true
          throw new Error('simulated process interruption after receipt commit')
        }
        return { decision: 'ACCEPT' }
      },
      async completeSession() {
        uploadComplete = true
        return {
          artifactDigestVerified: true,
          status: 'UPLOAD_COMPLETE',
        }
      },
    }),
    kernel: Object.freeze({
      async stageAndSeal() {
        return {
          generationId: 'generation-s6a',
          status: 'SEALED',
        }
      },
      async beginApply() {
        return Object.freeze({})
      },
      async applyNextChunk() {
        return { status: 'VERIFIED' }
      },
      async createActivationExpectation() {
        return Object.freeze({})
      },
      async activateWithExpectation() {
        const result = Object.freeze({
          activePointerOutcome: 'FLIPPED',
          status: 'ACTIVE',
        })
        activationResults.add(result)
        return result
      },
      async createReadDescriptorForActivation({ activation }) {
        assert.equal(activationResults.has(activation), true)
        const descriptor = Object.freeze({
          appliedRowCount: rows.length,
        })
        descriptors.add(descriptor)
        return descriptor
      },
      async readPinnedRows({ descriptor, limit, offset }) {
        assert.equal(descriptors.has(descriptor), true)
        return rows.slice(offset, offset + limit)
      },
    }),
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 's6a-runtime-core-'))
  try {
    const binding = runtimeBinding()
    const runtimeStore = createRuntimeStore(binding, {
      interruptFirstMarkIngested: true,
    })
    const pipeline = createPipeline(sourceRows(), {
      interruptFirstUpload: true,
    })
    let sourceReads = 0
    let sourceLoads = 0
    let persistCalls = 0
    const runtime = createStockPreparationRuntimeCore({
      artifactRoot: root,
      captureServiceFactory: async ({ captureRoot }) => ({
        async execute({ envelope }) {
          sourceReads += 1
          await fs.mkdir(captureRoot, { recursive: true })
          return buildCapturePackage(captureRoot, envelope)
        },
        async verifyManifestWithLifecycle() {
          return { signatureVerified: true }
        },
      }),
      clock: () => NOW_MS,
      externalSystemRegistry: {
        async getExternalSystemForAdapter() {
          sourceLoads += 1
          return sourceSystem()
        },
      },
      identityKey: IDENTITY_KEY,
      persistStockPreparation: async ({ decoded }) => {
        persistCalls += 1
        assert.equal(decoded.intake.bomSnapshotLines.length, 2)
        return { externalWrite: false, persisted: true }
      },
      pipelineFactory: async () => pipeline,
      requestIdGenerator: () => 'request-s6a',
      runtimeStore,
    })
    const call = {
      actor: 'operator-s6a',
      operationId: 'operation-s6a',
      tenantId: 'tenant-s6a',
      workspaceId: null,
    }
    await refuses(
      () => runtime.run(call),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
    assert.equal(runtimeStore.snapshot().status, 'INGESTING')
    assert.equal(sourceReads, 1)
    await refuses(
      () => runtime.run(call),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
    assert.equal(
      runtimeStore.snapshot().status,
      'INGESTING',
      'upload completion survives interruption before markIngested',
    )
    assert.equal(sourceReads, 1)
    const completed = await runtime.run(call)
    assert.deepEqual(completed, {
      businessLineCount: 2,
      externalWrite: false,
      mode: 'internal_persist',
      replay: false,
      sourceReadCount: 1,
      status: 'COMPLETED',
      valuesFree: true,
    })
    assert.equal(sourceReads, 1, 'retry never re-reads the source')
    assert.equal(persistCalls, 1)
    runtimeStore.refuseAuthority()
    const sourceLoadsBeforeReplay = sourceLoads
    const replay = await runtime.run({
      ...call,
      actor: 'different-operator',
    })
    assert.deepEqual(replay, {
      businessLineCount: 2,
      externalWrite: false,
      mode: 'internal_noop',
      replay: true,
      sourceReadCount: 1,
      status: 'COMPLETED',
      valuesFree: true,
    })
    assert.equal(sourceReads, 1)
    assert.equal(
      sourceLoads,
      sourceLoadsBeforeReplay,
      'completed replay returns before loading source credentials',
    )

    await refuses(
      () => runtime.run({
        ...call,
        operationId: 'forbidden-input',
        sql: 'SELECT * FROM forbidden',
      }),
      'SEALED_EXPORT_INTERNAL_ERROR',
    )
    assert.equal(sourceReads, 1)

    console.log('sealed-export-s6a-runtime-core.test.cjs OK')
  } finally {
    await fs.rm(root, { force: true, recursive: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
