import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildDirectoryInactiveLinkedAlertMessage,
  buildDirectorySyncAlertMessage,
  countConsecutiveFailedRuns,
  deliverDirectoryInactiveLinkedAlert,
  deliverDirectorySyncFailureAlert,
  getDirectoryManagerBindingCoverage,
  readDirectoryInactiveLinkedAlertThresholdDays,
  readDirectorySyncAlertWebhookConfig,
  type DirectoryInactiveLinkedMetric,
} from '../../src/directory/directory-sync-alert-delivery'

/**
 * DT-OPS-03 — approval-routing health. ApprovalDirectoryOrg can only resolve a manager
 * that is LINKED to a local user, so the share of bound managers is a direct upper bound
 * on approval-routing success — and it is invisible today.
 */
describe('DT-OPS-03 manager binding coverage', () => {
  const coverageQuery = (managerCount: number, linkedManagerCount: number) =>
    (async () => ({ rows: [{ manager_count: managerCount, linked_manager_count: linkedManagerCount }] })) as never

  it('reports the bound share of managers', async () => {
    await expect(getDirectoryManagerBindingCoverage('dir-1', coverageQuery(4, 3)))
      .resolves.toEqual({ managerCount: 4, linkedManagerCount: 3, coverage: 0.75 })
  })

  it('reports zero coverage when no manager is bound — every chain would dead-end', async () => {
    await expect(getDirectoryManagerBindingCoverage('dir-1', coverageQuery(4, 0)))
      .resolves.toMatchObject({ coverage: 0 })
  })

  it('treats "no managers at all" as full coverage rather than dividing by zero', async () => {
    await expect(getDirectoryManagerBindingCoverage('dir-1', coverageQuery(0, 0)))
      .resolves.toEqual({ managerCount: 0, linkedManagerCount: 0, coverage: 1 })
  })
})

const WEBHOOK = 'https://oapi.dingtalk.com/robot/send?access_token=alerttoken'

function okResponse(body: unknown = { errcode: 0, errmsg: 'ok' }) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/**
 * DT-OPS-03 — `directory_sync_alerts.sent_to_webhook` has existed since the table was
 * created and nothing ever sent anything. A nightly sync that fails because the app secret
 * rotated just accumulates rows in a table nobody opens.
 */
