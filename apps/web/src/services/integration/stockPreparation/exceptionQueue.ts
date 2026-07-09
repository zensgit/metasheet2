// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md)
// per-view service stub: EXCEPTION QUEUE (design §"Frontend MVP" view 6).
//
// Every uncertain row is visible and actionable instead of being dropped. Blocking exceptions stay
// visible and prevent final confirmation while mapping/unit status is unresolved.
//
// READONLY-FIRST: GET-only summary. Resolving an exception (later wave) is a MULTITABLE-INTERNAL row
// write behind its own gate; no external ERP/K3 write, no auto-retry of write-like actions, not in
// this stub.
//
// VALUES-FREE contract: counts by exception_type / severity / status only. No exception messages,
// drawing numbers, material codes, quantities, or raw rows.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, parseIntegrationResponse, type IntegrationScope } from '../workbench'

export type StockPreparationExceptionType =
  | 'missing_mapping'
  | 'multi_candidate'
  | 'unit_missing'
  | 'unit_conflict'
  | 'bom_changed'
  | 'missing_child_bom'
  | 'invalid_qty'

export type StockPreparationExceptionSeverity = 'info' | 'warning' | 'blocking'

export type StockPreparationExceptionStatus = 'open' | 'resolved' | 'ignored' | 'deferred'

export interface StockPreparationExceptionQueueSummary {
  totalExceptionCount: number
  openBlockingCount: number
  typeCounts: Record<StockPreparationExceptionType | string, number>
  severityCounts: Record<StockPreparationExceptionSeverity | string, number>
  statusCounts: Record<StockPreparationExceptionStatus | string, number>
}

/**
 * Values-free summary of the exception-confirmation queue for a project.
 * GET /api/integration/stock-preparation/exceptions/summary
 */
export async function getStockPreparationExceptionQueueSummary(
  scope: IntegrationScope & { projectId?: string | null } = {},
): Promise<StockPreparationExceptionQueueSummary> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
  })
  const response = await apiFetch(
    `/api/integration/stock-preparation/exceptions/summary${query ? `?${query}` : ''}`,
  )
  return parseIntegrationResponse<StockPreparationExceptionQueueSummary>(response)
}
