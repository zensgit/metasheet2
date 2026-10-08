// B1c SQL Server explicit-SNAPSHOT page-sequence capability spike.
//
// EVIDENCE ONLY. This runs only against a first-party, ephemeral SQL Server instance and a
// fixed throwaway database. It does not mint a profile, register a runtime executor, touch a
// customer system, activate a binding, or authorize deployment.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  MutationLog,
  assertSelectOnly,
  assertWriteOptIn,
} from './spike-b1b-shared'
import {
  B1C_CAPABILITY_POSTURE,
  B1C_CONSISTENCY_PROOF,
  B1C_CONTROL_IDS,
  B1C_CONTINUATION_LIFETIME,
  assertValidB1cSqlServerEvidenceRecord,
  b1cEvidenceFileName,
  classifyPageSequenceMeasurement,
  compareSequence,
  type B1cSqlServerEvidenceRecord,
  type PageSequenceMeasurement,
} from './spike-b1c-shared'

const env = process.env
const SPIKE_DATABASE = 'b1c_spike_sqlserver'
const SPIKE_TABLE = 'b1c_page_sequence'
const PAGE_SIZE = 3
const MAX_PAGES = 10
const SNAPSHOT_NOT_ALLOWED_ERROR = 3952
const SYSTEM_DATABASE_NAMES: ReadonlySet<string> = new Set([
  'master',
  'model',
  'msdb',
  'tempdb',
])
const EXPECTED_ORIGINAL_KEYS = Object.freeze([10, 20, 30, 40, 50, 60, 70, 80])
const EXPECTED_MUTATED_KEYS = Object.freeze([10, 80, 20, 25, 30, 40, 50, 70])
const PRODUCT_VERSION_PREFIX: Readonly<Record<'2019' | '2022', string>> =
  Object.freeze({
    '2019': '15.',
    '2022': '16.',
  })

interface MssqlRecordset<T> extends Array<T> {}
interface MssqlResult<T> {
  readonly recordset: MssqlRecordset<T>
}
export interface MssqlRequestLike {
  input(name: string, value: unknown): MssqlRequestLike
  query<T = Record<string, unknown>>(sql: string): Promise<MssqlResult<T>>
  batch<T = Record<string, unknown>>(sql: string): Promise<MssqlResult<T>>
}
interface MssqlConnectionPoolLike {
  connect(): Promise<MssqlConnectionPoolLike>
  close(): Promise<void>
  request(): MssqlRequestLike
  on(event: 'error', listener: () => void): MssqlConnectionPoolLike
}
export interface MssqlTransactionLike {
  begin(isolationLevel: number): Promise<MssqlTransactionLike>
  commit(): Promise<void>
  rollback(): Promise<void>
  request(): MssqlRequestLike
}
interface MssqlModuleLike {
  ConnectionPool: new (
    config: Record<string, unknown>,
  ) => MssqlConnectionPoolLike
  Transaction: new (pool: MssqlConnectionPoolLike) => MssqlTransactionLike
  ISOLATION_LEVEL: {
    readonly READ_COMMITTED: number
    readonly SNAPSHOT: number
  }
}

let mssql: MssqlModuleLike | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  mssql = require('mssql') as MssqlModuleLike
} catch {
  // Reported only when the opt-in real-engine path is invoked.
}

