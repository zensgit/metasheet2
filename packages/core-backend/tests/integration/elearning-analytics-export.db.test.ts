import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  up as jobsUp,
} from '../../src/db/migrations/zzzz20260826160000_create_elearning_jobs'
import {
  down as exportDown,
  up as exportUp,
} from '../../src/db/migrations/zzzz20260831090000_create_elearning_export_jobs'
import {
  cleanupElearningAnalyticsExport,
  createElearningAnalyticsExport,
  downloadElearningAnalyticsExport,
  getElearningAnalyticsExport,
  materializeElearningAnalyticsExport,
  type ElearningAnalyticsExportDb,
  type ElearningAnalyticsExportQueryable,
} from '../../src/services/elearning-analytics-export'
import type { ElearningAnalyticsExportStorage } from '../../src/services/elearning-analytics-export-storage'
import {
  assertSafeScratchDatabaseName,
  attachOwnedPoolTerminationHandler,
  dropScratchDatabase,
  formatScratchDropFailure,
  formatScratchDropOutcome,
} from '../helpers/scratch-database'

const DATABASE_URL = process.env.DATABASE_URL
const scratchPrefix = 'ms2_elexport_'
const scratchName = `${scratchPrefix}${randomUUID().replaceAll('-', '').slice(0, 12)}`
const FLAGS = { ELEARNING_ENABLED: 'true', ELEARNING_ANALYTICS_ENABLED: 'true' }
const ORG = `export-org-${randomUUID()}`
const ACTOR = `export-actor-${randomUUID()}`
const OTHER_ACTOR = `export-other-actor-${randomUUID()}`
const INTEGRATION = randomUUID()
const DEPARTMENT = randomUUID()
const PERIOD_START = '2026-08-01T00:00:00.000Z'
const PERIOD_END = '2026-09-01T00:00:00.000Z'

let adminPool: Pool
let firstPool: Pool
let secondPool: Pool
let database: Kysely<unknown>

function scratchUrl(base: string, name: string): string {
  const url = new URL(base)
  url.pathname = `/${name}`
  return url.toString()
}

async function query(
  target: Pool | PoolClient,
  text: string,
  params?: unknown[],
): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> {
  const value = await target.query(text, params as never)
  return { rows: value.rows as Array<Record<string, unknown>>, rowCount: value.rowCount }
}

function exportDb(pool: Pool): ElearningAnalyticsExportDb {
  return {
    query: (text, params) => query(pool, text, params),
    async transaction<T>(run: (tx: ElearningAnalyticsExportQueryable) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const value = await run({ query: (text, params) => query(client, text, params) })
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
  }
}

async function migrate(action: (db: Kysely<unknown>) => Promise<void>): Promise<void> {
  await database.transaction().execute((tx) => action(tx))
}

function memoryStorage(): ElearningAnalyticsExportStorage & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>()
  return {
    objects,
    async put(key, content) {
      if (objects.has(key)) throw new Error('exclusive create conflict')
      objects.set(key, Buffer.from(content))
    },
    async get(key) {
      const value = objects.get(key)
      if (!value) throw new Error('missing')
      return Buffer.from(value)
    },
    async delete(key) {
      objects.delete(key)
    },
  }
}

