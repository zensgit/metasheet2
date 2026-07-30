'use strict'

// Values-free evidence verifier for sealed-export S5 product-action runs.
// Distinguishes the product action from the S2 fixture and requires
// runtimeReachable=false and customerSourceUsed=false.

const fs = require('node:fs')
const path = require('node:path')

const {
  SEALED_EXPORT_S2_ACTION_ID,
} = require(
  '../../plugins/plugin-integration-core/lib/sealed-export/sqlserver-s2-producer.cjs',
)
const {
  SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
  SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
  SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
} = require(
  '../../plugins/plugin-integration-core/lib/sealed-export/sqlserver-sealed-snapshot-action.cjs',
)
const {
  verifySealedExportPackageProvenance,
} = require(
  '../../plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs',
)

const REQUIRED_ENGINE_VERSIONS = Object.freeze(['2019', '2022'])
const REQUIRED_FIELDS = Object.freeze([
  'evidenceSchemaVersion',
  'outcome',
  'engineMajorVersion',
  'profileId',
  'actionId',
  'implementationVersion',
  'distinctFromS2FixtureAction',
  's2FixtureActionId',
  'namedProductActionAllowlisted',
  'approvedBindingResolved',
  'dataStreamReadCount',
  'orderingProbeReadCount',
  'sourceCaptureProofClass',
  'immutableSnapshotTokenPresent',
  'concurrentFixtureMutationApplied',
  'concurrentMutationAffectedAllRows',
  'completeSnapshotStateObserved',
  'leastPrivilegeReadPrincipal',
  'snapshotDisabledRefused',
  'snapshotDisabledReason',
  'rowCount',
  'chunkCount',
  'atLeastThreeChunks',
  'productionDerivedManifest',
  'readerExhaustedBeforeSigning',
  'artifactFinalizedBeforeSigning',
  'manifestFrozenBeforeSigning',
  'signatureVerified',
  'privateArtifactCleaned',
  'candidatePackageProvenanceVerified',
  'externalPackagePinRequired',
  'provenanceManifestDigest',
  'runtimeReachable',
  'customerSourceUsed',
  'externalWrite',
])

const FORBIDDEN_KEYS = Object.freeze([
  'sourceValue',
  'password',
  'connectionString',
  'privateKey',
  'sql',
  'table',
  'endpoint',
  'path',
  'credential',
])

function fail() {
  throw new Error('SEALED_EXPORT_S5_EVIDENCE_ARTIFACT_INVALID')
}

function assertExactRecord(value, engineMajorVersion, provenanceManifestDigest) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const keys = Object.keys(value).sort()
  const expected = [...REQUIRED_FIELDS].sort()
  if (
    keys.length !== expected.length ||
    keys.some((field, index) => field !== expected[index])
  ) {
    fail()
  }
  for (const forbidden of FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, forbidden)) fail()
  }
  if (value.evidenceSchemaVersion !== 1) fail()
  if (value.outcome !== 'SEALED_EXPORT_S5_PRODUCT_ACTION_CERTIFIED') fail()
  if (value.engineMajorVersion !== engineMajorVersion) fail()
  if (value.profileId !== SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID) fail()
  if (value.actionId !== SQLSERVER_SEALED_SNAPSHOT_ACTION_ID) fail()
  if (value.actionId === SEALED_EXPORT_S2_ACTION_ID) fail()
  if (
    value.implementationVersion !==
    SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION
  ) {
    fail()
  }
  if (value.distinctFromS2FixtureAction !== true) fail()
  if (value.s2FixtureActionId !== SEALED_EXPORT_S2_ACTION_ID) fail()
  if (value.namedProductActionAllowlisted !== true) fail()
  if (value.approvedBindingResolved !== true) fail()
  if (value.dataStreamReadCount !== 1) fail()
  if (value.orderingProbeReadCount !== 1) fail()
  if (value.sourceCaptureProofClass !== 'SOURCE_SNAPSHOT_TXN') fail()
  if (value.immutableSnapshotTokenPresent !== true) fail()
  if (value.concurrentFixtureMutationApplied !== true) fail()
  if (value.concurrentMutationAffectedAllRows !== true) fail()
  if (value.completeSnapshotStateObserved !== true) fail()
  if (value.leastPrivilegeReadPrincipal !== true) fail()
  if (value.snapshotDisabledRefused !== true) fail()
  if (
    value.snapshotDisabledReason !==
    'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE'
  ) {
    fail()
  }
  if (!Number.isSafeInteger(value.rowCount) || value.rowCount < 1) fail()
  if (!Number.isSafeInteger(value.chunkCount) || value.chunkCount < 3) fail()
  if (value.atLeastThreeChunks !== true) fail()
  if (value.productionDerivedManifest !== true) fail()
  if (value.readerExhaustedBeforeSigning !== true) fail()
  if (value.artifactFinalizedBeforeSigning !== true) fail()
  if (value.manifestFrozenBeforeSigning !== true) fail()
  if (value.signatureVerified !== true) fail()
  if (value.privateArtifactCleaned !== true) fail()
  if (value.candidatePackageProvenanceVerified !== true) fail()
  if (value.externalPackagePinRequired !== true) fail()
  if (
    typeof value.provenanceManifestDigest !== 'string' ||
    value.provenanceManifestDigest !== provenanceManifestDigest
  ) {
    fail()
  }
  if (value.runtimeReachable !== false) fail()
  if (value.customerSourceUsed !== false) fail()
  if (value.externalWrite !== false) fail()
}

function verifySealedExportS5EvidenceArtifacts(root) {
  if (typeof root !== 'string' || root.length === 0) fail()
  let packageResult
  try {
    packageResult = verifySealedExportPackageProvenance({
      repoRoot: path.resolve(__dirname, '../..'),
    })
  } catch {
    fail()
  }
  if (
    packageResult.verified !== true ||
    packageResult.candidateTreeVerified !== true ||
    packageResult.externalPackagePinRequired !== true
  ) {
    fail()
  }
  const directory = path.join(root, 'product-action')
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    fail()
  }
  const names = fs.readdirSync(directory).sort()
  const expectedNames = REQUIRED_ENGINE_VERSIONS.map(
    (version) => `sealed-export-s5-product-${version}.json`,
  )
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    fail()
  }
  for (const version of REQUIRED_ENGINE_VERSIONS) {
    const file = path.join(
      directory,
      `sealed-export-s5-product-${version}.json`,
    )
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      fail()
    }
    assertExactRecord(
      parsed,
      version,
      packageResult.frozenManifestDigest,
    )
  }
  return [...REQUIRED_ENGINE_VERSIONS]
}

function main() {
  const root = process.env.S5_EVIDENCE_DIR
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('SEALED_EXPORT_S5_EVIDENCE_ARTIFACT_INVALID')
  }
  const versions = verifySealedExportS5EvidenceArtifacts(root)
  console.log(
    JSON.stringify({
      ok: true,
      versions,
      actionId: SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
      profileId: SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
      runtimeReachable: false,
      customerSourceUsed: false,
    }),
  )
}

if (require.main === module) {
  main()
}

module.exports = Object.freeze({
  verifySealedExportS5EvidenceArtifacts,
})
