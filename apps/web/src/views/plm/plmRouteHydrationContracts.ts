export const PLM_PANEL_KEYS = [
  'search',
  'product',
  'documents',
  'approvals',
  'cad',
  'where-used',
  'compare',
  'substitutes',
] as const

export type PlmPanelKey = (typeof PLM_PANEL_KEYS)[number]

const PLM_PANEL_KEY_SET = new Set<string>(PLM_PANEL_KEYS)

const PRODUCT_ADJACENT_PANELS: ReadonlySet<PlmPanelKey> = new Set([
  'product',
  'documents',
  'approvals',
  'where-used',
  'compare',
  'substitutes',
])

export type PlmPanelActivation = {
  search: boolean
  product: boolean
  documents: boolean
  approvals: boolean
  cad: boolean
  whereUsed: boolean
  compare: boolean
  substitutes: boolean
}

export function isPlmPanelKey(value: unknown): value is PlmPanelKey {
  return typeof value === 'string' && PLM_PANEL_KEY_SET.has(value)
}

export function isPlmProductAdjacentPanel(panelKey: string): boolean {
  return PRODUCT_ADJACENT_PANELS.has(panelKey as PlmPanelKey)
}

export function getPlmProductAdjacentPanels(): readonly PlmPanelKey[] {
  return [...PRODUCT_ADJACENT_PANELS]
}

export function hasProductAdjacentPanelSelected(selectedPanels: Set<string> | null): boolean {
  if (!selectedPanels) return true
  return [...PRODUCT_ADJACENT_PANELS].some((key) => selectedPanels.has(key))
}

export function resolvePlmPanelActivation(options: {
  selectedPanels: Set<string> | null
  hasProductContext: boolean
  hasSearchQuery: boolean
  hasCadFileId: boolean
  hasWhereUsedItemId: boolean
  hasCompareIds: boolean
  hasBomLineId: boolean
  hasProductId: boolean
}): PlmPanelActivation {
  const allows = (key: string) => !options.selectedPanels || options.selectedPanels.has(key)
  const productContextActive = options.hasProductContext && (
    !options.selectedPanels || [...PRODUCT_ADJACENT_PANELS].some((key) => allows(key))
  )

  return {
    search: allows('search') && options.hasSearchQuery,
    product: productContextActive,
    documents: productContextActive || (allows('documents') && options.hasProductId),
    approvals: productContextActive || (allows('approvals') && options.hasProductId),
    cad: allows('cad') && options.hasCadFileId,
    whereUsed: allows('where-used') && options.hasWhereUsedItemId,
    compare: allows('compare') && options.hasCompareIds,
    substitutes: allows('substitutes') && options.hasBomLineId,
  }
}
