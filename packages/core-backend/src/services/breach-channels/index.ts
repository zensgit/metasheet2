/**
 * Wave 2 WP5 — SLA breach notification channel contract.
 *
 * Channels are pluggable adapters dispatched in parallel by
 * ApprovalBreachNotifier. A channel that throws or returns `ok: false`
 * does not block sibling channels.
 */

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
