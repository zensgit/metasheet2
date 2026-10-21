import { describe, expect, it, vi } from 'vitest'
import { createAutomationReadRecordConditions, type AutomationReadRecordConditionEvent,
  type LockedAutomationReadRecordConditions } from '../../../src/integration/automation-read-record-conditions'
import type { Queryable } from '../../../src/multitable/automation-durable-dispatcher'

const scope = { actorId: 'synthetic-owner', ruleId: 'synthetic-rule', sheetId: 'synthetic-sheet', baseId: 'synthetic-base' }
const revision = '11111111-1111-4111-8111-111111111111'
const nextRevision = '22222222-2222-4222-8222-222222222222'
const event: AutomationReadRecordConditionEvent = { outboxId: 'synthetic-outbox', eventId: 'synthetic-event', eventType: 'multitable.record.created' }
const ast = (ids = ['text']) => ({ conjunction: 'AND', conditions: ids.map(fieldId => ({ fieldId, operator: 'equals', value: 'yes' })) })
const factory = () => createAutomationReadRecordConditions({ businessTimeZone: 'Asia/Shanghai' })
type Row = Record<string, unknown>

// Real schema/rule/ACL/compiler functions consume the fixture receipts. This proves query/control
// contracts, NOT PG locks, trigger enforcement or mathematical JSONB comparisons (real-PG covers those).
function fixture() {
  const state = { xid: '123', schema: revision, rule: revision, trigger: 'record.created', triggerConfig: {} as unknown,
    conditions: JSON.stringify(ast()), conditionExact: true, propertyExact: true, imageExact: true,
    conditionOversized: false, held: true, schemaBusy: false, read: true, admin: false, rowMode: false,
    fields: [{ id: 'text', sheet_id: scope.sheetId, type: 'string', property_json: '{}', property_oversized: false }] as Row[],
    fieldScopes: [] as Row[], projected: '{"text":"yes"}', identity: true, imagePresent: true,
    failAt: '', errorCode: '55P03', before: undefined as ((sql: string) => void) | undefined }
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params }); state.before?.(sql)
    if (state.failAt && sql.includes(state.failAt)) throw Object.assign(new Error('synthetic-private-value'), { code: state.errorCode })
    if (state.schemaBusy && sql.startsWith('LOCK TABLE meta_sheets,')) throw Object.assign(new Error('synthetic-private-value'), { code: '55P03' })
    let rows: Row[]
    if (sql.includes('current_setting')) rows = [{ isolation: 'read committed' }]
    else if (sql.includes('pg_current_xact_id')) rows = [{ xid: state.xid }]
    else if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT|LOCK TABLE) /u.test(sql)) rows = []
    else if (sql.includes('pg_catalog.pg_locks')) rows = [{ held: state.held }]
    else if (sql.includes('AS consistent')) rows = [{ consistent: true }]
    else if (sql.includes('SELECT revision FROM automation_read_material_epochs')) rows = [{ revision: state.schema }]
    else if (sql.includes('FROM meta_bases')) rows = [{ id: scope.baseId, deleted_at: null }]
    else if (sql.includes('AS raw_rule')) rows = [{ raw_rule: {
      id: scope.ruleId, sheet_id: scope.sheetId, name: 'Synthetic', created_by: scope.actorId, enabled: true,
      integration_authority_revision: state.rule, trigger_type: state.trigger, trigger_config: state.triggerConfig,
      action_type: 'integration_read_preview', action_config: { operation: 'plm.stock-preparation.diff-preview.v1', allowManual: false },
      conditions: JSON.parse(state.conditions) as unknown, actions: null, execution_mode: 'legacy',
      created_at: '2026-10-01T00:00:00.000000Z', updated_at: '2026-10-01T00:00:00.000000Z',
    } }]
    else if (sql.includes('AS conditions_json')) rows = [{ rule_revision: state.rule, conditions_json: state.conditionOversized ? null : state.conditions,
      conditions_oversized: state.conditionOversized }]
    else if (sql.includes('SELECT conditions=$2::jsonb AS exact')) rows = [{ exact: state.conditionExact }]
    else if (sql.includes('FROM meta_fields') && sql.includes('AS exact')) rows = [{ exact: state.propertyExact }]
    else if (sql.includes('FROM meta_fields')) rows = state.fields.filter(field => (params[1] as string[]).includes(String(field.id)))
    else if (sql.startsWith('SELECT role, permissions')) rows = [{ role: state.admin ? 'admin' : 'user', permissions: [], is_active: true, rbac_admin: state.admin }]
    else if (sql.includes('AS effective_permissions')) rows = state.read ? [{ code: 'multitable:read' }] : []
    else if (sql.includes('FROM spreadsheet_permissions')) rows = []
    else if (sql.includes('FROM field_permissions')) rows = state.fieldScopes
    else if (sql.includes('AS identity_valid')) rows = state.imagePresent ? [{ identity_valid: state.identity, projected_json: state.projected }] : []
    else if (sql.includes('SELECT p.projected=$3::jsonb AS exact')) rows = [{ exact: state.imageExact }]
    else if (sql.includes('FROM meta_sheets') && sql.includes('base_id =')) rows = []
    else if (sql.includes('FROM meta_sheets')) {
      rows = sql === 'SELECT id, deleted_at FROM meta_sheets WHERE id = $1'
        ? [{ id: scope.sheetId, deleted_at: null }]
        : [{ id: scope.sheetId, base_id: scope.baseId, deleted_at: null, row_level_read_permissions_enabled: state.rowMode }]
    } else throw new Error('Unexpected conditions fixture SQL')
    return { rows, rowCount: rows.length }
  })
  const trx: Queryable = { query }
  return { state, calls, query, trx }
}

