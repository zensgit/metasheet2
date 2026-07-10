import { randomBytes } from 'crypto'
import { query as defaultQuery } from '../db/pg'
import { Logger } from '../core/logger'
import {
  DingTalkBusinessError,
  DingTalkRequestError,
  fetchDingTalkAppAccessToken,
  sendDingTalkWorkNotification,
  sendDingTalkWorkNotificationActionCard,
  type DingTalkMessageConfig,
  type DingTalkWorkNotificationActionCardInput,
  type DingTalkWorkNotificationResult,
} from '../integrations/dingtalk/client'
import {
  readDingTalkMessageConfigFromRuntime,
} from '../integrations/dingtalk/work-notification-settings'
import {
  WeComBusinessError,
  WeComRequestError,
  clampWeComByteLengthUtf8,
  clampWeComCharLength,
  fetchWeComAppAccessToken,
  invalidateWeComAppAccessTokenCache,
  readWeComMessageConfigFromEnv,
  resolveWeComMessageConfigReadiness,
  sendWeComTextCardMessage,
  sendWeComTextMessage,
  WECOM_TEXTCARD_DESCRIPTION_MAX_CHARS,
  WECOM_TEXTCARD_TITLE_MAX_CHARS,
  WECOM_TEXT_CONTENT_MAX_BYTES,
  type WeComMessageConfig,
  type WeComSendMessageResult,
  type WeComTextCardMessageInput,
  type WeComTextMessageInput,
} from '../integrations/wecom/client'
import nodemailer from 'nodemailer'
import {
  resolveEmailSmtpTransportConfig,
  resolveEmailTransportReadiness,
  redactEmailTransportText,
  type EmailSmtpTransportConfig,
} from './email-transport-readiness'

/**
 * C5-2 delivery worker.
 *
 * Consumes `attendance_notification_deliveries` outbox rows, claims due rows with a short lease, sends
 * each row through its named channel, and writes per-delivery status. This worker is the first component
 * allowed to turn C5 outbox rows into sends; source producers must only insert rows.
 */

export type AttendanceNotificationDeliveryQuery = <T = unknown>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[]; rowCount?: number | null }>

export interface AttendanceDeliveryMessage {
  id: string
  orgId: string
  sourceType: string
  sourceId: string | null
  sourceKey: string
  recipientUserId: string
  recipientRole: string
  channel: string
  payload: Record<string, unknown>
}

/**
 * `skip` only has meaning alongside `retryable: false` — it tells the worker this recipient is
 * structurally undeliverable through this channel (no identity to send to, retrying will never help)
 * as opposed to a genuine send failure worth operator attention. The worker terminates a `skip: true`
 * result as delivery status `skipped` instead of `failed`, so a partially-onboarded org's ordinary
 * "this user has no channel identity yet" case does not pollute the dead-letter/failed counter that
 * exists to surface real delivery faults (API errors, timeouts, quota). Channels MUST NOT set `skip`
 * on a retryable result; the worker only consults it once `retryable` is already false.
 */
export type AttendanceDeliveryChannelResult =
  | { ok: true }
  | { ok: false; retryable: boolean; error: string; skip?: boolean }

export interface AttendanceDeliveryChannel {
  readonly name: string
  send(message: AttendanceDeliveryMessage): Promise<AttendanceDeliveryChannelResult>
}

export interface AttendanceNotificationDeliveryWorkerOptions {
  query?: AttendanceNotificationDeliveryQuery
  channels?: AttendanceDeliveryChannel[]
  batchSize?: number
  leaseMs?: number
  maxAttempts?: number
  workerId?: string
  now?: () => Date
  logger?: Logger
  /**
   * R8 quiet hours gate. `undefined` (the default when the worker is constructed by
   * resolveAttendanceNotificationDeliveryJob) resolves from ATTENDANCE_NOTIFICATION_QUIET_HOURS /
   * ATTENDANCE_NOTIFICATION_QUIET_HOURS_TZ at construction time; pass `null` explicitly to force the
   * gate off (e.g. tests), or a concrete config to bypass env parsing entirely (also tests).
   */
  quietHours?: AttendanceNotificationQuietHoursConfig | null
}

export interface DingTalkAttendanceDeliveryChannelOptions {
  query?: AttendanceNotificationDeliveryQuery
  readConfig?: (integrationId?: string) => Promise<DingTalkMessageConfig>
  fetchAccessToken?: (config: DingTalkMessageConfig) => Promise<string>
  sendWorkNotification?: (
    accessToken: string,
    input: { userIds: string[]; title: string; content: string },
    config: DingTalkMessageConfig,
  ) => Promise<DingTalkWorkNotificationResult>
  sendWorkNotificationActionCard?: (
    accessToken: string,
    input: DingTalkWorkNotificationActionCardInput,
    config: DingTalkMessageConfig,
  ) => Promise<DingTalkWorkNotificationResult>
}

/**
 * E3 notification deep link (e3-notification-deeplink design-lock): the URL a
 * DingTalk actionCard button opens — the E2 container landing (/attendance,
 * overview) with the notification source as an inert query marker. Returns
 * null when no base URL is configured (callers fall back to the text path).
 */
export function buildAttendanceNotificationDeepLink(sourceType: string, baseUrl: string | null | undefined): string | null {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!base) return null
  return `${base}/attendance?noticeSource=${encodeURIComponent(String(sourceType ?? '').trim())}`
}

function resolveAttendanceDeepLinkBaseUrl(): string | null {
  return process.env.PUBLIC_APP_URL?.trim() || process.env.APP_BASE_URL?.trim() || null
}

// Both the flag AND a base URL must be present: PUBLIC_APP_URL is already set
// in production for the approval cards, so its presence alone must not flip
// this channel's msgtype (env-gate side-effect channel discipline).
function attendanceDeepLinkEnabled(): boolean {
  return String(process.env.ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED ?? '').trim() === 'true'
}

export interface AttendanceNotificationDeliveryResult {
  claimed: number
  sent: number
  retrying: number
  failed: number
  skipped: number
  lostLease?: number
}

interface DeliveryRow {
  id: string
  org_id: string
  source_type: string
  source_id: string | null
  source_key: string
  recipient_user_id: string
  recipient_role: string
  channel: string
  attempt_count: number | string
  payload: unknown
}

const DEFAULT_BATCH_SIZE = 50
const DEFAULT_LEASE_MS = 60_000
const DEFAULT_MAX_ATTEMPTS = 5
const MIN_BATCH_SIZE = 1
const MAX_BATCH_SIZE = 200
const MIN_LEASE_MS = 5_000
const MAX_LEASE_MS = 10 * 60_000
export const DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME = 'dingtalk_work_notification'
export const EMAIL_SMTP_CHANNEL_NAME = 'email_smtp'
export const WECOM_WORK_NOTIFICATION_CHANNEL_NAME = 'wecom_work_notification'

