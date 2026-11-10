// 备料分批拉取第一期 step 6a-3 (S6-3; step-6 design §3.5, §3.8, §5.1, §5.4 as amended by the 2026-11-09 rebaseline;
// register R-91) — 「拉取待确认」's RECOVERY CARD: the client shapes for the three S6-2 routes (#6837) and the pure helpers
// the card is built from. Kept out of any `api/` directory on purpose (the vite browser harness routes `**/api/**`).
//
//   GET  …/projects/:projectNo/refresh/executions                                 the values-free executions list (PULL)
//   POST …/projects/:projectNo/refresh/executions/:executionId/recover            verify (report + ONE audited page of the
//                                                                                  private pending list) / close (PULL)
//   POST …/projects/:projectNo/refresh/executions/:executionId/close-unverified   inspect (the sheet only) / close — the
//                                                                                  runbook escape (ADMIN)
//
// Every body / query is CLOSED-ALLOW-LISTED server-side (http-routes.cjs `VALID_STOCK_PREPARATION_REFRESH_EXECUTIONS_QUERY_KEYS`,
// `…_RECOVER_KEYS`, `…_CLOSE_UNVERIFIED_KEYS`) and then normalized (stock-preparation-execution-recovery.cjs
// `normalizeRecoverBody` / `normalizeCloseUnverifiedBody`): an extra key, a digest on a verify, a page cursor on a close or
// an acknowledgement on an inspect is 400. So the builders here send EXACTLY what each mode admits — `tenantId` is added by
// the client only when non-blank, never `workspaceId` — and every one of the four actions carries the number the puller
// TYPED as `confirmProjectNo` (the route types the project in every mode: each takes the recovery lease).
//
// EVERY ECHO COMES FROM THE SERVER. A close echoes the `verifyDigest` of the LAST verify the card was answered (each verify is
// a fresh in-lease recompute with a fresh digest); a close-unverified echoes the `inspectDigest` of the last inspect. A
// STALE refusal drops the shown report: a new verify is required, never a resend.
//
// VALUES. The report and the executions list are values-free (digests, record-id handles, integers, closed tokens). The
// pending page is VALUE-BEARING (component code / name — pull tier, audited server-side before the response): this module
// returns it to the card and keeps nothing — no cache, no storage, no console. Errors carry clamped tokens only
// (StockPreparationConfirmApiError).
//
// N-SWITCH (rebaseline B-6, rulings C6 / C12). While 批次标识's switch is OFF the server sends NO `batch` key on a list item
// or on a report and NO `batchOutcome` on a close — absent, not null. So "is the batch line shown" is KEY PRESENCE, decided
// here once (`stockPrepRecoveryBatchOf`), never a settings read: absent => no batch line at all; present and null => the
// switch is on and this execution has no batch.
//
// The three calls themselves live on `createStockPrepRefreshQueueApi` (refreshQueue.ts), so the page keeps ONE test seam
// and this module imports refreshQueue.ts one way only (type-only there, no import cycle).

/** Mirrors of the server's closed allow-lists (http-routes.cjs). RC-BODY pins them against the plugin source. */
export const STOCK_PREP_REFRESH_EXECUTIONS_QUERY_KEYS = Object.freeze(['tenantId', 'limit', 'cursor'])
export const STOCK_PREP_REFRESH_RECOVER_KEYS = Object.freeze(['tenantId', 'confirmProjectNo', 'mode', 'verifyDigest', 'pageCursor'])
export const STOCK_PREP_REFRESH_CLOSE_UNVERIFIED_KEYS = Object.freeze(['tenantId', 'confirmProjectNo', 'mode', 'inspectDigest', 'runbookRef', 'acknowledge'])

/** The continuation store's `UNFINISHED_EXECUTION_STATUSES` (RC-CONTRACT pins it, both ways). */
export const STOCK_PREP_UNFINISHED_EXECUTION_STATUSES = Object.freeze(['running', 'partial', 'failed', 'aborted'])
/** The recovery lib's `RUNBOOK_REF_PATTERN` (a values-free ticket handle; RC-CONTRACT pins the source literal). */
export const STOCK_PREP_RECOVERY_RUNBOOK_REF_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/
/** The recovery lib's `PENDING_PAGE_SIZE` (RC-CONTRACT pins it). */
export const STOCK_PREP_RECOVERY_PENDING_PAGE_SIZE = 200

