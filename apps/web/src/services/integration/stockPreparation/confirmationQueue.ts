// O1' / O2 — the CONFIRMATION-QUEUE service for the `/stock-prep` workbench.
//
// The O1' ruling (docs/development/takeover-beiliao-20260821/o1-ruling-20260829.md §附) narrowed
// `/stock-prep` to the confirmation-queue workbench: the operator's entry point into the human
// confirmation loop — pending queue, confirm / accept_current / manual_hold, and the value-entry
// pane Q2-A unlocked. This module is the client for exactly the four operator-facing routes of that
// loop; reconcile and ensure stay platform-admin and are not called from here.
//
// VALUES-FREE except for TWO surfaces. The queue list carries decision ids, conflict/status/action
// enums, fingerprints and PRESENCE booleans only — never a source cell value. The first content-
// bearing read is `readStockPreparationValueEntry`, the author's own readback of what they entered;
// the second is `exportStockPreparationPrepLines`, the 按项目导出物料 Excel download — both are gated
// one notch tighter (stock-prep:operate) for that reason. Nothing in this module may route value
// content into a log, an error message, or an aggregate.
import { apiFetch } from '../../../utils/api'
import { buildQuerySuffix, type IntegrationApiEnvelope, type IntegrationScope } from '../workbench'
import { StockPreparationConfirmApiError, parseStockPreparationConfirmResponse } from './confirmApi'

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
 * 按项目导出物料 Excel — the SECOND content-bearing surface in this module (the queue/list/readiness
 * calls above stay values-free). `activeRowCount` is a COUNT, not content — it lets the caller tell a
 * populated download apart from a headers-only one without opening the file, matching the server's
 * `X-Stock-Prep-Export-Row-Count` response header.
 */
export interface StockPreparationExportResult {
  blob: Blob
  filename: string
  activeRowCount: number
}

const EXPORT_ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,80}$/

