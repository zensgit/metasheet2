import { readFileSync } from 'node:fs'
import path from 'node:path'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  NullExternalIdentityProofReader,
  ProtectedAddress,
  createRecipientResolver,
  type Db,
  type ExternalIdentityProof,
  type ExternalIdentityProofReader,
  type RecipientResolverDeps,
  type ResolveResult,
} from '../../src/notifications/recipient-resolver'
import {
  productionProviderNotificationRegistry,
  type ProviderTransportDescriptor,
} from '../../src/notifications/provider-notification-registry'

const SOURCE = readFileSync(path.resolve(__dirname, '..', '..', 'src', 'notifications', 'recipient-resolver.ts'), 'utf8')

const ORG = 'org-1'
const CONN = '11111111-1111-4111-8111-111111111111'
const CONN2 = '22222222-2222-4222-8222-222222222222'
const ENDPOINT = '33333333-3333-4333-8333-333333333333'

type Row = Record<string, unknown>
type Handlers = Partial<Record<'candidate' | 'diagnostic' | 'connection' | 'verify' | 'linked' | 'own', (params: unknown[]) => Row[]>>

/** A database that recognises the resolver statements by their text and answers from the given handlers. */
function scripted(handlers: Handlers = {}) {
  const log: Array<{ kind: string; sql: string; params: unknown[] }> = []
  const kindOf = (sql: string): string => {
    if (sql.includes('row_number() OVER')) return 'candidate'
    if (sql.includes('connection_exists')) return 'diagnostic'
    if (sql.includes('JOIN user_notification_endpoints e ON e.id = q.endpoint_id')) return 'verify'
    if (sql.includes('SELECT DISTINCT i.id')) return 'linked'
    if (sql.includes('FROM user_notification_endpoints\n WHERE org_id = $1 AND user_id = $2')) return 'own'
    if (sql.includes('WHERE i.id = ANY($1::uuid[]) AND i.org_id = $2')) return 'connection'
    return 'unknown'
  }
  const db: Db = {
    query: async (sql, params = []) => {
      const kind = kindOf(sql)
      log.push({ kind, sql, params })
      const handler = (handlers as Record<string, ((p: unknown[]) => Row[]) | undefined>)[kind]
      if (!handler) throw new Error(`unexpected statement: ${kind}`)
      return { rows: handler(params) }
    },
  }
  return { db, log, count: (kind?: string) => log.filter((entry) => kind === undefined || entry.kind === kind).length }
}

const candidateRow = (userId: string, over: Row = {}): Row => ({
  requested_user_id: userId,
  proof_id: `proof-${userId}`,
  link_status: 'linked',
  account_id: `account-${userId}`,
  external_user_id: `dt-${userId}`,
  union_id: null,
  open_id: null,
  account_active: true,
  account_provider: 'dingtalk',
  account_corp_id: 'CorpOne',
  connection_id: CONN,
  org_id: ORG,
  provider: 'dingtalk',
  corp_id: 'CorpOne',
  scope_config: { appKey: 'AppOne' },
  rn: 1,
  n: 1,
  ...over,
})

const everyoneActive = async (_db: Db, _org: string, ids: string[]) => new Set(ids)

const resolverWith = (over: Partial<RecipientResolverDeps> = {}) => createRecipientResolver({ isActiveOrgMembers: everyoneActive, ...over })

const code = (result: ResolveResult): string => (result.ok === true ? 'ok' : result.code)
const one = (userId = 'u1', connectionId = CONN) => ({ userId, connectionId, proofKind: 'directory_link' as const })