const DIGEST64_PATTERN = /^[0-9a-f]{64}$/

// ---------------------------------------------------------------------------
// shapes (stock-preparation-execution-recovery.cjs `listExecutionsRead` / `recoveryReportOf` / `pendingPageOf`, the
// continuation store's `closeExecution` and http-routes.cjs `runStockPreparationRecovery`) — values-free except the page
// ---------------------------------------------------------------------------

/** 批次标识's link on a list item: the batch ordinal, its label and status (values-free: BI §2.2). */
export interface StockPrepRecoveryBatchLink {
  batchNo: number
  label: string
  status: string
}

export interface StockPrepRefreshExecution {
  id: string
  status: string
  verifiedResult: string | null
  closedMode: string | null
  preCloseStatus: string | null
  startedAt: string | null
  finishedAt: string | null
  verifiedAt: string | null
  plannedCounts: Record<string, number> | null
  counts: Record<string, number> | null
  written: number | null
  attemptedWrites: number | null
  abortCode: string | null
  errorCodes: string[] | null
  binding: { continuationCount: number; changePlanBound: boolean }
  settlementSubject: boolean
  recoverable: boolean
  /** N-SWITCH: ABSENT while 批次标识's switch is off; null when on and this execution has no batch. */
  batch?: StockPrepRecoveryBatchLink | null
}

export interface StockPrepRefreshExecutionList {
  items: StockPrepRefreshExecution[]
  nextCursor: string | null
  total: number
}

export interface StockPrepRecoveryCounts {
  intended: number
  landed: number
  notLanded: number
  diverged: number
  duplicate: number
  vanished: number
  replaced: number
}

export interface StockPrepRecoveryReport {
  executionId: string
  preStatus: string
  result: string
  counts: StockPrepRecoveryCounts
  byKind: Record<string, StockPrepRecoveryCounts>
  refusalReasons: string[]
  closeAdmissible: boolean
  /** From the in-lease recompute; null for an inspect (no source read). */
  remaining: { add: number; update: number; inactive: number; manualConfirm: number; suspended: boolean; holdCount: number } | null
  settlesIfClosedNow: boolean
  changePlan: { bound: boolean; planStatusSeen: string; landedRecords: number; notLandedRecords: number; possiblyLandedRecords: number; writtenPlanPending: boolean } | null
  /** N-SWITCH: ABSENT while 批次标识's switch is off. */
  batch?: { linked: boolean; batchNo: number | null; statusSeen: string | null; verifiedCreatedRows: number }
  pending: { total: number; pageCount: number }
  /** A verify's echo (64 hex). */
  verifyDigest?: string
  /** An inspect's echo (64 hex). */
  inspectDigest?: string
}

/** One PRIVATE pending entry (values: component code / name). Lives in the card's refs only. */
export interface StockPrepRecoveryPendingEntry {
  decisionIndex: number
  kind: string
  class: string
  componentCode: string | null
  componentName: string | null
  sourceGone: boolean
}

export interface StockPrepRecoveryPendingPage {
  pageIndex: number
  entries: StockPrepRecoveryPendingEntry[]
  nextCursor: number | null
}

export interface StockPrepRecoveryVerifyAnswer {
  operation: 'verify'
  report: StockPrepRecoveryReport
  pending: StockPrepRecoveryPendingPage
}

export interface StockPrepRecoveryInspectAnswer {
  operation: 'inspect'
  report: StockPrepRecoveryReport
}

