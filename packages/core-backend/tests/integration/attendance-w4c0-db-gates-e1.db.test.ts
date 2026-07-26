/**
 * W4C-0 (#4556) Stage E1 — section 12.1 database gates against real Postgres.
 *
 * Families covered here (lock section 12.1, first gate block):
 *  - fresh install / upgrade-with-legacy-rows / replay-safe migration, on a scratch
 *    database created by this file (minimal legacy replicas carry exactly the columns the
 *    migration DDL and triggers reference; behavior legs run on the fully migrated main
 *    test database, never on the replicas);
 *  - down(): empty-surface success with byte-preserved legacy rows and up() revival;
 *    populated pre-DDL fail-closed for NON-registry categories (V1 job row, rollout state
 *    row) — the registry-row category is already proven in the Stage A smoke file;
 *  - immutable-table UPDATE/DELETE/TRUNCATE refusal across the full append-only surface
 *    (snapshots, calculations, segments, rollback closures, rollout events), registry
 *    DELETE/TRUNCATE/cascade refusal, illegal state transitions, completed
 *    response/fingerprint immutability, `paused` state refusal;
 *  - deferred constraints are TRANSACTION-BOUND: an in-transaction claim+seal commits
 *    (fails if the constraint were immediate), an unsealed claim cannot commit, injected
 *    rollback leaves no row, and the batch/segment parent-and-child count guards reject
 *    incomplete AND later-extra children from both trigger sides;
 *  - pointer/owner/visibility gates: cross-org refusal, shadow/review target refusal,
 *    pointer/state mismatch, daily-field drift, authoritative pointer clearing refusal;
 *  - lineage strictly-older/cross-record refusal + uq_arc_operation retry backstop;
 *  - request snapshot A->B->A version appends and mutable-substitution refusal;
 *  - outbox identity/payload immutability and closed delivery transitions;
 *  - P07 job gates: frozen identity/posture/vector fields (including the null->1
 *    promotion refusal), closed execution_reason_code pairing, proof-vector CHECK matrix
 *    (reordered/duplicated/missing/extra/tampered entries, wrong namespace), and the
 *    partial unique reservation backstop driven from two live connections in both commit
 *    orders with no raw 23505 escaping the service layer.
 *
 * Shared-DB discipline: every fixture identity is namespaced per run; append-only rows
 * are deliberately left behind (CI provisions a fresh database per run).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import {
  up,
  down,
} from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import {
  acquireAttendanceCalculationRolloutLock,
  createVerifiedAttendanceOperationIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  resolveSegmentCalculationPosture,
  type AttendanceW4TransactionClientV1,
} from '../../src/attendance/w4c0-identity'
import { createAuthorizedAttendanceWriteContextV1 } from '../../src/attendance/w4c0-authorization'
import { reserveAttendanceImportJobW4V1 } from '../../src/attendance/w4c0-operation-registry'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const RUN = crypto.randomUUID().slice(0, 8)
const HEX64_A = 'a'.repeat(64)
const HEX64_B = 'b'.repeat(64)
const HEX64_C = 'c'.repeat(64)
const IMPORT_NS = '6f67fdaa-e2aa-48b3-b76c-c4aab9723173'
const ENV_KEY = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'

const W4_TABLES = [
  'attendance_result_operation_batches',
  'attendance_result_operations',
  'attendance_result_event_outbox',
  'attendance_request_calculation_snapshots',
  'attendance_record_calculations',
  'attendance_record_segments',
  'attendance_import_rollback_closures',
  'attendance_calculation_rollout_state',
  'attendance_calculation_rollout_events',
] as const

function uuid(): string {
  return crypto.randomUUID()
}

function trx(client: PoolClient): AttendanceW4TransactionClientV1 {
  return {
    query: (sqlText, params) =>
      client.query(sqlText, params as unknown[]) as unknown as Promise<{ rows: Array<Record<string, unknown>> }>,
  }
}

/**
 * Runs statements in their own transaction, ATTEMPTS COMMIT (so deferred constraint
 * triggers fire), and returns the thrown error (undefined when nothing threw).
 */
async function catchInTxn(pool: Pool, fn: (client: PoolClient) => Promise<void>): Promise<unknown> {
  const client = await pool.connect()
  let caught: unknown
  try {
    await client.query('BEGIN')
    try {
      await fn(client)
      await client.query('COMMIT')
    } catch (error) {
      caught = error
      await client.query('ROLLBACK').catch(() => undefined)
    }
  } finally {
    client.release()
  }
  return caught
}

/**
 * Rollback-only variant for TRUNCATE legs: even under a Stage F guard-neuter mutation
 * the shared database is never committed-truncated (the leg still turns red because no
 * error is thrown).
 */
async function catchRolledBack(pool: Pool, fn: (client: PoolClient) => Promise<void>): Promise<unknown> {
  const client = await pool.connect()
  let caught: unknown
  try {
    await client.query('BEGIN')
    try {
      await fn(client)
    } catch (error) {
      caught = error
    }
    await client.query('ROLLBACK').catch(() => undefined)
  } finally {
    client.release()
  }
  return caught
}

async function countTables(pool: Pool): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [W4_TABLES as unknown as string[]],
  )
  return rows[0].n as number
}

