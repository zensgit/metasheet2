import { describe, expect, it } from 'vitest'

import {
  ElearningAssignmentReminderError,
  checkElearningAssignmentReminderEligibility,
  deriveElearningAssignmentReminderOccurrenceKey,
  produceElearningAssignmentReminder,
} from '../../src/services/elearning-assignment-reminder'
import type {
  ElearningNotificationDeliveryDb,
  ElearningNotificationDeliveryQueryable,
} from '../../src/services/elearning-notification-delivery'

const ORG = 'org-reminder-producer'
const MEMBER = '11111111-1111-4111-8111-111111111111'
const ASSIGNMENT = '22222222-2222-4222-8222-222222222222'
const VERSION = '33333333-3333-4333-8333-333333333333'
const USER = 'learner:one@example.test'
const WINDOW_START = '2026-08-27T00:00:00.000Z'
const DUE_AT = '2026-08-27T01:00:00.000Z'
const OCCURRENCE_KEY =
  `assignment:${ASSIGNMENT}:user:learner%3Aone%40example.test:window:2026-08-27T00:00:00Z`

function marker(sql: string): string | undefined {
  return sql.match(/\/\* ([^*]+) \*\//)?.[1]
}

function result(rows: Array<Record<string, unknown>> = []) {
  return { rows, rowCount: rows.length }
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    member_id: MEMBER,
    assignment_id: ASSIGNMENT,
    user_id: USER,
    revoked_at: null,
    course_version_id: VERSION,
    deadline: '2026-08-28T00:00:00.000Z',
    course_head_status: 'active',
    video_status: 'in_progress',
    exam_status: 'started',
    passed: false,
    ...overrides,
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    assignmentMemberId: MEMBER,
    occurrenceKey: OCCURRENCE_KEY,
    windowStart: WINDOW_START,
    dueAt: DUE_AT,
    ...overrides,
  }
}

class ScriptDb implements ElearningNotificationDeliveryDb {
  readonly calls: Array<{ sql: string; params?: unknown[] }> = []

  constructor(
    private readonly handler: (
      sql: string,
      params?: unknown[],
    ) => { rows: Array<Record<string, unknown>>; rowCount: number | null },
  ) {}

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params })
    return this.handler(sql, params)
  }

  async transaction<T>(
    handler: (tx: ElearningNotificationDeliveryQueryable) => Promise<T>,
  ): Promise<T> {
    return handler(this)
  }
}

function eligibleDb(row = candidate()) {
  return new ScriptDb((sql) => {
    if (marker(sql) === 'elearning-assignment-reminder:load-candidate') return result([row])
    if (marker(sql) === 'elearning-notification-delivery:load-member') {
      return result([{
        user_id: USER,
        revoked_at: row.revoked_at,
        deadline: row.deadline,
        course_status: row.course_head_status,
      }])
    }
    return result()
  })
}

