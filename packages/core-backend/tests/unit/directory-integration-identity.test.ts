import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DirectoryConflictError,
  DirectoryValidationError,
  listDirectoryIntegrations,
  updateDirectoryIntegration,
  updateDirectoryIntegrationIdentity,
} from '../../src/directory/directory-sync'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))
vi.mock('../../src/db/pg', () => ({ query: queryMock }))

const input = { name: 'Synthetic directory', corpId: 'synthetic-corp', appKey: 'synthetic-app', appSecret: 'synthetic-secret' }
const identity = { corpId: input.corpId, appKey: input.appKey, corpName: '合成企业', appName: '合成应用', confirm: true, appCorpId: input.corpId, appCorpName: '合成企业' }
const verification = { ...identity, source: 'admin_console', checkedAt: '2026-10-30T00:00:00.000Z', checkedBy: 'synthetic-admin' }
function row(config: Record<string, unknown> = {}) {
  return {
    id: 'synthetic-integration', org_id: 'synthetic-org', provider: 'dingtalk', name: input.name,
    status: 'active', corp_id: input.corpId,
    config: { ...input, corpName: identity.corpName, appName: identity.appName, ...config },
    sync_enabled: true, schedule_cron: '0 2 * * *', schedule_timezone: 'Asia/Tokyo',
    default_deprovision_policy: 'mark_inactive', last_sync_at: null, last_success_at: null, last_error: null,
    created_at: '2026-10-30T00:00:00Z', updated_at: '2026-10-30T00:00:00Z',
  }
}

beforeEach(() => { queryMock.mockReset() })

