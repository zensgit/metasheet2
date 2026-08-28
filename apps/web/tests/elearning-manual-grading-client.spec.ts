import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import { ElearningApiError } from '../src/services/elearning'
import {
  ELEARNING_MANUAL_GRADE_COMMENT_MAX,
  ELEARNING_MANUAL_GRADING_PAGE_SIZE_MAX,
  getElearningManualGradingDetail,
  listElearningManualGradingQueue,
  submitElearningManualGrade,
} from '../src/services/elearningManualGrading'

const ATTEMPT = '88888888-8888-4888-8888-888888888888'
const EXAM = '55555555-5555-4555-8555-555555555555'
const COURSE = '11111111-1111-4111-8111-111111111111'
const Q1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const REQUEST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const SUBMITTED_AT = '2026-08-26T00:00:00.000Z'
const GRADED_AT = '2026-08-26T01:00:00.000Z'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function lastCall(): { path: string; options: RequestInit } {
  const [path, options] = apiFetchMock.mock.calls.at(-1) ?? []
  return { path: String(path), options: (options ?? {}) as RequestInit }
}

function lastJson(): Record<string, unknown> {
  const { options } = lastCall()
  return JSON.parse(String(options.body ?? '{}')) as Record<string, unknown>
}

function queueItem(over: Record<string, unknown> = {}) {
  return {
    attemptId: ATTEMPT,
    userId: 'user-1',
    examId: EXAM,
    examTitle: 'Safety exam',
    courseId: COURSE,
    courseTitle: 'Safety course',
    attemptNo: 1,
    submittedAt: SUBMITTED_AT,
    autoScore: 6,
    manualScore: 0,
    paperMaxScore: 20,
    gradedQuestions: 0,
    manualQuestions: 1,
    ...over,
  }
}

function questionDetail(over: Record<string, unknown> = {}) {
  return {
    questionRevisionId: Q1,
    position: 1,
    prompt: 'Explain briefly',
    points: 10,
    learnerAnswer: 'my answer',
    grade: null,
    ...over,
  }
}

function detail(over: Record<string, unknown> = {}) {
  return {
    attemptId: ATTEMPT,
    userId: 'user-1',
    examId: EXAM,
    examTitle: 'Safety exam',
    courseId: COURSE,
    courseTitle: 'Safety course',
    attemptNo: 1,
    status: 'awaiting_manual',
    submittedAt: SUBMITTED_AT,
    autoScore: 6,
    manualScore: 0,
    paperMaxScore: 20,
    passScore: 12,
    gradedQuestions: 0,
    manualQuestions: 1,
    questions: [questionDetail()],
    ...over,
  }
}

