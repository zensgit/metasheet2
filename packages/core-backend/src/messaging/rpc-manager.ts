/**
 * RPC Manager with Timeout Cleanup
 * Issues #27 & #30: RPC timeout cleanup and error handling
 */

import { EventEmitter } from 'events'
import { Logger } from '../core/logger'
import { CoreMetrics } from '../integration/metrics/metrics'

interface RPCRequest {
  id: string
  topic: string
  payload: any
  timestamp: number
  timeoutMs: number
  retryCount: number
  callback?: (error: Error | null, result?: any) => void
}

interface RPCResponse {
  id: string
  result?: any
  error?: any
  timestamp: number
}

interface RPCConfig {
  defaultTimeoutMs?: number
  maxRetries?: number
  cleanupIntervalMs?: number
  circuitBreakerThreshold?: number
  circuitBreakerResetMs?: number
}

interface CircuitBreaker {
  failures: number
  lastFailureTime: number
  state: 'closed' | 'open' | 'half-open'
  successCount: number
}

export class RPCManager extends EventEmitter {
  private requests: Map<string, RPCRequest> = new Map()
  private responses: Map<string, RPCResponse> = new Map()
  private subscriptions: Map<string, any> = new Map()
  private cleanupTimer?: NodeJS.Timeout
  private circuitBreakers: Map<string, CircuitBreaker> = new Map()
  private logger: Logger
  private metrics: CoreMetrics
  private config: Required<RPCConfig>

  constructor(
    logger: Logger,
    metrics: CoreMetrics,
    config: RPCConfig = {}
  ) {
    super()
    this.logger = logger
    this.metrics = metrics
    this.config = {
      defaultTimeoutMs: config.defaultTimeoutMs || 5000,
      maxRetries: config.maxRetries || 3,
      cleanupIntervalMs: config.cleanupIntervalMs || 10000,
      circuitBreakerThreshold: config.circuitBreakerThreshold || 5,
      circuitBreakerResetMs: config.circuitBreakerResetMs || 60000
    }

    this.startCleanupTimer()
  }

  /**
   * Make an RPC request with timeout and retry logic
   */
  async request(
    topic: string,
    payload: any,
    options: {
      timeoutMs?: number
      retries?: number
      priority?: 'high' | 'normal' | 'low'
    } = {}
  ): Promise<any> {
    const requestId = this.generateRequestId()
    const timeoutMs = options.timeoutMs || this.getTimeoutForTopic(topic)
    const maxRetries = options.retries ?? this.config.maxRetries

    // Check circuit breaker
    const breaker = this.getCircuitBreaker(topic)
    if (breaker.state === 'open') {
      const error = new Error(`Circuit breaker open for topic: ${topic}`)
      this.metrics.increment('rpc.circuit_breaker.rejected', { topic })
      throw error
    }

    const request: RPCRequest = {
      id: requestId,
      topic,
      payload,
      timestamp: Date.now(),
      timeoutMs,
      retryCount: 0
    }

    this.requests.set(requestId, request)
    this.metrics.increment('rpc.requests.total', { topic })

    try {
      const result = await this.executeRequestWithRetry(request, maxRetries)
      this.recordSuccess(topic, breaker)
      return result
    } catch (error) {
      this.recordFailure(topic, breaker)
      throw error
    } finally {
      this.cleanup(requestId)
    }
  }

  /**
   * Execute request with retry logic
   */
  private async executeRequestWithRetry(
    request: RPCRequest,
    maxRetries: number
  ): Promise<any> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        request.retryCount = attempt
        if (attempt > 0) {
          this.logger.debug(`Retrying RPC request ${request.id} (attempt ${attempt})`)
          this.metrics.increment('rpc.retries.total', {
            topic: request.topic,
            attempt: attempt.toString()
          })
        }

