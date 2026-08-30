import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  assertElearningStatsDailySchema,
  down as statsDailyDown,
  up as statsDailyUp,
} from '../../src/db/migrations/zzzz20260830190000_create_elearning_stats_daily'
import {
  projectElearningDepartmentStatsDaily,
  type ElearningStatsDailyDb,
  type ElearningStatsDailyQueryable,
} from '../../src/services/elearning-stats-daily-projection'
import {
  assertSafeScratchDatabaseName,
  attachOwnedPoolTerminationHandler,
  dropScratchDatabase,
  formatScratchDropFailure,
  formatScratchDropOutcome,
} from '../helpers/scratch-database'

const DATABASE_URL = process.env.DATABASE_URL
const scratchPrefix = 'ms2_elstatsdaily_'
const scratchName = `${scratchPrefix}${randomUUID().replaceAll('-', '').slice(0, 12)}`
const ENABLED = {
  ELEARNING_ANALYTICS_ENABLED: 'true',
  ELEARNING_ENABLED: 'true',
} as NodeJS.ProcessEnv

let adminPool: Pool | undefined
let firstPool: Pool | undefined
let secondPool: Pool | undefined
let database: Kysely<unknown> | undefined

function scratchUrl(base: string, name: string): string {
  const url = new URL(base)
  url.pathname = `/${name}`
  return url.toString()
}

function projectorDb(
  pool: Pool,
  beforeQuery?: (text: string) => Promise<void>,
): ElearningStatsDailyDb {
  return {
    async query(text, params) {
      await beforeQuery?.(text)
      const result = await pool.query(text, params)
      return {
        rowCount: result.rowCount,
        rows: result.rows as Array<Record<string, unknown>>,
      }
    },
    async transaction<T>(run: (tx: ElearningStatsDailyQueryable) => Promise<T>) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await run({
          async query(text, params) {
            await beforeQuery?.(text)
            const queryResult = await client.query(text, params)
            return {
              rowCount: queryResult.rowCount,
              rows: queryResult.rows as Array<Record<string, unknown>>,
            }
          },
        })
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
  }
}

function twoPartyTimedBarrier(marker: string, timeoutMs = 100): (text: string) => Promise<void> {
  let arrivals = 0
  let release: (() => void) | undefined
  const bothArrived = new Promise<void>((resolve) => { release = resolve })
  return async (text) => {
    if (!text.includes(marker)) return
    arrivals += 1
    if (arrivals === 2) release?.()
    await Promise.race([
      bothArrived,
      new Promise<void>((resolve) => { setTimeout(resolve, timeoutMs) }),
    ])
  }
}

async function migrate(action: (db: Kysely<unknown>) => Promise<void>): Promise<void> {
  if (!database) throw new Error('database unavailable')
  await database.transaction().execute(async (tx) => action(tx))
}