function submitResult(over: Record<string, unknown> = {}) {
  return {
    attemptId: ATTEMPT,
    questionRevisionId: Q1,
    score: 8,
    maxScore: 10,
    status: 'awaiting_manual',
    gradedQuestions: 1,
    manualQuestions: 2,
    autoScore: 6,
    manualScore: 8,
    totalScore: 20,
    passed: null,
    duplicate: false,
    ...over,
  }
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('elearning manual grading client: queue', () => {
  it('GETs the queue with page/pageSize query params and parses the exact DTO', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      items: [queueItem()],
      page: 1,
      pageSize: 20,
      hasMore: true,
    }))
    const result = await listElearningManualGradingQueue()
    expect(lastCall().path).toBe('/api/elearning/assessment/manual-grading/attempts?page=1&pageSize=20')
    expect(lastCall().options.method).toBe('GET')
    expect(lastCall().options.body).toBeUndefined()
    expect(result).toEqual({
      items: [queueItem()],
      page: 1,
      pageSize: 20,
      hasMore: true,
    })
  })

  it('sends the requested page/pageSize verbatim', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [], page: 3, pageSize: 50, hasMore: false }))
    await listElearningManualGradingQueue(3, 50)
    expect(lastCall().path).toBe('/api/elearning/assessment/manual-grading/attempts?page=3&pageSize=50')
  })

  it('fails closed before any network call when page/pageSize are out of bounds', async () => {
    await expect(listElearningManualGradingQueue(0)).rejects.toMatchObject({ code: 'invalid_input', status: 400 })
    await expect(listElearningManualGradingQueue(1, ELEARNING_MANUAL_GRADING_PAGE_SIZE_MAX + 1)).rejects.toMatchObject({
      code: 'invalid_input',
      status: 400,
    })
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('rejects a queue item carrying rubric/answerKey/explanation but accepts the same item without it', async () => {
    for (const poison of [
      { rubric: 'give 5 for correctness' },
      { answerKey: 'foo' },
      { explanation: 'because' },
    ]) {
      apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
        items: [{ ...queueItem(), ...poison }],
        page: 1,
        pageSize: 20,
        hasMore: false,
      }))
      await expect(listElearningManualGradingQueue()).rejects.toMatchObject({
        code: 'invalid_response',
        status: 200,
      })
    }
    // Positive control: the same shape without the injected key parses fine —
    // proves the rejection above is caused by the forbidden key, not some
    // unrelated shape mismatch.
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      items: [queueItem()],
      page: 1,
      pageSize: 20,
      hasMore: false,
    }))
    await expect(listElearningManualGradingQueue()).resolves.toMatchObject({ items: [queueItem()] })
  })

  it('rejects an extra top-level key and a missing required key', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      items: [queueItem()],
      page: 1,
      pageSize: 20,
      hasMore: false,
      total: 1,
    }))
    await expect(listElearningManualGradingQueue()).rejects.toMatchObject({ code: 'invalid_response', status: 200 })

    const { hasMore: _hasMore, ...withoutHasMore } = { items: [queueItem()], page: 1, pageSize: 20, hasMore: false }
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, withoutHasMore))
    await expect(listElearningManualGradingQueue()).rejects.toMatchObject({ code: 'invalid_response', status: 200 })
  })

  it('rejects response page/pageSize values outside the client contract instead of clamping them', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      items: [],
      page: 10_001,
      pageSize: 20,
      hasMore: false,
    }))
    await expect(listElearningManualGradingQueue()).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, {
      items: [],
      page: 1,
      pageSize: ELEARNING_MANUAL_GRADING_PAGE_SIZE_MAX + 1,
      hasMore: false,
    }))
    await expect(listElearningManualGradingQueue()).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })

  it('surfaces 403/404/503 by status and code, and ORG_CONTEXT_REQUIRED verbatim', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'scope_required' }))
    await expect(listElearningManualGradingQueue()).rejects.toMatchObject({ code: 'scope_required', status: 403 })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'ORG_CONTEXT_REQUIRED' }))
    await expect(listElearningManualGradingQueue()).rejects.toMatchObject({ code: 'ORG_CONTEXT_REQUIRED', status: 403 })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(404, {}))
    await expect(listElearningManualGradingQueue()).rejects.toMatchObject({ status: 404 })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }))
    await expect(listElearningManualGradingQueue()).rejects.toMatchObject({ code: 'unavailable', status: 503 })
  })
})

describe('elearning manual grading client: attempt detail', () => {
  it('GETs the detail endpoint and parses the exact DTO', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, detail()))
    const result = await getElearningManualGradingDetail(ATTEMPT)
    expect(lastCall().path).toBe(`/api/elearning/assessment/manual-grading/attempts/${ATTEMPT}`)
    expect(lastCall().options.method).toBe('GET')
    expect(result).toEqual(detail())
  })

  it('accepts an already-graded question and rejects a graded sub-object missing a key', async () => {
    const graded = detail({
      gradedQuestions: 1,
      questions: [questionDetail({
        grade: { score: 8, maxScore: 10, comment: 'good effort', graderId: 'grader-1', gradedAt: GRADED_AT },
      })],
    })
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, graded))
    await expect(getElearningManualGradingDetail(ATTEMPT)).resolves.toEqual(graded)

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, detail({
      questions: [questionDetail({
        grade: { score: 8, maxScore: 10, comment: null, graderId: 'grader-1' },
      })],
    })))
    await expect(getElearningManualGradingDetail(ATTEMPT)).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })

  it('rejects a detail payload carrying rubric, a raw paperSnapshot, or another learner shape leak', async () => {
    for (const poison of [
      { rubric: 'grading rubric text' },
      { paperSnapshot: { questions: [] } },
      { regradeHistory: [] },
    ]) {
      apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { ...detail(), ...poison }))
      await expect(getElearningManualGradingDetail(ATTEMPT)).rejects.toMatchObject({
        code: 'invalid_response',
        status: 200,
      })
    }
  })

  it('rejects a status other than awaiting_manual and an empty questions array', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, detail({ status: 'graded' })))
    await expect(getElearningManualGradingDetail(ATTEMPT)).rejects.toMatchObject({ code: 'invalid_response', status: 200 })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, detail({ questions: [] })))
    await expect(getElearningManualGradingDetail(ATTEMPT)).rejects.toMatchObject({ code: 'invalid_response', status: 200 })
  })

  it('fails closed before any network call on a non-UUID attemptId', async () => {
    await expect(getElearningManualGradingDetail('not-a-uuid')).rejects.toMatchObject({
      code: 'invalid_input',
      status: 400,
    })
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('surfaces 403/404/503 for the detail endpoint', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'scope_required' }))
    await expect(getElearningManualGradingDetail(ATTEMPT)).rejects.toMatchObject({ code: 'scope_required', status: 403 })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'not_found' }))
    await expect(getElearningManualGradingDetail(ATTEMPT)).rejects.toMatchObject({ code: 'not_found', status: 404 })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }))
    await expect(getElearningManualGradingDetail(ATTEMPT)).rejects.toMatchObject({ code: 'unavailable', status: 503 })
  })
})

