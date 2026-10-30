import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeDingTalkApprovalCardCallback } from '../../src/integrations/dingtalk/interactive-card-callback'
import { applyDingTalkApprovalCardWebTerminalUpdate } from '../../src/integrations/dingtalk/interactive-card-update'
import { testDingTalkWorkNotificationAgentId } from '../../src/integrations/dingtalk/work-notification-settings'
import { __resetDingTalkAppAccessTokenCacheForTests } from '../../src/integrations/dingtalk/client'
import { withDingTalkConnectionOperation } from '../../src/directory/connection-disable'
import { getApprovalCardDeliverySummary } from '../../src/services/ApprovalCardDeliveryAction'
import type { ApprovalCardActionOutcome } from '../../src/services/ApprovalCardDeliveryAction'

const { query, state } = vi.hoisted(() => ({ query: vi.fn(), state: { stopped: true, registered: true } }))
vi.mock('../../src/db/pg', () => ({ query, transaction: (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }) }))
const source = '11111111-1111-4111-8111-111111111111'
const peer = '22222222-2222-4222-8222-222222222222'
const delivery = '33333333-3333-4333-8333-333333333333'
const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ access_token: 'synthetic-token', expires_in: 7200, errcode: 0, task_id: 1, success: true }), { status: 200 }))

beforeEach(() => {
  state.stopped = true; state.registered = true
  query.mockReset(); fetchFn.mockClear()
  __resetDingTalkAppAccessTokenCacheForTests()
  vi.stubGlobal('fetch', fetchFn)
  vi.stubEnv('DINGTALK_APP_KEY', 'global-peer-app')
  vi.stubEnv('DINGTALK_APP_SECRET', 'synthetic-secret')
  vi.stubEnv('DINGTALK_CLIENT_ID', 'global-peer-app')
  vi.stubEnv('DINGTALK_CLIENT_SECRET', 'synthetic-secret')
  vi.stubEnv('DINGTALK_AGENT_ID', '42')
  vi.stubEnv('DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED', 'true')
  vi.stubEnv('DINGTALK_INTERACTIVE_CARD_CLIENT_ID', 'global-peer-app')
  vi.stubEnv('DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET', 'synthetic-secret')
  vi.stubEnv('DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID', 'synthetic-template')
  query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('AS app_matches')) return { rows: [
      ...(params[1] ? [{ id: String(params[1]), app_matches: false }] : []),
      ...(state.registered ? [{ id: peer, app_matches: true }] : []),
    ] }
    if (sql.includes('AS disabled')) return { rows: [{ disabled: params[0] === source && state.stopped }] }
    if (sql.includes('SELECT 1 FROM directory_integrations')) return { rows: state.stopped ? [{ one: 1 }] : [] }
    if (sql.includes('SELECT id, name, status, config')) return { rows: [{ id: source, name: 'Synthetic', status: 'active', config: { appKey: 'source-app', appSecret: 'synthetic-secret', workNotificationAgentId: '42' } }] }
    if (sql.includes('SELECT corp_id')) return { rows: state.stopped ? [] : [{ corp_id: 'synthetic-corp' }] }
    if (sql.includes('FROM approval_instances')) return { rows: [{ id: 'synthetic-instance', status: 'revoked', policy_snapshot: {} }] }
    if (sql.includes('FROM dingtalk_approval_card_deliveries')) return { rows: [{ id: delivery, integration_id: source, delivery_kind: 'interactive_card' }] }
    return { rows: [] }
  })
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

const writes = () => fetchFn.mock.calls.filter(([url]) => !String(url).includes('gettoken'))

describe('source provenance at remaining outbound entry points', () => {
  it('the authoritative web summary carries the delivery source into the update hook', async () => {
    vi.stubEnv('APPROVAL_CARD_LINK_SECRET', 'synthetic-link-secret')
    const token = createHmac('sha256', 'synthetic-link-secret').update(delivery).digest('hex').slice(0, 32)
    const result = await getApprovalCardDeliverySummary({ query }, { deliveryId: delivery, token, viewerUserId: 'synthetic-user' })
    expect(result).toMatchObject({ status: 'ok', summary: { integrationId: source } })
  })

  it('a new stopped-source callback refuses the approval and emits no neutral card update through the normal global app', async () => {
    const dispatchAction = vi.fn()
    const result = await executeDingTalkApprovalCardCallback({ query, approvals: { dispatchAction } }, {
      outTrackId: delivery, corpId: 'synthetic-corp', userId: 'synthetic-operator',
      content: JSON.stringify({ cardPrivateData: { actionIds: ['approve'], params: {} } }),
    })
    expect(result).toMatchObject({ outcome: 'operator_unresolved', reason: 'delivery_corp_unresolved' })
    expect(dispatchAction).not.toHaveBeenCalled()
    expect(writes()).toHaveLength(0)
  })

  it('a committed local web decision stays successful while its stopped-source presentation update never leaves', async () => {
    const outcome = { status: 'ok', summary: { integrationId: source, deliveryId: delivery, deliveryKind: 'interactive_card', approval: { status: 'revoked' } } } as ApprovalCardActionOutcome
    expect(await applyDingTalkApprovalCardWebTerminalUpdate(outcome)).toMatchObject({ status: 'failed', reason: 'DirectoryConnectionError' })
    expect(outcome.status).toBe('ok')
    expect(writes()).toHaveLength(0)
    state.stopped = false
    expect(await applyDingTalkApprovalCardWebTerminalUpdate(outcome)).toMatchObject({ status: 'updated' })
    expect(writes()).toHaveLength(1)
  })

  it('an unresolved source cannot send a web update via otherwise healthy global credentials', async () => {
    const outcome = { status: 'ok', summary: { deliveryId: delivery, deliveryKind: 'interactive_card', approval: { status: 'revoked' } } } as ApprovalCardActionOutcome
    expect(await applyDingTalkApprovalCardWebTerminalUpdate(outcome)).toEqual({ status: 'skipped', reason: 'source_integration_unresolved' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('the direct work-notification test API preserves its database source even with env credentials', async () => {
    await expect(testDingTalkWorkNotificationAgentId({ integrationId: source, recipientUserId: 'synthetic-user' })).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_DISABLED' })
    expect(writes()).toHaveLength(0)
    state.stopped = false
    await expect(testDingTalkWorkNotificationAgentId({ integrationId: source, recipientUserId: 'synthetic-user' })).resolves.toMatchObject({})
    expect(writes()).toHaveLength(1)
  })

  it('an explicit normal source does not turn an unregistered app into a registered app', async () => {
    state.registered = false
    const send = vi.fn()
    await expect(withDingTalkConnectionOperation('unregistered-app', send, peer)).rejects.toMatchObject({ code: 'DIRECTORY_CONNECTION_SCOPE_REQUIRED' })
    expect(send).not.toHaveBeenCalled()
  })
})
