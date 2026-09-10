import { describe, expect, test } from 'vitest'

import { elearningAdminScopeLockKey } from '../../src/services/elearning-admin-access'
import {
  getElearningManualGradingDetail,
  listElearningManualGradingQueue,
  type ElearningManualGradingReadDb,
  type ElearningManualGradingReadQueryable,
} from '../../src/services/elearning-manual-grading-read'

const ORG = 'org-manual-read-1'
const ACTOR = 'actor-manual-read-1'
const LEARNER = 'learner-manual-read-1'
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111'
const EXAM_ID = '22222222-2222-4222-8222-222222222222'
const COURSE_ID = '33333333-3333-4333-8333-333333333333'
const OBJECTIVE_ID = '44444444-4444-4444-8444-444444444444'
const SHORT_ID = '55555555-5555-4555-8555-555555555555'

const SNAPSHOT = {
  domain: 'elearning.exam.paper.v1',
  version: 2,
  examId: EXAM_ID,
  passScore: 6,
  questions: [
    {
      position: 1,
      questionRevisionId: OBJECTIVE_ID,
      questionId: '66666666-6666-4666-8666-666666666666',
      questionType: 'single_choice',
      prompt: 'Secret objective prompt',
      options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
      points: 5,
      answerKey: { correct: ['a'] },
      explanation: 'Secret explanation',
    },
    {
      position: 2,
      questionRevisionId: SHORT_ID,
      questionId: '77777777-7777-4777-8777-777777777777',
      questionType: 'short_answer',
      prompt: 'Explain safely',
      options: [],
      points: 4,
      answerKey: {},
      explanation: 'Private rubric',
    },
  ],
}

const BASE_ROW = {
  id: ATTEMPT_ID,
  user_id: LEARNER,
  exam_id: EXAM_ID,
  attempt_no: 1,
  submitted_at: new Date('2026-08-27T01:00:00.000Z'),
  paper_snapshot: SNAPSHOT,
  auto_score: '5',
  manual_score: '3',
  exam_title: 'Safety exam',
  course_id: COURSE_ID,
  course_title: 'Safety course v1',
}