/** The close answer: the outcomes decided UNDER THE LOCKS (never an echo of the verify report). */
export interface StockPrepRecoveryCloseAnswer {
  operation: 'close' | 'close_unverified'
  executionId: string
  closed: true
  closedMode: string
  preStatus: string
  result: string
  transparent: boolean
  settlementSubject: boolean
  continuationsConsumed: number
  changePlan: { cell?: string; outcome?: string; recoveredRecordCount?: number } | null
  /** N-SWITCH: ABSENT while 批次标识's switch is off. */
  batchOutcome?: string
  settled: boolean
  decisionVersion: number | null
  /** T6-8: the `recovery_closed` bump after the release; false never turns a close into an error. */
  generationBumped: boolean
  nextStep: string
}

export interface StockPrepRecoverVerifyBody {
  confirmProjectNo: string
  mode: 'verify'
  pageCursor?: number
}

export interface StockPrepRecoverCloseBody {
  confirmProjectNo: string
  mode: 'close'
  verifyDigest: string
}

export interface StockPrepCloseUnverifiedInspectBody {
  confirmProjectNo: string
  mode: 'inspect'
}

export interface StockPrepCloseUnverifiedCloseBody {
  confirmProjectNo: string
  mode: 'close'
  inspectDigest: string
  runbookRef: string
  acknowledge: { resultUnknown: true }
}

/** The three calls on the page's ONE api seam (refreshQueue.ts `createStockPrepRefreshQueueApi`). */
export interface StockPrepRecoveryCalls {
  listExecutions(projectNo: string, query?: { cursor?: string | null }): Promise<StockPrepRefreshExecutionList>
  recoverExecution(projectNo: string, executionId: string, body: StockPrepRecoverVerifyBody | StockPrepRecoverCloseBody): Promise<StockPrepRecoveryVerifyAnswer | StockPrepRecoveryCloseAnswer>
  closeExecutionUnverified(projectNo: string, executionId: string, body: StockPrepCloseUnverifiedInspectBody | StockPrepCloseUnverifiedCloseBody): Promise<StockPrepRecoveryInspectAnswer | StockPrepRecoveryCloseAnswer>
}

// ---------------------------------------------------------------------------
// pure helpers (the half the unit suite drives)
// ---------------------------------------------------------------------------

/** The card shows exactly when the page's own refresh summary says 失败待恢复 (design §5.4) — never otherwise (dormancy). */
export function stockPrepRecoveryCardShown(summary: { readable?: unknown; status?: unknown } | null | undefined): boolean {
  return Boolean(summary && summary.readable === true && summary.status === 'failed_pending_recovery')
}

export function stockPrepExecutionUnfinished(execution: Pick<StockPrepRefreshExecution, 'status'>): boolean {
  return STOCK_PREP_UNFINISHED_EXECUTION_STATUSES.includes(execution.status)
}

/**
 * N-SWITCH, by KEY PRESENCE: `{ shown: false }` when the server sent no batch key (the switch is off — no batch line at
 * all); `{ shown: true, value }` otherwise (`value` null = on, no batch for this execution).
 */
export function stockPrepRecoveryBatchOf<T>(holder: object | null | undefined, key: string): { shown: false } | { shown: true; value: T | null } {
  if (!holder || !Object.prototype.hasOwnProperty.call(holder, key)) return { shown: false }
  const value = (holder as Record<string, unknown>)[key]
  return { shown: true, value: value === undefined ? null : value as T }
}

function typedNo(value: string): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** A verify: the typed number, and the page cursor only when it is a decision index (page 1 sends none). */
export function buildRecoverVerifyBody(options: { confirmProjectNo: string; pageCursor?: number | null }): StockPrepRecoverVerifyBody | null {
  const confirmProjectNo = typedNo(options.confirmProjectNo)
  if (!confirmProjectNo) return null
  const cursor = options.pageCursor
  if (cursor === undefined || cursor === null) return { confirmProjectNo, mode: 'verify' }
  if (!Number.isSafeInteger(cursor) || cursor < 0) return null
  return { confirmProjectNo, mode: 'verify', pageCursor: cursor }
}

/**
 * A close: only over a report that admits it, echoing ITS digest. Null when the report is missing, refuses a close
 * (UNPROVABLE reasons), belongs to another execution, or carries no well-formed digest.
 */
