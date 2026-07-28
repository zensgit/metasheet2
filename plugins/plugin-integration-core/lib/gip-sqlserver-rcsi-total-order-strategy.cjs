'use strict'

// GIP B1b step 3: the first certified SQL Server RCSI total-order probe strategy.
//
// This is deliberately NOT a CertifiedReadActionProfile. The real-engine evidence
// proves one READ COMMITTED statement gets a versioned snapshot when RCSI is on. It
// does not prove cross-statement or cross-page consistency, and it establishes no
// source completeness proof. A PAGED_READ profile remains behind B1c.
//
// LATENT: this module is not imported by a route, scheduler, adapter, or runtime
// registry. It registers one immutable strategy coordinate inside this module only.

const {
  CanonicalDomainError,
  deepCloneFrozenCanonical,
} = require('./gip-canonical-json.cjs')
const crypto = require('node:crypto')
const {
  quoteSqlServerIdentifier,
} = require('@metasheet/mssql-readonly-utils')

const SQLSERVER_RCSI_STRATEGY_ERROR_REASONS = Object.freeze([
  'SQLSERVER_RCSI_PROBE_INPUT_INVALID',
  'SQLSERVER_RCSI_PROBE_RESULT_INVALID',
  'SQLSERVER_RCSI_ENGINE_VERSION_UNCERTIFIED',
  'SQLSERVER_RCSI_POSTURE_UNPROVEN',
  'SQLSERVER_RCSI_ORDERING_KEY_DUPLICATE_FOUND',
  'SQLSERVER_RCSI_ORDERING_KEY_NULL_FOUND',
])
const ERROR_REASON_SET = new Set(SQLSERVER_RCSI_STRATEGY_ERROR_REASONS)
const ERROR_MESSAGES = Object.freeze({
  SQLSERVER_RCSI_PROBE_INPUT_INVALID: 'the SQL Server RCSI probe input is invalid',
  SQLSERVER_RCSI_PROBE_RESULT_INVALID: 'the SQL Server RCSI probe result is invalid',
  SQLSERVER_RCSI_ENGINE_VERSION_UNCERTIFIED: 'the SQL Server engine version is not certified by this strategy',
  SQLSERVER_RCSI_POSTURE_UNPROVEN: 'the SQL Server RCSI statement-snapshot posture was not proven',
  SQLSERVER_RCSI_ORDERING_KEY_DUPLICATE_FOUND: 'the configured ordering key is not unique',
  SQLSERVER_RCSI_ORDERING_KEY_NULL_FOUND: 'the configured ordering key contains NULL values',
})

class GipSqlServerRcsiStrategyError extends Error {
  constructor(reason) {
    const knownReason = typeof reason === 'string' && ERROR_REASON_SET.has(reason)
      ? reason
      : 'SQLSERVER_RCSI_PROBE_RESULT_INVALID'
    super(ERROR_MESSAGES[knownReason])
    this.name = 'GipSqlServerRcsiStrategyError'
    this.reason = knownReason
  }
}

function fail(reason) {
  throw new GipSqlServerRcsiStrategyError(reason)
}

function cloneStrict(value, reason) {
  try {
    return deepCloneFrozenCanonical(value)
  } catch (error) {
    if (error instanceof CanonicalDomainError) fail(reason)
    throw error
  }
}

const ACTION_PROFILE_VERSION = 'sqlserver.total_order_probe.rcsi.v1'
const STRATEGY_ID = 'gip.total_order_probe.sqlserver_rcsi'
const STRATEGY_VERSION = 'v1'
const SNAPSHOT_SEMANTICS = 'read_committed_snapshot_statement_scoped'