function requiredEnv(name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function declaredEngineVersion(): '2019' | '2022' {
  const value = requiredEnv('B1C_MSSQL_DECLARED_MAJOR_VERSION')
  if (value !== '2019' && value !== '2022') {
    throw new Error(
      'spike-b1c-sqlserver: declared engine version is outside the 2019/2022 matrix',
    )
  }
  return value
}

export function assertB1cDatabaseTarget(name: string): void {
  if (
    SYSTEM_DATABASE_NAMES.has(name.toLowerCase()) ||
    name !== SPIKE_DATABASE
  ) {
    throw new Error(
      'spike-b1c-sqlserver: refusing to target a database other than the dedicated B1c database',
    )
  }
}

function connectionConfig(database: string): Record<string, unknown> {
  return {
    server: env.MSSQL_HOST || env.MSSQL_SERVER,
    port: env.MSSQL_PORT ? Number(env.MSSQL_PORT) : 1433,
    database,
    user: requiredEnv('MSSQL_USERNAME'),
    password: requiredEnv('MSSQL_PASSWORD'),
    options: {
      encrypt: env.MSSQL_ENCRYPT !== 'false',
      trustServerCertificate: env.MSSQL_TRUST_SERVER_CERTIFICATE !== 'false',
    },
    connectionTimeout: 10_000,
    requestTimeout: 15_000,
    // One physical connection per pool makes any accidental pool.request() while a
    // transaction owns that connection block/fail instead of silently reading another
    // snapshot. Page helpers accept only a transaction, so the intended path cannot do that.
    pool: { max: 1, min: 1 },
  }
}

async function openPool(database: string): Promise<MssqlConnectionPoolLike> {
  if (!mssql) throw new Error('mssql package is not installed')
  const pool = new mssql.ConnectionPool(connectionConfig(database))
  // A killed loss-control connection may emit at pool level in addition to rejecting the
  // transaction request. The request rejection is the measured signal; prevent an unhandled
  // EventEmitter error from terminating the process before it can be recorded.
  pool.on('error', () => undefined)
  await pool.connect()
  return pool
}

function probeSql(sql: string): string {
  return assertSelectOnly(sql, 'spike-b1c-sqlserver')
}

async function poolScalar<T>(
  pool: MssqlConnectionPoolLike,
  sql: string,
): Promise<T> {
  const result = await pool
    .request()
    .query<Record<string, unknown>>(probeSql(sql))
  const row = result.recordset[0]
  const key = row ? Object.keys(row)[0] : undefined
  return (key ? row![key] : undefined) as T
}

interface PageRow {
  readonly keyValue: number
  readonly sessionId: number
}

export interface SnapshotPage {
  readonly keys: readonly number[]
  readonly sessionId: number
}

function positiveInteger(value: unknown, field: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`spike-b1c-sqlserver: ${field} was not a positive integer`)
  }
  return number
}

export async function readSnapshotPage(
  transaction: MssqlTransactionLike,
  offset: number,
  pageSize: number,
): Promise<SnapshotPage> {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1
  ) {
    throw new Error('spike-b1c-sqlserver: invalid page bounds')
  }
  const result = await transaction
    .request()
    .input('offset', offset)
    .input('pageSize', pageSize)
    .query<PageRow>(
      probeSql(
        `SELECT row_id AS keyValue, @@SPID AS sessionId
         FROM dbo.${SPIKE_TABLE}
         ORDER BY sort_key ASC, row_id ASC
         OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`,
      ),
    )
  if (result.recordset.length === 0) {
    throw new Error(
      'spike-b1c-sqlserver: page sequence reached an unexpected empty page',
    )
  }
  const sessionIds = new Set(
    result.recordset.map((row) =>
      positiveInteger(row.sessionId, 'page session id'),
    ),
  )
  if (sessionIds.size !== 1) {
    throw new Error('spike-b1c-sqlserver: one page crossed SQL Server sessions')
  }
  return {
    keys: result.recordset.map((row) =>
      positiveInteger(row.keyValue, 'synthetic row key'),
    ),
    sessionId: [...sessionIds][0]!,
  }
}

export interface SnapshotPageSequence {
  readonly keys: readonly number[]
  readonly sessionIds: readonly number[]
  readonly pageSizes: readonly number[]
}

export async function readSnapshotPageSequence(
  transaction: MssqlTransactionLike,
  pageSize: number,
  afterFirstPage: () => Promise<void>,
): Promise<SnapshotPageSequence> {
  const keys: number[] = []
  const sessionIds: number[] = []
  const pageSizes: number[] = []
  for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
    const page = await readSnapshotPage(
      transaction,
      pageIndex * pageSize,
      pageSize,
    )
    keys.push(...page.keys)
    sessionIds.push(page.sessionId)
    pageSizes.push(page.keys.length)
    if (pageIndex === 0) await afterFirstPage()
    if (page.keys.length < pageSize) {
      return { keys, sessionIds, pageSizes }
    }
  }
  throw new Error(
    'spike-b1c-sqlserver: page sequence exceeded the bounded page budget',
  )
}

interface ConnectionLossObservation {
  readonly killedSessionAbsent: boolean
  readonly pageAfterLossRejected: boolean
  readonly commitAfterLossRejected: boolean
  readonly transactionFactoryCalls: number
}

