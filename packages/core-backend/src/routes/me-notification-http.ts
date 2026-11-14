/**
 * Request and response helpers for the user-facing notification routes.
 *
 * The organization comes only from the verified session token; the user comes only from `req.user.id`
 * (the users.id plane), never from `sub` or from the request. No route accepts an organization, a user
 * or a recipient identifier from the client.
 */
import type { Request, Response } from 'express'
import { Logger } from '../core/logger'
import { isNotificationHttpError, NotificationHttpError } from '../notifications/notification-errors'
import { mapBusy } from '../notifications/notification-tx'

const logger = new Logger('MeNotificationRoutes')

export const NOT_FOUND_BODY = Object.freeze({ error: Object.freeze({ code: 'NOT_FOUND' }) })

export function respondNotFound(res: Response): void {
  res.status(404).json(NOT_FOUND_BODY)
}

export function respondUnauthorized(res: Response): void {
  res.status(401).json({ error: { code: 'UNAUTHORIZED' } })
}

export function tenantOf(req: Request): string {
  return typeof req.authenticatedTenantId === 'string' ? req.authenticatedTenantId : ''
}

export function userOf(req: Request): string {
  const id = req.user && typeof req.user === 'object' ? (req.user as { id?: unknown }).id : undefined
  return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : ''
}

/** Only a JSON body is read; any other body reaches the validation as no body. */
export function jsonBodyOf(req: Request): unknown {
  return req.is('application/json') ? req.body : undefined
}

const FIELD_NAME = /^[A-Za-z0-9_.]{1,64}$/

/** A request-validation failure that names fields only; an unusual client key is reported as a placeholder. */
export function invalidRequest(fields: readonly string[]): NotificationHttpError {
  const names = [...new Set(fields.map((name) => (FIELD_NAME.test(name) ? name : '_')))].sort()
  return new NotificationHttpError(422, 'INVALID_REQUEST', { fields: names })
}

/** The keys of a plain object body, or null when the body is not a plain object. */
export function plainObjectKeys(body: unknown): string[] | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  return Object.keys(body as Record<string, unknown>)
}

function failureToken(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  const name = error instanceof Error ? error.name : 'non-error'
  return `${name}${typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? ` ${code}` : ''}`
}

/**
 * Every route ends here. A lock wait, deadlock or cancelled statement is 503 NOTIFICATION_BUSY and a missing
 * table or column is 503 NOTIFICATION_SCHEMA_UNAVAILABLE, whether the failure came from a read or a write;
 * any other unexpected failure is the fixed-sentence 500.
 */
export function respondError(res: Response, error: unknown): void {
  const mapped = mapBusy(error)
  if (isNotificationHttpError(mapped)) {
    if (mapped !== error) logger.error(`notification route unavailable: ${failureToken(error)}`)
    res.status(mapped.status).json({ error: { code: mapped.code, ...(mapped.details ?? {}) } })
    return
  }
  logger.error(`notification route failed: ${failureToken(error)}`)
  res.status(500).json({ error: { code: 'INTERNAL' } })
}

export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
