import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  down,
  ELEARNING_ONBOARDING_DOWN_IN_USE,
  up,
} from '../../src/db/migrations/zzzz20260831120000_create_elearning_onboarding'
import {
  assertSafeScratchDatabaseName,
  attachOwnedPoolTerminationHandler,
  dropScratchDatabase,
  formatScratchDropFailure,
  formatScratchDropOutcome,
} from '../helpers/scratch-database'
import { enqueueDirectoryElearningOnboarding } from '../../src/directory/elearning-onboarding-lifecycle'
import { ElearningOnboardingAssignmentError } from '../../src/services/elearning-onboarding-assignment'

const DATABASE_URL = process.env.DATABASE_URL
const scratchPrefix = 'ms2_elonboard_'
const scratchName = `${scratchPrefix}${randomUUID().replaceAll('-', '').slice(0, 12)}`
const ORG = `org-${randomUUID()}`
const OTHER_ORG = `org-${randomUUID()}`
const ACTOR = `actor-${randomUUID()}`
const USER = `user-${randomUUID()}`
const PLAN = randomUUID()
const POLICY = randomUUID()
const PLAN_ASSIGNMENT = randomUUID()
const PLAN_SOURCE = 'onboarding-plan-source'
const DEPARTMENT = randomUUID()
const REQUEST = randomUUID()
const JOB_OCCURRENCE = `onboarding-assign-v1:${'d'.repeat(64)}`

let adminPool: Pool
let firstPool: Pool
let secondPool: Pool
let database: Kysely<unknown>

function scratchUrl(base: string, name: string): string {
  const url = new URL(base)
  url.pathname = `/${name}`
  return url.toString()
}

async function migrate(action: (db: Kysely<unknown>) => Promise<void>): Promise<void> {
  await database.transaction().execute((tx) => action(tx))
}