/**
 * Channel names a producer may assign to a NEW outbox row — these MUST be names the worker's channel
 * registry can route (see createAttendanceDeliveryChannelsFromEnv). This set is ALSO the SQL-injection
 * guard: resolveAttendanceDefaultDeliveryChannel interpolates its result into the producer SQL, so only
 * an allowlisted constant may ever reach the query.
 */
const ROUTABLE_DEFAULT_DELIVERY_CHANNELS: ReadonlySet<string> = new Set([
  DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME,
  EMAIL_SMTP_CHANNEL_NAME,
  WECOM_WORK_NOTIFICATION_CHANNEL_NAME,
])

/**
 * The default delivery channel a producer stamps onto a NEW outbox row. S2 v1 = one deployment-wide
 * default via `ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL`, **defaulting to the in-app work-notification
 * channel** — behavior is unchanged until an operator configures it. The value is allowlist-validated
 * (unrecognized / empty → the default) so an arbitrary env value can never be interpolated into the
 * producer SQL. Per-org / per-recipient routing is the design-lock §3 follow-up (a producer would
 * consult an org/recipient preference before falling back to this default).
 */
export function resolveAttendanceDefaultDeliveryChannel(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL ?? '').trim()
  return ROUTABLE_DEFAULT_DELIVERY_CHANNELS.has(configured)
    ? configured
    : DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME
}

export function clampDeliveryBatchSize(value: number | undefined): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_BATCH_SIZE
  return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, Math.floor(n)))
}

export function clampDeliveryLeaseMs(value: number | undefined): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_LEASE_MS
  return Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, Math.floor(n)))
}

export function computeDeliveryBackoffMs(attemptCount: number): number {
  if (attemptCount <= 1) return 60_000
  if (attemptCount === 2) return 5 * 60_000
  if (attemptCount === 3) return 15 * 60_000
  if (attemptCount === 4) return 60 * 60_000
  return 6 * 60 * 60_000
}

export interface AttendanceNotificationQuietHoursConfig {
  /** 24h "HH:MM", local to `timeZone`. */
  start: string
  /** 24h "HH:MM", local to `timeZone`; may be < start (cross-midnight window, e.g. 22:00-08:00). */
  end: string
  /** IANA zone name, e.g. "Asia/Shanghai". */
  timeZone: string
}

const QUIET_HOURS_ENV_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/
const DEFAULT_QUIET_HOURS_TZ = 'Asia/Shanghai'

/**
 * R8 quiet-hours window (design decision: deployment-wide v1, consistent with every existing
 * ATTENDANCE_NOTIFICATION_* knob — per-org config is a named follow-up, not v1).
 *
 * ATTENDANCE_NOTIFICATION_QUIET_HOURS="HH:MM-HH:MM" — unset/empty = off (unchanged behavior).
 * ATTENDANCE_NOTIFICATION_QUIET_HOURS_TZ — IANA zone; defaults to Asia/Shanghai.
 *
 * Malformed input (bad "HH:MM-HH:MM" shape, or a TZ Intl does not recognize) never throws: it logs a
 * single warn and disables the gate (off), exactly like unset — a typo in ops config must not crash the
 * scheduler tick or start silently dropping notifications outside a window nobody intended.
 */
export function resolveAttendanceNotificationQuietHours(
  env: NodeJS.ProcessEnv = process.env,
  logger: Pick<Logger, 'warn'> = new Logger('AttendanceNotificationDeliveryWorker'),
): AttendanceNotificationQuietHoursConfig | null {
  const raw = (env.ATTENDANCE_NOTIFICATION_QUIET_HOURS ?? '').trim()
  if (!raw) return null
  const match = QUIET_HOURS_ENV_PATTERN.exec(raw)
  if (!match) {
    logger.warn(
      `Ignoring malformed ATTENDANCE_NOTIFICATION_QUIET_HOURS="${raw}" (expected "HH:MM-HH:MM", 24h clock); quiet hours disabled`,
    )
    return null
  }
  const timeZone = (env.ATTENDANCE_NOTIFICATION_QUIET_HOURS_TZ ?? '').trim() || DEFAULT_QUIET_HOURS_TZ
  try {
    // Throws RangeError for a zone Intl does not recognize; this is the validation, the format result
    // itself is discarded.
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date())
  } catch {
    logger.warn(`Ignoring invalid ATTENDANCE_NOTIFICATION_QUIET_HOURS_TZ="${timeZone}"; quiet hours disabled`)
    return null
  }
  return { start: `${match[1]}:${match[2]}`, end: `${match[3]}:${match[4]}`, timeZone }
}

/**
 * Same cross-midnight wrap shape as NotificationService.isInQuietHours (start<=end → contiguous
 * window; start>end → wraps past midnight, "inside" means >= start OR <= end), but the local HH:MM is
 * computed via Intl.DateTimeFormat in the CONFIGURED timezone — NotificationService uses
 * `toTimeString()` (server-local time) and silently ignores its own `timezone` field; that bug is not
 * repeated here.
 */
export function isAttendanceNotificationQuietHours(
  now: Date,
  config: AttendanceNotificationQuietHoursConfig,
): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00'
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00'
  const current = `${hour}:${minute}`
  if (config.start <= config.end) {
    return current >= config.start && current <= config.end
  }
  return current >= config.start || current <= config.end
}

export class DeterministicFakeAttendanceDeliveryChannel implements AttendanceDeliveryChannel {
  readonly name = DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME

  async send(message: AttendanceDeliveryMessage): Promise<AttendanceDeliveryChannelResult> {
    const mode = String(message.payload.fakeDelivery ?? message.payload.deliveryMode ?? 'ok')
    if (mode === 'retry' || mode === 'retryable_failure') {
      return { ok: false, retryable: true, error: 'fake_retryable_failure' }
    }
    if (mode === 'fail' || mode === 'non_retryable_failure') {
      return { ok: false, retryable: false, error: 'fake_non_retryable_failure' }
    }
    if (mode === 'skip' || mode === 'structural_skip') {
      // Deterministic stand-in for a channel-flagged structurally-undeliverable recipient (e.g. the real
      // DingTalk channel's dingtalk_recipient_not_bound) — exercises the worker's skip: true → `skipped`
      // dispatch path without needing the real DingTalk channel/directory tables.
      return { ok: false, retryable: false, skip: true, error: 'fake_structural_skip' }
    }
    return { ok: true }
  }
}

