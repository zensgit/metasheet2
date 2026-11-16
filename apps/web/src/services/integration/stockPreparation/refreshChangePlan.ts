// 备料分批拉取第一期 step 5 PR-9 (design §10.3, §13; register R-77) — 「拉取待确认」's change-plan sections: the client for
// the three PR-8 routes (#6584) and the pure helpers the sections are built from. Kept out of any `api/` directory on
// purpose (the vite browser harness routes `**/api/**`).
//
//   GET  …/projects/:projectNo/refresh/change-plans/current      the PRIVATE change-plan page (values) + the receipt
//   POST …/projects/:projectNo/refresh/change-plans/confirm      the whole open content-class hold set as ONE plan
//   POST …/projects/:projectNo/refresh/change-reviews/complete   the review of the written plan (变更复核)
//
// All three are the PULL tier and CLOSED-ALLOW-LISTED server-side (http-routes.cjs
// `VALID_STOCK_PREPARATION_REFRESH_CHANGE_PLAN_*` / `…_CHANGE_REVIEW_KEYS`): an extra key is 400. So this module sends
// EXACTLY those keys — `tenantId` only when non-blank and NEVER `workspaceId` (the refreshQueue.ts rule), and every write
// carries the number the puller TYPED as `confirmProjectNo` (the route compares it with the path before anything else).
//
// EVERY ECHO COMES FROM THE SERVER. The confirm's `holdIds` and its three fingerprints are copied verbatim from the
// page's `proposal` (never derived here, never from the loaded holds); the review's `changePlanId` / `contentDigest` from
// `current.written`. The receipt is the page's ONE receipt id (the holds pages and the plan pages thread the same id).
// `recordLimit` is NEVER sent: the server default (100) keeps the written plan's page count — and so its receipt entry —
// stable across reads (a moving page count would restart the receipt's page set).
//
// VALUES. The change-plan page is VALUE-BEARING by design (pull tier, audited server-side before the response). This
// module returns it to the page and keeps nothing: no cache, no storage, no console. Errors carry clamped tokens only
// (StockPreparationConfirmApiError).
// The three calls themselves live on `createStockPrepRefreshQueueApi` (refreshQueue.ts), so the page keeps ONE test seam
// and this module imports refreshQueue.ts one way only (no import cycle).
import { receiptCompleteFor, type StockPrepRefreshHold, type StockPrepRefreshPageSummary, type StockPrepRefreshReceipt } from './refreshQueue'

/** Mirrors of the server's closed allow-lists (http-routes.cjs). CP-BODY pins them against the plugin source. */
export const STOCK_PREP_REFRESH_CHANGE_PLAN_QUERY_KEYS = Object.freeze(['tenantId', 'recordCursor', 'recordLimit', 'receipt'])
export const STOCK_PREP_REFRESH_CHANGE_PLAN_CONFIRM_KEYS = Object.freeze([
  'tenantId', 'confirmProjectNo', 'holdIds', 'holdSetFingerprint', 'planFingerprint', 'sourceContentDigest', 'readReceipt', 'candidates',
])
export const STOCK_PREP_REFRESH_CHANGE_REVIEW_KEYS = Object.freeze(['tenantId', 'confirmProjectNo', 'changePlanId', 'contentDigest', 'conclusion', 'notes', 'readReceipt'])

