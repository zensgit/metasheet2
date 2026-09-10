import { afterEach, describe, expect, it, vi } from 'vitest'

import { ElearningApiError } from '../src/services/elearning'
import { getMyElearningLearningProfile } from '../src/services/elearningProfile'
import { apiFetch } from '../src/utils/api'

vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))
const mockedFetch = vi.mocked(apiFetch)

const COURSE = '11111111-1111-4111-8111-111111111111'
const VERSION = '22222222-2222-4222-8222-222222222222'
const ITEM = '33333333-3333-4333-8333-333333333333'

function response(payload: unknown, status = 200): Response {
  return { status, json: async () => payload } as Response
}

function payload() {
  return {
    userId: 'learner-1',
    summary: { completedCourses: 1, assessmentCourses: 1, contentCourses: 0 },
    courses: [{
      courseId: COURSE,
      courseVersionId: VERSION,
      title: 'Assessment course',
      kind: 'assessment',
      completedAt: '2026-08-30T01:30:00.000Z',
      exams: [{
        itemId: ITEM,
        earnedScore: 9,
        totalScore: 10,
        passedAt: '2026-08-30T01:30:00.000Z',
      }],
    }],
    nextCursor: 'cursor_2',
  }
}

afterEach(() => vi.clearAllMocks())

describe('e-learning learning profile client', () => {
  it('parses the closed assessment/content union and sends an opaque cursor', async () => {
    mockedFetch.mockResolvedValue(response(payload()))
    await expect(getMyElearningLearningProfile('cursor_1', 25)).resolves.toEqual(payload())
    expect(mockedFetch).toHaveBeenCalledWith(
      '/api/elearning/profile?limit=25&cursor=cursor_1',
      { method: 'GET' },
    )

    mockedFetch.mockResolvedValue(response({
      userId: 'learner-1',
      summary: { completedCourses: 1, assessmentCourses: 0, contentCourses: 1 },
      courses: [{
        courseId: COURSE,
        courseVersionId: VERSION,
        title: 'Article course',
        kind: 'content',
        completedAt: '2026-08-30T01:30:00.000Z',
      }],
      nextCursor: null,
    }))
    await expect(getMyElearningLearningProfile()).resolves.toMatchObject({
      courses: [{ kind: 'content' }],
    })
  })

  it.each([
    ['extra top-level key', () => ({ ...payload(), secret: true })],
    ['answers leak', () => ({ ...payload(), answers: {} })],
    ['invalid summary', () => ({
      ...payload(),
      summary: { completedCourses: 1, assessmentCourses: 1, contentCourses: 1 },
    })],
    ['impossible timestamp', () => ({
      ...payload(),
      courses: [{ ...payload().courses[0], completedAt: '2026-02-30T01:30:00.000Z' }],
    })],
    ['assessment without exams', () => ({
      ...payload(),
      courses: [{ ...payload().courses[0], exams: [] }],
    })],
    ['content with assessment fields', () => ({
      ...payload(),
      courses: [{ ...payload().courses[0], kind: 'content' }],
    })],
    ['score above total', () => ({
      ...payload(),
      courses: [{
        ...payload().courses[0],
        exams: [{ ...payload().courses[0].exams[0], earnedScore: 11 }],
      }],
    })],
  ])('rejects %s fail-closed', async (_label, makePayload) => {
    mockedFetch.mockResolvedValue(response(makePayload()))
    await expect(getMyElearningLearningProfile()).rejects.toEqual(
      new ElearningApiError('invalid_response', 200),
    )
  })

  it('keeps transport and values-free server errors closed', async () => {
    mockedFetch.mockResolvedValue(response({ error: 'forbidden', detail: 'secret' }, 403))
    await expect(getMyElearningLearningProfile()).rejects.toEqual(
      new ElearningApiError('forbidden', 403),
    )
    mockedFetch.mockRejectedValue(new Error('network detail'))
    await expect(getMyElearningLearningProfile()).rejects.toEqual(
      new ElearningApiError('network_error', 0),
    )
  })
})