export function createAttendanceDeliveryChannelsFromEnv(env: NodeJS.ProcessEnv = process.env): AttendanceDeliveryChannel[] {
  // Accumulate every enabled channel (the worker routes each delivery row by `row.channel` name, so
  // channels coexist). Each is independently env-gated + default-off.
  const channels: AttendanceDeliveryChannel[] = []
  if (env.ATTENDANCE_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED === 'true') {
    channels.push(new DingTalkAttendanceDeliveryChannel())
  } else if (env.ATTENDANCE_NOTIFICATION_FAKE_CHANNEL_ENABLED === 'true') {
    // Fake registers ONLY when the real in-app channel is not enabled (preserve real-over-fake
    // precedence; both gates accidentally on → real wins). Email below is a distinct channel and
    // coexists with whichever in-app channel is active (the worker routes by `row.channel` name).
    channels.push(new DeterministicFakeAttendanceDeliveryChannel())
  }
  // Email: register ONLY when explicitly enabled AND SMTP transport is actually configured+ready
  // (else an at-least-once retry would spin against an unconfigured transport — register-nothing instead).
  if (
    env.ATTENDANCE_NOTIFICATION_EMAIL_ENABLED === 'true' &&
    resolveEmailTransportReadiness(env).mode === 'smtp' &&
    resolveEmailTransportReadiness(env).ok
  ) {
    channels.push(new EmailAttendanceDeliveryChannel({ env }))
  }
  // WeCom (企业微信): a THIRD, independent in-app channel — register ONLY when explicitly enabled AND
  // its app credentials (corpid+corpsecret+agentid) are all present (env-only readiness check, see
  // resolveWeComMessageConfigReadiness); else register-nothing (S4 design-lock G2).
  if (
    env.ATTENDANCE_NOTIFICATION_WECOM_ENABLED === 'true' &&
    resolveWeComMessageConfigReadiness(env).ok
  ) {
    channels.push(new WeComAttendanceDeliveryChannel())
  }
  return channels
}

interface DingTalkRecipientRow {
  integration_id: string
  external_user_id: string
}

export class DingTalkAttendanceDeliveryChannel implements AttendanceDeliveryChannel {
  readonly name = DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME
  private readonly query: AttendanceNotificationDeliveryQuery
  private readonly readConfig: (integrationId?: string) => Promise<DingTalkMessageConfig>
  private readonly fetchAccessToken: (config: DingTalkMessageConfig) => Promise<string>
  private readonly sendWorkNotification: (
    accessToken: string,
    input: { userIds: string[]; title: string; content: string },
    config: DingTalkMessageConfig,
  ) => Promise<DingTalkWorkNotificationResult>

  private readonly sendWorkNotificationActionCard: (
    accessToken: string,
    input: DingTalkWorkNotificationActionCardInput,
    config: DingTalkMessageConfig,
  ) => Promise<DingTalkWorkNotificationResult>

  constructor(options: DingTalkAttendanceDeliveryChannelOptions = {}) {
    this.query = options.query ?? (defaultQuery as AttendanceNotificationDeliveryQuery)
    this.readConfig = options.readConfig ?? readDingTalkMessageConfigFromRuntime
    this.fetchAccessToken = options.fetchAccessToken ?? fetchDingTalkAppAccessToken
    this.sendWorkNotification = options.sendWorkNotification ?? sendDingTalkWorkNotification
    this.sendWorkNotificationActionCard = options.sendWorkNotificationActionCard ?? sendDingTalkWorkNotificationActionCard
  }

  async send(message: AttendanceDeliveryMessage): Promise<AttendanceDeliveryChannelResult> {
    const recipient = await this.resolveRecipient(message)
    if (recipient.ok === false) return recipient.result

    let config: DingTalkMessageConfig
    try {
      config = await this.readConfig(recipient.integrationId)
    } catch (error) {
      return classifyConfigError(error)
    }

    try {
      const accessToken = await this.fetchAccessToken(config)
      const deepLink = attendanceDeepLinkEnabled()
        ? buildAttendanceNotificationDeepLink(message.sourceType, resolveAttendanceDeepLinkBaseUrl())
        : null
      if (deepLink) {
        // E3: actionCard whose button deep-links into the E2 container landing.
        // Same title/content source as the text path — no per-msgtype drift.
        await this.sendWorkNotificationActionCard(
          accessToken,
          {
            userIds: [recipient.dingTalkUserId],
            title: buildDeliveryTitle(message),
            markdown: buildDeliveryContent(message),
            singleTitle: '打开考勤',
            singleUrl: deepLink,
          },
          config,
        )
      } else {
        await this.sendWorkNotification(
          accessToken,
          {
            userIds: [recipient.dingTalkUserId],
            title: buildDeliveryTitle(message),
            content: buildDeliveryContent(message),
          },
          config,
        )
      }
      return { ok: true }
    } catch (error) {
      return classifyDingTalkSendError(error)
    }
  }

