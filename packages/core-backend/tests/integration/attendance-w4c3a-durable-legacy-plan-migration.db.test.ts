/**
 * Real-Postgres migration gates for W4C-3a durable legacy execution plans.
 * The suite owns scratch databases so its guarded-down and direct-SQL corruption legs cannot
 * hide behind a shared fixture's state.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import {
  computeLegacyImportAsyncJobSummaryDigestV1,
  type LegacyImportAsyncJobSummaryV1,
  type RawImportEvidenceV1,
} from '../../src/attendance/w4c3a-legacy-execution-plan'
import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import {
  down,
  LEGACY_IMPORT_PLAN_MAX_SOURCE_ROWS_PER_CHUNK,
  up,
} from '../../src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const run = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
const hex = (letter: string) => letter.repeat(64)
const EMPTY_SEQUENCE = '94809bfff965ac75c18c3f0fb4f01081090a535d5de8dca93d7126e1267b6993'
const EMPTY_SET = 'b1fd18b44303a9d854528cd0acf09a6c9947d6893fff761b0713617a06faad69'
const TERMINAL_RESPONSE: LegacyImportAsyncJobSummaryV1 = {
  __jobType: 'commit',
  idempotencyKey: null,
  __importEngine: 'standard',
  recordUpsertStrategy: 'unnest',
  itemsInsertStrategy: 'unnest',
  summary: {
    processedRows: 1,
    failedRows: 0,
    elapsedMs: 10,
    chunkConfig: { size: 500 },
  },
}
const TERMINAL_RESPONSE_DIGEST =
  computeLegacyImportAsyncJobSummaryDigestV1(TERMINAL_RESPONSE)
const EMPTY_OBJECT_DIGEST = crypto
  .createHash('sha256')
  .update('{}', 'utf8')
  .digest('hex')

function newId(): string {
  return crypto.randomUUID()
}

function rawEvidence(sourceOrdinal = 0): RawImportEvidenceV1 {
  const firstInAt = '2026-07-30T01:00:00.000Z'
  return {
    schemaVersion: 1,
    sourceOrdinal,
    punches: [{ direction: 'check_in', occurredAt: firstInAt }],
    fields: {
      userId: { present: true, value: 'user-a' },
      workDate: { present: true, value: '2026-07-30' },
      timezone: { present: true, value: 'Asia/Shanghai' },
      firstInAt: { present: true, value: firstInAt },
      lastOutAt: { present: false, value: null },
      status: { present: false, value: null },
      isWorkday: { present: false, value: null },
    },
    metrics: {
      workMinutes: { present: false, value: null },
      lateMinutes: { present: false, value: null },
      earlyLeaveMinutes: { present: false, value: null },
    },
    provenance: {
      transport: 'rows',
      sourceRef: `migration-fixture:${run}:${sourceOrdinal}`,
      artifactSha256: null,
      normalizedCsvSha256: null,
      convertedSheetName: null,
    },
  }
}

function rawPlanItem(kind: 'skip' | 'apply') {
  const evidence = rawEvidence()
  return kind === 'apply'
    ? {
        kind,
        ordinal: 0,
        semanticOrdinal: 0,
        itemId: newId(),
        targetRef: 'fixture-target',
        previewSnapshot: {},
        recordWriteRef: 'fixture-record-write',
        rawEvidence: evidence,
      }
    : {
        kind,
        ordinal: 0,
        semanticOrdinal: null,
        itemId: newId(),
        resolvedUserId: null,
        resolvedWorkDate: null,
        reasonCode: 'validation',
        warnings: [],
        previewSnapshot: {},
        rawEvidence: evidence,
      }
}

async function createBase(pool: Pool): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await pool.query(`
    CREATE TABLE attendance_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL,
      first_in_at timestamptz, last_out_at timestamptz, work_minutes integer NOT NULL DEFAULT 0,
      late_minutes integer NOT NULL DEFAULT 0, early_leave_minutes integer NOT NULL DEFAULT 0,
      status varchar(64) NOT NULL DEFAULT 'normal', org_id text NOT NULL DEFAULT 'default')`)
  await pool.query(`
    CREATE TABLE attendance_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL,
      request_type varchar(30) NOT NULL, status varchar(20) NOT NULL DEFAULT 'pending', org_id text NOT NULL DEFAULT 'default')`)
  await pool.query(`
    CREATE TABLE attendance_import_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL DEFAULT 'default', batch_id uuid NOT NULL,
      created_by text NOT NULL, idempotency_key text, status varchar(20) NOT NULL DEFAULT 'queued',
      progress integer NOT NULL DEFAULT 0, total integer NOT NULL DEFAULT 0, error text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb, started_at timestamptz, finished_at timestamptz)`)
  await pool.query(`
    CREATE TABLE attendance_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, name text NOT NULL DEFAULT 'group')`)
  await pool.query(`
    CREATE TABLE attendance_group_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, group_id uuid NOT NULL,
      user_id text NOT NULL)`)
}

async function createScratch(adminPool: Pool, name: string): Promise<{ pool: Pool; kyselyPool: Pool; db: Kysely<unknown> }> {
  await adminPool.query(`DROP DATABASE IF EXISTS ${name}`)
  await adminPool.query(`CREATE DATABASE ${name}`)
  const url = new URL(dbUrl as string)
  url.pathname = `/${name}`
  const pool = new Pool({ connectionString: url.toString() })
  const kyselyPool = new Pool({ connectionString: url.toString() })
  await createBase(pool)
  return { pool, kyselyPool, db: new Kysely<unknown>({ dialect: new PostgresDialect({ pool: kyselyPool }) }) }
}

async function seedNoTargetJob(pool: Pool, orgId: string): Promise<{ jobId: string; batchId: string }> {
  const jobId = newId()
  const batchId = newId()
  const client = await pool.connect()
  try {
    await client.query('SET session_replication_role = replica')
    await client.query(
      `INSERT INTO attendance_import_jobs (
        id, org_id, batch_id, created_by, status, total, w4_contract_version, w4_entrypoint,
        w4_batch_command_id, w4_source_kind, w4_source_ref, w4_actor_id, w4_actor_posture,
        w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
        w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector,
        w4_legacy_plan_digest, w4_distinct_target_count, w4_operational_branch, w4_legacy_input_fingerprint
      ) VALUES ($1,$2,$3,$4,'queued',1,1,'import_batch',$3,'import_batch',$5,$6,'attendance_admin',$7,
        'legacy_projection_only',0,$8,$9,'[]'::jsonb,$10,0,'operational_only_no_target',$11)`,
      [jobId, orgId, batchId, `creator:${run}`, `ref:${run}`, `actor:${run}`, hex('a'), EMPTY_SEQUENCE, EMPTY_SET, hex('f'), hex('b')],
    )
  } finally {
    await client.query('SET session_replication_role = origin').catch(() => undefined)
    client.release()
  }
  return { jobId, batchId }
}

async function seedNoTargetPlan(pool: Pool, orgId: string, itemKind: 'skip' | 'apply' = 'skip'): Promise<{ jobId: string; batchId: string }> {
  const { jobId, batchId } = await seedNoTargetJob(pool, orgId)
  const manifest = {
    schemaVersion: 1, orgId, jobId, batchId, sourceKind: 'import_batch', sourceRef: `ref:${run}`,
    createdBy: `creator:${run}`, actorId: `actor:${run}`, actorPosture: 'attendance_admin', tokenSubjectUserId: null,
    acceptedWritePosture: 'legacy_projection_only', identityProofVectorDigest: '', commandFingerprint: hex('a'),
    legacyInputFingerprint: hex('b'), operationalBranch: 'operational_only_no_target', legacyRowSourceKind: 'direct_rows',
    sourceRowCount: 1, sourceOrdinalDigest: hex('c'), rawEvidenceDigest: hex('d'), w4ItemCount: 0, w4DistinctTargetCount: 0,
    w4ItemSequenceFingerprint: EMPTY_SEQUENCE, w4ItemSetFingerprint: EMPTY_SET, legacySourceRowLimit: null,
    groupRevision: null, groupStateFingerprint: null, chunkVectorDigest: hex('f'),
    batch: {
      kind: 'normal',
      source: 'manual',
      ruleSetId: null,
      mappingSnapshot: {},
      sourceRowCount: 1,
      status: 'committed',
      idempotencyKey: null,
      visibilityRule: 'org',
      engine: 'standard',
      chunkConfig: {},
      recordUpsertStrategy: 'unnest',
      itemsInsertStrategy: 'unnest',
      mappingProfileId: null,
      compatibilityMetadata: {},
      groupSync: null,
      itemReturnPolicy: { returnItems: false, itemsLimit: null },
      skippedSamplePolicy: { limit: 50 },
      resultSlots: {
        groupCreated: 'ensure_group_returned_row_count',
        groupMembersAdded: 'ensure_member_inserted_row_count',
      },
    },
    artifactCleanup: { kind: 'none' },
  }
  const digest = await pool.query(`SELECT encode(digest(convert_to('[]'::jsonb::text, 'UTF8'), 'sha256'), 'hex') AS value`)
  manifest.identityProofVectorDigest = digest.rows[0].value as string
  const client = await pool.connect()
  try {
    // This fixture is intentionally raw SQL. It models a committed V1 row and then verifies the
    // migration's normal triggers reject direct rewrites; no application helper participates.
    await client.query('SET session_replication_role = replica')
    await client.query(
      `INSERT INTO attendance_import_legacy_execution_plans (
        job_id, org_id, batch_id, plan_version, plan_digest, chunk_vector_digest, source_kind, source_ref, created_by,
        actor_id, actor_posture, token_subject_user_id, accepted_write_posture, identity_proof_vector_digest,
        command_fingerprint, legacy_input_fingerprint, operational_branch, legacy_row_source_kind, legacy_source_row_limit,
        source_row_count, source_ordinal_digest, w4_item_count, w4_distinct_target_count, w4_item_sequence_fingerprint,
        w4_item_set_fingerprint, group_revision, group_state_fingerprint, chunk_count, manifest
      ) VALUES ($1,$2,$3,1,$4,$5,'import_batch',$6,$7,$8,'attendance_admin',NULL,'legacy_projection_only',$9,$10,$11,
        'operational_only_no_target','direct_rows',NULL,1,$12,0,0,$13,$14,NULL,NULL,1,$15::jsonb)`,
      [jobId, orgId, batchId, hex('f'), hex('f'), `ref:${run}`, `creator:${run}`, `actor:${run}`, manifest.identityProofVectorDigest,
        hex('a'), hex('b'), hex('c'), EMPTY_SEQUENCE, EMPTY_SET, JSON.stringify(manifest)],
    )
    await client.query(
      `INSERT INTO attendance_import_legacy_execution_plan_chunks (job_id, chunk_index, first_source_ordinal, source_row_count, chunk_digest, chunk)
       VALUES ($1,0,0,1,$2,$3::jsonb)`,
      [jobId, hex('f'), JSON.stringify({ items: [rawPlanItem(itemKind)], recordWrites: [], groupEffects: [] })],
    )
  } finally {
    await client.query('SET session_replication_role = origin').catch(() => undefined)
    client.release()
  }
  return { jobId, batchId }
}

describeIfDatabase('W4C-3a durable legacy execution-plan migration (real PostgreSQL)', () => {
  const scratchName = `ms2_w4c3a_${run}`
  let adminPool: Pool
  let pool: Pool
  let kyselyPool: Pool
  let db: Kysely<unknown>

  beforeAll(async () => {
    const adminUrl = new URL(dbUrl as string)
    adminUrl.pathname = '/postgres'
    adminPool = new Pool({ connectionString: adminUrl.toString() })
    const scratch = await createScratch(adminPool, scratchName)
    pool = scratch.pool
    kyselyPool = scratch.kyselyPool
    db = scratch.db
    await w4c0Up(db)
    await pool.query(`
      ALTER TABLE attendance_import_jobs
      ADD CONSTRAINT chk_aij_w4_plan_columns CHECK (true)
    `)
    await up(db)
  }, 90000)

  afterAll(async () => {
    for (const current of [pool, kyselyPool, adminPool]) current?.on('error', () => undefined)
    await db?.destroy()
    await pool?.end()
    await adminPool?.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).catch(() => undefined)
    await adminPool?.end()
  })

  it('creates the four job columns, six history/revision tables, named deferred validator, and ten truncate guards', async () => {
    const columns = await pool.query(`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='attendance_import_jobs' AND column_name = ANY($1::text[])`, [
      ['w4_legacy_plan_digest', 'w4_distinct_target_count', 'w4_operational_branch', 'w4_legacy_input_fingerprint'],
    ])
    expect(columns.rows[0].count).toBe(4)
    const tables = await pool.query(`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name = ANY($1::text[])`, [[
      'attendance_import_legacy_execution_plans', 'attendance_import_legacy_execution_plan_chunks',
      'attendance_import_legacy_terminal_responses', 'attendance_import_upload_cleanup_commands',
      'attendance_record_target_revisions', 'attendance_group_effect_revisions',
    ]])
    expect(tables.rows[0].count).toBe(6)
    const planChecks = await pool.query(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'attendance_import_legacy_execution_plans'::regclass
        AND contype = 'c'
    `)
    expect(planChecks.rows.map((row) => row.definition).join('\n')).toContain(
      'w4_item_count <= source_row_count',
    )
    expect(planChecks.rows.map((row) => row.definition).join('\n')).toContain(
      'group_revision >= 0',
    )
    expect(planChecks.rows.map((row) => row.definition).join('\n')).toContain(
      "source_kind = 'import_batch'::text",
    )
    const validator = await pool.query(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p WHERE p.proname='attendance_validate_import_legacy_plan_v1'`)
    expect(validator.rows).toContainEqual(expect.objectContaining({ proname: 'attendance_validate_import_legacy_plan_v1', args: 'job_id uuid' }))
    const proofFunctions = await pool.query(`
      SELECT pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      WHERE p.proname = 'attendance_w4_job_proof_vector_valid'
      ORDER BY args
    `)
    expect(proofFunctions.rows.map((row) => row.args)).toEqual([
      'source_kind text, root uuid, vector jsonb, item_count integer, operational_branch text, distinct_target_count integer',
    ])
    const jobShape = await pool.query(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'attendance_import_jobs'::regclass
        AND conname = 'chk_aij_w4_shape'
    `)
    const jobShapeDefinition = String(jobShape.rows[0]?.definition)
    for (const column of [
      'w4_legacy_plan_digest',
      'w4_distinct_target_count',
      'w4_operational_branch',
      'w4_legacy_input_fingerprint',
    ]) {
      expect(jobShapeDefinition).toContain(`${column} IS NOT NULL`)
    }
    const planColumnsCheck = await pool.query(`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'attendance_import_jobs'::regclass
        AND conname = 'chk_aij_w4_plan_columns'
    `)
    expect(String(planColumnsCheck.rows[0]?.definition)).toContain(
      'w4_legacy_plan_digest',
    )
    const cleanupColumns = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='attendance_import_upload_cleanup_commands' ORDER BY ordinal_position`)
    expect(cleanupColumns.rows.map((row) => row.column_name)).toEqual([
      'job_id', 'org_id', 'file_id', 'status', 'attempt_count', 'claim_token', 'lease_expires_at', 'last_error_code', 'created_at', 'updated_at',
    ])
    const terminalCheck = await pool.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname LIKE '%response_variant%'`)
    expect(terminalCheck.rows.map((row) => row.definition).join('\n')).toContain('first_execution')
    expect(terminalCheck.rows.map((row) => row.definition).join('\n')).not.toContain("'completed'")
    const truncates = await pool.query(`
      SELECT count(*)::int AS count
      FROM pg_trigger
      WHERE tgfoid = 'attendance_w4c3a_deny_truncate()'::regprocedure
        AND NOT tgisinternal
    `)
    expect(truncates.rows[0].count).toBe(10)
    expect(LEGACY_IMPORT_PLAN_MAX_SOURCE_ROWS_PER_CHUNK).toBe(500)
  })

  it('keeps the successor proof function and insert/update/delete guard intact when the predecessor migration is replayed', async () => {
    const replayName = `${scratchName}_replay`
    const replay = await createScratch(adminPool, replayName)
    try {
      await w4c0Up(replay.db)
      await up(replay.db)

      const captureSuccessor = async (): Promise<{
        proofArguments: string[]
        guardFunction: string
        guardTrigger: string
      }> => {
        const proofFunctions = await replay.pool.query(`
          SELECT pg_get_function_identity_arguments(p.oid) AS args
          FROM pg_proc p
          WHERE p.proname = 'attendance_w4_job_proof_vector_valid'
          ORDER BY args
        `)
        const guardFunction = await replay.pool.query(`
          SELECT pg_get_functiondef(p.oid) AS definition
          FROM pg_proc p
          WHERE p.proname = 'attendance_w4_import_jobs_w4_guard'
            AND pg_get_function_identity_arguments(p.oid) = ''
        `)
        const guardTrigger = await replay.pool.query(`
          SELECT pg_get_triggerdef(t.oid, true) AS definition
          FROM pg_trigger t
          WHERE t.tgrelid = 'attendance_import_jobs'::regclass
            AND t.tgname = 'trg_aij_w4_guard'
            AND NOT t.tgisinternal
        `)
        return {
          proofArguments: proofFunctions.rows.map((row) => String(row.args)),
          guardFunction: String(guardFunction.rows[0]?.definition),
          guardTrigger: String(guardTrigger.rows[0]?.definition),
        }
      }

      const beforeReplay = await captureSuccessor()
      expect(beforeReplay.proofArguments).toEqual([
        'source_kind text, root uuid, vector jsonb, item_count integer, operational_branch text, distinct_target_count integer',
      ])
      expect(beforeReplay.guardTrigger).toMatch(/BEFORE INSERT OR DELETE OR UPDATE/)
      expect(beforeReplay.guardFunction).toContain('W4C3A_V1_PLAN_ENQUEUE_SEAM_REQUIRED')
      expect(beforeReplay.guardFunction).toContain('W4C3A_V1_JOB_DELETE_DENIED')

      await w4c0Up(replay.db)

      expect(await captureSuccessor()).toEqual(beforeReplay)
      await expect(replay.pool.query(
        `INSERT INTO attendance_import_jobs (
          id, org_id, batch_id, created_by, w4_contract_version
        ) VALUES ($1, $2, $3, $4, 1)`,
        [newId(), `replay-${run}`, newId(), `creator:${run}`],
      )).rejects.toThrow(/W4C3A_V1_PLAN_ENQUEUE_SEAM_REQUIRED/)

      const seeded = await seedNoTargetJob(replay.pool, `replay-delete-${run}`)
      await expect(
        replay.pool.query('DELETE FROM attendance_import_jobs WHERE id = $1', [seeded.jobId]),
      ).rejects.toThrow(/W4C3A_V1_JOB_DELETE_DENIED/)
    } finally {
      await replay.db.destroy()
      await replay.pool.end()
      await adminPool.query(`DROP DATABASE IF EXISTS ${replayName} WITH (FORCE)`).catch(() => undefined)
    }
  })

  it('rejects W4C-3a history attached to a classic null-version job', async () => {
    const jobId = newId()
    await pool.query(
      `INSERT INTO attendance_import_jobs (id, org_id, batch_id, created_by, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)`,
      [jobId, `classic-${run}`, newId(), `classic-user-${run}`, `classic-key-${run}`],
    )

    await expect(
      pool.query(
        `INSERT INTO attendance_import_legacy_terminal_responses (
           job_id, org_id, response_variant, response_digest, response
         ) VALUES ($1, $2, 'first_execution', $3, $4::jsonb)`,
        [jobId, `classic-${run}`, TERMINAL_RESPONSE_DIGEST, JSON.stringify(TERMINAL_RESPONSE)],
      ),
    ).rejects.toThrow(/W4C3A_NON_V1_HISTORY_DENIED/)
  })

  it('rejects invalid exact root keys and a direct incomplete V1 job at commit', async () => {
    const invalidRootJob = await seedNoTargetJob(pool, `invalid-root-${run}`)
    await expect(pool.query(`
      INSERT INTO attendance_import_legacy_execution_plans (
        job_id,org_id,batch_id,plan_version,plan_digest,chunk_vector_digest,source_kind,source_ref,created_by,actor_id,actor_posture,
        accepted_write_posture,identity_proof_vector_digest,command_fingerprint,legacy_input_fingerprint,operational_branch,
        source_row_count,source_ordinal_digest,w4_item_count,w4_distinct_target_count,w4_item_sequence_fingerprint,w4_item_set_fingerprint,chunk_count,manifest
      ) VALUES ($1,$2,$3,1,$4,$5,'import_batch',$6,$7,$8,'attendance_admin','legacy_projection_only',$9,$10,$11,
        'operational_only_no_target',1,$12,0,0,$13,$14,1,'{}'::jsonb)`, [
        invalidRootJob.jobId, `invalid-root-${run}`, invalidRootJob.batchId, hex('f'), hex('f'), `ref:${run}`, `creator:${run}`,
        `actor:${run}`, 'e5c56491e4a72f4a277b135ed3b91e41a5c4df2b7f5d3071f66f6c4c30f3dac0', hex('a'), hex('b'), hex('c'), EMPTY_SEQUENCE, EMPTY_SET,
      ])).rejects.toThrow()

    await expect(pool.query(`
      INSERT INTO attendance_import_jobs (
        org_id,batch_id,created_by,status,total,w4_contract_version,w4_entrypoint,w4_batch_command_id,w4_source_kind,w4_source_ref,
        w4_actor_id,w4_actor_posture,w4_command_fingerprint,w4_accepted_write_posture,w4_item_count,w4_item_sequence_fingerprint,
        w4_item_set_fingerprint,w4_identity_proof_vector,w4_legacy_plan_digest,w4_distinct_target_count,w4_operational_branch,w4_legacy_input_fingerprint
      ) VALUES ('${run}',gen_random_uuid(),'x','queued',0,1,'import_batch',gen_random_uuid(),'import_batch','x','x','attendance_admin',
        $1,'legacy_projection_only',0,$1,$1,'[]'::jsonb,$1,0,'operational_only_no_target',$1)`, [hex('a')])).rejects.toThrow(/W4C3A_V1_PLAN_ENQUEUE_SEAM_REQUIRED/)
  })

  it('rejects predecessor four-field V1 inserts even through the marked seam', async () => {
    const jobId = newId()
    const batchId = newId()
    const semanticFingerprint = hex('a')
    const commandFingerprint = hex('b')
    const derived = await pool.query(
      `SELECT attendance_w4_uuidv5(
         '6f67fdaa-e2aa-48b3-b76c-c4aab9723173'::uuid,
         attendance_w4_item_name_bytes($1::uuid, 0, $2)
       )::text AS id`,
      [batchId, semanticFingerprint],
    )
    const proof = [{
      ordinal: 0,
      semanticFingerprint,
      derivedOperationId: String(derived.rows[0].id),
      commandFingerprint,
    }]

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT set_config('attendance.w4c3a_enqueue_job_id', $1, true)`,
        [jobId],
      )
      await expect(
        client.query(
          `INSERT INTO attendance_import_jobs (
             id, org_id, batch_id, created_by, status, total, payload,
             w4_contract_version, w4_entrypoint, w4_batch_command_id,
             w4_source_kind, w4_source_ref, w4_actor_id, w4_actor_posture,
             w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
             w4_item_sequence_fingerprint, w4_item_set_fingerprint,
             w4_identity_proof_vector
           ) VALUES (
             $1, $2, $3, $4, 'queued', 1, '{}'::jsonb,
             1, 'import_batch', $3, 'import_batch', $5, $4, 'attendance_admin',
             $6, 'legacy_projection_only', 1, $7, $8, $9::jsonb
           )`,
          [
            jobId,
            `predecessor-${run}`,
            batchId,
            `actor:${run}`,
            `source:${run}`,
            hex('c'),
            hex('d'),
            hex('e'),
            JSON.stringify(proof),
          ],
        ),
      ).rejects.toMatchObject({ code: '23514' })
      await client.query('ROLLBACK')
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }

    await expect(
      pool.query(
        `INSERT INTO attendance_import_jobs (
           org_id,batch_id,created_by,status,total,w4_contract_version,w4_entrypoint,
           w4_batch_command_id,w4_source_kind,w4_source_ref,w4_actor_id,w4_actor_posture,
           w4_command_fingerprint,w4_accepted_write_posture,w4_item_count,
           w4_item_sequence_fingerprint,w4_item_set_fingerprint,w4_identity_proof_vector,
           w4_legacy_plan_digest,w4_distinct_target_count,w4_operational_branch,
           w4_legacy_input_fingerprint
         ) VALUES (
           $1,gen_random_uuid(),'x','queued',0,1,'import_batch',gen_random_uuid(),
           'import_batch','x','x','attendance_admin',$2,'legacy_projection_only',0,
           $3,$4,'[]'::jsonb,$5,0,'operational_only_no_target',$6
         )`,
        [
          `unmarked-${run}`,
          hex('a'),
          EMPTY_SEQUENCE,
          EMPTY_SET,
          hex('b'),
          hex('c'),
        ],
      ),
    ).rejects.toThrow(/W4C3A_V1_PLAN_ENQUEUE_SEAM_REQUIRED/)
  })

  it('preserves predecessor idempotency updates for null-version jobs', async () => {
    const inserted = await pool.query(
      `INSERT INTO attendance_import_jobs (
         org_id, batch_id, created_by, status, payload
       ) VALUES ($1, gen_random_uuid(), $2, 'queued', '{}'::jsonb)
       RETURNING id`,
      [`legacy-${run}`, `creator:${run}`],
    )
    const jobId = String(inserted.rows[0].id)
    await expect(
      pool.query(
        `UPDATE attendance_import_jobs
            SET idempotency_key = $2
          WHERE id = $1
          RETURNING idempotency_key`,
        [jobId, `legacy-key-${run}`],
      ),
    ).resolves.toMatchObject({
      rows: [{ idempotency_key: `legacy-key-${run}` }],
    })
  })

  it('makes plan/chunk/terminal immutable, cleanup identity immutable with a closed CAS, and V1 delete/reopen impossible', async () => {
    const { jobId } = await seedNoTargetPlan(pool, `org-${run}`)
    await expect(pool.query(`UPDATE attendance_import_legacy_execution_plans SET plan_digest=$2 WHERE job_id=$1`, [jobId, hex('b')])).rejects.toThrow(/IMMUTABLE/)
    await expect(pool.query(`UPDATE attendance_import_legacy_execution_plan_chunks SET chunk_digest=$2 WHERE job_id=$1`, [jobId, hex('b')])).rejects.toThrow(/IMMUTABLE/)
    await expect(pool.query(`UPDATE attendance_import_jobs SET idempotency_key='changed' WHERE id=$1`, [jobId])).rejects.toThrow(/W4C3A_V1_JOB_FROZEN/)
    const corruptJob = await pool.connect()
    try {
      await corruptJob.query(`SET session_replication_role = replica`)
      await corruptJob.query(`UPDATE attendance_import_jobs SET idempotency_key='changed' WHERE id=$1`, [jobId])
      await corruptJob.query(`SET session_replication_role = origin`)
      await expect(
        corruptJob.query(`SELECT attendance_validate_import_legacy_plan_v1($1::uuid)`, [jobId]),
      ).rejects.toThrow(/W4C3A_PLAN_JOB_CONGRUENCE_DENIED/)
      await corruptJob.query(`SET session_replication_role = replica`)
      await corruptJob.query(`UPDATE attendance_import_jobs SET idempotency_key=NULL WHERE id=$1`, [jobId])
      await corruptJob.query(`SET session_replication_role = origin`)
    } finally {
      await corruptJob.query(`SET session_replication_role = origin`).catch(() => undefined)
      corruptJob.release()
    }
    await expect(pool.query(
      `INSERT INTO attendance_import_legacy_terminal_responses
        (job_id,org_id,response_variant,response_digest,response)
       VALUES ($1,$2,'completed',$3,$4::jsonb)`,
      [jobId, `org-${run}`, TERMINAL_RESPONSE_DIGEST, JSON.stringify(TERMINAL_RESPONSE)],
    )).rejects.toThrow()
    await expect(pool.query(
      `INSERT INTO attendance_import_legacy_terminal_responses
        (job_id,org_id,response_variant,response_digest,response)
       VALUES ($1,$2,'first_execution',$3,'{}'::jsonb)`,
      [jobId, `org-${run}`, EMPTY_OBJECT_DIGEST],
    )).rejects.toThrow(/chk_ailtr_response_shape/)
    const terminalClient = await pool.connect()
    try {
      await terminalClient.query('SET session_replication_role = replica')
      await terminalClient.query(
        `INSERT INTO attendance_import_legacy_terminal_responses
          (job_id,org_id,response_variant,response_digest,response)
         VALUES ($1,$2,'first_execution',$3,$4::jsonb)`,
        [jobId, `org-${run}`, TERMINAL_RESPONSE_DIGEST, JSON.stringify(TERMINAL_RESPONSE)],
      )
    } finally {
      await terminalClient.query('SET session_replication_role = origin').catch(() => undefined)
      terminalClient.release()
    }
    await expect(pool.query(
      `UPDATE attendance_import_legacy_terminal_responses
       SET response_digest=$2 WHERE job_id=$1`,
      [jobId, hex('b')],
    )).rejects.toThrow(/IMMUTABLE/)
    await expect(pool.query(
      `DELETE FROM attendance_import_legacy_terminal_responses WHERE job_id=$1`,
      [jobId],
    )).rejects.toThrow(/IMMUTABLE/)
    await expect(pool.query(`DELETE FROM attendance_import_jobs WHERE id=$1`, [jobId])).rejects.toThrow(/DELETE_DENIED/)
    await expect(pool.query(
      `UPDATE attendance_import_jobs
       SET status='failed', error='must-not-leak', w4_execution_reason_code='ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH'
       WHERE id=$1`,
      [jobId],
    )).rejects.toThrow()
    await expect(pool.query(
      `UPDATE attendance_import_jobs
       SET status='failed', w4_execution_reason_code='ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH'
      WHERE id=$1`,
      [jobId],
    )).rejects.toThrow(
      /TERMINAL_IMMUTABLE|REASON_TRANSITION_DENIED|TERMINAL_CONGRUENCE_DENIED/,
    )

    const cleanupJob = newId()
    const fileId = newId()
    await pool.query(`SET session_replication_role = replica`)
    await pool.query(`INSERT INTO attendance_import_upload_cleanup_commands (job_id,org_id,file_id,status) VALUES ($1,$2,$3,'pending')`, [cleanupJob, `org-${run}`, fileId])
    await pool.query(`SET session_replication_role = origin`)
    await expect(pool.query(`UPDATE attendance_import_upload_cleanup_commands SET file_id=gen_random_uuid() WHERE job_id=$1`, [cleanupJob])).rejects.toThrow(/IDENTITY_IMMUTABLE/)
    await expect(pool.query(`UPDATE attendance_import_upload_cleanup_commands SET status='processing', attempt_count=1, claim_token=gen_random_uuid(), lease_expires_at=now() + interval '1 minute' WHERE job_id=$1`, [cleanupJob])).rejects.toThrow(/DIRECT_UPDATE_DENIED/)
    const cleanupBypass = await pool.connect()
    try {
      await cleanupBypass.query(`SET attendance.w4c3a_cleanup_cas = 'on'`)
      await expect(cleanupBypass.query(`UPDATE attendance_import_upload_cleanup_commands SET status='processing', attempt_count=1, claim_token=gen_random_uuid(), lease_expires_at=now() + interval '1 minute' WHERE job_id=$1`, [cleanupJob])).rejects.toThrow(/DIRECT_UPDATE_DENIED/)
    } finally {
      await cleanupBypass.query(`RESET attendance.w4c3a_cleanup_cas`).catch(() => undefined)
      cleanupBypass.release()
    }
    const claim = newId()
    const claimed = await pool.query(`SELECT attendance_claim_import_upload_cleanup_command($1,$2,now() + interval '1 minute') AS claimed`, [cleanupJob, claim])
    expect(claimed.rows[0].claimed).toBe(true)
    const wrongClaimBypass = await pool.connect()
    try {
      await wrongClaimBypass.query(`SET attendance.w4c3a_cleanup_claim_token = '${newId()}'`)
      await expect(wrongClaimBypass.query(`UPDATE attendance_import_upload_cleanup_commands SET status='completed', claim_token=NULL, lease_expires_at=NULL WHERE job_id=$1`, [cleanupJob])).rejects.toThrow(/CAS_DENIED/)
    } finally {
      await wrongClaimBypass.query(`RESET attendance.w4c3a_cleanup_claim_token`).catch(() => undefined)
      wrongClaimBypass.release()
    }
    const wrongFinish = await pool.query(`SELECT attendance_finish_import_upload_cleanup_command($1,$2,'completed',NULL) AS finished`, [cleanupJob, newId()])
    expect(wrongFinish.rows[0].finished).toBe(false)
    const finished = await pool.query(`SELECT attendance_finish_import_upload_cleanup_command($1,$2,'completed',NULL) AS finished`, [cleanupJob, claim])
    expect(finished.rows[0].finished).toBe(true)
    const expiredJob = newId()
    await pool.query(`SET session_replication_role = replica`)
    await pool.query(`INSERT INTO attendance_import_upload_cleanup_commands (job_id,org_id,file_id,status,attempt_count,claim_token,lease_expires_at) VALUES ($1,$2,$3,'processing',1,$4,now() - interval '1 minute')`, [expiredJob, `org-${run}`, newId(), newId()])
    await pool.query(`SET session_replication_role = origin`)
    const reclaimed = await pool.query(`SELECT attendance_claim_import_upload_cleanup_command($1,$2,now() + interval '1 minute') AS claimed`, [expiredJob, newId()])
    expect(reclaimed.rows[0].claimed).toBe(true)
    const invalidNoTarget = await seedNoTargetPlan(pool, `bad-no-target-${run}`, 'apply')
    await expect(pool.query(`UPDATE attendance_import_jobs SET progress=1 WHERE id=$1`, [invalidNoTarget.jobId])).rejects.toThrow(/NO_TARGET_BRANCH_DENIED/)
  })

  it('replays the complete successor frozen-field UPDATE matrix on a persisted V1 plan', async () => {
    const mutations = [
      ['w4_contract_version', 'NULL'],
      ['w4_entrypoint', "'scheduled_auto_absence'"],
      ['w4_batch_command_id', 'gen_random_uuid()'],
      ['w4_source_kind', "'scheduled_auto_absence'"],
      ['w4_source_ref', "'changed-source'"],
      ['w4_actor_id', "'changed-actor'"],
      ['w4_actor_posture', "'platform_admin'"],
      ['w4_token_subject_user_id', "'changed-subject'"],
      ['w4_command_fingerprint', `'${hex('b')}'`],
      ['w4_accepted_write_posture', "'shadow'"],
      ['w4_item_count', '1'],
      ['w4_item_sequence_fingerprint', `'${hex('d')}'`],
      ['w4_item_set_fingerprint', `'${hex('e')}'`],
      ['w4_identity_proof_vector', `'[{"changed":true}]'::jsonb`],
      ['w4_legacy_plan_digest', `'${hex('e')}'`],
      ['w4_distinct_target_count', '1'],
      ['w4_operational_branch', "'normal'"],
      ['w4_legacy_input_fingerprint', `'${hex('e')}'`],
      ['idempotency_key', "'changed-key'"],
      ['payload', `'{"changed":true}'::jsonb`],
    ] as const

    for (const [column, value] of mutations) {
      const { jobId } = await seedNoTargetPlan(
        pool,
        `frozen-${column}-${run}`,
      )
      await expect(
        pool.query(
          `UPDATE attendance_import_jobs SET ${column} = ${value} WHERE id = $1`,
          [jobId],
        ),
      ).rejects.toThrow(/W4C3A_V1_JOB_FROZEN/)
    }
  })

  it('replays successor execution-reason/status pairing and immutable terminal transitions', async () => {
    const suspended = await seedNoTargetPlan(pool, `reason-suspended-${run}`)
    await expect(
      pool.query(
        `UPDATE attendance_import_jobs
            SET w4_execution_reason_code = 'SEGMENT_CALCULATION_SUSPENDED'
          WHERE id = $1`,
        [suspended.jobId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 })
    await expect(
      pool.query(
        `UPDATE attendance_import_jobs SET status = 'running' WHERE id = $1`,
        [suspended.jobId],
      ),
    ).rejects.toThrow(/chk_aij_w4_exec_reason/)

    const postureConflict = await seedNoTargetPlan(
      pool,
      `reason-posture-${run}`,
    )
    await expect(
      pool.query(
        `UPDATE attendance_import_jobs
            SET status = 'failed',
                w4_execution_reason_code = 'ATTENDANCE_ASYNC_JOB_POSTURE_CONFLICT'
          WHERE id = $1`,
        [postureConflict.jobId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 })

    const planFailure = await seedNoTargetPlan(
      pool,
      `reason-plan-${run}`,
    )
    await expect(
      pool.query(
        `UPDATE attendance_import_jobs
            SET status = 'failed',
                error = NULL,
                w4_execution_reason_code = 'ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH'
          WHERE id = $1`,
        [planFailure.jobId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 })
    await expect(
      pool.query(
        `UPDATE attendance_import_jobs
            SET w4_execution_reason_code = 'ATTENDANCE_IMPORT_LEGACY_PLAN_VERSION_MISMATCH'
          WHERE id = $1`,
        [planFailure.jobId],
      ),
    ).rejects.toThrow(/W4C3A_V1_REASON_TRANSITION_DENIED/)
    await expect(
      pool.query(
        `UPDATE attendance_import_jobs SET status = 'queued' WHERE id = $1`,
        [planFailure.jobId],
      ),
    ).rejects.toThrow(
      /W4C3A_V1_TERMINAL_IMMUTABLE|W4C3A_V1_REASON_TRANSITION_DENIED/,
    )

    const leakedError = await seedNoTargetPlan(
      pool,
      `reason-error-${run}`,
    )
    await expect(
      pool.query(
        `UPDATE attendance_import_jobs
            SET status = 'failed',
                error = 'must-not-leak',
                w4_execution_reason_code = 'ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH'
          WHERE id = $1`,
        [leakedError.jobId],
      ),
    ).rejects.toThrow(/chk_aij_w4_exec_reason/)

    const unknownReason = await seedNoTargetPlan(
      pool,
      `reason-unknown-${run}`,
    )
    await expect(
      pool.query(
        `UPDATE attendance_import_jobs
            SET status = 'failed',
                w4_execution_reason_code = 'ATTENDANCE_IMPORT_UNKNOWN_REASON'
          WHERE id = $1`,
        [unknownReason.jobId],
      ),
    ).rejects.toThrow(/chk_aij_w4_exec_reason/)
  })

  it('backfills and bumps record/group revisions, rejects moves, and rejects all ten truncates', async () => {
    const upgradeName = `${scratchName}_upgrade`
    const upgrade = await createScratch(adminPool, upgradeName)
    try {
      await w4c0Up(upgrade.db)
      await upgrade.pool.query(`INSERT INTO attendance_records (org_id,user_id,work_date) VALUES ('historic-org','historic-user','2026-07-29')`)
      await upgrade.pool.query(`INSERT INTO attendance_groups (org_id,name) VALUES ('historic-org','historic-group')`)
      await up(upgrade.db)
      const historicRecord = await upgrade.pool.query(`SELECT revision FROM attendance_record_target_revisions WHERE org_id='historic-org' AND user_id='historic-user' AND work_date='2026-07-29'`)
      const historicGroup = await upgrade.pool.query(`SELECT revision FROM attendance_group_effect_revisions WHERE org_id='historic-org'`)
      expect(Number(historicRecord.rows[0].revision)).toBe(1)
      expect(Number(historicGroup.rows[0].revision)).toBe(1)
    } finally {
      await upgrade.db.destroy()
      await upgrade.pool.end()
      await adminPool.query(`DROP DATABASE IF EXISTS ${upgradeName} WITH (FORCE)`).catch(() => undefined)
    }

    const org = `revision-${run}`
    const user = `user-${run}`
    await pool.query(`SET session_replication_role = replica`)
    await pool.query(`INSERT INTO attendance_records (org_id,user_id,work_date) VALUES ($1,$2,'2026-07-30')`, [org, user])
    await pool.query(`SET session_replication_role = origin`)
    await pool.query(`INSERT INTO attendance_records (org_id,user_id,work_date) VALUES ($1,$2,'2026-07-31')`, [org, user])
    const revision = await pool.query(`SELECT revision FROM attendance_record_target_revisions WHERE org_id=$1 AND user_id=$2 AND work_date='2026-07-31'`, [org, user])
    expect(Number(revision.rows[0].revision)).toBe(1)
    await pool.query(`INSERT INTO attendance_record_target_revisions (org_id,user_id,work_date,revision) VALUES ($1,$2,'2026-08-02',0)`, [org, user])
    await expect(pool.query(`INSERT INTO attendance_record_target_revisions (org_id,user_id,work_date,revision) VALUES ($1,$2,'2026-08-03',1)`, [org, user])).rejects.toThrow(/DIRECT_MUTATION_DENIED/)
    const revisionBypass = await pool.connect()
    try {
      await revisionBypass.query(`SET attendance.w4c3a_revision_write = 'on'`)
      await expect(revisionBypass.query(`UPDATE attendance_record_target_revisions SET revision=revision+1 WHERE org_id=$1 AND user_id=$2 AND work_date='2026-08-02'`, [org, user])).rejects.toThrow(/DIRECT_MUTATION_DENIED/)
    } finally {
      await revisionBypass.query(`RESET attendance.w4c3a_revision_write`).catch(() => undefined)
      revisionBypass.release()
    }
    await expect(pool.query(`UPDATE attendance_records SET work_date='2026-08-01' WHERE org_id=$1 AND user_id=$2 AND work_date='2026-07-31'`, [org, user])).rejects.toThrow(/TARGET_MOVE_DENIED/)
    const group = await pool.query(`INSERT INTO attendance_groups (org_id,name) VALUES ($1,'g') RETURNING id`, [org])
    await pool.query(`INSERT INTO attendance_group_members (org_id,group_id,user_id) VALUES ($1,$2,$3)`, [org, group.rows[0].id, user])
    const groupRevision = await pool.query(`SELECT revision FROM attendance_group_effect_revisions WHERE org_id=$1`, [org])
    expect(Number(groupRevision.rows[0].revision)).toBeGreaterThanOrEqual(2)
    await pool.query(`INSERT INTO attendance_group_effect_revisions (org_id,revision) VALUES ($1,0)`, [`zero-group-${run}`])
    await expect(pool.query(`INSERT INTO attendance_group_effect_revisions (org_id,revision) VALUES ($1,1)`, [`one-group-${run}`])).rejects.toThrow(/DIRECT_MUTATION_DENIED/)
    for (const table of [
      'attendance_import_jobs',
      'attendance_import_legacy_execution_plans',
      'attendance_import_legacy_execution_plan_chunks',
      'attendance_import_legacy_terminal_responses',
      'attendance_import_upload_cleanup_commands',
      'attendance_records',
      'attendance_groups',
      'attendance_group_members',
      'attendance_record_target_revisions',
      'attendance_group_effect_revisions',
    ]) {
      await expect(pool.query(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(/TRUNCATE_DENIED/)
    }
  })


  it('OD-W4C-60 ordinary-role single-transaction commit rejects open batch/result leaves', async () => {
    const orgId = `org-od60-ord-${run}`
    // Seed job only (replica), then exercise ordinary-role plan/chunk inserts.
    const { jobId, batchId } = await seedNoTargetJob(pool, orgId)
    const digest = await pool.query(
      `SELECT encode(digest(convert_to('[]'::jsonb::text, 'UTF8'), 'sha256'), 'hex') AS value`,
    )
    const identityProofVectorDigest = String(digest.rows[0].value)

    function manifestWithBatch(batch: Record<string, unknown>) {
      return {
        schemaVersion: 1, orgId, jobId, batchId, sourceKind: 'import_batch', sourceRef: `ref:${run}`,
        createdBy: `creator:${run}`, actorId: `actor:${run}`, actorPosture: 'attendance_admin',
        tokenSubjectUserId: null, acceptedWritePosture: 'legacy_projection_only',
        identityProofVectorDigest, commandFingerprint: hex('a'), legacyInputFingerprint: hex('b'),
        operationalBranch: 'operational_only_no_target', legacyRowSourceKind: 'direct_rows',
        sourceRowCount: 1, sourceOrdinalDigest: hex('c'), rawEvidenceDigest: hex('d'), w4ItemCount: 0, w4DistinctTargetCount: 0,
        w4ItemSequenceFingerprint: EMPTY_SEQUENCE, w4ItemSetFingerprint: EMPTY_SET,
        legacySourceRowLimit: null, groupRevision: null, groupStateFingerprint: null,
        chunkVectorDigest: hex('f'), batch, artifactCleanup: { kind: 'none' },
      }
    }
    const goodBatch = {
      kind: 'normal', source: 'manual', ruleSetId: null, mappingSnapshot: {},
      sourceRowCount: 1, status: 'committed', idempotencyKey: null, visibilityRule: 'org',
      engine: 'standard', chunkConfig: {}, recordUpsertStrategy: 'unnest',
      itemsInsertStrategy: 'unnest', mappingProfileId: null, compatibilityMetadata: {},
      groupSync: null,
      itemReturnPolicy: { returnItems: false, itemsLimit: null },
      skippedSamplePolicy: { limit: 50 },
      resultSlots: {
        groupCreated: 'ensure_group_returned_row_count',
        groupMembersAdded: 'ensure_member_inserted_row_count',
      },
    }
    const badBatches: Array<{ label: string; batch: Record<string, unknown> }> = [
      {
        label: 'omit itemReturnPolicy',
        batch: Object.fromEntries(Object.entries(goodBatch).filter(([k]) => k !== 'itemReturnPolicy')),
      },
      {
        label: 'extra key on itemReturnPolicy',
        batch: { ...goodBatch, itemReturnPolicy: { returnItems: false, itemsLimit: null, extra: true } },
      },
      {
        label: 'wrong returnItems literal',
        batch: { ...goodBatch, itemReturnPolicy: { returnItems: true, itemsLimit: null } },
      },
      { label: 'limit -1', batch: { ...goodBatch, skippedSamplePolicy: { limit: -1 } } },
      { label: 'limit 501', batch: { ...goodBatch, skippedSamplePolicy: { limit: 501 } } },
      { label: 'limit fraction', batch: { ...goodBatch, skippedSamplePolicy: { limit: 1.5 } } },
      {
        label: 'wrong resultSlots literal',
        batch: {
          ...goodBatch,
          resultSlots: {
            groupCreated: 'plan_value',
            groupMembersAdded: 'ensure_member_inserted_row_count',
          },
        },
      },
      { label: 'empty resultSlots object', batch: { ...goodBatch, resultSlots: {} } },
    ]

    for (const c of badBatches) {
      const seeded = await seedNoTargetJob(pool, orgId)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const role = await client.query(`SELECT current_setting('session_replication_role') AS r`)
        expect(String(role.rows[0].r)).toBe('origin')
        const m = manifestWithBatch(c.batch)
        m.jobId = seeded.jobId
        m.batchId = seeded.batchId
        await expect(
          client.query(
            `INSERT INTO attendance_import_legacy_execution_plans (
              job_id, org_id, batch_id, plan_version, plan_digest, chunk_vector_digest, source_kind, source_ref, created_by,
              actor_id, actor_posture, token_subject_user_id, accepted_write_posture, identity_proof_vector_digest,
              command_fingerprint, legacy_input_fingerprint, operational_branch, legacy_row_source_kind, legacy_source_row_limit,
              source_row_count, source_ordinal_digest, w4_item_count, w4_distinct_target_count, w4_item_sequence_fingerprint,
              w4_item_set_fingerprint, group_revision, group_state_fingerprint, chunk_count, manifest
            ) VALUES ($1,$2,$3,1,$4,$5,'import_batch',$6,$7,$8,'attendance_admin',NULL,'legacy_projection_only',$9,$10,$11,
              'operational_only_no_target','direct_rows',NULL,1,$12,0,0,$13,$14,NULL,NULL,1,$15::jsonb)`,
            [
              seeded.jobId, orgId, seeded.batchId, hex('f'), hex('f'), `ref:${run}`, `creator:${run}`, `actor:${run}`,
              identityProofVectorDigest, hex('a'), hex('b'), hex('c'), EMPTY_SEQUENCE, EMPTY_SET,
              JSON.stringify(m),
            ],
          ),
        ).rejects.toThrow()
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    }

    // Valid exact shapes commit under ordinary role in one transaction (plan+chunk).
    {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const role = await client.query(`SELECT current_setting('session_replication_role') AS r`)
        expect(String(role.rows[0].r)).toBe('origin')
        await client.query(
          `INSERT INTO attendance_import_legacy_execution_plans (
            job_id, org_id, batch_id, plan_version, plan_digest, chunk_vector_digest, source_kind, source_ref, created_by,
            actor_id, actor_posture, token_subject_user_id, accepted_write_posture, identity_proof_vector_digest,
            command_fingerprint, legacy_input_fingerprint, operational_branch, legacy_row_source_kind, legacy_source_row_limit,
            source_row_count, source_ordinal_digest, w4_item_count, w4_distinct_target_count, w4_item_sequence_fingerprint,
            w4_item_set_fingerprint, group_revision, group_state_fingerprint, chunk_count, manifest
          ) VALUES ($1,$2,$3,1,$4,$5,'import_batch',$6,$7,$8,'attendance_admin',NULL,'legacy_projection_only',$9,$10,$11,
            'operational_only_no_target','direct_rows',NULL,1,$12,0,0,$13,$14,NULL,NULL,1,$15::jsonb)`,
          [
            jobId, orgId, batchId, hex('f'), hex('f'), `ref:${run}`, `creator:${run}`, `actor:${run}`,
            identityProofVectorDigest, hex('a'), hex('b'), hex('c'), EMPTY_SEQUENCE, EMPTY_SET,
            JSON.stringify(manifestWithBatch(goodBatch)),
          ],
        )
        await client.query(
          `INSERT INTO attendance_import_legacy_execution_plan_chunks
             (job_id, chunk_index, first_source_ordinal, source_row_count, chunk_digest, chunk)
           VALUES ($1,0,0,1,$2,$3::jsonb)`,
          [
            jobId, hex('f'),
            JSON.stringify({
              items: [rawPlanItem('skip')],
              recordWrites: [{ resultSlots: {} }],
              groupEffects: [],
            }),
          ],
        )
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    }

    // Nonempty record resultSlots rejected immediately on chunk INSERT (ordinary role).
    {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const role = await client.query(`SELECT current_setting('session_replication_role') AS r`)
        expect(String(role.rows[0].r)).toBe('origin')
        await expect(
          client.query(
            `INSERT INTO attendance_import_legacy_execution_plan_chunks
               (job_id, chunk_index, first_source_ordinal, source_row_count, chunk_digest, chunk)
             VALUES ($1,1,1,1,$2,$3::jsonb)`,
            [
              jobId, hex('e'),
              JSON.stringify({
                items: [],
                recordWrites: [{ resultSlots: { groupCreated: 1 } }],
                groupEffects: [],
              }),
            ],
          ),
        ).rejects.toThrow()
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }
    }
  })




  it('refuses up before DDL for any pre-amendment V1 job, and guarded down restores predecessor columns only when empty', async () => {
    const blockedName = `${scratchName}_blocked`
    const blocked = await createScratch(adminPool, blockedName)
    try {
      await w4c0Up(blocked.db)
      await blocked.pool.query(`ALTER TABLE attendance_import_jobs DROP CONSTRAINT chk_aij_w4_shape`)
      await blocked.pool.query(`INSERT INTO attendance_import_jobs (org_id,batch_id,created_by,w4_contract_version) VALUES ('blocked',gen_random_uuid(),'x',1)`)
      await expect(up(blocked.db)).rejects.toThrow(/PREEXISTING_V1_IMPORT_JOB/)
      const absent = await blocked.pool.query(`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name='attendance_import_legacy_execution_plans'`)
      expect(absent.rows[0].count).toBe(0)
    } finally {
      await blocked.db.destroy()
      await blocked.pool.end()
      await adminPool.query(`DROP DATABASE IF EXISTS ${blockedName} WITH (FORCE)`).catch(() => undefined)
    }

    await expect(down(db)).rejects.toThrow(/DOWN_REFUSED/)

    const emptyName = `${scratchName}_empty`
    const empty = await createScratch(adminPool, emptyName)
    try {
      await w4c0Up(empty.db)
      await up(empty.db)
      await down(empty.db)
      const columns = await empty.pool.query(`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='attendance_import_jobs' AND column_name = ANY($1::text[])`, [[
        'w4_legacy_plan_digest', 'w4_distinct_target_count', 'w4_operational_branch', 'w4_legacy_input_fingerprint',
      ]])
      expect(columns.rows[0].count).toBe(0)
      const predecessorProof = await empty.pool.query(`SELECT count(*)::int AS count FROM pg_proc p WHERE p.proname='attendance_w4_job_proof_vector_valid' AND pg_get_function_identity_arguments(p.oid)='source_kind text, root uuid, vector jsonb, item_count integer'`)
      expect(predecessorProof.rows[0].count).toBe(1)
      const history = await empty.pool.query(`SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name = ANY($1::text[])`, [[
        'attendance_import_legacy_execution_plans', 'attendance_import_legacy_execution_plan_chunks',
        'attendance_import_legacy_terminal_responses', 'attendance_import_upload_cleanup_commands',
        'attendance_record_target_revisions', 'attendance_group_effect_revisions',
      ]])
      expect(history.rows[0].count).toBe(0)
    } finally {
      await empty.db.destroy()
      await empty.pool.end()
      await adminPool.query(`DROP DATABASE IF EXISTS ${emptyName} WITH (FORCE)`).catch(() => undefined)
    }
  })
})
