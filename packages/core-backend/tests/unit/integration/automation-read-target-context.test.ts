import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createAutomationReadTargetContext,
  AutomationReadTargetContextError,
  type AutomationReadTargetMaterialCodec,
  type AutomationReadTargetContextInput,
} from '../../../src/integration/automation-read-target-context'
import type { Queryable } from '../../../src/multitable/automation-durable-dispatcher'

const requirePlugin = createRequire(import.meta.url)
const pluginLib = path.resolve(__dirname, '../../../../../plugins/plugin-integration-core/lib')
const profileModule = requirePlugin(path.join(pluginLib, 'stock-preparation-automation-profile.cjs')) as {
  prepareStockPreparationAutomationProfiles(input: unknown): Array<Record<string, unknown>>
  restoreStockPreparationAutomationProfileMaterial: AutomationReadTargetMaterialCodec['restoreStockPreparationAutomationProfileMaterial']
}
const targetModule = requirePlugin(path.join(pluginLib, 'stock-preparation-automation-target-contract.cjs')) as {
  deriveAutomationReadTargetContract: AutomationReadTargetMaterialCodec['deriveAutomationReadTargetContract']
}
const codec: AutomationReadTargetMaterialCodec = {
  restoreStockPreparationAutomationProfileMaterial: profileModule.restoreStockPreparationAutomationProfileMaterial,
  deriveAutomationReadTargetContract: targetModule.deriveAutomationReadTargetContract,
}
const actionId = 'plm.stock-preparation.pull-bom.v1'
const revision = '11111111-1111-4111-8111-111111111111'
const targetId = '22222222-2222-4222-8222-222222222222'
const privateDetail = 'synthetic-sensitive-driver-detail'
type Row = Record<string, unknown>
function input(): AutomationReadTargetContextInput {
  return { actor: { actorId: 'synthetic-actor', tenantId: 'synthetic-tenant', workspaceId: null },
    producer: { generation: '1', nonce: revision }, targetId }
}
function prepared(): Row {
  return profileModule.prepareStockPreparationAutomationProfiles({ config: {
    stockPreparationAutomationProfiles: [{ tenantId: input().actor.tenantId, workspaceId: null, projectId: 'synthetic-project', actionId }],
    stockPreparationTableActions: [{ actionId, source: { externalSystemId: 'synthetic-source' },
      target: { sheetId: 'synthetic-sheet', fieldIdMap: {} } }],
  } })[0]
}
function fixture() {
  const profile = prepared()
  return {
    isolation: 'read committed', xid: '100', actorLive: true, member: true, profileLive: true,
    profile: { target_id: targetId, tenant_id: profile.tenantId, sheet_id: profile.sheetId, action_id: profile.actionId,
      project_id: profile.projectId, object_id: profile.objectId, material: profile.material,
      revision, producer_generation: '1', producer_nonce: revision, enabled: true, binding_tenant_id: profile.tenantId } as Row,
  }
}
// Deliberately only the real actor/profile prefix: these unit cases prove input,
// codec and fail-before-metadata guards, not a substituted installed/permission
// success. The full production composition is exercised in root's real PG suite.
function harness(data = fixture(), options: { before?: (sql: string) => void; failure?: string } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let lockTimeout = '0'
  const trx: Queryable = { async query(sql, params = []) {
    calls.push({ sql, params }); options.before?.(sql)
    if (options.failure && sql.includes(options.failure)) throw new Error(privateDetail)
    let rows: Row[]
    if (sql.includes("current_setting('transaction_isolation')")) rows = [{ isolation: data.isolation }]
    else if (sql.includes("current_setting('lock_timeout')")) rows = [{ previous: lockTimeout, timeout_ms: String(Number.parseInt(lockTimeout, 10)) }]
    else if (sql.includes("set_config('lock_timeout'")) {
      expect(params).toHaveLength(1)
      expect(['250ms', '0']).toContain(params[0])
      lockTimeout = params[0] as string
      rows = []
    } else if (sql.includes('pg_current_xact_id')) rows = [{ xid: data.xid }]
    else if (sql.includes('FROM user_roles')) rows = [{ role_id: 'integration_admin' }]
    else if (sql.includes('FROM role_permissions')) rows = [{ role_id: 'integration_admin', permission_code: 'integration:admin' }]
    else if (sql.includes('FROM user_permissions')) rows = []
    else if (sql.includes('FROM users')) rows = [{ id: input().actor.actorId, role: 'user', is_active: data.actorLive,
      activation_status: 'activated', permissions: [] }]
    else if (sql.includes('FROM user_orgs')) rows = data.member ? [{ user_id: input().actor.actorId,
      org_id: input().actor.tenantId, is_active: true }] : []
    else if (sql.includes('FROM user_namespace_admissions')) rows = [{ namespace: 'integration', enabled: true }]
    else if (sql.includes('FROM automation_read_producer_slot')) rows = [{ generation: '1', nonce: revision, live: data.profileLive }]
    else if (sql.includes('FROM automation_read_target_profiles')) rows = [data.profile]
    else throw new Error('Unexpected metadata SQL: unit prefix is not a complete authority fixture')
    return { rows, rowCount: rows.length }
  } }
  return { trx, calls }
}
async function refused(work: Promise<unknown>, code = 'AUTOMATION_TARGET_CONTEXT_UNAVAILABLE') {
  const error: unknown = await work.then(() => undefined, caught => caught)
  expect(error).toBeInstanceOf(AutomationReadTargetContextError)
  expect(error).toMatchObject({ code, message: code })
  expect(error).not.toHaveProperty('cause')
  expect(error).not.toHaveProperty('details')
  expect(String(error)).not.toContain(privateDetail)
}