describe('resolution of a directory link', () => {
  it('derives the target from the one candidate row and holds the address in a protected value', async () => {
    const { db } = scripted({ candidate: () => [candidateRow('u1')] })
    const result = await resolverWith().resolveForConnection(db, { orgId: ORG, ...one() , proofKind: 'directory_link' })
    expect(result.ok).toBe(true)
    if (result.ok !== true) return
    expect(result.target).toMatchObject({
      connectionId: CONN,
      provider: 'dingtalk',
      transport: 'work_notification',
      addressKind: 'dingtalk_userid',
      proofKind: 'directory_link',
      proofId: 'proof-u1',
      boundTenant: 'CorpOne',
      boundAppScope: 'AppOne',
    })
    expect(result.target.address.reveal()).toBe('dt-u1')
    expect(result.target.proofWitness).toMatch(/^[0-9a-f]{64}$/)
    expect(result.target.addressWitness).toMatch(/^[0-9a-f]{64}$/)
    expect(result.target.tenantAddressWitness).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a second candidate as ambiguous, whichever of the two rows is seen first', async () => {
    const rows = [candidateRow('u1', { rn: 1, n: 2 }), candidateRow('u1', { rn: 2, n: 2, account_id: 'account-2' })]
    const { db } = scripted({ candidate: () => rows })
    expect(code(await resolverWith().resolveForConnection(db, { orgId: ORG, ...one() }))).toBe('proof_ambiguous')
    const { db: db2 } = scripted({ candidate: () => [candidateRow('u1', { rn: 1, n: 3 })] })
    expect(code(await resolverWith().resolveForConnection(db2, { orgId: ORG, ...one() }))).toBe('proof_ambiguous')
  })

  it('answers each failure with its own code', async () => {
    const cases: Array<[string, Row, string]> = [
      ['provider that is not registered', { provider: 'other' }, 'provider_not_registered'],
      ['scope without an application key', { scope_config: null }, 'scope_unproven'],
      ['blank identifier', { external_user_id: '  ' }, 'address_missing'],
      ['identifier naming several people', { external_user_id: 'a,b' }, 'address_unusable'],
    ]
    for (const [label, over, expected] of cases) {
      const { db } = scripted({ candidate: () => [candidateRow('u1', over)] })
      expect([label, code(await resolverWith().resolveForConnection(db, { orgId: ORG, ...one() }))]).toEqual([label, expected])
    }
    const { db } = scripted({ candidate: () => [candidateRow('u1')] })
    const inactive = resolverWith({ isActiveOrgMembers: async () => new Set() })
    expect(code(await inactive.resolveForConnection(db, { orgId: ORG, ...one() }))).toBe('user_not_active_member')
  })

  it('names the reason of a request that has no candidate from the diagnostic statement', async () => {
    const reasons: Array<[Row[], string]> = [
      [[], 'connection_not_found'],
      [[{ requested_user_id: 'u1', connection_id: CONN, connection_exists: false }], 'connection_not_found'],
      [[{ requested_user_id: 'u1', connection_id: CONN, connection_exists: true, connection_status: 'inactive', has_link: false }], 'connection_inactive'],
      [[{ requested_user_id: 'u1', connection_id: CONN, connection_exists: true, connection_status: 'active', has_link: false }], 'proof_missing'],
      [[{ requested_user_id: 'u1', connection_id: CONN, connection_exists: true, connection_status: 'active', has_link: true, link_status: 'pending', account_active: true }], 'proof_not_linked'],
      [[{ requested_user_id: 'u1', connection_id: CONN, connection_exists: true, connection_status: 'active', has_link: true, link_status: 'linked', account_active: false }], 'proof_account_inactive'],
      [[{ requested_user_id: 'u1', connection_id: CONN, connection_exists: true, connection_status: 'active', has_link: true, link_status: 'linked', account_active: true, account_corp_id: null }], 'scope_unproven'],
    ]
    for (const [rows, expected] of reasons) {
      const { db, count } = scripted({ candidate: () => [], diagnostic: () => rows })
      expect(code(await resolverWith().resolveForConnection(db, { orgId: ORG, ...one() }))).toBe(expected)
      expect(count('diagnostic')).toBe(1)
    }
  })

  it('does not issue the diagnostic statement when every request has a candidate', async () => {
    const { db, count } = scripted({ candidate: () => [candidateRow('u1')] })
    await resolverWith().resolveForConnection(db, { orgId: ORG, ...one() })
    expect(count('diagnostic')).toBe(0)
  })

  it('treats a connection id that is not a UUID as not found without a statement', async () => {
    const { db, log } = scripted({})
    const result = await resolverWith().resolveForConnection(db, { orgId: ORG, userId: 'u1', connectionId: "x'; DROP", proofKind: 'directory_link' })
    expect(code(result)).toBe('connection_not_found')
    expect(log).toEqual([])
  })

  it('default targets name an ambiguous user as proof_ambiguous', async () => {
    const rows = [candidateRow('u2', { rn: 1, n: 2 }), candidateRow('u2', { rn: 2, n: 2, account_id: 'account-2' }), candidateRow('u1')]
    const { db } = scripted({ candidate: () => rows })
    const results = await resolverWith().deriveDefaultTargets(db, { orgId: ORG, connectionId: CONN, userIds: ['u1', 'u2'] })
    expect(results.map(code)).toEqual(['ok', 'proof_ambiguous'])
  })

  it('derives a default target from the directory link only', async () => {
    const { db, log } = scripted({ candidate: () => [candidateRow('u1')] })
    const [result] = await resolverWith().deriveDefaultTargets(db, { orgId: ORG, connectionId: CONN, userIds: ['u1'] })
    expect(code(result)).toBe('ok')
    expect(log.map((entry) => entry.kind)).toEqual(['candidate'])
    const single = await resolverWith().deriveDefaultTarget(scripted({ candidate: () => [candidateRow('u1')] }).db, { orgId: ORG, userId: 'u1', connectionId: CONN })
    expect(code(single)).toBe('ok')
  })
})

