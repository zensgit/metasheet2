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
 * message (the `event_deliveries` error column, and the best-effort dead-letter insert) and folds it into
 * its own error log. The transport error is never rethrown, wrapped or attached as a `cause`.
 *
 * WHY THROW: the bus ignores the handler's return value and records a delivery as successful unless the
 * handler throws (`EventBusService.processEvent`). A refusal or a transport failure therefore throws, and
 * on the `processEvent` path it is recorded as a failed delivery: an `event_deliveries` row with
 * `success = false` and the subscription's failure counter. The local-listener call site
 * (`handleLocalEvent`, non-wildcard patterns) catches and only logs; it books nothing. The dead-letter
 * insert (`addToDeadLetter`) is best-effort: it swallows its own error and targets the legacy
 * `event_dead_letters` table, which only the legacy SQL migrations create, so on a database built by the
 * default migration set no dead letter is written. A non-2xx answer keeps today's `false` return — that
 * bookkeeping is unchanged here.
 *
 * ONE DEADLINE FOR THE WHOLE DELIVERY (review P2, 2026-11-21). The bus bounds a handler with
 * `executeWithTimeout` (`EventBusService`), a `Promise.race` that records the delivery as failed when it
 * fires but never cancels the handler. If the name resolution were outside the transport's own timer, a
 * resolver slower than the budget would let the bus book `success = false` and the handler then go on to
 * send — a delivery recorded as failed that was in fact made. So the handler owns ONE deadline,
 * `timeoutMs` from its own start, shared by the resolution and the https exchange:
 *
 *  - the deadline timer is armed synchronously, before the handler's first `await`. The bus calls the
 *    handler BEFORE it arms its own race timer, with the same `timeout_ms` (or a longer default when the
 *    subscription gave none), so this deadline is never later than the bus's;
 *  - at the deadline the handler rejects with `EVENT_WEBHOOK_DELIVERY_FAILED:timeout` and the attempt is
 *    closed: a resolution that arrives later is dropped and ZERO requests are sent;
 *  - the transport gets only the time that is left (`deadline - now`), so a request that did start ends by
 *    the same deadline; with no time left nothing is sent.
 *
 * A request that started before the deadline and is still unanswered at it may have reached the receiver;
 * that is the ordinary meaning of a timeout and is unchanged. What can no longer happen is a request that
 * STARTS after the attempt was given up.
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
  /** Clock for the remaining-budget arithmetic. Production: `Date.now`. */
  now?: () => number
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


/** One delivery attempt. `closed` flips exactly once: at the deadline, or when the attempt settles. */
interface DeliveryAttempt {
  closed: boolean
}

/** Returned by the attempt when the budget is gone before the request could start (nothing was sent). */
const DEADLINE_SPENT = Symbol('event-webhook-deadline-spent')

/**
 * The handler the subscribe route registers on the bus. `url` stays in this closure only — it is never
 * logged, thrown, or persisted. One deadline covers the resolution and the https exchange (header note
 * "ONE DEADLINE FOR THE WHOLE DELIVERY").
 */
export function createEventWebhookHandler(
  url: string,
  subscriberId: string,
  timeoutMs: number,
  deps: EventWebhookDeliveryDeps = {},
): (event: unknown, context: unknown) => Promise<boolean> {
  return (event: unknown, _context: unknown): Promise<boolean> => {
    const now = deps.now ?? Date.now
    const deadlineAt = now() + timeoutMs
    const attempt: DeliveryAttempt = { closed: false }

    return new Promise<boolean>((resolve, reject) => {
      const giveUp = () => {
        logger.warn('[events.webhook.failed]', { failureClass: 'timeout', hostFamily: webhookHostFamily(url), subscriberId })
        reject(new Error(`${EVENT_WEBHOOK_DELIVERY_FAILED}:timeout`))
      }
      // Armed synchronously, before the first `await`: never later than the bus's own race timer.
      const deadline = setTimeout(() => {
        if (attempt.closed) return
        attempt.closed = true
        giveUp()
      }, timeoutMs)

      deliverOnce(url, subscriberId, event, deadlineAt, now, attempt, deps).then(
        (outcome) => {
          if (attempt.closed) return
          attempt.closed = true
          clearTimeout(deadline)
          if (outcome === DEADLINE_SPENT) giveUp()
          else resolve(outcome)
        },
        (error: unknown) => {
          if (attempt.closed) return
          attempt.closed = true
          clearTimeout(deadline)
          reject(error)
        },
      )
    })
  }
}

async function deliverOnce(
  url: string,
  subscriberId: string,
  event: unknown,
  deadlineAt: number,
  now: () => number,
  attempt: DeliveryAttempt,
  deps: EventWebhookDeliveryDeps,
): Promise<boolean | typeof DEADLINE_SPENT> {
  const ssrf = await checkWebhookTargetUrl(url, deps.ssrfLookupFn)
  // The attempt was given up while the name was resolving: drop the answer, send nothing, log nothing
  // (the deadline already logged and rejected once).
  if (attempt.closed) return false

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

  // Only what is left of the ONE budget goes to the transport. Nothing left: nothing is sent.
  const remainingMs = deadlineAt - now()
  if (!(remainingMs > 0)) return DEADLINE_SPENT

  const send: PinnedSendFn = deps.pinnedSendFn ?? pinnedHttpsFetch
  let result: { status: number; ok: boolean }
  try {
    // No `await` between the closed / remaining checks above and this call: the request starts in
    // the same turn the checks passed in.
    result = await send(url, pinned, pinnedAddressFamily(pinned), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      timeoutMs: remainingMs,
    })
  } catch (error) {
    if (attempt.closed) return false
    // `classifyWebhookFailure` reads name/code/cause only — never `message`, which can BE the URL.
    const failureClass = classifyWebhookFailure({ kind: 'error', error })
    logger.warn('[events.webhook.failed]', { failureClass, hostFamily: webhookHostFamily(url), subscriberId })
    throw new Error(`${EVENT_WEBHOOK_DELIVERY_FAILED}:${failureClass}`)
  }
  if (attempt.closed) return false

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
