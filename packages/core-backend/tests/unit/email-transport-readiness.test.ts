import { describe, expect, it, vi } from 'vitest'
import { Logger } from '../../src/core/logger'
import {
  EMAIL_CONFIRM_SEND_ENV,
  EMAIL_REAL_SEND_SMOKE_ENV,
  EMAIL_SMTP_REQUIRED_ENV,
  EMAIL_TRANSPORT_ENV,
  redactEmailTransportValue,
  renderEmailTransportReadinessMarkdown,
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

  it('fails controlled when smtp transport is explicitly requested before SMTP implementation lands', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const channel = new EmailNotificationChannel({ env: COMPLETE_SMTP_ENV })

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
    expect(result.failedReason).toContain('SMTP email transport is configured but not implemented')
  })
})
