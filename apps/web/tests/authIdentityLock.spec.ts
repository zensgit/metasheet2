import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MANAGED_COMPLETE_PENDING_KEY,
  MANAGED_RENEWAL_PENDING_KEY,
  syncMutationOpen,
  withAuthIdentityLock,
} from '../src/composables/authIdentityLock'
import { clearManagedDescriptor, clearManagedProbeMarker, readManagedDescriptor } from '../src/composables/authPrincipal'
import { useAuth } from '../src/composables/useAuth'
import { useFeatureFlags } from '../src/stores/featureFlags'
import {
  completeManagedBrowserBridge,
  logoutManagedBrowserBridge,
  startManagedBrowserBridge,
} from '../src/services/plm/plmManagedCompanion'
import { apiFetch, clearStoredAuthState } from '../src/utils/api'
import { useSessionOrg } from '../src/composables/useSessionOrg'
import { effectScope } from 'vue'

const ENTRY = '?issuer=http://127.0.0.1:9/installation&tenant_id=default&org_id=fixture-org&client_id=managed-fixture&root_part_id=part&native_subject_hint=42'
const DESTINATION = '/plm/bom-review?managed=ready'

function installQueueLock(): { held: () => number; waiting: () => number } {
  let tail = Promise.resolve()
  let held = 0
  let waiting = 0
  const request = (_name: string, optionsOrCallback: unknown, maybeCallback?: unknown) => {
    const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as () => unknown
    waiting += 1
    const run = tail.then(async () => {
      waiting -= 1
      held += 1
      try {
        return await callback()
      } finally {
        held -= 1
      }
    })
    tail = run.then(() => undefined, () => undefined)
    return run
  }
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
  return { held: () => held, waiting: () => waiting }
}

function holdQueue(): { release: () => void; done: Promise<unknown> } {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const done = withAuthIdentityLock(() => gate, { failClosed: true })
  return { release, done }
}

function mockLocation(replace: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      pathname: '/attendance',
      search: '',
      hash: '',
      origin: 'http://localhost:3000',
      href: 'http://localhost:3000/attendance',
      replace,
    },
  })
}

function removeQueueLock(): void {
  Reflect.deleteProperty(navigator, 'locks')
}

