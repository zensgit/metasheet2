import { describe, expect, it, vi } from 'vitest'
import { checkedReadDateFieldConfirmation, checkedReadDateScheduleConfig, createAutomationReadDateSchedule,
  type AutomationReadDateSchedulePageInput } from '../../../src/integration/automation-read-date-schedule'
import type { Queryable } from '../../../src/multitable/automation-durable-dispatcher'

const scope = { actorId: 'synthetic-owner', ruleId: 'synthetic-rule', sheetId: 'synthetic-sheet', baseId: 'synthetic-base' }
const revision = '11111111-1111-4111-8111-111111111111'
const nextRevision = '22222222-2222-4222-8222-222222222222'
const now = Date.parse('2026-10-02T10:00:00.000Z')
const config = () => ({ dateFieldId: 'deadline', offsetDays: 0, direction: 'after' as const })
type Row = Record<string, unknown>

// Actual schema/rule/field ACL helpers consume synthetic SQL receipts. These
// tests do NOT prove real PG locks, live RBAC or durable date admission.
function fixture() {
  const state = { xid: '123', schema: revision, rule: revision, trigger: 'schedule.date_field',
    config: config() as unknown, conditions: null as unknown, createdAt: Date.parse('2026-09-01T00:00:00.000Z'),
    held: true, schemaBusy: false, read: true, admin: false, rowMode: false, now: now as number | string,
    fields: [{ id: 'deadline', sheet_id: scope.sheetId, type: 'date', property_json: '{}', property_oversized: false }] as Row[],
    fieldScopes: [] as Row[], records: [{ id: 'record-a', date_value: '2026-10-02' }] as Row[],
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
      integration_authority_revision: state.rule, trigger_type: state.trigger, trigger_config: state.config,
      action_type: 'integration_read_preview', action_config: { operation: 'plm.stock-preparation.diff-preview.v1', allowManual: false },
      conditions: state.conditions, actions: null, execution_mode: 'legacy',
      created_at: '2026-09-01T00:00:00.000000Z', updated_at: '2026-09-01T00:00:00.000000Z',
    } }]
    else if (sql.includes('AS created_at_ms')) rows = [{ created_at_ms: String(state.createdAt) }]
    else if (sql.includes('AS now_ms')) rows = [{ now_ms: state.now }]
    else if (sql.includes('FROM meta_fields')) rows = state.fields.filter(field => (params[1] as string[]).includes(String(field.id)))
    else if (sql.startsWith('SELECT role, permissions')) rows = [{ role: state.admin ? 'admin' : 'user', permissions: [], is_active: true, rbac_admin: state.admin }]
    else if (sql.includes('AS effective_permissions')) rows = state.read ? [{ code: 'multitable:read' }] : []
    else if (sql.includes('FROM spreadsheet_permissions')) rows = []
    else if (sql.includes('FROM field_permissions')) rows = state.fieldScopes
    else if (sql.includes('FROM meta_records r')) {
      const after = params[2] as string | null
      const candidates = state.records.filter(row => after === null || String(row.id) > after)
      rows = sql.includes('AS date_value') ? candidates.slice(0, Number(params[5]))
        : candidates.slice(0, 1).map(row => ({ id: row.id }))
    } else if (sql.includes('FROM meta_sheets') && sql.includes('base_id =')) rows = []
    else if (sql.includes('FROM meta_sheets')) {
      rows = sql === 'SELECT id, deleted_at FROM meta_sheets WHERE id = $1'
        ? [{ id: scope.sheetId, deleted_at: null }]
        : [{ id: scope.sheetId, base_id: scope.baseId, deleted_at: null, row_level_read_permissions_enabled: state.rowMode }]
    } else throw new Error('Unexpected date schedule fixture SQL')
    return { rows, rowCount: rows.length }
  })
  const trx: Queryable = { query }
  const port = createAutomationReadDateSchedule()
  const input = (overrides: Partial<AutomationReadDateSchedulePageInput> = {}): AutomationReadDateSchedulePageInput => ({
    limit: 100, scanAtMs: now, activatedAt: '2026-09-30T00:00:00.000Z', signal: new AbortController().signal, ...overrides,
  })
  const valueQueries = () => calls.filter(call => call.sql.includes('AS date_value'))
  return { state, calls, query, trx, port, input, valueQueries }
}