/** The plugin pairing core's `CONTENT_CLASS_HOLD_KINDS` (RS-CLASS pins it, both ways). */
export const STOCK_PREP_CONTENT_CLASS_HOLD_KINDS = Object.freeze(['content_change', 'relationship_content_change', 'candidate_content_differs'])
/** The store's `REVIEW_CONCLUSIONS` (CP-CONTRACT pins it). */
export const STOCK_PREP_CHANGE_REVIEW_CONCLUSIONS = Object.freeze(['handled', 'handled_with_notes'] as const)
export type StockPrepChangeReviewConclusion = typeof STOCK_PREP_CHANGE_REVIEW_CONCLUSIONS[number]
/** The store's `REVIEW_NOTES_MAX_LENGTH` and `BASIS_NOTE_MAX_LENGTH` (CP-CONTRACT pins both). */
export const STOCK_PREP_CHANGE_REVIEW_NOTES_MAX_LENGTH = 2000
export const STOCK_PREP_CHANGE_PLAN_BASIS_NOTE_MAX_LENGTH = 2000
/** The decisions module's `RECORD_PAGE_LIMIT_DEFAULT` — the page size every read here gets (no `recordLimit` sent). */
export const STOCK_PREP_CHANGE_PLAN_RECORD_PAGE_DEFAULT = 100

/**
 * The store's control-character rule (continuation-store.cjs `CONTROL_CHARACTER_PATTERN`): C0, DEL, C1 and the two
 * Unicode line separators — a line break included. Built from char codes so no separator byte sits in this source.
 */
const CONTROL_CHARACTER_PATTERN = new RegExp(`[\\x00-\\x1F\\x7F-\\x9F${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`)

// ---------------------------------------------------------------------------
// shapes (decisions.cjs `readChangePlanCurrent`, `confirmChangePlan`, `completeChangeReview`) — loose where they carry values
// ---------------------------------------------------------------------------

export interface StockPrepChangePlanRecordPage {
  index: number
  count: number
  size: number
  next: number | null
}

export interface StockPrepChangePlanProposalRecord {
  recordId: unknown
  key?: unknown
  root?: unknown
  inContinuation?: unknown
  fields?: Record<string, { before?: unknown; after?: unknown } | unknown>
  present?: unknown
  humanColumnsPresent?: Record<string, unknown> | null
}

export interface StockPrepChangePlanCandidate {
  holdId: string
  candidateId: string | null
  history: string
}

export interface StockPrepChangePlanProposal {
  blocked: string | null
  holdIds: string[]
  holdSetFingerprint: string | null
  planFingerprint: string | null
  sourceContentDigest: string | null
  recordCount: number
  structureHoldOpen: boolean
  runbookHoldOpen: boolean
  candidates: StockPrepChangePlanCandidate[]
  recordPage: StockPrepChangePlanRecordPage
  records: StockPrepChangePlanProposalRecord[]
}

export interface StockPrepChangePlanCell {
  baseline?: unknown
  before?: unknown
  after?: unknown
  reviewOnly?: unknown
  current?: unknown
}

export interface StockPrepChangePlanRecord {
  recordId: unknown
  key?: unknown
  root?: unknown
  inContinuation?: unknown
  present?: unknown
  humanColumnsPresent?: Record<string, unknown> | null
  fields?: Record<string, StockPrepChangePlanCell>
}

export interface StockPrepChangePlanView {
  id: string
  status: string
  recordCount: number
  writeRecordCount?: number
  planFingerprint: string | null
  reviewBaselineDigest?: unknown
  absorbedChangePlanIds: string[]
  confirmedAt?: unknown
  confirmedBySelf: boolean
  writtenAt?: unknown
  writtenContentDigest: string | null
  /** Written plans only. */
  currentContentDigest?: string | null
  contentMatchesWrite?: boolean
  recordPage: StockPrepChangePlanRecordPage
  records: StockPrepChangePlanRecord[]
}

export interface StockPrepChangePlanPage {
  refresh: StockPrepRefreshPageSummary & { holdSetFingerprint?: string | null; decisionVersion?: unknown }
  proposal: StockPrepChangePlanProposal
  current: { confirmed: StockPrepChangePlanView | null; written: StockPrepChangePlanView | null }
  readReceipt: StockPrepRefreshReceipt | null
}

export interface StockPrepChangePlanCandidateDecision {
  holdId: string
  candidateId: string
  basis: { kind: 'puller_confirmed_same_demand'; note?: string }
  acknowledge?: { historyUnknown: true }
}