const RAW_EVIDENCE_CELLS = [
  {
    engineMajorVersion: '2019',
    productMajor: 15,
    artifactName: 'b1b-evidence-sqlserver-2019',
    phaseARecordSha256: 'b7b2f7cc99570bd45b0345f0dd45ed6ee4dd4cd72d3750f574f6893210b69dda',
    phaseBRecordSha256: 'ae5807432c58406933fa31fda34e47d73408a74958dd318a8cd38fb341ff3dc8',
    phaseARecord: {
      evidenceSchemaVersion: 1,
      dialect: 'sqlserver',
      engineMajorVersion: '2019',
      phase: 'phaseA',
      capabilityPosture: 'default_rc_no_rcsi',
      outcome: 'SQLSERVER_DEFAULT_RC_NO_RCSI_CERTIFICATION_REFUSED',
      sameConnection: true,
      controlsTotal: 23,
      controlsInverted: 23,
      observationsTaken: 16,
      recordedAt: '2026-07-28T04:38:33.934Z',
    },
    phaseBRecord: {
      evidenceSchemaVersion: 1,
      dialect: 'sqlserver',
      engineMajorVersion: '2019',
      phase: 'phaseB',
      capabilityPosture: 'rcsi_on',
      outcome: 'SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN',
      sameConnection: true,
      statementScoped: true,
      separateProfile: true,
      controlsTotal: 44,
      controlsInverted: 44,
      observationsTaken: 33,
      recordedAt: '2026-07-28T04:38:39.255Z',
    },
  },
  {
    engineMajorVersion: '2022',
    productMajor: 16,
    artifactName: 'b1b-evidence-sqlserver-2022',
    phaseARecordSha256: 'd4c9ed6f842de37a5910b534893fc235d809f372bbbd0f9094a911a22d9292a2',
    phaseBRecordSha256: '9dfa7007c1e5069d7b20c38a0a7aed39bccd18c01649b25767cc712277e26e1a',
    phaseARecord: {
      evidenceSchemaVersion: 1,
      dialect: 'sqlserver',
      engineMajorVersion: '2022',
      phase: 'phaseA',
      capabilityPosture: 'default_rc_no_rcsi',
      outcome: 'SQLSERVER_DEFAULT_RC_NO_RCSI_CERTIFICATION_REFUSED',
      sameConnection: true,
      controlsTotal: 23,
      controlsInverted: 23,
      observationsTaken: 16,
      recordedAt: '2026-07-28T04:38:35.207Z',
    },
    phaseBRecord: {
      evidenceSchemaVersion: 1,
      dialect: 'sqlserver',
      engineMajorVersion: '2022',
      phase: 'phaseB',
      capabilityPosture: 'rcsi_on',
      outcome: 'SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN',
      sameConnection: true,
      statementScoped: true,
      separateProfile: true,
      controlsTotal: 44,
      controlsInverted: 44,
      observationsTaken: 33,
      recordedAt: '2026-07-28T04:38:40.616Z',
    },
  },
]

function recordSha256(record) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(record, null, 2))
    .digest('hex')
}

function assertOpeningEvidenceCell(cell) {
  const phaseA = cell.phaseARecord
  const phaseB = cell.phaseBRecord
  if (phaseA.engineMajorVersion !== cell.engineMajorVersion
    || phaseB.engineMajorVersion !== cell.engineMajorVersion
    || phaseA.outcome !== 'SQLSERVER_DEFAULT_RC_NO_RCSI_CERTIFICATION_REFUSED'
    || phaseA.capabilityPosture !== 'default_rc_no_rcsi'
    || phaseA.sameConnection !== true
    || phaseA.controlsTotal < 1
    || phaseA.controlsInverted !== phaseA.controlsTotal
    || phaseB.outcome !== 'SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN'
    || phaseB.capabilityPosture !== 'rcsi_on'
    || phaseB.sameConnection !== true
    || phaseB.statementScoped !== true
    || phaseB.separateProfile !== true
    || phaseB.controlsTotal < 1
    || phaseB.controlsInverted !== phaseB.controlsTotal
    || recordSha256(phaseA) !== cell.phaseARecordSha256
    || recordSha256(phaseB) !== cell.phaseBRecordSha256) {
    fail('SQLSERVER_RCSI_PROBE_RESULT_INVALID')
  }
}

for (const cell of RAW_EVIDENCE_CELLS) assertOpeningEvidenceCell(cell)

