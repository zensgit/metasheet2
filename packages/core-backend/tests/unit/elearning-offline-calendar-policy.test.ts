import { describe, expect, it } from 'vitest'

import {
  ELEARNING_OFFLINE_CALENDAR_DOMAIN,
  ElearningOfflineCalendarPolicyError,
  createElearningOfflineCalendarPolicy,
  projectElearningOfflineCalendar,
} from '../../src/services/elearning-offline-calendar-policy'

const SENTINEL = 'secret-offline-calendar-value'

function target(targetKey: string, hourOffset = 0) {
  const hour = (value: number) => new Date(Date.UTC(
    2026,
    8,
    1,
    value + hourOffset,
  )).toISOString()
  return {
    checkInWindow: { closesAt: hour(10), opensAt: hour(8) },
    checkOutWindow: { closesAt: hour(14), opensAt: hour(11) },
    endsAt: hour(12),
    startsAt: hour(9),
    targetKey,
  }
}

function attendancePolicy(overrides: Record<string, unknown> = {}) {
  return {
    attendanceMode: 'session',
    policyRevision: 'attendance-v1',
    targets: [target('session-1'), target('session-2', 24)],
    ...overrides,
  }
}

function calendarPolicy(overrides: Record<string, unknown> = {}) {
  return {
    calendarPolicyRevision: 'calendar-v1',
    syncEnabled: true,
    ...overrides,
  }
}

