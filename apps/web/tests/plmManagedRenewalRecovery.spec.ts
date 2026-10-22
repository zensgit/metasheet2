import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTH_IDENTITY_LOCK_NAME,
  MANAGED_COMPLETE_PENDING_KEY,
  MANAGED_RENEWAL_PENDING_KEY,
  withAuthIdentityLock,
} from '../src/composables/authIdentityLock'
import {
  bumpManagedEpoch,
  clearManagedDescriptor,
  clearManagedProbeMarker,
  installManagedDescriptor,
  readManagedDescriptor,
  setManagedProbeMarker,
  type ManagedSessionDescriptor,
} from '../src/composables/authPrincipal'
import { useAuth } from '../src/composables/useAuth'
import {
  MANAGED_RENEWAL_LEAD_MS,
  continuousRenewalDue,
  continuousRenewalEligible,
  renewManagedContinuousSession,
  renewManagedContinuousSessionUnlocked,
} from '../src/services/plm/plmManagedCompanion'

const RENEW_PATH = '/api/plm/managed-login/renew-recovery'

function future(ms: number): string {
  return new Date(Date.now() + ms).toISOString()
}

function descriptor(overrides: Partial<ManagedSessionDescriptor> = {}): ManagedSessionDescriptor {
  return {
    mode: 'managed-cookie',
    userId: 'person-a',
    tenantId: 'tenant-a',
    sessionId: 'session-a',
    revision: 4,
    expiresAt: future(30_000),
    continuityMode: 'continuous',
    credentialGeneration: 0,
    ...overrides,
  }
}

function currentBody(session: ManagedSessionDescriptor) {
  return {
    success: true,
    data: {
      user: { id: session.userId, tenantId: session.tenantId, role: 'user', permissions: [], must_change_password: false },
      features: { plm: true, attendance: false, workflow: false },
      managedSession: session,
    },
  }
}

function installQueueLock(): { names: string[] } {
  let tail = Promise.resolve()
  const names: string[] = []
  const request = (name: string, _options: unknown, callback: () => unknown) => {
    names.push(name)
    const run = tail.then(() => callback())
    tail = run.then(() => undefined, () => undefined)
    return run
  }
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
  return { names }
}

function installReentryLock(): void {
  let held = false
  const request = (name: string, _options: unknown, callback: () => unknown) => {
    if (held) throw new Error('recursive lock')
    held = true
    return Promise.resolve().then(async () => {
      try {
        return await callback()
      } finally {
        held = false
      }
    })
  }
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
}

function removeLock(): void {
  Reflect.deleteProperty(navigator, 'locks')
}

function resetOrdinaryWriter(): void {
  removeLock()
  clearManagedDescriptor()
  clearManagedProbeMarker()
  localStorage.removeItem(MANAGED_COMPLETE_PENDING_KEY)
  localStorage.removeItem(MANAGED_RENEWAL_PENDING_KEY)
  useAuth().clearToken()
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>
}