describe('set-based statements', () => {
  const rowsFor = (params: unknown[]): Row[] => (params[0] as string[]).map((userId) => candidateRow(userId))

  async function statementCount(requests: number): Promise<number> {
    const { db, log } = scripted({ candidate: (params) => rowsFor(params) })
    const asks = Array.from({ length: requests }, (_, index) => ({ userId: `u${index}`, connectionId: CONN, proofKind: 'directory_link' as const }))
    const results = await resolverWith().resolveMany(db, { orgId: ORG, requests: asks })
    expect(results.every((result) => result.ok === true)).toBe(true)
    return log.length
  }

  it('issues the same number of statements for 1 and for 2,000 requests, and aligns the answers with the requests', async () => {
    expect(await statementCount(1)).toBe(await statementCount(2000))
    const { db } = scripted({ candidate: (params) => rowsFor(params) })
    const asks = ['u3', 'u1', 'u2'].map((userId) => one(userId))
    const results = await resolverWith().resolveMany(db, { orgId: ORG, requests: asks })
    expect(results.map((result) => (result.ok === true ? result.target.proofId : null))).toEqual(['proof-u3', 'proof-u1', 'proof-u2'])
  })

  it('answers a repeated request twice, as ok, and sends the key once', async () => {
    const { db, log } = scripted({ candidate: (params) => rowsFor(params) })
    const asks = [one('u1'), one('u1'), one('u2'), one('u1', CONN.toUpperCase())]
    const results = await resolverWith().resolveMany(db, { orgId: ORG, requests: asks })
    expect(results.map(code)).toEqual(['ok', 'ok', 'ok', 'ok'])
    const candidate = log.find((entry) => entry.kind === 'candidate')!
    expect(candidate.params[0]).toEqual(['u1', 'u2'])
    expect(candidate.params[1]).toHaveLength(2)
  })

  it('serves a batch of re-checks with one statement and one membership call whatever the batch size', async () => {
    let calls = 0
    const batch = (size: number) => {
      const { db, log } = scripted({ verify: () => [] })
      return resolverWith({
        isActiveOrgMembers: async (_db, _org, ids) => {
          calls += 1
          return new Set(ids)
        },
      })
        .verifyEndpoints(db, { orgId: ORG, refs: Array.from({ length: size }, (_, index) => ({ endpointId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, userId: 'u1' })) })
        .then((results) => ({ results, statements: log.length }))
    }
    const small = await batch(1)
    const large = await batch(500)
    expect(small.statements).toBe(large.statements)
    expect(large.results.every((result) => code(result) === 'endpoint_not_found')).toBe(true)
    expect(calls).toBe(0)
  })

  it('has one candidate statement, which every single-row call goes through', async () => {
    expect(SOURCE.split('row_number() OVER').length - 1).toBe(1)
    const { db, log } = scripted({ candidate: () => [candidateRow('u1')] })
    const resolver = resolverWith()
    await resolver.resolveForConnection(db, { orgId: ORG, ...one() })
    await resolver.deriveDefaultTarget(db, { orgId: ORG, userId: 'u1', connectionId: CONN })
    expect(log.filter((entry) => entry.kind === 'candidate').map((entry) => entry.sql).every((sql) => sql === log[0].sql)).toBe(true)
    expect((log[0].params[0] as string[]).length).toBe(1)
  })
})

