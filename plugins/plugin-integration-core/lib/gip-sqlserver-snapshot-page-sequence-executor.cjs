'use strict'

// GIP B1c: latent SQL Server explicit-SNAPSHOT page-sequence executor.
//
// This module is intentionally pinned to the first-party evidence fixture and
// evidence envelope. It has no runtime consumer. A future binding gate must
// replace the module-owned fixture plan with connector-owned authority before
// any customer source can become reachable.

const {
  CanonicalDomainError,
  deepCloneFrozenCanonical,
} = require('./gip-canonical-json.cjs')
const {
  SQLSERVER_SNAPSHOT_PAGED_READ_PROFILE,
  adjudicateSnapshotPagedReadCompleteness,
  assertCompletenessEvidenceCertified,
} = require('./gip-sqlserver-snapshot-paged-read-profile.cjs')
const { createErrorBrand } = require('./gip-inert-entry.cjs')

const SQLSERVER_SNAPSHOT_EXECUTOR_FIXTURE_TABLE =
  'dbo.gip_b1c_snapshot_executor_fixture'
const SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_SIZE = 3
const SQLSERVER_SNAPSHOT_EXECUTOR_MAX_PAGES = 3
const SQLSERVER_SNAPSHOT_EXECUTOR_MAX_ROWS = 8

const SQLSERVER_SNAPSHOT_EXECUTOR_ERROR_REASONS = Object.freeze([
  'SQLSERVER_SNAPSHOT_EXECUTOR_INPUT_INVALID',
  'SQLSERVER_SNAPSHOT_EXECUTOR_SESSION_OPEN_FAILED',
  'SQLSERVER_SNAPSHOT_EXECUTOR_BEGIN_FAILED',
  'SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_READ_FAILED',
  'SQLSERVER_SNAPSHOT_EXECUTOR_OBSERVATION_FAILED',
  'SQLSERVER_SNAPSHOT_EXECUTOR_SESSION_DRIFT',
  'SQLSERVER_SNAPSHOT_EXECUTOR_SNAPSHOT_UNPROVEN',
  'SQLSERVER_SNAPSHOT_EXECUTOR_SCALE_UNCERTIFIED',
  'SQLSERVER_SNAPSHOT_EXECUTOR_EMPTY_SOURCE_UNCERTIFIED',
  'SQLSERVER_SNAPSHOT_EXECUTOR_COMPLETENESS_UNPROVABLE',
  'SQLSERVER_SNAPSHOT_EXECUTOR_COMMIT_FAILED',
  'SQLSERVER_SNAPSHOT_EXECUTOR_CLEANUP_FAILED',
])

const ERROR_MESSAGES = Object.freeze({
  SQLSERVER_SNAPSHOT_EXECUTOR_INPUT_INVALID:
    'the SQL Server snapshot executor input is invalid',
  SQLSERVER_SNAPSHOT_EXECUTOR_SESSION_OPEN_FAILED:
    'the SQL Server snapshot session could not be opened',
  SQLSERVER_SNAPSHOT_EXECUTOR_BEGIN_FAILED:
    'the explicit SQL Server snapshot transaction could not be started',
  SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_READ_FAILED:
    'the transaction-bound SQL Server page read failed',
  SQLSERVER_SNAPSHOT_EXECUTOR_OBSERVATION_FAILED:
    'the SQL Server snapshot observation could not be verified',
  SQLSERVER_SNAPSHOT_EXECUTOR_SESSION_DRIFT:
    'the SQL Server page sequence did not remain on one session',
  SQLSERVER_SNAPSHOT_EXECUTOR_SNAPSHOT_UNPROVEN:
    'the SQL Server page sequence was not observed in one active snapshot',
  SQLSERVER_SNAPSHOT_EXECUTOR_SCALE_UNCERTIFIED:
    'the SQL Server page sequence exceeds the certified evidence envelope',
  SQLSERVER_SNAPSHOT_EXECUTOR_EMPTY_SOURCE_UNCERTIFIED:
    'empty-source completeness is not certified by this executor version',
  SQLSERVER_SNAPSHOT_EXECUTOR_COMPLETENESS_UNPROVABLE:
    'SHORT_PAGE completeness is unprovable for this page sequence',
  SQLSERVER_SNAPSHOT_EXECUTOR_COMMIT_FAILED:
    'the SQL Server snapshot transaction could not be committed',
  SQLSERVER_SNAPSHOT_EXECUTOR_CLEANUP_FAILED:
    'the SQL Server snapshot execution context could not be closed',
})