async function createPrerequisites(): Promise<void> {
  await firstPool.query(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE user_orgs (
      user_id text NOT NULL,
      org_id text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      PRIMARY KEY (user_id, org_id)
    );
    CREATE TABLE directory_integrations (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      provider text NOT NULL,
      status text NOT NULL,
      UNIQUE (id, org_id),
      UNIQUE (id, provider)
    );
    CREATE TABLE directory_departments (
      id uuid PRIMARY KEY,
      integration_id uuid NOT NULL,
      provider text NOT NULL,
      external_department_id text NOT NULL,
      external_parent_department_id text,
      is_active boolean NOT NULL DEFAULT true,
      UNIQUE (id, integration_id, provider)
    );
    CREATE TABLE elearning_admin_scopes (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      user_id text NOT NULL,
      directory_integration_id uuid NOT NULL,
      directory_provider text NOT NULL,
      directory_department_id uuid NOT NULL,
      include_children boolean NOT NULL,
      revoked_at timestamptz
    );
    CREATE TABLE elearning_stats_daily (
      org_id text NOT NULL,
      dataset text NOT NULL,
      department_id uuid NOT NULL,
      stats_date date NOT NULL,
      period_start timestamptz NOT NULL,
      period_end timestamptz NOT NULL,
      source_version text NOT NULL,
      suppressed boolean NOT NULL,
      min_group_size integer NOT NULL,
      assigned_count bigint,
      completed_count bigint,
      completion_rate numeric,
      credit_average numeric,
      credit_total bigint,
      exam_participant_count bigint,
      learner_count bigint,
      learning_seconds bigint,
      member_count bigint,
      overdue_count bigint,
      PRIMARY KEY (org_id, dataset, department_id, stats_date)
    )
  `)
  await firstPool.query(
    `INSERT INTO users (id, is_active) VALUES ($1, true)`,
    [ACTOR],
  )
  await firstPool.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)`,
    [ACTOR, ORG],
  )
  await firstPool.query(
    `INSERT INTO directory_integrations (id, org_id, provider, status)
     VALUES ($1, $2, 'local', 'active')`,
    [INTEGRATION, ORG],
  )
  await firstPool.query(
    `INSERT INTO directory_departments (
       id, integration_id, provider, external_department_id,
       external_parent_department_id, is_active
     ) VALUES ($1, $2, 'local', 'root', NULL, true)`,
    [DEPARTMENT, INTEGRATION],
  )
  await firstPool.query(
    `INSERT INTO elearning_admin_scopes (
       id, org_id, user_id, directory_integration_id, directory_provider,
       directory_department_id, include_children, revoked_at
     ) VALUES ($1, $2, $3, $4, 'local', $5, false, NULL)`,
    [randomUUID(), ORG, ACTOR, INTEGRATION, DEPARTMENT],
  )
}

function command(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    actorId: ACTOR,
    isGlobalAdmin: false,
    requestId,
    departmentId: DEPARTMENT,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    ...overrides,
  }
}

