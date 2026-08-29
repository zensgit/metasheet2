import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import * as operationBindingMigration from '../../src/db/migrations/zzzz20260826122500_add_operation_binding_to_nonrecord_history'
import {
  sweepConfigRevisionRetention,
  sweepFieldValueTombstoneRetention,
  sweepLinkTombstoneRetention,
  sweepMetaRevisionRetention,
  type MetaRevisionRetentionConfig,
} from '../../src/multitable/meta-revision-retention'

const runRealDb = Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeIfRealDbStep = runRealDb ? describe : describe.skip

test('sentinel: the D2d1 real-DB allowlist step must provide DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('operation_binding_realdb_harness_missing_database_url')
  }
})

const RUN = randomUUID().replaceAll('-', '').slice(0, 16)
const PREFIX = `tm_d2d1_${RUN}`
const WORKSPACE = `${PREFIX}_workspace`
const BASE = `${PREFIX}_base`
const OTHER_BASE = `${PREFIX}_other_base`
const SHEET = `${PREFIX}_sheet`
const OTHER_SHEET = `${PREFIX}_other_sheet`
const SEQ = '9007199254745001'
const OTHER_SEQ = '9007199254745002'

const TABLES = ['meta_config_revisions', 'meta_field_value_tombstones', 'meta_link_tombstones'] as const
const FUNCTIONS = ['meta_nonrecord_history_operation_binding_guard_row'] as const
const INDEXES = [
  'idx_meta_config_revisions_operation',
  'idx_meta_field_value_tombstones_operation',
  'idx_meta_link_tombstones_operation',
] as const
const CONSTRAINTS = ['fk_mcr_operation', 'fk_mfvt_operation', 'fk_mlt_operation'] as const
const GUARD_TRIGGERS = [
  'trg_mcr_operation_binding_immutable',
  'trg_mfvt_operation_binding_immutable',
  'trg_mlt_operation_binding_immutable',
] as const
const APPEND_TRIGGERS = [
  'trg_mcr_reject_append_sealed',
  'trg_mfvt_reject_append_sealed',
  'trg_mlt_reject_append_sealed',
] as const
const TRIGGERS = [...GUARD_TRIGGERS, ...APPEND_TRIGGERS] as const
const EXPECTED_FK_DEF =
  'FOREIGN KEY (sheet_id, operation_id) REFERENCES meta_record_history_operations(sheet_id, operation_id) DEFERRABLE INITIALLY DEFERRED'

type DatabaseError = Error & {
  code?: string
  constraint?: string
  detail?: string
  where?: string
}

let pool: Pool
let db: Kysely<unknown>
let schemaIsUp = false
let initialFingerprint = ''

const q = (text: string, values?: unknown[]) => pool.query(text, values)

async function errorOf(promise: Promise<unknown>): Promise<DatabaseError> {
  try {
    await promise
  } catch (error) {
    return error as DatabaseError
  }
  throw new Error('expected_database_rejection')
}

function expectValuesFree(error: DatabaseError, forbiddenValues: string[]): void {
  const rendered = [error.message, error.detail, error.where].filter(Boolean).join(' ')
  for (const value of forbiddenValues) expect(rendered).not.toContain(value)
}

async function withTxn<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function bindingFingerprint(): Promise<string> {
  const result = await q(
    `SELECT md5(string_agg(definition, '|' ORDER BY definition)) AS fingerprint
       FROM (
         SELECT concat_ws('|', 'column', table_name, column_name, data_type, udt_name, is_nullable)::text AS definition
           FROM information_schema.columns
          WHERE table_schema='public' AND table_name = ANY($1::text[])
            AND column_name='operation_id'
         UNION ALL
         SELECT concat_ws('|', 'constraint', relation.relname, constraint_row.conname,
                          constraint_row.condeferrable::text, constraint_row.condeferred::text,
                          pg_get_constraintdef(constraint_row.oid, true))
           FROM pg_constraint constraint_row
           JOIN pg_class relation ON relation.oid=constraint_row.conrelid
           JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname='public'
            AND relation.relname = ANY($1::text[])
            AND constraint_row.conname = ANY($2::text[])
         UNION ALL
         SELECT concat_ws('|', 'index', tablename, indexname, indexdef)
           FROM pg_indexes
          WHERE schemaname='public'
            AND tablename = ANY($1::text[])
            AND indexname = ANY($3::text[])
         UNION ALL
         SELECT concat_ws('|', 'trigger', relation.relname, trigger_row.tgname, pg_get_triggerdef(trigger_row.oid, true))
           FROM pg_trigger trigger_row
           JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
           JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname='public' AND NOT trigger_row.tgisinternal
            AND relation.relname = ANY($1::text[])
            AND trigger_row.tgname = ANY($4::text[])
         UNION ALL
         SELECT concat_ws('|', 'function', procedure_row.proname, pg_get_functiondef(procedure_row.oid))
           FROM pg_proc procedure_row
           JOIN pg_namespace namespace ON namespace.oid=procedure_row.pronamespace
          WHERE namespace.nspname='public' AND procedure_row.proname = ANY($5::text[])
         UNION ALL
         SELECT concat_ws('|', 'inherited-function', procedure_row.proname,
                          procedure_row.proconfig::text, pg_get_functiondef(procedure_row.oid))
           FROM pg_proc procedure_row
           JOIN pg_namespace namespace ON namespace.oid=procedure_row.pronamespace
          WHERE namespace.nspname='public'
            AND procedure_row.proname='meta_record_reject_append_to_sealed_operation'
       ) catalog_rows`,
    [[...TABLES], [...CONSTRAINTS], [...INDEXES], [...TRIGGERS], [...FUNCTIONS]],
  )
  return String(result.rows[0]?.fingerprint ?? '')
}

