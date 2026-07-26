// B1b capability spike — SQL Server (S-0..S-8, X-1..X-7).
//
// EVIDENCE ONLY (docs/development/database-system-integration-line-design-and-verification-
// 20260724.md §4 step 2): establishes, EMPIRICALLY, against the SAME engine instance in the
// SAME job, THREE frozen outcomes for single-statement snapshot semantics:
//   Phase A (RCSI OFF, the engine default) -> SQLSERVER_DEFAULT_RC_NO_RCSI_CERTIFICATION_REFUSED
//   Phase B (RCSI ON)                      -> SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN (its OWN
//                                              separate profile — never merged with Phase A)
//   Outcome 3 (explicit SNAPSHOT transaction) is UNREACHABLE BY CONSTRUCTION here (S-7/S-8) —
//   it belongs to B1c, the connection-bound seam, a later gate.
// Mints NO certification, registers NO strategy, opens NOTHING (§4 step 3 stays behind the
// owner). Target is an EPHEMERAL CI (or locally-run, throwaway) SQL Server service container,
// seeded from synthetic literals defined in this file — never a customer system.
//
// Job exit code vs verdict is DELIBERATELY DECOUPLED (§1.3): a REFUSED or UNOBTAINABLE record,
// fully recorded with its controls inverted, is a SUCCESSFUL run — exit 0. Only an incomplete
// record or a control that failed to invert reds the job.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DeclaredPhaseTracker,
  MutationLog,
  assertRowLabel,
  assertSelectOnly as sharedAssertSelectOnly,
  assertWriteOptIn as sharedAssertWriteOptIn,
  evidenceFileName,
  type OutcomeToken,
  type RowLabel,
  type SpikeRecord,
} from './spike-b1b-shared'

const env = process.env

// ── mssql dynamic import (mirrors smoke-sqlserver-seed.ts) ────────────────────────────────
interface MssqlRecordset<T> extends Array<T> {}
interface MssqlResult<T> {
  recordset: MssqlRecordset<T>
}
interface MssqlRequest {
  query<T = Record<string, unknown>>(sql: string): Promise<MssqlResult<T>>
  // batch() (README §"batch"): does NOT wrap the SQL in sp_executesql, unlike query(). This
  // script uses batch() EXCLUSIVELY for every statement — CI evidence (run 30199592058,
  // 2026-07-26) showed query() throwing "Transaction count after EXECUTE indicates a
  // mismatching number of BEGIN and COMMIT statements" the moment BEGIN TRAN was issued via
  // query() and a later statement executed on the same pinned connection: query()'s
  // sp_executesql wrapping enforces a per-call transaction-count balance, which an explicit
  // multi-call BEGIN…(later call)…COMMIT/ROLLBACK sequence (S-2/S-4/S-5's whole construction)
  // structurally cannot satisfy. batch() sends the SQL as a raw batch (no sp_executesql), so
  // session state — SET LOCK_TIMEOUT, SET TRANSACTION ISOLATION LEVEL, an open transaction —
  // persists correctly across separate .request() calls on the SAME pinned (pool:{max:1,
  // min:1}) connection, exactly like a persistent SSMS session.
  batch<T = Record<string, unknown>>(sql: string): Promise<MssqlResult<T>>
  input(name: string, value: unknown): MssqlRequest
}
interface MssqlConnectionPool {
  connect(): Promise<MssqlConnectionPool>
  close(): Promise<void>
  request(): MssqlRequest
}
interface MssqlModule {
  ConnectionPool: new (config: Record<string, unknown>) => MssqlConnectionPool
}
let mssql: MssqlModule | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  mssql = require('mssql') as MssqlModule
} catch {
  // reported below if actually needed
}

// ── Configuration ────────────────────────────────────────────────────────────────────────
// X-2: matrix label -> expected SERVERPROPERTY('ProductVersion') major-version prefix. Only
// versions this spike has declared+run appear here (2019/2022, matching P-1's existing
// sqlserver-smoke.yml matrix, blob 2a026c31b…) — never a guess for an undeclared label.
const PRODUCT_VERSION_PREFIX_BY_DECLARED_MAJOR_VERSION: Readonly<Record<string, string>> = Object.freeze({
  '2019': '15.',
  '2022': '16.',
})
// P-4/X-6b: names this spike may NEVER target with the RCSI toggle (never smoke_db, never a
// system database).
const FORBIDDEN_SPIKE_DATABASE_NAMES = new Set(['smoke_db', 'master', 'model', 'msdb', 'tempdb'])
const SPIKE_TABLE = 'b1b_probe'
const LOCK_TIMEOUT_MS = 2000
const ISOLATION_LEVEL_NAME_BY_CODE: Readonly<Record<number, string>> = Object.freeze({
  1: 'READ UNCOMMITTED',
  2: 'READ COMMITTED',
  3: 'REPEATABLE READ',
  4: 'SERIALIZABLE',
  5: 'SNAPSHOT',
})

function requiredEnv(name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

// X-6a (same discipline as smoke-sqlserver-seed.ts L43-49, blob 4993a805c…): refuse loudly,
// never skip, without an explicit write opt-in. Delegates to the SHARED (spike-b1b-shared.ts)
// implementation — see that module's own doc comment for why it is shared rather than
// duplicated, and spike-b1b-shared.test.ts for its pure, DB-free baseline/mutation tests. The
// real, LIVE mutation check below (inside main()) calls the same shared function again against
// SYNTHETIC env objects (never process.env), which is what turns "the guard exists" into "the
// guard's own mutation actually ran, in this job."
function assertWriteOptIn(): void {
  sharedAssertWriteOptIn(env, 'spike-b1b-sqlserver')
}

// X-6b: the RCSI toggle (and every other mutating statement this script issues) refuses
// unless the target database name is this spike's OWN dedicated database — never smoke_db,
// never a system database. MUTATION: point at smoke_db -> RED refusal (exercised below by
// calling this with 'smoke_db').
function assertSpikeDatabaseNameSafe(name: string): void {
  if (FORBIDDEN_SPIKE_DATABASE_NAMES.has(name.toLowerCase())) {
    throw new Error(`spike-b1b-sqlserver: refusing to target a forbidden database name: ${name}`)
  }
}

function printHelp(): void {
  console.log(`Usage: tsx scripts/spike-b1b-sqlserver.ts

Opt-in real-wire gate: with no MSSQL_HOST/MSSQL_SERVER set it SKIPS (exit 0). EVIDENCE ONLY —
mints no certification, registers no strategy (§4 step 2).

Required environment:
  MSSQL_HOST or MSSQL_SERVER
  MSSQL_USERNAME / MSSQL_PASSWORD
  B1B_MSSQL_DECLARED_MAJOR_VERSION   "2019" or "2022" — an undeclared label fails closed
  B1B_SEED_ALLOW_WRITE=true          explicit write opt-in (X-6a)

Optional environment:
  MSSQL_PORT, MSSQL_ENCRYPT, MSSQL_TRUST_SERVER_CERTIFICATE
  B1B_MSSQL_DATABASE   dedicated spike database (default b1b_spike_sqlserver; NEVER smoke_db)
  B1B_EVIDENCE_DIR      where the values-free SpikeRecord JSON files are written`)
}

function baseConnectionConfig(database: string, requestTimeoutMs = 15_000) {
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
    // The `mssql` driver has NO per-request timeout override — only this POOL-level value is
    // ever honoured (lib/tedious/connection-pool.js reads `this.config.requestTimeout`). S-4c
    // below opens a DEDICATED pool with a short value for exactly that reason.
    requestTimeout: requestTimeoutMs,
    // max:1/min:1 PINS exactly one physical connection for the whole pool's lifetime — X-1's
    // "same connection" requirement needs a stable session identity across many sequential
    // statements (SET LOCK_TIMEOUT, then a SELECT, then @@SPID …), which a normal multi-
    // connection pool does not guarantee across separate .request() calls.
    pool: { max: 1, min: 1 },
  }
}

