'use strict'

// GIP B1c: SQL Server explicit-SNAPSHOT paged-read profile (LATENT).
//
// This is a certified SPEC for one capability coordinate only:
//   PAGED_READ x SOURCE_SNAPSHOT_TXN x CONNECTION_BOUND x SHORT_PAGE.
//
// It has no runtime consumer and does not execute SQL. The values-free
// adjudicator below specifies what a future server-bound executor must prove;
// caller-supplied projections are not authoritative until that separately-gated
// executor exists.

const {
  CanonicalDomainError,
  deepCloneFrozenCanonical,
} = require('./gip-canonical-json.cjs')
const {
  normalizeCertifiedReadActionProfile,
  validateCompletenessEvidence,
  deriveRecoveryStrategy,
} = require('./gip-profile-certification-contracts.cjs')
const {
  SQLSERVER_SNAPSHOT_ACTION_PROFILE_VERSION,
  SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_STRATEGY_CERTIFICATE,
  SQLSERVER_SNAPSHOT_STRATEGY_ERROR_REASONS,
} = require('./gip-sqlserver-snapshot-page-sequence-strategy.cjs')

const SQLSERVER_SNAPSHOT_PAGED_READ_CONNECTOR_KIND =
  'data-source:sql-readonly'
const SQLSERVER_SNAPSHOT_PAGED_READ_IMPLEMENTATION_VERSION =
  'latent-contract.sqlserver-snapshot-page-sequence.v1'

const SQLSERVER_SNAPSHOT_PAGED_READ_ERROR_REASONS = Object.freeze([
  'SNAPSHOT_PAGED_READ_RESULT_INVALID',
  'SNAPSHOT_PAGED_READ_ENGINE_VERSION_UNCERTIFIED',
  'SNAPSHOT_PAGED_READ_SNAPSHOT_UNPROVEN',
  'SNAPSHOT_PAGED_READ_SESSION_DRIFT',
  'SNAPSHOT_PAGED_READ_CONNECTION_LOST',
  'SNAPSHOT_PAGED_READ_SCALE_UNCERTIFIED',
  'SNAPSHOT_PAGED_READ_EMPTY_SOURCE_UNCERTIFIED',
  'SNAPSHOT_PAGED_READ_COMPLETENESS_UNPROVABLE',
])
const ERROR_REASON_SET = new Set(
  SQLSERVER_SNAPSHOT_PAGED_READ_ERROR_REASONS,
)
const ERROR_MESSAGES = Object.freeze({
  SNAPSHOT_PAGED_READ_RESULT_INVALID:
    'the snapshot paged-read result projection is invalid',
  SNAPSHOT_PAGED_READ_ENGINE_VERSION_UNCERTIFIED:
    'the SQL Server engine version is not certified by this profile',
  SNAPSHOT_PAGED_READ_SNAPSHOT_UNPROVEN:
    'the page sequence was not read inside one explicit snapshot transaction',
  SNAPSHOT_PAGED_READ_SESSION_DRIFT:
    'the page sequence did not remain on one database session',
  SNAPSHOT_PAGED_READ_CONNECTION_LOST:
    'the connection-bound page sequence was interrupted',
  SNAPSHOT_PAGED_READ_SCALE_UNCERTIFIED:
    'the page sequence exceeds this profile version evidence envelope',
  SNAPSHOT_PAGED_READ_EMPTY_SOURCE_UNCERTIFIED:
    'empty-source completeness is not certified by this profile version',
  SNAPSHOT_PAGED_READ_COMPLETENESS_UNPROVABLE:
    'the terminal page is full, so SHORT_PAGE completeness is unprovable',
})

class SqlServerSnapshotPagedReadError extends Error {
  constructor(reason) {
    const knownReason =
      typeof reason === 'string' && ERROR_REASON_SET.has(reason)
        ? reason
        : 'SNAPSHOT_PAGED_READ_RESULT_INVALID'
    super(ERROR_MESSAGES[knownReason])
    this.name = 'SqlServerSnapshotPagedReadError'
    this.reason = knownReason
  }
}

