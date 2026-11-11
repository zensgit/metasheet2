/**
 * Reading and writing the caller's own notification endpoints.
 *
 * An endpoint is made from a proof the caller already has (a directory link) on a named connection;
 * the request carries no recipient identifier. The address is derived again each time it is needed.
 * Responses and audit records carry ids, names, revisions and fixed codes only: never an address, a
 * witness or a proof id.
 */
import {
  evaluateIntegrationCapability,
  peekIntegrationCapabilityState,
  probeCapabilityTables,
  type CapabilityReason,
} from '../integrations/integration-capability-evaluate'
import { isDirectoryIntegrationCapabilitiesEnabled } from '../integrations/directory-integration-capabilities-flag'
import { isCapabilityImplementationAvailable } from '../integrations/integration-capability-implementations'
import { resolveProviderCapabilityDescriptor } from '../integrations/provider-capability-registry'
import { NotificationHttpError } from './notification-errors'
import {
  mapBusy,
  pgErrorOf,
  withUserLocks,
  type AuditEvent,
  type AuditSink,
  type NotificationDbDeps,
  type UserLockKey,
} from './notification-tx'
import { connectionLabel, type ProofKind } from './provider-notification-registry'
import type { Db, EndpointCandidate, RecipientResolver, ResolveFailureCode, ResolveResult } from './recipient-resolver'

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value))

export interface EndpointsServiceDeps extends NotificationDbDeps {
  readonly resolver: RecipientResolver
  readonly audit: AuditSink
  /** Whether the capability display is on; defaults to the capability switch. */
  readonly capabilitySwitchOn?: () => boolean
}

export type EndpointStatus = 'active' | 'stale'
export type UnusableReason = ResolveFailureCode | 'endpoint_stale'

export interface EndpointItem {
  id: string
  connection: { id: string; provider: string; label: string }
  addressKind: string
  proofKind: ProofKind
  status: EndpointStatus
  revision: number
  usable: boolean
  unusableReason: UnusableReason | null
  capability: { effective: boolean; reason: string | null }
  /** Connection verification evidence. No evidence is stored yet, so this is false. */
  verified: boolean
  lastVerifiedAt: string
}

export interface CandidateItem {
  connection: { id: string; provider: string; label: string }
  proofKind: ProofKind
  addressable: boolean
  reasonCode: ResolveFailureCode | null
  endpointId: string | null
}

export interface EndpointsListing {
  /** Delivery is not wired in this version: always disabled. */
  delivery: { enabled: false; testSendAvailable: false; reason: 'delivery_disabled' }
  endpoints: EndpointItem[]
  candidates: CandidateItem[]
}

export interface EndpointWriteResult {
  created: boolean
  endpoint: EndpointItem
}

export interface RevokeResult {
  id: string
  status: 'revoked'
  revision: number
}

type Row = Record<string, unknown>

const ENDPOINT_COLUMNS = `id::text AS id, org_id, user_id, connection_id::text AS connection_id, provider, address_kind, proof_kind,
       proof_id::text AS proof_id, proof_witness, address_witness, tenant_address_witness, bound_tenant, bound_app_scope,
       status, revision::text AS revision, last_verified_at, revoked_at`

const SELECT_OWN_SQL = `SELECT ${ENDPOINT_COLUMNS}
  FROM user_notification_endpoints
 WHERE org_id = $1 AND user_id = $2 AND status <> 'revoked'
 ORDER BY created_at, id`

const SELECT_ONE_SQL = `SELECT ${ENDPOINT_COLUMNS}
  FROM user_notification_endpoints
 WHERE id = $1::uuid AND org_id = $2 AND user_id = $3`

const SELECT_ONE_LOCKED_SQL = `${SELECT_ONE_SQL} FOR UPDATE`

