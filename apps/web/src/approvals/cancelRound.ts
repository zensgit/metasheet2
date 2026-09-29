/**
 * 请假撤销(撤销轮)—— 前端入口的共享核心(阶段 B)。
 *
 * Authority: the approval change-request lock v5.9 and its header note 「RATIFY 追记 —— 产品入口增补 v2
 * (P-1…P-11)」, plus the owner's 2026-09-29 selections recorded in the design MD
 * (`docs/development/approval-cancel-entry-phase-b-fe-design-20260929.md` §1). Nothing in this module
 * decides whether an action is allowed — the attendance plugin routes and the approval service do that
 * and their answer is the authority. This module only:
 *
 *  1. talks to the four attendance-side cancel-round routes (summary read, launch, withdraw, approver
 *     decision) and turns a failed response into an `ApprovalApiError` carrying the server's code;
 *  2. maps a round to the P-2 vocabulary (V1–V8) that `statusDomains.ts` renders — every label names
 *     its subject (撤销申请 / 请假), and a system closure (V5/V6) is never rendered as an approver's
 *     rejection (V3): the only criterion is the one lock:131 fixed (system closure identity + the
 *     bounded close reason), read from the wire, never guessed;
 *  3. maps the registered error codes (P-8) and the open `business_blocked:<code>` domain (P-7) to
 *     user copy. Unknown block codes get category copy plus the raw code for a folded technical
 *     detail — never 「原因未知」, and never the adapter's free-text detail (it is not on the wire).
 *
 * Contract notes (the backend lane changes two response shapes in parallel with this slice):
 *  - the summary read carries `entryEnabled: boolean`; an ABSENT field is read as `false`;
 *  - approve / reject / withdraw success bodies are minimal (`{ requestId, roundId, outcome, status }`),
 *    so nothing here reads them — every caller re-reads the summary (or the approval detail) after a
 *    successful write.
 */
import { apiFetch } from '../utils/api'
import type { StatusDomain } from '../utils/statusDomains'
import { ApprovalApiError, getApproval } from './api'

/** `approval_instances.workflow_key` of a cancel round (lock §9-8 Q1). */
export const CANCEL_ROUND_WORKFLOW_KEY = 'approval.cancel-round'

/**
 * The actor id / actor name the system closure writes on its audit row (lock:131 「系统终结身份」).
 * It reaches the approval timeline verbatim and must not be rendered as if it were a person's name.
 */
export const CANCEL_ROUND_SYSTEM_ACTOR_ID = 'system:approval-cancel-round'

/** Close-reason tokens (`cancelRoundCloseReason`, whitelist-projected by the backend). */
export const CANCEL_ROUND_CLOSE_REASON_EXPIRED = 'round_expired'
export const CANCEL_ROUND_CLOSE_REASON_BLOCKED_PREFIX = 'business_blocked:'

/** Prefix of the ORIGINAL attendance approval instance's `businessKey` (`attendance-request:<id>`). */
export const ATTENDANCE_REQUEST_BUSINESS_KEY_PREFIX = 'attendance-request:'

export function isCancelRoundWorkflow(value: { workflowKey?: string | null } | null | undefined): boolean {
  return Boolean(value && value.workflowKey === CANCEL_ROUND_WORKFLOW_KEY)
}

// ---------------------------------------------------------------------------
// Vocabulary (P-2). The six machine words the summary read returns, one per round outcome.

export const CANCEL_ROUND_STATUS_KEYS = [
  'cancellation_pending_approval', // V1
  'leave_cancelled', // V2
  'cancellation_rejected', // V3
  'cancellation_withdrawn', // V4
  'cancellation_window_closed', // V5
  'cancellation_blocked', // V6
] as const

export type CancelRoundStatusKey = (typeof CANCEL_ROUND_STATUS_KEYS)[number]

/**
 * Everything the `cancelRound` StatusTag domain can render: the six round states, the two
 * NON-TERMINAL request-time outcomes (V7/V8 — the round stays pending, the action may be retried),
 * and the two states of a surface that has not (yet) read the close-reason criterion. The last two
 * are deliberately NOT V-words: they say 「we have not read it」, never 「驳回」.
 */
