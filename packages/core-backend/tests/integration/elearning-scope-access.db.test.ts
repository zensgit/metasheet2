/**
 * L1 scope/access gate against a fully migrated PostgreSQL database.
 * DATABASE_URL is mandatory; missing infrastructure must not produce green.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import {
  resolveElearningCourseAccess,
} from '../../src/services/elearning-course-access'
import {
  setElearningCourseScope,
  type ElearningScopeDb,
  type ElearningScopeQueryable,
} from '../../src/services/elearning-scope'
import {
  ELEARNING_WATCH_POLICY_VERSION,
  ELEARNING_WATCH_THRESHOLD_BPS,
  recordElearningHeartbeat,
  startElearningWatch,
  type ElearningWatchDb,
  type ElearningWatchQueryable,
} from '../../src/services/elearning-watch-progress'
import {
  SCOPE_RULES_NULL_IDENTITY_INDEX,
  SCOPE_RULES_REF_IDENTITY_INDEX,
  down as downScopeAccess,
  up as upScopeAccess,
} from '../../src/db/migrations/zzzz20260826150000_add_elearning_scope_access'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error('elearning scope/access DB gate requires DATABASE_URL; refusing skip-shaped green')
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 })
const NS = `el-scope-${Date.now().toString(36)}`

type Queryable = ElearningScopeQueryable & ElearningWatchQueryable

class TransactionalClientDb implements ElearningScopeDb, ElearningWatchDb {
  private savepoint = 0

  constructor(private readonly client: PoolClient) {}

  async query(sql: string, params?: unknown[]) {
    const result = await this.client.query(sql, params as never)
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount }
  }

  async transaction<T>(handler: (tx: Queryable) => Promise<T>): Promise<T> {
    const name = `elearning_scope_${++this.savepoint}`
    await this.client.query(`SAVEPOINT ${name}`)
    try {
      const value = await handler({ query: (sql, params) => this.query(sql, params) })
      await this.client.query(`RELEASE SAVEPOINT ${name}`)
      return value
    } catch (error) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${name}`)
      await this.client.query(`RELEASE SAVEPOINT ${name}`)
      throw error
    }
  }
}

async function withRolledBackDb(
  run: (client: PoolClient, db: TransactionalClientDb) => Promise<void>,
): Promise<void> {
  const client = await pool.connect()
  await client.query('BEGIN')
  try {
    await run(client, new TransactionalClientDb(client))
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

async function expectSqlState(
  client: PoolClient,
  expected: string,
  action: () => Promise<unknown>,
): Promise<void> {
  const savepoint = `negative_${randomUUID().replaceAll('-', '')}`
  await client.query(`SAVEPOINT ${savepoint}`)
  let caught: unknown
  try {
    await action()
  } catch (error) {
    caught = error
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
  await client.query(`RELEASE SAVEPOINT ${savepoint}`)
  expect(caught).toBeDefined()
  expect((caught as { code?: string }).code).toBe(expected)
}

interface CourseSeed {
  orgId: string
  userId: string
  courseId: string
  versionId: string
  itemId: string
}

function actor(label: string): string {
  return `${NS}-${label}`
}

async function seedActiveMembership(
  client: PoolClient,
  userId: string,
  orgId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO users (
       id, email, name, password_hash, role, permissions,
       is_active, is_admin, activation_status, local_password_set,
       must_change_password, created_at, updated_at
     ) VALUES (
       $1, $2, $3, 'x', 'user', '[]'::jsonb,
       TRUE, FALSE, 'activated', TRUE,
       FALSE, now(), now()
     )`,
    [userId, `${userId}@scope-gate.test`, userId],
  )
  await client.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active)
     VALUES ($1, $2, TRUE)`,
    [userId, orgId],
  )
}

async function seedPublishedVideoCourse(
  client: PoolClient,
  input: { orgId: string; userId?: string; durationMs?: number },
): Promise<CourseSeed> {
  const userId = input.userId ?? actor(`learner-${randomUUID().slice(0, 8)}`)
  const courseId = randomUUID()
  const versionId = randomUUID()
  const mediaId = randomUUID()
  const itemId = randomUUID()
  const examItemId = randomUUID()
  const examId = randomUUID()
  const questionId = randomUUID()
  const questionRevisionId = randomUUID()
  const durationMs = input.durationMs ?? 10_000

  await seedActiveMembership(client, userId, input.orgId)

  await client.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES ($1, $2, 'Scope course', 'active', $3)`,
    [courseId, input.orgId, actor('author')],
  )
  await client.query(
    `INSERT INTO elearning_course_versions
       (id, org_id, course_id, version, status, title, created_by)
     VALUES ($1, $2, $3, 1, 'draft', 'Version 1', $4)`,
    [versionId, input.orgId, courseId, actor('author')],
  )
  await client.query(
    `INSERT INTO elearning_media (
       id, org_id, storage_key, mime_type, magic_mime_type,
       size_bytes, sha256, duration_ms, status, created_by
     ) VALUES ($1, $2, $3, 'video/mp4', 'video/mp4', 1024, $4, $5, 'ready', $6)`,
    [
      mediaId,
      input.orgId,
      `${NS}/${input.orgId}/${mediaId}`,
      randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      durationMs,
      actor('uploader'),
    ],
  )
  await client.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position, media_id,
       completion_policy_version, completion_threshold_bps
     ) VALUES ($1, $2, $3, 'video', 1, $4, $5, $6)`,
    [
      itemId,
      input.orgId,
      versionId,
      mediaId,
      ELEARNING_WATCH_POLICY_VERSION,
      ELEARNING_WATCH_THRESHOLD_BPS,
    ],
  )
  await client.query(
    `INSERT INTO elearning_questions (id, org_id, created_by)
     VALUES ($1, $2, $3)`,
    [questionId, input.orgId, actor('author')],
  )
  await client.query(
    `INSERT INTO elearning_question_revisions (
       id, org_id, question_id, revision, question_type, prompt,
       options, answer_key, points, created_by
     ) VALUES ($1, $2, $3, 1, 'single_choice', 'Pick one', $4::jsonb, $5::jsonb, 10, $6)`,
    [
      questionRevisionId,
      input.orgId,
      questionId,
      JSON.stringify([{ id: 'a', text: 'yes' }]),
      JSON.stringify({ correct: ['a'] }),
      actor('author'),
    ],
  )
  await client.query(
    `INSERT INTO elearning_exams (
       id, org_id, title, status, pass_score, max_attempts, created_by
     ) VALUES ($1, $2, 'Scope exam', 'draft', 10, 3, $3)`,
    [examId, input.orgId, actor('author')],
  )
  await client.query(
    `INSERT INTO elearning_exam_questions (
       org_id, exam_id, question_revision_id, position, points
     ) VALUES ($1, $2, $3, 1, 10)`,
    [input.orgId, examId, questionRevisionId],
  )
  await client.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position, exam_id
     ) VALUES ($1, $2, $3, 'exam', 2, $4)`,
    [examItemId, input.orgId, versionId, examId],
  )
  await client.query(
    `UPDATE elearning_exams
        SET status = 'published', updated_at = clock_timestamp()
      WHERE org_id = $1 AND id = $2`,
    [input.orgId, examId],
  )
  await client.query(
    `UPDATE elearning_course_versions
        SET status = 'published', updated_at = clock_timestamp()
      WHERE org_id = $1 AND id = $2`,
    [input.orgId, versionId],
  )
  await client.query(
    `UPDATE elearning_courses
        SET active_version_id = $1,
            latest_version_id = $1,
            updated_at = clock_timestamp()
      WHERE org_id = $2 AND id = $3`,
    [versionId, input.orgId, courseId],
  )
  return { orgId: input.orgId, userId, courseId, versionId, itemId }
}

async function seedAssignment(client: PoolClient, seed: CourseSeed): Promise<string> {
  const assignmentId = randomUUID()
  const memberId = randomUUID()
  await client.query(
    `INSERT INTO elearning_assignments (
       id, org_id, course_version_id, source_key, request_hash,
       request_hash_version, deadline, assigned_by
     ) VALUES ($1, $2, $3, $4, $5, 1, NULL, $6)`,
    [
      assignmentId,
      seed.orgId,
      seed.versionId,
      `${NS}-${assignmentId}`,
      randomUUID().replaceAll('-', ''),
      actor('assigner'),
    ],
  )
  await client.query(
    `INSERT INTO elearning_assignment_members (
       id, org_id, assignment_id, course_version_id, user_id, source
     ) VALUES ($1, $2, $3, $4, $5, 'manual')`,
    [memberId, seed.orgId, assignmentId, seed.versionId, seed.userId],
  )
  return memberId
}

afterAll(async () => {
  await pool.end()
})

describe('elearning L1 scope/access gate (real DB)', () => {
  it('uses an active scope revision for self-study, then an empty revision blocks continuation with zero writes', async () => {
    await withRolledBackDb(async (client, db) => {
      const seed = await seedPublishedVideoCourse(client, { orgId: actor('org-shrink') })
      const firstScope = await setElearningCourseScope(db, {
        orgId: seed.orgId,
        actorId: actor('scope-admin'),
        courseId: seed.courseId,
        reason: 'initial visibility',
        rules: [{ subjectType: 'all' }],
      })
      expect(firstScope).toEqual(expect.objectContaining({ revision: 1 }))
      expect(firstScope.ruleIds).toHaveLength(1)

      const access = await resolveElearningCourseAccess(db, {
        orgId: seed.orgId,
        userId: seed.userId,
        courseVersionId: seed.versionId,
      })
      expect(access.basis).toEqual({
        kind: 'visibility',
        assignmentMemberId: null,
        scopeRevisionRuleId: firstScope.ruleIds[0],
        required: false,
      })
      const started = await startElearningWatch(db, {
        orgId: seed.orgId,
        userId: seed.userId,
        itemId: seed.itemId,
      })

      const emptyScope = await setElearningCourseScope(db, {
        orgId: seed.orgId,
        actorId: actor('scope-admin'),
        courseId: seed.courseId,
        reason: 'remove visibility',
        rules: [],
      })
      expect(emptyScope).toEqual(expect.objectContaining({
        scopeId: firstScope.scopeId,
        revision: 2,
        ruleIds: [],
      }))
      await expect(resolveElearningCourseAccess(db, {
        orgId: seed.orgId,
        userId: seed.userId,
        courseVersionId: seed.versionId,
      })).rejects.toMatchObject({ code: 'denied' })

      const before = await client.query(
        `SELECT
           (SELECT count(*)::int FROM elearning_progress_events WHERE org_id = $1) AS events,
           s.last_sequence,
           s.effective_ms,
           p.effective_ms AS progress_effective_ms
         FROM elearning_learning_sessions s
         JOIN elearning_progress p
           ON p.org_id = s.org_id
          AND p.user_id = s.user_id
          AND p.course_version_item_id = s.course_version_item_id
         WHERE s.org_id = $1 AND s.id = $2`,
        [seed.orgId, started.sessionId],
      )
      await expect(recordElearningHeartbeat(db, {
        sessionId: started.sessionId!,
        orgId: seed.orgId,
        userId: seed.userId,
        sequence: 1,
        positionMs: 5_000,
        playing: true,
      })).rejects.toMatchObject({ code: 'assignment_unavailable' })
      const after = await client.query(
        `SELECT
           (SELECT count(*)::int FROM elearning_progress_events WHERE org_id = $1) AS events,
           s.last_sequence,
           s.effective_ms,
           p.effective_ms AS progress_effective_ms
         FROM elearning_learning_sessions s
         JOIN elearning_progress p
           ON p.org_id = s.org_id
          AND p.user_id = s.user_id
          AND p.course_version_item_id = s.course_version_item_id
         WHERE s.org_id = $1 AND s.id = $2`,
        [seed.orgId, started.sessionId],
      )
      expect(after.rows).toEqual(before.rows)

      const history = await client.query(
        `SELECT revision, reason
           FROM elearning_scope_revisions
          WHERE org_id = $1 AND scope_id = $2
          ORDER BY revision`,
        [seed.orgId, firstScope.scopeId],
      )
      expect(history.rows).toEqual([
        { revision: 1, reason: 'initial visibility' },
        { revision: 2, reason: 'remove visibility' },
      ])
    })
  })

  it('gives assignment priority and preserves assigned access across archived and retired states', async () => {
    await withRolledBackDb(async (client, db) => {
      const seed = await seedPublishedVideoCourse(client, { orgId: actor('org-priority') })
      await setElearningCourseScope(db, {
        orgId: seed.orgId,
        actorId: actor('scope-admin'),
        courseId: seed.courseId,
        reason: 'learner visibility',
        rules: [{ subjectType: 'user', subjectRef: seed.userId }],
      })
      const visible = await resolveElearningCourseAccess(db, {
        orgId: seed.orgId,
        userId: seed.userId,
        courseVersionId: seed.versionId,
      })
      expect(visible.basis.kind).toBe('visibility')

      const memberId = await seedAssignment(client, seed)
      const assigned = await resolveElearningCourseAccess(db, {
        orgId: seed.orgId,
        userId: seed.userId,
        courseVersionId: seed.versionId,
      })
      expect(assigned.basis).toEqual({
        kind: 'assignment',
        assignmentMemberId: memberId,
        scopeRevisionRuleId: null,
        required: true,
      })

      await client.query(
        `UPDATE elearning_courses SET status = 'archived' WHERE org_id = $1 AND id = $2`,
        [seed.orgId, seed.courseId],
      )
      await expect(resolveElearningCourseAccess(db, {
        orgId: seed.orgId,
        userId: seed.userId,
        courseVersionId: seed.versionId,
      })).resolves.toMatchObject({ basis: { kind: 'assignment' } })
      await expect(resolveElearningCourseAccess(db, {
        orgId: seed.orgId,
        userId: actor('unassigned'),
        courseVersionId: seed.versionId,
      })).rejects.toMatchObject({ code: 'denied' })

      await client.query(
        `UPDATE elearning_courses
            SET status = 'active', active_version_id = NULL
          WHERE org_id = $1 AND id = $2`,
        [seed.orgId, seed.courseId],
      )
      await client.query(
        `UPDATE elearning_course_versions SET status = 'retired' WHERE org_id = $1 AND id = $2`,
        [seed.orgId, seed.versionId],
      )
      await expect(resolveElearningCourseAccess(db, {
        orgId: seed.orgId,
        userId: seed.userId,
        courseVersionId: seed.versionId,
      })).resolves.toMatchObject({ basis: { kind: 'assignment' } })
      await expect(resolveElearningCourseAccess(db, {
        orgId: seed.orgId,
        userId: actor('unassigned'),
        courseVersionId: seed.versionId,
      })).rejects.toMatchObject({ code: 'denied' })
    })
  })

  it('enforces XOR, same-org and same-parent constraints in the migrated schema', async () => {
    await withRolledBackDb(async (client, db) => {
      const seedA = await seedPublishedVideoCourse(client, { orgId: actor('org-fk-a') })
      const scopeA = await setElearningCourseScope(db, {
        orgId: seedA.orgId,
        actorId: actor('scope-admin'),
        courseId: seedA.courseId,
        reason: 'scope A',
        rules: [{ subjectType: 'all' }],
      })
      const started = await startElearningWatch(db, {
        orgId: seedA.orgId,
        userId: seedA.userId,
        itemId: seedA.itemId,
      })
      const memberId = await seedAssignment(client, seedA)

      await expectSqlState(client, '23514', () => client.query(
        `UPDATE elearning_learning_sessions
            SET assignment_member_id = NULL, scope_revision_rule_id = NULL
          WHERE id = $1`,
        [started.sessionId],
      ))
      await expectSqlState(client, '23514', () => client.query(
        `UPDATE elearning_learning_sessions
            SET assignment_member_id = $1, scope_revision_rule_id = $2
          WHERE id = $3`,
        [memberId, scopeA.ruleIds[0], started.sessionId],
      ))
      await expectSqlState(client, '23514', () => client.query(
        `UPDATE elearning_progress
            SET required_at_completion = TRUE
          WHERE org_id = $1 AND user_id = $2 AND course_version_item_id = $3`,
        [seedA.orgId, seedA.userId, seedA.itemId],
      ))

      const identityIndexes = await client.query<{ indexname: string }>(
        `SELECT indexname
           FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = ANY($1::text[])
          ORDER BY indexname`,
        [[SCOPE_RULES_NULL_IDENTITY_INDEX, SCOPE_RULES_REF_IDENTITY_INDEX]],
      )
      expect(identityIndexes.rows.map((row) => row.indexname)).toEqual([
        SCOPE_RULES_NULL_IDENTITY_INDEX,
        SCOPE_RULES_REF_IDENTITY_INDEX,
      ].sort())
      await expectSqlState(client, '23505', () => client.query(
        `INSERT INTO elearning_scope_revision_rules (
           org_id, scope_revision_id, subject_type, subject_ref, include_children
         ) VALUES ($1, $2, 'all', NULL, FALSE)`,
        [seedA.orgId, scopeA.revisionId],
      ))

      const seedB = await seedPublishedVideoCourse(client, { orgId: actor('org-fk-b') })
      const scopeB = await setElearningCourseScope(db, {
        orgId: seedB.orgId,
        actorId: actor('scope-admin'),
        courseId: seedB.courseId,
        reason: 'scope B',
        rules: [{ subjectType: 'all' }],
      })
      await expectSqlState(client, '23503', () => client.query(
        `UPDATE elearning_learning_sessions
            SET assignment_member_id = NULL, scope_revision_rule_id = $1
          WHERE id = $2`,
        [scopeB.ruleIds[0], started.sessionId],
      ))

      const unscopedA = await seedPublishedVideoCourse(client, {
        orgId: seedA.orgId,
        userId: actor('second-learner'),
      })
      await expectSqlState(client, '23503', () => client.query(
        `UPDATE elearning_courses SET scope_id = $1 WHERE org_id = $2 AND id = $3`,
        [scopeB.scopeId, seedA.orgId, unscopedA.courseId],
      ))
      await expectSqlState(client, '23503', () => client.query(
        `UPDATE elearning_scopes SET active_revision_id = $1
          WHERE org_id = $2 AND id = $3`,
        [scopeB.revisionId, seedA.orgId, scopeA.scopeId],
      ))
      await expectSqlState(client, 'P0001', () => client.query(
        `UPDATE elearning_scope_revisions SET reason = 'mutated' WHERE id = $1`,
        [scopeA.revisionId],
      ))
      await expectSqlState(client, 'P0001', () => client.query(
        `UPDATE elearning_scope_revision_rules SET subject_type = 'user' WHERE id = $1`,
        [scopeA.ruleIds[0]],
      ))
    })
  })

  it('freezes optional completion evidence and its referenced rule/revision with real RESTRICT FKs', async () => {
    await withRolledBackDb(async (client, db) => {
      const seed = await seedPublishedVideoCourse(client, {
        orgId: actor('org-evidence'),
        durationMs: 10_000,
      })
      const scope = await setElearningCourseScope(db, {
        orgId: seed.orgId,
        actorId: actor('scope-admin'),
        courseId: seed.courseId,
        reason: 'completion scope',
        rules: [{ subjectType: 'all' }],
      })
      const started = await startElearningWatch(db, {
        orgId: seed.orgId,
        userId: seed.userId,
        itemId: seed.itemId,
      })
      await client.query(
        `UPDATE elearning_learning_sessions
            SET last_event_at = clock_timestamp() - interval '20 seconds'
          WHERE id = $1`,
        [started.sessionId],
      )
      const completed = await recordElearningHeartbeat(db, {
        sessionId: started.sessionId!,
        orgId: seed.orgId,
        userId: seed.userId,
        sequence: 1,
        positionMs: 10_000,
        playing: true,
      })
      expect(completed.status).toBe('completed')
      const frozen = await client.query(
        `SELECT
           e.assignment_member_id,
           e.scope_revision_rule_id,
           p.required_at_completion
         FROM elearning_completion_evidence e
         JOIN elearning_progress p
           ON p.org_id = e.org_id
          AND p.user_id = e.user_id
          AND p.course_version_item_id = e.course_version_item_id
         WHERE e.org_id = $1`,
        [seed.orgId],
      )
      expect(frozen.rows).toEqual([{
        assignment_member_id: null,
        scope_revision_rule_id: scope.ruleIds[0],
        required_at_completion: false,
      }])

      const constraints = await client.query<{ conname: string; confdeltype: string }>(
        `SELECT conname, confdeltype
           FROM pg_constraint
          WHERE conname IN (
            'elearning_learning_sessions_scope_rule_fk',
            'elearning_progress_scope_rule_fk',
            'elearning_completion_evidence_scope_rule_fk'
          )
          ORDER BY conname`,
      )
      expect(constraints.rows).toEqual([
        { conname: 'elearning_completion_evidence_scope_rule_fk', confdeltype: 'r' },
        { conname: 'elearning_learning_sessions_scope_rule_fk', confdeltype: 'r' },
        { conname: 'elearning_progress_scope_rule_fk', confdeltype: 'r' },
      ])

      await client.query(
        `ALTER TABLE elearning_scope_revision_rules
           DISABLE TRIGGER trg_elearning_scope_revision_rules_deny_mutation`,
      )
      await expectSqlState(client, '23503', () => client.query(
        'DELETE FROM elearning_scope_revision_rules WHERE id = $1',
        [scope.ruleIds[0]],
      ))
      await client.query(
        `ALTER TABLE elearning_scope_revision_rules
           ENABLE TRIGGER trg_elearning_scope_revision_rules_deny_mutation`,
      )

      await client.query(
        `ALTER TABLE elearning_scope_revisions
           DISABLE TRIGGER trg_elearning_scope_revisions_deny_mutation`,
      )
      await expectSqlState(client, '23503', () => client.query(
        'DELETE FROM elearning_scope_revisions WHERE id = $1',
        [scope.revisionId],
      ))
      await client.query(
        `ALTER TABLE elearning_scope_revisions
           ENABLE TRIGGER trg_elearning_scope_revisions_deny_mutation`,
      )

      const assignedSeed = await seedPublishedVideoCourse(client, {
        orgId: actor('org-assignment-evidence'),
        durationMs: 10_000,
      })
      const memberId = await seedAssignment(client, assignedSeed)
      const assignedSession = await startElearningWatch(db, {
        orgId: assignedSeed.orgId,
        userId: assignedSeed.userId,
        itemId: assignedSeed.itemId,
      })
      await client.query(
        `UPDATE elearning_learning_sessions
            SET last_event_at = clock_timestamp() - interval '20 seconds'
          WHERE id = $1`,
        [assignedSession.sessionId],
      )
      await expect(recordElearningHeartbeat(db, {
        sessionId: assignedSession.sessionId!,
        orgId: assignedSeed.orgId,
        userId: assignedSeed.userId,
        sequence: 1,
        positionMs: 10_000,
        playing: true,
      })).resolves.toMatchObject({ status: 'completed' })
      await client.query(
        `ALTER TABLE elearning_assignment_members
           DISABLE TRIGGER trg_elearning_assignment_members_point_in_time`,
      )
      try {
        await expectSqlState(client, '23503', () => client.query(
          'DELETE FROM elearning_assignment_members WHERE id = $1',
          [memberId],
        ))
      } finally {
        await client.query(
          `ALTER TABLE elearning_assignment_members
             ENABLE TRIGGER trg_elearning_assignment_members_point_in_time`,
        )
      }
    })
  })

  it('validates the scope command before writes and appends deterministic revisions', async () => {
    await withRolledBackDb(async (client, db) => {
      const seed = await seedPublishedVideoCourse(client, { orgId: actor('org-command') })
      await expect(setElearningCourseScope(db, {
        orgId: seed.orgId,
        actorId: actor('scope-admin'),
        courseId: seed.courseId,
        reason: 'unsupported',
        rules: [{ subjectType: 'department', subjectRef: 'd1' } as never],
      })).rejects.toMatchObject({ code: 'unsupported_subject' })
      await expect(setElearningCourseScope(db, {
        orgId: seed.orgId,
        actorId: actor('scope-admin'),
        courseId: seed.courseId,
        reason: 'duplicate',
        rules: [
          { subjectType: 'user', subjectRef: seed.userId },
          { subjectType: 'user', subjectRef: ` ${seed.userId} ` },
        ],
      })).rejects.toMatchObject({ code: 'invalid_input' })

      await expect(setElearningCourseScope(db, {
        orgId: seed.orgId,
        actorId: actor('scope-admin'),
        courseId: seed.courseId,
        reason: 'missing user',
        rules: [{ subjectType: 'user', subjectRef: actor('missing-user') }],
      })).rejects.toMatchObject({ code: 'subject_not_found' })
      const crossOrgUser = actor(`cross-org-${randomUUID().slice(0, 8)}`)
      await seedActiveMembership(client, crossOrgUser, actor('other-org'))
      await expect(setElearningCourseScope(db, {
        orgId: seed.orgId,
        actorId: actor('scope-admin'),
        courseId: seed.courseId,
        reason: 'cross-org user',
        rules: [{ subjectType: 'user', subjectRef: crossOrgUser }],
      })).rejects.toMatchObject({ code: 'subject_not_found' })
      await client.query(
        `UPDATE user_orgs SET is_active = FALSE
          WHERE user_id = $1 AND org_id = $2`,
        [seed.userId, seed.orgId],
      )
      await expect(setElearningCourseScope(db, {
        orgId: seed.orgId,
        actorId: actor('scope-admin'),
        courseId: seed.courseId,
        reason: 'inactive user',
        rules: [{ subjectType: 'user', subjectRef: seed.userId }],
      })).rejects.toMatchObject({ code: 'subject_not_found' })
      await client.query(
        `UPDATE user_orgs SET is_active = TRUE
          WHERE user_id = $1 AND org_id = $2`,
        [seed.userId, seed.orgId],
      )
      const beforeValid = await client.query(
        `SELECT count(*)::int AS count
           FROM elearning_scope_revisions
          WHERE org_id = $1`,
        [seed.orgId],
      )
      expect(beforeValid.rows).toEqual([{ count: 0 }])

      const first = await setElearningCourseScope(db, {
        orgId: seed.orgId,
        actorId: actor('scope-admin'),
        courseId: seed.courseId,
        reason: 'nobody',
        rules: [],
      })
      const second = await setElearningCourseScope(db, {
        orgId: seed.orgId,
        actorId: actor('scope-admin'),
        courseId: seed.courseId,
        reason: 'one learner',
        rules: [{ subjectType: 'user', subjectRef: seed.userId }],
      })
      expect(first).toEqual(expect.objectContaining({ revision: 1, ruleIds: [] }))
      expect(second).toEqual(expect.objectContaining({
        scopeId: first.scopeId,
        revision: 2,
      }))
      const active = await client.query(
        `SELECT s.active_revision_id, s.latest_revision_id, r.revision
           FROM elearning_scopes s
           JOIN elearning_scope_revisions r
             ON r.org_id = s.org_id AND r.id = s.active_revision_id
          WHERE s.org_id = $1 AND s.id = $2`,
        [seed.orgId, first.scopeId],
      )
      expect(active.rows).toEqual([{
        active_revision_id: second.revisionId,
        latest_revision_id: second.revisionId,
        revision: 2,
      }])
    })
  })

  it('refuses an in-use down migration and round-trips the unused schema transactionally', async () => {
    const migrationPool = new Pool({ connectionString: DATABASE_URL, max: 1 })
    const migrationDb = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: migrationPool }),
    })
    const rollback = new Error('EXPECTED_SCOPE_MIGRATION_ROLLBACK')
    try {
      await expect(migrationDb.transaction().execute(async (trx) => {
        const orgId = actor('org-down-in-use')
        const courseId = randomUUID()
        const scopeId = randomUUID()
        const revisionId = randomUUID()
        await sql`
          INSERT INTO elearning_courses (id, org_id, title, status, created_by)
          VALUES (${courseId}, ${orgId}, 'Down guard', 'active', ${actor('author')})
        `.execute(trx)
        await sql`
          INSERT INTO elearning_scopes (id, org_id, created_by)
          VALUES (${scopeId}, ${orgId}, ${actor('scope-admin')})
        `.execute(trx)
        await sql`
          INSERT INTO elearning_scope_revisions
            (id, org_id, scope_id, revision, actor_id, reason)
          VALUES (${revisionId}, ${orgId}, ${scopeId}, 1, ${actor('scope-admin')}, 'in use')
        `.execute(trx)
        await sql`
          UPDATE elearning_scopes
             SET active_revision_id = ${revisionId}, latest_revision_id = ${revisionId}
           WHERE org_id = ${orgId} AND id = ${scopeId}
        `.execute(trx)
        await sql`
          UPDATE elearning_courses SET scope_id = ${scopeId}
           WHERE org_id = ${orgId} AND id = ${courseId}
        `.execute(trx)
        await expect(downScopeAccess(trx)).rejects.toThrow('ELEARNING_SCOPE_ACCESS_DOWN_IN_USE')
        throw rollback
      })).rejects.toBe(rollback)

      await expect(migrationDb.transaction().execute(async (trx) => {
        await downScopeAccess(trx)
        const removed = await sql<{ scope_table: string | null; scope_column: number }>`
          SELECT
            to_regclass('elearning_scopes')::text AS scope_table,
            (
              SELECT count(*)::integer
                FROM information_schema.columns
               WHERE table_schema = current_schema()
                 AND table_name = 'elearning_courses'
                 AND column_name = 'scope_id'
            ) AS scope_column
        `.execute(trx)
        expect(removed.rows).toEqual([{ scope_table: null, scope_column: 0 }])

        await upScopeAccess(trx)
        const restored = await sql<{ scope_table: string | null; scope_column: number }>`
          SELECT
            to_regclass('elearning_scopes')::text AS scope_table,
            (
              SELECT count(*)::integer
                FROM information_schema.columns
               WHERE table_schema = current_schema()
                 AND table_name = 'elearning_courses'
                 AND column_name = 'scope_id'
            ) AS scope_column
        `.execute(trx)
        expect(restored.rows).toEqual([{
          scope_table: 'elearning_scopes',
          scope_column: 1,
        }])
        throw rollback
      })).rejects.toBe(rollback)
    } finally {
      await migrationDb.destroy()
    }
  })
})