const ERROR_REASON_SET = new Set(SQLSERVER_SNAPSHOT_EXECUTOR_ERROR_REASONS)
const { brandError, isBrandedError } = createErrorBrand()

function createTrustedError(reason) {
  const knownReason = ERROR_REASON_SET.has(reason)
    ? reason
    : 'SQLSERVER_SNAPSHOT_EXECUTOR_INPUT_INVALID'
  const error = new Error(ERROR_MESSAGES[knownReason])
  error.name = 'SqlServerSnapshotPageSequenceExecutorError'
  Object.defineProperty(error, 'reason', {
    configurable: false,
    enumerable: true,
    writable: false,
    value: knownReason,
  })
  return Object.freeze(brandError(error))
}

function fail(reason) {
  throw createTrustedError(reason)
}

function cloneStrict(value, reason) {
  try {
    return deepCloneFrozenCanonical(value)
  } catch (error) {
    if (error instanceof CanonicalDomainError) fail(reason)
    throw error
  }
}

function normalizeRunInput(rawInput) {
  const input = cloneStrict(
    rawInput,
    'SQLSERVER_SNAPSHOT_EXECUTOR_INPUT_INVALID',
  )
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(input, 'connectionConfig') ||
    typeof input.connectionConfig !== 'object' ||
    input.connectionConfig === null ||
    Array.isArray(input.connectionConfig)
  ) {
    fail('SQLSERVER_SNAPSHOT_EXECUTOR_INPUT_INVALID')
  }
  return input
}

function normalizeNonNegativeInteger(value) {
  if (Number.isSafeInteger(value) && value >= 0) {
    return value
  }
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  return null
}

function normalizePositiveInteger(value) {
  const parsed = normalizeNonNegativeInteger(value)
  return parsed !== null && parsed > 0 ? parsed : null
}

function engineVersionFromProductMajor(productMajor) {
  if (productMajor === 15) return '2019'
  if (productMajor === 16) return '2022'
  return null
}

const PAGE_SQL = `
SELECT
  row_id AS keyValue,
  @@SPID AS sessionId
FROM ${SQLSERVER_SNAPSHOT_EXECUTOR_FIXTURE_TABLE}
ORDER BY sort_key ASC, row_id ASC
OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
`

const SNAPSHOT_OBSERVATION_SQL = `
SELECT
  CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS productMajor,
  @@SPID AS sessionId,
  (SELECT snapshot_isolation_state
     FROM sys.databases
    WHERE database_id = DB_ID()) AS snapshotEnabledState,
  (SELECT transaction_isolation_level
     FROM sys.dm_exec_sessions
    WHERE session_id = @@SPID) AS isolationLevel,
  (SELECT COUNT_BIG(*)
     FROM sys.dm_tran_active_snapshot_database_transactions
    WHERE session_id = @@SPID AND is_snapshot = 1) AS activeSnapshotCount
`

function requireRecordset(result, reason) {
  if (
    typeof result !== 'object' ||
    result === null ||
    !Array.isArray(result.recordset)
  ) {
    fail(reason)
  }
  return result.recordset
}