export type CancelRoundPresentationKey =
  | CancelRoundStatusKey
  | 'action_incomplete_retry' // V7
  | 'system_busy_retry' // V8
  | 'status_resolving'
  | 'status_unavailable'

export type CancelRoundOutcome = 'pending' | 'applied' | 'rejected' | 'withdrawn' | 'expired' | 'blocked'

const OUTCOME_TO_STATUS_KEY: Record<CancelRoundOutcome, CancelRoundStatusKey> = {
  pending: 'cancellation_pending_approval',
  applied: 'leave_cancelled',
  rejected: 'cancellation_rejected',
  withdrawn: 'cancellation_withdrawn',
  expired: 'cancellation_window_closed',
  blocked: 'cancellation_blocked',
}

export interface CancelRoundReversal {
  reversed: number
  lots: number
  unrecoverableExpired: number
  alreadyReversed: boolean
}

/** P-3 — three statuses, never collapsed to two (`cancelled_reversal_unreported` is NOT 「返还 0」). */
export type CancelRoundCancellationOutcome =
  | { status: 'cancelled' | 'cancelled_with_unrecoverable_expired'; reversal: CancelRoundReversal }
  | { status: 'cancelled_reversal_unreported'; reversal: null }

export type CancelRoundWithdrawBlockedReason =
  | 'APPROVAL_REVOKE_FORBIDDEN'
  | 'APPROVAL_REVOKE_DISABLED'
  | 'APPROVAL_REVOKE_WINDOW_CLOSED'
  | 'INVALID_STATUS_TRANSITION'

export interface CancelRoundSummaryRound {
  roundId: string
  engineInstanceId: string | null
  outcome: CancelRoundOutcome | string
  status: CancelRoundStatusKey | string
  startedAt: string | null
  endedAt: string | null
  closeReason: string | null
  blockCode: string | null
  closedBySystem: boolean
  canWithdraw: boolean
  withdrawBlockedReason: CancelRoundWithdrawBlockedReason | string | null
  cancellationOutcome: CancelRoundCancellationOutcome | null
}

export interface CancelRoundSummary {
  requestId: string
  documentInstanceId: string | null
  /** Owner 2026-09-29 14:3x 「Summary exposes entryEnabled」. Absent on the wire ⇒ `false`. */
  entryEnabled: boolean
  round: CancelRoundSummaryRound | null
}

/** V1–V6 for a round as the summary read returns it. Unknown ⇒ `status_unavailable` (never a V-word). */
export function cancelRoundStatusKeyFromSummary(round: Pick<CancelRoundSummaryRound, 'status' | 'outcome'>): CancelRoundPresentationKey {
  if ((CANCEL_ROUND_STATUS_KEYS as readonly string[]).includes(round.status)) {
    return round.status as CancelRoundStatusKey
  }
  const byOutcome = OUTCOME_TO_STATUS_KEY[round.outcome as CancelRoundOutcome]
  return byOutcome ?? 'status_unavailable'
}

/**
 * What a surface knows about the close-reason criterion of a cancel-round instance.
 *  - `resolved`: the surface read the approval DETAIL (`getApproval`), which whitelist-projects
 *    `cancelRoundCloseReason`; `closeReason: null` then means 「no system closure」.
 *  - `resolving` / `unavailable`: a LIST row — list DTOs do not carry the reason — whose detail read
 *    is still in flight / failed.
 */
export type CancelRoundCloseReasonState =
  | { kind: 'resolved'; closeReason: string | null }
  | { kind: 'resolving' }
  | { kind: 'unavailable' }

/**
 * V-word for a cancel-round APPROVAL INSTANCE (the engine status plus the close-reason criterion).
 * `rejected` is the only ambiguous engine status: the system closure reuses it (lock:120/121), so
 * V3 is returned ONLY when the criterion was read and says 「no system closure」.
 */
