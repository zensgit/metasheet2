'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

const canonicalCodec = require('./canonical-json.cjs')
const contracts = require('./contracts.cjs')
const digests = require('./digests.cjs')
const {
  failSealedExport,
  isTrustedSealedExportError,
} = require('./failure-vocabulary.cjs')
const {
  computeQueryBindingDigest,
  SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
  SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
} = require('./sqlserver-sealed-snapshot-action.cjs')
const {
  CANONICAL_OBJECT_VERSION,
  ROLE_ID,
  resolveStockPreparationSqlServerSource,
} = require('./stock-preparation-sqlserver-source-authority.cjs')
const {
  isStockPreparationRuntimePersistFailure,
} = require('./stock-preparation-runtime-persist.cjs')
const {
  MAX_BUSINESS_LINES,
  StockPreparationSealedSnapshotDecodeError,
  decodeStockPreparationSealedSnapshotRows,
} = require('../stock-preparation-sealed-snapshot-decoder.cjs')

const BYTE_BUDGET = 256 * 1024 * 1024
const CHUNK_BUDGET = 256
const ENVELOPE_TTL_MS = 15 * 60 * 1000
const PAGE_SIZE = 1000
const RUN_INPUT_FIELDS = Object.freeze([
  'actor',
  'operationId',
  'tenantId',
  'workspaceId',
])

function requiredText(value, maxLength = 256) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || value.trim() !== value
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
  }
  return value
}

