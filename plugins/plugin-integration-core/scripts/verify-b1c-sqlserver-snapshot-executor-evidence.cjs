'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')

const EXPECTED_ENGINE_VERSIONS = Object.freeze(['2019', '2022'])
const INVALID_REASON = 'B1C_EXECUTOR_EVIDENCE_ARTIFACT_INVALID'

function fail() {
  throw new Error(INVALID_REASON)
}

function expectedRecord(engineMajorVersion) {
  return {
    evidenceSchemaVersion: 1,
    outcome: 'SQLSERVER_SNAPSHOT_EXECUTOR_PATH_PROVEN',
    engineMajorVersion,
    profileId: 'sqlserver.snapshot_paged_read.v1',
    consistencyProof: 'SOURCE_SNAPSHOT_TXN',
    continuationLifetime: 'CONNECTION_BOUND',
    completenessProof: 'SHORT_PAGE',
    pageSize: 3,
    pageCount: 3,
    totalRowCount: 8,
    sameSessionAcrossPages: true,
    snapshotTransactionObserved: true,
    runtimeReachable: false,
    customerSourceUsed: false,
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

function verifyExecutorEvidenceArtifacts(evidenceRoot) {
  if (typeof evidenceRoot !== 'string' || evidenceRoot.length === 0) fail()
  const evidenceDir = path.join(evidenceRoot, 'executor')
  let entries
  try {
    entries = fs.readdirSync(evidenceDir, { withFileTypes: true })
  } catch {
    fail()
  }

  const expectedNames = EXPECTED_ENGINE_VERSIONS.map(
    (version) => `sqlserver-snapshot-executor-${version}.json`,
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
      `sqlserver-snapshot-executor-${engineMajorVersion}.json`,
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
    const verified = verifyExecutorEvidenceArtifacts(
      process.env.B1C_EVIDENCE_DIR,
    )
    console.log(
      `B1C_EXECUTOR_EVIDENCE_ARTIFACTS_VERIFIED engines=${verified.join(',')}`,
    )
  } catch {
    console.error(INVALID_REASON)
    process.exitCode = 1
  }
}

module.exports = Object.freeze({
  verifyExecutorEvidenceArtifacts,
})
