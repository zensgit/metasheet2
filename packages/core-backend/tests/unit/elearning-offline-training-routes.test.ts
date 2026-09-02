import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { ElearningOfflineError } from '../../src/services/elearning-offline-training'
import { createElearningOfflineTrainingRouter } from '../../src/routes/elearning-offline-training'
import { usePinnedServer } from '../utils/pinned-server'

const ENABLED = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_OFFLINE_TRAINING_ENABLED: 'true',
  ELEARNING_OFFLINE_QR_SIGNING_SECRET: 'route-test-secret-with-at-least-thirty-two-bytes',
} as NodeJS.ProcessEnv
const TRAINING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const REVISION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TARGET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const REQUEST_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const pinned = usePinnedServer()

function dummyDb() {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async <T>(handler: (tx: never) => Promise<T>) => handler({
      query: async () => ({ rows: [], rowCount: 0 }),
    } as never),
  }
}

function app(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ kind: string; input: unknown }> = []
  const env = { ...ENABLED }
  const router = createElearningOfflineTrainingRouter({
    db: dummyDb(),
    env,
    adminGuard: (_req, _res, next) => next(),
    readGuard: (_req, _res, next) => next(),
    orgId: () => 'org-one',
    viewerId: () => 'user-one',
    isGlobalAdmin: () => true,
    publishElearningOfflineTraining: async (_db, input) => {
      calls.push({ kind: 'publish', input })
      return {
        trainingId: TRAINING_ID,
        revisionId: REVISION_ID,
        title: 'Training',
        location: 'Room',
        attendanceMode: 'training',
        targets: [],
        memberCount: 1,
        registrationEnabled: false,
        createdAt: '2026-09-01T00:00:00.000Z',
        duplicate: false,
      }
    },
    issueElearningOfflineQr: async (_db, input) => {
      calls.push({ kind: 'issue', input })
      return {
        trainingId: TRAINING_ID,
        revisionId: REVISION_ID,
        targetId: TARGET_ID,
        action: 'check_in',
        token: 'opaque-token',
        issuedAt: '2026-09-01T00:00:00.000Z',
        expiresAt: '2026-09-01T00:01:00.000Z',
        duplicate: false,
      }
    },
    setElearningOfflineTrainingStatus: async (_db, input) => {
      calls.push({ kind: 'status', input })
      return {
        trainingId: TRAINING_ID,
        status: 'archived',
        reason: 'Completed cycle',
        changedAt: '2026-09-01T00:02:00.000Z',
        duplicate: false,
      }
    },
    changeElearningOfflineRegistration: async (_db, input) => {
      calls.push({ kind: 'registration', input })
      return {
        trainingId: TRAINING_ID,
        revisionId: REVISION_ID,
        action: 'register',
        status: 'registered',
        changedAt: '2026-09-01T00:03:00.000Z',
        duplicate: false,
      }
    },
    listElearningOfflineRegistrations: async (_db, input) => {
      calls.push({ kind: 'registrations', input })
      return { items: [], nextCursor: null }
    },
    recordElearningOfflineAttendance: async (_db, input) => {
      calls.push({ kind: 'record', input })
      return {
        eventId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        trainingId: TRAINING_ID,
        revisionId: REVISION_ID,
        targetId: TARGET_ID,
        action: 'check_in',
        occurredAt: '2026-09-01T00:00:10.000Z',
        targetStatus: 'checked_in',
        completionStatus: 'in_progress',
        completedTargetCount: 0,
        totalTargetCount: 1,
        duplicate: false,
      }
    },
    listMyElearningOfflineTrainings: async (_db, input) => {
      calls.push({ kind: 'list', input })
      return []
    },
    ...overrides,
  })
  if (!router) return { api: null, calls, env }
  const server = express()
  server.use(router)
  pinned.setApp(server)
  return { api: request(pinned.url()), calls, env }
}

