/**
 * Core-only W4C-3a rollout-control proof.
 *
 * Extended for the W4C-5 transition-safety amendment (docs/development/
 * attendance-issue-4556-w4c5-transition-safety-amendment-20260804.md,
 * OD-W4C-61=(a)): the closed transition matrix, expected-state/version
 * staleness rejection, allowlist-gated row creation, and the new section 3
 * database-backed predicates (retryable job posture, nonterminal legacy job,
 * incomplete operation, unresolved ingress review, defective pending request
 * snapshot).
 */
import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import {
  __setW4C3aRolloutControlAfterExclusiveLockForTests,
  __setW4C3aRolloutControlBeforeEventInsertForTests,
  closeLegacyRollbackWindowV1,
  transitionAttendanceCalculationRolloutV1,
  type AttendanceW4C3aRolloutControlResultV1,
  type EvidenceReferencesV1,
} from '../../src/attendance/w4c3a-rollout-control'
import {
  acquireAttendanceCalculationRolloutLock,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  type AttendanceRolloutStateV1,
  type AttendanceW4TransactionClientV1,
} from '../../src/attendance/w4c0-identity'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const run = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

const ALLOWLIST_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const IMPORT_NS = '6f67fdaa-e2aa-48b3-b76c-c4aab9723173'

const ALL_STATES: readonly AttendanceRolloutStateV1[] = ['legacy', 'shadow', 'eligible', 'authoritative', 'suspended']
// The amendment section 1 table, hardcoded independently of the production LEGAL_TRANSITIONS
// constant so a bug in that constant cannot hide from this test.
const LEGAL_PAIRS: ReadonlyArray<readonly [AttendanceRolloutStateV1, AttendanceRolloutStateV1]> = [
  ['legacy', 'shadow'],
  ['shadow', 'eligible'],
  ['eligible', 'shadow'],
  ['eligible', 'authoritative'],
  ['shadow', 'legacy'],
  ['authoritative', 'suspended'],
  ['suspended', 'authoritative'],
]

function transactionClient(client: PoolClient): AttendanceW4TransactionClientV1 {
  return {
    query: (text, values) => client.query(text, values as unknown[]) as unknown as Promise<{ rows: Array<Record<string, unknown>> }>,
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve: () => resolve?.() }
}

function hex64(seed: string): string {
  return crypto.createHash('sha256').update(seed).digest('hex')
}

function baseRefs(seed: string): EvidenceReferencesV1 {
  return Object.freeze({
    imageSha: `img-${seed}`,
    ownerAuthorizationRef: `owner-${seed}`,
    syntheticOrgRef: `org-${seed}`,
  }) as EvidenceReferencesV1
}

function resumeRefs(seed: string): EvidenceReferencesV1 {
  return Object.freeze({
    ...baseRefs(seed),
    ownerIncidentReviewRef: `incident-${seed}`,
    offlineReplayArtifactRef: `replay-${seed}`,
  }) as EvidenceReferencesV1
}

async function createBase(pool: Pool): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await pool.query(`
    CREATE TABLE attendance_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL,
      first_in_at timestamptz, last_out_at timestamptz, work_minutes integer NOT NULL DEFAULT 0,
      late_minutes integer NOT NULL DEFAULT 0, early_leave_minutes integer NOT NULL DEFAULT 0,
      status varchar(64) NOT NULL DEFAULT 'normal', is_workday boolean, meta jsonb,
      source_batch_id uuid, org_id text NOT NULL
    )`)
  await pool.query(`
    CREATE TABLE attendance_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL,
      request_type varchar(30) NOT NULL, status varchar(20) NOT NULL DEFAULT 'pending', org_id text NOT NULL
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, batch_id uuid NOT NULL,
      created_by text NOT NULL, idempotency_key text, status varchar(20) NOT NULL DEFAULT 'queued',
      progress integer NOT NULL DEFAULT 0, total integer NOT NULL DEFAULT 0, error text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb, started_at timestamptz, finished_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_batches (
      id uuid PRIMARY KEY, org_id text NOT NULL, idempotency_key text, status text NOT NULL,
      row_count integer NOT NULL DEFAULT 0, meta jsonb NOT NULL DEFAULT '{}'::jsonb
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), batch_id uuid NOT NULL, org_id text NOT NULL,
      user_id text, work_date date, record_id uuid, preview_snapshot jsonb
    )`)
}

