'use strict'

// GIP B1c: SQL Server explicit-SNAPSHOT page-sequence strategy certificate.
//
// LATENT ONLY. This module freezes the values-free real-engine evidence and the
// contract a future server-bound executor must satisfy. It does not expose an
// executor/context factory, execute SQL, hold credentials, register a runtime
// consumer, or make a customer source reachable.

const crypto = require('node:crypto')
const {
  CanonicalDomainError,
  deepCloneFrozenCanonical,
} = require('./gip-canonical-json.cjs')

const SQLSERVER_SNAPSHOT_ACTION_PROFILE_VERSION =
  'sqlserver.snapshot_paged_read.v1'
const SQLSERVER_SNAPSHOT_STRATEGY_ID =
  'gip.page_sequence.sqlserver_snapshot'
const SQLSERVER_SNAPSHOT_STRATEGY_VERSION = 'v1'
const SQLSERVER_SNAPSHOT_SEMANTICS =
  'explicit_snapshot_transaction_connection_bound'

const SQLSERVER_SNAPSHOT_STRATEGY_ERROR_REASONS = Object.freeze([
  'SQLSERVER_SNAPSHOT_EVIDENCE_INVALID',
])
const ERROR_REASON_SET = new Set(SQLSERVER_SNAPSHOT_STRATEGY_ERROR_REASONS)
const ERROR_MESSAGES = Object.freeze({
  SQLSERVER_SNAPSHOT_EVIDENCE_INVALID:
    'the SQL Server snapshot page-sequence evidence is invalid',
})

class GipSqlServerSnapshotStrategyError extends Error {
  constructor(reason) {
    const knownReason =
      typeof reason === 'string' && ERROR_REASON_SET.has(reason)
        ? reason
        : 'SQLSERVER_SNAPSHOT_EVIDENCE_INVALID'
    super(ERROR_MESSAGES[knownReason])
    this.name = 'GipSqlServerSnapshotStrategyError'
    this.reason = knownReason
  }
}

function fail(reason) {
  throw new GipSqlServerSnapshotStrategyError(reason)
}

function cloneStrict(value) {
  try {
    return deepCloneFrozenCanonical(value)
  } catch (error) {
    if (error instanceof CanonicalDomainError) {
      fail('SQLSERVER_SNAPSHOT_EVIDENCE_INVALID')
    }
    throw error
  }
}

const EVIDENCE_RECORD_KEYS = Object.freeze([
  'evidenceSchemaVersion',
  'dialect',
  'engineMajorVersion',
  'capabilityPosture',
  'outcome',
  'consistencyProof',
  'continuationLifetime',
  'snapshotEnabledReadback',
  'snapshotIsolationObserved',
  'activeSnapshotObserved',
  'sameSessionAcrossPages',
  'terminalShortPageObserved',
  'snapshotMatchesOriginal',
  'freshStateMatchesMutated',
  'snapshotDisabledRejected',
  'killedSessionAbsent',
  'connectionLossRejected',
  'commitAfterLossRejected',
  'lossControlTransactionFactoryCalls',
  'writerMutationsCommitted',
  'pageSize',
  'originalRowCount',
  'snapshotRowCount',
  'snapshotDuplicateCount',
  'snapshotMissingCount',
  'snapshotUnexpectedCount',
  'freshRowCount',
  'freshDuplicateCount',
  'freshMissingCount',
  'freshUnexpectedCount',
  'pageCount',
  'pageSessionObservationCount',
  'cleanupComplete',
  'controlsTotal',
  'controlsPassed',
  'observationsTaken',
  'recordedAt',
])

const EVIDENCE_BOOLEAN_KEYS = Object.freeze([
  'snapshotEnabledReadback',
  'snapshotIsolationObserved',
  'activeSnapshotObserved',
  'sameSessionAcrossPages',
  'terminalShortPageObserved',
  'snapshotMatchesOriginal',
  'freshStateMatchesMutated',
  'snapshotDisabledRejected',
  'killedSessionAbsent',
  'connectionLossRejected',
  'commitAfterLossRejected',
  'cleanupComplete',
])

const EVIDENCE_COUNT_KEYS = Object.freeze([
  'lossControlTransactionFactoryCalls',
  'writerMutationsCommitted',
  'pageSize',
  'originalRowCount',
  'snapshotRowCount',
  'snapshotDuplicateCount',
  'snapshotMissingCount',
  'snapshotUnexpectedCount',
  'freshRowCount',
  'freshDuplicateCount',
  'freshMissingCount',
  'freshUnexpectedCount',
  'pageCount',
  'pageSessionObservationCount',
  'controlsTotal',
  'controlsPassed',
  'observationsTaken',
])

