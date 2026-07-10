/**
 * B-4 (Slice B design lock §B-4): terminal card update — the presentation follow-up that maps the
 * B-3 callback outcome union onto an in-place DingTalk card update.
 *
 * Non-negotiables encoded here:
 * - PRESENTATION ONLY: the approval engine + delivery ledger stay the source of truth. This module
 *   has NO database access at all — a failed card update can not roll anything back by
 *   construction (lock §B-4: "do not roll back the approval"). Duplicate clicks converge through
 *   the wrapper's stale summary on the next callback.
 * - VALUES-FREE COPY (§2/§5, same fence as the B-2 card body): the terminal `statusText` is built
 *   exclusively from status-level fields (card state, acted action/time, instance status, stable
 *   engine reason codes) plus the server-side operator display name the callback adapter resolved
 *   from LOCAL user data. Titles, request numbers, node names, form values, and payload-supplied
 *   display text never enter the copy.
 * - NO EXISTENCE ORACLE (§5.2, review P3-H): `delivery_not_found` and every `operator_unresolved`
 *   reason render the BYTE-EQUAL neutral copy, so card copy never confirms whether a delivery id
 *   exists. Do not split these strings.
 * - FAILURE ISOLATION: `applyDingTalkApprovalCardTerminalUpdate` never throws. Update failures
 *   are logged values-free (reason class + ledger delivery id only — never card payloads or API
 *   error bodies) and surface as a typed outcome the caller may ignore.
 */
import { Logger } from '../../core/logger'
import {
  fetchDingTalkAppAccessToken,
  updateDingTalkInteractiveApprovalCard,
} from './client'
import { resolveDingTalkInteractiveCardStreamConfig } from './interactive-card-stream'
import type { DingTalkApprovalCardCallbackResult } from './interactive-card-callback'
import type { ApprovalCardDeliverySummary } from '../../services/ApprovalCardDeliveryAction'

const logger = new Logger('DingTalkInteractiveCardUpdate')

/**
 * Ratified §B-4 copy for an unmapped operator — and (review P3-H) the SHARED neutral copy for an
 * unknown delivery id: both cases must stay byte-equal so the card never oracles ledger existence.
 */
export const DINGTALK_APPROVAL_CARD_NEUTRAL_UNPROCESSABLE_TEXT = '请先在网页端绑定钉钉后再处理'
/** Ratified §B-4 copy for non-recipient / permission-denied outcomes. */
export const DINGTALK_APPROVAL_CARD_NO_PERMISSION_TEXT = '当前账号无权处理该审批'
/** Server-side inconsistency (missing link secret, wrapper row vanished): generic, values-free. */
export const DINGTALK_APPROVAL_CARD_SYSTEM_UNAVAILABLE_TEXT = '暂时无法处理，请在网页端处理该审批'

export type DingTalkApprovalCardTerminalUpdate = {
  /** The ledger delivery id — identical to the card's outTrackId (B-2 anchor). */
  outTrackId: string
  /** Terminal status copy; the ONLY card param a B-4 update may change. */
  statusText: string
}

export type DingTalkApprovalCardUpdateSender = (update: DingTalkApprovalCardTerminalUpdate) => Promise<void>

export type DingTalkApprovalCardTerminalUpdateContext = {
  /**
   * Operator display name resolved by the callback adapter from LOCAL user data (users.name).
   * Never sourced from callback payload display text (lock §B-4).
   */
  operatorDisplayName?: string | null
  /** Clock override for tests; production uses the ledger acted_at first, then now. */
  now?: Date
}

export type DingTalkApprovalCardTerminalUpdateOutcome =
  | { status: 'updated'; outTrackId: string }
  | { status: 'skipped'; reason: 'no_update_for_outcome' | 'stream_config_disabled' }
  /** `reason` is the error class name only — values-free by construction. */
  | { status: 'failed'; outTrackId: string; reason: string }

// Card audience timezone: DingTalk corp deployments (Asia/Shanghai, same default as the
// attendance delivery worker). The acted time is presentation-only; the ledger keeps the instant.
const CARD_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function formatCardTime(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return CARD_TIME_FORMATTER.format(date)
}

/**
 * Stale/duplicate convergence: the current TRUE terminal state, derived ONLY from status-level
 * summary fields. Precedence: this card's own acted claim → the instance's terminal status → the
 * card's lifecycle state (expired/superseded/undelivered).
 */
function staleStatusText(summary: ApprovalCardDeliverySummary): string {
  if (summary.cardState === 'acted') {
    const time = formatCardTime(summary.actedAt)
    const suffix = time ? ` · ${time}` : ''
    if (summary.actedAction === 'approve') return `已同意${suffix}`
    if (summary.actedAction === 'reject') return `已驳回${suffix}`
    return `已处理${suffix}`
  }
  switch (summary.approval.status) {
    case 'approved':
      return '审批已通过'
    case 'rejected':
      return '审批已拒绝'
    case 'revoked':
      return '审批已撤销'
    default:
      break
  }
  if (summary.cardState === 'expired') return '卡片已过期，请在网页端处理'
  if (summary.cardState === 'superseded') return '该任务已流转，请在网页端查看'
  return '卡片已失效，请在网页端查看'
}

