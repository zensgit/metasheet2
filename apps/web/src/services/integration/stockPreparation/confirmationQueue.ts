// O1' / O2 — the CONFIRMATION-QUEUE service for the `/stock-prep` workbench.
//
// The O1' ruling (docs/development/takeover-beiliao-20260821/o1-ruling-20260829.md §附) narrowed
// `/stock-prep` to the confirmation-queue workbench: the operator's entry point into the human
// confirmation loop — pending queue, confirm / accept_current / manual_hold, and the value-entry
// pane Q2-A unlocked. This module is the client for exactly the four operator-facing routes of that
// loop; reconcile and ensure stay platform-admin and are not called from here.
//
// VALUES-FREE except for ONE surface. The queue list carries decision ids, conflict/status/action
// enums, fingerprints and PRESENCE booleans only — never a source cell value. The single
// content-bearing read is `readStockPreparationValueEntry`, the author's own readback of what they
// entered, which the server gates one notch tighter (stock-prep:operate) for that reason. Nothing in
// this module may route value content into a log, an error message, or an aggregate.
import { apiFetch } from '../../../utils/api'
import { buildQuerySuffix, type IntegrationScope } from '../workbench'
import { parseStockPreparationConfirmResponse } from './confirmApi'

/** Frozen server status vocabulary (stock-preparation-confirmation-decisions.cjs STATUSES). */
export type StockPreparationDecisionStatus = 'pending' | 'confirmed' | 'superseded'

export const STOCK_PREPARATION_DECISION_STATUSES: readonly StockPreparationDecisionStatus[] = [
  'pending',
  'confirmed',
  'superseded',
]

/**
 * Frozen server action vocabulary (RESOLUTION_ACTIONS). All three are implemented as of the O1'
 * wave: keep_multiple_rows RESOLVES the duplicate group; accept_current parks it under the named
 * source_correction_required policy; manual_hold parks it under hold. Neither of the latter two ever
 * releases a group — the readback policy map, not this list, decides that server-side.
 */
export type StockPreparationResolutionAction = 'keep_multiple_rows' | 'accept_current' | 'manual_hold'

export const STOCK_PREPARATION_RESOLUTION_ACTIONS: readonly StockPreparationResolutionAction[] = [
  'keep_multiple_rows',
  'accept_current',
  'manual_hold',
]

/** One values-free queue row. Value/notes are PRESENCE booleans; contents never cross here. */
export interface StockPreparationDecisionRow {
  decisionId: string | null
  conflictType: string | null
  status: string | null
  resolutionAction: string | null
  inputFingerprint: string | null
  sourceRevisionPresent: boolean
  confirmedByPresent: boolean
  confirmedAtPresent: boolean
  notesPresent: boolean
  resolvedValuePresent: boolean
  resolvedAuxValuePresent: boolean
}

export interface StockPreparationDecisionQueue {
  rowCount: number
  byStatus: Record<string, number>
  byResolutionAction: Record<string, number>
  /** Human-PARKED rows (confirmed x manual_hold) — decided and standing held, not still open. */
  parkedCount: number
  rows: StockPreparationDecisionRow[]
}

export interface StockPreparationDecisionReadiness {
  ready?: boolean
  [key: string]: unknown
}

/** The ONE content-bearing shape in this module. Never log it, never aggregate it. */
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

export interface StockPreparationConfirmResult {
  ok?: boolean
  status?: string
  resolutionAction?: string
  [key: string]: unknown
}

/**
 * Provisioning state of the ledger target. Values-free.
 * GET /api/integration/stock-preparation/confirmation-decisions/readiness
 */
export async function readStockPreparationDecisionReadiness(
  scope: IntegrationScope,
): Promise<StockPreparationDecisionReadiness> {
  const query = buildQuerySuffix({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const response = await apiFetch(`/api/integration/stock-preparation/confirmation-decisions/readiness${query}`)
  return parseStockPreparationConfirmResponse<StockPreparationDecisionReadiness>(response)
}

/**
 * THE authoritative values-free confirmation queue for a project number.
 * GET /api/integration/stock-preparation/confirmation-decisions
 */
export async function listStockPreparationDecisions(
  scope: IntegrationScope & { projectNo: string; status?: StockPreparationDecisionStatus | null },
): Promise<StockPreparationDecisionQueue> {
  const query = buildQuerySuffix({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectNo: scope.projectNo,
    status: scope.status,
  })
  const response = await apiFetch(`/api/integration/stock-preparation/confirmation-decisions${query}`)
  return parseStockPreparationConfirmResponse<StockPreparationDecisionQueue>(response)
}

/**
 * The author's own value readback for ONE decision — the single surface where entered contents
 * cross. Gated on stock-prep:operate server-side, and its control is gated on the same code here.
 * GET /api/integration/stock-preparation/confirmation-decisions/value-entry
 */
export async function readStockPreparationValueEntry(
  scope: IntegrationScope & { decisionId: string },
): Promise<StockPreparationDecisionValueEntry> {
  const query = buildQuerySuffix({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    decisionId: scope.decisionId,
  })
  const response = await apiFetch(`/api/integration/stock-preparation/confirmation-decisions/value-entry${query}`)
  return parseStockPreparationConfirmResponse<StockPreparationDecisionValueEntry>(response)
}

/**
 * Confirm one decision. The body allowlist is the server's
 * VALID_STOCK_PREPARATION_CONFIRMATION_DECISION_CONFIRM_BODY_KEYS verbatim — no tenantId/projectId
 * (auth-derived server-side, and a steering vector on a write) and no confirmedBy/confirmedAt (the
 * server stamps the real principal, which is what keeps a customer operator's confirmations
 * attributable).
 * POST /api/integration/stock-preparation/confirmation-decisions/confirm
 */
export async function confirmStockPreparationDecision(input: {
  decisionId: string
  inputFingerprint: string
  resolutionAction: StockPreparationResolutionAction
  resolvedValue?: string
  resolvedAuxValue?: string
  notes?: string
}): Promise<StockPreparationConfirmResult> {
  const body: Record<string, unknown> = {
    decisionId: input.decisionId,
    inputFingerprint: input.inputFingerprint,
    resolutionAction: input.resolutionAction,
  }
  if (typeof input.resolvedValue === 'string' && input.resolvedValue.length > 0) body.resolvedValue = input.resolvedValue
  if (typeof input.resolvedAuxValue === 'string' && input.resolvedAuxValue.length > 0) body.resolvedAuxValue = input.resolvedAuxValue
  if (typeof input.notes === 'string' && input.notes.length > 0) body.notes = input.notes
  const response = await apiFetch('/api/integration/stock-preparation/confirmation-decisions/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return parseStockPreparationConfirmResponse<StockPreparationConfirmResult>(response)
}
