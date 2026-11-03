// 备料分批拉取第一期 step 4 PR-7 — 「拉取待确认」: the client for the puller's six routes (design §13; PR-4 #6565) and the
// pure helpers its page is built from. Kept out of any `api/` directory on purpose (the vite browser harness routes
// `**/api/**`).
//
//   GET  …/projects/:projectNo/refresh/holds                      the PRIVATE hold page (values) + the read receipt
//   GET  …/projects/:projectNo/refresh/holds/:holdId/evidence      the demand facts behind one hold
//   POST …/projects/:projectNo/refresh/holds/:holdId/keep          「暂不处理」: audit only
//   POST …/projects/:projectNo/refresh/continuations/confirm       confirm a candidate / re-confirm a relationship
//   GET  …/projects/:projectNo/refresh/continuations/:id           a relationship's header + members (its revision)
//   POST …/projects/:projectNo/refresh/continuations/:id/end       end a relationship with an explicit outcome
//
// All six are the PULL tier (`stock-prep:pull`; the ladder admits `stock-prep:admin` and a platform admin) and every
// body / query is CLOSED-ALLOW-LISTED server-side (http-routes.cjs `VALID_STOCK_PREPARATION_REFRESH_*`): an extra key is
// 400. So this module sends EXACTLY those keys — `tenantId` only when non-blank and NEVER `workspaceId` (the board's
// `buildQuerySuffix({ tenantId, workspaceId })` would 400 here), and every write carries `confirmProjectNo` (the route
// compares it with the path): the number the puller TYPED for confirm / re-confirm / end (PR-7b, review N3), the
// opened project for 「暂不处理」 (R-62 ⑧). StockPreparationRefreshQueue.spec.ts (RQ-BODY) reads the
// server's allow-lists out of the plugin source, so a server change reds there.
//
// VALUES. The hold page, the evidence and the relationship detail are VALUE-BEARING by design (the pull tier, audited
// server-side before the response). This module returns them to the page and keeps nothing: no cache, no storage. The
// error path carries clamped tokens only (StockPreparationConfirmApiError).
import { apiFetch } from '../../../utils/api'
import type { IntegrationScope } from '../workbench'
import { parseStockPreparationConfirmResponse } from './confirmApi'

const BASE = '/api/integration/stock-preparation/projects'

/** Mirrors of the server's closed allow-lists (http-routes.cjs). RQ-BODY pins them against the plugin source. */
export const STOCK_PREP_REFRESH_HOLDS_QUERY_KEYS = Object.freeze(['tenantId', 'cursor', 'limit', 'holdId', 'pairCursor', 'pairLimit', 'receipt'])
export const STOCK_PREP_REFRESH_EVIDENCE_QUERY_KEYS = Object.freeze(['tenantId', 'cursor'])
export const STOCK_PREP_REFRESH_DETAIL_QUERY_KEYS = Object.freeze(['tenantId'])
export const STOCK_PREP_REFRESH_CONFIRM_REQUEST_KEYS = Object.freeze([
  'tenantId', 'confirmProjectNo', 'holdId', 'holdFingerprint', 'comparisonFingerprint', 'evidenceFingerprint',
  'candidateId', 'continuation', 'readReceipt', 'basis', 'acknowledge',
])
export const STOCK_PREP_REFRESH_KEEP_REQUEST_KEYS = Object.freeze(['tenantId', 'confirmProjectNo', 'holdFingerprint'])
export const STOCK_PREP_REFRESH_END_REQUEST_KEYS = Object.freeze(['tenantId', 'confirmProjectNo', 'revision', 'outcome', 'note', 'factsHoldId', 'factsHoldFingerprint'])

// ---------------------------------------------------------------------------
// shapes (the server's holdPayload / listHolds / readContinuation, PR-4) — loosely typed where they carry values
// ---------------------------------------------------------------------------

export interface StockPrepRefreshPairPage {
  index: number
  count: number
  size: number
  next: number | null
}

export interface StockPrepRefreshComparisonField {
  item?: number
  status?: string
  old?: unknown
  new?: unknown
}

