import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import * as writerBlockMigration from '../../src/db/migrations/zzzz20260826123000_add_archive_writer_block_ownership'
import {
  __resetRecoveryWriterStateColumnProbe,
  fenceWriterEntry,
  setRecoveryWriterState,
  type FenceQuery,
} from '../../src/multitable/canonical-sheet-fence'
import {
  ARCHIVE_WRITER_BLOCK_CLEAN_CLAIM_SQL,
  ARCHIVE_WRITER_BLOCK_EXPECTED_CONSTRAINTS,
  ARCHIVE_WRITER_BLOCK_PREPARED_STATE_SQL,
  ARCHIVE_WRITER_BLOCK_SCHEMA_FINGERPRINT,
  ARCHIVE_WRITER_BLOCK_TRANSACTION_PRELUDE_SQL,
  ArchiveWriterBlockError,
  checkArchiveWriterBlockOwnerExact,
  claimArchiveWriterBlock,
  claimArchiveWriterBlockPrepared,
  heartbeatArchiveWriterBlock,
  prepareArchiveWriterBlockTransaction,
  readArchiveWriterBlockSchemaFingerprint,
  releaseArchiveWriterBlock,
  type ArchiveWriterBlockSnapshot,
  type ArchiveWriterBlockTransactionRunner,
} from '../../src/multitable/recovery-archive-writer-block'
import {
  attachOwnedPoolTerminationHandler,
  dropScratchDatabase,
  formatScratchDropOutcome,
  type OwnedPoolTerminationHandler,
} from '../helpers/scratch-database'

const runRealDb = Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeIfRealDbStep = runRealDb ? describe : describe.skip

test('sentinel: D2e writer-block real-DB step requires DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('recovery_archive_writer_block_realdb_harness_missing_database_url')
  }
})

const FLAG = 'MULTITABLE_ENABLE_WRITER_FENCE'
const ARCHIVE_FLAG = 'MULTITABLE_RECOVERY_ARCHIVE_ENABLED'
const RUN = randomUUID().replaceAll('-', '').slice(0, 12)
const SHEET = `tm_d2e_sheet_${RUN}`
const OWNER = `tm_d2e_owner_${RUN}`
const OTHER = `tm_d2e_other_${RUN}`
const FUTURE = '2099-01-01T00:00:00.000Z'
const FUTURE_2 = '2099-06-01T00:00:00.000Z'
const EXPIRED = '2000-01-01T00:00:00.000Z'

type Scratch = {
  name: string
  pool: Pool
  db: Kysely<unknown>
  terminationHandler: OwnedPoolTerminationHandler
}
type DatabaseError = Error & { code?: string; detail?: string; where?: string; hint?: string }

let adminPool: Pool
let runtime: Scratch
let lifecycle: Scratch
const scratches: Scratch[] = []

function databaseUrlFor(name: string): string {
  const url = new URL(String(process.env.DATABASE_URL))
  url.pathname = `/${name}`
  return url.toString()
}

async function createScratch(label: string): Promise<Scratch> {
  const name = `tm_d2e_${RUN}_${label}`
  await adminPool.query(`CREATE DATABASE "${name}"`)
  const pool = new Pool({ connectionString: databaseUrlFor(name), max: 6 })
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  const scratch = { name, pool, db, terminationHandler: attachOwnedPoolTerminationHandler(pool) }
  scratches.push(scratch)
  await pool.query(`
    CREATE TABLE public.meta_sheets (
      id text PRIMARY KEY,
      recovery_writer_state text,
      CONSTRAINT chk_meta_sheets_recovery_writer_state
        CHECK (
          recovery_writer_state IS NULL
          OR recovery_writer_state IN ('fencing', 'applying', 'paused_retryable')
        )
    )
  `)
  await writerBlockMigration.up(db)
  return scratch
}

async function dropScratch(scratch: Scratch): Promise<void> {
  try {
    await scratch.db.destroy().catch(() => {})
    const outcome = await dropScratchDatabase(adminPool, scratch.name)
    console.log(formatScratchDropOutcome('recovery-archive-writer-block', outcome))
  } finally {
    scratch.terminationHandler.detach()
  }
}

function asQuery(client: PoolClient): FenceQuery {
  return (sql, params) => client.query(sql, params)
}

function loggingQuery(client: PoolClient, sql: string[]): FenceQuery {
  return async (text, params) => {
    sql.push(text)
    return client.query(text, params)
  }
}

