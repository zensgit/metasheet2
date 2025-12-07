/**
 * 日志系统，附带可选的 trace/request 关联。
 */

import { AsyncLocalStorage } from 'async_hooks'
import winston from 'winston'

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
  const merged = {
    ...meta,
    ...traceMeta,
    requestId: store?.requestId ?? traceMeta.requestId,
    spanId: store?.spanId ?? traceMeta.spanId,
    traceId: store?.traceId ?? traceMeta.traceId
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

  debug(message: string, meta?: Record<string, unknown>): void {
    this.winston.debug(message, mergeMeta(meta))
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.winston.info(message, mergeMeta(meta))
  }

  warn(message: string, meta?: Record<string, unknown> | Error): void {
    if (meta instanceof Error) {
      this.winston.warn(message, mergeMeta({ error: meta.message, stack: meta.stack }))
    } else {
      this.winston.warn(message, mergeMeta(meta))
    }
  }

  error(message: string, error?: Error): void {
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
