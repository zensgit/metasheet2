/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Drives the router.beforeEach installed by src/main.ts. Route components are
 * replaced at createRouter so a view setup failure cannot impersonate the guard.
 * Feature load, guard context, and guard policy throws are injected around the
 * real catch.
 */
const cap = vi.hoisted(() => ({
  router: null as import('vue-router').Router | null,
}))

const fault = vi.hoisted(() => ({
  stage: null as null | 'feature' | 'context' | 'policy',
}))

const published = vi.hoisted(() => ({
  isPlatformAdmin: true,
  canManageScope: true,
  canManagePermissions: true,
}))

const seen = vi.hoisted(() => ({
  inputs: [] as Array<{ path: string; name?: string; matchedNames?: readonly string[] }>,
}))

const live = vi.hoisted(() => ({
  policy: null as typeof import('../src/router/guardPolicy') | null,
}))

vi.mock('element-plus', () => ({ default: { install() {} } }))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    createRouter: (options: Parameters<typeof actual.createRouter>[0]) => {
      const routes = (options.routes ?? []).map((route) => ({
        ...route,
        component: { render: () => null },
      }))
      const router = actual.createRouter({ ...options, routes })
      cap.router = router
      return router
    },
  }
})

vi.mock('../src/stores/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/stores/featureFlags')>()
  return {
    ...actual,
    useFeatureFlags: () => {
      const flags = actual.useFeatureFlags()
      return {
        ...flags,
        loadProductFeatures: () => {
          if (fault.stage === 'feature') return Promise.reject(new Error('feature load failed'))
          return flags.loadProductFeatures()
        },
      }
    },
  }
})

vi.mock('../src/router/guardPolicy', async (importOriginal) => {
  const initial = await importOriginal<typeof import('../src/router/guardPolicy')>()
  live.policy = initial
  const current = () => live.policy ?? initial
  return {
    ...initial,
    buildRouteGuardInput: (to: Parameters<typeof initial.buildRouteGuardInput>[0]) => {
      const input = current().buildRouteGuardInput(to)
      seen.inputs.push(input)
      return input
    },
    buildRouteGuardContext: (deps: Parameters<typeof initial.buildRouteGuardContext>[0]) => {
      if (fault.stage === 'context') throw new Error('guard context failed')
      return current().buildRouteGuardContext(deps)
    },
    resolveRouteGuardDecision: (
      input: Parameters<typeof initial.resolveRouteGuardDecision>[0],
      ctx: Parameters<typeof initial.resolveRouteGuardDecision>[1],
    ) => {
      if (fault.stage === 'policy') throw new Error('guard policy failed')
      return current().resolveRouteGuardDecision(input, ctx)
    },
  }
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const ROLE_DELEGATION_VARIANTS = ['/admin/role-delegation/', '/ADMIN/ROLE-DELEGATION'] as const
const PERMISSION_VARIANTS = ['/admin/permissions/', '/ADMIN/PERMISSIONS'] as const

function expectResolvedName(
  router: import('vue-router').Router,
  path: string,
  name: 'role-delegation' | 'permission-management',
) {
  const resolved = router.resolve(path)
  expect(resolved.name).toBe(name)
  expect(resolved.matched.some((record) => record.name === name)).toBe(true)
  expect(resolved.path).toBe(path)
}

function expectGuardSawName(
  path: string,
  name: 'role-delegation' | 'permission-management',
) {
  const input = seen.inputs.find((item) => item.path === path)
  expect(input?.name).toBe(name)
  expect(input?.matchedNames).toContain(name)
}

async function boot() {
  vi.resetModules()
  cap.router = null
  seen.inputs = []
  live.policy = await vi.importActual<typeof import('../src/router/guardPolicy')>('../src/router/guardPolicy')
  window.history.replaceState({}, '', '/settings')
  window.localStorage.clear()
  window.localStorage.setItem('auth_token', 'session-token')
  window.localStorage.setItem('jwt', 'session-token')
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    requests.push(url)
    if (url.includes('/api/auth/me')) {
      return jsonResponse({
        user: {
          id: 'user-1',
          email: 'user-1@example.test',
          role: 'user',
          roles: ['user'],
          permissions: [],
        },
      })
    }
    if (url.includes('/api/admin/access-capabilities')) {
      return jsonResponse({
        ok: true,
        data: {
          isPlatformAdmin: published.isPlatformAdmin,
          canManageScope: published.canManageScope,
          canManagePermissions: published.canManagePermissions,
          delegableNamespaces: [],
        },
      })
    }
    return jsonResponse({ data: [] })
  }))
  await import('../src/main')
  const { createApp } = await import('vue')
  const { adminAccessCapabilitiesState } = await import('../src/composables/adminAccessCapabilities')
  const router = cap.router
  if (!router) throw new Error('main.ts did not install router.beforeEach')
  const app = createApp({ render: () => null })
  app.use(router)
  const ready = await Promise.race([
    router.isReady().then(() => 'ready' as const),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1500)),
  ])
  if (ready === 'timeout') {
    throw new Error(`router.isReady hung at ${router.currentRoute.value.fullPath}; fetch: ${requests.join(' | ') || 'none'}`)
  }
  return { router, adminAccessCapabilitiesState, requests }
}