describe('directory identity metadata', () => {
  it('never treats administrator-entered names as verification', async () => {
    queryMock.mockResolvedValue({ rows: [row()] })
    const [result] = await listDirectoryIntegrations()
    expect(result.config).toMatchObject({ corpName: identity.corpName, appName: identity.appName, identityStatus: 'unverified', identityVerification: null })
  })

  it.each([
    [input.corpId, 'verified'], ['other-synthetic-corp', 'mismatch'],
  ])('uses full enterprise identifiers for an explicitly confirmed identity (%s)', async (appCorpId, identityStatus) => {
    queryMock.mockResolvedValue({ rows: [row({ identityVerification: { ...verification, appCorpId, appCorpName: identity.corpName } })] })
    const [result] = await listDirectoryIntegrations()
    expect(result.config.identityStatus).toBe(identityStatus)
    expect(result.config.identityVerification).not.toHaveProperty('confirm')
    expect(result.config).not.toHaveProperty('appSecret')
  })

  it.each([
    { appKey: 'changed-app' }, { corpId: 'changed-corp' }, { corpName: '旧企业' },
    { appName: '旧应用' }, { checkedAt: 'invalid' }, { source: 'provider_api' },
    { appCorpId: '' }, { checkedBy: '' },
  ])('discards stale or malformed stored verification without failing the list (%j)', async (change) => {
    queryMock.mockResolvedValue({ rows: [row({ identityVerification: { ...verification, ...change } }), row()] })
    const result = await listDirectoryIntegrations()
    expect(result).toHaveLength(2)
    expect(result[0].config.identityStatus).toBe('unverified')
    expect(result[0].config.identityVerification).toBeNull()
  })

  it('records server attribution and updates only metadata under an optimistic configuration guard', async () => {
    const current = row({ approvalCardLinkSecret: 'retained', todoOperatorUnionId: 'retained-operator' })
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (!sql.includes('UPDATE directory_integrations')) return { rows: [current] }
      const patch = JSON.parse(String(params[1]))
      expect(patch).toMatchObject({ corpName: identity.corpName, appName: identity.appName, identityVerification: { checkedBy: 'actual-admin', source: 'admin_console' } })
      expect(Number.isFinite(Date.parse(patch.identityVerification.checkedAt))).toBe(true)
      expect(sql).toContain('config IS NOT DISTINCT FROM')
      expect(sql).not.toMatch(/SET\s+(corp_id|sync_enabled)/)
      expect(Object.keys(patch).sort()).toEqual(['appName', 'corpName', 'identityVerification'])
      return { rows: [{ ...current, config: { ...current.config, ...patch } }] }
    })
    const result = await updateDirectoryIntegrationIdentity(current.id, identity, 'actual-admin')
    expect(result?.config.identityStatus).toBe('verified')
    expect(result?.syncEnabled).toBe(true)
    expect(result?.scheduleTimezone).toBe('Asia/Tokyo')
    expect(queryMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    { confirm: 'true' }, { confirm: true, appCorpId: '' }, { confirm: true, appName: '' },
    { confirm: true, appCorpName: '' }, { confirm: true, appCorpId: 'corp with spaces' },
    { checkedBy: 'spoofed' }, { checkedAt: '2020-01-01' }, { syncEnabled: true },
    { appSecret: 'replacement' }, { appName: 'x'.repeat(201) }, { corpName: null },
  ])('rejects invalid or extra fields without writes (%j)', async (change) => {
    queryMock.mockResolvedValue({ rows: [row()] })
    await expect(updateDirectoryIntegrationIdentity('synthetic-integration', { ...identity, ...change }, 'actual-admin')).rejects.toBeInstanceOf(DirectoryValidationError)
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('UPDATE'))).toBe(false)
  })

  it('clears confirmation when saving a changed display name without claiming a new verification', async () => {
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      const current = row({ identityVerification: verification })
      if (!sql.includes('UPDATE')) return { rows: [current] }
      const patch = JSON.parse(String(params[1]))
      expect(patch.identityVerification).toBeNull()
      return { rows: [{ ...current, config: { ...current.config, ...patch } }] }
    })
    const result = await updateDirectoryIntegrationIdentity('synthetic-integration', { ...identity, appName: '新名称', confirm: false }, 'actual-admin')
    expect(result?.config.identityStatus).toBe('unverified')
    expect(result?.config.appName).toBe('新名称')
    expect(result?.syncEnabled).toBe(true)
  })

  it('does not accept confirmation without an authenticated administrator', async () => {
    queryMock.mockResolvedValue({ rows: [row()] })
    await expect(updateDirectoryIntegrationIdentity('synthetic-integration', identity, '')).rejects.toBeInstanceOf(DirectoryValidationError)
  })

  it.each([{ appKey: 'changed-app' }, { corpId: 'changed-corp' }])('rejects a stale client binding (%j)', async (change) => {
    queryMock.mockResolvedValue({ rows: [row()] })
    await expect(updateDirectoryIntegrationIdentity('synthetic-integration', { ...identity, ...change }, 'actual-admin')).rejects.toBeInstanceOf(DirectoryConflictError)
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('UPDATE'))).toBe(false)
  })

  it('rejects a concurrent configuration change instead of attributing verification to new credentials', async () => {
    queryMock.mockImplementation(async (sql: string) => ({ rows: sql.includes('UPDATE') ? [] : [row()] }))
    await expect(updateDirectoryIntegrationIdentity('synthetic-integration', identity, 'actual-admin')).rejects.toBeInstanceOf(DirectoryConflictError)
  })

  it.each([
    [{}, 'verified'], [{ appName: '新应用名' }, 'unverified'],
    [{ corpName: '新企业名' }, 'unverified'], [{ appKey: 'new-app' }, 'unverified'],
    [{ appSecret: 'new-secret' }, 'unverified'], [{ baseUrl: 'https://synthetic.invalid' }, 'unverified'],
  ])('retains or invalidates verification on ordinary edits (%j)', async (change, expected) => {
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => ({ rows: [sql.includes('UPDATE') ? row(JSON.parse(String(params[4]))) : row({ identityVerification: verification })] }))
    const result = await updateDirectoryIntegration('synthetic-integration', { ...input, ...change })
    expect(result?.config.identityStatus).toBe(expected)
  })
})
