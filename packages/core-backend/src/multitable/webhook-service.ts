/**
 * Webhook Service
 * PostgreSQL-backed webhook management and delivery for multitable open API.
 * V2: persistent store via Kysely — state survives restarts.
 *
 * EGRESS POSTURE (F-3 of the #5619 security review). `multitable_webhooks.url` is a SUBSCRIBER-supplied
 * target: any authenticated user can POST /api/multitable/webhooks and have this process send them every
 * matching record/comment event, signed with the subscription's own secret. That made this the second
 * un-gated egress out of the same EventBus as the rule-driven `send_webhook` action, and the one with the
 * wider write surface (a rule needs sheet-edit rights; a webhook row needs only a session). The single
 * dispatch site in `executeDelivery` is therefore gated by the SAME `checkWebhookTargetUrl` the button
 * route and the automation path use, and refuses to follow redirects. There is exactly ONE outbound call
 * in this file; both entry points (`deliverEvent` fan-out and the `retryFailedDeliveries` tick) funnel
 * through it, so one gate covers both.
 */

import { createHmac, randomBytes } from 'crypto'
import { sql, type Kysely } from 'kysely'
import { Logger } from '../core/logger'
import type { Database } from '../db/types'
import { nowTimestamp, toJsonValue } from '../db/type-helpers'
import type {
  Webhook,
  WebhookCreateInput,
  WebhookDelivery,
  WebhookEventType,
  WebhookUpdateInput,
} from './webhooks'
import {
  ALL_WEBHOOK_EVENT_TYPES,
  WEBHOOK_DEFAULT_BASE_RETRY_DELAY_MS,
  WEBHOOK_DEFAULT_MAX_RETRIES,
} from './webhooks'
import { checkWebhookTargetUrl, checkWebhookTargetUrlShape, type SsrfLookupFn } from './webhook-ssrf-guard'
import { pinnedAddressFamily, pinnedHttpsFetch, type PinnedSendFn } from './webhook-pinned-fetch'
import {
  classifyWebhookFailure,
  classifyWebhookRefusal,
  isRefusedRedirectStatus,
  REDIRECT_NOT_ALLOWED,
  WEBHOOK_TARGET_REJECTED,
  webhookHostFamily,
} from './webhook-refusal-class'
import { WEBHOOK_CHECK_FAILED, authorizeWebhookDelivery } from './webhook-delivery-authority'

const logger = new Logger('WebhookService')

const DELIVERY_TIMEOUT_MS = 5_000
/** S0-a: the receiver's answer is recorded into `response_body` up to this many bytes (was unbounded). */
const DELIVERY_RESPONSE_BODY_LIMIT = 64 * 1024
/** What `executeDelivery` reads from one attempt, whichever transport made it. */
type DeliveryAttemptResponse = { status: number; ok: boolean; type?: string; text: () => Promise<string> }
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10
const BASE_RETRY_DELAY_MS = WEBHOOK_DEFAULT_BASE_RETRY_DELAY_MS
// Lease window a retry tick holds a claimed delivery for (review MINOR-1):
// long enough to out-live the HTTP attempt + backoff recompute so a concurrent
// replica's tick skips it; short enough that a crashed tick's row is retried soon.
const RETRY_CLAIM_LEASE_MS = DELIVERY_TIMEOUT_MS * 4
/** How long a pending row may sit with next_retry_at NULL (a first attempt whose outcome never landed)
 *  before the retry tick claims it as a crashed-process stray. Must exceed DELIVERY_TIMEOUT_MS by a wide
 *  margin so a live in-flight first attempt is never double-fired. */
const FIRST_ATTEMPT_STRAY_GRACE_MS = Math.max(5 * 60_000, DELIVERY_TIMEOUT_MS * 10)

/**
 * Values-free marker persisted into `response_body` when there is no RECEIVER body to record: a
 * pre-dispatch refusal, or a transport failure where nothing came back. The suffix is always a
 * closed-set token from `webhook-refusal-class.ts`, never free text and never the URL, so the
 * operator-facing delivery row carries a reason without carrying a value. (An HTTP failure response
 * still stores the receiver's real body, exactly as before.)
 */
const DELIVERY_FAILURE_MARKER = 'WEBHOOK_DELIVERY_FAILED'

/**
 * Ops switch for outbound subscription webhooks. Explicit-on: only a value in
 * OUTBOUND_OPS_SWITCH_ON_VALUES (after trim + lowercase) turns it on; a missing,
 * empty or unrecognised value leaves it off. Read once when this module is first
 * loaded, so changing it requires restarting every process. It covers the
 * subscription webhooks handled by WebhookService only. While on: no delivery rows
 * are written, no requests are sent, and existing rows keep their state; events
 * seen while on are not replayed.
 */
export const OUTBOUND_OPS_SWITCH_ENV = 'MULTITABLE_OUTBOUND_WEBHOOKS_DISABLED'
const OUTBOUND_OPS_SWITCH_ON_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on'])

function parseOutboundOpsSwitch(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false
  return OUTBOUND_OPS_SWITCH_ON_VALUES.has(raw.trim().toLowerCase())
}

const outboundOpsSwitchOn: boolean = parseOutboundOpsSwitch(process.env[OUTBOUND_OPS_SWITCH_ENV])

// Startup signal: reports the parsed value that the checks below read, once per process.
logger.info(
  outboundOpsSwitchOn
    ? 'outbound webhook ops switch: on (subscription webhook sends paused)'
    : 'outbound webhook ops switch: off (normal delivery)',
)

function generateId(): string {
  return randomBytes(16).toString('hex')
}

