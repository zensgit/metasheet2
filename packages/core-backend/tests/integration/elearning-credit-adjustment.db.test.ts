import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  down as creditAdjustmentDown,
  up as creditAdjustmentUp,
} from '../../src/db/migrations/zzzz20260829160000_create_elearning_credit_adjustments'
import {
  up as creditLedgerUp,
} from '../../src/db/migrations/zzzz20260828150000_create_elearning_credit_ledger'
import {
  ElearningCreditAdjustmentError,
  ELEARNING_CREDIT_INT4_MAX,
  hashElearningCreditAdjustmentRequest,
  type AdjustElearningCreditInput,
} from '../../src/services/elearning-credit-adjustment'
import { adjustElearningCreditPostgres } from '../../src/services/elearning-credit-adjustment-postgres'
import {
  claimElearningCredit,
  type ClaimElearningCreditInput,
} from '../../src/services/elearning-credit-ledger'
import {
  type ElearningCreditPgQuery,
  PostgresElearningCreditLedgerStore,
} from '../../src/services/elearning-credit-postgres'
import type {
  ElearningCreditSurfaceDb,
  ElearningCreditSurfaceQueryable,
} from '../../src/services/elearning-credit-surface'
import {
  assertSafeScratchDatabaseName,
  attachOwnedPoolTerminationHandler,
  dropScratchDatabase,
  formatScratchDropFailure,
  formatScratchDropOutcome,
} from '../helpers/scratch-database'

const ENABLED = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_INCENTIVE_ENABLED: 'true',
} as NodeJS.ProcessEnv
const DATABASE_URL = process.env.DATABASE_URL
const scratchPrefix = 'ms2_eladjust_'
const scratchName = `${scratchPrefix}${randomUUID().replaceAll('-', '').slice(0, 12)}`

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
  const result = await target.query(text, params as never)
  return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
}

