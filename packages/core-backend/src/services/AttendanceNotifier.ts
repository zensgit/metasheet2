/**
 * ④ C4 — AttendanceNotifier scaffold (NO messages in C4).
 *
 * The seam ⑤/C5 reminders will use. C4 builds ONLY the scaffold: the channel interface, an env-gated
 * factory that registers NOTHING by default (channel-env-gating discipline — a default-registered
 * channel produces per-tick warn noise under at-least-once retry), and a no-op dispatch. C4's expiry job
 * does not notify; the reminder job + concrete channels (DingTalk/email) arrive in C5, mirroring
 * ApprovalBreachNotifier.
 */

import { Logger } from '../core/logger'

export interface AttendanceNotificationMessage {
  orgId: string
  userId: string
  kind: string
  text: string
}

export interface AttendanceChannelResult {
  ok: boolean
  error?: string
}

export interface AttendanceNotificationChannel {
  readonly name: string
  send(message: AttendanceNotificationMessage): Promise<AttendanceChannelResult>
}

export interface AttendanceNotifierOptions {
  channels?: AttendanceNotificationChannel[]
  logger?: Logger
}

export interface AttendanceNotifyResult {
  requested: number
  sent: number
  failed: number
}

export class AttendanceNotifier {
  private readonly channels: AttendanceNotificationChannel[]
  private readonly logger: Logger

  constructor(options: AttendanceNotifierOptions = {}) {
    this.channels = options.channels ?? []
    this.logger = options.logger ?? new Logger('AttendanceNotifier')
  }

  get channelCount(): number {
    return this.channels.length
  }

  /**
   * Dispatch a batch of messages across every registered channel. With no channels (the C4 default)
   * this is a no-op — sends nothing and logs nothing, so an at-least-once caller never produces per-tick
   * warn noise. Never throws; a channel failure is isolated and counted.
   */
  async notify(messages: AttendanceNotificationMessage[]): Promise<AttendanceNotifyResult> {
    const result: AttendanceNotifyResult = { requested: messages.length, sent: 0, failed: 0 }
    if (this.channels.length === 0 || messages.length === 0) return result
    for (const message of messages) {
      for (const channel of this.channels) {
        try {
          const outcome = await channel.send(message)
          if (outcome.ok) result.sent += 1
          else result.failed += 1
        } catch (error) {
          result.failed += 1
          this.logger.warn(`AttendanceNotifier channel ${channel.name} failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    return result
  }
}

/**
 * Env-gated channel factory. C4 ships NO concrete channels — returns [] so nothing is registered by
 * default (channel-env-gating discipline). C5 adds channels behind their own env flags.
 */
export function createAttendanceNotifierChannelsFromEnv(_env: NodeJS.ProcessEnv = process.env): AttendanceNotificationChannel[] {
  return []
}
