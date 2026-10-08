'use strict'

// Sealed-export S5 product composition root for
// sqlserver.sealed_snapshot.v1 (issue #4690).
//
// LATENT: no route, scheduler, runtime consumer, flag, or deployment wiring.
// This public factory is MSSQL-only. Hermetic rows, capture factories and
// clocks belong to test-support composition. Construction-bound observers are
// accepted only for first-party evidence; execute-time observer overrides are
// refused.

const canonicalCodec = require('./canonical-json.cjs')
const { failSealedExport } = require('./failure-vocabulary.cjs')
const {
  openMssqlSnapshotCaptureContext,
} = require('./sqlserver-sealed-snapshot-source-session.cjs')
const core = require('./sqlserver-sealed-snapshot-service-core.cjs')

const PRODUCT_CONFIG_FIELDS = Object.freeze([
  'approvedBindings',
  'artifactRoot',
  'authorityDb',
  'connectionConfig',
  'onReaderActive',
  'privateSignerMaterials',
  'qualificationKeyring',
  'stageObserver',
  'systemContentKey',
  'tenantId',
  'workspaceId',
])

const productServices = new WeakSet()

function isStrictObject(value) {
  return canonicalCodec.__internals.isStrictPlainObject(value)
}

function hasExactKeys(object, expectedKeys) {
  if (!isStrictObject(object)) return false
  const actual = Object.keys(object).sort()
  const expected = [...expectedKeys].sort()
  return (
    actual.length === expected.length &&
    actual.every((field, index) => field === expected[index])
  )
}

function createSqlServerSealedSnapshotService(rawConfig) {
  if (!hasExactKeys(rawConfig, PRODUCT_CONFIG_FIELDS)) {
    failSealedExport('SEALED_EXPORT_PROFILE_UNCERTIFIED')
  }
  const frozenConnection = canonicalCodec.tryFreezeCanonical(
    rawConfig.connectionConfig,
  )
  if (!frozenConnection.ok || !isStrictObject(frozenConnection.value)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const rawConnectionConfig = frozenConnection.value
  if (!isStrictObject(rawConnectionConfig.options)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const ownedConnection = canonicalCodec.tryFreezeCanonical({
    ...rawConnectionConfig,
    options: {
      ...rawConnectionConfig.options,
      readOnlyIntent: true,
    },
  })
  if (!ownedConnection.ok) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const connectionConfig = ownedConnection.value
  const coreService = core.createSqlServerSealedSnapshotServiceCore({
    approvedBindings: rawConfig.approvedBindings,
    artifactRoot: rawConfig.artifactRoot,
    authorityDb: rawConfig.authorityDb,
    onReaderActive: rawConfig.onReaderActive,
    openCaptureContext: (binding) =>
      openMssqlSnapshotCaptureContext({
        connectionConfig,
        tableRef: binding.tableRef,
      }),
    privateSignerMaterials: rawConfig.privateSignerMaterials,
    qualificationKeyring: rawConfig.qualificationKeyring,
    stageObserver: rawConfig.stageObserver,
    systemContentKey: rawConfig.systemContentKey,
    tenantId: rawConfig.tenantId,
    workspaceId: rawConfig.workspaceId,
  })
  const service = Object.freeze({
    actionId: coreService.actionId,
    distinctFromS2FixtureActionId: coreService.distinctFromS2FixtureActionId,
    implementationVersion: coreService.implementationVersion,
    profileId: coreService.profileId,
    getApprovedBinding: coreService.getApprovedBinding,
    probeQualificationForBinding: coreService.probeQualificationForBinding,
    verifyManifestWithLifecycle: coreService.verifyManifestWithLifecycle,
    verifyQualificationForBinding: coreService.verifyQualificationForBinding,
    async execute(input) {
      const result = await coreService.execute(input)
      if (
        result.evidence.actionToken !== 'SEALED_EXPORT_SQLSERVER_PRODUCT' ||
        result.evidence.outcome !==
          'SEALED_EXPORT_S5_PRODUCT_ACTION_CERTIFIED' ||
        result.evidence.proofClassToken !== 'SOURCE_SNAPSHOT_TXN'
      ) {
        failSealedExport('SEALED_EXPORT_PROFILE_UNCERTIFIED')
      }
      return result
    },
  })
  productServices.add(service)
  return service
}

function isSqlServerSealedSnapshotService(value) {
  return productServices.has(value)
}

module.exports = Object.freeze({
  createSqlServerSealedSnapshotService,
  isSqlServerSealedSnapshotService,
  FORBIDDEN_PUBLIC_EXPORT_NAMES: core.FORBIDDEN_PUBLIC_EXPORT_NAMES,
  EXECUTE_INPUT_FIELDS: core.EXECUTE_INPUT_FIELDS,
  FORBIDDEN_EXECUTE_KEYS: core.FORBIDDEN_EXECUTE_KEYS,
  PRODUCT_CONFIG_FIELDS,
})