export function cancelRoundStatusKeyFromApproval(
  status: string,
  closeState: CancelRoundCloseReasonState,
): CancelRoundPresentationKey {
  if (status === 'pending') return 'cancellation_pending_approval'
  if (status === 'approved') return 'leave_cancelled'
  if (status === 'revoked') return 'cancellation_withdrawn'
  if (status !== 'rejected') return 'status_unavailable'
  if (closeState.kind === 'resolving') return 'status_resolving'
  if (closeState.kind === 'unavailable') return 'status_unavailable'
  const reason = closeState.closeReason
  if (reason === null) return 'cancellation_rejected'
  if (reason === CANCEL_ROUND_CLOSE_REASON_EXPIRED) return 'cancellation_window_closed'
  if (reason.startsWith(CANCEL_ROUND_CLOSE_REASON_BLOCKED_PREFIX)) return 'cancellation_blocked'
  return 'status_unavailable'
}

/** The `<code>` of a `business_blocked:<code>` close reason, or `null`. */
export function blockCodeFromCloseReason(closeReason: string | null | undefined): string | null {
  if (typeof closeReason !== 'string') return null
  if (!closeReason.startsWith(CANCEL_ROUND_CLOSE_REASON_BLOCKED_PREFIX)) return null
  const code = closeReason.slice(CANCEL_ROUND_CLOSE_REASON_BLOCKED_PREFIX.length)
  return code.length > 0 ? code : null
}

/** Minimal row shape the five `StatusTag` render points share. */
export interface ApprovalStatusTagSource {
  status: string
  workflowKey?: string | null
  cancelRoundCloseReason?: string
}

/**
 * THE one domain selector for the five approval-instance StatusTag render points (P-2): a
 * cancel-round instance renders through the `cancelRound` domain, everything else through the
 * untouched `approvalInstance` domain. Detail surfaces pass nothing (the detail DTO carries the
 * criterion); list surfaces pass the state their lazy detail read reached.
 */
export function approvalStatusTagProps(
  row: ApprovalStatusTagSource,
  closeState?: CancelRoundCloseReasonState,
): { domain: StatusDomain; status: string } {
  if (!isCancelRoundWorkflow(row)) return { domain: 'approvalInstance', status: row.status }
  const state: CancelRoundCloseReasonState = closeState ?? {
    kind: 'resolved',
    closeReason: typeof row.cancelRoundCloseReason === 'string' ? row.cancelRoundCloseReason : null,
  }
  return { domain: 'cancelRound', status: cancelRoundStatusKeyFromApproval(row.status, state) }
}

/** A list row whose V-word cannot be decided without the detail read (only `rejected` is ambiguous). */
export function needsCancelRoundCloseReason(row: ApprovalStatusTagSource): boolean {
  return isCancelRoundWorkflow(row) && row.status === 'rejected' && typeof row.cancelRoundCloseReason !== 'string'
}

/** Timeline actor label: the system-closure sentinel is shown as 「系统」, never as a raw id. */
export function isCancelRoundSystemActor(actorId: string | null | undefined, actorName: string | null | undefined): boolean {
  return actorId === CANCEL_ROUND_SYSTEM_ACTOR_ID || actorName === CANCEL_ROUND_SYSTEM_ACTOR_ID
}

// ---------------------------------------------------------------------------
// Error copy (P-7 / P-8 / P-6′).

/**
 * `creation`   — launch-time refusals: there is no round yet, so there is no status, only an error.
 * `retryable`  — V7/V8: throw ⇒ rollback ⇒ the round stays `pending`, seats kept; say 「稍后重试」,
 *                never 「失败」, and never the same shape as 「no round」.
 * `nonTerminal`— the round also stays `pending`, but a retry would not help; point at an admin.
 * `withdraw`   — the requester's withdraw refusals.
 * `other`      — everything else (server message, or the caller's fallback).
 */
export type CancelRoundErrorClass = 'creation' | 'retryable' | 'nonTerminal' | 'withdraw' | 'other'

interface CancelRoundErrorCopyEntry {
  cls: CancelRoundErrorClass
  zh: string
  en: string
  /** V7 / V8 for the retryable class. */
  presentationKey?: 'action_incomplete_retry' | 'system_busy_retry'
}

/**
 * P-6′ weak copy (owner option 「(ii) Reuse approval notices (Recommended)」: 「weaker
 * employee-facing copy until RC (c) lands」). Used for BOTH seat-class codes: it claims no cause.
 */
export const CANCEL_ROUND_SEAT_CLASS_COPY = {
  zh: '暂时无法发起撤销,请联系管理员',
  en: 'A cancellation cannot be started right now — please contact an administrator',
} as const

