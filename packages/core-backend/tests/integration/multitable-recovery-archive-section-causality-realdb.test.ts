import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import * as sectionCausalityMigration from '../../src/db/migrations/zzzz20260826122000_add_section_causality_substrate'
import * as snapshotReservationMigration from '../../src/db/migrations/zzzz20260828120000_add_recovery_archive_snapshot_reservations'
import { OperationLedger, sealOperation } from '../../src/multitable/operation-ledger'
import {
  consumeRecoveryArchiveBootstrapReservations,
  RecoveryArchiveSectionBootstrapError,
  reserveRecoveryArchiveSnapshotIdentities,
  type RecoveryArchiveBootstrapOwnerInput,
} from '../../src/multitable/recovery-archive-section-bootstrap'
import {
  bootstrapSectionEntityKey,
  RecoveryArchiveSealError,
  sealArchiveSnapshotOperation,
  sealDirectEventOperation,
  sealRestoreAggregateOperation,
  sealSectionBootstrapOperation,
  SECTION_CAUSALITY_DATA_SECTION_KINDS,
  type SealQuery,
} from '../../src/multitable/recovery-archive-seals'

const runRealDb = Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeIfRealDbStep = runRealDb ? describe : describe.skip

test('sentinel: the D2c real-DB allowlist step must provide DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('section_causality_realdb_harness_missing_database_url')
  }
})

const RUN = randomUUID().replaceAll('-', '').slice(0, 16)
const PREFIX = `tm_d2c_${RUN}`
const WORKSPACE = `${PREFIX}_workspace`
const BASE = `${PREFIX}_base`
const OTHER_BASE = `${PREFIX}_other_base`
const SHEET = `${PREFIX}_sheet`
const OTHER_SHEET = `${PREFIX}_other_sheet`
const SHA256_A = 'a'.repeat(64)
const SHA256_B = 'b'.repeat(64)
const DI0_SOURCE_VECTOR_HASH = 'c'.repeat(64)
const BOOTSTRAP_SEQ0 = '9007199254742000'
const RECORDS_HEAD_SEQ = '9007199254742009'
const SNAPSHOT_SEQ = '9007199254742010'
const CHUNK_SEQ_1 = '9007199254743001'
const CHUNK_SEQ_2 = '9007199254743002'
const UNION_REV_SEQ = '9007199254744001'
const UNION_MARK_SEQ = '9007199254744002'
const UNION_SEC_SEQ = '9007199254744003'

const TABLES = [
  'meta_sheet_section_revisions',
  'meta_record_history_snapshot_members',
  'meta_record_history_operation_members',
] as const

const FUNCTIONS = ['meta_sheet_section_revisions_guard_row', 'meta_record_history_membership_guard_row'] as const

const INDEXES = [
  'idx_meta_sheet_section_revisions_operation',
  'idx_meta_sheet_section_revisions_sheet_seq',
  'idx_meta_record_history_snapshot_members_parent',
  'idx_meta_record_history_operation_members_parent',
] as const

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

function asQuery(client: PoolClient): SealQuery {
  return (text, params) => client.query(text, params)
}

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

function bootstrapSeq(index: number): string {
  return String(BigInt(BOOTSTRAP_SEQ0) + BigInt(index))
}

