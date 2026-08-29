import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import * as archiveCatalogMigration from '../../src/db/migrations/zzzz20260826120000_create_meta_recovery_archive_catalog'
import * as stagingCleanupMigration from '../../src/db/migrations/zzzz20260826121000_add_recovery_archive_staging_cleanup_protocol'
import * as coverageBindingMigration from '../../src/db/migrations/zzzz20260827120000_add_recovery_archive_coverage_binding'
import * as keyRegistryMigration from '../../src/db/migrations/zzzz20260828121000_add_recovery_archive_key_registry'
import {
  RECOVERY_ARCHIVE_COVERAGE_BINDING_TARGETS,
  RECOVERY_ARCHIVE_COVERAGE_KIND_BINDING_TARGETS,
  RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS,
} from '../../src/multitable/recovery-archive-contract'

const runRealDb = Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeIfRealDbStep = runRealDb ? describe : describe.skip

test('sentinel: the D2d2-PREP-A real-DB allowlist step must provide DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('recovery_archive_coverage_binding_realdb_harness_missing_database_url')
  }
})

const RUN = randomUUID().replaceAll('-', '').slice(0, 16)
const PREFIX = `tm_d2d2a_${RUN}`
const WORKSPACE = `${PREFIX}_workspace`
const BASE = `${PREFIX}_base`
const SHEET = `${PREFIX}_sheet`
const CHECKPOINT = `${PREFIX}_checkpoint`
const OWNER = `${PREFIX}_owner`
const KEY_ID = `${PREFIX}_key`
const ANCHOR_OPERATION = randomUUID()
const ANCHOR_SEQ = '9007199254747993'
const SOURCE_VECTOR_HASH = '1'.repeat(64)
const SOURCE_HASH = '4'.repeat(64)
const LEASE_EXPIRES_AT = '2099-01-01T00:00:00.000Z'
const EXPIRES_AT = '2099-12-31T00:00:00.000Z'

const DATA_SECTIONS = RECOVERY_ARCHIVE_COVERAGE_BINDING_TARGETS.filter((name) => name !== 'manifest_root')
const SOURCE_KIND_CHECK = 'chk_meta_recovery_archive_coverage_source_kind'
const BOUND_SECTION_CHECK = 'chk_meta_recovery_archive_coverage_bound_section'
const KIND_BINDING_CHECK = 'chk_meta_recovery_archive_coverage_kind_binding'
const SOURCE_KIND_DEF =
  "CHECK (source_kind = ANY (ARRAY['record_revision'::text, 'marker'::text, 'section_revision'::text, 'config_revision'::text, 'field_tombstone'::text, 'link_tombstone'::text, 'checkpoint_baseline'::text, 'sealed_operation_endpoint'::text, 'snapshot_membership'::text, 'aggregate_membership'::text]))"
const NEW_BOUND_SECTION_DEF =
  "CHECK (bound_section = ANY (ARRAY['schema'::text, 'records'::text, 'links'::text, 'field_value_tombstones'::text, 'link_tombstones'::text, 'auto_number'::text, 'attachments_index'::text, 'permission_evidence'::text, 'views_config'::text, 'manifest_root'::text]))"
const OLD_BOUND_SECTION_DEF =
  "CHECK (bound_section = ANY (ARRAY['schema'::text, 'records'::text, 'links'::text, 'field_value_tombstones'::text, 'link_tombstones'::text, 'auto_number'::text, 'attachments_index'::text, 'permission_evidence'::text, 'views_config'::text]))"
const NEW_KIND_BINDING_DEF =
  "CHECK ((source_kind = ANY (ARRAY['record_revision'::text, 'marker'::text, 'checkpoint_baseline'::text])) AND bound_section = 'records'::text OR source_kind = 'field_tombstone'::text AND bound_section = 'field_value_tombstones'::text OR source_kind = 'link_tombstone'::text AND bound_section = 'link_tombstones'::text OR (source_kind = ANY (ARRAY['sealed_operation_endpoint'::text, 'aggregate_membership'::text])) AND bound_section = 'manifest_root'::text OR source_kind = 'config_revision'::text AND (bound_section = ANY (ARRAY['schema'::text, 'views_config'::text])) OR (source_kind = ANY (ARRAY['section_revision'::text, 'snapshot_membership'::text])) AND (bound_section = ANY (ARRAY['schema'::text, 'records'::text, 'links'::text, 'field_value_tombstones'::text, 'link_tombstones'::text, 'auto_number'::text, 'attachments_index'::text, 'permission_evidence'::text, 'views_config'::text])))"

