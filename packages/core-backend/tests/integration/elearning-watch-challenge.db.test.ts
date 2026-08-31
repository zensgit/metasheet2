import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  down as challengeDown,
  up as challengeUp,
} from '../../src/db/migrations/zzzz20260831160000_create_elearning_watch_challenges'
import {
  acknowledgeElearningWatchChallenge,
  ElearningWatchError,
  recordElearningHeartbeat,
  startElearningWatch,
  type ElearningWatchDb,
  type ElearningWatchQueryable,
} from '../../src/services/elearning-watch-progress'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error('watch challenge DB gate requires DATABASE_URL; refusing skip-shaped green')
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 6 })
const kysely = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
const NS = `el-wchallenge-${randomUUID().slice(0, 8)}`
const ORG = `${NS}-org`
const OTHER_ORG = `${NS}-other`
const USER = `${NS}-user`

async function query(
  target: Pool,
  text: string,
  params?: unknown[],
): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> {
  const result = await target.query(text, params as never)
  return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
}

const db: ElearningWatchDb = {
  query: (text, params) => query(pool, text, params),
  async transaction<T>(run: (tx: ElearningWatchQueryable) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const value = await run({
        query: async (text, params) => {
          const result = await client.query(text, params as never)
          return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
        },
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

interface Seed {
  itemId: string
  sessionId: string
}

async function seed(): Promise<Seed> {
  const courseId = randomUUID()
  const versionId = randomUUID()
  const mediaId = randomUUID()
  const videoItemId = randomUUID()
  const examItemId = randomUUID()
  const examId = randomUUID()
  const questionId = randomUUID()
  const revisionId = randomUUID()
  const assignmentId = randomUUID()
  const memberId = randomUUID()

  await pool.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES ($1, $2, 'Challenge course', 'active', $3)`,
    [courseId, ORG, `${NS}-author`],
  )
  await pool.query(
    `INSERT INTO elearning_course_versions
       (id, org_id, course_id, version, status, title, created_by)
     VALUES ($1, $2, $3, 1, 'draft', 'Version', $4)`,
    [versionId, ORG, courseId, `${NS}-author`],
  )
  await pool.query(
    `INSERT INTO elearning_media (
       id, org_id, storage_key, mime_type, magic_mime_type, size_bytes,
       sha256, duration_ms, status, created_by
     ) VALUES ($1, $2, $3, 'video/mp4', 'video/mp4', 1024, $4, 100000, 'ready', $5)`,
    [mediaId, ORG, `${NS}/video`, 'a'.repeat(64), `${NS}-author`],
  )
  await pool.query(
    `INSERT INTO elearning_questions (id, org_id, created_by) VALUES ($1, $2, $3)`,
    [questionId, ORG, `${NS}-author`],
  )
  await pool.query(
    `INSERT INTO elearning_question_revisions (
       id, org_id, question_id, revision, question_type, prompt, options,
       answer_key, points, created_by
     ) VALUES ($1, $2, $3, 1, 'single_choice', 'Question', $4::jsonb, $5::jsonb, 10, $6)`,
    [
      revisionId, ORG, questionId,
      JSON.stringify([{ id: 'a', text: 'A' }]),
      JSON.stringify({ correct: ['a'] }), `${NS}-author`,
    ],
  )
  await pool.query(
    `INSERT INTO elearning_exams
       (id, org_id, title, status, pass_score, max_attempts, created_by)
     VALUES ($1, $2, 'Exam', 'draft', 10, 1, $3)`,
    [examId, ORG, `${NS}-author`],
  )
  await pool.query(
    `INSERT INTO elearning_exam_questions
       (org_id, exam_id, question_revision_id, position, points)
     VALUES ($1, $2, $3, 1, 10)`,
    [ORG, examId, revisionId],
  )
  await pool.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position, media_id, exam_id,
       completion_policy_version, completion_threshold_bps,
       watch_challenge_policy_revision, watch_challenge_count,
       watch_challenge_min_duration_ms, watch_challenge_response_window_ms
     ) VALUES (
       $1, $2, $3, 'video', 1, $4, NULL, 'video-v1-90pct', 9000,
       'watch-challenge-v1', 1, 1, 120000
     )`,
    [videoItemId, ORG, versionId, mediaId],
  )
  await pool.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position, media_id, exam_id,
       completion_policy_version, completion_threshold_bps
     ) VALUES ($1, $2, $3, 'exam', 2, NULL, $4, NULL, NULL)`,
    [examItemId, ORG, versionId, examId],
  )
  await pool.query(
    `UPDATE elearning_exams SET status = 'published' WHERE org_id = $1 AND id = $2`,
    [ORG, examId],
  )
  await pool.query(
    `UPDATE elearning_course_versions SET status = 'published' WHERE org_id = $1 AND id = $2`,
    [ORG, versionId],
  )
  await pool.query(
    `INSERT INTO elearning_assignments (
       id, org_id, course_version_id, source_key, request_hash,
       request_hash_version, deadline, assigned_by
     ) VALUES ($1, $2, $3, $4, $5, 1, NULL, $6)`,
    [assignmentId, ORG, versionId, `${NS}-source-${assignmentId}`, `hash-${assignmentId}`, `${NS}-admin`],
  )
  await pool.query(
    `INSERT INTO elearning_assignment_members (
       id, org_id, assignment_id, user_id, course_version_id, source
     ) VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [memberId, ORG, assignmentId, USER, versionId],
  )
  const started = await startElearningWatch(db, {
    orgId: ORG,
    userId: USER,
    itemId: videoItemId,
    challengeEnabled: true,
  })
  if (!started.sessionId) throw new Error('session unavailable')
  return { itemId: videoItemId, sessionId: started.sessionId }
}

async function heartbeat(seedRow: Seed, sequence: number, positionMs: number) {
  await pool.query(
    `UPDATE elearning_learning_sessions
        SET last_event_at = clock_timestamp() - interval '30 seconds'
      WHERE org_id = $1 AND id = $2`,
    [ORG, seedRow.sessionId],
  )
  return recordElearningHeartbeat(db, {
    orgId: ORG,
    userId: USER,
    sessionId: seedRow.sessionId,
    sequence,
    positionMs,
    playing: true,
    challengeEnabled: true,
  })
}

async function issueChallenge(seedRow: Seed) {
  for (let sequence = 1; sequence <= 5; sequence += 1) {
    const state = await heartbeat(seedRow, sequence, sequence * 20_000)
    if (state.challenge) return { sequence, state }
  }
  throw new Error('challenge was not issued')
}

async function pinFirstCheckpoint(sessionId: string): Promise<void> {
  await pool.query(
    `ALTER TABLE elearning_watch_challenge_schedules
       DISABLE TRIGGER trg_elearning_watch_challenge_schedules_authority`,
  )
  try {
    await pool.query(
      `UPDATE elearning_watch_challenge_schedules
          SET checkpoints = '[{"ordinal":1,"targetTrustedMs":1}]'::jsonb
        WHERE org_id = $1 AND session_id = $2`,
      [ORG, sessionId],
    )
  } finally {
    await pool.query(
      `ALTER TABLE elearning_watch_challenge_schedules
         ENABLE TRIGGER trg_elearning_watch_challenge_schedules_authority`,
    )
  }
}

async function cleanup(): Promise<void> {
  const tables = [
    'elearning_watch_challenge_requests',
    'elearning_watch_challenge_events',
    'elearning_watch_challenge_schedules',
    'elearning_completion_evidence',
    'elearning_progress',
    'elearning_progress_events',
    'elearning_learning_sessions',
    'elearning_assignment_members',
    'elearning_assignments',
    'elearning_course_version_items',
    'elearning_exam_questions',
    'elearning_exams',
    'elearning_question_revisions',
    'elearning_questions',
    'elearning_media',
    'elearning_course_versions',
    'elearning_courses',
  ]
  for (const table of tables) {
    await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`)
  }
  try {
    await pool.query('DELETE FROM elearning_watch_challenge_requests WHERE org_id = $1', [ORG])
    await pool.query('DELETE FROM elearning_watch_challenge_events WHERE org_id = $1', [ORG])
    await pool.query('DELETE FROM elearning_watch_challenge_schedules WHERE org_id = $1', [ORG])
    await pool.query('DELETE FROM elearning_completion_evidence WHERE org_id = $1', [ORG])
    await pool.query('DELETE FROM elearning_progress WHERE org_id = $1', [ORG])
    await pool.query('DELETE FROM elearning_progress_events WHERE org_id = $1', [ORG])
    await pool.query('DELETE FROM elearning_learning_sessions WHERE org_id = $1', [ORG])
    await pool.query('DELETE FROM elearning_assignment_members WHERE org_id = $1', [ORG])
    await pool.query('DELETE FROM elearning_assignments WHERE org_id = $1', [ORG])
    await pool.query('DELETE FROM elearning_course_version_items WHERE org_id = $1', [ORG])
    await pool.query('DELETE FROM elearning_exam_questions WHERE org_id = $1', [ORG])
    await pool.query('DELETE FROM elearning_exams WHERE org_id = $1', [ORG])
    await pool.query('DELETE FROM elearning_question_revisions WHERE org_id = $1', [ORG])
    await pool.query('DELETE FROM elearning_questions WHERE org_id = $1', [ORG])
    await pool.query('DELETE FROM elearning_media WHERE org_id = $1', [ORG])
    await pool.query(`UPDATE elearning_courses SET active_version_id = NULL, latest_version_id = NULL WHERE org_id = $1`, [ORG])
    await pool.query('DELETE FROM elearning_course_versions WHERE org_id = $1', [ORG])
    await pool.query('DELETE FROM elearning_courses WHERE org_id = $1', [ORG])
  } finally {
    for (const table of [...tables].reverse()) {
      await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`)
    }
  }
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ElearningWatchError)
  expect((error as ElearningWatchError).code).toBe(code)
  expect((error as Error).message).toBe(code)
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe.sequential('elearning watch challenge PostgreSQL authority', () => {
  beforeAll(async () => {
    await kysely.transaction().execute((tx) => challengeUp(tx))
  })

  afterAll(async () => {
    await cleanup()
    await kysely.destroy()
  })

  it('replays the canonical migration and rejects constraint, function, and default drift', async () => {
    await kysely.transaction().execute((tx) => challengeUp(tx))
    await pool.query(
      `ALTER TABLE elearning_course_version_items
         DROP CONSTRAINT elearning_course_version_items_watch_challenge_chk`,
    )
    await expect(kysely.transaction().execute((tx) => challengeUp(tx))).rejects.toThrow(
      'migration drift: constraints',
    )
    await pool.query(`
      ALTER TABLE elearning_course_version_items
        ADD CONSTRAINT elearning_course_version_items_watch_challenge_chk CHECK (
          watch_challenge_count IS NULL OR watch_challenge_count >= 1
        )
    `)
    await expect(kysely.transaction().execute((tx) => challengeUp(tx))).rejects.toThrow(
      'migration drift: constraints',
    )
    await kysely.transaction().execute((tx) => challengeDown(tx))
    await kysely.transaction().execute((tx) => challengeUp(tx))

    await pool.query(`
      CREATE OR REPLACE FUNCTION elearning_watch_challenge_deny_mutation()
      RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RETURN COALESCE(NEW, OLD);
      END
      $fn$
    `)
    await expect(kysely.transaction().execute((tx) => challengeUp(tx))).rejects.toThrow(
      'migration drift: functions',
    )
    await kysely.transaction().execute((tx) => challengeDown(tx))
    await kysely.transaction().execute((tx) => challengeUp(tx))

    await pool.query(`
      ALTER TABLE elearning_watch_challenge_schedules
        ALTER COLUMN updated_at DROP DEFAULT
    `)
    await expect(kysely.transaction().execute((tx) => challengeUp(tx))).rejects.toThrow(
      'migration drift: defaults',
    )
    await pool.query(`
      ALTER TABLE elearning_watch_challenge_schedules
        ALTER COLUMN updated_at SET DEFAULT now()
    `)
    await kysely.transaction().execute((tx) => challengeUp(tx))
  })

  it('accepts the exact canonical item challenge policy definition after rebuild', async () => {
    await pool.query(
      `ALTER TABLE elearning_course_version_items
         DROP CONSTRAINT elearning_course_version_items_watch_challenge_chk`,
    )
    await pool.query(`
      ALTER TABLE elearning_course_version_items
        ADD CONSTRAINT elearning_course_version_items_watch_challenge_chk CHECK (
          (watch_challenge_policy_revision IS NULL AND watch_challenge_count IS NULL
            AND watch_challenge_min_duration_ms IS NULL
            AND watch_challenge_response_window_ms IS NULL)
          OR (item_type = 'video' AND watch_challenge_policy_revision IS NOT NULL
            AND btrim(watch_challenge_policy_revision) <> ''
            AND watch_challenge_count BETWEEN 1 AND 10
            AND watch_challenge_min_duration_ms > 0
            AND watch_challenge_response_window_ms BETWEEN 1 AND 120000)
        )
    `)
    await kysely.transaction().execute((tx) => challengeUp(tx))
  })

  it('holds eligible watch time provisionally and commits it only on a timely ack replay', async () => {
    const seeded = await seed()
    await pinFirstCheckpoint(seeded.sessionId)
    const issued = await issueChallenge(seeded)
    const challenge = issued.state.challenge!
    expect(issued.state.creditedMs).toBe(0)
    const before = issued.state.effectiveMs
    const provisional = await heartbeat(seeded, issued.sequence + 1, (issued.sequence + 1) * 20_000)
    expect(provisional.effectiveMs).toBe(before)
    expect(provisional.creditedMs).toBe(0)
    expect(provisional.challenge?.challengeId).toBe(challenge.challengeId)

    const requestId = randomUUID()
    const ack = await acknowledgeElearningWatchChallenge(db, {
      orgId: ORG,
      userId: USER,
      sessionId: seeded.sessionId,
      challengeId: challenge.challengeId,
      requestId,
    })
    expect(ack.challenge).toBeNull()
    expect(ack.effectiveMs).toBeGreaterThan(before)
    expect(ack.duplicate).toBe(false)
    const replay = await acknowledgeElearningWatchChallenge(db, {
      orgId: ORG,
      userId: USER,
      sessionId: seeded.sessionId,
      challengeId: challenge.challengeId,
      requestId,
    })
    expect(replay).toEqual({ ...ack, duplicate: true })
    await expect(acknowledgeElearningWatchChallenge(db, {
      orgId: ORG,
      userId: USER,
      sessionId: seeded.sessionId,
      challengeId: randomUUID(),
      requestId,
    })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'conflict')
      return true
    })
  })

  it('discards timed-out provisional credit and keeps completion evidence absent', async () => {
    await cleanup()
    const seeded = await seed()
    const issued = await issueChallenge(seeded)
    const challenge = issued.state.challenge!
    await heartbeat(seeded, issued.sequence + 1, (issued.sequence + 1) * 20_000)
    await pool.query(
      `UPDATE elearning_watch_challenge_schedules
          SET active_issued_at = clock_timestamp() - interval '2 seconds',
              active_deadline_at = clock_timestamp() - interval '1 second'
        WHERE org_id = $1 AND session_id = $2`,
      [ORG, seeded.sessionId],
    )
    const paused = await heartbeat(seeded, issued.sequence + 2, (issued.sequence + 2) * 20_000)
    expect(paused.challenge?.status).toBe('paused')
    expect(paused.creditedMs).toBe(0)
    const late = await acknowledgeElearningWatchChallenge(db, {
      orgId: ORG,
      userId: USER,
      sessionId: seeded.sessionId,
      challengeId: challenge.challengeId,
      requestId: randomUUID(),
    })
    expect(late.creditedMs).toBe(0)
    expect(late.challenge).toBeNull()
    const evidence = await pool.query(
      `SELECT count(*)::int AS count FROM elearning_completion_evidence
        WHERE org_id = $1 AND course_version_item_id = $2`,
      [ORG, seeded.itemId],
    )
    expect(evidence.rows[0]?.count).toBe(0)
  })

  it('serializes two request ids for one challenge and enforces tenant identity', async () => {
    await cleanup()
    const seeded = await seed()
    const issued = await issueChallenge(seeded)
    const challengeId = issued.state.challenge!.challengeId
    await heartbeat(seeded, issued.sequence + 1, (issued.sequence + 1) * 20_000)
    const firstRead = deferred()
    const releaseFirst = deferred()
    const secondRead = deferred()
    let transactionOrdinal = 0
    const barrierDb: ElearningWatchDb = {
      query: db.query,
      async transaction<T>(run: (tx: ElearningWatchQueryable) => Promise<T>): Promise<T> {
        const ordinal = ++transactionOrdinal
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const value = await run({
            query: async (text, params) => {
              const result = await client.query(text, params as never)
              if (text.includes('elearning-watch-challenge:lock-schedule')) {
                if (ordinal === 1) {
                  firstRead.resolve()
                  await releaseFirst.promise
                } else {
                  secondRead.resolve()
                }
              }
              return {
                rows: result.rows as Array<Record<string, unknown>>,
                rowCount: result.rowCount,
              }
            },
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
    const firstPromise = acknowledgeElearningWatchChallenge(barrierDb, {
      orgId: ORG, userId: USER, sessionId: seeded.sessionId,
      challengeId, requestId: randomUUID(),
    })
    await firstRead.promise
    const secondPromise = acknowledgeElearningWatchChallenge(barrierDb, {
      orgId: ORG, userId: USER, sessionId: seeded.sessionId,
      challengeId, requestId: randomUUID(),
    })
    try {
      const secondPassedAuthorityBarrier = await Promise.race([
        secondRead.promise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 75)),
      ])
      expect(secondPassedAuthorityBarrier).toBe(false)
    } finally {
      releaseFirst.resolve()
    }
    const [first, second] = await Promise.allSettled([firstPromise, secondPromise])
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = first.status === 'rejected' ? first.reason : second.status === 'rejected' ? second.reason : null
    expectCode(rejected, 'challenge_stale')
    await expect(acknowledgeElearningWatchChallenge(db, {
      orgId: OTHER_ORG, userId: USER, sessionId: seeded.sessionId,
      challengeId, requestId: randomUUID(),
    })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'not_found')
      return true
    })
  })

  it('makes schedule snapshots and event/request ledgers immutable', async () => {
    const seeded = await seed()
    const issued = await issueChallenge(seeded)
    const challengeId = issued.state.challenge!.challengeId
    await expect(pool.query(
      `UPDATE elearning_watch_challenge_schedules SET policy_revision = 'changed'
        WHERE org_id = $1 AND session_id = $2`,
      [ORG, seeded.sessionId],
    )).rejects.toThrow('snapshot is immutable')
    await acknowledgeElearningWatchChallenge(db, {
      orgId: ORG, userId: USER, sessionId: seeded.sessionId,
      challengeId, requestId: randomUUID(),
    })
    await expect(pool.query(
      `DELETE FROM elearning_watch_challenge_events WHERE org_id = $1`,
      [ORG],
    )).rejects.toThrow('append-only')
    await expect(pool.query(
      `UPDATE elearning_watch_challenge_requests SET result = '{}'::jsonb WHERE org_id = $1`,
      [ORG],
    )).rejects.toThrow('append-only')
  })

  it('refuses populated down and supports empty down/reapply/replay', async () => {
    await expect(kysely.transaction().execute((tx) => challengeDown(tx))).rejects.toThrow(
      'down refused: authoritative rows exist',
    )
    await cleanup()
    await kysely.transaction().execute((tx) => challengeDown(tx))
    const removed = await pool.query(
      `SELECT to_regclass('elearning_watch_challenge_schedules') AS table_name`,
    )
    expect(removed.rows[0]?.table_name).toBeNull()
    await kysely.transaction().execute((tx) => challengeUp(tx))
    await kysely.transaction().execute((tx) => challengeUp(tx))
  })
})
