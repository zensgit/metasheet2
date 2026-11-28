import { randomUUID } from 'node:crypto'
import { EVENT_COLUMNS, readEventRows, type EventReadSnapshot, type VerifiedEventReadScope, type EventSql } from './runtime'
import type { EventConnections, W1Capacity, W1Transaction } from './runtime'
import { EventIdentityConflict, EventWriteUnavailable, writeFailure, encodeSource, internalId, sameEventIdentity, uuid, validSource, validateEvent, type EventCandidate, type ScopeAuthority } from './validation'
import { BOOLEAN_FACTS, COUNT_FACTS, eventRule } from './registry'

export type Retention = Readonly<{ eventDays: number; deliveryDays: number }>
export const CANDIDATE_RETENTION: Retention = Object.freeze({ eventDays: 365, deliveryDays: 90 })
export type DirectorySchedulerObservation = Readonly<{
  kind: 'schedule_invalid' | 'reclaim' | 'bootstrap' | 'refresh'
  integrationId: string | null
}>
export type DirectoryRunObservation = Readonly<{
  kind: 'diagnostic_failed' | 'binding_sweep_failed' | 'post_commit_failed'
  runId: string
  integrationId: string
}>
type DirectoryObservation = DirectorySchedulerObservation | DirectoryRunObservation
export type ObservationDiagnostic = 'source_missing' | 'mapping_rejected' | 'event_identity_conflict' | 'event_store_unavailable'
type ObservationSnapshot = Readonly<{ input: EventCandidate; authority: ScopeAuthority }>
function retention(value: Retention): Retention {
  if (!Number.isSafeInteger(value.eventDays) || !Number.isSafeInteger(value.deliveryDays)
    || value.eventDays <= 0 || value.deliveryDays <= 0 || value.deliveryDays > value.eventDays || value.eventDays > 3650) throw new EventWriteUnavailable()
  return Object.freeze({ ...value })
}

async function append(sql: EventSql, input: EventCandidate, authority: ScopeAuthority, policy: Retention): Promise<string> {
  const event = validateEvent(input, authority)
  const columns = Object.keys(event)
  // Column identifiers come only from validateEvent's fixed output, never unchecked input.
  const values: unknown[] = Object.values(event)
  values.push(policy.eventDays)
  const inserted = await sql.query<{ id: string }>(`INSERT INTO public.security_events (${columns.join(', ')}, recorded_at, expires_at)
    VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')}, clock_timestamp(), clock_timestamp() + $${values.length} * interval '1 day')
    ON CONFLICT (producer, source_kind, source_id, source_step, event_type) DO NOTHING RETURNING id`, values)
  if (inserted.rows[0]) return inserted.rows[0].id
  const existing = await sql.query(`SELECT ${EVENT_COLUMNS} FROM public.security_events
    WHERE producer=$1 AND source_kind=$2 AND source_id=$3 AND source_step=$4 AND event_type=$5`,
  [event.producer, event.source_kind, event.source_id, event.source_step, event.event_type])
  if (!existing.rows[0] || !sameEventIdentity(existing.rows[0], event)) throw new EventIdentityConflict()
  return existing.rows[0].id as string
}

/** No singleton/boot registration. No method changes an event fact or sends a message. */
export class SecurityEventRepository {
  #directoryBoot = randomUUID()
  readonly policy: Retention
  constructor(private readonly connections: EventConnections, private readonly w1: W1Capacity, policy: Retention = CANDIDATE_RETENTION) {
    this.policy = retention(policy)
  }
  async appendW1(tx: W1Transaction, input: EventCandidate, authority: ScopeAuthority, proofUser?: string): Promise<string> {
    try { return await this.w1.run(tx, sql => append(sql, input, authority, this.policy), proofUser) }
    catch (error) { throw writeFailure(error) }
  }
  /** Call after the observed action is settled, and after confirmed COMMIT for transactional facts. */
  async appendCommitted(input: EventCandidate, authority: ScopeAuthority, mode: 'foreground' | 'background' = 'foreground'): Promise<
    { recorded: true; eventId: string } | { recorded: false; code: 'E1_WRITE_UNAVAILABLE'; count_unknown: true; diagnostic?: 'event_identity_conflict' }
  > {
    try {
      const eventId = await this.connections.writeTransaction(mode, sql => append(sql, input, authority, this.policy))
      return { recorded: true, eventId }
    } catch (error) { return { recorded: false, code: 'E1_WRITE_UNAVAILABLE', count_unknown: true, ...(error instanceof EventIdentityConflict ? { diagnostic: 'event_identity_conflict' as const } : {}) } }
  }

