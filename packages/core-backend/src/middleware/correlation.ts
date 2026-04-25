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

import { runWithRequestContext } from '../context/request-context'

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
  // on the context are populated later by a post-auth enrichment step
  // (follow-up); attempting to read `req.user` here is always undefined.
  runWithRequestContext({ correlationId }, () => next())
}

export const CORRELATION_ID_HEADER = 'X-Correlation-ID'