function roster(overrides: Record<string, unknown> = {}) {
  return {
    assistantUserIds: ['assistant-b', 'assistant-a'],
    displayName: '  Safety training  ',
    learnerUserIds: ['learner-b', 'learner-a'],
    orgId: 'org-1',
    organizerUserId: 'organizer-1',
    trainingKey: 'training-1',
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected offline calendar policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningOfflineCalendarPolicyError)
    const policyError = error as ElearningOfflineCalendarPolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning offline calendar policy', () => {
  it('creates an exact immutable calendar policy', () => {
    const result = createElearningOfflineCalendarPolicy(calendarPolicy())
    expect(result).toEqual({
      calendarPolicyRevision: 'calendar-v1',
      syncEnabled: true,
    })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('projects every attendance target with separated assistant and learner roles', () => {
    const result = projectElearningOfflineCalendar(
      attendancePolicy(),
      calendarPolicy(),
      roster(),
    )
    expect(result).toEqual({
      attendancePolicyRevision: 'attendance-v1',
      calendarPolicyRevision: 'calendar-v1',
      desiredEvents: [
        {
          assistantUserIds: ['assistant-a', 'assistant-b'],
          calendarEventKey: expect.stringMatching(
            new RegExp(`^${ELEARNING_OFFLINE_CALENDAR_DOMAIN}:[a-f0-9]{64}$`),
          ),
          displayName: 'Safety training',
          endsAt: '2026-09-01T12:00:00.000Z',
          learnerUserIds: ['learner-a', 'learner-b'],
          payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          startsAt: '2026-09-01T09:00:00.000Z',
          targetKey: 'session-1',
        },
        {
          assistantUserIds: ['assistant-a', 'assistant-b'],
          calendarEventKey: expect.stringMatching(
            new RegExp(`^${ELEARNING_OFFLINE_CALENDAR_DOMAIN}:[a-f0-9]{64}$`),
          ),
          displayName: 'Safety training',
          endsAt: '2026-09-02T12:00:00.000Z',
          learnerUserIds: ['learner-a', 'learner-b'],
          payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          startsAt: '2026-09-02T09:00:00.000Z',
          targetKey: 'session-2',
        },
      ],
      orgId: 'org-1',
      organizerUserId: 'organizer-1',
      syncEnabled: true,
      trainingKey: 'training-1',
    })
    expect(result.desiredEvents[0].calendarEventKey).not.toBe(
      result.desiredEvents[1].calendarEventKey,
    )
  })

  it('returns an empty desired set when synchronization is disabled', () => {
    expect(projectElearningOfflineCalendar(
      attendancePolicy(),
      calendarPolicy({ syncEnabled: false }),
      roster(),
    )).toEqual({
      attendancePolicyRevision: 'attendance-v1',
      calendarPolicyRevision: 'calendar-v1',
      desiredEvents: [],
      orgId: 'org-1',
      organizerUserId: 'organizer-1',
      syncEnabled: false,
      trainingKey: 'training-1',
    })
  })

  it('keeps the event identity stable while schedule and roster payloads change', () => {
    const original = projectElearningOfflineCalendar(
      attendancePolicy({ targets: [target('session-1')] }),
      calendarPolicy(),
      roster(),
    ).desiredEvents[0]
    const changed = projectElearningOfflineCalendar(
      attendancePolicy({
        targets: [{
          ...target('session-1'),
          endsAt: '2026-09-01T13:00:00.000Z',
        }],
      }),
      calendarPolicy({ calendarPolicyRevision: 'calendar-v2' }),
      roster({ assistantUserIds: ['assistant-c'] }),
    ).desiredEvents[0]
    expect(changed.calendarEventKey).toBe(original.calendarEventKey)
    expect(changed.payloadDigest).not.toBe(original.payloadDigest)
  })

  it('changes the payload digest when only the participant snapshot changes', () => {
    const original = projectElearningOfflineCalendar(
      attendancePolicy({ targets: [target('session-1')] }),
      calendarPolicy(),
      roster(),
    ).desiredEvents[0]
    const changed = projectElearningOfflineCalendar(
      attendancePolicy({ targets: [target('session-1')] }),
      calendarPolicy(),
      roster({ assistantUserIds: ['assistant-c'] }),
    ).desiredEvents[0]
    expect(changed.calendarEventKey).toBe(original.calendarEventKey)
    expect(changed.payloadDigest).not.toBe(original.payloadDigest)
  })

  it('changes identity for another organization, training, or target', () => {
    const original = projectElearningOfflineCalendar(
      attendancePolicy({ targets: [target('session-1')] }),
      calendarPolicy(),
      roster(),
    ).desiredEvents[0].calendarEventKey
    const otherTraining = projectElearningOfflineCalendar(
      attendancePolicy({ targets: [target('session-1')] }),
      calendarPolicy(),
      roster({ trainingKey: 'training-2' }),
    ).desiredEvents[0].calendarEventKey
    const otherOrganization = projectElearningOfflineCalendar(
      attendancePolicy({ targets: [target('session-1')] }),
      calendarPolicy(),
      roster({ orgId: 'org-2' }),
    ).desiredEvents[0].calendarEventKey
    const otherTarget = projectElearningOfflineCalendar(
      attendancePolicy({ targets: [target('session-2')] }),
      calendarPolicy(),
      roster(),
    ).desiredEvents[0].calendarEventKey
    expect(new Set([original, otherOrganization, otherTraining, otherTarget]).size).toBe(4)
  })

  it('rejects duplicate or overlapping organizer, assistant, and learner roles', () => {
    for (const input of [
      roster({ assistantUserIds: ['assistant-a', 'assistant-a'] }),
      roster({ learnerUserIds: ['learner-a', 'learner-a'] }),
      roster({ organizerUserId: 'assistant-a' }),
      roster({ organizerUserId: 'learner-a' }),
      roster({ assistantUserIds: ['shared-user'], learnerUserIds: ['shared-user'] }),
    ]) {
      expectCode(() => projectElearningOfflineCalendar(
        attendancePolicy(),
        calendarPolicy(),
        input,
      ), 'invalid_roster')
    }
  })

  it('rejects malformed roster content and shapes values-free', () => {
    for (const input of [
      null,
      {},
      { ...roster(), extra: SENTINEL },
    ]) {
      expectCode(() => projectElearningOfflineCalendar(
        attendancePolicy(),
        calendarPolicy(),
        input,
      ), 'invalid_input')
    }
    for (const input of [
      roster({ displayName: '   ' }),
      roster({ orgId: '' }),
      roster({ trainingKey: `${SENTINEL}\0` }),
      roster({ assistantUserIds: new Array(1) }),
      roster({ learnerUserIds: ['\ud800'] }),
    ]) {
      expectCode(() => projectElearningOfflineCalendar(
        attendancePolicy(),
        calendarPolicy(),
        input,
      ), 'invalid_roster')
    }
    const throwing = Object.defineProperty(roster(), 'displayName', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => projectElearningOfflineCalendar(
      attendancePolicy(),
      calendarPolicy(),
      throwing,
    ), 'invalid_input')
  })

  it('wraps malformed attendance and calendar policies values-free', () => {
    expectCode(() => projectElearningOfflineCalendar(
      attendancePolicy({ attendanceMode: SENTINEL }),
      calendarPolicy(),
      roster(),
    ), 'invalid_policy')
    for (const input of [
      null,
      {},
      calendarPolicy({ syncEnabled: SENTINEL }),
      calendarPolicy({ calendarPolicyRevision: `${SENTINEL}\0` }),
      { ...calendarPolicy(), extra: SENTINEL },
    ]) {
      expectCode(() => projectElearningOfflineCalendar(
        attendancePolicy(),
        input,
        roster(),
      ), 'invalid_policy')
    }
  })

  it('returns a deeply immutable and closed projection', () => {
    const result = projectElearningOfflineCalendar(
      attendancePolicy(),
      calendarPolicy(),
      roster(),
    )
    expect(Reflect.ownKeys(result)).toEqual([
      'attendancePolicyRevision',
      'calendarPolicyRevision',
      'desiredEvents',
      'orgId',
      'organizerUserId',
      'syncEnabled',
      'trainingKey',
    ])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.desiredEvents)).toBe(true)
    expect(result.desiredEvents.every(Object.isFrozen)).toBe(true)
    expect(result.desiredEvents.every((event) => (
      Object.isFrozen(event.assistantUserIds)
      && Object.isFrozen(event.learnerUserIds)
    ))).toBe(true)
  })
})