describeIfDatabase('W4C-0 Stage E1 — section 12.1 database gates (real DB)', () => {
  const pool = new Pool({ connectionString: dbUrl })
  let mainMigrationDb: Kysely<unknown> | undefined
  let priorEnv: string | undefined

  beforeAll(async () => {
    priorEnv = process.env[ENV_KEY]
    // Replay-with-data leg happens implicitly on every local rerun of this suite: the
    // main database is already migrated AND populated, and up() must still succeed.
    mainMigrationDb = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: dbUrl }) }),
    })
    await up(mainMigrationDb)
  }, 60000)

  afterAll(async () => {
    if (priorEnv === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = priorEnv
    await mainMigrationDb?.destroy()
    await pool.end()
  })

  // -------------------------------------------------------------------------
  // Fixture builders on the MAIN (fully migrated, real-shape) database.
  // -------------------------------------------------------------------------

  async function insertRecord(org: string): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO attendance_records (user_id, work_date, org_id, status, work_minutes, late_minutes, early_leave_minutes)
       VALUES ($1, '2026-03-02', $2, 'normal', 0, 0, 0) RETURNING id::text AS id`,
      [`w4c0e1-user-${uuid()}`, org],
    )
    return rows[0].id as string
  }

  interface CalcSpec {
    id?: string
    org: string
    recordId: string
    version: number
    kind?: 'legacy_baseline' | 'calculation' | 'reversal'
    mode?: 'shadow' | 'authoritative'
    outcome?: string
    reason?: string
    effect?: string
    expected?: number
    supersedes?: string | null
    operationId?: string | null
    projected?: { status: string; work: number; late: number; early: number } | null
    dailyFingerprint?: string | null
    tier?: string
    segments?: number
  }

  /** Inserts one calculation (+ its exact direct segments) in a single transaction. */
  async function insertCalc(client: PoolClient, spec: CalcSpec): Promise<string> {
    const id = spec.id ?? uuid()
    const kind = spec.kind ?? 'calculation'
    const mode = spec.mode ?? 'shadow'
    const outcome = spec.outcome ?? 'completed'
    const reason = spec.reason ?? (mode === 'shadow' ? 'shadow_only' : 'calculated')
    const effect = spec.effect ?? (mode === 'shadow' ? 'none' : 'set_active')
    const expected = spec.expected ?? 1
    const projected = spec.projected === undefined ? { status: 'normal', work: 480, late: 0, early: 0 } : spec.projected
    await client.query(
      `INSERT INTO attendance_record_calculations
         (id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint, engine_version,
          snapshot_schema_version, supersedes_calculation_id, operation_id, semantic_input_fingerprint,
          provenance_fingerprint, source_definition_fingerprint, attribution_snapshot, context_snapshot,
          segment_snapshot, evidence_snapshot, approved_facts_snapshot, input_provenance, merge_policy,
          calculation_tier, outcome, outcome_reason_code, projection_effect, expected_segment_count,
          projected_status, projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
          projected_daily_fingerprint, actor_id, correlation_id)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, 'live', 'w4c0-e1', 1, $7::uuid, $8::uuid, $9, $10, $11,
               '{"posture":"resolved_v2"}'::jsonb, $12::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
               '{"transport":"live_punch"}'::jsonb, 'append', $13, $14, $15, $16, $17,
               $18, $19, $20, $21, $22, 'actor-e1', $23)`,
      [
        id,
        spec.org,
        spec.recordId,
        spec.version,
        kind,
        mode,
        spec.supersedes ?? null,
        spec.operationId === undefined ? (kind === 'legacy_baseline' ? null : uuid()) : spec.operationId,
        HEX64_A,
        HEX64_B,
        outcome === 'review_required' ? null : HEX64_C,
        outcome === 'review_required' ? null : '{"tz":"Asia/Shanghai"}',
        spec.tier ?? (mode === 'shadow' ? 'legacy_shadow' : 'segment_authoritative'),
        outcome,
        reason,
        effect,
        expected,
        projected?.status ?? null,
        projected?.work ?? null,
        projected?.late ?? null,
        projected?.early ?? null,
        spec.dailyFingerprint ?? null,
        `corr-e1-${RUN}`,
      ],
    )
    const segments = spec.segments ?? (kind === 'calculation' && outcome === 'completed' ? expected : 0)
    for (let i = 0; i < segments; i += 1) {
      await client.query(
        `INSERT INTO attendance_record_segments
           (org_id, record_id, calculation_id, segment_index, expected_start_at, expected_end_at,
            work_minutes, late_minutes, early_leave_minutes, status, status_reasons,
            matched_evidence_refs, unmatched_evidence_refs)
         VALUES ($1, $2::uuid, $3::uuid, $4, '2026-03-02T01:00:00Z', '2026-03-02T09:00:00Z',
                 480, 0, 0, 'normal', '["within_window"]'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
        [spec.org, spec.recordId, id, i],
      )
    }
    return id
  }

  async function insertBatchWithItem(org: string): Promise<{ batchId: string; itemId: string }> {
    const batchId = uuid()
    const { rows } = await pool.query(
      'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $3))::text AS v',
      [IMPORT_NS, batchId, HEX64_A],
    )
    const itemId = rows[0].v as string
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO attendance_result_operation_batches
          (org_id, entrypoint, batch_command_id, identity_source_kind, source_root_id, source_ref,
           actor_id, actor_posture, capability, subject_scope, accepted_write_posture,
           command_fingerprint, item_count, item_sequence_fingerprint, item_set_fingerprint, state, response_snapshot)
         VALUES ($1, 'import_batch', $2, 'import_batch', $2, 'batch:e1', 'actor-e1', 'delegated_import',
                 'import', '{}'::jsonb, 'shadow', $3, 1, $3, $3, 'completed', '{"order":[],"byId":{}}'::jsonb)`,
        [org, batchId, HEX64_B],
      )
      await client.query(
        `INSERT INTO attendance_result_operations
          (org_id, entrypoint, operation_id, batch_command_id, input_ordinal, identity_source_kind,
           source_root_id, proof_semantic_fingerprint, source_ref, actor_id, actor_posture, capability,
           subject_scope, command_fingerprint, accepted_write_posture, state,
           normalized_business_input_snapshot, response_snapshot)
         VALUES ($1, 'import_batch', $2, $3, 0, 'import_item', $3, $4, 'item:e1', 'actor-e1',
                 'delegated_import', 'import', '{}'::jsonb, $5, 'shadow', 'completed', '{}'::jsonb, '{"ok":true}'::jsonb)`,
        [org, itemId, batchId, HEX64_A, HEX64_C],
      )
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    return { batchId, itemId }
  }

  // =========================================================================
  // A. Migration lifecycle on a scratch database.
  // =========================================================================

  describe('migration lifecycle (scratch database)', () => {
    const scratchName = `ms2_w4c0_e1_${RUN}`
    let adminPool: Pool
    let scratchPool: Pool
    let scratchKyselyPool: Pool
    let scratchDb: Kysely<unknown>
    // Captured legacy bytes for the upgrade-preservation assertion.
    let legacyJobsBefore: string[] = []
    let legacyRecordBefore = ''

    beforeAll(async () => {
      const adminUrl = new URL(dbUrl as string)
      adminUrl.pathname = '/postgres'
      adminPool = new Pool({ connectionString: adminUrl.toString() })
      await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
      await adminPool.query(`CREATE DATABASE ${scratchName}`)
      const scratchUrl = new URL(dbUrl as string)
      scratchUrl.pathname = `/${scratchName}`
      scratchPool = new Pool({ connectionString: scratchUrl.toString() })
      scratchKyselyPool = new Pool({ connectionString: scratchUrl.toString() })
      scratchDb = new Kysely<unknown>({
        dialect: new PostgresDialect({ pool: scratchKyselyPool }),
      })
      // Minimal legacy replicas: exactly the columns the migration DDL (ALTER/FK/unique)
      // and its triggers reference. The behavior matrix runs against the REAL schema on
      // the main database; these replicas exist only to drive the DDL lifecycle.
      await scratchPool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
      await scratchPool.query(`
        CREATE TABLE attendance_records (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id text NOT NULL,
          work_date date NOT NULL,
          first_in_at timestamptz,
          last_out_at timestamptz,
          work_minutes integer NOT NULL DEFAULT 0,
          late_minutes integer NOT NULL DEFAULT 0,
          early_leave_minutes integer NOT NULL DEFAULT 0,
          status varchar(64) NOT NULL DEFAULT 'normal',
          org_id text NOT NULL DEFAULT 'default'
        )`)
      await scratchPool.query(`
        CREATE TABLE attendance_requests (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id text NOT NULL,
          work_date date NOT NULL,
          request_type varchar(30) NOT NULL,
          status varchar(20) NOT NULL DEFAULT 'pending',
          org_id text NOT NULL DEFAULT 'default'
        )`)
      await scratchPool.query(`
        CREATE TABLE attendance_import_jobs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id text NOT NULL DEFAULT 'default',
          batch_id uuid NOT NULL,
          created_by text NOT NULL,
          idempotency_key text,
          status varchar(20) NOT NULL DEFAULT 'queued',
          progress integer NOT NULL DEFAULT 0,
          total integer NOT NULL DEFAULT 0,
          payload jsonb NOT NULL DEFAULT '{}'::jsonb
        )`)
      // Pre-migration legacy rows: the migration must preserve every byte and leave the
      // whole W4 job shape null (upgrade fixture gate).
      for (const status of ['queued', 'running', 'completed']) {
        await scratchPool.query(
          `INSERT INTO attendance_import_jobs (org_id, batch_id, created_by, status, progress, total, payload)
           VALUES ('default', $1::uuid, 'legacy-actor', $2, 3, 10, $3::jsonb)`,
          [uuid(), status, JSON.stringify({ legacy: true, status, marker: RUN })],
        )
      }
      await scratchPool.query(
        `INSERT INTO attendance_records (user_id, work_date, status, work_minutes) VALUES ('legacy-user', '2026-01-05', 'late', 300)`,
      )
      const jobs = await scratchPool.query('SELECT to_jsonb(t)::text AS r FROM attendance_import_jobs t ORDER BY id')
      legacyJobsBefore = jobs.rows.map((row: { r: string }) => row.r)
      legacyRecordBefore = (
        await scratchPool.query('SELECT to_jsonb(t)::text AS r FROM attendance_records t')
      ).rows[0].r
    }, 60000)

    afterAll(async () => {
      // Teardown-scoped FATAL absorber (CI flake root-caused on PR #4607): pool.end()
      // resolves when the client-side sockets close, but a backend whose server-side
      // teardown races that close is then killed by WITH (FORCE) and emits an async
      // 57P01 FATAL on the already-"ended" pool — vitest counts that unhandled 'error'
      // event and exits 1 with all tests green. Handlers are attached ONLY here, at
      // teardown start, so a FATAL during the tests themselves still fails loudly.
      for (const p of [scratchPool, scratchKyselyPool, adminPool]) p?.on('error', () => undefined)
      await scratchDb?.destroy()
      await scratchPool?.end()
      await adminPool?.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).catch(() => undefined)
      await adminPool?.end()
    })

    it('fresh + upgrade: up() over pre-existing legacy rows creates the full W4 surface, preserves legacy bytes, nulls the W4 job shape; up() replay is idempotent', async () => {
      await up(scratchDb)
      expect(await countTables(scratchPool)).toBe(9)
      const view = await scratchPool.query(
        "SELECT count(*)::int AS n FROM information_schema.views WHERE table_name = 'attendance_current_records'",
      )
      expect(view.rows[0].n).toBe(1)
      const fns = await scratchPool.query(
        "SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'attendance\\_w4\\_%'",
      )
      expect(fns.rows[0].n).toBeGreaterThanOrEqual(18)

      // Upgrade preservation: legacy job/record bytes unchanged; entire W4 shape null.
      const jobsAfter = await scratchPool.query(
        `SELECT to_jsonb(t) - ARRAY['w4_contract_version','w4_entrypoint','w4_batch_command_id','w4_source_kind',
                'w4_source_ref','w4_actor_id','w4_actor_posture','w4_token_subject_user_id','w4_command_fingerprint',
                'w4_accepted_write_posture','w4_item_count','w4_item_sequence_fingerprint','w4_item_set_fingerprint',
                'w4_identity_proof_vector','w4_execution_reason_code'] AS legacy,
                (w4_contract_version IS NULL AND w4_entrypoint IS NULL AND w4_batch_command_id IS NULL AND
                 w4_source_kind IS NULL AND w4_source_ref IS NULL AND w4_actor_id IS NULL AND
                 w4_actor_posture IS NULL AND w4_token_subject_user_id IS NULL AND w4_command_fingerprint IS NULL AND
                 w4_accepted_write_posture IS NULL AND w4_item_count IS NULL AND w4_item_sequence_fingerprint IS NULL AND
                 w4_item_set_fingerprint IS NULL AND w4_identity_proof_vector IS NULL AND
                 w4_execution_reason_code IS NULL) AS w4_null
           FROM attendance_import_jobs t ORDER BY id`,
      )
      expect(jobsAfter.rows.map((row: { legacy: unknown }) => JSON.stringify(row.legacy))).toEqual(
        legacyJobsBefore.map((r) => JSON.stringify(JSON.parse(r))),
      )
      expect(jobsAfter.rows.every((row: { w4_null: boolean }) => row.w4_null)).toBe(true)
      const recordAfter = await scratchPool.query(
        `SELECT to_jsonb(t) - ARRAY['current_calculation_id','projection_owner','visibility_state','visibility_reason'] AS legacy,
                current_calculation_id IS NULL AND projection_owner = 'legacy_untracked'
                  AND visibility_state = 'active' AND visibility_reason = 'active' AS w4_default
           FROM attendance_records t`,
      )
      expect(JSON.stringify(recordAfter.rows[0].legacy)).toBe(JSON.stringify(JSON.parse(legacyRecordBefore)))
      expect(recordAfter.rows[0].w4_default).toBe(true)

      // Replay: a second up() succeeds and changes nothing structural.
      await up(scratchDb)
      expect(await countTables(scratchPool)).toBe(9)
    }, 60000)

    it('down() on empty W4 surfaces succeeds pre-DDL guard, removes the whole surface, preserves legacy bytes; up() revives', async () => {
      await down(scratchDb)
      expect(await countTables(scratchPool)).toBe(0)
      const fns = await scratchPool.query(
        "SELECT count(*)::int AS n FROM pg_proc WHERE proname LIKE 'attendance\\_w4\\_%'",
      )
      expect(fns.rows[0].n).toBe(0)
      const jobCols = await scratchPool.query(
        "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'attendance_import_jobs' AND column_name LIKE 'w4\\_%'",
      )
      expect(jobCols.rows[0].n).toBe(0)
      const recCols = await scratchPool.query(
        "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'attendance_records' AND column_name IN ('current_calculation_id','projection_owner','visibility_state','visibility_reason')",
      )
      expect(recCols.rows[0].n).toBe(0)
      // Legacy rows survive down() byte-for-byte.
      const jobs = await scratchPool.query('SELECT to_jsonb(t)::text AS r FROM attendance_import_jobs t ORDER BY id')
      expect(jobs.rows.map((row: { r: string }) => JSON.stringify(JSON.parse(row.r)))).toEqual(
        legacyJobsBefore.map((r) => JSON.stringify(JSON.parse(r))),
      )
      // Revive.
      await up(scratchDb)
      expect(await countTables(scratchPool)).toBe(9)
    }, 60000)

    it('down() fail-closes pre-DDL for the V1-job and rollout-state categories (zero DDL happens)', async () => {
      // Category: attendance_import_jobs W4 V1 rows.
      const batch = uuid()
      const { rows } = await scratchPool.query(
        `INSERT INTO attendance_import_jobs
           (org_id, batch_id, created_by, status, payload, w4_contract_version, w4_entrypoint,
            w4_batch_command_id, w4_source_kind, w4_source_ref, w4_actor_id, w4_actor_posture,
            w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
            w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector)
         SELECT $1, $2::uuid, 'actor-e1', 'queued', '{}'::jsonb, 1, 'import_batch', $2::uuid, 'import_batch',
                'batch:e1', 'actor-e1', 'delegated_import', $3, 'shadow', 1, $3, $3,
                jsonb_build_array(jsonb_build_object(
                  'ordinal', 0, 'semanticFingerprint', $4::text,
                  'derivedOperationId', attendance_w4_uuidv5($5::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $4))::text,
                  'commandFingerprint', $3::text))
         RETURNING id::text AS id`,
        [uuid(), batch, HEX64_B, HEX64_A, IMPORT_NS],
      )
      await expect(down(scratchDb)).rejects.toThrow(/W4C0_DOWN_BLOCKED.*attendance_import_jobs W4 V1 rows/s)
      expect(await countTables(scratchPool)).toBe(9) // zero DDL happened
      await scratchPool.query('DELETE FROM attendance_import_jobs WHERE id = $1::uuid', [rows[0].id])

      // Category: rollout state row (append-only guarded — left in place; the scratch
      // database is dropped wholesale in afterAll).
      await scratchPool.query(
        `INSERT INTO attendance_calculation_rollout_state
           (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
         VALUES ($1, 'legacy', 'w4c0-e1', 'TEST_FIXTURE', 'actor-e1', 1, NULL)`,
        [uuid()],
      )
      await expect(down(scratchDb)).rejects.toThrow(/W4C0_DOWN_BLOCKED.*attendance_calculation_rollout_state/s)
      expect(await countTables(scratchPool)).toBe(9)
    }, 60000)
  })

  // =========================================================================
  // B. Immutability refusal surface (main database, real shapes).
  // =========================================================================

  it('append-only tables refuse UPDATE/DELETE/TRUNCATE (snapshots, calculations, segments, closures, rollout events)', async () => {
    const org = uuid()
    // Fixtures.
    const requestId = (
      await pool.query(
        `INSERT INTO attendance_requests (user_id, work_date, request_type, org_id)
         VALUES ($1, '2026-03-02', 'leave', $2) RETURNING id::text AS id`,
        [`w4c0e1-req-user-${RUN}`, org],
      )
    ).rows[0].id as string
    await pool.query(
      `INSERT INTO attendance_request_calculation_snapshots
         (org_id, request_id, version, request_type, subject_user_id, payload, payload_fingerprint,
          attribution_snapshot, created_by)
       VALUES ($1, $2::uuid, 1, 'leave', 'subject-e1', '{"v":1}'::jsonb, $3, '{}'::jsonb, 'actor-e1')`,
      [org, requestId, HEX64_A],
    )
    const recordId = await insertRecord(org)
    let calcId = ''
    {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        calcId = await insertCalc(client, { org, recordId, version: 1 })
        await client.query('COMMIT')
      } finally {
        client.release()
      }
    }
    await pool.query(
      `INSERT INTO attendance_import_rollback_closures
         (org_id, batch_id, batch_fingerprint, actor_id, actor_authorization_posture, reason_code, correlation_id)
       VALUES ($1, $2::uuid, $3, 'actor-e1', 'operator', 'TEST_FIXTURE', $4)`,
      [org, uuid(), HEX64_A, `corr-${RUN}`],
    )
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_events
         (org_id, prior_state, new_state, reason_code, engine_version, actor_id)
       VALUES ($1, NULL, 'legacy', 'TEST_FIXTURE', 'w4c0-e1', 'actor-e1')`,
      [org],
    )

    const legs: Array<{ label: string; sql: string; params?: unknown[] }> = [
      { label: 'snapshot UPDATE', sql: `UPDATE attendance_request_calculation_snapshots SET payload = '{"v":2}'::jsonb WHERE org_id = $1`, params: [org] },
      { label: 'snapshot DELETE', sql: 'DELETE FROM attendance_request_calculation_snapshots WHERE org_id = $1', params: [org] },
      { label: 'snapshot TRUNCATE', sql: 'TRUNCATE attendance_request_calculation_snapshots' },
      { label: 'calculation UPDATE', sql: `UPDATE attendance_record_calculations SET outcome_reason_code = 'calculated' WHERE id = $1::uuid`, params: [calcId] },
      { label: 'calculation DELETE', sql: 'DELETE FROM attendance_record_calculations WHERE id = $1::uuid', params: [calcId] },
      { label: 'calculation TRUNCATE CASCADE', sql: 'TRUNCATE attendance_record_calculations CASCADE' },
      { label: 'segment UPDATE', sql: 'UPDATE attendance_record_segments SET work_minutes = 1 WHERE calculation_id = $1::uuid', params: [calcId] },
      { label: 'segment DELETE', sql: 'DELETE FROM attendance_record_segments WHERE calculation_id = $1::uuid', params: [calcId] },
      { label: 'segment TRUNCATE', sql: 'TRUNCATE attendance_record_segments' },
      { label: 'closure UPDATE', sql: `UPDATE attendance_import_rollback_closures SET reason_code = 'X' WHERE org_id = $1`, params: [org] },
      { label: 'closure DELETE', sql: 'DELETE FROM attendance_import_rollback_closures WHERE org_id = $1', params: [org] },
      { label: 'closure TRUNCATE', sql: 'TRUNCATE attendance_import_rollback_closures' },
      { label: 'rollout event UPDATE', sql: `UPDATE attendance_calculation_rollout_events SET reason_code = 'X' WHERE org_id = $1`, params: [org] },
      { label: 'rollout event DELETE', sql: 'DELETE FROM attendance_calculation_rollout_events WHERE org_id = $1', params: [org] },
      { label: 'rollout event TRUNCATE', sql: 'TRUNCATE attendance_calculation_rollout_events' },
    ]
    for (const leg of legs) {
      const runner = leg.sql.startsWith('TRUNCATE') ? catchRolledBack : catchInTxn
      const caught = await runner(pool, async (client) => {
        await client.query(leg.sql, (leg.params ?? []) as unknown[])
      })
      expect(String((caught as Error | undefined)?.message ?? `NO ERROR for ${leg.label}`)).toMatch(/W4C0_IMMUTABLE/)
    }
  })

  it('registries refuse DELETE/TRUNCATE/cascade, paused state, illegal transitions; completed rows are fully immutable', async () => {
    const org = uuid()
    const { batchId, itemId } = await insertBatchWithItem(org)

    // paused state refused on both registries (closed CHECK).
    for (const leg of [
      {
        sql: `INSERT INTO attendance_result_operations
                (org_id, entrypoint, operation_id, identity_source_kind, source_ref, actor_id, actor_posture,
                 capability, subject_scope, command_fingerprint, accepted_write_posture, state)
              VALUES ($1, 'live_punch', $2, 'direct_live_punch', 'live:e1', 'actor-e1', 'self',
                      'punch', '{}'::jsonb, $3, 'shadow', 'paused')`,
        params: [org, uuid(), HEX64_A],
        pattern: /chk_aro_state/,
      },
      {
        sql: `INSERT INTO attendance_result_operation_batches
                (org_id, entrypoint, batch_command_id, identity_source_kind, source_root_id, source_ref,
                 actor_id, actor_posture, capability, subject_scope, accepted_write_posture,
                 command_fingerprint, item_count, item_sequence_fingerprint, item_set_fingerprint, state)
              VALUES ($1, 'import_batch', $2, 'import_batch', $2, 'b:e1', 'actor-e1', 'delegated_import',
                      'import', '{}'::jsonb, 'shadow', $3, 1, $3, $3, 'paused')`,
        params: [org, uuid(), HEX64_A],
        pattern: /chk_arob_state/,
      },
    ] as const) {
      const caught = await catchInTxn(pool, async (client) => {
        await client.query(leg.sql, leg.params as unknown[])
      })
      expect(String((caught as Error).message)).toMatch(leg.pattern)
    }

    // Completed rows: response/fingerprint mutation, terminal transition, and identity
    // mutations all refused; DELETE/TRUNCATE(+cascade) refused.
    const refusals: Array<{ sql: string; params: unknown[]; pattern: RegExp }> = [
      {
        sql: `UPDATE attendance_result_operations SET response_snapshot = '{"ok":false}'::jsonb WHERE org_id = $1 AND operation_id = $2::uuid`,
        params: [org, itemId],
        pattern: /W4C0_OPERATION_STATE/,
      },
      {
        sql: `UPDATE attendance_result_operations SET state = 'claimed' WHERE org_id = $1 AND operation_id = $2::uuid`,
        params: [org, itemId],
        pattern: /W4C0_OPERATION_STATE/,
      },
      {
        sql: `UPDATE attendance_result_operations SET command_fingerprint = $3 WHERE org_id = $1 AND operation_id = $2::uuid`,
        params: [org, itemId, HEX64_B],
        pattern: /W4C0_OPERATION_STATE/,
      },
      {
        sql: `UPDATE attendance_result_operation_batches SET item_sequence_fingerprint = $3 WHERE org_id = $1 AND batch_command_id = $2::uuid`,
        params: [org, batchId, HEX64_C],
        pattern: /W4C0_OPERATION_STATE/,
      },
      {
        sql: `UPDATE attendance_result_operation_batches SET state = 'canceled' WHERE org_id = $1 AND batch_command_id = $2::uuid`,
        params: [org, batchId],
        pattern: /W4C0_OPERATION_STATE/,
      },
      {
        sql: 'DELETE FROM attendance_result_operations WHERE org_id = $1 AND operation_id = $2::uuid',
        params: [org, itemId],
        pattern: /W4C0_IMMUTABLE/,
      },
      {
        sql: 'DELETE FROM attendance_result_operation_batches WHERE org_id = $1 AND batch_command_id = $2::uuid',
        params: [org, batchId],
        pattern: /W4C0_IMMUTABLE/,
      },
      { sql: 'TRUNCATE attendance_result_operations', params: [], pattern: /W4C0_IMMUTABLE/ },
      { sql: 'TRUNCATE attendance_result_operation_batches CASCADE', params: [], pattern: /W4C0_IMMUTABLE/ },
    ]
    for (const leg of refusals) {
      const runner = leg.sql.startsWith('TRUNCATE') ? catchRolledBack : catchInTxn
      const caught = await runner(pool, async (client) => {
        await client.query(leg.sql, leg.params)
      })
      expect(String((caught as Error | undefined)?.message ?? 'NO ERROR')).toMatch(leg.pattern)
    }
  })

  it('rollout state machine: legal transition succeeds; illegal edge/prior/version/identity/initial-state/DELETE/TRUNCATE all refused', async () => {
    const org = uuid()
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1, 'legacy', 'w4c0-e1', 'TEST_FIXTURE', 'actor-e1', 1, NULL)`,
      [org],
    )
    // Positive control: the one legal edge from legacy.
    await pool.query(
      `UPDATE attendance_calculation_rollout_state
         SET state = 'shadow', prior_state = 'legacy', version = 2 WHERE org_id = $1`,
      [org],
    )

    const refusals: Array<{ sql: string; params: unknown[]; pattern: RegExp }> = [
      {
        // shadow -> authoritative is NOT a legal edge.
        sql: `UPDATE attendance_calculation_rollout_state SET state = 'authoritative', prior_state = 'shadow', version = 3 WHERE org_id = $1`,
        params: [org],
        pattern: /illegal rollout state transition/,
      },
      {
        // Legal edge but prior_state does not record the previous state.
        sql: `UPDATE attendance_calculation_rollout_state SET state = 'eligible', prior_state = 'legacy', version = 3 WHERE org_id = $1`,
        params: [org],
        pattern: /prior_state must record/,
      },
      {
        // Legal edge but version does not increment.
        sql: `UPDATE attendance_calculation_rollout_state SET state = 'eligible', prior_state = 'shadow', version = 5 WHERE org_id = $1`,
        params: [org],
        pattern: /version must increment/,
      },
      {
        sql: `UPDATE attendance_calculation_rollout_state SET org_id = $2, state = 'eligible', prior_state = 'shadow', version = 3 WHERE org_id = $1`,
        params: [org, uuid()],
        pattern: /immutable/,
      },
      {
        sql: `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
              VALUES ($1, 'eligible', 'w4c0-e1', 'TEST_FIXTURE', 'actor-e1', 1, NULL)`,
        params: [uuid()],
        pattern: /illegal initial rollout state/,
      },
      {
        sql: `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
              VALUES ($1, 'legacy', 'w4c0-e1', 'TEST_FIXTURE', 'actor-e1', 2, NULL)`,
        params: [uuid()],
        pattern: /initial rollout version/,
      },
      {
        sql: 'DELETE FROM attendance_calculation_rollout_state WHERE org_id = $1',
        params: [org],
        pattern: /W4C0_IMMUTABLE/,
      },
      { sql: 'TRUNCATE attendance_calculation_rollout_state', params: [], pattern: /W4C0_IMMUTABLE/ },
    ]
    for (const leg of refusals) {
      const runner = leg.sql.startsWith('TRUNCATE') ? catchRolledBack : catchInTxn
      const caught = await runner(pool, async (client) => {
        await client.query(leg.sql, leg.params)
      })
      expect(String((caught as Error | undefined)?.message ?? 'NO ERROR')).toMatch(leg.pattern)
    }
  })

  // =========================================================================
  // C. Deferred constraints are transaction-bound.
  // =========================================================================

  it('deferred claimed-commit guards are transaction-bound: in-txn claim+seal commits; unsealed claim/batch cannot; injected rollback leaves no row; source-free cancel persists', async () => {
    const org = uuid()

    // (i) Transaction-bound leg: claim then seal INSIDE one transaction commits.
    // If either deferred trigger were immediate, the claimed INSERT itself would abort.
    const okId = uuid()
    {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO attendance_result_operations
             (org_id, entrypoint, operation_id, identity_source_kind, source_ref, actor_id, actor_posture,
              capability, subject_scope, command_fingerprint, accepted_write_posture, state)
           VALUES ($1, 'live_punch', $2, 'direct_live_punch', 'live:e1', 'actor-e1', 'self',
                   'punch', '{}'::jsonb, $3, 'shadow', 'claimed')`,
          [org, okId, HEX64_A],
        )
        await client.query(
          `UPDATE attendance_result_operations SET state = 'completed', response_snapshot = '{"ok":true}'::jsonb
           WHERE org_id = $1 AND operation_id = $2::uuid`,
          [org, okId],
        )
        await client.query('COMMIT')
      } finally {
        client.release()
      }
    }
    const sealed = await pool.query(
      'SELECT state FROM attendance_result_operations WHERE org_id = $1 AND operation_id = $2::uuid',
      [org, okId],
    )
    expect(sealed.rows).toEqual([{ state: 'completed' }])

    // (ii) Unsealed claimed operation cannot commit; unsealed claimed batch cannot commit.
    const opCaught = await catchInTxn(pool, async (client) => {
      await client.query(
        `INSERT INTO attendance_result_operations
           (org_id, entrypoint, operation_id, identity_source_kind, source_ref, actor_id, actor_posture,
            capability, subject_scope, command_fingerprint, accepted_write_posture, state)
         VALUES ($1, 'live_punch', $2, 'direct_live_punch', 'live:e1', 'actor-e1', 'self',
                 'punch', '{}'::jsonb, $3, 'shadow', 'claimed')`,
        [org, uuid(), HEX64_A],
      )
    })
    expect(String((opCaught as Error).message)).toMatch(/W4C0_CLAIMED_COMMIT/)
    const batchCaught = await catchInTxn(pool, async (client) => {
      await client.query(
        `INSERT INTO attendance_result_operation_batches
           (org_id, entrypoint, batch_command_id, identity_source_kind, source_root_id, source_ref,
            actor_id, actor_posture, capability, subject_scope, accepted_write_posture,
            command_fingerprint, item_count, item_sequence_fingerprint, item_set_fingerprint, state)
         VALUES ($1, 'import_batch', $2, 'import_batch', $2, 'b:e1', 'actor-e1', 'delegated_import',
                 'import', '{}'::jsonb, 'shadow', $3, 1, $3, $3, 'claimed')`,
        [org, uuid(), HEX64_A],
      )
    })
    expect(String((batchCaught as Error).message)).toMatch(/W4C0_CLAIMED_COMMIT/)

    // (iii) Injected rollback leaves no new operation row.
    const rollbackId = uuid()
    {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO attendance_result_operations
             (org_id, entrypoint, operation_id, identity_source_kind, source_ref, actor_id, actor_posture,
              capability, subject_scope, command_fingerprint, accepted_write_posture, state)
           VALUES ($1, 'live_punch', $2, 'direct_live_punch', 'live:e1', 'actor-e1', 'self',
                   'punch', '{}'::jsonb, $3, 'shadow', 'claimed')`,
          [org, rollbackId, HEX64_A],
        )
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    }
    const gone = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_result_operations WHERE org_id = $1 AND operation_id = $2::uuid',
      [org, rollbackId],
    )
    expect(gone.rows[0].n).toBe(0)

    // (iv) Source-free cancel persists through the deferred guard (raw-SQL leg).
    const cancelId = uuid()
    {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO attendance_result_operations
             (org_id, entrypoint, operation_id, identity_source_kind, source_ref, actor_id, actor_posture,
              capability, subject_scope, command_fingerprint, accepted_write_posture, state)
           VALUES ($1, 'live_punch', $2, 'direct_live_punch', 'live:e1', 'actor-e1', 'self',
                   'punch', '{}'::jsonb, $3, 'shadow', 'claimed')`,
          [org, cancelId, HEX64_A],
        )
        await client.query(
          `UPDATE attendance_result_operations SET state = 'canceled' WHERE org_id = $1 AND operation_id = $2::uuid`,
          [org, cancelId],
        )
        await client.query('COMMIT')
      } finally {
        client.release()
      }
    }
    const canceled = await pool.query(
      'SELECT state, response_snapshot FROM attendance_result_operations WHERE org_id = $1 AND operation_id = $2::uuid',
      [org, cancelId],
    )
    expect(canceled.rows).toEqual([{ state: 'canceled', response_snapshot: null }])
  })

  it('completed-batch item-count guard rejects incomplete AND extra children at commit, from both trigger sides', async () => {
    const org = uuid()

    // Incomplete: completed batch declaring 2 items with only 1 attached.
    const shortCaught = await catchInTxn(pool, async (client) => {
      const batchId = uuid()
      const derived = (
        await client.query(
          'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $3))::text AS v',
          [IMPORT_NS, batchId, HEX64_A],
        )
      ).rows[0].v
      await client.query(
        `INSERT INTO attendance_result_operation_batches
           (org_id, entrypoint, batch_command_id, identity_source_kind, source_root_id, source_ref,
            actor_id, actor_posture, capability, subject_scope, accepted_write_posture,
            command_fingerprint, item_count, item_sequence_fingerprint, item_set_fingerprint, state, response_snapshot)
         VALUES ($1, 'import_batch', $2, 'import_batch', $2, 'b:e1', 'actor-e1', 'delegated_import',
                 'import', '{}'::jsonb, 'shadow', $3, 2, $3, $3, 'completed', '{"order":[],"byId":{}}'::jsonb)`,
        [org, batchId, HEX64_B],
      )
      await client.query(
        `INSERT INTO attendance_result_operations
           (org_id, entrypoint, operation_id, batch_command_id, input_ordinal, identity_source_kind,
            source_root_id, proof_semantic_fingerprint, source_ref, actor_id, actor_posture, capability,
            subject_scope, command_fingerprint, accepted_write_posture, state,
            normalized_business_input_snapshot, response_snapshot)
         VALUES ($1, 'import_batch', $2, $3, 0, 'import_item', $3, $4, 'i:e1', 'actor-e1',
                 'delegated_import', 'import', '{}'::jsonb, $5, 'shadow', 'completed', '{}'::jsonb, '{"ok":true}'::jsonb)`,
        [org, derived, batchId, HEX64_A, HEX64_C],
      )
    })
    expect(String((shortCaught as Error).message)).toMatch(/W4C0_BATCH_ITEMS/)

    // Complete (positive) then a LATER extra item against the already-committed
    // completed batch: only the item-side deferred guard can see this — it must fail
    // at the second transaction's commit.
    const { batchId } = await insertBatchWithItem(org)
    const extraCaught = await catchInTxn(pool, async (client) => {
      const derived = (
        await client.query(
          'SELECT attendance_w4_uuidv5($1::uuid, attendance_w4_item_name_bytes($2::uuid, 1, $3))::text AS v',
          [IMPORT_NS, batchId, HEX64_B],
        )
      ).rows[0].v
      await client.query(
        `INSERT INTO attendance_result_operations
           (org_id, entrypoint, operation_id, batch_command_id, input_ordinal, identity_source_kind,
            source_root_id, proof_semantic_fingerprint, source_ref, actor_id, actor_posture, capability,
            subject_scope, command_fingerprint, accepted_write_posture, state,
            normalized_business_input_snapshot, response_snapshot)
         VALUES ($1, 'import_batch', $2, $3, 1, 'import_item', $3, $4, 'i:e1', 'actor-e1',
                 'delegated_import', 'import', '{}'::jsonb, $5, 'shadow', 'completed', '{}'::jsonb, '{"ok":true}'::jsonb)`,
        [org, derived, batchId, HEX64_B, HEX64_C],
      )
    })
    expect(String((extraCaught as Error).message)).toMatch(/W4C0_BATCH_ITEMS/)
    const stillOne = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_result_operations WHERE org_id = $1 AND batch_command_id = $2::uuid',
      [org, batchId],
    )
    expect(stillOne.rows[0].n).toBe(1)
  })

  it('two-sided segment count guard: completed calc requires exact children; later extra segment fails its own commit; review rows require zero children', async () => {
    const org = uuid()
    const recordId = await insertRecord(org)

    // Incomplete: expected 2, only 1 child at commit (calc-side deferred trigger).
    const shortCaught = await catchInTxn(pool, async (client) => {
      await insertCalc(client, { org, recordId, version: 1, expected: 2, segments: 1 })
    })
    expect(String((shortCaught as Error).message)).toMatch(/W4C0_SEGMENT_COUNT/)

    // Positive: expected 2, 2 children.
    let calcId = ''
    {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        calcId = await insertCalc(client, { org, recordId, version: 1, expected: 2, segments: 2 })
        await client.query('COMMIT')
      } finally {
        client.release()
      }
    }

    // Later extra segment in a NEW transaction: only the segment-side trigger can
    // catch this — it must fail at ITS commit.
    const extraCaught = await catchInTxn(pool, async (client) => {
      await client.query(
        `INSERT INTO attendance_record_segments
           (org_id, record_id, calculation_id, segment_index, expected_start_at, expected_end_at,
            work_minutes, late_minutes, early_leave_minutes, status, status_reasons,
            matched_evidence_refs, unmatched_evidence_refs)
         VALUES ($1, $2::uuid, $3::uuid, 2, '2026-03-02T10:00:00Z', '2026-03-02T12:00:00Z',
                 120, 0, 0, 'normal', '["within_window"]'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
        [org, recordId, calcId],
      )
    })
    expect(String((extraCaught as Error).message)).toMatch(/W4C0_SEGMENT_COUNT/)

    // Review row must carry zero children.
    const reviewCaught = await catchInTxn(pool, async (client) => {
      await insertCalc(client, {
        org,
        recordId,
        version: 2,
        outcome: 'review_required',
        reason: 'ambiguous_segment_match',
        effect: 'none',
        expected: 0,
        projected: null,
        segments: 1,
      })
    })
    expect(String((reviewCaught as Error).message)).toMatch(/W4C0_SEGMENT_COUNT/)
  })

  it('failure after calculation insert leaves no child/pointer/projection', async () => {
    const org = uuid()
    const recordId = await insertRecord(org)
    const caught = await catchInTxn(pool, async (client) => {
      await insertCalc(client, { org, recordId, version: 1 })
      // Injected failure AFTER the calculation+segment insert.
      await client.query('SELECT 1/0')
    })
    expect(String((caught as Error).message)).toMatch(/division by zero/)
    const calcs = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_record_calculations WHERE org_id = $1',
      [org],
    )
    const segs = await pool.query('SELECT count(*)::int AS n FROM attendance_record_segments WHERE org_id = $1', [org])
    const pointer = await pool.query(
      'SELECT current_calculation_id, projection_owner FROM attendance_records WHERE id = $1::uuid',
      [recordId],
    )
    expect(calcs.rows[0].n).toBe(0)
    expect(segs.rows[0].n).toBe(0)
    expect(pointer.rows).toEqual([{ current_calculation_id: null, projection_owner: 'legacy_untracked' }])
  })

  // =========================================================================
  // D. Pointer / owner / visibility / lineage.
  // =========================================================================

  it('pointer gates: authoritative set_active positive; drift/mismatch/shadow-review targets/cross-org/clearing all refused; set_retired reason matching', async () => {
    const org = uuid()
    const otherOrg = uuid()
    const recordId = await insertRecord(org)
    const otherRecordId = await insertRecord(otherOrg)

    let authoritativeId = ''
    let shadowId = ''
    let reviewId = ''
    let reversalId = ''
    {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        authoritativeId = await insertCalc(client, {
          org,
          recordId,
          version: 1,
          mode: 'authoritative',
          outcome: 'completed',
          reason: 'calculated',
          effect: 'set_active',
          expected: 1,
          segments: 1,
        })
        shadowId = await insertCalc(client, { org, recordId, version: 2 })
        reviewId = await insertCalc(client, {
          org,
          recordId,
          version: 3,
          mode: 'authoritative',
          outcome: 'review_required',
          reason: 'ambiguous_segment_match',
          effect: 'none',
          expected: 0,
          projected: null,
          segments: 0,
        })
        reversalId = await insertCalc(client, {
          org,
          recordId,
          version: 4,
          kind: 'reversal',
          mode: 'authoritative',
          outcome: 'reversed',
          reason: 'import_rollback_reversal',
          effect: 'set_retired',
          expected: 0,
          supersedes: authoritativeId,
          // The reversal snapshot carries the daily projection the parent must keep
          // showing while retired — the pointer guard compares these fields too.
          projected: { status: 'normal', work: 480, late: 0, early: 0 },
          segments: 0,
        })
        await client.query('COMMIT')
      } finally {
        client.release()
      }
    }

    // Positive: pointer to the authoritative set_active row with EXACT snapshot fields.
    await pool.query(
      `UPDATE attendance_records
          SET current_calculation_id = $2::uuid, projection_owner = 'w4',
              status = 'normal', first_in_at = NULL, last_out_at = NULL,
              work_minutes = 480, late_minutes = 0, early_leave_minutes = 0
        WHERE id = $1::uuid`,
      [recordId, authoritativeId],
    )

    const refusals: Array<{ label: string; sql: string; params: unknown[]; pattern: RegExp }> = [
      {
        label: 'daily-field drift',
        sql: `UPDATE attendance_records SET work_minutes = 481 WHERE id = $1::uuid`,
        params: [recordId],
        pattern: /W4C0_POINTER.*drifted/,
      },
      {
        label: 'visibility mismatch under set_active',
        sql: `UPDATE attendance_records SET visibility_state = 'retired', visibility_reason = 'import_rollback' WHERE id = $1::uuid`,
        params: [recordId],
        pattern: /W4C0_POINTER.*set_active/,
      },
      {
        label: 'shadow pointer target',
        sql: `UPDATE attendance_records SET current_calculation_id = $2::uuid WHERE id = $1::uuid`,
        params: [recordId, shadowId],
        pattern: /W4C0_POINTER.*authoritative completed\/reversed/,
      },
      {
        label: 'review pointer target',
        sql: `UPDATE attendance_records SET current_calculation_id = $2::uuid WHERE id = $1::uuid`,
        params: [recordId, reviewId],
        pattern: /W4C0_POINTER.*authoritative completed\/reversed/,
      },
      {
        label: 'cross-org pointer',
        sql: `UPDATE attendance_records
                 SET current_calculation_id = $2::uuid, projection_owner = 'w4',
                     status = 'normal', work_minutes = 480, late_minutes = 0, early_leave_minutes = 0
               WHERE id = $1::uuid`,
        params: [otherRecordId, authoritativeId],
        pattern: /fk_ar_current_calculation|foreign key/,
      },
      {
        label: 'authoritative pointer clearing',
        sql: `UPDATE attendance_records SET current_calculation_id = NULL, projection_owner = 'legacy_untracked' WHERE id = $1::uuid`,
        params: [recordId],
        pattern: /W4C0_POINTER.*legacy_untracked/,
      },
      {
        label: 'set_retired with wrong visibility reason',
        sql: `UPDATE attendance_records
                 SET current_calculation_id = $2::uuid, visibility_state = 'retired', visibility_reason = 'operator_retirement'
               WHERE id = $1::uuid`,
        params: [recordId, reversalId],
        pattern: /W4C0_POINTER.*(retired visibility reason|set_retired)/,
      },
    ]
    for (const leg of refusals) {
      const caught = await catchInTxn(pool, async (client) => {
        await client.query(leg.sql, leg.params)
      })
      expect(String((caught as Error | undefined)?.message ?? `NO ERROR for ${leg.label}`)).toMatch(leg.pattern)
    }

    // Positive: set_retired reversal pointer with the MATCHING visibility reason.
    await pool.query(
      `UPDATE attendance_records
          SET current_calculation_id = $2::uuid, visibility_state = 'retired', visibility_reason = 'import_rollback'
        WHERE id = $1::uuid`,
      [recordId, reversalId],
    )
    const final = await pool.query(
      'SELECT visibility_state, visibility_reason FROM attendance_records WHERE id = $1::uuid',
      [recordId],
    )
    expect(final.rows).toEqual([{ visibility_state: 'retired', visibility_reason: 'import_rollback' }])
    // Section 7.6 view surface: the retired row is invisible in attendance_current_records.
    const viewRow = await pool.query('SELECT count(*)::int AS n FROM attendance_current_records WHERE id = $1::uuid', [
      recordId,
    ])
    expect(viewRow.rows[0].n).toBe(0)
  })

  it('lineage: strictly-older refusal, forward/missing target refusal, cross-record refusal; uq_arc_operation retry backstop', async () => {
    const org = uuid()
    const recordId = await insertRecord(org)
    const otherRecordId = await insertRecord(org)
    let v1 = ''
    {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        v1 = await insertCalc(client, { org, recordId, version: 1 })
        await client.query('COMMIT')
      } finally {
        client.release()
      }
    }

    // Same-or-higher version target refused.
    const equalCaught = await catchInTxn(pool, async (client) => {
      await insertCalc(client, {
        org,
        recordId,
        version: 1,
        kind: 'reversal',
        outcome: 'reversed',
        reason: 'operator_retirement',
        mode: 'authoritative',
        effect: 'set_retired',
        expected: 0,
        supersedes: v1,
        projected: null,
        segments: 0,
      })
    })
    expect(String((equalCaught as Error).message)).toMatch(/W4C0_LINEAGE|uq_arc_record_version|duplicate key/)

    // Missing target refused.
    const missingCaught = await catchInTxn(pool, async (client) => {
      await insertCalc(client, { org, recordId, version: 2, supersedes: uuid() })
    })
    expect(String((missingCaught as Error).message)).toMatch(/W4C0_LINEAGE/)

    // Cross-record lineage refused (target belongs to another record).
    const crossCaught = await catchInTxn(pool, async (client) => {
      await insertCalc(client, { org, recordId: otherRecordId, version: 2, supersedes: v1 })
    })
    expect(String((crossCaught as Error).message)).toMatch(/W4C0_LINEAGE/)

    // Retry idempotency backstop: a second calculation reusing the SAME
    // (org, entrypoint, operation_id) cannot allocate another version.
    const opId = uuid()
    {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await insertCalc(client, { org, recordId, version: 2, operationId: opId })
        await client.query('COMMIT')
      } finally {
        client.release()
      }
    }
    const dupCaught = await catchInTxn(pool, async (client) => {
      await insertCalc(client, { org, recordId, version: 3, operationId: opId })
    })
    expect(String((dupCaught as Error).message)).toMatch(/uq_arc_operation/)
  })

  it('request snapshots: A->B->A appends three versions; duplicate version and mutable substitution refused', async () => {
    const org = uuid()
    const requestId = (
      await pool.query(
        `INSERT INTO attendance_requests (user_id, work_date, request_type, org_id)
         VALUES ($1, '2026-03-03', 'time_correction', $2) RETURNING id::text AS id`,
        [`w4c0e1-snap-user-${RUN}`, org],
      )
    ).rows[0].id as string
    const insertSnapshot = (version: number, payload: unknown, fingerprint: string) =>
      pool.query(
        `INSERT INTO attendance_request_calculation_snapshots
           (org_id, request_id, version, request_type, subject_user_id, payload, payload_fingerprint,
            attribution_snapshot, created_by)
         VALUES ($1, $2::uuid, $3, 'time_correction', 'subject-e1', $4::jsonb, $5, '{}'::jsonb, 'actor-e1')`,
        [org, requestId, version, JSON.stringify(payload), fingerprint],
      )
    await insertSnapshot(1, { edit: 'A' }, HEX64_A)
    await insertSnapshot(2, { edit: 'B' }, HEX64_B)
    // A -> B -> A: version 3 re-uses the version-1 fingerprint (index is NOT unique).
    await insertSnapshot(3, { edit: 'A' }, HEX64_A)
    const versions = await pool.query(
      'SELECT version, payload_fingerprint FROM attendance_request_calculation_snapshots WHERE org_id = $1 ORDER BY version',
      [org],
    )
    expect(versions.rows).toEqual([
      { version: 1, payload_fingerprint: HEX64_A },
      { version: 2, payload_fingerprint: HEX64_B },
      { version: 3, payload_fingerprint: HEX64_A },
    ])
    await expect(insertSnapshot(3, { edit: 'C' }, HEX64_C)).rejects.toThrow(/duplicate key/)
    const mutCaught = await catchInTxn(pool, async (client) => {
      await client.query(
        `UPDATE attendance_request_calculation_snapshots SET payload = '{"edit":"X"}'::jsonb WHERE org_id = $1 AND version = 1`,
        [org],
      )
    })
    expect(String((mutCaught as Error).message)).toMatch(/W4C0_IMMUTABLE/)
  })

  it('outbox: invalid event kind/duplicate identity/illegal transitions/immutability; delivered rows are terminal', async () => {
    const org = uuid()
    const opId = uuid()
    const insertEvent = (eventKind: string, operationId = opId) =>
      pool.query(
        `INSERT INTO attendance_result_event_outbox
           (org_id, entrypoint, operation_id, event_kind, payload, payload_schema_version, business_key_fingerprint)
         VALUES ($1, 'live_punch', $2::uuid, $3, '{"v":1}'::jsonb, 1, $4) RETURNING id::text AS id`,
        [org, operationId, eventKind, HEX64_A],
      )
    const { rows } = await insertEvent('attendance.punched')
    const outboxId = rows[0].id as string

    await expect(insertEvent('attendance.not-a-kind', uuid())).rejects.toThrow(/chk_areo_event_kind/)
    await expect(insertEvent('attendance.punched')).rejects.toThrow(/uq_areo_identity|duplicate key/)

    const refusals: Array<{ sql: string; params: unknown[]; pattern: RegExp }> = [
      {
        sql: `UPDATE attendance_result_event_outbox SET payload = '{"v":2}'::jsonb WHERE id = $1::uuid`,
        params: [outboxId],
        pattern: /W4C0_OUTBOX.*immutable/,
      },
      {
        sql: `UPDATE attendance_result_event_outbox SET attempts = attempts - 1 WHERE id = $1::uuid`,
        params: [outboxId],
        pattern: /W4C0_OUTBOX.*attempts|chk_areo_attempts/,
      },
      {
        sql: `UPDATE attendance_result_event_outbox SET delivery_state = 'failed' WHERE id = $1::uuid`,
        params: [outboxId],
        pattern: /W4C0_OUTBOX|chk_areo_delivery_state/,
      },
      {
        sql: `UPDATE attendance_result_event_outbox SET delivery_state = 'delivered' WHERE id = $1::uuid`,
        params: [outboxId],
        pattern: /chk_areo_delivered_pair/, // delivered requires delivered_at
      },
      { sql: 'DELETE FROM attendance_result_event_outbox WHERE id = $1::uuid', params: [outboxId], pattern: /W4C0_IMMUTABLE/ },
      { sql: 'TRUNCATE attendance_result_event_outbox', params: [], pattern: /W4C0_IMMUTABLE/ },
    ]
    for (const leg of refusals) {
      const caught = await catchInTxn(pool, async (client) => {
        await client.query(leg.sql, leg.params)
      })
      expect(String((caught as Error | undefined)?.message ?? 'NO ERROR')).toMatch(leg.pattern)
    }

    // Positive: retry bookkeeping then the one legal terminal transition.
    await pool.query(
      `UPDATE attendance_result_event_outbox SET attempts = attempts + 1, next_attempt_at = now() WHERE id = $1::uuid`,
      [outboxId],
    )
    await pool.query(
      `UPDATE attendance_result_event_outbox SET delivery_state = 'delivered', delivered_at = now() WHERE id = $1::uuid`,
      [outboxId],
    )
    const terminalCaught = await catchInTxn(pool, async (client) => {
      await client.query(`UPDATE attendance_result_event_outbox SET attempts = attempts + 1 WHERE id = $1::uuid`, [
        outboxId,
      ])
    })
    expect(String((terminalCaught as Error).message)).toMatch(/delivered outbox row is immutable/)
  })

  it('rollback closures: unique per (org,batch); UPDATE/DELETE/TRUNCATE refused', async () => {
    const org = uuid()
    const batchId = uuid()
    const insertClosure = () =>
      pool.query(
        `INSERT INTO attendance_import_rollback_closures
           (org_id, batch_id, batch_fingerprint, actor_id, actor_authorization_posture, reason_code, correlation_id)
         VALUES ($1, $2::uuid, $3, 'actor-e1', 'operator', 'TEST_FIXTURE', $4)`,
        [org, batchId, HEX64_A, `corr-${RUN}`],
      )
    await insertClosure()
    await expect(insertClosure()).rejects.toThrow(/uq_airc_org_batch|duplicate key/)
  })

  // =========================================================================
  // E. P07 job gates.
  // =========================================================================

  it('P07 frozen fields: every identity/posture/vector field refuses UPDATE including null->1 promotion; closed execution_reason_code pairing', async () => {
    const org = uuid()
    const batch = uuid()
    const insertV1 = async (): Promise<string> => {
      const { rows } = await pool.query(
        `INSERT INTO attendance_import_jobs
           (org_id, batch_id, created_by, status, payload, w4_contract_version, w4_entrypoint,
            w4_batch_command_id, w4_source_kind, w4_source_ref, w4_actor_id, w4_actor_posture,
            w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
            w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector)
         SELECT $1, $2::uuid, 'actor-e1', 'queued', '{"rows":1}'::jsonb, 1, 'import_batch', $2::uuid, 'import_batch',
                'batch:e1', 'actor-e1', 'delegated_import', $3, 'shadow', 1, $3, $3,
                jsonb_build_array(jsonb_build_object(
                  'ordinal', 0, 'semanticFingerprint', $4::text,
                  'derivedOperationId', attendance_w4_uuidv5($5::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $4))::text,
                  'commandFingerprint', $3::text))
         RETURNING id::text AS id`,
        [org, batch, HEX64_B, HEX64_A, IMPORT_NS],
      )
      return rows[0].id as string
    }
    const jobId = await insertV1()

    const frozenLegs = [
      `SET w4_command_fingerprint = '${HEX64_C}'`,
      `SET w4_batch_command_id = '${uuid()}'::uuid`,
      `SET w4_accepted_write_posture = 'authoritative'`,
      `SET w4_item_count = 2`,
      `SET w4_identity_proof_vector = '[]'::jsonb`,
      `SET w4_actor_id = 'someone-else'`,
      `SET w4_contract_version = NULL`,
    ]
    for (const setClause of frozenLegs) {
      const caught = await catchInTxn(pool, async (client) => {
        await client.query(`UPDATE attendance_import_jobs ${setClause} WHERE id = $1::uuid`, [jobId])
      })
      expect(String((caught as Error | undefined)?.message ?? `NO ERROR for ${setClause}`)).toMatch(
        /W4C0_JOB_FROZEN|chk_aij_w4/,
      )
    }

    // null->1 promotion refusal: a legacy job can never be backfilled into the V1 shape.
    const legacyId = (
      await pool.query(
        `INSERT INTO attendance_import_jobs (org_id, batch_id, created_by, status, payload)
         VALUES ($1, $2::uuid, 'actor-e1', 'queued', '{"legacy":true}'::jsonb) RETURNING id::text AS id`,
        [org, uuid()],
      )
    ).rows[0].id as string
    const promoteCaught = await catchInTxn(pool, async (client) => {
      await client.query(
        `UPDATE attendance_import_jobs
            SET w4_contract_version = 1, w4_entrypoint = 'import_batch', w4_batch_command_id = $2::uuid,
                w4_source_kind = 'import_batch', w4_source_ref = 'b', w4_actor_id = 'a', w4_actor_posture = 'delegated_import',
                w4_command_fingerprint = $3, w4_accepted_write_posture = 'shadow', w4_item_count = 1,
                w4_item_sequence_fingerprint = $3, w4_item_set_fingerprint = $3, w4_identity_proof_vector = '[]'::jsonb
          WHERE id = $1::uuid`,
        [legacyId, uuid(), HEX64_B],
      )
    })
    expect(String((promoteCaught as Error).message)).toMatch(/W4C0_JOB_FROZEN/)

    // execution_reason_code closed pairing.
    await pool.query(`UPDATE attendance_import_jobs SET w4_execution_reason_code = 'SEGMENT_CALCULATION_SUSPENDED' WHERE id = $1::uuid`, [jobId])
    const pairingLegs: Array<{ sql: string; pattern: RegExp }> = [
      // suspension pairs ONLY with queued.
      { sql: `UPDATE attendance_import_jobs SET status = 'failed' WHERE id = $1::uuid`, pattern: /chk_aij_w4_exec_reason/ },
      // unknown code.
      { sql: `UPDATE attendance_import_jobs SET w4_execution_reason_code = 'SOME_OTHER_CODE' WHERE id = $1::uuid`, pattern: /chk_aij_w4_exec_reason/ },
      // rollout-state value such as `eligible` is not an execution reason either.
      { sql: `UPDATE attendance_import_jobs SET w4_execution_reason_code = 'eligible' WHERE id = $1::uuid`, pattern: /chk_aij_w4_exec_reason/ },
    ]
    for (const leg of pairingLegs) {
      const caught = await catchInTxn(pool, async (client) => {
        await client.query(leg.sql, [jobId])
      })
      expect(String((caught as Error | undefined)?.message ?? 'NO ERROR')).toMatch(leg.pattern)
    }
    // posture conflict pairs ONLY with failed (transition through clearing the reason).
    await pool.query(`UPDATE attendance_import_jobs SET w4_execution_reason_code = NULL, status = 'failed' WHERE id = $1::uuid`, [jobId])
    await pool.query(`UPDATE attendance_import_jobs SET w4_execution_reason_code = 'ATTENDANCE_ASYNC_JOB_POSTURE_CONFLICT' WHERE id = $1::uuid`, [jobId])
    const completedCaught = await catchInTxn(pool, async (client) => {
      await client.query(`UPDATE attendance_import_jobs SET status = 'completed' WHERE id = $1::uuid`, [jobId])
    })
    expect(String((completedCaught as Error).message)).toMatch(/chk_aij_w4_exec_reason/)

    // A legacy (all-null) job cannot carry an execution reason at all.
    const legacyReasonCaught = await catchInTxn(pool, async (client) => {
      await client.query(`UPDATE attendance_import_jobs SET w4_execution_reason_code = 'SEGMENT_CALCULATION_SUSPENDED' WHERE id = $1::uuid`, [legacyId])
    })
    expect(String((legacyReasonCaught as Error).message)).toMatch(/chk_aij_w4_shape/)

    // Partial shape combos (beyond the smoke leg): missing proof vector; missing posture.
    for (const missing of ['w4_identity_proof_vector', 'w4_accepted_write_posture']) {
      const caught = await catchInTxn(pool, async (client) => {
        await client.query(
          `INSERT INTO attendance_import_jobs
             (org_id, batch_id, created_by, status, payload, w4_contract_version, w4_entrypoint,
              w4_batch_command_id, w4_source_kind, w4_source_ref, w4_actor_id, w4_actor_posture,
              w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
              w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector)
           SELECT $1, $2::uuid, 'actor-e1', 'queued', '{}'::jsonb, 1, 'import_batch', $2::uuid, 'import_batch',
                  'batch:e1', 'actor-e1', 'delegated_import', $3,
                  CASE WHEN $4 = 'w4_accepted_write_posture' THEN NULL ELSE 'shadow' END, 1, $3, $3,
                  CASE WHEN $4 = 'w4_identity_proof_vector' THEN NULL
                       ELSE jsonb_build_array(jsonb_build_object(
                         'ordinal', 0, 'semanticFingerprint', $5::text,
                         'derivedOperationId', attendance_w4_uuidv5($6::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $5))::text,
                         'commandFingerprint', $3::text)) END`,
          [org, uuid(), HEX64_B, missing, HEX64_A, IMPORT_NS],
        )
      })
      expect(String((caught as Error | undefined)?.message ?? `NO ERROR for missing ${missing}`)).toMatch(/chk_aij_w4_shape/)
    }
  })

  it('P07 proof-vector CHECK matrix: reordered/duplicated/short/long/tampered/wrong-namespace vectors are rejected', async () => {
    const org = uuid()
    const insertWithVector = async (batch: string, vectorSql: string, params: unknown[]): Promise<unknown> =>
      catchInTxn(pool, async (client) => {
        await client.query(
          `INSERT INTO attendance_import_jobs
             (org_id, batch_id, created_by, status, payload, w4_contract_version, w4_entrypoint,
              w4_batch_command_id, w4_source_kind, w4_source_ref, w4_actor_id, w4_actor_posture,
              w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
              w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector)
           SELECT $1, $2::uuid, 'actor-e1', 'queued', '{}'::jsonb, 1, 'import_batch', $2::uuid, 'import_batch',
                  'batch:e1', 'actor-e1', 'delegated_import', $3, 'shadow', 2, $3, $3, (${vectorSql})`,
          [org, batch, HEX64_B, ...params],
        )
      })

    const entry = (batchParam: string, ordinal: number, fp: string, ns = IMPORT_NS) =>
      `jsonb_build_object('ordinal', ${ordinal}, 'semanticFingerprint', '${fp}',
        'derivedOperationId', attendance_w4_uuidv5('${ns}'::uuid, attendance_w4_item_name_bytes(${batchParam}::uuid, ${ordinal}, '${fp}'))::text,
        'commandFingerprint', '${HEX64_B}')`

    const batch = uuid()
    // Reordered: entries [1,0] — ordinal must equal position.
    let caught = await insertWithVector(batch, `jsonb_build_array(${entry('$2', 1, HEX64_B)}, ${entry('$2', 0, HEX64_A)})`, [])
    expect(String((caught as Error).message)).toMatch(/chk_aij_w4_proof_vector/)
    // Duplicated ordinal.
    caught = await insertWithVector(batch, `jsonb_build_array(${entry('$2', 0, HEX64_A)}, ${entry('$2', 0, HEX64_A)})`, [])
    expect(String((caught as Error).message)).toMatch(/chk_aij_w4_proof_vector/)
    // Short (count 1 vs item_count 2).
    caught = await insertWithVector(batch, `jsonb_build_array(${entry('$2', 0, HEX64_A)})`, [])
    expect(String((caught as Error).message)).toMatch(/chk_aij_w4_proof_vector/)
    // Long (count 3 vs item_count 2).
    caught = await insertWithVector(
      batch,
      `jsonb_build_array(${entry('$2', 0, HEX64_A)}, ${entry('$2', 1, HEX64_B)}, ${entry('$2', 2, HEX64_C)})`,
      [],
    )
    expect(String((caught as Error).message)).toMatch(/chk_aij_w4_proof_vector/)
    // Tampered derived ID: entry 1 derived under a DIFFERENT root.
    caught = await insertWithVector(
      batch,
      `jsonb_build_array(${entry('$2', 0, HEX64_A)}, ${entry(`'${uuid()}'`, 1, HEX64_B)})`,
      [],
    )
    expect(String((caught as Error).message)).toMatch(/chk_aij_w4_proof_vector/)
    // Wrong namespace: derived under the INTEGRATION namespace for an import_batch job.
    caught = await insertWithVector(
      batch,
      `jsonb_build_array(${entry('$2', 0, HEX64_A)}, ${entry('$2', 1, HEX64_B, '46501375-c273-459f-a5af-f926859f6411')})`,
      [],
    )
    expect(String((caught as Error).message)).toMatch(/chk_aij_w4_proof_vector/)
    // Extra key inside an entry.
    caught = await insertWithVector(
      batch,
      `jsonb_build_array(${entry('$2', 0, HEX64_A)}, (${entry('$2', 1, HEX64_B)}) || jsonb_build_object('extra', 1))`,
      [],
    )
    expect(String((caught as Error).message)).toMatch(/chk_aij_w4_proof_vector/)
    // Missing commandFingerprint key.
    caught = await insertWithVector(
      batch,
      `jsonb_build_array(${entry('$2', 0, HEX64_A)}, (${entry('$2', 1, HEX64_B)}) - 'commandFingerprint')`,
      [],
    )
    expect(String((caught as Error).message)).toMatch(/chk_aij_w4_proof_vector/)
    // Zero rows made it through.
    const rows = await pool.query('SELECT count(*)::int AS n FROM attendance_import_jobs WHERE org_id = $1', [org])
    expect(rows.rows[0].n).toBe(0)
  })

  it('P07 reservation backstop: two live connections in both commit orders converge on ONE durable job; 23505 never escapes the service; the raw unique index is load-bearing', async () => {
    const org = uuid()
    process.env[ENV_KEY] = org
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state
         (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope)
       VALUES ($1, 'shadow', 'w4c0-e1', 'TEST_FIXTURE', 'actor-e1', 1, 'legacy', 'synthetic_staging')`,
      [org],
    )
    const actor = `w4c0-e1-actor-${RUN}`
    const auth = () =>
      createAuthorizedAttendanceWriteContextV1({
        actorId: actor,
        actorPosture: 'delegated_import',
        tokenSubjectUserId: null,
        orgId: org,
        subjectScope: { kind: 'explicit_users', userIds: [actor] },
        capability: 'import',
        sourceRef: 'test:w4c0-e1',
      })
    const batchRoot = uuid()
    const legacyBatchId = uuid()

    const buildIdentities = async (client: PoolClient) => {
      const t = trx(client)
      const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(org)
      await acquireAttendanceCalculationRolloutLock(t, orgKey, 'shared')
      const posture = await resolveSegmentCalculationPosture(t, org)
      const orgIdentity = createVerifiedAttendanceOrgIdentityV1({ orgKey: org, posture })
      const batchIdentity = createVerifiedAttendanceOperationIdentityV1({
        org: orgIdentity,
        kind: 'batch',
        entrypoint: 'import_batch',
        source: { sourceKind: 'import_batch', batchCommandId: batchRoot },
      })
      const items = [HEX64_A, HEX64_B].map((semanticFingerprint, index) => ({
        identity: createVerifiedAttendanceOperationIdentityV1({
          org: orgIdentity,
          kind: 'item',
          entrypoint: 'import_batch',
          source: { sourceKind: 'import_item', batchCommandId: batchRoot, ordinal: String(index), semanticFingerprint },
        }),
        commandFingerprint: semanticFingerprint,
      }))
      return { batchIdentity, items }
    }
    const reserveOn = async (client: PoolClient) => {
      const built = await buildIdentities(client)
      return reserveAttendanceImportJobW4V1(trx(client), auth(), {
        batchIdentity: built.batchIdentity,
        items: built.items,
        batchCommandFingerprint: HEX64_C,
        legacyJob: { batchId: legacyBatchId, createdBy: actor, payload: { rows: 2 }, total: 2 },
      })
    }

    const holder = await pool.connect()
    const waiter = await pool.connect()
    const surfaced: unknown[] = []
    try {
      // ORDER 1 — holder inserts but ROLLS BACK while the waiter is already blocked on
      // the class-10 locks: the waiter must then insert (kind 'created'), proving its
      // reservation re-read happens under the lock, not before it.
      await holder.query('BEGIN')
      const held = await reserveOn(holder)
      expect(held.kind).toBe('created')
      await waiter.query('BEGIN')
      const waiterPromise = reserveOn(waiter).catch((error) => {
        surfaced.push(error)
        throw error
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      await holder.query('ROLLBACK')
      const afterRollback = await waiterPromise
      expect(afterRollback.kind).toBe('created')
      await waiter.query('COMMIT')

      // ORDER 2 — holder-side transaction COMMITTED first: the second concurrent
      // byte-congruent enqueue returns the SAME durable job.
      await holder.query('BEGIN')
      const replayPromise = reserveOn(holder)
      const replay = await replayPromise
      expect(replay).toEqual({
        kind: 'existing',
        jobId: (afterRollback as { jobId: string }).jobId,
        status: 'queued',
      })
      await holder.query('COMMIT')
    } finally {
      holder.release()
      waiter.release()
    }
    expect(surfaced).toEqual([])

    // Exactly ONE durable job for the tuple.
    const jobs = await pool.query(
      'SELECT count(*)::int AS n FROM attendance_import_jobs WHERE org_id = $1 AND w4_batch_command_id = $2::uuid',
      [org, batchRoot],
    )
    expect(jobs.rows[0].n).toBe(1)

    // The raw unique backstop is load-bearing: bypassing the service (no advisory
    // lock, no re-read) hits uq_attendance_import_jobs_w4_reservation as 23505 —
    // proof the index exists and that ONLY the service layer keeps 23505 from callers.
    const rawCaught = await catchInTxn(pool, async (client) => {
      await client.query(
        `INSERT INTO attendance_import_jobs
           (org_id, batch_id, created_by, status, payload, w4_contract_version, w4_entrypoint,
            w4_batch_command_id, w4_source_kind, w4_source_ref, w4_actor_id, w4_actor_posture,
            w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
            w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector)
         SELECT $1, $2::uuid, 'actor-e1', 'queued', '{}'::jsonb, 1, 'import_batch', $3::uuid, 'import_batch',
                'batch:e1', 'actor-e1', 'delegated_import', $4, 'shadow', 1, $4, $4,
                jsonb_build_array(jsonb_build_object(
                  'ordinal', 0, 'semanticFingerprint', $5::text,
                  'derivedOperationId', attendance_w4_uuidv5($6::uuid, attendance_w4_item_name_bytes($3::uuid, 0, $5))::text,
                  'commandFingerprint', $4::text))`,
        [org, uuid(), batchRoot, HEX64_B, HEX64_A, IMPORT_NS],
      )
    })
    expect((rawCaught as { code?: string }).code).toBe('23505')
    expect(String((rawCaught as Error).message)).toMatch(/uq_attendance_import_jobs_w4_reservation/)

    // Changed actor on the same reservation: 409, no second job, still no raw 23505.
    const changedActorCaught = await catchInTxn(pool, async (client) => {
      const built = await buildIdentities(client)
      await reserveAttendanceImportJobW4V1(
        trx(client),
        createAuthorizedAttendanceWriteContextV1({
          actorId: `${actor}-other`,
          actorPosture: 'delegated_import',
          tokenSubjectUserId: null,
          orgId: org,
          subjectScope: { kind: 'explicit_users', userIds: [actor] },
          capability: 'import',
          sourceRef: 'test:w4c0-e1',
        }),
        {
          batchIdentity: built.batchIdentity,
          items: built.items,
          batchCommandFingerprint: HEX64_C,
          legacyJob: { batchId: legacyBatchId, createdBy: actor, payload: { rows: 2 }, total: 2 },
        },
      )
    })
    expect((changedActorCaught as { code?: string }).code).toBe('ATTENDANCE_OPERATION_CONFLICT')

    // A null-version legacy job can NEVER satisfy W4 replay: for a FRESH batch root
    // that only has a legacy job row, the reservation must still insert a V1 job
    // (kind 'created'), not return the legacy row as 'existing'.
    const legacyOnlyRoot = uuid()
    await pool.query(
      `INSERT INTO attendance_import_jobs (org_id, batch_id, created_by, status, payload)
       VALUES ($1, $2::uuid, 'actor-e1', 'completed', '{"legacy":true}'::jsonb)`,
      [org, legacyOnlyRoot],
    )
    const legacyOnlyResult = await (async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const t = trx(client)
        const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(org)
        await acquireAttendanceCalculationRolloutLock(t, orgKey, 'shared')
        const posture = await resolveSegmentCalculationPosture(t, org)
        const orgIdentity = createVerifiedAttendanceOrgIdentityV1({ orgKey: org, posture })
        const result = await reserveAttendanceImportJobW4V1(t, auth(), {
          batchIdentity: createVerifiedAttendanceOperationIdentityV1({
            org: orgIdentity,
            kind: 'batch',
            entrypoint: 'import_batch',
            source: { sourceKind: 'import_batch', batchCommandId: legacyOnlyRoot },
          }),
          items: [
            {
              identity: createVerifiedAttendanceOperationIdentityV1({
                org: orgIdentity,
                kind: 'item',
                entrypoint: 'import_batch',
                source: {
                  sourceKind: 'import_item',
                  batchCommandId: legacyOnlyRoot,
                  ordinal: '0',
                  semanticFingerprint: HEX64_A,
                },
              }),
              commandFingerprint: HEX64_A,
            },
          ],
          batchCommandFingerprint: HEX64_C,
          legacyJob: { batchId: legacyOnlyRoot, createdBy: actor, payload: { rows: 1 }, total: 1 },
        })
        await client.query('COMMIT')
        return result
      } finally {
        client.release()
      }
    })()
    expect(legacyOnlyResult.kind).toBe('created')
    const legacyUntouched = await pool.query(
      `SELECT status, payload::text AS p FROM attendance_import_jobs
        WHERE org_id = $1 AND batch_id = $2::uuid AND w4_contract_version IS NULL`,
      [org, legacyOnlyRoot],
    )
    expect(legacyUntouched.rows).toEqual([{ status: 'completed', p: '{"legacy": true}' }])
  }, 30000)

  // =========================================================================
  // F. Trigger posture + CI wiring self-checks.
  // =========================================================================

  it('no W4 trigger is disabled after data exists (tgenabled=O across the whole surface)', async () => {
    const { rows } = await pool.query(
      `SELECT c.relname, t.tgname, t.tgenabled
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND (t.tgname LIKE 'trg\\_a%' AND c.relname LIKE 'attendance\\_%')
        ORDER BY c.relname, t.tgname`,
    )
    const w4Triggers = rows.filter((row: { tgname: string }) => row.tgname.startsWith('trg_a'))
    expect(w4Triggers.length).toBeGreaterThanOrEqual(20)
    const notEnabled = w4Triggers.filter((row: { tgenabled: string }) => row.tgenabled !== 'O')
    expect(notEnabled).toEqual([])
  })

  it('this suite is DB-excluded from the no-DB run and explicitly named in CI (two-point wiring)', () => {
    const repoRoot = path.resolve(__dirname, '../../../..')
    const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
    const vitestConfig = fs.readFileSync(
      path.join(repoRoot, 'packages/core-backend/vitest.config.ts'),
      'utf8',
    )
    expect(workflow).toContain('tests/integration/attendance-w4c0-db-gates-e1.db.test.ts')
    expect(vitestConfig).toContain('tests/integration/attendance-w4c0-db-gates-e1.db.test.ts')
  })
})
