/**
 * Request-scoped context shared across async boundaries.
 *
 * A dedicated AsyncLocalStorage keyed on the end-to-end correlation id so
 * downstream services can annotate logs, errors, and outbound calls without
 * prop-drilling `req`.
 */

import { AsyncLocalStorage } from 'async_hooks'

export interface RequestContext {
  correlationId: string
  userId?: string
  tenantId?: string
}

const storage = new AsyncLocalStorage<RequestContext>()

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore()
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId
}

export function getRequestContextStorage(): AsyncLocalStorage<RequestContext> {
  return storage
}
