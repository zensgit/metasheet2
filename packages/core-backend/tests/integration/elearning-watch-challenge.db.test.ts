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
  versionId: string
}

async function seed(options: {
  challengeCount?: number
  policy?: 'configured' | 'disabled'
  startChallengeEnabled?: boolean
} = {}): Promise<Seed> {
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
       $5, $6, $7, $8
     )`,
    [
      videoItemId, ORG, versionId, mediaId,
      options.policy === 'disabled' ? null : 'watch-challenge-v1',
      options.policy === 'disabled' ? null : (options.challengeCount ?? 1),
      options.policy === 'disabled' ? null : 1,
      options.policy === 'disabled' ? null : 120000,
    ],
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
    ...(options.startChallengeEnabled === false ? {} : { challengeEnabled: true as const }),
  })
  if (!started.sessionId) throw new Error('session unavailable')
  return { itemId: videoItemId, sessionId: started.sessionId, versionId }
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

function challengeSelections(challenge: {
  targets: [string, string]
  options: Array<{ optionId: string; label: string }>
}): [string, string] {
  const byLabel = new Map(challenge.options.map((option) => [option.label, option.optionId]))
  const first = byLabel.get(challenge.targets[0])
  const second = byLabel.get(challenge.targets[1])
  if (!first || !second || first === second) throw new Error('invalid challenge prompt')
  return [first, second]
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

function createBarrierDb(marker: string): {
  barrierDb: ElearningWatchDb
  firstRead: ReturnType<typeof deferred>
  releaseFirst: ReturnType<typeof deferred>
  secondRead: ReturnType<typeof deferred>
} {
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
            if (text.includes(marker)) {
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
  return { barrierDb, firstRead, releaseFirst, secondRead }
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

    await pool.query(`
      ALTER TABLE elearning_course_version_items
        ALTER COLUMN watch_challenge_count SET DEFAULT 1
    `)
    await expect(kysely.transaction().execute((tx) => challengeUp(tx))).rejects.toThrow(
      'migration drift: item defaults',
    )
    await pool.query(`
      ALTER TABLE elearning_course_version_items
        ALTER COLUMN watch_challenge_count DROP DEFAULT
    `)
    await kysely.transaction().execute((tx) => challengeUp(tx))

    await pool.query(`
      ALTER TABLE elearning_watch_challenge_events
        DROP CONSTRAINT elearning_watch_challenge_events_prompt_chk,
        ADD CONSTRAINT elearning_watch_challenge_events_prompt_chk CHECK (
          kind <> 'issue' OR prompt_version = 'symbol-number-v1'
        )
    `)
    await expect(kysely.transaction().execute((tx) => challengeUp(tx))).rejects.toThrow(
      'migration drift: constraints',
    )
    await kysely.transaction().execute((tx) => challengeDown(tx))
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
    await pool.query(
      `UPDATE elearning_learning_sessions
          SET last_event_at = clock_timestamp() - interval '30 seconds'
        WHERE org_id = $1 AND id = $2`,
      [ORG, seeded.sessionId],
    )

    const requestId = randomUUID()
    const ack = await acknowledgeElearningWatchChallenge(db, {
      orgId: ORG,
      userId: USER,
      sessionId: seeded.sessionId,
      challengeId: challenge.challengeId,
      requestId,
      selections: challengeSelections(challenge),
    })
    expect(ack.challenge).toBeNull()
    expect(ack.effectiveMs).toBeGreaterThan(before)
    expect(ack.duplicate).toBe(false)
    const ackFence = await pool.query(
      `SELECT extract(epoch FROM (clock_timestamp() - last_event_at)) * 1000 AS age_ms
         FROM elearning_learning_sessions
        WHERE org_id = $1 AND id = $2`,
      [ORG, seeded.sessionId],
    )
    expect(Number(ackFence.rows[0]?.age_ms)).toBeLessThan(5_000)
    const replay = await acknowledgeElearningWatchChallenge(db, {
      orgId: ORG,
      userId: USER,
      sessionId: seeded.sessionId,
      challengeId: challenge.challengeId,
      requestId,
      selections: challengeSelections(challenge),
    })
    expect(replay).toEqual({ ...ack, duplicate: true })
    await expect(acknowledgeElearningWatchChallenge(db, {
      orgId: ORG,
      userId: USER,
      sessionId: seeded.sessionId,
      challengeId: challenge.challengeId,
      requestId,
      selections: challengeSelections(challenge).reverse() as [string, string],
    })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'conflict')
      return true
    })
  })

  it('freezes the prompt and rejects reversed or forged selections without credit or completion', async () => {
    await cleanup()
    const seeded = await seed()
    await pinFirstCheckpoint(seeded.sessionId)
    const issued = await issueChallenge(seeded)
    const challenge = issued.state.challenge!
    expect(challenge.promptVersion).toBe('symbol-number-v1')
    expect(challenge.options).toHaveLength(6)
    expect(new Set(challenge.options.map((option) => option.optionId)).size).toBe(6)
    expect(challenge.targets).toHaveLength(2)

    const event = await pool.query(
      `SELECT prompt_version, prompt_option_ids, prompt_option_labels, expected_selection
         FROM elearning_watch_challenge_events
        WHERE org_id = $1 AND session_id = $2 AND challenge_id = $3 AND kind = 'issue'`,
      [ORG, seeded.sessionId, challenge.challengeId],
    )
    expect(event.rows).toHaveLength(1)
    expect(event.rows[0]?.prompt_version).toBe('symbol-number-v1')
    expect(event.rows[0]?.prompt_option_ids).toEqual(challenge.options.map((option) => option.optionId))
    expect(event.rows[0]?.prompt_option_labels).toEqual(challenge.options.map((option) => option.label))
    expect(event.rows[0]?.expected_selection).toEqual(challengeSelections(challenge))

    const correct = challengeSelections(challenge)
    for (const selections of [
      [correct[1], correct[0]] as [string, string],
      [correct[0], randomUUID()] as [string, string],
    ]) {
      await expect(acknowledgeElearningWatchChallenge(db, {
        orgId: ORG,
        userId: USER,
        sessionId: seeded.sessionId,
        challengeId: challenge.challengeId,
        requestId: randomUUID(),
        selections,
      })).rejects.toSatisfy((error: unknown) => {
        expectCode(error, 'challenge_incorrect')
        return true
      })
    }
    const authority = await pool.query(
      `SELECT schedule.status, schedule.provisional_ms::int AS provisional_ms,
              progress.effective_ms::int AS effective_ms,
              (SELECT count(*)::int FROM elearning_completion_evidence evidence
                WHERE evidence.org_id = schedule.org_id
                  AND evidence.course_version_item_id = schedule.course_version_item_id) AS evidence_count
         FROM elearning_watch_challenge_schedules schedule
         JOIN elearning_progress progress
           ON progress.org_id = schedule.org_id
          AND progress.course_version_item_id = schedule.course_version_item_id
          AND progress.user_id = schedule.user_id
        WHERE schedule.org_id = $1 AND schedule.session_id = $2`,
      [ORG, seeded.sessionId],
    )
    expect(authority.rows).toHaveLength(1)
    expect(authority.rows[0]).toMatchObject({
      status: 'challenged',
      effective_ms: 0,
      evidence_count: 0,
    })
    expect(authority.rows[0]?.provisional_ms).toBeGreaterThan(0)
  })

  it('requires every configured checkpoint before completion evidence can be written', async () => {
    await cleanup()
    const seeded = await seed({ challengeCount: 2 })
    await pool.query(
      `ALTER TABLE elearning_watch_challenge_schedules
         DISABLE TRIGGER trg_elearning_watch_challenge_schedules_authority`,
    )
    try {
      await pool.query(
        `UPDATE elearning_watch_challenge_schedules
            SET checkpoints = '[{"ordinal":1,"targetTrustedMs":1},{"ordinal":2,"targetTrustedMs":2}]'::jsonb
          WHERE org_id = $1 AND session_id = $2`,
        [ORG, seeded.sessionId],
      )
    } finally {
      await pool.query(
        `ALTER TABLE elearning_watch_challenge_schedules
           ENABLE TRIGGER trg_elearning_watch_challenge_schedules_authority`,
      )
    }
    const first = await heartbeat(seeded, 1, 100_000)
    expect(first.challenge?.ordinal).toBe(1)
    const firstAck = await acknowledgeElearningWatchChallenge(db, {
      orgId: ORG, userId: USER, sessionId: seeded.sessionId,
      challengeId: first.challenge!.challengeId, requestId: randomUUID(),
      selections: challengeSelections(first.challenge!),
    })
    expect(firstAck.status).toBe('in_progress')
    const second = await heartbeat(seeded, 2, 0)
    expect(second.challenge?.ordinal).toBe(2)
    const secondAck = await acknowledgeElearningWatchChallenge(db, {
      orgId: ORG, userId: USER, sessionId: seeded.sessionId,
      challengeId: second.challenge!.challengeId, requestId: randomUUID(),
      selections: challengeSelections(second.challenge!),
    })
    expect(secondAck.status).toBe('in_progress')
    const completed = await heartbeat(seeded, 3, 100_000)
    expect(completed.status).toBe('completed')
    const evidence = await pool.query(
      `SELECT count(*)::int AS count FROM elearning_completion_evidence
        WHERE org_id = $1 AND course_version_item_id = $2`,
      [ORG, seeded.itemId],
    )
    expect(evidence.rows[0]?.count).toBe(1)
  })

  it('does not complete at the video threshold while a later checkpoint is unissued', async () => {
    await cleanup()
    const seeded = await seed()
    await pool.query(
      `ALTER TABLE elearning_watch_challenge_schedules
         DISABLE TRIGGER trg_elearning_watch_challenge_schedules_authority`,
    )
    try {
      await pool.query(
        `UPDATE elearning_watch_challenge_schedules
            SET checkpoints = '[{"ordinal":1,"targetTrustedMs":95000}]'::jsonb
          WHERE org_id = $1 AND session_id = $2`,
        [ORG, seeded.sessionId],
      )
    } finally {
      await pool.query(
        `ALTER TABLE elearning_watch_challenge_schedules
           ENABLE TRIGGER trg_elearning_watch_challenge_schedules_authority`,
      )
    }
    const first = await heartbeat(seeded, 1, 60_000)
    expect(first.challenge).toBeNull()
    const threshold = await heartbeat(seeded, 2, 90_000)
    expect(threshold.status).toBe('in_progress')
    expect(threshold.challenge).toBeNull()
    const issued = await heartbeat(seeded, 3, 100_000)
    expect(issued.challenge?.ordinal).toBe(1)
    const completed = await acknowledgeElearningWatchChallenge(db, {
      orgId: ORG, userId: USER, sessionId: seeded.sessionId,
      challengeId: issued.challenge!.challengeId, requestId: randomUUID(),
      selections: challengeSelections(issued.challenge!),
    })
    expect(completed.status).toBe('completed')
  })

  it('persists an explicit disabled schedule and fails closed when a hot-enabled session has none', async () => {
    await cleanup()
    const disabled = await seed({ policy: 'disabled' })
    const mode = await pool.query(
      `SELECT mode FROM elearning_watch_challenge_schedules
        WHERE org_id = $1 AND session_id = $2`,
      [ORG, disabled.sessionId],
    )
    expect(mode.rows).toEqual([{ mode: 'disabled' }])
    const credited = await heartbeat(disabled, 1, 20_000)
    expect(credited.creditedMs).toBeGreaterThan(0)
    expect(credited.challenge).toBeNull()

    await cleanup()
    const hotEnabled = await seed({ startChallengeEnabled: false })
    await expect(heartbeat(hotEnabled, 1, 20_000)).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'unavailable')
      return true
    })
    const progress = await pool.query(
      `SELECT effective_ms::int AS effective_ms FROM elearning_progress
        WHERE org_id = $1 AND course_version_item_id = $2 AND user_id = $3`,
      [ORG, hotEnabled.itemId, USER],
    )
    expect(progress.rows).toEqual([{ effective_ms: 0 }])
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
      selections: challengeSelections(challenge),
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
    const challenge = issued.state.challenge!
    const challengeId = challenge.challengeId
    await heartbeat(seeded, issued.sequence + 1, (issued.sequence + 1) * 20_000)
    const { barrierDb, firstRead, releaseFirst, secondRead } = createBarrierDb(
      'elearning-watch-challenge:lock-schedule',
    )
    const firstPromise = acknowledgeElearningWatchChallenge(barrierDb, {
      orgId: ORG, userId: USER, sessionId: seeded.sessionId,
      challengeId, requestId: randomUUID(),
      selections: challengeSelections(challenge),
    })
    await firstRead.promise
    const secondPromise = acknowledgeElearningWatchChallenge(barrierDb, {
      orgId: ORG, userId: USER, sessionId: seeded.sessionId,
      challengeId, requestId: randomUUID(),
      selections: challengeSelections(challenge),
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
      selections: challengeSelections(challenge),
    })).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'not_found')
      return true
    })
  })

  it('serializes one request id across different items before either request lookup', async () => {
    await cleanup()
    const firstSeed = await seed()
    const firstIssued = await issueChallenge(firstSeed)
    const secondSeed = await seed()
    const secondIssued = await issueChallenge(secondSeed)
    const requestId = randomUUID()
    const { barrierDb, firstRead, releaseFirst, secondRead } = createBarrierDb(
      'elearning-watch-challenge:lock-request-identity',
    )
    const firstPromise = acknowledgeElearningWatchChallenge(barrierDb, {
      orgId: ORG, userId: USER, sessionId: firstSeed.sessionId,
      challengeId: firstIssued.state.challenge!.challengeId, requestId,
      selections: challengeSelections(firstIssued.state.challenge!),
    })
    await firstRead.promise
    const secondPromise = acknowledgeElearningWatchChallenge(barrierDb, {
      orgId: ORG, userId: USER, sessionId: secondSeed.sessionId,
      challengeId: secondIssued.state.challenge!.challengeId, requestId,
      selections: challengeSelections(secondIssued.state.challenge!),
    })
    try {
      const secondPassedRequestLock = await Promise.race([
        secondRead.promise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 75)),
      ])
      expect(secondPassedRequestLock).toBe(false)
    } finally {
      releaseFirst.resolve()
    }
    const [first, second] = await Promise.allSettled([firstPromise, secondPromise])
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = first.status === 'rejected'
      ? first.reason
      : second.status === 'rejected' ? second.reason : null
    expectCode(rejected, 'conflict')
  })

  it('binds schedule, event, and request redundant identity with same-org composite FKs', async () => {
    await cleanup()
    const sessionOnly = await seed({ startChallengeEnabled: false })
    const other = await seed()
    await expect(pool.query(
      `INSERT INTO elearning_watch_challenge_schedules (
         id, org_id, session_id, course_version_id, course_version_item_id, user_id,
         mode, policy_revision, response_window_ms, video_duration_ms, checkpoints
       ) VALUES ($1, $2, $3, $4, $5, $6, 'disabled', 'watch-challenge-disabled-v1',
         1, 100000, '[]'::jsonb)`,
      [randomUUID(), ORG, sessionOnly.sessionId, other.versionId, other.itemId, USER],
    )).rejects.toMatchObject({ code: '23503' })

    const schedule = await pool.query(
      `SELECT id FROM elearning_watch_challenge_schedules
        WHERE org_id = $1 AND session_id = $2`,
      [ORG, other.sessionId],
    )
    const scheduleId = schedule.rows[0]?.id
    expect(typeof scheduleId).toBe('string')
    await expect(pool.query(
      `INSERT INTO elearning_watch_challenge_events (
         id, org_id, schedule_id, session_id, course_version_id,
         course_version_item_id, user_id, challenge_id, ordinal, kind,
         policy_revision, credited_ms, discarded_ms
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'ack',
         'watch-challenge-v1', 0, 0)`,
      [
        randomUUID(), ORG, scheduleId, other.sessionId, sessionOnly.versionId,
        sessionOnly.itemId, USER, randomUUID(),
      ],
    )).rejects.toMatchObject({ code: '23503' })
    await expect(pool.query(
      `INSERT INTO elearning_watch_challenge_requests (
         id, org_id, user_id, request_id, request_hash, request_hash_version,
         schedule_id, session_id, course_version_id, course_version_item_id,
         challenge_id, result
       ) VALUES ($1, $2, $3, $4, $5, 2, $6, $7, $8, $9, $10, NULL)`,
      [
        randomUUID(), ORG, USER, randomUUID(), 'a'.repeat(64), scheduleId,
        other.sessionId, sessionOnly.versionId, sessionOnly.itemId, randomUUID(),
      ],
    )).rejects.toMatchObject({ code: '23503' })
  })

  it('makes schedule snapshots and event/request ledgers immutable', async () => {
    const seeded = await seed()
    const issued = await issueChallenge(seeded)
    const challenge = issued.state.challenge!
    const challengeId = challenge.challengeId
    await expect(pool.query(
      `UPDATE elearning_watch_challenge_schedules SET policy_revision = 'changed'
        WHERE org_id = $1 AND session_id = $2`,
      [ORG, seeded.sessionId],
    )).rejects.toThrow('snapshot is immutable')
    await acknowledgeElearningWatchChallenge(db, {
      orgId: ORG, userId: USER, sessionId: seeded.sessionId,
      challengeId, requestId: randomUUID(),
      selections: challengeSelections(challenge),
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
