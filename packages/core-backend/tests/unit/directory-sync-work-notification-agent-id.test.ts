import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDirectoryIntegration, updateDirectoryIntegration } from '../../src/directory/directory-sync'
import { decryptStoredSecretValue, normalizeStoredSecretValue } from '../../src/security/encrypted-secrets'

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: queryMock,
  transaction: vi.fn(),
}))

function integrationRow(config: Record<string, unknown> = {}) {
  return {
    id: 'dir-1',
    org_id: 'default',
    provider: 'dingtalk',
    name: 'DingTalk CN',
    status: 'active',
    corp_id: 'dingcorp',
    config: {
      appKey: 'ding-app-key',
      appSecret: normalizeStoredSecretValue('unit-secret'),
      rootDepartmentId: '1',
      pageSize: 50,
      admissionMode: 'manual_only',
      admissionDepartmentIds: [],
      excludeDepartmentIds: [],
      memberGroupSyncMode: 'disabled',
      memberGroupDepartmentIds: [],
      memberGroupDefaultRoleIds: [],
      memberGroupDefaultNamespaces: [],
      ...config,
    },
    sync_enabled: true,
    schedule_cron: null,
    default_deprovision_policy: 'mark_inactive',
    last_sync_at: null,
    last_success_at: null,
    last_error: null,
    created_at: '2026-05-08T00:00:00.000Z',
    updated_at: '2026-05-08T00:00:00.000Z',
  }
}

describe('directory sync work-notification Agent ID storage boundary', () => {
  beforeEach(() => {
    queryMock.mockReset()
  })

  it('does not persist Agent ID from the generic create integration path', async () => {
    let persistedConfig: Record<string, unknown> | null = null
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO directory_integrations')) {
        persistedConfig = JSON.parse(String(params[5]))
        return { rows: [integrationRow(persistedConfig)] }
      }
      return { rows: [] }
    })

    await createDirectoryIntegration({
      name: 'DingTalk CN',
      corpId: 'dingcorp',
      appKey: 'ding-app-key',
      appSecret: 'unit-secret',
      workNotificationAgentId: 'not-a-valid-agent-id',
    } as never)

    expect(persistedConfig?.workNotificationAgentId).toBeNull()
    expect(JSON.stringify(persistedConfig)).not.toContain('not-a-valid-agent-id')
  })

  it('preserves existing Agent ID but ignores generic update payload overrides', async () => {
    let persistedConfig: Record<string, unknown> | null = null
    const currentAgentId = normalizeStoredSecretValue('123456789')
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM directory_integrations') && sql.includes('WHERE id = $1')) {
        return { rows: [integrationRow({ workNotificationAgentId: currentAgentId })] }
      }
      if (sql.includes('UPDATE directory_integrations')) {
        persistedConfig = JSON.parse(String(params[4]))
        return { rows: [integrationRow(persistedConfig)] }
      }
      return { rows: [] }
    })

    await updateDirectoryIntegration('dir-1', {
      name: 'DingTalk CN',
      corpId: 'dingcorp',
      appKey: 'ding-app-key',
      appSecret: '',
      workNotificationAgentId: 'not-a-valid-agent-id',
    } as never)

    expect(decryptStoredSecretValue(String(persistedConfig?.workNotificationAgentId))).toBe('123456789')
    expect(JSON.stringify(persistedConfig)).not.toContain('not-a-valid-agent-id')
  })
})
