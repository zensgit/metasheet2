import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  down as creditLedgerDown,
  up as creditLedgerUp,
} from '../../src/db/migrations/zzzz20260828150000_create_elearning_credit_ledger'
import {
  claimElearningCredit,
  ElearningCreditLedgerError,
  type ClaimElearningCreditInput,
} from '../../src/services/elearning-credit-ledger'
import {
  type ElearningCreditPgQuery,
  PostgresElearningCreditLedgerStore,
} from '../../src/services/elearning-credit-postgres'
import {
  elearningCreditDay,
} from '../../src/services/elearning-credit-policy'
import {
  assertSafeScratchDatabaseName,
  attachOwnedPoolTerminationHandler,
  dropScratchDatabase,
  formatScratchDropFailure,
  formatScratchDropOutcome,
} from '../helpers/scratch-database'

const ENABLED: NodeJS.ProcessEnv = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_INCENTIVE_ENABLED: 'true',
}

const adminUrl = process.env.DATABASE_URL
const scratchName = `ms2_elcredit_${randomUUID().replaceAll('-', '').slice(0, 12)}`
const ORG = 'org-credit-realdb'
const USER = 'user-credit-realdb'

let adminPool: Pool
let firstPool: Pool
let secondPool: Pool
let db: Kysely<unknown>

function scratchUrl(base: string, database: string): string {
  const url = new URL(base)
  url.pathname = `/${database}`
  return url.toString()
}

function storeFor(pool: Pool): PostgresElearningCreditLedgerStore {
  return new PostgresElearningCreditLedgerStore(async (handler) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const query: ElearningCreditPgQuery = async <Row extends Record<string, unknown>>(
        text: string,
        values?: unknown[],
      ) => {
        const result = await client.query(text, values)
        return { rowCount: result.rowCount, rows: result.rows as Row[] }
      }
      const value = await handler(query)
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

async function migrate(action: (database: Kysely<unknown>) => Promise<void>): Promise<void> {
  await db.transaction().execute(async (transaction) => action(transaction))
}

async function seedRule(): Promise<void> {
  await firstPool.query(
    `INSERT INTO elearning_credit_rules (
       org_id, id, version, behavior, points, daily_cap, time_zone, status
     ) VALUES ($1, 'rule-pass-exam', 1, 'pass_exam', 10, 10, 'Asia/Shanghai', 'active')
     ON CONFLICT (org_id, id, version) DO NOTHING`,
    [ORG],
  )
}

function effect(over: Partial<ClaimElearningCreditInput> = {}): ClaimElearningCreditInput {
  return {
    behavior: 'pass_exam',
    effectKey: 'attempt:midnight-race',
    occurredAt: '2026-01-01T15:59:59.000Z',
    orgId: ORG,
    reference: { attemptId: 'midnight-race', observedDay: 'first' },
    userId: USER,
    ...over,
  }
}

function expectValuesFreeCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElearningCreditLedgerError)
  expect((error as ElearningCreditLedgerError).code).toBe(code)
  const rendered = `${String(error)}\n${error instanceof Error ? error.stack ?? '' : ''}`
  expect(rendered).not.toContain(ORG)
  expect(rendered).not.toContain(USER)
  expect(rendered).not.toContain('attempt:midnight-race')
}