const RETRY_V7 = {
  zh: '本次操作未完成,请稍后重试(撤销申请仍在审批中)',
  en: 'Action did not complete — please try again later (the cancellation is still pending)',
}
const RETRY_V8 = {
  zh: '系统繁忙,请稍后重试(撤销申请仍在审批中)',
  en: 'System busy — please try again later (the cancellation is still pending)',
}

/** Unified copy for the two codes that mean 「an approver already acted」 (proposal §3.4). */
const WITHDRAW_CLOSED = {
  zh: '已有审批人处理过,无法再撤回本次撤销申请',
  en: 'An approver has already acted — this cancellation can no longer be withdrawn',
}

export const CANCEL_ROUND_ERROR_COPY: Readonly<Record<string, CancelRoundErrorCopyEntry>> = Object.freeze({
  // ① creation-time (P-8 ①)
  CANCEL_ROUND_DOCUMENT_NOT_APPROVED: { cls: 'creation', zh: '只有已通过的请假才能发起撤销', en: 'Only an approved leave can be cancelled' },
  CANCEL_ROUND_REQUESTER_ONLY: { cls: 'creation', zh: '只有请假本人可以发起撤销', en: 'Only the person who requested this leave can cancel it' },
  CANCEL_ROUND_SUITE_FORBIDDEN: { cls: 'creation', zh: '该类型的请假不支持撤销', en: 'This type of leave cannot be cancelled' },
  CANCEL_ROUND_ALREADY_PENDING: { cls: 'creation', zh: '这条请假已有一个撤销申请在审批中', en: 'This leave already has a cancellation pending approval' },
  CANCEL_ROUND_NO_ELIGIBLE_APPROVER: { cls: 'creation', ...CANCEL_ROUND_SEAT_CLASS_COPY },
  CANCEL_ROUND_SEAT_INELIGIBLE: { cls: 'creation', ...CANCEL_ROUND_SEAT_CLASS_COPY },
  CANCEL_ROUND_SUITE_UNKNOWN: { cls: 'creation', zh: '该请假的撤销规则配置有误,请联系管理员', en: 'The cancellation rules for this leave are misconfigured — please contact an administrator' },
  CANCEL_ROUND_WINDOW_OUT_OF_RANGE: { cls: 'creation', zh: '该请假的撤销规则配置有误,请联系管理员', en: 'The cancellation rules for this leave are misconfigured — please contact an administrator' },
  CANCEL_ROUND_OUTLET_FORBIDDEN: { cls: 'creation', zh: '撤销申请不支持该操作,请联系管理员', en: 'This action is not available for a cancellation — please contact an administrator' },
  CANCEL_ROUND_CREATE_FAILED: { cls: 'creation', zh: '撤销申请未能创建,请稍后重试', en: 'The cancellation could not be created — please try again later' },
  // ③ retryable, non-terminal (P-8 ③): the round stays pending.
  CANCEL_ROUND_WINDOW_ANCHOR_MISSING: { cls: 'retryable', presentationKey: 'action_incomplete_retry', ...RETRY_V7 },
  CANCEL_ROUND_INVARIANT_VIOLATION: { cls: 'retryable', presentationKey: 'action_incomplete_retry', ...RETRY_V7 },
  CANCEL_ROUND_EXECUTION_PORT_UNAVAILABLE: { cls: 'retryable', presentationKey: 'action_incomplete_retry', ...RETRY_V7 },
  CANCEL_ROUND_ROLLOUT_LOCK_SCOPE_CHANGED: { cls: 'retryable', presentationKey: 'action_incomplete_retry', ...RETRY_V7 },
  CANCEL_ROUND_DISPATCH_CONTENDED: { cls: 'retryable', presentationKey: 'system_busy_retry', ...RETRY_V8 },
  ATTENDANCE_CALCULATION_ROLLOUT_BUSY: { cls: 'retryable', presentationKey: 'system_busy_retry', ...RETRY_V8 },
  // Non-terminal (rolled back, round stays pending) but not fixed by retrying.
  CANCEL_ROUND_BUSINESS_TARGET_MISSING: {
    cls: 'nonTerminal',
    zh: '本次操作未完成(撤销申请仍在审批中),请联系管理员',
    en: 'Action did not complete (the cancellation is still pending) — please contact an administrator',
  },
  // Withdraw refusals (engine revoke gate codes, unchanged).
  APPROVAL_REVOKE_WINDOW_CLOSED: { cls: 'withdraw', ...WITHDRAW_CLOSED },
  INVALID_STATUS_TRANSITION: { cls: 'withdraw', ...WITHDRAW_CLOSED },
  APPROVAL_REVOKE_FORBIDDEN: { cls: 'withdraw', zh: '只有请假本人可以撤回撤销申请', en: 'Only the person who requested this leave can withdraw the cancellation' },
  APPROVAL_REVOKE_DISABLED: { cls: 'withdraw', zh: '该撤销申请不允许撤回', en: 'This cancellation cannot be withdrawn' },
  // Entry-level plugin codes that can reach the dialogs.
  NOT_FOUND: { cls: 'other', zh: '找不到这条请假或撤销申请,请刷新后重试', en: 'This leave or cancellation was not found — please refresh and try again' },
  FORBIDDEN: { cls: 'other', zh: '没有权限执行此操作', en: 'You do not have permission to do this' },
})