  private async resolveRecipient(message: AttendanceDeliveryMessage): Promise<
    | { ok: true; integrationId: string; dingTalkUserId: string }
    | { ok: false; result: AttendanceDeliveryChannelResult }
  > {
    const { rows } = await this.query<DingTalkRecipientRow>(
      `SELECT i.id::text AS integration_id,
              a.external_user_id
         FROM directory_account_links l
         JOIN directory_accounts a
           ON a.id = l.directory_account_id
          AND a.provider = 'dingtalk'
          AND a.is_active = true
         JOIN directory_integrations i
           ON i.id = a.integration_id
          AND i.provider = 'dingtalk'
          AND i.status = 'active'
          AND i.org_id = $2
        WHERE l.local_user_id = $1
          AND l.link_status = 'linked'
        ORDER BY i.updated_at DESC, a.updated_at DESC, a.id ASC
        LIMIT 2`,
      [message.recipientUserId, message.orgId],
    )
    if (rows.length === 0) {
      // 0 rows conflates two different situations (H1 hardening — review #3920 P3-1): the ordinary
      // "this user is not onboarded to DingTalk yet" gap for a partially-adopted org (SKIP — correct,
      // unchanged), and "the org itself has no active DingTalk integration at all" because it was
      // suspended/reconfigured/removed (directory_integrations has no status='active' row for this
      // org). The latter is an org-level, typically RECOVERABLE outage: every delivery for that org
      // would otherwise be silently and PERMANENTLY dropped via the `skipped` terminal state, and
      // integration recovery would not self-heal anything already skipped. Disambiguate with one
      // extra existence check — only reached on this cold 0-row path, never on the hot bound-recipient
      // path.
      const { rows: orgIntegrationRows } = await this.query<{ org_has_active_integration: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM directory_integrations
            WHERE org_id = $1
              AND provider = 'dingtalk'
              AND status = 'active'
         ) AS org_has_active_integration`,
        [message.orgId],
      )
      const orgHasActiveIntegration = Boolean(orgIntegrationRows[0]?.org_has_active_integration)
      if (!orgHasActiveIntegration) {
        // No active DingTalk integration exists for this org at all — not this one user's onboarding
        // gap. Return a retryable failure (NOT skip) so the worker's normal backoff keeps retrying;
        // if/when the integration is re-activated, the delivery self-heals instead of staying dropped.
        return {
          ok: false,
          result: { ok: false, retryable: true, error: 'dingtalk_org_integration_inactive' },
        }
      }
      // The org DOES have an active DingTalk integration — this really is just "this user is not
      // onboarded yet". Nothing about retrying (or alerting on this specific delivery) would help; the
      // fix is a directory sync/linking action outside this worker's scope. Structural, not a fault:
      // terminate as `skipped`, not `failed`.
      return {
        ok: false,
        result: { ok: false, retryable: false, skip: true, error: 'dingtalk_recipient_not_bound' },
      }
    }
    if (rows.length > 1) {
      // Two+ active linked bindings for the same local user is a directory DATA INTEGRITY anomaly, not
      // an expected "not onboarded" gap — it means account-linking let a duplicate/ambiguous state form.
      // That is worth an operator's attention (dedupe the links), so this intentionally stays `failed`
      // (visible in the dead-letter counter) rather than `skipped`. Retrying still will not help, hence
      // retryable: false, but we do not set `skip`.
      return {
        ok: false,
        result: { ok: false, retryable: false, error: 'dingtalk_recipient_ambiguous' },
      }
    }
    const dingTalkUserId = String(rows[0].external_user_id ?? '').trim()
    if (!dingTalkUserId) {
      // A linked, unambiguous binding row exists but its external_user_id is blank. From this delivery's
      // perspective there is still no usable DingTalk identity to send to — same structural class as
      // "not bound" (no action a retry could take), so this also terminates as `skipped`.
      return {
        ok: false,
        result: { ok: false, retryable: false, skip: true, error: 'dingtalk_recipient_external_user_id_missing' },
      }
    }
    return {
      ok: true,
      integrationId: rows[0].integration_id,
      dingTalkUserId,
    }
  }
}

// ── WeCom (企业微信) delivery channel ───────────────────────────────────────────
// S4 design-lock (attendance-wecom-delivery-channel-s4-design-lock-20260710). A THIRD, independent
// AttendanceDeliveryChannel beside DingTalk and Email — coexists via name-routing. Config is env-only
// (no directory-stored tier in this slice; see design-lock G7). Recipient resolution is the SAME
// three-table JOIN as DingTalk, scoped to provider='wecom' (zero new tables/columns).

interface WeComRecipientRow {
  integration_id: string
  external_user_id: string
}

export interface WeComAttendanceDeliveryChannelOptions {
  query?: AttendanceNotificationDeliveryQuery
  readConfig?: (integrationId?: string) => Promise<WeComMessageConfig>
  fetchAccessToken?: (config: WeComMessageConfig) => Promise<string>
  sendTextMessage?: (
    accessToken: string,
    input: WeComTextMessageInput,
    config: WeComMessageConfig,
  ) => Promise<WeComSendMessageResult>
  sendTextCardMessage?: (
    accessToken: string,
    input: WeComTextCardMessageInput,
    config: WeComMessageConfig,
  ) => Promise<WeComSendMessageResult>
}

const WECOM_TOKEN_EXPIRED_ERRCODES: ReadonlySet<number> = new Set([42001, 40014])

export class WeComAttendanceDeliveryChannel implements AttendanceDeliveryChannel {
  readonly name = WECOM_WORK_NOTIFICATION_CHANNEL_NAME
  private readonly query: AttendanceNotificationDeliveryQuery
  private readonly readConfig: (integrationId?: string) => Promise<WeComMessageConfig>
  private readonly fetchAccessToken: (config: WeComMessageConfig) => Promise<string>
  private readonly sendTextMessage: (
    accessToken: string,
    input: WeComTextMessageInput,
    config: WeComMessageConfig,
  ) => Promise<WeComSendMessageResult>

  private readonly sendTextCardMessage: (
    accessToken: string,
    input: WeComTextCardMessageInput,
    config: WeComMessageConfig,
  ) => Promise<WeComSendMessageResult>

  constructor(options: WeComAttendanceDeliveryChannelOptions = {}) {
    this.query = options.query ?? (defaultQuery as AttendanceNotificationDeliveryQuery)
    this.readConfig = options.readConfig ?? (async () => readWeComMessageConfigFromEnv())
    this.fetchAccessToken = options.fetchAccessToken ?? fetchWeComAppAccessToken
    this.sendTextMessage = options.sendTextMessage ?? sendWeComTextMessage
    this.sendTextCardMessage = options.sendTextCardMessage ?? sendWeComTextCardMessage
  }

  async send(message: AttendanceDeliveryMessage): Promise<AttendanceDeliveryChannelResult> {
    const recipient = await this.resolveRecipient(message)
    if (recipient.ok === false) return recipient.result

    let config: WeComMessageConfig
    try {
      config = await this.readConfig(recipient.integrationId)
    } catch (error) {
      return classifyWeComConfigError(error)
    }

    const deepLink = attendanceDeepLinkEnabled()
      ? buildAttendanceNotificationDeepLink(message.sourceType, resolveAttendanceDeepLinkBaseUrl())
      : null
    const title = buildDeliveryTitle(message)
    const content = buildDeliveryContent(message)

    // Field-length guards (design-lock G4) are applied HERE, before the (possibly-injected) sender —
    // a clamp inside the client's send function would be invisible to DI-mode tests that stub it out.
    const doSend = (accessToken: string): Promise<WeComSendMessageResult> => {
      if (deepLink) {
        // E3 parity: textcard whose button deep-links into the E2 container landing. Same
        // title/content source as the text path — no per-msgtype drift.
        return this.sendTextCardMessage(
          accessToken,
          {
            userIds: [recipient.weComUserId],
            title: clampWeComCharLength(title, WECOM_TEXTCARD_TITLE_MAX_CHARS),
            description: clampWeComCharLength(content, WECOM_TEXTCARD_DESCRIPTION_MAX_CHARS),
            url: deepLink,
            btnTxt: '打开考勤',
          },
          config,
        )
      }
      return this.sendTextMessage(
        accessToken,
        {
          userIds: [recipient.weComUserId],
          content: clampWeComByteLengthUtf8(content, WECOM_TEXT_CONTENT_MAX_BYTES),
        },
        config,
      )
    }

    let accessToken: string
    try {
      accessToken = await this.fetchAccessToken(config)
    } catch (error) {
      return classifyWeComSendError(error)
    }

    let result: WeComSendMessageResult
    try {
      result = await doSend(accessToken)
    } catch (error) {
      // G3: a token-expired/invalid business error gets exactly ONE invalidate+refetch+retry; whatever
      // happens on that retry (success or any failure) is final — no further retry loop here (the
      // worker's own backoff handles subsequent attempts across outbox rows).
      if (error instanceof WeComBusinessError && WECOM_TOKEN_EXPIRED_ERRCODES.has(error.errcode)) {
        invalidateWeComAppAccessTokenCache(config)
        try {
          const freshToken = await this.fetchAccessToken(config)
          result = await doSend(freshToken)
        } catch (retryError) {
          return classifyWeComSendError(retryError)
        }
      } else {
        return classifyWeComSendError(error)
      }
    }

    // G6: errcode===0 (overall success) can still carry `invaliduser` listing THIS recipient — a
    // structural per-recipient failure inside an otherwise-successful call. Never thrown (errcode is
    // 0), so it is only observable here, not via classifyWeComSendError.
    if (result.invalidUserIds.includes(recipient.weComUserId)) {
      return { ok: false, retryable: false, skip: true, error: 'wecom_recipient_invalid_user' }
    }
    return { ok: true }
  }

  private async resolveRecipient(message: AttendanceDeliveryMessage): Promise<
    | { ok: true; integrationId: string; weComUserId: string }
    | { ok: false; result: AttendanceDeliveryChannelResult }
  > {
    const { rows } = await this.query<WeComRecipientRow>(
      `SELECT i.id::text AS integration_id,
              a.external_user_id
         FROM directory_account_links l
         JOIN directory_accounts a
           ON a.id = l.directory_account_id
          AND a.provider = 'wecom'
          AND a.is_active = true
         JOIN directory_integrations i
           ON i.id = a.integration_id
          AND i.provider = 'wecom'
          AND i.status = 'active'
          AND i.org_id = $2
        WHERE l.local_user_id = $1
          AND l.link_status = 'linked'
        ORDER BY i.updated_at DESC, a.updated_at DESC, a.id ASC
        LIMIT 2`,
      [message.recipientUserId, message.orgId],
    )
    if (rows.length === 0) {
      // 0 rows conflates two different situations (H1 hardening — review #3920 P3-1, applied here for
      // parity with the DingTalk channel — same shape, same fix): the ordinary "this user is not
      // onboarded to WeCom yet" gap for a partially-adopted org (SKIP — correct, unchanged; WeCom
      // directory population is a named prerequisite outside this channel's scope — S4 design-lock
      // G7), and "the org itself has no active WeCom integration at all" because it was
      // suspended/reconfigured/removed. The latter is an org-level, typically RECOVERABLE outage:
      // every delivery for that org would otherwise be silently and PERMANENTLY dropped via the
      // `skipped` terminal state. Disambiguate with one extra existence check — only reached on this
      // cold 0-row path, never on the hot bound-recipient path.
      const { rows: orgIntegrationRows } = await this.query<{ org_has_active_integration: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM directory_integrations
            WHERE org_id = $1
              AND provider = 'wecom'
              AND status = 'active'
         ) AS org_has_active_integration`,
        [message.orgId],
      )
      const orgHasActiveIntegration = Boolean(orgIntegrationRows[0]?.org_has_active_integration)
      if (!orgHasActiveIntegration) {
        // No active WeCom integration exists for this org at all — not this one user's onboarding
        // gap. Return a retryable failure (NOT skip) so the worker's normal backoff keeps retrying;
        // if/when the integration is re-activated, the delivery self-heals instead of staying dropped.
        return {
          ok: false,
          result: { ok: false, retryable: true, error: 'wecom_org_integration_inactive' },
        }
      }
      // The org DOES have an active WeCom integration — this really is just "this user is not
      // onboarded yet". Structural, not a fault: terminate as `skipped`.
      return {
        ok: false,
        result: { ok: false, retryable: false, skip: true, error: 'wecom_recipient_not_bound' },
      }
    }
    if (rows.length > 1) {
      // Same directory data-integrity reasoning as the DingTalk channel: worth an operator's
      // attention (dedupe the links), so this stays `failed` (visible in the dead-letter counter)
      // rather than `skipped`. Retrying will not help, hence retryable: false, but no `skip`.
      return {
        ok: false,
        result: { ok: false, retryable: false, error: 'wecom_recipient_ambiguous' },
      }
    }
    const weComUserId = String(rows[0].external_user_id ?? '').trim()
    if (!weComUserId) {
      return {
        ok: false,
        result: { ok: false, retryable: false, skip: true, error: 'wecom_recipient_external_user_id_missing' },
      }
    }
    return {
      ok: true,
      integrationId: rows[0].integration_id,
      weComUserId,
    }
  }
}