/** Map a DB row to the domain Webhook. */
function rowToWebhook(row: {
  id: string
  name: string
  url: string
  secret: string | null
  events: string | string[]
  active: boolean
  created_by: string
  created_at: string | Date
  updated_at?: string | Date | null
  last_delivered_at?: string | Date | null
  failure_count: number
  max_retries: number
  retry_base_delay_ms?: number | null
  retry_max_delay_ms?: number | null
  sheet_id?: string | null
}): Webhook {
  const events =
    typeof row.events === 'string'
      ? (JSON.parse(row.events) as WebhookEventType[])
      : (row.events as WebhookEventType[])
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    secret: row.secret ?? undefined,
    events,
    active: row.active,
    createdBy: row.created_by,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
    updatedAt: row.updated_at
      ? row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updated_at
      : undefined,
    lastDeliveredAt: row.last_delivered_at
      ? row.last_delivered_at instanceof Date
        ? row.last_delivered_at.toISOString()
        : row.last_delivered_at
      : undefined,
    failureCount: row.failure_count,
    maxRetries: row.max_retries,
    retryBaseDelayMs: row.retry_base_delay_ms ?? undefined,
    retryMaxDelayMs: row.retry_max_delay_ms ?? undefined,
    sheetId: typeof row.sheet_id === 'string' && row.sheet_id.length > 0 ? row.sheet_id : null,
  }
}

/**
 * How a PATCH relates to the stored webhook. A change of `active` false → true, a different `url`, a
 * different event set, or binding a not-yet-bound webhook needs the caller to pass the create-time sheet
 * access check again (on `recheckSheetId`); a field that is sent again with its stored value does not.
 * Turning the webhook off never needs it. The bound sheet cannot be changed.
 */
export type WebhookUpdatePlan =
  | { kind: 'refuse'; reason: 'sheet_immutable' | 'sheet_binding_required' }
  | { kind: 'apply'; recheckSheetId: string | null; bindSheetId: string | null }

export function planWebhookUpdate(
  existing: Pick<Webhook, 'url' | 'events' | 'active' | 'sheetId'>,
  input: Pick<WebhookUpdateInput, 'url' | 'events' | 'active' | 'sheetId'>,
): WebhookUpdatePlan {
  const requestedSheetId = typeof input.sheetId === 'string' ? input.sheetId.trim() : ''
  let bindSheetId: string | null = null
  if (requestedSheetId) {
    if (existing.sheetId === null) bindSheetId = requestedSheetId
    else if (existing.sheetId !== requestedSheetId) return { kind: 'refuse', reason: 'sheet_immutable' }
  }
  const activating = input.active === true && existing.active !== true
  const urlChanged = input.url !== undefined && input.url.trim() !== existing.url
  const eventsChanged =
    input.events !== undefined
    && (new Set(input.events).size !== new Set(existing.events).size
      || input.events.some((evt) => !existing.events.includes(evt)))
  const needsRecheck = activating || urlChanged || eventsChanged || bindSheetId !== null
  if (!needsRecheck) return { kind: 'apply', recheckSheetId: null, bindSheetId: null }
  const targetSheetId = bindSheetId ?? existing.sheetId
  if (!targetSheetId) return { kind: 'refuse', reason: 'sheet_binding_required' }
  return { kind: 'apply', recheckSheetId: targetSheetId, bindSheetId }
}

/** Map a DB row to the domain WebhookDelivery. */
function rowToDelivery(row: {
  id: string
  webhook_id: string
  event: string
  payload: unknown
  status: string
  http_status: number | null
  response_body: string | null
  attempt_count: number
  created_at: string | Date
  delivered_at?: string | Date | null
  next_retry_at?: string | Date | null
}): WebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    event: row.event as WebhookEventType,
    payload: row.payload,
    status: row.status as WebhookDelivery['status'],
    httpStatus: row.http_status ?? undefined,
    responseBody: row.response_body ?? undefined,
    attemptCount: row.attempt_count,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
    deliveredAt: row.delivered_at
      ? row.delivered_at instanceof Date
        ? row.delivered_at.toISOString()
        : row.delivered_at
      : undefined,
    nextRetryAt: row.next_retry_at
      ? row.next_retry_at instanceof Date
        ? row.next_retry_at.toISOString()
        : row.next_retry_at
      : undefined,
  }
}

export class WebhookService {
  private db: Kysely<Database>
  /**
   * Fetch-shaped TEST seam (the constructor's 2nd argument). Production constructions pass none, and then
   * delivery goes through the pinned transport below. When injected (and no pinned seam is), it is called
   * with `redirect: 'manual'`, but a fetch-shaped call cannot be pinned to the checked address.
   */
  private fetchFn?: typeof fetch
  /**
   * S0-a transport seam. OMITTED (production) ⇒ `pinnedHttpsFetch`: the request goes to the address the SSRF
   * check approved for THIS attempt (never a fresh resolution of the name), certificate checks unchanged, and
   * a 3xx comes back as a status with no second request. A test passes a wrapper to observe the chosen pin.
   */
  private pinnedSendFn?: PinnedSendFn
  /**
   * DNS seam for the SSRF gate, same shape as `AutomationDeps.ssrfLookupFn`. OMITTED (every production
   * construction: `routes/api-tokens.ts:26`, `webhook-event-bridge.ts:79`, `WebhookRetryScheduler.ts:81`,
   * `index.ts:3890`) means the REAL resolver, so production is gated by actual DNS. This is a RESOLVER
   * seam only and cannot disable the gate: `checkWebhookTargetUrl` still judges every address it returns,
   * so a seam that answers with an internal address is refused like any other.
   */
  private ssrfLookupFn?: SsrfLookupFn

  constructor(db: Kysely<Database>, fetchFn?: typeof fetch, ssrfLookupFn?: SsrfLookupFn, pinnedSendFn?: PinnedSendFn) {
    this.db = db
    this.fetchFn = fetchFn
    this.ssrfLookupFn = ssrfLookupFn
    this.pinnedSendFn = pinnedSendFn
  }