export interface CancelRoundErrorDescription {
  message: string
  cls: CancelRoundErrorClass
  code: string | null
  /** V7 / V8 when the refusal left the round pending and a retry is legitimate. */
  presentationKey: 'action_incomplete_retry' | 'system_busy_retry' | null
}

function errorCodeOf(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return null
}

/**
 * Copy for a failed cancel-round call. Registered codes get their fixed copy; any other code keeps
 * the server's own message (this is what the approval side already shows — e.g. the no-seat 403
 * `APPROVAL_ASSIGNMENT_REQUIRED`, kept 「same as approval side」 by the owner's 14:3x choice), and a
 * message-less failure falls back to the caller's copy.
 */
export function describeCancelRoundError(error: unknown, isZh: boolean, fallback: string): CancelRoundErrorDescription {
  const code = errorCodeOf(error)
  const entry = code ? CANCEL_ROUND_ERROR_COPY[code] : undefined
  if (entry) {
    return {
      message: isZh ? entry.zh : entry.en,
      cls: entry.cls,
      code,
      presentationKey: entry.presentationKey ?? null,
    }
  }
  const message = error instanceof Error && error.message ? error.message : fallback
  return { message, cls: 'other', code, presentationKey: null }
}

// ---------------------------------------------------------------------------
// Business-blocked codes (P-7). Known producers at this head: C-1's attendance refusal and the
// in-lock policy evaluation's two configuration codes. Every other code is rendered at category
// level with the raw code folded away as a copyable technical detail.

export const CANCEL_ROUND_BLOCK_CATEGORY_COPY = {
  zh: '该请假已不可撤销(业务原因)',
  en: 'This leave can no longer be cancelled (business reason)',
} as const

export const CANCEL_ROUND_BLOCK_CODE_COPY: Readonly<Record<string, { zh: string; en: string }>> = Object.freeze({
  ATTENDANCE_CANCELLATION_REVIEW_REQUIRED: {
    zh: '该请假关联的考勤结果需要复核,已无法撤销',
    en: 'The attendance result for this leave needs review, so it can no longer be cancelled',
  },
  CANCEL_ROUND_SUITE_UNKNOWN: {
    zh: '该请假的撤销规则配置有误,已无法撤销',
    en: 'The cancellation rules for this leave are misconfigured, so it can no longer be cancelled',
  },
  CANCEL_ROUND_WINDOW_OUT_OF_RANGE: {
    zh: '该请假的撤销规则配置有误,已无法撤销',
    en: 'The cancellation rules for this leave are misconfigured, so it can no longer be cancelled',
  },
})

export interface CancelRoundBlockDescription {
  message: string
  /** The raw code, for the folded technical detail. Present for known and unknown codes alike. */
  code: string | null
  known: boolean
}

export function describeCancelRoundBlock(blockCode: string | null | undefined, isZh: boolean): CancelRoundBlockDescription {
  const code = typeof blockCode === 'string' && blockCode.length > 0 ? blockCode : null
  const entry = code ? CANCEL_ROUND_BLOCK_CODE_COPY[code] : undefined
  if (entry) return { message: isZh ? entry.zh : entry.en, code, known: true }
  return {
    message: isZh ? CANCEL_ROUND_BLOCK_CATEGORY_COPY.zh : CANCEL_ROUND_BLOCK_CATEGORY_COPY.en,
    code,
    known: false,
  }
}

