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
  __setW4C3aRolloutControlBeforeStateUpdateForTests,
  ATTENDANCE_REQUEST_SNAPSHOT_DEFECT_CELLS_V1,
  closeLegacyRollbackWindowV1,
  readAttendanceRequestSnapshotDefectReportV1,
  transitionAttendanceCalculationRolloutV1,
  type AttendanceRequestSnapshotDefectCellV1,
  type AttendanceRequestSnapshotDefectCountsV1,
  type AttendanceW4C3aRolloutControlResultV1,
  type EvidenceReferencesV1,
} from '../../src/attendance/w4c3a-rollout-control'
import {
  acquireAttendanceCalculationRolloutLock,
  ATTENDANCE_ROLLOUT_STATES_V1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  type AttendanceRolloutStateV1,
  type AttendanceW4TransactionClientV1,
} from '../../src/attendance/w4c0-identity'
import {
  buildAttendanceRequestCalculationPayloadFromRequestRowV1,
  computeAttendanceRequestPayloadFingerprintV1,
} from '../../src/attendance/w4c3b-request-snapshots'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const run = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

const ALLOWLIST_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const IMPORT_NS = '6f67fdaa-e2aa-48b3-b76c-c4aab9723173'

// NIT-2 (PR #4773 exact-head independent gate, 20260805): mechanical over the exported table,
// not a second hardcoded literal — a sixth rollout state would silently escape this test's
// 25-combo exhaustive sweep otherwise.
const ALL_STATES: readonly AttendanceRolloutStateV1[] = ATTENDANCE_ROLLOUT_STATES_V1
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
      request_type varchar(30) NOT NULL, status varchar(20) NOT NULL DEFAULT 'pending', org_id text NOT NULL,
      requested_in_at timestamptz, requested_out_at timestamptz, reason text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb, approval_instance_id text
    )`)
  // W4C-5 §3 (issue #4775): the reversal-incomplete cell reads the request's linked approval
  // instance. Minimal shape matching `20250924105000_create_approval_tables.ts` (`id text PRIMARY
  // KEY, status text NOT NULL, version integer`) — the rollout-control predicate reads only `id`
  // and `status`.
  await pool.query(`
    CREATE TABLE approval_instances (
      id text PRIMARY KEY, status text NOT NULL, version integer NOT NULL DEFAULT 0
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

  /**
   * Minimal valid V1 retryable job (see attendance-w4c0-durable-storage-smoke fixture shape).
   * `executor` defaults to the shared pool (autocommit) but accepts an open `PoolClient`
   * transaction so RACE A/C below can insert the defect row UNCOMMITTED, inside a
   * shared-lock-holding writer transaction, and control exactly when it becomes visible.
   */
  /** Returns the generated `batchCommandId` (== `w4_batch_command_id`) so callers needing to
   * construct a matching `attendance_result_operations` row (P2-4's "with operation rows" leg)
   * can reference the exact same batch. */
  async function insertRetryableJob(
    org: string,
    status: 'queued' | 'failed',
    acceptedWritePosture: 'legacy_projection_only' | 'shadow' | 'authoritative',
    executor: Pool | PoolClient = pool,
  ): Promise<string> {
    const batchCommandId = crypto.randomUUID()
    const fp = hex64(`${org}:${batchCommandId}`)
    await executor.query(
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
    return batchCommandId
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

  /** `executor` defaults to the shared pool (autocommit); RACE D below passes an open writer transaction. */
  async function insertUnresolvedReview(org: string, executor: Pool | PoolClient = pool): Promise<void> {
    const recordId = crypto.randomUUID()
    await executor.query(
      `INSERT INTO attendance_records (id, user_id, work_date, org_id) VALUES ($1::uuid, $2, '2026-08-01', $3)`,
      [recordId, crypto.randomUUID(), org],
    )
    await executor.query(
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

  /**
   * `'unsupported_snapshot'` was retired (W4C-5 §3, issue #4775): its arbitrary `hex64(...)`
   * fingerprint isn't congruent with the live row, so under the new payload-stale check it would
   * ALSO trip `pendingPayloadStale`, defeating the exclusivity a mutation test needs (see the
   * "unsupported" describe block below, now built on `insertRequestSnapshotFixture` instead). Only
   * `'missing_snapshot'` remains — no live-row/snapshot payload comparison ever runs when the
   * snapshot itself is absent, so that kind was never affected.
   */
  async function insertPendingRequest(org: string, kind: 'missing_snapshot'): Promise<void> {
    void kind
    const requestId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO attendance_requests (id, user_id, work_date, request_type, status, org_id)
       VALUES ($1::uuid, $2, '2026-08-01', 'time_correction', 'pending', $3)`,
      [requestId, crypto.randomUUID(), org],
    )
  }

  /**
   * W4C-5 §3 (issue #4775): fixture builder for the full 2x4 = 8-cell closed request-snapshot
   * defect set. `bucket` selects `status='pending'` (any calc-affecting type) or `status='approved'
   * AND request_type='leave'` — the only combination the plugin's shared cancel adapter treats as
   * reversible (`plugins/plugin-attendance/index.cjs:34091`/`:34174`).
   *
   * Each `kind` is built to be EXCLUSIVE — it trips exactly the one cell it names and none of the
   * other three defect kinds for the same request — so a mutation that deletes one classification
   * branch in production code can be told apart from another by which cell's counter moves.
   */
  const LIVE_ROW_REASON = 'fixture-reason'
  const STALE_SNAPSHOT_REASON = 'fixture-reason-mismatch'

  function fixtureLivePayloadFingerprint(): string {
    const payload = buildAttendanceRequestCalculationPayloadFromRequestRowV1({
      workDate: '2026-08-01',
      requestedInAt: null,
      requestedOutAt: null,
      reason: LIVE_ROW_REASON,
    })
    return computeAttendanceRequestPayloadFingerprintV1(payload)
  }

  function fixtureStaleSnapshotFingerprint(): string {
    const payload = buildAttendanceRequestCalculationPayloadFromRequestRowV1({
      workDate: '2026-08-01',
      requestedInAt: null,
      requestedOutAt: null,
      reason: STALE_SNAPSHOT_REASON,
    })
    return computeAttendanceRequestPayloadFingerprintV1(payload)
  }

  type RequestSnapshotFixtureBucket = 'pending' | 'reversible'
  type RequestSnapshotFixtureKind =
    | 'missing'
    | 'unsupported'
    | 'payload_stale'
    | 'reversal_incomplete'

  async function insertRequestSnapshotFixture(
    org: string,
    bucket: RequestSnapshotFixtureBucket,
    kind: RequestSnapshotFixtureKind,
    executor: Pool | PoolClient = pool,
  ): Promise<{ requestId: string; approvalInstanceId: string }> {
    const requestId = crypto.randomUUID()
    const requestType = bucket === 'reversible' ? 'leave' : 'time_correction'
    const status = bucket === 'reversible' ? 'approved' : 'pending'
    const approvalInstanceId = `appr-${requestId}`
    const approvalStatus = kind === 'reversal_incomplete' ? 'cancelled' : 'pending'
    await executor.query(
      `INSERT INTO attendance_requests
         (id, user_id, work_date, request_type, status, org_id, requested_in_at, requested_out_at,
          reason, metadata, approval_instance_id)
       VALUES ($1::uuid, $2, '2026-08-01', $3, $4, $5, NULL, NULL, $6, '{}'::jsonb, $7)`,
      [requestId, crypto.randomUUID(), requestType, status, org, LIVE_ROW_REASON, approvalInstanceId],
    )
    await executor.query(
      `INSERT INTO approval_instances (id, status, version) VALUES ($1, $2, 1)`,
      [approvalInstanceId, approvalStatus],
    )
    if (kind !== 'missing') {
      const posture = kind === 'unsupported' ? 'unsupported' : 'resolved_v2'
      const attributionSnapshot =
        posture === 'unsupported'
          ? '{"posture":"unsupported","sourceSchemaVersion":null,"reason":"missing","sourceFingerprint":null}'
          : '{"posture":"resolved_v2"}'
      const payloadFingerprint =
        kind === 'payload_stale' ? fixtureStaleSnapshotFingerprint() : fixtureLivePayloadFingerprint()
      const payloadReason = kind === 'payload_stale' ? STALE_SNAPSHOT_REASON : LIVE_ROW_REASON
      await executor.query(
        `INSERT INTO attendance_request_calculation_snapshots (
           org_id, request_id, version, request_type, subject_user_id, payload, payload_fingerprint,
           attribution_snapshot, created_by)
         VALUES ($1, $2::uuid, 1, $3, $4, $5::jsonb, $6, $7::jsonb, $8)`,
        [
          org,
          requestId,
          requestType,
          crypto.randomUUID(),
          JSON.stringify({
            schemaVersion: 1,
            workDate: '2026-08-01',
            requestedInAt: null,
            requestedOutAt: null,
            reason: payloadReason,
            minutes: null,
            leaveTypeCode: null,
            outdoorPunch: null,
          }),
          payloadFingerprint,
          attributionSnapshot,
          actorId,
        ],
      )
    }
    return { requestId, approvalInstanceId }
  }

  function emptyDefectCounts(): Record<AttendanceRequestSnapshotDefectCellV1, number> {
    const out = {} as Record<AttendanceRequestSnapshotDefectCellV1, number>
    for (const cell of ATTENDANCE_REQUEST_SNAPSHOT_DEFECT_CELLS_V1) out[cell] = 0
    return out
  }

  function expectSingleCellDefect(
    report: AttendanceRequestSnapshotDefectCountsV1,
    cell: AttendanceRequestSnapshotDefectCellV1,
  ): void {
    const expected = emptyDefectCounts()
    expected[cell] = 1
    expect(report).toEqual(expected)
  }

  /**
   * Inserts a durable `attendance_result_operation_batches` + `attendance_result_operations`
   * row pair for `entrypoint = 'import_batch'` at the given `batchCommandId` — the exact
   * `w4_batch_command_id` a retryable V1 import job (`insertRetryableJob`'s return value)
   * carries. Used by the P2-4 "resume with operation rows" negative leg below. Follows the same
   * claimed-then-terminal-before-COMMIT shape as the pre-existing "refuses closure when an
   * integration batch owns..." fixture above (OPERATION_STATES only ever durably persists
   * `completed`/`canceled` — a deferred commit-time trigger forbids a persisted `claimed` row).
   */
  async function insertOperationRowForImportBatch(org: string, batchCommandId: string): Promise<void> {
    const registryClient = await pool.connect()
    try {
      await registryClient.query('BEGIN')
      await registryClient.query(
        `INSERT INTO attendance_result_operation_batches (
           org_id, entrypoint, batch_command_id, identity_source_kind, source_root_id,
           source_ref, actor_id, actor_posture, capability,
           subject_scope, accepted_write_posture, command_fingerprint, item_count,
           item_sequence_fingerprint, item_set_fingerprint, state)
         VALUES ($1, 'import_batch', $2::uuid, 'import_batch', $2::uuid,
           'test:w4c3a-control-resume-op', $3, 'attendance_admin', 'import',
           $4::jsonb, 'authoritative', $5, 1, $6, $7, 'claimed')`,
        [
          org,
          batchCommandId,
          actorId,
          JSON.stringify({ kind: 'explicit_users', userIds: [] }),
          hex64(`${org}:${batchCommandId}:cmd`),
          hex64(`${org}:${batchCommandId}:seq`),
          hex64(`${org}:${batchCommandId}:set`),
        ],
      )
      await registryClient.query(
        `INSERT INTO attendance_result_operations (
           org_id, entrypoint, operation_id, batch_command_id, input_ordinal,
           identity_source_kind, source_root_id, proof_semantic_fingerprint,
           source_ref, actor_id, actor_posture, capability,
           subject_scope, command_fingerprint, accepted_write_posture,
           normalized_business_input_snapshot, state)
         VALUES ($1, 'import_batch', attendance_w4_uuidv5(
             $7::uuid,
             attendance_w4_item_name_bytes($2::uuid, 0, $3)),
           $2::uuid, 0, 'import_item', $2::uuid, $3,
           'test:w4c3a-control-resume-op', $4, 'attendance_admin', 'import',
           $5::jsonb, $6, 'authoritative', '{}'::jsonb, 'claimed')`,
        [
          org,
          batchCommandId,
          hex64(`${org}:${batchCommandId}:semantic`),
          actorId,
          JSON.stringify({ kind: 'explicit_users', userIds: [] }),
          hex64(`${org}:${batchCommandId}:cmd`),
          IMPORT_NS,
        ],
      )
      await registryClient.query(
        `UPDATE attendance_result_operations
            SET state = 'canceled', updated_at = now(), version = version + 1
          WHERE org_id = $1 AND entrypoint = 'import_batch' AND batch_command_id = $2::uuid`,
        [org, batchCommandId],
      )
      await registryClient.query(
        `UPDATE attendance_result_operation_batches
            SET state = 'canceled', updated_at = now(), version = version + 1
          WHERE org_id = $1 AND entrypoint = 'import_batch' AND batch_command_id = $2::uuid`,
        [org, batchCommandId],
      )
      await registryClient.query('COMMIT')
    } catch (error) {
      await registryClient.query('ROLLBACK')
      throw error
    } finally {
      registryClient.release()
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
    __setW4C3aRolloutControlBeforeStateUpdateForTests(null)
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

    it('rejects a same-state-name preflight whose version went stale by round-tripping through another state (P2-1, PR #4773 gate)', async () => {
      // PR #4773's exact-head independent gate (P2-1) found the version half of
      // `persisted.state !== input.expectedState || persisted.version !== input.expectedVersion`
      // (w4c3a-rollout-control.ts) was untested: every existing staleness test changes the state
      // NAME, so deleting `|| persisted.version !== input.expectedVersion` still passed all 23
      // tests. It guards a real case this test constructs directly: shadow (v2) -> eligible (v3)
      // -> shadow (v4). An operator preflight taken at shadow/v2 must NOT be accepted at
      // shadow/v4 just because the STATE NAME happens to match again — the org visibly
      // round-tripped through eligible in between, and the preflight's belief about section 3
      // predicates at that moment is stale.
      const roundTripOrg = crypto.randomUUID()
      allow(roundTripOrg)
      const client = await pool.connect()
      try {
        await transitionAttendanceCalculationRolloutV1(transactionClient(client), {
          orgId: roundTripOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
          evidenceManifestSha256: hex64('round-trip-1'), evidenceReferences: baseRefs('round-trip-1'),
          reasonCode: 'rollout_transition',
        })
        // Preflight taken here believes shadow/version=2 — true at this instant.
        const preflight = await pool.query(
          'SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [roundTripOrg],
        )
        expect(preflight.rows[0]).toMatchObject({ state: 'shadow', version: 2 })

        await transitionAttendanceCalculationRolloutV1(transactionClient(client), {
          orgId: roundTripOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'eligible', expectedState: 'shadow', expectedVersion: 2,
          evidenceManifestSha256: hex64('round-trip-2'), evidenceReferences: baseRefs('round-trip-2'),
          reasonCode: 'rollout_transition',
        })
        await transitionAttendanceCalculationRolloutV1(transactionClient(client), {
          orgId: roundTripOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'shadow', expectedState: 'eligible', expectedVersion: 3,
          evidenceManifestSha256: hex64('round-trip-3'), evidenceReferences: baseRefs('round-trip-3'),
          reasonCode: 'rollout_transition',
        })
        // Current state is now shadow/version=4 — the NAME matches the stale preflight, the
        // VERSION does not.
        await expect(pool.query(
          'SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [roundTripOrg],
        )).resolves.toMatchObject({ rows: [{ state: 'shadow', version: 4 }] })

        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: roundTripOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'legacy', expectedState: preflight.rows[0].state, expectedVersion: preflight.rows[0].version,
            evidenceManifestSha256: hex64('round-trip-stale'), evidenceReferences: baseRefs('round-trip-stale'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_STALE_EXPECTED_STATE' })
        // Zero DML from the rejected attempt: state/version unchanged, event count unchanged (3:
        // the three sequential setup transitions above).
        await expect(pool.query(
          'SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [roundTripOrg],
        )).resolves.toMatchObject({ rows: [{ state: 'shadow', version: 4 }] })
        await expect(pool.query(
          'SELECT count(*)::int AS n FROM attendance_calculation_rollout_events WHERE org_id = $1',
          [roundTripOrg],
        )).resolves.toMatchObject({ rows: [{ n: 3 }] })
      } finally {
        client.release()
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
      // RETRACTION (W4C-5 P1-2, PR #4773 exact-head independent gate, 20260805): this test's
      // comment previously claimed a "job appears mid-wait, transition sees it" race was
      // "architecturally unconstructable" and that "there is no window for such a race to
      // occur." Both claims were false, and were refuted by four constructed real
      // two/three-connection races (RACE A/C/D/E, see the `describe` block immediately below
      // this one): the window is not the exclusive lock's HOLD (which this test correctly
      // proves is exclusive and serializing) but its WAIT, up to
      // `W4_ADVISORY_HELPER_WAIT_MS` = 5000ms — before the W4C-5 P1-2 fix, a writer that
      // committed its INSERT while the transition was still waiting to acquire the (then
      // transaction-scoped) exclusive lock was invisible to every §3 predicate, because
      // PostgreSQL fixes a SERIALIZABLE snapshot at the START of the first statement in the
      // transaction — including a statement that itself blocks — so the snapshot predated the
      // wait's resolution, not just the transaction's own BEGIN.
      //
      // This test still correctly proves exact serialization (a shared-lock acquisition — the
      // same primitive every job-writer calls first, lock section 9 — genuinely blocks for the
      // whole duration the transition holds the lock). What it does NOT prove, and what it was
      // wrongly assumed to prove, is that the predicates re-evaluated after that hold begins
      // see a fresh-enough snapshot. That is proven separately, and positively, by the
      // `describe` block immediately below.
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

  describe('W4C-5 P1-2: lock-WAIT races — a defect committed by a legitimate shared-lock writer WHILE the transition is genuinely blocked waiting for the exclusive lock is still caught', () => {
    // PR #4773 exact-head independent gate (20260805) constructed these as RACE A/C/D/E against
    // the pre-fix code (each false-PASSED: `RESOLVED` with the defect left uncaught in the DB)
    // and refuted the PR body's "architecturally unconstructable / no window" claim. They are
    // real two/three-connection races: every leg first proves genuine blocking
    // (`settled === false` after 150ms) before letting the writer commit, exactly like the
    // pre-existing TOCTOU staleness race and shared-lock-writer tests above. No barrier hook on
    // any contended leg — timing is real, not simulated.

    it('RACE A: a mismatched retryable job committed by a shared-lock holder DURING the exclusive wait is caught (not missed)', async () => {
      const raceOrg = crypto.randomUUID()
      allow(raceOrg)
      const writerClient = await pool.connect()
      const transitionClient = await pool.connect()
      try {
        await writerClient.query('BEGIN')
        await acquireAttendanceCalculationRolloutLock(
          transactionClient(writerClient),
          parseCanonicalAttendanceRolloutOrgKeyV1(raceOrg),
          'shared',
        )

        let transitionSettled = false
        const transition = transitionAttendanceCalculationRolloutV1(transactionClient(transitionClient), {
          orgId: raceOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
          evidenceManifestSha256: hex64('race-a-transition'), evidenceReferences: baseRefs('race-a-transition'),
          reasonCode: 'rollout_transition',
        }).finally(() => { transitionSettled = true })
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect(transitionSettled).toBe(false) // genuinely blocked behind the writer's shared hold

        // Committed WHILE the transition is still waiting — posture 'authoritative' mismatches
        // the legacy->shadow pair's required 'shadow'.
        await insertRetryableJob(raceOrg, 'queued', 'authoritative', writerClient)
        await writerClient.query('COMMIT')

        await expect(transition).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_RETRYABLE_JOB_POSTURE_MISMATCH' })
        expect(transitionSettled).toBe(true)
        await expect(pool.query(
          'SELECT count(*)::int AS n FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [raceOrg],
        )).resolves.toMatchObject({ rows: [{ n: 0 }] })
      } finally {
        await writerClient.query('ROLLBACK').catch(() => undefined)
        writerClient.release()
        transitionClient.release()
      }
    })

    it('RACE C: an incomplete V1 job committed by a shared-lock holder DURING the exclusive wait blocks promotion to eligible', async () => {
      const raceOrg = crypto.randomUUID()
      allow(raceOrg)
      const setupClient = await pool.connect()
      try {
        await transitionAttendanceCalculationRolloutV1(transactionClient(setupClient), {
          orgId: raceOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
          evidenceManifestSha256: hex64('race-c-setup'), evidenceReferences: baseRefs('race-c-setup'),
          reasonCode: 'rollout_transition',
        })
      } finally {
        setupClient.release()
      }

      const writerClient = await pool.connect()
      const transitionClient = await pool.connect()
      try {
        await writerClient.query('BEGIN')
        await acquireAttendanceCalculationRolloutLock(
          transactionClient(writerClient),
          parseCanonicalAttendanceRolloutOrgKeyV1(raceOrg),
          'shared',
        )

        let transitionSettled = false
        const transition = transitionAttendanceCalculationRolloutV1(transactionClient(transitionClient), {
          orgId: raceOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'eligible', expectedState: 'shadow', expectedVersion: 2,
          evidenceManifestSha256: hex64('race-c-transition'), evidenceReferences: baseRefs('race-c-transition'),
          reasonCode: 'rollout_transition',
        }).finally(() => { transitionSettled = true })
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect(transitionSettled).toBe(false)

        // Committed WHILE the transition is still waiting — a fresh 'queued' V1 job is a still-open
        // (not `completed`) org operation.
        await insertRetryableJob(raceOrg, 'queued', 'shadow', writerClient)
        await writerClient.query('COMMIT')

        await expect(transition).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_INCOMPLETE_OPERATION' })
        expect(transitionSettled).toBe(true)
        await expect(pool.query(
          'SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [raceOrg],
        )).resolves.toMatchObject({ rows: [{ state: 'shadow', version: 2 }] })
      } finally {
        await writerClient.query('ROLLBACK').catch(() => undefined)
        writerClient.release()
        transitionClient.release()
      }
    })

    it('RACE D: an unresolved ingress review committed by a shared-lock holder DURING the exclusive wait blocks promotion to eligible', async () => {
      const raceOrg = crypto.randomUUID()
      allow(raceOrg)
      const setupClient = await pool.connect()
      try {
        await transitionAttendanceCalculationRolloutV1(transactionClient(setupClient), {
          orgId: raceOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
          evidenceManifestSha256: hex64('race-d-setup'), evidenceReferences: baseRefs('race-d-setup'),
          reasonCode: 'rollout_transition',
        })
      } finally {
        setupClient.release()
      }

      const writerClient = await pool.connect()
      const transitionClient = await pool.connect()
      try {
        await writerClient.query('BEGIN')
        await acquireAttendanceCalculationRolloutLock(
          transactionClient(writerClient),
          parseCanonicalAttendanceRolloutOrgKeyV1(raceOrg),
          'shared',
        )

        let transitionSettled = false
        const transition = transitionAttendanceCalculationRolloutV1(transactionClient(transitionClient), {
          orgId: raceOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'eligible', expectedState: 'shadow', expectedVersion: 2,
          evidenceManifestSha256: hex64('race-d-transition'), evidenceReferences: baseRefs('race-d-transition'),
          reasonCode: 'rollout_transition',
        }).finally(() => { transitionSettled = true })
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect(transitionSettled).toBe(false)

        // Committed WHILE the transition is still waiting.
        await insertUnresolvedReview(raceOrg, writerClient)
        await writerClient.query('COMMIT')

        await expect(transition).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_UNRESOLVED_REVIEW' })
        expect(transitionSettled).toBe(true)
        await expect(pool.query(
          'SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [raceOrg],
        )).resolves.toMatchObject({ rows: [{ state: 'shadow', version: 2 }] })
      } finally {
        await writerClient.query('ROLLBACK').catch(() => undefined)
        writerClient.release()
        transitionClient.release()
      }
    })

    it('RACE E (3-actor, zero protocol violations): a pending request committed by an actor with NO rollout-lock obligation, while a protocol-compliant shared-lock holder blocks the transition, is still caught', async () => {
      // C1 = a protocol-compliant shared-lock holder (exactly the primitive every real job-writer
      // calls first, lock section 9) — its only role is to create a genuine, provable wait window
      // for T. C2 = an ordinary pending-request writer (the shape of
      // `plugins/plugin-attendance/index.cjs`'s request-creation route): it acquires NO rollout
      // lock and reads NO rollout state — by construction (bare `pool.query`, autocommit,
      // `insertPendingRequest`'s existing shape) it commits independently of C1/T entirely. T is
      // the transition itself. No actor here violates any locking obligation the current
      // codebase defines; the fix must still catch this.
      const raceOrg = crypto.randomUUID()
      allow(raceOrg)
      const setupClient = await pool.connect()
      try {
        await transitionAttendanceCalculationRolloutV1(transactionClient(setupClient), {
          orgId: raceOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
          evidenceManifestSha256: hex64('race-e-setup'), evidenceReferences: baseRefs('race-e-setup'),
          reasonCode: 'rollout_transition',
        })
      } finally {
        setupClient.release()
      }

      const c1Client = await pool.connect()
      const transitionClient = await pool.connect()
      try {
        await c1Client.query('BEGIN')
        await acquireAttendanceCalculationRolloutLock(
          transactionClient(c1Client),
          parseCanonicalAttendanceRolloutOrgKeyV1(raceOrg),
          'shared',
        )

        let transitionSettled = false
        const transition = transitionAttendanceCalculationRolloutV1(transactionClient(transitionClient), {
          orgId: raceOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'eligible', expectedState: 'shadow', expectedVersion: 2,
          evidenceManifestSha256: hex64('race-e-transition'), evidenceReferences: baseRefs('race-e-transition'),
          reasonCode: 'rollout_transition',
        }).finally(() => { transitionSettled = true })
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect(transitionSettled).toBe(false) // T genuinely blocked behind C1's shared hold

        // C2: commits independently, with no relationship to C1's lock or T's wait at all — a
        // plain autocommit INSERT via the shared pool, matching insertPendingRequest's existing
        // (lock-free) shape.
        await insertPendingRequest(raceOrg, 'missing_snapshot')

        // C1 releases; T can now proceed.
        await c1Client.query('COMMIT')

        await expect(transition).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_REQUEST_SNAPSHOT_DEFECTIVE' })
        expect(transitionSettled).toBe(true)
        await expect(pool.query(
          'SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [raceOrg],
        )).resolves.toMatchObject({ rows: [{ state: 'shadow', version: 2 }] })
      } finally {
        await c1Client.query('ROLLBACK').catch(() => undefined)
        c1Client.release()
        transitionClient.release()
      }
    })
  })

  describe('W4C-5 NEW-B: the session-exclusive rollout lock requires an idle connection — enforced, not just documented', () => {
    // PR #4773 exact-head independent DELTA gate (20260805) constructed this exact probe against
    // the pre-fix code: a caller that pre-opens `BEGIN ISOLATION LEVEL SERIALIZABLE; SELECT 1;`
    // on the SAME connection before calling `transitionAttendanceCalculationRolloutV1` fixes the
    // OUTER transaction's snapshot before the session-level rollout lock is ever requested —
    // silently reintroducing the exact P1-2 defect (PostgreSQL only WARNs on a nested `BEGIN`,
    // it does not error), `RESOLVED {state:'shadow'}`, no red test anywhere. Mutation-confirmed
    // (see PR mutation ledger): neutering `assertConnectionIsIdleV1` (renamed off
    // `assertConnectionIsIdleForSessionExclusiveRolloutLockV1` P2-2, PR #4839 gate, 20260809, when
    // generalized to a second caller — see w4c0-identity.ts) turns this leg from a
    // `W4C0_CONNECTION_NOT_IDLE` rejection back into a silent `RESOLVED`, reproducing the gate's
    // finding exactly.
    it('rejects a transition called on a connection that already has an open transaction', async () => {
      const idleOrg = crypto.randomUUID()
      allow(idleOrg)
      const client = await pool.connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
        await client.query('SELECT 1') // fixes the SERIALIZABLE snapshot; no write yet, no xid assigned
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: idleOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
            evidenceManifestSha256: hex64('new-b-not-idle'), evidenceReferences: baseRefs('new-b-not-idle'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' })
        // No rollout row was ever created — the rejection happened before any rollout DML.
        await expect(pool.query(
          'SELECT count(*)::int AS n FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [idleOrg],
        )).resolves.toMatchObject({ rows: [{ n: 0 }] })
        // The caller's own pre-opened transaction is still open and usable afterward — the
        // probe's `ROLLBACK TO SAVEPOINT` cleanup must not have touched it.
        await expect(client.query('SELECT 1 AS still_alive')).resolves.toMatchObject({
          rows: [{ still_alive: 1 }],
        })
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    it('positive control: an idle connection (the normal call shape) still transitions successfully', async () => {
      const idleOrg = crypto.randomUUID()
      allow(idleOrg)
      const client = await pool.connect()
      try {
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: idleOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
            evidenceManifestSha256: hex64('new-b-idle-control'), evidenceReferences: baseRefs('new-b-idle-control'),
            reasonCode: 'rollout_transition',
          }),
        ).resolves.toMatchObject({ state: 'shadow' })
      } finally {
        client.release()
      }
    })
  })

  describe('W4C-5 P1-2 hygiene: the session-level exclusive lock is actually released, not just asserted to be', () => {
    // The `finally` release in `transitionAttendanceCalculationRolloutV1` is otherwise an
    // UNTESTED guard: every test in this file uses a fresh `crypto.randomUUID()` org per case,
    // so a leaked session-level lock on org A's advisory key never blocks org B's key, and every
    // existing test would stay green even if the release call were deleted entirely (the same
    // "guard neuterable with all tests green" shape the P1-2 gate already flagged for the
    // staleness version half, P2-1). These legs check the actual server-visible lock state on
    // `pg_locks` for this connection's own backend PID — a stronger, more direct signal than
    // trusting `pg_advisory_unlock`'s boolean return value, which production code does not (and,
    // per the P1-2 fix's own doc comment, must not let a release-failure override the real
    // transition outcome) inspect.
    it('leaves zero session-level advisory locks held after a successful transition', async () => {
      const hygieneOrg = crypto.randomUUID()
      allow(hygieneOrg)
      const client = await pool.connect()
      try {
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: hygieneOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
            evidenceManifestSha256: hex64('hygiene-success'), evidenceReferences: baseRefs('hygiene-success'),
            reasonCode: 'rollout_transition',
          }),
        ).resolves.toMatchObject({ state: 'shadow' })
        await expect(
          client.query('SELECT count(*)::int AS n FROM pg_locks WHERE locktype = $1 AND pid = pg_backend_pid()', ['advisory']),
        ).resolves.toMatchObject({ rows: [{ n: 0 }] })
      } finally {
        client.release()
      }
    })

    it('leaves zero session-level advisory locks held after a rejected transition (predicate failure)', async () => {
      const hygieneOrg = crypto.randomUUID()
      allow(hygieneOrg)
      await insertRetryableJob(hygieneOrg, 'queued', 'authoritative') // pair requires "shadow"
      const client = await pool.connect()
      try {
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: hygieneOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
            evidenceManifestSha256: hex64('hygiene-reject'), evidenceReferences: baseRefs('hygiene-reject'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_RETRYABLE_JOB_POSTURE_MISMATCH' })
        await expect(
          client.query('SELECT count(*)::int AS n FROM pg_locks WHERE locktype = $1 AND pid = pg_backend_pid()', ['advisory']),
        ).resolves.toMatchObject({ rows: [{ n: 0 }] })
      } finally {
        client.release()
      }
    })

    it('leaves zero session-level advisory locks held after an input-validation rejection (before any lock acquisition attempt at all)', async () => {
      // Sanity companion leg: an input-time rejection (illegal pair) fails BEFORE
      // `acquireAttendanceCalculationRolloutLockSessionExclusiveV1` is ever called, so there is
      // no lock to release in the first place — this proves the two success/rejection legs above
      // are not vacuously green because pg_locks happens to always read zero for this org.
      const hygieneOrg = crypto.randomUUID()
      allow(hygieneOrg)
      const client = await pool.connect()
      try {
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: hygieneOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'authoritative', expectedState: 'legacy', expectedVersion: 1, // not in LEGAL_TRANSITIONS
            evidenceManifestSha256: hex64('hygiene-illegal'), evidenceReferences: baseRefs('hygiene-illegal'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_ILLEGAL_TRANSITION' })
        await expect(
          client.query('SELECT count(*)::int AS n FROM pg_locks WHERE locktype = $1 AND pid = pg_backend_pid()', ['advisory']),
        ).resolves.toMatchObject({ rows: [{ n: 0 }] })
      } finally {
        client.release()
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

  describe('resume "preserved authoritative jobs remain retryable without operation rows" predicate (gate 5, P2-4 PR #4773 gate)', () => {
    async function step(
      client: PoolClient,
      org: string,
      target: AttendanceRolloutStateV1,
      expectedState: AttendanceRolloutStateV1,
      expectedVersion: number,
      seed: string,
      refs = baseRefs(seed),
    ) {
      return transitionAttendanceCalculationRolloutV1(transactionClient(client), {
        orgId: org, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
        targetState: target, expectedState, expectedVersion,
        evidenceManifestSha256: hex64(seed), evidenceReferences: refs,
        reasonCode: 'rollout_transition',
      })
    }

    /**
     * Reaches 'authoritative' (version 3) BEFORE any retryable job exists — every earlier pair
     * (legacy->shadow, shadow->eligible) requires comparisonWritePosture 'shadow', which a job
     * frozen at 'authoritative' would immediately fail on
     * (W4C3A_ROLLOUT_CONTROL_RETRYABLE_JOB_POSTURE_MISMATCH, the pre-existing predicate, not the
     * one under test here). The job is inserted by the caller between this and `suspend` below,
     * exactly once the org is already at the posture the job will be frozen at.
     */
    async function advanceOrgToAuthoritative(client: PoolClient, org: string): Promise<void> {
      await step(client, org, 'shadow', 'legacy', 1, `${org}-resume-setup-1`)
      await step(client, org, 'eligible', 'shadow', 2, `${org}-resume-setup-2`)
      await step(client, org, 'authoritative', 'eligible', 3, `${org}-resume-setup-3`)
    }

    async function suspend(client: PoolClient, org: string): Promise<void> {
      await step(client, org, 'suspended', 'authoritative', 4, `${org}-resume-setup-4`)
    }

    it('rejects resume when a retryable job preserved through suspension already has a durable operation row', async () => {
      const resumeOrg = crypto.randomUUID()
      allow(resumeOrg)
      const client = await pool.connect()
      try {
        await advanceOrgToAuthoritative(client, resumeOrg)
        // Frozen at 'authoritative' — matches both the suspend pair's and the resume pair's
        // required comparisonWritePosture, so this leg exercises ONLY the new predicate under
        // test, never the pre-existing posture-mismatch one.
        const batchCommandId = await insertRetryableJob(resumeOrg, 'queued', 'authoritative')
        await insertOperationRowForImportBatch(resumeOrg, batchCommandId)
        await suspend(client, resumeOrg)

        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: resumeOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'authoritative', expectedState: 'suspended', expectedVersion: 5,
            evidenceManifestSha256: hex64('resume-op-rows-blocked'),
            evidenceReferences: resumeRefs('resume-op-rows-blocked'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_RETRYABLE_JOB_HAS_OPERATION_ROWS' })
        await expect(pool.query(
          'SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [resumeOrg],
        )).resolves.toMatchObject({ rows: [{ state: 'suspended', version: 5 }] })
      } finally {
        client.release()
      }
    })

    it('a preserved retryable job WITHOUT an operation row is rejected by the pre-existing incomplete-operation predicate, never by the new one (negative discriminator)', async () => {
      // NOTE (found while writing this leg, not self-reported by the original PR): a resume
      // target is ALWAYS in ELIGIBILITY_AUTHORITY_TARGETS ('eligible'/'authoritative'), so
      // countIncompleteOperations — "any w4_contract_version=1 job not yet completed" — fires
      // unconditionally on ANY resume attempt with ANY retryable (queued/failed) job present,
      // gated only on the TARGET state, never on the SOURCE state or the resume/promotion
      // distinction. That appears to make bullet 9's "preserved authoritative jobs remain
      // retryable" language unreachable as written today: there is no live combination where a
      // retryable job survives suspend and a resume attempt still succeeds. Whether
      // countIncompleteOperations should be narrowed to skip the resume pair specifically (so
      // bullet 9's own, more permissive "without operation rows" predicate is the one that
      // actually governs resume) is a design question outside the scope of adding the missing
      // "without operation rows" predicate itself — flagged for owner review, not silently
      // resolved here by loosening an existing gate. This test instead proves the DISCRIMINATING
      // property this leg was asked to prove: the new predicate is not spuriously broad — it
      // does NOT fire for a job that has no operation row, even though this job is (for the
      // unrelated reason above) still rejected overall.
      const resumeOrg = crypto.randomUUID()
      allow(resumeOrg)
      const client = await pool.connect()
      try {
        await advanceOrgToAuthoritative(client, resumeOrg)
        // Same frozen posture, same shape, deliberately WITHOUT a matching operation row.
        await insertRetryableJob(resumeOrg, 'queued', 'authoritative')
        await suspend(client, resumeOrg)

        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: resumeOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'authoritative', expectedState: 'suspended', expectedVersion: 5,
            evidenceManifestSha256: hex64('resume-op-rows-allowed'),
            evidenceReferences: resumeRefs('resume-op-rows-allowed'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_INCOMPLETE_OPERATION' })
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
      // W4C-5 §3 (issue #4775): uses the shared fixture builder (not the legacy `insertPendingRequest`
      // helper's arbitrary `hex64(...)` fingerprint) so this fixture's stored `payload_fingerprint`
      // EXACTLY matches what the live row would recompute — i.e. it trips ONLY `pendingUnsupported`,
      // not `pendingPayloadStale` too. A mutation-test pass (self-reported in the PR body) found the
      // legacy fixture's arbitrary fingerprint accidentally also tripped the new payload-stale check,
      // masking an `unsupported`-only mutation behind a still-red `payload-stale` leg on the same row.
      await insertRequestSnapshotFixture(reqOrg, 'pending', 'unsupported')
      const client = await pool.connect()
      try {
        const report = await readAttendanceRequestSnapshotDefectReportV1(transactionClient(client), reqOrg)
        expectSingleCellDefect(report.byCell, 'pendingUnsupported')
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

  describe('W4C-5 §3 (issue #4775): the remaining 6 request-snapshot defect cells', () => {
    const CASES: ReadonlyArray<{
      readonly label: string
      readonly bucket: RequestSnapshotFixtureBucket
      readonly kind: RequestSnapshotFixtureKind
      readonly cell: AttendanceRequestSnapshotDefectCellV1
    }> = [
      { label: 'pending x payload-stale', bucket: 'pending', kind: 'payload_stale', cell: 'pendingPayloadStale' },
      { label: 'pending x reversal-incomplete', bucket: 'pending', kind: 'reversal_incomplete', cell: 'pendingReversalIncomplete' },
      { label: 'reversible x missing', bucket: 'reversible', kind: 'missing', cell: 'reversibleMissing' },
      { label: 'reversible x unsupported', bucket: 'reversible', kind: 'unsupported', cell: 'reversibleUnsupported' },
      { label: 'reversible x payload-stale', bucket: 'reversible', kind: 'payload_stale', cell: 'reversiblePayloadStale' },
      { label: 'reversible x reversal-incomplete', bucket: 'reversible', kind: 'reversal_incomplete', cell: 'reversibleReversalIncomplete' },
    ]

    for (const testCase of CASES) {
      it(`${testCase.label}: the read-only reporter flags exactly this cell and no other`, async () => {
        const org = crypto.randomUUID()
        allow(org)
        await insertRequestSnapshotFixture(org, testCase.bucket, testCase.kind)
        const client = await pool.connect()
        try {
          const report = await readAttendanceRequestSnapshotDefectReportV1(transactionClient(client), org)
          expect(report.totalDefectiveRequests).toBe(1)
          expectSingleCellDefect(report.byCell, testCase.cell)
        } finally {
          client.release()
        }
      })

      it(`${testCase.label}: blocks entry into eligible with zero rollout DML`, async () => {
        const org = crypto.randomUUID()
        allow(org)
        await insertRequestSnapshotFixture(org, testCase.bucket, testCase.kind)
        const client = await pool.connect()
        try {
          await transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: org, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
            evidenceManifestSha256: hex64(`${testCase.cell}-setup`), evidenceReferences: baseRefs(`${testCase.cell}-setup`),
            reasonCode: 'rollout_transition',
          })
          await expect(
            transitionAttendanceCalculationRolloutV1(transactionClient(client), {
              orgId: org, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
              targetState: 'eligible', expectedState: 'shadow', expectedVersion: 2,
              evidenceManifestSha256: hex64(`${testCase.cell}-blocked`), evidenceReferences: baseRefs(`${testCase.cell}-blocked`),
              reasonCode: 'rollout_transition',
            }),
          ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_REQUEST_SNAPSHOT_DEFECTIVE' })
          await expect(pool.query(
            'SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1',
            [org],
          )).resolves.toMatchObject({ rows: [{ state: 'shadow', version: 2 }] })
        } finally {
          client.release()
        }
      })
    }

    it('POSITIVE CONTROL: a reversible (approved leave) request with a healthy, fresh, non-stale snapshot does not block promotion', async () => {
      const org = crypto.randomUUID()
      allow(org)
      const requestId = crypto.randomUUID()
      await pool.query(
        `INSERT INTO attendance_requests
           (id, user_id, work_date, request_type, status, org_id, requested_in_at, requested_out_at, reason, metadata, approval_instance_id)
         VALUES ($1::uuid, $2, '2026-08-01', 'leave', 'approved', $3, NULL, NULL, $4, '{}'::jsonb, NULL)`,
        [requestId, crypto.randomUUID(), org, LIVE_ROW_REASON],
      )
      await pool.query(
        `INSERT INTO attendance_request_calculation_snapshots (
           org_id, request_id, version, request_type, subject_user_id, payload, payload_fingerprint,
           attribution_snapshot, created_by)
         VALUES ($1, $2::uuid, 1, 'leave', $3, $4::jsonb, $5, '{"posture":"resolved_v2"}'::jsonb, $6)`,
        [
          org,
          requestId,
          crypto.randomUUID(),
          JSON.stringify({
            schemaVersion: 1, workDate: '2026-08-01', requestedInAt: null, requestedOutAt: null,
            reason: LIVE_ROW_REASON, minutes: null, leaveTypeCode: null, outdoorPunch: null,
          }),
          fixtureLivePayloadFingerprint(),
          actorId,
        ],
      )
      const client = await pool.connect()
      try {
        const report = await readAttendanceRequestSnapshotDefectReportV1(transactionClient(client), org)
        expect(report).toEqual({ totalDefectiveRequests: 0, byCell: emptyDefectCounts() })
        await transitionAttendanceCalculationRolloutV1(transactionClient(client), {
          orgId: org, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
          evidenceManifestSha256: hex64('healthy-reversible-setup'), evidenceReferences: baseRefs('healthy-reversible-setup'),
          reasonCode: 'rollout_transition',
        })
        await expect(transitionAttendanceCalculationRolloutV1(transactionClient(client), {
          orgId: org, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'eligible', expectedState: 'shadow', expectedVersion: 2,
          evidenceManifestSha256: hex64('healthy-reversible-ok'), evidenceReferences: baseRefs('healthy-reversible-ok'),
          reasonCode: 'rollout_transition',
        })).resolves.toEqual<AttendanceW4C3aRolloutControlResultV1>({ orgId: org, state: 'eligible', batchId: null })
      } finally {
        client.release()
      }
    })

    it('bucket-exclusion control: an approved NON-leave request with a missing snapshot is NOT flagged (reversible is closed to leave)', async () => {
      const org = crypto.randomUUID()
      allow(org)
      const requestId = crypto.randomUUID()
      // Approved 'overtime' — never reversible (index.cjs:34174 hard-blocks cancelling any
      // already-resolved non-leave request) — and has no snapshot at all. A predicate that
      // mistakenly widened `reversible` to "any approved type" would flag this row.
      await pool.query(
        `INSERT INTO attendance_requests
           (id, user_id, work_date, request_type, status, org_id, requested_in_at, requested_out_at, reason, metadata, approval_instance_id)
         VALUES ($1::uuid, $2, '2026-08-01', 'overtime', 'approved', $3, NULL, NULL, $4, '{}'::jsonb, NULL)`,
        [requestId, crypto.randomUUID(), org, LIVE_ROW_REASON],
      )
      const client = await pool.connect()
      try {
        const report = await readAttendanceRequestSnapshotDefectReportV1(transactionClient(client), org)
        expect(report).toEqual({ totalDefectiveRequests: 0, byCell: emptyDefectCounts() })
      } finally {
        client.release()
      }
    })
  })

  describe('W4C-5 §3 (issue #4775): real two-connection races extended to the 6 new snapshot cells (gate 6)', () => {
    const RACE_CASES: ReadonlyArray<{
      readonly label: string
      readonly bucket: RequestSnapshotFixtureBucket
      readonly kind: RequestSnapshotFixtureKind
      readonly cell: AttendanceRequestSnapshotDefectCellV1
    }> = [
      { label: 'RACE F (pending x payload-stale)', bucket: 'pending', kind: 'payload_stale', cell: 'pendingPayloadStale' },
      { label: 'RACE G (pending x reversal-incomplete)', bucket: 'pending', kind: 'reversal_incomplete', cell: 'pendingReversalIncomplete' },
      { label: 'RACE H (reversible x missing)', bucket: 'reversible', kind: 'missing', cell: 'reversibleMissing' },
      { label: 'RACE I (reversible x unsupported)', bucket: 'reversible', kind: 'unsupported', cell: 'reversibleUnsupported' },
      { label: 'RACE J (reversible x payload-stale)', bucket: 'reversible', kind: 'payload_stale', cell: 'reversiblePayloadStale' },
      { label: 'RACE K (reversible x reversal-incomplete)', bucket: 'reversible', kind: 'reversal_incomplete', cell: 'reversibleReversalIncomplete' },
    ]

    for (const raceCase of RACE_CASES) {
      it(`${raceCase.label}, 3-actor: a defect committed by an actor with NO rollout-lock obligation, while a protocol-compliant shared-lock holder blocks the transition, is still caught`, async () => {
        const raceOrg = crypto.randomUUID()
        allow(raceOrg)
        const setupClient = await pool.connect()
        try {
          await transitionAttendanceCalculationRolloutV1(transactionClient(setupClient), {
            orgId: raceOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
            evidenceManifestSha256: hex64(`${raceCase.cell}-race-setup`), evidenceReferences: baseRefs(`${raceCase.cell}-race-setup`),
            reasonCode: 'rollout_transition',
          })
        } finally {
          setupClient.release()
        }

        const c1Client = await pool.connect()
        const transitionClient = await pool.connect()
        try {
          await c1Client.query('BEGIN')
          await acquireAttendanceCalculationRolloutLock(
            transactionClient(c1Client),
            parseCanonicalAttendanceRolloutOrgKeyV1(raceOrg),
            'shared',
          )

          let transitionSettled = false
          const transition = transitionAttendanceCalculationRolloutV1(transactionClient(transitionClient), {
            orgId: raceOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'eligible', expectedState: 'shadow', expectedVersion: 2,
            evidenceManifestSha256: hex64(`${raceCase.cell}-race-transition`), evidenceReferences: baseRefs(`${raceCase.cell}-race-transition`),
            reasonCode: 'rollout_transition',
          }).finally(() => { transitionSettled = true })
          await new Promise((resolve) => setTimeout(resolve, 150))
          expect(transitionSettled).toBe(false) // T genuinely blocked behind C1's shared hold

          // C2: commits independently, lock-free, plain autocommit — matching
          // `insertRequestSnapshotFixture`'s default (shared pool) executor.
          await insertRequestSnapshotFixture(raceOrg, raceCase.bucket, raceCase.kind)

          // C1 releases; T can now proceed.
          await c1Client.query('COMMIT')

          await expect(transition).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_REQUEST_SNAPSHOT_DEFECTIVE' })
          expect(transitionSettled).toBe(true)
          await expect(pool.query(
            'SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1',
            [raceOrg],
          )).resolves.toMatchObject({ rows: [{ state: 'shadow', version: 2 }] })
        } finally {
          await c1Client.query('ROLLBACK').catch(() => undefined)
          c1Client.release()
          transitionClient.release()
        }
      })
    }
  })

  describe('W4C-5 §3 owner-review P2 (PR #4780): forged payload_fingerprint cannot bypass payload-stale', () => {
    /**
     * Constructs the exact adversarial row the pre-#4780 one-sided
     * `liveFingerprint === storedFingerprint` compare could not see: the stored `payload` column
     * is genuinely stale (independently re-hashes to `fixtureStaleSnapshotFingerprint()`, NOT
     * `fixtureLivePayloadFingerprint()`), but the stored `payload_fingerprint` column is FORGED
     * to equal the LIVE row's fingerprint instead of a hash of the payload actually stored beside
     * it. No writer in this codebase ever produces this shape —
     * `appendAttendanceRequestEditSnapshotV1` always hashes the exact payload object it is about
     * to store (`w4c3b-request-snapshots.ts` `payloadFingerprint:
     * computeAttendanceRequestPayloadFingerprintV1(payload)`, same `payload` value written to the
     * `payload` column two lines above) — this simulates a write outside that append boundary, or
     * a forged/corrupted field: exactly the class of defect a payload/fingerprint PAIR exists to
     * catch, and exactly what a one-sided fingerprint-only compare cannot.
     */
    async function insertForgedPayloadStaleFixture(
      org: string,
      bucket: RequestSnapshotFixtureBucket,
    ): Promise<{ requestId: string }> {
      const requestId = crypto.randomUUID()
      const requestType = bucket === 'reversible' ? 'leave' : 'time_correction'
      const status = bucket === 'reversible' ? 'approved' : 'pending'
      await pool.query(
        `INSERT INTO attendance_requests
           (id, user_id, work_date, request_type, status, org_id, requested_in_at, requested_out_at,
            reason, metadata, approval_instance_id)
         VALUES ($1::uuid, $2, '2026-08-01', $3, $4, $5, NULL, NULL, $6, '{}'::jsonb, NULL)`,
        [requestId, crypto.randomUUID(), requestType, status, org, LIVE_ROW_REASON],
      )
      await pool.query(
        `INSERT INTO attendance_request_calculation_snapshots (
           org_id, request_id, version, request_type, subject_user_id, payload, payload_fingerprint,
           attribution_snapshot, created_by)
         VALUES ($1, $2::uuid, 1, $3, $4, $5::jsonb, $6, '{"posture":"resolved_v2"}'::jsonb, $7)`,
        [
          org,
          requestId,
          requestType,
          crypto.randomUUID(),
          // STORED PAYLOAD: genuinely stale (mismatched `reason`).
          JSON.stringify({
            schemaVersion: 1, workDate: '2026-08-01', requestedInAt: null, requestedOutAt: null,
            reason: STALE_SNAPSHOT_REASON, minutes: null, leaveTypeCode: null, outdoorPunch: null,
          }),
          // FORGED STORED FINGERPRINT: hash of the LIVE payload, not of the stale payload two
          // lines above. The pre-#4780 predicate trusted this field as ground truth.
          fixtureLivePayloadFingerprint(),
          actorId,
        ],
      )
      return { requestId }
    }

    it('pending x payload-stale, FORGED fingerprint: the read-only reporter still flags pendingPayloadStale', async () => {
      const org = crypto.randomUUID()
      allow(org)
      await insertForgedPayloadStaleFixture(org, 'pending')
      const client = await pool.connect()
      try {
        const report = await readAttendanceRequestSnapshotDefectReportV1(transactionClient(client), org)
        expect(report.totalDefectiveRequests).toBe(1)
        expectSingleCellDefect(report.byCell, 'pendingPayloadStale')
      } finally {
        client.release()
      }
    })

    it('reversible x payload-stale, FORGED fingerprint: the read-only reporter still flags reversiblePayloadStale', async () => {
      const org = crypto.randomUUID()
      allow(org)
      await insertForgedPayloadStaleFixture(org, 'reversible')
      const client = await pool.connect()
      try {
        const report = await readAttendanceRequestSnapshotDefectReportV1(transactionClient(client), org)
        expect(report.totalDefectiveRequests).toBe(1)
        expectSingleCellDefect(report.byCell, 'reversiblePayloadStale')
      } finally {
        client.release()
      }
    })

    it('pending x payload-stale, FORGED fingerprint: blocks entry into eligible with zero rollout DML', async () => {
      const org = crypto.randomUUID()
      allow(org)
      await insertForgedPayloadStaleFixture(org, 'pending')
      const client = await pool.connect()
      try {
        await transitionAttendanceCalculationRolloutV1(transactionClient(client), {
          orgId: org, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
          evidenceManifestSha256: hex64('forged-fingerprint-setup'), evidenceReferences: baseRefs('forged-fingerprint-setup'),
          reasonCode: 'rollout_transition',
        })
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: org, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'eligible', expectedState: 'shadow', expectedVersion: 2,
            evidenceManifestSha256: hex64('forged-fingerprint-blocked'), evidenceReferences: baseRefs('forged-fingerprint-blocked'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_REQUEST_SNAPSHOT_DEFECTIVE' })
        await expect(pool.query(
          'SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [org],
        )).resolves.toMatchObject({ rows: [{ state: 'shadow', version: 2 }] })
      } finally {
        client.release()
      }
    })

    it('RACE L (pending x payload-stale, FORGED fingerprint), 3-actor: a forged-consistent defect committed by an actor with NO rollout-lock obligation, while a protocol-compliant shared-lock holder blocks the transition, is still caught', async () => {
      const raceOrg = crypto.randomUUID()
      allow(raceOrg)
      const setupClient = await pool.connect()
      try {
        await transitionAttendanceCalculationRolloutV1(transactionClient(setupClient), {
          orgId: raceOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
          evidenceManifestSha256: hex64('forged-race-setup'), evidenceReferences: baseRefs('forged-race-setup'),
          reasonCode: 'rollout_transition',
        })
      } finally {
        setupClient.release()
      }

      const c1Client = await pool.connect()
      const transitionClient = await pool.connect()
      try {
        await c1Client.query('BEGIN')
        await acquireAttendanceCalculationRolloutLock(
          transactionClient(c1Client),
          parseCanonicalAttendanceRolloutOrgKeyV1(raceOrg),
          'shared',
        )

        let transitionSettled = false
        const transition = transitionAttendanceCalculationRolloutV1(transactionClient(transitionClient), {
          orgId: raceOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
          targetState: 'eligible', expectedState: 'shadow', expectedVersion: 2,
          evidenceManifestSha256: hex64('forged-race-transition'), evidenceReferences: baseRefs('forged-race-transition'),
          reasonCode: 'rollout_transition',
        }).finally(() => { transitionSettled = true })
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect(transitionSettled).toBe(false) // T genuinely blocked behind C1's shared hold

        // C2: commits the forged-consistent defect independently, lock-free, plain autocommit.
        await insertForgedPayloadStaleFixture(raceOrg, 'pending')

        // C1 releases; T can now proceed.
        await c1Client.query('COMMIT')

        await expect(transition).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_REQUEST_SNAPSHOT_DEFECTIVE' })
        expect(transitionSettled).toBe(true)
        await expect(pool.query(
          'SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [raceOrg],
        )).resolves.toMatchObject({ rows: [{ state: 'shadow', version: 2 }] })
      } finally {
        await c1Client.query('ROLLBACK').catch(() => undefined)
        c1Client.release()
        transitionClient.release()
      }
    })

    it("DEFENSIVE: a stored payload that does not decode under the writers' own closed-shape validator is treated as inconsistent (payload-stale), not silently skipped", async () => {
      const org = crypto.randomUUID()
      allow(org)
      const requestId = crypto.randomUUID()
      await pool.query(
        `INSERT INTO attendance_requests
           (id, user_id, work_date, request_type, status, org_id, requested_in_at, requested_out_at,
            reason, metadata, approval_instance_id)
         VALUES ($1::uuid, $2, '2026-08-01', 'time_correction', 'pending', $3, NULL, NULL, $4, '{}'::jsonb, NULL)`,
        [requestId, crypto.randomUUID(), org, LIVE_ROW_REASON],
      )
      await pool.query(
        `INSERT INTO attendance_request_calculation_snapshots (
           org_id, request_id, version, request_type, subject_user_id, payload, payload_fingerprint,
           attribution_snapshot, created_by)
         VALUES ($1, $2::uuid, 1, 'time_correction', $3, $4::jsonb, $5, '{"posture":"resolved_v2"}'::jsonb, $6)`,
        [
          org,
          requestId,
          crypto.randomUUID(),
          // Malformed: does not carry the writers' exact PAYLOAD_KEYS shape, so
          // normalizeAttendanceRequestCalculationPayloadV1 (reached through
          // computeAttendanceRequestPayloadFingerprintV1) throws when re-hashing it.
          JSON.stringify({ schemaVersion: 1, note: 'not a real payload' }),
          fixtureLivePayloadFingerprint(),
          actorId,
        ],
      )
      const client = await pool.connect()
      try {
        const report = await readAttendanceRequestSnapshotDefectReportV1(transactionClient(client), org)
        expect(report.totalDefectiveRequests).toBe(1)
        expectSingleCellDefect(report.byCell, 'pendingPayloadStale')
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
            retryableJobsWithOperationRows: 0,
            nonterminalLegacyJobs: 0,
            incompleteOperations: 0,
            unresolvedReviews: 0,
            defectiveRequestSnapshots: 0,
            defectiveRequestSnapshotsByCell: emptyDefectCounts(),
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

    it('leaves no event when the state update fails after the event insert succeeded', async () => {
      const atomicOrg = crypto.randomUUID()
      allow(atomicOrg)
      __setW4C3aRolloutControlBeforeStateUpdateForTests(async () => {
        throw new Error('W4C3A_TEST_FORCED_STATE_UPDATE_FAILURE')
      })
      const client = await pool.connect()
      try {
        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId: atomicOrg, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c3a-control-test',
            targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
            evidenceManifestSha256: hex64('atomic-2'), evidenceReferences: baseRefs('atomic-2'),
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toThrow('W4C3A_TEST_FORCED_STATE_UPDATE_FAILURE')
        await expect(pool.query(
          'SELECT count(*)::int AS n FROM attendance_calculation_rollout_state WHERE org_id = $1',
          [atomicOrg],
        )).resolves.toMatchObject({ rows: [{ n: 0 }] })
        await expect(pool.query(
          'SELECT count(*)::int AS n FROM attendance_calculation_rollout_events WHERE org_id = $1',
          [atomicOrg],
        )).resolves.toMatchObject({ rows: [{ n: 0 }] })
      } finally {
        __setW4C3aRolloutControlBeforeStateUpdateForTests(null)
        client.release()
      }
    })
  })
})