export interface StockPrepChangePlanConfirmBody {
  confirmProjectNo: string
  holdIds: string[]
  holdSetFingerprint: string
  planFingerprint: string
  sourceContentDigest: string
  readReceipt: string
  candidates?: StockPrepChangePlanCandidateDecision[]
}

export interface StockPrepChangeReviewBody {
  confirmProjectNo: string
  changePlanId: string
  contentDigest: string
  conclusion: StockPrepChangeReviewConclusion
  notes?: string
  readReceipt: string
}

/** 201 (decisions.cjs `confirmChangePlan`). */
export interface StockPrepChangePlanConfirmResult {
  changePlanId?: string
  recordCount?: number
  holdCount?: number
  continuationIds?: string[]
  decisionVersion?: unknown
  generation?: unknown
  state?: string
  nextStep?: string
}

/** 200 (decisions.cjs `completeChangeReview`). */
export interface StockPrepChangeReviewResult {
  changePlanId?: string
  status?: string
  recordCount?: number
  reviewedContentDigest?: string
  decisionVersion?: unknown
  nextStep?: string
}

export interface StockPrepChangePlanQuery {
  recordCursor?: number | null
  receipt?: string | null
}

export interface StockPrepChangePlanCalls {
  readChangePlan(projectNo: string, query?: StockPrepChangePlanQuery): Promise<StockPrepChangePlanPage>
  confirmChangePlan(projectNo: string, body: StockPrepChangePlanConfirmBody): Promise<StockPrepChangePlanConfirmResult>
  completeChangeReview(projectNo: string, body: StockPrepChangeReviewBody): Promise<StockPrepChangeReviewResult>
}

// ---------------------------------------------------------------------------
// pure helpers (the half the unit suite drives)
// ---------------------------------------------------------------------------

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isRecordPage(value: unknown): value is StockPrepChangePlanRecordPage {
  if (!value || typeof value !== 'object') return false
  const page = value as Record<string, unknown>
  return Number.isInteger(page.index) && Number.isInteger(page.count) && (page.count as number) >= 1
    && (page.next === null || Number.isInteger(page.next))
}

function isPlanView(value: unknown): value is StockPrepChangePlanView {
  if (!value || typeof value !== 'object') return false
  const plan = value as Record<string, unknown>
  return nonBlank(plan.id) && isRecordPage(plan.recordPage) && Array.isArray(plan.records)
}

/**
 * FAIL CLOSED: the change-plan page is usable only when it is the PR-8 shape — a `proposal` object with an id list and
 * an integer record page, and a `current` object whose plans (when present) are well formed. Anything else (an empty
 * `{}`, an older backend, a non-integer page) is NOT "nothing to do": the page then offers no confirm and no review.
 */
export function stockPrepChangePlanPageUsable(page: unknown): page is StockPrepChangePlanPage {
  if (!page || typeof page !== 'object') return false
  const value = page as Record<string, unknown>
  const proposal = value.proposal as Record<string, unknown> | undefined
  const current = value.current as Record<string, unknown> | undefined
  if (!proposal || typeof proposal !== 'object' || !current || typeof current !== 'object') return false
  if (!Array.isArray(proposal.holdIds) || !proposal.holdIds.every(nonBlank)) return false
  if (!isRecordPage(proposal.recordPage) || !Array.isArray(proposal.records)) return false
  if (!Array.isArray(proposal.candidates)) return false
  for (const key of ['confirmed', 'written'] as const) {
    if (current[key] !== null && current[key] !== undefined && !isPlanView(current[key])) return false
  }
  return true
}

/**
 * The web payload of the pairing core's `isContentClassHold`: a content-class kind, OR a `relationship_reconfirm` whose
 * verdict is `content_changed` and whose own reason is `needs_step5` (`isReconfirmContentHold`; the hold page carries the
 * detail's verdict as `verification.verdict`). Used ONLY to decide whether to read the change plan and to point a hold
 * card at it — never to build a body (the confirm's set is the server's `proposal.holdIds`).
 */
