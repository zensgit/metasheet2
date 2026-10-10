/**
 * R-41 — the text a failed directory sync PERSISTS and SENDS OUT.
 *
 * markSyncFailure (directory-sync.ts) writes one text to `directory_sync_runs.error_message`,
 * `directory_integrations.last_error` and `directory_sync_alerts.message`, and hands the same text to the
 * DingTalk group-robot alert (directory-sync-alert-delivery.ts) — an OUTBOUND message. Before R-41 that text
 * was the caught error's message: DingTalk's errmsg, a socket error naming the peer, a driver sentence. Now it
 * is the classified text (directory-failure-text.ts) and the original goes to the server log only.
 *
 * Driven through the real `syncDirectoryIntegration` with pg and the DingTalk client mocked (the run-lease
 * harness shape), a stubbed global `fetch` capturing the alert POST, and the webhook env set — so the
 * outbound payload asserted is the one production builds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

const dingtalkMocks = vi.hoisted(() => ({
  fetchDingTalkAppAccessToken: vi.fn(),
  listDingTalkDepartments: vi.fn(),
  listDingTalkDepartmentUsers: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
  getDingTalkDepartmentDetail: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

vi.mock('../../src/integrations/dingtalk/client', () => ({
  fetchDingTalkAppAccessToken: dingtalkMocks.fetchDingTalkAppAccessToken,
  listDingTalkDepartments: dingtalkMocks.listDingTalkDepartments,
  listDingTalkDepartmentUsers: dingtalkMocks.listDingTalkDepartmentUsers,
  getDingTalkUserDetail: dingtalkMocks.getDingTalkUserDetail,
  getDingTalkDepartmentDetail: dingtalkMocks.getDingTalkDepartmentDetail,
}))

import { Logger } from '../../src/core/logger'
import { DirectoryValidationError, syncDirectoryIntegration } from '../../src/directory/directory-sync'
import {
  DingTalkBusinessError,
  DingTalkRequestError,
  DingTalkTimeoutError,
} from '../../src/integrations/dingtalk/transport'

const MARKER = 'MARKER_r41_sync'
const PROVIDER_TEXT = `${MARKER} invalid appkey from egress 203.0.113.21:443 request-id 7a7a`
const WEBHOOK = 'https://oapi.dingtalk.com/robot/send?access_token=alerttoken'
const RUN_ID = 'run-r41'

const INTEGRATION_ROW = {
  id: 'dir-1',
  org_id: 'default',
  provider: 'dingtalk',
  name: 'DingTalk CN',
  status: 'active',
  corp_id: 'dingcorp',
  config: { appKey: 'k', appSecret: 's' },
  sync_enabled: true,
  schedule_cron: null,
  default_deprovision_policy: 'mark_inactive',
  last_sync_at: null,
  last_success_at: null,
  last_error: null,
  created_at: '2026-07-08T00:00:00.000Z',
  updated_at: '2026-07-08T00:00:00.000Z',
}

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    integration_id: 'dir-1',
    status: 'running',
    started_at: '2026-07-09T00:00:00.000Z',
    finished_at: null,
    stats: {},
    error_message: null,
    triggered_by: 'admin-1',
    trigger_source: 'scheduler',
    created_at: '2026-07-09T00:00:00.000Z',
    updated_at: '2026-07-09T00:00:00.000Z',
    ...overrides,
  }
}

type LoggedCall = { text: string; params: unknown[] | undefined }

function installFailingRun(failure: unknown) {
  const bareCalls: LoggedCall[] = []
  const txCalls: LoggedCall[] = []
  pgMocks.query.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const text = String(sql)
    bareCalls.push({ text, params })
    if (text.includes('INSERT INTO directory_sync_runs')) return { rows: [runRow()] }
    if (text.includes('FROM directory_integrations')) return { rows: [INTEGRATION_ROW] }
    // countConsecutiveFailedRuns: this run is the first failure.
    if (text.includes('FROM directory_sync_runs')) return { rows: [{ status: 'failed' }] }
    return { rows: [] }
  })
  pgMocks.transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({
    query: async (sql: unknown, params?: unknown[]) => {
      txCalls.push({ text: String(sql), params })
      return { rows: [] }
    },
  }))
  dingtalkMocks.fetchDingTalkAppAccessToken.mockResolvedValue('token')
  dingtalkMocks.listDingTalkDepartments.mockRejectedValue(failure)
  return { bareCalls, txCalls }
}

/** The three persisted texts and the outbound alert body, in one place. */
function persisted(calls: { bareCalls: LoggedCall[]; txCalls: LoggedCall[] }) {
  const runWrite = calls.txCalls.find((c) => c.text.includes('UPDATE directory_sync_runs') && c.text.includes('error_message = $2'))
  const integrationWrite = calls.txCalls.find((c) => c.text.includes('UPDATE directory_integrations') && c.text.includes('last_error = $2'))
  const alertInsert = calls.bareCalls.find((c) => c.text.includes('INSERT INTO directory_sync_alerts'))
  return {
    errorMessage: runWrite?.params?.[1],
    lastError: integrationWrite?.params?.[1],
    alertMessage: alertInsert?.params?.[2],
  }
}

