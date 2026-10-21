/**
 * Request helpers shared by the task route files (`tasks.ts` and the files it registers).
 * Moved out of `tasks.ts` unchanged.
 */
import type { Request, Response } from 'express'
import { Logger } from '../core/logger'

export function actorId(req: Request): string {
  const sub = req.user && typeof req.user === 'object' && 'sub' in req.user ? String(req.user.sub ?? '') : ''
  return sub || String(req.user?.id ?? '')
}

export function orgId(req: Request): string {
  return typeof req.authenticatedTenantId === 'string' ? req.authenticatedTenantId : ''
}

const logger = new Logger('TasksRoutes')

/**
 * Errors raised by the task services through `fail()` carry a numeric 4xx
 * `status` and a contract `code`, and are sent as-is. Anything else (a
 * driver error, a bug) is logged and answered 500 `INTERNAL`: its own `code`
 * (for a pg error, the SQLSTATE) is never echoed to the client (M3R2-AUTHZ-4).
 */
export function sendError(res: Response, err: unknown): void {
  const status = typeof err === 'object' && err && 'status' in err ? Number((err as { status: unknown }).status) : NaN
  const code = typeof err === 'object' && err && 'code' in err ? (err as { code: unknown }).code : undefined
  if (Number.isInteger(status) && status >= 400 && status < 500 && typeof code === 'string') {
    res.status(status).json({ error: { code } })
    return
  }
  logger.error('tasks route failed', err instanceof Error ? err : undefined)
  res.status(500).json({ error: { code: 'INTERNAL' } })
}