const SELECT_SAME_PROOF_SQL = `SELECT ${ENDPOINT_COLUMNS}
  FROM user_notification_endpoints
 WHERE org_id = $1 AND user_id = $2 AND connection_id = $3::uuid AND address_kind = $4 AND proof_kind = $5
 FOR UPDATE`

// The active endpoint, of any user, connection or organization, that holds this address in this tenant.
const SELECT_ADDRESS_HOLDER_SQL = `SELECT ${ENDPOINT_COLUMNS}
  FROM user_notification_endpoints
 WHERE provider = $1 AND bound_tenant = $2 AND address_kind = $3 AND tenant_address_witness = $4 AND status = 'active'`

const SELECT_ADDRESS_HOLDER_LOCKED_SQL = `${SELECT_ADDRESS_HOLDER_SQL} FOR UPDATE`

const CONNECTION_NAMES_SQL = `SELECT id::text AS id, name FROM directory_integrations WHERE id = ANY($1::uuid[]) AND org_id = $2`

const INSERT_SQL = `INSERT INTO user_notification_endpoints
  (org_id, user_id, connection_id, provider, address_kind, proof_kind, proof_id, proof_witness, address_witness,
   tenant_address_witness, bound_tenant, bound_app_scope)
VALUES ($1, $2, $3::uuid, $4, $5, $6, $7::uuid, $8, $9, $10, $11, $12)
RETURNING id::text AS id, revision::text AS revision`

const REFRESH_SQL = `UPDATE user_notification_endpoints
   SET proof_id = $2::uuid, proof_witness = $3, address_witness = $4, tenant_address_witness = $5,
       bound_tenant = $6, bound_app_scope = $7, status = 'active', revoked_at = NULL,
       last_verified_at = now(), revision = revision + 1, updated_at = now()
 WHERE id = $1::uuid
RETURNING revision::text AS revision`

const DEMOTE_SQL = `UPDATE user_notification_endpoints
   SET status = 'stale', revision = revision + 1, updated_at = now()
 WHERE id = $1::uuid AND status = 'active'
RETURNING revision::text AS revision`

const REVOKE_SQL = `UPDATE user_notification_endpoints
   SET status = 'revoked', revoked_at = now(), revision = revision + 1, updated_at = now()
 WHERE id = $1::uuid
RETURNING revision::text AS revision`

// A revoked primary is replaced by the fallback, if there is one; a revoked fallback is cleared.
const CLEAR_PREFERENCES_SQL = `UPDATE user_notification_preferences
   SET primary_endpoint_id = CASE WHEN primary_endpoint_id = $1::uuid THEN fallback_endpoint_id ELSE primary_endpoint_id END,
       fallback_endpoint_id = CASE WHEN primary_endpoint_id = $1::uuid OR fallback_endpoint_id = $1::uuid THEN NULL ELSE fallback_endpoint_id END,
       revision = revision + 1, updated_by = $4, updated_at = now()
 WHERE org_id = $2 AND user_id = $3 AND (primary_endpoint_id = $1::uuid OR fallback_endpoint_id = $1::uuid)`

/** What a failed resolution is called to the caller. */
function resolutionError(code: ResolveFailureCode): NotificationHttpError {
  switch (code) {
    case 'proof_kind_unavailable':
      return new NotificationHttpError(409, 'PROOF_KIND_UNAVAILABLE')
    case 'address_kind_not_derivable':
      return new NotificationHttpError(409, 'ADDRESS_KIND_NOT_DERIVABLE')
    case 'proof_ambiguous':
      return new NotificationHttpError(409, 'PROOF_AMBIGUOUS')
    case 'scope_unproven':
    case 'scope_changed':
      return new NotificationHttpError(409, 'SCOPE_UNPROVEN')
    case 'user_not_active_member':
      return new NotificationHttpError(409, 'NOT_ACTIVE_MEMBER')
    case 'address_missing':
    case 'address_unusable':
      return new NotificationHttpError(409, 'ADDRESS_UNUSABLE')
    default:
      return new NotificationHttpError(409, 'PROOF_NOT_FOUND')
  }
}

