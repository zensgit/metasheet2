import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  up as creditLedgerUp,
} from '../../src/db/migrations/zzzz20260828150000_create_elearning_credit_ledger'
import {
  down as creditSurfaceDown,
  up as creditSurfaceUp,
} from '../../src/db/migrations/zzzz20260829120000_create_elearning_credit_rule_requests'
import {
  ElearningCreditSurfaceError,
  getElearningCreditWallet,
  publishElearningCreditRule,
  type ElearningCreditSurfaceDb,
  type ElearningCreditSurfaceQueryable,
} from '../../src/services/elearning-credit-surface'
import {
  assertSafeScratchDatabaseName,
  attachOwnedPoolTerminationHandler,
  dropScratchDatabase,
  formatScratchDropFailure,
  formatScratchDropOutcome,
} from '../helpers/scratch-database'

const DATABASE_URL = process.env.DATABASE_URL
const scratchName = `ms2_elrules_${randomUUID().replaceAll('-', '').slice(0, 12)}`

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

function surfaceDb(pool: Pool): ElearningCreditSurfaceDb {
  return {
    query: (text, params) => query(pool, text, params),
    async transaction<T>(
      handler: (tx: ElearningCreditSurfaceQueryable) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const value = await handler({ query: (text, params) => query(client, text, params) })
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
  await database.transaction().execute(async (tx) => action(tx))
}

async function createMembershipSchema(): Promise<void> {
  await firstPool.query(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      is_active boolean NOT NULL DEFAULT true
    )
  `)
  await firstPool.query(`
    CREATE TABLE user_orgs (
      user_id text NOT NULL,
      org_id text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      PRIMARY KEY (user_id, org_id)
    )
  `)
}

async function seedMember(userId: string, orgId: string): Promise<void> {
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

function publishInput(over: Record<string, unknown> = {}) {
  return {
    orgId: 'org-rules-default',
    actorId: 'admin-rules-default',
    requestId: randomUUID(),
    behavior: 'complete_course',
    points: 5,
    dailyCap: 20,
    timeZone: 'Asia/Taipei',
    ...over,
  }
}

function expectValuesFreeConflict(error: unknown, values: string[]): void {
  expect(error).toBeInstanceOf(ElearningCreditSurfaceError)
  expect((error as ElearningCreditSurfaceError).code).toBe('conflict')
  const rendered = `${String(error)}\n${error instanceof Error ? error.stack ?? '' : ''}`
  for (const value of values) expect(rendered).not.toContain(value)
}

describe('e-learning credit rules and wallet PostgreSQL authority', () => {
  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is required; refusing skip-shaped green')
    }
    assertSafeScratchDatabaseName(scratchName)
    adminPool = new Pool({
      application_name: 'elearning-credit-rules-admin',
      connectionString: DATABASE_URL,
      max: 1,
    })
    const collision = await adminPool.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [scratchName],
    )
    if (collision.rows.length !== 0) throw new Error('scratch database name collision')
    await adminPool.query(`CREATE DATABASE "${scratchName}"`)

    const connectionString = scratchUrl(DATABASE_URL, scratchName)
    firstPool = new Pool({
      application_name: 'elearning-credit-rules-first',
      connectionString,
      max: 2,
    })
    secondPool = new Pool({
      application_name: 'elearning-credit-rules-second',
      connectionString,
      max: 2,
    })
    database = new Kysely({ dialect: new PostgresDialect({ pool: firstPool }) })
    await createMembershipSchema()
    await migrate(creditLedgerUp)
    await migrate(creditSurfaceUp)
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
          console.info(formatScratchDropOutcome('elearning-credit-rules-wallet', outcome))
        } catch (error) {
          console.error(formatScratchDropFailure('elearning-credit-rules-wallet', error))
          throw error
        }
        const residue = await adminPool.query(
          'SELECT 1 FROM pg_database WHERE datname = $1',
          [scratchName],
        )
        if (residue.rows.length !== 0) throw new Error('scratch database remains after teardown')
      }
    } finally {
      firstTermination?.detach()
      secondTermination?.detach()
      if (adminPool) await adminPool.end()
    }
  }, 30_000)

  it('applies, replays, fails loud on drift, rolls down twice, and reapplies', async () => {
    await migrate(creditSurfaceUp)

    await firstPool.query('DROP INDEX elearning_credit_decisions_wallet_keyset_idx')
    await expect(migrate(creditSurfaceUp)).rejects.toThrow(
      'elearning credit rule request migration drift: partial object set',
    )
    await firstPool.query(`
      CREATE INDEX elearning_credit_decisions_wallet_keyset_idx
        ON elearning_credit_decisions (org_id, user_id, created_at DESC, id DESC)
    `)
    await migrate(creditSurfaceUp)

    await migrate(creditSurfaceDown)
    await migrate(creditSurfaceDown)
    const absent = await firstPool.query(`
      SELECT
        to_regclass('elearning_credit_rule_requests') AS request_table,
        to_regclass('elearning_credit_decisions_wallet_keyset_idx') AS wallet_index
    `)
    expect(absent.rows).toEqual([{ request_table: null, wallet_index: null }])
    await migrate(creditSurfaceUp)
  })

  it('serializes concurrent versions and leaves exactly one active rule per behavior', async () => {
    const orgId = `org-concurrent-${randomUUID()}`
    const first = publishInput({ orgId, actorId: 'admin-first', requestId: randomUUID() })
    const second = publishInput({ orgId, actorId: 'admin-second', requestId: randomUUID(), points: 7 })
    const results = await Promise.all([
      publishElearningCreditRule(surfaceDb(firstPool), first),
      publishElearningCreditRule(surfaceDb(secondPool), second),
    ])
    expect(results.map((result) => result.version).sort()).toEqual([1, 2])

    const rows = await firstPool.query(
      `SELECT id, version, status, points
         FROM elearning_credit_rules
        WHERE org_id = $1 AND behavior = 'complete_course'
        ORDER BY version`,
      [orgId],
    )
    expect(rows.rows).toHaveLength(2)
    expect(new Set(rows.rows.map((row) => row.id)).size).toBe(1)
    expect(rows.rows.map((row) => row.version)).toEqual([1, 2])
    expect(rows.rows.filter((row) => row.status === 'active')).toHaveLength(1)
    expect(rows.rows.find((row) => row.status === 'active')?.version).toBe(2)
  })

  it('replays the same request exactly and rejects changed values without leaking them', async () => {
    const orgId = `org-replay-${randomUUID()}`
    const requestId = randomUUID()
    const input = publishInput({ orgId, requestId, behavior: 'pass_exam' })
    const results = await Promise.all([
      publishElearningCreditRule(surfaceDb(firstPool), input),
      publishElearningCreditRule(surfaceDb(secondPool), input),
    ])
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true])
    expect(results[0]).toMatchObject({
      ruleId: results[1]?.ruleId,
      version: results[1]?.version,
      points: results[1]?.points,
    })
    expect(await firstPool.query(
      'SELECT count(*)::int AS count FROM elearning_credit_rule_requests WHERE org_id = $1 AND source_key = $2',
      [orgId, requestId],
    ).then((result) => result.rows)).toEqual([{ count: 1 }])

    const changedValue = '19'
    let caught: unknown
    try {
      await publishElearningCreditRule(surfaceDb(firstPool), {
        ...input,
        points: Number(changedValue),
      })
    } catch (error) {
      caught = error
    }
    expectValuesFreeConflict(caught, [orgId, requestId, changedValue])
  })

  it('isolates identical request IDs by organization', async () => {
    const requestId = randomUUID()
    const firstOrg = `org-isolated-a-${randomUUID()}`
    const secondOrg = `org-isolated-b-${randomUUID()}`
    const [first, second] = await Promise.all([
      publishElearningCreditRule(surfaceDb(firstPool), publishInput({ orgId: firstOrg, requestId })),
      publishElearningCreditRule(surfaceDb(secondPool), publishInput({ orgId: secondOrg, requestId })),
    ])
    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(false)
    expect(await firstPool.query(
      'SELECT count(*)::int AS count FROM elearning_credit_rule_requests WHERE source_key = $1',
      [requestId],
    ).then((result) => result.rows)).toEqual([{ count: 2 }])
  })

  it('reads a same-org wallet with stable keyset pagination and rejects cross-org targets', async () => {
    const orgId = `org-wallet-${randomUUID()}`
    const otherOrgId = `org-wallet-other-${randomUUID()}`
    const userId = `user-wallet-${randomUUID()}`
    const otherUserId = `user-wallet-other-${randomUUID()}`
    await seedMember(userId, orgId)
    await seedMember(otherUserId, otherOrgId)
    const rule = await publishElearningCreditRule(
      surfaceDb(firstPool),
      publishInput({ orgId, actorId: 'wallet-admin', behavior: 'complete_course' }),
    )
    await firstPool.query(
      `INSERT INTO elearning_credit_balances (org_id, user_id, balance_points)
       VALUES ($1, $2, 15)`,
      [orgId, userId],
    )
    const decisions = [
      { id: randomUUID(), at: '2026-08-29T03:00:00.123900Z' },
      { id: randomUUID(), at: '2026-08-29T03:00:00.123500Z' },
      { id: randomUUID(), at: '2026-08-29T03:00:00.123100Z' },
    ]
    for (const [index, decision] of decisions.entries()) {
      await firstPool.query(
        `INSERT INTO elearning_credit_decisions (
           id, org_id, user_id, behavior, effect_key,
           request_hash, request_hash_version, occurred_at, local_day,
           rule_id, rule_version, rule_points, rule_daily_cap, rule_time_zone,
           requested_points, awarded_points, remaining_daily_cap, status, created_at
         ) VALUES (
           $1, $2, $3, 'complete_course', $4,
           $5, 1, $6, '2026-08-29',
           $7, $8, 5, 20, 'Asia/Taipei',
           5, 5, 15, 'awarded', $6
         )`,
        [
          decision.id,
          orgId,
          userId,
          `course:${index}`,
          String(index + 1).repeat(64),
          decision.at,
          rule.ruleId,
          rule.version,
        ],
      )
    }

    const firstPage = await getElearningCreditWallet(surfaceDb(firstPool), {
      orgId,
      userId,
      limit: 2,
    })
    expect(firstPage).toEqual({
      userId,
      balancePoints: 15,
      items: expect.arrayContaining([
        expect.objectContaining({ decisionId: decisions[0]?.id, awardedPoints: 5 }),
        expect.objectContaining({ decisionId: decisions[1]?.id, awardedPoints: 5 }),
      ]),
      nextCursor: expect.any(String),
    })
    expect(firstPage.items.map((item) => item.decisionId)).toEqual([
      decisions[0]?.id,
      decisions[1]?.id,
    ])
    const secondPage = await getElearningCreditWallet(surfaceDb(secondPool), {
      orgId,
      userId,
      limit: 2,
      cursor: firstPage.nextCursor,
    })
    expect(secondPage.items.map((item) => item.decisionId)).toEqual([decisions[2]?.id])
    expect(secondPage.nextCursor).toBeNull()

    await expect(getElearningCreditWallet(surfaceDb(firstPool), {
      orgId,
      userId: otherUserId,
    })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('enforces command-ledger immutability for row and table operations', async () => {
    await expect(firstPool.query(
      'UPDATE elearning_credit_rule_requests SET actor_id = actor_id',
    )).rejects.toThrow('ELEARNING_CREDIT_IMMUTABLE')
    await expect(firstPool.query(
      'DELETE FROM elearning_credit_rule_requests',
    )).rejects.toThrow('ELEARNING_CREDIT_IMMUTABLE')
    await expect(firstPool.query(
      'TRUNCATE elearning_credit_rule_requests',
    )).rejects.toThrow('ELEARNING_CREDIT_IMMUTABLE')
  })
})
