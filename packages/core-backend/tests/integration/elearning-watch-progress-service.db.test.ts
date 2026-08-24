/**
 * E-learning V0.1 watch-progress service gate (real PostgreSQL).
 *
 * Assumes content/assessment + watch-progress migrations have already been
 * applied by the caller. Does not call up()/down() and does not write
 * kysely_migration.
 *
 * DATABASE_URL is required. A missing URL throws (refuses skip-shaped green).
 * HTTP/API surfaces are out of this slice.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import { ELEARNING_V01_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment'
import { ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS } from '../../src/db/migrations/zzzz20260825120000_create_elearning_v01_watch_progress'
import {
  ELEARNING_WATCH_EVALUATOR_VERSION,
  ELEARNING_WATCH_POLICY_VERSION,
  ELEARNING_WATCH_THRESHOLD_BPS,
  ElearningWatchError,
  recordElearningHeartbeat,
  rollElearningWatchEventDigest,
  startElearningWatch,
  type ElearningWatchDb,
  type ElearningWatchQueryable,
} from '../../src/services/elearning-watch-progress'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'elearning V0.1 watch-progress service gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
const STAMP = Date.now().toString(36)
const NS = `el-wsvc-${STAMP}`

const ALL_TRIGGERS = [
  ...ELEARNING_V01_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS,
]

async function exec(target: Pool, sql: string, params?: unknown[]) {
  const result = await target.query(sql, params as never)
  return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
}

class PgWatchDb implements ElearningWatchDb {
  constructor(private readonly target: Pool) {}

  query(sql: string, params?: unknown[]) {
    return exec(this.target, sql, params)
  }

  async transaction<T>(handler: (tx: ElearningWatchQueryable) => Promise<T>): Promise<T> {
    const client = await this.target.connect()
    try {
      await client.query('BEGIN')
      try {
        const value = await handler({
          query: async (sql, params) => {
            const result = await client.query(sql, params as never)
            return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
          },
        })
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    } finally {
      client.release()
    }
  }
}

const db = new PgWatchDb(pool)

function watchDbFromClient(client: PoolClient): ElearningWatchDb {
  const query: ElearningWatchQueryable['query'] = async (sql, params) => {
    const result = await client.query(sql, params as never)
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
  }
  return {
    query,
    async transaction<T>(handler: (tx: ElearningWatchQueryable) => Promise<T>): Promise<T> {
      await client.query('BEGIN')
      try {
        const value = await handler({ query })
        await client.query('COMMIT')
        return value
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    },
  }
}

function wrapWatchDb(
  base: ElearningWatchDb,
  beforeQuery: (sql: string) => void,
): ElearningWatchDb {
  return {
    query: async (sql, params) => {
      beforeQuery(sql)
      return base.query(sql, params)
    },
    transaction: (handler) =>
      base.transaction((tx) =>
        handler({
          query: async (sql, params) => {
            beforeQuery(sql)
            return tx.query(sql, params)
          },
        }),
      ),
  }
}

function settled<T>(promise: Promise<T>): Promise<T | unknown> {
  return promise.then(
    (value) => value,
    (error) => error,
  )
}

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  return result.rows[0].pid
}

async function waitUntilWaiterBlockedByHolder(
  holderPid: number,
  waiterPid: number,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_locks waiter_lock
         JOIN pg_locks holder_lock
           ON holder_lock.locktype = waiter_lock.locktype
          AND holder_lock.database IS NOT DISTINCT FROM waiter_lock.database
          AND holder_lock.relation IS NOT DISTINCT FROM waiter_lock.relation
          AND holder_lock.page IS NOT DISTINCT FROM waiter_lock.page
          AND holder_lock.tuple IS NOT DISTINCT FROM waiter_lock.tuple
          AND holder_lock.virtualxid IS NOT DISTINCT FROM waiter_lock.virtualxid
          AND holder_lock.transactionid IS NOT DISTINCT FROM waiter_lock.transactionid
          AND holder_lock.classid IS NOT DISTINCT FROM waiter_lock.classid
          AND holder_lock.objid IS NOT DISTINCT FROM waiter_lock.objid
          AND holder_lock.objsubid IS NOT DISTINCT FROM waiter_lock.objsubid
          AND holder_lock.pid IS DISTINCT FROM waiter_lock.pid
        WHERE waiter_lock.pid = $1
          AND waiter_lock.granted = false
          AND holder_lock.granted = true
          AND holder_lock.pid = $2
          AND $2 = ANY(pg_blocking_pids($1))`,
      [waiterPid, holderPid],
    )
    if ((result.rows[0]?.n ?? 0) >= 1) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(
    `timed out waiting for waiter pid ${waiterPid} to be blocked by holder pid ${holderPid} (pg_locks barrier never engaged)`,
  )
}

async function runLockBarrier(input: {
  hold: (holder: PoolClient) => Promise<void>
  wait: (waiter: PoolClient) => Promise<unknown>
  afterBlocked?: (holder: PoolClient) => Promise<void>
}): Promise<unknown> {
  const holder: PoolClient = await pool.connect()
  let waiter: PoolClient | undefined
  let waitPromise: Promise<unknown> | undefined
  try {
    waiter = await pool.connect()
    const holderPid = await backendPid(holder)
    const waiterPid = await backendPid(waiter)
    await holder.query('BEGIN')
    await input.hold(holder)
    await waiter.query(`SET lock_timeout = '15s'`)
    waitPromise = input.wait(waiter)
    const waitSettled = settled(waitPromise)
    const winner = await Promise.race([
      waitUntilWaiterBlockedByHolder(holderPid, waiterPid).then(() => 'blocked' as const),
      waitSettled.then((value) => ({ settled: value })),
    ])
    if (winner !== 'blocked') {
      throw new Error(
        `pg_locks barrier never engaged (waiter pid ${waiterPid} settled without waiting on holder pid ${holderPid})`,
      )
    }
    if (input.afterBlocked) {
      await input.afterBlocked(holder)
    }
    await holder.query('COMMIT')
    return await waitPromise
  } finally {
    try {
      await holder.query('ROLLBACK')
    } catch {
      /* already committed / idle */
    }
    if (waitPromise) {
      await settled(waitPromise)
    }
    try {
      if (waiter) {
        try {
          await waiter.query('ROLLBACK')
        } catch {
          /* already idle / aborted */
        }
        waiter.release()
      }
    } finally {
      holder.release()
    }
  }
}

