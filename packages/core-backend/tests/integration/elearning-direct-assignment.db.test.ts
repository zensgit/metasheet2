/**
 * E-learning V0.1 manual direct-assignment service gate (real PostgreSQL).
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
  assignElearningDirect,
  elearningDirectAssignmentLockKey,
  ElearningDirectAssignmentError,
  hashElearningAssignmentRequest,
  type ElearningDirectAssignmentDb,
  type ElearningDirectAssignmentQueryable,
} from '../../src/services/elearning-direct-assignment'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'elearning V0.1 direct-assignment service gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
const STAMP = Date.now().toString(36)
const NS = `el-asgn-${STAMP}`

const ALL_TRIGGERS = [
  ...ELEARNING_V01_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS,
]

async function exec(target: Pool | PoolClient, sql: string, params?: unknown[]) {
  const result = await target.query(sql, params as never)
  return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
}

class PgAssignDb implements ElearningDirectAssignmentDb {
  constructor(private readonly target: Pool) {}

  query(sql: string, params?: unknown[]) {
    return exec(this.target, sql, params)
  }

  async transaction<T>(handler: (tx: ElearningDirectAssignmentQueryable) => Promise<T>): Promise<T> {
    const client = await this.target.connect()
    try {
      await client.query('BEGIN')
      try {
        const value = await handler({
          query: async (sql, params) => exec(client, sql, params),
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

const db = new PgAssignDb(pool)

function assignDbFromClient(client: PoolClient): ElearningDirectAssignmentDb {
  const query: ElearningDirectAssignmentQueryable['query'] = async (sql, params) => exec(client, sql, params)
  return {
    query,
    async transaction<T>(handler: (tx: ElearningDirectAssignmentQueryable) => Promise<T>): Promise<T> {
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

function wrapAssignDb(
  base: ElearningDirectAssignmentDb,
  beforeQuery: (sql: string) => void,
): ElearningDirectAssignmentDb {
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
    const memberships = await pool.query<{ user_id: string }>(
      'SELECT user_id FROM user_orgs WHERE org_id = $1',
      [org],
    )
    await pool.query('DELETE FROM user_orgs WHERE org_id = $1', [org])
    const userIds = memberships.rows.map((row) => row.user_id)
    if (userIds.length > 0) {
      await pool.query(
        `DELETE FROM users
          WHERE id = ANY($1::text[])
            AND NOT EXISTS (
              SELECT 1 FROM user_orgs uo WHERE uo.user_id = users.id
            )`,
        [userIds],
      )
    }
  } finally {
    await setTriggers(true)
  }
}

interface Seed {
  org: string
  userId: string
  courseId: string
  versionId: string
}

async function insertUser(userId: string, isActive = true): Promise<void> {
  await pool.query(
    `INSERT INTO users (id, email, username, name, password_hash, role, permissions, is_active, is_admin)
     VALUES ($1, $2, $3, 'Assign learner', 'x', 'user', '[]'::jsonb, $4, false)
     ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active`,
    [userId, `${userId}@el-asgn.test`, userId, isActive],
  )
}

async function insertMembership(org: string, userId: string, isActive = true): Promise<void> {
  await insertUser(userId, true)
  await pool.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = EXCLUDED.is_active`,
    [userId, org, isActive],
  )
}

async function seedCourse(input: {
  org: string
  userId?: string
  publish?: boolean
  retire?: boolean
  courseStatus?: 'active' | 'archived' | 'withdrawn'
}): Promise<Seed> {
  const userId = input.userId ?? actor(`learner-${randomUUID().slice(0, 8)}`)
  const courseId = randomUUID()
  const versionId = randomUUID()
  const mediaId = randomUUID()
  const examId = randomUUID()
  const questionId = randomUUID()
  const revisionId = randomUUID()
  const itemId = randomUUID()

  await pool.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES ($1, $2, 'Assign course', 'active', $3)`,
    [courseId, input.org, actor('author')],
  )
  await pool.query(
    `INSERT INTO elearning_course_versions
       (id, org_id, course_id, version, status, title, created_by)
     VALUES ($1, $2, $3, 1, 'draft', 'Version 1', $4)`,
    [versionId, input.org, courseId, actor('author')],
  )
  if (input.publish !== false) {
    await pool.query(
      `INSERT INTO elearning_media (
         id, org_id, storage_key, mime_type, magic_mime_type,
         size_bytes, sha256, duration_ms, status, created_by
       ) VALUES ($1, $2, $3, 'video/mp4', 'video/mp4', 1024, $4, 10000, 'ready', $5)`,
      [mediaId, input.org, `${NS}/media/${mediaId}`, 'a'.repeat(64), actor('uploader')],
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
       VALUES ($1, $2, 'Assign exam', 'draft', 60, 3, $3)`,
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
       ) VALUES ($1, $2, $3, 'video', 1, $4, NULL, 'video-v1-90pct', 9000)`,
      [itemId, input.org, versionId, mediaId],
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
    if (input.retire) {
      await pool.query(
        `UPDATE elearning_course_versions SET status = 'retired', updated_at = now() WHERE org_id = $1 AND id = $2`,
        [input.org, versionId],
      )
    }
  }
  if (input.courseStatus && input.courseStatus !== 'active') {
    await pool.query(
      `UPDATE elearning_courses SET status = $1, updated_at = now() WHERE org_id = $2 AND id = $3`,
      [input.courseStatus, input.org, courseId],
    )
  }
  await insertMembership(input.org, userId, true)
  return { org: input.org, userId, courseId, versionId }
}

async function countOrg(table: string, org: string): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`,
    [org],
  )
  return result.rows[0].n
}

function assertValuesFree(payload: unknown, org: string, userId: string, sourceKey: string): void {
  const blob = JSON.stringify(payload)
  expect(blob).not.toContain(org)
  expect(blob).not.toContain(userId)
  expect(blob).not.toContain(sourceKey)
  expect(blob).not.toContain('answer_key')
  expect(blob).not.toContain('storage_key')
  expect(blob).not.toContain(`${NS}/media/`)
}

describe('elearning V0.1 direct-assignment service gate (real DB)', () => {
  const seededOrgIds: string[] = []

  afterEach(async () => {
    for (const org of seededOrgIds.splice(0)) {
      await cleanupOrg(org)
    }
  })

  afterAll(async () => {
    await pool.end()
  })

  it('creates assignment and manual member atomically with the exact deadline', async () => {
    const org = orgId('create')
    seededOrgIds.push(org)
    const seed = await seedCourse({ org })
    const sourceKey = `${org}-src`
    const deadline = '2026-12-31T08:00:00.000Z'
    const result = await assignElearningDirect(db, {
      orgId: org,
      actorId: actor('assigner'),
      targetUserId: seed.userId,
      courseVersionId: seed.versionId,
      sourceKey,
      deadline,
    })
    expect(result.duplicate).toBe(false)
    const assignment = await pool.query(
      `SELECT course_version_id, source_key, request_hash, request_hash_version,
              deadline, assigned_by
         FROM elearning_assignments WHERE org_id = $1 AND id = $2`,
      [org, result.assignmentId],
    )
    expect(assignment.rows).toHaveLength(1)
    expect(assignment.rows[0].source_key).toBe(sourceKey)
    expect(assignment.rows[0].request_hash_version).toBe(1)
    expect(assignment.rows[0].request_hash).toBe(hashElearningAssignmentRequest({
      courseVersionId: seed.versionId,
      deadline,
      targetUserId: seed.userId,
    }))
    expect(new Date(assignment.rows[0].deadline).toISOString()).toBe(deadline)
    expect(assignment.rows[0].assigned_by).toBe(actor('assigner'))
    const member = await pool.query(
      `SELECT assignment_id, course_version_id, user_id, source, revoked_at
         FROM elearning_assignment_members WHERE org_id = $1 AND id = $2`,
      [org, result.memberId],
    )
    expect(member.rows).toEqual([
      expect.objectContaining({
        assignment_id: result.assignmentId,
        course_version_id: seed.versionId,
        user_id: seed.userId,
        source: 'manual',
        revoked_at: null,
      }),
    ])
    assertValuesFree(result, org, seed.userId, sourceKey)
  })

  it('replays the same key and payload, conflicts on a different payload, and isolates orgs', async () => {
    const org = orgId('idem')
    const orgB = orgId('idem-b')
    seededOrgIds.push(org, orgB)
    const seed = await seedCourse({ org })
    const seedB = await seedCourse({ org: orgB })
    const sourceKey = 'shared-source-key'
    const input = {
      orgId: org,
      actorId: actor('assigner'),
      targetUserId: seed.userId,
      courseVersionId: seed.versionId,
      sourceKey,
      deadline: null as string | null,
    }
    const first = await assignElearningDirect(db, input)
    const duplicate = await assignElearningDirect(db, { ...input, actorId: actor('retry') })
    expect(duplicate).toEqual({
      assignmentId: first.assignmentId,
      memberId: first.memberId,
      duplicate: true,
    })
    expect(await countOrg('elearning_assignments', org)).toBe(1)
    expect(await countOrg('elearning_assignment_members', org)).toBe(1)

    await pool.query(
      `UPDATE elearning_course_versions
          SET status = 'retired', updated_at = now()
        WHERE org_id = $1 AND id = $2`,
      [org, seed.versionId],
    )
    const afterRetire = await assignElearningDirect(db, input)
    expect(afterRetire).toEqual({
      assignmentId: first.assignmentId,
      memberId: first.memberId,
      duplicate: true,
    })

    try {
      await assignElearningDirect(db, { ...input, deadline: '2026-12-31T00:00:00.000Z' })
      throw new Error('expected conflict')
    } catch (error) {
      expect(error).toBeInstanceOf(ElearningDirectAssignmentError)
      expect((error as ElearningDirectAssignmentError).code).toBe('conflict')
      assertValuesFree(error, org, seed.userId, sourceKey)
    }
    expect(await countOrg('elearning_assignments', org)).toBe(1)
    expect(await countOrg('elearning_assignment_members', org)).toBe(1)

    const other = await assignElearningDirect(db, {
      orgId: orgB,
      actorId: actor('assigner-b'),
      targetUserId: seedB.userId,
      courseVersionId: seedB.versionId,
      sourceKey,
      deadline: null,
    })
    expect(other.duplicate).toBe(false)
    expect(other.assignmentId).not.toBe(first.assignmentId)
    expect(await countOrg('elearning_assignments', orgB)).toBe(1)
    expect(await countOrg('elearning_assignment_members', orgB)).toBe(1)
  })

  it('converges concurrent duplicates onto one assignment and member', async () => {
    const org = orgId('race')
    seededOrgIds.push(org)
    const seed = await seedCourse({ org })
    const sourceKey = `${org}-race`
    const input = {
      orgId: org,
      actorId: actor('assigner'),
      targetUserId: seed.userId,
      courseVersionId: seed.versionId,
      sourceKey,
      deadline: null as string | null,
    }
    const raced = await Promise.all([
      assignElearningDirect(db, input),
      assignElearningDirect(db, input),
    ])
    expect(raced[0].assignmentId).toBe(raced[1].assignmentId)
    expect(raced[0].memberId).toBe(raced[1].memberId)
    expect(raced.filter((row) => row.duplicate)).toHaveLength(1)
    expect(await countOrg('elearning_assignments', org)).toBe(1)
    expect(await countOrg('elearning_assignment_members', org)).toBe(1)
  })

  it('waits on the advisory lock so a blocked duplicate converges on the holder row', async () => {
    const org = orgId('lock-dup')
    seededOrgIds.push(org)
    const seed = await seedCourse({ org })
    const sourceKey = `${org}-lock`
    const deadline = null
    const assignmentId = randomUUID()
    const memberId = randomUUID()
    const requestHash = hashElearningAssignmentRequest({
      courseVersionId: seed.versionId,
      deadline,
      targetUserId: seed.userId,
    })
    const result = await runLockBarrier({
      hold: async (holder: PoolClient) => {
        await holder.query(
          `SELECT pg_advisory_xact_lock(hashtext($1))`,
          [elearningDirectAssignmentLockKey(org, sourceKey)],
        )
      },
      wait: (waiter: PoolClient) =>
        assignElearningDirect(assignDbFromClient(waiter), {
          orgId: org,
          actorId: actor('waiter'),
          targetUserId: seed.userId,
          courseVersionId: seed.versionId,
          sourceKey,
          deadline,
        }),
      afterBlocked: async (holder: PoolClient) => {
        await holder.query(
          `INSERT INTO elearning_assignments (
             id, org_id, course_version_id, source_key, request_hash, request_hash_version,
             deadline, assigned_by
           ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
          [assignmentId, org, seed.versionId, sourceKey, requestHash, deadline, actor('holder')],
        )
        await holder.query(
          `INSERT INTO elearning_assignment_members (
             id, org_id, assignment_id, course_version_id, user_id, source
           ) VALUES ($1, $2, $3, $4, $5, 'manual')`,
          [memberId, org, assignmentId, seed.versionId, seed.userId],
        )
      },
    })
    expect(result).toEqual({ assignmentId, memberId, duplicate: true })
    expect(await countOrg('elearning_assignments', org)).toBe(1)
    expect(await countOrg('elearning_assignment_members', org)).toBe(1)
  })

  it('waits on the course-head lock so an in-flight withdrawal refuses the new assignment', async () => {
    const org = orgId('wd-head')
    seededOrgIds.push(org)
    const seed = await seedCourse({ org })
    const sourceKey = `${org}-wd`
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
          assignElearningDirect(assignDbFromClient(waiter), {
            orgId: org,
            actorId: actor('assigner'),
            targetUserId: seed.userId,
            courseVersionId: seed.versionId,
            sourceKey,
            deadline: null,
          }),
      })
      throw new Error('expected course_unavailable')
    } catch (error) {
      expect(error).toBeInstanceOf(ElearningDirectAssignmentError)
      expect((error as ElearningDirectAssignmentError).code).toBe('course_unavailable')
      assertValuesFree(error, org, seed.userId, sourceKey)
    }
    expect(await countOrg('elearning_assignments', org)).toBe(0)
    expect(await countOrg('elearning_assignment_members', org)).toBe(0)
  })

  it('waits on the platform-user lock so an in-flight deactivation refuses the new assignment', async () => {
    const org = orgId('wd-user')
    seededOrgIds.push(org)
    const seed = await seedCourse({ org })
    const sourceKey = `${org}-wd-user`
    try {
      await runLockBarrier({
        hold: async (holder: PoolClient) => {
          await holder.query(
            `UPDATE users SET is_active = false, updated_at = now() WHERE id = $1`,
            [seed.userId],
          )
        },
        wait: (waiter: PoolClient) =>
          assignElearningDirect(assignDbFromClient(waiter), {
            orgId: org,
            actorId: actor('assigner'),
            targetUserId: seed.userId,
            courseVersionId: seed.versionId,
            sourceKey,
            deadline: null,
          }),
      })
      throw new Error('expected target_unavailable')
    } catch (error) {
      expect(error).toBeInstanceOf(ElearningDirectAssignmentError)
      expect((error as ElearningDirectAssignmentError).code).toBe('target_unavailable')
      assertValuesFree(error, org, seed.userId, sourceKey)
    }
    expect(await countOrg('elearning_assignments', org)).toBe(0)
    expect(await countOrg('elearning_assignment_members', org)).toBe(0)
  })

  it('rolls back assignment insert when member insert is injected-failed', async () => {
    const org = orgId('rollback')
    seededOrgIds.push(org)
    const seed = await seedCourse({ org })
    const sourceKey = `${org}-fail`
    const failing = wrapAssignDb(db, (sql) => {
      if (sql.includes('elearning-assign:insert-member')) {
        throw new ElearningDirectAssignmentError('unavailable')
      }
    })
    try {
      await assignElearningDirect(failing, {
        orgId: org,
        actorId: actor('assigner'),
        targetUserId: seed.userId,
        courseVersionId: seed.versionId,
        sourceKey,
        deadline: null,
      })
      throw new Error('expected unavailable')
    } catch (error) {
      expect(error).toBeInstanceOf(ElearningDirectAssignmentError)
      expect((error as ElearningDirectAssignmentError).code).toBe('unavailable')
      assertValuesFree(error, org, seed.userId, sourceKey)
    }
    expect(await countOrg('elearning_assignments', org)).toBe(0)
    expect(await countOrg('elearning_assignment_members', org)).toBe(0)
  })

  it('refuses cross-org targets, draft/retired versions, and archived/withdrawn heads with no rows', async () => {
    const org = orgId('neg')
    const other = orgId('neg-other')
    seededOrgIds.push(org, other)
    const published = await seedCourse({ org })
    const draft = await seedCourse({ org, publish: false, userId: published.userId })
    const retired = await seedCourse({ org, retire: true })
    const archived = await seedCourse({ org, courseStatus: 'archived' })
    const withdrawn = await seedCourse({ org, courseStatus: 'withdrawn' })
    const foreign = await seedCourse({ org: other })

    const cases: Array<{
      label: string
      input: Parameters<typeof assignElearningDirect>[1]
      code: string
    }> = [
      {
        label: 'cross-org target',
        input: {
          orgId: org,
          actorId: actor('assigner'),
          targetUserId: foreign.userId,
          courseVersionId: published.versionId,
          sourceKey: `${org}-xo-target`,
          deadline: null,
        },
        code: 'target_unavailable',
      },
      {
        label: 'draft version',
        input: {
          orgId: org,
          actorId: actor('assigner'),
          targetUserId: published.userId,
          courseVersionId: draft.versionId,
          sourceKey: `${org}-draft`,
          deadline: null,
        },
        code: 'course_unavailable',
      },
      {
        label: 'retired version',
        input: {
          orgId: org,
          actorId: actor('assigner'),
          targetUserId: retired.userId,
          courseVersionId: retired.versionId,
          sourceKey: `${org}-retired`,
          deadline: null,
        },
        code: 'course_unavailable',
      },
      {
        label: 'archived head',
        input: {
          orgId: org,
          actorId: actor('assigner'),
          targetUserId: archived.userId,
          courseVersionId: archived.versionId,
          sourceKey: `${org}-archived`,
          deadline: null,
        },
        code: 'course_unavailable',
      },
      {
        label: 'withdrawn head',
        input: {
          orgId: org,
          actorId: actor('assigner'),
          targetUserId: withdrawn.userId,
          courseVersionId: withdrawn.versionId,
          sourceKey: `${org}-withdrawn`,
          deadline: null,
        },
        code: 'course_unavailable',
      },
      {
        label: 'cross-org version',
        input: {
          orgId: org,
          actorId: actor('assigner'),
          targetUserId: published.userId,
          courseVersionId: foreign.versionId,
          sourceKey: `${org}-xo-version`,
          deadline: null,
        },
        code: 'not_found',
      },
    ]

    for (const item of cases) {
      try {
        await assignElearningDirect(db, item.input)
        throw new Error(`expected ${item.code} for ${item.label}`)
      } catch (error) {
        expect(error).toBeInstanceOf(ElearningDirectAssignmentError)
        expect((error as ElearningDirectAssignmentError).code).toBe(item.code)
        assertValuesFree(error, org, item.input.targetUserId, item.input.sourceKey)
      }
    }

    await insertMembership(org, published.userId, false)
    try {
      await assignElearningDirect(db, {
        orgId: org,
        actorId: actor('assigner'),
        targetUserId: published.userId,
        courseVersionId: published.versionId,
        sourceKey: `${org}-inactive`,
        deadline: '2000-01-01T00:00:00.000Z',
      })
      throw new Error('expected target_unavailable')
    } catch (error) {
      expect((error as ElearningDirectAssignmentError).code).toBe('target_unavailable')
      assertValuesFree(error, org, published.userId, `${org}-inactive`)
    }

    const inactivePlatformUser = actor(`inactive-platform-${randomUUID().slice(0, 8)}`)
    await insertUser(inactivePlatformUser, false)
    await pool.query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = true`,
      [inactivePlatformUser, org],
    )
    try {
      await assignElearningDirect(db, {
        orgId: org,
        actorId: actor('assigner'),
        targetUserId: inactivePlatformUser,
        courseVersionId: published.versionId,
        sourceKey: `${org}-inactive-user`,
        deadline: '2000-01-01T00:00:00.000Z',
      })
      throw new Error('expected target_unavailable')
    } catch (error) {
      expect(error).toBeInstanceOf(ElearningDirectAssignmentError)
      expect((error as ElearningDirectAssignmentError).code).toBe('target_unavailable')
      assertValuesFree(error, org, inactivePlatformUser, `${org}-inactive-user`)
    }

    expect(await countOrg('elearning_assignments', org)).toBe(0)
    expect(await countOrg('elearning_assignment_members', org)).toBe(0)
    expect(await countOrg('elearning_assignments', other)).toBe(0)
    expect(await countOrg('elearning_assignment_members', other)).toBe(0)
  })

  it('keeps an expired deadline as stored fact and does not treat expiry as revoke', async () => {
    const org = orgId('deadline')
    seededOrgIds.push(org)
    const seed = await seedCourse({ org })
    const sourceKey = `${org}-past`
    const deadline = '2000-01-01T00:00:00.000Z'
    const result = await assignElearningDirect(db, {
      orgId: org,
      actorId: actor('assigner'),
      targetUserId: seed.userId,
      courseVersionId: seed.versionId,
      sourceKey,
      deadline,
    })
    const row = await pool.query(
      `SELECT deadline, revoked_at
         FROM elearning_assignments a
         JOIN elearning_assignment_members m
           ON m.org_id = a.org_id AND m.assignment_id = a.id
        WHERE a.org_id = $1 AND a.id = $2`,
      [org, result.assignmentId],
    )
    expect(new Date(row.rows[0].deadline).toISOString()).toBe(deadline)
    expect(row.rows[0].revoked_at).toBeNull()
    const replay = await assignElearningDirect(db, {
      orgId: org,
      actorId: actor('assigner'),
      targetUserId: seed.userId,
      courseVersionId: seed.versionId,
      sourceKey,
      deadline,
    })
    expect(replay.duplicate).toBe(true)
    expect(replay.assignmentId).toBe(result.assignmentId)
  })

})
