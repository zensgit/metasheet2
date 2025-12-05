/**
 * Telemetry middleware for Express
 */

import type { Request, Response, NextFunction } from 'express'
import { getTelemetry } from '../services/TelemetryService'
import type { StructuredLogger } from '../services/TelemetryService'

interface OTelSpan {
  recordException(exception: Error): void
  setStatus(status: { code: number; message?: string }): void
  setAttributes(attributes: Record<string, unknown>): void
  end(): void
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      span?: OTelSpan
      correlationId?: string
      logger?: StructuredLogger
    }
  }
}

/**
 * Log HTTP request
 */
function logRequest(logger: StructuredLogger, req: Request): void {
  logger.info('HTTP request received', {
    method: req.method,
    path: req.path,
    query: req.query,
    ip: req.ip,
    userAgent: req.get('user-agent')
  })
}

/**
 * Telemetry middleware
 * Adds tracing, logging, and metrics to HTTP requests
 */
export function telemetryMiddleware() {
  const telemetry = getTelemetry()

  return (req: Request, res: Response, next: NextFunction) => {
    // Use telemetry's built-in Express middleware
    const middleware = telemetry.expressMiddleware()

    // Add correlation ID
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const correlationId = (req.headers['x-correlation-id'] as string) || require('crypto').randomUUID()
    req.correlationId = correlationId

    // Add structured logger to request
    const reqLogger = telemetry.getLogger(`http.${req.method}.${req.path}`)
    reqLogger.setCorrelationId(correlationId)
    req.logger = reqLogger

    // Set correlation ID in response
    res.setHeader('x-correlation-id', correlationId);

    // Log request
    logRequest(reqLogger, req);

    // Apply telemetry middleware - use type assertion to handle Express type differences
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (middleware as any)(req, res, () => {
      // Log response on finish
      res.on('finish', () => {
        reqLogger.info('HTTP request completed', {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          contentLength: res.get('content-length')
        })
      })

      next()
    })
  }
}

/**
 * Error handling middleware with telemetry
 */
export function telemetryErrorHandler() {
  return (err: Error, req: Request, res: Response, next: NextFunction) => {
    // Log error
    if (req.logger) {
      req.logger.error('Request error', err, {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode || 500
      })
    }

    // Set error status in span
    if (req.span) {
      req.span.recordException(err)
      req.span.setStatus({
        code: 2, // ERROR
        message: err.message
      })
    }

    // Send error response
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined,
        correlationId: req.correlationId
      })
    }

    next(err)
  }
}

/**
 * Database query tracing helper
 */
export function traceDbQuery<T>(
  operation: string,
  table: string,
  queryFn: () => Promise<T>
): Promise<T> {
  const telemetry = getTelemetry()
  const tracer = telemetry.getTracer('database')
  const metrics = telemetry.getMetrics()

  return tracer.startActiveSpan(`db.${operation}.${table}`, async (span: OTelSpan) => {
    const startTime = Date.now()

    try {
      span.setAttributes({
        'db.system': 'postgresql',
        'db.operation': operation,
        'db.table': table
      })

      const result = await queryFn()

      span.setStatus({ code: 1 }) // OK
      metrics.recordDbQuery(operation, table, Date.now() - startTime, true)

      return result

    } catch (error) {
      span.recordException(error as Error)
      span.setStatus({
        code: 2, // ERROR
        message: (error as Error).message
      })
      metrics.recordDbQuery(operation, table, Date.now() - startTime, false)

      throw error

    } finally {
      span.end()
    }
  })
}

/**
 * Cache operation tracing helper
 */
export function traceCacheOperation<T>(
  operation: 'get' | 'set' | 'delete',
  key: string,
  operationFn: () => Promise<T>
): Promise<T> {
  const telemetry = getTelemetry()
  const tracer = telemetry.getTracer('cache')
  const metrics = telemetry.getMetrics()

  return tracer.startActiveSpan(`cache.${operation}`, async (span: OTelSpan) => {
    try {
      span.setAttributes({
        'cache.operation': operation,
        'cache.key': key
      })

      const result = await operationFn()

      // Determine if it was a cache hit (for get operations)
      const isHit = operation === 'get' && result !== null && result !== undefined

      span.setAttributes({
        'cache.hit': isHit
      })

      span.setStatus({ code: 1 }) // OK
      metrics.recordCacheOperation(operation, isHit)

      return result

    } catch (error) {
      span.recordException(error as Error)
      span.setStatus({
        code: 2, // ERROR
        message: (error as Error).message
      })
      metrics.recordCacheOperation(operation, false)

      throw error

    } finally {
      span.end()
    }
  })
}

/**
 * Async operation tracing helper
 */
export async function traceAsync<T>(
  name: string,
  fn: () => Promise<T>,
  attributes?: Record<string, unknown>
): Promise<T> {
  const telemetry = getTelemetry()
  const tracer = telemetry.getTracer('async')

  return tracer.startActiveSpan(name, { attributes }, async (span: OTelSpan) => {
    try {
      const result = await fn()
      span.setStatus({ code: 1 }) // OK
      return result

    } catch (error) {
      span.recordException(error as Error)
      span.setStatus({
        code: 2, // ERROR
        message: (error as Error).message
      })
      throw error

    } finally {
      span.end()
    }
  })
}
