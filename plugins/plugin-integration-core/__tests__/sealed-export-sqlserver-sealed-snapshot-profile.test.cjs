'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
  SQLSERVER_SEALED_SNAPSHOT_CONNECTOR_KIND,
  SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
  SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
  SQLSERVER_SEALED_SNAPSHOT_PROFILE,
  SQLSERVER_SEALED_SNAPSHOT_RECOVERY_STRATEGY,
  successfulSealedSnapshotCompletenessEvidence,
  assertSealedSnapshotCompletenessEvidence,
} = require(
  '../lib/sealed-export/sqlserver-sealed-snapshot-profile.cjs',
)
const {
  deriveRecoveryStrategy,
  GipProfileContractError,
} = require('../lib/gip-profile-certification-contracts.cjs')
const {
  runReadActionProfileComplianceBattery,
  summarizeBatteryForEvidence,
} = require('../lib/gip-profile-compliance-harness.cjs')
const {
  SEALED_EXPORT_S2_ACTION_ID,
} = require('../lib/sealed-export/sqlserver-s2-producer.cjs')

function profileCoordinatesExact() {
  const profile = SQLSERVER_SEALED_SNAPSHOT_PROFILE
  assert.equal(profile.profileId, 'sqlserver.sealed_snapshot.v1')
  assert.equal(profile.profileId, SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID)
  assert.equal(profile.connectorKind, 'data-source:sql-readonly')
  assert.equal(profile.connectorKind, SQLSERVER_SEALED_SNAPSHOT_CONNECTOR_KIND)
  assert.equal(profile.actionId, 'sealed_snapshot')
  assert.equal(profile.actionId, SQLSERVER_SEALED_SNAPSHOT_ACTION_ID)
  assert.equal(
    profile.implementationVersion,
    'sealed-export.sqlserver.snapshot-action.v1',
  )
  assert.equal(
    profile.implementationVersion,
    SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
  )
  assert.equal(profile.certificate.acquisitionMode, 'SEALED_EXPORT')
  assert.deepEqual(
    [...profile.certificate.supportedConsistencyProofs].sort(),
    ['IMMUTABLE_SNAPSHOT_TOKEN', 'SOURCE_SNAPSHOT_TXN'],
  )
  assert.equal(profile.certificate.continuationLifetime, 'DURABLE_TOKEN')
  assert.deepEqual(
    [...profile.certificate.supportedCompletenessProofs],
    ['SIGNED_MANIFEST'],
  )
  assert.equal(SQLSERVER_SEALED_SNAPSHOT_RECOVERY_STRATEGY, 'CHUNK_RESUME')
  assert.equal(
    deriveRecoveryStrategy(profile.certificate),
    'CHUNK_RESUME',
  )
  assert.notEqual(profile.actionId, SEALED_EXPORT_S2_ACTION_ID)
  assert.notEqual(
    profile.implementationVersion,
    'sealed-export-s2-sqlserver-v1',
  )
}

function completenessEvidencePinsSignedManifest() {
  const evidence = successfulSealedSnapshotCompletenessEvidence()
  assert.equal(evidence.runOutcome, 'successful')
  assert.deepEqual([...evidence.usedCompletenessProofs], ['SIGNED_MANIFEST'])

  assert.throws(
    () =>
      assertSealedSnapshotCompletenessEvidence({
        runOutcome: 'successful',
        usedCompletenessProofs: ['SHORT_PAGE'],
      }),
    (error) => error instanceof GipProfileContractError,
  )
}

function complianceBatteryPasses() {
  // normalizeCertifiedReadActionProfile emits actionProfileVersion; the battery
  // re-normalizes the candidate input shape and refuses that emitted field.
  const {
    actionProfileVersion: _emittedVersion,
    ...candidate
  } = SQLSERVER_SEALED_SNAPSHOT_PROFILE
  const battery = runReadActionProfileComplianceBattery(candidate)
  const summary = summarizeBatteryForEvidence(battery)
  assert.equal(summary.passed, true)
  assert.deepEqual(summary.failedCheckIds, [])
}

function main() {
  profileCoordinatesExact()
  completenessEvidencePinsSignedManifest()
  complianceBatteryPasses()
  console.log('sealed-export-sqlserver-sealed-snapshot-profile.test.cjs OK')
}

main()
