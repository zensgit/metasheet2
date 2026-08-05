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

      // A separate connection durably holds a row lock on candidate `b` — modeling the sweep's
      // OWN per-candidate `finalizeAttendanceScheduledRunV1`/`abandonAttendanceScheduledRunV1`
      // step-3 `SELECT ... FOR UPDATE` (both reachable, default-multi-worker topology per the
      // gate's Orientation section), or a second concurrent scan worker.
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
        // unaffected and processed normally — values-free containment restored.
        expect(result).toEqual({ scanned: 2, finalized: 0, notReady: 2, skipped: 0, errored: 0, backlogRemaining: 3 })
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
})
