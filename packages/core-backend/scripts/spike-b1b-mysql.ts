// B1b capability spike — MySQL preconditions (M-1..M-5, X-1/X-2/X-3/X-6/X-7).
//
// EVIDENCE ONLY (docs/development/database-system-integration-line-design-and-verification-
// 20260724.md §4 step 2): establishes, EMPIRICALLY and on the SAME connection, whether this
// MySQL instance offers InnoDB + autocommit + isolation >= READ COMMITTED for the probe
// table. Mints NO certification, registers NO strategy, opens NOTHING (§4 step 3 stays behind
// the owner). There is no customer data anywhere in this job — the target is an EPHEMERAL CI
// (or locally-run, throwaway) MySQL service container, seeded from synthetic literals defined
// in this file, never a customer system (§4 step 2's own note; the values-free discipline
// below is carried forward for the shape a later, separately ops-gated real-system run must
// already have — see §6.3 of the acceptance battery).
//
// Job exit code vs verdict is DELIBERATELY DECOUPLED (§1.3): MYSQL_PRECONDITIONS_UNESTABLISHED
// is a fully-recorded, control-verified, SUCCESSFUL run — exit 0. Only an incomplete record or
// a control that failed to invert reds the job (exit non-zero).
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  DeclaredPhaseTracker,
  MutationLog,
  evidenceFileName,
  type OutcomeToken,
  type SpikeRecord,
} from './spike-b1b-shared'

const env = process.env

// ── mysql2/promise dynamic import (mirrors MySQLAdapter.ts's lazy require) ────────────────
interface MySqlQueryResult {
  // mysql2 returns [rows, fields] for query()/execute(); rows is an array of plain row objects
  // for SELECT, or an OkPacket-shaped object for DDL/DML. We only ever destructure `rows`.
}
interface MySqlConnection {
  query(sql: string, params?: unknown[]): Promise<[Record<string, unknown>[] | Record<string, unknown>, unknown]>
  end(): Promise<void>
}
interface MySqlModule {
  createConnection(config: Record<string, unknown>): Promise<MySqlConnection>
}
let mysql: MySqlModule | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  mysql = require('mysql2/promise') as MySqlModule
} catch {
  // reported below if actually needed
}

// ── Configuration ────────────────────────────────────────────────────────────────────────
// The database schema name for a version-dependent isolation-variable lookup is the ONLY
// per-major-version thing this script needs; MySQL 8.x renamed `tx_isolation` (5.x) to
// `transaction_isolation`. §4 step 2's M-3: "Version handling — fail closed, do not try
// both." Only versions this spike has actually declared+run appear here — an undeclared
// version fails closed (never a guess, never a try-both fallback).
const ISOLATION_VARIABLE_BY_DECLARED_MAJOR_VERSION: Readonly<Record<string, string>> = Object.freeze({
  '8.0': 'transaction_isolation',
})

const SPIKE_DATABASE = env.B1B_MYSQL_DATABASE || 'b1b_spike_mysql'
const INNODB_TABLE = 'b1b_probe'
const MYISAM_SIBLING_TABLE = 'b1b_probe_myisam_sibling'
const ISOLATION_ORDER = ['READ-UNCOMMITTED', 'READ-COMMITTED', 'REPEATABLE-READ', 'SERIALIZABLE'] as const

