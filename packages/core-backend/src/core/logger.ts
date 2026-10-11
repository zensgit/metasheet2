/**
 * 日志系统，附带可选的 trace/request 关联。
 */

import { AsyncLocalStorage } from 'async_hooks'
import winston from 'winston'

import { getRequestContext } from '../context/request-context'

type LogContext = {
  traceId?: string
  spanId?: string
  requestId?: string
}

const contextStore = new AsyncLocalStorage<LogContext>()

// Optional OpenTelemetry API (loaded lazily to avoid hard dependency)
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic import of optional dependency
let otelApi: any
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  otelApi = require('@opentelemetry/api')
} catch {
  otelApi = null
}

function currentTraceIds(): LogContext {
  try {
    if (!otelApi) return {}
    const span = otelApi.trace.getActiveSpan?.()
    const ctx = span?.spanContext?.()
    if (!ctx) return {}
    return {
      traceId: ctx.traceId,
      spanId: ctx.spanId
    }
  } catch {
    return {}
  }
}

function mergeMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  const store = contextStore.getStore()
  const traceMeta = currentTraceIds()
  const requestContext = getRequestContext()
  const correlationId = requestContext?.correlationId
  const merged: Record<string, unknown> = {
    ...meta,
    ...traceMeta,
    requestId: store?.requestId ?? traceMeta.requestId,
    spanId: store?.spanId ?? traceMeta.spanId,
    traceId: store?.traceId ?? traceMeta.traceId
  }
  if (correlationId) {
    merged.correlation_id = correlationId
  }
  if (requestContext?.userId) {
    merged.user_id = requestContext.userId
  }
  if (requestContext?.tenantId) {
    merged.tenant_id = requestContext.tenantId
  }
  // Strip keys whose value is undefined so downstream formatters don't emit them.
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key]
  }
  return Object.keys(merged).length ? merged : undefined
}

export class Logger {
  private winston: winston.Logger
  private context: string

  constructor(context: string) {
    this.context = context
    this.winston = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      defaultMeta: { service: 'metasheet', context },
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        })
      ]
    })
  }

  /** Owner HTTP logs retain server correlation only. Branch before touching any
   * caller message/meta/error or consulting identity/trace/request-id bridges. */
  private writePrivateObservation(level: 'debug' | 'info' | 'warn' | 'error'): boolean {
    const requestContext = getRequestContext()
    if (requestContext?.privateObservationSurface !== 'yida-owner-http') return false
    const meta = {
      correlation_id: requestContext.correlationId,
      requestId: requestContext.correlationId,
    }
    switch (level) {
      case 'debug':
        this.winston.debug('YIDA_OWNER_HTTP_DEBUG', meta)
        break
      case 'info':
        this.winston.info('YIDA_OWNER_HTTP_INFO', meta)
        break
      case 'warn':
        this.winston.warn('YIDA_OWNER_HTTP_WARN', meta)
        break
      case 'error':
        this.winston.error('YIDA_OWNER_HTTP_ERROR', meta)
        break
    }
    return true
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (this.writePrivateObservation('debug')) return
    this.winston.debug(message, mergeMeta(meta))
  }

  info(message: string, meta?: Record<string, unknown>): void {
    if (this.writePrivateObservation('info')) return
    this.winston.info(message, mergeMeta(meta))
  }

  warn(message: string, meta?: Record<string, unknown> | Error): void {
    if (this.writePrivateObservation('warn')) return
    if (meta instanceof Error) {
      this.winston.warn(message, mergeMeta({ error: meta.message, stack: meta.stack }))
    } else {
      this.winston.warn(message, mergeMeta(meta))
    }
  }

  error(message: string, error?: Error): void {
    if (this.writePrivateObservation('error')) return
    this.winston.error(message, mergeMeta({ error: error?.message, stack: error?.stack }))
  }
}

export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return contextStore.run(ctx, fn)
}

export function setLogContext(ctx: LogContext): void {
  const existing = contextStore.getStore() || {}
  // enterWith overrides current store in this async context
  contextStore.enterWith({ ...existing, ...ctx })
}

export function getLogContext(): LogContext | undefined {
  return contextStore.getStore()
}

/**
 * 创建日志器实例的辅助函数
 */
export function createLogger(context: string): Logger {
  return new Logger(context)
}