const EVIDENCE_CELL_KEYS = Object.freeze([
  'engineMajorVersion',
  'productMajor',
  'artifactName',
  'artifactArchiveSha256',
  'recordSha256',
  'record',
])

const RAW_EVIDENCE_CELLS = [
  {
    engineMajorVersion: '2019',
    productMajor: 15,
    artifactName:
      'b1c-sqlserver-snapshot-evidence-2019',
    artifactArchiveSha256:
      'd9df942688b769ae48c425dfc5bbb187b8a06eefc921d26c20dce7fc238e071e',
    recordSha256:
      '86d52b87dcf7f4aa1ea0883a29c19098d8232926ea777adcdda938f7a132b35b',
    record: {
      evidenceSchemaVersion: 1,
      dialect: 'sqlserver',
      engineMajorVersion: '2019',
      capabilityPosture: 'explicit_snapshot_transaction',
      outcome: 'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_PROVEN',
      consistencyProof: 'SOURCE_SNAPSHOT_TXN',
      continuationLifetime: 'CONNECTION_BOUND',
      snapshotEnabledReadback: true,
      snapshotIsolationObserved: true,
      activeSnapshotObserved: true,
      sameSessionAcrossPages: true,
      terminalShortPageObserved: true,
      snapshotMatchesOriginal: true,
      freshStateMatchesMutated: true,
      snapshotDisabledRejected: true,
      killedSessionAbsent: true,
      connectionLossRejected: true,
      commitAfterLossRejected: true,
      lossControlTransactionFactoryCalls: 1,
      writerMutationsCommitted: 3,
      pageSize: 3,
      originalRowCount: 8,
      snapshotRowCount: 8,
      snapshotDuplicateCount: 0,
      snapshotMissingCount: 0,
      snapshotUnexpectedCount: 0,
      freshRowCount: 8,
      freshDuplicateCount: 0,
      freshMissingCount: 0,
      freshUnexpectedCount: 0,
      pageCount: 3,
      pageSessionObservationCount: 3,
      cleanupComplete: true,
      controlsTotal: 5,
      controlsPassed: 5,
      observationsTaken: 10,
      recordedAt: '2026-07-28T10:55:26.213Z',
    },
  },
  {
    engineMajorVersion: '2022',
    productMajor: 16,
    artifactName:
      'b1c-sqlserver-snapshot-evidence-2022',
    artifactArchiveSha256:
      'ed1ae01d0c04bce8048d787471b8b7152c907ecb9aa588d016364f8be61defd0',
    recordSha256:
      '0e37035f003273fc2d6fc16210f129ba428faaf6ebccccb09237e9ebcd42f93a',
    record: {
      evidenceSchemaVersion: 1,
      dialect: 'sqlserver',
      engineMajorVersion: '2022',
      capabilityPosture: 'explicit_snapshot_transaction',
      outcome: 'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_PROVEN',
      consistencyProof: 'SOURCE_SNAPSHOT_TXN',
      continuationLifetime: 'CONNECTION_BOUND',
      snapshotEnabledReadback: true,
      snapshotIsolationObserved: true,
      activeSnapshotObserved: true,
      sameSessionAcrossPages: true,
      terminalShortPageObserved: true,
      snapshotMatchesOriginal: true,
      freshStateMatchesMutated: true,
      snapshotDisabledRejected: true,
      killedSessionAbsent: true,
      connectionLossRejected: true,
      commitAfterLossRejected: true,
      lossControlTransactionFactoryCalls: 1,
      writerMutationsCommitted: 3,
      pageSize: 3,
      originalRowCount: 8,
      snapshotRowCount: 8,
      snapshotDuplicateCount: 0,
      snapshotMissingCount: 0,
      snapshotUnexpectedCount: 0,
      freshRowCount: 8,
      freshDuplicateCount: 0,
      freshMissingCount: 0,
      freshUnexpectedCount: 0,
      pageCount: 3,
      pageSessionObservationCount: 3,
      cleanupComplete: true,
      controlsTotal: 5,
      controlsPassed: 5,
      observationsTaken: 10,
      recordedAt: '2026-07-28T10:55:29.639Z',
    },
  },
]