  /**
   * S0-a — EARLY error for a subscription target, at create AND update, in every environment (create used
   * to require https only when NODE_ENV=production; update checked URL syntax only). Decided from the URL
   * alone, no DNS: https, not an internal name, not an internal IP literal. NOT the boundary — every delivery
   * attempt is checked again and pinned in `executeDelivery`; a public name that resolves internally is
   * refused there. Messages are values-free (no URL); the route maps them to 400.
   */
  private static assertTargetShape(url: string): void {
    const shape = checkWebhookTargetUrlShape(url)
    if (shape.ok) return
    const reason = (shape as { reason?: string }).reason ?? ''
    if (reason === 'URL is malformed' || reason === 'URL is required') throw new Error('Webhook URL is not a valid URL')
    if (reason.startsWith('scheme not allowed')) throw new Error('Webhook URL must use HTTPS')
    throw new Error(`${WEBHOOK_TARGET_REJECTED}:${classifyWebhookRefusal(url, reason).refusalClass}`)
  }

  // ─── CRUD ────────────────────────────────────────────────────────────

  async createWebhook(
    userId: string,
    input: WebhookCreateInput,
  ): Promise<Webhook> {
    if (!input.name || input.name.trim().length === 0) {
      throw new Error('Webhook name is required')
    }
    if (!input.url || input.url.trim().length === 0) {
      throw new Error('Webhook URL is required')
    }
    const sheetId = typeof input.sheetId === 'string' ? input.sheetId.trim() : ''
    if (!sheetId) {
      throw new Error('Webhook sheetId is required')
    }
    WebhookService.assertTargetShape(input.url.trim())
    if (!input.events || input.events.length === 0) {
      throw new Error('At least one event type is required')
    }
    for (const evt of input.events) {
      if (!ALL_WEBHOOK_EVENT_TYPES.includes(evt)) {
        throw new Error(`Unknown event type: ${evt}`)
      }
    }

    const id = generateId()
    const now = new Date().toISOString()

    const maxRetries = input.maxRetries ?? WEBHOOK_DEFAULT_MAX_RETRIES
    const retryBaseDelayMs = input.retryBaseDelayMs ?? null
    const retryMaxDelayMs = input.retryMaxDelayMs ?? null

    await this.db
      .insertInto('multitable_webhooks')
      .values({
        id,
        name: input.name.trim(),
        url: input.url.trim(),
        secret: input.secret ?? null,
        events: toJsonValue([...input.events]),
        active: true,
        created_by: userId,
        created_at: now,
        failure_count: 0,
        max_retries: maxRetries,
        retry_base_delay_ms: retryBaseDelayMs,
        retry_max_delay_ms: retryMaxDelayMs,
        sheet_id: sheetId,
      })
      .execute()

    const webhook: Webhook = {
      id,
      name: input.name.trim(),
      url: input.url.trim(),
      secret: input.secret,
      events: [...input.events],
      active: true,
      createdBy: userId,
      createdAt: now,
      failureCount: 0,
      maxRetries,
      retryBaseDelayMs: retryBaseDelayMs ?? undefined,
      retryMaxDelayMs: retryMaxDelayMs ?? undefined,
      sheetId,
    }

    logger.info(`Webhook created: ${id} by user ${userId}`)
    return webhook
  }

  async listWebhooks(userId: string): Promise<Webhook[]> {
    const rows = await this.db
      .selectFrom('multitable_webhooks')
      .selectAll()
      .where('created_by', '=', userId)
      .execute()

    return rows.map((r) => rowToWebhook(r as Parameters<typeof rowToWebhook>[0]))
  }

  async updateWebhook(
    webhookId: string,
    userId: string,
    input: WebhookUpdateInput,
  ): Promise<Webhook> {
    const row = await this.db
      .selectFrom('multitable_webhooks')
      .selectAll()
      .where('id', '=', webhookId)
      .executeTakeFirst()

    if (!row) throw new Error('Webhook not found')
    if (row.created_by !== userId) throw new Error('Not authorized')

    const updates: Record<string, unknown> = {
      updated_at: nowTimestamp(),
    }

    // Binding: a not-yet-bound webhook takes the given sheet; the same sheet again is a no-op; a different
    // sheet is refused (the binding is fixed once set).
    const requestedSheetId = typeof input.sheetId === 'string' ? input.sheetId.trim() : ''
    if (requestedSheetId) {
      const storedSheetId = typeof row.sheet_id === 'string' && row.sheet_id.length > 0 ? row.sheet_id : null
      if (storedSheetId === null) updates.sheet_id = requestedSheetId
      else if (storedSheetId !== requestedSheetId) throw new Error('Webhook sheetId cannot be changed')
    }

    if (input.name !== undefined) updates.name = input.name.trim()
    if (input.url !== undefined) {
      WebhookService.assertTargetShape(input.url.trim())
      updates.url = input.url.trim()
    }
    if (input.secret !== undefined) updates.secret = input.secret
    if (input.events !== undefined)
      updates.events = toJsonValue([...input.events])
    if (input.active !== undefined) updates.active = input.active
    if (input.maxRetries !== undefined) updates.max_retries = input.maxRetries
    if (input.retryBaseDelayMs !== undefined)
      updates.retry_base_delay_ms = input.retryBaseDelayMs
    if (input.retryMaxDelayMs !== undefined)
      updates.retry_max_delay_ms = input.retryMaxDelayMs

    await this.db
      .updateTable('multitable_webhooks')
      .set(updates as never)
      .where('id', '=', webhookId)
      .execute()

    // Re-read the updated row
    const updated = await this.db
      .selectFrom('multitable_webhooks')
      .selectAll()
      .where('id', '=', webhookId)
      .executeTakeFirstOrThrow()

    return rowToWebhook(updated as Parameters<typeof rowToWebhook>[0])
  }

  async deleteWebhook(webhookId: string, userId: string): Promise<void> {
    const row = await this.db
      .selectFrom('multitable_webhooks')
      .selectAll()
      .where('id', '=', webhookId)
      .executeTakeFirst()

    if (!row) throw new Error('Webhook not found')
    if (row.created_by !== userId) throw new Error('Not authorized')

    await this.db
      .deleteFrom('multitable_webhooks')
      .where('id', '=', webhookId)
      .execute()

    logger.info(`Webhook deleted: ${webhookId} by user ${userId}`)
  }

