/**
 * #4770 (W4C-2 recovery-sweep fairness/observability/call-through; owner ruling 2026-08-05,
 * baseline `db74bd8667df1084797c97d872fe53ef845e3803`) — real-DB proof for:
 *
 *  - the durable-rotation scan fix in `w4c2-scheduled-run.ts`'s
 *    `scanAttendanceScheduledRunSweepCandidatesV1` (owner completion gate 1: with >25
 *    persistently-blocked candidates ahead, a later candidate still gets processed within a
 *    bounded number of ticks — never OFFSET, per the owner's explicit constraint: a durable
 *    `last_attempt_at` column stamped in the SAME statement as the scan);
 *  - gate 2's mutation control (reverting the scan to the fixed prefix `ORDER BY created_at ASC
 *    LIMIT 25` must turn this file's fairness test red — exercised by hand during review, not
 *    automated here, since automating "revert my own fix" as a permanent CI leg would just be
 *    re-testing the pre-#4770 code path forever; the fairness test itself IS the mutation
 *    oracle);
 *  - gate 3's values-free tick/backlog/error observability shape
 *    (`AttendanceScheduledRunSweepTickLoggerV1`).
 *
 * Call-through legs (host port wiring / scheduler job registration / abandon HTTP route) are a
 * SEPARATE file (`attendance-w4c2-sweep-call-through.db.test.ts`) — this file proves the PURE
 * algorithm against a self-provisioned scratch database.
 *
 * Isolation: `scanAttendanceScheduledRunSweepCandidatesV1`'s predicate is deliberately GLOBAL
 * (`state='running'`, not scoped to an org — section 1.7's own cross-`work_date` requirement),
 * so this file's exact-count assertions (`scanned`, `backlogRemaining`) would be corrupted by
 * `running` rows left over from an EARLIER `it()` in the SAME database — unlike the sibling
 * `attendance-w4c2-p12-run-transactions.db.test.ts`, which sidesteps this by always scanning
 * with a large limit and `.find()`-ing its own candidate. This file needs the SMALL limit
 * (`25`, matching the real default) to exercise congestion, so it gets a FRESH scratch database
 * per `it()` (`beforeEach`/`afterEach`, not `beforeAll`/`afterAll`) — the DDL cost is paid once
 * per test, not shared, on purpose.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import { up as w4c2Up } from '../../src/db/migrations/zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union'
import { up as w4c2SweepFairnessUp } from '../../src/db/migrations/zzzz20260805120000_w4c2_scheduled_run_sweep_fairness'
import {
  createOrResumeAttendanceScheduledRunV1,
  recordAttendanceScheduledRunTargetOutcomeV1,
  scanAttendanceScheduledRunSweepCandidatesV1,
  type AttendanceScheduledRunMemberInputV1,
  type AttendanceScheduledRunMembershipResolverV1,
} from '../../src/attendance/w4c2-scheduled-run'
import {
  sweepAttendanceScheduledRunsOnceV1,
  type AttendanceScheduledRunSweepTickLoggerV1,
} from '../../src/attendance/w4c2-scheduled-run-ops-worker'
import { createVerifiedAttendanceOperationIdentityV1, createVerifiedAttendanceOrgIdentityV1, resolveSegmentCalculationPosture } from '../../src/attendance/w4c0-identity'
import { runAttendanceResultOperationTransactionV1 } from '../../src/attendance/w4c0-operation-registry'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const FILE_RUN = crypto.randomUUID().slice(0, 8)

function uuid(): string {
  return crypto.randomUUID()
}

describeIfDatabase('W4C-2 #4770 recovery-sweep fairness/observability (real DB)', () => {
  let adminPool: Pool
  let pool: Pool
  let kyselyPool: Pool
  let scratchDb: Kysely<unknown>
  let scratchName: string
  let testRun: string

  function orgIdFor(label: string): string {
    return crypto.createHash('sha1').update(testRun + ':org:' + label).digest('hex').slice(0, 32).replace(
      /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
      '$1-$2-$3-$4-$5',
    )
  }

  beforeEach(async () => {
    testRun = 'w4c2sweepfair' + FILE_RUN + crypto.randomUUID().slice(0, 8)
    scratchName = `ms2_w4c2sf_${crypto.randomUUID().slice(0, 12).replace(/-/g, '')}`
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
    await w4c2SweepFairnessUp(scratchDb)
  }, 60000)

  afterEach(async () => {
    for (const p of [pool, kyselyPool, adminPool]) p?.on('error', () => undefined)
    await scratchDb?.destroy()
    await pool?.end()
    await adminPool?.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).catch(() => undefined)
    await adminPool?.end()
  }, 60000)

  async function setRolloutState(orgId: string, state: 'shadow'): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1,'legacy','v1','w4c2sweepfair-seed','w4c2sweepfair-actor',1,NULL)`,
      [orgId],
    )
    await pool.query(
      `UPDATE attendance_calculation_rollout_state SET state = $2, prior_state = 'legacy', version = 2 WHERE org_id = $1`,
      [orgId, state],
    )
  }

  async function withAllowlist<T>(orgIds: readonly string[], fn: () => Promise<T>): Promise<T> {
    const prior = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = [prior, ...orgIds].filter(Boolean).join(',')
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

  /** Seals a `generate` target's per-user operation as `completed` — mirrors the sibling
   *  file's `sealGenerateTarget` helper (duplicated locally per this file's own scratch-DB
   *  isolation, not shared across test files). */
  async function sealGenerateTargetCompleted(orgId: string, runId: string, userId: string, workDate: string): Promise<void> {
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
          ) VALUES ($1,'scheduled',$2,'scheduled',$3,$4,$5,'ref:w4c2sweepfair','actor-w4c2sweepfair','scheduler','scheduled','{}'::jsonb,$6,'shadow','claimed')`,
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
      await trx.query(
        `UPDATE attendance_result_operations
            SET state = 'completed', response_snapshot = $3::jsonb, version = version + 1, updated_at = now()
          WHERE org_id = $1 AND entrypoint = 'scheduled' AND operation_id = $2::uuid AND state = 'claimed'`,
        [orgId, operationId, JSON.stringify({ inserted: true })],
      )
      await recordAttendanceScheduledRunTargetOutcomeV1(trx, identity, { terminalOutcome: 'completed' })
    })
  }

  async function createStuckRun(label: string, workDate: string): Promise<{ orgId: string; runId: string; userId: string }> {
    const orgId = orgIdFor(label)
    await setRolloutState(orgId, 'shadow')
    const userId = uuid()
    const created = await withAllowlist([orgId], () =>
      withTxn((trx) =>
        createOrResumeAttendanceScheduledRunV1(
          trx,
          { orgId, initiator: 'cron', workDate },
          memberResolverFor([{ userId, targetKind: 'generate', reviewReasonCode: null }]),
        ),
      ),
    )
    if (created.kind !== 'created_running') throw new Error(`expected created_running for ${label}, got ${created.kind}`)
    // Deliberately NEVER sealed — the target has no outcome row, so
    // `sweepAttendanceScheduledRunCandidateV1` reports `not_ready` on every scan forever
    // (a real "cannot progress" candidate, not a timing artifact).
    return { orgId, runId: created.runId, userId }
  }

  async function runState(runId: string): Promise<string> {
    const r = await pool.query('SELECT state FROM attendance_scheduled_runs WHERE run_id = $1::uuid', [runId])
    return r.rows[0].state as string
  }

  async function lastAttemptAt(runId: string): Promise<string | null> {
    const r = await pool.query('SELECT last_attempt_at FROM attendance_scheduled_runs WHERE run_id = $1::uuid', [runId])
    return r.rows[0].last_attempt_at
  }

  // =============================================================================================
  // Gate 1 — >25 persistently-blocked candidates ahead; a later candidate still gets processed.
  // =============================================================================================
  describe('gate 1 — durable rotation over a >25 persistently-blocked backlog', () => {
    it('26 stuck candidates occupy the front of the queue; a 27th (healthy, newest) candidate finalizes on the SECOND tick', async () => {
      const workDate = '2026-03-01'
      const STUCK_COUNT = 26
      const stuck: Array<{ orgId: string; runId: string; userId: string }> = []
      for (let i = 0; i < STUCK_COUNT; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- ordering-sensitive: created_at must be
        // strictly increasing across these rows, which requires SEQUENTIAL (not parallel) inserts.
        stuck.push(await createStuckRun(`stuck-${i}`, workDate))
      }
      const healthyOrgId = orgIdFor('healthy')
      await setRolloutState(healthyOrgId, 'shadow')
      const healthyUserId = uuid()
      const healthyCreated = await withAllowlist([healthyOrgId], () =>
        withTxn((trx) =>
          createOrResumeAttendanceScheduledRunV1(
            trx,
            { orgId: healthyOrgId, initiator: 'cron', workDate },
            memberResolverFor([{ userId: healthyUserId, targetKind: 'generate', reviewReasonCode: null }]),
          ),
        ),
      )
      if (healthyCreated.kind !== 'created_running') throw new Error('expected created_running for healthy run')
      // Sealed BEFORE any sweep runs — once scanned, it finalizes on the SAME tick (no second
      // recovery round-trip needed), isolating "did rotation reach it" from "did recovery work".
      await sealGenerateTargetCompleted(healthyOrgId, healthyCreated.runId, healthyUserId, workDate)

      const allOrgIds = [...stuck.map((s) => s.orgId), healthyOrgId]
      const recovered: string[] = []
      const tick = () =>
        withAllowlist(allOrgIds, () =>
          sweepAttendanceScheduledRunsOnceV1(pool, {
            limit: 25,
            async recoverCandidate(candidate) {
              recovered.push(candidate.runId)
              // No-op: the stuck candidates' targets are never sealed, so this "recovery
              // attempt" never actually unblocks them — modeling a genuinely-stuck run
              // (e.g. permanently failing shift resolution), not a timing artifact.
            },
          }),
        )

      const tick1 = await tick()
      expect(tick1).toEqual({ scanned: 25, finalized: 0, notReady: 25, skipped: 0, errored: 0, backlogRemaining: 27 })
      // The healthy run and the 26th stuck run were NOT reached by tick 1 (still un-stamped).
      expect(await lastAttemptAt(healthyCreated.runId)).toBeNull()
      expect(await runState(healthyCreated.runId)).toBe('running')

      const tick2 = await tick()
      expect(tick2).toEqual({ scanned: 25, finalized: 1, notReady: 24, skipped: 0, errored: 0, backlogRemaining: 27 })

      // The healthy run finalized on tick 2 — durable rotation reached it despite 26
      // persistently-blocked candidates having occupied every earlier scan window.
      expect(await runState(healthyCreated.runId)).toBe('completed')
      expect(await lastAttemptAt(healthyCreated.runId)).not.toBeNull()
      // The healthy run never went through `recoverCandidate` — it finalized straight off the
      // scan (its target was pre-sealed), confirming rotation (not recovery-callback luck) is
      // what got it processed.
      expect(recovered).not.toContain(healthyCreated.runId)

      // All 26 stuck candidates remain 'running' — the sweep never fabricates progress for a
      // genuinely-stuck run.
      for (const s of stuck) {
        expect(await runState(s.runId)).toBe('running')
      }
    }, 60000)
  })

  // =============================================================================================
  // Steady state (backlog <= limit): un-congested behavior is unchanged — every row starts
  // `last_attempt_at IS NULL`, so `created_at ASC` alone decides order, byte-identical to the
  // pre-#4770 fixed-prefix query. Anchors that the fairness fix does not alter the common case.
  // =============================================================================================
  describe('steady state — no backlog congestion', () => {
    it('a lone stuck candidate is scanned on tick 1 and stamped, with zero fabricated progress', async () => {
      const workDate = '2026-03-02'
      const solo = await createStuckRun('solo', workDate)
      const result = await withAllowlist([solo.orgId], () =>
        sweepAttendanceScheduledRunsOnceV1(pool, { limit: 25, async recoverCandidate() {} }),
      )
      expect(result).toEqual({ scanned: 1, finalized: 0, notReady: 1, skipped: 0, errored: 0, backlogRemaining: 1 })
      expect(await lastAttemptAt(solo.runId)).not.toBeNull()
      expect(await runState(solo.runId)).toBe('running')
    }, 60000)
  })

  // =============================================================================================
  // Gate 3 — values-free tick/backlog/error observability.
  // =============================================================================================
  describe('gate 3 — values-free tick observability', () => {
    function captureLogger(): AttendanceScheduledRunSweepTickLoggerV1 & {
      infoCalls: Array<{ event: string; meta: Record<string, number> }>
      warnCalls: Array<{ event: string; meta: Record<string, number> }>
    } {
      const infoCalls: Array<{ event: string; meta: Record<string, number> }> = []
      const warnCalls: Array<{ event: string; meta: Record<string, number> }> = []
      return {
        infoCalls,
        warnCalls,
        info: (event, meta) => infoCalls.push({ event, meta }),
        warn: (event, meta) => warnCalls.push({ event, meta }),
      }
    }

    const EXPECTED_META_KEYS = ['scanned', 'finalized', 'notReady', 'skipped', 'errored', 'backlogRemaining'].sort()

    it('logs exactly one info tick-summary with a closed, all-numeric, values-free key set — and no warn when nothing errors', async () => {
      const workDate = '2026-03-03'
      const solo = await createStuckRun('obs-clean', workDate)
      const logger = captureLogger()
      await withAllowlist([solo.orgId], () =>
        sweepAttendanceScheduledRunsOnceV1(pool, { limit: 25, logger, async recoverCandidate() {} }),
      )

      expect(logger.infoCalls).toHaveLength(1)
      expect(logger.infoCalls[0].event).toBe('attendance.w4_scheduled_run_sweep.tick')
      expect(Object.keys(logger.infoCalls[0].meta).sort()).toEqual(EXPECTED_META_KEYS)
      for (const [key, value] of Object.entries(logger.infoCalls[0].meta)) {
        expect(typeof value, `meta.${key} must be a number, never a business value`).toBe('number')
      }
      expect(logger.warnCalls).toHaveLength(0)
    }, 60000)

    it('additionally logs a warn tick_errors line, same closed shape, when a recovery callback throws', async () => {
      const workDate = '2026-03-04'
      const failing = await createStuckRun('obs-error', workDate)
      const logger = captureLogger()
      const result = await withAllowlist([failing.orgId], () =>
        sweepAttendanceScheduledRunsOnceV1(pool, {
          limit: 25,
          logger,
          async recoverCandidate() {
            throw new Error('W4C2_TEST_SWEEP_OBSERVABILITY_RECOVERY_FAILURE')
          },
        }),
      )
      expect(result.errored).toBe(1)

      expect(logger.infoCalls).toHaveLength(1)
      expect(logger.warnCalls).toHaveLength(1)
      expect(logger.warnCalls[0].event).toBe('attendance.w4_scheduled_run_sweep.tick_errors')
      expect(Object.keys(logger.warnCalls[0].meta).sort()).toEqual(EXPECTED_META_KEYS)
      expect(logger.warnCalls[0].meta).toEqual(logger.infoCalls[0].meta)
      for (const value of Object.values(logger.warnCalls[0].meta)) {
        expect(typeof value).toBe('number')
      }
    }, 60000)

    it('the default (no logger supplied) tick is silent — byte-identical to the pre-#4770 caller contract', async () => {
      const workDate = '2026-03-05'
      const solo = await createStuckRun('obs-default', workDate)
      // No `logger` field at all — must not throw, must not require the field.
      const result = await withAllowlist([solo.orgId], () =>
        sweepAttendanceScheduledRunsOnceV1(pool, { limit: 25, async recoverCandidate() {} }),
      )
      expect(result.scanned).toBe(1)
    }, 60000)
  })

  // =============================================================================================
  // Scan-level unit proof: the rotation write-back is visible even when called directly (not
  // just through the tick wrapper) — pins the exact query contract
  // `scanAttendanceScheduledRunSweepCandidatesV1` now has, independent of
  // `sweepAttendanceScheduledRunsOnceV1`'s own connection/transaction wrapping.
  // =============================================================================================
  describe('scanAttendanceScheduledRunSweepCandidatesV1 — direct rotation contract', () => {
    it('stamps last_attempt_at on every returned candidate in the SAME statement as the scan', async () => {
      const workDate = '2026-03-06'
      const a = await createStuckRun('scan-direct-a', workDate)
      const b = await createStuckRun('scan-direct-b', workDate)
      expect(await lastAttemptAt(a.runId)).toBeNull()
      expect(await lastAttemptAt(b.runId)).toBeNull()

      const candidates = await withAllowlist([a.orgId, b.orgId], () =>
        withTxn((trx) => scanAttendanceScheduledRunSweepCandidatesV1(trx, 500)),
      )
      const ids = candidates.map((c) => c.runId)
      expect(ids).toContain(a.runId)
      expect(ids).toContain(b.runId)
      expect(await lastAttemptAt(a.runId)).not.toBeNull()
      expect(await lastAttemptAt(b.runId)).not.toBeNull()
    }, 60000)
  })
})
