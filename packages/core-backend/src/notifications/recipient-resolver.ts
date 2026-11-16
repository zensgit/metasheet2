/**
 * Recipient resolver: from a user and a named connection to the address of that user on that
 * connection, derived from a proof row and never stored. Every business that sends through a
 * connection obtains an address only here. It writes nothing, sends nothing and never chooses a
 * connection.
 *
 * Every method serves any number of requests with a constant number of statements: one candidate (or
 * re-check) statement, one diagnostic statement when some request has no candidate, and one
 * membership call. Requests are de-duplicated by key before the statements run, so a repeated request
 * cannot double the window count and look ambiguous.
 *
 * The active-member predicate is a function argument, so this module does not depend on any task
 * module.
 */
import { inspect } from 'node:util'
import {
  resolveProviderCapabilityDescriptor,
  type IntegrationScope,
} from '../integrations/provider-capability-registry'
import {
  connectionLabel,
  lookupProviderNotificationDescriptor,
  productionProviderNotificationRegistry,
  type AddressKind,
  type ProofKind,
  type ProviderTransportDescriptor,
} from './provider-notification-registry'
import {
  addressWitness,
  directoryLinkProofWitness,
  externalIdentityProofWitness,
  normalizeAddress,
  tenantAddressWitness,
} from './witness'

export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

export type ResolveFailureCode =
  | 'connection_not_found'
  | 'connection_inactive'
  | 'provider_not_registered'
  | 'proof_kind_unavailable'
  | 'proof_missing'
  | 'proof_not_linked'
  | 'proof_wrong_user'
  | 'proof_ambiguous'
  | 'proof_account_inactive'
  | 'proof_changed'
  | 'proof_assurance_insufficient'
  | 'address_missing'
  | 'address_unusable'
  | 'address_kind_not_derivable'
  | 'address_bound_on_other_connection'
  | 'scope_unproven'
  | 'scope_changed'
  | 'user_not_active_member'
  | 'endpoint_not_found'

const protectedValues = new WeakMap<ProtectedAddress, string>()
const PLACEHOLDER = '[address]'

/** An address held in memory only: serialization, string conversion and inspection all give a placeholder. */
export class ProtectedAddress {
  constructor(value: string) {
    protectedValues.set(this, value)
  }
  /** The only way to read the value. */
  reveal(): string {
    return protectedValues.get(this) as string
  }
  toJSON(): string {
    return PLACEHOLDER
  }
  toString(): string {
    return PLACEHOLDER
  }
  [Symbol.toPrimitive](): string {
    return PLACEHOLDER
  }
  [inspect.custom](): string {
    return PLACEHOLDER
  }
}

export interface ResolvedTarget {
  readonly connectionId: string
  readonly provider: string
  readonly transport: string
  readonly addressKind: AddressKind
  readonly proofKind: ProofKind
  readonly proofId: string
  readonly proofWitness: string
  readonly addressWitness: string
  readonly tenantAddressWitness: string
  readonly boundTenant: string
  readonly boundAppScope: string
  readonly address: ProtectedAddress
}

export type ResolveResult = { ok: true; target: ResolvedTarget } | { ok: false; code: ResolveFailureCode }

export interface EndpointCandidate {
  readonly connectionId: string
  readonly provider: string
  readonly label: string
  readonly proofKind: ProofKind
  readonly addressable: boolean
  readonly reasonCode: ResolveFailureCode | null
  readonly endpointId: string | null
}

export interface ExternalIdentityProof {
  identityId: string
  bindingRevision: number
  subjectType: string
  subjectKey: string
  issuer: { tenant: string; appScope: string | null }
  /** Whether the person completed the platform's authentication, or the system linked the row by an attribute the platform reported. */
  establishedBy: 'self_authenticated' | 'association'
  verified: true
  revoked: false
}

export interface ExternalIdentityProofReader {
  readonly provider: string
  read(db: Db, input: { userId: string; orgId: string; connectionId: string }): Promise<ExternalIdentityProof | null>
}

/** The reader used until an identity store provides one: every identity proof is unavailable. */
export class NullExternalIdentityProofReader implements ExternalIdentityProofReader {
  constructor(readonly provider: string) {}
  async read(): Promise<ExternalIdentityProof | null> {
    return null
  }
}

