import { describe, expect, it } from 'vitest'
import {
  TASK_DELIVERY_BACKOFF_LADDER_MS,
  TASK_DELIVERY_BATCH_SIZE_DEFAULT,
  TASK_DELIVERY_BATCH_SIZE_MAX,
  TASK_DELIVERY_BATCH_SIZE_MIN,
  TASK_DELIVERY_DEFAULTS,
  TASK_DELIVERY_FENCE_MARGIN_MS,
  TASK_DELIVERY_LEASE_MS_DEFAULT,
  TASK_DELIVERY_LEASE_MS_MAX,
  TASK_DELIVERY_LEASE_MS_MIN,
  TASK_DELIVERY_MAX_ATTEMPTS_DEFAULT,
  TASK_DELIVERY_OUTCOMES,
  TASK_DELIVERY_MATERIALISE_ALLOWANCE_MS,
  TASK_DELIVERY_PREPARE_BUDGET_MS,
  TASK_DELIVERY_PRIORITY_SOURCE_TYPES,
  TASK_DELIVERY_ROW_BUDGET_MS,
  TASK_DELIVERY_ROW_RESERVE_MS,
  TASK_DELIVERY_SEND_LEASE_MS,
  TASK_DELIVERY_STATUSES,
  TASK_DELIVERY_TICK_BUDGET_MS,
  TASK_DINGTALK_BASE_HOST,
  TASK_DINGTALK_REQUEST_TIMEOUT_MS,
  TASK_EVENT_NOTIFICATION_MAX_AGE_MS,
  clampDeliveryBatchSize,
  clampDeliveryLeaseMs,
  classifyTaskDeliveryOutcome,
  computeTaskDeliveryBackoffMs,
  isAllowedTaskDingTalkBaseUrl,
  isTaskEventNotificationStale,
  orderClaimedDeliveries,
  type ClaimedDeliveryOrderKey,
  type TaskDeliveryChannelResult,
} from '../../src/tasks/task-delivery-protocol'
import { TASK_SCHEDULER_INTERVAL_DEFAULT_MS } from '../../src/services/task-notification-flags'
import { TASK_NOTIFICATION_SOURCE_TYPES } from '../../src/tasks/task-notifications'

