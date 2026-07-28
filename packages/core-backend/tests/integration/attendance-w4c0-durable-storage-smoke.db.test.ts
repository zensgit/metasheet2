import { afterAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { query } from '../../src/db/pg'
import { down } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'

/**
 * W4C-0 (#4556) Stage A smoke — durable storage migration
 * (`zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage`).
 *
 * Minimal migration-liveness gates only (the full section 12.1 + amendment section 2 test
 * matrix is delivered by the later W4C-0 stages in this same slice):
 *  - the canonical SQL UUIDv5 function reproduces the RFC 4122 known vector and derives
 *    a version-5/RFC-variant import-item identity;
 *  - the item registry rejects a wrong derived operation ID and a cross-source masquerade
 *    at the DB boundary;
 *  - a persisted `claimed` operation row cannot commit (deferred constraint trigger);
 *  - a completed operation row refuses UPDATE and DELETE;
 *  - attendance_import_jobs accepts the legacy all-null W4 shape, rejects a partial V1
 *    shape, accepts the complete V1 shape with a proof vector verified through the SQL
 *    UUIDv5 function, and freezes `accepted_write_posture` against UPDATE;
 *  - down() fail-closes BEFORE DDL while any W4 registry row exists (this test inserts a
 *    completed operation row first, so calling down() here must throw and drop nothing).
 *
 * Shared-DB discipline: all fixture identity is namespaced by `w4c0smoke<ts><rand>`;
 * registry rows are append-only by design and are deliberately left in place (CI
 * provisions a fresh database per run).
 */
const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const NS = `w4c0smoke${Date.now()}${crypto.randomBytes(4).toString('hex')}`
const ORG = `${NS}-org`

const IMPORT_NS = '6f67fdaa-e2aa-48b3-b76c-c4aab9723173'
const HEX64_A = 'a'.repeat(64)

function uuid(): string {
  return crypto.randomUUID()
}

describeIfDatabase('W4C-0 Stage A — durable storage migration smoke (real DB)', () => {
  const jobIds: string[] = []
  let migrationDb: Kysely<unknown> | undefined

  afterAll(async () => {
    if (jobIds.length) {
      await query('DELETE FROM attendance_import_jobs WHERE id = ANY($1::uuid[])', [jobIds])
    }
    await migrationDb?.destroy()
  })

  it('reproduces the RFC 4122 UUIDv5 known vector through the canonical SQL function', async () => {
    const { rows } = await query<{ v: string }>(
      "SELECT attendance_w4_uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid, convert_to('www.example.com','UTF8'))::text AS v",
    )
    expect(rows[0].v).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2')
  })

  it('derives an import-item identity with version-5 and RFC variant bits', async () => {
    const root = uuid()
    const { rows } = await query<{ v: string }>(
      'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($1::uuid, 0, $2))::text AS v',
      [root, HEX64_A],
    )
    expect(rows[0].v).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('accepts a congruent completed import batch + derived item, then freezes it', async () => {
    const batchId = uuid()
    const { rows } = await query<{ v: string }>(
      'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $3))::text AS v',
      [IMPORT_NS, batchId, HEX64_A],
    )
    const derivedItemId = rows[0].v

    // Batch + item must land in ONE transaction: the deferred batch-items commit guard
    // rejects a completed batch whose attached item count mismatches at commit.
    const pool = new Pool({ connectionString: dbUrl })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO attendance_result_operation_batches
          (org_id, entrypoint, batch_command_id, identity_source_kind, source_root_id, source_ref,
           actor_id, actor_posture, capability, subject_scope, accepted_write_posture,
           command_fingerprint, item_count, item_sequence_fingerprint, item_set_fingerprint, state, response_snapshot)
         VALUES ($1, 'import_batch', $2, 'import_batch', $2, 'batch:smoke', 'actor-smoke', 'delegated_import',
                 'import', '{}'::jsonb, 'shadow', $3, 1, $3, $3, 'completed', '{"order":[],"byId":{}}'::jsonb)`,
        [ORG, batchId, 'b'.repeat(64)],
      )
      await client.query(
        `INSERT INTO attendance_result_operations
          (org_id, entrypoint, operation_id, batch_command_id, input_ordinal, identity_source_kind,
           source_root_id, proof_semantic_fingerprint, source_ref, actor_id, actor_posture, capability,
           subject_scope, command_fingerprint, accepted_write_posture, state,
           normalized_business_input_snapshot, response_snapshot)
         VALUES ($1, 'import_batch', $2, $3, 0, 'import_item', $3, $4, 'item:smoke', 'actor-smoke',
                 'delegated_import', 'import', '{}'::jsonb, $5, 'shadow', 'completed', '{}'::jsonb, '{"ok":true}'::jsonb)`,
        [ORG, derivedItemId, batchId, HEX64_A, 'c'.repeat(64)],
      )
      await client.query('COMMIT')
    } finally {
      client.release()
      await pool.end()
    }

    // Completed row: UPDATE and DELETE both refused at the DB boundary.
    await expect(
      query(
        `UPDATE attendance_result_operations SET response_snapshot = '{"ok":false}'::jsonb
         WHERE org_id = $1 AND entrypoint = 'import_batch' AND operation_id = $2`,
        [ORG, derivedItemId],
      ),
    ).rejects.toThrow(/W4C0_OPERATION_STATE/)
    await expect(
      query(
        `DELETE FROM attendance_result_operations
         WHERE org_id = $1 AND entrypoint = 'import_batch' AND operation_id = $2`,
        [ORG, derivedItemId],
      ),
    ).rejects.toThrow(/W4C0_IMMUTABLE/)
  })

  it('rejects a wrong derived operation ID and a cross-source masquerade', async () => {
    const batchId = uuid()
    // Wrong derived ID (a fresh random UUID cannot equal the namespace derivation).
    // The CHECK is immediate, so the statement itself fails inside a rolled-back
    // transaction that also carries the (never-committed) batch row.
    const pool = new Pool({ connectionString: dbUrl })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO attendance_result_operation_batches
          (org_id, entrypoint, batch_command_id, identity_source_kind, source_root_id, source_ref,
           actor_id, actor_posture, capability, subject_scope, accepted_write_posture,
           command_fingerprint, item_count, item_sequence_fingerprint, item_set_fingerprint, state, response_snapshot)
         VALUES ($1, 'import_batch', $2, 'import_batch', $2, 'batch:smoke', 'actor-smoke', 'delegated_import',
                 'import', '{}'::jsonb, 'shadow', $3, 1, $3, $3, 'completed', '{"order":[],"byId":{}}'::jsonb)`,
        [ORG, batchId, 'd'.repeat(64)],
      )
      await expect(
        client.query(
          `INSERT INTO attendance_result_operations
            (org_id, entrypoint, operation_id, batch_command_id, input_ordinal, identity_source_kind,
             source_root_id, proof_semantic_fingerprint, source_ref, actor_id, actor_posture, capability,
             subject_scope, command_fingerprint, accepted_write_posture, state,
             normalized_business_input_snapshot, response_snapshot)
           VALUES ($1, 'import_batch', $2, $3, 0, 'import_item', $3, $4, 'item:smoke', 'actor-smoke',
                   'delegated_import', 'import', '{}'::jsonb, $5, 'shadow', 'completed', '{}'::jsonb, '{"ok":true}'::jsonb)`,
          [ORG, uuid(), batchId, HEX64_A, 'e'.repeat(64)],
        ),
      ).rejects.toThrow(/chk_aro_derived_identity/)
      await client.query('ROLLBACK')
    } finally {
      client.release()
      await pool.end()
    }

    // Cross-source masquerade: an import-item UUIDv5 presented as a scheduled identity
    // fails the scheduled-namespace derivation check.
    const importDerived = (
      await query<{ v: string }>(
        'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $3))::text AS v',
        [IMPORT_NS, batchId, HEX64_A],
      )
    ).rows[0].v
    await expect(
      query(
        `INSERT INTO attendance_result_operations
          (org_id, entrypoint, operation_id, identity_source_kind, source_root_id, proof_user_id,
           proof_work_date, source_ref, actor_id, actor_posture, capability, subject_scope,
           command_fingerprint, accepted_write_posture, state, response_snapshot)
         VALUES ($1, 'scheduled', $2, 'scheduled', $3, $4, '2026-07-25', 'sched:smoke', 'actor-smoke',
                 'scheduler', 'scheduled', '{}'::jsonb, $5, 'shadow', 'completed', '{"ok":true}'::jsonb)`,
        [ORG, importDerived, batchId, uuid(), 'f'.repeat(64)],
      ),
    ).rejects.toThrow(/chk_aro_derived_identity/)
  })

  it('rejects committing a persisted claimed operation row (deferred constraint)', async () => {
    const pool = new Pool({ connectionString: dbUrl })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO attendance_result_operations
          (org_id, entrypoint, operation_id, identity_source_kind, source_ref, actor_id, actor_posture,
           capability, subject_scope, command_fingerprint, accepted_write_posture, state)
         VALUES ($1, 'live_punch', $2, 'direct_live_punch', 'live:smoke', 'actor-smoke', 'self',
                 'punch', '{}'::jsonb, $3, 'shadow', 'claimed')`,
        [ORG, uuid(), '0'.repeat(64)],
      )
      await expect(client.query('COMMIT')).rejects.toThrow(/W4C0_CLAIMED_COMMIT/)
    } finally {
      client.release()
      await pool.end()
    }
  })

  it('enforces the attendance_import_jobs null-all-or-V1-complete shape and frozen fields', async () => {
    // Legacy all-null W4 shape inserts unchanged.
    const legacy = (
      await query<{ id: string }>(
        `INSERT INTO attendance_import_jobs (org_id, batch_id, created_by, status, payload)
         VALUES ($1, $2, 'actor-smoke', 'queued', '{}'::jsonb) RETURNING id::text AS id`,
        [ORG, uuid()],
      )
    ).rows[0].id
    jobIds.push(legacy)

    // Partial V1 shape fails the shape constraint.
    await expect(
      query(
        `INSERT INTO attendance_import_jobs (org_id, batch_id, created_by, status, payload, w4_contract_version, w4_entrypoint)
         VALUES ($1, $2, 'actor-smoke', 'queued', '{}'::jsonb, 1, 'import_batch')`,
        [ORG, uuid()],
      ),
    ).rejects.toThrow(/chk_aij_w4_shape/)

    // Complete V1 shape with a proof vector verified through the canonical SQL function.
    const reservation = uuid()
    const v1 = (
      await query<{ id: string }>(
        `INSERT INTO attendance_import_jobs
          (org_id, batch_id, created_by, status, payload, w4_contract_version, w4_entrypoint,
           w4_batch_command_id, w4_source_kind, w4_source_ref, w4_actor_id, w4_actor_posture,
           w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
           w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector)
         SELECT $1, $2, 'actor-smoke', 'queued', '{}'::jsonb, 1, 'import_batch', $2, 'import_batch',
                'batch:smoke', 'actor-smoke', 'delegated_import', $3, 'shadow', 1, $3, $3,
                jsonb_build_array(jsonb_build_object(
                  'ordinal', 0,
                  'semanticFingerprint', $4::text,
                  'derivedOperationId', attendance_w4_uuidv5($5::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $4))::text,
                  'commandFingerprint', $3::text))
         RETURNING id::text AS id`,
        [ORG, reservation, '9'.repeat(64), HEX64_A, IMPORT_NS],
      )
    ).rows[0].id
    jobIds.push(v1)

    // A rollout-state value is rejected at the job DB boundary.
    await expect(
      query(
        `INSERT INTO attendance_import_jobs
          (org_id, batch_id, created_by, status, payload, w4_contract_version, w4_entrypoint,
           w4_batch_command_id, w4_source_kind, w4_source_ref, w4_actor_id, w4_actor_posture,
           w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
           w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector)
         VALUES ($1, $2, 'actor-smoke', 'queued', '{}'::jsonb, 1, 'import_batch', $2, 'import_batch',
                 'batch:smoke', 'actor-smoke', 'delegated_import', $3, 'eligible', 1, $3, $3, '[]'::jsonb)`,
        [ORG, uuid(), '8'.repeat(64)],
      ),
    ).rejects.toThrow(/chk_aij_w4/)

    // Frozen accepted posture refuses UPDATE.
    await expect(
      query(`UPDATE attendance_import_jobs SET w4_accepted_write_posture = 'authoritative' WHERE id = $1::uuid`, [v1]),
    ).rejects.toThrow(/W4C0_JOB_FROZEN/)
  })

  it('down() fail-closes before DDL while W4 registry rows exist', async () => {
    // Rows inserted by earlier cases in this file guarantee a populated registry.
    const { rows } = await query<{ n: string }>('SELECT count(*)::text AS n FROM attendance_result_operation_batches')
    expect(Number(rows[0].n)).toBeGreaterThan(0)

    migrationDb = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: dbUrl }) }),
    })
    await expect(down(migrationDb)).rejects.toThrow(/W4C0_DOWN_BLOCKED/)

    // Fail-closed means zero DDL happened: the registries and the SQL function all survive.
    const stillThere = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM information_schema.tables WHERE table_name IN ('attendance_result_operation_batches','attendance_result_operations','attendance_result_event_outbox','attendance_record_calculations','attendance_record_segments','attendance_request_calculation_snapshots','attendance_import_rollback_closures','attendance_calculation_rollout_state','attendance_calculation_rollout_events')",
    )
    expect(Number(stillThere.rows[0].n)).toBe(9)
    const fn = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_proc WHERE proname = 'attendance_w4_uuidv5'",
    )
    expect(Number(fn.rows[0].n)).toBe(1)
  })
})
