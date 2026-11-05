/**
 * Delivery-result truthfulness — channel matrix, the single outcome mapping, and the production-default
 * (Class-B flag OFF) end-to-end path from a REAL `NotificationServiceImpl` through the REAL
 * `AutomationExecutor` legacy send_email mapping.
 *
 * Invariant under test: `sent` is returned only after a transport / provider accepted every addressed
 * recipient (at least one); a development simulation reports `simulated` and touches no transport; a
 * not-attempted send (no recipient of the channel's type, transport disabled) reports `cancelled`;
 * configuration and transport failures stay `failed`; a channel with no sender reports `failed`.
 * No consumer counts anything but `sent` as a send.
 *
 * Every case that constructs an email channel injects BOTH `env` and a tripwire `smtpTransportFactory`,
 * so the outcome never depends on the process environment and no real SMTP connection can be opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Logger } from '../../src/core/logger'
import { EventBus } from '../../src/integration/events/event-bus'
import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { isTargetRecordMissingSkippedExecution } from '../../src/multitable/automation-retry-eligibility'
import {
  createAttendanceDeliveryChannelsFromEnv,
  EMAIL_SMTP_CHANNEL_NAME,
} from '../../src/services/AttendanceNotificationDeliveryWorker'
import { EMAIL_TRANSPORT_ENV, resolveEmailTransportReadiness } from '../../src/services/email-transport-readiness'
import {
  EmailNotificationChannel,
  FeishuNotificationChannel,
  NotificationServiceImpl,
  WebhookNotificationChannel,
} from '../../src/services/NotificationService'
import {
  NOTIFICATION_NO_CHANNEL_RECIPIENTS_REASON,
  NOTIFICATION_TRANSPORT_DISABLED_REASON,
  NOTIFICATION_TRANSPORT_NOT_CONFIGURED_REASON,
  SEND_EMAIL_OUTCOME_REASONS,
  isSendEmailOutcomeReason,
  mapSendEmailDeliveryOutcome,
} from '../../src/services/notification-delivery-outcome'
import type { Notification, NotificationRecipient, NotificationResult } from '../../src/types/plugin'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const afterSalesAdapter = require('../../../../plugins/plugin-after-sales/lib/notification-adapter.cjs') as {
  sendTopicNotification: (context: Record<string, unknown>, input: Record<string, unknown>) => Promise<Array<{ channel: string; result: NotificationResult }>>
}

const COMPLETE_SMTP_ENV = {
  [EMAIL_TRANSPORT_ENV]: 'smtp',
  MULTITABLE_EMAIL_SMTP_HOST: 'smtp.example.com',
  MULTITABLE_EMAIL_SMTP_PORT: '587',
  MULTITABLE_EMAIL_SMTP_USER: 'smtp-user',
  MULTITABLE_EMAIL_SMTP_PASSWORD: 'smtp-password-secret',
  MULTITABLE_EMAIL_SMTP_FROM: 'ops@example.com',
}
const CLASSB_FLAG = 'AUTOMATION_CLASSB_OUTBOUND_ENABLED'

const EMAIL_RECIPIENT: NotificationRecipient = { id: 'ops@example.com', type: 'email' }
const SECOND_RECIPIENT: NotificationRecipient = { id: 'owner@example.com', type: 'email' }
const USER_RECIPIENT: NotificationRecipient = { id: 'user_1', type: 'user' }

function emailNotification(recipients: NotificationRecipient[]): Notification {
  return { channel: 'email', subject: 'Subject', content: 'Body', recipients }
}

/** A transport factory that must never be reached; calling it fails the test. */
function tripwireFactory() {
  const createTransport = vi.fn(() => { throw new Error('tripwire: smtp transport factory must not be called') })
  return { factory: { createTransport }, createTransport }
}

function emailChannel(env: Record<string, string>) {
  const { factory, createTransport } = tripwireFactory()
  return { channel: new EmailNotificationChannel({ env, smtpTransportFactory: factory }), createTransport }
}

