import { createHash, randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import * as claimAnchorMigration from '../../src/db/migrations/zzzz20260828126000_amend_recovery_archive_claim_anchor'
import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from '../../src/multitable/recovery-archive-contract'
import {
  bootstrapSectionEntityKey,
  sealArchiveSnapshotOperation,
  sealSectionBootstrapOperation,
  SECTION_CAUSALITY_DATA_SECTION_KINDS,
  type SealQuery,
} from '../../src/multitable/recovery-archive-seals'

const runRealDb = Boolean(process.env.DATABASE_URL) && process.env.METASHEET_REAL_DB_TEST_STEP === '1'
const describeIfRealDbStep = runRealDb ? describe : describe.skip

test('sentinel: the D2 claim-anchor real-DB allowlist step must provide DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('recovery_archive_claim_anchor_realdb_harness_missing_database_url')
  }
})

const RUN = randomUUID().replaceAll('-', '').slice(0, 16)
const PREFIX = `tm_d2ca_${RUN}`
const WORKSPACE = `${PREFIX}_workspace`
const BASE = `${PREFIX}_base`
const OTHER_BASE = `${PREFIX}_other_base`
const SHEET = `${PREFIX}_sheet`
const OTHER_SHEET = `${PREFIX}_other_sheet`
const SYSTEM_SHEET = `${PREFIX}_system_sheet`
const CHECKPOINT = `${PREFIX}_checkpoint`
const OTHER_CHECKPOINT = `${PREFIX}_other_checkpoint`
const SYSTEM_CHECKPOINT = `${PREFIX}_system_checkpoint`
const OWNER_KIND = 'archive_builder'
const OWNER_ID = `${PREFIX}_owner`
const KEY_ID = `${PREFIX}_key`
const SOURCE_VECTOR_HASH = 'c'.repeat(64)
const OTHER_SOURCE_VECTOR_HASH = 'd'.repeat(64)
const ROOT_HASH = '2'.repeat(64)
const COVERAGE_HASH = '3'.repeat(64)
const SECTION_HASH = 'a'.repeat(64)
const LEASE_EXPIRES_AT = '2099-01-01T00:00:00.000Z'
const EXPIRES_AT = '2099-12-31T00:00:00.000Z'
const SEQ_BASE = 9007199254761000n + BigInt(`0x${RUN.slice(0, 8)}`)

const SECTION_KINDS = SECTION_CAUSALITY_DATA_SECTION_KINDS
const FUNCTIONS = [
  'meta_recovery_archives_claim_anchor_guard_row',
  'meta_recovery_archives_claim_anchor_reservation_guard',
  'meta_recovery_archives_claim_anchor_operation_delete_guard',
] as const
const TRIGGERS = [
  'trg_meta_recovery_archives_claim_anchor_guard_row',
  'trg_meta_recovery_archives_claim_anchor_reservation_guard',
  'trg_mrho_claim_anchor_delete_guard',
] as const

type DatabaseError = Error & {
  code?: string
  constraint?: string
  detail?: string
  where?: string
  hint?: string
}

type ClaimIds = {
  generationId: string
  snapshotOperationId: string
  snapshotSeq: string
  sections: Array<{
    sectionKind: (typeof SECTION_KINDS)[number]
    operationId: string
    endpointSeq: string
  }>
}

type ClaimSection = ClaimIds['sections'][number]

let pool: Pool
let db: Kysely<unknown>
let schemaIsUp = false
let initialFingerprint = ''
let seqCursor = SEQ_BASE

const q = (text: string, values?: unknown[]) => pool.query(text, values)

function nextSeq(): string {
  seqCursor += 1n
  return seqCursor.toString()
}

function asSealQuery(client: PoolClient): SealQuery {
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

function expectValuesFree(error: DatabaseError, forbiddenValues: readonly string[]): void {
  const rendered = [error.message, error.detail, error.where, error.hint].filter(Boolean).join(' ')
  for (const value of forbiddenValues) expect(rendered).not.toContain(value)
}

function forbiddenIdentities(extra: readonly string[] = []): string[] {
  return [WORKSPACE, BASE, SHEET, OWNER_ID, PREFIX, KEY_ID, ...extra]
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
        WHERE pid=$1::int`,
      [waiterPid, blockerPid],
    )
    if (result.rows[0]?.blocked === true) return
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
  }
  throw new Error('recovery_archive_claim_anchor_lock_probe_timeout')
}

async function insertOrdinarySealedOperation(
  client: PoolClient,
  operationId: string,
  endpointSeq: string,
): Promise<void> {
  await client.query(
    `INSERT INTO meta_record_revisions (
       id, sheet_id, record_id, version, action, source,
       changed_field_ids, patch, snapshot, seq, operation_id
     ) VALUES ($1::uuid, $2, $3, 1, 'create', 'rest', ARRAY[]::text[], '{}'::jsonb,
               '{}'::jsonb, $4::bigint, $5::uuid)`,
    [randomUUID(), SHEET, `${PREFIX}_ordinary_${operationId}`, endpointSeq, operationId],
  )
  await client.query(
    `INSERT INTO meta_record_history_operations (
       sheet_id, operation_id, endpoint_seq, event_count
     ) VALUES ($1, $2::uuid, $3::bigint, 1)`,
    [SHEET, operationId, endpointSeq],
  )
}

async function seedOrdinarySealedOperation(operationId: string, endpointSeq: string): Promise<void> {
  await withTxn(async (client) => {
    await insertOrdinarySealedOperation(client, operationId, endpointSeq)
  })
}

async function deleteSealedOperation(client: PoolClient, operationId: string): Promise<void> {
  await client.query(`SELECT set_config('metasheet.mrho_retention', 'on', true)`)
  await client.query(`DELETE FROM meta_record_revisions WHERE operation_id=$1::uuid`, [operationId])
  await client.query(`DELETE FROM meta_record_version_markers WHERE operation_id=$1::uuid`, [operationId])
  await client.query(`DELETE FROM meta_sheet_section_revisions WHERE operation_id=$1::uuid`, [operationId])
  await client.query(`DELETE FROM meta_record_history_operations WHERE operation_id=$1::uuid`, [operationId])
}

async function countAnchorsTo(operationId: string): Promise<number> {
  const result = await q(
    `SELECT count(*)::int AS count
       FROM meta_recovery_archives
      WHERE sheet_id=$1 AND anchor_operation_id=$2::uuid`,
    [SHEET, operationId],
  )
  return Number(result.rows[0]?.count ?? 0)
}

async function operationExists(operationId: string): Promise<boolean> {
  const result = await q(
    `SELECT EXISTS (
       SELECT 1 FROM meta_record_history_operations WHERE operation_id=$1::uuid
     ) AS present`,
    [operationId],
  )
  return result.rows[0]?.present === true
}

async function amendmentPresent(query: typeof q = q): Promise<boolean> {
  const result = await query(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger trigger_row
         JOIN pg_catalog.pg_class relation ON relation.oid = trigger_row.tgrelid
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'meta_recovery_archives'
          AND trigger_row.tgname = 'trg_meta_recovery_archives_claim_anchor_reservation_guard'
          AND NOT trigger_row.tgisinternal
     ) AS present`,
  )
  return result.rows[0]?.present === true
}