async function readPage(transaction, pageIndex) {
  let request
  let result
  try {
    request = transaction.request()
    result = await request
      .input('offset', pageIndex * SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_SIZE)
      .input('pageSize', SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_SIZE)
      .query(PAGE_SQL)
  } catch {
    fail('SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_READ_FAILED')
  }

  const recordset = requireRecordset(
    result,
    'SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_READ_FAILED',
  )
  if (recordset.length > SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_SIZE) {
    fail('SQLSERVER_SNAPSHOT_EXECUTOR_SCALE_UNCERTIFIED')
  }

  const rows = []
  let pageSessionId = null
  for (const rawRow of recordset) {
    let keyValue
    let sessionId
    try {
      keyValue = normalizePositiveInteger(rawRow.keyValue)
      sessionId = normalizePositiveInteger(rawRow.sessionId)
    } catch {
      fail('SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_READ_FAILED')
    }
    if (keyValue === null || sessionId === null) {
      fail('SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_READ_FAILED')
    }
    if (pageSessionId !== null && pageSessionId !== sessionId) {
      fail('SQLSERVER_SNAPSHOT_EXECUTOR_SESSION_DRIFT')
    }
    pageSessionId = sessionId
    rows.push({ keyValue })
  }

  return {
    rows,
    pageSessionId,
  }
}

async function observeSnapshot(transaction) {
  let result
  try {
    result = await transaction.request().query(SNAPSHOT_OBSERVATION_SQL)
  } catch {
    fail('SQLSERVER_SNAPSHOT_EXECUTOR_OBSERVATION_FAILED')
  }
  const recordset = requireRecordset(
    result,
    'SQLSERVER_SNAPSHOT_EXECUTOR_OBSERVATION_FAILED',
  )
  if (recordset.length !== 1) {
    fail('SQLSERVER_SNAPSHOT_EXECUTOR_OBSERVATION_FAILED')
  }

  let productMajor
  let sessionId
  let snapshotEnabledState
  let isolationLevel
  let activeSnapshotCount
  try {
    const row = recordset[0]
    productMajor = normalizePositiveInteger(row.productMajor)
    sessionId = normalizePositiveInteger(row.sessionId)
    snapshotEnabledState = normalizeNonNegativeInteger(row.snapshotEnabledState)
    isolationLevel = normalizePositiveInteger(row.isolationLevel)
    activeSnapshotCount = normalizeNonNegativeInteger(row.activeSnapshotCount)
  } catch {
    fail('SQLSERVER_SNAPSHOT_EXECUTOR_OBSERVATION_FAILED')
  }
  const engineMajorVersion = engineVersionFromProductMajor(productMajor)
  if (
    engineMajorVersion === null ||
    sessionId === null ||
    snapshotEnabledState === null ||
    isolationLevel === null ||
    activeSnapshotCount === null
  ) {
    fail('SQLSERVER_SNAPSHOT_EXECUTOR_OBSERVATION_FAILED')
  }
  if (
    snapshotEnabledState !== 1 ||
    isolationLevel !== 5 ||
    activeSnapshotCount < 1
  ) {
    fail('SQLSERVER_SNAPSHOT_EXECUTOR_SNAPSHOT_UNPROVEN')
  }
  return {
    engineMajorVersion,
    sessionId,
  }
}

function profileProjection(engineMajorVersion, pageSizes, totalRowCount) {
  if (pageSizes.length === 0) {
    return {
      engineMajorVersion,
      contextState: 'COMPLETED',
      snapshotTransactionObserved: true,
      sameSessionAcrossPages: true,
      connectionLossObserved: false,
      pageCount: 1,
      appliedPageSize: SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_SIZE,
      precedingFullPageCount: 0,
      terminalPageRowCount: 0,
      totalRowCount,
    }
  }
  return {
    engineMajorVersion,
    contextState: 'COMPLETED',
    snapshotTransactionObserved: true,
    sameSessionAcrossPages: true,
    connectionLossObserved: false,
    pageCount: pageSizes.length,
    appliedPageSize: SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_SIZE,
    precedingFullPageCount: pageSizes.length - 1,
    terminalPageRowCount: pageSizes[pageSizes.length - 1],
    totalRowCount,
  }
}

