import { sendDingTalkWorkNotification, createDingTalkTodoTask, exchangeCodeForUserAccessToken } from '../../src/integrations/dingtalk/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncDirectoryIntegration, previewDirectorySyncIntegration } from '../../src/directory/directory-sync'
import { assertDirectoryConnectionEnabled, disableDirectoryConnection, previewDirectoryConnectionDisable, withDingTalkConnectionOperation } from '../../src/directory/connection-disable'

import { readDingTalkMessageConfigFromRuntime } from '../../src/integrations/dingtalk/work-notification-settings'
import { isDingTalkOutcomeUnknown } from '../../src/integrations/dingtalk/transport'

const { q, tx } = vi.hoisted(() => ({ q: vi.fn(), tx: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ query: q, transaction: tx }))
const id = '00000000-0000-4000-8000-000000000001'
const peer = '00000000-0000-4000-8000-000000000002'
let stopped = false
let rows = [{ id, app_key: 'synthetic-app', disabled: false }]
let shared = false
beforeEach(() => {
  q.mockReset(); tx.mockReset(); stopped = false; shared = false
  rows = [{ id, app_key: 'synthetic-app', disabled: false }]
  tx.mockImplementation((fn) => fn({ query: q }))
  q.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT id, org_id, corp_id')) return { rows: [{ id, org_id: 'synthetic-org', corp_id: 'synthetic-corp' }] }
    if (sql.includes('AS app_key')) return { rows }
    if (sql.includes('SELECT 1 FROM directory_integrations')) return { rows: shared ? [{ one: 1 }] : [] }
    if (sql.includes('AS disabled')) return { rows: [{ disabled: stopped }] }
    if (sql.includes('AS app_matches')) return { rows }
    return { rows: [] }
  })
})
afterEach(() => vi.unstubAllEnvs())
describe('directory connection stop boundary', () => {
  it.each([undefined, '', 'all', 'Integration', null, {}, true])('rejects an invalid scope before SQL (%s)', async (scope) => {
    await expect(disableDirectoryConnection(id, scope)).rejects.toMatchObject({ code: 'DIRECTORY_DISABLE_SCOPE_INVALID', statusCode: 400 })
    expect(q).not.toHaveBeenCalled()
  })
  it('does not group legacy connections under a missing enterprise identifier', async () => {
    q.mockResolvedValueOnce({ rows: [{ id, org_id: 'synthetic-org', corp_id: '' }] })
    await expect(previewDirectoryConnectionDisable(id, 'enterprise')).rejects.toMatchObject({ code: 'DIRECTORY_ENTERPRISE_ID_UNRESOLVED' })
    expect(tx).not.toHaveBeenCalled()
  })
  it('previews without writes, decryption, or a transaction', async () => {
    expect(await previewDirectoryConnectionDisable(id, 'enterprise')).toEqual({ integrationCount: 1, disabledCount: 0 })
    expect(tx).not.toHaveBeenCalled()
    expect(q.mock.calls.every(([sql]) => sql.trim().startsWith('SELECT'))).toBe(true)
  })
  it.each(['integration', 'enterprise'])('disables only selected connection rows (%s)', async (scope) => {
    if (scope === 'enterprise') rows.push({ id: peer, app_key: 'synthetic-app-2', disabled: false })
    expect(await disableDirectoryConnection(id, scope)).toEqual({ integrationIds: rows.map((r) => r.id), disabled: true })
    const writes = q.mock.calls.filter(([sql]) => /UPDATE|INSERT|DELETE/.test(sql))
    expect(writes).toHaveLength(1)
    expect(writes[0][0]).toContain('UPDATE directory_integrations')
    expect(writes[0][1]).toEqual([rows.map((r) => r.id), scope])
    expect(writes[0][0]).not.toMatch(/SET\s+status|users|user_orgs|user_external|directory_account_links/)
  })
  it('does not expand the scope when an app is shared', async () => {
    shared = true
    await expect(disableDirectoryConnection(id, 'integration')).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_APP_SHARED' })
    expect(q.mock.calls.some(([sql]) => sql.includes('UPDATE'))).toBe(false)
  })
  it('repeated disable keeps the same target and never enables anything', async () => {
    rows[0].disabled = true
    expect(await disableDirectoryConnection(id, 'integration')).toEqual({ integrationIds: [id], disabled: true })
    expect(q.mock.calls.find(([sql]) => sql.includes('UPDATE'))?.[0]).toContain('sync_enabled = FALSE')
  })
  it.each([syncDirectoryIntegration, previewDirectorySyncIntegration])('rejects a stopped sync/preview before decrypting or issuing IO', async (run) => {
    q.mockImplementation(async (sql: string) => {
      if (sql.includes('AS disabled')) return { rows: [{ disabled: true }] }
      if (sql.includes('FROM directory_sync_runs')) return { rows: [] }
      return { rows: [{ id, config: { appSecret: 'enc:invalid' } }] }
    })
    const io = vi.spyOn(globalThis, 'fetch')
    try {
      await expect(run(id, 'synthetic-admin')).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_DISABLED' })
      expect(io).not.toHaveBeenCalled()
      expect(q.mock.calls.some(([sql]) => /INSERT|UPDATE|DELETE/.test(sql))).toBe(false)
    } finally { io.mockRestore() }
  })
  it('blocks sync with a values-free code', async () => {
    stopped = true
    await expect(assertDirectoryConnectionEnabled(id)).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_DISABLED', statusCode: 409 })
  })
  it('never invokes a provider on a disabled connection', async () => {
    stopped = true
    const send = vi.fn()
    await expect(withDingTalkConnectionOperation('synthetic-app', send)).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_DISABLED' })
    expect(send).not.toHaveBeenCalled()
  })
  it('blocks actual work-notification and todo client entrypoints before HTTP', async () => {
    stopped = true
    const fetchFn = vi.fn()
    await expect(sendDingTalkWorkNotification('synthetic-token', { userIds: ['synthetic-user'], title: 'title', content: 'body' },
      { appKey: 'synthetic-app', appSecret: 'synthetic-secret', agentId: '1' }, { fetchFn })).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_DISABLED' })
    await expect(createDingTalkTodoTask('synthetic-token', 'synthetic-operator', { sourceId: 'synthetic-source', subject: 'subject', creatorUnionId: 'synthetic-operator', executorUnionIds: ['synthetic-user'] },
      { appKey: 'synthetic-app' }, { fetchFn })).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_DISABLED' })
    expect(fetchFn).not.toHaveBeenCalled()
  })
  it('rejects a stopped task source even when global credentials select a normal peer application', async () => {
    vi.stubEnv('DINGTALK_APP_KEY', 'global-peer-app')
    vi.stubEnv('DINGTALK_APP_SECRET', 'synthetic-global-secret')
    vi.stubEnv('DINGTALK_AGENT_ID', '42')
    q.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('AS app_matches')) return { rows: params[1] === id ? [{ id, app_matches: false }, { id: peer, app_matches: true }] : [{ id: peer, app_matches: true }] }
      if (sql.includes('AS disabled')) return { rows: [{ disabled: params[0] === id }] }
      return { rows: [] }
    })
    const config = await readDingTalkMessageConfigFromRuntime(id)
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ errcode: 0, task_id: 1 }), { status: 200 }))
    await expect(sendDingTalkWorkNotification('synthetic-token', { userIds: ['synthetic-user'], title: 'title', content: 'body' }, config, { fetchFn })).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_DISABLED' })
    expect(fetchFn).not.toHaveBeenCalled()
    // The peer's own task remains allowed; disabling a source does not disable its members.
    const peerConfig = await readDingTalkMessageConfigFromRuntime(peer)
    await expect(sendDingTalkWorkNotification('synthetic-token', { userIds: ['synthetic-user'], title: 'title', content: 'body' }, peerConfig, { fetchFn })).resolves.toMatchObject({ taskId: '1' })
    expect(fetchFn).toHaveBeenCalledOnce()
  })
  it('does not substitute a live application when the explicit source connection disappeared', async () => {
    q.mockImplementation(async (sql: string) => ({ rows: sql.includes('AS app_matches') ? [{ id: peer }] : [] }))
    const send = vi.fn()
    await expect(withDingTalkConnectionOperation('global-peer-app', send, id)).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_NOT_FOUND' })
    expect(send).not.toHaveBeenCalled()
  })
  it('marks a successful HTTP followed by COMMIT failure as outcome unknown', async () => {
    tx.mockImplementationOnce(async (fn) => {
      await fn({ query: q })
      throw new Error('synthetic commit connection lost')
    })
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ errcode: 0, task_id: 1 }), { status: 200 }))
    const error = await sendDingTalkWorkNotification('synthetic-token', { userIds: ['synthetic-user'], title: 'title', content: 'body' },
      { appKey: 'synthetic-app', appSecret: 'synthetic-secret', agentId: '1' }, { fetchFn }).catch((error: unknown) => error)
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(isDingTalkOutcomeUnknown(error)).toBe(true)
    expect(error).toMatchObject({ message: 'DIRECTORY_SEND_FINALIZATION_FAILED' })
  })
  it('leaves the OAuth code exchange outside the connection stop', async () => {
    stopped = true
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ accessToken: 'synthetic-token', expireIn: 7200 }), headers: { get: () => null } }))
    const originalFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchFn as never)
    try {
      await exchangeCodeForUserAccessToken('synthetic-code', { clientId: 'synthetic-app', clientSecret: 'synthetic-secret', corpId: null, redirectUri: 'https://example.invalid/callback' })
    } finally { originalFetch.mockRestore() }
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(tx).not.toHaveBeenCalled()
    expect(q).not.toHaveBeenCalled()
  })
  it('allows a normal registered connection and holds its lock before sending', async () => {
    const send = vi.fn(async () => {
      expect(q.mock.calls.some(([sql]) => sql.includes('pg_advisory_xact_lock'))).toBe(true)
      return 'sent'
    })
    expect(await withDingTalkConnectionOperation('synthetic-app', send)).toBe('sent')
  })
  it('fails closed on an unavailable connection store before any HTTP', async () => {
    q.mockRejectedValueOnce(new Error('synthetic query failure'))
    const send = vi.fn()
    await expect(withDingTalkConnectionOperation('synthetic-app', send)).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_STATE_UNAVAILABLE', statusCode: 503 })
    expect(send).not.toHaveBeenCalled()
  })
  it('reports lock contention as a retryable conflict, never a send', async () => {
    q.mockRejectedValueOnce(Object.assign(new Error('synthetic lock timeout'), { code: '55P03' }))
    const send = vi.fn()
    await expect(withDingTalkConnectionOperation('synthetic-app', send)).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_BUSY', statusCode: 409 })
    expect(send).not.toHaveBeenCalled()
  })
  it('preserves a transport error once the operation starts', async () => {
    const error = new Error('synthetic transport failure')
    await expect(withDingTalkConnectionOperation('synthetic-app', async () => { throw error })).rejects.toBe(error)
  })
  it('refuses unscoped sends if a stopped connection exists', async () => {
    const send = vi.fn()
    await expect(withDingTalkConnectionOperation(undefined, send)).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_SCOPE_REQUIRED' })
    expect(send).not.toHaveBeenCalled()
  })
})
