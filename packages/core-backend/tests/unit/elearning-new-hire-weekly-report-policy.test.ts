import { describe, expect, it } from 'vitest'

import {
  createElearningNewHireWeeklyReportPolicy,
  ELEARNING_NEW_HIRE_WEEKLY_REPORT_DELIVERY_DOMAIN,
  ELEARNING_NEW_HIRE_WEEKLY_REPORT_DOMAIN,
  ElearningNewHireWeeklyReportPolicyError,
  planElearningNewHireWeeklyReport,
} from '../../src/services/elearning-new-hire-weekly-report-policy'

const SENTINEL = 'secret-weekly-report-value'
const PROGRAM_ID = '10000000-0000-4000-8000-000000000001'
const POLICY_REVISION_ID = '10000000-0000-4000-8000-000000000002'
const NEXT_POLICY_REVISION_ID = '10000000-0000-4000-8000-000000000003'
const RECIPIENT_A = '10000000-0000-4000-8000-000000000004'
const RECIPIENT_B = '10000000-0000-4000-8000-000000000005'
const OTHER_ID = '10000000-0000-4000-8000-000000000006'

function policy(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    localTime: '09:30',
    orgId: 'org-1',
    policyRevisionId: POLICY_REVISION_ID,
    programId: PROGRAM_ID,
    recipientUserIds: [RECIPIENT_B, RECIPIENT_A],
    timeZone: 'Asia/Shanghai',
    weekday: 1,
    ...overrides,
  }
}

function authorization(userId: string, trackingAuthorized: unknown) {
  return { trackingAuthorized, userId }
}

