import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  down as offlineDown,
  up as offlineUp,
} from '../../src/db/migrations/zzzz20260901100000_create_elearning_offline_training'
import { ElearningOfflineError } from '../../src/services/elearning-offline-training'
import {
  issueElearningOfflineQr,
  listMyElearningOfflineTrainings,
  publishElearningOfflineTraining,
  recordElearningOfflineAttendance,
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
  throw new Error('e-learning offline training authority requires DATABASE_URL; refusing skip-shaped green')
}

const scratchPrefix = 'ms2_eloffline_'
const scratchName = `${scratchPrefix}${randomUUID().replaceAll('-', '').slice(0, 12)}`
const SECRET = 'offline-realdb-secret-with-at-least-thirty-two-bytes'
const ENV = { ELEARNING_OFFLINE_QR_SIGNING_SECRET: SECRET } as NodeJS.ProcessEnv
const ORG = `offline-org-${randomUUID()}`
const OTHER_ORG = `offline-org-${randomUUID()}`
const ADMIN = randomUUID()
const MEMBER = randomUUID()
const OTHER_MEMBER = randomUUID()

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

function runtimeDb(
  pool: Pool,
  beforeQuery?: (text: string, params: unknown[] | undefined) => Promise<void> | void,
): ElearningOfflineDb {
  const runQuery = async (target: Pool | PoolClient, text: string, params?: unknown[]) => {
    await beforeQuery?.(text, params)
    return query(target, text, params)
  }
  return {
    query: (text, params) => runQuery(pool, text, params),
    async transaction<T>(handler: (tx: ElearningOfflineQueryable) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await handler({ query: (text, params) => runQuery(client, text, params) })
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function bounded(promise: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('offline training concurrency barrier timeout')), 2_000)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function migrate(action: (db: Kysely<unknown>) => Promise<void>): Promise<void> {
  await database.transaction().execute((tx) => action(tx))
}

function at(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

function publishCommand(requestId = randomUUID()) {
  return {
    requestId,
    title: 'Safety training',
    location: 'Room A',
    attendanceMode: 'training',
    targets: [{
      title: 'Full training',
      startsAt: at(-60_000),
      endsAt: at(60_000),
      checkInOpensAt: at(-60_000),
      checkInClosesAt: at(60_000),
      checkOutOpensAt: at(-30_000),
      checkOutClosesAt: at(90_000),
    }],
    memberUserIds: [MEMBER],
  }
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

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElearningOfflineError)
  expect((error as ElearningOfflineError).code).toBe(code)
  expect((error as Error).message).toBe(code)
}

describe.sequential('e-learning offline training PostgreSQL authority', () => {
  beforeAll(async () => {
    assertSafeScratchDatabaseName(scratchName)
    adminPool = new Pool({
      application_name: 'elearning-offline-admin',
      connectionString: DATABASE_URL,
      max: 1,
    })
    await adminPool.query(`CREATE DATABASE ${scratchName}`)
    const url = scratchUrl(DATABASE_URL, scratchName)
    firstPool = new Pool({
      application_name: 'elearning-offline-first',
      connectionString: url,
      max: 4,
    })
    secondPool = new Pool({
      application_name: 'elearning-offline-second',
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
    await seedUser(firstPool, OTHER_MEMBER, OTHER_ORG)
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
          console.info(formatScratchDropOutcome('elearning-offline-training', outcome))
          if (!outcome.drained || outcome.residualBackends !== 0) {
            throw new Error('offline training scratch database did not drain cleanly')
          }
        } catch (error) {
          console.error(formatScratchDropFailure('elearning-offline-training', error))
          throw error
        }
        const exact = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [scratchName])
        const prefix = await adminPool.query(
          'SELECT datname FROM pg_database WHERE datname LIKE $1',
          [`${scratchPrefix}%`],
        )
        if (exact.rows.length !== 0 || prefix.rows.length !== 0) {
          throw new Error('offline training scratch database residue')
        }
      }
    } finally {
      firstTermination?.detach()
      secondTermination?.detach()
      if (adminPool) await adminPool.end()
    }
  })

  it('applies, replays, rolls back empty, reapplies and rejects structural drift', async () => {
    await migrate(offlineUp)
    await migrate(offlineUp)
    const triggerCount = await firstPool.query(
      `SELECT count(*)::integer AS count FROM pg_trigger tg
       JOIN pg_class rel ON rel.oid = tg.tgrelid
       WHERE rel.relname LIKE 'elearning_offline_%' AND NOT tg.tgisinternal`,
    )
    expect(triggerCount.rows[0]?.count).toBe(20)
    await migrate(offlineDown)
    await migrate(offlineDown)
    await migrate(offlineUp)

    await firstPool.query(
      'ALTER TABLE elearning_offline_training_targets ALTER COLUMN title DROP NOT NULL',
    )
    await expect(migrate(offlineUp)).rejects.toThrow('column authority')
    await firstPool.query(
      'ALTER TABLE elearning_offline_training_targets ALTER COLUMN title SET NOT NULL',
    )
    await migrate(offlineUp)

    await firstPool.query(
      'ALTER TABLE elearning_offline_training_revisions ALTER COLUMN created_at DROP DEFAULT',
    )
    await expect(migrate(offlineUp)).rejects.toThrow('column authority')
    await firstPool.query(
      'ALTER TABLE elearning_offline_training_revisions ALTER COLUMN created_at SET DEFAULT now()',
    )
    await migrate(offlineUp)

    await firstPool.query(
      'ALTER TABLE elearning_offline_qr_challenges DROP CONSTRAINT elearning_offline_challenges_target_fk',
    )
    await firstPool.query(`
      ALTER TABLE elearning_offline_qr_challenges
      ADD CONSTRAINT elearning_offline_challenges_target_fk
      FOREIGN KEY (org_id, target_id)
      REFERENCES elearning_offline_training_targets(org_id, id)
      ON DELETE RESTRICT
    `)
    await expect(migrate(offlineUp)).rejects.toThrow('constraint set')
    await firstPool.query(
      'ALTER TABLE elearning_offline_qr_challenges DROP CONSTRAINT elearning_offline_challenges_target_fk',
    )
    await firstPool.query(`
      ALTER TABLE elearning_offline_qr_challenges
      ADD CONSTRAINT elearning_offline_challenges_target_fk
      FOREIGN KEY (org_id, training_id, revision_id, target_id)
      REFERENCES elearning_offline_training_targets(org_id, training_id, revision_id, id)
      ON DELETE RESTRICT
    `)
    await migrate(offlineUp)

    await firstPool.query(
      'ALTER TABLE elearning_offline_attendance_requests DROP CONSTRAINT elearning_offline_attendance_requests_event_fk',
    )
    await firstPool.query(`
      ALTER TABLE elearning_offline_attendance_requests
      ADD CONSTRAINT elearning_offline_attendance_requests_event_fk
      FOREIGN KEY (org_id, event_id)
      REFERENCES elearning_offline_attendance_events(org_id, id)
      ON DELETE RESTRICT
    `)
    await expect(migrate(offlineUp)).rejects.toThrow('constraint set')
    await firstPool.query(
      'ALTER TABLE elearning_offline_attendance_requests DROP CONSTRAINT elearning_offline_attendance_requests_event_fk',
    )
    await firstPool.query(`
      ALTER TABLE elearning_offline_attendance_requests
      ADD CONSTRAINT elearning_offline_attendance_requests_event_fk
      FOREIGN KEY (org_id, user_id, event_id)
      REFERENCES elearning_offline_attendance_events(org_id, user_id, id)
      ON DELETE RESTRICT
    `)
    await migrate(offlineUp)

    await firstPool.query('DROP INDEX elearning_offline_challenges_active_uniq')
    await expect(migrate(offlineUp)).rejects.toThrow('index set')
    await firstPool.query(`
      CREATE UNIQUE INDEX elearning_offline_challenges_active_uniq
      ON elearning_offline_qr_challenges(org_id, revision_id, target_id, action)
      WHERE superseded_at IS NULL
    `)
    await migrate(offlineUp)

    await firstPool.query(`
      CREATE INDEX elearning_offline_attendance_requests_extra_idx
      ON elearning_offline_attendance_requests(created_at)
    `)
    await expect(migrate(offlineUp)).rejects.toThrow('index set')
    await firstPool.query('DROP INDEX elearning_offline_attendance_requests_extra_idx')
    await migrate(offlineUp)

    await firstPool.query(`
      CREATE TRIGGER trg_elearning_offline_attendance_requests_extra
      BEFORE INSERT ON elearning_offline_attendance_requests
      FOR EACH ROW EXECUTE FUNCTION elearning_offline_reject_change()
    `)
    await expect(migrate(offlineUp)).rejects.toThrow('trigger set')
    await firstPool.query(
      'DROP TRIGGER trg_elearning_offline_attendance_requests_extra ON elearning_offline_attendance_requests',
    )
    await migrate(offlineUp)

    await firstPool.query('DROP TRIGGER trg_elearning_offline_publish_authority ON elearning_offline_trainings')
    await firstPool.query(`
      CREATE CONSTRAINT TRIGGER trg_elearning_offline_publish_authority
      AFTER INSERT ON elearning_offline_trainings
      DEFERRABLE INITIALLY IMMEDIATE
      FOR EACH ROW EXECUTE FUNCTION elearning_offline_publish_authority()
    `)
    await expect(migrate(offlineUp)).rejects.toThrow('constraint set')
    await firstPool.query('DROP TRIGGER trg_elearning_offline_publish_authority ON elearning_offline_trainings')
    await firstPool.query(`
      CREATE CONSTRAINT TRIGGER trg_elearning_offline_publish_authority
      AFTER INSERT ON elearning_offline_trainings
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION elearning_offline_publish_authority()
    `)
    await migrate(offlineUp)
  })

  it('publishes an immutable member snapshot with exact replay/conflict semantics', async () => {
    const requestId = randomUUID()
    const command = publishCommand(requestId)
    const created = await publishElearningOfflineTraining(runtimeDb(firstPool), {
      orgId: ORG,
      actorId: ADMIN,
      command,
    })
    expect(created.duplicate).toBe(false)
    expect(created.memberCount).toBe(1)
    expect(created.targets).toHaveLength(1)
    const replay = await publishElearningOfflineTraining(runtimeDb(firstPool), {
      orgId: ORG,
      actorId: ADMIN,
      command,
    })
    expect(replay).toEqual({ ...created, duplicate: true })
    await expect(publishElearningOfflineTraining(runtimeDb(firstPool), {
      orgId: ORG,
      actorId: ADMIN,
      command: { ...command, title: 'Different title' },
    })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'conflict')
      return true
    })
    await expect(firstPool.query(
      'UPDATE elearning_offline_training_members SET user_id = $1 WHERE org_id = $2',
      [OTHER_MEMBER, ORG],
    )).rejects.toMatchObject({ code: '23514' })
    await expect(firstPool.query('TRUNCATE elearning_offline_attendance_requests')).rejects
      .toMatchObject({ code: '23514' })
  })

  it('rotates dynamic QR challenges and replays the same token by request identity', async () => {
    const training = (await listMyElearningOfflineTrainings(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
    }))[0]!
    const targetId = training.targets[0]!.targetId
    const requestId = randomUUID()
    const first = await issueElearningOfflineQr(runtimeDb(firstPool), {
      orgId: ORG,
      actorId: ADMIN,
      command: { requestId, trainingId: training.trainingId, targetId, action: 'check_in' },
    }, ENV)
    expect(first.duplicate).toBe(false)
    expect(JSON.stringify(first)).not.toMatch(/challengeId|orgId|digest/)
    const replay = await issueElearningOfflineQr(runtimeDb(firstPool), {
      orgId: ORG,
      actorId: ADMIN,
      command: { requestId, trainingId: training.trainingId, targetId, action: 'check_in' },
    }, ENV)
    expect(replay).toEqual({ ...first, duplicate: true })
    const rotated = await issueElearningOfflineQr(runtimeDb(firstPool), {
      orgId: ORG,
      actorId: ADMIN,
      command: { requestId: randomUUID(), trainingId: training.trainingId, targetId, action: 'check_in' },
    }, ENV)
    expect(rotated.token).not.toBe(first.token)
    await expect(issueElearningOfflineQr(runtimeDb(firstPool), {
      orgId: ORG,
      actorId: ADMIN,
      command: { requestId, trainingId: training.trainingId, targetId, action: 'check_in' },
    }, ENV)).resolves.toEqual({ ...first, duplicate: true })
    await expect(recordElearningOfflineAttendance(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
      command: { requestId: randomUUID(), token: first.token },
    }, ENV)).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'invalid_token')
      return true
    })
  })

  it('serializes concurrent QR issuances by target and action before rotation', async () => {
    const training = (await listMyElearningOfflineTrainings(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
    }))[0]!
    const targetId = training.targets[0]!.targetId
    const firstAtRotation = deferred()
    const releaseFirst = deferred()
    const secondAtEffectLock = deferred()
    const firstDb = runtimeDb(firstPool, async (text) => {
      if (text.includes('UPDATE elearning_offline_qr_challenges')) {
        firstAtRotation.resolve()
        await releaseFirst.promise
      }
    })
    const secondDb = runtimeDb(secondPool, (text, params) => {
      if (text.includes('pg_advisory_xact_lock') && params?.[0] === 'elearning-offline-qr-effect') {
        secondAtEffectLock.resolve()
      }
    })
    const first = issueElearningOfflineQr(firstDb, {
      orgId: ORG,
      actorId: ADMIN,
      command: {
        requestId: randomUUID(), trainingId: training.trainingId, targetId, action: 'check_in',
      },
    }, ENV)
    await bounded(firstAtRotation.promise)
    const second = issueElearningOfflineQr(secondDb, {
      orgId: ORG,
      actorId: ADMIN,
      command: {
        requestId: randomUUID(), trainingId: training.trainingId, targetId, action: 'check_in',
      },
    }, ENV)
    await bounded(secondAtEffectLock.promise)
    releaseFirst.resolve()
    const results = await Promise.all([first, second])
    expect(results[0].token).not.toBe(results[1].token)
    expect(results.map((result) => result.duplicate)).toEqual([false, false])
    const active = await firstPool.query(
      `SELECT count(*)::integer AS count
       FROM elearning_offline_qr_challenges
       WHERE org_id = $1 AND revision_id = $2::uuid AND target_id = $3::uuid
         AND action = 'check_in' AND superseded_at IS NULL`,
      [ORG, training.revisionId, targetId],
    )
    expect(active.rows[0]?.count).toBe(1)
  })

  it('records check-in then check-out and derives completion without a second truth table', async () => {
    const training = (await listMyElearningOfflineTrainings(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
    }))[0]!
    const targetId = training.targets[0]!.targetId
    const checkoutBefore = await issueElearningOfflineQr(runtimeDb(firstPool), {
      orgId: ORG,
      actorId: ADMIN,
      command: {
        requestId: randomUUID(), trainingId: training.trainingId, targetId, action: 'check_out',
      },
    }, ENV)
    await expect(recordElearningOfflineAttendance(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
      command: { requestId: randomUUID(), token: checkoutBefore.token },
    }, ENV)).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'check_in_required')
      return true
    })

    const checkinQr = await issueElearningOfflineQr(runtimeDb(firstPool), {
      orgId: ORG,
      actorId: ADMIN,
      command: {
        requestId: randomUUID(), trainingId: training.trainingId, targetId, action: 'check_in',
      },
    }, ENV)
    const checkinRequest = randomUUID()
    const checkin = await recordElearningOfflineAttendance(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
      command: { requestId: checkinRequest, token: checkinQr.token },
    }, ENV)
    expect(checkin).toMatchObject({
      action: 'check_in', targetStatus: 'checked_in', completionStatus: 'in_progress', duplicate: false,
    })
    expect(await recordElearningOfflineAttendance(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
      command: { requestId: checkinRequest, token: checkinQr.token },
    }, ENV)).toEqual({ ...checkin, duplicate: true })

    const checkoutQr = await issueElearningOfflineQr(runtimeDb(firstPool), {
      orgId: ORG,
      actorId: ADMIN,
      command: {
        requestId: randomUUID(), trainingId: training.trainingId, targetId, action: 'check_out',
      },
    }, ENV)
    const checkout = await recordElearningOfflineAttendance(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
      command: { requestId: randomUUID(), token: checkoutQr.token },
    }, ENV)
    expect(checkout).toMatchObject({
      action: 'check_out', targetStatus: 'checked_out', completionStatus: 'completed',
      completedTargetCount: 1, totalTargetCount: 1,
    })
    const mine = await listMyElearningOfflineTrainings(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
    })
    expect(mine[0]).toMatchObject({ completionStatus: 'completed' })
    expect(mine[0]!.targets[0]).toMatchObject({ attendanceStatus: 'checked_out' })
  })

  it('serializes two request identities onto one attendance effect', async () => {
    const command = publishCommand()
    command.memberUserIds = [MEMBER]
    const training = await publishElearningOfflineTraining(runtimeDb(firstPool), {
      orgId: ORG,
      actorId: ADMIN,
      command,
    })
    const targetId = training.targets[0]!.targetId
    const qr = await issueElearningOfflineQr(runtimeDb(firstPool), {
      orgId: ORG,
      actorId: ADMIN,
      command: {
        requestId: randomUUID(), trainingId: training.trainingId, targetId, action: 'check_in',
      },
    }, ENV)
    const [first, second] = await Promise.all([
      recordElearningOfflineAttendance(runtimeDb(firstPool), {
        orgId: ORG, userId: MEMBER, command: { requestId: randomUUID(), token: qr.token },
      }, ENV),
      recordElearningOfflineAttendance(runtimeDb(secondPool), {
        orgId: ORG, userId: MEMBER, command: { requestId: randomUUID(), token: qr.token },
      }, ENV),
    ])
    expect(first.eventId).toBe(second.eventId)
    expect([first.duplicate, second.duplicate].sort()).toEqual([false, true])
    const count = await firstPool.query(
      `SELECT count(*)::integer AS count FROM elearning_offline_attendance_events
       WHERE org_id = $1 AND revision_id = $2 AND target_id = $3
         AND user_id = $4 AND action = 'check_in'`,
      [ORG, training.revisionId, targetId, MEMBER],
    )
    expect(count.rows[0]?.count).toBe(1)
    await expect(firstPool.query(
      `INSERT INTO elearning_offline_attendance_requests
         (org_id, user_id, request_id, request_hash, request_hash_version, event_id)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      [ORG, OTHER_MEMBER, randomUUID(), 'a'.repeat(64), first.eventId],
    )).rejects.toMatchObject({ code: '23503' })
  })

  it('fails closed across organizations, inactive membership and nonempty rollback', async () => {
    const mine = (await listMyElearningOfflineTrainings(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
    }))[0]!
    const qr = await issueElearningOfflineQr(runtimeDb(firstPool), {
      orgId: ORG,
      actorId: ADMIN,
      command: {
        requestId: randomUUID(),
        trainingId: mine.trainingId,
        targetId: mine.targets[0]!.targetId,
        action: 'check_in',
      },
    }, ENV)
    await expect(recordElearningOfflineAttendance(runtimeDb(firstPool), {
      orgId: OTHER_ORG,
      userId: OTHER_MEMBER,
      command: { requestId: randomUUID(), token: qr.token },
    }, ENV)).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'invalid_token')
      return true
    })
    await firstPool.query(
      'UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2',
      [MEMBER, ORG],
    )
    await expect(recordElearningOfflineAttendance(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
      command: { requestId: randomUUID(), token: qr.token },
    }, ENV)).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'forbidden')
      return true
    })
    await expect(listMyElearningOfflineTrainings(runtimeDb(firstPool), {
      orgId: ORG,
      userId: MEMBER,
    })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'forbidden')
      return true
    })
    await firstPool.query(
      'UPDATE user_orgs SET is_active = true WHERE user_id = $1 AND org_id = $2',
      [MEMBER, ORG],
    )
    await expect(migrate(offlineDown)).rejects.toThrow('authoritative rows exist')
  })
})