export interface ResolveRequest {
  userId: string
  connectionId: string
  proofKind: ProofKind
}

export interface RecipientResolver {
  listCandidates(db: Db, input: { orgId: string; userId: string }): Promise<EndpointCandidate[]>
  resolveMany(db: Db, input: { orgId: string; requests: ReadonlyArray<ResolveRequest> }): Promise<ResolveResult[]>
  verifyEndpoints(
    db: Db,
    input: { orgId: string; refs: ReadonlyArray<{ endpointId: string; userId: string }> },
  ): Promise<ResolveResult[]>
  deriveDefaultTargets(
    db: Db,
    input: { orgId: string; connectionId: string; userIds: readonly string[] },
  ): Promise<ResolveResult[]>
  resolveForConnection(db: Db, input: { orgId: string; userId: string; connectionId: string; proofKind: ProofKind }): Promise<ResolveResult>
  verifyEndpoint(db: Db, input: { orgId: string; userId: string; endpointId: string }): Promise<ResolveResult>
  deriveDefaultTarget(db: Db, input: { orgId: string; userId: string; connectionId: string }): Promise<ResolveResult>
}

export interface RecipientResolverDeps {
  /** The subset of `userIds` that are active members of `orgId`; one call per batch. */
  isActiveOrgMembers(db: Db, orgId: string, userIds: string[]): Promise<Set<string>>
  /** Descriptors the resolver may use; defaults to the production registry. */
  registry?: readonly ProviderTransportDescriptor[]
  /** Reads the scope anchor of an integration row; defaults to the provider capability registry. */
  scopeOf?(provider: string, row: { corp_id: string; config: unknown }): IntegrationScope | null
  externalIdentityReaders?: Readonly<Record<string, ExternalIdentityProofReader>>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// $1 user ids, $2 connection ids (aligned arrays), $3 organization, $4 configuration keys the scope anchor reads.
const CANDIDATE_SQL = `WITH q AS (SELECT * FROM unnest($1::text[], $2::uuid[]) AS q(user_id, connection_id)),
c AS (
  SELECT q.user_id AS requested_user_id, l.id::text AS proof_id, l.link_status AS link_status,
         a.id::text AS account_id, a.external_user_id, a.union_id, a.open_id,
         a.is_active AS account_active, a.provider AS account_provider, a.corp_id AS account_corp_id,
         i.id::text AS connection_id, i.org_id, i.provider, i.corp_id,
         CASE WHEN jsonb_typeof(i.config) = 'object'
              THEN (SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(i.config) AS e WHERE e.key = ANY($4::text[]))
         END AS scope_config,
         row_number() OVER (PARTITION BY q.user_id, i.id ORDER BY a.id ASC) AS rn,
         count(*)     OVER (PARTITION BY q.user_id, i.id)                   AS n
    FROM q
    JOIN directory_account_links l ON l.local_user_id = q.user_id AND l.link_status = 'linked'
    JOIN directory_accounts a ON a.id = l.directory_account_id
    JOIN directory_integrations i ON i.id = a.integration_id
   WHERE a.is_active AND a.provider = i.provider
     AND i.id = q.connection_id AND i.org_id = $3 AND i.status = 'active'
     AND a.corp_id = i.corp_id
)
SELECT * FROM c WHERE rn <= 2`

// Only for requests that have no candidate: names the most specific reason. It never widens the candidates.
// $1 user ids, $2 connection ids (aligned arrays), $3 organization.
const DIAGNOSTIC_SQL = `WITH q AS (SELECT * FROM unnest($1::text[], $2::uuid[]) AS q(user_id, connection_id))
SELECT q.user_id AS requested_user_id, q.connection_id::text AS connection_id,
       (i.id IS NOT NULL) AS connection_exists, i.status AS connection_status,
       i.provider AS connection_provider, i.corp_id AS connection_corp_id,
       (l.id IS NOT NULL) AS has_link, l.link_status AS link_status,
       a.is_active AS account_active, a.provider AS account_provider, a.corp_id AS account_corp_id
  FROM q
  LEFT JOIN directory_integrations i ON i.id = q.connection_id AND i.org_id = $3
  LEFT JOIN (directory_account_links l JOIN directory_accounts a ON a.id = l.directory_account_id)
         ON l.local_user_id = q.user_id AND a.integration_id = q.connection_id`

// The integration rows for identity-proof requests. $1 connection ids, $2 organization, $3 configuration keys.
const CONNECTION_SQL = `SELECT i.id::text AS connection_id, i.org_id, i.provider, i.status, i.corp_id,
       CASE WHEN jsonb_typeof(i.config) = 'object'
            THEN (SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(i.config) AS e WHERE e.key = ANY($3::text[]))
       END AS scope_config
  FROM directory_integrations i
 WHERE i.id = ANY($1::uuid[]) AND i.org_id = $2`

// Endpoint re-check: the endpoint is read by (id, organization, user), then its proof is read by proof_id.
// $1 endpoint ids, $2 user ids (aligned arrays), $3 organization, $4 configuration keys.
const VERIFY_SQL = `WITH q AS (SELECT * FROM unnest($1::uuid[], $2::text[]) AS q(endpoint_id, user_id))
SELECT e.id::text AS endpoint_id, e.user_id AS endpoint_user_id, e.connection_id::text AS endpoint_connection_id,
       e.provider AS endpoint_provider, e.address_kind AS endpoint_address_kind, e.proof_kind AS endpoint_proof_kind,
       e.proof_id::text AS endpoint_proof_id, e.proof_witness AS endpoint_proof_witness,
       e.address_witness AS endpoint_address_witness, e.tenant_address_witness AS endpoint_tenant_address_witness,
       e.bound_tenant AS endpoint_bound_tenant, e.bound_app_scope AS endpoint_bound_app_scope,
       l.id::text AS link_id, l.local_user_id AS link_user_id, l.link_status AS link_status,
       a.id::text AS account_id, a.integration_id::text AS account_integration_id, a.is_active AS account_active,
       a.provider AS account_provider, a.corp_id AS account_corp_id,
       a.external_user_id, a.union_id, a.open_id,
       i.id::text AS connection_id, i.org_id AS connection_org_id, i.provider AS connection_provider,
       i.status AS connection_status, i.corp_id AS connection_corp_id,
       CASE WHEN jsonb_typeof(i.config) = 'object'
            THEN (SELECT jsonb_object_agg(k.key, k.value) FROM jsonb_each(i.config) AS k WHERE k.key = ANY($4::text[]))
       END AS scope_config
  FROM q
  JOIN user_notification_endpoints e ON e.id = q.endpoint_id AND e.org_id = $3 AND e.user_id = q.user_id
  LEFT JOIN directory_account_links l ON l.id = e.proof_id AND e.proof_kind = 'directory_link'
  LEFT JOIN directory_accounts a ON a.id = l.directory_account_id
  LEFT JOIN directory_integrations i ON i.id = e.connection_id`

// The connections where a user has a proof row. $1 user id, $2 organization.
const LINKED_CONNECTIONS_SQL = `SELECT DISTINCT i.id::text AS connection_id, i.provider, i.name
  FROM directory_account_links l
  JOIN directory_accounts a ON a.id = l.directory_account_id
  JOIN directory_integrations i ON i.id = a.integration_id
 WHERE l.local_user_id = $1 AND i.org_id = $2
 ORDER BY i.name, connection_id`

// The user's own endpoint rows. $1 organization, $2 user id.
const OWN_ENDPOINTS_SQL = `SELECT id::text AS id, connection_id::text AS connection_id, proof_kind, status, provider, tenant_address_witness
  FROM user_notification_endpoints
 WHERE org_id = $1 AND user_id = $2 AND status <> 'revoked'`

const text = (value: unknown): string => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value))
const nullableText = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))

