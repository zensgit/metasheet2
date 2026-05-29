import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
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
})
