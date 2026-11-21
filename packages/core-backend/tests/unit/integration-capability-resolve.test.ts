/**
 * The consumer resolver against a scripted executor: input checks before any statement, the switch, the
 * transaction / isolation / lock-wait contract, the fixed statement sequence (six statements, no
 * connection lifecycle table), error folding, every refusal reason, the entry point's fixed shape and
 * the witness.
 *
 * Positive cases use a test-only mock of the provider registry and the implementation table (the
 * production registry governs every dingtalk capability as legacy, so nothing is effective in
 * production). The resolver itself has no override.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { importSpecifiers } from '../helpers/import-edge-allowlist'

const control = vi.hoisted(() => ({
  testRegistry: true,
  governance: { directory: 'gated', login: 'gated', notification: 'gated' } as Record<string, 'gated' | 'legacy' | 'unsupported'>,
  implemented: true,
}))

vi.mock('../../src/integrations/provider-capability-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integrations/provider-capability-registry')>()
  return {
    ...actual,
    resolveProviderCapabilityDescriptor: (provider: string) => {
      if (!control.testRegistry) return actual.resolveProviderCapabilityDescriptor(provider)
      if (provider !== 'dingtalk') return null
      const production = actual.resolveProviderCapabilityDescriptor('dingtalk')
      if (production === null) throw new Error('production dingtalk descriptor missing')
      return {
        provider: 'dingtalk',
        governance: { ...control.governance },
        scopeOf: production.scopeOf,
        enablePreconditions: async () => ({ ok: true as const }),
        secretConfigKeys: production.secretConfigKeys,
      }
    },
  }
})

vi.mock('../../src/integrations/integration-capability-implementations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/integrations/integration-capability-implementations')>()
  return {
    ...actual,
    isCapabilityImplementationAvailable: (provider: string, capability: 'directory' | 'login' | 'notification') =>
      control.testRegistry ? provider === 'dingtalk' && control.implemented : actual.isCapabilityImplementationAvailable(provider, capability),
  }
})

import {
  CAPABILITY_RESOLVE_MAX_LOCK_TIMEOUT_MS,
  computeIntegrationCapabilityWitness,
  resolveEffectiveIntegrationCapability,
  type CapabilityDecision,
} from '../../src/integrations/integration-capability-resolve'

const SWITCH = 'DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED'
const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const ORG = 'org-alpha'
const CAPABILITIES = ['directory', 'login', 'notification'] as const
type Capability = (typeof CAPABILITIES)[number]

type Row = Record<string, unknown>

function integrationRow(overrides: Row = {}): Row {
  return { id: ID, org_id: ORG, provider: 'dingtalk', status: 'active', corp_id: 'CorpOne', config: { appKey: 'AppOne' }, ...overrides }
}

function stateRow(enabled: Capability[] = ['login'], overrides: Row = {}): Row {
  const row: Row = {
    integration_id: ID, bound_provider: 'dingtalk', bound_org_id: ORG, revision: '3',
    created_by: 'admin-1', updated_by: 'admin-1', created_at: new Date(0), updated_at: new Date(0),
  }
  for (const capability of CAPABILITIES) {
    const on = enabled.includes(capability)
    row[`${capability}_enabled`] = on
    row[`${capability}_bound_tenant`] = on ? 'CorpOne' : null
    row[`${capability}_bound_app_scope`] = on ? 'AppOne' : null
  }
  return { ...row, ...overrides }
}

interface Script {
  isolation?: unknown
  lockTimeout?: unknown
  settingsRows?: number
  xids?: [string, string]
  tables?: boolean
  integration?: Row | null
  state?: Row | null
  /** Zero-based index of the statement that throws. */
  failAt?: number
  failWith?: unknown
}

type Kind = 'settings' | 'xid' | 'probe' | 'integration' | 'capability' | 'unknown'