describe('task-delivery-protocol', () => {
  describe('constants ([own-3b-08])', () => {
    it('batch 50 in [1, 200]; maxAttempts 5', () => {
      expect(TASK_DELIVERY_BATCH_SIZE_DEFAULT).toBe(50)
      expect(TASK_DELIVERY_BATCH_SIZE_MIN).toBe(1)
      expect(TASK_DELIVERY_BATCH_SIZE_MAX).toBe(200)
      expect(TASK_DELIVERY_MAX_ATTEMPTS_DEFAULT).toBe(5)
    })

    it('request timeout 10 s, prepare budget 12 s, materialisation allowance 3 s, fence margin 5 s, send lease 15 s, row reserve 30 s', () => {
      expect(TASK_DINGTALK_REQUEST_TIMEOUT_MS).toBe(10_000)
      expect(TASK_DELIVERY_PREPARE_BUDGET_MS).toBe(12_000)
      expect(TASK_DELIVERY_PREPARE_BUDGET_MS).toBeGreaterThan(TASK_DINGTALK_REQUEST_TIMEOUT_MS)
      expect(TASK_DELIVERY_MATERIALISE_ALLOWANCE_MS).toBe(3_000)
      expect(TASK_DELIVERY_FENCE_MARGIN_MS).toBe(5_000)
      expect(TASK_DELIVERY_SEND_LEASE_MS).toBe(15_000)
      expect(TASK_DELIVERY_SEND_LEASE_MS).toBe(TASK_DINGTALK_REQUEST_TIMEOUT_MS + TASK_DELIVERY_FENCE_MARGIN_MS)
      expect(TASK_DELIVERY_ROW_RESERVE_MS).toBe(30_000)
      expect(TASK_DELIVERY_ROW_RESERVE_MS).toBe(TASK_DELIVERY_ROW_BUDGET_MS + TASK_DELIVERY_SEND_LEASE_MS)
    })

    it('row budget 15 s = prepare budget + materialisation allowance ([own-3b-36]): what a row may spend before the fence, strictly above the prepare budget', () => {
      expect(TASK_DELIVERY_ROW_BUDGET_MS).toBe(15_000)
      expect(TASK_DELIVERY_ROW_BUDGET_MS).toBe(TASK_DELIVERY_PREPARE_BUDGET_MS + TASK_DELIVERY_MATERIALISE_ALLOWANCE_MS)
      expect(TASK_DELIVERY_ROW_BUDGET_MS).toBe(TASK_DELIVERY_ROW_RESERVE_MS - TASK_DELIVERY_SEND_LEASE_MS)
      expect(TASK_DELIVERY_ROW_BUDGET_MS).toBeGreaterThan(TASK_DELIVERY_PREPARE_BUDGET_MS)
      expect(TASK_DELIVERY_ROW_BUDGET_MS - TASK_DELIVERY_PREPARE_BUDGET_MS).toBe(TASK_DELIVERY_MATERIALISE_ALLOWANCE_MS)
    })

    it('batch lease 60 s, clamped to [60 s, 600 s] ([own-3b-24]); lease > row reserve', () => {
      expect(TASK_DELIVERY_LEASE_MS_DEFAULT).toBe(60_000)
      expect(TASK_DELIVERY_LEASE_MS_MIN).toBe(60_000)
      expect(TASK_DELIVERY_LEASE_MS_MIN).toBe(2 * TASK_DELIVERY_ROW_RESERVE_MS)
      expect(TASK_DELIVERY_LEASE_MS_MAX).toBe(600_000)
      expect(TASK_DELIVERY_LEASE_MS_DEFAULT).toBeGreaterThan(TASK_DELIVERY_ROW_RESERVE_MS)
      expect(TASK_DELIVERY_LEASE_MS_MIN).toBeGreaterThan(TASK_DELIVERY_ROW_RESERVE_MS)
    })

    it('tick delivery budget 40 s, below the default scheduler interval (design §6.4)', () => {
      expect(TASK_DELIVERY_TICK_BUDGET_MS).toBe(40_000)
      expect(TASK_DELIVERY_TICK_BUDGET_MS).toBeLessThan(TASK_SCHEDULER_INTERVAL_DEFAULT_MS)
    })

    it('TASK_DELIVERY_DEFAULTS bundles the same values and is frozen', () => {
      expect(TASK_DELIVERY_DEFAULTS).toEqual({
        batchSize: 50,
        leaseMs: 60_000,
        maxAttempts: 5,
        requestTimeoutMs: 10_000,
        prepareBudgetMs: 12_000,
        materialiseAllowanceMs: 3_000,
        fenceMarginMs: 5_000,
        sendLeaseMs: 15_000,
        rowReserveMs: 30_000,
        rowBudgetMs: 15_000,
        tickBudgetMs: 40_000,
      })
      expect(Object.isFrozen(TASK_DELIVERY_DEFAULTS)).toBe(true)
      expect(TASK_DELIVERY_DEFAULTS.leaseMs).toBeGreaterThan(TASK_DELIVERY_DEFAULTS.rowReserveMs)
    })

    it('priority families are the two windowed ones ([own-3b-16]) and are known source types', () => {
      expect(TASK_DELIVERY_PRIORITY_SOURCE_TYPES).toEqual(['task_reminder', 'task_daily'])
      for (const t of TASK_DELIVERY_PRIORITY_SOURCE_TYPES) {
        expect(TASK_NOTIFICATION_SOURCE_TYPES).toContain(t)
      }
    })

    it('event freshness bound 24 h ([own-3b-14])', () => {
      expect(TASK_EVENT_NOTIFICATION_MAX_AGE_MS).toBe(86_400_000)
    })

    it('outcomes and statuses closed sets', () => {
      expect(TASK_DELIVERY_OUTCOMES).toEqual(['sent', 'retrying', 'failed', 'skipped', 'outcome_unknown'])
      expect(TASK_DELIVERY_STATUSES).toEqual(['pending', 'retrying', 'sending', 'sent', 'failed', 'skipped', 'outcome_unknown'])
    })
  })

  describe('computeTaskDeliveryBackoffMs (design §7.3)', () => {
    it('ladder 1 min / 5 min / 15 min / 1 h / 6 h, the last step repeating', () => {
      expect(TASK_DELIVERY_BACKOFF_LADDER_MS).toEqual([60_000, 300_000, 900_000, 3_600_000, 21_600_000])
      expect(computeTaskDeliveryBackoffMs(1)).toBe(60_000)
      expect(computeTaskDeliveryBackoffMs(2)).toBe(300_000)
      expect(computeTaskDeliveryBackoffMs(3)).toBe(900_000)
      expect(computeTaskDeliveryBackoffMs(4)).toBe(3_600_000)
      expect(computeTaskDeliveryBackoffMs(5)).toBe(21_600_000)
      expect(computeTaskDeliveryBackoffMs(6)).toBe(21_600_000)
      expect(computeTaskDeliveryBackoffMs(100)).toBe(21_600_000)
    })

    it('rejects 0, negatives, fractions and non-numbers', () => {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 'x', undefined, null]) {
        expect(() => computeTaskDeliveryBackoffMs(bad as never)).toThrow(TypeError)
      }
    })
  })

  describe('classifyTaskDeliveryOutcome ([own-3b-04])', () => {
    const ok: TaskDeliveryChannelResult = { ok: true }
    const retry: TaskDeliveryChannelResult = { ok: false, retryable: true, error: 'e' }
    const fail: TaskDeliveryChannelResult = { ok: false, retryable: false, error: 'e' }
    const skip: TaskDeliveryChannelResult = { ok: false, retryable: false, error: 'e', skip: true }
    const unknown: TaskDeliveryChannelResult = { ok: false, retryable: true, error: 'e', outcomeUnknown: true }
    const at = (result: unknown, attemptCount: number, fenced: boolean, maxAttempts = 5) =>
      classifyTaskDeliveryOutcome({ result, attemptCount, maxAttempts, fenced })

    it('{ ok: true } after the fence -> sent', () => {
      expect(at(ok, 1, true)).toBe('sent')
      expect(at(ok, 5, true)).toBe('sent')
    })

    it('{ ok: true } before the fence claims a send that cannot have happened -> the bounded retry, never sent', () => {
      expect(at(ok, 1, false)).toBe('retrying')
      expect(at(ok, 4, false)).toBe('retrying')
      expect(at(ok, 5, false)).toBe('failed')
    })

    it('outcomeUnknown after the fence -> outcome_unknown, whatever else the result says', () => {
      expect(at(unknown, 1, true)).toBe('outcome_unknown')
      expect(at(unknown, 5, true)).toBe('outcome_unknown')
      expect(at({ ok: false, retryable: false, error: 'e', outcomeUnknown: true }, 1, true)).toBe('outcome_unknown')
    })

    it('outcomeUnknown before the fence (nothing was sent) -> the bounded retry, whatever else the result says', () => {
      expect(at(unknown, 1, false)).toBe('retrying')
      expect(at(unknown, 5, false)).toBe('failed')
      expect(at({ ok: false, retryable: false, error: 'e', skip: true, outcomeUnknown: true }, 1, false)).toBe('retrying')
      expect(at({ ok: false, retryable: false, error: 'e', outcomeUnknown: true }, 1, false)).toBe('retrying')
    })

    it('invariant: sent / outcome_unknown only after the fence; skipped only before it', () => {
      const population: unknown[] = [
        ok, retry, fail, skip, unknown,
        { ok: false, retryable: true, error: 'e', skip: true },
        { ok: false, retryable: false, error: 'e', skip: true, outcomeUnknown: true },
        new Error('x'), undefined, null, 'x', 42, {}, [], { ok: 'yes' }, { ok: false }, { ok: false, retryable: 'yes' },
      ]
      for (const result of population) {
        for (const attemptCount of [0, 1, 4, 5, 9]) {
          const before = at(result, attemptCount, false)
          const after = at(result, attemptCount, true)
          expect(['skipped', 'retrying', 'failed'], `before ${JSON.stringify(result)}`).toContain(before)
          expect(['sent', 'retrying', 'failed', 'outcome_unknown'], `after ${JSON.stringify(result)}`).toContain(after)
        }
      }
    })

    it('skip -> skipped before the fence; after the fence -> outcome_unknown', () => {
      expect(at(skip, 1, false)).toBe('skipped')
      expect(at(skip, 5, false)).toBe('skipped')
      expect(at(skip, 1, true)).toBe('outcome_unknown')
      expect(at({ ok: false, retryable: true, error: 'e', skip: true }, 1, false)).toBe('skipped')
    })

    it('retryable -> retrying while attemptCount < maxAttempts, else failed (both sides of the fence)', () => {
      expect(at(retry, 1, false)).toBe('retrying')
      expect(at(retry, 4, false)).toBe('retrying')
      expect(at(retry, 5, false)).toBe('failed')
      expect(at(retry, 6, false)).toBe('failed')
      expect(at(retry, 1, true)).toBe('retrying')
      expect(at(retry, 5, true)).toBe('failed')
      expect(at(retry, 2, true, 3)).toBe('retrying')
      expect(at(retry, 3, true, 3)).toBe('failed')
    })

    it('not retryable -> failed on the first attempt already', () => {
      expect(at(fail, 1, false)).toBe('failed')
      expect(at(fail, 1, true)).toBe('failed')
    })

    it('unclassifiable (thrown Error, undefined, text, {}, ok not boolean, retryable missing) -> outcome_unknown after the fence', () => {
      for (const r of [new Error('x'), undefined, null, 'x', 42, {}, { ok: 'yes' }, { ok: false }, { ok: false, retryable: 'yes' }, []]) {
        expect(at(r, 1, true)).toBe('outcome_unknown')
      }
    })

    it('unclassifiable before the fence -> the bounded retryable path', () => {
      for (const r of [new Error('x'), undefined, null, 'x', {}, [], { ok: 'yes' }, { ok: false }, { ok: false, retryable: 'yes' }]) {
        expect(at(r, 1, false)).toBe('retrying')
        expect(at(r, 4, false)).toBe('retrying')
        expect(at(r, 5, false)).toBe('failed')
      }
    })

    it('rejects a malformed attemptCount / maxAttempts / fenced and a non-object input', () => {
      expect(() => classifyTaskDeliveryOutcome({ result: ok, attemptCount: -1, maxAttempts: 5, fenced: true })).toThrow(TypeError)
      expect(() => classifyTaskDeliveryOutcome({ result: ok, attemptCount: 1.5, maxAttempts: 5, fenced: true })).toThrow(TypeError)
      expect(() => classifyTaskDeliveryOutcome({ result: ok, attemptCount: 'x' as never, maxAttempts: 5, fenced: true })).toThrow(TypeError)
      expect(() => classifyTaskDeliveryOutcome({ result: ok, attemptCount: 1, maxAttempts: 0, fenced: true })).toThrow(TypeError)
      expect(() => classifyTaskDeliveryOutcome({ result: ok, attemptCount: 1, maxAttempts: 5, fenced: 'yes' as never })).toThrow(TypeError)
      expect(() => classifyTaskDeliveryOutcome('x' as never)).toThrow(TypeError)
    })
  })

  describe('orderClaimedDeliveries (the claim ORDER BY, design §7.2)', () => {
    const t = (iso: string) => new Date(iso)
    const row = (id: string, sourceType: string, nextAttemptAt: string, createdAt: string): ClaimedDeliveryOrderKey => ({
      id,
      sourceType,
      nextAttemptAt: t(nextAttemptAt),
      createdAt: t(createdAt),
    })

    it('windowed families first, then next_attempt_at, created_at, id ascending', () => {
      const rows = [
        row('d', 'task_event', '2026-10-07T00:00:00Z', '2026-10-06T00:00:00Z'),
        row('c', 'task_event', '2026-10-07T00:00:00Z', '2026-10-05T00:00:00Z'),
        row('b', 'task_list_event', '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z'),
        row('a', 'task_event', '2026-10-07T00:00:00Z', '2026-10-06T00:00:00Z'),
        row('f', 'task_daily', '2026-10-07T00:00:00Z', '2026-10-06T00:00:00Z'),
        row('e', 'task_reminder', '2026-10-07T00:00:00Z', '2026-10-06T00:00:00Z'),
        row('g', 'task_reminder', '2026-10-08T00:00:00Z', '2026-10-01T00:00:00Z'),
      ]
      expect(orderClaimedDeliveries(rows).map((r) => r.id)).toEqual(['e', 'f', 'g', 'b', 'c', 'a', 'd'])
    })

    it('a late reminder still precedes an earlier event row (priority before time)', () => {
      const rows = [
        row('ev', 'task_event', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
        row('rem', 'task_reminder', '2026-10-07T00:00:00Z', '2026-10-07T00:00:00Z'),
      ]
      expect(orderClaimedDeliveries(rows).map((r) => r.id)).toEqual(['rem', 'ev'])
    })

    it('returns a new array and leaves the input untouched; extra row fields survive', () => {
      const rows = [
        { ...row('b', 'task_event', '2026-10-07T00:00:00Z', '2026-10-06T00:00:00Z'), orgId: 'o' },
        { ...row('a', 'task_event', '2026-10-07T00:00:00Z', '2026-10-06T00:00:00Z'), orgId: 'o' },
      ]
      const snapshot = rows.map((r) => r.id)
      const out = orderClaimedDeliveries(rows)
      expect(out).not.toBe(rows)
      expect(rows.map((r) => r.id)).toEqual(snapshot)
      expect(out.map((r) => r.id)).toEqual(['a', 'b'])
      expect(out[0].orgId).toBe('o')
    })

    it('empty -> empty; rejects a non-array and a malformed row', () => {
      expect(orderClaimedDeliveries([])).toEqual([])
      expect(() => orderClaimedDeliveries('x' as never)).toThrow(TypeError)
      expect(() => orderClaimedDeliveries([{ id: 'a', sourceType: 'task_event', nextAttemptAt: '2026-10-07', createdAt: t('2026-10-07T00:00:00Z') } as never])).toThrow(TypeError)
      expect(() => orderClaimedDeliveries([{ id: 1, sourceType: 'task_event', nextAttemptAt: t('2026-10-07T00:00:00Z'), createdAt: t('2026-10-07T00:00:00Z') } as never])).toThrow(TypeError)
      expect(() => orderClaimedDeliveries(['x' as never])).toThrow(TypeError)
    })
  })

  describe('isTaskEventNotificationStale ([own-3b-14])', () => {
    const now = new Date('2026-10-07T12:00:00.000Z')
    const H = 60 * 60 * 1000

    it('25 h old -> stale; 23 h old -> fresh', () => {
      expect(isTaskEventNotificationStale(new Date(now.getTime() - 25 * H), now)).toBe(true)
      expect(isTaskEventNotificationStale(new Date(now.getTime() - 23 * H), now)).toBe(false)
    })

    it('boundary: exactly 24 h -> fresh; 24 h + 1 ms -> stale', () => {
      expect(isTaskEventNotificationStale(new Date(now.getTime() - TASK_EVENT_NOTIFICATION_MAX_AGE_MS), now)).toBe(false)
      expect(isTaskEventNotificationStale(new Date(now.getTime() - TASK_EVENT_NOTIFICATION_MAX_AGE_MS - 1), now)).toBe(true)
    })

    it('a row created in the future is not stale', () => {
      expect(isTaskEventNotificationStale(new Date(now.getTime() + H), now)).toBe(false)
    })

    it('rejects non-Dates and invalid Dates', () => {
      expect(() => isTaskEventNotificationStale('x' as never, now)).toThrow(TypeError)
      expect(() => isTaskEventNotificationStale(now, 'x' as never)).toThrow(TypeError)
      expect(() => isTaskEventNotificationStale(new Date(NaN), now)).toThrow(TypeError)
    })
  })

  describe('isAllowedTaskDingTalkBaseUrl ([own-3b-21])', () => {
    it('the base host constant', () => {
      expect(TASK_DINGTALK_BASE_HOST).toBe('oapi.dingtalk.com')
    })

    it('accepts https to oapi.dingtalk.com and to *.dingtalk.com (case-insensitive host, path / query / port allowed, trimmed)', () => {
      for (const url of [
        'https://oapi.dingtalk.com',
        'https://oapi.dingtalk.com/',
        'https://oapi.dingtalk.com/gateway?x=1#f',
        'https://OAPI.DingTalk.com',
        '  https://oapi.dingtalk.com  ',
        'https://api.dingtalk.com',
        'https://a.b.dingtalk.com',
        'https://oapi.dingtalk.com:8443',
      ]) {
        expect(isAllowedTaskDingTalkBaseUrl(url), url).toBe(true)
      }
    })

    it('refuses every other scheme, host shape, user-info, IP, and non-URL text', () => {
      for (const url of [
        'http://oapi.dingtalk.com',
        'ftp://oapi.dingtalk.com',
        'https://oapi.dingtalk.com.example',
        'https://oapi.dingtalk.com.',
        'https://oapidingtalk.com',
        'https://oapi-dingtalk.com',
        'https://dingtalk.com',
        'https://.dingtalk.com',
        'https://evil.example',
        'https://evil.example/oapi.dingtalk.com',
        'https://evil.example#oapi.dingtalk.com',
        'https://oapi.dingtalk.com@evil.example',
        'https://user@oapi.dingtalk.com',
        'https://user:pw@oapi.dingtalk.com',
        'https://127.0.0.1',
        'https://[::1]',
        'oapi.dingtalk.com',
        '//oapi.dingtalk.com',
        'x',
        '',
        ' ',
      ]) {
        expect(isAllowedTaskDingTalkBaseUrl(url), url).toBe(false)
      }
    })

    it('never throws: non-strings are refused', () => {
      for (const v of [undefined, null, 42, {}, [], new URL('https://oapi.dingtalk.com')]) {
        expect(isAllowedTaskDingTalkBaseUrl(v)).toBe(false)
      }
    })
  })

  describe('clamps', () => {
    it('clampDeliveryBatchSize: [1, 200], default 50 for non-finite, floors fractions', () => {
      expect(clampDeliveryBatchSize(undefined)).toBe(50)
      expect(clampDeliveryBatchSize(Number.NaN)).toBe(50)
      expect(clampDeliveryBatchSize('x' as never)).toBe(50)
      expect(clampDeliveryBatchSize(Number.POSITIVE_INFINITY)).toBe(50)
      expect(clampDeliveryBatchSize(0)).toBe(1)
      expect(clampDeliveryBatchSize(-5)).toBe(1)
      expect(clampDeliveryBatchSize(1)).toBe(1)
      expect(clampDeliveryBatchSize(7.9)).toBe(7)
      expect(clampDeliveryBatchSize(200)).toBe(200)
      expect(clampDeliveryBatchSize(201)).toBe(200)
      expect(clampDeliveryBatchSize(1000)).toBe(200)
    })

    it('clampDeliveryLeaseMs: [60 000, 600 000], default 60 000 for non-finite, floors fractions', () => {
      expect(clampDeliveryLeaseMs(undefined)).toBe(60_000)
      expect(clampDeliveryLeaseMs(Number.NaN)).toBe(60_000)
      expect(clampDeliveryLeaseMs('x' as never)).toBe(60_000)
      expect(clampDeliveryLeaseMs(1_000)).toBe(60_000)
      expect(clampDeliveryLeaseMs(59_999)).toBe(60_000)
      expect(clampDeliveryLeaseMs(60_000)).toBe(60_000)
      expect(clampDeliveryLeaseMs(90_000.7)).toBe(90_000)
      expect(clampDeliveryLeaseMs(600_000)).toBe(600_000)
      expect(clampDeliveryLeaseMs(600_001)).toBe(600_000)
    })

    it('every clamped lease satisfies the worker constructor assertion leaseMs > row reserve', () => {
      for (const v of [undefined, 0, 1, 30_000, 30_001, 60_000, 10 ** 9]) {
        expect(clampDeliveryLeaseMs(v)).toBeGreaterThan(TASK_DELIVERY_ROW_RESERVE_MS)
      }
    })
  })
})