function orgId(suffix: string): string {
  return `${NS}-${suffix}`
}

function actor(suffix: string): string {
  return `${NS}-actor-${suffix}`
}

async function setTriggers(enabled: boolean): Promise<void> {
  const verb = enabled ? 'ENABLE' : 'DISABLE'
  for (const { table, name } of ALL_TRIGGERS) {
    await pool.query(`ALTER TABLE ${table} ${verb} TRIGGER ${name}`)
  }
}

async function cleanupOrg(org: string): Promise<void> {
  await setTriggers(false)
  try {
    await pool.query('DELETE FROM elearning_completion_evidence WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_progress WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_progress_events WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_learning_sessions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_assignment_members WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_assignments WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_course_version_items WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_exam_questions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_exams WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_question_revisions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_questions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_media WHERE org_id = $1', [org])
    await pool.query(
      `UPDATE elearning_courses
          SET active_version_id = NULL, latest_version_id = NULL
        WHERE org_id = $1`,
      [org],
    )
    await pool.query('DELETE FROM elearning_course_versions WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_courses WHERE org_id = $1', [org])
  } finally {
    await setTriggers(true)
  }
}

interface Seed {
  org: string
  userId: string
  courseId: string
  versionId: string
  itemId: string
  memberId: string
  durationMs: number
}