function recordSha256(record) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(record, null, 2))
    .digest('hex')
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length > 32) return false
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return false
  const canonical = new Date(parsed).toISOString()
  return value === canonical || value === canonical.replace('.000Z', 'Z')
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function pageSequenceOpeningProof(record) {
  return (
    record.snapshotEnabledReadback === true &&
    record.snapshotIsolationObserved === true &&
    record.activeSnapshotObserved === true &&
    record.sameSessionAcrossPages === true &&
    record.terminalShortPageObserved === true &&
    record.snapshotMatchesOriginal === true &&
    record.freshStateMatchesMutated === true &&
    record.snapshotDisabledRejected === true &&
    record.killedSessionAbsent === true &&
    record.connectionLossRejected === true &&
    record.commitAfterLossRejected === true &&
    record.cleanupComplete === true &&
    record.lossControlTransactionFactoryCalls === 1 &&
    record.writerMutationsCommitted === 3 &&
    record.pageSize > 0 &&
    record.originalRowCount > 0 &&
    record.snapshotRowCount === record.originalRowCount &&
    record.snapshotDuplicateCount === 0 &&
    record.snapshotMissingCount === 0 &&
    record.snapshotUnexpectedCount === 0 &&
    record.freshRowCount === record.originalRowCount &&
    record.freshDuplicateCount === 0 &&
    record.freshMissingCount === 0 &&
    record.freshUnexpectedCount === 0 &&
    record.pageCount > 1 &&
    record.pageSessionObservationCount === record.pageCount &&
    record.pageCount ===
      Math.ceil(record.originalRowCount / record.pageSize) &&
    record.originalRowCount % record.pageSize !== 0 &&
    record.controlsTotal === 5 &&
    record.controlsPassed === record.controlsTotal &&
    record.observationsTaken > 0
  )
}

function assertOpeningEvidenceCell(rawCell) {
  const cell = cloneStrict(rawCell)
  if (
    typeof cell !== 'object' ||
    cell === null ||
    Array.isArray(cell) ||
    typeof cell.record !== 'object' ||
    cell.record === null ||
    Array.isArray(cell.record)
  ) {
    fail('SQLSERVER_SNAPSHOT_EVIDENCE_INVALID')
  }
  const record = cell.record
  const cellKeys = Object.keys(cell)
  const recordKeys = Object.keys(record)
  if (
    cellKeys.length !== EVIDENCE_CELL_KEYS.length ||
    EVIDENCE_CELL_KEYS.some(
      (key) => !Object.prototype.hasOwnProperty.call(cell, key),
    ) ||
    cellKeys.some((key) => !EVIDENCE_CELL_KEYS.includes(key)) ||
    recordKeys.length !== EVIDENCE_RECORD_KEYS.length ||
    EVIDENCE_RECORD_KEYS.some(
      (key) => !Object.prototype.hasOwnProperty.call(record, key),
    ) ||
    recordKeys.some((key) => !EVIDENCE_RECORD_KEYS.includes(key)) ||
    !(
      (cell.engineMajorVersion === '2019' &&
        cell.productMajor === 15) ||
      (cell.engineMajorVersion === '2022' &&
        cell.productMajor === 16)
    ) ||
    cell.artifactName !==
      `b1c-sqlserver-snapshot-evidence-${cell.engineMajorVersion}` ||
    typeof cell.artifactArchiveSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(cell.artifactArchiveSha256) ||
    typeof cell.recordSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(cell.recordSha256) ||
    cell.engineMajorVersion !== record.engineMajorVersion ||
    record.evidenceSchemaVersion !== 1 ||
    record.dialect !== 'sqlserver' ||
    record.capabilityPosture !== 'explicit_snapshot_transaction' ||
    record.outcome !== 'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_PROVEN' ||
    record.consistencyProof !== 'SOURCE_SNAPSHOT_TXN' ||
    record.continuationLifetime !== 'CONNECTION_BOUND' ||
    !EVIDENCE_BOOLEAN_KEYS.every(
      (key) => typeof record[key] === 'boolean',
    ) ||
    !EVIDENCE_COUNT_KEYS.every((key) =>
      isNonNegativeInteger(record[key]),
    ) ||
    !isCanonicalTimestamp(record.recordedAt) ||
    !pageSequenceOpeningProof(record) ||
    recordSha256(record) !== cell.recordSha256
  ) {
    fail('SQLSERVER_SNAPSHOT_EVIDENCE_INVALID')
  }
}