export class AttendanceNotificationDeliveryWorker {
  private readonly query: AttendanceNotificationDeliveryQuery
  private readonly channelsByName: Map<string, AttendanceDeliveryChannel>
  private readonly batchSize: number
  private readonly leaseMs: number
  private readonly maxAttempts: number
  private readonly workerId: string
  private readonly now: () => Date
  private readonly logger: Logger
  private readonly quietHours: AttendanceNotificationQuietHoursConfig | null
  private quietHoursLogged = false
  private running = false

  constructor(options: AttendanceNotificationDeliveryWorkerOptions = {}) {
    this.query = options.query ?? (defaultQuery as AttendanceNotificationDeliveryQuery)
    this.channelsByName = new Map((options.channels ?? []).map((channel) => [channel.name, channel]))
    this.batchSize = clampDeliveryBatchSize(options.batchSize)
    this.leaseMs = clampDeliveryLeaseMs(options.leaseMs)
    this.maxAttempts = Number.isFinite(Number(options.maxAttempts)) && Number(options.maxAttempts) > 0
      ? Math.floor(Number(options.maxAttempts))
      : DEFAULT_MAX_ATTEMPTS
    this.workerId = options.workerId ?? `attendance-delivery:${process.pid}:${randomBytes(4).toString('hex')}`
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger ?? new Logger('AttendanceNotificationDeliveryWorker')
    this.quietHours = options.quietHours !== undefined
      ? options.quietHours
      : resolveAttendanceNotificationQuietHours(process.env, this.logger)
  }

  async claimDueDeliveries(): Promise<DeliveryRow[]> {
    const asOf = this.now().toISOString()
    const { rows } = await this.query<DeliveryRow>(
      `WITH claim AS (
         SELECT id
           FROM attendance_notification_deliveries
          WHERE (
                  status IN ('pending','retrying')
              AND next_attempt_at <= $1::timestamptz
            )
             OR (
                  status = 'sending'
              AND claim_expires_at <= $1::timestamptz
            )
          ORDER BY COALESCE(next_attempt_at, claim_expires_at) ASC, created_at ASC
          LIMIT $2::int
          FOR UPDATE SKIP LOCKED
       ),
       claimed AS (
         UPDATE attendance_notification_deliveries d
            SET status = 'sending',
                attempt_count = attempt_count + 1,
                last_attempt_at = $1::timestamptz,
                claimed_at = $1::timestamptz,
                claim_expires_at = $1::timestamptz + ($3::int * interval '1 millisecond'),
                claim_worker_id = $4,
                updated_at = $1::timestamptz
           FROM claim
          WHERE d.id = claim.id
          RETURNING d.id::text AS id,
                    d.org_id,
                    d.source_type,
                    d.source_id,
                    d.source_key,
                    d.recipient_user_id,
                    d.recipient_role,
                    d.channel,
                    d.attempt_count,
                    d.payload
       )
       SELECT *
         FROM claimed
        ORDER BY id`,
      [asOf, this.batchSize, this.leaseMs, this.workerId],
    )
    return rows
  }

