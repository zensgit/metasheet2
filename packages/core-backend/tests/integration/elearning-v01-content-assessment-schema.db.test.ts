/**
 * E-learning V0.1 content + assessment schema gate (real PostgreSQL).
 *
 * This file assumes both Part A migrations have already been applied by the
 * caller — in CI that is `.github/workflows/plugin-tests.yml` "Run DB migrations"
 * immediately before this whole-file step. It does not call up()/down() and
 * does not write kysely_migration.
 *
 * DATABASE_URL is required. A missing URL throws (refuses skip-shaped green).
 * HTTP/API surfaces are out of this slice. Concurrent freeze proofs use two
 * PoolClient sessions from this file's Pool plus a pg_locks barrier.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import {
  ELEARNING_MEDIA_STALE_CLAIM_INDEX,
  ELEARNING_V01_IMMUTABILITY_TRIGGERS,
  ELEARNING_V01_TABLES,
  GRADING_RECORD_ATTEMPT_KIND_UNIQ,
} from '../../src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment'
import { ELEARNING_PERMISSION_CODES } from '../../src/db/migrations/zzzz20260824121000_add_elearning_permissions'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'elearning V0.1 content/assessment schema gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
const STAMP = Date.now().toString(36)
const NS = `el-f3a-${STAMP}`

interface PgError extends Error {
  code?: string
  constraint?: string
}

function orgId(suffix: string): string {
  return `${NS}-${suffix}`
}

function actor(suffix: string): string {
  return `${NS}-actor-${suffix}`
}

async function reject(fn: () => Promise<unknown>): Promise<PgError | null> {
  try {
    await fn()
    return null
  } catch (error) {
    return error as PgError
  }
}

async function setImmutabilityTriggers(enabled: boolean): Promise<void> {
  const verb = enabled ? 'ENABLE' : 'DISABLE'
  for (const { table, name } of ELEARNING_V01_IMMUTABILITY_TRIGGERS) {
    await pool.query(`ALTER TABLE ${table} ${verb} TRIGGER ${name}`)
  }
}

async function cleanupOrg(org: string): Promise<void> {
  // Production triggers refuse row DELETE/UPDATE on frozen tables. This
  // independent whole-file gate may DISABLE every named immutability trigger
  // for namespace cleanup, and MUST re-enable them in `finally`.
  await setImmutabilityTriggers(false)
  try {
    await pool.query('DELETE FROM elearning_grading_records WHERE org_id = $1', [org])
    await pool.query('DELETE FROM elearning_exam_attempts WHERE org_id = $1', [org])
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
    await setImmutabilityTriggers(true)
  }
}

async function insertCourse(org: string, id: string, title = 'Pilot course'): Promise<void> {
  await pool.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES ($1, $2, $3, 'active', $4)`,
    [id, org, title, actor('author')],
  )
}

async function insertVersion(
  org: string,
  id: string,
  courseId: string,
  version = 1,
  status = 'draft',
): Promise<void> {
  await pool.query(
    `INSERT INTO elearning_course_versions
       (id, org_id, course_id, version, status, title, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, org, courseId, version, status, `Version ${version}`, actor('author')],
  )
}

async function insertMedia(org: string, id: string, status = 'ready'): Promise<void> {
  await pool.query(
    `INSERT INTO elearning_media (
       id, org_id, storage_key, mime_type, magic_mime_type,
       size_bytes, sha256, duration_ms, status, created_by
     ) VALUES ($1, $2, $3, 'video/mp4', 'video/mp4', 1024, $4, 60000, $5, $6)`,
    [id, org, `${NS}/media/${id}`, 'a'.repeat(64), status, actor('uploader')],
  )
}

async function insertQuestion(org: string, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO elearning_questions (id, org_id, created_by) VALUES ($1, $2, $3)`,
    [id, org, actor('author')],
  )
}

async function insertRevision(org: string, id: string, questionId: string, revision = 1): Promise<void> {
  await pool.query(
    `INSERT INTO elearning_question_revisions (
       id, org_id, question_id, revision, question_type, prompt, options, answer_key, points, created_by
     ) VALUES ($1, $2, $3, $4, 'single_choice', 'Pick one', $5::jsonb, $6::jsonb, 10, $7)`,
    [
      id,
      org,
      questionId,
      revision,
      JSON.stringify([{ id: 'a', text: 'yes' }, { id: 'b', text: 'no' }]),
      JSON.stringify({ correct: ['a'] }),
      actor('author'),
    ],
  )
}

async function insertExam(org: string, id: string, status = 'draft'): Promise<void> {
  await pool.query(
    `INSERT INTO elearning_exams (id, org_id, title, status, pass_score, max_attempts, created_by)
     VALUES ($1, $2, 'Pilot exam', $3, 60, 3, $4)`,
    [id, org, status, actor('author')],
  )
}

async function publishExam(org: string, examId: string): Promise<void> {
  await pool.query(
    `UPDATE elearning_exams
        SET status = 'published', updated_at = now()
      WHERE org_id = $1 AND id = $2`,
    [org, examId],
  )
}

async function publishVersion(org: string, versionId: string): Promise<void> {
  await pool.query(
    `UPDATE elearning_course_versions
        SET status = 'published', updated_at = now()
      WHERE org_id = $1 AND id = $2`,
    [org, versionId],
  )
}

async function setActiveVersion(org: string, courseId: string, versionId: string | null): Promise<void> {
  await pool.query(
    `UPDATE elearning_courses SET active_version_id = $1 WHERE org_id = $2 AND id = $3`,
    [versionId, org, courseId],
  )
}

async function insertExamQuestion(
  org: string,
  examId: string,
  revisionId: string,
  position = 1,
): Promise<void> {
  await pool.query(
    `INSERT INTO elearning_exam_questions (org_id, exam_id, question_revision_id, position, points)
     VALUES ($1, $2, $3, $4, 10)`,
    [org, examId, revisionId, position],
  )
}

async function insertItem(input: {
  org: string
  versionId: string
  itemType: 'video' | 'exam'
  position: number
  mediaId?: string | null
  examId?: string | null
}): Promise<void> {
  await pool.query(
    `INSERT INTO elearning_course_version_items
       (org_id, course_version_id, item_type, position, media_id, exam_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.org, input.versionId, input.itemType, input.position, input.mediaId ?? null, input.examId ?? null],
  )
}

async function insertAttempt(input: {
  org: string
  examId: string
  versionId: string
  userId: string
  attemptNo: number
  status?: string
  autoScore?: number | null
  totalScore?: number | null
  passed?: boolean | null
  answers?: Record<string, unknown> | null
  submittedAt?: string | null
  gradedAt?: string | null
}): Promise<string> {
  const status = input.status ?? 'started'
  const isGraded = status === 'graded'
  const answers = input.answers === undefined ? {} : input.answers
  const submittedAt = input.submittedAt === undefined
    ? (isGraded ? new Date().toISOString() : null)
    : input.submittedAt
  const gradedAt = input.gradedAt === undefined
    ? (isGraded ? new Date().toISOString() : null)
    : input.gradedAt
  const result = await pool.query<{ id: string }>(
    `INSERT INTO elearning_exam_attempts (
       org_id, exam_id, course_version_id, user_id, attempt_no,
       paper_snapshot, answers, auto_score, total_score, passed, status,
       submitted_at, graded_at
     ) VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      input.org,
      input.examId,
      input.versionId,
      input.userId,
      input.attemptNo,
      answers === null ? null : JSON.stringify(answers),
      input.autoScore ?? null,
      input.totalScore ?? null,
      input.passed ?? null,
      status,
      submittedAt,
      gradedAt,
    ],
  )
  return result.rows[0].id
}

async function submitAttempt(
  id: string,
  answers: Record<string, unknown> = { choice: 'a' },
): Promise<void> {
  await pool.query(
    `UPDATE elearning_exam_attempts
        SET status = 'submitted', answers = $2::jsonb, submitted_at = now()
      WHERE id = $1`,
    [id, JSON.stringify(answers)],
  )
}

async function expireAttempt(
  id: string,
  answers: Record<string, unknown> = { choice: 'a' },
): Promise<void> {
  await pool.query(
    `UPDATE elearning_exam_attempts
        SET status = 'expired', answers = $2::jsonb, submitted_at = now()
      WHERE id = $1`,
    [id, JSON.stringify(answers)],
  )
}

async function gradeAttempt(
  id: string,
  autoScore = 8,
  totalScore = 10,
  passed = true,
): Promise<void> {
  await pool.query(
    `UPDATE elearning_exam_attempts
        SET status = 'graded',
            auto_score = $2,
            total_score = $3,
            passed = $4,
            graded_at = now()
      WHERE id = $1`,
    [id, autoScore, totalScore, passed],
  )
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
    // Holder first: releasing its lock unblocks waiter so a barrier/afterBlocked
    // throw does not sit on lock_timeout (15s) before cleanup can proceed.
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

async function seedGraph(org: string): Promise<{
  courseId: string
  versionId: string
  mediaId: string
  questionId: string
  revisionId: string
  examId: string
}> {
  const courseId = randomUUID()
  const versionId = randomUUID()
  const mediaId = randomUUID()
  const questionId = randomUUID()
  const revisionId = randomUUID()
  const examId = randomUUID()

  await insertCourse(org, courseId)
  await insertVersion(org, versionId, courseId)
  await pool.query(
    `UPDATE elearning_courses
        SET latest_version_id = $1
      WHERE org_id = $2 AND id = $3`,
    [versionId, org, courseId],
  )
  await insertMedia(org, mediaId)
  await insertQuestion(org, questionId)
  await insertRevision(org, revisionId, questionId)
  await insertExam(org, examId)
  await insertExamQuestion(org, examId, revisionId)
  await insertItem({ org, versionId, itemType: 'video', position: 1, mediaId })
  await insertItem({ org, versionId, itemType: 'exam', position: 2, examId })
  return { courseId, versionId, mediaId, questionId, revisionId, examId }
}

describe('elearning V0.1 content/assessment schema gate (real DB)', () => {
  const seededOrgIds: string[] = []

  afterEach(async () => {
    for (const org of seededOrgIds.splice(0)) {
      await cleanupOrg(org)
    }
  })

  afterAll(async () => {
    try {
      const result = await pool.query<{ tgname: string; tgenabled: string }>(
        `SELECT t.tgname, t.tgenabled::text AS tgenabled
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema()
            AND NOT t.tgisinternal
            AND t.tgname = ANY($1::text[])
          ORDER BY t.tgname`,
        [ELEARNING_V01_IMMUTABILITY_TRIGGERS.map((row) => row.name)],
      )
      expect(result.rows).toHaveLength(ELEARNING_V01_IMMUTABILITY_TRIGGERS.length)
      expect(result.rows.every((row) => row.tgenabled === 'O')).toBe(true)
    } finally {
      await pool.end()
    }
  })

  it('refuses to run without DATABASE_URL (sentinel)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('records both Part A migrations as already applied (read-only ledger check)', async () => {
    const result = await pool.query<{ name: string }>(
      `SELECT name FROM kysely_migration
        WHERE name = ANY($1::text[])
        ORDER BY name`,
      [[
        'zzzz20260824120000_create_elearning_v01_content_assessment',
        'zzzz20260824121000_add_elearning_permissions',
      ]],
    )
    expect(result.rows.map((row) => row.name)).toEqual([
      'zzzz20260824120000_create_elearning_v01_content_assessment',
      'zzzz20260824121000_add_elearning_permissions',
    ])
  })

  it('creates all 10 tables', async () => {
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [ELEARNING_V01_TABLES],
    )
    expect(result.rows.map((row) => row.table_name).sort()).toEqual([...ELEARNING_V01_TABLES].sort())

    const triggers = await pool.query<{ tgname: string }>(
      `SELECT t.tgname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND NOT t.tgisinternal
          AND t.tgname = ANY($1::text[])
        ORDER BY t.tgname`,
      [ELEARNING_V01_IMMUTABILITY_TRIGGERS.map((row) => row.name)],
    )
    expect(triggers.rows.map((row) => row.tgname).sort()).toEqual(
      [...ELEARNING_V01_IMMUTABILITY_TRIGGERS.map((row) => row.name)].sort(),
    )

    const uniq = await pool.query<{ conname: string }>(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'elearning_grading_records'::regclass
          AND conname = $1`,
      [GRADING_RECORD_ATTEMPT_KIND_UNIQ],
    )
    expect(uniq.rows).toHaveLength(1)
  })

  it('pins the elearning_media stale-claim partial index name, column order, and predicate', async () => {
    const listed = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'elearning_media'
          AND indexname = $1`,
      [ELEARNING_MEDIA_STALE_CLAIM_INDEX],
    )
    expect(listed.rows).toHaveLength(1)
    expect(listed.rows[0].indexname).toBe(ELEARNING_MEDIA_STALE_CLAIM_INDEX)
    expect(listed.rows[0].indexdef).toMatch(/USING btree \(updated_at, id\) WHERE/i)

    const columns = await pool.query<{ attname: string }>(
      `SELECT a.attname
         FROM pg_index ix
         JOIN pg_class idx ON idx.oid = ix.indexrelid
         JOIN pg_class tbl ON tbl.oid = ix.indrelid
         JOIN pg_namespace nsp ON nsp.oid = tbl.relnamespace
         JOIN unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a
           ON a.attrelid = ix.indrelid
          AND a.attnum = k.attnum
        WHERE nsp.nspname = current_schema()
          AND tbl.relname = 'elearning_media'
          AND idx.relname = $1
        ORDER BY k.ord`,
      [ELEARNING_MEDIA_STALE_CLAIM_INDEX],
    )
    expect(columns.rows.map((row) => row.attname)).toEqual(['updated_at', 'id'])

    const predicate = await pool.query<{ predicate: string | null }>(
      `SELECT pg_get_expr(ix.indpred, ix.indrelid) AS predicate
         FROM pg_index ix
         JOIN pg_class idx ON idx.oid = ix.indexrelid
         JOIN pg_class tbl ON tbl.oid = ix.indrelid
         JOIN pg_namespace nsp ON nsp.oid = tbl.relnamespace
        WHERE nsp.nspname = current_schema()
          AND tbl.relname = 'elearning_media'
          AND idx.relname = $1`,
      [ELEARNING_MEDIA_STALE_CLAIM_INDEX],
    )
    expect(predicate.rows).toHaveLength(1)
    expect(predicate.rows[0].predicate).toBe(
      `(status = ANY (ARRAY['uploading'::text, 'probing'::text]))`,
    )
  })

  it('gives every table org_id TEXT NOT NULL with column_default IS NULL', async () => {
    const result = await pool.query<{
      table_name: string
      is_nullable: string
      column_default: string | null
      data_type: string
    }>(
      `SELECT table_name, is_nullable, column_default, data_type
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND column_name = 'org_id'
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [ELEARNING_V01_TABLES],
    )
    expect(result.rows).toHaveLength(ELEARNING_V01_TABLES.length)
    for (const row of result.rows) {
      expect(row.data_type).toBe('text')
      expect(row.is_nullable).toBe('NO')
      expect(row.column_default).toBeNull()
    }
  })

  it('pins head 3-column FKs as RESTRICT and parent composite uniques', async () => {
    const fks = await pool.query<{ conname: string; ncols: number; confdeltype: string }>(
      `SELECT conname, array_length(conkey, 1) AS ncols, confdeltype
         FROM pg_constraint
        WHERE conrelid = 'elearning_courses'::regclass
          AND conname IN ('elearning_courses_active_version_fk', 'elearning_courses_latest_version_fk')`,
    )
    const byName = new Map(fks.rows.map((row) => [row.conname, row]))
    expect(byName.get('elearning_courses_active_version_fk')?.ncols).toBe(3)
    expect(byName.get('elearning_courses_latest_version_fk')?.ncols).toBe(3)
    expect(byName.get('elearning_courses_active_version_fk')?.confdeltype).toBe('r')
    expect(byName.get('elearning_courses_latest_version_fk')?.confdeltype).toBe('r')

    const uniques = await pool.query<{ conname: string; ncols: number }>(
      `SELECT conname, array_length(conkey, 1) AS ncols
         FROM pg_constraint
        WHERE conrelid = 'elearning_course_versions'::regclass
          AND contype = 'u'
          AND conname IN (
            'elearning_course_versions_org_id_id_uniq',
            'elearning_course_versions_org_course_id_uniq',
            'elearning_course_versions_org_course_version_uniq'
          )`,
    )
    const uniqueByName = new Map(uniques.rows.map((row) => [row.conname, row.ncols]))
    expect(uniqueByName.get('elearning_course_versions_org_id_id_uniq')).toBe(2)
    expect(uniqueByName.get('elearning_course_versions_org_course_id_uniq')).toBe(3)
    expect(uniqueByName.get('elearning_course_versions_org_course_version_uniq')).toBe(3)
  })

  it('pins same-org child FKs as arity 2 + RESTRICT', async () => {
    const expected = [
      ['elearning_course_versions', 'elearning_course_versions_course_fk'],
      ['elearning_question_revisions', 'elearning_question_revisions_question_fk'],
      ['elearning_exam_questions', 'elearning_exam_questions_exam_fk'],
      ['elearning_exam_questions', 'elearning_exam_questions_revision_fk'],
      ['elearning_course_version_items', 'elearning_course_version_items_version_fk'],
      ['elearning_course_version_items', 'elearning_course_version_items_media_fk'],
      ['elearning_course_version_items', 'elearning_course_version_items_exam_fk'],
      ['elearning_exam_attempts', 'elearning_exam_attempts_exam_fk'],
      ['elearning_exam_attempts', 'elearning_exam_attempts_version_fk'],
      ['elearning_grading_records', 'elearning_grading_records_attempt_fk'],
    ] as const

    for (const [table, conname] of expected) {
      const result = await pool.query<{ ncols: number; confdeltype: string }>(
        `SELECT array_length(conkey, 1) AS ncols, confdeltype
           FROM pg_constraint
          WHERE conrelid = $1::regclass
            AND conname = $2`,
        [table, conname],
      )
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].ncols).toBe(2)
      expect(result.rows[0].confdeltype).toBe('r')
    }
  })

  it('allows a course with empty version pointers, then a same-org version + pointer update', async () => {
    const org = orgId('pos')
    seededOrgIds.push(org)
    const courseId = randomUUID()
    const versionId = randomUUID()
    await insertCourse(org, courseId)
    await insertVersion(org, versionId, courseId)
    await pool.query(
      `UPDATE elearning_courses SET latest_version_id = $1 WHERE org_id = $2 AND id = $3`,
      [versionId, org, courseId],
    )
    const row = await pool.query<{ latest_version_id: string }>(
      `SELECT latest_version_id FROM elearning_courses WHERE org_id = $1 AND id = $2`,
      [org, courseId],
    )
    expect(row.rows[0].latest_version_id).toBe(versionId)
  })

  it('rejects cross-org course_version / item / exam-question / revision inserts by named FK 23503', async () => {
    const orgA = orgId('xo-a')
    const orgB = orgId('xo-b')
    seededOrgIds.push(orgA, orgB)
    const graphA = await seedGraph(orgA)
    const graphB = await seedGraph(orgB)

    const versionCross = await reject(() =>
      pool.query(
        `INSERT INTO elearning_course_versions
           (org_id, course_id, version, status, title, created_by)
         VALUES ($1, $2, 2, 'draft', 'foreign', $3)`,
        [orgB, graphA.courseId, actor('author')],
      ),
    )
    expect(versionCross?.code).toBe('23503')
    expect(versionCross?.constraint).toBe('elearning_course_versions_course_fk')

    const itemMediaCross = await reject(() =>
      insertItem({
        org: orgA,
        versionId: graphA.versionId,
        itemType: 'video',
        position: 9,
        mediaId: graphB.mediaId,
      }),
    )
    expect(itemMediaCross?.code).toBe('23503')
    expect(itemMediaCross?.constraint).toBe('elearning_course_version_items_media_fk')

    const itemExamCross = await reject(() =>
      insertItem({
        org: orgA,
        versionId: graphA.versionId,
        itemType: 'exam',
        position: 10,
        examId: graphB.examId,
      }),
    )
    expect(itemExamCross?.code).toBe('23503')
    expect(itemExamCross?.constraint).toBe('elearning_course_version_items_exam_fk')

    const examQuestionCross = await reject(() =>
      insertExamQuestion(orgA, graphA.examId, graphB.revisionId, 9),
    )
    expect(examQuestionCross?.code).toBe('23503')
    expect(examQuestionCross?.constraint).toBe('elearning_exam_questions_revision_fk')

    const revisionCross = await reject(() =>
      insertRevision(orgA, randomUUID(), graphB.questionId, 9),
    )
    expect(revisionCross?.code).toBe('23503')
    expect(revisionCross?.constraint).toBe('elearning_question_revisions_question_fk')
  })

  it('rejects a head pointer that targets another course version (same org)', async () => {
    const org = orgId('head-x')
    seededOrgIds.push(org)
    const courseA = randomUUID()
    const courseB = randomUUID()
    const versionB = randomUUID()
    await insertCourse(org, courseA, 'Course A')
    await insertCourse(org, courseB, 'Course B')
    await insertVersion(org, versionB, courseB)

    const err = await reject(() =>
      pool.query(
        `UPDATE elearning_courses SET latest_version_id = $1 WHERE org_id = $2 AND id = $3`,
        [versionB, org, courseA],
      ),
    )
    expect(err?.code).toBe('23503')
    expect(err?.constraint).toBe('elearning_courses_latest_version_fk')
  })

  it('rejects illegal enums, dual-empty/dual-filled items, and negative scores with 23514', async () => {
    const org = orgId('chk')
    seededOrgIds.push(org)
    const graph = await seedGraph(org)

    const statusErr = await reject(() =>
      pool.query(`UPDATE elearning_courses SET status = 'hidden' WHERE org_id = $1`, [org]),
    )
    expect(statusErr?.code).toBe('23514')
    expect(statusErr?.constraint).toBe('elearning_courses_status_chk')

    const dualEmpty = await reject(() =>
      insertItem({
        org,
        versionId: graph.versionId,
        itemType: 'video',
        position: 8,
        mediaId: null,
        examId: null,
      }),
    )
    expect(dualEmpty?.code).toBe('23514')
    expect(dualEmpty?.constraint).toBe('elearning_course_version_items_item_shape_chk')

    const dualFilled = await reject(() =>
      insertItem({
        org,
        versionId: graph.versionId,
        itemType: 'video',
        position: 8,
        mediaId: graph.mediaId,
        examId: graph.examId,
      }),
    )
    expect(dualFilled?.code).toBe('23514')
    expect(dualFilled?.constraint).toBe('elearning_course_version_items_item_shape_chk')

    const negScoreId = await insertAttempt({
      org,
      examId: graph.examId,
      versionId: graph.versionId,
      userId: actor('learner'),
      attemptNo: 1,
    })
    await submitAttempt(negScoreId)
    const negScore = await reject(() => gradeAttempt(negScoreId, -1, 10, false))
    expect(negScore?.code).toBe('23514')
    expect(negScore?.constraint).toBe('elearning_exam_attempts_auto_score_nonneg_chk')

    const orderErrId = await insertAttempt({
      org,
      examId: graph.examId,
      versionId: graph.versionId,
      userId: actor('learner-order'),
      attemptNo: 1,
    })
    await submitAttempt(orderErrId)
    const orderErr = await reject(() => gradeAttempt(orderErrId, 11, 10, true))
    expect(orderErr?.code).toBe('23514')
    expect(orderErr?.constraint).toBe('elearning_exam_attempts_score_order_chk')

    const negPoints = await reject(() =>
      pool.query(
        `INSERT INTO elearning_question_revisions (
           org_id, question_id, revision, question_type, prompt, options, answer_key, points, created_by
         ) VALUES ($1, $2, 2, 'true_false', 'x', '[]'::jsonb, '{}'::jsonb, -1, $3)`,
        [org, graph.questionId, actor('author')],
      ),
    )
    expect(negPoints?.code).toBe('23514')
    expect(negPoints?.constraint).toBe('elearning_question_revisions_points_chk')

    const startedWithScore = await reject(() =>
      insertAttempt({
        org,
        examId: graph.examId,
        versionId: graph.versionId,
        userId: actor('started-score'),
        attemptNo: 3,
        status: 'started',
        autoScore: 1,
      }),
    )
    expect(startedWithScore?.code).toBe('23514')
    expect(startedWithScore?.constraint).toBe('elearning_exam_attempts_started_no_grade_chk')

    const gradedIncompleteId = await insertAttempt({
      org,
      examId: graph.examId,
      versionId: graph.versionId,
      userId: actor('graded-incomplete'),
      attemptNo: 4,
    })
    await submitAttempt(gradedIncompleteId)
    const gradedIncomplete = await reject(() =>
      pool.query(
        `UPDATE elearning_exam_attempts
            SET status = 'graded', auto_score = 8, total_score = 10, passed = true, graded_at = NULL
          WHERE id = $1`,
        [gradedIncompleteId],
      ),
    )
    expect(gradedIncomplete?.code).toBe('23514')
    expect(gradedIncomplete?.constraint).toBe('elearning_exam_attempts_graded_complete_chk')
  })

  it('RESTRICT-blocks deleting a referenced parent', async () => {
    const org = orgId('rst')
    seededOrgIds.push(org)
    const graph = await seedGraph(org)

    const mediaErr = await reject(() =>
      pool.query(`DELETE FROM elearning_media WHERE org_id = $1 AND id = $2`, [org, graph.mediaId]),
    )
    expect(mediaErr?.code).toBe('23503')
    expect(mediaErr?.constraint).toBe('elearning_course_version_items_media_fk')

    const versionErr = await reject(() =>
      pool.query(
        `DELETE FROM elearning_course_versions WHERE org_id = $1 AND id = $2`,
        [org, graph.versionId],
      ),
    )
    expect(versionErr?.code).toBe('23503')

    const questionErr = await reject(() =>
      pool.query(`DELETE FROM elearning_questions WHERE org_id = $1 AND id = $2`, [org, graph.questionId]),
    )
    expect(questionErr?.code).toBe('23503')
    expect(questionErr?.constraint).toBe('elearning_question_revisions_question_fk')
  })

  it('rejects UPDATE/DELETE on question_revisions and grading_records while keeping the original row', async () => {
    const org = orgId('imm')
    seededOrgIds.push(org)
    const graph = await seedGraph(org)
    const attemptId = await insertAttempt({
      org,
      examId: graph.examId,
      versionId: graph.versionId,
      userId: actor('learner'),
      attemptNo: 1,
    })
    await submitAttempt(attemptId)
    await gradeAttempt(attemptId)
    const grading = await pool.query<{ id: string }>(
      `INSERT INTO elearning_grading_records
         (org_id, attempt_id, kind, score, max_score, details, grader_id)
       VALUES ($1, $2, 'auto', 8, 10, '{}'::jsonb, $3)
       RETURNING id`,
      [org, attemptId, actor('grader')],
    )
    const gradingId = grading.rows[0].id

    const revUpdate = await reject(() =>
      pool.query(
        `UPDATE elearning_question_revisions SET prompt = 'changed' WHERE org_id = $1 AND id = $2`,
        [org, graph.revisionId],
      ),
    )
    expect(revUpdate).toBeTruthy()
    expect(String(revUpdate?.message)).toMatch(/append-only/)

    const revDelete = await reject(() =>
      pool.query(
        `DELETE FROM elearning_question_revisions WHERE org_id = $1 AND id = $2`,
        [org, graph.revisionId],
      ),
    )
    expect(revDelete).toBeTruthy()
    expect(String(revDelete?.message)).toMatch(/append-only/)

    const stillRev = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM elearning_question_revisions WHERE org_id = $1 AND id = $2`,
      [org, graph.revisionId],
    )
    expect(stillRev.rows[0].n).toBe(1)

    const gradeUpdate = await reject(() =>
      pool.query(
        `UPDATE elearning_grading_records SET score = 9 WHERE org_id = $1 AND id = $2`,
        [org, gradingId],
      ),
    )
    expect(gradeUpdate).toBeTruthy()
    expect(String(gradeUpdate?.message)).toMatch(/append-only/)

    const gradeDelete = await reject(() =>
      pool.query(
        `DELETE FROM elearning_grading_records WHERE org_id = $1 AND id = $2`,
        [org, gradingId],
      ),
    )
    expect(gradeDelete).toBeTruthy()
    expect(String(gradeDelete?.message)).toMatch(/append-only/)

    const stillGrade = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM elearning_grading_records WHERE org_id = $1 AND id = $2`,
      [org, gradingId],
    )
    expect(stillGrade.rows[0].n).toBe(1)
  })

  it('enforces attempt uniqueness and accepts a legal scored attempt', async () => {
    const org = orgId('att')
    seededOrgIds.push(org)
    const graph = await seedGraph(org)
    const userId = actor('learner')

    const started = await insertAttempt({
      org,
      examId: graph.examId,
      versionId: graph.versionId,
      userId,
      attemptNo: 1,
      status: 'started',
    })
    expect(started).toBeTruthy()

    const dup = await reject(() =>
      insertAttempt({
        org,
        examId: graph.examId,
        versionId: graph.versionId,
        userId,
        attemptNo: 1,
        status: 'started',
      }),
    )
    expect(dup?.code).toBe('23505')
    expect(dup?.constraint).toBe('elearning_exam_attempts_attempt_uniq')

    const scoredId = await insertAttempt({
      org,
      examId: graph.examId,
      versionId: graph.versionId,
      userId,
      attemptNo: 2,
    })
    await submitAttempt(scoredId)
    await gradeAttempt(scoredId)
    await pool.query(
      `INSERT INTO elearning_grading_records
         (org_id, attempt_id, kind, score, max_score, details, grader_id)
       VALUES ($1, $2, 'auto', 8, 10, '{"method":"auto"}'::jsonb, $3)`,
      [org, scoredId, actor('grader')],
    )
    const row = await pool.query<{ auto_score: string; total_score: string; passed: boolean }>(
      `SELECT auto_score::text, total_score::text, passed
         FROM elearning_exam_attempts WHERE id = $1`,
      [scoredId],
    )
    expect(row.rows[0].auto_score).toBe('8')
    expect(row.rows[0].total_score).toBe('10')
    expect(row.rows[0].passed).toBe(true)
  })

  it('rejects active_version_id on a draft and accepts it after publish; latest may stay on draft', async () => {
    const org = orgId('active-ptr')
    seededOrgIds.push(org)
    const graph = await seedGraph(org)

    const activeDraft = await reject(() => setActiveVersion(org, graph.courseId, graph.versionId))
    expect(String(activeDraft?.message)).toMatch(/active_version_id must reference a published course version/)

    const publishDraftExam = await reject(() => publishVersion(org, graph.versionId))
    expect(String(publishDraftExam?.message)).toMatch(/exam items require exam status published/)

    await publishExam(org, graph.examId)
    await publishVersion(org, graph.versionId)
    await setActiveVersion(org, graph.courseId, graph.versionId)

    const draftId = randomUUID()
    await insertVersion(org, draftId, graph.courseId, 2, 'draft')
    await pool.query(
      `UPDATE elearning_courses SET latest_version_id = $1 WHERE org_id = $2 AND id = $3`,
      [draftId, org, graph.courseId],
    )
    const pointers = await pool.query<{ active_version_id: string; latest_version_id: string }>(
      `SELECT active_version_id, latest_version_id FROM elearning_courses WHERE org_id = $1 AND id = $2`,
      [org, graph.courseId],
    )
    expect(pointers.rows[0].active_version_id).toBe(graph.versionId)
    expect(pointers.rows[0].latest_version_id).toBe(draftId)
  })

  it('freezes published version/item/exam/question rows and refuses illegal status rollbacks', async () => {
    const org = orgId('freeze')
    seededOrgIds.push(org)
    const graph = await seedGraph(org)
    await publishExam(org, graph.examId)
    await publishVersion(org, graph.versionId)
    await setActiveVersion(org, graph.courseId, graph.versionId)

    const versionTitle = await reject(() =>
      pool.query(
        `UPDATE elearning_course_versions SET title = 'mutated' WHERE org_id = $1 AND id = $2`,
        [org, graph.versionId],
      ),
    )
    expect(String(versionTitle?.message)).toMatch(/status published are immutable/)

    const itemInsert = await reject(() =>
      insertItem({ org, versionId: graph.versionId, itemType: 'video', position: 9, mediaId: graph.mediaId }),
    )
    expect(String(itemInsert?.message)).toMatch(/parent course version is draft/)

    const itemUpdate = await reject(() =>
      pool.query(
        `UPDATE elearning_course_version_items SET position = 8
          WHERE org_id = $1 AND course_version_id = $2 AND position = 1`,
        [org, graph.versionId],
      ),
    )
    expect(String(itemUpdate?.message)).toMatch(/parent course version is draft/)

    const itemDelete = await reject(() =>
      pool.query(
        `DELETE FROM elearning_course_version_items
          WHERE org_id = $1 AND course_version_id = $2 AND position = 1`,
        [org, graph.versionId],
      ),
    )
    expect(String(itemDelete?.message)).toMatch(/parent course version is draft/)

    const examTitle = await reject(() =>
      pool.query(`UPDATE elearning_exams SET title = 'mutated' WHERE org_id = $1 AND id = $2`, [org, graph.examId]),
    )
    expect(String(examTitle?.message)).toMatch(/status published are immutable/)

    const examQuestionInsert = await reject(() =>
      insertExamQuestion(org, graph.examId, graph.revisionId, 9),
    )
    expect(String(examQuestionInsert?.message)).toMatch(/parent exam is draft/)

    const examQuestionUpdate = await reject(() =>
      pool.query(
        `UPDATE elearning_exam_questions SET points = 99 WHERE org_id = $1 AND exam_id = $2 AND position = 1`,
        [org, graph.examId],
      ),
    )
    expect(String(examQuestionUpdate?.message)).toMatch(/parent exam is draft/)

    const examQuestionDelete = await reject(() =>
      pool.query(
        `DELETE FROM elearning_exam_questions WHERE org_id = $1 AND exam_id = $2 AND position = 1`,
        [org, graph.examId],
      ),
    )
    expect(String(examQuestionDelete?.message)).toMatch(/parent exam is draft/)

    const versionRollback = await reject(() =>
      pool.query(
        `UPDATE elearning_course_versions SET status = 'draft' WHERE org_id = $1 AND id = $2`,
        [org, graph.versionId],
      ),
    )
    expect(String(versionRollback?.message)).toMatch(/illegal status transition/)

    const examRollback = await reject(() =>
      pool.query(
        `UPDATE elearning_exams SET status = 'draft' WHERE org_id = $1 AND id = $2`,
        [org, graph.examId],
      ),
    )
    expect(String(examRollback?.message)).toMatch(/illegal status transition/)

    const extraDraft = randomUUID()
    await insertVersion(org, extraDraft, graph.courseId, 2)
    const draftSkip = await reject(() =>
      pool.query(
        `UPDATE elearning_course_versions SET status = 'retired' WHERE org_id = $1 AND id = $2`,
        [org, extraDraft],
      ),
    )
    expect(String(draftSkip?.message)).toMatch(/illegal status transition/)

    const retireWhileActive = await reject(() =>
      pool.query(
        `UPDATE elearning_course_versions SET status = 'retired' WHERE org_id = $1 AND id = $2`,
        [org, graph.versionId],
      ),
    )
    expect(String(retireWhileActive?.message)).toMatch(/cannot retire course version while it is the course active_version_id/)

    await setActiveVersion(org, graph.courseId, null)
    await pool.query(
      `UPDATE elearning_course_versions SET status = 'retired' WHERE org_id = $1 AND id = $2`,
      [org, graph.versionId],
    )
    const retiredBack = await reject(() =>
      pool.query(
        `UPDATE elearning_course_versions SET status = 'published' WHERE org_id = $1 AND id = $2`,
        [org, graph.versionId],
      ),
    )
    expect(String(retiredBack?.message)).toMatch(/illegal status transition/)

    const reactivateRetired = await reject(() => setActiveVersion(org, graph.courseId, graph.versionId))
    expect(String(reactivateRetired?.message)).toMatch(/active_version_id must reference a published course version/)
  })

  it('refuses to publish a version whose video media is not ready', async () => {
    const org = orgId('media-not-ready')
    seededOrgIds.push(org)
    const graph = await seedGraph(org)
    await pool.query(
      `UPDATE elearning_media SET status = 'probing' WHERE org_id = $1 AND id = $2`,
      [org, graph.mediaId],
    )
    await publishExam(org, graph.examId)

    const err = await reject(() => publishVersion(org, graph.versionId))
    expect(String(err?.message)).toMatch(/video items require media status ready/)

    const stillDraft = await pool.query<{ status: string }>(
      `SELECT status FROM elearning_course_versions WHERE org_id = $1 AND id = $2`,
      [org, graph.versionId],
    )
    expect(stillDraft.rows[0].status).toBe('draft')
  })

  it('refuses to insert a version or exam already published, and blocks cross-parent moves', async () => {
    const org = orgId('insert-state')
    seededOrgIds.push(org)
    const graph = await seedGraph(org)
    const otherVersion = randomUUID()
    await insertVersion(org, otherVersion, graph.courseId, 2)

    const publishedInsert = await reject(() =>
      insertVersion(org, randomUUID(), graph.courseId, 3, 'published'),
    )
    expect(String(publishedInsert?.message)).toMatch(/must be inserted as draft/)

    const publishedExamInsert = await reject(() => insertExam(org, randomUUID(), 'published'))
    expect(String(publishedExamInsert?.message)).toMatch(/must be inserted as draft/)

    const moveItem = await reject(() =>
      pool.query(
        `UPDATE elearning_course_version_items
            SET course_version_id = $1
          WHERE org_id = $2 AND course_version_id = $3 AND position = 1`,
        [otherVersion, org, graph.versionId],
      ),
    )
    expect(String(moveItem?.message)).toMatch(/cannot move across parents/)

    const otherExam = randomUUID()
    await insertExam(org, otherExam)
    const moveQuestion = await reject(() =>
      pool.query(
        `UPDATE elearning_exam_questions SET exam_id = $1 WHERE org_id = $2 AND exam_id = $3 AND position = 1`,
        [otherExam, org, graph.examId],
      ),
    )
    expect(String(moveQuestion?.message)).toMatch(/cannot move across parents/)
  })

  it('freezes attempt identity and paper_snapshot, rejects graded mutation, and unique-blocks duplicate auto grades', async () => {
    const org = orgId('attempt-imm')
    seededOrgIds.push(org)
    const graph = await seedGraph(org)
    const userId = actor('learner')

    const startedId = await insertAttempt({
      org,
      examId: graph.examId,
      versionId: graph.versionId,
      userId,
      attemptNo: 1,
      status: 'started',
    })

    const snapshotErr = await reject(() =>
      pool.query(
        `UPDATE elearning_exam_attempts SET paper_snapshot = '{"n":1}'::jsonb WHERE id = $1`,
        [startedId],
      ),
    )
    expect(String(snapshotErr?.message)).toMatch(/identity fields are immutable after insert/)

    const identityErr = await reject(() =>
      pool.query(
        `UPDATE elearning_exam_attempts SET attempt_no = 9 WHERE id = $1`,
        [startedId],
      ),
    )
    expect(String(identityErr?.message)).toMatch(/identity fields are immutable after insert/)

    await pool.query(
      `UPDATE elearning_exam_attempts SET answers = '{"a":"b"}'::jsonb WHERE id = $1`,
      [startedId],
    )

    const skipToGraded = await reject(() =>
      pool.query(
        `UPDATE elearning_exam_attempts
            SET status = 'graded', auto_score = 8, total_score = 10, passed = true,
                submitted_at = now(), graded_at = now()
          WHERE id = $1`,
        [startedId],
      ),
    )
    expect(String(skipToGraded?.message)).toMatch(/illegal status transition/)

    await pool.query(
      `UPDATE elearning_exam_attempts SET status = 'submitted', submitted_at = now() WHERE id = $1`,
      [startedId],
    )
    await pool.query(
      `UPDATE elearning_exam_attempts
          SET status = 'graded', auto_score = 8, total_score = 10, passed = true, graded_at = now()
        WHERE id = $1`,
      [startedId],
    )

    const gradedUpdate = await reject(() =>
      pool.query(`UPDATE elearning_exam_attempts SET total_score = 1 WHERE id = $1`, [startedId]),
    )
    expect(String(gradedUpdate?.message)).toMatch(/graded rows cannot be updated/)

    const gradedDelete = await reject(() =>
      pool.query(`DELETE FROM elearning_exam_attempts WHERE id = $1`, [startedId]),
    )
    expect(String(gradedDelete?.message)).toMatch(/graded rows cannot be deleted/)

    await pool.query(
      `INSERT INTO elearning_grading_records
         (org_id, attempt_id, kind, score, max_score, details, grader_id)
       VALUES ($1, $2, 'auto', 8, 10, '{}'::jsonb, $3)`,
      [org, startedId, actor('grader')],
    )
    const dupAuto = await reject(() =>
      pool.query(
        `INSERT INTO elearning_grading_records
           (org_id, attempt_id, kind, score, max_score, details, grader_id)
         VALUES ($1, $2, 'auto', 1, 10, '{}'::jsonb, $3)`,
        [org, startedId, actor('grader')],
      ),
    )
    expect(dupAuto?.code).toBe('23505')
    expect(dupAuto?.constraint).toBe(GRADING_RECORD_ATTEMPT_KIND_UNIQ)

    const kept = await pool.query<{ score: string; n: number }>(
      `SELECT score::text, count(*)::int AS n
         FROM elearning_grading_records
        WHERE org_id = $1 AND attempt_id = $2
        GROUP BY score`,
      [org, startedId],
    )
    expect(kept.rows).toHaveLength(1)
    expect(kept.rows[0].score).toBe('8')
    expect(kept.rows[0].n).toBe(1)
  })

  it('direct INSERT of submitted/graded attempts is refused; only started may be inserted', async () => {
    const org = orgId('attempt-insert')
    seededOrgIds.push(org)
    const graph = await seedGraph(org)

    const submittedInsert = await reject(() =>
      insertAttempt({
        org,
        examId: graph.examId,
        versionId: graph.versionId,
        userId: actor('insert-submitted'),
        attemptNo: 1,
        status: 'submitted',
        answers: { choice: 'a' },
        submittedAt: new Date().toISOString(),
      }),
    )
    expect(String(submittedInsert?.message)).toMatch(/must be inserted as started/)

    const gradedInsert = await reject(() =>
      insertAttempt({
        org,
        examId: graph.examId,
        versionId: graph.versionId,
        userId: actor('insert-graded'),
        attemptNo: 1,
        status: 'graded',
        autoScore: 8,
        totalScore: 10,
        passed: true,
      }),
    )
    expect(String(gradedInsert?.message)).toMatch(/must be inserted as started/)

    const remaining = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM elearning_exam_attempts WHERE org_id = $1`,
      [org],
    )
    expect(remaining.rows[0].n).toBe(0)
  })

  it('freezes answers/submitted_at after submit or expire and allows started→submitted|expired→graded', async () => {
    const org = orgId('attempt-lifecycle')
    seededOrgIds.push(org)
    const graph = await seedGraph(org)

    const submittedId = await insertAttempt({
      org,
      examId: graph.examId,
      versionId: graph.versionId,
      userId: actor('submit-path'),
      attemptNo: 1,
    })
    await submitAttempt(submittedId, { choice: 'final-submit' })
    const submittedMutate = await reject(() =>
      pool.query(
        `UPDATE elearning_exam_attempts SET answers = '{"choice":"tamper"}'::jsonb WHERE id = $1`,
        [submittedId],
      ),
    )
    expect(String(submittedMutate?.message)).toMatch(/answers and submitted_at are immutable after submit\/expire/)
    const submittedAtMutate = await reject(() =>
      pool.query(
        `UPDATE elearning_exam_attempts SET submitted_at = now() + interval '1 hour' WHERE id = $1`,
        [submittedId],
      ),
    )
    expect(String(submittedAtMutate?.message)).toMatch(/answers and submitted_at are immutable after submit\/expire/)
    await gradeAttempt(submittedId)
    const submittedRow = await pool.query<{ status: string; answers: { choice: string } }>(
      `SELECT status, answers FROM elearning_exam_attempts WHERE id = $1`,
      [submittedId],
    )
    expect(submittedRow.rows[0].status).toBe('graded')
    expect(submittedRow.rows[0].answers.choice).toBe('final-submit')

    const expiredId = await insertAttempt({
      org,
      examId: graph.examId,
      versionId: graph.versionId,
      userId: actor('expire-path'),
      attemptNo: 1,
    })
    await expireAttempt(expiredId, { choice: 'final-expire' })
    const expiredMutate = await reject(() =>
      pool.query(
        `UPDATE elearning_exam_attempts SET answers = '{"choice":"tamper"}'::jsonb WHERE id = $1`,
        [expiredId],
      ),
    )
    expect(String(expiredMutate?.message)).toMatch(/answers and submitted_at are immutable after submit\/expire/)
    await gradeAttempt(expiredId, 0, 10, false)
    const expiredRow = await pool.query<{ status: string; passed: boolean; answers: { choice: string } }>(
      `SELECT status, passed, answers FROM elearning_exam_attempts WHERE id = $1`,
      [expiredId],
    )
    expect(expiredRow.rows[0].status).toBe('graded')
    expect(expiredRow.rows[0].passed).toBe(false)
    expect(expiredRow.rows[0].answers.choice).toBe('final-expire')
  })

  it('refuses empty exam publish and course versions missing video or exam items', async () => {
    const org = orgId('publish-closed-loop')
    seededOrgIds.push(org)
    const emptyExamId = randomUUID()
    await insertExam(org, emptyExamId)
    const emptyExam = await reject(() => publishExam(org, emptyExamId))
    expect(String(emptyExam?.message)).toMatch(/at least one exam question is required/)

    const courseId = randomUUID()
    const missingVideoId = randomUUID()
    const missingExamId = randomUUID()
    const examId = randomUUID()
    const questionId = randomUUID()
    const revisionId = randomUUID()
    const mediaId = randomUUID()
    await insertCourse(org, courseId)
    await insertVersion(org, missingVideoId, courseId, 1)
    await insertVersion(org, missingExamId, courseId, 2)
    await insertQuestion(org, questionId)
    await insertRevision(org, revisionId, questionId)
    await insertExam(org, examId)
    await insertExamQuestion(org, examId, revisionId)
    await publishExam(org, examId)
    await insertMedia(org, mediaId, 'ready')
    await insertItem({
      org,
      versionId: missingVideoId,
      itemType: 'exam',
      position: 1,
      examId,
    })
    await insertItem({
      org,
      versionId: missingExamId,
      itemType: 'video',
      position: 1,
      mediaId,
    })

    const missingVideo = await reject(() => publishVersion(org, missingVideoId))
    expect(String(missingVideo?.message)).toMatch(/at least one video item is required/)
    const missingExam = await reject(() => publishVersion(org, missingExamId))
    expect(String(missingExam?.message)).toMatch(/at least one exam item is required/)
  })

  it('locks draft audit fields on course_version and exam while allowing business edits', async () => {
    const org = orgId('draft-audit')
    seededOrgIds.push(org)
    const graph = await seedGraph(org)

    const versionNumber = await reject(() =>
      pool.query(
        `UPDATE elearning_course_versions SET version = 9 WHERE org_id = $1 AND id = $2`,
        [org, graph.versionId],
      ),
    )
    expect(String(versionNumber?.message)).toMatch(/audit fields are immutable/)
    const versionAuthor = await reject(() =>
      pool.query(
        `UPDATE elearning_course_versions SET created_by = 'other' WHERE org_id = $1 AND id = $2`,
        [org, graph.versionId],
      ),
    )
    expect(String(versionAuthor?.message)).toMatch(/audit fields are immutable/)
    const versionCreatedAt = await reject(() =>
      pool.query(
        `UPDATE elearning_course_versions SET created_at = now() - interval '1 day' WHERE org_id = $1 AND id = $2`,
        [org, graph.versionId],
      ),
    )
    expect(String(versionCreatedAt?.message)).toMatch(/audit fields are immutable/)
    await pool.query(
      `UPDATE elearning_course_versions SET title = 'Draft title', updated_at = now() WHERE org_id = $1 AND id = $2`,
      [org, graph.versionId],
    )

    const examAuthor = await reject(() =>
      pool.query(
        `UPDATE elearning_exams SET created_by = 'other' WHERE org_id = $1 AND id = $2`,
        [org, graph.examId],
      ),
    )
    expect(String(examAuthor?.message)).toMatch(/audit fields are immutable/)
    const examCreatedAt = await reject(() =>
      pool.query(
        `UPDATE elearning_exams SET created_at = now() - interval '1 day' WHERE org_id = $1 AND id = $2`,
        [org, graph.examId],
      ),
    )
    expect(String(examCreatedAt?.message)).toMatch(/audit fields are immutable/)
    await pool.query(
      `UPDATE elearning_exams SET title = 'Draft exam', pass_score = 70, updated_at = now() WHERE org_id = $1 AND id = $2`,
      [org, graph.examId],
    )

    const versionRow = await pool.query<{ title: string; version: number }>(
      `SELECT title, version FROM elearning_course_versions WHERE org_id = $1 AND id = $2`,
      [org, graph.versionId],
    )
    expect(versionRow.rows[0].title).toBe('Draft title')
    expect(versionRow.rows[0].version).toBe(1)
    const examRow = await pool.query<{ title: string; pass_score: string }>(
      `SELECT title, pass_score::text FROM elearning_exams WHERE org_id = $1 AND id = $2`,
      [org, graph.examId],
    )
    expect(examRow.rows[0].title).toBe('Draft exam')
    expect(examRow.rows[0].pass_score).toBe('70')
  })

  it('serializes publish vs child insert so a published parent cannot gain a new item', async () => {
    const org = orgId('race-item')
    seededOrgIds.push(org)
    const graph = await seedGraph(org)
    await publishExam(org, graph.examId)

    const outcome = await reject(() =>
      runLockBarrier({
        hold: async (holder) => {
          await holder.query(
            `UPDATE elearning_course_versions
                SET status = 'published', updated_at = now()
              WHERE org_id = $1 AND id = $2`,
            [org, graph.versionId],
          )
        },
        wait: (waiter) =>
          waiter.query(
            `INSERT INTO elearning_course_version_items
               (org_id, course_version_id, item_type, position, media_id, exam_id)
             VALUES ($1, $2, 'video', 9, $3, NULL)`,
            [org, graph.versionId, graph.mediaId],
          ),
      }),
    )
    expect(String(outcome?.message)).toMatch(/parent course version is draft/)

    const items = await pool.query<{ n: number; status: string }>(
      `SELECT
          (SELECT count(*)::int FROM elearning_course_version_items WHERE org_id = $1 AND course_version_id = $2) AS n,
          (SELECT status FROM elearning_course_versions WHERE org_id = $1 AND id = $2) AS status`,
      [org, graph.versionId],
    )
    expect(items.rows[0].n).toBe(2)
    expect(items.rows[0].status).toBe('published')
  })

  it('serializes exam publish vs exam_question insert so a published exam cannot gain a question', async () => {
    const org = orgId('race-question')
    seededOrgIds.push(org)
    const graph = await seedGraph(org)

    const outcome = await reject(() =>
      runLockBarrier({
        hold: async (holder) => {
          await holder.query(
            `UPDATE elearning_exams
                SET status = 'published', updated_at = now()
              WHERE org_id = $1 AND id = $2`,
            [org, graph.examId],
          )
        },
        wait: (waiter) =>
          waiter.query(
            `INSERT INTO elearning_exam_questions
               (org_id, exam_id, question_revision_id, position, points)
             VALUES ($1, $2, $3, 9, 10)`,
            [org, graph.examId, graph.revisionId],
          ),
      }),
    )
    expect(String(outcome?.message)).toMatch(/parent exam is draft/)

    const questions = await pool.query<{ n: number; status: string }>(
      `SELECT
          (SELECT count(*)::int FROM elearning_exam_questions WHERE org_id = $1 AND exam_id = $2) AS n,
          (SELECT status FROM elearning_exams WHERE org_id = $1 AND id = $2) AS status`,
      [org, graph.examId],
    )
    expect(questions.rows[0].n).toBe(1)
    expect(questions.rows[0].status).toBe('published')
  })

  it('serializes retire vs set-active so an active pointer cannot land on a retired version', async () => {
    const org = orgId('race-retire')
    seededOrgIds.push(org)
    const graph = await seedGraph(org)
    await publishExam(org, graph.examId)
    await publishVersion(org, graph.versionId)

    const setActiveWhileRetire = await reject(() =>
      runLockBarrier({
        hold: async (holder) => {
          await holder.query(
            `UPDATE elearning_course_versions
                SET status = 'retired', updated_at = now()
              WHERE org_id = $1 AND id = $2`,
            [org, graph.versionId],
          )
        },
        wait: (waiter) =>
          waiter.query(
            `UPDATE elearning_courses SET active_version_id = $1 WHERE org_id = $2 AND id = $3`,
            [graph.versionId, org, graph.courseId],
          ),
      }),
    )
    expect(String(setActiveWhileRetire?.message)).toMatch(
      /active_version_id must reference a published course version/,
    )

    const afterRetire = await pool.query<{
      version_status: string
      active_version_id: string | null
    }>(
      `SELECT
          (SELECT status FROM elearning_course_versions WHERE org_id = $1 AND id = $2) AS version_status,
          (SELECT active_version_id FROM elearning_courses WHERE org_id = $1 AND id = $3) AS active_version_id`,
      [org, graph.versionId, graph.courseId],
    )
    expect(afterRetire.rows[0].version_status).toBe('retired')
    expect(afterRetire.rows[0].active_version_id).toBeNull()

    const graph2Org = orgId('race-active')
    seededOrgIds.push(graph2Org)
    const graph2 = await seedGraph(graph2Org)
    await publishExam(graph2Org, graph2.examId)
    await publishVersion(graph2Org, graph2.versionId)

    const retireWhileSetActive = await reject(() =>
      runLockBarrier({
        hold: async (holder) => {
          await holder.query(
            `UPDATE elearning_courses SET active_version_id = $1 WHERE org_id = $2 AND id = $3`,
            [graph2.versionId, graph2Org, graph2.courseId],
          )
        },
        wait: (waiter) =>
          waiter.query(
            `UPDATE elearning_course_versions
                SET status = 'retired', updated_at = now()
              WHERE org_id = $1 AND id = $2`,
            [graph2Org, graph2.versionId],
          ),
      }),
    )
    expect(String(retireWhileSetActive?.message)).toMatch(
      /cannot retire course version while it is the course active_version_id/,
    )

    const afterActive = await pool.query<{
      version_status: string
      active_version_id: string | null
    }>(
      `SELECT
          (SELECT status FROM elearning_course_versions WHERE org_id = $1 AND id = $2) AS version_status,
          (SELECT active_version_id FROM elearning_courses WHERE org_id = $1 AND id = $3) AS active_version_id`,
      [graph2Org, graph2.versionId, graph2.courseId],
    )
    expect(afterActive.rows[0].version_status).toBe('published')
    expect(afterActive.rows[0].active_version_id).toBe(graph2.versionId)
  })

  it('linearizes set-active over an in-flight retire that already holds the version row (no course→version deadlock)', async () => {
    const org = orgId('race-deadlock')
    seededOrgIds.push(org)
    const graph = await seedGraph(org)
    await publishExam(org, graph.examId)
    await publishVersion(org, graph.versionId)

    let setActiveOk = false
    const retireOutcome = await settled(
      runLockBarrier({
        hold: async (holder) => {
          await holder.query(
            `UPDATE elearning_courses SET updated_at = now() WHERE org_id = $1 AND id = $2`,
            [org, graph.courseId],
          )
        },
        wait: async (waiter) => {
          await waiter.query('BEGIN')
          return waiter.query(
            `UPDATE elearning_course_versions
                SET status = 'retired', updated_at = now()
              WHERE org_id = $1 AND id = $2`,
            [org, graph.versionId],
          )
        },
        afterBlocked: async (holder) => {
          await holder.query(
            `UPDATE elearning_courses SET active_version_id = $1 WHERE org_id = $2 AND id = $3`,
            [graph.versionId, org, graph.courseId],
          )
          setActiveOk = true
        },
      }),
    )
    const retireError = retireOutcome as PgError
    expect(setActiveOk).toBe(true)
    expect(retireError?.code).not.toBe('40P01')
    expect(retireError?.code).not.toBe('55P03')
    expect(String(retireError?.message)).not.toMatch(/deadlock detected|lock timeout/i)
    expect(String(retireError?.message)).toMatch(
      /cannot retire course version while it is the course active_version_id/,
    )

    const after = await pool.query<{
      version_status: string
      active_version_id: string | null
    }>(
      `SELECT
          (SELECT status FROM elearning_course_versions WHERE org_id = $1 AND id = $2) AS version_status,
          (SELECT active_version_id FROM elearning_courses WHERE org_id = $1 AND id = $3) AS active_version_id`,
      [org, graph.versionId, graph.courseId],
    )
    expect(after.rows[0].version_status).toBe('published')
    expect(after.rows[0].active_version_id).toBe(graph.versionId)
  })

  it('seeds the five elearning permissions and grants them to admin', async () => {
    const perms = await pool.query<{ code: string }>(
      `SELECT code FROM permissions WHERE code = ANY($1::text[]) ORDER BY code`,
      [ELEARNING_PERMISSION_CODES],
    )
    expect(perms.rows.map((row) => row.code)).toEqual([...ELEARNING_PERMISSION_CODES].sort())

    const grants = await pool.query<{ permission_code: string }>(
      `SELECT permission_code
         FROM role_permissions
        WHERE role_id = 'admin'
          AND permission_code = ANY($1::text[])
        ORDER BY permission_code`,
      [ELEARNING_PERMISSION_CODES],
    )
    expect(grants.rows.map((row) => row.permission_code)).toEqual([...ELEARNING_PERMISSION_CODES].sort())
  })
})
