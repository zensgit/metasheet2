/**
 * Core-only W4C-3a rollout-control proof.
 *
 * This test intentionally proves only close/transition serialization. The
 * current rollback implementation does not export a transaction-bound
 * coordinator, so it cannot be used as a real contender without lying with a
 * fixture. That integration remains an explicit interface gap.
 */
import crypto from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { up as w4c0Up } from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import {
  __setW4C3aRolloutControlAfterExclusiveLockForTests,
  closeLegacyRollbackWindowV1,
  transitionAttendanceCalculationRolloutV1,
  type AttendanceW4C3aRolloutControlResultV1,
} from '../../src/attendance/w4c3a-rollout-control'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const run = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

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
  let adminPool: Pool
  let pool: Pool

  async function insertLegacyBatch(id = batchId): Promise<void> {
    await pool.query(
      `INSERT INTO attendance_import_batches (id, org_id, status, row_count, meta)
       VALUES ($1::uuid, $2, 'committed', 1, '{"source":"test"}'::jsonb)`,
      [id, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_import_items (batch_id, org_id, user_id, work_date, preview_snapshot)
       VALUES ($1::uuid, $2, $3, '2026-08-01', '{}'::jsonb)`,
      [id, orgId, userId],
    )
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
  }, 60_000)

  afterAll(async () => {
    __setW4C3aRolloutControlAfterExclusiveLockForTests(null)
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
          targetState: 'shadow', reasonCode: 'rollout_transition',
        }),
      ).rejects.toMatchObject({ code: 'W4C3A_ROLLOUT_CONTROL_UNCLOSED_BATCH' })
      await expect(pool.query('SELECT count(*)::int AS n FROM attendance_calculation_rollout_state WHERE org_id = $1', [orgId]))
        .resolves.toMatchObject({ rows: [{ n: 0 }] })
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
        targetState: 'shadow', reasonCode: 'rollout_transition',
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
        targetState: 'eligible', reasonCode: 'rollout_transition',
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
})
