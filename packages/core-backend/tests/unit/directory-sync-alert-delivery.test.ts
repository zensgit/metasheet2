import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildDirectorySyncAlertMessage,
  countConsecutiveFailedRuns,
  deliverDirectorySyncFailureAlert,
  getDirectoryManagerBindingCoverage,
  readDirectorySyncAlertWebhookConfig,
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
