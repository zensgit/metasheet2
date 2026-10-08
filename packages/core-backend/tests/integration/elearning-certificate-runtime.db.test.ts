import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { up as creditLedgerUp } from '../../src/db/migrations/zzzz20260828150000_create_elearning_credit_ledger'
import {
  down as certificateDown,
  up as certificateUp,
} from '../../src/db/migrations/zzzz20260830150000_create_elearning_certificates'
import {
  ElearningCertificateSurfaceError,
  issueElearningCertificate,
  listMyElearningCertificates,
  publishElearningCertificateTemplate,
  type ElearningCertificateDb,
  type ElearningCertificateQueryable,
} from '../../src/services/elearning-certificate-surface'
import {
  assertSafeScratchDatabaseName,
  attachOwnedPoolTerminationHandler,
  dropScratchDatabase,
  formatScratchDropFailure,
  formatScratchDropOutcome,
} from '../helpers/scratch-database'

const DATABASE_URL = process.env.DATABASE_URL
const scratchPrefix = 'ms2_elcert_'
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

function surfaceDb(pool: Pool): ElearningCertificateDb {
  return {
    query: (text, params) => query(pool, text, params),
    async transaction<T>(
      handler: (tx: ElearningCertificateQueryable) => Promise<T>,
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

function templateInput(orgId: string, actorId: string, requestId = randomUUID()) {
  return {
    orgId,
    actorId,
    requestId,
    certificateId: 'course-completion',
    name: 'Course completion',
    templateText: '#learnerName# completed #courseName#',
    backgroundImageUrl: 'https://assets.example.test/certificate.png',
  }
}

function issueInput(
  orgId: string,
  actorId: string,
  userId: string,
  requestId = randomUUID(),
) {
  return {
    orgId,
    actorId,
    requestId,
    certificateId: 'course-completion',
    userId,
    parameters: { learnerName: 'Learner', courseName: 'Safety' },
  }
}

describe.sequential('e-learning certificate PostgreSQL authority', () => {
  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is required; refusing skip-shaped green')
    }
    assertSafeScratchDatabaseName(scratchName)
    adminPool = new Pool({
      application_name: 'elearning-certificate-admin',
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
      application_name: 'elearning-certificate-first',
      connectionString,
      max: 3,
    })
    secondPool = new Pool({
      application_name: 'elearning-certificate-second',
      connectionString,
      max: 2,
    })
    database = new Kysely({ dialect: new PostgresDialect({ pool: firstPool }) })
    await createMembershipSchema()
    await migrate(creditLedgerUp)
    await migrate(certificateUp)
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
          console.info(formatScratchDropOutcome('elearning-certificate', outcome))
        } catch (error) {
          console.error(formatScratchDropFailure('elearning-certificate', error))
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
          throw new Error('elearning certificate scratch database residue')
        }
      }
    } finally {
      firstTermination?.detach()
      secondTermination?.detach()
      if (adminPool) await adminPool.end()
    }
  }, 30_000)

  it('applies, replays, detects drift, rolls down twice, and reapplies empty', async () => {
    await migrate(certificateUp)

    await firstPool.query(`
      CREATE OR REPLACE FUNCTION elearning_credit_reject_immutable_write()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY INVOKER
      AS 'BEGIN RETURN OLD; END;'
    `)
    await expect(migrate(certificateUp)).rejects.toThrow(
      'elearning certificate migration drift: immutable function',
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
    await migrate(certificateUp)
    await firstPool.query(`
      ALTER TABLE elearning_certificate_issues
      DROP CONSTRAINT elearning_certificate_issues_hash_check
    `)
    await expect(migrate(certificateUp)).rejects.toThrow(
      'elearning certificate migration drift: check constraint set',
    )
    await firstPool.query(`
      ALTER TABLE elearning_certificate_issues
      ADD CONSTRAINT elearning_certificate_issues_hash_check
      CHECK (request_hash ~ '^[0-9A-F]{64}$' AND request_hash_version > 0)
    `)
    await expect(migrate(certificateUp)).rejects.toThrow(
      'elearning certificate migration drift: check constraint set',
    )
    await firstPool.query(`
      ALTER TABLE elearning_certificate_issues
      DROP CONSTRAINT elearning_certificate_issues_hash_check
    `)
    await firstPool.query(`
      ALTER TABLE elearning_certificate_issues
      ADD CONSTRAINT elearning_certificate_issues_hash_check
      CHECK (request_hash ~ '^[0-9a-f]{64}$' AND request_hash_version > 0)
    `)
    await migrate(certificateUp)

    await firstPool.query(`
      DROP TRIGGER elearning_certificate_issues_immutable_row
      ON elearning_certificate_issues
    `)
    await firstPool.query(`
      CREATE TRIGGER elearning_certificate_issues_immutable_row
      BEFORE UPDATE OR DELETE ON elearning_certificate_issues
      FOR EACH ROW WHEN (false)
      EXECUTE FUNCTION elearning_credit_reject_immutable_write()
    `)
    await expect(migrate(certificateUp)).rejects.toThrow(
      'elearning certificate migration drift: elearning_certificate_issues_immutable_row',
    )
    await firstPool.query(`
      DROP TRIGGER elearning_certificate_issues_immutable_row
      ON elearning_certificate_issues
    `)
    await firstPool.query(`
      CREATE TRIGGER elearning_certificate_issues_immutable_row
      BEFORE UPDATE OR DELETE ON elearning_certificate_issues
      FOR EACH ROW EXECUTE FUNCTION elearning_credit_reject_immutable_write()
    `)
    await migrate(certificateUp)

    await migrate(certificateDown)
    await migrate(certificateDown)
    expect(await firstPool.query(`
      SELECT to_regclass('elearning_certificate_heads') AS heads
    `).then((result) => result.rows)).toEqual([{ heads: null }])
    await migrate(certificateUp)
  })

  it('serializes template publishes into one versioned active head', async () => {
    const orgId = `org-certificate-template-${randomUUID()}`
    const actorId = `actor-certificate-template-${randomUUID()}`
    await seedMember(actorId, orgId)
    const requestId = randomUUID()
    const input = templateInput(orgId, actorId, requestId)
    const replays = await Promise.all([
      publishElearningCertificateTemplate(surfaceDb(firstPool), input),
      publishElearningCertificateTemplate(surfaceDb(secondPool), input),
    ])
    expect(replays[0]).toEqual(replays[1])
    expect(replays[0]?.version).toBe(1)

    const next = await publishElearningCertificateTemplate(
      surfaceDb(firstPool),
      { ...templateInput(orgId, actorId), name: 'Course completion v2' },
    )
    expect(next.version).toBe(2)
    expect(await firstPool.query(
      `SELECT head.latest_version, revision.version
         FROM elearning_certificate_heads head
         JOIN elearning_certificate_revisions revision
           ON revision.org_id = head.org_id
          AND revision.head_id = head.id
          AND revision.id = head.active_revision_id
        WHERE head.org_id = $1 AND head.certificate_key = $2`,
      [orgId, 'course-completion'],
    ).then((result) => result.rows)).toEqual([{ latest_version: 2, version: 2 }])

    await expect(publishElearningCertificateTemplate(
      surfaceDb(firstPool),
      { ...input, name: 'changed-value-must-not-leak' },
    )).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ElearningCertificateSurfaceError)
      expect((error as ElearningCertificateSurfaceError).code).toBe('conflict')
      expect(String(error)).not.toContain('changed-value-must-not-leak')
      return true
    })
  })

  it('issues exactly once with immutable parameter, revision, and serial snapshots', async () => {
    const orgId = `org-certificate-issue-${randomUUID()}`
    const actorId = `actor-certificate-issue-${randomUUID()}`
    const userId = `user-certificate-issue-${randomUUID()}`
    await seedMember(actorId, orgId)
    await seedMember(userId, orgId)
    await publishElearningCertificateTemplate(
      surfaceDb(firstPool),
      templateInput(orgId, actorId),
    )
    const requestId = randomUUID()
    const input = issueInput(orgId, actorId, userId, requestId)
    const replays = await Promise.all([
      issueElearningCertificate(surfaceDb(firstPool), input),
      issueElearningCertificate(surfaceDb(secondPool), input),
    ])
    expect(replays[0]).toEqual(replays[1])
    expect(replays[0]?.serialNumber).toMatch(/^[0-9a-f-]{36}$/)
    expect(await listMyElearningCertificates(surfaceDb(firstPool), orgId, userId))
      .toEqual([replays[0]])
    expect(await firstPool.query(
      `SELECT count(*)::int AS count
         FROM elearning_certificate_issues
        WHERE org_id = $1 AND source_key = $2`,
      [orgId, requestId],
    ).then((result) => result.rows)).toEqual([{ count: 1 }])

    await expect(issueElearningCertificate(surfaceDb(firstPool), {
      ...input,
      parameters: { learnerName: 'Learner', courseName: 'Changed' },
    })).rejects.toMatchObject({ code: 'conflict', message: 'conflict' })
  })

  it('enforces same-org active membership and immutable issue history', async () => {
    const orgId = `org-certificate-member-${randomUUID()}`
    const otherOrgId = `org-certificate-other-${randomUUID()}`
    const actorId = `actor-certificate-member-${randomUUID()}`
    const userId = `user-certificate-member-${randomUUID()}`
    await seedMember(actorId, orgId)
    await seedMember(userId, otherOrgId)
    await publishElearningCertificateTemplate(
      surfaceDb(firstPool),
      templateInput(orgId, actorId),
    )
    await expect(issueElearningCertificate(
      surfaceDb(firstPool),
      issueInput(orgId, actorId, userId),
    )).rejects.toMatchObject({ code: 'not_found' })
    await seedMember(userId, orgId)
    await issueElearningCertificate(
      surfaceDb(firstPool),
      issueInput(orgId, actorId, userId),
    )
    await expect(firstPool.query(
      `INSERT INTO elearning_certificate_issues (
         id, org_id, user_id, certificate_key, template_revision_id,
         actor_id, source_key, effect_key, request_hash,
         request_hash_version, serial_number, parameter_snapshot, issued_at
       )
       SELECT gen_random_uuid(), issue.org_id, issue.user_id,
              'different-certificate', issue.template_revision_id,
              issue.actor_id, $2, $3, issue.request_hash,
              issue.request_hash_version, gen_random_uuid(),
              issue.parameter_snapshot, issue.issued_at
         FROM elearning_certificate_issues issue
        WHERE issue.org_id = $1
        LIMIT 1`,
      [orgId, randomUUID(), randomUUID()],
    )).rejects.toThrow()
    for (const statement of [
      `UPDATE elearning_certificate_revisions SET name = name`,
      `DELETE FROM elearning_certificate_template_requests`,
      `UPDATE elearning_certificate_issues SET effect_key = effect_key`,
      `TRUNCATE elearning_certificate_issues`,
    ]) {
      await expect(firstPool.query(statement)).rejects.toThrow()
    }
  })

  it('refuses rollback after authoritative certificate rows exist', async () => {
    await expect(migrate(certificateDown)).rejects.toThrow(
      'elearning certificate migration down refused: authoritative rows exist',
    )
    await migrate(certificateUp)
  })
})
