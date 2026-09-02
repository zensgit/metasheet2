import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { up as offlineUp } from '../../src/db/migrations/zzzz20260901100000_create_elearning_offline_training'
import {
  down as registrationDown,
  up as registrationUp,
} from '../../src/db/migrations/zzzz20260901150000_create_elearning_offline_registration'
import { ElearningOfflineError } from '../../src/services/elearning-offline-training'
import {
  changeElearningOfflineRegistration,
  listElearningOfflineRegistrations,
  listMyElearningOfflineTrainings,
  publishElearningOfflineTraining,
  setElearningOfflineTrainingStatus,
  type ElearningOfflineDb,
  type ElearningOfflineQueryable,
} from '../../src/services/elearning-offline-training-postgres'
import {
  assertSafeScratchDatabaseName,
  attachOwnedPoolTerminationHandler,
  dropScratchDatabase,
  formatScratchDropFailure,
  formatScratchDropOutcome,
} from '../helpers/scratch-database'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error('e-learning offline registration authority requires DATABASE_URL; refusing skip-shaped green')
}

const scratchPrefix = 'ms2_eloffline_reg_'
const scratchName = `${scratchPrefix}${randomUUID().replaceAll('-', '').slice(0, 12)}`
const ORG = `offline-registration-org-${randomUUID()}`
const OTHER_ORG = `offline-registration-org-${randomUUID()}`
const ADMIN = randomUUID()
const MEMBER = randomUUID()
const OUTSIDER = randomUUID()

let adminPool: Pool
let firstPool: Pool
let secondPool: Pool
let database: Kysely<unknown>

function scratchUrl(base: string, name: string): string {
  const url = new URL(base)
  url.pathname = `/${name}`
  return url.toString()
}

function runtimeDb(pool: Pool, afterRegistrationRead?: () => Promise<void>): ElearningOfflineDb {
  const query = async (target: Pool | PoolClient, text: string, params?: unknown[]) => {
    const result = await target.query(text, params as never)
    if (
      afterRegistrationRead
      && text.includes('FROM elearning_offline_registration_events')
      && text.includes('ORDER BY sequence DESC')
    ) await afterRegistrationRead()
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
  }
  return {
    query: (text, params) => query(pool, text, params),
    async transaction<T>(handler: (tx: ElearningOfflineQueryable) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await handler({ query: (text, params) => query(client, text, params) })
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

function twoReadBarrier(): () => Promise<void> {
  let arrivals = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return async () => {
    arrivals += 1
    if (arrivals === 2) release?.()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        gate,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 200)
        }),
      ])
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}

async function migrate(action: (db: Kysely<unknown>) => Promise<void>): Promise<void> {
  await database.transaction().execute((tx) => action(tx))
}

async function seedUser(pool: Pool, userId: string, orgId: string): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, is_active) VALUES ($1, true)
     ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active`,
    [userId],
  )
  await pool.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)
     ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = EXCLUDED.is_active`,
    [userId, orgId],
  )
}

function publishCommand() {
  const start = Date.now() + 60_000
  return {
    requestId: randomUUID(),
    title: 'Open registration training',
    location: 'Room R',
    attendanceMode: 'training',
    registrationEnabled: true,
    targets: [{
      title: 'Training',
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + 60_000).toISOString(),
      checkInOpensAt: new Date(start - 30_000).toISOString(),
      checkInClosesAt: new Date(start + 30_000).toISOString(),
      checkOutOpensAt: new Date(start + 30_000).toISOString(),
      checkOutClosesAt: new Date(start + 90_000).toISOString(),
    }],
    memberUserIds: [MEMBER],
  }
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElearningOfflineError)
  expect((error as ElearningOfflineError).code).toBe(code)
  expect((error as Error).message).toBe(code)
}