describe('source of the statements', () => {
  const statements = [...SOURCE.matchAll(/const (\w+_SQL) = `([\s\S]*?)`/g)].map((match) => ({ name: match[1], sql: match[2] }))

  it('finds the statements it checks', () => {
    expect(statements.map((entry) => entry.name).sort()).toEqual(['CANDIDATE_SQL', 'CONNECTION_SQL', 'DIAGNOSTIC_SQL', 'LINKED_CONNECTIONS_SQL', 'OWN_ENDPOINTS_SQL', 'VERIFY_SQL'])
  })

  it('references every placeholder from $1 to the highest, in every statement', () => {
    for (const { name, sql } of statements) {
      const used = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))].sort((a, b) => a - b)
      expect(used, name).toEqual(Array.from({ length: used.length }, (_, index) => index + 1))
    }
  })

  it('names the connection explicitly, compares the corp id without a wildcard, filters before the window, and never picks by recency', () => {
    const candidate = statements.find((entry) => entry.name === 'CANDIDATE_SQL')!.sql
    expect(candidate).toContain('i.id = q.connection_id')
    expect(candidate).toContain('a.corp_id = i.corp_id')
    expect(candidate).not.toMatch(/corp_id IS NULL OR/)
    // Every validity filter sits inside the window's source rows; the final select only cuts the window.
    const window = candidate.slice(candidate.indexOf('row_number() OVER'))
    const source = window.slice(window.indexOf('FROM q'), window.indexOf('SELECT * FROM c'))
    expect(source).toContain('a.is_active')
    expect(source).toContain("l.link_status = 'linked'")
    expect(candidate.endsWith('SELECT * FROM c WHERE rn <= 2')).toBe(true)
    expect(candidate).toMatch(/WITH q AS[\s\S]*row_number\(\) OVER[\s\S]*SELECT \* FROM c WHERE rn <= 2/)
    for (const { name, sql } of statements) expect(sql, name).not.toMatch(/ORDER BY[^)]*updated_at/)
  })

  it('reads configuration only key by key, never the whole object', () => {
    for (const { name, sql } of statements) {
      const reads = [...sql.matchAll(/\b[a-z]\.config\b/g)].length
      const projected = [...sql.matchAll(/jsonb_typeof\([a-z]\.config\)|jsonb_each\([a-z]\.config\)/g)].length
      expect(reads, name).toBe(projected)
    }
  })

  it('reads an endpoint by organization and user, and re-checks the account against the endpoint connection', () => {
    const verify = statements.find((entry) => entry.name === 'VERIFY_SQL')!.sql
    expect(verify).toContain('e.org_id = $3')
    expect(verify).toContain('e.user_id = q.user_id')
    expect(verify).toContain('a.integration_id::text AS account_integration_id')
    expect(SOURCE).toContain('text(row.account_integration_id) !== endpoint.connectionId')
    const own = statements.find((entry) => entry.name === 'OWN_ENDPOINTS_SQL')!.sql
    expect(own).toContain('org_id = $1 AND user_id = $2')
  })
})