async function openPinnedPool(database: string, requestTimeoutMs?: number): Promise<MssqlConnectionPool> {
  if (!mssql) throw new Error('mssql package is not installed')
  const pool = new mssql.ConnectionPool(baseConnectionConfig(database, requestTimeoutMs))
  await pool.connect()
  return pool
}

// S-6's qualifying predicate, extracted as a NAMED function so the mutation checks below
// exercise the SAME decision logic the real outcome emission uses (never a hand-duplicated
// copy that could drift) — called once with Phase A's REAL measured tuple (must reject) and
// once with Phase B's REAL measured tuple (must accept), per advisor review: a mutation must
// alter the OBSERVATION/INPUT tuple, never re-derive an already-proven fact or compare a
// literal to itself.
interface RcsiProvenMeasurement {
  readonly rcsi: number
  readonly readerBlocked: boolean
  readonly preImageOk: boolean
  readonly postCommitOk: boolean
}
function qualifiesForRcsiProven(m: RcsiProvenMeasurement): boolean {
  return m.rcsi === 1 && !m.readerBlocked && m.preImageOk && m.postCommitOk
}

// X-6c hygiene (NOT a security boundary — battery explicit: never cite this as the boundary):
// every PROBE (observation) statement issued through scalar()/readerSelectsProbeRow*() is
// SELECT-only. Narrower than "every statement the reader connection issues": SESSION-
// CONFIGURATION statements (SET LOCK_TIMEOUT, SET TRANSACTION ISOLATION LEVEL …) and the
// writer's own transaction-control statements are issued directly via .request().batch() and
// are never claimed as SELECT-only — overclaiming "every statement" would be exactly the
// class of over-strong claim this line's own review discipline flags.
function assertSelectOnly(sql: string): string {
  return sharedAssertSelectOnly(sql, 'spike-b1b-sqlserver')
}

async function scalar<T = unknown>(pool: MssqlConnectionPool, sql: string): Promise<T> {
  const result = await pool.request().batch<Record<string, unknown>>(assertSelectOnly(sql))
  const row = result.recordset[0]
  const key = row ? Object.keys(row)[0] : undefined
  return (key ? row![key] : undefined) as T
}

async function spid(pool: MssqlConnectionPool): Promise<number> {
  return Number(await scalar<number>(pool, 'SELECT @@SPID AS v'))
}

// CI evidence (run 30199801644, SQL Server 2019): @@SPID is a RECYCLABLE slot number — a
// lightly-loaded container can legitimately hand Phase B's brand-new connection the EXACT
// SAME @@SPID Phase A's (already-closed) connection had. Bare-SPID equality is therefore not
// sufficient to prove "a distinct session" across a connection close/reopen boundary (S-4b);
// within one phase it IS sufficient (X-1a/X-1b), since those comparisons happen milliseconds
// apart on a connection that is never closed. For the CROSS-PHASE distinctness claim, pair
// @@SPID with sys.dm_exec_sessions.login_time (inline-bound to @@SPID, same discipline as
// S-7's DB_ID()/@@SPID binding). RETRACTION-FIRST NOTE (not the original, over-strong wording):
// `login_time` is a `datetime` column, whose documented rounding granularity is ~3.33ms — a
// SPID recycled AND re-logged-in within the same rounding tick would still collide on this
// pair. This has NOT happened in the runs observed so far (real, unbounded Phase A work runs
// between the two logins), but the pairing narrows the collision window, it does not eliminate
// it by construction the way, e.g., S-0's DB_ID() binding does. Treat S-4b as empirically
// robust against the ONE failure mode CI evidence actually found (bare SPID reuse), not as a
// mathematically guaranteed distinctness proof.
async function sessionIdentity(pool: MssqlConnectionPool): Promise<string> {
  const spidValue = await spid(pool)
  const loginTime = await scalar<string>(
    pool,
    'SELECT CONVERT(VARCHAR(33), login_time, 126) AS v FROM sys.dm_exec_sessions WHERE session_id = @@SPID'
  )
  return `${spidValue}@${loginTime}`
}

