// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md)
// per-view service module: EXCEPTION QUEUE (design §"Frontend MVP" view 6).
//
// Every uncertain row is visible and actionable instead of being dropped. Blocking exceptions stay
// visible and prevent final confirmation while mapping/unit status is unresolved.
//
// INTERNAL-ONLY writes: the resolve / bulk-resolve POSTs below are MULTITABLE-INTERNAL row patches
// against the frozen MVP exception table (W4a, plugin-integration-core
// stock-preparation-generation-runtime.cjs). No external ERP/K3 write, no auto-retry.
//
// SERVER-STAMPED resolution: resolvedBy / resolvedAt are NEVER in any request body — the route
// derives the operator identity and the module stamps the time; a body that carries either is
// rejected as an unknown field. Every body below is built from a CLOSED key set mirroring the
// route's per-endpoint allowlist. Bulk resolve is SAME-REASON gated server-side (#3890): mixed
// exceptionTypes are refused with 409 EXCEPTION_BULK_MIXED_TYPES before any patch — the FE mirror
// in view 6 is convenience only, the server gate stays authoritative.
//
// VALUES-FREE contract (W5a list, stock-preparation-confirm-reads.cjs): counts by exception_type /
// severity / status, sha16 handles, and presence booleans only. The exception `message` cell
// (human-readable business text) NEVER crosses; resolver identity surfaces as a presence boolean.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, parseIntegrationResponse, type IntegrationScope } from '../workbench'
import { parseStockPreparationConfirmResponse } from './confirmApi'

// Fixed FE whitelists mirroring the server's frozen vocabularies (EXCEPTION_TYPES in
// stock-preparation-mvp-generation.cjs; severity/status/resolution closed sets in
// stock-preparation-confirm-reads.cjs). Junk stored values fold to `unknown` server-side.
export type StockPreparationExceptionType =
  | 'missing_mapping'
  | 'multi_candidate'
  | 'version_conflict'
  | 'erp_item_missing'
  | 'unit_missing'
  | 'unit_conflict'
  | 'invalid_qty'
  | 'missing_child_bom'

export const STOCK_PREPARATION_EXCEPTION_TYPES: readonly StockPreparationExceptionType[] = [
  'missing_mapping',
  'multi_candidate',
  'version_conflict',
  'erp_item_missing',
  'unit_missing',
  'unit_conflict',
  'invalid_qty',
  'missing_child_bom',
]

export type StockPreparationExceptionSeverity = 'info' | 'warning' | 'blocking'

export type StockPreparationExceptionStatus = 'open' | 'resolved' | 'ignored' | 'deferred'

export const STOCK_PREPARATION_EXCEPTION_STATUSES: readonly StockPreparationExceptionStatus[] = [
  'open',
  'resolved',
  'ignored',
  'deferred',
]

/** The four human resolution reasons — the resolve routes accept EXACTLY this vocabulary. */
export type StockPreparationResolutionAction =
  | 'mapping_confirmed'
  | 'unit_rule_confirmed'
  | 'accepted_change'
  | 'manual_hold'

export const STOCK_PREPARATION_RESOLUTION_ACTIONS: readonly StockPreparationResolutionAction[] = [
  'mapping_confirmed',
  'unit_rule_confirmed',
  'accepted_change',
  'manual_hold',
]

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
 *
 * NOTE: sp-fe-shell stub predating the W5a real read below — the endpoint is not served yet;
 * view 6 reads listStockPreparationExceptions instead.
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

// ── W5a exception queue list (view 6 real read) ───────────────────────────────────────────────────

/**
 * One values-free queue row: sha16 handles + enums + booleans ONLY — the exception `message`
 * (human-readable business text) never crosses; resolver identity is a presence boolean.
 */
export interface StockPreparationExceptionRow {
  /** sha16 handle — the only row identity the FE ever holds; used for resolve actions. */
  exceptionId: string | null
  snapshotBatchId?: string
  snapshotLineId?: string
  stockPrepLineId?: string
  exceptionType?: StockPreparationExceptionType | 'unknown'
  severity?: StockPreparationExceptionSeverity | 'unknown'
  status?: StockPreparationExceptionStatus | 'unknown'
  resolutionAction?: StockPreparationResolutionAction | 'unknown'
  resolved: boolean
  resolvedByPresent: boolean
}