        const result = await this.executeRequest(request)
        return result
      } catch (error) {
        lastError = error as Error

        // Don't retry for non-retriable errors
        if (!this.isRetriableError(error)) {
          break
        }

        // Wait before retry with exponential backoff
        if (attempt < maxRetries) {
          await this.sleep(Math.pow(2, attempt) * 100)
        }
      }
    }

    throw lastError || new Error('Unknown RPC error')
  }

  /**
   * Execute a single RPC request
   */
  private executeRequest(request: RPCRequest): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.handleTimeout(request.id)
        reject(new Error(`RPC timeout for topic: ${request.topic}`))
      }, request.timeoutMs)

      request.callback = (error, result) => {
        clearTimeout(timeoutHandle)
        if (error) {
          reject(error)
        } else {
          resolve(result)
        }
      }

      // Emit request event for message bus to handle
      this.emit('rpc:request', request)

      // Simulate subscription for demonstration
      const subscription = {
        id: request.id,
        topic: request.topic,
        createdAt: Date.now()
      }
      this.subscriptions.set(request.id, subscription)
    })
  }

  /**
   * Handle RPC response
   */
  handleResponse(requestId: string, result?: any, error?: any): void {
    const request = this.requests.get(requestId)
    if (!request) {
      this.logger.warn(`Received response for unknown request: ${requestId}`)
      return
    }

    const response: RPCResponse = {
      id: requestId,
      result,
      error,
      timestamp: Date.now()
    }

    this.responses.set(requestId, response)

    // Calculate latency
    const latency = response.timestamp - request.timestamp
    this.metrics.histogram('rpc.latency', latency, {
      topic: request.topic,
      success: error ? 'false' : 'true'
    })

    // Call the callback
    if (request.callback) {
      request.callback(error, result)
    }
  }

  /**
   * Handle request timeout
   */
  private handleTimeout(requestId: string): void {
    const request = this.requests.get(requestId)
    if (!request) return

    this.logger.warn(`RPC timeout for request ${requestId} on topic ${request.topic}`)
    this.metrics.increment('rpc.timeouts.total', { topic: request.topic })

    // Clean up subscription
    this.cleanupSubscription(requestId)

    // Emit timeout event
    this.emit('rpc:timeout', { requestId, topic: request.topic })
  }

  /**
   * Clean up request and related resources
   */
  private cleanup(requestId: string): void {
    const request = this.requests.get(requestId)
    if (request) {
      const duration = Date.now() - request.timestamp
      this.metrics.histogram('rpc.duration', duration, { topic: request.topic })
    }

    this.requests.delete(requestId)
    this.responses.delete(requestId)
    this.cleanupSubscription(requestId)

    this.metrics.increment('rpc.cleanup.total', { reason: 'completed' })
  }

  /**
   * Clean up subscription
   */
  private cleanupSubscription(requestId: string): void {
    const subscription = this.subscriptions.get(requestId)
    if (subscription) {
      this.subscriptions.delete(requestId)
      this.emit('rpc:unsubscribe', { id: requestId, topic: subscription.topic })
    }
  }

  /**
   * Periodic cleanup of stale requests
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.performCleanup()
    }, this.config.cleanupIntervalMs)
  }

  /**
   * Perform cleanup of stale requests and responses
   */
  private performCleanup(): void {
    const now = Date.now()
    let cleanedRequests = 0
    let cleanedResponses = 0
    let cleanedSubscriptions = 0

    // Clean up timed out requests
    for (const [id, request] of this.requests) {
      if (now - request.timestamp > request.timeoutMs * 2) {
        this.requests.delete(id)
        this.cleanupSubscription(id)
        cleanedRequests++
      }
    }

    // Clean up old responses
    for (const [id, response] of this.responses) {
      if (now - response.timestamp > 60000) { // Keep for 1 minute
        this.responses.delete(id)
        cleanedResponses++
      }
    }

    // Clean up orphaned subscriptions
    for (const [id, subscription] of this.subscriptions) {
      if (!this.requests.has(id) && now - subscription.createdAt > 30000) {
        this.subscriptions.delete(id)
        cleanedSubscriptions++
      }
    }

    if (cleanedRequests > 0 || cleanedResponses > 0 || cleanedSubscriptions > 0) {
      this.logger.debug(`RPC cleanup: ${cleanedRequests} requests, ${cleanedResponses} responses, ${cleanedSubscriptions} subscriptions`)
      this.metrics.increment('rpc.cleanup.periodic', {
        requests: cleanedRequests.toString(),
        responses: cleanedResponses.toString(),
        subscriptions: cleanedSubscriptions.toString()
      })
    }

    // Reset circuit breakers if needed
    this.resetCircuitBreakers()
  }

  /**
   * Get timeout for specific topic
   */
  private getTimeoutForTopic(topic: string): number {
    const timeouts: Record<string, number> = {
      'system.health': 1000,
      'data.query': 10000,
      'data.export': 30000,
      'workflow.execute': 15000,
      'approval.submit': 5000
    }

    return timeouts[topic] || this.config.defaultTimeoutMs
  }

  /**
   * Check if error is retriable
   */
  private isRetriableError(error: any): boolean {
    if (!error) return false

    const retriableErrors = [
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'ENETUNREACH'
    ]

    const errorCode = error.code || error.message
    return retriableErrors.some(code => errorCode?.includes(code))
  }

  /**
   * Circuit breaker management
   */
  private getCircuitBreaker(topic: string): CircuitBreaker {
    let breaker = this.circuitBreakers.get(topic)
    if (!breaker) {
      breaker = {
        failures: 0,
        lastFailureTime: 0,
        state: 'closed',
        successCount: 0
      }
      this.circuitBreakers.set(topic, breaker)
    }
    return breaker
  }

  private recordSuccess(topic: string, breaker: CircuitBreaker): void {
    breaker.successCount++
    if (breaker.state === 'half-open' && breaker.successCount >= 3) {
      breaker.state = 'closed'
      breaker.failures = 0
      this.logger.info(`Circuit breaker closed for topic: ${topic}`)
      this.metrics.increment('rpc.circuit_breaker.closed', { topic })
    }
  }

  private recordFailure(topic: string, breaker: CircuitBreaker): void {
    breaker.failures++
    breaker.lastFailureTime = Date.now()
    breaker.successCount = 0

    if (breaker.failures >= this.config.circuitBreakerThreshold) {
      breaker.state = 'open'
      this.logger.warn(`Circuit breaker opened for topic: ${topic}`)
      this.metrics.increment('rpc.circuit_breaker.opened', { topic })
    }
  }

  private resetCircuitBreakers(): void {
    const now = Date.now()
    for (const [topic, breaker] of this.circuitBreakers) {
      if (
        breaker.state === 'open' &&
        now - breaker.lastFailureTime > this.config.circuitBreakerResetMs
      ) {
        breaker.state = 'half-open'
        breaker.successCount = 0
        this.logger.info(`Circuit breaker half-opened for topic: ${topic}`)
        this.metrics.increment('rpc.circuit_breaker.half_open', { topic })
      }
    }
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    return `rpc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }

  /**
   * Helper sleep function
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Get statistics
   */
  getStats(): {
    activeRequests: number
    cachedResponses: number
    activeSubscriptions: number
    circuitBreakers: Record<string, string>
  } {
    const circuitBreakers: Record<string, string> = {}
    for (const [topic, breaker] of this.circuitBreakers) {
      circuitBreakers[topic] = breaker.state
    }

    return {
      activeRequests: this.requests.size,
      cachedResponses: this.responses.size,
      activeSubscriptions: this.subscriptions.size,
      circuitBreakers
    }
  }

  /**
   * Shutdown and cleanup
   */
  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
    }

    // Cancel all pending requests
    for (const [id, request] of this.requests) {
      if (request.callback) {
        request.callback(new Error('RPC manager shutting down'), null)
      }
    }

    this.requests.clear()
    this.responses.clear()
    this.subscriptions.clear()
    this.circuitBreakers.clear()

    this.logger.info('RPC manager shutdown complete')
  }
}