export interface StockPrepRefreshComparisonItem {
  relativePath?: unknown
  componentSourceId?: unknown
  root?: boolean
  fields?: Record<string, StockPrepRefreshComparisonField>
}

export interface StockPrepRefreshComparison {
  outcome?: string
  items?: StockPrepRefreshComparisonItem[] | null
  parentEdgeUsage?: unknown
}

export interface StockPrepRefreshCandidate {
  candidateId: string | null
  componentSourceId?: unknown
  newPositionKeys?: unknown[]
  oldRootKeys?: unknown[]
  oldRootRecordIds?: unknown[]
  pairs?: unknown[] | null
  comparison?: StockPrepRefreshComparison | null
  parentEdgeUsage?: unknown
  demand?: unknown
  history?: string
  shapeSubTokens?: string[]
  pairingProblems?: unknown[]
  duplicateResolvedRootKey?: boolean
}

export interface StockPrepRefreshVerification {
  verdict: string | null
  statusReason: string | null
  steps?: Record<string, unknown>
  pairs?: unknown[] | null
  pairingProblems?: unknown[]
  comparison?: StockPrepRefreshComparison | null
  demand?: unknown
  /** An integer, or null / ABSENT when the computation recorded none (delta review N-7: both mean "no count"). */
  componentNewPositionCount?: number | null
}

export interface StockPrepRefreshContentChange {
  recordId?: unknown
  recordVersion?: unknown
  key?: unknown
  reason?: unknown
  fields?: Record<string, unknown>
  inContinuation?: unknown
  humanColumnsPresent?: Record<string, unknown>
}

export interface StockPrepRefreshHold {
  id: string
  kind: string
  status: string
  confirmable: boolean
  notConfirmableReason: string | null
  shapeToken: string | null
  runbookOnly: boolean
  continuationId: string | null
  fingerprint: string
  comparisonFingerprint: string | null
  evidenceFingerprint: string | null
  pairingFingerprint: string | null
  openedAt: string | null
  lastSeenAt: string | null
  history: string
  candidates: StockPrepRefreshCandidate[]
  verification: StockPrepRefreshVerification | null
  contentChanges: StockPrepRefreshContentChange[]
  detail: unknown
  pairPage: StockPrepRefreshPairPage | null
}

export interface StockPrepRefreshReceipt {
  id: string
  expiresAt: string
  holds: Record<string, { pageCount: number; pagesServed: number[]; complete: boolean }>
}

export interface StockPrepRefreshPageSummary {
  readable: boolean
  status: string
  governed: string
  counts: Record<string, number> | null
  pilot: boolean
}

export interface StockPrepRefreshHoldPage {
  refresh: StockPrepRefreshPageSummary
  page: { holds: StockPrepRefreshHold[]; next: string | null; limit: number; pairLimit: number }
  /** Null for a project the batch refresh does not govern (the server issues no receipt for it). */
  readReceipt: StockPrepRefreshReceipt | null
}

export interface StockPrepRefreshContinuationDetail {
  continuation: { id: string; status: string; revision: number; statusReason?: string | null; [key: string]: unknown }
  members: unknown[]
  holds: Array<{ id: string; kind: string; status: string; confirmable: boolean; runbookOnly: boolean; fingerprint: string }>
}

export interface StockPrepRefreshDecisionResult {
  continuationId?: string
  revision?: number
  status?: string
  endedOutcome?: string
  nextStep?: string
  state?: string
}

export interface StockPrepRefreshHoldsQuery {
  cursor?: string | null
  holdId?: string | null
  pairCursor?: number | null
  receipt?: string | null
}

export interface StockPrepRefreshConfirmBody {
  confirmProjectNo: string
  holdId: string
  holdFingerprint: string
  comparisonFingerprint: string
  evidenceFingerprint: string
  readReceipt: string
  candidateId?: string
  continuation?: { id: string; revision: number }
  basis?: { kind: 'puller_confirmed_same_demand'; note?: string }
  acknowledge?: { historyUnknown: true }
}

export interface StockPrepRefreshEndBody {
  confirmProjectNo: string
  revision: number
  outcome: StockPrepRefreshEndOutcome
  note?: string
  factsHoldId?: string
  factsHoldFingerprint?: string
}