async function installIfAbsent(): Promise<void> {
  const catalog = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archives') IS NOT NULL AS present`,
  )
  if (catalog.rows[0]?.present !== true) {
    throw new Error('recovery_archive_claim_anchor_catalog_missing')
  }
  const reservations = await q(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_snapshot_reservations') IS NOT NULL AS present`,
  )
  if (reservations.rows[0]?.present !== true) {
    throw new Error('recovery_archive_claim_anchor_reservations_missing')
  }
  if (!(await amendmentPresent())) await claimAnchorMigration.up(db)
  schemaIsUp = true
}

async function amendmentFingerprint(): Promise<string> {
  const result = await q(
    `SELECT kind, object_name, member_name, definition
       FROM (
         SELECT 'column'::text AS kind,
                'meta_recovery_archives'::text AS object_name,
                column_name::text AS member_name,
                concat_ws('|', data_type, udt_name, is_nullable)::text AS definition
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'meta_recovery_archives'
            AND column_name IN ('anchor_operation_id', 'anchor_seq')
         UNION ALL
         SELECT 'constraint',
                relation.relname::text,
                constraint_row.conname::text,
                concat_ws(
                  '|',
                  constraint_row.contype::text,
                  constraint_row.condeferrable::text,
                  constraint_row.condeferred::text,
                  constraint_row.confdeltype::text,
                  pg_get_constraintdef(constraint_row.oid, true)
                )
           FROM pg_constraint constraint_row
           JOIN pg_class relation ON relation.oid = constraint_row.conrelid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND relation.relname = 'meta_recovery_archives'
            AND constraint_row.conname = 'fk_meta_recovery_archives_anchor'
         UNION ALL
         SELECT 'trigger',
                relation.relname::text,
                trigger_row.tgname::text,
                concat_ws(
                  '|',
                  trigger_row.tgenabled::text,
                  trigger_row.tgdeferrable::text,
                  trigger_row.tginitdeferred::text,
                  trigger_row.tgtype::text,
                  (trigger_row.tgqual IS NOT NULL)::text,
                  pg_get_triggerdef(trigger_row.oid, true)
                )
           FROM pg_trigger trigger_row
           JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'public'
            AND NOT trigger_row.tgisinternal
            AND trigger_row.tgname = ANY($1::text[])
         UNION ALL
         SELECT 'function',
                procedure_row.proname::text,
                pg_get_function_identity_arguments(procedure_row.oid)::text,
                concat_ws('|', coalesce(array_to_string(procedure_row.proconfig, ','), ''),
                          md5(procedure_row.prosrc))
           FROM pg_proc procedure_row
           JOIN pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
          WHERE namespace.nspname = 'public'
            AND procedure_row.proname = ANY($2::text[])
       ) catalog
      ORDER BY kind, object_name, member_name, definition`,
    [TRIGGERS, [...FUNCTIONS, 'meta_recovery_archives_guard_row']],
  )
  return createHash('sha256').update(JSON.stringify(result.rows)).digest('hex')
}

