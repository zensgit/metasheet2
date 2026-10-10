/**
 * R-41 end to end — the DingTalk config and directory-test routes with their REAL services, the REAL DingTalk
 * client and transport, and a stubbed global `fetch` standing in for DingTalk. Only pg and the audit sink are
 * mocked. What it pins, that the mocked-service probes in admin-directory-5xx-values-free.test.ts cannot:
 *   - the developer-authored validation throws in work-notification-settings.ts / approval-card-config.ts /
 *     directory-sync.ts are really TYPED, so their sentence still reaches the admin (an untyped throw would
 *     now be reduced to the route's fixed sentence);
 *   - a DingTalk rejection coming out of the real transport reaches the body as the route's fixed sentence
 *     plus the errcode only — DingTalk's errmsg (here carrying a marker address) never does;
 *   - client.ts's "2xx without the expected field" throw is TYPED (DingTalkIncompleteResponseError) with the
 *     envelope's errcode, and keeps its old message for the logs;
 *   - a raw network failure (a socket error naming the peer) and a driver failure answer the fixed sentence.
 */
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
  pool: { query: pgMocks.query },
}))
vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn(async () => undefined) }))

import { Logger } from '../../src/core/logger'
import {
  __resetDingTalkAppAccessTokenCacheForTests,
  DingTalkBusinessError,
  DingTalkIncompleteResponseError,
  exchangeCodeForUserAccessToken,
  fetchDingTalkAppAccessToken,
  fetchDingTalkCurrentUser,
} from '../../src/integrations/dingtalk/client'
import { DingTalkConfigValidationError } from '../../src/integrations/dingtalk/config-validation-error'
import { normalizeDingTalkWorkNotificationAgentId } from '../../src/integrations/dingtalk/work-notification-settings'
import { saveApprovalCardPublicAppUrl } from '../../src/integrations/dingtalk/approval-card-config'
import { classifyDirectoryFailureText } from '../../src/directory/directory-failure-text'
import { adminDirectoryRouter } from '../../src/routes/admin-directory'

const MARKER = 'MARKER_r41_e2e'
const PROVIDER_TEXT = `${MARKER} invalid appkey, egress 203.0.113.31:443 not in allowlist`
const INTEGRATION_ID = 'd1000000-0000-4000-8000-000000000001'
const STORED_ROW = {
  id: INTEGRATION_ID,
  name: 'DingTalk CN',
  status: 'active',
  config: { appKey: 'app-key-test', appSecret: 'app-secret-test', workNotificationAgentId: '123456' },
  updated_at: '2026-10-10T00:00:00.000Z',
}

let storedRow: Record<string, unknown> | null = STORED_ROW
let failWrites: Error | null = null
let fetchMock: ReturnType<typeof vi.fn>
let warnSpy: ReturnType<typeof vi.spyOn>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

type RouteLayer = {
  route?: {
    path: string
    methods: Record<string, boolean>
    stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }>
  }
}

