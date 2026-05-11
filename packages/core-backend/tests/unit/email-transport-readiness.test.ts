import { afterEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '../../src/core/logger'
import {
  EMAIL_CONFIRM_SEND_ENV,
  EMAIL_REAL_SEND_SMOKE_ENV,
  EMAIL_SMTP_REQUIRED_ENV,
  EMAIL_TRANSPORT_ENV,
  redactEmailTransportText,
  redactEmailTransportValue,
  renderEmailTransportReadinessMarkdown,
  resolveEmailSmtpTransportConfig,
  resolveEmailTransportReadiness,
} from '../../src/services/email-transport-readiness'
import { EmailNotificationChannel } from '../../src/services/NotificationService'

const COMPLETE_SMTP_ENV = {
  [EMAIL_TRANSPORT_ENV]: 'smtp',
  MULTITABLE_EMAIL_SMTP_HOST: 'smtp.example.com',
  MULTITABLE_EMAIL_SMTP_PORT: '587',
  MULTITABLE_EMAIL_SMTP_USER: 'smtp-user',
  MULTITABLE_EMAIL_SMTP_PASSWORD: 'smtp-password-secret',
  MULTITABLE_EMAIL_SMTP_FROM: 'ops@example.com',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('email transport readiness', () => {
  it('keeps mock email transport as the default', () => {
    const report = resolveEmailTransportReadiness({})

    expect(report.ok).toBe(true)
    expect(report.status).toBe('pass')
    expect(report.mode).toBe('mock')
    expect(report.requiredEnv).toEqual([])
    expect(report.messages.join('\n')).toContain('mock')
  })

  it('blocks smtp transport when required provider env is missing', () => {
    const report = resolveEmailTransportReadiness({
      [EMAIL_TRANSPORT_ENV]: 'smtp',
      MULTITABLE_EMAIL_SMTP_HOST: 'smtp.example.com',
    })

    expect(report.ok).toBe(false)
    expect(report.status).toBe('blocked')
    for (const name of EMAIL_SMTP_REQUIRED_ENV.filter((name) => name !== 'MULTITABLE_EMAIL_SMTP_HOST')) {
      expect(report.messages.join('\n')).toContain(name)
    }
  })

  it('passes smtp readiness when all provider env is present without sending email', () => {
    const report = resolveEmailTransportReadiness(COMPLETE_SMTP_ENV)

    expect(report.ok).toBe(true)
    expect(report.status).toBe('pass')
    expect(report.mode).toBe('smtp')
    expect(report.messages.join('\n')).toContain('does not send email')
  })

  it('blocks smtp readiness when port is invalid', () => {
    const report = resolveEmailTransportReadiness({
      ...COMPLETE_SMTP_ENV,
      MULTITABLE_EMAIL_SMTP_PORT: '70000',
    })

    expect(report.ok).toBe(false)
    expect(report.status).toBe('blocked')
    expect(report.messages.join('\n')).toContain('MULTITABLE_EMAIL_SMTP_PORT')
  })

  it('blocks smtp readiness when optional transport values are invalid', () => {
    const report = resolveEmailTransportReadiness({
      ...COMPLETE_SMTP_ENV,
      MULTITABLE_EMAIL_SMTP_SECURE: 'definitely',
      MULTITABLE_EMAIL_SMTP_CONNECTION_TIMEOUT_MS: '500',
    })

    expect(report.ok).toBe(false)
    expect(report.status).toBe('blocked')
    expect(report.messages.join('\n')).toContain('MULTITABLE_EMAIL_SMTP_SECURE')
    expect(report.messages.join('\n')).toContain('MULTITABLE_EMAIL_SMTP_CONNECTION_TIMEOUT_MS')
  })

  it('resolves SMTP transport config with explicit TLS and timeouts', () => {
    const config = resolveEmailSmtpTransportConfig({
      ...COMPLETE_SMTP_ENV,
      MULTITABLE_EMAIL_SMTP_SECURE: 'true',
      MULTITABLE_EMAIL_SMTP_CONNECTION_TIMEOUT_MS: '15000',
      MULTITABLE_EMAIL_SMTP_GREETING_TIMEOUT_MS: '12000',
    })

    expect(config).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: true,
      authUser: 'smtp-user',
      authPass: 'smtp-password-secret',
      from: 'ops@example.com',
      connectionTimeoutMs: 15000,
      greetingTimeoutMs: 12000,
    })
  })

  it('requires explicit confirmation for real-send smoke requests', () => {
    const report = resolveEmailTransportReadiness({
      ...COMPLETE_SMTP_ENV,
      [EMAIL_REAL_SEND_SMOKE_ENV]: '1',
    })

    expect(report.ok).toBe(false)
    expect(report.status).toBe('blocked')
    expect(report.messages.join('\n')).toContain(`${EMAIL_CONFIRM_SEND_ENV}=1`)
  })

  it('redacts smtp values and bearer-like secrets from markdown reports', () => {
    const report = resolveEmailTransportReadiness({
      ...COMPLETE_SMTP_ENV,
      MULTITABLE_EMAIL_SMTP_HOST: 'smtp://user:pass@smtp.example.com?token=secret-token',
      MULTITABLE_EMAIL_SMTP_PASSWORD: 'Bearer raw-token-value',
      MULTITABLE_EMAIL_SMTP_FROM: 'ops-private@example.com',
      [EMAIL_REAL_SEND_SMOKE_ENV]: '1',
      [EMAIL_CONFIRM_SEND_ENV]: '1',
    })
    const markdown = renderEmailTransportReadinessMarkdown(report)

    expect(markdown).not.toContain('smtp://user:pass@smtp.example.com')
    expect(markdown).not.toContain('secret-token')
    expect(markdown).not.toContain('raw-token-value')
    expect(markdown).not.toContain('ops-private@example.com')
    expect(markdown).toContain('<set>')
  })

  it('redacts individual values defensively', () => {
    expect(redactEmailTransportValue('MULTITABLE_EMAIL_SMTP_PASSWORD', 'Bearer abc.def.ghi')).toBe('<set>')
    expect(redactEmailTransportValue('MULTITABLE_EMAIL_SMTP_PORT', '587')).toBe('587')
  })

  it('redacts SMTP env values and bearer tokens from runtime error text', () => {
    const redacted = redactEmailTransportText(
      'Failed smtp://smtp-user:smtp-password-secret@smtp.example.com?token=secret-token for ops@example.com with Bearer raw-token-value',
      COMPLETE_SMTP_ENV,
    )

    expect(redacted).not.toContain('smtp-user')
    expect(redacted).not.toContain('smtp-password-secret')
    expect(redacted).not.toContain('smtp.example.com')
    expect(redacted).not.toContain('secret-token')
    expect(redacted).not.toContain('ops@example.com')
    expect(redacted).not.toContain('raw-token-value')
  })
})