function surfaceDb(
  pool: Pool,
  beforeQuery?: (text: string) => Promise<void>,
): ElearningCreditSurfaceDb {
  const runQuery = async (
    target: Pool | PoolClient,
    text: string,
    params?: unknown[],
  ) => {
    await beforeQuery?.(text)
    return query(target, text, params)
  }
  return {
    query: (text, params) => runQuery(pool, text, params),
    async transaction<T>(
      handler: (tx: ElearningCreditSurfaceQueryable) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const value = await handler({
          query: (text, params) => runQuery(client, text, params),
        })
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

function twoPartyQueryBarrier(...markers: string[]): (text: string) => Promise<void> {
  let arrivals = 0
  let release: (() => void) | undefined
  const bothArrived = new Promise<void>((resolve) => { release = resolve })
  return async (text) => {
    if (!markers.some((marker) => text.includes(marker))) return
    arrivals += 1
    if (arrivals === 2) release?.()
    await bothArrived
  }
}

function creditStore(
  pool: Pool,
  beforeQuery?: (text: string) => Promise<void>,
): PostgresElearningCreditLedgerStore {
  return new PostgresElearningCreditLedgerStore(async (handler) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const runQuery: ElearningCreditPgQuery = async <Row extends Record<string, unknown>>(
        text: string,
        values?: unknown[],
      ) => {
        await beforeQuery?.(text)
        const result = await client.query(text, values)
        return { rowCount: result.rowCount, rows: result.rows as Row[] }
      }
      const value = await handler(runQuery)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })
}

async function migrate(action: (db: Kysely<unknown>) => Promise<void>): Promise<void> {
  await database.transaction().execute(async (tx) => action(tx))
}

async function seedMember(orgId: string, userId: string): Promise<void> {
  await firstPool.query(
    `INSERT INTO users (id, is_active) VALUES ($1, true)
     ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active`,
    [userId],
  )
  await firstPool.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)
     ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = EXCLUDED.is_active`,
    [userId, orgId],
  )
}

function adjustment(
  orgId: string,
  actorId: string,
  userId: string,
  over: Partial<AdjustElearningCreditInput> = {},
): AdjustElearningCreditInput {
  return {
    orgId,
    actorId,
    requestId: randomUUID(),
    userId,
    points: 5,
    reason: 'verified manual adjustment',
    ...over,
  }
}

function automaticAward(
  orgId: string,
  userId: string,
): ClaimElearningCreditInput {
  const effectId = randomUUID()
  return {
    behavior: 'pass_exam',
    effectKey: `attempt:${effectId}`,
    occurredAt: '2026-08-29T00:00:00.000Z',
    orgId,
    reference: { attemptId: effectId },
    userId,
  }
}

function expectValuesFreeConflict(error: unknown, values: string[]): void {
  expect(error).toBeInstanceOf(ElearningCreditAdjustmentError)
  expect((error as ElearningCreditAdjustmentError).code).toBe('conflict')
  const rendered = `${String(error)}\n${error instanceof Error ? error.stack ?? '' : ''}`
  for (const value of values) expect(rendered).not.toContain(value)
}

beforeAll(async () => {
  if (!DATABASE_URL) {
    throw new Error(
      'e-learning credit adjustment authority requires DATABASE_URL; refusing skip-shaped green',
    )
  }
  assertSafeScratchDatabaseName(scratchName)
  adminPool = new Pool({
    application_name: 'elearning-credit-adjustment-admin',
    connectionString: DATABASE_URL,
    max: 1,
  })
  const existing = await adminPool.query(
    'SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname',
    [`${scratchPrefix}%`],
  )
  if (existing.rows.length !== 0) throw new Error('scratch database prefix residue detected')
  await adminPool.query(`CREATE DATABASE "${scratchName}"`)

  const connectionString = scratchUrl(DATABASE_URL, scratchName)
  firstPool = new Pool({
    application_name: 'elearning-credit-adjustment-first',
    connectionString,
    max: 2,
  })
  secondPool = new Pool({
    application_name: 'elearning-credit-adjustment-second',
    connectionString,
    max: 2,
  })
  database = new Kysely({ dialect: new PostgresDialect({ pool: firstPool }) })
  await firstPool.query(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      is_active boolean NOT NULL DEFAULT true
    )
  `)
  await migrate(creditLedgerUp)
  await migrate(creditAdjustmentUp)
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
        console.info(formatScratchDropOutcome('elearning-credit-adjustment', outcome))
        if (!outcome.drained || outcome.residualBackends !== 0) {
          throw new Error('scratch database did not drain cleanly')
        }
      } catch (error) {
        console.error(formatScratchDropFailure('elearning-credit-adjustment', error))
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
      if (backends.rows[0]?.count !== 0) throw new Error('scratch database backend residue detected')
      if (residue.rows.length !== 0) throw new Error('scratch database prefix residue remains')
    }
  } finally {
    firstTermination?.detach()
    secondTermination?.detach()
    if (adminPool) await adminPool.end()
  }
}, 30_000)

