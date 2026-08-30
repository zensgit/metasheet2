import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  up as creditLedgerUp,
} from '../../src/db/migrations/zzzz20260828150000_create_elearning_credit_ledger'
import {
  up as creditSurfaceUp,
} from '../../src/db/migrations/zzzz20260829120000_create_elearning_credit_rule_requests'
import {
  up as creditAdjustmentUp,
} from '../../src/db/migrations/zzzz20260829160000_create_elearning_credit_adjustments'
import {
  down as titleDown,
  up as titleUp,
} from '../../src/db/migrations/zzzz20260830123000_create_elearning_titles'
import {
  getElearningCreditWallet,
  type ElearningCreditSurfaceDb,
  type ElearningCreditSurfaceQueryable,
} from '../../src/services/elearning-credit-surface'
import {
  ElearningTitleSurfaceError,
  publishElearningTitleSnapshot,
} from '../../src/services/elearning-title-surface'
import {
  assertSafeScratchDatabaseName,
  attachOwnedPoolTerminationHandler,
  dropScratchDatabase,
  formatScratchDropFailure,
  formatScratchDropOutcome,
} from '../helpers/scratch-database'

const DATABASE_URL = process.env.DATABASE_URL
const scratchPrefix = 'ms2_eltitle_'
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
  return {
    rows: result.rows as Array<Record<string, unknown>>,
    rowCount: result.rowCount,
  }
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
        const value = await handler({
          query: (text, params) => query(client, text, params),
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
      created_at timestamptz NOT NULL DEFAULT now(),
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

function titleInput(
  orgId: string,
  actorId: string,
  requestId = randomUUID(),
  titles: unknown = [
    { id: 'starter', name: 'Starter', threshold: 0 },
    { id: 'expert', name: 'Expert', threshold: 100 },
  ],
) {
  return { orgId, actorId, requestId, titles }
}

describe.sequential('e-learning title PostgreSQL authority', () => {
  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is required; refusing skip-shaped green')
    }
    assertSafeScratchDatabaseName(scratchName)
    adminPool = new Pool({
      application_name: 'elearning-title-admin',
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
      application_name: 'elearning-title-first',
      connectionString,
      max: 3,
    })
    secondPool = new Pool({
      application_name: 'elearning-title-second',
      connectionString,
      max: 2,
    })
    database = new Kysely({ dialect: new PostgresDialect({ pool: firstPool }) })
    await createMembershipSchema()
    await migrate(creditLedgerUp)
    await migrate(creditSurfaceUp)
    await migrate(creditAdjustmentUp)
    await migrate(titleUp)
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
          console.info(formatScratchDropOutcome('elearning-title', outcome))
        } catch (error) {
          console.error(formatScratchDropFailure('elearning-title', error))
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
          throw new Error('elearning title scratch database residue')
        }
      }
    } finally {
      firstTermination?.detach()
      secondTermination?.detach()
      if (adminPool) await adminPool.end()
    }
  }, 30_000)

  it('applies, replays, detects catalog drift, rolls down twice, and reapplies empty', async () => {
    await migrate(titleUp)

    await firstPool.query(`
      CREATE OR REPLACE FUNCTION elearning_credit_reject_immutable_write()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY INVOKER
      AS 'BEGIN RETURN OLD; END;'
    `)
    await expect(migrate(titleUp)).rejects.toThrow(
      'elearning title migration drift: immutable function',
    )
    await firstPool.query(`
      CREATE OR REPLACE FUNCTION elearning_credit_reject_immutable_write()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY INVOKER
      AS \$immutable\$BEGIN
      RAISE EXCEPTION 'ELEARNING_CREDIT_IMMUTABLE';
    END;\$immutable\$
    `)
    await migrate(titleUp)

    await firstPool.query(`
      ALTER TABLE elearning_title_publish_requests
      DROP CONSTRAINT elearning_title_publish_requests_hash_check
    `)
    await expect(migrate(titleUp)).rejects.toThrow(
      'elearning title migration drift: check constraint set',
    )
    await firstPool.query(`
      ALTER TABLE elearning_title_publish_requests
      ADD CONSTRAINT elearning_title_publish_requests_hash_check
      CHECK (request_hash ~ '^[0-9A-F]{64}$' AND request_hash_version > 0)
    `)
    await expect(migrate(titleUp)).rejects.toThrow(
      'elearning title migration drift: check constraint set',
    )
    await firstPool.query(`
      ALTER TABLE elearning_title_publish_requests
      DROP CONSTRAINT elearning_title_publish_requests_hash_check
    `)
    await firstPool.query(`
      ALTER TABLE elearning_title_publish_requests
      ADD CONSTRAINT elearning_title_publish_requests_hash_check
      CHECK (request_hash ~ '^[0-9a-f]{64}$' AND request_hash_version > 0)
    `)
    await migrate(titleUp)

    await firstPool.query(`
      ALTER FUNCTION elearning_title_award_balance_milestones()
      RESET search_path
    `)
    await expect(migrate(titleUp)).rejects.toThrow(
      'elearning title migration drift: elearning_title_award_balance_milestones',
    )
    await firstPool.query(`
      ALTER FUNCTION elearning_title_award_balance_milestones()
      SET search_path TO pg_catalog, public
    `)
    await migrate(titleUp)

    await firstPool.query(`
      CREATE SCHEMA elearning_title_shadow
    `)
    await firstPool.query(`
      CREATE FUNCTION elearning_title_shadow.elearning_title_award_balance_milestones()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY INVOKER
      AS 'BEGIN RETURN NEW; END;'
    `)
    await firstPool.query(`
      DROP TRIGGER elearning_credit_balances_title_awards
      ON elearning_credit_balances
    `)
    await firstPool.query(`
      CREATE TRIGGER elearning_credit_balances_title_awards
      AFTER INSERT OR UPDATE OF balance_points ON elearning_credit_balances
      FOR EACH ROW EXECUTE FUNCTION
        elearning_title_shadow.elearning_title_award_balance_milestones()
    `)
    await expect(migrate(titleUp)).rejects.toThrow(
      'elearning title migration drift: elearning_credit_balances_title_awards',
    )
    await firstPool.query(`
      DROP TRIGGER elearning_credit_balances_title_awards
      ON elearning_credit_balances
    `)
    await firstPool.query(`
      CREATE TRIGGER elearning_credit_balances_title_awards
      AFTER INSERT OR UPDATE OF balance_points ON elearning_credit_balances
      FOR EACH ROW EXECUTE FUNCTION elearning_title_award_balance_milestones()
    `)
    await firstPool.query(`DROP SCHEMA elearning_title_shadow CASCADE`)
    await migrate(titleUp)

    await firstPool.query(`
      ALTER TABLE elearning_title_awards
      DROP CONSTRAINT elearning_title_awards_milestone_key
    `)
    await expect(migrate(titleUp)).rejects.toThrow(
      'elearning title migration drift: elearning_title_awards_milestone_key',
    )
    await firstPool.query(`
      ALTER TABLE elearning_title_awards
      ADD CONSTRAINT elearning_title_awards_milestone_key
      UNIQUE (org_id, user_id, title_key)
    `)
    await migrate(titleUp)

    await migrate(titleDown)
    await migrate(titleDown)
    const absent = await firstPool.query(`
      SELECT
        to_regclass('elearning_title_heads') AS heads,
        to_regprocedure('elearning_title_award_balance_milestones()') AS award_function
    `)
    expect(absent.rows).toEqual([{ heads: null, award_function: null }])
    await migrate(titleUp)
  })

  it('serializes exact request replay and rejects changed snapshots values-free', async () => {
    const orgId = `org-title-replay-${randomUUID()}`
    const actorId = `actor-title-replay-${randomUUID()}`
    const requestId = randomUUID()
    await seedMember(actorId, orgId)
    const input = titleInput(orgId, actorId, requestId)
    const results = await Promise.all([
      publishElearningTitleSnapshot(surfaceDb(firstPool), input),
      publishElearningTitleSnapshot(surfaceDb(secondPool), input),
    ])
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true])
    expect(results[0]).toMatchObject({
      revisionId: results[1]?.revisionId,
      version: 1,
      titles: results[1]?.titles,
    })
    const changedValue = 'changed-title-name-must-not-leak'
    await expect(
      publishElearningTitleSnapshot(surfaceDb(firstPool), titleInput(
        orgId,
        actorId,
        requestId,
        [{ id: 'starter', name: changedValue, threshold: 0 }],
      )),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ElearningTitleSurfaceError)
      expect((error as ElearningTitleSurfaceError).code).toBe('conflict')
      expect(String(error)).not.toContain(changedValue)
      return true
    })
    expect(await firstPool.query(
      `SELECT count(*)::int AS count
         FROM elearning_title_publish_requests
        WHERE org_id = $1 AND source_key = $2`,
      [orgId, requestId],
    ).then((result) => result.rows)).toEqual([{ count: 1 }])
  })

  it('serializes distinct publishes into one monotonically versioned active head', async () => {
    const orgId = `org-title-version-${randomUUID()}`
    const actorId = `actor-title-version-${randomUUID()}`
    await seedMember(actorId, orgId)
    const results = await Promise.all([
      publishElearningTitleSnapshot(
        surfaceDb(firstPool),
        titleInput(orgId, actorId, randomUUID(), [
          { id: 'starter', name: 'Starter', threshold: 0 },
        ]),
      ),
      publishElearningTitleSnapshot(
        surfaceDb(secondPool),
        titleInput(orgId, actorId, randomUUID(), [
          { id: 'starter', name: 'Starter', threshold: 0 },
          { id: 'expert', name: 'Expert', threshold: 100 },
        ]),
      ),
    ])
    expect(results.map((result) => result.version).sort()).toEqual([1, 2])
    const state = await firstPool.query(
      `SELECT head.latest_version, revision.version
         FROM elearning_title_heads head
         JOIN elearning_title_revisions revision
           ON revision.org_id = head.org_id
          AND revision.head_id = head.id
          AND revision.id = head.active_revision_id
        WHERE head.org_id = $1`,
      [orgId],
    )
    expect(state.rows).toEqual([{ latest_version: 2, version: 2 }])
  })

  it('resolves the current title dynamically while keeping first-achievement awards append-only', async () => {
    const orgId = `org-title-wallet-${randomUUID()}`
    const actorId = `actor-title-wallet-${randomUUID()}`
    const userId = `user-title-wallet-${randomUUID()}`
    await seedMember(actorId, orgId)
    await seedMember(userId, orgId)
    await publishElearningTitleSnapshot(
      surfaceDb(firstPool),
      titleInput(orgId, actorId),
    )
    await firstPool.query(
      `INSERT INTO elearning_credit_balances (org_id, user_id, balance_points)
       VALUES ($1, $2, 120)`,
      [orgId, userId],
    )
    const wallet = await getElearningCreditWallet(
      surfaceDb(firstPool),
      { orgId, userId },
    )
    expect(wallet.currentTitle).toEqual({
      id: 'expert',
      name: 'Expert',
      threshold: 100,
    })
    expect(await firstPool.query(
      `SELECT title_key, threshold, balance_points
         FROM elearning_title_awards
        WHERE org_id = $1 AND user_id = $2
        ORDER BY threshold`,
      [orgId, userId],
    ).then((result) => result.rows)).toEqual([
      { title_key: 'starter', threshold: 0, balance_points: 120 },
      { title_key: 'expert', threshold: 100, balance_points: 120 },
    ])

    await firstPool.query(
      `UPDATE elearning_credit_balances
          SET balance_points = 5, updated_at = now()
        WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    )
    const downgraded = await getElearningCreditWallet(
      surfaceDb(firstPool),
      { orgId, userId },
    )
    expect(downgraded.currentTitle?.id).toBe('starter')
    expect(await firstPool.query(
      `SELECT count(*)::int AS count
         FROM elearning_title_awards
        WHERE org_id = $1 AND user_id = $2`,
      [orgId, userId],
    ).then((result) => result.rows)).toEqual([{ count: 2 }])
  })

  it('backfills an active snapshot for existing balances and enforces same-org actors', async () => {
    const orgId = `org-title-backfill-${randomUUID()}`
    const otherOrgId = `org-title-other-${randomUUID()}`
    const actorId = `actor-title-backfill-${randomUUID()}`
    const userId = `user-title-backfill-${randomUUID()}`
    await seedMember(actorId, otherOrgId)
    await seedMember(userId, orgId)
    await firstPool.query(
      `INSERT INTO elearning_credit_balances (org_id, user_id, balance_points)
       VALUES ($1, $2, 150)`,
      [orgId, userId],
    )
    await expect(publishElearningTitleSnapshot(
      surfaceDb(firstPool),
      titleInput(orgId, actorId),
    )).rejects.toMatchObject({ code: 'unavailable' })
    await seedMember(actorId, orgId)
    await publishElearningTitleSnapshot(
      surfaceDb(firstPool),
      titleInput(orgId, actorId),
    )
    expect(await firstPool.query(
      `SELECT title_key
         FROM elearning_title_awards
        WHERE org_id = $1 AND user_id = $2
        ORDER BY title_key`,
      [orgId, userId],
    ).then((result) => result.rows)).toEqual([
      { title_key: 'expert' },
      { title_key: 'starter' },
    ])
  })

  it('serializes a first balance insert before activating and backfilling a snapshot', async () => {
    const orgId = `org-title-balance-race-${randomUUID()}`
    const actorId = `actor-title-balance-race-${randomUUID()}`
    const userId = `user-title-balance-race-${randomUUID()}`
    await seedMember(actorId, orgId)
    await seedMember(userId, orgId)
    const inserter = await secondPool.connect()
    try {
      await inserter.query('BEGIN')
      await inserter.query(
        `INSERT INTO elearning_credit_balances (org_id, user_id, balance_points)
         VALUES ($1, $2, 120)`,
        [orgId, userId],
      )
      let publishSettled = false
      const publish = publishElearningTitleSnapshot(
        surfaceDb(firstPool),
        titleInput(orgId, actorId),
      ).finally(() => {
        publishSettled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(publishSettled).toBe(false)
      await inserter.query('COMMIT')
      await publish
    } finally {
      try {
        await inserter.query('ROLLBACK')
      } catch {
        // COMMIT already ended the transaction.
      }
      inserter.release()
    }
    expect(await firstPool.query(
      `SELECT title_key
         FROM elearning_title_awards
        WHERE org_id = $1 AND user_id = $2
        ORDER BY title_key`,
      [orgId, userId],
    ).then((result) => result.rows)).toEqual([
      { title_key: 'expert' },
      { title_key: 'starter' },
    ])
  })

  it('rejects mutation and deletion of immutable revisions, requests, rows, and awards', async () => {
    for (const statement of [
      `UPDATE elearning_title_revisions SET version = version + 1`,
      `DELETE FROM elearning_title_revision_rows`,
      `UPDATE elearning_title_publish_requests SET source_key = source_key`,
      `DELETE FROM elearning_title_awards`,
      `TRUNCATE elearning_title_awards`,
    ]) {
      await expect(firstPool.query(statement)).rejects.toThrow()
    }
  })

  it('refuses rollback after authoritative title rows exist', async () => {
    await expect(migrate(titleDown)).rejects.toThrow(
      'elearning title migration down refused: authoritative rows exist',
    )
    await migrate(titleUp)
  })
})
