import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  down as enrollmentDown,
  up as enrollmentUp,
} from '../../src/db/migrations/zzzz20260901120000_create_elearning_course_enrollments'
import {
  ElearningCourseEnrollmentError,
  enrollElearningCourse,
  type ElearningCourseEnrollmentDb,
  type ElearningCourseEnrollmentQueryable,
} from '../../src/services/elearning-course-enrollment'
import {
  ElearningCourseAccessError,
  resolveElearningCourseAccess,
} from '../../src/services/elearning-course-access'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error('course enrollment DB gate requires DATABASE_URL; refusing skip-shaped green')
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 8 })
const kysely = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
const NS = `el-enroll-${randomUUID().slice(0, 8)}`
const trackedOrgs = new Set<string>()

function valuesFreeCode(error: unknown, code: string): boolean {
  expect(error).toBeInstanceOf(ElearningCourseEnrollmentError)
  const actual = error as ElearningCourseEnrollmentError
  expect(actual.code).toBe(code)
  expect(actual.message).toBe(code)
  expect(JSON.stringify(actual)).not.toContain(NS)
  return true
}

async function queryTarget(
  target: Pool | PoolClient,
  text: string,
  params?: unknown[],
): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> {
  const result = await target.query(text, params as never)
  return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
}

function database(target: Pool = pool): ElearningCourseEnrollmentDb {
  return {
    async transaction<T>(handler: (tx: ElearningCourseEnrollmentQueryable) => Promise<T>): Promise<T> {
      const client = await target.connect()
      try {
        await client.query('BEGIN')
        const result = await handler({ query: (text, params) => queryTarget(client, text, params) })
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

interface Seed {
  orgId: string
  userId: string
  courseId: string
  versionId: string
  scopeId: string
  revisionId: string
  ruleId: string
}

async function ensureUser(orgId: string, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO users (
       id, email, name, password_hash, role, permissions,
       is_active, is_admin, activation_status, local_password_set,
       must_change_password, created_at, updated_at
     ) VALUES (
       $1, $2, $3, 'x', 'user', '[]'::jsonb,
       TRUE, FALSE, 'activated', TRUE, FALSE, now(), now()
     ) ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
    [userId, `${userId}@enrollment.test`, userId],
  )
  await pool.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active)
     VALUES ($1, $2, TRUE)
     ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
    [userId, orgId],
  )
}

async function seed(suffix: string): Promise<Seed> {
  const orgId = `${NS}-${suffix}`
  const userId = `${NS}-user-${suffix}`
  const courseId = randomUUID()
  const versionId = randomUUID()
  const articleRevisionId = randomUUID()
  const scopeId = randomUUID()
  const revisionId = randomUUID()
  const ruleId = randomUUID()
  trackedOrgs.add(orgId)
  await ensureUser(orgId, userId)
  await pool.query(
    `INSERT INTO elearning_scopes (id, org_id, created_by)
     VALUES ($1, $2, $3)`,
    [scopeId, orgId, userId],
  )
  await pool.query(
    `INSERT INTO elearning_scope_revisions
       (id, org_id, scope_id, revision, actor_id, reason)
     VALUES ($1, $2, $3, 1, $4, 'initial visibility')`,
    [revisionId, orgId, scopeId, userId],
  )
  await pool.query(
    `INSERT INTO elearning_scope_revision_rules
       (id, org_id, scope_revision_id, subject_type, subject_ref, include_children)
     VALUES ($1, $2, $3, 'all', NULL, FALSE)`,
    [ruleId, orgId, revisionId],
  )
  await pool.query(
    `UPDATE elearning_scopes
        SET active_revision_id = $3, latest_revision_id = $3
      WHERE org_id = $1 AND id = $2`,
    [orgId, scopeId, revisionId],
  )
  await pool.query(
    `INSERT INTO elearning_courses
       (id, org_id, title, status, created_by, scope_id)
     VALUES ($1, $2, 'Visible self-study', 'active', $3, $4)`,
    [courseId, orgId, userId, scopeId],
  )
  await pool.query(
    `INSERT INTO elearning_course_versions
       (id, org_id, course_id, version, status, title, created_by)
     VALUES ($1, $2, $3, 1, 'draft', 'Visible self-study v1', $4)`,
    [versionId, orgId, courseId, userId],
  )
  await pool.query(
    `INSERT INTO elearning_content_revisions (
       id, org_id, item_type, title, article_html, external_url,
       content_digest, created_by
     ) VALUES ($1, $2, 'article', 'Enrollment article', '<p>Enrollment article</p>', NULL, $3, $4)`,
    [articleRevisionId, orgId, 'c'.repeat(64), userId],
  )
  await pool.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position,
       article_revision_id, completion_policy_version
     ) VALUES ($1, $2, $3, 'article', 1, $4, 'article-open-v1')`,
    [randomUUID(), orgId, versionId, articleRevisionId],
  )
  await pool.query(
    `UPDATE elearning_course_versions SET status = 'published'
      WHERE org_id = $1 AND id = $2`,
    [orgId, versionId],
  )
  await pool.query(
    `UPDATE elearning_courses
        SET active_version_id = $3, latest_version_id = $3
      WHERE org_id = $1 AND id = $2`,
    [orgId, courseId, versionId],
  )
  return { orgId, userId, courseId, versionId, scopeId, revisionId, ruleId }
}

async function cleanupOrg(orgId: string): Promise<void> {
  for (const table of [
    'elearning_course_enrollments',
    'elearning_assignments',
    'elearning_assignment_members',
    'elearning_course_versions',
    'elearning_course_version_items',
    'elearning_content_revisions',
    'elearning_scope_revision_rules',
    'elearning_scope_revisions',
  ]) await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`)
  try {
    await pool.query('DELETE FROM elearning_course_enrollments WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_assignment_members WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_assignments WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_course_version_items WHERE org_id = $1', [orgId])
    await pool.query(
      `UPDATE elearning_courses SET active_version_id = NULL, latest_version_id = NULL
        WHERE org_id = $1`,
      [orgId],
    )
    await pool.query('DELETE FROM elearning_course_versions WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_courses WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_content_revisions WHERE org_id = $1', [orgId])
    await pool.query(
      `UPDATE elearning_scopes SET active_revision_id = NULL, latest_revision_id = NULL
        WHERE org_id = $1`,
      [orgId],
    )
    await pool.query('DELETE FROM elearning_scope_revision_rules WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_scope_revisions WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM elearning_scopes WHERE org_id = $1', [orgId])
    await pool.query('DELETE FROM user_orgs WHERE org_id = $1 AND user_id LIKE $2', [orgId, `${NS}%`])
    await pool.query(
      `DELETE FROM users user_row
        WHERE user_row.id LIKE $1
          AND NOT EXISTS (SELECT 1 FROM user_orgs membership WHERE membership.user_id = user_row.id)`,
      [`${NS}%`],
    )
  } finally {
    for (const table of [
      'elearning_course_enrollments',
      'elearning_assignments',
      'elearning_assignment_members',
      'elearning_course_versions',
      'elearning_course_version_items',
      'elearning_content_revisions',
      'elearning_scope_revision_rules',
      'elearning_scope_revisions',
    ]) await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`)
  }
}

async function enroll(row: Seed, requestId = randomUUID()) {
  return enrollElearningCourse(database(), {
    orgId: row.orgId,
    userId: row.userId,
    courseId: row.courseId,
    requestId,
  })
}

beforeAll(async () => {
  await kysely.transaction().execute((tx) => enrollmentUp(tx))
  await kysely.transaction().execute((tx) => enrollmentUp(tx))
})

afterEach(async () => {
  for (const orgId of trackedOrgs) await cleanupOrg(orgId)
  trackedOrgs.clear()
})

afterAll(async () => {
  await kysely.destroy()
})

describe('online course enrollment PostgreSQL authority', () => {
  it('stores one visibility snapshot and replays the exact result', async () => {
    const row = await seed('replay')
    const requestId = randomUUID()
    const first = await enroll(row, requestId)
    const replay = await enroll(row, requestId)
    expect(replay).toEqual(first)
    const stored = await pool.query(
      `SELECT course_version_id::text, scope_revision_rule_id::text,
              request_hash, request_hash_version
         FROM elearning_course_enrollments
        WHERE org_id = $1 AND user_id = $2 AND course_id = $3`,
      [row.orgId, row.userId, row.courseId],
    )
    expect(stored.rows).toEqual([{
      course_version_id: row.versionId,
      scope_revision_rule_id: row.ruleId,
      request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      request_hash_version: 1,
    }])
  })

  it('serializes concurrent requests to one immutable course enrollment', async () => {
    const row = await seed('concurrent')
    const [first, second] = await Promise.all([
      enroll(row, randomUUID()),
      enroll(row, randomUUID()),
    ])
    expect(second).toEqual(first)
    const count = await pool.query(
      `SELECT count(*)::integer AS count FROM elearning_course_enrollments
        WHERE org_id = $1 AND user_id = $2 AND course_id = $3`,
      [row.orgId, row.userId, row.courseId],
    )
    expect(count.rows[0]?.count).toBe(1)
  })

  it('preserves exact request replay after scope shrink but grants no current access', async () => {
    const row = await seed('scope-shrink')
    const requestId = randomUUID()
    const first = await enroll(row, requestId)
    const nextRevision = randomUUID()
    await pool.query(
      `INSERT INTO elearning_scope_revisions
         (id, org_id, scope_id, revision, actor_id, reason)
       VALUES ($1, $2, $3, 2, $4, 'scope shrink')`,
      [nextRevision, row.orgId, row.scopeId, row.userId],
    )
    await pool.query(
      `INSERT INTO elearning_scope_revision_rules
         (id, org_id, scope_revision_id, subject_type, subject_ref, include_children)
       VALUES ($1, $2, $3, 'user', $4, FALSE)`,
      [randomUUID(), row.orgId, nextRevision, `${NS}-other-user`],
    )
    await pool.query(
      `UPDATE elearning_scopes
          SET active_revision_id = $3, latest_revision_id = $3
        WHERE org_id = $1 AND id = $2`,
      [row.orgId, row.scopeId, nextRevision],
    )
    await expect(resolveElearningCourseAccess({ query: (text, params) => queryTarget(pool, text, params) }, {
      orgId: row.orgId,
      userId: row.userId,
      courseVersionId: row.versionId,
    })).rejects.toMatchObject<Partial<ElearningCourseAccessError>>({ code: 'denied' })
    await expect(enroll(row, randomUUID())).rejects.toSatisfy(
      (error: unknown) => valuesFreeCode(error, 'not_enrollable'),
    )
    await expect(enroll(row, requestId)).resolves.toEqual(first)
  })

  it('rejects assigned and cross-org courses without writing a second authority', async () => {
    const row = await seed('assigned')
    const assignmentId = randomUUID()
    await pool.query(
      `INSERT INTO elearning_assignments (
         id, org_id, course_version_id, source_key, request_hash,
         request_hash_version, deadline, assigned_by
       ) VALUES ($1, $2, $3, $4, $5, 1, NULL, $6)`,
      [assignmentId, row.orgId, row.versionId, `${NS}-source`, 'a'.repeat(64), row.userId],
    )
    await pool.query(
      `INSERT INTO elearning_assignment_members
         (id, org_id, assignment_id, course_version_id, user_id, source)
       VALUES ($1, $2, $3, $4, $5, 'manual')`,
      [randomUUID(), row.orgId, assignmentId, row.versionId, row.userId],
    )
    await expect(enroll(row)).rejects.toSatisfy(
      (error: unknown) => valuesFreeCode(error, 'already_assigned'),
    )
    await expect(enrollElearningCourse(database(), {
      orgId: `${NS}-foreign`,
      userId: row.userId,
      courseId: row.courseId,
      requestId: randomUUID(),
    })).rejects.toSatisfy((error: unknown) => valuesFreeCode(error, 'not_found'))
    const count = await pool.query(
      'SELECT count(*)::integer AS count FROM elearning_course_enrollments WHERE org_id = $1',
      [row.orgId],
    )
    expect(count.rows[0]?.count).toBe(0)
  })

  it('enforces request hash conflicts and immutable update/delete/truncate', async () => {
    const first = await seed('conflict-a')
    const second = await seed('conflict-b')
    const requestId = randomUUID()
    await enroll(first, requestId)
    await expect(enrollElearningCourse(database(), {
      orgId: first.orgId,
      userId: first.userId,
      courseId: second.courseId,
      requestId,
    })).rejects.toSatisfy((error: unknown) => valuesFreeCode(error, 'conflict'))
    await expect(pool.query(
      'UPDATE elearning_course_enrollments SET enrolled_at = now() WHERE org_id = $1',
      [first.orgId],
    )).rejects.toThrow('is immutable')
    await expect(pool.query(
      'DELETE FROM elearning_course_enrollments WHERE org_id = $1',
      [first.orgId],
    )).rejects.toThrow('is immutable')
    await expect(pool.query('TRUNCATE elearning_course_enrollments')).rejects.toThrow('is immutable')
  })

  it('detects schema drift and refuses populated down while empty down/reapply stays valid', async () => {
    const row = await seed('drift')
    await enroll(row)
    await expect(kysely.transaction().execute((tx) => enrollmentDown(tx))).rejects.toThrow(
      'down refused: authoritative rows exist',
    )
    await cleanupOrg(row.orgId)
    trackedOrgs.delete(row.orgId)

    await pool.query(
      'ALTER TABLE elearning_course_enrollments ALTER COLUMN course_version_id DROP NOT NULL',
    )
    await expect(kysely.transaction().execute((tx) => enrollmentUp(tx))).rejects.toThrow(
      'migration drift: column authority',
    )
    await pool.query(
      'ALTER TABLE elearning_course_enrollments ALTER COLUMN course_version_id SET NOT NULL',
    )
    await kysely.transaction().execute((tx) => enrollmentUp(tx))
    await kysely.transaction().execute((tx) => enrollmentDown(tx))
    await kysely.transaction().execute((tx) => enrollmentUp(tx))
    await kysely.transaction().execute((tx) => enrollmentUp(tx))
  })
})
