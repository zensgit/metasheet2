import { describe, expect, it } from 'vitest'
import { buildMultitableRoute } from '../src/router/multitableRoute'
import { buildRouteGuardInput, resolveRouteGuardDecision } from '../src/router/guardPolicy'

const grid = buildMultitableRoute({ render: () => null })
const ctx = { hasFeature: () => true, hasPermission: () => true,
  attendanceFocused: false, plmWorkbenchFocused: true, resolveHomePath: () => '/plm' }
const decide = (path: string, meta: unknown = grid.meta, context = ctx) =>
  resolveRouteGuardDecision(buildRouteGuardInput({ path, meta }), context)

describe('PLM snapshot destination grid', () => {
  it('opens the existing grid through the actual route metadata and runtime adapter', () => {
    expect(decide('/multitable/snapshot-sheet/grid-view')).toEqual({ action: 'allow' })
  })
  it('keeps unrelated multitable authoring and public-form routes outside the focus mode', () => {
    for (const path of ['/multitable', '/multitable/templates', '/multitable/templates/template-1', '/multitable/public-form/sheet/view'])
      expect(decide(path, {})).toEqual({ action: 'redirect', target: '/plm' })
  })
  it('does not bypass route permissions or disabled required features', () => {
    expect(decide('/multitable/sheet/view', { ...grid.meta, permissions: ['multitable:read'] },
      { ...ctx, hasPermission: () => false })).toEqual({ action: 'redirect', target: '/plm' })
    expect(decide('/multitable/sheet/view', { ...grid.meta, requiredFeature: 'plm' },
      { ...ctx, hasFeature: () => false })).toEqual({ action: 'redirect', target: '/plm' })
  })
  it('does not relax the attendance focus boundary', () => {
    expect(decide('/multitable/sheet/view', grid.meta, { ...ctx, attendanceFocused: true }))
      .toEqual({ action: 'redirect', target: '/attendance' })
  })
})
