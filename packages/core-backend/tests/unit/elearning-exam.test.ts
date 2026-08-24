import { describe, expect, it } from 'vitest'
import {
  ELEARNING_EXAM_AUTO_GRADER,
  ELEARNING_EXAM_GRADE_KIND,
  ELEARNING_EXAM_PAPER_DOMAIN,
  ELEARNING_EXAM_PAPER_VERSION,
  canonicalizeElearningExamAnswers,
  elearningExamLockKey,
  ElearningExamError,
  redactElearningPaperSnapshot,
  scoreElearningExam,
  startElearningExam,
  stripElearningExamSecrets,
  submitElearningExam,
  validateElearningObjectiveQuestion,
  validateElearningPaperSnapshot,
  type ElearningExamDb,
  type ElearningExamQueryable,
  type ElearningPaperSnapshot,
} from '../../src/services/elearning-exam'

const ORG = 'org-exam-1'
const USER = 'user-exam-1'
const ITEM = '11111111-1111-4111-8111-111111111111'
const ATTEMPT = '22222222-2222-4222-8222-222222222222'
const EXAM = '33333333-3333-4333-8333-333333333333'
const Q1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const Q2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const Q3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const QUESTION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const QUESTION_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const QUESTION_C = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const VERSION = '44444444-4444-4444-8444-444444444444'
const MEMBER = '55555555-5555-4555-8555-555555555555'

const PUBLIC_SUBMIT_KEYS = [
  'attemptId',
  'attemptNo',
  'status',
  'autoScore',
  'totalScore',
  'passed',
  'duplicate',
] as const

function sampleQuestion(over: Record<string, unknown> = {}) {
  return {
    position: 1,
    questionRevisionId: Q1,
    questionId: QUESTION,
    questionType: 'single_choice',
    prompt: 'Pick one',
    options: [
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'beta' },
    ],
    points: 10,
    answerKey: { correct: ['a'] },
    explanation: 'secret rationale',
    ...over,
  }
}

function samplePaper(over: Partial<ElearningPaperSnapshot> = {}): ElearningPaperSnapshot {
  return validateElearningPaperSnapshot({
    domain: ELEARNING_EXAM_PAPER_DOMAIN,
    version: ELEARNING_EXAM_PAPER_VERSION,
    examId: EXAM,
    passScore: 20,
    questions: [
      sampleQuestion(),
      sampleQuestion({
        position: 2,
        questionRevisionId: Q2,
        questionId: QUESTION_B,
        questionType: 'multiple_choice',
        prompt: 'Pick several',
        options: [
          { id: 'a', text: 'alpha' },
          { id: 'b', text: 'beta' },
          { id: 'c', text: 'gamma' },
        ],
        points: 10,
        answerKey: { correct: ['a', 'c'] },
        explanation: 'multi secret',
      }),
      sampleQuestion({
        position: 3,
        questionRevisionId: Q3,
        questionId: QUESTION_C,
        questionType: 'true_false',
        prompt: 'Is this true',
        options: [
          { id: 't', text: 'true' },
          { id: 'f', text: 'false' },
        ],
        points: 10,
        answerKey: { correct: ['t'] },
        explanation: 'tf secret',
      }),
    ],
    ...over,
  })
}

function assertValuesFree(error: unknown): void {
  expect(error).toBeInstanceOf(ElearningExamError)
  const err = error as ElearningExamError
  const blob = `${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err)}`
  expect(blob).not.toContain(ORG)
  expect(blob).not.toContain(USER)
  expect(blob).not.toContain('answer_key')
  expect(blob).not.toContain('answerKey')
  expect(blob).not.toContain('explanation')
  expect(blob).not.toMatch(/"correct"/)
  expect(err.message).toBe(err.code)
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect((error as ElearningExamError).code).toBe(code)
    assertValuesFree(error)
  }
}

async function expectAsyncCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect((error as ElearningExamError).code).toBe(code)
    assertValuesFree(error)
  }
}

function createMemoryDb(): ElearningExamDb {
  const query: ElearningExamQueryable['query'] = async () => {
    throw new Error('memory db should not be queried for identifier validation')
  }
  return {
    query,
    transaction: async (handler) => handler({ query }),
  }
}

