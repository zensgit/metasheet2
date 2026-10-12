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
 *  - approve / reject / withdraw success bodies are minimal (`{ requestId, roundId, outcome, status }`).
 *    The only field read from any of them is `roundId`, to confirm which round was decided or withdrawn
 *    (see `decideCancelRoundOnRequest`, `decideListedCancelRound` and the attendance panel's withdraw);
 *    every caller re-reads the summary (or the approval detail) after a successful write.
 *  - every approve / reject / withdraw this client sends names the round on screen (`expectedRoundId`,
 *    phase D D2): the server refuses it — 409 `INVALID_STATUS_TRANSITION`, nothing written — when that is
 *    no longer the leave's current round, instead of acting on a round the page never showed.
 */
import { apiFetch } from '../utils/api'
import type { StatusDomain } from '../utils/statusDomains'
import type { ApprovalActionRequest } from '../types/approval'
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
  /**
   * P-5 delivery status of THIS round's own notices. `null` = the read did not report deliveries at
   * all (absent / not a list on the wire) — rendered as nothing, never as 「no notices were sent」;
   * `[]` = reported, none.
   */
  deliveries: CancelRoundDelivery[] | null
}

// ---------------------------------------------------------------------------
// P-5 (owner 「(iii) Full delivery」 with 「Full status, no raw ids/errors (Recommended)」; 16:5x
// 「Show the list (Recommended)」): per delivery the status (delivered / pending / failed), the channel
// TYPE, the attempt count and timestamps — nothing else is read off the wire. Each status has fixed
// category copy. A delivery's status never changes the round's: the round's V-word comes from the
// round alone (lock invariant 「投递失败不改变撤销轮任何状态」).

export const CANCEL_ROUND_DELIVERY_STATUSES = ['delivered', 'pending', 'failed'] as const
export type CancelRoundDeliveryStatus = (typeof CANCEL_ROUND_DELIVERY_STATUSES)[number]

export interface CancelRoundDelivery {
  channelType: string
  status: CancelRoundDeliveryStatus
  attempts: number
  createdAt: string | null
  lastAttemptAt: string | null
  updatedAt: string | null
}

export const CANCEL_ROUND_DELIVERY_STATUS_COPY: Readonly<Record<CancelRoundDeliveryStatus, { zh: string; en: string }>> = Object.freeze({
  delivered: { zh: '已送达', en: 'Delivered' },
  pending: { zh: '发送中或结果待确认', en: 'Sending, or the result is not confirmed yet' },
  failed: { zh: '未能送达(不影响撤销申请本身)', en: 'Not delivered (the cancellation itself is not affected)' },
})

export const CANCEL_ROUND_DELIVERY_CHANNEL_COPY: Readonly<Record<string, { zh: string; en: string }>> = Object.freeze({
  dingtalk_approval_card: { zh: '钉钉审批卡片', en: 'DingTalk approval card' },
  dingtalk_todo: { zh: '钉钉待办', en: 'DingTalk to-do' },
})

/** A channel type this client has no label for is shown under a neutral label, never dropped. */
export const CANCEL_ROUND_DELIVERY_CHANNEL_OTHER_COPY = { zh: '其他通知渠道', en: 'Other notification channel' } as const

/**
 * Field-by-field copy of the six P-5 fields. A row whose status is not one of the three values is
 * dropped (it cannot be given category copy — the same rule the server applies to an unknown ledger
 * state); an unknown channel type is kept and labelled neutrally.
 */
export function normalizeCancelRoundDeliveries(raw: unknown): CancelRoundDelivery[] | null {
  if (!Array.isArray(raw)) return null
  const deliveries: CancelRoundDelivery[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const d = entry as Record<string, unknown>
    if (typeof d.status !== 'string' || !(CANCEL_ROUND_DELIVERY_STATUSES as readonly string[]).includes(d.status)) continue
    deliveries.push({
      channelType: typeof d.channelType === 'string' ? d.channelType : '',
      status: d.status as CancelRoundDeliveryStatus,
      attempts: typeof d.attempts === 'number' && Number.isFinite(d.attempts) && d.attempts >= 0 ? Math.trunc(d.attempts) : 0,
      createdAt: typeof d.createdAt === 'string' ? d.createdAt : null,
      lastAttemptAt: typeof d.lastAttemptAt === 'string' ? d.lastAttemptAt : null,
      updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : null,
    })
  }
  return deliveries
}