async function createPrerequisites(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE directory_integrations (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      provider text NOT NULL,
      status text NOT NULL,
      CONSTRAINT uq_directory_integrations_id_org UNIQUE (id, org_id)
    );
    CREATE TABLE directory_departments (
      id uuid PRIMARY KEY,
      integration_id uuid NOT NULL,
      provider text NOT NULL,
      is_active boolean NOT NULL,
      CONSTRAINT uq_directory_departments_id_integration_provider
        UNIQUE (id, integration_id, provider)
    );
    CREATE TABLE directory_accounts (
      id uuid PRIMARY KEY,
      integration_id uuid NOT NULL,
      is_active boolean NOT NULL
    );
    CREATE TABLE directory_account_departments (
      directory_account_id uuid NOT NULL,
      directory_department_id uuid NOT NULL,
      PRIMARY KEY (directory_account_id, directory_department_id)
    );
    CREATE TABLE users (
      id text PRIMARY KEY,
      is_active boolean NOT NULL
    );
    CREATE TABLE user_orgs (
      user_id text NOT NULL,
      org_id text NOT NULL,
      is_active boolean NOT NULL,
      PRIMARY KEY (user_id, org_id)
    );
    CREATE TABLE directory_account_links (
      directory_account_id uuid PRIMARY KEY,
      local_user_id text,
      link_status text NOT NULL
    );
    CREATE TABLE elearning_assignments (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      course_version_id uuid NOT NULL,
      deadline timestamptz NOT NULL
    );
    CREATE TABLE elearning_assignment_members (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      user_id text NOT NULL,
      assignment_id uuid NOT NULL,
      course_version_id uuid NOT NULL,
      assigned_at timestamptz NOT NULL,
      revoked_at timestamptz
    );
    CREATE TABLE elearning_course_version_items (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      course_version_id uuid NOT NULL,
      item_type text NOT NULL
    );
    CREATE TABLE elearning_completion_evidence (
      org_id text NOT NULL,
      user_id text NOT NULL,
      course_version_id uuid NOT NULL,
      course_version_item_id uuid NOT NULL,
      item_type text NOT NULL,
      completed_at timestamptz NOT NULL,
      effective_ms bigint
    );
    CREATE TABLE elearning_exam_attempts (
      org_id text NOT NULL,
      user_id text NOT NULL,
      course_version_id uuid NOT NULL,
      course_version_item_id uuid NOT NULL,
      status text NOT NULL,
      passed boolean,
      graded_at timestamptz,
      started_at timestamptz NOT NULL
    );
    CREATE TABLE elearning_credit_decisions (
      org_id text NOT NULL,
      user_id text NOT NULL,
      awarded_points integer NOT NULL,
      occurred_at timestamptz NOT NULL
    );
    CREATE TABLE elearning_credit_adjustments (
      org_id text NOT NULL,
      user_id text NOT NULL,
      points integer NOT NULL,
      created_at timestamptz NOT NULL
    )
  `)
}

async function seedDepartment(
  pool: Pool,
  options: { memberCount: number; orgId: string },
): Promise<{ departmentId: string; integrationId: string; userIds: string[] }> {
  const integrationId = randomUUID()
  const departmentId = randomUUID()
  await pool.query(
    `INSERT INTO directory_integrations (id, org_id, provider, status)
     VALUES ($1, $2, 'dingtalk', 'active')`,
    [integrationId, options.orgId],
  )
  await pool.query(
    `INSERT INTO directory_departments (id, integration_id, provider, is_active)
     VALUES ($1, $2, 'dingtalk', true)`,
    [departmentId, integrationId],
  )
  const userIds: string[] = []
  for (let index = 0; index < options.memberCount; index += 1) {
    const accountId = randomUUID()
    const userId = `stats-user-${randomUUID()}`
    userIds.push(userId)
    await pool.query(
      'INSERT INTO users (id, is_active) VALUES ($1, true)',
      [userId],
    )
    await pool.query(
      'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)',
      [userId, options.orgId],
    )
    await pool.query(
      `INSERT INTO directory_accounts (id, integration_id, is_active)
       VALUES ($1, $2, true)`,
      [accountId, integrationId],
    )
    await pool.query(
      `INSERT INTO directory_account_departments (
         directory_account_id, directory_department_id
       ) VALUES ($1, $2)`,
      [accountId, departmentId],
    )
    await pool.query(
      `INSERT INTO directory_account_links (
         directory_account_id, local_user_id, link_status
       ) VALUES ($1, $2, 'linked')`,
      [accountId, userId],
    )
  }
  return { departmentId, integrationId, userIds }
}

async function mutateConstraint(
  client: Pool | PoolClient,
  name: string,
  definition: string,
): Promise<void> {
  await client.query(
    `ALTER TABLE elearning_stats_daily DROP CONSTRAINT ${name};
     ALTER TABLE elearning_stats_daily ADD CONSTRAINT ${name} ${definition}`,
  )
}

beforeAll(async () => {
  if (!DATABASE_URL) {
    throw new Error(
      'e-learning stats daily authority requires DATABASE_URL; refusing skip-shaped green',
    )
  }
  assertSafeScratchDatabaseName(scratchName)
  adminPool = new Pool({
    application_name: 'elearning-stats-daily-admin',
    connectionString: DATABASE_URL,
    max: 1,
  })
  const residue = await adminPool.query(
    'SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname',
    [`${scratchPrefix}%`],
  )
  if (residue.rows.length !== 0) throw new Error('scratch database prefix residue detected')
  await adminPool.query(`CREATE DATABASE "${scratchName}"`)
  const connectionString = scratchUrl(DATABASE_URL, scratchName)
  firstPool = new Pool({
    application_name: 'elearning-stats-daily-first',
    connectionString,
    max: 3,
  })
  secondPool = new Pool({
    application_name: 'elearning-stats-daily-second',
    connectionString,
    max: 3,
  })
  await createPrerequisites(firstPool)
  database = new Kysely({ dialect: new PostgresDialect({ pool: firstPool }) })
  await migrate(statsDailyUp)
}, 30_000)

afterAll(async () => {
  const firstTermination = firstPool
    ? attachOwnedPoolTerminationHandler(firstPool)
    : null
  const secondTermination = secondPool
    ? attachOwnedPoolTerminationHandler(secondPool)
    : null
  try {
    if (database) await database.destroy()
    if (secondPool) await secondPool.end()
    if (adminPool) {
      try {
        const outcome = await dropScratchDatabase(adminPool, scratchName)
        console.info(formatScratchDropOutcome('elearning-stats-daily', outcome))
        if (!outcome.drained || outcome.residualBackends !== 0) {
          throw new Error('scratch database did not drain cleanly')
        }
      } catch (error) {
        console.error(formatScratchDropFailure('elearning-stats-daily', error))
        throw error
      }
      const [backends, residue] = await Promise.all([
        adminPool.query(
          'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1',
          [scratchName],
        ),
        adminPool.query(
          'SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname',
          [`${scratchPrefix}%`],
        ),
      ])
      if (backends.rows[0]?.count !== 0) {
        throw new Error('scratch database backend residue detected')
      }
      if (residue.rows.length !== 0) throw new Error('scratch database prefix residue remains')
    }
  } finally {
    firstTermination?.detach()
    secondTermination?.detach()
    if (adminPool) await adminPool.end()
  }
}, 30_000)

describe('e-learning stats daily PostgreSQL authority', () => {
  it('applies, replays, rejects semantic drift, rolls down and reapplies', async () => {
    if (!firstPool || !database) throw new Error('database unavailable')
    await migrate(statsDailyUp)
    await assertElearningStatsDailySchema(database)

    await mutateConstraint(
      firstPool,
      'elearning_stats_daily_threshold_chk',
      'CHECK (min_group_size >= 4)',
    )
    await expect(migrate(statsDailyUp)).rejects.toThrow(
      'elearning stats daily migration drift: check constraint set',
    )
    await mutateConstraint(
      firstPool,
      'elearning_stats_daily_threshold_chk',
      'CHECK (min_group_size >= 5)',
    )
    await migrate(statsDailyUp)

    await firstPool.query(
      'ALTER TABLE elearning_stats_daily ALTER COLUMN suppressed DROP NOT NULL',
    )
    await expect(migrate(statsDailyUp)).rejects.toThrow(
      'elearning stats daily migration drift: column set',
    )
    await firstPool.query(
      'ALTER TABLE elearning_stats_daily ALTER COLUMN suppressed SET NOT NULL',
    )
    await migrate(statsDailyUp)

    await migrate(statsDailyDown)
    await migrate(statsDailyDown)
    expect(await firstPool.query(
      `SELECT to_regclass('elearning_stats_daily') AS table_name`,
    ).then((result) => result.rows)).toEqual([{ table_name: null }])
    await migrate(statsDailyUp)
  })

  it('serializes two connections and advances only when materialized content changes', async () => {
    if (!firstPool || !secondPool) throw new Error('database unavailable')
    const orgId = `org-stats-visible-${randomUUID()}`
    const seeded = await seedDepartment(firstPool, { memberCount: 5, orgId })
    const input = {
      departmentId: seeded.departmentId,
      orgId,
      statsDate: '2026-08-30',
    }
    const upsertBarrier = twoPartyTimedBarrier('elearning-stats-daily:upsert')
    const results = await Promise.all([
      projectElearningDepartmentStatsDaily(
        projectorDb(firstPool, upsertBarrier),
        input,
        ENABLED,
      ),
      projectElearningDepartmentStatsDaily(
        projectorDb(secondPool, upsertBarrier),
        input,
        ENABLED,
      ),
    ])
    expect(results.map((result) => result.outcome).sort()).toEqual(['noop', 'projected'])
    expect(results.every((result) => result.projectedVersion === 1)).toBe(true)

    const initial = await firstPool.query(
      `SELECT suppressed, projected_version::text, source_version,
              assigned_count::text, credit_total::text, member_count::text
         FROM elearning_stats_daily
        WHERE org_id = $1 AND department_id = $2`,
      [orgId, seeded.departmentId],
    )
    expect(initial.rows).toEqual([{
      assigned_count: '0',
      credit_total: '0',
      member_count: '5',
      projected_version: '1',
      source_version: expect.any(String),
      suppressed: false,
    }])

    await firstPool.query(
      `INSERT INTO elearning_credit_decisions (
         org_id, user_id, awarded_points, occurred_at
       ) VALUES ($1, $2, 7, '2026-08-30T12:00:00.000Z')`,
      [orgId, seeded.userIds[0]],
    )
    await expect(
      projectElearningDepartmentStatsDaily(projectorDb(firstPool), input, ENABLED),
    ).resolves.toEqual({
      outcome: 'projected',
      projectedVersion: 2,
      suppressed: false,
    })
    expect(await firstPool.query(
      `SELECT projected_version::text, credit_total::text
         FROM elearning_stats_daily
        WHERE org_id = $1 AND department_id = $2`,
      [orgId, seeded.departmentId],
    ).then((result) => result.rows)).toEqual([{
      credit_total: '7',
      projected_version: '2',
    }])
  })

  it('stores no numeric payload below five and database checks reject leakage', async () => {
    if (!firstPool) throw new Error('database unavailable')
    const orgId = `org-stats-suppressed-${randomUUID()}`
    const seeded = await seedDepartment(firstPool, { memberCount: 4, orgId })
    await projectElearningDepartmentStatsDaily(projectorDb(firstPool), {
      departmentId: seeded.departmentId,
      orgId,
      statsDate: '2026-08-30',
    }, ENABLED)
    const row = await firstPool.query(
      `SELECT suppressed, assigned_count, completed_count, completion_rate,
              credit_average, credit_total, exam_participant_count, learner_count,
              learning_seconds, member_count, overdue_count
         FROM elearning_stats_daily
        WHERE org_id = $1 AND department_id = $2`,
      [orgId, seeded.departmentId],
    )
    expect(row.rows).toEqual([{
      assigned_count: null,
      completed_count: null,
      completion_rate: null,
      credit_average: null,
      credit_total: null,
      exam_participant_count: null,
      learner_count: null,
      learning_seconds: null,
      member_count: null,
      overdue_count: null,
      suppressed: true,
    }])
    await expect(firstPool.query(
      `UPDATE elearning_stats_daily SET member_count = 4
        WHERE org_id = $1 AND department_id = $2`,
      [orgId, seeded.departmentId],
    )).rejects.toMatchObject({ code: '23514' })
  })

  it('enforces same-org directory identity and one row per daily dataset key', async () => {
    if (!firstPool) throw new Error('database unavailable')
    const firstOrg = `org-stats-first-${randomUUID()}`
    const secondOrg = `org-stats-second-${randomUUID()}`
    const first = await seedDepartment(firstPool, { memberCount: 0, orgId: firstOrg })
    const second = await seedDepartment(firstPool, { memberCount: 0, orgId: secondOrg })
    const params = [
      firstOrg,
      second.integrationId,
      second.departmentId,
      '0'.repeat(64),
    ]
    await expect(firstPool.query(
      `INSERT INTO elearning_stats_daily (
         org_id, directory_integration_id, directory_provider, department_id,
         dataset, stats_date, period_start, period_end, source_version,
         payload_digest, suppressed, min_group_size
       ) VALUES (
         $1, $2, 'dingtalk', $3, 'department_overview', '2026-08-30',
         '2026-08-30T00:00:00.000Z', '2026-08-31T00:00:00.000Z',
         'source-cross-org', $4, true, 5
       )`,
      params,
    )).rejects.toMatchObject({ code: '23503' })

    await projectElearningDepartmentStatsDaily(projectorDb(firstPool), {
      departmentId: first.departmentId,
      orgId: firstOrg,
      statsDate: '2026-08-30',
    }, ENABLED)
    await expect(firstPool.query(
      `INSERT INTO elearning_stats_daily (
         org_id, directory_integration_id, directory_provider, department_id,
         dataset, stats_date, period_start, period_end, source_version,
         payload_digest, suppressed, min_group_size
       ) SELECT org_id, directory_integration_id, directory_provider, department_id,
                dataset, stats_date, period_start, period_end, source_version,
                payload_digest, suppressed, min_group_size
           FROM elearning_stats_daily
          WHERE org_id = $1 AND department_id = $2`,
      [firstOrg, first.departmentId],
    )).rejects.toMatchObject({ code: '23505' })
  })
})