async function insertBootstrapRevision(
  client: PoolClient,
  sheetId: string,
  operationId: string,
  sectionKind: (typeof SECTION_CAUSALITY_DATA_SECTION_KINDS)[number],
  seq: string,
  rowCount: string,
  sourceHash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO meta_sheet_section_revisions (
       sheet_id, section_kind, entity_key, action, payload, seq, operation_id
     ) VALUES (
       $1, $2, $3, 'bootstrap_snapshot',
       jsonb_build_object('row_count', $4::text, 'source_hash', $5::text),
       $6::bigint, $7::uuid
     )`,
    [sheetId, sectionKind, bootstrapSectionEntityKey(sectionKind), rowCount, sourceHash, seq, operationId],
  )
}

async function sealBootstrapHead(
  client: PoolClient,
  sheetId: string,
  sectionKind: (typeof SECTION_CAUSALITY_DATA_SECTION_KINDS)[number],
  seq: string,
  rowCount = '0',
  sourceHash = SHA256_A,
): Promise<string> {
  const operationId = randomUUID()
  await insertBootstrapRevision(client, sheetId, operationId, sectionKind, seq, rowCount, sourceHash)
  await sealSectionBootstrapOperation(asQuery(client), {
    sheetId,
    operationId,
    endpointSeq: seq,
    sectionKind,
    rowCount,
    sourceHash,
  })
  return operationId
}

async function snapshotMembersFor(
  sheetId: string,
  heads: Array<{
    sectionKind: (typeof SECTION_CAUSALITY_DATA_SECTION_KINDS)[number]
    operationId: string
    seq: string
  }>,
) {
  return heads.map((head, index) => ({
    ordinal: index + 1,
    sectionKind: head.sectionKind,
    sourceHeadKind: 'section_bootstrap' as const,
    sourceOperationId: head.operationId,
    sourceHeadSeq: head.seq,
    rowCount: '0',
    sourceHash: SHA256_A,
  }))
}

async function bootstrapAllSections(client: PoolClient, sheetId: string) {
  const heads = []
  for (const [index, sectionKind] of SECTION_CAUSALITY_DATA_SECTION_KINDS.entries()) {
    const seq = bootstrapSeq(index)
    const operationId = await sealBootstrapHead(client, sheetId, sectionKind, seq)
    heads.push({ sectionKind, operationId, seq })
  }
  return heads
}

async function insertRecordRevision(
  client: PoolClient,
  sheetId: string,
  operationId: string,
  seq: string,
  recordId = `${sheetId}_record`,
): Promise<void> {
  await client.query(
    `INSERT INTO meta_record_revisions (
       id, sheet_id, record_id, version, action, source,
       changed_field_ids, patch, snapshot, seq, operation_id
     ) VALUES ($1::uuid, $2, $3, 1, 'create', 'rest', ARRAY[]::text[], '{}'::jsonb,
               '{}'::jsonb, $4::bigint, $5::uuid)`,
    [randomUUID(), sheetId, recordId, seq, operationId],
  )
}

async function insertMarker(
  client: PoolClient,
  sheetId: string,
  operationId: string,
  seq: string,
  recordId = `${sheetId}_record`,
): Promise<void> {
  await client.query(
    `INSERT INTO meta_record_version_markers (
       id, sheet_id, record_id, version, kind, seq, operation_id
     ) VALUES ($1::uuid, $2, $3, 1, 'lock', $4::bigint, $5::uuid)`,
    [randomUUID(), sheetId, recordId, seq, operationId],
  )
}

async function causalityFingerprint(): Promise<string> {
  const result = await q(
    `SELECT md5(string_agg(definition, '|' ORDER BY definition)) AS fingerprint
       FROM (
         SELECT concat_ws('|', 'column', table_name, column_name, data_type, udt_name, is_nullable)::text AS definition
           FROM information_schema.columns
          WHERE table_schema='public' AND table_name = ANY($1::text[])
         UNION ALL
         SELECT concat_ws('|', 'constraint', relation.relname, constraint_row.conname,
                          constraint_row.condeferrable::text, constraint_row.condeferred::text,
                          pg_get_constraintdef(constraint_row.oid, true))
           FROM pg_constraint constraint_row
           JOIN pg_class relation ON relation.oid=constraint_row.conrelid
           JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname='public' AND relation.relname = ANY($1::text[])
         UNION ALL
         SELECT concat_ws('|', 'index', tablename, indexname, indexdef)
           FROM pg_indexes
          WHERE schemaname='public' AND tablename = ANY($1::text[])
         UNION ALL
         SELECT concat_ws('|', 'trigger', relation.relname, trigger_row.tgname, pg_get_triggerdef(trigger_row.oid, true))
           FROM pg_trigger trigger_row
           JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
           JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname='public' AND NOT trigger_row.tgisinternal
            AND relation.relname = ANY($1::text[])
         UNION ALL
         SELECT concat_ws('|', 'function', procedure_row.proname, pg_get_functiondef(procedure_row.oid))
           FROM pg_proc procedure_row
           JOIN pg_namespace namespace ON namespace.oid=procedure_row.pronamespace
          WHERE namespace.nspname='public' AND procedure_row.proname = ANY($2::text[])
         UNION ALL
         SELECT concat_ws('|', 'operations-check', constraint_row.conname, pg_get_constraintdef(constraint_row.oid, true))
           FROM pg_constraint constraint_row
           JOIN pg_class relation ON relation.oid=constraint_row.conrelid
           JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname='public'
            AND relation.relname='meta_record_history_operations'
            AND constraint_row.conname IN (
              'chk_mrho_event_contract',
              'chk_mrho_event_contract_version',
              'chk_mrho_operation_kind',
              'chk_mrho_event_count_positive'
            )
         UNION ALL
         SELECT concat_ws('|', 'validate', md5(procedure_row.prosrc), coalesce(array_to_string(procedure_row.proconfig, ','), ''))
           FROM pg_proc procedure_row
           JOIN pg_namespace namespace ON namespace.oid=procedure_row.pronamespace
          WHERE namespace.nspname='public'
            AND procedure_row.proname='meta_record_history_operations_validate_endpoint'
       ) catalog_rows`,
    [[...TABLES, 'meta_record_history_operations'], [...FUNCTIONS]],
  )
  return String(result.rows[0]?.fingerprint ?? '')
}

async function installIfAbsent(): Promise<void> {
  const present = await q(
    `SELECT count(*)::int AS count
       FROM unnest($1::text[]) AS owned(name)
      WHERE pg_catalog.to_regclass('public.' || name) IS NOT NULL`,
    [TABLES],
  )
  const count = Number(present.rows[0]?.count ?? 0)
  if (count === 0) await sectionCausalityMigration.up(db)
  else if (count !== TABLES.length) throw new Error('section_causality_partial_schema')
  const reservation = await q(
    `SELECT count(*)::int AS count
       FROM unnest(ARRAY[
         'meta_recovery_archive_snapshot_reservations',
         'meta_recovery_archive_section_bootstrap_markers'
       ]::text[]) AS owned(name)
      WHERE pg_catalog.to_regclass('public.' || owned.name) IS NOT NULL`,
  )
  const reservationCount = Number(reservation.rows[0]?.count ?? 0)
  if (reservationCount === 0) await snapshotReservationMigration.up(db)
  else if (reservationCount !== 2) throw new Error('snapshot_reservation_partial_schema')
  schemaIsUp = true
}

async function withRolledBackTxn(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

async function seedBuildingGeneration(
  client: PoolClient,
  reuseActiveCheckpoint = false,
): Promise<RecoveryArchiveBootstrapOwnerInput> {
  const generationId = randomUUID()
  const anchorOperationId = randomUUID()
  const anchorRecordId = `${PREFIX}_di0_anchor_${randomUUID()}`
  const checkpointId = reuseActiveCheckpoint
    ? String(
        (
          await client.query(
            `SELECT id FROM meta_history_trust_checkpoints
              WHERE sheet_id=$1 AND state='active'`,
            [SHEET],
          )
        ).rows[0]?.id ?? '',
      )
    : `${PREFIX}_di0_checkpoint_${randomUUID()}`
  const seq = await client.query(`SELECT nextval('meta_record_chain_seq')::text AS seq`)
  const anchorSeq = String(seq.rows[0]?.seq)
  await insertRecordRevision(client, SHEET, anchorOperationId, anchorSeq, anchorRecordId)
  await sealDirectEventOperation(asQuery(client), {
    sheetId: SHEET,
    operationId: anchorOperationId,
    endpointSeq: anchorSeq,
    eventCount: 1,
    operationKind: 'ordinary',
  })
  if (!reuseActiveCheckpoint) {
    await client.query(
      `INSERT INTO meta_history_trust_checkpoints (id, sheet_id, state, trusted_since_seq)
       VALUES ($1, $2, 'active', $3::bigint)`,
      [checkpointId, SHEET, anchorSeq],
    )
  }
  const input: RecoveryArchiveBootstrapOwnerInput = {
    generationId,
    sheetId: SHEET,
    sourceVectorHash: DI0_SOURCE_VECTOR_HASH,
    ownerKind: 'archive_builder',
    ownerId: `${PREFIX}_di0_owner`,
    ownerFence: '17',
  }
  await client.query(
    `INSERT INTO meta_recovery_archives (
       generation_id, workspace_id, base_id, sheet_id, anchor_operation_id, anchor_seq,
       checkpoint_id, source_vector_hash, key_id, owner_kind, owner_id, owner_fence,
       lease_expires_at, expires_at
     ) VALUES (
       $1::uuid, $2, $3, $4, $5::uuid, $6::bigint,
       $7, $8, 'tm-di0-test-key', $9, $10, $11::bigint,
       clock_timestamp() + interval '1 hour', clock_timestamp() + interval '2 hours'
     )`,
    [
      input.generationId,
      WORKSPACE,
      BASE,
      input.sheetId,
      anchorOperationId,
      anchorSeq,
      checkpointId,
      input.sourceVectorHash,
      input.ownerKind,
      input.ownerId,
      input.ownerFence,
    ],
  )
  return input
}

function di0Contents() {
  return SECTION_CAUSALITY_DATA_SECTION_KINDS.map((sectionKind, index) => ({
    sectionKind,
    rowCount: index === 0 ? '3' : '0',
    sourceHash: index % 2 === 0 ? SHA256_A : SHA256_B,
  }))
}

async function cleanupSheetRows(): Promise<void> {
  if (!schemaIsUp) return
  await withTxn(async (client) => {
    await client.query(`SELECT set_config('metasheet.mrho_retention', 'on', true)`)
    await client.query(
      `TRUNCATE TABLE
         meta_record_history_operation_members,
         meta_record_history_snapshot_members,
         meta_sheet_section_revisions`,
    )
    await client.query(`DELETE FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])`, [[SHEET, OTHER_SHEET]])
    await client.query(`DELETE FROM meta_record_version_markers WHERE sheet_id = ANY($1::text[])`, [
      [SHEET, OTHER_SHEET],
    ])
    await client.query(`DELETE FROM meta_record_history_operations WHERE sheet_id = ANY($1::text[])`, [
      [SHEET, OTHER_SHEET],
    ])
    await client.query(`DELETE FROM meta_field_value_tombstones WHERE sheet_id = ANY($1::text[])`, [
      [SHEET, OTHER_SHEET],
    ])
    await client.query(`DELETE FROM meta_link_tombstones WHERE sheet_id = ANY($1::text[])`, [[SHEET, OTHER_SHEET]])
    await client.query(`DELETE FROM meta_config_revisions WHERE sheet_id = ANY($1::text[])`, [[SHEET, OTHER_SHEET]])
  })
}

describeIfRealDbStep('Phase D2c section-causality substrate (real DB)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    await installIfAbsent()
    initialFingerprint = await causalityFingerprint()

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

  test('D-I0 reserves one immutable exact section set and a strictly greater parent idempotently', async () => {
    await withRolledBackTxn(async (client) => {
      const input = await seedBuildingGeneration(client)
      const first = await reserveRecoveryArchiveSnapshotIdentities(asQuery(client), input)
      const second = await reserveRecoveryArchiveSnapshotIdentities(asQuery(client), input)

      expect(second).toEqual(first)
      expect(first.sections.map((section) => section.sectionKind)).toEqual(SECTION_CAUSALITY_DATA_SECTION_KINDS)
      expect(new Set(first.sections.map((section) => section.operationId)).size).toBe(9)
      expect(BigInt(first.snapshotSeq)).toBeGreaterThan(
        first.sections.reduce(
          (max, section) => (BigInt(section.endpointSeq) > max ? BigInt(section.endpointSeq) : max),
          0n,
        ),
      )

      await client.query('SET CONSTRAINTS trg_mrasr_guard_set IMMEDIATE')
      const rows = await client.query(
        `SELECT ordinal, reservation_kind, section_kind, operation_id::text, endpoint_seq::text
           FROM meta_recovery_archive_snapshot_reservations
          WHERE generation_id=$1::uuid ORDER BY ordinal`,
        [input.generationId],
      )
      expect(rows.rows).toHaveLength(10)
      expect(rows.rows.at(-1)).toMatchObject({
        ordinal: 10,
        reservation_kind: 'archive_snapshot',
        section_kind: null,
      })

      const immutable = await errorOf(
        client.query(
          `UPDATE meta_recovery_archive_snapshot_reservations
              SET endpoint_seq=endpoint_seq+1 WHERE generation_id=$1::uuid AND ordinal=1`,
          [input.generationId],
        ),
      )
      expect(immutable.message).toBe('recovery_archive_snapshot_reservation_immutable')
      expectValuesFree(immutable, [input.generationId, input.sheetId, input.ownerId])
    })
  })

  test('D-I0 permits an empty no-op truncate but refuses to erase reserved identities', async () => {
    await withRolledBackTxn(async (client) => {
      await client.query('TRUNCATE TABLE meta_recovery_archive_snapshot_reservations')
      const input = await seedBuildingGeneration(client)
      await reserveRecoveryArchiveSnapshotIdentities(asQuery(client), input)
      await client.query('SET CONSTRAINTS trg_mrasr_guard_set IMMEDIATE')

      const immutable = await errorOf(
        client.query('TRUNCATE TABLE meta_recovery_archive_snapshot_reservations'),
      )
      expect(immutable.message).toBe('recovery_archive_snapshot_reservation_immutable')
      expectValuesFree(immutable, [input.generationId, input.sheetId, input.ownerId])
    })
  })

  test('D-I0 rejects a partial reservation set at the deferred database boundary', async () => {
    await withRolledBackTxn(async (client) => {
      const input = await seedBuildingGeneration(client)
      await client.query('SAVEPOINT partial_reservation')
      const identity = await client.query(`SELECT nextval('meta_record_chain_seq')::text AS seq`)
      const operationId = randomUUID()
      await client.query(
        `INSERT INTO meta_recovery_archive_snapshot_reservations (
           generation_id, sheet_id, source_vector_hash, owner_kind, owner_id, owner_fence,
           ordinal, reservation_kind, section_kind, operation_id, endpoint_seq
         ) VALUES ($1::uuid, $2, $3, $4, $5, $6::bigint, 1, 'section_bootstrap', 'schema',
                   $7::uuid, $8::bigint)`,
        [
          input.generationId,
          input.sheetId,
          input.sourceVectorHash,
          input.ownerKind,
          input.ownerId,
          input.ownerFence,
          operationId,
          identity.rows[0]?.seq,
        ],
      )
      const error = await errorOf(client.query('SET CONSTRAINTS trg_mrasr_guard_set IMMEDIATE'))
      expect(error.message).toBe('recovery_archive_snapshot_reservation_set_invalid')
      expectValuesFree(error, [input.generationId, input.sheetId, input.ownerId])
      await client.query('ROLLBACK TO SAVEPOINT partial_reservation')
    })
  })

  test('D-I0 rejects a complete reservation set whose parent sequence is not last', async () => {
    await withRolledBackTxn(async (client) => {
      const input = await seedBuildingGeneration(client)
      await client.query('SAVEPOINT parent_not_last')
      const allocated = await client.query(
        `SELECT ordinal::int, nextval('meta_record_chain_seq')::text AS endpoint_seq
           FROM generate_series(1, 10) AS ordinal
          ORDER BY ordinal`,
      )
      const endpointSeqs = allocated.rows.map((row) => String(row.endpoint_seq))
      const operationIds = Array.from({ length: 10 }, () => randomUUID())
      await client.query(
        `INSERT INTO meta_recovery_archive_snapshot_reservations (
           generation_id, sheet_id, source_vector_hash, owner_kind, owner_id, owner_fence,
           ordinal, reservation_kind, section_kind, operation_id, endpoint_seq
         )
         SELECT $1::uuid, $2, $3, $4, $5, $6::bigint,
                row_input.ordinal, row_input.reservation_kind, row_input.section_kind,
                row_input.operation_id, row_input.endpoint_seq
           FROM unnest(
             $7::int[], $8::text[], $9::text[], $10::uuid[], $11::bigint[]
           ) AS row_input(ordinal, reservation_kind, section_kind, operation_id, endpoint_seq)`,
        [
          input.generationId,
          input.sheetId,
          input.sourceVectorHash,
          input.ownerKind,
          input.ownerId,
          input.ownerFence,
          Array.from({ length: 10 }, (_, index) => index + 1),
          [...SECTION_CAUSALITY_DATA_SECTION_KINDS.map(() => 'section_bootstrap'), 'archive_snapshot'],
          [...SECTION_CAUSALITY_DATA_SECTION_KINDS, null],
          operationIds,
          [...endpointSeqs.slice(1), endpointSeqs[0]],
        ],
      )
      const error = await errorOf(client.query('SET CONSTRAINTS trg_mrasr_guard_set IMMEDIATE'))
      expect(error.message).toBe('recovery_archive_snapshot_reservation_set_invalid')
      expectValuesFree(error, [input.generationId, input.sheetId, input.ownerId])
      await client.query('ROLLBACK TO SAVEPOINT parent_not_last')
    })
  })

  test('D-I0 consume rolls back partial work, retries deterministically, and seals parent last', async () => {
    await withRolledBackTxn(async (client) => {
      const input = await seedBuildingGeneration(client)
      const plan = await reserveRecoveryArchiveSnapshotIdentities(asQuery(client), input)
      const contents = di0Contents()
      await client.query('SAVEPOINT failed_finalize')
      let sealedBootstrapCount = 0
      const injectedQuery: SealQuery = async (text, params) => {
        if (text.includes('INSERT INTO meta_record_history_operations') && text.includes("'section_bootstrap'")) {
          sealedBootstrapCount += 1
          if (sealedBootstrapCount === 3) throw new Error('injected_di0_finalize_failure')
        }
        return client.query(text, params)
      }
      await expect(
        consumeRecoveryArchiveBootstrapReservations(injectedQuery, { ...input, sections: contents }),
      ).rejects.toThrow('injected_di0_finalize_failure')
      await client.query('ROLLBACK TO SAVEPOINT failed_finalize')

      const afterRollback = await client.query(
        `SELECT
           (SELECT count(*)::int FROM meta_sheet_section_revisions
             WHERE sheet_id=$1 AND operation_id=ANY($2::uuid[])) AS revisions,
           (SELECT count(*)::int FROM meta_record_history_operations
             WHERE sheet_id=$1 AND operation_id=ANY($2::uuid[])) AS operations,
           (SELECT count(*)::int FROM meta_record_history_snapshot_members
             WHERE sheet_id=$1 AND parent_operation_id=$3::uuid) AS members,
           (SELECT count(*)::int FROM meta_recovery_archive_section_bootstrap_markers
             WHERE sheet_id=$1) AS markers`,
        [
          input.sheetId,
          [...plan.sections.map((section) => section.operationId), plan.snapshotOperationId],
          plan.snapshotOperationId,
        ],
      )
      expect(afterRollback.rows[0]).toEqual({ revisions: 0, operations: 0, members: 0, markers: 0 })

      const retried = await consumeRecoveryArchiveBootstrapReservations(asQuery(client), {
        ...input,
        sections: contents,
      })
      expect(retried).toEqual(plan)
      await client.query('SET CONSTRAINTS ALL IMMEDIATE')

      const sealed = await client.query(
        `SELECT operation_kind, endpoint_seq::text AS endpoint_seq, event_count, component_count
         FROM meta_record_history_operations
          WHERE sheet_id=$1 AND operation_id=ANY($2::uuid[])
          ORDER BY endpoint_seq::bigint`,
        [input.sheetId, [...plan.sections.map((section) => section.operationId), plan.snapshotOperationId]],
      )
      expect(sealed.rows).toHaveLength(10)
      expect(sealed.rows.at(-1)).toEqual({
        operation_kind: 'archive_snapshot',
        endpoint_seq: plan.snapshotSeq,
        event_count: 0,
        component_count: 9,
      })
      const memberCount = await client.query(
        `SELECT count(*)::int AS count FROM meta_record_history_snapshot_members
          WHERE sheet_id=$1 AND parent_operation_id=$2::uuid`,
        [input.sheetId, plan.snapshotOperationId],
      )
      expect(memberCount.rows[0]?.count).toBe(9)
      const marker = await client.query(
        `SELECT generation_id::text AS generation_id,
                snapshot_operation_id::text AS snapshot_operation_id, source_vector_hash
           FROM meta_recovery_archive_section_bootstrap_markers
          WHERE sheet_id=$1`,
        [input.sheetId],
      )
      expect(marker.rows).toEqual([
        {
          generation_id: input.generationId,
          snapshot_operation_id: plan.snapshotOperationId,
          source_vector_hash: input.sourceVectorHash,
        },
      ])

      await consumeRecoveryArchiveBootstrapReservations(asQuery(client), { ...input, sections: contents })
      const retryCounts = await client.query(
        `SELECT
           (SELECT count(*)::int FROM meta_sheet_section_revisions
             WHERE sheet_id=$1 AND operation_id=ANY($2::uuid[])) AS revisions,
           (SELECT count(*)::int FROM meta_record_history_operations
             WHERE sheet_id=$1 AND operation_id=ANY($2::uuid[])) AS operations,
           (SELECT count(*)::int FROM meta_record_history_snapshot_members
             WHERE sheet_id=$1 AND parent_operation_id=$3::uuid) AS members`,
        [
          input.sheetId,
          [...plan.sections.map((section) => section.operationId), plan.snapshotOperationId],
          plan.snapshotOperationId,
        ],
      )
      expect(retryCounts.rows[0]).toEqual({ revisions: 9, operations: 10, members: 9 })
    })
  })

  test('D-I0 permits only one successful bootstrap generation per sheet', async () => {
    await withRolledBackTxn(async (client) => {
      const firstInput = await seedBuildingGeneration(client)
      const secondInput = await seedBuildingGeneration(client, true)
      const firstPlan = await reserveRecoveryArchiveSnapshotIdentities(asQuery(client), firstInput)
      const secondPlan = await reserveRecoveryArchiveSnapshotIdentities(asQuery(client), secondInput)

      await consumeRecoveryArchiveBootstrapReservations(asQuery(client), {
        ...firstInput,
        sections: di0Contents(),
      })
      const duplicate = await errorOf(
        consumeRecoveryArchiveBootstrapReservations(asQuery(client), {
          ...secondInput,
          sections: di0Contents(),
        }),
      )
      expect(duplicate).toBeInstanceOf(RecoveryArchiveSectionBootstrapError)
      expect((duplicate as RecoveryArchiveSectionBootstrapError).code).toBe(
        'RECOVERY_ARCHIVE_BOOTSTRAP_ALREADY_INITIALIZED',
      )
      expectValuesFree(duplicate, [firstInput.generationId, secondInput.generationId, firstInput.sheetId])

      const committed = await client.query(
        `SELECT
           (SELECT count(*)::int FROM meta_record_history_operations
             WHERE sheet_id=$1 AND operation_id=ANY($2::uuid[])) AS first_operations,
           (SELECT count(*)::int FROM meta_record_history_operations
             WHERE sheet_id=$1 AND operation_id=ANY($3::uuid[])) AS second_operations,
           (SELECT count(*)::int FROM meta_recovery_archive_section_bootstrap_markers
             WHERE sheet_id=$1 AND generation_id=$4::uuid
               AND snapshot_operation_id=$5::uuid) AS markers`,
        [
          firstInput.sheetId,
          [...firstPlan.sections.map((section) => section.operationId), firstPlan.snapshotOperationId],
          [...secondPlan.sections.map((section) => section.operationId), secondPlan.snapshotOperationId],
          firstInput.generationId,
          firstPlan.snapshotOperationId,
        ],
      )
      expect(committed.rows[0]).toEqual({ first_operations: 10, second_operations: 0, markers: 1 })

      await client.query('SAVEPOINT immutable_marker')
      const immutable = await errorOf(
        client.query(
          `UPDATE meta_recovery_archive_section_bootstrap_markers
              SET initialized_at=initialized_at + interval '1 second'
            WHERE sheet_id=$1`,
          [firstInput.sheetId],
        ),
      )
      expect(immutable.message).toBe('recovery_archive_section_bootstrap_marker_immutable')
      expectValuesFree(immutable, [firstInput.generationId, firstInput.sheetId])
      await client.query('ROLLBACK TO SAVEPOINT immutable_marker')

      await client.query('SAVEPOINT truncate_marker')
      const truncate = await errorOf(
        client.query('TRUNCATE TABLE meta_recovery_archive_section_bootstrap_markers'),
      )
      expect(truncate.message).toBe('recovery_archive_section_bootstrap_marker_immutable')
      expectValuesFree(truncate, [firstInput.generationId, firstInput.sheetId])
      await client.query('ROLLBACK TO SAVEPOINT truncate_marker')
    })
  })

  test('D-I0 keeps reservations unusable after the owning generation is abandoned', async () => {
    await withRolledBackTxn(async (client) => {
      const input = await seedBuildingGeneration(client)
      await reserveRecoveryArchiveSnapshotIdentities(asQuery(client), input)
      await client.query(
        `UPDATE meta_recovery_archives SET build_status='abandoned' WHERE generation_id=$1::uuid`,
        [input.generationId],
      )

      const error = await errorOf(
        consumeRecoveryArchiveBootstrapReservations(asQuery(client), { ...input, sections: di0Contents() }),
      )
      expect(error).toBeInstanceOf(RecoveryArchiveSectionBootstrapError)
      expect((error as RecoveryArchiveSectionBootstrapError).code).toBe(
        'RECOVERY_ARCHIVE_BOOTSTRAP_GENERATION_UNAVAILABLE',
      )
      const rows = await client.query(
        `SELECT count(*)::int AS count FROM meta_recovery_archive_snapshot_reservations
          WHERE generation_id=$1::uuid`,
        [input.generationId],
      )
      expect(rows.rows[0]?.count).toBe(10)
    })
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
      await db.destroy()
    }
  })

  test('parent FKs are DEFERRABLE INITIALLY DEFERRED and event_count=0 is legal only for archive_snapshot', async () => {
    const fks = await q(
      `SELECT constraint_row.conname, constraint_row.condeferrable, constraint_row.condeferred
         FROM pg_constraint constraint_row
         JOIN pg_class relation ON relation.oid=constraint_row.conrelid
         JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        WHERE namespace.nspname='public'
          AND constraint_row.conname IN ('fk_mssr_operation','fk_mrhsm_parent','fk_mrhsm_source','fk_mrhom_parent','fk_mrhom_child')
        ORDER BY constraint_row.conname`,
    )
    expect(fks.rows).toEqual([
      { conname: 'fk_mrhom_child', condeferrable: true, condeferred: true },
      { conname: 'fk_mrhom_parent', condeferrable: true, condeferred: true },
      { conname: 'fk_mrhsm_parent', condeferrable: true, condeferred: true },
      { conname: 'fk_mrhsm_source', condeferrable: true, condeferred: true },
      { conname: 'fk_mssr_operation', condeferrable: true, condeferred: true },
    ])
    const contract = await q(
      `SELECT pg_get_constraintdef(constraint_row.oid, true) AS definition
         FROM pg_constraint constraint_row
         JOIN pg_class relation ON relation.oid=constraint_row.conrelid
         JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        WHERE namespace.nspname='public'
          AND relation.relname='meta_record_history_operations'
          AND constraint_row.conname='chk_mrho_event_contract'`,
    )
    expect(String(contract.rows[0]?.definition)).toContain("operation_kind = 'archive_snapshot'")
    expect(String(contract.rows[0]?.definition)).toContain('event_count = 0')
  })

  test('legacy four-column ordinary seal is preserved as v1', async () => {
    const operationId = randomUUID()
    await withTxn(async (client) => {
      await insertRecordRevision(client, SHEET, operationId, UNION_REV_SEQ)
      await client.query(
        `INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count)
         VALUES ($1, $2::uuid, $3::bigint, 1)`,
        [SHEET, operationId, UNION_REV_SEQ],
      )
    })
    const row = await q(
      `SELECT operation_kind, event_contract_version::text, component_count, event_count, endpoint_seq::text
         FROM meta_record_history_operations
        WHERE sheet_id=$1 AND operation_id=$2::uuid`,
      [SHEET, operationId],
    )
    expect(row.rows).toEqual([
      {
        operation_kind: 'ordinary',
        event_contract_version: '1',
        component_count: null,
        event_count: 1,
        endpoint_seq: UNION_REV_SEQ,
      },
    ])
  })

  test('v2 ordinary count/max is the exact union of revisions, markers, and section revisions', async () => {
    const operationId = randomUUID()
    await withTxn(async (client) => {
      await insertRecordRevision(client, SHEET, operationId, UNION_REV_SEQ)
      await insertMarker(client, SHEET, operationId, UNION_MARK_SEQ)
      await client.query(
        `INSERT INTO meta_sheet_section_revisions (
           sheet_id, section_kind, entity_key, action, payload, seq, operation_id
         ) VALUES ($1, 'links', 'link/one', 'upsert', '{"ok":true}'::jsonb, $2::bigint, $3::uuid)`,
        [SHEET, UNION_SEC_SEQ, operationId],
      )
      await sealDirectEventOperation(asQuery(client), {
        sheetId: SHEET,
        operationId,
        endpointSeq: UNION_SEC_SEQ,
        eventCount: 3,
        operationKind: 'ordinary',
      })
    })
    const row = await q(
      `SELECT operation_kind, event_contract_version::text, event_count, endpoint_seq::text
         FROM meta_record_history_operations WHERE operation_id=$1::uuid`,
      [operationId],
    )
    expect(row.rows).toEqual([
      {
        operation_kind: 'ordinary',
        event_contract_version: '2',
        event_count: 3,
        endpoint_seq: UNION_SEC_SEQ,
      },
    ])
  })

  test('config/tombstone evidence rows do not count toward v2 event_count', async () => {
    const operationId = randomUUID()
    await withTxn(async (client) => {
      await insertRecordRevision(client, SHEET, operationId, UNION_REV_SEQ)
      await client.query(
        `INSERT INTO meta_sheet_section_revisions (
           sheet_id, section_kind, entity_key, action, payload, seq, operation_id
         ) VALUES ($1, 'links', 'link/one', 'upsert', '{"ok":true}'::jsonb, $2::bigint, $3::uuid)`,
        [SHEET, UNION_SEC_SEQ, operationId],
      )
      await client.query(
        `INSERT INTO meta_field_value_tombstones (
           sheet_id, field_id, record_id, value, reason
         ) VALUES ($1, $2, $3, '{"n":1}'::jsonb, 'field_delete')`,
        [SHEET, `${SHEET}_field`, `${SHEET}_record`],
      )
      await client.query(
        `INSERT INTO meta_link_tombstones (
           sheet_id, field_id, record_id, foreign_record_id, reason
         ) VALUES ($1, $2, $3, $4, 'record_delete')`,
        [SHEET, `${SHEET}_link`, `${SHEET}_record`, `${SHEET}_foreign`],
      )
      await client.query(
        `INSERT INTO meta_config_revisions (
           sheet_id, entity_type, entity_id, action, after
         ) VALUES ($1, 'field', $2, 'update', '{"ok":true}'::jsonb)`,
        [SHEET, `${SHEET}_field`],
      )
      await sealDirectEventOperation(asQuery(client), {
        sheetId: SHEET,
        operationId,
        endpointSeq: UNION_SEC_SEQ,
        eventCount: 2,
        operationKind: 'ordinary',
      })
    })
    const row = await q(`SELECT event_count FROM meta_record_history_operations WHERE operation_id=$1::uuid`, [
      operationId,
    ])
    expect(row.rows).toEqual([{ event_count: 2 }])

    const forged = await errorOf(
      withTxn(async (client) => {
        const extraId = randomUUID()
        await insertRecordRevision(client, SHEET, extraId, '9007199254744011', `${SHEET}_extra`)
        await client.query(
          `INSERT INTO meta_field_value_tombstones (
             sheet_id, field_id, record_id, value, reason
           ) VALUES ($1, $2, $3, '{"n":2}'::jsonb, 'field_delete')`,
          [SHEET, `${SHEET}_field2`, `${SHEET}_extra`],
        )
        await sealDirectEventOperation(asQuery(client), {
          sheetId: SHEET,
          operationId: extraId,
          endpointSeq: '9007199254744011',
          eventCount: 2,
          operationKind: 'ordinary',
        })
      }),
    )
    expect(forged.message).toBe('section_causality_direct_event_mismatch')
    expectValuesFree(forged, [SHEET, WORKSPACE, BASE])
  })

  test('records section events are legal only as bootstrap_snapshot', async () => {
    const error = await errorOf(
      withTxn(async (client) => {
        await client.query(
          `INSERT INTO meta_sheet_section_revisions (
             sheet_id, section_kind, entity_key, action, payload, seq, operation_id
           ) VALUES ($1, 'records', 'record/one', 'upsert', '{"ok":true}'::jsonb, $2::bigint, $3::uuid)`,
          [SHEET, UNION_SEC_SEQ, randomUUID()],
        )
      }),
    )
    expect(error.code).toBe('23514')
    expect(error.message).toBe('section_causality_records_requires_bootstrap')
    expectValuesFree(error, [SHEET, WORKSPACE, BASE])
  })

  test('coverage_index is not a live section kind', async () => {
    const error = await errorOf(
      withTxn(async (client) => {
        await client.query(
          `INSERT INTO meta_sheet_section_revisions (
             sheet_id, section_kind, entity_key, action, payload, seq, operation_id
           ) VALUES ($1, 'coverage_index', 'section/coverage_index', 'bootstrap_snapshot',
                     jsonb_build_object('row_count', '0'::text, 'source_hash', $2::text),
                     $3::bigint, $4::uuid)`,
          [SHEET, SHA256_A, UNION_SEC_SEQ, randomUUID()],
        )
      }),
    )
    expect(error.code).toBe('23514')
    expect(error.message).toBe('section_causality_section_kind_invalid')
    expectValuesFree(error, [SHEET, WORKSPACE, BASE, SHA256_A])
  })

  test('section_bootstrap seals exactly one bootstrap event and generic ordinary seal cannot mint it', async () => {
    const bootstrapId = randomUUID()
    await withTxn(async (client) => {
      await insertBootstrapRevision(client, SHEET, bootstrapId, 'schema', BOOTSTRAP_SEQ0, '0', SHA256_A)
      await sealSectionBootstrapOperation(asQuery(client), {
        sheetId: SHEET,
        operationId: bootstrapId,
        endpointSeq: BOOTSTRAP_SEQ0,
        sectionKind: 'schema',
        rowCount: '0',
        sourceHash: SHA256_A,
      })
    })
    const row = await q(
      `SELECT operation_kind, event_count, endpoint_seq::text
         FROM meta_record_history_operations WHERE operation_id=$1::uuid`,
      [bootstrapId],
    )
    expect(row.rows).toEqual([
      {
        operation_kind: 'section_bootstrap',
        event_count: 1,
        endpoint_seq: BOOTSTRAP_SEQ0,
      },
    ])

    const ledger = new OperationLedger(SHEET, randomUUID())
    ledger.track(UNION_REV_SEQ)
    const generic = await withTxn(async (client) => {
      await insertRecordRevision(client, SHEET, ledger.operationId as string, UNION_REV_SEQ)
      await sealOperation(asQuery(client), ledger)
      return client.query(
        `SELECT operation_kind, event_contract_version::text
           FROM meta_record_history_operations WHERE operation_id=$1::uuid`,
        [ledger.operationId],
      )
    })
    expect(generic.rows).toEqual([{ operation_kind: 'ordinary', event_contract_version: '1' }])
  })

  test('archive_snapshot inserts members first, parent last, with event_count=0', async () => {
    const snapshotId = randomUUID()
    await withTxn(async (client) => {
      const heads = await bootstrapAllSections(client, SHEET)
      await sealArchiveSnapshotOperation(asQuery(client), {
        sheetId: SHEET,
        operationId: snapshotId,
        endpointSeq: SNAPSHOT_SEQ,
        members: await snapshotMembersFor(SHEET, heads),
      })
    })
    const parent = await q(
      `SELECT operation_kind, event_count, component_count, endpoint_seq::text
         FROM meta_record_history_operations WHERE operation_id=$1::uuid`,
      [snapshotId],
    )
    expect(parent.rows).toEqual([
      {
        operation_kind: 'archive_snapshot',
        event_count: 0,
        component_count: 9,
        endpoint_seq: SNAPSHOT_SEQ,
      },
    ])
    const members = await q(
      `SELECT count(*)::int AS count, min(ordinal) AS min, max(ordinal) AS max
         FROM meta_record_history_snapshot_members WHERE parent_operation_id=$1::uuid`,
      [snapshotId],
    )
    expect(members.rows).toEqual([{ count: 9, min: 1, max: 9 }])
  })

  test('restore_aggregate stores the child sum/max and owns zero direct events', async () => {
    const chunk1 = randomUUID()
    const chunk2 = randomUUID()
    const aggregateId = randomUUID()
    await withTxn(async (client) => {
      await insertRecordRevision(client, SHEET, chunk1, CHUNK_SEQ_1, `${SHEET}_c1`)
      await sealDirectEventOperation(asQuery(client), {
        sheetId: SHEET,
        operationId: chunk1,
        endpointSeq: CHUNK_SEQ_1,
        eventCount: 1,
        operationKind: 'restore_chunk',
      })
      await insertRecordRevision(client, SHEET, chunk2, CHUNK_SEQ_2, `${SHEET}_c2`)
      await insertMarker(client, SHEET, chunk2, String(BigInt(CHUNK_SEQ_2) - 1n), `${SHEET}_c2`)
      await sealDirectEventOperation(asQuery(client), {
        sheetId: SHEET,
        operationId: chunk2,
        endpointSeq: CHUNK_SEQ_2,
        eventCount: 2,
        operationKind: 'restore_chunk',
      })
      await sealRestoreAggregateOperation(asQuery(client), {
        sheetId: SHEET,
        operationId: aggregateId,
        endpointSeq: CHUNK_SEQ_2,
        members: [
          {
            ordinal: 1,
            childOperationId: chunk1,
            childEndpointSeq: CHUNK_SEQ_1,
            childEventCount: 1,
          },
          {
            ordinal: 2,
            childOperationId: chunk2,
            childEndpointSeq: CHUNK_SEQ_2,
            childEventCount: 2,
          },
        ],
      })
    })
    const row = await q(
      `SELECT operation_kind, event_count, component_count, endpoint_seq::text
         FROM meta_record_history_operations WHERE operation_id=$1::uuid`,
      [aggregateId],
    )
    expect(row.rows).toEqual([
      {
        operation_kind: 'restore_aggregate',
        event_count: 3,
        component_count: 2,
        endpoint_seq: CHUNK_SEQ_2,
      },
    ])
    const direct = await q(
      `SELECT
         (SELECT count(*)::int FROM meta_record_revisions WHERE operation_id=$1::uuid) AS revisions,
         (SELECT count(*)::int FROM meta_record_version_markers WHERE operation_id=$1::uuid) AS markers,
         (SELECT count(*)::int FROM meta_sheet_section_revisions WHERE operation_id=$1::uuid) AS sections`,
      [aggregateId],
    )
    expect(direct.rows).toEqual([{ revisions: 0, markers: 0, sections: 0 }])
  })

  test('each synthetic parent refuses rows from the other membership table', async () => {
    const snapshotId = randomUUID()
    const snapshotError = await errorOf(
      withTxn(async (client) => {
        const heads = await bootstrapAllSections(client, SHEET)
        const chunkId = randomUUID()
        await insertRecordRevision(client, SHEET, chunkId, CHUNK_SEQ_1, `${SHEET}_mixed_snapshot`)
        await sealDirectEventOperation(asQuery(client), {
          sheetId: SHEET,
          operationId: chunkId,
          endpointSeq: CHUNK_SEQ_1,
          eventCount: 1,
          operationKind: 'restore_chunk',
        })
        for (const member of await snapshotMembersFor(SHEET, heads)) {
          await client.query(
            `INSERT INTO meta_record_history_snapshot_members (
               sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
               source_operation_id, source_head_seq, row_count, source_hash
             ) VALUES ($1, $2::uuid, $3::int, $4, $5, $6::uuid, $7::bigint, $8::bigint, $9)`,
            [
              SHEET,
              snapshotId,
              member.ordinal,
              member.sectionKind,
              member.sourceHeadKind,
              member.sourceOperationId,
              member.sourceHeadSeq,
              member.rowCount,
              member.sourceHash,
            ],
          )
        }
        await client.query(
          `INSERT INTO meta_record_history_operation_members (
             sheet_id, parent_operation_id, ordinal, child_operation_id,
             child_endpoint_seq, child_event_count
           ) VALUES ($1, $2::uuid, 1, $3::uuid, $4::bigint, 1)`,
          [SHEET, snapshotId, chunkId, CHUNK_SEQ_1],
        )
        await client.query(
          `INSERT INTO meta_record_history_operations (
             sheet_id, operation_id, endpoint_seq, event_count,
             operation_kind, event_contract_version, component_count
           ) VALUES ($1, $2::uuid, $3::bigint, 0, 'archive_snapshot', 2, 9)`,
          [SHEET, snapshotId, SNAPSHOT_SEQ],
        )
      }),
    )
    expect(snapshotError.message).toBe('section_causality_snapshot_membership_invalid')
    expectValuesFree(snapshotError, [SHEET, WORKSPACE, BASE, snapshotId])

    const aggregateId = randomUUID()
    const aggregateError = await errorOf(
      withTxn(async (client) => {
        const bootstrapId = await sealBootstrapHead(client, SHEET, 'schema', BOOTSTRAP_SEQ0)
        const chunkId = randomUUID()
        await insertRecordRevision(client, SHEET, chunkId, CHUNK_SEQ_1, `${SHEET}_mixed_aggregate`)
        await sealDirectEventOperation(asQuery(client), {
          sheetId: SHEET,
          operationId: chunkId,
          endpointSeq: CHUNK_SEQ_1,
          eventCount: 1,
          operationKind: 'restore_chunk',
        })
        await client.query(
          `INSERT INTO meta_record_history_operation_members (
             sheet_id, parent_operation_id, ordinal, child_operation_id,
             child_endpoint_seq, child_event_count
           ) VALUES ($1, $2::uuid, 1, $3::uuid, $4::bigint, 1)`,
          [SHEET, aggregateId, chunkId, CHUNK_SEQ_1],
        )
        await client.query(
          `INSERT INTO meta_record_history_snapshot_members (
             sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
             source_operation_id, source_head_seq, row_count, source_hash
           ) VALUES ($1, $2::uuid, 1, 'schema', 'section_bootstrap', $3::uuid, $4::bigint, 0, $5)`,
          [SHEET, aggregateId, bootstrapId, BOOTSTRAP_SEQ0, SHA256_A],
        )
        await client.query(
          `INSERT INTO meta_record_history_operations (
             sheet_id, operation_id, endpoint_seq, event_count,
             operation_kind, event_contract_version, component_count
           ) VALUES ($1, $2::uuid, $3::bigint, 1, 'restore_aggregate', 2, 1)`,
          [SHEET, aggregateId, CHUNK_SEQ_1],
        )
      }),
    )
    expect(aggregateError.message).toBe('section_causality_aggregate_membership_invalid')
    expectValuesFree(aggregateError, [SHEET, WORKSPACE, BASE, aggregateId])
  })

  test('legacy, direct-event, and bootstrap parents refuse synthetic membership rows', async () => {
    const legacyError = await errorOf(
      withTxn(async (client) => {
        const sourceId = await sealBootstrapHead(client, SHEET, 'schema', BOOTSTRAP_SEQ0)
        const operationId = randomUUID()
        await client.query(
          `INSERT INTO meta_record_history_snapshot_members (
             sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
             source_operation_id, source_head_seq, row_count, source_hash
           ) VALUES ($1, $2::uuid, 1, 'schema', 'section_bootstrap', $3::uuid, $4::bigint, 0, $5)`,
          [SHEET, operationId, sourceId, BOOTSTRAP_SEQ0, SHA256_A],
        )
        await insertRecordRevision(client, SHEET, operationId, UNION_REV_SEQ, `${SHEET}_legacy_member`)
        await client.query(
          `INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count)
           VALUES ($1, $2::uuid, $3::bigint, 1)`,
          [SHEET, operationId, UNION_REV_SEQ],
        )
      }),
    )
    expect(legacyError.message).toBe('section_causality_legacy_contract_invalid')

    const directError = await errorOf(
      withTxn(async (client) => {
        const childId = randomUUID()
        await insertRecordRevision(client, SHEET, childId, CHUNK_SEQ_1, `${SHEET}_direct_child`)
        await sealDirectEventOperation(asQuery(client), {
          sheetId: SHEET,
          operationId: childId,
          endpointSeq: CHUNK_SEQ_1,
          eventCount: 1,
          operationKind: 'restore_chunk',
        })
        const operationId = randomUUID()
        await client.query(
          `INSERT INTO meta_record_history_operation_members (
             sheet_id, parent_operation_id, ordinal, child_operation_id,
             child_endpoint_seq, child_event_count
           ) VALUES ($1, $2::uuid, 1, $3::uuid, $4::bigint, 1)`,
          [SHEET, operationId, childId, CHUNK_SEQ_1],
        )
        await insertRecordRevision(client, SHEET, operationId, CHUNK_SEQ_2, `${SHEET}_direct_parent`)
        await sealDirectEventOperation(asQuery(client), {
          sheetId: SHEET,
          operationId,
          endpointSeq: CHUNK_SEQ_2,
          eventCount: 1,
          operationKind: 'restore_chunk',
        })
      }),
    )
    expect(directError.message).toBe('section_causality_direct_event_mismatch')

    const bootstrapError = await errorOf(
      withTxn(async (client) => {
        const sourceId = await sealBootstrapHead(client, SHEET, 'links', BOOTSTRAP_SEQ0)
        const operationId = randomUUID()
        await client.query(
          `INSERT INTO meta_record_history_snapshot_members (
             sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
             source_operation_id, source_head_seq, row_count, source_hash
           ) VALUES ($1, $2::uuid, 1, 'links', 'section_bootstrap', $3::uuid, $4::bigint, 0, $5)`,
          [SHEET, operationId, sourceId, BOOTSTRAP_SEQ0, SHA256_A],
        )
        await insertBootstrapRevision(client, SHEET, operationId, 'schema', CHUNK_SEQ_1, '0', SHA256_A)
        await client.query(
          `INSERT INTO meta_record_history_operations (
             sheet_id, operation_id, endpoint_seq, event_count,
             operation_kind, event_contract_version, component_count
           ) VALUES ($1, $2::uuid, $3::bigint, 1, 'section_bootstrap', 2, NULL)`,
          [SHEET, operationId, CHUNK_SEQ_1],
        )
      }),
    )
    expect(bootstrapError.message).toBe('section_causality_bootstrap_invalid')
    expectValuesFree(legacyError, [SHEET, WORKSPACE, BASE])
    expectValuesFree(directError, [SHEET, WORKSPACE, BASE])
    expectValuesFree(bootstrapError, [SHEET, WORKSPACE, BASE])
  })

  test('generic helper misuse cannot mint synthetic kinds', async () => {
    const client = await pool.connect()
    try {
      await expect(
        sealDirectEventOperation(asQuery(client), {
          sheetId: SHEET,
          operationId: randomUUID(),
          endpointSeq: SNAPSHOT_SEQ,
          eventCount: 1,
          operationKind: 'archive_snapshot',
        }),
      ).rejects.toMatchObject({
        name: 'RecoveryArchiveSealError',
        code: 'SECTION_CAUSALITY_SYNTHETIC_KIND_FORBIDDEN',
        message: 'SECTION_CAUSALITY_SYNTHETIC_KIND_FORBIDDEN',
      })
      await expect(
        sealDirectEventOperation(asQuery(client), {
          sheetId: SHEET,
          operationId: randomUUID(),
          endpointSeq: SNAPSHOT_SEQ,
          eventCount: 1,
          operationKind: 'restore_aggregate',
        }),
      ).rejects.toMatchObject({
        code: 'SECTION_CAUSALITY_SYNTHETIC_KIND_FORBIDDEN',
      })
      await expect(
        sealDirectEventOperation(asQuery(client), {
          sheetId: SHEET,
          operationId: randomUUID(),
          endpointSeq: SNAPSHOT_SEQ,
          eventCount: 1,
          operationKind: 'section_bootstrap',
        }),
      ).rejects.toMatchObject({
        code: 'SECTION_CAUSALITY_BOOTSTRAP_HELPER_REQUIRED',
        message: 'SECTION_CAUSALITY_BOOTSTRAP_HELPER_REQUIRED',
      })
    } finally {
      client.release()
    }
  })

  test('snapshot parent cannot seal before its members exist', async () => {
    const error = await errorOf(
      withTxn(async (client) => {
        const snapshotId = randomUUID()
        await client.query(
          `INSERT INTO meta_record_history_operations (
             sheet_id, operation_id, endpoint_seq, event_count,
             operation_kind, event_contract_version, component_count
           ) VALUES ($1, $2::uuid, $3::bigint, 0, 'archive_snapshot', 2, 9)`,
          [SHEET, snapshotId, SNAPSHOT_SEQ],
        )
      }),
    )
    expect(error.message).toBe('section_causality_snapshot_membership_invalid')
    expectValuesFree(error, [SHEET, WORKSPACE, BASE])
  })

  test('missing, duplicate, and foreign snapshot members are refused', async () => {
    const missing = await errorOf(
      withTxn(async (client) => {
        const heads = await bootstrapAllSections(client, SHEET)
        const snapshotId = randomUUID()
        const members = (await snapshotMembersFor(SHEET, heads)).slice(0, 8)
        for (const member of members) {
          await client.query(
            `INSERT INTO meta_record_history_snapshot_members (
               sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
               source_operation_id, source_head_seq, row_count, source_hash
             ) VALUES ($1, $2::uuid, $3::int, $4, $5, $6::uuid, $7::bigint, $8::bigint, $9)`,
            [
              SHEET,
              snapshotId,
              member.ordinal,
              member.sectionKind,
              member.sourceHeadKind,
              member.sourceOperationId,
              member.sourceHeadSeq,
              member.rowCount,
              member.sourceHash,
            ],
          )
        }
        await client.query(
          `INSERT INTO meta_record_history_operations (
             sheet_id, operation_id, endpoint_seq, event_count,
             operation_kind, event_contract_version, component_count
           ) VALUES ($1, $2::uuid, $3::bigint, 0, 'archive_snapshot', 2, 9)`,
          [SHEET, snapshotId, SNAPSHOT_SEQ],
        )
      }),
    )
    expect(missing.message).toBe('section_causality_snapshot_membership_invalid')

    const duplicate = await errorOf(
      withTxn(async (client) => {
        const heads = await bootstrapAllSections(client, SHEET)
        const snapshotId = randomUUID()
        await client.query(
          `INSERT INTO meta_record_history_snapshot_members (
             sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
             source_operation_id, source_head_seq, row_count, source_hash
           ) VALUES
             ($1, $2::uuid, 1, 'schema', 'section_bootstrap', $3::uuid, $4::bigint, 0, $5),
             ($1, $2::uuid, 2, 'schema', 'section_bootstrap', $6::uuid, $7::bigint, 0, $5)`,
          [SHEET, snapshotId, heads[0]?.operationId, heads[0]?.seq, SHA256_A, heads[1]?.operationId, heads[1]?.seq],
        )
      }),
    )
    expect(duplicate.code).toBe('23505')

    const foreign = await errorOf(
      withTxn(async (client) => {
        const heads = await bootstrapAllSections(client, SHEET)
        const foreignHead = await sealBootstrapHead(client, OTHER_SHEET, 'schema', bootstrapSeq(0), '0', SHA256_B)
        const snapshotId = randomUUID()
        const members = await snapshotMembersFor(SHEET, heads)
        members[0] = { ...members[0], sourceOperationId: foreignHead }
        await sealArchiveSnapshotOperation(asQuery(client), {
          sheetId: SHEET,
          operationId: snapshotId,
          endpointSeq: SNAPSHOT_SEQ,
          members,
        })
      }),
    )
    expect(foreign).toMatchObject({
      message: 'SECTION_CAUSALITY_SOURCE_HEAD_MISMATCH',
    })
    expectValuesFree(foreign, [SHEET, OTHER_SHEET, WORKSPACE, BASE])
  })

  test('forged snapshot count, max, and hash are refused', async () => {
    const forgedHash = await errorOf(
      withTxn(async (client) => {
        const heads = await bootstrapAllSections(client, SHEET)
        const members = await snapshotMembersFor(SHEET, heads)
        members[3] = { ...members[3], sourceHash: SHA256_B }
        await sealArchiveSnapshotOperation(asQuery(client), {
          sheetId: SHEET,
          operationId: randomUUID(),
          endpointSeq: SNAPSHOT_SEQ,
          members,
        })
      }),
    )
    expect(forgedHash.message).toBe('section_causality_snapshot_membership_invalid')

    const forgedMax = await errorOf(
      withTxn(async (client) => {
        const heads = await bootstrapAllSections(client, SHEET)
        const members = await snapshotMembersFor(SHEET, heads)
        const snapshotId = randomUUID()
        for (const member of members) {
          await client.query(
            `INSERT INTO meta_record_history_snapshot_members (
               sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
               source_operation_id, source_head_seq, row_count, source_hash
             ) VALUES ($1, $2::uuid, $3::int, $4, $5, $6::uuid, $7::bigint, $8::bigint, $9)`,
            [
              SHEET,
              snapshotId,
              member.ordinal,
              member.sectionKind,
              member.sourceHeadKind,
              member.sourceOperationId,
              member.sourceHeadSeq,
              member.rowCount,
              member.sourceHash,
            ],
          )
        }
        await client.query(
          `INSERT INTO meta_record_history_operations (
             sheet_id, operation_id, endpoint_seq, event_count,
             operation_kind, event_contract_version, component_count
           ) VALUES ($1, $2::uuid, $3::bigint, 0, 'archive_snapshot', 2, 9)`,
          [SHEET, snapshotId, bootstrapSeq(0)],
        )
      }),
    )
    expect(forgedMax.message).toBe('section_causality_snapshot_membership_invalid')

    const forgedCount = await errorOf(
      withTxn(async (client) => {
        await client.query(
          `INSERT INTO meta_record_history_operations (
             sheet_id, operation_id, endpoint_seq, event_count,
             operation_kind, event_contract_version, component_count
           ) VALUES ($1, $2::uuid, $3::bigint, 0, 'archive_snapshot', 2, 8)`,
          [SHEET, randomUUID(), SNAPSHOT_SEQ],
        )
      }),
    )
    expect(forgedCount.code).toBe('23514')
    expect(forgedCount.message).toBe('section_causality_snapshot_direct_events_forbidden')
  })

  test('event_count>=1 lift is load-bearing for archive_snapshot', async () => {
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          ALTER TABLE public.meta_record_history_operations
            DROP CONSTRAINT chk_mrho_event_contract
        `.execute(trx)
        await sql`
          ALTER TABLE public.meta_record_history_operations
            ADD CONSTRAINT chk_mrho_event_count_positive CHECK (event_count >= 1)
        `.execute(trx)
        const heads = []
        for (const [index, sectionKind] of SECTION_CAUSALITY_DATA_SECTION_KINDS.entries()) {
          const seq = bootstrapSeq(index)
          const operationId = randomUUID()
          await sql`
            INSERT INTO meta_sheet_section_revisions (
              sheet_id, section_kind, entity_key, action, payload, seq, operation_id
            ) VALUES (
              ${SHEET}, ${sectionKind}, ${bootstrapSectionEntityKey(sectionKind)}, 'bootstrap_snapshot',
              jsonb_build_object('row_count', '0'::text, 'source_hash', ${SHA256_A}::text),
              ${seq}::bigint, ${operationId}::uuid
            )
          `.execute(trx)
          await sql`
            INSERT INTO meta_record_history_operations (
              sheet_id, operation_id, endpoint_seq, event_count,
              operation_kind, event_contract_version, component_count
            ) VALUES (
              ${SHEET}, ${operationId}::uuid, ${seq}::bigint, 1, 'section_bootstrap', 2, NULL
            )
          `.execute(trx)
          heads.push({ sectionKind, operationId, seq })
        }
        const snapshotId = randomUUID()
        for (const [index, head] of heads.entries()) {
          await sql`
            INSERT INTO meta_record_history_snapshot_members (
              sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
              source_operation_id, source_head_seq, row_count, source_hash
            ) VALUES (
              ${SHEET}, ${snapshotId}::uuid, ${index + 1}::int, ${head.sectionKind},
              'section_bootstrap', ${head.operationId}::uuid, ${head.seq}::bigint, 0, ${SHA256_A}
            )
          `.execute(trx)
        }
        await sql`
          INSERT INTO meta_record_history_operations (
             sheet_id, operation_id, endpoint_seq, event_count,
             operation_kind, event_contract_version, component_count
           ) VALUES (
            ${SHEET}, ${snapshotId}::uuid, ${SNAPSHOT_SEQ}::bigint, 0,
            'archive_snapshot', 2, 9
          )
        `.execute(trx)
        throw new Error('section_causality_event_count_lift_missing')
      }),
    )
    expect(refusal.code).toBe('23514')
    expect(refusal.constraint).toBe('chk_mrho_event_count_positive')
    expect(await causalityFingerprint()).toBe(initialFingerprint)
  })

  test('parent-FK deferrability is load-bearing for members-before-parent', async () => {
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          ALTER TABLE public.meta_record_history_snapshot_members
            DROP CONSTRAINT fk_mrhsm_parent
        `.execute(trx)
        await sql`
          ALTER TABLE public.meta_record_history_snapshot_members
            ADD CONSTRAINT fk_mrhsm_parent
            FOREIGN KEY (sheet_id, parent_operation_id)
            REFERENCES public.meta_record_history_operations (sheet_id, operation_id)
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_history_snapshot_members (
            sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
            source_operation_id, source_head_seq, row_count, source_hash
          ) VALUES (
            ${SHEET}, ${randomUUID()}::uuid, 1, 'schema', 'section_bootstrap',
            ${randomUUID()}::uuid, ${BOOTSTRAP_SEQ0}::bigint, 0, ${SHA256_A}
          )
        `.execute(trx)
        throw new Error('section_causality_parent_fk_deferrability_missing')
      }),
    )
    expect(refusal.code).toBe('23503')
    expect(await causalityFingerprint()).toBe(initialFingerprint)
  })

  test('nonempty down refuses without partial drop; empty down/up restores the fingerprint', async () => {
    await withTxn(async (client) => {
      await sealBootstrapHead(client, SHEET, 'schema', BOOTSTRAP_SEQ0)
    })
    const refusal = await errorOf(db.transaction().execute(async (trx) => sectionCausalityMigration.down(trx)))
    expect(refusal.message).toBe('section_causality_catalog_nonempty')
    expectValuesFree(refusal, [SHEET, WORKSPACE, BASE])
    expect(await causalityFingerprint()).toBe(initialFingerprint)

    await cleanupSheetRows()
    await sectionCausalityMigration.down(db)
    schemaIsUp = false
    try {
      const original = await q(
        `SELECT procedure_row.proname,
                md5(procedure_row.prosrc) AS src_md5,
                coalesce(array_to_string(procedure_row.proconfig, ','), '') AS proconfig
           FROM pg_proc procedure_row
           JOIN pg_namespace namespace ON namespace.oid=procedure_row.pronamespace
          WHERE namespace.nspname='public'
            AND procedure_row.proname IN (
              'meta_record_history_operations_validate_endpoint',
              'meta_record_history_operations_prune'
            )
          ORDER BY procedure_row.proname`,
      )
      expect(original.rows).toEqual([
        {
          proname: 'meta_record_history_operations_prune',
          src_md5: '1fc85d4dfe0533bba039e9b5f3caf326',
          proconfig: '',
        },
        {
          proname: 'meta_record_history_operations_validate_endpoint',
          src_md5: '358f7ecffad2b3a6e7270448e1a1ff4f',
          proconfig: '',
        },
      ])
      const lifted = await q(
        `SELECT conname FROM pg_constraint constraint_row
           JOIN pg_class relation ON relation.oid=constraint_row.conrelid
           JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname='public'
            AND relation.relname='meta_record_history_operations'
            AND constraint_row.conname='chk_mrho_event_count_positive'`,
      )
      expect(lifted.rows).toEqual([{ conname: 'chk_mrho_event_count_positive' }])
      await sectionCausalityMigration.up(db)
      schemaIsUp = true
      expect(await causalityFingerprint()).toBe(initialFingerprint)
    } finally {
      if (!schemaIsUp) {
        await sectionCausalityMigration.up(db)
        schemaIsUp = true
      }
    }
  })

  test('membership INSERT is legal before seal and refused after the parent exists', async () => {
    const aggregateId = randomUUID()
    const chunk1 = randomUUID()
    const extraChunk = randomUUID()
    await withTxn(async (client) => {
      await insertRecordRevision(client, SHEET, chunk1, CHUNK_SEQ_1, `${SHEET}_c1`)
      await sealDirectEventOperation(asQuery(client), {
        sheetId: SHEET,
        operationId: chunk1,
        endpointSeq: CHUNK_SEQ_1,
        eventCount: 1,
        operationKind: 'restore_chunk',
      })
      await insertRecordRevision(client, SHEET, extraChunk, CHUNK_SEQ_2, `${SHEET}_extra`)
      await sealDirectEventOperation(asQuery(client), {
        sheetId: SHEET,
        operationId: extraChunk,
        endpointSeq: CHUNK_SEQ_2,
        eventCount: 1,
        operationKind: 'restore_chunk',
      })
      await sealRestoreAggregateOperation(asQuery(client), {
        sheetId: SHEET,
        operationId: aggregateId,
        endpointSeq: CHUNK_SEQ_1,
        members: [
          {
            ordinal: 1,
            childOperationId: chunk1,
            childEndpointSeq: CHUNK_SEQ_1,
            childEventCount: 1,
          },
        ],
      })
    })
    const afterSeal = await errorOf(
      q(
        `INSERT INTO meta_record_history_operation_members (
           sheet_id, parent_operation_id, ordinal, child_operation_id,
           child_endpoint_seq, child_event_count
         ) VALUES ($1, $2::uuid, 2, $3::uuid, $4::bigint, 1)`,
        [SHEET, aggregateId, extraChunk, CHUNK_SEQ_2],
      ),
    )
    expect(afterSeal.message).toBe('section_causality_membership_sealed')
    expectValuesFree(afterSeal, [SHEET, WORKSPACE, BASE, aggregateId])

    const snapshotId = randomUUID()
    await withTxn(async (client) => {
      const heads = await bootstrapAllSections(client, SHEET)
      await sealArchiveSnapshotOperation(asQuery(client), {
        sheetId: SHEET,
        operationId: snapshotId,
        endpointSeq: SNAPSHOT_SEQ,
        members: await snapshotMembersFor(SHEET, heads),
      })
    })
    const extraSnapshot = await errorOf(
      q(
        `INSERT INTO meta_record_history_snapshot_members (
           sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
           source_operation_id, source_head_seq, row_count, source_hash
         ) VALUES ($1, $2::uuid, 10, 'schema', 'section_bootstrap', $3::uuid, $4::bigint, 0, $5)`,
        [SHEET, snapshotId, randomUUID(), BOOTSTRAP_SEQ0, SHA256_A],
      ),
    )
    expect(extraSnapshot.message).toBe('section_causality_membership_sealed')
  })

  test('whole-operation prune removes snapshot members first and refuses a still-referenced source', async () => {
    let heads: Awaited<ReturnType<typeof bootstrapAllSections>> = []
    const prunedSnapshotId = randomUUID()
    await withTxn(async (client) => {
      heads = await bootstrapAllSections(client, SHEET)
      await sealArchiveSnapshotOperation(asQuery(client), {
        sheetId: SHEET,
        operationId: prunedSnapshotId,
        endpointSeq: SNAPSHOT_SEQ,
        members: await snapshotMembersFor(SHEET, heads),
      })
    })
    const before = await q(
      `SELECT
         (SELECT count(*)::int FROM meta_record_history_operations
           WHERE sheet_id=$1 AND operation_id=$2::uuid) AS parent_count,
         (SELECT count(*)::int FROM meta_record_history_snapshot_members
           WHERE sheet_id=$1 AND parent_operation_id=$2::uuid) AS member_count`,
      [SHEET, prunedSnapshotId],
    )
    expect(before.rows).toEqual([{ parent_count: 1, member_count: 9 }])

    await q('SELECT meta_record_history_operations_prune($1, $2::uuid)', [SHEET, prunedSnapshotId])
    const after = await q(
      `SELECT
         (SELECT count(*)::int FROM meta_record_history_operations
           WHERE sheet_id=$1 AND operation_id=$2::uuid) AS parent_count,
         (SELECT count(*)::int FROM meta_record_history_snapshot_members
           WHERE sheet_id=$1 AND parent_operation_id=$2::uuid) AS member_count`,
      [SHEET, prunedSnapshotId],
    )
    expect(after.rows).toEqual([{ parent_count: 0, member_count: 0 }])

    const retainedSnapshotId = randomUUID()
    await withTxn(async (client) => {
      await sealArchiveSnapshotOperation(asQuery(client), {
        sheetId: SHEET,
        operationId: retainedSnapshotId,
        endpointSeq: SNAPSHOT_SEQ,
        members: await snapshotMembersFor(SHEET, heads),
      })
    })
    const sourceOperationId = heads[0]!.operationId
    const refusal = await errorOf(
      withTxn(async (client) => {
        await client.query('SELECT meta_record_history_operations_prune($1, $2::uuid)', [
          SHEET,
          sourceOperationId,
        ])
      }),
    )
    expect(refusal.code).toBe('23503')
    expect(refusal.constraint).toBe('fk_mrhsm_source')
    const retained = await q(
      `SELECT
         (SELECT count(*)::int FROM meta_record_history_operations
           WHERE sheet_id=$1 AND operation_id=$2::uuid) AS source_count,
         (SELECT count(*)::int FROM meta_sheet_section_revisions
           WHERE sheet_id=$1 AND operation_id=$2::uuid) AS source_revision_count,
         (SELECT count(*)::int FROM meta_record_history_snapshot_members
           WHERE sheet_id=$1 AND parent_operation_id=$3::uuid) AS member_count`,
      [SHEET, sourceOperationId, retainedSnapshotId],
    )
    expect(retained.rows).toEqual([{ source_count: 1, source_revision_count: 1, member_count: 9 }])
  })

  test('a concurrent transaction cannot append membership while the parent seal is uncommitted', async () => {
    const aggregateId = randomUUID()
    const chunk1 = randomUUID()
    const extraChunk = randomUUID()
    await withTxn(async (client) => {
      await insertRecordRevision(client, SHEET, chunk1, CHUNK_SEQ_1, `${SHEET}_race_c1`)
      await sealDirectEventOperation(asQuery(client), {
        sheetId: SHEET,
        operationId: chunk1,
        endpointSeq: CHUNK_SEQ_1,
        eventCount: 1,
        operationKind: 'restore_chunk',
      })
      await insertRecordRevision(client, SHEET, extraChunk, CHUNK_SEQ_2, `${SHEET}_race_c2`)
      await sealDirectEventOperation(asQuery(client), {
        sheetId: SHEET,
        operationId: extraChunk,
        endpointSeq: CHUNK_SEQ_2,
        eventCount: 1,
        operationKind: 'restore_chunk',
      })
    })

    const sealer = await pool.connect()
    const lateWriter = await pool.connect()
    let sealerOpen = false
    let lateWriterOpen = false
    try {
      await sealer.query('BEGIN')
      sealerOpen = true
      await sealer.query(
        `INSERT INTO meta_record_history_operation_members (
           sheet_id, parent_operation_id, ordinal, child_operation_id,
           child_endpoint_seq, child_event_count
         ) VALUES ($1, $2::uuid, 1, $3::uuid, $4::bigint, 1)`,
        [SHEET, aggregateId, chunk1, CHUNK_SEQ_1],
      )
      await sealer.query(
        `INSERT INTO meta_record_history_operations (
           sheet_id, operation_id, endpoint_seq, event_count,
           operation_kind, event_contract_version, component_count
         ) VALUES ($1, $2::uuid, $3::bigint, 1, 'restore_aggregate', 2, 1)`,
        [SHEET, aggregateId, CHUNK_SEQ_1],
      )

      await lateWriter.query('BEGIN')
      lateWriterOpen = true
      const concurrentError = await errorOf(
        lateWriter.query(
          `INSERT INTO meta_record_history_operation_members (
             sheet_id, parent_operation_id, ordinal, child_operation_id,
             child_endpoint_seq, child_event_count
           ) VALUES ($1, $2::uuid, 2, $3::uuid, $4::bigint, 1)`,
          [SHEET, aggregateId, extraChunk, CHUNK_SEQ_2],
        ),
      )
      expect(concurrentError.code).toBe('40001')
      expect(concurrentError.message).toBe('section_causality_membership_busy')
      expectValuesFree(concurrentError, [SHEET, WORKSPACE, BASE, aggregateId])
      await lateWriter.query('ROLLBACK')
      lateWriterOpen = false

      await sealer.query('COMMIT')
      sealerOpen = false
      const sealed = await q(
        `SELECT operation_row.component_count,
                COUNT(member_row.ordinal)::int AS member_count
           FROM meta_record_history_operations operation_row
           LEFT JOIN meta_record_history_operation_members member_row
             ON member_row.sheet_id = operation_row.sheet_id
            AND member_row.parent_operation_id = operation_row.operation_id
          WHERE operation_row.sheet_id = $1
            AND operation_row.operation_id = $2::uuid
          GROUP BY operation_row.component_count`,
        [SHEET, aggregateId],
      )
      expect(sealed.rows).toEqual([{ component_count: 1, member_count: 1 }])
    } finally {
      if (lateWriterOpen) await lateWriter.query('ROLLBACK').catch(() => {})
      if (sealerOpen) await sealer.query('ROLLBACK').catch(() => {})
      lateWriter.release()
      sealer.release()
    }
  })

  test('a membership writer cannot race ahead after a direct parent has started sealing', async () => {
    const sourceId = await withTxn((client) => sealBootstrapHead(client, SHEET, 'schema', BOOTSTRAP_SEQ0))
    const operationId = randomUUID()
    const sealer = await pool.connect()
    const lateWriter = await pool.connect()
    let sealerOpen = false
    let lateWriterOpen = false
    try {
      await sealer.query('BEGIN')
      sealerOpen = true
      await insertRecordRevision(sealer, SHEET, operationId, UNION_REV_SEQ, `${SHEET}_parent_lock`)
      await sealer.query(
        `INSERT INTO meta_record_history_operations (
           sheet_id, operation_id, endpoint_seq, event_count,
           operation_kind, event_contract_version, component_count
         ) VALUES ($1, $2::uuid, $3::bigint, 1, 'ordinary', 2, NULL)`,
        [SHEET, operationId, UNION_REV_SEQ],
      )

      await lateWriter.query('BEGIN')
      lateWriterOpen = true
      const concurrentError = await errorOf(
        lateWriter.query(
          `INSERT INTO meta_record_history_snapshot_members (
             sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
             source_operation_id, source_head_seq, row_count, source_hash
           ) VALUES ($1, $2::uuid, 1, 'schema', 'section_bootstrap', $3::uuid, $4::bigint, 0, $5)`,
          [SHEET, operationId, sourceId, BOOTSTRAP_SEQ0, SHA256_A],
        ),
      )
      expect(concurrentError.code).toBe('40001')
      expect(concurrentError.message).toBe('section_causality_membership_busy')
      expectValuesFree(concurrentError, [SHEET, WORKSPACE, BASE, operationId])
      await lateWriter.query('ROLLBACK')
      lateWriterOpen = false

      await sealer.query('COMMIT')
      sealerOpen = false
      const sealed = await q(
        `SELECT operation_kind,
                (SELECT count(*)::int
                   FROM meta_record_history_snapshot_members member_row
                  WHERE member_row.sheet_id = operation_row.sheet_id
                    AND member_row.parent_operation_id = operation_row.operation_id) AS member_count
           FROM meta_record_history_operations operation_row
          WHERE operation_row.sheet_id = $1
            AND operation_row.operation_id = $2::uuid`,
        [SHEET, operationId],
      )
      expect(sealed.rows).toEqual([{ operation_kind: 'ordinary', member_count: 0 }])
    } finally {
      if (lateWriterOpen) await lateWriter.query('ROLLBACK').catch(() => {})
      if (sealerOpen) await sealer.query('ROLLBACK').catch(() => {})
      lateWriter.release()
      sealer.release()
    }
  })

  test('removing the membership INSERT arm lets a sealed parent grow and reds', async () => {
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          CREATE OR REPLACE FUNCTION public.meta_record_history_membership_guard_row()
          RETURNS trigger
          LANGUAGE plpgsql
          SET search_path = pg_catalog, public
          AS $fn$
          BEGIN
            IF TG_OP = 'UPDATE' THEN
              RAISE EXCEPTION USING
                ERRCODE = '55000',
                MESSAGE = 'section_causality_membership_immutable';
            END IF;
            IF TG_OP = 'DELETE' THEN
              IF current_setting('metasheet.mrho_retention', true) IS DISTINCT FROM 'on' THEN
                RAISE EXCEPTION USING
                  ERRCODE = '55000',
                  MESSAGE = 'section_causality_membership_immutable';
              END IF;
              RETURN OLD;
            END IF;
            RETURN NEW;
          END;
          $fn$
        `.execute(trx)
        const chunk1 = randomUUID()
        const extraChunk = randomUUID()
        const aggregateId = randomUUID()
        await sql`
          INSERT INTO meta_record_revisions (
            id, sheet_id, record_id, version, action, source,
            changed_field_ids, patch, snapshot, seq, operation_id
          ) VALUES (
            ${randomUUID()}::uuid, ${SHEET}, ${`${SHEET}_mut_c1`}, 1, 'create', 'rest',
            ARRAY[]::text[], '{}'::jsonb, '{}'::jsonb, ${CHUNK_SEQ_1}::bigint, ${chunk1}::uuid
          )
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_history_operations (
            sheet_id, operation_id, endpoint_seq, event_count,
            operation_kind, event_contract_version, component_count
          ) VALUES (
            ${SHEET}, ${chunk1}::uuid, ${CHUNK_SEQ_1}::bigint, 1, 'restore_chunk', 2, NULL
          )
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_revisions (
            id, sheet_id, record_id, version, action, source,
            changed_field_ids, patch, snapshot, seq, operation_id
          ) VALUES (
            ${randomUUID()}::uuid, ${SHEET}, ${`${SHEET}_mut_c2`}, 1, 'create', 'rest',
            ARRAY[]::text[], '{}'::jsonb, '{}'::jsonb, ${CHUNK_SEQ_2}::bigint, ${extraChunk}::uuid
          )
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_history_operations (
            sheet_id, operation_id, endpoint_seq, event_count,
            operation_kind, event_contract_version, component_count
          ) VALUES (
            ${SHEET}, ${extraChunk}::uuid, ${CHUNK_SEQ_2}::bigint, 1, 'restore_chunk', 2, NULL
          )
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_history_operation_members (
            sheet_id, parent_operation_id, ordinal, child_operation_id,
            child_endpoint_seq, child_event_count
          ) VALUES (
            ${SHEET}, ${aggregateId}::uuid, 1, ${chunk1}::uuid, ${CHUNK_SEQ_1}::bigint, 1
          )
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_history_operations (
            sheet_id, operation_id, endpoint_seq, event_count,
            operation_kind, event_contract_version, component_count
          ) VALUES (
            ${SHEET}, ${aggregateId}::uuid, ${CHUNK_SEQ_1}::bigint, 1, 'restore_aggregate', 2, 1
          )
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_history_operation_members (
            sheet_id, parent_operation_id, ordinal, child_operation_id,
            child_endpoint_seq, child_event_count
          ) VALUES (
            ${SHEET}, ${aggregateId}::uuid, 2, ${extraChunk}::uuid, ${CHUNK_SEQ_2}::bigint, 1
          )
        `.execute(trx)
        throw new Error('section_causality_membership_insert_arm_missing')
      }),
    )
    expect(refusal.message).toBe('section_causality_membership_insert_arm_missing')
    expect(await causalityFingerprint()).toBe(initialFingerprint)
  })

  test('D2c archive_snapshot refuses ordinary, restore_chunk, and restore_aggregate sources', async () => {
    for (const sourceHeadKind of ['ordinary', 'restore_chunk', 'restore_aggregate'] as const) {
      await cleanupSheetRows()
      const error = await errorOf(
        withTxn(async (client) => {
          const heads = await bootstrapAllSections(client, SHEET)
          const members = await snapshotMembersFor(SHEET, heads)
          members[1] = {
            ...members[1],
            sourceHeadKind,
            rowCount: '1',
            sourceHash: SHA256_A,
          }
          await sealArchiveSnapshotOperation(asQuery(client), {
            sheetId: SHEET,
            operationId: randomUUID(),
            endpointSeq: SNAPSHOT_SEQ,
            members,
          })
        }),
      )
      expect(error).toMatchObject({
        message: 'SECTION_CAUSALITY_SNAPSHOT_SOURCE_UNFINALIZED',
      })
    }
  })

  test('records ordinary and restore_chunk source identity cannot mint a v1 snapshot', async () => {
    for (const operationKind of ['ordinary', 'restore_chunk'] as const) {
      await cleanupSheetRows()
      const error = await errorOf(
        withTxn(async (client) => {
          const heads = await bootstrapAllSections(client, SHEET)
          const recordsOp = randomUUID()
          await insertRecordRevision(client, SHEET, recordsOp, RECORDS_HEAD_SEQ, `${SHEET}_${operationKind}`)
          await sealDirectEventOperation(asQuery(client), {
            sheetId: SHEET,
            operationId: recordsOp,
            endpointSeq: RECORDS_HEAD_SEQ,
            eventCount: 1,
            operationKind,
          })
          const snapshotId = randomUUID()
          const members = await snapshotMembersFor(SHEET, heads)
          members[1] = {
            ordinal: 2,
            sectionKind: 'records',
            sourceHeadKind: operationKind,
            sourceOperationId: recordsOp,
            sourceHeadSeq: RECORDS_HEAD_SEQ,
            rowCount: '1',
            sourceHash: SHA256_B,
          }
          for (const member of members) {
            await client.query(
              `INSERT INTO meta_record_history_snapshot_members (
                 sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
                 source_operation_id, source_head_seq, row_count, source_hash
               ) VALUES ($1, $2::uuid, $3::int, $4, $5, $6::uuid, $7::bigint, $8::bigint, $9)`,
              [
                SHEET,
                snapshotId,
                member.ordinal,
                member.sectionKind,
                member.sourceHeadKind,
                member.sourceOperationId,
                member.sourceHeadSeq,
                member.rowCount,
                member.sourceHash,
              ],
            )
          }
          await client.query(
            `INSERT INTO meta_record_history_operations (
               sheet_id, operation_id, endpoint_seq, event_count,
               operation_kind, event_contract_version, component_count
             ) VALUES ($1, $2::uuid, $3::bigint, 0, 'archive_snapshot', 2, 9)`,
            [SHEET, snapshotId, SNAPSHOT_SEQ],
          )
        }),
      )
      expect(error.message).toBe('section_causality_snapshot_source_unfinalized')
      expectValuesFree(error, [SHEET, WORKSPACE, BASE, SHA256_B])
    }
  })

  test('non-record source_head_seq mismatch refuses at helper and COMMIT', async () => {
    const helperRefusal = await errorOf(
      withTxn(async (client) => {
        const heads = await bootstrapAllSections(client, SHEET)
        const members = await snapshotMembersFor(SHEET, heads)
        members[2] = { ...members[2], sourceHeadSeq: heads[0]!.seq }
        await sealArchiveSnapshotOperation(asQuery(client), {
          sheetId: SHEET,
          operationId: randomUUID(),
          endpointSeq: SNAPSHOT_SEQ,
          members,
        })
      }),
    )
    expect(helperRefusal).toMatchObject({
      message: 'SECTION_CAUSALITY_SOURCE_HEAD_MISMATCH',
    })

    await cleanupSheetRows()
    const commitRefusal = await errorOf(
      withTxn(async (client) => {
        const heads = await bootstrapAllSections(client, SHEET)
        const snapshotId = randomUUID()
        const members = await snapshotMembersFor(SHEET, heads)
        members[2] = { ...members[2], sourceHeadSeq: heads[0]!.seq }
        for (const member of members) {
          await client.query(
            `INSERT INTO meta_record_history_snapshot_members (
               sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
               source_operation_id, source_head_seq, row_count, source_hash
             ) VALUES ($1, $2::uuid, $3::int, $4, $5, $6::uuid, $7::bigint, $8::bigint, $9)`,
            [
              SHEET,
              snapshotId,
              member.ordinal,
              member.sectionKind,
              member.sourceHeadKind,
              member.sourceOperationId,
              member.sourceHeadSeq,
              member.rowCount,
              member.sourceHash,
            ],
          )
        }
        await client.query(
          `INSERT INTO meta_record_history_operations (
             sheet_id, operation_id, endpoint_seq, event_count,
             operation_kind, event_contract_version, component_count
           ) VALUES ($1, $2::uuid, $3::bigint, 0, 'archive_snapshot', 2, 9)`,
          [SHEET, snapshotId, SNAPSHOT_SEQ],
        )
      }),
    )
    expect(commitRefusal.message).toBe('section_causality_snapshot_membership_invalid')
    expectValuesFree(commitRefusal, [SHEET, WORKSPACE, BASE])
  })

  test('arbitrary hash/count on a real non-record ordinary revision cannot mint a snapshot parent', async () => {
    const error = await errorOf(
      withTxn(async (client) => {
        const heads = await bootstrapAllSections(client, SHEET)
        const linkOp = randomUUID()
        await client.query(
          `INSERT INTO meta_sheet_section_revisions (
             sheet_id, section_kind, entity_key, action, payload, seq, operation_id
           ) VALUES ($1, 'links', 'link/one', 'upsert', '{"ok":true}'::jsonb, $2::bigint, $3::uuid)`,
          [SHEET, RECORDS_HEAD_SEQ, linkOp],
        )
        await sealDirectEventOperation(asQuery(client), {
          sheetId: SHEET,
          operationId: linkOp,
          endpointSeq: RECORDS_HEAD_SEQ,
          eventCount: 1,
          operationKind: 'ordinary',
        })
        const snapshotId = randomUUID()
        const members = await snapshotMembersFor(SHEET, heads)
        members[2] = {
          ordinal: 3,
          sectionKind: 'links',
          sourceHeadKind: 'ordinary',
          sourceOperationId: linkOp,
          sourceHeadSeq: RECORDS_HEAD_SEQ,
          rowCount: '99',
          sourceHash: SHA256_B,
        }
        for (const member of members) {
          await client.query(
            `INSERT INTO meta_record_history_snapshot_members (
               sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
               source_operation_id, source_head_seq, row_count, source_hash
             ) VALUES ($1, $2::uuid, $3::int, $4, $5, $6::uuid, $7::bigint, $8::bigint, $9)`,
            [
              SHEET,
              snapshotId,
              member.ordinal,
              member.sectionKind,
              member.sourceHeadKind,
              member.sourceOperationId,
              member.sourceHeadSeq,
              member.rowCount,
              member.sourceHash,
            ],
          )
        }
        await client.query(
          `INSERT INTO meta_record_history_operations (
             sheet_id, operation_id, endpoint_seq, event_count,
             operation_kind, event_contract_version, component_count
           ) VALUES ($1, $2::uuid, $3::bigint, 0, 'archive_snapshot', 2, 9)`,
          [SHEET, snapshotId, SNAPSHOT_SEQ],
        )
      }),
    )
    expect(error.message).toBe('section_causality_snapshot_source_unfinalized')
    expectValuesFree(error, [SHEET, WORKSPACE, BASE, SHA256_B])
  })

  test('removing the bootstrap-only snapshot refusal lets an arbitrary ordinary vector mint a parent', async () => {
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          CREATE OR REPLACE FUNCTION public.meta_record_history_operations_validate_endpoint()
          RETURNS trigger
          LANGUAGE plpgsql
          SET search_path = pg_catalog, public
          AS $fn$
          DECLARE
            member_count bigint;
            matched_count bigint;
            mismatch_count bigint;
          BEGIN
            IF NEW.operation_kind IS DISTINCT FROM 'archive_snapshot' THEN
              RETURN NEW;
            END IF;
            SELECT COUNT(*),
                   COUNT(*) FILTER (WHERE expected.section_kind IS NOT NULL)
              INTO member_count, matched_count
              FROM public.meta_record_history_snapshot_members member_row
              LEFT JOIN (
                VALUES
                  (1, 'schema'),
                  (2, 'records'),
                  (3, 'links'),
                  (4, 'field_value_tombstones'),
                  (5, 'link_tombstones'),
                  (6, 'auto_number'),
                  (7, 'attachments_index'),
                  (8, 'permission_evidence'),
                  (9, 'views_config')
              ) expected(ordinal, section_kind)
                ON expected.ordinal = member_row.ordinal
               AND expected.section_kind = member_row.section_kind
             WHERE member_row.sheet_id = NEW.sheet_id
               AND member_row.parent_operation_id = NEW.operation_id;
            IF member_count <> 9 OR matched_count <> 9 THEN
              RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'section_causality_snapshot_membership_invalid';
            END IF;
            SELECT COUNT(*)
              INTO mismatch_count
              FROM public.meta_record_history_snapshot_members member_row
              LEFT JOIN public.meta_record_history_operations source_row
                ON source_row.sheet_id = member_row.sheet_id
               AND source_row.operation_id = member_row.source_operation_id
             WHERE member_row.sheet_id = NEW.sheet_id
               AND member_row.parent_operation_id = NEW.operation_id
               AND (
                 source_row.operation_id IS NULL
                 OR source_row.endpoint_seq IS DISTINCT FROM member_row.source_head_seq
               );
            IF mismatch_count <> 0 THEN
              RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'section_causality_snapshot_membership_invalid';
            END IF;
            RETURN NEW;
          END;
          $fn$
        `.execute(trx)
        const heads = []
        for (const [index, sectionKind] of SECTION_CAUSALITY_DATA_SECTION_KINDS.entries()) {
          const seq = bootstrapSeq(index)
          const operationId = randomUUID()
          await sql`
            INSERT INTO meta_sheet_section_revisions (
              sheet_id, section_kind, entity_key, action, payload, seq, operation_id
            ) VALUES (
              ${SHEET}, ${sectionKind}, ${`section/${sectionKind}`}, 'bootstrap_snapshot',
              jsonb_build_object('row_count', '0'::text, 'source_hash', ${SHA256_A}::text),
              ${seq}::bigint, ${operationId}::uuid
            )
          `.execute(trx)
          await sql`
            INSERT INTO meta_record_history_operations (
              sheet_id, operation_id, endpoint_seq, event_count,
              operation_kind, event_contract_version, component_count
            ) VALUES (
              ${SHEET}, ${operationId}::uuid, ${seq}::bigint, 1, 'section_bootstrap', 2, NULL
            )
          `.execute(trx)
          heads.push({ sectionKind, operationId, seq })
        }
        const linkOp = randomUUID()
        await sql`
          INSERT INTO meta_sheet_section_revisions (
            sheet_id, section_kind, entity_key, action, payload, seq, operation_id
          ) VALUES (
            ${SHEET}, 'links', 'link/forged', 'upsert', '{"ok":true}'::jsonb,
            ${RECORDS_HEAD_SEQ}::bigint, ${linkOp}::uuid
          )
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_history_operations (
            sheet_id, operation_id, endpoint_seq, event_count,
            operation_kind, event_contract_version, component_count
          ) VALUES (
            ${SHEET}, ${linkOp}::uuid, ${RECORDS_HEAD_SEQ}::bigint, 1, 'ordinary', 2, NULL
          )
        `.execute(trx)
        const snapshotId = randomUUID()
        for (const [index, head] of heads.entries()) {
          const isLinks = head.sectionKind === 'links'
          await sql`
            INSERT INTO meta_record_history_snapshot_members (
              sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
              source_operation_id, source_head_seq, row_count, source_hash
            ) VALUES (
              ${SHEET}, ${snapshotId}::uuid, ${index + 1}::int, ${head.sectionKind}::text,
              ${isLinks ? 'ordinary' : 'section_bootstrap'}::text,
              ${isLinks ? linkOp : head.operationId}::uuid,
              ${isLinks ? RECORDS_HEAD_SEQ : head.seq}::bigint,
              ${isLinks ? 99 : 0}::bigint,
              ${isLinks ? SHA256_B : SHA256_A}::text
            )
          `.execute(trx)
        }
        await sql`
          INSERT INTO meta_record_history_operations (
            sheet_id, operation_id, endpoint_seq, event_count,
            operation_kind, event_contract_version, component_count
          ) VALUES (
            ${SHEET}, ${snapshotId}::uuid, ${SNAPSHOT_SEQ}::bigint, 0, 'archive_snapshot', 2, 9
          )
        `.execute(trx)
        throw new Error('section_causality_snapshot_source_unfinalized_missing')
      }),
    )
    expect(refusal.message).toBe('section_causality_snapshot_source_unfinalized_missing')
    expect(await causalityFingerprint()).toBe(initialFingerprint)
  })

  test('exact source-head equality survives if only the bootstrap-only refusal is removed', async () => {
    const error = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          ALTER TABLE public.meta_record_history_operations
            DROP CONSTRAINT chk_mrho_event_contract
        `.execute(trx)
        await sql`
          CREATE OR REPLACE FUNCTION public.meta_record_history_operations_validate_endpoint()
          RETURNS trigger
          LANGUAGE plpgsql
          SET search_path = pg_catalog, public
          AS $fn$
          DECLARE
            mismatch_count bigint;
          BEGIN
            IF NEW.operation_kind IS DISTINCT FROM 'archive_snapshot' THEN
              RETURN NEW;
            END IF;
            SELECT COUNT(*)
              INTO mismatch_count
              FROM public.meta_record_history_snapshot_members member_row
              LEFT JOIN public.meta_record_history_operations source_row
                ON source_row.sheet_id = member_row.sheet_id
               AND source_row.operation_id = member_row.source_operation_id
             WHERE member_row.sheet_id = NEW.sheet_id
               AND member_row.parent_operation_id = NEW.operation_id
               AND source_row.endpoint_seq IS DISTINCT FROM member_row.source_head_seq;
            IF mismatch_count <> 0 THEN
              RAISE EXCEPTION USING
                ERRCODE = '23514',
                MESSAGE = 'section_causality_snapshot_membership_invalid';
            END IF;
            RETURN NEW;
          END;
          $fn$
        `.execute(trx)
        const earlySeq = '9007199254741998'
        const headSeq = '9007199254741999'
        const linkOp = randomUUID()
        const snapshotId = randomUUID()
        await sql`
          INSERT INTO meta_sheet_section_revisions (
            sheet_id, section_kind, entity_key, action, payload, seq, operation_id
          ) VALUES
            (${SHEET}, 'links', 'link/early', 'upsert', '{"n":1}'::jsonb, ${earlySeq}::bigint, ${linkOp}::uuid),
            (${SHEET}, 'links', 'link/head', 'upsert', '{"n":2}'::jsonb, ${headSeq}::bigint, ${linkOp}::uuid)
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_history_operations (
            sheet_id, operation_id, endpoint_seq, event_count,
            operation_kind, event_contract_version, component_count
          ) VALUES (
            ${SHEET}, ${linkOp}::uuid, ${headSeq}::bigint, 2, 'ordinary', 2, NULL
          )
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_history_snapshot_members (
            sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
            source_operation_id, source_head_seq, row_count, source_hash
          ) VALUES (
            ${SHEET}, ${snapshotId}::uuid, 1, 'links', 'ordinary',
            ${linkOp}::uuid, ${earlySeq}::bigint, 99, ${SHA256_B}
          )
        `.execute(trx)
        await sql`
          INSERT INTO meta_record_history_operations (
            sheet_id, operation_id, endpoint_seq, event_count,
            operation_kind, event_contract_version, component_count
          ) VALUES (
            ${SHEET}, ${snapshotId}::uuid, ${SNAPSHOT_SEQ}::bigint, 0, 'archive_snapshot', 2, 1
          )
        `.execute(trx)
        throw new Error('section_causality_source_head_equality_missing')
      }),
    )
    expect(error.message).toBe('section_causality_snapshot_membership_invalid')
    expect(await causalityFingerprint()).toBe(initialFingerprint)
  })

  test('bootstrap helper refuses a bound value that does not match the captured event', async () => {
    const error = await errorOf(
      withTxn(async (client) => {
        const operationId = randomUUID()
        await insertBootstrapRevision(client, SHEET, operationId, 'schema', BOOTSTRAP_SEQ0, '0', SHA256_A)
        await sealSectionBootstrapOperation(asQuery(client), {
          sheetId: SHEET,
          operationId,
          endpointSeq: BOOTSTRAP_SEQ0,
          sectionKind: 'schema',
          rowCount: '0',
          sourceHash: SHA256_B,
        })
      }),
    )
    expect(error).toMatchObject({
      message: 'SECTION_CAUSALITY_BOOTSTRAP_EVENT_MISMATCH',
    })
  })

  test('up fails loud when the parent validator source drifts', async () => {
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        await sectionCausalityMigration.down(trx)
        await sql`
          CREATE OR REPLACE FUNCTION public.meta_record_history_operations_validate_endpoint()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $fn$
          BEGIN
            RETURN NEW;
          END;
          $fn$
        `.execute(trx)
        await sectionCausalityMigration.up(trx)
        throw new Error('section_causality_source_schema_guard_missing')
      }),
    )
    expect(refusal.message).toBe('section_causality_source_schema_mismatch')
    expect(await causalityFingerprint()).toBe(initialFingerprint)
  })
})
