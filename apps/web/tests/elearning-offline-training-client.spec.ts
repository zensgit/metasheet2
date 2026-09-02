import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import {
  changeElearningOfflineRegistration,
  createElearningOfflineRequestIds,
  createElearningOfflineAttendanceLink,
  issueElearningOfflineQr,
  listElearningOfflineRegistrations,
  listMyElearningOfflineTrainings,
  probeElearningOfflineTraining,
  publishElearningOfflineTraining,
  recordElearningOfflineAttendance,
  readElearningOfflineAttendanceToken,
  setElearningOfflineTrainingStatus,
} from '../src/services/elearningOfflineTraining'

const TRAINING = '11111111-1111-4111-8111-111111111111'
const REVISION = '22222222-2222-4222-8222-222222222222'
const TARGET = '33333333-3333-4333-8333-333333333333'
const EVENT = '44444444-4444-4444-8444-444444444444'
const MEMBER = '55555555-5555-4555-8555-555555555555'
const REQUEST_A = '66666666-6666-4666-8666-666666666666'
const REQUEST_B = '77777777-7777-4777-8777-777777777777'
const REQUEST_C = '88888888-8888-4888-8888-888888888888'
const STARTS = '2026-09-01T02:00:00.000Z'
const ENDS = '2026-09-01T04:00:00.000Z'
const CHECK_IN_OPEN = '2026-09-01T01:30:00.000Z'
const CHECK_IN_CLOSE = '2026-09-01T02:30:00.000Z'
const CHECK_OUT_OPEN = '2026-09-01T03:30:00.000Z'
const CHECK_OUT_CLOSE = '2026-09-01T04:30:00.000Z'
const CREATED = '2026-09-01T00:00:00.000Z'
const TOKEN = 'A'.repeat(43)

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function target(over: Record<string, unknown> = {}) {
  return {
    targetId: TARGET,
    position: 1,
    title: 'Morning session',
    startsAt: STARTS,
    endsAt: ENDS,
    checkInOpensAt: CHECK_IN_OPEN,
    checkInClosesAt: CHECK_IN_CLOSE,
    checkOutOpensAt: CHECK_OUT_OPEN,
    checkOutClosesAt: CHECK_OUT_CLOSE,
    ...over,
  }
}

function learnerTarget(over: Record<string, unknown> = {}) {
  return {
    ...target(),
    attendanceStatus: 'not_checked_in',
    checkedInAt: null,
    checkedOutAt: null,
    ...over,
  }
}

function learnerTraining(over: Record<string, unknown> = {}) {
  return {
    trainingId: TRAINING,
    revisionId: REVISION,
    title: 'Safety training',
    location: 'Room A',
    attendanceMode: 'training',
    status: 'active',
    registrationEnabled: true,
    registrationStatus: 'not_registered',
    targets: [learnerTarget()],
    completionStatus: 'in_progress',
    ...over,
  }
}

