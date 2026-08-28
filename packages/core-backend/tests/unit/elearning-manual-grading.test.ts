import { describe, expect, test } from 'vitest'

import {
  submitElearningManualGrade,
  type ElearningManualGradingDb,
  type ElearningManualGradingQueryable,
} from '../../src/services/elearning-manual-grading'

const ORG = 'org-manual-service-1'
const ACTOR = 'actor-manual-service-1'
const LEARNER = 'learner-manual-service-1'
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111'
const EXAM_ID = '22222222-2222-4222-8222-222222222222'
const QUESTION_ID = '33333333-3333-4333-8333-333333333333'
const REVISION_ID = '44444444-4444-4444-8444-444444444444'
const REQUEST_ID = '55555555-5555-4555-8555-555555555555'
const GRADED_AT = new Date('2026-08-29T02:03:04.000Z')
const INCENTIVE_ON: NodeJS.ProcessEnv = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_INCENTIVE_ENABLED: 'true',
}

const SNAPSHOT = {
  domain: 'elearning.exam.paper.v1',
  version: 2,
  examId: EXAM_ID,
  passScore: 2,
  questions: [{
    position: 1,
    questionRevisionId: REVISION_ID,
    questionId: QUESTION_ID,
    questionType: 'short_answer',
    prompt: 'Explain',
    options: [],
    points: 4,
    answerKey: {},
    explanation: null,
  }],
}

function scopedDb(
  scopeCount: string,
  coveredCount: string,
  attemptStatus = 'awaiting_manual',
) {
  const sqls: string[] = []
  const query: ElearningManualGradingQueryable['query'] = async (sql) => {
    sqls.push(sql)
    if (sql.includes('elearning-manual-grading:scope-lock')) {
      return { rows: [{}], rowCount: 1 }
    }
    if (sql.includes('elearning-manual-grading:lock-attempt')) {
      return {
        rows: [{
          id: ATTEMPT_ID,
          user_id: LEARNER,
          status: attemptStatus,
          paper_snapshot: SNAPSHOT,
          auto_score: '0',
          manual_score: '0',
          total_score: null,
          passed: null,
        }],
        rowCount: 1,
      }
    }
    if (sql.includes('elearning-admin-access:user-scope')) {
      return {
        rows: [{
          scope_count: scopeCount,
          target_count: '1',
          covered_count: coveredCount,
        }],
        rowCount: 1,
      }
    }
    throw new Error('unexpected query')
  }
  const db: ElearningManualGradingDb = {
    query,
    transaction: async (handler) => handler({ query }),
  }
  return { db, sqls }
}

function finalGradeDb() {
  const sqls: string[] = []
  const query: ElearningManualGradingQueryable['query'] = async (sql) => {
    sqls.push(sql)
    if (sql.includes('elearning-manual-grading:lock-attempt')) {
      return {
        rows: [{
          id: ATTEMPT_ID,
          user_id: LEARNER,
          status: 'awaiting_manual',
          paper_snapshot: SNAPSHOT,
          auto_score: '0',
          manual_score: '0',
          total_score: null,
          passed: null,
        }],
        rowCount: 1,
      }
    }
    if (sql.includes('elearning-manual-grading:load-auto-ledger')) {
      return {
        rows: [{ score: '0', max_score: '0', seq: 1, grader_id: 'system:auto' }],
        rowCount: 1,
      }
    }
    if (sql.includes('elearning-manual-grading:load-ledger')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('elearning-manual-grading:append-grade')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('elearning-manual-grading:finalize-attempt')) {
      return { rows: [{ graded_at: GRADED_AT }], rowCount: 1 }
    }
    throw new Error('unexpected query')
  }
  const db: ElearningManualGradingDb = {
    query,
    transaction: async (handler) => handler({ query }),
  }
  return { db, sqls }
}

describe('e-learning manual-grading management scope', () => {
  test.each([
    ['0', '0', 'scope_required'],
    ['1', '0', 'target_out_of_scope'],
  ] as const)('fails before reading or appending the grade ledger', async (
    scopeCount,
    coveredCount,
    code,
  ) => {
    const { db, sqls } = scopedDb(scopeCount, coveredCount)
    await expect(submitElearningManualGrade(db, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      attemptId: ATTEMPT_ID,
      questionRevisionId: REVISION_ID,
      requestId: REQUEST_ID,
      score: 2,
      comment: null,
    })).rejects.toMatchObject({ code })
    expect(sqls).toHaveLength(3)
    expect(sqls[0]).toContain('elearning-manual-grading:scope-lock')
    expect(sqls[1]).toContain('elearning-manual-grading:lock-attempt')
    expect(sqls[2]).toContain('elearning-admin-access:user-scope')
    expect(sqls.join('\n')).not.toContain('load-ledger')
    expect(sqls.join('\n')).not.toContain('append-grade')
  })

  test('checks management scope before exposing attempt state', async () => {
    const { db, sqls } = scopedDb('1', '0', 'started')
    await expect(submitElearningManualGrade(db, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: false,
      attemptId: ATTEMPT_ID,
      questionRevisionId: REVISION_ID,
      requestId: REQUEST_ID,
      score: 2,
      comment: null,
    })).rejects.toMatchObject({ code: 'target_out_of_scope' })
    expect(sqls).toHaveLength(3)
    expect(sqls[0]).toContain('elearning-manual-grading:scope-lock')
    expect(sqls[1]).toContain('elearning-manual-grading:lock-attempt')
    expect(sqls[2]).toContain('elearning-admin-access:user-scope')
  })
})

describe('e-learning manual-grading pass credit', () => {
  test('awards only the final passing grade from the locked learner and DB time', async () => {
    const passed = finalGradeDb()
    const awards: unknown[] = []
    await expect(submitElearningManualGrade(passed.db, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: true,
      attemptId: ATTEMPT_ID,
      questionRevisionId: REVISION_ID,
      requestId: REQUEST_ID,
      score: 2,
      comment: null,
    }, {
      env: INCENTIVE_ON,
      awardPassExam: async (_tx, input, env) => {
        awards.push({ input, env })
        return null
      },
    })).resolves.toMatchObject({ status: 'graded', passed: true })
    expect(awards).toEqual([{
      input: {
        attemptId: ATTEMPT_ID,
        gradedAt: GRADED_AT,
        orgId: ORG,
        userId: LEARNER,
      },
      env: INCENTIVE_ON,
    }])

    const failed = finalGradeDb()
    awards.length = 0
    await expect(submitElearningManualGrade(failed.db, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: true,
      attemptId: ATTEMPT_ID,
      questionRevisionId: REVISION_ID,
      requestId: REQUEST_ID,
      score: 0,
      comment: null,
    }, {
      env: INCENTIVE_ON,
      awardPassExam: async (_tx, input, env) => {
        awards.push({ input, env })
        return null
      },
    })).resolves.toMatchObject({ status: 'graded', passed: false })
    expect(awards).toEqual([])
  })

  test('maps credit authority failure to the closed unavailable result', async () => {
    const { db } = finalGradeDb()
    await expect(submitElearningManualGrade(db, {
      orgId: ORG,
      actorId: ACTOR,
      isGlobalAdmin: true,
      attemptId: ATTEMPT_ID,
      questionRevisionId: REVISION_ID,
      requestId: REQUEST_ID,
      score: 2,
      comment: null,
    }, {
      env: INCENTIVE_ON,
      awardPassExam: async () => {
        throw new Error('credit authority failed')
      },
    })).rejects.toMatchObject({ code: 'unavailable' })
  })
})
