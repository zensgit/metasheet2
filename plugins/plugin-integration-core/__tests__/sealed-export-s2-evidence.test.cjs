'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const {
  verifySealedExportS2EvidenceArtifacts,
} = require(
  '../../../scripts/ops/verify-sealed-export-s2-sqlserver-evidence.cjs',
)

function record(engineMajorVersion) {
  return {
    evidenceSchemaVersion: 1,
    outcome: 'SEALED_EXPORT_S2_PRODUCER_FEASIBILITY_PROVEN',
    engineMajorVersion,
    namedActionAllowlisted: true,
    sourceReadCount: 1,
    sourceCaptureProofClass: 'SOURCE_SNAPSHOT_TXN',
    concurrentFixtureMutationApplied: true,
    completeSnapshotStateObserved: true,
    snapshotDisabledRefused: true,
    snapshotDisabledReason:
      'SEALED_EXPORT_SNAPSHOT_PROOF_UNAVAILABLE',
    rowCount: 600,
    chunkCount: 10,
    atLeastThreeChunks: true,
    productionDerivedManifest: true,
    readerExhaustedBeforeSigning: true,
    artifactFinalizedBeforeSigning: true,
    manifestFrozenBeforeSigning: true,
    signatureVerified: true,
    privateArtifactCleaned: true,
    runtimeReachable: false,
    customerSourceUsed: false,
    externalWrite: false,
  }
}

function writeRecord(root, version, value) {
  const directory = path.join(root, 'producer')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `sealed-export-s2-producer-${version}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
  )
}

function refuses(root) {
  assert.throws(
    () => verifySealedExportS2EvidenceArtifacts(root),
    /SEALED_EXPORT_S2_EVIDENCE_ARTIFACT_INVALID/,
  )
}

async function main() {
  const root = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'sealed-export-s2-evidence-test-'),
  )
  try {
    writeRecord(root, '2019', record('2019'))
    writeRecord(root, '2022', record('2022'))
    assert.deepEqual(
      verifySealedExportS2EvidenceArtifacts(root),
      ['2019', '2022'],
    )

    const file = path.join(
      root,
      'producer',
      'sealed-export-s2-producer-2022.json',
    )
    const original = fs.readFileSync(file, 'utf8')
    const mutated = record('2022')
    mutated.signatureVerified = false
    fs.writeFileSync(file, `${JSON.stringify(mutated)}\n`)
    refuses(root)
    fs.writeFileSync(file, original)

    const withValue = record('2022')
    withValue.sourceValue = 'must-not-enter-evidence'
    fs.writeFileSync(file, `${JSON.stringify(withValue)}\n`)
    refuses(root)
    fs.writeFileSync(file, original)

    fs.writeFileSync(
      path.join(root, 'producer', 'unexpected.json'),
      '{}\n',
    )
    refuses(root)
    fs.unlinkSync(path.join(root, 'producer', 'unexpected.json'))

    fs.unlinkSync(file)
    refuses(root)
    console.log('sealed-export S2 evidence verifier tests passed')
  } finally {
    await fsPromises.rm(root, { force: true, recursive: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
