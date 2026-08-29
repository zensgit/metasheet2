/**
 * E-learning V0.1 watch-progress schema gate (real PostgreSQL).
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
import { Pool } from 'pg'
import {
  COURSE_VERSION_ITEMS_DRAFT_TRIGGER,
  ELEARNING_V01_IMMUTABILITY_TRIGGERS,
} from '../../src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment'
import {
  ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS,
  ELEARNING_V01_WATCH_TABLES,
  LEARNING_SESSIONS_ONE_ACTIVE_INDEX,
} from '../../src/db/migrations/zzzz20260825120000_create_elearning_v01_watch_progress'
import {
  ASSIGNMENTS_DENY_DELETE_TRIGGER,
  ASSIGNMENTS_IDENTITY_TRIGGER,
  ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS,
  PROGRESS_EVENTS_DENY_UPDATE_TRIGGER,
} from '../../src/db/migrations/zzzz20260826120000_harden_elearning_v01_ledger'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'elearning V0.1 watch-progress schema gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
const STAMP = Date.now().toString(36)
const NS = `el-watch-${STAMP}`

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

const ALL_IMMUTABILITY_TRIGGERS = [
  ...ELEARNING_V01_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_WATCH_IMMUTABILITY_TRIGGERS,
  ...ELEARNING_V01_LEDGER_CLEANUP_TRIGGERS,
]

async function setImmutabilityTriggers(enabled: boolean): Promise<void> {
  const verb = enabled ? 'ENABLE' : 'DISABLE'
  for (const { table, name } of ALL_IMMUTABILITY_TRIGGERS) {
    await pool.query(`ALTER TABLE ${table} ${verb} TRIGGER ${name}`)
  }
}

async function cleanupOrg(org: string): Promise<void> {
  await setImmutabilityTriggers(false)
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
    await setImmutabilityTriggers(true)
  }
}

async function insertCourse(org: string, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES ($1, $2, 'Watch course', 'active', $3)`,
    [id, org, actor('author')],
  )
}

async function insertVersion(org: string, id: string, courseId: string, version = 1): Promise<void> {
  await pool.query(
    `INSERT INTO elearning_course_versions
       (id, org_id, course_id, version, status, title, created_by)
     VALUES ($1, $2, $3, $4, 'draft', $5, $6)`,
    [id, org, courseId, version, `Version ${version}`, actor('author')],
  )
}

async function insertMedia(org: string, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO elearning_media (
       id, org_id, storage_key, mime_type, magic_mime_type,
       size_bytes, sha256, duration_ms, status, created_by
     ) VALUES ($1, $2, $3, 'video/mp4', 'video/mp4', 1024, $4, 60000, 'ready', $5)`,
    [id, org, `${NS}/media/${id}`, 'a'.repeat(64), actor('uploader')],
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

async function insertExam(org: string, id: string): Promise<void> {
  await pool.query(
    `INSERT INTO elearning_exams (id, org_id, title, status, pass_score, max_attempts, created_by)
     VALUES ($1, $2, 'Watch exam', 'draft', 10, 3, $3)`,
    [id, org, actor('author')],
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

async function retireVersion(org: string, versionId: string): Promise<void> {
  await pool.query(
    `UPDATE elearning_course_versions
        SET status = 'retired', updated_at = now()
      WHERE org_id = $1 AND id = $2`,
    [org, versionId],
  )
}

async function insertVideoItem(
  org: string,
  versionId: string,
  mediaId: string,
  position: number,
  id = randomUUID(),
  policyVersion: string | null = 'video-v1-90pct',
  threshold: number | null = 9000,
): Promise<string> {
  await pool.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position, media_id, exam_id,
       completion_policy_version, completion_threshold_bps
     ) VALUES ($1, $2, $3, 'video', $4, $5, NULL, $6, $7)`,
    [id, org, versionId, position, mediaId, policyVersion, threshold],
  )
  return id
}

async function insertExamItem(
  org: string,
  versionId: string,
  examId: string,
  position: number,
  id = randomUUID(),
): Promise<string> {
  await pool.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position, media_id, exam_id,
       completion_policy_version, completion_threshold_bps
     ) VALUES ($1, $2, $3, 'exam', $4, NULL, $5, NULL, NULL)`,
    [id, org, versionId, position, examId],
  )
  return id
}

async function insertAssignment(input: {
  org: string
  versionId: string
  sourceKey: string
  id?: string
  deadline?: string | null
}): Promise<string> {
  const id = input.id ?? randomUUID()
  await pool.query(
    `INSERT INTO elearning_assignments (
       id, org_id, course_version_id, source_key, request_hash, request_hash_version,
       deadline, assigned_by
     ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
    [
      id,
      input.org,
      input.versionId,
      input.sourceKey,
      `hash-${id}`,
      input.deadline === undefined ? null : input.deadline,
      actor('assigner'),
    ],
  )
  return id
}

async function insertMember(input: {
  org: string
  assignmentId: string
  versionId: string
  userId: string
  id?: string
  source?: string
}): Promise<string> {
  const id = input.id ?? randomUUID()
  await pool.query(
    `INSERT INTO elearning_assignment_members (
       id, org_id, assignment_id, course_version_id, user_id, source
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, input.org, input.assignmentId, input.versionId, input.userId, input.source ?? 'manual'],
  )
  return id
}

async function insertSession(input: {
  org: string
  memberId: string
  versionId: string
  itemId: string
  userId: string
  status?: string
  closedAt?: string | null
  id?: string
}): Promise<string> {
  const id = input.id ?? randomUUID()
  const status = input.status ?? 'active'
  const closedAt = input.closedAt === undefined
    ? (status === 'active' ? null : new Date().toISOString())
    : input.closedAt
  await pool.query(
    `INSERT INTO elearning_learning_sessions (
       id, org_id, assignment_member_id, course_version_id, course_version_item_id,
       user_id, status, last_sequence, last_client_position_ms, effective_ms,
       max_position_ms, rolling_event_digest, closed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, 0, 0, 'digest', $8)`,
    [id, input.org, input.memberId, input.versionId, input.itemId, input.userId, status, closedAt],
  )
  return id
}

async function insertEvent(input: {
  org: string
  sessionId: string
  versionId: string
  itemId: string
  userId: string
  sequence: number
  kind?: string
}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO elearning_progress_events (
       org_id, session_id, course_version_id, course_version_item_id, user_id,
       sequence, kind, reported_position_ms, playing, credited_ms, event_digest
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, true, 0, 'evt')
     RETURNING id`,
    [
      input.org,
      input.sessionId,
      input.versionId,
      input.itemId,
      input.userId,
      input.sequence,
      input.kind ?? 'start',
    ],
  )
  return result.rows[0].id
}

async function insertProgress(input: {
  org: string
  memberId: string
  versionId: string
  itemId: string
  userId: string
  status?: string
  completedAt?: string | null
  required?: boolean
}): Promise<string> {
  const status = input.status ?? 'in_progress'
  const completedAt = input.completedAt === undefined
    ? (status === 'completed' ? new Date().toISOString() : null)
    : input.completedAt
  const result = await pool.query<{ id: string }>(
    `INSERT INTO elearning_progress (
       org_id, assignment_member_id, course_version_id, course_version_item_id,
       user_id, status, effective_ms, max_position_ms, completed_at, required_at_completion
     ) VALUES ($1, $2, $3, $4, $5, $6, 0, 0, $7, $8)
     RETURNING id`,
    [
      input.org,
      input.memberId,
      input.versionId,
      input.itemId,
      input.userId,
      status,
      completedAt,
      input.required ?? true,
    ],
  )
  return result.rows[0].id
}

async function insertEvidence(input: {
  org: string
  memberId: string
  versionId: string
  itemId: string
  userId: string
  id?: string
}): Promise<string> {
  const id = input.id ?? randomUUID()
  await pool.query(
    `INSERT INTO elearning_completion_evidence (
       id, org_id, assignment_member_id, course_version_id, course_version_item_id,
       user_id, completion_policy_version, completion_threshold_bps, media_duration_ms,
       effective_ms, max_position_ms, event_digest, evaluator_version, completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'video-v1-90pct', 9000, 60000, 54000, 60000, 'ev', 'eval-v1', now())`,
    [id, input.org, input.memberId, input.versionId, input.itemId, input.userId],
  )
  return id
}

async function seedContent(org: string): Promise<{
  courseId: string
  versionId: string
  otherVersionId: string
  mediaId: string
  examId: string
  videoItemId: string
  examItemId: string
  otherVideoItemId: string
}> {
  const courseId = randomUUID()
  const versionId = randomUUID()
  const otherVersionId = randomUUID()
  const mediaId = randomUUID()
  const examId = randomUUID()
  const questionId = randomUUID()
  const revisionId = randomUUID()
  await insertCourse(org, courseId)
  await insertVersion(org, versionId, courseId, 1)
  await insertVersion(org, otherVersionId, courseId, 2)
  await insertMedia(org, mediaId)
  await insertQuestion(org, questionId)
  await insertRevision(org, revisionId, questionId)
  await insertExam(org, examId)
  await insertExamQuestion(org, examId, revisionId)
  const videoItemId = await insertVideoItem(org, versionId, mediaId, 1)
  const examItemId = await insertExamItem(org, versionId, examId, 2)
  const otherVideoItemId = await insertVideoItem(org, otherVersionId, mediaId, 1)
  await publishExam(org, examId)
  await publishVersion(org, versionId)
  return {
    courseId,
    versionId,
    otherVersionId,
    mediaId,
    examId,
    videoItemId,
    examItemId,
    otherVideoItemId,
  }
}

describe('elearning V0.1 watch-progress schema gate (real DB)', () => {
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
        [ALL_IMMUTABILITY_TRIGGERS.map((row) => row.name)],
      )
      expect(result.rows).toHaveLength(ALL_IMMUTABILITY_TRIGGERS.length)
      expect(result.rows.every((row) => row.tgenabled === 'O')).toBe(true)
    } finally {
      await pool.end()
    }
  })

  it('refuses to run without DATABASE_URL (sentinel)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('records the watch-progress migration as already applied', async () => {
    const result = await pool.query<{ name: string }>(
      `SELECT name FROM kysely_migration WHERE name = $1`,
      ['zzzz20260825120000_create_elearning_v01_watch_progress'],
    )
    expect(result.rows.map((row) => row.name)).toEqual([
      'zzzz20260825120000_create_elearning_v01_watch_progress',
    ])
  })

  it('creates the six watch tables with org_id TEXT NOT NULL and no default', async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])
        ORDER BY table_name`,
      [ELEARNING_V01_WATCH_TABLES],
    )
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual(
      [...ELEARNING_V01_WATCH_TABLES].sort(),
    )

    const columns = await pool.query<{
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
      [ELEARNING_V01_WATCH_TABLES],
    )
    expect(columns.rows).toHaveLength(ELEARNING_V01_WATCH_TABLES.length)
    for (const row of columns.rows) {
      expect(row.data_type).toBe('text')
      expect(row.is_nullable).toBe('NO')
      expect(row.column_default).toBeNull()
    }

    const scopeCol = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'elearning_completion_evidence'
          AND column_name = 'scope_revision_rule_id'`,
    )
    expect(scopeCol.rows).toEqual([{ is_nullable: 'YES' }])
  })

  it('pins video/exam completion-policy shape and the item composite parent key', async () => {
    const org = orgId('item-shape')
    seededOrgIds.push(org)
    const content = await seedContent(org)

    const parentKey = await pool.query<{ ncols: number }>(
      `SELECT array_length(conkey, 1) AS ncols
         FROM pg_constraint
        WHERE conrelid = 'elearning_course_version_items'::regclass
          AND conname = 'elearning_course_version_items_org_version_id_uniq'`,
    )
    expect(parentKey.rows).toHaveLength(1)
    expect(parentKey.rows[0].ncols).toBe(3)

    const missingPolicy = await reject(() =>
      insertVideoItem(org, content.otherVersionId, content.mediaId, 9, randomUUID(), null, null),
    )
    expect(missingPolicy?.code).toBe('23514')
    expect(missingPolicy?.constraint).toBe('elearning_course_version_items_completion_policy_chk')

    const examPolicy = await reject(() =>
      pool.query(
        `INSERT INTO elearning_course_version_items (
           org_id, course_version_id, item_type, position, media_id, exam_id,
           completion_policy_version, completion_threshold_bps
         ) VALUES ($1, $2, 'exam', 10, NULL, $3, 'video-v1-90pct', 9000)`,
        [org, content.otherVersionId, content.examId],
      ),
    )
    expect(examPolicy?.code).toBe('23514')
    expect(examPolicy?.constraint).toBe('elearning_course_version_items_completion_policy_chk')
  })

  it('pins same-org same-version same-user assignment/member/item chains and rejects mismatches with 23503', async () => {
    const orgA = orgId('chain-a')
    const orgB = orgId('chain-b')
    seededOrgIds.push(orgA, orgB)
    const a = await seedContent(orgA)
    const b = await seedContent(orgB)
    const userA = actor('learner-a')
    const userB = actor('learner-b')

    const assignmentA = await insertAssignment({
      org: orgA,
      versionId: a.versionId,
      sourceKey: `${orgA}-src-a`,
    })
    const memberA = await insertMember({
      org: orgA,
      assignmentId: assignmentA,
      versionId: a.versionId,
      userId: userA,
    })

    const crossOrgAssignment = await reject(() =>
      insertAssignment({
        org: orgB,
        versionId: a.versionId,
        sourceKey: `${orgB}-src-cross`,
      }),
    )
    expect(crossOrgAssignment?.code).toBe('23503')
    expect(crossOrgAssignment?.constraint).toBe('elearning_assignments_version_fk')

    const wrongVersionMember = await reject(() =>
      insertMember({
        org: orgA,
        assignmentId: assignmentA,
        versionId: a.otherVersionId,
        userId: userB,
      }),
    )
    expect(wrongVersionMember?.code).toBe('23503')
    expect(wrongVersionMember?.constraint).toBe('elearning_assignment_members_assignment_version_fk')

    const crossOrgMember = await reject(() =>
      insertMember({
        org: orgB,
        assignmentId: assignmentA,
        versionId: a.versionId,
        userId: userB,
      }),
    )
    expect(crossOrgMember?.code).toBe('23503')
    expect(crossOrgMember?.constraint).toBe('elearning_assignment_members_assignment_version_fk')

    const wrongUserSession = await reject(() =>
      insertSession({
        org: orgA,
        memberId: memberA,
        versionId: a.versionId,
        itemId: a.videoItemId,
        userId: userB,
      }),
    )
    expect(wrongUserSession?.code).toBe('23503')
    expect(wrongUserSession?.constraint).toBe('elearning_learning_sessions_member_identity_fk')

    const wrongVersionSession = await reject(() =>
      insertSession({
        org: orgA,
        memberId: memberA,
        versionId: a.otherVersionId,
        itemId: a.otherVideoItemId,
        userId: userA,
      }),
    )
    expect(wrongVersionSession?.code).toBe('23503')
    expect(wrongVersionSession?.constraint).toBe('elearning_learning_sessions_member_identity_fk')

    const wrongItemVersion = await reject(() =>
      insertSession({
        org: orgA,
        memberId: memberA,
        versionId: a.versionId,
        itemId: a.otherVideoItemId,
        userId: userA,
      }),
    )
    expect(wrongItemVersion?.code).toBe('23503')
    expect(wrongItemVersion?.constraint).toBe('elearning_learning_sessions_item_version_fk')

    const sessionId = await insertSession({
      org: orgA,
      memberId: memberA,
      versionId: a.versionId,
      itemId: a.videoItemId,
      userId: userA,
    })
    expect(sessionId).toBeTruthy()

    const wrongUserProgress = await reject(() =>
      insertProgress({
        org: orgA,
        memberId: memberA,
        versionId: a.versionId,
        itemId: a.videoItemId,
        userId: userB,
      }),
    )
    expect(wrongUserProgress?.code).toBe('23503')
    expect(wrongUserProgress?.constraint).toBe('elearning_progress_member_identity_fk')

    const crossOrgEvidence = await reject(() =>
      insertEvidence({
        org: orgB,
        memberId: memberA,
        versionId: a.versionId,
        itemId: a.videoItemId,
        userId: userA,
      }),
    )
    expect(crossOrgEvidence?.code).toBe('23503')
    expect(crossOrgEvidence?.constraint).toBe('elearning_completion_evidence_member_identity_fk')
  })

  it('accepts assignment only on a published version; draft and retired new assignments fail; existing assignment survives retirement', async () => {
    const org = orgId('assign-status')
    seededOrgIds.push(org)
    const content = await seedContent(org)

    const draftErr = await reject(() =>
      insertAssignment({
        org,
        versionId: content.otherVersionId,
        sourceKey: `${org}-src-draft`,
      }),
    )
    expect(String(draftErr?.message)).toMatch(
      /course_version_id must reference a published course version/,
    )

    const assignmentId = await insertAssignment({
      org,
      versionId: content.versionId,
      sourceKey: `${org}-src-published`,
    })
    expect(assignmentId).toBeTruthy()

    await retireVersion(org, content.versionId)

    const stillThere = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM elearning_assignments WHERE org_id = $1 AND id = $2`,
      [org, assignmentId],
    )
    expect(stillThere.rows[0].n).toBe(1)

    const retiredErr = await reject(() =>
      insertAssignment({
        org,
        versionId: content.versionId,
        sourceKey: `${org}-src-retired`,
      }),
    )
    expect(String(retiredErr?.message)).toMatch(
      /course_version_id must reference a published course version/,
    )

    await pool.query(
      `UPDATE elearning_assignments SET deadline = now() WHERE org_id = $1 AND id = $2`,
      [org, assignmentId],
    )
    const afterUpdate = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM elearning_assignments WHERE org_id = $1 AND id = $2`,
      [org, assignmentId],
    )
    expect(afterUpdate.rows[0].n).toBe(1)
  })

  it('refuses member delete, identity change, and revoke rollback; allows one complete revoke; deadline expiry does not revoke', async () => {
    const org = orgId('member-pit')
    seededOrgIds.push(org)
    const content = await seedContent(org)
    const userId = actor('learner')
    const assignmentId = await insertAssignment({
      org,
      versionId: content.versionId,
      sourceKey: `${org}-src`,
      deadline: new Date(Date.now() - 60_000).toISOString(),
    })
    const memberId = await insertMember({
      org,
      assignmentId,
      versionId: content.versionId,
      userId,
    })

    const preRevoked = await reject(() =>
      pool.query(
        `INSERT INTO elearning_assignment_members (
           org_id, assignment_id, course_version_id, user_id, source,
           revoked_at, revoked_by, revocation_reason
         ) VALUES ($1, $2, $3, $4, 'manual', now(), $5, 'already revoked')`,
        [org, assignmentId, content.versionId, actor('pre-revoked'), actor('revoker')],
      ),
    )
    expect(String(preRevoked?.message)).toMatch(/cannot be inserted already revoked/)

    const deleteErr = await reject(() =>
      pool.query(`DELETE FROM elearning_assignment_members WHERE org_id = $1 AND id = $2`, [org, memberId]),
    )
    expect(String(deleteErr?.message)).toMatch(/point-in-time fact: DELETE is not permitted/)

    const identityErr = await reject(() =>
      pool.query(
        `UPDATE elearning_assignment_members SET user_id = $1 WHERE org_id = $2 AND id = $3`,
        [actor('other'), org, memberId],
      ),
    )
    expect(String(identityErr?.message)).toMatch(/identity\/source\/assigned_at are immutable/)

    const sourceErr = await reject(() =>
      pool.query(
        `UPDATE elearning_assignment_members SET source = 'import' WHERE org_id = $1 AND id = $2`,
        [org, memberId],
      ),
    )
    expect(String(sourceErr?.message)).toMatch(/identity\/source\/assigned_at are immutable/)

    const incompleteRevoke = await reject(() =>
      pool.query(
        `UPDATE elearning_assignment_members
            SET revoked_at = now(), revoked_by = $1, revocation_reason = NULL
          WHERE org_id = $2 AND id = $3`,
        [actor('revoker'), org, memberId],
      ),
    )
    expect(incompleteRevoke?.code).toBe('23514')
    expect(incompleteRevoke?.constraint).toBe('elearning_assignment_members_revoke_triplet_chk')

    await pool.query(
      `UPDATE elearning_assignment_members
          SET revoked_at = now(), revoked_by = $1, revocation_reason = 'pilot revoke'
        WHERE org_id = $2 AND id = $3`,
      [actor('revoker'), org, memberId],
    )
    const revoked = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM elearning_assignment_members WHERE org_id = $1 AND id = $2`,
      [org, memberId],
    )
    expect(revoked.rows[0].revoked_at).not.toBeNull()

    const undoErr = await reject(() =>
      pool.query(
        `UPDATE elearning_assignment_members
            SET revoked_at = NULL, revoked_by = NULL, revocation_reason = NULL
          WHERE org_id = $1 AND id = $2`,
        [org, memberId],
      ),
    )
    expect(String(undoErr?.message)).toMatch(/revoke fields cannot be changed after revoke/)

    const secondErr = await reject(() =>
      pool.query(
        `UPDATE elearning_assignment_members
            SET revocation_reason = 'changed'
          WHERE org_id = $1 AND id = $2`,
        [org, memberId],
      ),
    )
    expect(String(secondErr?.message)).toMatch(/revoke fields cannot be changed after revoke/)

    const stillRevoked = await pool.query<{
      revoked_at: Date | null
      revocation_reason: string | null
    }>(
      `SELECT revoked_at, revocation_reason
         FROM elearning_assignment_members WHERE org_id = $1 AND id = $2`,
      [org, memberId],
    )
    expect(stillRevoked.rows[0].revoked_at).not.toBeNull()
    expect(stillRevoked.rows[0].revocation_reason).toBe('pilot revoke')

    const openOrg = orgId('deadline-open')
    seededOrgIds.push(openOrg)
    const openContent = await seedContent(openOrg)
    const openAssignment = await insertAssignment({
      org: openOrg,
      versionId: openContent.versionId,
      sourceKey: `${openOrg}-src`,
      deadline: new Date(Date.now() - 86_400_000).toISOString(),
    })
    const openMember = await insertMember({
      org: openOrg,
      assignmentId: openAssignment,
      versionId: openContent.versionId,
      userId: actor('open-learner'),
    })
    const openRow = await pool.query<{ revoked_at: Date | null; deadline: Date | null }>(
      `SELECT m.revoked_at, a.deadline
         FROM elearning_assignment_members m
         JOIN elearning_assignments a
           ON a.org_id = m.org_id AND a.id = m.assignment_id
        WHERE m.org_id = $1 AND m.id = $2`,
      [openOrg, openMember],
    )
    expect(openRow.rows[0].deadline).not.toBeNull()
    expect(openRow.rows[0].deadline!.getTime()).toBeLessThan(Date.now())
    expect(openRow.rows[0].revoked_at).toBeNull()
  })

  it('enforces one active session per user×item via the partial unique index', async () => {
    const org = orgId('session-uniq')
    seededOrgIds.push(org)
    const content = await seedContent(org)
    const userId = actor('learner')
    const assignmentId = await insertAssignment({
      org,
      versionId: content.versionId,
      sourceKey: `${org}-src`,
    })
    const memberId = await insertMember({
      org,
      assignmentId,
      versionId: content.versionId,
      userId,
    })

    await insertSession({
      org,
      memberId,
      versionId: content.versionId,
      itemId: content.videoItemId,
      userId,
      status: 'active',
    })
    const dup = await reject(() =>
      insertSession({
        org,
        memberId,
        versionId: content.versionId,
        itemId: content.videoItemId,
        userId,
        status: 'active',
      }),
    )
    expect(dup?.code).toBe('23505')
    expect(dup?.constraint).toBe(LEARNING_SESSIONS_ONE_ACTIVE_INDEX)

    await insertSession({
      org,
      memberId,
      versionId: content.versionId,
      itemId: content.videoItemId,
      userId,
      status: 'closed',
    })
    await insertSession({
      org,
      memberId,
      versionId: content.versionId,
      itemId: content.examItemId,
      userId,
      status: 'active',
    })
  })

  it('enforces event sequence uniqueness and start|heartbeat enum (no completed kind)', async () => {
    const org = orgId('events')
    seededOrgIds.push(org)
    const content = await seedContent(org)
    const userId = actor('learner')
    const assignmentId = await insertAssignment({
      org,
      versionId: content.versionId,
      sourceKey: `${org}-src`,
    })
    const memberId = await insertMember({
      org,
      assignmentId,
      versionId: content.versionId,
      userId,
    })
    const sessionId = await insertSession({
      org,
      memberId,
      versionId: content.versionId,
      itemId: content.videoItemId,
      userId,
    })

    await insertEvent({
      org,
      sessionId,
      versionId: content.versionId,
      itemId: content.videoItemId,
      userId,
      sequence: 0,
      kind: 'start',
    })
    await insertEvent({
      org,
      sessionId,
      versionId: content.versionId,
      itemId: content.videoItemId,
      userId,
      sequence: 1,
      kind: 'heartbeat',
    })

    const dupSeq = await reject(() =>
      insertEvent({
        org,
        sessionId,
        versionId: content.versionId,
        itemId: content.videoItemId,
        userId,
        sequence: 1,
        kind: 'heartbeat',
      }),
    )
    expect(dupSeq?.code).toBe('23505')
    expect(dupSeq?.constraint).toBe('elearning_progress_events_org_session_sequence_uniq')

    const completedKind = await reject(() =>
      insertEvent({
        org,
        sessionId,
        versionId: content.versionId,
        itemId: content.videoItemId,
        userId,
        sequence: 2,
        kind: 'completed',
      }),
    )
    expect(completedKind?.code).toBe('23514')
    expect(completedKind?.constraint).toBe('elearning_progress_events_kind_chk')

    const wrongUserEvent = await reject(() =>
      insertEvent({
        org,
        sessionId,
        versionId: content.versionId,
        itemId: content.videoItemId,
        userId: actor('other-learner'),
        sequence: 9,
      }),
    )
    expect(wrongUserEvent?.code).toBe('23503')
    expect(wrongUserEvent?.constraint).toBe('elearning_progress_events_session_identity_fk')

    const wrongVersionEvent = await reject(() =>
      insertEvent({
        org,
        sessionId,
        versionId: content.otherVersionId,
        itemId: content.otherVideoItemId,
        userId,
        sequence: 10,
      }),
    )
    expect(wrongVersionEvent?.code).toBe('23503')
    expect(wrongVersionEvent?.constraint).toBe('elearning_progress_events_session_identity_fk')

    const wrongItemEvent = await reject(() =>
      insertEvent({
        org,
        sessionId,
        versionId: content.versionId,
        itemId: content.examItemId,
        userId,
        sequence: 11,
      }),
    )
    expect(wrongItemEvent?.code).toBe('23503')
    expect(wrongItemEvent?.constraint).toBe('elearning_progress_events_session_identity_fk')
  })

  it('requires progress completed iff completed_at and required_at_completion true', async () => {
    const org = orgId('progress')
    seededOrgIds.push(org)
    const content = await seedContent(org)
    const userId = actor('learner')
    const assignmentId = await insertAssignment({
      org,
      versionId: content.versionId,
      sourceKey: `${org}-src`,
    })
    const memberId = await insertMember({
      org,
      assignmentId,
      versionId: content.versionId,
      userId,
    })

    await insertProgress({
      org,
      memberId,
      versionId: content.versionId,
      itemId: content.videoItemId,
      userId,
      status: 'in_progress',
    })

    const completedNoTs = await reject(() =>
      insertProgress({
        org,
        memberId,
        versionId: content.versionId,
        itemId: content.examItemId,
        userId,
        status: 'completed',
        completedAt: null,
      }),
    )
    expect(completedNoTs?.code).toBe('23514')
    expect(completedNoTs?.constraint).toBe('elearning_progress_completed_iff_chk')

    const inProgressWithTs = await reject(() =>
      pool.query(
        `INSERT INTO elearning_progress (
           org_id, assignment_member_id, course_version_id, course_version_item_id,
           user_id, status, effective_ms, max_position_ms, completed_at, required_at_completion
         ) VALUES ($1, $2, $3, $4, $5, 'in_progress', 0, 0, now(), true)`,
        [org, memberId, content.versionId, content.examItemId, userId],
      ),
    )
    expect(inProgressWithTs?.code).toBe('23514')
    expect(inProgressWithTs?.constraint).toBe('elearning_progress_completed_iff_chk')

    const notRequired = await reject(() =>
      insertProgress({
        org,
        memberId,
        versionId: content.versionId,
        itemId: content.examItemId,
        userId,
        status: 'completed',
        required: false,
      }),
    )
    expect(notRequired?.code).toBe('23514')
    expect(notRequired?.constraint).toBe('elearning_progress_required_access_basis_chk')

    await insertProgress({
      org,
      memberId,
      versionId: content.versionId,
      itemId: content.examItemId,
      userId,
      status: 'completed',
    })
  })

  it('restricts evidence to the member/user/version chain, RESTRICT-blocks parent deletes, and is append-only', async () => {
    const org = orgId('evidence')
    seededOrgIds.push(org)
    const content = await seedContent(org)
    const userId = actor('learner')
    const otherUser = actor('other')
    const assignmentId = await insertAssignment({
      org,
      versionId: content.versionId,
      sourceKey: `${org}-src`,
    })
    const memberId = await insertMember({
      org,
      assignmentId,
      versionId: content.versionId,
      userId,
    })
    await insertMember({
      org,
      assignmentId,
      versionId: content.versionId,
      userId: otherUser,
    })

    const wrongUser = await reject(() =>
      insertEvidence({
        org,
        memberId,
        versionId: content.versionId,
        itemId: content.videoItemId,
        userId: otherUser,
      }),
    )
    expect(wrongUser?.code).toBe('23503')
    expect(wrongUser?.constraint).toBe('elearning_completion_evidence_member_identity_fk')

    const wrongVersion = await reject(() =>
      insertEvidence({
        org,
        memberId,
        versionId: content.otherVersionId,
        itemId: content.otherVideoItemId,
        userId,
      }),
    )
    expect(wrongVersion?.code).toBe('23503')
    expect(wrongVersion?.constraint).toBe('elearning_completion_evidence_member_identity_fk')

    const evidenceId = await insertEvidence({
      org,
      memberId,
      versionId: content.versionId,
      itemId: content.videoItemId,
      userId,
    })

    const updateErr = await reject(() =>
      pool.query(
        `UPDATE elearning_completion_evidence SET effective_ms = 1 WHERE org_id = $1 AND id = $2`,
        [org, evidenceId],
      ),
    )
    expect(String(updateErr?.message)).toMatch(/append-only/)

    const deleteErr = await reject(() =>
      pool.query(
        `DELETE FROM elearning_completion_evidence WHERE org_id = $1 AND id = $2`,
        [org, evidenceId],
      ),
    )
    expect(String(deleteErr?.message)).toMatch(/append-only/)

    const stillThere = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM elearning_completion_evidence WHERE org_id = $1 AND id = $2`,
      [org, evidenceId],
    )
    expect(stillThere.rows[0].n).toBe(1)

    const deleteMember = await reject(() =>
      pool.query(`DELETE FROM elearning_assignment_members WHERE org_id = $1 AND id = $2`, [org, memberId]),
    )
    expect(String(deleteMember?.message)).toMatch(/point-in-time fact: DELETE is not permitted/)

    const frozenItem = await reject(() =>
      pool.query(
        `DELETE FROM elearning_course_version_items WHERE org_id = $1 AND id = $2`,
        [org, content.videoItemId],
      ),
    )
    expect(String(frozenItem?.message)).toMatch(
      /can only be mutated when the parent course version is draft/,
    )

    await pool.query(
      `ALTER TABLE elearning_course_version_items DISABLE TRIGGER ${COURSE_VERSION_ITEMS_DRAFT_TRIGGER}`,
    )
    try {
      const deleteItem = await reject(() =>
        pool.query(
          `DELETE FROM elearning_course_version_items WHERE org_id = $1 AND id = $2`,
          [org, content.videoItemId],
        ),
      )
      expect(deleteItem?.code).toBe('23503')
      expect(deleteItem?.constraint).toBe('elearning_completion_evidence_item_version_fk')
    } finally {
      await pool.query(
        `ALTER TABLE elearning_course_version_items ENABLE TRIGGER ${COURSE_VERSION_ITEMS_DRAFT_TRIGGER}`,
      )
    }

    await pool.query(
      `ALTER TABLE elearning_assignments DISABLE TRIGGER ${ASSIGNMENTS_DENY_DELETE_TRIGGER}`,
    )
    try {
      const deleteAssignment = await reject(() =>
        pool.query(`DELETE FROM elearning_assignments WHERE org_id = $1 AND id = $2`, [org, assignmentId]),
      )
      expect(deleteAssignment?.code).toBe('23503')
      expect(deleteAssignment?.constraint).toBe('elearning_assignment_members_assignment_version_fk')
    } finally {
      await pool.query(
        `ALTER TABLE elearning_assignments ENABLE TRIGGER ${ASSIGNMENTS_DENY_DELETE_TRIGGER}`,
      )
    }
  })

  it('freezes assignment identity, rejects assignment DELETE and progress-event UPDATE, and allows retention DELETE', async () => {
    const org = orgId('ledger-append')
    seededOrgIds.push(org)
    const content = await seedContent(org)
    const userId = actor('learner')
    const assignmentId = await insertAssignment({
      org,
      versionId: content.versionId,
      sourceKey: `${org}-src-append`,
    })
    const memberId = await insertMember({
      org,
      assignmentId,
      versionId: content.versionId,
      userId,
    })
    const sessionId = await insertSession({
      org,
      memberId,
      versionId: content.versionId,
      itemId: content.videoItemId,
      userId,
    })
    const eventId = await insertEvent({
      org,
      sessionId,
      versionId: content.versionId,
      itemId: content.videoItemId,
      userId,
      sequence: 0,
    })

    const assignIdentity = await reject(() =>
      pool.query(
        `UPDATE elearning_assignments SET request_hash = 'tamper' WHERE org_id = $1 AND id = $2`,
        [org, assignmentId],
      ),
    )
    expect(String(assignIdentity?.message)).toMatch(/identity fields are immutable/)
    expect(ASSIGNMENTS_IDENTITY_TRIGGER).toBe('trg_elearning_assignments_identity_guard')
    const assignDelete = await reject(() =>
      pool.query(`DELETE FROM elearning_assignments WHERE org_id = $1 AND id = $2`, [org, assignmentId]),
    )
    expect(String(assignDelete?.message)).toMatch(/assignments DELETE is not permitted/)

    const eventUpdate = await reject(() =>
      pool.query(
        `UPDATE elearning_progress_events SET credited_ms = 1 WHERE org_id = $1 AND id = $2`,
        [org, eventId],
      ),
    )
    expect(String(eventUpdate?.message)).toMatch(/append-only: UPDATE is not permitted/)
    expect(PROGRESS_EVENTS_DENY_UPDATE_TRIGGER).toBe('trg_elearning_progress_events_deny_update')
    await pool.query(
      `DELETE FROM elearning_progress_events WHERE org_id = $1 AND id = $2`,
      [org, eventId],
    )
    const retained = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM elearning_progress_events WHERE org_id = $1 AND id = $2`,
      [org, eventId],
    )
    expect(retained.rows[0].n).toBe(0)
  })
})
