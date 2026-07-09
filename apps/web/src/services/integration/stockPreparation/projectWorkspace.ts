// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md)
// per-view service stub: PROJECT WORKSPACE (design §"Frontend MVP" view 1).
//
// READONLY-FIRST: every function here issues a GET against a values-free summary endpoint.
// There is NO write path in this module — no external ERP/K3 write, no K3 Save/Submit/Audit, no
// apply/generate. Business-row writes (when they land in a later wave) are MULTITABLE-INTERNAL table
// ops behind their own owner-gated ladder and never live in this stub.
//
// VALUES-FREE contract: the shapes below carry ONLY counts / status enums / booleans and internal
// MetaSheet navigation handles (projectId / runId). They deliberately EXCLUDE customer business
// values — no source_project_no, project_name, owner, PLM drawing numbers, ERP material codes,
// quantities, host / tenant / connection strings, credentials, or raw PLM/K3/ERP rows.
//
// The backend routes may 404 until later stock-preparation waves land; these are type-safe stubs
// that reuse the exact landed integration transport (apiFetch + parseIntegrationResponse +
// buildQueryString from services/integration/workbench).
import { apiFetch } from '../../../utils/api'
import { buildQueryString, parseIntegrationResponse, type IntegrationScope } from '../workbench'

export type StockPreparationProjectStatus = 'active' | 'paused' | 'closed' | 'archived'

/** Values-free per-project summary. `projectId` is an internal MetaSheet handle used for routing. */
export interface StockPreparationProjectSummary {
  projectId: string
  projectStatus: StockPreparationProjectStatus | string
  lastSyncRunId: string | null
  snapshotBatchCount: number
  openExceptionCount: number
  readyLineCount: number
  heldLineCount: number
}

export interface StockPreparationWorkspaceOverview {
  projectCount: number
  statusCounts: Record<string, number>
  projects: StockPreparationProjectSummary[]
}

/**
 * List the projects that can produce stock-preparation lines, as a values-free summary.
 * GET /api/integration/stock-preparation/projects
 */
export async function getStockPreparationWorkspaceOverview(
  scope: IntegrationScope = {},
): Promise<StockPreparationWorkspaceOverview> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  })
  const response = await apiFetch(
    `/api/integration/stock-preparation/projects${query ? `?${query}` : ''}`,
  )
  return parseIntegrationResponse<StockPreparationWorkspaceOverview>(response)
}
