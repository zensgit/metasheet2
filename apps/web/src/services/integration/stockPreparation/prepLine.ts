// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md)
// per-view service stub: STOCK PREPARATION LINE (design §"Frontend MVP" view 5).
//
// Preparation lines are generated ONLY from confirmed BOM snapshots, confirmed mappings, and
// confirmed unit rules. Generation never produces final `ready` lines for unresolved mappings, unit
// conflicts, missing child BOM, or invalid quantities — those stay `held`/exception.
//
// READONLY-FIRST: GET-only summary. "Generation" (when it lands in a later wave) is a
// MULTITABLE-INTERNAL table op behind its own gate — it never writes to ERP/K3 and is not in this
// stub. No K3 Save/Submit/Audit, no production write.
//
// VALUES-FREE contract: counts by prep_status / unit_status / mapping_status only. No drawing
// numbers, ERP material codes, design/issue quantities, factors, or raw line rows.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, parseIntegrationResponse, type IntegrationScope } from '../workbench'

export type StockPreparationPrepStatus = 'draft' | 'ready' | 'held' | 'confirmed' | 'cancelled'

export type StockPreparationUnitStatus = 'converted' | 'pending_confirm' | 'missing_rule' | 'conflict'

export interface StockPreparationLineSummary {
  totalLineCount: number
  prepStatusCounts: Record<StockPreparationPrepStatus | string, number>
  unitStatusCounts: Record<StockPreparationUnitStatus | string, number>
  mappingStatusCounts: Record<string, number>
  exceptionLinkedLineCount: number
}

/**
 * Values-free summary of the stock-preparation-line table for a project/snapshot batch.
 * GET /api/integration/stock-preparation/prep-lines/summary
 */
export async function getStockPreparationLineSummary(
  scope: IntegrationScope & { projectId?: string | null; snapshotBatchId?: string | null } = {},
): Promise<StockPreparationLineSummary> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    snapshotBatchId: scope.snapshotBatchId,
  })
  const response = await apiFetch(
    `/api/integration/stock-preparation/prep-lines/summary${query ? `?${query}` : ''}`,
  )
  return parseIntegrationResponse<StockPreparationLineSummary>(response)
}