function fail(reason) {
  throw new SqlServerSnapshotPagedReadError(reason)
}

function cloneStrict(value) {
  try {
    return deepCloneFrozenCanonical(value)
  } catch (error) {
    if (error instanceof CanonicalDomainError) {
      fail('SNAPSHOT_PAGED_READ_RESULT_INVALID')
    }
    throw error
  }
}

const SQLSERVER_SNAPSHOT_PAGED_READ_FAILURE_VOCABULARY =
  Object.freeze([
    ...SQLSERVER_SNAPSHOT_STRATEGY_ERROR_REASONS,
    ...SQLSERVER_SNAPSHOT_PAGED_READ_ERROR_REASONS,
  ])

const SQLSERVER_SNAPSHOT_PAGED_READ_PROFILE =
  normalizeCertifiedReadActionProfile({
    profileId: SQLSERVER_SNAPSHOT_ACTION_PROFILE_VERSION,
    connectorKind: SQLSERVER_SNAPSHOT_PAGED_READ_CONNECTOR_KIND,
    actionId: 'snapshot_paged_read',
    implementationVersion:
      SQLSERVER_SNAPSHOT_PAGED_READ_IMPLEMENTATION_VERSION,
    certificate: {
      acquisitionMode: 'PAGED_READ',
      supportedConsistencyProofs: ['SOURCE_SNAPSHOT_TXN'],
      continuationLifetime: 'CONNECTION_BOUND',
      supportedCompletenessProofs: ['SHORT_PAGE'],
      completenessCombinationRules: [['SHORT_PAGE']],
      // The real-engine spike proves the semantics at this envelope. It does
      // not certify a production row/page ceiling; runtime bounds remain a
      // separate implementation gate.
      maxScale: {
        runtimeScaleCertified: false,
        adjudicationBoundedToEvidenceEnvelope: true,
        evidenceEnvelope: {
          pageSize: 3,
          pageCount: 3,
          rowCount: 8,
        },
      },
      orderingKeyRequirement: {
        required: true,
        kind: 'STABLE_UNIQUE_NON_NULL_TOTAL_ORDER',
        qualification: 'SEPARATE_BINDING_QUALIFICATION_REQUIRED',
      },
      cursorShape: {
        kind: 'OFFSET_WITHIN_BOUND_TRANSACTION',
        durable: false,
        sameConnectionRequired: true,
        callerSuppliedSqlForbidden: true,
      },
      failureVocabulary: [
        ...SQLSERVER_SNAPSHOT_PAGED_READ_FAILURE_VOCABULARY,
      ],
    },
  })

const RESULT_FIELDS = Object.freeze([
  'engineMajorVersion',
  'contextState',
  'snapshotTransactionObserved',
  'sameSessionAcrossPages',
  'connectionLossObserved',
  'pageCount',
  'appliedPageSize',
  'precedingFullPageCount',
  'terminalPageRowCount',
  'totalRowCount',
])

function requireNonNegativeSafeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('SNAPSHOT_PAGED_READ_RESULT_INVALID')
  }
  return value
}

function completenessEvidence() {
  return Object.freeze({
    runOutcome: 'successful',
    usedCompletenessProofs: Object.freeze(['SHORT_PAGE']),
  })
}

