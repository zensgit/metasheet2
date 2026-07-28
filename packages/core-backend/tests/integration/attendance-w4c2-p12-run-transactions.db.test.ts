/**
 * W4C-2 P1-2 (#4556) — TRANSACTIONAL half of the RATIFIED scheduled-run identity amendment
 * (docs/development/attendance-issue-4556-w4c2-scheduled-run-identity-amendment-20260726.md,
 * PR #4617, owner Bundle A = 44a/45a/46a/47a/48a/49a/50a/51a/52a/53(i)) against real Postgres.
 *
 * SCOPE (the second half of section 4 step 3 — the schema/identity/enqueue half is the
 * SIBLING file `attendance-w4c2-p12-migration-schema-gates.db.test.ts`; this file covers the
 * run-creation/resume transaction (section 1.7), the finalization transaction (section 1.8),
 * the `O-3=(a)` per-target outcome writer (section 1.1.1), the `abandoned` transition
 * (section 1.1.2), the `O-4=(a)` promotion-block guard (section 1.7.1), and the recovery-sweep
 * step function).
 *
 * Shared-DB discipline: this file self-provisions its OWN scratch database (mirrors the
 * migration-lifecycle file's own pattern) so its concurrency legs never collide with fixtures
 * in a shared test database. Every fixture identity is namespaced `w4c2p12txn<run>`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import ts from 'typescript'
import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import { up as w4c2Up } from '../../src/db/migrations/zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union'
import {
  createOrResumeAttendanceScheduledRunV1,
  finalizeAttendanceScheduledRunV1,
  recordAttendanceScheduledRunTargetOutcomeV1,
  abandonAttendanceScheduledRunV1,
  scanAttendanceScheduledRunSweepCandidatesV1,
  sweepAttendanceScheduledRunCandidateV1,
  resumeAttendanceScheduledRunByExactIdV1,
  resolveAttendanceScheduledRunTargetSetV1,
  computeAttendanceScheduledRunTargetSetFingerprintV1,
  type AttendanceScheduledRunMemberInputV1,
  type AttendanceScheduledRunMembershipResolverV1,
} from '../../src/attendance/w4c2-scheduled-run'
import { sweepAttendanceScheduledRunsOnceV1 } from '../../src/attendance/w4c2-scheduled-run-ops-worker'
import { createVerifiedAttendanceOperationIdentityV1, createVerifiedAttendanceOrgIdentityV1, resolveSegmentCalculationPosture } from '../../src/attendance/w4c0-identity'
import { createAuthorizedAttendanceWriteContextV1 } from '../../src/attendance/w4c0-authorization'
import {
  cancelAttendanceResultOperationV1,
  runAttendanceResultOperationTransactionV1,
} from '../../src/attendance/w4c0-operation-registry'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const RUN = crypto.randomUUID().slice(0, 8)
const NS = 'w4c2p12txn' + RUN

function uuid(): string {
  return crypto.randomUUID()
}

/** Deterministic per-test org id (canonical UUID syntax required by the identity layer). */
function orgIdFor(label: string): string {
  return crypto.createHash('sha1').update(NS + ':org:' + label).digest('hex').slice(0, 32).replace(
    /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
    '$1-$2-$3-$4-$5',
  )
}

async function catchAsync<T>(fn: () => Promise<T>): Promise<unknown> {
  try {
    await fn()
    return undefined
  } catch (error) {
    return error
  }
}

interface RecordedStatement {
  readonly sql: string
  readonly params: readonly unknown[]
}

function recordingTrx(
  inner: AttendanceW4TransactionClientV1,
  log: RecordedStatement[],
): AttendanceW4TransactionClientV1 {
  return {
    async query(sql: string, params?: unknown[]) {
      log.push({ sql, params: params ?? [] })
      return inner.query(sql, params as unknown[])
    },
  } as AttendanceW4TransactionClientV1
}

const SOURCE_DML_RE =
  /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(attendance_events|attendance_records|attendance_requests|attendance_record_result_edits|attendance_import_batches|attendance_import_items)\b/i

function listTypeScriptFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