  async getWebhookById(webhookId: string): Promise<Webhook | undefined> {
    const row = await this.db
      .selectFrom('multitable_webhooks')
      .selectAll()
      .where('id', '=', webhookId)
      .executeTakeFirst()

    if (!row) return undefined
    return rowToWebhook(row as Parameters<typeof rowToWebhook>[0])
  }

  // ─── Delivery ────────────────────────────────────────────────────────

  /**
   * Queue deliveries for the active webhooks bound to the event's sheet and subscribed to the event type,
   * each only when its owner can currently read what it would receive (see webhook-delivery-authority).
   */
  async deliverEvent(
    event: WebhookEventType,
    payload: unknown,
    // P2 durable-delivery closure item 3: the DURABLE consumer passes the outbox `eventId` so the per-webhook
    // delivery row becomes an idempotent CLAIM keyed by (webhook_id, event_id). An at-least-once redelivery
    // (crash between send and the consumer-row done-CAS, or a `busy` retry) then re-enters here with the SAME
    // eventId → the claim finds the row already present → NO second row, NO second send. LEGACY callers (the
    // bus bridge, the retry tick) pass nothing → NULL event_id → byte-identical fan-out (no dedup, unchanged).
    eventId?: string,
  ): Promise<WebhookDelivery[]> {
    // Ops switch on: no webhook lookup, no delivery row, no send.
    if (outboundOpsSwitchOn) return []
    // Only webhooks bound to the event's sheet are candidates; an event without a string sheetId has none.
    const eventSheetId =
      payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as { sheetId?: unknown }).sheetId
        : undefined
    if (typeof eventSheetId !== 'string' || eventSheetId.length === 0) return []
    const rows = await this.db
      .selectFrom('multitable_webhooks')
      .selectAll()
      .where('active', '=', true)
      .where('sheet_id', '=', eventSheetId)
      .execute()

    const matching = rows
      .map((r) => rowToWebhook(r as Parameters<typeof rowToWebhook>[0]))
      .filter((wh) => wh.events.includes(event))

