/**
 * Telemetry middleware for Express
 */

import { Request, Response, NextFunction } from 'express'
import { getTelemetry, StructuredLogger } from '../services/TelemetryService'

declare global {
  namespace Express {
    interface Request {
      span?: any
      correlationId?: string
      logger?: StructuredLogger
    }
  }
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
    req.correlationId = req.headers['x-correlation-id'] as string || require('crypto').randomUUID()

    // Add structured logger to request
    req.logger = telemetry.getLogger(`http.${req.method}.${req.path}`)
    req.logger.setCorrelationId(req.correlationId)

    // Set correlation ID in response
    res.setHeader('x-correlation-id', req.correlationId)

    // Log request
    req.logger.info('HTTP request received', {
      method: req.method,
      path: req.path,
      query: req.query,
      ip: req.ip,
      userAgent: req.get('user-agent')
    })

    // Apply telemetry middleware
    middleware(req, res, () => {
      // Log response on finish
      res.on('finish', () => {
        req.logger?.info('HTTP request completed', {
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

  return tracer.startActiveSpan(`db.${operation}.${table}`, async (span) => {
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

  return tracer.startActiveSpan(`cache.${operation}`, async (span) => {
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
  attributes?: Record<string, any>
): Promise<T> {
  const telemetry = getTelemetry()
  const tracer = telemetry.getTracer('async')

  return tracer.startActiveSpan(name, { attributes }, async (span) => {
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