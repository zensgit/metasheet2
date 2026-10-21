import { Logger } from '../core/logger'
import { coreMetrics } from '../integration/metrics/metrics'
import { AuditService } from './AuditService'

export const auditService = new AuditService()
const logger = new Logger('auditLog')

export const AUDIT_WRITE_ERRORS_METRIC = 'audit_events_write_errors'

const TOKEN_MAX_LENGTH = 64

/**
 * Keep log tokens to a conservative charset so that neither a driver message
 * nor a caller-supplied action can smuggle record values into the log line.
 */
function sanitizeToken(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return 'UNKNOWN'
  const normalized = String(value).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, TOKEN_MAX_LENGTH)
  return normalized.length > 0 ? normalized : 'UNKNOWN'
}

/**
 * Prefer a driver error code (SQLSTATE and friends) over the error message,
 * which routinely echoes row values back at us.
 */
function extractErrorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' || typeof code === 'number') return sanitizeToken(code)
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string') return sanitizeToken(name)
  }
  return 'UNKNOWN'
}

export interface AuditLogOptions {
  actorId?: string
  actorType: string
  action: string
  resourceType: string
  resourceId: string
  meta?: Record<string, unknown>
}

export async function auditLog(options: AuditLogOptions): Promise<void> {
  const parsedUserId = options.actorType === 'user' && options.actorId
    ? Number(options.actorId)
    : undefined
  const userId = Number.isFinite(parsedUserId) ? parsedUserId : undefined

  try {
    await auditService.logEvent(
      options.action.toUpperCase(),
      options.action,
      {
        userId,
        resourceType: options.resourceType,
        resourceId: options.resourceId,
        actionDetails: options.meta
      }
    )
  } catch (error) {
    // Audit write failures are silent data loss: count them and log at error level.
    // The payload stays values-free on purpose - no resourceId, no meta, no driver text.
    coreMetrics.increment(AUDIT_WRITE_ERRORS_METRIC)
    logger.error(
      'Audit log write failed; continuing without blocking request'
      + ` (action=${sanitizeToken(options.action)}`
      + ` resource_type=${sanitizeToken(options.resourceType)}`
      + ` error_code=${extractErrorCode(error)})`
    )
  }
}