export type StockPrepRefreshEndOutcome = 'release_to_normal_refresh' | 'escalate_special_repair'

export interface StockPrepRefreshQueueApi {
  listHolds(projectNo: string, query?: StockPrepRefreshHoldsQuery): Promise<StockPrepRefreshHoldPage>
  readEvidence(projectNo: string, holdId: string): Promise<unknown>
  readContinuation(projectNo: string, continuationId: string): Promise<StockPrepRefreshContinuationDetail>
  keep(projectNo: string, holdId: string, body: { confirmProjectNo: string; holdFingerprint: string }): Promise<{ kept: boolean; holdId: string }>
  confirm(projectNo: string, body: StockPrepRefreshConfirmBody): Promise<StockPrepRefreshDecisionResult>
  end(projectNo: string, continuationId: string, body: StockPrepRefreshEndBody): Promise<StockPrepRefreshDecisionResult>
}

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

function tenantOf(scope: IntegrationScope): string | null {
  return typeof scope.tenantId === 'string' && scope.tenantId.trim().length > 0 ? scope.tenantId : null
}

function querySuffix(entries: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

function projectPath(projectNo: string): string {
  return `${BASE}/${encodeURIComponent(projectNo)}/refresh`
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return parseStockPreparationConfirmResponse<T>(response)
}

/** Adds `tenantId` when the scope has one; never `workspaceId`. */
function withTenant(scope: IntegrationScope, body: Record<string, unknown>): Record<string, unknown> {
  const tenantId = tenantOf(scope)
  return tenantId ? { tenantId, ...body } : { ...body }
}

export function createStockPrepRefreshQueueApi(scope: IntegrationScope = {}): StockPrepRefreshQueueApi {
  return {
    async listHolds(projectNo, query = {}) {
      const suffix = querySuffix({
        tenantId: tenantOf(scope),
        cursor: query.cursor ?? null,
        holdId: query.holdId ?? null,
        pairCursor: typeof query.pairCursor === 'number' && query.pairCursor > 0 ? query.pairCursor : null,
        receipt: query.receipt ?? null,
      })
      const response = await apiFetch(`${projectPath(projectNo)}/holds${suffix}`)
      return parseStockPreparationConfirmResponse<StockPrepRefreshHoldPage>(response)
    },
    async readEvidence(projectNo, holdId) {
      const suffix = querySuffix({ tenantId: tenantOf(scope) })
      const response = await apiFetch(`${projectPath(projectNo)}/holds/${encodeURIComponent(holdId)}/evidence${suffix}`)
      return parseStockPreparationConfirmResponse<unknown>(response)
    },
    async readContinuation(projectNo, continuationId) {
      const suffix = querySuffix({ tenantId: tenantOf(scope) })
      const response = await apiFetch(`${projectPath(projectNo)}/continuations/${encodeURIComponent(continuationId)}${suffix}`)
      return parseStockPreparationConfirmResponse<StockPrepRefreshContinuationDetail>(response)
    },
    async keep(projectNo, holdId, body) {
      return postJson(`${projectPath(projectNo)}/holds/${encodeURIComponent(holdId)}/keep`, withTenant(scope, { ...body }))
    },
    async confirm(projectNo, body) {
      return postJson(`${projectPath(projectNo)}/continuations/confirm`, withTenant(scope, { ...body }))
    },
    async end(projectNo, continuationId, body) {
      return postJson(`${projectPath(projectNo)}/continuations/${encodeURIComponent(continuationId)}/end`, withTenant(scope, { ...body }))
    },
  }
}

// ---------------------------------------------------------------------------
// pure helpers (the half the unit suite drives)
// ---------------------------------------------------------------------------

/** A hold kind with a confirm control: a candidate (new relationship) or a relationship needing re-confirmation. */
export function stockPrepRefreshHoldConfirmMode(hold: Pick<StockPrepRefreshHold, 'kind'>): 'confirm' | 'reconfirm' | null {
  if (hold.kind === 'continuation_candidate') return 'confirm'
  if (hold.kind === 'relationship_reconfirm') return 'reconfirm'
  return null
}

/** True when the read receipt covers EVERY pair page of the hold (the server's `verify` is the authority). */
export function receiptCompleteFor(receipt: StockPrepRefreshReceipt | null | undefined, holdId: string): boolean {
  const entry = receipt?.holds?.[holdId]
  if (!entry || !Number.isInteger(entry.pageCount) || entry.pageCount < 1) return false
  const served = new Set(Array.isArray(entry.pagesServed) ? entry.pagesServed : [])
  for (let index = 0; index < entry.pageCount; index += 1) {
    if (!served.has(index)) return false
  }
  return true
}

/** 「已看 x / y 页」 — from the receipt; `null` when the receipt does not name the hold. */
export function receiptProgressFor(receipt: StockPrepRefreshReceipt | null | undefined, holdId: string): { served: number; count: number } | null {
  const entry = receipt?.holds?.[holdId]
  if (!entry || !Number.isInteger(entry.pageCount)) return null
  return { served: Array.isArray(entry.pagesServed) ? new Set(entry.pagesServed).size : 0, count: entry.pageCount }
}

/** The three fingerprints a confirm echoes — all must be non-blank (a hold without them has no confirm). */
export function holdFingerprintsPresent(hold: Pick<StockPrepRefreshHold, 'fingerprint' | 'comparisonFingerprint' | 'evidenceFingerprint'>): boolean {
  return [hold.fingerprint, hold.comparisonFingerprint, hold.evidenceFingerprint].every((value) => typeof value === 'string' && value.trim().length > 0)
}

/**
 * The candidate confirm body (§8.2): exactly the server's keys. `candidateId` = the candidate's pairing fingerprint;
 * `acknowledge.historyUnknown` ONLY when the hold's history is unknown (the server 400s it otherwise missing, and it
 * is meaningless otherwise). Null when the hold cannot be confirmed from this page.
 */
export function buildCandidateConfirmBody(
  hold: StockPrepRefreshHold,
  receipt: StockPrepRefreshReceipt | null,
  options: { confirmProjectNo: string; historyAcknowledged: boolean; note?: string | null },
): StockPrepRefreshConfirmBody | null {
  if (stockPrepRefreshHoldConfirmMode(hold) !== 'confirm' || !hold.confirmable || !holdFingerprintsPresent(hold)) return null
  if (!receipt || !receiptCompleteFor(receipt, hold.id)) return null
  const candidateId = hold.candidates[0]?.candidateId
  if (typeof candidateId !== 'string' || candidateId.length === 0) return null
  const historyUnknown = hold.history === 'history_unknown'
  if (historyUnknown && !options.historyAcknowledged) return null
  const note = typeof options.note === 'string' && options.note.trim().length > 0 ? options.note.trim() : null
  return {
    confirmProjectNo: options.confirmProjectNo,
    holdId: hold.id,
    holdFingerprint: hold.fingerprint,
    comparisonFingerprint: hold.comparisonFingerprint as string,
    evidenceFingerprint: hold.evidenceFingerprint as string,
    readReceipt: receipt.id,
    candidateId,
    basis: note ? { kind: 'puller_confirmed_same_demand', note } : { kind: 'puller_confirmed_same_demand' },
    ...(historyUnknown ? { acknowledge: { historyUnknown: true as const } } : {}),
  }
}

/**
 * The re-confirm body (§8.3): `continuation: { id, revision }` from the DETAIL read (the revision the server holds),
 * no `candidateId`, no `basis`. Null without the detail read or when the detail names another relationship.
 */
export function buildReconfirmBody(
  hold: StockPrepRefreshHold,
  receipt: StockPrepRefreshReceipt | null,
  continuation: StockPrepRefreshContinuationDetail['continuation'] | null,
  options: { confirmProjectNo: string; historyAcknowledged: boolean },
): StockPrepRefreshConfirmBody | null {
  if (stockPrepRefreshHoldConfirmMode(hold) !== 'reconfirm' || !hold.confirmable || !holdFingerprintsPresent(hold)) return null
  if (!receipt || !receiptCompleteFor(receipt, hold.id)) return null
  if (!continuation || continuation.id !== hold.continuationId || !Number.isInteger(continuation.revision) || continuation.revision < 1) return null
  const historyUnknown = hold.history === 'history_unknown'
  if (historyUnknown && !options.historyAcknowledged) return null
  return {
    confirmProjectNo: options.confirmProjectNo,
    holdId: hold.id,
    holdFingerprint: hold.fingerprint,
    comparisonFingerprint: hold.comparisonFingerprint as string,
    evidenceFingerprint: hold.evidenceFingerprint as string,
    readReceipt: receipt.id,
    continuation: { id: continuation.id, revision: continuation.revision },
    ...(historyUnknown ? { acknowledge: { historyUnknown: true as const } } : {}),
  }
}

/**
 * Whether 「放回普通刷新」 (`release_to_normal_refresh`) may be OFFERED for this hold (§8.4): a relationship_reconfirm
 * hold whose recorded verdict is `new_position_removed` AND whose recorded new-position count is the INTEGER 0. An
 * absent or null count is "no count recorded" (delta review N-7) — no release control; the server refuses anyway.
 */
export function releaseAdmissibleOnPage(hold: Pick<StockPrepRefreshHold, 'kind' | 'verification' | 'runbookOnly'>): boolean {
  if (hold.kind !== 'relationship_reconfirm' || hold.runbookOnly === true) return false
  const verification = hold.verification
  if (!verification || verification.verdict !== 'new_position_removed') return false
  const count = verification.componentNewPositionCount
  return typeof count === 'number' && Number.isInteger(count) && count === 0
}

/**
 * The end body (§8.4). A release names the hold the page showed (`factsHoldId` + `factsHoldFingerprint`, PR-4's
 * fix B1 — the store refuses STALE `facts_moved` if the computation moved); an escalation carries NEITHER key (the
 * server 400s them on any other outcome). `superseded_by_new_confirmation` is confirm-only and never offered.
 */
export function buildEndBody(
  hold: Pick<StockPrepRefreshHold, 'id' | 'fingerprint'>,
  continuation: StockPrepRefreshContinuationDetail['continuation'] | null,
  outcome: StockPrepRefreshEndOutcome,
  options: { confirmProjectNo: string; note?: string | null },
): StockPrepRefreshEndBody | null {
  if (!continuation || !Number.isInteger(continuation.revision) || continuation.revision < 1) return null
  const note = typeof options.note === 'string' && options.note.trim().length > 0 ? options.note.trim() : null
  const base: StockPrepRefreshEndBody = { confirmProjectNo: options.confirmProjectNo, revision: continuation.revision, outcome, ...(note ? { note } : {}) }
  if (outcome === 'release_to_normal_refresh') return { ...base, factsHoldId: hold.id, factsHoldFingerprint: hold.fingerprint }
  if (outcome === 'escalate_special_repair') return base
  return null
}

/** The codes after which the page re-reads page 1: the hold moved on under a newer computation (id churn). */
export const STOCK_PREP_REFRESH_REREAD_CODES: readonly string[] = Object.freeze([
  'STOCK_PREP_REFRESH_HOLD_NOT_FOUND',
  'STOCK_PREP_CONTINUATION_CONFIRM_STALE',
  'STOCK_PREP_CONTINUATION_NOT_FOUND',
])

/** The read-receipt reasons that mean "the item changed — read it again" rather than "read the rest". */
export const STOCK_PREP_REFRESH_REREAD_RECEIPT_REASONS: readonly string[] = Object.freeze(['fingerprint_moved', 'hold_not_in_receipt'])

export function stockPrepRefreshNeedsReread(code: string | null | undefined, reason: string | null | undefined): boolean {
  if (typeof code !== 'string') return false
  if (STOCK_PREP_REFRESH_REREAD_CODES.includes(code)) return true
  return code === 'STOCK_PREP_CONTINUATION_CONFIRM_READ_RECEIPT_INCOMPLETE'
    && typeof reason === 'string'
    && STOCK_PREP_REFRESH_REREAD_RECEIPT_REASONS.includes(reason)
}

/** A value from a hold payload, as text for a table cell. Never logged, never stored. */
export function stockPrepRefreshCellText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map((entry) => stockPrepRefreshCellText(entry)).join(' / ')
  try {
    return JSON.stringify(value)
  } catch {
    return '—'
  }
}