/** Same filename-parsing idiom as the generic Multitable export client (multitable/api/client.ts). */
function parseExportFilename(header: string | null): string {
  if (header) {
    const star = header.match(/filename\*=(?:UTF-8'')?([^;]+)/i)
    if (star?.[1]) {
      try {
        return decodeURIComponent(star[1].trim().replace(/^["']|["']$/g, ''))
      } catch {
        // fall through to the plain form
      }
    }
    const plain = header.match(/filename="?([^";]+)"?/i)
    if (plain?.[1]) return plain[1].trim()
  }
  return 'stock-preparation-export.xlsx'
}

function parseExportRowCount(header: string | null): number {
  const parsed = header ? Number.parseInt(header, 10) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/**
 * THE project-scoped materials export the warehouse/purchasing button downloads — an authenticated
 * binary GET (apiFetch attaches Authorization/x-tenant-id the same as every other call in this
 * module; a plain `<a href>`/`<a download>` to the API URL would carry none of that), so the caller
 * gets back a Blob + filename to trigger the download from, not a URL to link to.
 * GET /api/integration/stock-preparation/prep-lines/export
 */
export async function exportStockPreparationPrepLines(
  scope: IntegrationScope & { projectNo: string },
): Promise<StockPreparationExportResult> {
  const query = buildQuerySuffix({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectNo: scope.projectNo,
  })
  const response = await apiFetch(`/api/integration/stock-preparation/prep-lines/export${query}`)
  if (!response.ok) {
    let payload: IntegrationApiEnvelope<unknown> | null = null
    try {
      payload = await response.json() as IntegrationApiEnvelope<unknown>
    } catch {
      payload = null
    }
    const code = typeof payload?.error?.code === 'string' && EXPORT_ERROR_CODE_PATTERN.test(payload.error.code)
      ? payload.error.code
      : 'STOCK_PREPARATION_EXPORT_REQUEST_FAILED'
    throw new StockPreparationConfirmApiError(response.status, code, null)
  }
  const blob = await response.blob()
  return {
    blob,
    filename: parseExportFilename(response.headers.get('Content-Disposition')),
    activeRowCount: parseExportRowCount(response.headers.get('X-Stock-Prep-Export-Row-Count')),
  }
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

// ---------------------------------------------------------------------------
// 通知下一步 — the light multi-person handoff
//
// Several people each fill their own fields on a project's prep rows, in order. Whoever is done
// presses 通知下一步; the turn moves on and the group chat is told who is up next. The last step
// additionally tells 仓库/采购.
//
// THIS IS A VISIBLE TURN SIGNAL, NOT A PERMISSION MECHANISM. Nothing here decides who may write
// which column — per-column write enforcement is a separate, deliberately deferred decision. What
// the server does enforce on the advance is that the caller is the CURRENT handler (403
// STOCK_PREPARATION_HANDOFF_NOT_CURRENT_HANDLER) and that nobody advanced the same step first (409
// STOCK_PREPARATION_HANDOFF_STEP_MISMATCH) — i.e. it protects the signal's integrity, not the data.
//
// VALUES-FREE, both directions. Step keys, 0-based indices, booleans and a handler COUNT cross here;
// no material name, no quantity, and no handler NAME — the name a person needs is in the DingTalk
// message, which the server composes.
// ---------------------------------------------------------------------------

/** One step of the chain. `handlerCount` is a COUNT — the names never cross this boundary. */
export interface StockPreparationHandoffStep {
  key: string
  order: number
  handlerCount: number
}

/** Whose turn it is on one project. `configured: false` = this deployment has no chain; feature inert. */
export interface StockPreparationHandoffStatus {
  configured: boolean
  projectNo: string
  steps: StockPreparationHandoffStep[]
  stepCount: number
  /** 0-based index of the CURRENT step; null when `configured` is false. */
  stepIndex: number | null
  currentStepKey: string | null
  /** The current step is the last one — advancing it notifies 仓库/采购. */
  terminal: boolean
  /** The chain has been advanced past the last step. */
  completed: boolean
  /** SERVER-COMPUTED. The client never derives this from a name it holds. */
  isCurrentHandler: boolean
  notifiedStepIndex: number | null
}

/** Frozen server vocabulary for what happened to the notification itself. */
export type StockPreparationHandoffNotifyOutcome = 'sent' | 'failed' | 'skipped' | 'not_configured'

export interface StockPreparationHandoffAdvanceResult {
  projectNo: string
  fromStepKey: string
  /** The NEW current step — null when this advance completed the chain. */
  currentStepKey: string | null
  stepIndex: number | null
  stepCount: number
  /** false = an idempotent replay of the same transition; nothing moved, nothing re-notified. */
  changed: boolean
  /** This advance completed the LAST step. */
  terminal: boolean
  notified: boolean
  notifyOutcome: StockPreparationHandoffNotifyOutcome
}

/**
 * Whose turn it is on this project. Values-free, and inert rather than fatal on a deployment with no
 * handoff config — the route answers 200 with `configured: false`.
 * GET /api/integration/stock-preparation/handoff
 */
export async function readStockPreparationHandoff(
  scope: IntegrationScope & { projectNo: string },
): Promise<StockPreparationHandoffStatus> {
  const query = buildQuerySuffix({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    projectNo: scope.projectNo,
  })
  const response = await apiFetch(`/api/integration/stock-preparation/handoff${query}`)
  return parseStockPreparationConfirmResponse<StockPreparationHandoffStatus>(response)
}

/**
 * Move the turn on one step and let the next person know. The body allowlist is CLOSED server-side —
 * an unexpected key is REFUSED 400, not ignored — so this builds exactly the four permitted keys and
 * omits the scope ones when they are empty rather than sending a null the allowlist has to tolerate.
 * `fromStepKey` is what makes a double-press idempotent instead of a double-advance: the server
 * compares it to the step it actually holds and answers 409 when someone else moved first.
 * POST /api/integration/stock-preparation/handoff/advance
 */
export async function advanceStockPreparationHandoff(
  scope: IntegrationScope & { projectNo: string; fromStepKey: string },
): Promise<StockPreparationHandoffAdvanceResult> {
  const body: Record<string, unknown> = {
    projectNo: scope.projectNo,
    fromStepKey: scope.fromStepKey,
  }
  if (typeof scope.tenantId === 'string' && scope.tenantId.length > 0) body.tenantId = scope.tenantId
  if (typeof scope.workspaceId === 'string' && scope.workspaceId.length > 0) body.workspaceId = scope.workspaceId
  const response = await apiFetch('/api/integration/stock-preparation/handoff/advance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return parseStockPreparationConfirmResponse<StockPreparationHandoffAdvanceResult>(response)
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
