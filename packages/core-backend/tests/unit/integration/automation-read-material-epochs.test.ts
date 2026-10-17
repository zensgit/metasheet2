import { describe, expect, it } from 'vitest'
import { AutomationReadMaterialEpochError, lockAutomationReadMaterialEpochs as lock,
  type AutomationReadMaterialEpochInput, type AutomationReadMaterialEpochErrorCode,
} from '../../../src/integration/automation-read-material-epochs'
import type { Queryable } from '../../../src/multitable/automation-durable-dispatcher'

type Row = Record<string, unknown>
type Fixture = { isolation: unknown; xids: unknown[]; schemas: Row[]; sheets: Row[]; bases: Row[]; epochs: Row[] }
const revision = 'abcdef12-3456-4789-abcd-0123456789ab'
const baseId = 'synthetic-base'
const secret = 'synthetic-driver-private-detail'
function input(): AutomationReadMaterialEpochInput {
  return { tenantId: 'synthetic-tenant', workspaceId: null, projectId: 'synthetic-project', objectId: 'synthetic-object', sheetId: 'synthetic-sheet' }
}
function fixture(change: Partial<Fixture> = {}): Fixture {
  return { isolation: 'read committed', xids: ['100', '100'], schemas: [{ consistent: true }],
    sheets: [{ id: input().sheetId, base_id: baseId, deleted_at: null }], bases: [{ id: baseId, deleted_at: null }],
    epochs: [{ kind: 'sheet', scope: { id: input().sheetId }, revision }, { kind: 'base', scope: { id: baseId }, revision },
      { kind: 'pack', scope: { tenantId: input().tenantId, projectId: input().projectId, objectId: input().objectId }, revision }], ...change }
}
function harness(data = fixture(), options: { failAt?: string; onQuery?: (sql: string) => void } = {}) {
  const calls: { sql: string; params: unknown[] }[] = []
  let probes = 0
  const trx: Queryable = { async query(sql, params = []) {
    calls.push({ sql, params }); options.onQuery?.(sql)
    if (options.failAt && sql.includes(options.failAt)) throw Object.assign(new Error(secret), { detail: secret, code: '55P03' })
    let rows: Row[]
    if (sql.includes('current_setting')) rows = [{ isolation: data.isolation }]
    else if (sql.includes('pg_current_xact_id')) rows = [{ xid: data.xids[probes++] }]
    else if (sql.startsWith('LOCK TABLE')) rows = []
    else if (sql.includes('pg_catalog.pg_class')) rows = data.schemas
    else if (sql.includes('FROM meta_sheets')) rows = data.sheets
    else if (sql.includes('FROM meta_bases')) rows = data.bases
    else if (sql.includes('FROM automation_read_material_epochs')) rows = data.epochs
    else throw new Error('Unexpected query')
    return { rows, rowCount: rows.length }
  } }
  return { trx, calls }
}
async function refused(result: Promise<unknown>, code: AutomationReadMaterialEpochErrorCode) {
  const error: unknown = await result.then(() => undefined, caught => caught)
  expect(error).toBeInstanceOf(AutomationReadMaterialEpochError)
  expect(error).toMatchObject({ message: code, code })
  expect(error).not.toHaveProperty('cause')
  expect(error).not.toHaveProperty('detail')
  expect(String(error)).not.toContain(secret)
}
const denied = 'AUTOMATION_MATERIAL_DENIED'
const unavailable = 'AUTOMATION_MATERIAL_UNAVAILABLE'