describe('date schedule closed metadata and config', () => {
  it('freezes exact config without adding defaults or interpreting legacy scanIntervalMs', () => {
    const raw = { ...config(), scanIntervalMs: 1, effectiveAt: '2026-09-30T00:00:00.000001Z' }
    const checked = checkedReadDateScheduleConfig(raw)
    expect(checked).toEqual(raw); expect(Object.isFrozen(checked)).toBe(true)
    expect(checked).not.toHaveProperty('timezone'); expect(checked).not.toHaveProperty('timeOfDay')
    expect(checkedReadDateScheduleConfig({ ...config(), scanIntervalMs: Number.MAX_SAFE_INTEGER })).toHaveProperty('scanIntervalMs', Number.MAX_SAFE_INTEGER)
    raw.offsetDays = 9
    expect(checked.offsetDays).toBe(0)
  })
  it.each([
    { offsetDays: -1 }, { offsetDays: 36501 }, { offsetDays: 0.1 }, { offsetDays: NaN },
    { direction: 'AFTER' }, { dateFieldId: ' padded ' }, { timeOfDay: '9:00' }, { timeOfDay: '24:00' },
    { timezone: 'not/a-zone' }, { timezone: ' UTC' }, { timezone: undefined },
    { scanIntervalMs: 0 }, { scanIntervalMs: 1.1 }, { scanIntervalMs: Number.MAX_SAFE_INTEGER + 1 },
    { effectiveAt: '2026-02-29T00:00:00Z' }, { effectiveAt: '2026-10-02T00:00:00' },
    { effectiveAt: '0099-10-02T00:00:00Z' }, { effectiveAt: '2026-10-02T00:00:00-00:00' },
    { effectiveAt: '2026-10-02T00:00:00+14:01' }, { extra: true },
  ])('rejects malformed persisted config %# without fallback', patch => {
    expect(() => checkedReadDateScheduleConfig({ ...config(), ...patch })).toThrow('AUTOMATION_READ_INPUT_INVALID')
  })
  it('rejects accessors, symbols, hidden keys and nonplain config without invoking hooks', () => {
    const hook = vi.fn(() => 0)
    for (const value of [Object.defineProperty(config(), 'offsetDays', { enumerable: true, get: hook }),
      { ...config(), [Symbol('extra')]: 1 }, Object.defineProperty(config(), 'secret', { value: true }),
      Object.assign(Object.create({ inherited: true }) as object, config())]) {
      expect(() => checkedReadDateScheduleConfig(value)).toThrow('AUTOMATION_READ_INPUT_INVALID')
    }
    expect(hook).not.toHaveBeenCalled()
  })
  it('closes field confirmation to a stored native date type and lowercase schema nonce', () => {
    const value = { fieldId: 'deadline', fieldType: 'date', schemaRevision: revision }
    expect(checkedReadDateFieldConfirmation(value)).toEqual(value)
    expect(Object.isFrozen(checkedReadDateFieldConfirmation(value))).toBe(true)
    for (const patch of [{ fieldType: 'datetime' }, { fieldId: '' }, { schemaRevision: 'not-a-nonce' }, { extra: true }]) {
      expect(() => checkedReadDateFieldConfirmation({ ...value, ...patch })).toThrow('AUTOMATION_READ_INPUT_INVALID')
    }
    const hook = vi.fn(() => 'deadline')
    expect(() => checkedReadDateFieldConfirmation(Object.defineProperty(value, 'fieldId', { enumerable: true, get: hook }))).toThrow('INPUT_INVALID')
    expect(hook).not.toHaveBeenCalled()
  })
})