export interface StockPreparationExceptionList {
  rowCount: number
  /** Blocking rows not yet resolved — the count that gates generation `ready`. */
  unresolvedBlockingCount: number
  /** Zero-filled over the closed vocabularies; an extra `unknown` key appears only for junk. */
  byType: Record<string, number>
  byStatus: Record<string, number>
  bySeverity: Record<string, number>
  rows: StockPreparationExceptionRow[]
}

/**
 * Values-free exception queue for a project (optional batch scope + status/type/severity filters).
 * GET /api/integration/stock-preparation/exceptions
 */
export async function listStockPreparationExceptions(
  scope: IntegrationScope & {
    projectId: string
    snapshotBatchId?: string | null
    status?: StockPreparationExceptionStatus | null
    exceptionType?: StockPreparationExceptionType | null
    severity?: StockPreparationExceptionSeverity | null
  },
): Promise<StockPreparationExceptionList> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    snapshotBatchId: scope.snapshotBatchId,
    status: scope.status,
    exceptionType: scope.exceptionType,
    severity: scope.severity,
  })
  const response = await apiFetch(
    `/api/integration/stock-preparation/exceptions${query ? `?${query}` : ''}`,
  )
  return parseStockPreparationConfirmResponse<StockPreparationExceptionList>(response)
}

// ── W4a human resolution writes (multitable-internal only) ────────────────────────────────────────

function scopeBodyFields(scope: IntegrationScope & { projectId?: string | null }): Record<string, string> {
  const out: Record<string, string> = {}
  if (scope.tenantId) out.tenantId = scope.tenantId
  if (scope.workspaceId) out.workspaceId = scope.workspaceId
  if (scope.projectId) out.projectId = scope.projectId
  return out
}

export interface StockPreparationExceptionResolveResult {
  persisted: boolean
  mode: 'resolved' | 'skipped_already_resolved'
  exceptionId: string
  evidence: Record<string, unknown>
}

/**
 * Resolve ONE exception — the server patches EXACTLY the resolution quartet (status /
 * resolutionAction / resolvedBy / resolvedAt), stamping identity + time itself; the body carries
 * only scope + exceptionId + resolutionAction.
 * POST /api/integration/stock-preparation/exceptions/resolve
 */
export async function resolveStockPreparationException(
  input: { exceptionId: string; resolutionAction: StockPreparationResolutionAction },
  scope: IntegrationScope & { projectId?: string | null } = {},
): Promise<StockPreparationExceptionResolveResult> {
  const body: Record<string, unknown> = {
    ...scopeBodyFields(scope),
    exceptionId: input.exceptionId,
    resolutionAction: input.resolutionAction,
  }
  const response = await apiFetch('/api/integration/stock-preparation/exceptions/resolve', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return parseStockPreparationConfirmResponse<StockPreparationExceptionResolveResult>(response)
}

export interface StockPreparationExceptionBulkResolveResult {
  persisted: boolean
  mode: 'resolved' | 'skipped_already_resolved'
  resolved: number
  skipped: number
  /** The single shared exceptionType of the batch (same-reason gate passed). */
  exceptionType: string
  evidence: Record<string, unknown>
}

/**
 * Bulk resolve — SAME-REASON gated (#3890): the server refuses mixed exceptionTypes with
 * 409 EXCEPTION_BULK_MIXED_TYPES BEFORE any patch, and bounds the id list. Already-resolved rows
 * are skipped, never re-stamped.
 * POST /api/integration/stock-preparation/exceptions/bulk-resolve
 */
export async function bulkResolveStockPreparationExceptions(
  input: { exceptionIds: string[]; resolutionAction: StockPreparationResolutionAction },
  scope: IntegrationScope & { projectId?: string | null } = {},
): Promise<StockPreparationExceptionBulkResolveResult> {
  const body: Record<string, unknown> = {
    ...scopeBodyFields(scope),
    exceptionIds: input.exceptionIds,
    resolutionAction: input.resolutionAction,
  }
  const response = await apiFetch('/api/integration/stock-preparation/exceptions/bulk-resolve', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return parseStockPreparationConfirmResponse<StockPreparationExceptionBulkResolveResult>(response)
}