describe('material epoch capture (SQL fixtures, not real DB lock/ABA proof)', () => {
  it('returns detached deeply frozen epochs and the actual base, not projectId', async () => {
    const f = fixture()
    const value = await lock(harness(f).trx, input())
    expect(value).toEqual({ baseId, revisions: { sheet: revision, base: revision, pack: revision } })
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.revisions)).toBe(true)
    f.epochs[0].revision = secret
    expect(value.revisions.sheet).toBe(revision)
    expect(Reflect.set(value.revisions, 'sheet', secret)).toBe(false)
  })
  it('allows only pack to be never-seen and issues no read-time mutation', async () => {
    const f = fixture(); f.epochs.pop()
    const h = harness(f)
    expect(await lock(h.trx, input())).toEqual({ baseId, revisions: { sheet: revision, base: revision, pack: null } })
    expect(h.calls.map(call => call.sql).join('\n')).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|BEGIN|COMMIT|meta_records)\b/u)
  })
  it('fences all sources before positive and negative epoch lookups', async () => {
    const h = harness()
    await lock(h.trx, input())
    expect(h.calls).toHaveLength(8)
    expect(h.calls[3].sql).toContain('LOCK TABLE meta_bases, meta_sheets, meta_fields,')
    expect(h.calls[3].sql).toContain('plugin_multitable_object_registry, integration_stock_prep_pack_installs IN SHARE MODE NOWAIT')
    expect(h.calls[4].sql).toContain('count(DISTINCT c.relnamespace) = 1')
    expect(h.calls[5].params).toEqual([input().sheetId])
    expect(h.calls[6].params).toEqual([baseId])
    expect(h.calls[7].sql).toContain('FOR SHARE NOWAIT')
    expect(h.calls[7].params).toEqual([JSON.stringify({ id: input().sheetId }), JSON.stringify({ id: baseId }),
      JSON.stringify({ tenantId: input().tenantId, projectId: input().projectId, objectId: input().objectId })])
  })
  it('captures input before awaiting, accepts a plain null prototype', async () => {
    const supplied = Object.assign(Object.create(null) as AutomationReadMaterialEpochInput, input())
    const h = harness(fixture(), { onQuery(sql) { if (sql.includes('current_setting')) supplied.sheetId = 'changed' } })
    expect(await lock(h.trx, supplied)).toMatchObject({ baseId })
    expect(h.calls[5].params).toEqual([input().sheetId])
  })
  it.each([null, {}, [], { ...input(), workspaceId: '' }, { ...input(), extra: true },
    { ...input(), sheetId: '' }, { ...input(), projectId: ' project' }, { ...input(), tenantId: null },
    { ...input(), objectId: 'object\n' }])('rejects malformed input %# before SQL', async value => {
    const h = harness()
    await refused(lock(h.trx, value as AutomationReadMaterialEpochInput), 'AUTOMATION_MATERIAL_INPUT_INVALID')
    expect(h.calls).toEqual([])
  })
  it('rejects getter, toJSON, symbols and hidden data without invoking hooks', async () => {
    let hooks = 0
    const getter = input(); Object.defineProperty(getter, 'sheetId', { enumerable: true, get() { hooks++; return input().sheetId } })
    const serializer = input(); Object.defineProperty(serializer, 'toJSON', { value() { hooks++; return input() } })
    const symbol = input(); Object.defineProperty(symbol, Symbol('hidden'), { value: true })
    const hidden = input(); Object.defineProperty(hidden, 'sheetId', { enumerable: false })
    for (const supplied of [getter, serializer, symbol, hidden]) {
      const h = harness()
      await refused(lock(h.trx, supplied), 'AUTOMATION_MATERIAL_INPUT_INVALID')
      expect(h.calls).toEqual([])
    }
    expect(hooks).toBe(0)
  })
  it.each(['repeatable read', 'serializable', null])('requires RC, not %s', async isolation => {
    await refused(lock(harness(fixture({ isolation })).trx, input()), 'AUTOMATION_MATERIAL_TRANSACTION_REQUIRED')
  })
  it('rejects actual autocommit xid change, independent of a forged marker', async () => {
    const h = harness(fixture({ xids: ['100', '101'] }))
    Object.assign(h.trx, { isTransaction: true })
    await refused(lock(h.trx, input()), 'AUTOMATION_MATERIAL_TRANSACTION_REQUIRED')
    expect(h.calls.some(call => call.sql.startsWith('LOCK'))).toBe(false)
  })
  it.each(['LOCK TABLE', 'pg_catalog.pg_class', 'FROM meta_sheets', 'FROM meta_bases', 'FROM automation_read_material_epochs'])(
    'sanitizes missing schema/lock/driver error at %s', async failAt => {
      await refused(lock(harness(fixture(), { failAt }).trx, input()), unavailable)
    },
  )
  it.each([[], [{ consistent: false }], [{ consistent: null }], [{ consistent: true }, { consistent: true }]].map(schemas => ({ schemas })))(
    'rejects missing/mixed/RLS schemas %#', async ({ schemas }) => {
      await refused(lock(harness(fixture({ schemas })).trx, input()), unavailable)
    },
  )
  it.each(['sheet', 'base'])('requires current live %s and a persistent epoch', async kind => {
    const absent = fixture(); absent[kind === 'sheet' ? 'sheets' : 'bases'] = []
    const deleted = fixture(); deleted[kind === 'sheet' ? 'sheets' : 'bases'][0].deleted_at = 'synthetic-time'
    const foreign = fixture(); foreign[kind === 'sheet' ? 'sheets' : 'bases'][0].id = 'foreign'
    const noEpoch = fixture(); noEpoch.epochs = noEpoch.epochs.filter(row => row.kind !== kind)
    for (const f of [absent, deleted, foreign, noEpoch]) await refused(lock(harness(f).trx, input()), denied)
  })
  it.each([null, '', ' base'])('rejects malformed actual sheet base %#', async base => {
    const f = fixture(); f.sheets[0].base_id = base
    await refused(lock(harness(f).trx, input()), denied)
  })
  it.each(['kind', 'scope', 'duplicate'])('does not accept wrong returned epoch %s', async change => {
    const f = fixture()
    if (change === 'kind') f.epochs[0].kind = 'foreign'
    if (change === 'scope') f.epochs[0].scope = { id: 'foreign' }
    if (change === 'duplicate') f.epochs.push({ ...f.epochs[0] })
    await refused(lock(harness(f).trx, input()), denied)
  })
  it.each([null, '', 'invalid', revision.toUpperCase()])('rejects malformed revision %#', async value => {
    const f = fixture(); f.epochs[0].revision = value
    await refused(lock(harness(f).trx, input()), unavailable)
  })
  it('never executes database epoch/scope getters or serialization hooks', async () => {
    let hooks = 0
    const first = fixture(); Object.defineProperty(first.epochs[0], 'revision', { enumerable: true, get() { hooks++; return revision } })
    const second = fixture(); Object.defineProperty(second.epochs[0].scope as object, 'id', { enumerable: true, get() { hooks++; return input().sheetId } })
    const third = fixture(); Object.defineProperty(third.epochs[0].scope as object, 'toJSON', { value() { hooks++; return { id: input().sheetId } } })
    for (const f of [first, second, third]) await refused(lock(harness(f).trx, input()), unavailable)
    expect(hooks).toBe(0)
  })
})