async function createPrerequisites(): Promise<void> {
  await firstPool.query(`
    CREATE TABLE user_orgs (
      user_id text NOT NULL,
      org_id text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      PRIMARY KEY (user_id, org_id)
    );
    CREATE TABLE users (
      id text PRIMARY KEY,
      hire_date date,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE elearning_training_plans (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      status text NOT NULL,
      UNIQUE (org_id, id)
    );
    CREATE TABLE elearning_training_plan_assignments (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      training_plan_id uuid NOT NULL,
      member_ids text[] NOT NULL,
      source_key text NOT NULL,
      UNIQUE (org_id, id)
    );
    CREATE TABLE elearning_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      kind text NOT NULL,
      occurrence_key text NOT NULL,
      ref text NOT NULL,
      payload jsonb NOT NULL,
      due_at timestamptz NOT NULL,
      status text NOT NULL,
      UNIQUE (org_id, kind, occurrence_key)
    );
  `)
  await firstPool.query(
    `INSERT INTO users (id, hire_date)
     VALUES ($1, DATE '2026-08-20'), ($2, NULL)`,
    [ACTOR, USER],
  )
  await firstPool.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active)
     VALUES ($1, $2, true), ($3, $2, true)`,
    [ACTOR, ORG, USER],
  )
  await firstPool.query(
    `INSERT INTO elearning_training_plans (id, org_id, status)
     VALUES ($1, $2, 'active')`,
    [PLAN, ORG],
  )
  await firstPool.query(
    `INSERT INTO elearning_training_plan_assignments (
       id, org_id, training_plan_id, member_ids, source_key
     ) VALUES ($1, $2, $3, $4::text[], $5)`,
    [PLAN_ASSIGNMENT, ORG, PLAN, [USER], PLAN_SOURCE],
  )
}

function rules() {
  return [{
    subjectType: 'department',
    subjectRef: DEPARTMENT,
    includeChildren: true,
  }]
}

async function insertPolicy(id = POLICY): Promise<void> {
  await firstPool.query(
    `INSERT INTO elearning_onboarding_policies (
       id, org_id, request_id, request_hash, request_hash_version,
       training_plan_id, match_rules, hire_window_days, deadline_days,
       weekly_report_enabled, created_by
     ) VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, 30, 14, true, $7)`,
    [id, ORG, REQUEST, 'a'.repeat(64), PLAN, JSON.stringify(rules()), ACTOR],
  )
}

describe.sequential('e-learning onboarding PostgreSQL authority', () => {
  beforeAll(async () => {
    if (!DATABASE_URL) throw new Error('DATABASE_URL is required; refusing skip-shaped green')
    assertSafeScratchDatabaseName(scratchName)
    adminPool = new Pool({
      application_name: 'elearning-onboarding-admin',
      connectionString: DATABASE_URL,
      max: 1,
    })
    const residue = await adminPool.query(
      'SELECT datname FROM pg_database WHERE datname LIKE $1',
      [`${scratchPrefix}%`],
    )
    if (residue.rows.length !== 0) throw new Error('onboarding scratch prefix residue detected')
    await adminPool.query(`CREATE DATABASE "${scratchName}"`)
    const url = scratchUrl(DATABASE_URL, scratchName)
    firstPool = new Pool({
      application_name: 'elearning-onboarding-first',
      connectionString: url,
      max: 4,
    })
    secondPool = new Pool({
      application_name: 'elearning-onboarding-second',
      connectionString: url,
      max: 4,
    })
    database = new Kysely({ dialect: new PostgresDialect({ pool: firstPool }) })
    await createPrerequisites()
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
          console.info(formatScratchDropOutcome('elearning-onboarding', outcome))
          if (!outcome.drained || outcome.residualBackends !== 0) {
            throw new Error('onboarding scratch database did not drain cleanly')
          }
        } catch (error) {
          console.error(formatScratchDropFailure('elearning-onboarding', error))
          throw error
        }
        const exact = await adminPool.query(
          'SELECT 1 FROM pg_database WHERE datname = $1',
          [scratchName],
        )
        const prefix = await adminPool.query(
          'SELECT datname FROM pg_database WHERE datname LIKE $1',
          [`${scratchPrefix}%`],
        )
        if (exact.rows.length !== 0 || prefix.rows.length !== 0) {
          throw new Error('onboarding scratch database residue')
        }
      }
    } finally {
      firstTermination?.detach()
      secondTermination?.detach()
      if (adminPool) await adminPool.end()
    }
  }, 30_000)

  it('applies, replays, and rejects canonical schema drift', async () => {
    await migrate(up)
    await migrate(up)
    await firstPool.query(
      `ALTER TABLE elearning_onboarding_weekly_reports
       DROP CONSTRAINT elearning_onboarding_weekly_reports_week_chk`,
    )
    await expect(migrate(up)).rejects.toThrow('migration drift')
    await firstPool.query(
      `ALTER TABLE elearning_onboarding_weekly_reports
       ADD CONSTRAINT elearning_onboarding_weekly_reports_week_chk
       CHECK (week_end = week_start + 7)`,
    )
    await migrate(up)
    await firstPool.query(
      `ALTER TABLE elearning_onboarding_assignment_effects
       DROP CONSTRAINT elearning_onboarding_assignment_effects_job_uniq`,
    )
    await expect(migrate(up)).rejects.toThrow('constraint set')
    await firstPool.query(
      `ALTER TABLE elearning_onboarding_assignment_effects
       ADD CONSTRAINT elearning_onboarding_assignment_effects_job_uniq
       UNIQUE (org_id, job_occurrence_key)`,
    )
    await migrate(up)
    await firstPool.query(`
      CREATE OR REPLACE FUNCTION elearning_onboarding_match_rules_valid(rules jsonb)
      RETURNS boolean
      LANGUAGE sql
      IMMUTABLE
      STRICT
      AS $fn$ SELECT false $fn$
    `)
    await expect(migrate(up)).rejects.toThrow('function definition')
    await migrate(down)
    await migrate(up)
  })

  it('enforces closed policy rules, request identity, and one-way retirement', async () => {
    await insertPolicy()
    await expect(firstPool.query(
      `INSERT INTO elearning_onboarding_policies (
         org_id, request_id, request_hash, request_hash_version,
         training_plan_id, match_rules, hire_window_days, deadline_days,
         weekly_report_enabled, created_by
       ) VALUES ($1, $2, $3, 1, $4, $5::jsonb, 30, 14, true, $6)`,
      [ORG, REQUEST, 'b'.repeat(64), PLAN, JSON.stringify(rules()), ACTOR],
    )).rejects.toMatchObject({ code: '23505' })
    await expect(firstPool.query(
      `UPDATE elearning_onboarding_policies SET deadline_days = 15
       WHERE org_id = $1 AND id = $2`,
      [ORG, POLICY],
    )).rejects.toThrow('payload is immutable')
    await expect(firstPool.query(
      `INSERT INTO elearning_onboarding_policies (
         org_id, request_id, request_hash, request_hash_version,
         training_plan_id, match_rules, hire_window_days, deadline_days,
         weekly_report_enabled, created_by
       ) VALUES ($1, $2, $3, 1, $4, $5::jsonb, 30, 14, true, $6)`,
      [
        ORG,
        randomUUID(),
        'c'.repeat(64),
        PLAN,
        JSON.stringify([{ subjectType: 'all', subjectRef: null, includeChildren: false }]),
        ACTOR,
      ],
    )).rejects.toMatchObject({ code: '23514' })
  })

  it('serializes a global assignment effect and rejects cross-org authority', async () => {
    await firstPool.query(
      `INSERT INTO elearning_jobs (
         org_id, kind, occurrence_key, ref, payload, due_at, status
       ) VALUES (
         $1, 'onboarding_assign', $2, $3,
         jsonb_build_object(
           'policyId', $3::text,
           'userId', $4::text,
           'hireDate', '2026-08-20'
         ), now(), 'running'
       )`,
      [ORG, JOB_OCCURRENCE, POLICY, USER],
    )
    const sourceResult = await firstPool.query(
      `SELECT source_key
         FROM elearning_training_plan_assignments
        WHERE org_id = $1 AND id = $2`,
      [ORG, PLAN_ASSIGNMENT],
    )
    const assignmentSourceKey = sourceResult.rows[0]?.source_key
    expect(typeof assignmentSourceKey).toBe('string')
    await expect(firstPool.query(
      `INSERT INTO elearning_onboarding_assignment_effects (
         org_id, policy_id, user_id, hire_date, job_occurrence_key, source_key,
         training_plan_assignment_id
       ) VALUES ($1, $2, $3, DATE '2026-08-20', 'onboarding-assign-v1:wrong',
                 'wrong-job', $4)`,
      [ORG, POLICY, USER, PLAN_ASSIGNMENT],
    )).rejects.toThrow('authority mismatch')
    await expect(firstPool.query(
      `INSERT INTO elearning_onboarding_assignment_effects (
         org_id, policy_id, user_id, hire_date, job_occurrence_key, source_key,
         training_plan_assignment_id
       ) VALUES ($1, $2, $3, DATE '2026-08-20', $4, 'wrong-source', $5)`,
      [ORG, POLICY, USER, JOB_OCCURRENCE, PLAN_ASSIGNMENT],
    )).rejects.toThrow('authority mismatch')
    const insert = (pool: Pool, id: string) => pool.query(
      `INSERT INTO elearning_onboarding_assignment_effects (
         id, org_id, policy_id, user_id, hire_date, job_occurrence_key, source_key,
         training_plan_assignment_id
       ) VALUES ($1, $2, $3, $4, DATE '2026-08-20', $5, $6, $7)`,
      [id, ORG, POLICY, USER, JOB_OCCURRENCE, assignmentSourceKey, PLAN_ASSIGNMENT],
    )
    const results = await Promise.allSettled([
      insert(firstPool, randomUUID()),
      insert(secondPool, randomUUID()),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const stored = await firstPool.query(
      `SELECT id FROM elearning_onboarding_assignment_effects
       WHERE org_id = $1 AND policy_id = $2 AND user_id = $3`,
      [ORG, POLICY, USER],
    )
    expect(stored.rows).toHaveLength(1)
    await expect(firstPool.query(
      `INSERT INTO elearning_onboarding_assignment_effects (
         org_id, policy_id, user_id, hire_date, job_occurrence_key, source_key,
         training_plan_assignment_id
       ) VALUES ($1, $2, $3, DATE '2026-08-20', $4, 'cross-org', $5)`,
      [OTHER_ORG, POLICY, USER, JOB_OCCURRENCE, PLAN_ASSIGNMENT],
    )).rejects.toBeTruthy()
    await expect(firstPool.query(
      `UPDATE elearning_onboarding_assignment_effects SET hire_date = DATE '2026-08-21'
       WHERE org_id = $1 AND policy_id = $2 AND user_id = $3`,
      [ORG, POLICY, USER],
    )).rejects.toThrow('immutable')
  })

  it('uses the outer directory transaction for fill-only-null and rolls back earlier enqueue effects', async () => {
    const env = {
      ELEARNING_ENABLED: 'true',
      ELEARNING_CONTENT_ENABLED: 'true',
      ELEARNING_ASSIGNMENT_ENABLED: 'true',
    }
    const preserveClient = await firstPool.connect()
    try {
      await preserveClient.query('BEGIN')
      await enqueueDirectoryElearningOnboarding({
        client: preserveClient,
        orgId: ORG,
        users: [{ userId: ACTOR, hiredDate: '2026-08-31' }],
        eventAt: '2026-08-31T00:00:00.000Z',
        env,
      }, async () => ({ matchedPolicyCount: 0, enqueuedCount: 0 }))
      await preserveClient.query('COMMIT')
    } catch (error) {
      await preserveClient.query('ROLLBACK')
      throw error
    } finally {
      preserveClient.release()
    }
    const preserved = await firstPool.query('SELECT hire_date::text AS hire_date FROM users WHERE id = $1', [ACTOR])
    expect(preserved.rows[0]?.hire_date).toBe('2026-08-20')

    const rollbackClient = await firstPool.connect()
    await rollbackClient.query('BEGIN')
    await expect((async () => {
      let call = 0
      await enqueueDirectoryElearningOnboarding({
        client: rollbackClient,
        orgId: ORG,
        users: [
          { userId: ACTOR, hiredDate: '2026-08-20' },
          { userId: USER, hiredDate: '2026-08-31' },
        ],
        eventAt: '2026-08-31T00:00:00.000Z',
        env,
      }, async (db) => {
        call += 1
        if (call === 2) throw new ElearningOnboardingAssignmentError('unavailable')
        await db.query(
          `INSERT INTO elearning_jobs (org_id, kind, occurrence_key, ref, payload, due_at, status)
           VALUES ($1, 'onboarding_assign', $2, $3, '{}'::jsonb, now(), 'queued')`,
          [ORG, `rollback-${randomUUID()}`, POLICY],
        )
        return { matchedPolicyCount: 1, enqueuedCount: 1 }
      })
    })()).rejects.toMatchObject({ code: 'unavailable' })
    await rollbackClient.query('ROLLBACK')
    rollbackClient.release()
    const rolledBack = await firstPool.query(
      `SELECT count(*)::int AS count FROM elearning_jobs WHERE occurrence_key LIKE 'rollback-%'`,
    )
    expect(rolledBack.rows[0]?.count).toBe(0)
  })

  it('suppresses small cohorts and makes every report append-only', async () => {
    await firstPool.query(
      `INSERT INTO elearning_onboarding_weekly_reports (
         org_id, policy_id, week_start, week_end, min_group_size, suppressed,
         enqueued_count, assigned_user_count, failed_count, dead_count
       ) VALUES ($1, $2, DATE '2026-08-24', DATE '2026-08-31', 5, true,
                 NULL, NULL, NULL, NULL)`,
      [ORG, POLICY],
    )
    await expect(firstPool.query(
      `INSERT INTO elearning_onboarding_weekly_reports (
         org_id, policy_id, week_start, week_end, min_group_size, suppressed,
         enqueued_count, assigned_user_count, failed_count, dead_count
       ) VALUES ($1, $2, DATE '2026-08-17', DATE '2026-08-24', 5, true,
                 2, 1, 0, 0)`,
      [ORG, POLICY],
    )).rejects.toMatchObject({ code: '23514' })
    await firstPool.query(
      `INSERT INTO elearning_onboarding_weekly_reports (
         org_id, policy_id, week_start, week_end, min_group_size, suppressed,
         enqueued_count, assigned_user_count, failed_count, dead_count
       ) VALUES ($1, $2, DATE '2026-08-10', DATE '2026-08-17', 5, false,
                 5, 4, 1, 0)`,
      [ORG, POLICY],
    )
    await expect(firstPool.query(
      `DELETE FROM elearning_onboarding_weekly_reports
       WHERE org_id = $1 AND policy_id = $2`,
      [ORG, POLICY],
    )).rejects.toThrow('immutable')
    await expect(firstPool.query(
      'TRUNCATE elearning_onboarding_weekly_reports',
    )).rejects.toThrow('immutable')
  })

  it('fails down on authoritative rows, then supports empty down and reapply', async () => {
    await expect(migrate(down)).rejects.toThrow(ELEARNING_ONBOARDING_DOWN_IN_USE)
    await firstPool.query(`
      ALTER TABLE elearning_onboarding_weekly_reports DISABLE TRIGGER USER;
      ALTER TABLE elearning_onboarding_assignment_effects DISABLE TRIGGER USER;
      ALTER TABLE elearning_onboarding_policies DISABLE TRIGGER USER;
      TRUNCATE elearning_onboarding_weekly_reports,
               elearning_onboarding_assignment_effects,
               elearning_onboarding_policies;
      ALTER TABLE elearning_onboarding_weekly_reports ENABLE TRIGGER USER;
      ALTER TABLE elearning_onboarding_assignment_effects ENABLE TRIGGER USER;
      ALTER TABLE elearning_onboarding_policies ENABLE TRIGGER USER;
    `)
    await migrate(down)
    await migrate(up)
    await migrate(up)
  })
})
