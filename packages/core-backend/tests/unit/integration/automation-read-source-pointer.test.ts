import { describe, expect, it } from 'vitest'
import {
  AutomationReadSourcePointerError,
  lockAutomationReadSourcePointer as lock,
  type AutomationReadSourcePointerInput,
  type AutomationReadSourcePointerErrorCode,
} from '../../../src/integration/automation-read-source-pointer'
import type { Queryable } from '../../../src/multitable/automation-durable-dispatcher'

type Row = Record<string, unknown>
type Fixture = { isolation: unknown; xids: unknown[]; epochs: Row[]; pointers: Row[] }
const revision = 'abcdef12-3456-4789-abcd-0123456789ab'
const privateDetail = 'synthetic-private-driver-detail'
function input(): AutomationReadSourcePointerInput {
  return { tenantId: 'synthetic-tenant', workspaceId: null, actionId: 'synthetic-action' }
}
function epoch(overrides: Row = {}): Row {
  return { tenant_id: input().tenantId, workspace_key: '', action_id: input().actionId, revision,
    binding_id: 'synthetic-binding', external_system_id: 'synthetic-system', ...overrides }
}
function pointer(overrides: Row = {}): Row {
  return { id: 'synthetic-binding', tenant_id: input().tenantId, workspace_id: null,
    action_id: input().actionId, external_system_id: 'synthetic-system', ...overrides }
}
function fixture(overrides: Partial<Fixture> = {}): Fixture {
  return { isolation: 'read committed', xids: ['100', '100'], epochs: [epoch()], pointers: [pointer()], ...overrides }
}
function harness(data = fixture(), options: { failAt?: string; onQuery?: (sql: string) => void } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let probes = 0
  const trx: Queryable = { async query(sql, params = []) {
    calls.push({ sql, params })
    options.onQuery?.(sql)
    if (options.failAt && sql.includes(options.failAt)) throw Object.assign(new Error(privateDetail), { code: '55P03', detail: privateDetail })
    let rows: Row[]
    if (sql.includes('current_setting')) rows = [{ isolation: data.isolation }]
    else if (sql.includes('pg_current_xact_id')) rows = [{ xid: data.xids[probes++] }]
    else if (sql.startsWith('LOCK TABLE')) rows = []
    else if (sql.includes('FROM integration_stock_prep_source_pointer_revisions')) rows = data.epochs
    else if (sql.includes('FROM integration_stock_prep_source_binding')) rows = data.pointers
    else throw new Error('Unexpected query')
    return { rows, rowCount: rows.length }
  } }
  return { trx, calls }
}
async function refused(promise: Promise<unknown>, code: AutomationReadSourcePointerErrorCode) {
  const error: unknown = await promise.then(() => undefined, caught => caught)
  expect(error).toBeInstanceOf(AutomationReadSourcePointerError)
  expect(error).toMatchObject({ name: 'AutomationReadSourcePointerError', code, message: code })
  expect(error).not.toHaveProperty('cause')
  expect(error).not.toHaveProperty('detail')
  expect(String(error)).not.toContain(privateDetail)
}
const denied = 'AUTOMATION_SOURCE_POINTER_DENIED'
const unavailable = 'AUTOMATION_SOURCE_POINTER_UNAVAILABLE'