// ---------------------------------------------------------------------------
// Attendance-side routes (owner 2026-09-28 Q1′ 「(i) Attendance-side」 + 2026-09-29 11:0x
// 「Attendance-side + OFF flag」).

function cancelRoundPath(requestId: string, suffix = ''): string {
  return `/api/attendance/requests/${encodeURIComponent(requestId)}/cancel-round${suffix}`
}

async function readCancelRoundResponse(response: Response): Promise<Record<string, unknown> | null> {
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok || (payload && payload.ok === false)) {
    const errorField = payload?.error
    const errorRecord = errorField && typeof errorField === 'object' ? (errorField as Record<string, unknown>) : null
    const code = typeof errorRecord?.code === 'string' ? errorRecord.code : undefined
    const rawMessage = typeof errorRecord?.message === 'string'
      ? errorRecord.message
      : typeof errorField === 'string'
        ? errorField
        : ''
    const message = rawMessage.trim().length > 0 ? rawMessage : `请求失败（${response.status}）`
    throw new ApprovalApiError(message, response.status, code)
  }
  return payload
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function normalizeRound(raw: unknown): CancelRoundSummaryRound | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.roundId !== 'string' || typeof r.outcome !== 'string') return null
  return {
    roundId: r.roundId,
    engineInstanceId: toStringOrNull(r.engineInstanceId),
    outcome: r.outcome,
    status: typeof r.status === 'string' ? r.status : '',
    startedAt: toStringOrNull(r.startedAt),
    endedAt: toStringOrNull(r.endedAt),
    closeReason: toStringOrNull(r.closeReason),
    blockCode: toStringOrNull(r.blockCode),
    closedBySystem: r.closedBySystem === true,
    canWithdraw: r.canWithdraw === true,
    withdrawBlockedReason: toStringOrNull(r.withdrawBlockedReason),
    cancellationOutcome: normalizeCancellationOutcome(r.cancellationOutcome),
  }
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function normalizeCancellationOutcome(raw: unknown): CancelRoundCancellationOutcome | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.status === 'cancelled_reversal_unreported') return { status: 'cancelled_reversal_unreported', reversal: null }
  if (o.status !== 'cancelled' && o.status !== 'cancelled_with_unrecoverable_expired') return null
  const rev = o.reversal && typeof o.reversal === 'object' ? (o.reversal as Record<string, unknown>) : null
  if (!rev) return null
  const reversed = finiteOrNull(rev.reversed)
  const lots = finiteOrNull(rev.lots)
  const unrecoverableExpired = finiteOrNull(rev.unrecoverableExpired)
  if (reversed === null || lots === null || unrecoverableExpired === null || typeof rev.alreadyReversed !== 'boolean') return null
  return { status: o.status, reversal: { reversed, lots, unrecoverableExpired, alreadyReversed: rev.alreadyReversed } }
}

export function normalizeCancelRoundSummary(payload: unknown, requestId: string): CancelRoundSummary {
  const envelope = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const data = envelope.data && typeof envelope.data === 'object' ? (envelope.data as Record<string, unknown>) : envelope
  return {
    requestId: typeof data.requestId === 'string' ? data.requestId : requestId,
    documentInstanceId: toStringOrNull(data.documentInstanceId),
    entryEnabled: data.entryEnabled === true,
    round: normalizeRound(data.round),
  }
}

/** `GET /api/attendance/requests/:id/cancel-round` (attendance:read). */
export async function fetchCancelRoundSummary(requestId: string): Promise<CancelRoundSummary> {
  const response = await apiFetch(cancelRoundPath(requestId))
  const payload = await readCancelRoundResponse(response)
  return normalizeCancelRoundSummary(payload, requestId)
}

function withOptionalText(key: string, value: string | null | undefined): Record<string, string> {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed ? { [key]: trimmed } : {}
}

