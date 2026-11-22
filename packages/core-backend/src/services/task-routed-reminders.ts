import { randomUUID } from 'node:crypto'
import { pool } from '../db/pg'
import { resolveEffectiveNotificationCapabilityForBackground } from '../integrations/integration-capability-resolve-background'
import { metrics } from '../metrics/metrics'
import { resolveNotificationAdapter } from '../notifications/adapters/notification-adapter'
import { readRecipientRouteInputs } from '../notifications/route-inputs'
import { createRecipientResolver, type Db } from '../notifications/recipient-resolver'
import { decideRoute, ROUTER_VERSION, type RouteCandidate, type RouteDecision } from '../notifications/router'
import { resolveNotificationTopic } from '../notifications/topic-registry'
import { checkNotificationVerificationRow } from '../notifications/verification-evidence'
import { sha256Hex, WITNESS_DOMAINS } from '../notifications/witness'
import { planTaskReminderDeliveries, type TaskAssigneeCompletionShape } from '../tasks/task-notifications'
import { findActiveOrgMembers } from './task-org-members'
import type { TaskSchedulerJobContext } from './task-scheduler'
import type { TopicTakeover } from './task-notification-takeover'

export const ROUTED_BRANCH_BUDGET_MS = 10_000
// Largest phase: BEGIN + two SETs + six authority reads + COMMIT + one fingerprint read.
export const ROUTED_BRANCH_MAX_STATEMENTS_BETWEEN_HEARTBEATS = 11
export type RoutingTransaction = <T>(fn: (db: Db) => Promise<T>) => Promise<T>

