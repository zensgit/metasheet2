import { createHash, randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import * as claimAnchorMigration from '../../src/db/migrations/zzzz20260828126000_amend_recovery_archive_claim_anchor'
import * as legalHoldMigration from '../../src/db/migrations/zzzz20260828130000_add_recovery_archive_legal_hold_authority'
import {
  expireRecoveryArchiveAfterLegalHoldCheck,
  placeRecoveryArchiveLegalHold,
  RecoveryArchiveLegalHoldError,
  releaseRecoveryArchiveLegalHold,
  type PlaceRecoveryArchiveLegalHoldInput,
  type RecoveryArchiveLegalHoldQuery,
} from '../../src/multitable/recovery-archive-legal-holds'

const runRealDb = Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeIfRealDbStep = runRealDb ? describe : describe.skip

test('sentinel: the D3 legal-hold real-DB step must provide DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('recovery_archive_legal_hold_realdb_harness_missing_database_url')
  }
})

const RUN = randomUUID().replaceAll('-', '').slice(0, 16)
const PREFIX = `tm_d3hold_${RUN}`
const WORKSPACE = `${PREFIX}_workspace`
const BASE = `${PREFIX}_base`
const SHEET = `${PREFIX}_sheet`
const CHECKPOINT = `${PREFIX}_checkpoint`
const KEY_ID = `${PREFIX}_key`
const PLACED_ACTOR = `${PREFIX}_placed_actor`
const RELEASED_ACTOR = `${PREFIX}_released_actor`
const ANCHOR_OPERATION = randomUUID()
const ANCHOR_SEQ = '9007199254753001'
const ARCHIVE_COUNT = 12

type DatabaseError = Error & { code?: string; detail?: string; where?: string }

let pool: Pool
let db: Kysely<unknown>
let schemaIsUp = true
let initialFingerprint = ''
const generations: string[] = []

const q: RecoveryArchiveLegalHoldQuery = (text, values) => pool.query(text, values)

