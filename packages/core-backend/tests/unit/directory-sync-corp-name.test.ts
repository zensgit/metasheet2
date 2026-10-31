import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDirectoryIntegration, updateDirectoryIntegration, listDirectoryIntegrations, DirectoryValidationError } from '../../src/directory/directory-sync'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ query: queryMock, transaction: vi.fn() }))

const input = { name: 'Synthetic integration', corpId: 'synthetic-corp', appKey: 'synthetic-app', appSecret: 'synthetic-secret' }
function row(config: Record<string, unknown> = {}) {
  return {
    id: 'corp-name-test', org_id: 'synthetic-org', provider: 'dingtalk', name: input.name,
    status: 'active', corp_id: input.corpId, config: { ...input, ...config }, sync_enabled: false,
    schedule_cron: null, schedule_timezone: null, default_deprovision_policy: 'mark_inactive',
    last_sync_at: null, last_success_at: null, last_error: null,
    created_at: '2026-10-29T00:00:00Z', updated_at: '2026-10-29T00:00:00Z',
  }
}

describe('directory enterprise name is display metadata', () => {
  beforeEach(() => { queryMock.mockReset() })

  it('stores a trimmed optional name and returns it separately from Corp ID and local org', async () => {
    queryMock.mockImplementation(async (_sql: string, params: unknown[]) => ({ rows: [row(JSON.parse(String(params[5])))] }))
    const result = await createDirectoryIntegration({ ...input, corpName: ' 合成企业 ' })
    expect(result.config.corpName).toBe('合成企业')
    expect(result.corpId).toBe(input.corpId)
    expect(result.orgId).toBe('synthetic-org')
    expect(result.config).not.toHaveProperty('appSecret')
  })

  it.each([undefined, '', '  '])('reports an unknown name without guessing from the integration label (%s)', async (corpName) => {
    queryMock.mockResolvedValue({ rows: [row({ corpName })] })
    const result = await listDirectoryIntegrations()
    expect(result[0].config.corpName).toBeNull()
  })

  it.each([undefined, '', ' 新企业 '])('preserves omitted names and supports explicit clearing or replacement (%s)', async (corpName) => {
    let saved: Record<string, unknown> = {}
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('UPDATE directory_integrations')) {
        saved = JSON.parse(String(params[4]))
        return { rows: [row(saved)] }
      }
      return { rows: [row({ corpName: '原企业' })] }
    })
    const result = await updateDirectoryIntegration('corp-name-test', { ...input, ...(corpName === undefined ? {} : { corpName }) })
    expect(result.config.corpName).toBe(corpName === undefined ? '原企业' : corpName.trim() || null)
    expect(saved.corpName).toBe(result.config.corpName)
  })

  it.each([null, 123, {}, 'x'.repeat(201)])('rejects invalid name metadata before writing', async (corpName) => {
    await expect(createDirectoryIntegration({ ...input, corpName } as never)).rejects.toBeInstanceOf(DirectoryValidationError)
    expect(queryMock).not.toHaveBeenCalled()
  })
})