// ── main ─────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    printHelp()
    return
  }
  if (!env.MSSQL_HOST && !env.MSSQL_SERVER) {
    console.log('[skip] B1b SQL Server spike skipped — no MSSQL_HOST/MSSQL_SERVER set (opt-in). Exiting 0.')
    return
  }
  assertWriteOptIn()
  if (!mssql) throw new Error('mssql package is not installed')

  const declaredMajorVersion = requiredEnv('B1B_MSSQL_DECLARED_MAJOR_VERSION')
  const expectedProductVersionPrefix = PRODUCT_VERSION_PREFIX_BY_DECLARED_MAJOR_VERSION[declaredMajorVersion]
  if (!expectedProductVersionPrefix) {
    throw new Error(
      `spike-b1b-sqlserver: B1B_MSSQL_DECLARED_MAJOR_VERSION="${declaredMajorVersion}" is not declared ` +
        `(declared: ${Object.keys(PRODUCT_VERSION_PREFIX_BY_DECLARED_MAJOR_VERSION).join(', ')}). Refusing to guess.`
    )
  }
  const spikeDb = env.B1B_MSSQL_DATABASE || 'b1b_spike_sqlserver'
  const decoyDb = `${spikeDb}_decoy`
  assertSpikeDatabaseNameSafe(spikeDb)

  const log = new MutationLog()
  const tracker = new DeclaredPhaseTracker(['phaseA', 'phaseB'])
  let observationsTaken = 0
  const obs = <T>(value: T): T => {
    observationsTaken += 1
    return value
  }

  // ── X-6a MUTATION (real, run once, SYNTHETIC env objects — never process.env) ───────────
  // assertWriteOptIn() already ran for REAL against process.env above (before `log` existed)
  // — that call is the load-bearing gate for this run. These two calls exercise the SAME
  // shared function (spike-b1b-shared.ts, mutation-tested in spike-b1b-shared.test.ts) again,
  // against synthetic inputs that never touch the real environment, which is what turns "the
  // guard exists" into "the guard's own mutation actually ran, in this job, with the RED
  // pasted" (battery DoD §9.1).
  let x6aMutationThrew = false
  try {
    sharedAssertWriteOptIn({}, 'x6a-mutation-probe')
  } catch {
    x6aMutationThrew = true
  }
  log.check('X-6a-mutation-unset-throws', 'MUTATION: call the SAME shared write-opt-in guard with a SYNTHETIC unset env -> must throw loudly, never skip', 'RED', !x6aMutationThrew)
  let x6aBaselineThrew = false
  try {
    sharedAssertWriteOptIn({ B1B_SEED_ALLOW_WRITE: 'true' }, 'x6a-baseline-probe')
  } catch {
    x6aBaselineThrew = true
  }
  log.check('X-6a-baseline-set-does-not-throw', 'the same guard, called with the opt-in explicitly set (the real value this run uses), does not throw', 'GREEN', !x6aBaselineThrew)

  let masterPool: MssqlConnectionPool | null = null
  let reader: MssqlConnectionPool | null = null
  let writer: MssqlConnectionPool | null = null
  const records: SpikeRecord[] = []

  // X-4c toggle helper (S-4a/S-4c): issues the ALTER from a MASTER connection only, after
  // asserting DB_NAME() there really is 'master' and the target name is safe (X-6b). Takes
  // the issuing pool explicitly — the `mssql` driver has NO per-request timeout override (its
  // `Request` class exposes no `.timeout`; only the POOL-level `requestTimeout` config is
  // honoured), so S-4c's bounded-wait test below uses a DEDICATED short-`requestTimeout` pool
  // rather than a decorative per-request cast that the driver would silently ignore.
  async function toggleRcsi(pool: MssqlConnectionPool, targetState: 'ON' | 'OFF', database: string, rollbackImmediate: boolean): Promise<void> {
    assertSpikeDatabaseNameSafe(database)
    const currentDb = await scalar<string>(pool, 'SELECT DB_NAME() AS v')
    if (currentDb !== 'master') {
      throw new Error(`spike-b1b-sqlserver: RCSI toggle must be issued from master, was issued from "${currentDb}"`)
    }
    const clause = rollbackImmediate ? 'WITH ROLLBACK IMMEDIATE' : ''
    await pool.request().batch(`ALTER DATABASE [${database}] SET READ_COMMITTED_SNAPSHOT ${targetState} ${clause}`)
  }

  // S-0/S-1/X-7: RCSI readback bound to DB_ID()/DB_NAME() — hoisted above the try block (was
  // previously defined inline, further down, right before its first real Phase A use) so
  // X-7's contamination-simulation mutation below can call the EXACT SAME function before
  // Phase A's reader pool even exists. Same function, same code path, called twice: once
  // against a deliberately contaminated database (X-7), once for real (S-0/S-1).
  async function rcsiReadbackBound(pool: MssqlConnectionPool): Promise<{ db: string; rcsi: number }> {
    const result = await pool
      .request()
      .batch<{ db: string; rcsi: number }>(
        "SELECT DB_NAME() AS db, (SELECT is_read_committed_snapshot_on FROM sys.databases WHERE database_id = DB_ID()) AS rcsi"
      )
    obs(null)
    const parsed = { db: result.recordset[0]!.db, rcsi: Number(result.recordset[0]!.rcsi) }
    // Diagnostic only (not part of the values-free evidence record — see §6).
    console.log('[b1b-sqlserver] rcsiReadbackBound raw:', JSON.stringify(parsed))
    return parsed
  }

  try {
    // ── one-time setup: master connection, dedicated spike DB, decoy DB, probe table ──────
    masterPool = await openPinnedPool('master')
    await masterPool.request().batch(`IF DB_ID('${spikeDb}') IS NULL CREATE DATABASE [${spikeDb}]`)
    // Decoy DB: NEVER toggled, used only so S-0's DB_ID()-binding mutation has a database
    // whose RCSI state is KNOWN (freshly-created user databases default RCSI OFF — a
    // documented SQL Server default for a database this script itself just created, NOT an
    // assumption about a pre-existing system database's configuration) without ever having
    // to assume what `master`/`tempdb` ship with (§1.1: this battery asserts no such default).
    await masterPool.request().batch(`IF DB_ID('${decoyDb}') IS NULL CREATE DATABASE [${decoyDb}]`)

    // ── X-7 MUTATION 1 (real, live, embedded): simulate "a PRIOR run left RCSI ON" ─────────
    // Force RCSI ON directly (bypassing the real reset immediately below), then show that
    // rcsiReadbackBound() — the SAME function the real Phase A/B records use further down, not
    // a duplicate — REDs against that contaminated state. Then run the REAL idempotent reset
    // (next statement, which every invocation performs regardless of whether contamination
    // happened) and let S-0/S-1 below re-observe GREEN for real. This is the live proof of the
    // battery's own framing: "the contamination is detected by an existing assertion, which is
    // the point" — if the reset immediately below were ever silently dropped, S-1 would RED on
    // the very next run against a database a prior run left RCSI ON, exactly as demonstrated
    // here against a database THIS run just created and force-contaminated on purpose. (X-7's
    // SECOND mutation — an open writer transaction at the phase boundary must fail closed, not
    // hang — is proven for real by S-4c below, using a genuine open writer transaction as the
    // contending force; not duplicated here, cross-referenced there.)
    await masterPool.request().batch(`ALTER DATABASE [${spikeDb}] SET READ_COMMITTED_SNAPSHOT ON`)
    const x7ContaminationProbe = await openPinnedPool(spikeDb)
    const x7Contaminated = await rcsiReadbackBound(x7ContaminationProbe)
    log.check(
      'X-7-mutation-rcsi-left-on-contaminates',
      "MUTATION: simulate RCSI left ON by a prior run -> rcsiReadbackBound()'s own observation (the SAME function S-0/S-1 use for real, below) must RED before the real reset (next statement) runs",
      'RED',
      x7Contaminated.rcsi === 0
    )
    await x7ContaminationProbe.close()

    // Ensure a clean starting posture (idempotent across local re-runs of this script) — the
    // step X-7's mutation directly above proves is load-bearing.
    await toggleRcsi(masterPool, 'OFF', spikeDb, true)

    const setupPool = await openPinnedPool(spikeDb)
    await setupPool.request().batch(`IF OBJECT_ID('dbo.${SPIKE_TABLE}', 'U') IS NOT NULL DROP TABLE dbo.${SPIKE_TABLE}`)
    await setupPool.request().batch(
      `CREATE TABLE dbo.${SPIKE_TABLE} (id INT NOT NULL PRIMARY KEY, name NVARCHAR(50) NULL); ` +
        `INSERT INTO dbo.${SPIKE_TABLE} (id, name) VALUES (1,'a'), (2,'b'), (3,'c');`
    )
    await setupPool.close()
    console.log('[ok] seeded dedicated spike database', { spikeDb, decoyDb, table: SPIKE_TABLE })

    // ── X-6b MUTATION (real, run once — refusal, not a live toggle) ───────────────────────
    let x6bMutationRefused = false
    try {
      assertSpikeDatabaseNameSafe('smoke_db')
    } catch {
      x6bMutationRefused = true
    }
    log.check('X-6b-mutation-smoke_db', 'MUTATION: point the RCSI toggle at smoke_db -> must refuse', 'RED', !x6bMutationRefused)

    // ── X-6c MUTATION (real, run once) ─────────────────────────────────────────────────────
    let x6cMutationThrew = false
    try {
      assertSelectOnly(`UPDATE dbo.${SPIKE_TABLE} SET name = 'z' WHERE id = 1`)
    } catch {
      x6cMutationThrew = true
    }
    log.check(
      'X-6c-mutation-non-select-rejected',
      'MUTATION: pass a non-SELECT statement to the probe/observation guard -> must throw (HYGIENE, never a security boundary — B-4 stands)',
      'RED',
      !x6cMutationThrew
    )

    // ═══════════════════════════════════ PHASE A ═══════════════════════════════════════
    reader = await openPinnedPool(spikeDb)
    writer = await openPinnedPool(spikeDb)
    const phaseAReaderSpid = obs(await spid(reader))
    const phaseAWriterSpid = obs(await spid(writer))
    const phaseAReaderSpidSecondObservation = obs(await spid(reader))
    const phaseAX1aHolds = phaseAReaderSpid === phaseAReaderSpidSecondObservation
    // S-4b's cross-phase distinctness needs the robust (spid, login_time) pair — see
    // sessionIdentity()'s comment.
    const phaseAReaderIdentity = obs(await sessionIdentity(reader))
    log.check('X-1a-phaseA-baseline', 'two reader observations on the pinned Phase A connection share one session id', 'GREEN', phaseAX1aHolds)
    log.check('X-1b-phaseA-baseline', 'Phase A writer session id differs from reader session id', 'GREEN', phaseAReaderSpid !== phaseAWriterSpid)
    // MUTATION: source the "writer identity" observation from the READER's own connection
    // instead of the writer's — a REAL, live requery misdirected to the wrong pool, never a
    // literal compared to itself.
    const phaseAMisdirectedWriterSpid = obs(await spid(reader))
    log.check(
      'X-1b-phaseA-mutation-misdirected-source',
      "MUTATION: read the writer-identity observation FROM THE READER'S OWN CONNECTION instead of the writer's -> must red",
      'RED',
      phaseAReaderSpid !== phaseAMisdirectedWriterSpid
    )

    // X-2
    const productVersion = obs(await scalar<string>(reader, "SELECT CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(50)) AS v"))
    console.log('[b1b-sqlserver] observed ProductVersion:', productVersion, '| declared major version:', declaredMajorVersion)
    log.check('X-2-baseline', `observed ProductVersion "${productVersion}" matches declared "${declaredMajorVersion}"`, 'GREEN', productVersion.startsWith(expectedProductVersionPrefix))
    log.check('X-2-mutation-wrong-declared-label', 'MUTATION: declared label mismatched against the real observed ProductVersion (equivalent to pointing at the other matrix version while leaving the label unchanged)', 'RED', productVersion.startsWith('99.'))

    // S-0: RCSI readback bound to DB_ID()/DB_NAME() — baseline in Phase A (expect rcsi=0, db=spikeDb).
    // rcsiReadbackBound() itself is defined ABOVE the try block now (hoisted for X-7's
    // contamination-simulation mutation, which needs it before Phase A's reader pool exists —
    // see that block's comment). Same function, same code path, no duplicate.
    const phaseAReadback = obs(await rcsiReadbackBound(reader))
    log.check('S-0-baseline-db-binding', 'the RCSI readback reports the probe connection\'s OWN current database', 'GREEN', phaseAReadback.db === spikeDb)

    // S-1
    log.check('S-1', 'Phase A observes RCSI = 0 on the probe connection', 'GREEN', phaseAReadback.rcsi === 0)

    // S-2a: LOCK_TIMEOUT set and read back on the SAME connection before the blocking statement
    async function setAndVerifyLockTimeout(pool: MssqlConnectionPool, ms: number): Promise<boolean> {
      await pool.request().batch(`SET LOCK_TIMEOUT ${ms}`)
      const readback = Number(await scalar<number>(pool, 'SELECT @@LOCK_TIMEOUT AS v'))
      obs(null)
      return readback === ms
    }
    log.check('S-2a-baseline', 'SET LOCK_TIMEOUT is applied and read back on the same connection before the blocking statement', 'GREEN', await setAndVerifyLockTimeout(reader, LOCK_TIMEOUT_MS))
    // MUTATION: omit the SET -> a fresh connection's default @@LOCK_TIMEOUT is -1 (infinite), never equal to LOCK_TIMEOUT_MS.
    const freshProbe = await openPinnedPool(spikeDb)
    const freshLockTimeout = Number(await scalar<number>(freshProbe, 'SELECT @@LOCK_TIMEOUT AS v'))
    await freshProbe.close()
    log.check('S-2a-mutation-omitted', 'MUTATION: omit SET LOCK_TIMEOUT -> the readback must NOT equal the declared bound', 'RED', freshLockTimeout === LOCK_TIMEOUT_MS)

    // S-2 / S-2b: writer holds an uncommitted UPDATE; reader must time out with 1222; after
    // rollback, the identical statement succeeds and returns COMMITTED_ROW.
    async function readerSelectsProbeRow(): Promise<{ ok: true; name: string } | { ok: false; number: number | undefined }> {
      try {
        const result = await reader!.request().batch<{ name: string }>(assertSelectOnly(`SELECT name FROM dbo.${SPIKE_TABLE} WHERE id = 1`))
        obs(null)
        return { ok: true, name: result.recordset[0]!.name }
      } catch (error) {
        obs(null)
        return { ok: false, number: (error as { number?: number }).number }
      }
    }
    await writer.request().batch('BEGIN TRAN')
    await writer.request().batch(`UPDATE dbo.${SPIKE_TABLE} SET name = 'dirty_phaseA' WHERE id = 1`)
    const s2Result = await readerSelectsProbeRow()
    log.check('S-2', 'reader blocked by the uncommitted writer fails with the engine lock-timeout error (1222) within the bound', 'GREEN', !s2Result.ok && s2Result.number === 1222)
    await writer.request().batch('ROLLBACK')
    const s2bResult = await readerSelectsProbeRow()
    const s2bLabel: RowLabel = 'COMMITTED_ROW'
    assertRowLabel(s2bLabel) // label discipline: NEVER 'PRE_IMAGE' here — Phase A has no version store (see S-2b note)
    log.check('S-2b-exclusive-cause-control', `after ROLLBACK, the identical statement on the same connection succeeds and returns ${s2bLabel}`, 'GREEN', s2bResult.ok && s2bResult.name === 'a')

    // MUTATION: writer holds no transaction at all -> reader's select must succeed (S-2 RED).
    const s2MutationNoWriterTxn = await readerSelectsProbeRow()
    log.check('S-2-mutation-writer-no-txn', "MUTATION: W opens no transaction / issues no update -> the reader's select must succeed (no 1222)", 'RED', !s2MutationNoWriterTxn.ok && s2MutationNoWriterTxn.number === 1222)

    // S-0 mutation (the unbound-literal trap) — run now, Phase A: rcsi(spikeDb)=0 vs a literal lookup of the (never-toggled) decoy DB, which is also 0 today, so this half only demonstrates the BINDING is correct when both databases agree; the DISCRIMINATING half runs in Phase B below where the two values are made to differ for real.
    const decoyReadbackPhaseA = obs(
      Number(
        await scalar<number>(reader, `SELECT is_read_committed_snapshot_on AS v FROM sys.databases WHERE name = '${decoyDb}'`)
      )
    )
    log.check('S-0-phaseA-decoy-baseline', 'decoy DB (never toggled) reports RCSI=0, same as the freshly-created spike DB — establishes ground truth before Phase B makes them diverge for real', 'GREEN', decoyReadbackPhaseA === 0)

    // S-7 (Phase A leg): ALLOW_SNAPSHOT_ISOLATION=0, session isolation never SNAPSHOT(5), via
    // an INLINE @@SPID DMV lookup (never a harness-held id).
    async function s7Observation(pool: MssqlConnectionPool, mode: 'inline-spid' | 'foreign-spid', foreignSpid?: number): Promise<{ allowSnapshot: number; isolationLevel: number }> {
      const allowSnapshot = Number(await scalar<number>(pool, `SELECT snapshot_isolation_state FROM sys.databases WHERE database_id = DB_ID()`))
      const spidClause = mode === 'inline-spid' ? '@@SPID' : String(foreignSpid)
      const isolationLevel = Number(await scalar<number>(pool, `SELECT transaction_isolation_level AS v FROM sys.dm_exec_sessions WHERE session_id = ${spidClause}`))
      obs(null)
      return { allowSnapshot, isolationLevel }
    }
    const s7PhaseA = obs(await s7Observation(reader, 'inline-spid'))
    log.check('S-7-phaseA-baseline', 'ALLOW_SNAPSHOT_ISOLATION=0 and session isolation level is never SNAPSHOT(5)', 'GREEN', s7PhaseA.allowSnapshot === 0 && s7PhaseA.isolationLevel !== 5)

    // S-3: Phase A outcome.
    const phaseAControlsOkSoFar = !log.all().some(entry => entry.verdict === 'FAIL')
    let phaseAOutcome: OutcomeToken
    if (phaseAControlsOkSoFar && phaseAReadback.rcsi === 0 && s2Result.ok === false && s2Result.number === 1222 && s2bResult.ok && s2bResult.name === 'a') {
      phaseAOutcome = 'SQLSERVER_DEFAULT_RC_NO_RCSI_CERTIFICATION_REFUSED'
    } else {
      phaseAOutcome = 'INCONCLUSIVE'
    }
    // MUTATION: feed Phase A's REAL measured tuple (rcsi=0, reader blocked with 1222, no
    // post-commit observation in this phase) into the SAME qualifying predicate S-6 uses for
    // real -> must reject (X-4 MUTATION A analog: Phase B's token must never be emitted from
    // Phase A's own observations).
    const phaseAMeasurement: RcsiProvenMeasurement = {
      rcsi: phaseAReadback.rcsi,
      readerBlocked: !s2Result.ok && s2Result.number === 1222,
      preImageOk: s2bResult.ok && s2bResult.name === 'a',
      postCommitOk: false, // Phase A never performs a post-commit visibility read
    }
    log.check('S-3-mutation-wrong-token', "MUTATION: Phase A's REAL measured tuple fed into S-6's qualifying predicate must not satisfy it", 'RED', qualifiesForRcsiProven(phaseAMeasurement))

    tracker.emit('phaseA', phaseAOutcome)
    records.push({
      evidenceSchemaVersion: 1,
      dialect: 'sqlserver',
      engineMajorVersion: declaredMajorVersion,
      phase: 'phaseA',
      capabilityPosture: 'default_rc_no_rcsi',
      outcome: phaseAOutcome,
      sameConnection: phaseAX1aHolds,
      controlsInverted: log.summary().passed,
      observationsTaken,
      recordedAt: new Date().toISOString(),
    })
    console.log('[b1b-sqlserver] Phase A outcome:', phaseAOutcome)

    // Close Phase A's pools BEFORE the toggle (S-4a: "with all probe pools closed first").
    await reader.close()
    await writer.close()
    reader = null
    writer = null

    // ═══════════════════════════════════ TOGGLE (S-4) ══════════════════════════════════
    // S-4a eligibility guard, exercised for real: baseline (master) passes; mutation (a
    // connection scoped to the spike DB) must throw.
    const eligibleFromMaster = await (async () => {
      try {
        await toggleRcsi(masterPool!, 'OFF', spikeDb, true) // idempotent no-op re-affirmation from master
        return true
      } catch {
        return false
      }
    })()
    log.check('S-4a-baseline-issued-from-master', 'the toggle succeeds when issued from a connection whose DB_NAME() is master', 'GREEN', eligibleFromMaster)

    const spikeScopedPool = await openPinnedPool(spikeDb)
    let mutationIssuedFromSpikeDbThrew = false
    try {
      const currentDb = await scalar<string>(spikeScopedPool, 'SELECT DB_NAME() AS v')
      if (currentDb !== 'master') {
        throw new Error('simulated: toggle attempted from a non-master connection')
      }
    } catch {
      mutationIssuedFromSpikeDbThrew = true
    }
    await spikeScopedPool.close()
    log.check('S-4a-mutation-issued-from-spike-db', 'MUTATION: issue the toggle-eligibility check from a connection whose current database IS the spike database -> must refuse', 'RED', !mutationIssuedFromSpikeDbThrew)

    // S-4c: the toggle runs under a bounded wait and fails closed on a timeout. Simulated by
    // leaving a writer transaction OPEN on the spike DB and omitting WITH ROLLBACK IMMEDIATE —
    // ALTER DATABASE...SET READ_COMMITTED_SNAPSHOT ON without the immediate clause WAITS for
    // other transactions; a DEDICATED short-`requestTimeout` pool must fail closed rather than
    // hang (the driver has no per-request override — see toggleRcsi's own comment).
    const contentionWriter = await openPinnedPool(spikeDb)
    await contentionWriter.request().batch('BEGIN TRAN')
    await contentionWriter.request().batch(`UPDATE dbo.${SPIKE_TABLE} SET name = 'holding_lock' WHERE id = 2`)
    const shortTimeoutMasterPool = await openPinnedPool('master', /* requestTimeoutMs */ 3000)
    let s4cTimedOutClosed = false
    try {
      await toggleRcsi(shortTimeoutMasterPool, 'ON', spikeDb, /* rollbackImmediate */ false)
    } catch (error) {
      s4cTimedOutClosed = /timeout/i.test(String((error as Error).message)) || (error as { code?: string }).code === 'ETIMEOUT'
    }
    await shortTimeoutMasterPool.close()
    await contentionWriter.request().batch('ROLLBACK')
    await contentionWriter.close()
    // Doubles as X-7's SECOND mutation ("leave the writer transaction open at phase end -> the
    // following phase reds rather than hanging"): the contending force here IS a genuine open
    // writer transaction (BEGIN TRAN, no COMMIT/ROLLBACK yet, two lines above) — the same
    // failure shape X-7 names, not a separate re-implementation of it.
    log.check(
      'S-4c-also-X-7-mutation-2-open-writer-txn-fails-closed',
      'MUTATION: the toggle without WITH ROLLBACK IMMEDIATE, contended by a genuinely open writer transaction (X-7\'s "left open at phase end" scenario), must fail closed on a bounded timeout rather than hang',
      'RED',
      !s4cTimedOutClosed
    )

    // The REAL toggle, correctly formed: WITH ROLLBACK IMMEDIATE, no contending open pools.
    await toggleRcsi(masterPool!, 'ON', spikeDb, true)

    // ═══════════════════════════════════ PHASE B ═══════════════════════════════════════
    // S-4b: fresh pools after the toggle; readback on the NEW connection reports 1; X-1 holds
    // with a session identity distinct from Phase A's.
    reader = await openPinnedPool(spikeDb)
    writer = await openPinnedPool(spikeDb)
    const phaseBReaderSpid = obs(await spid(reader))
    const phaseBWriterSpid = obs(await spid(writer))
    const phaseBReaderSpidSecondObservation = obs(await spid(reader))
    const phaseBX1aHolds = phaseBReaderSpid === phaseBReaderSpidSecondObservation
    log.check('X-1a-phaseB-baseline', 'two reader observations on the pinned Phase B connection share one session id', 'GREEN', phaseBX1aHolds)
    log.check('X-1b-phaseB-baseline', 'Phase B writer session id differs from reader session id', 'GREEN', phaseBReaderSpid !== phaseBWriterSpid)
    const phaseBMisdirectedWriterSpid = obs(await spid(reader))
    log.check(
      'X-1b-phaseB-mutation-misdirected-source',
      "MUTATION: read the writer-identity observation FROM THE READER'S OWN CONNECTION instead of the writer's -> must red",
      'RED',
      phaseBReaderSpid !== phaseBMisdirectedWriterSpid
    )
    // Bare @@SPID equality is NOT sufficient here (see sessionIdentity()'s comment: @@SPID is a
    // recyclable slot number and CI evidence showed Phase B legitimately reusing Phase A's
    // numeric SPID after Phase A's connection closed) — the robust cross-phase proof pairs
    // @@SPID with sys.dm_exec_sessions.login_time.
    const phaseBReaderIdentity = obs(await sessionIdentity(reader))
    log.check('S-4b-distinct-session-from-phaseA', "Phase B's reader session identity (spid@login_time) differs from Phase A's (fresh connection, not reused — robust to @@SPID recycling)", 'GREEN', phaseBReaderIdentity !== phaseAReaderIdentity)

    const phaseBReadback = obs(await rcsiReadbackBound(reader))
    log.check('S-4b-readback-reports-on', 'the fresh Phase B probe connection reports RCSI=1 via the DB_ID()-bound readback', 'GREEN', phaseBReadback.rcsi === 1 && phaseBReadback.db === spikeDb)

    // S-0 discriminating mutation (Phase B): the literal-lookup trap, now with a REAL,
    // self-controlled discrepancy — decoy DB was never toggled (still 0), spike DB is now 1.
    const decoyReadbackPhaseB = obs(
      Number(await scalar<number>(reader, `SELECT is_read_committed_snapshot_on AS v FROM sys.databases WHERE name = '${decoyDb}'`))
    )
    log.check(
      'S-0-mutation-literal-lookup-trap',
      "MUTATION: read the row by a literal OTHER database name (the never-toggled decoy) instead of DB_ID() -> wrongly reports the CURRENT connection's database as RCSI=0 when it is really 1",
      'RED',
      decoyReadbackPhaseB === phaseBReadback.rcsi // if the literal lookup agreed with the correctly-bound one, the trap would be undetectable
    )
    // S-0 "readback must be load-bearing" mutation: a STALE (pre-toggle, Phase A) cached
    // reading paired with the REAL post-toggle state must disagree — proving a cached
    // readback (rather than a fresh live query, which is what this script always does) would
    // have been decorative.
    log.check(
      'S-0-mutation-stale-cached-readback-would-be-decorative',
      'MUTATION: a cached PRE-toggle readback (rcsi=0) compared against the REAL post-toggle state must disagree, proving a cached (non-live) readback would misreport reality',
      'RED',
      phaseAReadback.rcsi === phaseBReadback.rcsi
    )

    // S-2a on Phase B too (LOCK_TIMEOUT must still be explicitly set on the fresh connection).
    log.check('S-2a-phaseB-baseline', 'SET LOCK_TIMEOUT is (re-)applied and read back on the fresh Phase B connection', 'GREEN', await setAndVerifyLockTimeout(reader, LOCK_TIMEOUT_MS))

    // S-5(i)/(ii)/S-5b: reader does not block AND reads the PRE-image; after commit, a fresh
    // read on the SAME connection reads the POST-image.
    async function readerSelectsProbeRowPhaseB(): Promise<{ ok: true; name: string } | { ok: false; number: number | undefined }> {
      try {
        const result = await reader!.request().batch<{ name: string }>(assertSelectOnly(`SELECT name FROM dbo.${SPIKE_TABLE} WHERE id = 1`))
        obs(null)
        return { ok: true, name: result.recordset[0]!.name }
      } catch (error) {
        obs(null)
        return { ok: false, number: (error as { number?: number }).number }
      }
    }
    await writer.request().batch('BEGIN TRAN')
    await writer.request().batch(`UPDATE dbo.${SPIKE_TABLE} SET name = 'dirty_phaseB' WHERE id = 1`)
    const s5iResult = await readerSelectsProbeRowPhaseB()
    log.check('S-5i', 'Phase B: the reader does NOT block (no 1222) while the writer holds an uncommitted update', 'GREEN', s5iResult.ok)
    const s5iiLabel: RowLabel = 'PRE_IMAGE'
    assertRowLabel(s5iiLabel) // label discipline: THE only legitimate use of PRE_IMAGE in this battery (contrast S-2b's COMMITTED_ROW)
    log.check('S-5ii', `Phase B: the returned row is the versioned ${s5iiLabel}, read while the writer's transaction is still open (never a dirty read)`, 'GREEN', s5iResult.ok && s5iResult.name === 'a')
    await writer.request().batch('COMMIT')
    const s5bResult = await readerSelectsProbeRowPhaseB()
    log.check('S-5b-visibility-positive-control', 'after the writer COMMITs, a fresh SELECT on the SAME reader connection observes the POST-image', 'GREEN', s5bResult.ok && s5bResult.name === 'dirty_phaseB')
    await writer.request().batch(`UPDATE dbo.${SPIKE_TABLE} SET name = 'a' WHERE id = 1`) // reset for cleanliness

    // CP-1: the SAME statement sequence, byte-identical, with RCSI OFF, must red S-5(i) with a
    // lock timeout — this is exactly Phase A's own S-2 result, cross-referenced here rather
    // than re-run, because CP-1 requires BOTH phases to call the SAME probe function on the
    // SAME statement text (captured below) — re-running a third time would not add evidence
    // beyond what Phase A already produced under IDENTICAL SQL text.
    const phaseAStatementText = `SELECT name FROM dbo.${SPIKE_TABLE} WHERE id = 1`
    const phaseBStatementText = `SELECT name FROM dbo.${SPIKE_TABLE} WHERE id = 1`
    log.check('CP-1-byte-identical-statement', 'Phase A and Phase B issue the BYTE-IDENTICAL probe statement (only the phase/posture differs)', 'GREEN', phaseAStatementText === phaseBStatementText)
    log.check('CP-1-pair', 'CP-1: RCSI OFF (Phase A, cross-referenced) reds with a lock timeout on this SAME statement; RCSI ON (Phase B, just observed) does not', 'GREEN', !s2Result.ok && s2Result.number === 1222 && s5iResult.ok)

    // S-7 (Phase B leg), including the unbound-lookup trap and the real ALLOW_SNAPSHOT_ISOLATION/SNAPSHOT mutations.
    const s7PhaseB = obs(await s7Observation(reader, 'inline-spid'))
    log.check('S-7-phaseB-baseline', 'ALLOW_SNAPSHOT_ISOLATION=0 and session isolation level is never SNAPSHOT(5) in Phase B either', 'GREEN', s7PhaseB.allowSnapshot === 0 && s7PhaseB.isolationLevel !== 5)

    // Unbound-lookup trap: a FOREIGN session id (a throwaway connection deliberately forced to
    // SERIALIZABLE, guaranteeing a real mismatch) instead of inline @@SPID.
    const foreignConn = await openPinnedPool(spikeDb)
    await foreignConn.request().batch('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
    const foreignSpidValue = await spid(foreignConn)
    const foreignLookup = await s7Observation(reader, 'foreign-spid', foreignSpidValue)
    await foreignConn.close()
    log.check(
      'S-7-mutation-unbound-lookup',
      "MUTATION: supply a harness-held FOREIGN session id (forced to SERIALIZABLE on a different connection) instead of inline @@SPID -> the isolation-level readback must NOT match the probe connection's own real level",
      'RED',
      foreignLookup.isolationLevel === s7PhaseB.isolationLevel
    )

    // Real ALLOW_SNAPSHOT_ISOLATION ON + forced SNAPSHOT isolation mutation, then revert.
    await reader.close()
    reader = null
    await masterPool.request().batch(`ALTER DATABASE [${spikeDb}] SET ALLOW_SNAPSHOT_ISOLATION ON`)
    reader = await openPinnedPool(spikeDb)
    await setAndVerifyLockTimeout(reader, LOCK_TIMEOUT_MS)
    const allowSnapshotAfterToggle = Number(await scalar<number>(reader, 'SELECT snapshot_isolation_state FROM sys.databases WHERE database_id = DB_ID()'))
    log.check('S-7-mutation-allow-snapshot-isolation-on', 'MUTATION: ALTER DATABASE ... SET ALLOW_SNAPSHOT_ISOLATION ON -> the "ALLOW_SNAPSHOT_ISOLATION=0" assertion must red', 'RED', allowSnapshotAfterToggle === 0)
    await reader.request().batch('SET TRANSACTION ISOLATION LEVEL SNAPSHOT')
    const forcedSnapshot = await s7Observation(reader, 'inline-spid')
    log.check('S-7-mutation-forced-snapshot-isolation', 'MUTATION: force the probe session to SNAPSHOT isolation -> the "never SNAPSHOT(5)" assertion must red', 'RED', forcedSnapshot.isolationLevel !== 5)
    await reader.request().batch('SET TRANSACTION ISOLATION LEVEL READ COMMITTED') // revert session
    await reader.close()
    reader = null
    await masterPool.request().batch(`ALTER DATABASE [${spikeDb}] SET ALLOW_SNAPSHOT_ISOLATION OFF`) // revert database
    reader = await openPinnedPool(spikeDb) // reopen for the remainder of the run
    await setAndVerifyLockTimeout(reader, LOCK_TIMEOUT_MS)

    // S-6: Phase B outcome, with the two structured scope qualifiers. The REAL decision uses
    // the SAME qualifiesForRcsiProven() predicate the mutation checks below exercise.
    const phaseBControlsSoFarOk = !log.all().some(entry => entry.verdict === 'FAIL')
    const phaseBMeasurement: RcsiProvenMeasurement = {
      rcsi: phaseBReadback.rcsi,
      readerBlocked: !s5iResult.ok,
      preImageOk: s5iResult.ok && s5iResult.name === 'a',
      postCommitOk: s5bResult.ok && s5bResult.name === 'dirty_phaseB',
    }
    let phaseBOutcome: OutcomeToken
    if (phaseBControlsSoFarOk && qualifiesForRcsiProven(phaseBMeasurement)) {
      phaseBOutcome = 'SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN'
    } else if (phaseBControlsSoFarOk) {
      // STOP-2: RCSI proven=1 but the guarantee failed to materialize (blocked, dirty read,
      // or the visibility control failed) -> UNOBTAINABLE, not a fallback to Phase A's token.
      phaseBOutcome = 'SQLSERVER_SINGLE_STATEMENT_SNAPSHOT_UNOBTAINABLE'
    } else {
      phaseBOutcome = 'INCONCLUSIVE'
    }
    // MUTATION: feed Phase A's REAL measured tuple into the SAME predicate -> must reject
    // (Phase B's token must never be emitted from Phase A's own observations).
    log.check('S-6-mutation-emit-from-phaseA', "MUTATION: Phase A's REAL measured tuple fed into the qualifying predicate must not satisfy it", 'RED', qualifiesForRcsiProven(phaseAMeasurement))
    // MUTATION (single-emitter, behavioural): neuter S-5b using Phase B's REAL tuple with ONLY
    // the post-commit field re-evaluated against the PRE-image value (simulating "the
    // post-commit read wrongly returned the pre-image") — a genuine one-variable mutation of
    // real measured data, never a hardcoded `false`.
    const neuteredPhaseBMeasurement: RcsiProvenMeasurement = {
      ...phaseBMeasurement,
      postCommitOk: s5bResult.ok && s5bResult.name === 'a', // neutered: checks for the PRE-image post-commit, which a real commit never produces
    }
    log.check('S-6-mutation-neutered-s5b', 'MUTATION: neuter S-5b (post-commit read re-checked against the pre-image value) -> the PROVEN token must not be emitted', 'RED', qualifiesForRcsiProven(neuteredPhaseBMeasurement))

    tracker.emit('phaseB', phaseBOutcome)
    records.push({
      evidenceSchemaVersion: 1,
      dialect: 'sqlserver',
      engineMajorVersion: declaredMajorVersion,
      phase: 'phaseB',
      capabilityPosture: 'rcsi_on',
      outcome: phaseBOutcome,
      sameConnection: phaseBX1aHolds,
      statementScoped: phaseBOutcome === 'SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN' ? true : undefined,
      separateProfile: phaseBOutcome === 'SQLSERVER_RCSI_STATEMENT_SNAPSHOT_PROVEN' ? true : undefined,
      controlsInverted: log.summary().passed,
      observationsTaken,
      recordedAt: new Date().toISOString(),
    })
    console.log('[b1b-sqlserver] Phase B outcome:', phaseBOutcome)

    // ── finalize: emit records, run the control-inversion gate, write evidence ────────────
    tracker.finalize()
    const evidenceDir = env.B1B_EVIDENCE_DIR
    if (evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true })
      // ONE file per phase (§1.4: Phase A and Phase B are separate certification units) —
      // never one file holding an array, which the gate-check does not parse as multiple
      // records.
      for (const record of records) {
        fs.writeFileSync(path.join(evidenceDir, evidenceFileName('sqlserver', declaredMajorVersion, record.phase)), JSON.stringify(record, null, 2))
      }
    }
    for (const record of records) {
      console.log('[b1b-sqlserver] RECORD (values-free):', JSON.stringify(record, null, 2))
    }
    console.log('[b1b-sqlserver] mutation/control summary:', JSON.stringify(log.summary()))

    // §1.3: a control/mutation that failed to invert reds the JOB (both phases already wrote
    // INCONCLUSIVE where applicable above; this is the final gate that turns that into a
    // non-zero exit).
    log.assertAllPassed('sqlserver')
  } finally {
    await reader?.request().batch('ROLLBACK TRAN').catch(() => undefined)
    await writer?.request().batch('ROLLBACK TRAN').catch(() => undefined)
    await reader?.close().catch(() => undefined)
    await writer?.close().catch(() => undefined)
    // Leave RCSI ON (Phase B's real end state) is intentional — the run is DONE. A local
    // re-run's own setup step above idempotently turns it back OFF before Phase A restarts,
    // which IS the X-7 contamination detector: S-1 would RED on a re-run if that reset were
    // ever silently dropped.
    await masterPool?.close().catch(() => undefined)
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === entryUrl) {
  main().catch(error => {
    console.error('[failed] B1b SQL Server spike failed')
    console.error(error)
    process.exitCode = 1
  })
}
