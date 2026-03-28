import { Logger } from '../core/logger'
import { AuditService } from './AuditService'

export const auditService = new AuditService()
const logger = new Logger('auditLog')

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
    logger.warn('Audit log write failed; continuing without blocking request', {
      action: options.action,
      resourceType: options.resourceType,
      resourceId: options.resourceId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