describe('re-checking an endpoint', () => {
  const link = (over: Row = {}): Row => ({ ...candidateRow('u1'), ...over })

  /** The stored endpoint is whatever the first resolution derived. */
  async function stored(over: Row = {}) {
    const resolver = resolverWith()
    const first = await resolver.resolveForConnection(scripted({ candidate: () => [candidateRow('u1')] }).db, { orgId: ORG, ...one() })
    if (first.ok !== true) throw new Error('setup')
    const t = first.target
    const row = (extra: Row): Row => ({
      endpoint_id: ENDPOINT,
      endpoint_user_id: 'u1',
      endpoint_connection_id: CONN,
      endpoint_provider: 'dingtalk',
      endpoint_address_kind: 'dingtalk_userid',
      endpoint_proof_kind: 'directory_link',
      endpoint_proof_id: 'proof-u1',
      endpoint_proof_witness: t.proofWitness,
      endpoint_address_witness: t.addressWitness,
      endpoint_tenant_address_witness: t.tenantAddressWitness,
      endpoint_bound_tenant: 'CorpOne',
      endpoint_bound_app_scope: 'AppOne',
      link_id: 'proof-u1',
      link_user_id: 'u1',
      link_status: 'linked',
      account_id: 'account-u1',
      account_integration_id: CONN,
      account_active: true,
      account_provider: 'dingtalk',
      account_corp_id: 'CorpOne',
      external_user_id: 'dt-u1',
      union_id: null,
      open_id: null,
      connection_id: CONN,
      connection_org_id: ORG,
      connection_provider: 'dingtalk',
      connection_status: 'active',
      connection_corp_id: 'CorpOne',
      scope_config: { appKey: 'AppOne' },
      ...extra,
    })
    return { resolver, row: row(over) }
  }

  const verifyWith = async (over: Row, resolverOver?: Partial<RecipientResolverDeps>) => {
    const { row } = await stored()
    const resolver = resolverWith(resolverOver)
    const { db } = scripted({ verify: () => [{ ...row, ...over }] })
    return code(await resolver.verifyEndpoint(db, { orgId: ORG, userId: 'u1', endpointId: ENDPOINT }))
  }

  it('passes an unchanged endpoint', async () => {
    expect(await verifyWith({})).toBe('ok')
  })

  it('answers endpoint_not_found for a missing row, which is also what another user, another organization or an unknown id read as', async () => {
    const { db } = scripted({ verify: () => [] })
    expect(code(await resolverWith().verifyEndpoint(db, { orgId: ORG, userId: 'u1', endpointId: ENDPOINT }))).toBe('endpoint_not_found')
    expect(code(await resolverWith().verifyEndpoint(db, { orgId: ORG, userId: 'u1', endpointId: 'not-a-uuid' }))).toBe('endpoint_not_found')
  })

  it('answers each way the proof can have changed with its own code', async () => {
    const cases: Array<[string, Row, string]> = [
      ['connection gone', { connection_id: null }, 'connection_not_found'],
      ['connection inactive', { connection_status: 'inactive' }, 'connection_inactive'],
      ['link gone', { link_id: null }, 'proof_missing'],
      ['link status changed', { link_status: 'pending' }, 'proof_not_linked'],
      ['administrator unbind', { link_user_id: null, link_status: 'unmatched' }, 'proof_not_linked'],
      ['link moved to another user', { link_user_id: 'u2' }, 'proof_wrong_user'],
      ['account moved to another integration', { account_integration_id: CONN2 }, 'scope_changed'],
      ['account inactive', { account_active: false }, 'proof_account_inactive'],
      ['account corp id empty', { account_corp_id: null }, 'scope_unproven'],
      ['account corp id different', { account_corp_id: 'CorpTwo' }, 'scope_unproven'],
      ['application key changed', { scope_config: { appKey: 'AppTwo' } }, 'scope_changed'],
      ['tenant changed', { connection_corp_id: 'CorpTwo', account_corp_id: 'CorpTwo' }, 'scope_changed'],
      ['union id changed', { union_id: 'union-new' }, 'proof_changed'],
      ['identifier changed', { external_user_id: 'dt-other' }, 'proof_changed'],
      ['address kind changed', { endpoint_address_kind: 'wecom_userid' }, 'proof_changed'],
      ['identifier unusable', { external_user_id: 'a,b' }, 'address_unusable'],
    ]
    for (const [label, over, expected] of cases) {
      expect([label, await verifyWith(over)]).toEqual([label, expected])
    }
    expect(await verifyWith({}, { isActiveOrgMembers: async () => new Set() })).toBe('user_not_active_member')
  })
})