function kindOf(sql: string): Kind {
  if (/current_setting\('transaction_isolation'\)/.test(sql)) return 'settings'
  if (/pg_current_xact_id/.test(sql)) return 'xid'
  if (/to_regclass/.test(sql)) return 'probe'
  if (/FROM directory_integrations\b/.test(sql)) return 'integration'
  if (/FROM directory_integration_capabilities\b/.test(sql)) return 'capability'
  return 'unknown'
}

function scripted(script: Script = {}) {
  const statements: Array<{ sql: string; params?: unknown[]; kind: Kind }> = []
  let xidCalls = 0
  const executor = {
    async query(sql: string, params?: unknown[]) {
      const kind = kindOf(sql)
      statements.push({ sql, params, kind })
      if (script.failAt === statements.length - 1) {
        throw script.failWith ?? Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })
      }
      const ok = (rows: Row[]) => ({ rows, rowCount: rows.length })
      switch (kind) {
        case 'settings': {
          const row = {
            isolation: 'isolation' in script ? script.isolation : 'read committed',
            lock_timeout_ms: 'lockTimeout' in script ? script.lockTimeout : '1000',
          }
          return ok(Array.from({ length: script.settingsRows ?? 1 }, () => row))
        }
        case 'xid': {
          const xids = script.xids ?? ['900', '900']
          return ok([{ xid: xids[xidCalls++ % 2] }])
        }
        case 'probe': {
          const present = script.tables ?? true
          return ok([{ capabilities: present, history: present }])
        }
        case 'integration': {
          const row = 'integration' in script ? script.integration : integrationRow()
          // Emulates the SQL filter: id = $1 AND org_id = $2.
          return ok(row && row.id === params?.[0] && row.org_id === params?.[1] ? [row] : [])
        }
        case 'capability': {
          const row = 'state' in script ? script.state : stateRow()
          return ok(row ? [row] : [])
        }
        default:
          throw new Error(`unexpected statement: ${sql}`)
      }
    },
  }
  return { executor, statements }
}

const resolveWith = (script: Script, input: Partial<{ integrationId: unknown; capability: unknown; expectedOrgId: unknown }> = {}) => {
  const harness = scripted(script)
  const decision = resolveEffectiveIntegrationCapability(harness.executor, {
    integrationId: ID, capability: 'login', expectedOrgId: ORG, ...input,
  } as never)
  return { ...harness, decision }
}

const refused = (reason: string) => ({ effective: false, reason })
const FULL_SEQUENCE: Kind[] = ['settings', 'xid', 'xid', 'probe', 'integration', 'capability']