export function buildRecoverCloseBody(options: { confirmProjectNo: string; executionId: string; report: StockPrepRecoveryReport | null | undefined }): StockPrepRecoverCloseBody | null {
  const confirmProjectNo = typedNo(options.confirmProjectNo)
  const report = options.report
  if (!confirmProjectNo || !report || report.executionId !== options.executionId) return null
  if (report.closeAdmissible !== true || (Array.isArray(report.refusalReasons) && report.refusalReasons.length > 0)) return null
  if (typeof report.verifyDigest !== 'string' || !DIGEST64_PATTERN.test(report.verifyDigest)) return null
  return { confirmProjectNo, mode: 'close', verifyDigest: report.verifyDigest }
}

/** An inspect (admin): the typed number only — no digest, no runbook reference, no acknowledgement. */
export function buildCloseUnverifiedInspectBody(options: { confirmProjectNo: string }): StockPrepCloseUnverifiedInspectBody | null {
  const confirmProjectNo = typedNo(options.confirmProjectNo)
  return confirmProjectNo ? { confirmProjectNo, mode: 'inspect' } : null
}

/** A close-unverified (admin): the last inspect's digest, a values-free runbook reference and the explicit acknowledgement. */
export function buildCloseUnverifiedCloseBody(options: {
  confirmProjectNo: string
  executionId: string
  report: StockPrepRecoveryReport | null | undefined
  runbookRef: string
  acknowledged: boolean
}): StockPrepCloseUnverifiedCloseBody | null {
  const confirmProjectNo = typedNo(options.confirmProjectNo)
  const report = options.report
  if (!confirmProjectNo || !report || report.executionId !== options.executionId) return null
  if (typeof report.inspectDigest !== 'string' || !DIGEST64_PATTERN.test(report.inspectDigest)) return null
  const runbookRef = typeof options.runbookRef === 'string' ? options.runbookRef.trim() : ''
  if (!STOCK_PREP_RECOVERY_RUNBOOK_REF_PATTERN.test(runbookRef)) return null
  if (options.acknowledged !== true) return null
  return { confirmProjectNo, mode: 'close', inspectDigest: report.inspectDigest, runbookRef, acknowledge: { resultUnknown: true } }
}

/** The first thing the puller's close is missing on this card (in words by the card), or null when it can be sent. */
export type StockPrepRecoveryCloseGap = 'no_report' | 'unprovable' | 'typed' | null

export function stockPrepRecoveryCloseGap(options: { report: StockPrepRecoveryReport | null | undefined; typedMatches: boolean }): StockPrepRecoveryCloseGap {
  const report = options.report
  if (!report) return 'no_report'
  if (report.closeAdmissible !== true || (Array.isArray(report.refusalReasons) && report.refusalReasons.length > 0)) return 'unprovable'
  if (!options.typedMatches) return 'typed'
  return null
}

/**
 * The refusals after which the shown report is void and a NEW verify (or inspect) is required: the sheet / source moved
 * (STALE), the project's state or the execution moved under the close's locks (STATE_MOVED), the recovery lost its lease,
 * or the close found what the report did not (UNPROVABLE at close).
 */
export const STOCK_PREP_RECOVERY_REVERIFY_CODES: readonly string[] = Object.freeze([
  'STOCK_PREP_REFRESH_RECOVERY_STALE',
  'STOCK_PREP_REFRESH_RECOVERY_UNPROVABLE',
  'STOCK_PREP_PULL_STATE_MOVED',
  'STOCK_PREP_PROJECT_WRITE_LEASE_LOST',
])

/** The refusals after which the executions list (and the page) is read again: the execution is gone or already finished. */
export const STOCK_PREP_RECOVERY_RELIST_CODES: readonly string[] = Object.freeze([
  'STOCK_PREP_REFRESH_EXECUTION_NOT_FOUND',
  'STOCK_PREP_REFRESH_EXECUTION_NOT_UNFINISHED',
])

/** A count from a values-free payload, as text (never a value). */
export function stockPrepRecoveryCount(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : '—'
}
