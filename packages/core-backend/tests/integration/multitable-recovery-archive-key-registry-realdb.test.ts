import { createHash, randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import * as keyRegistryMigration from '../../src/db/migrations/zzzz20260828121000_add_recovery_archive_key_registry'
import {
  lockActiveRecoveryArchiveKeyForReference,
  RecoveryArchiveKeyReferenceError,
  type RecoveryArchiveKeyRegistryQuery,
} from '../../src/multitable/recovery-archive-key-registry'

const runRealDb = Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeIfRealDbStep = runRealDb ? describe : describe.skip

test('sentinel: the D2 key-registry real-DB lane must provide DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('recovery_archive_key_registry_realdb_harness_missing_database_url')
  }
})

const RUN = randomUUID().replaceAll('-', '').slice(0, 12)
const KEY_TABLE = 'meta_recovery_archive_keys'
const FUNCTIONS = [
  'meta_recovery_archive_key_guard_row',
  'meta_recovery_archive_key_guard_truncate',
  'meta_recovery_archive_key_reference_guard_row',
] as const
const TRIGGERS = [
  'trg_meta_recovery_archive_key_guard_row',
  'trg_meta_recovery_archive_key_guard_truncate',
  'trg_meta_recovery_archive_key_reference_guard_row',
] as const

type DatabaseError = Error & { code?: string; detail?: string; where?: string; hint?: string }
type Scratch = { pool: Pool; db: Kysely<unknown>; name: string }

let adminPool: Pool
const liveScratches = new Set<Scratch>()

function databaseUrlFor(databaseName: string): string {
  const url = new URL(String(process.env.DATABASE_URL))
  url.pathname = `/${databaseName}`
  return url.toString()
}

async function createScratch(label: string, sourceKind: 'exact' | 'wrong-key-type' = 'exact'): Promise<Scratch> {
  const name = `tm_d2key_${RUN}_${label}`
  await adminPool.query(`CREATE DATABASE "${name}"`)
  const pool = new Pool({ connectionString: databaseUrlFor(name), max: 6 })
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  const scratch = { pool, db, name }
  liveScratches.add(scratch)
  await pool.query(
    sourceKind === 'exact'
      ? `CREATE TABLE public.meta_recovery_archives (
           generation_id uuid PRIMARY KEY,
           key_id text NOT NULL
         )`
      : `CREATE TABLE public.meta_recovery_archives (
           generation_id uuid PRIMARY KEY,
           key_id uuid NOT NULL
         )`,
  )
  return scratch
}

async function dropScratch(scratch: Scratch): Promise<void> {
  liveScratches.delete(scratch)
  await scratch.db.destroy().catch(() => {})
  await scratch.pool.end().catch(() => {})
  await adminPool
    .query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [scratch.name],
    )
    .catch(() => {})
  await adminPool.query(`DROP DATABASE IF EXISTS "${scratch.name}"`).catch(() => {})
}

async function withScratch<T>(label: string, run: (scratch: Scratch) => Promise<T>): Promise<T> {
  const scratch = await createScratch(label)
  try {
    return await run(scratch)
  } finally {
    await dropScratch(scratch)
  }
}

async function errorOf(promise: Promise<unknown>): Promise<DatabaseError> {
  try {
    await promise
  } catch (error) {
    return error as DatabaseError
  }
  throw new Error('expected_database_rejection')
}

function expectValuesFree(error: DatabaseError, forbiddenValues: readonly string[]): void {
  const rendered = [error.message, error.detail, error.where, error.hint].filter(Boolean).join(' ')
  for (const value of forbiddenValues) expect(rendered).not.toContain(value)
}

function asQuery(client: PoolClient): RecoveryArchiveKeyRegistryQuery {
  return (text, values) => client.query(text, values)
}

async function insertKey(
  scratch: Scratch,
  keyId: string,
  state: 'active' | 'retiring' | 'destroyed' = 'active',
): Promise<void> {
  if (state === 'active') {
    await scratch.pool.query(`INSERT INTO ${KEY_TABLE} (key_id) VALUES ($1)`, [keyId])
    return
  }
  await scratch.pool.query(`INSERT INTO ${KEY_TABLE} (key_id) VALUES ($1)`, [keyId])
  await scratch.pool.query(
    `UPDATE ${KEY_TABLE}
        SET state = 'retiring', row_version = row_version + 1
      WHERE key_id = $1`,
    [keyId],
  )
  if (state === 'destroyed') {
    const client = await scratch.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`LOCK TABLE ${KEY_TABLE} IN ACCESS EXCLUSIVE MODE`)
      await client.query(`ALTER TABLE ${KEY_TABLE} DISABLE TRIGGER USER`)
      await client.query(
        `UPDATE ${KEY_TABLE}
            SET state = 'destroyed', row_version = row_version + 1,
                updated_at = clock_timestamp()
          WHERE key_id = $1`,
        [keyId],
      )
      await client.query(`ALTER TABLE ${KEY_TABLE} ENABLE TRIGGER USER`)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }
}

