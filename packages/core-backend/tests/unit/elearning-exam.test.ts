import { describe, expect, it } from 'vitest'
import {
  ELEARNING_EXAM_AUTO_GRADER,
  ELEARNING_EXAM_GRADE_KIND,
  ELEARNING_EXAM_PAPER_DOMAIN,
  ELEARNING_EXAM_PAPER_VERSION,
  ELEARNING_EXAM_PAPER_VERSION_MIXED,
  ELEARNING_SHORT_ANSWER_MAX_CHARS,
  canonicalizeElearningExamAnswers,
  elearningExamObjectiveMaxScore,
  elearningExamLockKey,
  ElearningExamError,
  freezeElearningPaperSnapshot,
  hasElearningManualQuestions,
  materializeElearningExamQuestions,
  redactElearningPaperSnapshot,
  scoreElearningExam,
  saveElearningExamAnswers,
  startElearningExam,
  stripElearningExamSecrets,
  submitElearningExam,
  validateElearningExamQuestion,
  validateElearningObjectiveQuestion,
  validateElearningPaperSnapshot,
  type ElearningExamDb,
  type ElearningExamAnswers,
  type ElearningExamQueryable,
  type ElearningPaperSnapshot,
} from '../../src/services/elearning-exam'
import { settleExpiredElearningExamAttempt } from '../../src/services/elearning-exam-expiry'

const ORG = 'org-exam-1'
const USER = 'user-exam-1'
const ITEM = '11111111-1111-4111-8111-111111111111'
const ATTEMPT = '22222222-2222-4222-8222-222222222222'
const EXAM = '33333333-3333-4333-8333-333333333333'
const Q1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const Q2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const Q3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const Q4 = 'abababab-abab-4bab-8bab-abababababab'
const QUESTION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const QUESTION_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const QUESTION_C = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const QUESTION_D = 'acacacac-acac-4cac-8cac-acacacacacac'
const VERSION = '44444444-4444-4444-8444-444444444444'
const MEMBER = '55555555-5555-4555-8555-555555555555'
const COURSE = '66666666-6666-4666-8666-666666666666'
const SCOPE = '77777777-7777-4777-8777-777777777777'
const SCOPE_REVISION = '88888888-8888-4888-8888-888888888888'
const SCOPE_RULE = '99999999-9999-4999-8999-999999999999'
const GRADED_AT = new Date('2026-08-29T01:02:03.000Z')
const INCENTIVE_ON: NodeJS.ProcessEnv = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_INCENTIVE_ENABLED: 'true',
}

const PUBLIC_START_KEYS = [
  'attemptId',
  'attemptNo',
  'status',
  'paper',
  'answers',
  'deadlineAt',
  'duplicate',
] as const

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

