// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md)
// per-view service stub: MATERIAL MAPPING CONFIRMATION (design §"Frontend MVP" view 3).
//
// Maps PLM drawing/version -> ERP material code/internal id. The MVP NEVER auto-creates ERP material
// codes and NEVER generates final lines from ambiguous candidates — unresolved rows stay pending for
// human confirmation.
//
// READONLY-FIRST: GET-only summary. No external ERP/K3 write, no auto material create. When a
// confirm action lands in a later wave it is a MULTITABLE-INTERNAL row write behind its own gate,
// never an external write, and never in this stub.
//
// VALUES-FREE contract: counts by match_status / version_policy / match_method only. No PLM drawing
// numbers, versions, material names, specs, ERP material codes, or internal ids as VALUES.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, parseIntegrationResponse, type IntegrationScope } from '../workbench'

export type StockPreparationMatchStatus =
  | 'matched'
  | 'pending_confirm'
  | 'multi_candidate'
  | 'not_found'
  | 'version_conflict'

export type StockPreparationVersionPolicy =
  | 'drawing_and_version'
  | 'drawing_only'
  | 'category_rule'
  | 'manual'

export interface StockPreparationMaterialMappingSummary {
  totalMappingCount: number
  activeMappingCount: number
  matchStatusCounts: Record<StockPreparationMatchStatus | string, number>
  versionPolicyCounts: Record<StockPreparationVersionPolicy | string, number>
  pendingConfirmCount: number
}

/**
 * Values-free summary of the material-mapping table's confirmation state.
 * GET /api/integration/stock-preparation/material-mappings/summary
 */
export async function getStockPreparationMaterialMappingSummary(
  scope: IntegrationScope & { projectId?: string | null } = {},
): Promise<StockPreparationMaterialMappingSummary> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
  })
  const response = await apiFetch(
    `/api/integration/stock-preparation/material-mappings/summary${query ? `?${query}` : ''}`,
  )
  return parseIntegrationResponse<StockPreparationMaterialMappingSummary>(response)
}
