import { describe, expect, it } from 'vitest'
import {
  applyPlmDeferredRouteQueryPatch,
  mergePlmDeferredRouteQueryPatch,
  resolvePlmDeferredRouteQueryPatch,
} from '../src/views/plm/plmRouteHydrationPatch'

describe('plmRouteHydrationPatch', () => {
  it('merges deferred route query patches while hydration is active', () => {
    const patch = mergePlmDeferredRouteQueryPatch(
      { workbenchTeamView: 'stale-view' },
      { workbenchTeamView: undefined, documentTeamView: 'document-default' },
    )

    expect(patch).toEqual({
      workbenchTeamView: undefined,
      documentTeamView: 'document-default',
    })
  })

  it('flushes the deferred patch only after the final hydration pass completes', () => {
    expect(
      resolvePlmDeferredRouteQueryPatch(
        { workbenchTeamView: undefined, approvalsTeamView: 'approvals-default' },
        true,
      ),
    ).toEqual({
      pendingPatch: { workbenchTeamView: undefined, approvalsTeamView: 'approvals-default' },
      flushPatch: null,
    })

    expect(
      resolvePlmDeferredRouteQueryPatch(
        { workbenchTeamView: undefined, approvalsTeamView: 'approvals-default' },
        false,
      ),
    ).toEqual({
      pendingPatch: null,
      flushPatch: { workbenchTeamView: undefined, approvalsTeamView: 'approvals-default' },
    })
  })

  it('applies the deferred patch over the current route query when computing effective hydration state', () => {
    expect(
      applyPlmDeferredRouteQueryPatch(
        {
          documentTeamView: 'stale-document',
          documentFilter: 'motor',
          panel: 'documents',
        },
        {
          documentTeamView: undefined,
          documentFilter: '',
          cadTeamView: 'cad-default',
        },
      ),
    ).toEqual({
      panel: 'documents',
      cadTeamView: 'cad-default',
    })
  })
})