beforeEach(() => {
  vi.stubEnv(SWITCH, 'true')
  control.testRegistry = true
  control.governance = { directory: 'gated', login: 'gated', notification: 'gated' }
  control.implemented = true
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('an effective capability', () => {
  it('is effective when every condition holds, with the decision fields and a server-side witness', async () => {
    const { decision, statements } = resolveWith({})
    const result = await decision
    expect(result).toEqual({
      effective: true,
      capability: 'login',
      integrationId: ID,
      orgId: ORG,
      provider: 'dingtalk',
      status: 'active',
      revision: 3,
      witness: expect.stringMatching(/^[0-9a-f]{64}$/),
      orgSource: 'authenticated_tenant',
    })
    if (!result.effective) throw new Error('expected effective')
    expect(result.witness).toBe(computeIntegrationCapabilityWitness({
      orgSource: 'authenticated_tenant', integrationId: ID, orgId: ORG, provider: 'dingtalk', status: 'active',
      capability: 'login', revision: 3, anchor: { tenant: 'CorpOne', appScope: 'AppOne' },
    }))
    expect(statements.map((statement) => statement.kind)).toEqual(FULL_SEQUENCE)
  })

  it('is effective for each capability with its own anchor', async () => {
    for (const capability of CAPABILITIES) {
      const result = await resolveWith({ state: stateRow([capability]) }, { capability }).decision
      expect(result.effective, capability).toBe(true)
      for (const other of CAPABILITIES.filter((candidate) => candidate !== capability)) {
        expect(await resolveWith({ state: stateRow([capability]) }, { capability: other }).decision, `${capability} -> ${other}`).toEqual(refused('not_enabled'))
      }
    }
  })

  it('accepts a revision given as a number and the full 0..2^53-1 range', async () => {
    for (const revision of [0, 7, '9007199254740991']) {
      const result = await resolveWith({ state: stateRow(['login'], { revision }) }).decision
      expect(result, String(revision)).toMatchObject({ effective: true, revision: Number(revision) })
    }
  })
})

describe('input checks, before any statement', () => {
  it('refuses a non-canonical integration id or an unknown capability as input_invalid', async () => {
    const ids: unknown[] = ['', 'not-a-uuid', ID.toUpperCase(), ID.replace(/-/g, ''), ` ${ID}`, `${ID} `, `{${ID}}`, 42, null, undefined]
    for (const integrationId of ids) {
      const { decision, statements } = resolveWith({}, { integrationId })
      expect(await decision, String(integrationId)).toEqual(refused('input_invalid'))
      expect(statements).toHaveLength(0)
    }
    for (const capability of ['', 'Login', 'LOGIN', 'sso', 'login ', null, undefined, 1]) {
      const { decision, statements } = resolveWith({}, { capability })
      expect(await decision, String(capability)).toEqual(refused('input_invalid'))
      expect(statements).toHaveLength(0)
    }
  })

  it('refuses a missing input object as input_invalid', async () => {
    for (const input of [null, undefined, 'x', 7]) {
      const harness = scripted()
      expect(await resolveEffectiveIntegrationCapability(harness.executor, input as never)).toEqual(refused('input_invalid'))
      expect(harness.statements).toHaveLength(0)
    }
  })

  it('refuses a blank or missing organization as org_mismatch with zero statements and no fallback to the integration row', async () => {
    for (const expectedOrgId of ['', ' ', '\t', '\n ', undefined, null, 0]) {
      const { decision, statements } = resolveWith({ integration: integrationRow({ org_id: ORG }) }, { expectedOrgId })
      expect(await decision, JSON.stringify(expectedOrgId)).toEqual(refused('org_mismatch'))
      expect(statements).toHaveLength(0)
    }
  })

  it('checks the input before the switch and the organization after the id and capability', async () => {
    vi.stubEnv(SWITCH, '')
    expect(await resolveWith({}, { integrationId: 'bad', expectedOrgId: '' }).decision).toEqual(refused('input_invalid'))
    expect(await resolveWith({}, { capability: 'bad', expectedOrgId: '' }).decision).toEqual(refused('input_invalid'))
    expect(await resolveWith({}, { expectedOrgId: '' }).decision).toEqual(refused('org_mismatch'))
  })
})

describe('the switch', () => {
  it('issues no statement and refuses as switch_off unless the switch is exactly "true"', async () => {
    for (const value of [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', '1', 'yes']) {
      // beforeEach stubbed the switch, so unstubAllEnvs restores the original value after a delete.
      if (value === undefined) delete process.env[SWITCH]
      else vi.stubEnv(SWITCH, value)
      const { decision, statements } = resolveWith({})
      expect(await decision, String(value)).toEqual(refused('switch_off'))
      expect(statements).toHaveLength(0)
    }
  })
})

describe('transaction, isolation and lock wait bound', () => {
  it('pins the bound at five seconds', () => {
    expect(CAPABILITY_RESOLVE_MAX_LOCK_TIMEOUT_MS).toBe(5000)
  })

  it('refuses any isolation other than read committed after the one settings statement', async () => {
    for (const isolation of ['repeatable read', 'serializable', 'read uncommitted', 'READ COMMITTED', '', null]) {
      const { decision, statements } = resolveWith({ isolation })
      expect(await decision, String(isolation)).toEqual(refused('transaction_required'))
      expect(statements.map((statement) => statement.kind)).toEqual(['settings'])
    }
  })

  it('refuses an unbounded, over-long or unreadable lock wait after the one settings statement', async () => {
    const values: unknown[] = ['0', String(CAPABILITY_RESOLVE_MAX_LOCK_TIMEOUT_MS + 1), '60000', '-1', '', '1s', '01000', '1000.5', 'abc', null, undefined, 1000]
    for (const lockTimeout of values) {
      const { decision, statements } = resolveWith({ lockTimeout })
      expect(await decision, String(lockTimeout)).toEqual(refused('transaction_required'))
      expect(statements.map((statement) => statement.kind)).toEqual(['settings'])
    }
  })

  it('accepts a lock wait bound in (0, 5000] milliseconds', async () => {
    for (const lockTimeout of ['1', '1000', String(CAPABILITY_RESOLVE_MAX_LOCK_TIMEOUT_MS)]) {
      expect((await resolveWith({ lockTimeout }).decision).effective, lockTimeout).toBe(true)
    }
  })

  it('reads the isolation and the lock wait bound in one statement', async () => {
    const { decision, statements } = resolveWith({})
    await decision
    expect(statements[0].sql).toMatch(/current_setting\('transaction_isolation'\)/)
    expect(statements[0].sql).toMatch(/pg_settings WHERE name = 'lock_timeout'/)
    expect(statements[0].params ?? []).toEqual([])
  })

  it('refuses when the two transaction probes disagree, and issues nothing after them', async () => {
    const { decision, statements } = resolveWith({ xids: ['900', '901'] })
    expect(await decision).toEqual(refused('transaction_required'))
    expect(statements.map((statement) => statement.kind)).toEqual(['settings', 'xid', 'xid'])
  })

  it('folds a failing settings or transaction probe statement into read_failed, not transaction_required, and stops', async () => {
    for (const code of ['55P03', '40001', '40P01', '57014', '25P02', '42P01', undefined]) {
      for (const failAt of [0, 1, 2]) {
        const failWith = Object.assign(new Error('failure'), { code })
        const { decision, statements } = resolveWith({ failAt, failWith })
        expect(await decision, `${code}@${failAt}`).toEqual(refused('read_failed'))
        expect(statements).toHaveLength(failAt + 1)
      }
    }
    for (const failWith of ['string', null, undefined, { code: '57014' }]) {
      for (const failAt of [0, 1, 2]) {
        expect(await resolveWith({ failAt, failWith }).decision, `${String(failWith)}@${failAt}`).toEqual(refused('read_failed'))
      }
    }
  })

  it('folds a settings statement that throws synchronously into read_failed', async () => {
    const statements: string[] = []
    const executor = {
      query(sql: string): never {
        statements.push(sql)
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
      },
    }
    expect(await resolveEffectiveIntegrationCapability(executor as never, { integrationId: ID, capability: 'login', expectedOrgId: ORG })).toEqual(refused('read_failed'))
    expect(statements).toHaveLength(1)
  })

  it('keeps transaction_required for a requirement that does not hold: an unusable handle, a settings result of the wrong shape, a probe without a transaction id', async () => {
    for (const settingsRows of [0, 2]) {
      const { decision, statements } = resolveWith({ settingsRows })
      expect(await decision, String(settingsRows)).toEqual(refused('transaction_required'))
      expect(statements.map((statement) => statement.kind)).toEqual(['settings'])
    }
    for (const executor of [null, undefined, {}, { query: 'no' }]) {
      expect(await resolveEffectiveIntegrationCapability(executor as never, { integrationId: ID, capability: 'login', expectedOrgId: ORG })).toEqual(refused('transaction_required'))
    }
    for (const xids of [['', ''], ['900', ''], ['', '900']] as Array<[string, string]>) {
      const { decision, statements } = resolveWith({ xids })
      expect(await decision, JSON.stringify(xids)).toEqual(refused('transaction_required'))
      expect(statements.map((statement) => statement.kind)).toEqual(xids[0] === '' ? ['settings', 'xid'] : ['settings', 'xid', 'xid'])
    }
    const rowlessProbe = {
      query: async (sql: string) => {
        if (kindOf(sql) === 'settings') return { rows: [{ isolation: 'read committed', lock_timeout_ms: '1000' }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      },
    }
    expect(await resolveEffectiveIntegrationCapability(rowlessProbe, { integrationId: ID, capability: 'login', expectedOrgId: ORG })).toEqual(refused('transaction_required'))
  })
})

describe('statement sequence', () => {
  it('is exactly six statements in a fixed order: settings, two transaction probes, table probe, integration, capability', async () => {
    const { decision, statements } = resolveWith({})
    await decision
    expect(statements.map((statement) => statement.kind)).toEqual(FULL_SEQUENCE)
  })

  it('locks the integration row by id and organization, then the capability row, both FOR SHARE', async () => {
    const { decision, statements } = resolveWith({})
    await decision
    const [integration, capability] = statements.slice(4)
    expect(integration.sql).toMatch(/FROM directory_integrations WHERE id = \$1::uuid AND org_id = \$2 FOR SHARE\s*$/)
    expect(integration.params).toEqual([ID, ORG])
    expect(capability.sql).toMatch(/FROM directory_integration_capabilities WHERE integration_id = \$1::uuid FOR SHARE\s*$/)
    expect(capability.params).toEqual([ID])
  })

  it('names no connection lifecycle table, takes no FOR UPDATE, and sets no session or transaction parameter', async () => {
    const { decision, statements } = resolveWith({})
    await decision
    for (const { sql } of statements) {
      expect(sql).not.toMatch(/lifecycle/i)
      expect(sql).not.toMatch(/FOR UPDATE|FOR NO KEY UPDATE|LOCK TABLE/i)
      expect(sql).not.toMatch(/^\s*(SET|RESET)\b|set_config|\bSET\s+LOCAL\b|\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|\bSAVEPOINT\b/i)
    }
  })

  it('stops after the table probe when a table is missing', async () => {
    const { decision, statements } = resolveWith({ tables: false })
    expect(await decision).toEqual(refused('schema_unavailable'))
    expect(statements.map((statement) => statement.kind)).toEqual(FULL_SEQUENCE.slice(0, 4))
  })

  it('does not read the capability row when the integration is missing', async () => {
    const { decision, statements } = resolveWith({ integration: null })
    expect(await decision).toEqual(refused('integration_missing'))
    expect(statements.map((statement) => statement.kind)).toEqual(FULL_SEQUENCE.slice(0, 5))
  })
})

describe('error folding', () => {
  it('folds every failure of the probe or the two locked reads into read_failed and stops', async () => {
    for (const code of ['40001', '55P03', '40P01', '57014', '42P01', undefined]) {
      for (const failAt of [3, 4, 5]) {
        const failWith = Object.assign(new Error('failure'), { code })
        const { decision, statements } = resolveWith({ failAt, failWith })
        expect(await decision, `${code}@${failAt}`).toEqual(refused('read_failed'))
        expect(statements).toHaveLength(failAt + 1)
      }
    }
  })

  it('is never effective when any statement throws, whatever it throws', async () => {
    for (const failWith of [new Error('x'), 'string', null, undefined, { code: '40001' }]) {
      for (let failAt = 0; failAt < FULL_SEQUENCE.length; failAt += 1) {
        const decision = await resolveWith({ failAt, failWith }).decision
        expect(decision.effective, `${String(failWith)}@${failAt}`).toBe(false)
      }
    }
  })

  it('never throws on a malformed result', async () => {
    const broken = { query: async () => undefined as never }
    await expect(resolveEffectiveIntegrationCapability(broken, { integrationId: ID, capability: 'login', expectedOrgId: ORG })).resolves.toEqual(refused('transaction_required'))
    const rowless = {
      query: async (sql: string) => {
        const kind = kindOf(sql)
        if (kind === 'settings') return { rows: [{ isolation: 'read committed', lock_timeout_ms: '1000' }], rowCount: 1 }
        if (kind === 'xid') return { rows: [{ xid: '5' }], rowCount: 1 }
        if (kind === 'probe') return { rows: [{ capabilities: true, history: true }], rowCount: 1 }
        return {} as never
      },
    }
    await expect(resolveEffectiveIntegrationCapability(rowless, { integrationId: ID, capability: 'login', expectedOrgId: ORG })).resolves.toEqual(refused('read_failed'))
  })

  it('refuses a malformed integration row, capability row or revision as read_failed', async () => {
    const cases: Script[] = [
      { integration: integrationRow({ provider: null }) },
      { integration: integrationRow({ status: 1 }) },
      { integration: integrationRow({ corp_id: undefined }) },
      { state: stateRow(['login'], { bound_org_id: null }) },
      { state: stateRow(['login'], { integration_id: 7 }) },
      { state: stateRow(['login'], { revision: 'x' }) },
      { state: stateRow(['login'], { revision: '-1' }) },
      { state: stateRow(['login'], { revision: '9007199254740992' }) },
      { state: stateRow(['login'], { revision: 1.5 }) },
      { state: stateRow(['login'], { revision: null }) },
    ]
    for (const script of cases) {
      expect(await resolveWith(script).decision, JSON.stringify(script)).toEqual(refused('read_failed'))
    }
  })
})

describe('refusal reasons', () => {
  it('folds a foreign integration and a missing one into the same integration_missing', async () => {
    const foreign = await resolveWith({ integration: integrationRow({ org_id: 'org-beta' }) }).decision
    const missing = await resolveWith({ integration: null }).decision
    expect(foreign).toEqual(refused('integration_missing'))
    expect(foreign).toEqual(missing)
  })

  it('refuses each single broken condition with its own reason', async () => {
    const cases: Array<[string, Script, () => void]> = [
      ['state_mismatch', { state: stateRow(['login'], { bound_org_id: 'org-beta' }) }, () => undefined],
      ['state_mismatch', { state: stateRow(['login'], { bound_provider: 'wecom' }) }, () => undefined],
      ['state_mismatch', { state: stateRow(['login'], { integration_id: '99999999-2222-4333-8444-555555555555' }) }, () => undefined],
      ['provider_not_registered', { integration: integrationRow({ provider: 'wecom' }), state: stateRow(['login'], { bound_provider: 'wecom' }) }, () => undefined],
      ['governed_by_legacy_path', {}, () => { control.governance.login = 'legacy' }],
      ['unsupported', {}, () => { control.governance.login = 'unsupported' }],
      ['implementation_missing', {}, () => { control.implemented = false }],
      ['not_enabled', { state: null }, () => undefined],
      ['not_enabled', { state: stateRow([]) }, () => undefined],
      ['not_enabled', { state: stateRow(['directory', 'notification']) }, () => undefined],
      ['integration_inactive', { integration: integrationRow({ status: 'inactive' }) }, () => undefined],
      ['integration_inactive', { integration: integrationRow({ status: 'disabled' }) }, () => undefined],
      ['scope_changed', { integration: integrationRow({ config: { appKey: 'AppTwo' } }) }, () => undefined],
      ['scope_changed', { integration: integrationRow({ corp_id: 'CorpTwo' }) }, () => undefined],
      ['scope_changed', { integration: integrationRow({ config: {} }) }, () => undefined],
      ['scope_changed', { state: stateRow(['login'], { login_bound_app_scope: 'appone' }) }, () => undefined],
    ]
    for (const [reason, script, arrange] of cases) {
      control.governance = { directory: 'gated', login: 'gated', notification: 'gated' }
      control.implemented = true
      arrange()
      const { decision, statements } = resolveWith(script)
      expect(await decision, `${reason} ${JSON.stringify(script)}`).toEqual(refused(reason))
      expect(statements.map((statement) => statement.kind)).toEqual(FULL_SEQUENCE)
    }
  })

  it('refuses through the production registry: every dingtalk capability is legacy, other providers are not registered', async () => {
    control.testRegistry = false
    for (const capability of CAPABILITIES) {
      expect(await resolveWith({ state: stateRow([capability]) }, { capability }).decision, capability).toEqual(refused('governed_by_legacy_path'))
    }
    const wecom = { integration: integrationRow({ provider: 'wecom' }), state: stateRow(['login'], { bound_provider: 'wecom' }) }
    expect(await resolveWith(wecom).decision).toEqual(refused('provider_not_registered'))
  })
})

describe('the entry point', () => {
  it('takes exactly the executor and the three-field input', () => {
    expect(resolveEffectiveIntegrationCapability.length).toBe(2)
  })

  it('ignores a switch, descriptor, implementation flag or lock option passed in the input or as a third argument', async () => {
    const overrides = {
      switchOn: true,
      schemaAvailable: true,
      descriptor: { provider: 'dingtalk', governance: { directory: 'gated', login: 'gated', notification: 'gated' }, scopeOf: () => ({ tenant: 'CorpOne', appScope: 'AppOne' }) },
      implementationAvailable: true,
      lockTimeoutMs: 1000,
      orgSource: 'integration_row',
    }
    vi.stubEnv(SWITCH, 'false')
    const off = scripted()
    const call = resolveEffectiveIntegrationCapability as unknown as (...args: unknown[]) => Promise<CapabilityDecision>
    expect(await call(off.executor, { integrationId: ID, capability: 'login', expectedOrgId: ORG, ...overrides }, overrides)).toEqual(refused('switch_off'))
    expect(off.statements).toHaveLength(0)

    vi.stubEnv(SWITCH, 'true')
    control.testRegistry = false
    const legacy = scripted()
    expect(await call(legacy.executor, { integrationId: ID, capability: 'login', expectedOrgId: ORG, ...overrides }, overrides)).toEqual(refused('governed_by_legacy_path'))

    control.testRegistry = true
    const unbounded = scripted({ lockTimeout: '0' })
    expect(await call(unbounded.executor, { integrationId: ID, capability: 'login', expectedOrgId: ORG, ...overrides }, overrides)).toEqual(refused('transaction_required'))

    const effective = await call(scripted().executor, { integrationId: ID, capability: 'login', expectedOrgId: ORG, ...overrides })
    expect(effective).toMatchObject({ effective: true, orgSource: 'authenticated_tenant' })
  })
})

describe('the witness', () => {
  const base = {
    orgSource: 'authenticated_tenant', integrationId: ID, orgId: ORG, provider: 'dingtalk', status: 'active',
    capability: 'login' as Capability, revision: 3, anchor: { tenant: 'CorpOne', appScope: 'AppOne' },
  }

  it('is a 64-character lowercase hex digest that is stable for the same fields', () => {
    expect(computeIntegrationCapabilityWitness(base)).toMatch(/^[0-9a-f]{64}$/)
    expect(computeIntegrationCapabilityWitness({ ...base, anchor: { ...base.anchor } })).toBe(computeIntegrationCapabilityWitness(base))
  })

  it('matches the fixed v1 vector for the base fields', () => {
    expect(computeIntegrationCapabilityWitness(base)).toBe('7c59bf69adedfa5adae92abcb96e20780bd64101805747d4417b12442b222d60')
  })

  it('changes with every covered field, including the organization source marker, the revision and the anchor', () => {
    const variants = [
      { ...base, orgSource: 'login_intent' },
      { ...base, integrationId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e' },
      { ...base, orgId: 'org-beta' },
      { ...base, provider: 'wecom' },
      { ...base, status: 'inactive' },
      { ...base, capability: 'notification' as Capability },
      { ...base, revision: 4 },
      { ...base, anchor: { tenant: 'CorpTwo', appScope: 'AppOne' } },
      { ...base, anchor: { tenant: 'CorpOne', appScope: 'AppTwo' } },
    ]
    const digests = new Set([computeIntegrationCapabilityWitness(base), ...variants.map(computeIntegrationCapabilityWitness)])
    expect(digests.size).toBe(variants.length + 1)
  })

  it('separates field boundaries by length prefixes', () => {
    const left = computeIntegrationCapabilityWitness({ ...base, anchor: { tenant: 'Corp', appScope: 'OneAppOne' } })
    const right = computeIntegrationCapabilityWitness({ ...base, anchor: { tenant: 'CorpOne', appScope: 'AppOne' } })
    const shifted = computeIntegrationCapabilityWitness({ ...base, anchor: { tenant: 'CorpOneApp', appScope: 'One' } })
    expect(new Set([left, right, shifted]).size).toBe(3)
  })

  it('from the resolver, follows the revision and the anchor of the resolved row', async () => {
    const witnessOf = async (script: Script): Promise<string> => {
      const result = await resolveWith(script).decision
      if (result.effective === false) throw new Error(`expected effective, got ${result.reason}`)
      return result.witness
    }
    const first = await witnessOf({})
    expect(await witnessOf({})).toBe(first)
    expect(await witnessOf({ state: stateRow(['login'], { revision: '4' }) })).not.toBe(first)
    const rebound = await witnessOf({
      integration: integrationRow({ config: { appKey: 'AppTwo' } }),
      state: stateRow(['login'], { login_bound_app_scope: 'AppTwo' }),
    })
    expect(rebound).not.toBe(first)
    expect(rebound).toBe(computeIntegrationCapabilityWitness({ ...base, anchor: { tenant: 'CorpOne', appScope: 'AppTwo' } }))
    expect(first).not.toBe(computeIntegrationCapabilityWitness({ ...base, orgSource: 'login_intent' }))
  })
})

describe('module boundaries of the resolver', () => {
  const SOURCE = path.resolve(__dirname, '..', '..', 'src', 'integrations', 'integration-capability-resolve.ts')
  const source = readFileSync(SOURCE, 'utf8')

  it('loads exactly the reviewed modules and no connection lifecycle module', () => {
    expect(importSpecifiers(source, SOURCE)).toEqual([
      'node:crypto',
      '../multitable/automation-durable-dispatcher',
      '../multitable/pg-transaction-guard',
      './directory-integration-capabilities-flag',
      './integration-capability-evaluate',
      './integration-capability-implementations',
      './provider-capability-registry',
    ])
    expect(importSpecifiers(source, SOURCE).filter((specifier) => /lifecycle/i.test(specifier))).toEqual([])
  })

  it('takes the pure evaluator and the table probe from the display module, but not its non-locking read', () => {
    const file = ts.createSourceFile(SOURCE, source, ts.ScriptTarget.Latest, true)
    const names: string[] = []
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      if (statement.moduleSpecifier.text !== './integration-capability-evaluate') continue
      const bindings = statement.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) names.push(...bindings.elements.map((element) => element.name.text))
    }
    expect(names.sort()).toEqual(['CapabilityReason', 'CapabilityRow', 'EvaluatedIntegration', 'capabilityAnchor', 'evaluateIntegrationCapability', 'probeCapabilityTables'])
    expect(source).not.toMatch(/peekIntegrationCapabilityState/)
  })

  it('names only the integration and capability tables in its statements, never the history or lifecycle tables', () => {
    const file = ts.createSourceFile(SOURCE, source, ts.ScriptTarget.Latest, true)
    const literals: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push(node.text)
      else if (ts.isTemplateExpression(node)) literals.push(node.getText(file))
      ts.forEachChild(node, visit)
    }
    visit(file)
    const statements = literals.filter((text) => /\bSELECT\b/.test(text))
    expect(statements).toHaveLength(3)
    const tables = new Set(statements.flatMap((text) => [...text.matchAll(/\bFROM\s+([a-z_]+)/g)].map((match) => match[1])))
    expect([...tables].sort()).toEqual(['directory_integration_capabilities', 'directory_integrations', 'pg_settings'])
    for (const text of literals) {
      expect(text).not.toMatch(/lifecycle/i)
      expect(text).not.toMatch(/directory_integration_capability_history/)
    }
  })
})