// Durable, values-free provenance for the exact step-2 evidence that opened this
// capability. Each record's JSON bytes are re-hashed above before certification.
const SQLSERVER_RCSI_STRATEGY_CERTIFICATE = cloneStrict({
  actionProfileVersion: ACTION_PROFILE_VERSION,
  strategyId: STRATEGY_ID,
  strategyVersion: STRATEGY_VERSION,
  dialect: 'sqlserver',
  capabilityPosture: 'rcsi_on',
  supportedEngineMajorVersions: ['2019', '2022'],
  snapshotSemantics: SNAPSHOT_SEMANTICS,
  scope: {
    qualificationOnly: true,
    statementScoped: true,
    crossStatement: false,
    crossPage: false,
    explicitSnapshotTransaction: false,
    runtimeReachable: false,
  },
  evidence: {
    evidenceSchemaVersion: 1,
    sourceHeadSha: '4308b138e4e44ce9f09e9ebf505396a6e7dd4958',
    workflowRunId: '30329280423',
    outcomeToken: 'SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN',
    cells: RAW_EVIDENCE_CELLS,
  },
}, 'SQLSERVER_RCSI_PROBE_RESULT_INVALID')

const CERTIFIED_PRODUCT_MAJOR_TO_ENGINE = Object.freeze(new Map([
  [15, '2019'],
  [16, '2022'],
]))

const trustedStrategies = new WeakSet()

function normalizeProbeInput(input) {
  const value = cloneStrict(input, 'SQLSERVER_RCSI_PROBE_INPUT_INVALID')
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('objectName') || !keys.includes('keyColumns')) {
    fail('SQLSERVER_RCSI_PROBE_INPUT_INVALID')
  }
  if (typeof value.objectName !== 'string'
    || value.objectName.length === 0
    || value.objectName.length > 384) {
    fail('SQLSERVER_RCSI_PROBE_INPUT_INVALID')
  }
  if (!Array.isArray(value.keyColumns)
    || value.keyColumns.length === 0
    || value.keyColumns.length > 16) {
    fail('SQLSERVER_RCSI_PROBE_INPUT_INVALID')
  }

  let objectSql
  try {
    objectSql = quoteSqlServerIdentifier(value.objectName, 'objectName')
  } catch (_error) {
    fail('SQLSERVER_RCSI_PROBE_INPUT_INVALID')
  }

  const seen = new Set()
  const columnSql = []
  for (const column of value.keyColumns) {
    if (typeof column !== 'string'
      || column.length === 0
      || column.length > 128
      || column.includes('.')
      || seen.has(column)) {
      fail('SQLSERVER_RCSI_PROBE_INPUT_INVALID')
    }
    seen.add(column)
    try {
      columnSql.push(quoteSqlServerIdentifier(column, 'keyColumn'))
    } catch (_error) {
      fail('SQLSERVER_RCSI_PROBE_INPUT_INVALID')
    }
  }
  return Object.freeze({ objectSql, columnSql: Object.freeze(columnSql) })
}

function buildTotalOrderProbePlan(input) {
  const normalized = normalizeProbeInput(input)
  const columns = normalized.columnSql.join(', ')
  const nullPredicate = normalized.columnSql
    .map((column) => `${column} IS NULL`)
    .join(' OR ')
  const duplicateProbe = `SELECT TOP (1) 1 AS duplicate_group FROM ${normalized.objectSql} GROUP BY ${columns} HAVING COUNT_BIG(*) > 1`
  const nullProbe = `SELECT TOP (1) 1 AS null_key_row FROM ${normalized.objectSql} WHERE ${nullPredicate}`
  const statement = [
    "SELECT CONVERT(INT, SERVERPROPERTY('ProductMajorVersion')) AS engine_product_major",
    '(SELECT CONVERT(INT, is_read_committed_snapshot_on) FROM sys.databases WHERE database_id = DB_ID()) AS rcsi_enabled',
    '(SELECT transaction_isolation_level FROM sys.dm_exec_sessions WHERE session_id = @@SPID) AS isolation_level',
    `(SELECT COUNT(*) FROM (${duplicateProbe}) AS gip_duplicate_probe) AS duplicate_groups_sampled`,
    `(SELECT COUNT(*) FROM (${nullProbe}) AS gip_null_probe) AS null_key_rows_sampled`,
  ].join(', ')

  const checkedKeyColumnCount = normalized.columnSql.length
  return Object.freeze({
    actionProfileVersion: ACTION_PROFILE_VERSION,
    statement,
    checkedKeyColumnCount,
    adjudicate(rawResult) {
      return adjudicateProbeResult(checkedKeyColumnCount, rawResult)
    },
  })
}

