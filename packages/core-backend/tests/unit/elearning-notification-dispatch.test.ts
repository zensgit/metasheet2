import { describe, expect, it, vi } from 'vitest'
import { dispatchElearningNotification, isElearningNotificationDispatchEnabled } from '../../src/services/elearning-notification-dispatch'
import type { ElearningNotificationDeliveryDb } from '../../src/services/elearning-notification-delivery'

const env = {
  ELEARNING_ENABLED: 'true', ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_ASSIGNMENT_ENABLED: 'true', ELEARNING_NOTIFICATIONS_ENABLED: 'true',
  ELEARNING_ENROLLMENT_ENABLED: 'true',
  ELEARNING_NOTIFICATIONS_SINCE: '2026-09-08T00:00:00.000Z',
}
const input = {
  orgId: 'synthetic-org', deliveryId: '11111111-1111-4111-8111-111111111111',
  assignmentMemberId: '22222222-2222-4222-8222-222222222222',
  idempotencyKey: 'delivery:11111111-1111-4111-8111-111111111111',
  recipientUserId: 'synthetic-user', kind: 'assignment_reminder' as const, payload: {},
}

function fixture() {
  let state = 'idle'
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes(':load')) return { rows: [{ dispatch_state: state, status: 'sending', due_at: env.ELEARNING_NOTIFICATIONS_SINCE }], rowCount: 1 }
    if (sql.includes(':claim')) {
      if (state !== 'idle') return { rows: [], rowCount: 0 }
      state = 'claimed'
    }
    if (sql.includes(':finalize')) state = String(params?.[2])
    return { rows: [{ id: input.deliveryId }], rowCount: 1 }
  })
  const db: ElearningNotificationDeliveryDb = { query, transaction: (fn) => fn(db) }
  const send = vi.fn(async () => ({ outcome: 'sent' as const }))
  const prepare = vi.fn(async () => ({ outcome: 'prepared' as const, send }))
  const eligible = vi.fn(async () => true)
  return { db, query, send, prepare, eligible, options: { env: { ...env }, prepare, eligible }, state: () => state }
}