function requiredEnv(name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

// X-6a: all mutating setup refuses to run LOUDLY (throws, never skips) unless an explicit
// write opt-in is set. Precedent: packages/core-backend/scripts/smoke-sqlserver-seed.ts
// L43-49 (blob 4993a805c…). MUTATION: unset the opt-in -> setup FAILS; a silent skip is
// ALSO wrong (only reachable by manual inspection — see the PR body's pasted transcript of
// running this script with B1B_SEED_ALLOW_WRITE unset).
function assertWriteOptIn(): void {
  if (env.B1B_SEED_ALLOW_WRITE !== 'true') {
    throw new Error(
      'Refusing to seed: this script MUTATES the target MySQL server (CREATE DATABASE / DROP + ' +
        'CREATE + INSERT + session-level SET TRANSACTION / autocommit toggling on a WRITER connection). ' +
        'Set B1B_SEED_ALLOW_WRITE=true ONLY against a throwaway/CI/local instance — never a customer or ' +
        'production server.'
    )
  }
}

function printHelp(): void {
  console.log(`Usage: tsx scripts/spike-b1b-mysql.ts

Opt-in real-wire gate: with no B1B_MYSQL_HOST set it SKIPS (exit 0). EVIDENCE ONLY — mints no
certification, registers no strategy (§4 step 2 of the database-system-integration-line doc).

Required environment:
  B1B_MYSQL_HOST                    target host (opt-in trigger)
  B1B_MYSQL_USERNAME
  B1B_MYSQL_PASSWORD
  B1B_MYSQL_DECLARED_MAJOR_VERSION  e.g. "8.0" — must be a version this script has declared;
                                     an undeclared version fails closed (never a guess)
  B1B_SEED_ALLOW_WRITE=true         explicit write opt-in (X-6a) — refuses loudly without it

Optional environment:
  B1B_MYSQL_PORT           (default 3306)
  B1B_MYSQL_DATABASE       dedicated spike database name (default b1b_spike_mysql)
  B1B_EVIDENCE_DIR         where the values-free SpikeRecord JSON is written`)
}

// ── Reader/writer connection identity (X-1) ────────────────────────────────────────────────
async function connectionId(conn: MySqlConnection): Promise<number> {
  const [rows] = (await conn.query('SELECT CONNECTION_ID() AS id')) as [Array<{ id: number }>, unknown]
  return Number(rows[0]!.id)
}

// X-6c hygiene (NOT a security boundary — battery explicit: never cite this as the boundary):
// the reader's PROBE (observation) statements are SELECT-only — every function that reads
// data FROM the probed rows/metadata routes through readerQuery() below. This is narrower
// than "every statement the reader connection issues": the mutations for M-2/M-3 need
// SESSION-CONFIGURATION statements (SET SESSION autocommit=…, SET SESSION TRANSACTION
// ISOLATION LEVEL …) on the SAME connection, which are session config, not data probes, and
// are issued directly via reader.query() — never claimed as SELECT-only, and never routed
// through this guard. Overclaiming "every statement" here would be exactly the class of
// over-strong claim this line's own review discipline flags.
function assertSelectOnly(sql: string): string {
  const text = sql.trim()
  if (!/^SELECT\b/i.test(text)) {
    throw new Error(`spike-b1b-mysql internal: reader connection issued a non-SELECT statement: ${text.slice(0, 40)}…`)
  }
  return text
}
async function readerQuery(reader: MySqlConnection, sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  const [rows] = await reader.query(assertSelectOnly(sql), params)
  return rows as Record<string, unknown>[]
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    printHelp()
    return
  }
  if (!env.B1B_MYSQL_HOST) {
    console.log('[skip] B1b MySQL spike skipped — no B1B_MYSQL_HOST set (opt-in, CI/local-only). Exiting 0.')
    return
  }
  assertWriteOptIn()
  if (!mysql) {
    throw new Error('mysql2 package is not installed')
  }

  const declaredMajorVersion = requiredEnv('B1B_MYSQL_DECLARED_MAJOR_VERSION')
  const isolationVariable = ISOLATION_VARIABLE_BY_DECLARED_MAJOR_VERSION[declaredMajorVersion]
  if (!isolationVariable) {
    // FAIL CLOSED — never try both `tx_isolation` and `transaction_isolation` (battery M-3:
    // "A try-both-and-take-whichever-works fallback is forbidden: it succeeds against the
    // wrong variable and reports a green that means nothing").
    throw new Error(
      `spike-b1b-mysql: B1B_MYSQL_DECLARED_MAJOR_VERSION="${declaredMajorVersion}" is not a declared ` +
        `version (declared: ${Object.keys(ISOLATION_VARIABLE_BY_DECLARED_MAJOR_VERSION).join(', ')}). ` +
        'Refusing to guess the isolation-variable name.'
    )
  }

  const baseConfig = {
    host: env.B1B_MYSQL_HOST,
    port: env.B1B_MYSQL_PORT ? Number(env.B1B_MYSQL_PORT) : 3306,
    user: requiredEnv('B1B_MYSQL_USERNAME'),
    password: requiredEnv('B1B_MYSQL_PASSWORD'),
    connectTimeout: 10_000,
  }

  const tracker = new DeclaredPhaseTracker(['preconditions'])
  const log = new MutationLog()
  let reader: MySqlConnection | null = null
  let writer: MySqlConnection | null = null
  let setup: MySqlConnection | null = null

  try {
    // Dedicated database (P-4 analog): the spike NEVER touches an existing database. There is
    // no MySQL precedent (`smoke_db`) in this repo to collide with — this is the first MySQL
    // container — but the discipline is carried forward identically to the SQL Server spike.
    setup = await mysql.createConnection(baseConfig)
    await setup.query(`CREATE DATABASE IF NOT EXISTS \`${SPIKE_DATABASE}\``)
    await setup.end()
    setup = null

    reader = await mysql.createConnection({ ...baseConfig, database: SPIKE_DATABASE })
    writer = await mysql.createConnection({ ...baseConfig, database: SPIKE_DATABASE })

    // Setup: InnoDB probe table + MyISAM sibling (M-1c control pair), synthetic literals only.
    await writer.query(`DROP TABLE IF EXISTS \`${INNODB_TABLE}\``)
    await writer.query(`CREATE TABLE \`${INNODB_TABLE}\` (id INT NOT NULL PRIMARY KEY, name VARCHAR(50)) ENGINE=InnoDB`)
    await writer.query(`INSERT INTO \`${INNODB_TABLE}\` (id, name) VALUES (1,'a'), (2,'b'), (3,'c')`)
    await writer.query(`DROP TABLE IF EXISTS \`${MYISAM_SIBLING_TABLE}\``)
    await writer.query(`CREATE TABLE \`${MYISAM_SIBLING_TABLE}\` (id INT NOT NULL PRIMARY KEY, name VARCHAR(50)) ENGINE=MyISAM`)
    await writer.query(`INSERT INTO \`${MYISAM_SIBLING_TABLE}\` (id, name) VALUES (1,'a')`)
    console.log('[ok] seeded dedicated spike database', { database: SPIKE_DATABASE, innodbTable: INNODB_TABLE, myisamTable: MYISAM_SIBLING_TABLE })

    let observationsTaken = 0
    const countObservation = <T>(value: T): T => {
      observationsTaken += 1
      return value
    }

    // ── X-1: same connection, proven by the engine ─────────────────────────────────────────
    const readerIdFirst = countObservation(await connectionId(reader))
    const readerIdSecond = countObservation(await connectionId(reader))
    log.check('X-1a-baseline', 'two reader observations on the SAME pinned connection report the same session id', 'GREEN', readerIdFirst === readerIdSecond)

    const secondReaderConnection = await mysql.createConnection({ ...baseConfig, database: SPIKE_DATABASE })
    const readerIdOnSecondConnection = countObservation(await connectionId(secondReaderConnection))
    await secondReaderConnection.end()
    log.check(
      'X-1a-mutation-second-connection',
      'MUTATION: execute one reader observation on a SECOND pooled connection instead of the pinned one',
      'RED',
      readerIdFirst === readerIdOnSecondConnection
    )

    const writerId = countObservation(await connectionId(writer))
    log.check('X-1b-baseline', 'writer session identity differs from reader session identity', 'GREEN', readerIdFirst !== writerId)
    // MUTATION: source the "writer identity" observation from the READER's own connection
    // instead of the writer's (models a hardcoded/misdirected read with a REAL, live
    // requery on both sides — never comparing a literal to itself, which proves nothing).
    const misdirectedWriterId = countObservation(await connectionId(reader))
    log.check(
      'X-1b-mutation-misdirected-source',
      "MUTATION: read the writer-identity observation FROM THE READER'S OWN CONNECTION instead of the writer's -> the distinctness assertion must red (both sides now the same live session)",
      'RED',
      readerIdFirst !== misdirectedWriterId
    )

    // ── X-2: engine version identity matches the declared matrix cell ─────────────────────
    const [versionRows] = (await reader.query('SELECT VERSION() AS v')) as [Array<{ v: string }>, unknown]
    const observedVersion = countObservation(String(versionRows[0]!.v))
    console.log('[b1b-mysql] observed VERSION():', observedVersion, '| declared major version:', declaredMajorVersion)
    log.check('X-2-baseline', `observed VERSION() "${observedVersion}" matches the declared matrix cell "${declaredMajorVersion}"`, 'GREEN', observedVersion.startsWith(declaredMajorVersion))
    const decoyDeclaredVersion = '99.99'
    log.check(
      'X-2-mutation-wrong-declared-label',
      'MUTATION: leave the declared label mismatched against the real observed VERSION() (equivalent effect to pointing the job at the other matrix version while leaving the label unchanged)',
      'RED',
      observedVersion.startsWith(decoyDeclaredVersion)
    )

    // ── M-1: probe table storage engine is InnoDB (+ M-1c control pair) ────────────────────
    async function engineIsInnoDB(tableName: string): Promise<boolean> {
      const rows = await readerQuery(
        reader!,
        'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [tableName]
      )
      observationsTaken += 1
      return rows[0]?.ENGINE === 'InnoDB'
    }
    const m1Baseline = await engineIsInnoDB(INNODB_TABLE)
    log.check('M-1-baseline', 'the probe table (bound to the SAME identifier the probe statements use) reports ENGINE=InnoDB', 'GREEN', m1Baseline)
    log.check(
      'M-1-mutation-misbound-table',
      'MUTATION: bind the engine read to a different table name than the one actually probed',
      'RED',
      await engineIsInnoDB(MYISAM_SIBLING_TABLE)
    )
    log.check(
      'M-1c-control-pair-myisam-sibling',
      'CP-2 negative half: the IDENTICAL assertion against a MyISAM sibling table (same database, same connection) must red',
      'RED',
      await engineIsInnoDB(MYISAM_SIBLING_TABLE)
    )
    const m1 = m1Baseline

    // ── M-2: session autocommit is ON (+ scope-trap mutation + M-2c control pair) ──────────
    async function autocommitOn(scope: 'SESSION' | 'GLOBAL'): Promise<boolean> {
      const rows = await readerQuery(reader!, `SELECT @@${scope}.autocommit AS ac`)
      observationsTaken += 1
      return Number(rows[0]!.ac) === 1
    }
    const m2Baseline = await autocommitOn('SESSION')
    log.check('M-2-baseline', '@@SESSION.autocommit is ON by default', 'GREEN', m2Baseline)

    await reader.query('SET SESSION autocommit = 0')
    log.check(
      'M-2-mutation-session-off',
      'MUTATION (real server state): SET SESSION autocommit = 0 on the reader -> the SESSION-scoped assertion must red',
      'RED',
      await autocommitOn('SESSION')
    )
    log.check(
      'M-2-scope-trap-global-stays-green',
      'MUTATION (scope trap): reading @@GLOBAL.autocommit instead, with SESSION forced to 0, must WRONGLY stay green -- demonstrates why @@GLOBAL is the wrong scope and is never the shipped read',
      'GREEN',
      await autocommitOn('GLOBAL')
    )
    await reader.query('SET SESSION autocommit = 1')
    log.check('M-2c-control-pair-restore-green', 'restoring SESSION autocommit to 1 makes the SESSION-scoped assertion green again (same connection)', 'GREEN', await autocommitOn('SESSION'))
    const m2 = m2Baseline

    // ── M-3: session isolation >= READ COMMITTED (ordered-index compare, closed vocabulary) ─
    async function isolationAtLeastReadCommitted(compare: 'ordered' | 'lexicographic-DEMO-ONLY'): Promise<boolean> {
      const rows = await readerQuery(reader!, `SELECT @@SESSION.${isolationVariable} AS iso`)
      observationsTaken += 1
      const raw = String(rows[0]!.iso)
      // Diagnostic only (not part of the values-free evidence record — see §6): if this
      // engine returns a format ISOLATION_ORDER does not recognise (e.g. a space instead of a
      // hyphen), the closed-rejection branch below returns false rather than crashing, so this
      // log line is what makes a CI run diagnosable in one cycle instead of a silent
      // MYSQL_PRECONDITIONS_UNESTABLISHED with no clue why.
      console.log(`[b1b-mysql] raw @@SESSION.${isolationVariable} = ${JSON.stringify(raw)} (compare=${compare})`)
      if (compare === 'lexicographic-DEMO-ONLY') {
        // NEVER shipped — exists ONLY to demonstrate the trap named in the battery: a naive
        // string >= comparison wrongly accepts READ UNCOMMITTED because 'U' > 'C'.
        return raw >= 'READ-COMMITTED'
      }
      const index = ISOLATION_ORDER.indexOf(raw as (typeof ISOLATION_ORDER)[number])
      if (index === -1) return false // closed rejection — membership outside the vocabulary is never a default
      return index >= ISOLATION_ORDER.indexOf('READ-COMMITTED')
    }
    const m3Baseline = await isolationAtLeastReadCommitted('ordered')
    log.check('M-3-baseline', `default session isolation (MySQL default REPEATABLE-READ) is >= READ COMMITTED via ${isolationVariable}`, 'GREEN', m3Baseline)

    await reader.query('SET SESSION TRANSACTION ISOLATION LEVEL READ UNCOMMITTED')
    log.check(
      'M-3-mutation-discriminating-read-uncommitted',
      'MUTATION (the discriminating one): SET SESSION TRANSACTION ISOLATION LEVEL READ UNCOMMITTED -> the ordered-index assertion must red',
      'RED',
      await isolationAtLeastReadCommitted('ordered')
    )
    log.check(
      'M-3-lexicographic-trap-demo',
      "DEMONSTRATION (never shipped): a naive lexicographic '>=' comparison WRONGLY accepts READ UNCOMMITTED ('U' > 'C') -- this is why the ordered-index comparison is mandatory",
      'GREEN',
      await isolationAtLeastReadCommitted('lexicographic-DEMO-ONLY')
    )

    await reader.query('SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE')
    log.check(
      'M-3-mutation-over-strictness-serializable',
      'MUTATION (over-strictness positive case): SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE must STAY green (>=, not ==, READ COMMITTED)',
      'GREEN',
      await isolationAtLeastReadCommitted('ordered')
    )

    await reader.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ') // restore MySQL default
    log.check('M-3c-control-pair-restore-green', 'restoring the default (>= RC) posture makes the assertion green again (same connection)', 'GREEN', await isolationAtLeastReadCommitted('ordered'))
    const m3 = m3Baseline

    // ── M-4 ⚠ BATTERY-ADDED (dirty-read refutation) — implemented, mutation-tested, but kept
    // NON-load-bearing for MYSQL_PRECONDITIONS_PROVEN because the battery's own §4.2 formula is
    // "(∧ M-4 if ratified)" and §10(ii) records it as awaiting owner ratification. Runs against
    // the SAME reader connection (X-1) with a DISTINCT writer connection (X-1b).
    async function readProbeName(): Promise<string> {
      const rows = await readerQuery(reader!, `SELECT name FROM \`${INNODB_TABLE}\` WHERE id = 1`)
      observationsTaken += 1
      return String(rows[0]!.name)
    }
    async function m4Sequence(writerUpdateIsNoOp: boolean): Promise<void> {
      await writer!.query('START TRANSACTION')
      if (writerUpdateIsNoOp) {
        await writer!.query(`UPDATE \`${INNODB_TABLE}\` SET name = name WHERE id = 999`) // matches zero rows
      } else {
        await writer!.query(`UPDATE \`${INNODB_TABLE}\` SET name = 'dirty_uncommitted' WHERE id = 1`)
      }

      await reader!.query('SET SESSION TRANSACTION ISOLATION LEVEL READ UNCOMMITTED')
      const positive = await readProbeName()
      const positiveHolds = positive === 'dirty_uncommitted'
      log.check(
        writerUpdateIsNoOp ? 'M-4-mutation-writer-noop-positive-must-red' : 'CP-5 positive: READ UNCOMMITTED sees the POST-image (dirty read) while W is uncommitted',
        writerUpdateIsNoOp
          ? "MUTATION: W's UPDATE is a no-op (matches zero rows) -> the positive control must red (nothing to see)"
          : 'reader at READ UNCOMMITTED observes the uncommitted write',
        writerUpdateIsNoOp ? 'RED' : 'GREEN',
        positiveHolds
      )

      await reader!.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      const negative = await readProbeName()
      log.check(
        'CP-5 negative: declared isolation (>= READ COMMITTED) sees the PRE-image',
        'reader restored to the declared isolation observes the committed pre-image, not the uncommitted write',
        'GREEN',
        negative === 'a'
      )

      await writer!.query('COMMIT')
      const visibility = await readProbeName()
      log.check(
        'CP-5 visibility: after commit, a FRESH read on the SAME reader connection observes the POST-image',
        'without this, "reader saw the old value" is also produced by a reader that is blind to all change',
        'GREEN',
        writerUpdateIsNoOp ? visibility === 'a' : visibility === 'dirty_uncommitted'
      )

      // Reset for the next sub-run / for cleanliness.
      await writer!.query(`UPDATE \`${INNODB_TABLE}\` SET name = 'a' WHERE id = 1`)
    }
    await m4Sequence(false)
    await m4Sequence(true)
    await reader.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')

    // ── M-5: aggregate outcome ──────────────────────────────────────────────────────────────
    let outcome: OutcomeToken
    try {
      log.assertAllPassed('mysql-preconditions')
      // M-4 is battery-added / unratified (§10(ii)) -> excluded from the formula on purpose.
      outcome = m1 && m2 && m3 ? 'MYSQL_PRECONDITIONS_PROVEN' : 'MYSQL_PRECONDITIONS_UNESTABLISHED'
    } catch (controlFailure) {
      // A control that failed to invert is INCONCLUSIVE, never UNESTABLISHED (STOP-4).
      tracker.emit('preconditions', 'INCONCLUSIVE')
      console.error('[b1b-mysql] a mutation/control failed to invert:', (controlFailure as Error).message)
      throw controlFailure
    }
    tracker.emit('preconditions', outcome)

    const summary = log.summary()
    const record: SpikeRecord = {
      evidenceSchemaVersion: 1,
      dialect: 'mysql',
      engineMajorVersion: declaredMajorVersion,
      phase: 'preconditions',
      capabilityPosture: 'default',
      outcome,
      sameConnection: readerIdFirst === readerIdSecond,
      controlsInverted: summary.passed,
      observationsTaken,
      recordedAt: new Date().toISOString(),
    }
    const evidenceDir = env.B1B_EVIDENCE_DIR
    if (evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true })
      fs.writeFileSync(path.join(evidenceDir, evidenceFileName('mysql', declaredMajorVersion, 'preconditions')), JSON.stringify(record, null, 2))
    }
    console.log('[b1b-mysql] RECORD (values-free):', JSON.stringify(record, null, 2))
    console.log('[b1b-mysql] mutation/control summary:', JSON.stringify(summary))
  } finally {
    // X-7 teardown: MySQL's mutations here are all SESSION-scoped (autocommit, isolation
    // level) — closing the connections resets every one of them; there is no MySQL analog of
    // SQL Server's database-scoped RCSI toggle for this spike to leave dirty across runs.
    try {
      await writer?.query('ROLLBACK').catch(() => undefined)
    } catch {
      /* no open transaction to roll back — fine */
    }
    await reader?.end().catch(() => undefined)
    await writer?.end().catch(() => undefined)
    await setup?.end().catch(() => undefined)
    tracker.finalize() // X-3 MUTATION C: a phase that crashed before emit() reds HERE with "missing phase"
  }
}

const entryUrl = process.argv[1] ? new URL(`file://${path.resolve(process.argv[1])}`).href : ''
if (import.meta.url === entryUrl) {
  main().catch(error => {
    console.error('[failed] B1b MySQL spike failed')
    console.error(error)
    process.exitCode = 1
  })
}