function dispatch(overrides: Record<string, unknown> = {}) {
  return {
    recipientAuthorizations: [
      authorization(RECIPIENT_B, false),
      authorization(RECIPIENT_A, true),
    ],
    scheduledFor: '2026-08-31T01:30:00Z',
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected new-hire weekly-report policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningNewHireWeeklyReportPolicyError)
    const policyError = error as ElearningNewHireWeeklyReportPolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning new-hire weekly-report policy', () => {
  it('creates a normalized immutable weekly schedule snapshot', () => {
    const result = createElearningNewHireWeeklyReportPolicy(policy({
      recipientUserIds: [RECIPIENT_B.toUpperCase(), RECIPIENT_A],
      timeZone: 'US/Pacific',
    }))
    expect(result).toEqual({
      enabled: true,
      localTime: '09:30',
      orgId: 'org-1',
      policyRevisionId: POLICY_REVISION_ID,
      programId: PROGRAM_ID,
      recipientUserIds: [RECIPIENT_A, RECIPIENT_B],
      timeZone: 'America/Los_Angeles',
      weekday: 1,
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.recipientUserIds)).toBe(true)
  })

  it('plans one authorized delivery at the configured local weekly occurrence', () => {
    const result = planElearningNewHireWeeklyReport(policy(), dispatch())
    expect(result).toEqual({
      deliveries: [{
        deliveryKey: expect.stringMatching(
          new RegExp(`^${ELEARNING_NEW_HIRE_WEEKLY_REPORT_DELIVERY_DOMAIN}:[a-f0-9]{64}$`),
        ),
        recipientUserId: RECIPIENT_A,
      }],
      jobOccurrenceKey: expect.stringMatching(
        new RegExp(`^${ELEARNING_NEW_HIRE_WEEKLY_REPORT_DOMAIN}:[a-f0-9]{64}$`),
      ),
      outcome: 'ready',
      policyRevisionId: POLICY_REVISION_ID,
      programId: PROGRAM_ID,
      reportWeek: '2026-W36',
      scheduledFor: '2026-08-31T01:30:00.000Z',
      suppressedRecipientCount: 1,
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.deliveries)).toBe(true)
    expect(result.deliveries.every(Object.isFrozen)).toBe(true)
  })

  it('keeps job and delivery identities stable across retries and policy revisions', () => {
    const first = planElearningNewHireWeeklyReport(policy(), dispatch())
    const reordered = planElearningNewHireWeeklyReport(
      policy({ policyRevisionId: NEXT_POLICY_REVISION_ID }),
      dispatch({
        recipientAuthorizations: [
          authorization(RECIPIENT_A.toUpperCase(), true),
          authorization(RECIPIENT_B, false),
        ],
      }),
    )
    expect(reordered.jobOccurrenceKey).toBe(first.jobOccurrenceKey)
    expect(reordered.deliveries[0].deliveryKey).toBe(first.deliveries[0].deliveryKey)
    expect(reordered.policyRevisionId).toBe(NEXT_POLICY_REVISION_ID)
  })

  it('separates job identity by organization, program, and local ISO week', () => {
    const first = planElearningNewHireWeeklyReport(policy(), dispatch())
    const otherOrg = planElearningNewHireWeeklyReport(
      policy({ orgId: 'org-2' }),
      dispatch(),
    )
    const otherProgram = planElearningNewHireWeeklyReport(
      policy({ programId: OTHER_ID }),
      dispatch(),
    )
    const nextWeek = planElearningNewHireWeeklyReport(
      policy(),
      dispatch({ scheduledFor: '2026-09-07T01:30:00Z' }),
    )
    expect(new Set([
      first.jobOccurrenceKey,
      otherOrg.jobOccurrenceKey,
      otherProgram.jobOccurrenceKey,
      nextWeek.jobOccurrenceKey,
    ]).size).toBe(4)
    expect(nextWeek.reportWeek).toBe('2026-W37')
  })

  it('deduplicates both fall-back instants into the same local weekly occurrence', () => {
    const fallBackPolicy = policy({
      localTime: '01:30',
      timeZone: 'America/New_York',
      weekday: 7,
    })
    const first = planElearningNewHireWeeklyReport(
      fallBackPolicy,
      dispatch({ scheduledFor: '2026-11-01T05:30:00Z' }),
    )
    const second = planElearningNewHireWeeklyReport(
      fallBackPolicy,
      dispatch({ scheduledFor: '2026-11-01T06:30:00Z' }),
    )
    expect(first.outcome).toBe('ready')
    expect(second.outcome).toBe('ready')
    expect(second.reportWeek).toBe(first.reportWeek)
    expect(second.jobOccurrenceKey).toBe(first.jobOccurrenceKey)
    expect(second.deliveries[0].deliveryKey).toBe(first.deliveries[0].deliveryKey)
  })

  it('uses the local ISO week-year across the calendar-year boundary', () => {
    const sunday = planElearningNewHireWeeklyReport(
      policy({ localTime: '09:30', timeZone: 'UTC', weekday: 7 }),
      dispatch({ scheduledFor: '2027-01-03T09:30:00Z' }),
    )
    const monday = planElearningNewHireWeeklyReport(
      policy({ localTime: '09:30', timeZone: 'UTC', weekday: 1 }),
      dispatch({ scheduledFor: '2027-01-04T09:30:00Z' }),
    )
    expect(sunday.reportWeek).toBe('2026-W53')
    expect(monday.reportWeek).toBe('2027-W01')
    expect(monday.jobOccurrenceKey).not.toBe(sunday.jobOccurrenceKey)
  })

  it('returns disabled and not-due decisions without creating effect identities', () => {
    const disabled = planElearningNewHireWeeklyReport(
      policy({ enabled: false, recipientUserIds: [] }),
      dispatch({ recipientAuthorizations: [] }),
    )
    expect(disabled).toEqual({
      deliveries: [],
      jobOccurrenceKey: null,
      outcome: 'disabled',
      policyRevisionId: POLICY_REVISION_ID,
      programId: PROGRAM_ID,
      reportWeek: null,
      scheduledFor: null,
      suppressedRecipientCount: 0,
    })
    for (const scheduledFor of [
      '2026-08-31T01:29:00Z',
      '2026-09-01T01:30:00Z',
    ]) {
      const notDue = planElearningNewHireWeeklyReport(
        policy(),
        dispatch({ scheduledFor }),
      )
      expect(notDue).toMatchObject({
        deliveries: [],
        jobOccurrenceKey: null,
        outcome: 'not_due',
        reportWeek: null,
        suppressedRecipientCount: 0,
      })
    }
  })

  it('suppresses every recipient whose tracking permission was revoked', () => {
    const result = planElearningNewHireWeeklyReport(policy(), dispatch({
      recipientAuthorizations: [
        authorization(RECIPIENT_A, false),
        authorization(RECIPIENT_B, false),
      ],
    }))
    expect(result).toMatchObject({
      deliveries: [],
      outcome: 'no_authorized_recipients',
      reportWeek: '2026-W36',
      suppressedRecipientCount: 2,
    })
    expect(result.jobOccurrenceKey).not.toBeNull()
  })

  it('creates one distinct effect identity for every currently authorized recipient', () => {
    const result = planElearningNewHireWeeklyReport(policy(), dispatch({
      recipientAuthorizations: [
        authorization(RECIPIENT_A, true),
        authorization(RECIPIENT_B, true),
      ],
    }))
    expect(result.deliveries.map((delivery) => delivery.recipientUserId)).toEqual([
      RECIPIENT_A,
      RECIPIENT_B,
    ])
    expect(new Set(result.deliveries.map((delivery) => delivery.deliveryKey)).size).toBe(2)
    expect(result.suppressedRecipientCount).toBe(0)
  })

  it('requires an exact current authorization decision for every configured recipient', () => {
    for (const recipientAuthorizations of [
      [authorization(RECIPIENT_A, true)],
      [
        authorization(RECIPIENT_A, true),
        authorization(RECIPIENT_B, false),
        authorization(OTHER_ID, true),
      ],
      [
        authorization(RECIPIENT_A, true),
        authorization(RECIPIENT_A.toUpperCase(), false),
      ],
      [
        authorization(RECIPIENT_A, true),
        authorization(RECIPIENT_B, 'yes'),
      ],
    ]) {
      expectCode(() => planElearningNewHireWeeklyReport(policy(), dispatch({
        recipientAuthorizations,
      })), 'invalid_authorization')
    }
  })

  it('rejects invalid or open policy shapes values-free', () => {
    for (const value of [
      null,
      {},
      { ...policy(), extra: SENTINEL },
      policy({ enabled: 'yes' }),
      policy({ enabled: true, recipientUserIds: [] }),
      policy({ localTime: '9:30' }),
      policy({ localTime: '24:00' }),
      policy({ weekday: 0 }),
      policy({ weekday: 8 }),
      policy({ weekday: 1.5 }),
      policy({ timeZone: SENTINEL }),
      policy({ orgId: '' }),
      policy({ orgId: '\ud800' }),
      policy({ programId: 'program-1' }),
      policy({ policyRevisionId: 'revision-1' }),
      policy({ recipientUserIds: [RECIPIENT_A, RECIPIENT_A.toUpperCase()] }),
    ]) {
      expectCode(() => createElearningNewHireWeeklyReportPolicy(value), 'invalid_policy')
    }
  })

  it('rejects invalid dispatch shapes and timestamps values-free', () => {
    for (const value of [
      null,
      {},
      { ...dispatch(), extra: SENTINEL },
      dispatch({ scheduledFor: '2026-08-31 01:30:00' }),
      dispatch({ scheduledFor: '2026-02-30T01:30:00Z' }),
    ]) {
      expectCode(
        () => planElearningNewHireWeeklyReport(policy(), value),
        'invalid_dispatch',
      )
    }
  })

  it('fails closed on sparse, oversized and hostile recipient inputs', () => {
    expectCode(() => createElearningNewHireWeeklyReportPolicy(policy({
      recipientUserIds: new Array(1),
    })), 'invalid_policy')
    expectCode(() => createElearningNewHireWeeklyReportPolicy(policy({
      recipientUserIds: Array.from(
        { length: 101 },
        (_, index) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      ),
    })), 'invalid_policy')
    expectCode(() => planElearningNewHireWeeklyReport(
      policy(),
      dispatch({ recipientAuthorizations: new Array(2) }),
    ), 'invalid_authorization')
    const hostile = Object.defineProperty(policy(), 'orgId', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(
      () => createElearningNewHireWeeklyReportPolicy(hostile),
      'invalid_policy',
    )
  })

  it('does not retain mutable caller arrays', () => {
    const recipientUserIds = [RECIPIENT_A]
    const snapshot = createElearningNewHireWeeklyReportPolicy(policy({
      recipientUserIds,
    }))
    recipientUserIds[0] = SENTINEL
    recipientUserIds.push(RECIPIENT_B)
    expect(snapshot.recipientUserIds).toEqual([RECIPIENT_A])
  })
})