function assertPublicSubmitJson(payload: unknown): Record<string, unknown> {
  const raw = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
  expect(Object.keys(raw)).toEqual([...PUBLIC_SUBMIT_KEYS])
  expect(raw.status).toBe('graded')
  const blob = JSON.stringify(raw)
  expect(blob).not.toContain('answers')
  expect(blob).not.toContain('questions')
  expect(blob).not.toContain('awarded')
  expect(blob).not.toContain('selected')
  expect(blob).not.toContain('answer_key')
  expect(blob).not.toContain('answerKey')
  expect(blob).not.toContain('explanation')
  expect(blob).not.toMatch(/"correct"/)
  return raw
}

function examQueryTag(sql: string): string | null {
  const match = /\/\* (elearning-exam:[a-z-]+) \*\//.exec(sql)
  return match ? match[1] : null
}

interface SubmitMemAttempt {
  id: string
  examId: string
  versionId: string
  userId: string
  attemptNo: number
  status: string
  paperSnapshot: ElearningPaperSnapshot
  answers: Record<string, string[]> | null
  autoScore: number | null
  totalScore: number | null
  passed: boolean | null
}

interface SubmitMem {
  attempt: SubmitMemAttempt
  memberId: string | null
  grades: Array<{ details: unknown; score: unknown; maxScore: unknown }>
  lockKeys: string[]
}