async function ownedSurface() {
  const columns = await q(
    `SELECT table_name, column_name, udt_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name = ANY($1::text[]) AND column_name='operation_id'
      ORDER BY table_name`,
    [[...TABLES]],
  )
  const indexes = await q(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname='public' AND indexname = ANY($1::text[])
      ORDER BY indexname`,
    [[...INDEXES]],
  )
  const fks = await q(
    `SELECT relation.relname, constraint_row.conname, constraint_row.condeferrable, constraint_row.condeferred,
            pg_get_constraintdef(constraint_row.oid, true) AS definition
       FROM pg_constraint constraint_row
       JOIN pg_class relation ON relation.oid=constraint_row.conrelid
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='public'
        AND relation.relname = ANY($1::text[])
        AND constraint_row.conname = ANY($2::text[])
      ORDER BY constraint_row.conname`,
    [[...TABLES], [...CONSTRAINTS]],
  )
  const triggers = await q(
    `SELECT trigger_row.tgname
       FROM pg_trigger trigger_row
       JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='public' AND NOT trigger_row.tgisinternal
        AND trigger_row.tgname = ANY($1::text[])
      ORDER BY trigger_row.tgname`,
    [[...TRIGGERS]],
  )
  const functions = await q(
    `SELECT procedure_row.proname
       FROM pg_proc procedure_row
       JOIN pg_namespace namespace ON namespace.oid=procedure_row.pronamespace
      WHERE namespace.nspname='public' AND procedure_row.proname = ANY($1::text[])`,
    [[...FUNCTIONS]],
  )
  return {
    columns: columns.rows,
    indexes: indexes.rows,
    fks: fks.rows,
    triggers: triggers.rows,
    functions: functions.rows,
  }
}

async function installIfAbsent(): Promise<void> {
  const present = await q(
    `SELECT count(*)::int AS count
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name = ANY($1::text[]) AND column_name='operation_id'`,
    [[...TABLES]],
  )
  const count = Number(present.rows[0]?.count ?? 0)
  if (count === 0) await operationBindingMigration.up(db)
  else if (count !== TABLES.length) throw new Error('operation_binding_partial_schema')
  schemaIsUp = true
}

async function insertRecordRevision(
  client: PoolClient,
  sheetId: string,
  operationId: string,
  seq: string,
  recordId = `${sheetId}_record`,
  version = 1,
): Promise<void> {
  await client.query(
    `INSERT INTO meta_record_revisions (
       id, sheet_id, record_id, version, action, source,
       changed_field_ids, patch, snapshot, seq, operation_id
     ) VALUES ($1::uuid, $2, $3, $4, 'create', 'rest', ARRAY[]::text[], '{}'::jsonb,
               '{}'::jsonb, $5::bigint, $6::uuid)`,
    [randomUUID(), sheetId, recordId, version, seq, operationId],
  )
}

async function sealOrdinary(
  client: PoolClient,
  sheetId: string,
  operationId: string,
  seq: string,
  recordId?: string,
): Promise<void> {
  await insertRecordRevision(client, sheetId, operationId, seq, recordId)
  await client.query(
    `INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count)
     VALUES ($1, $2::uuid, $3::bigint, 1)`,
    [sheetId, operationId, seq],
  )
}

async function insertConfig(
  client: PoolClient,
  sheetId: string,
  operationId: string | null,
  entityId = `${sheetId}_field`,
): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO meta_config_revisions (id, sheet_id, entity_type, entity_id, action, after, operation_id)
     VALUES ($1::uuid, $2, 'field', $3, 'update', '{"ok":true}'::jsonb, $4::uuid)`,
    [id, sheetId, entityId, operationId],
  )
  return id
}