function scheduledOutcomeCallsites(): {
  completed: string[]
  unsafe: string[]
} {
  const completed: string[] = []
  const unsafe: string[] = []
  const srcRoot = fileURLToPath(new URL('../../src', import.meta.url))

  for (const file of listTypeScriptFiles(srcRoot)) {
    const source = readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const localWriterNames = new Set<string>()

    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings) continue
      if (!ts.isNamedImports(statement.importClause.namedBindings)) continue
      for (const specifier of statement.importClause.namedBindings.elements) {
        if ((specifier.propertyName ?? specifier.name).text === 'recordAttendanceScheduledRunTargetOutcomeV1') {
          localWriterNames.add(specifier.name.text)
        }
      }
    }

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const isDirectWriter =
          (ts.isIdentifier(node.expression) && localWriterNames.has(node.expression.text)) ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'recordAttendanceScheduledRunTargetOutcomeV1')
        if (isDirectWriter) {
          const outcome = node.arguments[2]
          const terminalOutcome =
            outcome && ts.isObjectLiteralExpression(outcome)
              ? outcome.properties.find(
                  (property): property is ts.PropertyAssignment =>
                    ts.isPropertyAssignment(property) &&
                    ((ts.isIdentifier(property.name) && property.name.text === 'terminalOutcome') ||
                      (ts.isStringLiteral(property.name) && property.name.text === 'terminalOutcome')),
                )
              : undefined
          const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          const label = `${file}:${location.line + 1}`
          if (
            terminalOutcome &&
            ts.isStringLiteral(terminalOutcome.initializer) &&
            terminalOutcome.initializer.text === 'completed'
          ) {
            completed.push(label)
          } else {
            unsafe.push(label)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  return { completed, unsafe }
}

function namedCancelFixtureCallsites(): string[] {
  const file = fileURLToPath(import.meta.url)
  const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const callsites: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'cancelAttendanceResultOperationV1'
    ) {
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      callsites.push(`${file}:${location.line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return callsites
}

describeIfDatabase('W4C-2 P1-2 — run-creation/resume/finalization/abandoned transactions (real DB)', () => {
  const scratchName = `ms2_w4c2_p12txn_${RUN}`
  let adminPool: Pool
  let pool: Pool
  let kyselyPool: Pool
  let scratchDb: Kysely<unknown>

  beforeAll(async () => {
    const adminUrl = new URL(dbUrl as string)
    adminUrl.pathname = '/postgres'
    adminPool = new Pool({ connectionString: adminUrl.toString() })
    await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
    await adminPool.query(`CREATE DATABASE ${scratchName}`)
    const scratchUrl = new URL(dbUrl as string)
    scratchUrl.pathname = `/${scratchName}`
    pool = new Pool({ connectionString: scratchUrl.toString() })
    kyselyPool = new Pool({ connectionString: scratchUrl.toString() })
    scratchDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: kyselyPool }) })

    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    await pool.query(`
      CREATE TABLE attendance_records (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL, work_date date NOT NULL, first_in_at timestamptz, last_out_at timestamptz,
        work_minutes integer NOT NULL DEFAULT 0, late_minutes integer NOT NULL DEFAULT 0,
        early_leave_minutes integer NOT NULL DEFAULT 0, status varchar(64) NOT NULL DEFAULT 'normal',
        org_id text NOT NULL DEFAULT 'default')`)
    await pool.query(`
      CREATE TABLE attendance_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL, work_date date NOT NULL, request_type varchar(30) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'pending', org_id text NOT NULL DEFAULT 'default')`)
    await pool.query(`
      CREATE TABLE attendance_import_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL DEFAULT 'default',
        batch_id uuid NOT NULL, created_by text NOT NULL, idempotency_key text,
        status varchar(20) NOT NULL DEFAULT 'queued', progress integer NOT NULL DEFAULT 0,
        total integer NOT NULL DEFAULT 0, payload jsonb NOT NULL DEFAULT '{}'::jsonb)`)

    await w4c0Up(scratchDb)
    await w4c2Up(scratchDb)
  }, 120000)

  afterAll(async () => {
    for (const p of [pool, kyselyPool, adminPool]) p?.on('error', () => undefined)
    await scratchDb?.destroy()
    await pool?.end()
    await adminPool?.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).catch(() => undefined)
    await adminPool?.end()
  })

  async function setRolloutState(orgId: string, state: 'legacy' | 'shadow' | 'eligible' | 'authoritative' | 'suspended'): Promise<void> {
    const existing = await pool.query('SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1', [orgId])
    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
         VALUES ($1,'legacy','v1','w4c2p12txn-seed','w4c2p12txn-actor',1,NULL)`,
        [orgId],
      )
    }
    let current = (await pool.query('SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1', [orgId])).rows[0]
    // Legal transitions only (mirrors attendance_w4_rollout_state_guard()): legacy->shadow,
    // shadow->eligible|legacy, eligible->authoritative|shadow, authoritative->suspended,
    // suspended->authoritative. `suspended` is reachable ONLY via authoritative.
    const NEXT_HOP: Record<string, Record<string, string>> = {
      legacy: { shadow: 'shadow', eligible: 'shadow', authoritative: 'shadow', suspended: 'shadow' },
      shadow: { legacy: 'legacy', eligible: 'eligible', authoritative: 'eligible', suspended: 'eligible' },
      eligible: { shadow: 'shadow', authoritative: 'authoritative', suspended: 'authoritative' },
      authoritative: { suspended: 'suspended' },
      suspended: { authoritative: 'authoritative' },
    }
    let guard = 0
    while (current.state !== state) {
      guard += 1
      if (guard > 10) throw new Error(`test setRolloutState: no path from ${current.state} to ${state}`)
      const next = NEXT_HOP[current.state as string]?.[state]
      if (!next) throw new Error(`test setRolloutState: no path from ${current.state} to ${state}`)
      await pool.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = $2, prior_state = $3, version = $4, changed_at = now()
          WHERE org_id = $1`,
        [orgId, next, current.state, Number(current.version) + 1],
      )
      current = (await pool.query('SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1', [orgId])).rows[0]
    }
  }

  /** Sets the allowlist to include ALL given org ids for the duration of `fn`. NOT safe to
   * nest/parallelize two separate `withAllowlist` calls with different org sets (the env var
   * is process-global) — callers that need multiple orgs pass them all in one call. */
  async function withAllowlist<T>(orgIds: string | readonly string[], fn: () => Promise<T>): Promise<T> {
    const ids = Array.isArray(orgIds) ? orgIds : [orgIds as string]
    const prior = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = [prior, ...ids].filter(Boolean).join(',')
    try {
      return await fn()
    } finally {
      if (prior === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = prior
    }
  }

  function memberResolverFor(
    members: readonly AttendanceScheduledRunMemberInputV1[],
  ): AttendanceScheduledRunMembershipResolverV1 {
    return async () => members
  }

  /**
   * Delegates to the CANONICAL SERIALIZABLE wrapper (`runAttendanceResultOperationTransactionV1`,
   * w4c0-operation-registry.ts, lock section 8.2) rather than a bespoke BEGIN/COMMIT — that
   * wrapper's bounded whole-transaction retry on SQLSTATE 40001/40P01 is production behavior,
   * not test convenience: under real `SERIALIZABLE` isolation, two genuinely concurrent
   * finalizers/abandons can produce a true read/write-dependency `40001` (Postgres SSI), not
   * only a `FOR UPDATE` lock wait — gate 7/23's "no `23505`/`55P03` escapes, the loser retries"
   * shape is stated against a caller that retries on `40001`, exactly as this wrapper does.
   */
  async function withTxn<T>(fn: (trx: AttendanceW4TransactionClientV1) => Promise<T>): Promise<T> {
    const c: PoolClient = await pool.connect()
    try {
      return await runAttendanceResultOperationTransactionV1(c as unknown as AttendanceW4TransactionClientV1, fn)
    } finally {
      c.release()
    }
  }

  /**
   * Claims AND seals/cancels the per-user operation row in ONE transaction (mirrors production:
   * `attendanceResultOperationPreflightV1` claims and the caller seals within the SAME
   * transaction). A bare `pool.query()` INSERT of a `claimed` row, committed alone, is REJECTED
   * by `attendance_w4_operations_claimed_commit_guard()` (a deferred constraint — "claimed" is
   * a transient, never-committed-alone state by design) — this helper's single-transaction
   * shape is required, not a convenience.
   */
  async function sealGenerateTarget(
    orgId: string,
    runId: string,
    userId: string,
    workDate: string,
    outcome: 'completed' | 'failed',
    inserted: boolean,
  ): Promise<RecordedStatement[]> {
    const t = await pool.query(
      `SELECT operation_id::text AS operation_id FROM attendance_scheduled_run_targets
        WHERE org_id = $1 AND run_id = $2::uuid AND user_id = $3::uuid AND target_kind = 'generate'`,
      [orgId, runId, userId],
    )
    const operationId = t.rows[0].operation_id as string
    const statements: RecordedStatement[] = []
    await withTxn(async (innerTrx) => {
      const trx = recordingTrx(innerTrx, statements)
      await trx.query(
        `INSERT INTO attendance_result_operations (
            org_id, entrypoint, operation_id, identity_source_kind, source_root_id, proof_user_id, proof_work_date,
            source_ref, actor_id, actor_posture, capability, subject_scope, command_fingerprint, accepted_write_posture, state
          ) VALUES ($1,'scheduled',$2,'scheduled',$3,$4,$5,'ref:w4c2p12txn','actor-w4c2p12txn','scheduler','scheduled','{}'::jsonb,$6,'shadow','claimed')`,
        [orgId, operationId, runId, userId, workDate, 'a'.repeat(64)],
      )
      const org = createVerifiedAttendanceOrgIdentityV1({
        orgKey: orgId,
        posture: await resolveSegmentCalculationPosture(trx, orgId),
      })
      const identity = createVerifiedAttendanceOperationIdentityV1({
        org,
        kind: 'item',
        entrypoint: 'scheduled',
        source: { sourceKind: 'scheduled', scheduledRunId: runId, userId, workDate },
      })
      if (outcome === 'completed') {
        await trx.query(
          `UPDATE attendance_result_operations
              SET state = 'completed', response_snapshot = $3::jsonb, version = version + 1, updated_at = now()
            WHERE org_id = $1 AND entrypoint = 'scheduled' AND operation_id = $2::uuid AND state = 'claimed'`,
          [orgId, operationId, JSON.stringify({ inserted })],
        )
        await recordAttendanceScheduledRunTargetOutcomeV1(trx, identity, { terminalOutcome: 'completed' })
      } else {
        await cancelAttendanceResultOperationV1(trx, identity)
        await recordAttendanceScheduledRunTargetOutcomeV1(trx, identity, {
          terminalOutcome: 'failed',
          failureReasonCode: 'ATTENDANCE_SCHEDULED_TARGET_OPERATION_REJECTED',
        })
      }
    })
    return statements
  }

  it('OD-W4C-54=(a) keeps every production scheduled outcome writer completed-only', () => {
    const callsites = scheduledOutcomeCallsites()
    expect(callsites.completed.length).toBeGreaterThan(0)
    expect(callsites.unsafe).toEqual([])
  })

  it('OD-W4C-54=(a) binds the failed contract fixture to the named cancel writer', () => {
    expect(namedCancelFixtureCallsites()).toHaveLength(1)
  })

  // ===========================================================================================
  // 1. Pure ordinal/fingerprint (51=a): unit-shaped, co-located here for real-schema round trip.
  // ===========================================================================================
  describe('section 1.2/1.3 — target-set resolution + fingerprint (O-2=(a))', () => {
    it('pins ORDER BY user_id ascending regardless of input order, and is a pure function of membership', () => {
      const userA = '00000000-0000-4000-8000-000000000001'
      const userB = '00000000-0000-4000-8000-000000000002'
      const userC = '00000000-0000-4000-8000-000000000003'
      const membersOrderA: AttendanceScheduledRunMemberInputV1[] = [
        { userId: userC, targetKind: 'generate', reviewReasonCode: null },
        { userId: userA, targetKind: 'review', reviewReasonCode: 'NO_MATCHING_SHIFT' },
        { userId: userB, targetKind: 'generate', reviewReasonCode: null },
      ]
      const membersOrderB = [...membersOrderA].reverse()
      const planA = resolveAttendanceScheduledRunTargetSetV1(membersOrderA)
      const planB = resolveAttendanceScheduledRunTargetSetV1(membersOrderB)
      expect(planA.map((t) => t.userId)).toEqual([userA, userB, userC])
      expect(planA.map((t) => t.ordinal)).toEqual([0, 1, 2])
      expect(planB).toEqual(planA)
      const key = { orgId: orgIdFor('fp'), initiator: 'cron', workDate: '2026-01-05' }
      expect(computeAttendanceScheduledRunTargetSetFingerprintV1(key, planA)).toBe(
        computeAttendanceScheduledRunTargetSetFingerprintV1(key, planB),
      )
    })

    it('a one-user membership difference changes the fingerprint', () => {
      const userA = '00000000-0000-4000-8000-000000000001'
      const userB = '00000000-0000-4000-8000-000000000002'
      const userD = '00000000-0000-4000-8000-000000000004'
      const key = { orgId: orgIdFor('fp2'), initiator: 'cron', workDate: '2026-01-05' }
      const planA = resolveAttendanceScheduledRunTargetSetV1([
        { userId: userA, targetKind: 'generate', reviewReasonCode: null },
        { userId: userB, targetKind: 'generate', reviewReasonCode: null },
      ])
      const planB = resolveAttendanceScheduledRunTargetSetV1([
        { userId: userA, targetKind: 'generate', reviewReasonCode: null },
        { userId: userD, targetKind: 'generate', reviewReasonCode: null },
      ])
      expect(computeAttendanceScheduledRunTargetSetFingerprintV1(key, planA)).not.toBe(
        computeAttendanceScheduledRunTargetSetFingerprintV1(key, planB),
      )
    })

    it('rejects an unlisted review reason code before any DB round trip', () => {
      const userA = '00000000-0000-4000-8000-000000000001'
      expect(() =>
        resolveAttendanceScheduledRunTargetSetV1([
          { userId: userA, targetKind: 'review', reviewReasonCode: 'NOT_A_REAL_CODE' },
        ]),
      ).toThrow(/W4C2_SCHEDULED_RUN_MEMBER_REVIEW_REASON_INVALID/)
    })
  })

  // ===========================================================================================
  // 2. Run creation: happy path, ordinal/derived-identity, zero-generate inline finalization.
  // ===========================================================================================
  describe('section 1.7 — run creation', () => {
    it('creates a running run with frozen target rows in ORDER BY user_id order and correctly derived operation_id', async () => {
      const orgId = orgIdFor('create1')
      await setRolloutState(orgId, 'shadow')
      // Fixed, lexicographically-ordered literals (never crypto.randomUUID()) so the ordinal
      // assertion below does not depend on which random UUID happens to sort first — the input
      // array below is deliberately given in the OPPOSITE (userHigh, userLow) order to prove the
      // ordering comes from `ORDER BY user_id`, not from input/insertion order.
      const userLow = '00000000-0000-4000-8000-00000000aaaa'
      const userHigh = '00000000-0000-4000-8000-00000000bbbb'
      const workDate = '2026-02-01'
      await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([
              { userId: userHigh, targetKind: 'generate', reviewReasonCode: null },
              { userId: userLow, targetKind: 'review', reviewReasonCode: 'NO_MATCHING_SHIFT' },
            ]),
          ),
        ),
      )
      const rows = await pool.query(
        `SELECT ordinal, user_id, target_kind, operation_id FROM attendance_scheduled_run_targets
          WHERE org_id = $1 ORDER BY ordinal ASC`,
        [orgId],
      )
      expect(rows.rows.map((r: { user_id: string }) => r.user_id)).toEqual([userLow, userHigh])
      expect(rows.rows[1].operation_id).not.toBeNull()
      expect(rows.rows[0].operation_id).toBeNull()
      const runRow = await pool.query(`SELECT state, expected_user_count, review_count FROM attendance_scheduled_runs WHERE org_id = $1`, [orgId])
      expect(runRow.rows[0]).toEqual({ state: 'running', expected_user_count: 1, review_count: 1 })
    })

    it('section 1.9: zero-generate-target run finalizes inline, in the SAME transaction (gate 8/19)', async () => {
      const orgId = orgIdFor('zerogen')
      await setRolloutState(orgId, 'shadow')
      const userA = uuid()
      const outcome = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate: '2026-02-02' },
            memberResolverFor([{ userId: userA, targetKind: 'review', reviewReasonCode: 'NO_MATCHING_SHIFT' }]),
          ),
        ),
      )
      expect(outcome.kind).toBe('created_and_finalized')
      const runRow = await pool.query(
        `SELECT state, completed_user_count, generated_count, review_count FROM attendance_scheduled_runs WHERE org_id = $1`,
        [orgId],
      )
      expect(runRow.rows[0]).toEqual({ state: 'completed', completed_user_count: 0, generated_count: 0, review_count: 1 })
      const outbox = await pool.query(
        `SELECT event_kind, payload FROM attendance_result_event_outbox WHERE org_id = $1 ORDER BY event_kind`,
        [orgId],
      )
      expect(outbox.rows.map((r: { event_kind: string }) => r.event_kind)).toEqual([
        'attendance.absence.generated',
        'attendance.work_date.review_required',
      ])
      const reviewPayload = outbox.rows[1].payload as { total: number; reasons: Array<{ userId: string }> }
      expect(reviewPayload.total).toBe(1)
      expect(reviewPayload.reasons).toEqual([{ userId: userA, reasonCode: 'NO_MATCHING_SHIFT' }])
    })

    it('org_legacy_zero_rows / org_suspended_deferred: zero W4 rows created either way', async () => {
      const orgLegacy = orgIdFor('legacy1')
      const outcomeLegacy = await withTxn((trx) =>
        createOrResumeAttendanceScheduledRunV1(
          trx,
          { orgId: orgLegacy, initiator: 'cron', workDate: '2026-02-03' },
          memberResolverFor([]),
        ),
      )
      expect(outcomeLegacy).toEqual({ kind: 'org_legacy_zero_rows' })
      expect((await pool.query('SELECT count(*)::int AS n FROM attendance_scheduled_runs WHERE org_id=$1', [orgLegacy])).rows[0].n).toBe(0)

      const orgSuspended = orgIdFor('suspended1')
      await setRolloutState(orgSuspended, 'suspended')
      const outcomeSuspended = await withAllowlist(orgSuspended, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId: orgSuspended, initiator: 'cron', workDate: '2026-02-03' },
            memberResolverFor([]),
          ),
        ),
      )
      expect(outcomeSuspended).toEqual({ kind: 'org_suspended_deferred' })
      expect((await pool.query('SELECT count(*)::int AS n FROM attendance_scheduled_runs WHERE org_id=$1', [orgSuspended])).rows[0].n).toBe(0)
    })
  })

  // ===========================================================================================
  // 3. Full lifecycle: create -> per-user outcomes -> finalize; gate 20's contract-only failed-target leg.
  // ===========================================================================================
  describe('section 1.7/1.8/1.1.1 — failed-outcome representation contract', () => {
    it('a contract fixture uses the named cancel writer with zero source DML and finalizes a mixed run', async () => {
      const orgId = orgIdFor('lifecycle1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-02-04'
      const [userA, userB, userC] = [uuid(), uuid(), uuid()]
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([
              { userId: userA, targetKind: 'generate', reviewReasonCode: null },
              { userId: userB, targetKind: 'generate', reviewReasonCode: null },
              { userId: userC, targetKind: 'generate', reviewReasonCode: null },
            ]),
          ),
        ),
      )
      if (created.kind !== 'created_running') throw new Error('expected created_running')
      const runId = created.runId

      await sealGenerateTarget(orgId, runId, userA, workDate, 'completed', true)
      await sealGenerateTarget(orgId, runId, userB, workDate, 'completed', false)
      const failedStatements = await sealGenerateTarget(orgId, runId, userC, workDate, 'failed', false)
      expect(SOURCE_DML_RE.test('INSERT INTO attendance_records (id) VALUES ($1)')).toBe(true)
      expect(failedStatements.filter((statement) => SOURCE_DML_RE.test(statement.sql))).toEqual([])

      const outcome = await withAllowlist(orgId, () =>
        withTxn((trx) => finalizeAttendanceScheduledRunV1(trx, { orgId, initiator: 'cron', workDate, runId })),
      )
      expect(outcome).toEqual({ kind: 'finalized', runId, completedUserCount: 2, generatedCount: 1, reviewCount: 0 })
      const runRow = await pool.query(`SELECT state, completed_user_count, generated_count FROM attendance_scheduled_runs WHERE run_id = $1::uuid`, [runId])
      expect(runRow.rows[0]).toEqual({ state: 'completed', completed_user_count: 2, generated_count: 1 })
      const outboxCount = await pool.query(`SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE scheduled_run_id = $1::uuid`, [runId])
      expect(outboxCount.rows[0].n).toBe(1) // review_count=0 => only attendance.absence.generated

      // gate 20 added leg: a second outcome insert for the same (already-outcome-bearing) target fails uq_asrto_target.
      const dup = await catchAsync(() =>
        pool.query(
          `INSERT INTO attendance_scheduled_run_target_outcomes (org_id, run_id, target_id, terminal_outcome)
           SELECT org_id, run_id, id, 'completed' FROM attendance_scheduled_run_targets
            WHERE org_id = $1 AND run_id = $2::uuid AND user_id = $3::uuid`,
          [orgId, runId, userA],
        ),
      )
      expect(String((dup as { message?: string })?.message || '')).toMatch(/uq_asrto_target/)
    })

    it('finalization is not admitted while a generate target has no outcome row yet (not_ready, zero DML)', async () => {
      const orgId = orgIdFor('notready1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-02-05'
      const userA = uuid()
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([{ userId: userA, targetKind: 'generate', reviewReasonCode: null }]),
          ),
        ),
      )
      if (created.kind !== 'created_running') throw new Error('expected created_running')
      const outcome = await withAllowlist(orgId, () =>
        withTxn((trx) => finalizeAttendanceScheduledRunV1(trx, { orgId, initiator: 'cron', workDate, runId: created.runId })),
      )
      expect(outcome).toEqual({ kind: 'not_ready' })
      const runRow = await pool.query(`SELECT state FROM attendance_scheduled_runs WHERE run_id = $1::uuid`, [created.runId])
      expect(runRow.rows[0].state).toBe('running')
    })
  })

  // ===========================================================================================
  // 4. Resume protocol.
  // ===========================================================================================
  describe('section 1.7 — resume protocol', () => {
    it('a second create-or-resume call on the SAME key resumes the SAME run (no duplicate row) and reports the correct outstanding set', async () => {
      const orgId = orgIdFor('resume1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-02-06'
      const [userA, userB] = [uuid(), uuid()]
      const members = [
        { userId: userA, targetKind: 'generate' as const, reviewReasonCode: null },
        { userId: userB, targetKind: 'generate' as const, reviewReasonCode: null },
      ]
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) => createOrResumeAttendanceScheduledRunV1(trx, { orgId, initiator: 'cron', workDate }, memberResolverFor(members))),
      )
      if (created.kind !== 'created_running') throw new Error('expected created_running')
      await sealGenerateTarget(orgId, created.runId, userA, workDate, 'completed', true)

      const resumed = await withAllowlist(orgId, () =>
        withTxn((trx) => createOrResumeAttendanceScheduledRunV1(trx, { orgId, initiator: 'cron', workDate }, memberResolverFor(members))),
      )
      expect(resumed.kind).toBe('resumed')
      if (resumed.kind !== 'resumed') throw new Error('unreachable')
      expect(resumed.runId).toBe(created.runId)
      expect(resumed.outstandingGenerateTargets.map((t) => t.userId)).toEqual([userB])
      expect(resumed.readyToFinalize).toBe(false)

      const runCount = await pool.query(`SELECT count(*)::int AS n FROM attendance_scheduled_runs WHERE org_id = $1`, [orgId])
      expect(runCount.rows[0].n).toBe(1)
    })

    it('a fingerprint drift on resume is fail-closed remediation (gate 10), never a silent replan', async () => {
      const orgId = orgIdFor('resumedrift1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-02-07'
      const userA = uuid()
      const userExtra = uuid()
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([{ userId: userA, targetKind: 'generate', reviewReasonCode: null }]),
          ),
        ),
      )
      expect(created.kind).toBe('created_running')
      const err = await catchAsync(() =>
        withAllowlist(orgId, () =>
          withTxn((trx) =>
            createOrResumeAttendanceScheduledRunV1(
              trx,
              { orgId, initiator: 'cron', workDate },
              memberResolverFor([
                { userId: userA, targetKind: 'generate', reviewReasonCode: null },
                { userId: userExtra, targetKind: 'generate', reviewReasonCode: null },
              ]),
            ),
          ),
        ),
      )
      expect(String((err as { code?: string })?.code)).toBe('W4C2_SCHEDULED_RUN_RESUME_TARGET_SET_DRIFT')
    })
  })

  // ===========================================================================================
  // 5. TOCTOU: two real connections race to create the SAME run.
  // ===========================================================================================
  describe('TOCTOU — concurrent run creation on the same key', () => {
    it('exactly one row is ever running; the loser resumes the winner (no raw 23505/40001 escapes)', async () => {
      const orgId = orgIdFor('toctou1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-02-08'
      const userA = uuid()
      const members = [{ userId: userA, targetKind: 'generate' as const, reviewReasonCode: null }]

      const results = await withAllowlist(orgId, () =>
        Promise.allSettled([
          withTxn((trx) => createOrResumeAttendanceScheduledRunV1(trx, { orgId, initiator: 'cron', workDate }, memberResolverFor(members))),
          withTxn((trx) => createOrResumeAttendanceScheduledRunV1(trx, { orgId, initiator: 'cron', workDate }, memberResolverFor(members))),
        ]),
      )

      for (const r of results) {
        if (r.status === 'rejected') {
          const code = (r.reason as { code?: string })?.code
          expect(code).not.toBe(undefined)
          // Never a raw driver SQLSTATE surfacing as the thrown identity — this line's own
          // busy code, if the class-01 helper timed out, is the only acceptable throw shape.
          expect(code).not.toBe('23505')
          expect(code).not.toBe('40001')
        }
      }
      const fulfilled = results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<unknown>).value)
      expect(fulfilled.length).toBeGreaterThanOrEqual(1)
      const runIds = new Set(
        fulfilled
          .map((v) => v as { kind: string; runId?: string })
          .filter((v) => v.kind === 'created_running' || v.kind === 'resumed')
          .map((v) => v.runId),
      )
      expect(runIds.size).toBe(1)
      const runningCount = await pool.query(
        `SELECT count(*)::int AS n FROM attendance_scheduled_runs WHERE org_id = $1 AND state = 'running'`,
        [orgId],
      )
      expect(runningCount.rows[0].n).toBe(1)
    })
  })

  // ===========================================================================================
  // 6. Gate 7 — concurrent finalization is serialized.
  // ===========================================================================================
  describe('gate 7 — concurrent finalization', () => {
    it('two connections finalize the same ready run simultaneously: exactly one flips state and inserts outbox rows', async () => {
      const orgId = orgIdFor('finrace1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-02-09'
      const userA = uuid()
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([{ userId: userA, targetKind: 'generate', reviewReasonCode: null }]),
          ),
        ),
      )
      if (created.kind !== 'created_running') throw new Error('expected created_running')
      await sealGenerateTarget(orgId, created.runId, userA, workDate, 'completed', true)

      const target = { orgId, initiator: 'cron' as const, workDate, runId: created.runId }
      const results = await withAllowlist(orgId, () =>
        Promise.all([
          withTxn((trx) => finalizeAttendanceScheduledRunV1(trx, target)),
          withTxn((trx) => finalizeAttendanceScheduledRunV1(trx, target)),
        ]),
      )
      const finalizedCount = results.filter((r) => r.kind === 'finalized').length
      const notRunningCount = results.filter((r) => r.kind === 'not_running').length
      expect(finalizedCount).toBe(1)
      expect(notRunningCount).toBe(1)
      const outboxCount = await pool.query(`SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE scheduled_run_id = $1::uuid`, [created.runId])
      expect(outboxCount.rows[0].n).toBe(1)
    })
  })

  // ===========================================================================================
  // 7. Abandoned transition — authorization, org anchor, idempotency, concurrency (gate 23).
  // ===========================================================================================
  describe('section 1.1.2 — abandoned transition', () => {
    function callerFor(orgId: string, actorPosture: 'platform_admin' | 'attendance_admin' | 'operator', capability: 'retirement' | 'scheduled' = 'retirement') {
      // `subjectScope: 'org_scheduler'` is reserved to posture `'scheduler'` (w4c0-authorization.ts's
      // own mint-time pairing rule) — an admin-posture abandon caller uses `explicit_users` instead
      // (a non-empty, synthetic placeholder; abandon's authorization is capability+posture, not a
      // per-user subject scope).
      return createAuthorizedAttendanceWriteContextV1({
        actorId: 'w4c2p12txn-operator',
        actorPosture,
        tokenSubjectUserId: null,
        orgId,
        subjectScope: { kind: 'explicit_users', userIds: ['w4c2p12txn-abandon-caller'] },
        capability,
        sourceRef: 'ref:w4c2p12txn-abandon',
      })
    }

    it('rejects an unauthorized actor posture / capability BEFORE any lock (zero DML)', async () => {
      const orgId = orgIdFor('abandonauth1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-02-10'
      const userA = uuid()
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([{ userId: userA, targetKind: 'generate', reviewReasonCode: null }]),
          ),
        ),
      )
      if (created.kind !== 'created_running') throw new Error('expected created_running')

      const wrongPosture = await catchAsync(() =>
        withTxn((trx) =>
          abandonAttendanceScheduledRunV1(
            trx,
            callerFor(orgId, 'operator' as never, 'retirement'),
            { orgId, runId: created.runId },
            'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED',
          ),
        ),
      )
      expect(String((wrongPosture as { code?: string })?.code)).toBe('ATTENDANCE_WRITE_NOT_AUTHORIZED')

      const wrongCapability = await catchAsync(() =>
        withTxn((trx) =>
          abandonAttendanceScheduledRunV1(
            trx,
            callerFor(orgId, 'platform_admin', 'scheduled'),
            { orgId, runId: created.runId },
            'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED',
          ),
        ),
      )
      expect(String((wrongCapability as { code?: string })?.code)).toBe('ATTENDANCE_WRITE_NOT_AUTHORIZED')

      const runRow = await pool.query(`SELECT state FROM attendance_scheduled_runs WHERE run_id = $1::uuid`, [created.runId])
      expect(runRow.rows[0].state).toBe('running')
    })

    it('rejects cross-org abandonment (org anchor / gate 13 extension) with zero DML', async () => {
      const orgA = orgIdFor('abandonorgA')
      const orgB = orgIdFor('abandonorgB')
      await setRolloutState(orgA, 'shadow')
      await setRolloutState(orgB, 'shadow')
      const workDate = '2026-02-11'
      const userA = uuid()
      const created = await withAllowlist(orgA, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId: orgA, initiator: 'cron', workDate },
            memberResolverFor([{ userId: userA, targetKind: 'generate', reviewReasonCode: null }]),
          ),
        ),
      )
      if (created.kind !== 'created_running') throw new Error('expected created_running')

      const err = await catchAsync(() =>
        withTxn((trx) =>
          abandonAttendanceScheduledRunV1(
            trx,
            callerFor(orgB, 'platform_admin'),
            { orgId: orgA, runId: created.runId },
            'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED',
          ),
        ),
      )
      expect(String((err as { code?: string })?.code)).toBe('ATTENDANCE_SCHEDULED_RUN_NOT_FOUND')
      const runRow = await pool.query(`SELECT state FROM attendance_scheduled_runs WHERE run_id = $1::uuid`, [created.runId])
      expect(runRow.rows[0].state).toBe('running')
    })

    it('two operators race to abandon the same running run: exactly one transitions; the other is idempotent zero-DML; a third call against the now-abandoned run is also idempotent', async () => {
      const orgId = orgIdFor('abandonrace1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-02-12'
      const [userA, userB] = [uuid(), uuid()]
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([
              { userId: userA, targetKind: 'generate', reviewReasonCode: null },
              { userId: userB, targetKind: 'generate', reviewReasonCode: null },
            ]),
          ),
        ),
      )
      if (created.kind !== 'created_running') throw new Error('expected created_running')
      await sealGenerateTarget(orgId, created.runId, userA, workDate, 'completed', true)

      const key = { orgId, runId: created.runId }
      const results = await Promise.all([
        withTxn((trx) => abandonAttendanceScheduledRunV1(trx, callerFor(orgId, 'platform_admin'), key, 'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED')),
        withTxn((trx) => abandonAttendanceScheduledRunV1(trx, callerFor(orgId, 'attendance_admin'), key, 'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED')),
      ])
      const abandonedCount = results.filter((r) => r.kind === 'abandoned').length
      const notRunningCount = results.filter((r) => r.kind === 'not_running').length
      expect(abandonedCount).toBe(1)
      expect(notRunningCount).toBe(1)
      const abandonedResult = results.find((r) => r.kind === 'abandoned') as { kind: 'abandoned'; completedUserCount: number }
      expect(abandonedResult.completedUserCount).toBe(1)

      const third = await withTxn((trx) =>
        abandonAttendanceScheduledRunV1(trx, callerFor(orgId, 'platform_admin'), key, 'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED'),
      )
      expect(third).toEqual({ kind: 'not_running', state: 'abandoned' })

      const runRow = await pool.query(
        `SELECT state, abandon_reason_code, abandoned_by_actor_posture FROM attendance_scheduled_runs WHERE run_id = $1::uuid`,
        [created.runId],
      )
      expect(runRow.rows[0].state).toBe('abandoned')
      expect(runRow.rows[0].abandon_reason_code).toBe('ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED')
      expect(['platform_admin', 'attendance_admin']).toContain(runRow.rows[0].abandoned_by_actor_posture)
      const outboxCount = await pool.query(`SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE scheduled_run_id = $1::uuid`, [created.runId])
      expect(outboxCount.rows[0].n).toBe(0)
    })

    it('an abandon call against a suspended org is deferred with zero DML (W4C-R43), and abandoning a completed run never overwrites it', async () => {
      const orgId = orgIdFor('abandonblocked1')
      // Seeded straight to `authoritative` BEFORE the run is created — promoting an org while
      // NO scheduled run is running never trips the `O-4=(a)` promotion-block guard (that guard
      // fires only on eligible->authoritative WITH a running row); reaching `suspended`
      // afterwards is the legal authoritative->suspended edge, which the guard never touches.
      await setRolloutState(orgId, 'authoritative')
      const workDate = '2026-02-13'
      const userA = uuid()
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([{ userId: userA, targetKind: 'generate', reviewReasonCode: null }]),
          ),
        ),
      )
      if (created.kind !== 'created_running') throw new Error('expected created_running')

      await setRolloutState(orgId, 'suspended')
      const deferred = await withTxn((trx) =>
        abandonAttendanceScheduledRunV1(trx, callerFor(orgId, 'platform_admin'), { orgId, runId: created.runId }, 'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED'),
      )
      expect(deferred).toEqual({ kind: 'deferred', code: 'ATTENDANCE_SCHEDULED_RUN_ABANDON_DEFERRED' })
      const stillRunning = await pool.query(`SELECT state FROM attendance_scheduled_runs WHERE run_id = $1::uuid`, [created.runId])
      expect(stillRunning.rows[0].state).toBe('running')

      // Unblock (suspended->authoritative is legal and untouched by the promotion-block guard,
      // which only watches eligible->authoritative) and finalize normally, then prove
      // abandon-after-completed is idempotent zero-DML.
      await setRolloutState(orgId, 'authoritative')
      await sealGenerateTarget(orgId, created.runId, userA, workDate, 'completed', true)
      const finalized = await withAllowlist(orgId, () =>
        withTxn((trx) => finalizeAttendanceScheduledRunV1(trx, { orgId, initiator: 'cron', workDate, runId: created.runId })),
      )
      expect(finalized.kind).toBe('finalized')
      const afterAbandon = await withTxn((trx) =>
        abandonAttendanceScheduledRunV1(trx, callerFor(orgId, 'platform_admin'), { orgId, runId: created.runId }, 'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED'),
      )
      expect(afterAbandon).toEqual({ kind: 'not_running', state: 'completed' })
    })
  })

  // ===========================================================================================
  // 7b. P1-2 remediation P2-3/P2-4 — section 1.1.1's outcome writer: fail-closed on a
  //     non-`running` run (gate 12's second clause, applied at this writer's own DML), and the
  //     witness guard's own two independently-neuterable legs.
  // ===========================================================================================
  describe('section 1.1.1 — outcome writer run-state guard and witness guard (P2-3/P2-4)', () => {
    interface RecordedStatement {
      readonly sql: string
      readonly params: readonly unknown[]
    }
    function recordingTrx(inner: AttendanceW4TransactionClientV1, log: RecordedStatement[]): AttendanceW4TransactionClientV1 {
      return {
        async query(sql: string, params?: unknown[]) {
          log.push({ sql, params: params ?? [] })
          return inner.query(sql, params as unknown[])
        },
      } as AttendanceW4TransactionClientV1
    }

    it('P2-3: a straggler seal arriving after the run was abandoned is rejected BEFORE the outcome INSERT, zero rows written, run state/counts untouched', async () => {
      const orgId = orgIdFor('outcomenonrun1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-02-15'
      const userA = uuid()
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([{ userId: userA, targetKind: 'generate', reviewReasonCode: null }]),
          ),
        ),
      )
      if (created.kind !== 'created_running') throw new Error('expected created_running')

      // Operator abandons BEFORE userA's operation completes — completed_user_count folds to 0.
      const abandonCaller = createAuthorizedAttendanceWriteContextV1({
        actorId: 'w4c2p12txn-p23-operator',
        actorPosture: 'platform_admin',
        tokenSubjectUserId: null,
        orgId,
        subjectScope: { kind: 'explicit_users', userIds: ['w4c2p12txn-p23-abandon-caller'] },
        capability: 'retirement',
        sourceRef: 'ref:w4c2p12txn-p23-abandon',
      })
      const abandonOutcome = await withTxn((trx) =>
        abandonAttendanceScheduledRunV1(trx, abandonCaller, { orgId, runId: created.runId }, 'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED'),
      )
      expect(abandonOutcome).toEqual({ kind: 'abandoned', runId: created.runId, completedUserCount: 0 })

      // The straggler's per-user operation transaction was already in flight (claimed before the
      // abandon committed) and now attempts to seal — reproduces the verdict's real-DB probe
      // through the actual production writer, not a raw-SQL bypass.
      const t = await pool.query(
        `SELECT operation_id::text AS operation_id FROM attendance_scheduled_run_targets
          WHERE org_id = $1 AND run_id = $2::uuid AND user_id = $3::uuid AND target_kind = 'generate'`,
        [orgId, created.runId, userA],
      )
      const operationId = t.rows[0].operation_id as string

      const err = await catchAsync(() =>
        withTxn(async (trx) => {
          await trx.query(
            `INSERT INTO attendance_result_operations (
                org_id, entrypoint, operation_id, identity_source_kind, source_root_id, proof_user_id, proof_work_date,
                source_ref, actor_id, actor_posture, capability, subject_scope, command_fingerprint, accepted_write_posture, state
              ) VALUES ($1,'scheduled',$2,'scheduled',$3,$4,$5,'ref:w4c2p12txn-p23','actor-w4c2p12txn-p23','scheduler','scheduled','{}'::jsonb,$6,'shadow','claimed')`,
            [orgId, operationId, created.runId, userA, workDate, 'b'.repeat(64)],
          )
          const org = createVerifiedAttendanceOrgIdentityV1({
            orgKey: orgId,
            posture: await resolveSegmentCalculationPosture(trx, orgId),
          })
          const identity = createVerifiedAttendanceOperationIdentityV1({
            org,
            kind: 'item',
            entrypoint: 'scheduled',
            source: { sourceKind: 'scheduled', scheduledRunId: created.runId, userId: userA, workDate },
          })
          await trx.query(
            `UPDATE attendance_result_operations
                SET state = 'completed', response_snapshot = $3::jsonb, version = version + 1, updated_at = now()
              WHERE org_id = $1 AND entrypoint = 'scheduled' AND operation_id = $2::uuid AND state = 'claimed'`,
            [orgId, operationId, JSON.stringify({ inserted: true })],
          )
          await recordAttendanceScheduledRunTargetOutcomeV1(trx, identity, { terminalOutcome: 'completed' })
        }),
      )
      expect(String((err as { code?: string })?.code)).toBe('W4C2_SCHEDULED_RUN_OUTCOME_RUN_NOT_RUNNING')

      const outcomeRows = await pool.query(
        `SELECT count(*)::int AS n FROM attendance_scheduled_run_target_outcomes WHERE org_id = $1 AND run_id = $2::uuid`,
        [orgId, created.runId],
      )
      expect(outcomeRows.rows[0].n).toBe(0)
      const runRow = await pool.query(
        `SELECT state, completed_user_count FROM attendance_scheduled_runs WHERE run_id = $1::uuid`,
        [created.runId],
      )
      expect(runRow.rows[0]).toEqual({ state: 'abandoned', completed_user_count: 0 })
    })

    it('P2-4 leg (a): a caller-fabricated plain object shaped like a real witness is rejected by the witness-registration check itself, zero trx queries', async () => {
      const orgId = orgIdFor('outcomewitness1')
      await setRolloutState(orgId, 'shadow')
      // Shaped exactly like a real `entrypoint: 'scheduled', kind: 'item'` witness so this leg
      // isolates the witness-REGISTRATION check from the downstream entrypoint/kind check below
      // — a bare-cast neuter of `requireVerifiedAttendanceOperationIdentityV1` would let this
      // exact object fall through to the entrypoint/kind check (which it would pass) and reach
      // a `trx.query` call, so "zero queries" only holds under the real guard.
      const fabricated = Object.freeze({
        kind: 'item',
        org: Object.freeze({ orgId, acceptedWritePosture: 'shadow' }),
        entrypoint: 'scheduled',
        id: uuid(),
        sourceProof: Object.freeze({
          sourceKind: 'scheduled',
          sourceRootId: uuid(),
          ordinal: null,
          semanticFingerprint: null,
          userId: uuid(),
          workDate: '2026-02-16',
        }),
      })
      const log: RecordedStatement[] = []
      const err = await catchAsync(() =>
        withTxn((trx) =>
          recordAttendanceScheduledRunTargetOutcomeV1(recordingTrx(trx, log), fabricated, { terminalOutcome: 'completed' }),
        ),
      )
      expect(String((err as { code?: string })?.code)).toBe('W4C0_OPERATION_WITNESS_REQUIRED')
      expect(log.length).toBe(0)
    })

    it('P2-4 leg (b): a REAL witness of the wrong entrypoint/kind (live_punch, not scheduled) is rejected by the entrypoint/kind check, zero trx queries', async () => {
      const orgId = orgIdFor('outcomewitness2')
      await setRolloutState(orgId, 'shadow')
      const log: RecordedStatement[] = []
      const err = await catchAsync(() =>
        withTxn(async (trx) => {
          const org = createVerifiedAttendanceOrgIdentityV1({
            orgKey: orgId,
            posture: await resolveSegmentCalculationPosture(trx, orgId),
          })
          // A genuinely MINTED, real witness (passes `requireVerifiedAttendanceOperationIdentityV1`
          // cleanly) — but for `live_punch`, not `scheduled`. This leg only proves something if
          // leg (a)'s guard stays intact and this witness reaches the entrypoint/kind branch.
          const wrongEntrypointWitness = createVerifiedAttendanceOperationIdentityV1({
            org,
            kind: 'item',
            entrypoint: 'live_punch',
            source: { sourceKind: 'direct_live_punch', clientOperationId: uuid() },
          })
          await recordAttendanceScheduledRunTargetOutcomeV1(recordingTrx(trx, log), wrongEntrypointWitness, {
            terminalOutcome: 'completed',
          })
        }),
      )
      expect(String((err as { code?: string })?.code)).toBe('W4C2_SCHEDULED_RUN_OUTCOME_WITNESS_INVALID')
      expect(log.length).toBe(0)
    })
  })

  // ===========================================================================================
  // 8. Terminal-failure does not stall an unrelated org's own run (positive control).
  // ===========================================================================================
  describe('failed-outcome contract fixture blast radius', () => {
    it('a contract-only failed target in org A finalizes org A and never touches org B, which finalizes independently and concurrently', async () => {
      const orgA = orgIdFor('blastA')
      const orgB = orgIdFor('blastB')
      await setRolloutState(orgA, 'shadow')
      await setRolloutState(orgB, 'shadow')
      const workDate = '2026-02-14'
      const userA = uuid()
      const userB = uuid()

      // Both orgs allowlisted TOGETHER in one call — `withAllowlist` mutates a process-global
      // env var, so nesting two separate concurrent `withAllowlist` calls (one per org) would
      // race on that mutation; a single call covering both org ids is required for the
      // concurrent Promise.all below to be meaningful.
      const [createdA, createdB] = await withAllowlist([orgA, orgB], () =>
        Promise.all([
          withTxn((trx) =>
            createOrResumeAttendanceScheduledRunV1(trx, { orgId: orgA, initiator: 'cron', workDate }, memberResolverFor([{ userId: userA, targetKind: 'generate', reviewReasonCode: null }])),
          ),
          withTxn((trx) =>
            createOrResumeAttendanceScheduledRunV1(trx, { orgId: orgB, initiator: 'cron', workDate }, memberResolverFor([{ userId: userB, targetKind: 'generate', reviewReasonCode: null }])),
          ),
        ]),
      )
      if (createdA.kind !== 'created_running' || createdB.kind !== 'created_running') throw new Error('expected created_running')
      await sealGenerateTarget(orgA, createdA.runId, userA, workDate, 'failed', false)
      await sealGenerateTarget(orgB, createdB.runId, userB, workDate, 'completed', true)

      const [outcomeA, outcomeB] = await withAllowlist([orgA, orgB], () =>
        Promise.all([
          withTxn((trx) => finalizeAttendanceScheduledRunV1(trx, { orgId: orgA, initiator: 'cron', workDate, runId: createdA.runId })),
          withTxn((trx) => finalizeAttendanceScheduledRunV1(trx, { orgId: orgB, initiator: 'cron', workDate, runId: createdB.runId })),
        ]),
      )
      expect(outcomeA).toEqual({ kind: 'finalized', runId: createdA.runId, completedUserCount: 0, generatedCount: 0, reviewCount: 0 })
      expect(outcomeB).toEqual({ kind: 'finalized', runId: createdB.runId, completedUserCount: 1, generatedCount: 1, reviewCount: 0 })
    })
  })

  // ===========================================================================================
  // 9. Recovery sweep — positive control.
  // ===========================================================================================
  describe('section 1.7 — recovery sweep', () => {
    it('scans a stranded running run whose targets are all terminal (cross a prior calendar work_date) and finalizes it exactly once via the sweep step', async () => {
      const orgId = orgIdFor('sweep1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2020-01-01' // deliberately a "prior calendar day" relative to any sweep tick
      const userA = uuid()
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([{ userId: userA, targetKind: 'generate', reviewReasonCode: null }]),
          ),
        ),
      )
      if (created.kind !== 'created_running') throw new Error('expected created_running')
      await sealGenerateTarget(orgId, created.runId, userA, workDate, 'completed', true)

      const candidates = await withTxn((trx) => scanAttendanceScheduledRunSweepCandidatesV1(trx, 500))
      const mine = candidates.find((c) => c.orgId === orgId)
      expect(mine).toBeDefined()
      expect(mine?.workDate).toBe(workDate)

      const stepOutcome = await withAllowlist(orgId, () => withTxn((trx) => sweepAttendanceScheduledRunCandidateV1(trx, mine!)))
      expect(stepOutcome).toEqual({ kind: 'finalized', runId: created.runId })

      const runRow = await pool.query(`SELECT state FROM attendance_scheduled_runs WHERE run_id = $1::uuid`, [created.runId])
      expect(runRow.rows[0].state).toBe('completed')
    })

    it('a not-yet-terminal candidate is reported not_ready by the sweep step, not silently finalized', async () => {
      const orgId = orgIdFor('sweep2')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-02-15'
      const userA = uuid()
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([{ userId: userA, targetKind: 'generate', reviewReasonCode: null }]),
          ),
        ),
      )
      if (created.kind !== 'created_running') throw new Error('expected created_running')
      const stepOutcome = await withAllowlist(orgId, () =>
        withTxn((trx) => sweepAttendanceScheduledRunCandidateV1(trx, { orgId, initiator: 'cron', workDate, runId: created.runId })),
      )
      expect(stepOutcome).toEqual({ kind: 'not_ready', runId: created.runId })
    })

    it.each(['cron', 'admin_run'] as const)(
      'resumes the exact scanned %s run without allocating a new generation',
      async (initiator) => {
        const orgId = orgIdFor(`sweep-exact-${initiator}`)
        await setRolloutState(orgId, 'shadow')
        const workDate = initiator === 'cron' ? '2026-02-20' : '2026-02-21'
        const userA = uuid()
        const members = [{ userId: userA, targetKind: 'generate' as const, reviewReasonCode: null }]
        const created = await withAllowlist(orgId, () =>
          withTxn((trx) =>
            createOrResumeAttendanceScheduledRunV1(
              trx,
              { orgId, initiator, workDate },
              memberResolverFor(members),
            ),
          ),
        )
        if (created.kind !== 'created_running') throw new Error('expected created_running')

        const resumed = await withAllowlist(orgId, () =>
          withTxn((trx) =>
            resumeAttendanceScheduledRunByExactIdV1(
              trx,
              { orgId, initiator, workDate, runId: created.runId },
              memberResolverFor(members),
            ),
          ),
        )
        expect(resumed).toMatchObject({
          kind: 'resumed',
          runId: created.runId,
          generation: 1,
          readyToFinalize: false,
        })
        const runs = await pool.query(
          `SELECT run_id::text AS run_id, generation, state
             FROM attendance_scheduled_runs
            WHERE org_id = $1 AND initiator = $2 AND work_date = $3::date`,
          [orgId, initiator, workDate],
        )
        expect(runs.rows).toEqual([{ run_id: created.runId, generation: 1, state: 'running' }])
      },
    )

    it('returns not_running when the scanned run finalized before recovery and never creates generation n+1', async () => {
      const orgId = orgIdFor('sweep-finalize-race')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-02-22'
      const userA = uuid()
      const members = [{ userId: userA, targetKind: 'generate' as const, reviewReasonCode: null }]
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor(members),
          ),
        ),
      )
      if (created.kind !== 'created_running') throw new Error('expected created_running')
      await sealGenerateTarget(orgId, created.runId, userA, workDate, 'completed', true)
      await withAllowlist(orgId, () =>
        withTxn((trx) =>
          finalizeAttendanceScheduledRunV1(trx, {
            orgId,
            initiator: 'cron',
            workDate,
            runId: created.runId,
          }),
        ),
      )

      const raced = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          resumeAttendanceScheduledRunByExactIdV1(
            trx,
            { orgId, initiator: 'cron', workDate, runId: created.runId },
            memberResolverFor(members),
          ),
        ),
      )
      expect(raced).toEqual({ kind: 'not_running', runId: created.runId, state: 'completed' })
      const count = await pool.query(
        `SELECT count(*)::int AS n, max(generation)::int AS max_generation
           FROM attendance_scheduled_runs
          WHERE org_id = $1 AND initiator = 'cron' AND work_date = $2::date`,
        [orgId, workDate],
      )
      expect(count.rows[0]).toEqual({ n: 1, max_generation: 1 })
    })

    it('fails closed on membership drift and leaves the exact run running', async () => {
      const orgId = orgIdFor('sweep-drift')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-02-23'
      const userA = uuid()
      const userB = uuid()
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([{ userId: userA, targetKind: 'generate', reviewReasonCode: null }]),
          ),
        ),
      )
      if (created.kind !== 'created_running') throw new Error('expected created_running')

      const error = await withAllowlist(orgId, () =>
        catchAsync(() =>
          withTxn((trx) =>
            resumeAttendanceScheduledRunByExactIdV1(
              trx,
              { orgId, initiator: 'cron', workDate, runId: created.runId },
              memberResolverFor([
                { userId: userA, targetKind: 'generate', reviewReasonCode: null },
                { userId: userB, targetKind: 'generate', reviewReasonCode: null },
              ]),
            ),
          ),
        ),
      )
      expect(String((error as { code?: string })?.code)).toBe('W4C2_SCHEDULED_RUN_RESUME_TARGET_SET_DRIFT')
      expect(
        (await pool.query('SELECT state FROM attendance_scheduled_runs WHERE run_id = $1::uuid', [created.runId]))
          .rows[0].state,
      ).toBe('running')
    })

    it('defers exact recovery while suspended, then resumes the same run after unblocking', async () => {
      const orgId = orgIdFor('sweep-suspended')
      await setRolloutState(orgId, 'authoritative')
      const workDate = '2026-02-25'
      const userA = uuid()
      const members = [{ userId: userA, targetKind: 'generate' as const, reviewReasonCode: null }]
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor(members),
          ),
        ),
      )
      if (created.kind !== 'created_running') throw new Error('expected created_running')

      await setRolloutState(orgId, 'suspended')
      const deferred = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          resumeAttendanceScheduledRunByExactIdV1(
            trx,
            { orgId, initiator: 'cron', workDate, runId: created.runId },
            memberResolverFor(members),
          ),
        ),
      )
      expect(deferred).toEqual({ kind: 'org_suspended_deferred' })
      expect(
        (await pool.query('SELECT state FROM attendance_scheduled_runs WHERE run_id = $1::uuid', [created.runId]))
          .rows[0].state,
      ).toBe('running')

      await setRolloutState(orgId, 'authoritative')
      const resumed = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          resumeAttendanceScheduledRunByExactIdV1(
            trx,
            { orgId, initiator: 'cron', workDate, runId: created.runId },
            memberResolverFor(members),
          ),
        ),
      )
      expect(resumed).toMatchObject({ kind: 'resumed', runId: created.runId, generation: 1 })
      const runs = await pool.query(
        `SELECT run_id::text AS run_id, generation, state
           FROM attendance_scheduled_runs
          WHERE org_id = $1 AND initiator = 'cron' AND work_date = $2::date`,
        [orgId, workDate],
      )
      expect(runs.rows).toEqual([{ run_id: created.runId, generation: 1, state: 'running' }])
    })

    it('contains one recovery callback failure and still finalizes a later all-terminal candidate', async () => {
      const orgError = orgIdFor('sweep-worker-error')
      const orgFinal = orgIdFor('sweep-worker-final')
      await setRolloutState(orgError, 'shadow')
      await setRolloutState(orgFinal, 'shadow')
      const workDate = '2026-02-24'
      const userError = uuid()
      const userFinal = uuid()
      const [errorRun, finalRun] = await withAllowlist([orgError, orgFinal], () =>
        Promise.all([
          withTxn((trx) =>
            createOrResumeAttendanceScheduledRunV1(
              trx,
              { orgId: orgError, initiator: 'cron', workDate },
              memberResolverFor([{ userId: userError, targetKind: 'generate', reviewReasonCode: null }]),
            ),
          ),
          withTxn((trx) =>
            createOrResumeAttendanceScheduledRunV1(
              trx,
              { orgId: orgFinal, initiator: 'cron', workDate },
              memberResolverFor([{ userId: userFinal, targetKind: 'generate', reviewReasonCode: null }]),
            ),
          ),
        ]),
      )
      if (errorRun.kind !== 'created_running' || finalRun.kind !== 'created_running') {
        throw new Error('expected created_running')
      }
      await sealGenerateTarget(orgFinal, finalRun.runId, userFinal, workDate, 'completed', true)

      const callbackRuns: string[] = []
      const result = await withAllowlist([orgError, orgFinal], () =>
        sweepAttendanceScheduledRunsOnceV1(pool, {
          limit: 500,
          async recoverCandidate(candidate) {
            callbackRuns.push(candidate.runId)
            if (candidate.runId === errorRun.runId) throw new Error('W4C2_TEST_RECOVERY_FAILURE')
          },
        }),
      )
      expect(callbackRuns).toContain(errorRun.runId)
      expect(result.errored).toBeGreaterThanOrEqual(1)
      expect(
        (await pool.query('SELECT state FROM attendance_scheduled_runs WHERE run_id = $1::uuid', [finalRun.runId]))
          .rows[0].state,
      ).toBe('completed')
      expect(
        (await pool.query('SELECT state FROM attendance_scheduled_runs WHERE run_id = $1::uuid', [errorRun.runId]))
          .rows[0].state,
      ).toBe('running')
    })
  })

  // ===========================================================================================
  // 10. `O-4=(a)` — promotion-block guard (gate 21, activated).
  // ===========================================================================================
  describe('section 1.7.1 — O-4=(a) promotion-block guard', () => {
    it('promotion eligible->authoritative is refused while a scheduled run for that org is running, and succeeds once it finalizes', async () => {
      const orgId = orgIdFor('promoblock1')
      await setRolloutState(orgId, 'eligible')
      const workDate = '2026-02-16'
      const userA = uuid()
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([{ userId: userA, targetKind: 'generate', reviewReasonCode: null }]),
          ),
        ),
      )
      if (created.kind !== 'created_running') throw new Error('expected created_running')

      const current = await pool.query('SELECT version FROM attendance_calculation_rollout_state WHERE org_id = $1', [orgId])
      const blocked = await catchAsync(() =>
        pool.query(
          `UPDATE attendance_calculation_rollout_state SET state='authoritative', prior_state='eligible', version=$2 WHERE org_id=$1`,
          [orgId, Number(current.rows[0].version) + 1],
        ),
      )
      expect(String((blocked as { message?: string })?.message || '')).toMatch(/W4C2_ROLLOUT_PROMOTION_BLOCKED/)
      const stillEligible = await pool.query('SELECT state FROM attendance_calculation_rollout_state WHERE org_id = $1', [orgId])
      expect(stillEligible.rows[0].state).toBe('eligible')

      await sealGenerateTarget(orgId, created.runId, userA, workDate, 'completed', true)
      await withAllowlist(orgId, () => withTxn((trx) => finalizeAttendanceScheduledRunV1(trx, { orgId, initiator: 'cron', workDate, runId: created.runId })))

      const current2 = await pool.query('SELECT version FROM attendance_calculation_rollout_state WHERE org_id = $1', [orgId])
      await pool.query(
        `UPDATE attendance_calculation_rollout_state SET state='authoritative', prior_state='eligible', version=$2 WHERE org_id=$1`,
        [orgId, Number(current2.rows[0].version) + 1],
      )
      const promoted = await pool.query('SELECT state FROM attendance_calculation_rollout_state WHERE org_id = $1', [orgId])
      expect(promoted.rows[0].state).toBe('authoritative')
    })

    // -----------------------------------------------------------------------------------------
    // Exclusivity matrix ("Group G" — identity/authorization guards; "L6" — resume fingerprint
    // guard). Each leg is neutered ALONE and re-run; the exclusivity claim is that ONLY the
    // named assertion for that leg turns red, and every OTHER leg in this describe block stays
    // green under the same mutation. This block asserts the POSITIVE (un-mutated) baseline for
    // each leg so a future mutation pass has a red/green signature to diff against; it does not
    // itself perform the mutation (mutation is done by hand against the worktree, see the PR
    // report's mutation table).
    // -----------------------------------------------------------------------------------------
    it('Group G / L6 baseline: promotion-block guard fires ONLY on eligible->authoritative, never on shadow->eligible or an unrelated org', async () => {
      const orgId = orgIdFor('promoblock2')
      const otherOrg = orgIdFor('promoblock2-other')
      await setRolloutState(orgId, 'eligible')
      await setRolloutState(otherOrg, 'eligible')
      const workDate = '2026-02-17'
      const userA = uuid()
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([{ userId: userA, targetKind: 'generate', reviewReasonCode: null }]),
          ),
        ),
      )
      expect(created.kind).toBe('created_running')

      // shadow->eligible transition on the SAME org (posture stays 'shadow' both sides) is
      // untouched by the guard — already exercised implicitly by setRolloutState's own walk;
      // assert it did not raise (setRolloutState would have thrown if it had).
      const orgState = await pool.query('SELECT state FROM attendance_calculation_rollout_state WHERE org_id=$1', [orgId])
      expect(orgState.rows[0].state).toBe('eligible')

      // An unrelated org's own eligible->authoritative promotion is unaffected by orgId's
      // running run (org-scoped WHERE clause).
      const otherCurrent = await pool.query('SELECT version FROM attendance_calculation_rollout_state WHERE org_id=$1', [otherOrg])
      await pool.query(
        `UPDATE attendance_calculation_rollout_state SET state='authoritative', prior_state='eligible', version=$2 WHERE org_id=$1`,
        [otherOrg, Number(otherCurrent.rows[0].version) + 1],
      )
      const otherState = await pool.query('SELECT state FROM attendance_calculation_rollout_state WHERE org_id=$1', [otherOrg])
      expect(otherState.rows[0].state).toBe('authoritative')
    })
  })
})
