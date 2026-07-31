'use strict'

const crypto = require('node:crypto')
const path = require('node:path')

const { createGenerationStore } = require('./generation-store.cjs')
const {
  createSealedExportGenerationKernel,
} = require('./generation-kernel.cjs')
const {
  createPrivateIngestionBlobStore,
} = require('./private-ingestion-blob-store.cjs')
const {
  createSqlServerPrivateIngestionManifestVerifier,
} = require('./private-ingestion-manifest-verifier.cjs')
const {
  createPrivateIngestionMetadataStore,
} = require('./private-ingestion-metadata-store.cjs')
const {
  createPrivateIngestionService,
} = require('./private-ingestion-service.cjs')
const {
  failSealedExport,
  isTrustedSealedExportError,
} = require('./failure-vocabulary.cjs')
const {
  createSqlServerSealedSnapshotService,
  isSqlServerSealedSnapshotService,
} = require('./sqlserver-sealed-snapshot-service.cjs')
const {
  createStockPreparationRuntimeCore,
} = require('./stock-preparation-runtime-core.cjs')
const {
  isStockPreparationRuntimeDatabase,
} = require('./stock-preparation-runtime-database.cjs')
const {
  createStockPreparationRuntimeStore,
} = require('./stock-preparation-runtime-store.cjs')
const {
  isStockPreparationRuntimePersistFailure,
} = require('./stock-preparation-runtime-persist.cjs')
const {
  StockPreparationSealedSnapshotDecodeError,
} = require('../stock-preparation-sealed-snapshot-decoder.cjs')

const productRuntimes = new WeakSet()

const CONFLICT_REASONS = new Set([
  'SEALED_EXPORT_ARTIFACT_EXPIRED',
  'SEALED_EXPORT_MANIFEST_REPLAYED',
  'SEALED_EXPORT_SIGNER_EXPIRED',
  'SEALED_EXPORT_SIGNER_REVOKED',
  'SEALED_EXPORT_VISIBILITY_CAS_CONFLICT',
])
const UNPROCESSABLE_REASONS = new Set([
  'SEALED_EXPORT_BINDING_UNQUALIFIED',
  'SEALED_EXPORT_BUDGET_EXCEEDED',
  'SEALED_EXPORT_CHUNK_DIGEST_MISMATCH',
  'SEALED_EXPORT_MANIFEST_BINDING_MISMATCH',
  'SEALED_EXPORT_MANIFEST_INVALID',
  'SEALED_EXPORT_MANIFEST_SCHEMA_MISMATCH',
  'SEALED_EXPORT_MANIFEST_SIGNATURE_INVALID',
  'SEALED_EXPORT_MANIFEST_SNAPSHOT_MISMATCH',
  'SEALED_EXPORT_PROFILE_UNCERTIFIED',
  'SEALED_EXPORT_ROW_COUNT_MISMATCH',
  'SEALED_EXPORT_SIGNER_UNENROLLED',
  'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE',
])

class StockPreparationSqlServerRuntimeError extends Error {
  constructor(status, code) {
    super('stock-preparation sealed-snapshot run was refused')
    this.name = 'StockPreparationSqlServerRuntimeError'
    this.status = status
    this.code = code
    this.details = Object.freeze({})
  }
}

function mapRuntimeError(error) {
  if (isStockPreparationRuntimePersistFailure(error)) {
    return new StockPreparationSqlServerRuntimeError(
      error.status,
      error.code,
    )
  }
  if (error instanceof StockPreparationSealedSnapshotDecodeError) {
    return new StockPreparationSqlServerRuntimeError(
      Number.isInteger(error.status) ? error.status : 422,
      error.code,
    )
  }
  if (isTrustedSealedExportError(error)) {
    const status = CONFLICT_REASONS.has(error.reason)
      ? 409
      : UNPROCESSABLE_REASONS.has(error.reason)
        ? 422
        : 503
    return new StockPreparationSqlServerRuntimeError(status, error.reason)
  }
  return new StockPreparationSqlServerRuntimeError(
    503,
    'SEALED_EXPORT_INTERNAL_ERROR',
  )
}

function ownedSignerMaterials(raw) {
  const materials = raw.map((entry) => {
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || Object.keys(entry).sort().join('\n')
        !== 'privateKey\nsignerKeyId'
      || typeof entry.signerKeyId !== 'string'
    ) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    return Object.freeze({
      privateKey: entry.privateKey,
      signerKeyId: entry.signerKeyId,
    })
  })
  return Object.freeze(materials)
}