describe('external identity proofs', () => {
  const wecomish: ProviderTransportDescriptor = {
    provider: 'wecomish',
    displayName: 'W',
    transport: 'message',
    addressKind: 'wecom_userid',
    proofRules: { directory_link: null, external_identity: { from: 'identity_subject', subjectType: 'userid' } },
    idScope: 'tenant',
    forbiddenInAddress: ['|'],
    maxAddressLength: 64,
    scopeConfigKeys: ['appKey'],
    recipientLevelNonAcceptanceFields: [],
    providerDedupe: 'none',
    fallbackEligibleCodes: [],
  }
  const appScoped: ProviderTransportDescriptor = { ...wecomish, provider: 'appish', idScope: 'app' }
  const registry = [...productionProviderNotificationRegistry(), wecomish, appScoped]
  const scopeOf = (_provider: string, row: { corp_id: string; config: unknown }) => {
    const appKey = (row.config as { appKey?: string } | null)?.appKey
    return appKey ? { tenant: row.corp_id, appScope: appKey } : null
  }
  const proof = (over: Partial<ExternalIdentityProof> = {}): ExternalIdentityProof => ({
    identityId: 'identity-1',
    bindingRevision: 1,
    subjectType: 'userid',
    subjectKey: 'zhangsan',
    issuer: { tenant: 'CorpOne', appScope: 'AppOne' },
    establishedBy: 'self_authenticated',
    verified: true,
    revoked: false,
    ...over,
  })
  const reader = (provider: string, result: ExternalIdentityProof | null): ExternalIdentityProofReader => ({ provider, read: async () => result })
  const connectionRow = (provider: string, over: Row = {}): Row => ({
    connection_id: CONN,
    org_id: ORG,
    provider,
    status: 'active',
    corp_id: 'CorpOne',
    scope_config: { appKey: 'AppOne' },
    ...over,
  })
  const ask = (provider: string, readers: Record<string, ExternalIdentityProofReader>, connection: Row = connectionRow(provider)) =>
    createRecipientResolver({ isActiveOrgMembers: everyoneActive, registry, scopeOf, externalIdentityReaders: readers }).resolveMany(
      scripted({ connection: () => [connection] }).db,
      { orgId: ORG, requests: [{ userId: 'u1', connectionId: CONN, proofKind: 'external_identity' }] },
    )

  it('has no address for DingTalk, whatever reader is registered', async () => {
    const results = await ask('dingtalk', { dingtalk: reader('dingtalk', proof()) })
    expect(code(results[0])).toBe('address_kind_not_derivable')
  })

  it('is unavailable without a reader and with the null reader', async () => {
    expect(code((await ask('wecomish', {}))[0])).toBe('proof_kind_unavailable')
    expect(code((await ask('wecomish', { wecomish: new NullExternalIdentityProofReader('wecomish') }))[0])).toBe('proof_kind_unavailable')
  })

  it('walks the matrix of reader answer, scope and how the binding was established', async () => {
    const cases: Array<[string, string, ExternalIdentityProof | null, string]> = [
      ['no identity', 'wecomish', null, 'proof_missing'],
      ['wrong subject type', 'wecomish', proof({ subjectType: 'open_id' }), 'scope_unproven'],
      ['other tenant', 'wecomish', proof({ issuer: { tenant: 'CorpTwo', appScope: null } }), 'scope_unproven'],
      ['association binding', 'wecomish', proof({ establishedBy: 'association' }), 'proof_assurance_insufficient'],
      ['self authenticated', 'wecomish', proof(), 'ok'],
      ['application scope not needed for a tenant id', 'wecomish', proof({ issuer: { tenant: 'CorpOne', appScope: null } }), 'ok'],
      ['application id from another application', 'appish', proof({ issuer: { tenant: 'CorpOne', appScope: 'AppTwo' } }), 'scope_unproven'],
      ['application id without an application', 'appish', proof({ issuer: { tenant: 'CorpOne', appScope: null } }), 'scope_unproven'],
      ['application id from this application', 'appish', proof(), 'ok'],
      ['identifier naming several people', 'wecomish', proof({ subjectKey: 'a|b' }), 'address_unusable'],
    ]
    for (const [label, provider, answer, expected] of cases) {
      const results = await ask(provider, { [provider]: reader(provider, answer) })
      expect([label, code(results[0])]).toEqual([label, expected])
    }
  })

  it('reports an inactive connection, a missing connection and an unregistered provider', async () => {
    expect(code((await ask('wecomish', { wecomish: reader('wecomish', proof()) }, connectionRow('wecomish', { status: 'inactive' })))[0])).toBe('connection_inactive')
    expect(code((await ask('wecomish', { wecomish: reader('wecomish', proof()) }, connectionRow('unlisted')))[0])).toBe('provider_not_registered')
    const resolver = createRecipientResolver({ isActiveOrgMembers: everyoneActive, registry, scopeOf })
    const none = await resolver.resolveMany(scripted({ connection: () => [] }).db, { orgId: ORG, requests: [{ userId: 'u1', connectionId: CONN, proofKind: 'external_identity' }] })
    expect(code(none[0])).toBe('connection_not_found')
  })

  it('makes the proof digest depend on how the binding was established', async () => {
    const digest = async (establishedBy: ExternalIdentityProof['establishedBy']) => {
      const [result] = await ask('wecomish', { wecomish: reader('wecomish', proof({ establishedBy })) })
      return result.ok === true ? result.target.proofWitness : 'none'
    }
    expect(await digest('self_authenticated')).toMatch(/^[0-9a-f]{64}$/)
    expect(await digest('association')).toBe('none')
  })
})