describe('date schedule private proof — actual helpers, synthetic SQL receipts', () => {
  it('locks field/read/schema metadata without reading records or adding scope properties', async () => {
    const f = fixture(), context = await f.port.lock(f.trx, scope)
    expect(context).toEqual({ scope, ruleRevision: revision, config: config(),
      dateField: { fieldId: 'deadline', fieldType: 'date', schemaRevision: revision }, createdAtMs: f.state.createdAt })
    expect(Object.isFrozen(context)).toBe(true); expect(Object.isFrozen(context.scope)).toBe(true)
    expect(Object.isFrozen(context.config)).toBe(true); expect(Object.isFrozen(context.dateField)).toBe(true)
    expect(f.calls.some(call => /\bmeta_records\b/u.test(call.sql))).toBe(false)
    expect(f.calls.some(call => call.sql.startsWith('LOCK TABLE users, user_roles'))).toBe(true)
    expect(f.calls.findIndex(call => call.sql.startsWith('LOCK TABLE meta_sheets,')))
      .toBeLessThan(f.calls.findIndex(call => call.sql.includes('AS raw_rule')))
  })
  it('captures caller scope before awaiting and rejects a scope accessor without any query', async () => {
    const f = fixture(), mutable = { ...scope }
    f.state.before = () => { mutable.sheetId = 'foreign' }
    expect((await f.port.lock(f.trx, mutable)).scope.sheetId).toBe(scope.sheetId)
    const hook = vi.fn(() => scope.sheetId), before = f.calls.length
    await expect(f.port.lock(f.trx, Object.defineProperty({ ...scope }, 'sheetId', { enumerable: true, get: hook }))).rejects.toThrow('INPUT_INVALID')
    expect(hook).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(before)
  })
  it.each(['wrong-trigger', 'conditions', 'missing', 'retyped', 'alias', 'hidden', 'no-read', 'row-mode', 'mirror'])(
    'rejects metadata/permission denial %s before record values', async kind => {
      const f = fixture()
      if (kind === 'wrong-trigger') f.state.trigger = 'schedule.cron'
      if (kind === 'conditions') f.state.conditions = {}
      if (kind === 'missing') f.state.fields = []
      if (kind === 'retyped') f.state.fields[0].type = 'string'
      if (kind === 'alias') f.state.fields[0].type = 'datetime'
      if (kind === 'hidden') f.state.fieldScopes = [{ field_id: 'deadline', visible: false, read_only: false }]
      if (kind === 'no-read') f.state.read = false
      if (kind === 'row-mode') f.state.rowMode = true
      if (kind === 'mirror') f.state.fields[0].property_json = '{"mirrorOf":"other"}'
      await expect(f.port.lock(f.trx, scope)).rejects.toThrow('DENIED')
      expect(f.valueQueries()).toEqual([])
    })
  it('retains current admin row bypass but not hidden field bypass; readonly fields are readable', async () => {
    const f = fixture(); f.state.admin = true; f.state.rowMode = true
    f.state.fieldScopes = [{ field_id: 'deadline', visible: true, read_only: true }]
    await expect(f.port.lock(f.trx, scope)).resolves.toHaveProperty('dateField.fieldType', 'date')
    f.state.fieldScopes[0].visible = false
    await expect(f.port.lock(f.trx, scope)).rejects.toThrow('DENIED')
  })
  it('schema NOWAIT conflict is unavailable, not permission or a usable null-schema context', async () => {
    const f = fixture(); f.state.schemaBusy = true
    await expect(f.port.lock(f.trx, scope)).rejects.toThrow('AUTOMATION_READ_UNAVAILABLE')
    expect(f.calls.some(call => call.sql === 'ROLLBACK TO SAVEPOINT automation_record_schema_capture')).toBe(true)
    expect(f.valueQueries()).toEqual([])
  })
  it('returns only opaque due proofs and guarded facts, with a bounded locking single-field projection', async () => {
    const f = fixture(), context = await f.port.lock(f.trx, scope)
    const page = await f.port.page(f.trx, context, f.input())
    expect(page).toMatchObject({ scanned: 1, nextCursor: null }); expect(page.items).toHaveLength(1)
    expect(Object.keys(page.items[0])).toEqual([]); expect(Object.isFrozen(page.items[0])).toBe(true)
    expect(await f.port.facts(f.trx, context, page.items[0])).toEqual({ recordId: 'record-a', occurrenceAt: '2026-10-02T09:00:00.000Z' })
    const statement = f.valueQueries()[0]
    expect(statement.params).toEqual([scope.sheetId, 'deadline', null, expect.any(String), expect.any(String), 100])
    expect(statement.sql).toContain('octet_length(r.data->>$2::text)<=64')
    expect(statement.sql).toContain('FOR SHARE OF r NOWAIT')
    expect(statement.sql).not.toMatch(/SELECT\s+[^]*r\.data\s*(?:,|FROM)/u)
    expect(JSON.stringify(page)).not.toContain('2026-10-02')
  })
  it('advances cursor over non-due/invalid candidates and lookahead transfers no 101st date', async () => {
    const f = fixture(); f.state.records = [{ id: 'a', date_value: 'invalid' }, { id: 'b', date_value: '2026-10-03' },
      { id: 'c', date_value: '2026-10-02' }]
    const context = await f.port.lock(f.trx, scope)
    const first = await f.port.page(f.trx, context, f.input({ limit: 2 }))
    expect(first).toEqual({ items: [], scanned: 2, nextCursor: 'b' })
    const lookahead = f.calls.find(call => call.sql.startsWith('SELECT r.id FROM meta_records'))
    expect(lookahead?.sql).not.toContain('AS date_value'); expect(lookahead?.params[2]).toBe('b')
    const second = await f.port.page(f.trx, context, f.input({ limit: 2, afterId: 'b' }))
    expect(second.scanned).toBe(1); expect(second.nextCursor).toBeNull()
    expect(await f.port.facts(f.trx, context, second.items[0])).toHaveProperty('recordId', 'c')
  })
  it('bounds a full page to 100 projected dates while preserving the last processed cursor', async () => {
    const f = fixture()
    f.state.records = Array.from({ length: 101 }, (_, index) => ({
      id: `record-${String(index).padStart(3, '0')}`, date_value: '2026-10-02',
    }))
    const context = await f.port.lock(f.trx, scope), page = await f.port.page(f.trx, context, f.input())
    expect(page.scanned).toBe(100); expect(page.items).toHaveLength(100); expect(page.nextCursor).toBe('record-099')
    expect(f.valueQueries()).toHaveLength(1)
    expect(f.valueQueries()[0].params[5]).toBe(100)
    expect(f.calls.filter(call => call.sql.startsWith('SELECT r.id FROM meta_records'))).toHaveLength(1)
  })
  it.each([NaN, Infinity, 'not-a-clock', 9e15])('rejects malformed DB time %s before projecting dates', async clock => {
    const f = fixture(), context = await f.port.lock(f.trx, scope)
    f.state.now = clock
    await expect(f.port.page(f.trx, context, f.input())).rejects.toThrow('UNAVAILABLE')
    expect(f.valueQueries()).toEqual([])
  })
  it('uses each page DB clock for the 48h lower bound, not a stale wake clock', async () => {
    const f = fixture(), context = await f.port.lock(f.trx, scope)
    f.state.now = now + 3 * 86400000
    expect(await f.port.page(f.trx, context, f.input())).toEqual({ items: [], scanned: 1, nextCursor: null })
    f.state.now = now - 1
    await expect(f.port.page(f.trx, context, f.input())).rejects.toThrow('UNAVAILABLE')
  })
  it.each(['cutover-equal', 'future', 'old', 'rule-created', 'effectiveAt'])(
    'filters due occurrence against %s without changing its identity', async kind => {
      const f = fixture()
      if (kind === 'future') f.state.records[0].date_value = '2026-10-03'
      if (kind === 'old') f.state.records[0].date_value = '2026-09-29'
      if (kind === 'rule-created') f.state.createdAt = now
      if (kind === 'effectiveAt') f.state.config = { ...config(), effectiveAt: '2026-10-02T10:00:00Z' }
      const context = await f.port.lock(f.trx, scope)
      const page = await f.port.page(f.trx, context, f.input(kind === 'cutover-equal'
        ? { activatedAt: '2026-10-02T09:00:00.000000Z' } : {}))
      expect(page.items).toEqual([])
    })
  it.each(['2026-02-29', '2026-02-30', '0099-10-02', '2026-10-02T00:00:00Z', ' 2026-10-02', null])(
    'strict date refuses rollover/instant/ambiguous value %s', async value => {
      const f = fixture(); f.state.records[0].date_value = value
      const context = await f.port.lock(f.trx, scope)
      expect((await f.port.page(f.trx, context, f.input())).items).toEqual([])
    })
  it.each(['2026-10-02', '2026-10-02T09:00:00', '2026-02-30T09:00:00Z', '2026-10-02T24:00:00Z',
    '2026-10-02T09:00:60Z', '2026-10-02T09:00:00-00:00', '2026-10-02T09:00:00+14:01'])(
    'strict dateTime refuses ambiguous/invalid instant %s', async value => {
      const f = fixture(); f.state.fields[0].type = 'dateTime'; f.state.records[0].date_value = value
      const context = await f.port.lock(f.trx, scope)
      expect((await f.port.page(f.trx, context, f.input())).items).toEqual([])
    })
  it('accepts a real leap day and keeps date floating under a negative-offset zone', async () => {
    const f = fixture(); f.state.config = { ...config(), timezone: 'America/New_York', timeOfDay: '09:00' }
    f.state.records[0].date_value = '2024-02-29'; f.state.createdAt = Date.parse('2024-02-01T00:00:00Z')
    f.state.now = Date.parse('2024-02-29T15:00:00Z')
    const context = await f.port.lock(f.trx, scope)
    const page = await f.port.page(f.trx, context, f.input({ scanAtMs: Number(f.state.now), activatedAt: '2024-02-28T00:00:00Z' }))
    expect(await f.port.facts(f.trx, context, page.items[0])).toHaveProperty('occurrenceAt', '2024-02-29T14:00:00.000Z')
  })
  it('explicit-offset dateTime uses its actual instant and same-day edits keep the occurrence', async () => {
    const f = fixture(); f.state.fields[0].type = 'dateTime'
    f.state.records = [{ id: 'a', date_value: '2026-10-02T01:00:00+01:00' }, { id: 'b', date_value: '2026-10-02T22:00:00Z' }]
    const context = await f.port.lock(f.trx, scope), page = await f.port.page(f.trx, context, f.input())
    const facts = await Promise.all(page.items.map(proof => f.port.facts(f.trx, context, proof)))
    expect(facts).toEqual([{ recordId: 'a', occurrenceAt: '2026-10-02T09:00:00.000Z' },
      { recordId: 'b', occurrenceAt: '2026-10-02T09:00:00.000Z' }])
  })
  it.each(['schema', 'rule', 'xid', 'locks', 'hidden', 'no-read', 'row-mode'])(
    'rechecks current %s before page values and before facts', async kind => {
      const f = fixture(), context = await f.port.lock(f.trx, scope), page = await f.port.page(f.trx, context, f.input())
      const before = f.valueQueries().length
      if (kind === 'schema') f.state.schema = nextRevision
      if (kind === 'rule') f.state.rule = nextRevision
      if (kind === 'xid') f.state.xid = '999'
      if (kind === 'locks') f.state.held = false
      if (kind === 'hidden') f.state.fieldScopes = [{ field_id: 'deadline', visible: false, read_only: false }]
      if (kind === 'no-read') f.state.read = false
      if (kind === 'row-mode') f.state.rowMode = true
      await expect(f.port.page(f.trx, context, f.input())).rejects.toBeInstanceOf(Error)
      await expect(f.port.facts(f.trx, context, page.items[0])).rejects.toBeInstanceOf(Error)
      expect(f.valueQueries()).toHaveLength(before)
    })
  it('does not accept copied proof/context, another factory, another handle or another same-t context', async () => {
    const f = fixture(), context = await f.port.lock(f.trx, scope), page = await f.port.page(f.trx, context, f.input())
    const before = f.calls.length
    await expect(f.port.page(f.trx, { ...context }, f.input())).rejects.toThrow('DENIED')
    await expect(f.port.facts(f.trx, context, { ...page.items[0] })).rejects.toThrow('DENIED')
    await expect(createAutomationReadDateSchedule().facts(f.trx, context, page.items[0])).rejects.toThrow('DENIED')
    await expect(f.port.facts({ query: f.query }, context, page.items[0])).rejects.toThrow('DENIED')
    expect(f.calls).toHaveLength(before)
    const second = await f.port.lock(f.trx, scope)
    await expect(f.port.facts(f.trx, second, page.items[0])).rejects.toThrow('DENIED')
  })
  it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { afterId: ' bad ' }, { scanAtMs: NaN },
    { activatedAt: '2026-02-30T00:00:00Z' }, { signal: {} }, { extra: true }])('closes page input %# before IO', async patch => {
    const f = fixture(), context = await f.port.lock(f.trx, scope), before = f.calls.length
    await expect(f.port.page(f.trx, context, { ...f.input(), ...patch } as never)).rejects.toThrow('INPUT_INVALID')
    expect(f.calls).toHaveLength(before)
  })
  it('abort before page or during metadata recheck starts no date-value query and hides arbitrary reason', async () => {
    for (const during of [false, true]) {
      const f = fixture(), context = await f.port.lock(f.trx, scope), controller = new AbortController()
      if (during) f.state.before = () => controller.abort('synthetic-private-value')
      else controller.abort('synthetic-private-value')
      await expect(f.port.page(f.trx, context, f.input({ signal: controller.signal }))).rejects.toThrow('AUTOMATION_READ_FENCE_LOST')
      expect(f.valueQueries()).toEqual([])
    }
  })
  it.each(['AS date_value', 'AS now_ms', 'FROM field_permissions', 'pg_current_xact_id'])(
    'SQL failure at %s stays fixed unavailability, never an empty successful page', async failAt => {
      const f = fixture(), context = await f.port.lock(f.trx, scope)
      f.state.failAt = failAt
      const error: unknown = await f.port.page(f.trx, context, f.input()).catch(error => error as unknown)
      expect(error).toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE', message: 'AUTOMATION_READ_UNAVAILABLE' })
      expect(error).not.toHaveProperty('cause'); expect(String(error)).not.toContain('synthetic-private-value')
    })
})