const lockKey = (orgId: string, userId: string): UserLockKey => ({ orgId, userId })
const sameOwner = (row: Row, orgId: string, userId: string): boolean => text(row.org_id) === orgId && text(row.user_id) === userId

export interface EndpointsService {
  list(input: { orgId: string; userId: string }): Promise<EndpointsListing>
  establish(input: { orgId: string; userId: string; connectionId: string; proofKind: ProofKind }): Promise<EndpointWriteResult>
  revoke(input: { orgId: string; userId: string; endpointId: string }): Promise<RevokeResult>
}

export function createEndpointsService(deps: EndpointsServiceDeps): EndpointsService {
  const { resolver } = deps
  const capabilitySwitchOn = deps.capabilitySwitchOn ?? (() => isDirectoryIntegrationCapabilitiesEnabled())

  async function connectionNames(db: Db, orgId: string, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map()
    const found = await db.query(CONNECTION_NAMES_SQL, [[...new Set(ids)], orgId])
    return new Map(found.rows.map((row) => [text(row.id), text(row.name)]))
  }

  /** Display-only capability state per connection; not an authorization input. */
  async function capabilityDisplay(db: Db, orgId: string, ids: string[]): Promise<Map<string, { effective: boolean; reason: string | null }>> {
    const answers = new Map<string, { effective: boolean; reason: string | null }>()
    const unique = [...new Set(ids)]
    if (unique.length === 0) return answers
    if (!capabilitySwitchOn()) {
      for (const id of unique) answers.set(id, { effective: false, reason: 'switch_off' })
      return answers
    }
    const queryable = {
      query: async (statement: string, params?: unknown[]) => {
        const result = await db.query(statement, params)
        return { rows: result.rows, rowCount: result.rows.length }
      },
    }
    const available = await probeCapabilityTables(queryable)
    for (const id of unique) {
      if (!available) {
        answers.set(id, { effective: false, reason: 'schema_unavailable' })
        continue
      }
      const peeked = await peekIntegrationCapabilityState(queryable, id)
      if (peeked === null) {
        answers.set(id, { effective: false, reason: 'not_found' })
        continue
      }
      const evaluation = evaluateIntegrationCapability({
        capability: 'notification',
        switchOn: true,
        schemaAvailable: true,
        descriptor: resolveProviderCapabilityDescriptor(peeked.integration.provider),
        implementationAvailable: isCapabilityImplementationAvailable(peeked.integration.provider, 'notification'),
        expectedOrgId: orgId,
        integration: peeked.integration,
        state: peeked.state,
      })
      answers.set(id, { effective: evaluation.effective, reason: evaluation.reason as CapabilityReason | null })
    }
    return answers
  }

  async function itemsFor(db: Db, orgId: string, userId: string, rows: Row[]): Promise<EndpointItem[]> {
    if (rows.length === 0) return []
    const verified = await resolver.verifyEndpoints(db, {
      orgId,
      refs: rows.map((row) => ({ endpointId: text(row.id), userId })),
    })
    const connections = rows.map((row) => text(row.connection_id))
    const names = await connectionNames(db, orgId, connections)
    const capabilities = await capabilityDisplay(db, orgId, connections)
    return rows.map((row, index) => {
      const result: ResolveResult = verified[index]
      const status = text(row.status) as EndpointStatus
      const connectionId = text(row.connection_id)
      const provider = text(row.provider)
      const live = result.ok === true
      let unusableReason: UnusableReason | null = result.ok === true ? null : result.code
      if (status !== 'active' && unusableReason === null) unusableReason = 'endpoint_stale'
      return {
        id: text(row.id),
        connection: { id: connectionId, provider, label: connectionLabel(provider, names.get(connectionId) ?? '') },
        addressKind: text(row.address_kind),
        proofKind: text(row.proof_kind) as ProofKind,
        status,
        revision: Number(row.revision),
        usable: live && status === 'active',
        unusableReason,
        capability: capabilities.get(connectionId) ?? { effective: false, reason: 'not_found' },
        verified: false,
        lastVerifiedAt: new Date(row.last_verified_at as string | Date).toISOString(),
      }
    })
  }

  async function list(input: { orgId: string; userId: string }): Promise<EndpointsListing> {
    const { orgId, userId } = input
    const candidates = await resolver.listCandidates(deps.db, { orgId, userId })
    const own = await deps.db.query(SELECT_OWN_SQL, [orgId, userId])
    const endpoints = await itemsFor(deps.db, orgId, userId, own.rows)
    return {
      delivery: { enabled: false, testSendAvailable: false, reason: 'delivery_disabled' },
      endpoints,
      candidates: candidates.map(candidateItem),
    }
  }

  function candidateItem(candidate: EndpointCandidate): CandidateItem {
    return {
      connection: { id: candidate.connectionId, provider: candidate.provider, label: candidate.label },
      proofKind: candidate.proofKind,
      addressable: candidate.addressable,
      reasonCode: candidate.reasonCode,
      endpointId: candidate.endpointId,
    }
  }

  const MAX_LOCK_ATTEMPTS = 3

  async function establish(input: { orgId: string; userId: string; connectionId: string; proofKind: ProofKind }): Promise<EndpointWriteResult> {
    const { orgId, userId, connectionId, proofKind } = input
    for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
      // Outside any lock: derive the target and find who holds the address, to know whose lock is also needed.
      const first = await resolver.resolveForConnection(deps.db, { orgId, userId, connectionId, proofKind })
      if (first.ok === false) throw resolutionError(first.code)
      const holder = await deps.db.query(SELECT_ADDRESS_HOLDER_SQL, [
        first.target.provider,
        first.target.boundTenant,
        first.target.addressKind,
        first.target.tenantAddressWitness,
      ])
      const locks: UserLockKey[] = [lockKey(orgId, userId)]
      for (const row of holder.rows) locks.push(lockKey(text(row.org_id), text(row.user_id)))
      const held = new Set(locks.map((key) => JSON.stringify([key.orgId, key.userId])))
      const audits: AuditEvent[] = []
      try {
        const outcome = await withUserLocks(deps, locks, async (tx) => {
          const target = await resolver.resolveForConnection(tx, { orgId, userId, connectionId, proofKind })
          if (target.ok === false) throw resolutionError(target.code)
          const now = target.target
          const holders = await tx.query(SELECT_ADDRESS_HOLDER_LOCKED_SQL, [now.provider, now.boundTenant, now.addressKind, now.tenantAddressWitness])
          const others = holders.rows.filter(
            (row) => !(sameOwner(row, orgId, userId) && text(row.connection_id) === now.connectionId && text(row.proof_kind) === now.proofKind),
          )
          for (const row of others) {
            if (!held.has(JSON.stringify([text(row.org_id), text(row.user_id)]))) return 'retry' as const
          }
          for (const row of others) {
            const mine = sameOwner(row, orgId, userId)
            const checked = await resolver.verifyEndpoint(tx, { orgId: text(row.org_id), userId: text(row.user_id), endpointId: text(row.id) })
            if (checked.ok === true) {
              throw new NotificationHttpError(409, mine ? 'ADDRESS_BOUND_ON_OTHER_CONNECTION' : 'ADDRESS_ALREADY_BOUND')
            }
            const demoted = await tx.query(DEMOTE_SQL, [text(row.id)])
            if (demoted.rows.length > 0) {
              audits.push({
                actorType: mine ? 'user' : 'system',
                ...(mine ? { actorId: userId } : {}),
                action: 'notification.endpoint.demote',
                resourceType: 'user_notification_endpoint',
                resourceId: text(row.id),
                meta: { provider: text(row.provider), revision: Number(demoted.rows[0].revision), reason: 'address_rebound' },
              })
            }
          }

          const existing = await tx.query(SELECT_SAME_PROOF_SQL, [orgId, userId, now.connectionId, now.addressKind, now.proofKind])
          const row = existing.rows[0]
          const params = [now.proofId, now.proofWitness, now.addressWitness, now.tenantAddressWitness, now.boundTenant, now.boundAppScope]
          if (!row) {
            const inserted = await tx.query(INSERT_SQL, [
              orgId, userId, now.connectionId, now.provider, now.addressKind, now.proofKind, ...params,
            ])
            audits.push(createAudit(userId, text(inserted.rows[0].id), now.provider, Number(inserted.rows[0].revision), 'created'))
            return { created: true, id: text(inserted.rows[0].id) }
          }
          const unchanged =
            text(row.status) === 'active' &&
            text(row.proof_id) === now.proofId &&
            text(row.proof_witness) === now.proofWitness &&
            text(row.address_witness) === now.addressWitness &&
            text(row.tenant_address_witness) === now.tenantAddressWitness &&
            text(row.bound_tenant) === now.boundTenant &&
            text(row.bound_app_scope) === now.boundAppScope
          if (unchanged) return { created: false, id: text(row.id) }
          const refreshed = await tx.query(REFRESH_SQL, [text(row.id), ...params])
          audits.push(
            createAudit(userId, text(row.id), now.provider, Number(refreshed.rows[0].revision), text(row.status) === 'revoked' ? 'reactivated' : 'refreshed'),
          )
          return { created: false, id: text(row.id) }
        })
        if (outcome === 'retry') continue
        for (const event of audits) await deps.audit(event)
        const read = await deps.db.query(SELECT_ONE_SQL, [outcome.id, orgId, userId])
        const [endpoint] = await itemsFor(deps.db, orgId, userId, read.rows)
        return { created: outcome.created, endpoint }
      } catch (error) {
        const { code, constraint } = pgErrorOf(error)
        if (code === '23505' && constraint === 'une_tenant_address_active_uniq') {
          throw new NotificationHttpError(409, 'ADDRESS_ALREADY_BOUND')
        }
        throw mapBusy(error)
      }
    }
    throw new NotificationHttpError(503, 'NOTIFICATION_BUSY')
  }

  function createAudit(userId: string, id: string, provider: string, revision: number, change: string): AuditEvent {
    return {
      actorType: 'user',
      actorId: userId,
      action: 'notification.endpoint.create',
      resourceType: 'user_notification_endpoint',
      resourceId: id,
      meta: { provider, revision, change },
    }
  }

  async function revoke(input: { orgId: string; userId: string; endpointId: string }): Promise<RevokeResult> {
    const { orgId, userId, endpointId } = input
    const audits: AuditEvent[] = []
    try {
      const result = await withUserLocks(deps, [lockKey(orgId, userId)], async (tx) => {
        const found = await tx.query(SELECT_ONE_LOCKED_SQL, [endpointId, orgId, userId])
        const row = found.rows[0]
        if (!row) throw new NotificationHttpError(404, 'NOT_FOUND')
        if (text(row.status) === 'revoked') return { id: text(row.id), status: 'revoked' as const, revision: Number(row.revision) }
        const revoked = await tx.query(REVOKE_SQL, [endpointId])
        await tx.query(CLEAR_PREFERENCES_SQL, [endpointId, orgId, userId, userId])
        const revision = Number(revoked.rows[0].revision)
        audits.push({
          actorType: 'user',
          actorId: userId,
          action: 'notification.endpoint.revoke',
          resourceType: 'user_notification_endpoint',
          resourceId: text(row.id),
          meta: { provider: text(row.provider), revision },
        })
        return { id: text(row.id), status: 'revoked' as const, revision }
      })
      for (const event of audits) await deps.audit(event)
      return result
    } catch (error) {
      throw mapBusy(error)
    }
  }

  return { list, establish, revoke }
}
