/** Management-only policy writes. Background scans never import this authenticated consumer. */
import { resolveEffectiveIntegrationCapability } from '../integrations/integration-capability-resolve'
import { resolveNotificationAdapter } from './adapters/notification-adapter'
import { NotificationHttpError } from './notification-errors'
import type { NotificationDbDeps, AuditSink } from './notification-tx'
import { readRecipientRouteInputs } from './route-inputs'
import type { Db, RecipientResolver } from './recipient-resolver'
import { resolveNotificationTopic, listNotificationTopics } from './topic-registry'
import type { NotificationVerificationCheck } from './verification-evidence'

export interface TopicPolicyPatch {
  expectedRevision: number
  state: 'active' | 'paused'
  defaultConnectionId?: string | null
  confirmNoDefaultConnection?: true
}
export interface PolicyActor { actorId: string; authenticatedTenantId?: string }
export interface TopicPolicyDeps extends NotificationDbDeps {
  isActiveOrgMembers(db: Db, orgId: string, userIds: string[]): Promise<Set<string>>
  resolver: RecipientResolver
  audit: AuditSink
  deliveryEnabled(): boolean
  verification(db: Db, input: { orgId: string; connectionId: string; provider: string }): Promise<NotificationVerificationCheck>
}
function fail(status: number, code: string): never { throw new NotificationHttpError(status, code) }
const COLUMNS = 'topic, state, default_connection_id::text AS default_connection_id, revision'
const policyView = (row: Record<string, unknown>) => ({ topic: String(row.topic), state: String(row.state),
  defaultConnectionId: row.default_connection_id === null ? null : String(row.default_connection_id), revision: Number(row.revision) })

