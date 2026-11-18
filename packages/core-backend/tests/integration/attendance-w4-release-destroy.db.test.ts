/**
 * Attendance settlement coordination P1-1 「连接销毁语义」 on a real PostgreSQL and a real `pg.Pool`
 * (acceptance A05 provider coverage, A06 OPS:370).
 *
 * Every releaser of a W4 runner connection, driven through its real boundary with a provider shaped
 * like the composition-root closures (`tests/helpers/attendance-w4-release-probe.ts`):
 *  - the five W4 providers' boundaries (BND execute, PROC, RES, SYNC, RB), LSB `withConnection`
 *    (through `probeOnlinePunchReplay`), REC `execute` and the OPS sweep scan each get two legs:
 *    (a) an ordinary body failure with a successful ROLLBACK returns the connection: the caller gets
 *        the body's own error object, unmarked; exactly one release, without an error; no remove;
 *        the next checkout gets the same backend;
 *    (b) the same body failure with a failed ROLLBACK destroys it: the caller gets the same body
 *        error object, now marked; exactly one release, carrying that error; one remove; the backend
 *        is gone and the next checkout gets another one;
 *  - the per-candidate sweep borrow (which counts and swallows errors) gets the same two legs,
 *    asserted on the tick result and on the release the swallowed error reached;
 *  - OPS `abandonScheduledRunOnceV1` (OPS:370) gets success, a business error with a successful
 *    ROLLBACK, a business error with a failed ROLLBACK, a COMMIT failing with 57014, and the control
 *    that a COMMIT failing with 40001 is still retried on the same connection.
 *
 * Faults are injected client-side by the probe (the faulted statement is never sent), except the A04
 * (d1) legs' lost ROLLBACK result, which runs on the server and fails only on the client. Each body
 * failure is the first statement of the boundary's runner body, which no boundary maps or wraps
 * before the runner sees it (SYNC's body-level `catch` that rewrites a string `code` sits around a
 * later block, not around its first statement).
 *
 * Fixture: an own scratch database (pattern of `attendance-w4c2-p12-run-transactions.db.test.ts`),
 * because the sweep scan is global over `state = 'running'` and PROC reads a real import-job row
 * before its runner. Fixture identities are namespaced `p11a05<run>`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { AttendanceManagedPgPool, attendanceOwningSessionForClientV1, withAttendanceExclusiveIdleSessionV1 } from '../../src/attendance/attendance-owning-session'

import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import { up as w4c2Up } from '../../src/db/migrations/zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union'
import { up as w4c3aLegacyPlanUp } from '../../src/db/migrations/zzzz20260730120000_w4c3a_durable_legacy_execution_plan'
import { up as w4c2SweepFairnessUp } from '../../src/db/migrations/zzzz20260805120000_w4c2_scheduled_run_sweep_fairness'
import { createAuthorizedAttendanceWriteContextV1 } from '../../src/attendance/w4c0-authorization'
import { assertConnectionIsIdleV1, type AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'
import { AttendanceW4OperationError } from '../../src/attendance/w4c0-operation-contract'
import {
  attendanceW4ConnectionDiscardV1,
  isAttendanceW4ConnectionUncertainV1,
  runAttendanceResultOperationTransactionV1,
} from '../../src/attendance/w4c0-operation-registry'
import {
  __setW4C3aRolloutControlAfterExclusiveLockForTests,
  AttendanceW4C3aRolloutControlError,
  closeLegacyRollbackWindowV1,
} from '../../src/attendance/w4c3a-rollout-control'
import { abandonAttendanceScheduledRunV1, createOrResumeAttendanceScheduledRunV1 } from '../../src/attendance/w4c2-scheduled-run'
import { abandonScheduledRunOnceV1, sweepAttendanceScheduledRunsOnceV1 } from '../../src/attendance/w4c2-scheduled-run-ops-worker'
import { createAttendanceLiveScheduledBoundaryV1 } from '../../src/attendance/w4c2-live-scheduled-boundary'
import {
  ATTENDANCE_REQUEST_OPERATION_KINDS_V1,
  createAttendanceRequestOperationBoundaryV1,
  type AttendanceRequestOperationAdapterV1,
} from '../../src/attendance/w4c3b-request-operation-boundary'
import {
  ATTENDANCE_RECORD_OPERATION_KINDS_V1,
  createAttendanceRecordOperationBoundaryV1,
  type AttendanceRecordOperationAdapterV1,
} from '../../src/attendance/w4c3c-record-operation-boundary'
import { createAttendanceLegacyPlanCommitConnectionV1 } from '../../src/attendance/w4c3a-legacy-plan-commit-connection'
import { createAttendanceLegacyPlanProcessorV1 } from '../../src/attendance/w4c3a-legacy-plan-processor'
import {
  createAttendanceLegacyPlanReservationHostV1,
  type ReserveAttendanceLegacyImportPlanFromHostInputV1,
} from '../../src/attendance/w4c3a-legacy-plan-reservation-host'
import {
  createAttendanceSyncImportHostV1,
  type CommitAttendanceSyncImportPlanFromHostInputV1,
} from '../../src/attendance/w4c3a-sync-import-host'
import { createAttendanceImportRollbackBoundaryV1 } from '../../src/attendance/w4c3a-import-rollback-boundary'
import {
  createAttendanceW4ReleaseProbe,
  type AttendanceW4ReleaseProbe,
  type AttendanceW4ReleaseProbeBorrow,
} from '../helpers/attendance-w4-release-probe'
import { waitForBackendGone } from '../helpers/settlement-coordination-db'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have a database URL (a DB-expected run must never skip-green)', () => {
  expect(dbUrl).toBeTruthy()
})

const RUN = crypto.randomUUID().slice(0, 8)
const NS = 'p11a05' + RUN
const ADMIN_ACTOR = `${NS}-admin`
const ABANDON_REASON = 'ATTENDANCE_SCHEDULED_RUN_OPERATOR_ABANDONED' as const
/** Active user + membership the SYNC and LSB commit legs need for the in-transaction liveness recheck. */
const SYNC_ACTOR = `${NS}-sync-actor`
const SYNC_KEY = `${NS}-sync-key`
const LSB_USER = crypto.randomUUID()

/** Deterministic per-leg org id in canonical UUID syntax, namespaced to this file and run. */
function orgIdFor(label: string): string {
  return crypto.createHash('sha1').update(NS + ':org:' + label).digest('hex').slice(0, 32).replace(
    /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
    '$1-$2-$3-$4-$5',
  )
}