/**
 * The §B-4 mapping table as a pure function: callback outcome → terminal card update, or `null`
 * for the no-op rows (parse-level rejection has no card to address; unsupported actions are a
 * recorded no-op per §B-3 step 2).
 */
export function buildDingTalkApprovalCardTerminalUpdate(
  result: DingTalkApprovalCardCallbackResult,
  context: DingTalkApprovalCardTerminalUpdateContext = {},
): DingTalkApprovalCardTerminalUpdate | null {
  switch (result.outcome) {
    case 'rejected':
    case 'ignored_unsupported_action':
      return null
    case 'delivery_not_found':
      // P3-H: byte-equal with operator_unresolved below — never an existence oracle.
      return { outTrackId: result.outTrackId, statusText: DINGTALK_APPROVAL_CARD_NEUTRAL_UNPROCESSABLE_TEXT }
    case 'operator_unresolved':
      return { outTrackId: result.deliveryId, statusText: DINGTALK_APPROVAL_CARD_NEUTRAL_UNPROCESSABLE_TEXT }
    case 'link_secret_unavailable':
    case 'wrapper_not_found':
      return { outTrackId: result.deliveryId, statusText: DINGTALK_APPROVAL_CARD_SYSTEM_UNAVAILABLE_TEXT }
    case 'executed': {
      const name = typeof context.operatorDisplayName === 'string' ? context.operatorDisplayName.trim() : ''
      const time = formatCardTime(result.summary.actedAt) ?? formatCardTime(context.now ?? new Date())!
      return {
        outTrackId: result.deliveryId,
        statusText: name ? `已由 ${name} 同意 · ${time}` : `已同意 · ${time}`,
      }
    }
    case 'stale':
      return { outTrackId: result.deliveryId, statusText: staleStatusText(result.summary) }
    case 'engine_rejected': {
      const permissionDenied = result.httpStatus === 403 || result.code === 'APPROVAL_ASSIGNMENT_REQUIRED'
      return {
        outTrackId: result.deliveryId,
        statusText: permissionDenied
          ? DINGTALK_APPROVAL_CARD_NO_PERMISSION_TEXT
          // Reason-coded failure copy: the STABLE engine code only, never the engine message
          // (which may carry titles/names) and never form values (lock §B-4 row 5).
          : `无法处理该审批（${result.code}）`,
      }
    }
  }
}

/**
 * Production sender: same env-gated Stream credentials the B-2 send used (`resolve…StreamConfig`),
 * app-token via the shared cache, official update endpoint. Returns `null` when the stream gate is
 * off — with the flag off no card was ever sent by this channel, so there is nothing to update.
 */
export function createDingTalkApprovalCardStreamUpdateSender(
  env: NodeJS.ProcessEnv = process.env,
): DingTalkApprovalCardUpdateSender | null {
  const config = resolveDingTalkInteractiveCardStreamConfig(env)
  if (config.enabled === false) return null
  return async (update) => {
    const accessToken = await fetchDingTalkAppAccessToken({
      appKey: config.clientId,
      appSecret: config.clientSecret,
    })
    await updateDingTalkInteractiveApprovalCard(accessToken, update)
  }
}

/**
 * The B-4 follow-up hook: build the terminal update for an outcome and send it. NEVER throws and
 * touches no database — the committed approval action is out of reach from here (no-rollback
 * invariant). Failures log values-free (error class + delivery id) and duplicate clicks converge
 * later through the wrapper's stale summary.
 */
export async function applyDingTalkApprovalCardTerminalUpdate(
  result: DingTalkApprovalCardCallbackResult,
  context: DingTalkApprovalCardTerminalUpdateContext = {},
  sender?: DingTalkApprovalCardUpdateSender,
): Promise<DingTalkApprovalCardTerminalUpdateOutcome> {
  const update = buildDingTalkApprovalCardTerminalUpdate(result, context)
  if (!update) return { status: 'skipped', reason: 'no_update_for_outcome' }

  const send = sender ?? createDingTalkApprovalCardStreamUpdateSender()
  if (!send) return { status: 'skipped', reason: 'stream_config_disabled' }

  try {
    await send(update)
    return { status: 'updated', outTrackId: update.outTrackId }
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'UnknownError'
    // Values-free (lock §5.3): reason class + ledger id only — API error bodies and card payloads
    // never enter logs. The action itself is already committed and stays committed.
    logger.warn(`DingTalk approval-card terminal update failed (card_update_failed:${reason}) delivery=${update.outTrackId}`)
    return { status: 'failed', outTrackId: update.outTrackId, reason }
  }
}