function normalizeRunInput(raw) {
  const cloned = canonicalCodec.tryFreezeCanonical(raw)
  if (
    !cloned.ok
    || !canonicalCodec.__internals.isStrictPlainObject(cloned.value)
    || Object.keys(cloned.value).sort().join('\n')
      !== [...RUN_INPUT_FIELDS].sort().join('\n')
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const input = cloned.value
  const workspaceId = input.workspaceId === null
    ? null
    : requiredText(input.workspaceId)
  return Object.freeze({
    actor: requiredText(input.actor),
    operationId: requiredText(input.operationId),
    tenantId: requiredText(input.tenantId),
    workspaceId,
  })
}

function withinRoot(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

function validateArtifactCheckpoint(checkpoint, captureRoot) {
  const directory = path.resolve(checkpoint.artifactDirectory)
  const root = path.resolve(captureRoot)
  if (
    !withinRoot(root, directory)
    || !Array.isArray(checkpoint.chunkPaths)
    || checkpoint.chunkPaths.length !== checkpoint.manifest.chunks.length
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const chunkPaths = checkpoint.chunkPaths.map((candidate) => {
    const resolved = path.resolve(requiredText(candidate, 4096))
    if (!withinRoot(directory, resolved)) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    return resolved
  })
  return Object.freeze({ chunkPaths: Object.freeze(chunkPaths), directory })
}

function envelopeExpiry(nowMs, binding, authority) {
  const expiry = Math.min(
    nowMs + ENVELOPE_TTL_MS,
    Date.parse(binding.expiresAt),
    Date.parse(authority.bindingExpiresAt),
    Date.parse(authority.qualificationExpiresAt),
    Date.parse(authority.signerExpiresAt),
  )
  if (!Number.isFinite(expiry) || expiry <= nowMs) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  return new Date(expiry).toISOString()
}

function buildEnvelope({
  authority,
  binding,
  nowMs,
  requestId,
}) {
  return contracts.validateExportRequestEnvelope({
    actionProfileVersion: SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
    applyProfileVersion: 'STAGED_GENERATION',
    approvedConfigVersionId: binding.approvedConfigVersionId,
    bindingVersion: binding.bindingVersion,
    byteBudget: BYTE_BUDGET,
    canonicalObjectVersion: binding.canonicalObjectVersion,
    chunkBudget: CHUNK_BUDGET,
    configContentKey: binding.configContentKey,
    executionMode: 'S6A_CONTROLLED_RUNTIME',
    expectedSourceSchemaFieldMapDigest:
      SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
    expiry: envelopeExpiry(nowMs, binding, authority),
    exportRequestId: requestId,
    nonce: requestId,
    qualificationDigest: authority.qualificationDigest,
    queryObjectFilterBindingDigest: computeQueryBindingDigest({
      objectKey: binding.objectKey,
      relationId: binding.relationId,
      tableRef: binding.tableRef,
    }),
    roleBindingFingerprint: binding.roleBindingFingerprint,
    roleId: ROLE_ID,
    rowBudget: MAX_BUSINESS_LINES,
    scenarioVersion: 'stock-preparation.v1',
    systemContentKey: binding.systemContentKey,
    tenantDomainBinding: binding.tenantDomainBinding,
  })
}

function createStockPreparationRuntimeCore({
  artifactRoot,
  captureServiceFactory,
  clock = Date.now,
  externalSystemRegistry,
  identityKey,
  persistStockPreparation,
  pipelineFactory,
  requestIdGenerator,
  runtimeStore,
} = {}) {
  if (
    typeof artifactRoot !== 'string'
    || artifactRoot.length < 1
    || typeof captureServiceFactory !== 'function'
    || typeof clock !== 'function'
    || !externalSystemRegistry
    || typeof externalSystemRegistry.getExternalSystemForSealedSnapshot !== 'function'
    || !(identityKey instanceof Uint8Array)
    || typeof persistStockPreparation !== 'function'
    || typeof pipelineFactory !== 'function'
    || typeof requestIdGenerator !== 'function'
    || !runtimeStore
    || [
      'loadActiveBinding',
      'loadCurrentAuthority',
      'markActivated',
      'markCaptured',
      'markCaptureFailed',
      'markCompleted',
      'markGenerationVerified',
      'markIngested',
      'markIngestionStarted',
      'openRun',
      'readPrivateCheckpoint',
    ].some((name) => typeof runtimeStore[name] !== 'function')
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const captureRoot = path.join(path.resolve(artifactRoot), 'capture')

  function nowMs() {
    let value
    try {
      value = clock()
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (!Number.isFinite(value)) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    return value
  }

  async function privateBoundary(action) {
    try {
      return await action()
    } catch (error) {
      if (
        isTrustedSealedExportError(error)
        || isStockPreparationRuntimePersistFailure(error)
        || error instanceof StockPreparationSealedSnapshotDecodeError
      ) {
        return Promise.reject(error)
      }
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
  }

  async function loadSource(binding, scope, principal) {
    return privateBoundary(async () => {
      const externalSystem =
        await externalSystemRegistry.getExternalSystemForSealedSnapshot({
          id: binding.externalSystemId,
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          // This runtime is reachable only through the admin-authenticated HTTP
          // handler, which derives `actor` from the host user. Reuse that same
          // server-held identity as the Connection owner principal; never infer
          // an owner from the Binding or silently promote the run to service.
          principal,
          runAs: 'user',
        })
      return resolveStockPreparationSqlServerSource({
        binding,
        externalSystem,
        identityKey,
      })
    })
  }

  async function readArtifactChunk(candidate) {
    try {
      return await fs.readFile(candidate)
    } catch {
      failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')
    }
  }

  async function runInternal(rawInput) {
    const input = normalizeRunInput(rawInput)
    const scope = Object.freeze({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
    })
    const binding = await runtimeStore.loadActiveBinding(scope)
    let handle = await runtimeStore.openRun({
      actor: input.actor,
      binding,
      operationId: input.operationId,
      scope,
    })
    if (handle.status === 'COMPLETED') {
      if (
        !Number.isInteger(handle.businessLineCount)
        || handle.businessLineCount < 1
        || handle.businessLineCount > MAX_BUSINESS_LINES
      ) {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
      return Object.freeze({
        businessLineCount: handle.businessLineCount,
        externalWrite: false,
        mode: 'internal_noop',
        replay: true,
        sourceReadCount: 1,
        status: 'COMPLETED',
        valuesFree: true,
      })
    }

    let authorityState
    let source
    let captureService
    try {
      authorityState = await runtimeStore.loadCurrentAuthority(binding)
      source = await loadSource(binding, scope, input.actor)
      captureService = await captureServiceFactory({
        authority: source.authority,
        binding,
        captureRoot,
        connectionConfig: source.connectionConfig,
      })
      if (
        !captureService
        || typeof captureService.execute !== 'function'
        || typeof captureService.verifyManifestWithLifecycle !== 'function'
      ) {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    } catch (error) {
      if (handle.status === 'CAPTURING') {
        await runtimeStore.markCaptureFailed(
          handle,
          isTrustedSealedExportError(error)
            ? error.reason
            : 'SEALED_EXPORT_INTERNAL_ERROR',
        )
      }
      if (isTrustedSealedExportError(error)) return Promise.reject(error)
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }

    let checkpoint = handle.status === 'CAPTURING'
      ? null
      : await runtimeStore.readPrivateCheckpoint(handle)
    if (handle.status === 'CAPTURING') {
      const requestId = requiredText(requestIdGenerator())
      const envelope = buildEnvelope({
        authority: authorityState,
        binding,
        nowMs: nowMs(),
        requestId,
      })
      try {
        const capture = await captureService.execute({ envelope })
        const manifest = contracts.validateSignedManifest(capture.manifest)
        contracts.verifyManifestBinding(envelope, manifest)
        const manifestDigest = contracts.computeManifestDigest(manifest)
        if (
          !capture.evidence
          || capture.evidence.dataStreamReadCount !== 1
          || manifest.totalRows < 1
          || manifest.totalRows > MAX_BUSINESS_LINES
          || !digests.constantTimeEqualDigest(
            manifestDigest,
            capture.manifestDigest,
          )
          || !capture.artifact
          || !Array.isArray(capture.artifact.chunkPaths)
        ) {
          failSealedExport('SEALED_EXPORT_ROW_COUNT_MISMATCH')
        }
        handle = await runtimeStore.markCaptured(handle, {
          artifactDirectory: capture.artifact.directory,
          chunkPaths: capture.artifact.chunkPaths,
          envelope,
          manifest,
          manifestDigest,
        })
        checkpoint = await runtimeStore.readPrivateCheckpoint(handle)
      } catch (error) {
        await runtimeStore.markCaptureFailed(
          handle,
          isTrustedSealedExportError(error)
            ? error.reason
            : 'SEALED_EXPORT_INTERNAL_ERROR',
        )
        if (isTrustedSealedExportError(error)) return Promise.reject(error)
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    const pipeline = await privateBoundary(() => pipelineFactory({
      authority: source.authority,
      captureService,
      envelope: checkpoint.envelope,
    }))
    if (
      !pipeline
      || !pipeline.ingestionService
      || !pipeline.kernel
    ) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    const ingestion = pipeline.ingestionService
    const kernel = pipeline.kernel

    if (handle.status === 'CAPTURED') {
      const created = await ingestion.createSession({
        envelope: checkpoint.envelope,
        manifest: checkpoint.manifest,
      })
      handle = await runtimeStore.markIngestionStarted(
        handle,
        created.sessionId,
      )
      checkpoint = await runtimeStore.readPrivateCheckpoint(handle)
    }

    if (handle.status === 'INGESTING') {
      const artifact = validateArtifactCheckpoint(checkpoint, captureRoot)
      const resumed = await ingestion.resumeSession({
        sessionId: checkpoint.ingestionSessionId,
      })
      if (resumed.status === 'UPLOADING') {
        if (!Array.isArray(resumed.acceptedChunkIndexes)) {
          failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
        }
        const accepted = new Set(resumed.acceptedChunkIndexes)
        for (let index = 0; index < artifact.chunkPaths.length; index += 1) {
          if (accepted.has(index)) continue
          await ingestion.submitChunk({
            bytes: await readArtifactChunk(artifact.chunkPaths[index]),
            chunkIndex: index,
            sessionId: checkpoint.ingestionSessionId,
          })
        }
        const completed = await ingestion.completeSession({
          sessionId: checkpoint.ingestionSessionId,
        })
        if (
          completed.status !== 'UPLOAD_COMPLETE'
          || completed.artifactDigestVerified !== true
        ) {
          failSealedExport('SEALED_EXPORT_ARTIFACT_DIGEST_MISMATCH')
        }
      } else if (
        resumed.status !== 'UPLOAD_COMPLETE'
        || resumed.artifactDigestVerified !== true
      ) {
        failSealedExport('SEALED_EXPORT_ARTIFACT_DIGEST_MISMATCH')
      }
      handle = await runtimeStore.markIngested(handle)
      checkpoint = await runtimeStore.readPrivateCheckpoint(handle)
    }

    if (handle.status === 'INGESTED') {
      const sealed = await kernel.stageAndSeal({
        sessionId: checkpoint.ingestionSessionId,
      })
      if (
        typeof sealed.generationId !== 'string'
        || !['SEALED', 'APPLYING', 'VERIFIED', 'ACTIVE'].includes(sealed.status)
      ) {
        failSealedExport('SEALED_EXPORT_GENERATION_VERIFY_FAILED')
      }
      if (sealed.status === 'SEALED' || sealed.status === 'APPLYING') {
        const lease = await kernel.beginApply({
          generationId: sealed.generationId,
        })
        let applied = await kernel.applyNextChunk({ lease })
        let iterations = 1
        while (applied.status === 'APPLYING') {
          if (iterations > MAX_BUSINESS_LINES + 1) {
            failSealedExport('SEALED_EXPORT_APPLY_INCOMPLETE')
          }
          applied = await kernel.applyNextChunk({ lease })
          iterations += 1
        }
        if (applied.status !== 'VERIFIED') {
          failSealedExport('SEALED_EXPORT_APPLY_INCOMPLETE')
        }
      }
      handle = await runtimeStore.markGenerationVerified(
        handle,
        sealed.generationId,
      )
      checkpoint = await runtimeStore.readPrivateCheckpoint(handle)
    }

    let activation
    if (handle.status === 'GENERATION_VERIFIED') {
      const expectation = await kernel.createActivationExpectation({
        canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
      })
      activation = await kernel.activateWithExpectation({
        expectation,
        generationId: checkpoint.generationId,
      })
      handle = await runtimeStore.markActivated(handle)
      checkpoint = await runtimeStore.readPrivateCheckpoint(handle)
    } else if (handle.status === 'ACTIVATED') {
      const expectation = await kernel.createActivationExpectation({
        canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
      })
      activation = await kernel.activateWithExpectation({
        expectation,
        generationId: checkpoint.generationId,
      })
    }

    if (handle.status !== 'ACTIVATED' || !activation) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    const descriptor = await kernel.createReadDescriptorForActivation({
      activation,
    })
    if (
      descriptor.appliedRowCount < 1
      || descriptor.appliedRowCount > MAX_BUSINESS_LINES
    ) {
      return Promise.reject(new StockPreparationSealedSnapshotDecodeError(
        'STOCK_PREPARATION_SEALED_SNAPSHOT_BUDGET_EXCEEDED',
        {
          observedCount: descriptor.appliedRowCount,
          permittedCount: MAX_BUSINESS_LINES,
        },
      ))
    }
    const rows = []
    for (
      let offset = 0;
      offset < descriptor.appliedRowCount;
      offset += PAGE_SIZE
    ) {
      const page = await kernel.readPinnedRows({
        descriptor,
        limit: Math.min(PAGE_SIZE, descriptor.appliedRowCount - offset),
        offset,
      })
      rows.push(...page)
    }
    if (rows.length !== descriptor.appliedRowCount) {
      failSealedExport('SEALED_EXPORT_GENERATION_VERIFY_FAILED')
    }
    const decoded = decodeStockPreparationSealedSnapshotRows({
      actor: checkpoint.actor,
      rows,
      startedAt: checkpoint.startedAt,
    })
    const persisted = await privateBoundary(() => persistStockPreparation({
      decoded,
      scope,
    }))
    if (
      !persisted
      || typeof persisted.persisted !== 'boolean'
      || persisted.externalWrite !== false
    ) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    handle = await runtimeStore.markCompleted(
      handle,
      decoded.request.syncRunId,
      rows.length,
    )
    return Object.freeze({
      businessLineCount: rows.length,
      externalWrite: false,
      mode: persisted.persisted ? 'internal_persist' : 'internal_noop',
      replay: false,
      sourceReadCount: 1,
      status: handle.status,
      valuesFree: true,
    })
  }

  return Object.freeze({
    run(rawInput) {
      return privateBoundary(() => runInternal(rawInput))
    },
  })
}

module.exports = Object.freeze({
  BYTE_BUDGET,
  CHUNK_BUDGET,
  PAGE_SIZE,
  RUN_INPUT_FIELDS,
  createStockPreparationRuntimeCore,
})
