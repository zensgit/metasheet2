/**
 * The capability write service against a scripted transaction client: the closed body allowlist, the
 * fixed statement order, the revision check, what turning a capability off and on means per capability,
 * enable preconditions and enable gates, the typed error mapping, and the audit records.
 *
 * Turning a capability on is reachable only with an injected registry: the production registry governs
 * every capability as legacy. Rows are held by the script; the insert and update statements the service
 * issues are applied to them, so the assertions read what the service wrote.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CAPABILITIES_AUDIT_REFUSED_ACTION,
  CAPABILITIES_AUDIT_RESOURCE_TYPE,
  CAPABILITIES_AUDIT_UPDATE_ACTION,
  CAPABILITY_REFUSAL_CODES,
  PATCH_BODY_FIELD,
  PATCH_UNKNOWN_FIELD,
  PRECONDITIONS_MISSING_CODE,
  PRECONDITION_CODE_MALFORMED,
  PRODUCTION_CAPABILITY_ENABLE_GATES,
  createDirectoryIntegrationCapabilitiesWriteService,
  parseCapabilitiesPatchBody,
  type CapabilitiesPatchResult,
  type CapabilitiesWriteServiceDeps,
  type CapabilityAuditEvent,
  type CapabilityEnableGate,
  type CapabilityEnableGates,
} from '../../src/integrations/directory-integration-capabilities-write-service'
import { isCapabilityImplementationAvailable } from '../../src/integrations/integration-capability-implementations'
import {
  resolveProviderCapabilityDescriptor,
  scopeFromValues,
  type CapabilityGovernance,
  type CapabilityTransactionClient,
  type EnablePreconditionContext,
  type EnablePreconditionResult,
  type IntegrationCapability,
  type ProviderCapabilityDescriptor,
} from '../../src/integrations/provider-capability-registry'

const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const ORG = 'org-alpha'
const CORP = 'corp-value-not-for-output'
const APP = 'app-value-not-for-output'
const OTHER_APP = 'app-older-value-not-for-output'
const ACTOR = 'admin-7'
const CAPABILITIES = ['directory', 'login', 'notification'] as const
/** Carried by every URI sent in a field outside the allowlist: no answer may echo it. */
const REFUSED_URI_MARKER = 'refused-uri-marker-h5p9c2'

type Row = Record<string, unknown>
type Governance = Record<IntegrationCapability, CapabilityGovernance>
type Kind =
  | 'isolation'
  | 'lock_timeout'
  | 'statement_timeout'
  | 'probe'
  | 'integration_exists'
  | 'integration_for_share'
  | 'state_for_update'
  | 'insert_state'
  | 'update_state'
  | 'insert_history'
  | 'unknown'

const ALL_GATED: Governance = { directory: 'gated', login: 'gated', notification: 'gated' }

function integrationRow(overrides: Row = {}): Row {
  return {
    id: ID, org_id: ORG, provider: 'acme', status: 'active', corp_id: CORP, config: { app: APP },
    sync_enabled: false, schedule_cron: null, ...overrides,
  }
}

function stateRow(enabled: IntegrationCapability[] = [], overrides: Row = {}): Row {
  const row: Row = {
    integration_id: ID, bound_provider: 'acme', bound_org_id: ORG, revision: '3',
    created_by: 'admin-1', updated_by: 'admin-1',
    created_at: new Date('2026-11-01T00:00:00Z'), updated_at: new Date('2026-11-02T00:00:00Z'),
  }
  for (const capability of CAPABILITIES) {
    const on = enabled.includes(capability)
    row[`${capability}_enabled`] = on
    row[`${capability}_bound_tenant`] = on ? CORP : null
    row[`${capability}_bound_app_scope`] = on ? APP : null
  }
  return { ...row, ...overrides }
}

