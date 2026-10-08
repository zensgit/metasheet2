import { describe, expect, it } from 'vitest'

import {
  getElearningExamReview,
  type ElearningExamReviewQueryable,
} from '../../src/services/elearning-exam-review'
import {
  ELEARNING_EXAM_PAPER_DOMAIN,
  ELEARNING_EXAM_PAPER_VERSION,
  ELEARNING_EXAM_PAPER_VERSION_MIXED,
  ElearningExamError,
  type ElearningPaperSnapshot,
} from '../../src/services/elearning-exam'

const ORG = 'org-review'
const USER = 'user-review'
const OTHER_USER = 'user-other'
const ATTEMPT = '11111111-1111-4111-8111-111111111111'
const EXAM = '22222222-2222-4222-8222-222222222222'
const Q1 = '33333333-3333-4333-8333-333333333333'
const Q2 = '44444444-4444-4444-8444-444444444444'
const Q3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const QUESTION_1 = '55555555-5555-4555-8555-555555555555'
const QUESTION_2 = '66666666-6666-4666-8666-666666666666'
const QUESTION_3 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const COURSE = '77777777-7777-4777-8777-777777777777'
const VERSION = '88888888-8888-4888-8888-888888888888'
const MEMBER = '99999999-9999-4999-8999-999999999999'

function paper(): ElearningPaperSnapshot {
  return {
    domain: ELEARNING_EXAM_PAPER_DOMAIN,
    version: ELEARNING_EXAM_PAPER_VERSION,
    examId: EXAM,
    passScore: 10,
    questions: [
      {
        position: 1,
        questionRevisionId: Q1,
        questionId: QUESTION_1,
        questionType: 'single_choice',
        prompt: 'Pick one',
        options: [
          { id: 'a', text: 'alpha' },
          { id: 'b', text: 'beta' },
        ],
        points: 10,
        answerKey: { correct: ['a'] },
        explanation: 'secret one',
      },
      {
        position: 2,
        questionRevisionId: Q2,
        questionId: QUESTION_2,
        questionType: 'multiple_choice',
        prompt: 'Pick several',
        options: [
          { id: 'a', text: 'alpha' },
          { id: 'b', text: 'beta' },
          { id: 'c', text: 'gamma' },
        ],
        points: 10,
        answerKey: { correct: ['a', 'c'] },
        explanation: 'secret two',
      },
    ],
  }
}

function mixedPaper(): ElearningPaperSnapshot {
  return {
    ...paper(),
    version: ELEARNING_EXAM_PAPER_VERSION_MIXED,
    questions: [
      ...paper().questions,
      {
        position: 3,
        questionRevisionId: Q3,
        questionId: QUESTION_3,
        questionType: 'short_answer',
        prompt: 'Explain briefly',
        options: [],
        points: 10,
        answerKey: {},
        explanation: null,
      },
    ],
  }
}

function storedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ATTEMPT,
    attempt_no: 2,
    status: 'graded',
    paper_snapshot: paper(),
    answers: { [Q1]: ['b'], [Q2]: ['c', 'a'] },
    auto_score: 10,
    total_score: 20,
    passed: true,
    course_version_id: VERSION,
    disclosure_policy: 'correctness_after_submit',
    window_ends_at: null,
    exam_status: 'published',
    version_status: 'retired',
    course_status: 'archived',
    server_now: new Date('2026-08-26T10:00:00.000Z'),
    ...over,
  }
}

function dbWithRows(
  rows: Array<Record<string, unknown>>,
  options: { assignmentRows?: Array<Record<string, unknown>> } = {},
) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const db: ElearningExamReviewQueryable = {
    query: async (sql, params = []) => {
      calls.push({ sql, params })
      if (sql.includes('elearning-exam-review:load')) {
        if (params[0] !== ORG || params[1] !== ATTEMPT || params[2] !== USER) {
          return { rows: [], rowCount: 0 }
        }
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('elearning-access:lock-course')) {
        const row = rows[0]
        if (!row || params[0] !== ORG || params[1] !== VERSION) {
          return { rows: [], rowCount: 0 }
        }
        return {
          rows: [{
            course_id: COURSE,
            course_status: row.course_status,
            active_version_id: VERSION,
            scope_id: null,
            version_status: row.version_status,
          }],
          rowCount: 1,
        }
      }
      if (sql.includes('elearning-access:lock-assignment')) {
        if (params[0] !== ORG || params[1] !== USER || params[2] !== VERSION) {
          return { rows: [], rowCount: 0 }
        }
        const assignmentRows = options.assignmentRows ?? [{ id: MEMBER }]
        return { rows: assignmentRows, rowCount: assignmentRows.length }
      }
      throw new Error('unexpected query')
    },
  }
  return { db, calls }
}

async function expectCode(
  run: () => Promise<unknown>,
  code: ConstructorParameters<typeof ElearningExamError>[0],
): Promise<void> {
  try {
    await run()
    throw new Error('expected failure')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningExamError)
    expect((error as ElearningExamError).code).toBe(code)
    expect((error as Error).message).toBe(code)
  }
}

