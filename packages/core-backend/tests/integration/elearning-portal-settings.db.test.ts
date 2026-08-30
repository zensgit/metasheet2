import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  down as portalDown,
  up as portalUp,
} from '../../src/db/migrations/zzzz20260830210000_create_elearning_portal_settings'
import {
  ElearningPortalSettingsError,
  getActiveElearningPortalSettings,
  publishElearningPortalSettings,
  type ElearningPortalDb,
  type ElearningPortalQueryable,
} from '../../src/services/elearning-portal-settings'
import {
  assertSafeScratchDatabaseName,
  attachOwnedPoolTerminationHandler,
  dropScratchDatabase,
  formatScratchDropFailure,
  formatScratchDropOutcome,
} from '../helpers/scratch-database'

const DATABASE_URL = process.env.DATABASE_URL
const scratchPrefix = 'ms2_elportal_'
const scratchName = `${scratchPrefix}${randomUUID().replaceAll('-', '').slice(0, 12)}`
const SETTINGS = {
  siteName: 'MetaSheet Academy',
  tagline: 'Learn together',
  bannerUrl: '/assets/banner.png',
  navigation: [
    { label: 'My courses', href: '/elearning' },
    { label: 'My wallet', href: '/elearning/wallet' },
  ],
}

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

function portalDb(pool: Pool): ElearningPortalDb {
  return {
    query: (text, params) => query(pool, text, params),
    async transaction<T>(
      handler: (tx: ElearningPortalQueryable) => Promise<T>,
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

function input(orgId: string, actorId: string, requestId = randomUUID()) {
  return { orgId, actorId, requestId, ...SETTINGS }
}

describe.sequential('e-learning portal PostgreSQL authority', () => {
  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is required; refusing skip-shaped green')
    }
    assertSafeScratchDatabaseName(scratchName)
    adminPool = new Pool({
      application_name: 'elearning-portal-admin',
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
      application_name: 'elearning-portal-first',
      connectionString,
      max: 3,
    })
    secondPool = new Pool({
      application_name: 'elearning-portal-second',
      connectionString,
      max: 2,
    })
    database = new Kysely({ dialect: new PostgresDialect({ pool: firstPool }) })
    await createMembershipSchema()
    await migrate(portalUp)
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
          console.info(formatScratchDropOutcome('elearning-portal', outcome))
        } catch (error) {
          console.error(formatScratchDropFailure('elearning-portal', error))
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
          throw new Error('elearning portal scratch database residue')
        }
      }
    } finally {
      firstTermination?.detach()
      secondTermination?.detach()
      if (adminPool) await adminPool.end()
    }
  }, 30_000)

  it('applies, replays, detects catalog drift, rolls down twice, and reapplies empty', async () => {
    await migrate(portalUp)

    await firstPool.query(`
      ALTER TABLE elearning_portal_revisions ALTER COLUMN site_name DROP NOT NULL
    `)
    await expect(migrate(portalUp)).rejects.toThrow('elearning portal migration drift: column set')
    await firstPool.query(`
      ALTER TABLE elearning_portal_revisions ALTER COLUMN site_name SET NOT NULL
    `)
    await migrate(portalUp)

    await firstPool.query(`
      DROP TRIGGER trg_elearning_portal_revisions_immutable
      ON elearning_portal_revisions
    `)
    await firstPool.query(`
      CREATE TRIGGER trg_elearning_portal_revisions_immutable
      BEFORE UPDATE OR DELETE ON elearning_portal_revisions
      FOR EACH ROW WHEN (false)
      EXECUTE FUNCTION elearning_portal_reject_immutable_write()
    `)
    await expect(migrate(portalUp)).rejects.toThrow(
      'elearning portal migration drift: immutable trigger',
    )
    await firstPool.query(`
      DROP TRIGGER trg_elearning_portal_revisions_immutable
      ON elearning_portal_revisions
    `)
    await firstPool.query(`
      CREATE TRIGGER trg_elearning_portal_revisions_immutable
      BEFORE UPDATE OR DELETE ON elearning_portal_revisions
      FOR EACH ROW EXECUTE FUNCTION elearning_portal_reject_immutable_write()
    `)
    await migrate(portalUp)

    await firstPool.query(`
      ALTER TABLE elearning_portal_heads
      DROP CONSTRAINT elearning_portal_heads_active_revision_fk
    `)
    await firstPool.query(`
      ALTER TABLE elearning_portal_heads
      ADD CONSTRAINT elearning_portal_heads_active_revision_fk
      FOREIGN KEY (org_id, active_revision_id)
      REFERENCES elearning_portal_revisions (org_id, id)
      ON DELETE RESTRICT
    `)
    await expect(migrate(portalUp)).rejects.toThrow(
      'elearning portal migration drift: elearning_portal_heads_active_revision_fk',
    )
    await firstPool.query(`
      ALTER TABLE elearning_portal_heads
      DROP CONSTRAINT elearning_portal_heads_active_revision_fk
    `)
    await firstPool.query(`
      ALTER TABLE elearning_portal_heads
      ADD CONSTRAINT elearning_portal_heads_active_revision_fk
      FOREIGN KEY (org_id, active_revision_id, latest_version)
      REFERENCES elearning_portal_revisions (org_id, id, version)
      ON DELETE RESTRICT
    `)
    await migrate(portalUp)

    await firstPool.query(`
      ALTER TABLE elearning_portal_publish_requests
      DROP CONSTRAINT elearning_portal_publish_requests_hash_check
    `)
    await firstPool.query(`
      ALTER TABLE elearning_portal_publish_requests
      ADD CONSTRAINT elearning_portal_publish_requests_hash_check
      CHECK (request_hash ~ '^[0-9A-F]{64}$' AND request_hash_version > 0)
    `)
    await expect(migrate(portalUp)).rejects.toThrow(
      'elearning portal migration drift: check constraint set',
    )
    await firstPool.query(`
      ALTER TABLE elearning_portal_publish_requests
      DROP CONSTRAINT elearning_portal_publish_requests_hash_check
    `)
    await firstPool.query(`
      ALTER TABLE elearning_portal_publish_requests
      ADD CONSTRAINT elearning_portal_publish_requests_hash_check
      CHECK (request_hash ~ '^[0-9a-f]{64}$' AND request_hash_version > 0)
    `)
    await migrate(portalUp)

    await migrate(portalDown)
    await migrate(portalDown)
    expect((await firstPool.query(`
      SELECT to_regclass('elearning_portal_heads') AS heads,
             to_regprocedure('elearning_portal_reject_immutable_write()') AS immutable
    `)).rows).toEqual([{ heads: null, immutable: null }])
    await migrate(portalUp)
  })

  it('serializes same-key replay and rejects changed payload values-free', async () => {
    const orgId = `org-portal-replay-${randomUUID()}`
    const actorId = `actor-portal-replay-${randomUUID()}`
    const requestId = randomUUID()
    await seedMember(actorId, orgId)
    const command = input(orgId, actorId, requestId)
    const results = await Promise.all([
      publishElearningPortalSettings(portalDb(firstPool), command),
      publishElearningPortalSettings(portalDb(secondPool), command),
    ])
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true])
    expect(results[0]?.revisionId).toBe(results[1]?.revisionId)
    expect(results[0]?.version).toBe(1)

    const changedValue = 'changed-value-must-not-leak'
    await expect(publishElearningPortalSettings(portalDb(firstPool), {
      ...command,
      siteName: changedValue,
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ElearningPortalSettingsError)
      expect((error as ElearningPortalSettingsError).code).toBe('conflict')
      expect(String(error)).not.toContain(changedValue)
      return true
    })
    expect((await firstPool.query(
      `SELECT count(*)::int AS count FROM elearning_portal_publish_requests
       WHERE org_id = $1 AND source_key = $2`,
      [orgId, requestId],
    )).rows).toEqual([{ count: 1 }])
  })

  it('serializes distinct request keys into one monotonic active head', async () => {
    const orgId = `org-portal-version-${randomUUID()}`
    const actorId = `actor-portal-version-${randomUUID()}`
    await seedMember(actorId, orgId)
    const results = await Promise.all([
      publishElearningPortalSettings(portalDb(firstPool), input(orgId, actorId)),
      publishElearningPortalSettings(portalDb(secondPool), {
        ...input(orgId, actorId),
        siteName: 'Second Academy',
      }),
    ])
    expect(results.map((result) => result.version).sort()).toEqual([1, 2])
    const active = await getActiveElearningPortalSettings(portalDb(firstPool), orgId)
    expect(active.version).toBe(2)
    expect(active.revisionId).toBe(results.find((result) => result.version === 2)?.revisionId)
  })

  it('enforces same-org head identity, actor membership and append-only evidence', async () => {
    const orgId = `org-portal-guard-${randomUUID()}`
    const otherOrg = `org-portal-other-${randomUUID()}`
    const actorId = `actor-portal-guard-${randomUUID()}`
    await seedMember(actorId, orgId)
    const published = await publishElearningPortalSettings(
      portalDb(firstPool),
      input(orgId, actorId),
    )

    await expect(firstPool.query(
      `UPDATE elearning_portal_revisions SET site_name = 'tampered'
       WHERE org_id = $1 AND id = $2`,
      [orgId, published.revisionId],
    )).rejects.toThrow('ELEARNING_PORTAL_IMMUTABLE')
    await expect(firstPool.query(
      `DELETE FROM elearning_portal_publish_requests WHERE org_id = $1`,
      [orgId],
    )).rejects.toThrow('ELEARNING_PORTAL_IMMUTABLE')

    await seedMember(actorId, otherOrg)
    await expect(firstPool.query(
      `INSERT INTO elearning_portal_heads (org_id, active_revision_id, latest_version)
       VALUES ($1, $2, $3)`,
      [otherOrg, published.revisionId, published.version],
    )).rejects.toMatchObject({ code: '23503' })

    await expect(publishElearningPortalSettings(portalDb(firstPool), {
      ...input(orgId, 'actor-not-in-org'),
      requestId: randomUUID(),
    })).rejects.toMatchObject({ code: 'unavailable' })

    await expect(migrate(portalDown)).rejects.toThrow(
      'elearning portal migration down refused: authoritative rows exist',
    )
  })
})
