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

/**
 * The ONE conflict type the server can currently act on.
 *
 * The confirm endpoint refuses any other conflict type outright — see `FIRST_CUT_CONFLICT_TYPE` in
 * `plugins/plugin-integration-core/lib/stock-preparation-confirmation-decisions.cjs`, which answers
 * 409 `CONFIRMATION_DECISION_ACTION_CONFLICT_MISMATCH` for everything else. A second, structural
 * wall sits behind it: the readback that turns a confirmed decision into a planner policy only ever
 * consumes the duplicate-group candidates, so an anonymous-family row could not release its hold
 * even if the runtime check let it through.
 *
 * WHY THE UI NEEDS THIS CONSTANT: without it the queue offered "I'll decide…" and all three actions
 * on every row. Observed 2026-09-04 against the customer's own PLM — a project whose BOM lines
 * reference parts absent from the parts library holds its rows as `missing_component`, they appear
 * in the queue as pending, and every action an operator picks fails with a message that reads like
 * "wrong option, try another one". There is no other option: the only way out is fixing the source
 * data. Naming the confirmable type here lets the queue say that instead of inviting a dead end.
 */
export const STOCK_PREPARATION_CONFIRMABLE_CONFLICT_TYPE = 'duplicate_expanded_key'

/** Whether the confirm endpoint can act on this row's conflict type at all. */
export function isConfirmableConflictType(conflictType: string | null | undefined): boolean {
  return conflictType === STOCK_PREPARATION_CONFIRMABLE_CONFLICT_TYPE
}

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

/**
 * 一线看得见自己工厂的项目 — THE THIRD content-bearing shape in this module.
 *
 * One row of the operator's OWN-TENANT project directory. `projectNo` and `projectName` are customer
 * business values and cross only this route and the value-entry/export reads; every other call in
 * this module stays values-free. The server refuses this read to any principal without a tenant of
 * its own, so a values-free platform/admin surface can never receive this shape.
 */
export interface StockPreparationOperatorProject {
  projectId: string
  /** 番号 — the number an operator would otherwise have to memorise. Null if the row carries none. */
  projectNo: string | null
  /** …and the name that makes memorising it unnecessary. */
  projectName: string | null
  projectStatus: string
  lastSyncRunId: string | null
  snapshotBatchCount: number
  openExceptionCount: number
  heldLineCount: number
  readyLineCount: number
  /** Rows in the confirmation ledger still waiting on a human, for THIS project. */
  pendingDecisionCount: number
}

/**
 * The directory response. The two `*Ready` booleans are what make an honest empty state possible:
 * without them "nothing has been synced into this deployment yet", "the confirmation ledger has not
 * been created yet" and "your project is fine and has nothing pending" are the same blank screen.
 */
export interface StockPreparationOperatorDirectory {
  /** Echo of the tenant the server actually scoped to — a handle, never a business value. */
  tenantId: string
  /** False when the project table itself is not provisioned: nothing has ever been synced here. */
  directoryReady: boolean
  /** False when the confirmation-decision ledger is not provisioned: pending counts are all zero. */
  ledgerReady: boolean
  projectCount: number
  pendingProjectCount: number
  projects: StockPreparationOperatorProject[]
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
 * 一线看得见自己工厂的项目 — THE OPERATOR'S OWN-TENANT PROJECT DIRECTORY / WORKLIST.
 *
 * The whole directory comes back, not only the projects with pending work, because the front end has
 * to be able to tell "that number is not in this system" from "that project is real and has nothing
 * pending" — and only the full list can distinguish them. Filtering to pending-only is a view over
 * this response, never a narrowing of the request.
 *
 * `tenantId` is sent for shape-compatibility with every other call here and is NOT a selector: the
 * server derives the scope from the authenticated principal and refuses any value that is not the
 * caller's own tenant.
 * GET /api/integration/stock-preparation/operator/projects
 */
export async function readStockPreparationOperatorDirectory(
  scope: IntegrationScope,
): Promise<StockPreparationOperatorDirectory> {
  const query = buildQuerySuffix({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const response = await apiFetch(`/api/integration/stock-preparation/operator/projects${query}`)
  return parseStockPreparationConfirmResponse<StockPreparationOperatorDirectory>(response)
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
// which column — per-column write scoping exists since #5447 and is a SEPARATE mechanism
// (`field_permissions` rows written at pack install, keyed by role and column) that never consults
// the turn, so the cursor moving grants and revokes nothing. What the server does enforce on the
// advance is that the caller is the CURRENT handler (403
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
  /** The highest step whose completion has had a notification dispatched; null = none yet. */
  notifiedStepIndex: number | null
  /**
   * The step key whose group notice has NOT gone out yet and STILL CAN — pressing 通知下一步 again
   * sends it. Non-null only when the caller is that step's configured handler. `null` when there is
   * nothing owed, or when the owed hop is no longer this caller's to resend.
   *
   * Server-computed on purpose: it depends on the monotonic claim column and on the step's roster,
   * neither of which the client holds.
   */
  resendableStepKey: string | null
  /**
   * Step keys whose group notice can never be sent again — a later hop's claim moved the monotonic
   * max past them. Read back from the append-only trail, because an interior gap has no other
   * representation.
   */
  lostStepKeys: string[]
  /**
   * Does this chain notify at all? Without it the page cannot tell a hop whose notice was LOST from a
   * turn-state-only deployment, whose `notifiedStepIndex` is null forever and correctly so.
   */
  notificationsConfigured: boolean
}

/**
 * Frozen server vocabulary for what happened to the notification itself.
 *
 * `partial` exists because the TERMINAL hop fans out to two groups (仓库 and 采购) and the host keeps
 * going past a failed one. Collapsing that into `sent` told the operator the group had been told when
 * one of the two had not — on the one hop the whole feature exists for, and irreversibly, because the
 * at-most-once claim means clicking again can never re-send it.
 *
 * `no_destination` replaced `not_configured`, which conflated two different facts: "this deployment
 * has no chain" (the advance route's 501, which has its own error copy) and "this CONFIGURED chain
 * sends nothing for this hop" (a legal turn-state-only deployment, or a host that wired no notifier).
 * The second was being shown the first's words — telling an operator whose turn had just moved that
 * an admin still had to set the chain up, on a screen whose button only renders because the chain IS
 * configured.
 */
export type StockPreparationHandoffNotifyOutcome =
  | 'sent'
  | 'partial'
  | 'failed'
  | 'skipped'
  | 'no_destination'

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
  /**
   * This request found the hop already moved and its notification still OWED, and took the claim.
   *
   * It exists because since the claim became a separate compare-and-set, `changed: false` no longer
   * means "nothing needed sending": a replay is exactly how an interrupted hop gets finished. The
   * notice reads `notifyOutcome` to decide what happened and this to decide how to say it.
   */
  resumed: boolean
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
