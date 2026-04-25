/**
 * Wave 2 WP5 — email breach channel stub.
 *
 * No SMTP / SES / SendGrid transport currently exists in core-backend
 * (`grep nodemailer|sendgrid|mailgun|transporter` is empty). The task
 * explicitly forbids adding new dependencies for this slice, so the email
 * channel ships as a logging stub: it observes `APPROVAL_BREACH_EMAIL_FROM`
 * + `APPROVAL_BREACH_EMAIL_TO` and emits a structured warn entry per
 * dispatch, but `send()` always resolves to `{ ok: false, error: ... }`.
 *
 * Wiring an actual transport is a follow-up tracked in the dev MD.
 */

import { Logger } from '../../core/logger'
import type {
  BreachChannelResult,
  BreachMessage,
  BreachNotificationChannel,
} from './index'

export interface ApprovalBreachEmailChannelOptions {
  from?: string | null
  to?: string | null
  logger?: Logger
}

export class ApprovalBreachEmailChannel implements BreachNotificationChannel {
  readonly name = 'email'
  private readonly from: string | null
  private readonly to: string | null
  private readonly logger: Logger

  constructor(options: ApprovalBreachEmailChannelOptions = {}) {
    this.logger = options.logger ?? new Logger('ApprovalBreachEmail')
    this.from = trimOrNull(options.from)
    this.to = trimOrNull(options.to)
  }

  async send(message: BreachMessage): Promise<BreachChannelResult> {
    if (!this.from || !this.to) {
      return { ok: false, error: 'email transport not configured' }
    }
    this.logger.warn(
      `Email breach channel stub fired (from=${this.from} to=${this.to} instance=${message.instanceId} title=${message.title})`,
    )
    return { ok: false, error: 'email transport not configured' }
  }
}

function trimOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function createApprovalBreachEmailChannel(
  options: ApprovalBreachEmailChannelOptions = {},
): ApprovalBreachEmailChannel {
  const from = options.from ?? process.env.APPROVAL_BREACH_EMAIL_FROM ?? null
  const to = options.to ?? process.env.APPROVAL_BREACH_EMAIL_TO ?? null
  return new ApprovalBreachEmailChannel({ ...options, from, to })
}