/** Distinctive: a stub reached means the probe did not fire where it should have. */
function unreachable(where: string): Error {
  return Object.assign(new Error(`UNREACHABLE: ${where}`), { code: 'P11_A05_UNREACHABLE' })
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('P11_A05_EXPECTED_REJECTION')
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

const ORDINARY_TAIL = ['BEGIN:ok', 'set_config(statement_timeout):ok', 'set_config(lock_timeout):ok', 'body:faulted', 'ROLLBACK:ok']
const DESTROY_TAIL = ['BEGIN:ok', 'set_config(statement_timeout):ok', 'set_config(lock_timeout):ok', 'body:faulted', 'ROLLBACK:faulted']
/** A non-40001 / 40P01 COMMIT failure: marked, one cleanup ROLLBACK, no further attempt. */
const COMMIT_FAILED_CONTROL = ['BEGIN:ok', 'COMMIT:faulted', 'ROLLBACK:ok']

describeIfDatabase('attendance W4 connection release — destroy on the uncertainty mark (real database)', () => {
  const scratchName = `ms2_p11a05_${RUN}`
  let scratchUrl: string
  let adminPool: Pool
  let observer: Pool
  let kyselyPool: Pool
  let scratchDb: Kysely<unknown>
  let importJobId: string

  beforeAll(async () => {
    const adminUrl = new URL(dbUrl as string)
    adminUrl.pathname = '/postgres'
    adminPool = new Pool({ connectionString: adminUrl.toString() })
    await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
    await adminPool.query(`CREATE DATABASE ${scratchName}`)
    const url = new URL(dbUrl as string)
    url.pathname = `/${scratchName}`
    scratchUrl = url.toString()
    observer = new AttendanceManagedPgPool({ connectionString: scratchUrl, max: 3 })
    // House rule: a real-DB suite proves it is on its own disposable database before it writes anything.
    const onDatabase = await observer.query('SELECT current_database() AS db')
    expect((onDatabase.rows[0] as { db: string }).db).toBe(scratchName)
    if ((onDatabase.rows[0] as { db: string }).db !== scratchName) throw new Error('P11_A05_NOT_ON_SCRATCH_DATABASE')
    kyselyPool = new Pool({ connectionString: scratchUrl })
    scratchDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: kyselyPool }) })

    // Pre-migration tables: p12 run-transactions' set, with the import-job and group tables the
    // durable legacy-plan migration's own suite provisions (`createBase` there) so that migration applies.
    await observer.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    await observer.query(`
      CREATE TABLE attendance_records (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL, work_date date NOT NULL, first_in_at timestamptz, last_out_at timestamptz,
        work_minutes integer NOT NULL DEFAULT 0, late_minutes integer NOT NULL DEFAULT 0,
        early_leave_minutes integer NOT NULL DEFAULT 0, status varchar(64) NOT NULL DEFAULT 'normal',
        org_id text NOT NULL DEFAULT 'default')`)
    await observer.query(`
      CREATE TABLE attendance_requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id text NOT NULL, work_date date NOT NULL, request_type varchar(30) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'pending', org_id text NOT NULL DEFAULT 'default')`)
    await observer.query(`
      CREATE TABLE attendance_import_jobs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL DEFAULT 'default',
        batch_id uuid NOT NULL, created_by text NOT NULL, idempotency_key text,
        status varchar(20) NOT NULL DEFAULT 'queued', progress integer NOT NULL DEFAULT 0,
        total integer NOT NULL DEFAULT 0, error text, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        started_at timestamptz, finished_at timestamptz)`)
    await observer.query(`
      CREATE TABLE attendance_groups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, name text NOT NULL DEFAULT 'group')`)
    await observer.query(`
      CREATE TABLE attendance_group_members (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, group_id uuid NOT NULL,
        user_id text NOT NULL)`)
    // Chronological order; the legacy-plan migration adds the job columns PROC's authorization read selects.
    await w4c0Up(scratchDb)
    await w4c2Up(scratchDb)
    await w4c3aLegacyPlanUp(scratchDb)
    await w4c2SweepFairnessUp(scratchDb)

    // Minimal directory + legacy-batch tables for the COMMIT legs (created after the migrations, so no
    // migration installs anything on them): the liveness recheck reads users / user_orgs, SYNC's
    // idempotent replay reads attendance_import_batches, and BND / REC stub adapters write p11a05_effects.
    await observer.query(`CREATE TABLE users (id text PRIMARY KEY, is_active boolean NOT NULL, activation_status text)`)
    await observer.query(`CREATE TABLE user_orgs (user_id text NOT NULL, org_id text NOT NULL, is_active boolean NOT NULL)`)
    await observer.query(`
      CREATE TABLE attendance_import_batches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL, idempotency_key text,
        status text NOT NULL, row_count integer NOT NULL DEFAULT 0, meta jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now())`)
    await observer.query(`CREATE TABLE p11a05_effects (tag text NOT NULL)`)
    await observer.query(`INSERT INTO users (id, is_active, activation_status) VALUES ($1, true, 'activated'), ($2, true, 'activated')`, [SYNC_ACTOR, LSB_USER])
    await observer.query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true), ($3, $4, true)`, [
      SYNC_ACTOR, orgIdFor('sync-commit'), LSB_USER, orgIdFor('lsb-commit'),
    ])
    await observer.query(
      `INSERT INTO attendance_import_batches (org_id, idempotency_key, status, row_count, meta)
       VALUES ($1, $2, 'committed', 0, '{"engine":"standard"}'::jsonb)`,
      [orgIdFor('sync-commit'), SYNC_KEY],
    )

    // PROC reads this row (autocommit, on the borrowed connection) before its runner starts.
    const job = await observer.query(
      `INSERT INTO attendance_import_jobs (org_id, batch_id, created_by, idempotency_key, status, progress, total, payload)
       VALUES ($1, $2::uuid, $3, NULL, 'running', 0, 1, '{"legacy":true}'::jsonb)
       RETURNING id::text AS id`,
      [orgIdFor('proc'), crypto.randomUUID(), `${NS}-actor`],
    )
    importJobId = (job.rows[0] as { id: string }).id
  }, 120_000)

  afterAll(async () => {
    for (const p of [observer, kyselyPool, adminPool]) p?.on('error', () => undefined)
    await scratchDb?.destroy()
    await observer?.end()
    await adminPool?.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).catch(() => undefined)
    await adminPool?.end()
  }, 60_000)

  async function withProbe<T>(run: (probe: AttendanceW4ReleaseProbe) => Promise<T>): Promise<T> {
    const probe = createAttendanceW4ReleaseProbe(scratchUrl)
    try {
      return await run(probe)
    } finally {
      // A leg that failed before its own release would leave a checkout that blocks pool.end().
      for (const borrow of probe.borrows) {
        if (borrow.releaseCalls.length === 0) borrow.client.release(new Error('p11a05: checkout left unreleased by a failed leg'))
      }
      await probe.end()
    }
  }

  async function observerTxn<T>(fn: (trx: AttendanceW4TransactionClientV1) => Promise<T>): Promise<T> {
    const client: PoolClient = await observer.connect()
    try {
      return await runAttendanceResultOperationTransactionV1(attendanceOwningSessionForClientV1(client), fn)
    } finally {
      client.release()
    }
  }

  async function withAllowlist<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
    const prior = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = [prior, orgId].filter(Boolean).join(',')
    try {
      return await fn()
    } finally {
      if (prior === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = prior
    }
  }

  /** Seeds `legacy` then takes the legal legacy -> shadow edge (p12's `setRolloutState`, one hop). */
  async function seedShadow(orgId: string): Promise<void> {
    await observer.query(
      `INSERT INTO attendance_calculation_rollout_state (org_id, state, engine_version, reason_code, actor_id, version, prior_state)
       VALUES ($1,'legacy','v1','p11a05-seed','p11a05-actor',1,NULL)`,
      [orgId],
    )
    await observer.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = 'shadow', prior_state = 'legacy', version = 2, changed_at = now()
        WHERE org_id = $1`,
      [orgId],
    )
  }

  /** One running scheduled run with one generate target, in its own org (p12's abandon fixture). */
  async function runningRun(label: string): Promise<{ orgId: string; runId: string }> {
    const orgId = orgIdFor(label)
    await seedShadow(orgId)
    const created = await withAllowlist(orgId, () =>
      observerTxn((trx) =>
        createOrResumeAttendanceScheduledRunV1(
          trx,
          { orgId, initiator: 'cron', workDate: '2026-03-02' },
          async () => [{ userId: crypto.randomUUID(), targetKind: 'generate', reviewReasonCode: null }],
        ),
      ),
    )
    if (created.kind !== 'created_running') throw new Error(`P11_A05_FIXTURE: expected created_running, got ${created.kind}`)
    return { orgId, runId: created.runId }
  }

  async function runState(runId: string): Promise<string> {
    const { rows } = await observer.query('SELECT state FROM attendance_scheduled_runs WHERE run_id = $1::uuid', [runId])
    return (rows[0] as { state: string }).state
  }

  async function runningCount(): Promise<number> {
    const { rows } = await observer.query(`SELECT count(*)::int AS n FROM attendance_scheduled_runs WHERE state = 'running'`)
    return (rows[0] as { n: number }).n
  }

  /** Leaves no running run behind for the next leg (the sweep scan is global). Runs in `finally`. */
  async function cleanupRun(orgId: string, runId: string): Promise<void> {
    if ((await runState(runId)) === 'running') await abandonViaObserver(orgId, runId)
  }

  async function abandonViaObserver(orgId: string, runId: string): Promise<void> {
    const caller = createAuthorizedAttendanceWriteContextV1({
      actorId: ADMIN_ACTOR,
      actorPosture: 'platform_admin',
      tokenSubjectUserId: ADMIN_ACTOR,
      orgId,
      subjectScope: { kind: 'explicit_users', userIds: [ADMIN_ACTOR] },
      capability: 'retirement',
      sourceRef: 'ref:p11a05-cleanup',
    })
    const outcome = await observerTxn((trx) => abandonAttendanceScheduledRunV1(trx, caller, { orgId, runId }, ABANDON_REASON))
    expect(outcome).toEqual({ kind: 'abandoned', runId, completedUserCount: 0 })
  }

  /** The connection went back to the pool: one release without an error, no remove, same backend next. */
  async function expectReturned(probe: AttendanceW4ReleaseProbe, borrow: AttendanceW4ReleaseProbeBorrow): Promise<void> {
    expect(borrow.unfired).toEqual([])
    expect(borrow.releaseCalls).toStrictEqual([undefined])
    expect(borrow.releaseEvents).toStrictEqual([undefined])
    await settle()
    expect(borrow.removed).toBe(false)
    expect(await probe.nextPid()).toBe(borrow.pid)
  }

  /** The connection was destroyed with `error`: one release carrying it, one remove, backend gone, another backend next. */
  async function expectDestroyed(probe: AttendanceW4ReleaseProbe, borrow: AttendanceW4ReleaseProbeBorrow, error: unknown): Promise<void> {
    expect(borrow.unfired).toEqual([])
    expect(borrow.releaseCalls).toHaveLength(1)
    expect(borrow.releaseCalls[0]).toBe(error)
    expect(borrow.releaseEvents).toHaveLength(1)
    expect(borrow.releaseEvents[0]).toBe(error)
    expect(await probe.waitForRemoval(borrow)).toBe(true)
    expect(await waitForBackendGone(observer, borrow.pid)).toBe(true)
    expect(await probe.nextPid()).not.toBe(borrow.pid)
  }

  // -------------------------------------------------------------------------------------------
  // A05 — every runner-connection releaser, through its real boundary.
  // -------------------------------------------------------------------------------------------

  interface BoundaryCase {
    readonly name: string
    /** Statements the boundary sends on the borrowed connection before the runner's idle probe. */
    readonly pre: readonly string[]
    /** Builds the boundary on the probe and calls it once with the cheapest input that reaches the runner body. */
    readonly call: (probe: AttendanceW4ReleaseProbe) => Promise<unknown>
    /**
     * Leg (c): the shortest real path on which the body completes and the runner reaches COMMIT, or
     * the reason there is none within this suite's fixture budget. `effectTag` names the row the
     * body writes into `p11a05_effects` (stub adapters only), which must not be visible afterwards.
     */
    readonly commit: CommitLeg | { readonly todo: string } | null
  }

  interface CommitLeg {
    readonly call: (probe: AttendanceW4ReleaseProbe) => Promise<unknown>
    readonly effectTag?: string
  }

  type RequestPrepared = Awaited<ReturnType<AttendanceRequestOperationAdapterV1['prepare']>>
  type RequestExecuted = Awaited<ReturnType<AttendanceRequestOperationAdapterV1['execute']>>
  type RecordPrepared = Awaited<ReturnType<AttendanceRecordOperationAdapterV1['prepare']>>
  type RecordExecuted = Awaited<ReturnType<AttendanceRecordOperationAdapterV1['execute']>>

  /** Stub adapters whose body completes: prepare returns a minimal prepared identity, execute writes one effect row. */
  function completingRequestAdapters(orgId: string, tag: string) {
    const actorId = `${NS}-request-actor`
    const prepared = {
      orgId,
      actorId,
      actorPosture: 'self',
      tokenSubjectUserId: actorId,
      subjectUserId: actorId,
      subjectScope: { kind: 'self', userId: actorId },
      commandPayload: { requestType: 'leave' },
      state: {},
    } as unknown as RequestPrepared
    const adapter: AttendanceRequestOperationAdapterV1 = {
      async prepareIdentity(trx) {
        await trx.query('SELECT 1 AS p11a05_request_identity')
        return prepared
      },
      async prepare(trx) {
        await trx.query('SELECT 1 AS p11a05_request_prepare')
        return prepared
      },
      async execute(trx) {
        await trx.query('INSERT INTO p11a05_effects (tag) VALUES ($1)', [tag])
        return { response: { ok: true }, resolvedRequestId: null, lifecycleEvents: [] } as unknown as RequestExecuted
      },
    }
    return Object.fromEntries(ATTENDANCE_REQUEST_OPERATION_KINDS_V1.map((kind) => [kind, adapter])) as Record<
      (typeof ATTENDANCE_REQUEST_OPERATION_KINDS_V1)[number],
      AttendanceRequestOperationAdapterV1
    >
  }

  function completingRecordAdapters(orgId: string, tag: string) {
    const actorId = `${NS}-record-actor`
    const prepared = {
      orgId,
      actorId,
      actorPosture: 'self',
      tokenSubjectUserId: actorId,
      subjectUserId: actorId,
      targetWorkDate: '2026-03-02',
      subjectScope: { kind: 'self', userId: actorId },
      commandPayload: { kind: 'manual_edit' },
      state: {},
    } as unknown as RecordPrepared
    const adapter: AttendanceRecordOperationAdapterV1 = {
      async prepareIdentity(trx) {
        await trx.query('SELECT 1 AS p11a05_record_identity')
        return prepared
      },
      async prepare(trx) {
        await trx.query('SELECT 1 AS p11a05_record_prepare')
        return prepared
      },
      async execute(trx) {
        await trx.query('INSERT INTO p11a05_effects (tag) VALUES ($1)', [tag])
        return { response: { ok: true }, resolvedRecordId: null, resolvedCalculationId: null, lifecycleEvents: [] } as unknown as RecordExecuted
      },
    }
    return Object.fromEntries(ATTENDANCE_RECORD_OPERATION_KINDS_V1.map((kind) => [kind, adapter])) as Record<
      (typeof ATTENDANCE_RECORD_OPERATION_KINDS_V1)[number],
      AttendanceRecordOperationAdapterV1
    >
  }

  async function effectCount(tag: string): Promise<number> {
    const { rows } = await observer.query('SELECT count(*)::int AS n FROM p11a05_effects WHERE tag = $1', [tag])
    return (rows[0] as { n: number }).n
  }

  function requestAdapters(): Record<(typeof ATTENDANCE_REQUEST_OPERATION_KINDS_V1)[number], AttendanceRequestOperationAdapterV1> {
    const adapter: AttendanceRequestOperationAdapterV1 = {
      async prepareIdentity(trx) {
        await trx.query('SELECT 1 AS p11a05_request_body')
        throw unreachable('request prepareIdentity')
      },
      async prepare(trx) {
        await trx.query('SELECT 1 AS p11a05_request_body')
        throw unreachable('request prepare')
      },
      async execute() {
        throw unreachable('request execute')
      },
    }
    return Object.fromEntries(ATTENDANCE_REQUEST_OPERATION_KINDS_V1.map((kind) => [kind, adapter])) as Record<
      (typeof ATTENDANCE_REQUEST_OPERATION_KINDS_V1)[number],
      AttendanceRequestOperationAdapterV1
    >
  }

  function recordAdapters(): Record<(typeof ATTENDANCE_RECORD_OPERATION_KINDS_V1)[number], AttendanceRecordOperationAdapterV1> {
    const adapter: AttendanceRecordOperationAdapterV1 = {
      async prepareIdentity(trx) {
        await trx.query('SELECT 1 AS p11a05_record_body')
        throw unreachable('record prepareIdentity')
      },
      async prepare(trx) {
        await trx.query('SELECT 1 AS p11a05_record_body')
        throw unreachable('record prepare')
      },
      async execute() {
        throw unreachable('record execute')
      },
    }
    return Object.fromEntries(ATTENDANCE_RECORD_OPERATION_KINDS_V1.map((kind) => [kind, adapter])) as Record<
      (typeof ATTENDANCE_RECORD_OPERATION_KINDS_V1)[number],
      AttendanceRecordOperationAdapterV1
    >
  }

  /** The eight adapters the LSB factory requires; none is reached by the online replay probe. */
  function liveLegacyAdapters(): Parameters<typeof createAttendanceLiveScheduledBoundaryV1>[0]['legacyAdapters'] {
    const stub = (where: string) => async () => {
      throw unreachable(where)
    }
    return {
      applyLivePunchLegacy: stub('applyLivePunchLegacy'),
      insertLivePunchEvent: stub('insertLivePunchEvent'),
      deriveLivePunchWorkDateResolution: stub('deriveLivePunchWorkDateResolution'),
      applyScheduledAbsenceLegacy: stub('applyScheduledAbsenceLegacy'),
      resolveLiveCandidate: stub('resolveLiveCandidate'),
      resolveScheduledCandidate: stub('resolveScheduledCandidate'),
      buildShadowFrozenContext: stub('buildShadowFrozenContext'),
      issueFrozenContext: stub('issueFrozenContext'),
    } as unknown as Parameters<typeof createAttendanceLiveScheduledBoundaryV1>[0]['legacyAdapters']
  }

  const BOUNDARIES: readonly BoundaryCase[] = [
    {
      // Body's first statement: the adapter's prepareIdentity query (BND protocol, ~L806).
      name: 'BND request boundary execute',
      pre: [],
      call: (probe) =>
        createAttendanceRequestOperationBoundaryV1({ acquireConnection: probe.provider(), adapters: requestAdapters() }).execute({
          kind: 'request_create',
          operationId: crypto.randomUUID(),
          correlationId: `${NS}-request`,
          routeVariant: 'generic',
          routeInput: {},
        }),
      // Null operation id + canonical org with no rollout row: the protocol's null-ID legacy branch
      // (rollout lock, posture read = legacy) runs prepare and execute and returns `legacy`.
      commit: {
        effectTag: `${NS}-bnd-commit`,
        call: (probe) =>
          createAttendanceRequestOperationBoundaryV1({
            acquireConnection: probe.provider(),
            adapters: completingRequestAdapters(orgIdFor('bnd-commit'), `${NS}-bnd-commit`),
          }).execute({
            kind: 'request_create',
            operationId: null,
            correlationId: `${NS}-request-commit`,
            routeVariant: 'generic',
            routeInput: {},
          }),
      },
    },
    {
      // Autocommit readCandidateJob first (the seeded job), then the runner; body's first statement:
      // acquireClass00's timezone prefix lock. Client wrapped by CCON, as the IDX provider does.
      name: 'PROC legacy plan processor',
      pre: ['statement:ok'],
      call: (probe) =>
        createAttendanceLegacyPlanProcessorV1({
          acquireConnection: probe.provider((client) => createAttendanceLegacyPlanCommitConnectionV1(client)),
        }).processLegacyImportPlanV1(importJobId),
      // Same seeded job: it carries no W4 contract version, so after class-00 and the posture read the
      // worker's authorization read finds no V1 row and the body returns `not_found`. COMMIT is sent
      // through CCON as a config object. The body writes nothing.
      commit: {
        call: (probe) =>
          createAttendanceLegacyPlanProcessorV1({
            acquireConnection: probe.provider((client) => createAttendanceLegacyPlanCommitConnectionV1(client)),
          }).processLegacyImportPlanV1(importJobId),
      },
    },
    {
      // Passes validateHostInputBeforeConnection (empty arrays, sourceRowCount 0, 64-hex fingerprint);
      // body's first statement: resolveSegmentCalculationPosture's rollout-state read. CCON-wrapped client.
      name: 'RES legacy plan reservation host',
      pre: [],
      call: (probe) =>
        createAttendanceLegacyPlanReservationHostV1({
          acquireConnection: probe.provider((client) => createAttendanceLegacyPlanCommitConnectionV1(client)),
        }).reserveLegacyImportPlanV1({
          orgId: orgIdFor('res'),
          actorId: `${NS}-actor`,
          actorPosture: 'self',
          tokenSubjectUserId: `${NS}-actor`,
          batchId: crypto.randomUUID(),
          idempotencyKey: null,
          legacyInputFingerprint: '0'.repeat(64),
          payload: {},
          legacyRowSourceKind: 'csv',
          legacySourceRowLimit: null,
          batch: { kind: 'normal', sourceRowCount: 0 },
          artifactCleanup: {},
          items: [],
          recordWrites: [],
          groupEffects: [],
        } as unknown as ReserveAttendanceLegacyImportPlanFromHostInputV1),
      commit: {
        todo:
          'RES (c): every path to COMMIT first runs the full-import authorization recheck (users, user_orgs, user_roles, '
          + 'user_namespace_admissions, role_permissions, user_permissions with a granted attendance import permission) and then '
          + 'either reserves a new V1 job (a valid LegacyImportPublicJobEnvelopeV1 payload and a normal batch plan whose manifest '
          + 'passes attendance_validate_import_legacy_plan_v1) or returns `existing` for an already-reserved V1 job with its durable '
          + 'plan rows; both are the durable-plan-enqueue suite fixture, well over this suite budget',
      },
    },
    {
      // Passes validateHostInput; body's first statement: the import timezone prefix lock (outside the
      // body-level catch that rewrites a string `code`). Raw client, as the IDX provider passes it.
      name: 'SYNC sync import host',
      pre: [],
      call: (probe) =>
        createAttendanceSyncImportHostV1({ acquireConnection: probe.provider() }).commitSyncImportPlanV1({
          orgId: orgIdFor('sync'),
          actorId: `${NS}-actor`,
          actorPosture: 'self',
          tokenSubjectUserId: `${NS}-actor`,
          batchId: crypto.randomUUID(),
          idempotencyKey: null,
          payload: {},
          legacyRowSourceKind: 'csv',
          legacySourceRowLimit: null,
          batch: { kind: 'normal', sourceRowCount: 0 },
          artifactCleanup: {},
          items: [],
          recordWrites: [],
          groupEffects: [],
          itemReturnPolicy: { returnItems: false, itemsLimit: null },
        } as unknown as CommitAttendanceSyncImportPlanFromHostInputV1),
      // Idempotent replay: the actor is active with an active membership (liveness recheck), and a
      // committed legacy batch already carries this idempotency key, so the body returns the
      // idempotent response after the reservation locks. The body writes nothing.
      commit: {
        call: (probe) =>
          createAttendanceSyncImportHostV1({ acquireConnection: probe.provider() }).commitSyncImportPlanV1({
            orgId: orgIdFor('sync-commit'),
            actorId: SYNC_ACTOR,
            actorPosture: 'self',
            tokenSubjectUserId: SYNC_ACTOR,
            batchId: crypto.randomUUID(),
            idempotencyKey: SYNC_KEY,
            payload: {},
            legacyRowSourceKind: 'csv',
            legacySourceRowLimit: null,
            batch: { kind: 'normal', sourceRowCount: 0 },
            artifactCleanup: {},
            items: [],
            recordWrites: [],
            groupEffects: [],
            itemReturnPolicy: { returnItems: false, itemsLimit: null },
          } as unknown as CommitAttendanceSyncImportPlanFromHostInputV1),
      },
    },
    {
      // Exactly the four keys, tokenSubjectUserId === actorId; body's first statement: the rollout
      // lock helper's own `set_config('lock_timeout')` (counted by position, not by text).
      name: 'RB import rollback boundary',
      pre: [],
      call: (probe) =>
        createAttendanceImportRollbackBoundaryV1({ acquireConnection: probe.provider() }).rollbackImportBatchV1({
          orgId: orgIdFor('rb'),
          batchId: crypto.randomUUID(),
          actorId: `${NS}-actor`,
          tokenSubjectUserId: `${NS}-actor`,
        }),
      commit: {
        todo:
          'RB (c): the only successful returns are a completed legacy or W4 rollback; both need a committed import batch with '
          + 'its items and attendance records, an actor whose attendance import/admin permission resolveRollbackActorPosture '
          + 'accepts (RBAC tables), and legacy delete eligibility or a durable operation batch with frozen preimages; that is '
          + 'the import-rollback suite fixture (built through the real plugin import route), well over this suite budget',
      },
    },
    {
      // LSB withConnection through the online replay probe (design D3-02's read-only probe): input is
      // validated before the borrow; body's first statement: the actor liveness read.
      name: 'LSB withConnection (probeOnlinePunchReplay)',
      pre: [],
      call: (probe) => {
        const userId = crypto.randomUUID()
        const orgId = orgIdFor('lsb')
        return createAttendanceLiveScheduledBoundaryV1({
          acquireConnection: probe.provider(),
          legacyAdapters: liveLegacyAdapters(),
        }).probeOnlinePunchReplay({
          orgId,
          userId,
          tokenSubjectUserId: userId,
          operationId: crypto.randomUUID(),
          client: { eventType: 'check_in', timezone: 'UTC', source: null, location: null, meta: null, photoFileId: null, requestNamedOrgId: orgId },
        })
      },
      // The user is active with an active membership; no operation row exists for the id, so the
      // replay probe returns null (no receipt) and the body completes. The body writes nothing.
      commit: {
        call: (probe) => {
          const orgId = orgIdFor('lsb-commit')
          return createAttendanceLiveScheduledBoundaryV1({
            acquireConnection: probe.provider(),
            legacyAdapters: liveLegacyAdapters(),
          }).probeOnlinePunchReplay({
            orgId,
            userId: LSB_USER,
            tokenSubjectUserId: LSB_USER,
            operationId: crypto.randomUUID(),
            client: { eventType: 'check_in', timezone: 'UTC', source: null, location: null, meta: null, photoFileId: null, requestNamedOrgId: orgId },
          })
        },
      },
    },
    {
      // Non-cleaning entry (REC:494); body's first statement: the adapter's prepareIdentity query.
      name: 'REC record boundary execute',
      pre: [],
      call: (probe) =>
        createAttendanceRecordOperationBoundaryV1({ acquireConnection: probe.provider(), adapters: recordAdapters() }).execute({
          kind: 'manual_edit',
          operationId: crypto.randomUUID(),
          correlationId: `${NS}-record`,
          routeInput: {},
        }),
      // Null operation id + canonical org with no rollout row: the null-ID legacy branch runs execute
      // and returns `legacy`.
      commit: {
        effectTag: `${NS}-rec-commit`,
        call: (probe) =>
          createAttendanceRecordOperationBoundaryV1({
            acquireConnection: probe.provider(),
            adapters: completingRecordAdapters(orgIdFor('rec-commit'), `${NS}-rec-commit`),
          }).execute({
            kind: 'manual_edit',
            operationId: null,
            correlationId: `${NS}-record-commit`,
            routeInput: {},
          }),
      },
    },
    {
      // OPS:236 / 272; body's first statement: the scan's UPDATE ... RETURNING. A scan failure fails the tick.
      name: 'OPS sweep scan',
      pre: [],
      call: (probe) =>
        sweepAttendanceScheduledRunsOnceV1(probe.pool(), {
          recoverCandidate: async () => {
            throw unreachable('recoverCandidate')
          },
        }),
      // Not one of the providers S4-PLAN §1 item 3 names; its COMMIT path is the abandon 57014 leg's twin.
      commit: null,
    },
  ]

  for (const boundary of BOUNDARIES) {
    describe(`A05 — ${boundary.name}`, () => {
      it('(a) an ordinary body failure with a successful ROLLBACK returns the connection; the body error reaches the caller unchanged and unmarked', async () => {
        await withProbe(async (probe) => {
          const bodyError = probe.failNextBodyStatement()
          const error = await caught(() => boundary.call(probe))

          expect(error).toBe(bodyError)
          expect((error as { code?: unknown }).code).toBe('PROBE_BODY')
          expect((error as Error).message).toBe('probe: body failed')
          expect(isAttendanceW4ConnectionUncertainV1(error)).toBe(false)
          expect(probe.pendingFaults()).toEqual([])
          expect(probe.borrows).toHaveLength(1)
          const borrow = probe.borrows[0]!
          expect(probe.shape(borrow)).toEqual([...boundary.pre, ...ORDINARY_TAIL])
          await expectReturned(probe, borrow)
        })
      })

      it('(b) the same body failure with a failed ROLLBACK destroys the connection; the same body error reaches the caller, marked', async () => {
        await withProbe(async (probe) => {
          const bodyError = probe.failNextBodyStatement()
          const rollbackError = probe.failNextRollback()
          const error = await caught(() => boundary.call(probe))

          expect(error).toBe(bodyError)
          expect(error).not.toBe(rollbackError)
          expect((error as { code?: unknown }).code).toBe('PROBE_BODY')
          expect((error as Error).message).toBe('probe: body failed')
          expect(isAttendanceW4ConnectionUncertainV1(error)).toBe(true)
          expect(isAttendanceW4ConnectionUncertainV1(rollbackError)).toBe(false)
          expect(probe.pendingFaults()).toEqual([])
          expect(probe.borrows).toHaveLength(1)
          const borrow = probe.borrows[0]!
          expect(probe.shape(borrow)).toEqual([...boundary.pre, ...DESTROY_TAIL])
          await expectDestroyed(probe, borrow, bodyError)
        })
      })

      const spec = boundary.commit
      if (spec && 'todo' in spec) {
        it.todo(spec.todo)
      } else if (spec) {
        const commit = spec as CommitLeg
        it('(c) the body completes and COMMIT fails with 57014: destroyed, the COMMIT error reaches the caller unchanged and marked, no retry, nothing written survives', async () => {
          await withProbe(async (probe) => {
            const commitError = probe.failNextCommit('57014')
            const error = await caught(() => commit.call(probe))

            expect(error).toBe(commitError)
            expect((error as { code?: unknown }).code).toBe('57014')
            expect((error as Error).message).toBe('probe: commit failed')
            expect(isAttendanceW4ConnectionUncertainV1(error)).toBe(true)
            expect(probe.pendingFaults()).toEqual([])
            expect(probe.borrows).toHaveLength(1)
            const borrow = probe.borrows[0]!
            expect(probe.controlShape(borrow)).toEqual(COMMIT_FAILED_CONTROL)
            expect(probe.shape(borrow).slice(-2)).toEqual(['COMMIT:faulted', 'ROLLBACK:ok'])
            if (commit.effectTag !== undefined) {
              // The body did write (the INSERT was sent and succeeded), and the cleanup ROLLBACK undid it.
              expect(borrow.statements.filter((statement) => statement.text.startsWith('INSERT INTO p11a05_effects'))
                .map((statement) => statement.outcome)).toEqual(['ok'])
            }
            await expectDestroyed(probe, borrow, commitError)
          })
          if (commit.effectTag !== undefined) expect(await effectCount(commit.effectTag)).toBe(0)
        })
      }
    })
  }

  // -------------------------------------------------------------------------------------------
  // A05 — the per-candidate sweep borrow (OPS:280 / 290): errors are counted and swallowed.
  // -------------------------------------------------------------------------------------------

  describe('A05 — OPS sweep per-candidate borrow', () => {
    async function tick(probe: AttendanceW4ReleaseProbe, recovered: unknown[]) {
      return sweepAttendanceScheduledRunsOnceV1(probe.pool(), {
        recoverCandidate: async (candidate) => {
          recovered.push(candidate)
        },
      })
    }

    const TICK_WITH_ONE_ERROR = {
      scanned: 1,
      finalized: 0,
      notReady: 0,
      skipped: 0,
      errored: 1,
      backlogRemaining: 1,
      neverAttemptedRunning: 0,
      oldestRunningAttemptAgeSeconds: expect.any(Number),
    }

    it('(a) an ordinary candidate body failure is counted and the connection goes back to the pool', async () => {
      const { orgId, runId } = await runningRun('sweep-candidate-a')
      try {
        expect(await runningCount()).toBe(1)
        await withProbe(async (probe) => {
          const bodyError = probe.failNextBodyStatement({ skipBorrows: 1 })
          const recovered: unknown[] = []
          const result = await tick(probe, recovered)

          expect(result).toEqual(TICK_WITH_ONE_ERROR)
          expect(recovered).toEqual([])
          expect(isAttendanceW4ConnectionUncertainV1(bodyError)).toBe(false)
          expect(probe.pendingFaults()).toEqual([])
          expect(probe.borrows).toHaveLength(2)
          const [scan, candidate] = probe.borrows as [AttendanceW4ReleaseProbeBorrow, AttendanceW4ReleaseProbeBorrow]
          expect(probe.controlShape(scan)).toEqual(['BEGIN:ok', 'COMMIT:ok'])
          expect(scan.releaseCalls).toStrictEqual([undefined])
          expect(scan.releaseEvents).toStrictEqual([undefined])
          expect(scan.removed).toBe(false)
          expect(candidate.pid).toBe(scan.pid)
          expect(probe.shape(candidate)).toEqual(ORDINARY_TAIL)
          await expectReturned(probe, candidate)
        })
        expect(await runState(runId)).toBe('running')
        await abandonViaObserver(orgId, runId)
      } finally {
        await cleanupRun(orgId, runId)
      }
    })

    it('(b) a candidate body failure with a failed ROLLBACK is counted and the connection is destroyed with the swallowed error', async () => {
      const { orgId, runId } = await runningRun('sweep-candidate-b')
      try {
        expect(await runningCount()).toBe(1)
        await withProbe(async (probe) => {
          const bodyError = probe.failNextBodyStatement({ skipBorrows: 1 })
          probe.failNextRollback({ skipBorrows: 1 })
          const recovered: unknown[] = []
          const result = await tick(probe, recovered)

          expect(result).toEqual(TICK_WITH_ONE_ERROR)
          expect(recovered).toEqual([])
          expect(isAttendanceW4ConnectionUncertainV1(bodyError)).toBe(true)
          expect(probe.pendingFaults()).toEqual([])
          expect(probe.borrows).toHaveLength(2)
          const [scan, candidate] = probe.borrows as [AttendanceW4ReleaseProbeBorrow, AttendanceW4ReleaseProbeBorrow]
          expect(probe.controlShape(scan)).toEqual(['BEGIN:ok', 'COMMIT:ok'])
          expect(scan.releaseCalls).toStrictEqual([undefined])
          expect(scan.releaseEvents).toStrictEqual([undefined])
          expect(candidate.pid).toBe(scan.pid)
          expect(probe.shape(candidate)).toEqual(DESTROY_TAIL)
          await expectDestroyed(probe, candidate, bodyError)
        })
        expect(await runState(runId)).toBe('running')
        await abandonViaObserver(orgId, runId)
      } finally {
        await cleanupRun(orgId, runId)
      }
    })
  })

  // -------------------------------------------------------------------------------------------
  // A06 — OPS:370, admin abandon-run: per-consumer evidence.
  // -------------------------------------------------------------------------------------------

  describe('A06 — OPS abandonScheduledRunOnceV1 (OPS:370)', () => {
    const input = (orgId: string, runId: string) => ({ orgId, runId, adminActorId: ADMIN_ACTOR, reasonCode: ABANDON_REASON })
    const notFound = (): AttendanceW4OperationError => new AttendanceW4OperationError('ATTENDANCE_SCHEDULED_RUN_NOT_FOUND')

    /** Same class, message and enumerable own fields as a freshly constructed not-found error. */
    function expectNotFoundUnchanged(error: unknown): void {
      const reference = notFound()
      expect(error).toBeInstanceOf(AttendanceW4OperationError)
      expect((error as Error).message).toBe(reference.message)
      expect({ ...(error as object) }).toStrictEqual({ ...reference })
    }

    it('success: the run is abandoned, the connection is released once without an error and goes back', async () => {
      const { orgId, runId } = await runningRun('abandon-success')
      await withProbe(async (probe) => {
        const outcome = await abandonScheduledRunOnceV1(probe.pool(), input(orgId, runId))

        expect(outcome).toEqual({ kind: 'abandoned', runId, completedUserCount: 0 })
        expect(probe.borrows).toHaveLength(1)
        const borrow = probe.borrows[0]!
        expect(probe.controlShape(borrow)).toEqual(['BEGIN:ok', 'COMMIT:ok'])
        await expectReturned(probe, borrow)
      })
      expect(await runState(runId)).toBe('abandoned')
    })

    it('ordinary business error with a successful ROLLBACK: returned once, the error unchanged and unmarked', async () => {
      const orgId = orgIdFor('abandon-business')
      await withProbe(async (probe) => {
        const error = await caught(() => abandonScheduledRunOnceV1(probe.pool(), input(orgId, crypto.randomUUID())))

        expectNotFoundUnchanged(error)
        expect(isAttendanceW4ConnectionUncertainV1(error)).toBe(false)
        expect(probe.borrows).toHaveLength(1)
        const borrow = probe.borrows[0]!
        expect(probe.controlShape(borrow)).toEqual(['BEGIN:ok', 'ROLLBACK:ok'])
        await expectReturned(probe, borrow)
      })
    })

    it('business error with a failed ROLLBACK: destroyed once, the error unchanged and marked', async () => {
      const orgId = orgIdFor('abandon-rollback-failed')
      await withProbe(async (probe) => {
        const rollbackError = probe.failNextRollback()
        const error = await caught(() => abandonScheduledRunOnceV1(probe.pool(), input(orgId, crypto.randomUUID())))

        expect(error).not.toBe(rollbackError)
        expectNotFoundUnchanged(error)
        expect(isAttendanceW4ConnectionUncertainV1(error)).toBe(true)
        expect(probe.pendingFaults()).toEqual([])
        expect(probe.borrows).toHaveLength(1)
        const borrow = probe.borrows[0]!
        expect(probe.controlShape(borrow)).toEqual(['BEGIN:ok', 'ROLLBACK:faulted'])
        await expectDestroyed(probe, borrow, error)
      })
    })

    it('COMMIT failing with 57014: destroyed once, the COMMIT error unchanged and marked; nothing committed, one cleanup ROLLBACK, no retry', async () => {
      const { orgId, runId } = await runningRun('abandon-commit-57014')
      try {
        await withProbe(async (probe) => {
          const commitError = probe.failNextCommit('57014')
          const error = await caught(() => abandonScheduledRunOnceV1(probe.pool(), input(orgId, runId)))

          expect(error).toBe(commitError)
          expect((error as { code?: unknown }).code).toBe('57014')
          expect((error as Error).message).toBe('probe: commit failed')
          expect(isAttendanceW4ConnectionUncertainV1(error)).toBe(true)
          expect(probe.pendingFaults()).toEqual([])
          expect(probe.borrows).toHaveLength(1)
          const borrow = probe.borrows[0]!
          expect(probe.controlShape(borrow)).toEqual(['BEGIN:ok', 'COMMIT:faulted', 'ROLLBACK:ok'])
          await expectDestroyed(probe, borrow, commitError)
        })
        expect(await runState(runId)).toBe('running')
        await abandonViaObserver(orgId, runId)
      } finally {
        await cleanupRun(orgId, runId)
      }
    })

    it.each(['40001', '40P01'] as const)('control: COMMIT failing with %s is retried on the same connection as before, then released once without an error and kept', async (code) => {
      const { orgId, runId } = await runningRun(`abandon-commit-${code}`)
      try {
        await withProbe(async (probe) => {
          const commitError = probe.failNextCommit(code)
          const outcome = await abandonScheduledRunOnceV1(probe.pool(), input(orgId, runId))

          expect(outcome).toEqual({ kind: 'abandoned', runId, completedUserCount: 0 })
          expect((commitError as { code?: unknown }).code).toBe(code)
          expect(isAttendanceW4ConnectionUncertainV1(commitError)).toBe(false)
          expect(probe.pendingFaults()).toEqual([])
          expect(probe.borrows).toHaveLength(1)
          const borrow = probe.borrows[0]!
          expect(probe.controlShape(borrow)).toEqual([
            'BEGIN:ok',
            'COMMIT:faulted',
            'ROLLBACK:ok',
            'BEGIN:ok',
            'COMMIT:ok',
          ])
          await expectReturned(probe, borrow)
        })
        expect(await runState(runId)).toBe('abandoned')
      } finally {
        await cleanupRun(orgId, runId)
      }
    })
  })

  // -------------------------------------------------------------------------------------------
  // A04 — the same-connection outer wrapper (ROLL `runControlTransaction`): a marked error is not
  // retried, even when it is one of the two retryable control preconditions.
  // -------------------------------------------------------------------------------------------

  describe('A04 — rollout-control runControlTransaction via closeLegacyRollbackWindowV1', () => {
    const closeInput = (label: string) => ({
      orgId: orgIdFor(label),
      batchId: crypto.randomUUID(),
      actorId: 'p11a05-actor',
      correlationId: crypto.randomUUID(),
      engineVersion: 'v1',
      reasonCode: 'legacy_rollback_window_closed' as const,
    })

    /** The probe backend's transaction state as the server reports it, read from another connection. */
    async function serverTransactionState(pid: number): Promise<Array<{ state: string; no_transaction: boolean }>> {
      const { rows } = await observer.query(
        'SELECT state, xact_start IS NULL AS no_transaction FROM pg_stat_activity WHERE pid = $1',
        [pid],
      )
      return rows as Array<{ state: string; no_transaction: boolean }>
    }

    // The ROLLBACK runs on the server and only its result is lost: the transaction has really ended and
    // the connection is idle, so the runner's Gate E would admit a second attempt. The mark check in
    // runControlTransaction is the only thing that stops one (TEST-MATRIX A04).
    it.each(['W4C3A_ROLLOUT_CONTROL_UNCLOSED_BATCH', 'W4C3A_ROLLOUT_CONTROL_CLOSE_CONFLICT'] as const)(
      '(d1) a %s precondition whose ROLLBACK ran on the server but whose result was lost is marked and not retried, although Gate E would admit a retry; the caller destroys the connection with it',
      async (code) => {
        await withProbe(async (probe) => {
          const hookError = new AttendanceW4C3aRolloutControlError(code)
          const calls: string[] = []
          __setW4C3aRolloutControlAfterExclusiveLockForTests(async (kind) => {
            calls.push(kind)
            throw hookError
          })
          try {
            // Faults attach at checkout, so they are armed before the connection is borrowed.
            const rollbackError = probe.loseNextRollbackResult()
            const client = (await probe.pool().connect()) as PoolClient
            const error = await caught(() =>
              closeLegacyRollbackWindowV1(attendanceOwningSessionForClientV1(client), closeInput(`close-d1-${code}`)),
            )

            expect(probe.borrows).toHaveLength(1)
            const borrow = probe.borrows[0]!
            // Exactly one attempt: one BEGIN, the ROLLBACK executed on the server with its reply lost.
            expect(probe.controlShape(borrow)).toEqual(['BEGIN:ok', 'ROLLBACK:lost'])
            expect(calls).toEqual(['close'])
            expect(error).toBe(hookError)
            expect(error).not.toBe(rollbackError)
            expect((error as { code?: unknown }).code).toBe(code)
            expect(isAttendanceW4ConnectionUncertainV1(error)).toBe(true)
            expect(isAttendanceW4ConnectionUncertainV1(rollbackError)).toBe(false)
            expect(probe.pendingFaults()).toEqual([])
            expect(borrow.unfired).toEqual([])
            expect(borrow.releaseCalls).toEqual([])

            // The server ended the transaction: the connection is idle and the next Gate E passes on it.
            expect(await serverTransactionState(borrow.pid)).toEqual([{ state: 'idle', no_transaction: true }])
            await expect(withAttendanceExclusiveIdleSessionV1(
              attendanceOwningSessionForClientV1(client), lease => assertConnectionIsIdleV1(lease),
            )).resolves.toBeUndefined()
            expect(probe.controlShape(borrow)).toEqual(['BEGIN:ok', 'ROLLBACK:lost'])

            // Even so the caller's discard value is the error, and the release destroys the connection.
            expect(attendanceW4ConnectionDiscardV1(error)).toBe(error)
            client.release(attendanceW4ConnectionDiscardV1(error))
            await expectDestroyed(probe, borrow, error)
          } finally {
            __setW4C3aRolloutControlAfterExclusiveLockForTests(null)
          }
        })
      },
    )

    // The ROLLBACK never reaches the server: its transaction stays open, so here Gate E would refuse a
    // second attempt on its own; only the destroy ends the transaction.
    it('(d1, never sent) a CLOSE_CONFLICT precondition whose ROLLBACK never reached the server is marked and not retried; the server transaction stays open until the caller destroys the connection', async () => {
      await withProbe(async (probe) => {
        const hookError = new AttendanceW4C3aRolloutControlError('W4C3A_ROLLOUT_CONTROL_CLOSE_CONFLICT')
        const calls: string[] = []
        __setW4C3aRolloutControlAfterExclusiveLockForTests(async (kind) => {
          calls.push(kind)
          throw hookError
        })
        try {
          probe.failNextRollback()
          const client = (await probe.pool().connect()) as PoolClient
          const error = await caught(() =>
            closeLegacyRollbackWindowV1(attendanceOwningSessionForClientV1(client), closeInput('close-d1-never-sent')),
          )

          expect(error).toBe(hookError)
          expect((error as { code?: unknown }).code).toBe('W4C3A_ROLLOUT_CONTROL_CLOSE_CONFLICT')
          expect(isAttendanceW4ConnectionUncertainV1(error)).toBe(true)
          expect(calls).toEqual(['close'])
          expect(probe.pendingFaults()).toEqual([])
          expect(probe.borrows).toHaveLength(1)
          const borrow = probe.borrows[0]!
          expect(probe.controlShape(borrow)).toEqual(['BEGIN:ok', 'ROLLBACK:faulted'])
          expect(await serverTransactionState(borrow.pid)).toEqual([{ state: 'idle in transaction', no_transaction: false }])
          // The release is the caller's job; the error carries what it needs to destroy the connection.
          client.release(attendanceW4ConnectionDiscardV1(error))
          await expectDestroyed(probe, borrow, error)
        } finally {
          __setW4C3aRolloutControlAfterExclusiveLockForTests(null)
        }
      })
    })

    it('(d2) control: an unmarked CLOSE_CONFLICT is still retried once on the same connection, as before', async () => {
      await withProbe(async (probe) => {
        const first = new AttendanceW4C3aRolloutControlError('W4C3A_ROLLOUT_CONTROL_CLOSE_CONFLICT')
        const second = Object.assign(new Error('p11a05: stop'), { code: 'P11_A05_STOP' })
        const calls: string[] = []
        __setW4C3aRolloutControlAfterExclusiveLockForTests(async (kind) => {
          calls.push(kind)
          throw calls.length === 1 ? first : second
        })
        try {
          const client = (await probe.pool().connect()) as PoolClient
          const error = await caught(() =>
            closeLegacyRollbackWindowV1(attendanceOwningSessionForClientV1(client), closeInput('close-d2')),
          )

          expect(error).toBe(second)
          expect(isAttendanceW4ConnectionUncertainV1(error)).toBe(false)
          expect(isAttendanceW4ConnectionUncertainV1(first)).toBe(false)
          expect(calls).toEqual(['close', 'close'])
          expect(probe.borrows).toHaveLength(1)
          const borrow = probe.borrows[0]!
          // Each runControlTransaction attempt is a fresh owning runner call; admission emits no SQL.
          expect(probe.controlShape(borrow)).toEqual([
            'BEGIN:ok', 'ROLLBACK:ok',
            'BEGIN:ok', 'ROLLBACK:ok',
          ])
          expect(attendanceW4ConnectionDiscardV1(error)).toBeUndefined()
          client.release(attendanceW4ConnectionDiscardV1(error))
          await expectReturned(probe, borrow)
        } finally {
          __setW4C3aRolloutControlAfterExclusiveLockForTests(null)
        }
      })
    })
  })

  // -------------------------------------------------------------------------------------------
  // A04 — the runner itself: a failed ROLLBACK stops the same-connection retry even for 40001.
  // -------------------------------------------------------------------------------------------

  describe('A04 — runner retry stops on a failed ROLLBACK', () => {
    const body = async (trx: AttendanceW4TransactionClientV1): Promise<string> => {
      await trx.query('SELECT 1 AS p11a05_runner_body')
      return 'p11a05-done'
    }

    it('(e) a 40001 body error whose ROLLBACK failed is marked and not retried; the caller destroys the connection with it', async () => {
      await withProbe(async (probe) => {
        const bodyError = probe.failNextBodyStatement({ code: '40001' })
        probe.failNextRollback()
        const client = (await probe.pool().connect()) as PoolClient
        const error = await caught(() => runAttendanceResultOperationTransactionV1(attendanceOwningSessionForClientV1(client), body))

        expect(error).toBe(bodyError)
        expect((error as { code?: unknown }).code).toBe('40001')
        expect((error as Error).message).toBe('probe: body failed')
        expect(isAttendanceW4ConnectionUncertainV1(error)).toBe(true)
        expect(probe.pendingFaults()).toEqual([])
        expect(probe.borrows).toHaveLength(1)
        const borrow = probe.borrows[0]!
        expect(probe.shape(borrow)).toEqual(DESTROY_TAIL)
        client.release(attendanceW4ConnectionDiscardV1(error))
        await expectDestroyed(probe, borrow, error)
      })
    })

    it('(e2) control: the same 40001 body error with a successful ROLLBACK is retried on the same connection and succeeds', async () => {
      await withProbe(async (probe) => {
        const bodyError = probe.failNextBodyStatement({ code: '40001' })
        const client = (await probe.pool().connect()) as PoolClient
        const result = await runAttendanceResultOperationTransactionV1(attendanceOwningSessionForClientV1(client), body)

        expect(result).toBe('p11a05-done')
        expect((bodyError as { code?: unknown }).code).toBe('40001')
        expect(isAttendanceW4ConnectionUncertainV1(bodyError)).toBe(false)
        expect(probe.pendingFaults()).toEqual([])
        expect(probe.borrows).toHaveLength(1)
        const borrow = probe.borrows[0]!
        expect(probe.shape(borrow)).toEqual([
          ...ORDINARY_TAIL,
          'BEGIN:ok', 'set_config(statement_timeout):ok', 'set_config(lock_timeout):ok', 'statement:ok', 'COMMIT:ok',
        ])
        client.release()
        await expectReturned(probe, borrow)
      })
    })
  })
})
