/**
 * Correlation-id request tracing middleware.
 *
 * Reads the inbound `X-Correlation-ID` header (or generates a uuid when
 * absent/invalid), echoes it on the response, and runs the rest of the
 * request pipeline inside an AsyncLocalStorage scope so downstream code can
 * retrieve the id via `getCorrelationId()`.
 */

import crypto from 'crypto'
import type { NextFunction, Request, Response } from 'express'

import { enrichRequestContext, getCorrelationId, runWithRequestContext } from '../context/request-context'

const CORRELATION_HEADER = 'x-correlation-id'
const CORRELATION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && CORRELATION_PATTERN.test(value)
}

export function resolveCorrelationId(headerValue: unknown): string {
  if (Array.isArray(headerValue)) {
    return resolveCorrelationId(headerValue[0])
  }
  if (isValidCorrelationId(headerValue)) {
    return headerValue
  }
  return crypto.randomUUID()
}

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[CORRELATION_HEADER]
  const correlationId = resolveCorrelationId(incoming)

  req.correlationId = correlationId
  res.setHeader('X-Correlation-ID', correlationId)

  // NOTE: this middleware intentionally runs before auth so CORS preflights
  // and whitelisted routes still get a correlation id. `userId` / `tenantId`
  // are populated later by `correlationContextEnrichmentMiddleware`, after
  // authentication has attached `req.user`.
  runWithRequestContext({ correlationId }, () => next())
}

export const CORRELATION_ID_HEADER = 'X-Correlation-ID'

function resolveRequestUserId(req: Request): string | undefined {
  const candidates = [req.user?.id, req.user?.userId, req.user?.sub]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(candidate)
    }
  }
  return undefined
}

function resolveRequestTenantId(req: Request): string | undefined {
  const requestWithTenant = req as Request & {
    tenantId?: unknown
    tenant?: { id?: unknown } | null
  }
  const candidates = [
    requestWithTenant.tenantId,
    requestWithTenant.tenant?.id,
    req.user?.tenantId,
    req.user?.tenant_id,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(candidate)
    }
  }
  return undefined
}

export function correlationContextEnrichmentMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  enrichRequestContext({
    userId: resolveRequestUserId(req),
    tenantId: resolveRequestTenantId(req),
  })
  next()
}

export type CorrelationErrorLogger = {
  error(message: string, error: Error): void
}

export function correlationErrorHandler(
  logger: CorrelationErrorLogger,
  nodeEnv: string | undefined = process.env.NODE_ENV,
) {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    const correlationId = req.correlationId ?? getCorrelationId()
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`Unhandled route error: ${req.method} ${req.path}`, err instanceof Error ? err : new Error(message))
    if (res.headersSent) return next(err)
    const status = typeof (err as { status?: number })?.status === 'number'
      ? (err as { status: number }).status
      : typeof (err as { statusCode?: number })?.statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500
    res.status(status).json({
      success: false,
      error: status >= 500 ? 'Internal Server Error' : message,
      message: nodeEnv === 'production' && status >= 500 ? undefined : message,
      correlationId,
    })
  }
}
