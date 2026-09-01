import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  ElearningOfflineError,
  createElearningOfflineQrToken,
  digestElearningOfflineQrToken,
  hashElearningOfflineRequest,
  normalizeIssueElearningOfflineQr,
  normalizePublishElearningOfflineTraining,
  normalizeRecordElearningOfflineAttendance,
  normalizeSetElearningOfflineTrainingStatus,
} from '../../src/services/elearning-offline-training'

const SECRET = 'offline-training-test-secret-with-more-than-32-bytes'
const REQUEST_ID = randomUUID()
const TRAINING_ID = randomUUID()
const TARGET_ID = randomUUID()
const CHALLENGE_ID = randomUUID()
const MEMBER_ID = randomUUID()

function target(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Morning session',
    startsAt: '2026-09-01T09:00:00.000Z',
    endsAt: '2026-09-01T10:00:00.000Z',
    checkInOpensAt: '2026-09-01T08:45:00.000Z',
    checkInClosesAt: '2026-09-01T09:15:00.000Z',
    checkOutOpensAt: '2026-09-01T09:45:00.000Z',
    checkOutClosesAt: '2026-09-01T10:15:00.000Z',
    ...overrides,
  }
}

function publish(overrides: Record<string, unknown> = {}) {
  return {
    requestId: REQUEST_ID,
    title: 'Secure operations',
    location: 'Training room',
    attendanceMode: 'training',
    targets: [target()],
    memberUserIds: [MEMBER_ID],
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrowError(ElearningOfflineError)
  try {
    action()
  } catch (error) {
    expect((error as ElearningOfflineError).code).toBe(code)
    expect((error as Error).message).toBe(code)
  }
}

describe('e-learning offline training domain', () => {
  it('normalizes a closed training-level publish command and stable hash', () => {
    const normalized = normalizePublishElearningOfflineTraining(publish())
    expect(normalized).toEqual(publish())
    expect(hashElearningOfflineRequest('publish', normalized)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashElearningOfflineRequest('publish', {
      ...normalized,
      memberUserIds: [...normalized.memberUserIds],
    })).toBe(hashElearningOfflineRequest('publish', normalized))
  })

  it('supports ordered session targets but training mode has exactly one target', () => {
    const sessions = normalizePublishElearningOfflineTraining(publish({
      attendanceMode: 'session',
      targets: [target(), target({
        title: 'Afternoon session',
        startsAt: '2026-09-01T13:00:00.000Z',
        endsAt: '2026-09-01T14:00:00.000Z',
        checkInOpensAt: '2026-09-01T12:45:00.000Z',
        checkInClosesAt: '2026-09-01T13:15:00.000Z',
        checkOutOpensAt: '2026-09-01T13:45:00.000Z',
        checkOutClosesAt: '2026-09-01T14:15:00.000Z',
      })],
    }))
    expect(sessions.targets.map((entry) => entry.title)).toEqual([
      'Morning session',
      'Afternoon session',
    ])
    expectCode(() => normalizePublishElearningOfflineTraining(publish({
      targets: [target(), target()],
    })), 'invalid_input')
  })

  it('rejects extra keys, duplicate members, invalid windows and noncanonical timestamps', () => {
    expectCode(() => normalizePublishElearningOfflineTraining({
      ...publish(),
      actorId: MEMBER_ID,
    }), 'invalid_input')
    expectCode(() => normalizePublishElearningOfflineTraining(publish({
      memberUserIds: [MEMBER_ID, MEMBER_ID],
    })), 'invalid_input')
    expectCode(() => normalizePublishElearningOfflineTraining(publish({
      targets: [target({ checkInClosesAt: '2026-09-01T08:44:00.000Z' })],
    })), 'invalid_input')
    expectCode(() => normalizePublishElearningOfflineTraining(publish({
      targets: [target({ startsAt: '2026-09-01T09:00:00Z' })],
    })), 'invalid_input')
    expectCode(() => normalizePublishElearningOfflineTraining(publish({
      targets: [target({ startsAt: '2026-02-30T09:00:00.000Z' })],
    })), 'invalid_input')
  })

  it('normalizes closed QR issue and attendance commands', () => {
    expect(normalizeIssueElearningOfflineQr({
      requestId: REQUEST_ID,
      trainingId: TRAINING_ID,
      targetId: TARGET_ID,
      action: 'check_out',
    })).toEqual({
      requestId: REQUEST_ID,
      trainingId: TRAINING_ID,
      targetId: TARGET_ID,
      action: 'check_out',
    })
    expect(normalizeRecordElearningOfflineAttendance({
      requestId: REQUEST_ID,
      token: 'opaque-token',
    })).toEqual({ requestId: REQUEST_ID, token: 'opaque-token' })
  })

  it('normalizes a closed audited training status command', () => {
    expect(normalizeSetElearningOfflineTrainingStatus({
      requestId: REQUEST_ID,
      status: 'withdrawn',
      reason: ' Safety recall ',
    })).toEqual({
      requestId: REQUEST_ID,
      status: 'withdrawn',
      reason: 'Safety recall',
    })
    expectCode(() => normalizeSetElearningOfflineTrainingStatus({
      requestId: REQUEST_ID,
      status: 'retired',
      reason: 'No longer offered',
    }), 'invalid_input')
    expectCode(() => normalizeSetElearningOfflineTrainingStatus({
      requestId: REQUEST_ID,
      status: 'archived',
      reason: 'Archived',
      actorId: MEMBER_ID,
    }), 'invalid_input')
  })

  it('derives a deterministic opaque bearer token without embedding authority claims', () => {
    const token = createElearningOfflineQrToken(CHALLENGE_ID, SECRET)
    expect(createElearningOfflineQrToken(CHALLENGE_ID, SECRET)).toBe(token)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(token).not.toContain(CHALLENGE_ID)
    expect(token).not.toContain(TRAINING_ID)
    expect(token).not.toContain(TARGET_ID)
    expect(digestElearningOfflineQrToken(token)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('separates secrets and rejects malformed opaque tokens and challenge ids', () => {
    const token = createElearningOfflineQrToken(CHALLENGE_ID, SECRET)
    expect(createElearningOfflineQrToken(CHALLENGE_ID, `${SECRET}-wrong`)).not.toBe(token)
    expectCode(() => digestElearningOfflineQrToken(`${token.slice(0, -1)}.`), 'invalid_token')
    expectCode(() => digestElearningOfflineQrToken(`${token}A`), 'invalid_token')
    expectCode(() => createElearningOfflineQrToken('not-a-uuid', SECRET), 'invalid_input')
    expectCode(() => createElearningOfflineQrToken(CHALLENGE_ID, 'short'), 'unavailable')
  })
})