/** Explicit isolation, on the same physical connection as both bounded settings and all six reads. */
export const routedCapabilityTransaction: RoutingTransaction = async fn => {
  if (!pool) throw new Error('capability_unreadable')
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    const value = await fn(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally { client.release() }
}

export interface RoutedRecipient {
  orgId: string
  userId: string
  taskId: string
  remindAt: string
  role: string
  eventKey: string
  legacySourceKey: string
}
export interface RecipientDecision { recipient: RoutedRecipient; decision: RouteDecision }

export const ROUTED_OWNERSHIP_PREDICATE = `NOT EXISTS (SELECT 1 FROM task_notification_delivery_decisions d
      WHERE d.org_id = r.org_id AND d.recipient_user_id = r.recipient_user_id AND d.event_key = r.event_key AND d.rank = 0)
    AND NOT EXISTS (SELECT 1 FROM task_notification_deliveries l
      WHERE l.org_id = r.org_id AND l.source_key = r.legacy_source_key)`
const DECISION_COLUMNS = `delivery_id, org_id, recipient_user_id, event_key, rank, route_source, connection_id,
  endpoint_id, endpoint_revision, preference_revision, policy_revision, capability_revision, capability_witness,
  verification_level, address_kind, address_witness, proof_witness, bound_tenant, bound_app_scope,
  fallback, excluded, reason, depends_on_delivery_id, router_version, decided_at`
export const INSERT_ROUTED_REMINDERS_SQL = `WITH r AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(
    delivery_id uuid, org_id text, recipient_user_id text, event_key text, rank smallint,
    task_id text, source_key text, legacy_source_key text, role text, channel text, status text, last_error text, payload jsonb,
    route_source text, connection_id uuid, endpoint_id uuid, endpoint_revision bigint, preference_revision bigint,
    policy_revision bigint, capability_revision bigint, capability_witness text, verification_level text,
    address_kind text, address_witness text, proof_witness text, bound_tenant text, bound_app_scope text,
    fallback jsonb, excluded jsonb, reason text, depends_on_delivery_id uuid, router_version smallint, decided_at timestamptz)
), d AS (
  INSERT INTO task_notification_delivery_decisions (${DECISION_COLUMNS})
  SELECT ${DECISION_COLUMNS.split(',').map(column => `r.${column.trim()}`).join(', ')} FROM r
  WHERE ${ROUTED_OWNERSHIP_PREDICATE}
  ON CONFLICT (org_id, recipient_user_id, event_key, rank) DO NOTHING RETURNING delivery_id
)
INSERT INTO task_notification_deliveries
  (id, org_id, source_type, source_id, source_key, recipient_user_id, recipient_role, channel, status, last_error, payload)
SELECT r.delivery_id, r.org_id, 'task_reminder', r.task_id, r.source_key, r.recipient_user_id, r.role,
  r.channel, r.status, r.last_error, r.payload FROM r JOIN d ON d.delivery_id = r.delivery_id
ON CONFLICT (org_id, source_key) DO NOTHING RETURNING id`

export async function insertRoutedReminderDeliveries(db: Db, decisions: readonly RecipientDecision[], now: Date): Promise<number> {
  const rows = decisions.flatMap(({ recipient, decision }) => {
    if (decision.kind === 'defer') return []
    const target = decision.kind === 'route' ? decision.targets[0] : null
    const reason = decision.kind === 'skip' ? decision.code : null
    return [{
      delivery_id: randomUUID(), org_id: recipient.orgId, recipient_user_id: recipient.userId, event_key: recipient.eventKey,
      task_id: recipient.taskId, role: recipient.role, legacy_source_key: recipient.legacySourceKey, rank: 0,
      source_key: 'routed:v1:task_reminder:' + sha256Hex(WITNESS_DOMAINS.eventKey, {
        org: recipient.orgId, topic: 'task_reminder', eventKey: recipient.eventKey, recipient: recipient.userId,
        rank: 0, connectionId: target?.connectionId ?? null, endpointRef: target ? target.endpointId ?? target.proofId : null,
      }),
      channel: target ? 'routed_dingtalk_work_notification' : 'routed_decision', status: target ? 'pending' : 'skipped',
      last_error: reason, payload: { kind: 'task_reminder', taskId: recipient.taskId, remindAt: recipient.remindAt },
      route_source: target?.routeSource ?? null, connection_id: target?.connectionId ?? null,
      endpoint_id: target?.endpointId ?? null, endpoint_revision: target?.endpointRevision ?? null,
      preference_revision: decision.preferenceRevision, policy_revision: decision.policyRevision,
      capability_revision: target?.capabilityRevision ?? null, capability_witness: target?.capabilityWitness ?? null,
      verification_level: target?.verificationLevel ?? null, address_kind: target?.addressKind ?? null,
      address_witness: target?.addressWitness ?? null, proof_witness: target?.proofWitness ?? null,
      bound_tenant: target?.boundTenant ?? null, bound_app_scope: target?.boundAppScope ?? null,
      fallback: decision.kind === 'route' ? decision.targets[1] ?? null : null,
      excluded: decision.excluded, reason, depends_on_delivery_id: null, router_version: ROUTER_VERSION, decided_at: now.toISOString(),
    }]
  })
  if (!rows.length) return 0
  return (await db.query(INSERT_ROUTED_REMINDERS_SQL, [JSON.stringify(rows)])).rows.length
}

export async function writeRoutedReminderOrg(input: {
  db: Db
  ctx: TaskSchedulerJobContext
  tasks: readonly Record<string, unknown>[]
  policy: Extract<TopicTakeover, { state: 'active' }>
  now: Date
  transaction?: RoutingTransaction
  clock?: () => number
  warn: (code: string) => void
}): Promise<number> {
  const { db, ctx, policy, now } = input
  const orgId = String(input.tasks[0].org_id)
  if (input.tasks.some(task => task.org_id !== orgId)) throw new Error('routed_branch_error')
  const clock = input.clock ?? Date.now
  const started = clock()
  const defer = (code: string) => { metrics.notificationRoutingDecisionsTotal.inc({ topic: 'task_reminder', outcome: 'defer', reason: code }); return 0 }
  const heartbeat = async () => { await ctx.leaderHeartbeat?.(); return !(ctx.stopping() || ctx.leaderLost()) }
  if (!(await heartbeat())) return defer('routed_branch_stopped')
  const assignees = await db.query('SELECT task_id, user_id, completed_at FROM task_assignees WHERE task_id = ANY($1::text[])', [input.tasks.map(task => String(task.id))])
  const byTask = new Map<string, TaskAssigneeCompletionShape[]>()
  for (const row of assignees.rows) {
    const list = byTask.get(String(row.task_id)) ?? []
    list.push({ userId: String(row.user_id), completedAt: row.completed_at == null ? null : new Date(String(row.completed_at)) })
    byTask.set(String(row.task_id), list)
  }
  const recipients: RoutedRecipient[] = input.tasks.flatMap(task => {
    const remindAt = new Date(task.remind_at as string | Date)
    return planTaskReminderDeliveries({ orgId, taskId: String(task.id), remindAt, creatorId: String(task.created_by),
      assignees: byTask.get(String(task.id)) ?? [], channels: ['dingtalk_work_notification'] }).map(plan => ({
      orgId, userId: plan.recipientUserId, taskId: String(task.id), remindAt: remindAt.toISOString(), role: plan.recipientRole,
      eventKey: `task_reminder:${task.id}:${remindAt.toISOString()}`, legacySourceKey: plan.sourceKey,
    }))
  })
  if (!recipients.length) return 0
  const pendingRows = await db.query(`WITH r AS (SELECT * FROM jsonb_to_recordset($1::jsonb)
    AS r(ordinal integer, org_id text, recipient_user_id text, event_key text, legacy_source_key text))
    SELECT r.ordinal, 'pending' AS outcome, 1 AS count FROM r WHERE ${ROUTED_OWNERSHIP_PREDICATE}
    UNION ALL SELECT NULL, 'already_decided', count(*)::integer FROM r
      WHERE EXISTS (SELECT 1 FROM task_notification_delivery_decisions d
        WHERE d.org_id = r.org_id AND d.recipient_user_id = r.recipient_user_id AND d.event_key = r.event_key AND d.rank = 0)
    UNION ALL SELECT NULL, 'legacy_owns', count(*)::integer FROM r
      WHERE NOT EXISTS (SELECT 1 FROM task_notification_delivery_decisions d
        WHERE d.org_id = r.org_id AND d.recipient_user_id = r.recipient_user_id AND d.event_key = r.event_key AND d.rank = 0)
      AND EXISTS (SELECT 1 FROM task_notification_deliveries l WHERE l.org_id = r.org_id AND l.source_key = r.legacy_source_key)`,
  [JSON.stringify(recipients.map((recipient, ordinal) => ({
    ordinal, org_id: recipient.orgId, recipient_user_id: recipient.userId, event_key: recipient.eventKey, legacy_source_key: recipient.legacySourceKey,
  })))])
  const pending = pendingRows.rows.filter(row => row.outcome === 'pending').map(row => recipients[Number(row.ordinal)])
  for (const outcome of ['already_decided', 'legacy_owns']) {
    const count = Number(pendingRows.rows.find(row => row.outcome === outcome)?.count ?? 0)
    metrics.notificationRoutingDecisionsTotal.inc({ topic: 'task_reminder', outcome, reason: '' }, count)
  }
  if (!pending.length) return 0
  const userIds = [...new Set(pending.map(recipient => recipient.userId))]
  const active = await findActiveOrgMembers(db, orgId, userIds)
  const resolver = createRecipientResolver({ isActiveOrgMembers: async (_db, _org, ids) => new Set(ids.filter(id => active.has(id))) })
  const batch = await readRecipientRouteInputs(db, { orgId, userIds, defaultConnectionId: policy.defaultConnectionId,
    topic: resolveNotificationTopic('task_reminder')!, resolver })
  if (!(await heartbeat())) return defer('routed_branch_stopped')
  if (clock() - started > ROUTED_BRANCH_BUDGET_MS) return defer('routed_branch_budget')
  const evidence = batch.connections.size ? await db.query(`SELECT connection_id::text, provider, reached_level, tuple_fingerprint,
    bound_tenant, bound_app_scope, verified_at, invalidated_at FROM notification_connection_verifications WHERE connection_id = ANY($1::uuid[])`, [[...batch.connections]]) : { rows: [] }
  const readiness = new Map<string, { capability: RouteCandidate['capability']; fingerprint: string | null; available: boolean }>()
  for (const connectionId of batch.connections) {
    if (!(await heartbeat())) return defer('routed_branch_stopped')
    let capability: RouteCandidate['capability']
    let fingerprint: string | null = null
    let available = false
    try {
      const result = await (input.transaction ?? routedCapabilityTransaction)(async client => {
        await client.query("SET LOCAL lock_timeout = '2s'")
        await client.query("SET LOCAL statement_timeout = '5s'")
        const decision = await resolveEffectiveNotificationCapabilityForBackground({ query: async (sql, params) => {
          const result = await client.query(sql, params); return { rows: result.rows, rowCount: result.rows.length }
        } }, { integrationId: connectionId, eventOrgId: orgId })
        if (decision.effective === false && decision.reason === 'read_failed') throw new Error('capability_unreadable')
        return decision
      })
      capability = result
      if (result.effective && result.orgId !== orgId) {
        capability = { effective: false, reason: 'org_mismatch' }
        input.warn('routed_decision_mismatch')
      } else if (result.effective) {
        try {
          const adapter = resolveNotificationAdapter(result.provider)
          available = adapter.transport === resolveNotificationTopic('task_reminder')?.profiles[result.provider]?.transport
          const value = await adapter.fingerprint(connectionId)
          fingerprint = value.ok ? value.value : null
        } catch { available = false }
      }
    } catch { capability = { effective: false, reason: 'read_failed' } }
    readiness.set(connectionId, { capability, fingerprint, available })
  }
  if (!(await heartbeat())) return defer('routed_branch_stopped')
  if (clock() - started > ROUTED_BRANCH_BUDGET_MS) return defer('routed_branch_budget')
  const decisions = pending.map(recipient => {
    const inputs = batch.recipients.get(recipient.userId)!
    for (const candidate of inputs.candidates) {
      if (candidate.resolution.ok === false) continue
      const target = candidate.resolution.target
      const ready = readiness.get(target.connectionId)!
      candidate.capability = ready.capability
      candidate.adapterAvailable = ready.available
      const verified = checkNotificationVerificationRow(evidence.rows.find(row => row.connection_id === target.connectionId), {
        connectionId: target.connectionId, provider: candidate.provider!, scope: { tenant: target.boundTenant, appScope: target.boundAppScope },
        tupleFingerprint: ready.fingerprint, now,
      })
      candidate.verificationLevel = verified.ok ? verified.verification.level : null
    }
    const decision = decideRoute({ state: policy.state, policyRevision: policy.revision, permitted: active.has(recipient.userId),
      preference: inputs.preference, candidates: inputs.candidates, now })
    metrics.notificationRoutingDecisionsTotal.inc({ topic: 'task_reminder', outcome: decision.kind, reason: decision.kind === 'route' ? '' : decision.code })
    return { recipient, decision }
  })
  return insertRoutedReminderDeliveries(db, decisions, now)
}
