import { AuditService } from './AuditService'

export const auditService = new AuditService()

export interface AuditLogOptions {
  actorId?: string
  actorType: string
  action: string
  resourceType: string
  resourceId: string
  meta?: Record<string, unknown>
}

export async function auditLog(options: AuditLogOptions): Promise<void> {
  try {
    const parsedUserId = options.actorType === 'user' && options.actorId
      ? Number.parseInt(options.actorId, 10)
      : undefined
    const userId = Number.isFinite(parsedUserId) ? parsedUserId : undefined
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
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[Audit] Failed to record audit log: ${message}`)
  }
}