function transactionRunner(pool: Pool, afterWork?: () => never): ArchiveWriterBlockTransactionRunner {
  return async <T>(work: (query: FenceQuery) => Promise<T>): Promise<T> => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const result = await work(asQuery(client))
      afterWork?.()
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }
}

async function readSnapshot(): Promise<ArchiveWriterBlockSnapshot | null> {
  const result = await runtime.pool.query(
    `SELECT recovery_writer_state AS state,
            recovery_writer_owner_kind AS owner_kind,
            recovery_writer_owner_id AS owner_id,
            recovery_writer_owner_fence::text AS fence,
            recovery_writer_lease_until::text AS lease_until,
            recovery_writer_updated_at::text AS updated_at
       FROM public.meta_sheets WHERE id = $1`,
    [SHEET],
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row || row.state !== 'archiving') return null
  return {
    state: 'archiving',
    ownerKind: row.owner_kind as 'archive_generation' | 'restore_job',
    ownerId: String(row.owner_id),
    fence: String(row.fence),
    leaseUntil: String(row.lease_until),
    updatedAt: String(row.updated_at),
  }
}

async function clearRow(): Promise<void> {
  await runtime.pool.query(
    `UPDATE public.meta_sheets
        SET recovery_writer_state = NULL,
            recovery_writer_owner_kind = NULL,
            recovery_writer_owner_id = NULL,
            recovery_writer_owner_fence = NULL,
            recovery_writer_lease_until = NULL,
            recovery_writer_updated_at = NULL
      WHERE id = $1`,
    [SHEET],
  )
}

async function errorOf(promise: Promise<unknown>): Promise<DatabaseError> {
  try {
    await promise
  } catch (error) {
    return error as DatabaseError
  }
  throw new Error('expected_rejection')
}

function expectValuesFree(error: DatabaseError): void {
  const text = [error.message, error.detail, error.where, error.hint].filter(Boolean).join(' ')
  for (const value of [SHEET, OWNER, OTHER, 'archiving']) expect(text).not.toContain(value)
}