describe('DT-OPS-03 directory sync alert delivery', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('channel registration', () => {
    it('does not exist unless the webhook env is configured', () => {
      expect(readDirectorySyncAlertWebhookConfig()).toBeNull()
    })

    it('rejects a non-DingTalk webhook rather than exfiltrating alerts to it (SSRF pinning)', () => {
      vi.stubEnv('DIRECTORY_SYNC_ALERT_WEBHOOK', 'https://evil.example.com/collect')
      expect(readDirectorySyncAlertWebhookConfig()).toBeNull()
    })

    it('accepts a pinned DingTalk robot URL', () => {
      vi.stubEnv('DIRECTORY_SYNC_ALERT_WEBHOOK', WEBHOOK)
      expect(readDirectorySyncAlertWebhookConfig()).toMatchObject({ webhookUrl: WEBHOOK })
    })
  })

  describe('consecutive failure streak', () => {
    const runs = (...statuses: string[]) => (async () => ({ rows: statuses.map((status) => ({ status })) })) as never

    it('counts only the leading run of failures', async () => {
      await expect(countConsecutiveFailedRuns('dir-1', runs('failed', 'failed', 'completed', 'failed'))).resolves.toBe(2)
    })

    it('is zero when the latest run succeeded', async () => {
      await expect(countConsecutiveFailedRuns('dir-1', runs('completed', 'failed'))).resolves.toBe(0)
    })
  })

  it('escalates the subject once the failure repeats', () => {
    const single = buildDirectorySyncAlertMessage({ integrationName: 'CN', runId: 'r1', message: 'boom', consecutiveFailures: 1 })
    const repeated = buildDirectorySyncAlertMessage({ integrationName: 'CN', runId: 'r1', message: 'boom', consecutiveFailures: 3 })
    expect(single.subject).not.toMatch(/连续/)
    expect(repeated.subject).toMatch(/连续失败 3 次/)
    expect(repeated.content).toContain('boom')
    expect(repeated.content).toContain('r1')
  })

  describe('delivery', () => {
    it('sends nothing and reports false when no channel is configured', async () => {
      const fetchFn = vi.fn() as unknown as typeof fetch
      const delivered = await deliverDirectorySyncFailureAlert(
        { integrationId: 'dir-1', integrationName: 'CN', runId: 'r1', message: 'boom' },
        { config: null, fetchFn },
      )
      expect(delivered).toBe(false)
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('signs the webhook, posts markdown, and flips sent_to_webhook', async () => {
      const fetchFn = vi.fn(async () => okResponse()) as unknown as typeof fetch
      const queryFn = vi.fn(async () => ({ rows: [{ status: 'failed' }] })) as never

      const delivered = await deliverDirectorySyncFailureAlert(
        { integrationId: 'dir-1', integrationName: 'CN', runId: 'r1', message: 'app secret rotated' },
        { config: { webhookUrl: WEBHOOK, secret: 'SECabc123' }, fetchFn, queryFn },
      )

      expect(delivered).toBe(true)
      const [url, init] = (fetchFn as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
      expect(url).toContain('sign=')
      expect(url).toContain('timestamp=')
      expect(init.signal).toBeTruthy()
      const payload = JSON.parse(init.body as string)
      expect(payload.msgtype).toBe('markdown')
      expect(payload.markdown.text).toContain('app secret rotated')

      const updates = (queryFn as unknown as { mock: { calls: Array<[string]> } }).mock.calls
        .filter(([sql]) => /UPDATE directory_sync_alerts/.test(sql))
      expect(updates).toHaveLength(1)
    })

    it('NEVER lets a webhook failure escape — a failed sync must not be made worse', async () => {
      const fetchFn = vi.fn(async () => {
        throw new Error('webhook unreachable')
      }) as unknown as typeof fetch
      const queryFn = vi.fn(async () => ({ rows: [] })) as never

      // The load-bearing property: resolves false, does not throw.
      await expect(deliverDirectorySyncFailureAlert(
        { integrationId: 'dir-1', integrationName: 'CN', runId: 'r1', message: 'boom' },
        { config: { webhookUrl: WEBHOOK }, fetchFn, queryFn },
      )).resolves.toBe(false)
    })

    it('treats a DingTalk business error as undelivered rather than marking it sent', async () => {
      const fetchFn = vi.fn(async () => okResponse({ errcode: 130101, errmsg: 'flow control' })) as unknown as typeof fetch
      const queryFn = vi.fn(async () => ({ rows: [{ status: 'failed' }] })) as never

      await expect(deliverDirectorySyncFailureAlert(
        { integrationId: 'dir-1', integrationName: 'CN', runId: 'r1', message: 'boom' },
        { config: { webhookUrl: WEBHOOK }, fetchFn, queryFn },
      )).resolves.toBe(false)

      const updates = (queryFn as unknown as { mock: { calls: Array<[string]> } }).mock.calls
        .filter(([sql]) => /UPDATE directory_sync_alerts/.test(sql))
      expect(updates).toHaveLength(0)
    })
  })
})

/**
 * roadmap §7.1 — offboarding blind-spot digest. `getDirectoryInactiveLinkedMetric`'s real
 * SQL (the age comparison, the linked-join, the local-user-active filter) is proven against
 * real Postgres in `tests/integration/directory-sync-alert-coverage.db.test.ts`. This suite
 * proves the WIRING around it: the two independent env gates and the message/delivery shape,
 * using a fake queryFn that ignores the SQL text — exactly the same division of labor the
 * manager-coverage tests above use.
 */
describe('§7.1 directory inactive-linked backlog digest', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('threshold env gate', () => {
    it('is off when the threshold env is unset', () => {
      expect(readDirectoryInactiveLinkedAlertThresholdDays()).toBeNull()
    })

    it('rejects a non-positive or non-integer threshold rather than silently clamping it', () => {
      for (const bad of ['0', '-3', '2.5', 'abc']) {
        vi.stubEnv('DIRECTORY_INACTIVE_LINKED_ALERT_DAYS', bad)
        expect(readDirectoryInactiveLinkedAlertThresholdDays()).toBeNull()
      }
    })

    it('accepts a positive integer threshold', () => {
      vi.stubEnv('DIRECTORY_INACTIVE_LINKED_ALERT_DAYS', '45')
      expect(readDirectoryInactiveLinkedAlertThresholdDays()).toBe(45)
    })
  })

  describe('buildDirectoryInactiveLinkedAlertMessage', () => {
    it('reports the threshold and count, caps the example list at 5, and notes the remainder', () => {
      const metric: DirectoryInactiveLinkedMetric = {
        thresholdDays: 30,
        count: 7,
        sample: Array.from({ length: 6 }, (_, i) => ({
          directoryAccountId: `acc-${i}`,
          externalUserId: `ext-${i}`,
          accountName: `Account ${i}`,
          localUserId: `user-${i}`,
          localUserEmail: `user${i}@example.com`,
          localUserName: `User ${i}`,
          inactiveSinceAt: '2026-01-01T00:00:00.000Z',
          inactiveDays: 40 + i,
        })),
      }
      const { subject, content } = buildDirectoryInactiveLinkedAlertMessage({ integrationName: 'CN', metric })
      expect(subject).toContain('30')
      expect(content).toContain('数量：7')
      expect((content.match(/Account \d/g) ?? []).length).toBe(5)
      expect(content).toContain('以及其他 2 个账号')
    })
  })

  describe('deliverDirectoryInactiveLinkedAlert', () => {
    // Discriminates by SQL shape rather than args, mirroring the getDirectoryManagerBindingCoverage
    // unit fakes above — it proves the WIRING (does a nonzero backlog reach the webhook), not the
    // predicate; the predicate itself is proven against real Postgres in the .db.test.ts.
    const metricQueryFn = (total: number) => (async (sql: string) => (
      /COUNT\(\*\)/.test(sql) ? { rows: [{ total }] } : { rows: [] }
    )) as unknown as typeof import('../../src/db/pg').query

    it('sends nothing when the threshold env is unset — the SOLE gate on this alert', async () => {
      // No `deps.thresholdDays` override: falls through to the REAL env reader, which is
      // unset here. The fake queryFn would report a backlog of 3 if the guard let it
      // through — proving the guard, not the query, is what stops delivery. Deleting the
      // `if (!thresholdDays) return false` line in the source makes this test go RED.
      const fetchFn = vi.fn() as unknown as typeof fetch
      const queryFn = vi.fn(metricQueryFn(3))
      const delivered = await deliverDirectoryInactiveLinkedAlert(
        { integrationId: 'dir-1', integrationName: 'CN' },
        { config: { webhookUrl: WEBHOOK }, fetchFn, queryFn: queryFn as never },
      )
      expect(delivered).toBe(false)
      expect(fetchFn).not.toHaveBeenCalled()
      expect(queryFn).not.toHaveBeenCalled()
    })

    it('sends nothing when the webhook channel is not configured, even with a threshold set', async () => {
      const fetchFn = vi.fn() as unknown as typeof fetch
      const queryFn = vi.fn(metricQueryFn(3))
      const delivered = await deliverDirectoryInactiveLinkedAlert(
        { integrationId: 'dir-1', integrationName: 'CN' },
        { thresholdDays: 30, config: null, fetchFn, queryFn: queryFn as never },
      )
      expect(delivered).toBe(false)
      expect(fetchFn).not.toHaveBeenCalled()
      expect(queryFn).not.toHaveBeenCalled()
    })

    it('sends nothing when the backlog is empty — this is a digest, not per-tick noise', async () => {
      const fetchFn = vi.fn(async () => okResponse()) as unknown as typeof fetch
      const queryFn = metricQueryFn(0)
      const delivered = await deliverDirectoryInactiveLinkedAlert(
        { integrationId: 'dir-1', integrationName: 'CN' },
        { thresholdDays: 30, config: { webhookUrl: WEBHOOK }, fetchFn, queryFn: queryFn as never },
      )
      expect(delivered).toBe(false)
      expect(fetchFn).not.toHaveBeenCalled()
    })

    it('signs and posts a markdown digest when both gates are open and the backlog is nonzero', async () => {
      const fetchFn = vi.fn(async () => okResponse()) as unknown as typeof fetch
      const queryFn = metricQueryFn(4)
      const delivered = await deliverDirectoryInactiveLinkedAlert(
        { integrationId: 'dir-1', integrationName: 'CN' },
        { thresholdDays: 30, config: { webhookUrl: WEBHOOK, secret: 'SECabc123' }, fetchFn, queryFn: queryFn as never },
      )
      expect(delivered).toBe(true)
      const [url, init] = (fetchFn as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0]
      expect(url).toContain('sign=')
      expect(url).toContain('timestamp=')
      const payload = JSON.parse(init.body as string)
      expect(payload.msgtype).toBe('markdown')
      expect(payload.markdown.text).toContain('数量：4')
    })

    it('NEVER lets a webhook failure escape — a healthy sync must not look broken', async () => {
      const fetchFn = vi.fn(async () => {
        throw new Error('webhook unreachable')
      }) as unknown as typeof fetch
      const queryFn = metricQueryFn(1)
      await expect(deliverDirectoryInactiveLinkedAlert(
        { integrationId: 'dir-1', integrationName: 'CN' },
        { thresholdDays: 30, config: { webhookUrl: WEBHOOK }, fetchFn, queryFn: queryFn as never },
      )).resolves.toBe(false)
    })

    it('treats a DingTalk business error as undelivered', async () => {
      const fetchFn = vi.fn(async () => okResponse({ errcode: 130101, errmsg: 'flow control' })) as unknown as typeof fetch
      const queryFn = metricQueryFn(2)
      await expect(deliverDirectoryInactiveLinkedAlert(
        { integrationId: 'dir-1', integrationName: 'CN' },
        { thresholdDays: 30, config: { webhookUrl: WEBHOOK }, fetchFn, queryFn: queryFn as never },
      )).resolves.toBe(false)
    })
  })
})
