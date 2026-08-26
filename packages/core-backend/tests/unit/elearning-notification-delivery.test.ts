import { describe, expect, it } from 'vitest'

import {
  canonicalizeElearningNotificationRequest,
  elearningNotificationDeliveryLockKey,
  enqueueElearningNotificationDelivery,
  hashElearningNotificationRequest,
  type ElearningNotificationDeliveryDb,
  type ElearningNotificationDeliveryQueryable,
} from '../../src/services/elearning-notification-delivery'

const ORG = 'org-notification-ledger'
const MEMBER = '11111111-1111-4111-8111-111111111111'
const USER = 'user-notification-ledger'
const DUE_AT = '2026-08-27T01:00:00.000Z'

function marker(sql: string): string | undefined {
  return sql.match(/\/\* ([^*]+) \*\//)?.[1]
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

function result(rows: Array<Record<string, unknown>> = []) {
  return { rows, rowCount: rows.length }
}

function input(payload: Record<string, unknown> = { course: 'intro' }) {
  return {
    orgId: ORG,
    assignmentMemberId: MEMBER,
    recipientUserId: USER,
    sourceKey: 'assignment:a:user:u:window:2026-08-27T01:00:00Z',
    dueAt: DUE_AT,
    payload,
  }
}

describe('e-learning notification delivery intent', () => {
  it('canonicalizes nested payload keys and UTC timestamps deterministically', () => {
    const left = canonicalizeElearningNotificationRequest({
      assignmentMemberId: MEMBER,
      recipientUserId: USER,
      dueAt: DUE_AT,
      payload: { z: 1, nested: { b: true, a: false } },
    })
    const right = canonicalizeElearningNotificationRequest({
      assignmentMemberId: MEMBER,
      recipientUserId: USER,
      dueAt: DUE_AT,
      payload: { nested: { a: false, b: true }, z: 1 },
    })
    expect(left).toBe(right)
    const baselineHash = hashElearningNotificationRequest({
      assignmentMemberId: MEMBER,
      recipientUserId: USER,
      dueAt: DUE_AT,
      payload: { z: 1, nested: { b: true, a: false } },
    })
    expect(baselineHash).toMatch(/^[0-9a-f]{64}$/)
    for (const changed of [
      {
        assignmentMemberId: '33333333-3333-4333-8333-333333333333',
        recipientUserId: USER,
        dueAt: DUE_AT,
      },
      {
        assignmentMemberId: MEMBER,
        recipientUserId: `${USER}-other`,
        dueAt: DUE_AT,
      },
      {
        assignmentMemberId: MEMBER,
        recipientUserId: USER,
        dueAt: '2026-08-27T02:00:00.000Z',
      },
    ]) {
      expect(hashElearningNotificationRequest({
        ...changed,
        payload: { z: 1, nested: { b: true, a: false } },
      })).not.toBe(baselineHash)
    }
  })

  it('locks, validates the same-org active member, and inserts one pending intent', async () => {
    const db = new ScriptDb((sql) => {
      if (marker(sql) === 'elearning-notification-delivery:load-member') {
        return result([{ user_id: USER, revoked_at: null, deadline: DUE_AT }])
      }
      return result()
    })

    const value = await enqueueElearningNotificationDelivery(db, input())
    expect(value).toMatchObject({ status: 'pending', duplicate: false })
    expect(value.deliveryId).toMatch(/^[0-9a-f-]{36}$/)
    expect(db.calls.map((call) => marker(call.sql))).toEqual([
      'elearning-notification-delivery:lock',
      'elearning-notification-delivery:load-existing',
      'elearning-notification-delivery:load-member',
      'elearning-notification-delivery:insert',
    ])
    expect(db.calls[0]?.params).toEqual([
      elearningNotificationDeliveryLockKey(ORG, input().sourceKey),
    ])
  })

  it('returns an idempotent replay without re-reading mutable member state', async () => {
    const request = input({ b: 2, a: 1 })
    const payload = { a: 1, b: 2 }
    const requestHash = hashElearningNotificationRequest({
      assignmentMemberId: MEMBER,
      recipientUserId: USER,
      dueAt: DUE_AT,
      payload,
    })
    const db = new ScriptDb((sql) => {
      if (marker(sql) === 'elearning-notification-delivery:load-existing') {
        return result([{
          id: '22222222-2222-4222-8222-222222222222',
          request_hash: requestHash,
          request_hash_version: 1,
          status: 'sent',
        }])
      }
      return result()
    })

    await expect(enqueueElearningNotificationDelivery(db, request)).resolves.toEqual({
      deliveryId: '22222222-2222-4222-8222-222222222222',
      status: 'sent',
      duplicate: true,
    })
    expect(db.calls.some(
      (call) => marker(call.sql) === 'elearning-notification-delivery:load-member',
    )).toBe(false)
  })

  it('fails closed when a stored delivery identity is malformed', async () => {
    const request = input()
    const requestHash = hashElearningNotificationRequest({
      assignmentMemberId: MEMBER,
      recipientUserId: USER,
      dueAt: DUE_AT,
      payload: request.payload,
    })
    const db = new ScriptDb((sql) => {
      if (marker(sql) === 'elearning-notification-delivery:load-existing') {
        return result([{
          id: 'not-a-uuid',
          request_hash: requestHash,
          request_hash_version: 1,
          status: 'pending',
        }])
      }
      return result()
    })

    await expect(enqueueElearningNotificationDelivery(db, request))
      .rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects the same source key with a different normalized request', async () => {
    const db = new ScriptDb((sql) => {
      if (marker(sql) === 'elearning-notification-delivery:load-existing') {
        return result([{
          id: '22222222-2222-4222-8222-222222222222',
          request_hash: '0'.repeat(64),
          request_hash_version: 1,
          status: 'pending',
        }])
      }
      return result()
    })

    let caught: unknown
    try {
      await enqueueElearningNotificationDelivery(db, input({ secret: 'must-not-leak' }))
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'conflict' })
    const blob = `${(caught as Error).message}\n${(caught as Error).stack ?? ''}`
    expect(blob).not.toContain(input().sourceKey)
    expect(blob).not.toContain('must-not-leak')
    expect(blob).not.toContain('0'.repeat(64))
  })

  it('fails closed for a revoked, mismatched, or deadline-free member without leaking values', async () => {
    const db = new ScriptDb((sql) => {
      if (marker(sql) === 'elearning-notification-delivery:load-member') {
        return result([{ user_id: USER, revoked_at: DUE_AT, deadline: null }])
      }
      return result()
    })

    let caught: unknown
    try {
      await enqueueElearningNotificationDelivery(db, input())
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'not_eligible' })
    expect(`${(caught as Error).message}\n${(caught as Error).stack ?? ''}`)
      .not.toContain(ORG)
  })

  it('maps transaction-boundary failures to a values-free unavailable error', async () => {
    const db: ElearningNotificationDeliveryDb = {
      query: async () => result(),
      transaction: async () => {
        throw new Error(`commit failed for ${ORG}`)
      },
    }

    let caught: unknown
    try {
      await enqueueElearningNotificationDelivery(db, input())
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'unavailable' })
    expect(`${(caught as Error).message}\n${(caught as Error).stack ?? ''}`)
      .not.toContain(ORG)
  })
})
