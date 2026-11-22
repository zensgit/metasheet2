/** Batched recipient inputs shared by the scan and the read-only management preview. No authority entry imports. */
import type { TopicPreferenceView } from './preferences-service'
import type { Db, RecipientResolver, ResolveResult } from './recipient-resolver'
import { RESOLVE_EXCLUSIONS, type RouteCandidate, type RouteSource } from './router'
import type { NotificationTopicDescriptor } from './topic-registry'

type Row = Record<string, unknown>
export interface RecipientRouteInputs {
  preference: TopicPreferenceView | null
  candidates: RouteCandidate[]
}
export interface RecipientBatch {
  recipients: Map<string, RecipientRouteInputs>
  connections: Set<string>
  proofChangedEndpoints: number
  resolutionCounts: Record<string, number>
}

export async function readRecipientRouteInputs(db: Db, input: {
  orgId: string
  userIds: readonly string[]
  defaultConnectionId: string | null
  topic: NotificationTopicDescriptor
  resolver: RecipientResolver
}): Promise<RecipientBatch> {
  const userIds = [...new Set(input.userIds)]
  const preferences = await db.query(`SELECT user_id, enabled, primary_endpoint_id::text, fallback_endpoint_id::text,
      to_char(quiet_start, 'HH24:MI') AS quiet_start, to_char(quiet_end, 'HH24:MI') AS quiet_end, quiet_timezone, revision
    FROM user_notification_preferences WHERE org_id = $1 AND topic = $2 AND user_id = ANY($3::text[])`,
  [input.orgId, input.topic.topic, userIds])
  const endpoints = await db.query(`SELECT id::text, user_id, connection_id::text, provider, status, revision
    FROM user_notification_endpoints WHERE org_id = $1 AND user_id = ANY($2::text[])`, [input.orgId, userIds])
  const preferenceByUser = new Map(preferences.rows.map(row => [String(row.user_id), row]))
  const endpointByRef = new Map(endpoints.rows.map(row => [JSON.stringify([row.user_id, row.id]), row]))
  const refs: Array<{ userId: string; endpointId: string }> = []
  const defaults: string[] = []
  for (const userId of userIds) {
    const preference = preferenceByUser.get(userId)
    const ids = [preference?.primary_endpoint_id, preference?.fallback_endpoint_id].filter((id): id is string => typeof id === 'string')
    for (const endpointId of ids) refs.push({ userId, endpointId })
    if (!ids.length && input.defaultConnectionId) defaults.push(userId)
  }
  const verified = refs.length ? await input.resolver.verifyEndpoints(db, { orgId: input.orgId, refs }) : []
  const derived = defaults.length && input.defaultConnectionId
    ? await input.resolver.deriveDefaultTargets(db, { orgId: input.orgId, connectionId: input.defaultConnectionId, userIds: defaults }) : []
  const byRef = new Map(refs.map((ref, index) => [JSON.stringify([ref.userId, ref.endpointId]), verified[index]]))
  const byDefault = new Map(defaults.map((userId, index) => [userId, derived[index]]))
  const batch: RecipientBatch = { recipients: new Map(), connections: new Set(), proofChangedEndpoints: 0, resolutionCounts: {} }
  for (const result of [...verified, ...derived]) {
    if (!result) throw new Error('routed_branch_error')
    const code = result.ok === true ? 'ok' : result.code
    batch.resolutionCounts[code] = (batch.resolutionCounts[code] ?? 0) + 1
  }
  batch.proofChangedEndpoints = verified.filter(result => result.ok === false && result.code === 'proof_changed').length
  function candidate(result: ResolveResult | undefined, source: RouteSource, endpoint?: Row): RouteCandidate {
    if (!result) throw new Error('routed_branch_error')
    const provider = endpoint ? String(endpoint.provider) : result.ok === true ? result.target.provider : null
    const resolution: RouteCandidate['resolution'] = endpoint && endpoint.status !== 'active'
      ? { ok: false, code: endpoint.status === 'stale' ? 'target_endpoint_stale' : 'target_endpoint_revoked' }
      : result.ok === false ? { ok: false, code: RESOLVE_EXCLUSIONS[result.code] }
        : { ok: true, target: {
          routeSource: source, connectionId: result.target.connectionId,
          endpointId: endpoint ? String(endpoint.id) : null, endpointRevision: endpoint ? Number(endpoint.revision) : null,
          proofId: result.target.proofId, addressKind: result.target.addressKind,
          addressWitness: result.target.addressWitness, proofWitness: result.target.proofWitness,
          boundTenant: result.target.boundTenant, boundAppScope: result.target.boundAppScope,
        } }
    if (endpoint) batch.connections.add(String(endpoint.connection_id))
    if (result.ok) batch.connections.add(result.target.connectionId)
    return { provider, rank: source === 'org_default' ? null : source === 'user_primary' ? 0 : 1,
      inProfile: provider === null || !!input.topic.profiles[provider], resolution,
      capability: { effective: false, reason: 'read_failed' }, verificationLevel: null, adapterAvailable: false }
  }
  for (const userId of userIds) {
    const row = preferenceByUser.get(userId)
    const preference: TopicPreferenceView | null = row ? {
      enabled: row.enabled === true, revision: Number(row.revision),
      primaryEndpointId: row.primary_endpoint_id === null ? null : String(row.primary_endpoint_id),
      fallbackEndpointId: row.fallback_endpoint_id === null ? null : String(row.fallback_endpoint_id),
      quietHours: row.quiet_start === null ? null : { start: String(row.quiet_start), end: String(row.quiet_end), timeZone: String(row.quiet_timezone) },
    } : null
    const candidates: RouteCandidate[] = []
    for (const [id, source] of [[preference?.primaryEndpointId, 'user_primary'], [preference?.fallbackEndpointId, 'user_fallback']] as const) {
      if (id) candidates.push(candidate(byRef.get(JSON.stringify([userId, id])), source, endpointByRef.get(JSON.stringify([userId, id]))))
    }
    if (!candidates.length && input.defaultConnectionId) candidates.push(candidate(byDefault.get(userId), 'org_default'))
    batch.recipients.set(userId, { preference, candidates })
  }
  return batch
}
