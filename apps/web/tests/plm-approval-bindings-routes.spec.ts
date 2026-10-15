import { describe, expect, it } from 'vitest'
import { resolveRouteGuardDecision, type RouteGuardPolicyContext } from '../src/router/guardPolicy'
const context: RouteGuardPolicyContext = {
  hasFeature: () => true, hasPermission: () => true,
  attendanceFocused: false, plmWorkbenchFocused: true, resolveHomePath: () => '/plm',
}
describe('personal PLM approval entry in focused mode', () => {
  it.each(['/settings', '/m/approval-decision'])('keeps the exact self-service path reachable: %s', (path) => {
    expect(resolveRouteGuardDecision({ path, meta: {} }, context)).toEqual({ action: 'allow' })
  })
  it.each(['/settings/admin', '/m/approval-decision/other'])('does not open descendants: %s', (path) => {
    expect(resolveRouteGuardDecision({ path, meta: {} }, context)).toEqual({ action: 'redirect', target: '/plm' })
  })
  it('retains the independent permission gate', () => {
    expect(resolveRouteGuardDecision({ path: '/settings', meta: { permissions: ['ungranted'] } }, { ...context, hasPermission: () => false })).toEqual({ action: 'redirect', target: '/plm' })
  })
})
