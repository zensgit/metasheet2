'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')

const EXPECTED_ENGINE_VERSIONS = Object.freeze(['2019', '2022'])
const INVALID_REASON = 'SEALED_EXPORT_S2_EVIDENCE_ARTIFACT_INVALID'

function fail() {
  throw new Error(INVALID_REASON)
}

function expectedRecord(engineMajorVersion) {
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

function assertEvidenceRecord(record, engineMajorVersion) {
  if (
    typeof record !== 'object' ||
    record === null ||
    Array.isArray(record) ||
    Object.getPrototypeOf(record) !== Object.prototype ||
    !isDeepStrictEqual(record, expectedRecord(engineMajorVersion))
  ) {
    fail()
  }
}

function verifySealedExportS2EvidenceArtifacts(evidenceRoot) {
  if (typeof evidenceRoot !== 'string' || evidenceRoot.length === 0) fail()
  const evidenceDir = path.join(evidenceRoot, 'producer')
  let entries
  try {
    entries = fs.readdirSync(evidenceDir, { withFileTypes: true })
  } catch {
    fail()
  }

  const expectedNames = EXPECTED_ENGINE_VERSIONS.map(
    (version) => `sealed-export-s2-producer-${version}.json`,
  )
  const actualNames = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
  if (
    entries.length !== expectedNames.length ||
    !isDeepStrictEqual(actualNames, expectedNames)
  ) {
    fail()
  }

  for (const engineMajorVersion of EXPECTED_ENGINE_VERSIONS) {
    const file = path.join(
      evidenceDir,
      `sealed-export-s2-producer-${engineMajorVersion}.json`,
    )
    let record
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      fail()
    }
    assertEvidenceRecord(record, engineMajorVersion)
  }

  return Object.freeze([...EXPECTED_ENGINE_VERSIONS])
}

if (require.main === module) {
  try {
    const verified = verifySealedExportS2EvidenceArtifacts(
      process.env.S2_EVIDENCE_DIR,
    )
    console.log(
      `SEALED_EXPORT_S2_EVIDENCE_ARTIFACTS_VERIFIED engines=${verified.join(
        ',',
      )}`,
    )
  } catch {
    console.error(INVALID_REASON)
    process.exitCode = 1
  }
}

module.exports = Object.freeze({
  verifySealedExportS2EvidenceArtifacts,
})