describe('e-learning personal notification effect fence', () => {
  it('an advanced cutoff cannot overwrite sent or uncertain recorded outcomes', async () => {
    for (const state of ['sent', 'claimed']) {
      const f = fixture()
      f.query.mockResolvedValueOnce({ rows: [{ dispatch_state: state, status: 'sending', due_at: '2026-09-07T23:59:59.999Z' }], rowCount: 1 })
      expect(await dispatchElearningNotification(f.db, input, f.options)).toEqual(state === 'sent'
        ? { outcome: 'sent' }
        : { outcome: 'outcome_unknown', code: 'NOTIFICATION_EFFECT_UNKNOWN' })
      expect(f.prepare).not.toHaveBeenCalled()
    }
  })
  it('rejects historical pending deliveries and missing cutoff without provider calls', async () => {
    const f = fixture()
    f.query.mockResolvedValueOnce({ rows: [{ dispatch_state: 'idle', status: 'sending', due_at: '2026-09-07T23:59:59.999Z' }], rowCount: 1 })
    expect(await dispatchElearningNotification(f.db, input, f.options))
      .toEqual({ outcome: 'failed', code: 'NOTIFICATION_BEFORE_CUTOFF' })
    expect(f.prepare).not.toHaveBeenCalled()
    const missing = fixture()
    missing.options.env.ELEARNING_NOTIFICATIONS_SINCE = ''
    expect(await dispatchElearningNotification(missing.db, input, missing.options))
      .toEqual({ outcome: 'retryable', code: 'NOTIFICATION_CUTOFF_REQUIRED' })
    expect(missing.query).not.toHaveBeenCalled()
  })
  it('requires every exact gate and performs no SQL/network while disabled', async () => {
    for (const key of ['ELEARNING_ENABLED', 'ELEARNING_CONTENT_ENABLED', 'ELEARNING_NOTIFICATIONS_ENABLED']) {
      for (const value of [undefined, '', 'false', 'TRUE', '1']) {
        const f = fixture()
        const flags = { ...env, [key]: value }
        expect(isElearningNotificationDispatchEnabled(flags)).toBe(false)
        expect(await dispatchElearningNotification(f.db, input, { ...f.options, env: flags }))
          .toEqual({ outcome: 'retryable', code: 'NOTIFICATION_DISABLED' })
        expect(f.query).not.toHaveBeenCalled()
        expect(f.prepare).not.toHaveBeenCalled()
      }
    }
  })

  it('fences before send, persists success and replays without another effect', async () => {
    const f = fixture()
    f.send.mockImplementation(async () => {
      expect(f.state()).toBe('claimed')
      return { outcome: 'sent' }
    })
    expect(await dispatchElearningNotification(f.db, input, f.options)).toEqual({ outcome: 'sent' })
    expect(await dispatchElearningNotification(f.db, input, f.options)).toEqual({ outcome: 'sent' })
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.eligible).toHaveBeenCalledTimes(2)
    expect(f.query.mock.calls[0]?.[1]).toEqual([
      input.orgId, input.deliveryId, input.assignmentMemberId, input.recipientUserId, input.kind,
    ])
  })

  it('two reclaimed workers cannot both send the same effect', async () => {
    const f = fixture()
    const results = await Promise.all([
      dispatchElearningNotification(f.db, input, f.options),
      dispatchElearningNotification(f.db, input, f.options),
    ])
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(results).toContainEqual({ outcome: 'sent' })
    expect(results).toContainEqual({ outcome: 'outcome_unknown', code: 'NOTIFICATION_EFFECT_UNKNOWN' })
  })
  it('turning the kind gate OFF while claim is in flight prevents sending and keeps the fence', async () => {
    const f = fixture()
    const original = f.query.getMockImplementation()!
    f.query.mockImplementation(async (sql, params) => {
      const result = await original(sql, params)
      if (sql.includes(':claim')) f.options.env.ELEARNING_ASSIGNMENT_ENABLED = 'false'
      return result
    })
    expect(await dispatchElearningNotification(f.db, input, f.options))
      .toEqual({ outcome: 'outcome_unknown', code: 'NOTIFICATION_EFFECT_UNKNOWN' })
    expect(f.state()).toBe('claimed')
    expect(f.send).not.toHaveBeenCalled()
  })

  it('enrollment messages do not depend on the unrelated assessment or assignment gates', async () => {
    const f = fixture()
    f.options.env.ELEARNING_ASSIGNMENT_ENABLED = 'false'
    expect(await dispatchElearningNotification(f.db, {
      ...input, assignmentMemberId: null, kind: 'training_available',
    }, f.options)).toEqual({ outcome: 'sent' })
  })

  it('training messages enforce their source capability before SQL and after claim', async () => {
    for (const assignmentMemberId of [input.assignmentMemberId, null]) {
      const key = assignmentMemberId === null ? 'ELEARNING_ENROLLMENT_ENABLED' : 'ELEARNING_ASSIGNMENT_ENABLED'
      const training = { ...input, assignmentMemberId, kind: 'training_available' as const }
      const disabled = fixture()
      disabled.options.env[key] = 'false'
      expect(await dispatchElearningNotification(disabled.db, training, disabled.options))
        .toEqual({ outcome: 'retryable', code: 'NOTIFICATION_DISABLED' })
      expect(disabled.query).not.toHaveBeenCalled()
      const f = fixture()
      const original = f.query.getMockImplementation()!
      f.query.mockImplementation(async (sql, params) => {
        const result = await original(sql, params)
        if (sql.includes(':claim')) f.options.env[key] = 'false'
        return result
      })
      expect(await dispatchElearningNotification(f.db, training, f.options))
        .toEqual({ outcome: 'outcome_unknown', code: 'NOTIFICATION_EFFECT_UNKNOWN' })
      expect(f.send).not.toHaveBeenCalled()
    }
  })

  it('never retries an uncertain send even when a worker is reclaimed', async () => {
    const f = fixture()
    f.send.mockRejectedValue(new Error('private provider response'))
    expect(await dispatchElearningNotification(f.db, input, f.options))
      .toEqual({ outcome: 'outcome_unknown', code: 'NOTIFICATION_EFFECT_UNKNOWN' })
    expect(await dispatchElearningNotification(f.db, input, f.options))
      .toEqual({ outcome: 'outcome_unknown', code: 'NOTIFICATION_EFFECT_UNKNOWN' })
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('preflight failure remains safely retryable before claiming', async () => {
    const f = fixture()
    const prepare = vi.fn(async () => ({ outcome: 'retryable' as const, code: 'NOTIFICATION_CONFIG_UNAVAILABLE' }))
    expect(await dispatchElearningNotification(f.db, input, { ...f.options, prepare }))
      .toEqual({ outcome: 'retryable', code: 'NOTIFICATION_CONFIG_UNAVAILABLE' })
    expect(f.state()).toBe('idle')
    expect(await dispatchElearningNotification(f.db, input, f.options)).toEqual({ outcome: 'sent' })
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('a database read failure before the effect fence is safe to retry', async () => {
    const f = fixture()
    f.query.mockRejectedValueOnce(new Error('private diagnostics'))
    expect(await dispatchElearningNotification(f.db, input, f.options))
      .toEqual({ outcome: 'retryable', code: 'NOTIFICATION_DISPATCH_UNAVAILABLE' })
    expect(f.send).not.toHaveBeenCalled()
    expect(await dispatchElearningNotification(f.db, input, f.options)).toEqual({ outcome: 'sent' })
  })

  it('rechecks eligibility after slow configuration/token preparation', async () => {
    const f = fixture()
    f.eligible.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    expect(await dispatchElearningNotification(f.db, input, f.options))
      .toEqual({ outcome: 'failed', code: 'NOTIFICATION_INELIGIBLE' })
    expect(f.state()).toBe('idle')
    expect(f.send).not.toHaveBeenCalled()
  })

  it('cross-org/recipient or nonexistent delivery never reaches the provider', async () => {
    const f = fixture()
    f.query.mockResolvedValue({ rows: [], rowCount: 0 })
    expect(await dispatchElearningNotification(f.db, input, f.options))
      .toEqual({ outcome: 'failed', code: 'NOTIFICATION_NOT_FOUND' })
    expect(f.prepare).not.toHaveBeenCalled()
  })

  it('rejects a different effect key and unsupported kind before SQL', async () => {
    for (const changed of [{ idempotencyKey: 'other' }, { kind: 'unknown' }]) {
      const f = fixture()
      expect(await dispatchElearningNotification(f.db, { ...input, ...changed } as typeof input, f.options))
        .toEqual({ outcome: 'failed', code: 'NOTIFICATION_INPUT_INVALID' })
      expect(f.query).not.toHaveBeenCalled()
    }
  })

  it('an unknown finalize outcome cannot make a sent message resendable', async () => {
    const f = fixture()
    const original = f.query.getMockImplementation()!
    f.query.mockImplementation(async (sql, params) => {
      if (sql.includes(':finalize')) throw new Error('private database diagnostic')
      return original(sql, params)
    })
    expect(await dispatchElearningNotification(f.db, input, f.options))
      .toEqual({ outcome: 'outcome_unknown', code: 'NOTIFICATION_DISPATCH_UNAVAILABLE' })
    expect(await dispatchElearningNotification(f.db, input, f.options))
      .toEqual({ outcome: 'outcome_unknown', code: 'NOTIFICATION_EFFECT_UNKNOWN' })
    expect(f.send).toHaveBeenCalledTimes(1)
  })
})
