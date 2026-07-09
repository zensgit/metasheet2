// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md)
// per-view service stub: UNIT CONVERSION CONFIRMATION (design §"Frontend MVP" view 4).
//
// Converts a PLM design unit into an ERP production-issue unit via a confirmed rule. If no unique
// active rule exists the line enters the exception queue (never a silent guess).
//
// READONLY-FIRST: GET-only summary. No external write. A later "confirm rule" action is a
// MULTITABLE-INTERNAL row write behind its own gate, not part of this stub.
//
// VALUES-FREE contract: counts by scope_type / rounding_rule and pending counts only. No unit
// symbols-as-data rows, conversion factors, loss rates, minimum quantities, or raw rule rows.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, parseIntegrationResponse, type IntegrationScope } from '../workbench'

export type StockPreparationUnitScopeType = 'material' | 'category' | 'generic'

export type StockPreparationRoundingRule = 'none' | 'ceil' | 'floor' | 'nearest' | 'pack_size'

export interface StockPreparationUnitConversionSummary {
  totalRuleCount: number
  activeRuleCount: number
  requiresConfirmationCount: number
  scopeTypeCounts: Record<StockPreparationUnitScopeType | string, number>
  roundingRuleCounts: Record<StockPreparationRoundingRule | string, number>
  pendingUnitLineCount: number
}

/**
 * Values-free summary of the unit-conversion-rule table's confirmation state.
 * GET /api/integration/stock-preparation/unit-conversions/summary
 */
export async function getStockPreparationUnitConversionSummary(
  scope: IntegrationScope & { projectId?: string | null } = {},
): Promise<StockPreparationUnitConversionSummary> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
  })
  const response = await apiFetch(
    `/api/integration/stock-preparation/unit-conversions/summary${query ? `?${query}` : ''}`,
  )
  return parseIntegrationResponse<StockPreparationUnitConversionSummary>(response)
}