describe('e-learning credit adjustment PostgreSQL authority', () => {
  it('applies, replays, rejects drift, rolls down twice, and reapplies with same-org FKs', async () => {
    await migrate(creditAdjustmentUp)

    const foreignKeys = await firstPool.query<{
      name: string
      columns: string[]
      referenced_columns: string[]
      delete_action: string
    }>(`
      SELECT
        constraint_row.conname AS name,
        ARRAY(
          SELECT attribute.attname
            FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, position)
            JOIN pg_attribute attribute
              ON attribute.attrelid = constraint_row.conrelid
             AND attribute.attnum = key.attnum
           ORDER BY key.position
        )::text[] AS columns,
        ARRAY(
          SELECT attribute.attname
            FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key(attnum, position)
            JOIN pg_attribute attribute
              ON attribute.attrelid = constraint_row.confrelid
             AND attribute.attnum = key.attnum
           ORDER BY key.position
        )::text[] AS referenced_columns,
        constraint_row.confdeltype::text AS delete_action
        FROM pg_constraint constraint_row
       WHERE constraint_row.conrelid = 'elearning_credit_adjustments'::regclass
         AND constraint_row.contype = 'f'
       ORDER BY constraint_row.conname
    `)
    expect(foreignKeys.rows).toEqual([
      {
        name: 'elearning_credit_adjustments_actor_org_fk',
        columns: ['actor_id', 'org_id'],
        referenced_columns: ['user_id', 'org_id'],
        delete_action: 'r',
      },
      {
        name: 'elearning_credit_adjustments_user_org_fk',
        columns: ['user_id', 'org_id'],
        referenced_columns: ['user_id', 'org_id'],
        delete_action: 'r',
      },
    ])

    await firstPool.query(`
      CREATE OR REPLACE FUNCTION elearning_credit_reject_immutable_write()
      RETURNS trigger AS $$
      BEGIN
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `)
    await expect(migrate(creditAdjustmentUp)).rejects.toThrow(
      'elearning credit adjustment migration drift: immutable function',
    )
    await firstPool.query(`
      CREATE OR REPLACE FUNCTION elearning_credit_reject_immutable_write()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'ELEARNING_CREDIT_IMMUTABLE';
      END;
      $$ LANGUAGE plpgsql
    `)
    await migrate(creditAdjustmentUp)

    await firstPool.query(
      `ALTER TABLE elearning_credit_adjustments
       DROP CONSTRAINT elearning_credit_adjustments_org_source_key`,
    )
    await expect(migrate(creditAdjustmentUp)).rejects.toThrow(
      'elearning credit adjustment migration drift: elearning_credit_adjustments_org_source_key',
    )
    await firstPool.query(
      `ALTER TABLE elearning_credit_adjustments
       ADD CONSTRAINT elearning_credit_adjustments_org_source_key UNIQUE (org_id, source_key)`,
    )
    await migrate(creditAdjustmentUp)

    await migrate(creditAdjustmentDown)
    await migrate(creditAdjustmentDown)
    expect(await firstPool.query(
      `SELECT to_regclass('elearning_credit_adjustments') AS adjustment_table`,
    ).then((result) => result.rows)).toEqual([{ adjustment_table: null }])
    await migrate(creditAdjustmentUp)
  })

  it('serializes same-key replays and rejects a concurrent changed payload values-free', async () => {
    const orgId = `org-adjust-replay-${randomUUID()}`
    const actorId = `actor-adjust-replay-${randomUUID()}`
    const userId = `user-adjust-replay-${randomUUID()}`
    const requestId = randomUUID()
    await seedMember(orgId, actorId)
    await seedMember(orgId, userId)
    const input = adjustment(orgId, actorId, userId, { requestId })

    const replays = await Promise.all([
      adjustElearningCreditPostgres(surfaceDb(firstPool), input, ENABLED),
      adjustElearningCreditPostgres(surfaceDb(secondPool), input, ENABLED),
    ])
    expect(replays.map((result) => result.duplicate).sort()).toEqual([false, true])
    expect(replays[0]).toMatchObject({
      adjustmentId: replays[1]?.adjustmentId,
      balancePoints: 5,
      points: 5,
    })

    const changedRequestId = randomUUID()
    const first = adjustment(orgId, actorId, userId, {
      requestId: changedRequestId,
      points: 7,
    })
    const changedValue = `changed-adjustment-${randomUUID()}`
    const second = { ...first, reason: changedValue }
    const settled = await Promise.allSettled([
      adjustElearningCreditPostgres(surfaceDb(firstPool), first, ENABLED),
      adjustElearningCreditPostgres(surfaceDb(secondPool), second, ENABLED),
    ])
    expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.find((entry) => entry.status === 'rejected')
    if (!rejected || rejected.status !== 'rejected') throw new Error('expected one conflict')
    expectValuesFreeConflict(rejected.reason, [orgId, changedRequestId, changedValue])
    expect(await firstPool.query(
      `SELECT count(*)::int AS count
         FROM elearning_credit_adjustments
        WHERE org_id = $1 AND source_key = $2`,
      [orgId, changedRequestId],
    ).then((result) => result.rows)).toEqual([{ count: 1 }])
  }, 30_000)

  it('serializes different request keys through the same balance row', async () => {
    const orgId = `org-adjust-balance-${randomUUID()}`
    const actorId = `actor-adjust-balance-${randomUUID()}`
    const userId = `user-adjust-balance-${randomUUID()}`
    await seedMember(orgId, actorId)
    await seedMember(orgId, userId)
    await firstPool.query(
      `INSERT INTO elearning_credit_balances (org_id, user_id, balance_points)
       VALUES ($1, $2, 0)`,
      [orgId, userId],
    )
    await firstPool.query(`
      CREATE FUNCTION elearning_credit_adjustment_test_pause_balance() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(0.2);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await firstPool.query(`
      CREATE TRIGGER elearning_credit_adjustment_test_pause_balance
      BEFORE UPDATE ON elearning_credit_balances
      FOR EACH ROW EXECUTE FUNCTION elearning_credit_adjustment_test_pause_balance()
    `)
    try {
      const beforeBalanceLock = twoPartyQueryBarrier(':lock-balance')
      const results = await Promise.all([
        adjustElearningCreditPostgres(
          surfaceDb(firstPool, beforeBalanceLock),
          adjustment(orgId, actorId, userId, { points: 4 }),
          ENABLED,
        ),
        adjustElearningCreditPostgres(
          surfaceDb(secondPool, beforeBalanceLock),
          adjustment(orgId, actorId, userId, { points: 7 }),
          ENABLED,
        ),
      ])
      expect(results.map((result) => result.points).sort((a, b) => a - b)).toEqual([4, 7])
      expect(results.filter((result) => result.balancePoints === 11)).toHaveLength(1)
      expect(results.some((result) => result.balancePoints === 4 || result.balancePoints === 7))
        .toBe(true)
      expect(await firstPool.query(
        `SELECT balance_points FROM elearning_credit_balances
          WHERE org_id = $1 AND user_id = $2`,
        [orgId, userId],
      ).then((result) => result.rows)).toEqual([{ balance_points: 11 }])
    } finally {
      await firstPool.query(
        'DROP TRIGGER elearning_credit_adjustment_test_pause_balance ON elearning_credit_balances',
      )
      await firstPool.query('DROP FUNCTION elearning_credit_adjustment_test_pause_balance()')
    }
  }, 30_000)

  it('serializes an automatic award behind a manual adjustment balance lock', async () => {
    const orgId = `org-adjust-auto-${randomUUID()}`
    const actorId = `actor-adjust-auto-${randomUUID()}`
    const userId = `user-adjust-auto-${randomUUID()}`
    const advisoryKey = 2_026_082_916
    await seedMember(orgId, actorId)
    await seedMember(orgId, userId)
    await firstPool.query(
      `INSERT INTO elearning_credit_balances (org_id, user_id, balance_points)
       VALUES ($1, $2, 0)`,
      [orgId, userId],
    )
    await firstPool.query(
      `INSERT INTO elearning_credit_rules (
         org_id, id, version, behavior, points, daily_cap, time_zone, status
       ) VALUES ($1, $2, 1, 'pass_exam', 10, NULL, 'UTC', 'active')`,
      [orgId, `rule-adjust-auto-${randomUUID()}`],
    )
    await firstPool.query(`
      CREATE FUNCTION elearning_credit_adjustment_test_gate_automatic_balance()
      RETURNS trigger AS $$
      BEGIN
        IF current_setting('application_name') = 'elearning-credit-adjustment-second' THEN
          PERFORM pg_advisory_xact_lock(${advisoryKey});
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await firstPool.query(`
      CREATE TRIGGER elearning_credit_adjustment_test_gate_automatic_balance
      BEFORE UPDATE ON elearning_credit_balances
      FOR EACH ROW EXECUTE FUNCTION elearning_credit_adjustment_test_gate_automatic_balance()
    `)

    const gateClient = await firstPool.connect()
    let releaseManual: (() => void) | undefined
    let markManualReady: (() => void) | undefined
    let markAutomaticReady: (() => void) | undefined
    const manualRelease = new Promise<void>((resolve) => { releaseManual = resolve })
    const manualReady = new Promise<void>((resolve) => { markManualReady = resolve })
    const automaticReady = new Promise<void>((resolve) => { markAutomaticReady = resolve })
    try {
      await gateClient.query('SELECT pg_advisory_lock($1)', [advisoryKey])
      const manualPromise = adjustElearningCreditPostgres(
        surfaceDb(firstPool, async (text) => {
          if (!text.includes(':set-balance')) return
          markManualReady?.()
          await manualRelease
        }),
        adjustment(orgId, actorId, userId, { points: 5 }),
        ENABLED,
      )
      await manualReady

      const automaticPromise = claimElearningCredit(
        creditStore(secondPool, async (text) => {
          if (text.includes('SET balance_points = elearning_credit_balances.balance_points +')) {
            markAutomaticReady?.()
          }
        }),
        automaticAward(orgId, userId),
        ENABLED,
      )
      await automaticReady

      let observedLockWait = false
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await adminPool.query(
          `SELECT 1
             FROM pg_stat_activity
            WHERE datname = $1
              AND application_name = 'elearning-credit-adjustment-second'
              AND wait_event_type = 'Lock'`,
          [scratchName],
        )
        if (activity.rows.length === 1) {
          observedLockWait = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(observedLockWait).toBe(true)

      releaseManual?.()
      await gateClient.query('SELECT pg_advisory_unlock($1)', [advisoryKey])
      const [manual, automatic] = await Promise.all([manualPromise, automaticPromise])
      expect(manual).toMatchObject({ balancePoints: 5, duplicate: false, points: 5 })
      expect(automatic).toMatchObject({ awardedPoints: 10, duplicate: false, status: 'awarded' })
      expect(await firstPool.query(
        `SELECT
           (SELECT balance_points FROM elearning_credit_balances
             WHERE org_id = $1 AND user_id = $2) AS balance,
           (SELECT count(*)::int FROM elearning_credit_adjustments
             WHERE org_id = $1 AND user_id = $2) AS adjustments,
           (SELECT count(*)::int FROM elearning_credit_decisions
             WHERE org_id = $1 AND user_id = $2) AS decisions`,
        [orgId, userId],
      ).then((result) => result.rows)).toEqual([{
        adjustments: 1,
        balance: 15,
        decisions: 1,
      }])
    } finally {
      releaseManual?.()
      await gateClient.query('SELECT pg_advisory_unlock($1)', [advisoryKey])
      gateClient.release()
      await firstPool.query(
        'DROP TRIGGER elearning_credit_adjustment_test_gate_automatic_balance ON elearning_credit_balances',
      )
      await firstPool.query(
        'DROP FUNCTION elearning_credit_adjustment_test_gate_automatic_balance()',
      )
    }
  }, 30_000)

  it('enforces same-org actor and target FKs in the database', async () => {
    const firstOrg = `org-adjust-fk-a-${randomUUID()}`
    const secondOrg = `org-adjust-fk-b-${randomUUID()}`
    const actorId = `actor-adjust-fk-${randomUUID()}`
    const userId = `user-adjust-fk-${randomUUID()}`
    await seedMember(firstOrg, actorId)
    await seedMember(secondOrg, userId)
    const hash = hashElearningCreditAdjustmentRequest({
      actorId,
      userId,
      points: 5,
      reason: 'same org foreign key',
    })
    await expect(firstPool.query(
      `INSERT INTO elearning_credit_adjustments (
         id, org_id, actor_id, source_key, request_hash, request_hash_version,
         user_id, points, reason, balance_after
       ) VALUES ($1, $2, $3, $4, $5, 1, $6, 5, 'same org foreign key', 5)`,
      [randomUUID(), firstOrg, actorId, randomUUID(), hash, userId],
    )).rejects.toMatchObject({
      code: '23503',
      constraint: 'elearning_credit_adjustments_user_org_fk',
    })

    await expect(adjustElearningCreditPostgres(
      surfaceDb(firstPool),
      adjustment(firstOrg, actorId, userId),
      ENABLED,
    )).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rolls back insufficient and overflowing balances without an adjustment row', async () => {
    for (const [index, scenario] of [
      { balance: 4, points: -5 },
      { balance: ELEARNING_CREDIT_INT4_MAX, points: 1 },
    ].entries()) {
      const orgId = `org-adjust-bound-${index}-${randomUUID()}`
      const actorId = `actor-adjust-bound-${index}-${randomUUID()}`
      const userId = `user-adjust-bound-${index}-${randomUUID()}`
      const requestId = randomUUID()
      await seedMember(orgId, actorId)
      await seedMember(orgId, userId)
      await firstPool.query(
        `INSERT INTO elearning_credit_balances (org_id, user_id, balance_points)
         VALUES ($1, $2, $3)`,
        [orgId, userId, scenario.balance],
      )
      await expect(adjustElearningCreditPostgres(
        surfaceDb(firstPool),
        adjustment(orgId, actorId, userId, {
          requestId,
          points: scenario.points,
        }),
        ENABLED,
      )).rejects.toMatchObject({ code: 'conflict' })
      expect(await firstPool.query(
        `SELECT
           (SELECT balance_points FROM elearning_credit_balances
             WHERE org_id = $1 AND user_id = $2) AS balance,
           (SELECT count(*)::int FROM elearning_credit_adjustments
             WHERE org_id = $1 AND source_key = $3) AS adjustments`,
        [orgId, userId, requestId],
      ).then((result) => result.rows)).toEqual([{
        balance: scenario.balance,
        adjustments: 0,
      }])
    }
  })

  it('enforces int4/check boundaries and immutable row/table operations', async () => {
    const orgId = `org-adjust-immutable-${randomUUID()}`
    const actorId = `actor-adjust-immutable-${randomUUID()}`
    const userId = `user-adjust-immutable-${randomUUID()}`
    await seedMember(orgId, actorId)
    await seedMember(orgId, userId)
    const inserted = await adjustElearningCreditPostgres(
      surfaceDb(firstPool),
      adjustment(orgId, actorId, userId),
      ENABLED,
    )
    expect(inserted.duplicate).toBe(false)

    await expect(firstPool.query(
      `UPDATE elearning_credit_adjustments SET reason = reason WHERE id = $1`,
      [inserted.adjustmentId],
    )).rejects.toThrow('ELEARNING_CREDIT_IMMUTABLE')
    await expect(firstPool.query(
      `DELETE FROM elearning_credit_adjustments WHERE id = $1`,
      [inserted.adjustmentId],
    )).rejects.toThrow('ELEARNING_CREDIT_IMMUTABLE')
    await expect(firstPool.query(
      'TRUNCATE elearning_credit_adjustments',
    )).rejects.toThrow('ELEARNING_CREDIT_IMMUTABLE')

    await expect(firstPool.query(
      `INSERT INTO elearning_credit_adjustments (
         id, org_id, actor_id, source_key, request_hash, request_hash_version,
         user_id, points, reason, balance_after
       ) VALUES ($1, $2, $3, $4, $5, 1, $6, -2147483648, 'invalid boundary', 0)`,
      [randomUUID(), orgId, actorId, randomUUID(), 'a'.repeat(64), userId],
    )).rejects.toMatchObject({
      code: '23514',
      constraint: 'elearning_credit_adjustments_points_check',
    })
  })
})
