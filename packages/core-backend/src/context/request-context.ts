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

export function enrichRequestContext(patch: Partial<Omit<RequestContext, 'correlationId'>>): RequestContext | undefined {
  const current = storage.getStore()
  if (!current) return undefined
  if (typeof patch.userId === 'string' && patch.userId.trim().length > 0) {
    current.userId = patch.userId.trim()
  }
  if (typeof patch.tenantId === 'string' && patch.tenantId.trim().length > 0) {
    current.tenantId = patch.tenantId.trim()
  }
  return current
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId
}

export function getRequestContextStorage(): AsyncLocalStorage<RequestContext> {
  return storage
}