type DatabaseError = Error & {
  code?: string
  constraint?: string
  detail?: string
  where?: string
}

let pool: Pool
let db: Kysely<unknown>
let schemaIsUp = false
let keyRegistryIsUp = false
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

function forbiddenIdentities(generationId: string, sourceId: string): string[] {
  return [WORKSPACE, BASE, SHEET, OWNER, generationId, sourceId, SOURCE_HASH, ANCHOR_SEQ, PREFIX, KEY_ID]
}

async function bindingFingerprint(): Promise<string> {
  const result = await q(
    `SELECT md5(string_agg(definition, '|' ORDER BY definition)) AS fingerprint
       FROM (
         SELECT concat_ws('|', constraint_row.conname, pg_get_constraintdef(constraint_row.oid, true)) AS definition
           FROM pg_constraint constraint_row
           JOIN pg_class relation ON relation.oid = constraint_row.conrelid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relname = 'meta_recovery_archive_coverage_items'
            AND constraint_row.conname = ANY($1::text[])
       ) catalog_rows`,
    [[BOUND_SECTION_CHECK, KIND_BINDING_CHECK]],
  )
  return String(result.rows[0]?.fingerprint ?? '')
}

async function constraintDefs(): Promise<Record<string, string | null>> {
  const result = await q(
    `SELECT constraint_row.conname, pg_get_constraintdef(constraint_row.oid, true) AS definition
       FROM pg_constraint constraint_row
       JOIN pg_class relation ON relation.oid = constraint_row.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'meta_recovery_archive_coverage_items'
        AND constraint_row.conname = ANY($1::text[])
      ORDER BY constraint_row.conname`,
    [[BOUND_SECTION_CHECK, KIND_BINDING_CHECK]],
  )
  const defs: Record<string, string | null> = {
    [BOUND_SECTION_CHECK]: null,
    [KIND_BINDING_CHECK]: null,
  }
  for (const row of result.rows as Array<{ conname: string; definition: string }>) {
    defs[row.conname] = row.definition
  }
  return defs
}

async function sourceKindConstraintDef(): Promise<string | null> {
  const result = await q(
    `SELECT pg_get_constraintdef(constraint_row.oid, true) AS definition
       FROM pg_constraint constraint_row
       JOIN pg_class relation ON relation.oid = constraint_row.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'meta_recovery_archive_coverage_items'
        AND constraint_row.conname = $1`,
    [SOURCE_KIND_CHECK],
  )
  return result.rows[0]?.definition ?? null
}