export function createTopicPolicyService(deps: TopicPolicyDeps) {
  /** Only a verified tenant may authorize a first takeover or a nonempty default selection. */
  async function requireMember(actor: PolicyActor): Promise<string> {
    if (!actor.authenticatedTenantId?.trim()) fail(422, 'ORG_MISSING')
    if (actor.authenticatedTenantId !== 'default') fail(403, 'ORG_MISMATCH')
    if (!(await deps.isActiveOrgMembers(deps.db, actor.authenticatedTenantId, [actor.actorId])).has(actor.actorId)) fail(403, 'ORG_MISMATCH')
    return actor.authenticatedTenantId
  }
  async function ready(connectionId: string, trustedOrgId: string, topic: string) {
    const capability = await deps.transaction(async client => {
      await client.query("SET LOCAL lock_timeout = '2s'")
      await client.query("SET LOCAL statement_timeout = '5s'")
      const result = await resolveEffectiveIntegrationCapability({ query: async (sql, params) => {
        const read = await client.query(sql, params); return { rows: read.rows, rowCount: read.rows.length }
      } }, { integrationId: connectionId.toLowerCase(), capability: 'notification', expectedOrgId: trustedOrgId })
      if (result.effective === false && result.reason === 'read_failed') fail(503, 'NOTIFICATION_BUSY')
      return result
    })
    if (capability.effective === false) fail(409, 'DEFAULT_CONNECTION_NOT_READY')
    if (capability.orgId !== trustedOrgId) fail(409, 'DEFAULT_CONNECTION_NOT_READY')
    const profile = resolveNotificationTopic(topic)?.profiles[capability.provider]
    if (!profile) fail(409, 'DEFAULT_CONNECTION_NOT_READY')
    try {
      if (resolveNotificationAdapter(capability.provider).transport !== profile.transport) fail(409, 'DEFAULT_CONNECTION_NOT_READY')
    } catch { fail(409, 'DEFAULT_CONNECTION_NOT_READY') }
    const verification = await deps.verification(deps.db, { orgId: trustedOrgId, connectionId, provider: capability.provider })
    if (verification.ok === false) fail(409, 'DEFAULT_CONNECTION_NOT_READY')
    // Authenticated witnesses are discarded here; only background witnesses may enter task decisions.
    return verification.verification
  }
  return {
    requireMember,
    async list() {
      const rows = await deps.db.query(`SELECT ${COLUMNS} FROM org_notification_topic_policies WHERE org_id = $1`, ['default'])
      return { topics: await Promise.all(listNotificationTopics().map(async topic => {
        const row = rows.rows.find(row => row.topic === topic.topic)
        let verification = { level: null, verifiedUntil: null, valid: false } as NotificationVerificationCheck['verification']
        if (row?.default_connection_id) {
          const connections = await deps.db.query('SELECT provider FROM directory_integrations WHERE id = $1::uuid AND org_id = $2', [row.default_connection_id, 'default'])
          if (connections.rows[0]) verification = (await deps.verification(deps.db, { orgId: 'default', connectionId: String(row.default_connection_id), provider: String(connections.rows[0].provider) })).verification
        }
        return { topic: topic.topic, integrated: topic.integrated, policy: row ? policyView(row) : null, verification }
      })) }
    },
    async put(actor: PolicyActor, topic: string, patch: TopicPolicyPatch) {
      const descriptor = resolveNotificationTopic(topic)
      if (!descriptor) fail(422, 'INVALID_REQUEST')
      const first = patch.expectedRevision === 0
      const explicit = Object.hasOwn(patch, 'defaultConnectionId')
      if (first && (!explicit || patch.state !== 'active')) fail(422, 'INVALID_REQUEST')
      let trustedOrg: string | undefined
      if (first || (explicit && patch.defaultConnectionId !== null)) trustedOrg = await requireMember(actor)
      if (first && !descriptor.integrated) fail(409, 'TOPIC_NOT_INTEGRATED')
      if (first && !deps.deliveryEnabled()) fail(409, 'NOTIFICATION_DELIVERY_DISABLED')
      if (explicit && patch.defaultConnectionId !== null) await ready(patch.defaultConnectionId!, trustedOrg!, topic)
      const result = await deps.transaction(async client => {
        await client.query("SET LOCAL lock_timeout = '2s'")
        await client.query("SET LOCAL statement_timeout = '5s'")
        if (first) {
          const tables = ['org_notification_topic_policies', 'task_notification_delivery_decisions', 'user_notification_endpoints', 'user_notification_preferences']
          for (const table of tables) {
            const probe = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [table])
            if (probe.rows[0]?.present !== true) fail(503, 'NOTIFICATION_SCHEMA_UNAVAILABLE')
          }
          await client.query('SELECT 1 FROM task_notification_delivery_decisions LIMIT 1')
        }
        const read = await client.query(`SELECT ${COLUMNS} FROM org_notification_topic_policies WHERE org_id = $1 AND topic = $2 FOR UPDATE`, ['default', topic])
        const current = read.rows[0]
        if (Number(current?.revision ?? 0) !== patch.expectedRevision) fail(409, 'POLICY_STALE')
        const connectionId = explicit ? patch.defaultConnectionId! : current?.default_connection_id == null ? null : String(current.default_connection_id)
        if (first && connectionId === null && patch.confirmNoDefaultConnection !== true) fail(409, 'DEFAULT_CONNECTION_CONFIRM_REQUIRED')
        // Only an explicit selection (or first takeover) changes authority; a state-only update retains the default.
        const written = first
          ? await client.query(`INSERT INTO org_notification_topic_policies (org_id, topic, state, default_connection_id, created_by, updated_by)
              VALUES ($1, $2, $3, $4::uuid, $5, $5) ON CONFLICT (org_id, topic) DO NOTHING RETURNING ${COLUMNS}`,
            ['default', topic, patch.state, connectionId, actor.actorId])
          : await client.query(`UPDATE org_notification_topic_policies SET state = $3, default_connection_id = $4::uuid,
              revision = revision + 1, updated_by = $5, updated_at = now()
              WHERE org_id = $1 AND topic = $2 AND revision = $6::bigint RETURNING ${COLUMNS}`,
            ['default', topic, patch.state, connectionId, actor.actorId, patch.expectedRevision])
        if (!written.rows.length) fail(409, 'POLICY_STALE')
        return policyView(written.rows[0])
      })
      await deps.audit({ actorId: actor.actorId, actorType: 'user', action: 'notification.topic_policy.update',
        resourceType: 'notification-topic-policy', resourceId: topic, meta: { state: result.state, revision: result.revision, defaultConnectionId: result.defaultConnectionId, firstTakeover: first } })
      return result
    },
    async preview(actor: PolicyActor, topic: string, defaultConnectionId: string | null) {
      const descriptor = resolveNotificationTopic(topic)
      if (!descriptor) fail(422, 'INVALID_REQUEST')
      let defaultReady = false
      if (defaultConnectionId) {
        const orgId = await requireMember(actor)
        try { await ready(defaultConnectionId, orgId, topic); defaultReady = true }
        catch (error) { if (!(error instanceof NotificationHttpError) || error.code !== 'DEFAULT_CONNECTION_NOT_READY') throw error }
      }
      const members = await deps.db.query(`SELECT uo.user_id FROM user_orgs uo JOIN users u ON u.id = uo.user_id
        WHERE uo.org_id = $1 AND uo.is_active = true AND u.is_active = true
          AND (to_jsonb(u) ->> 'deleted_at') IS NULL AND (to_jsonb(u) ->> 'purged_at') IS NULL
          AND u.activation_status = 'activated'
          AND (u.role <> 'disabled' OR EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = 'admin'))
        ORDER BY uo.user_id LIMIT 5001`, ['default'])
      const userIds = members.rows.slice(0, 5000).map(row => String(row.user_id))
      const counts: Record<string, number> = {}
      let noRoute = 0; let proofChanged = 0; let noValidTarget = 0
      for (let offset = 0; offset < userIds.length; offset += 500) {
        const batch = await readRecipientRouteInputs(deps.db, { orgId: 'default', userIds: userIds.slice(offset, offset + 500),
          defaultConnectionId, topic: descriptor, resolver: deps.resolver })
        proofChanged += batch.proofChangedEndpoints
        for (const [code, count] of Object.entries(batch.resolutionCounts)) counts[code] = (counts[code] ?? 0) + count
        for (const recipient of batch.recipients.values()) {
          const explicit = recipient.preference?.primaryEndpointId || recipient.preference?.fallbackEndpointId
          const usable = recipient.candidates.some(candidate => candidate.inProfile && candidate.resolution.ok)
          if (!explicit && !usable) noRoute++
          else if (explicit && !usable) noValidTarget++
        }
      }
      const integrations = await deps.db.query("SELECT count(*)::integer AS count FROM directory_integrations WHERE org_id = $1 AND provider = 'dingtalk' AND status = 'active'", ['default'])
      const collisions = await deps.db.query(`SELECT count(*)::integer AS count FROM (
        SELECT a.provider, a.corp_id, a.external_user_id FROM directory_account_links l
        JOIN directory_accounts a ON a.id = l.directory_account_id
        JOIN directory_integrations i ON i.id = a.integration_id
        WHERE i.org_id = $1 AND i.status = 'active' AND a.is_active AND l.link_status = 'linked'
          AND a.external_user_id IS NOT NULL AND a.corp_id = i.corp_id
        GROUP BY a.provider, a.corp_id, a.external_user_id HAVING count(DISTINCT l.local_user_id) > 1
      ) collisions`, ['default'])
      const activeIntegrations = Number(integrations.rows[0]?.count ?? 0)
      return { counts, member_count: userIds.length, truncated: members.rows.length > 5000,
        no_route_count: noRoute, no_valid_target_count: noValidTarget, proof_changed_endpoint_count: proofChanged,
        tenant_address_collisions: Number(collisions.rows[0]?.count ?? 0), active_dingtalk_integrations: activeIntegrations,
        warnings: [activeIntegrations > 1 ? 'multiple_active_integrations' : null,
          defaultConnectionId === null ? 'no_default_connection' : !defaultReady ? 'default_connection_not_ready' : null].filter(Boolean) }
    },
  }
}
export type TopicPolicyService = ReturnType<typeof createTopicPolicyService>
