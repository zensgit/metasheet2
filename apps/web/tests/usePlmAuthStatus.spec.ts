import { describe, expect, it, vi } from 'vitest'
import { resolveTokenStatus, usePlmAuthStatus } from '../src/views/plm/usePlmAuthStatus'

function createJwt(expSeconds: number) {
  const encode = (payload: object) =>
    Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${encode({ exp: expSeconds })}.signature`
}

describe('usePlmAuthStatus', () => {
  it('resolves token status by expiry window', () => {
    const now = Date.UTC(2026, 2, 8, 12, 0, 0)

    expect(resolveTokenStatus('', now).state).toBe('missing')
    expect(resolveTokenStatus('broken.token', now).state).toBe('invalid')
    expect(resolveTokenStatus(createJwt(Math.floor(now / 1000) - 10), now).state).toBe('expired')
    expect(resolveTokenStatus(createJwt(Math.floor(now / 1000) + 60), now).state).toBe('expiring')
    expect(resolveTokenStatus(createJwt(Math.floor(now / 1000) + 3600), now).state).toBe('valid')
  })

  it('refreshes metasheet and plm auth states from storage and marks legacy token', () => {
    const storage = {
      getItem: vi.fn((key: string) => {
        if (key === 'auth_token') return createJwt(Math.floor(Date.now() / 1000) + 3600)
        if (key === 'plm_token') return ''
        if (key === 'jwt') return createJwt(Math.floor(Date.now() / 1000) + 300)
        return ''
      }),
    }
    const auth = usePlmAuthStatus({ storage })

    auth.refreshAuthStatus()

    expect(auth.authState.value).toBe('valid')
    expect(auth.plmAuthState.value).toBe('expiring')
    expect(auth.plmAuthLegacy.value).toBe(true)
  })
})
