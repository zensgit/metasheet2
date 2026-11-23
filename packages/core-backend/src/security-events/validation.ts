import { isDeepStrictEqual } from 'node:util'
import { BOOLEAN_FACTS, COUNT_FACTS, REASON_CODES, eventRule, type AuthorityKind, type EventType, type ScopeKind } from './registry'

export class EventWriteUnavailable extends Error {
  readonly code = 'E1_WRITE_UNAVAILABLE'
  readonly status = 503
  constructor() { super('E1_WRITE_UNAVAILABLE') }
}
export class EventIdentityConflict extends EventWriteUnavailable {
  readonly diagnostic = 'event_identity_conflict'
}
export function writeFailure(error: unknown): EventWriteUnavailable {
  return error instanceof EventIdentityConflict ? new EventIdentityConflict() : new EventWriteUnavailable()
}
export const unavailable = (): never => { throw new EventWriteUnavailable() }

export type EventScope = Readonly<{ scope_kind: ScopeKind; org_id: string | null }>
/** These snapshots belong to server-side adapters, never request bodies or JWT claims. */
export type ScopeAuthority = Readonly<{
  kind: AuthorityKind
  orgId: string | null
  /** Required for all non-strict deprovision events, including restore/compensation. */
  parentOrgId?: string | null
}>

export function internalId(value: unknown): value is string {
  return typeof value === 'string' && [...value].length >= 1 && [...value].length <= 128
    && !/[\s@]/u.test(value) && ![...value].some(char => char.codePointAt(0)! < 32 || char.codePointAt(0) === 127) && !value.includes('://')
    && !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)
    && !/^eyJ[^.]*\.[^.]+\./.test(value)
}
export function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export function resolveEventScope(type: EventType, step: string, authority: ScopeAuthority): EventScope {
  const rule = eventRule(type)
  if (!rule || !authority || typeof authority !== 'object') return unavailable()
  // Each authority field is read exactly once into a frozen copy; the scope is resolved from that copy only.
  const copy: ScopeAuthority = Object.freeze({ kind: authority.kind, orgId: authority.orgId, parentOrgId: authority.parentOrgId })
  if (copy.kind !== rule.authority) return unavailable()
  let org = copy.orgId
  if (copy.kind === 'deprovision' && type !== 'deprovision.strict_grant_revoked') {
    // A NULL child inherits its verified parent; disagreement is a gap.
    if (!internalId(copy.parentOrgId) || (org !== null && org !== copy.parentOrgId)) return unavailable()
    org = copy.parentOrgId
  }
  const scope: ScopeKind = org === null ? 'system' : 'organization'
  if (!rule.scopes.includes(scope) || (org !== null && !internalId(org))) return unavailable()
  if (rule.stepScopes?.[step] && rule.stepScopes[step] !== scope) return unavailable()
  if (type === 'directory.projection_observed') {
    const global = ['governance_roles', 'governance_admissions', 'projected_groups_created', 'projected_groups_synced', 'projected_memberships'].includes(step)
    if (global !== (scope === 'system')) return unavailable()
  }
  return Object.freeze({ scope_kind: scope, org_id: org })
}

