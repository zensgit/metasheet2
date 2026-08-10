/**
 * W4C-5 operator transition tooling — real-PostgreSQL proof.
 *
 * docs/development/attendance-issue-4556-w4c5-transition-safety-amendment-20260804.md
 * (OD-W4C-61=(a), ratified at 2a2a5eee4f00abceff94ed6360e8c051708e35f7, owner comment
 * 5189421034 on PR 4747).
 *
 * Covers, against real PostgreSQL: the plan reporter's zero-write property (dynamic query
 * sweep + before/after row-count invariance), a full legacy -> shadow plan+apply cycle through
 * the actual CLI subprocess, idempotent re-apply, and one test per refusal class named in the
 * task — each asserting its SPECIFIC failure code. Pure orchestration/manifest/digest logic is
 * covered without a database in
 * scripts/ops/attendance-w4c5-rollout-transition-lib.test.ts.
 */
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import {
  planAttendanceCalculationRolloutTransitionV1,
  transitionAttendanceCalculationRolloutV1,
  type AttendanceRolloutTransitionPlanV1,
  type AttendanceRolloutTransitionPredicateV1,
  type EvidenceReferencesV1,
} from '../../src/attendance/w4c3a-rollout-control'
import {
  acquireAttendanceCalculationRolloutLockSessionExclusiveV1,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  releaseAttendanceCalculationRolloutLockSessionExclusiveV1,
  type AttendanceW4TransactionClientV1,
} from '../../src/attendance/w4c0-identity'
import {
  ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
  computeAttendanceW4C5PlanDigestV1,
} from '../../../../scripts/ops/attendance-w4c5-rollout-transition-lib'
import {
  __setAttendanceW4C2AuthoritativeDeliveryOverrideForTests,
  isAttendanceW4C2AuthoritativeEntrypointDeliveredV1,
} from '../../src/attendance/w4c2-authoritative-delivery'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const run = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

const ALLOWLIST_ENV = 'ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED'
const CLI_PATH = join(process.cwd(), '..', '..', 'scripts', 'ops', 'attendance-w4c5-rollout-transition.ts')
const TSX_CLI = join(process.cwd(), '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')

function hex64(seed: string): string {
  return crypto.createHash('sha256').update(seed).digest('hex')
}

/** Arbitrary fixed namespace UUID for `attendance_w4_uuidv5(...)` derivations in test fixtures. */
const IMPORT_NS_V1 = '6f67fdaa-e2aa-48b3-b76c-c4aab9723173'

/**
 * Hardened write detector for the statement-level zero-write sweep (P2-3, PR #4839 gate,
 * 20260809). The original sweep used a bare `/^(INSERT|UPDATE|DELETE|...)\b/` anchor —
 * deliberately anchored at the START of the statement, never a whole-statement scan, because a
 * whole-statement `\bUPDATE\b` search would false-positive on every `FOR UPDATE`/`FOR UPDATE OF
 * j` locking clause this file's own read-only predicates issue routinely. That anchor is still
 * correct for a bare DML statement, but it CANNOT see a write hidden inside a CTE
 * (`WITH x AS (INSERT INTO ... ) SELECT ...`) — such a statement starts with `WITH`, not
 * `INSERT`, so the anchor alone would pass it through undetected. Nothing on the actual `plan`
 * path issues a CTE today (verified: every predicate helper in w4c3a-rollout-control.ts issues a
 * plain `SELECT ... FOR UPDATE`), so this is defense-in-depth against a future edit, not a fix
 * for a live gap. Matches EITHER the statement-start form OR a write verb immediately inside a
 * CTE's `AS (...)` open — `\bAS\s*\(` requires a literal open-paren right after `AS`, which a
 * read-only CTE's own `(SELECT ...) AS "alias"` shape (parenthesis BEFORE `AS`) never produces,
 * so it does not false-positive on that either. See the self-test directly below for both the
 * must-catch and must-NOT-catch cases.
 */
const WRITE_VERBS_V1 =
  'INSERT\\s+INTO|UPDATE\\s+\\S+\\s+SET|DELETE\\s+FROM|MERGE\\s+INTO|TRUNCATE(?:\\s+TABLE)?\\s|ALTER\\s+(?:TABLE|SEQUENCE|DATABASE)|DROP\\s+(?:TABLE|SEQUENCE|DATABASE)|CREATE\\s+(?:TABLE|SEQUENCE|DATABASE)'
const WRITE_STATEMENT_PATTERN_V1 = new RegExp(
  `(^\\s*(?:${WRITE_VERBS_V1}))|(\\bAS\\s*\\(\\s*(?:${WRITE_VERBS_V1}))`,
  'i',
)

function isWriteStatementV1(text: string): boolean {
  return WRITE_STATEMENT_PATTERN_V1.test(text)
}

// Ungated (not behind describeIfDatabase): this detector is pure string matching, needs no
// database, and its own correctness — including the exact false-positive it must avoid — should
// never be skippable just because DATABASE_URL happens to be unset in a given CI leg.
describe('isWriteStatementV1 (hardened statement-sweep write detector, P2-3)', () => {
  it('flags a bare DML statement at the start (the pre-existing shallow case)', () => {
    for (const text of [
      'INSERT INTO t (a) VALUES (1)',
      'UPDATE t SET a = 1 WHERE id = $1',
      'DELETE FROM t WHERE id = $1',
      'TRUNCATE TABLE t',
      'ALTER TABLE t ADD COLUMN a int',
      'DROP TABLE t',
      'CREATE TABLE t (a int)',
    ]) {
      expect(isWriteStatementV1(text)).toBe(true)
    }
  })

  it('flags a CTE-wrapped write that the shallow start-anchor alone would miss', () => {
    for (const text of [
      'WITH x AS (INSERT INTO t (a) VALUES (1) RETURNING id) SELECT * FROM x',
      'WITH a AS (SELECT 1), b AS (UPDATE t SET a = 1 WHERE id = $1 RETURNING id) SELECT * FROM b',
      'WITH x AS (\n  DELETE FROM t WHERE id = $1 RETURNING id\n) SELECT * FROM x',
    ]) {
      expect(isWriteStatementV1(text)).toBe(true)
    }
  })

  it('does NOT flag a real read-only statement, including one using FOR UPDATE (the exact false-positive this detector must avoid)', () => {
    for (const text of [
      'SELECT id FROM attendance_records WHERE org_id = $1 ORDER BY id FOR UPDATE',
      'SELECT j.id FROM attendance_import_jobs j WHERE j.org_id = $1 ORDER BY j.id FOR UPDATE OF j',
      'SELECT state, version, prior_state FROM attendance_calculation_rollout_state WHERE org_id = $1',
      'WITH target(user_id, work_date) AS (\n  SELECT * FROM unnest($2::uuid[], $3::date[])\n)\nSELECT r.id FROM attendance_records r JOIN target t ON true FOR UPDATE',
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      'ROLLBACK',
      'COMMIT',
    ]) {
      expect(isWriteStatementV1(text)).toBe(false)
    }
  })
})

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

function transactionClient(client: PoolClient): AttendanceW4TransactionClientV1 {
  return {
    query: (text, values) =>
      client.query(text, values as unknown[]) as unknown as Promise<{ rows: Array<Record<string, unknown>> }>,
  }
}

/**
 * Same adapter as `transactionClient`, but also appends every statement TEXT to `log` before
 * delegating — used by the P2-2/F2 ordering proofs (PR #4839 P3 gate, 20260810) to assert that
 * the idle-connection guard's own `SAVEPOINT w4c5_idle_probe` is genuinely the FIRST statement
 * `plan` issues on a caller-supplied connection, never a predicate SELECT that ran before it.
 */
function loggingTransactionClient(client: PoolClient, log: string[]): AttendanceW4TransactionClientV1 {
  return {
    query: (text, values) => {
      log.push(text)
      return client.query(text, values as unknown[]) as unknown as Promise<{ rows: Array<Record<string, unknown>> }>
    },
  }
}

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    orgId: overrides.orgId,
    targetState: overrides.targetState,
    imageSha: 'sha-tool-test',
    pendingMigrations: 0,
    serviceHealthy: true,
    ownerAuthorizationRef: 'owner-ref-tool-test',
    syntheticOrgRef: 'synthetic-ref-tool-test',
    customerData: false,
    externalNotificationsDisabled: true,
    externalDestinationCount: 0,
    entrypointInventoryRef: 'inventory-ref-tool-test',
    ...overrides,
  }
}