describe.sequential('e-learning offline registration PostgreSQL authority', () => {
  beforeAll(async () => {
    assertSafeScratchDatabaseName(scratchName)
    adminPool = new Pool({
      application_name: 'elearning-offline-registration-admin',
      connectionString: DATABASE_URL,
      max: 1,
    })
    await adminPool.query(`CREATE DATABASE ${scratchName}`)
    const url = scratchUrl(DATABASE_URL, scratchName)
    firstPool = new Pool({
      application_name: 'elearning-offline-registration-first',
      connectionString: url,
      max: 4,
    })
    secondPool = new Pool({
      application_name: 'elearning-offline-registration-second',
      connectionString: url,
      max: 4,
    })
    database = new Kysely({ dialect: new PostgresDialect({ pool: firstPool }) })
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
      )
    `)
    await seedUser(firstPool, ADMIN, ORG)
    await seedUser(firstPool, MEMBER, ORG)
    await seedUser(firstPool, OUTSIDER, OTHER_ORG)
  })

  afterAll(async () => {
    const firstTermination = firstPool ? attachOwnedPoolTerminationHandler(firstPool) : null
    const secondTermination = secondPool ? attachOwnedPoolTerminationHandler(secondPool) : null
    try {
      if (database) await database.destroy()
      if (secondPool) await secondPool.end()
      if (adminPool) {
        try {
          const outcome = await dropScratchDatabase(adminPool, scratchName)
          console.info(formatScratchDropOutcome('elearning-offline-registration', outcome))
          if (!outcome.drained || outcome.residualBackends !== 0) {
            throw new Error('offline registration scratch database did not drain cleanly')
          }
        } catch (error) {
          console.error(formatScratchDropFailure('elearning-offline-registration', error))
          throw error
        }
        const exact = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [scratchName])
        const prefix = await adminPool.query(
          'SELECT datname FROM pg_database WHERE datname LIKE $1',
          [`${scratchPrefix}%`],
        )
        if (exact.rows.length !== 0 || prefix.rows.length !== 0) {
          throw new Error('offline registration scratch database residue')
        }
      }
    } finally {
      firstTermination?.detach()
      secondTermination?.detach()
      if (adminPool) await adminPool.end()
    }
  })

  it('applies, replays, rolls back empty, reapplies and rejects column/trigger drift', async () => {
    await migrate(offlineUp)
    await migrate(registrationUp)
    await migrate(registrationUp)
    await migrate(offlineUp)
    await migrate(registrationDown)
    await migrate(registrationDown)
    await migrate(registrationUp)

    await firstPool.query(
      'ALTER TABLE elearning_offline_training_revisions ALTER COLUMN registration_enabled DROP NOT NULL',
    )
    await expect(migrate(offlineUp)).rejects.toThrow('column authority')
    await expect(migrate(registrationUp)).rejects.toThrow('schema drift')
    await firstPool.query(
      'ALTER TABLE elearning_offline_training_revisions ALTER COLUMN registration_enabled SET NOT NULL',
    )
    await migrate(registrationUp)

    await firstPool.query(
      'ALTER TABLE elearning_offline_registration_requests ALTER COLUMN created_at DROP DEFAULT',
    )
    await expect(migrate(registrationUp)).rejects.toThrow('schema drift')
    await firstPool.query(
      'ALTER TABLE elearning_offline_registration_requests ALTER COLUMN created_at SET DEFAULT now()',
    )
    await migrate(registrationUp)

    await firstPool.query(
      'DROP TRIGGER trg_elearning_offline_registration_events_immutable ON elearning_offline_registration_events',
    )
    await expect(migrate(registrationUp)).rejects.toThrow('schema drift')
    await firstPool.query(`
      CREATE TRIGGER trg_elearning_offline_registration_events_immutable
      BEFORE UPDATE OR DELETE ON elearning_offline_registration_events
      FOR EACH ROW EXECUTE FUNCTION elearning_offline_reject_change()
    `)
    await migrate(registrationUp)

    await firstPool.query(
      'DROP TRIGGER trg_elearning_offline_registration_events_immutable ON elearning_offline_registration_events',
    )
    await firstPool.query(`
      CREATE TRIGGER trg_elearning_offline_registration_events_immutable
      BEFORE UPDATE OR DELETE ON elearning_offline_registration_events
      FOR EACH ROW WHEN (false) EXECUTE FUNCTION elearning_offline_reject_change()
    `)
    await expect(migrate(registrationUp)).rejects.toThrow('schema drift')
    await firstPool.query(
      'DROP TRIGGER trg_elearning_offline_registration_events_immutable ON elearning_offline_registration_events',
    )
    await firstPool.query(`
      CREATE TRIGGER trg_elearning_offline_registration_events_immutable
      BEFORE UPDATE OR DELETE ON elearning_offline_registration_events
      FOR EACH ROW EXECUTE FUNCTION elearning_offline_reject_change()
    `)
    await migrate(registrationUp)

    await firstPool.query('CREATE SCHEMA offline_registration_decoy')
    await firstPool.query(`
      CREATE FUNCTION offline_registration_decoy.elearning_offline_reject_change()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$
    `)
    await firstPool.query(
      'DROP TRIGGER trg_elearning_offline_registration_requests_immutable ON elearning_offline_registration_requests',
    )
    await firstPool.query(`
      CREATE TRIGGER trg_elearning_offline_registration_requests_immutable
      BEFORE UPDATE OR DELETE ON elearning_offline_registration_requests
      FOR EACH ROW EXECUTE FUNCTION offline_registration_decoy.elearning_offline_reject_change()
    `)
    await expect(migrate(registrationUp)).rejects.toThrow('schema drift')
    await firstPool.query(
      'DROP TRIGGER trg_elearning_offline_registration_requests_immutable ON elearning_offline_registration_requests',
    )
    await firstPool.query(`
      CREATE TRIGGER trg_elearning_offline_registration_requests_immutable
      BEFORE UPDATE OR DELETE ON elearning_offline_registration_requests
      FOR EACH ROW EXECUTE FUNCTION elearning_offline_reject_change()
    `)
    await firstPool.query('DROP SCHEMA offline_registration_decoy CASCADE')
    await migrate(registrationUp)
  })

  it('registers and cancels an invited learner with exact replay and closed admin readback', async () => {
    const training = await publishElearningOfflineTraining(runtimeDb(firstPool), {
      orgId: ORG,
      actorId: ADMIN,
      command: publishCommand(),
    })
    expect(training.registrationEnabled).toBe(true)
    const requestId = randomUUID()
    const registered = await changeElearningOfflineRegistration(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
      trainingId: training.trainingId,
      command: { requestId, action: 'register' },
    })
    expect(registered).toMatchObject({ status: 'registered', duplicate: false })
    await expect(changeElearningOfflineRegistration(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
      trainingId: training.trainingId,
      command: { requestId, action: 'register' },
    })).resolves.toEqual({ ...registered, duplicate: true })
    await expect(changeElearningOfflineRegistration(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
      trainingId: training.trainingId,
      command: { requestId, action: 'cancel' },
    })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'conflict')
      return true
    })

    const learner = await listMyElearningOfflineTrainings(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
    })
    expect(learner[0]).toMatchObject({
      registrationEnabled: true,
      registrationStatus: 'registered',
    })
    await expect(listElearningOfflineRegistrations(runtimeDb(firstPool), {
      orgId: ORG,
      trainingId: training.trainingId,
      limit: 50,
    })).resolves.toEqual({
      items: [{
        userId: MEMBER,
        status: 'registered',
        changedAt: registered.changedAt,
      }],
      nextCursor: null,
    })

    await expect(changeElearningOfflineRegistration(runtimeDb(firstPool), {
      orgId: ORG,
      userId: OUTSIDER,
      trainingId: training.trainingId,
      command: { requestId: randomUUID(), action: 'register' },
    })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'forbidden')
      return true
    })

    await expect(changeElearningOfflineRegistration(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
      trainingId: training.trainingId,
      command: { requestId: randomUUID(), action: 'cancel' },
    })).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('serializes competing registration effects and lifecycle changes', async () => {
    const trainingRow = await firstPool.query(
      'SELECT id::text FROM elearning_offline_trainings WHERE org_id = $1 LIMIT 1',
      [ORG],
    )
    const trainingId = String(trainingRow.rows[0]?.id)
    const barrier = twoReadBarrier()
    const attempts = await Promise.allSettled([
      changeElearningOfflineRegistration(runtimeDb(firstPool, barrier), {
        orgId: ORG,
        userId: MEMBER,
        trainingId,
        command: { requestId: randomUUID(), action: 'register' },
      }),
      changeElearningOfflineRegistration(runtimeDb(secondPool, barrier), {
        orgId: ORG,
        userId: MEMBER,
        trainingId,
        command: { requestId: randomUUID(), action: 'register' },
      }),
    ])
    expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
    const rejected = attempts.find((entry) => entry.status === 'rejected')
    expectCode((rejected as PromiseRejectedResult).reason, 'conflict')
    const events = await firstPool.query(
      `SELECT sequence, action FROM elearning_offline_registration_events
       WHERE org_id = $1 AND user_id = $2 ORDER BY sequence`,
      [ORG, MEMBER],
    )
    expect(events.rows.map((row) => row.action)).toEqual(['register', 'cancel', 'register'])
    expect(events.rows.map((row) => row.sequence)).toEqual([1, 2, 3])

    await setElearningOfflineTrainingStatus(runtimeDb(firstPool), {
      orgId: ORG,
      actorId: ADMIN,
      trainingId,
      command: { requestId: randomUUID(), status: 'archived', reason: 'Registration closed' },
    })
    await expect(changeElearningOfflineRegistration(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
      trainingId,
      command: { requestId: randomUUID(), action: 'cancel' },
    })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'conflict')
      return true
    })

    const disabledTraining = await publishElearningOfflineTraining(runtimeDb(firstPool), {
      orgId: ORG,
      actorId: ADMIN,
      command: { ...publishCommand(), registrationEnabled: false },
    })
    await expect(changeElearningOfflineRegistration(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
      trainingId: disabledTraining.trainingId,
      command: { requestId: randomUUID(), action: 'register' },
    })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'disabled')
      return true
    })
    await expect(firstPool.query(
      `UPDATE elearning_offline_registration_events SET action = 'cancel'
       WHERE id = (SELECT id FROM elearning_offline_registration_events WHERE org_id = $1 LIMIT 1)`,
      [ORG],
    )).rejects.toMatchObject({ code: '23514' })
    await expect(migrate(registrationDown)).rejects.toThrow('rollback refused')
  })
})
