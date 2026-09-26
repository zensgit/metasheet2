import { describe, expect, it } from 'vitest'
import { appRoutes } from '../src/router/appRoutes'
import { resolveRouteGuardDecision, type RouteGuardPolicyContext } from '../src/router/guardPolicy'

const tasks = appRoutes.find((route) => route.path === '/tasks')

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

describe('tasks route meta', () => {
  it('projects /tasks without a requiredFeature flag', () => {
    expect(tasks).toBeTruthy()
    const meta = tasks?.meta as Record<string, unknown>
    expect(meta.requiresAuth).toBe(true)
    expect(meta.permissions).toEqual(['tasks:read'])
    expect('requiredFeature' in meta).toBe(false)
    expect(typeof meta.title).toBe('string')
    expect(String(meta.title).length).toBeGreaterThan(0)
    expect(typeof meta.titleZh).toBe('string')
    expect(String(meta.titleZh).length).toBeGreaterThan(0)
  })
})

describe('tasks guard policy', () => {
  const meta = { requiresAuth: true, permissions: ['tasks:read'] }

  it('sends an attendance-focused session to /attendance', () => {
    expect(resolveRouteGuardDecision(
      { path: '/tasks', meta },
      ctx({ attendanceFocused: true, plmWorkbenchFocused: false }),
    )).toEqual({ action: 'redirect', target: '/attendance' })
  })

  it('sends a plm-focused session to /plm', () => {
    expect(resolveRouteGuardDecision(
      { path: '/tasks', meta },
      ctx({ attendanceFocused: false, plmWorkbenchFocused: true }),
    )).toEqual({ action: 'redirect', target: '/plm' })
  })

  it('allows the route when the permission probe returns true', () => {
    expect(resolveRouteGuardDecision(
      { path: '/tasks', meta },
      ctx(),
    )).toEqual({ action: 'allow' })
  })

  it('sends a caller without tasks:read home', () => {
    expect(resolveRouteGuardDecision(
      { path: '/tasks', meta },
      ctx({ hasPermission: () => false }),
    )).toEqual({ action: 'redirect', target: '/HOME' })
  })
})
