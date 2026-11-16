import { beforeEach, describe, expect, it } from 'vitest'
import {
  publishAdminAccessCapabilities,
  resetAdminAccessCapabilities,
} from '../src/composables/adminAccessCapabilities'
import { buildRouteGuardContext, resolveRouteGuardDecision, type RouteGuardPolicyContext } from '../src/router/guardPolicy'

function deps(attendanceFocused: boolean, plmWorkbenchFocused = false) {
  return {
    auth: {
      hasPermission: () => true,
      getAccessSnapshot: () => ({ roles: [] as string[], permissions: [] as string[] }),
    },
    flags: {
      hasFeature: () => true as const,
      isAttendanceFocused: () => attendanceFocused,
      isPlmWorkbenchFocused: () => plmWorkbenchFocused,
      resolveHomePath: () => '/home',
    },
  }
}

function ctx(over: Partial<RouteGuardPolicyContext> = {}): RouteGuardPolicyContext {
  return {
    hasFeature: () => true,
    hasPermission: () => true,
    attendanceFocused: false,
    plmWorkbenchFocused: false,
    resolveHomePath: () => '/home',
    ...over,
  }
}

describe('focused management-scope route exception', () => {
  beforeEach(() => {
    resetAdminAccessCapabilities()
  })

  it('allows only the exact role-delegation path when canManageScope is published', () => {
    publishAdminAccessCapabilities({
      isPlatformAdmin: false,
      canManageScope: true,
      delegableNamespaces: ['attendance'],
    })
    const attendance = buildRouteGuardContext(deps(true))
    expect(attendance.canManageScope).toBe(true)
    expect(resolveRouteGuardDecision({ path: '/admin/role-delegation', meta: { requiresAuth: true } }, attendance))
      .toEqual({ action: 'allow' })
    expect(resolveRouteGuardDecision({ path: '/admin/users', meta: {} }, attendance))
      .toEqual({ action: 'redirect', target: '/attendance' })
    expect(resolveRouteGuardDecision({ path: '/admin', meta: {} }, attendance))
      .toEqual({ action: 'redirect', target: '/attendance' })
    expect(resolveRouteGuardDecision({ path: '/admin/role-delegation/extra', meta: {} }, attendance))
      .toEqual({ action: 'redirect', target: '/attendance' })
    expect(resolveRouteGuardDecision({ path: '/admin/role-delegation-evil', meta: {} }, attendance))
      .toEqual({ action: 'redirect', target: '/attendance' })

    const plm = buildRouteGuardContext(deps(false, true))
    expect(resolveRouteGuardDecision({ path: '/admin/role-delegation', meta: {} }, plm))
      .toEqual({ action: 'allow' })
    expect(resolveRouteGuardDecision({ path: '/admin/roles', meta: {} }, plm))
      .toEqual({ action: 'redirect', target: '/plm' })
  })

  it('keeps the role-delegation path closed in focus mode until the capability is granted', () => {
    const attendance = buildRouteGuardContext(deps(true))
    expect(attendance.canManageScope).toBe(false)
    expect(resolveRouteGuardDecision({ path: '/admin/role-delegation', meta: {} }, attendance))
      .toEqual({ action: 'redirect', target: '/attendance' })
  })

  it('gates exact role-delegation and permission-source routes in the ordinary shell', () => {
    expect(resolveRouteGuardDecision(
      { path: '/admin/role-delegation', meta: { requiresAuth: true } },
      ctx(),
    )).toEqual({ action: 'redirect', target: '/home' })
    expect(resolveRouteGuardDecision(
      { path: '/admin/role-delegation', meta: { requiresAuth: true } },
      ctx({ canManageScope: true }),
    )).toEqual({ action: 'allow' })
    expect(resolveRouteGuardDecision(
      { path: '/admin/role-delegation/extra', meta: {} },
      ctx({ canManageScope: true }),
    )).toEqual({ action: 'allow' })
    expect(resolveRouteGuardDecision(
      { path: '/admin/users', meta: { requiresAdmin: true } },
      ctx({ canManageScope: false }),
    )).toEqual({ action: 'allow' })

    expect(resolveRouteGuardDecision(
      { path: '/admin/permissions', meta: { requiresAdmin: true } },
      ctx({ canManageScope: true }),
    )).toEqual({ action: 'redirect', target: '/home' })
    expect(resolveRouteGuardDecision(
      { path: '/admin/permissions', meta: { requiresAdmin: true } },
      ctx({ canManagePermissions: true }),
    )).toEqual({ action: 'allow' })
    expect(resolveRouteGuardDecision(
      { path: '/admin/permissions/extra', meta: {} },
      ctx(),
    )).toEqual({ action: 'allow' })

    publishAdminAccessCapabilities({
      isPlatformAdmin: true,
      canManageScope: true,
      delegableNamespaces: [],
    })
    const legacyAdmin = buildRouteGuardContext(deps(false))
    expect(legacyAdmin.canManagePermissions).toBe(false)
    expect(resolveRouteGuardDecision(
      { path: '/admin/permissions', meta: { requiresAdmin: true } },
      legacyAdmin,
    )).toEqual({ action: 'redirect', target: '/home' })
    expect(resolveRouteGuardDecision(
      { path: '/admin/role-delegation', meta: { requiresAuth: true } },
      legacyAdmin,
    )).toEqual({ action: 'allow' })
  })

  it('does not let the focus exception skip the route permission gate', () => {
    const decision = resolveRouteGuardDecision(
      { path: '/admin/role-delegation', meta: { permissions: ['secret:read'] } },
      ctx({ attendanceFocused: true, canManageScope: true, hasPermission: () => false }),
    )
    expect(decision).toEqual({ action: 'redirect', target: '/home' })
  })
})
