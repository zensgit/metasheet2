import { describe, expect, it } from 'vitest'
import type { RouteRecordRaw } from 'vue-router'
import { createMemoryHistory, createRouter } from 'vue-router'
import { appRoutes } from '../src/router/appRoutes'
import { resolveAdminRouteRedirect } from '../src/router/adminAccess'
import {
  resolveRouteGuardDecision,
  type RouteGuardPolicyContext,
} from '../src/router/guardPolicy'

function routeByPath(path: string): RouteRecordRaw {
  const route = appRoutes.find((item) => item.path === path)
  expect(route, `expected exported route at path ${path}`).toBeTruthy()
  return route as RouteRecordRaw
}

function isLazyViewLoader(component: RouteRecordRaw['component'], viewFile: string): boolean {
  return typeof component === 'function' && String(component).includes(viewFile)
}

function ctx(over: Partial<RouteGuardPolicyContext> = {}): RouteGuardPolicyContext {
  return {
    hasFeature: () => true,
    hasPermission: () => true,
    attendanceFocused: false,
    plmWorkbenchFocused: false,
    resolveHomePath: () => '/HOME',
    ...over,
  }
}

describe('/plm/bom-review route', () => {
  it('declares the same auth and plm feature metadata as /plm, with no integration:write, role, or admin grant', () => {
    const route = routeByPath('/plm/bom-review')

    expect(route.name).toBe('plm-bom-review')
    expect(route.meta).toEqual({
      title: 'BOM Review',
      titleZh: 'BOM 评审',
      requiresAuth: true,
      requiredFeature: 'plm',
    })
    expect(route.meta).not.toHaveProperty('permissions')
    expect(route.meta).not.toHaveProperty('roles')
    expect(route.meta).not.toHaveProperty('requiresAdmin')
    expect(JSON.stringify(route.meta)).not.toContain('integration:write')
    expect(isLazyViewLoader(route.component, 'PlmBomReviewWorkspaceView.vue')).toBe(true)
    expect(routeByPath('/plm').meta).toMatchObject({ requiresAuth: true, requiredFeature: 'plm' })
    expect(routeByPath('/plm-embed/bom-review').meta?.requiresAuth).toBe(false)
  })

  it('resolves /plm/bom-review without taking /plm, /plm/audit, or the embed page', () => {
    const router = createRouter({ history: createMemoryHistory(), routes: appRoutes })
    expect(router.resolve('/plm/bom-review').name).toBe('plm-bom-review')
    expect(router.resolve('/plm').name).toBe('plm')
    expect(router.resolve('/plm/audit').name).toBe('plm-audit')
    expect(router.resolve('/plm-embed/bom-review').name).toBe('plm-embed-bom-review')

    const index = appRoutes.findIndex((item) => item.path === '/plm/bom-review')
    const catchAll = appRoutes.findIndex((item) => item.name === 'not-found')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(index).toBeLessThan(catchAll)
  })
})

describe('/plm/bom-review resolveRouteGuardDecision', () => {
  it('allows the plm feature without integration:write, and still denies that permission on the workbench route', () => {
    const noIntegrationWrite = ctx({
      hasFeature: (feature) => feature === 'plm',
      hasPermission: () => false,
    })
    expect(resolveRouteGuardDecision(
      { path: '/plm/bom-review', meta: routeByPath('/plm/bom-review').meta },
      noIntegrationWrite,
    )).toEqual({ action: 'allow' })
    expect(resolveRouteGuardDecision(
      { path: '/integrations/workbench', meta: routeByPath('/integrations/workbench').meta },
      noIntegrationWrite,
    )).toEqual({ action: 'redirect', target: '/HOME' })
  })

  it('redirects when the plm feature is off, including inside plm focus', () => {
    const decision = resolveRouteGuardDecision(
      { path: '/plm/bom-review', meta: routeByPath('/plm/bom-review').meta },
      ctx({
        hasFeature: () => false,
        hasPermission: () => true,
        plmWorkbenchFocused: true,
      }),
    )
    expect(decision).toEqual({ action: 'redirect', target: '/HOME' })
  })

  it('keeps the admin gate and focus redirects on the real route records', async () => {
    const bom = routeByPath('/plm/bom-review')
    const workbench = routeByPath('/integrations/workbench')
    const admin = routeByPath('/admin/users')
    expect(workbench.meta?.permissions).toEqual(['integration:write'])
    expect(admin.meta?.requiresAdmin).toBe(true)
    expect(bom.meta?.requiresAdmin).not.toBe(true)

    const flags = {
      loadProductFeatures: async () => {
        throw new Error('admin feature load is not part of the bom route')
      },
      resolveHomePath: () => '/HOME',
    }
    await expect(resolveAdminRouteRedirect({ meta: bom.meta ?? {} }, { hasAdminAccess: () => false }, flags)).resolves.toBeNull()
    await expect(resolveAdminRouteRedirect({ meta: admin.meta ?? {} }, { hasAdminAccess: () => false }, flags)).resolves.toBe('/HOME')

    expect(resolveRouteGuardDecision(
      { path: '/plm/bom-review', meta: bom.meta },
      ctx({ hasFeature: (feature) => feature === 'plm', hasPermission: () => false, attendanceFocused: true }),
    )).toEqual({ action: 'redirect', target: '/attendance' })
    expect(resolveRouteGuardDecision(
      { path: '/plm/bom-review', meta: bom.meta },
      ctx({ hasFeature: (feature) => feature === 'plm', hasPermission: () => false, plmWorkbenchFocused: true }),
    )).toEqual({ action: 'allow' })
  })
})