async function seedPublishedAssignment(input: {
  org: string
  durationMs?: number
  deadline?: string | null
}): Promise<Seed> {
  const durationMs = input.durationMs ?? 10_000
  const userId = actor(`learner-${randomUUID().slice(0, 8)}`)
  const courseId = randomUUID()
  const versionId = randomUUID()
  const mediaId = randomUUID()
  const examId = randomUUID()
  const questionId = randomUUID()
  const revisionId = randomUUID()
  const itemId = randomUUID()
  const assignmentId = randomUUID()
  const memberId = randomUUID()

  await pool.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES ($1, $2, 'Watch service course', 'active', $3)`,
    [courseId, input.org, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_course_versions
       (id, org_id, course_id, version, status, title, created_by)
     VALUES ($1, $2, $3, 1, 'draft', 'Version 1', $4)`,
    [versionId, input.org, courseId, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_media (
       id, org_id, storage_key, mime_type, magic_mime_type,
       size_bytes, sha256, duration_ms, status, created_by
     ) VALUES ($1, $2, $3, 'video/mp4', 'video/mp4', 1024, $4, $5, 'ready', $6)`,
    [mediaId, input.org, `${NS}/media/${mediaId}`, 'a'.repeat(64), durationMs, actor('uploader')],
  )
  await pool.query(
    `INSERT INTO elearning_questions (id, org_id, created_by) VALUES ($1, $2, $3)`,
    [questionId, input.org, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_question_revisions (
       id, org_id, question_id, revision, question_type, prompt, options, answer_key, points, created_by
     ) VALUES ($1, $2, $3, 1, 'single_choice', 'Pick one', $4::jsonb, $5::jsonb, 10, $6)`,
    [
      revisionId,
      input.org,
      questionId,
      JSON.stringify([{ id: 'a', text: 'yes' }]),
      JSON.stringify({ correct: ['a'] }),
      actor('author'),
    ],
  )
  await pool.query(
    `INSERT INTO elearning_exams (id, org_id, title, status, pass_score, max_attempts, created_by)
     VALUES ($1, $2, 'Watch exam', 'draft', 60, 3, $3)`,
    [examId, input.org, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_exam_questions (org_id, exam_id, question_revision_id, position, points)
     VALUES ($1, $2, $3, 1, 10)`,
    [input.org, examId, revisionId],
  )
  await pool.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position, media_id, exam_id,
       completion_policy_version, completion_threshold_bps
     ) VALUES ($1, $2, $3, 'video', 1, $4, NULL, $5, $6)`,
    [itemId, input.org, versionId, mediaId, ELEARNING_WATCH_POLICY_VERSION, ELEARNING_WATCH_THRESHOLD_BPS],
  )
  await pool.query(
    `INSERT INTO elearning_course_version_items (
       org_id, course_version_id, item_type, position, media_id, exam_id,
       completion_policy_version, completion_threshold_bps
     ) VALUES ($1, $2, 'exam', 2, NULL, $3, NULL, NULL)`,
    [input.org, versionId, examId],
  )
  await pool.query(
    `UPDATE elearning_exams SET status = 'published', updated_at = now() WHERE org_id = $1 AND id = $2`,
    [input.org, examId],
  )
  await pool.query(
    `UPDATE elearning_course_versions SET status = 'published', updated_at = now() WHERE org_id = $1 AND id = $2`,
    [input.org, versionId],
  )
  await pool.query(
    `INSERT INTO elearning_assignments (
       id, org_id, course_version_id, source_key, request_hash, request_hash_version,
       deadline, assigned_by
     ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
    [
      assignmentId,
      input.org,
      versionId,
      `${input.org}-src`,
      `hash-${assignmentId}`,
      input.deadline === undefined ? null : input.deadline,
      actor('assigner'),
    ],
  )
  await pool.query(
    `INSERT INTO elearning_assignment_members (
       id, org_id, assignment_id, course_version_id, user_id, source
     ) VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [memberId, input.org, assignmentId, versionId, userId],
  )

  return { org: input.org, userId, courseId, versionId, itemId, memberId, durationMs }
}

async function seedReplacementMember(seed: Seed): Promise<string> {
  const assignmentId = randomUUID()
  const memberId = randomUUID()
  await pool.query(
    `INSERT INTO elearning_assignments (
       id, org_id, course_version_id, source_key, request_hash, request_hash_version,
       deadline, assigned_by
     ) VALUES ($1, $2, $3, $4, $5, 1, NULL, $6)`,
    [
      assignmentId,
      seed.org,
      seed.versionId,
      `${seed.org}-src-${memberId}`,
      `hash-${assignmentId}`,
      actor('assigner'),
    ],
  )
  await pool.query(
    `INSERT INTO elearning_assignment_members (
       id, org_id, assignment_id, course_version_id, user_id, source
     ) VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [memberId, seed.org, assignmentId, seed.versionId, seed.userId],
  )
  return memberId
}

async function revokeMember(org: string, memberId: string): Promise<void> {
  await pool.query(
    `UPDATE elearning_assignment_members
        SET revoked_at = now(), revoked_by = $1, revocation_reason = 'pilot reassign'
      WHERE org_id = $2 AND id = $3`,
    [actor('revoker'), org, memberId],
  )
}

async function countOrg(table: string, org: string): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`,
    [org],
  )
  return result.rows[0].n
}

async function eventKinds(org: string): Promise<string[]> {
  const result = await pool.query<{ kind: string }>(
    `SELECT kind FROM elearning_progress_events WHERE org_id = $1 ORDER BY sequence`,
    [org],
  )
  return result.rows.map((row) => row.kind)
}

function assertValuesFree(payload: unknown, org: string, userId: string): void {
  const blob = JSON.stringify(payload)
  expect(blob).not.toContain(org)
  expect(blob).not.toContain(userId)
  expect(blob).not.toContain('answer_key')
  expect(blob).not.toContain('storage_key')
  expect(blob).not.toContain(`${NS}/media/`)
  expect(blob).not.toContain('elearning.watch.event.v1')
}

describe('elearning V0.1 watch-progress service gate (real DB)', () => {
  const seededOrgIds: string[] = []

  afterEach(async () => {
    for (const org of seededOrgIds.splice(0)) {
      await cleanupOrg(org)
    }
  })

  afterAll(async () => {
    await pool.end()
  })

  it('reuses a repeated start and serializes concurrent starts to one session and start event', async () => {
    const org = orgId('start-once')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org })
    const first = await startElearningWatch(db, { orgId: org, userId: seed.userId, itemId: seed.itemId })
    const second = await startElearningWatch(db, { orgId: org, userId: seed.userId, itemId: seed.itemId })
    expect(first.sessionId).toBeTruthy()
    expect(second.sessionId).toBe(first.sessionId)
    expect(first.lastSequence).toBe(0)

    const orgB = orgId('start-race')
    seededOrgIds.push(orgB)
    const race = await seedPublishedAssignment({ org: orgB })
    const raced = await Promise.all([
      startElearningWatch(db, { orgId: orgB, userId: race.userId, itemId: race.itemId }),
      startElearningWatch(db, { orgId: orgB, userId: race.userId, itemId: race.itemId }),
    ])
    expect(raced[0].sessionId).toBe(raced[1].sessionId)
    const sessions = await pool.query(
      `SELECT id, status FROM elearning_learning_sessions WHERE org_id = $1`,
      [orgB],
    )
    const starts = await pool.query(
      `SELECT sequence, kind FROM elearning_progress_events WHERE org_id = $1`,
      [orgB],
    )
    expect(sessions.rows).toHaveLength(1)
    expect(starts.rows).toEqual([{ sequence: 0, kind: 'start' }])
    assertValuesFree(first, org, seed.userId)
  })

  it('treats exact heartbeat replays as duplicates, payload mismatches as conflict, and holes as gaps', async () => {
    const org = orgId('seq')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org })
    const started = await startElearningWatch(db, { orgId: org, userId: seed.userId, itemId: seed.itemId })
    await pool.query(
      `UPDATE elearning_learning_sessions SET last_event_at = clock_timestamp() - interval '10 seconds' WHERE id = $1`,
      [started.sessionId],
    )
    const beat = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 1,
      positionMs: 3_000,
      playing: true,
    })
    expect(beat.duplicate).toBe(false)
    expect(beat.creditedMs).toBeGreaterThan(0)

    const dup = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 1,
      positionMs: 3_000,
      playing: true,
    })
    expect(dup).toEqual(expect.objectContaining({
      duplicate: true,
      creditedMs: 0,
      effectiveMs: beat.effectiveMs,
      lastSequence: 1,
    }))

    await expect(recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 1,
      positionMs: 4_000,
      playing: true,
    })).rejects.toMatchObject({ code: 'conflict' })

    await expect(recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 3,
      positionMs: 4_000,
      playing: true,
    })).rejects.toMatchObject({ code: 'sequence_gap' })

    const events = await pool.query(
      `SELECT sequence, kind FROM elearning_progress_events WHERE org_id = $1 ORDER BY sequence`,
      [org],
    )
    expect(events.rows).toEqual([
      { sequence: 0, kind: 'start' },
      { sequence: 1, kind: 'heartbeat' },
    ])
  })

  it('credits zero while paused and clamps seek/wall-clock playback', async () => {
    const org = orgId('clamp')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org, durationMs: 120_000 })
    const started = await startElearningWatch(db, { orgId: org, userId: seed.userId, itemId: seed.itemId })

    const paused = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 1,
      positionMs: 8_000,
      playing: false,
    })
    expect(paused.creditedMs).toBe(0)
    expect(paused.maxPositionMs).toBe(0)
    expect(paused.lastClientPositionMs).toBe(8_000)
    expect(paused.effectiveMs).toBe(0)

    await pool.query(
      `UPDATE elearning_learning_sessions SET last_event_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [started.sessionId],
    )
    const seek = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 2,
      positionMs: 50_000,
      playing: true,
    })
    expect(seek.lastClientPositionMs).toBe(50_000)
    expect(seek.creditedMs).toBeGreaterThan(0)
    expect(seek.creditedMs).toBeLessThan(8_000)
    expect(seek.maxPositionMs).toBe(seek.creditedMs)
    expect(seek.maxPositionMs).not.toBe(50_000)
    expect(seek.effectiveMs).toBe(seek.creditedMs)

    await pool.query(
      `UPDATE elearning_learning_sessions SET last_event_at = clock_timestamp() - interval '2 minutes' WHERE id = $1`,
      [started.sessionId],
    )
    const wall = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 3,
      positionMs: 120_000,
      playing: true,
    })
    expect(wall.lastClientPositionMs).toBe(120_000)
    expect(wall.creditedMs).toBe(60_000)
    expect(wall.maxPositionMs).toBe(seek.maxPositionMs + 60_000)
    expect(wall.maxPositionMs).not.toBe(120_000)
    expect(wall.effectiveMs).toBe(seek.effectiveMs + 60_000)
  })

  it('recovers credit after a paused duration seek without burning the trusted frontier', async () => {
    const org = orgId('recover')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org, durationMs: 120_000 })
    const started = await startElearningWatch(db, { orgId: org, userId: seed.userId, itemId: seed.itemId })

    const paused = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 1,
      positionMs: 120_000,
      playing: false,
    })
    expect(paused).toEqual(expect.objectContaining({
      creditedMs: 0,
      maxPositionMs: 0,
      lastClientPositionMs: 120_000,
      effectiveMs: 0,
      duplicate: false,
    }))

    const rewind = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 2,
      positionMs: 0,
      playing: false,
    })
    expect(rewind).toEqual(expect.objectContaining({
      creditedMs: 0,
      maxPositionMs: 0,
      lastClientPositionMs: 0,
    }))

    await pool.query(
      `UPDATE elearning_learning_sessions SET last_event_at = clock_timestamp() - interval '10 seconds' WHERE id = $1`,
      [started.sessionId],
    )
    const watched = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 3,
      positionMs: 3_000,
      playing: true,
    })
    expect(watched.creditedMs).toBe(3_000)
    expect(watched.maxPositionMs).toBe(3_000)
    expect(watched.effectiveMs).toBe(3_000)

    await pool.query(
      `UPDATE elearning_learning_sessions SET last_event_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [started.sessionId],
    )
    const seek = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 4,
      positionMs: 100_000,
      playing: true,
    })
    expect(seek.creditedMs).toBeGreaterThan(0)
    expect(seek.creditedMs).toBeLessThan(8_000)
    expect(seek.maxPositionMs).toBe(watched.maxPositionMs + seek.creditedMs)
    expect(seek.maxPositionMs).not.toBe(100_000)
    expect(seek.lastClientPositionMs).toBe(100_000)
    expect(seek.effectiveMs).toBe(watched.effectiveMs + seek.creditedMs)

    await pool.query(
      `UPDATE elearning_learning_sessions SET last_event_at = clock_timestamp() - interval '10 seconds' WHERE id = $1`,
      [started.sessionId],
    )
    const idle = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 5,
      positionMs: 100_000,
      playing: true,
    })
    expect(idle).toEqual(expect.objectContaining({
      creditedMs: 0,
      maxPositionMs: seek.maxPositionMs,
      lastClientPositionMs: 100_000,
      effectiveMs: seek.effectiveMs,
    }))

    const back = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 6,
      positionMs: 0,
      playing: false,
    })
    expect(back).toEqual(expect.objectContaining({
      creditedMs: 0,
      maxPositionMs: seek.maxPositionMs,
      lastClientPositionMs: 0,
      effectiveMs: seek.effectiveMs,
    }))

    await pool.query(
      `UPDATE elearning_learning_sessions SET last_event_at = clock_timestamp() - interval '10 seconds' WHERE id = $1`,
      [started.sessionId],
    )
    const replay = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 7,
      positionMs: seek.maxPositionMs,
      playing: true,
    })
    expect(replay).toEqual(expect.objectContaining({
      creditedMs: 0,
      maxPositionMs: seek.maxPositionMs,
      effectiveMs: seek.effectiveMs,
    }))

    await pool.query(
      `UPDATE elearning_learning_sessions SET last_event_at = clock_timestamp() - interval '2 seconds' WHERE id = $1`,
      [started.sessionId],
    )
    const novel = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 8,
      positionMs: seek.maxPositionMs + 2_000,
      playing: true,
    })
    expect(novel.creditedMs).toBe(2_000)
    expect(novel.maxPositionMs).toBe(seek.maxPositionMs + 2_000)
    expect(novel.effectiveMs).toBe(seek.effectiveMs + 2_000)

    const session = await pool.query(
      `SELECT last_client_position_ms, effective_ms, max_position_ms
         FROM elearning_learning_sessions WHERE org_id = $1`,
      [org],
    )
    expect(Number(session.rows[0].last_client_position_ms)).toBe(novel.lastClientPositionMs)
    expect(Number(session.rows[0].effective_ms)).toBe(novel.effectiveMs)
    expect(Number(session.rows[0].max_position_ms)).toBe(novel.maxPositionMs)
    const progress = await pool.query(
      `SELECT effective_ms, max_position_ms FROM elearning_progress WHERE org_id = $1`,
      [org],
    )
    expect(Number(progress.rows[0].effective_ms)).toBe(novel.effectiveMs)
    expect(Number(progress.rows[0].max_position_ms)).toBe(novel.maxPositionMs)
    expect(await countOrg('elearning_completion_evidence', org)).toBe(0)
  })

  it('blocks revoked members and withdrawn courses, allows expired deadlines and retired pinned assignments', async () => {
    const revokedOrg = orgId('revoked')
    seededOrgIds.push(revokedOrg)
    const revoked = await seedPublishedAssignment({ org: revokedOrg })
    await pool.query(
      `UPDATE elearning_assignment_members
          SET revoked_at = now(), revoked_by = $1, revocation_reason = 'pilot revoke'
        WHERE org_id = $2 AND id = $3`,
      [actor('revoker'), revokedOrg, revoked.memberId],
    )
    await expect(startElearningWatch(db, {
      orgId: revokedOrg,
      userId: revoked.userId,
      itemId: revoked.itemId,
    })).rejects.toBeInstanceOf(ElearningWatchError)
    await expect(startElearningWatch(db, {
      orgId: revokedOrg,
      userId: revoked.userId,
      itemId: revoked.itemId,
    })).rejects.toMatchObject({ code: 'assignment_unavailable' })

    const withdrawnOrg = orgId('withdrawn')
    seededOrgIds.push(withdrawnOrg)
    const withdrawn = await seedPublishedAssignment({ org: withdrawnOrg })
    const live = await startElearningWatch(db, {
      orgId: withdrawnOrg,
      userId: withdrawn.userId,
      itemId: withdrawn.itemId,
    })
    await pool.query(
      `UPDATE elearning_courses SET status = 'withdrawn' WHERE org_id = $1 AND id = $2`,
      [withdrawnOrg, withdrawn.courseId],
    )
    await expect(recordElearningHeartbeat(db, {
      sessionId: live.sessionId!,
      orgId: withdrawnOrg,
      userId: withdrawn.userId,
      sequence: 1,
      positionMs: 1_000,
      playing: true,
    })).rejects.toMatchObject({ code: 'course_withdrawn' })
    await expect(startElearningWatch(db, {
      orgId: withdrawnOrg,
      userId: withdrawn.userId,
      itemId: withdrawn.itemId,
    })).rejects.toMatchObject({ code: 'course_withdrawn' })

    const expiredOrg = orgId('expired')
    seededOrgIds.push(expiredOrg)
    const expired = await seedPublishedAssignment({
      org: expiredOrg,
      deadline: new Date(Date.now() - 60_000).toISOString(),
    })
    await expect(startElearningWatch(db, {
      orgId: expiredOrg,
      userId: expired.userId,
      itemId: expired.itemId,
    })).resolves.toMatchObject({ status: 'in_progress' })

    const retiredOrg = orgId('retired')
    seededOrgIds.push(retiredOrg)
    const retired = await seedPublishedAssignment({ org: retiredOrg })
    await pool.query(
      `UPDATE elearning_course_versions SET status = 'retired', updated_at = now() WHERE org_id = $1 AND id = $2`,
      [retiredOrg, retired.versionId],
    )
    await expect(startElearningWatch(db, {
      orgId: retiredOrg,
      userId: retired.userId,
      itemId: retired.itemId,
    })).resolves.toMatchObject({ status: 'in_progress' })

    const archivedOrg = orgId('archived')
    seededOrgIds.push(archivedOrg)
    const archived = await seedPublishedAssignment({ org: archivedOrg })
    await pool.query(
      `UPDATE elearning_courses SET status = 'archived' WHERE org_id = $1 AND id = $2`,
      [archivedOrg, archived.courseId],
    )
    await expect(startElearningWatch(db, {
      orgId: archivedOrg,
      userId: archived.userId,
      itemId: archived.itemId,
    })).resolves.toMatchObject({ status: 'in_progress' })
  })

  it('completes in one transaction with frozen evidence and never writes a client completed event', async () => {
    const org = orgId('complete')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org, durationMs: 10_000 })
    const started = await startElearningWatch(db, { orgId: org, userId: seed.userId, itemId: seed.itemId })
    await pool.query(
      `UPDATE elearning_learning_sessions SET last_event_at = clock_timestamp() - interval '20 seconds' WHERE id = $1`,
      [started.sessionId],
    )
    const done = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 1,
      positionMs: 10_000,
      playing: true,
      ...({ completed: true, delta: 10_000, timestamp: Date.now() } as Record<string, unknown>),
    } as Parameters<typeof recordElearningHeartbeat>[1])

    expect(done.status).toBe('completed')
    expect(done.effectiveMs).toBeGreaterThanOrEqual(9_000)
    expect(done.duplicate).toBe(false)
    assertValuesFree(done, org, seed.userId)

    const evidence = await pool.query(
      `SELECT completion_policy_version, completion_threshold_bps, media_duration_ms,
              effective_ms, max_position_ms, event_digest, evaluator_version
         FROM elearning_completion_evidence WHERE org_id = $1`,
      [org],
    )
    expect(evidence.rows).toHaveLength(1)
    expect(evidence.rows[0]).toEqual(expect.objectContaining({
      completion_policy_version: ELEARNING_WATCH_POLICY_VERSION,
      completion_threshold_bps: ELEARNING_WATCH_THRESHOLD_BPS,
      evaluator_version: ELEARNING_WATCH_EVALUATOR_VERSION,
    }))
    expect(Number(evidence.rows[0].media_duration_ms)).toBe(10_000)
    expect(Number(evidence.rows[0].effective_ms)).toBe(done.effectiveMs)

    const events = await pool.query<{
      sequence: number
      kind: 'start' | 'heartbeat'
      reported_position_ms: string
      playing: boolean
      credited_ms: string
    }>(
      `SELECT sequence, kind, reported_position_ms, playing, credited_ms
         FROM elearning_progress_events WHERE org_id = $1 ORDER BY sequence`,
      [org],
    )
    expect(events.rows.map((row) => row.kind)).toEqual(['start', 'heartbeat'])
    let digest = ''
    for (const row of events.rows) {
      digest = rollElearningWatchEventDigest(digest, {
        sequence: row.sequence,
        kind: row.kind,
        reportedPositionMs: Number(row.reported_position_ms),
        playing: row.playing,
        creditedMs: Number(row.credited_ms),
      })
    }
    expect(evidence.rows[0].event_digest).toBe(digest)

    const progress = await pool.query(
      `SELECT status, completed_at FROM elearning_progress WHERE org_id = $1`,
      [org],
    )
    const session = await pool.query(
      `SELECT status, closed_at FROM elearning_learning_sessions WHERE org_id = $1`,
      [org],
    )
    expect(progress.rows[0].status).toBe('completed')
    expect(progress.rows[0].completed_at).not.toBeNull()
    expect(session.rows[0].status).toBe('completed')
    expect(session.rows[0].closed_at).not.toBeNull()

    const again = await startElearningWatch(db, { orgId: org, userId: seed.userId, itemId: seed.itemId })
    expect(again).toEqual(expect.objectContaining({
      sessionId: null,
      status: 'completed',
      effectiveMs: done.effectiveMs,
    }))
    expect(await eventKinds(org)).toEqual(['start', 'heartbeat'])

    await expect(recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 2,
      positionMs: 10_000,
      playing: true,
    })).rejects.toMatchObject({ code: 'session_inactive' })
  })

  it('does not double-credit parallel heartbeats with the same sequence', async () => {
    const org = orgId('parallel')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org })
    const started = await startElearningWatch(db, { orgId: org, userId: seed.userId, itemId: seed.itemId })
    await pool.query(
      `UPDATE elearning_learning_sessions SET last_event_at = clock_timestamp() - interval '10 seconds' WHERE id = $1`,
      [started.sessionId],
    )
    const results = await Promise.allSettled([
      recordElearningHeartbeat(db, {
        sessionId: started.sessionId!,
        orgId: org,
        userId: seed.userId,
        sequence: 1,
        positionMs: 4_000,
        playing: true,
      }),
      recordElearningHeartbeat(db, {
        sessionId: started.sessionId!,
        orgId: org,
        userId: seed.userId,
        sequence: 1,
        positionMs: 4_000,
        playing: true,
      }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as Array<PromiseFulfilledResult<{
      creditedMs: number
      duplicate: boolean
      effectiveMs: number
    }>>
    expect(fulfilled).toHaveLength(2)
    const credits = fulfilled.map((r) => r.value.creditedMs).sort((a, b) => a - b)
    expect(credits[0]).toBe(0)
    expect(credits[1]).toBeGreaterThan(0)
    expect(fulfilled.filter((r) => r.value.duplicate)).toHaveLength(1)
    const events = await pool.query(
      `SELECT sequence FROM elearning_progress_events WHERE org_id = $1 AND kind = 'heartbeat'`,
      [org],
    )
    expect(events.rows).toHaveLength(1)
    const progress = await pool.query(
      `SELECT effective_ms FROM elearning_progress WHERE org_id = $1`,
      [org],
    )
    expect(Number(progress.rows[0].effective_ms)).toBe(credits[1])
  })

  it('waits on the course-head lock so an in-flight withdrawal fails start with no writes', async () => {
    const org = orgId('wd-start')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org })
    try {
      await runLockBarrier({
        hold: async (holder: PoolClient) => {
          await holder.query(
            `UPDATE elearning_courses
                SET status = 'withdrawn', updated_at = now()
              WHERE org_id = $1 AND id = $2`,
            [org, seed.courseId],
          )
        },
        wait: (waiter: PoolClient) =>
          startElearningWatch(watchDbFromClient(waiter), {
            orgId: org,
            userId: seed.userId,
            itemId: seed.itemId,
          }),
      })
      throw new Error('expected course_withdrawn')
    } catch (error) {
      expect(error).toBeInstanceOf(ElearningWatchError)
      expect((error as ElearningWatchError).code).toBe('course_withdrawn')
      assertValuesFree(error, org, seed.userId)
    }
    expect(await countOrg('elearning_learning_sessions', org)).toBe(0)
    expect(await countOrg('elearning_progress_events', org)).toBe(0)
    expect(await countOrg('elearning_progress', org)).toBe(0)
    expect(await countOrg('elearning_completion_evidence', org)).toBe(0)
  })

  it('waits on the course-head lock so an in-flight withdrawal fails heartbeat with no credit', async () => {
    const org = orgId('wd-beat')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org })
    const started = await startElearningWatch(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.itemId,
    })
    await pool.query(
      `UPDATE elearning_learning_sessions
          SET last_event_at = clock_timestamp() - interval '10 seconds'
        WHERE id = $1`,
      [started.sessionId],
    )
    try {
      await runLockBarrier({
        hold: async (holder: PoolClient) => {
          await holder.query(
            `UPDATE elearning_courses
                SET status = 'withdrawn', updated_at = now()
              WHERE org_id = $1 AND id = $2`,
            [org, seed.courseId],
          )
        },
        wait: (waiter: PoolClient) =>
          recordElearningHeartbeat(watchDbFromClient(waiter), {
            sessionId: started.sessionId!,
            orgId: org,
            userId: seed.userId,
            sequence: 1,
            positionMs: 4_000,
            playing: true,
          }),
      })
      throw new Error('expected course_withdrawn')
    } catch (error) {
      expect(error).toBeInstanceOf(ElearningWatchError)
      expect((error as ElearningWatchError).code).toBe('course_withdrawn')
      assertValuesFree(error, org, seed.userId)
    }
    expect(await eventKinds(org)).toEqual(['start'])
    const session = await pool.query(
      `SELECT status, last_sequence, effective_ms FROM elearning_learning_sessions WHERE org_id = $1`,
      [org],
    )
    expect(session.rows).toEqual([
      expect.objectContaining({ status: 'active', last_sequence: 0 }),
    ])
    expect(Number(session.rows[0].effective_ms)).toBe(0)
    const progress = await pool.query(
      `SELECT status, effective_ms FROM elearning_progress WHERE org_id = $1`,
      [org],
    )
    expect(progress.rows[0].status).toBe('in_progress')
    expect(Number(progress.rows[0].effective_ms)).toBe(0)
    expect(await countOrg('elearning_completion_evidence', org)).toBe(0)
  })

  it('does not reuse a revoked-member session; rebinds a fresh chain and lets heartbeat succeed', async () => {
    const org = orgId('reassign')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org })
    const started = await startElearningWatch(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.itemId,
    })
    await pool.query(
      `UPDATE elearning_learning_sessions
          SET last_event_at = clock_timestamp() - interval '10 seconds'
        WHERE id = $1`,
      [started.sessionId],
    )
    const credited = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 1,
      positionMs: 4_000,
      playing: true,
    })
    expect(credited.effectiveMs).toBeGreaterThan(0)
    await revokeMember(org, seed.memberId)
    const newMemberId = await seedReplacementMember(seed)

    const restarted = await startElearningWatch(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.itemId,
    })
    expect(restarted.sessionId).not.toBe(started.sessionId)
    expect(restarted).toEqual(expect.objectContaining({
      status: 'in_progress',
      lastSequence: 0,
      lastClientPositionMs: 0,
      effectiveMs: 0,
      maxPositionMs: 0,
      creditedMs: 0,
      duplicate: false,
    }))
    assertValuesFree(restarted, org, seed.userId)

    const sessions = await pool.query<{
      id: string
      status: string
      assignment_member_id: string
      last_sequence: number
      effective_ms: string
      max_position_ms: string
      closed_at: Date | null
    }>(
      `SELECT id, status, assignment_member_id, last_sequence, effective_ms, max_position_ms, closed_at
         FROM elearning_learning_sessions WHERE org_id = $1 ORDER BY started_at`,
      [org],
    )
    expect(sessions.rows).toHaveLength(2)
    expect(sessions.rows[0]).toEqual(expect.objectContaining({
      id: started.sessionId,
      status: 'closed',
      assignment_member_id: seed.memberId,
    }))
    expect(sessions.rows[0].closed_at).not.toBeNull()
    expect(Number(sessions.rows[0].effective_ms)).toBe(credited.effectiveMs)
    expect(sessions.rows[1]).toEqual(expect.objectContaining({
      id: restarted.sessionId,
      status: 'active',
      assignment_member_id: newMemberId,
      last_sequence: 0,
      closed_at: null,
    }))
    expect(Number(sessions.rows[1].effective_ms)).toBe(0)
    expect(Number(sessions.rows[1].max_position_ms)).toBe(0)

    const progress = await pool.query(
      `SELECT assignment_member_id, status, effective_ms, max_position_ms, completed_at
         FROM elearning_progress WHERE org_id = $1`,
      [org],
    )
    expect(progress.rows).toHaveLength(1)
    expect(progress.rows[0]).toEqual(expect.objectContaining({
      assignment_member_id: newMemberId,
      status: 'in_progress',
      completed_at: null,
    }))
    expect(Number(progress.rows[0].effective_ms)).toBe(0)
    expect(Number(progress.rows[0].max_position_ms)).toBe(0)

    const events = await pool.query<{ session_id: string; sequence: number; kind: string }>(
      `SELECT session_id, sequence, kind FROM elearning_progress_events WHERE org_id = $1 ORDER BY received_at, sequence`,
      [org],
    )
    expect(events.rows).toEqual([
      { session_id: started.sessionId, sequence: 0, kind: 'start' },
      { session_id: started.sessionId, sequence: 1, kind: 'heartbeat' },
      { session_id: restarted.sessionId, sequence: 0, kind: 'start' },
    ])
    expect(await countOrg('elearning_completion_evidence', org)).toBe(0)

    await pool.query(
      `UPDATE elearning_learning_sessions
          SET last_event_at = clock_timestamp() - interval '10 seconds'
        WHERE id = $1`,
      [restarted.sessionId],
    )
    const beat = await recordElearningHeartbeat(db, {
      sessionId: restarted.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 1,
      positionMs: 3_000,
      playing: true,
    })
    expect(beat.duplicate).toBe(false)
    expect(beat.status).toBe('in_progress')
    expect(beat.creditedMs).toBeGreaterThan(0)
    expect(beat.effectiveMs).toBe(beat.creditedMs)
  })

  it('reuses an unrevoked active session when another valid member exists', async () => {
    const org = orgId('reuse-member')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org })
    const started = await startElearningWatch(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.itemId,
    })
    await seedReplacementMember(seed)
    const again = await startElearningWatch(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.itemId,
    })
    expect(again.sessionId).toBe(started.sessionId)
    const sessions = await pool.query(
      `SELECT id, status, assignment_member_id FROM elearning_learning_sessions WHERE org_id = $1`,
      [org],
    )
    expect(sessions.rows).toHaveLength(1)
    expect(sessions.rows[0]).toEqual(expect.objectContaining({
      id: started.sessionId,
      status: 'active',
      assignment_member_id: seed.memberId,
    }))
    expect(await eventKinds(org)).toEqual(['start'])
  })

  it('never resets completed progress after revoke and a new valid member', async () => {
    const org = orgId('keep-complete')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org, durationMs: 10_000 })
    const started = await startElearningWatch(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.itemId,
    })
    await pool.query(
      `UPDATE elearning_learning_sessions
          SET last_event_at = clock_timestamp() - interval '20 seconds'
        WHERE id = $1`,
      [started.sessionId],
    )
    const done = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 1,
      positionMs: 10_000,
      playing: true,
    })
    expect(done.status).toBe('completed')
    await revokeMember(org, seed.memberId)
    await seedReplacementMember(seed)
    const seen: string[] = []
    const observing = wrapWatchDb(db, (sql) => {
      seen.push(sql)
    })
    const again = await startElearningWatch(observing, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.itemId,
    })
    expect(again).toEqual(expect.objectContaining({
      sessionId: null,
      status: 'completed',
      effectiveMs: done.effectiveMs,
    }))
    expect(seen.some((sql) => sql.includes('elearning-watch:load-member'))).toBe(true)
    expect(seen.some((sql) => sql.includes('elearning-watch:insert-session'))).toBe(false)
    expect(seen.some((sql) => sql.includes('elearning-watch:rebind-progress'))).toBe(false)
    const progress = await pool.query(
      `SELECT assignment_member_id, status, effective_ms, completed_at
         FROM elearning_progress WHERE org_id = $1`,
      [org],
    )
    expect(progress.rows[0]).toEqual(expect.objectContaining({
      assignment_member_id: seed.memberId,
      status: 'completed',
    }))
    expect(progress.rows[0].completed_at).not.toBeNull()
    expect(Number(progress.rows[0].effective_ms)).toBe(done.effectiveMs)
    expect(await countOrg('elearning_learning_sessions', org)).toBe(1)
    expect(await countOrg('elearning_completion_evidence', org)).toBe(1)
    expect(await eventKinds(org)).toEqual(['start', 'heartbeat'])
  })

  it('does not expose completed progress when the only assignment member is revoked', async () => {
    const org = orgId('complete-revoked')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org, durationMs: 10_000 })
    const started = await startElearningWatch(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.itemId,
    })
    await pool.query(
      `UPDATE elearning_learning_sessions
          SET last_event_at = clock_timestamp() - interval '20 seconds'
        WHERE id = $1`,
      [started.sessionId],
    )
    const done = await recordElearningHeartbeat(db, {
      sessionId: started.sessionId!,
      orgId: org,
      userId: seed.userId,
      sequence: 1,
      positionMs: 10_000,
      playing: true,
    })
    expect(done.status).toBe('completed')
    await revokeMember(org, seed.memberId)

    const progressBefore = await pool.query(
      `SELECT xmin::text AS xmin, assignment_member_id, status, effective_ms,
              max_position_ms, completed_at
         FROM elearning_progress WHERE org_id = $1`,
      [org],
    )
    const evidenceBefore = await pool.query(
      `SELECT xmin::text AS xmin, assignment_member_id, effective_ms, event_digest
         FROM elearning_completion_evidence WHERE org_id = $1`,
      [org],
    )
    const sessionsBefore = await pool.query(
      `SELECT id, status, assignment_member_id, last_sequence
         FROM elearning_learning_sessions WHERE org_id = $1`,
      [org],
    )
    const eventsBefore = await eventKinds(org)

    const seen: string[] = []
    const observing = wrapWatchDb(db, (sql) => {
      seen.push(sql)
    })
    try {
      await startElearningWatch(observing, {
        orgId: org,
        userId: seed.userId,
        itemId: seed.itemId,
      })
      throw new Error('expected assignment_unavailable')
    } catch (error) {
      expect(error).toBeInstanceOf(ElearningWatchError)
      expect((error as ElearningWatchError).code).toBe('assignment_unavailable')
      assertValuesFree(error, org, seed.userId)
    }

    expect(seen.some((sql) => sql.includes('elearning-watch:load-member'))).toBe(true)
    expect(seen.some((sql) => sql.includes('elearning-watch:insert-session'))).toBe(false)
    expect(seen.some((sql) => sql.includes('elearning-watch:insert-event'))).toBe(false)
    expect(seen.some((sql) => sql.includes('elearning-watch:insert-evidence'))).toBe(false)
    expect(seen.some((sql) => sql.includes('elearning-watch:rebind-progress'))).toBe(false)

    const progressAfter = await pool.query(
      `SELECT xmin::text AS xmin, assignment_member_id, status, effective_ms,
              max_position_ms, completed_at
         FROM elearning_progress WHERE org_id = $1`,
      [org],
    )
    const evidenceAfter = await pool.query(
      `SELECT xmin::text AS xmin, assignment_member_id, effective_ms, event_digest
         FROM elearning_completion_evidence WHERE org_id = $1`,
      [org],
    )
    const sessionsAfter = await pool.query(
      `SELECT id, status, assignment_member_id, last_sequence
         FROM elearning_learning_sessions WHERE org_id = $1`,
      [org],
    )
    expect(progressAfter.rows).toEqual(progressBefore.rows)
    expect(progressAfter.rows[0]).toEqual(expect.objectContaining({
      assignment_member_id: seed.memberId,
      status: 'completed',
    }))
    expect(Number(progressAfter.rows[0].effective_ms)).toBe(done.effectiveMs)
    expect(evidenceAfter.rows).toEqual(evidenceBefore.rows)
    expect(sessionsAfter.rows).toEqual(sessionsBefore.rows)
    expect(sessionsAfter.rows).toHaveLength(1)
    expect(await eventKinds(org)).toEqual(eventsBefore)
    expect(await eventKinds(org)).toEqual(['start', 'heartbeat'])
    expect(await countOrg('elearning_learning_sessions', org)).toBe(1)
    expect(await countOrg('elearning_progress_events', org)).toBe(2)
    expect(await countOrg('elearning_completion_evidence', org)).toBe(1)
    expect(await countOrg('elearning_progress', org)).toBe(1)
  })

  it('rolls back heartbeat event, session/progress advance, evidence, and completion when evidence insert fails', async () => {
    const org = orgId('evidence-fail')
    seededOrgIds.push(org)
    const seed = await seedPublishedAssignment({ org, durationMs: 10_000 })
    const started = await startElearningWatch(db, {
      orgId: org,
      userId: seed.userId,
      itemId: seed.itemId,
    })
    await pool.query(
      `UPDATE elearning_learning_sessions
          SET last_event_at = clock_timestamp() - interval '20 seconds'
        WHERE id = $1`,
      [started.sessionId],
    )
    const failing = wrapWatchDb(db, (sql) => {
      if (sql.includes('elearning-watch:insert-evidence')) {
        throw new ElearningWatchError('unavailable')
      }
    })
    try {
      await recordElearningHeartbeat(failing, {
        sessionId: started.sessionId!,
        orgId: org,
        userId: seed.userId,
        sequence: 1,
        positionMs: 10_000,
        playing: true,
      })
      throw new Error('expected unavailable')
    } catch (error) {
      expect(error).toBeInstanceOf(ElearningWatchError)
      expect((error as ElearningWatchError).code).toBe('unavailable')
      assertValuesFree(error, org, seed.userId)
    }
    expect(await eventKinds(org)).toEqual(['start'])
    const session = await pool.query(
      `SELECT status, last_sequence, effective_ms, closed_at
         FROM elearning_learning_sessions WHERE org_id = $1`,
      [org],
    )
    expect(session.rows).toEqual([
      expect.objectContaining({
        status: 'active',
        last_sequence: 0,
        closed_at: null,
      }),
    ])
    expect(Number(session.rows[0].effective_ms)).toBe(0)
    const progress = await pool.query(
      `SELECT status, effective_ms, completed_at FROM elearning_progress WHERE org_id = $1`,
      [org],
    )
    expect(progress.rows[0].status).toBe('in_progress')
    expect(progress.rows[0].completed_at).toBeNull()
    expect(Number(progress.rows[0].effective_ms)).toBe(0)
    expect(await countOrg('elearning_completion_evidence', org)).toBe(0)
  })
})