describe('host-private source pointer (actual helper SQL fixtures, not PG lock proof)', () => {
  it('returns an exact detached frozen bound identity, not row-derived authority or defaults', async () => {
    const data = fixture()
    const result = await lock(harness(data).trx, input())
    expect(result).toEqual({ ...input(), state: 'bound', sourcePointerRevision: revision,
      sourcePointerRowId: 'synthetic-binding', externalSystemId: 'synthetic-system' })
    expect(Object.isFrozen(result)).toBe(true)
    data.epochs[0].revision = '11111111-1111-4111-8111-111111111111'
    data.pointers[0].external_system_id = 'other-system'
    expect(result.sourcePointerRevision).toBe(revision)
    expect(result.externalSystemId).toBe('synthetic-system')
    expect(Reflect.set(result, 'externalSystemId', 'other-system')).toBe(false)
    expect(result).not.toHaveProperty('actorId')
    expect(result).not.toHaveProperty('connectionId')
    expect(result).not.toHaveProperty('defaultSystemId')
  })
  it('distinguishes never-bound absence from a revision-bearing deleted tombstone', async () => {
    const never = await lock(harness(fixture({ epochs: [], pointers: [] })).trx, input())
    const deleted = await lock(harness(fixture({ epochs: [epoch({ binding_id: null, external_system_id: null })], pointers: [] })).trx, input())
    expect(never).toEqual({ ...input(), state: 'absent', sourcePointerRevision: null, sourcePointerRowId: null, externalSystemId: null })
    expect(deleted).toEqual({ ...never, sourcePointerRevision: revision })
    expect(Object.isFrozen(never)).toBe(true)
    expect(Object.isFrozen(deleted)).toBe(true)
  })
  it('uses real isolation/xid probes before table NOWAIT, epoch lock and exact 079 bucket read', async () => {
    const { trx, calls } = harness()
    await lock(trx, input())
    expect(calls).toHaveLength(6)
    expect(calls[0].sql).toContain("current_setting('transaction_isolation')")
    expect(calls[1].sql).toContain('pg_current_xact_id()')
    expect(calls[2].sql).toContain('pg_current_xact_id()')
    expect(calls[3].sql).toBe('LOCK TABLE integration_stock_prep_source_binding IN SHARE MODE NOWAIT')
    expect(calls[4].sql).toContain('SELECT tenant_id, workspace_key, action_id, revision, binding_id, external_system_id')
    expect(calls[4].sql).toContain("WHERE tenant_id = $1 AND workspace_key = '' AND action_id = $2 FOR SHARE NOWAIT")
    expect(calls[5].sql).toContain('SELECT id, tenant_id, workspace_id, action_id, external_system_id')
    expect(calls[5].sql).toContain("WHERE tenant_id = $1 AND COALESCE(workspace_id, '') = '' AND action_id = $2")
    expect(calls[4].params).toEqual([input().tenantId, input().actionId])
    expect(calls[5].params).toEqual([input().tenantId, input().actionId])
    expect(calls.map(call => call.sql).join('\n')).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE|integration_external_systems|data_sources)\b/u)
  })
  it('keeps the phantom-covering table lock and epoch query even for never-bound absence', async () => {
    const { trx, calls } = harness(fixture({ epochs: [], pointers: [] }))
    await lock(trx, input())
    expect(calls).toHaveLength(6)
    expect(calls[3].sql).toContain('IN SHARE MODE NOWAIT')
    expect(calls[4].sql).toContain('FOR SHARE NOWAIT')
  })
  it('captures immutable trusted scope before the first await', async () => {
    const scope = input()
    const { trx, calls } = harness(fixture(), { onQuery(sql) {
      if (sql.includes('current_setting')) { scope.tenantId = 'other-tenant'; scope.actionId = 'other-action' }
    } })
    expect(await lock(trx, scope)).toMatchObject(input())
    expect(calls[4].params).toEqual([input().tenantId, input().actionId])
    expect(calls[5].params).toEqual([input().tenantId, input().actionId])
  })
  it('accepts a null-prototype data input without retaining it', async () => {
    const supplied = Object.assign(Object.create(null) as AutomationReadSourcePointerInput, input())
    expect(await lock(harness().trx, supplied)).toMatchObject(input())
  })
  const invalidInputs: unknown[] = [null, undefined, {}, [], { tenantId: 'tenant', actionId: 'action' },
    { ...input(), workspaceId: '' }, { ...input(), workspaceId: 'workspace' }, { ...input(), extra: true },
    { ...input(), tenantId: '' }, { ...input(), tenantId: ' tenant' }, { ...input(), tenantId: 'x'.repeat(256) },
    { ...input(), actionId: 'action\n' }, { ...input(), actionId: 'act\u0000ion' }, { ...input(), actionId: null },
    { ...input(), actionId: () => 'action' }, Object.assign(Object.create({ hidden: true }) as Row, input())]
  it.each(invalidInputs.map(value => ({ value })))('rejects invalid input %# before SQL', async ({ value }) => {
    const { trx, calls } = harness()
    await refused(lock(trx, value as AutomationReadSourcePointerInput), 'AUTOMATION_SOURCE_POINTER_INPUT_INVALID')
    expect(calls).toEqual([])
  })
  it('rejects getters, hidden keys and toJSON without executing them', async () => {
    let hooks = 0
    const accessor = input()
    Object.defineProperty(accessor, 'tenantId', { enumerable: true, get() { hooks += 1; return input().tenantId } })
    const serializer = input()
    Object.defineProperty(serializer, 'toJSON', { value() { hooks += 1; return input() } })
    const hidden = input()
    Object.defineProperty(hidden, 'actionId', { value: input().actionId, enumerable: false })
    const symbol = input()
    Object.defineProperty(symbol, Symbol('hidden'), { value: true })
    for (const value of [accessor, serializer, hidden, symbol]) {
      const { trx, calls } = harness()
      await refused(lock(trx, value), 'AUTOMATION_SOURCE_POINTER_INPUT_INVALID')
      expect(calls).toEqual([])
    }
    expect(hooks).toBe(0)
  })
  it.each(['repeatable read', 'serializable', undefined, null])('refuses non-RC isolation %# before metadata', async isolation => {
    const { trx, calls } = harness(fixture({ isolation }))
    await refused(lock(trx, input()), 'AUTOMATION_SOURCE_POINTER_TRANSACTION_REQUIRED')
    expect(calls).toHaveLength(1)
  })
  it.each([['100', '101'], ['', ''], [undefined, undefined], [1, 1]])('refuses wrong/autocommit transaction probe %#', async (...xids) => {
    const { trx, calls } = harness(fixture({ xids }))
    await refused(lock(trx, input()), 'AUTOMATION_SOURCE_POINTER_TRANSACTION_REQUIRED')
    expect(calls.some(call => call.sql.startsWith('LOCK'))).toBe(false)
  })
  it('maps a failing transaction driver to a fixed transaction refusal', async () => {
    await refused(lock(harness(fixture(), { failAt: 'pg_current_xact_id' }).trx, input()), 'AUTOMATION_SOURCE_POINTER_TRANSACTION_REQUIRED')
  })
  it.each(['LOCK TABLE', 'FROM integration_stock_prep_source_pointer_revisions', 'FROM integration_stock_prep_source_binding'])(
    'missing schema/column, NOWAIT and driver failure at %s never escape or become absence', async failAt => {
      await refused(lock(harness(fixture(), { failAt }).trx, input()), unavailable)
    },
  )
  it.each([
    { epochs: [], pointers: [pointer()] },
    { epochs: [epoch()], pointers: [] },
    { epochs: [epoch({ binding_id: null, external_system_id: null })], pointers: [pointer()] },
    { epochs: [epoch({ binding_id: 'other-binding' })], pointers: [pointer()] },
    { epochs: [epoch({ external_system_id: 'other-system' })], pointers: [pointer()] },
    { epochs: [epoch(), epoch()], pointers: [pointer()] },
    { epochs: [epoch()], pointers: [pointer(), pointer()] },
  ])('refuses missing/mismatched/duplicate epoch or binding %#', async rows => {
    await refused(lock(harness(fixture(rows)).trx, input()), denied)
  })
  it.each(['tenant_id', 'action_id'])('does not adopt epoch or pointer %s scope hints', async key => {
    await refused(lock(harness(fixture({ epochs: [epoch({ [key]: 'foreign-scope' })] })).trx, input()), denied)
    await refused(lock(harness(fixture({ pointers: [pointer({ [key]: 'foreign-scope' })] })).trx, input()), denied)
  })
  it.each([null, 'workspace', ' '])('does not fall back from exact epoch workspace key %#', async workspaceKey => {
    await refused(lock(harness(fixture({ epochs: [epoch({ workspace_key: workspaceKey })] })).trx, input()), denied)
  })
  it.each(['', 'workspace', ' '])('rejects a non-null actual 079 workspace including malformed empty bucket %#', async workspaceId => {
    await refused(lock(harness(fixture({ pointers: [pointer({ workspace_id: workspaceId })] })).trx, input()), denied)
  })
  it.each([null, '', 'invalid', revision.toUpperCase(), `${revision} `])('rejects noncanonical epoch revision %#', async value => {
    await refused(lock(harness(fixture({ epochs: [epoch({ revision: value })] })).trx, input()), unavailable)
  })
  it.each([
    { binding_id: null }, { external_system_id: null }, { binding_id: '' }, { external_system_id: ' system' },
    { binding_id: 1 }, { external_system_id: true },
  ])('requires complete canonical epoch identity or exact double-null tombstone %#', async change => {
    await refused(lock(harness(fixture({ epochs: [epoch(change)] })).trx, input()), unavailable)
  })
  it.each([{ id: '' }, { id: ' binding' }, { external_system_id: null }, { external_system_id: 'sys\nitem' }])(
    'requires canonical actual pointer identity %#', async change => {
      await refused(lock(harness(fixture({ pointers: [pointer(change)] })).trx, input()), unavailable)
    },
  )
  it.each(['epochs', 'pointers'] as const)('rejects %s partial schema or unexpected selected keys', async table => {
    const missing = fixture(); delete missing[table][0].action_id
    const extra = fixture(); extra[table][0].private_metadata = privateDetail
    await refused(lock(harness(missing).trx, input()), unavailable)
    await refused(lock(harness(extra).trx, input()), unavailable)
  })
  it('never invokes malformed driver row getters', async () => {
    let hooks = 0
    const data = fixture()
    Object.defineProperty(data.epochs[0], 'revision', { enumerable: true, get() { hooks += 1; return revision } })
    await refused(lock(harness(data).trx, input()), unavailable)
    expect(hooks).toBe(0)
  })
})