const pairKey = (a: string, b: string): string => JSON.stringify([a, b])
const requestKey = (r: ResolveRequest): string => JSON.stringify([r.userId, r.connectionId.toLowerCase(), r.proofKind])

const fail = (code: ResolveFailureCode): ResolveResult => ({ ok: false, code })

function isNullReader(reader: ExternalIdentityProofReader | undefined): boolean {
  return reader === undefined || reader instanceof NullExternalIdentityProofReader
}

export function createRecipientResolver(deps: RecipientResolverDeps): RecipientResolver {
  const registry = deps.registry ?? productionProviderNotificationRegistry()
  const descriptorOf = (provider: string): ProviderTransportDescriptor | null =>
    lookupProviderNotificationDescriptor(registry, provider)
  const scopeOf =
    deps.scopeOf ??
    ((provider: string, row: { corp_id: string; config: unknown }): IntegrationScope | null =>
      resolveProviderCapabilityDescriptor(provider)?.scopeOf(row) ?? null)
  const readers = deps.externalIdentityReaders ?? {}
  const scopeKeys = [...new Set(registry.flatMap((descriptor) => descriptor.scopeConfigKeys))].sort()

  function target(
    descriptor: ProviderTransportDescriptor,
    fields: {
      connectionId: string
      proofKind: ProofKind
      proofId: string
      proofWitness: string
      address: string
      anchor: IntegrationScope
    },
  ): ResolvedTarget {
    return {
      connectionId: fields.connectionId,
      provider: descriptor.provider,
      transport: descriptor.transport,
      addressKind: descriptor.addressKind,
      proofKind: fields.proofKind,
      proofId: fields.proofId,
      proofWitness: fields.proofWitness,
      addressWitness: addressWitness({ connectionId: fields.connectionId, addressKind: descriptor.addressKind, address: fields.address }),
      tenantAddressWitness: tenantAddressWitness({
        provider: descriptor.provider,
        boundTenant: fields.anchor.tenant,
        addressKind: descriptor.addressKind,
        address: fields.address,
      }),
      boundTenant: fields.anchor.tenant,
      boundAppScope: fields.anchor.appScope,
      address: new ProtectedAddress(fields.address),
    }
  }

  /** Address and anchor from a directory account row; the proof state is already established by the caller. */
  function deriveFromDirectory(
    row: Record<string, unknown>,
    descriptor: ProviderTransportDescriptor,
    connection: { id: string; orgId: string; provider: string; corpId: string; scopeConfig: unknown },
    proof: { proofId: string; localUserId: string; accountId: string; linkStatus: string; accountActive: boolean; accountProvider: string; accountCorpId: string | null; accountUnionId: string | null },
  ): ResolveResult {
    const rule = descriptor.proofRules.directory_link
    if (rule === null || rule.from !== 'directory_account') return fail('address_kind_not_derivable')
    if (descriptor.idScope === 'app' && rule.issuerWitness === undefined) return fail('scope_unproven')
    const anchor = scopeOf(connection.provider, { corp_id: connection.corpId, config: connection.scopeConfig })
    if (anchor === null) return fail('scope_unproven')
    const normalized = normalizeAddress(descriptor, row[rule.column])
    if (normalized.ok === false) return fail(normalized.code)
    return {
      ok: true,
      target: target(descriptor, {
        connectionId: connection.id,
        proofKind: 'directory_link',
        proofId: proof.proofId,
        proofWitness: directoryLinkProofWitness({
          proofId: proof.proofId,
          localUserId: proof.localUserId,
          accountId: proof.accountId,
          connectionId: connection.id,
          orgId: connection.orgId,
          linkStatus: proof.linkStatus,
          accountActive: proof.accountActive,
          accountProvider: proof.accountProvider,
          accountCorpId: proof.accountCorpId,
          accountUnionId: proof.accountUnionId,
        }),
        address: normalized.address,
        anchor,
      }),
    }
  }

  async function deriveFromIdentity(
    db: Db,
    orgId: string,
    userId: string,
    connection: { id: string; provider: string; corpId: string; scopeConfig: unknown },
    descriptor: ProviderTransportDescriptor,
  ): Promise<ResolveResult> {
    const rule = descriptor.proofRules.external_identity
    if (rule === null || rule.from !== 'identity_subject') return fail('address_kind_not_derivable')
    const reader = readers[descriptor.provider]
    if (isNullReader(reader)) return fail('proof_kind_unavailable')
    const anchor = scopeOf(connection.provider, { corp_id: connection.corpId, config: connection.scopeConfig })
    if (anchor === null) return fail('scope_unproven')
    const proof = await (reader as ExternalIdentityProofReader).read(db, { userId, orgId, connectionId: connection.id })
    if (proof === null) return fail('proof_missing')
    if (proof.subjectType !== rule.subjectType) return fail('scope_unproven')
    if (proof.issuer.tenant !== anchor.tenant) return fail('scope_unproven')
    if (descriptor.idScope === 'app' && proof.issuer.appScope !== anchor.appScope) return fail('scope_unproven')
    if (proof.establishedBy !== 'self_authenticated') return fail('proof_assurance_insufficient')
    const normalized = normalizeAddress(descriptor, proof.subjectKey)
    if (normalized.ok === false) return fail(normalized.code)
    return {
      ok: true,
      target: target(descriptor, {
        connectionId: connection.id,
        proofKind: 'external_identity',
        proofId: proof.identityId,
        proofWitness: externalIdentityProofWitness({
          identityId: proof.identityId,
          localUserId: userId,
          connectionId: connection.id,
          bindingRevision: proof.bindingRevision,
          subjectType: proof.subjectType,
          establishedBy: proof.establishedBy,
          verified: proof.verified,
          revoked: proof.revoked,
        }),
        address: normalized.address,
        anchor,
      }),
    }
  }

  function diagnose(rows: Array<Record<string, unknown>>): ResolveFailureCode {
    const first = rows[0]
    if (!first || first.connection_exists !== true) return 'connection_not_found'
    if (first.connection_status !== 'active') return 'connection_inactive'
    const links = rows.filter((row) => row.has_link === true)
    if (links.length === 0) return 'proof_missing'
    // Most specific first: a linked, active account that fails the scope test, then an inactive account, then a link that is not linked.
    const linked = links.filter((row) => row.link_status === 'linked')
    if (linked.some((row) => row.account_active === true)) return 'scope_unproven'
    if (linked.length > 0) return 'proof_account_inactive'
    return 'proof_not_linked'
  }

  async function members(db: Db, orgId: string, userIds: string[]): Promise<Set<string>> {
    return userIds.length === 0 ? new Set() : deps.isActiveOrgMembers(db, orgId, userIds)
  }

  async function resolveMany(db: Db, input: { orgId: string; requests: ReadonlyArray<ResolveRequest> }): Promise<ResolveResult[]> {
    const { orgId } = input
    const unique = new Map<string, ResolveRequest>()
    for (const request of input.requests) {
      const key = requestKey(request)
      if (!unique.has(key)) unique.set(key, { ...request, connectionId: request.connectionId.toLowerCase() })
    }
    const answers = new Map<string, ResolveResult>()
    const directory: Array<[string, ResolveRequest]> = []
    const identity: Array<[string, ResolveRequest]> = []
    for (const [key, request] of unique) {
      if (!UUID.test(request.connectionId)) answers.set(key, fail('connection_not_found'))
      else if (request.proofKind === 'directory_link') directory.push([key, request])
      else if (request.proofKind === 'external_identity') identity.push([key, request])
      else answers.set(key, fail('proof_kind_unavailable'))
    }

    if (directory.length > 0) {
      const users = directory.map(([, r]) => r.userId)
      const connections = directory.map(([, r]) => r.connectionId)
      const found = await db.query(CANDIDATE_SQL, [users, connections, orgId, scopeKeys])
      const groups = new Map<string, Array<Record<string, unknown>>>()
      for (const row of found.rows) {
        const key = pairKey(text(row.requested_user_id), text(row.connection_id))
        const group = groups.get(key)
        if (group) group.push(row)
        else groups.set(key, [row])
      }
      const empty: Array<[string, ResolveRequest]> = []
      for (const [key, request] of directory) {
        const group = groups.get(pairKey(request.userId, request.connectionId))
        if (!group) {
          empty.push([key, request])
          continue
        }
        const row = group[0]
        const total = Number(row.n)
        if (group.length >= 2 || total >= 2) {
          answers.set(key, fail('proof_ambiguous'))
          continue
        }
        const provider = text(row.provider)
        const descriptor = descriptorOf(provider)
        if (descriptor === null) {
          answers.set(key, fail('provider_not_registered'))
          continue
        }
        answers.set(
          key,
          deriveFromDirectory(
            row,
            descriptor,
            { id: text(row.connection_id), orgId: text(row.org_id), provider, corpId: text(row.corp_id), scopeConfig: row.scope_config },
            {
              proofId: text(row.proof_id),
              localUserId: request.userId,
              accountId: text(row.account_id),
              linkStatus: text(row.link_status),
              accountActive: row.account_active === true,
              accountProvider: text(row.account_provider),
              accountCorpId: nullableText(row.account_corp_id),
              accountUnionId: nullableText(row.union_id),
            },
          ),
        )
      }
      if (empty.length > 0) {
        const diagnostic = await db.query(DIAGNOSTIC_SQL, [empty.map(([, r]) => r.userId), empty.map(([, r]) => r.connectionId), orgId])
        const byPair = new Map<string, Array<Record<string, unknown>>>()
        for (const row of diagnostic.rows) {
          const key = pairKey(text(row.requested_user_id), text(row.connection_id))
          const group = byPair.get(key)
          if (group) group.push(row)
          else byPair.set(key, [row])
        }
        for (const [key, request] of empty) {
          answers.set(key, fail(diagnose(byPair.get(pairKey(request.userId, request.connectionId)) ?? [])))
        }
      }
    }

    if (identity.length > 0) {
      const connections = [...new Set(identity.map(([, r]) => r.connectionId))]
      const found = await db.query(CONNECTION_SQL, [connections, orgId, scopeKeys])
      const byId = new Map(found.rows.map((row) => [text(row.connection_id), row]))
      for (const [key, request] of identity) {
        const row = byId.get(request.connectionId)
        if (!row) {
          answers.set(key, fail('connection_not_found'))
          continue
        }
        if (row.status !== 'active') {
          answers.set(key, fail('connection_inactive'))
          continue
        }
        const provider = text(row.provider)
        const descriptor = descriptorOf(provider)
        if (descriptor === null) {
          answers.set(key, fail('provider_not_registered'))
          continue
        }
        answers.set(
          key,
          await deriveFromIdentity(
            db,
            orgId,
            request.userId,
            { id: text(row.connection_id), provider, corpId: text(row.corp_id), scopeConfig: row.scope_config },
            descriptor,
          ),
        )
      }
    }

    const okUsers = [...new Set([...unique].filter(([key]) => answers.get(key)?.ok === true).map(([, r]) => r.userId))]
    const active = await members(db, orgId, okUsers)
    return input.requests.map((request) => {
      const key = requestKey(request)
      const answer = answers.get(key) as ResolveResult
      if (answer.ok && !active.has(request.userId)) return fail('user_not_active_member')
      return answer
    })
  }

  async function verifyEndpoints(
    db: Db,
    input: { orgId: string; refs: ReadonlyArray<{ endpointId: string; userId: string }> },
  ): Promise<ResolveResult[]> {
    const { orgId } = input
    const uniqueRefs = new Map<string, { endpointId: string; userId: string }>()
    for (const ref of input.refs) {
      const key = pairKey(ref.endpointId.toLowerCase(), ref.userId)
      if (!uniqueRefs.has(key)) uniqueRefs.set(key, { endpointId: ref.endpointId.toLowerCase(), userId: ref.userId })
    }
    const answers = new Map<string, ResolveResult>()
    const valid = [...uniqueRefs].filter(([key, ref]) => {
      if (UUID.test(ref.endpointId)) return true
      answers.set(key, fail('endpoint_not_found'))
      return false
    })
    if (valid.length > 0) {
      const found = await db.query(VERIFY_SQL, [valid.map(([, r]) => r.endpointId), valid.map(([, r]) => r.userId), orgId, scopeKeys])
      const rows = new Map(found.rows.map((row) => [pairKey(text(row.endpoint_id), text(row.endpoint_user_id)), row]))
      for (const [key, ref] of valid) {
        const row = rows.get(pairKey(ref.endpointId, ref.userId))
        answers.set(key, row ? await verifyOne(db, orgId, row) : fail('endpoint_not_found'))
      }
    }
    const okUsers = [...new Set([...uniqueRefs].filter(([key]) => answers.get(key)?.ok === true).map(([, r]) => r.userId))]
    const active = await members(db, orgId, okUsers)
    return input.refs.map((ref) => {
      const answer = answers.get(pairKey(ref.endpointId.toLowerCase(), ref.userId)) as ResolveResult
      if (answer.ok && !active.has(ref.userId)) return fail('user_not_active_member')
      return answer
    })
  }

  async function verifyOne(db: Db, orgId: string, row: Record<string, unknown>): Promise<ResolveResult> {
    const endpoint = {
      userId: text(row.endpoint_user_id),
      connectionId: text(row.endpoint_connection_id),
      provider: text(row.endpoint_provider),
      addressKind: text(row.endpoint_address_kind),
      proofKind: text(row.endpoint_proof_kind),
      proofId: text(row.endpoint_proof_id),
      proofWitness: text(row.endpoint_proof_witness),
      addressWitness: text(row.endpoint_address_witness),
      tenantAddressWitness: text(row.endpoint_tenant_address_witness),
      boundTenant: text(row.endpoint_bound_tenant),
      boundAppScope: text(row.endpoint_bound_app_scope),
    }
    if (row.connection_id === null || row.connection_id === undefined) return fail('connection_not_found')
    if (row.connection_status !== 'active') return fail('connection_inactive')
    const descriptor = descriptorOf(endpoint.provider)
    if (descriptor === null) return fail('provider_not_registered')
    const connection = {
      id: text(row.connection_id),
      orgId: text(row.connection_org_id),
      provider: text(row.connection_provider),
      corpId: text(row.connection_corp_id),
      scopeConfig: row.scope_config,
    }

    let derived: ResolveResult
    if (endpoint.proofKind === 'external_identity') {
      derived = await deriveFromIdentity(db, orgId, endpoint.userId, connection, descriptor)
    } else {
      if (row.link_id === null || row.link_id === undefined) return fail('proof_missing')
      if (row.link_user_id === null || row.link_user_id === undefined || row.link_status !== 'linked') return fail('proof_not_linked')
      if (text(row.link_user_id) !== endpoint.userId) return fail('proof_wrong_user')
      if (text(row.account_integration_id) !== endpoint.connectionId) return fail('scope_changed')
      if (row.account_active !== true) return fail('proof_account_inactive')
      if (
        text(row.account_provider) !== connection.provider ||
        row.account_corp_id === null ||
        row.account_corp_id === undefined ||
        text(row.account_corp_id) !== connection.corpId
      ) {
        return fail('scope_unproven')
      }
      derived = deriveFromDirectory(row, descriptor, connection, {
        proofId: endpoint.proofId,
        localUserId: endpoint.userId,
        accountId: text(row.account_id),
        linkStatus: text(row.link_status),
        accountActive: true,
        accountProvider: text(row.account_provider),
        accountCorpId: nullableText(row.account_corp_id),
        accountUnionId: nullableText(row.union_id),
      })
    }
    if (derived.ok === false) return derived
    const now = derived.target
    if (now.boundTenant !== endpoint.boundTenant || now.boundAppScope !== endpoint.boundAppScope) return fail('scope_changed')
    if (
      now.addressKind !== endpoint.addressKind ||
      now.proofWitness !== endpoint.proofWitness ||
      now.addressWitness !== endpoint.addressWitness ||
      now.tenantAddressWitness !== endpoint.tenantAddressWitness
    ) {
      return fail('proof_changed')
    }
    return derived
  }

  async function listCandidates(db: Db, input: { orgId: string; userId: string }): Promise<EndpointCandidate[]> {
    const { orgId, userId } = input
    const linked = await db.query(LINKED_CONNECTIONS_SQL, [userId, orgId])
    const connections = linked.rows
      .map((row) => ({ id: text(row.connection_id), provider: text(row.provider), name: text(row.name) }))
      .filter((connection) => descriptorOf(connection.provider) !== null)
    if (connections.length === 0) return []

    const requests: ResolveRequest[] = []
    for (const connection of connections) {
      requests.push({ userId, connectionId: connection.id, proofKind: 'directory_link' })
      const descriptor = descriptorOf(connection.provider) as ProviderTransportDescriptor
      if (descriptor.proofRules.external_identity !== null) {
        requests.push({ userId, connectionId: connection.id, proofKind: 'external_identity' })
      }
    }
    const results = await resolveMany(db, { orgId, requests })
    const own = await db.query(OWN_ENDPOINTS_SQL, [orgId, userId])
    const ownRows = own.rows.map((row) => ({
      id: text(row.id),
      connectionId: text(row.connection_id),
      proofKind: text(row.proof_kind),
      status: text(row.status),
      provider: text(row.provider),
      tenantWitness: text(row.tenant_address_witness),
    }))

    // An own endpoint on another connection blocks a candidate only while its own re-check still holds; the
    // re-check is one set-based call, made at most once and only when a candidate could be blocked.
    let stillHolds: Map<string, boolean> | null = null
    const holdsNow = async (): Promise<Map<string, boolean>> => {
      if (stillHolds !== null) return stillHolds
      const activeRows = ownRows.filter((row) => row.status === 'active')
      const checks = activeRows.length === 0 ? [] : await verifyEndpoints(db, { orgId, refs: activeRows.map((row) => ({ endpointId: row.id, userId })) })
      stillHolds = new Map(activeRows.map((row, index) => [row.id, checks[index].ok === true]))
      return stillHolds
    }

    const candidates: EndpointCandidate[] = []
    let cursor = 0
    for (const connection of connections) {
      const descriptor = descriptorOf(connection.provider) as ProviderTransportDescriptor
      const label = connectionLabel(connection.provider, connection.name)
      const kinds: ProofKind[] = descriptor.proofRules.external_identity !== null ? ['directory_link', 'external_identity'] : ['directory_link']
      for (const proofKind of kinds) {
        const result = results[cursor++]
        const existing = ownRows.find((row) => row.connectionId === connection.id && row.proofKind === proofKind) ?? null
        if (proofKind === 'external_identity' && result.ok === false && result.code === 'proof_missing' && existing === null) continue
        let addressable = result.ok === true
        let reasonCode: ResolveFailureCode | null = result.ok === true ? null : result.code
        if (result.ok === true && existing === null) {
          const blockers = ownRows.filter(
            (row) =>
              row.status === 'active' &&
              row.connectionId !== connection.id &&
              row.provider === connection.provider &&
              row.tenantWitness === result.target.tenantAddressWitness,
          )
          const holds = blockers.length === 0 ? null : await holdsNow()
          const elsewhere = blockers.some((row) => holds?.get(row.id) === true)
          if (elsewhere) {
            addressable = false
            reasonCode = 'address_bound_on_other_connection'
          }
        }
        candidates.push({ connectionId: connection.id, provider: connection.provider, label, proofKind, addressable, reasonCode, endpointId: existing?.id ?? null })
      }
      if (descriptor.proofRules.external_identity === null) {
        candidates.push({
          connectionId: connection.id,
          provider: connection.provider,
          label,
          proofKind: 'external_identity',
          addressable: false,
          reasonCode: 'address_kind_not_derivable',
          endpointId: null,
        })
      }
    }
    return candidates
  }

  return {
    listCandidates,
    resolveMany,
    verifyEndpoints,
    deriveDefaultTargets: (db, input) =>
      resolveMany(db, {
        orgId: input.orgId,
        requests: input.userIds.map((userId) => ({ userId, connectionId: input.connectionId, proofKind: 'directory_link' as const })),
      }),
    resolveForConnection: async (db, input) =>
      (await resolveMany(db, { orgId: input.orgId, requests: [{ userId: input.userId, connectionId: input.connectionId, proofKind: input.proofKind }] }))[0],
    verifyEndpoint: async (db, input) =>
      (await verifyEndpoints(db, { orgId: input.orgId, refs: [{ endpointId: input.endpointId, userId: input.userId }] }))[0],
    deriveDefaultTarget: async (db, input) =>
      (await resolveMany(db, { orgId: input.orgId, requests: [{ userId: input.userId, connectionId: input.connectionId, proofKind: 'directory_link' }] }))[0],
  }
}
