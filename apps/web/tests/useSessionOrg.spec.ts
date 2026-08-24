import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { persistSessionOrgChoice, SESSION_ORG_CHOICE_KEY } from '../src/utils/sessionOrgChoice'

const apiFetch = vi.fn()
const authMocks = {
  getCurrentUserId: vi.fn(),
  setToken: vi.fn(),
}

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => authMocks,
}))

import { useSessionOrg } from '../src/composables/useSessionOrg'

describe('useSessionOrg', () => {
  beforeEach(() => {
    window.localStorage.clear()
    apiFetch.mockReset()
    authMocks.getCurrentUserId.mockReset()
    authMocks.setToken.mockReset()
    authMocks.getCurrentUserId.mockResolvedValue('user-1')
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  it('loads memberships without inventing a current org', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { orgs: ['default', 'tenant_42'], currentOrgId: null },
      }),
    })

    const sessionOrg = useSessionOrg()
    const snapshot = await sessionOrg.loadSessionOrgs()

    expect(apiFetch).toHaveBeenCalledWith('/api/auth/session-orgs', {
      suppressUnauthorizedRedirect: true,
    })
    expect(snapshot.currentOrgId).toBeNull()
    expect(sessionOrg.orgs.value).toEqual(['default', 'tenant_42'])
    expect(sessionOrg.currentOrgId.value).toBeNull()
  })

  it('persists an explicit switcher choice and remints without writing the injected hint', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          token: 'switched-token',
          currentOrgId: 'tenant_42',
          user: { id: 'user-1' },
        },
      }),
    })

    const sessionOrg = useSessionOrg()
    await expect(sessionOrg.switchSessionOrg('tenant_42')).resolves.toBe(true)

    expect(apiFetch).toHaveBeenCalledWith('/api/auth/session-org', {
      method: 'POST',
      body: JSON.stringify({ orgId: 'tenant_42' }),
      suppressUnauthorizedRedirect: true,
    })
    expect(authMocks.setToken).toHaveBeenCalledWith('switched-token', { persistInjectedTenantHint: false })
    expect(JSON.parse(window.localStorage.getItem(SESSION_ORG_CHOICE_KEY) || 'null')).toEqual({
      userId: 'user-1',
      orgId: 'tenant_42',
    })
    expect(window.localStorage.getItem('tenantId')).toBeNull()
    expect(sessionOrg.currentOrgId.value).toBe('tenant_42')
  })

  it('restores a stored explicit choice, including default', async () => {
    persistSessionOrgChoice('user-1', 'default')
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          token: 'default-token',
          currentOrgId: 'default',
          user: { id: 'user-1' },
        },
      }),
    })

    const sessionOrg = useSessionOrg()
    await expect(sessionOrg.restoreExplicitSessionOrg()).resolves.toBe(true)
    expect(apiFetch).toHaveBeenCalledWith('/api/auth/session-org', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ orgId: 'default' }),
    }))
  })
})
