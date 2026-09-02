import { Logger } from '../core/logger'

const logger = new Logger('StockPreparationHandoffNotifier')

/**
 * 通知下一步 (light 备料 handoff) — the fan-out half of the host notifier seam.
 *
 * This lives in its own module rather than inline in `src/index.ts` for one concrete reason: the
 * "one broken webhook must not silence the others" rule below is load-bearing behaviour that has to
 * be provable by a test, and `src/index.ts` cannot be imported from a unit test (it pulls the whole
 * server graph and never settles). `src/index.ts` still owns the wiring — it resolves the DingTalk
 * group-destination service and injects the seam for plugin-integration-core — and delegates the
 * loop to here.
 */

/**
 * The one method this fan-out needs. Deliberately narrower than `DingTalkGroupDestinationService`
 * so a test can supply a fake without a Kysely handle, and so this module cannot quietly start
 * depending on the rest of that service.
 */
export interface StockPreparationHandoffDestinationSender {
  sendToDestination(
    id: string,
    input: { subject?: string; content?: string; initiatedBy?: string | null },
  ): Promise<{ ok: true }>
}

export interface StockPreparationHandoffNotification {
  destinationIds: string[]
  title: string
  body: string
}

/**
 * Send ONE composed notification to EVERY configured destination, and report counts.
 *
 * ONE FAILURE MUST NOT ABORT THE REST. A terminal 备料 notice goes to warehouse AND purchasing; if
 * warehouse's robot has a rotated secret or a revoked token, purchasing must still be told. So every
 * destination is attempted, each failure is caught, counted and logged, and the caller receives
 * counts instead of an exception — an early `throw` or a `Promise.all` here would turn one dead
 * webhook into total silence, which is exactly the bug this shape exists to prevent.
 *
 * The counts are what the plugin reads: `delivered > 0` -> 'sent', `delivered === 0` -> 'failed'.
 * A structurally impossible failure (no sender, for instance) is allowed to throw; the plugin
 * treats a throw as 'failed' too, so the honest answer reaches the operator either way.
 */
export async function sendStockPreparationHandoffNotificationToDestinations(
  sender: StockPreparationHandoffDestinationSender,
  notification: StockPreparationHandoffNotification,
): Promise<{ delivered: number; failed: number }> {
  const destinationIds = Array.isArray(notification?.destinationIds) ? notification.destinationIds : []
  let delivered = 0
  let failed = 0
  if (destinationIds.length === 0) return { delivered, failed }

  for (const destinationId of destinationIds) {
    try {
      await sender.sendToDestination(destinationId, {
        subject: notification.title,
        content: notification.body,
      })
      delivered += 1
    } catch (error) {
      failed += 1
      // Counted, logged, and NOT rethrown — the next destination still gets its turn. A destination
      // id is deployment configuration, not customer data, so it is safe to name; the message body
      // is never logged.
      logger.warn(
        `Stock-preparation handoff notification to DingTalk group destination ${destinationId} failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return { delivered, failed }
}
