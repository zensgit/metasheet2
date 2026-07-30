'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const {
  verifySealedExportS5EvidenceArtifacts,
} = require(
  '../../../scripts/ops/verify-sealed-export-s5-sqlserver-evidence.cjs',
)
const {
  SEALED_EXPORT_S2_ACTION_ID,
} = require('../lib/sealed-export/sqlserver-s2-producer.cjs')

function record(engineMajorVersion) {
  return {
    evidenceSchemaVersion: 1,
    outcome: 'SEALED_EXPORT_S5_PRODUCT_ACTION_CERTIFIED',
    engineMajorVersion,
    profileId: 'sqlserver.sealed_snapshot.v1',
    actionId: 'sealed_snapshot',
    implementationVersion: 'sealed-export.sqlserver.snapshot-action.v1',
    distinctFromS2FixtureAction: true,
    s2FixtureActionId: SEALED_EXPORT_S2_ACTION_ID,
    namedProductActionAllowlisted: true,
    approvedBindingResolved: true,
    dataStreamReadCount: 1,
    orderingProbeReadCount: 1,
    sourceCaptureProofClass: 'SOURCE_SNAPSHOT_TXN',
    immutableSnapshotTokenPresent: true,
    concurrentFixtureMutationApplied: true,
    concurrentMutationAffectedAllRows: true,
    completeSnapshotStateObserved: true,
    leastPrivilegeReadPrincipal: true,
    snapshotDisabledRefused: true,
    snapshotDisabledReason: 'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE',
    rowCount: 600,
    chunkCount: 10,
    atLeastThreeChunks: true,
    productionDerivedManifest: true,
    readerExhaustedBeforeSigning: true,
    artifactFinalizedBeforeSigning: true,
    manifestFrozenBeforeSigning: true,
    signatureVerified: true,
    privateArtifactCleaned: true,
    candidatePackageProvenanceVerified: true,
    externalPackagePinRequired: true,
    provenanceManifestDigest: 'a'.repeat(64),
    runtimeReachable: false,
    customerSourceUsed: false,
    externalWrite: false,
  }
}

function writeRecord(root, version, value) {
  const directory = path.join(root, 'product-action')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `sealed-export-s5-product-${version}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
  )
}

function refuses(root) {
  assert.throws(
    () => verifySealedExportS5EvidenceArtifacts(root),
    /SEALED_EXPORT_S5_EVIDENCE_ARTIFACT_INVALID/,
  )
}

async function main() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s5-evidence-test-'),
  )
  try {
    writeRecord(root, '2019', record('2019'))
    writeRecord(root, '2022', record('2022'))
    assert.deepEqual(verifySealedExportS5EvidenceArtifacts(root), [
      '2019',
      '2022',
    ])

    const file = path.join(
      root,
      'product-action',
      'sealed-export-s5-product-2022.json',
    )
    const original = fs.readFileSync(file, 'utf8')

    const asFixture = record('2022')
    asFixture.actionId = SEALED_EXPORT_S2_ACTION_ID
    fs.writeFileSync(file, `${JSON.stringify(asFixture)}\n`)
    refuses(root)
    fs.writeFileSync(file, original)

    const runtimeTrue = record('2022')
    runtimeTrue.runtimeReachable = true
    fs.writeFileSync(file, `${JSON.stringify(runtimeTrue)}\n`)
    refuses(root)
    fs.writeFileSync(file, original)

    const customerTrue = record('2022')
    customerTrue.customerSourceUsed = true
    fs.writeFileSync(file, `${JSON.stringify(customerTrue)}\n`)
    refuses(root)
    fs.writeFileSync(file, original)

    const unprovenMutation = record('2022')
    unprovenMutation.concurrentMutationAffectedAllRows = false
    fs.writeFileSync(file, `${JSON.stringify(unprovenMutation)}\n`)
    refuses(root)
    fs.writeFileSync(file, original)

    const mixedSnapshot = record('2022')
    mixedSnapshot.completeSnapshotStateObserved = false
    fs.writeFileSync(file, `${JSON.stringify(mixedSnapshot)}\n`)
    refuses(root)
    fs.writeFileSync(file, original)

    const privilegedSource = record('2022')
    privilegedSource.leastPrivilegeReadPrincipal = false
    fs.writeFileSync(file, `${JSON.stringify(privilegedSource)}\n`)
    refuses(root)
    fs.writeFileSync(file, original)

    const withValue = record('2022')
    withValue.sourceValue = 'must-not-enter-evidence'
    fs.writeFileSync(file, `${JSON.stringify(withValue)}\n`)
    refuses(root)
    fs.writeFileSync(file, original)

    fs.writeFileSync(
      path.join(root, 'product-action', 'unexpected.json'),
      '{}\n',
    )
    refuses(root)
    fs.unlinkSync(path.join(root, 'product-action', 'unexpected.json'))

    fs.unlinkSync(file)
    refuses(root)
    console.log('sealed-export S5 evidence verifier tests passed')
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
