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
  type AttendanceScheduledRunSweepCandidateV1,
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
      // #4770 follow-up: 27 running rows, 25 scanned/stamped this tick — the 26th stuck run and
      // the healthy run are the 2 rows still `last_attempt_at IS NULL` after this tick's scan.
      // `oldestRunningAttemptAgeSeconds` is asserted separately below (not inlined into this
      // `toEqual`): all 25 stamped rows share the SAME `now()` this tick's transaction saw
      // (PostgreSQL's `now()` is transaction-stable), so it is deterministically exactly `0` —
      // an exact assertion, not a bound.
      const { oldestRunningAttemptAgeSeconds: tick1Age, ...tick1Rest } = tick1
      expect(tick1Rest).toEqual({
        scanned: 25,
        finalized: 0,
        notReady: 25,
        skipped: 0,
        errored: 0,
        backlogRemaining: 27,
        neverAttemptedRunning: 2,
      })
      expect(tick1Age).toBe(0)
      // The healthy run and the 26th stuck run were NOT reached by tick 1 (still un-stamped).
      expect(await lastAttemptAt(healthyCreated.runId)).toBeNull()
      expect(await runState(healthyCreated.runId)).toBe('running')

      const tick2 = await tick()
      // Tick 2's scan durably prioritizes `last_attempt_at IS NULL` rows FIRST (`NULLS FIRST`),
      // so both previously-unstamped rows are claimed this tick — `neverAttemptedRunning` drops
      // to 0 even though 2 of the 26 stuck rows from tick 1 are not re-scanned this tick (they
      // already carry a non-null `last_attempt_at` from tick 1, so they do not count here; this
      // is the read-AFTER-scan ordering `AttendanceScheduledRunSweepTickResultV1`'s doc comment
      // pins — computing this BEFORE the scan would read 2, not 0). The SAME 2 leftover rows are
      // now the `MIN(last_attempt_at)` (still at tick 1's stamp), so `oldestRunningAttemptAgeSeconds`
      // is positive here — real wall-clock elapsed time between tick 1's and tick 2's OWN
      // transactions, not a value this test can predict exactly (see the dedicated discriminating-
      // leg describe block below for the tight, deterministic monotonic-growth proof this field
      // exists for).
      const { oldestRunningAttemptAgeSeconds: tick2Age, ...tick2Rest } = tick2
      expect(tick2Rest).toEqual({
        scanned: 25,
        finalized: 1,
        notReady: 24,
        skipped: 0,
        errored: 0,
        backlogRemaining: 27,
        neverAttemptedRunning: 0,
      })
      expect(tick2Age).toBeGreaterThan(0)

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
      expect(result).toEqual({
        scanned: 1,
        finalized: 0,
        notReady: 1,
        skipped: 0,
        errored: 0,
        backlogRemaining: 1,
        // Steady state: the lone row is scanned (and stamped) THIS tick, so it no longer counts
        // as never-attempted by the time the post-scan read happens — 0, not 1.
        neverAttemptedRunning: 0,
        // Freshly stamped THIS tick — `now()` is transaction-stable, so this is exactly `0`.
        oldestRunningAttemptAgeSeconds: 0,
      })
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

    const EXPECTED_META_KEYS = [
      'scanned',
      'finalized',
      'notReady',
      'skipped',
      'errored',
      'backlogRemaining',
      'neverAttemptedRunning',
      'oldestRunningAttemptAgeSeconds',
    ].sort()

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

  // =============================================================================================
  // #4774 P1-1 regression guard — the scan became a row-lock WAITER when it was converted from a
  // pure `SELECT` to `UPDATE ... RETURNING`, and the scan's transaction sits OUTSIDE the
  // per-candidate try/catch in `sweepAttendanceScheduledRunsOnceV1`. Before the `FOR UPDATE SKIP
  // LOCKED` fix, a concurrent holder of a row lock on ONE selected `running` row blocked the
  // scan's `UPDATE` statement until `lock_timeout` (5000ms, `W4_TRANSACTION_LOCK_TIMEOUT_MS`)
  // aborted it with `55P03` — a SQLSTATE `isRetryableSqlState()` does NOT cover — which propagated
  // out of the tick and killed ALL candidates for that tick (0 processed), where the pre-#4770
  // plain-`SELECT` scan never waited on a row lock at all. This is a strict regression of section
  // 1.7's own containment invariant ("one stuck candidate cannot block the others in the same
  // scan") for the scan phase specifically.
  // =============================================================================================
  describe('tick-level containment under a concurrent row lock (regression guard, #4774 P1-1)', () => {
    it('one candidate row-locked by a concurrent connection does not kill the tick; it is excluded THIS tick and the other candidates are still processed', async () => {
      const workDate = '2026-03-07'
      const a = await createStuckRun('lockguard-a', workDate)
      const b = await createStuckRun('lockguard-b', workDate)
      const c = await createStuckRun('lockguard-c', workDate)

      // A separate connection holds an open, uncommitted row lock on candidate `b` — modeling
      // the sweep's OWN per-candidate `finalizeAttendanceScheduledRunV1`/
      // `abandonAttendanceScheduledRunV1` step-3 `SELECT ... FOR UPDATE` (both reachable,
      // default-multi-worker topology per the gate's Orientation section), or a second
      // concurrent scan worker. (Deliberately NOT "durably" — an open transaction's lock is the
      // opposite of durable; it vanishes on rollback/crash, unlike this fix's `last_attempt_at`
      // rotation stamp.)
      const lockConn = await pool.connect()
      await lockConn.query('BEGIN')
      await lockConn.query('SELECT * FROM attendance_scheduled_runs WHERE run_id = $1::uuid FOR UPDATE', [b.runId])

      try {
        const started = Date.now()
        const result = await withAllowlist([a.orgId, b.orgId, c.orgId], () =>
          sweepAttendanceScheduledRunsOnceV1(pool, { limit: 25, async recoverCandidate() {} }),
        )
        const elapsedMs = Date.now() - started

        // Must not have waited out the 5000ms `lock_timeout` — `FOR UPDATE SKIP LOCKED` excludes
        // the locked candidate from the scan instead of blocking on its row lock. (Pre-fix this
        // assertion is moot — the call above throws `55P03` before returning at all.)
        expect(elapsedMs).toBeLessThan(4000)

        // `b` (locked) is excluded from THIS tick's candidate set entirely; `a` and `c` are
        // unaffected and processed normally — values-free containment restored. `b` is also the
        // #4770-follow-up `neverAttemptedRunning` signal in miniature: it is `state='running'`
        // and was never stamped (excluded by SKIP LOCKED, not merely deferred to later in the
        // scan window), so it reads 1 — a single-tick preview of the multi-tick "stably >0"
        // starvation signature exercised in full below.
        expect(result).toEqual({
          scanned: 2,
          finalized: 0,
          notReady: 2,
          skipped: 0,
          errored: 0,
          backlogRemaining: 3,
          neverAttemptedRunning: 1,
          // `b`'s `last_attempt_at` is NULL (locked BEFORE ever being scanned) — `MIN()` ignores
          // NULL, so only `a`/`c`'s fresh THIS-tick stamps count, giving an exact `0`. `b` is
          // invisible to this field by construction (that is `neverAttemptedRunning`'s case, not
          // this field's — see the disjoint-coverage note on `AttendanceScheduledRunSweepTickResultV1`).
          oldestRunningAttemptAgeSeconds: 0,
        })
        expect(await lastAttemptAt(a.runId)).not.toBeNull()
        expect(await lastAttemptAt(c.runId)).not.toBeNull()
        // `b` was never reached by this tick — still un-stamped, still running, NOT counted as
        // `errored` (it is simply deferred to a later tick once the lock releases).
        expect(await lastAttemptAt(b.runId)).toBeNull()
        expect(await runState(b.runId)).toBe('running')
      } finally {
        await lockConn.query('ROLLBACK').catch(() => undefined)
        lockConn.release()
      }
    }, 30000)
  })

  // =============================================================================================
  // #4774 P2-2 regression guard — the PR's "Fairness design" claim ("two concurrent scans cannot
  // both durably 'own' the same candidate") was empirically FALSE at head `76ecd793e` (measured
  // overlap 6/6 — the inner `SELECT` took no lock, so both scans read the same `state='running'`
  // rows; the SERIALIZABLE write-conflict that followed was absorbed by the helper's own `40001`
  // retry, which then re-selected the same still-`running` rows). `FOR UPDATE SKIP LOCKED` (the
  // SAME fix as P1-1) makes the claim true: a row already locked by a concurrent scan is skipped,
  // not duplicated.
  //
  // Construction note: a naive `Promise.all([scanA(), scanB()])` against two SEPARATE fresh
  // connections is RACY on localhost — a whole SERIALIZABLE scan transaction (BEGIN + 2x
  // `set_config` + the scan + COMMIT) can complete in under a millisecond, so it is possible for
  // worker A to fully commit (releasing its row locks) before worker B's scan even attempts to
  // lock anything; B then legitimately re-scans the SAME (only) backlog, which is correct
  // ROTATION behavior, not a SKIP LOCKED failure, and would show up as a false "overlap" that has
  // nothing to do with exclusivity. (Measured directly: a `Promise.all` version of this test
  // still showed a rare 6/6 overlap AFTER the fix, purely from that race — not from SKIP LOCKED
  // not working.)
  //
  // A second construction pitfall (also measured directly): manually holding worker A's
  // transaction open with a BARE `BEGIN`/`COMMIT` (bypassing the production retry wrapper) makes
  // `COMMIT` fail with SQLSTATE `40001` ("could not serialize access due to read/write
  // dependencies... Canceled on identification as a pivot") — because BOTH scans' `SeqScan`
  // (a 6-row scratch table has no index to make the plan narrower) touches the WHOLE
  // `state='running'` predicate range even though `SKIP LOCKED` makes their WRITES disjoint, so
  // PostgreSQL's serializable-snapshot-isolation conflict detector sees a genuine two-transaction
  // rw-antidependency cycle and aborts the later committer. This is EXPECTED SERIALIZABLE
  // behavior, not a defect — and exactly why `runAttendanceResultOperationTransactionV1` retries
  // on `40001`/`40P01` in the first place. This test goes through that SAME production retry
  // wrapper for BOTH workers (not a bare `BEGIN`/`COMMIT`), with an explicit signal so worker A's
  // scan-claim is guaranteed to still be open when worker B's independent scan runs, modeling a
  // worker mid-flight between its scan and its per-candidate processing — the exact window P1-1's
  // mechanism (and a real second sweep replica) exploits. On A's `40001`, the wrapper transparently
  // retries the WHOLE callback (rollback + rescan), matching real production behavior.
  // =============================================================================================
  describe('multi-worker exclusivity (regression guard, #4774 P2-2)', () => {
    it('a concurrent worker holding an uncommitted scan-claim on part of the backlog does not let a second worker durably double-claim those same rows', async () => {
      const workDate = '2026-03-08'
      const seeded: Array<{ orgId: string; runId: string }> = []
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential seeding, same rationale as gate 1.
        seeded.push(await createStuckRun(`overlap-${i}`, workDate))
      }
      const orgIds = seeded.map((r) => r.orgId)

      // Signals: `scanADone` resolves once worker A's scan-claim transaction has taken its
      // locks (but is still open); `releaseASignal` is held until worker B has finished, so A's
      // COMMIT (or its post-`40001`-retry rescan+COMMIT) cannot happen before B's scan runs.
      let scanADoneResolve!: (v: readonly AttendanceScheduledRunSweepCandidateV1[]) => void
      const scanADone = new Promise<readonly AttendanceScheduledRunSweepCandidateV1[]>((resolve) => {
        scanADoneResolve = resolve
      })
      let releaseA!: () => void
      const releaseASignal = new Promise<void>((resolve) => {
        releaseA = resolve
      })

      const clientA = await pool.connect()
      const clientB = await pool.connect()
      const workerAPromise = withAllowlist(orgIds, () =>
        runAttendanceResultOperationTransactionV1(
          clientA as unknown as AttendanceW4TransactionClientV1,
          async (trx) => {
            const candidates = await scanAttendanceScheduledRunSweepCandidatesV1(trx, 3)
            scanADoneResolve(candidates)
            await releaseASignal
            return candidates
          },
        ),
      )

      try {
        const candidatesA = await scanADone
        expect(candidatesA).toHaveLength(3)

        // Worker B: a fully independent second scan while A's claim is STILL uncommitted.
        const candidatesB = await withAllowlist(orgIds, () =>
          runAttendanceResultOperationTransactionV1(clientB as unknown as AttendanceW4TransactionClientV1, (trx) =>
            scanAttendanceScheduledRunSweepCandidatesV1(trx, 25),
          ),
        )

        releaseA()
        const finalCandidatesA = await workerAPromise

        const idsA = new Set(finalCandidatesA.map((c) => c.runId))
        const idsB = new Set(candidatesB.map((c) => c.runId))
        const overlap = [...idsA].filter((id) => idsB.has(id))
        expect(overlap, 'FOR UPDATE SKIP LOCKED must make a concurrent scan skip rows another worker already holds').toEqual([])
        // B's scan (limit 25, only 3 unlocked rows available) claims exactly the OTHER 3.
        expect(idsB.size).toBe(3)
        expect(idsA.size).toBe(3)
        const union = new Set([...idsA, ...idsB])
        expect(union.size).toBe(6)
        for (const s of seeded) expect(union.has(s.runId)).toBe(true)
      } finally {
        // Always unstick A even on assertion failure, so afterEach's DROP DATABASE cannot hang
        // behind a leaked open transaction — and always AWAIT its settlement before releasing
        // the connection back to the pool.
        releaseA()
        await workerAPromise.catch(() => undefined)
        clientA.release()
        clientB.release()
      }
    }, 30000)
  })

  // =============================================================================================
  // #4770 follow-up (issue #4770; second-opinion NIT-refine, 2026-08-05) — `neverAttemptedRunning`
  // is meant to separate "permanently stuck" from "ordinary large-backlog churn", something
  // `backlogRemaining` alone cannot do once `backlogRemaining > limit` (`scanned < backlogRemaining`
  // holds every tick either way — see the second opinion's Probe C). These two tests are the SAME
  // 30-row/limit-25 backlog, differing in EXACTLY one variable — whether a connection holds an
  // open, never-released `FOR UPDATE` lock on one row — so the observed `neverAttemptedRunning`
  // sequences are the discriminating signal itself, not an artifact of different fixtures.
  // =============================================================================================
  describe('#4770 follow-up — neverAttemptedRunning discriminates permanent-lock starvation from ordinary churn', () => {
    it('a row held under a never-released lock floors neverAttemptedRunning at 1 across ticks; every other row still drains', async () => {
      const workDate = '2026-03-09'
      const ROWS = 30
      const rows: Array<{ orgId: string; runId: string }> = []
      for (let i = 0; i < ROWS; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential seeding: created_at must be
        // strictly increasing, same rationale as gate 1's and the overlap test's seeding loops.
        rows.push(await createStuckRun(`starve-${i}`, workDate))
      }
      const orgIds = rows.map((r) => r.orgId)

      // Row 0 (oldest — sorts first in the rotation) is held under an open, uncommitted `FOR
      // UPDATE` lock for the ENTIRE test — modeling a genuinely hung/leaked transaction, not a
      // timing artifact (same construction as the "tick-level containment" regression guard
      // above, held across THREE ticks here instead of one). `FOR UPDATE SKIP LOCKED` excludes
      // it from every tick's scan, so it is NEVER stamped — this is the second opinion's Probe C
      // scenario (120 rows/8 ticks, manual), pinned here as an automated multi-tick regression
      // at a smaller scale (30 rows/3 ticks, limit 25).
      const lockConn = await pool.connect()
      await lockConn.query('BEGIN')
      await lockConn.query('SELECT * FROM attendance_scheduled_runs WHERE run_id = $1::uuid FOR UPDATE', [
        rows[0].runId,
      ])

      try {
        const tick = () =>
          withAllowlist(orgIds, () =>
            sweepAttendanceScheduledRunsOnceV1(pool, { limit: 25, async recoverCandidate() {} }),
          )
        const observed: Array<Awaited<ReturnType<typeof tick>>> = []
        for (let t = 0; t < 3; t += 1) {
          // eslint-disable-next-line no-await-in-loop -- ticks are inherently sequential: each
          // reads the durable write-back the previous tick left behind.
          observed.push(await tick())
        }

        // 30 rows, limit 25, none ever finalize (targets never sealed — every candidate reports
        // `not_ready`, so `scanned`/`notReady`/`backlogRemaining` are flat across all 3 ticks).
        // Tick 1 scans the 25 oldest UNLOCKED rows (row 0 is skip-locked, invisible to the
        // selection entirely), leaving 4 unlocked rows + the locked row un-stamped (5). Tick 2's
        // `last_attempt_at ASC NULLS FIRST` ordering claims those 4 remaining unlocked rows
        // FIRST, so only the permanently-locked row is left (1) — and it STAYS at 1 on tick 3,
        // because it is never claimable. This is the stuck-vs-churn signature: FLOORS nonzero
        // instead of draining to 0 (contrast the positive-control test immediately below, whose
        // sequence is [5, 0, 0] off the identical fixture minus the held lock).
        const restObserved = observed.map(({ oldestRunningAttemptAgeSeconds, ...rest }) => rest)
        expect(restObserved).toEqual([
          { scanned: 25, finalized: 0, notReady: 25, skipped: 0, errored: 0, backlogRemaining: 30, neverAttemptedRunning: 5 },
          { scanned: 25, finalized: 0, notReady: 25, skipped: 0, errored: 0, backlogRemaining: 30, neverAttemptedRunning: 1 },
          { scanned: 25, finalized: 0, notReady: 25, skipped: 0, errored: 0, backlogRemaining: 30, neverAttemptedRunning: 1 },
        ])

        // `oldestRunningAttemptAgeSeconds` is NOT this test's discriminator: row 0's
        // `last_attempt_at` is NULL forever (locked BEFORE its first scan) — `MIN()` ignores
        // NULL, so this field structurally cannot see row 0 (that is `neverAttemptedRunning`'s
        // exclusive coverage, already proven above). At this 30-row/limit-25 SCALE, the 29 other
        // (unlocked, genuinely churning) rows themselves leave a handful of rows one tick
        // "behind" every tick (rotation can only touch `limit` rows per tick — same dynamic the
        // positive-control test below also shows), so no exact or monotonic claim holds for
        // ticks 2-3 here. Tick 1 is the one exception: every stamped row shares that tick's OWN
        // transaction-stable `now()`, so it is deterministically `0`. The tight, deterministic
        // monotonic-growth proof this field exists for uses a STEADY-STATE (backlog <= limit)
        // fixture instead, where every unlocked row genuinely IS re-touched every tick — see the
        // "owner-review P2" describe block below.
        expect(observed[0].oldestRunningAttemptAgeSeconds).toBe(0)
        for (const o of observed) {
          expect(o.oldestRunningAttemptAgeSeconds).toBeGreaterThanOrEqual(0)
        }

        expect(await lastAttemptAt(rows[0].runId)).toBeNull()
        expect(await runState(rows[0].runId)).toBe('running')
      } finally {
        await lockConn.query('ROLLBACK').catch(() => undefined)
        lockConn.release()
      }
    }, 90000)

    it('positive control — the SAME 30-row backlog with NO held lock drains neverAttemptedRunning to 0 and stays there', async () => {
      const workDate = '2026-03-10'
      const ROWS = 30
      const rows: Array<{ orgId: string; runId: string }> = []
      for (let i = 0; i < ROWS; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential seeding, same rationale as the
        // sibling (locked) test above.
        rows.push(await createStuckRun(`churn-${i}`, workDate))
      }
      const orgIds = rows.map((r) => r.orgId)

      // No lock held anywhere — every row is genuinely claimable. `createStuckRun`'s targets are
      // deliberately never sealed (see its own doc comment), so every row reports `not_ready` on
      // every scan forever and STAYS `state='running'` — a real positive control (an ongoing,
      // never-terminal backlog under legitimate rotation churn), not "an empty queue reads 0".
      const tick = () =>
        withAllowlist(orgIds, () =>
          sweepAttendanceScheduledRunsOnceV1(pool, { limit: 25, async recoverCandidate() {} }),
        )
      const observed: Array<Awaited<ReturnType<typeof tick>>> = []
      for (let t = 0; t < 3; t += 1) {
        // eslint-disable-next-line no-await-in-loop -- ticks are inherently sequential.
        observed.push(await tick())
      }

      // Identical 30/25 split to the locked sibling test's tick 1 (5 un-stamped after tick 1),
      // but with nothing permanently un-claimable, tick 2 claims the remaining 5 rows and it
      // stays 0 on tick 3 — the discriminating counter-signature to the sibling test's
      // [5, 1, 1] above.
      const restObserved = observed.map(({ oldestRunningAttemptAgeSeconds, ...rest }) => rest)
      expect(restObserved).toEqual([
        { scanned: 25, finalized: 0, notReady: 25, skipped: 0, errored: 0, backlogRemaining: 30, neverAttemptedRunning: 5 },
        { scanned: 25, finalized: 0, notReady: 25, skipped: 0, errored: 0, backlogRemaining: 30, neverAttemptedRunning: 0 },
        { scanned: 25, finalized: 0, notReady: 25, skipped: 0, errored: 0, backlogRemaining: 30, neverAttemptedRunning: 0 },
      ])

      // Same caveat as the locked sibling test above: at this congested (backlog > limit) scale,
      // even this fully-healthy churn leaves a handful of rows one tick "behind" every tick
      // (rotation can only touch `limit` rows per tick), so `oldestRunningAttemptAgeSeconds` is
      // NOT pinned to `0` on ticks 2-3 here despite there being no lock anywhere — only tick 1
      // (every row fresh-stamped in its OWN transaction) is exactly `0`. The clean "stays at `0`,
      // every tick" signature this field gives for genuinely healthy churn needs a STEADY-STATE
      // (backlog <= limit) fixture, where literally every row is re-touched every tick — see the
      // "owner-review P2" describe block below.
      expect(observed[0].oldestRunningAttemptAgeSeconds).toBe(0)
      for (const o of observed) {
        expect(o.oldestRunningAttemptAgeSeconds).toBeGreaterThanOrEqual(0)
      }
    }, 90000)
  })

  // =============================================================================================
  // Owner-review P2 on #4779 (2026-08-05) — `neverAttemptedRunning`'s OWN blind spot: it counts
  // `last_attempt_at IS NULL`, so a row locked BEFORE its first-ever scan is caught (the describe
  // block above), but a row that WAS scanned/stamped once and is THEN locked forever is NOT — its
  // `last_attempt_at` is non-NULL, so it never re-enters the never-attempted bucket, and `FOR
  // UPDATE SKIP LOCKED` means it is never re-selected either. `neverAttemptedRunning` reads `0`
  // for it on every subsequent tick, silently.
  //
  // Fixture is deliberately STEADY STATE (backlog <= limit, 4 rows vs. limit 25) rather than the
  // 30-row congested scale above — that is what makes the positive control's signature exactly
  // `[0, 0, 0]` (every row, including the one under test before it is locked, is genuinely
  // re-touched every tick) rather than merely bounded, and makes the locked leg's damning form
  // sharpest: from tick 2 to tick 3, NOT ONE of the seven pre-existing counters moves at all
  // (`scanned`/`notReady`/`backlogRemaining`/`neverAttemptedRunning` are byte-identical) — a
  // dashboard watching only those seven would see a perfectly ordinary, unchanging 3-row backlog,
  // tick after tick, forever. Only `oldestRunningAttemptAgeSeconds` reveals the row that's been
  // frozen since tick 1.
  // =============================================================================================
  describe('owner-review P2 on #4779 — oldestRunningAttemptAgeSeconds discriminates a row scanned once then permanently locked', () => {
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

    it('a row locked AFTER its first successful scan freezes there — neverAttemptedRunning reads 0 (the blind spot) while oldestRunningAttemptAgeSeconds climbs, tick after tick, with the other seven counters unchanged', async () => {
      const workDate = '2026-03-11'
      const ROWS = 4
      const rows: Array<{ orgId: string; runId: string }> = []
      for (let i = 0; i < ROWS; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential seeding, same rationale as the
        // sibling 30-row tests above.
        rows.push(await createStuckRun(`p2starve-${i}`, workDate))
      }
      const orgIds = rows.map((r) => r.orgId)
      const tick = () =>
        withAllowlist(orgIds, () => sweepAttendanceScheduledRunsOnceV1(pool, { limit: 25, async recoverCandidate() {} }))

      // Tick 1: steady state (4 rows <= limit 25) — every row is scanned and stamped THIS tick,
      // including the row about to be locked. `oldestRunningAttemptAgeSeconds` is exactly `0`
      // (transaction-stable `now()`, same as the steady-state and gate-1-tick-1 tests above).
      const tick1 = await tick()
      expect(tick1).toEqual({
        scanned: 4,
        finalized: 0,
        notReady: 4,
        skipped: 0,
        errored: 0,
        backlogRemaining: 4,
        neverAttemptedRunning: 0,
        oldestRunningAttemptAgeSeconds: 0,
      })
      const frozenStamp = await lastAttemptAt(rows[0].runId)
      expect(frozenStamp).not.toBeNull()

      // NOW — only AFTER rows[0] already carries a non-NULL `last_attempt_at` from tick 1 — a
      // separate connection takes an open, never-released `FOR UPDATE` lock on it. This is the
      // exact ordering the sibling `neverAttemptedRunning`-discriminating leg above does NOT
      // cover (there, the lock is acquired BEFORE tick 1 ever runs).
      const lockConn = await pool.connect()
      await lockConn.query('BEGIN')
      await lockConn.query('SELECT * FROM attendance_scheduled_runs WHERE run_id = $1::uuid FOR UPDATE', [
        rows[0].runId,
      ])

      try {
        await sleep(300)
        const tick2 = await tick()
        const { oldestRunningAttemptAgeSeconds: age2, ...rest2 } = tick2
        // `rows[0]` is excluded by SKIP LOCKED; the other 3 are re-scanned/re-stamped normally.
        expect(rest2).toEqual({
          scanned: 3,
          finalized: 0,
          notReady: 3,
          skipped: 0,
          errored: 0,
          backlogRemaining: 4,
          // THE BLIND SPOT, reproduced: `rows[0]` has been permanently unclaimable since tick 1,
          // yet this reads `0` — its `last_attempt_at` is non-NULL (stamped once, at tick 1), so
          // it never counts as "never attempted".
          neverAttemptedRunning: 0,
        })
        // THE FIX, observable: `rows[0]`'s frozen tick-1 stamp is now the STALEST — age is
        // strictly positive (real wall-clock time elapsed since tick 1), where the blind-spot
        // counter above read a flat `0`.
        expect(age2).toBeGreaterThanOrEqual(0.2)

        await sleep(300)
        const tick3 = await tick()
        const { oldestRunningAttemptAgeSeconds: age3, ...rest3 } = tick3
        // Identical to tick 2's seven-counter shape — NOT ONE of them moved. A dashboard reading
        // only the pre-#4779-P2 fields would see nothing wrong, tick after tick, forever.
        expect(rest3).toEqual(rest2)
        // Monotonic growth: strictly larger than tick 2's reading, because `rows[0]`'s stamp is
        // STILL frozen at tick 1 while real time keeps advancing.
        expect(age3).toBeGreaterThan(age2)

        // Mechanism pin: rows[0]'s `last_attempt_at` genuinely never moved across either tick —
        // this is not a coincidence of the aggregate reading.
        expect(await lastAttemptAt(rows[0].runId)).toEqual(frozenStamp)
        expect(await runState(rows[0].runId)).toBe('running')
      } finally {
        await lockConn.query('ROLLBACK').catch(() => undefined)
        lockConn.release()
      }
    }, 30000)

    it('positive control — the SAME 4-row steady-state backlog with NO held lock reads oldestRunningAttemptAgeSeconds as exactly 0 on every tick (never grows)', async () => {
      const workDate = '2026-03-12'
      const ROWS = 4
      const rows: Array<{ orgId: string; runId: string }> = []
      for (let i = 0; i < ROWS; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential seeding, same rationale as the
        // sibling (locked) test above.
        rows.push(await createStuckRun(`p2churn-${i}`, workDate))
      }
      const orgIds = rows.map((r) => r.orgId)
      const tick = () =>
        withAllowlist(orgIds, () => sweepAttendanceScheduledRunsOnceV1(pool, { limit: 25, async recoverCandidate() {} }))

      // Nothing locked anywhere — every row is genuinely re-claimable every tick (steady state,
      // 4 <= limit 25), so EVERY tick restamps EVERY row: `oldestRunningAttemptAgeSeconds` is
      // exactly `0`, every single time — the discriminating counter-signature to the locked
      // sibling test's strictly-growing `age2 < age3` above ("normal progress ⇒ never grows").
      const tick1 = await tick()
      expect(tick1).toEqual({
        scanned: 4,
        finalized: 0,
        notReady: 4,
        skipped: 0,
        errored: 0,
        backlogRemaining: 4,
        neverAttemptedRunning: 0,
        oldestRunningAttemptAgeSeconds: 0,
      })

      await sleep(300)
      const tick2 = await tick()
      expect(tick2).toEqual(tick1)

      await sleep(300)
      const tick3 = await tick()
      expect(tick3).toEqual(tick1)
    }, 30000)
  })
})
