import { describe, expect, it } from 'vitest'

import {
  ELEARNING_QUESTION_PRACTICE_DOMAIN,
  ELEARNING_QUESTION_PRACTICE_VERSION,
  ElearningQuestionPracticePolicyError,
  createElearningQuestionPracticeSnapshot,
  evaluateElearningQuestionPracticeAnswer,
  materializeElearningQuestionPractice,
} from '../../src/services/elearning-question-practice-policy'

const SENTINEL = 'secret-practice-value'
const PRACTICE_ID = '10000000-0000-4000-8000-000000000001'
const PRACTICE_REVISION_ID = '10000000-0000-4000-8000-000000000002'
const SESSION_1 = '10000000-0000-4000-8000-000000000003'
const SESSION_2 = '10000000-0000-4000-8000-000000000004'

const QUESTION_IDS = [
  '20000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000003',
  '20000000-0000-4000-8000-000000000004',
] as const
const REVISION_IDS = [
  '30000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003',
  '30000000-0000-4000-8000-000000000004',
] as const

function question(index: number, overrides: Record<string, unknown> = {}) {
  return {
    answerKey: { correct: index === 1 ? ['b', 'a'] : ['a'] },
    explanation: `${SENTINEL}-${index}`,
    options: [
      { id: 'a', text: `A${index}` },
      { id: 'b', text: `B${index}` },
      { id: 'c', text: `C${index}` },
    ],
    points: 1,
    position: index + 1,
    prompt: `Question ${index + 1}`,
    questionId: QUESTION_IDS[index],
    questionRevisionId: REVISION_IDS[index],
    questionType: index === 1 ? 'multiple_choice' : 'single_choice',
    ...overrides,
  }
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    domain: ELEARNING_QUESTION_PRACTICE_DOMAIN,
    orgId: 'org-1',
    practiceId: PRACTICE_ID,
    practiceRevisionId: PRACTICE_REVISION_ID,
    questions: [question(0), question(1), question(2), question(3)],
    version: ELEARNING_QUESTION_PRACTICE_VERSION,
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected question-practice policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningQuestionPracticePolicyError)
    const policyError = error as ElearningQuestionPracticePolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

function answer(overrides: Record<string, unknown> = {}) {
  return {
    questionRevisionId: REVISION_IDS[0],
    selectedOptionIds: ['a'],
    sessionId: SESSION_1,
    userId: 'learner-1',
    ...overrides,
  }
}