async function truncateOwnedState(): Promise<void> {
  if (!schemaIsUp) return
  const childTables = [
    'meta_recovery_archive_legal_holds',
    'meta_recovery_archive_objects',
    'meta_recovery_archive_snapshot_reservations',
    'meta_recovery_archive_section_bootstrap_markers',
    'meta_recovery_archive_staging_objects',
    'meta_recovery_archive_attachment_refs',
    'meta_recovery_archive_coverage_items',
  ]
  const present = await q(
    `SELECT name
       FROM unnest($1::text[]) AS owned(name)
      WHERE pg_catalog.to_regclass('public.' || name) IS NOT NULL
      ORDER BY name`,
    [childTables],
  )
  const targets = [...present.rows.map((row) => String(row.name)), 'meta_recovery_archives']
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL session_replication_role = replica')
    await client.query(`TRUNCATE TABLE ${targets.join(', ')}`)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function objectFixtureHash(generationId: string, slot: string, field: string): string {
  return createHash('sha256').update(`${generationId}|${slot}|${field}`).digest('hex')
}

async function seedVerifiedObjectRosterIfPresent(
  client: PoolClient,
  generationId: string,
): Promise<void> {
  const presence = await client.query(
    `SELECT pg_catalog.to_regclass('public.meta_recovery_archive_objects') IS NOT NULL AS present`,
  )
  if (presence.rows[0]?.present !== true) return

  const parent = await client.query(
    `SELECT key_id, owner_kind, owner_id, owner_fence::text
       FROM meta_recovery_archives
      WHERE generation_id=$1::uuid`,
    [generationId],
  )
  const row = parent.rows[0]
  if (!row) throw new Error('recovery_archive_claim_anchor_object_parent_missing')

  const slots = [
    ...RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((sectionName) => ({
      objectClass: 'section' as const,
      slot: `section:${sectionName}`,
      sectionName,
      attachmentId: null as string | null,
    })),
    {
      objectClass: 'manifest' as const,
      slot: 'manifest',
      sectionName: null as string | null,
      attachmentId: null as string | null,
    },
  ]

  for (const slot of slots) {
    const objectId = objectFixtureHash(generationId, slot.slot, 'object')
    await client.query(
      `INSERT INTO meta_recovery_archive_objects (
         generation_id, object_id, object_class, section_name, attachment_id,
         key_id, provider_version, plaintext_sha256, ciphertext_sha256, size_bytes,
         idempotency_key, put_receipt_sha256, head_receipt_sha256,
         owner_kind, owner_id, owner_fence
       ) VALUES (
         $1::uuid, $2, $3, $4, $5,
         $6, $7, $8, $9, 1,
         $2, $10, $11,
         $12, $13, $14::bigint
       )
       ON CONFLICT (generation_id, object_id) DO NOTHING`,
      [
        generationId,
        objectId,
        slot.objectClass,
        slot.sectionName,
        slot.attachmentId,
        row.key_id,
        `${PREFIX}_fixture_v1`,
        objectFixtureHash(generationId, slot.slot, 'plaintext'),
        objectFixtureHash(generationId, slot.slot, 'ciphertext'),
        objectFixtureHash(generationId, slot.slot, 'put'),
        objectFixtureHash(generationId, slot.slot, 'head'),
        row.owner_kind,
        row.owner_id,
        row.owner_fence,
      ],
    )
  }

  await client.query(
    `UPDATE meta_recovery_archive_objects
        SET state='verified', verified_at=clock_timestamp()
      WHERE generation_id=$1::uuid AND state='uploaded'`,
    [generationId],
  )
}

function allocateClaimIds(): ClaimIds {
  const sections = SECTION_KINDS.map((sectionKind) => ({
    sectionKind,
    operationId: randomUUID(),
    endpointSeq: nextSeq(),
  }))
  return {
    generationId: randomUUID(),
    snapshotOperationId: randomUUID(),
    snapshotSeq: nextSeq(),
    sections,
  }
}

async function insertBuildingGeneration(
  client: PoolClient,
  ids: ClaimIds,
  overrides: {
    sheetId?: string
    sourceVectorHash?: string
    ownerKind?: string
    ownerId?: string
    ownerFence?: string
    checkpointId?: string
    anchorOperationId?: string
    anchorSeq?: string
    workspaceId?: string | null
    baseId?: string
  } = {},
): Promise<void> {
  await client.query(
    `INSERT INTO meta_recovery_archives (
       generation_id, workspace_id, base_id, sheet_id, anchor_operation_id, anchor_seq,
       checkpoint_id, format_version, state, build_status, coverage_status,
       source_vector_hash, key_id, owner_kind, owner_id, owner_fence,
       lease_expires_at, expires_at
     ) VALUES (
       $1::uuid, $2, $3, $4, $5::uuid, $6::bigint,
       $7, 1, 'building', 'active', 'incomplete',
       $8, $9, $10, $11, $12::bigint,
       $13::timestamptz, $14::timestamptz
     )`,
    [
      ids.generationId,
      overrides.workspaceId === undefined ? WORKSPACE : overrides.workspaceId,
      overrides.baseId ?? BASE,
      overrides.sheetId ?? SHEET,
      overrides.anchorOperationId ?? ids.snapshotOperationId,
      overrides.anchorSeq ?? ids.snapshotSeq,
      overrides.checkpointId ?? CHECKPOINT,
      overrides.sourceVectorHash ?? SOURCE_VECTOR_HASH,
      KEY_ID,
      overrides.ownerKind ?? OWNER_KIND,
      overrides.ownerId ?? OWNER_ID,
      overrides.ownerFence ?? '1',
      LEASE_EXPIRES_AT,
      EXPIRES_AT,
    ],
  )
}

async function insertReservationSet(
  client: PoolClient,
  ids: ClaimIds,
  options: {
    omitOrdinal10?: boolean
    alterOrdinal10?: Partial<{
      operationId: string
      endpointSeq: string
      reservationKind: string
    }>
    sheetId?: string
    sourceVectorHash?: string
    ownerKind?: string
    ownerId?: string
    ownerFence?: string
    generationId?: string
  } = {},
): Promise<void> {
  const generationId = options.generationId ?? ids.generationId
  for (const [index, section] of ids.sections.entries()) {
    await client.query(
      `INSERT INTO meta_recovery_archive_snapshot_reservations (
         generation_id, sheet_id, source_vector_hash, owner_kind, owner_id, owner_fence,
         ordinal, reservation_kind, section_kind, operation_id, endpoint_seq
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6::bigint,
         $7, 'section_bootstrap', $8, $9::uuid, $10::bigint
       )`,
      [
        generationId,
        options.sheetId ?? SHEET,
        options.sourceVectorHash ?? SOURCE_VECTOR_HASH,
        options.ownerKind ?? OWNER_KIND,
        options.ownerId ?? OWNER_ID,
        options.ownerFence ?? '1',
        index + 1,
        section.sectionKind,
        section.operationId,
        section.endpointSeq,
      ],
    )
  }
  if (options.omitOrdinal10) return
  await client.query(
    `INSERT INTO meta_recovery_archive_snapshot_reservations (
       generation_id, sheet_id, source_vector_hash, owner_kind, owner_id, owner_fence,
       ordinal, reservation_kind, section_kind, operation_id, endpoint_seq
     ) VALUES (
       $1::uuid, $2, $3, $4, $5, $6::bigint,
       10, $7, NULL, $8::uuid, $9::bigint
     )`,
    [
      generationId,
      options.sheetId ?? SHEET,
      options.sourceVectorHash ?? SOURCE_VECTOR_HASH,
      options.ownerKind ?? OWNER_KIND,
      options.ownerId ?? OWNER_ID,
      options.ownerFence ?? '1',
      options.alterOrdinal10?.reservationKind ?? 'archive_snapshot',
      options.alterOrdinal10?.operationId ?? ids.snapshotOperationId,
      options.alterOrdinal10?.endpointSeq ?? ids.snapshotSeq,
    ],
  )
}

async function claimExactSet(client: PoolClient, ids: ClaimIds): Promise<void> {
  await insertBuildingGeneration(client, ids)
  await insertReservationSet(client, ids)
}

async function claimOnPool(ids: ClaimIds): Promise<void> {
  await withTxn((client) => claimExactSet(client, ids))
}

async function sealReservedParent(client: PoolClient, ids: ClaimIds): Promise<void> {
  await sealSnapshotParentFromSections(client, ids, ids.sections)
}

async function sealSnapshotParentFromSections(
  client: PoolClient,
  ids: ClaimIds,
  sourceSections: readonly ClaimSection[],
): Promise<void> {
  const query = asSealQuery(client)
  const members = []
  for (const section of sourceSections) {
    await client.query(
      `INSERT INTO meta_sheet_section_revisions (
         sheet_id, section_kind, entity_key, action, payload, seq, operation_id
       ) VALUES (
         $1, $2, $3, 'bootstrap_snapshot',
         jsonb_build_object('row_count', '0', 'source_hash', $4::text),
         $5::bigint, $6::uuid
       )`,
      [
        SHEET,
        section.sectionKind,
        bootstrapSectionEntityKey(section.sectionKind),
        SECTION_HASH,
        section.endpointSeq,
        section.operationId,
      ],
    )
    await sealSectionBootstrapOperation(query, {
      sheetId: SHEET,
      operationId: section.operationId,
      endpointSeq: section.endpointSeq,
      sectionKind: section.sectionKind,
      rowCount: '0',
      sourceHash: SECTION_HASH,
    })
    members.push({
      ordinal: members.length + 1,
      sectionKind: section.sectionKind,
      sourceHeadKind: 'section_bootstrap' as const,
      sourceOperationId: section.operationId,
      sourceHeadSeq: section.endpointSeq,
      rowCount: '0',
      sourceHash: SECTION_HASH,
    })
  }
  await sealArchiveSnapshotOperation(query, {
    sheetId: SHEET,
    operationId: ids.snapshotOperationId,
    endpointSeq: ids.snapshotSeq,
    members,
  })
}

async function transitionVerified(client: PoolClient, generationId: string): Promise<void> {
  await seedVerifiedObjectRosterIfPresent(client, generationId)
  await client.query(
    `UPDATE meta_recovery_archives
        SET state='verified',
            build_status='finalized',
            coverage_status='complete',
            root_hash=$2,
            coverage_section_hash=$3,
            coverage_row_count=0,
            manifest_mac=$4::bytea
      WHERE generation_id=$1::uuid`,
    [generationId, ROOT_HASH, COVERAGE_HASH, Buffer.from('d2-claim-anchor-mac')],
  )
}

async function restoreAmendment(): Promise<void> {
  if (!(await amendmentPresent())) await claimAnchorMigration.up(db)
  schemaIsUp = true
}

describeIfRealDbStep('Phase D2 recovery archive claim-anchor amendment (real DB)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    await installIfAbsent()

    await q(`INSERT INTO meta_recovery_archive_keys (key_id) VALUES ($1)`, [KEY_ID])
    await q(`INSERT INTO meta_bases (id, name, workspace_id) VALUES ($1, $2, $3), ($4, $5, $6)`, [
      BASE,
      `${PREFIX} Base`,
      WORKSPACE,
      OTHER_BASE,
      `${PREFIX} Other Base`,
      `${PREFIX}_other_workspace`,
    ])
    await q(
      `INSERT INTO meta_sheets (id, base_id, name, system_kind) VALUES
         ($1, $2, $3, NULL),
         ($4, $5, $6, NULL),
         ($7, $2, $8, 'people_directory')`,
      [SHEET, BASE, `${PREFIX} Sheet`, OTHER_SHEET, OTHER_BASE, `${PREFIX} Other Sheet`, SYSTEM_SHEET, `${PREFIX} System`],
    )
    await q(
      `INSERT INTO meta_history_trust_checkpoints (id, sheet_id, state, trusted_since_seq)
       VALUES ($1, $2, 'active', 1), ($3, $4, 'active', 1), ($5, $6, 'active', 1)`,
      [CHECKPOINT, SHEET, OTHER_CHECKPOINT, OTHER_SHEET, SYSTEM_CHECKPOINT, SYSTEM_SHEET],
    )

    initialFingerprint = await amendmentFingerprint()
  })

  test('the exact real-DB allowlist marker and database are active', () => {
    expect(process.env.METASHEET_REAL_DB_TEST_STEP).toBe('1')
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  afterEach(async () => {
    await q('ROLLBACK').catch(() => {})
    await restoreAmendment()
    await truncateOwnedState()
  })

  afterAll(async () => {
    try {
      await restoreAmendment()
      await truncateOwnedState()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`SELECT set_config('metasheet.mrho_retention', 'on', true)`)
        await client.query(`DELETE FROM meta_record_history_snapshot_members WHERE sheet_id = ANY($1::text[])`, [
          [SHEET, OTHER_SHEET, SYSTEM_SHEET],
        ])
        await client.query(`DELETE FROM meta_sheet_section_revisions WHERE sheet_id = ANY($1::text[])`, [
          [SHEET, OTHER_SHEET, SYSTEM_SHEET],
        ])
        await client.query(`DELETE FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])`, [
          [SHEET, OTHER_SHEET, SYSTEM_SHEET],
        ])
        await client.query(`DELETE FROM meta_record_history_operations WHERE sheet_id = ANY($1::text[])`, [
          [SHEET, OTHER_SHEET, SYSTEM_SHEET],
        ])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
      await q(`DELETE FROM meta_history_trust_checkpoints WHERE id = ANY($1::text[])`, [
        [CHECKPOINT, OTHER_CHECKPOINT, SYSTEM_CHECKPOINT],
      ])
      await q(`DELETE FROM meta_sheets WHERE id = ANY($1::text[])`, [[SHEET, OTHER_SHEET, SYSTEM_SHEET]])
      await q(`DELETE FROM meta_bases WHERE id = ANY($1::text[])`, [[BASE, OTHER_BASE]])
      const keyClient = await pool.connect()
      try {
        await keyClient.query('BEGIN')
        await keyClient.query('LOCK TABLE meta_recovery_archive_keys IN ACCESS EXCLUSIVE MODE')
        await keyClient.query('ALTER TABLE meta_recovery_archive_keys DISABLE TRIGGER USER')
        await keyClient.query('DELETE FROM meta_recovery_archive_keys WHERE key_id=$1', [KEY_ID])
        await keyClient.query('ALTER TABLE meta_recovery_archive_keys ENABLE TRIGGER USER')
        await keyClient.query('COMMIT')
      } catch (error) {
        await keyClient.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        keyClient.release()
      }
    } finally {
      await db.destroy()
    }
  })

  test('anchor id/seq stay NOT NULL and immutable, and deferred reservation RI is exact', async () => {
    const columns = await q(
      `SELECT column_name, is_nullable, udt_name
         FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='meta_recovery_archives'
          AND column_name IN ('anchor_operation_id', 'anchor_seq')
        ORDER BY column_name`,
    )
    expect(columns.rows).toEqual([
      { column_name: 'anchor_operation_id', is_nullable: 'NO', udt_name: 'uuid' },
      { column_name: 'anchor_seq', is_nullable: 'NO', udt_name: 'int8' },
    ])

    const rowGuards = await q(
      `SELECT count(*) FILTER (
                WHERE trigger_row.tgname='trg_meta_recovery_archives_guard_row'
              )::int AS predecessor_count,
              count(*) FILTER (
                WHERE trigger_row.tgname='trg_meta_recovery_archives_claim_anchor_guard_row'
                  AND trigger_row.tgqual IS NULL
              )::int AS replacement_count
         FROM pg_trigger trigger_row
         JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname='public'
          AND relation.relname='meta_recovery_archives'
          AND NOT trigger_row.tgisinternal`,
    )
    expect(rowGuards.rows).toEqual([{ predecessor_count: 0, replacement_count: 1 }])

    const deferred = await q(
      `SELECT trigger_row.tgdeferrable, trigger_row.tginitdeferred, trigger_row.tgtype
         FROM pg_trigger trigger_row
         JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname='public'
          AND relation.relname='meta_recovery_archives'
          AND trigger_row.tgname='trg_meta_recovery_archives_claim_anchor_reservation_guard'
          AND NOT trigger_row.tgisinternal`,
    )
    expect(deferred.rows).toEqual([{ tgdeferrable: true, tginitdeferred: true, tgtype: 21 }])

    const droppedFk = await q(
      `SELECT count(*)::int AS count
         FROM pg_constraint constraint_row
         JOIN pg_class relation ON relation.oid = constraint_row.conrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname='public'
          AND relation.relname='meta_recovery_archives'
          AND constraint_row.conname='fk_meta_recovery_archives_anchor'`,
    )
    expect(droppedFk.rows).toEqual([{ count: 0 }])

    const ids = allocateClaimIds()
    await claimOnPool(ids)
    const immutable = await errorOf(
      q(
        `UPDATE meta_recovery_archives
            SET anchor_seq = anchor_seq + 1
          WHERE generation_id=$1::uuid`,
        [ids.generationId],
      ),
    )
    expect(immutable.message).toBe('recovery_archive_identity_immutable')
    expectValuesFree(immutable, forbiddenIdentities([ids.generationId, ids.snapshotOperationId]))
  })

  test('old schema claim fails and the amended claim commits while ordinal-10 is unsealed', async () => {
    await truncateOwnedState()
    await claimAnchorMigration.down(db)
    schemaIsUp = false

    const oldIds = allocateClaimIds()
    const oldError = await errorOf(claimOnPool(oldIds))
    expect(['recovery_archive_binding_invalid', '23503']).toContain(
      oldError.message === 'recovery_archive_binding_invalid' ? oldError.message : oldError.code,
    )
    expectValuesFree(oldError, forbiddenIdentities([oldIds.generationId, oldIds.snapshotOperationId]))

    const fk = await q(
      `SELECT constraint_row.condeferrable, constraint_row.confdeltype,
              pg_get_constraintdef(constraint_row.oid, true) AS definition
         FROM pg_constraint constraint_row
         JOIN pg_class relation ON relation.oid = constraint_row.conrelid
         JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname='public'
          AND relation.relname='meta_recovery_archives'
          AND constraint_row.conname='fk_meta_recovery_archives_anchor'`,
    )
    expect(fk.rows).toEqual([
      {
        condeferrable: false,
        confdeltype: 'r',
        definition:
          'FOREIGN KEY (sheet_id, anchor_operation_id) REFERENCES meta_record_history_operations(sheet_id, operation_id) ON DELETE RESTRICT',
      },
    ])

    await claimAnchorMigration.up(db)
    schemaIsUp = true
    expect(await amendmentFingerprint()).toBe(initialFingerprint)

    const ids = allocateClaimIds()
    await claimOnPool(ids)
    const row = await q(
      `SELECT state, build_status, coverage_status, anchor_operation_id::text, anchor_seq::text,
              (SELECT count(*)::int
                 FROM meta_record_history_operations operation
                WHERE operation.operation_id = archive.anchor_operation_id) AS sealed_parent
         FROM meta_recovery_archives archive
        WHERE generation_id=$1::uuid`,
      [ids.generationId],
    )
    expect(row.rows).toEqual([
      {
        state: 'building',
        build_status: 'active',
        coverage_status: 'incomplete',
        anchor_operation_id: ids.snapshotOperationId,
        anchor_seq: ids.snapshotSeq,
        sealed_parent: 0,
      },
    ])
  })

  test('omit or alter the ordinal-10 reservation fails at COMMIT', async () => {
    const omitted = allocateClaimIds()
    const omitError = await errorOf(
      withTxn(async (client) => {
        await insertBuildingGeneration(client, omitted)
        await insertReservationSet(client, omitted, { omitOrdinal10: true })
      }),
    )
    expect(['recovery_archive_binding_invalid', 'recovery_archive_snapshot_reservation_set_invalid']).toContain(
      omitError.message,
    )
    expectValuesFree(omitError, forbiddenIdentities([omitted.generationId, omitted.snapshotOperationId]))

    const altered = allocateClaimIds()
    const alterError = await errorOf(
      withTxn(async (client) => {
        await insertBuildingGeneration(client, altered)
        await insertReservationSet(client, altered, {
          alterOrdinal10: { operationId: randomUUID(), endpointSeq: nextSeq() },
        })
      }),
    )
    expect(alterError.message).toBe('recovery_archive_binding_invalid')
    expectValuesFree(alterError, forbiddenIdentities([altered.generationId, altered.snapshotOperationId]))
  })

  test('wrong generation, sheet, source-vector, owner, op, or seq fails', async () => {
    const ids = allocateClaimIds()
    const sheetError = await errorOf(
      withTxn(async (client) => {
        await insertBuildingGeneration(client, ids)
        await insertReservationSet(client, ids, { sheetId: OTHER_SHEET })
      }),
    )
    expect(sheetError.message).toBe('recovery_archive_snapshot_reservation_parent_invalid')
    expectValuesFree(sheetError, forbiddenIdentities([ids.generationId, OTHER_SHEET]))

    const vectorIds = allocateClaimIds()
    const vectorError = await errorOf(
      withTxn(async (client) => {
        await insertBuildingGeneration(client, vectorIds)
        await insertReservationSet(client, vectorIds, { sourceVectorHash: OTHER_SOURCE_VECTOR_HASH })
      }),
    )
    expect(vectorError.message).toBe('recovery_archive_snapshot_reservation_parent_invalid')

    const ownerIds = allocateClaimIds()
    const ownerError = await errorOf(
      withTxn(async (client) => {
        await insertBuildingGeneration(client, ownerIds)
        await insertReservationSet(client, ownerIds, { ownerId: `${PREFIX}_other_owner` })
      }),
    )
    expect(ownerError.message).toBe('recovery_archive_snapshot_reservation_parent_invalid')

    const opIds = allocateClaimIds()
    const opError = await errorOf(
      withTxn(async (client) => {
        await insertBuildingGeneration(client, opIds, { anchorOperationId: randomUUID() })
        await insertReservationSet(client, opIds)
      }),
    )
    expect(opError.message).toBe('recovery_archive_binding_invalid')

    const seqIds = allocateClaimIds()
    const seqError = await errorOf(
      withTxn(async (client) => {
        await insertBuildingGeneration(client, seqIds, { anchorSeq: nextSeq() })
        await insertReservationSet(client, seqIds)
      }),
    )
    expect(seqError.message).toBe('recovery_archive_binding_invalid')
  })

  test('an arbitrary absent operation is refused at COMMIT', async () => {
    const ids = allocateClaimIds()
    const error = await errorOf(
      withTxn(async (client) => {
        await insertBuildingGeneration(client, ids)
      }),
    )
    expect(error.message).toBe('recovery_archive_binding_invalid')
    expectValuesFree(error, forbiddenIdentities([ids.generationId, ids.snapshotOperationId]))
  })

  test('existing catalog binding, checkpoint, system-sheet, and posture guards stay values-free', async () => {
    const ids = allocateClaimIds()
    const systemError = await errorOf(
      withTxn(async (client) => {
        await insertBuildingGeneration(client, ids, {
          sheetId: SYSTEM_SHEET,
          checkpointId: SYSTEM_CHECKPOINT,
        })
      }),
    )
    expect(systemError.message).toBe('recovery_archive_binding_invalid')
    expectValuesFree(systemError, forbiddenIdentities([SYSTEM_SHEET]))

    const checkpointError = await errorOf(
      withTxn(async (client) => {
        await insertBuildingGeneration(client, ids, { checkpointId: OTHER_CHECKPOINT })
      }),
    )
    expect(checkpointError.message).toBe('recovery_archive_binding_invalid')

    const workspaceError = await errorOf(
      withTxn(async (client) => {
        await insertBuildingGeneration(client, ids, { workspaceId: null })
      }),
    )
    expect(workspaceError.message).toBe('recovery_archive_binding_invalid')
  })

  test('verify before parent seal fails; exact parent-last seal then transition succeeds', async () => {
    const ids = allocateClaimIds()
    await claimOnPool(ids)

    const unsealed = await errorOf(
      withTxn(async (client) => {
        await transitionVerified(client, ids.generationId)
      }),
    )
    expect(unsealed.message).toBe('recovery_archive_claim_anchor_parent_unsealed')
    expectValuesFree(unsealed, forbiddenIdentities([ids.generationId, ids.snapshotOperationId]))

    await withTxn(async (client) => {
      await sealReservedParent(client, ids)
      await transitionVerified(client, ids.generationId)
    })

    const row = await q(
      `SELECT state, build_status, coverage_status,
              (SELECT operation_kind
                 FROM meta_record_history_operations operation
                WHERE operation.operation_id = archive.anchor_operation_id) AS kind,
              (SELECT event_count::text
                 FROM meta_record_history_operations operation
                WHERE operation.operation_id = archive.anchor_operation_id) AS event_count,
              (SELECT component_count::text
                 FROM meta_record_history_operations operation
                WHERE operation.operation_id = archive.anchor_operation_id) AS component_count,
              (SELECT count(*)::int
                 FROM meta_record_history_snapshot_members member_row
                WHERE member_row.parent_operation_id = archive.anchor_operation_id) AS members
         FROM meta_recovery_archives archive
        WHERE generation_id=$1::uuid`,
      [ids.generationId],
    )
    expect(row.rows).toEqual([
      {
        state: 'verified',
        build_status: 'finalized',
        coverage_status: 'complete',
        kind: 'archive_snapshot',
        event_count: '0',
        component_count: '9',
        members: 9,
      },
    ])
  })

  test('verify refuses a sealed parent whose members do not match the reserved source identities', async () => {
    const foreignSections = SECTION_KINDS.map((sectionKind) => ({
      sectionKind,
      operationId: randomUUID(),
      endpointSeq: nextSeq(),
    }))
    const ids = allocateClaimIds()
    await claimOnPool(ids)

    await withTxn(async (client) => {
      await sealSnapshotParentFromSections(client, ids, foreignSections)
    })

    const error = await errorOf(withTxn((client) => transitionVerified(client, ids.generationId)))
    expect(error.code).toBe('23514')
    expect(error.message).toBe('recovery_archive_claim_anchor_parent_unsealed')
    expectValuesFree(error, forbiddenIdentities([
      ids.generationId,
      ids.snapshotOperationId,
      ...foreignSections.map((section) => section.operationId),
    ]))
  })

  test('deleting a referenced parent fails for every archive state', async () => {
    const ids = allocateClaimIds()
    await claimOnPool(ids)
    await withTxn(async (client) => {
      await sealReservedParent(client, ids)
    })

    const buildingDelete = await errorOf(
      withTxn(async (client) => {
        await client.query(`SELECT set_config('metasheet.mrho_retention', 'on', true)`)
        await client.query(`DELETE FROM meta_record_history_operations WHERE operation_id=$1::uuid`, [
          ids.snapshotOperationId,
        ])
      }),
    )
    expect(buildingDelete.message).toBe('recovery_archive_anchor_operation_referenced')
    expectValuesFree(buildingDelete, forbiddenIdentities([ids.generationId, ids.snapshotOperationId]))

    await withTxn(async (client) => {
      await transitionVerified(client, ids.generationId)
    })

    const verifiedDelete = await errorOf(
      withTxn(async (client) => {
        await client.query(`SELECT set_config('metasheet.mrho_retention', 'on', true)`)
        await client.query(`DELETE FROM meta_record_history_operations WHERE operation_id=$1::uuid`, [
          ids.snapshotOperationId,
        ])
      }),
    )
    expect(verifiedDelete.message).toBe('recovery_archive_anchor_operation_referenced')
  })

  test('operation delete fails fast instead of waiting behind an archive-row holder', async () => {
    const ids = allocateClaimIds()
    await claimOnPool(ids)
    await withTxn(async (client) => {
      await sealReservedParent(client, ids)
    })

    const holder = await pool.connect()
    const deleter = await pool.connect()
    let holderOpen = false
    let deleterOpen = false
    try {
      await holder.query('BEGIN')
      holderOpen = true
      await holder.query(
        `SELECT 1
           FROM meta_recovery_archives
          WHERE generation_id=$1::uuid
          FOR UPDATE`,
        [ids.generationId],
      )

      await deleter.query('BEGIN')
      deleterOpen = true
      await deleter.query(`SET LOCAL lock_timeout = '250ms'`)
      const busy = await errorOf(deleteSealedOperation(deleter, ids.snapshotOperationId))
      expect(busy.code).toBe('55P03')
      expect(busy.message).toBe('recovery_archive_claim_anchor_busy')
      expectValuesFree(busy, forbiddenIdentities([ids.generationId, ids.snapshotOperationId]))
      await deleter.query('ROLLBACK')
      deleterOpen = false

      await transitionVerified(holder, ids.generationId)
      await holder.query('COMMIT')
      holderOpen = false
      expect(await operationExists(ids.snapshotOperationId)).toBe(true)
    } finally {
      if (deleterOpen) await deleter.query('ROLLBACK').catch(() => {})
      if (holderOpen) await holder.query('ROLLBACK').catch(() => {})
      deleter.release()
      holder.release()
    }
  })

  test('building->verified refuses a compatibility-arm ordinary parent values-free', async () => {
    const ordinaryOp = randomUUID()
    const ordinarySeq = nextSeq()
    await seedOrdinarySealedOperation(ordinaryOp, ordinarySeq)
    const ids: ClaimIds = {
      generationId: randomUUID(),
      snapshotOperationId: ordinaryOp,
      snapshotSeq: ordinarySeq,
      sections: [],
    }
    await withTxn(async (client) => {
      await insertBuildingGeneration(client, ids)
    })

    const unsealed = await errorOf(
      withTxn(async (client) => {
        await transitionVerified(client, ids.generationId)
      }),
    )
    expect(unsealed.message).toBe('recovery_archive_claim_anchor_parent_unsealed')
    expectValuesFree(unsealed, forbiddenIdentities([ids.generationId, ordinaryOp, ordinarySeq]))

    const neutralized = await errorOf(
      withTxn(async (client) => {
        await client.query(`
          CREATE OR REPLACE FUNCTION public.meta_recovery_archives_claim_anchor_guard_row()
          RETURNS trigger
          LANGUAGE plpgsql
          SET search_path = pg_catalog, public
          AS $gated$
          DECLARE
            coverage_count bigint;
          BEGIN
            IF TG_OP = 'DELETE' THEN
              RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_delete_not_authorized';
            END IF;
            IF TG_OP IN ('INSERT', 'UPDATE') THEN
              PERFORM 1
                FROM public.meta_record_history_operations operation
               WHERE operation.sheet_id = NEW.sheet_id
                 AND operation.operation_id = NEW.anchor_operation_id
               FOR KEY SHARE;
            END IF;
            IF TG_OP = 'INSERT' THEN
              RETURN NEW;
            END IF;
            IF OLD.state = 'building' AND NEW.state = 'verified' THEN
              IF EXISTS (
                SELECT 1
                  FROM public.meta_recovery_archive_snapshot_reservations reservation
                 WHERE reservation.generation_id = NEW.generation_id
                   AND reservation.ordinal = 10
                   AND reservation.reservation_kind = 'archive_snapshot'
              ) THEN
                RAISE EXCEPTION USING
                  ERRCODE = '23514',
                  MESSAGE = 'recovery_archive_claim_anchor_parent_unsealed';
              END IF;
            END IF;
            NEW.updated_at := clock_timestamp();
            RETURN NEW;
          END
          $gated$
        `)
        await seedVerifiedObjectRosterIfPresent(client, ids.generationId)
        await client.query(
          `UPDATE meta_recovery_archives
              SET state='verified',
                  build_status='finalized',
                  coverage_status='complete',
                  root_hash=$2,
                  coverage_section_hash=$3,
                  coverage_row_count=0,
                  manifest_mac=$4::bytea
            WHERE generation_id=$1::uuid`,
          [ids.generationId, ROOT_HASH, COVERAGE_HASH, Buffer.from('d2-claim-anchor-mac')],
        )
        throw new Error('claim_anchor_unconditional_parent_guard_missing')
      }),
    )
    expect(neutralized.message).toBe('claim_anchor_unconditional_parent_guard_missing')
  })

  /**
   * Catalog insert takes KEY SHARE on an existing operation before inserting the archive.
   * Operation DELETE already holds the operation row and probes matching archives NOWAIT,
   * so an archive-first UPDATE cannot complete the reverse wait edge.
   */
  test('insert vs delete races cannot leave a catalog row pointing at a deleted operation', async () => {
    const ordinaryOp = randomUUID()
    const ordinarySeq = nextSeq()
    await seedOrdinarySealedOperation(ordinaryOp, ordinarySeq)
    const insertIds: ClaimIds = {
      generationId: randomUUID(),
      snapshotOperationId: ordinaryOp,
      snapshotSeq: ordinarySeq,
      sections: [],
    }

    const deleter = await pool.connect()
    const inserter = await pool.connect()
    let deleterOpen = false
    let inserterOpen = false
    try {
      await deleter.query('BEGIN')
      deleterOpen = true
      const deleterPid = await backendPid(deleter)
      await deleteSealedOperation(deleter, ordinaryOp)

      await inserter.query('BEGIN')
      inserterOpen = true
      const inserterPid = await backendPid(inserter)
      const insertWait = insertBuildingGeneration(inserter, insertIds)
      await waitForBlockedBy(inserterPid, deleterPid)
      await deleter.query('COMMIT')
      deleterOpen = false
      const insertError = await errorOf(insertWait.then(() => inserter.query('COMMIT')))
      expect(['recovery_archive_binding_invalid', '40001', '55P03']).toContain(
        insertError.message === 'recovery_archive_binding_invalid' ? insertError.message : insertError.code,
      )
      expect(await countAnchorsTo(ordinaryOp)).toBe(0)
      expect(await operationExists(ordinaryOp)).toBe(false)
    } finally {
      if (inserterOpen) await inserter.query('ROLLBACK').catch(() => {})
      if (deleterOpen) await deleter.query('ROLLBACK').catch(() => {})
      inserter.release()
      deleter.release()
    }

    const ordinaryOp2 = randomUUID()
    const ordinarySeq2 = nextSeq()
    await seedOrdinarySealedOperation(ordinaryOp2, ordinarySeq2)
    const heldIds: ClaimIds = {
      generationId: randomUUID(),
      snapshotOperationId: ordinaryOp2,
      snapshotSeq: ordinarySeq2,
      sections: [],
    }

    const holder = await pool.connect()
    const lateDeleter = await pool.connect()
    let holderOpen = false
    let lateDeleterOpen = false
    try {
      await holder.query('BEGIN')
      holderOpen = true
      await insertBuildingGeneration(holder, heldIds)
      const holderPid = await backendPid(holder)

      await lateDeleter.query('BEGIN')
      lateDeleterOpen = true
      const lateDeleterPid = await backendPid(lateDeleter)
      const deleteWait = deleteSealedOperation(lateDeleter, ordinaryOp2)
      await waitForBlockedBy(lateDeleterPid, holderPid)
      await holder.query('COMMIT')
      holderOpen = false
      const deleteError = await errorOf(deleteWait.then(() => lateDeleter.query('COMMIT')))
      expect(deleteError.message).toBe('recovery_archive_anchor_operation_referenced')
      expect(await countAnchorsTo(ordinaryOp2)).toBe(1)
      expect(await operationExists(ordinaryOp2)).toBe(true)
    } finally {
      if (lateDeleterOpen) await lateDeleter.query('ROLLBACK').catch(() => {})
      if (holderOpen) await holder.query('ROLLBACK').catch(() => {})
      lateDeleter.release()
      holder.release()
    }
  })

  test('deferred compatibility KEY SHARE covers an operation that appears after BEFORE INSERT', async () => {
    const ordinaryOp = randomUUID()
    const ordinarySeq = nextSeq()
    const ids: ClaimIds = {
      generationId: randomUUID(),
      snapshotOperationId: ordinaryOp,
      snapshotSeq: ordinarySeq,
      sections: [],
    }

    const claimer = await pool.connect()
    const sealer = await pool.connect()
    const deleter = await pool.connect()
    let claimerOpen = false
    let sealerOpen = false
    let deleterOpen = false
    let commitWait: Promise<unknown> | undefined
    try {
      await claimer.query('BEGIN')
      claimerOpen = true
      const claimerPid = await backendPid(claimer)
      await insertBuildingGeneration(claimer, ids)

      await sealer.query('BEGIN')
      sealerOpen = true
      await insertOrdinarySealedOperation(sealer, ordinaryOp, ordinarySeq)
      await sealer.query('COMMIT')
      sealerOpen = false
      expect(await operationExists(ordinaryOp)).toBe(true)

      await deleter.query('BEGIN')
      deleterOpen = true
      const deleterPid = await backendPid(deleter)
      await deleteSealedOperation(deleter, ordinaryOp)

      commitWait = claimer.query('COMMIT')
      await waitForBlockedBy(claimerPid, deleterPid)
      await deleter.query('COMMIT')
      deleterOpen = false
      const commitError = await errorOf(commitWait)
      expect(['recovery_archive_binding_invalid', '40001', '55P03']).toContain(
        commitError.message === 'recovery_archive_binding_invalid' ? commitError.message : commitError.code,
      )
      expect(await countAnchorsTo(ordinaryOp)).toBe(0)
      expect(await operationExists(ordinaryOp)).toBe(false)
    } finally {
      if (deleterOpen) await deleter.query('ROLLBACK').catch(() => {})
      if (sealerOpen) await sealer.query('ROLLBACK').catch(() => {})
      await Promise.resolve(commitWait).catch(() => {})
      if (claimerOpen) await claimer.query('ROLLBACK').catch(() => {})
      claimer.release()
      sealer.release()
      deleter.release()
    }
  })

  test('verify vs delete races cannot drop a referenced parent under a live catalog row', async () => {
    const ids = allocateClaimIds()
    await claimOnPool(ids)
    await withTxn(async (client) => {
      await sealReservedParent(client, ids)
    })

    const verifier = await pool.connect()
    const deleter = await pool.connect()
    let verifierOpen = false
    let deleterOpen = false
    try {
      await verifier.query('BEGIN')
      verifierOpen = true
      await seedVerifiedObjectRosterIfPresent(verifier, ids.generationId)
      const verifierPid = await backendPid(verifier)
      const verifyWait = verifier.query(
        `UPDATE meta_recovery_archives
            SET state='verified',
                build_status='finalized',
                coverage_status='complete',
                root_hash=$2,
                coverage_section_hash=$3,
                coverage_row_count=0,
                manifest_mac=$4::bytea
          WHERE generation_id=$1::uuid`,
        [ids.generationId, ROOT_HASH, COVERAGE_HASH, Buffer.from('d2-claim-anchor-mac')],
      )

      await deleter.query('BEGIN')
      deleterOpen = true
      const deleterPid = await backendPid(deleter)
      const deleteWait = deleteSealedOperation(deleter, ids.snapshotOperationId)

      const deadline = Date.now() + 5_000
      let blockedPair: 'verify-waits' | 'delete-waits' | null = null
      while (Date.now() < deadline && blockedPair === null) {
        const [verifyState, deleteState] = await Promise.all([
          q(
            `SELECT wait_event_type = 'Lock'
                    AND $2::int = ANY(pg_catalog.pg_blocking_pids($1::int)) AS blocked
               FROM pg_catalog.pg_stat_activity
              WHERE pid=$1::int`,
            [verifierPid, deleterPid],
          ),
          q(
            `SELECT wait_event_type = 'Lock'
                    AND $2::int = ANY(pg_catalog.pg_blocking_pids($1::int)) AS blocked
               FROM pg_catalog.pg_stat_activity
              WHERE pid=$1::int`,
            [deleterPid, verifierPid],
          ),
        ])
        if (verifyState.rows[0]?.blocked === true) blockedPair = 'verify-waits'
        else if (deleteState.rows[0]?.blocked === true) blockedPair = 'delete-waits'
        else {
          await new Promise<void>((resolve) => {
            setImmediate(resolve)
          })
        }
      }
      if (blockedPair === null) {
        // One statement may already have finished fail-closed. Drain both.
        const verifyError = await errorOf(verifyWait.then(() => verifier.query('COMMIT')))
        verifierOpen = false
        const deleteError = await errorOf(deleteWait.then(() => deleter.query('COMMIT')))
        deleterOpen = false
        const dangling = (await countAnchorsTo(ids.snapshotOperationId)) > 0 && !(await operationExists(ids.snapshotOperationId))
        expect(dangling).toBe(false)
        expect(
          [verifyError.message, deleteError.message].some(
            (message) =>
              message === 'recovery_archive_anchor_operation_referenced' ||
              message === 'recovery_archive_claim_anchor_parent_unsealed' ||
              message === 'expected_database_rejection',
          ),
        ).toBe(true)
        return
      }

      if (blockedPair === 'verify-waits') {
        await deleter.query('COMMIT')
        deleterOpen = false
        const verifyError = await errorOf(verifyWait.then(() => verifier.query('COMMIT')))
        verifierOpen = false
        expect(['recovery_archive_claim_anchor_parent_unsealed', 'recovery_archive_anchor_operation_referenced']).toContain(
          verifyError.message,
        )
      } else {
        await verifier.query('COMMIT')
        verifierOpen = false
        const deleteError = await errorOf(deleteWait.then(() => deleter.query('COMMIT')))
        deleterOpen = false
        expect(deleteError.message).toBe('recovery_archive_anchor_operation_referenced')
      }
      expect(
        (await countAnchorsTo(ids.snapshotOperationId)) > 0 && !(await operationExists(ids.snapshotOperationId)),
      ).toBe(false)
    } finally {
      if (verifierOpen) await verifier.query('ROLLBACK').catch(() => {})
      if (deleterOpen) await deleter.query('ROLLBACK').catch(() => {})
      verifier.release()
      deleter.release()
    }
  })

  test('neutralizing each new guard makes its targeted golden red', async () => {
    const unbound = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          DROP TRIGGER trg_meta_recovery_archives_claim_anchor_reservation_guard
            ON public.meta_recovery_archives
        `.execute(trx)
        const ids = allocateClaimIds()
        await sql`
          INSERT INTO meta_recovery_archives (
            generation_id, workspace_id, base_id, sheet_id, anchor_operation_id, anchor_seq,
            checkpoint_id, format_version, state, build_status, coverage_status,
            source_vector_hash, key_id, owner_kind, owner_id, owner_fence,
            lease_expires_at, expires_at
          ) VALUES (
            ${ids.generationId}::uuid, ${WORKSPACE}, ${BASE}, ${SHEET}, ${ids.snapshotOperationId}::uuid,
            ${ids.snapshotSeq}::bigint, ${CHECKPOINT}, 1, 'building', 'active', 'incomplete',
            ${SOURCE_VECTOR_HASH}, ${KEY_ID}, ${OWNER_KIND}, ${OWNER_ID}, 1,
            ${LEASE_EXPIRES_AT}::timestamptz, ${EXPIRES_AT}::timestamptz
          )
        `.execute(trx)
        throw new Error('claim_anchor_reservation_guard_missing')
      }),
    )
    expect(unbound.message).toBe('claim_anchor_reservation_guard_missing')

    const ids = allocateClaimIds()
    await claimOnPool(ids)
    const verifyHole = await errorOf(
      withTxn(async (client) => {
        await client.query(`
          CREATE OR REPLACE FUNCTION public.meta_recovery_archives_claim_anchor_guard_row()
          RETURNS trigger
          LANGUAGE plpgsql
          SET search_path = pg_catalog, public
          AS $neutral$
          BEGIN
            IF TG_OP = 'DELETE' THEN
              RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'recovery_archive_delete_not_authorized';
            END IF;
            NEW.updated_at := clock_timestamp();
            RETURN NEW;
          END
          $neutral$
        `)
        await seedVerifiedObjectRosterIfPresent(client, ids.generationId)
        await client.query(
          `UPDATE meta_recovery_archives
              SET state='verified',
                  build_status='finalized',
                  coverage_status='complete',
                  root_hash=$2,
                  coverage_section_hash=$3,
                  coverage_row_count=0,
                  manifest_mac=$4::bytea
            WHERE generation_id=$1::uuid`,
          [ids.generationId, ROOT_HASH, COVERAGE_HASH, Buffer.from('d2-claim-anchor-mac')],
        )
        throw new Error('claim_anchor_verify_guard_missing')
      }),
    )
    expect(verifyHole.message).toBe('claim_anchor_verify_guard_missing')

    await withTxn(async (client) => {
      await sealReservedParent(client, ids)
    })
    const deleteHole = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          DROP TRIGGER trg_mrho_claim_anchor_delete_guard
            ON public.meta_record_history_operations
        `.execute(trx)
        await sql`SELECT set_config('metasheet.mrho_retention', 'on', true)`.execute(trx)
        await sql`
          DELETE FROM meta_record_history_operations
           WHERE operation_id = ${ids.snapshotOperationId}::uuid
        `.execute(trx)
        throw new Error('claim_anchor_delete_guard_missing')
      }),
    )
    expect(deleteHole.message).toBe('claim_anchor_delete_guard_missing')
    expect(await amendmentFingerprint()).toBe(initialFingerprint)
  })

  test('migration replay is exact, drift and collision fail loud, nonempty incompatible down refuses', async () => {
    const ids = allocateClaimIds()
    await claimOnPool(ids)

    const nonempty = await errorOf(claimAnchorMigration.down(db))
    expect(nonempty.message).toBe('recovery_archive_claim_anchor_incompatible')
    expect(await amendmentFingerprint()).toBe(initialFingerprint)
    expectValuesFree(nonempty, forbiddenIdentities([ids.generationId, ids.snapshotOperationId]))

    await truncateOwnedState()
    await claimAnchorMigration.down(db)
    schemaIsUp = false

    const weakPredecessor = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          CREATE OR REPLACE FUNCTION public.meta_recovery_archives_guard_row()
          RETURNS trigger
          LANGUAGE plpgsql
          SET search_path = pg_catalog, public
          AS $drift$
          BEGIN
            RETURN NEW;
          END
          $drift$
        `.execute(trx)
        await claimAnchorMigration.up(trx)
        throw new Error('claim_anchor_source_schema_guard_missing')
      }),
    )
    expect(weakPredecessor.message).toBe('recovery_archive_claim_anchor_source_schema_mismatch')

    const collision = await errorOf(
      db.transaction().execute(async (trx) => {
        await sql`
          CREATE FUNCTION public.meta_recovery_archives_claim_anchor_guard_row()
          RETURNS trigger
          LANGUAGE plpgsql
          AS $collision$
          BEGIN
            RETURN NEW;
          END
          $collision$
        `.execute(trx)
        await claimAnchorMigration.up(trx)
        throw new Error('claim_anchor_object_conflict_guard_missing')
      }),
    )
    expect(collision.message).toBe('recovery_archive_claim_anchor_object_conflict')

    await claimAnchorMigration.up(db)
    schemaIsUp = true
    expect(await amendmentFingerprint()).toBe(initialFingerprint)
  })
})
