/**
 * W4C-2 P1-2 (#4556) — THIRD real-DB gate suite for the RATIFIED scheduled-run identity
 * amendment (docs/development/attendance-issue-4556-w4c2-scheduled-run-identity-amendment-
 * 20260726.md, PR #4617, owner Bundle A = 44a/45a/46a/47a/48a/49a/50a/51a/52a/53(i)).
 *
 * SCOPE (the section 2 gates the first two sibling suites did not close):
 *  - gates 2/3/4: the durable run-level event legs — crash-after-finalize-commit posture,
 *    dispatcher-restart exactly-once delivery, the review_required zero/one-row split, and
 *    the payload/wire freeze (exact key set + values + the O-2=(a) pinned canonical reasons
 *    order + byte-stable durable payload text);
 *  - gate 5: legacy posture zero-row leg extended to ALL four W4 surfaces (run/target/
 *    operation/outbox) — the "unchanged synchronous best-effort emit" half of gate 5 lives
 *    at the CALLER (index.cjs keeps its legacy emit when this module reports
 *    `org_legacy_zero_rows`; the caller cutover is a later slice per the module docstring)
 *    and is asserted here at the module boundary only, disclosed, not hidden;
 *  - gate 6: restart completes ONLY unfinished users — durable-evidence outstanding set,
 *    zero-DML replay of the k completed users (content-hash congruence), and fold equality
 *    with an uninterrupted control run;
 *  - gate 7 ADDED leg (round-7, section 1.8 step 3): an `abandoned` transition commits
 *    while a finalizer is WAITING on the class-`01` lock; the finalizer then observes
 *    `state='abandoned'` and returns the recorded outcome with zero DML;
 *  - gate 8: injected-failure atomicity legs (fault after the outbox insert / at the outbox
 *    insert), plus the one-txid witness on the STANDALONE finalization path (the zero-
 *    `generate` inline path's witness is the sibling transactional suite's);
 *  - gate 15: lock-order legs via a statement-recording client — class-`00` shared before
 *    class-`01` exclusive, EXACTLY that advisory-lock set (which is also the no-class-`11`
 *    proof: any extra acquisition fails the exact-set assertion), and zero source DML — for
 *    the finalization transaction, the `abandoned` transaction (gate 23's extension of gate
 *    15), and the section 1.9 zero-`generate` creation transaction (gate 19's "gate 15
 *    applies verbatim");
 *  - gate 17: suspended pause — finalization deferral is zero-DML and retryable, and once
 *    the org posture matches the run's frozen posture again the next attempt finalizes
 *    exactly once;
 *  - gate 22 positive/negative controls: the zero-`generate` inline-finalization outbox rows
 *    satisfy the full discriminated union indistinguishably from rehydrated-path rows, and a
 *    forced rollback AFTER the private mint ran in-process leaves zero committed rows;
 *  - gate 23 extended legs: zero-SQL (therefore zero-lock-wait) rejection with an
 *    instrumented counter + its positive control, and `abandoned_by_actor_posture`
 *    immutability after the terminal state.
 *
 * Shared-DB discipline: self-provisions its OWN scratch database (same pattern as the two
 * sibling P1-2 suites). Every fixture identity is namespaced `w4c2p12dlg<run>`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import { up as w4c2Up } from '../../src/db/migrations/zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union'
import {
  createOrResumeAttendanceScheduledRunV1,
  finalizeAttendanceScheduledRunV1,
  recordAttendanceScheduledRunTargetOutcomeV1,
  abandonAttendanceScheduledRunV1,
  type AttendanceScheduledRunMemberInputV1,
  type AttendanceScheduledRunMembershipResolverV1,
} from '../../src/attendance/w4c2-scheduled-run'
import {
  createVerifiedAttendanceOperationIdentityV1,
  createVerifiedAttendanceOrgIdentityV1,
  resolveSegmentCalculationPosture,
  buildAttendanceCalculationRolloutAdvisoryKey,
  buildAttendanceScheduledRunAdvisoryKey,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  parseCanonicalAttendanceScheduledRunKeyV1,
} from '../../src/attendance/w4c0-identity'
import { createAuthorizedAttendanceWriteContextV1 } from '../../src/attendance/w4c0-authorization'
import { runAttendanceResultOperationTransactionV1 } from '../../src/attendance/w4c0-operation-registry'
import {
  dispatchAttendanceResultEventOutboxV1,
  type AttendanceOutboxDeliveryV1,
} from '../../src/attendance/w4c2-outbox-dispatcher'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const RUN = crypto.randomUUID().slice(0, 8)
const NS = 'w4c2p12dlg' + RUN

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

/**
 * Statement-recording pass-through client — the gate 15/23 witness. Records every (sql,
 * params) pair the wrapped code path issues, delegating each to the real client unchanged.
 */
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

/** Advisory-lock acquisitions (mode + signed key) extracted from a recorded statement log. */
function advisoryAcquisitions(log: readonly RecordedStatement[]): Array<{ mode: 'shared' | 'exclusive'; key: string }> {
  const out: Array<{ mode: 'shared' | 'exclusive'; key: string }> = []
  for (const entry of log) {
    if (/pg_advisory_xact_lock_shared/.test(entry.sql)) {
      out.push({ mode: 'shared', key: String(entry.params[0]) })
    } else if (/pg_advisory_xact_lock/.test(entry.sql)) {
      out.push({ mode: 'exclusive', key: String(entry.params[0]) })
    }
  }
  return out
}

/** Source-table DML statements (section 8.4 "business" bucket) in a recorded log. */
const SOURCE_DML_RE =
  /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(attendance_events|attendance_records|attendance_requests|attendance_record_result_edits|attendance_import_batches|attendance_import_items)\b/i
function sourceDmlStatements(log: readonly RecordedStatement[]): RecordedStatement[] {
  return log.filter((entry) => SOURCE_DML_RE.test(entry.sql))
}