describe('elearning manual grading client: submit', () => {
  function submitInput(over: Record<string, unknown> = {}) {
    return {
      requestId: REQUEST,
      questionRevisionId: Q1,
      score: 8,
      comment: 'good effort',
      ...over,
    } as { requestId: string; questionRevisionId: string; score: number; comment: string | null }
  }

  it('fails closed before any network call on an invalid request payload', async () => {
    for (const invalid of [
      { requestId: 'not-a-uuid' },
      { questionRevisionId: 'not-a-uuid' },
      { score: -1 },
      { score: 1.5 },
      { score: '8' },
      { comment: 'x'.repeat(ELEARNING_MANUAL_GRADE_COMMENT_MAX + 1) },
    ]) {
      await expect(submitElearningManualGrade(
        ATTEMPT,
        submitInput(invalid),
      )).rejects.toMatchObject({ code: 'invalid_input', status: 400 })
    }
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('POSTs the exact four-key body, always including comment (even when null)', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, submitResult()))
    await submitElearningManualGrade(ATTEMPT, submitInput())
    expect(lastCall().path).toBe(`/api/elearning/assessment/attempts/${ATTEMPT}/manual-grades`)
    expect(lastCall().options.method).toBe('POST')
    expect(lastJson()).toEqual({
      requestId: REQUEST,
      questionRevisionId: Q1,
      score: 8,
      comment: 'good effort',
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, submitResult()))
    await submitElearningManualGrade(ATTEMPT, submitInput({ comment: null }))
    expect(lastJson()).toEqual({
      requestId: REQUEST,
      questionRevisionId: Q1,
      score: 8,
      comment: null,
    })
    expect(Object.keys(lastJson())).toHaveLength(4)
  })

  it('parses the exact submit-result DTO, including a duplicate=true response', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, submitResult()))
    await expect(submitElearningManualGrade(ATTEMPT, submitInput())).resolves.toEqual(submitResult())

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, submitResult({ duplicate: true })))
    await expect(submitElearningManualGrade(ATTEMPT, submitInput())).resolves.toMatchObject({ duplicate: true })
  })

  it('parses a finalizing response with status=graded and a non-null passed', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, submitResult({
      status: 'graded',
      gradedQuestions: 2,
      manualQuestions: 2,
      passed: true,
    })))
    await expect(submitElearningManualGrade(ATTEMPT, submitInput())).resolves.toMatchObject({
      status: 'graded',
      passed: true,
    })
  })

  it('rejects a submit result leaking learnerAnswer or a grader comment', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { ...submitResult(), learnerAnswer: 'leak' }))
    await expect(submitElearningManualGrade(ATTEMPT, submitInput())).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })

  it('fails closed before any network call on a non-UUID attemptId', async () => {
    await expect(submitElearningManualGrade('not-a-uuid', submitInput())).rejects.toMatchObject({
      code: 'invalid_input',
      status: 400,
    })
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('surfaces 409 conflict and 503 unavailable', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(409, { error: 'conflict' }))
    await expect(submitElearningManualGrade(ATTEMPT, submitInput())).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    })

    apiFetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }))
    await expect(submitElearningManualGrade(ATTEMPT, submitInput())).rejects.toMatchObject({
      code: 'unavailable',
      status: 503,
    })
  })

  it('exposes the comment max length constant matching the server contract', () => {
    expect(ELEARNING_MANUAL_GRADE_COMMENT_MAX).toBe(4_000)
  })

  it('rejects only stable lowercase error codes on failure, otherwise request_failed', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(400, { error: 'NOT_LOWERCASE' }))
    await expect(submitElearningManualGrade(ATTEMPT, submitInput())).rejects.toMatchObject({
      code: 'request_failed',
      status: 400,
    })
  })
})

describe('elearning manual grading client: transport-level identity discipline', () => {
  it('never sends orgId/actorId overrides on any request', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [], page: 1, pageSize: 20, hasMore: false }))
    await listElearningManualGradingQueue()

    apiFetchMock.mockResolvedValueOnce(jsonResponse(200, submitResult()))
    await submitElearningManualGrade(ATTEMPT, {
      requestId: REQUEST,
      questionRevisionId: Q1,
      score: 8,
      comment: null,
    })
    expect(JSON.stringify(lastJson())).not.toMatch(/orgId|actorId|userId|isGlobalAdmin/)
  })

  it('uses the ElearningApiError class shared with the rest of the elearning client surface', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }))
    const error = await listElearningManualGradingQueue().catch((cause) => cause)
    expect(error).toBeInstanceOf(ElearningApiError)
  })
})
