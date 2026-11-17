/**
 * What the production audit sink hands to the audit service: the owner of the row and its organization
 * are in the stored details, because a user id that is not a number cannot be stored as the actor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { auditService } from '../../src/audit/audit'
import { createPreferencesService } from '../../src/notifications/preferences-service'
import type { AuditEvent, NotificationDbDeps } from '../../src/notifications/notification-tx'
import type { Db, RecipientResolver } from '../../src/notifications/recipient-resolver'
import { productionAuditSink } from '../../src/routes/me-notification-wiring'

const ENDPOINT = '33333333-3333-4333-8333-333333333333'
const USER = 'f0e1d2c3-aaaa-4bbb-8ccc-0123456789ab'

afterEach(() => {
  vi.restoreAllMocks()
})

function scriptedPreferences(audit: (event: AuditEvent) => Promise<void>) {
  const db: Db = {
    query: async (sql) => {
      if (/FOR SHARE/.test(sql)) return { rows: [{ id: ENDPOINT, provider: 'dingtalk', status: 'active' }] }
      if (/^\s*INSERT INTO user_notification_preferences/.test(sql)) {
        return {
          rows: [{ topic: 'task_reminder', enabled: true, primary_endpoint_id: ENDPOINT, fallback_endpoint_id: null, quiet_start: null, quiet_end: null, quiet_timezone: null, revision: '1' }],
        }
      }
      if (/LEFT JOIN directory_integrations/.test(sql)) return { rows: [{ id: ENDPOINT, connection_id: ENDPOINT, provider: 'dingtalk', status: 'active', connection_name: 'HQ' }] }
      return { rows: [] }
    },
  }
  const deps: NotificationDbDeps = { db, transaction: async (fn) => fn(db) }
  const resolver = { verifyEndpoints: async () => [{ ok: true }] } as unknown as RecipientResolver
  return createPreferencesService({ ...deps, resolver, audit })
}

describe('the production audit sink', () => {
  it('stores the organization and the user of a preference update in the details, although a user id that is not a number is not stored as the actor', async () => {
    const logEvent = vi.spyOn(auditService, 'logEvent').mockResolvedValue(undefined as never)
    const service = scriptedPreferences(productionAuditSink)
    await service.patch({ orgId: 'org-1', userId: USER, patch: { topic: 'task_reminder', expectedRevision: 0, primaryEndpointId: ENDPOINT } })
    expect(logEvent).toHaveBeenCalledTimes(1)
    const [eventType, action, data] = logEvent.mock.calls[0]
    expect([eventType, action]).toEqual(['NOTIFICATION.PREFERENCE.UPDATE', 'notification.preference.update'])
    expect(data).toMatchObject({
      userId: undefined,
      resourceType: 'user_notification_preference',
      resourceId: 'task_reminder',
      actionDetails: { topic: 'task_reminder', revision: 1, organizationId: 'org-1', userId: USER },
    })
  })

  it('stores every meta key of an event it is given, including the initiator of a demotion', async () => {
    const logEvent = vi.spyOn(auditService, 'logEvent').mockResolvedValue(undefined as never)
    await productionAuditSink({
      actorType: 'system',
      action: 'notification.endpoint.demote',
      resourceType: 'user_notification_endpoint',
      resourceId: ENDPOINT,
      meta: { provider: 'dingtalk', revision: 2, reason: 'address_rebound', initiator: 'system', organizationId: 'org-1', userId: USER },
    })
    expect(logEvent.mock.calls[0][2]).toMatchObject({
      actionDetails: { provider: 'dingtalk', revision: 2, reason: 'address_rebound', initiator: 'system', organizationId: 'org-1', userId: USER },
    })
  })
})