describeIfDatabase('W4C-2 P1-2 — durable delivery / lock-order / atomicity gates (real DB)', () => {
  const scratchName = `ms2_w4c2_p12dlg_${RUN}`
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
         VALUES ($1,'legacy','v1','w4c2p12dlg-seed','w4c2p12dlg-actor',1,NULL)`,
        [orgId],
      )
    }
    let current = (await pool.query('SELECT state, version FROM attendance_calculation_rollout_state WHERE org_id = $1', [orgId])).rows[0]
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

  async function withTxn<T>(fn: (trx: AttendanceW4TransactionClientV1) => Promise<T>): Promise<T> {
    const c: PoolClient = await pool.connect()
    try {
      return await runAttendanceResultOperationTransactionV1(c as unknown as AttendanceW4TransactionClientV1, fn)
    } finally {
      c.release()
    }
  }

  /** Claims AND seals/cancels the per-user operation row in ONE transaction (sibling-suite pattern). */
  async function sealGenerateTarget(
    orgId: string,
    runId: string,
    userId: string,
    workDate: string,
    outcome: 'completed' | 'failed',
    inserted: boolean,
    acceptedWritePosture: 'shadow' | 'authoritative' = 'shadow',
  ): Promise<void> {
    const t = await pool.query(
      `SELECT operation_id::text AS operation_id FROM attendance_scheduled_run_targets
        WHERE org_id = $1 AND run_id = $2::uuid AND user_id = $3::uuid AND target_kind = 'generate'`,
      [orgId, runId, userId],
    )
    const operationId = t.rows[0].operation_id as string
    await withTxn(async (trx) => {
      await trx.query(
        `INSERT INTO attendance_result_operations (
            org_id, entrypoint, operation_id, identity_source_kind, source_root_id, proof_user_id, proof_work_date,
            source_ref, actor_id, actor_posture, capability, subject_scope, command_fingerprint, accepted_write_posture, state
          ) VALUES ($1,'scheduled',$2,'scheduled',$3,$4,$5,'ref:w4c2p12dlg','actor-w4c2p12dlg','scheduler','scheduled','{}'::jsonb,$6,$7,'claimed')`,
        [orgId, operationId, runId, userId, workDate, 'a'.repeat(64), acceptedWritePosture],
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
        await trx.query(
          `UPDATE attendance_result_operations
              SET state = 'canceled', version = version + 1, updated_at = now()
            WHERE org_id = $1 AND entrypoint = 'scheduled' AND operation_id = $2::uuid AND state = 'claimed'`,
          [orgId, operationId],
        )
        await recordAttendanceScheduledRunTargetOutcomeV1(trx, identity, {
          terminalOutcome: 'failed',
          failureReasonCode: 'ATTENDANCE_SCHEDULED_TARGET_OPERATION_REJECTED',
        })
      }
    })
  }

  function abandonCallerFor(orgId: string, actorPosture: 'platform_admin' | 'attendance_admin' | 'operator', capability: 'retirement' | 'scheduled' = 'retirement') {
    return createAuthorizedAttendanceWriteContextV1({
      actorId: 'w4c2p12dlg-operator',
      actorPosture,
      tokenSubjectUserId: null,
      orgId,
      subjectScope: { kind: 'explicit_users', userIds: ['w4c2p12dlg-abandon-caller'] },
      capability,
      sourceRef: 'ref:w4c2p12dlg-abandon',
    })
  }

  /** Dispatch one batch on a dedicated connection, capturing every delivered event. */
  async function dispatchOnce(): Promise<AttendanceOutboxDeliveryV1[]> {
    const deliveries: AttendanceOutboxDeliveryV1[] = []
    const c: PoolClient = await pool.connect()
    try {
      await dispatchAttendanceResultEventOutboxV1(c as unknown as AttendanceW4TransactionClientV1, {
        emit: (delivery) => {
          deliveries.push(delivery)
        },
      })
    } finally {
      c.release()
    }
    return deliveries
  }

  function deliveriesForOrg(deliveries: readonly AttendanceOutboxDeliveryV1[], orgId: string) {
    return deliveries.filter((d) => (d.payload as { orgId?: string })?.orgId === orgId)
  }

  // ===========================================================================================
  // 1. Gates 2/3/4 — durable run-level events: crash-before-emit posture, restart delivery
  //    exactly once, review zero/one split, payload/wire freeze.
  // ===========================================================================================
  describe('gates 2/3/4 — durable run-level events + payload/wire freeze', () => {
    it('gate 2+4: finalization commit leaves both rows pending (crash-before-emit posture); dispatcher restart delivers each exactly once with frozen payload bytes; no source or per-user DML repeats', async () => {
      const orgId = orgIdFor('durable1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-03-01'
      // Fixed lexicographic user ids: G1 < G2 < R1.
      const userG1 = '00000000-0000-4000-8000-00000000aaa1'
      const userG2 = '00000000-0000-4000-8000-00000000aaa2'
      const userR1 = '00000000-0000-4000-8000-00000000aaa3'
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([
              { userId: userG1, targetKind: 'generate', reviewReasonCode: null },
              { userId: userG2, targetKind: 'generate', reviewReasonCode: null },
              { userId: userR1, targetKind: 'review', reviewReasonCode: 'NO_MATCHING_SHIFT' },
            ]),
          ),
        ),
      )
      if (created.kind !== 'created_running') throw new Error('expected created_running')
      await sealGenerateTarget(orgId, created.runId, userG1, workDate, 'completed', true)
      await sealGenerateTarget(orgId, created.runId, userG2, workDate, 'completed', false)
      const finalized = await withAllowlist(orgId, () =>
        withTxn((trx) => finalizeAttendanceScheduledRunV1(trx, { orgId, initiator: 'cron', workDate, runId: created.runId })),
      )
      expect(finalized).toEqual({ kind: 'finalized', runId: created.runId, completedUserCount: 2, generatedCount: 1, reviewCount: 1 })

      // Crash-after-commit-before-emit posture: the finalization COMMIT is durable, no emit
      // has happened (the dispatcher has not run) — both rows must be sitting `pending`.
      const pre = await pool.query(
        `SELECT event_kind, delivery_state, payload::text AS payload_text FROM attendance_result_event_outbox
          WHERE scheduled_run_id = $1::uuid ORDER BY event_kind`,
        [created.runId],
      )
      expect(pre.rows.map((r: { event_kind: string; delivery_state: string }) => [r.event_kind, r.delivery_state])).toEqual([
        ['attendance.absence.generated', 'pending'],
        ['attendance.work_date.review_required', 'pending'],
      ])
      const prePayloadTexts = pre.rows.map((r: { payload_text: string }) => r.payload_text)

      // DML-repetition witness snapshot (per-user + source surfaces).
      const dmlSnapshot = async () => ({
        ops: (await pool.query(`SELECT count(*)::int AS n FROM attendance_result_operations WHERE org_id = $1`, [orgId])).rows[0].n as number,
        outcomes: (await pool.query(`SELECT count(*)::int AS n FROM attendance_scheduled_run_target_outcomes WHERE org_id = $1`, [orgId])).rows[0].n as number,
        records: (await pool.query(`SELECT count(*)::int AS n FROM attendance_records WHERE org_id = $1`, [orgId])).rows[0].n as number,
        requests: (await pool.query(`SELECT count(*)::int AS n FROM attendance_requests WHERE org_id = $1`, [orgId])).rows[0].n as number,
      })
      const before = await dmlSnapshot()

      // "Dispatcher restart": a fresh dispatcher drains the pending rows exactly once.
      const first = deliveriesForOrg(await dispatchOnce(), orgId)
      expect(first.map((d) => d.eventKind).sort()).toEqual([
        'attendance.absence.generated',
        'attendance.work_date.review_required',
      ])
      const absence = first.find((d) => d.eventKind === 'attendance.absence.generated') as AttendanceOutboxDeliveryV1
      const review = first.find((d) => d.eventKind === 'attendance.work_date.review_required') as AttendanceOutboxDeliveryV1

      // Gate 4 payload/wire freeze — EXACT key set and values, matching the pre-amendment
      // synchronous emit shape (index.cjs `emit('attendance.absence.generated', { orgId,
      // workDate, total })` / `emit('attendance.work_date.review_required', { orgId,
      // workDate, total, reasons })`), under O-2=(a)'s pinned canonical reasons order.
      expect(Object.keys(absence.payload as Record<string, unknown>).sort()).toEqual(['orgId', 'total', 'workDate'])
      expect(absence.payload).toEqual({ orgId, workDate, total: 1 })
      expect(absence.payloadSchemaVersion).toBe(1)
      expect(Object.keys(review.payload as Record<string, unknown>).sort()).toEqual(['orgId', 'reasons', 'total', 'workDate'])
      expect(review.payload).toEqual({
        orgId,
        workDate,
        total: 1,
        reasons: [{ userId: userR1, reasonCode: 'NO_MATCHING_SHIFT' }],
      })

      // Exactly once: a second dispatcher pass delivers nothing for this run.
      const second = deliveriesForOrg(await dispatchOnce(), orgId)
      expect(second).toEqual([])

      const post = await pool.query(
        `SELECT event_kind, delivery_state, attempts, payload::text AS payload_text FROM attendance_result_event_outbox
          WHERE scheduled_run_id = $1::uuid ORDER BY event_kind`,
        [created.runId],
      )
      expect(post.rows.map((r: { event_kind: string; delivery_state: string; attempts: number }) => [r.event_kind, r.delivery_state, r.attempts])).toEqual([
        ['attendance.absence.generated', 'delivered', 1],
        ['attendance.work_date.review_required', 'delivered', 1],
      ])
      // Byte-stable durable payload: the delivered rows' payload text is unchanged from the
      // pre-restart (pre-dispatch) durable copy.
      expect(post.rows.map((r: { payload_text: string }) => r.payload_text)).toEqual(prePayloadTexts)

      // Run stays completed; no source or per-user DML repeated by delivery.
      const runRow = await pool.query(`SELECT state FROM attendance_scheduled_runs WHERE run_id = $1::uuid`, [created.runId])
      expect(runRow.rows[0].state).toBe('completed')
      expect(await dmlSnapshot()).toEqual(before)
    })

    it('gate 3: review_count = 0 inserts NO review_required row (absence row only)', async () => {
      const orgId = orgIdFor('noreview1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-03-02'
      const userG1 = uuid()
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([{ userId: userG1, targetKind: 'generate', reviewReasonCode: null }]),
          ),
        ),
      )
      if (created.kind !== 'created_running') throw new Error('expected created_running')
      await sealGenerateTarget(orgId, created.runId, userG1, workDate, 'completed', true)
      const finalized = await withAllowlist(orgId, () =>
        withTxn((trx) => finalizeAttendanceScheduledRunV1(trx, { orgId, initiator: 'cron', workDate, runId: created.runId })),
      )
      expect(finalized.kind).toBe('finalized')
      const rows = await pool.query(
        `SELECT event_kind FROM attendance_result_event_outbox WHERE scheduled_run_id = $1::uuid ORDER BY event_kind`,
        [created.runId],
      )
      expect(rows.rows.map((r: { event_kind: string }) => r.event_kind)).toEqual(['attendance.absence.generated'])
    })

    it('gate 3+4: review_count > 0 inserts EXACTLY ONE review row whose reasons array is byte-for-byte the pinned ordinal (user_id-ascending) order, regardless of membership input order', async () => {
      const orgId = orgIdFor('revorder1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-03-03'
      const userR1 = '00000000-0000-4000-8000-00000000bbb1'
      const userR2 = '00000000-0000-4000-8000-00000000bbb2'
      const userR3 = '00000000-0000-4000-8000-00000000bbb3'
      // Deliberately scrambled input order — the pinned order must come from ordinal, not input.
      const created = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([
              { userId: userR3, targetKind: 'review', reviewReasonCode: 'WORK_DATE_ATTRIBUTION_AMBIGUOUS' },
              { userId: userR1, targetKind: 'review', reviewReasonCode: 'NO_MATCHING_SHIFT' },
              { userId: userR2, targetKind: 'review', reviewReasonCode: 'WORK_DATE_ATTRIBUTION_MISMATCH' },
            ]),
          ),
        ),
      )
      expect(created.kind).toBe('created_and_finalized')
      const runIdResult = await pool.query(`SELECT run_id::text AS run_id FROM attendance_scheduled_runs WHERE org_id = $1`, [orgId])
      const runId = runIdResult.rows[0].run_id as string
      const rows = await pool.query(
        `SELECT event_kind, payload, payload::text AS payload_text FROM attendance_result_event_outbox
          WHERE scheduled_run_id = $1::uuid AND event_kind = 'attendance.work_date.review_required'`,
        [runId],
      )
      expect(rows.rows.length).toBe(1)
      const payload = rows.rows[0].payload as { total: number; reasons: unknown[] }
      // Order-SENSITIVE deep equality: ordinal order == user_id ascending (O-2=(a)).
      expect(payload.reasons).toEqual([
        { userId: userR1, reasonCode: 'NO_MATCHING_SHIFT' },
        { userId: userR2, reasonCode: 'WORK_DATE_ATTRIBUTION_MISMATCH' },
        { userId: userR3, reasonCode: 'WORK_DATE_ATTRIBUTION_AMBIGUOUS' },
      ])
      expect(payload.total).toBe(3)
      // The durable byte stream the dispatcher will later deliver is this exact text; the
      // delivered payload equals the pre-restart durable copy byte-for-byte.
      const preText = rows.rows[0].payload_text as string
      const delivered = deliveriesForOrg(await dispatchOnce(), orgId)
      const deliveredReview = delivered.find((d) => d.eventKind === 'attendance.work_date.review_required')
      expect(deliveredReview).toBeDefined()
      const postText = await pool.query(
        `SELECT payload::text AS payload_text FROM attendance_result_event_outbox
          WHERE scheduled_run_id = $1::uuid AND event_kind = 'attendance.work_date.review_required'`,
        [runId],
      )
      expect(postText.rows[0].payload_text).toBe(preText)
      expect((deliveredReview as AttendanceOutboxDeliveryV1).payload).toEqual(payload)
    })
  })

  // ===========================================================================================
  // 2. Gate 5 — legacy posture: zero rows on EVERY W4 surface.
  // ===========================================================================================
  describe('gate 5 — legacy posture zero-outbox leg (module boundary)', () => {
    it('legacy_projection_only creates no run row, no target row, no operation row, and no outbox row', async () => {
      const orgId = orgIdFor('legacy1')
      // No rollout row, not allowlisted -> legacy_projection_only.
      const outcome = await withTxn((trx) =>
        createOrResumeAttendanceScheduledRunV1(
          trx,
          { orgId, initiator: 'cron', workDate: '2026-03-04' },
          memberResolverFor([{ userId: uuid(), targetKind: 'generate', reviewReasonCode: null }]),
        ),
      )
      expect(outcome).toEqual({ kind: 'org_legacy_zero_rows' })
      for (const [table, column] of [
        ['attendance_scheduled_runs', 'org_id'],
        ['attendance_scheduled_run_targets', 'org_id'],
        ['attendance_result_operations', 'org_id'],
        ['attendance_result_event_outbox', 'org_id'],
      ] as const) {
        const n = (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [orgId])).rows[0].n
        expect(n, `${table} must stay empty under legacy posture`).toBe(0)
      }
      // The synchronous best-effort emit half of gate 5 is the CALLER's unchanged legacy
      // path — `org_legacy_zero_rows` is the module-boundary signal that keeps it; the
      // caller cutover (and its byte-identical-response assertion) is a later slice.
    })
  })

  // ===========================================================================================
  // 3. Gate 6 — restart completes only unfinished users.
  // ===========================================================================================
  describe('gate 6 — restart completes only unfinished users', () => {
    it('a run interrupted after k of n users resumes the exact n−k remainder from durable evidence, replays the k users with zero DML, and folds counts equal to an uninterrupted control run', async () => {
      const workDate = '2026-03-05'
      const userA = '00000000-0000-4000-8000-00000000ccc1'
      const userB = '00000000-0000-4000-8000-00000000ccc2'
      const userC = '00000000-0000-4000-8000-00000000ccc3'
      const members: readonly AttendanceScheduledRunMemberInputV1[] = [
        { userId: userA, targetKind: 'generate', reviewReasonCode: null },
        { userId: userB, targetKind: 'generate', reviewReasonCode: null },
        { userId: userC, targetKind: 'generate', reviewReasonCode: null },
      ]

      // Uninterrupted control run.
      const orgU = orgIdFor('restartU')
      await setRolloutState(orgU, 'shadow')
      const createdU = await withAllowlist(orgU, () =>
        withTxn((trx) => createOrResumeAttendanceScheduledRunV1(trx, { orgId: orgU, initiator: 'cron', workDate }, memberResolverFor(members))),
      )
      if (createdU.kind !== 'created_running') throw new Error('expected created_running')
      await sealGenerateTarget(orgU, createdU.runId, userA, workDate, 'completed', true)
      await sealGenerateTarget(orgU, createdU.runId, userB, workDate, 'completed', true)
      await sealGenerateTarget(orgU, createdU.runId, userC, workDate, 'completed', false)
      const finalizedU = await withAllowlist(orgU, () =>
        withTxn((trx) => finalizeAttendanceScheduledRunV1(trx, { orgId: orgU, initiator: 'cron', workDate, runId: createdU.runId })),
      )
      expect(finalizedU).toEqual({ kind: 'finalized', runId: createdU.runId, completedUserCount: 3, generatedCount: 2, reviewCount: 0 })

      // Interrupted run: k = 1 (userA) completes, then the "process dies".
      const orgI = orgIdFor('restartI')
      await setRolloutState(orgI, 'shadow')
      const createdI = await withAllowlist(orgI, () =>
        withTxn((trx) => createOrResumeAttendanceScheduledRunV1(trx, { orgId: orgI, initiator: 'cron', workDate }, memberResolverFor(members))),
      )
      if (createdI.kind !== 'created_running') throw new Error('expected created_running')
      await sealGenerateTarget(orgI, createdI.runId, userA, workDate, 'completed', true)

      // Row-count + content-hash snapshot of the completed user's durable rows.
      const kSnapshot = async () => {
        const op = await pool.query(
          `SELECT count(*)::int AS n, coalesce(md5(string_agg(md5(row_to_json(o)::text), ',' ORDER BY o.operation_id)), '') AS h
             FROM (SELECT operation_id, state, response_snapshot, version FROM attendance_result_operations
                    WHERE org_id = $1 AND proof_user_id = $2::uuid) o`,
          [orgI, userA],
        )
        const oc = await pool.query(
          `SELECT count(*)::int AS n, coalesce(md5(string_agg(md5(row_to_json(x)::text), ',' ORDER BY x.target_id)), '') AS h
             FROM (SELECT o.target_id, o.terminal_outcome, o.failure_reason_code
                     FROM attendance_scheduled_run_target_outcomes o
                     JOIN attendance_scheduled_run_targets t ON t.id = o.target_id AND t.org_id = o.org_id
                    WHERE o.org_id = $1 AND t.user_id = $2::uuid) x`,
          [orgI, userA],
        )
        return { op: op.rows[0], oc: oc.rows[0] }
      }
      const beforeRestart = await kSnapshot()
      expect(beforeRestart.op.n).toBe(1)
      expect(beforeRestart.oc.n).toBe(1)

      // Restart: a fresh invocation resumes and derives the outstanding set from DURABLE
      // evidence (outcome rows), never an in-memory cursor — exactly {userB, userC}, in
      // ordinal order.
      const resumed = await withAllowlist(orgI, () =>
        withTxn((trx) => createOrResumeAttendanceScheduledRunV1(trx, { orgId: orgI, initiator: 'cron', workDate }, memberResolverFor(members))),
      )
      if (resumed.kind !== 'resumed') throw new Error('expected resumed, got ' + resumed.kind)
      expect(resumed.runId).toBe(createdI.runId)
      expect(resumed.readyToFinalize).toBe(false)
      expect(resumed.outstandingGenerateTargets.map((t) => t.userId)).toEqual([userB, userC])

      // The n−k remainder executes; the k completed user is REPLAYED with zero DML.
      await sealGenerateTarget(orgI, createdI.runId, userB, workDate, 'completed', true)
      await sealGenerateTarget(orgI, createdI.runId, userC, workDate, 'completed', false)
      const resumedAgain = await withAllowlist(orgI, () =>
        withTxn((trx) => createOrResumeAttendanceScheduledRunV1(trx, { orgId: orgI, initiator: 'cron', workDate }, memberResolverFor(members))),
      )
      if (resumedAgain.kind !== 'resumed') throw new Error('expected resumed, got ' + resumedAgain.kind)
      expect(resumedAgain.outstandingGenerateTargets).toEqual([])
      expect(resumedAgain.readyToFinalize).toBe(true)

      const finalizedI = await withAllowlist(orgI, () =>
        withTxn((trx) => finalizeAttendanceScheduledRunV1(trx, { orgId: orgI, initiator: 'cron', workDate, runId: createdI.runId })),
      )
      // Fold equality with the uninterrupted run (same membership, same outcomes).
      expect(finalizedI).toEqual({ kind: 'finalized', runId: createdI.runId, completedUserCount: 3, generatedCount: 2, reviewCount: 0 })

      // Byte-congruent replay: the k user's durable rows are untouched by the whole
      // resume/finalize sequence (count AND content hash).
      expect(await kSnapshot()).toEqual(beforeRestart)

      // The two runs' emitted absence payloads agree on `total` (per-org fields aside).
      const totals = await pool.query(
        `SELECT org_id, (payload ->> 'total')::int AS total FROM attendance_result_event_outbox
          WHERE org_id IN ($1, $2) AND event_kind = 'attendance.absence.generated' ORDER BY org_id`,
        [orgU, orgI].sort(),
      )
      expect(totals.rows.map((r: { total: number }) => r.total)).toEqual([2, 2])
    })
  })

  // ===========================================================================================
  // 4. Gate 7 ADDED leg — an abandon commits while a finalizer waits on the class-01 lock.
  // ===========================================================================================
  describe('gate 7 added leg — abandon commits while the finalizer waits on class-01', () => {
    it('the finalizer, once it acquires the lock, observes state=abandoned and returns the recorded outcome with zero DML (no outbox rows, no completed flip)', async () => {
      const orgId = orgIdFor('abwait1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-03-06'
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
      // All targets terminal — the finalizer would flip to `completed` if it won.
      await sealGenerateTarget(orgId, created.runId, userA, workDate, 'completed', true)

      const cA: PoolClient = await pool.connect()
      try {
        // Abandoner: open transaction, run the abandon transition, HOLD the commit — it now
        // holds the class-01 lock and the run row lock.
        await cA.query('BEGIN')
        const abandonOutcome = await withAllowlist(orgId, () =>
          abandonAttendanceScheduledRunV1(
            cA as unknown as AttendanceW4TransactionClientV1,
            abandonCallerFor(orgId, 'platform_admin'),
            { orgId, runId: created.runId },
            'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED',
          ),
        )
        expect(abandonOutcome.kind).toBe('abandoned')

        // Finalizer starts NOW (production wrapper, own connection) and must block on the
        // class-01 advisory lock the abandoner holds.
        const finalizePromise = withAllowlist(orgId, () =>
          withTxn((trx) => finalizeAttendanceScheduledRunV1(trx, { orgId, initiator: 'cron', workDate, runId: created.runId })),
        )
        // Deterministic wait: poll until an advisory lock wait is visible, then commit.
        let waited = false
        for (let i = 0; i < 200; i += 1) {
          const waiting = await pool.query(
            `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted = false`,
          )
          if (waiting.rows[0].n >= 1) {
            waited = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        expect(waited, 'the finalizer must actually wait on the advisory lock (constructed race, not sequential)').toBe(true)
        await cA.query('COMMIT')

        const finalizeOutcome = await finalizePromise
        expect(finalizeOutcome).toEqual({ kind: 'not_running', state: 'abandoned' })
      } finally {
        await cA.query('ROLLBACK').catch(() => undefined)
        cA.release()
      }

      // Zero DML from the losing finalizer: no outbox rows, run still abandoned, counts from
      // the abandoner's fold.
      const outbox = await pool.query(`SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE scheduled_run_id = $1::uuid`, [created.runId])
      expect(outbox.rows[0].n).toBe(0)
      const runRow = await pool.query(
        `SELECT state, completed_user_count FROM attendance_scheduled_runs WHERE run_id = $1::uuid`,
        [created.runId],
      )
      expect(runRow.rows[0]).toEqual({ state: 'abandoned', completed_user_count: 1 })
    })
  })

  // ===========================================================================================
  // 4b. P1-2 remediation P2-7 — gate 7's `FOR UPDATE` clause, abandon instance: a racer that
  //     never takes class-01 at all (a raw SQL running->completed transition) is the ONLY
  //     competitor that can expose this clause — two class-01 holders are already serialized by
  //     the advisory lock itself, which is why removing class-01 (not FOR UPDATE) is what the
  //     "abandon commits while a finalizer waits" leg above already covers.
  // ===========================================================================================
  describe('gate 7 (P2-7) — abandon\'s SELECT ... FOR UPDATE is load-bearing against a racer outside class-01', () => {
    it('the abandoner blocks on the racer\'s uncommitted row lock, re-reads fresh under the lock, and returns not_running/completed — never a false-positive abandoned', async () => {
      const orgId = orgIdFor('abandonfu1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-03-09'
      const initiator = 'cron'
      const runId = uuid()
      // Inserted directly (bypassing createOrResumeAttendanceScheduledRunV1, which would
      // auto-finalize a zero-generate-target run inline per section 1.9) with ZERO targets —
      // expected_user_count=0/review_count=0 keeps the deferred frozen-counts and
      // completion-outcome guards trivially satisfied for the racer's own legal completion
      // below, isolating this leg to abandon's own FOR UPDATE clause, nothing else.
      await pool.query(
        `INSERT INTO attendance_scheduled_runs (
            run_id, org_id, entrypoint, initiator, work_date, generation, accepted_write_posture,
            target_set_fingerprint, expected_user_count, review_count, state
          ) VALUES ($1::uuid,$2,'scheduled',$3,$4::date,1,'shadow',$5,0,0,'running')`,
        [runId, orgId, initiator, workDate, 'f'.repeat(64)],
      )

      const cA: PoolClient = await pool.connect()
      const cB: PoolClient = await pool.connect()
      try {
        // B: a raw-SQL competitor that NEVER acquires class-01 — a legal running->completed
        // transition, held open (uncommitted) so it exclusively locks the run row.
        await cB.query('BEGIN')
        await cB.query(
          `UPDATE attendance_scheduled_runs
              SET state = 'completed', completed_user_count = 0, generated_count = 0, finalized_at = now()
            WHERE org_id = $1 AND run_id = $2::uuid AND state = 'running'`,
          [orgId, runId],
        )

        // A: the REAL abandon transition, its own connection (bare BEGIN, no SERIALIZABLE
        // retry wrapper — the wrapper's own 40001 retry would otherwise re-run this call AFTER
        // B commits and mask the very race this leg exists to expose), starting NOW and
        // contending with B's held row lock on whichever statement reaches the row first.
        await cA.query('BEGIN')
        const abandonPromise = abandonAttendanceScheduledRunV1(
          cA as unknown as AttendanceW4TransactionClientV1,
          abandonCallerFor(orgId, 'platform_admin'),
          { orgId, runId },
          'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED',
        )

        let waited = false
        for (let i = 0; i < 200; i += 1) {
          const waiting = await pool.query(
            `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted`,
          )
          if (waiting.rows[0].n >= 1) {
            waited = true
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        expect(
          waited,
          "the abandoner must actually contend on the racer's uncommitted row lock (constructed race, not sequential)",
        ).toBe(true)
        await cB.query('COMMIT')

        const abandonOutcome = await abandonPromise
        await cA.query('COMMIT')
        expect(abandonOutcome).toEqual({ kind: 'not_running', state: 'completed' })
      } finally {
        await cA.query('ROLLBACK').catch(() => undefined)
        await cB.query('ROLLBACK').catch(() => undefined)
        cA.release()
        cB.release()
      }

      const runRow = await pool.query(`SELECT state FROM attendance_scheduled_runs WHERE run_id = $1::uuid`, [runId])
      expect(runRow.rows[0].state).toBe('completed')
    })
  })

  // ===========================================================================================
  // 5. Gate 8 — finalization atomicity: injected failures + one-txid witness.
  // ===========================================================================================
  describe('gate 8 — finalization atomicity (standalone path)', () => {
    async function makeReadyRun(label: string): Promise<{ orgId: string; runId: string; workDate: string }> {
      const orgId = orgIdFor(label)
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-03-07'
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
      return { orgId, runId: created.runId, workDate }
    }

    it('an injected failure AFTER the outbox insert and BEFORE the state flip leaves BOTH unwritten', async () => {
      const { orgId, runId, workDate } = await makeReadyRun('atom1')
      let sawOutboxInsert = false
      const err = await catchAsync(() =>
        withAllowlist(orgId, () =>
          withTxn((trx) => {
            const fault: AttendanceW4TransactionClientV1 = {
              async query(sql: string, params?: unknown[]) {
                if (/INSERT INTO attendance_result_event_outbox/.test(sql)) {
                  sawOutboxInsert = true
                }
                if (/UPDATE attendance_scheduled_runs\s+SET state = 'completed'/.test(sql)) {
                  const e = new Error('W4C2_TEST_INJECTED_FAULT')
                  ;(e as { code?: string }).code = 'W4C2_TEST_INJECTED_FAULT'
                  throw e
                }
                return trx.query(sql, params as unknown[])
              },
            } as AttendanceW4TransactionClientV1
            return finalizeAttendanceScheduledRunV1(fault, { orgId, initiator: 'cron', workDate, runId })
          }),
        ),
      )
      expect(String((err as { code?: string })?.code)).toBe('W4C2_TEST_INJECTED_FAULT')
      // Injection positive control: the outbox insert DID execute in-process before the fault.
      expect(sawOutboxInsert).toBe(true)
      const outbox = await pool.query(`SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE scheduled_run_id = $1::uuid`, [runId])
      expect(outbox.rows[0].n).toBe(0)
      const runRow = await pool.query(`SELECT state FROM attendance_scheduled_runs WHERE run_id = $1::uuid`, [runId])
      expect(runRow.rows[0].state).toBe('running')
    })

    it('the reverse order: an injected failure AT the outbox insert leaves both unwritten too, and the state flip never executes', async () => {
      const { orgId, runId, workDate } = await makeReadyRun('atom2')
      let sawStateFlip = false
      const err = await catchAsync(() =>
        withAllowlist(orgId, () =>
          withTxn((trx) => {
            const fault: AttendanceW4TransactionClientV1 = {
              async query(sql: string, params?: unknown[]) {
                if (/INSERT INTO attendance_result_event_outbox/.test(sql)) {
                  const e = new Error('W4C2_TEST_INJECTED_FAULT')
                  ;(e as { code?: string }).code = 'W4C2_TEST_INJECTED_FAULT'
                  throw e
                }
                if (/UPDATE attendance_scheduled_runs\s+SET state = 'completed'/.test(sql)) {
                  sawStateFlip = true
                }
                return trx.query(sql, params as unknown[])
              },
            } as AttendanceW4TransactionClientV1
            return finalizeAttendanceScheduledRunV1(fault, { orgId, initiator: 'cron', workDate, runId })
          }),
        ),
      )
      expect(String((err as { code?: string })?.code)).toBe('W4C2_TEST_INJECTED_FAULT')
      expect(sawStateFlip).toBe(false)
      const outbox = await pool.query(`SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE scheduled_run_id = $1::uuid`, [runId])
      expect(outbox.rows[0].n).toBe(0)
      const runRow = await pool.query(`SELECT state FROM attendance_scheduled_runs WHERE run_id = $1::uuid`, [runId])
      expect(runRow.rows[0].state).toBe('running')
      // Positive control: after the injections, the SAME run finalizes normally with ONE
      // txid across the outbox insert and the state flip (the gate 8 witness).
      const txids: string[] = []
      const finalized = await withAllowlist(orgId, () =>
        withTxn((trx) => {
          const witness: AttendanceW4TransactionClientV1 = {
            async query(sql: string, params?: unknown[]) {
              if (
                /INSERT INTO attendance_result_event_outbox/.test(sql) ||
                /UPDATE attendance_scheduled_runs\s+SET state = 'completed'/.test(sql)
              ) {
                const t = await trx.query('SELECT txid_current()::text AS txid', [])
                txids.push((t.rows[0] as { txid: string }).txid)
              }
              return trx.query(sql, params as unknown[])
            },
          } as AttendanceW4TransactionClientV1
          return finalizeAttendanceScheduledRunV1(witness, { orgId, initiator: 'cron', workDate, runId })
        }),
      )
      expect(finalized.kind).toBe('finalized')
      expect(txids.length).toBe(2)
      expect(new Set(txids).size).toBe(1)
    })
  })

  // ===========================================================================================
  // 6. Gate 15 (+ gate 19/23 extensions) — lock order, exact advisory-lock set, zero source DML.
  // ===========================================================================================
  describe('gate 15 — lock order + no class-11 + no source DML (recorded-statement witness)', () => {
    function expectedKeys(orgId: string, workDate: string): { class00: string; class01: string } {
      const class00 = buildAttendanceCalculationRolloutAdvisoryKey(parseCanonicalAttendanceRolloutOrgKeyV1(orgId)).toString()
      const class01 = buildAttendanceScheduledRunAdvisoryKey(
        parseCanonicalAttendanceScheduledRunKeyV1({ orgId, initiator: 'cron', workDate }),
      ).toString()
      return { class00, class01 }
    }

    it('finalization: class-00 shared strictly before class-01 exclusive, EXACTLY that advisory set (no class-11), zero source DML — with a DML-visibility positive control', async () => {
      const orgId = orgIdFor('lockfin1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-03-08'
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

      const log: RecordedStatement[] = []
      const finalized = await withAllowlist(orgId, () =>
        withTxn((trx) => finalizeAttendanceScheduledRunV1(recordingTrx(trx, log), { orgId, initiator: 'cron', workDate, runId: created.runId })),
      )
      expect(finalized.kind).toBe('finalized')

      const { class00, class01 } = expectedKeys(orgId, workDate)
      const acquisitions = advisoryAcquisitions(log)
      // EXACT set and order: one shared class-00, then one exclusive class-01. Anything else
      // (a class-11 target key, a duplicate, a reordering) fails this deep equality.
      expect(acquisitions).toEqual([
        { mode: 'shared', key: class00 },
        { mode: 'exclusive', key: class01 },
      ])
      // The class-01 key sits in the reserved [2^62, 2^63) band (gate 16's range contract).
      const key01 = BigInt(class01)
      expect(key01 >= 2n ** 62n && key01 < 2n ** 63n).toBe(true)
      // Zero source DML inside the finalization transaction.
      expect(sourceDmlStatements(log)).toEqual([])
      // Positive control: the recorder DOES see this transaction's own legitimate DML — the
      // outbox insert and the run-state flip — so an injected source-DML statement could not
      // hide from the assertion above.
      expect(log.some((e) => /INSERT INTO attendance_result_event_outbox/.test(e.sql))).toBe(true)
      expect(log.some((e) => /UPDATE attendance_scheduled_runs/.test(e.sql))).toBe(true)
    })

    it('abandoned transition (gate 23 extension of gate 15): same lock order, EXACT advisory set, zero source DML, zero outbox insert', async () => {
      const orgId = orgIdFor('lockab1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-03-09'
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

      const log: RecordedStatement[] = []
      const outcome = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          abandonAttendanceScheduledRunV1(
            recordingTrx(trx, log),
            abandonCallerFor(orgId, 'platform_admin'),
            { orgId, runId: created.runId },
            'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED',
          ),
        ),
      )
      expect(outcome.kind).toBe('abandoned')

      const { class00, class01 } = expectedKeys(orgId, workDate)
      expect(advisoryAcquisitions(log)).toEqual([
        { mode: 'shared', key: class00 },
        { mode: 'exclusive', key: class01 },
      ])
      expect(sourceDmlStatements(log)).toEqual([])
      // No outbox insert on the abandoned path — in the recorded statements AND durably.
      expect(log.some((e) => /INSERT INTO attendance_result_event_outbox/.test(e.sql))).toBe(false)
      const outbox = await pool.query(`SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE scheduled_run_id = $1::uuid`, [created.runId])
      expect(outbox.rows[0].n).toBe(0)
      // Positive control: the abandon's own run-row UPDATE is visible to the recorder.
      expect(log.some((e) => /UPDATE attendance_scheduled_runs/.test(e.sql))).toBe(true)
    })

    it('zero-generate-target creation (gate 19: "gate 15 applies verbatim"): EXACT advisory set {class-00 shared, class-01 exclusive}, no class-11, zero source DML, both outbox inserts inline', async () => {
      const orgId = orgIdFor('lockzero1')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-03-10'
      const userR = uuid()
      const log: RecordedStatement[] = []
      const outcome = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            recordingTrx(trx, log),
            { orgId, initiator: 'cron', workDate },
            memberResolverFor([{ userId: userR, targetKind: 'review', reviewReasonCode: 'NO_MATCHING_SHIFT' }]),
          ),
        ),
      )
      expect(outcome.kind).toBe('created_and_finalized')

      const { class00, class01 } = expectedKeys(orgId, workDate)
      expect(advisoryAcquisitions(log)).toEqual([
        { mode: 'shared', key: class00 },
        { mode: 'exclusive', key: class01 },
      ])
      expect(sourceDmlStatements(log)).toEqual([])
      expect(log.filter((e) => /INSERT INTO attendance_result_event_outbox/.test(e.sql)).length).toBe(2)
    })
  })

  // ===========================================================================================
  // 7. Gate 17 — suspended pause and mid-run finalize-exactly-once.
  // ===========================================================================================
  describe('gate 17 — suspended pause, then finalize exactly once', () => {
    it('finalization under a blocked org is DEFERRED with zero DML and the run stays running; once the posture matches the frozen posture again the next attempt finalizes exactly once', async () => {
      const orgId = orgIdFor('susp1')
      await setRolloutState(orgId, 'authoritative')
      const workDate = '2026-03-11'
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
      await sealGenerateTarget(orgId, created.runId, userA, workDate, 'completed', true, 'authoritative')

      // Org suspended mid-run: finalization is a closed, retryable deferral — zero DML.
      await setRolloutState(orgId, 'suspended')
      const deferred = await withAllowlist(orgId, () =>
        withTxn((trx) => finalizeAttendanceScheduledRunV1(trx, { orgId, initiator: 'cron', workDate, runId: created.runId })),
      )
      expect(deferred).toEqual({ kind: 'deferred', code: 'ATTENDANCE_SCHEDULED_RUN_FINALIZATION_DEFERRED' })
      const still = await pool.query(`SELECT state FROM attendance_scheduled_runs WHERE run_id = $1::uuid`, [created.runId])
      expect(still.rows[0].state).toBe('running')
      const outboxDuring = await pool.query(`SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE scheduled_run_id = $1::uuid`, [created.runId])
      expect(outboxDuring.rows[0].n).toBe(0)

      // Posture returns to the run's frozen `authoritative`; the next attempt finalizes —
      // exactly once (the follow-up call is a zero-DML recorded-outcome read).
      await setRolloutState(orgId, 'authoritative')
      const finalized = await withAllowlist(orgId, () =>
        withTxn((trx) => finalizeAttendanceScheduledRunV1(trx, { orgId, initiator: 'cron', workDate, runId: created.runId })),
      )
      expect(finalized).toEqual({ kind: 'finalized', runId: created.runId, completedUserCount: 1, generatedCount: 1, reviewCount: 0 })
      const again = await withAllowlist(orgId, () =>
        withTxn((trx) => finalizeAttendanceScheduledRunV1(trx, { orgId, initiator: 'cron', workDate, runId: created.runId })),
      )
      expect(again).toEqual({ kind: 'not_running', state: 'completed' })
      const outboxAfter = await pool.query(
        `SELECT count(*)::int AS n FROM attendance_result_event_outbox WHERE scheduled_run_id = $1::uuid AND event_kind = 'attendance.absence.generated'`,
        [created.runId],
      )
      expect(outboxAfter.rows[0].n).toBe(1)
    })
  })

  // ===========================================================================================
  // 8. Gate 22 — positive/negative controls for the private minting factory.
  // ===========================================================================================
  describe('gate 22 controls — mint-from-inserted-row equivalence and transactionality', () => {
    it('positive control: zero-generate inline-finalization outbox rows satisfy the full discriminated union, column-indistinguishable from rehydrated-path rows', async () => {
      // Minted path (section 1.9 inline finalization).
      const orgMint = orgIdFor('mint22p')
      await setRolloutState(orgMint, 'shadow')
      const mintOutcome = await withAllowlist(orgMint, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId: orgMint, initiator: 'cron', workDate: '2026-03-12' },
            memberResolverFor([{ userId: uuid(), targetKind: 'review', reviewReasonCode: 'NO_MATCHING_SHIFT' }]),
          ),
        ),
      )
      expect(mintOutcome.kind).toBe('created_and_finalized')

      // Rehydrated path (standalone finalization over a separately committed run row).
      const orgRehy = orgIdFor('rehy22p')
      await setRolloutState(orgRehy, 'shadow')
      const workDate = '2026-03-12'
      const userA = uuid()
      const createdRehy = await withAllowlist(orgRehy, () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId: orgRehy, initiator: 'cron', workDate },
            memberResolverFor([{ userId: userA, targetKind: 'generate', reviewReasonCode: null }]),
          ),
        ),
      )
      if (createdRehy.kind !== 'created_running') throw new Error('expected created_running')
      await sealGenerateTarget(orgRehy, createdRehy.runId, userA, workDate, 'completed', true)
      const finalizedRehy = await withAllowlist(orgRehy, () =>
        withTxn((trx) => finalizeAttendanceScheduledRunV1(trx, { orgId: orgRehy, initiator: 'cron', workDate, runId: createdRehy.runId })),
      )
      expect(finalizedRehy.kind).toBe('finalized')

      // Column-level shape comparison at the DB layer: identical discriminated-union posture.
      const shape = async (orgId: string) =>
        (
          await pool.query(
            `SELECT event_kind, identity_kind, entrypoint,
                    (scheduled_run_id IS NOT NULL) AS has_run_id,
                    (operation_id IS NOT NULL) AS has_operation_id,
                    delivery_state, payload_schema_version
               FROM attendance_result_event_outbox
              WHERE org_id = $1 AND event_kind = 'attendance.absence.generated'`,
            [orgId],
          )
        ).rows
      const mintShape = await shape(orgMint)
      const rehyShape = await shape(orgRehy)
      expect(mintShape.length).toBe(1)
      expect(mintShape).toEqual(rehyShape)
      expect(mintShape[0]).toEqual({
        event_kind: 'attendance.absence.generated',
        identity_kind: 'scheduled_run',
        entrypoint: 'scheduled',
        has_run_id: true,
        has_operation_id: false,
        delivery_state: 'pending',
        payload_schema_version: 1,
      })
    })

    it('negative control: rolling back the run-creation transaction AFTER the mint ran in-process leaves ZERO committed rows — the mint commits nothing ahead of its enclosing transaction', async () => {
      const orgId = orgIdFor('mint22n')
      await setRolloutState(orgId, 'shadow')
      let mintRanInProcess = false
      const err = await catchAsync(() =>
        withAllowlist(orgId, () =>
          withTxn(async (trx) => {
            const outcome = await createOrResumeAttendanceScheduledRunV1(
              trx,
              { orgId, initiator: 'cron', workDate: '2026-03-13' },
              memberResolverFor([{ userId: uuid(), targetKind: 'review', reviewReasonCode: 'NO_MATCHING_SHIFT' }]),
            )
            // `created_and_finalized` can ONLY be produced through the private mint factory
            // (section 1.9) — the outbox insert has already executed in-process here.
            expect(outcome.kind).toBe('created_and_finalized')
            mintRanInProcess = true
            const e = new Error('W4C2_TEST_INJECTED_ROLLBACK')
            ;(e as { code?: string }).code = 'W4C2_TEST_INJECTED_ROLLBACK'
            throw e
          }),
        ),
      )
      expect(String((err as { code?: string })?.code)).toBe('W4C2_TEST_INJECTED_ROLLBACK')
      expect(mintRanInProcess).toBe(true)
      for (const table of ['attendance_scheduled_runs', 'attendance_scheduled_run_targets', 'attendance_result_event_outbox'] as const) {
        const n = (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [orgId])).rows[0].n
        expect(n, `${table} must have zero committed rows after the injected rollback`).toBe(0)
      }
    })
  })

  // ===========================================================================================
  // 9. Gate 23 extended legs — zero-SQL rejection witness + terminal-audit-field immutability.
  // ===========================================================================================
  describe('gate 23 extended — instrumented zero-lock-wait rejection + audit immutability', () => {
    it('an unauthorized abandon issues ZERO SQL statements (therefore zero lock waits, zero DML); the authorized positive control shows the counter counting', async () => {
      const orgId = orgIdFor('ab23a')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-03-14'
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

      // Rejected call: posture outside {platform_admin, attendance_admin} — the recording
      // client proves NOT ONE statement reached the database (the strongest possible
      // "zero lock-wait" witness: no acquisition was even attempted).
      const rejectedLog: RecordedStatement[] = []
      const err = await catchAsync(() =>
        withTxn((trx) =>
          abandonAttendanceScheduledRunV1(
            recordingTrx(trx, rejectedLog),
            abandonCallerFor(orgId, 'operator' as never),
            { orgId, runId: created.runId },
            'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED',
          ),
        ),
      )
      expect(String((err as { code?: string })?.code)).toBe('ATTENDANCE_WRITE_NOT_AUTHORIZED')
      expect(rejectedLog).toEqual([])

      // Positive control on the SAME run with the SAME instrument: the authorized call's
      // statements (including both advisory acquisitions) ARE counted — the zero above is a
      // measured zero, not a broken counter.
      const authorizedLog: RecordedStatement[] = []
      const outcome = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          abandonAttendanceScheduledRunV1(
            recordingTrx(trx, authorizedLog),
            abandonCallerFor(orgId, 'attendance_admin'),
            { orgId, runId: created.runId },
            'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED',
          ),
        ),
      )
      expect(outcome.kind).toBe('abandoned')
      expect(authorizedLog.length).toBeGreaterThan(0)
      expect(advisoryAcquisitions(authorizedLog).length).toBe(2)
    })

    it('abandoned_by_actor_posture (and the other audit fields) cannot be changed by any subsequent UPDATE once the run is abandoned', async () => {
      const orgId = orgIdFor('ab23b')
      await setRolloutState(orgId, 'shadow')
      const workDate = '2026-03-15'
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
      const abandoned = await withAllowlist(orgId, () =>
        withTxn((trx) =>
          abandonAttendanceScheduledRunV1(trx, abandonCallerFor(orgId, 'platform_admin'), { orgId, runId: created.runId }, 'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED'),
        ),
      )
      expect(abandoned.kind).toBe('abandoned')

      // The column sits in the trigger's MUTABLE allowlist (it must be writable during the
      // running->abandoned transition itself) — what protects it afterwards is the
      // out-of-terminal-state check. Relaxing that check while leaving the column mutable
      // is the exact mutation this leg exists to catch.
      const flip = await catchAsync(() =>
        pool.query(`UPDATE attendance_scheduled_runs SET abandoned_by_actor_posture = 'attendance_admin' WHERE run_id = $1::uuid`, [created.runId]),
      )
      expect(String((flip as Error)?.message)).toMatch(/W4C2_RUN_STATE/)
      const reasonFlip = await catchAsync(() =>
        pool.query(`UPDATE attendance_scheduled_runs SET abandon_reason_code = NULL WHERE run_id = $1::uuid`, [created.runId]),
      )
      expect(String((reasonFlip as Error)?.message)).toMatch(/W4C2_RUN_STATE/)
      const resurrect = await catchAsync(() =>
        pool.query(`UPDATE attendance_scheduled_runs SET state = 'running' WHERE run_id = $1::uuid`, [created.runId]),
      )
      expect(String((resurrect as Error)?.message)).toMatch(/W4C2_RUN_STATE/)
      const row = await pool.query(
        `SELECT state, abandoned_by_actor_posture, abandon_reason_code FROM attendance_scheduled_runs WHERE run_id = $1::uuid`,
        [created.runId],
      )
      expect(row.rows[0]).toEqual({
        state: 'abandoned',
        abandoned_by_actor_posture: 'platform_admin',
        abandon_reason_code: 'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED',
      })
    })
  })
})