describeIfRealDbStep('D2e durable archive writer-block substrate (real DB)', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
    runtime = await createScratch('runtime')
    lifecycle = await createScratch('lifecycle')
    await runtime.pool.query('INSERT INTO public.meta_sheets (id) VALUES ($1)', [SHEET])
  })

  beforeEach(() => {
    process.env[ARCHIVE_FLAG] = 'true'
    process.env[FLAG] = 'true'
    __resetRecoveryWriterStateColumnProbe()
  })

  afterEach(async () => {
    delete process.env[ARCHIVE_FLAG]
    delete process.env[FLAG]
    await clearRow().catch(() => {})
  })

  afterAll(async () => {
    delete process.env[ARCHIVE_FLAG]
    delete process.env[FLAG]
    for (const scratch of [...scratches].reverse()) await dropScratch(scratch)
    await adminPool?.end().catch(() => {})
  })

  test('migration down/up replays only while the ownership surface is empty', async () => {
    await expect(writerBlockMigration.down(lifecycle.db)).resolves.toBeUndefined()
    await expect(writerBlockMigration.up(lifecycle.db)).resolves.toBeUndefined()
    await lifecycle.pool.query(
      `INSERT INTO public.meta_sheets (
         id, recovery_writer_owner_fence
       ) VALUES ('nonempty', 9007199254740993::bigint)`,
    )
    const error = await errorOf(writerBlockMigration.down(lifecycle.db))
    expect(error.code).toBe('55000')
    expect(error.message).toBe('archive_writer_block_down_nonempty')
  })

  test('clean claim, exact owner check, heartbeat and release retain a monotonic bigint fence', async () => {
    await runtime.pool.query(
      'UPDATE public.meta_sheets SET recovery_writer_owner_fence = 9007199254740992::bigint WHERE id = $1',
      [SHEET],
    )
    const claimed = await claimArchiveWriterBlock(transactionRunner(runtime.pool), SHEET, {
      ownerKind: 'archive_generation',
      ownerId: OWNER,
      leaseUntil: FUTURE,
    })
    expect(claimed.fence).toBe('9007199254740993')
    await expect(
      checkArchiveWriterBlockOwnerExact(runtime.pool.query.bind(runtime.pool), SHEET, claimed),
    ).resolves.toMatchObject({ ownerId: OWNER, fence: '9007199254740993' })
    const heartbeated = await heartbeatArchiveWriterBlock(
      transactionRunner(runtime.pool),
      SHEET,
      claimed,
      FUTURE_2,
    )
    expect(heartbeated.fence).toBe(claimed.fence)
    await expect(
      heartbeatArchiveWriterBlock(transactionRunner(runtime.pool), SHEET, claimed, FUTURE),
    ).rejects.toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_OWNERSHIP_LOST' })
    await expect(
      releaseArchiveWriterBlock(transactionRunner(runtime.pool), SHEET, claimed),
    ).rejects.toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_OWNERSHIP_LOST' })
    await releaseArchiveWriterBlock(transactionRunner(runtime.pool), SHEET, heartbeated)
    const idle = await runtime.pool.query(
      `SELECT recovery_writer_state,
              recovery_writer_owner_id,
              recovery_writer_owner_fence::text AS fence
         FROM public.meta_sheets WHERE id = $1`,
      [SHEET],
    )
    expect(idle.rows[0]).toEqual({
      recovery_writer_state: null,
      recovery_writer_owner_id: null,
      fence: '9007199254740993',
    })
  })

  test('expired takeover CASes the complete previous tuple; stale ABA heartbeat/release write zero', async () => {
    let first = await claimArchiveWriterBlock(transactionRunner(runtime.pool), SHEET, {
      ownerKind: 'archive_generation',
      ownerId: OWNER,
      leaseUntil: FUTURE,
    })
    await runtime.pool.query(
      `UPDATE public.meta_sheets
          SET recovery_writer_lease_until = $2::timestamptz,
              recovery_writer_updated_at = clock_timestamp()
        WHERE id = $1`,
      [SHEET, EXPIRED],
    )
    first = (await readSnapshot()) as ArchiveWriterBlockSnapshot
    await runtime.pool.query(
      `UPDATE public.meta_sheets
          SET recovery_writer_updated_at = recovery_writer_updated_at + interval '1 microsecond'
        WHERE id = $1`,
      [SHEET],
    )
    await expect(
      claimArchiveWriterBlock(transactionRunner(runtime.pool), SHEET, {
        ownerKind: 'restore_job',
        ownerId: OTHER,
        leaseUntil: FUTURE,
        previous: first,
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_CLAIM_CONFLICT' })
    const exactPrevious = (await readSnapshot()) as ArchiveWriterBlockSnapshot
    const second = await claimArchiveWriterBlock(transactionRunner(runtime.pool), SHEET, {
      ownerKind: 'restore_job',
      ownerId: OTHER,
      leaseUntil: FUTURE,
      previous: exactPrevious,
    })
    expect(BigInt(second.fence)).toBe(BigInt(exactPrevious.fence) + 1n)
    await expect(
      heartbeatArchiveWriterBlock(transactionRunner(runtime.pool), SHEET, first, FUTURE_2),
    ).rejects.toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_OWNERSHIP_LOST' })
    await expect(
      releaseArchiveWriterBlock(transactionRunner(runtime.pool), SHEET, first),
    ).rejects.toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_OWNERSHIP_LOST' })
    expect((await readSnapshot())?.ownerId).toBe(OTHER)
  })

  test('unexpired or inexact takeover refuses and transaction rollback leaves zero ownership', async () => {
    const current = await claimArchiveWriterBlock(transactionRunner(runtime.pool), SHEET, {
      ownerKind: 'archive_generation',
      ownerId: OWNER,
      leaseUntil: FUTURE,
    })
    await expect(
      claimArchiveWriterBlock(transactionRunner(runtime.pool), SHEET, {
        ownerKind: 'restore_job',
        ownerId: OTHER,
        leaseUntil: FUTURE_2,
        previous: current,
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_CLAIM_CONFLICT' })
    await clearRow()
    const rollbackRunner = transactionRunner(runtime.pool, () => {
      throw new Error('rollback_probe')
    })
    await expect(
      claimArchiveWriterBlock(rollbackRunner, SHEET, {
        ownerKind: 'archive_generation',
        ownerId: OWNER,
        leaseUntil: FUTURE,
      }),
    ).rejects.toThrow('rollback_probe')
    expect(await readSnapshot()).toBeNull()
  })

  test('ordinary writer observes archiving and state-only setter cannot manufacture it', async () => {
    await claimArchiveWriterBlock(transactionRunner(runtime.pool), SHEET, {
      ownerKind: 'archive_generation',
      ownerId: OWNER,
      leaseUntil: FUTURE,
    })
    const writer = await errorOf(
      transactionRunner(runtime.pool)(async (query) => fenceWriterEntry(query, SHEET)),
    )
    expect(writer).toMatchObject({ code: 'SHEET_WRITER_BLOCKED' })
    expectValuesFree(writer)
    await expect(
      setRecoveryWriterState(
        runtime.pool.query.bind(runtime.pool),
        SHEET,
        'archiving' as never,
      ),
    ).rejects.toThrow('RECOVERY_WRITER_STATE_INVALID')
  })

  test('flag off and non-exact spellings produce zero transaction entry and zero durable writes', async () => {
    process.env[ARCHIVE_FLAG] = 'true'
    for (const value of [undefined, 'TRUE', ' true ', 'false']) {
      if (value === undefined) delete process.env[FLAG]
      else process.env[FLAG] = value
      let entered = false
      const runner: ArchiveWriterBlockTransactionRunner = async () => {
        entered = true
        throw new Error('must_not_enter')
      }
      const error = await errorOf(
        claimArchiveWriterBlock(runner, SHEET, {
          ownerKind: 'archive_generation',
          ownerId: OWNER,
          leaseUntil: FUTURE,
        }),
      )
      expect(error).toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_DISABLED' })
      expect(entered).toBe(false)
      expect(await readSnapshot()).toBeNull()
    }

    process.env[FLAG] = 'true'
    for (const value of [undefined, 'TRUE', ' true ', 'false']) {
      if (value === undefined) delete process.env[ARCHIVE_FLAG]
      else process.env[ARCHIVE_FLAG] = value
      let entered = false
      const runner: ArchiveWriterBlockTransactionRunner = async () => {
        entered = true
        throw new Error('must_not_enter')
      }
      const error = await errorOf(
        claimArchiveWriterBlock(runner, SHEET, {
          ownerKind: 'archive_generation',
          ownerId: OWNER,
          leaseUntil: FUTURE,
        }),
      )
      expect(error).toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_DISABLED' })
      expect(entered).toBe(false)
      expect(await readSnapshot()).toBeNull()
    }
  })

  test('schema fingerprint ignores an unrelated same-prefix constraint but refuses missing/wrong owned names', async () => {
    const liveConstraints = await runtime.pool.query(
      `SELECT constraint_row.conname AS constraint_name,
              constraint_row.contype::text AS contype,
              constraint_row.convalidated AS convalidated,
              pg_catalog.pg_get_constraintdef(constraint_row.oid, true) AS definition
         FROM pg_catalog.pg_constraint constraint_row
         JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'meta_sheets'
          AND constraint_row.conname = ANY($1::text[])
        ORDER BY constraint_row.conname`,
      [ARCHIVE_WRITER_BLOCK_EXPECTED_CONSTRAINTS.map((row) => row.constraint_name)],
    )
    expect(liveConstraints.rows).toEqual(
      ARCHIVE_WRITER_BLOCK_EXPECTED_CONSTRAINTS.map((row) => ({ ...row })),
    )
    expect(await readArchiveWriterBlockSchemaFingerprint(runtime.pool.query.bind(runtime.pool))).toBe(
      ARCHIVE_WRITER_BLOCK_SCHEMA_FINGERPRINT,
    )
    await runtime.pool.query(
      'ALTER TABLE public.meta_sheets ADD CONSTRAINT chk_meta_sheets_recovery_writer_foreign CHECK (true)',
    )
    try {
      expect(await readArchiveWriterBlockSchemaFingerprint(runtime.pool.query.bind(runtime.pool))).toBe(
        ARCHIVE_WRITER_BLOCK_SCHEMA_FINGERPRINT,
      )
      const claimed = await claimArchiveWriterBlock(transactionRunner(runtime.pool), SHEET, {
        ownerKind: 'archive_generation',
        ownerId: OWNER,
        leaseUntil: FUTURE,
      })
      await releaseArchiveWriterBlock(transactionRunner(runtime.pool), SHEET, claimed)
    } finally {
      await runtime.pool.query(
        'ALTER TABLE public.meta_sheets DROP CONSTRAINT chk_meta_sheets_recovery_writer_foreign',
      )
      await clearRow()
    }

    await runtime.pool.query(
      'ALTER TABLE public.meta_sheets RENAME CONSTRAINT chk_meta_sheets_recovery_writer_owner_kind TO chk_meta_sheets_recovery_writer_owner_kind_drift',
    )
    try {
      const error = await errorOf(
        claimArchiveWriterBlock(transactionRunner(runtime.pool), SHEET, {
          ownerKind: 'archive_generation',
          ownerId: OWNER,
          leaseUntil: FUTURE,
        }),
      )
      expect(error).toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_SCHEMA_DRIFT' })
      expectValuesFree(error)
      expect(await readSnapshot()).toBeNull()
    } finally {
      await runtime.pool.query(
        'ALTER TABLE public.meta_sheets RENAME CONSTRAINT chk_meta_sheets_recovery_writer_owner_kind_drift TO chk_meta_sheets_recovery_writer_owner_kind',
      )
    }

    await runtime.pool.query(
      'ALTER TABLE public.meta_sheets DROP CONSTRAINT chk_meta_sheets_recovery_writer_fence',
    )
    await runtime.pool.query(
      'ALTER TABLE public.meta_sheets ADD CONSTRAINT chk_meta_sheets_recovery_writer_fence CHECK (recovery_writer_owner_fence IS NULL OR recovery_writer_owner_fence >= 0)',
    )
    try {
      await expect(
        claimArchiveWriterBlock(transactionRunner(runtime.pool), SHEET, {
          ownerKind: 'archive_generation',
          ownerId: OWNER,
          leaseUntil: FUTURE,
        }),
      ).rejects.toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_SCHEMA_DRIFT' })
    } finally {
      await runtime.pool.query(
        'ALTER TABLE public.meta_sheets DROP CONSTRAINT chk_meta_sheets_recovery_writer_fence',
      )
      await runtime.pool.query(
        'ALTER TABLE public.meta_sheets ADD CONSTRAINT chk_meta_sheets_recovery_writer_fence CHECK (recovery_writer_owner_fence IS NULL OR recovery_writer_owner_fence >= 1)',
      )
    }
  })

  test('wrong isolation and autocommit runners fail closed before ownership', async () => {
    const repeatableRunner: ArchiveWriterBlockTransactionRunner = async (work) => {
      const client = await runtime.pool.connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
        return await work(asQuery(client))
      } finally {
        await client.query('ROLLBACK').catch(() => {})
        client.release()
      }
    }
    await expect(
      claimArchiveWriterBlock(repeatableRunner, SHEET, {
        ownerKind: 'archive_generation',
        ownerId: OWNER,
        leaseUntil: FUTURE,
      }),
    ).rejects.toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_ISOLATION_INVALID' })
    const autocommit: ArchiveWriterBlockTransactionRunner = (work) =>
      work(runtime.pool.query.bind(runtime.pool))
    await expect(
      claimArchiveWriterBlock(autocommit, SHEET, {
        ownerKind: 'archive_generation',
        ownerId: OWNER,
        leaseUntil: FUTURE,
      }),
    ).rejects.toBeInstanceOf(ArchiveWriterBlockError)
    expect(await readSnapshot()).toBeNull()
  })

  test('prepared claim stays in one outer transaction: prelude first, caller gap, no second prelude, commit persists', async () => {
    const client = await runtime.pool.connect()
    const sql: string[] = []
    let beginCount = 0
    try {
      const query = loggingQuery(client, sql)
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      beginCount += 1
      const prepared = await prepareArchiveWriterBlockTransaction(query, SHEET)
      const gap = await query('SELECT pg_current_xact_id()::text AS caller_gap_xid')
      expect(Object.isFrozen(prepared)).toBe(true)
      expect(prepared.query).toBe(query)
      expect(prepared.sheetId).toBe(SHEET)
      expect(prepared.xid).toBe((gap.rows[0] as { caller_gap_xid: string }).caller_gap_xid)
      expect(sql[0]).toBe(ARCHIVE_WRITER_BLOCK_TRANSACTION_PRELUDE_SQL)
      const claimed = await claimArchiveWriterBlockPrepared(prepared, {
        ownerKind: 'archive_generation',
        ownerId: OWNER,
        leaseUntil: FUTURE,
      })
      expect(beginCount).toBe(1)
      expect(sql.some((text) => /^\s*BEGIN\b/i.test(text))).toBe(false)
      expect(sql.filter((text) => text === ARCHIVE_WRITER_BLOCK_TRANSACTION_PRELUDE_SQL)).toHaveLength(1)
      const gapIndex = sql.indexOf('SELECT pg_current_xact_id()::text AS caller_gap_xid')
      expect(gapIndex).toBeGreaterThan(0)
      expect(sql[gapIndex + 1]).toBe(ARCHIVE_WRITER_BLOCK_PREPARED_STATE_SQL)
      expect(sql.slice(gapIndex).includes(ARCHIVE_WRITER_BLOCK_TRANSACTION_PRELUDE_SQL)).toBe(false)
      expect(sql.at(-1)).toBe(ARCHIVE_WRITER_BLOCK_CLEAN_CLAIM_SQL)
      expect(claimed.ownerId).toBe(OWNER)
      expect(await readSnapshot()).toBeNull()
      await client.query('COMMIT')
      expect((await readSnapshot())?.ownerId).toBe(OWNER)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  test('prepared claim rollback leaves no writer block', async () => {
    const client = await runtime.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const query = asQuery(client)
      const prepared = await prepareArchiveWriterBlockTransaction(query, SHEET)
      await query('SELECT 1 AS caller_gap')
      const claimed = await claimArchiveWriterBlockPrepared(prepared, {
        ownerKind: 'archive_generation',
        ownerId: OWNER,
        leaseUntil: FUTURE,
      })
      const inside = await client.query(
        `SELECT recovery_writer_state AS state, recovery_writer_owner_id AS owner_id
           FROM public.meta_sheets WHERE id = $1`,
        [SHEET],
      )
      expect(inside.rows[0]).toEqual({ state: 'archiving', owner_id: OWNER })
      expect(claimed.ownerId).toBe(OWNER)
      expect(await readSnapshot()).toBeNull()
      await client.query('ROLLBACK')
      expect(await readSnapshot()).toBeNull()
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  test('rolling back the preparation savepoint invalidates the token with zero writes', async () => {
    const client = await runtime.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      await client.query('SAVEPOINT before_prepare')
      const prepared = await prepareArchiveWriterBlockTransaction(asQuery(client), SHEET)
      await client.query('ROLLBACK TO SAVEPOINT before_prepare')
      const error = await errorOf(
        claimArchiveWriterBlockPrepared(prepared, {
          ownerKind: 'archive_generation',
          ownerId: OWNER,
          leaseUntil: FUTURE,
        }),
      )
      expect(error).toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_NOT_IN_TRANSACTION' })
      expectValuesFree(error)
      expect(await readSnapshot()).toBeNull()
      await client.query('ROLLBACK')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  test('a reflected token clone cannot claim while the original transaction and fence remain live', async () => {
    const client = await runtime.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const prepared = await prepareArchiveWriterBlockTransaction(asQuery(client), SHEET)
      const reflectedClone = Object.fromEntries(
        Reflect.ownKeys(prepared).map((key) => [key, prepared[key as keyof typeof prepared]]),
      )
      await expect(
        claimArchiveWriterBlockPrepared(reflectedClone as never, {
          ownerKind: 'archive_generation',
          ownerId: OWNER,
          leaseUntil: FUTURE,
        }),
      ).rejects.toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_NOT_IN_TRANSACTION' })
      const inside = await client.query(
        'SELECT recovery_writer_state AS state FROM public.meta_sheets WHERE id = $1',
        [SHEET],
      )
      expect(inside.rows[0]).toEqual({ state: null })
      await client.query('ROLLBACK')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  test('stale prepared token after commit fails NOT_IN_TRANSACTION with zero writes', async () => {
    const client = await runtime.pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      const query = asQuery(client)
      const prepared = await prepareArchiveWriterBlockTransaction(query, SHEET)
      await client.query('COMMIT')
      const error = await errorOf(
        claimArchiveWriterBlockPrepared(prepared, {
          ownerKind: 'archive_generation',
          ownerId: OWNER,
          leaseUntil: FUTURE,
        }),
      )
      expect(error).toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_NOT_IN_TRANSACTION' })
      expectValuesFree(error)
      expect(await readSnapshot()).toBeNull()
      const forged = await errorOf(
        claimArchiveWriterBlockPrepared({} as never, {
          ownerKind: 'archive_generation',
          ownerId: OWNER,
          leaseUntil: FUTURE,
        }),
      )
      expect(forged).toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_NOT_IN_TRANSACTION' })
      const lookalike = await errorOf(
        claimArchiveWriterBlockPrepared(
          { query, sheetId: SHEET, xid: '1' } as never,
          {
            ownerKind: 'archive_generation',
            ownerId: OWNER,
            leaseUntil: FUTURE,
          },
        ),
      )
      expect(lookalike).toMatchObject({ code: 'ARCHIVE_WRITER_BLOCK_NOT_IN_TRANSACTION' })
      expect(await readSnapshot()).toBeNull()
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})