  async runBatch(): Promise<AttendanceNotificationDeliveryResult> {
    if (this.running) return { claimed: 0, sent: 0, retrying: 0, failed: 0, skipped: 0 }
    this.running = true
    const result: AttendanceNotificationDeliveryResult = { claimed: 0, sent: 0, retrying: 0, failed: 0, skipped: 0 }
    try {
      // R8: quiet-hours gate sits BEFORE claimDueDeliveries — a zero-result return here touches no SQL
      // at all, so due rows stay untouched (pending/retrying, next_attempt_at unchanged, attempt_count
      // unchanged, no lease taken). They are not lost and not penalized; the very next in-window
      // runBatch() call drains them oldest-first via claimDueDeliveries' ORDER BY. This must NOT be
      // expressed as a channel-level retryable failure — that would burn attempt_count toward
      // maxAttempts and could dead-letter a row via computeDeliveryBackoffMs's up-to-6h backoff.
      if (this.quietHours && isAttendanceNotificationQuietHours(this.now(), this.quietHours)) {
        if (!this.quietHoursLogged) {
          this.logger.info(
            `Attendance notification dispatch deferred: quiet hours ${this.quietHours.start}-${this.quietHours.end} (${this.quietHours.timeZone})`,
          )
          this.quietHoursLogged = true
        }
        return result
      }
      this.quietHoursLogged = false
      const rows = await this.claimDueDeliveries()
      result.claimed = rows.length
      let lostLease = 0
      for (const row of rows) {
        const outcome = await this.deliver(row)
        if (outcome === 'sent') result.sent += 1
        else if (outcome === 'retrying') result.retrying += 1
        else if (outcome === 'failed') result.failed += 1
        else if (outcome === 'skipped') result.skipped += 1
        else lostLease += 1
      }
      if (lostLease > 0) {
        result.lostLease = lostLease
      }
      if (result.claimed > 0) {
        this.logger.info(`Attendance deliveries claimed=${result.claimed} sent=${result.sent} retrying=${result.retrying} failed=${result.failed} skipped=${result.skipped} lostLease=${lostLease}`)
      }
      return result
    } finally {
      this.running = false
    }
  }

  private async deliver(row: DeliveryRow): Promise<'sent' | 'retrying' | 'failed' | 'skipped' | 'lost-lease'> {
    const channel = this.channelsByName.get(row.channel)
    const attemptCount = Number(row.attempt_count)
    if (!channel) {
      return await this.markFailed(row.id, 'attendance_delivery_channel_not_configured', attemptCount)
        ? 'failed'
        : 'lost-lease'
    }

    const message: AttendanceDeliveryMessage = {
      id: row.id,
      orgId: row.org_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      sourceKey: row.source_key,
      recipientUserId: row.recipient_user_id,
      recipientRole: row.recipient_role,
      channel: row.channel,
      payload: parsePayload(row.payload),
    }

    let channelResult: AttendanceDeliveryChannelResult
    try {
      channelResult = await channel.send(message)
    } catch (error) {
      channelResult = { ok: false, retryable: true, error: error instanceof Error ? error.message : String(error) }
    }

    if (channelResult.ok) {
      return await this.markSent(row.id, attemptCount) ? 'sent' : 'lost-lease'
    }

    const failure = channelResult as Extract<AttendanceDeliveryChannelResult, { ok: false }>
    if (!failure.retryable || attemptCount >= this.maxAttempts) {
      // Only a genuinely non-retryable, channel-flagged-structural result skips the dead-letter bucket.
      // A retryable failure that merely ran out of attempts (attemptCount >= maxAttempts) always still
      // lands in `failed` — it was a real, repeated send failure, not something we should have skipped.
      if (!failure.retryable && failure.skip) {
        return await this.markSkipped(row.id, failure.error, attemptCount) ? 'skipped' : 'lost-lease'
      }
      return await this.markFailed(row.id, failure.error, attemptCount) ? 'failed' : 'lost-lease'
    }

    return await this.markRetrying(row.id, failure.error, attemptCount) ? 'retrying' : 'lost-lease'
  }

  private async markSent(id: string, attemptCount: number): Promise<boolean> {
    const now = this.now().toISOString()
    const result = await this.query(
      `UPDATE attendance_notification_deliveries
          SET status = 'sent',
              delivered_at = $2::timestamptz,
              last_error = NULL,
              claim_expires_at = NULL,
              claim_worker_id = NULL,
              updated_at = $2::timestamptz
        WHERE id = $1::uuid
          AND status = 'sending'
          AND claim_worker_id = $3
          AND attempt_count = $4::int`,
      [id, now, this.workerId, attemptCount],
    )
    return Number(result.rowCount ?? 0) === 1
  }

  private async markRetrying(id: string, error: string, attemptCount: number): Promise<boolean> {
    const now = this.now()
    const next = new Date(now.getTime() + computeDeliveryBackoffMs(attemptCount)).toISOString()
    const result = await this.query(
      `UPDATE attendance_notification_deliveries
          SET status = 'retrying',
              next_attempt_at = $2::timestamptz,
              last_error = $3,
              claim_expires_at = NULL,
              claim_worker_id = NULL,
              updated_at = $4::timestamptz
        WHERE id = $1::uuid
          AND status = 'sending'
          AND claim_worker_id = $5
          AND attempt_count = $6::int`,
      [id, next, error.slice(0, 1000), now.toISOString(), this.workerId, attemptCount],
    )
    return Number(result.rowCount ?? 0) === 1
  }

  private async markFailed(id: string, error: string, attemptCount: number): Promise<boolean> {
    const now = this.now().toISOString()
    const result = await this.query(
      `UPDATE attendance_notification_deliveries
          SET status = 'failed',
              last_error = $2,
              claim_expires_at = NULL,
              claim_worker_id = NULL,
              updated_at = $3::timestamptz
        WHERE id = $1::uuid
          AND status = 'sending'
          AND claim_worker_id = $4
          AND attempt_count = $5::int`,
      [id, error.slice(0, 1000), now, this.workerId, attemptCount],
    )
    return Number(result.rowCount ?? 0) === 1
  }

  // Same terminal-state CAS guard as markFailed (only the lease holder, matching attempt_count, may
  // write) — the only difference is the target status. See the AttendanceDeliveryChannelResult.skip
  // doc comment for why this is a distinct terminal bucket from `failed`.
  private async markSkipped(id: string, error: string, attemptCount: number): Promise<boolean> {
    const now = this.now().toISOString()
    const result = await this.query(
      `UPDATE attendance_notification_deliveries
          SET status = 'skipped',
              last_error = $2,
              claim_expires_at = NULL,
              claim_worker_id = NULL,
              updated_at = $3::timestamptz
        WHERE id = $1::uuid
          AND status = 'sending'
          AND claim_worker_id = $4
          AND attempt_count = $5::int`,
      [id, error.slice(0, 1000), now, this.workerId, attemptCount],
    )
    return Number(result.rowCount ?? 0) === 1
  }
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, unknown> } catch { return {} }
  }
  return value as Record<string, unknown>
}

