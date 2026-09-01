import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import {
  createElearningOfflineRequestIds,
  issueElearningOfflineQr,
  listMyElearningOfflineTrainings,
  probeElearningOfflineTraining,
  publishElearningOfflineTraining,
  recordElearningOfflineAttendance,
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
      token: 'signed-token',
      issuedAt: CREATED,
      expiresAt: '2026-09-01T00:01:00.000Z',
      duplicate: false,
    }))
    await expect(issueElearningOfflineQr({
      requestId: REQUEST_B,
      trainingId: TRAINING,
      targetId: TARGET,
      action: 'check_in',
    })).resolves.toMatchObject({ token: 'signed-token', action: 'check_in' })
    expect(apiFetchMock.mock.calls[1]?.[0]).toBe(
      `/api/elearning/admin/offline-trainings/${TRAINING}/targets/${TARGET}/qr`,
    )
    expect(JSON.parse(String(apiFetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      requestId: REQUEST_B,
      action: 'check_in',
    })
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
      token: 'signed-token',
    })).resolves.toMatchObject({
      eventId: EVENT,
      completionStatus: 'completed',
    })
    expect(JSON.parse(String(apiFetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      requestId: REQUEST_C,
      token: 'signed-token',
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
      token: 'signed-token',
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
      token: 'signed-token',
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
      token: 'signed-token',
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
})