function jwt(org: string): string {
  const body = btoa(JSON.stringify({ userId: 'actor', tenantId: org, exp: Math.floor(Date.now() / 1000) + 3600 }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `header.${body}.signature`
}

describe('auth identity lock', () => {
  afterEach(() => {
    removeQueueLock()
    clearManagedProbeMarker()
    clearManagedDescriptor()
    localStorage.removeItem(MANAGED_COMPLETE_PENDING_KEY)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    window.history.replaceState(null, '', '/')
    try {
      useAuth().clearToken()
    } catch {
      localStorage.removeItem('auth_token')
      localStorage.removeItem('jwt')
      localStorage.removeItem('devToken')
    }
  })

  it('does not post complete or start when the lock manager is missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(startManagedBrowserBridge(ENTRY)).rejects.toThrow('AUTH_IDENTITY_LOCK_UNAVAILABLE')
    await expect(completeManagedBrowserBridge('code', 'state')).rejects.toThrow('AUTH_IDENTITY_LOCK_UNAVAILABLE')
    await expect(logoutManagedBrowserBridge()).rejects.toThrow('AUTH_IDENTITY_LOCK_UNAVAILABLE')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(localStorage.getItem('metasheet_managed_probe')).toBeNull()
    expect(localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY)).toBeNull()
  })

  it('still writes an ordinary token when no managed history and no lock manager exist', () => {
    useAuth().setToken('ordinary-token')
    expect(localStorage.getItem('auth_token')).toBe('ordinary-token')
    expect(localStorage.getItem('jwt')).toBe('ordinary-token')
  })

  it('refuses a bare writer while a lock manager or managed history exists', async () => {
    localStorage.setItem('auth_token', 'kept')
    localStorage.setItem('jwt', 'kept')
    installQueueLock()
    expect(() => useAuth().setToken('next')).toThrow('AUTH_IDENTITY_LOCK_REQUIRED')
    expect(() => useAuth().clearToken()).toThrow('AUTH_IDENTITY_LOCK_REQUIRED')
    expect(() => useAuth().setExplicitSessionOrg(jwt('org-b'), 'org-b', 'kept')).toThrow('AUTH_IDENTITY_LOCK_REQUIRED')
    expect(() => clearStoredAuthState()).toThrow('AUTH_IDENTITY_LOCK_REQUIRED')
    expect(localStorage.getItem('auth_token')).toBe('kept')
    removeQueueLock()
    localStorage.setItem('metasheet_managed_probe', '1')
    expect(() => useAuth().setToken('next')).toThrow('AUTH_IDENTITY_LOCK_REQUIRED')
    expect(localStorage.getItem('auth_token')).toBe('kept')
  })

  it('revokes managed history before an ordinary publish and aborts the publish when revoke fails', async () => {
    localStorage.setItem('metasheet_managed_probe', '1')
    localStorage.setItem('auth_token', 'ordinary-a')
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: { code: 'DOWN' } }), { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(useAuth().commitOrdinaryAuthTransition(() => {
      useAuth().setToken('ordinary-b')
    })).rejects.toThrow('DOWN')
    expect(localStorage.getItem('auth_token')).toBe('ordinary-a')
    expect(localStorage.getItem('metasheet_managed_probe')).toBe('1')
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/plm/managed-login/logout')

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 }))
    await useAuth().commitOrdinaryAuthTransition(() => {
      useAuth().setToken('ordinary-b')
    })
    expect(localStorage.getItem('auth_token')).toBe('ordinary-b')
    expect(localStorage.getItem('metasheet_managed_probe')).toBeNull()
    expect(readManagedDescriptor()).toBeNull()
  })

  it('queues a same-tab publish behind complete and keeps the sync guard closed while complete awaits', async () => {
    const locks = installQueueLock()
    let release: (response: Response) => void = () => undefined
    let depthWhileCompleteAwaited = -1
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes('/logout')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 }))
      }
      depthWhileCompleteAwaited = syncMutationOpen() ? 1 : 0
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const complete = completeManagedBrowserBridge('code', 'state')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(depthWhileCompleteAwaited).toBe(0)
    expect(syncMutationOpen()).toBe(false)
    expect(locks.held()).toBe(1)
    let wrote = false
    const publish = useAuth().commitOrdinaryAuthTransition(() => {
      wrote = true
      useAuth().setToken('header.person-b.signature')
    })
    await Promise.resolve()
    expect(wrote).toBe(false)
    expect(() => useAuth().setToken('bare')).toThrow('AUTH_IDENTITY_LOCK_REQUIRED')
    expect(localStorage.getItem('auth_token')).toBeNull()
    release(new Response(JSON.stringify({ ok: true, destination: DESTINATION }), { status: 200 }))
    await expect(complete).resolves.toEqual({ destination: DESTINATION, stale: false })
    await publish
    expect(wrote).toBe(true)
    expect(localStorage.getItem('auth_token')).toBe('header.person-b.signature')
    expect(localStorage.getItem('metasheet_managed_probe')).toBeNull()
    expect(localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY)).toBeNull()
  })

  it('runs a second same-tab waiter only after the first transition releases the lock', async () => {
    installQueueLock()
    localStorage.setItem('metasheet_managed_probe', '1')
    let releaseLogout: ((response: Response) => void) | null = null
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/logout')) {
        return new Promise<Response>((resolve) => {
          releaseLogout = resolve
        })
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    }))
    const first = useAuth().commitOrdinaryAuthTransition(() => {
      useAuth().setToken('first-token')
    })
    await vi.waitFor(() => expect(releaseLogout).not.toBeNull())
    let secondWrote = false
    const second = useAuth().commitOrdinaryAuthTransition(() => {
      secondWrote = true
      useAuth().setToken('second-token')
    })
    await Promise.resolve()
    expect(secondWrote).toBe(false)
    expect(localStorage.getItem('auth_token')).toBeNull()
    expect(syncMutationOpen()).toBe(false)
    releaseLogout!(new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 }))
    await first
    await second
    expect(localStorage.getItem('auth_token')).toBe('second-token')
    expect(localStorage.getItem('metasheet_managed_probe')).toBeNull()
  })

  it('adopts a stable complete and compensates drift, unread bodies, and network loss differently', async () => {
    installQueueLock()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, destination: DESTINATION }), { status: 200 }))
    await expect(completeManagedBrowserBridge('code', 'state')).resolves.toEqual({ destination: DESTINATION, stale: false })
    expect(localStorage.getItem('metasheet_managed_probe')).toBe('1')
    expect(localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY)).toBeNull()

    clearManagedProbeMarker()
    localStorage.setItem('auth_token', 'person-b')
    fetchMock.mockImplementationOnce(async () => {
      localStorage.setItem('auth_token', 'person-c')
      return new Response(JSON.stringify({ ok: true, destination: DESTINATION }), { status: 200 })
    })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 }))
    await expect(completeManagedBrowserBridge('code', 'state')).resolves.toEqual({ destination: '', stale: true })
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('/logout')
    expect(localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY)).toBeNull()

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ok: false,
      error: { code: 'PLM_MANAGED_PERSON_CONFLICT' },
    }), { status: 409 }))
    await expect(completeManagedBrowserBridge('code', 'state')).rejects.toThrow('PLM_MANAGED_PERSON_CONFLICT')
    expect(localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY)).toBeNull()
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/logout'))).toHaveLength(1)

    fetchMock.mockResolvedValueOnce(new Response('not-json', { status: 200 }))
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 }))
    await expect(completeManagedBrowserBridge('code', 'state')).resolves.toEqual({ destination: '', stale: true })

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(completeManagedBrowserBridge('code', 'state')).rejects.toThrow('Failed to fetch')
    expect(localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY)).toBe('1')
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/logout'))).toHaveLength(2)
  })

  it('refuses the complete POST when the pending marker cannot be stored', async () => {
    installQueueLock()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const setItem = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key === MANAGED_COMPLETE_PENDING_KEY) throw new Error('quota')
      return setItem(key, value)
    })
    await expect(completeManagedBrowserBridge('code', 'state')).rejects.toThrow('AUTH_IDENTITY_PENDING_STORAGE')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY)).toBeNull()
  })

  it('writes devToken in the same synchronous mutation as the ordinary token', async () => {
    const writes: string[] = []
    let microtask = false
    const setItem = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key === 'auth_token') queueMicrotask(() => { microtask = true })
      writes.push(`${key}:${microtask ? 'later' : 'same-turn'}`)
      return setItem(key, value)
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ token: 'dev-jwt-token' }), { status: 200 })))
    await expect(useAuth().refreshDevToken()).resolves.toBe('dev-jwt-token')
    expect(localStorage.getItem('devToken')).toBe('dev-jwt-token')
    expect(localStorage.getItem('auth_token')).toBe('dev-jwt-token')
    const devWrite = writes.find((entry) => entry.startsWith('devToken:'))
    expect(devWrite).toBe('devToken:same-turn')
  })

  it('does not install a dev identity while managed history is visible', async () => {
    localStorage.setItem('metasheet_managed_probe', '1')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(useAuth().refreshDevToken()).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(useAuth().buildAuthHeaders()['x-user-id']).toBeUndefined()
    clearManagedProbeMarker()
    localStorage.setItem(MANAGED_COMPLETE_PENDING_KEY, '1')
    expect(useAuth().buildAuthHeaders()['x-user-id']).toBeUndefined()
    await expect(useAuth().ensureToken()).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('restores the explicit-session keys with no await when install fails inside the lock', async () => {
    installQueueLock()
    const auth = useAuth()
    const current = jwt('org-a')
    const next = jwt('org-b')
    await auth.commitOrdinaryAuthTransition(() => { auth.setToken(current) })
    const setItem = localStorage.setItem.bind(localStorage)
    let failed = false
    vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (!failed && key === 'jwt' && value === next) {
        failed = true
        throw new Error('jwt failed')
      }
      return setItem(key, value)
    })
    await expect(auth.commitExplicitSessionOrg(next, 'org-b', current)).resolves.toBe(false)
    expect(localStorage.getItem('auth_token')).toBe(current)
    expect(localStorage.getItem('jwt')).toBe(current)
    expect(localStorage.getItem('metasheet.explicitSessionOrg.v1')).toBeNull()
  })

  it('does not redirect a 401 when managed revoke fails', async () => {
    const replace = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        pathname: '/attendance',
        search: '',
        hash: '',
        origin: 'http://localhost:3000',
        href: 'http://localhost:3000/attendance',
        replace,
      },
    })
    localStorage.setItem('metasheet_managed_probe', '1')
    localStorage.setItem('auth_token', 'person-b')
    localStorage.setItem('jwt', 'person-b')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/plm/managed-login/logout')) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'REVOKE_DOWN' } }), { status: 503 })
      }
      return new Response('{}', { status: 401 })
    }))
    await apiFetch('/api/attendance/records')
    expect(replace).not.toHaveBeenCalled()
    expect(localStorage.getItem('auth_token')).toBe('person-b')
    expect(localStorage.getItem('metasheet_managed_probe')).toBe('1')
  })

  it('does not let a 401 queued behind B clear or redirect B', async () => {
    const locks = installQueueLock()
    localStorage.setItem('auth_token', 'person-a')
    localStorage.setItem('jwt', 'person-a')
    const held = holdQueue()
    await vi.waitFor(() => expect(locks.held()).toBe(1))
    const publishB = useAuth().commitOrdinaryAuthTransition(() => {
      useAuth().setToken('person-b')
    })
    await vi.waitFor(() => expect(locks.waiting()).toBe(1))
    const replace = vi.fn()
    mockLocation(replace)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    const stale = apiFetch('/api/attendance/records')
    await vi.waitFor(() => expect(locks.waiting()).toBe(2))
    held.release()
    await held.done
    await publishB
    await stale
    expect(localStorage.getItem('auth_token')).toBe('person-b')
    expect(localStorage.getItem('jwt')).toBe('person-b')
    expect(replace).not.toHaveBeenCalled()
  })

  it('does not let a queued bootstrap 401 clear B or cache the failure', async () => {
    const locks = installQueueLock()
    localStorage.setItem('auth_token', 'person-a')
    localStorage.setItem('jwt', 'person-a')
    const held = holdQueue()
    await vi.waitFor(() => expect(locks.held()).toBe(1))
    const publishB = useAuth().commitOrdinaryAuthTransition(() => {
      useAuth().setToken('person-b')
    })
    await vi.waitFor(() => expect(locks.waiting()).toBe(1))
    let meCalls = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/auth/dev-token')) return new Response('{}', { status: 404 })
      if (String(url).includes('/api/auth/me')) {
        meCalls += 1
        if (meCalls === 1) return new Response(JSON.stringify({ success: false }), { status: 401 })
        return new Response(JSON.stringify({
          success: true,
          data: { user: { id: 'b', role: 'user', permissions: [] } },
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const first = useAuth().bootstrapSession(true)
    await vi.waitFor(() => expect(locks.waiting()).toBe(2))
    held.release()
    await held.done
    await publishB
    await expect(first).resolves.toMatchObject({ ok: false, status: 0 })
    expect(localStorage.getItem('auth_token')).toBe('person-b')
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/logout'))).toHaveLength(0)
    const second = await useAuth().bootstrapSession()
    expect(second.ok).toBe(true)
    expect(localStorage.getItem('auth_token')).toBe('person-b')
    expect(meCalls).toBe(2)
  })

  it('does not let a late dev token overwrite an ordinary login queued ahead of it', async () => {
    const locks = installQueueLock()
    const held = holdQueue()
    await vi.waitFor(() => expect(locks.held()).toBe(1))
    let releaseDev: ((response: Response) => void) | null = null
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/api/auth/dev-token')) {
        return new Promise<Response>((resolve) => {
          releaseDev = resolve
        })
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    }))
    const pending = useAuth().refreshDevToken()
    await vi.waitFor(() => expect(releaseDev).not.toBeNull())
    const publishB = useAuth().commitOrdinaryAuthTransition(() => {
      useAuth().setToken('person-b')
    })
    await vi.waitFor(() => expect(locks.waiting()).toBe(1))
    releaseDev!(new Response(JSON.stringify({ token: 'dev-late' }), { status: 200 }))
    await vi.waitFor(() => expect(locks.waiting()).toBe(2))
    held.release()
    await held.done
    await publishB
    await expect(pending).resolves.toBeNull()
    expect(localStorage.getItem('auth_token')).toBe('person-b')
    expect(localStorage.getItem('jwt')).toBe('person-b')
    expect(localStorage.getItem('devToken')).toBeNull()
  })

  it('clears an ordinary session on 401 after the transition settles', async () => {
    const locks = installQueueLock()
    const held = holdQueue()
    await vi.waitFor(() => expect(locks.held()).toBe(1))
    const replace = vi.fn()
    mockLocation(replace)
    localStorage.setItem('auth_token', 'expired')
    localStorage.setItem('jwt', 'expired')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    const pending = apiFetch('/api/attendance/records')
    await vi.waitFor(() => expect(locks.waiting()).toBe(1))
    held.release()
    await held.done
    await pending
    expect(localStorage.getItem('auth_token')).toBeNull()
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('recovers a crashed pending complete by revoking before the next ordinary publish', async () => {
    localStorage.setItem(MANAGED_COMPLETE_PENDING_KEY, '1')
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/current')) return new Response('{}', { status: 200 })
      if (String(url).includes('/logout')) return new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 })
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const probed = await useAuth().bootstrapSession()
    expect(probed.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    await useAuth().commitOrdinaryAuthTransition(() => {
      useAuth().setToken('ordinary-b')
    })
    expect(String(fetchMock.mock.calls[0][0])).toContain('/logout')
    expect(localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY)).toBeNull()
    expect(localStorage.getItem('auth_token')).toBe('ordinary-b')
  })

  it('revokes before ordinary publish while a lost renewal is pending', async () => {
    localStorage.setItem(MANAGED_RENEWAL_PENDING_KEY, JSON.stringify({
      userId: 'person-a',
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      revision: 4,
      epoch: 1,
      token: null,
    }))
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/logout')) return new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 })
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    await useAuth().commitOrdinaryAuthTransition(() => {
      useAuth().setToken('ordinary-c')
    })
    expect(String(fetchMock.mock.calls[0][0])).toContain('/logout')
    expect(localStorage.getItem(MANAGED_RENEWAL_PENDING_KEY)).toBeNull()
    expect(localStorage.getItem(MANAGED_COMPLETE_PENDING_KEY)).toBeNull()
    expect(localStorage.getItem('auth_token')).toBe('ordinary-c')
  })

  it('does not probe a managed cookie while a pending complete is still unmarked', async () => {
    localStorage.setItem('metasheet_managed_probe', '1')
    localStorage.setItem(MANAGED_COMPLETE_PENDING_KEY, '1')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const probed = await useAuth().bootstrapSession()
    expect(probed.status).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readManagedDescriptor()).toBeNull()
  })

  it('does not apply an org switch whose token changed during managed revoke', async () => {
    installQueueLock()
    const scope = effectScope()
    const current = jwt('org-a')
    await useAuth().commitOrdinaryAuthTransition(() => { useAuth().setToken(current) })
    localStorage.setItem('metasheet_managed_probe', '1')
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      if (String(url).includes('/api/plm/managed-login/logout')) {
        localStorage.setItem('auth_token', 'someone-else')
        localStorage.setItem('jwt', 'someone-else')
        return new Response(JSON.stringify({ ok: true, revoked: true }), { status: 200 })
      }
      if (String(url).includes('/api/auth/session-org')) {
        return new Response(JSON.stringify({
          success: true,
          data: { token: jwt('org-b'), currentOrgId: 'org-b' },
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }))
    const state = scope.run(() => useSessionOrg())!
    expect(await state.switchSessionOrg('org-b')).toBe(false)
    expect(calls.some((url) => url.includes('/logout'))).toBe(true)
    expect(localStorage.getItem('auth_token')).toBe('someone-else')
    expect(localStorage.getItem('metasheet_managed_probe')).toBeNull()
    scope.stop()
  })

  it('drops a late feature payload after the principal changes', async () => {
    useAuth().setToken(jwt('org-a'))
    let release: ((response: Response) => void) | null = null
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/api/auth/me')) {
        return new Promise<Response>((resolve) => { release = resolve })
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    }))
    const flags = useFeatureFlags()
    const loading = flags.loadProductFeatures(true)
    await vi.waitFor(() => expect(release).not.toBeNull())
    useAuth().setToken(jwt('org-b'))
    release!(new Response(JSON.stringify({
      success: true,
      data: {
        user: { id: 'actor', tenantId: 'org-a', role: 'user', permissions: [] },
        features: { plm: true, attendance: false, workflow: false },
      },
    }), { status: 200 }))
    const features = await loading
    expect(useAuth().getToken()).toBe(jwt('org-b'))
    expect(features.plm).toBe(false)
  })
})
