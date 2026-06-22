/**
 * S1 — Email (SMTP) attendance delivery channel (design-lock: attendance-notification-email-channel-designlock-20260621).
 * Unit-level: query + transport + env are injected (no real DB / no real SMTP). Covers recipient
 * resolution, failure classification (retryable vs permanent), PII scrub, and the env-gate registration.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  EmailAttendanceDeliveryChannel,
  EMAIL_SMTP_CHANNEL_NAME,
  DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME,
  createAttendanceDeliveryChannelsFromEnv,
  resolveAttendanceDefaultDeliveryChannel,
  type EmailDeliveryTransport,
  type AttendanceDeliveryMessage,
} from '../../src/services/AttendanceNotificationDeliveryWorker'
import { EMAIL_TRANSPORT_ENV } from '../../src/services/email-transport-readiness'

const READY_SMTP_ENV = {
  [EMAIL_TRANSPORT_ENV]: 'smtp',
  MULTITABLE_EMAIL_SMTP_HOST: 'smtp.example.com',
  MULTITABLE_EMAIL_SMTP_PORT: '587',
  MULTITABLE_EMAIL_SMTP_USER: 'smtp-user',
  MULTITABLE_EMAIL_SMTP_PASSWORD: 'smtp-password-secret',
  MULTITABLE_EMAIL_SMTP_FROM: 'ops@example.com',
} as NodeJS.ProcessEnv

const MESSAGE: AttendanceDeliveryMessage = {
  id: 'dlv1',
  orgId: 'org1',
  sourceType: 'unscheduled_reminder',
  sourceId: 'src1',
  sourceKey: 'key1',
  recipientUserId: 'u1',
  recipientRole: 'member',
  channel: EMAIL_SMTP_CHANNEL_NAME,
  payload: { title: 'Punch reminder', body: 'You have an unscheduled shift today.' },
}

function makeChannel(opts: {
  email?: string | null
  inOrg?: boolean
  queryThrows?: boolean
  sendImpl?: () => Promise<unknown>
  env?: NodeJS.ProcessEnv
}) {
  const sendMail = vi.fn(opts.sendImpl ?? (async () => ({ messageId: 'ok' })))
  const transport: EmailDeliveryTransport = { sendMail }
  // Mock the ORG-SCOPED query: a row is returned only when the recipient is an active member of the
  // delivery's org (inOrg !== false). Mirrors the real SQL JOIN on user_orgs (org-membership gate).
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => {
    if (opts.queryThrows) throw new Error('db connection lost')
    if (opts.inOrg === false) return { rows: [] as Array<{ email: string | null }> }
    return { rows: [{ email: opts.email === undefined ? 'user@example.com' : opts.email }] }
  })
  const channel = new EmailAttendanceDeliveryChannel({
    env: opts.env ?? READY_SMTP_ENV,
    query: query as never,
    createTransport: () => transport,
  })
  return { channel, sendMail, query }
}

describe('EmailAttendanceDeliveryChannel.send', () => {
  it('reached + sent → ok:true; org-scoped lookup; sends shared content to the resolved users.email', async () => {
    const { channel, sendMail, query } = makeChannel({ email: 'user@example.com' })
    const result = await channel.send(MESSAGE)
    expect(result).toEqual({ ok: true })
    // recipient lookup is scoped to the delivery org: params = [recipientUserId, orgId]
    expect(query).toHaveBeenCalledWith(expect.stringContaining('user_orgs'), [MESSAGE.recipientUserId, MESSAGE.orgId])
    expect(sendMail).toHaveBeenCalledTimes(1)
    const sent = sendMail.mock.calls[0][0] as Record<string, string>
    expect(sent.to).toBe('user@example.com')
    expect(sent.from).toBe('ops@example.com')
    expect(sent.subject).toBe('Punch reminder') // buildDeliveryTitle from shared helper
    expect(sent.text).toBe('You have an unscheduled shift today.') // buildDeliveryContent
  })

  it('SECURITY: recipient NOT an active member of the delivery org → permanent, nothing sent (no cross-tenant email)', async () => {
    const { channel, sendMail } = makeChannel({ email: 'user@example.com', inOrg: false })
    const result = await channel.send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect((result as { error: string }).error).toContain('email_recipient_unresolved')
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('user resolvable in org but has no email → permanent (non-retryable), nothing sent', async () => {
    const { channel, sendMail } = makeChannel({ email: null })
    const result = await channel.send(MESSAGE)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect((result as { error: string }).error).toContain('email_recipient_unresolved')
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('recipient lookup throws → transient (retryable), nothing sent', async () => {
    const { channel, sendMail } = makeChannel({ queryThrows: true })
    const result = await channel.send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: true })
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('SMTP not configured (mock-mode env) → permanent config error (non-retryable)', async () => {
    const { channel, sendMail } = makeChannel({ env: {} as NodeJS.ProcessEnv })
    const result = await channel.send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: false })
    expect((result as { error: string }).error).toContain('email_smtp_config_unavailable')
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('transient transport error (ECONNREFUSED) → retryable:true', async () => {
    const { channel } = makeChannel({
      sendImpl: async () => { throw Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }) },
    })
    const result = await channel.send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: true })
  })

  it('permanent SMTP 5xx → retryable:false', async () => {
    const { channel } = makeChannel({
      sendImpl: async () => { throw Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550 }) },
    })
    const result = await channel.send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: false })
  })

  it('SMTP 4xx greylisting → retryable:true', async () => {
    const { channel } = makeChannel({
      sendImpl: async () => { throw Object.assign(new Error('451 try again later'), { responseCode: 451 }) },
    })
    const result = await channel.send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: true })
  })

  it('auth failure (EAUTH) → retryable:false', async () => {
    const { channel } = makeChannel({
      sendImpl: async () => { throw Object.assign(new Error('invalid login'), { code: 'EAUTH' }) },
    })
    const result = await channel.send(MESSAGE)
    expect(result).toMatchObject({ ok: false, retryable: false })
  })

  it('PII scrub: the configured SMTP password never appears in the persisted error', async () => {
    const { channel } = makeChannel({
      sendImpl: async () => { throw new Error('auth failed for smtp-password-secret on smtp.example.com') },
    })
    const result = await channel.send(MESSAGE)
    expect(result.ok).toBe(false)
    const error = (result as { error: string }).error
    expect(error).not.toContain('smtp-password-secret')
    expect(error).toContain('<redacted>')
  })
})

describe('createAttendanceDeliveryChannelsFromEnv — email env-gate', () => {
  it('no email flag → email channel NOT registered', () => {
    const channels = createAttendanceDeliveryChannelsFromEnv({} as NodeJS.ProcessEnv)
    expect(channels.some((c) => c.name === EMAIL_SMTP_CHANNEL_NAME)).toBe(false)
  })

  it('email flag but SMTP NOT ready (missing host) → NOT registered (no spin against unconfigured transport)', () => {
    const channels = createAttendanceDeliveryChannelsFromEnv({
      ATTENDANCE_NOTIFICATION_EMAIL_ENABLED: 'true',
      [EMAIL_TRANSPORT_ENV]: 'smtp',
      // host intentionally omitted → readiness blocked
      MULTITABLE_EMAIL_SMTP_PORT: '587',
      MULTITABLE_EMAIL_SMTP_USER: 'smtp-user',
      MULTITABLE_EMAIL_SMTP_PASSWORD: 'pw',
      MULTITABLE_EMAIL_SMTP_FROM: 'ops@example.com',
    } as NodeJS.ProcessEnv)
    expect(channels.some((c) => c.name === EMAIL_SMTP_CHANNEL_NAME)).toBe(false)
  })

  it('email flag + ready SMTP env → email channel registered', () => {
    const channels = createAttendanceDeliveryChannelsFromEnv({
      ...READY_SMTP_ENV,
      ATTENDANCE_NOTIFICATION_EMAIL_ENABLED: 'true',
    } as NodeJS.ProcessEnv)
    expect(channels.some((c) => c.name === EMAIL_SMTP_CHANNEL_NAME)).toBe(true)
  })

  it('email + in-app channel both enabled → both registered (coexist via name-routing)', () => {
    const channels = createAttendanceDeliveryChannelsFromEnv({
      ...READY_SMTP_ENV,
      ATTENDANCE_NOTIFICATION_EMAIL_ENABLED: 'true',
      ATTENDANCE_NOTIFICATION_DINGTALK_WORK_NOTIFICATION_ENABLED: 'true',
    } as NodeJS.ProcessEnv)
    const names = channels.map((c) => c.name)
    expect(names).toContain(EMAIL_SMTP_CHANNEL_NAME)
    expect(names).toContain(DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME)
  })
})

describe('resolveAttendanceDefaultDeliveryChannel — producer default routing (S2)', () => {
  it('no env → defaults to the in-app work-notification channel (behavior unchanged)', () => {
    expect(resolveAttendanceDefaultDeliveryChannel({} as NodeJS.ProcessEnv)).toBe(DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME)
  })

  it('configured to email_smtp → producers stamp email', () => {
    expect(resolveAttendanceDefaultDeliveryChannel({ ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL: EMAIL_SMTP_CHANNEL_NAME } as NodeJS.ProcessEnv)).toBe(EMAIL_SMTP_CHANNEL_NAME)
  })

  it('configured to the in-app channel explicitly → in-app', () => {
    expect(resolveAttendanceDefaultDeliveryChannel({ ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL: DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME } as NodeJS.ProcessEnv)).toBe(DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME)
  })

  it('unrecognized / empty / injection-shaped value → falls back to default (allowlist guard prevents arbitrary SQL interpolation)', () => {
    expect(resolveAttendanceDefaultDeliveryChannel({ ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL: 'sms' } as NodeJS.ProcessEnv)).toBe(DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME)
    expect(resolveAttendanceDefaultDeliveryChannel({ ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL: '' } as NodeJS.ProcessEnv)).toBe(DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME)
    expect(resolveAttendanceDefaultDeliveryChannel({ ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL: "email_smtp'; DROP TABLE x;--" } as NodeJS.ProcessEnv)).toBe(DINGTALK_WORK_NOTIFICATION_CHANNEL_NAME)
  })
})