describe('elearning question-practice policy', () => {
  it('freezes a revision-pinned objective-question snapshot', () => {
    const result = createElearningQuestionPracticeSnapshot(snapshot())
    expect(result).toMatchObject({
      domain: ELEARNING_QUESTION_PRACTICE_DOMAIN,
      orgId: 'org-1',
      practiceId: PRACTICE_ID,
      practiceRevisionId: PRACTICE_REVISION_ID,
      version: 1,
    })
    expect(result.questions.map((item) => item.position)).toEqual([1, 2, 3, 4])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.questions)).toBe(true)
    expect(result.questions.every((item) => (
      Object.isFrozen(item)
      && Object.isFrozen(item.answerKey)
      && Object.isFrozen(item.answerKey.correct)
      && Object.isFrozen(item.options)
    ))).toBe(true)
  })

  it('materializes sequential practice without answer keys or explanations', () => {
    const result = materializeElearningQuestionPractice(snapshot(), {
      mode: 'sequential',
      sessionId: SESSION_1,
    })
    expect(result).toEqual({
      domain: ELEARNING_QUESTION_PRACTICE_DOMAIN,
      mode: 'sequential',
      practiceId: PRACTICE_ID,
      practiceRevisionId: PRACTICE_REVISION_ID,
      questions: [
        {
          options: question(0).options,
          points: 1,
          position: 1,
          prompt: 'Question 1',
          questionRevisionId: REVISION_IDS[0],
          questionType: 'single_choice',
        },
        {
          options: question(1).options,
          points: 1,
          position: 2,
          prompt: 'Question 2',
          questionRevisionId: REVISION_IDS[1],
          questionType: 'multiple_choice',
        },
        {
          options: question(2).options,
          points: 1,
          position: 3,
          prompt: 'Question 3',
          questionRevisionId: REVISION_IDS[2],
          questionType: 'single_choice',
        },
        {
          options: question(3).options,
          points: 1,
          position: 4,
          prompt: 'Question 4',
          questionRevisionId: REVISION_IDS[3],
          questionType: 'single_choice',
        },
      ],
      sessionId: SESSION_1,
      version: 1,
    })
    expect(JSON.stringify(result)).not.toContain('answerKey')
    expect(JSON.stringify(result)).not.toContain('explanation')
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.questions)).toBe(true)
    expect(result.questions.every((item) => Object.isFrozen(item.options))).toBe(true)
  })

  it('uses the server session as a deterministic random-order seed', () => {
    const first = materializeElearningQuestionPractice(snapshot(), {
      mode: 'random',
      sessionId: SESSION_1,
    })
    const replay = materializeElearningQuestionPractice(snapshot(), {
      mode: 'random',
      sessionId: SESSION_1,
    })
    const nextSession = materializeElearningQuestionPractice(snapshot(), {
      mode: 'random',
      sessionId: SESSION_2,
    })
    const ids = (value: typeof first) => value.questions.map((item) => item.questionRevisionId)
    expect(ids(replay)).toEqual(ids(first))
    expect(ids(first)).not.toEqual(REVISION_IDS)
    expect(ids(nextSession)).not.toEqual(ids(first))
    expect(first.questions.map((item) => item.position)).toEqual([1, 2, 3, 4])
  })

  it('intersects a wrong book with the authorized practice snapshot', () => {
    const result = materializeElearningQuestionPractice(snapshot(), {
      mode: 'wrong_book',
      sessionId: SESSION_1,
      wrongQuestionRevisionIds: [
        REVISION_IDS[2],
        '30000000-0000-4000-8000-000000000099',
        REVISION_IDS[0],
      ],
    })
    expect(result.questions.map((item) => item.questionRevisionId)).toEqual([
      REVISION_IDS[0],
      REVISION_IDS[2],
    ])
    expect(result.questions.map((item) => item.position)).toEqual([1, 2])
  })

  it('returns no wrong-book intent for a correct answer', () => {
    expect(evaluateElearningQuestionPracticeAnswer(snapshot(), answer())).toEqual({
      correct: true,
      practiceRevisionId: PRACTICE_REVISION_ID,
      questionRevisionId: REVISION_IDS[0],
      wrongBookIntent: null,
    })
    expect(evaluateElearningQuestionPracticeAnswer(snapshot(), answer({
      questionRevisionId: REVISION_IDS[1],
      selectedOptionIds: ['a', 'b'],
    }))).toMatchObject({ correct: true, wrongBookIntent: null })
  })

  it('derives an answer-free idempotent wrong-book intent', () => {
    const first = evaluateElearningQuestionPracticeAnswer(snapshot(), answer({
      selectedOptionIds: ['b'],
    }))
    const replay = evaluateElearningQuestionPracticeAnswer(snapshot(), answer({
      selectedOptionIds: ['c'],
    }))
    expect(first).toEqual({
      correct: false,
      practiceRevisionId: PRACTICE_REVISION_ID,
      questionRevisionId: REVISION_IDS[0],
      wrongBookIntent: {
        entryKey: expect.stringMatching(
          new RegExp(`^${ELEARNING_QUESTION_PRACTICE_DOMAIN}:entry:[a-f0-9]{64}$`),
        ),
        kind: 'practice_wrong_answer',
        occurrenceKey: expect.stringMatching(
          new RegExp(`^${ELEARNING_QUESTION_PRACTICE_DOMAIN}:occurrence:[a-f0-9]{64}$`),
        ),
        payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        reference: {
          orgId: 'org-1',
          practiceId: PRACTICE_ID,
          practiceRevisionId: PRACTICE_REVISION_ID,
          questionRevisionId: REVISION_IDS[0],
          sessionId: SESSION_1,
          userId: 'learner-1',
        },
      },
    })
    expect(replay.wrongBookIntent).toEqual(first.wrongBookIntent)
    expect(JSON.stringify(first)).not.toContain('selectedOptionIds')
    expect(JSON.stringify(first)).not.toContain('answerKey')
    expect(JSON.stringify(first)).not.toContain('explanation')
  })

  it('keeps entry identity stable across sessions but occurrences distinct', () => {
    const first = evaluateElearningQuestionPracticeAnswer(snapshot(), answer({
      selectedOptionIds: [],
    })).wrongBookIntent
    const next = evaluateElearningQuestionPracticeAnswer(snapshot(), answer({
      selectedOptionIds: [],
      sessionId: SESSION_2,
    })).wrongBookIntent
    expect(next?.entryKey).toBe(first?.entryKey)
    expect(next?.occurrenceKey).not.toBe(first?.occurrenceKey)
    expect(next?.payloadDigest).not.toBe(first?.payloadDigest)
  })

  it('scopes wrong-book entry identity by org, user, practice, and question', () => {
    const key = (
      snapshotInput: unknown,
      answerInput: unknown,
    ) => evaluateElearningQuestionPracticeAnswer(
      snapshotInput,
      answerInput,
    ).wrongBookIntent?.entryKey
    const original = key(snapshot(), answer({ selectedOptionIds: [] }))
    const values = [
      key(snapshot({ orgId: 'org-2' }), answer({ selectedOptionIds: [] })),
      key(snapshot(), answer({ selectedOptionIds: [], userId: 'learner-2' })),
      key(snapshot({ practiceId: '10000000-0000-4000-8000-000000000009' }), answer({
        selectedOptionIds: [],
      })),
      key(snapshot(), answer({
        questionRevisionId: REVISION_IDS[2],
        selectedOptionIds: [],
      })),
    ]
    expect(new Set([original, ...values]).size).toBe(5)
  })

  it('rejects invalid answers and unknown questions fail-closed', () => {
    expectCode(() => evaluateElearningQuestionPracticeAnswer(snapshot(), answer({
      questionRevisionId: '30000000-0000-4000-8000-000000000099',
    })), 'question_not_found')
    for (const selectedOptionIds of [
      'a',
      ['unknown'],
      ['a', 'a'],
      ['a', 'b'],
      [1],
    ]) {
      expectCode(() => evaluateElearningQuestionPracticeAnswer(snapshot(), answer({
        selectedOptionIds,
      })), 'invalid_request')
    }
  })

  it('rejects malformed modes and wrong-book request shapes', () => {
    for (const request of [
      { mode: 'unsupported', sessionId: SESSION_1 },
      { mode: 'sequential', sessionId: SESSION_1, wrongQuestionRevisionIds: [] },
      { mode: 'wrong_book', sessionId: SESSION_1 },
      {
        mode: 'wrong_book',
        sessionId: SESSION_1,
        wrongQuestionRevisionIds: [REVISION_IDS[0], REVISION_IDS[0]],
      },
      {
        mode: 'wrong_book',
        sessionId: SESSION_1,
        wrongQuestionRevisionIds: ['not-a-uuid'],
      },
    ]) {
      expectCode(() => materializeElearningQuestionPractice(snapshot(), request), 'invalid_request')
    }
  })

  it('rejects non-objective, duplicate, empty, oversized, and malformed snapshots', () => {
    expectCode(() => createElearningQuestionPracticeSnapshot(snapshot({
      questions: [question(0, {
        answerKey: {},
        options: [],
        questionType: 'short_answer',
      })],
    })), 'invalid_snapshot')
    expectCode(() => createElearningQuestionPracticeSnapshot(snapshot({
      questions: [question(0), question(1, { position: 1 })],
    })), 'invalid_snapshot')
    expectCode(() => createElearningQuestionPracticeSnapshot(snapshot({
      questions: [question(0), question(1, { questionRevisionId: REVISION_IDS[0] })],
    })), 'invalid_snapshot')
    expectCode(() => createElearningQuestionPracticeSnapshot(snapshot({ questions: [] })), (
      'invalid_snapshot'
    ))
    expectCode(() => createElearningQuestionPracticeSnapshot(snapshot({
      questions: Array.from({ length: 2_001 }, (_, index) => question(0, {
        position: index + 1,
        questionRevisionId: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      })),
    })), 'invalid_snapshot')
    for (const input of [
      null,
      {},
      snapshot({ domain: SENTINEL }),
      snapshot({ version: 2 }),
      { ...snapshot(), extra: SENTINEL },
    ]) {
      expectCode(() => createElearningQuestionPracticeSnapshot(input), 'invalid_snapshot')
    }
  })

  it('rejects sparse arrays and hostile accessors values-free', () => {
    expectCode(() => createElearningQuestionPracticeSnapshot(snapshot({
      questions: new Array(1),
    })), 'invalid_snapshot')
    expectCode(() => materializeElearningQuestionPractice(snapshot(), {
      mode: 'wrong_book',
      sessionId: SESSION_1,
      wrongQuestionRevisionIds: new Array(1),
    }), 'invalid_request')

    const hostile = Object.defineProperty(snapshot(), 'orgId', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => createElearningQuestionPracticeSnapshot(hostile), 'invalid_snapshot')
    const hostileQuestion = Object.defineProperty(question(0), 'questionType', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => createElearningQuestionPracticeSnapshot(snapshot({
      questions: [hostileQuestion],
    })), 'invalid_snapshot')
    const hostileRequest = Object.defineProperty({}, 'mode', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => materializeElearningQuestionPractice(
      snapshot(),
      hostileRequest,
    ), 'invalid_request')
  })
})
