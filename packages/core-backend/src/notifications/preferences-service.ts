/**
 * Reading and writing the caller's own notification preferences, one row per topic.
 *
 * A write names the revision it expects (0 means "no row yet") and is applied only if the stored
 * revision still equals it. The endpoints a write refers to must be the caller's own, read by
 * (id, organization, user): an endpoint of another user, of another organization and one that does not
 * exist are the same answer.
 */
import { NotificationHttpError } from './notification-errors'
import { mapBusy, withUserLocks, type AuditSink, type NotificationDbDeps } from './notification-tx'
import { connectionLabel } from './provider-notification-registry'
import type { Db, RecipientResolver } from './recipient-resolver'
import { listNotificationTopics, resolveNotificationTopic, type NotificationTopicDescriptor } from './topic-registry'
import type { QuietHours } from './quiet-hours'

type Row = Record<string, unknown>
const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value))

export interface PreferencePatch {
  topic: string
  expectedRevision: number
  enabled?: boolean
  primaryEndpointId?: string | null
  fallbackEndpointId?: string | null
  quietHours?: QuietHours | null
}

export interface TopicPreferenceView {
  enabled: boolean
  primaryEndpointId: string | null
  fallbackEndpointId: string | null
  quietHours: QuietHours | null
  revision: number
}

export type AppliesReason = 'topic_not_integrated' | 'org_not_taken_over' | 'org_paused' | 'delivery_disabled' | 'capability_off'

export interface TopicView {
  topic: string
  integrated: boolean
  applies: { now: boolean; reason: AppliesReason | null }
  preference: TopicPreferenceView | null
  effective: {
    source: 'user_primary' | 'org_default' | 'none'
    connection: { id: string; provider: string; label: string } | null
    usable: boolean
    /** The stored backup; never usable when it is of the primary's provider. */
    fallback: { connection: { id: string; provider: string; label: string }; usable: boolean } | null
  }
}

export interface PreferencesService {
  list(input: { orgId: string; userId: string }): Promise<{ topics: TopicView[] }>
  patch(input: { orgId: string; userId: string; patch: PreferencePatch }): Promise<TopicView>
}

export interface PreferencesServiceDeps extends NotificationDbDeps {
  readonly resolver: RecipientResolver
  readonly audit: AuditSink
}

const PREFERENCE_COLUMNS = `topic, enabled, primary_endpoint_id::text AS primary_endpoint_id, fallback_endpoint_id::text AS fallback_endpoint_id,
       to_char(quiet_start, 'HH24:MI') AS quiet_start, to_char(quiet_end, 'HH24:MI') AS quiet_end, quiet_timezone,
       revision::text AS revision`

const SELECT_ALL_SQL = `SELECT ${PREFERENCE_COLUMNS} FROM user_notification_preferences WHERE org_id = $1 AND user_id = $2`

const SELECT_ONE_LOCKED_SQL = `SELECT ${PREFERENCE_COLUMNS} FROM user_notification_preferences
 WHERE org_id = $1 AND user_id = $2 AND topic = $3 FOR UPDATE`

// The caller's own endpoints, read by (id, organization, user) and held against revocation until the write commits.
const SELECT_ENDPOINTS_SHARED_SQL = `SELECT id::text AS id, provider, status
  FROM user_notification_endpoints
 WHERE id = ANY($1::uuid[]) AND org_id = $2 AND user_id = $3
 FOR SHARE`

const SELECT_ENDPOINTS_SQL = `SELECT e.id::text AS id, e.connection_id::text AS connection_id, e.provider, e.status, i.name AS connection_name
  FROM user_notification_endpoints e
  LEFT JOIN directory_integrations i ON i.id = e.connection_id AND i.org_id = e.org_id
 WHERE e.id = ANY($1::uuid[]) AND e.org_id = $2 AND e.user_id = $3`

const INSERT_SQL = `INSERT INTO user_notification_preferences
  (org_id, user_id, topic, enabled, primary_endpoint_id, fallback_endpoint_id, quiet_start, quiet_end, quiet_timezone, updated_by)
VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid, $7::time, $8::time, $9, $10)
ON CONFLICT (org_id, user_id, topic) DO NOTHING
RETURNING ${PREFERENCE_COLUMNS}`

const UPDATE_SQL = `UPDATE user_notification_preferences
   SET enabled = $4, primary_endpoint_id = $5::uuid, fallback_endpoint_id = $6::uuid,
       quiet_start = $7::time, quiet_end = $8::time, quiet_timezone = $9,
       revision = revision + 1, updated_by = $10, updated_at = now()
 WHERE org_id = $1 AND user_id = $2 AND topic = $3 AND revision = $11::bigint
RETURNING ${PREFERENCE_COLUMNS}`

