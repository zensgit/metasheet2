/**
 * E-learning L3 manual-grading queue/detail gate against fully migrated
 * PostgreSQL. DATABASE_URL is mandatory; missing infrastructure must fail.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'

import {
  getElearningManualGradingDetail,
  listElearningManualGradingQueue,
  type ElearningManualGradingReadDb,
  type ElearningManualGradingReadQueryable,
} from '../../src/services/elearning-manual-grading-read'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning manual-grading read gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 })
const NS = `el-manual-read-${process.pid}-${Date.now().toString(36)}`

class ClientDb implements ElearningManualGradingReadDb {
  private savepoint = 0

  constructor(private readonly client: PoolClient) {}

  async query(sql: string, params?: unknown[]) {
    const result = await this.client.query(sql, params as never)
    return {
      rows: result.rows as Array<Record<string, unknown>>,
      rowCount: result.rowCount,
    }
  }

  async transaction<T>(
    handler: (tx: ElearningManualGradingReadQueryable) => Promise<T>,
  ): Promise<T> {
    const savepoint = `elearning_manual_read_${++this.savepoint}`
    await this.client.query(`SAVEPOINT ${savepoint}`)
    try {
      const result = await handler({
        query: async (sql, params) => {
          const queryResult = await this.client.query(sql, params as never)
          return {
            rows: queryResult.rows as Array<Record<string, unknown>>,
            rowCount: queryResult.rowCount,
          }
        },
      })
      await this.client.query(`RELEASE SAVEPOINT ${savepoint}`)
      return result
    } catch (error) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      await this.client.query(`RELEASE SAVEPOINT ${savepoint}`)
      throw error
    }
  }
}

type Fixture = {
  orgId: string
  managerId: string
  noScopeManagerId: string
  inScopeLearnerId: string
  outsideLearnerId: string
  inScopeAttemptId: string
  outsideAttemptId: string
  shortRevisionIds: [string, string]
}

async function withRolledBackDb(
  run: (client: PoolClient, db: ClientDb) => Promise<void>,
): Promise<void> {
  const client = await pool.connect()
  await client.query('BEGIN')
  try {
    await run(client, new ClientDb(client))
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

async function seedUser(
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
       $1, $2, $1, 'x', 'user', '[]'::jsonb,
       TRUE, FALSE, 'activated', TRUE, FALSE, now(), now()
     )`,
    [userId, `${randomUUID()}@elearning-read.test`],
  )
  await client.query(
    `INSERT INTO user_orgs (user_id, org_id, is_active)
     VALUES ($1, $2, TRUE)`,
    [userId, orgId],
  )
}

async function seedDirectoryUser(
  client: PoolClient,
  userId: string,
  integrationId: string,
  departmentId: string,
): Promise<void> {
  const accountId = randomUUID()
  const externalId = `${NS}-${randomUUID()}`
  await client.query(
    `INSERT INTO directory_accounts (
       id, integration_id, provider, external_user_id, external_key,
       name, is_active
     ) VALUES ($1, $2, 'dingtalk', $3, $3, $4, TRUE)`,
    [accountId, integrationId, externalId, userId],
  )
  await client.query(
    `INSERT INTO directory_account_departments (
       directory_account_id, directory_department_id, is_primary
     ) VALUES ($1, $2, TRUE)`,
    [accountId, departmentId],
  )
  await client.query(
    `INSERT INTO directory_account_links (
       id, directory_account_id, local_user_id, link_status
     ) VALUES ($1, $2, $3, 'linked')`,
    [randomUUID(), accountId, userId],
  )
}

async function seedAttempt(
  client: PoolClient,
  input: {
    orgId: string
    examId: string
    versionId: string
    itemId: string
    userId: string
    snapshot: Record<string, unknown>
    answers: Record<string, unknown>
    withManualGrade: boolean
    shortRevisionId: string
    graderId: string
  },
): Promise<string> {
  const attemptId = randomUUID()
  await client.query(
    `INSERT INTO elearning_exam_attempts (
       id, org_id, exam_id, course_version_id, course_version_item_id,
       user_id, attempt_no, paper_snapshot, status
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7::jsonb, 'started')`,
    [
      attemptId,
      input.orgId,
      input.examId,
      input.versionId,
      input.itemId,
      input.userId,
      JSON.stringify(input.snapshot),
    ],
  )
  await client.query(
    `UPDATE elearning_exam_attempts
        SET status = 'submitted', answers = $1::jsonb,
            submitted_at = clock_timestamp()
      WHERE org_id = $2 AND id = $3`,
    [JSON.stringify(input.answers), input.orgId, attemptId],
  )
  await client.query(
    `INSERT INTO elearning_grading_records (
       org_id, attempt_id, kind, score, max_score, details, grader_id
     ) VALUES ($1, $2, 'auto', 5, 5, '{}'::jsonb, 'system:auto')`,
    [input.orgId, attemptId],
  )
  await client.query(
    `UPDATE elearning_exam_attempts
        SET status = 'awaiting_manual', auto_score = 5
      WHERE org_id = $1 AND id = $2`,
    [input.orgId, attemptId],
  )
  if (input.withManualGrade) {
    await client.query(
      `INSERT INTO elearning_grading_records (
         org_id, attempt_id, kind, question_revision_id, request_id,
         seq, score, max_score, details, grader_id
       ) VALUES (
         $1, $2, 'manual', $3, $4, 2, 3, 4, $5::jsonb, $6
       )`,
      [
        input.orgId,
        attemptId,
        input.shortRevisionId,
        randomUUID(),
        JSON.stringify({
          domain: 'elearning.manual-grade.v1',
          version: 1,
          comment: 'Good structure',
        }),
        input.graderId,
      ],
    )
    await client.query(
      `UPDATE elearning_exam_attempts
          SET manual_score = 3
        WHERE org_id = $1 AND id = $2`,
      [input.orgId, attemptId],
    )
  }
  return attemptId
}

async function seedFixture(client: PoolClient): Promise<Fixture> {
  const orgId = `${NS}-org`
  const managerId = `${NS}-manager`
  const noScopeManagerId = `${NS}-manager-no-scope`
  const inScopeLearnerId = `${NS}-learner-in`
  const outsideLearnerId = `${NS}-learner-out`
  for (const userId of [
    managerId,
    noScopeManagerId,
    inScopeLearnerId,
    outsideLearnerId,
  ]) {
    await seedUser(client, userId, orgId)
  }

  const integrationId = randomUUID()
  const allowedDepartmentId = randomUUID()
  const outsideDepartmentId = randomUUID()
  await client.query(
    `INSERT INTO directory_integrations (
       id, org_id, provider, name, status, corp_id
     ) VALUES ($1, $2, 'dingtalk', $3, 'active', $4)`,
    [integrationId, orgId, `${NS}-integration`, `${NS}-corp`],
  )
  await client.query(
    `INSERT INTO directory_departments (
       id, integration_id, provider, external_department_id,
       external_parent_department_id, name, is_active
     ) VALUES
       ($1, $3, 'dingtalk', 'allowed', NULL, 'Allowed', TRUE),
       ($2, $3, 'dingtalk', 'outside', NULL, 'Outside', TRUE)`,
    [allowedDepartmentId, outsideDepartmentId, integrationId],
  )
  await seedDirectoryUser(
    client,
    inScopeLearnerId,
    integrationId,
    allowedDepartmentId,
  )
  await seedDirectoryUser(
    client,
    outsideLearnerId,
    integrationId,
    outsideDepartmentId,
  )
  await client.query(
    `INSERT INTO elearning_admin_scopes (
       org_id, user_id, directory_integration_id, directory_provider,
       directory_department_id, include_children, granted_by
     ) VALUES ($1, $2, $3, 'dingtalk', $4, FALSE, $2)`,
    [orgId, managerId, integrationId, allowedDepartmentId],
  )

  const courseId = randomUUID()
  const versionId = randomUUID()
  const examId = randomUUID()
  const itemId = randomUUID()
  const questionIds = [randomUUID(), randomUUID(), randomUUID()]
  const revisionIds = [randomUUID(), randomUUID(), randomUUID()] as const
  await client.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES ($1, $2, 'Read course', 'active', $3)`,
    [courseId, orgId, managerId],
  )
  await client.query(
    `INSERT INTO elearning_course_versions (
       id, org_id, course_id, version, status, title, created_by
     ) VALUES ($1, $2, $3, 1, 'draft', 'Read course v1', $4)`,
    [versionId, orgId, courseId, managerId],
  )
  await client.query(
    `INSERT INTO elearning_exams (
       id, org_id, title, status, pass_score, max_attempts, created_by
     ) VALUES ($1, $2, 'Read exam', 'draft', 10, 1, $3)`,
    [examId, orgId, managerId],
  )
  await client.query(
    `INSERT INTO elearning_course_version_items (
       id, org_id, course_version_id, item_type, position, exam_id
     ) VALUES ($1, $2, $3, 'exam', 1, $4)`,
    [itemId, orgId, versionId, examId],
  )
  for (const questionId of questionIds) {
    await client.query(
      `INSERT INTO elearning_questions (id, org_id, created_by)
       VALUES ($1, $2, $3)`,
      [questionId, orgId, managerId],
    )
  }
  await client.query(
    `INSERT INTO elearning_question_revisions (
       id, org_id, question_id, revision, question_type, prompt, options,
       answer_key, points, explanation, created_by
     ) VALUES
       ($1, $4, $6, 1, 'single_choice', 'Objective secret',
        '[{"id":"a","text":"A"},{"id":"b","text":"B"}]'::jsonb,
        '{"correct":["a"]}'::jsonb, 5, 'Objective explanation', $5),
       ($2, $4, $7, 1, 'short_answer', 'Explain one', '[]'::jsonb,
        '{}'::jsonb, 4, 'Private rubric one', $5),
       ($3, $4, $8, 1, 'short_answer', 'Explain two', '[]'::jsonb,
        '{}'::jsonb, 6, 'Private rubric two', $5)`,
    [
      revisionIds[0],
      revisionIds[1],
      revisionIds[2],
      orgId,
      managerId,
      questionIds[0],
      questionIds[1],
      questionIds[2],
    ],
  )

  const snapshot = {
    domain: 'elearning.exam.paper.v1',
    version: 2,
    examId,
    passScore: 10,
    questions: [
      {
        position: 1,
        questionRevisionId: revisionIds[0],
        questionId: questionIds[0],
        questionType: 'single_choice',
        prompt: 'Objective secret',
        options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
        points: 5,
        answerKey: { correct: ['a'] },
        explanation: 'Objective explanation',
      },
      {
        position: 2,
        questionRevisionId: revisionIds[1],
        questionId: questionIds[1],
        questionType: 'short_answer',
        prompt: 'Explain one',
        options: [],
        points: 4,
        answerKey: {},
        explanation: 'Private rubric one',
      },
      {
        position: 3,
        questionRevisionId: revisionIds[2],
        questionId: questionIds[2],
        questionType: 'short_answer',
        prompt: 'Explain two',
        options: [],
        points: 6,
        answerKey: {},
        explanation: 'Private rubric two',
      },
    ],
  }
  const answers = {
    [revisionIds[0]]: ['a'],
    [revisionIds[1]]: 'Learner answer one',
    [revisionIds[2]]: 'Learner answer two',
  }
  const inScopeAttemptId = await seedAttempt(client, {
    orgId,
    examId,
    versionId,
    itemId,
    userId: inScopeLearnerId,
    snapshot,
    answers,
    withManualGrade: true,
    shortRevisionId: revisionIds[1],
    graderId: managerId,
  })
  const outsideAttemptId = await seedAttempt(client, {
    orgId,
    examId,
    versionId,
    itemId,
    userId: outsideLearnerId,
    snapshot,
    answers,
    withManualGrade: false,
    shortRevisionId: revisionIds[1],
    graderId: managerId,
  })
  return {
    orgId,
    managerId,
    noScopeManagerId,
    inScopeLearnerId,
    outsideLearnerId,
    inScopeAttemptId,
    outsideAttemptId,
    shortRevisionIds: [revisionIds[1], revisionIds[2]],
  }
}

afterAll(async () => {
  await pool.end()
})

describe('e-learning manual-grading read service (real PostgreSQL)', () => {
  it('scope-filters queue/detail and returns only closed short-answer DTOs', async () => {
    await withRolledBackDb(async (client, db) => {
      const fixture = await seedFixture(client)
      const scoped = await listElearningManualGradingQueue(db, {
        orgId: fixture.orgId,
        actorId: fixture.managerId,
        isGlobalAdmin: false,
        page: 1,
        pageSize: 10,
      })
      expect(scoped).toEqual({
        items: [expect.objectContaining({
          attemptId: fixture.inScopeAttemptId,
          userId: fixture.inScopeLearnerId,
          examTitle: 'Read exam',
          courseTitle: 'Read course v1',
          autoScore: 5,
          manualScore: 3,
          paperMaxScore: 15,
          gradedQuestions: 1,
          manualQuestions: 2,
        })],
        page: 1,
        pageSize: 10,
        hasMore: false,
      })
      expect(JSON.stringify(scoped)).not.toContain(fixture.outsideLearnerId)
      expect(JSON.stringify(scoped)).not.toContain('Objective secret')

      const detail = await getElearningManualGradingDetail(db, {
        orgId: fixture.orgId,
        actorId: fixture.managerId,
        isGlobalAdmin: false,
        attemptId: fixture.inScopeAttemptId,
      })
      expect(detail.questions).toEqual([
        {
          questionRevisionId: fixture.shortRevisionIds[0],
          position: 2,
          prompt: 'Explain one',
          points: 4,
          learnerAnswer: 'Learner answer one',
          grade: expect.objectContaining({
            score: 3,
            maxScore: 4,
            comment: 'Good structure',
            graderId: fixture.managerId,
          }),
        },
        {
          questionRevisionId: fixture.shortRevisionIds[1],
          position: 3,
          prompt: 'Explain two',
          points: 6,
          learnerAnswer: 'Learner answer two',
          grade: null,
        },
      ])
      const serialized = JSON.stringify(detail)
      expect(serialized).not.toContain('Objective secret')
      expect(serialized).not.toContain('Objective explanation')
      expect(serialized).not.toContain('Private rubric')
      expect(serialized).not.toContain('answerKey')
      expect(serialized).not.toContain('requestId')

      await expect(getElearningManualGradingDetail(db, {
        orgId: fixture.orgId,
        actorId: fixture.managerId,
        isGlobalAdmin: false,
        attemptId: fixture.outsideAttemptId,
      })).rejects.toMatchObject({ code: 'not_found' })
      await expect(listElearningManualGradingQueue(db, {
        orgId: fixture.orgId,
        actorId: fixture.noScopeManagerId,
        isGlobalAdmin: false,
      })).rejects.toMatchObject({ code: 'scope_required' })

      const globalPage = await listElearningManualGradingQueue(db, {
        orgId: fixture.orgId,
        actorId: fixture.managerId,
        isGlobalAdmin: true,
        page: 1,
        pageSize: 1,
      })
      expect(globalPage.items).toHaveLength(1)
      expect(globalPage.hasMore).toBe(true)
      expect(globalPage.items[0]?.attemptId).toBe(fixture.inScopeAttemptId)
      const globalPageTwo = await listElearningManualGradingQueue(db, {
        orgId: fixture.orgId,
        actorId: fixture.managerId,
        isGlobalAdmin: true,
        page: 2,
        pageSize: 1,
      })
      expect(globalPageTwo.items.map((item) => item.attemptId)).toEqual([
        fixture.outsideAttemptId,
      ])
      expect(globalPageTwo.hasMore).toBe(false)
      const otherOrgQueue = await listElearningManualGradingQueue(db, {
        orgId: `${fixture.orgId}-other`,
        actorId: fixture.managerId,
        isGlobalAdmin: true,
      })
      expect(otherOrgQueue.items).toEqual([])
      await expect(getElearningManualGradingDetail(db, {
        orgId: `${fixture.orgId}-other`,
        actorId: fixture.managerId,
        isGlobalAdmin: true,
        attemptId: fixture.inScopeAttemptId,
      })).rejects.toMatchObject({ code: 'not_found' })

      await client.query(
        `UPDATE elearning_exam_attempts
            SET status = 'graded', total_score = 15, passed = FALSE,
                graded_at = clock_timestamp()
          WHERE org_id = $1 AND id = $2`,
        [fixture.orgId, fixture.outsideAttemptId],
      )
      const afterFinalization = await listElearningManualGradingQueue(db, {
        orgId: fixture.orgId,
        actorId: fixture.managerId,
        isGlobalAdmin: true,
      })
      expect(afterFinalization.items.map((item) => item.attemptId)).toEqual([
        fixture.inScopeAttemptId,
      ])
      await expect(getElearningManualGradingDetail(db, {
        orgId: fixture.orgId,
        actorId: fixture.managerId,
        isGlobalAdmin: true,
        attemptId: fixture.outsideAttemptId,
      })).rejects.toMatchObject({ code: 'not_found' })

      await client.query(
        `UPDATE elearning_exam_attempts
            SET manual_score = 9
          WHERE org_id = $1 AND id = $2`,
        [fixture.orgId, fixture.inScopeAttemptId],
      )
      await expect(listElearningManualGradingQueue(db, {
        orgId: fixture.orgId,
        actorId: fixture.managerId,
        isGlobalAdmin: true,
      })).rejects.toMatchObject({ code: 'unavailable' })
      await expect(getElearningManualGradingDetail(db, {
        orgId: fixture.orgId,
        actorId: fixture.managerId,
        isGlobalAdmin: true,
        attemptId: fixture.inScopeAttemptId,
      })).rejects.toMatchObject({ code: 'unavailable' })
    })
  })
})
