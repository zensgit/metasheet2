/**
 * Production wiring of the notification services: the connection pool, the audit log and the
 * active-member predicate. The services themselves take these as arguments; only this file binds them.
 */
import { auditLog } from '../audit/audit'
import { query, transaction } from '../db/pg'
import { readNotificationTupleFingerprint } from '../integrations/dingtalk/notification-fingerprint'
import { resolveEffectiveIntegrationCapability } from '../integrations/integration-capability-resolve'
import { resolveProviderCapabilityDescriptor } from '../integrations/provider-capability-registry'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { NotificationHttpError } from '../notifications/notification-errors'
import { isExternalNotificationDeliveryEnabled, isUserNotificationPreferencesEnabled } from '../notifications/notification-flags'
import type { AuditSink, NotificationDbDeps } from '../notifications/notification-tx'
import { createRecipientResolver, type Db, type RecipientResolver } from '../notifications/recipient-resolver'
import type { ConnectionReadiness } from '../notifications/test-send-service'
import { checkNotificationVerification, type NotificationVerificationCheck } from '../notifications/verification-evidence'
import { isTaskDingTalkWorkNotificationEnabled } from '../services/task-notification-flags'
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

/** The same three switches drive the display and the test-send production consumer. */
export function productionNotificationDeliveryEnabled(): boolean {
  return isUserNotificationPreferencesEnabled() && isExternalNotificationDeliveryEnabled() && isTaskDingTalkWorkNotificationEnabled()
}

interface NotificationConnectionInput {
  orgId: string
  connectionId: string
  provider: string
}

function queryable(db: Db): Queryable {
  return {
    query: async (sql, params) => {
      const result = await db.query(sql, params)
      return { rows: result.rows, rowCount: result.rows.length }
    },
  }
}

/** Ordinary reads, suitable for GET display or after the authoritative resolver has locked the integration. */
export async function productionNotificationVerificationSummary(db: Db, input: NotificationConnectionInput): Promise<NotificationVerificationCheck> {
  const read = await db.query(`SELECT id::text AS id, org_id, provider, status, corp_id, config
    FROM directory_integrations WHERE id = $1::uuid AND org_id = $2 AND provider = $3`,
  [input.connectionId, input.orgId, input.provider])
  const integration = read.rows[0]
  if (!integration) {
    return { ok: false, code: 'verification_missing', verification: { level: null, verifiedUntil: null, valid: false } }
  }
  const descriptor = resolveProviderCapabilityDescriptor(input.provider)
  const scope = descriptor?.scopeOf({ corp_id: String(integration.corp_id ?? ''), config: integration.config }) ?? null
  const fingerprint = input.provider === 'dingtalk'
    ? await readNotificationTupleFingerprint(input.connectionId, db)
    : null
  return checkNotificationVerification(db, {
    connectionId: input.connectionId,
    provider: input.provider,
    scope,
    tupleFingerprint: fingerprint?.ok === true ? fingerprint.value : null,
  })
}

/** R-1: the expected organization is the authenticated tenant passed by the user route. */
export async function productionNotificationConnectionReadiness(input: NotificationConnectionInput): Promise<ConnectionReadiness> {
  return productionNotificationDbDeps().transaction(async (db) => {
    await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await db.query("SET LOCAL lock_timeout = '2s'")
    await db.query("SET LOCAL statement_timeout = '5s'")
    const capability = await resolveEffectiveIntegrationCapability(queryable(db), {
      integrationId: input.connectionId,
      capability: 'notification',
      expectedOrgId: input.orgId,
    })
    if (capability.effective === false) {
      // The resolver swallows driver failures; throw here so its aborted transaction is rolled back.
      if (capability.reason === 'read_failed') throw new NotificationHttpError(503, 'NOTIFICATION_BUSY')
      return { ok: false, code: capability.reason }
    }
    if (capability.provider !== input.provider) return { ok: false, code: 'provider_not_registered' }
    const evidence = await productionNotificationVerificationSummary(db, input)
    if (evidence.ok === false) return { ok: false, code: evidence.code }
    return { ok: true, witness: capability.witness }
  })
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