describe('elearning credit ledger PostgreSQL authority', () => {
  beforeAll(async () => {
    if (!adminUrl) {
      throw new Error('DATABASE_URL is required; real-DB authority tests never skip-green')
    }
    assertSafeScratchDatabaseName(scratchName)
    adminPool = new Pool({
      application_name: 'elearning-credit-authority-admin',
      connectionString: adminUrl,
      max: 1,
    })
    const existing = await adminPool.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [scratchName],
    )
    if (existing.rows.length !== 0) throw new Error('scratch database name collision')
    await adminPool.query(`CREATE DATABASE "${scratchName}"`)

    const connectionString = scratchUrl(adminUrl, scratchName)
    firstPool = new Pool({
      application_name: 'elearning-credit-authority-first',
      connectionString,
      max: 1,
    })
    secondPool = new Pool({
      application_name: 'elearning-credit-authority-second',
      connectionString,
      max: 1,
    })
    db = new Kysely({ dialect: new PostgresDialect({ pool: firstPool }) })
    await migrate(creditLedgerUp)
  }, 30_000)

  afterAll(async () => {
    const firstTermination = firstPool ? attachOwnedPoolTerminationHandler(firstPool) : null
    const secondTermination = secondPool ? attachOwnedPoolTerminationHandler(secondPool) : null
    try {
      if (db) await db.destroy()
      if (secondPool) await secondPool.end()
      if (adminPool) {
        try {
          const outcome = await dropScratchDatabase(adminPool, scratchName)
          console.info(formatScratchDropOutcome('elearning-credit-authority', outcome))
        } catch (error) {
          console.error(formatScratchDropFailure('elearning-credit-authority', error))
          throw error
        }
        const absent = await adminPool.query(
          'SELECT 1 FROM pg_database WHERE datname = $1',
          [scratchName],
        )
        if (absent.rows.length !== 0) throw new Error('scratch database remains after teardown')
      }
    } finally {
      firstTermination?.detach()
      secondTermination?.detach()
      if (adminPool) await adminPool.end()
    }
  }, 30_000)

  it('applies, replays, rejects catalog drift, rolls down twice, and reapplies', async () => {
    await migrate(creditLedgerUp)

    await firstPool.query(
      `ALTER TABLE elearning_credit_effect_claims
       DROP CONSTRAINT elearning_credit_effect_claims_effect_identity_key`,
    )
    await expect(migrate(creditLedgerUp)).rejects.toThrow(
      'elearning credit ledger migration drift: elearning_credit_effect_claims_effect_identity_key',
    )
    await firstPool.query(
      `ALTER TABLE elearning_credit_effect_claims
       ADD CONSTRAINT elearning_credit_effect_claims_effect_identity_key
       UNIQUE (org_id, user_id, behavior, effect_key)`,
    )
    await migrate(creditLedgerUp)

    await firstPool.query(
      `ALTER TABLE elearning_credit_balances
       DROP CONSTRAINT elearning_credit_balances_pk`,
    )
    await expect(migrate(creditLedgerUp)).rejects.toThrow(
      'elearning credit ledger migration drift: elearning_credit_balances_pk',
    )
    await firstPool.query(
      `ALTER TABLE elearning_credit_balances
       ADD CONSTRAINT elearning_credit_balances_pk PRIMARY KEY (org_id, user_id)`,
    )
    await migrate(creditLedgerUp)

    await firstPool.query(`
      CREATE OR REPLACE FUNCTION elearning_credit_reject_immutable_write()
      RETURNS trigger AS $$
      BEGIN
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `)
    await expect(migrate(creditLedgerUp)).rejects.toThrow(
      'elearning credit ledger migration drift: immutable function',
    )
    await firstPool.query(`
      CREATE OR REPLACE FUNCTION elearning_credit_reject_immutable_write()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'ELEARNING_CREDIT_IMMUTABLE';
      END;
      $$ LANGUAGE plpgsql
    `)
    await migrate(creditLedgerUp)

    await migrate(creditLedgerDown)
    await migrate(creditLedgerDown)
    const afterDown = await firstPool.query(
      `SELECT to_regclass('elearning_credit_effect_claims') AS claim_table`,
    )
    expect(afterDown.rows).toEqual([{ claim_table: null }])

    await migrate(creditLedgerUp)
    const globalUnique = await firstPool.query<{ columns: string[] }>(
      `SELECT ARRAY(
         SELECT attribute.attname
           FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, position)
           JOIN pg_attribute attribute
             ON attribute.attrelid = constraint_row.conrelid
            AND attribute.attnum = key.attnum
          ORDER BY key.position
       )::text[] AS columns
         FROM pg_constraint constraint_row
        WHERE constraint_row.conname = 'elearning_credit_effect_claims_effect_identity_key'`,
    )
    expect(globalUnique.rows).toEqual([{
      columns: ['org_id', 'user_id', 'behavior', 'effect_key'],
    }])
  })

  it('serializes one global effect across two connections and two local days', async () => {
    await migrate(creditLedgerUp)
    await seedRule()
    await firstPool.query(`
      CREATE FUNCTION elearning_credit_test_pause_claim() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_sleep(0.2);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await firstPool.query(`
      CREATE TRIGGER elearning_credit_test_pause_claim
      AFTER INSERT ON elearning_credit_effect_claims
      FOR EACH ROW EXECUTE FUNCTION elearning_credit_test_pause_claim()
    `)

    const firstInput = effect()
    const secondInput = effect({
      occurredAt: '2026-01-01T16:00:00.000Z',
    })
    expect(firstInput.reference).toEqual(secondInput.reference)
    expect(elearningCreditDay(firstInput.occurredAt, 'Asia/Shanghai')).toBe('2026-01-01')
    expect(elearningCreditDay(secondInput.occurredAt, 'Asia/Shanghai')).toBe('2026-01-02')
    const settled = await Promise.allSettled([
      claimElearningCredit(storeFor(firstPool), firstInput, ENABLED),
      claimElearningCredit(storeFor(secondPool), secondInput, ENABLED),
    ])

    await firstPool.query('DROP TRIGGER elearning_credit_test_pause_claim ON elearning_credit_effect_claims')
    await firstPool.query('DROP FUNCTION elearning_credit_test_pause_claim()')

    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled')
    const rejected = settled.filter((entry) => entry.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const winner = fulfilled[0]
    if (!winner || winner.status !== 'fulfilled') throw new Error('expected one winner')
    expect(winner.value).toMatchObject({ awardedPoints: 10, duplicate: false, status: 'awarded' })
    const loser = rejected[0]
    if (!loser || loser.status !== 'rejected') throw new Error('expected one loser')
    expectValuesFreeCode(loser.reason, 'conflict')

    const rows = await firstPool.query<{
      claims: number
      decisions: number
      balance: number
      buckets: number
      decision_day: string
    }>(
      `SELECT
         (SELECT count(*)::int FROM elearning_credit_effect_claims
           WHERE org_id = $1 AND user_id = $2 AND effect_key = 'attempt:midnight-race') AS claims,
         (SELECT count(*)::int FROM elearning_credit_decisions
           WHERE org_id = $1 AND user_id = $2 AND effect_key = 'attempt:midnight-race') AS decisions,
         (SELECT balance_points FROM elearning_credit_balances
           WHERE org_id = $1 AND user_id = $2) AS balance,
         (SELECT count(*)::int FROM elearning_credit_daily_buckets
           WHERE org_id = $1 AND user_id = $2) AS buckets,
         (SELECT local_day::text FROM elearning_credit_decisions
           WHERE org_id = $1 AND user_id = $2 AND effect_key = 'attempt:midnight-race') AS decision_day`,
      [ORG, USER],
    )
    const expectedWinnerDay = settled[0].status === 'fulfilled' ? '2026-01-01' : '2026-01-02'
    expect(rows.rows).toEqual([{
      balance: 10,
      buckets: 1,
      claims: 1,
      decision_day: expectedWinnerDay,
      decisions: 1,
    }])

    const winningInput = settled[0].status === 'fulfilled' ? firstInput : secondInput
    await expect(
      claimElearningCredit(storeFor(secondPool), winningInput, ENABLED),
    ).resolves.toEqual({ ...winner.value, duplicate: true })
  }, 30_000)

  it('rolls the effect claim back with the decision and balance on failure', async () => {
    await seedRule()
    await firstPool.query(`
      CREATE FUNCTION elearning_credit_test_reject_balance() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'TEST_BALANCE_REJECTED';
      END;
      $$ LANGUAGE plpgsql
    `)
    await firstPool.query(`
      CREATE TRIGGER elearning_credit_test_reject_balance
      BEFORE INSERT OR UPDATE ON elearning_credit_balances
      FOR EACH ROW EXECUTE FUNCTION elearning_credit_test_reject_balance()
    `)
    const retryable = effect({
      effectKey: 'attempt:rollback',
      occurredAt: '2026-01-02T16:00:00.000Z',
      reference: { attemptId: 'rollback' },
      userId: 'user-credit-realdb-rollback',
    })

    await expect(
      claimElearningCredit(storeFor(firstPool), retryable, ENABLED),
    ).rejects.toMatchObject({ code: 'unavailable' })
    const residue = await firstPool.query<{
      balances: number
      buckets: number
      claims: number
      decisions: number
    }>(
      `SELECT
         (SELECT count(*)::int FROM elearning_credit_effect_claims
           WHERE effect_key = 'attempt:rollback') AS claims,
         (SELECT count(*)::int FROM elearning_credit_decisions
           WHERE effect_key = 'attempt:rollback') AS decisions,
         (SELECT count(*)::int FROM elearning_credit_daily_buckets
           WHERE user_id = 'user-credit-realdb-rollback') AS buckets,
         (SELECT count(*)::int FROM elearning_credit_balances
           WHERE user_id = 'user-credit-realdb-rollback') AS balances`,
    )
    expect(residue.rows).toEqual([{ balances: 0, buckets: 0, claims: 0, decisions: 0 }])

    await firstPool.query('DROP TRIGGER elearning_credit_test_reject_balance ON elearning_credit_balances')
    await firstPool.query('DROP FUNCTION elearning_credit_test_reject_balance()')
    await expect(
      claimElearningCredit(storeFor(firstPool), retryable, ENABLED),
    ).resolves.toMatchObject({ awardedPoints: 10, duplicate: false, status: 'awarded' })
  })

  it('serializes different effects in one local-day bucket before enforcing the daily cap', async () => {
    await seedRule()
    await firstPool.query(`
      CREATE FUNCTION elearning_credit_test_pause_decision() RETURNS trigger AS $$
      BEGIN
        IF NEW.user_id = 'user-credit-realdb-cap-race' THEN
          PERFORM pg_sleep(0.2);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `)
    await firstPool.query(`
      CREATE TRIGGER elearning_credit_test_pause_decision
      BEFORE INSERT ON elearning_credit_decisions
      FOR EACH ROW EXECUTE FUNCTION elearning_credit_test_pause_decision()
    `)

    const occurredAt = '2026-01-03T00:00:00.000Z'
    const userId = 'user-credit-realdb-cap-race'
    await firstPool.query(
      `INSERT INTO elearning_credit_daily_buckets (
         org_id, user_id, behavior, local_day
       ) VALUES ($1, $2, 'pass_exam', '2026-01-03')`,
      [ORG, userId],
    )
    const settled = await Promise.all([
      claimElearningCredit(
        storeFor(firstPool),
        effect({
          effectKey: 'attempt:cap-race-a',
          occurredAt,
          reference: { attemptId: 'cap-race-a' },
          userId,
        }),
        ENABLED,
      ),
      claimElearningCredit(
        storeFor(secondPool),
        effect({
          effectKey: 'attempt:cap-race-b',
          occurredAt,
          reference: { attemptId: 'cap-race-b' },
          userId,
        }),
        ENABLED,
      ),
    ])

    await firstPool.query(
      'DROP TRIGGER elearning_credit_test_pause_decision ON elearning_credit_decisions',
    )
    await firstPool.query('DROP FUNCTION elearning_credit_test_pause_decision()')

    expect(
      settled
        .map((entry) => entry.awardedPoints)
        .sort((left, right) => left - right),
    ).toEqual([0, 10])
    expect(settled.map((entry) => entry.status).sort()).toEqual(['awarded', 'exhausted'])
    const rows = await firstPool.query<{
      awarded: number
      balance: number
      buckets: number
      decisions: number
    }>(
      `SELECT
         (SELECT COALESCE(sum(awarded_points), 0)::int FROM elearning_credit_decisions
           WHERE org_id = $1 AND user_id = $2) AS awarded,
         (SELECT balance_points FROM elearning_credit_balances
           WHERE org_id = $1 AND user_id = $2) AS balance,
         (SELECT count(*)::int FROM elearning_credit_daily_buckets
           WHERE org_id = $1 AND user_id = $2) AS buckets,
         (SELECT count(*)::int FROM elearning_credit_decisions
           WHERE org_id = $1 AND user_id = $2) AS decisions`,
      [ORG, userId],
    )
    expect(rows.rows).toEqual([{ awarded: 10, balance: 10, buckets: 1, decisions: 2 }])
  }, 30_000)
})