function mapProfileFailure(error) {
  const reason =
    typeof error === 'object' && error !== null ? error.reason : undefined
  if (reason === 'SNAPSHOT_PAGED_READ_EMPTY_SOURCE_UNCERTIFIED') {
    return 'SQLSERVER_SNAPSHOT_EXECUTOR_EMPTY_SOURCE_UNCERTIFIED'
  }
  if (reason === 'SNAPSHOT_PAGED_READ_COMPLETENESS_UNPROVABLE') {
    return 'SQLSERVER_SNAPSHOT_EXECUTOR_COMPLETENESS_UNPROVABLE'
  }
  if (
    reason === 'SNAPSHOT_PAGED_READ_SCALE_UNCERTIFIED' ||
    reason === 'SNAPSHOT_PAGED_READ_ENGINE_VERSION_UNCERTIFIED'
  ) {
    return 'SQLSERVER_SNAPSHOT_EXECUTOR_SCALE_UNCERTIFIED'
  }
  if (reason === 'SNAPSHOT_PAGED_READ_SESSION_DRIFT') {
    return 'SQLSERVER_SNAPSHOT_EXECUTOR_SESSION_DRIFT'
  }
  if (reason === 'SNAPSHOT_PAGED_READ_SNAPSHOT_UNPROVEN') {
    return 'SQLSERVER_SNAPSHOT_EXECUTOR_SNAPSHOT_UNPROVEN'
  }
  return 'SQLSERVER_SNAPSHOT_EXECUTOR_COMPLETENESS_UNPROVABLE'
}

function adjudicate(engineMajorVersion, pageSizes, totalRowCount) {
  try {
    const completeness = adjudicateSnapshotPagedReadCompleteness(
      profileProjection(engineMajorVersion, pageSizes, totalRowCount),
    )
    assertCompletenessEvidenceCertified(completeness)
    return completeness
  } catch (error) {
    fail(mapProfileFailure(error))
  }
}

function stageFailureReason(stage) {
  if (stage === 'OPEN_SESSION' || stage === 'LOAD_DRIVER') {
    return 'SQLSERVER_SNAPSHOT_EXECUTOR_SESSION_OPEN_FAILED'
  }
  if (stage === 'BEGIN_SNAPSHOT') {
    return 'SQLSERVER_SNAPSHOT_EXECUTOR_BEGIN_FAILED'
  }
  if (stage === 'OBSERVE_SNAPSHOT') {
    return 'SQLSERVER_SNAPSHOT_EXECUTOR_OBSERVATION_FAILED'
  }
  if (stage === 'COMMIT') {
    return 'SQLSERVER_SNAPSHOT_EXECUTOR_COMMIT_FAILED'
  }
  return 'SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_READ_FAILED'
}

