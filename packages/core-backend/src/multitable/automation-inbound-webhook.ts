import { createHmac, timingSafeEqual } from 'crypto'

export const WEBHOOK_RECEIVED_TRIGGER = 'webhook.received'
export const INBOUND_WEBHOOK_SIGNATURE_HEADER = 'x-ms-webhook-signature'
export const INBOUND_WEBHOOK_TIMESTAMP_HEADER = 'x-ms-webhook-timestamp'
export const INBOUND_WEBHOOK_SIGNATURE_PREFIX = 'sha256='
export const INBOUND_WEBHOOK_REPLAY_WINDOW_SECONDS = 300
export const INBOUND_WEBHOOK_BODY_LIMIT = '1mb'
export const INBOUND_WEBHOOK_RATE_LIMIT_PER_MINUTE = 60
export const INBOUND_WEBHOOK_RATE_LIMIT_WINDOW_MS = 60_000
export const INBOUND_WEBHOOK_REDACTED_SECRET = '<redacted>'

export type InboundWebhookRejectReason =
  | 'unknown_rule'
  | 'wrong_trigger'
  | 'disabled'
  | 'missing_secret'
  | 'missing_body'
  | 'invalid_body'
  | 'missing_timestamp'
  | 'stale_timestamp'
  | 'missing_signature'
  | 'bad_signature'

export function inboundWebhookSecret(triggerConfig: Record<string, unknown> | null | undefined): string {
  const secret = triggerConfig && typeof triggerConfig.secret === 'string' ? triggerConfig.secret.trim() : ''
  return secret
}

export function validateInboundWebhookTriggerAtSave(
  triggerType: string,
  triggerConfig: Record<string, unknown> | null | undefined,
): string | null {
  if (triggerType !== WEBHOOK_RECEIVED_TRIGGER) return null
  const secret = inboundWebhookSecret(triggerConfig)
  if (!secret) {
    return 'webhook.received requires trigger_config.secret'
  }
  // Defense-in-depth: the read API returns the secret as this placeholder. A client that naively
  // round-trips a fetched rule would otherwise PERSIST the placeholder as the literal secret and
  // silently break every future signature check. Reject it — keep the stored secret by omitting
  // triggerConfig from the update, or send a real replacement to rotate.
  if (secret === INBOUND_WEBHOOK_REDACTED_SECRET) {
    return 'webhook.received trigger_config.secret must not be the redacted placeholder (omit triggerConfig to keep the stored secret, or provide a new one)'
  }
  return null
}

export function signInboundWebhookBody(rawBody: Buffer | string, secret: string, unixSeconds: number | string): string {
  const timestamp = String(unixSeconds)
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex')
  return `${INBOUND_WEBHOOK_SIGNATURE_PREFIX}${digest}`
}

function normalizeSignatureHeader(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value
  const sig = typeof raw === 'string' ? raw.trim() : ''
  return sig.startsWith(INBOUND_WEBHOOK_SIGNATURE_PREFIX)
    ? sig.slice(INBOUND_WEBHOOK_SIGNATURE_PREFIX.length)
    : sig
}

export function verifyInboundWebhookSignature(input: {
  rawBody: Buffer
  secret: string
  timestampHeader: unknown
  signatureHeader: unknown
  nowMs?: number
}): { ok: true } | { ok: false; reason: InboundWebhookRejectReason } {
  const timestampRaw = Array.isArray(input.timestampHeader) ? input.timestampHeader[0] : input.timestampHeader
  const timestamp = typeof timestampRaw === 'string' ? timestampRaw.trim() : ''
  if (!timestamp) return { ok: false, reason: 'missing_timestamp' }
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'stale_timestamp' }

  const tsSeconds = Number(timestamp)
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000)
  if (!Number.isFinite(tsSeconds) || Math.abs(nowSeconds - tsSeconds) > INBOUND_WEBHOOK_REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: 'stale_timestamp' }
  }

  const providedHex = normalizeSignatureHeader(input.signatureHeader)
  if (!providedHex) return { ok: false, reason: 'missing_signature' }
  if (!/^[a-f0-9]{64}$/i.test(providedHex)) return { ok: false, reason: 'bad_signature' }

  const expected = signInboundWebhookBody(input.rawBody, input.secret, timestamp)
    .slice(INBOUND_WEBHOOK_SIGNATURE_PREFIX.length)
  const expectedBuffer = Buffer.from(expected, 'hex')
  const providedBuffer = Buffer.from(providedHex, 'hex')
  if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
    return { ok: false, reason: 'bad_signature' }
  }
  return { ok: true }
}

export function isTopLevelWebhookJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function redactInboundWebhookTriggerConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(config, 'secret')) return config
  return { ...config, secret: INBOUND_WEBHOOK_REDACTED_SECRET }
}
