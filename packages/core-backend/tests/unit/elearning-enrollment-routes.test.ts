import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

import { createElearningEnrollmentRouter } from '../../src/routes/elearning-enrollment'
import {
  ElearningCourseEnrollmentError,
  type ElearningCourseEnrollmentDb,
  type EnrollElearningCourseInput,
} from '../../src/services/elearning-course-enrollment'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-enrollment-route'
const USER = 'user-enrollment-route'
const COURSE = '11111111-1111-4111-8111-111111111111'
const VERSION = '22222222-2222-4222-8222-222222222222'
const REQUEST = '33333333-3333-4333-8333-333333333333'
const ENROLLMENT = '44444444-4444-4444-8444-444444444444'
const FLAGS = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ENROLLMENT_ENABLED: 'true',
} as NodeJS.ProcessEnv

function db(): ElearningCourseEnrollmentDb {
  return {
    transaction: async (handler) => handler({
      query: async () => ({ rows: [], rowCount: 0 }),
    }),
  }
}

function app(input: {
  env?: NodeJS.ProcessEnv
  viewerId?: string | null
  orgId?: string | null
  enroll?: (value: EnrollElearningCourseInput) => Promise<{
    enrollmentId: string
    courseId: string
    courseVersionId: string
    status: 'enrolled'
    enrolledAt: string
  }>
  guard?: 'allow' | 'deny'
} = {}): express.Express {
  const router = createElearningEnrollmentRouter({
    db: db(),
    env: input.env ?? FLAGS,
    viewerId: () => input.viewerId === undefined ? USER : input.viewerId,
    orgId: () => input.orgId === undefined ? ORG : input.orgId,
    readGuard: (_req, res, next) => {
      if (input.guard === 'deny') {
        res.status(403).json({ error: 'forbidden' })
        return
      }
      next()
    },
    enrollElearningCourse: async (_db, value) => input.enroll?.(value) ?? {
      enrollmentId: ENROLLMENT,
      courseId: COURSE,
      courseVersionId: VERSION,
      status: 'enrolled',
      enrolledAt: '2026-09-01T04:00:00.000Z',
    },
  })
  return express().use(router ?? RouterNever())
}

function RouterNever(): express.Router {
  return express.Router()
}

describe('online enrollment route', () => {
  const pinned = usePinnedServer()
  const api = (input: Parameters<typeof app>[0] = {}) => {
    pinned.setApp(app(input))
    return request(pinned.url())
  }

  it('injects server org/user and returns the closed enrollment result', async () => {
    const enroll = vi.fn(async () => ({
      enrollmentId: ENROLLMENT,
      courseId: COURSE,
      courseVersionId: VERSION,
      status: 'enrolled' as const,
      enrolledAt: '2026-09-01T04:00:00.000Z',
    }))
    const response = await api({ enroll })
      .post(`/api/elearning/me/courses/${COURSE}/enrollments`)
      .send({ requestId: REQUEST })
      .expect(201)
    expect(response.body).toEqual({
      enrollmentId: ENROLLMENT,
      courseId: COURSE,
      courseVersionId: VERSION,
      status: 'enrolled',
      enrolledAt: '2026-09-01T04:00:00.000Z',
    })
    expect(enroll).toHaveBeenCalledWith({
      orgId: ORG,
      userId: USER,
      requestId: REQUEST,
      courseId: COURSE,
    })
  })

  it('rejects unknown or client-owned identity fields before the service', async () => {
    const enroll = vi.fn()
    for (const body of [
      {},
      { requestId: 'bad' },
      { requestId: REQUEST, userId: 'forged' },
      { requestId: REQUEST, orgId: 'forged' },
    ]) {
      await api({ enroll: enroll as never })
        .post(`/api/elearning/me/courses/${COURSE}/enrollments`)
        .send(body)
        .expect(400, { error: 'invalid_input' })
    }
    expect(enroll).not.toHaveBeenCalled()
  })

  it('fails closed before parsing for flags, identity, org, and RBAC', async () => {
    const path = `/api/elearning/me/courses/${COURSE}/enrollments`
    for (const value of [undefined, 'false', 'TRUE', 'true ']) {
      await api({ env: { ...FLAGS, ELEARNING_ENROLLMENT_ENABLED: value } })
        .post(path).send({ requestId: REQUEST }).expect(404)
    }
    await api({ viewerId: null }).post(path).send({ requestId: REQUEST })
      .expect(401, { error: 'unauthenticated' })
    await api({ orgId: null }).post(path).send({ requestId: REQUEST })
      .expect(403, { error: 'ORG_CONTEXT_REQUIRED' })
    await api({ guard: 'deny' }).post(path).send({ requestId: REQUEST })
      .expect(403, { error: 'forbidden' })
  })

  it.each([
    ['not_found', 404],
    ['not_enrollable', 403],
    ['already_assigned', 409],
    ['conflict', 409],
    ['unavailable', 503],
  ] as const)('maps %s to a values-free response', async (code, status) => {
    await api({
      enroll: async () => { throw new ElearningCourseEnrollmentError(code) },
    }).post(`/api/elearning/me/courses/${COURSE}/enrollments`)
      .send({ requestId: REQUEST })
      .expect(status, { error: code })
  })
})