export function stockPrepRefreshIsContentClassHold(hold: Pick<StockPrepRefreshHold, 'kind' | 'notConfirmableReason'> & { verification?: { verdict?: string | null } | null }): boolean {
  if ((STOCK_PREP_CONTENT_CLASS_HOLD_KINDS as readonly string[]).includes(hold.kind)) return true
  return hold.kind === 'relationship_reconfirm' && hold.verification?.verdict === 'content_changed' && hold.notConfirmableReason === 'needs_step5'
}

/** 「这份计划涉及的 N 项里,已打开看完 X 项」: every named hold complete on the receipt (the server's `verify` decides). */
export function changePlanReceiptProgress(receipt: StockPrepRefreshReceipt | null | undefined, holdIds: readonly string[]): { complete: boolean; done: number; missing: number } {
  const done = holdIds.filter((id) => receiptCompleteFor(receipt, id)).length
  return { complete: holdIds.length > 0 && done === holdIds.length, done, missing: holdIds.length - done }
}

/** A single-line private note (basis / review): the store refuses control characters (line breaks included). */
export function stockPrepPrivateNoteProblem(text: string, max: number): 'control_character' | 'too_long' | null {
  if (CONTROL_CHARACTER_PATTERN.test(text)) return 'control_character'
  if (text.trim().length > max) return 'too_long'
  return null
}

/** Why the review notes cannot be sent: required for `handled_with_notes`, one line, at most 2000 characters. */
export function stockPrepReviewNotesProblem(notes: string | null | undefined, conclusion: string | null | undefined): 'required' | 'control_character' | 'too_long' | null {
  const text = typeof notes === 'string' ? notes : ''
  const problem = stockPrepPrivateNoteProblem(text, STOCK_PREP_CHANGE_REVIEW_NOTES_MAX_LENGTH)
  if (problem) return problem
  if (conclusion === 'handled_with_notes' && text.trim().length === 0) return 'required'
  return null
}

export interface StockPrepChangePlanCandidateChoice {
  historyAcknowledged?: boolean
  note?: string | null
}

export type StockPrepChangePlanConfirmGap =
  | 'unusable'
  | 'blocked'
  | 'no_fingerprint'
  | 'holds_moved'
  | 'pages_unread'
  | 'not_pilot'
  | 'candidate'
  | 'history_ack'
  | 'basis_note'
  | 'ack'
  | 'typed'
  | null

/**
 * The FIRST precondition a change-plan confirm is missing on this page, or null when it can be sent. The server's own
 * rules mirrored (R-77 ③) plus the explicit acknowledgement: `blocked` null, a plan fingerprint, the holds page and the
 * proposal naming the same hold set, every named hold complete on the receipt, every combined candidate decided (pilot
 * only; the history acknowledgement when its history is unknown), the acknowledgement ticked, the typed number matching.
 */
export function changePlanConfirmGap(
  page: StockPrepChangePlanPage | null,
  receipt: StockPrepRefreshReceipt | null,
  options: {
    typedMatches: boolean
    acknowledged: boolean
    candidateChoices: Record<string, StockPrepChangePlanCandidateChoice | undefined>
    holdsPageFingerprint: string | null | undefined
    pilot: boolean
  },
): StockPrepChangePlanConfirmGap {
  if (!page || !stockPrepChangePlanPageUsable(page)) return 'unusable'
  const proposal = page.proposal
  if (proposal.blocked !== null || proposal.holdIds.length === 0) return 'blocked'
  if (!nonBlank(proposal.planFingerprint) || !nonBlank(proposal.holdSetFingerprint) || !nonBlank(proposal.sourceContentDigest)) return 'no_fingerprint'
  if (options.holdsPageFingerprint !== proposal.holdSetFingerprint) return 'holds_moved'
  if (!receipt || !nonBlank(receipt.id) || !changePlanReceiptProgress(receipt, proposal.holdIds).complete) return 'pages_unread'
  if (proposal.candidates.length > 0 && options.pilot !== true) return 'not_pilot'
  for (const candidate of proposal.candidates) {
    if (!nonBlank(candidate.candidateId)) return 'candidate'
    const choice = options.candidateChoices[candidate.holdId]
    if (candidate.history === 'history_unknown' && choice?.historyAcknowledged !== true) return 'history_ack'
    if (typeof choice?.note === 'string' && stockPrepPrivateNoteProblem(choice.note, STOCK_PREP_CHANGE_PLAN_BASIS_NOTE_MAX_LENGTH)) return 'basis_note'
  }
  if (options.acknowledged !== true) return 'ack'
  if (options.typedMatches !== true) return 'typed'
  return null
}