describe('e-learning assignment reminder intent producer', () => {
  it('derives the ratified server-owned occurrence key deterministically', () => {
    expect(deriveElearningAssignmentReminderOccurrenceKey({
      assignmentId: ASSIGNMENT.toUpperCase(),
      userId: USER,
      windowStart: WINDOW_START,
    })).toBe(OCCURRENCE_KEY)
    expect(deriveElearningAssignmentReminderOccurrenceKey({
      assignmentId: ASSIGNMENT,
      userId: 'plain-user',
      windowStart: '2026-08-27T00:00:00.123Z',
    })).toBe(
      `assignment:${ASSIGNMENT}:user:plain-user:window:2026-08-27T00:00:00.123Z`,
    )
  })

  it('creates one server-derived intent for an active incomplete member', async () => {
    const db = eligibleDb()
    const produced = await produceElearningAssignmentReminder(db, input())
    expect(produced).toMatchObject({ outcome: 'enqueued' })
    if (produced.outcome !== 'enqueued') throw new Error('expected enqueued')
    expect(produced.deliveryId).toMatch(UUID_RE_FOR_TEST)
    expect(db.calls.map((call) => marker(call.sql))).toEqual([
      'elearning-assignment-reminder:load-candidate',
      'elearning-notification-delivery:lock',
      'elearning-notification-delivery:load-existing',
      'elearning-notification-delivery:load-member',
      'elearning-notification-delivery:insert',
    ])
    const insert = db.calls.find(
      (call) => marker(call.sql) === 'elearning-notification-delivery:insert',
    )
    expect(insert?.params?.[3]).toBe(OCCURRENCE_KEY)
    expect(JSON.parse(String(insert?.params?.[7]))).toEqual({
      assignmentId: ASSIGNMENT,
      assignmentMemberId: MEMBER,
      courseVersionId: VERSION,
      windowStart: WINDOW_START,
    })
  })

  it('keeps archived assigned members eligible', async () => {
    const db = eligibleDb(candidate({ course_head_status: 'archived' }))
    await expect(produceElearningAssignmentReminder(db, input()))
      .resolves.toMatchObject({ outcome: 'enqueued' })
  })

  it('rechecks current recipient and course state immediately before dispatch', async () => {
    for (const row of [candidate(), candidate({ course_head_status: 'archived' })]) {
      await expect(checkElearningAssignmentReminderEligibility(eligibleDb(row), {
        orgId: ORG,
        assignmentMemberId: MEMBER,
        recipientUserId: USER,
      })).resolves.toBe(true)
    }
    for (const row of [
      candidate({ revoked_at: DUE_AT }),
      candidate({ deadline: null }),
      candidate({ course_head_status: 'withdrawn' }),
      candidate({ video_status: 'completed', exam_status: 'graded', passed: true }),
      candidate({ video_status: 'completed', exam_status: 'awaiting_manual', passed: false }),
    ]) {
      await expect(checkElearningAssignmentReminderEligibility(eligibleDb(row), {
        orgId: ORG,
        assignmentMemberId: MEMBER,
        recipientUserId: USER,
      })).resolves.toBe(false)
    }
    await expect(checkElearningAssignmentReminderEligibility(eligibleDb(), {
      orgId: ORG,
      assignmentMemberId: MEMBER,
      recipientUserId: 'other-user',
    })).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('creates no intent for revoked, no-deadline, withdrawn, or completed members', async () => {
    for (const row of [
      candidate({ revoked_at: DUE_AT }),
      candidate({ deadline: null }),
      candidate({ course_head_status: 'withdrawn' }),
      candidate({ video_status: 'completed', exam_status: 'graded', passed: true }),
      candidate({ video_status: 'completed', exam_status: 'awaiting_manual', passed: false }),
    ]) {
      const db = eligibleDb(row)
      await expect(produceElearningAssignmentReminder(db, input()))
        .resolves.toEqual({ outcome: 'ineligible' })
      expect(db.calls.map((call) => marker(call.sql))).toEqual([
        'elearning-assignment-reminder:load-candidate',
      ])
    }
  })

  it('does not mistake a passed exam or completed video alone for course completion', async () => {
    for (const row of [
      candidate({ video_status: 'in_progress', exam_status: 'graded', passed: true }),
      candidate({ video_status: 'completed', exam_status: 'graded', passed: false }),
      candidate({ video_status: 'in_progress', exam_status: 'awaiting_manual', passed: false }),
    ]) {
      const db = eligibleDb(row)
      await expect(produceElearningAssignmentReminder(db, input()))
        .resolves.toMatchObject({ outcome: 'enqueued' })
    }
  })

  it('rejects malformed policy envelopes before SQL and mismatched server-derived keys', async () => {
    for (const request of [
      input({ orgId: ' org-reminder-producer' }),
      input({ orgId: 'org\ud800' }),
      input({ assignmentMemberId: 'not-a-uuid' }),
      input({ windowStart: '2026-08-27T00:00:00Z' }),
      input({ dueAt: '2026-08-26T23:59:59.999Z' }),
    ]) {
      const db = new ScriptDb(() => {
        throw new Error('must not query')
      })
      await expect(produceElearningAssignmentReminder(db, request as never))
        .rejects.toMatchObject({ code: 'invalid_input' })
      expect(db.calls).toEqual([])
    }

    const mismatch = eligibleDb()
    await expect(produceElearningAssignmentReminder(
      mismatch,
      input({ occurrenceKey: `${OCCURRENCE_KEY}:other` }),
    )).rejects.toMatchObject({ code: 'invalid_input' })
    expect(mismatch.calls).toHaveLength(1)
  })

  it('fails closed for missing or malformed same-org candidate data without leaking values', async () => {
    for (const rows of [
      [],
      [candidate({ member_id: '44444444-4444-4444-8444-444444444444' })],
      [candidate({ user_id: ' learner' })],
      [candidate({ user_id: 'learner\udc00' })],
      [candidate({ passed: 'true' })],
    ]) {
      const db = new ScriptDb((sql) => (
        marker(sql) === 'elearning-assignment-reminder:load-candidate'
          ? result(rows)
          : result()
      ))
      let caught: unknown
      try {
        await produceElearningAssignmentReminder(db, input())
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(ElearningAssignmentReminderError)
      expect(caught).toMatchObject({ code: rows.length === 0 ? 'not_found' : 'unavailable' })
      expect(`${(caught as Error).message}\n${(caught as Error).stack ?? ''}`)
        .not.toContain(ORG)
    }
  })
})

const UUID_RE_FOR_TEST = /^[0-9a-f]{8}-[0-9a-f-]{27}$/