export async function runConnectionLossControl(
  createTransaction: () => MssqlTransactionLike,
  snapshotIsolationLevel: number,
  killAndConfirmSessionAbsent: (sessionId: number) => Promise<boolean>,
): Promise<ConnectionLossObservation> {
  let transactionFactoryCalls = 0
  const transaction = createTransaction()
  transactionFactoryCalls += 1
  let committed = false
  try {
    await transaction.begin(snapshotIsolationLevel)
    const firstPage = await readSnapshotPage(transaction, 0, PAGE_SIZE)
    const killedSessionAbsent = await killAndConfirmSessionAbsent(
      firstPage.sessionId,
    )

    let pageAfterLossRejected = false
    try {
      await readSnapshotPage(transaction, PAGE_SIZE, PAGE_SIZE)
    } catch {
      pageAfterLossRejected = true
    }

    let commitAfterLossRejected = false
    try {
      await transaction.commit()
      committed = true
    } catch {
      commitAfterLossRejected = true
    }
    return {
      killedSessionAbsent,
      pageAfterLossRejected,
      commitAfterLossRejected,
      transactionFactoryCalls,
    }
  } finally {
    if (!committed) await transaction.rollback().catch(() => undefined)
  }
}

interface SnapshotState {
  readonly sessionId: number
  readonly isolationLevel: number
  readonly activeSnapshotCount: number
}

async function readSnapshotState(
  transaction: MssqlTransactionLike,
): Promise<SnapshotState> {
  const result = await transaction.request().query<{
    sessionId: number
    isolationLevel: number
    activeSnapshotCount: number | string
  }>(
    probeSql(
      `SELECT
         @@SPID AS sessionId,
         (SELECT transaction_isolation_level
            FROM sys.dm_exec_sessions
           WHERE session_id = @@SPID) AS isolationLevel,
         (SELECT COUNT_BIG(*)
            FROM sys.dm_tran_active_snapshot_database_transactions
           WHERE session_id = @@SPID AND is_snapshot = 1) AS activeSnapshotCount`,
    ),
  )
  const row = result.recordset[0]
  if (!row)
    throw new Error('spike-b1c-sqlserver: snapshot-state query returned no row')
  return {
    sessionId: positiveInteger(row.sessionId, 'snapshot session id'),
    isolationLevel: positiveInteger(
      row.isolationLevel,
      'snapshot isolation level',
    ),
    activeSnapshotCount: Number(row.activeSnapshotCount),
  }
}

async function readCurrentKeys(
  pool: MssqlConnectionPoolLike,
): Promise<number[]> {
  const result = await pool.request().query<{ keyValue: number }>(
    probeSql(
      `SELECT row_id AS keyValue
         FROM dbo.${SPIKE_TABLE}
        ORDER BY sort_key ASC, row_id ASC`,
    ),
  )
  return result.recordset.map((row) =>
    positiveInteger(row.keyValue, 'synthetic row key'),
  )
}

async function applyWriterMutations(
  pool: MssqlConnectionPoolLike,
): Promise<number> {
  const result = await pool.request().batch<{
    insertedCount: number
    deletedCount: number
    updatedCount: number
  }>(
    `SET NOCOUNT ON;
     SET XACT_ABORT ON;
     DECLARE @insertedCount INT;
     DECLARE @deletedCount INT;
     DECLARE @updatedCount INT;
     BEGIN TRANSACTION;
       INSERT INTO dbo.${SPIKE_TABLE} (row_id, sort_key) VALUES (25, 25);
       SET @insertedCount = @@ROWCOUNT;
       DELETE FROM dbo.${SPIKE_TABLE} WHERE row_id = 60;
       SET @deletedCount = @@ROWCOUNT;
       UPDATE dbo.${SPIKE_TABLE} SET sort_key = 15 WHERE row_id = 80;
       SET @updatedCount = @@ROWCOUNT;
       IF @insertedCount <> 1 OR @deletedCount <> 1 OR @updatedCount <> 1
         THROW 51000, 'B1c mutation cardinality mismatch', 1;
     COMMIT TRANSACTION;
     SELECT
       @insertedCount AS insertedCount,
       @deletedCount AS deletedCount,
       @updatedCount AS updatedCount;`,
  )
  const row = result.recordset[0]
  if (!row) {
    throw new Error(
      'spike-b1c-sqlserver: writer mutation counts were not returned',
    )
  }
  return (
    positiveInteger(row.insertedCount, 'inserted mutation count') +
    positiveInteger(row.deletedCount, 'deleted mutation count') +
    positiveInteger(row.updatedCount, 'updated mutation count')
  )
}