/** Length prefixes count UTF-8 bytes, not delimiters or UTF-16 code units. Never hashes/truncates. */
export function encodeSource(parts: readonly string[], maxCharacters = 512): string {
  if (!parts.length || parts.some(part => !internalId(part))) return unavailable()
  const value = parts.map(part => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('')
  if ([...value].length > maxCharacters || Buffer.byteLength(value, 'utf8') > 2048) return unavailable()
  return value
}

function sourceParts(value: unknown): string[] | null {
  if (typeof value !== 'string' || [...value].length > 512 || Buffer.byteLength(value) > 2048) return null
  const bytes = Buffer.from(value, 'utf8')
  let offset = 0
  const parts: string[] = []
  while (offset < bytes.length) {
    const colon = bytes.indexOf(58, offset)
    if (colon < 0) return null
    const prefix = bytes.subarray(offset, colon).toString('ascii')
    if (!/^[1-9][0-9]{0,3}$/.test(prefix)) return null
    const size = Number(prefix), end = colon + 1 + size
    if (end > bytes.length) return null
    const part = bytes.subarray(colon + 1, end).toString('utf8')
    if (!internalId(part) || !Buffer.from(part).equals(bytes.subarray(colon + 1, end))) return null
    offset = end; parts.push(part)
  }
  return parts.length ? parts : null
}

export function validSource(value: unknown): value is string {
  return uuid(value) || sourceParts(value) !== null
}

export function authorizationSource(actorId: string, operationId: string): string {
  if (!uuid(operationId)) return unavailable()
  return encodeSource([actorId, operationId], 192)
}
export function strictRevocationSource(runId: string, accountId: string, orgId: string, userId: string): string {
  if (!uuid(runId) || !uuid(accountId)) return unavailable()
  return encodeSource([runId, accountId, orgId, userId], 448)
}

export function auditSource(id: string, createdAtMicroseconds: string): string {
  if (!/^[0-9]+$/.test(id) || !/^[0-9]{1,20}$/.test(createdAtMicroseconds)) return unavailable()
  return encodeSource([id, createdAtMicroseconds])
}

export type EventCandidate = {
  id: string
  producer: string
  event_type: EventType
  source_kind: string
  source_id: string
  source_step: string
  actor_kind: 'user' | 'system' | 'anonymous'
  actor_user_id: string | null
  subject_user_id: string | null
  target_kind: 'integration' | 'user' | 'membership' | 'grant' | 'operation' | 'run' | 'component' | null
  target_id: string | null
  reason_code: string | null
  record_origin: 'live' | 'backfill' | 'reconcile'
  occurred_at: string
  facts: Record<string, number | boolean>
}
export type ValidatedEvent = Readonly<EventCandidate & EventScope & {
  schema_version: 1
  outcome: 'succeeded' | 'denied' | 'failed' | 'observed'
  severity: 'info' | 'warning' | 'error' | 'critical'
}>
const CANDIDATE_KEYS = ['id', 'producer', 'event_type', 'source_kind', 'source_id', 'source_step', 'actor_kind', 'actor_user_id', 'subject_user_id', 'target_kind', 'target_id', 'reason_code', 'record_origin', 'occurred_at', 'facts']
const TARGETS = ['integration', 'user', 'membership', 'grant', 'operation', 'run', 'component']

export function validateEvent(input: EventCandidate, authority: ScopeAuthority): ValidatedEvent {
  // One plain snapshot of the own enumerable string keys and values, each read exactly once.
  // Keys and values are checked on this snapshot only, and only it is returned and stored.
  const snapshot: Record<string, unknown> | null = input && typeof input === 'object' ? Object.fromEntries(Object.entries(input)) : null
  if (!snapshot || Object.keys(snapshot).length !== CANDIDATE_KEYS.length || CANDIDATE_KEYS.some(key => !Object.hasOwn(snapshot, key))) return unavailable()
  const candidate = Object.fromEntries(CANDIDATE_KEYS.map(key => [key, snapshot[key]])) as EventCandidate
  const rule = eventRule(candidate.event_type)
  const autoGrant = candidate.event_type === 'admin.login_grant_changed' && candidate.source_step === 'auto_grant'
  if (!rule || candidate.producer !== (autoGrant ? 'directory' : rule.producer)
    || !rule.sourceKinds.includes(candidate.source_kind as never) || !rule.steps.includes(candidate.source_step)
    || !uuid(candidate.id) || !['live', 'backfill', 'reconcile'].includes(candidate.record_origin)
    || !validSource(candidate.source_id)
    || [...candidate.source_id].length > 512 || Buffer.byteLength(candidate.source_id, 'utf8') > 2048
    || (candidate.reason_code !== null && !REASON_CODES.includes(candidate.reason_code as never))) return unavailable()
  if (!['user', 'system', 'anonymous'].includes(candidate.actor_kind)
    || (candidate.actor_kind === 'user' ? !internalId(candidate.actor_user_id) : candidate.actor_user_id !== null)
    || (candidate.subject_user_id !== null && !internalId(candidate.subject_user_id))
    || (candidate.target_kind === null ? candidate.target_id !== null : !TARGETS.includes(candidate.target_kind) || !internalId(candidate.target_id))) return unavailable()
  if (typeof candidate.occurred_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(candidate.occurred_at)
    || !Number.isFinite(Date.parse(candidate.occurred_at))) return unavailable()
  const reasons: readonly (string | null)[] = candidate.source_kind === 'request_window' && candidate.event_type !== 'system.event_store_gap'
    ? ['refusal_window'] : candidate.event_type === 'directory.sync_failed' ? ['sync_failed']
      : candidate.event_type === 'directory.deprovision_blocked' ? ['empty_directory_fetch', 'batch_exceeds_max', null]
        : candidate.event_type === 'webhook.redirect_refused' ? ['redirect_refused', null]
          : candidate.event_type === 'system.event_store_gap' ? ['startup_tail_unverified', 'aggregation_overflow', 'scan_interrupted', 'event_store_unavailable', 'source_missing'] : [null]
  if (!reasons.includes(candidate.reason_code)) return unavailable()
  if (!candidate.facts || Object.getPrototypeOf(candidate.facts) !== Object.prototype) return unavailable()
  const facts: Record<string, number | boolean> = {}
  for (const [key, value] of Object.entries(candidate.facts)) {
    if (!rule.facts.includes(key)) return unavailable()
    if (BOOLEAN_FACTS.includes(key as never)) { if (typeof value !== 'boolean') return unavailable() }
    else if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0
      || (COUNT_FACTS.includes(key as never) && value > 2147483647)) return unavailable()
    // Negative zero is stored as 0, so it is compared as 0 as well.
    facts[key] = value === 0 ? 0 : value
  }
  if (Buffer.byteLength(JSON.stringify(facts)) > 2048) return unavailable()
  const scope = resolveEventScope(candidate.event_type, candidate.source_step, authority)
  if (candidate.source_kind === 'request_window' && candidate.event_type !== 'system.event_store_gap') {
    if (candidate.reason_code !== 'refusal_window' || candidate.actor_kind !== 'anonymous'
      || candidate.actor_user_id !== null || candidate.subject_user_id !== null || candidate.target_kind !== null
      || !Object.hasOwn(facts, 'attempt_count')) return unavailable()
  }
  if (candidate.event_type === 'directory.sync_failed' && candidate.reason_code !== 'sync_failed') return unavailable()
  if (candidate.event_type === 'directory.projection_observed') {
    const governance = scope.scope_kind === 'system'
    const summary = ['scan_completed', 'organization_daily_summary'].includes(candidate.source_step)
    const parts = sourceParts(candidate.source_id)
    const day = candidate.occurred_at.slice(0, 10)
    if (governance ? !uuid(candidate.source_id) : !parts || (summary
      ? parts.length !== 2 || parts[0] !== scope.org_id || parts[1] !== day
      : candidate.source_step === 'membership_active'
        ? parts.length !== 3 || parts[0] !== candidate.subject_user_id || parts[1] !== scope.org_id || parts[2] !== day
        : parts.length !== 4 || !internalId(parts[0]) || parts[1] !== candidate.subject_user_id || parts[2] !== scope.org_id || parts[3] !== day)) return unavailable()
    if (candidate.actor_kind !== 'system' || candidate.target_kind !== null || candidate.reason_code !== null
      || candidate.source_kind !== (governance ? 'sync_run' : 'runtime_probe')
      || (governance || summary ? candidate.subject_user_id !== null : !internalId(candidate.subject_user_id))
      || (governance || summary ? Object.keys(facts).length !== 1 || !Object.hasOwn(facts, 'affected_count') : Object.keys(facts).length !== 0)
      || (governance && !(typeof facts.affected_count === 'number' && facts.affected_count > 0))) return unavailable()
  }
  if (candidate.source_kind === 'admin_grant_command') {
    const parts = sourceParts(candidate.source_id)
    if (!parts || parts.length !== 2 || !/^[0-9]+$/.test(parts[0]) || !/^[0-9]{1,20}$/.test(parts[1])) return unavailable()
  }
  if (candidate.event_type === 'deprovision.strict_grant_revoked') {
    const parts = sourceParts(candidate.source_id)
    if (!isDeepStrictEqual(facts, { grant_revoked: true }) || !parts || parts.length !== 4
      || !uuid(parts[0]) || !uuid(parts[1]) || parts[2] !== scope.org_id || parts[3] !== candidate.subject_user_id
      || [...candidate.source_id].length > 448) return unavailable()
  }
  if (candidate.event_type === 'authorization.operation_committed' && [...candidate.source_id].length > 192) return unavailable()
  if (candidate.event_type === 'system.event_store_gap' && facts.count_unknown !== true) return unavailable()
  return Object.freeze({ ...candidate, facts: Object.freeze(facts), ...scope, schema_version: 1, outcome: rule.outcome, severity: rule.severity })
}

/** Replays freeze the first fact time, origin and retention, including current-state observations. */
export function sameEventIdentity(stored: Record<string, unknown>, candidate: ValidatedEvent): boolean {
  const excluded = new Set(['id', 'occurred_at', 'record_origin'])
  return Object.entries(candidate).every(([key, value]) => excluded.has(key) || isDeepStrictEqual(stored[key], value))
}