async function invoke(
  method: 'post' | 'put',
  path: string,
  options: { params?: Record<string, string>; body?: Record<string, unknown> } = {},
): Promise<{ statusCode: number; body: unknown; headers: Record<string, string> }> {
  const router = adminDirectoryRouter() as unknown as { stack: RouteLayer[] }
  const layer = router.stack.find((entry) => entry.route?.path === path && entry.route?.methods?.[method])
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${path} not found`)
  const headers: Record<string, string> = {}
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers,
    headersSent: false,
    status(code: number) { this.statusCode = code; return this },
    json(payload: unknown) { this.body = payload; this.headersSent = true; return this },
    send(payload: unknown) { this.body = payload; this.headersSent = true; return this },
    setHeader(name: string, value: unknown) { headers[name.toLowerCase()] = String(value); return this },
    set(name: string, value: unknown) { headers[name.toLowerCase()] = String(value); return this },
    getHeader(name: string) { return headers[name.toLowerCase()] },
  }
  const req = {
    method: method.toUpperCase(),
    url: path,
    headers: {},
    params: options.params ?? {},
    query: {},
    body: options.body ?? {},
    // The legacy admin claim short-circuits ensurePlatformAdmin's RBAC read.
    user: { id: 'admin-1', role: 'admin' },
  } as unknown as Request
  let forwarded: unknown
  await layer.route.stack[layer.route.stack.length - 1].handle(req, res as unknown as Response, (err?: unknown) => {
    forwarded = err
  })
  if (forwarded) throw forwarded
  return res
}

function expectValuesFree(res: { body: unknown; headers: Record<string, string> }): void {
  const serialized = JSON.stringify(res.body) + JSON.stringify(res.headers)
  expect(serialized).not.toContain(MARKER)
  expect(serialized).not.toContain('203.0.113')
}

beforeEach(() => {
  storedRow = STORED_ROW
  failWrites = null
  pgMocks.query.mockReset()
  pgMocks.query.mockImplementation(async (sql: unknown) => {
    const text = String(sql)
    if (/^\s*UPDATE directory_integrations/.test(text)) {
      if (failWrites) throw failWrites
      return { rows: storedRow ? [storedRow] : [] }
    }
    if (text.includes('FROM directory_integrations')) return { rows: storedRow ? [storedRow] : [] }
    return { rows: [] }
  })
  __resetDingTalkAppAccessTokenCacheForTests()
  // Env-first resolution must not leak a developer machine's DingTalk env into these probes.
  for (const key of ['DINGTALK_APP_KEY', 'DINGTALK_CLIENT_ID', 'DINGTALK_APP_SECRET', 'DINGTALK_CLIENT_SECRET', 'DINGTALK_BASE_URL', 'DINGTALK_ALLOWED_CORP_IDS']) {
    vi.stubEnv(key, '')
  }
  // One attempt: a read-tier network error would otherwise back off and retry.
  vi.stubEnv('DINGTALK_TRANSPORT_MAX_ATTEMPTS', '1')
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  warnSpy.mockRestore()
})

describe('R-41 — typed validation sentences survive through the real services', () => {
  it('work-notification test: a malformed Agent ID → 400 with the Agent ID sentence (DingTalkConfigValidationError)', async () => {
    const res = await invoke('post', '/dingtalk/work-notification/test', { body: { integrationId: INTEGRATION_ID, agentId: 'agent-x' } })
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'DINGTALK_WORK_NOTIFICATION_TEST_FAILED', message: 'DingTalk Agent ID must be 1-32 numeric characters', details: undefined },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('work-notification save: a missing integration → 400 with its sentence', async () => {
    storedRow = null
    const res = await invoke('put', '/dingtalk/work-notification', { body: { integrationId: INTEGRATION_ID, agentId: '123456' } })
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'DINGTALK_WORK_NOTIFICATION_SAVE_FAILED', message: 'DingTalk directory integration not found', details: undefined },
    })
  })

  it('approval-card config save: a non-http(s) URL → 400 with the scheme sentence', async () => {
    const res = await invoke('put', '/integrations/:integrationId/approval-card-config', {
      params: { integrationId: INTEGRATION_ID },
      body: { publicAppUrl: 'ftp://files.example.com/' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'APPROVAL_CARD_CONFIG_SAVE_FAILED', message: 'publicAppUrl must use http or https', details: undefined },
    })
  })

  it('directory test: a missing appSecret → 400 with the DirectoryValidationError sentence', async () => {
    const res = await invoke('post', '/integrations/test', { body: { name: 'DingTalk CN', corpId: 'dingcorp', appKey: 'k' } })
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ ok: false, error: { code: 'DIRECTORY_TEST_FAILED', message: 'appSecret is required', details: undefined } })
  })

  it('the throws themselves are typed (message unchanged)', async () => {
    expect(() => normalizeDingTalkWorkNotificationAgentId('agent-x')).toThrow(DingTalkConfigValidationError)
    await expect(saveApprovalCardPublicAppUrl(INTEGRATION_ID, 'not a url')).rejects.toBeInstanceOf(DingTalkConfigValidationError)
    await expect(saveApprovalCardPublicAppUrl(INTEGRATION_ID, 'not a url')).rejects.toThrow('publicAppUrl must be an absolute http(s) URL')
  })
})

describe('R-41 — provider, transport and driver failures reach the body as a fixed sentence (+ DingTalk\'s code)', () => {
  it('work-notification test: DingTalk rejects gettoken → the fixed sentence + errcode, never errmsg', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errcode: 40089, errmsg: PROVIDER_TEXT }))
    const res = await invoke('post', '/dingtalk/work-notification/test', { body: { integrationId: INTEGRATION_ID, agentId: '123456' } })
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'DINGTALK_WORK_NOTIFICATION_TEST_FAILED',
        message: 'Failed to test DingTalk work notification Agent ID: DingTalk rejected the request (errcode 40089)',
        details: undefined,
      },
    })
    expectValuesFree(res)
  })

  it('directory test: DingTalk rejects gettoken → the fixed sentence + errcode', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errcode: 40089, errmsg: PROVIDER_TEXT }))
    const res = await invoke('post', '/integrations/test', { body: { name: 'DingTalk CN', corpId: 'dingcorp', appKey: 'k', appSecret: 's' } })
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'DIRECTORY_TEST_FAILED', message: 'Failed to test directory integration: DingTalk rejected the request (errcode 40089)', details: undefined },
    })
    expectValuesFree(res)
  })

  it('directory test: gettoken answers 2xx without a token → the incomplete-response sentence + errcode 0', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errcode: 0, errmsg: 'ok', message: PROVIDER_TEXT }))
    const res = await invoke('post', '/integrations/test', { body: { name: 'DingTalk CN', corpId: 'dingcorp', appKey: 'k', appSecret: 's' } })
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'DIRECTORY_TEST_FAILED',
        message: 'Failed to test directory integration: DingTalk returned a response without the expected data (errcode 0)',
        details: undefined,
      },
    })
    expectValuesFree(res)
  })

  it('work-notification test: a socket error naming the peer → the fixed sentence, the text logged', async () => {
    const socketError = Object.assign(new TypeError(`fetch failed ${MARKER}`), {
      cause: Object.assign(new Error('connect ECONNREFUSED 203.0.113.32:443'), { code: 'ECONNREFUSED' }),
    })
    fetchMock.mockRejectedValue(socketError)
    const res = await invoke('post', '/dingtalk/work-notification/test', { body: { integrationId: INTEGRATION_ID, agentId: '123456' } })
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'DINGTALK_WORK_NOTIFICATION_TEST_FAILED', message: 'Failed to test DingTalk work notification Agent ID', details: undefined },
    })
    expectValuesFree(res)
    expect(JSON.stringify(warnSpy.mock.calls)).toContain(MARKER)
  })

  it('approval-card config save / secret generate: a driver failure on the write → the fixed sentence', async () => {
    failWrites = Object.assign(new Error(`${MARKER} could not write block 7 of relation directory_integrations at 203.0.113.33`), { code: '58030' })
    const save = await invoke('put', '/integrations/:integrationId/approval-card-config', {
      params: { integrationId: INTEGRATION_ID },
      body: { publicAppUrl: 'https://app.example.com/' },
    })
    expect(save.statusCode).toBe(400)
    expect(save.body).toEqual({ ok: false, error: { code: 'APPROVAL_CARD_CONFIG_SAVE_FAILED', message: 'Failed to save approval card config', details: undefined } })
    expectValuesFree(save)
    expect(JSON.stringify(warnSpy.mock.calls)).toContain(MARKER)

    warnSpy.mockClear()
    const generate = await invoke('post', '/integrations/:integrationId/approval-card-config/secret/generate', { params: { integrationId: INTEGRATION_ID } })
    expect(generate.statusCode).toBe(400)
    expect(generate.body).toEqual({
      ok: false,
      error: { code: 'APPROVAL_CARD_SECRET_GENERATE_FAILED', message: 'Failed to generate approval card link secret', details: undefined },
    })
    expectValuesFree(generate)
    // The write itself failed (not something earlier): its driver text is what reached the log.
    expect(JSON.stringify(warnSpy.mock.calls)).toContain(MARKER)
  })
})

describe('R-41 follow-up — production refusing to encrypt / decrypt shows its own values-free sentence (400, as before)', () => {
  const MATERIAL_SENTENCE =
    'Invalid encryption material for production: ENCRYPTION_KEY not configured / not set; ENCRYPTION_SALT not configured / not set'

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ENCRYPTION_KEY', '')
    vi.stubEnv('ENCRYPTION_SALT', '')
  })

  it('work-notification save: the Agent ID cannot be encrypted → 400 with the EncryptionMaterialError sentence', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errcode: 0, access_token: 'token-test', expires_in: 7200 }))
    const res = await invoke('put', '/dingtalk/work-notification', { body: { integrationId: INTEGRATION_ID, agentId: '123456' } })
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ ok: false, error: { code: 'DINGTALK_WORK_NOTIFICATION_SAVE_FAILED', message: MATERIAL_SENTENCE, details: undefined } })
  })

  it('approval-card secret generate: the secret cannot be encrypted → 400 with the sentence', async () => {
    const res = await invoke('post', '/integrations/:integrationId/approval-card-config/secret/generate', { params: { integrationId: INTEGRATION_ID } })
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ ok: false, error: { code: 'APPROVAL_CARD_SECRET_GENERATE_FAILED', message: MATERIAL_SENTENCE, details: undefined } })
  })

  it('directory test: the stored appSecret cannot be decrypted → 400 with the sentence', async () => {
    storedRow = { ...STORED_ROW, provider: 'dingtalk', corp_id: 'dingcorp', config: { appKey: 'app-key-test', appSecret: 'enc:not-decryptable-without-material' } }
    const res = await invoke('post', '/integrations/test', { body: { integrationId: INTEGRATION_ID, name: 'DingTalk CN', corpId: 'dingcorp', appKey: 'k' } })
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ ok: false, error: { code: 'DIRECTORY_TEST_FAILED', message: MATERIAL_SENTENCE, details: undefined } })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('R-41 — client.ts: a 2xx without the expected field is a typed DingTalkIncompleteResponseError', () => {
  it('gettoken without access_token: typed, errcode kept, message unchanged, not a business rejection', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errcode: 0, errmsg: 'ok', message: PROVIDER_TEXT }))
    const error = await fetchDingTalkAppAccessToken({ appKey: 'k-incomplete', appSecret: 's' }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DingTalkIncompleteResponseError)
    // NOT a DingTalkBusinessError: callers that key retry / ledger decisions on that type keep treating this
    // exactly as they treated the plain Error it replaces.
    expect(error).not.toBeInstanceOf(DingTalkBusinessError)
    expect((error as Error).message).toBe(PROVIDER_TEXT)
    expect((error as DingTalkIncompleteResponseError).responseBody).toMatchObject({ errcode: 0 })
    expect(classifyDirectoryFailureText(error, { fallback: 'Directory sync failed' }).text)
      .toBe('Directory sync failed: DingTalk returned a response without the expected data (errcode 0)')
  })

  it('gettoken without access_token and without a message: the old fallback message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errcode: 0, errmsg: 'ok' }))
    await expect(fetchDingTalkAppAccessToken({ appKey: 'k-incomplete-2', appSecret: 's' }))
      .rejects.toThrow('Failed to obtain DingTalk app access token')
  })

  it('the v1.0 userAccessToken exchange and users/me: typed, message unchanged', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: PROVIDER_TEXT }))
    const exchange = await exchangeCodeForUserAccessToken('code-1', {
      clientId: 'client-test',
      clientSecret: 'secret-test',
      redirectUri: 'https://app.example.com/callback',
      corpId: null,
    }).catch((caught: unknown) => caught)
    expect(exchange).toBeInstanceOf(DingTalkIncompleteResponseError)
    expect((exchange as Error).message).toBe(PROVIDER_TEXT)

    fetchMock.mockResolvedValueOnce(jsonResponse({ nick: 'someone' }))
    const me = await fetchDingTalkCurrentUser('user-token').catch((caught: unknown) => caught)
    expect(me).toBeInstanceOf(DingTalkIncompleteResponseError)
    expect((me as Error).message).toBe('Failed to resolve DingTalk openId')
  })
})