const RESULT_FIELDS = Object.freeze([
  'engine_product_major',
  'rcsi_enabled',
  'isolation_level',
  'duplicate_groups_sampled',
  'null_key_rows_sampled',
])

function requireNonNegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('SQLSERVER_RCSI_PROBE_RESULT_INVALID')
  }
  return value
}

function adjudicateProbeResult(checkedKeyColumnCount, rawResult) {
  const result = cloneStrict(rawResult, 'SQLSERVER_RCSI_PROBE_RESULT_INVALID')
  const resultKeys = Object.keys(result)
  if (resultKeys.length !== RESULT_FIELDS.length
    || RESULT_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(result, field))) {
    fail('SQLSERVER_RCSI_PROBE_RESULT_INVALID')
  }

  const productMajor = requireNonNegativeInteger(result.engine_product_major)
  const engineMajorVersion = CERTIFIED_PRODUCT_MAJOR_TO_ENGINE.get(productMajor)
  if (!engineMajorVersion) fail('SQLSERVER_RCSI_ENGINE_VERSION_UNCERTIFIED')
  if (result.rcsi_enabled !== 1 || result.isolation_level !== 2) {
    fail('SQLSERVER_RCSI_POSTURE_UNPROVEN')
  }
  const duplicateGroups = requireNonNegativeInteger(result.duplicate_groups_sampled)
  const nullRows = requireNonNegativeInteger(result.null_key_rows_sampled)
  if (duplicateGroups !== 0) fail('SQLSERVER_RCSI_ORDERING_KEY_DUPLICATE_FOUND')
  if (nullRows !== 0) fail('SQLSERVER_RCSI_ORDERING_KEY_NULL_FOUND')

  return cloneStrict({
    probeKind: 'ordering_key_total_order_negative',
    actionProfileVersion: ACTION_PROFILE_VERSION,
    strategyId: STRATEGY_ID,
    strategyVersion: STRATEGY_VERSION,
    dialect: 'sqlserver',
    capabilityPosture: 'rcsi_on',
    engineMajorVersion,
    snapshotSemantics: SNAPSHOT_SEMANTICS,
    statementScoped: true,
    checkedKeyColumnCount,
    duplicateGroupsFound: 0,
    nullKeyRowsFound: 0,
  }, 'SQLSERVER_RCSI_PROBE_RESULT_INVALID')
}

const SQLSERVER_RCSI_TOTAL_ORDER_STRATEGY = Object.freeze({
  actionProfileVersion: ACTION_PROFILE_VERSION,
  strategyId: STRATEGY_ID,
  strategyVersion: STRATEGY_VERSION,
  dialect: 'sqlserver',
  capabilityPosture: 'rcsi_on',
  snapshotSemantics: SNAPSHOT_SEMANTICS,
  buildTotalOrderProbePlan,
})
trustedStrategies.add(SQLSERVER_RCSI_TOTAL_ORDER_STRATEGY)

// Immutable, module-owned registration. There is no public register() or trusted
// factory: callers may obtain the one certified object, never mint another.
const strategyByActionProfileVersion = new Map([
  [ACTION_PROFILE_VERSION, SQLSERVER_RCSI_TOTAL_ORDER_STRATEGY],
])

function resolveCertifiedSqlServerRcsiStrategy(actionProfileVersion) {
  if (typeof actionProfileVersion !== 'string') return null
  return strategyByActionProfileVersion.get(actionProfileVersion) || null
}

function isCertifiedSqlServerRcsiStrategy(value) {
  return trustedStrategies.has(value)
}

module.exports = Object.freeze({
  SQLSERVER_RCSI_STRATEGY_CERTIFICATE,
  SQLSERVER_RCSI_STRATEGY_ERROR_REASONS,
  resolveCertifiedSqlServerRcsiStrategy,
  isCertifiedSqlServerRcsiStrategy,
})