/**
 * The change-plan confirm body (decisions.cjs `normalizeChangePlanConfirmBody`): EXACTLY the server's keys, every echo
 * copied from `proposal` verbatim, `readReceipt` = the page's receipt, `candidates` only when the proposal has any
 * (`acknowledge.historyUnknown` only for a candidate whose history is unknown). Null whenever a precondition is missing.
 */
export function buildChangePlanConfirmBody(
  page: StockPrepChangePlanPage | null,
  receipt: StockPrepRefreshReceipt | null,
  options: {
    confirmProjectNo: string
    typedMatches: boolean
    acknowledged: boolean
    candidateChoices: Record<string, StockPrepChangePlanCandidateChoice | undefined>
    holdsPageFingerprint: string | null | undefined
    pilot: boolean
  },
): StockPrepChangePlanConfirmBody | null {
  if (changePlanConfirmGap(page, receipt, options) !== null || !page || !receipt) return null
  if (!nonBlank(options.confirmProjectNo)) return null
  const proposal = page.proposal
  const body: StockPrepChangePlanConfirmBody = {
    confirmProjectNo: options.confirmProjectNo,
    holdIds: [...proposal.holdIds],
    holdSetFingerprint: proposal.holdSetFingerprint as string,
    planFingerprint: proposal.planFingerprint as string,
    sourceContentDigest: proposal.sourceContentDigest as string,
    readReceipt: receipt.id,
  }
  if (proposal.candidates.length > 0) {
    body.candidates = proposal.candidates.map((candidate) => {
      const choice = options.candidateChoices[candidate.holdId]
      const note = typeof choice?.note === 'string' && choice.note.trim().length > 0 ? choice.note.trim() : null
      return {
        holdId: candidate.holdId,
        candidateId: candidate.candidateId as string,
        basis: note ? { kind: 'puller_confirmed_same_demand' as const, note } : { kind: 'puller_confirmed_same_demand' as const },
        ...(candidate.history === 'history_unknown' ? { acknowledge: { historyUnknown: true as const } } : {}),
      }
    })
  }
  return body
}

export type StockPrepChangeReviewBlock = 'hold_open' | 'change_plan_pending' | 'recovery' | 'executing' | null

/**
 * C12 (decisions.cjs `completeChangeReview`), mirrored: the review completes only when nothing else is open — no open
 * hold, no confirmed (unwritten) plan, no recovery, no live write. Read from the change-plan page's own `refresh`
 * summary (the same consult the server decides on) and the holds the parent loaded.
 */
export function stockPrepChangeReviewBlock(page: StockPrepChangePlanPage | null, options: { openHolds: number }): StockPrepChangeReviewBlock {
  const counts = page?.refresh?.counts ?? null
  const pending = counts && typeof counts.pendingConfirm === 'number' ? counts.pendingConfirm : 0
  if (options.openHolds > 0 || pending > 0) return 'hold_open'
  if (page?.current?.confirmed) return 'change_plan_pending'
  const status = page?.refresh?.status
  if (status === 'failed_pending_recovery') return 'recovery'
  if (status === 'executing') return 'executing'
  return null
}