function cloneQualificationKeyring(raw) {
  if (
    !raw
    || typeof raw !== 'object'
    || Array.isArray(raw)
    || Object.keys(raw).sort().join('\n') !== 'keyId\nsecret'
    || typeof raw.keyId !== 'string'
    || !(raw.secret instanceof Uint8Array)
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  return Object.freeze({
    keyId: raw.keyId,
    secret: Buffer.from(raw.secret),
  })
}

function createStockPreparationSqlServerRuntime({
  artifactRoot,
  clock = Date.now,
  evidenceKey,
  externalSystemRegistry,
  identityKey,
  persistStockPreparation,
  privateSignerMaterials,
  qualificationKeyring,
  runtimeDatabase,
} = {}) {
  if (
    typeof artifactRoot !== 'string'
    || artifactRoot.length < 1
    || typeof clock !== 'function'
    || !(evidenceKey instanceof Uint8Array)
    || evidenceKey.byteLength < 32
    || !externalSystemRegistry
    || typeof externalSystemRegistry.getExternalSystemForAdapter !== 'function'
    || !(identityKey instanceof Uint8Array)
    || identityKey.byteLength < 32
    || typeof persistStockPreparation !== 'function'
    || !Array.isArray(privateSignerMaterials)
    || privateSignerMaterials.length < 1
    || !qualificationKeyring
    || !isStockPreparationRuntimeDatabase(runtimeDatabase)
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const ownedEvidenceKey = Buffer.from(evidenceKey)
  const ownedIdentityKey = Buffer.from(identityKey)
  const ownedPrivateSignerMaterials = ownedSignerMaterials(
    privateSignerMaterials,
  )
  const ownedQualificationKeyring = cloneQualificationKeyring(
    qualificationKeyring,
  )
  const db = runtimeDatabase.db
  const runtimeStore = createStockPreparationRuntimeStore({ clock, db })
  const metadataStore = createPrivateIngestionMetadataStore({ db })
  const generationStore = createGenerationStore({ db })
  const ingestionRoot = path.join(
    path.resolve(artifactRoot),
    'private-ingestion',
  )
  const blobStore = createPrivateIngestionBlobStore({
    rootDir: ingestionRoot,
  })
  const clockDate = () => new Date(clock())

  const core = createStockPreparationRuntimeCore({
    artifactRoot,
    clock,
    evidenceKey: ownedEvidenceKey,
    externalSystemRegistry,
    identityKey: ownedIdentityKey,
    persistStockPreparation,
    requestIdGenerator: crypto.randomUUID,
    runtimeStore,
    captureServiceFactory({
      authority,
      binding,
      captureRoot,
      connectionConfig,
    }) {
      const service = createSqlServerSealedSnapshotService({
        approvedBindings: [{
          approvedConfigVersionId: binding.approvedConfigVersionId,
          bindingVersion: binding.bindingVersion,
          canonicalObjectVersion: binding.canonicalObjectVersion,
          configContentKey: binding.configContentKey,
          objectKey: binding.objectKey,
          relationId: binding.relationId,
          roleBindingFingerprint: binding.roleBindingFingerprint,
          tableRef: binding.tableRef,
          tenantDomainBinding: binding.tenantDomainBinding,
        }],
        artifactRoot: captureRoot,
        authorityDb: db,
        connectionConfig,
        onReaderActive: null,
        privateSignerMaterials: ownedPrivateSignerMaterials,
        qualificationKeyring: ownedQualificationKeyring,
        stageObserver: null,
        systemContentKey: authority.systemContentKey,
        tenantId: authority.tenantId,
        workspaceId: authority.workspaceId,
      })
      if (!isSqlServerSealedSnapshotService(service)) {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
      return service
    },
    pipelineFactory({ authority, captureService, envelope }) {
      const manifestVerifier =
        createSqlServerPrivateIngestionManifestVerifier({
          envelope,
          sealedSnapshotService: captureService,
        })
      const ingestionService = createPrivateIngestionService({
        authority,
        blobStore,
        clock: clockDate,
        manifestVerifier,
        metadataStore,
      })
      const kernel = createSealedExportGenerationKernel({
        authority,
        clock: clockDate,
        evidenceKey: ownedEvidenceKey,
        generationStore,
        ingestionSource: ingestionService,
      })
      return Object.freeze({ ingestionService, kernel })
    },
  })
  const runtime = Object.freeze({
    async run(input) {
      try {
        await runtimeDatabase.assertReady()
        return await core.run(input)
      } catch (error) {
        return Promise.reject(mapRuntimeError(error))
      }
    },
  })
  productRuntimes.add(runtime)
  return runtime
}

function isStockPreparationSqlServerRuntime(value) {
  return productRuntimes.has(value)
}

module.exports = Object.freeze({
  createStockPreparationSqlServerRuntime,
  isStockPreparationSqlServerRuntime,
  __internals: Object.freeze({
    mapRuntimeError,
  }),
})
