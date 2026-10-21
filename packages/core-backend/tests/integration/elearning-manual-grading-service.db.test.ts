/**
 * E-learning L3 initial manual-grading service gate against fully migrated
 * PostgreSQL. DATABASE_URL is mandatory; missing infrastructure must fail.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'

import {
  submitElearningManualGrade,
  type ElearningManualGradingDb,
  type ElearningManualGradingQueryable,
} from '../../src/services/elearning-manual-grading'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error(
    'e-learning manual-grading service gate requires DATABASE_URL; refusing skip-shaped green',
  )
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 4 })
const NS = `el-manual-service-${Date.now().toString(36)}`

class ClientDb implements ElearningManualGradingDb {
  private savepoint = 0

  constructor(
    private readonly client: PoolClient,
    private readonly failQueryMarker: string | null = null,
  ) {}

  async query(sql: string, params?: unknown[]) {
    const result = await this.client.query(sql, params as never)
    return {
      rows: result.rows as Array<Record<string, unknown>>,
      rowCount: result.rowCount,
    }
  }

  async transaction<T>(
    handler: (tx: ElearningManualGradingQueryable) => Promise<T>,
  ): Promise<T> {
    const savepoint = `elearning_manual_service_${++this.savepoint}`
    await this.client.query(`SAVEPOINT ${savepoint}`)
    try {
      const result = await handler({
        query: async (sql, params) => {
          if (this.failQueryMarker && sql.includes(this.failQueryMarker)) {
            return { rows: [], rowCount: 0 }
          }
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
  attemptId: string
  learnerId: string
  objectiveRevisionId: string
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

async function seedAwaitingManualAttempt(
  client: PoolClient,
  suffix: string,
  includeAutoLedger = true,
): Promise<Fixture> {
  const orgId = `${NS}-${suffix}`
  const actorId = `${NS}-author`
  const learnerId = `${NS}-learner-${suffix}`
  const courseId = randomUUID()
  const versionId = randomUUID()
  const examId = randomUUID()
  const itemId = randomUUID()
  const attemptId = randomUUID()
  const questionIds = [randomUUID(), randomUUID(), randomUUID()]
  const revisionIds = [randomUUID(), randomUUID(), randomUUID()] as const

  await client.query(
    `INSERT INTO elearning_courses (id, org_id, title, status, created_by)
     VALUES ($1, $2, 'Manual grading course', 'active', $3)`,
    [courseId, orgId, actorId],
  )
  await client.query(
    `INSERT INTO elearning_course_versions
       (id, org_id, course_id, version, status, title, created_by)
     VALUES ($1, $2, $3, 1, 'draft', 'Manual grading v1', $4)`,
    [versionId, orgId, courseId, actorId],
  )
  await client.query(
    `INSERT INTO elearning_exams
       (id, org_id, title, status, pass_score, max_attempts, created_by)
     VALUES ($1, $2, 'Manual grading exam', 'draft', 12, 1, $3)`,
    [examId, orgId, actorId],
  )
  await client.query(
    `INSERT INTO elearning_course_version_items
       (id, org_id, course_version_id, item_type, position, exam_id)
     VALUES ($1, $2, $3, 'exam', 1, $4)`,
    [itemId, orgId, versionId, examId],
  )

  for (let index = 0; index < questionIds.length; index += 1) {
    await client.query(
      `INSERT INTO elearning_questions (id, org_id, created_by)
       VALUES ($1, $2, $3)`,
      [questionIds[index], orgId, actorId],
    )
  }
  await client.query(
    `INSERT INTO elearning_question_revisions
       (id, org_id, question_id, revision, question_type, prompt, options,
        answer_key, points, created_by)
     VALUES
       ($1, $4, $6, 1, 'single_choice', 'Pick one',
        '[{"id":"a","text":"A"},{"id":"b","text":"B"}]'::jsonb,
        '{"correct":["a"]}'::jsonb, 5, $5),
       ($2, $4, $7, 1, 'short_answer', 'Explain one', '[]'::jsonb,
        '{}'::jsonb, 4, $5),
       ($3, $4, $8, 1, 'short_answer', 'Explain two', '[]'::jsonb,
        '{}'::jsonb, 6, $5)`,
    [
      revisionIds[0],
      revisionIds[1],
      revisionIds[2],
      orgId,
      actorId,
      questionIds[0],
      questionIds[1],
      questionIds[2],
    ],
  )

  const snapshot = {
    domain: 'elearning.exam.paper.v1',
    version: 2,
    examId,
    passScore: 12,
    questions: [
      {
        position: 1,
        questionRevisionId: revisionIds[0],
        questionId: questionIds[0],
        questionType: 'single_choice',
        prompt: 'Pick one',
        options: [
          { id: 'a', text: 'A' },
          { id: 'b', text: 'B' },
        ],
        points: 5,
        answerKey: { correct: ['a'] },
        explanation: null,
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
        explanation: null,
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
        explanation: null,
      },
    ],
  }
  const answers = {
    [revisionIds[0]]: ['a'],
    [revisionIds[1]]: 'first answer',
    [revisionIds[2]]: 'second answer',
  }
  await client.query(
    `INSERT INTO elearning_exam_attempts
       (id, org_id, exam_id, course_version_id, course_version_item_id,
        user_id, attempt_no, paper_snapshot, status)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7::jsonb, 'started')`,
    [
      attemptId,
      orgId,
      examId,
      versionId,
      itemId,
      learnerId,
      JSON.stringify(snapshot),
    ],
  )
  await client.query(
    `UPDATE elearning_exam_attempts
        SET status = 'submitted', answers = $1::jsonb,
            submitted_at = clock_timestamp()
      WHERE org_id = $2 AND id = $3`,
    [JSON.stringify(answers), orgId, attemptId],
  )
  if (includeAutoLedger) {
    await client.query(
      `INSERT INTO elearning_grading_records
         (org_id, attempt_id, kind, score, max_score, details, grader_id)
       VALUES ($1, $2, 'auto', 5, 5, '{}'::jsonb, 'system:auto')`,
      [orgId, attemptId],
    )
  }
  await client.query(
    `UPDATE elearning_exam_attempts
        SET status = 'awaiting_manual', auto_score = 5
      WHERE org_id = $1 AND id = $2`,
    [orgId, attemptId],
  )

  return {
    orgId,
    attemptId,
    learnerId,
    objectiveRevisionId: revisionIds[0],
    shortRevisionIds: [revisionIds[1], revisionIds[2]],
  }
}

afterAll(async () => {
  await pool.end()
})

describe('e-learning initial manual-grading service (real PostgreSQL)', () => {
  it('appends per-question grades, replays idempotently, and finalizes only when complete', async () => {
    await withRolledBackDb(async (client, db) => {
      const fixture = await seedAwaitingManualAttempt(client, 'complete')
      const graderId = `${NS}-grader`
      const firstRequestId = randomUUID()
      const first = await submitElearningManualGrade(db, {
        orgId: fixture.orgId,
        actorId: graderId,
        isGlobalAdmin: true,
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.shortRevisionIds[0],
        requestId: firstRequestId,
        score: 4,
        comment: 'Clear answer',
      })
      expect(first).toEqual({
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.shortRevisionIds[0],
        score: 4,
        maxScore: 4,
        status: 'awaiting_manual',
        gradedQuestions: 1,
        manualQuestions: 2,
        autoScore: 5,
        manualScore: 4,
        totalScore: 15,
        passed: null,
        duplicate: false,
      })
      const partialAttempt = await client.query(
        `SELECT status, manual_score::text, total_score, passed
           FROM elearning_exam_attempts
          WHERE org_id = $1 AND id = $2`,
        [fixture.orgId, fixture.attemptId],
      )
      expect(partialAttempt.rows).toEqual([{
        status: 'awaiting_manual',
        manual_score: '4',
        total_score: null,
        passed: null,
      }])

      const replay = await submitElearningManualGrade(db, {
        orgId: fixture.orgId,
        actorId: graderId,
        isGlobalAdmin: true,
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.shortRevisionIds[0],
        requestId: firstRequestId,
        score: 4,
        comment: 'Clear answer',
      })
      expect(replay).toEqual({ ...first, duplicate: true })
      await expect(submitElearningManualGrade(db, {
        orgId: fixture.orgId,
        actorId: graderId,
        isGlobalAdmin: true,
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.shortRevisionIds[0],
        requestId: firstRequestId,
        score: 3,
        comment: 'Changed payload',
      })).rejects.toMatchObject({ code: 'conflict' })

      const completed = await submitElearningManualGrade(db, {
        orgId: fixture.orgId,
        actorId: graderId,
        isGlobalAdmin: true,
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.shortRevisionIds[1],
        requestId: randomUUID(),
        score: 3,
        comment: null,
      })
      expect(completed).toEqual({
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.shortRevisionIds[1],
        score: 3,
        maxScore: 6,
        status: 'graded',
        gradedQuestions: 2,
        manualQuestions: 2,
        autoScore: 5,
        manualScore: 7,
        totalScore: 15,
        passed: true,
        duplicate: false,
      })

      const attempt = await client.query(
        `SELECT status, auto_score::text, manual_score::text,
                total_score::text, passed, graded_at IS NOT NULL AS graded
           FROM elearning_exam_attempts
          WHERE org_id = $1 AND id = $2`,
        [fixture.orgId, fixture.attemptId],
      )
      expect(attempt.rows).toEqual([{
        status: 'graded',
        auto_score: '5',
        manual_score: '7',
        total_score: '15',
        passed: true,
        graded: true,
      }])
      const ledger = await client.query(
        `SELECT kind, question_revision_id, request_id, seq,
                score::text, max_score::text, details, grader_id
           FROM elearning_grading_records
          WHERE org_id = $1 AND attempt_id = $2
          ORDER BY seq`,
        [fixture.orgId, fixture.attemptId],
      )
      expect(ledger.rows.map((row) => row.kind)).toEqual([
        'auto',
        'manual',
        'manual',
      ])
      expect(ledger.rows.map((row) => row.seq)).toEqual([1, 2, 3])
      expect(ledger.rows[1]).toEqual(expect.objectContaining({
        question_revision_id: fixture.shortRevisionIds[0],
        request_id: firstRequestId,
        score: '4',
        max_score: '4',
        details: {
          domain: 'elearning.manual-grade.v1',
          version: 1,
          comment: 'Clear answer',
        },
        grader_id: graderId,
      }))

      const replayAfterCompletion = await submitElearningManualGrade(db, {
        orgId: fixture.orgId,
        actorId: graderId,
        isGlobalAdmin: true,
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.shortRevisionIds[0],
        requestId: firstRequestId,
        score: 4,
        comment: 'Clear answer',
      })
      expect(replayAfterCompletion).toEqual({
        ...first,
        status: 'graded',
        gradedQuestions: 2,
        manualScore: 7,
        passed: true,
        duplicate: true,
      })
    })
  })

  it('rejects invalid question, score, actor replay, org, and post-finalization commands', async () => {
    await withRolledBackDb(async (client, db) => {
      const fixture = await seedAwaitingManualAttempt(client, 'negative')
      const graderId = `${NS}-grader-negative`
      const requestId = randomUUID()

      await expect(submitElearningManualGrade(db, {
        orgId: fixture.orgId,
        actorId: graderId,
        isGlobalAdmin: true,
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.objectiveRevisionId,
        requestId,
        score: 1,
        comment: null,
      })).rejects.toMatchObject({ code: 'not_found' })
      await expect(submitElearningManualGrade(db, {
        orgId: fixture.orgId,
        actorId: graderId,
        isGlobalAdmin: true,
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.shortRevisionIds[0],
        requestId,
        score: 5,
        comment: null,
      })).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(submitElearningManualGrade(db, {
        orgId: `${fixture.orgId}-other`,
        actorId: graderId,
        isGlobalAdmin: true,
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.shortRevisionIds[0],
        requestId,
        score: 4,
        comment: null,
      })).rejects.toMatchObject({ code: 'not_found' })

      await submitElearningManualGrade(db, {
        orgId: fixture.orgId,
        actorId: graderId,
        isGlobalAdmin: true,
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.shortRevisionIds[0],
        requestId,
        score: 4,
        comment: null,
      })
      await expect(submitElearningManualGrade(db, {
        orgId: fixture.orgId,
        actorId: `${graderId}-other`,
        isGlobalAdmin: true,
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.shortRevisionIds[0],
        requestId,
        score: 4,
        comment: null,
      })).rejects.toMatchObject({ code: 'conflict' })
      await expect(submitElearningManualGrade(db, {
        orgId: fixture.orgId,
        actorId: graderId,
        isGlobalAdmin: true,
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.objectiveRevisionId,
        requestId,
        score: 4,
        comment: null,
      })).rejects.toMatchObject({ code: 'conflict' })
      await expect(submitElearningManualGrade(db, {
        orgId: fixture.orgId,
        actorId: graderId,
        isGlobalAdmin: true,
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.shortRevisionIds[0],
        requestId,
        score: 5,
        comment: null,
      })).rejects.toMatchObject({ code: 'conflict' })
      const failed = await submitElearningManualGrade(db, {
        orgId: fixture.orgId,
        actorId: graderId,
        isGlobalAdmin: true,
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.shortRevisionIds[1],
        requestId: randomUUID(),
        score: 0,
        comment: null,
      })
      expect(failed).toEqual(expect.objectContaining({
        status: 'graded',
        autoScore: 5,
        manualScore: 4,
        totalScore: 15,
        passed: false,
      }))
      const failedAttempt = await client.query(
        `SELECT status, manual_score::text, total_score::text, passed
           FROM elearning_exam_attempts
          WHERE org_id = $1 AND id = $2`,
        [fixture.orgId, fixture.attemptId],
      )
      expect(failedAttempt.rows).toEqual([{
        status: 'graded',
        manual_score: '4',
        total_score: '15',
        passed: false,
      }])
      await expect(submitElearningManualGrade(db, {
        orgId: fixture.orgId,
        actorId: graderId,
        isGlobalAdmin: true,
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.shortRevisionIds[0],
        requestId: randomUUID(),
        score: 4,
        comment: null,
      })).rejects.toMatchObject({ code: 'conflict' })
    })
  })

  it('refuses to grade when the server-derived automatic ledger is absent', async () => {
    await withRolledBackDb(async (client, db) => {
      const fixture = await seedAwaitingManualAttempt(
        client,
        'missing-auto-ledger',
        false,
      )
      await expect(submitElearningManualGrade(db, {
        orgId: fixture.orgId,
        actorId: `${NS}-grader-missing-auto`,
        isGlobalAdmin: true,
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.shortRevisionIds[0],
        requestId: randomUUID(),
        score: 4,
        comment: null,
      })).rejects.toMatchObject({ code: 'unavailable' })
      const ledger = await client.query(
        `SELECT count(*)::integer AS count
           FROM elearning_grading_records
          WHERE org_id = $1 AND attempt_id = $2`,
        [fixture.orgId, fixture.attemptId],
      )
      expect(ledger.rows).toEqual([{ count: 0 }])
    })
  })

  it('rolls back the appended grade when the attempt aggregate update fails', async () => {
    await withRolledBackDb(async (client) => {
      const fixture = await seedAwaitingManualAttempt(client, 'rollback')
      const db = new ClientDb(
        client,
        'elearning-manual-grading:update-manual-score',
      )
      await expect(submitElearningManualGrade(db, {
        orgId: fixture.orgId,
        actorId: `${NS}-grader-rollback`,
        isGlobalAdmin: true,
        attemptId: fixture.attemptId,
        questionRevisionId: fixture.shortRevisionIds[0],
        requestId: randomUUID(),
        score: 4,
        comment: null,
      })).rejects.toMatchObject({ code: 'unavailable' })

      const attempt = await client.query(
        `SELECT status, manual_score::text, total_score, passed
           FROM elearning_exam_attempts
          WHERE org_id = $1 AND id = $2`,
        [fixture.orgId, fixture.attemptId],
      )
      expect(attempt.rows).toEqual([{
        status: 'awaiting_manual',
        manual_score: '0',
        total_score: null,
        passed: null,
      }])
      const ledger = await client.query(
        `SELECT kind, count(*)::integer AS count
           FROM elearning_grading_records
          WHERE org_id = $1 AND attempt_id = $2
          GROUP BY kind`,
        [fixture.orgId, fixture.attemptId],
      )
      expect(ledger.rows).toEqual([{ kind: 'auto', count: 1 }])
    })
  })
})