export type StockPrepChangeReviewGap =
  | 'unusable'
  | 'no_written'
  | 'content_moved'
  | 'pages_unread'
  | 'blocked'
  | 'conclusion'
  | 'notes'
  | 'typed'
  | null

/** The FIRST precondition the review is missing on this page (R-77 ④), or null when it can be sent. */
export function changeReviewGap(
  page: StockPrepChangePlanPage | null,
  receipt: StockPrepRefreshReceipt | null,
  options: { typedMatches: boolean; conclusion: string | null | undefined; notes: string | null | undefined; block: StockPrepChangeReviewBlock },
): StockPrepChangeReviewGap {
  if (!page || !stockPrepChangePlanPageUsable(page)) return 'unusable'
  const written = page.current.written
  if (!written) return 'no_written'
  if (written.contentMatchesWrite !== true || !nonBlank(written.currentContentDigest)) return 'content_moved'
  if (!receipt || !nonBlank(receipt.id) || !receiptCompleteFor(receipt, written.id)) return 'pages_unread'
  if (options.block !== null) return 'blocked'
  if (!(STOCK_PREP_CHANGE_REVIEW_CONCLUSIONS as readonly string[]).includes(String(options.conclusion))) return 'conclusion'
  if (stockPrepReviewNotesProblem(options.notes, options.conclusion) !== null) return 'notes'
  if (options.typedMatches !== true) return 'typed'
  return null
}

/**
 * The review body (decisions.cjs `normalizeReviewBody`): `contentDigest` = the written plan's CURRENT digest, sent only
 * when the server says it matches the write (so it equals `writtenContentDigest`); `notes` only when non-blank after
 * trim. Null whenever a precondition is missing.
 */
export function buildChangeReviewBody(
  page: StockPrepChangePlanPage | null,
  receipt: StockPrepRefreshReceipt | null,
  options: { confirmProjectNo: string; typedMatches: boolean; conclusion: string | null | undefined; notes: string | null | undefined; block: StockPrepChangeReviewBlock },
): StockPrepChangeReviewBody | null {
  if (changeReviewGap(page, receipt, options) !== null || !page || !receipt) return null
  if (!nonBlank(options.confirmProjectNo)) return null
  const written = page.current.written as StockPrepChangePlanView
  const notes = typeof options.notes === 'string' && options.notes.trim().length > 0 ? options.notes.trim() : null
  return {
    confirmProjectNo: options.confirmProjectNo,
    changePlanId: written.id,
    contentDigest: written.currentContentDigest as string,
    conclusion: options.conclusion as StockPrepChangeReviewConclusion,
    readReceipt: receipt.id,
    ...(notes ? { notes } : {}),
  }
}

/** The codes after which the change-plan sections re-read (the holds page 1 and the plan): the picture moved on. */
export const STOCK_PREP_CHANGE_PLAN_REREAD_CODES: readonly string[] = Object.freeze([
  'STOCK_PREP_CHANGE_PLAN_STALE',
  'STOCK_PREP_CHANGE_REVIEW_STALE',
  'STOCK_PREP_CHANGE_PLAN_NOT_FOUND',
  'STOCK_PREP_PULL_STATE_MOVED',
])

const CHANGE_PLAN_RECEIPT_CODES = Object.freeze([
  'STOCK_PREP_CONTINUATION_CONFIRM_READ_RECEIPT_INCOMPLETE',
  'STOCK_PREP_CHANGE_REVIEW_READ_RECEIPT_INCOMPLETE',
])

export function stockPrepChangePlanNeedsReread(code: string | null | undefined, reason: string | null | undefined): boolean {
  if (typeof code !== 'string') return false
  if (STOCK_PREP_CHANGE_PLAN_REREAD_CODES.includes(code)) return true
  return CHANGE_PLAN_RECEIPT_CODES.includes(code) && (reason === 'fingerprint_moved' || reason === 'hold_not_in_receipt')
}
