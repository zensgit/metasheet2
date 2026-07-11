// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md)
// per-view service module: STOCK PREPARATION LINE (design §"Frontend MVP" view 5).
//
// Preparation lines are generated ONLY from confirmed BOM snapshots, confirmed mappings, and
// confirmed unit rules. Generation never produces final `ready` lines for unresolved mappings, unit
// conflicts, missing child BOM, or invalid quantities — those stay `held`/exception.
//
// INTERNAL-ONLY write: the generation-run POST below is a MULTITABLE-INTERNAL table op (W4a,
// plugin-integration-core stock-preparation-generation-runtime.cjs) — prep-line upsert + create-only
// exceptions + run ledger against the frozen MVP tables. It never writes to ERP/K3: no K3
// Save/Submit/Audit, no production write, no auto ERP material create. The resolution/confirmation
// stamps are server-derived and NEVER in any request body.
//
// VALUES-FREE contract (W5a list, stock-preparation-confirm-reads.cjs): counts by prep_status /
// mapping_status / unit_status, presence booleans, and sha16 row handles only. No drawing numbers,
// ERP material codes, design/issue quantities, unit symbols, or factors ever cross — the
// value-bearing detail surface stays OWNER-GATED (OD-W3-1) and is deliberately NOT in the MVP.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, parseIntegrationResponse, type IntegrationScope } from '../workbench'
import { parseStockPreparationConfirmResponse } from './confirmApi'

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
 *
 * NOTE: sp-fe-shell stub predating the W5a real read below — the design-vocabulary types above stay
 * with it. The endpoint is not served yet; view 5 reads listStockPreparationPrepLines instead.
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

// ── W5a prep-line list (view 5 real read) ─────────────────────────────────────────────────────────

// Fixed FE whitelists mirroring the server's frozen W5 vocabularies (stock-preparation-mvp-generation
// / -material-match .cjs via -confirm-reads.cjs). The MVP engine only ever emits draft/held prep
// statuses; the list route validates the prepStatus filter against EXACTLY these two values, and each
// row enum folds junk stored values to `unknown` (the junk string itself never crosses).
export type StockPreparationPrepLineStatus = 'draft' | 'held'

export const STOCK_PREPARATION_PREP_LINE_STATUSES: readonly StockPreparationPrepLineStatus[] = [
  'draft',
  'held',
]

export type StockPreparationPrepLineMappingStatus =
  | 'matched'
  | 'pending_confirm'
  | 'multi_candidate'
  | 'not_found'
  | 'version_conflict'

export type StockPreparationPrepLineUnitStatus = 'converted' | 'missing_rule' | 'conflict'

/**
 * One values-free prep-line summary row: sha16 handles + status enums + counts + presence booleans
 * ONLY. Drawing numbers, quantities, and unit symbols are value-bearing operator reads — OWNER-GATED
 * (OD-W3-1), never in this shape.
 */
export interface StockPreparationPrepLineRow {
  /** sha16 handle — the only row identity the FE ever holds. */
  stockPrepLineId: string | null
  snapshotBatchId?: string
  snapshotLineId?: string
  prepStatus?: StockPreparationPrepLineStatus | 'unknown'
  mappingStatus?: StockPreparationPrepLineMappingStatus | 'unknown'
  unitStatus?: StockPreparationPrepLineUnitStatus | 'unknown'
  exceptionCount: number
  /** issueQtyFinal present — the quantity VALUE itself never crosses. */
  hasIssueQty: boolean
  /** BOTH ERP identifiers present on the line — the codes themselves never cross. */
  hasErpTarget: boolean
  createdFromRunId?: string
}

export interface StockPreparationPrepLineList {
  rowCount: number
  /** Zero-filled over draft/held; an extra `unknown` key appears only when junk exists. */
  byPrepStatus: Record<string, number>
  byMappingStatus: Record<string, number>
  byUnitStatus: Record<string, number>
  rows: StockPreparationPrepLineRow[]
}

/**
 * Values-free prep-line list for a project (optional snapshot-batch scope + prepStatus filter).
 * GET /api/integration/stock-preparation/prep-lines
 */
export async function listStockPreparationPrepLines(
  scope: IntegrationScope & {
    projectId: string
    snapshotBatchId?: string | null
    prepStatus?: StockPreparationPrepLineStatus | null
  },
): Promise<StockPreparationPrepLineList> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    snapshotBatchId: scope.snapshotBatchId,
    prepStatus: scope.prepStatus,
  })
  const response = await apiFetch(
    `/api/integration/stock-preparation/prep-lines${query ? `?${query}` : ''}`,
  )
  return parseStockPreparationConfirmResponse<StockPreparationPrepLineList>(response)
}

// ── W4a generation run (multitable-internal write) ────────────────────────────────────────────────

/** Engine verdict vocabulary (stock-preparation-mvp-generation.cjs). */
export type StockPreparationGenerationStatus = 'ready' | 'partial' | 'blocked'

export interface StockPreparationGenerationRunResult {
  persisted: boolean
  mode: 'created' | 'refreshed' | 'skipped_existing'
  snapshotBatchId: string
  runId: string | null
  status: StockPreparationGenerationStatus
  /** Server-computed INVARIANT: engine 'ready' AND zero unresolved blocking exceptions. */
  ready: boolean
  unresolvedBlockingExceptionCount: number
  created: { lines: number; exceptions: number; run: number }
  patched: { lines: number; run: number }
  skipped: { exceptions: number }
  evidence: Record<string, unknown>
}

function scopeBodyFields(scope: IntegrationScope & { projectId?: string | null }): Record<string, string> {
  const out: Record<string, string> = {}
  if (scope.tenantId) out.tenantId = scope.tenantId
  if (scope.workspaceId) out.workspaceId = scope.workspaceId
  if (scope.projectId) out.projectId = scope.projectId
  return out
}

/**
 * Run the generation engine over confirmed inputs for a project's latest complete snapshot batch
 * (or an explicit snapshotBatchId). MULTITABLE-INTERNAL persistence only: prep lines upsert,
 * exceptions create-only (human resolutions preserved), run ledger. The body is built from a CLOSED
 * key set mirroring the route allowlist — nothing beyond scope + snapshotBatchId ever crosses.
 * POST /api/integration/stock-preparation/generation/run
 */
export async function runStockPreparationGeneration(
  input: { snapshotBatchId?: string | null },
  scope: IntegrationScope & { projectId: string },
): Promise<StockPreparationGenerationRunResult> {
  const body: Record<string, unknown> = {
    ...scopeBodyFields(scope),
    ...(input.snapshotBatchId ? { snapshotBatchId: input.snapshotBatchId } : {}),
  }
  const response = await apiFetch('/api/integration/stock-preparation/generation/run', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return parseStockPreparationConfirmResponse<StockPreparationGenerationRunResult>(response)
}