    const durable = typeof eventId === 'string' && eventId.length > 0
    let failedChecks = 0
    const deliveries: WebhookDelivery[] = []
    for (const wh of matching) {
      // Decide per webhook; a failed check for one webhook does not stop the others.
      const decision = await authorizeWebhookDelivery(this.db, wh, event, payload)
      if (decision.deliver === false) {
        if (decision.reason === WEBHOOK_CHECK_FAILED) failedChecks += 1
        continue
      }
      const delivery = await this.createDeliveryRecord(wh.id, event, decision.payload, eventId)
      // A null claim (durable path only) = this (webhook, event) was already delivered/claimed by a prior
      // attempt → skip the HTTP send entirely (the redelivery is terminally handled; the caller/adapter maps
      // an error-free return to success). Never reachable on the legacy path (eventId undefined → always a row).
      if (!delivery) continue
      deliveries.push(delivery)
      // Fire-and-forget — do not await per delivery to avoid blocking the caller
      this.executeDelivery(delivery).catch((err) => {
        logger.error(
          `Delivery ${delivery.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    }

    // Durable path: after every webhook was handled, surface failed checks so the consumer redelivers;
    // webhooks already claimed for this event id are not sent again (the claim dedups them).
    if (durable && failedChecks > 0) {
      throw new Error(`webhook delivery check failed for ${failedChecks} webhook(s)`)
    }
    return deliveries
  }

  /**
   * Execute a single webhook delivery attempt.
   */
  async executeDelivery(delivery: WebhookDelivery): Promise<void> {
    // Ops switch on: send nothing and leave the row as it is (the retry tick handles it once off).
    if (outboundOpsSwitchOn) return
    const wh = await this.getWebhookById(delivery.webhookId)
    if (!wh) {
      await this.db
        .updateTable('multitable_webhook_deliveries')
        .set({ status: 'failed' })
        .where('id', '=', delivery.id)
        .execute()
      delivery.status = 'failed'
      return
    }

    // Re-check before every attempt (first send and every retry) and re-mask the stored body.
    const decision = await authorizeWebhookDelivery(this.db, wh, delivery.event, delivery.payload)
    if (decision.deliver === false) {
      if (decision.reason === WEBHOOK_CHECK_FAILED) {
        await this.handleDeliveryCheckFailure(delivery, wh)
        return
      }
      // A refusal is not an endpoint failure: no send, no failure_count change, no auto-disable.
      await this.db
        .updateTable('multitable_webhook_deliveries')
        .set({ status: 'failed' })
        .where('id', '=', delivery.id)
        .execute()
      delivery.status = 'failed'
      return
    }

    // (Merge note: the SSRF gate runs AFTER the access re-check above — an access refusal is not an
    // endpoint failure — and BEFORE the re-masked body is serialized and signed.)
    //
    // SSRF GATE (F-3 of the #5619 security review) - the ONE decision that makes this file safe.
    //
    // `wh.url` is written by whoever created the subscription (POST /api/multitable/webhooks ->
    // `createWebhook`, routes/api-tokens.ts:320), and PATCH (`updateWebhook`, :286-293) accepts any
    // parseable URL with no scheme check at all. So a plain session holder could aim this process at
    // 127.0.0.1 / 10.x / 169.254.169.254 and have every matching record event POSTed there, signed with
    // their own secret - request forgery with a delivery guarantee and a retry tick behind it.
    //
    // PLACEMENT is load-bearing, three ways (same argument as the rule-driven path,
    // automation-executor.ts:4128):
    //  1. BEFORE the header/HMAC assembly below - a refused target never has a signature computed over
    //     the payload, so the subscription's secret is not exercised on a target we refuse to speak to.
    //  2. INSIDE `executeDelivery`, which is the single funnel for BOTH entry points (the `deliverEvent`
    //     fan-out and the `retryFailedDeliveries` tick): one call gates both, and a queued row that was
    //     created before the gate existed is re-judged on every attempt.
    //  3. BEFORE the only `fetchFn` call in this file - refusal means the request is never made, which
    //     is the whole property. Nothing is scrubbed; nothing is dispatched.
    //
    // NOT terminal on its own: the refusal is handed to the EXISTING `handleDeliveryFailure`, so the
    // gate changes WHETHER we send, never WHEN we give up. A refused target consumes its retries and
    // then fails exactly like an unreachable one (and counts toward the auto-disable threshold), so a
    // transient resolver failure keeps today's retry behaviour instead of silently dropping an event.
    // Re-attempting costs nothing in containment terms: every attempt re-enters this gate and still
    // sends nothing. (The redirect refusal below IS terminal - see the reason there.)
    const ssrf = await checkWebhookTargetUrl(wh.url, this.ssrfLookupFn)
    if (!ssrf.ok) {
      // `strict: false` in this package disables discriminated-union narrowing (same as the button
      // route and the automation path); read `reason` off the rejection variant explicitly.
      const guardReason = (ssrf as { reason?: string }).reason
      // VALUES-FREE: the guard's `reason` is never logged - it is only mapped to a closed-set label.
      // The URL itself may carry userinfo or a query token, so nothing derived from it but the host
      // SHAPE is recorded; the ids below are identifiers, and `event` is a fixed enum.
      const refusal = classifyWebhookRefusal(wh.url, guardReason)
      logger.warn('[webhook.delivery.refused]', {
        code: refusal.code,
        refusalClass: refusal.refusalClass,
        hostFamily: refusal.hostFamily,
        webhookId: wh.id,
        deliveryId: delivery.id,
        event: delivery.event,
      })
      // An attempt IS consumed even though nothing was dispatched: `handleDeliveryFailure` terminates on
      // `attemptCount >= maxRetries`, so not counting it would re-check a permanently refused target
      // forever. No HTTP happened, so a previous attempt's status must not be re-persisted as this
      // attempt's outcome.
      delivery.attemptCount += 1
      delivery.httpStatus = undefined
      delivery.responseBody = `${WEBHOOK_TARGET_REJECTED}:${refusal.refusalClass}`
      // BOOKKEEPING FAILURE IS THIS ROW'S PROBLEM ONLY. `handleDeliveryFailure` issues two UPDATEs, and
      // this branch runs BEFORE the `try` below, so an exception here would leave `executeDelivery` -
      // which the retry tick awaits per row without its own guard - and abort the whole pass in
      // `retryFailedDeliveries`. Every other row that pass already CLAIMED has had `next_retry_at`
      // leased forward, so they would sit undelivered until the lease expires, and the scheduler's
      // catch would log the raw `err.message` (`services/WebhookRetryScheduler.ts:157`). Contained
      // here instead, so THIS branch's failed bookkeeping cannot stall its batch. Scoped, not general:
      // `getWebhookById` (:397) and the not-found UPDATE (:399-404) are still un-guarded DB calls ahead
      // of the `try` in the same loop; a per-row guard at :731 is the real answer and is existing code.
      //
      // Swallowing is safe in containment terms, and ONLY in containment terms: the gate already
      // refused, so nothing was dispatched and nothing is dispatched by the recovery either. The cost
      // is bookkeeping - the delivery row keeps the state it had (a claimed row keeps its lease and is
      // re-judged by this same gate after it expires; `failure_count` does not advance this attempt).
      //
      // NO BINDING on the catch, deliberately: the DB driver's message can carry the statement and its
      // parameters, so the error object is not reachable from this scope at all and the line below is
      // closed-set labels plus identifiers, the same discipline as the refusal log above.
      try {
        await this.handleDeliveryFailure(delivery, wh)
      } catch {
        logger.warn('[webhook.delivery.refusal_unrecorded]', {
          code: WEBHOOK_TARGET_REJECTED,
          refusalClass: refusal.refusalClass,
          hostFamily: refusal.hostFamily,
          webhookId: wh.id,
          deliveryId: delivery.id,
          event: delivery.event,
        })
      }
      return
    }

    // S0-a: the addresses THIS attempt's check approved; the dispatch below connects to one of them.
    const approvedAddresses = (ssrf as { addresses: string[] }).addresses

    const bodyStr = JSON.stringify(decision.payload)
    const timestamp = new Date().toISOString()

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Webhook-Id': wh.id,
      'X-Webhook-Event': delivery.event,
      'X-Webhook-Timestamp': timestamp,
      // Stable per delivery row: the same value on the first attempt and on every retry.
      'X-Webhook-Delivery': delivery.id,
    }

    if (wh.secret) {
      headers['X-Webhook-Signature'] = WebhookService.signPayload(
        bodyStr,
        wh.secret,
      )
    }

    delivery.attemptCount += 1

    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)

      // F-3 / S0-a: connect to the address the gate approved for this attempt (pinned) and do NOT follow:
      // the gate judged exactly ONE url, and following would replay this method, this body and the
      // signature headers at a `Location` chosen by whoever answers the first hop. The pinned transport
      // (`https.request`) does not follow; the fetch-shaped test seam gets `redirect: 'manual'`. Either way
      // a 3xx resolves as itself with no second request — same posture as the button route and the
      // rule-driven path.
      const response = await this.dispatchAttempt(wh.url, approvedAddresses, headers, bodyStr, controller.signal)

      clearTimeout(timer)

      if (isRefusedRedirectStatus(response)) {
        // Checked BEFORE the body is read, so nothing from the redirect response - `Location` above all
        // - is read, logged or persisted. TERMINAL, unlike the target refusal above: a retry would
        // re-send the same body to the same first hop, which answers 3xx again; that is real repeated
        // egress with no chance of success, so it is reported as the refusal it is.
        await this.handleRefusedRedirect(delivery, wh, response.status)
        return
      }

      delivery.httpStatus = response.status
      try {
        delivery.responseBody = await response.text()
      } catch {
        // ignore body read errors
      }

      if (response.ok) {
        delivery.status = 'success'
        delivery.deliveredAt = new Date().toISOString()

        await this.db
          .updateTable('multitable_webhook_deliveries')
          .set({
            status: 'success',
            http_status: response.status,
            response_body: delivery.responseBody ?? null,
            attempt_count: delivery.attemptCount,
            delivered_at: nowTimestamp(),
          })
          .where('id', '=', delivery.id)
          .execute()

        await this.db
          .updateTable('multitable_webhooks')
          .set({ last_delivered_at: nowTimestamp(), failure_count: 0 })
          .where('id', '=', wh.id)
          .execute()
      } else {
        await this.handleDeliveryFailure(delivery, wh)
      }
    } catch (err) {
      // VALUES-FREE, CLOSED FAILURE CLASS. This line used to be
      // `Webhook delivery error for ${wh.id}: ${err.message}` - free text straight from the transport,
      // and on this runtime the transport's own text CAN BE the credential: a subscription whose url
      // carries userinfo makes the native client throw, at request CONSTRUCTION,
      //   `TypeError: Request cannot be constructed from a URL that includes credentials: https://u:<pw>@h/x`
      // i.e. the message IS the whole url, password and query token included. `createWebhook` accepts
      // such a url (it only checks that `new URL()` parses), so this was reachable from the public
      // route, and the log had no redaction on it at all - not even the shared redactor, which has no
      // generic userinfo rule anyway (`automation-log-redact.ts:30-61`). So no free text goes into this
      // line: host SHAPE + a closed-set class + identifiers, the same discipline as the refusal line.
      //
      // `classifyWebhookFailure` gets the RAW error, never its message - it reads only `name`/`code`/
      // `cause.*`, which is what makes "a value cannot reach the label" true by construction.
      //
      // SCOPE, stated exactly: the level drops from `error` to `warn` because `Logger.error(msg, err)`
      // has no structured-meta parameter (core/logger.ts:112) and folds `err.message` into the record
      // itself - the very thing being removed. Nothing else about the failure path changes.
      const failureClass = classifyWebhookFailure({ kind: 'error', error: err })
      logger.warn('[webhook.delivery.failed]', {
        failureClass,
        hostFamily: webhookHostFamily(wh.url),
        webhookId: wh.id,
        deliveryId: delivery.id,
        attempts: delivery.attemptCount,
      })
      // PERSISTENCE FACE: the transport's free text is not stored either (there is no `last_error`
      // column on this table and this change does not add one). What the operator reads in the delivery
      // row is the closed-set class - strictly more than before, where a transport failure left
      // `response_body` holding a STALE body from an earlier attempt and `http_status` a stale status.
      delivery.httpStatus = undefined
      delivery.responseBody = `${DELIVERY_FAILURE_MARKER}:${failureClass}`
      await this.handleDeliveryFailure(delivery, wh)
    }
  }

  /**
   * S0-a: ONE delivery attempt to an address the SSRF check approved. Production (no seam) uses
   * `pinnedHttpsFetch` with a bounded body read; the result carries only what `executeDelivery` reads.
   */
  private async dispatchAttempt(
    url: string,
    approvedAddresses: string[],
    headers: Record<string, string>,
    body: string,
    signal: AbortSignal,
  ): Promise<DeliveryAttemptResponse> {
    if (this.fetchFn && !this.pinnedSendFn) {
      return this.fetchFn(url, { method: 'POST', headers, body, signal, redirect: 'manual' })
    }
    const pinned = approvedAddresses[0]
    if (typeof pinned !== 'string' || pinned.length === 0) {
      // Unreachable for an `ok` check (the guard always returns at least one address); fail closed anyway.
      throw new TypeError('webhook target has no approved address')
    }
    const send: PinnedSendFn = this.pinnedSendFn ?? pinnedHttpsFetch
    const result = await send(url, pinned, pinnedAddressFamily(pinned), {
      method: 'POST',
      headers,
      body,
      timeoutMs: DELIVERY_TIMEOUT_MS,
      responseBodyLimit: DELIVERY_RESPONSE_BODY_LIMIT,
    })
    return { status: result.status, ok: result.ok, text: async () => result.body ?? '' }
  }

  /**
   * The first hop answered 3xx while we asked for `redirect: 'manual'`, so nothing followed it.
   *
   * Terminal by design: `status = 'failed'`, no backoff row, `next_retry_at` cleared - so a row this
   * method actually WROTE is not re-claimed by the retry tick, which only claims `pending` rows.
   * QUALIFIED, not absolute: this call site is INSIDE the `try` at `:508`, so if the terminal UPDATE
   * below itself throws (a DB blip), that throw is caught by the generic catch, classified like any
   * other failure, and `handleDeliveryFailure` writes `status='pending'` + a backoff instead - the row
   * IS re-picked and the same body re-sent to the same first hop, bounded by `max_retries`. Containment
   * is unaffected either way (every re-attempt re-enters the SSRF gate, and the first hop is the URL the
   * gate already judged); what is wrong in that case is the LABEL (`transport-error` for a DB fault).
   * Moving the redirect decision out of the `try` is registered as FS-8 in the design doc, not done here.
   * The webhook's `failure_count` is NOT
   * touched - auto-disable is the flap counter for a receiver that cannot be reached, and this receiver
   * answered; a subscription that permanently redirects therefore stays active and produces one refused
   * delivery per event until an operator fixes the url (registered as a follow-up in the design doc).
   *
   * The `Location` is never read, logged or followed: it is the one input the gate never judged.
   */
  private async handleRefusedRedirect(
    delivery: WebhookDelivery,
    wh: Webhook,
    status: number,
  ): Promise<void> {
    const httpStatus = typeof status === 'number' && Number.isFinite(status) ? status : undefined
    logger.warn('[webhook.delivery.refused]', {
      code: WEBHOOK_TARGET_REJECTED,
      refusalClass: REDIRECT_NOT_ALLOWED,
      hostFamily: webhookHostFamily(wh.url),
      webhookId: wh.id,
      deliveryId: delivery.id,
      event: delivery.event,
      // The STATUS is a response shape, not a value - it is what tells the operator this was a redirect.
      httpStatus,
    })
    delivery.status = 'failed'
    delivery.httpStatus = httpStatus
    delivery.responseBody = `${WEBHOOK_TARGET_REJECTED}:${REDIRECT_NOT_ALLOWED}`

    await this.db
      .updateTable('multitable_webhook_deliveries')
      .set({
        status: 'failed',
        attempt_count: delivery.attemptCount,
        http_status: delivery.httpStatus ?? null,
        response_body: delivery.responseBody,
        next_retry_at: null,
      })
      .where('id', '=', delivery.id)
      .execute()
  }

  /**
   * Retry all failed deliveries that are due for retry.
   */
  async retryFailedDeliveries(): Promise<number> {
    // Ops switch on: return before the claim, so due rows are neither selected nor leased.
    if (outboundOpsSwitchOn) return 0
    // Cross-replica safety (review MINOR-1): claim due rows under
    // FOR UPDATE SKIP LOCKED in a short transaction and lease them forward by
    // bumping next_retry_at, so a concurrent tick on another replica skips
    // them — then deliver OUTSIDE the transaction (no DB lock held across the
    // HTTP attempt, mirroring the M2 reserve-then-settle posture). If this
    // tick crashes mid-delivery the lease expires and the row is retried.
    const now = Date.now()
    const leaseUntil = new Date(now + RETRY_CLAIM_LEASE_MS)
    const claimed = await this.db.transaction().execute(async (trx) => {
      const due = await trx
        .selectFrom('multitable_webhook_deliveries')
        .selectAll()
        .where('status', '=', 'pending')
        .where((eb) =>
          eb.or([
            // scheduled retries whose backoff has elapsed
            eb.and([eb('next_retry_at', 'is not', null), eb('next_retry_at', '<=', new Date(now))]),
            // FIRST-ATTEMPT strays (sink audit 2026-07-17): deliverEvent persists the row and fires the HTTP
            // attempt WITHOUT awaiting; the outcome handler is what stamps status/next_retry_at. A process
            // crash between the INSERT and that handler leaves pending + next_retry_at NULL — which the
            // scheduled-retry leg above can never select, a stuck absorbing state (the module header's
            // "the retry tick picks it up" was false for first attempts). Claim them after a grace period
            // long enough that a LIVE in-flight first attempt (outcome lands within DELIVERY_TIMEOUT_MS)
            // is never double-fired.
            eb.and([
              eb('next_retry_at', 'is', null),
              eb('created_at', '<=', new Date(now - FIRST_ATTEMPT_STRAY_GRACE_MS)),
            ]),
          ]),
        )
        .forUpdate()
        .skipLocked()
        .execute()
      if (due.length > 0) {
        await trx
          .updateTable('multitable_webhook_deliveries')
          .set({ next_retry_at: leaseUntil })
          .where(
            'id',
            'in',
            due.map((r) => String((r as { id: string }).id)),
          )
          .execute()
      }
      return due
    })

    let retried = 0

    for (const row of claimed) {
      const delivery = rowToDelivery(row as Parameters<typeof rowToDelivery>[0])

      const wh = await this.getWebhookById(delivery.webhookId)
      if (!wh || !wh.active) {
        await this.db
          .updateTable('multitable_webhook_deliveries')
          .set({ status: 'failed' })
          .where('id', '=', delivery.id)
          .execute()
        continue
      }

      if (delivery.attemptCount >= wh.maxRetries) {
        await this.db
          .updateTable('multitable_webhook_deliveries')
          .set({ status: 'failed' })
          .where('id', '=', delivery.id)
          .execute()
        continue
      }

      await this.executeDelivery(delivery)
      retried++
    }

    return retried
  }

  /**
   * List recent deliveries for a webhook.
   */
  async listDeliveries(
    webhookId: string,
    limit = 50,
  ): Promise<WebhookDelivery[]> {
    const rows = await this.db
      .selectFrom('multitable_webhook_deliveries')
      .selectAll()
      .where('webhook_id', '=', webhookId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute()

    return rows.map((r) =>
      rowToDelivery(r as Parameters<typeof rowToDelivery>[0]),
    )
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  /**
   * Create the pending delivery row. When `eventId` is supplied (durable path) this is an idempotent CLAIM on
   * the partial-unique `(webhook_id, event_id)` index: `ON CONFLICT DO NOTHING RETURNING id` returns 0 rows
   * when a prior attempt already claimed this (webhook, event) → returns `null`, and the caller skips the
   * send. When `eventId` is absent (legacy path) it is an unconditional INSERT with NULL event_id, exactly as
   * before — the partial index does not constrain NULL, so legacy fan-out is byte-identical.
   */
  private async createDeliveryRecord(
    webhookId: string,
    event: WebhookEventType,
    payload: unknown,
    eventId?: string,
  ): Promise<WebhookDelivery | null> {
    const id = generateId()
    const now = new Date().toISOString()

    if (typeof eventId === 'string' && eventId.length > 0) {
      // Durable claim — raw SQL so the ON CONFLICT targets the partial index precisely. Zero rows ⇒ a prior
      // attempt owns this (webhook, event) ⇒ null (skip the send; the redelivery is terminally handled).
      const claimed = await sql<{ id: string }>`
        INSERT INTO multitable_webhook_deliveries (id, webhook_id, event, payload, status, attempt_count, created_at, event_id)
        VALUES (${id}, ${webhookId}, ${event}, ${toJsonValue(payload)}, 'pending', 0, ${now}, ${eventId})
        ON CONFLICT (webhook_id, event_id) WHERE event_id IS NOT NULL DO NOTHING
        RETURNING id
      `.execute(this.db)
      if (claimed.rows.length === 0) return null
    } else {
      await this.db
        .insertInto('multitable_webhook_deliveries')
        .values({
          id,
          webhook_id: webhookId,
          event,
          payload: toJsonValue(payload),
          status: 'pending',
          attempt_count: 0,
          created_at: now,
        })
        .execute()
    }

    return {
      id,
      webhookId,
      event: event as WebhookEventType,
      payload,
      status: 'pending',
      attemptCount: 0,
      createdAt: now,
    }
  }

  /**
   * A delivery check that could not be completed: nothing is sent, the attempt is counted and the row is
   * rescheduled with the normal backoff (failed once max_retries is reached). failure_count is unchanged,
   * so a check failure never auto-disables the webhook.
   */
  private async handleDeliveryCheckFailure(
    delivery: WebhookDelivery,
    wh: Webhook,
  ): Promise<void> {
    delivery.attemptCount += 1
    if (delivery.attemptCount >= wh.maxRetries) {
      await this.db
        .updateTable('multitable_webhook_deliveries')
        .set({ status: 'failed', attempt_count: delivery.attemptCount })
        .where('id', '=', delivery.id)
        .execute()
      delivery.status = 'failed'
      return
    }
    const delay = WebhookService.computeBackoffMs(
      delivery.attemptCount,
      wh.retryBaseDelayMs,
      wh.retryMaxDelayMs,
    )
    const nextRetry = new Date(Date.now() + delay).toISOString()
    delivery.nextRetryAt = nextRetry
    delivery.status = 'pending'
    await this.db
      .updateTable('multitable_webhook_deliveries')
      .set({ status: 'pending', attempt_count: delivery.attemptCount, next_retry_at: nextRetry })
      .where('id', '=', delivery.id)
      .execute()
  }

  private async handleDeliveryFailure(
    delivery: WebhookDelivery,
    wh: Webhook,
  ): Promise<void> {
    const newFailureCount = wh.failureCount + 1
    const maxConsecutiveFailures = WebhookService.maxConsecutiveFailures()

    if (newFailureCount >= maxConsecutiveFailures) {
      await this.db
        .updateTable('multitable_webhooks')
        .set({ active: false, failure_count: newFailureCount })
        .where('id', '=', wh.id)
        .execute()

      await this.db
        .updateTable('multitable_webhook_deliveries')
        .set({
          status: 'failed',
          attempt_count: delivery.attemptCount,
          http_status: delivery.httpStatus ?? null,
          response_body: delivery.responseBody ?? null,
        })
        .where('id', '=', delivery.id)
        .execute()

      delivery.status = 'failed'
      logger.warn(
        `Webhook ${wh.id} auto-disabled after ${maxConsecutiveFailures} consecutive failures`,
      )
      return
    }

    await this.db
      .updateTable('multitable_webhooks')
      .set({ failure_count: newFailureCount })
      .where('id', '=', wh.id)
      .execute()

    if (delivery.attemptCount >= wh.maxRetries) {
      await this.db
        .updateTable('multitable_webhook_deliveries')
        .set({
          status: 'failed',
          attempt_count: delivery.attemptCount,
          http_status: delivery.httpStatus ?? null,
          response_body: delivery.responseBody ?? null,
        })
        .where('id', '=', delivery.id)
        .execute()

      delivery.status = 'failed'
      return
    }

    // Exponential backoff, driven by the webhook's stored retry policy (or the
    // module defaults when the row predates the policy columns / leaves them NULL).
    const delay = WebhookService.computeBackoffMs(
      delivery.attemptCount,
      wh.retryBaseDelayMs,
      wh.retryMaxDelayMs,
    )
    const nextRetry = new Date(Date.now() + delay).toISOString()
    delivery.nextRetryAt = nextRetry
    delivery.status = 'pending'

    await this.db
      .updateTable('multitable_webhook_deliveries')
      .set({
        status: 'pending',
        attempt_count: delivery.attemptCount,
        next_retry_at: nextRetry,
        http_status: delivery.httpStatus ?? null,
        response_body: delivery.responseBody ?? null,
      })
      .where('id', '=', delivery.id)
      .execute()
  }

  /**
   * Compute HMAC-SHA256 signature for webhook payload.
   */
  static signPayload(body: string, secret: string): string {
    return createHmac('sha256', secret).update(body).digest('hex')
  }

  /**
   * Exponential backoff for the Nth attempt (1-based): base * 2^(attempt-1),
   * optionally capped at maxMs. Absent base/cap fall back to the module
   * default (1s base, uncapped) so legacy webhooks keep today's behavior.
   */
  static computeBackoffMs(
    attemptCount: number,
    baseMs?: number,
    maxMs?: number,
  ): number {
    const base = baseMs ?? BASE_RETRY_DELAY_MS
    const exp = Math.max(0, attemptCount - 1)
    const delay = base * Math.pow(2, exp)
    if (maxMs === undefined) return delay
    // Cross-field guard (review NIT-1): a cap below the base delay would shorten
    // the very first retry below `base`, which is never intended — floor the cap
    // at the base so "cap wins" can only ever lengthen the wait, not invert it.
    return Math.min(delay, Math.max(maxMs, base))
  }

  /**
   * Consecutive-failure count that auto-disables a webhook. Env-configurable via
   * WEBHOOK_MAX_CONSECUTIVE_FAILURES (default 10); a non-positive / non-numeric
   * value falls back to the default rather than disabling immediately.
   */
  static maxConsecutiveFailures(): number {
    const raw = process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES
    if (raw === undefined) return DEFAULT_MAX_CONSECUTIVE_FAILURES
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_MAX_CONSECUTIVE_FAILURES
  }
}