export function sqlServerErrorNumbers(error: unknown): readonly number[] {
  const numbers = new Set<number>()
  const seen = new Set<object>()
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ]
  while (pending.length > 0) {
    const next = pending.pop()!
    if (
      next.depth > 4 ||
      typeof next.value !== 'object' ||
      next.value === null ||
      seen.has(next.value)
    ) {
      continue
    }
    seen.add(next.value)
    let descriptors: PropertyDescriptorMap
    try {
      descriptors = Object.getOwnPropertyDescriptors(next.value)
    } catch {
      continue
    }
    const numberDescriptor = descriptors.number
    if (numberDescriptor && 'value' in numberDescriptor) {
      const number = Number(numberDescriptor.value)
      if (Number.isInteger(number)) numbers.add(number)
    }
    for (const key of ['originalError', 'cause'] as const) {
      const descriptor = descriptors[key]
      if (descriptor && 'value' in descriptor) {
        pending.push({ value: descriptor.value, depth: next.depth + 1 })
      }
    }
  }
  return [...numbers]
}

export function isSnapshotNotAllowedError(error: unknown): boolean {
  const numbers = sqlServerErrorNumbers(error)
  return numbers.length === 1 && numbers[0] === SNAPSHOT_NOT_ALLOWED_ERROR
}