let fetchMock: ReturnType<typeof vi.fn>
let warnSpy: ReturnType<typeof vi.spyOn>

function outboundBodies(): string[] {
  return fetchMock.mock.calls.map((call) => String((call[1] as RequestInit | undefined)?.body ?? ''))
}
function loggedTexts(): string {
  const out: string[] = []
  const walk = (value: unknown) => {
    if (typeof value === 'string') out.push(value)
    else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v)
  }
  walk(warnSpy.mock.calls)
  return out.join('\n')
}

beforeEach(() => {
  pgMocks.query.mockReset()
  pgMocks.transaction.mockReset()
  for (const fn of Object.values(dingtalkMocks)) fn.mockReset()
  vi.stubEnv('DIRECTORY_SYNC_ALERT_WEBHOOK', WEBHOOK)
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  warnSpy.mockRestore()
})

describe('R-41: a failed sync persists and sends the classified text, never the caught text', () => {
  it('a DingTalk rejection: all three columns and the outbound alert carry the fixed sentence + errcode only', async () => {
    const calls = installFailingRun(new DingTalkBusinessError(PROVIDER_TEXT, { errcode: 40089, errmsg: PROVIDER_TEXT }))

    await expect(syncDirectoryIntegration('dir-1', 'admin-1', 'scheduler')).rejects.toBeInstanceOf(DingTalkBusinessError)

    const expected = 'Directory sync failed: DingTalk rejected the request (errcode 40089)'
    expect(persisted(calls)).toEqual({ errorMessage: expected, lastError: expected, alertMessage: expected })

    // The OUTBOUND alert: exactly one POST to the group robot, carrying the classified text and no marker.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [body] = outboundBodies()
    expect(body).toContain('原因：Directory sync failed: DingTalk rejected the request (errcode 40089)')
    expect(body).not.toContain(MARKER)
    expect(body).not.toContain('203.0.113')

    // The original text moved to the server log (once, from markSyncFailure); it did not vanish.
    expect(loggedTexts()).toContain(PROVIDER_TEXT)
  })

  it('a driver / unknown error: the fixed sentence alone, everywhere', async () => {
    const driverError = Object.assign(new Error(`${MARKER} relation "directory_accounts" does not exist`), {
      code: '42P01',
      detail: PROVIDER_TEXT,
    })
    const calls = installFailingRun(driverError)

    await expect(syncDirectoryIntegration('dir-1', 'admin-1', 'scheduler')).rejects.toBe(driverError)

    expect(persisted(calls)).toEqual({
      errorMessage: 'Directory sync failed',
      lastError: 'Directory sync failed',
      alertMessage: 'Directory sync failed',
    })
    const [body] = outboundBodies()
    expect(body).toContain('原因：Directory sync failed')
    expect(body).not.toContain(MARKER)
    expect(loggedTexts()).toContain(`${MARKER} relation "directory_accounts" does not exist`)
  })

  it('an HTTP-level DingTalk failure and a timeout: the status / the fixed timeout sentence', async () => {
    const httpCalls = installFailingRun(new DingTalkRequestError(PROVIDER_TEXT, 502, { message: PROVIDER_TEXT }))
    await expect(syncDirectoryIntegration('dir-1', 'admin-1', 'scheduler')).rejects.toBeInstanceOf(DingTalkRequestError)
    expect(persisted(httpCalls).errorMessage).toBe('Directory sync failed: DingTalk answered with an error status (HTTP 502)')

    fetchMock.mockClear()
    const timeoutCalls = installFailingRun(new DingTalkTimeoutError(10_000))
    await expect(syncDirectoryIntegration('dir-1', 'admin-1', 'scheduler')).rejects.toBeInstanceOf(DingTalkTimeoutError)
    expect(persisted(timeoutCalls).lastError).toBe('Directory sync failed: DingTalk did not answer in time')
    for (const body of outboundBodies()) expect(body).not.toContain(MARKER)
  })

  it('a typed directory sentence is persisted as it is (developer-authored, R-41 rule 3)', async () => {
    const calls = installFailingRun(new DirectoryValidationError('rootDepartmentId is required'))
    await expect(syncDirectoryIntegration('dir-1', 'admin-1', 'scheduler')).rejects.toBeInstanceOf(DirectoryValidationError)
    expect(persisted(calls)).toEqual({
      errorMessage: 'rootDepartmentId is required',
      lastError: 'rootDepartmentId is required',
      alertMessage: 'rootDepartmentId is required',
    })
    // A sentence is an answer, not an incident: markSyncFailure does not log the fallback line for it.
    expect(warnSpy).not.toHaveBeenCalledWith('Directory sync failed', expect.anything())
  })
})