describeIfDatabase('W4C-3a core-only rollout control (real PostgreSQL)', () => {
  const scratchName = `ms2_w4c3a_control_${run}`
  const orgId = crypto.randomUUID()
  const batchId = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const actorId = `w4c3a-control-${run}`
  const allowlisted = new Set<string>()
  let adminPool: Pool
  let pool: Pool

  function allow(id: string): void {
    allowlisted.add(id)
    process.env[ALLOWLIST_ENV] = [...allowlisted].join(',')
  }

  async function insertLegacyBatch(id = batchId, org = orgId): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_import_batches (id, org_id, status, row_count, meta)
       VALUES ($1::uuid, $2, 'committed', 1, '{"source":"test"}'::jsonb)`,
      [id, org],
    )
    await pool.query(
      `INSERT INTO attendance_import_items (batch_id, org_id, user_id, work_date, preview_snapshot)
       VALUES ($1::uuid, $2, $3, '2026-08-01', '{}'::jsonb)`,
      [id, org, userId],
    )
  }

  /** Minimal valid V1 retryable job (see attendance-w4c0-durable-storage-smoke fixture shape). */
  async function insertRetryableJob(
    org: string,
    status: 'queued' | 'failed',
    acceptedWritePosture: 'legacy_projection_only' | 'shadow' | 'authoritative',
  ): Promise<void> {
    const batchCommandId = crypto.randomUUID()
    const fp = hex64(`${org}:${batchCommandId}`)
    await pool.query(
      `INSERT INTO attendance_import_jobs
         (org_id, batch_id, created_by, status, payload, w4_contract_version, w4_entrypoint,
          w4_batch_command_id, w4_source_kind, w4_source_ref, w4_actor_id, w4_actor_posture,
          w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
          w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector)
       SELECT $1, $2::uuid, 'actor-control', $3, '{}'::jsonb, 1, 'import_batch',
              $2::uuid, 'import_batch', 'batch:control', 'actor-control', 'delegated_import',
              $4, $5, 1, $4, $4,
              jsonb_build_array(jsonb_build_object(
                'ordinal', 0,
                'semanticFingerprint', $4::text,
                'derivedOperationId', attendance_w4_uuidv5($6::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $4))::text,
                'commandFingerprint', $4::text))`,
      [org, batchCommandId, status, fp, acceptedWritePosture, IMPORT_NS],
    )
  }

  async function insertNullVersionLegacyJob(org: string, status: 'queued' | 'running'): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_import_jobs (org_id, batch_id, created_by, status, payload)
       VALUES ($1, $2, 'actor-control', $3, '{}'::jsonb)`,
      [org, crypto.randomUUID(), status],
    )
  }

  /**
   * `attendance_result_operations`/`attendance_result_operation_batches` `claimed` rows are
   * deliberately NOT used here: a deferred commit-time constraint trigger
   * (`attendance_w4_*_claimed_commit_guard`) forbids ever committing a transaction that leaves
   * a row it touched `claimed` — that state is same-transaction-transient only. The durable
   * "incomplete org operation" this predicate targets (lock section 9: "Promotion drains or
   * cancels every incomplete org operation before changing posture") is a still-open V1 job.
   */
  async function insertIncompleteV1Job(org: string, status: 'queued' | 'running' | 'failed'): Promise<void> {
    await insertRetryableJob(org, status === 'queued' || status === 'failed' ? status : 'queued', 'shadow')
    if (status === 'running') {
      await pool.query(
        `UPDATE attendance_import_jobs SET status = 'running' WHERE org_id = $1 AND status = 'queued'`,
        [org],
      )
    }
  }

  async function insertUnresolvedReview(org: string): Promise<void> {
    const recordId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO attendance_records (id, user_id, work_date, org_id) VALUES ($1::uuid, $2, '2026-08-01', $3)`,
      [recordId, crypto.randomUUID(), org],
    )
    await pool.query(
      `INSERT INTO attendance_record_calculations (
         id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint,
         engine_version, snapshot_schema_version, operation_id, semantic_input_fingerprint,
         provenance_fingerprint, attribution_snapshot, segment_snapshot, evidence_snapshot,
         approved_facts_snapshot, input_provenance, merge_policy, calculation_tier, outcome,
         outcome_reason_code, projection_effect, expected_segment_count, actor_id, correlation_id)
       VALUES (
         $1::uuid, $2, $3::uuid, 1, 'calculation', 'shadow', 'legacy_import',
         'w4c3a-control-test', 1, $4::uuid, $5, $6,
         '{"posture":"unsupported","sourceSchemaVersion":null,"reason":"missing","sourceFingerprint":null}'::jsonb,
         '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'append', 'legacy_shadow',
         'review_required', 'legacy_time_ingress_not_authoritative', 'none', 0, $7, $8)`,
      [
        crypto.randomUUID(),
        org,
        recordId,
        crypto.randomUUID(),
        hex64(`${org}:${recordId}:semantic`),
        hex64(`${org}:${recordId}:provenance`),
        actorId,
        crypto.randomUUID(),
      ],
    )
  }

  async function insertPendingRequest(
    org: string,
    kind: 'missing_snapshot' | 'unsupported_snapshot',
  ): Promise<void> {
    const requestId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO attendance_requests (id, user_id, work_date, request_type, status, org_id)
       VALUES ($1::uuid, $2, '2026-08-01', 'time_correction', 'pending', $3)`,
      [requestId, crypto.randomUUID(), org],
    )
    if (kind === 'unsupported_snapshot') {
      await pool.query(
        `INSERT INTO attendance_request_calculation_snapshots (
           org_id, request_id, version, request_type, subject_user_id, payload, payload_fingerprint,
           attribution_snapshot, created_by)
         VALUES ($1, $2::uuid, 1, 'time_correction', $3, '{"schemaVersion":1}'::jsonb, $4,
           '{"posture":"unsupported","sourceSchemaVersion":null,"reason":"missing","sourceFingerprint":null}'::jsonb, $5)`,
        [org, requestId, crypto.randomUUID(), hex64(`${org}:${requestId}:payload`), actorId],
      )
    }
  }

  beforeAll(async () => {
    const adminUrl = new URL(dbUrl as string)
    adminUrl.pathname = '/postgres'
    adminPool = new Pool({ connectionString: adminUrl.toString() })
    await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
    await adminPool.query(`CREATE DATABASE ${scratchName}`)
    const scratchUrl = new URL(dbUrl as string)
    scratchUrl.pathname = `/${scratchName}`
    pool = new Pool({ connectionString: scratchUrl.toString() })
    await createBase(pool)
    // Kysely owns the supplied pool on destroy; the test retains that pool for
    // the two live contender connections below and closes it in afterAll.
    const db = new Kysely<never>({ dialect: new PostgresDialect({ pool }) })
    await w4c0Up(db)
    await insertLegacyBatch()
    allow(orgId)
  }, 60_000)

  afterAll(async () => {
    __setW4C3aRolloutControlAfterExclusiveLockForTests(null)
    __setW4C3aRolloutControlBeforeEventInsertForTests(null)
    delete process.env[ALLOWLIST_ENV]
    await pool?.end().catch(() => undefined)
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`).catch(() => undefined)
      await adminPool.end().catch(() => undefined)
    }
  })

  it('rejects a transition while a legacy batch is neither closed nor preimaged', async () => {
    const client = await pool.connect()
    try {
      await expect(
        transitionAttendanceCalculationRolloutV1(transactionClient(client), {
          orgId, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
          evidenceManifestSha256: hex64('unclosed-batch'), evidenceReferences: baseRefs('unclosed'),
          reasonCode: 'rollout_transition',
        }),
      ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_UNCLOSED_BATCH' })
      await expect(pool.query('SELECT count(*)::int AS n FROM attendance_calculation_rollout_state WHERE org_id = $1', [orgId]))
        .resolves.toMatchObject({ rows: [{ n: 0 }] })
    } finally {
      client.release()
    }
  })

  it('refuses closure when an integration batch owns the compatibility batch identity', async () => {
    const integrationOrgId = crypto.randomUUID()
    const integrationBatchId = crypto.randomUUID()
    const integrationUserId = crypto.randomUUID()
    const semanticFingerprint = 'd'.repeat(64)
    await pool.query(
      `INSERT INTO attendance_import_batches (id, org_id, status, row_count, meta)
       VALUES ($1::uuid, $2, 'committed', 1, '{"source":"test"}'::jsonb)`,
      [integrationBatchId, integrationOrgId],
    )
    await pool.query(
      `INSERT INTO attendance_import_items (batch_id, org_id, user_id, work_date, preview_snapshot)
       VALUES ($1::uuid, $2, $3, '2026-08-02', '{}'::jsonb)`,
      [integrationBatchId, integrationOrgId, integrationUserId],
    )
    const registryClient = await pool.connect()
    try {
      await registryClient.query('BEGIN')
      await registryClient.query(
        `INSERT INTO attendance_result_operation_batches (
           org_id, entrypoint, batch_command_id, identity_source_kind, source_root_id,
           source_ref, actor_id, actor_posture, token_subject_user_id, capability,
           subject_scope, accepted_write_posture, command_fingerprint, item_count,
           item_sequence_fingerprint, item_set_fingerprint, state)
         VALUES ($1, 'integration_batch', $2::uuid, 'integration_batch', $2::uuid,
           'test:w4c3a-control-integration', $3, 'attendance_admin', $3, 'import',
           $4::jsonb, 'authoritative', $5, 1, $6, $7, 'claimed')`,
        [
          integrationOrgId,
          integrationBatchId,
          actorId,
          JSON.stringify({ kind: 'explicit_users', userIds: [integrationUserId] }),
          'a'.repeat(64),
          'b'.repeat(64),
          'c'.repeat(64),
        ],
      )
      await registryClient.query(
        `INSERT INTO attendance_result_operations (
           org_id, entrypoint, operation_id, batch_command_id, input_ordinal,
           identity_source_kind, source_root_id, proof_semantic_fingerprint,
           source_ref, actor_id, actor_posture, token_subject_user_id, capability,
           subject_scope, command_fingerprint, accepted_write_posture,
           normalized_business_input_snapshot, state)
         VALUES ($1, 'integration_batch', attendance_w4_uuidv5(
             '46501375-c273-459f-a5af-f926859f6411'::uuid,
             attendance_w4_item_name_bytes($2::uuid, 0, $3)),
           $2::uuid, 0, 'integration_item', $2::uuid, $3,
           'test:w4c3a-control-integration', $4, 'attendance_admin', $4, 'import',
           $5::jsonb, $6, 'authoritative', '{}'::jsonb, 'claimed')`,
        [
          integrationOrgId,
          integrationBatchId,
          semanticFingerprint,
          actorId,
          JSON.stringify({ kind: 'explicit_users', userIds: [integrationUserId] }),
          'a'.repeat(64),
        ],
      )
      await registryClient.query(
        `UPDATE attendance_result_operations
            SET state = 'canceled', updated_at = now(), version = version + 1
          WHERE org_id = $1 AND entrypoint = 'integration_batch'
            AND batch_command_id = $2::uuid`,
        [integrationOrgId, integrationBatchId],
      )
      await registryClient.query(
        `UPDATE attendance_result_operation_batches
            SET state = 'canceled', updated_at = now(), version = version + 1
          WHERE org_id = $1 AND entrypoint = 'integration_batch'
            AND batch_command_id = $2::uuid`,
        [integrationOrgId, integrationBatchId],
      )
      await registryClient.query('COMMIT')
    } catch (error) {
      await registryClient.query('ROLLBACK')
      throw error
    } finally {
      registryClient.release()
    }

    const client = await pool.connect()
    try {
      await expect(closeLegacyRollbackWindowV1(transactionClient(client), {
        orgId: integrationOrgId,
        batchId: integrationBatchId,
        actorId,
        correlationId: crypto.randomUUID(),
        engineVersion: 'w4c3a-control-test',
        reasonCode: 'legacy_rollback_window_closed',
      })).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_CLOSE_CONFLICT' })
      await expect(pool.query(
        `SELECT count(*)::int AS n
           FROM attendance_import_rollback_closures
          WHERE org_id = $1 AND batch_id = $2::uuid`,
        [integrationOrgId, integrationBatchId],
      )).resolves.toMatchObject({ rows: [{ n: 0 }] })
    } finally {
      client.release()
    }
  })

  it('serializes close then transition across two independent connections', async () => {
    const entered = deferred()
    const release = deferred()
    __setW4C3aRolloutControlAfterExclusiveLockForTests(async (kind) => {
      if (kind === 'close') {
        entered.resolve()
        await release.promise
      }
    })
    const closeClient = await pool.connect()
    const transitionClient = await pool.connect()
    try {
      const close = closeLegacyRollbackWindowV1(transactionClient(closeClient), {
        orgId, batchId, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
        reasonCode: 'legacy_rollback_window_closed',
      })
      await entered.promise
      let transitionSettled = false
      const transition = transitionAttendanceCalculationRolloutV1(transactionClient(transitionClient), {
        orgId, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
        targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
        evidenceManifestSha256: hex64('serialize-close-then-transition'), evidenceReferences: baseRefs('sct'),
        reasonCode: 'rollout_transition',
      }).finally(() => { transitionSettled = true })
      await new Promise((resolve) => setTimeout(resolve, 75))
      expect(transitionSettled).toBe(false)
      release.resolve()
      await expect(close).resolves.toEqual<AttendanceW4C3aRolloutControlResultV1>({ orgId, state: 'legacy', batchId })
      await expect(pool.query(
        `SELECT count(*)::int AS n FROM attendance_import_rollback_closures WHERE org_id = $1 AND batch_id = $2::uuid`,
        [orgId, batchId],
      )).resolves.toMatchObject({ rows: [{ n: 1 }] })
      await expect(transition).resolves.toEqual<AttendanceW4C3aRolloutControlResultV1>({ orgId, state: 'shadow', batchId: null })
      await expect(pool.query(
        `SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1`, [orgId],
      )).resolves.toMatchObject({ rows: [{ state: 'shadow', version: 2 }] })
      await expect(pool.query(
        `SELECT count(*)::int AS n FROM attendance_import_rollback_closures WHERE org_id = $1 AND batch_id = $2::uuid`,
        [orgId, batchId],
      )).resolves.toMatchObject({ rows: [{ n: 1 }] })
    } finally {
      __setW4C3aRolloutControlAfterExclusiveLockForTests(null)
      closeClient.release()
      transitionClient.release()
    }
  })

  it('serializes transition before a competing close and performs no second closure DML', async () => {
    const entered = deferred()
    const release = deferred()
    __setW4C3aRolloutControlAfterExclusiveLockForTests(async (kind) => {
      if (kind === 'transition') {
        entered.resolve()
        await release.promise
      }
    })
    const transitionClient = await pool.connect()
    const closeClient = await pool.connect()
    try {
      const transition = transitionAttendanceCalculationRolloutV1(transactionClient(transitionClient), {
        orgId, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
        targetState: 'eligible', expectedState: 'shadow', expectedVersion: 2,
        evidenceManifestSha256: hex64('serialize-transition-before-close'), evidenceReferences: baseRefs('stbc'),
        reasonCode: 'rollout_transition',
      })
      await entered.promise
      let closeSettled = false
      const duplicateClose = closeLegacyRollbackWindowV1(transactionClient(closeClient), {
        orgId, batchId, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
        reasonCode: 'legacy_rollback_window_closed',
      }).finally(() => { closeSettled = true })
      await new Promise((resolve) => setTimeout(resolve, 75))
      expect(closeSettled).toBe(false)
      release.resolve()
      await expect(transition).resolves.toEqual<AttendanceW4C3aRolloutControlResultV1>({ orgId, state: 'eligible', batchId: null })
      await expect(duplicateClose).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_CLOSE_CONFLICT' })
      await expect(pool.query(
        `SELECT count(*)::int AS n FROM attendance_import_rollback_closures WHERE org_id = $1 AND batch_id = $2::uuid`,
        [orgId, batchId],
      )).resolves.toMatchObject({ rows: [{ n: 1 }] })
    } finally {
      __setW4C3aRolloutControlAfterExclusiveLockForTests(null)
      transitionClient.release()
      closeClient.release()
    }
  })

  // ---------------------------------------------------------------------------
  // W4C-5 amendment coverage
  // ---------------------------------------------------------------------------

  describe('closed transition matrix (completion gates 1-2)', () => {
    it('rejects every pair outside the closed 7-pair matrix before any lock or DML', async () => {
      const client = await pool.connect()
      try {
        const illegalPairs: Array<readonly [AttendanceRolloutStateV1, AttendanceRolloutStateV1]> = []
        for (const from of ALL_STATES) {
          for (const to of ALL_STATES) {
            if (LEGAL_PAIRS.some(([legalFrom, legalTo]) => legalFrom === from && legalTo === to)) continue
            illegalPairs.push([from, to])
          }
        }
        expect(illegalPairs.length).toBe(25 - LEGAL_PAIRS.length)
        for (const [from, to] of illegalPairs) {
          await expect(
            transitionAttendanceCalculationRolloutV1(transactionClient(client), {
              orgId: crypto.randomUUID(), actorId, correlationId: crypto.randomUUID(),
              engineVersion: 'w4c3a-control-test', targetState: to, expectedState: from, expectedVersion: 1,
              evidenceManifestSha256: hex64(`matrix-${from}-${to}`), evidenceReferences: baseRefs(`matrix-${from}-${to}`),
              reasonCode: 'rollout_transition',
            }),
          ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_ILLEGAL_TRANSITION' })
        }
      } finally {
        client.release()
      }
    })

    it('walks all seven legal pairs to completion on a dedicated allowlisted org', async () => {
      const walkOrg = crypto.randomUUID()
      allow(walkOrg)
      const client = await pool.connect()
      const step = async (
        target: AttendanceRolloutStateV1,
        expectedState: AttendanceRolloutStateV1,
        expectedVersion: number,
        refs = baseRefs(`${walkOrg}-${expectedVersion}`),
      ) =>
        transitionAttendanceCalculationRolloutV1(transactionClient(client), {
          orgId: walkOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: target, expectedState, expectedVersion,
          evidenceManifestSha256: hex64(`walk-${walkOrg}-${expectedVersion}`), evidenceReferences: refs,
          reasonCode: 'rollout_transition',
        })
      try {
        await expect(step('shadow', 'legacy', 1)).resolves.toMatchObject({ state: 'shadow' })
        await expect(step('eligible', 'shadow', 2)).resolves.toMatchObject({ state: 'eligible' })
        await expect(step('shadow', 'eligible', 3)).resolves.toMatchObject({ state: 'shadow' })
        await expect(step('legacy', 'shadow', 4)).resolves.toMatchObject({ state: 'legacy' })
        await expect(step('shadow', 'legacy', 5)).resolves.toMatchObject({ state: 'shadow' })
        await expect(step('eligible', 'shadow', 6)).resolves.toMatchObject({ state: 'eligible' })
        await expect(step('authoritative', 'eligible', 7)).resolves.toMatchObject({ state: 'authoritative' })
        await expect(step('suspended', 'authoritative', 8)).resolves.toMatchObject({ state: 'suspended' })
        await expect(
          step('authoritative', 'suspended', 9, resumeRefs(`${walkOrg}-9`)),
        ).resolves.toMatchObject({ state: 'authoritative' })
        await expect(pool.query(
          `SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1`,
          [walkOrg],
        )).resolves.toMatchObject({ rows: [{ state: 'authoritative', version: 10 }] })
        await expect(pool.query(
          `SELECT count(*)::int AS n FROM attendance_calculation_rollout_events WHERE org_id = $1`,
          [walkOrg],
        )).resolves.toMatchObject({ rows: [{ n: 9 }] })
      } finally {
        client.release()
      }
    })
  })

  describe('allowlist-gated row creation (completion gate 3)', () => {
    it('refuses a non-allowlisted org and creates zero rollout-state row', async () => {
      const strangerOrg = crypto.randomUUID()
      const client = await pool.connect()
      try {
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: strangerOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
            evidenceManifestSha256: hex64('stranger'), evidenceReferences: baseRefs('stranger'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_ORG_NOT_ALLOWLISTED' })
        await expect(pool.query(
          'SELECT count(*)::int AS n FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [strangerOrg],
        )).resolves.toMatchObject({ rows: [{ n: 0 }] })
      } finally {
        client.release()
      }
    })

    it('refuses to bootstrap a missing row for a non-legacy-to-shadow claimed pair, even when allowlisted', async () => {
      const freshOrg = crypto.randomUUID()
      allow(freshOrg)
      const client = await pool.connect()
      try {
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: freshOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'eligible', expectedState: 'shadow', expectedVersion: 1,
            evidenceManifestSha256: hex64('fresh-non-bootstrap'), evidenceReferences: baseRefs('fnb'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_STATE_MISSING' })
        await expect(pool.query(
          'SELECT count(*)::int AS n FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [freshOrg],
        )).resolves.toMatchObject({ rows: [{ n: 0 }] })
      } finally {
        client.release()
      }
    })
  })

  describe('expected-state/version staleness — real two-connection TOCTOU race (completion gate 4, gate 6)', () => {
    it('rejects a transition whose caller-supplied preflight went stale under a concurrent committed transition', async () => {
      const raceOrg = crypto.randomUUID()
      allow(raceOrg)
      // Bring the org to shadow/version=2 BEFORE the race (sequential setup, not part of the race).
      const setupClient = await pool.connect()
      try {
        await transitionAttendanceCalculationRolloutV1(transactionClient(setupClient), {
          orgId: raceOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
          evidenceManifestSha256: hex64('race-setup'), evidenceReferences: baseRefs('race-setup'),
          reasonCode: 'rollout_transition',
        })
      } finally {
        setupClient.release()
      }
      // Simulate an external read-only preflight: a plain, lock-free read of state/version.
      const preflight = await pool.query(
        'SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1',
        [raceOrg],
      )
      expect(preflight.rows[0]).toMatchObject({ state: 'shadow', version: 2 })

      const entered = deferred()
      const release = deferred()
      __setW4C3aRolloutControlAfterExclusiveLockForTests(async (kind) => {
        if (kind === 'transition') {
          entered.resolve()
          await release.promise
        }
      })
      const winnerClient = await pool.connect()
      const staleClient = await pool.connect()
      try {
        // Connection B (winner) races in FIRST, pauses right after the exclusive lock.
        const winner = transitionAttendanceCalculationRolloutV1(transactionClient(winnerClient), {
          orgId: raceOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'eligible', expectedState: 'shadow', expectedVersion: 2,
          evidenceManifestSha256: hex64('race-winner'), evidenceReferences: baseRefs('race-winner'),
          reasonCode: 'rollout_transition',
        })
        await entered.promise

        // Connection A (stale) attempts its OWN transition using the preflight snapshot. It must
        // genuinely block on the SAME exclusive advisory lock B is holding — not settle early.
        let staleSettled = false
        const stale = transitionAttendanceCalculationRolloutV1(transactionClient(staleClient), {
          orgId: raceOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'legacy', expectedState: preflight.rows[0].state, expectedVersion: preflight.rows[0].version,
          evidenceManifestSha256: hex64('race-stale'), evidenceReferences: baseRefs('race-stale'),
          reasonCode: 'rollout_transition',
        }).finally(() => { staleSettled = true })
        await new Promise((resolve) => setTimeout(resolve, 75))
        expect(staleSettled).toBe(false)

        // B commits first (shadow/2 -> eligible/3).
        release.resolve()
        await expect(winner).resolves.toEqual<AttendanceW4C3aRolloutControlResultV1>({ orgId: raceOrg, state: 'eligible', batchId: null })

        // A, now able to acquire the lock, re-reads under lock and finds its belief stale.
        await expect(stale).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_STALE_EXPECTED_STATE' })
        await expect(pool.query(
          'SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [raceOrg],
        )).resolves.toMatchObject({ rows: [{ state: 'eligible', version: 3 }] })
        // 2 events: the sequential setup (legacy->shadow) + the winner (shadow->eligible). The
        // stale attempt inserted zero rows.
        await expect(pool.query(
          'SELECT count(*)::int AS n FROM attendance_calculation_rollout_events WHERE org_id = $1',
          [raceOrg],
        )).resolves.toMatchObject({ rows: [{ n: 2 }] })
      } finally {
        __setW4C3aRolloutControlAfterExclusiveLockForTests(null)
        winnerClient.release()
        staleClient.release()
      }
    })
  })

  describe('retryable job posture predicate — real two-connection race (gate 5, gate 6)', () => {
    it('rejects when a retryable V1 job is frozen at a different posture than the pair requires', async () => {
      const jobOrg = crypto.randomUUID()
      allow(jobOrg)
      await insertRetryableJob(jobOrg, 'queued', 'authoritative') // pair requires "shadow"
      const client = await pool.connect()
      try {
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: jobOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
            evidenceManifestSha256: hex64('job-mismatch'), evidenceReferences: baseRefs('job-mismatch'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_RETRYABLE_JOB_POSTURE_MISMATCH' })
        await expect(pool.query(
          'SELECT count(*)::int AS n FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [jobOrg],
        )).resolves.toMatchObject({ rows: [{ n: 0 }] })
      } finally {
        client.release()
      }
    })

    it('blocks a legitimate shared-lock job-writer for the whole duration of an in-flight transition', async () => {
      // A genuine "job appears mid-wait, transition sees it" race is architecturally
      // unconstructable: w4_accepted_write_posture is immutable post-insert (rules out an
      // UPDATE-based race), and PostgreSQL's `SELECT ... FOR UPDATE` under SERIALIZABLE only
      // re-fetches the LATEST version of rows already present in the transaction's snapshot —
      // it does not retroactively admit a brand-new row inserted after that snapshot was taken,
      // lock or no lock (verified empirically: pausing the transition — via the barrier hook or
      // via genuine third-party lock contention — before a concurrent INSERT does not make that
      // INSERT visible to the paused transaction's own read).
      //
      // This is not a gap in the predicate: lock section 9 requires every legitimate job-writer
      // (P07 enqueue and friends) to acquire the class-00 rollout lock SHARED before writing a
      // job row. Because `transitionAttendanceCalculationRolloutV1` holds that same lock
      // EXCLUSIVE for its whole duration, a legitimate writer cannot insert a job for this org at
      // all while a transition is in flight — there is no window for such a race to occur. What
      // this test proves instead is that exact serialization: a shared-lock acquisition (the
      // same primitive every job-writer calls first) genuinely blocks until the transition
      // commits.
      const raceOrg = crypto.randomUUID()
      allow(raceOrg)
      const entered = deferred()
      const release = deferred()
      __setW4C3aRolloutControlAfterExclusiveLockForTests(async (kind) => {
        if (kind === 'transition') {
          entered.resolve()
          await release.promise
        }
      })
      const transitionClient = await pool.connect()
      const writerClient = await pool.connect()
      try {
        const transition = transitionAttendanceCalculationRolloutV1(transactionClient(transitionClient), {
          orgId: raceOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
          evidenceManifestSha256: hex64('job-writer-race'), evidenceReferences: baseRefs('job-writer-race'),
          reasonCode: 'rollout_transition',
        })
        await entered.promise

        let writerSettled = false
        await writerClient.query('BEGIN')
        const writer = acquireAttendanceCalculationRolloutLock(
          transactionClient(writerClient),
          parseCanonicalAttendanceRolloutOrgKeyV1(raceOrg),
          'shared',
        ).finally(() => { writerSettled = true })
        await new Promise((resolve) => setTimeout(resolve, 75))
        expect(writerSettled).toBe(false) // genuinely blocked behind the transition's exclusive hold

        release.resolve()
        await expect(transition).resolves.toMatchObject({ state: 'shadow' })
        await writer // now unblocks — the transition committed and released the exclusive lock
        await writerClient.query('COMMIT')
      } finally {
        __setW4C3aRolloutControlAfterExclusiveLockForTests(null)
        await writerClient.query('ROLLBACK').catch(() => undefined)
        transitionClient.release()
        writerClient.release()
      }
    })
  })

  describe('nonterminal null-version legacy job predicate (gate 5)', () => {
    it('blocks entry into shadow while a nonterminal legacy job is active', async () => {
      const legacyJobOrg = crypto.randomUUID()
      allow(legacyJobOrg)
      await insertNullVersionLegacyJob(legacyJobOrg, 'running')
      const client = await pool.connect()
      try {
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: legacyJobOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
            evidenceManifestSha256: hex64('legacy-job'), evidenceReferences: baseRefs('legacy-job'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_LEGACY_JOB_ACTIVE' })
        await expect(pool.query(
          'SELECT count(*)::int AS n FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [legacyJobOrg],
        )).resolves.toMatchObject({ rows: [{ n: 0 }] })
      } finally {
        client.release()
      }
    })
  })

  describe('org-wide incomplete operation predicate (gate 5)', () => {
    it('blocks entry into eligible while a V1 job for the org is still running (not completed)', async () => {
      const opOrg = crypto.randomUUID()
      allow(opOrg)
      await insertIncompleteV1Job(opOrg, 'running')
      const client = await pool.connect()
      try {
        await transitionAttendanceCalculationRolloutV1(transactionClient(client), {
          orgId: opOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
          evidenceManifestSha256: hex64('op-setup'), evidenceReferences: baseRefs('op-setup'),
          reasonCode: 'rollout_transition',
        })
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: opOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'eligible', expectedState: 'shadow', expectedVersion: 2,
            evidenceManifestSha256: hex64('op-blocked'), evidenceReferences: baseRefs('op-blocked'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_INCOMPLETE_OPERATION' })
        await expect(pool.query(
          'SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [opOrg],
        )).resolves.toMatchObject({ rows: [{ state: 'shadow', version: 2 }] })
      } finally {
        client.release()
      }
    })
  })

  describe('unresolved legacy_time_ingress_not_authoritative review predicate (gate 5)', () => {
    it('blocks entry into eligible while an unresolved review remains the latest calculation', async () => {
      const reviewOrg = crypto.randomUUID()
      allow(reviewOrg)
      await insertUnresolvedReview(reviewOrg)
      const client = await pool.connect()
      try {
        await transitionAttendanceCalculationRolloutV1(transactionClient(client), {
          orgId: reviewOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
          evidenceManifestSha256: hex64('review-setup'), evidenceReferences: baseRefs('review-setup'),
          reasonCode: 'rollout_transition',
        })
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: reviewOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'eligible', expectedState: 'shadow', expectedVersion: 2,
            evidenceManifestSha256: hex64('review-blocked'), evidenceReferences: baseRefs('review-blocked'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_UNRESOLVED_REVIEW' })
        await expect(pool.query(
          'SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [reviewOrg],
        )).resolves.toMatchObject({ rows: [{ state: 'shadow', version: 2 }] })
      } finally {
        client.release()
      }
    })
  })

  describe('defective pending request-snapshot predicate (gate 5)', () => {
    it('blocks entry into eligible when a pending calculation-affecting request has no snapshot', async () => {
      const reqOrg = crypto.randomUUID()
      allow(reqOrg)
      await insertPendingRequest(reqOrg, 'missing_snapshot')
      const client = await pool.connect()
      try {
        await transitionAttendanceCalculationRolloutV1(transactionClient(client), {
          orgId: reqOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
          evidenceManifestSha256: hex64('req-missing-setup'), evidenceReferences: baseRefs('req-missing-setup'),
          reasonCode: 'rollout_transition',
        })
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: reqOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'eligible', expectedState: 'shadow', expectedVersion: 2,
            evidenceManifestSha256: hex64('req-missing-blocked'), evidenceReferences: baseRefs('req-missing-blocked'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_REQUEST_SNAPSHOT_DEFECTIVE' })
      } finally {
        client.release()
      }
    })

    it('blocks entry into eligible when the latest snapshot is unsupported', async () => {
      const reqOrg = crypto.randomUUID()
      allow(reqOrg)
      await insertPendingRequest(reqOrg, 'unsupported_snapshot')
      const client = await pool.connect()
      try {
        await transitionAttendanceCalculationRolloutV1(transactionClient(client), {
          orgId: reqOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
          evidenceManifestSha256: hex64('req-unsupported-setup'), evidenceReferences: baseRefs('req-unsupported-setup'),
          reasonCode: 'rollout_transition',
        })
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: reqOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'eligible', expectedState: 'shadow', expectedVersion: 2,
            evidenceManifestSha256: hex64('req-unsupported-blocked'), evidenceReferences: baseRefs('req-unsupported-blocked'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_REQUEST_SNAPSHOT_DEFECTIVE' })
      } finally {
        client.release()
      }
    })
  })

  describe('evidence manifest + reference validation (gate 8)', () => {
    it('rejects a non-hex64 manifest with zero DML', async () => {
      const evOrg = crypto.randomUUID()
      allow(evOrg)
      const client = await pool.connect()
      try {
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: evOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
            evidenceManifestSha256: 'not-a-real-hash', evidenceReferences: baseRefs('bad-hash'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_MANIFEST_INVALID' })
        await expect(pool.query(
          'SELECT count(*)::int AS n FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [evOrg],
        )).resolves.toMatchObject({ rows: [{ n: 0 }] })
      } finally {
        client.release()
      }
    })

    it('rejects an unexpected evidence-reference key set (extra key)', async () => {
      const evOrg = crypto.randomUUID()
      allow(evOrg)
      const client = await pool.connect()
      try {
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: evOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
            evidenceManifestSha256: hex64('extra-key'),
            evidenceReferences: { ...baseRefs('extra-key'), extra: 'nope' } as unknown as EvidenceReferencesV1,
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_EVIDENCE_REFERENCE_INVALID' })
      } finally {
        client.release()
      }
    })

    it('rejects a resume pair missing the incident/replay reference keys', async () => {
      const evOrg = crypto.randomUUID()
      allow(evOrg)
      const client = await pool.connect()
      try {
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: evOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'authoritative', expectedState: 'suspended', expectedVersion: 1,
            evidenceManifestSha256: hex64('resume-missing-refs'), evidenceReferences: baseRefs('resume-missing-refs'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_EVIDENCE_REFERENCE_INVALID' })
      } finally {
        client.release()
      }
    })

    it('rejects a raw-payload-shaped reference value (secret/JSON injection attempt)', async () => {
      const evOrg = crypto.randomUUID()
      allow(evOrg)
      const client = await pool.connect()
      try {
        const poisoned = { ...baseRefs('poison'), imageSha: '{"secret":"leak"}' } as unknown as EvidenceReferencesV1
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: evOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
            evidenceManifestSha256: hex64('poison'), evidenceReferences: poisoned,
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_EVIDENCE_REFERENCE_INVALID' })
      } finally {
        client.release()
      }
    })

    it('stores exactly manifest hash, correlation ID, precondition counts, and references on success', async () => {
      const evOrg = crypto.randomUUID()
      allow(evOrg)
      const correlationId = crypto.randomUUID()
      const client = await pool.connect()
      try {
        await transitionAttendanceCalculationRolloutV1(transactionClient(client), {
          orgId: evOrg, actorId, correlationId, engineVersion: 'w4c3a-control-test',
          targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
          evidenceManifestSha256: hex64('event-shape'), evidenceReferences: baseRefs('event-shape'),
          reasonCode: 'rollout_transition',
        })
        const result = await pool.query(
          `SELECT prior_state AS "priorState", new_state AS "newState", evidence
             FROM attendance_calculation_rollout_events WHERE org_id = $1`,
          [evOrg],
        )
        expect(result.rows).toHaveLength(1)
        expect(result.rows[0].priorState).toBe('legacy')
        expect(result.rows[0].newState).toBe('shadow')
        expect(result.rows[0].evidence).toEqual({
          schemaVersion: 1,
          manifestSha256: hex64('event-shape'),
          correlationId,
          comparisonWritePosture: 'shadow',
          preconditionCounts: {
            retryableJobPostureMismatches: 0,
            nonterminalLegacyJobs: 0,
            incompleteOperations: 0,
            unresolvedReviews: 0,
            defectiveRequestSnapshots: 0,
          },
          references: baseRefs('event-shape'),
        })
      } finally {
        client.release()
      }
    })
  })

  describe('atomicity between state UPDATE and event INSERT (completion gate 7)', () => {
    it('leaves state/version unchanged and inserts no event when the event insert fails', async () => {
      const atomicOrg = crypto.randomUUID()
      allow(atomicOrg)
      __setW4C3aRolloutControlBeforeEventInsertForTests(async () => {
        throw new Error('W4C3A_TEST_FORCED_EVENT_INSERT_FAILURE')
      })
      const client = await pool.connect()
      try {
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: atomicOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
            evidenceManifestSha256: hex64('atomic'), evidenceReferences: baseRefs('atomic'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toThrow('W4C3A_TEST_FORCED_EVENT_INSERT_FAILURE')
        await expect(pool.query(
          'SELECT count(*)::int AS n FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [atomicOrg],
        )).resolves.toMatchObject({ rows: [{ n: 0 }] })
        await expect(pool.query(
          'SELECT count(*)::int AS n FROM attendance_calculation_rollout_events WHERE org_id = $1',
          [atomicOrg],
        )).resolves.toMatchObject({ rows: [{ n: 0 }] })
      } finally {
        __setW4C3aRolloutControlBeforeEventInsertForTests(null)
        client.release()
      }
    })
  })
})
