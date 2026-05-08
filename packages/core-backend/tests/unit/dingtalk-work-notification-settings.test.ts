import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeStoredSecretValue } from '../../src/security/encrypted-secrets'

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: dbMocks.query,
}))

import {
  getDingTalkWorkNotificationRuntimeStatusFromStore,
  normalizeDingTalkWorkNotificationAgentId,
  readDingTalkMessageConfigFromRuntime,
  saveDingTalkWorkNotificationAgentId,
} from '../../src/integrations/dingtalk/work-notification-settings'

function directoryRow(config: Record<string, unknown> = {}) {
  return {
    id: 'dir-1',
    name: 'DingTalk CN',
    status: 'active',
    updated_at: '2026-05-08T00:00:00.000Z',
    config: {
      appKey: 'dt-app-key',
      appSecret: normalizeStoredSecretValue('dt-app-secret'),
      baseUrl: 'https://oapi.dingtalk.com',
      ...config,
    },
  }
}

describe('dingtalk work notification settings', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    dbMocks.query.mockReset()
  })

  it('normalizes numeric DingTalk Agent IDs only', () => {
    expect(normalizeDingTalkWorkNotificationAgentId(' 123456789 ')).toBe('123456789')
    expect(() => normalizeDingTalkWorkNotificationAgentId('agent-123')).toThrow('DingTalk Agent ID must be 1-32 numeric characters')
  })

  it('builds runtime status from directory integration Agent ID without leaking values', async () => {
    dbMocks.query.mockResolvedValueOnce({
      rows: [directoryRow({ workNotificationAgentId: normalizeStoredSecretValue('123456789') })],
    })

    const status = await getDingTalkWorkNotificationRuntimeStatusFromStore('dir-1')

    expect(status.available).toBe(true)
    expect(status.source).toBe('directory_integration')
    expect(status.requirements.agentId.selectedKey).toBe('directory_integrations.config.workNotificationAgentId')
    expect(JSON.stringify(status)).not.toContain('123456789')
    expect(JSON.stringify(status)).not.toContain('dt-app-secret')
  })

  it('lets environment app credentials use the directory Agent ID fallback', async () => {
    vi.stubEnv('DINGTALK_CLIENT_ID', 'env-app-key')
    vi.stubEnv('DINGTALK_CLIENT_SECRET', 'env-app-secret')
    dbMocks.query.mockResolvedValueOnce({
      rows: [directoryRow({ workNotificationAgentId: '123456789' })],
    })

    const config = await readDingTalkMessageConfigFromRuntime('dir-1')

    expect(config).toEqual({
      appKey: 'env-app-key',
      appSecret: 'env-app-secret',
      agentId: '123456789',
      baseUrl: 'https://oapi.dingtalk.com',
    })
  })

  it('does not query directory integrations when env work notification config is complete', async () => {
    vi.stubEnv('DINGTALK_CLIENT_ID', 'env-app-key')
    vi.stubEnv('DINGTALK_CLIENT_SECRET', 'env-app-secret')
    vi.stubEnv('DINGTALK_AGENT_ID', '123456789')

    const config = await readDingTalkMessageConfigFromRuntime()

    expect(config).toEqual({
      appKey: 'env-app-key',
      appSecret: 'env-app-secret',
      agentId: '123456789',
      baseUrl: undefined,
    })
    expect(dbMocks.query).not.toHaveBeenCalled()
  })

  it('validates app access token before saving Agent ID and stores it encrypted', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ errcode: 0, access_token: 'app-access-token' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)
    dbMocks.query
      .mockResolvedValueOnce({ rows: [directoryRow()] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({
        rows: [directoryRow({ workNotificationAgentId: normalizeStoredSecretValue('123456789') })],
      })

    const result = await saveDingTalkWorkNotificationAgentId({
      integrationId: 'dir-1',
      agentId: '123456789',
    })

    expect(result.saved).toBe(true)
    expect(result.accessTokenVerified).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const updateArgs = dbMocks.query.mock.calls[1]
    expect(String(updateArgs[0])).toContain('workNotificationAgentId')
    expect(updateArgs[1]).toEqual([
      'dir-1',
      expect.stringMatching(/^enc:/),
      'dingtalk',
    ])
    expect(String(updateArgs[1][1])).not.toContain('123456789')
  })
})