  /** The caller has completed its source action. Resolution and insertion share one write budget. */
  async appendDirectoryObservation(observation: DirectoryObservation, occurredAt = new Date().toISOString()): Promise<{
    recorded: boolean; retry?: ObservationSnapshot; diagnostic?: ObservationDiagnostic
  }> {
    let retry: ObservationSnapshot | undefined
    let diagnostic: ObservationDiagnostic = 'mapping_rejected'
    try {
      const run = 'runId' in observation
      const { integrationId, kind } = observation
      if (run ? !['diagnostic_failed', 'binding_sweep_failed', 'post_commit_failed'].includes(kind) || !uuid(observation.runId)
        : !['schedule_invalid', 'reclaim', 'bootstrap', 'refresh'].includes(kind)) throw new EventWriteUnavailable()
      if (integrationId === null ? run || !['reclaim', 'bootstrap'].includes(kind) : !uuid(integrationId)) throw new EventWriteUnavailable()
      if (['reclaim', 'bootstrap'].includes(kind) && integrationId !== null) throw new EventWriteUnavailable()
      const snapshot = (orgId: string | null): ObservationSnapshot => {
        const authority: ScopeAuthority = Object.freeze({ kind: 'integration', orgId })
        const input: EventCandidate = Object.freeze({
          id: randomUUID(), producer: 'directory',
          event_type: run ? (kind === 'diagnostic_failed' ? 'directory.diagnostic_failed'
            : kind === 'binding_sweep_failed' ? 'directory.binding_sweep_failed' : 'directory.post_commit_failed')
            : kind === 'schedule_invalid' ? 'directory.schedule_invalid' : 'directory.scheduler_failed',
          source_kind: run ? 'sync_run' : 'runtime_probe',
          source_id: run ? observation.runId : kind === 'schedule_invalid'
            ? encodeSource([this.#directoryBoot, integrationId!]) : kind === 'refresh' ? randomUUID() : this.#directoryBoot,
          source_step: kind === 'diagnostic_failed' ? 'diagnostic' : kind === 'binding_sweep_failed' ? 'sweep' : kind,
          actor_kind: 'system', actor_user_id: null, subject_user_id: null,
          target_kind: run ? 'run' : integrationId === null ? null : 'integration',
          target_id: run ? observation.runId : integrationId,
          reason_code: null, record_origin: 'live', occurred_at: occurredAt, facts: Object.freeze({}),
        })
        validateEvent(input, authority)
        return Object.freeze({ input, authority })
      }
      // System observations have a complete scope before connection admission.
      if (integrationId === null) retry = snapshot(null)
      diagnostic = 'event_store_unavailable'
      await this.connections.writeTransaction('foreground', async sql => {
        if (integrationId !== null) {
          const result = await sql.query<{ id: string; org_id: string; run_id?: string }>(run
            ? `SELECT i.id, i.org_id, r.id AS run_id FROM public.directory_integrations i
              JOIN public.directory_sync_runs r ON r.integration_id=i.id
              WHERE i.id=$1 AND r.id=$2${kind === 'diagnostic_failed' ? '' : " AND r.status='completed' AND r.finished_at IS NOT NULL"}`
            : 'SELECT id, org_id FROM public.directory_integrations WHERE id=$1',
          run ? [integrationId, observation.runId] : [integrationId])
          const row = result.rows[0]
          diagnostic = 'source_missing'
          if (result.rows.length !== 1 || !row || row.id !== integrationId || !internalId(row.org_id)
            || (run && row.run_id !== observation.runId)) throw new EventWriteUnavailable()
          diagnostic = 'mapping_rejected'
          retry = snapshot(row.org_id)
        }
        diagnostic = 'event_store_unavailable'
        await append(sql, retry!.input, retry!.authority, this.policy)
      })
      return { recorded: true }
    } catch (error) {
      if (error instanceof EventIdentityConflict) return { recorded: false, diagnostic: 'event_identity_conflict' }
      return { recorded: false, diagnostic, ...(retry ? { retry } : {}) }
    }
  }

  /** Passive no-send planning primitive; scheduling and legacy eligibility belong to E1-F. */
  async planSkipped(eventId: string, code: 'channel_unconfigured' | 'source_not_eligible' | 'legacy_sent_observed' | 'legacy_outcome_unknown'): Promise<boolean> {
    try {
      if (!uuid(eventId) || !['channel_unconfigured', 'source_not_eligible', 'legacy_sent_observed', 'legacy_outcome_unknown'].includes(code)) throw new EventWriteUnavailable()
      return await this.connections.writeTransaction('background', async sql => {
        const row = await sql.query<{ id: string }>(`UPDATE public.security_events SET delivery_planned_at=clock_timestamp()
          WHERE id=$1 AND delivery_planned_at IS NULL RETURNING id`, [eventId])
        if (!row.rows.length) return false
        await sql.query(`INSERT INTO public.security_event_deliveries
          (id,event_id,channel,route_ref,attempt_no,status,result_code,created_at,due_at,finished_at,retry_safety,expires_at)
          SELECT $1,$2,'none','none',0,'skipped',$3,t,t,t,'not_applicable',t + $4 * interval '1 day' FROM (SELECT clock_timestamp() AS t) stamp`,
        [randomUUID(), eventId, code, this.policy.deliveryDays])
        return true
      })
    } catch { throw new EventWriteUnavailable() }
  }

  /** Owner confirmation is explicit; no timer or caller is installed by E1-A. */
  async cleanup(ownerConfirmed: boolean, batchSize = 1000): Promise<{ enabled: boolean; deliveries: number; events: number; activeExpired: boolean; diagnostic?: 'active_delivery_expired' }> {
    if (ownerConfirmed !== true) return { enabled: false, deliveries: 0, events: 0, activeExpired: false }
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new EventWriteUnavailable()
    return this.connections.writeTransaction('background', async sql => {
      const active = await sql.query<{ present: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM public.security_events e JOIN public.security_event_deliveries d ON d.event_id=e.id
        WHERE e.expires_at <= clock_timestamp() AND d.status IN ('queued','sending')) AS present`)
      const children = await sql.query(`WITH expired AS (
        SELECT id FROM public.security_event_deliveries WHERE expires_at <= clock_timestamp()
        AND status IN ('succeeded','failed','unknown','skipped') ORDER BY expires_at,id LIMIT $1 FOR UPDATE SKIP LOCKED)
        DELETE FROM public.security_event_deliveries d USING expired x WHERE d.id=x.id RETURNING d.id`, [batchSize])
      const remaining = batchSize - children.rows.length
      const parents = remaining === 0 ? { rows: [] } : await sql.query(`WITH expired AS (
        SELECT id FROM public.security_events e WHERE expires_at <= clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM public.security_event_deliveries d WHERE d.event_id=e.id)
        ORDER BY expires_at,id LIMIT $1 FOR UPDATE SKIP LOCKED)
        DELETE FROM public.security_events e USING expired x WHERE e.id=x.id RETURNING e.id`, [remaining])
      // The eventual worker must stop expired active work and emit the fixed diagnostic; never delete it.
      return { enabled: true, deliveries: children.rows.length, events: parents.rows.length, activeExpired: active.rows[0]?.present === true, ...(active.rows[0]?.present === true ? { diagnostic: 'active_delivery_expired' as const } : {}) }
    })
  }
}

/** No raw connections or caller-built scopes cross these read boundaries. */
export async function readScopedEvent(snapshot: EventReadSnapshot, scope: VerifiedEventReadScope, id: string): Promise<Record<string, unknown> | null> {
  const rows = await readEventRows(snapshot, scope, id, false)
  return rows[0] ? eventDto(rows[0]) : null
}
export async function readScopedDeliveries(snapshot: EventReadSnapshot, scope: VerifiedEventReadScope, id: string): Promise<Record<string, unknown>[]> {
  return readEventRows(snapshot, scope, id, true)
}

/** Unknown types never expose their facts. No joins to identity or original audit contents. */
export function eventDto(row: Record<string, unknown>): Record<string, unknown> {
  const rule = typeof row.event_type === 'string' ? eventRule(row.event_type) : undefined
  const dto: Record<string, unknown> = {}
  for (const key of EVENT_COLUMNS.split(', ')) dto[key] = row[key]
  dto.event_type = rule ? row.event_type : 'unknown_event_type'
  const facts: Record<string, number | boolean> = {}
  if (rule && row.facts && typeof row.facts === 'object' && !Array.isArray(row.facts)) {
    for (const key of rule.facts) {
      const value = (row.facts as Record<string, unknown>)[key]
      if (BOOLEAN_FACTS.includes(key as never) ? typeof value === 'boolean'
        : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && (!COUNT_FACTS.includes(key as never) || value <= 2147483647)) facts[key] = value as number | boolean
    }
  }
  for (const key of ['org_id', 'actor_user_id', 'subject_user_id', 'target_id']) {
    if (dto[key] !== null && !internalId(dto[key])) dto[key] = null
  }
  if (!validSource(dto.source_id)) dto.source_id = null
  dto.facts = facts
  if (!rule) { dto.source_step = 'unknown'; dto.reason_code = null }
  if (row.event_type === 'directory.projection_observed') {
    dto.observed_at = row.occurred_at
    dto.time_semantics = 'observed_state_not_grant_time'
    dto.coverage = row.source_step === 'scan_completed' ? 'scan_completed' : 'not_established_by_this_record'
  }
  return dto
}

export function estimateSteadyState(users: number, eventDays: number, deliveryDays: number, sessionsPerUserPerDay: number) {
  if (![users, eventDays, deliveryDays, sessionsPerUserPerDay].every(x => Number.isSafeInteger(x) && x >= 0)) throw new EventWriteUnavailable()
  const dailyObservations = users * 2
  const dailySessions = users * sessionsPerUserPerDay
  return { dailyObservations, dailySessions, events: (dailyObservations + dailySessions) * eventDays,
    deliveries: (dailyObservations + dailySessions) * deliveryDays, total: (dailyObservations + dailySessions) * (eventDays + deliveryDays) }
}