async function installIfAbsent(): Promise<void> {
  const catalogPresent = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_coverage_items') IS NOT NULL AS present`,
  )
  if (!catalogPresent.rows[0]?.present) await archiveCatalogMigration.up(db)

  const stagingPresent = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_staging_objects') IS NOT NULL AS present`,
  )
  if (!stagingPresent.rows[0]?.present) await stagingCleanupMigration.up(db)

  const bindingPresent = await q(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint constraint_row
         JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'meta_recovery_archive_coverage_items'
          AND constraint_row.conname = $1
     ) AS present`,
    [KIND_BINDING_CHECK],
  )
  if (!bindingPresent.rows[0]?.present) await coverageBindingMigration.up(db)
  schemaIsUp = true
}

async function seedSealedOperation(sheetId: string, operationId: string, endpointSeq: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO meta_record_revisions (
         id, sheet_id, record_id, version, action, source,
         changed_field_ids, patch, snapshot, seq, operation_id
       ) VALUES ($1::uuid, $2, $3, 1, 'create', 'rest', ARRAY[]::text[], '{}'::jsonb,
                 '{}'::jsonb, $4::bigint, $5::uuid)`,
      [randomUUID(), sheetId, `${sheetId}_anchor_record`, endpointSeq, operationId],
    )
    await client.query(
      `INSERT INTO meta_record_history_operations (
         sheet_id, operation_id, endpoint_seq, event_count
       ) VALUES ($1, $2::uuid, $3::bigint, 1)`,
      [sheetId, operationId, endpointSeq],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function insertArchive(): Promise<string> {
  const generationId = randomUUID()
  await q(
    `INSERT INTO meta_recovery_archives (
       generation_id, workspace_id, base_id, sheet_id, anchor_operation_id, anchor_seq,
       checkpoint_id, format_version, state, build_status, coverage_status,
       source_vector_hash, key_id, owner_kind, owner_id, owner_fence,
       lease_expires_at, expires_at
     ) VALUES (
       $1::uuid, $2, $3, $4, $5::uuid, $6::bigint,
       $7, 1, 'building', 'active', 'incomplete',
       $8, $9, 'archive_builder', $10, 1,
       $11::timestamptz, $12::timestamptz
     )`,
    [
      generationId,
      WORKSPACE,
      BASE,
      SHEET,
      ANCHOR_OPERATION,
      ANCHOR_SEQ,
      CHECKPOINT,
      SOURCE_VECTOR_HASH,
      KEY_ID,
      OWNER,
      LEASE_EXPIRES_AT,
      EXPIRES_AT,
    ],
  )
  return generationId
}

async function insertCoverage(
  generationId: string,
  sourceKind: string,
  boundSection: string,
  sourceId = `${PREFIX}_source_${randomUUID()}`,
): Promise<string> {
  await q(
    `INSERT INTO meta_recovery_archive_coverage_items (
       generation_id, source_kind, source_id, source_seq, source_sha256, bound_section
     ) VALUES ($1::uuid, $2, $3, $4::bigint, $5, $6)`,
    [generationId, sourceKind, sourceId, ANCHOR_SEQ, SOURCE_HASH, boundSection],
  )
  return sourceId
}

async function truncateCoverage(): Promise<void> {
  if (!schemaIsUp) return
  const reservationTable = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_snapshot_reservations') IS NOT NULL AS present`,
  )
  const reservationTarget = reservationTable.rows[0]?.present
    ? 'meta_recovery_archive_snapshot_reservations,'
    : ''
  const objectTable = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_objects') IS NOT NULL AS present`,
  )
  const objectTarget = objectTable.rows[0]?.present ? 'meta_recovery_archive_objects,' : ''
  const legalHoldTable = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_legal_holds') IS NOT NULL AS present`,
  )
  const legalHoldTarget = legalHoldTable.rows[0]?.present
    ? 'meta_recovery_archive_legal_holds,'
    : ''
  const restoreJobsTable = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_jobs') IS NOT NULL AS present`,
  )
  const restoreJobTargets = restoreJobsTable.rows[0]?.present
    ? `meta_recovery_archive_restore_plans,
         meta_recovery_archive_job_chunks,
         meta_recovery_archive_sync_receipts,
         meta_recovery_token_burns,
         meta_recovery_archive_jobs,`
    : ''
  if (!legalHoldTarget) {
    await q(
      `TRUNCATE TABLE
         ${restoreJobTargets}
         ${objectTarget}
         ${reservationTarget}
         meta_recovery_archive_staging_objects,
         meta_recovery_archive_attachment_refs,
         meta_recovery_archive_coverage_items,
         meta_recovery_archives`,
    )
    return
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    await client.query(
      `TRUNCATE TABLE
         ${restoreJobTargets}
         ${objectTarget}
         ${reservationTarget}
         meta_recovery_archive_staging_objects,
         meta_recovery_archive_attachment_refs,
         meta_recovery_archive_coverage_items,
         ${legalHoldTarget}
         meta_recovery_archives`,
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

async function cleanupSourceFixtures(): Promise<void> {
  await q('SELECT meta_record_history_operations_prune($1, $2::uuid)', [SHEET, ANCHOR_OPERATION])
  await q(`DELETE FROM meta_history_trust_checkpoints WHERE id = $1`, [CHECKPOINT])
  await q(`DELETE FROM meta_sheets WHERE id = $1`, [SHEET])
  await q(`DELETE FROM meta_bases WHERE id = $1`, [BASE])

  const residue = await q(
    `SELECT
       (SELECT count(*)::int FROM meta_recovery_archives WHERE sheet_id = $1) AS archives,
       (SELECT count(*)::int FROM meta_record_revisions WHERE sheet_id = $1 AND operation_id = $2::uuid) AS revisions,
       (SELECT count(*)::int FROM meta_record_history_operations WHERE sheet_id = $1 AND operation_id = $2::uuid) AS operations,
       (SELECT count(*)::int FROM meta_history_trust_checkpoints WHERE id = $3) AS checkpoints,
       (SELECT count(*)::int FROM meta_sheets WHERE id = $1) AS sheets,
       (SELECT count(*)::int FROM meta_bases WHERE id = $4) AS bases`,
    [SHEET, ANCHOR_OPERATION, CHECKPOINT, BASE],
  )
  expect(residue.rows).toEqual([
    { archives: 0, revisions: 0, operations: 0, checkpoints: 0, sheets: 0, bases: 0 },
  ])
}

async function provisionFixtureKey(): Promise<void> {
  const surface = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_keys') IS NOT NULL AS present`,
  )
  if (!surface.rows[0]?.present) await keyRegistryMigration.up(db)
  keyRegistryIsUp = true
  await q(`INSERT INTO meta_recovery_archive_keys (key_id) VALUES ($1)`, [KEY_ID])
}

async function removeFixtureKey(): Promise<void> {
  if (!keyRegistryIsUp) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('LOCK TABLE meta_recovery_archive_keys IN ACCESS EXCLUSIVE MODE')
    await client.query('ALTER TABLE meta_recovery_archive_keys DISABLE TRIGGER USER')
    await client.query('DELETE FROM meta_recovery_archive_keys WHERE key_id=$1', [KEY_ID])
    await client.query('ALTER TABLE meta_recovery_archive_keys ENABLE TRIGGER USER')
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

describeIfRealDbStep('Phase D2d2-PREP-A coverage section/root binding (real DB)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    await installIfAbsent()
    await provisionFixtureKey()
    initialFingerprint = await bindingFingerprint()

    await q(`INSERT INTO meta_bases (id, name, workspace_id) VALUES ($1, $2, $3)`, [BASE, `${PREFIX} Base`, WORKSPACE])
    await q(`INSERT INTO meta_sheets (id, base_id, name, system_kind) VALUES ($1, $2, $3, NULL)`, [
      SHEET,
      BASE,
      `${PREFIX} Sheet`,
    ])
    await seedSealedOperation(SHEET, ANCHOR_OPERATION, ANCHOR_SEQ)
    await q(
      `INSERT INTO meta_history_trust_checkpoints (id, sheet_id, state, trusted_since_seq)
       VALUES ($1, $2, 'active', $3::bigint)`,
      [CHECKPOINT, SHEET, ANCHOR_SEQ],
    )
  })

  test('the exact real-DB allowlist marker and database are active', () => {
    expect(process.env.METASHEET_REAL_DB_TEST_STEP).toBe('1')
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  afterEach(async () => {
    await truncateCoverage()
  })

  afterAll(async () => {
    try {
      if (!schemaIsUp) {
        await coverageBindingMigration.up(db)
        schemaIsUp = true
      }
      await truncateCoverage()
      await cleanupSourceFixtures()
      await removeFixtureKey()
    } finally {
      await db.destroy()
    }
  })

  test('D2b staging objects are installed so truncate does not assume a missing relation', async () => {
    const staging = await q(
      `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_staging_objects') IS NOT NULL AS present`,
    )
    expect(staging.rows).toEqual([{ present: true }])
    await truncateCoverage()
    expect(await bindingFingerprint()).toBe(initialFingerprint)
  })

  test('bound_section admits the nine data sections plus manifest_root and forbids coverage_index', async () => {
    const defs = await constraintDefs()
    expect(defs[BOUND_SECTION_CHECK]).toBe(NEW_BOUND_SECTION_DEF)
    expect(defs[KIND_BINDING_CHECK]).toBe(NEW_KIND_BINDING_DEF)
    expect(defs[BOUND_SECTION_CHECK]).not.toContain('coverage_index')
    expect(defs[KIND_BINDING_CHECK]).not.toContain('coverage_index')
    expect(defs[KIND_BINDING_CHECK]).not.toContain('NOT IN')
  })

  test('positive kind-to-binding pairs insert, including aggregate+manifest_root and dynamic sections', async () => {
    const archive = await insertArchive()
    await insertCoverage(archive, 'record_revision', 'records')
    await insertCoverage(archive, 'marker', 'records')
    await insertCoverage(archive, 'checkpoint_baseline', 'records')
    await insertCoverage(archive, 'field_tombstone', 'field_value_tombstones')
    await insertCoverage(archive, 'link_tombstone', 'link_tombstones')
    await insertCoverage(archive, 'config_revision', 'schema')
    await insertCoverage(archive, 'config_revision', 'views_config', `${PREFIX}_config_views`)
    await insertCoverage(archive, 'sealed_operation_endpoint', 'manifest_root')
    await insertCoverage(archive, 'aggregate_membership', 'manifest_root')
    for (const [index, section] of DATA_SECTIONS.entries()) {
      await insertCoverage(archive, 'section_revision', section, `${PREFIX}_section_${index}`)
      await insertCoverage(archive, 'snapshot_membership', section, `${PREFIX}_snapshot_${index}`)
    }

    const rows = await q(
      `SELECT source_kind, bound_section
         FROM meta_recovery_archive_coverage_items
        WHERE generation_id = $1::uuid
        ORDER BY source_kind, bound_section, source_id`,
      [archive],
    )
    expect(rows.rows.length).toBe(9 + DATA_SECTIONS.length * 2)
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        { source_kind: 'aggregate_membership', bound_section: 'manifest_root' },
        { source_kind: 'sealed_operation_endpoint', bound_section: 'manifest_root' },
        { source_kind: 'section_revision', bound_section: 'records' },
        { source_kind: 'snapshot_membership', bound_section: 'views_config' },
      ]),
    )
    expect(new Set(rows.rows.map((row) => row.source_kind))).toEqual(new Set(RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS))
  })

  test('discriminating negatives refuse endpoint+records, record+root, config+permission_evidence, and coverage_index', async () => {
    const archive = await insertArchive()

    // Native CHECK DETAIL echoes the failing row; that surface is not values-free.
    const endpointRecords = await errorOf(insertCoverage(archive, 'sealed_operation_endpoint', 'records'))
    expect(endpointRecords.message).toContain(KIND_BINDING_CHECK)

    const recordRoot = await errorOf(insertCoverage(archive, 'record_revision', 'manifest_root'))
    expect(recordRoot.message).toContain(KIND_BINDING_CHECK)

    const configPermission = await errorOf(insertCoverage(archive, 'config_revision', 'permission_evidence'))
    expect(configPermission.message).toContain(KIND_BINDING_CHECK)

    const coverageIndex = await errorOf(insertCoverage(archive, 'record_revision', 'coverage_index'))
    expect(coverageIndex.message).toContain(BOUND_SECTION_CHECK)

    const sectionRoot = await errorOf(insertCoverage(archive, 'section_revision', 'manifest_root'))
    expect(sectionRoot.message).toContain(KIND_BINDING_CHECK)

    const snapshotRoot = await errorOf(insertCoverage(archive, 'snapshot_membership', 'manifest_root'))
    expect(snapshotRoot.message).toContain(KIND_BINDING_CHECK)

    const remaining = await q(
      `SELECT count(*)::int AS n FROM meta_recovery_archive_coverage_items WHERE generation_id = $1::uuid`,
      [archive],
    )
    expect(remaining.rows).toEqual([{ n: 0 }])
  })

  test('kind binding map matches every accepted insert target used by this substrate', async () => {
    expect(RECOVERY_ARCHIVE_COVERAGE_KIND_BINDING_TARGETS.sealed_operation_endpoint).toEqual(['manifest_root'])
    expect(RECOVERY_ARCHIVE_COVERAGE_KIND_BINDING_TARGETS.aggregate_membership).toEqual(['manifest_root'])
    expect(RECOVERY_ARCHIVE_COVERAGE_KIND_BINDING_TARGETS.section_revision).toEqual(DATA_SECTIONS)
    expect(RECOVERY_ARCHIVE_COVERAGE_KIND_BINDING_TARGETS.snapshot_membership).toEqual(DATA_SECTIONS)
  })

  test('down refuses incompatible manifest_root rows without dropping constraints; empty down/up restores fingerprint', async () => {
    const archive = await insertArchive()
    const sourceId = await insertCoverage(archive, 'aggregate_membership', 'manifest_root')
    const refusal = await errorOf(db.transaction().execute(async (trx) => coverageBindingMigration.down(trx)))
    expect(refusal.message).toBe('recovery_archive_coverage_binding_incompatible')
    expectValuesFree(refusal, forbiddenIdentities(archive, sourceId))
    expect(await bindingFingerprint()).toBe(initialFingerprint)
    expect(await constraintDefs()).toEqual({
      [BOUND_SECTION_CHECK]: NEW_BOUND_SECTION_DEF,
      [KIND_BINDING_CHECK]: NEW_KIND_BINDING_DEF,
    })

    await truncateCoverage()
    await coverageBindingMigration.down(db)
    schemaIsUp = false
    try {
      const restored = await constraintDefs()
      expect(restored[BOUND_SECTION_CHECK]).toBe(OLD_BOUND_SECTION_DEF)
      expect(restored[KIND_BINDING_CHECK]).toBeNull()
      await coverageBindingMigration.up(db)
      schemaIsUp = true
      expect(await bindingFingerprint()).toBe(initialFingerprint)
      expect(await constraintDefs()).toMatchObject({
        [BOUND_SECTION_CHECK]: NEW_BOUND_SECTION_DEF,
      })
    } finally {
      if (!schemaIsUp) {
        await coverageBindingMigration.up(db)
        schemaIsUp = true
      }
    }
  })

  test('up fails loud on an owned kind-binding collision and on source-schema drift', async () => {
    const archive = await insertArchive()
    const sourceId = await insertCoverage(archive, 'record_revision', 'records')
    const identities = forbiddenIdentities(archive, sourceId)

    const collision = await errorOf(coverageBindingMigration.up(db))
    expect(collision.message).toBe('recovery_archive_coverage_binding_object_conflict')
    expectValuesFree(collision, identities)
    expect(await bindingFingerprint()).toBe(initialFingerprint)

    const drift = await errorOf(
      db.transaction().execute(async (trx) => {
        await coverageBindingMigration.down(trx)
        await sql`
          ALTER TABLE public.meta_recovery_archive_coverage_items
            RENAME COLUMN bound_section TO bound_section_d2d2_drift
        `.execute(trx)
        await coverageBindingMigration.up(trx)
        throw new Error('recovery_archive_coverage_binding_source_schema_guard_missing')
      }),
    )
    expect(drift.message).toBe('recovery_archive_coverage_binding_source_schema_mismatch')
    expectValuesFree(drift, identities)
    expect(await bindingFingerprint()).toBe(initialFingerprint)

    const weakenedSourceKind = await errorOf(
      db.transaction().execute(async (trx) => {
        await coverageBindingMigration.down(trx)
        await sql`
          ALTER TABLE public.meta_recovery_archive_coverage_items
            DROP CONSTRAINT chk_meta_recovery_archive_coverage_source_kind
        `.execute(trx)
        await sql`
          ALTER TABLE public.meta_recovery_archive_coverage_items
            ADD CONSTRAINT chk_meta_recovery_archive_coverage_source_kind CHECK (true)
        `.execute(trx)
        await coverageBindingMigration.up(trx)
        throw new Error('recovery_archive_coverage_binding_up_source_kind_guard_missing')
      }),
    )
    expect(weakenedSourceKind.message).toBe('recovery_archive_coverage_binding_source_schema_mismatch')
    expectValuesFree(weakenedSourceKind, identities)
    expect(await sourceKindConstraintDef()).toBe(SOURCE_KIND_DEF)
    expect(await bindingFingerprint()).toBe(initialFingerprint)
  })

  test('down refuses a renamed kind-binding constraint without partial drop', async () => {
    const archive = await insertArchive()
    const sourceId = await insertCoverage(archive, 'record_revision', 'records')
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          ALTER TABLE public.meta_recovery_archive_coverage_items
            RENAME CONSTRAINT chk_meta_recovery_archive_coverage_kind_binding
            TO chk_meta_recovery_archive_coverage_kind_binding_drift
        `.execute(trx)
        await coverageBindingMigration.down(trx)
        throw new Error('recovery_archive_coverage_binding_rename_guard_missing')
      }),
    )
    expect(refusal.message).toBe('recovery_archive_coverage_binding_source_schema_mismatch')
    expectValuesFree(refusal, forbiddenIdentities(archive, sourceId))
    expect(await bindingFingerprint()).toBe(initialFingerprint)
    expect(await constraintDefs()).toEqual({
      [BOUND_SECTION_CHECK]: NEW_BOUND_SECTION_DEF,
      [KIND_BINDING_CHECK]: NEW_KIND_BINDING_DEF,
    })
  })

  test('down refuses a weakened kind-binding constraint without partial drop', async () => {
    const archive = await insertArchive()
    const sourceId = await insertCoverage(archive, 'record_revision', 'records')
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          ALTER TABLE public.meta_recovery_archive_coverage_items
            DROP CONSTRAINT chk_meta_recovery_archive_coverage_kind_binding
        `.execute(trx)
        await sql`
          ALTER TABLE public.meta_recovery_archive_coverage_items
            ADD CONSTRAINT chk_meta_recovery_archive_coverage_kind_binding CHECK (true)
        `.execute(trx)
        await coverageBindingMigration.down(trx)
        throw new Error('recovery_archive_coverage_binding_weaken_guard_missing')
      }),
    )
    expect(refusal.message).toBe('recovery_archive_coverage_binding_source_schema_mismatch')
    expectValuesFree(refusal, forbiddenIdentities(archive, sourceId))
    expect(await bindingFingerprint()).toBe(initialFingerprint)
    expect(await constraintDefs()).toEqual({
      [BOUND_SECTION_CHECK]: NEW_BOUND_SECTION_DEF,
      [KIND_BINDING_CHECK]: NEW_KIND_BINDING_DEF,
    })
  })

  test('down refuses a drifted bound-section constraint without partial drop', async () => {
    const archive = await insertArchive()
    const sourceId = await insertCoverage(archive, 'record_revision', 'records')
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          ALTER TABLE public.meta_recovery_archive_coverage_items
            DROP CONSTRAINT chk_meta_recovery_archive_coverage_bound_section
        `.execute(trx)
        await sql`
          ALTER TABLE public.meta_recovery_archive_coverage_items
            ADD CONSTRAINT chk_meta_recovery_archive_coverage_bound_section CHECK (
              bound_section IN (
                'schema',
                'records',
                'links',
                'field_value_tombstones',
                'link_tombstones',
                'auto_number',
                'attachments_index',
                'permission_evidence',
                'views_config'
              )
            )
        `.execute(trx)
        await coverageBindingMigration.down(trx)
        throw new Error('recovery_archive_coverage_binding_bound_section_drift_guard_missing')
      }),
    )
    expect(refusal.message).toBe('recovery_archive_coverage_binding_source_schema_mismatch')
    expectValuesFree(refusal, forbiddenIdentities(archive, sourceId))
    expect(await bindingFingerprint()).toBe(initialFingerprint)
    expect(await constraintDefs()).toEqual({
      [BOUND_SECTION_CHECK]: NEW_BOUND_SECTION_DEF,
      [KIND_BINDING_CHECK]: NEW_KIND_BINDING_DEF,
    })
  })

  test('down refuses a weakened source-kind constraint before removing the pairing guard', async () => {
    const archive = await insertArchive()
    const sourceId = await insertCoverage(archive, 'record_revision', 'records')
    const refusal = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          ALTER TABLE public.meta_recovery_archive_coverage_items
            DROP CONSTRAINT chk_meta_recovery_archive_coverage_source_kind
        `.execute(trx)
        await sql`
          ALTER TABLE public.meta_recovery_archive_coverage_items
            ADD CONSTRAINT chk_meta_recovery_archive_coverage_source_kind CHECK (true)
        `.execute(trx)
        await coverageBindingMigration.down(trx)
        throw new Error('recovery_archive_coverage_binding_source_kind_drift_guard_missing')
      }),
    )
    expect(refusal.message).toBe('recovery_archive_coverage_binding_source_schema_mismatch')
    expectValuesFree(refusal, forbiddenIdentities(archive, sourceId))
    expect(await sourceKindConstraintDef()).toBe(SOURCE_KIND_DEF)
    expect(await constraintDefs()).toEqual({
      [BOUND_SECTION_CHECK]: NEW_BOUND_SECTION_DEF,
      [KIND_BINDING_CHECK]: NEW_KIND_BINDING_DEF,
    })
  })
})
