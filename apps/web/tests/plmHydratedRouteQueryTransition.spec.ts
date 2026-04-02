import { describe, expect, it } from 'vitest'
import { resolvePlmHydratedRouteQueryTransition } from '../src/views/plm/plmHydratedRouteQueryTransition'

describe('plmHydratedRouteQueryTransition', () => {
  it('applies the explicit next route value when present', () => {
    expect(resolvePlmHydratedRouteQueryTransition({
      previousRouteValue: 'document-view-a',
      nextRouteValue: 'document-view-b',
    })).toEqual({
      kind: 'apply',
      routeValue: 'document-view-b',
    })
  })

  it('preserves explicit empty route values as apply transitions', () => {
    expect(resolvePlmHydratedRouteQueryTransition({
      previousRouteValue: 'document-view-a',
      nextRouteValue: '',
    })).toEqual({
      kind: 'apply',
      routeValue: '',
    })
  })

  it('removes the previous route value when the next query omits it', () => {
    expect(resolvePlmHydratedRouteQueryTransition({
      previousRouteValue: ' document-view-a ',
      nextRouteValue: undefined,
    })).toEqual({
      kind: 'remove',
      removedRouteValue: 'document-view-a',
    })
  })

  it('returns noop when there is no previous route value to remove', () => {
    expect(resolvePlmHydratedRouteQueryTransition({
      previousRouteValue: '  ',
      nextRouteValue: undefined,
    })).toEqual({
      kind: 'noop',
    })
  })
})