async function insertFieldTombstone(
  client: PoolClient,
  sheetId: string,
  operationId: string | null,
  options: { recordId?: string; configRevisionId?: string; createdAtSql?: string } = {},
): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO meta_field_value_tombstones (
       id, sheet_id, field_id, record_id, value, reason, config_revision_id, operation_id, created_at
     ) VALUES (
       $1::uuid, $2, $3, $4, '{"n":1}'::jsonb, 'field_delete', $5::uuid, $6::uuid,
       ${options.createdAtSql ?? 'now()'}
     )`,
    [
      id,
      sheetId,
      `${sheetId}_field`,
      options.recordId ?? `${sheetId}_record`,
      options.configRevisionId ?? null,
      operationId,
    ],
  )
  return id
}

async function insertLinkTombstone(
  client: PoolClient,
  sheetId: string,
  operationId: string | null,
  options: { recordId?: string; sourceRevisionId?: string; createdAtSql?: string } = {},
): Promise<string> {
  const id = randomUUID()
  await client.query(
    `INSERT INTO meta_link_tombstones (
       id, sheet_id, field_id, record_id, foreign_record_id, reason, source_revision_id, operation_id, created_at
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, 'record_delete', $6::uuid, $7::uuid,
       ${options.createdAtSql ?? 'now()'}
     )`,
    [
      id,
      sheetId,
      `${sheetId}_link`,
      options.recordId ?? `${sheetId}_record`,
      `${sheetId}_foreign`,
      options.sourceRevisionId ?? null,
      operationId,
    ],
  )
  return id
}

async function cleanupSheetRows(): Promise<void> {
  if (!schemaIsUp) return
  await withTxn(async (client) => {
    await client.query(`SELECT set_config('metasheet.mrho_retention', 'on', true)`)
    await client.query(`DELETE FROM meta_config_revisions WHERE sheet_id = ANY($1::text[])`, [[SHEET, OTHER_SHEET]])
    await client.query(`DELETE FROM meta_field_value_tombstones WHERE sheet_id = ANY($1::text[])`, [
      [SHEET, OTHER_SHEET],
    ])
    await client.query(`DELETE FROM meta_link_tombstones WHERE sheet_id = ANY($1::text[])`, [[SHEET, OTHER_SHEET]])
    await client.query(`DELETE FROM meta_sheet_section_revisions WHERE sheet_id = ANY($1::text[])`, [
      [SHEET, OTHER_SHEET],
    ]).catch(() => {})
    await client.query(`DELETE FROM meta_record_history_snapshot_members WHERE sheet_id = ANY($1::text[])`, [
      [SHEET, OTHER_SHEET],
    ]).catch(() => {})
    await client.query(`DELETE FROM meta_record_history_operation_members WHERE sheet_id = ANY($1::text[])`, [
      [SHEET, OTHER_SHEET],
    ]).catch(() => {})
    await client.query(`DELETE FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])`, [[SHEET, OTHER_SHEET]])
    await client.query(`DELETE FROM meta_record_version_markers WHERE sheet_id = ANY($1::text[])`, [
      [SHEET, OTHER_SHEET],
    ])
    await client.query(`DELETE FROM meta_record_history_operations WHERE sheet_id = ANY($1::text[])`, [
      [SHEET, OTHER_SHEET],
    ])
  })
}

const sweepConfig = (cfg: Partial<MetaRevisionRetentionConfig> = {}): MetaRevisionRetentionConfig => ({
  enabled: true,
  policy: 'keep-last-n',
  keepN: 10,
  retentionDays: 30,
  batchSize: 5000,
  ...cfg,
})

describeIfRealDbStep('Phase D2d1 non-record operation binding (real DB)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    await installIfAbsent()
    initialFingerprint = await bindingFingerprint()

    await q(`INSERT INTO meta_bases (id, name, workspace_id) VALUES ($1, $2, $3), ($4, $5, $6)`, [
      BASE,
      `${PREFIX} Base`,
      WORKSPACE,
      OTHER_BASE,
      `${PREFIX} Other Base`,
      `${PREFIX}_other_workspace`,
    ])
    await q(`INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3), ($4, $5, $6)`, [
      SHEET,
      BASE,
      `${PREFIX} Sheet`,
      OTHER_SHEET,
      OTHER_BASE,
      `${PREFIX} Other Sheet`,
    ])
  })

  test('the exact real-DB allowlist marker and database are active', () => {
    expect(process.env.METASHEET_REAL_DB_TEST_STEP).toBe('1')
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  afterEach(async () => {
    await cleanupSheetRows()
  })

  afterAll(async () => {
    try {
      await cleanupSheetRows()
      await q(`DELETE FROM meta_sheets WHERE id = ANY($1::text[])`, [[SHEET, OTHER_SHEET]]).catch(() => {})
      await q(`DELETE FROM meta_bases WHERE id = ANY($1::text[])`, [[BASE, OTHER_BASE]]).catch(() => {})
    } finally {
      if (!schemaIsUp) {
        await operationBindingMigration.up(db).catch(() => {})
        schemaIsUp = true
      }
      await db.destroy()
    }
  })

  test('nullable uuid columns, plain (sheet_id, operation_id) indexes, and exact deferred FKs', async () => {
    const surface = await ownedSurface()
    expect(surface.columns).toEqual([
      { table_name: 'meta_config_revisions', column_name: 'operation_id', udt_name: 'uuid', is_nullable: 'YES' },
      { table_name: 'meta_field_value_tombstones', column_name: 'operation_id', udt_name: 'uuid', is_nullable: 'YES' },
      { table_name: 'meta_link_tombstones', column_name: 'operation_id', udt_name: 'uuid', is_nullable: 'YES' },
    ])
    expect(surface.indexes.map((row) => row.indexname)).toEqual([...INDEXES].sort())
    for (const row of surface.indexes as Array<{ indexdef: string }>) {
      expect(row.indexdef).toMatch(/USING btree \(sheet_id, operation_id\)$/)
      expect(row.indexdef).not.toContain('WHERE')
      expect(row.indexdef).not.toContain('UNIQUE')
    }
    const triggerDefs = await q(
      `SELECT relation.relname, trigger_row.tgname, pg_get_triggerdef(trigger_row.oid, true) AS definition,
              procedure_row.proname
         FROM pg_trigger trigger_row
         JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
         JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
         JOIN pg_proc procedure_row ON procedure_row.oid=trigger_row.tgfoid
        WHERE namespace.nspname='public' AND NOT trigger_row.tgisinternal
          AND relation.relname = ANY($1::text[])
          AND trigger_row.tgname = ANY($2::text[])
        ORDER BY trigger_row.tgname`,
      [[...TABLES], [...TRIGGERS]],
    )
    expect(triggerDefs.rows).toHaveLength(6)
    for (const row of triggerDefs.rows as Array<{ tgname: string; definition: string; proname: string }>) {
      if ((GUARD_TRIGGERS as readonly string[]).includes(row.tgname)) {
        expect(row.definition).toContain('BEFORE DELETE OR UPDATE')
        expect(row.proname).toBe('meta_nonrecord_history_operation_binding_guard_row')
      } else {
        expect(row.definition).toContain('BEFORE INSERT')
        expect(row.proname).toBe('meta_record_reject_append_to_sealed_operation')
      }
    }
    expect(surface.fks).toEqual([
      {
        relname: 'meta_config_revisions',
        conname: 'fk_mcr_operation',
        condeferrable: true,
        condeferred: true,
        definition: EXPECTED_FK_DEF,
      },
      {
        relname: 'meta_field_value_tombstones',
        conname: 'fk_mfvt_operation',
        condeferrable: true,
        condeferred: true,
        definition: EXPECTED_FK_DEF,
      },
      {
        relname: 'meta_link_tombstones',
        conname: 'fk_mlt_operation',
        condeferrable: true,
        condeferred: true,
        definition: EXPECTED_FK_DEF,
      },
    ])
    expect(surface.triggers.map((row) => row.tgname)).toEqual([...TRIGGERS].sort())
    expect(surface.functions).toEqual([{ proname: 'meta_nonrecord_history_operation_binding_guard_row' }])
    const appendFunction = await q(
      `SELECT procedure_row.proconfig
         FROM pg_proc procedure_row
         JOIN pg_namespace namespace ON namespace.oid=procedure_row.pronamespace
        WHERE namespace.nspname='public'
          AND procedure_row.proname='meta_record_reject_append_to_sealed_operation'
          AND pg_get_function_identity_arguments(procedure_row.oid)=''`,
    )
    expect(appendFunction.rows).toEqual([{ proconfig: ['search_path=pg_catalog, public'] }])
  })

  test('child-before-parent in one transaction commits; a child that never seals fails at COMMIT', async () => {
    const operationId = randomUUID()
    await withTxn(async (client) => {
      await insertConfig(client, SHEET, operationId)
      await insertFieldTombstone(client, SHEET, operationId)
      await insertLinkTombstone(client, SHEET, operationId)
      await sealOrdinary(client, SHEET, operationId, SEQ)
    })
    const counts = await q(
      `SELECT
         (SELECT count(*)::int FROM meta_config_revisions WHERE operation_id=$1::uuid) AS config_count,
         (SELECT count(*)::int FROM meta_field_value_tombstones WHERE operation_id=$1::uuid) AS field_count,
         (SELECT count(*)::int FROM meta_link_tombstones WHERE operation_id=$1::uuid) AS link_count,
         (SELECT count(*)::int FROM meta_record_history_operations WHERE operation_id=$1::uuid) AS endpoint_count`,
      [operationId],
    )
    expect(counts.rows).toEqual([{ config_count: 1, field_count: 1, link_count: 1, endpoint_count: 1 }])

    const afterSeal = await errorOf(
      q(
        `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, after, operation_id)
         VALUES ($1, 'field', $2, 'update', '{"ok":true}'::jsonb, $3::uuid)`,
        [SHEET, `${SHEET}_after_seal`, operationId],
      ),
    )
    expect(afterSeal.code).toBe('23514')
    expect(afterSeal.message).toMatch(/sealed operation/)
    expectValuesFree(afterSeal, [SHEET, operationId])

    await q(
      `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, after)
       VALUES ($1, 'field', $2, 'update', '{"ok":true}'::jsonb)`,
      [SHEET, `${SHEET}_after_seal_null`],
    )

    const dangling = randomUUID()
    const refusal = await errorOf(
      withTxn(async (client) => {
        await insertConfig(client, SHEET, dangling)
      }),
    )
    expect(refusal.code).toBe('23503')
    expect(refusal.constraint).toBe('fk_mcr_operation')
    expect(
      Number(
        ((await q('SELECT count(*)::int AS n FROM meta_config_revisions WHERE operation_id=$1::uuid', [dangling]))
          .rows[0] as { n: number }).n,
      ),
    ).toBe(0)
  })

  test('parent-FK deferrability is load-bearing for child-before-parent', async () => {
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          ALTER TABLE public.meta_config_revisions DROP CONSTRAINT fk_mcr_operation
        `.execute(trx)
        await sql`
          ALTER TABLE public.meta_config_revisions
            ADD CONSTRAINT fk_mcr_operation
            FOREIGN KEY (sheet_id, operation_id)
            REFERENCES public.meta_record_history_operations (sheet_id, operation_id)
        `.execute(trx)
        await sql`
          INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, after, operation_id)
          VALUES (${SHEET}, 'field', ${`${SHEET}_drift`}, 'update', '{"ok":true}'::jsonb, ${randomUUID()}::uuid)
        `.execute(trx)
        throw new Error('operation_binding_parent_fk_deferrability_missing')
      }),
    )
    expect(refusal.code).toBe('23503')
    expect(await bindingFingerprint()).toBe(initialFingerprint)
  })

  test('append-after-seal triggers are load-bearing', async () => {
    const operationId = randomUUID()
    const sentinel = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`DROP TRIGGER trg_mcr_reject_append_sealed ON public.meta_config_revisions`.execute(trx)
        await sql`
          INSERT INTO meta_record_revisions (
            id, sheet_id, record_id, version, action, source,
            changed_field_ids, patch, snapshot, seq, operation_id
          ) VALUES (
            ${randomUUID()}::uuid, ${SHEET}, ${`${SHEET}_append`}, 1, 'create', 'rest',
            ARRAY[]::text[], '{}'::jsonb, '{}'::jsonb, ${SEQ}::bigint, ${operationId}::uuid
          )
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count)
          VALUES (${SHEET}, ${operationId}::uuid, ${SEQ}::bigint, 1)
        `.execute(trx)
        await sql`
          INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, after, operation_id)
          VALUES (${SHEET}, 'field', ${`${SHEET}_append_late`}, 'update', '{"ok":true}'::jsonb, ${operationId}::uuid)
        `.execute(trx)
        throw new Error('operation_binding_append_after_seal_missing')
      }),
    )
    expect(sentinel.message).toBe('operation_binding_append_after_seal_missing')
    expect(await bindingFingerprint()).toBe(initialFingerprint)
  })

  test('append-after-seal lookup cannot be redirected through the caller search_path', async () => {
    const shadowSchema = `${PREFIX}_shadow`
    const operationId = randomUUID()
    const refusal = await errorOf(
      withTxn(async (client) => {
        await client.query(`CREATE SCHEMA ${shadowSchema}`)
        await client.query(
          `CREATE TABLE ${shadowSchema}.meta_record_history_operations (
             sheet_id text NOT NULL,
             operation_id uuid NOT NULL
           )`,
        )
        await sealOrdinary(client, SHEET, operationId, SEQ)
        await client.query(`SET LOCAL search_path = ${shadowSchema}, public`)
        await insertConfig(client, SHEET, operationId, `${SHEET}_shadow_append`)
      }),
    )
    expect(refusal.code).toBe('23514')
    expect(refusal.message).toMatch(/sealed operation/)
    expectValuesFree(refusal, [SHEET, operationId])
    expect(await bindingFingerprint()).toBe(initialFingerprint)
  })

  test('cross-sheet operation_id is refused at COMMIT', async () => {
    const operationId = randomUUID()
    await withTxn(async (client) => {
      await sealOrdinary(client, SHEET, operationId, SEQ)
    })
    const refusal = await errorOf(
      withTxn(async (client) => {
        await insertConfig(client, OTHER_SHEET, operationId)
      }),
    )
    expect(refusal.code).toBe('23503')
    expect(refusal.constraint).toBe('fk_mcr_operation')
  })

  test('BEFORE UPDATE forbids changing or backfilling a binding and allows unrelated column updates', async () => {
    const operationId = randomUUID()
    let configId = ''
    let fieldId = ''
    let untaggedId = ''
    await withTxn(async (client) => {
      configId = await insertConfig(client, SHEET, operationId)
      fieldId = await insertFieldTombstone(client, SHEET, operationId)
      untaggedId = await insertConfig(client, SHEET, null, `${SHEET}_untagged`)
      await sealOrdinary(client, SHEET, operationId, SEQ)
    })

    const change = await errorOf(
      q(`UPDATE meta_config_revisions SET operation_id=$1::uuid WHERE id=$2::uuid`, [randomUUID(), configId]),
    )
    expect(change.message).toBe('operation_binding_immutable')
    expectValuesFree(change, [SHEET, WORKSPACE, BASE, operationId, configId])

    const clear = await errorOf(
      q(`UPDATE meta_field_value_tombstones SET operation_id=NULL WHERE id=$1::uuid`, [fieldId]),
    )
    expect(clear.message).toBe('operation_binding_immutable')

    const backfill = await errorOf(
      q(`UPDATE meta_config_revisions SET operation_id=$1::uuid WHERE id=$2::uuid`, [operationId, untaggedId]),
    )
    expect(backfill.message).toBe('operation_binding_immutable')

    await q(`UPDATE meta_config_revisions SET after='{"ok":false}'::jsonb WHERE id=$1::uuid`, [configId])
    await q(`UPDATE meta_field_value_tombstones SET value='{"n":2}'::jsonb WHERE id=$1::uuid`, [fieldId])
    const after = await q(
      `SELECT
         (SELECT after->>'ok' FROM meta_config_revisions WHERE id=$1::uuid) AS config_after,
         (SELECT value->>'n' FROM meta_field_value_tombstones WHERE id=$2::uuid) AS field_value,
         (SELECT operation_id::text FROM meta_config_revisions WHERE id=$3::uuid) AS untagged_binding`,
      [configId, fieldId, untaggedId],
    )
    expect(after.rows).toEqual([{ config_after: 'false', field_value: '2', untagged_binding: null }])

    const taggedSheetMove = await errorOf(
      q(`UPDATE meta_config_revisions SET sheet_id=$1 WHERE id=$2::uuid`, [OTHER_SHEET, configId]),
    )
    expect(taggedSheetMove.message).toBe('operation_binding_immutable')
    expectValuesFree(taggedSheetMove, [SHEET, OTHER_SHEET, WORKSPACE, BASE, operationId, configId])

    await q(`UPDATE meta_config_revisions SET sheet_id=$1 WHERE id=$2::uuid`, [OTHER_SHEET, untaggedId])
    expect(
      String(
        ((await q('SELECT sheet_id FROM meta_config_revisions WHERE id=$1::uuid', [untaggedId])).rows[0] as { sheet_id: string })
          .sheet_id,
      ),
    ).toBe(OTHER_SHEET)
  })

  test('tagged sheet_id guard is load-bearing', async () => {
    const operationId = randomUUID()
    const sentinel = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          CREATE OR REPLACE FUNCTION public.meta_nonrecord_history_operation_binding_guard_row()
          RETURNS trigger
          LANGUAGE plpgsql
          SET search_path = pg_catalog, public
          AS $fn$
          BEGIN
            IF TG_OP = 'DELETE' THEN
              IF OLD.operation_id IS NOT NULL
                 AND current_setting('metasheet.mrho_retention', true) IS DISTINCT FROM 'on' THEN
                RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'operation_binding_tagged_delete_forbidden';
              END IF;
              RETURN OLD;
            END IF;
            IF NEW.operation_id IS DISTINCT FROM OLD.operation_id THEN
              RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'operation_binding_immutable';
            END IF;
            RETURN NEW;
          END;
          $fn$
        `.execute(trx)
        await sql`
          INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, after, operation_id)
          VALUES (${SHEET}, 'field', ${`${SHEET}_sheet_move`}, 'update', '{"ok":true}'::jsonb, ${operationId}::uuid)
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_revisions (
            id, sheet_id, record_id, version, action, source,
            changed_field_ids, patch, snapshot, seq, operation_id
          ) VALUES (
            ${randomUUID()}::uuid, ${SHEET}, ${`${SHEET}_sheet_move`}, 1, 'create', 'rest',
            ARRAY[]::text[], '{}'::jsonb, '{}'::jsonb, ${SEQ}::bigint, ${operationId}::uuid
          )
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count)
          VALUES (${SHEET}, ${operationId}::uuid, ${SEQ}::bigint, 1)
        `.execute(trx)
        await sql`
          UPDATE meta_config_revisions SET sheet_id = ${OTHER_SHEET}
           WHERE operation_id = ${operationId}::uuid
        `.execute(trx)
        throw new Error('operation_binding_tagged_sheet_guard_missing')
      }),
    )
    expect(sentinel.message).toBe('operation_binding_tagged_sheet_guard_missing')
    expect(await bindingFingerprint()).toBe(initialFingerprint)
  })

  test('tagged DELETE is forbidden without the retention GUC and allowed with it; untagged DELETE stays ordinary', async () => {
    // D1: only the whole-operation path may remove tagged rows. The ordinary-sweep
    // operation_id IS NULL predicate is application SQL; the deferred FK only
    // protects parent-delete-with-children. This GUC-gated BEFORE DELETE is the
    // DB half, using the existing metasheet.mrho_retention exception so D2d2 can
    // extend prune without a second flag.
    const operationId = randomUUID()
    let taggedConfigId = ''
    let taggedFieldId = ''
    let taggedLinkId = ''
    let untaggedConfigId = ''
    await withTxn(async (client) => {
      taggedConfigId = await insertConfig(client, SHEET, operationId)
      taggedFieldId = await insertFieldTombstone(client, SHEET, operationId)
      taggedLinkId = await insertLinkTombstone(client, SHEET, operationId)
      untaggedConfigId = await insertConfig(client, SHEET, null, `${SHEET}_untagged_del`)
      await sealOrdinary(client, SHEET, operationId, SEQ)
    })

    const taggedConfigDelete = await errorOf(
      q(`DELETE FROM meta_config_revisions WHERE id=$1::uuid`, [taggedConfigId]),
    )
    expect(taggedConfigDelete.message).toBe('operation_binding_tagged_delete_forbidden')
    expectValuesFree(taggedConfigDelete, [SHEET, WORKSPACE, BASE, operationId, taggedConfigId])

    const taggedFieldDelete = await errorOf(
      q(`DELETE FROM meta_field_value_tombstones WHERE id=$1::uuid`, [taggedFieldId]),
    )
    expect(taggedFieldDelete.message).toBe('operation_binding_tagged_delete_forbidden')

    const taggedLinkDelete = await errorOf(
      q(`DELETE FROM meta_link_tombstones WHERE id=$1::uuid`, [taggedLinkId]),
    )
    expect(taggedLinkDelete.message).toBe('operation_binding_tagged_delete_forbidden')

    await q(`DELETE FROM meta_config_revisions WHERE id=$1::uuid`, [untaggedConfigId])
    expect(
      Number(
        ((await q('SELECT count(*)::int AS n FROM meta_config_revisions WHERE id=$1::uuid', [untaggedConfigId]))
          .rows[0] as { n: number }).n,
      ),
    ).toBe(0)

    await withTxn(async (client) => {
      await client.query(`SELECT set_config('metasheet.mrho_retention', 'on', true)`)
      await client.query(`DELETE FROM meta_config_revisions WHERE id=$1::uuid`, [taggedConfigId])
      await client.query(`DELETE FROM meta_field_value_tombstones WHERE id=$1::uuid`, [taggedFieldId])
      await client.query(`DELETE FROM meta_link_tombstones WHERE id=$1::uuid`, [taggedLinkId])
    })
    const remaining = await q(
      `SELECT
         (SELECT count(*)::int FROM meta_config_revisions WHERE id=$1::uuid) AS config_count,
         (SELECT count(*)::int FROM meta_field_value_tombstones WHERE id=$2::uuid) AS field_count,
         (SELECT count(*)::int FROM meta_link_tombstones WHERE id=$3::uuid) AS link_count,
         (SELECT count(*)::int FROM meta_record_history_operations WHERE operation_id=$4::uuid) AS endpoint_count`,
      [taggedConfigId, taggedFieldId, taggedLinkId, operationId],
    )
    expect(remaining.rows).toEqual([{ config_count: 0, field_count: 0, link_count: 0, endpoint_count: 1 }])
  })

  test('tagged DELETE GUC exception is load-bearing', async () => {
    const operationId = randomUUID()
    const sentinel = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          CREATE OR REPLACE FUNCTION public.meta_nonrecord_history_operation_binding_guard_row()
          RETURNS trigger
          LANGUAGE plpgsql
          SET search_path = pg_catalog, public
          AS $fn$
          BEGIN
            IF TG_OP = 'DELETE' THEN
              RETURN OLD;
            END IF;
            IF NEW.operation_id IS DISTINCT FROM OLD.operation_id THEN
              RAISE EXCEPTION USING
                ERRCODE = '55000',
                MESSAGE = 'operation_binding_immutable';
            END IF;
            RETURN NEW;
          END;
          $fn$
        `.execute(trx)
        await sql`
          INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, after, operation_id)
          VALUES (${SHEET}, 'field', ${`${SHEET}_guc_field`}, 'update', '{"ok":true}'::jsonb, ${operationId}::uuid)
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_revisions (
            id, sheet_id, record_id, version, action, source,
            changed_field_ids, patch, snapshot, seq, operation_id
          ) VALUES (
            ${randomUUID()}::uuid, ${SHEET}, ${`${SHEET}_guc`}, 1, 'create', 'rest',
            ARRAY[]::text[], '{}'::jsonb, '{}'::jsonb, ${SEQ}::bigint, ${operationId}::uuid
          )
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count)
          VALUES (${SHEET}, ${operationId}::uuid, ${SEQ}::bigint, 1)
        `.execute(trx)
        await sql`DELETE FROM meta_config_revisions WHERE operation_id = ${operationId}::uuid`.execute(trx)
        throw new Error('operation_binding_tagged_delete_guc_missing')
      }),
    )
    expect(sentinel.message).toBe('operation_binding_tagged_delete_guc_missing')
    expect(await bindingFingerprint()).toBe(initialFingerprint)
  })

  test('nonempty down refuses without partial drop; empty down/up restores the fingerprint', async () => {
    const operationId = randomUUID()
    await withTxn(async (client) => {
      await insertConfig(client, SHEET, operationId)
      await sealOrdinary(client, SHEET, operationId, SEQ)
    })
    const refusal = await errorOf(db.transaction().execute(async (trx) => operationBindingMigration.down(trx)))
    expect(refusal.message).toBe('operation_binding_nonempty')
    expectValuesFree(refusal, [SHEET, WORKSPACE, BASE, operationId])
    expect(await bindingFingerprint()).toBe(initialFingerprint)

    await cleanupSheetRows()
    await operationBindingMigration.down(db)
    schemaIsUp = false
    try {
      const surface = await ownedSurface()
      expect(surface.columns).toEqual([])
      expect(surface.indexes).toEqual([])
      expect(surface.fks).toEqual([])
      expect(surface.triggers).toEqual([])
      expect(surface.functions).toEqual([])
      await operationBindingMigration.up(db)
      schemaIsUp = true
      expect(await bindingFingerprint()).toBe(initialFingerprint)
    } finally {
      if (!schemaIsUp) {
        await operationBindingMigration.up(db)
        schemaIsUp = true
      }
    }
  })

  test('keep-last-n and keep-days leave tagged rows in ranking windows and refuse to delete them', async () => {
    // Deliberate minimal semantics: a tagged newest row occupies rank 1, so one extra
    // untagged row ages out of keep-N compared with filtering tagged rows out of ranking.
    const taggedOp = randomUUID()
    const recordId = `${SHEET}_ranked`
    await withTxn(async (client) => {
      await client.query(
        `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, after, operation_id, created_at)
         VALUES ($1, 'field', $2, 'update', '{"ok":true}'::jsonb, $3::uuid, now() - interval '400 days')`,
        [SHEET, `${SHEET}_cfg`, taggedOp],
      )
      await client.query(
        `INSERT INTO meta_record_revisions (
           id, sheet_id, record_id, version, action, source,
           changed_field_ids, patch, snapshot, seq, operation_id, created_at
         ) VALUES ($1::uuid, $2, $3, 13, 'update', 'rest', ARRAY[]::text[], '{}'::jsonb,
                   '{}'::jsonb, $4::bigint, $5::uuid, now())`,
        [randomUUID(), SHEET, recordId, SEQ, taggedOp],
      )
      await client.query(
        `INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count)
         VALUES ($1, $2::uuid, $3::bigint, 1)`,
        [SHEET, taggedOp, SEQ],
      )
      for (let version = 12; version >= 1; version -= 1) {
        await client.query(
          `INSERT INTO meta_record_revisions (
             id, sheet_id, record_id, version, action, source,
             changed_field_ids, patch, snapshot, seq, created_at
           ) VALUES ($1::uuid, $2, $3, $4, 'update', 'rest', ARRAY[]::text[], '{}'::jsonb,
                     '{}'::jsonb, $5::bigint, now() - ($6::int * interval '1 day'))`,
          [randomUUID(), SHEET, recordId, version, String(9007199254745100 + version), 13 - version],
        )
      }
    })
    const deleted = await sweepMetaRevisionRetention(q, sweepConfig({ keepN: 2 }))
    expect(deleted).toBe(3)
    const remaining = await q(
      `SELECT version, (operation_id IS NOT NULL) AS tagged
         FROM meta_record_revisions WHERE record_id=$1 ORDER BY version DESC`,
      [recordId],
    )
    expect(remaining.rows).toHaveLength(10)
    expect(remaining.rows[0]).toEqual({ version: 13, tagged: true })

    const configEntity = `${SHEET}_cfg`
    await withTxn(async (client) => {
      await client.query(
        `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, after, created_at)
         VALUES ($1, 'field', $2, 'update', '{"ok":true}'::jsonb, now() - interval '400 days')`,
        [SHEET, configEntity],
      )
      await client.query(
        `INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, after, created_at)
         VALUES ($1, 'field', $2, 'update', '{"ok":true}'::jsonb, now())`,
        [SHEET, configEntity],
      )
    })
    const configDeleted = await sweepConfigRevisionRetention(
      q,
      sweepConfig({ policy: 'keep-days', retentionDays: 30 }),
    )
    expect(configDeleted).toBe(1)
    const configRemaining = await q(
      `SELECT (operation_id IS NOT NULL) AS tagged, (created_at > now() - interval '1 day') AS recent
         FROM meta_config_revisions WHERE entity_id=$1 ORDER BY created_at DESC, id DESC`,
      [configEntity],
    )
    expect(configRemaining.rows).toEqual([
      { tagged: false, recent: true },
      { tagged: true, recent: false },
    ])
  })

  test('mixed tagged tombstone groups and tagged loose rows are not pruned; untagged groups are', async () => {
    const taggedOp = randomUUID()
    const mixedAnchor = randomUUID()
    const untaggedAnchor = randomUUID()
    await withTxn(async (client) => {
      await insertFieldTombstone(client, SHEET, taggedOp, {
        configRevisionId: mixedAnchor,
        recordId: `${SHEET}_mixed_tagged`,
        createdAtSql: `now() - interval '40 days'`,
      })
      await insertFieldTombstone(client, SHEET, null, {
        configRevisionId: mixedAnchor,
        recordId: `${SHEET}_mixed_untagged`,
        createdAtSql: `now() - interval '40 days'`,
      })
      await insertFieldTombstone(client, SHEET, null, {
        configRevisionId: untaggedAnchor,
        recordId: `${SHEET}_untagged_group`,
        createdAtSql: `now() - interval '40 days'`,
      })
      await insertFieldTombstone(client, SHEET, taggedOp, {
        recordId: `${SHEET}_loose_tagged`,
        createdAtSql: `now() - interval '40 days'`,
      })
      await insertFieldTombstone(client, SHEET, null, {
        recordId: `${SHEET}_loose_untagged`,
        createdAtSql: `now() - interval '40 days'`,
      })
      await insertLinkTombstone(client, SHEET, taggedOp, {
        sourceRevisionId: mixedAnchor,
        recordId: `${SHEET}_link_mixed_tagged`,
        createdAtSql: `now() - interval '40 days'`,
      })
      await sealOrdinary(client, SHEET, taggedOp, SEQ)
      await insertLinkTombstone(client, SHEET, null, {
        sourceRevisionId: mixedAnchor,
        recordId: `${SHEET}_link_mixed_untagged`,
        createdAtSql: `now() - interval '40 days'`,
      })
      await insertLinkTombstone(client, SHEET, null, {
        sourceRevisionId: untaggedAnchor,
        recordId: `${SHEET}_link_untagged_group`,
        createdAtSql: `now() - interval '40 days'`,
      })
    })

    const fieldDeleted = await sweepFieldValueTombstoneRetention(q, sweepConfig({ retentionDays: 30 }))
    const linkDeleted = await sweepLinkTombstoneRetention(q, sweepConfig({ retentionDays: 30 }))
    expect(fieldDeleted).toBe(2)
    expect(linkDeleted).toBe(1)

    const remainingField = await q(
      `SELECT record_id FROM meta_field_value_tombstones WHERE sheet_id=$1 ORDER BY record_id`,
      [SHEET],
    )
    expect(remainingField.rows.map((row) => row.record_id)).toEqual([
      `${SHEET}_loose_tagged`,
      `${SHEET}_mixed_tagged`,
      `${SHEET}_mixed_untagged`,
    ])
    const remainingLink = await q(
      `SELECT record_id FROM meta_link_tombstones WHERE sheet_id=$1 ORDER BY record_id`,
      [SHEET],
    )
    expect(remainingLink.rows.map((row) => row.record_id)).toEqual([
      `${SHEET}_link_mixed_tagged`,
      `${SHEET}_link_mixed_untagged`,
    ])
  })

  test('missing trash delete_revision_id takes the guarded link-tombstone fallback', async () => {
    const client = await pool.connect()
    try {
      const sourceRevisionId = randomUUID()
      await client.query(`
        CREATE TEMP TABLE meta_link_tombstones (
          id uuid PRIMARY KEY,
          source_revision_id uuid,
          operation_id uuid,
          created_at timestamptz NOT NULL
        )
      `)
      await client.query('CREATE TEMP TABLE meta_records_trash (id text PRIMARY KEY)')
      await client.query('SET search_path = pg_temp, pg_catalog')
      await client.query(
        `INSERT INTO meta_link_tombstones (id, source_revision_id, operation_id, created_at)
         VALUES ($1::uuid, $2::uuid, NULL, now() - interval '400 days')`,
        [randomUUID(), sourceRevisionId],
      )
      const deleted = await sweepLinkTombstoneRetention(
        ((text: string, values?: unknown[]) => client.query(text, values)) as never,
        sweepConfig({ retentionDays: 30 }),
      )
      expect(deleted).toBe(1)
      const remaining = await client.query(
        'SELECT count(*)::int AS n FROM meta_link_tombstones WHERE source_revision_id=$1::uuid',
        [sourceRevisionId],
      )
      expect(remaining.rows).toEqual([{ n: 0 }])
    } finally {
      await client.query('RESET search_path').catch(() => {})
      await client.query('DISCARD TEMP').catch(() => {})
      client.release()
    }
    expect(await bindingFingerprint()).toBe(initialFingerprint)
  })

  test('current endpoint prune fails at COMMIT when tagged evidence remains and still prunes untagged operations', async () => {
    const taggedOp = randomUUID()
    const plainOp = randomUUID()
    await withTxn(async (client) => {
      await insertConfig(client, SHEET, taggedOp)
      await insertFieldTombstone(client, SHEET, taggedOp)
      await insertLinkTombstone(client, SHEET, taggedOp)
      await sealOrdinary(client, SHEET, taggedOp, SEQ, `${SHEET}_tagged_record`)
      await sealOrdinary(client, SHEET, plainOp, OTHER_SEQ, `${SHEET}_plain_record`)
    })

    const taggedRefusal = await errorOf(
      withTxn(async (client) => {
        await client.query('SELECT meta_record_history_operations_prune($1, $2::uuid)', [SHEET, taggedOp])
      }),
    )
    expect(taggedRefusal.code).toBe('23503')
    expect(['fk_mcr_operation', 'fk_mfvt_operation', 'fk_mlt_operation']).toContain(taggedRefusal.constraint)

    const surviving = await q(
      `SELECT
         (SELECT count(*)::int FROM meta_record_history_operations WHERE operation_id=$1::uuid) AS endpoint_count,
         (SELECT count(*)::int FROM meta_record_revisions WHERE operation_id=$1::uuid) AS revision_count,
         (SELECT count(*)::int FROM meta_config_revisions WHERE operation_id=$1::uuid) AS config_count,
         (SELECT count(*)::int FROM meta_field_value_tombstones WHERE operation_id=$1::uuid) AS field_count,
         (SELECT count(*)::int FROM meta_link_tombstones WHERE operation_id=$1::uuid) AS link_count`,
      [taggedOp],
    )
    expect(surviving.rows).toEqual([
      { endpoint_count: 1, revision_count: 1, config_count: 1, field_count: 1, link_count: 1 },
    ])

    await q('SELECT meta_record_history_operations_prune($1, $2::uuid)', [SHEET, plainOp])
    const plainGone = await q(
      `SELECT count(*)::int AS n FROM meta_record_history_operations WHERE operation_id=$1::uuid`,
      [plainOp],
    )
    expect(plainGone.rows).toEqual([{ n: 0 }])
  })

  test('legacy prune fail-loud is load-bearing on the deferred FKs', async () => {
    // Residual: D2d1 does not CREATE OR REPLACE meta_record_history_operations_prune
    // with a values-free precheck. That function is D2c-fingerprinted; replacing it
    // here would drift D2c real-DB replay. Fail-loud is the deferred FK 23503 plus
    // zero surviving deletion. D2d2 may wrap prune.
    const operationId = randomUUID()
    const sentinel = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`ALTER TABLE public.meta_config_revisions DROP CONSTRAINT fk_mcr_operation`.execute(trx)
        await sql`ALTER TABLE public.meta_field_value_tombstones DROP CONSTRAINT fk_mfvt_operation`.execute(trx)
        await sql`ALTER TABLE public.meta_link_tombstones DROP CONSTRAINT fk_mlt_operation`.execute(trx)
        await sql`
          INSERT INTO meta_config_revisions (sheet_id, entity_type, entity_id, action, after, operation_id)
          VALUES (${SHEET}, 'field', ${`${SHEET}_prune_fk`}, 'update', '{"ok":true}'::jsonb, ${operationId}::uuid)
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_revisions (
            id, sheet_id, record_id, version, action, source,
            changed_field_ids, patch, snapshot, seq, operation_id
          ) VALUES (
            ${randomUUID()}::uuid, ${SHEET}, ${`${SHEET}_prune_fk`}, 1, 'create', 'rest',
            ARRAY[]::text[], '{}'::jsonb, '{}'::jsonb, ${SEQ}::bigint, ${operationId}::uuid
          )
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count)
          VALUES (${SHEET}, ${operationId}::uuid, ${SEQ}::bigint, 1)
        `.execute(trx)
        await sql`SELECT meta_record_history_operations_prune(${SHEET}, ${operationId}::uuid)`.execute(trx)
        throw new Error('operation_binding_prune_fk_missing')
      }),
    )
    expect(sentinel.message).toBe('operation_binding_prune_fk_missing')
    expect(await bindingFingerprint()).toBe(initialFingerprint)
  })

  test('up fails loud on source-schema drift and rolls the attempted down back atomically', async () => {
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        await operationBindingMigration.down(trx)
        await sql`
          ALTER TABLE public.meta_config_revisions
          RENAME COLUMN sheet_id TO sheet_id_d2d1_drift
        `.execute(trx)
        await operationBindingMigration.up(trx)
        throw new Error('operation_binding_source_schema_guard_missing')
      }),
    )
    expect(refusal.message).toBe('operation_binding_source_schema_mismatch')
    expect(await bindingFingerprint()).toBe(initialFingerprint)
  })

  test('up fails loud when the inherited append-after-seal function body has drifted', async () => {
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        await operationBindingMigration.down(trx)
        await sql`
          CREATE OR REPLACE FUNCTION public.meta_record_reject_append_to_sealed_operation()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $fn$
          BEGIN
            RETURN NEW;
          END;
          $fn$
        `.execute(trx)
        await operationBindingMigration.up(trx)
        throw new Error('operation_binding_append_function_shape_guard_missing')
      }),
    )
    expect(refusal.message).toBe('operation_binding_source_schema_mismatch')
    expect(await bindingFingerprint()).toBe(initialFingerprint)
  })

  test('up fails loud on an owned-name collision and rolls the attempted down back atomically', async () => {
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        await operationBindingMigration.down(trx)
        await sql`
          ALTER TABLE public.meta_config_revisions ADD COLUMN operation_id integer
        `.execute(trx)
        await operationBindingMigration.up(trx)
        throw new Error('operation_binding_owned_object_guard_missing')
      }),
    )
    expect(refusal.message).toBe('operation_binding_object_conflict')
    expect(await bindingFingerprint()).toBe(initialFingerprint)
  })

  test('FK owned-object conflict is conrelid-scoped, not conname-only', async () => {
    const sentinel = await errorOf(
      db.transaction().execute(async (trx) => {
        await operationBindingMigration.down(trx)
        await sql`
          ALTER TABLE public.meta_sheets ADD CONSTRAINT fk_mcr_operation CHECK (true)
        `.execute(trx)
        await operationBindingMigration.up(trx)
        throw new Error('operation_binding_fk_conrelid_unscoped')
      }),
    )
    expect(sentinel.message).toBe('operation_binding_fk_conrelid_unscoped')
    expect(await bindingFingerprint()).toBe(initialFingerprint)
  })
})
