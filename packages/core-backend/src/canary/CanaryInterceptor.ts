/**
 * CanaryInterceptor - Message bus interceptor for canary routing
 *
 * Wraps message handlers to route traffic between stable and canary
 * versions based on CanaryRouter decisions, recording metrics for
 * latency and error comparison.
 *
 * Integrates with the existing messageBus.setInterceptor() pattern.
 */

import { Logger } from '../core/logger'
import { CanaryRouter } from './CanaryRouter'
import type { CanaryVersion } from './CanaryRouter'
import { canaryMetrics } from './CanaryMetrics'
import type { MessageHandlerInterceptor } from '../integration/messaging/message-bus'

const logger = new Logger('CanaryInterceptor')

interface MessageWithHeaders {
  id?: string
  topic?: string
  headers?: Record<string, unknown>
  payload?: unknown
}

type MessageHandler<T = unknown, R = unknown> = (msg: T) => Promise<R> | R

export class CanaryInterceptor implements MessageHandlerInterceptor {
  constructor(private readonly router: CanaryRouter) {}

  /**
   * Wrap a handler with canary routing and metrics.
   *
   * The interceptor determines stable vs canary based on the tenant header
   * and topic. Both versions execute the same underlying handler (the
   * routing decision is recorded for metrics), since actual handler
   * swapping happens at the subscription level.
   *
   * This interceptor records:
   * - Which version was selected (for request counting)
   * - Latency per version
   * - Errors per version
   */
  wrap<T = unknown, R = unknown>(handler: MessageHandler<T, R>): MessageHandler<T, R> {
    const router = this.router

    return async (msg: T): Promise<R> => {
      const message = msg as unknown as MessageWithHeaders
      const topic = message.topic ?? 'unknown'
      const tenantId = this.extractTenantId(message)

      // Determine version
      const version: CanaryVersion = tenantId
        ? router.route(topic, tenantId)
        : 'stable'

      // Record the request
      canaryMetrics.recordRequest(version, topic)

      // Measure latency
      const endTimer = canaryMetrics.startTimer(version, topic)

      try {
        const result = await handler(msg)
        endTimer()
        return result
      } catch (error) {
        endTimer()
        canaryMetrics.recordError(version, topic)
        throw error
      }
    }
  }

  /**
   * Extract tenant ID from message headers.
   */
  private extractTenantId(msg: MessageWithHeaders): string | undefined {
    const headers = msg.headers
    if (!headers) return undefined

    const tenantId = headers['x-tenant-id']
    return typeof tenantId === 'string' ? tenantId : undefined
  }
}

/**
 * Create and configure the canary interceptor for the message bus.
 */
export function createCanaryInterceptor(router: CanaryRouter): CanaryInterceptor {
  const interceptor = new CanaryInterceptor(router)
  logger.info('CanaryInterceptor created')
  return interceptor
}
