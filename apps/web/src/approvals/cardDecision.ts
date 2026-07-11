/**
 * A-3 (one-tap lock #3594 §5): the mobile decision page's ONLY api surface.
 *
 * Talks exclusively to the card-delivery endpoints — resolution is deliveryId + HMAC token,
 * never an instance id, and this module deliberately has NO import from `./api` so the page
 * cannot drift into calling the raw per-instance approval action route (locked by a tripwire spec).
 */
import { apiFetch } from '../utils/api'

export interface ApprovalCardSummary {
  deliveryId: string
  cardState: 'sent' | 'acted' | 'superseded' | 'expired' | 'revoked'
  /** 'outcome_unknown' (PR #4046 Phase B): send attempted, response lost — the card MAY be delivered; the server keeps it actionable. */
  sendStatus: 'pending' | 'sent' | 'failed' | 'outcome_unknown'
  nodeKey: string
  recipientUserId: string
  viewerIsRecipient: boolean
  actionable: boolean
  approval: {
    instanceId: string
    title: string | null
    requestNo: string | null
    status: string
    currentNodeKey: string | null
    rejectCommentRequired: boolean
  }
  actedAction: string | null
  actedAt: string | null
}

export interface ApprovalCardActionError {
  code: string
  message: string
  /** Server may attach the real card summary alongside the error (409 stale / engine 4xx). */
  summary?: ApprovalCardSummary
}

async function parseError(response: Response): Promise<ApprovalCardActionError> {
  try {
    const payload = await response.json() as { error?: { code?: string; message?: string }; data?: ApprovalCardSummary }
    return {
      code: payload.error?.code ?? `HTTP_${response.status}`,
      message: payload.error?.message ?? `请求失败（${response.status}）`,
      summary: payload.data,
    }
  } catch {
    return { code: `HTTP_${response.status}`, message: `请求失败（${response.status}）` }
  }
}

/**
 * Lock §5: an unauthenticated card deep link drives the DingTalk OAuth launch DIRECTLY (not the
 * generic /login page). Mirrors LoginView's launch contract: GET the launch endpoint with the
 * decision page as redirect, then navigate to the returned URL. Returns false (with a message)
 * when the launch is unavailable so the page can render a manual retry button.
 */
export async function launchDingTalkLoginForDecision(fullPath: string): Promise<{ ok: boolean; message?: string }> {
  try {
    const response = await apiFetch(`/api/auth/dingtalk/launch?redirect=${encodeURIComponent(fullPath)}`, {
      method: 'GET',
      suppressUnauthorizedRedirect: true,
    } as RequestInit)
    const payload = await response.json().catch(() => null) as { success?: boolean; data?: { url?: string }; error?: { message?: string } } | null
    const launchUrl = typeof payload?.data?.url === 'string' ? payload.data.url : ''
    if (!response.ok || payload?.success !== true || !launchUrl) {
      return { ok: false, message: payload?.error?.message ?? '钉钉登录暂不可用，请稍后重试。' }
    }
    window.location.href = launchUrl
    return { ok: true }
  } catch {
    return { ok: false, message: '钉钉登录暂不可用，请稍后重试。' }
  }
}

export async function fetchApprovalCardSummary(deliveryId: string, token: string): Promise<ApprovalCardSummary> {
  const response = await apiFetch(`/api/approval-card-deliveries/${encodeURIComponent(deliveryId)}?t=${encodeURIComponent(token)}`)
  if (!response.ok) throw Object.assign(new Error('card summary failed'), { cardError: await parseError(response) })
  const payload = await response.json() as { data: ApprovalCardSummary }
  return payload.data
}

export async function submitApprovalCardDecision(
  deliveryId: string,
  token: string,
  decision: 'approve' | 'reject',
  comment?: string,
): Promise<ApprovalCardSummary> {
  const response = await apiFetch(`/api/approval-card-deliveries/${encodeURIComponent(deliveryId)}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: token, decision, ...(comment ? { comment } : {}) }),
  })
  if (!response.ok) throw Object.assign(new Error('card decision failed'), { cardError: await parseError(response) })
  const payload = await response.json() as { data: ApprovalCardSummary }
  return payload.data
}