describe('getElearningExamReview', () => {
  it('returns an exact closed all-question DTO without answer keys or explanations', async () => {
    const { db, calls } = dbWithRows([storedRow()])
    const result = await getElearningExamReview(db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT.toUpperCase(),
    })

    expect(result).toEqual({
      attemptId: ATTEMPT,
      attemptNo: 2,
      status: 'graded',
      disclosurePolicy: 'correctness_after_submit',
      autoScore: 10,
      totalScore: 20,
      passed: true,
      questions: [
        {
          position: 1,
          questionRevisionId: Q1,
          questionType: 'single_choice',
          prompt: 'Pick one',
          options: [
            { id: 'a', text: 'alpha' },
            { id: 'b', text: 'beta' },
          ],
          points: 10,
          selected: ['b'],
          correct: false,
          awarded: 0,
        },
        {
          position: 2,
          questionRevisionId: Q2,
          questionType: 'multiple_choice',
          prompt: 'Pick several',
          options: [
            { id: 'a', text: 'alpha' },
            { id: 'b', text: 'beta' },
            { id: 'c', text: 'gamma' },
          ],
          points: 10,
          selected: ['a', 'c'],
          correct: true,
          awarded: 10,
        },
      ],
    })
    expect(calls).toHaveLength(3)
    expect(calls[0]?.params).toEqual([ORG, ATTEMPT, USER])
    const raw = JSON.stringify(result)
    expect(raw).not.toMatch(/answerKey|answer_key|correctOptionIds|explanation|examId|passScore/)
  })

  it('returns only incorrect questions for wrong_items_after_submit', async () => {
    const { db } = dbWithRows([storedRow({
      disclosure_policy: 'wrong_items_after_submit',
    })])
    const result = await getElearningExamReview(db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
    })
    expect(result.questions).toHaveLength(1)
    expect(result.questions[0]).toMatchObject({
      questionRevisionId: Q1,
      selected: ['b'],
      correct: false,
      awarded: 0,
    })
  })

  it('uses the database clock for correctness_after_window and opens exactly at the boundary', async () => {
    const before = dbWithRows([storedRow({
      disclosure_policy: 'correctness_after_window',
      window_ends_at: new Date('2026-08-26T10:00:01.000Z'),
    })]).db
    await expectCode(() => getElearningExamReview(before, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
    }), 'review_unavailable')

    const boundary = dbWithRows([storedRow({
      disclosure_policy: 'correctness_after_window',
      window_ends_at: new Date('2026-08-26T10:00:00.000Z'),
    })]).db
    const result = await getElearningExamReview(boundary, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
    })
    expect(result.disclosurePolicy).toBe('correctness_after_window')
    expect(result.questions).toHaveLength(2)
  })

  it('never releases no_review and refuses unfinished attempts', async () => {
    for (const row of [
      storedRow({ disclosure_policy: 'no_review' }),
      storedRow({ status: 'started' }),
      storedRow({ status: 'submitted' }),
    ]) {
      const { db } = dbWithRows([row])
      await expectCode(() => getElearningExamReview(db, {
        orgId: ORG,
        userId: USER,
        attemptId: ATTEMPT,
      }), 'review_unavailable')
    }
  })

  it('keeps mixed-paper review closed until the manual-disclosure contract exists', async () => {
    const { db } = dbWithRows([storedRow({
      paper_snapshot: mixedPaper(),
      answers: { [Q1]: ['b'], [Q2]: ['c', 'a'], [Q3]: 'manual answer' },
      total_score: 30,
    })])
    await expectCode(() => getElearningExamReview(db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
    }), 'review_unavailable')
  })

  it('hides cross-user and cross-org attempts behind not_found', async () => {
    const { db } = dbWithRows([storedRow()])
    await expectCode(() => getElearningExamReview(db, {
      orgId: ORG,
      userId: OTHER_USER,
      attemptId: ATTEMPT,
    }), 'not_found')
    await expectCode(() => getElearningExamReview(db, {
      orgId: 'org-other',
      userId: USER,
      attemptId: ATTEMPT,
    }), 'not_found')
  })

  it('blocks withdrawn course content but allows archived history', async () => {
    const withdrawn = dbWithRows([storedRow({ course_status: 'withdrawn' })]).db
    await expectCode(() => getElearningExamReview(withdrawn, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
    }), 'course_withdrawn')

    const archived = dbWithRows([storedRow({ course_status: 'archived' })]).db
    await expect(getElearningExamReview(archived, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
    })).resolves.toMatchObject({ status: 'graded' })

    const revoked = dbWithRows(
      [storedRow({ course_status: 'archived' })],
      { assignmentRows: [] },
    ).db
    await expectCode(() => getElearningExamReview(revoked, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
    }), 'assignment_unavailable')
  })

  it('fails closed on malformed policy, window, duplicate rows, or grade drift', async () => {
    for (const rows of [
      [storedRow({ disclosure_policy: 'surprise' })],
      [storedRow({ disclosure_policy: 'correctness_after_window', window_ends_at: null })],
      [storedRow(), storedRow()],
      [storedRow({ auto_score: 20 })],
      [storedRow({ paper_snapshot: { broken: true } })],
    ]) {
      const { db } = dbWithRows(rows)
      await expectCode(() => getElearningExamReview(db, {
        orgId: ORG,
        userId: USER,
        attemptId: ATTEMPT,
      }), 'unavailable')
    }
  })

  it('rejects invalid input before querying', async () => {
    const { db, calls } = dbWithRows([storedRow()])
    await expectCode(() => getElearningExamReview(db, {
      orgId: '',
      userId: USER,
      attemptId: ATTEMPT,
    }), 'invalid_input')
    await expectCode(() => getElearningExamReview(db, {
      orgId: ORG,
      userId: USER,
      attemptId: 'not-a-uuid',
    }), 'invalid_input')
    expect(calls).toHaveLength(0)
  })
})