async function executeSqlServerSnapshotPageSequence(rawInput) {
  let pool = null
  let transaction = null
  let transactionBegun = false
  let committed = false
  let output = null
  let failureReason = null
  let stage = 'INPUT'

  try {
    const input = normalizeRunInput(rawInput)

    stage = 'LOAD_DRIVER'
    const sql = require('mssql')
    if (
      typeof sql.ConnectionPool !== 'function' ||
      typeof sql.Transaction !== 'function' ||
      typeof sql.ISOLATION_LEVEL !== 'object' ||
      sql.ISOLATION_LEVEL === null ||
      !Number.isSafeInteger(sql.ISOLATION_LEVEL.SNAPSHOT)
    ) {
      fail('SQLSERVER_SNAPSHOT_EXECUTOR_SESSION_OPEN_FAILED')
    }

    stage = 'OPEN_SESSION'
    pool = new sql.ConnectionPool(input.connectionConfig)
    await pool.connect()

    transaction = new sql.Transaction(pool)
    stage = 'BEGIN_SNAPSHOT'
    await transaction.begin(sql.ISOLATION_LEVEL.SNAPSHOT)
    transactionBegun = true

    const rows = []
    const pageSizes = []
    let sequenceSessionId = null
    let engineMajorVersion = null

    for (
      let pageIndex = 0;
      pageIndex < SQLSERVER_SNAPSHOT_EXECUTOR_MAX_PAGES;
      pageIndex += 1
    ) {
      stage = 'READ_PAGE'
      const page = await readPage(transaction, pageIndex)

      stage = 'OBSERVE_SNAPSHOT'
      const observation = await observeSnapshot(transaction)
      if (
        sequenceSessionId !== null &&
        sequenceSessionId !== observation.sessionId
      ) {
        fail('SQLSERVER_SNAPSHOT_EXECUTOR_SESSION_DRIFT')
      }
      if (
        page.pageSessionId !== null &&
        page.pageSessionId !== observation.sessionId
      ) {
        fail('SQLSERVER_SNAPSHOT_EXECUTOR_SESSION_DRIFT')
      }
      if (
        engineMajorVersion !== null &&
        engineMajorVersion !== observation.engineMajorVersion
      ) {
        fail('SQLSERVER_SNAPSHOT_EXECUTOR_OBSERVATION_FAILED')
      }
      sequenceSessionId = observation.sessionId
      engineMajorVersion = observation.engineMajorVersion

      if (page.rows.length === 0) {
        const completeness = adjudicate(
          engineMajorVersion,
          pageSizes,
          rows.length,
        )
        output = {
          rows,
          evidence: {
            profileId: SQLSERVER_SNAPSHOT_PAGED_READ_PROFILE.profileId,
            engineMajorVersion,
            contextState: 'COMPLETED',
            pageSize: SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_SIZE,
            pageCount: pageSizes.length,
            totalRowCount: rows.length,
            sameSessionAcrossPages: true,
            snapshotTransactionObserved: true,
            completeness,
          },
        }
        break
      }

      pageSizes.push(page.rows.length)
      rows.push(...page.rows)
      if (rows.length > SQLSERVER_SNAPSHOT_EXECUTOR_MAX_ROWS) {
        fail('SQLSERVER_SNAPSHOT_EXECUTOR_SCALE_UNCERTIFIED')
      }
      if (page.rows.length < SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_SIZE) {
        const completeness = adjudicate(
          engineMajorVersion,
          pageSizes,
          rows.length,
        )
        output = {
          rows,
          evidence: {
            profileId: SQLSERVER_SNAPSHOT_PAGED_READ_PROFILE.profileId,
            engineMajorVersion,
            contextState: 'COMPLETED',
            pageSize: SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_SIZE,
            pageCount: pageSizes.length,
            totalRowCount: rows.length,
            sameSessionAcrossPages: true,
            snapshotTransactionObserved: true,
            completeness,
          },
        }
        break
      }
    }

    if (output === null) {
      fail('SQLSERVER_SNAPSHOT_EXECUTOR_SCALE_UNCERTIFIED')
    }

    stage = 'COMMIT'
    await transaction.commit()
    committed = true
    output = cloneStrict(output, 'SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_READ_FAILED')
  } catch (error) {
    failureReason = isBrandedError(error)
      ? error.reason
      : stageFailureReason(stage)
  }

  if (transaction !== null && transactionBegun && !committed) {
    try {
      await transaction.rollback()
    } catch {
      // Cleanup is best-effort after a primary refusal.
    }
  }

  if (pool !== null) {
    try {
      await pool.close()
    } catch {
      if (failureReason === null) {
        failureReason = 'SQLSERVER_SNAPSHOT_EXECUTOR_CLEANUP_FAILED'
      }
    }
  }

  if (failureReason !== null) fail(failureReason)
  return output
}

module.exports = Object.freeze({
  SQLSERVER_SNAPSHOT_EXECUTOR_FIXTURE_TABLE,
  SQLSERVER_SNAPSHOT_EXECUTOR_PAGE_SIZE,
  SQLSERVER_SNAPSHOT_EXECUTOR_MAX_PAGES,
  SQLSERVER_SNAPSHOT_EXECUTOR_MAX_ROWS,
  SQLSERVER_SNAPSHOT_EXECUTOR_ERROR_REASONS,
  executeSqlServerSnapshotPageSequence,
})