describe('managed cookie renewal recovery', () => {
  beforeEach(() => {
    removeLock()
    localStorage.clear()
    sessionStorage.clear()
    clearManagedProbeMarker()
    clearManagedDescriptor()
    useAuth().clearToken()
    window.history.replaceState(null, '', '/')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.VITE_API_URL
    removeLock()
    localStorage.clear()
    clearManagedProbeMarker()
    clearManagedDescriptor()
    useAuth().clearToken()
  })

  it('stores an authenticated continuity mode and native generation without inventing renewal authority', () => {
    const installed = installManagedDescriptor(descriptor({ revision: 4, credentialGeneration: 2, expiresAt: future(600_000) }))
    expect(installed).toMatchObject({
      mode: 'managed-cookie',
      revision: 4,
      continuityMode: 'continuous',
      credentialGeneration: 2,
    })
    expect(continuousRenewalEligible(readManagedDescriptor())).toBe(true)
    expect(continuousRenewalDue(readManagedDescriptor())).toBe(false)
    clearManagedDescriptor()
    installManagedDescriptor(descriptor())
    expect(continuousRenewalDue(readManagedDescriptor())).toBe(true)
    expect(MANAGED_RENEWAL_LEAD_MS).toBe(120_000)
    clearManagedDescriptor()
    const snapshot = installManagedDescriptor({
      mode: 'managed-cookie',
      userId: 'person-a',
      tenantId: 'tenant-a',
      sessionId: 'session-snapshot',
      revision: 1,
      expiresAt: future(30_000),
    })
    expect(snapshot?.sessionId).toBe('session-snapshot')
    expect(continuousRenewalEligible(readManagedDescriptor())).toBe(false)
    clearManagedDescriptor()
    expect(installManagedDescriptor(descriptor({ continuityMode: 'ordinary', credentialGeneration: null }))?.continuityMode).toBe('ordinary')
    expect(continuousRenewalEligible(readManagedDescriptor())).toBe(false)
    clearManagedDescriptor()
    expect(installManagedDescriptor(descriptor({ credentialGeneration: 7 }))).not.toBeNull()
    expect(continuousRenewalEligible(readManagedDescriptor())).toBe(false)
    clearManagedDescriptor()
    expect(installManagedDescriptor(descriptor({ continuityMode: 'ordinary', credentialGeneration: 0 }))).toBeNull()
    expect(installManagedDescriptor(descriptor({ continuityMode: 'continuous', credentialGeneration: null }))).toBeNull()
    expect(installManagedDescriptor({ ...descriptor(), continuityMode: 'hour' as 'continuous' })).toBeNull()
    expect(readManagedDescriptor()).toBeNull()
  })

  it('posts renew-recovery with the cookie bridge and no bearer', async () => {
    installQueueLock()
    localStorage.setItem('auth_token', 'stored-bearer')
    localStorage.setItem('jwt', 'stored-bearer')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(renewManagedContinuousSession()).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(new URL(RENEW_PATH, window.location.origin).toString())
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(init.referrerPolicy).toBe('no-referrer')
    expect(init.body).toBe(JSON.stringify({}))
    const headers = headerRecord(init)
    expect(headers['x-metasheet-managed-bridge']).toBe('renew-recovery')
    expect(headers.authorization).toBeUndefined()
    expect(headers.Authorization).toBeUndefined()
    expect(JSON.stringify(headers).toLowerCase()).not.toContain('bearer')
    expect(localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY)).toBeNull()
  })

  it('does not treat 409 or a malformed success as an installed identity', async () => {
    installQueueLock()
    installManagedDescriptor(descriptor({ expiresAt: future(600_000) }))
    const refused = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'PLM_MANAGED_RENEW_NOT_DUE', message: 'not due' },
    }), { status: 409 }))
    vi.stubGlobal('fetch', refused)
    await expect(renewManagedContinuousSession()).resolves.toEqual({ ok: false, reason: 'refused' })
    expect(readManagedDescriptor()?.sessionId).toBe('session-a')
    expect(String(refused.mock.calls[0][0])).toContain(RENEW_PATH)
    expect(localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY)).toBeNull()

    const malformed = vi.fn(async (url: string) => {
      if (String(url).includes('/logout')) {
        return new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, sessionId: 'forged' }), { status: 200 })
    })
    vi.stubGlobal('fetch', malformed)
    await expect(renewManagedContinuousSession()).resolves.toEqual({ ok: false, reason: 'malformed' })
    expect(readManagedDescriptor()).toBeNull()
    expect(malformed.mock.calls.some((call) => String(call[0]).includes('/logout'))).toBe(true)
    expect(malformed.mock.calls.some((call) => String(call[0]).includes('/current'))).toBe(false)
  })

  it('keeps a lost transport pending and compensates a late cookie after logout, epoch, or token switch', async () => {
    installQueueLock()
    installManagedDescriptor(descriptor())
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('socket reset')
    }))
    await expect(renewManagedContinuousSession()).resolves.toEqual({ ok: false, reason: 'transport' })
    expect(localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY)).toBeNull()
    expect(localStorage.getItem(MANAGED_RENEWAL_PENDING_KEY)).not.toBeNull()
    expect(readManagedDescriptor()?.sessionId).toBe('session-a')

    resetOrdinaryWriter()
    installQueueLock()
    setManagedProbeMarker()
    installManagedDescriptor(descriptor())
    const synthetic = 'owned-synthetic-bearer-not-a-real-credential'
    localStorage.setItem('auth_token', synthetic)
    localStorage.setItem('jwt', synthetic)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('owned lost response')
    }))
    await expect(renewManagedContinuousSession()).resolves.toEqual({ ok: false, reason: 'transport' })
    const leaked = localStorage.getItem(MANAGED_RENEWAL_PENDING_KEY)
    expect(leaked?.includes(synthetic) ?? false).toBe(false)
    expect(localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY)).toBeNull()
    expect(readManagedDescriptor()?.sessionId).toBe('session-a')

    const recovered = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', recovered)
    await expect(renewManagedContinuousSessionUnlocked()).resolves.toEqual({ ok: true })
    expect(localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY)).toBeNull()
    expect(localStorage.getItem(MANAGED_RENEWAL_PENDING_KEY)).toBeNull()
    expect(readManagedDescriptor()?.sessionId).toBe('session-a')

    let releaseEpoch: ((response: Response) => void) | null = null
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/logout')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 }))
      }
      return new Promise<Response>((resolve) => {
        releaseEpoch = resolve
      })
    }))
    const epochPending = renewManagedContinuousSession()
    await vi.waitFor(() => expect(releaseEpoch).not.toBeNull())
    bumpManagedEpoch()
    releaseEpoch!(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await expect(epochPending).resolves.toEqual({ ok: false, reason: 'stale' })
    expect(readManagedDescriptor()).toBeNull()

    installManagedDescriptor(descriptor())
    let releaseToken: ((response: Response) => void) | null = null
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/logout')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 }))
      }
      return new Promise<Response>((resolve) => {
        releaseToken = resolve
      })
    }))
    const tokenPending = renewManagedContinuousSession()
    await vi.waitFor(() => expect(releaseToken).not.toBeNull())
    localStorage.setItem('auth_token', 'next-person')
    releaseToken!(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await expect(tokenPending).resolves.toEqual({ ok: false, reason: 'stale' })
    expect(readManagedDescriptor()).toBeNull()

    localStorage.removeItem('auth_token')
    installManagedDescriptor(descriptor())
    let releaseLogout: ((response: Response) => void) | null = null
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/logout')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 }))
      }
      return new Promise<Response>((resolve) => {
        releaseLogout = resolve
      })
    }))
    const logoutPending = renewManagedContinuousSession()
    await vi.waitFor(() => expect(releaseLogout).not.toBeNull())
    clearManagedDescriptor()
    releaseLogout!(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await expect(logoutPending).resolves.toEqual({ ok: false, reason: 'stale' })
    expect(readManagedDescriptor()).toBeNull()
  })

  it('serializes same-tab and cross-tab callers on the shared identity lock without recursive deadlock', async () => {
    const names = installQueueLock().names
    let active = 0
    let maxActive = 0
    vi.stubGlobal('fetch', vi.fn((_url: string) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      return new Promise<Response>((resolve) => {
        setTimeout(() => {
          active -= 1
          resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
        }, 20)
      })
    }))
    const [first, second] = await Promise.all([
      renewManagedContinuousSession(),
      renewManagedContinuousSession(),
    ])
    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: true })
    expect(maxActive).toBe(1)
    expect(names).toEqual([AUTH_IDENTITY_LOCK_NAME, AUTH_IDENTITY_LOCK_NAME])

    removeLock()
    installReentryLock()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })))
    await expect(withAuthIdentityLock(
      () => renewManagedContinuousSessionUnlocked(),
      { failClosed: true },
    )).resolves.toEqual({ ok: true })
    await expect(withAuthIdentityLock(
      () => renewManagedContinuousSession(),
      { failClosed: true },
    )).rejects.toThrow('recursive lock')
  })

  it('does not renew an ordinary bearer, a snapshot, or an ordinary continuity session', async () => {
    installQueueLock()
    localStorage.setItem('auth_token', 'ordinary-bearer')
    localStorage.setItem('user_permissions', '["plm:read"]')
    installManagedDescriptor(descriptor())
    const ordinary = vi.fn(async (url: string) => {
      if (String(url).includes('/api/auth/me')) {
        return new Response(JSON.stringify({
          success: true,
          data: { user: { id: 'ordinary-person', role: 'user', permissions: [] } },
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', ordinary)
    expect((await useAuth().bootstrapSession()).ok).toBe(true)
    expect(ordinary.mock.calls.some((call) => String(call[0]).includes(RENEW_PATH))).toBe(false)
    expect(ordinary.mock.calls.some((call) => String(call[0]).includes('/api/auth/dev-token'))).toBe(false)

    resetOrdinaryWriter()
    installQueueLock()
    clearManagedDescriptor()
    setManagedProbeMarker()
    installManagedDescriptor({
      mode: 'managed-cookie',
      userId: 'person-a',
      tenantId: 'tenant-a',
      sessionId: 'session-snapshot',
      revision: 1,
      expiresAt: future(30_000),
    })
    const snapshotFetch = vi.fn(async () => new Response(JSON.stringify(currentBody({
      mode: 'managed-cookie',
      userId: 'person-a',
      tenantId: 'tenant-a',
      sessionId: 'session-snapshot',
      revision: 1,
      expiresAt: future(30_000),
    })), { status: 200 }))
    vi.stubGlobal('fetch', snapshotFetch)
    expect((await useAuth().bootstrapSession(true)).ok).toBe(true)
    expect(snapshotFetch).toHaveBeenCalledTimes(1)
    expect(String(snapshotFetch.mock.calls[0][0])).toContain('/api/plm/managed-login/current')

    resetOrdinaryWriter()
    installQueueLock()
    clearManagedDescriptor()
    installManagedDescriptor(descriptor({
      continuityMode: 'ordinary',
      credentialGeneration: null,
      expiresAt: future(30_000),
    }))
    const ordinaryContinuity = vi.fn(async () => new Response(JSON.stringify(currentBody(descriptor({
      continuityMode: 'ordinary',
      credentialGeneration: null,
      expiresAt: future(60_000),
    }))), { status: 200 }))
    vi.stubGlobal('fetch', ordinaryContinuity)
    expect((await useAuth().bootstrapSession(true)).ok).toBe(true)
    expect(ordinaryContinuity).toHaveBeenCalledTimes(1)
    expect(String(ordinaryContinuity.mock.calls[0][0])).toContain('/current')
    expect(readManagedDescriptor()?.continuityMode).toBe('ordinary')
  })

  it('renews a near-expiry continuous descriptor before current and installs only the retried snapshot', async () => {
    installQueueLock()
    setManagedProbeMarker()
    installManagedDescriptor(descriptor())
    const successor = descriptor({ sessionId: 'session-next', credentialGeneration: 1, expiresAt: future(600_000) })
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(String(url))
      if (String(url).includes(RENEW_PATH)) {
        expect(headerRecord(init).authorization).toBeUndefined()
        expect(headerRecord(init).Authorization).toBeUndefined()
        expect(headerRecord(init)['x-metasheet-managed-bridge']).toBe('renew-recovery')
        expect(init?.body).toBe('{}')
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response(JSON.stringify(currentBody(successor)), { status: 200 })
    }))
    expect((await useAuth().bootstrapSession()).ok).toBe(true)
    expect(calls.map((url) => url.includes(RENEW_PATH) ? 'renew' : 'current')).toEqual(['renew', 'current'])
    expect(readManagedDescriptor()).toMatchObject({
      sessionId: 'session-next',
      revision: 4,
      continuityMode: 'continuous',
      credentialGeneration: 1,
    })
    expect(localStorage.getItem('devToken')).toBeNull()
    expect(localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY)).toBeNull()
  })

  it('recovers a rotated predecessor once and does not install a 409, malformed, or lost transport', async () => {
    installQueueLock()
    setManagedProbeMarker()
    installManagedDescriptor(descriptor({ expiresAt: future(600_000) }))
    const successor = descriptor({ sessionId: 'session-successor', credentialGeneration: 1, expiresAt: future(600_000) })
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      if (String(url).includes('/current') && calls.filter((item) => item.includes('/current')).length === 1) {
        return new Response(JSON.stringify({ success: false }), { status: 401 })
      }
      if (String(url).includes(RENEW_PATH)) return new Response(JSON.stringify({ ok: true }), { status: 200 })
      if (String(url).includes('/current')) return new Response(JSON.stringify(currentBody(successor)), { status: 200 })
      return new Response('{}', { status: 404 })
    }))
    expect((await useAuth().bootstrapSession()).ok).toBe(true)
    expect(calls.map((url) => (url.includes(RENEW_PATH) ? 'renew' : 'current'))).toEqual(['current', 'renew', 'current'])
    expect(readManagedDescriptor()?.sessionId).toBe('session-successor')

    resetOrdinaryWriter()
    installQueueLock()
    clearManagedDescriptor()
    installManagedDescriptor(descriptor({ expiresAt: future(600_000) }))
    const conflictCalls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      conflictCalls.push(String(url))
      if (String(url).includes(RENEW_PATH)) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'PLM_MANAGED_RENEW_NOT_DUE', message: 'no' } }), { status: 409 })
      }
      return new Response(JSON.stringify({ success: false }), { status: 401 })
    }))
    expect((await useAuth().bootstrapSession(true)).ok).toBe(false)
    expect(conflictCalls.filter((url) => url.includes('/current'))).toHaveLength(1)
    expect(conflictCalls.filter((url) => url.includes(RENEW_PATH))).toHaveLength(1)
    expect(readManagedDescriptor()).toBeNull()
    expect(localStorage.getItem('devToken')).toBeNull()
    expect(localStorage.getItem('auth_token')).toBeNull()

    installManagedDescriptor(descriptor())
    const malformedCalls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      malformedCalls.push(String(url))
      if (String(url).includes('/logout')) return new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 })
      if (String(url).includes(RENEW_PATH)) return new Response(JSON.stringify({ ok: true, forged: true }), { status: 200 })
      return new Response(JSON.stringify(currentBody(successor)), { status: 200 })
    }))
    expect((await useAuth().bootstrapSession(true)).ok).toBe(false)
    expect(malformedCalls.some((url) => url.includes('/current'))).toBe(false)
    expect(malformedCalls.some((url) => url.includes('/logout'))).toBe(true)
    expect(readManagedDescriptor()).toBeNull()

    installManagedDescriptor(descriptor())
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('no response')
    }))
    expect((await useAuth().bootstrapSession(true)).ok).toBe(false)
    expect(readManagedDescriptor()?.sessionId).toBe('session-a')
    expect(localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY)).toBeNull()
    expect(localStorage.getItem(MANAGED_RENEWAL_PENDING_KEY)).not.toBeNull()
  })

  it('retries a lost renewal on the next same-session bootstrap using current authority', async () => {
    installQueueLock()
    setManagedProbeMarker()
    installManagedDescriptor(descriptor())
    const successor = descriptor({
      sessionId: 'session-next',
      credentialGeneration: 1,
      expiresAt: future(600_000),
    })
    let renew = 0
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      if (String(url).includes(RENEW_PATH)) {
        renew += 1
        if (renew === 1) throw new TypeError('owned lost response')
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response(JSON.stringify(currentBody(successor)), { status: 200 })
    }))
    expect((await useAuth().bootstrapSession(true)).ok).toBe(false)
    expect(localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY)).toBeNull()
    expect(readManagedDescriptor()?.sessionId).toBe('session-a')
    const second = await useAuth().bootstrapSession(true)
    expect(second.ok).toBe(true)
    expect(renew).toBe(2)
    expect(readManagedDescriptor()?.sessionId).toBe('session-next')
    expect(readManagedDescriptor()?.credentialGeneration).toBe(1)
    expect(localStorage.getItem(MANAGED_RENEWAL_PENDING_KEY)).toBeNull()
    expect(calls.some((url) => url.includes('/api/plm/managed-login/current'))).toBe(true)

    resetOrdinaryWriter()
    installQueueLock()
    setManagedProbeMarker()
    installManagedDescriptor(descriptor())
    localStorage.setItem(MANAGED_COMPLETE_PENDING_KEY, '1')
    const blocked = vi.fn()
    vi.stubGlobal('fetch', blocked)
    expect((await useAuth().bootstrapSession(true)).status).toBe(0)
    expect(blocked).not.toHaveBeenCalled()
    expect(readManagedDescriptor()?.sessionId).toBe('session-a')
  })

  it('does not install a lost renewal for another epoch, owner, or concurrent tab', async () => {
    installQueueLock()
    setManagedProbeMarker()
    installManagedDescriptor(descriptor())
    const successor = descriptor({
      sessionId: 'session-next',
      credentialGeneration: 1,
      expiresAt: future(600_000),
    })
    const lostThenSucceed = () => {
      let renew = 0
      return vi.fn(async (url: string) => {
        if (String(url).includes('/logout')) {
          return new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 })
        }
        if (String(url).includes(RENEW_PATH)) {
          renew += 1
          if (renew === 1) throw new TypeError('owned lost response')
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        return new Response(JSON.stringify(currentBody(successor)), { status: 200 })
      })
    }
    vi.stubGlobal('fetch', lostThenSucceed())
    expect((await useAuth().bootstrapSession(true)).ok).toBe(false)
    bumpManagedEpoch()
    const moved = await useAuth().bootstrapSession(true)
    expect(moved.ok).toBe(false)
    expect(readManagedDescriptor()?.sessionId).not.toBe('session-next')
    expect(localStorage.getItem(MANAGED_RENEWAL_PENDING_KEY)).toBeNull()

    resetOrdinaryWriter()
    installQueueLock()
    setManagedProbeMarker()
    installManagedDescriptor(descriptor())
    vi.stubGlobal('fetch', lostThenSucceed())
    expect((await useAuth().bootstrapSession(true)).ok).toBe(false)
    installManagedDescriptor(descriptor({ userId: 'person-b', sessionId: 'session-b', revision: 8 }))
    const otherOwner = await useAuth().bootstrapSession(true)
    expect(otherOwner.ok).toBe(false)
    expect(readManagedDescriptor()?.sessionId).not.toBe('session-next')

    resetOrdinaryWriter()
    installQueueLock()
    setManagedProbeMarker()
    installManagedDescriptor(descriptor())
    let release: (() => void) | null = null
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/logout')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 }))
      }
      if (String(url).includes(RENEW_PATH)) {
        if (!release) {
          return new Promise((_resolve, reject) => {
            release = () => reject(new TypeError('owned lost response'))
          })
        }
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      }
      return Promise.resolve(new Response(JSON.stringify(currentBody(successor)), { status: 200 }))
    }))
    const first = useAuth().bootstrapSession(true)
    const second = useAuth().bootstrapSession(true)
    await vi.waitFor(() => expect(release).not.toBeNull())
    bumpManagedEpoch()
    release!()
    const [left, right] = await Promise.all([first, second])
    expect(left.ok).toBe(false)
    expect(right.ok).toBe(false)
    expect(readManagedDescriptor()?.sessionId).not.toBe('session-next')
  })

  it('does not accept a reloaded or forged descriptor and does not loop after one recovery', async () => {
    installQueueLock()
    setManagedProbeMarker()
    localStorage.setItem('managedSession', JSON.stringify(descriptor()))
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    expect((await useAuth().bootstrapSession()).ok).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/current')
    expect(readManagedDescriptor()).toBeNull()
    expect(localStorage.getItem('devToken')).toBeNull()

    installManagedDescriptor(descriptor({ credentialGeneration: 7, expiresAt: future(30_000) }))
    const terminal = vi.fn(async () => new Response(JSON.stringify(currentBody(descriptor({
      credentialGeneration: 7,
      expiresAt: future(60_000),
    }))), { status: 200 }))
    vi.stubGlobal('fetch', terminal)
    expect((await useAuth().bootstrapSession(true)).ok).toBe(true)
    expect(terminal).toHaveBeenCalledTimes(1)
    expect(String(terminal.mock.calls[0][0])).toContain('/current')

    clearManagedDescriptor()
    installManagedDescriptor(descriptor({ expiresAt: future(600_000) }))
    let currentCount = 0
    const repeated = vi.fn(async (url: string) => {
      if (String(url).includes('/current')) {
        currentCount += 1
        return new Response(JSON.stringify({ success: false }), { status: 401 })
      }
      if (String(url).includes(RENEW_PATH)) return new Response(JSON.stringify({ ok: true }), { status: 200 })
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', repeated)
    expect((await useAuth().bootstrapSession(true)).ok).toBe(false)
    expect(currentCount).toBe(2)
    expect(repeated.mock.calls.filter((call) => String(call[0]).includes(RENEW_PATH))).toHaveLength(1)
    expect(readManagedDescriptor()).toBeNull()
  })
})