function publishInput(over: Record<string, unknown> = {}) {
  return {
    requestId: REQUEST_A,
    title: 'Safety training',
    location: 'Room A',
    attendanceMode: 'training' as const,
    registrationEnabled: true,
    targets: [{
      title: 'Morning session',
      startsAt: STARTS,
      endsAt: ENDS,
      checkInOpensAt: CHECK_IN_OPEN,
      checkInClosesAt: CHECK_IN_CLOSE,
      checkOutOpensAt: CHECK_OUT_OPEN,
      checkOutClosesAt: CHECK_OUT_CLOSE,
    }],
    memberUserIds: [MEMBER],
    ...over,
  }
}

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe('e-learning offline training client', () => {
  it('sends closed publish and QR commands and parses exact results', async () => {
    apiFetchMock.mockResolvedValueOnce(response(201, {
      trainingId: TRAINING,
      revisionId: REVISION,
      title: 'Safety training',
      location: 'Room A',
      attendanceMode: 'training',
      targets: [target()],
      memberCount: 1,
      registrationEnabled: true,
      createdAt: CREATED,
      duplicate: false,
    }))
    await expect(publishElearningOfflineTraining(publishInput())).resolves.toMatchObject({
      trainingId: TRAINING,
      targets: [expect.objectContaining({ targetId: TARGET, position: 1 })],
    })
    expect(JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body))).toEqual(publishInput())

    apiFetchMock.mockResolvedValueOnce(response(201, {
      trainingId: TRAINING,
      revisionId: REVISION,
      targetId: TARGET,
      action: 'check_in',
      token: TOKEN,
      issuedAt: CREATED,
      expiresAt: '2026-09-01T00:01:00.000Z',
      duplicate: false,
    }))
    await expect(issueElearningOfflineQr({
      requestId: REQUEST_B,
      trainingId: TRAINING,
      targetId: TARGET,
      action: 'check_in',
    })).resolves.toMatchObject({ token: TOKEN, action: 'check_in' })
    expect(apiFetchMock.mock.calls[1]?.[0]).toBe(
      `/api/elearning/admin/offline-trainings/${TRAINING}/targets/${TARGET}/qr`,
    )
    expect(JSON.parse(String(apiFetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      requestId: REQUEST_B,
      action: 'check_in',
    })
  })

  it('sends a closed lifecycle command and rejects mismatched or widened results', async () => {
    apiFetchMock.mockResolvedValueOnce(response(200, {
      trainingId: TRAINING,
      status: 'archived',
      reason: 'Completed cycle',
      changedAt: CREATED,
      duplicate: false,
    }))
    await expect(setElearningOfflineTrainingStatus({
      requestId: REQUEST_A,
      trainingId: TRAINING,
      status: 'archived',
      reason: 'Completed cycle',
    })).resolves.toEqual({
      trainingId: TRAINING,
      status: 'archived',
      reason: 'Completed cycle',
      changedAt: CREATED,
      duplicate: false,
    })
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(
      `/api/elearning/admin/offline-trainings/${TRAINING}/status`,
    )
    expect(JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      requestId: REQUEST_A,
      status: 'archived',
      reason: 'Completed cycle',
    })

    for (const bad of [
      { trainingId: REVISION, status: 'archived', reason: 'Completed cycle', changedAt: CREATED, duplicate: false },
      { trainingId: TRAINING, status: 'withdrawn', reason: 'Completed cycle', changedAt: CREATED, duplicate: false },
      { trainingId: TRAINING, status: 'archived', reason: 'Completed cycle', changedAt: CREATED, duplicate: false, actorId: MEMBER },
      { trainingId: TRAINING, status: 'archived', reason: 'Completed cycle', changedAt: '2026-02-31T00:00:00.000Z', duplicate: false },
    ]) {
      apiFetchMock.mockResolvedValueOnce(response(200, bad))
      await expect(setElearningOfflineTrainingStatus({
        requestId: REQUEST_A,
        trainingId: TRAINING,
        status: 'archived',
        reason: 'Completed cycle',
      })).rejects.toMatchObject({ code: 'invalid_response', status: 200 })
    }
  })

  it('parses learner rows and attendance without exposing authority material', async () => {
    apiFetchMock.mockResolvedValueOnce(response(200, { trainings: [learnerTraining()] }))
    await expect(listMyElearningOfflineTrainings()).resolves.toEqual({
      trainings: [learnerTraining()],
    })

    apiFetchMock.mockResolvedValueOnce(response(200, {
      eventId: EVENT,
      trainingId: TRAINING,
      revisionId: REVISION,
      targetId: TARGET,
      action: 'check_out',
      occurredAt: CREATED,
      targetStatus: 'checked_out',
      completionStatus: 'completed',
      completedTargetCount: 1,
      totalTargetCount: 1,
      duplicate: false,
    }))
    await expect(recordElearningOfflineAttendance({
      requestId: REQUEST_C,
      token: TOKEN,
    })).resolves.toMatchObject({
      eventId: EVENT,
      completionStatus: 'completed',
    })
    expect(JSON.parse(String(apiFetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      requestId: REQUEST_C,
      token: TOKEN,
    })

    for (const forbidden of ['challengeId', 'orgId', 'decisionHash', 'requestHash']) {
      apiFetchMock.mockResolvedValueOnce(response(200, {
        trainings: [learnerTraining({ [forbidden]: 'hidden' })],
      }))
      await expect(listMyElearningOfflineTrainings()).rejects.toMatchObject({
        code: 'invalid_response',
        status: 200,
      })
    }
  })

  it.each([
    learnerTraining({ extra: true }),
    learnerTraining({ completionStatus: 'completed' }),
    learnerTraining({ targets: [learnerTarget({ position: 2 })] }),
    learnerTraining({ targets: [learnerTarget({ attendanceStatus: 'checked_in' })] }),
    learnerTraining({ targets: [learnerTarget({ checkedInAt: '2026-02-31T01:02:03.456Z' })] }),
    learnerTraining({ targets: [learnerTarget({ startsAt: '2026-09-01T02:00:00Z' })] }),
  ])('rejects malformed learner result %#', async (badTraining) => {
    apiFetchMock.mockResolvedValueOnce(response(200, { trainings: [badTraining] }))
    await expect(listMyElearningOfflineTrainings()).rejects.toMatchObject({
      code: 'invalid_response',
      status: 200,
    })
  })

  it('rejects malformed publish, QR and attendance results', async () => {
    apiFetchMock.mockResolvedValueOnce(response(201, {
      trainingId: TRAINING,
      revisionId: REVISION,
      title: 'Safety training',
      location: 'Room A',
      attendanceMode: 'training',
      targets: [target({ position: 2 })],
      memberCount: 1,
      registrationEnabled: true,
      createdAt: CREATED,
      duplicate: false,
    }))
    await expect(publishElearningOfflineTraining(publishInput())).rejects.toMatchObject({
      code: 'invalid_response',
    })

    apiFetchMock.mockResolvedValueOnce(response(201, {
      trainingId: TRAINING,
      revisionId: REVISION,
      targetId: TARGET,
      action: 'check_in',
      token: TOKEN,
      issuedAt: CREATED,
      expiresAt: CREATED,
      duplicate: false,
    }))
    await expect(issueElearningOfflineQr({
      requestId: REQUEST_B,
      trainingId: TRAINING,
      targetId: TARGET,
      action: 'check_in',
    })).rejects.toMatchObject({ code: 'invalid_response' })

    apiFetchMock.mockResolvedValueOnce(response(201, {
      trainingId: TRAINING,
      revisionId: REVISION,
      targetId: TARGET,
      action: 'check_out',
      token: TOKEN,
      issuedAt: CREATED,
      expiresAt: '2026-09-01T00:01:00.000Z',
      duplicate: false,
    }))
    await expect(issueElearningOfflineQr({
      requestId: REQUEST_B,
      trainingId: TRAINING,
      targetId: TARGET,
      action: 'check_in',
    })).rejects.toMatchObject({ code: 'invalid_response' })

    apiFetchMock.mockResolvedValueOnce(response(200, {
      eventId: EVENT,
      trainingId: TRAINING,
      revisionId: REVISION,
      targetId: TARGET,
      action: 'check_in',
      occurredAt: CREATED,
      targetStatus: 'checked_out',
      completionStatus: 'completed',
      completedTargetCount: 1,
      totalTargetCount: 1,
      duplicate: false,
    }))
    await expect(recordElearningOfflineAttendance({
      requestId: REQUEST_C,
      token: TOKEN,
    })).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('treats only a list 404 as disabled and preserves other failures', async () => {
    apiFetchMock.mockResolvedValueOnce(response(404, { error: 'not_found' }))
    await expect(probeElearningOfflineTraining()).resolves.toBe(false)

    apiFetchMock.mockResolvedValueOnce(response(503, { error: 'unavailable' }))
    await expect(probeElearningOfflineTraining()).rejects.toMatchObject({
      code: 'unavailable',
      status: 503,
    })
  })

  it('builds a client-only scan link and accepts only its closed opaque token fragment', () => {
    expect(createElearningOfflineAttendanceLink(TOKEN, 'https://learn.example.test/app'))
      .toBe(`https://learn.example.test/learn#offline-attendance=${TOKEN}`)
    expect(readElearningOfflineAttendanceToken(`#offline-attendance=${TOKEN}`)).toBe(TOKEN)
    expect(readElearningOfflineAttendanceToken(`#offline-attendance=${TOKEN}A`)).toBeNull()
    expect(readElearningOfflineAttendanceToken(`#other=${TOKEN}`)).toBeNull()
    expect(() => createElearningOfflineAttendanceLink('not-opaque', 'https://learn.example.test'))
      .toThrowError('invalid_response')
  })

  it('reuses retry identities, rotates on payload change, and settles successful commands', () => {
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(REQUEST_A)
      .mockReturnValueOnce(REQUEST_B)
      .mockReturnValueOnce(REQUEST_C)
      .mockReturnValueOnce(TRAINING)
      .mockReturnValueOnce(REVISION)
      .mockReturnValueOnce(TARGET)
      .mockReturnValue(EVENT)
    const ids = createElearningOfflineRequestIds()
    const logical = publishInput()
    const { requestId: _requestId, ...payload } = logical
    expect(ids.forPublish(payload)).toBe(REQUEST_A)
    expect(ids.forPublish({ ...payload, title: ' Safety training ' })).toBe(REQUEST_A)
    expect(ids.forPublish({ ...payload, location: 'Room B' })).toBe(REQUEST_B)
    ids.settlePublish(payload)
    expect(ids.forPublish(payload)).toBe(REQUEST_C)
    expect(ids.forQr(TRAINING, TARGET, 'check_in')).toBe(TRAINING)
    expect(ids.forQr(TRAINING, TARGET, 'check_in')).toBe(TRAINING)
    ids.settleQr(TRAINING, TARGET, 'check_in')
    expect(ids.forQr(TRAINING, TARGET, 'check_in')).toBe(REVISION)
    expect(ids.forAttendance(' token ')).toBe(TARGET)
    expect(ids.forAttendance('token')).toBe(TARGET)
    ids.settleAttendance('token')
    expect(ids.forAttendance('token')).toBe(EVENT)
    uuid.mockRestore()
  })

  it('binds lifecycle retry identity to course, status and normalized reason', () => {
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(REQUEST_A)
      .mockReturnValueOnce(REQUEST_B)
      .mockReturnValue(REQUEST_C)
    const ids = createElearningOfflineRequestIds()
    expect(ids.forStatus(TRAINING, 'archived', ' Completed cycle ')).toBe(REQUEST_A)
    expect(ids.forStatus(TRAINING, 'archived', 'Completed cycle')).toBe(REQUEST_A)
    expect(ids.forStatus(TRAINING, 'withdrawn', 'Completed cycle')).toBe(REQUEST_B)
    ids.settleStatus(TRAINING, 'archived', 'Completed cycle')
    expect(ids.forStatus(TRAINING, 'archived', 'Completed cycle')).toBe(REQUEST_C)
    uuid.mockRestore()
  })

  it('changes registration and parses the closed stable admin roster', async () => {
    apiFetchMock.mockResolvedValueOnce(response(201, {
      trainingId: TRAINING,
      revisionId: REVISION,
      action: 'register',
      status: 'registered',
      changedAt: CREATED,
      duplicate: false,
    }))
    await expect(changeElearningOfflineRegistration({
      requestId: REQUEST_A,
      trainingId: TRAINING,
      action: 'register',
    })).resolves.toEqual({
      trainingId: TRAINING,
      revisionId: REVISION,
      action: 'register',
      status: 'registered',
      changedAt: CREATED,
      duplicate: false,
    })
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe(
      `/api/elearning/me/offline-trainings/${TRAINING}/registration`,
    )
    expect(JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      requestId: REQUEST_A,
      action: 'register',
    })

    apiFetchMock.mockResolvedValueOnce(response(200, {
      items: [{ userId: MEMBER, status: 'registered', changedAt: CREATED }],
      nextCursor: MEMBER,
    }))
    await expect(listElearningOfflineRegistrations({ trainingId: TRAINING, limit: 1 }))
      .resolves.toEqual({
        items: [{ userId: MEMBER, status: 'registered', changedAt: CREATED }],
        nextCursor: MEMBER,
      })
    expect(apiFetchMock.mock.calls[1]?.[0]).toBe(
      `/api/elearning/admin/offline-trainings/${TRAINING}/registrations?limit=1`,
    )
  })

  it('rejects widened, mismatched or internally inconsistent registration results', async () => {
    for (const bad of [
      { trainingId: REVISION, revisionId: REVISION, action: 'register', status: 'registered', changedAt: CREATED, duplicate: false },
      { trainingId: TRAINING, revisionId: REVISION, action: 'register', status: 'cancelled', changedAt: CREATED, duplicate: false },
      { trainingId: TRAINING, revisionId: REVISION, action: 'cancel', status: 'cancelled', changedAt: CREATED, duplicate: false },
      { trainingId: TRAINING, revisionId: REVISION, action: 'register', status: 'registered', changedAt: CREATED, duplicate: false, actorId: MEMBER },
    ]) {
      apiFetchMock.mockResolvedValueOnce(response(200, bad))
      await expect(changeElearningOfflineRegistration({
        requestId: REQUEST_A,
        trainingId: TRAINING,
        action: 'register',
      })).rejects.toMatchObject({ code: 'invalid_response' })
    }

    for (const bad of [
      { items: [{ userId: MEMBER, status: 'not_registered', changedAt: CREATED }], nextCursor: null },
      { items: [{ userId: MEMBER, status: 'registered', changedAt: null }], nextCursor: null },
      { items: [{ userId: MEMBER, status: 'registered', changedAt: CREATED, orgId: 'hidden' }], nextCursor: null },
      { items: [{ userId: MEMBER, status: 'registered', changedAt: CREATED }], nextCursor: TRAINING },
    ]) {
      apiFetchMock.mockResolvedValueOnce(response(200, bad))
      await expect(listElearningOfflineRegistrations({ trainingId: TRAINING }))
        .rejects.toMatchObject({ code: 'invalid_response' })
    }

    apiFetchMock.mockResolvedValueOnce(response(200, {
      items: [{ userId: MEMBER, status: 'registered', changedAt: CREATED }],
      nextCursor: null,
    }))
    await expect(listElearningOfflineRegistrations({
      trainingId: TRAINING,
      after: MEMBER,
    })).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('keeps registration retry identity stable until success and separates the opposite action', () => {
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(REQUEST_A)
      .mockReturnValueOnce(REQUEST_B)
      .mockReturnValue(REQUEST_C)
    const ids = createElearningOfflineRequestIds()
    expect(ids.forRegistration(TRAINING, 'register')).toBe(REQUEST_A)
    expect(ids.forRegistration(TRAINING.toUpperCase(), 'register')).toBe(REQUEST_A)
    expect(ids.forRegistration(TRAINING, 'cancel')).toBe(REQUEST_B)
    ids.settleRegistration(TRAINING, 'register')
    expect(ids.forRegistration(TRAINING, 'register')).toBe(REQUEST_C)
    uuid.mockRestore()
  })

  it('binds publish retry identity to the frozen registration setting', () => {
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(REQUEST_A)
      .mockReturnValue(REQUEST_B)
    const ids = createElearningOfflineRequestIds()
    const { requestId: _requestId, ...payload } = publishInput()
    expect(ids.forPublish(payload)).toBe(REQUEST_A)
    expect(ids.forPublish({ ...payload, registrationEnabled: false })).toBe(REQUEST_B)
    uuid.mockRestore()
  })
})
