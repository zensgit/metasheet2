import {
  normalizePlmWorkbenchPanelScope,
  shouldAutoloadPlmProductContext,
} from './plmWorkbenchViewState'

export type PlmHydratedPanelDataRouteState = {
  autoload?: unknown
  panel?: unknown
  searchQuery?: unknown
  searchItemType?: unknown
  searchLimit?: unknown
  productId?: unknown
  itemNumber?: unknown
  itemType?: unknown
  bomDepth?: unknown
  bomEffectiveAt?: unknown
  documentRole?: unknown
  approvalsStatus?: unknown
  cadFileId?: unknown
  cadOtherFileId?: unknown
  whereUsedItemId?: unknown
  whereUsedRecursive?: unknown
  whereUsedMaxLevels?: unknown
  compareLeftId?: unknown
  compareRightId?: unknown
  compareMode?: unknown
  compareLineKey?: unknown
  compareMaxLevels?: unknown
  compareIncludeChildFields?: unknown
  compareIncludeSubstitutes?: unknown
  compareIncludeEffectivity?: unknown
  compareEffectiveAt?: unknown
  compareRelationshipProps?: unknown
  bomLineId?: unknown
}

export type PlmHydratedPanelDataReset = {
  clearSearch: boolean
  clearProduct: boolean
  clearBom: boolean
  clearDocuments: boolean
  clearCad: boolean
  clearApprovals: boolean
  clearWhereUsed: boolean
  clearCompare: boolean
  clearSubstitutes: boolean
}

const EMPTY_RESET: PlmHydratedPanelDataReset = {
  clearSearch: false,
  clearProduct: false,
  clearBom: false,
  clearDocuments: false,
  clearCad: false,
  clearApprovals: false,
  clearWhereUsed: false,
  clearCompare: false,
  clearSubstitutes: false,
}

function normalizeToken(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return ''
}

function hasTruthyToken(value: unknown): boolean {
  return normalizeToken(value).length > 0
}

function allowsPanel(selectedPanels: Set<string> | null, key: string): boolean {
  return !selectedPanels || selectedPanels.has(key)
}