async function insertGeneration(scratch: Scratch, generationId: string, keyId: string): Promise<void> {
  await scratch.pool.query(
    `INSERT INTO public.meta_recovery_archives (generation_id, key_id)
     VALUES ($1::uuid, $2)`,
    [generationId, keyId],
  )
}

async function registryFingerprint(scratch: Scratch): Promise<string> {
  const result = await scratch.pool.query(
    `SELECT kind, object_name, member_name, definition FROM (
       SELECT 'column'::text AS kind,
              table_name::text AS object_name,
              column_name::text AS member_name,
              concat_ws('|', data_type, udt_name, is_nullable,
                        coalesce(column_default, ''), coalesce(collation_name, ''))::text AS definition
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
       UNION ALL
       SELECT 'constraint', relation.relname, constraint_row.conname,
              pg_get_constraintdef(constraint_row.oid, true)
         FROM pg_constraint constraint_row
         JOIN pg_class relation ON relation.oid = constraint_row.conrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND (
            relation.relname = $1 OR
            constraint_row.conname = 'fk_meta_recovery_archives_key'
          )
       UNION ALL
       SELECT 'trigger', relation.relname, trigger_row.tgname,
              pg_get_triggerdef(trigger_row.oid, true)
         FROM pg_trigger trigger_row
         JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgname = ANY($2::text[])
       UNION ALL
       SELECT 'function', procedure_row.proname,
              pg_get_function_identity_arguments(procedure_row.oid),
              concat_ws('|', coalesce(array_to_string(procedure_row.proconfig, ','), ''),
                        pg_get_functiondef(procedure_row.oid))
         FROM pg_proc procedure_row
         JOIN pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
        WHERE namespace.nspname = 'public'
          AND procedure_row.proname = ANY($3::text[])
     ) catalog
     ORDER BY kind, object_name, member_name, definition`,
    [KEY_TABLE, TRIGGERS, FUNCTIONS],
  )
  return createHash('sha256').update(JSON.stringify(result.rows)).digest('hex')
}

async function forceClearKeys(scratch: Scratch): Promise<void> {
  await scratch.pool.query('BEGIN')
  try {
    await scratch.pool.query(`LOCK TABLE ${KEY_TABLE} IN ACCESS EXCLUSIVE MODE`)
    await scratch.pool.query(`ALTER TABLE ${KEY_TABLE} DISABLE TRIGGER USER`)
    await scratch.pool.query(`DELETE FROM ${KEY_TABLE}`)
    await scratch.pool.query(`ALTER TABLE ${KEY_TABLE} ENABLE TRIGGER USER`)
    await scratch.pool.query('COMMIT')
  } catch (error) {
    await scratch.pool.query('ROLLBACK')
    throw error
  }
}

async function waitForLockWait(observer: Pool, blockedPid: number): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const result = await observer.query(
      `SELECT wait_event_type,
              cardinality(pg_blocking_pids(pid))::int AS blocker_count
         FROM pg_stat_activity
        WHERE pid = $1`,
      [blockedPid],
    )
    if (result.rows[0]?.wait_event_type === 'Lock' && Number(result.rows[0]?.blocker_count) > 0) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('key_registry_lock_barrier_not_observed')
}