/** `POST /api/attendance/requests/:id/cancel-round` (attendance:write; default-OFF flag server side). */
export async function launchCancelRound(requestId: string, reason?: string | null): Promise<void> {
  const response = await apiFetch(cancelRoundPath(requestId), {
    method: 'POST',
    body: JSON.stringify(withOptionalText('reason', reason)),
  })
  await readCancelRoundResponse(response)
}

/** `POST /api/attendance/requests/:id/cancel-round/withdraw` (attendance:write). */
export async function withdrawCancelRound(requestId: string, comment?: string | null): Promise<void> {
  const response = await apiFetch(cancelRoundPath(requestId, '/withdraw'), {
    method: 'POST',
    body: JSON.stringify(withOptionalText('comment', comment)),
  })
  await readCancelRoundResponse(response)
}

/** `POST /api/attendance/requests/:id/cancel-round/actions` (attendance:approve). */
export async function decideCancelRound(
  requestId: string,
  action: 'approve' | 'reject',
  comment?: string | null,
): Promise<void> {
  const response = await apiFetch(cancelRoundPath(requestId, '/actions'), {
    method: 'POST',
    body: JSON.stringify({ action, ...withOptionalText('comment', comment) }),
  })
  await readCancelRoundResponse(response)
}

// ---------------------------------------------------------------------------
// Approver path from the approval side (④). A cancel-round instance's `businessKey` is the ORIGINAL
// approval instance id (not the attendance request id), and that original instance's `businessKey`
// is `attendance-request:<id>`. Two reads, fail closed: a resolution failure NEVER falls back to the
// generic `/api/approvals/:id/actions` route.

export const CANCEL_ROUND_LEAVE_UNRESOLVED_COPY = {
  zh: '无法定位这条撤销申请对应的请假,请到考勤页面办理或联系管理员',
  en: 'The leave behind this cancellation could not be located — please act on it from Attendance or contact an administrator',
} as const

const leaveRequestIdCache = new Map<string, string>()

/** Test hook: forget resolved ids. */
export function resetCancelRoundLeaveRequestIdCache(): void {
  leaveRequestIdCache.clear()
}

export function parseAttendanceRequestBusinessKey(businessKey: string | null | undefined): string | null {
  if (typeof businessKey !== 'string' || !businessKey.startsWith(ATTENDANCE_REQUEST_BUSINESS_KEY_PREFIX)) return null
  const id = businessKey.slice(ATTENDANCE_REQUEST_BUSINESS_KEY_PREFIX.length)
  return id.length > 0 ? id : null
}

export async function resolveCancelRoundLeaveRequestId(
  approval: { id: string; businessKey: string | null },
  isZh = true,
): Promise<string> {
  const cached = leaveRequestIdCache.get(approval.id)
  if (cached) return cached
  const unresolved = () =>
    new ApprovalApiError(isZh ? CANCEL_ROUND_LEAVE_UNRESOLVED_COPY.zh : CANCEL_ROUND_LEAVE_UNRESOLVED_COPY.en, 0)
  if (typeof approval.businessKey !== 'string' || approval.businessKey.length === 0) throw unresolved()
  let original: { businessKey: string | null } | null = null
  try {
    original = await getApproval(approval.businessKey)
  } catch {
    throw unresolved()
  }
  const requestId = parseAttendanceRequestBusinessKey(original?.businessKey ?? null)
  if (!requestId) throw unresolved()
  leaveRequestIdCache.set(approval.id, requestId)
  return requestId
}

/**
 * Approve / reject a cancel-round instance through the attendance route. The thrown error (an
 * `ApprovalApiError`) carries the mapped copy as its message, so existing dialog code that renders
 * `error.message` shows registered copy for registered codes and the server's own text otherwise.
 */
export async function decideCancelRoundFromApproval(
  approval: { id: string; businessKey: string | null },
  action: 'approve' | 'reject',
  comment?: string | null,
  isZh = true,
): Promise<void> {
  const requestId = await resolveCancelRoundLeaveRequestId(approval, isZh)
  try {
    await decideCancelRound(requestId, action, comment)
  } catch (error) {
    const described = describeCancelRoundError(error, isZh, isZh ? '操作失败，请重试' : 'Action failed, please retry')
    const status = error instanceof ApprovalApiError ? error.status : 0
    throw new ApprovalApiError(described.message, status, described.code ?? undefined)
  }
}