async function transaction<T>(work: (query: RecoveryArchiveLegalHoldQuery) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work((text, values) => client.query(text, values))
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
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

function expectValuesFree(error: DatabaseError, values: readonly string[]): void {
  const rendered = [error.message, error.detail, error.where].filter(Boolean).join(' ')
  for (const value of values) expect(rendered).not.toContain(value)
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function placeInput(generationId: string, suffix: string): PlaceRecoveryArchiveLegalHoldInput {
  return {
    holdId: randomUUID(),
    workspaceId: WORKSPACE,
    baseId: BASE,
    sheetId: SHEET,
    generationId,
    reasonCode: `LEGAL_${suffix.toUpperCase()}`,
    placedByActorId: PLACED_ACTOR,
  }
}

async function placeCommitted(
  generationId: string,
  suffix: string,
): Promise<Awaited<ReturnType<typeof placeRecoveryArchiveLegalHold>>> {
  return transaction((query) => placeRecoveryArchiveLegalHold(query, placeInput(generationId, suffix)))
}

async function releaseCommitted(
  placed: Awaited<ReturnType<typeof placeRecoveryArchiveLegalHold>>,
  expectedRowVersion = placed.rowVersion,
): Promise<Awaited<ReturnType<typeof releaseRecoveryArchiveLegalHold>>> {
  return transaction((query) => releaseRecoveryArchiveLegalHold(query, {
    holdId: placed.holdId,
    workspaceId: placed.workspaceId,
    baseId: placed.baseId,
    sheetId: placed.sheetId,
    generationId: placed.generationId,
    expectedRowVersion,
    releasedByActorId: RELEASED_ACTOR,
  }))
}

async function expireCommitted(generationId: string) {
  return transaction((query) => expireRecoveryArchiveAfterLegalHoldCheck(query, {
    workspaceId: WORKSPACE,
    baseId: BASE,
    sheetId: SHEET,
    generationId,
  }))
}

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query('SELECT pg_backend_pid() AS pid')
  return Number(result.rows[0]?.pid)
}

async function waitForBlockedBy(waiterPid: number, blockerPid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await q(
      `SELECT wait_event_type = 'Lock'
              AND $2::int = ANY(pg_catalog.pg_blocking_pids($1::int)) AS blocked
         FROM pg_catalog.pg_stat_activity
        WHERE pid = $1::int`,
      [waiterPid, blockerPid],
    )
    if ((result.rows[0] as { blocked?: unknown } | undefined)?.blocked === true) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('recovery_archive_legal_hold_lock_probe_timeout')
}

async function authorityFingerprint(): Promise<string> {
  const result = await q(
    `SELECT md5(string_agg(definition, '|' ORDER BY definition)) AS fingerprint
       FROM (
         SELECT concat_ws('|', 'column', attribute.attname,
                          pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                          attribute.attnotnull::text) AS definition
           FROM pg_catalog.pg_attribute attribute
          WHERE attribute.attrelid = 'public.meta_recovery_archive_legal_holds'::regclass
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
         UNION ALL
         SELECT concat_ws('|', 'constraint', constraint_row.conname,
                          pg_catalog.pg_get_constraintdef(constraint_row.oid, true))
           FROM pg_catalog.pg_constraint constraint_row
          WHERE constraint_row.conrelid = 'public.meta_recovery_archive_legal_holds'::regclass
         UNION ALL
         SELECT concat_ws('|', 'index', relation.relname, pg_catalog.pg_get_indexdef(index_row.indexrelid))
           FROM pg_catalog.pg_index index_row
           JOIN pg_catalog.pg_class relation ON relation.oid = index_row.indexrelid
          WHERE index_row.indrelid = 'public.meta_recovery_archive_legal_holds'::regclass
         UNION ALL
         SELECT concat_ws('|', 'trigger', trigger_row.tgname,
                          pg_catalog.pg_get_triggerdef(trigger_row.oid, true))
           FROM pg_catalog.pg_trigger trigger_row
          WHERE trigger_row.tgrelid IN (
                  'public.meta_recovery_archive_legal_holds'::regclass,
                  'public.meta_recovery_archives'::regclass
                )
            AND trigger_row.tgname LIKE '%legal_hold%'
            AND NOT trigger_row.tgisinternal
         UNION ALL
         SELECT concat_ws('|', 'function', procedure_row.proname,
                          pg_catalog.md5(procedure_row.prosrc),
                          coalesce(pg_catalog.array_to_string(procedure_row.proconfig, ','), ''))
           FROM pg_catalog.pg_proc procedure_row
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
          WHERE namespace.nspname = 'public'
            AND procedure_row.proname IN (
              'meta_recovery_archive_legal_hold_guard_row',
              'meta_recovery_archive_legal_hold_guard_truncate',
              'meta_recovery_archive_legal_hold_expiry_guard_row',
              'meta_recovery_archive_expiry_authorize',
              'meta_recovery_archive_legal_hold_release_authorize'
            )
       ) definitions`,
  )
  return String((result.rows[0] as { fingerprint?: unknown } | undefined)?.fingerprint ?? '')
}

async function seedArchiveParents(): Promise<void> {
  await q('INSERT INTO meta_recovery_archive_keys (key_id) VALUES ($1)', [KEY_ID])
  await q('INSERT INTO meta_bases (id, name, workspace_id) VALUES ($1, $2, $3)', [
    BASE,
    `${PREFIX} Base`,
    WORKSPACE,
  ])
  await q('INSERT INTO meta_sheets (id, base_id, name, system_kind) VALUES ($1, $2, $3, NULL)', [
    SHEET,
    BASE,
    `${PREFIX} Sheet`,
  ])
  const causalityClient = await pool.connect()
  try {
    await causalityClient.query('BEGIN')
    await causalityClient.query(
      `INSERT INTO meta_record_revisions (
         id, sheet_id, record_id, version, action, source,
         changed_field_ids, patch, snapshot, seq, operation_id
       ) VALUES ($1::uuid, $2, $3, 1, 'create', 'rest',
                 ARRAY[]::text[], '{}'::jsonb, '{}'::jsonb, $4::bigint, $5::uuid)`,
      [randomUUID(), SHEET, `${PREFIX}_record`, ANCHOR_SEQ, ANCHOR_OPERATION],
    )
    await causalityClient.query(
      `INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count)
       VALUES ($1, $2::uuid, $3::bigint, 1)`,
      [SHEET, ANCHOR_OPERATION, ANCHOR_SEQ],
    )
    await causalityClient.query('COMMIT')
  } catch (error) {
    await causalityClient.query('ROLLBACK')
    throw error
  } finally {
    causalityClient.release()
  }
  await q(
    `INSERT INTO meta_history_trust_checkpoints (id, sheet_id, state, trusted_since_seq)
     VALUES ($1, $2, 'active', $3::bigint)`,
    [CHECKPOINT, SHEET, ANCHOR_SEQ],
  )

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('LOCK TABLE meta_recovery_archives IN ACCESS EXCLUSIVE MODE')
    await client.query('ALTER TABLE meta_recovery_archives DISABLE TRIGGER USER')
    for (let index = 0; index < ARCHIVE_COUNT; index += 1) {
      const generationId = randomUUID()
      generations.push(generationId)
      await client.query(
        `INSERT INTO meta_recovery_archives (
           generation_id, workspace_id, base_id, sheet_id, anchor_operation_id, anchor_seq,
           checkpoint_id, format_version, state, build_status, coverage_status,
           source_vector_hash, key_id, root_hash, coverage_section_hash, coverage_row_count,
           manifest_mac, owner_kind, owner_id, owner_fence, lease_expires_at, expires_at
         ) VALUES (
           $1::uuid, $2, $3, $4, $5::uuid, $6::bigint,
           $7, 1, 'verified', 'finalized', 'complete',
           $8, $9, $10, $11, 0,
           $12::bytea, 'archive_builder', $13, 1,
           '2099-01-01T00:00:00Z'::timestamptz,
           CASE WHEN $14::int IN (4, 5) THEN
             '2000-01-01T00:00:00Z'::timestamptz
           ELSE '2099-12-31T00:00:00Z'::timestamptz END
         )`,
        [
          generationId,
          WORKSPACE,
          BASE,
          SHEET,
          ANCHOR_OPERATION,
          ANCHOR_SEQ,
          CHECKPOINT,
          sha(`${PREFIX}:source:${index}`),
          KEY_ID,
          sha(`${PREFIX}:root:${index}`),
          sha(`${PREFIX}:coverage:${index}`),
          Buffer.from(`legal-hold-${index}`),
          `${PREFIX}_owner`,
          index,
        ],
      )
    }
    await client.query('ALTER TABLE meta_recovery_archives ENABLE TRIGGER USER')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function clearHoldsForTeardown(): Promise<void> {
  const present = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_legal_holds') IS NOT NULL AS present`,
  )
  if ((present.rows[0] as { present?: unknown } | undefined)?.present !== true) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('LOCK TABLE meta_recovery_archive_legal_holds IN ACCESS EXCLUSIVE MODE')
    await client.query('ALTER TABLE meta_recovery_archive_legal_holds DISABLE TRIGGER USER')
    await client.query('TRUNCATE TABLE meta_recovery_archive_legal_holds')
    await client.query('ALTER TABLE meta_recovery_archive_legal_holds ENABLE TRIGGER USER')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

describeIfRealDbStep('Phase D3 legal-hold storage authority (real DB)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    const present = await q(
      `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_legal_holds') IS NOT NULL AS present`,
    )
    if ((present.rows[0] as { present?: unknown } | undefined)?.present !== true) {
      await legalHoldMigration.up(db)
    }
    schemaIsUp = true
    initialFingerprint = await authorityFingerprint()
    await seedArchiveParents()
  })

  afterAll(async () => {
    try {
      if (!schemaIsUp) {
        await legalHoldMigration.up(db)
        schemaIsUp = true
      }
      await clearHoldsForTeardown()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('LOCK TABLE meta_recovery_archives IN ACCESS EXCLUSIVE MODE')
        await client.query('ALTER TABLE meta_recovery_archives DISABLE TRIGGER USER')
        await client.query('DELETE FROM meta_recovery_archives WHERE generation_id = ANY($1::uuid[])', [
          generations,
        ])
        await client.query('ALTER TABLE meta_recovery_archives ENABLE TRIGGER USER')
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
      await q('SELECT meta_record_history_operations_prune($1, $2::uuid)', [SHEET, ANCHOR_OPERATION])
      await q('DELETE FROM meta_history_trust_checkpoints WHERE id = $1', [CHECKPOINT])
      await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET])
      await q('DELETE FROM meta_bases WHERE id = $1', [BASE])
      await transaction(async (query) => {
        await query('LOCK TABLE meta_recovery_archive_keys IN ACCESS EXCLUSIVE MODE')
        await query('ALTER TABLE meta_recovery_archive_keys DISABLE TRIGGER USER')
        await query('DELETE FROM meta_recovery_archive_keys WHERE key_id = $1', [KEY_ID])
        await query('ALTER TABLE meta_recovery_archive_keys ENABLE TRIGGER USER')
      })
    } finally {
      await db.destroy()
    }
  })

  test('schema is exact and a second up fails loud without changing authority', async () => {
    const shape = await q(
      `SELECT
         (SELECT count(*)::int FROM pg_catalog.pg_attribute attribute
           WHERE attribute.attrelid = 'public.meta_recovery_archive_legal_holds'::regclass
             AND attribute.attnum > 0 AND NOT attribute.attisdropped) AS columns,
         (SELECT count(*)::int FROM pg_catalog.pg_trigger trigger_row
           WHERE trigger_row.tgname = ANY(ARRAY[
             'trg_meta_recovery_archive_legal_hold_guard_row',
             'trg_meta_recovery_archive_legal_hold_guard_truncate',
             'trg_meta_recovery_archives_legal_hold_expiry_guard_row'
           ]::text[]) AND NOT trigger_row.tgisinternal) AS triggers,
         (SELECT count(*)::int FROM pg_catalog.pg_index index_row
           JOIN pg_catalog.pg_class relation ON relation.oid = index_row.indexrelid
          WHERE index_row.indrelid = 'public.meta_recovery_archive_legal_holds'::regclass
            AND relation.relname = 'idx_meta_recovery_archive_legal_holds_active_generation'
            AND index_row.indisunique
           AND index_row.indpred IS NOT NULL) AS active_unique,
         (SELECT count(*)::int FROM pg_catalog.pg_proc procedure_row
           JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
          WHERE namespace.nspname = 'public'
            AND procedure_row.proname = ANY(ARRAY[
              'meta_recovery_archive_legal_hold_guard_row',
              'meta_recovery_archive_legal_hold_guard_truncate',
              'meta_recovery_archive_legal_hold_expiry_guard_row',
              'meta_recovery_archive_expiry_authorize',
              'meta_recovery_archive_legal_hold_release_authorize'
            ]::text[])) AS functions,
         pg_catalog.to_regclass('public.meta_recovery_archive_object_deletions') IS NULL
           AS deletion_intents_absent`,
    )
    expect(shape.rows).toEqual([{
      columns: 12,
      triggers: 3,
      active_unique: 1,
      functions: 5,
      deletion_intents_absent: true,
    }])
    expect(initialFingerprint).toMatch(/^[0-9a-f]{32}$/)

    const conflict = await errorOf(legalHoldMigration.up(db))
    expect(conflict.code).toBe('55000')
    expect(conflict.message).toBe('recovery_archive_legal_hold_object_conflict')
    expect(await authorityFingerprint()).toBe(initialFingerprint)
  })

  test('empty development down and up replay exactly', async () => {
    await legalHoldMigration.down(db)
    schemaIsUp = false
    const absent = await q(
      `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_legal_holds') IS NULL AS absent`,
    )
    expect(absent.rows).toEqual([{ absent: true }])
    await legalHoldMigration.up(db)
    schemaIsUp = true
    expect(await authorityFingerprint()).toBe(initialFingerprint)
  })

  test('up and down fail loud when a pinned parent or owned authority drifts', async () => {
    const oldSubstrate = await errorOf(db.transaction().execute(async (trx) => {
      await claimAnchorMigration.down(trx)
      await legalHoldMigration.up(trx)
    }))
    expect(oldSubstrate.code).toBe('55000')
    expect(oldSubstrate.message).toBe('recovery_archive_legal_hold_source_schema_mismatch')

    const parentFunctionDrift = await errorOf(db.transaction().execute(async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION public.meta_recovery_archives_claim_anchor_guard_row()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        BEGIN
          RETURN NEW;
        END $$
      `.execute(trx)
      await legalHoldMigration.up(trx)
    }))
    expect(parentFunctionDrift.code).toBe('55000')
    expect(parentFunctionDrift.message).toBe('recovery_archive_legal_hold_source_schema_mismatch')

    const parentTriggerDrift = await errorOf(db.transaction().execute(async (trx) => {
      await sql`
        DROP TRIGGER trg_meta_recovery_archives_claim_anchor_reservation_guard
          ON public.meta_recovery_archives
      `.execute(trx)
      await sql`
        CREATE CONSTRAINT TRIGGER trg_meta_recovery_archives_claim_anchor_reservation_guard
        AFTER INSERT OR UPDATE ON public.meta_recovery_archives
        DEFERRABLE INITIALLY IMMEDIATE
        FOR EACH ROW
        EXECUTE FUNCTION public.meta_recovery_archives_claim_anchor_reservation_guard()
      `.execute(trx)
      await legalHoldMigration.up(trx)
    }))
    expect(parentTriggerDrift.code).toBe('55000')
    expect(parentTriggerDrift.message).toBe('recovery_archive_legal_hold_source_schema_mismatch')

    const parentFkDrift = await errorOf(db.transaction().execute(async (trx) => {
      await sql`
        ALTER TABLE public.meta_recovery_archives
          ADD CONSTRAINT fk_meta_recovery_archives_d3_drift
          FOREIGN KEY (sheet_id, anchor_operation_id)
          REFERENCES public.meta_record_history_operations(sheet_id, operation_id)
          ON DELETE RESTRICT
          NOT VALID
      `.execute(trx)
      await legalHoldMigration.up(trx)
    }))
    expect(parentFkDrift.code).toBe('55000')
    expect(parentFkDrift.message).toBe('recovery_archive_legal_hold_source_schema_mismatch')

    const ownDownDrift = await errorOf(db.transaction().execute(async (trx) => {
      await sql`
        CREATE OR REPLACE FUNCTION public.meta_recovery_archive_legal_hold_release_authorize(
          expected_hold_id uuid,
          expected_generation_id uuid,
          expected_workspace_id text,
          expected_base_id text,
          expected_sheet_id text,
          expected_row_version bigint
        )
        RETURNS void
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $$
        BEGIN
          RETURN;
        END $$
      `.execute(trx)
      await legalHoldMigration.down(trx)
    }))
    expect(ownDownDrift.code).toBe('55000')
    expect(ownDownDrift.message).toBe('recovery_archive_legal_hold_schema_mismatch')
    expect(await authorityFingerprint()).toBe(initialFingerprint)
  })

  test('exact binding is enforced by helper and raw authority', async () => {
    const generationId = generations[0] as string
    const mismatch = `${PREFIX}_wrong_workspace`
    const helperError = await errorOf(transaction((query) => placeRecoveryArchiveLegalHold(query, {
      ...placeInput(generationId, 'binding'),
      workspaceId: mismatch,
    })))
    expect((helperError as RecoveryArchiveLegalHoldError).code).toBe(
      'RECOVERY_ARCHIVE_LEGAL_HOLD_BINDING_REFUSED',
    )
    expectValuesFree(helperError, [generationId, mismatch, KEY_ID])

    const rawError = await errorOf(q(
      `INSERT INTO meta_recovery_archive_legal_holds (
         id, workspace_id, base_id, sheet_id, generation_id,
         state, reason_code, placed_by_actor_id, row_version
       ) VALUES ($1::uuid, $2, $3, $4, $5::uuid, 'active', 'LEGAL_BINDING', $6, 1)`,
      [randomUUID(), mismatch, BASE, SHEET, generationId, PLACED_ACTOR],
    ))
    expect(rawError.code).toBe('55000')
    expect(rawError.message).toBe('recovery_archive_legal_hold_binding_invalid')
    expectValuesFree(rawError, [generationId, mismatch, PLACED_ACTOR])

    const placed = await placeCommitted(generationId, 'binding')
    expect(placed).toMatchObject({
      workspaceId: WORKSPACE,
      baseId: BASE,
      sheetId: SHEET,
      generationId,
      state: 'active',
      rowVersion: '1',
    })
  })

  test('one active hold is unique under concurrency and raw DML', async () => {
    const generationId = generations[1] as string
    const firstInput = placeInput(generationId, 'concurrent_a')
    const secondInput = placeInput(generationId, 'concurrent_b')
    const first = await pool.connect()
    const second = await pool.connect()
    let secondPromise: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined
    try {
      await first.query('BEGIN')
      await placeRecoveryArchiveLegalHold((text, values) => first.query(text, values), firstInput)

      await second.query('BEGIN')
      const firstPid = await backendPid(first)
      const secondPid = await backendPid(second)
      secondPromise = placeRecoveryArchiveLegalHold(
        (text, values) => second.query(text, values),
        secondInput,
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      await waitForBlockedBy(secondPid, firstPid)
      await first.query('COMMIT')
      const outcome = await secondPromise
      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('expected_place_conflict')
      expect((outcome.error as RecoveryArchiveLegalHoldError).code).toBe(
        'RECOVERY_ARCHIVE_LEGAL_HOLD_PLACE_CONFLICT',
      )
      await second.query('ROLLBACK')
    } catch (error) {
      await first.query('ROLLBACK').catch(() => {})
      await second.query('ROLLBACK').catch(() => {})
      if (secondPromise) await secondPromise
      throw error
    } finally {
      second.release()
      first.release()
    }

    const duplicateId = randomUUID()
    const duplicate = await errorOf(q(
      `INSERT INTO meta_recovery_archive_legal_holds (
         id, workspace_id, base_id, sheet_id, generation_id,
         state, reason_code, placed_by_actor_id, row_version
       ) VALUES ($1::uuid, $2, $3, $4, $5::uuid, 'active', 'LEGAL_RAW_DUPLICATE', $6, 1)`,
      [duplicateId, WORKSPACE, BASE, SHEET, generationId, PLACED_ACTOR],
    ))
    expect(duplicate.code).toBe('55000')
    expect(duplicate.message).toBe('recovery_archive_legal_hold_active_exists')
    expectValuesFree(duplicate, [duplicateId, generationId, WORKSPACE, BASE, SHEET, PLACED_ACTOR])
    const active = await q(
      `SELECT count(*)::int AS count
         FROM meta_recovery_archive_legal_holds
        WHERE generation_id = $1::uuid AND state = 'active'`,
      [generationId],
    )
    expect(active.rows).toEqual([{ count: 1 }])
  })

  test('release is one exact row-version CAS and stale writes affect zero rows', async () => {
    const placed = await placeCommitted(generations[2] as string, 'release_cas')
    const stale = await errorOf(releaseCommitted(placed, '2'))
    expect((stale as RecoveryArchiveLegalHoldError).code).toBe(
      'RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_STALE',
    )
    const unchanged = await q(
      `SELECT state, row_version::text AS row_version, released_by_actor_id, released_at
         FROM meta_recovery_archive_legal_holds WHERE id = $1::uuid`,
      [placed.holdId],
    )
    expect(unchanged.rows).toEqual([{
      state: 'active',
      row_version: '1',
      released_by_actor_id: null,
      released_at: null,
    }])

    const released = await releaseCommitted(placed)
    expect(released).toMatchObject({ state: 'released', rowVersion: '2' })
    const replay = await errorOf(releaseCommitted(placed))
    expect((replay as RecoveryArchiveLegalHoldError).code).toBe(
      'RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_STALE',
    )
  })

  test('direct raw release is refused; only the ordered helper CAS releases and clears its guard', async () => {
    const placed = await placeCommitted(generations[10] as string, 'raw_release_refusal')
    const raw = await errorOf(q(
      `UPDATE meta_recovery_archive_legal_holds
          SET state = 'released',
              released_by_actor_id = $2,
              released_at = clock_timestamp(),
              row_version = row_version + 1
        WHERE id = $1::uuid
          AND state = 'active'
          AND row_version = 1`,
      [placed.holdId, RELEASED_ACTOR],
    ))
    expect(raw.code).toBe('55000')
    expect(raw.message).toBe('recovery_archive_legal_hold_release_not_authorized')
    expectValuesFree(raw, [placed.holdId, placed.generationId, RELEASED_ACTOR, PREFIX])

    const released = await transaction(async (query) => {
      const snapshot = await releaseRecoveryArchiveLegalHold(query, {
        holdId: placed.holdId,
        workspaceId: placed.workspaceId,
        baseId: placed.baseId,
        sheetId: placed.sheetId,
        generationId: placed.generationId,
        expectedRowVersion: placed.rowVersion,
        releasedByActorId: RELEASED_ACTOR,
      })
      const guard = await query(
        `SELECT current_setting('metasheet.recovery_archive_legal_hold_release_hold', true) AS hold,
                current_setting('metasheet.recovery_archive_legal_hold_release_generation', true) AS generation`,
      )
      expect(guard.rows).toEqual([{ hold: '', generation: '' }])
      return snapshot
    })
    expect(released).toMatchObject({ state: 'released', rowVersion: '2' })
  })

  test('the direct-release rejection is carried by the row trigger', async () => {
    const placed = await placeCommitted(generations[11] as string, 'release_trigger')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'DROP TRIGGER trg_meta_recovery_archive_legal_hold_guard_row ON meta_recovery_archive_legal_holds',
      )
      const update = await client.query(
        `UPDATE meta_recovery_archive_legal_holds
            SET state = 'released',
                released_by_actor_id = $2,
                released_at = clock_timestamp(),
                row_version = row_version + 1
          WHERE id = $1::uuid`,
        [placed.holdId, RELEASED_ACTOR],
      )
      expect(update.rowCount).toBe(1)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  test('binding and audit identity are immutable and rows cannot be deleted', async () => {
    const placed = await placeCommitted(generations[3] as string, 'immutable')
    const update = await errorOf(q(
      `UPDATE meta_recovery_archive_legal_holds
          SET reason_code = 'LEGAL_CHANGED'
        WHERE id = $1::uuid`,
      [placed.holdId],
    ))
    expect(update.message).toBe('recovery_archive_legal_hold_immutable')
    const deletion = await errorOf(q(
      'DELETE FROM meta_recovery_archive_legal_holds WHERE id = $1::uuid',
      [placed.holdId],
    ))
    expect(deletion.message).toBe('recovery_archive_legal_hold_delete_not_authorized')
    const truncate = await errorOf(q('TRUNCATE TABLE meta_recovery_archive_legal_holds'))
    expect(truncate.message).toBe('recovery_archive_legal_hold_delete_not_authorized')
  })

  test('direct raw expiry is refused for both future and due generations', async () => {
    const future = await errorOf(q(
      `UPDATE meta_recovery_archives SET state = 'expired' WHERE generation_id = $1::uuid`,
      [generations[6]],
    ))
    expect(future.code).toBe('55000')
    expect(future.message).toBe('recovery_archive_expiry_not_authorized')
    expectValuesFree(future, [generations[6] as string, PREFIX])

    const due = await errorOf(q(
      `UPDATE meta_recovery_archives SET state = 'expired' WHERE generation_id = $1::uuid`,
      [generations[5]],
    ))
    expect(due.code).toBe('55000')
    expect(due.message).toBe('recovery_archive_expiry_not_authorized')
    expectValuesFree(due, [generations[5] as string, PREFIX])
  })

  test('an active hold blocks the due expiry helper after its ordered prefix', async () => {
    const generationId = generations[4] as string
    await placeCommitted(generationId, 'expiry_block')
    const refusal = await errorOf(expireCommitted(generationId))
    expect((refusal as RecoveryArchiveLegalHoldError).code).toBe(
      'RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_REFUSED',
    )
    expectValuesFree(refusal, [generationId, PREFIX])
    const state = await q(
      'SELECT state FROM meta_recovery_archives WHERE generation_id = $1::uuid',
      [generationId],
    )
    expect(state.rows).toEqual([{ state: 'verified' }])
  })

  test('only the due no-hold helper may expire and clears its transaction-local guard', async () => {
    const futureRefusal = await errorOf(expireCommitted(generations[6] as string))
    expect((futureRefusal as RecoveryArchiveLegalHoldError).code).toBe(
      'RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_REFUSED',
    )

    const generationId = generations[5] as string
    const placed = await placeCommitted(generationId, 'expiry_release')
    await releaseCommitted(placed)
    const expired = await transaction(async (query) => {
      const snapshot = await expireRecoveryArchiveAfterLegalHoldCheck(query, {
        workspaceId: WORKSPACE,
        baseId: BASE,
        sheetId: SHEET,
        generationId,
      })
      const guard = await query(
        `SELECT current_setting('metasheet.recovery_archive_expiry_generation', true) AS value`,
      )
      expect(guard.rows).toEqual([{ value: '' }])
      return snapshot
    })
    expect(expired).toMatchObject({ generationId, state: 'expired' })
    const state = await q(
      'SELECT state FROM meta_recovery_archives WHERE generation_id = $1::uuid',
      [generationId],
    )
    expect(state.rows).toEqual([{ state: 'expired' }])
  })

  test('the direct-expiry rejection is carried by the expiry trigger', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'DROP TRIGGER trg_meta_recovery_archives_legal_hold_expiry_guard_row ON meta_recovery_archives',
      )
      const update = await client.query(
        `UPDATE meta_recovery_archives SET state = 'expired' WHERE generation_id = $1::uuid`,
        [generations[8]],
      )
      expect(update.rowCount).toBe(1)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  test('malformed raw shape and helper refusals remain values-free', async () => {
    const generationId = generations[6] as string
    const sentinel = `${PREFIX}_sensitive_reason_text`
    const malformed = await errorOf(q(
      `INSERT INTO meta_recovery_archive_legal_holds (
         id, workspace_id, base_id, sheet_id, generation_id,
         state, reason_code, placed_by_actor_id, row_version
       ) VALUES ($1::uuid, $2, $3, $4, $5::uuid, 'active', NULL, $6, 1)`,
      [randomUUID(), WORKSPACE, BASE, SHEET, generationId, sentinel],
    ))
    expect(malformed.code).toBe('23514')
    expect(malformed.message).toBe('recovery_archive_legal_hold_shape_invalid')
    expectValuesFree(malformed, [generationId, sentinel, WORKSPACE, BASE, SHEET])

    const invalid = await errorOf(transaction((query) => placeRecoveryArchiveLegalHold(query, {
      ...placeInput(generationId, 'values_free'),
      reasonCode: sentinel,
    })))
    expect((invalid as RecoveryArchiveLegalHoldError).code).toBe(
      'RECOVERY_ARCHIVE_LEGAL_HOLD_INVALID_INPUT',
    )
    expectValuesFree(invalid, [generationId, sentinel])
  })

  test('placement parks on the active key before acquiring the generation', async () => {
    const generationId = generations[7] as string
    const keyHolder = await pool.connect()
    const placer = await pool.connect()
    const generationProbe = await pool.connect()
    let placementPromise: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined
    try {
      await keyHolder.query('BEGIN')
      const keyHolderPid = await backendPid(keyHolder)
      await keyHolder.query(
        'SELECT 1 FROM meta_recovery_archive_keys WHERE key_id = $1 FOR UPDATE',
        [KEY_ID],
      )

      await placer.query('BEGIN')
      const placerPid = await backendPid(placer)
      placementPromise = placeRecoveryArchiveLegalHold(
        (text, values) => placer.query(text, values),
        placeInput(generationId, 'lock_order'),
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      await waitForBlockedBy(placerPid, keyHolderPid)

      await generationProbe.query('BEGIN')
      await generationProbe.query(
        `SELECT 1 FROM meta_recovery_archives
          WHERE generation_id = $1::uuid FOR UPDATE NOWAIT`,
        [generationId],
      )
      await generationProbe.query('ROLLBACK')

      await keyHolder.query('ROLLBACK')
      const outcome = await placementPromise
      if (!outcome.ok) throw outcome.error
      await placer.query('ROLLBACK')
    } catch (error) {
      await generationProbe.query('ROLLBACK').catch(() => {})
      await keyHolder.query('ROLLBACK').catch(() => {})
      await placer.query('ROLLBACK').catch(() => {})
      if (placementPromise) await placementPromise
      throw error
    } finally {
      generationProbe.release()
      placer.release()
      keyHolder.release()
    }
  }, 15_000)

  test('release DB authority parks on the active key before acquiring the generation', async () => {
    const generationId = generations[7] as string
    const placed = await placeCommitted(generationId, 'release_lock_order')
    const keyHolder = await pool.connect()
    const releaser = await pool.connect()
    const generationProbe = await pool.connect()
    let authorization: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined
    try {
      await keyHolder.query('BEGIN')
      const keyHolderPid = await backendPid(keyHolder)
      await keyHolder.query(
        'SELECT 1 FROM meta_recovery_archive_keys WHERE key_id = $1 FOR UPDATE',
        [KEY_ID],
      )

      await releaser.query('BEGIN')
      const releaserPid = await backendPid(releaser)
      authorization = releaser.query(
        `SELECT public.meta_recovery_archive_legal_hold_release_authorize(
           $1::uuid, $2::uuid, $3, $4, $5, $6::bigint
         )`,
        [placed.holdId, generationId, WORKSPACE, BASE, SHEET, placed.rowVersion],
      ).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      await waitForBlockedBy(releaserPid, keyHolderPid)

      await generationProbe.query('BEGIN')
      await generationProbe.query(
        `SELECT 1 FROM meta_recovery_archives
          WHERE generation_id = $1::uuid FOR UPDATE NOWAIT`,
        [generationId],
      )
      await generationProbe.query('ROLLBACK')

      await keyHolder.query('ROLLBACK')
      const outcome = await authorization
      if (!outcome.ok) throw outcome.error
      await releaser.query('ROLLBACK')
    } catch (error) {
      await generationProbe.query('ROLLBACK').catch(() => {})
      await keyHolder.query('ROLLBACK').catch(() => {})
      await releaser.query('ROLLBACK').catch(() => {})
      if (authorization) await authorization
      throw error
    } finally {
      generationProbe.release()
      releaser.release()
      keyHolder.release()
    }
  }, 15_000)

  test('place and release changes roll back with their caller transaction', async () => {
    const placeGeneration = generations[8] as string
    const releaseGeneration = generations[9] as string
    const placer = await pool.connect()
    try {
      await placer.query('BEGIN')
      await placeRecoveryArchiveLegalHold(
        (text, values) => placer.query(text, values),
        placeInput(placeGeneration, 'rollback_place'),
      )
      await placer.query('ROLLBACK')
    } finally {
      placer.release()
    }
    const absent = await q(
      'SELECT count(*)::int AS count FROM meta_recovery_archive_legal_holds WHERE generation_id = $1::uuid',
      [placeGeneration],
    )
    expect(absent.rows).toEqual([{ count: 0 }])

    const placed = await placeCommitted(releaseGeneration, 'rollback_release')
    const releaser = await pool.connect()
    try {
      await releaser.query('BEGIN')
      await releaseRecoveryArchiveLegalHold((text, values) => releaser.query(text, values), {
        holdId: placed.holdId,
        workspaceId: placed.workspaceId,
        baseId: placed.baseId,
        sheetId: placed.sheetId,
        generationId: placed.generationId,
        expectedRowVersion: placed.rowVersion,
        releasedByActorId: RELEASED_ACTOR,
      })
      await releaser.query('ROLLBACK')
    } finally {
      releaser.release()
    }
    const active = await q(
      `SELECT state, row_version::text AS row_version
         FROM meta_recovery_archive_legal_holds WHERE id = $1::uuid`,
      [placed.holdId],
    )
    expect(active.rows).toEqual([{ state: 'active', row_version: '1' }])
  })

  test('development down refuses the retained nonempty hold surface', async () => {
    const refusal = await errorOf(legalHoldMigration.down(db))
    expect(refusal.code).toBe('55000')
    expect(refusal.message).toBe('recovery_archive_legal_hold_nonempty')
    expect(await authorityFingerprint()).toBe(initialFingerprint)
  })
})