describe('EmailNotificationChannel transport gate', () => {
  it('sends through the mock channel when transport env is absent', async () => {
    vi.spyOn(Logger.prototype, 'info').mockImplementation(() => undefined)
    const channel = new EmailNotificationChannel({ env: {} })

    const result = await channel.sender(
      {
        channel: 'email',
        subject: 'Mock subject',
        content: 'Mock body',
        recipients: [{ id: 'ops@example.com', type: 'email' }],
      },
      [{ id: 'ops@example.com', type: 'email' }],
    )

    expect(result.status).toBe('sent')
    expect(result.metadata).toEqual(expect.objectContaining({
      channel: 'email',
      recipientCount: 1,
    }))
  })

  it('sends through an injected SMTP transport when smtp mode is configured', async () => {
    const sendMail = vi.fn(async () => ({ messageId: 'msg_1' }))
    const createTransport = vi.fn(() => ({ sendMail }))
    const channel = new EmailNotificationChannel({
      env: COMPLETE_SMTP_ENV,
      smtpTransportFactory: { createTransport },
    })

    const result = await channel.sender(
      {
        channel: 'email',
        subject: 'Real subject',
        content: 'Real body',
        recipients: [{ id: 'ops@example.com', type: 'email' }],
        metadata: {
          source: 'automation',
        },
      },
      [{ id: 'ops@example.com', type: 'email' }],
    )

    expect(result.status).toBe('sent')
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: {
        user: 'smtp-user',
        pass: 'smtp-password-secret',
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
    })
    expect(sendMail).toHaveBeenCalledWith({
      from: 'ops@example.com',
      to: 'ops@example.com',
      subject: 'Real subject',
      text: 'Real body',
      headers: {
        'X-MetaSheet-Notification-Channel': 'email',
        'X-MetaSheet-Notification-Source': 'automation',
      },
    })
  })

  it('fails controlled when smtp transport reports an error and redacts secrets', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const sendMail = vi.fn(async () => {
      throw new Error('SMTP auth failed for smtp-user / smtp-password-secret with Bearer raw-token-value')
    })
    const channel = new EmailNotificationChannel({
      env: COMPLETE_SMTP_ENV,
      smtpTransportFactory: { createTransport: vi.fn(() => ({ sendMail })) },
    })

    const result = await channel.sender(
      {
        channel: 'email',
        subject: 'Real subject',
        content: 'Real body',
        recipients: [{ id: 'ops@example.com', type: 'email' }],
      },
      [{ id: 'ops@example.com', type: 'email' }],
    )

    expect(result.status).toBe('failed')
    expect(result.failedReason).toContain('SMTP auth failed')
    expect(result.failedReason).not.toContain('smtp-user')
    expect(result.failedReason).not.toContain('smtp-password-secret')
    expect(result.failedReason).not.toContain('raw-token-value')
  })
})