async function waitForSessionAbsent(
  masterPool: MssqlConnectionPoolLike,
  sessionId: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await masterPool
      .request()
      .input('sessionId', sessionId)
      .query<{ presentCount: number | string }>(
        probeSql(
          `SELECT COUNT_BIG(*) AS presentCount
             FROM sys.dm_exec_sessions
            WHERE session_id = @sessionId`,
        ),
      )
    const count = Number(result.recordset[0]?.presentCount)
    if (!Number.isInteger(count) || count < 0 || count > 1) {
      throw new Error(
        'spike-b1c-sqlserver: killed-session presence probe returned an invalid count',
      )
    }
    if (count === 0) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

export function assertExactB1cControlRoster(ids: readonly string[]): void {
  if (
    ids.length !== B1C_CONTROL_IDS.length ||
    ids.some((id, index) => id !== B1C_CONTROL_IDS[index])
  ) {
    throw new Error(
      'spike-b1c-sqlserver: executed control roster does not match the frozen B1c roster',
    )
  }
}

async function setSnapshotIsolation(
  masterPool: MssqlConnectionPoolLike,
  state: 'ON' | 'OFF',
): Promise<void> {
  assertB1cDatabaseTarget(SPIKE_DATABASE)
  await masterPool
    .request()
    .batch(
      `ALTER DATABASE [${SPIKE_DATABASE}] SET ALLOW_SNAPSHOT_ISOLATION ${state}`,
    )
}

async function dropSpikeDatabase(
  masterPool: MssqlConnectionPoolLike,
): Promise<void> {
  assertB1cDatabaseTarget(SPIKE_DATABASE)
  await masterPool.request().batch(
    `IF DB_ID('${SPIKE_DATABASE}') IS NOT NULL
     BEGIN
       ALTER DATABASE [${SPIKE_DATABASE}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
       DROP DATABASE [${SPIKE_DATABASE}];
     END`,
  )
}

function persistEvidence(record: B1cSqlServerEvidenceRecord): void {
  const evidenceDir = env.B1C_EVIDENCE_DIR
  if (!evidenceDir) return
  fs.mkdirSync(evidenceDir, { recursive: true })
  fs.writeFileSync(
    path.join(evidenceDir, b1cEvidenceFileName(record.engineMajorVersion)),
    JSON.stringify(record, null, 2),
  )
}

async function main(): Promise<void> {
  if (!env.MSSQL_HOST && !env.MSSQL_SERVER) {
    throw new Error(
      'spike-b1c-sqlserver: MSSQL_HOST or MSSQL_SERVER is required',
    )
  }
  if (!mssql) throw new Error('mssql package is not installed')
  const sql = mssql
  assertWriteOptIn(env, 'spike-b1c-sqlserver')
  const engineMajorVersion = declaredEngineVersion()
  const log = new MutationLog()
  let observationsTaken = 0
  const observed = <T>(value: T): T => {
    observationsTaken += 1
    return value
  }

  let missingOptInRejected = false
  try {
    assertWriteOptIn({}, 'spike-b1c-sqlserver-control')
  } catch {
    missingOptInRejected = true
  }
  log.check(
    'B1C-WRITE-OPT-IN',
    'unset write opt-in is refused before any throwaway-database mutation',
    'RED',
    !missingOptInRejected,
  )
  let wrongDatabaseRejected = false
  try {
    assertB1cDatabaseTarget('b1b_spike_sqlserver')
  } catch {
    wrongDatabaseRejected = true
  }
  log.check(
    'B1C-DEDICATED-DATABASE',
    'a sibling spike database is refused by the exact target guard',
    'RED',
    !wrongDatabaseRejected,
  )

  let masterPool: MssqlConnectionPoolLike | null = null
  let controlPool: MssqlConnectionPoolLike | null = null
  let readerPool: MssqlConnectionPoolLike | null = null
  let writerPool: MssqlConnectionPoolLike | null = null
  let lossPool: MssqlConnectionPoolLike | null = null
  let controlTransaction: MssqlTransactionLike | null = null
  let snapshotTransaction: MssqlTransactionLike | null = null
  let measured: Omit<PageSequenceMeasurement, 'cleanupComplete'> | null = null
  let primaryError: unknown
  let cleanupError: unknown
  let cleanupComplete = false

  try {
    masterPool = await openPool('master')
    await dropSpikeDatabase(masterPool)
    await masterPool.request().batch(`CREATE DATABASE [${SPIKE_DATABASE}]`)

    const observedProductVersion = String(
      observed(
        await poolScalar<string>(
          masterPool,
          `SELECT CONVERT(VARCHAR(128), SERVERPROPERTY('ProductVersion')) AS v`,
        ),
      ),
    )
    if (
      !observedProductVersion.startsWith(
        PRODUCT_VERSION_PREFIX[engineMajorVersion],
      )
    ) {
      throw new Error(
        'spike-b1c-sqlserver: observed engine version does not match the declared matrix cell',
      )
    }

    controlPool = await openPool(SPIKE_DATABASE)
    await controlPool.request().batch(
      `CREATE TABLE dbo.${SPIKE_TABLE} (
         row_id INT NOT NULL PRIMARY KEY,
         sort_key INT NOT NULL UNIQUE
       );
       INSERT INTO dbo.${SPIKE_TABLE} (row_id, sort_key)
       VALUES (10,10),(20,20),(30,30),(40,40),(50,50),(60,60),(70,70),(80,80);`,
    )
    await controlPool.close()
    controlPool = null

    await setSnapshotIsolation(masterPool, 'OFF')
    controlPool = await openPool(SPIKE_DATABASE)
    const snapshotOffReadback = Number(
      observed(
        await poolScalar<number>(
          controlPool,
          'SELECT snapshot_isolation_state AS v FROM sys.databases WHERE database_id = DB_ID()',
        ),
      ),
    )
    if (snapshotOffReadback !== 0) {
      throw new Error(
        'spike-b1c-sqlserver: snapshot-isolation OFF precondition was not established',
      )
    }

    // Positive connection control: the same pool can execute a normal transaction while
    // SNAPSHOT is disabled, so the negative control below is not an authentication failure.
    const readCommittedControl = new sql.Transaction(controlPool)
    await readCommittedControl.begin(sql.ISOLATION_LEVEL.READ_COMMITTED)
    await readCommittedControl
      .request()
      .query(probeSql(`SELECT COUNT_BIG(*) AS v FROM dbo.${SPIKE_TABLE}`))
    await readCommittedControl.rollback()

    controlTransaction = new sql.Transaction(controlPool)
    let snapshotAccessSucceededWhileDisabled = false
    let snapshotDisabledRejected = false
    try {
      await controlTransaction.begin(sql.ISOLATION_LEVEL.SNAPSHOT)
      // SQL Server defines the transaction start at first data access. Include that access
      // in the negative control instead of assuming begin() alone is the failure point.
      await controlTransaction
        .request()
        .query(probeSql(`SELECT COUNT_BIG(*) AS v FROM dbo.${SPIKE_TABLE}`))
      snapshotAccessSucceededWhileDisabled = true
    } catch (error) {
      snapshotDisabledRejected = isSnapshotNotAllowedError(error)
    } finally {
      await controlTransaction.rollback().catch(() => undefined)
      controlTransaction = null
    }
    snapshotDisabledRejected =
      !snapshotAccessSucceededWhileDisabled && snapshotDisabledRejected
    log.check(
      'B1C-SNAPSHOT-OFF-NEGATIVE',
      'explicit SNAPSHOT first data access while ALLOW_SNAPSHOT_ISOLATION is OFF rejects with SQL Server 3952',
      'RED',
      !snapshotDisabledRejected,
    )
    await controlPool.close()
    controlPool = null

    await setSnapshotIsolation(masterPool, 'ON')
    readerPool = await openPool(SPIKE_DATABASE)
    writerPool = await openPool(SPIKE_DATABASE)
    const snapshotEnabledReadback =
      Number(
        observed(
          await poolScalar<number>(
            readerPool,
            'SELECT snapshot_isolation_state AS v FROM sys.databases WHERE database_id = DB_ID()',
          ),
        ),
      ) === 1

    snapshotTransaction = new sql.Transaction(readerPool)
    await snapshotTransaction.begin(sql.ISOLATION_LEVEL.SNAPSHOT)
    const firstPageContext: {
      snapshotState?: SnapshotState
      writerSessionId?: number
    } = {}
    let writerMutationsCommitted = 0
    const pageSequence = await readSnapshotPageSequence(
      snapshotTransaction,
      PAGE_SIZE,
      async () => {
        // This is deliberately the first transaction-scoped observation after page 1. A
        // SNAPSHOT transaction starts its data snapshot at first data access, not at BEGIN.
        firstPageContext.snapshotState = observed(
          await readSnapshotState(snapshotTransaction!),
        )
        firstPageContext.writerSessionId = positiveInteger(
          observed(await poolScalar<number>(writerPool!, 'SELECT @@SPID AS v')),
          'writer session id',
        )
        writerMutationsCommitted = await applyWriterMutations(writerPool!)
      },
    )
    await snapshotTransaction.commit()
    snapshotTransaction = null

    const snapshotState = firstPageContext.snapshotState
    const writerSessionId = firstPageContext.writerSessionId
    if (!snapshotState || writerSessionId === undefined) {
      throw new Error(
        'spike-b1c-sqlserver: first-page snapshot observation was not recorded',
      )
    }
    observationsTaken += pageSequence.pageSizes.length
    const snapshotComparison = compareSequence(
      pageSequence.keys,
      EXPECTED_ORIGINAL_KEYS,
    )
    const freshKeys = observed(await readCurrentKeys(writerPool))
    const freshComparison = compareSequence(freshKeys, EXPECTED_MUTATED_KEYS)
    const sameSessionAcrossPages =
      pageSequence.sessionIds.length === pageSequence.pageSizes.length &&
      pageSequence.sessionIds.every(
        (sessionId) => sessionId === snapshotState!.sessionId,
      )
    log.check(
      'B1C-FOREIGN-SESSION-CONTROL',
      'the independently opened writer session must not equal the transaction-bound reader session',
      'RED',
      snapshotState.sessionId === writerSessionId,
    )
    log.check(
      'B1C-SEQUENCE-DISCRIMINATOR',
      'the pre-mutation snapshot sequence must not equal the independently verified post-mutation order',
      'RED',
      compareSequence(pageSequence.keys, EXPECTED_MUTATED_KEYS).matchesExpected,
    )

    lossPool = await openPool(SPIKE_DATABASE)
    const loss = observed(
      await runConnectionLossControl(
        () => new sql.Transaction(lossPool!),
        sql.ISOLATION_LEVEL.SNAPSHOT,
        async (sessionId) => {
          positiveInteger(sessionId, 'loss-control session id')
          await masterPool!.request().batch(`KILL ${sessionId}`)
          return waitForSessionAbsent(masterPool!, sessionId)
        },
      ),
    )

    measured = {
      snapshotEnabledReadback,
      snapshotIsolationObserved:
        snapshotState.isolationLevel === sql.ISOLATION_LEVEL.SNAPSHOT,
      activeSnapshotObserved: snapshotState.activeSnapshotCount >= 1,
      sameSessionAcrossPages,
      terminalShortPageObserved:
        pageSequence.pageSizes.length > 0 &&
        pageSequence.pageSizes[pageSequence.pageSizes.length - 1]! < PAGE_SIZE,
      snapshotMatchesOriginal: snapshotComparison.matchesExpected,
      freshStateMatchesMutated: freshComparison.matchesExpected,
      snapshotDisabledRejected,
      killedSessionAbsent: loss.killedSessionAbsent,
      connectionLossRejected: loss.pageAfterLossRejected,
      commitAfterLossRejected: loss.commitAfterLossRejected,
      lossControlTransactionFactoryCalls: loss.transactionFactoryCalls,
      writerMutationsCommitted,
      pageSize: PAGE_SIZE,
      originalRowCount: EXPECTED_ORIGINAL_KEYS.length,
      snapshotRowCount: snapshotComparison.rowCount,
      snapshotDuplicateCount: snapshotComparison.duplicateCount,
      snapshotMissingCount: snapshotComparison.missingCount,
      snapshotUnexpectedCount: snapshotComparison.unexpectedCount,
      freshRowCount: freshComparison.rowCount,
      freshDuplicateCount: freshComparison.duplicateCount,
      freshMissingCount: freshComparison.missingCount,
      freshUnexpectedCount: freshComparison.unexpectedCount,
      pageCount: pageSequence.pageSizes.length,
      pageSessionObservationCount: pageSequence.sessionIds.length,
    }
  } catch (error) {
    primaryError = error
  } finally {
    await controlTransaction?.rollback().catch(() => undefined)
    await snapshotTransaction?.rollback().catch(() => undefined)
    for (const pool of [controlPool, readerPool, writerPool, lossPool]) {
      await pool?.close().catch((error) => {
        cleanupError ??= error
      })
    }
    if (masterPool) {
      await dropSpikeDatabase(masterPool).catch((error) => {
        cleanupError ??= error
      })
      if (cleanupError === undefined) {
        await poolScalar<number | null>(
          masterPool,
          `SELECT DB_ID('${SPIKE_DATABASE}') AS v`,
        )
          .then((databaseId) => {
            cleanupComplete = databaseId === null
            if (!cleanupComplete) {
              cleanupError = new Error(
                'spike-b1c-sqlserver: throwaway database still exists after cleanup',
              )
            }
          })
          .catch((error) => {
            cleanupError ??= error
          })
      }
      await masterPool.close().catch((error) => {
        cleanupError ??= error
      })
    }
  }

  if (primaryError !== undefined) throw primaryError
  if (cleanupError !== undefined) throw cleanupError
  if (!measured)
    throw new Error('spike-b1c-sqlserver: measurement was not produced')

  const measurement: PageSequenceMeasurement = {
    ...measured,
    cleanupComplete,
  }
  const summary = log.summary()
  assertExactB1cControlRoster(log.all().map((entry) => entry.id))
  const harnessComplete = summary.failed === 0
  const outcome = classifyPageSequenceMeasurement(measurement, harnessComplete)
  const record: B1cSqlServerEvidenceRecord = {
    evidenceSchemaVersion: 1,
    dialect: 'sqlserver',
    engineMajorVersion,
    capabilityPosture: B1C_CAPABILITY_POSTURE,
    outcome,
    consistencyProof: B1C_CONSISTENCY_PROOF,
    continuationLifetime: B1C_CONTINUATION_LIFETIME,
    ...measurement,
    controlsTotal: summary.total,
    controlsPassed: summary.passed,
    observationsTaken,
    recordedAt: new Date().toISOString(),
  }
  assertValidB1cSqlServerEvidenceRecord(record)
  persistEvidence(record)
  console.log(
    '[b1c-sqlserver] RECORD (values-free):',
    JSON.stringify(record, null, 2),
  )
  log.assertAllPassed('b1c-sqlserver')
}

const entryUrl = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : ''
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    console.error('[failed] B1c SQL Server snapshot page-sequence spike')
    console.error(error instanceof Error ? error.name : 'UnknownError')
    process.exitCode = 1
  })
}
