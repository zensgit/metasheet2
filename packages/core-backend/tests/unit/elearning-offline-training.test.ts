import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  ELEARNING_OFFLINE_QR_TTL_SECONDS,
  ELEARNING_OFFLINE_QR_VERSION,
  ElearningOfflineError,
  hashElearningOfflineRequest,
  normalizeIssueElearningOfflineQr,
  normalizePublishElearningOfflineTraining,
  normalizeRecordElearningOfflineAttendance,
  signElearningOfflineQr,
  verifyElearningOfflineQr,
} from '../../src/services/elearning-offline-training'

const SECRET = 'offline-training-test-secret-with-more-than-32-bytes'
const REQUEST_ID = randomUUID()
const TRAINING_ID = randomUUID()
const REVISION_ID = randomUUID()
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

function claims(overrides: Record<string, unknown> = {}) {
  return {
    version: ELEARNING_OFFLINE_QR_VERSION,
    challengeId: CHALLENGE_ID,
    orgId: 'org-one',
    trainingId: TRAINING_ID,
    revisionId: REVISION_ID,
    targetId: TARGET_ID,
    action: 'check_in',
    issuedAt: '2026-09-01T08:59:00.000Z',
    expiresAt: '2026-09-01T09:00:00.000Z',
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

  it('signs a user-free context token and verifies the half-open TTL', () => {
    const token = signElearningOfflineQr(claims(), SECRET)
    expect(signElearningOfflineQr(claims(), SECRET)).toBe(token)
    expect(verifyElearningOfflineQr(
      token,
      SECRET,
      '2026-09-01T08:59:00.000Z',
    )).toEqual(claims())
    const decoded = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'))
    expect(Object.keys(decoded).sort()).toEqual([
      'action',
      'challengeId',
      'expiresAt',
      'issuedAt',
      'orgId',
      'revisionId',
      'targetId',
      'trainingId',
      'version',
    ])
    expect(JSON.stringify(decoded)).not.toContain('user')
    expect(Date.parse(decoded.expiresAt) - Date.parse(decoded.issuedAt))
      .toBe(ELEARNING_OFFLINE_QR_TTL_SECONDS * 1000)
    expectCode(() => verifyElearningOfflineQr(
      token,
      SECRET,
      '2026-09-01T09:00:00.000Z',
    ), 'expired')
  })

  it('rejects tampering, wrong secrets, noncanonical claims and extra claim keys', () => {
    const token = signElearningOfflineQr(claims(), SECRET)
    const [payload, signature] = token.split('.')
    expectCode(() => verifyElearningOfflineQr(
      `${payload}.${signature!.slice(0, -1)}A`,
      SECRET,
      '2026-09-01T08:59:00.000Z',
    ), 'invalid_token')
    expectCode(() => verifyElearningOfflineQr(
      token,
      `${SECRET}-wrong`,
      '2026-09-01T08:59:00.000Z',
    ), 'invalid_token')
    expectCode(() => signElearningOfflineQr({
      ...claims(),
      userId: MEMBER_ID,
    }, SECRET), 'invalid_input')
    expectCode(() => signElearningOfflineQr(claims({
      issuedAt: '2026-09-01T08:59:00Z',
    }), SECRET), 'invalid_input')
    expectCode(() => signElearningOfflineQr(claims(), 'short'), 'unavailable')
  })
})