function normalizePayloadText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function buildDeliveryTitle(message: AttendanceDeliveryMessage): string {
  const title = normalizePayloadText(message.payload.title)
  if (title) return title
  if (message.sourceType === 'comp_time_expiry_reminder') return 'Comp-time expiry reminder'
  if (message.sourceType === 'unscheduled_reminder') return 'Unscheduled shift reminder'
  return 'Attendance notification'
}

function buildDeliveryContent(message: AttendanceDeliveryMessage): string {
  const body = normalizePayloadText(message.payload.body)
  if (body) return body
  const content = normalizePayloadText(message.payload.content)
  if (content) return content
  return `Attendance notification source: ${message.sourceType}`
}

function normalizeErrorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = redactDingTalkErrorText(raw.trim() || fallback)
  return text.length > 240 ? `${text.slice(0, 237)}...` : text
}

function redactDingTalkErrorText(text: string): string {
  const redactedSecrets = text
    .replace(/([?&](?:access_token|accessToken|appkey|appKey|appsecret|appSecret|app_secret|client_secret|clientSecret)=)[^&\s'")]+/gi, '$1[redacted]')
    .replace(/((?:access_token|accessToken|appkey|appKey|appsecret|appSecret|app_secret|client_secret|clientSecret)\s*[:=]\s*)[^&\s'")]+/gi, '$1[redacted]')
  return redactedSecrets.replace(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s'")]*)?/gi, '[redacted-url]')
}

function classifyConfigError(error: unknown): AttendanceDeliveryChannelResult {
  const message = normalizeErrorText(error, 'DingTalk work-notification config unavailable')
  const retryable = !/not configured|required|not found|Agent ID/i.test(message)
  return { ok: false, retryable, error: `dingtalk_work_notification_config_unavailable: ${message}` }
}

function isRetryableDingTalkBusinessError(error: DingTalkBusinessError): boolean {
  const code = readDingTalkErrorNumber(error.responseBody, 'errcode', 'code', 'statusCode', 'status')
  if (code !== null && isRetryableDingTalkErrorCode(code)) return true
  const responseText = typeof error.responseBody?.errmsg === 'string' ? error.responseBody.errmsg : ''
  const message = `${error.message} ${responseText}`.toLowerCase()
  return /rate.?limit|too many|throttl|system busy|server busy|temporar|timeout|timed out|try again|retry|busy|限流|频繁|繁忙|超时|稍后|重试|系统异常|服务异常/i.test(message)
}

function readDingTalkErrorNumber(body: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!body) return null
  for (const key of keys) {
    const value = body[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Number(value))) {
      return Number(value)
    }
  }
  return null
}

function isRetryableDingTalkErrorCode(code: number): boolean {
  return code === 408 || code === 429 || (code >= 500 && code < 600) || code === 50001
}

function classifyDingTalkSendError(error: unknown): AttendanceDeliveryChannelResult {
  if (error instanceof DingTalkRequestError) {
    return {
      ok: false,
      retryable: isRetryableDingTalkErrorCode(error.statusCode),
      error: `dingtalk_request_${error.statusCode}: ${normalizeErrorText(error, 'DingTalk request failed')}`,
    }
  }
  if (error instanceof DingTalkBusinessError) {
    return {
      ok: false,
      retryable: isRetryableDingTalkBusinessError(error),
      error: `dingtalk_business_error: ${normalizeErrorText(error, 'DingTalk business error')}`,
    }
  }
  return {
    ok: false,
    retryable: true,
    error: `dingtalk_send_failed: ${normalizeErrorText(error, 'DingTalk send failed')}`,
  }
}

// ── WeCom error classification + redaction (design-lock G6) ────────────────────────────────────
// Distinct bucketing from DingTalk's (different error-code space, different retry semantics):
//  - retryable: HTTP transport error / timeout / 5xx, {42001,40014} (token-expired, but ONLY after
//    the channel's own single invalidate+retry already ran — see WeComAttendanceDeliveryChannel.send),
//    {45009,45033} (rate/concurrency limited).
//  - structural skip (undeliverable to THIS recipient, not an operator fault): {81013,82001,40003}.
//  - permanent config fault (worth operator attention, NOT skipped — dead-letter): {41001,40056,60020}
//    plus "not configured" config-read failures.
//  - any other/unrecognized WeCom business error: permanent, non-retryable (mirrors DingTalk's
//    conservative default — do not spin forever against an unclassified business rule violation).
const WECOM_RATE_LIMIT_ERRCODES: ReadonlySet<number> = new Set([45009, 45033])
const WECOM_STRUCTURAL_SKIP_ERRCODES: ReadonlySet<number> = new Set([81013, 82001, 40003])
const WECOM_PERMANENT_CONFIG_ERRCODES: ReadonlySet<number> = new Set([41001, 40056, 60020])

function isRetryableWeComRequestStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode < 600)
}

function redactWeComErrorText(text: string): string {
  const redactedSecrets = text
    .replace(/([?&](?:corpsecret|access_token|accessToken)=)[^&\s'")]+/gi, '$1[redacted]')
    .replace(/((?:corpsecret|access_token|accessToken)\s*[:=]\s*)[^&\s'")]+/gi, '$1[redacted]')
  return redactedSecrets.replace(/(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s'")]*)?/gi, '[redacted-url]')
}

function normalizeWeComErrorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = redactWeComErrorText(raw.trim() || fallback)
  return text.length > 240 ? `${text.slice(0, 237)}...` : text
}

function classifyWeComConfigError(error: unknown): AttendanceDeliveryChannelResult {
  const message = normalizeWeComErrorText(error, 'WeCom work-notification config unavailable')
  const retryable = !/not configured/i.test(message)
  return { ok: false, retryable, error: `wecom_work_notification_config_unavailable: ${message}` }
}

function classifyWeComSendError(error: unknown): AttendanceDeliveryChannelResult {
  if (error instanceof WeComRequestError) {
    return {
      ok: false,
      retryable: isRetryableWeComRequestStatus(error.statusCode),
      error: `wecom_request_${error.statusCode}: ${normalizeWeComErrorText(error, 'WeCom request failed')}`,
    }
  }
  if (error instanceof WeComBusinessError) {
    const code = error.errcode
    if (WECOM_STRUCTURAL_SKIP_ERRCODES.has(code)) {
      return {
        ok: false,
        retryable: false,
        skip: true,
        error: `wecom_business_error_${code}: ${normalizeWeComErrorText(error, 'WeCom business error')}`,
      }
    }
    if (WECOM_RATE_LIMIT_ERRCODES.has(code) || WECOM_TOKEN_EXPIRED_ERRCODES.has(code)) {
      return {
        ok: false,
        retryable: true,
        error: `wecom_business_error_${code}: ${normalizeWeComErrorText(error, 'WeCom business error')}`,
      }
    }
    // WECOM_PERMANENT_CONFIG_ERRCODES (41001/40056/60020) and any OTHER unrecognized WeCom business
    // error both land here: permanent, non-retryable, NOT skipped (worth an operator's attention —
    // dead-lettered, never silently dropped). The explicit set membership check keeps the design-lock's
    // G6 bucket boundaries visible in the persisted error text rather than relying on elimination.
    const label = WECOM_PERMANENT_CONFIG_ERRCODES.has(code) ? 'WeCom permanent config error' : 'WeCom business error'
    return {
      ok: false,
      retryable: false,
      error: `wecom_business_error_${code}: ${normalizeWeComErrorText(error, label)}`,
    }
  }
  return {
    ok: false,
    retryable: true,
    error: `wecom_send_failed: ${normalizeWeComErrorText(error, 'WeCom send failed')}`,
  }
}

// ── Email (SMTP) delivery channel ───────────────────────────────────────────────
// A second AttendanceDeliveryChannel beside the in-app work-notification channel. Sends the SAME
// delivery content over SMTP, reusing the app's existing email transport config + readiness. Env-gated
// + default-off (see createAttendanceDeliveryChannelsFromEnv). Recipient email resolved from users.email.

export interface EmailDeliveryTransport {
  sendMail(options: {
    from: string
    to: string
    subject: string
    text: string
    headers?: Record<string, string>
  }): Promise<unknown>
}

export interface EmailAttendanceDeliveryChannelOptions {
  query?: AttendanceNotificationDeliveryQuery
  env?: NodeJS.ProcessEnv
  createTransport?: (config: EmailSmtpTransportConfig) => EmailDeliveryTransport
}

function defaultEmailTransportFactory(config: EmailSmtpTransportConfig): EmailDeliveryTransport {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.authUser, pass: config.authPass },
    connectionTimeout: config.connectionTimeoutMs,
    greetingTimeout: config.greetingTimeoutMs,
  }) as unknown as EmailDeliveryTransport
}

export class EmailAttendanceDeliveryChannel implements AttendanceDeliveryChannel {
  readonly name = EMAIL_SMTP_CHANNEL_NAME
  private readonly query: AttendanceNotificationDeliveryQuery
  private readonly env: NodeJS.ProcessEnv
  private readonly createTransport: (config: EmailSmtpTransportConfig) => EmailDeliveryTransport
  private transport: EmailDeliveryTransport | null = null

  constructor(options: EmailAttendanceDeliveryChannelOptions = {}) {
    this.query = options.query ?? (defaultQuery as AttendanceNotificationDeliveryQuery)
    this.env = options.env ?? process.env
    this.createTransport = options.createTransport ?? defaultEmailTransportFactory
  }

  async send(message: AttendanceDeliveryMessage): Promise<AttendanceDeliveryChannelResult> {
    // 1. Resolve recipient email — STRICTLY scoped to the delivery's org (tenant boundary). The user
    //    must be active AND an active member of message.orgId. Email is EXTERNAL egress, so this is
    //    fail-closed: the producer / deliveries table does not prove recipient↔org membership, so a
    //    bare `users.id` lookup could send cross-tenant. No matching active org-member row → permanent
    //    (non-retryable), do NOT send. A lookup error is transient (retryable); no row (missing email /
    //    inactive user / not a member of this org) is permanent (dead-letter, no spin).
    let email: string
    try {
      const { rows } = await this.query<{ email: string | null }>(
        `SELECT u.email
           FROM users u
           JOIN user_orgs uo ON uo.user_id = u.id AND uo.org_id = $2 AND uo.is_active = true
          WHERE u.id = $1 AND u.is_active = true`,
        [message.recipientUserId, message.orgId],
      )
      email = (rows[0]?.email ?? '').trim()
    } catch (error) {
      return { ok: false, retryable: true, error: `email_recipient_lookup_failed: ${normalizeEmailErrorText(error, 'recipient lookup failed', this.env)}` }
    }
    if (!email) {
      return { ok: false, retryable: false, error: 'email_recipient_unresolved: no active org-member email for this recipient in the delivery org' }
    }

    // 2. Resolve SMTP config. resolveEmailSmtpTransportConfig throws when transport is not smtp-mode or
    //    readiness is blocked → a permanent config error (non-retryable).
    let config: EmailSmtpTransportConfig
    try {
      config = resolveEmailSmtpTransportConfig(this.env)
    } catch (error) {
      return { ok: false, retryable: false, error: `email_smtp_config_unavailable: ${normalizeEmailErrorText(error, 'SMTP config unavailable', this.env)}` }
    }

    // 3. Send. Subject/body come from the SHARED content helpers (one content source; no per-channel drift).
    try {
      const transport = this.transport ?? this.createTransport(config)
      this.transport = transport
      await transport.sendMail({
        from: config.from,
        to: email,
        subject: buildDeliveryTitle(message),
        text: buildDeliveryContent(message),
        headers: {
          'X-MetaSheet-Notification-Channel': EMAIL_SMTP_CHANNEL_NAME,
          'X-MetaSheet-Notification-Source': message.sourceType,
        },
      })
      return { ok: true }
    } catch (error) {
      return classifyEmailSendError(error, this.env)
    }
  }
}

function normalizeEmailErrorText(error: unknown, fallback: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  // Scrub the configured SMTP host/user/password/from + token/password patterns — the password could
  // otherwise surface verbatim in an SMTP transport error string written to the delivery record.
  const text = redactEmailTransportText(raw.trim() || fallback, env)
  return text.length > 240 ? `${text.slice(0, 237)}...` : text
}

function classifyEmailSendError(error: unknown, env: NodeJS.ProcessEnv = process.env): AttendanceDeliveryChannelResult {
  const responseCode =
    typeof (error as { responseCode?: unknown } | null)?.responseCode === 'number'
      ? (error as { responseCode: number }).responseCode
      : null
  const code =
    typeof (error as { code?: unknown } | null)?.code === 'string'
      ? (error as { code: string }).code.toUpperCase()
      : ''
  let retryable: boolean
  if (responseCode !== null) {
    // SMTP reply codes: 4xx = transient (greylist / rate / try-later) → retry; 5xx = permanent → dead-letter.
    retryable = responseCode >= 400 && responseCode < 500
  } else if (/^(ECONNREFUSED|ETIMEDOUT|ESOCKET|ECONNRESET|ENOTFOUND|EDNS|ECONNECTION|ETLS|EHOSTUNREACH|EPIPE)$/.test(code)) {
    retryable = true
  } else if (/^(EAUTH|EENVELOPE|EMESSAGE)$/.test(code)) {
    retryable = false
  } else {
    // Unknown failure: retry (bounded by the worker's max-attempts → dead-letter); never silently drop.
    retryable = true
  }
  const suffix = responseCode !== null ? `_${responseCode}` : code ? `_${code.toLowerCase()}` : ''
  return { ok: false, retryable, error: `email_send_failed${suffix}: ${normalizeEmailErrorText(error, 'email send failed', env)}` }
}