function sampleMixedPaper(): ElearningPaperSnapshot {
  return freezeElearningPaperSnapshot(EXAM, 12, [
    validateElearningObjectiveQuestion(sampleQuestion()),
    validateElearningExamQuestion({
      position: 2,
      questionRevisionId: Q4,
      questionId: QUESTION_D,
      questionType: 'short_answer',
      prompt: 'Explain briefly',
      options: [],
      points: 10,
      answerKey: {},
      explanation: null,
    }),
  ])
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

function assertPublicStartJson(payload: unknown): Record<string, unknown> {
  const raw = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
  expect(Object.keys(raw)).toEqual([...PUBLIC_START_KEYS])
  expect(raw.status).toBe('started')
  const blob = JSON.stringify(raw)
  expect(blob).not.toContain('answer_key')
  expect(blob).not.toContain('answerKey')
  expect(blob).not.toContain('explanation')
  expect(blob).not.toContain('secret rationale')
  expect(blob).not.toContain('multi secret')
  expect(blob).not.toContain('tf secret')
  expect(blob).not.toMatch(/"correct"/)
  expect(blob).not.toContain('paper_snapshot')
  expect(blob).not.toContain('examId')
  expect(blob).not.toContain('passScore')
  return raw
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
  const match = /\/\* (elearning-(?:exam|access|audience):[a-z-]+) \*\//.exec(sql)
  return match ? match[1] : null
}

interface AccessMem {
  memberId: string | null
  courseStatus: string
  versionStatus: string
  activeVersionId: string | null
  scopeId: string | null
  scopeRevisionId: string | null
  scopeRuleId: string | null
  scopeSubjectType: 'all' | 'user'
  scopeSubjectRef: string | null
}

function defaultAccessMem(): AccessMem {
  return {
    memberId: MEMBER,
    courseStatus: 'active',
    versionStatus: 'published',
    activeVersionId: VERSION,
    scopeId: null,
    scopeRevisionId: null,
    scopeRuleId: null,
    scopeSubjectType: 'all',
    scopeSubjectRef: null,
  }
}

function queryAccessMemory(
  tag: string | null,
  params: unknown[],
  access: AccessMem,
): { rows: Array<Record<string, unknown>>; rowCount: number } | null {
  if (tag === 'elearning-access:lock-course') {
    if (params[0] !== ORG || params[1] !== VERSION) return { rows: [], rowCount: 0 }
    return {
      rows: [{
        course_id: COURSE,
        course_status: access.courseStatus,
        active_version_id: access.activeVersionId,
        scope_id: access.scopeId,
        version_status: access.versionStatus,
      }],
      rowCount: 1,
    }
  }
  if (tag === 'elearning-access:lock-assignment') {
    if (
      access.memberId
      && params[0] === ORG
      && params[1] === USER
      && params[2] === VERSION
    ) {
      return { rows: [{ id: access.memberId }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }
  if (tag === 'elearning-access:lock-scope') {
    if (params[0] !== ORG || params[1] !== access.scopeId || !access.scopeRevisionId) {
      return { rows: [], rowCount: 0 }
    }
    return { rows: [{ active_revision_id: access.scopeRevisionId }], rowCount: 1 }
  }
  if (tag === 'elearning-audience:load-revision-rules') {
    if (params[0] !== ORG || params[1] !== access.scopeRevisionId || !access.scopeRuleId) {
      return { rows: [], rowCount: 0 }
    }
    return {
      rows: [{
        rule_id: access.scopeRuleId,
        scope_revision_id: access.scopeRevisionId,
        subject_type: access.scopeSubjectType,
        subject_ref: access.scopeSubjectRef,
        include_children: false,
      }],
      rowCount: 1,
    }
  }
  if (tag === 'elearning-audience:lock-principal') {
    return { rows: [{ id: USER }], rowCount: 1 }
  }
  if (tag === 'elearning-audience:resolve-membership') {
    if (params[0] !== ORG || typeof params[1] !== 'string') {
      return { rows: [], rowCount: 0 }
    }
    const rules = JSON.parse(params[1]) as Array<Record<string, unknown>>
    const rows = rules.flatMap((rule) => {
      const matches = rule.subject_type === 'all'
        || (rule.subject_type === 'user' && rule.subject_ref === USER)
      return matches ? [{ rule_key: rule.rule_key, user_id: USER }] : []
    })
    return { rows, rowCount: rows.length }
  }
  return null
}

interface SubmitMemAttempt {
  id: string
  examId: string
  versionId: string
  userId: string
  attemptNo: number
  status: string
  paperSnapshot: ElearningPaperSnapshot
  answers: ElearningExamAnswers | null
  autoScore: number | null
  totalScore: number | null
  passed: boolean | null
  deadlineAt: Date | null
  expiredAt: Date | null
}

interface SubmitMem {
  attempt: SubmitMemAttempt
  access: AccessMem
  grades: Array<{ details: unknown; score: unknown; maxScore: unknown }>
  lockKeys: string[]
}

function createSubmitMemoryDb(
  seed: Partial<SubmitMemAttempt> = {},
  accessSeed: Partial<AccessMem> = {},
): {
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
      deadlineAt: null,
      expiredAt: null,
      ...seed,
    },
    access: { ...defaultAccessMem(), ...accessSeed },
    grades: [],
    lockKeys: [],
  }
  const query: ElearningExamQueryable['query'] = async (sql, params = []) => {
    const tag = examQueryTag(sql)
    const attempt = mem.attempt
    if (tag === 'elearning-exam:peek-attempt') {
      if (params[0] !== ORG || params[1] !== attempt.id) return { rows: [], rowCount: 0 }
      return { rows: [{ user_id: attempt.userId, exam_id: attempt.examId, course_version_item_id: ITEM }], rowCount: 1 }
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
          course_version_item_id: ITEM,
          paper_snapshot: attempt.paperSnapshot,
          answers: attempt.answers,
          auto_score: attempt.autoScore,
          total_score: attempt.totalScore,
          passed: attempt.passed,
          deadline_at: attempt.deadlineAt,
          expired_at: attempt.expiredAt,
          user_id: attempt.userId,
          course_status: mem.access.courseStatus,
          version_status: mem.access.versionStatus,
          exam_status: 'published',
        }],
        rowCount: 1,
      }
    }
    const accessResult = queryAccessMemory(tag, params, mem.access)
    if (accessResult) return accessResult
    if (tag === 'elearning-exam:save-answers') {
      if (params[1] !== ORG || params[2] !== attempt.id || attempt.status !== 'started') {
        return { rows: [], rowCount: 0 }
      }
      attempt.answers = JSON.parse(String(params[0])) as Record<string, string[]>
      return { rows: [], rowCount: 1 }
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
      return { rows: [{ graded_at: GRADED_AT }], rowCount: 1 }
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
  it('materializes deterministic question and option order without changing stable ids', () => {
    const source = samplePaper().questions
    const materialized = materializeElearningExamQuestions(
      source,
      ATTEMPT,
      true,
      true,
    )
    expect(materialized.map((question) => question.questionRevisionId)).toEqual([
      Q3,
      Q2,
      Q1,
    ])
    expect(materialized.map((question) => question.position)).toEqual([1, 2, 3])
    expect(materialized[0]?.options.map((option) => option.id)).toEqual(['f', 't'])
    expect(materialized[1]?.options.map((option) => option.id)).toEqual(['b', 'c', 'a'])
    expect(materializeElearningExamQuestions(source, ATTEMPT, true, true)).toEqual(
      materialized,
    )
    expect(source.map((question) => question.questionRevisionId)).toEqual([Q1, Q2, Q3])
    const snapshot = validateElearningPaperSnapshot({
      ...samplePaper(),
      questions: materialized,
    })
    expect(scoreElearningExam(
      snapshot,
      canonicalizeElearningExamAnswers(snapshot, perfectAnswers()),
    )).toMatchObject({ autoScore: 30, totalScore: 30, passed: true })
  })

  it('names the advisory lock from org, user, and course item id', () => {
    expect(elearningExamLockKey(ORG, USER, ITEM)).toBe(`elearning-exam:${ORG}:${USER}:${ITEM}`)
    expect(elearningExamLockKey(ORG, USER, ITEM)).not.toBe(`elearning-exam:${ORG}:${USER}:${EXAM}`)
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

  it('keeps objective snapshots on v1 and uses a closed v2 shape for short answers', () => {
    expect(samplePaper().version).toBe(ELEARNING_EXAM_PAPER_VERSION)
    const mixed = sampleMixedPaper()
    expect(mixed.version).toBe(ELEARNING_EXAM_PAPER_VERSION_MIXED)
    expect(hasElearningManualQuestions(mixed)).toBe(true)
    expect(elearningExamObjectiveMaxScore(mixed)).toBe(10)
    expect(mixed.questions[1]).toMatchObject({
      questionType: 'short_answer',
      options: [],
      answerKey: {},
    })
    expectCode(
      () =>
        validateElearningPaperSnapshot({
          ...mixed,
          version: ELEARNING_EXAM_PAPER_VERSION,
        }),
      'invalid_input',
    )
    expectCode(
      () =>
        validateElearningPaperSnapshot({
          ...samplePaper(),
          version: ELEARNING_EXAM_PAPER_VERSION_MIXED,
        }),
      'invalid_input',
    )
    expectCode(
      () =>
        validateElearningExamQuestion({
          ...mixed.questions[1],
          options: [{ id: 'a', text: 'not allowed' }],
        }),
      'invalid_input',
    )
    expectCode(
      () =>
        validateElearningExamQuestion({
          ...mixed.questions[1],
          answerKey: { correct: ['a'] },
        }),
      'invalid_input',
    )
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
  it('canonicalizes short text without auto-grading or exposing it in public paper JSON', () => {
    const paper = sampleMixedPaper()
    const answers = canonicalizeElearningExamAnswers(paper, {
      [Q1]: ['a'],
      [Q4]: '  first\r\nsecond  ',
    })
    expect(answers).toEqual({
      [Q1]: ['a'],
      [Q4]: 'first\nsecond',
    })
    const grade = scoreElearningExam(paper, answers)
    expect(grade).toMatchObject({
      autoScore: 10,
      totalScore: 20,
      passed: null,
    })
    expect(grade.questions).toEqual([
      {
        questionRevisionId: Q1,
        selected: ['a'],
        awarded: 10,
        points: 10,
      },
      {
        questionRevisionId: Q4,
        selected: [],
        awarded: 0,
        points: 10,
      },
    ])
    const publicJson = JSON.stringify(redactElearningPaperSnapshot(paper))
    expect(publicJson).not.toContain('answerKey')
    expect(publicJson).not.toContain('explanation')
    expect(publicJson).not.toContain('first')
    expect(canonicalizeElearningExamAnswers(paper, null)[Q4]).toBe('')
    expectCode(
      () => canonicalizeElearningExamAnswers(paper, { [Q1]: 'a', [Q4]: '' }),
      'invalid_input',
    )
    expectCode(
      () => canonicalizeElearningExamAnswers(paper, { [Q1]: [], [Q4]: [] }),
      'invalid_input',
    )
    expectCode(
      () =>
        canonicalizeElearningExamAnswers(paper, {
          [Q1]: [],
          [Q4]: 'x'.repeat(ELEARNING_SHORT_ANSWER_MAX_CHARS + 1),
        }),
      'invalid_input',
    )
  })

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
    await expectAsyncCode(
      () => saveElearningExamAnswers(db, { orgId: ORG, userId: USER, attemptId: 'nope', answers: {} }),
      'invalid_input',
    )
    await expectAsyncCode(
      () => saveElearningExamAnswers(db, { orgId: '', userId: USER, attemptId: ATTEMPT, answers: {} }),
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
  it('awards pass_exam exactly once from the locked learner and DB graded time', async () => {
    const { db } = createSubmitMemoryDb()
    const awards: unknown[] = []
    const awardPassExam = async (_tx: unknown, input: unknown, env: NodeJS.ProcessEnv | undefined) => {
      awards.push({ input, env })
      return null
    }

    await submitElearningExam(db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
      answers: perfectAnswers(),
    }, {
      env: INCENTIVE_ON,
      awardPassExam,
    })
    await expect(submitElearningExam(db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
      answers: perfectAnswers(),
    }, { env: INCENTIVE_ON, awardPassExam })).resolves.toMatchObject({ duplicate: true })

    expect(awards).toEqual([{
      input: {
        attemptId: ATTEMPT,
        gradedAt: GRADED_AT,
        orgId: ORG,
        userId: USER,
      },
      env: INCENTIVE_ON,
    }])

    const disabled = createSubmitMemoryDb()
    let disabledCalls = 0
    await expect(submitElearningExam(disabled.db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
      answers: perfectAnswers(),
    }, {
      env: { ELEARNING_ENABLED: 'true' },
      awardPassExam: async () => {
        disabledCalls += 1
        return null
      },
    })).resolves.toMatchObject({ passed: true })
    expect(disabledCalls).toBe(0)
  })

  it('does not award a failed objective attempt and fails closed on award errors', async () => {
    const failed = createSubmitMemoryDb()
    let calls = 0
    await expect(submitElearningExam(failed.db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
      answers: emptyAnswers(),
    }, {
      env: INCENTIVE_ON,
      awardPassExam: async () => {
        calls += 1
        return null
      },
    })).resolves.toMatchObject({ passed: false })
    expect(calls).toBe(0)

    const broken = createSubmitMemoryDb()
    await expectAsyncCode(() => submitElearningExam(broken.db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
      answers: perfectAnswers(),
    }, {
      env: INCENTIVE_ON,
      awardPassExam: async () => {
        throw new Error('credit authority failed')
      },
    }), 'unavailable')
  })

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
    expect(mem.lockKeys).toEqual([elearningExamLockKey(ORG, USER, ITEM)])
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
      elearningExamLockKey(ORG, USER, ITEM),
      elearningExamLockKey(ORG, USER, ITEM),
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

describe('elearning expired-attempt credit award', () => {
  it('awards only a passing timeout settlement from the locked attempt identity', async () => {
    const awards: unknown[] = []
    let answers: unknown = perfectAnswers()
    const query: ElearningExamQueryable['query'] = async (sql) => {
      const tag = examQueryTag(sql)
      if (tag === 'elearning-exam:lock-expiry-attempt') {
        return {
          rows: [{
            id: ATTEMPT,
            user_id: USER,
            status: 'expired',
            paper_snapshot: samplePaper(),
            answers,
            deadline_at: new Date('2026-08-29T01:00:00.000Z'),
            expired_at: new Date('2026-08-29T01:00:01.000Z'),
          }],
          rowCount: 1,
        }
      }
      if (tag === 'elearning-exam:insert-expiry-grade') {
        return { rows: [], rowCount: 1 }
      }
      if (tag === 'elearning-exam:grade-expired-attempt') {
        return { rows: [{ graded_at: GRADED_AT }], rowCount: 1 }
      }
      throw new Error(`unexpected exam query: ${tag ?? sql}`)
    }
    const db = {
      query,
      transaction: async <T>(handler: (tx: ElearningExamQueryable) => Promise<T>) => handler({ query }),
    }

    await expect(settleExpiredElearningExamAttempt(db, {
      orgId: ORG,
      attemptId: ATTEMPT,
    }, {
      env: INCENTIVE_ON,
      awardPassExam: async (_tx, input, env) => {
        awards.push({ input, env })
        return null
      },
    })).resolves.toEqual({ outcome: 'settled' })
    expect(awards).toEqual([{
      input: {
        attemptId: ATTEMPT,
        gradedAt: GRADED_AT,
        orgId: ORG,
        userId: USER,
      },
      env: INCENTIVE_ON,
    }])

    let disabledCalls = 0
    await expect(settleExpiredElearningExamAttempt(db, {
      orgId: ORG,
      attemptId: ATTEMPT,
    }, {
      env: { ELEARNING_ENABLED: 'true' },
      awardPassExam: async () => {
        disabledCalls += 1
        return null
      },
    })).resolves.toEqual({ outcome: 'settled' })
    expect(disabledCalls).toBe(0)

    answers = emptyAnswers()
    awards.length = 0
    await expect(settleExpiredElearningExamAttempt(db, {
      orgId: ORG,
      attemptId: ATTEMPT,
    }, {
      env: INCENTIVE_ON,
      awardPassExam: async (_tx, input, env) => {
        awards.push({ input, env })
        return null
      },
    })).resolves.toEqual({ outcome: 'settled' })
    expect(awards).toEqual([])
  })

  it('fails closed when timeout credit authority fails', async () => {
    const query: ElearningExamQueryable['query'] = async (sql) => {
      const tag = examQueryTag(sql)
      if (tag === 'elearning-exam:lock-expiry-attempt') {
        return {
          rows: [{
            id: ATTEMPT,
            user_id: USER,
            status: 'expired',
            paper_snapshot: samplePaper(),
            answers: perfectAnswers(),
            deadline_at: new Date('2026-08-29T01:00:00.000Z'),
            expired_at: new Date('2026-08-29T01:00:01.000Z'),
          }],
          rowCount: 1,
        }
      }
      if (tag === 'elearning-exam:insert-expiry-grade') return { rows: [], rowCount: 1 }
      if (tag === 'elearning-exam:grade-expired-attempt') {
        return { rows: [{ graded_at: GRADED_AT }], rowCount: 1 }
      }
      throw new Error(`unexpected exam query: ${tag ?? sql}`)
    }
    const db = {
      query,
      transaction: async <T>(handler: (tx: ElearningExamQueryable) => Promise<T>) => handler({ query }),
    }
    await expectAsyncCode(() => settleExpiredElearningExamAttempt(db, {
      orgId: ORG,
      attemptId: ATTEMPT,
    }, {
      env: INCENTIVE_ON,
      awardPassExam: async () => {
        throw new Error('credit authority failed')
      },
    }), 'unavailable')
  })
})

function emptyAnswers() {
  return { [Q1]: [] as string[], [Q2]: [] as string[], [Q3]: [] as string[] }
}

interface StartMem {
  attempts: SubmitMemAttempt[]
  access: AccessMem
  lockKeys: string[]
  priorVideoIncomplete: boolean
}

function createStartMemoryDb(
  seed: Partial<SubmitMemAttempt> & { started?: boolean } = {},
  accessSeed: Partial<AccessMem> = {},
): {
  db: ElearningExamDb
  mem: StartMem
} {
  const snapshot = samplePaper()
  const started = seed.started !== false
  const mem: StartMem = {
    attempts: started
      ? [{
          id: ATTEMPT,
          examId: EXAM,
          versionId: VERSION,
          userId: USER,
          attemptNo: 1,
          status: 'started',
          paperSnapshot: snapshot,
          answers: seed.answers === undefined ? null : seed.answers,
          autoScore: null,
          totalScore: null,
          passed: null,
          deadlineAt: null,
          expiredAt: null,
          ...seed,
        }]
      : [],
    access: { ...defaultAccessMem(), ...accessSeed },
    lockKeys: [],
    priorVideoIncomplete: false,
  }
  const query: ElearningExamQueryable['query'] = async (sql, params = []) => {
    const tag = examQueryTag(sql)
    if (tag === 'elearning-exam:peek-item') {
      if (params[0] !== ORG || params[1] !== ITEM) return { rows: [], rowCount: 0 }
      return { rows: [{ item_type: 'exam', exam_id: EXAM }], rowCount: 1 }
    }
    if (tag === 'elearning-exam:lock') {
      mem.lockKeys.push(String(params[0]))
      return { rows: [{}], rowCount: 1 }
    }
    if (tag === 'elearning-exam:load-item') {
      if (params[0] !== ORG || params[1] !== ITEM) return { rows: [], rowCount: 0 }
      return {
        rows: [{
          id: ITEM,
          course_version_id: VERSION,
          item_type: 'exam',
          position: 2,
          exam_id: EXAM,
          version_status: mem.access.versionStatus,
          course_status: mem.access.courseStatus,
        }],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-exam:lock-exam') {
      if (params[0] !== ORG || params[1] !== EXAM) return { rows: [], rowCount: 0 }
      return {
        rows: [{
          status: 'published',
          pass_score: 20,
          max_attempts: 3,
          paper_id: null,
          window_starts_at: null,
          window_ends_at: null,
          duration_seconds: null,
          shuffle_questions: false,
          shuffle_options: false,
        }],
        rowCount: 1,
      }
    }
    const accessResult = queryAccessMemory(tag, params, mem.access)
    if (accessResult) return accessResult
    if (tag === 'elearning-exam:load-prior-videos') {
      if (mem.priorVideoIncomplete) return { rows: [{ id: ITEM }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }
    if (tag === 'elearning-exam:load-attempts') {
      if (params[0] !== ORG || params[1] !== EXAM || params[2] !== USER) return { rows: [], rowCount: 0 }
      return {
        rows: mem.attempts.map((attempt) => ({
          id: attempt.id,
          user_id: attempt.userId,
          attempt_no: attempt.attemptNo,
          status: attempt.status,
          paper_snapshot: attempt.paperSnapshot,
          answers: attempt.answers,
          auto_score: attempt.autoScore,
          total_score: attempt.totalScore,
          passed: attempt.passed,
          deadline_at: attempt.deadlineAt,
          expired_at: attempt.expiredAt,
        })),
        rowCount: mem.attempts.length,
      }
    }
    if (tag === 'elearning-exam:load-questions') {
      return {
        rows: snapshot.questions.map((question) => ({
          position: question.position,
          points: question.points,
          question_revision_id: question.questionRevisionId,
          question_id: question.questionId,
          question_type: question.questionType,
          prompt: question.prompt,
          options: question.options,
          answer_key: question.answerKey,
          explanation: question.explanation,
        })),
        rowCount: snapshot.questions.length,
      }
    }
    if (tag === 'elearning-exam:insert-attempt') {
      const attempt: SubmitMemAttempt = {
        id: String(params[0]),
        examId: String(params[2]),
        versionId: String(params[3]),
        userId: String(params[4]),
        attemptNo: Number(params[5]),
        status: 'started',
        paperSnapshot: JSON.parse(String(params[6])) as ElearningPaperSnapshot,
        answers: null,
        autoScore: null,
        totalScore: null,
        passed: null,
        deadlineAt: null,
        expiredAt: null,
      }
      mem.attempts.push(attempt)
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

describe('elearning exam start own answers', () => {
  it('returns a closed started DTO with empty own answers on a new attempt', async () => {
    const { db, mem } = createStartMemoryDb({ started: false })
    const started = await startElearningExam(db, { orgId: ORG, userId: USER, itemId: ITEM })
    const raw = assertPublicStartJson(started)
    expect(raw).toEqual({
      attemptId: started.attemptId,
      attemptNo: 1,
      status: 'started',
      paper: redactElearningPaperSnapshot(samplePaper()),
      answers: emptyAnswers(),
      deadlineAt: null,
      duplicate: false,
    })
    expect(mem.attempts).toHaveLength(1)
    expect(mem.attempts[0]?.answers).toBeNull()
    expect(mem.lockKeys).toEqual([elearningExamLockKey(ORG, USER, ITEM)])
  })

  it('starts a self-study exam from an active visibility rule without an assignment', async () => {
    const { db, mem } = createStartMemoryDb(
      { started: false },
      {
        memberId: null,
        scopeId: SCOPE,
        scopeRevisionId: SCOPE_REVISION,
        scopeRuleId: SCOPE_RULE,
        scopeSubjectType: 'all',
      },
    )
    await expect(startElearningExam(db, {
      orgId: ORG,
      userId: USER,
      itemId: ITEM,
    })).resolves.toMatchObject({ status: 'started', duplicate: false })
    expect(mem.attempts).toHaveLength(1)
    expect(mem.access.memberId).toBeNull()
  })

  it('replays a started attempt with canonical saved answers and does not insert a second row', async () => {
    const saved = { [Q1]: ['a'], [Q2]: ['a', 'c'], [Q3]: [] as string[] }
    const { db, mem } = createStartMemoryDb({ answers: saved })
    const replayed = await startElearningExam(db, { orgId: ORG, userId: USER, itemId: ITEM })
    expect(assertPublicStartJson(replayed)).toEqual({
      attemptId: ATTEMPT,
      attemptNo: 1,
      status: 'started',
      paper: redactElearningPaperSnapshot(samplePaper()),
      answers: saved,
      deadlineAt: null,
      duplicate: true,
    })
    expect(mem.attempts).toHaveLength(1)
  })

  it('does not open a retake while an attempt awaits manual grading', async () => {
    const mixed = sampleMixedPaper()
    const { db, mem } = createStartMemoryDb({
      status: 'awaiting_manual',
      paperSnapshot: mixed,
      answers: {
        [Q1]: ['a'],
        [Q4]: 'Manual answer',
      },
      autoScore: 10,
    })
    await expectAsyncCode(
      () => startElearningExam(db, { orgId: ORG, userId: USER, itemId: ITEM }),
      'conflict',
    )
    expect(mem.attempts).toHaveLength(1)
  })
})

describe('elearning exam draft answer save', () => {
  it('canonicalizes, updates only the started attempt, and returns a closed started DTO', async () => {
    const { db, mem } = createSubmitMemoryDb()
    const saved = await saveElearningExamAnswers(db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
      answers: { [Q1]: ['a'], [Q2]: ['c', 'a'] },
    })
    expect(assertPublicStartJson(saved)).toEqual({
      attemptId: ATTEMPT,
      attemptNo: 1,
      status: 'started',
      paper: redactElearningPaperSnapshot(samplePaper()),
      answers: { [Q1]: ['a'], [Q2]: ['a', 'c'], [Q3]: [] },
      deadlineAt: null,
      duplicate: false,
    })
    expect(mem.lockKeys).toEqual([elearningExamLockKey(ORG, USER, ITEM)])
    expect(mem.attempt.status).toBe('started')
    expect(mem.attempt.answers).toEqual({ [Q1]: ['a'], [Q2]: ['a', 'c'], [Q3]: [] })
    expect(mem.grades).toHaveLength(0)
  })

  it('treats the same canonical body as an idempotent duplicate', async () => {
    const { db, mem } = createSubmitMemoryDb()
    const first = await saveElearningExamAnswers(db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
      answers: { [Q1]: ['b'] },
    })
    const stored = mem.attempt.answers
    const replay = await saveElearningExamAnswers(db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
      answers: { [Q1]: ['b'], [Q2]: [], [Q3]: [] },
    })
    expect(assertPublicStartJson(replay)).toEqual({
      ...assertPublicStartJson(first),
      duplicate: true,
    })
    expect(mem.attempt.answers).toEqual(stored)
    expect(mem.attempt.status).toBe('started')
  })

  it('rejects unknown questions and options as invalid_input without leaking secrets', async () => {
    const { db, mem } = createSubmitMemoryDb()
    await expectAsyncCode(() => saveElearningExamAnswers(db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
      answers: { [Q1]: ['z'] },
    }), 'invalid_input')
    await expectAsyncCode(() => saveElearningExamAnswers(db, {
      orgId: ORG,
      userId: USER,
      attemptId: ATTEMPT,
      answers: { '99999999-9999-4999-8999-999999999999': ['a'] },
    }), 'invalid_input')
    expect(mem.attempt.answers).toBeNull()
  })

  it('denies other users and orgs as not_found without querying the save update', async () => {
    const { db, mem } = createSubmitMemoryDb()
    await expectAsyncCode(() => saveElearningExamAnswers(db, {
      orgId: ORG,
      userId: 'other-user',
      attemptId: ATTEMPT,
      answers: perfectAnswers(),
    }), 'not_found')
    await expectAsyncCode(() => saveElearningExamAnswers(db, {
      orgId: 'other-org',
      userId: USER,
      attemptId: ATTEMPT,
      answers: perfectAnswers(),
    }), 'not_found')
    expect(mem.attempt.answers).toBeNull()
    expect(mem.lockKeys).toEqual([])
  })

  it('conflicts on graded, submitted, and expired attempts', async () => {
    const stored = canonicalizeElearningExamAnswers(samplePaper(), perfectAnswers())
    for (const status of ['graded', 'submitted', 'expired'] as const) {
      const { db, mem } = createSubmitMemoryDb({
        status,
        answers: stored,
        autoScore: status === 'graded' ? 30 : null,
        totalScore: status === 'graded' ? 30 : null,
        passed: status === 'graded' ? true : null,
      })
      await expectAsyncCode(() => saveElearningExamAnswers(db, {
        orgId: ORG,
        userId: USER,
        attemptId: ATTEMPT,
        answers: perfectAnswers(),
      }), 'conflict')
      expect(mem.attempt.answers).toBe(stored)
      expect(mem.grades).toHaveLength(0)
    }
  })
})
