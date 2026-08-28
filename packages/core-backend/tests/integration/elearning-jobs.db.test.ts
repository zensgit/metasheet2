/**
 * E-learning L0 jobs claim-lease gate (real PostgreSQL).
 *
 * DATABASE_URL is required. A missing URL throws (refusing skip-shaped green).
 * This suite verifies the migrator product; it does not re-run up() against
 * the shared schema. HTTP/API surfaces are out of this slice.
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import {
  ELEARNING_JOBS_CLAIM_INDEX,
  ELEARNING_JOBS_ORG_KIND_OCCURRENCE_UNIQ,
  ELEARNING_JOBS_TABLE,
  up,
} from '../../src/db/migrations/zzzz20260826160000_create_elearning_jobs'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning jobs gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const require = createRequire(import.meta.url)
const jobs = require('../../../../plugins/plugin-elearning/lib/jobs.cjs') as {
  registerJobHandler: (kind: string, handler: (job: Record<string, unknown>) => Promise<void> | void) => void
  clearJobHandlers: () => void
  claimDueJobs: (
    database: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    options?: Record<string, unknown>,
  ) => Promise<Array<Record<string, unknown>>>
  finalizeJobSuccess: (
    database: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    input: { jobId: string; workerId: string; claimAttempt: number },
  ) => Promise<boolean>
  finalizeJobFailure: (
    database: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    input: { jobId: string; workerId: string; claimAttempt: number; code?: string; maxAttempts?: number },
  ) => Promise<boolean>
  runJobsTick: (override: Record<string, unknown>) => Promise<{ claimed: number; skipped?: boolean }>
  CLAIM_SQL: string
  FINALIZE_SUCCESS_SQL: string
  FINALIZE_FAILURE_SQL: string
  ATTEMPTS_EXHAUSTED: string
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
const NS = `el-jobs-${Date.now().toString(36)}`
const LOCK_TIMEOUT_MS = 400
const SKIP_LOCKED_BUDGET_MS = 1000
const MIGRATION_NAME = 'zzzz20260826160000_create_elearning_jobs'

interface PgError extends Error {
  code?: string
  constraint?: string
}

function orgId(suffix: string): string {
  return `${NS}-${suffix}`
}

function pluginDb(target: Pool | PoolClient) {
  return {
    query: async (text: string, params?: unknown[]) => {
      const result = await target.query(text, params as never)
      return result.rows
    },
  }
}

async function reject(fn: () => Promise<unknown>): Promise<PgError | null> {
  try {
    await fn()
    return null
  } catch (error) {
    return error as PgError
  }
}

function uniqueKind(): string {
  return `el-jobs-${randomUUID()}`
}

async function insertJob(input: {
  org: string
  kind: string
  occurrenceKey: string
  ref?: string | null
  payload?: Record<string, unknown>
  dueAt?: Date
  status?: string
  attempts?: number
  lastError?: string | null
}): Promise<{ id: string }> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO elearning_jobs (
       org_id, kind, occurrence_key, ref, payload, due_at, status, attempts, last_error
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7, $8, $9)
     RETURNING id`,
    [
      input.org,
      input.kind,
      input.occurrenceKey,
      input.ref === undefined ? null : input.ref,
      JSON.stringify(input.payload ?? {}),
      (input.dueAt ?? new Date(Date.now() - 1_000)).toISOString(),
      input.status ?? 'pending',
      input.attempts ?? 0,
      input.lastError === undefined ? null : input.lastError,
    ],
  )
  return result.rows[0]
}

async function readJob(id: string) {
  const result = await pool.query(
    `SELECT id, org_id, kind, occurrence_key, ref, payload, due_at, status,
            lease_until, claim_worker_id, attempts, last_error
       FROM elearning_jobs
      WHERE id = $1::uuid`,
    [id],
  )
  return result.rows[0]
}

async function expireLease(id: string): Promise<void> {
  await pool.query(
    `UPDATE elearning_jobs
        SET lease_until = now() - interval '1 second'
      WHERE id = $1::uuid`,
    [id],
  )
}

afterEach(async () => {
  jobs.clearJobHandlers()
  await pool.query('DELETE FROM elearning_jobs WHERE org_id LIKE $1', [`${NS}%`])
})

afterAll(async () => {
  jobs.clearJobHandlers()
  await pool.query('DELETE FROM elearning_jobs WHERE org_id LIKE $1', [`${NS}%`])
  await db.destroy()
})

describe('e-learning jobs claim-lease (real PostgreSQL)', () => {
  it('verifies the migrator product: UUID id, org_id NOT NULL no default, unique identity, checks, index', async () => {
    const ledger = await pool.query<{ name: string }>(
      `SELECT name FROM kysely_migration WHERE name = $1`,
      [MIGRATION_NAME],
    )
    expect(ledger.rows).toEqual([{ name: MIGRATION_NAME }])

    const columns = await pool.query<{
      column_name: string
      data_type: string
      is_nullable: string
      column_default: string | null
      udt_name: string
    }>(
      `SELECT column_name, data_type, is_nullable, column_default, udt_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = $1
        ORDER BY ordinal_position`,
      [ELEARNING_JOBS_TABLE],
    )
    const byName = new Map(columns.rows.map((row) => [row.column_name, row]))
    expect(byName.get('id')?.udt_name).toBe('uuid')
    expect(byName.get('id')?.is_nullable).toBe('NO')
    expect(byName.get('org_id')?.data_type).toBe('text')
    expect(byName.get('org_id')?.is_nullable).toBe('NO')
    expect(byName.get('org_id')?.column_default).toBeNull()
    for (const name of [
      'kind',
      'occurrence_key',
      'ref',
      'payload',
      'due_at',
      'status',
      'lease_until',
      'claim_worker_id',
      'attempts',
      'last_error',
      'created_at',
      'updated_at',
    ]) {
      expect(byName.has(name)).toBe(true)
    }

    const unique = await pool.query<{ conname: string; cols: string }>(
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS cols
         FROM pg_constraint c
        WHERE c.conrelid = 'elearning_jobs'::regclass
          AND c.conname = $1`,
      [ELEARNING_JOBS_ORG_KIND_OCCURRENCE_UNIQ],
    )
    expect(unique.rows).toHaveLength(1)
    expect(unique.rows[0].cols).toContain('UNIQUE')
    expect(unique.rows[0].cols).toContain('org_id')
    expect(unique.rows[0].cols).toContain('kind')
    expect(unique.rows[0].cols).toContain('occurrence_key')

    const checks = await pool.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
        WHERE c.conrelid = 'elearning_jobs'::regclass
          AND contype = 'c'`,
    )
    const checkNames = checks.rows.map((row) => row.conname).sort()
    expect(checkNames).toEqual([
      'elearning_jobs_attempts_chk',
      'elearning_jobs_error_status_chk',
      'elearning_jobs_kind_nonempty_chk',
      'elearning_jobs_last_error_code_chk',
      'elearning_jobs_lease_state_chk',
      'elearning_jobs_occurrence_key_nonempty_chk',
      'elearning_jobs_org_id_nonempty_chk',
      'elearning_jobs_payload_object_chk',
      'elearning_jobs_ref_nonempty_chk',
      'elearning_jobs_status_chk',
    ])
    const byCheck = new Map(checks.rows.map((row) => [row.conname, row.def]))
    expect(byCheck.get('elearning_jobs_last_error_code_chk')).toContain('^[A-Z][A-Z0-9_]{1,63}$')
    expect(byCheck.get('elearning_jobs_org_id_nonempty_chk')).toContain('btrim')
    expect(byCheck.get('elearning_jobs_kind_nonempty_chk')).toContain('btrim')
    expect(byCheck.get('elearning_jobs_occurrence_key_nonempty_chk')).toContain('btrim')
    expect(byCheck.get('elearning_jobs_ref_nonempty_chk')).toContain('btrim')
    expect(byCheck.get('elearning_jobs_lease_state_chk')).toContain(
      'claim_worker_id = btrim(claim_worker_id)',
    )

    const index = await pool.query<{ indexdef: string }>(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = $1`,
      [ELEARNING_JOBS_CLAIM_INDEX],
    )
    expect(index.rows).toHaveLength(1)
    expect(index.rows[0].indexdef).toContain('due_at')
    expect(index.rows[0].indexdef).toContain('lease_until')
    expect(index.rows[0].indexdef).toContain('pending')
    expect(index.rows[0].indexdef).toContain('running')
    expect(index.rows[0].indexdef).toContain('failed')

    const missingOrg = await reject(() =>
      pool.query(
        `INSERT INTO elearning_jobs (kind, occurrence_key, due_at)
         VALUES ('k', 'o', now())`,
      ),
    )
    expect(missingOrg?.code).toBe('23502')
  })

  it('rejects leading/trailing whitespace on org_id, kind, occurrence_key, and ref', async () => {
    const org = orgId('ws')
    const kind = uniqueKind()
    const due = new Date().toISOString()
    const paddedOrg = await reject(() =>
      pool.query(
        `INSERT INTO elearning_jobs (org_id, kind, occurrence_key, due_at)
         VALUES ($1, $2, 'occ', $3::timestamptz)`,
        [` ${org}`, kind, due],
      ),
    )
    expect(paddedOrg?.code).toBe('23514')
    expect(paddedOrg?.constraint).toBe('elearning_jobs_org_id_nonempty_chk')

    const paddedKind = await reject(() =>
      pool.query(
        `INSERT INTO elearning_jobs (org_id, kind, occurrence_key, due_at)
         VALUES ($1, $2, 'occ', $3::timestamptz)`,
        [org, `${kind} `, due],
      ),
    )
    expect(paddedKind?.code).toBe('23514')
    expect(paddedKind?.constraint).toBe('elearning_jobs_kind_nonempty_chk')

    const paddedOcc = await reject(() =>
      pool.query(
        `INSERT INTO elearning_jobs (org_id, kind, occurrence_key, due_at)
         VALUES ($1, $2, ' occ', $3::timestamptz)`,
        [org, kind, due],
      ),
    )
    expect(paddedOcc?.code).toBe('23514')
    expect(paddedOcc?.constraint).toBe('elearning_jobs_occurrence_key_nonempty_chk')

    const paddedRef = await reject(() =>
      pool.query(
        `INSERT INTO elearning_jobs (org_id, kind, occurrence_key, ref, due_at)
         VALUES ($1, $2, 'occ', ' ref', $3::timestamptz)`,
        [org, kind, due],
      ),
    )
    expect(paddedRef?.code).toBe('23514')
    expect(paddedRef?.constraint).toBe('elearning_jobs_ref_nonempty_chk')

    const paddedWorker = await reject(() =>
      pool.query(
        `INSERT INTO elearning_jobs (
           org_id, kind, occurrence_key, due_at, status, lease_until, claim_worker_id, attempts
         ) VALUES ($1, $2, 'occ', now(), 'running', now() + interval '1 minute', ' worker ', 1)`,
        [org, kind],
      ),
    )
    expect(paddedWorker?.code).toBe('23514')
    expect(paddedWorker?.constraint).toBe('elearning_jobs_lease_state_chk')
  })

  it('rejects last_error values that are not values-free stable codes', async () => {
    const org = orgId('code')
    const kind = uniqueKind()
    const invalid = await reject(() =>
      insertJob({
        org,
        kind,
        occurrenceKey: `bad:${randomUUID()}`,
        status: 'failed',
        lastError: 'not a code',
      }),
    )
    expect(invalid?.code).toBe('23514')
    expect(invalid?.constraint).toBe('elearning_jobs_last_error_code_chk')

    const lower = await reject(() =>
      insertJob({
        org,
        kind,
        occurrenceKey: `lower:${randomUUID()}`,
        status: 'failed',
        lastError: 'handler_failed',
      }),
    )
    expect(lower?.code).toBe('23514')
    expect(lower?.constraint).toBe('elearning_jobs_last_error_code_chk')

    const ok = await insertJob({
      org,
      kind,
      occurrenceKey: `ok:${randomUUID()}`,
      status: 'failed',
      lastError: 'HANDLER_FAILED',
    })
    expect(ok.id).toBeTruthy()
  })

  it('fails closed on pre-existing same-name table drift inside a rolled-back schema', async () => {
    const client = await pool.connect()
    const schema = `el_jobs_drift_${randomUUID().replace(/-/g, 'x')}`
    const isolated = new Kysely<unknown>({
      dialect: new PostgresDialect({
        pool: {
          connect: async () => client,
          end: async () => undefined,
        } as unknown as Pool,
      }),
    })
    const originalRelease = client.release.bind(client)
    ;(client as PoolClient & { release: () => void }).release = () => undefined
    try {
      await client.query('BEGIN')
      await client.query(`CREATE SCHEMA ${schema}`)
      await client.query(`SET LOCAL search_path TO ${schema}`)
      await client.query('CREATE TABLE elearning_jobs (id integer PRIMARY KEY)')
      const drift = await reject(() => up(isolated))
      expect(drift?.code).toBe('42P07')
    } finally {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* already rolled back */
      }
      ;(client as PoolClient & { release: typeof originalRelease }).release = originalRelease
      await isolated.destroy()
      originalRelease()
    }

    const stillPublic = await pool.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = $1`,
      [ELEARNING_JOBS_TABLE],
    )
    expect(stillPublic.rows).toHaveLength(1)
  })

  it('same-key replay stays one row; the same occurrence is isolated across orgs', async () => {
    const orgA = orgId('a')
    const orgB = orgId('b')
    const kind = uniqueKind()
    const occurrence = `attempt:${randomUUID()}`
    const first = await insertJob({
      org: orgA,
      kind,
      occurrenceKey: occurrence,
      ref: 'attempt:one',
      payload: { n: 1 },
    })
    const replay = await reject(() =>
      insertJob({
        org: orgA,
        kind,
        occurrenceKey: occurrence,
        ref: 'attempt:two',
        payload: { n: 2 },
      }),
    )
    expect(replay?.code).toBe('23505')
    expect(replay?.constraint).toBe(ELEARNING_JOBS_ORG_KIND_OCCURRENCE_UNIQ)

    const remaining = await pool.query(
      `SELECT id, ref, payload
         FROM elearning_jobs
        WHERE org_id = $1 AND kind = $2 AND occurrence_key = $3`,
      [orgA, kind, occurrence],
    )
    expect(remaining.rows).toHaveLength(1)
    expect(remaining.rows[0].id).toBe(first.id)
    expect(remaining.rows[0].ref).toBe('attempt:one')
    expect(remaining.rows[0].payload).toEqual({ n: 1 })

    const other = await insertJob({
      org: orgB,
      kind,
      occurrenceKey: occurrence,
      ref: 'attempt:one',
      payload: { n: 1 },
    })
    expect(other.id).not.toBe(first.id)
    const both = await pool.query(
      `SELECT org_id
         FROM elearning_jobs
        WHERE kind = $1 AND occurrence_key = $2
        ORDER BY org_id`,
      [kind, occurrence],
    )
    expect(both.rows.map((row) => row.org_id)).toEqual([orgA, orgB])
  })

  it('does not claim kinds without a registered handler', async () => {
    const org = orgId('kinds')
    const kind = uniqueKind()
    const row = await insertJob({ org, kind, occurrenceKey: `export:${randomUUID()}` })
    jobs.registerJobHandler('el-jobs-other', async () => {})
    const claimed = await jobs.claimDueJobs(pluginDb(pool), {
      workerId: 'worker-kind',
      batchSize: 8,
      maxAttempts: 8,
    })
    expect(claimed).toEqual([])
    const still = await readJob(row.id)
    expect(still.status).toBe('pending')
    expect(still.claim_worker_id).toBeNull()
    expect(still.attempts).toBe(0)
  })

  it('does not claim an unregistered kind passed explicitly in claimDueJobs({kinds})', async () => {
    const org = orgId('explicit-kind')
    const kind = uniqueKind()
    const row = await insertJob({ org, kind, occurrenceKey: `export:${randomUUID()}` })
    jobs.registerJobHandler('el-jobs-other', async () => {})
    const claimed = await jobs.claimDueJobs(pluginDb(pool), {
      workerId: 'worker-explicit',
      kinds: [kind],
      batchSize: 8,
      maxAttempts: 8,
    })
    expect(claimed).toEqual([])
    const still = await readJob(row.id)
    expect(still.status).toBe('pending')
    expect(still.claim_worker_id).toBeNull()
    expect(still.attempts).toBe(0)
  })

  it('concurrent claimers take a single row via FOR UPDATE SKIP LOCKED', async () => {
    expect(jobs.CLAIM_SQL).toMatch(/FOR UPDATE SKIP LOCKED/)
    const org = orgId('concurrent')
    const kind = uniqueKind()
    const row = await insertJob({ org, kind, occurrenceKey: `export:${randomUUID()}` })
    jobs.registerJobHandler(kind, async () => {})

    const left = await pool.connect()
    const right = await pool.connect()
    try {
      const [first, second] = await Promise.all([
        jobs.claimDueJobs(pluginDb(left), { workerId: 'worker-left', batchSize: 8, maxAttempts: 8 }),
        jobs.claimDueJobs(pluginDb(right), { workerId: 'worker-right', batchSize: 8, maxAttempts: 8 }),
      ])
      expect(first.length + second.length).toBe(1)
      const winner = first[0] ?? second[0]
      expect(winner.id).toBe(row.id)
      expect(winner.status).toBe('running')
      expect(winner.attempts).toBe(1)
      expect(['worker-left', 'worker-right']).toContain(winner.claim_worker_id)

      const held = await readJob(row.id)
      expect(held.status).toBe('running')
      expect(held.claim_worker_id).toBe(winner.claim_worker_id)
      expect(held.lease_until).not.toBeNull()
    } finally {
      left.release()
      right.release()
    }
  })

  it('SKIP LOCKED skips a held due row then claims it after release', async () => {
    const org = orgId('skiplock')
    const kind = uniqueKind()
    const row = await insertJob({ org, kind, occurrenceKey: `retention:${randomUUID()}` })
    jobs.registerJobHandler(kind, async () => {})
    const locker = await pool.connect()
    const claimer = await pool.connect()
    try {
      await locker.query('BEGIN')
      const locked = await locker.query(
        'SELECT id FROM elearning_jobs WHERE id = $1::uuid FOR UPDATE',
        [row.id],
      )
      expect(locked.rowCount).toBe(1)

      await claimer.query(`SET lock_timeout = '${LOCK_TIMEOUT_MS}ms'`)
      const started = Date.now()
      const skipped = await jobs.claimDueJobs(pluginDb(claimer), {
        workerId: 'worker-skip',
        batchSize: 8,
        maxAttempts: 8,
      })
      expect(Date.now() - started).toBeLessThan(SKIP_LOCKED_BUDGET_MS)
      expect(skipped).toEqual([])
      await locker.query('COMMIT')

      const claimed = await jobs.claimDueJobs(pluginDb(claimer), {
        workerId: 'worker-skip',
        batchSize: 8,
        maxAttempts: 8,
      })
      expect(claimed).toHaveLength(1)
      expect(claimed[0].id).toBe(row.id)
      expect(claimed[0].claim_worker_id).toBe('worker-skip')
    } finally {
      try {
        await locker.query('ROLLBACK')
      } catch {
        /* already committed or closed */
      }
      locker.release()
      claimer.release()
    }
  })

  it('permits expired-lease reclaim by another worker when attempts remain', async () => {
    const org = orgId('reclaim')
    const kind = uniqueKind()
    const row = await insertJob({ org, kind, occurrenceKey: `scope:${randomUUID()}:week:2026-W34` })
    jobs.registerJobHandler(kind, async () => {})
    const first = await jobs.claimDueJobs(pluginDb(pool), {
      workerId: 'worker-a',
      batchSize: 8,
      leaseMs: 60_000,
      maxAttempts: 8,
    })
    expect(first).toHaveLength(1)
    await expireLease(row.id)
    const second = await jobs.claimDueJobs(pluginDb(pool), {
      workerId: 'worker-b',
      batchSize: 8,
      leaseMs: 60_000,
      maxAttempts: 8,
    })
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe(row.id)
    expect(second[0].claim_worker_id).toBe('worker-b')
    expect(second[0].attempts).toBe(2)
    const held = await readJob(row.id)
    expect(held.claim_worker_id).toBe('worker-b')
    expect(held.attempts).toBe(2)
    expect(held.status).toBe('running')
  })

  it('dead-letters due pending, failed, and expired-running rows at the attempts ceiling', async () => {
    const org = orgId('ceiling')
    const pendingKind = uniqueKind()
    const failedKind = uniqueKind()
    const runningKind = uniqueKind()
    const runs: string[] = []
    for (const kind of [pendingKind, failedKind, runningKind]) {
      jobs.registerJobHandler(kind, async () => {
        runs.push(kind)
      })
    }

    const pendingRow = await insertJob({
      org,
      kind: pendingKind,
      occurrenceKey: `pending:${randomUUID()}`,
      status: 'pending',
      attempts: 2,
    })
    const failedRow = await insertJob({
      org,
      kind: failedKind,
      occurrenceKey: `failed:${randomUUID()}`,
      status: 'failed',
      attempts: 2,
      lastError: 'HANDLER_FAILED',
    })
    const runningRow = await insertJob({
      org,
      kind: runningKind,
      occurrenceKey: `running:${randomUUID()}`,
      status: 'pending',
      attempts: 1,
    })
    const claimedRunning = await jobs.claimDueJobs(pluginDb(pool), {
      workerId: 'worker-seed',
      kinds: [runningKind],
      batchSize: 8,
      leaseMs: 60_000,
      maxAttempts: 8,
    })
    expect(claimedRunning).toHaveLength(1)
    expect(claimedRunning[0].id).toBe(runningRow.id)
    expect(claimedRunning[0].attempts).toBe(2)
    expect(claimedRunning[0].status).toBe('running')
    await expireLease(runningRow.id)

    const exhausted = await jobs.claimDueJobs(pluginDb(pool), {
      workerId: 'worker-ceiling',
      batchSize: 8,
      leaseMs: 60_000,
      maxAttempts: 2,
    })
    expect(exhausted).toEqual([])

    for (const id of [pendingRow.id, failedRow.id, runningRow.id]) {
      const dead = await readJob(id)
      expect(dead.status).toBe('dead')
      expect(dead.last_error).toBe(jobs.ATTEMPTS_EXHAUSTED)
      expect(dead.claim_worker_id).toBeNull()
      expect(dead.lease_until).toBeNull()
    }

    const again = await jobs.claimDueJobs(pluginDb(pool), {
      workerId: 'worker-again',
      batchSize: 8,
      leaseMs: 60_000,
      maxAttempts: 8,
    })
    expect(again).toEqual([])

    const tick = await jobs.runJobsTick({
      database: pluginDb(pool),
      workerId: 'worker-tick',
      maxAttempts: 8,
    })
    expect(tick.claimed).toBe(0)
    expect(runs).toEqual([])
  })

  it('refuses finalize from the wrong worker while the lease is live', async () => {
    const org = orgId('fence')
    const kind = uniqueKind()
    const row = await insertJob({ org, kind, occurrenceKey: `assignment:${randomUUID()}` })
    jobs.registerJobHandler(kind, async () => {})
    const claimed = await jobs.claimDueJobs(pluginDb(pool), {
      workerId: 'worker-owner',
      batchSize: 8,
      leaseMs: 60_000,
      maxAttempts: 8,
    })
    expect(claimed).toHaveLength(1)

    const claimAttempt = Number(claimed[0].attempts)
    expect(claimAttempt).toBe(1)
    const wrongSuccess = await jobs.finalizeJobSuccess(pluginDb(pool), {
      jobId: row.id,
      workerId: 'worker-other',
      claimAttempt,
    })
    expect(wrongSuccess).toBe(false)
    const wrongFailure = await jobs.finalizeJobFailure(pluginDb(pool), {
      jobId: row.id,
      workerId: 'worker-other',
      claimAttempt,
      code: 'HANDLER_FAILED',
    })
    expect(wrongFailure).toBe(false)

    const still = await readJob(row.id)
    expect(still.status).toBe('running')
    expect(still.claim_worker_id).toBe('worker-owner')
    expect(still.last_error).toBeNull()

    const ok = await jobs.finalizeJobSuccess(pluginDb(pool), {
      jobId: row.id,
      workerId: 'worker-owner',
      claimAttempt,
    })
    expect(ok).toBe(true)
    const done = await readJob(row.id)
    expect(done.status).toBe('succeeded')
    expect(done.claim_worker_id).toBeNull()
    expect(done.lease_until).toBeNull()
  })

  it('lease-expired finalize is refused and the next claim re-runs at-least-once', async () => {
    const org = orgId('once')
    const kind = uniqueKind()
    const row = await insertJob({ org, kind, occurrenceKey: `retention:${randomUUID()}` })
    jobs.registerJobHandler(kind, async () => {})

    const first = await jobs.claimDueJobs(pluginDb(pool), {
      workerId: 'worker-a',
      batchSize: 8,
      leaseMs: 60_000,
      maxAttempts: 8,
    })
    expect(first).toHaveLength(1)
    expect(first[0].claim_worker_id).toBe('worker-a')
    expect(first[0].attempts).toBe(1)

    await expireLease(row.id)

    const lateSuccess = await jobs.finalizeJobSuccess(pluginDb(pool), {
      jobId: row.id,
      workerId: 'worker-a',
      claimAttempt: 1,
    })
    expect(lateSuccess).toBe(false)
    const lateFailure = await jobs.finalizeJobFailure(pluginDb(pool), {
      jobId: row.id,
      workerId: 'worker-a',
      claimAttempt: 1,
      code: 'HANDLER_FAILED',
    })
    expect(lateFailure).toBe(false)
    const stillRunning = await readJob(row.id)
    expect(stillRunning.status).toBe('running')
    expect(stillRunning.claim_worker_id).toBe('worker-a')

    const second = await jobs.claimDueJobs(pluginDb(pool), {
      workerId: 'worker-b',
      batchSize: 8,
      leaseMs: 60_000,
      maxAttempts: 8,
    })
    expect(second).toHaveLength(1)
    expect(second[0].id).toBe(row.id)
    expect(second[0].claim_worker_id).toBe('worker-b')
    expect(second[0].attempts).toBe(2)

    const ok = await jobs.finalizeJobSuccess(pluginDb(pool), {
      jobId: row.id,
      workerId: 'worker-b',
      claimAttempt: 2,
    })
    expect(ok).toBe(true)
    const done = await readJob(row.id)
    expect(done.status).toBe('succeeded')
    expect(done.attempts).toBe(2)
    expect(done.claim_worker_id).toBeNull()
    expect(done.lease_until).toBeNull()
  })

  it('refuses stale attempt finalization after the same worker reclaims', async () => {
    expect(jobs.FINALIZE_SUCCESS_SQL).toMatch(/attempts = \$3::int/)
    expect(jobs.FINALIZE_FAILURE_SQL).toMatch(/attempts = \$3::int/)
    const org = orgId('stale-attempt')
    const kind = uniqueKind()
    const row = await insertJob({ org, kind, occurrenceKey: `stale:${randomUUID()}` })
    jobs.registerJobHandler(kind, async () => {})

    const first = await jobs.claimDueJobs(pluginDb(pool), {
      workerId: 'worker-same',
      batchSize: 8,
      leaseMs: 60_000,
      maxAttempts: 8,
    })
    expect(first).toHaveLength(1)
    expect(first[0].attempts).toBe(1)
    await expireLease(row.id)

    const second = await jobs.claimDueJobs(pluginDb(pool), {
      workerId: 'worker-same',
      batchSize: 8,
      leaseMs: 60_000,
      maxAttempts: 8,
    })
    expect(second).toHaveLength(1)
    expect(second[0].attempts).toBe(2)
    expect(second[0].claim_worker_id).toBe('worker-same')

    const staleSuccess = await jobs.finalizeJobSuccess(pluginDb(pool), {
      jobId: row.id,
      workerId: 'worker-same',
      claimAttempt: 1,
    })
    expect(staleSuccess).toBe(false)
    const staleFailure = await jobs.finalizeJobFailure(pluginDb(pool), {
      jobId: row.id,
      workerId: 'worker-same',
      claimAttempt: 1,
      code: 'HANDLER_FAILED',
    })
    expect(staleFailure).toBe(false)
    const still = await readJob(row.id)
    expect(still.status).toBe('running')
    expect(still.attempts).toBe(2)
    expect(still.claim_worker_id).toBe('worker-same')

    const ok = await jobs.finalizeJobSuccess(pluginDb(pool), {
      jobId: row.id,
      workerId: 'worker-same',
      claimAttempt: 2,
    })
    expect(ok).toBe(true)
    const done = await readJob(row.id)
    expect(done.status).toBe('succeeded')
    expect(done.attempts).toBe(2)
    expect(done.claim_worker_id).toBeNull()
  })
})