describe('e-learning offline training routes', () => {
  it('publishes only for a global e-learning administrator with server context', async () => {
    const state = app()
    const body = {
      requestId: REQUEST_ID,
      title: 'Training',
      location: 'Room',
      attendanceMode: 'training',
      targets: [],
      memberUserIds: [],
      registrationEnabled: false,
    }
    const response = await state.api!.post('/api/elearning/admin/offline-trainings').send(body)
    expect(response.status).toBe(201)
    expect(response.body).toEqual(expect.objectContaining({
      trainingId: TRAINING_ID,
      revisionId: REVISION_ID,
      duplicate: false,
    }))
    expect(state.calls).toEqual([{
      kind: 'publish',
      input: { orgId: 'org-one', actorId: 'user-one', command: body },
    }])
  })

  it('accepts the bounded 10000-member roster above the small command limit', async () => {
    const state = app()
    const memberUserIds = Array.from({ length: 10_000 }, (_value, index) => (
      `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`
    ))
    const body = {
      requestId: REQUEST_ID,
      title: 'Training',
      location: 'Room',
      attendanceMode: 'training',
      targets: [],
      memberUserIds,
      registrationEnabled: true,
    }
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(64 * 1024)
    const response = await state.api!.post('/api/elearning/admin/offline-trainings').send(body)
    expect(response.status).toBe(201)
    const input = state.calls[0]?.input as { command?: { memberUserIds?: unknown[] } }
    expect(input.command?.memberUserIds).toHaveLength(10_000)
  })

  it('rejects scoped/non-global admins before service execution', async () => {
    const state = app({ isGlobalAdmin: () => false })
    const response = await state.api!.post('/api/elearning/admin/offline-trainings').send({})
    expect(response.status).toBe(403)
    expect(response.body).toEqual({ error: 'forbidden' })
    expect(state.calls).toEqual([])
  })

  it('issues a closed QR command from route parameters', async () => {
    const state = app()
    const response = await state.api!
      .post(`/api/elearning/admin/offline-trainings/${TRAINING_ID}/targets/${TARGET_ID}/qr`)
      .send({ requestId: REQUEST_ID, action: 'check_in' })
    expect(response.status).toBe(201)
    expect(response.body).toEqual({
      trainingId: TRAINING_ID,
      revisionId: REVISION_ID,
      targetId: TARGET_ID,
      action: 'check_in',
      token: 'opaque-token',
      issuedAt: '2026-09-01T00:00:00.000Z',
      expiresAt: '2026-09-01T00:01:00.000Z',
      duplicate: false,
    })
    expect(state.calls[0]).toEqual({
      kind: 'issue',
      input: {
        orgId: 'org-one',
        actorId: 'user-one',
        command: { requestId: REQUEST_ID, action: 'check_in', trainingId: TRAINING_ID, targetId: TARGET_ID },
      },
    })
  })

  it('changes lifecycle status only through the closed global-admin route', async () => {
    const state = app()
    const body = { requestId: REQUEST_ID, status: 'archived', reason: 'Completed cycle' }
    const response = await state.api!
      .post(`/api/elearning/admin/offline-trainings/${TRAINING_ID}/status`)
      .send(body)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      trainingId: TRAINING_ID,
      status: 'archived',
      reason: 'Completed cycle',
      changedAt: '2026-09-01T00:02:00.000Z',
      duplicate: false,
    })
    expect(state.calls).toEqual([{
      kind: 'status',
      input: {
        orgId: 'org-one',
        actorId: 'user-one',
        trainingId: TRAINING_ID,
        command: body,
      },
    }])

    const invalid = await state.api!
      .post(`/api/elearning/admin/offline-trainings/${TRAINING_ID}/status`)
      .send({ ...body, actorId: 'client-controlled' })
    expect(invalid.status).toBe(400)
    expect(invalid.body).toEqual({ error: 'invalid_input' })
  })

  it('records attendance and lists only the authenticated learner context', async () => {
    const state = app()
    const record = await state.api!.post('/api/elearning/me/offline-attendance').send({
      requestId: REQUEST_ID,
      token: 'opaque-token',
    })
    expect(record.status).toBe(200)
    expect(record.body).toEqual(expect.objectContaining({
      eventId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      targetStatus: 'checked_in',
    }))
    const list = await state.api!.get('/api/elearning/me/offline-trainings')
    expect(list.status).toBe(200)
    expect(list.body).toEqual({ trainings: [] })
    expect(state.calls.map((entry) => entry.kind)).toEqual(['record', 'list'])
    expect(state.calls[1]).toEqual({
      kind: 'list',
      input: { orgId: 'org-one', userId: 'user-one' },
    })
  })

  it('registers only the authenticated learner and lists registrations only for global admins', async () => {
    const state = app()
    const body = { requestId: REQUEST_ID, action: 'register' }
    const changed = await state.api!
      .post(`/api/elearning/me/offline-trainings/${TRAINING_ID}/registration`)
      .send(body)
    expect(changed.status).toBe(201)
    expect(changed.body).toEqual(expect.objectContaining({
      trainingId: TRAINING_ID,
      status: 'registered',
    }))
    const listed = await state.api!
      .get(`/api/elearning/admin/offline-trainings/${TRAINING_ID}/registrations?limit=25`)
    expect(listed.status).toBe(200)
    expect(listed.body).toEqual({ items: [], nextCursor: null })
    expect(state.calls).toEqual([{
      kind: 'registration',
      input: {
        orgId: 'org-one',
        userId: 'user-one',
        trainingId: TRAINING_ID,
        command: body,
      },
    }, {
      kind: 'registrations',
      input: {
        orgId: 'org-one',
        trainingId: TRAINING_ID,
        afterUserId: undefined,
        limit: 25,
      },
    }])

    const forbidden = app({ isGlobalAdmin: () => false })
    const response = await forbidden.api!
      .get(`/api/elearning/admin/offline-trainings/${TRAINING_ID}/registrations`)
    expect(response.status).toBe(403)
    expect(forbidden.calls).toEqual([])
  })

  it('returns values-free domain errors', async () => {
    const state = app({
      recordElearningOfflineAttendance: async () => {
        throw new ElearningOfflineError('invalid_token')
      },
    })
    const response = await state.api!.post('/api/elearning/me/offline-attendance').send({
      requestId: REQUEST_ID,
      token: 'sensitive-token-value',
    })
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'invalid_token' })
    expect(JSON.stringify(response.body)).not.toContain('sensitive-token-value')
  })

  it('rechecks the exact flag after router creation', async () => {
    const state = app()
    state.env.ELEARNING_OFFLINE_TRAINING_ENABLED = 'false'
    const response = await state.api!.get('/api/elearning/me/offline-trainings')
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'not_found' })
    expect(state.calls).toEqual([])
  })

  it.each([
    {},
    { ELEARNING_ENABLED: 'true' },
    { ELEARNING_OFFLINE_TRAINING_ENABLED: 'true' },
    { ELEARNING_ENABLED: 'true', ELEARNING_OFFLINE_TRAINING_ENABLED: 'TRUE' },
  ])('does not mount for non-exact flag combinations %#', (env) => {
    expect(app({ env }).api).toBeNull()
  })
})