describe('target context: strict input and real actor/profile prefix; full chain belongs to real PG', () => {
  it('passes the real actor/profile and bounded producer lock prefix before installed metadata refusal', async () => {
    const { trx, calls } = harness()
    let restored = false
    const observedCodec: AutomationReadTargetMaterialCodec = { ...codec,
      restoreStockPreparationAutomationProfileMaterial(material) {
        const result = codec.restoreStockPreparationAutomationProfileMaterial(material)
        restored = true
        return result
      },
    }
    await refused(createAutomationReadTargetContext({ codec: observedCodec }).lock(trx, input()))
    expect(restored).toBe(true)
    expect(calls.filter(call => call.sql.includes("set_config('lock_timeout'"))
      .map(call => call.params)).toEqual([['250ms'], ['0'], ['250ms'], ['0']])
    const producerReads = calls.filter(call => call.sql.includes('FROM automation_read_producer_slot'))
    expect(producerReads).toHaveLength(4)
    expect(producerReads.map(call => call.sql.includes('FOR SHARE'))).toEqual([true, false, true, false])
    expect(producerReads.filter(call => !call.sql.includes('FOR SHARE'))
      .every(call => call.sql.includes('expires_at > pg_catalog.clock_timestamp()'))).toBe(true)
    expect(calls.at(-1)?.sql).toMatch(/^LOCK TABLE /)
    expect(calls.some(call => call.sql.includes('FROM automation_read_target_profiles'))).toBe(true)
  })
  it.each([null, {}, [], { codec: null }, { codec: {} }, { codec, proof: true }])('requires a closed host codec option %#', bad => {
    expect(() => createAutomationReadTargetContext(bad as { codec: AutomationReadTargetMaterialCodec }))
      .toThrow('AUTOMATION_TARGET_CONTEXT_INPUT_INVALID')
  })
  it('captures codec function references once without invoking accessors', async () => {
    let oldCalls = 0, newCalls = 0, hookCalls = 0
    const supplied: AutomationReadTargetMaterialCodec = { ...codec, restoreStockPreparationAutomationProfileMaterial() {
      oldCalls += 1; throw new Error(privateDetail)
    } }
    const context = createAutomationReadTargetContext({ codec: supplied })
    Object.assign(supplied, { restoreStockPreparationAutomationProfileMaterial() { newCalls += 1 } })
    await refused(context.lock(harness().trx, input()))
    expect(oldCalls).toBe(1); expect(newCalls).toBe(0)
    const hidden = { ...codec }
    Object.defineProperty(hidden, 'deriveAutomationReadTargetContract', { enumerable: true, get() { hookCalls += 1; return codec.deriveAutomationReadTargetContract } })
    expect(() => createAutomationReadTargetContext({ codec: hidden })).toThrow('AUTOMATION_TARGET_CONTEXT_INPUT_INVALID')
    expect(hookCalls).toBe(0)
    expect(Object.isFrozen(context)).toBe(true)
  })
  const badInputs: unknown[] = [undefined, null, {}, [], { ...input(), fieldIds: ['active'] },
    { ...input(), targetId: targetId.toUpperCase().replace('2', 'A') }, { ...input(), targetId: 'not-a-uuid' },
    { ...input(), actor: { ...input().actor, workspaceId: '' } }, { ...input(), actor: { ...input().actor, actorId: ' padded' } },
    { ...input(), actor: { ...input().actor, tenantId: 'bad\n' } }, { ...input(), producer: { generation: '0', nonce: revision } },
    { ...input(), producer: { generation: '1', nonce: 'invalid' } }, { ...input(), producer: { generation: '9223372036854775808', nonce: revision } }]
  it.each(badInputs.map(value => ({ value })))('rejects input %# before all SQL and codecs', async ({ value }) => {
    const { trx, calls } = harness()
    await refused(createAutomationReadTargetContext({ codec }).lock(trx, value as AutomationReadTargetContextInput), 'AUTOMATION_TARGET_CONTEXT_INPUT_INVALID')
    expect(calls).toEqual([])
  })
  it('rejects input getter/toJSON/hidden keys without invoking them', async () => {
    let hooks = 0
    for (const key of ['actor', 'producer', 'targetId']) {
      const bad = input()
      Object.defineProperty(bad, key, { enumerable: true, get() { hooks += 1; return input()[key as keyof AutomationReadTargetContextInput] } })
      await refused(createAutomationReadTargetContext({ codec }).lock(harness().trx, bad), 'AUTOMATION_TARGET_CONTEXT_INPUT_INVALID')
    }
    const hidden = input()
    Object.defineProperty(hidden.actor, 'toJSON', { value() { hooks += 1; return input().actor } })
    await refused(createAutomationReadTargetContext({ codec }).lock(harness().trx, hidden), 'AUTOMATION_TARGET_CONTEXT_INPUT_INVALID')
    expect(hooks).toBe(0)
  })
  it.each(['repeatable read', 'serializable', ''])('requires actual RC, not %s', async isolation => {
    const data = fixture(); data.isolation = isolation
    const { trx, calls } = harness(data)
    await refused(createAutomationReadTargetContext({ codec }).lock(trx, input()), 'AUTOMATION_TARGET_CONTEXT_TRANSACTION_REQUIRED')
    expect(calls).toHaveLength(1)
  })
  it('rejects an autocommit-shaped handle before live actor lookup', async () => {
    const data = fixture(); let probes = 0
    const { trx, calls } = harness(data, { before(sql) { if (sql.includes('pg_current_xact_id')) data.xid = String(++probes) } })
    await refused(createAutomationReadTargetContext({ codec }).lock(trx, input()), 'AUTOMATION_TARGET_CONTEXT_TRANSACTION_REQUIRED')
    expect(calls.some(call => call.sql.includes('FROM user_roles'))).toBe(false)
  })
  it.each(['actorLive', 'member', 'profileLive'] as const)('refuses real failed %s before metadata/records/codec derive', async key => {
    const data = fixture(); data[key] = false
    const { trx, calls } = harness(data)
    await refused(createAutomationReadTargetContext({ codec }).lock(trx, input()))
    expect(calls.some(call => /LOCK TABLE|FROM meta_|meta_records/.test(call.sql))).toBe(false)
    if (key !== 'profileLive') expect(calls.some(call => call.sql.includes('automation_read_producer_slot'))).toBe(false)
  })
  it.each(['sheet_id', 'object_id', 'action_id'])('refuses profile header/material %s disagreement before installed lookup', async key => {
    const data = fixture(); data.profile[key] = 'synthetic-different-header'
    const { trx, calls } = harness(data)
    await refused(createAutomationReadTargetContext({ codec }).lock(trx, input()), 'AUTOMATION_TARGET_CONTEXT_DENIED')
    expect(calls.some(call => /LOCK TABLE|FROM meta_/.test(call.sql))).toBe(false)
  })
  it('calls the real restore factory and rejects malformed persisted mapping material', async () => {
    const data = fixture()
    data.profile.material = { ...(data.profile.material as Row), extFieldMappingConfig: { mappingId: 'not-a-valid-config' } }
    const { trx, calls } = harness(data)
    await refused(createAutomationReadTargetContext({ codec }).lock(trx, input()))
    expect(calls.some(call => sqlMetadata(call.sql))).toBe(false)
  })
  it('captures actor and producer before the first await, not a later mutated selector', async () => {
    const scope = input(), data = fixture(); data.profile.sheet_id = 'different-header'
    const { trx, calls } = harness(data, { before() { scope.actor.actorId = 'foreign'; scope.actor.tenantId = 'foreign'; scope.targetId = 'foreign' } })
    await refused(createAutomationReadTargetContext({ codec }).lock(trx, scope), 'AUTOMATION_TARGET_CONTEXT_DENIED')
    expect(calls.find(call => call.sql.includes('FROM user_roles'))?.params).toEqual([input().actor.actorId])
    expect(calls.find(call => call.sql.includes('FROM automation_read_target_profiles'))?.params).toEqual([targetId, input().actor.tenantId])
  })
  it.each(['FROM user_roles', 'FROM user_orgs', 'FROM automation_read_producer_slot', 'FROM automation_read_target_profiles'])(
    'does not leak driver failures at %s', async failure => {
      await refused(createAutomationReadTargetContext({ codec }).lock(harness(fixture(), { failure }).trx, input()))
    },
  )
})
function sqlMetadata(sql: string): boolean { return /LOCK TABLE|FROM meta_|meta_records/.test(sql) }
