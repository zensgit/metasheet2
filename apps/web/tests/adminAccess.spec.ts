import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  adminAccessCapabilitiesState,
  refreshAdminAccessCapabilities,
  resetAdminAccessCapabilities,
} from '../src/composables/adminAccessCapabilities'
import { useAuth } from '../src/composables/useAuth'
import { resolveAdminRouteRedirect } from '../src/router/adminAccess'

const platformAdminPaths = [
  '/admin/users',
  '/admin/directory',
  '/admin/roles',
  '/admin/permissions',
  '/admin/automation-executions',
  '/admin/audit',
  '/admin/plugins',
  '/approvals/metrics',
]

function routeWithMeta(meta: Record<string, unknown>): Parameters<typeof resolveAdminRouteRedirect>[0] {
  return { meta } as Parameters<typeof resolveAdminRouteRedirect>[0]
}

function routeBlock(source: string, path: string): string {
  const start = source.indexOf(`path: '${path}'`)
  expect(start, `Expected ${path} route to be registered`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n  {', start + 1)
  return source.slice(start, end === -1 ? undefined : end)
}

describe('admin route access', () => {
  it('marks platform-admin pages with requiresAdmin before their route components load', async () => {
    const source = await readFile('src/router/appRoutes.ts', 'utf8')

    for (const path of platformAdminPaths) {
      const block = routeBlock(source, path)
      expect(block, `${path} must require authentication`).toContain('requiresAuth: true')
      expect(block, `${path} must be route-gated`).toContain('requiresAdmin: true')
    }
  })

  it('keeps delegated role administration out of the platform-admin-only route list', async () => {
    const source = await readFile('src/router/appRoutes.ts', 'utf8')
    const block = routeBlock(source, '/admin/role-delegation')

    expect(block).toContain('requiresAuth: true')
    expect(block).not.toContain('requiresAdmin: true')
  })

  it('redirects non-admin users away from admin routes before rendering page shells', async () => {
    const loadProductFeatures = vi.fn().mockResolvedValue(undefined)
    const redirect = await resolveAdminRouteRedirect(
      routeWithMeta({ requiresAdmin: true }),
      { hasAdminAccess: () => false },
      {
        loadProductFeatures,
        resolveHomePath: () => '/attendance',
      },
    )

    expect(loadProductFeatures).toHaveBeenCalledTimes(1)
    expect(redirect).toBe('/attendance')
  })

  it('keeps the admin boundary closed when feature probing fails', async () => {
    const redirect = await resolveAdminRouteRedirect(
      routeWithMeta({ requiresAdmin: true }),
      { hasAdminAccess: () => false },
      {
        loadProductFeatures: vi.fn().mockRejectedValue(new Error('offline')),
        resolveHomePath: () => '/multitable',
      },
    )

    expect(redirect).toBe('/multitable')
  })

  it('allows admins and non-admin routes to continue normally', async () => {
    await expect(resolveAdminRouteRedirect(
      routeWithMeta({ requiresAdmin: true }),
      { hasAdminAccess: () => true },
      {
        loadProductFeatures: vi.fn(),
        resolveHomePath: () => '/multitable',
      },
    )).resolves.toBeNull()

    await expect(resolveAdminRouteRedirect(
      routeWithMeta({ requiresAuth: true }),
      { hasAdminAccess: () => false },
      {
        loadProductFeatures: vi.fn(),
        resolveHomePath: () => '/multitable',
      },
    )).resolves.toBeNull()
  })

  it('lets a supplied capability answer override the snapshot admin flag', async () => {
    const flags = {
      loadProductFeatures: vi.fn().mockResolvedValue(undefined),
      resolveHomePath: () => '/home',
    }

    await expect(resolveAdminRouteRedirect(
      routeWithMeta({ requiresAdmin: true }),
      { hasAdminAccess: () => true },
      flags,
      { isPlatformAdmin: false },
    )).resolves.toBe('/home')

    await expect(resolveAdminRouteRedirect(
      routeWithMeta({ requiresAdmin: true }),
      { hasAdminAccess: () => false },
      flags,
      { isPlatformAdmin: true },
    )).resolves.toBeNull()

    await expect(resolveAdminRouteRedirect(
      routeWithMeta({ requiresAdmin: true }),
      { hasAdminAccess: () => true },
      flags,
      null,
    )).resolves.toBe('/home')
  })
})

describe('admin access capabilities', () => {
  afterEach(() => {
    resetAdminAccessCapabilities()
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('publishes a well-formed capability payload', async () => {
    localStorage.setItem('jwt', 'session-token')
    localStorage.setItem('user_roles', JSON.stringify(['admin']))
    localStorage.setItem('user_permissions', JSON.stringify(['*:*', 'admin:all']))
    expect(useAuth().hasAdminAccess()).toBe(false)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { isPlatformAdmin: true, canManageScope: false, delegableNamespaces: ['attendance'] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(refreshAdminAccessCapabilities()).resolves.toEqual({
      isPlatformAdmin: true,
      canManageScope: false,
      canManagePermissions: false,
      delegableNamespaces: ['attendance'],
    })
    expect(adminAccessCapabilitiesState.canManagePermissions).toBe(false)
    expect(useAuth().hasAdminAccess()).toBe(true)
  })

  it('fails closed when the capability read errors, even if the snapshot says admin', async () => {
    localStorage.setItem('jwt', 'session-token')
    localStorage.setItem('user_roles', JSON.stringify(['admin']))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))

    await expect(refreshAdminAccessCapabilities()).resolves.toEqual({
      isPlatformAdmin: false,
      canManageScope: false,
      canManagePermissions: false,
      delegableNamespaces: [],
    })
    expect(adminAccessCapabilitiesState.loaded).toBe(true)
    expect(useAuth().hasAdminAccess()).toBe(false)
  })

  it('does not publish a grant that resolves after logout', async () => {
    localStorage.setItem('jwt', 'session-token')
    let release: (response: Response) => void = () => {}
    const pending = new Promise<Response>((resolve) => {
      release = resolve
    })
    vi.stubGlobal('fetch', vi.fn(() => pending))

    const reading = refreshAdminAccessCapabilities()
    useAuth().clearToken()
    release(new Response(JSON.stringify({
      ok: true,
      data: { isPlatformAdmin: true, canManageScope: true, delegableNamespaces: ['attendance'] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(reading).resolves.toEqual({
      isPlatformAdmin: false,
      canManageScope: false,
      canManagePermissions: false,
      delegableNamespaces: [],
    })
    expect(adminAccessCapabilitiesState.loaded).toBe(false)
    expect(adminAccessCapabilitiesState.isPlatformAdmin).toBe(false)
    expect(adminAccessCapabilitiesState.canManageScope).toBe(false)
  })

  it('reads the same token again so a demotion updates the route and the nav flags', async () => {
    localStorage.setItem('jwt', 'session-token')
    let granted = true
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: {
        isPlatformAdmin: granted,
        canManageScope: granted,
        canManagePermissions: granted,
        delegableNamespaces: granted ? ['attendance'] : [],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const flags = {
      loadProductFeatures: vi.fn().mockResolvedValue(undefined),
      resolveHomePath: () => '/home',
    }

    const first = await refreshAdminAccessCapabilities()
    expect(first.isPlatformAdmin).toBe(true)
    expect(useAuth().hasAdminAccess()).toBe(true)
    expect(adminAccessCapabilitiesState.canManagePermissions).toBe(true)
    await expect(resolveAdminRouteRedirect(
      routeWithMeta({ requiresAdmin: true }),
      useAuth(),
      flags,
      first,
    )).resolves.toBeNull()

    granted = false
    const second = await refreshAdminAccessCapabilities()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(second).toEqual({
      isPlatformAdmin: false,
      canManageScope: false,
      canManagePermissions: false,
      delegableNamespaces: [],
    })
    expect(adminAccessCapabilitiesState.loaded).toBe(true)
    expect(adminAccessCapabilitiesState.isPlatformAdmin).toBe(false)
    expect(adminAccessCapabilitiesState.canManageScope).toBe(false)
    expect(useAuth().hasAdminAccess()).toBe(false)
    await expect(resolveAdminRouteRedirect(
      routeWithMeta({ requiresAdmin: true }),
      useAuth(),
      flags,
      second,
    )).resolves.toBe('/home')

    granted = true
    window.dispatchEvent(new Event('focus'))
    for (let attempt = 0; attempt < 20 && !adminAccessCapabilitiesState.isPlatformAdmin; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(adminAccessCapabilitiesState.isPlatformAdmin).toBe(true)
    expect(useAuth().hasAdminAccess()).toBe(true)
  })

  it('shares one in-flight read and does not keep that answer for the next navigation', async () => {
    localStorage.setItem('jwt', 'session-token')
    let release: (response: Response) => void = () => {}
    const pending = new Promise<Response>((resolve) => {
      release = resolve
    })
    const fetchMock = vi.fn(() => pending)
    vi.stubGlobal('fetch', fetchMock)

    const first = refreshAdminAccessCapabilities()
    const second = refreshAdminAccessCapabilities()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    release(new Response(JSON.stringify({
      ok: true,
      data: { isPlatformAdmin: true, canManageScope: false, delegableNamespaces: [] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await expect(first).resolves.toMatchObject({ isPlatformAdmin: true })
    await expect(second).resolves.toMatchObject({ isPlatformAdmin: true })

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { isPlatformAdmin: false, canManageScope: true, delegableNamespaces: ['crm'] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    await expect(refreshAdminAccessCapabilities()).resolves.toMatchObject({
      isPlatformAdmin: false,
      canManageScope: true,
    })
    expect(adminAccessCapabilitiesState.canManageScope).toBe(true)
    expect(useAuth().hasAdminAccess()).toBe(false)
  })

  it('does not keep the previous identity visible while a swapped token read is still waiting', async () => {
    localStorage.setItem('jwt', 'token-a')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { isPlatformAdmin: true, canManageScope: true, canManagePermissions: true, delegableNamespaces: ['attendance'] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    await refreshAdminAccessCapabilities()
    expect(adminAccessCapabilitiesState.isPlatformAdmin).toBe(true)
    expect(adminAccessCapabilitiesState.canManageScope).toBe(true)

    let releaseOld: (response: Response) => void = () => {}
    const oldPending = new Promise<Response>((resolve) => {
      releaseOld = resolve
    })
    const fetchMock = vi.fn(() => oldPending)
    vi.stubGlobal('fetch', fetchMock)
    const staleRead = refreshAdminAccessCapabilities()
    expect(adminAccessCapabilitiesState.isPlatformAdmin).toBe(true)

    localStorage.setItem('jwt', 'token-b')
    expect(useAuth().hasAdminAccess()).toBe(false)
    expect(adminAccessCapabilitiesState.loaded).toBe(false)
    expect(adminAccessCapabilitiesState.isPlatformAdmin).toBe(false)
    expect(adminAccessCapabilitiesState.canManageScope).toBe(false)
    expect(adminAccessCapabilitiesState.canManagePermissions).toBe(false)

    let releaseNew: (response: Response) => void = () => {}
    const newPending = new Promise<Response>((resolve) => {
      releaseNew = resolve
    })
    fetchMock.mockImplementation(() => newPending)
    const nextRead = refreshAdminAccessCapabilities()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(adminAccessCapabilitiesState.isPlatformAdmin).toBe(false)
    expect(adminAccessCapabilitiesState.canManageScope).toBe(false)

    releaseOld(new Response(JSON.stringify({
      ok: true,
      data: { isPlatformAdmin: true, canManageScope: true, canManagePermissions: true, delegableNamespaces: ['attendance'] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await expect(staleRead).resolves.toEqual({
      isPlatformAdmin: false,
      canManageScope: false,
      canManagePermissions: false,
      delegableNamespaces: [],
    })
    expect(adminAccessCapabilitiesState.isPlatformAdmin).toBe(false)
    expect(adminAccessCapabilitiesState.canManageScope).toBe(false)
    expect(useAuth().hasAdminAccess()).toBe(false)

    releaseNew(new Response(JSON.stringify({
      ok: true,
      data: { isPlatformAdmin: false, canManageScope: true, canManagePermissions: false, delegableNamespaces: ['crm'] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    await expect(nextRead).resolves.toMatchObject({ isPlatformAdmin: false, canManageScope: true })
    expect(adminAccessCapabilitiesState.canManageScope).toBe(true)
    expect(useAuth().hasAdminAccess()).toBe(false)
  })
})