describeIfDatabase('W4C-5 operator transition tooling (real PostgreSQL)', () => {
  const scratchName = `ms2_w4c5_tool_${run}`
  const actorId = `w4c5-tool-${run}`
  const allowlisted = new Set<string>()
  let adminPool: Pool
  let pool: Pool
  let workdir: string

  function allow(id: string): void {
    allowlisted.add(id)
    process.env[ALLOWLIST_ENV] = [...allowlisted].join(',')
  }

  function spawnCli(argv: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [TSX_CLI, CLI_PATH, ...argv], {
      encoding: 'utf8',
      cwd: join(process.cwd()),
      env: { ...process.env, DATABASE_URL: dbUrl?.replace(/\/[^/]+$/, `/${scratchName}`), [ALLOWLIST_ENV]: [...allowlisted].join(',') },
      timeout: 30_000,
    })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }

  function writeManifest(name: string, manifest: Record<string, unknown>): string {
    const filePath = join(workdir, `${name}.json`)
    writeFileSync(filePath, JSON.stringify(manifest), 'utf8')
    return filePath
  }

  async function rolloutRow(orgId: string): Promise<{ state: string; version: number } | null> {
    const result = await pool.query(
      `SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1`,
      [orgId],
    )
    return result.rows.length === 1 ? (result.rows[0] as { state: string; version: number }) : null
  }

  async function eventCount(orgId: string): Promise<number> {
    const result = await pool.query(
      `SELECT count(*)::int AS n FROM attendance_calculation_rollout_events WHERE org_id = $1`,
      [orgId],
    )
    return result.rows[0].n as number
  }

  // ---------------------------------------------------------------------------
  // P2-3 deep-branch fixtures (PR #4839 gate, 20260809). Same shapes as the sibling
  // attendance-w4c3a-rollout-control.db.test.ts's own fixture builders (not invented fresh) —
  // just enough of each to make ONE deep predicate see a real row, never intended to model a
  // realistic org. Called AFTER an org has been driven to its target state cleanly, so seeding
  // never blocks the drive-up transitions themselves.
  // ---------------------------------------------------------------------------

  async function insertUnclosedBatchFixture(orgId: string): Promise<void> {
    const batchId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO attendance_import_batches (id, org_id, status, row_count, meta)
       VALUES ($1::uuid, $2, 'committed', 1, '{"source":"w4c5-tool-test"}'::jsonb)`,
      [batchId, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_import_items (batch_id, org_id, user_id, work_date, preview_snapshot)
       VALUES ($1::uuid, $2, $3, '2026-08-01', '{}'::jsonb)`,
      [batchId, orgId, crypto.randomUUID()],
    )
  }

  /** A retryable (queued) V1 job — `w4_accepted_write_posture: 'shadow'` deliberately, so it
   * can be reused as a genuine RETRYABLE_JOB_POSTURE_MISMATCH candidate against a 'shadow'
   * comparison posture and as an INCOMPLETE_OPERATION / RETRYABLE_JOB_HAS_OPERATION_ROWS
   * candidate regardless of the pair's own comparison posture. */
  async function insertRetryableV1JobFixture(orgId: string): Promise<void> {
    const batchCommandId = crypto.randomUUID()
    const fp = hex64(`${orgId}:${batchCommandId}`)
    await pool.query(
      `INSERT INTO attendance_import_jobs
         (org_id, batch_id, created_by, status, payload, w4_contract_version, w4_entrypoint,
          w4_batch_command_id, w4_source_kind, w4_source_ref, w4_actor_id, w4_actor_posture,
          w4_command_fingerprint, w4_accepted_write_posture, w4_item_count,
          w4_item_sequence_fingerprint, w4_item_set_fingerprint, w4_identity_proof_vector)
       SELECT $1, $2::uuid, 'actor-control', 'queued', '{}'::jsonb, 1, 'import_batch',
              $2::uuid, 'import_batch', 'batch:control', 'actor-control', 'delegated_import',
              $3, 'shadow', 1, $3, $3,
              jsonb_build_array(jsonb_build_object(
                'ordinal', 0,
                'semanticFingerprint', $3::text,
                'derivedOperationId', attendance_w4_uuidv5($4::uuid, attendance_w4_item_name_bytes($2::uuid, 0, $3))::text,
                'commandFingerprint', $3::text))`,
      [orgId, batchCommandId, fp, IMPORT_NS_V1],
    )
  }

  async function insertUnresolvedIngressReviewFixture(orgId: string): Promise<void> {
    const recordId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO attendance_records (id, user_id, work_date, org_id) VALUES ($1::uuid, $2, '2026-08-01', $3)`,
      [recordId, crypto.randomUUID(), orgId],
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
         'w4c5-tool-test', 1, $4::uuid, $5, $6,
         '{"posture":"unsupported","sourceSchemaVersion":null,"reason":"missing","sourceFingerprint":null}'::jsonb,
         '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, 'append', 'legacy_shadow',
         'review_required', 'legacy_time_ingress_not_authoritative', 'none', 0, $7, $8)`,
      [
        crypto.randomUUID(),
        orgId,
        recordId,
        crypto.randomUUID(),
        hex64(`${orgId}:${recordId}:semantic`),
        hex64(`${orgId}:${recordId}:provenance`),
        actorId,
        crypto.randomUUID(),
      ],
    )
  }

  /** A 'missing-snapshot' defective pending request with a LIVE `approval_instances` link — the
   * combination that exercises BOTH the `attendance_request_calculation_snapshots` lookup AND
   * the per-row `approval_instances ... FOR UPDATE` sub-loop
   * (`classifyAttendanceRequestSnapshotDefectsV1`, w4c3a-rollout-control.ts:1023), which only
   * fires when a matched request row carries a non-null `approval_instance_id`. */
  async function insertDefectiveRequestFixture(orgId: string): Promise<void> {
    const requestId = crypto.randomUUID()
    const approvalInstanceId = `appr-${requestId}`
    await pool.query(
      `INSERT INTO attendance_requests
         (id, user_id, work_date, request_type, status, org_id, requested_in_at, requested_out_at,
          reason, metadata, approval_instance_id)
       VALUES ($1::uuid, $2, '2026-08-01', 'time_correction', 'pending', $3, NULL, NULL, 'fixture', '{}'::jsonb, $4)`,
      [requestId, crypto.randomUUID(), orgId, approvalInstanceId],
    )
    await pool.query(`INSERT INTO approval_instances (id, status, version) VALUES ($1, 'pending', 1)`, [
      approvalInstanceId,
    ])
    // Deliberately NO attendance_request_calculation_snapshots row inserted — this is the
    // 'missing' defect kind, which is enough on its own to trip DEFECTIVE_REQUEST_SNAPSHOT.
  }

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'w4c5-tool-'))
    const adminUrl = new URL(dbUrl as string)
    adminUrl.pathname = '/postgres'
    adminPool = new Pool({ connectionString: adminUrl.toString() })
    await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
    await adminPool.query(`CREATE DATABASE ${scratchName}`)
    const scratchUrl = new URL(dbUrl as string)
    scratchUrl.pathname = `/${scratchName}`
    pool = new Pool({ connectionString: scratchUrl.toString() })
    await createBase(pool)
    const db = new Kysely<never>({ dialect: new PostgresDialect({ pool }) })
    await w4c0Up(db)
  }, 60_000)

  afterAll(async () => {
    delete process.env[ALLOWLIST_ENV]
    await pool?.end().catch(() => undefined)
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`).catch(() => undefined)
      await adminPool.end().catch(() => undefined)
    }
    rmSync(workdir, { recursive: true, force: true })
  })

  describe('plan reporter: zero-write proof', () => {
    it('issues no write statement and always ends with ROLLBACK, never COMMIT', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const client = await pool.connect()
      const statements: string[] = []
      const spy: AttendanceW4TransactionClientV1 = {
        query: (text, values) => {
          statements.push(text.trim())
          return client.query(text, values as unknown[]) as unknown as Promise<{ rows: Array<Record<string, unknown>> }>
        },
      }
      try {
        const plan = await planAttendanceCalculationRolloutTransitionV1(spy, { orgId, targetState: 'shadow' })
        expect(plan.rowExists).toBe(false)
        expect(plan.canBootstrap).toBe(true)
        expect(plan.priorState).toBeNull()

        for (const statement of statements) {
          expect(isWriteStatementV1(statement)).toBe(false)
        }
        expect(statements.at(-1)?.toUpperCase()).toBe('ROLLBACK')
        expect(statements.some((s) => s.toUpperCase() === 'COMMIT')).toBe(false)
      } finally {
        client.release()
      }
    })

    it('leaves the rollout row and event count exactly unchanged across a plan call', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const client = await pool.connect()
      try {
        const before = await rolloutRow(orgId)
        const beforeEvents = await eventCount(orgId)
        expect(before).toBeNull()
        expect(beforeEvents).toBe(0)

        await planAttendanceCalculationRolloutTransitionV1(transactionClient(client), {
          orgId,
          targetState: 'shadow',
        })

        const after = await rolloutRow(orgId)
        const afterEvents = await eventCount(orgId)
        expect(after).toBeNull()
        expect(afterEvents).toBe(0)
      } finally {
        client.release()
      }
    })
  })

  describe('plan reporter: zero-write proof over the DEEP predicate branch (P2-3)', () => {
    it('target=eligible from a seeded shadow org: INCOMPLETE_OPERATION / UNRESOLVED_INGRESS_REVIEW / DEFECTIVE_REQUEST_SNAPSHOT all become applicable, and plan is STILL zero-write', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const driveClient = await pool.connect()
      try {
        await transitionAttendanceCalculationRolloutV1(transactionClient(driveClient), {
          orgId,
          actorId,
          correlationId: crypto.randomUUID(),
          engineVersion: 'w4c5-tool-test',
          targetState: 'shadow',
          expectedState: 'legacy',
          expectedVersion: 1,
          evidenceManifestSha256: hex64(`${orgId}:p2-3-eligible:bootstrap`),
          evidenceReferences: { imageSha: 'x', ownerAuthorizationRef: 'y', syntheticOrgRef: 'z' } as EvidenceReferencesV1,
          reasonCode: 'rollout_transition',
        })
      } finally {
        driveClient.release()
      }
      expect(await rolloutRow(orgId)).toEqual({ state: 'shadow', version: 2 })

      // Seeded AFTER the clean drive-up, so these rows never block it. One batch, one job, one
      // review, one request — matching the gate's own fix text.
      await insertUnclosedBatchFixture(orgId)
      await insertRetryableV1JobFixture(orgId)
      await insertUnresolvedIngressReviewFixture(orgId)
      await insertDefectiveRequestFixture(orgId)

      const before = await rolloutRow(orgId)
      const beforeEvents = await eventCount(orgId)

      const sweepClient = await pool.connect()
      const statements: string[] = []
      const spy: AttendanceW4TransactionClientV1 = {
        query: (text, values) => {
          statements.push(text.trim())
          return sweepClient.query(text, values as unknown[]) as unknown as Promise<{
            rows: Array<Record<string, unknown>>
          }>
        },
      }
      let plan: AttendanceRolloutTransitionPlanV1
      try {
        plan = await planAttendanceCalculationRolloutTransitionV1(spy, { orgId, targetState: 'eligible' })
      } finally {
        sweepClient.release()
      }

      expect(plan.currentState).toBe('shadow')
      expect(plan.priorState).toBe('legacy')
      expect(plan.legalPair).toBe(true)

      const byCode = Object.fromEntries(plan.predicates.map((p) => [p.code, p])) as Record<
        string,
        { applicable: boolean; pass: boolean; count: number | null }
      >
      const applicableCodes = Object.entries(byCode)
        .filter(([, p]) => p.applicable)
        .map(([code]) => code)
        .sort()
      expect(applicableCodes).toEqual(
        [
          'DEFECTIVE_REQUEST_SNAPSHOT',
          'INCOMPLETE_OPERATION',
          'LEGAL_TRANSITION_PAIR',
          'NONTERMINAL_LEGACY_JOB',
          'ORG_ALLOWLISTED',
          'RETRYABLE_JOB_POSTURE_MISMATCH',
          'ROLLOUT_ROW_RESOLVABLE',
          'UNCLOSED_LEGACY_BATCH',
          'UNRESOLVED_INGRESS_REVIEW',
        ].sort(),
      )
      // RETRYABLE_JOB_HAS_OPERATION_ROWS is resume-only: not applicable for shadow -> eligible.
      expect(byCode.RETRYABLE_JOB_HAS_OPERATION_ROWS.applicable).toBe(false)

      // Every deep predicate that reached a real seeded row reports a genuine non-zero count —
      // proving the query actually examined the row, not merely that its branch was entered.
      expect(byCode.UNCLOSED_LEGACY_BATCH.count).toBe(1)
      expect(byCode.INCOMPLETE_OPERATION.count).toBe(1)
      expect(byCode.UNRESOLVED_INGRESS_REVIEW.count).toBe(1)
      expect(byCode.DEFECTIVE_REQUEST_SNAPSHOT.count).toBe(1)
      expect(plan.blocked).toBe(true)

      for (const statement of statements) {
        expect(isWriteStatementV1(statement)).toBe(false)
      }
      expect(statements.at(-1)?.toUpperCase()).toBe('ROLLBACK')
      expect(statements.some((s) => s.toUpperCase() === 'COMMIT')).toBe(false)

      // Row-level zero-write proof across every table this deep branch actually reads.
      expect(await rolloutRow(orgId)).toEqual(before)
      expect(await eventCount(orgId)).toBe(beforeEvents)
      const jobCount = await pool.query(`SELECT count(*)::int AS n FROM attendance_import_jobs WHERE org_id = $1`, [
        orgId,
      ])
      expect(jobCount.rows[0].n).toBe(1)
      const requestCount = await pool.query(`SELECT count(*)::int AS n FROM attendance_requests WHERE org_id = $1`, [
        orgId,
      ])
      expect(requestCount.rows[0].n).toBe(1)
      const approvalRow = await pool.query(`SELECT status FROM approval_instances`)
      expect(approvalRow.rows.every((r) => r.status === 'pending')).toBe(true)
      const snapshotCount = await pool.query(
        `SELECT count(*)::int AS n FROM attendance_request_calculation_snapshots WHERE org_id = $1`,
        [orgId],
      )
      expect(snapshotCount.rows[0].n).toBe(0)
    })

    it('target=authoritative from a seeded suspended org (resume pair): RETRYABLE_JOB_HAS_OPERATION_ROWS becomes applicable, and plan is STILL zero-write', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const driveClient = await pool.connect()
      try {
        const chain: ReadonlyArray<readonly [string, string, number]> = [
          ['shadow', 'legacy', 1],
          ['eligible', 'shadow', 2],
          ['authoritative', 'eligible', 3],
          ['suspended', 'authoritative', 4],
        ]
        // Gate D (owner completion gate, PR #4839, 20260810): the third step above is a REAL
        // `eligible -> authoritative` promotion, driven as SETUP for a test whose actual subject
        // is `RETRYABLE_JOB_HAS_OPERATION_ROWS` (asserted below, under PRODUCTION-DEFAULT
        // (undelivered) Gate D values — the override is reset before the plan call this test
        // actually exercises, so it never masks what this test proves).
        __setAttendanceW4C2AuthoritativeDeliveryOverrideForTests({ live_punch: true, scheduled: true })
        for (const [targetState, expectedState, expectedVersion] of chain) {
          await transitionAttendanceCalculationRolloutV1(transactionClient(driveClient), {
            orgId,
            actorId,
            correlationId: crypto.randomUUID(),
            engineVersion: 'w4c5-tool-test',
            targetState,
            expectedState,
            expectedVersion,
            evidenceManifestSha256: hex64(`${orgId}:p2-3-resume:${targetState}:${expectedVersion}`),
            evidenceReferences: { imageSha: 'x', ownerAuthorizationRef: 'y', syntheticOrgRef: 'z' } as EvidenceReferencesV1,
            reasonCode: 'rollout_transition',
          })
        }
      } finally {
        __setAttendanceW4C2AuthoritativeDeliveryOverrideForTests(null)
        driveClient.release()
      }
      expect(await rolloutRow(orgId)).toEqual({ state: 'suspended', version: 5 })

      // A retryable V1 job present WITHOUT a matching attendance_result_operations row: enough
      // for the resume-only JOIN this predicate issues to execute against a non-empty candidate
      // set. Zero matching operation rows is the CORRECT count here — the point being proven is
      // that the statement fires at all (it never did on an empty org before this fix), not that
      // it finds a match.
      await insertRetryableV1JobFixture(orgId)

      const before = await rolloutRow(orgId)
      const beforeEvents = await eventCount(orgId)

      const sweepClient = await pool.connect()
      const statements: string[] = []
      const spy: AttendanceW4TransactionClientV1 = {
        query: (text, values) => {
          statements.push(text.trim())
          return sweepClient.query(text, values as unknown[]) as unknown as Promise<{
            rows: Array<Record<string, unknown>>
          }>
        },
      }
      let plan: AttendanceRolloutTransitionPlanV1
      try {
        plan = await planAttendanceCalculationRolloutTransitionV1(spy, { orgId, targetState: 'authoritative' })
      } finally {
        sweepClient.release()
      }

      expect(plan.currentState).toBe('suspended')
      expect(plan.priorState).toBe('authoritative')
      expect(plan.legalPair).toBe(true)

      const byCode = Object.fromEntries(plan.predicates.map((p) => [p.code, p])) as Record<
        string,
        { applicable: boolean; pass: boolean; count: number | null }
      >
      // Eleven predicates are applicable on a resume pair whose target is also an
      // eligibility/authority target: every ELIGIBILITY_AUTHORITY_TARGETS +
      // CALCULATION_ENTRY_TARGETS + resume-only branch is reached simultaneously, plus Gate D's
      // AUTHORITATIVE_ENTRYPOINTS_DELIVERED (owner completion gate, PR #4839, 20260810 — the
      // eleventh, applicable whenever `targetState === 'authoritative'`, which this resume pair
      // is).
      expect(Object.values(byCode).filter((p) => p.applicable)).toHaveLength(11)
      expect(byCode.RETRYABLE_JOB_HAS_OPERATION_ROWS.applicable).toBe(true)
      expect(byCode.RETRYABLE_JOB_HAS_OPERATION_ROWS.count).toBe(0)
      // This plan call runs under PRODUCTION-DEFAULT (undelivered) Gate D values — the override
      // set for the drive-up above was reset in the `finally` block before this call — so the
      // reporter must show the real shipped state: applicable, failing, both entrypoints
      // undelivered.
      expect(byCode.AUTHORITATIVE_ENTRYPOINTS_DELIVERED).toMatchObject({
        applicable: true,
        pass: false,
        count: 2,
      })

      for (const statement of statements) {
        expect(isWriteStatementV1(statement)).toBe(false)
      }
      expect(statements.at(-1)?.toUpperCase()).toBe('ROLLBACK')
      expect(statements.some((s) => s.toUpperCase() === 'COMMIT')).toBe(false)

      expect(await rolloutRow(orgId)).toEqual(before)
      expect(await eventCount(orgId)).toBe(beforeEvents)
      const jobCount = await pool.query(`SELECT count(*)::int AS n FROM attendance_import_jobs WHERE org_id = $1`, [
        orgId,
      ])
      expect(jobCount.rows[0].n).toBe(1)
    })
  })

  describe('full legacy -> shadow plan+apply cycle (CLI), idempotent re-apply', () => {
    const orgId = crypto.randomUUID()

    it('plan reports an unblocked legacy -> shadow bootstrap-eligible transition', () => {
      allow(orgId)
      const result = spawnCli(['plan', '--org', orgId, '--target', 'shadow'])
      expect(result.status).toBe(0)
      const plan = JSON.parse(result.stdout) as AttendanceRolloutTransitionPlanV1 & { planDigest: string }
      expect(plan.blocked).toBe(false)
      expect(plan.legalPair).toBe(true)
      expect(plan.canBootstrap).toBe(true)
      expect(plan.currentState).toBe('legacy')
      expect(plan.targetState).toBe('shadow')
      expect(plan.planDigest).toMatch(/^[0-9a-f]{64}$/)
    })

    let planDigest: string
    let correlationId: string

    it('apply transitions legacy -> shadow through the CLI and persists exactly one event', () => {
      const planResult = spawnCli(['plan', '--org', orgId, '--target', 'shadow'])
      const plan = JSON.parse(planResult.stdout) as { planDigest: string }
      planDigest = plan.planDigest
      correlationId = crypto.randomUUID()

      const manifestPath = writeManifest('legacy-to-shadow', baseManifest({ orgId, targetState: 'shadow' }))
      const applyResult = spawnCli([
        'apply',
        '--org', orgId,
        '--target', 'shadow',
        '--expected-state', 'legacy',
        '--expected-version', '1',
        '--plan-digest', planDigest,
        '--confirm', ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
        '--manifest', manifestPath,
        '--actor-id', actorId,
        '--correlation-id', correlationId,
        '--engine-version', 'w4c5-tool-test',
      ])

      expect(applyResult.status).toBe(0)
      const outcome = JSON.parse(applyResult.stdout) as { outcome: string; state: string }
      expect(outcome.outcome).toBe('transitioned')
      expect(outcome.state).toBe('shadow')
    })

    it('persisted exactly the expected row and event after apply', async () => {
      const row = await rolloutRow(orgId)
      expect(row).toEqual({ state: 'shadow', version: 2 })
      expect(await eventCount(orgId)).toBe(1)

      const events = await pool.query(
        `SELECT evidence FROM attendance_calculation_rollout_events WHERE org_id = $1`,
        [orgId],
      )
      const evidence = events.rows[0].evidence as Record<string, unknown>
      expect(evidence.correlationId).toBe(correlationId)
      expect(typeof evidence.manifestSha256).toBe('string')
      expect((evidence.manifestSha256 as string)).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(evidence)).not.toMatch(/secret/i)
    })

    it('re-applying the SAME invocation is a no-op — zero DML, not a second transition', () => {
      const manifestPath = writeManifest('legacy-to-shadow-reapply', baseManifest({ orgId, targetState: 'shadow' }))
      const applyResult = spawnCli([
        'apply',
        '--org', orgId,
        '--target', 'shadow',
        '--expected-state', 'legacy',
        '--expected-version', '1',
        '--plan-digest', planDigest,
        '--confirm', ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
        '--manifest', manifestPath,
        '--actor-id', actorId,
        '--correlation-id', crypto.randomUUID(),
        '--engine-version', 'w4c5-tool-test',
      ])

      expect(applyResult.status).toBe(0)
      const outcome = JSON.parse(applyResult.stdout) as { outcome: string }
      expect(outcome.outcome).toBe('noop_already_at_target')
    })

    it('the idempotent re-apply left state, version, and event count byte-identical', async () => {
      const row = await rolloutRow(orgId)
      expect(row).toEqual({ state: 'shadow', version: 2 })
      expect(await eventCount(orgId)).toBe(1)
    })
  })

  describe('P2-1 (PR #4839 gate, 20260809): the idempotency short-circuit can no longer bypass --expected-state', () => {
    // P3 fix (PR #4839 fresh-gate round, 20260810): the Gate D test seam
    // (`__setAttendanceW4C2AuthoritativeDeliveryOverrideForTests`) is a module-level singleton
    // with NO reset between vitest test cases. The A17 test below sets it, does one more DB call,
    // then clears it — all inline in the `try` body, not in a `finally`. If that DB call ever
    // throws, the clear is skipped and the override LEAKS into every subsequent test in this
    // describe (and file), silently masking Gate D's production-default (undelivered) behaviour
    // for tests that never touch the seam themselves. This `afterEach` is the backstop: it
    // guarantees the override is reset after EVERY test in this describe regardless of how that
    // test exits, so a future inline set-without-finally in this describe still cannot leak past
    // its own test. See the "Gate D test-seam hygiene" sub-describe below for the regression
    // proof that this backstop is actually load-bearing (not dead code).
    afterEach(() => {
      __setAttendanceW4C2AuthoritativeDeliveryOverrideForTests(null)
    })

    async function directTransition(
      client: PoolClient,
      orgId: string,
      targetState: string,
      expectedState: string,
      expectedVersion: number,
    ): Promise<void> {
      await transitionAttendanceCalculationRolloutV1(transactionClient(client), {
        orgId,
        actorId,
        correlationId: crypto.randomUUID(),
        engineVersion: 'w4c5-tool-test',
        targetState,
        expectedState,
        expectedVersion,
        evidenceManifestSha256: hex64(`${orgId}:${targetState}:${expectedVersion}`),
        evidenceReferences: { imageSha: 'x', ownerAuthorizationRef: 'y', syntheticOrgRef: 'z' } as EvidenceReferencesV1,
        reasonCode: 'rollout_transition',
      })
    }

    it('D1 reproduction (illegal pair, stale zeros digest): refuses PLAN_DIGEST_MISMATCH, never a no-op', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const client = await pool.connect()
      try {
        await directTransition(client, orgId, 'shadow', 'legacy', 1) // -> shadow v2, prior_state='legacy'
      } finally {
        client.release()
      }

      const manifestPath = writeManifest('p2-1-d1', baseManifest({ orgId, targetState: 'shadow' }))
      const applyResult = spawnCli([
        'apply',
        '--org', orgId,
        '--target', 'shadow',
        '--expected-state', 'authoritative', // never this org's real prior state
        '--expected-version', '1', // currentVersion(2) - 1: satisfies the OLD buggy arithmetic exactly
        '--plan-digest', '0'.repeat(64),
        '--confirm', ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
        '--manifest', manifestPath,
        '--actor-id', actorId,
        '--correlation-id', crypto.randomUUID(),
        '--engine-version', 'w4c5-tool-test',
      ])

      expect(applyResult.status).toBe(5)
      expect(applyResult.stderr).toContain('W4C5_TOOL_PLAN_DIGEST_MISMATCH')
      expect(await rolloutRow(orgId)).toEqual({ state: 'shadow', version: 2 })
      expect(await eventCount(orgId)).toBe(1)
    })

    it('D1-SHARP (illegal pair, FRESH matching digest): reaches the boundary and is refused there — mutation-exclusive proof for the priorState conjunct', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const client = await pool.connect()
      try {
        await directTransition(client, orgId, 'shadow', 'legacy', 1) // -> shadow v2, prior_state='legacy'
      } finally {
        client.release()
      }

      // A genuinely fresh, matching digest for the ACTUAL current plan — so the refusal below
      // CANNOT be explained by a stale/wrong digest. This is the exact D1-SHARP shape: with the
      // priorState conjunct removed, this invocation exits 0 noop_already_at_target; with it
      // restored, it must fall through past the digest check (which passes) to the boundary,
      // which refuses the pair.
      const planResult = spawnCli(['plan', '--org', orgId, '--target', 'shadow'])
      const plan = JSON.parse(planResult.stdout) as { planDigest: string }

      const manifestPath = writeManifest('p2-1-d1-sharp', baseManifest({ orgId, targetState: 'shadow' }))
      const applyResult = spawnCli([
        'apply',
        '--org', orgId,
        '--target', 'shadow',
        '--expected-state', 'authoritative', // authoritative -> shadow is NOT one of the seven ratified pairs
        '--expected-version', '1',
        '--plan-digest', plan.planDigest,
        '--confirm', ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
        '--manifest', manifestPath,
        '--actor-id', actorId,
        '--correlation-id', crypto.randomUUID(),
        '--engine-version', 'w4c5-tool-test',
      ])

      expect(applyResult.status).toBe(7)
      expect(applyResult.stderr).toContain('W4C3A_ROLLOUT_CONTROL_ILLEGAL_TRANSITION')
      expect(await rolloutRow(orgId)).toEqual({ state: 'shadow', version: 2 })
      expect(await eventCount(orgId)).toBe(1)
    })

    it('A17 reproduction (weak manifest key set): a base-only manifest cannot buy an exit-0 no-op for an authoritative org under the wrong --expected-state', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const client = await pool.connect()
      try {
        await directTransition(client, orgId, 'shadow', 'legacy', 1) // v2, prior='legacy'
        await directTransition(client, orgId, 'eligible', 'shadow', 2) // v3, prior='shadow'
        // Gate D (owner completion gate, PR #4839, 20260810): this promotion step is SETUP for
        // an A17-manifest-weakness reproduction, unrelated to Gate D — override on for just this
        // one call, off immediately after, so it never leaks into the assertions below (which
        // must observe production-default behaviour for everything else in this test).
        //
        // P3 fix (PR #4839 fresh-gate round, 20260810): the clear used to sit inline in the try
        // body, right after the call it guards — if `directTransition` below ever threw, the
        // clear was skipped and the override leaked into every later test in this file (no
        // afterEach existed at all before this fix). Moved into the enclosing `finally` so the
        // module-level singleton is reset REGARDLESS of how this block exits; the describe-level
        // `afterEach` added above is a second, independent backstop.
        __setAttendanceW4C2AuthoritativeDeliveryOverrideForTests({ live_punch: true, scheduled: true })
        await directTransition(client, orgId, 'authoritative', 'eligible', 3) // v4, prior='eligible'
      } finally {
        __setAttendanceW4C2AuthoritativeDeliveryOverrideForTests(null)
        client.release()
      }
      expect(await rolloutRow(orgId)).toEqual({ state: 'authoritative', version: 4 })

      // 13 base keys only — no sevenDistinctCalendarDaysObserved / criticalDiffCount /
      // unresolvedReviewCount. Validates cleanly because expectedState='shadow' makes
      // isAuthorityPromotionPairV1('shadow','authoritative') false: the manifest validator never
      // even asks for the authority-only fields for THIS claimed pair, exactly the A17 gap.
      const manifestPath = writeManifest('p2-1-a17', baseManifest({ orgId, targetState: 'authoritative' }))
      const applyResult = spawnCli([
        'apply',
        '--org', orgId,
        '--target', 'authoritative',
        '--expected-state', 'shadow', // this org's REAL prior_state is 'eligible', not 'shadow'
        '--expected-version', '3', // currentVersion(4) - 1: satisfies the OLD buggy arithmetic exactly
        '--plan-digest', '0'.repeat(64),
        '--confirm', ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
        '--manifest', manifestPath,
        '--actor-id', actorId,
        '--correlation-id', crypto.randomUUID(),
        '--engine-version', 'w4c5-tool-test',
      ])

      expect(applyResult.status).not.toBe(0)
      expect(applyResult.status).toBe(5)
      expect(applyResult.stderr).toContain('W4C5_TOOL_PLAN_DIGEST_MISMATCH')
      expect(await rolloutRow(orgId)).toEqual({ state: 'authoritative', version: 4 })
      expect(await eventCount(orgId)).toBe(3)
    })

    // P3 regression (PR #4839 fresh-gate round, 20260810): proves the describe-level `afterEach`
    // added above is an actual, load-bearing safety net — not dead code sitting next to a fixed
    // call site. Test (A) deliberately sets the Gate D test seam and does NOT clear it itself
    // (simulating a throw between set and clear, the exact class of bug fixed above). Test (B),
    // which vitest always runs after (A)'s `afterEach` fires regardless of (A)'s outcome, asserts
    // production-default (undelivered) values are observed. If the describe-scoped `afterEach`
    // above is ever removed, (B) reds — on its own, independent of whether the A17 fix's
    // `finally` block above is intact, because (A) never clears the seam itself; verified
    // directly (gate-2 round): removing only the `afterEach`, with the A17 `finally` block left
    // untouched, reds (B).
    describe('Gate D test-seam hygiene: the describe-level afterEach backstop is load-bearing', () => {
      it('(A) sets the Gate D override and relies ENTIRELY on the surrounding afterEach to clear it (no explicit clear in this test)', () => {
        expect(isAttendanceW4C2AuthoritativeEntrypointDeliveredV1('live_punch')).toBe(false) // sanity: starts clean
        __setAttendanceW4C2AuthoritativeDeliveryOverrideForTests({ live_punch: true, scheduled: true })
        expect(isAttendanceW4C2AuthoritativeEntrypointDeliveredV1('live_punch')).toBe(true) // sanity: override is live
        expect(isAttendanceW4C2AuthoritativeEntrypointDeliveredV1('scheduled')).toBe(true)
        // No clear here, deliberately — proving the afterEach above is what cleans this up.
      })

      it('(B) the override set by (A) has not leaked into this test — proves the afterEach backstop actually ran', () => {
        expect(isAttendanceW4C2AuthoritativeEntrypointDeliveredV1('live_punch')).toBe(false)
        expect(isAttendanceW4C2AuthoritativeEntrypointDeliveredV1('scheduled')).toBe(false)
      })
    })
  })

  describe('refusal matrix — one test per class, each asserting its SPECIFIC failure code', () => {
    it('unknown org: no row and not bootstrap-eligible (target != shadow) refuses with STATE_MISSING and zero DML', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const planResult = spawnCli(['plan', '--org', orgId, '--target', 'eligible'])
      const plan = JSON.parse(planResult.stdout) as { planDigest: string }

      const manifestPath = writeManifest('unknown-org', baseManifest({ orgId, targetState: 'eligible' }))
      const applyResult = spawnCli([
        'apply',
        '--org', orgId,
        '--target', 'eligible',
        '--expected-state', 'shadow',
        '--expected-version', '1',
        '--plan-digest', plan.planDigest,
        '--confirm', ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
        '--manifest', manifestPath,
        '--actor-id', actorId,
        '--correlation-id', crypto.randomUUID(),
        '--engine-version', 'w4c5-tool-test',
      ])

      expect(applyResult.status).toBe(7)
      expect(applyResult.stderr).toContain('W4C3A_ROLLOUT_CONTROL_STATE_MISSING')
      expect(await rolloutRow(orgId)).toBeNull()
    })

    it('org not in expected current state: a stale expected-version refuses with STALE_EXPECTED_STATE (direct boundary proof)', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const client = await pool.connect()
      try {
        await transitionAttendanceCalculationRolloutV1(transactionClient(client), {
          orgId,
          actorId,
          correlationId: crypto.randomUUID(),
          engineVersion: 'w4c5-tool-test',
          targetState: 'shadow',
          expectedState: 'legacy',
          expectedVersion: 1,
          evidenceManifestSha256: crypto.createHash('sha256').update('stale-fixture').digest('hex'),
          evidenceReferences: { imageSha: 'x', ownerAuthorizationRef: 'y', syntheticOrgRef: 'z' } as EvidenceReferencesV1,
          reasonCode: 'rollout_transition',
        })

        await expect(
          transitionAttendanceCalculationRolloutV1(transactionClient(client), {
            orgId,
            actorId,
            correlationId: crypto.randomUUID(),
            engineVersion: 'w4c5-tool-test',
            targetState: 'eligible',
            expectedState: 'shadow',
            expectedVersion: 99, // deliberately stale
            evidenceManifestSha256: crypto.createHash('sha256').update('stale-fixture-2').digest('hex'),
            evidenceReferences: { imageSha: 'x', ownerAuthorizationRef: 'y', syntheticOrgRef: 'z' } as EvidenceReferencesV1,
            reasonCode: 'rollout_transition',
          }),
        ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_STALE_EXPECTED_STATE' })

        expect(await rolloutRow(orgId)).toEqual({ state: 'shadow', version: 2 })
      } finally {
        client.release()
      }
    })

    it('org not in expected current state, driven through the actual CLI subprocess: apply refuses STALE_EXPECTED_STATE (P3-3, CLI-level proof)', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const client = await pool.connect()
      try {
        await transitionAttendanceCalculationRolloutV1(transactionClient(client), {
          orgId,
          actorId,
          correlationId: crypto.randomUUID(),
          engineVersion: 'w4c5-tool-test',
          targetState: 'shadow',
          expectedState: 'legacy',
          expectedVersion: 1,
          evidenceManifestSha256: hex64(`${orgId}:p3-3-cli-stale`),
          evidenceReferences: { imageSha: 'x', ownerAuthorizationRef: 'y', syntheticOrgRef: 'z' } as EvidenceReferencesV1,
          reasonCode: 'rollout_transition',
        })
      } finally {
        client.release()
      }
      expect(await rolloutRow(orgId)).toEqual({ state: 'shadow', version: 2 })

      // eligible -> shadow IS one of the seven ratified pairs (so the boundary's input-time
      // matrix check clears and the real staleness comparison runs), but this org's TRUE current
      // state is 'shadow', not 'eligible'. --expected-version 2 also keeps this off the
      // idempotency short-circuit (currentVersion=2 !== expectedVersion(2)+1=3), so the refusal
      // below is provably the STALE_EXPECTED_STATE guard, not the no-op path or a digest issue —
      // and unlike the sibling test above, this one goes through the real CLI subprocess end to
      // end, never calling the boundary directly.
      const planResult = spawnCli(['plan', '--org', orgId, '--target', 'shadow'])
      const plan = JSON.parse(planResult.stdout) as { planDigest: string }
      const manifestPath = writeManifest('p3-3-cli-stale', baseManifest({ orgId, targetState: 'shadow' }))
      const applyResult = spawnCli([
        'apply',
        '--org', orgId,
        '--target', 'shadow',
        '--expected-state', 'eligible',
        '--expected-version', '2',
        '--plan-digest', plan.planDigest,
        '--confirm', ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
        '--manifest', manifestPath,
        '--actor-id', actorId,
        '--correlation-id', crypto.randomUUID(),
        '--engine-version', 'w4c5-tool-test',
      ])

      expect(applyResult.status).toBe(7)
      expect(applyResult.stderr).toContain('W4C3A_ROLLOUT_CONTROL_STALE_EXPECTED_STATE')
      expect(await rolloutRow(orgId)).toEqual({ state: 'shadow', version: 2 })
      expect(await eventCount(orgId)).toBe(1)
    })

    it('transition pair absent from the ratified matrix refuses with ILLEGAL_TRANSITION and zero DML', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const planResult = spawnCli(['plan', '--org', orgId, '--target', 'suspended'])
      const plan = JSON.parse(planResult.stdout) as { planDigest: string; legalPair: boolean }
      expect(plan.legalPair).toBe(false)

      const manifestPath = writeManifest('illegal-pair', baseManifest({ orgId, targetState: 'suspended' }))
      const applyResult = spawnCli([
        'apply',
        '--org', orgId,
        '--target', 'suspended',
        '--expected-state', 'legacy',
        '--expected-version', '1',
        '--plan-digest', plan.planDigest,
        '--confirm', ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
        '--manifest', manifestPath,
        '--actor-id', actorId,
        '--correlation-id', crypto.randomUUID(),
        '--engine-version', 'w4c5-tool-test',
      ])

      expect(applyResult.status).toBe(7)
      expect(applyResult.stderr).toContain('W4C3A_ROLLOUT_CONTROL_ILLEGAL_TRANSITION')
      expect(await rolloutRow(orgId)).toBeNull()
    })

    it('Gate D (owner completion gate, PR #4839, 20260810), driven through the actual CLI subprocess: a legal eligible -> authoritative promotion still refuses with AUTHORITATIVE_ENTRYPOINT_NOT_DELIVERED under production values — the test seam cannot cross the subprocess boundary, so this proves the CLI has no bypass and is display-only', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const driveClient = await pool.connect()
      try {
        // Setup only: drives the org to `eligible` (production-default undelivered Gate D
        // values never block this — Gate D is keyed strictly on `targetState === 'authoritative'`
        // and none of these three steps target it).
        await transitionAttendanceCalculationRolloutV1(transactionClient(driveClient), {
          orgId, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c5-tool-test',
          targetState: 'shadow', expectedState: 'legacy', expectedVersion: 1,
          evidenceManifestSha256: hex64(`${orgId}:gate-d-cli:shadow`),
          evidenceReferences: { imageSha: 'x', ownerAuthorizationRef: 'y', syntheticOrgRef: 'z' } as EvidenceReferencesV1,
          reasonCode: 'rollout_transition',
        })
        await transitionAttendanceCalculationRolloutV1(transactionClient(driveClient), {
          orgId, actorId, correlationId: crypto.randomUUID(), engineVersion: 'w4c5-tool-test',
          targetState: 'eligible', expectedState: 'shadow', expectedVersion: 2,
          evidenceManifestSha256: hex64(`${orgId}:gate-d-cli:eligible`),
          evidenceReferences: { imageSha: 'x', ownerAuthorizationRef: 'y', syntheticOrgRef: 'z' } as EvidenceReferencesV1,
          reasonCode: 'rollout_transition',
        })
      } finally {
        driveClient.release()
      }
      expect(await rolloutRow(orgId)).toEqual({ state: 'eligible', version: 3 })
      const before = await rolloutRow(orgId)
      const beforeEvents = await eventCount(orgId)

      // eligible -> authoritative IS one of the seven ratified pairs, so plan reports
      // legalPair:true and canBootstrap:false — this promotion is refused ONLY by Gate D, not by
      // pair legality, org allowlist, or any other section-3 predicate (a clean org has none of
      // those seeded).
      const planResult = spawnCli(['plan', '--org', orgId, '--target', 'authoritative'])
      const plan = JSON.parse(planResult.stdout) as AttendanceRolloutTransitionPlanV1 & { planDigest: string }
      expect(plan.legalPair).toBe(true)
      expect(plan.blocked).toBe(true)
      const authoritativePredicate = plan.predicates.find((p) => p.code === 'AUTHORITATIVE_ENTRYPOINTS_DELIVERED')
      expect(authoritativePredicate).toMatchObject({ applicable: true, pass: false, count: 2 })

      const manifestPath = writeManifest(
        'gate-d-cli-promotion',
        baseManifest({
          orgId,
          targetState: 'authoritative',
          sevenDistinctCalendarDaysObserved: [
            '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07',
          ],
          criticalDiffCount: 0,
          unresolvedReviewCount: 0,
        }),
      )
      const applyResult = spawnCli([
        'apply',
        '--org', orgId,
        '--target', 'authoritative',
        '--expected-state', 'eligible',
        '--expected-version', '3',
        '--plan-digest', plan.planDigest,
        '--confirm', ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
        '--manifest', manifestPath,
        '--actor-id', actorId,
        '--correlation-id', crypto.randomUUID(),
        '--engine-version', 'w4c5-tool-test',
      ])

      expect(applyResult.status).toBe(7)
      expect(applyResult.stderr).toContain('W4C3A_ROLLOUT_CONTROL_AUTHORITATIVE_ENTRYPOINT_NOT_DELIVERED')
      await expect(rolloutRow(orgId)).resolves.toEqual(before)
      await expect(eventCount(orgId)).resolves.toBe(beforeEvents)
    })

    it('missing confirmation refuses with W4C5_TOOL_CONFIRMATION_REQUIRED before any DB access', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const manifestPath = writeManifest('missing-confirm', baseManifest({ orgId, targetState: 'shadow' }))
      const applyResult = spawnCli([
        'apply',
        '--org', orgId,
        '--target', 'shadow',
        '--expected-state', 'legacy',
        '--expected-version', '1',
        '--plan-digest', 'a'.repeat(64),
        '--manifest', manifestPath,
        '--actor-id', actorId,
        '--correlation-id', crypto.randomUUID(),
        '--engine-version', 'w4c5-tool-test',
      ])

      expect(applyResult.status).toBe(3)
      expect(applyResult.stderr).toContain('W4C5_TOOL_CONFIRMATION_REQUIRED')
      expect(await rolloutRow(orgId)).toBeNull()
    })

    it('stale/mismatched plan digest refuses with W4C5_TOOL_PLAN_DIGEST_MISMATCH and zero DML', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const manifestPath = writeManifest('digest-mismatch', baseManifest({ orgId, targetState: 'shadow' }))
      const applyResult = spawnCli([
        'apply',
        '--org', orgId,
        '--target', 'shadow',
        '--expected-state', 'legacy',
        '--expected-version', '1',
        '--plan-digest', '0'.repeat(64), // never a real digest for this fresh org
        '--confirm', ATTENDANCE_W4C5_CONFIRMATION_TOKEN_V1,
        '--manifest', manifestPath,
        '--actor-id', actorId,
        '--correlation-id', crypto.randomUUID(),
        '--engine-version', 'w4c5-tool-test',
      ])

      expect(applyResult.status).toBe(5)
      expect(applyResult.stderr).toContain('W4C5_TOOL_PLAN_DIGEST_MISMATCH')
      expect(await rolloutRow(orgId)).toBeNull()
    })

    it('a concurrent transition in flight refuses with the boundary\'s own bounded-wait busy code (real two-connection proof)', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const holder = await pool.connect()
      const contender = await pool.connect()
      try {
        const orgKey = parseCanonicalAttendanceRolloutOrgKeyV1(orgId)
        await acquireAttendanceCalculationRolloutLockSessionExclusiveV1(transactionClient(holder), orgKey)
        try {
          await expect(
            transitionAttendanceCalculationRolloutV1(transactionClient(contender), {
              orgId,
              actorId,
              correlationId: crypto.randomUUID(),
              engineVersion: 'w4c5-tool-test',
              targetState: 'shadow',
              expectedState: 'legacy',
              expectedVersion: 1,
              evidenceManifestSha256: crypto.createHash('sha256').update('busy-fixture').digest('hex'),
              evidenceReferences: { imageSha: 'x', ownerAuthorizationRef: 'y', syntheticOrgRef: 'z' } as EvidenceReferencesV1,
              reasonCode: 'rollout_transition',
            }),
          ).rejects.toMatchObject({ code: 'ATTENDANCE_CALCULATION_ROLLOUT_BUSY' })
        } finally {
          await releaseAttendanceCalculationRolloutLockSessionExclusiveV1(transactionClient(holder), orgKey)
        }
        expect(await rolloutRow(orgId)).toBeNull()
      } finally {
        holder.release()
        contender.release()
      }
    }, 20_000)
  })

  describe('planDigest arithmetic sanity (direct, no CLI)', () => {
    it('computeAttendanceW4C5PlanDigestV1 over a real plan matches what the CLI printed', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const client = await pool.connect()
      try {
        const plan = await planAttendanceCalculationRolloutTransitionV1(transactionClient(client), {
          orgId,
          targetState: 'shadow',
        })
        const digest = computeAttendanceW4C5PlanDigestV1(plan)
        const cliResult = spawnCli(['plan', '--org', orgId, '--target', 'shadow'])
        const cliPlan = JSON.parse(cliResult.stdout) as { planDigest: string }
        expect(cliPlan.planDigest).toBe(digest)
      } finally {
        client.release()
      }
    })
  })

  describe('P2-2 (PR #4839 gate, 20260809): plan enforces its own idle-connection precondition — enforced, not just documented', () => {
    // `planAttendanceCalculationRolloutTransitionV1`'s own doc comment used to say "`connection`
    // must be idle" with no enforcement or test — the exact defect class W4C-5 NEW-B (PR #4773)
    // already closed for the SIBLING session-exclusive-lock acquisition. On a dirty connection,
    // PostgreSQL only WARNs on the nested `BEGIN` (never errors), so `plan`'s own unconditional
    // `finally` ROLLBACK then aborted the CALLER's entire outer transaction, and `set_config(...,
    // true)` overrode the caller's own `statement_timeout` for the rest of it. This reuses the
    // EXISTING mechanism (`assertConnectionIsIdleV1`, generalized off
    // `assertConnectionIsIdleForSessionExclusiveRolloutLockV1` in w4c0-identity.ts) rather than
    // building a second one — see that function's own doc comment for the SAVEPOINT-probe proof.
    //
    // F1 (PR #4839 P3 gate, 20260810) rewrote the assertions below: the original
    // `SELECT 1 AS still_alive` cannot distinguish a live caller transaction from one whose
    // transaction was DESTROYED (`SELECT 1` resolves identically either way) — mutating the
    // guard's own cleanup from `ROLLBACK TO SAVEPOINT` to a bare `ROLLBACK` (which destroys the
    // caller's WHOLE transaction) left that assertion green. Now a temp table + row are created
    // in the caller's transaction BEFORE the guard runs, and required still visible afterward —
    // state a destroyed transaction would actually lose. The original `rolloutRow(orgId) ===
    // null` check was zero information (`plan` never issues DML on ANY path — see the dedicated
    // "plan reporter: zero-write proof" suite above — so it is null regardless of whether the
    // guard fired correctly) and has been dropped. The "before any DB read" ordering claim is now
    // asserted for real via `loggingTransactionClient`, which records every statement `plan`
    // issues: the FIRST one recorded must be the guard's own `SAVEPOINT`.
    it('rejects a plan called on a connection that already has an open, non-aborted transaction, before any DB read (real query-order proof)', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const client = await pool.connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
        await client.query('SELECT 1') // fixes the SERIALIZABLE snapshot; no write yet, no xid assigned
        await client.query('CREATE TEMP TABLE w4c5_p22_probe_marker (id int)')
        await client.query('INSERT INTO w4c5_p22_probe_marker VALUES (1)')
        const queryLog: string[] = []
        await expect(
          planAttendanceCalculationRolloutTransitionV1(loggingTransactionClient(client, queryLog), {
            orgId,
            targetState: 'shadow',
          }),
        ).rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' })
        // F1(c): the FIRST statement `plan` issued at all is the idle probe's own SAVEPOINT —
        // never a predicate SELECT that ran before it.
        expect(queryLog[0]).toBe('SAVEPOINT w4c5_idle_probe')
        // F1(a): the caller's own pre-opened transaction — including the row inserted before the
        // guard ran — is still intact afterward. A bare `ROLLBACK` (destroying the whole
        // transaction) instead of the correct `ROLLBACK TO SAVEPOINT` would make this SELECT fail
        // (transaction aborted / temp table gone), not merely return something different.
        await expect(client.query('SELECT id FROM w4c5_p22_probe_marker')).resolves.toMatchObject({
          rows: [{ id: 1 }],
        })
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
    })

    // F2 (PR #4839 P3 gate, 20260810): the state `isNoActiveTransactionForSavepoint` used to get
    // wrong. A transaction already ABORTED by an earlier failed statement makes the SAME
    // `SAVEPOINT` probe raise SQLSTATE `25P02` (`in_failed_sql_transaction`), not `25P01` — the
    // old code rethrew that raw driver code instead of refusing with the product code. An aborted
    // transaction is emphatically NOT idle (there IS an open transaction block); `plan` must
    // refuse it exactly the same way it refuses an open, non-aborted one.
    it('F2: rejects a plan called on a connection whose transaction is ABORTED by an earlier failed statement — the product code, never the raw driver SQLSTATE 25P02', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await expect(client.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' }) // division_by_zero -> aborts the transaction
        const queryLog: string[] = []
        await expect(
          planAttendanceCalculationRolloutTransitionV1(loggingTransactionClient(client, queryLog), {
            orgId,
            targetState: 'shadow',
          }),
        ).rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' }) // never the raw '25P02'
        expect(queryLog[0]).toBe('SAVEPOINT w4c5_idle_probe')
        // The guard must not have tried to "fix" the aborted transaction (no COMMIT/ROLLBACK of
        // its own on this path — there is nothing to clean up, the probe SAVEPOINT never actually
        // ran either). The connection is left EXACTLY as the caller left it: still open, still
        // aborted, still refusing every statement with 25P02 until the caller's own ROLLBACK.
        await expect(client.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' })
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
      expect(await rolloutRow(orgId)).toBeNull()
    })

    // P2-C (PR #4839 gate, 20260810): `assertConnectionIsIdleV1`'s cleanup, on the "SAVEPOINT
    // succeeded" branch (an open, non-aborted transaction already existed), issues BOTH
    // `ROLLBACK TO SAVEPOINT w4c5_idle_probe` (w4c0-identity.ts:1393) AND, immediately after,
    // `RELEASE SAVEPOINT w4c5_idle_probe` (:1394) — the function's own doc comment explains why
    // the first alone is not enough: `ROLLBACK TO SAVEPOINT` undoes work done under the
    // savepoint but leaves the savepoint itself DEFINED in the connection's subtransaction stack;
    // only `RELEASE SAVEPOINT` afterward actually removes it. A prior gate round claimed this
    // `RELEASE` line was "covered by the same F1 mutation proof" above — refuted: F1's assertions
    // (`queryLog[0]`, the temp-table row surviving) are both satisfied identically whether or not
    // :1394 ever runs, because F1 never issues a SECOND `RELEASE SAVEPOINT` itself. This test
    // does, from OUTSIDE the guard, playing the role of a caller checking the guard actually
    // cleaned up: it must fail, because the guard already released the name. Deleting :1394 alone
    // leaves every other suite green (verified by the gate round that added this test: mutate,
    // record red, restore via `cp`) but flips this test's outcome, because a SECOND `RELEASE
    // SAVEPOINT w4c5_idle_probe` on a savepoint the guard never released SUCCEEDS instead of
    // failing (verified against real PostgreSQL 15 directly, both shapes, before writing this
    // assertion).
    it('P2-C: after a not-idle refusal, the guard has already RELEASEd its own probe savepoint — a caller-issued RELEASE SAVEPOINT afterward must fail with 3B001, proving cleanup rather than merely documenting it', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const client = await pool.connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
        await client.query('SELECT 1') // fixes the SERIALIZABLE snapshot; no write yet, no xid assigned
        await expect(
          planAttendanceCalculationRolloutTransitionV1(transactionClient(client), {
            orgId,
            targetState: 'shadow',
          }),
        ).rejects.toMatchObject({ code: 'W4C0_CONNECTION_NOT_IDLE' })
        // The guard's own SAVEPOINT probe ran and hit the "already open, non-aborted transaction"
        // branch (never the 25P01/25P02 branches — this connection's transaction is neither
        // absent nor aborted), so `w4c5_idle_probe` was ROLLBACK-TO'd and then RELEASEd. If
        // `RELEASE SAVEPOINT w4c5_idle_probe` (w4c0-identity.ts:1394) had NOT run, this exact
        // statement would SUCCEED instead (the savepoint would still be defined) — that is the
        // load-bearing distinction this assertion is built to catch.
        await expect(client.query('RELEASE SAVEPOINT w4c5_idle_probe')).rejects.toMatchObject({
          code: '3B001', // invalid_savepoint_specification: "savepoint ... does not exist"
        })
        // That failed RELEASE is itself a normal SQL error inside the (still-open) transaction
        // block, so — same PostgreSQL rule F2 above already exercises — it now poisons the REST
        // of this transaction until a ROLLBACK: every further statement on this connection fails
        // with 25P02, not a dropped connection. Asserting that (rather than a bare "some query
        // still resolves") confirms this was a genuine SQL-level 3B001, not e.g. the connection
        // having been silently reset out from under this test.
        await expect(client.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' })
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }
      expect(await rolloutRow(orgId)).toBeNull()
    })

    it('positive control: an idle connection (the normal call shape) still plans successfully — proves the refusal above is specific to a dirty connection, not a general breakage', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const client = await pool.connect()
      try {
        const plan = await planAttendanceCalculationRolloutTransitionV1(transactionClient(client), {
          orgId,
          targetState: 'shadow',
        })
        expect(plan.rowExists).toBe(false)
        expect(plan.canBootstrap).toBe(true)
        expect(plan.blocked).toBe(false)
      } finally {
        client.release()
      }
      expect(await rolloutRow(orgId)).toBeNull() // still zero-write, same as the zero-write proof above
    })
  })

  describe('P2-1 auto-coverage (PR #4839 gate, 20260809; domain narrowed by F4, PR #4839 P3 gate, 20260810): every DECLARED plan field survives the digest', () => {
    // Complements the fixture-driven table in
    // scripts/ops/attendance-w4c5-rollout-transition-lib.test.ts.
    //
    // F4 (PR #4839 P3 gate, 20260810): this test used to iterate `Object.keys(plan)` — i.e. what
    // ONE runtime plan instance (a fresh, non-existent-row org, target 'shadow') HAS, never what
    // `AttendanceRolloutTransitionPlanV1` (the TYPE) DECLARES. A field that is OPTIONAL and
    // emitted only under some OTHER condition (e.g. only when `persisted.rowExists`) is silently
    // absent from THIS fixture's own `Object.keys()` and so never reaches the loop's
    // alternate-registration check at all — EXECUTED by the gate: adding
    // `futureOptionalField?: string` to the type, emitted only when `rowExists`, and omitting it
    // from `computeAttendanceW4C5PlanDigestV1`'s own `canonical` object, escaped this test
    // silently on exactly this fixture. The shipped claim this test's own comment used to make —
    // "fails loudly (not silently) if a future field has no registered alternate-value case" —
    // was therefore only true for fields present on THIS ONE plan object, not for the type.
    //
    // Fixed by switching the iteration DOMAIN from `Object.keys(plan)` to
    // `Object.keys(PLAN_FIELD_ALTERNATES)`, where `PLAN_FIELD_ALTERNATES` is now typed
    // `Record<keyof AttendanceRolloutTransitionPlanV1, ...>` — TypeScript's structural typing
    // requires an entry for EVERY key of the type (optional keys included: `keyof` does not
    // exclude them), independent of what any one plan instance happens to carry. Mutating a key
    // the real plan never set still proves coverage: the MUTATED object has it, the baseline
    // (computed from the real, unmutated plan) does not — a digest function that never reads that
    // field produces the SAME digest for both, and the assertion reds. A second, independent
    // runtime check (below) still verifies the REVERSE direction — every key the real `plan`
    // object actually carries is present in `PLAN_FIELD_ALTERNATES` — catching the table going
    // stale the other way (a field the type already has but this table forgot).
    //
    // Honest limitation, checked rather than assumed (same shape as the sibling unit-test file's
    // own disclosure): `packages/core-backend/tsconfig.json`'s own `exclude` list contains
    // `**/*.test.ts`, and no `.github/workflows/*.yml` step type-checks `tests/integration/**` —
    // grepped, zero hits (`pnpm type-check` runs `tsc --noEmit` per package, per
    // `.github/workflows/plugin-tests.yml`'s "Run type checking" step, but THIS file is excluded
    // from that package's own compile unit). So the `Record<keyof
    // AttendanceRolloutTransitionPlanV1, ...>` completeness this test now relies on is real for a
    // developer's own local `tsc`/editor, but is NOT mechanically enforced by this repo's CI
    // today — a future field silently added to the type without extending
    // `PLAN_FIELD_ALTERNATES` would not be caught by a CI run of THIS test; only the reverse
    // runtime check below would catch it, and only once that field is actually SET on this
    // fixture. This test is strictly STRONGER than the one-runtime-instance version it replaces
    // (it now catches a conditionally-omitted field too, via the type-level table), but it no
    // longer offers unconditional "no human needs to remember anything, in CI" — that property
    // was never actually true for a conditionally-emitted field, which is exactly what F4 found.
    it('mutating ANY declared plan field changes the digest — a table entry missing for a type field fails a local tsc; a table entry missing for a REAL plan field throws here', async () => {
      const orgId = crypto.randomUUID()
      allow(orgId)
      const client = await pool.connect()
      let plan: AttendanceRolloutTransitionPlanV1
      try {
        plan = await planAttendanceCalculationRolloutTransitionV1(transactionClient(client), {
          orgId,
          targetState: 'shadow',
        })
      } finally {
        client.release()
      }
      // Sanity on the fixture this test relies on: a bootstrap-eligible legacy->shadow plan
      // reaches the deep predicate branch, so `predicates` has more than one real, distinct entry
      // to mutate below (never an empty/degenerate array), and includes at least one predicate
      // with a non-null `count` (the deep branch's `UNCLOSED_LEGACY_BATCH` et al. — the first
      // three predicates, `ORG_ALLOWLISTED`/`ROLLOUT_ROW_RESOLVABLE`/`LEGAL_TRANSITION_PAIR`, are
      // always `count: null` by construction; see `w4c3a-rollout-control.ts`'s `passVerdict`
      // calls).
      expect(plan.predicates.length).toBeGreaterThan(1)

      const baseline = computeAttendanceW4C5PlanDigestV1(plan)

      const PLAN_FIELD_ALTERNATES: Record<keyof AttendanceRolloutTransitionPlanV1, (current: unknown) => unknown> = {
        orgId: () => crypto.randomUUID(),
        orgAllowlisted: (v) => !v,
        rowExists: (v) => !v,
        currentState: (v) => (v === 'shadow' ? 'eligible' : 'shadow'),
        currentVersion: (v) => (typeof v === 'number' ? v + 1000 : 1),
        priorState: (v) => (v === 'legacy' ? 'shadow' : 'legacy'),
        targetState: (v) => (v === 'shadow' ? 'eligible' : 'shadow'),
        legalPair: (v) => !v,
        comparisonWritePosture: (v) => (v === 'shadow' ? 'authoritative' : 'shadow'),
        canBootstrap: (v) => !v,
        blocked: (v) => !v,
        predicates: (v) => {
          const arr = v as readonly AttendanceRolloutTransitionPredicateV1[]
          return [...arr, { code: arr[0].code, applicable: arr[0].applicable, pass: !arr[0].pass, count: 999 }]
        },
      }

      // Reverse-direction check (runtime, independent of tsc): every field the REAL plan object
      // actually carries must be accounted for — catches the table going stale the other way.
      for (const key of Object.keys(plan)) {
        if (!(key in PLAN_FIELD_ALTERNATES)) {
          throw new Error(
            `Real plan object has field '${key}' with no registered alternate-value generator in ` +
              `PLAN_FIELD_ALTERNATES — the coverage table has gone stale relative to the real boundary ` +
              `output. Add an entry before this can be proven covered by computeAttendanceW4C5PlanDigestV1.`,
          )
        }
      }

      // Forward-direction coverage: iterate the TYPE-COMPLETE table, not the one runtime object —
      // this is the actual F4 fix. A field the real plan never set (e.g. a future
      // conditionally-emitted optional field) is still mutated and still proven to move the
      // digest, because the alternate is applied to a COPY, never read back from `plan` itself.
      for (const key of Object.keys(PLAN_FIELD_ALTERNATES) as Array<keyof AttendanceRolloutTransitionPlanV1>) {
        const alt = PLAN_FIELD_ALTERNATES[key]
        const mutated = { ...plan, [key]: alt((plan as Record<string, unknown>)[key]) } as AttendanceRolloutTransitionPlanV1
        const digest = computeAttendanceW4C5PlanDigestV1(mutated)
        expect(digest, `mutating '${key}' must change the digest`).not.toBe(baseline)
      }

      // Predicate sub-fields: mutate the FIRST predicate's own fields one at a time (structure
      // otherwise unchanged) — the loop above only proves the `predicates` array AS A WHOLE
      // participates; this proves each of `code`/`applicable`/`pass`/`count` individually does.
      const PREDICATE_FIELD_ALTERNATES: Record<
        keyof AttendanceRolloutTransitionPredicateV1,
        (current: unknown) => unknown
      > = {
        code: () => plan.predicates[1].code, // a genuinely different REAL code, never a fabricated enum value
        applicable: (v) => !v,
        pass: (v) => !v,
        // F3-class straddle (PR #4839 P3 gate, 20260810): `firstPredicate.count` (below) is
        // `null` by construction (`ORG_ALLOWLISTED` never carries a count) — mutating null to
        // ANY non-null value proves `count` is PRESENT in the digest, never that its VALUE
        // survives (a bucketing mutant collapsing every non-null count to one constant would
        // still redden this row, for the wrong reason: the null/non-null boundary, not the
        // value). See the dedicated `count`-only assertion below, which uses a predicate with a
        // non-null baseline instead.
        count: (v) => (typeof v === 'number' ? v + 999 : 999),
      }
      const firstPredicate = plan.predicates[0]
      for (const key of Object.keys(firstPredicate)) {
        if (!(key in PREDICATE_FIELD_ALTERNATES)) {
          throw new Error(
            `Real predicate object has field '${key}' with no registered alternate — a field was added to ` +
              `AttendanceRolloutTransitionPredicateV1 without extending this P2-1 auto-coverage test.`,
          )
        }
      }
      for (const key of Object.keys(PREDICATE_FIELD_ALTERNATES) as Array<keyof AttendanceRolloutTransitionPredicateV1>) {
        if (key === 'count') continue // covered by the dedicated non-null-baseline assertion below
        const alt = PREDICATE_FIELD_ALTERNATES[key]
        const mutatedPredicate = {
          ...firstPredicate,
          [key]: alt((firstPredicate as Record<string, unknown>)[key]),
        } as AttendanceRolloutTransitionPredicateV1
        const mutatedPlan: AttendanceRolloutTransitionPlanV1 = {
          ...plan,
          predicates: [mutatedPredicate, ...plan.predicates.slice(1)],
        }
        const digest = computeAttendanceW4C5PlanDigestV1(mutatedPlan)
        expect(digest, `mutating predicate field '${key}' must change the digest`).not.toBe(baseline)
      }

      // count, VALUE preservation (not mere presence): use a REAL predicate from the deep branch
      // whose baseline count is already non-null, mutated to a DIFFERENT non-null value. Under a
      // bucketing mutant that collapses every non-null count to one constant, both baseline and
      // mutated collapse to the same value and this assertion reds — unlike a null -> non-null
      // mutation, which would redden even under that mutant.
      const nonNullCountIndex = plan.predicates.findIndex((p) => p.count !== null)
      expect(nonNullCountIndex, 'fixture drifted — expected at least one deep-branch predicate with a non-null count').toBeGreaterThanOrEqual(0)
      const nonNullCountPredicate = plan.predicates[nonNullCountIndex]
      const mutatedCountPredicate = {
        ...nonNullCountPredicate,
        count: (nonNullCountPredicate.count as number) + 999,
      }
      const mutatedCountPlan: AttendanceRolloutTransitionPlanV1 = {
        ...plan,
        predicates: plan.predicates.map((p, i) => (i === nonNullCountIndex ? mutatedCountPredicate : p)),
      }
      expect(computeAttendanceW4C5PlanDigestV1(mutatedCountPlan), "mutating predicate field 'count' (non-null -> different non-null) must change the digest").not.toBe(baseline)
    })
  })
})
