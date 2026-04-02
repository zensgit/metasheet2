import { describe, expect, it } from 'vitest'
import {
  PLM_PANEL_KEYS,
  getPlmProductAdjacentPanels,
  hasProductAdjacentPanelSelected,
  isPlmPanelKey,
  isPlmProductAdjacentPanel,
  resolvePlmPanelActivation,
  type PlmPanelActivation,
} from '../src/views/plm/plmRouteHydrationContracts'

describe('plmRouteHydrationContracts', () => {
  describe('panel key registry', () => {
    it('defines exactly 8 panel keys', () => {
      expect(PLM_PANEL_KEYS).toEqual([
        'search', 'product', 'documents', 'approvals',
        'cad', 'where-used', 'compare', 'substitutes',
      ])
    })

    it.each(PLM_PANEL_KEYS)('isPlmPanelKey("%s") → true', (key) => {
      expect(isPlmPanelKey(key)).toBe(true)
    })

    it.each([
      'bom', 'audit', 'settings', '', null, undefined, 42,
    ])('isPlmPanelKey(%j) → false', (value) => {
      expect(isPlmPanelKey(value)).toBe(false)
    })
  })

  describe('product-adjacent panels', () => {
    const expected = ['product', 'documents', 'approvals', 'where-used', 'compare', 'substitutes']

    it('returns correct product-adjacent panel set', () => {
      expect(getPlmProductAdjacentPanels().sort()).toEqual(expected.sort())
    })

    it.each(expected)('isPlmProductAdjacentPanel("%s") → true', (key) => {
      expect(isPlmProductAdjacentPanel(key)).toBe(true)
    })

    it.each(['search', 'cad'])('isPlmProductAdjacentPanel("%s") → false', (key) => {
      expect(isPlmProductAdjacentPanel(key)).toBe(false)
    })
  })

  describe('hasProductAdjacentPanelSelected', () => {
    it('returns true when selectedPanels is null', () => {
      expect(hasProductAdjacentPanelSelected(null)).toBe(true)
    })

    it('returns true when a product-adjacent panel is selected', () => {
      expect(hasProductAdjacentPanelSelected(new Set(['documents']))).toBe(true)
      expect(hasProductAdjacentPanelSelected(new Set(['cad', 'approvals']))).toBe(true)
    })

    it('returns false when only non-product panels are selected', () => {
      expect(hasProductAdjacentPanelSelected(new Set(['cad']))).toBe(false)
      expect(hasProductAdjacentPanelSelected(new Set(['search']))).toBe(false)
      expect(hasProductAdjacentPanelSelected(new Set(['search', 'cad']))).toBe(false)
    })
  })

  describe('resolvePlmPanelActivation', () => {
    const base = {
      selectedPanels: null as Set<string> | null,
      hasProductContext: false,
      hasSearchQuery: false,
      hasCadFileId: false,
      hasWhereUsedItemId: false,
      hasCompareIds: false,
      hasBomLineId: false,
      hasProductId: false,
    }

    function activate(overrides: Partial<typeof base>): PlmPanelActivation {
      return resolvePlmPanelActivation({ ...base, ...overrides })
    }

    it('keeps all panels inactive when there are no route tokens', () => {
      expect(activate({})).toEqual({
        search: false,
        product: false,
        documents: false,
        approvals: false,
        cad: false,
        whereUsed: false,
        compare: false,
        substitutes: false,
      })
    })

    it('activates the product panel from product context', () => {
      expect(activate({ hasProductContext: true }).product).toBe(true)
    })

    it('does not let panel=cad trigger product autoload', () => {
      const result = activate({
        hasProductContext: true,
        selectedPanels: new Set(['cad']),
        hasCadFileId: true,
      })
      expect(result.product).toBe(false)
      expect(result.cad).toBe(true)
    })

    it('activates all data-bearing panels when panel scope is absent', () => {
      const result = activate({
        hasProductContext: true,
        hasSearchQuery: true,
        hasCadFileId: true,
        hasWhereUsedItemId: true,
        hasCompareIds: true,
        hasBomLineId: true,
        hasProductId: true,
      })
      expect(result.search).toBe(true)
      expect(result.product).toBe(true)
      expect(result.cad).toBe(true)
      expect(result.whereUsed).toBe(true)
      expect(result.compare).toBe(true)
      expect(result.substitutes).toBe(true)
    })

    it('lets documents activate from productId on a documents-scoped route', () => {
      expect(activate({
        selectedPanels: new Set(['documents']),
        hasProductId: true,
      }).documents).toBe(true)
    })
  })
})
