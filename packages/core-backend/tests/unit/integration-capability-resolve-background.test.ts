/** Production registry tests: no module mocks in this file. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { resolveEffectiveNotificationCapabilityForBackground as resolve } from '../../src/integrations/integration-capability-resolve-background'
import { resolveEffectiveIntegrationCapability, CAPABILITY_WITNESS_SHAPE as COMPAT_SHAPE, computeIntegrationCapabilityWitness as compatWitness } from '../../src/integrations/integration-capability-resolve'
import { CAPABILITY_WITNESS_SHAPE, computeIntegrationCapabilityWitness } from '../../src/integrations/integration-capability-witness'
import { resolveProviderCapabilityDescriptor } from '../../src/integrations/provider-capability-registry'
import { isCapabilityImplementationAvailable } from '../../src/integrations/integration-capability-implementations'
import { importSpecifiers } from '../helpers/import-edge-allowlist'
import { capabilityRow, ID, INPUT, integrationRow, ORG, refusal, scripted, SEQUENCE, type Script } from '../helpers/background-capability-fixture'

const SWITCH = 'DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED'
const run = async (script: Script = {}, ...inputs: [unknown?]) => {
  const harness = scripted(script)
  return { ...harness, decision: await resolve(harness.executor, (inputs.length ? inputs[0] : INPUT) as never) }
}

beforeEach(() => { vi.stubEnv(SWITCH, 'true') })
afterEach(() => { vi.unstubAllEnvs() })

describe('BG-U01/U02: exact input and refusal precedence', () => {
  it.each([
    null, undefined, [], 'input', 1, {}, { integrationId: ID }, { eventOrgId: ORG },
    { integrationId: ID, orgId: ORG }, { integrationId: ID, eventOrgID: ORG },
    { ...INPUT, integrationId: ID.toUpperCase() }, { ...INPUT, integrationId: 'bad' },
    { ...INPUT, integrationId: 1 }, { ...INPUT, integrationId: null },
    ...['orgId', 'expectedOrgId', 'integrationOrgId', 'orgSource', 'switch', 'descriptor', 'lock'].map((key) => ({ ...INPUT, [key]: true })),
    ...['notification', 'directory', 'login'].map((capability) => ({ ...INPUT, capability })),
    Object.defineProperty({ ...INPUT }, 'hidden', { value: true }),
    { ...INPUT, [Symbol('extra')]: true },
  ].map((input) => [input]))('rejects malformed or extra keys before SQL: %j', async (input) => {
    const { decision, statements } = await run({}, input)
    expect(decision).toEqual(refusal('input_invalid'))
    expect(statements).toEqual([])
  })

  it.each([undefined, null, 7, [], {}, '', ' ', '\t\n'])('rejects a present invalid event organization before the switch: %j', async (eventOrgId) => {
    vi.stubEnv(SWITCH, 'false')
    const { decision, statements } = await run({}, { ...INPUT, eventOrgId })
    expect(decision).toEqual(refusal('org_mismatch'))
    expect(statements).toEqual([])
    expect((await run({}, { integrationId: 'bad', eventOrgId })).decision).toEqual(refusal('input_invalid'))
    expect((await run({}, { ...INPUT, eventOrgId, orgSource: 'injected' })).decision).toEqual(refusal('input_invalid'))
  })

  it.each(['false', 'TRUE', '', '1', ' true', 'true '])('only accepts the exact enabled switch, not %j', async (flag) => {
    vi.stubEnv(SWITCH, flag)
    const { decision, statements } = await run()
    expect(decision).toEqual(refusal('switch_off'))
    expect(statements).toEqual([])
  })

  it('preserves nonblank organization bytes and fixes the two-argument API', async () => {
    expect(resolve.length).toBe(2)
    const eventOrgId = ' org-alpha '
    const { decision, statements } = await run({
      integrations: [integrationRow({ org_id: eventOrgId })],
      capabilities: [capabilityRow({ bound_org_id: eventOrgId })],
    }, { ...INPUT, eventOrgId })
    expect(decision).toMatchObject({ effective: true, orgId: eventOrgId, capability: 'notification', orgSource: 'background_event_row' })
    expect(statements[4].params).toEqual([ID, eventOrgId])
  })

  it('folds unexpected property access failures without exposing them', async () => {
    const input = { eventOrgId: ORG, get integrationId() { throw new Error('private failure') } }
    expect((await run({}, input)).decision).toEqual(refusal('read_failed'))
  })
})

describe('BG-U03/U04: transaction contract and six statements', () => {
  it.each([null, undefined, {}, { query: 'invalid' }])('rejects an unusable executor: %j', async (executor) => {
    expect(await resolve(executor as never, INPUT)).toEqual(refusal('transaction_required'))
  })

  it.each([
    ...['repeatable read', 'serializable', null].map((isolation) => [{ isolation, lock_timeout_ms: '2000' }]),
    ...['0', '5001', '-1', '2s', '', undefined, 2000, '1.5', '9007199254740992'].map((lock_timeout_ms) => [{ isolation: 'read committed', lock_timeout_ms }]),
    [], [{ isolation: 'read committed', lock_timeout_ms: '2000' }, { isolation: 'read committed', lock_timeout_ms: '2000' }],
  ].map((settings) => [settings]))('refuses invalid transaction settings: %j', async (settings) => {
    const { decision, statements } = await run({ settings })
    expect(decision).toEqual(refusal('transaction_required'))
    expect(statements.map(({ kind }) => kind)).toEqual(['settings'])
  })

  it.each([['71', '72'], ['', ''], ['71', undefined]])('refuses absent or different transaction ids: %j', async (...xids) => {
    const { decision, statements } = await run({ xids })
    expect(decision).toEqual(refusal('transaction_required'))
    expect(statements.every(({ kind }) => kind === 'settings' || kind === 'xid')).toBe(true)
  })

  it.each(['1', '2000', '5000'])('runs exactly six statements on the provided handle at lock bound %s', async (lock_timeout_ms) => {
    const { decision, statements } = await run({ settings: [{ isolation: 'read committed', lock_timeout_ms }] })
    expect(decision.effective).toBe(true)
    expect(statements.map(({ kind }) => kind)).toEqual(SEQUENCE)
    expect(statements[4].sql).toMatch(/WHERE id = \$1::uuid AND org_id = \$2 FOR SHARE\s*$/)
    expect(statements[4].params).toEqual([ID, ORG])
    expect(statements[5].sql).toMatch(/WHERE integration_id = \$1::uuid FOR SHARE\s*$/)
    expect(statements[5].params).toEqual([ID])
    for (const { sql } of statements) {
      expect(sql).not.toMatch(/\b(?:SET|BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE|users)\b|advisory|lifecycle/i)
    }
  })

  it.each([{ capabilities: false, history: true }, { capabilities: true, history: false }])('probes both required tables: %j', async (tables) => {
    const { decision, statements } = await run({ probe: [tables] })
    expect(decision).toEqual(refusal('schema_unavailable'))
    expect(statements.map(({ kind }) => kind)).toEqual(SEQUENCE.slice(0, 4))
    expect(statements[3].sql).toContain("to_regclass('directory_integration_capabilities')")
    expect(statements[3].sql).toContain("to_regclass('directory_integration_capability_history')")
  })

  it.each(['55P03', '57014', '40001', '40P01', '25P02', '42P01'])('folds %s at every statement and stops immediately', async (code) => {
    for (let failAt = 0; failAt < 6; failAt++) {
      const { decision, statements } = await run({ failAt, error: Object.assign(new Error('driver details'), { code }) })
      expect(decision, `statement ${failAt}`).toEqual(refusal('read_failed'))
      expect(statements).toHaveLength(failAt + 1)
    }
  })
})

describe('BG-U05/U06: locked rows and evaluator order', () => {
  it.each([true, false])('hides foreign integrations regardless of notification state %j', async (enabled) => {
    const { decision, statements } = await run({
      integrations: [integrationRow({ org_id: 'org-beta' })], capabilities: [capabilityRow({ notification_enabled: enabled })],
    })
    expect(decision).toEqual(refusal('integration_missing'))
    expect(statements.map(({ kind }) => kind)).toEqual(SEQUENCE.slice(0, 5))
  })

  it('stops before the capability read for missing, multiple or malformed integrations', async () => {
    for (const [integrations, reason] of [
      [[], 'integration_missing'], [[integrationRow(), integrationRow()], 'read_failed'],
      ...['id', 'org_id', 'provider', 'status', 'corp_id'].map((key) => [[integrationRow({ [key]: 7 })], 'read_failed']),
    ] as Array<[Record<string, unknown>[], string]>) {
      const { decision, statements } = await run({ integrations, ignorePair: true })
      expect(decision).toEqual(refusal(reason))
      expect(statements).toHaveLength(5)
    }
  })

  it('keeps the existing evaluator and final-id ordering for impossible paired-query mock rows', async () => {
    const other = '11111111-2222-4333-8444-555555555555'
    const cases: Array<[Script, string]> = [
      [{ integrations: [integrationRow({ org_id: 'org-beta' })] }, 'org_mismatch'],
      [{ integrations: [integrationRow({ id: other })], capabilities: [capabilityRow({ integration_id: other })] }, 'read_failed'],
      [{ integrations: [integrationRow({ id: other })] }, 'state_mismatch'],
    ]
    for (const [script, reason] of cases) {
      const { decision, statements } = await run({ ...script, ignorePair: true })
      expect(decision).toEqual(refusal(reason))
      expect(statements.map(({ kind }) => kind)).toEqual(SEQUENCE)
    }
  })

  it.each([
    ['state_mismatch', { capabilities: [capabilityRow({ bound_org_id: 'org-beta' })] }],
    ['state_mismatch', { capabilities: [capabilityRow({ bound_provider: 'other' })] }],
    ['state_mismatch', { capabilities: [capabilityRow({ integration_id: 'another-id' })] }],
    ['provider_not_registered', { integrations: [integrationRow({ provider: 'other' })], capabilities: [] }],
    ['not_enabled', { capabilities: [] }],
    ['not_enabled', { capabilities: [capabilityRow({ notification_enabled: false, login_enabled: true, directory_enabled: true })] }],
    ['integration_inactive', { integrations: [integrationRow({ status: 'disabled' })] }],
    ['scope_changed', { integrations: [integrationRow({ config: { appKey: 'Changed' } })] }],
    ['scope_changed', { integrations: [integrationRow({ corp_id: 'Changed' })] }],
    ['scope_changed', { capabilities: [capabilityRow({ notification_bound_app_scope: null })] }],
    ['state_mismatch', { integrations: [integrationRow({ status: 'inactive' })], capabilities: [capabilityRow({ bound_org_id: 'other', notification_enabled: false })] }],
    ['not_enabled', { integrations: [integrationRow({ status: 'inactive' })], capabilities: [capabilityRow({ notification_enabled: false })] }],
  ] satisfies Array<[string, Script]>)('returns only the fixed refusal %s', async (reason, script) => {
    const { decision, statements } = await run(script)
    expect(decision).toEqual(refusal(reason))
    expect(statements.map(({ kind }) => kind)).toEqual(SEQUENCE)
  })

  it('rejects malformed capability rows and unsafe revisions without a witness', async () => {
    const rows = [
      [capabilityRow(), capabilityRow()],
      ...['integration_id', 'bound_org_id', 'bound_provider'].map((key) => [capabilityRow({ [key]: null })]),
      ...['-1', '01', '1.5', '9007199254740992', '', null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((revision) => [capabilityRow({ revision })]),
    ]
    for (const capabilities of rows) expect((await run({ capabilities })).decision).toEqual(refusal('read_failed'))
    for (const revision of ['0', '9007199254740991', 17]) {
      expect((await run({ capabilities: [capabilityRow({ revision })] })).decision).toMatchObject({ effective: true, revision: Number(revision) })
    }
  })
})

describe('BG-U07/U09/U10: production parity and witness leaf', () => {
  const fields = {
    orgSource: 'background_event_row', integrationId: ID, orgId: ORG, provider: 'dingtalk', status: 'active',
    capability: 'notification' as const, revision: 17, anchor: { tenant: 'CorpOne', appScope: 'AppOne' },
  }

  it('pins the two background vectors and unchanged authenticated vectors', async () => {
    const { decision } = await run()
    expect(decision).toEqual({
      effective: true, capability: 'notification', integrationId: ID, orgId: ORG, provider: 'dingtalk',
      status: 'active', revision: 17, orgSource: 'background_event_row',
      witness: 'cfd57e6fd6992de1c6ed9d15df41f047e6872af0a1d14070e449f37359c2f722',
    })
    expect(computeIntegrationCapabilityWitness(fields)).toBe('cfd57e6fd6992de1c6ed9d15df41f047e6872af0a1d14070e449f37359c2f722')
    expect((await run({ capabilities: [capabilityRow({ revision: '18' })] })).decision).toMatchObject({ witness: 'c1b7d6ab96af25294c22c7b613f46447bee889843b328170ce8b80729742896d' })
    expect(computeIntegrationCapabilityWitness({ ...fields, orgSource: 'authenticated_tenant' })).toBe('ffcc39c834e5290ee5f62008a196855339e698dc632672a8330427f178b3d181')
    expect(compatWitness({ ...fields, orgSource: 'authenticated_tenant', capability: 'login', revision: 3 })).toBe('7c59bf69adedfa5adae92abcb96e20780bd64101805747d4417b12442b222d60')
  })

  it('separates every encoded field, field boundaries, and UTF-8 bytes', () => {
    const variants = [
      { ...fields, orgSource: 'authenticated_tenant' }, { ...fields, integrationId: 'another-id' },
      { ...fields, orgId: 'org-beta' }, { ...fields, provider: 'other' }, { ...fields, status: 'inactive' },
      { ...fields, capability: 'login' as const }, { ...fields, revision: 18 },
      { ...fields, anchor: { ...fields.anchor, tenant: 'Corp' } }, { ...fields, anchor: { ...fields.anchor, appScope: 'Other' } },
    ]
    expect(new Set([fields, ...variants].map(computeIntegrationCapabilityWitness)).size).toBe(10)
    expect(computeIntegrationCapabilityWitness({ ...fields, anchor: { tenant: 'ab', appScope: 'c' } }))
      .not.toBe(computeIntegrationCapabilityWitness({ ...fields, anchor: { tenant: 'a', appScope: 'bc' } }))
    expect(computeIntegrationCapabilityWitness({ ...fields, orgId: '组织-α', anchor: { tenant: '租户', appScope: '应用' } }))
      .toBe('f97e9bbf6d9d324b0492163d5fa4f5580e2c6d4e82a868d99d1c106d6db6a955')
  })

  it('uses the production gated/implemented notification with identical R-1 decisions except source and witness', async () => {
    expect(resolveProviderCapabilityDescriptor('dingtalk')?.governance).toEqual({ directory: 'legacy', login: 'legacy', notification: 'gated' })
    expect(['directory', 'login', 'notification'].map((capability) => isCapabilityImplementationAvailable('dingtalk', capability as never))).toEqual([false, false, true])
    for (const script of [{}, { capabilities: [] }, { integrations: [] }, { integrations: [integrationRow({ status: 'inactive' })] }] satisfies Script[]) {
      const background = await run(script)
      const request = scripted(script)
      const authenticated = await resolveEffectiveIntegrationCapability(request.executor, { integrationId: ID, expectedOrgId: ORG, capability: 'notification' })
      if (background.decision.effective && authenticated.effective) {
        const { orgSource: bgSource, witness: bgWitness, ...bg } = background.decision
        const { orgSource: requestSource, witness: requestWitness, ...r1 } = authenticated
        expect(bg).toEqual(r1)
        expect([bgSource, requestSource]).toEqual(['background_event_row', 'authenticated_tenant'])
        expect(bgWitness).not.toBe(requestWitness)
      } else expect(background.decision).toEqual(authenticated)
      expect(background.statements).toEqual(request.statements)
    }
  })

  it('keeps one constant definition, compatibility exports and a pure leaf with no migration import', () => {
    expect(CAPABILITY_WITNESS_SHAPE).toBe('^[0-9a-f]{64}$')
    expect(COMPAT_SHAPE).toBe(CAPABILITY_WITNESS_SHAPE)
    expect(compatWitness).toBe(computeIntegrationCapabilityWitness)
    const dir = path.resolve(__dirname, '../../src/integrations')
    const leaf = path.join(dir, 'integration-capability-witness.ts')
    expect(importSpecifiers(readFileSync(leaf, 'utf8'), leaf)).toEqual(['node:crypto', './provider-capability-registry'])
    const definitions = ['integration-capability-resolve', 'integration-capability-resolve-core', 'integration-capability-resolve-background', 'integration-capability-witness']
      .flatMap((file) => readFileSync(path.join(dir, `${file}.ts`), 'utf8').match(/const CAPABILITY_WITNESS_SHAPE\s*=/g) ?? [])
    expect(definitions).toHaveLength(1)
  })
})