function adjudicateSnapshotPagedReadCompleteness(runResult) {
  const result = cloneStrict(runResult)
  if (
    typeof result !== 'object' ||
    result === null ||
    Array.isArray(result)
  ) {
    fail('SNAPSHOT_PAGED_READ_RESULT_INVALID')
  }
  const keys = Object.keys(result)
  if (
    keys.length !== RESULT_FIELDS.length ||
    RESULT_FIELDS.some(
      (field) => !Object.prototype.hasOwnProperty.call(result, field),
    ) ||
    keys.some((field) => !RESULT_FIELDS.includes(field))
  ) {
    fail('SNAPSHOT_PAGED_READ_RESULT_INVALID')
  }

  if (
    result.engineMajorVersion !== '2019' &&
    result.engineMajorVersion !== '2022'
  ) {
    fail('SNAPSHOT_PAGED_READ_ENGINE_VERSION_UNCERTIFIED')
  }
  if (
    result.contextState !== 'COMPLETED' ||
    result.snapshotTransactionObserved !== true
  ) {
    fail('SNAPSHOT_PAGED_READ_SNAPSHOT_UNPROVEN')
  }
  if (result.sameSessionAcrossPages !== true) {
    fail('SNAPSHOT_PAGED_READ_SESSION_DRIFT')
  }
  if (result.connectionLossObserved !== false) {
    fail('SNAPSHOT_PAGED_READ_CONNECTION_LOST')
  }

  const pageCount = requireNonNegativeSafeInteger(result.pageCount)
  const appliedPageSize = requireNonNegativeSafeInteger(
    result.appliedPageSize,
  )
  const precedingFullPageCount = requireNonNegativeSafeInteger(
    result.precedingFullPageCount,
  )
  const terminalPageRowCount = requireNonNegativeSafeInteger(
    result.terminalPageRowCount,
  )
  const totalRowCount = requireNonNegativeSafeInteger(
    result.totalRowCount,
  )

  if (
    pageCount < 1 ||
    appliedPageSize < 1 ||
    pageCount !== precedingFullPageCount + 1 ||
    terminalPageRowCount > appliedPageSize ||
    totalRowCount !==
      precedingFullPageCount * appliedPageSize +
        terminalPageRowCount
  ) {
    fail('SNAPSHOT_PAGED_READ_RESULT_INVALID')
  }

  const evidenceEnvelope =
    SQLSERVER_SNAPSHOT_PAGED_READ_PROFILE.certificate.maxScale
      .evidenceEnvelope
  if (
    appliedPageSize > evidenceEnvelope.pageSize ||
    pageCount > evidenceEnvelope.pageCount
  ) {
    fail('SNAPSHOT_PAGED_READ_SCALE_UNCERTIFIED')
  }

  // The real-engine opening evidence used a non-empty, multi-page sequence.
  // Empty-source semantics therefore stay fail-closed in v1 rather than being
  // inferred from arithmetic alone.
  if (totalRowCount === 0) {
    fail('SNAPSHOT_PAGED_READ_EMPTY_SOURCE_UNCERTIFIED')
  }

  // SHORT_PAGE is the only completeness proof this profile certifies.
  // An exact page multiple ends on a full page and remains unprovable.
  if (terminalPageRowCount === appliedPageSize) {
    fail('SNAPSHOT_PAGED_READ_COMPLETENESS_UNPROVABLE')
  }

  return completenessEvidence()
}

function sqlServerSnapshotPagedReadRecoveryStrategy() {
  return deriveRecoveryStrategy(
    SQLSERVER_SNAPSHOT_PAGED_READ_PROFILE.certificate,
  )
}

function assertCompletenessEvidenceCertified(evidence) {
  return validateCompletenessEvidence(
    SQLSERVER_SNAPSHOT_PAGED_READ_PROFILE,
    evidence,
  )
}

module.exports = Object.freeze({
  SQLSERVER_SNAPSHOT_PAGED_READ_PROFILE,
  SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_STRATEGY_CERTIFICATE,
  SQLSERVER_SNAPSHOT_PAGED_READ_CONNECTOR_KIND,
  SQLSERVER_SNAPSHOT_PAGED_READ_IMPLEMENTATION_VERSION,
  SQLSERVER_SNAPSHOT_PAGED_READ_ERROR_REASONS,
  SQLSERVER_SNAPSHOT_PAGED_READ_FAILURE_VOCABULARY,
  adjudicateSnapshotPagedReadCompleteness,
  sqlServerSnapshotPagedReadRecoveryStrategy,
  assertCompletenessEvidenceCertified,
})