function smtpChannel(sendMail: ReturnType<typeof vi.fn>, env: Record<string, string> = COMPLETE_SMTP_ENV) {
  const createTransport = vi.fn(() => ({ sendMail }))
  return { channel: new EmailNotificationChannel({ env, smtpTransportFactory: { createTransport } }), createTransport }
}

/** A real service whose default email channel is replaced by an env-controlled, tripwired one. */
function serviceWithEmailEnv(env: Record<string, string>) {
  const service = new NotificationServiceImpl()
  const { channel, createTransport } = emailChannel(env)
  service.registerChannel(channel)
  return { service, createTransport }
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'info').mockImplementation(() => undefined)
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
  delete process.env[CLASSB_FLAG]
})
afterEach(() => {
  delete process.env[CLASSB_FLAG]
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('EmailNotificationChannel — result matrix', () => {
  it('U1 no transport env: simulated, mock transport, no factory call, never sent', async () => {
    const { channel, createTransport } = emailChannel({})
    const result = await channel.sender(emailNotification([EMAIL_RECIPIENT]), [EMAIL_RECIPIENT])
    expect(result.status).toBe('simulated')
    expect(result.sentAt).toBeUndefined()
    expect(result.metadata).toEqual({ channel: 'email', transport: 'mock', reason: 'transport_simulated', recipientCount: 1 })
    expect(createTransport).not.toHaveBeenCalled()
  })

  it('U2 explicit mock: same as unset', async () => {
    const { channel, createTransport } = emailChannel({ [EMAIL_TRANSPORT_ENV]: 'mock' })
    const result = await channel.sender(emailNotification([EMAIL_RECIPIENT]), [EMAIL_RECIPIENT])
    expect(result.status).toBe('simulated')
    expect(result.metadata).toMatchObject({ transport: 'mock', recipientCount: 1 })
    expect(createTransport).not.toHaveBeenCalled()
  })

  it('U3 disabled / off: cancelled with transport_disabled, no factory call; readiness is its own mode with its own message', async () => {
    for (const value of ['disabled', 'off', 'OFF']) {
      const { channel, createTransport } = emailChannel({ [EMAIL_TRANSPORT_ENV]: value })
      const result = await channel.sender(emailNotification([EMAIL_RECIPIENT]), [EMAIL_RECIPIENT])
      expect(result.status).toBe('cancelled')
      expect(result.metadata).toEqual({ channel: 'email', transport: 'disabled', reason: NOTIFICATION_TRANSPORT_DISABLED_REASON, recipientCount: 1 })
      expect(createTransport).not.toHaveBeenCalled()

      const readiness = resolveEmailTransportReadiness({ [EMAIL_TRANSPORT_ENV]: value })
      expect(readiness.mode).toBe('disabled')
      expect(readiness.ok).toBe(true)
      expect(readiness.status).toBe('pass')
      expect(readiness.messages.join('\n')).toContain('disabled')
      expect(readiness.messages.join('\n')).not.toContain('SMTP transport env is present')
      expect(readiness.messages.join('\n')).not.toContain('mock')
    }
  })

  it('U3b the unsupported-mode message lists every accepted value, including disabled and off', () => {
    const readiness = resolveEmailTransportReadiness({ [EMAIL_TRANSPORT_ENV]: 'sendgrid' })
    expect(readiness.mode).toBe('unsupported')
    expect(readiness.ok).toBe(false)
    for (const literal of ['"mock"', '"disabled"', '"off"', '"smtp"']) {
      expect(readiness.messages.join('\n')).toContain(literal)
    }
  })

  it('U4 incomplete SMTP (host only): failed; the reason names the missing env NAMES and no value', async () => {
    const { channel, createTransport } = emailChannel({ [EMAIL_TRANSPORT_ENV]: 'smtp', MULTITABLE_EMAIL_SMTP_HOST: 'smtp.example.com' })
    const result = await channel.sender(emailNotification([EMAIL_RECIPIENT]), [EMAIL_RECIPIENT])
    expect(result.status).toBe('failed')
    for (const name of ['MULTITABLE_EMAIL_SMTP_PORT', 'MULTITABLE_EMAIL_SMTP_USER', 'MULTITABLE_EMAIL_SMTP_PASSWORD', 'MULTITABLE_EMAIL_SMTP_FROM']) {
      expect(result.failedReason).toContain(name)
    }
    expect(result.failedReason).not.toContain('smtp.example.com')
    expect(result.metadata).toMatchObject({ recipientCount: 1, acceptedCount: 0 })
    expect(createTransport).not.toHaveBeenCalled()
  })

  it('U5 unsupported mode literal: failed, no factory call', async () => {
    const { channel, createTransport } = emailChannel({ [EMAIL_TRANSPORT_ENV]: 'sendgrid' })
    const result = await channel.sender(emailNotification([EMAIL_RECIPIENT]), [EMAIL_RECIPIENT])
    expect(result.status).toBe('failed')
    expect(result.failedReason).toContain('unsupported')
    expect(createTransport).not.toHaveBeenCalled()
  })

  it('U6 zero email-type recipients: cancelled / no_channel_recipients / recipientCount 0 in mock AND in complete smtp (sendMail untouched)', async () => {
    const mock = emailChannel({})
    const mockResult = await mock.channel.sender(emailNotification([USER_RECIPIENT]), [USER_RECIPIENT])
    expect(mockResult.status).toBe('cancelled')
    expect(mockResult.metadata).toEqual({ channel: 'email', reason: NOTIFICATION_NO_CHANNEL_RECIPIENTS_REASON, recipientCount: 0 })

    const sendMail = vi.fn(async () => ({ messageId: 'never' }))
    const smtp = smtpChannel(sendMail)
    const smtpResult = await smtp.channel.sender(emailNotification([USER_RECIPIENT]), [USER_RECIPIENT])
    expect(smtpResult.status).toBe('cancelled')
    expect(smtpResult.metadata).toEqual({ channel: 'email', reason: NOTIFICATION_NO_CHANNEL_RECIPIENTS_REASON, recipientCount: 0 })
    expect(smtp.createTransport).not.toHaveBeenCalled()
    expect(sendMail).not.toHaveBeenCalled()

    const empty = await smtp.channel.sender(emailNotification([]), [])
    expect(empty.status).toBe('cancelled')
  })

  it('U7 partial failure (second sendMail rejects): failed, recipientCount 2, acceptedCount 1, reason redacted', async () => {
    const sendMail = vi.fn()
      .mockResolvedValueOnce({ messageId: 'msg_1' })
      .mockRejectedValueOnce(new Error('relay refused for smtp-user with smtp-password-secret'))
    const { channel } = smtpChannel(sendMail)
    const result = await channel.sender(emailNotification([EMAIL_RECIPIENT, SECOND_RECIPIENT]), [EMAIL_RECIPIENT, SECOND_RECIPIENT])
    expect(result.status).toBe('failed')
    expect(result.metadata).toEqual({ channel: 'email', recipientCount: 2, acceptedCount: 1 })
    expect(result.failedReason).toContain('relay refused')
    expect(result.failedReason).not.toContain('smtp-user')
    expect(result.failedReason).not.toContain('smtp-password-secret')
    expect(sendMail).toHaveBeenCalledTimes(2)
  })

  it('U7b every recipient accepted: sent with recipientCount === acceptedCount and a sentAt', async () => {
    const sendMail = vi.fn(async () => ({ messageId: 'msg' }))
    const { channel } = smtpChannel(sendMail)
    const result = await channel.sender(emailNotification([EMAIL_RECIPIENT, SECOND_RECIPIENT]), [EMAIL_RECIPIENT, SECOND_RECIPIENT])
    expect(result.status).toBe('sent')
    expect(result.sentAt).toBeInstanceOf(Date)
    expect(result.metadata).toEqual({ channel: 'email', transport: 'smtp', recipientCount: 2, acceptedCount: 2 })
  })

  it('U8 transport error on the only recipient (timeout-shaped): failed, acceptedCount 0; the mapping fails closed to outcome_unknown', async () => {
    const sendMail = vi.fn(async () => { throw new Error('Connection timeout') })
    const { channel } = smtpChannel(sendMail)
    const result = await channel.sender(emailNotification([EMAIL_RECIPIENT]), [EMAIL_RECIPIENT])
    expect(result.status).toBe('failed')
    expect(result.metadata).toMatchObject({ recipientCount: 1, acceptedCount: 0 })
    expect(mapSendEmailDeliveryOutcome(result)).toEqual({ outcome: 'outcome_unknown', reason: 'email_send_failed' })
  })
})

describe('other channels', () => {
  it('U9 Feishu channel with no sender: failed / transport_not_configured, no sleep, never sent', async () => {
    vi.useFakeTimers()
    const channel = new FeishuNotificationChannel({})
    // Not advancing the fake clock: a pending timer would leave this promise unresolved and time the test out.
    const result = await channel.sender({ channel: 'feishu', subject: 'S', content: 'C', recipients: [USER_RECIPIENT] }, [USER_RECIPIENT])
    expect(result.status).toBe('failed')
    expect(result.sentAt).toBeUndefined()
    expect(result.metadata).toEqual({ channel: 'feishu', reason: NOTIFICATION_TRANSPORT_NOT_CONFIGURED_REASON, recipientCount: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('U10 webhook channel with zero webhook-type recipients: cancelled, no fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('fetch must not be called') })
    const channel = new WebhookNotificationChannel({})
    const result = await channel.sender({ channel: 'webhook', subject: 'S', content: 'C', recipients: [USER_RECIPIENT] }, [USER_RECIPIENT])
    expect(result.status).toBe('cancelled')
    expect(result.metadata).toEqual({ channel: 'webhook', reason: NOTIFICATION_NO_CHANNEL_RECIPIENTS_REASON, recipientCount: 0 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('NotificationServiceImpl end to end', () => {
  it('U11 send() with the env-controlled mock email channel returns simulated and records it in history; no factory call', async () => {
    const { service, createTransport } = serviceWithEmailEnv({})
    const result = await service.send(emailNotification([EMAIL_RECIPIENT]))
    expect(result.status).toBe('simulated')
    expect(createTransport).not.toHaveBeenCalled()
    const history = await service.getHistory({ status: 'simulated' })
    expect(history).toHaveLength(1)
    expect(history[0]?.result.status).toBe('simulated')
    expect(await service.getHistory({ status: 'sent' })).toHaveLength(0)
  })

  it('U14 after-sales adapter over the real service: feishu failed, email simulated, nothing sent', async () => {
    const { service, createTransport } = serviceWithEmailEnv({})
    const results = await afterSalesAdapter.sendTopicNotification(
      { services: { notification: service } },
      {
        topic: 'after-sales.approval.pending',
        payload: { subject: 'Refund approval pending' },
        roleRecipients: {
          finance: [{ id: 'finance@example.com', type: 'email' }],
          supervisor: [{ id: 'user_42', type: 'user' }],
        },
      },
    )
    expect(results.map((entry) => [entry.channel, entry.result.status])).toEqual([
      ['feishu', 'failed'],
      ['email', 'simulated'],
    ])
    expect(results.some((entry) => entry.result.status === 'sent')).toBe(false)
    expect(createTransport).not.toHaveBeenCalled()
  })
})

describe('attendance delivery worker channel registration (independent path, must not regress)', () => {
  it('U15 disabled mode with the email flag on registers no email channel, exactly like mock', () => {
    for (const mode of ['disabled', 'off', 'mock']) {
      const channels = createAttendanceDeliveryChannelsFromEnv({
        ATTENDANCE_NOTIFICATION_EMAIL_ENABLED: 'true',
        [EMAIL_TRANSPORT_ENV]: mode,
      } as NodeJS.ProcessEnv)
      expect(channels.some((c) => c.name === EMAIL_SMTP_CHANNEL_NAME)).toBe(false)
    }
  })
})

describe('mapSendEmailDeliveryOutcome — one closed token set for every consumer', () => {
  const r = (status: string, reason?: string): Pick<NotificationResult, 'status' | 'metadata'> =>
    ({ status: status as NotificationResult['status'], metadata: reason ? { reason } : undefined })

  it('covers every status literal of the contract with a token from the closed set', () => {
    expect(mapSendEmailDeliveryOutcome(r('sent'))).toEqual({ outcome: 'sent', reason: 'sent' })
    expect(mapSendEmailDeliveryOutcome(r('simulated', 'transport_simulated'))).toEqual({ outcome: 'failed', reason: 'email_transport_simulated' })
    expect(mapSendEmailDeliveryOutcome(r('cancelled', 'transport_disabled'))).toEqual({ outcome: 'failed', reason: 'email_transport_disabled' })
    expect(mapSendEmailDeliveryOutcome(r('cancelled', 'no_channel_recipients'))).toEqual({ outcome: 'failed', reason: 'email_no_recipients' })
    expect(mapSendEmailDeliveryOutcome(r('cancelled', 'No recipients after preference filtering'))).toEqual({ outcome: 'failed', reason: 'email_no_recipients' })
    expect(mapSendEmailDeliveryOutcome(r('cancelled'))).toEqual({ outcome: 'failed', reason: 'email_no_recipients' })
    expect(mapSendEmailDeliveryOutcome(r('failed'))).toEqual({ outcome: 'outcome_unknown', reason: 'email_send_failed' })
    expect(mapSendEmailDeliveryOutcome(r('pending'))).toEqual({ outcome: 'outcome_unknown', reason: 'email_result_unrecognized' })
    expect(mapSendEmailDeliveryOutcome(r('scheduled'))).toEqual({ outcome: 'outcome_unknown', reason: 'email_result_unrecognized' })
  })

  it('fails closed on an unknown status literal (never sent, never the retryable failed)', () => {
    for (const bogus of ['delivered', 'ok', 'SENT', '', 'accepted']) {
      expect(mapSendEmailDeliveryOutcome(r(bogus))).toEqual({ outcome: 'outcome_unknown', reason: 'email_result_unrecognized' })
    }
  })

  it('the token set is closed: every mapped reason is a member, and the member list is exactly the documented seven', () => {
    expect(Object.values(SEND_EMAIL_OUTCOME_REASONS).sort()).toEqual([
      'email_no_recipients',
      'email_result_unrecognized',
      'email_send_failed',
      'email_send_threw',
      'email_transport_disabled',
      'email_transport_simulated',
      'sent',
    ])
    for (const status of ['sent', 'simulated', 'cancelled', 'failed', 'pending', 'scheduled', 'bogus']) {
      expect(isSendEmailOutcomeReason(mapSendEmailDeliveryOutcome(r(status)).reason)).toBe(true)
    }
    expect(isSendEmailOutcomeReason('transport_simulated')).toBe(false)
    expect(isSendEmailOutcomeReason(undefined)).toBe(false)
  })
})

// ── F2: production default (Class-B flag OFF) — REAL channel → REAL service → REAL executor legacy mapping ──

function emailRule(): AutomationRule {
  return {
    id: 'rule_delivery_truth', name: 'send_email rule', sheetId: 'sheet_1',
    trigger: { type: 'record.created', config: {} },
    actions: [{ type: 'send_email', config: { recipients: ['ops@example.test', 'owner@example.test'], subjectTemplate: 'Subject', bodyTemplate: 'Body' } }] as never,
    enabled: true, createdBy: 'user_1', createdAt: '2026-01-01T00:00:00Z',
  } as AutomationRule
}
const TRIGGER = { recordId: 'rec_1', sheetId: 'sheet_1', actorId: 'user_1', data: { title: 'X' } }

function executorOver(service: NotificationServiceImpl) {
  const queryFn = vi.fn(async (sql: string) => {
    if (/meta_automation_outbound_intent/i.test(String(sql))) throw new Error('ledger must not be touched with the flag off')
    return { rows: [], rowCount: 1 }
  }) as unknown as AutomationDeps['queryFn']
  return new AutomationExecutor({ eventBus: new EventBus(), queryFn, notificationService: service })
}

describe('production default path: real NotificationServiceImpl → real AutomationExecutor legacy send_email', () => {
  it('mock transport: step skipped (not success), notificationStatus simulated, shared reason token, execution skipped, tripwire never called', async () => {
    const { service, createTransport } = serviceWithEmailEnv({})
    const execution = await executorOver(service).execute(emailRule(), TRIGGER, undefined, 'exec_root_truth_mock')
    expect(execution.status).toBe('skipped')
    expect(execution.steps).toHaveLength(1)
    expect(execution.steps[0]?.status).toBe('skipped')
    expect(execution.steps[0]?.output).toMatchObject({
      outcome: 'not_sent',
      reason: 'email_transport_simulated',
      notificationStatus: 'simulated',
      recipientCount: 2,
    })
    expect(createTransport).not.toHaveBeenCalled()
    expect(isTargetRecordMissingSkippedExecution(execution)).toBe(false)
  })

  it('disabled transport: step skipped, notificationStatus cancelled, email_transport_disabled, execution skipped, tripwire never called', async () => {
    const { service, createTransport } = serviceWithEmailEnv({ [EMAIL_TRANSPORT_ENV]: 'disabled' })
    const execution = await executorOver(service).execute(emailRule(), TRIGGER, undefined, 'exec_root_truth_disabled')
    expect(execution.status).toBe('skipped')
    expect(execution.steps[0]?.status).toBe('skipped')
    expect(execution.steps[0]?.output).toMatchObject({
      outcome: 'not_sent',
      reason: 'email_transport_disabled',
      notificationStatus: 'cancelled',
      recipientCount: 2,
    })
    expect(createTransport).not.toHaveBeenCalled()
  })

  it('complete smtp with an accepting injected transport: step success, notificationStatus sent, one sendMail per recipient', async () => {
    const service = new NotificationServiceImpl()
    const sendMail = vi.fn(async () => ({ messageId: 'msg' }))
    service.registerChannel(smtpChannel(sendMail).channel)
    const execution = await executorOver(service).execute(emailRule(), TRIGGER, undefined, 'exec_root_truth_smtp')
    expect(execution.status).toBe('success')
    expect(execution.steps[0]?.status).toBe('success')
    expect(execution.steps[0]?.output).toMatchObject({ notificationStatus: 'sent', recipientCount: 2 })
    expect(sendMail).toHaveBeenCalledTimes(2)
  })

  it('a skipped send_email step does not stop a dependent action (chain behaviour unchanged for development runs)', async () => {
    const { service } = serviceWithEmailEnv({})
    const rule = emailRule()
    rule.actions = [
      ...rule.actions,
      { type: 'send_email', config: { recipients: ['ops@example.test'], subjectTemplate: 'S2', bodyTemplate: 'B2' } } as never,
    ]
    const execution = await executorOver(service).execute(rule, TRIGGER, undefined, 'exec_root_truth_chain')
    expect(execution.steps.map((s) => s.status)).toEqual(['skipped', 'skipped'])
    expect(execution.status).toBe('skipped')
  })
})
