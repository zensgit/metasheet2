import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AutomationRuleAuthorityError,
  lockAutomationReadRule,
  type AutomationReadRuleInput,
} from '../../../src/integration/automation-read-rule-authority'
import { canonicalizeConfig } from '../../../src/multitable/automation-action-idempotency'
import type { Queryable } from '../../../src/multitable/automation-durable-dispatcher'

type Row = Record<string, unknown>
type Fixture = {
  isolation: unknown
  xids: unknown[]
  bases: Row[]
  sheets: Row[]
  rules: Row[]
}
const scope = {
  actorId: 'synthetic-actor', ruleId: 'synthetic-rule',
  sheetId: 'synthetic-sheet', baseId: 'synthetic-base',
}
const revision = '00000000-0000-4000-8000-000000000001'
const nextRevision = '00000000-0000-4000-8000-000000000002'
const privateDetail = 'synthetic_private_sql_config_detail'

function rawRule(overrides: Row = {}): Row {
  return {
    id: scope.ruleId,
    sheet_id: scope.sheetId,
    name: 'Synthetic rule',
    trigger_type: 'record.created',
    trigger_config: { field: 'synthetic-field', extra: { untouched: true } },
    action_type: 'notify',
    action_config: { message: privateDetail, template: { fields: ['synthetic-field'] } },
    enabled: true,
    created_at: '2026-10-01T00:00:00.123456Z',
    updated_at: '2026-10-01T00:00:00.123456Z',
    created_by: scope.actorId,
    conditions: { all: [{ field: 'synthetic-field', op: 'eq', value: 1 }] },
    actions: [{ type: 'notify', config: { message: privateDetail } }],
    execution_mode: null,
    integration_authority_revision: revision,
    ...overrides,
  }
}

function fixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    isolation: 'read committed', xids: ['100', '100'],
    bases: [{ id: scope.baseId, deleted_at: null }],
    sheets: [{ id: scope.sheetId, base_id: scope.baseId, deleted_at: null }],
    rules: [{ raw_rule: rawRule() }],
    ...overrides,
  }
}

const tables = ['meta_bases', 'meta_sheets', 'automation_rules'] as const
const keys = ['bases', 'sheets', 'rules'] as const
function harness(data = fixture(), failure?: { at: string; code: string }) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let probes = 0
  const trx: Queryable = {
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (failure && sql.includes(failure.at)) {
        throw Object.assign(new Error(privateDetail), { code: failure.code, detail: privateDetail })
      }
      if (sql.includes('current_setting')) return { rows: [{ isolation: data.isolation }], rowCount: 1 }
      if (sql.includes('pg_current_xact_id')) return { rows: [{ xid: data.xids[probes++] }], rowCount: 1 }
      const index = tables.findIndex(table => new RegExp(`FROM ${table}\\s`).test(sql))
      if (index < 0) throw new Error('Unexpected query')
      const rows = data[keys[index]]
      return { rows, rowCount: rows.length }
    },
  }
  return { trx, calls }
}

async function lockRaw(raw: Row) {
  return lockAutomationReadRule(harness(fixture({ rules: [{ raw_rule: raw }] })).trx, scope)
}

async function expectDenied(data: Fixture) {
  await expect(lockAutomationReadRule(harness(data).trx, scope))
    .rejects.toMatchObject({ code: 'AUTOMATION_RULE_AUTHORITY_DENIED' })
}

