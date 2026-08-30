// O2 / R-11 — the confirmation-decision LEDGER client: the operator surface of the `/stock-prep`
// workbench (o1-ruling-20260829.md 附:同日第二项裁决).
//
// Three endpoints, and deliberately only three:
//   GET  /confirmation-decisions             the AUTHORITATIVE values-free queue   (stockprep:read)
//   GET  /confirmation-decisions/value-entry the ONE value-bearing read            (stockprep:confirm)
//   POST /confirmation-decisions/confirm     the decision write                    (stockprep:confirm)
//
// NOT here, on purpose:
//   - `/confirmation-decisions/ensure` — provisioning, admin-only, no operator control exists.
//   - `.../confirmation-decisions/reconcile` — it re-reads the customer's external source and can
//     burn a one-shot armed B2a claim. Owner-level, admin-only, and rendered by NOTHING at any tier;
//     an admin performs it out of band. A client for it here would be a control waiting to be shown.
//
// VALUES-FREE except where the ruling unlocked it: the queue type below carries counts, ids, hashes
// and status enums only. `resolvedValue` / `resolvedAuxValue` / `notes` appear in exactly one type
// (StockPreparationDecisionValueEntry) reached by exactly one function, and the queue reports their
// presence as booleans — never their contents.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, type IntegrationScope } from '../workbench'
import { parseStockPreparationConfirmResponse } from './confirmApi'

/** The frozen O1-A resolution vocabulary the confirm route accepts. */
export type StockPreparationDecisionAction =
  | 'keep_multiple_rows'
  | 'accept_current'
  | 'manual_hold'

export const STOCK_PREPARATION_DECISION_ACTIONS: readonly StockPreparationDecisionAction[] = Object.freeze([
  'keep_multiple_rows',
  'accept_current',
  'manual_hold',
])

/** Values-free queue row: ids, enums, fingerprints, and PRESENCE booleans. Never a cell value. */
export interface StockPreparationDecisionRow {
  decisionId: string | null
  conflictType: string | null
  status: string | null
  resolutionAction: string | null
  inputFingerprint: string | null
  sourceRevisionPresent: boolean
  confirmedByPresent: boolean
  confirmedAtPresent: boolean
  /** Whether a value entry exists — the contents require `stockprep:confirm` and a separate read. */
  notesPresent: boolean
  resolvedValuePresent: boolean
  resolvedAuxValuePresent: boolean
}

export interface StockPreparationDecisionList {
  rowCount: number
  byStatus: Record<string, number>
  byResolutionAction: Record<string, number>
  /** Confirmed `manual_hold` rows: decided and standing held, as opposed to still-open PENDING. */
  parkedCount: number
  rows: StockPreparationDecisionRow[]
}

/**
 * The values-free confirmation queue for a project number.
 * GET /api/integration/stock-preparation/confirmation-decisions — `stockprep:read`.
 */
export async function listStockPreparationDecisions(
  scope: IntegrationScope & { projectNo: string; status?: string | null },
): Promise<StockPreparationDecisionList> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectNo: scope.projectNo,
    status: scope.status,
  })
  const response = await apiFetch(
    `/api/integration/stock-preparation/confirmation-decisions${query ? `?${query}` : ''}`,
  )
  return parseStockPreparationConfirmResponse<StockPreparationDecisionList>(response)
}

/**
 * The ONE value-bearing read (O1' unlock). Contents stay in the caller's local state and are never
 * folded into the queue list, a count, or an error payload.
 * GET /api/integration/stock-preparation/confirmation-decisions/value-entry — `stockprep:confirm`.
 */
export interface StockPreparationDecisionValueEntry {
  decisionId: string
  conflictType: string | null
  status: string | null
  resolutionAction: string | null
  inputFingerprint: string | null
  valueEntry: {
    resolvedValue: string | null
    resolvedAuxValue: string | null
    notes: string | null
  }
}

export async function readStockPreparationDecisionValueEntry(
  scope: IntegrationScope & { decisionId: string },
): Promise<StockPreparationDecisionValueEntry> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    decisionId: scope.decisionId,
  })
  const response = await apiFetch(
    `/api/integration/stock-preparation/confirmation-decisions/value-entry${query ? `?${query}` : ''}`,
  )
  return parseStockPreparationConfirmResponse<StockPreparationDecisionValueEntry>(response)
}

export interface StockPreparationDecisionConfirmResult {
  mode: string
  decisionId: string
  status: string
  resolutionAction: string
  /** Values-free: counts and presence booleans only. */
  evidence: Record<string, unknown>
}

/**
 * Confirm one decision. `inputFingerprint` is carried back from the queue row so a decision can
 * never be applied to a generation the operator did not look at (the server refuses a mismatch).
 *
 * NO SCOPE FIELDS IN THE BODY. The confirm route's body allowlist is exactly the six keys below
 * and a `tenantId` / `workspaceId` would be rejected with 400 — the tenant is derived from the
 * authenticated principal (`resolveAuthUserTenantId`), because on a write route a request-supplied
 * tenant is a steering vector. Identity is likewise server-stamped: confirmedBy/confirmedAt are
 * never request-supplied.
 * POST /api/integration/stock-preparation/confirmation-decisions/confirm — `stockprep:confirm`.
 */
export async function confirmStockPreparationDecision(input: {
  decisionId: string
  inputFingerprint: string
  resolutionAction: StockPreparationDecisionAction
  resolvedValue?: string
  resolvedAuxValue?: string
  notes?: string
}): Promise<StockPreparationDecisionConfirmResult> {
  const body: Record<string, unknown> = {
    decisionId: input.decisionId,
    inputFingerprint: input.inputFingerprint,
    resolutionAction: input.resolutionAction,
  }
  // Omitted rather than sent empty: the server distinguishes "not filled" from "filled blank"
  // (O1' Q3 requires 未填 and 差异 to stay distinguishable in the T-2 reconciliation view).
  if (input.resolvedValue) body.resolvedValue = input.resolvedValue
  if (input.resolvedAuxValue) body.resolvedAuxValue = input.resolvedAuxValue
  if (input.notes) body.notes = input.notes

  const response = await apiFetch('/api/integration/stock-preparation/confirmation-decisions/confirm', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return parseStockPreparationConfirmResponse<StockPreparationDecisionConfirmResult>(response)
}
