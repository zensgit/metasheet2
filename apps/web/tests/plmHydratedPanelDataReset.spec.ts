import { describe, expect, it } from 'vitest'
import { resolvePlmHydratedPanelDataReset } from '../src/views/plm/plmHydratedPanelDataReset'

describe('plmHydratedPanelDataReset', () => {
  it('clears changed route-owned payloads even when route hydration does not autoload', () => {
    expect(resolvePlmHydratedPanelDataReset({
      previousRouteState: {
        cadFileId: 'cad-a',
      },
      nextRouteState: {
        autoload: false,
        panel: 'cad',
        cadFileId: 'cad-b',
      },
    })).toEqual({
      clearSearch: false,
      clearProduct: false,
      clearBom: false,
      clearDocuments: false,
      clearCad: true,
      clearApprovals: false,
      clearWhereUsed: false,
      clearCompare: false,
      clearSubstitutes: false,
    })
  })

  it('preserves existing payloads for non-autoload route hydration when the target is unchanged', () => {
    expect(resolvePlmHydratedPanelDataReset({
      previousRouteState: {
        autoload: false,
        panel: 'cad',
        cadFileId: 'cad-a',
      },
      nextRouteState: {
        autoload: false,
        panel: 'cad',
        cadFileId: 'cad-a',
      },
    })).toEqual({
      clearSearch: false,
      clearProduct: false,
      clearBom: false,
      clearDocuments: false,
      clearCad: false,
      clearApprovals: false,
      clearWhereUsed: false,
      clearCompare: false,
      clearSubstitutes: false,
    })
  })

  it('clears non-autoload bom data when route-owned bom options drift under the same product context', () => {
    expect(resolvePlmHydratedPanelDataReset({
      previousRouteState: {
        autoload: false,
        panel: 'product',
        productId: 'prod-100',
        itemNumber: 'P-100',
        itemType: 'Part',
        bomDepth: 2,
      },
      nextRouteState: {
        autoload: false,
        panel: 'product',
        productId: 'prod-100',
        itemNumber: 'P-100',
        itemType: 'Part',
        bomDepth: 3,
      },
    })).toEqual({
      clearSearch: false,
      clearProduct: false,
      clearBom: true,
      clearDocuments: false,
      clearCad: false,
      clearApprovals: false,
      clearWhereUsed: false,
      clearCompare: false,
      clearSubstitutes: false,
    })
  })

  it('clears non-autoload documents and approvals data when route-owned panel state drifts under the same product context', () => {
    expect(resolvePlmHydratedPanelDataReset({
      previousRouteState: {
        autoload: false,
        panel: 'documents,approvals',
        productId: 'prod-100',
        itemNumber: 'P-100',
        itemType: 'Part',
        documentRole: 'drawing',
        approvalsStatus: 'pending',
      },
      nextRouteState: {
        autoload: false,
        panel: 'documents,approvals',
        productId: 'prod-100',
        itemNumber: 'P-100',
        itemType: 'Part',
        documentRole: 'spec',
        approvalsStatus: 'rejected',
      },
    })).toEqual({
      clearSearch: false,
      clearProduct: false,
      clearBom: false,
      clearDocuments: true,
      clearCad: false,
      clearApprovals: true,
      clearWhereUsed: false,
      clearCompare: false,
      clearSubstitutes: false,
    })
  })

  it('clears stale non-target panel data for cad-only share links', () => {
    expect(resolvePlmHydratedPanelDataReset({
      previousRouteState: {
        searchQuery: 'motor',
        searchItemType: 'Part',
        searchLimit: 10,
        productId: 'prod-100',
        itemNumber: 'P-100',
        itemType: 'Part',
        bomDepth: 2,
        documentRole: 'drawing',
        approvalsStatus: 'pending',
        cadFileId: 'cad-a',
        whereUsedItemId: 'item-a',
        compareLeftId: 'left-a',
        compareRightId: 'right-a',
        bomLineId: 'line-a',
      },
      nextRouteState: {
        autoload: true,
        panel: 'cad',
        cadFileId: 'cad-b',
      },
    })).toEqual({
      clearSearch: true,
      clearProduct: true,
      clearBom: true,
      clearDocuments: true,
      clearCad: true,
      clearApprovals: true,
      clearWhereUsed: true,
      clearCompare: true,
      clearSubstitutes: true,
    })
  })

  it('preserves product-scoped fetch data when a documents share reloads the same product context', () => {
    expect(resolvePlmHydratedPanelDataReset({
      previousRouteState: {
        productId: 'prod-100',
        itemNumber: 'P-100',
        itemType: 'Part',
        bomDepth: 2,
        documentRole: 'drawing',
        approvalsStatus: 'pending',
        cadFileId: 'cad-a',
      },
      nextRouteState: {
        autoload: true,
        panel: 'documents',
        productId: 'prod-100',
        itemNumber: 'P-100',
        itemType: 'Part',
        bomDepth: 2,
        documentRole: 'drawing',
        approvalsStatus: 'pending',
      },
    })).toEqual({
      clearSearch: true,
      clearProduct: false,
      clearBom: false,
      clearDocuments: false,
      clearCad: true,
      clearApprovals: false,
      clearWhereUsed: true,
      clearCompare: true,
      clearSubstitutes: true,
    })
  })

  it('preserves cad payloads when the hydrated cad target is unchanged', () => {
    expect(resolvePlmHydratedPanelDataReset({
      previousRouteState: {
        cadFileId: 'cad-a',
        cadOtherFileId: 'cad-b',
      },
      nextRouteState: {
        autoload: true,
        panel: 'cad',
        cadFileId: 'cad-a',
        cadOtherFileId: 'cad-b',
      },
    })).toEqual({
      clearSearch: true,
      clearProduct: true,
      clearBom: true,
      clearDocuments: true,
      clearCad: false,
      clearApprovals: true,
      clearWhereUsed: true,
      clearCompare: true,
      clearSubstitutes: true,
    })
  })

  it('clears compare data when compare inputs drift under the same panel scope', () => {
    expect(resolvePlmHydratedPanelDataReset({
      previousRouteState: {
        compareLeftId: 'left-a',
        compareRightId: 'right-a',
        compareMode: 'delta',
        compareLineKey: 'child_config',
        compareMaxLevels: 5,
      },
      nextRouteState: {
        autoload: true,
        panel: 'compare',
        compareLeftId: 'left-a',
        compareRightId: 'right-b',
        compareMode: 'delta',
        compareLineKey: 'child_config',
        compareMaxLevels: 5,
      },
    }).clearCompare).toBe(true)
  })
})