describe('candidates', () => {
  const linked = (rows: Row[] = [{ connection_id: CONN, provider: 'dingtalk', name: 'HQ' }]) => rows

  it('lists the connections where the user has a proof row, with a label that holds no identifier', async () => {
    const { db } = scripted({ linked: () => linked(), candidate: () => [candidateRow('u1')], own: () => [] })
    const candidates = await resolverWith().listCandidates(db, { orgId: ORG, userId: 'u1' })
    expect(candidates).toEqual([
      { connectionId: CONN, provider: 'dingtalk', label: '钉钉 · HQ', proofKind: 'directory_link', addressable: true, reasonCode: null, endpointId: null },
      { connectionId: CONN, provider: 'dingtalk', label: '钉钉 · HQ', proofKind: 'external_identity', addressable: false, reasonCode: 'address_kind_not_derivable', endpointId: null },
    ])
    expect(JSON.stringify(candidates)).not.toContain('dt-u1')
  })

  it('lists nothing, and reads nothing else, for a user with no proof row', async () => {
    const { db, log } = scripted({ linked: () => [] })
    expect(await resolverWith().listCandidates(db, { orgId: ORG, userId: 'u1' })).toEqual([])
    expect(log.map((entry) => entry.kind)).toEqual(['linked'])
  })

  it('skips a connection of a provider that is not registered', async () => {
    const { db, log } = scripted({ linked: () => linked([{ connection_id: CONN, provider: 'local', name: 'Local' }]) })
    expect(await resolverWith().listCandidates(db, { orgId: ORG, userId: 'u1' })).toEqual([])
    expect(log).toHaveLength(1)
  })

  it('carries the id of the own endpoint on that connection, and flags an address held on another connection of the tenant', async () => {
    const first = await resolverWith().resolveForConnection(scripted({ candidate: () => [candidateRow('u1')] }).db, { orgId: ORG, ...one() })
    if (first.ok !== true) throw new Error('setup')
    const tenantWitness = first.target.tenantAddressWitness
    const own = (rows: Row[]) => scripted({ linked: () => linked([{ connection_id: CONN2, provider: 'dingtalk', name: 'Branch' }]), candidate: () => [candidateRow('u1', { connection_id: CONN2 })], own: () => rows })
    const held = await resolverWith().listCandidates(own([{ id: ENDPOINT, connection_id: CONN, proof_kind: 'directory_link', status: 'active', provider: 'dingtalk', tenant_address_witness: tenantWitness }]).db, { orgId: ORG, userId: 'u1' })
    expect(held[0]).toMatchObject({ connectionId: CONN2, addressable: false, reasonCode: 'address_bound_on_other_connection', endpointId: null })
    const stale = await resolverWith().listCandidates(own([{ id: ENDPOINT, connection_id: CONN, proof_kind: 'directory_link', status: 'stale', provider: 'dingtalk', tenant_address_witness: tenantWitness }]).db, { orgId: ORG, userId: 'u1' })
    expect(stale[0]).toMatchObject({ addressable: true, reasonCode: null })
    const same = await resolverWith().listCandidates(own([{ id: ENDPOINT, connection_id: CONN2, proof_kind: 'directory_link', status: 'active', provider: 'dingtalk', tenant_address_witness: tenantWitness }]).db, { orgId: ORG, userId: 'u1' })
    expect(same[0]).toMatchObject({ addressable: true, endpointId: ENDPOINT })
  })
})

describe('the protected address', () => {
  it('gives only a placeholder to serialization, string conversion, templates and inspection', () => {
    const address = new ProtectedAddress('secret-address')
    expect(address.reveal()).toBe('secret-address')
    for (const text of [JSON.stringify(address), JSON.stringify({ address }), String(address), `${address}`, inspect(address), inspect({ nested: { address } }, { depth: 5 }), address + '']) {
      expect(text).not.toContain('secret-address')
    }
    expect(JSON.stringify(address)).toBe('"[address]"')
    expect(String(address)).toBe('[address]')
  })

  it('keeps the value out of every own property', () => {
    const address = new ProtectedAddress('secret-address')
    expect(Object.keys(address)).toEqual([])
    expect(JSON.stringify(Object.getOwnPropertyNames(address))).not.toContain('secret')
  })
})