describeIfRealDbStep.sequential('Phase D2 key registry and reference admission (real DB)', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
  })

  afterAll(async () => {
    for (const scratch of [...liveScratches]) await dropScratch(scratch)
    await adminPool?.end().catch(() => {})
    const residue = await new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
    try {
      const result = await residue.query(
        `SELECT count(*)::int AS count
           FROM pg_database
          WHERE datname LIKE $1`,
        [`tm_d2key_${RUN}_%`],
      )
      expect(result.rows[0]?.count).toBe(0)
    } finally {
      await residue.end()
    }
  }, 120000)

  test('installs an exact restrictive authority surface and replays byte-identically', async () => {
    await withScratch('surface', async (scratch) => {
      await keyRegistryMigration.up(scratch.db)

      const surface = await scratch.pool.query(
        `SELECT
           (SELECT count(*)::int FROM information_schema.columns
             WHERE table_schema='public' AND table_name=$1) AS columns,
           (SELECT count(*)::int FROM pg_proc procedure_row
             JOIN pg_namespace namespace ON namespace.oid=procedure_row.pronamespace
            WHERE namespace.nspname='public' AND procedure_row.proname=ANY($2::text[])) AS functions,
           (SELECT count(*)::int FROM pg_trigger trigger_row
             JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
             JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
            WHERE namespace.nspname='public' AND NOT trigger_row.tgisinternal
              AND trigger_row.tgname=ANY($3::text[])) AS triggers`,
        [KEY_TABLE, FUNCTIONS, TRIGGERS],
      )
      expect(surface.rows).toEqual([{ columns: 5, functions: 3, triggers: 3 }])

      const foreignKey = await scratch.pool.query(
        `SELECT constraint_row.conname,
                constraint_row.contype,
                constraint_row.condeferrable,
                constraint_row.condeferred,
                constraint_row.convalidated,
                constraint_row.confdeltype,
                constraint_row.confupdtype,
                pg_get_constraintdef(constraint_row.oid, true) AS definition
           FROM pg_constraint constraint_row
           JOIN pg_class relation ON relation.oid=constraint_row.conrelid
           JOIN pg_class target ON target.oid=constraint_row.confrelid
          WHERE relation.relname='meta_recovery_archives'
            AND target.relname=$1`,
        [KEY_TABLE],
      )
      expect(foreignKey.rows).toEqual([
        {
          conname: 'fk_meta_recovery_archives_key',
          contype: 'f',
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confdeltype: 'r',
          confupdtype: 'r',
          definition:
            'FOREIGN KEY (key_id) REFERENCES meta_recovery_archive_keys(key_id) ON UPDATE RESTRICT ON DELETE RESTRICT',
        },
      ])

      const firstFingerprint = await registryFingerprint(scratch)
      await keyRegistryMigration.down(scratch.db)
      await keyRegistryMigration.up(scratch.db)
      expect(await registryFingerprint(scratch)).toBe(firstFingerprint)
    })
  }, 120000)

  test('fails loudly on source drift, same-name objects, and preexisting unregistered generations', async () => {
    const wrongSource = await createScratch('wrong_source', 'wrong-key-type')
    try {
      const error = await errorOf(keyRegistryMigration.up(wrongSource.db))
      expect(error.message).toBe('recovery_archive_key_registry_source_mismatch')
    } finally {
      await dropScratch(wrongSource)
    }

    await withScratch('object_conflict', async (scratch) => {
      await scratch.pool.query(`CREATE TABLE ${KEY_TABLE} (wrong text)`)
      const error = await errorOf(keyRegistryMigration.up(scratch.db))
      expect(error.message).toBe('recovery_archive_key_registry_object_conflict')
    })

    await withScratch('backfill', async (scratch) => {
      const sentinel = 'kms://sensitive/history'
      await scratch.pool.query(
        `INSERT INTO meta_recovery_archives (generation_id, key_id) VALUES ($1::uuid, $2)`,
        [randomUUID(), sentinel],
      )
      const error = await errorOf(keyRegistryMigration.up(scratch.db))
      expect(error.message).toBe('recovery_archive_key_registry_backfill_required')
      expectValuesFree(error, [sentinel])
      const absent = await scratch.pool.query(
        `SELECT pg_catalog.to_regclass('public.${KEY_TABLE}') IS NULL AS absent`,
      )
      expect(absent.rows).toEqual([{ absent: true }])
    })
  }, 120000)

  test('locks and returns only the active row-version snapshot', async () => {
    await withScratch('helper', async (scratch) => {
      await keyRegistryMigration.up(scratch.db)
      const activeKey = 'key-active'
      await insertKey(scratch, activeKey)

      const queryNeverCalled: RecoveryArchiveKeyRegistryQuery = async () => {
        throw new Error('unexpected_key_registry_query')
      }
      for (const input of [
        { keyId: '', expectedRowVersion: '1' },
        { keyId: ' padded', expectedRowVersion: '1' },
        { keyId: 'line\nbreak', expectedRowVersion: '1' },
        { keyId: activeKey, expectedRowVersion: '0' },
        { keyId: activeKey, expectedRowVersion: '01' },
      ]) {
        const inputError = await errorOf(
          lockActiveRecoveryArchiveKeyForReference(queryNeverCalled, input),
        )
        expect(inputError.message).toBe('RECOVERY_ARCHIVE_KEY_REFERENCE_INVALID_INPUT')
        expectValuesFree(inputError, input.keyId.length > 0 ? [input.keyId] : [])
      }

      const autocommitError = await errorOf(
        lockActiveRecoveryArchiveKeyForReference((text, values) => scratch.pool.query(text, values), {
          keyId: activeKey,
          expectedRowVersion: '1',
        }),
      )
      expect(autocommitError.message).toBe('RECOVERY_ARCHIVE_KEY_REFERENCE_NOT_IN_TRANSACTION')
      expectValuesFree(autocommitError, [activeKey])

      const client = await scratch.pool.connect()
      try {
        await client.query('BEGIN')
        await expect(
          lockActiveRecoveryArchiveKeyForReference(asQuery(client), {
            keyId: activeKey,
            expectedRowVersion: '1',
          }),
        ).resolves.toEqual({ state: 'active', rowVersion: '1' })
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }

      for (const [keyId, state, version] of [
        ['key-retiring', 'retiring', '2'],
        ['key-destroyed', 'destroyed', '3'],
      ] as const) {
        await insertKey(scratch, keyId, state)
        const error = await errorOf(
          lockActiveRecoveryArchiveKeyForReference((text, values) => scratch.pool.query(text, values), {
            keyId,
            expectedRowVersion: version,
          }),
        )
        expect(error).toBeInstanceOf(RecoveryArchiveKeyReferenceError)
        expect(error.message).toBe('RECOVERY_ARCHIVE_KEY_REFERENCE_UNAVAILABLE')
        expectValuesFree(error, [keyId])
      }

      const missing = 'key-missing'
      const missingError = await errorOf(
        lockActiveRecoveryArchiveKeyForReference((text, values) => scratch.pool.query(text, values), {
          keyId: missing,
          expectedRowVersion: '1',
        }),
      )
      expect(missingError.message).toBe('RECOVERY_ARCHIVE_KEY_REFERENCE_UNAVAILABLE')
      expectValuesFree(missingError, [missing])
    })
  }, 120000)

  test('serializes reference admission before retirement with a lock-observed barrier', async () => {
    await withScratch('claim_wins', async (scratch) => {
      await keyRegistryMigration.up(scratch.db)
      const keyId = 'key-claim-wins'
      const generationId = randomUUID()
      await insertKey(scratch, keyId)

      const claimant = await scratch.pool.connect()
      const retirement = await scratch.pool.connect()
      try {
        await claimant.query('BEGIN')
        await retirement.query('BEGIN')
        const retirementPid = Number((await retirement.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)

        await lockActiveRecoveryArchiveKeyForReference(asQuery(claimant), {
          keyId,
          expectedRowVersion: '1',
        })
        const retirementUpdate = retirement.query(
          `UPDATE ${KEY_TABLE}
              SET state='retiring', row_version=row_version+1
            WHERE key_id=$1`,
          [keyId],
        )
        await waitForLockWait(scratch.pool, retirementPid)

        await claimant.query(
          `INSERT INTO meta_recovery_archives (generation_id, key_id) VALUES ($1::uuid, $2)`,
          [generationId, keyId],
        )
        await claimant.query('COMMIT')
        await retirementUpdate
        await retirement.query('COMMIT')

        const final = await scratch.pool.query(
          `SELECT key_row.state, key_row.row_version::text AS row_version,
                  count(archive.generation_id)::int AS references
             FROM ${KEY_TABLE} key_row
             LEFT JOIN meta_recovery_archives archive ON archive.key_id=key_row.key_id
            WHERE key_row.key_id=$1
            GROUP BY key_row.state, key_row.row_version`,
          [keyId],
        )
        expect(final.rows).toEqual([{ state: 'retiring', row_version: '2', references: 1 }])
      } finally {
        await claimant.query('ROLLBACK').catch(() => {})
        await retirement.query('ROLLBACK').catch(() => {})
        claimant.release()
        retirement.release()
      }
    })
  }, 120000)

  test('raw generation admission holds the key authority row through commit', async () => {
    await withScratch('raw_claim_wins', async (scratch) => {
      await keyRegistryMigration.up(scratch.db)
      const keyId = 'key-raw-claim-wins'
      await insertKey(scratch, keyId)

      const claimant = await scratch.pool.connect()
      const retirement = await scratch.pool.connect()
      try {
        await claimant.query('BEGIN')
        await retirement.query('BEGIN')
        const retirementPid = Number((await retirement.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid)

        await claimant.query(
          `INSERT INTO meta_recovery_archives (generation_id, key_id) VALUES ($1::uuid, $2)`,
          [randomUUID(), keyId],
        )
        const retirementUpdate = retirement.query(
          `UPDATE ${KEY_TABLE}
              SET state='retiring', row_version=row_version+1
            WHERE key_id=$1`,
          [keyId],
        )
        await waitForLockWait(scratch.pool, retirementPid)

        await claimant.query('COMMIT')
        await retirementUpdate
        await retirement.query('COMMIT')

        const final = await scratch.pool.query(
          `SELECT key_row.state, count(archive.generation_id)::int AS references
             FROM ${KEY_TABLE} key_row
             LEFT JOIN meta_recovery_archives archive ON archive.key_id=key_row.key_id
            WHERE key_row.key_id=$1
            GROUP BY key_row.state`,
          [keyId],
        )
        expect(final.rows).toEqual([{ state: 'retiring', references: 1 }])
      } finally {
        await claimant.query('ROLLBACK').catch(() => {})
        await retirement.query('ROLLBACK').catch(() => {})
        claimant.release()
        retirement.release()
      }
    })
  }, 120000)

  test('retirement or destruction wins before admission and raw generation inserts write zero', async () => {
    await withScratch('retirement_wins', async (scratch) => {
      await keyRegistryMigration.up(scratch.db)

      for (const [state, version] of [
        ['retiring', '2'],
        ['destroyed', '3'],
      ] as const) {
        const keyId = `key-${state}`
        const generationId = randomUUID()
        await insertKey(scratch, keyId, state)

        const helperError = await errorOf(
          lockActiveRecoveryArchiveKeyForReference((text, values) => scratch.pool.query(text, values), {
            keyId,
            expectedRowVersion: version,
          }),
        )
        expect(helperError.message).toBe('RECOVERY_ARCHIVE_KEY_REFERENCE_UNAVAILABLE')

        const rawError = await errorOf(insertGeneration(scratch, generationId, keyId))
        expect(rawError.message).toBe('recovery_archive_key_reference_unavailable')
        expectValuesFree(rawError, [keyId, generationId])
        const count = await scratch.pool.query(
          `SELECT count(*)::int AS count FROM meta_recovery_archives WHERE generation_id=$1::uuid`,
          [generationId],
        )
        expect(count.rows).toEqual([{ count: 0 }])
      }

      const missingKey = 'key-not-provisioned'
      const missingGeneration = randomUUID()
      const missingError = await errorOf(insertGeneration(scratch, missingGeneration, missingKey))
      expect(missingError.message).toBe('recovery_archive_key_reference_unavailable')
      expectValuesFree(missingError, [missingKey, missingGeneration])
    })
  }, 120000)

  test('keeps destruction and retirement cancellation unreachable without D3 authority', async () => {
    await withScratch('transition_boundary', async (scratch) => {
      await keyRegistryMigration.up(scratch.db)
      const keyId = 'key-transition-boundary'
      await insertKey(scratch, keyId, 'retiring')

      for (const targetState of ['destroyed', 'active'] as const) {
        const error = await errorOf(
          scratch.pool.query(
            `UPDATE ${KEY_TABLE}
                SET state = $2, row_version = row_version + 1
              WHERE key_id = $1`,
            [keyId, targetState],
          ),
        )
        expect(error.message).toBe('recovery_archive_key_transition_invalid')
        expectValuesFree(error, [keyId])
      }

      const final = await scratch.pool.query(
        `SELECT state, row_version::text AS row_version
           FROM ${KEY_TABLE}
          WHERE key_id = $1`,
        [keyId],
      )
      expect(final.rows).toEqual([{ state: 'retiring', row_version: '2' }])
    })
  }, 120000)

  test('enforces strict immutable identities, restrictive deletes, and non-destructive down', async () => {
    await withScratch('lifecycle_guards', async (scratch) => {
      await keyRegistryMigration.up(scratch.db)

      for (const invalidKey of [' padded', 'padded ', 'line\nbreak']) {
        const error = await errorOf(
          scratch.pool.query(`INSERT INTO ${KEY_TABLE} (key_id) VALUES ($1)`, [invalidKey]),
        )
        expect(error.message).toBe('recovery_archive_key_shape_invalid')
        expectValuesFree(error, [invalidKey])
      }

      const keyId = 'key-immutable'
      const generationId = randomUUID()
      await insertKey(scratch, keyId)
      await insertGeneration(scratch, generationId, keyId)

      const deleteError = await errorOf(
        scratch.pool.query(`DELETE FROM ${KEY_TABLE} WHERE key_id=$1`, [keyId]),
      )
      expect(deleteError.message).toBe('recovery_archive_key_delete_not_authorized')
      expectValuesFree(deleteError, [keyId])
      expect((await scratch.pool.query(`SELECT count(*)::int AS count FROM ${KEY_TABLE}`)).rows)
        .toEqual([{ count: 1 }])

      const downError = await errorOf(keyRegistryMigration.down(scratch.db))
      expect(downError.message).toBe('recovery_archive_key_registry_nonempty')
      expectValuesFree(downError, [keyId, generationId])

      const restrictiveTruncateError = await errorOf(scratch.pool.query(`TRUNCATE TABLE ${KEY_TABLE}`))
      expect(restrictiveTruncateError.code).toBe('0A000')
      expectValuesFree(restrictiveTruncateError, [keyId, generationId])

      await scratch.pool.query('DELETE FROM meta_recovery_archives WHERE generation_id=$1::uuid', [generationId])
      const truncateGuardError = await errorOf(
        scratch.pool.query(`TRUNCATE TABLE ${KEY_TABLE}, meta_recovery_archives`),
      )
      expect(truncateGuardError.message).toBe('recovery_archive_key_truncate_not_authorized')
      expect((await scratch.pool.query(`SELECT count(*)::int AS count FROM ${KEY_TABLE}`)).rows)
        .toEqual([{ count: 1 }])
      await forceClearKeys(scratch)
      await keyRegistryMigration.down(scratch.db)
      const absent = await scratch.pool.query(
        `SELECT pg_catalog.to_regclass('public.${KEY_TABLE}') IS NULL AS key_table_absent,
                NOT EXISTS (
                  SELECT 1 FROM pg_constraint WHERE conname='fk_meta_recovery_archives_key'
                ) AS foreign_key_absent`,
      )
      expect(absent.rows).toEqual([{ key_table_absent: true, foreign_key_absent: true }])
    })
  }, 120000)

  test('down refuses a concurrent uncommitted key reference without dropping authority', async () => {
    await withScratch('down_race', async (scratch) => {
      await keyRegistryMigration.up(scratch.db)
      const keyId = 'key-down-race'
      const generationId = randomUUID()
      const writer = await scratch.pool.connect()
      const downPool = new Pool({ connectionString: databaseUrlFor(scratch.name), max: 1 })
      const downDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: downPool }) })
      try {
        await downPool.query("SET statement_timeout='750ms'")
        await writer.query('BEGIN')
        await writer.query(`INSERT INTO ${KEY_TABLE} (key_id) VALUES ($1)`, [keyId])
        await writer.query(
          `INSERT INTO meta_recovery_archives (generation_id, key_id) VALUES ($1::uuid, $2)`,
          [generationId, keyId],
        )

        const refusal = await errorOf(keyRegistryMigration.down(downDb))
        expect(refusal.message).toBe('recovery_archive_key_registry_busy')
        expectValuesFree(refusal, [keyId, generationId])
        await writer.query('COMMIT')

        const retained = await scratch.pool.query(
          `SELECT pg_catalog.to_regclass('public.${KEY_TABLE}') IS NOT NULL AS key_table_present,
                  EXISTS (
                    SELECT 1 FROM pg_constraint
                     WHERE conname='fk_meta_recovery_archives_key'
                  ) AS foreign_key_present,
                  (SELECT count(*)::int FROM ${KEY_TABLE} WHERE key_id=$1) AS key_count,
                  (SELECT count(*)::int FROM meta_recovery_archives
                    WHERE generation_id=$2::uuid AND key_id=$1) AS archive_count`,
          [keyId, generationId],
        )
        expect(retained.rows).toEqual([{
          key_table_present: true,
          foreign_key_present: true,
          key_count: 1,
          archive_count: 1,
        }])
      } finally {
        await writer.query('ROLLBACK').catch(() => {})
        writer.release()
        await downDb.destroy().catch(() => {})
        await downPool.end().catch(() => {})
      }
    })
  }, 120000)
})
