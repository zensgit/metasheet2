/**
 * Wave 2 WP5 — SLA breach notification channel contract.
 *
 * Channels are pluggable adapters dispatched in parallel by
 * ApprovalBreachNotifier. A channel that throws or returns `ok: false`
 * does not block sibling channels.
 */

import { createApprovalBreachDingTalkChannel } from './dingtalk-channel'
import { createApprovalBreachEmailChannel } from './email-channel'

export type BreachSeverity = 'warning' | 'critical'

export interface BreachMessage {
  instanceId: string
  title: string
  body: string
  link: string
  severity: BreachSeverity
}

export interface BreachChannelResult {
  ok: boolean
  error?: string
}

export interface BreachNotificationChannel {
  readonly name: string
  send(message: BreachMessage): Promise<BreachChannelResult>
}

export { ApprovalBreachDingTalkChannel, createApprovalBreachDingTalkChannel } from './dingtalk-channel'
export { ApprovalBreachEmailChannel, createApprovalBreachEmailChannel } from './email-channel'

export function createApprovalBreachChannelsFromEnv(env: NodeJS.ProcessEnv = process.env): BreachNotificationChannel[] {
  const channels: BreachNotificationChannel[] = []
  if (typeof env.APPROVAL_BREACH_DINGTALK_WEBHOOK === 'string' && env.APPROVAL_BREACH_DINGTALK_WEBHOOK.trim().length > 0) {
    channels.push(createApprovalBreachDingTalkChannel({
      webhookUrl: env.APPROVAL_BREACH_DINGTALK_WEBHOOK,
      secret: env.APPROVAL_BREACH_DINGTALK_SECRET,
    }))
  }
  if (
    typeof env.APPROVAL_BREACH_EMAIL_FROM === 'string' &&
    env.APPROVAL_BREACH_EMAIL_FROM.trim().length > 0 &&
    typeof env.APPROVAL_BREACH_EMAIL_TO === 'string' &&
    env.APPROVAL_BREACH_EMAIL_TO.trim().length > 0
  ) {
    channels.push(createApprovalBreachEmailChannel({
      from: env.APPROVAL_BREACH_EMAIL_FROM,
      to: env.APPROVAL_BREACH_EMAIL_TO,
    }))
  }
  return channels
}