export function cancelRoundDeliveryChannelLabel(channelType: string, isZh: boolean): string {
  const copy = CANCEL_ROUND_DELIVERY_CHANNEL_COPY[channelType] ?? CANCEL_ROUND_DELIVERY_CHANNEL_OTHER_COPY
  return isZh ? copy.zh : copy.en
}

export function cancelRoundDeliveryStatusLabel(status: CancelRoundDeliveryStatus, isZh: boolean): string {
  const copy = CANCEL_ROUND_DELIVERY_STATUS_COPY[status]
  return isZh ? copy.zh : copy.en
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
// Business-blocked codes (P-7). Known producers at this head: C-1's attendance refusal, the
// in-lock policy evaluation's two configuration codes, and the in-lock re-check that the original
// leave is still approved (`CANCEL_ROUND_DOCUMENT_NOT_APPROVED`, the creation path's own code).
// Every other code is rendered at category level with the raw code folded away as a copyable
// technical detail.

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
  // The server keys this code on the original leave's status, not on what changed it, so the copy
  // gives the direct cancel as an example rather than as the cause.
  CANCEL_ROUND_DOCUMENT_NOT_APPROVED: {
    zh: '该请假已不再是已通过状态(例如已被取消),本次撤销未执行',
    en: 'This leave is no longer approved (for example, it has already been cancelled), so this cancellation was not carried out',
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
    deliveries: normalizeCancelRoundDeliveries(r.deliveries),
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

/**
 * `POST /api/attendance/requests/:id/cancel-round/withdraw` (attendance:write). Resolves to the `roundId`
 * the minimal success body names — the round the server actually withdrew — or `null` when the body does
 * not name one. `expectedRoundId`: the round on screen; the server refuses (409 `INVALID_STATUS_TRANSITION`,
 * nothing written) when it is not the leave's current round — the same code, and for the withdraw the
 * same message, as a round that has already finished, so the caller tells the two apart by re-reading.
 */
export async function withdrawCancelRound(
  requestId: string,
  comment?: string | null,
  expectedRoundId?: string | null,
): Promise<string | null> {
  const response = await apiFetch(cancelRoundPath(requestId, '/withdraw'), {
    method: 'POST',
    body: JSON.stringify({ ...withOptionalText('comment', comment), ...withOptionalText('expectedRoundId', expectedRoundId) }),
  })
  const payload = await readCancelRoundResponse(response)
  const data = payload?.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : null
  return typeof data?.roundId === 'string' && data.roundId.length > 0 ? data.roundId : null
}

/**
 * `POST /api/attendance/requests/:id/cancel-round/actions` (attendance:approve). Resolves to the
 * `roundId` the minimal success body names — the round the server actually decided — or `null` when
 * the body does not name one. `expectedRoundId` (optional): the round on screen; the server refuses
 * (409 `INVALID_STATUS_TRANSITION`, nothing written) when it is not the leave's current round.
 */
export async function decideCancelRound(
  requestId: string,
  action: 'approve' | 'reject',
  comment?: string | null,
  expectedRoundId?: string | null,
): Promise<string | null> {
  const response = await apiFetch(cancelRoundPath(requestId, '/actions'), {
    method: 'POST',
    body: JSON.stringify({ action, ...withOptionalText('comment', comment), ...withOptionalText('expectedRoundId', expectedRoundId) }),
  })
  const payload = await readCancelRoundResponse(response)
  const data = payload?.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : null
  return typeof data?.roundId === 'string' && data.roundId.length > 0 ? data.roundId : null
}

// ---------------------------------------------------------------------------
// Attendance-side 「待我审批的撤销」 list (owner 2026-09-29 16:5x 「Attendance-side list
// (Recommended)」: guarded by `attendance:approve`, filtered to the viewer's own live seats, same seat
// source as the decision route). Contract agreed with the backend lane:
//   GET /api/attendance/cancel-rounds/pending
//   ⇒ { ok: true, data: { items: [{ requestId, roundId, engineInstanceId, requesterUserId,
//        requesterName, requestType, startAt, endAt, launchedAt }], total } }   (requesterName may be null)
// A response that does not have this shape is a failed read — never an empty list.

export interface PendingCancelRoundItem {
  requestId: string
  roundId: string
  engineInstanceId: string
  requesterUserId: string | null
  requesterName: string | null
  requestType: string | null
  startAt: string | null
  endAt: string | null
  launchedAt: string | null
}

export interface PendingCancelRoundList {
  items: PendingCancelRoundItem[]
  total: number
}

export const CANCEL_ROUND_PENDING_LIST_PATH = '/api/attendance/cancel-rounds/pending'

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Strict: any item without the three ids it is acted on by makes the whole read a failure. */
export function normalizePendingCancelRoundList(payload: unknown): PendingCancelRoundList {
  const envelope = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
  const data = envelope?.data && typeof envelope.data === 'object' ? (envelope.data as Record<string, unknown>) : null
  if (!data || !Array.isArray(data.items)) throw new Error('Malformed pending cancellation list')
  const items = data.items.map((raw): PendingCancelRoundItem => {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const requestId = nonEmptyString(r.requestId)
    const roundId = nonEmptyString(r.roundId)
    const engineInstanceId = nonEmptyString(r.engineInstanceId)
    if (!requestId || !roundId || !engineInstanceId) throw new Error('Malformed pending cancellation item')
    return {
      requestId,
      roundId,
      engineInstanceId,
      requesterUserId: toStringOrNull(r.requesterUserId),
      requesterName: nonEmptyString(r.requesterName),
      requestType: toStringOrNull(r.requestType),
      startAt: toStringOrNull(r.startAt),
      endAt: toStringOrNull(r.endAt),
      launchedAt: toStringOrNull(r.launchedAt),
    }
  })
  const total = typeof data.total === 'number' && Number.isFinite(data.total) && data.total >= items.length
    ? data.total
    : items.length
  return { items, total }
}

/** `GET /api/attendance/cancel-rounds/pending` (attendance:approve). Throws on any non-2xx or malformed body. */
export async function fetchPendingCancelRounds(): Promise<PendingCancelRoundList> {
  const response = await apiFetch(CANCEL_ROUND_PENDING_LIST_PATH)
  const payload = await readCancelRoundResponse(response)
  return normalizePendingCancelRoundList(payload)
}

/**
 * Display predicate for the approver decision on a cancel round, shared by the detail view, the
 * approval center (inline, pane, batch) and the attendance-side pending list (whose route the owner's
 * 16:5x option names as 「guarded by attendance:approve」). It mirrors the grant the attendance decision
 * route actually checks: `withPermission('attendance:approve')`, which the plugin's `withAnyPermission`
 * satisfies for an admin, a holder of `attendance:approve`, or a holder of `attendance:admin`. Display
 * only — the route (grant, seat, §9-9) decides.
 */
export function canDecideCancelRoundWith(
  access: { readonly isAdmin: boolean; readonly permissions: readonly string[] } | null | undefined,
): boolean {
  if (!access) return false
  return access.isAdmin
    || access.permissions.includes('attendance:approve')
    || access.permissions.includes('attendance:admin')
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

/**
 * The attendance decision route acts on the leave's LATEST cancel round unless the body names one. So
 * the approval side confirms — before sending anything — that the round on screen IS that round and is
 * still pending, sends the confirmed round as `expectedRoundId` (the server then refuses, writing
 * nothing, if another round replaced it in between), and afterwards checks that the round the server
 * decided is the one it confirmed. These three refusals are raised by the client:
 *  - `ROUND_UNVERIFIED`: the pre-read failed (for example the viewer may not read the leave); nothing sent.
 *  - `ROUND_NOT_CURRENT`: the round on screen is no longer the leave's pending round — found by the
 *    pre-read (nothing sent), or by the server's 409 `INVALID_STATUS_TRANSITION` for the named round
 *    (nothing written).
 *  - `ACTED_ROUND_UNCONFIRMED`: the decision WAS accepted, but for a round other than the confirmed one
 *    (or the body did not name it) — never announced as a success, never as 「失败，请重试」.
 */
export const CANCEL_ROUND_CLIENT_ROUND_UNVERIFIED = 'CANCEL_ROUND_CLIENT_ROUND_UNVERIFIED'
export const CANCEL_ROUND_CLIENT_ROUND_NOT_CURRENT = 'CANCEL_ROUND_CLIENT_ROUND_NOT_CURRENT'
export const CANCEL_ROUND_CLIENT_ACTED_ROUND_UNCONFIRMED = 'CANCEL_ROUND_CLIENT_ACTED_ROUND_UNCONFIRMED'

export const CANCEL_ROUND_CLIENT_COPY: Readonly<Record<string, { zh: string; en: string }>> = Object.freeze({
  [CANCEL_ROUND_CLIENT_ROUND_UNVERIFIED]: {
    zh: '暂时无法核对这条撤销申请的当前状态;未执行任何操作,请刷新后重试或联系管理员',
    en: 'The current state of this cancellation could not be confirmed — nothing was done. Please refresh and try again, or contact an administrator',
  },
  [CANCEL_ROUND_CLIENT_ROUND_NOT_CURRENT]: {
    zh: '这条撤销申请已不在审批中,或已有更新的撤销申请;未执行任何操作,请刷新后查看',
    en: 'This cancellation is no longer pending, or a newer cancellation has replaced it — nothing was done. Please refresh',
  },
  [CANCEL_ROUND_CLIENT_ACTED_ROUND_UNCONFIRMED]: {
    zh: '操作已提交,但无法确认它作用于页面上的这条撤销申请,请刷新后核对结果',
    en: 'The action was submitted, but it could not be confirmed that it applied to the cancellation shown here — please refresh and check the result',
  },
})

function cancelRoundClientRefusal(code: string, isZh: boolean): ApprovalApiError {
  const copy = CANCEL_ROUND_CLIENT_COPY[code]
  return new ApprovalApiError(isZh ? copy.zh : copy.en, 0, code)
}

/**
 * The decision WAS accepted by the server, but for a round other than the confirmed one (or the body
 * did not name it): not a failure — a batch counts it apart from its failures.
 */
export function isCancelRoundActedRoundUnconfirmed(error: unknown): boolean {
  return errorCodeOf(error) === CANCEL_ROUND_CLIENT_ACTED_ROUND_UNCONFIRMED
}

/** One of the three client refusals above: the page is showing a round that was not (or may not have been) the one decided. */
export function isCancelRoundClientRefusal(error: unknown): boolean {
  const code = errorCodeOf(error)
  return code !== null && Object.prototype.hasOwnProperty.call(CANCEL_ROUND_CLIENT_COPY, code)
}

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
 *
 * The approval side knows the round by its own instance id only; the leave is resolved first (two
 * reads, fail closed) and the decision then goes through `decideCancelRoundOnRequest`.
 */
export async function decideCancelRoundFromApproval(
  approval: { id: string; businessKey: string | null },
  action: 'approve' | 'reject',
  comment?: string | null,
  isZh = true,
): Promise<void> {
  const requestId = await resolveCancelRoundLeaveRequestId(approval, isZh)
  await decideCancelRoundOnRequest(requestId, { engineInstanceId: approval.id }, action, comment, isZh)
}

/**
 * The approval side's decision path for a cancel round shown on screen (the attendance-side
 * 「待我审批的撤销」 list uses `decideListedCancelRound` since phase D D2).
 *
 * The route decides the leave's latest round, so the round on screen (`expected.engineInstanceId`,
 * and `expected.roundId` when the surface knows it) is first confirmed — by the summary read — to be
 * that round and still pending; a failed or mismatching read sends nothing (fail closed; the same
 * for a delegate who may not read the leave). The decision then names the confirmed round
 * (`expectedRoundId`), so a round that replaced it after the read is refused by the server — 409
 * `INVALID_STATUS_TRANSITION`, nothing written, shown as `ROUND_NOT_CURRENT` (reviewer finding F1,
 * 2026-10-08: before, that window let the decision land on a round the approver never saw). After the
 * decision, the `roundId` the server names must be the confirmed round, or the caller is told to
 * re-check instead of being told it succeeded.
 */
export async function decideCancelRoundOnRequest(
  requestId: string,
  expected: { engineInstanceId: string; roundId?: string | null },
  action: 'approve' | 'reject',
  comment?: string | null,
  isZh = true,
): Promise<void> {
  let summary: CancelRoundSummary
  try {
    summary = await fetchCancelRoundSummary(requestId)
  } catch {
    throw cancelRoundClientRefusal(CANCEL_ROUND_CLIENT_ROUND_UNVERIFIED, isZh)
  }
  const confirmed = summary.round
  if (
    !confirmed
    || confirmed.engineInstanceId !== expected.engineInstanceId
    || confirmed.outcome !== 'pending'
    || (typeof expected.roundId === 'string' && confirmed.roundId !== expected.roundId)
  ) {
    throw cancelRoundClientRefusal(CANCEL_ROUND_CLIENT_ROUND_NOT_CURRENT, isZh)
  }
  let actedRoundId: string | null
  try {
    actedRoundId = await decideCancelRound(requestId, action, comment, confirmed.roundId)
  } catch (error) {
    // The named round is no longer the leave's current round, or it finished after the pre-read: the
    // server wrote nothing either way. Never the registered withdraw copy (「已有审批人处理过…」).
    if (errorCodeOf(error) === 'INVALID_STATUS_TRANSITION') {
      throw cancelRoundClientRefusal(CANCEL_ROUND_CLIENT_ROUND_NOT_CURRENT, isZh)
    }
    const described = describeCancelRoundError(error, isZh, isZh ? '操作失败，请重试' : 'Action failed, please retry')
    const status = error instanceof ApprovalApiError ? error.status : 0
    throw new ApprovalApiError(described.message, status, described.code ?? undefined)
  }
  if (actedRoundId !== confirmed.roundId) {
    throw cancelRoundClientRefusal(CANCEL_ROUND_CLIENT_ACTED_ROUND_UNCONFIRMED, isZh)
  }
}

/**
 * The attendance-side 「待我审批的撤销」 list's decision path (phase D D2). The list row names the round
 * (`roundId`), so the decision carries it as `expectedRoundId` and the SERVER confirms it is still the
 * leave's current round — refusing with 409 `INVALID_STATUS_TRANSITION` (nothing written) when it is
 * not. There is no summary pre-read: that read stays behind the original document's read predicate,
 * which a seated delegator does not pass. The refusal is shown with the client's 「no longer pending /
 * replaced — nothing was done」 copy (`ROUND_NOT_CURRENT`); after the decision, the `roundId` the server
 * names must be the listed one, or the caller is told to re-check. The approval-side path
 * (`decideCancelRoundOnRequest`) keeps its pre-read and, since reviewer finding F1 (2026-10-08), also
 * names the confirmed round.
 */
export async function decideListedCancelRound(
  requestId: string,
  expectedRoundId: string,
  action: 'approve' | 'reject',
  comment?: string | null,
  isZh = true,
): Promise<void> {
  let actedRoundId: string | null
  try {
    actedRoundId = await decideCancelRound(requestId, action, comment, expectedRoundId)
  } catch (error) {
    if (errorCodeOf(error) === 'INVALID_STATUS_TRANSITION') {
      throw cancelRoundClientRefusal(CANCEL_ROUND_CLIENT_ROUND_NOT_CURRENT, isZh)
    }
    const described = describeCancelRoundError(error, isZh, isZh ? '操作失败，请重试' : 'Action failed, please retry')
    const status = error instanceof ApprovalApiError ? error.status : 0
    throw new ApprovalApiError(described.message, status, described.code ?? undefined)
  }
  if (actedRoundId !== expectedRoundId) {
    throw cancelRoundClientRefusal(CANCEL_ROUND_CLIENT_ACTED_ROUND_UNCONFIRMED, isZh)
  }
}

/**
 * The approval center's single decision path (inline 通过 / row 驳回 / batch): a cancel-round row's
 * approve / reject goes to the attendance route; every other row (and every other verb) keeps the
 * caller's generic dispatcher. Fail closed: a cancel-round row whose leave cannot be resolved throws —
 * it is never re-sent through the generic route.
 */
export async function dispatchApprovalDecision(
  row: { id: string; workflowKey?: string | null; businessKey: string | null },
  req: ApprovalActionRequest,
  dispatchGeneric: (id: string, req: ApprovalActionRequest) => Promise<unknown>,
  isZh = true,
): Promise<void> {
  if (isCancelRoundWorkflow(row) && (req.action === 'approve' || req.action === 'reject')) {
    await decideCancelRoundFromApproval(row, req.action, req.comment, isZh)
    return
  }
  await dispatchGeneric(row.id, req)
}