function createSubmitMemoryDb(seed: Partial<SubmitMemAttempt> = {}): {
  db: ElearningExamDb
  mem: SubmitMem
} {
  const snapshot = samplePaper()
  const mem: SubmitMem = {
    attempt: {
      id: ATTEMPT,
      examId: EXAM,
      versionId: VERSION,
      userId: USER,
      attemptNo: 1,
      status: 'started',
      paperSnapshot: snapshot,
      answers: null,
      autoScore: null,
      totalScore: null,
      passed: null,
      ...seed,
    },
    memberId: MEMBER,
    grades: [],
    lockKeys: [],
  }
  const query: ElearningExamQueryable['query'] = async (sql, params = []) => {
    const tag = examQueryTag(sql)
    const attempt = mem.attempt
    if (tag === 'elearning-exam:peek-attempt') {
      if (params[0] !== ORG || params[1] !== attempt.id) return { rows: [], rowCount: 0 }
      return { rows: [{ user_id: attempt.userId, exam_id: attempt.examId }], rowCount: 1 }
    }
    if (tag === 'elearning-exam:lock') {
      mem.lockKeys.push(String(params[0]))
      return { rows: [{}], rowCount: 1 }
    }
    if (tag === 'elearning-exam:lock-attempt') {
      if (params[0] !== ORG || params[1] !== attempt.id) return { rows: [], rowCount: 0 }
      return {
        rows: [{
          id: attempt.id,
          attempt_no: attempt.attemptNo,
          status: attempt.status,
          course_version_id: attempt.versionId,
          exam_id: attempt.examId,
          paper_snapshot: attempt.paperSnapshot,
          answers: attempt.answers,
          auto_score: attempt.autoScore,
          total_score: attempt.totalScore,
          passed: attempt.passed,
          user_id: attempt.userId,
          course_status: 'active',
          version_status: 'published',
          exam_status: 'published',
        }],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-exam:load-member') {
      if (
        mem.memberId
        && params[0] === ORG
        && params[1] === USER
        && params[2] === attempt.versionId
      ) {
        return { rows: [{ id: mem.memberId }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (tag === 'elearning-exam:submit-attempt') {
      if (params[1] !== ORG || params[2] !== attempt.id || attempt.status !== 'started') {
        return { rows: [], rowCount: 0 }
      }
      attempt.answers = JSON.parse(String(params[0])) as Record<string, string[]>
      attempt.status = 'submitted'
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-exam:insert-grade') {
      mem.grades.push({
        details: JSON.parse(String(params[5])),
        score: params[3],
        maxScore: params[4],
      })
      return { rows: [], rowCount: 1 }
    }
    if (tag === 'elearning-exam:grade-attempt') {
      if (params[3] !== ORG || params[4] !== attempt.id || attempt.status !== 'submitted') {
        return { rows: [], rowCount: 0 }
      }
      attempt.autoScore = params[0] as number
      attempt.totalScore = params[1] as number
      attempt.passed = params[2] as boolean
      attempt.status = 'graded'
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected exam query: ${tag ?? sql}`)
  }
  return {
    db: {
      query,
      transaction: async (handler) => handler({ query }),
    },
    mem,
  }
}

function perfectAnswers() {
  return {
    [Q1]: ['a'],
    [Q2]: ['c', 'a'],
    [Q3]: ['t'],
  }
}

describe('elearning exam lock and paper contract', () => {
  it('names the advisory lock from org, user, and exam id', () => {
    expect(elearningExamLockKey(ORG, USER, EXAM)).toBe(`elearning-exam:${ORG}:${USER}:${EXAM}`)
    expect(elearningExamLockKey(ORG, USER, EXAM)).not.toBe(`elearning-exam:${ORG}:${USER}:${ITEM}`)
    expect(ELEARNING_EXAM_PAPER_DOMAIN).toBe('elearning.exam.paper.v1')
    expect(ELEARNING_EXAM_PAPER_VERSION).toBe(1)
    expect(ELEARNING_EXAM_GRADE_KIND).toBe('auto')
    expect(ELEARNING_EXAM_AUTO_GRADER).toBe('system:auto')
  })

  it('validates unique nonblank options and private answer keys for all three types', () => {
    const single = validateElearningObjectiveQuestion(sampleQuestion())
    expect(single.answerKey).toEqual({ correct: ['a'] })
    expect(single.options).toEqual([
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'beta' },
    ])

    const multiple = validateElearningObjectiveQuestion(sampleQuestion({
      questionType: 'multiple_choice',
      answerKey: { correct: ['b', 'a'] },
    }))
    expect(multiple.answerKey.correct).toEqual(['a', 'b'])

    const truth = validateElearningObjectiveQuestion(sampleQuestion({
      questionType: 'true_false',
      options: [
        { id: 't', text: 'true' },
        { id: 'f', text: 'false' },
      ],
      answerKey: { correct: ['f'] },
    }))
    expect(truth.answerKey.correct).toEqual(['f'])

    const paper = samplePaper()
    expect(paper.questions).toHaveLength(3)
    expect(paper.domain).toBe(ELEARNING_EXAM_PAPER_DOMAIN)
  })

  it('rejects blank, duplicate, and unknown option or answer-key ids without leaking secrets', () => {
    expectCode(() => validateElearningObjectiveQuestion(sampleQuestion({
      options: [{ id: ' ', text: 'alpha' }],
    })), 'invalid_input')
    expectCode(() => validateElearningObjectiveQuestion(sampleQuestion({
      options: [{ id: 'a', text: '   ' }],
    })), 'invalid_input')
    expectCode(() => validateElearningObjectiveQuestion(sampleQuestion({
      options: [
        { id: 'a', text: 'alpha' },
        { id: 'a', text: 'again' },
      ],
    })), 'invalid_input')
    expectCode(() => validateElearningObjectiveQuestion(sampleQuestion({
      answerKey: { correct: ['z'] },
    })), 'invalid_input')
    expectCode(() => validateElearningObjectiveQuestion(sampleQuestion({
      answerKey: { correct: ['a', 'a'] },
    })), 'invalid_input')
    expectCode(() => validateElearningObjectiveQuestion(sampleQuestion({
      answerKey: { correct: [] },
    })), 'invalid_input')
    expectCode(() => validateElearningObjectiveQuestion(sampleQuestion({
      questionType: 'single_choice',
      answerKey: { correct: ['a', 'b'] },
    })), 'invalid_input')
    expectCode(() => validateElearningObjectiveQuestion(sampleQuestion({
      questionType: 'true_false',
      options: [
        { id: 't', text: 'true' },
        { id: 'f', text: 'false' },
      ],
      answerKey: { correct: ['t', 'f'] },
    })), 'invalid_input')
    expectCode(() => validateElearningObjectiveQuestion(sampleQuestion({
      questionType: 'multiple_choice',
      answerKey: { correct: [] },
    })), 'invalid_input')
    expectCode(() => validateElearningObjectiveQuestion(sampleQuestion({
      questionType: 'essay',
    })), 'invalid_input')
    expectCode(() => validateElearningPaperSnapshot({
      domain: ELEARNING_EXAM_PAPER_DOMAIN,
      version: ELEARNING_EXAM_PAPER_VERSION,
      examId: EXAM,
      passScore: 10,
      questions: [sampleQuestion(), sampleQuestion()],
    }), 'invalid_input')
  })

  it('redacts answer keys, correct ids, and explanation from public paper JSON', () => {
    const paper = samplePaper()
    const publicPaper = redactElearningPaperSnapshot(paper)
    const blob = JSON.stringify(publicPaper)
    expect(blob).not.toContain('answer_key')
    expect(blob).not.toContain('answerKey')
    expect(blob).not.toContain('explanation')
    expect(blob).not.toContain('secret rationale')
    expect(blob).not.toContain('multi secret')
    expect(blob).not.toMatch(/"correct"/)
    expect(publicPaper.questions.map((question) => question.questionRevisionId)).toEqual([Q1, Q2, Q3])
    expect(publicPaper.questions[0].options).toEqual([
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'beta' },
    ])
    expect(stripElearningExamSecrets(paper).questions[0]).not.toHaveProperty('answerKey')
    expect(stripElearningExamSecrets(paper).questions[0]).not.toHaveProperty('explanation')
  })
})

describe('elearning exam scoring and answer canonicalization', () => {
  it('scores single choice, order-insensitive multiple choice, and true/false by exact set equality', () => {
    const paper = samplePaper()
    const perfect = canonicalizeElearningExamAnswers(paper, {
      [Q1]: ['a'],
      [Q2]: ['c', 'a'],
      [Q3]: ['t'],
    })
    expect(perfect[Q2]).toEqual(['a', 'c'])
    const scored = scoreElearningExam(paper, perfect)
    expect(scored).toEqual(expect.objectContaining({
      autoScore: 30,
      totalScore: 30,
      passed: true,
    }))
    expect(scored.questions.map((row) => row.awarded)).toEqual([10, 10, 10])
    expect(JSON.stringify(scored)).not.toContain('answer_key')
    expect(JSON.stringify(scored)).not.toContain('explanation')
    expect(JSON.stringify(scored)).not.toMatch(/"correct"/)

    const missSingle = scoreElearningExam(paper, canonicalizeElearningExamAnswers(paper, {
      [Q1]: ['b'],
      [Q2]: ['a', 'c'],
      [Q3]: ['t'],
    }))
    expect(missSingle.questions[0].awarded).toBe(0)
    expect(missSingle.autoScore).toBe(20)

    const partialMultiple = scoreElearningExam(paper, canonicalizeElearningExamAnswers(paper, {
      [Q1]: ['a'],
      [Q2]: ['a'],
      [Q3]: ['t'],
    }))
    expect(partialMultiple.questions[1].awarded).toBe(0)
    expect(partialMultiple.autoScore).toBe(20)

    const extraMultiple = scoreElearningExam(paper, canonicalizeElearningExamAnswers(paper, {
      [Q1]: ['a'],
      [Q2]: ['a', 'b', 'c'],
      [Q3]: ['t'],
    }))
    expect(extraMultiple.questions[1].awarded).toBe(0)

    const missTf = scoreElearningExam(paper, canonicalizeElearningExamAnswers(paper, {
      [Q1]: ['a'],
      [Q2]: ['a', 'c'],
      [Q3]: ['f'],
    }))
    expect(missTf.questions[2].awarded).toBe(0)
    expect(missTf.autoScore).toBe(20)
  })

  it('treats missing answers as unanswered zeros and applies the snapshot pass score', () => {
    const paper = samplePaper()
    const empty = canonicalizeElearningExamAnswers(paper, {})
    expect(empty).toEqual({ [Q1]: [], [Q2]: [], [Q3]: [] })
    const scored = scoreElearningExam(paper, empty)
    expect(scored.autoScore).toBe(0)
    expect(scored.passed).toBe(false)

    const passAtZero = scoreElearningExam(samplePaper({ passScore: 0 }), empty)
    expect(passAtZero.passed).toBe(true)

    const brokenHigh = samplePaper()
    brokenHigh.passScore = 31
    expectCode(() => scoreElearningExam(brokenHigh, empty), 'unavailable')
    const brokenLow = samplePaper()
    brokenLow.passScore = -1
    expectCode(() => scoreElearningExam(brokenLow, empty), 'unavailable')
  })

  it('rejects invalid, unknown, and duplicate submitted options or question keys', () => {
    const paper = samplePaper()
    expectCode(() => canonicalizeElearningExamAnswers(paper, { [Q1]: 'a' }), 'invalid_input')
    expectCode(() => canonicalizeElearningExamAnswers(paper, { [Q1]: ['a', 'a'] }), 'invalid_input')
    expectCode(() => canonicalizeElearningExamAnswers(paper, { [Q1]: ['z'] }), 'invalid_input')
    expectCode(() => canonicalizeElearningExamAnswers(paper, { [Q1]: [''] }), 'invalid_input')
    expectCode(() => canonicalizeElearningExamAnswers(paper, { [Q1]: [1] }), 'invalid_input')
    expectCode(
      () => canonicalizeElearningExamAnswers(paper, { '99999999-9999-4999-8999-999999999999': ['a'] }),
      'invalid_input',
    )
    expectCode(() => canonicalizeElearningExamAnswers(paper, []), 'invalid_input')
    expectCode(() => canonicalizeElearningExamAnswers(paper, 'a'), 'invalid_input')
  })

  it('keeps mixed-case valid UUID answers and rejects duplicate normalized aliases', () => {
    const paper = samplePaper()
    const mixedQ1 = `AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
    const mixedQ2 = `BBBBBBBB-bbbb-4bbb-8bbb-bbbbbbbbbbbb`
    const mixedQ3 = `CCCCCCCC-cccc-4ccc-8ccc-cccccccccccc`
    const canonical = canonicalizeElearningExamAnswers(paper, {
      [mixedQ1]: ['a'],
      [mixedQ2]: ['c', 'a'],
      [mixedQ3]: ['t'],
    })
    expect(canonical[Q1]).toEqual(['a'])
    expect(canonical[Q2]).toEqual(['a', 'c'])
    expect(canonical[Q3]).toEqual(['t'])
    expect(scoreElearningExam(paper, canonical)).toEqual(expect.objectContaining({
      autoScore: 30,
      passed: true,
    }))

    expectCode(() => canonicalizeElearningExamAnswers(paper, {
      [Q1]: ['a'],
      [Q1.toUpperCase()]: ['a'],
    }), 'invalid_input')
    expectCode(() => canonicalizeElearningExamAnswers(paper, {
      [mixedQ1]: ['a'],
      [Q1]: ['b'],
    }), 'invalid_input')
  })

  it('treats paper_snapshot.passScore as the grading threshold and rejects scores above the frozen total', () => {
    const highBar = samplePaper({ passScore: 30 })
    const empty = canonicalizeElearningExamAnswers(highBar, {})
    expect(scoreElearningExam(highBar, empty).passed).toBe(false)
    expect(scoreElearningExam(highBar, empty).totalScore).toBe(30)

    const zeroBar = samplePaper({ passScore: 0 })
    expect(scoreElearningExam(zeroBar, empty).passed).toBe(true)
    const ignoredOverride = (scoreElearningExam as (...args: unknown[]) => ReturnType<typeof scoreElearningExam>)(
      samplePaper(),
      empty,
      0,
    )
    expect(ignoredOverride.passed).toBe(false)

    expectCode(() => validateElearningPaperSnapshot({
      domain: ELEARNING_EXAM_PAPER_DOMAIN,
      version: ELEARNING_EXAM_PAPER_VERSION,
      examId: EXAM,
      passScore: 31,
      questions: [sampleQuestion(), sampleQuestion({
        position: 2,
        questionRevisionId: Q2,
        questionId: QUESTION_B,
      })],
    }), 'invalid_input')
    expectCode(() => validateElearningPaperSnapshot({
      domain: ELEARNING_EXAM_PAPER_DOMAIN,
      version: ELEARNING_EXAM_PAPER_VERSION,
      examId: EXAM,
      passScore: 10.5,
      questions: [sampleQuestion()],
    }), 'invalid_input')
  })
})

describe('elearning exam service input closure', () => {
  it('rejects blank actors and non-UUID item/attempt ids without leaking values', async () => {
    const db = createMemoryDb()
    await expectAsyncCode(() => startElearningExam(db, { orgId: '', userId: USER, itemId: ITEM }), 'invalid_input')
    await expectAsyncCode(() => startElearningExam(db, { orgId: ORG, userId: '  ', itemId: ITEM }), 'invalid_input')
    await expectAsyncCode(
      () => startElearningExam(db, { orgId: ORG, userId: USER, itemId: 'not-a-uuid' }),
      'invalid_input',
    )
    await expectAsyncCode(
      () => submitElearningExam(db, { orgId: ORG, userId: USER, attemptId: 'nope', answers: {} }),
      'invalid_input',
    )
    await expectAsyncCode(
      () => submitElearningExam(db, { orgId: '', userId: USER, attemptId: ATTEMPT, answers: {} }),
      'invalid_input',
    )
  })

  it('lowercases attempt/item UUIDs and still fails closed before a query on blank org', async () => {
    const db = createMemoryDb()
    await expectAsyncCode(
      () => startElearningExam(db, { orgId: '\t', userId: USER, itemId: ITEM.toUpperCase() }),
      'invalid_input',
    )
  })
})

describe('elearning exam public submit result', () => {
  it('returns aggregate-only JSON on initial submit and keeps details on the ledger', async () => {
    const { db, mem } = createSubmitMemoryDb()
    const submitted = await submitElearningExam(db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
      answers: perfectAnswers(),
    })
    const raw = assertPublicSubmitJson(submitted)
    expect(raw).toEqual({
      attemptId: ATTEMPT,
      attemptNo: 1,
      status: 'graded',
      autoScore: 30,
      totalScore: 30,
      passed: true,
      duplicate: false,
    })
    expect(mem.lockKeys).toEqual([elearningExamLockKey(ORG, USER, EXAM)])
    expect(mem.attempt.status).toBe('graded')
    expect(mem.attempt.answers).toEqual({
      [Q1]: ['a'],
      [Q2]: ['a', 'c'],
      [Q3]: ['t'],
    })
    expect(mem.grades).toHaveLength(1)
    expect(mem.grades[0].score).toBe(30)
    expect(mem.grades[0].maxScore).toBe(30)
    const details = mem.grades[0].details as { questions: Array<{ awarded: number; selected: string[] }> }
    expect(details.questions.map((row) => row.awarded)).toEqual([10, 10, 10])
    expect(details.questions[1].selected).toEqual(['a', 'c'])
  })

  it('replays identical answers with the same aggregate-only JSON and conflicts when answers change', async () => {
    const { db, mem } = createSubmitMemoryDb()
    const first = await submitElearningExam(db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
      answers: perfectAnswers(),
    })
    const replay = await submitElearningExam(db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
      answers: {
        [Q1]: ['a'],
        [Q2]: ['a', 'c'],
        [Q3]: ['t'],
      },
    })
    expect(assertPublicSubmitJson(replay)).toEqual({
      ...assertPublicSubmitJson(first),
      duplicate: true,
    })
    expect(replay.duplicate).toBe(true)
    expect(mem.grades).toHaveLength(1)
    expect(mem.lockKeys).toEqual([
      elearningExamLockKey(ORG, USER, EXAM),
      elearningExamLockKey(ORG, USER, EXAM),
    ])

    await expectAsyncCode(() => submitElearningExam(db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
      answers: { [Q1]: ['b'], [Q2]: ['a'], [Q3]: ['f'] },
    }), 'conflict')
    expect(mem.grades).toHaveLength(1)
  })

  it('normalizes mixed-case question UUID keys into stored answers without exposing them publicly', async () => {
    const { db, mem } = createSubmitMemoryDb()
    const submitted = await submitElearningExam(db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
      answers: {
        [Q1.toUpperCase()]: ['a'],
        [Q2.toUpperCase()]: ['c', 'a'],
        [Q3.toUpperCase()]: ['t'],
      },
    })
    assertPublicSubmitJson(submitted)
    expect(submitted.passed).toBe(true)
    expect(mem.attempt.answers).toEqual({
      [Q1]: ['a'],
      [Q2]: ['a', 'c'],
      [Q3]: ['t'],
    })
  })

  it('fails unavailable when a stored aggregate disagrees with a snapshot recompute', async () => {
    const snapshot = samplePaper()
    const stored = canonicalizeElearningExamAnswers(snapshot, perfectAnswers())
    const { db, mem } = createSubmitMemoryDb({
      status: 'graded',
      answers: stored,
      autoScore: 0,
      totalScore: 30,
      passed: true,
    })
    await expectAsyncCode(() => submitElearningExam(db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
      answers: perfectAnswers(),
    }), 'unavailable')
    expect(mem.grades).toHaveLength(0)

    const passedMismatch = createSubmitMemoryDb({
      status: 'graded',
      answers: stored,
      autoScore: 30,
      totalScore: 30,
      passed: false,
    })
    await expectAsyncCode(() => submitElearningExam(passedMismatch.db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
      answers: perfectAnswers(),
    }), 'unavailable')
  })
})