const openingEvidenceEngineVersions = new Set()
for (const cell of RAW_EVIDENCE_CELLS) {
  assertOpeningEvidenceCell(cell)
  if (openingEvidenceEngineVersions.has(cell.engineMajorVersion)) {
    fail('SQLSERVER_SNAPSHOT_EVIDENCE_INVALID')
  }
  openingEvidenceEngineVersions.add(cell.engineMajorVersion)
}
if (
  openingEvidenceEngineVersions.size !== 2 ||
  !openingEvidenceEngineVersions.has('2019') ||
  !openingEvidenceEngineVersions.has('2022')
) {
  fail('SQLSERVER_SNAPSHOT_EVIDENCE_INVALID')
}

const SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_STRATEGY_CERTIFICATE = cloneStrict({
  actionProfileVersion: SQLSERVER_SNAPSHOT_ACTION_PROFILE_VERSION,
  strategyId: SQLSERVER_SNAPSHOT_STRATEGY_ID,
  strategyVersion: SQLSERVER_SNAPSHOT_STRATEGY_VERSION,
  dialect: 'sqlserver',
  capabilityPosture: 'explicit_snapshot_transaction',
  supportedEngineMajorVersions: ['2019', '2022'],
  snapshotSemantics: SQLSERVER_SNAPSHOT_SEMANTICS,
  contextContract: {
    lifecycle: ['OPEN', 'READING', 'COMPLETED', 'ABORTED'],
    transactionBoundary: 'ONE_EXPLICIT_SNAPSHOT_TRANSACTION',
    connectionAffinity: 'ONE_CONNECTION_PER_PAGE_SEQUENCE',
    continuation: 'OFFSET_WITHIN_BOUND_TRANSACTION',
    orderingRequirement: 'STABLE_UNIQUE_NON_NULL_TOTAL_ORDER',
    connectionLossPolicy: 'ABORT_NO_RESNAPSHOT',
    recoveryStrategy: 'WHOLE_ROUND_RESTART',
    executorAuthority: 'SERVER_BOUND_EXECUTOR_REQUIRED',
    executableInThisModule: false,
    runtimeReachable: false,
  },
  evidence: {
    evidenceSchemaVersion: 1,
    sourceHeadSha:
      'b6b66d04e9b1106af98691ad2627ea80aab1090b',
    mergedEvidenceSha:
      '10056f823c39544a15a4e180169fcc0c058b1ffe',
    workflowRunId: '30352634620',
    outcomeToken: 'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_PROVEN',
    cells: RAW_EVIDENCE_CELLS,
  },
})

const trustedStrategies = new WeakSet()

const SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_STRATEGY = Object.freeze({
  actionProfileVersion: SQLSERVER_SNAPSHOT_ACTION_PROFILE_VERSION,
  strategyId: SQLSERVER_SNAPSHOT_STRATEGY_ID,
  strategyVersion: SQLSERVER_SNAPSHOT_STRATEGY_VERSION,
  dialect: 'sqlserver',
  capabilityPosture: 'explicit_snapshot_transaction',
  snapshotSemantics: SQLSERVER_SNAPSHOT_SEMANTICS,
  contextContract:
    SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_STRATEGY_CERTIFICATE.contextContract,
})
trustedStrategies.add(SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_STRATEGY)

const strategyByActionProfileVersion = new Map([
  [
    SQLSERVER_SNAPSHOT_ACTION_PROFILE_VERSION,
    SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_STRATEGY,
  ],
])

function resolveCertifiedSqlServerSnapshotPageSequenceStrategy(
  actionProfileVersion,
) {
  if (typeof actionProfileVersion !== 'string') return null
  return strategyByActionProfileVersion.get(actionProfileVersion) || null
}

function isCertifiedSqlServerSnapshotPageSequenceStrategy(value) {
  return trustedStrategies.has(value)
}

module.exports = Object.freeze({
  SQLSERVER_SNAPSHOT_ACTION_PROFILE_VERSION,
  SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_STRATEGY_CERTIFICATE,
  SQLSERVER_SNAPSHOT_STRATEGY_ERROR_REASONS,
  resolveCertifiedSqlServerSnapshotPageSequenceStrategy,
  isCertifiedSqlServerSnapshotPageSequenceStrategy,
})