describe('private record condition context — real helpers, synthetic SQL receipts', () => {
  it.each(['', ' padded ', 'UTC+08:00', 'invalid/timezone'])('requires an already resolved valid business zone %s', businessTimeZone => {
    expect(() => createAutomationReadRecordConditions({ businessTimeZone })).toThrow('AUTOMATION_READ_RECORD_CONDITIONS_INPUT_INVALID')
  })
  it('does not invoke factory/input accessors or accept extra keys', async () => {
    const hook = vi.fn(() => 'Asia/Shanghai')
    expect(() => createAutomationReadRecordConditions(Object.defineProperty({}, 'businessTimeZone', { enumerable: true, get: hook }) as never)).toThrow('INPUT_INVALID')
    const f = fixture()
    await expect(factory().lock(f.trx, { ...scope, extra: true } as never)).rejects.toThrow('INPUT_INVALID')
    await expect(factory().lock(f.trx, Object.defineProperty({ ...scope }, 'sheetId', { enumerable: true, get: hook }))).rejects.toThrow('INPUT_INVALID')
    expect(hook).not.toHaveBeenCalled(); expect(f.calls).toEqual([])
  })
  it('locks metadata before rule, all finite field ACLs before compile, and freezes only public references', async () => {
    const f = fixture(), port = factory()
    const context = await port.lock(f.trx, scope)
    expect(Object.keys(context).sort()).toEqual(['fieldIds', 'fingerprint', 'ruleRevision', 'schemaRevision', 'scope'])
    expect(context).toEqual({ scope, fieldIds: ['text'], ruleRevision: revision, schemaRevision: revision, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(Object.isFrozen(context)).toBe(true); expect(Object.isFrozen(context.scope)).toBe(true); expect(Object.isFrozen(context.fieldIds)).toBe(true)
    const sql = f.calls.map(call => call.sql)
    expect(sql.findIndex(value => value.startsWith('LOCK TABLE meta_sheets,'))).toBeLessThan(sql.findIndex(value => value.includes('AS raw_rule')))
    expect(sql.some(value => /\bmeta_records\b/u.test(value))).toBe(false)
    expect(await port.evaluate(f.trx, context, event)).toEqual({ kind: 'match' })
    expect(f.calls.find(call => call.sql.includes('AS identity_valid'))?.params).toEqual([event.outboxId, event.eventId, event.eventType, ['text'], scope.sheetId, revision])
  })
  it('captures scope before the first await, ignoring caller mutations', async () => {
    const f = fixture(), input = { ...scope }
    f.state.before = () => { input.ruleId = 'foreign'; input.sheetId = 'foreign' }
    expect((await factory().lock(f.trx, input)).scope).toEqual(scope)
  })
  it.each(['record.deleted', 'record.field.value_changed', 'schedule.cron'])('rejects unsupported rule %s', trigger => {
    const f = fixture(); f.state.trigger = trigger
    return expect(factory().lock(f.trx, scope)).rejects.toThrow('DENIED')
  })
  it.each([null, {}, { fieldId: 'text' }])('requires nonnull conditions and empty trigger config %#', async triggerConfig => {
    const f = fixture(); f.state.triggerConfig = triggerConfig
    if (triggerConfig === null || Object.keys(triggerConfig).length === 0) f.state.conditions = 'null'
    await expect(factory().lock(f.trx, scope)).rejects.toThrow('DENIED')
  })
  it('accepts updated with empty trigger config, but requires its exact event family', async () => {
    const f = fixture(), port = factory(); f.state.trigger = 'record.updated'
    const context = await port.lock(f.trx, scope)
    expect(await port.evaluate(f.trx, context, event)).toEqual({ kind: 'unreadable', reason: 'AFTER_IMAGE_UNAVAILABLE' })
    expect(await port.evaluate(f.trx, context, { ...event, eventType: 'multitable.record.updated' })).toEqual({ kind: 'match' })
  })
  it.each(['conditionExact', 'propertyExact', 'conditionOversized'] as const)('requires exact bounded PG metadata receipt %s', async key => {
    const f = fixture(); f.state[key] = key === 'conditionOversized'
    await expect(factory().lock(f.trx, scope)).rejects.toThrow('DENIED')
  })
  it('rejects aggregate property text over 128KiB without treating ignored metadata as free', async () => {
    const f = fixture(); f.state.conditions = JSON.stringify(ast(['a', 'b', 'c']))
    f.state.fields = ['a', 'b', 'c'].map(id => ({ id, sheet_id: scope.sheetId, type: 'string', property_json: JSON.stringify({ ignored: 'x'.repeat(50000) }), property_oversized: false }))
    await expect(factory().lock(f.trx, scope)).rejects.toThrow('DENIED')
  })
  it.each(['missing', 'hidden', 'no-read', 'row-scope', 'unsupported'])('rejects finite field read failure %s', async kind => {
    const f = fixture()
    if (kind === 'missing') f.state.fields = []
    if (kind === 'hidden') f.state.fieldScopes = [{ field_id: 'text', visible: false, read_only: false }]
    if (kind === 'no-read') f.state.read = false
    if (kind === 'row-scope') f.state.rowMode = true
    if (kind === 'unsupported') f.state.fields[0].type = 'formula'
    await expect(factory().lock(f.trx, scope)).rejects.toThrow('DENIED')
  })
  it('does not substitute write permission: a visible readonly condition field is readable', async () => {
    const f = fixture(); f.state.fieldScopes = [{ field_id: 'text', visible: true, read_only: true }]
    await expect(factory().lock(f.trx, scope)).resolves.toHaveProperty('fieldIds', ['text'])
  })
  it('schema busy does not produce an apparently prepared context or late recapture', async () => {
    const f = fixture(); f.state.schemaBusy = true
    await expect(factory().lock(f.trx, scope)).rejects.toThrow('DENIED')
    expect(f.calls.filter(call => call.sql.startsWith('LOCK TABLE meta_sheets,'))).toHaveLength(1)
    expect(f.calls.some(call => call.sql.includes('AS raw_rule'))).toBe(false)
  })
  it.each(['rule', 'schema'] as const)('does not adopt an own-transaction %s revision change during preparation', async kind => {
    const f = fixture()
    f.state.before = sql => { if (sql.includes("SELECT COALESCE(NULLIF(property,")) f.state[kind] = nextRevision }
    await expect(factory().lock(f.trx, scope)).rejects.toThrow('DENIED')
  })
  it('captures business timezone without consulting a replacement factory option or ambient environment', async () => {
    const f = fixture(), options = { businessTimeZone: 'Asia/Tokyo' }, port = createAutomationReadRecordConditions(options)
    options.businessTimeZone = 'America/New_York'
    f.state.fields[0].type = 'dateTime'; f.state.fields[0].property_json = '{"timezone":"UTC"}'
    f.state.conditions = JSON.stringify({ conjunction: 'AND', conditions: [{ fieldId: 'text', operator: 'equals', value: '2026-10-01 09:00' }] })
    f.state.projected = '{"text":"2026-10-01T00:00:00Z"}'
    expect(await port.evaluate(f.trx, await port.lock(f.trx, scope), event)).toEqual({ kind: 'match' })
  })
  it('does not allow copied contexts, another instance, or another handle to use private compiled material', async () => {
    const f = fixture(), port = factory(), context = await port.lock(f.trx, scope)
    const before = f.calls.length
    for (const candidate of [{ ...context }, JSON.parse(JSON.stringify(context)) as LockedAutomationReadRecordConditions]) {
      expect(await port.evaluate(f.trx, candidate, event)).toEqual({ kind: 'unreadable', reason: 'CONTEXT_INVALID' })
    }
    expect(await factory().evaluate(f.trx, context, event)).toEqual({ kind: 'unreadable', reason: 'CONTEXT_INVALID' })
    expect(await port.evaluate({ query: f.query }, context, event)).toEqual({ kind: 'unreadable', reason: 'CONTEXT_INVALID' })
    expect(f.calls).toHaveLength(before)
  })
  it('captures event identity before the first await and never invokes event accessors', async () => {
    const f = fixture(), port = factory(), context = await port.lock(f.trx, scope), mutable = { ...event }
    f.state.before = () => { mutable.outboxId = 'foreign'; mutable.eventId = 'foreign' }
    expect(await port.evaluate(f.trx, context, mutable)).toEqual({ kind: 'match' })
    expect(f.calls.find(call => call.sql.includes('AS identity_valid'))?.params.slice(0, 3)).toEqual([event.outboxId, event.eventId, event.eventType])
    const hook = vi.fn(() => event.eventId), before = f.calls.length
    await expect(port.evaluate(f.trx, context, Object.defineProperty({ ...event }, 'eventId', { enumerable: true, get: hook }))).rejects.toThrow('INPUT_INVALID')
    expect(hook).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(before)
  })
  it.each(['xid', 'schema', 'rule', 'locks'] as const)('fails closed on changed context %s without reading the after-image', async kind => {
    const f = fixture(), port = factory(), context = await port.lock(f.trx, scope)
    if (kind === 'xid') f.state.xid = '124'
    if (kind === 'schema') f.state.schema = nextRevision
    if (kind === 'rule') f.state.rule = nextRevision
    if (kind === 'locks') f.state.held = false
    expect(await port.evaluate(f.trx, context, event)).toEqual({ kind: 'unreadable', reason: kind === 'xid' ? 'CONTEXT_INVALID' : kind === 'rule' ? 'RULE_CHANGED' : 'SCHEMA_CHANGED' })
    expect(f.calls.some(call => call.sql.includes('AS identity_valid'))).toBe(false)
  })
  it.each(['absent', 'identity', 'precision', 'missing', 'bad-typed', 'no-match', 'null'])('handles after-image semantic state %s', async kind => {
    const f = fixture(), port = factory(), context = await port.lock(f.trx, scope)
    if (kind === 'absent') f.state.imagePresent = false
    if (kind === 'identity') f.state.identity = false
    if (kind === 'precision') f.state.imageExact = false
    if (kind === 'missing') f.state.projected = '{}'
    if (kind === 'bad-typed') f.state.projected = '{"text":123}'
    if (kind === 'no-match') f.state.projected = '{"text":"no"}'
    if (kind === 'null') f.state.projected = '{"text":null}'
    expect(await port.evaluate(f.trx, context, event)).toEqual(kind === 'no-match' || kind === 'null'
      ? { kind: 'no_match' } : { kind: 'unreadable', reason: kind === 'absent' || kind === 'identity' ? 'AFTER_IMAGE_UNAVAILABLE' : 'VALUE_UNREADABLE' })
  })
  it.each(['hidden', 'no-read'])('rechecks current field read access after preparation: %s', async kind => {
    const f = fixture(), port = factory(), context = await port.lock(f.trx, scope)
    if (kind === 'hidden') f.state.fieldScopes = [{ field_id: 'text', visible: false, read_only: false }]
    else f.state.read = false
    expect(await port.evaluate(f.trx, context, event)).toEqual({ kind: 'unreadable', reason: 'FIELD_ACCESS_DENIED' })
    expect(f.calls.some(call => call.sql.includes('AS identity_valid'))).toBe(false)
    expect(f.calls.filter(call => call.sql.includes('FROM field_permissions')).length).toBeGreaterThanOrEqual(kind === 'hidden' ? 2 : 1)
  })
  it('does not convert SQL failure in the current ACL recheck into an ACK-able denial', async () => {
    const f = fixture(), port = factory(), context = await port.lock(f.trx, scope)
    f.state.failAt = 'FROM field_permissions'
    await expect(port.evaluate(f.trx, context, event)).rejects.toMatchObject({
      code: 'AUTOMATION_READ_RECORD_CONDITIONS_UNAVAILABLE', message: 'AUTOMATION_READ_RECORD_CONDITIONS_UNAVAILABLE',
    })
    expect(f.calls.some(call => call.sql.includes('AS identity_valid'))).toBe(false)
  })
  it.each(['AS identity_valid', 'SELECT p.projected=', 'pg_current_xact_id'])('SQL failures are fixed thrown unavailability, never ACK-able unreadable: %s', async failAt => {
    const f = fixture(), port = factory(), context = await port.lock(f.trx, scope)
    f.state.failAt = failAt
    const failure = await port.evaluate(f.trx, context, event).catch(error => error as unknown)
    expect(failure).toMatchObject({ code: 'AUTOMATION_READ_RECORD_CONDITIONS_UNAVAILABLE', message: 'AUTOMATION_READ_RECORD_CONDITIONS_UNAVAILABLE' })
    expect(failure).not.toHaveProperty('cause'); expect(String(failure)).not.toContain('synthetic-private-value')
  })
})