describe('Automation read rule prerequisite (actual helper, query fixtures; not a PostgreSQL lock proof)', () => {
  it('returns a narrow private snapshot with exact persisted fields and a full raw-row digest', async () => {
    const raw = rawRule()
    const result = await lockRaw(raw)
    expect(result).toEqual({
      ruleId: scope.ruleId, sheetId: scope.sheetId, baseId: scope.baseId,
      createdBy: scope.actorId, authorityRevision: revision,
      fingerprint: createHash('sha256').update(canonicalizeConfig(raw)).digest('hex'),
      triggerType: raw.trigger_type, triggerConfig: raw.trigger_config,
      actionType: raw.action_type, actionConfig: raw.action_config,
      conditions: raw.conditions, actions: raw.actions, executionMode: raw.execution_mode,
    })
    expect(result).not.toHaveProperty('tenantId')
    expect(result).not.toHaveProperty('workspaceId')
    expect(result).not.toHaveProperty('rawRule')
  })

  it('preserves legacy null configs and arbitrary persisted trigger/action types without authorizing them', async () => {
    const result = await lockRaw(rawRule({ trigger_type: 'approval.task_created',
      action_type: 'send_dingtalk_approval_card', trigger_config: null, action_config: null,
      conditions: null, actions: null, execution_mode: 'workflow_job_v1' }))
    expect(result).toMatchObject({ triggerType: 'approval.task_created', actionType: 'send_dingtalk_approval_card',
      triggerConfig: null, actionConfig: null, conditions: null, actions: null, executionMode: 'workflow_job_v1' })
  })

  it('deeply copies and freezes exposed configuration, arrays, nested objects and the result', async () => {
    const raw = rawRule()
    const result = await lockRaw(raw)
    const frozen = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      expect(Object.isFrozen(value)).toBe(true)
      for (const item of Object.values(value)) frozen(item)
    }
    frozen(result)
    expect(result.triggerConfig).not.toBe(raw.trigger_config)
    expect(result.actions).not.toBe(raw.actions)
    expect(Reflect.set(result.actionConfig as object, 'message', 'changed')).toBe(false)
    const driverConfig = raw.action_config as Row
    driverConfig.message = 'driver-reference-mutated'
    expect(result.actionConfig).toMatchObject({ message: privateDetail })
  })

  const edits: Array<[string, unknown]> = [
    ['name', 'Renamed synthetic rule'],
    ['trigger_type', 'record.updated'],
    ['trigger_config', { field: 'different-synthetic-field' }],
    ['action_type', 'update_field'],
    ['action_config', { message: 'different' }],
    ['created_at', '2026-10-01T00:00:00.123457Z'],
    ['updated_at', '2026-10-01T00:00:00.123457Z'],
    ['conditions', { all: [] }],
    ['actions', [{ type: 'notify', config: { message: 'different' } }]],
    ['execution_mode', 'workflow_job_v1'],
    ['integration_authority_revision', nextRevision],
    ['future_rule_authority', { new: 'synthetic-column' }],
  ]
  it.each(edits)('changes its fingerprint for raw %s changes, including timestamp microseconds and future columns', async (key, value) => {
    const original = await lockRaw(rawRule())
    const edited = await lockRaw(rawRule({ [key]: value }))
    expect(edited.fingerprint).not.toBe(original.fingerprint)
  })

  it('preserves JSON array order but canonicalizes object key order', async () => {
    const first = await lockRaw(rawRule({ actions: [{ type: 'notify', config: { a: 1, b: 2 } }, { type: 'update_field' }] }))
    const reorderedKeys = await lockRaw(rawRule({ actions: [{ config: { b: 2, a: 1 }, type: 'notify' }, { type: 'update_field' }] }))
    const reorderedActions = await lockRaw(rawRule({ actions: [{ type: 'update_field' }, { type: 'notify', config: { a: 1, b: 2 } }] }))
    expect(reorderedKeys.fingerprint).toBe(first.fingerprint)
    expect(reorderedActions.fingerprint).not.toBe(first.fingerprint)
  })

  it('retains a different fingerprint after an ABA restore with a changed database nonce', async () => {
    const old = await lockRaw(rawRule())
    const restored = await lockRaw(rawRule({ integration_authority_revision: nextRevision }))
    expect(restored.actions).toEqual(old.actions)
    expect(restored.fingerprint).not.toBe(old.fingerprint)
  })

  it('probes RC and xid, then locks exact supplied base -> sheet -> rule IDs NOWAIT with no unlocked rereads', async () => {
    const { trx, calls } = harness()
    await lockAutomationReadRule(trx, scope)
    expect(calls).toHaveLength(6)
    expect(calls.slice(0, 3).map(({ sql }) => sql)).toEqual([
      "SELECT current_setting('transaction_isolation') AS isolation",
      'SELECT pg_current_xact_id()::text AS xid', 'SELECT pg_current_xact_id()::text AS xid',
    ])
    for (const [index, table] of tables.entries()) {
      expect(calls[index + 3].sql).toContain(`FROM ${table}`)
      expect(calls[index + 3].sql).toMatch(/WHERE (?:r\.)?id = \$1 FOR SHARE NOWAIT/)
    }
    expect(calls.slice(3).map(({ params }) => params)).toEqual([[scope.baseId], [scope.sheetId], [scope.ruleId]])
    const ruleSql = calls[5].sql
    expect(ruleSql).toContain('pg_catalog.to_jsonb(r)')
    expect(ruleSql).toContain('r.integration_authority_revision')
    for (const column of ['created_at', 'updated_at']) {
      expect(ruleSql).toContain(`pg_catalog.to_char(r.${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`)
    }
    expect(calls.every(({ sql }) => !/\b(UPDATE|INSERT|DELETE|COMMIT|ROLLBACK|SET|JOIN)\b/.test(sql))).toBe(true)
  })

  it('copies trusted expected IDs before awaits, preventing caller mutation from switching the scope', async () => {
    const input = { ...scope }
    const base = harness()
    const trx: Queryable = {
      async query(sql, params) {
        input.actorId = input.ruleId = input.sheetId = input.baseId = 'mutated-scope'
        return base.trx.query(sql, params)
      },
    }
    await expect(lockAutomationReadRule(trx, input)).resolves.toMatchObject({ ruleId: scope.ruleId, createdBy: scope.actorId })
    expect(base.calls.slice(3).map(({ params }) => params)).toEqual([[scope.baseId], [scope.sheetId], [scope.ruleId]])
  })

  it.each([
    ['missing base', { bases: [] }],
    ['duplicate base', { bases: [...fixture().bases, ...fixture().bases] }],
    ['other base', { bases: [{ id: 'other-base', deleted_at: null }] }],
    ['deleted base', { bases: [{ id: scope.baseId, deleted_at: '2026-10-01' }] }],
    ['missing base liveness', { bases: [{ id: scope.baseId }] }],
    ['missing sheet', { sheets: [] }],
    ['duplicate sheet', { sheets: [...fixture().sheets, ...fixture().sheets] }],
    ['other sheet', { sheets: [{ ...fixture().sheets[0], id: 'other-sheet' }] }],
    ['sheet moved to another base', { sheets: [{ ...fixture().sheets[0], base_id: 'other-base' }] }],
    ['deleted sheet', { sheets: [{ ...fixture().sheets[0], deleted_at: '2026-10-01' }] }],
    ['missing sheet liveness', { sheets: [{ id: scope.sheetId, base_id: scope.baseId }] }],
    ['missing rule', { rules: [] }],
    ['duplicate rule', { rules: [...fixture().rules, ...fixture().rules] }],
  ] satisfies Array<[string, Partial<Fixture>]> )('denies %s', async (_name, overrides) => {
    await expectDenied(fixture(overrides))
  })

  it.each([
    ['id', 'other-rule'], ['sheet_id', 'other-sheet'], ['created_by', 'other-actor'],
    ['created_by', null], ['enabled', false], ['enabled', null], ['enabled', 'true'], ['enabled', 1],
    ['integration_authority_revision', null], ['integration_authority_revision', ''],
    ['integration_authority_revision', 'not-a-uuid'], ['integration_authority_revision', `${revision} `],
  ])('denies invalid %s: case %#', async (key, value) => {
    await expectDenied(fixture({ rules: [{ raw_rule: rawRule({ [key as string]: value }) }] }))
  })

  it('stops at failed base/sheet binding rather than following the returned scope hint', async () => {
    const { trx, calls } = harness(fixture({ sheets: [{ ...fixture().sheets[0], base_id: 'other-base' }] }))
    await expect(lockAutomationReadRule(trx, scope)).rejects.toMatchObject({ code: 'AUTOMATION_RULE_AUTHORITY_DENIED' })
    expect(calls).toHaveLength(5)
    expect(calls.every(({ params }) => !params.includes('other-base'))).toBe(true)
  })

  it.each(['integration_authority_revision', 'conditions', 'actions', 'execution_mode'])('rejects a missing raw schema field %s', async key => {
    const raw = rawRule()
    delete raw[key]
    await expect(lockRaw(raw)).rejects.toMatchObject({ code: 'AUTOMATION_RULE_AUTHORITY_UNAVAILABLE' })
  })

  it.each([
    ['created_at', new Date('2026-10-01T00:00:00.123Z')],
    ['updated_at', '2026-10-01T00:00:00.123Z'],
    ['action_config', undefined], ['trigger_config', { invalid: Number.NaN }],
    ['execution_mode', true], ['action_type', null], ['trigger_type', null],
  ])('fails closed on malformed raw %s: case %#', async (key, value) => {
    await expect(lockRaw(rawRule({ [key as string]: value })))
      .rejects.toMatchObject({ code: 'AUTOMATION_RULE_AUTHORITY_UNAVAILABLE' })
  })

  it.each([
    null, undefined, {}, [], { ...scope, actorId: '' }, { ...scope, actorId: 42 },
    { ...scope, ruleId: ' rule' }, { ...scope, sheetId: 'sheet ' },
    { ...scope, baseId: 'base\u0000' }, { ...scope, ruleId: 'x'.repeat(256) },
    { ...scope, tenantId: 'caller-tenant' }, { ...scope, workspaceId: 'caller-workspace' },
  ])('rejects noncanonical or surplus input before querying: case %#', async input => {
    const { trx, calls } = harness()
    await expect(lockAutomationReadRule(trx, input as AutomationReadRuleInput))
      .rejects.toMatchObject({ code: 'AUTOMATION_RULE_INPUT_INVALID' })
    expect(calls).toEqual([])
  })

  it.each([null, undefined, {}, { query: false }])('rejects unusable transaction handles: case %#', async trx => {
    await expect(lockAutomationReadRule(trx as Queryable, scope))
      .rejects.toMatchObject({ code: 'AUTOMATION_RULE_TRANSACTION_REQUIRED' })
  })

  it.each(['repeatable read', 'serializable', 'read uncommitted', 'READ COMMITTED', null])('rejects isolation %s before row locks', async isolation => {
    const { trx, calls } = harness(fixture({ isolation }))
    await expect(lockAutomationReadRule(trx, scope)).rejects.toMatchObject({ code: 'AUTOMATION_RULE_TRANSACTION_REQUIRED' })
    expect(calls).toHaveLength(1)
  })

  it.each([['100', '101'], ['', ''], [null, null], []])('rejects autocommit and invalid transaction probes: case %#', async (...xids) => {
    const { trx, calls } = harness(fixture({ xids }))
    await expect(lockAutomationReadRule(trx, scope)).rejects.toMatchObject({ code: 'AUTOMATION_RULE_TRANSACTION_REQUIRED' })
    expect(calls.some(({ sql }) => sql.includes('FOR SHARE'))).toBe(false)
  })

  it.each(['current_setting', 'pg_current_xact_id'])('sanitizes transaction error at %s', async at => {
    const { trx } = harness(fixture(), { at, code: 'XX000' })
    await expect(lockAutomationReadRule(trx, scope)).rejects.toMatchObject({
      code: 'AUTOMATION_RULE_TRANSACTION_REQUIRED', message: 'Automation rule authority requires a read-committed transaction',
    })
  })

  it.each(tables.flatMap(table => ['55P03', '42P01', '42703', '42501'].map(code => [table, code])))(
    'sanitizes busy/unavailable/schema/permission errors on %s (%s)', async (table, code) => {
    const { trx } = harness(fixture(), { at: `FROM ${table}`, code })
    try {
      await lockAutomationReadRule(trx, scope)
      expect.fail('unavailable rule prerequisite must reject')
    } catch (error) {
      expect(error).toBeInstanceOf(AutomationRuleAuthorityError)
      expect(error).toMatchObject({ code: 'AUTOMATION_RULE_AUTHORITY_UNAVAILABLE', message: 'Automation rule authority is unavailable' })
      expect(error).not.toHaveProperty('cause')
      expect(JSON.stringify(error)).not.toContain(privateDetail)
      expect(String(error)).not.toContain(privateDetail)
    }
  })
})
