/**
 * Webhook delivery for `POST /api/events/subscribe` through the S0-a egress guard (2026-11-17).
 *
 * The subscribe route used to hand the event bus a closure that called the platform `fetch(webhookUrl)`:
 * no address check, no resolve-then-pin (a name re-resolved at connect time defeats any check), the
 * platform's default redirect FOLLOW (a 307/308 re-sends this POST body to a `Location` nobody judged),
 * and a free-text error log whose message, for a userinfo URL, IS the URL. The other three webhook
 * egress paths (button field, rule `send_webhook`, sheet subscriptions) already closed all of that in
 * S0-a (#5619, #5649); this module routes the fourth through the SAME functions, unchanged:
 *
 *  - `checkWebhookTargetUrlShape` — subscribe-time early error (no DNS: a subscribe must not depend on the
 *    resolver). https only, no internal name, no internal IP literal.
 *  - `checkWebhookTargetUrl` — on EVERY delivery (the bus also calls the handler for replays and for the
 *    local listener of a non-wildcard pattern). Resolves the name and refuses if ANY answer is internal;
 *    a resolver failure is refused (fail-closed). This is the boundary.
 *  - `pinnedHttpsFetch` — connects to the address that check approved (never re-resolves), keeps SNI and
 *    Host on the URL's name, and never follows a redirect. No `responseBodyLimit`: the body was never read
 *    before and is not read now; the socket is closed on the headers.
 *  - a 3xx is refused as `redirect-not-allowed`; its `Location` is never read.
 *
 * POLICY IS NOT FORKED: no allowlist, no flag, no env var — exactly S0-a's posture. A receiver on the
 * intranet is published behind a reverse proxy as a public https endpoint (S0-a design §5).
 *
 * VALUES-FREE: every log line carries closed-set labels (`refusalClass`, `failureClass`, `hostFamily`) and
 * identifiers only, and every thrown message is a closed-set token, because the bus persists the thrown
 * message (delivery log + dead letter) and folds it into its own error log. The transport error is never
 * rethrown, wrapped or attached as a `cause`.
 *
 * WHY THROW: the bus ignores the handler's return value and records a delivery as successful unless the
 * handler throws (`EventBusService.processEvent`). A refusal or a transport failure therefore throws so it
 * is recorded as a failed delivery and a dead letter; both bus call sites catch (`processEvent`,
 * `handleLocalEvent`). A non-2xx answer keeps today's `false` return — that bookkeeping is unchanged here.
 */
import { Logger } from './logger'
import { checkWebhookTargetUrl, checkWebhookTargetUrlShape, type SsrfLookupFn } from '../multitable/webhook-ssrf-guard'
import { pinnedAddressFamily, pinnedHttpsFetch, type PinnedSendFn } from '../multitable/webhook-pinned-fetch'
import {
  REDIRECT_NOT_ALLOWED,
  WEBHOOK_TARGET_REJECTED,
  classifyWebhookFailure,
  classifyWebhookRefusal,
  isRefusedRedirectStatus,
  webhookHostFamily,
  type WebhookRefusalClass,
} from '../multitable/webhook-refusal-class'

const logger = new Logger('EventWebhookDelivery')

/** Same per-attempt bound as sheet-subscription delivery (`webhook-service.ts` DELIVERY_TIMEOUT_MS). */
export const EVENT_WEBHOOK_DEFAULT_TIMEOUT_MS = 5_000

/** Closed-set prefix of a delivery the gate allowed and the transport then failed. */
export const EVENT_WEBHOOK_DELIVERY_FAILED = 'EVENT_WEBHOOK_DELIVERY_FAILED' as const

/** Seams for tests. Production passes none: the system resolver and the pinned https transport. */
export interface EventWebhookDeliveryDeps {
  ssrfLookupFn?: SsrfLookupFn
  pinnedSendFn?: PinnedSendFn
}

export type EventWebhookTargetCheck =
  | { ok: true }
  | { ok: false; error: { code: typeof WEBHOOK_TARGET_REJECTED; refusalClass: WebhookRefusalClass } }
  | { ok: false; error: { code: 'VALIDATION_ERROR'; reason: 'url-credentials-not-allowed' } }

/**
 * Subscribe-time early error. URL shape only (no DNS); the per-delivery check stays the boundary.
 * Userinfo is refused here too: `pinnedHttpsFetch` refuses it at send anyway (it would otherwise become an
 * `Authorization` header), so this is that existing rule surfaced at subscribe, not a new policy.
 */
export function checkEventWebhookTarget(url: string): EventWebhookTargetCheck {
  const shape = checkWebhookTargetUrlShape(url)
  if (!shape.ok) {
    // `strict: false` disables discriminated-union narrowing in this package; read `reason` explicitly.
    const reason = (shape as { reason?: string }).reason
    return { ok: false, error: { code: WEBHOOK_TARGET_REJECTED, refusalClass: classifyWebhookRefusal(url, reason).refusalClass } }
  }
  const parsed = new URL(url) // parseable: the shape check passed
  if (parsed.username || parsed.password) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', reason: 'url-credentials-not-allowed' } }
  }
  return { ok: true }
}

/**
 * The handler the subscribe route registers on the bus. `url` stays in this closure only — it is never
 * logged, thrown, or persisted.
 */
export function createEventWebhookHandler(
  url: string,
  subscriberId: string,
  timeoutMs: number,
  deps: EventWebhookDeliveryDeps = {},
): (event: unknown, context: unknown) => Promise<boolean> {
  return async (event: unknown, _context: unknown): Promise<boolean> => {
    const ssrf = await checkWebhookTargetUrl(url, deps.ssrfLookupFn)
    if (!ssrf.ok) {
      const refusal = classifyWebhookRefusal(url, (ssrf as { reason?: string }).reason)
      logger.warn('[events.webhook.refused]', {
        code: refusal.code,
        refusalClass: refusal.refusalClass,
        hostFamily: refusal.hostFamily,
        subscriberId,
      })
      throw new Error(`${WEBHOOK_TARGET_REJECTED}:${refusal.refusalClass}`)
    }

    const pinned = (ssrf as { addresses: string[] }).addresses[0]
    if (typeof pinned !== 'string' || pinned.length === 0) {
      // Unreachable for an `ok` check (it always carries at least one address); fail closed anyway.
      throw new Error(`${WEBHOOK_TARGET_REJECTED}:internal-other`)
    }

    const send: PinnedSendFn = deps.pinnedSendFn ?? pinnedHttpsFetch
    let result: { status: number; ok: boolean }
    try {
      result = await send(url, pinned, pinnedAddressFamily(pinned), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        timeoutMs,
      })
    } catch (error) {
      // `classifyWebhookFailure` reads name/code/cause only — never `message`, which can BE the URL.
      const failureClass = classifyWebhookFailure({ kind: 'error', error })
      logger.warn('[events.webhook.failed]', { failureClass, hostFamily: webhookHostFamily(url), subscriberId })
      throw new Error(`${EVENT_WEBHOOK_DELIVERY_FAILED}:${failureClass}`)
    }

    if (isRefusedRedirectStatus(result)) {
      // Decided on the status alone: nothing else of the 3xx response — `Location` above all — is read.
      logger.warn('[events.webhook.refused]', {
        code: WEBHOOK_TARGET_REJECTED,
        refusalClass: REDIRECT_NOT_ALLOWED,
        hostFamily: webhookHostFamily(url),
        subscriberId,
      })
      throw new Error(`${WEBHOOK_TARGET_REJECTED}:${REDIRECT_NOT_ALLOWED}`)
    }
    return result.ok
  }
}
