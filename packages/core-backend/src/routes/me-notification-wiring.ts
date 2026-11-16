/**
 * Production wiring of the notification services: the connection pool, the audit log and the
 * active-member predicate. The services themselves take these as arguments; only this file binds them.
 */
import { auditLog } from '../audit/audit'
import { query, transaction } from '../db/pg'
import type { AuditSink, NotificationDbDeps } from '../notifications/notification-tx'
import { createRecipientResolver, type Db, type RecipientResolver } from '../notifications/recipient-resolver'
import { findActiveOrgMembers } from '../services/task-org-members'

export function productionNotificationDbDeps(): NotificationDbDeps {
  return {
    db: { query: (sql, params) => query(sql, params) as unknown as ReturnType<Db['query']> },
    transaction: (fn) => transaction((client) => fn(client as unknown as Db)),
  }
}

export function productionRecipientResolver(): RecipientResolver {
  return createRecipientResolver({ isActiveOrgMembers: (db, orgId, userIds) => findActiveOrgMembers(db, orgId, userIds) })
}

export const productionAuditSink: AuditSink = (event) =>
  auditLog({
    actorType: event.actorType,
    ...(event.actorId !== undefined ? { actorId: event.actorId } : {}),
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    ...(event.meta !== undefined ? { meta: event.meta } : {}),
  })