function kindOf(sql: string): Kind {
  if (sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') return 'isolation'
  if (/^SET LOCAL lock_timeout\b/.test(sql)) return 'lock_timeout'
  if (/^SET LOCAL statement_timeout\b/.test(sql)) return 'statement_timeout'
  if (/to_regclass/.test(sql)) return 'probe'
  if (/^INSERT INTO directory_integration_capability_history\b/.test(sql)) return 'insert_history'
  if (/^INSERT INTO directory_integration_capabilities\b/.test(sql)) return 'insert_state'
  if (/^UPDATE directory_integration_capabilities\b/.test(sql)) return 'update_state'
  if (/FROM directory_integration_capabilities\b/.test(sql)) return 'state_for_update'
  if (/FROM directory_integrations\b/.test(sql)) return /\bFOR SHARE\b/.test(sql) ? 'integration_for_share' : 'integration_exists'
  return 'unknown'
}

/** The assignments of the service's UPDATE: the text between SET and WHERE. */
function setClauseOf(sql: string): string {
  const clause = /\bSET ([\s\S]*?)\s+WHERE\b/.exec(sql)
  if (!clause) throw new Error('update without a SET clause')
  return clause[1].trim()
}

/** Applies the assignments of the service's UPDATE to the scripted row. */
function applyUpdate(sql: string, params: unknown[], current: Row): Row {
  const next: Row = { ...current }
  for (const part of setClauseOf(sql).split(',').map((text) => text.trim())) {
    const [column, expression] = part.split(' = ').map((text) => text.trim())
    if (column === 'revision') {
      if (expression !== 'revision + 1') throw new Error('the revision must advance by one')
      next.revision = String(Number(current.revision) + 1)
    } else if (column === 'updated_at') next.updated_at = new Date('2026-11-20T08:00:00Z')
    else if (expression === 'true') next[column] = true
    else if (expression === 'false') next[column] = false
    else if (expression === 'NULL') next[column] = null
    else if (/^\$\d+$/.test(expression)) next[column] = params[Number(expression.slice(1)) - 1]
    else throw new Error(`unexpected assignment: ${part}`)
  }
  return next
}

interface Script {
  switchOn?: boolean
  tables?: boolean
  integration?: Row | null
  state?: Row | null
  /** Governance of the injected `acme` provider; null leaves `acme` unregistered. */
  governance?: Governance | null
  implemented?: boolean
  /**
   * 'throw': every scope read is recorded and then fails. A decision that reads the scope fails the
   * request; the answer shows such a read as no current scope, so a case about a request that must
   * not read the scope asserts on the record of reads.
   */
  scope?: 'from-row' | 'null' | 'throw'
  withoutPreconditions?: boolean
  precondition?: (capability: IntegrationCapability, context: EnablePreconditionContext) => Promise<unknown> | unknown
  gates?: CapabilityEnableGates
  /** An error to throw instead of answering a statement. */
  failOn?: (kind: Kind, sql: string) => unknown
  insertConflict?: boolean
  audit?: (event: CapabilityAuditEvent) => Promise<void>
}

function harness(script: Script = {}) {
  const statements: Array<{ sql: string; params?: unknown[]; kind: Kind }> = []
  const events: string[] = []
  const contexts: EnablePreconditionContext[] = []
  const audits: CapabilityAuditEvent[] = []
  const history: Row[] = []
  const store = {
    integration: 'integration' in script ? script.integration ?? null : integrationRow(),
    state: 'state' in script ? script.state ?? null : null,
  }
  const committed = { state: store.state }

  const client: CapabilityTransactionClient = {
    async query(sql: string, params?: unknown[]) {
      const kind = kindOf(sql)
      statements.push({ sql, params, kind })
      events.push(kind)
      const failure = script.failOn?.(kind, sql)
      if (failure) throw failure
      const ok = (rows: Row[]) => ({ rows, rowCount: rows.length })
      switch (kind) {
        case 'isolation':
        case 'lock_timeout':
        case 'statement_timeout':
          return ok([])
        case 'probe': {
          const present = script.tables ?? true
          return ok([{ capabilities: present, history: present }])
        }
        case 'integration_exists':
          return ok(store.integration && store.integration.id === params?.[0] ? [{ present: 1 }] : [])
        case 'integration_for_share':
          return ok(store.integration && store.integration.id === params?.[0] ? [store.integration] : [])
        case 'state_for_update':
          return ok(store.state ? [store.state] : [])
        case 'insert_state': {
          if (script.insertConflict) return ok([])
          const [integrationId, provider, org, ...rest] = params ?? []
          const row: Row = {
            integration_id: integrationId, bound_provider: provider, bound_org_id: org, revision: '1',
            created_by: rest[9], updated_by: rest[9],
            created_at: new Date('2026-11-20T08:00:00Z'), updated_at: new Date('2026-11-20T08:00:00Z'),
          }
          CAPABILITIES.forEach((capability, index) => {
            row[`${capability}_enabled`] = rest[index * 3]
            row[`${capability}_bound_tenant`] = rest[index * 3 + 1]
            row[`${capability}_bound_app_scope`] = rest[index * 3 + 2]
          })
          store.state = row
          return ok([row])
        }
        case 'update_state': {
          if (!store.state) return ok([])
          store.state = applyUpdate(sql, params ?? [], store.state)
          return ok([store.state])
        }
        case 'insert_history': {
          const [integrationId, provider, revision, actor, changed, rebound, directory, login, notification] = params ?? []
          history.push({ integrationId, provider, revision, actor, changed, rebound, directory, login, notification })
          return ok([])
        }
        default:
          throw new Error(`unexpected statement: ${sql}`)
      }
    },
  }

  const descriptor: ProviderCapabilityDescriptor | null =
    script.governance === null
      ? null
      : {
          provider: 'acme',
          governance: script.governance ?? ALL_GATED,
          scopeOf: (row) => {
            events.push('scopeOf')
            if (script.scope === 'throw') throw new Error('the scope was read')
            if (script.scope === 'null') return null
            return scopeFromValues(row.corp_id, (row.config as { app?: string } | null)?.app ?? '')
          },
          ...(script.withoutPreconditions
            ? {}
            : {
                enablePreconditions: async (capability: IntegrationCapability, context: EnablePreconditionContext) => {
                  events.push(`precondition:${capability}`)
                  contexts.push(context)
                  const answer = script.precondition ? await script.precondition(capability, context) : { ok: true }
                  return answer as EnablePreconditionResult
                },
              }),
          secretConfigKeys: Object.freeze([]),
        }

  const deps: CapabilitiesWriteServiceDeps = {
    isEnabled: () => script.switchOn ?? true,
    resolveDescriptor: (provider) => (provider === 'acme' ? descriptor : null),
    isImplementationAvailable: (provider) => provider === 'acme' && (script.implemented ?? true),
    readLoginRuntime: () => ({ available: false, requireGrant: false, autoLinkEmail: false, autoProvision: false }),
    isIntegrationScopedCredentialsEnabled: () => false,
    transaction: async (work) => {
      events.push('begin')
      const before = { integration: store.integration, state: store.state }
      const historyBefore = history.length
      try {
        const result = await work(client)
        committed.state = store.state
        events.push('commit')
        return result
      } catch (error) {
        store.integration = before.integration
        store.state = before.state
        history.length = historyBefore
        events.push('rollback')
        throw error
      }
    },
    capabilityGates: script.gates ?? {},
    audit: async (event) => {
      events.push('audit')
      audits.push(event)
      if (script.audit) await script.audit(event)
    },
  }
  const service = createDirectoryIntegrationCapabilitiesWriteService(deps)
  const patch = (body: unknown, integrationId = ID, actorId = ACTOR): Promise<CapabilitiesPatchResult> =>
    service.patch(integrationId, body, actorId)
  const kinds = () => statements.map((statement) => statement.kind)
  return { service, patch, statements, events, contexts, audits, history, store, committed, client, kinds }
}

const HEAD: Kind[] = ['isolation', 'lock_timeout', 'statement_timeout', 'probe']
const WRITES: Kind[] = ['insert_state', 'update_state', 'insert_history']
const pgError = (code: string, extra: Row = {}) => Object.assign(new Error(`driver text with ${CORP} and ${APP}`), { code, ...extra })
const body = (expectedRevision: number, capabilities: Partial<Record<IntegrationCapability, boolean>>) => ({ expectedRevision, capabilities })
const failing = (code: string): CapabilityEnableGate => async () => ({ ok: false, code })

function expectNoValues(value: unknown): void {
  const text = JSON.stringify(value)
  for (const secret of [CORP, APP, OTHER_APP]) expect(text).not.toContain(secret)
}

describe('the request body allowlist', () => {
  it('accepts the expected revision and at least one boolean capability, and nothing else', () => {
    expect(parseCapabilitiesPatchBody(body(0, { login: true }))).toEqual({ ok: true, input: body(0, { login: true }) })
    expect(parseCapabilitiesPatchBody(body(12, { directory: false, login: true, notification: false }))).toEqual({
      ok: true, input: body(12, { directory: false, login: true, notification: false }),
    })
    expect(parseCapabilitiesPatchBody(Object.assign(Object.create(null), body(1, { notification: true })))).toEqual({
      ok: true, input: body(1, { notification: true }),
    })
    const zero = parseCapabilitiesPatchBody({ expectedRevision: -0, capabilities: { login: false } })
    expect(zero.ok && Object.is(zero.input.expectedRevision, 0)).toBe(true)
    expect(parseCapabilitiesPatchBody(body(Number.MAX_SAFE_INTEGER, { login: false })).ok).toBe(true)
  })

  it('reports a body that is not a plain object under one fixed token', () => {
    class Carrier { expectedRevision = 0; capabilities = { login: true } }
    for (const value of [null, undefined, [], [body(0, { login: true })], 'text', 7, true, new Date(0), new Carrier(), new Map()]) {
      expect(parseCapabilitiesPatchBody(value)).toEqual({ ok: false, fields: [PATCH_BODY_FIELD] })
    }
    // Inherited fields are not read: an object that only inherits a valid body is not one.
    expect(parseCapabilitiesPatchBody(Object.create(body(0, { login: true })))).toEqual({ ok: false, fields: [PATCH_BODY_FIELD] })
  })

  it('reports every field outside the allowlist as unknown_field, once, without its name', () => {
    const extras: unknown[] = [
      { ...body(0, { login: true }), redirectUri: `urn:example:${REFUSED_URI_MARKER}:back` },
      { ...body(0, { login: true }), callbackUrl: `urn:example:${REFUSED_URI_MARKER}:hook` },
      { ...body(0, { login: true }), orgId: 'another-org', corpId: 'another-corp' },
      JSON.parse('{"expectedRevision":0,"capabilities":{"login":true},"__proto__":{"admin":true}}'),
      JSON.parse('{"expectedRevision":0,"capabilities":{"login":true,"__proto__":{"login":true}}}'),
      { expectedRevision: 0, capabilities: { login: true, sso: true, 'caller-chosen-name': true } },
      { ...body(0, { login: true }), [Symbol('s')]: 1 },
    ]
    for (const value of extras) {
      const parsed = parseCapabilitiesPatchBody(value)
      expect(parsed).toEqual({ ok: false, fields: [PATCH_UNKNOWN_FIELD] })
      expect(JSON.stringify(parsed)).not.toMatch(/redirectUri|callbackUrl|orgId|corpId|__proto__|sso|caller-chosen-name/)
      expect(JSON.stringify(parsed)).not.toContain(REFUSED_URI_MARKER)
    }
  })

  it('reports a wrong value of a known field under that field, in a fixed order', () => {
    for (const expectedRevision of [undefined, null, '0', '1', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, true, [0]]) {
      expect(parseCapabilitiesPatchBody({ expectedRevision, capabilities: { login: true } }), String(expectedRevision)).toEqual({ ok: false, fields: ['expectedRevision'] })
    }
    expect(parseCapabilitiesPatchBody({ capabilities: { login: true } })).toEqual({ ok: false, fields: ['expectedRevision'] })
    for (const capabilities of [undefined, null, [], 'login', true, {}]) {
      expect(parseCapabilitiesPatchBody({ expectedRevision: 0, capabilities })).toEqual({ ok: false, fields: ['capabilities'] })
    }
    expect(parseCapabilitiesPatchBody({ expectedRevision: 0 })).toEqual({ ok: false, fields: ['capabilities'] })
    for (const value of ['true', 1, 0, null, {}, []]) {
      expect(parseCapabilitiesPatchBody({ expectedRevision: 0, capabilities: { login: value } })).toEqual({ ok: false, fields: ['capabilities.login'] })
    }
    expect(parseCapabilitiesPatchBody({ extra: 1, expectedRevision: '0', capabilities: { directory: 1, notification: 'x', other: true } })).toEqual({
      ok: false, fields: [PATCH_UNKNOWN_FIELD, 'expectedRevision', 'capabilities.directory', 'capabilities.notification'],
    })
    expect(parseCapabilitiesPatchBody({})).toEqual({ ok: false, fields: ['expectedRevision', 'capabilities'] })
  })
})

describe('switch, tables, integration and body, in that order', () => {
  it('opens no transaction and issues no statement while the switch is off', async () => {
    const h = harness({ switchOn: false })
    expect(h.service.isEnabled()).toBe(false)
    expect(await h.patch(body(0, { login: true }))).toEqual({ kind: 'disabled' })
    expect(await h.patch('not a body')).toEqual({ kind: 'disabled' })
    expect(h.events).toEqual([])
  })

  it('stops after the existence probe when a table is missing, whatever the body', async () => {
    for (const request of [body(0, { login: true }), { redirectUri: 'x' }]) {
      const h = harness({ tables: false })
      expect(await h.patch(request)).toEqual({ kind: 'schema_unavailable' })
      expect(h.kinds()).toEqual(HEAD)
      expect(h.audits).toEqual([])
    }
  })

  it('reports a missing integration after the locked read and reads no capability row', async () => {
    const h = harness({ integration: null })
    expect(await h.patch(body(0, { login: true }))).toEqual({ kind: 'not_found' })
    expect(h.kinds()).toEqual([...HEAD, 'integration_for_share'])
    expect(h.audits).toEqual([])
  })

  it('answers an invalid body only after it knows the integration exists, and takes no row lock for it', async () => {
    const present = harness()
    expect(await present.patch({ expectedRevision: 0, capabilities: { login: true }, callbackUrl: `urn:example:${REFUSED_URI_MARKER}` })).toEqual({
      kind: 'invalid_input', fields: [PATCH_UNKNOWN_FIELD],
    })
    expect(present.kinds()).toEqual([...HEAD, 'integration_exists'])
    expect(present.statements.every((statement) => !/FOR (SHARE|UPDATE)/.test(statement.sql))).toBe(true)
    expect(present.audits).toEqual([])

    const missing = harness({ integration: null })
    expect(await missing.patch(null)).toEqual({ kind: 'not_found' })
    expect(missing.kinds()).toEqual([...HEAD, 'integration_exists'])
  })

  it('refuses to run without an administrator id', async () => {
    for (const actor of ['', '   ']) {
      const h = harness()
      await expect(h.patch(body(0, { login: true }), ID, actor)).rejects.toThrow('capability write cannot continue')
      expect(h.events).toEqual([])
    }
  })
})

describe('statement order of a write', () => {
  it('sets the isolation level first, then the two time bounds, probes, locks the integration row FOR SHARE and the capability row FOR UPDATE, writes the row and then the history', async () => {
    const h = harness()
    const result = await h.patch(body(0, { login: true }))
    expect(result.kind).toBe('ok')
    expect(h.kinds()).toEqual([...HEAD, 'integration_for_share', 'state_for_update', 'insert_state', 'insert_history'])
    expect(h.statements[0].sql).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(h.statements[1].sql).toBe("SET LOCAL lock_timeout = '5s'")
    expect(h.statements[2].sql).toBe("SET LOCAL statement_timeout = '30s'")
    const integrationRead = h.statements[4]
    expect(integrationRead.sql).toMatch(/WHERE id = \$1::uuid FOR SHARE$/)
    expect(integrationRead.sql).not.toMatch(/org_id\s*=/)
    expect(integrationRead.params).toEqual([ID])
    expect(h.statements[5].sql).toMatch(/WHERE integration_id = \$1::uuid FOR UPDATE$/)
    // The scope is read once to decide (after both locks, before the precondition) and again only to build the answer.
    expect(h.events.filter((event) => event !== 'scopeOf')).toEqual([
      'begin', ...HEAD, 'integration_for_share', 'state_for_update', 'precondition:login',
      'insert_state', 'insert_history', 'commit', 'audit',
    ])
    const firstScopeRead = h.events.indexOf('scopeOf')
    expect(firstScopeRead).toBe(h.events.indexOf('state_for_update') + 1)
    expect(h.events[firstScopeRead + 1]).toBe('precondition:login')
    expect(h.events.slice(firstScopeRead + 1, h.events.indexOf('insert_history')).includes('scopeOf')).toBe(false)
  })

  it('inserts with the primary key as the only conflict target and updates by integration id alone', async () => {
    const inserted = harness()
    await inserted.patch(body(0, { login: true }))
    const insert = inserted.statements.find((statement) => statement.kind === 'insert_state')!
    expect(insert.sql).toContain('ON CONFLICT (integration_id) DO NOTHING')
    expect(insert.sql.match(/ON CONFLICT/g)).toHaveLength(1)

    const updated = harness({ state: stateRow(['notification']) })
    await updated.patch(body(3, { login: true }))
    const update = updated.statements.find((statement) => statement.kind === 'update_state')!
    expect(update.sql).toContain('revision = revision + 1')
    expect(update.sql).toMatch(/WHERE integration_id = \$1::uuid\s+RETURNING/)
    expect(update.sql).not.toMatch(/AND\s+revision/)
    expect(updated.kinds()).toEqual([...HEAD, 'integration_for_share', 'state_for_update', 'update_state', 'insert_history'])
  })

  it('names no table other than the integrations table and the two capability tables', async () => {
    const h = harness({ state: stateRow(['login']) })
    await h.patch(body(3, { login: false, notification: true }))
    const tables = new Set<string>()
    for (const statement of h.statements) {
      for (const match of statement.sql.matchAll(/\b(?:FROM|INTO|UPDATE)\s+([a-z_]+)/g)) tables.add(match[1])
      for (const match of statement.sql.matchAll(/to_regclass\('([a-z_]+)'\)/g)) tables.add(match[1])
    }
    expect([...tables].sort()).toEqual(['directory_integration_capabilities', 'directory_integration_capability_history', 'directory_integrations'])
  })
})

describe('the revision check', () => {
  it('refuses any other revision before looking at what the request asks for', async () => {
    const cases: Array<[Row | null, number]> = [
      [stateRow(['login']), 0],
      [stateRow(['login']), 2],
      [stateRow(['login']), 4],
      [null, 1],
      [null, 3],
    ]
    for (const [state, expectedRevision] of cases) {
      for (const capabilities of [{ login: true }, { login: false }, { directory: true, notification: false }]) {
        const h = harness({ state, governance: { directory: 'legacy', login: 'legacy', notification: 'legacy' } })
        expect(await h.patch(body(expectedRevision, capabilities))).toEqual({ kind: 'stale' })
        expect(h.kinds()).toEqual([...HEAD, 'integration_for_share', 'state_for_update'])
        expect(h.events).not.toContain('scopeOf')
        expect(h.audits).toEqual([])
        expect(h.history).toEqual([])
      }
    }
  })

  it('is stale, not a refusal, for an unregistered provider with the wrong revision', async () => {
    const h = harness({ governance: null, state: stateRow([]) })
    expect(await h.patch(body(0, { login: true }))).toEqual({ kind: 'stale' })
  })

  it('reports a second request that finds the row created meanwhile as stale, with no history and no audit', async () => {
    const h = harness({ insertConflict: true })
    expect(await h.patch(body(0, { login: true }))).toEqual({ kind: 'stale' })
    expect(h.kinds()).toEqual([...HEAD, 'integration_for_share', 'state_for_update', 'insert_state'])
    expect(h.history).toEqual([])
    expect(h.audits).toEqual([])
  })

  it('fails with the fixed error when the stored revision is not a safe positive integer', async () => {
    for (const revision of ['9007199254740993', '-1', 'abc', '1.5']) {
      const h = harness({ state: stateRow(['login'], { revision }) })
      await expect(h.patch(body(3, { login: false }))).rejects.toThrow('capability state is not displayable')
      expect(h.events).toContain('rollback')
      expect(h.kinds().some((kind) => WRITES.includes(kind))).toBe(false)
    }
  })
})

describe('turning a capability off', () => {
  it('is allowed for an unregistered provider, a legacy or unsupported capability, a missing implementation, an inactive integration and a missing scope', async () => {
    const situations: Script[] = [
      { governance: null },
      { governance: { directory: 'legacy', login: 'legacy', notification: 'legacy' } },
      { governance: { directory: 'unsupported', login: 'unsupported', notification: 'unsupported' } },
      { implemented: false },
      { integration: integrationRow({ status: 'inactive' }) },
      { integration: integrationRow({ config: {} }) },
      { scope: 'null' },
      { withoutPreconditions: true },
      { gates: { login: [failing('GATE_SAYS_NO')] } },
    ]
    for (const situation of situations) {
      const h = harness({ ...situation, state: stateRow(['login', 'notification']) })
      const result = await h.patch(body(3, { login: false }))
      expect(result.kind).toBe('ok')
      if (result.kind !== 'ok') continue
      expect(result.changed).toBe(true)
      expect(result.view.revision).toBe(4)
      expect(result.view.capabilities.login).toMatchObject({ enabled: false, anchor: { bound: false, matchesCurrent: null } })
      expect(h.committed.state).toMatchObject({
        login_enabled: false, login_bound_tenant: null, login_bound_app_scope: null,
        notification_enabled: true, notification_bound_tenant: CORP, notification_bound_app_scope: APP,
        revision: '4', updated_by: ACTOR, created_by: 'admin-1',
      })
      expect(h.history).toEqual([{
        integrationId: ID, provider: 'acme', revision: 4, actor: ACTOR, changed: ['login'], rebound: [],
        directory: false, login: false, notification: true,
      }])
      expect(h.events.filter((event) => event.startsWith('precondition'))).toEqual([])
    }
  })

  it('never reads the scope to decide: with another capability still bound, the scope is first read after the row and the history were written, to show that other capability', async () => {
    const h = harness({ state: stateRow(['login', 'notification']) })
    const result = await h.patch(body(3, { login: false }))
    const firstScopeRead = h.events.indexOf('scopeOf')
    expect(firstScopeRead).toBeGreaterThan(h.events.indexOf('insert_history'))
    expect(h.events.indexOf('update_state')).toBeLessThan(h.events.indexOf('insert_history'))
    expect(result).toMatchObject({
      kind: 'ok', changed: true,
      view: { revision: 4, capabilities: {
        login: { enabled: false, anchor: { bound: false, matchesCurrent: null } },
        notification: { enabled: true, effective: true, reason: null, anchor: { bound: true, matchesCurrent: true } },
      } },
    })

    // That read is for the answer only. With a scope that is not complete, the capability that stays
    // on is shown as not matching, and login is turned off and committed all the same.
    const incomplete = harness({ scope: 'null', state: stateRow(['login', 'notification']) })
    const answer = await incomplete.patch(body(3, { login: false }))
    expect(answer).toMatchObject({
      kind: 'ok', changed: true,
      view: { revision: 4, capabilities: {
        login: { enabled: false, anchor: { bound: false, matchesCurrent: null } },
        notification: { enabled: true, effective: false, reason: 'scope_changed', anchor: { bound: true, matchesCurrent: false } },
      } },
    })
    expect(incomplete.events.indexOf('scopeOf')).toBeGreaterThan(incomplete.events.indexOf('insert_history'))
    expect(incomplete.events.slice(-2)).toEqual(['commit', 'audit'])
    expect(incomplete.committed.state).toMatchObject({
      login_enabled: false, login_bound_tenant: null, login_bound_app_scope: null,
      notification_enabled: true, notification_bound_tenant: CORP, notification_bound_app_scope: APP,
      revision: '4',
    })
    expect(incomplete.history).toHaveLength(1)

    const unregistered = harness({ governance: null, state: stateRow(['login']) })
    await unregistered.patch(body(3, { login: false }))
    expect(unregistered.events).not.toContain('scopeOf')
  })

  it('reads no scope at all when the request leaves no anchor on the row, with a provider whose every scope read fails', async () => {
    // The last capability that was on is turned off: a change, and nothing left to compare a scope with.
    const last = harness({ scope: 'throw', state: stateRow(['login']) })
    const lastResult = await last.patch(body(3, { login: false }))
    expect(lastResult).toMatchObject({ kind: 'ok', changed: true, view: { revision: 4 } })
    if (lastResult.kind !== 'ok') throw new Error('expected a view')
    for (const capability of CAPABILITIES) {
      expect(lastResult.view.capabilities[capability]).toMatchObject({ enabled: false, anchor: { bound: false, matchesCurrent: null } })
    }
    expect(last.events).not.toContain('scopeOf')
    expect(last.events.slice(-2)).toEqual(['commit', 'audit'])
    expect(last.committed.state).toMatchObject({ login_enabled: false, login_bound_tenant: null, login_bound_app_scope: null, revision: '4' })
    expect(last.history).toEqual([{
      integrationId: ID, provider: 'acme', revision: 4, actor: ACTOR, changed: ['login'], rebound: [],
      directory: false, login: false, notification: false,
    }])

    // Every capability that was on is turned off in one request.
    const all = harness({ scope: 'throw', state: stateRow(['directory', 'login', 'notification']) })
    expect(await all.patch(body(3, { directory: false, login: false, notification: false }))).toMatchObject({
      kind: 'ok', changed: true, view: { revision: 4 },
    })
    expect(all.events).not.toContain('scopeOf')

    // Nothing to turn off: no capability row, and a row on which every capability is already off.
    const unchanged: Array<[Row | null, number]> = [[null, 0], [stateRow([]), 3]]
    for (const [state, expectedRevision] of unchanged) {
      for (const capabilities of [{ login: false }, { directory: false, login: false, notification: false }]) {
        const h = harness({ scope: 'throw', state })
        const result = await h.patch(body(expectedRevision, capabilities))
        expect(result).toMatchObject({ kind: 'ok', changed: false, view: { revision: expectedRevision } })
        if (result.kind !== 'ok') throw new Error('expected a view')
        expect(result.view.capabilities.login).toEqual({
          enabled: false, governance: 'gated', effective: false, reason: 'not_enabled', anchor: { bound: false, matchesCurrent: null },
        })
        expect(h.events).not.toContain('scopeOf')
        expect(h.kinds()).toEqual([...HEAD, 'integration_for_share', 'state_for_update'])
        expect(h.committed.state).toBe(state)
        expect(h.audits).toEqual([])
      }
    }

    // The witness is live: the same provider fails a request that does need the scope.
    const on = harness({ scope: 'throw' })
    await expect(on.patch(body(0, { login: true }))).rejects.toThrow('the scope was read')
    expect(on.events.filter((event) => event === 'scopeOf')).toHaveLength(1)
    expect(on.kinds().some((kind) => WRITES.includes(kind))).toBe(false)
  })

  it('commits the disable when the scope read for the answer throws, and shows the capability that stays on as stored and not matching', async () => {
    const h = harness({ scope: 'throw', state: stateRow(['login', 'notification']) })
    const result = await h.patch(body(3, { login: false }))

    const off = { enabled: false, governance: 'gated', effective: false, reason: 'not_enabled', anchor: { bound: false, matchesCurrent: null } }
    expect(result).toEqual({
      kind: 'ok', changed: true,
      view: {
        integrationId: ID, provider: 'acme', integrationStatus: 'active', revision: 4, updatedAt: '2026-11-20T08:00:00.000Z',
        capabilities: {
          directory: off,
          login: off,
          // Both scope reads of this capability threw: its evaluation and the comparison with its anchor.
          notification: { enabled: true, governance: 'gated', effective: false, reason: 'scope_changed', anchor: { bound: true, matchesCurrent: false } },
        },
      },
    })

    expect(h.committed.state).toEqual(
      stateRow(['notification'], { revision: '4', updated_by: ACTOR, updated_at: new Date('2026-11-20T08:00:00Z') }),
    )
    expect(h.history).toEqual([{
      integrationId: ID, provider: 'acme', revision: 4, actor: ACTOR, changed: ['login'], rebound: [],
      directory: false, login: false, notification: true,
    }])
    expect(h.audits).toEqual([{
      actorId: ACTOR, actorType: 'user', action: CAPABILITIES_AUDIT_UPDATE_ACTION,
      resourceType: CAPABILITIES_AUDIT_RESOURCE_TYPE, resourceId: ID,
      meta: {
        provider: 'acme', actorId: ACTOR, fromRevision: 3, toRevision: 4, changed: ['login'], anchorRebound: [],
        directoryEnabled: false, loginEnabled: false, notificationEnabled: true,
      },
    }])

    // One transaction that commits, then the audit record; the scope is read only between the history
    // row and the commit, and no precondition runs.
    expect(h.events.filter((event) => event !== 'scopeOf')).toEqual([
      'begin', ...HEAD, 'integration_for_share', 'state_for_update', 'update_state', 'insert_history', 'commit', 'audit',
    ])
    const scopeReads = h.events.flatMap((event, index) => (event === 'scopeOf' ? [index] : []))
    expect(scopeReads.length).toBeGreaterThan(0)
    expect(Math.min(...scopeReads)).toBeGreaterThan(h.events.indexOf('insert_history'))
    expect(Math.max(...scopeReads)).toBeLessThan(h.events.indexOf('commit'))
    expectNoValues([result, h.audits, h.history])

    // Nothing to change under the same provider: the answer is built the same way and nothing is written.
    const unchanged = harness({ scope: 'throw', state: stateRow(['notification']) })
    expect(await unchanged.patch(body(3, { login: false }))).toMatchObject({
      kind: 'ok', changed: false,
      view: { revision: 3, capabilities: {
        login: { enabled: false, anchor: { bound: false, matchesCurrent: null } },
        notification: { enabled: true, effective: false, reason: 'scope_changed', anchor: { bound: true, matchesCurrent: false } },
      } },
    })
    expect(unchanged.kinds()).toEqual([...HEAD, 'integration_for_share', 'state_for_update'])
    expect(unchanged.history).toEqual([])
    expect(unchanged.audits).toEqual([])
  })

  it('assigns only the columns of the named capability', async () => {
    const h = harness({ state: stateRow(['directory', 'login', 'notification']) })
    await h.patch(body(3, { login: false }))
    const update = h.statements.find((statement) => statement.kind === 'update_state')!
    expect(setClauseOf(update.sql)).toBe(
      'login_enabled = false, login_bound_tenant = NULL, login_bound_app_scope = NULL, revision = revision + 1, updated_by = $2, updated_at = now()',
    )
    expect(setClauseOf(update.sql)).not.toMatch(/directory_(enabled|bound)|notification_(enabled|bound)/)
    expect(update.params).toEqual([ID, ACTOR])
  })

  it('changes nothing when the capability is already off: no write, no history, no audit, same revision', async () => {
    const h = harness({ state: stateRow(['notification']) })
    const result = await h.patch(body(3, { login: false, directory: false }))
    expect(result).toMatchObject({ kind: 'ok', changed: false, view: { revision: 3 } })
    expect(h.kinds()).toEqual([...HEAD, 'integration_for_share', 'state_for_update'])
    expect(h.history).toEqual([])
    expect(h.audits).toEqual([])
  })

  it('creates no row for an integration without one', async () => {
    for (const governance of [ALL_GATED, null]) {
      const h = harness({ governance })
      const result = await h.patch(body(0, { directory: false, login: false, notification: false }))
      expect(result).toMatchObject({ kind: 'ok', changed: false, view: { revision: 0, updatedAt: null } })
      expect(h.kinds()).toEqual([...HEAD, 'integration_for_share', 'state_for_update'])
      expect(h.committed.state).toBeNull()
      expect(h.audits).toEqual([])
    }
  })
})

describe('turning a capability on: refusals, in order', () => {
  async function refusalOf(script: Script, capabilities: Partial<Record<IntegrationCapability, boolean>> = { login: true }) {
    const h = harness(script)
    const result = await h.patch(body(script.state ? 3 : 0, capabilities))
    expect(h.kinds().some((kind) => WRITES.includes(kind))).toBe(false)
    expect(h.history).toEqual([])
    expect(h.committed.state).toBe(script.state ?? null)
    return { h, result }
  }

  it('gives each failed check its own code and names the capability', async () => {
    const cases: Array<[Script, string]> = [
      [{ governance: null }, 'CAPABILITY_PROVIDER_NOT_REGISTERED'],
      [{ governance: { ...ALL_GATED, login: 'legacy' } }, 'CAPABILITY_GOVERNED_BY_LEGACY_PATH'],
      [{ governance: { ...ALL_GATED, login: 'unsupported' } }, 'CAPABILITY_UNSUPPORTED'],
      [{ implemented: false }, 'CAPABILITY_IMPLEMENTATION_MISSING'],
      [{ integration: integrationRow({ status: 'inactive' }) }, 'CAPABILITY_INTEGRATION_INACTIVE'],
      [{ integration: integrationRow({ status: 'disabled' }) }, 'CAPABILITY_INTEGRATION_INACTIVE'],
      [{ scope: 'null' }, 'CAPABILITY_SCOPE_INCOMPLETE'],
      [{ integration: integrationRow({ config: { app: 'two words' } }) }, 'CAPABILITY_SCOPE_INCOMPLETE'],
      [{ integration: integrationRow({ config: { app: 'a'.repeat(257) } }) }, 'CAPABILITY_SCOPE_INCOMPLETE'],
      [{ integration: integrationRow({ corp_id: '' }) }, 'CAPABILITY_SCOPE_INCOMPLETE'],
    ]
    for (const [script, code] of cases) {
      const { h, result } = await refusalOf(script)
      expect(result, code).toEqual({ kind: 'refused', code, capability: 'login' })
      expect(h.audits).toEqual([{
        actorId: ACTOR, actorType: 'user', action: CAPABILITIES_AUDIT_REFUSED_ACTION,
        resourceType: CAPABILITIES_AUDIT_RESOURCE_TYPE, resourceId: ID,
        meta: { provider: 'acme', actorId: ACTOR, code, capability: 'login' },
      }])
      expect(h.events.at(-1)).toBe('audit')
      expect(h.events.indexOf('commit')).toBeLessThan(h.events.indexOf('audit'))
      expectNoValues([result, h.audits])
    }
  })

  it('reports the earlier check when two fail together', async () => {
    const inactive = integrationRow({ status: 'inactive' })
    const pairs: Array<[Script, string]> = [
      [{ governance: null, integration: inactive, implemented: false }, 'CAPABILITY_PROVIDER_NOT_REGISTERED'],
      [{ governance: { ...ALL_GATED, login: 'legacy' }, implemented: false, integration: inactive }, 'CAPABILITY_GOVERNED_BY_LEGACY_PATH'],
      [{ governance: { ...ALL_GATED, login: 'unsupported' }, implemented: false }, 'CAPABILITY_UNSUPPORTED'],
      [{ implemented: false, integration: inactive, scope: 'null' }, 'CAPABILITY_IMPLEMENTATION_MISSING'],
      [{ integration: inactive, scope: 'null' }, 'CAPABILITY_INTEGRATION_INACTIVE'],
      [{ scope: 'null', precondition: () => ({ ok: false, code: 'EVIDENCE_MISSING' }) }, 'CAPABILITY_SCOPE_INCOMPLETE'],
    ]
    for (const [script, code] of pairs) {
      const { h, result } = await refusalOf(script)
      expect(result).toMatchObject({ kind: 'refused', code, capability: 'login' })
      expect(h.events.filter((event) => event.startsWith('precondition'))).toEqual([])
    }
  })

  it('does not read the scope before the provider, governance, implementation and status checks have passed', async () => {
    for (const script of [{ governance: { ...ALL_GATED, login: 'legacy' as const } }, { implemented: false }, { integration: integrationRow({ status: 'inactive' }) }]) {
      const { h } = await refusalOf(script)
      expect(h.events).not.toContain('scopeOf')
    }
  })

  it('lists exactly the refusal codes the write can answer with', () => {
    expect([...CAPABILITY_REFUSAL_CODES]).toEqual([
      'CAPABILITY_PROVIDER_NOT_REGISTERED',
      'CAPABILITY_GOVERNED_BY_LEGACY_PATH',
      'CAPABILITY_UNSUPPORTED',
      'CAPABILITY_IMPLEMENTATION_MISSING',
      'CAPABILITY_INTEGRATION_INACTIVE',
      'CAPABILITY_SCOPE_INCOMPLETE',
      'CAPABILITY_PRECONDITION_FAILED',
      'CAPABILITY_LOGIN_SCOPE_TAKEN',
    ])
  })

  it('refuses every capability of the production registry and of an unregistered provider', async () => {
    for (const [provider, code] of [['dingtalk', 'CAPABILITY_GOVERNED_BY_LEGACY_PATH'], ['local', 'CAPABILITY_PROVIDER_NOT_REGISTERED'], ['wecom', 'CAPABILITY_PROVIDER_NOT_REGISTERED']] as const) {
      for (const capability of CAPABILITIES) {
        const h = harness({ integration: integrationRow({ provider, config: { appKey: APP } }) })
        const service = createDirectoryIntegrationCapabilitiesWriteService({
          isEnabled: () => true,
          resolveDescriptor: resolveProviderCapabilityDescriptor,
          isImplementationAvailable: isCapabilityImplementationAvailable,
          readLoginRuntime: () => ({ available: false, requireGrant: false, autoLinkEmail: false, autoProvision: false }),
          isIntegrationScopedCredentialsEnabled: () => false,
          transaction: (work) => work(h.client),
          capabilityGates: PRODUCTION_CAPABILITY_ENABLE_GATES,
          audit: async () => undefined,
        })
        expect(await service.patch(ID, body(0, { [capability]: true }), ACTOR)).toEqual({ kind: 'refused', code, capability })
        expect(h.kinds().some((kind) => WRITES.includes(kind))).toBe(false)
        const off = await service.patch(ID, body(0, { [capability]: false }), ACTOR)
        expect(off).toMatchObject({ kind: 'ok', changed: false, view: { revision: 0 } })
        expect(h.kinds().some((kind) => WRITES.includes(kind))).toBe(false)
      }
    }
  })
})

describe('turning a capability on: the write', () => {
  it('creates the row at revision one with the anchor of the locked integration row, and records the administrator', async () => {
    const h = harness()
    const result = await h.patch(body(0, { login: true }))
    expect(result).toMatchObject({
      kind: 'ok', changed: true,
      view: {
        integrationId: ID, provider: 'acme', integrationStatus: 'active', revision: 1,
        capabilities: {
          login: { enabled: true, governance: 'gated', effective: true, reason: null, anchor: { bound: true, matchesCurrent: true } },
          directory: { enabled: false, effective: false, reason: 'not_enabled', anchor: { bound: false, matchesCurrent: null } },
          notification: { enabled: false, anchor: { bound: false, matchesCurrent: null } },
        },
      },
    })
    expect(h.committed.state).toMatchObject({
      integration_id: ID, bound_provider: 'acme', bound_org_id: ORG, revision: '1', created_by: ACTOR, updated_by: ACTOR,
      directory_enabled: false, directory_bound_tenant: null, directory_bound_app_scope: null,
      login_enabled: true, login_bound_tenant: CORP, login_bound_app_scope: APP,
      notification_enabled: false, notification_bound_tenant: null, notification_bound_app_scope: null,
    })
    expect(h.history).toEqual([{
      integrationId: ID, provider: 'acme', revision: 1, actor: ACTOR, changed: ['login'], rebound: [],
      directory: false, login: true, notification: false,
    }])
    expect(h.audits).toEqual([{
      actorId: ACTOR, actorType: 'user', action: CAPABILITIES_AUDIT_UPDATE_ACTION,
      resourceType: CAPABILITIES_AUDIT_RESOURCE_TYPE, resourceId: ID,
      meta: {
        provider: 'acme', actorId: ACTOR, fromRevision: 0, toRevision: 1, changed: ['login'], anchorRebound: [],
        directoryEnabled: false, loginEnabled: true, notificationEnabled: false,
      },
    }])
    expectNoValues([result, h.audits, h.history])
    const historyStatement = h.statements.find((statement) => statement.kind === 'insert_history')!
    expectNoValues(historyStatement.params)
  })

  it('takes the organization and the provider of the row from the locked integration row', async () => {
    const h = harness({ integration: integrationRow({ org_id: 'org-of-the-row' }) })
    await h.patch(body(0, { notification: true }))
    expect(h.committed.state).toMatchObject({ bound_org_id: 'org-of-the-row', bound_provider: 'acme' })
  })

  it('leaves the state and the anchor of a capability that is not named exactly as they were', async () => {
    // Login is on with an older anchor: turning notification on must not re-anchor login.
    const state = stateRow(['login'], { login_bound_app_scope: OTHER_APP })
    const h = harness({ state })
    const result = await h.patch(body(3, { notification: true }))
    expect(result).toMatchObject({
      kind: 'ok', changed: true,
      view: { revision: 4, capabilities: {
        login: { enabled: true, effective: false, reason: 'scope_changed', anchor: { bound: true, matchesCurrent: false } },
        notification: { enabled: true, effective: true, anchor: { bound: true, matchesCurrent: true } },
      } },
    })
    expect(h.committed.state).toMatchObject({
      login_enabled: true, login_bound_tenant: CORP, login_bound_app_scope: OTHER_APP,
      notification_enabled: true, notification_bound_tenant: CORP, notification_bound_app_scope: APP,
    })
    const update = h.statements.find((statement) => statement.kind === 'update_state')!
    expect(setClauseOf(update.sql)).toBe(
      'notification_enabled = true, notification_bound_tenant = $2, notification_bound_app_scope = $3, revision = revision + 1, updated_by = $4, updated_at = now()',
    )
    expect(setClauseOf(update.sql)).not.toMatch(/login_(enabled|bound)|directory_(enabled|bound)/)
    expect(update.params).toEqual([ID, CORP, APP, ACTOR])
    expect(h.history[0]).toMatchObject({ changed: ['notification'], rebound: [] })
    expect(h.events.filter((event) => event.startsWith('precondition'))).toEqual(['precondition:notification'])
  })

  it('changes nothing, and runs no precondition, when the capability is already on with the current anchor', async () => {
    const h = harness({ state: stateRow(['login']), gates: { login: [failing('GATE_SAYS_NO')] }, precondition: () => ({ ok: false, code: 'EVIDENCE_MISSING' }) })
    const result = await h.patch(body(3, { login: true }))
    expect(result).toMatchObject({ kind: 'ok', changed: false, view: { revision: 3 } })
    expect(h.kinds()).toEqual([...HEAD, 'integration_for_share', 'state_for_update'])
    expect(h.events.filter((event) => event.startsWith('precondition'))).toEqual([])
    expect(h.history).toEqual([])
    expect(h.audits).toEqual([])
  })

  it('re-anchors a capability that is on with another anchor: a change, recorded as a re-anchoring, after its preconditions', async () => {
    const h = harness({ state: stateRow(['login', 'notification'], { login_bound_app_scope: OTHER_APP }) })
    const result = await h.patch(body(3, { login: true }))
    expect(result).toMatchObject({ kind: 'ok', changed: true, view: { revision: 4, capabilities: { login: { anchor: { bound: true, matchesCurrent: true } } } } })
    expect(h.committed.state).toMatchObject({ login_enabled: true, login_bound_tenant: CORP, login_bound_app_scope: APP, revision: '4' })
    expect(h.history).toEqual([{
      integrationId: ID, provider: 'acme', revision: 4, actor: ACTOR, changed: ['login'], rebound: ['login'],
      directory: false, login: true, notification: true,
    }])
    expect(h.audits[0].meta).toMatchObject({ fromRevision: 3, toRevision: 4, changed: ['login'], anchorRebound: ['login'] })
    expect(h.events.filter((event) => event.startsWith('precondition'))).toEqual(['precondition:login'])

    // The same request again finds the anchor current.
    const again = harness({ state: h.committed.state })
    expect(await again.patch(body(4, { login: true }))).toMatchObject({ kind: 'ok', changed: false })
  })

  it('applies several capabilities in one request, in the fixed order, as one revision', async () => {
    const h = harness({ state: stateRow(['directory'], { notification_enabled: true, notification_bound_tenant: CORP, notification_bound_app_scope: OTHER_APP }) })
    const result = await h.patch({ expectedRevision: 3, capabilities: { notification: true, login: true, directory: false } })
    expect(result).toMatchObject({ kind: 'ok', changed: true, view: { revision: 4 } })
    expect(h.committed.state).toMatchObject({
      directory_enabled: false, directory_bound_tenant: null, directory_bound_app_scope: null,
      login_enabled: true, login_bound_app_scope: APP,
      notification_enabled: true, notification_bound_app_scope: APP,
      revision: '4',
    })
    expect(h.history).toEqual([{
      integrationId: ID, provider: 'acme', revision: 4, actor: ACTOR,
      changed: ['directory', 'login', 'notification'], rebound: ['notification'],
      directory: false, login: true, notification: true,
    }])
    expect(h.kinds().filter((kind) => kind === 'update_state')).toHaveLength(1)
    expect(h.events.filter((event) => event.startsWith('precondition'))).toEqual(['precondition:login', 'precondition:notification'])
  })

  it('writes nothing when one of several capabilities is refused, and names the first that failed', async () => {
    const mixed = harness({ governance: { directory: 'gated', login: 'legacy', notification: 'gated' }, state: stateRow(['notification']) })
    expect(await mixed.patch(body(3, { directory: true, login: true, notification: false }))).toEqual({
      kind: 'refused', code: 'CAPABILITY_GOVERNED_BY_LEGACY_PATH', capability: 'login',
    })
    expect(mixed.kinds().some((kind) => WRITES.includes(kind))).toBe(false)
    expect(mixed.committed.state).toMatchObject({ directory_enabled: false, notification_enabled: true, revision: '3' })

    // Directory fails its precondition and login fails governance: directory comes first.
    const ordered = harness({
      governance: { directory: 'gated', login: 'legacy', notification: 'gated' },
      precondition: (capability) => (capability === 'directory' ? { ok: false, code: 'DIRECTORY_EVIDENCE_MISSING' } : { ok: true }),
    })
    expect(await ordered.patch(body(0, { login: true, directory: true }))).toEqual({
      kind: 'refused', code: 'CAPABILITY_PRECONDITION_FAILED', capability: 'directory', reason: 'DIRECTORY_EVIDENCE_MISSING',
    })
    expect(ordered.audits[0].meta).toEqual({ provider: 'acme', actorId: ACTOR, code: 'CAPABILITY_PRECONDITION_FAILED', capability: 'directory' })
  })
})

describe('enable preconditions and enable gates', () => {
  it('run with both locks held and before any write: preconditions first, then that capability’s gates in order', async () => {
    const order: string[] = []
    const gate = (name: string): CapabilityEnableGate => async () => {
      order.push(name)
      return { ok: true }
    }
    const h = harness({
      gates: { login: [gate('login-1'), gate('login-2')], notification: [gate('notification-1')], directory: [gate('directory-1')] },
      precondition: (capability) => {
        order.push(`precondition-${capability}`)
        return { ok: true }
      },
    })
    const result = await h.patch(body(0, { notification: true, login: true }))
    expect(result.kind).toBe('ok')
    expect(order).toEqual(['precondition-login', 'login-1', 'login-2', 'precondition-notification', 'notification-1'])
    const firstPrecondition = h.events.indexOf('precondition:login')
    expect(firstPrecondition).toBeGreaterThan(h.events.indexOf('state_for_update'))
    expect(h.events.indexOf('state_for_update')).toBeGreaterThan(h.events.indexOf('integration_for_share'))
    expect(h.events.indexOf('precondition:notification')).toBeLessThan(h.events.indexOf('insert_state'))
  })

  it('run a gate after both locks and before the write, as the statements the gate itself sees show', async () => {
    const seen: Kind[][] = []
    const h = harness({
      gates: { login: [async () => {
        seen.push(h.kinds())
        return { ok: true }
      }] },
    })
    await h.patch(body(0, { login: true }))
    expect(seen).toEqual([[...HEAD, 'integration_for_share', 'state_for_update']])
    expect(h.kinds().slice(seen[0].length)).toEqual(['insert_state', 'insert_history'])
  })

  it('give the precondition and the gate the write’s own client, the organization of the locked row and the scope', async () => {
    const gateCalls: Array<{ client: CapabilityTransactionClient; context: EnablePreconditionContext }> = []
    const h = harness({
      integration: integrationRow({ org_id: 'org-of-the-row' }),
      gates: { login: [async (client, context) => {
        gateCalls.push({ client, context })
        return { ok: true }
      }] },
    })
    await h.patch(body(0, { login: true }))
    expect(h.contexts).toHaveLength(1)
    const context = h.contexts[0]
    expect(context.integrationId).toBe(ID)
    expect(context.provider).toBe('acme')
    expect(context.orgId).toBe('org-of-the-row')
    expect(context.scope).toEqual({ tenant: CORP, appScope: APP })
    expect(context.client).toBe(h.client)
    expect(Object.isFrozen(context)).toBe(true)
    expect(Object.keys(context).sort()).toEqual(['client', 'integrationId', 'orgId', 'provider', 'scope'])
    expect(gateCalls).toHaveLength(1)
    expect(gateCalls[0].client).toBe(h.client)
    expect(gateCalls[0].context).toBe(context)
  })

  it('let a precondition read through the transaction client before the write', async () => {
    const h = harness({
      precondition: async (_capability, context) => {
        const probe = await context.client.query(`SELECT to_regclass('directory_integrations') IS NOT NULL AS capabilities, true AS history`)
        return probe.rows.length === 1 ? { ok: true } : { ok: false, code: 'EVIDENCE_MISSING' }
      },
    })
    expect((await h.patch(body(0, { login: true }))).kind).toBe('ok')
    expect(h.kinds()).toEqual([...HEAD, 'integration_for_share', 'state_for_update', 'probe', 'insert_state', 'insert_history'])
  })

  it('refuse with the precondition’s code, write nothing, and do not ask the gates', async () => {
    const gate = vi.fn(failing('GATE_SAYS_NO'))
    const h = harness({ precondition: () => ({ ok: false, code: 'EVIDENCE_MISSING' }), gates: { login: [gate] } })
    expect(await h.patch(body(0, { login: true }))).toEqual({
      kind: 'refused', code: 'CAPABILITY_PRECONDITION_FAILED', capability: 'login', reason: 'EVIDENCE_MISSING',
    })
    expect(gate).not.toHaveBeenCalled()
    expect(h.kinds()).toEqual([...HEAD, 'integration_for_share', 'state_for_update'])
    expect(h.committed.state).toBeNull()
    expect(h.history).toEqual([])
    expect(h.audits.map((event) => [event.action, event.meta])).toEqual([[CAPABILITIES_AUDIT_REFUSED_ACTION, {
      provider: 'acme', actorId: ACTOR, code: 'CAPABILITY_PRECONDITION_FAILED', capability: 'login',
    }]])
  })

  it('refuse with the gate’s code when the precondition passes and a gate does not, stopping at the first failing gate', async () => {
    const later = vi.fn(failing('LATER_GATE'))
    const h = harness({ gates: { login: [async () => ({ ok: true }), failing('ROUTING_POLICY_REQUIRED'), later] } })
    expect(await h.patch(body(0, { login: true }))).toEqual({
      kind: 'refused', code: 'CAPABILITY_PRECONDITION_FAILED', capability: 'login', reason: 'ROUTING_POLICY_REQUIRED',
    })
    expect(later).not.toHaveBeenCalled()
    expect(h.kinds().some((kind) => WRITES.includes(kind))).toBe(false)
    expect(h.history).toEqual([])
    expect(h.committed.state).toBeNull()
  })

  it('apply a gate to its own capability only, whatever the provider', async () => {
    const gate = vi.fn(failing('DIRECTORY_GATE'))
    const h = harness({ gates: { directory: [gate] } })
    expect((await h.patch(body(0, { login: true, notification: true }))).kind).toBe('ok')
    expect(gate).not.toHaveBeenCalled()
    const refused = harness({ gates: { directory: [gate] } })
    expect(await refused.patch(body(0, { directory: true }))).toMatchObject({ kind: 'refused', capability: 'directory', reason: 'DIRECTORY_GATE' })
    expect(gate).toHaveBeenCalledTimes(1)
  })

  it('treat anything but an exact pass as a refusal, and replace a code that is not a fixed token', async () => {
    const answers: Array<[unknown, string]> = [
      [undefined, PRECONDITION_CODE_MALFORMED],
      [null, PRECONDITION_CODE_MALFORMED],
      [{ ok: 'true' }, PRECONDITION_CODE_MALFORMED],
      [{ ok: 1 }, PRECONDITION_CODE_MALFORMED],
      [{ ok: false }, PRECONDITION_CODE_MALFORMED],
      [{ ok: false, code: `corp ${CORP} is not verified` }, PRECONDITION_CODE_MALFORMED],
      [{ ok: false, code: '' }, PRECONDITION_CODE_MALFORMED],
      [{ ok: false, code: 'EVIDENCE_MISSING' }, 'EVIDENCE_MISSING'],
    ]
    for (const [answer, reason] of answers) {
      const viaPrecondition = harness({ precondition: () => answer })
      const first = await viaPrecondition.patch(body(0, { login: true }))
      expect(first).toEqual({ kind: 'refused', code: 'CAPABILITY_PRECONDITION_FAILED', capability: 'login', reason })
      expectNoValues(first)
      const viaGate = harness({ gates: { login: [(async () => answer) as unknown as CapabilityEnableGate] } })
      expect(await viaGate.patch(body(0, { login: true }))).toEqual({ kind: 'refused', code: 'CAPABILITY_PRECONDITION_FAILED', capability: 'login', reason })
      expect(viaGate.kinds().some((kind) => WRITES.includes(kind))).toBe(false)
    }
  })

  it('refuse a gated capability whose provider declares no preconditions', async () => {
    const h = harness({ withoutPreconditions: true })
    expect(await h.patch(body(0, { login: true }))).toEqual({
      kind: 'refused', code: 'CAPABILITY_PRECONDITION_FAILED', capability: 'login', reason: PRECONDITIONS_MISSING_CODE,
    })
    expect(h.committed.state).toBeNull()
  })

  it('have an empty, frozen production gate table', () => {
    expect(Object.isFrozen(PRODUCTION_CAPABILITY_ENABLE_GATES)).toBe(true)
    expect(Reflect.ownKeys(PRODUCTION_CAPABILITY_ENABLE_GATES)).toEqual([])
    for (const capability of CAPABILITIES) expect(PRODUCTION_CAPABILITY_ENABLE_GATES[capability]).toBeUndefined()
  })
})

describe('typed error mapping', () => {
  const BUSY = ['55P03', '40P01', '40001', '57014']
  const STAGES: Kind[] = ['lock_timeout', 'probe', 'integration_for_share', 'state_for_update', 'insert_state', 'insert_history']

  it('answers busy for a lost lock race or an exhausted time bound at any statement, with the transaction rolled back and no audit', async () => {
    for (const code of BUSY) {
      for (const stage of STAGES) {
        const h = harness({ failOn: (kind) => (kind === stage ? pgError(code) : null) })
        const result = await h.patch(body(0, { login: true }))
        expect(result, `${code} at ${stage}`).toEqual({ kind: 'busy' })
        expect(h.events).toContain('rollback')
        expect(h.events).not.toContain('commit')
        expect(h.committed.state).toBeNull()
        expect(h.history).toEqual([])
        expect(h.audits).toEqual([])
      }
      const update = harness({ state: stateRow(['login']), failOn: (kind) => (kind === 'update_state' ? pgError(code) : null) })
      expect(await update.patch(body(3, { login: false }))).toEqual({ kind: 'busy' })
      expect(update.committed.state).toMatchObject({ login_enabled: true, revision: '3' })
      const invalid = harness({ failOn: (kind) => (kind === 'integration_exists' ? pgError(code) : null) })
      expect(await invalid.patch(null)).toEqual({ kind: 'busy' })
    }
  })

  it('answers busy when a precondition or a gate meets one of those errors', async () => {
    const viaPrecondition = harness({ precondition: () => { throw pgError('55P03') } })
    expect(await viaPrecondition.patch(body(0, { login: true }))).toEqual({ kind: 'busy' })
    const viaGate = harness({ gates: { login: [async () => { throw pgError('40001') }] } })
    expect(await viaGate.patch(body(0, { login: true }))).toEqual({ kind: 'busy' })
    expect(viaGate.audits).toEqual([])
  })

  it('maps the login scope index to its refusal on the insert and on the update, and records the refusal', async () => {
    const taken = pgError('23505', { constraint: 'dic_login_scope_uniq' })
    const inserted = harness({ failOn: (kind) => (kind === 'insert_state' ? taken : null) })
    expect(await inserted.patch(body(0, { login: true }))).toEqual({ kind: 'refused', code: 'CAPABILITY_LOGIN_SCOPE_TAKEN', capability: 'login' })
    expect(inserted.events).toContain('rollback')
    expect(inserted.audits).toEqual([{
      actorId: ACTOR, actorType: 'user', action: CAPABILITIES_AUDIT_REFUSED_ACTION,
      resourceType: CAPABILITIES_AUDIT_RESOURCE_TYPE, resourceId: ID,
      meta: { provider: 'acme', actorId: ACTOR, code: 'CAPABILITY_LOGIN_SCOPE_TAKEN', capability: 'login' },
    }])
    expect(inserted.history).toEqual([])

    const updated = harness({ state: stateRow(['notification']), failOn: (kind) => (kind === 'update_state' ? taken : null) })
    expect(await updated.patch(body(3, { login: true }))).toEqual({ kind: 'refused', code: 'CAPABILITY_LOGIN_SCOPE_TAKEN', capability: 'login' })
    expect(updated.committed.state).toMatchObject({ login_enabled: false, revision: '3' })
  })

  it('maps an anchor check of the row write to the scope refusal of that capability', async () => {
    for (const capability of CAPABILITIES) {
      const h = harness({ failOn: (kind) => (kind === 'insert_state' ? pgError('23514', { constraint: `dic_${capability}_anchor_chk` }) : null) })
      expect(await h.patch(body(0, { [capability]: true }))).toEqual({ kind: 'refused', code: 'CAPABILITY_SCOPE_INCOMPLETE', capability })
      expect(h.audits[0].meta).toEqual({ provider: 'acme', actorId: ACTOR, code: 'CAPABILITY_SCOPE_INCOMPLETE', capability })
    }
  })

  it('lets every other error through for the route’s fixed sentence, with the transaction rolled back and no audit', async () => {
    const others: Array<[Kind, unknown]> = [
      ['insert_state', pgError('23514', { constraint: 'dic_row_shape_chk' })],
      ['insert_state', pgError('23514', { constraint: 'dic_revision_chk' })],
      ['insert_state', pgError('23514')],
      ['insert_state', pgError('23505', { constraint: 'dic_pkey' })],
      ['insert_state', pgError('23505')],
      ['insert_state', pgError('23503', { constraint: 'dic_integration_org_fk' })],
      ['insert_state', pgError('55000')],
      ['insert_state', new Error('plain failure')],
      ['insert_history', pgError('55000')],
      ['insert_history', pgError('23514', { constraint: 'dich_changed_chk' })],
      // The two constraint mappings belong to the capability row write only.
      ['insert_history', pgError('23505', { constraint: 'dic_login_scope_uniq' })],
      ['insert_history', pgError('23514', { constraint: 'dic_login_anchor_chk' })],
      ['state_for_update', pgError('23505', { constraint: 'dic_login_scope_uniq' })],
      ['integration_for_share', pgError('42P01')],
      ['probe', pgError('08006')],
      ['isolation', pgError('25001')],
    ]
    for (const [stage, failure] of others) {
      const h = harness({ failOn: (kind) => (kind === stage ? failure : null) })
      await expect(h.patch(body(0, { login: true })), `${stage}`).rejects.toBe(failure)
      expect(h.events).toContain('rollback')
      expect(h.committed.state).toBeNull()
      expect(h.history).toEqual([])
      expect(h.audits).toEqual([])
    }
    const update = harness({ state: stateRow(['login']), failOn: (kind) => (kind === 'update_state' ? pgError('55000') : null) })
    await expect(update.patch(body(3, { login: false }))).rejects.toMatchObject({ code: '55000' })
    expect(update.committed.state).toMatchObject({ login_enabled: true, revision: '3' })
    expect(update.history).toEqual([])
  })

  it('rolls the row write back when the history row cannot be written', async () => {
    const h = harness({ state: stateRow(['login']), failOn: (kind) => (kind === 'insert_history' ? new Error('history refused') : null) })
    await expect(h.patch(body(3, { login: false }))).rejects.toThrow('history refused')
    expect(h.kinds()).toEqual([...HEAD, 'integration_for_share', 'state_for_update', 'update_state', 'insert_history'])
    expect(h.committed.state).toMatchObject({ login_enabled: true, login_bound_app_scope: APP, revision: '3' })
    expect(h.audits).toEqual([])
  })

  it('fails when the written row does not carry the next revision', async () => {
    const h = harness({ state: stateRow(['login']) })
    const original = h.client.query.bind(h.client)
    h.client.query = async (sql: string, params?: unknown[]) => {
      const answer = await original(sql, params)
      return kindOf(sql) === 'update_state' ? { rows: [{ ...answer.rows[0], revision: '9' }], rowCount: 1 } : answer
    }
    await expect(h.patch(body(3, { login: false }))).rejects.toThrow('capability write cannot continue')
    expect(h.history).toEqual([])
    expect(h.audits).toEqual([])
  })
})

describe('the audit record', () => {
  it('is written after the commit and its failure does not change the answer', async () => {
    const h = harness({ audit: async () => { throw new Error('audit store unavailable') } })
    const result = await h.patch(body(0, { login: true }))
    expect(result).toMatchObject({ kind: 'ok', changed: true, view: { revision: 1 } })
    expect(h.events.slice(-2)).toEqual(['commit', 'audit'])
    expect(h.committed.state).toMatchObject({ login_enabled: true })
    expect(h.history).toHaveLength(1)
  })

  it('is not written for an unchanged request, a stale request, an invalid body, a missing integration or a busy answer', async () => {
    const quiet: Array<[Script, unknown]> = [
      [{ state: stateRow(['login']) }, body(3, { login: true })],
      [{ state: stateRow(['login']) }, body(2, { login: false })],
      [{}, { capabilities: { login: true } }],
      [{ integration: null }, body(0, { login: true })],
      [{ failOn: (kind) => (kind === 'state_for_update' ? pgError('55P03') : null) }, body(0, { login: true })],
    ]
    for (const [script, request] of quiet) {
      const h = harness(script)
      await h.patch(request)
      expect(h.audits).toEqual([])
      expect(h.events).not.toContain('audit')
    }
  })

  it('carries codes, booleans, revisions, capability names and ids only', async () => {
    const h = harness({ state: stateRow(['login', 'directory'], { login_bound_app_scope: OTHER_APP }) })
    await h.patch(body(3, { login: true, directory: false, notification: true }))
    expect(h.audits).toHaveLength(1)
    expect(Object.keys(h.audits[0].meta).sort()).toEqual([
      'actorId', 'anchorRebound', 'changed', 'directoryEnabled', 'fromRevision', 'loginEnabled', 'notificationEnabled', 'provider', 'toRevision',
    ])
    expect(h.audits[0].meta).toEqual({
      provider: 'acme', actorId: ACTOR, fromRevision: 3, toRevision: 4,
      changed: ['directory', 'login', 'notification'], anchorRebound: ['login'],
      directoryEnabled: false, loginEnabled: true, notificationEnabled: true,
    })
    expectNoValues(h.audits)
    expectNoValues(h.history)
  })
})