async function go(router: import('vue-router').Router, path: string, requests: string[]) {
  const result = await Promise.race([
    router.push(path).then(() => 'pushed' as const),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1500)),
  ])
  if (result === 'timeout') {
    throw new Error(`push ${path} hung at ${router.currentRoute.value.fullPath}; fetch: ${requests.join(' | ') || 'none'}`)
  }
}

describe('installed management route guard fails closed', () => {
  afterEach(() => {
    fault.stage = null
    published.isPlatformAdmin = true
    published.canManageScope = true
    published.canManagePermissions = true
    seen.inputs = []
    window.localStorage.clear()
    vi.unstubAllGlobals()
  })

  it.each(['feature', 'context', 'policy'] as const)(
    'denies the two management routes when %s throws and still opens settings',
    async (stage) => {
      const { router, adminAccessCapabilitiesState, requests } = await boot()
      fault.stage = stage

      await go(router, '/admin/role-delegation', requests)
      expect(adminAccessCapabilitiesState.loaded).toBe(true)
      expect(adminAccessCapabilitiesState.canManageScope).toBe(true)
      expect(router.currentRoute.value.path).toBe('/home')

      await go(router, '/admin/permissions', requests)
      expect(adminAccessCapabilitiesState.isPlatformAdmin).toBe(true)
      expect(adminAccessCapabilitiesState.canManagePermissions).toBe(true)
      expect(router.currentRoute.value.path).toBe('/home')

      for (const path of ROLE_DELEGATION_VARIANTS) {
        expectResolvedName(router, path, 'role-delegation')
        await go(router, path, requests)
        expect(adminAccessCapabilitiesState.canManageScope).toBe(true)
        expect(router.currentRoute.value.path).toBe('/home')
        if (stage !== 'feature') expectGuardSawName(path, 'role-delegation')
      }

      for (const path of PERMISSION_VARIANTS) {
        expectResolvedName(router, path, 'permission-management')
        await go(router, path, requests)
        expect(adminAccessCapabilitiesState.isPlatformAdmin).toBe(true)
        expect(adminAccessCapabilitiesState.canManagePermissions).toBe(true)
        expect(router.currentRoute.value.path).toBe('/home')
        if (stage !== 'feature') expectGuardSawName(path, 'permission-management')
      }

      await go(router, '/settings', requests)
      expect(router.currentRoute.value.path).toBe('/settings')

      for (const path of ['/admin/role-delegation/extra', '/admin/permissions/extra'] as const) {
        const resolved = router.resolve(path)
        expect(resolved.name).not.toBe('role-delegation')
        expect(resolved.name).not.toBe('permission-management')
        expect(resolved.matched.some((record) => record.name === 'role-delegation' || record.name === 'permission-management')).toBe(false)
        await go(router, path, requests)
        expect(router.currentRoute.value.path).not.toBe('/home')
        expect(router.currentRoute.value.name).not.toBe('role-delegation')
        expect(router.currentRoute.value.name).not.toBe('permission-management')
      }
    },
    20000,
  )

  it('still enters both management routes when the policy allows them', async () => {
    const { router, adminAccessCapabilitiesState, requests } = await boot()
    fault.stage = null

    for (const path of ['/admin/role-delegation', ...ROLE_DELEGATION_VARIANTS]) {
      await go(router, '/settings', requests)
      expectResolvedName(router, path, 'role-delegation')
      await go(router, path, requests)
      expectGuardSawName(path, 'role-delegation')
      expect(adminAccessCapabilitiesState.canManageScope).toBe(true)
      expect(router.currentRoute.value.name).toBe('role-delegation')
      expect(router.currentRoute.value.path).toBe(path)
    }

    for (const path of ['/admin/permissions', ...PERMISSION_VARIANTS]) {
      await go(router, '/settings', requests)
      expectResolvedName(router, path, 'permission-management')
      await go(router, path, requests)
      expectGuardSawName(path, 'permission-management')
      expect(adminAccessCapabilitiesState.canManagePermissions).toBe(true)
      expect(router.currentRoute.value.name).toBe('permission-management')
      expect(router.currentRoute.value.path).toBe(path)
    }
  }, 20000)

  it('denies trailing-slash and case variants when the capability is false', async () => {
    published.isPlatformAdmin = true
    published.canManageScope = false
    published.canManagePermissions = false
    const { router, adminAccessCapabilitiesState, requests } = await boot()
    fault.stage = null

    for (const path of ['/admin/role-delegation', ...ROLE_DELEGATION_VARIANTS]) {
      await go(router, '/settings', requests)
      expectResolvedName(router, path, 'role-delegation')
      await go(router, path, requests)
      expectGuardSawName(path, 'role-delegation')
      expect(adminAccessCapabilitiesState.loaded).toBe(true)
      expect(adminAccessCapabilitiesState.isPlatformAdmin).toBe(true)
      expect(adminAccessCapabilitiesState.canManageScope).toBe(false)
      expect(router.currentRoute.value.path).toBe('/home')
    }

    for (const path of ['/admin/permissions', ...PERMISSION_VARIANTS]) {
      await go(router, '/settings', requests)
      expectResolvedName(router, path, 'permission-management')
      await go(router, path, requests)
      expectGuardSawName(path, 'permission-management')
      expect(adminAccessCapabilitiesState.isPlatformAdmin).toBe(true)
      expect(adminAccessCapabilitiesState.canManagePermissions).toBe(false)
      expect(router.currentRoute.value.path).toBe('/home')
    }
  }, 20000)
})