describe.sequential('e-learning analytics export PostgreSQL authority', () => {
  beforeAll(async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required; refusing skip-shaped green')
    assertSafeScratchDatabaseName(scratchName)
    adminPool = new Pool({
      application_name: 'elearning-export-admin',
      connectionString: DATABASE_URL,
      max: 1,
    })
    const residue = await adminPool.query(
      'SELECT datname FROM pg_database WHERE datname LIKE $1',
      [`${scratchPrefix}%`],
    )
    if (residue.rows.length !== 0) throw new Error('scratch database prefix residue detected')
    await adminPool.query(`CREATE DATABASE "${scratchName}"`)
    const url = scratchUrl(DATABASE_URL, scratchName)
    firstPool = new Pool({ application_name: 'elearning-export-first', connectionString: url, max: 5 })
    secondPool = new Pool({ application_name: 'elearning-export-second', connectionString: url, max: 5 })
    database = new Kysely({ dialect: new PostgresDialect({ pool: firstPool }) })
    await createPrerequisites()
    await migrate(jobsUp)
    await migrate(exportUp)
  }, 30_000)

  afterAll(async () => {
    const firstTermination = firstPool ? attachOwnedPoolTerminationHandler(firstPool) : null
    const secondTermination = secondPool ? attachOwnedPoolTerminationHandler(secondPool) : null
    try {
      if (database) await database.destroy()
      if (secondPool) await secondPool.end()
      if (adminPool) {
        try {
          const outcome = await dropScratchDatabase(adminPool, scratchName)
          console.info(formatScratchDropOutcome('elearning-analytics-export', outcome))
          if (!outcome.drained || outcome.residualBackends !== 0) {
            throw new Error('export scratch database did not drain cleanly')
          }
        } catch (error) {
          console.error(formatScratchDropFailure('elearning-analytics-export', error))
          throw error
        }
        const exact = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [scratchName])
        const prefix = await adminPool.query(
          'SELECT datname FROM pg_database WHERE datname LIKE $1',
          [`${scratchPrefix}%`],
        )
        if (exact.rows.length !== 0 || prefix.rows.length !== 0) {
          throw new Error('export scratch database residue')
        }
      }
    } finally {
      firstTermination?.detach()
      secondTermination?.detach()
      if (adminPool) await adminPool.end()
    }
  }, 30_000)

  it('replays, detects column/function/trigger drift, and supports empty down/reapply', async () => {
    await migrate(exportUp)
    await firstPool.query('ALTER TABLE elearning_export_jobs ALTER COLUMN actor_id DROP NOT NULL')
    await expect(migrate(exportUp)).rejects.toThrow('elearning export migration drift: columns')
    await firstPool.query('ALTER TABLE elearning_export_jobs ALTER COLUMN actor_id SET NOT NULL')
    await migrate(exportUp)
    await firstPool.query(`
      ALTER TABLE elearning_export_jobs
        DROP CONSTRAINT elearning_export_jobs_request_hash_chk;
      ALTER TABLE elearning_export_jobs
        ADD CONSTRAINT elearning_export_jobs_request_hash_chk
        CHECK (request_hash <> '')
    `)
    await expect(migrate(exportUp)).rejects.toThrow('elearning export migration drift: constraints')
    await firstPool.query(`
      ALTER TABLE elearning_export_jobs
        DROP CONSTRAINT elearning_export_jobs_request_hash_chk;
      ALTER TABLE elearning_export_jobs
        ADD CONSTRAINT elearning_export_jobs_request_hash_chk
        CHECK (request_hash ~ '^[0-9a-f]{64}$')
    `)
    await migrate(exportUp)
    await firstPool.query('DROP INDEX elearning_export_jobs_request_uniq')
    await firstPool.query(`
      CREATE INDEX elearning_export_jobs_request_uniq
      ON elearning_export_jobs (org_id, actor_id, request_id)
    `)
    await expect(migrate(exportUp)).rejects.toThrow('elearning export migration drift: indexes')
    await firstPool.query('DROP INDEX elearning_export_jobs_request_uniq')
    await firstPool.query(`
      CREATE UNIQUE INDEX elearning_export_jobs_request_uniq
      ON elearning_export_jobs (org_id, actor_id, request_id)
    `)
    await migrate(exportUp)
    await firstPool.query(`
      CREATE OR REPLACE FUNCTION elearning_export_jobs_authority()
      RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$
    `)
    await expect(migrate(exportUp)).rejects.toThrow('elearning export migration drift: function')
    await migrate(exportDown)
    await migrate(exportDown)
    await migrate(exportUp)
    await firstPool.query(`
      CREATE SCHEMA export_shadow;
      CREATE FUNCTION export_shadow.elearning_export_jobs_authority()
      RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$;
      DROP TRIGGER trg_elearning_export_jobs_authority ON elearning_export_jobs;
      CREATE TRIGGER trg_elearning_export_jobs_authority
        BEFORE INSERT OR UPDATE OR DELETE ON elearning_export_jobs
        FOR EACH ROW EXECUTE FUNCTION export_shadow.elearning_export_jobs_authority()
    `)
    await expect(migrate(exportUp)).rejects.toThrow('elearning export migration drift: trigger')
    await firstPool.query(`
      DROP TRIGGER trg_elearning_export_jobs_authority ON elearning_export_jobs;
      CREATE TRIGGER trg_elearning_export_jobs_authority
        BEFORE INSERT OR UPDATE OR DELETE ON elearning_export_jobs
        FOR EACH ROW EXECUTE FUNCTION elearning_export_jobs_authority();
      DROP SCHEMA export_shadow CASCADE
    `)
    await migrate(exportUp)
  })

  it('serializes request replay, enqueues in the same commit, and rejects changed payloads', async () => {
    const requestId = randomUUID()
    const [left, right] = await Promise.all([
      createElearningAnalyticsExport(exportDb(firstPool), command(requestId), FLAGS),
      createElearningAnalyticsExport(exportDb(secondPool), command(requestId), FLAGS),
    ])
    expect(left.exportId).toBe(right.exportId)
    expect([left.duplicate, right.duplicate].sort()).toEqual([false, true])
    const rows = await firstPool.query(
      `SELECT request_hash, scope_snapshot, query_snapshot
       FROM elearning_export_jobs WHERE org_id = $1 AND id = $2`,
      [ORG, left.exportId],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.scope_snapshot).toMatchObject({
      departmentId: DEPARTMENT,
      kind: 'delegated',
    })
    const jobs = await firstPool.query(
      `SELECT kind, occurrence_key FROM elearning_jobs
       WHERE org_id = $1 AND ref = $2 ORDER BY kind`,
      [ORG, left.exportId],
    )
    expect(jobs.rows).toEqual([
      { kind: 'analytics_export', occurrence_key: `export:${left.exportId}` },
      { kind: 'analytics_export_cleanup', occurrence_key: `export:${left.exportId}:cleanup` },
    ])
    await expect(createElearningAnalyticsExport(exportDb(firstPool), command(requestId, {
      periodEnd: '2026-10-01T00:00:00.000Z',
    }), FLAGS)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('rolls back the export request when same-transaction enqueue fails', async () => {
    await firstPool.query(`
      CREATE FUNCTION elearning_export_test_reject_enqueue()
      RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.kind IN ('analytics_export', 'analytics_export_cleanup') THEN
          RAISE EXCEPTION 'export enqueue rejected';
        END IF;
        RETURN NEW;
      END
      $fn$;
      CREATE TRIGGER trg_elearning_export_test_reject_enqueue
        BEFORE INSERT ON elearning_jobs
        FOR EACH ROW EXECUTE FUNCTION elearning_export_test_reject_enqueue()
    `)
    const requestId = randomUUID()
    try {
      await expect(createElearningAnalyticsExport(
        exportDb(firstPool),
        command(requestId),
        FLAGS,
      )).rejects.toMatchObject({ code: 'unavailable' })
      expect((await firstPool.query(
        'SELECT 1 FROM elearning_export_jobs WHERE org_id = $1 AND request_id = $2',
        [ORG, requestId],
      )).rows).toHaveLength(0)
    } finally {
      await firstPool.query(`
        DROP TRIGGER trg_elearning_export_test_reject_enqueue ON elearning_jobs;
        DROP FUNCTION elearning_export_test_reject_enqueue()
      `)
    }
  })

  it('binds detail and download authority to the server-derived requesting actor', async () => {
    await firstPool.query(
      'INSERT INTO users (id, is_active) VALUES ($1, true)',
      [OTHER_ACTOR],
    )
    await firstPool.query(
      'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)',
      [OTHER_ACTOR, ORG],
    )
    const created = await createElearningAnalyticsExport(
      exportDb(firstPool),
      command(randomUUID()),
      FLAGS,
    )
    await expect(getElearningAnalyticsExport(exportDb(firstPool), {
      orgId: ORG,
      actorId: OTHER_ACTOR,
      isGlobalAdmin: true,
      exportId: created.exportId,
    }, FLAGS)).rejects.toMatchObject({ code: 'not_found' })
    await expect(downloadElearningAnalyticsExport(exportDb(firstPool), {
      orgId: ORG,
      actorId: OTHER_ACTOR,
      isGlobalAdmin: true,
      exportId: created.exportId,
    }, memoryStorage(), FLAGS)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('materializes aggregate-only CSV once, survives duplicate effects, and rechecks current scope', async () => {
    await firstPool.query(
      `INSERT INTO elearning_stats_daily (
         org_id, dataset, department_id, stats_date, period_start, period_end,
         source_version, suppressed, min_group_size, assigned_count, completed_count,
         completion_rate, credit_average, credit_total, exam_participant_count,
         learner_count, learning_seconds, member_count, overdue_count
       ) VALUES
         ($1, 'department_overview', $2, '2026-08-01', '2026-08-01T00:00:00Z',
          '2026-08-02T00:00:00Z', '=projection', true, 5,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
         ($1, 'department_overview', $2, '2026-08-02', '2026-08-02T00:00:00Z',
          '2026-08-03T00:00:00Z', 'projection-2', false, 5,
          4, 3, 0.75, 2.5, 10, 3, 4, 120, 5, 1)
       ON CONFLICT DO NOTHING`,
      [ORG, DEPARTMENT],
    )
    const created = await createElearningAnalyticsExport(
      exportDb(firstPool),
      command(randomUUID()),
      FLAGS,
    )
    const storage = memoryStorage()
    const outcomes = await Promise.all([
      materializeElearningAnalyticsExport(
        exportDb(firstPool), { orgId: ORG, exportId: created.exportId }, storage, FLAGS,
      ),
      materializeElearningAnalyticsExport(
        exportDb(secondPool), { orgId: ORG, exportId: created.exportId }, storage, FLAGS,
      ),
    ])
    expect(outcomes.map((item) => item.outcome).sort()).toEqual(['materialized', 'noop'])
    expect(storage.objects.size).toBe(1)
    const bytes = [...storage.objects.values()][0]!
    expect(bytes.toString('utf8')).toContain('"\'=projection"')
    expect(bytes.toString('utf8')).not.toMatch(/answer|trace|grade/i)
    const download = await downloadElearningAnalyticsExport(
      exportDb(firstPool),
      { orgId: ORG, actorId: ACTOR, isGlobalAdmin: false, exportId: created.exportId },
      storage,
      FLAGS,
    )
    expect(download.content).toEqual(bytes)

    await firstPool.query(
      `UPDATE elearning_admin_scopes SET revoked_at = now()
       WHERE org_id = $1 AND user_id = $2`,
      [ORG, ACTOR],
    )
    await expect(downloadElearningAnalyticsExport(
      exportDb(firstPool),
      { orgId: ORG, actorId: ACTOR, isGlobalAdmin: false, exportId: created.exportId },
      storage,
      FLAGS,
    )).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('records storage failure for retry and rejects destructive authority changes', async () => {
    const created = await createElearningAnalyticsExport(
      exportDb(firstPool),
      command(randomUUID(), { isGlobalAdmin: true }),
      FLAGS,
    )
    const unavailable: ElearningAnalyticsExportStorage = {
      async put() { throw new Error('unavailable') },
      async get() { throw new Error('unavailable') },
      async delete() { throw new Error('unavailable') },
    }
    await expect(materializeElearningAnalyticsExport(
      exportDb(firstPool), { orgId: ORG, exportId: created.exportId }, unavailable, FLAGS,
    )).rejects.toMatchObject({ code: 'unavailable' })
    expect((await firstPool.query(
      'SELECT status, error_code FROM elearning_export_jobs WHERE id = $1',
      [created.exportId],
    )).rows).toEqual([{ status: 'failed', error_code: 'STORAGE_UNAVAILABLE' }])
    await expect(firstPool.query(
      `UPDATE elearning_export_jobs SET actor_id = 'other' WHERE id = $1`,
      [created.exportId],
    )).rejects.toThrow()
    await expect(firstPool.query(
      'DELETE FROM elearning_export_jobs WHERE id = $1',
      [created.exportId],
    )).rejects.toThrow()
    await expect(firstPool.query('TRUNCATE elearning_export_jobs')).rejects.toThrow()
    await expect(migrate(exportDown)).rejects.toThrow(
      'elearning export down refused: authoritative rows exist',
    )
  })

  it('expires a due row only after retryable storage cleanup succeeds', async () => {
    const exportId = randomUUID()
    const requestId = randomUUID()
    const requestHash = 'a'.repeat(64)
    await firstPool.query(
      `INSERT INTO elearning_export_jobs (
         id, org_id, actor_id, request_id, request_hash, request_hash_version,
         directory_integration_id, directory_provider, department_id,
         period_start, period_end, scope_snapshot, query_snapshot,
         expires_at, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, 1, $6, 'local', $7,
         $8, $9, '{}'::jsonb, '{}'::jsonb,
         now() - interval '1 hour', now() - interval '8 days'
       )`,
      [exportId, ORG, ACTOR, requestId, requestHash, INTEGRATION, DEPARTMENT, PERIOD_START, PERIOD_END],
    )
    const storage = memoryStorage()
    await expect(cleanupElearningAnalyticsExport(
      exportDb(firstPool), { orgId: ORG, exportId }, storage, FLAGS,
    )).resolves.toEqual({ outcome: 'expired', exportId })
    expect((await firstPool.query(
      'SELECT status, expired_at IS NOT NULL AS expired FROM elearning_export_jobs WHERE id = $1',
      [exportId],
    )).rows).toEqual([{ status: 'expired', expired: true }])
  })
})