function preferenceView(row: Row): TopicPreferenceView {
  const start = row.quiet_start === null || row.quiet_start === undefined ? null : text(row.quiet_start)
  return {
    enabled: row.enabled === true,
    primaryEndpointId: row.primary_endpoint_id === null || row.primary_endpoint_id === undefined ? null : text(row.primary_endpoint_id),
    fallbackEndpointId: row.fallback_endpoint_id === null || row.fallback_endpoint_id === undefined ? null : text(row.fallback_endpoint_id),
    quietHours: start === null ? null : { start, end: text(row.quiet_end), timeZone: text(row.quiet_timezone) },
    revision: Number(row.revision),
  }
}

function appliesOf(descriptor: NotificationTopicDescriptor): TopicView['applies'] {
  // No organization policy exists in this version, so a topic that is connected still has no takeover.
  return { now: false, reason: descriptor.integrated ? 'org_not_taken_over' : 'topic_not_integrated' }
}

const NONE_EFFECTIVE: TopicView['effective'] = { source: 'none', connection: null, usable: false, fallback: null }

export function createPreferencesService(deps: PreferencesServiceDeps): PreferencesService {
  const { resolver } = deps

  async function viewsFor(db: Db, orgId: string, userId: string, rows: Row[]): Promise<TopicView[]> {
    const byTopic = new Map(rows.map((row) => [text(row.topic), row]))
    const ids = [
      ...new Set(
        rows
          .flatMap((row) => [row.primary_endpoint_id, row.fallback_endpoint_id])
          .filter((id) => id !== null && id !== undefined)
          .map(text),
      ),
    ]
    const endpoints = new Map<string, Row>()
    const usable = new Map<string, boolean>()
    if (ids.length > 0) {
      const found = await db.query(SELECT_ENDPOINTS_SQL, [ids, orgId, userId])
      for (const row of found.rows) endpoints.set(text(row.id), row)
      const checks = await resolver.verifyEndpoints(db, { orgId, refs: ids.map((endpointId) => ({ endpointId, userId })) })
      ids.forEach((id, index) => usable.set(id, checks[index].ok === true && text(endpoints.get(id)?.status) === 'active'))
    }
    const connectionOf = (endpoint: Row) => ({
      id: text(endpoint.connection_id),
      provider: text(endpoint.provider),
      label: connectionLabel(text(endpoint.provider), text(endpoint.connection_name)),
    })
    return listNotificationTopics().map((descriptor) => {
      const row = byTopic.get(descriptor.topic)
      const preference = row ? preferenceView(row) : null
      let effective = NONE_EFFECTIVE
      const primary = preference?.primaryEndpointId ?? null
      const endpoint = primary === null ? undefined : endpoints.get(primary)
      if (primary !== null && endpoint) {
        const backup = preference?.fallbackEndpointId ?? null
        const backupEndpoint = backup === null ? undefined : endpoints.get(backup)
        effective = {
          source: 'user_primary',
          connection: connectionOf(endpoint),
          usable: usable.get(primary) === true,
          fallback:
            backup !== null && backupEndpoint
              ? {
                  connection: connectionOf(backupEndpoint),
                  usable: usable.get(backup) === true && text(backupEndpoint.provider) !== text(endpoint.provider),
                }
              : null,
        }
      }
      return { topic: descriptor.topic, integrated: descriptor.integrated, applies: appliesOf(descriptor), preference, effective }
    })
  }

  async function list(input: { orgId: string; userId: string }): Promise<{ topics: TopicView[] }> {
    const found = await deps.db.query(SELECT_ALL_SQL, [input.orgId, input.userId])
    return { topics: await viewsFor(deps.db, input.orgId, input.userId, found.rows) }
  }

  async function patch(input: { orgId: string; userId: string; patch: PreferencePatch }): Promise<TopicView> {
    const { orgId, userId } = input
    const request = input.patch
    const descriptor = resolveNotificationTopic(request.topic)
    if (descriptor === null) throw new NotificationHttpError(422, 'INVALID_REQUEST', { fields: ['topic'] })
    let auditRevision = 0
    let changed = false
    try {
      const written = await withUserLocks(deps, [{ orgId, userId }], async (tx) => {
        const found = await tx.query(SELECT_ONE_LOCKED_SQL, [orgId, userId, descriptor.topic])
        const current = found.rows[0] ? preferenceView(found.rows[0]) : null

        const primary = 'primaryEndpointId' in request ? (request.primaryEndpointId ?? null) : (current?.primaryEndpointId ?? null)
        const fallback = 'fallbackEndpointId' in request ? (request.fallbackEndpointId ?? null) : (current?.fallbackEndpointId ?? null)
        const referenced = [primary, fallback].filter((id): id is string => id !== null)
        const suppliedIds = new Set(
          [
            'primaryEndpointId' in request ? request.primaryEndpointId : null,
            'fallbackEndpointId' in request ? request.fallbackEndpointId : null,
          ].filter((id): id is string => typeof id === 'string'),
        )
        const endpoints = new Map<string, Row>()
        if (referenced.length > 0) {
          const rows = await tx.query(SELECT_ENDPOINTS_SHARED_SQL, [[...new Set(referenced)], orgId, userId])
          for (const row of rows.rows) endpoints.set(text(row.id), row)
        }
        // A missing endpoint comes first: another user's, another organization's and an unknown id answer alike.
        for (const id of suppliedIds) {
          if (!endpoints.has(id)) throw new NotificationHttpError(409, 'ENDPOINT_NOT_USABLE', { reason: 'endpoint_not_found' })
        }
        for (const id of suppliedIds) {
          const status = text(endpoints.get(id)?.status)
          if (status !== 'active') throw new NotificationHttpError(409, 'ENDPOINT_NOT_USABLE', { reason: `endpoint_${status}` })
        }
        for (const id of suppliedIds) {
          const provider = text(endpoints.get(id)?.provider)
          if (!Object.hasOwn(descriptor.profiles, provider)) throw new NotificationHttpError(409, 'ENDPOINT_NOT_ALLOWED_FOR_TOPIC')
        }
        if (fallback !== null && primary === null) throw new NotificationHttpError(422, 'INVALID_REQUEST', { fields: ['fallbackEndpointId'] })
        if (fallback !== null && fallback === primary) throw new NotificationHttpError(422, 'INVALID_REQUEST', { fields: ['fallbackEndpointId'] })
        if (fallback !== null && primary !== null) {
          const first = endpoints.get(primary)
          const second = endpoints.get(fallback)
          if (first && second && text(first.provider) === text(second.provider)) {
            throw new NotificationHttpError(409, 'FALLBACK_PROVIDER_NOT_ALLOWED')
          }
        }

        const enabled = 'enabled' in request ? request.enabled === true : (current?.enabled ?? true)
        const quiet = 'quietHours' in request ? (request.quietHours ?? null) : (current?.quietHours ?? null)

        const unchanged =
          current !== null &&
          current.revision === request.expectedRevision &&
          current.enabled === enabled &&
          current.primaryEndpointId === primary &&
          current.fallbackEndpointId === fallback &&
          (current.quietHours === null
            ? quiet === null
            : quiet !== null &&
              current.quietHours.start === quiet.start &&
              current.quietHours.end === quiet.end &&
              current.quietHours.timeZone === quiet.timeZone)
        if (unchanged) return found.rows[0]
        if (current === null && request.expectedRevision === 0 && Object.keys(request).every((key) => key === 'topic' || key === 'expectedRevision')) {
          return null
        }

        const values = [primary, fallback, quiet?.start ?? null, quiet?.end ?? null, quiet?.timeZone ?? null, userId]
        const result =
          request.expectedRevision === 0
            ? await tx.query(INSERT_SQL, [orgId, userId, descriptor.topic, enabled, ...values])
            : await tx.query(UPDATE_SQL, [orgId, userId, descriptor.topic, enabled, ...values, request.expectedRevision])
        if (result.rows.length === 0) {
          throw new NotificationHttpError(409, 'PREFERENCE_STALE', { currentRevision: current?.revision ?? 0 })
        }
        changed = true
        auditRevision = Number(result.rows[0].revision)
        return result.rows[0]
      })
      if (changed) {
        await deps.audit({
          actorType: 'user',
          actorId: userId,
          action: 'notification.preference.update',
          resourceType: 'user_notification_preference',
          resourceId: descriptor.topic,
          meta: { topic: descriptor.topic, revision: auditRevision },
        })
      }
      const rows = written === null ? [] : [written]
      return (await viewsFor(deps.db, orgId, userId, rows)).find((view) => view.topic === descriptor.topic) as TopicView
    } catch (error) {
      throw mapBusy(error)
    }
  }

  return { list, patch }
}
