import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import {
  createElearningPracticeRequestIds,
  createElearningPracticeSet,
  listElearningPracticeSets,
  listElearningWrongQuestions,
  startElearningPracticeSession,
  submitElearningPracticeAnswer,
} from '../src/services/elearningPractice'

const SET = '11111111-1111-4111-8111-111111111111'
const PAPER = '22222222-2222-4222-8222-222222222222'
const SESSION = '33333333-3333-4333-8333-333333333333'
const QUESTION = '44444444-4444-4444-8444-444444444444'
const REVISION = '55555555-5555-4555-8555-555555555555'
const ANSWER = '66666666-6666-4666-8666-666666666666'
const REQUEST_A = '77777777-7777-4777-8777-777777777777'
const REQUEST_B = '88888888-8888-4888-8888-888888888888'
const REQUEST_C = '99999999-9999-4999-8999-999999999999'
const CREATED = '2026-08-30T01:02:03.456Z'

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function set(over: Record<string, unknown> = {}) {
  return {
    practiceSetId: SET,
    paperId: PAPER,
    title: 'Safety practice',
    status: 'active',
    createdAt: CREATED,
    ...over,
  }
}

function question(over: Record<string, unknown> = {}) {
  return {
    questionId: QUESTION,
    questionRevisionId: REVISION,
    questionType: 'single_choice',
    prompt: 'Choose one',
    options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
    points: 1,
    position: 1,
    ...over,
  }
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe('e-learning practice client', () => {
  it('sends closed commands and parses new and replay results', async () => {
    apiFetchMock.mockResolvedValueOnce(response(201, { ...set(), duplicate: false }))
    await expect(createElearningPracticeSet({
      requestId: REQUEST_A,
      paperId: PAPER,
      title: 'Safety practice',
    })).resolves.toEqual({ ...set(), duplicate: false })
    expect(JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      requestId: REQUEST_A,
      paperId: PAPER,
      title: 'Safety practice',
    })

    apiFetchMock.mockResolvedValueOnce(response(200, {
      sessionId: SESSION,
      practiceSetId: SET,
      mode: 'sequential',
      questions: [question()],
      createdAt: CREATED,
      duplicate: true,
    }))
    await expect(startElearningPracticeSession({
      requestId: REQUEST_B,
      practiceSetId: SET,
      mode: 'sequential',
    })).resolves.toMatchObject({ sessionId: SESSION, duplicate: true })

    apiFetchMock.mockResolvedValueOnce(response(200, {
      answerId: ANSWER,
      sessionId: SESSION,
      questionRevisionId: REVISION,
      correct: false,
      wrongState: 'wrong',
      createdAt: CREATED,
      duplicate: false,
    }))
    await expect(submitElearningPracticeAnswer(SESSION, {
      requestId: REQUEST_A,
      questionRevisionId: REVISION,
      selectedOptionIds: ['a'],
    })).resolves.toMatchObject({ correct: false, wrongState: 'wrong' })
  })

  it('parses exact set and wrong-question lists without leaking answer material', async () => {
    apiFetchMock.mockResolvedValueOnce(response(200, { practiceSets: [set()] }))
    await expect(listElearningPracticeSets()).resolves.toEqual({ practiceSets: [set()] })

    apiFetchMock.mockResolvedValueOnce(response(200, {
      practiceSetId: SET,
      questions: [question()],
    }))
    await expect(listElearningWrongQuestions(SET)).resolves.toEqual({
      practiceSetId: SET,
      questions: [question()],
    })

    for (const forbidden of ['answerKey', 'answer_key', 'correctOptionIds', 'explanation']) {
      apiFetchMock.mockResolvedValueOnce(response(200, {
        practiceSetId: SET,
        questions: [question({ [forbidden]: ['a'] })],
      }))
      await expect(listElearningWrongQuestions(SET)).rejects.toMatchObject({
        code: 'invalid_response',
        status: 200,
      })
    }
  })

  it.each([
    question({ position: 2 }),
    question({ extra: true }),
    question({ questionType: 'short_answer' }),
    question({ options: [{ id: 'a', text: 'A' }, { id: 'a', text: 'Again' }] }),
  ])('rejects malformed public question %#', async (badQuestion) => {
    apiFetchMock.mockResolvedValueOnce(response(200, {
      sessionId: SESSION,
      practiceSetId: SET,
      mode: 'sequential',
      questions: [badQuestion],
      createdAt: CREATED,
      duplicate: false,
    }))
    await expect(startElearningPracticeSession({
      requestId: REQUEST_A,
      practiceSetId: SET,
      mode: 'sequential',
    })).rejects.toMatchObject({ code: 'invalid_response', status: 200 })
  })

  it.each(['2026-02-31T01:02:03.456Z', '2026-08-30T01:02:03Z']) (
    'rejects noncanonical timestamps: %s',
    async (createdAt) => {
      apiFetchMock.mockResolvedValueOnce(response(200, { practiceSets: [set({ createdAt })] }))
      await expect(listElearningPracticeSets()).rejects.toMatchObject({
        code: 'invalid_response',
        status: 200,
      })
    },
  )

  it('keeps request ids for same logical retries and rotates when payload changes', () => {
    const randomUuid = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(REQUEST_A)
      .mockReturnValueOnce(REQUEST_B)
      .mockReturnValueOnce(ANSWER)
      .mockReturnValue(REQUEST_C)
    const ids = createElearningPracticeRequestIds()
    expect(ids.forSet(PAPER, ' Safety practice ')).toBe(REQUEST_A)
    expect(ids.forSet(PAPER, 'Safety practice')).toBe(REQUEST_A)
    expect(ids.forSet(PAPER, 'Changed')).toBe(REQUEST_B)
    expect(ids.forAnswer(SESSION, REVISION, ['b', 'a'])).toBe(ANSWER)
    expect(ids.forAnswer(SESSION, REVISION, ['a', 'b'])).toBe(ANSWER)
    expect(ids.forAnswer(SESSION, REVISION, ['a'])).toBe(REQUEST_C)
    randomUuid.mockRestore()
  })

  it('preserves values-free stable errors', async () => {
    apiFetchMock.mockResolvedValueOnce(response(409, { error: 'conflict', value: PAPER }))
    await expect(createElearningPracticeSet({
      requestId: REQUEST_A,
      paperId: PAPER,
      title: 'Safety practice',
    })).rejects.toMatchObject({ code: 'request_failed', status: 409 })
  })
})