function buildSelectedPanelSet(panel: unknown): Set<string> | null {
  const normalized = normalizePlmWorkbenchPanelScope(panel)
  if (!normalized) return null
  return new Set(
    normalized
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
}

function buildProductContextKey(state: PlmHydratedPanelDataRouteState): string {
  const productId = normalizeToken(state.productId)
  const itemNumber = normalizeToken(state.itemNumber)
  if (!productId && !itemNumber) return ''
  return [productId, itemNumber, normalizeToken(state.itemType)].join('|')
}

function buildSearchKey(state: PlmHydratedPanelDataRouteState): string {
  const query = normalizeToken(state.searchQuery)
  if (!query) return ''
  return [query, normalizeToken(state.searchItemType), normalizeToken(state.searchLimit)].join('|')
}

function buildBomKey(state: PlmHydratedPanelDataRouteState): string {
  const productContextKey = buildProductContextKey(state)
  if (!productContextKey) return ''
  return [productContextKey, normalizeToken(state.bomDepth), normalizeToken(state.bomEffectiveAt)].join('|')
}

function buildDocumentsKey(state: PlmHydratedPanelDataRouteState): string {
  const productContextKey = buildProductContextKey(state)
  if (!productContextKey) return ''
  return [productContextKey, normalizeToken(state.documentRole)].join('|')
}

function buildApprovalsKey(state: PlmHydratedPanelDataRouteState): string {
  const productContextKey = buildProductContextKey(state)
  if (!productContextKey) return ''
  return [productContextKey, normalizeToken(state.approvalsStatus)].join('|')
}

function buildCadKey(state: PlmHydratedPanelDataRouteState): string {
  const fileId = normalizeToken(state.cadFileId)
  if (!fileId) return ''
  return [fileId, normalizeToken(state.cadOtherFileId)].join('|')
}

function buildWhereUsedKey(state: PlmHydratedPanelDataRouteState): string {
  const itemId = normalizeToken(state.whereUsedItemId)
  if (!itemId) return ''
  return [itemId, normalizeToken(state.whereUsedRecursive), normalizeToken(state.whereUsedMaxLevels)].join('|')
}

function buildCompareKey(state: PlmHydratedPanelDataRouteState): string {
  const leftId = normalizeToken(state.compareLeftId)
  const rightId = normalizeToken(state.compareRightId)
  if (!leftId || !rightId) return ''
  return [
    leftId,
    rightId,
    normalizeToken(state.compareMode),
    normalizeToken(state.compareLineKey),
    normalizeToken(state.compareMaxLevels),
    normalizeToken(state.compareIncludeChildFields),
    normalizeToken(state.compareIncludeSubstitutes),
    normalizeToken(state.compareIncludeEffectivity),
    normalizeToken(state.compareEffectiveAt),
    normalizeToken(state.compareRelationshipProps),
  ].join('|')
}

function buildSubstitutesKey(state: PlmHydratedPanelDataRouteState): string {
  return normalizeToken(state.bomLineId)
}

export function resolvePlmHydratedPanelDataReset(options: {
  previousRouteState: PlmHydratedPanelDataRouteState
  nextRouteState: PlmHydratedPanelDataRouteState
}): PlmHydratedPanelDataReset {
  if (!options.nextRouteState.autoload) {
    const previousSearchKey = buildSearchKey(options.previousRouteState)
    const nextSearchKey = buildSearchKey(options.nextRouteState)
    const previousProductContextKey = buildProductContextKey(options.previousRouteState)
    const nextProductContextKey = buildProductContextKey(options.nextRouteState)
    const previousCadKey = buildCadKey(options.previousRouteState)
    const nextCadKey = buildCadKey(options.nextRouteState)
    const previousWhereUsedKey = buildWhereUsedKey(options.previousRouteState)
    const nextWhereUsedKey = buildWhereUsedKey(options.nextRouteState)
    const previousCompareKey = buildCompareKey(options.previousRouteState)
    const nextCompareKey = buildCompareKey(options.nextRouteState)
    const previousSubstitutesKey = buildSubstitutesKey(options.previousRouteState)
    const nextSubstitutesKey = buildSubstitutesKey(options.nextRouteState)

    return {
      clearSearch: previousSearchKey !== nextSearchKey,
      clearProduct: previousProductContextKey !== nextProductContextKey,
      clearBom: previousProductContextKey !== nextProductContextKey,
      clearDocuments: previousProductContextKey !== nextProductContextKey,
      clearCad: previousCadKey !== nextCadKey,
      clearApprovals: previousProductContextKey !== nextProductContextKey,
      clearWhereUsed: previousWhereUsedKey !== nextWhereUsedKey,
      clearCompare: previousCompareKey !== nextCompareKey,
      clearSubstitutes: previousSubstitutesKey !== nextSubstitutesKey,
    }
  }

  const selectedPanels = buildSelectedPanelSet(options.nextRouteState.panel)
  const nextSearchActive = allowsPanel(selectedPanels, 'search')
    && hasTruthyToken(options.nextRouteState.searchQuery)
  const nextProductContextActive = shouldAutoloadPlmProductContext({
    panel: options.nextRouteState.panel,
    productId: options.nextRouteState.productId,
    itemNumber: options.nextRouteState.itemNumber,
  })
  const nextCadActive = allowsPanel(selectedPanels, 'cad')
    && hasTruthyToken(options.nextRouteState.cadFileId)
  const nextWhereUsedActive = allowsPanel(selectedPanels, 'where-used')
    && hasTruthyToken(options.nextRouteState.whereUsedItemId)
  const nextCompareActive = allowsPanel(selectedPanels, 'compare')
    && hasTruthyToken(options.nextRouteState.compareLeftId)
    && hasTruthyToken(options.nextRouteState.compareRightId)
  const nextSubstitutesActive = allowsPanel(selectedPanels, 'substitutes')
    && hasTruthyToken(options.nextRouteState.bomLineId)
  const nextDocumentsActive = nextProductContextActive
    || (allowsPanel(selectedPanels, 'documents') && hasTruthyToken(options.nextRouteState.productId))
  const nextApprovalsActive = nextProductContextActive
    || (allowsPanel(selectedPanels, 'approvals') && hasTruthyToken(options.nextRouteState.productId))

  const previousSearchKey = buildSearchKey(options.previousRouteState)
  const nextSearchKey = nextSearchActive ? buildSearchKey(options.nextRouteState) : ''
  const previousProductContextKey = buildProductContextKey(options.previousRouteState)
  const nextProductContextKey = nextProductContextActive
    ? buildProductContextKey(options.nextRouteState)
    : ''
  const previousBomKey = buildBomKey(options.previousRouteState)
  const nextBomKey = nextProductContextActive ? buildBomKey(options.nextRouteState) : ''
  const previousDocumentsKey = buildDocumentsKey(options.previousRouteState)
  const nextDocumentsKey = nextDocumentsActive ? buildDocumentsKey(options.nextRouteState) : ''
  const previousCadKey = buildCadKey(options.previousRouteState)
  const nextCadKey = nextCadActive ? buildCadKey(options.nextRouteState) : ''
  const previousApprovalsKey = buildApprovalsKey(options.previousRouteState)
  const nextApprovalsKey = nextApprovalsActive ? buildApprovalsKey(options.nextRouteState) : ''
  const previousWhereUsedKey = buildWhereUsedKey(options.previousRouteState)
  const nextWhereUsedKey = nextWhereUsedActive ? buildWhereUsedKey(options.nextRouteState) : ''
  const previousCompareKey = buildCompareKey(options.previousRouteState)
  const nextCompareKey = nextCompareActive ? buildCompareKey(options.nextRouteState) : ''
  const previousSubstitutesKey = buildSubstitutesKey(options.previousRouteState)
  const nextSubstitutesKey = nextSubstitutesActive ? buildSubstitutesKey(options.nextRouteState) : ''

  return {
    clearSearch: !nextSearchActive || previousSearchKey !== nextSearchKey,
    clearProduct: !nextProductContextActive || previousProductContextKey !== nextProductContextKey,
    clearBom: !nextProductContextActive || previousBomKey !== nextBomKey,
    clearDocuments: !nextDocumentsActive || previousDocumentsKey !== nextDocumentsKey,
    clearCad: !nextCadActive || previousCadKey !== nextCadKey,
    clearApprovals: !nextApprovalsActive || previousApprovalsKey !== nextApprovalsKey,
    clearWhereUsed: !nextWhereUsedActive || previousWhereUsedKey !== nextWhereUsedKey,
    clearCompare: !nextCompareActive || previousCompareKey !== nextCompareKey,
    clearSubstitutes: !nextSubstitutesActive || previousSubstitutesKey !== nextSubstitutesKey,
  }
}