function scriptedDb(
  handler: (
    sql: string,
    params: unknown[] | undefined,
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>,
) {
  const calls: Array<{
    sql: string
    params: unknown[] | undefined
    inTransaction: boolean
  }> = []
  const directQuery: ElearningManualGradingReadQueryable['query'] = async (
    sql,
    params,
  ) => {
    calls.push({ sql, params, inTransaction: false })
    return handler(sql, params)
  }
  const db: ElearningManualGradingReadDb = {
    query: directQuery,
    transaction: async (run) => run({
      query: async (sql, params) => {
        calls.push({ sql, params, inTransaction: true })
        return handler(sql, params)
      },
    }),
  }
  return { db, calls }
}

describe('e-learning manual-grading read service', () => {
  test('lists only the closed queue summary in one set-based query', async () => {
    const { db, calls } = scriptedDb(async (sql) => {
      if (!sql.includes('FROM elearning_exam_attempts a')) {
        throw new Error('unexpected query')
      }
      return {
        rows: [{
          ...BASE_ROW,
          grade_row_count: '1',
          graded_question_count: '1',
          ledger_manual_score: '3',
          regrade_row_count: '0',
          auto_row_count: '1',
          ledger_auto_score: '5',
          ledger_auto_max_score: '5',
          auto_seq: 1,
          auto_grader_id: 'system:auto',
        }],
        rowCount: 1,
      }
    })
    const result = await listElearningManualGradingQueue(db, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: true,
      page: 1,
      pageSize: 20,
    })
    expect(result).toEqual({
      items: [{
        attemptId: ATTEMPT_ID,
        userId: LEARNER,
        examId: EXAM_ID,
        examTitle: 'Safety exam',
        courseId: COURSE_ID,
        courseTitle: 'Safety course v1',
        attemptNo: 1,
        submittedAt: '2026-08-27T01:00:00.000Z',
        autoScore: 5,
        manualScore: 3,
        paperMaxScore: 9,
        gradedQuestions: 1,
        manualQuestions: 1,
      }],
      page: 1,
      pageSize: 20,
      hasMore: false,
    })
    expect(calls).toHaveLength(1)
    expect(calls.every((call) => call.inTransaction)).toBe(true)
    expect(calls[0]?.params).toEqual([ORG, null, 21, 0])
    expect(calls[0]?.sql).toContain("a.status = 'awaiting_manual'")
    expect(calls[0]?.sql).toContain("FILTER (WHERE g.kind = 'manual')")
    expect(JSON.stringify(result)).not.toContain('Secret objective prompt')
    expect(JSON.stringify(result)).not.toContain('answerKey')
  })

  test('returns only short-answer detail and deterministic current grades', async () => {
    const { db, calls } = scriptedDb(async (sql) => {
      if (sql.includes('elearning-manual-grading-read:detail-grades')) {
        return {
          rows: [
            {
              kind: 'auto',
              question_revision_id: null,
              score: '5',
              max_score: '5',
              seq: 1,
              details: {},
              grader_id: 'system:auto',
              created_at: new Date('2026-08-27T01:05:00.000Z'),
            },
            {
              kind: 'manual',
              question_revision_id: SHORT_ID,
              score: '3',
              max_score: '4',
              seq: 2,
              details: {
                domain: 'elearning.manual-grade.v1',
                version: 1,
                comment: 'Good structure',
              },
              grader_id: ACTOR,
              created_at: new Date('2026-08-27T01:10:00.000Z'),
            },
          ],
          rowCount: 2,
        }
      }
      if (sql.includes('FROM elearning_exam_attempts a')) {
        return {
          rows: [{
            ...BASE_ROW,
            status: 'awaiting_manual',
            answers: {
              [OBJECTIVE_ID]: ['a'],
              [SHORT_ID]: 'Learner explanation',
            },
            total_score: null,
            passed: null,
          }],
          rowCount: 1,
        }
      }
      throw new Error('unexpected query')
    })
    const result = await getElearningManualGradingDetail(db, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: true,
      attemptId: ATTEMPT_ID,
    })
    expect(result).toEqual({
      attemptId: ATTEMPT_ID,
      userId: LEARNER,
      examId: EXAM_ID,
      examTitle: 'Safety exam',
      courseId: COURSE_ID,
      courseTitle: 'Safety course v1',
      attemptNo: 1,
      status: 'awaiting_manual',
      submittedAt: '2026-08-27T01:00:00.000Z',
      autoScore: 5,
      manualScore: 3,
      paperMaxScore: 9,
      passScore: 6,
      gradedQuestions: 1,
      manualQuestions: 1,
      questions: [{
        questionRevisionId: SHORT_ID,
        position: 2,
        prompt: 'Explain safely',
        points: 4,
        learnerAnswer: 'Learner explanation',
        grade: {
          score: 3,
          maxScore: 4,
          comment: 'Good structure',
          graderId: ACTOR,
          gradedAt: '2026-08-27T01:10:00.000Z',
        },
      }],
    })
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.inTransaction)).toBe(true)
    expect(calls[0]?.sql).toContain('FOR SHARE OF a')
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('Secret objective prompt')
    expect(serialized).not.toContain('Secret explanation')
    expect(serialized).not.toContain('Private rubric')
    expect(serialized).not.toContain('answerKey')
    expect(serialized).not.toContain('requestId')
  })

  test.each([
    ['regrade ledger', { regrade_row_count: '1' }],
    ['missing automatic ledger', { auto_row_count: '0', ledger_auto_score: null }],
    ['duplicate manual grades', { grade_row_count: '2' }],
  ])('fails closed on %s corruption in queue rows', async (_label, override) => {
    const { db } = scriptedDb(async () => ({
      rows: [{
        ...BASE_ROW,
        grade_row_count: '1',
        graded_question_count: '1',
        ledger_manual_score: '3',
        regrade_row_count: '0',
        auto_row_count: '1',
        ledger_auto_score: '5',
        ledger_auto_max_score: '5',
        auto_seq: 1,
        auto_grader_id: 'system:auto',
        ...override,
      }],
      rowCount: 1,
    }))
    await expect(listElearningManualGradingQueue(db, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: true,
    })).rejects.toMatchObject({ code: 'unavailable' })
  })

  test('fails closed before queue SQL when delegated actor has no active scope', async () => {
    const { db, calls } = scriptedDb(async (sql) => {
      if (sql.includes('scope-lock')) return { rows: [{}], rowCount: 1 }
      if (sql.includes('active-scope-count')) {
        return { rows: [{ scope_count: '0' }], rowCount: 1 }
      }
      throw new Error('queue query must not run')
    })
    await expect(listElearningManualGradingQueue(db, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
    })).rejects.toMatchObject({ code: 'scope_required' })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.sql).toContain('scope-lock')
    expect(calls[0]?.sql).toContain('pg_advisory_xact_lock_shared')
    expect(calls[0]?.params).toEqual([
      elearningAdminScopeLockKey(ORG, ACTOR),
    ])
    expect(calls[1]?.sql).toContain('active-scope-count')
  })

  test('scope-filters detail in SQL and hides out-of-scope existence', async () => {
    const { db, calls } = scriptedDb(async (sql) => {
      if (sql.includes('scope-lock')) return { rows: [{}], rowCount: 1 }
      if (sql.includes('active-scope-count')) {
        return { rows: [{ scope_count: '1' }], rowCount: 1 }
      }
      if (sql.includes('FROM elearning_exam_attempts a')) {
        return { rows: [], rowCount: 0 }
      }
      throw new Error('unexpected query')
    })
    await expect(getElearningManualGradingDetail(db, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      attemptId: ATTEMPT_ID,
    })).rejects.toMatchObject({ code: 'not_found' })
    expect(calls).toHaveLength(3)
    expect(calls[2]?.params).toEqual([ORG, ACTOR, ATTEMPT_ID])
    expect(calls[2]?.sql).toContain('JOIN directory_account_departments')
    expect(calls[2]?.sql).toContain('platform_user.id = a.user_id')
  })

  test('rejects regrade rows instead of silently selecting a stale grade', async () => {
    const { db } = scriptedDb(async (sql) => {
      if (sql.includes('detail-grades')) {
        return {
          rows: [
            {
              kind: 'auto',
              question_revision_id: null,
              score: '5',
              max_score: '5',
              seq: 1,
              details: {},
              grader_id: 'system:auto',
              created_at: new Date(),
            },
            {
              kind: 'regrade',
              question_revision_id: SHORT_ID,
              score: '3',
              max_score: '4',
              seq: 2,
              details: {},
              grader_id: ACTOR,
              created_at: new Date(),
            },
          ],
          rowCount: 2,
        }
      }
      return {
        rows: [{
          ...BASE_ROW,
          status: 'awaiting_manual',
          answers: { [OBJECTIVE_ID]: ['a'], [SHORT_ID]: 'Answer' },
          total_score: null,
          passed: null,
        }],
        rowCount: 1,
      }
    })
    await expect(getElearningManualGradingDetail(db, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: true,
      attemptId: ATTEMPT_ID,
    })).rejects.toMatchObject({ code: 'unavailable' })
  })

  test('rejects duplicate manual grades for one question', async () => {
    const manualRow = {
      kind: 'manual',
      question_revision_id: SHORT_ID,
      score: '3',
      max_score: '4',
      seq: 2,
      details: {
        domain: 'elearning.manual-grade.v1',
        version: 1,
        comment: null,
      },
      grader_id: ACTOR,
      created_at: new Date(),
    }
    const { db } = scriptedDb(async (sql) => {
      if (sql.includes('detail-grades')) {
        return {
          rows: [
            {
              kind: 'auto',
              question_revision_id: null,
              score: '5',
              max_score: '5',
              seq: 1,
              details: {},
              grader_id: 'system:auto',
              created_at: new Date(),
            },
            manualRow,
            { ...manualRow, seq: 3 },
          ],
          rowCount: 3,
        }
      }
      return {
        rows: [{
          ...BASE_ROW,
          status: 'awaiting_manual',
          answers: { [OBJECTIVE_ID]: ['a'], [SHORT_ID]: 'Answer' },
          total_score: null,
          passed: null,
        }],
        rowCount: 1,
      }
    })
    await expect(getElearningManualGradingDetail(db, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: true,
      attemptId: ATTEMPT_ID,
    })).rejects.toMatchObject({ code: 'unavailable' })
  })
})
