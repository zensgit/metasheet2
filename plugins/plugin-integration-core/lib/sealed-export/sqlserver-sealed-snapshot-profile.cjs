'use strict'

// Sealed-export S5 — certified product profile for direct SQL Server sealed
// snapshot (issue #4690).
//
// LATENT: no route, scheduler, runtime consumer, flag, deployment, or external
// write. This module freezes the exact owner-ratified coordinates and the
// derived recovery strategy. It does not execute SQL and does not relabel the
// S2 fixture action as a production surface.

const {
  normalizeCertifiedReadActionProfile,
  deriveRecoveryStrategy,
  validateCompletenessEvidence,
} = require('../gip-profile-certification-contracts.cjs')
const {
  SEALED_EXPORT_FAILURE_REASONS,
} = require('./failure-vocabulary.cjs')

const SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID = 'sqlserver.sealed_snapshot.v1'
const SQLSERVER_SEALED_SNAPSHOT_CONNECTOR_KIND = 'data-source:sql-readonly'
const SQLSERVER_SEALED_SNAPSHOT_ACTION_ID = 'sealed_snapshot'
const SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION =
  'sealed-export.sqlserver.snapshot-action.v1'

const SQLSERVER_SEALED_SNAPSHOT_PROFILE = normalizeCertifiedReadActionProfile({
  profileId: SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
  connectorKind: SQLSERVER_SEALED_SNAPSHOT_CONNECTOR_KIND,
  actionId: SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
  implementationVersion: SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
  certificate: {
    acquisitionMode: 'SEALED_EXPORT',
    supportedConsistencyProofs: [
      'SOURCE_SNAPSHOT_TXN',
      'IMMUTABLE_SNAPSHOT_TOKEN',
    ],
    continuationLifetime: 'DURABLE_TOKEN',
    supportedCompletenessProofs: ['SIGNED_MANIFEST'],
    completenessCombinationRules: [['SIGNED_MANIFEST']],
    maxScale: {
      runtimeScaleCertified: false,
      adjudicationBoundedToEvidenceEnvelope: true,
      evidenceEnvelope: {
        engineMajors: Object.freeze(['2019', '2022']),
        customerScope: 'SINGLE_CUSTOMER',
        sourceMode: 'READ_ONLY',
        externalWrite: false,
      },
    },
    orderingKeyRequirement: {
      required: true,
      kind: 'STABLE_UNIQUE_NON_NULL_TOTAL_ORDER',
      qualification: 'SEALED_EXPORT_BINDING_QUALIFICATION_REQUIRED',
    },
    manifestShape: {
      kind: 'SIGNED_MANIFEST',
      signatureAlgorithm: 'ED25519',
      sourceCaptureProofClassRequired: 'SOURCE_SNAPSHOT_TXN',
      durableArtifactToken: 'IMMUTABLE_SNAPSHOT_TOKEN',
      callerSuppliedSqlForbidden: true,
      callerSuppliedSignerMaterialForbidden: true,
    },
    tokenShape: {
      kind: 'IMMUTABLE_SNAPSHOT_TOKEN',
      durable: true,
      bindsManifestDigest: true,
      notSourceTimeProof: true,
    },
    failureVocabulary: [...SEALED_EXPORT_FAILURE_REASONS],
  },
})

const SQLSERVER_SEALED_SNAPSHOT_RECOVERY_STRATEGY = deriveRecoveryStrategy(
  SQLSERVER_SEALED_SNAPSHOT_PROFILE.certificate,
)

function assertSealedSnapshotCompletenessEvidence(evidence) {
  return validateCompletenessEvidence(
    SQLSERVER_SEALED_SNAPSHOT_PROFILE,
    evidence,
  )
}

function successfulSealedSnapshotCompletenessEvidence() {
  return assertSealedSnapshotCompletenessEvidence({
    runOutcome: 'successful',
    usedCompletenessProofs: ['SIGNED_MANIFEST'],
  })
}

module.exports = Object.freeze({
  SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
  SQLSERVER_SEALED_SNAPSHOT_CONNECTOR_KIND,
  SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
  SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
  SQLSERVER_SEALED_SNAPSHOT_PROFILE,
  SQLSERVER_SEALED_SNAPSHOT_RECOVERY_STRATEGY,
  assertSealedSnapshotCompletenessEvidence,
  successfulSealedSnapshotCompletenessEvidence,
})
