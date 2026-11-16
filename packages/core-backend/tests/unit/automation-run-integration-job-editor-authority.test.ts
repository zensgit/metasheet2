/**
 * R-69 I6d — finding B1 ("editor authority"), owner-approved 2026-11-13 (「按建议执行」). Synthetic only: no plugin, no
 * port, no network, no real database (the real-DB half is in tests/integration/multitable-automation-run-integration-
 * job-realdb.test.ts, on real membership / permission rows).
 *
 * THE HOLE. A save of a run_integration_job rule re-stamps the binding from the rule's STORED creator (ADR §6.2: the
 * editor never takes it over), and the executor checks the LIVE authority of that bound principal only. Nothing
 * looked at the person saving. So someone who may manage the sheet's automations but does not hold the job authority
 * could retype the creator's schedule rule into a job rule, switch a job rule on, or edit an enabled one — and the job
 * then ran under the creator's authority.
 *
 * THE RULE (T-layer default, the owner can veto it):
 *   "When a save (create or update, including setRuleEnabled) leaves a rule that carries run_integration_job AND is
 *   enabled after the write, the acting user must pass the SAME live-authority predicate the executor applies at run
 *   time (resolveIntegrationRunPrincipalOnTransaction, with principalId = the acting user and tenantId = the rule's
 *   binding tenant). A missing acting user is refused. No check when the write leaves the rule disabled or removes
 *   the job. The binding principal stays the stored creator (ADR §6.2)."
 *
 * WHAT IS DRIVEN HERE: the PRODUCTION authority read — no test seam on the service. The pool and the predicate are
 * module mocks: `poolManager.get().transaction` records every statement of each transaction, and the predicate answers
 * by (principalId, tenantId), so a check that asked about the creator instead of the acting user, or about another
 * tenant, is a red here, not a pass. The rule store is in memory (the three Kysely shapes createRule / getRule /
 * updateRule issue); `onRuleUpdate` stands for ANOTHER save landing between an attempt's read and its write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authority = vi.hoisted(() => ({
  /** principalId → the tenants in which the predicate answers ok. */
  authorized: new Map<string, Set<string>>(),
  /** principals for which the predicate itself answers authority_unavailable (its own read failed). */
  unavailable: new Set<string>(),
  /** the pool cannot open the transaction at all. */
  poolDown: false,
  /** every binding the predicate was asked about, in order. */
  asked: [] as Array<{ principalId: string; tenantId: string }>,
  /** the statements of every authority transaction, one list per transaction. */
  transactions: [] as string[][],
}))

vi.mock('../../src/integration/db/connection-pool', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/integration/db/connection-pool')>()
  // Only `transaction` is replaced; everything else (getInternalPool, read at import by src/db/pg.ts) is the real
  // pool's, never connected here.
  let pool: object | undefined
  const get = () => {
    pool ??= Object.assign(Object.create(original.poolManager.get()) as object, {
      transaction: async <T>(handler: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }) => Promise<T>): Promise<T> => {
        if (authority.poolDown) throw Object.assign(new Error('synthetic connect failure'), { code: 'ECONNREFUSED' })
        const statements: string[] = []
        authority.transactions.push(statements)
        return handler({ query: async (sql: string) => { statements.push(sql); return { rows: [], rowCount: 0 } } })
      },
    })
    return pool
  }
  return { ...original, poolManager: Object.assign(Object.create(original.poolManager) as object, { get }) }
})

vi.mock('../../src/integration/automation-run-authority', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/integration/automation-run-authority')>()
  return {
    ...original,
    resolveIntegrationRunPrincipalOnTransaction: async (
      trx: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
      binding: { principalId: string; tenantId: string },
    ) => {
      // The predicate's reads go to the transaction it is handed (a marker statement stands for them).
      await trx.query('SELECT /* the live-authority predicate */ 1', [binding.principalId, binding.tenantId])
      authority.asked.push({ principalId: binding.principalId, tenantId: binding.tenantId })
      if (authority.unavailable.has(binding.principalId)) return { ok: false, reason: 'authority_unavailable' }
      if (authority.authorized.get(binding.principalId)?.has(binding.tenantId)) {
        return { ok: true, user: { id: binding.principalId, permissions: ['workflow:write'], roles: [], role: 'user', tenantId: binding.tenantId } }
      }
      return { ok: false, reason: 'principal_unauthorized' }
    },
  }
})

import { EventBus } from '../../src/integration/events/event-bus'
import {
  AutomationRuleValidationError,
  AutomationService,
  parseCreateRuleInput,
  parseUpdateRuleInput,
  preflightAutomationRuleUpdate,
  type AutomationRule,
} from '../../src/multitable/automation-service'
import { STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV } from '../../src/multitable/stock-preparation-manual-rows-gate'

const FLAG = 'INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED'
/** Pinned HERE, not read from the module: a renamed code or a reworded refusal is a change to review. */
const CODE = 'RUN_INTEGRATION_JOB_EDITOR_UNAUTHORIZED'
const UNAUTHORIZED_MESSAGE =
  'an enabled run_integration_job rule can only be saved by a user who holds the job authority themself (active, a member of the rule\'s tenant, able to manage automation); the rule was not saved'
const UNAVAILABLE_MESSAGE =
  'run_integration_job: the saving user\'s job authority could not be checked; the rule was not saved'
const READ_COMMITTED = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'

const SHEET = 'sheet_1'
const TENANT = 'tenant_1'
const CREATOR = 'svc_user'
/** May manage the sheet's automations (the route let them in) but holds no job authority anywhere. */
const EDITOR_PLAIN = 'editor_plain'
/** Holds the job authority in the rule's tenant. */
const EDITOR_OK = 'editor_ok'
/** Holds the job authority, but only in ANOTHER tenant. */
const EDITOR_ELSEWHERE = 'editor_elsewhere'
const BINDING = { principalId: CREATOR, tenantId: TENANT }
const CRON = { cron: '0 6 * * *', timezone: 'Asia/Shanghai' }
const JOB = { job: { kind: 'stock_prep_pull', projectNos: ['P-1'], applyMode: 'dry_run_only' }, timeoutMs: 30 * 60_000 }
const STAMPED = { ...JOB, binding: BINDING }
const JSON_COLUMNS = ['trigger_config', 'action_config', 'conditions', 'actions']

type Action = { type: string; config: Record<string, unknown> }
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const job = (extra: Record<string, unknown> = {}): Action => ({ type: 'run_integration_job', config: { ...JOB, ...extra } })
const other = (): Action => ({ type: 'record_click', config: {} })
/** MetaAutomationRuleEditor.vue buildPayload: the action list, the pair mirrored from actions[0], the trigger twice. */
const editorBody = (actions: Action[], overrides: Record<string, unknown> = {}) => wire({
  name: 'Nightly pull', triggerType: 'schedule.cron', triggerConfig: CRON, trigger: { type: 'schedule.cron', config: CRON },
  actions, actionType: actions[0].type, actionConfig: actions[0].config, executionMode: null, ...overrides,
})

/** A stored job rule in the editor shape (both columns stamped with the creator's binding). */
const storedJobRule = (overrides: Record<string, unknown> = {}) => ({
  id: 'atr_1', sheet_id: SHEET, created_by: CREATOR, name: 'stored', enabled: true, conditions: null, execution_mode: null,
  created_at: '2026-11-12T00:00:00.000Z', updated_at: '2026-11-12T00:00:00.000Z',
  trigger_type: 'schedule.cron', trigger_config: CRON,
  action_type: 'run_integration_job', action_config: STAMPED, actions: [{ type: 'run_integration_job', config: STAMPED }],
  ...overrides,
})
/** A stored schedule rule that carries NO job (what an editor could retype into one). */
const storedPlainRule = (overrides: Record<string, unknown> = {}) => storedJobRule({ action_type: 'record_click', action_config: {}, actions: null, ...overrides })

function makeService(options: { onRuleUpdate?: (nth: number, rules: Map<string, Record<string, unknown>>) => 'lost' | undefined } = {}) {
  const rules = new Map<string, Record<string, unknown>>()
  const writes: Array<{ op: 'insert' | 'update'; values: Record<string, unknown> }> = []
  let ruleUpdates = 0
  const asStored = (values: Record<string, unknown>) => {
    const row: Record<string, unknown> = { ...values }
    for (const column of JSON_COLUMNS) if (typeof row[column] === 'string') row[column] = JSON.parse(row[column] as string)
    return row
  }
  const builder = (op: 'insert' | 'select' | 'update' | 'delete', table: string) => {
    const state: { values?: Record<string, unknown>; wheres: Array<[string, unknown]> } = { wheres: [] }
    const self: Record<string, unknown> = {}
    for (const method of ['selectAll', 'select', 'orderBy', 'limit', 'offset', 'returningAll', 'onConflict', 'columns', 'doUpdateSet', 'groupBy', 'leftJoin']) self[method] = () => self
    self.values = (values: Record<string, unknown>) => { state.values = values; return self }
    self.set = (values: Record<string, unknown>) => { state.values = values; return self }
    self.where = (column: unknown, _operator: unknown, value: unknown) => { if (typeof column === 'string') state.wheres.push([column, value]); return self }
    const matching = () => (table === 'automation_rules' ? [...rules.values()].filter((row) => state.wheres.every(([column, value]) => row[column] === value)) : [])
    self.execute = async () => {
      if (table !== 'automation_rules') return []
      if (op === 'insert') {
        const row = asStored(state.values ?? {})
        rules.set(String(row.id), row)
        writes.push({ op, values: state.values ?? {} })
        return []
      }
      if (op === 'update') {
        ruleUpdates += 1
        if (options.onRuleUpdate?.(ruleUpdates, rules) === 'lost') return []
        const hit = matching()
        for (const row of hit) Object.assign(row, asStored(state.values ?? {}), { updated_at: `2026-11-12T00:00:00.${String(ruleUpdates).padStart(3, '0')}Z` })
        if (hit.length > 0) writes.push({ op, values: state.values ?? {} })
        return hit.map((row) => ({ ...row }))
      }
      return op === 'select' ? matching().map((row) => ({ ...row })) : []
    }
    self.executeTakeFirst = async () => {
      const first = op === 'select' ? matching()[0] : undefined
      return first ? { ...first } : undefined
    }
    return self
  }
  const db = {
    insertInto: (table: string) => builder('insert', table),
    selectFrom: (table: string) => builder('select', table),
    updateTable: (table: string) => builder('update', table),
    deleteFrom: (table: string) => builder('delete', table),
  }
  const queryFn = vi.fn(async (sql: string, params: unknown[] = []) => {
    // the creator's single active membership (the binding tenant) and the rule sheet's registration
    if (/FROM user_orgs/i.test(sql)) return { rows: [{ org_id: TENANT }], rowCount: 1 }
    if (/FROM integration_stock_prep_project_target WHERE sheet_id = \$1/.test(sql)) {
      return params[0] === SHEET
        ? { rows: [{ sheet_id: SHEET, tenant_id: TENANT, project_no: 'P-1', status: 'active', object_id: 'obj_1' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 0 }
  })
  const service = new AutomationService(new EventBus(), db as never, queryFn as never)
  const seed = (row: Record<string, unknown>) => { rules.set(String(row.id), { ...row }) }
  /** PATCH /sheets/:sheetId/automations/:ruleId after authn/authz: the route's parser and preflight, then updateRule. */
  const patch = async (body: Record<string, unknown>, actorId: string | null | undefined): Promise<AutomationRule | null> => {
    const parsed = parseUpdateRuleInput(wire(body))
    if (!parsed) throw new Error('test body carries no recognised field')
    const preflight = await preflightAutomationRuleUpdate(queryFn as never, SHEET, 'atr_1', parsed, service)
    if (!preflight) return null
    return service.updateRule('atr_1', SHEET, preflight.input, actorId)
  }
  const stored = () => JSON.stringify(rules.get('atr_1'))
  return { service, rules, writes, seed, patch, stored }
}

const refusalOf = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error as Error)
/** Refused with THE code and the given fixed message; values-free (no id, no tenant, no project). */
async function refusedAsEditorUnauthorized(work: Promise<unknown>, message = UNAUTHORIZED_MESSAGE, label = ''): Promise<void> {
  const refusal = await refusalOf(work)
  expect(refusal, `${label}: the save must be refused, nothing written`).toBeInstanceOf(AutomationRuleValidationError)
  // (a refusal by ANOTHER save check is a red here too, and names its message)
  expect((refusal as AutomationRuleValidationError).code, `${label}: refused by «${refusal!.message}»`).toBe(CODE)
  expect(refusal!.message, label).toBe(message)
  for (const needle of [CREATOR, EDITOR_PLAIN, EDITOR_OK, EDITOR_ELSEWHERE, TENANT, SHEET, 'P-1', 'atr_']) expect(refusal!.message, label).not.toContain(needle)
}
const configColumn = (values: Record<string, unknown>) => JSON.parse(String(values.action_config)) as Record<string, unknown>
const actionsColumn = (values: Record<string, unknown>) => JSON.parse(String(values.actions)) as Action[]
/** Every authority transaction went READ COMMITTED first and then ran the predicate on that same transaction. */
function expectEveryAuthorityReadCommitted(): void {
  expect(authority.transactions.length).toBeGreaterThan(0)
  for (const statements of authority.transactions) {
    expect(statements[0]).toBe(READ_COMMITTED)
    expect(statements.slice(1)).toEqual(['SELECT /* the live-authority predicate */ 1'])
  }
}

let services: Array<ReturnType<typeof makeService>> = []
const harness = (options: Parameters<typeof makeService>[0] = {}) => { const h = makeService(options); services.push(h); return h }

beforeEach(() => {
  vi.stubEnv(FLAG, 'true')
  vi.stubEnv(STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV, 'true')
  authority.authorized = new Map([[CREATOR, new Set([TENANT])], [EDITOR_OK, new Set([TENANT])], [EDITOR_ELSEWHERE, new Set(['tenant_2'])]])
  authority.unavailable = new Set()
  authority.poolDown = false
  authority.asked = []
  authority.transactions = []
})
afterEach(() => {
  for (const h of services) for (const id of h.rules.keys()) h.service.unregisterSchedule(id)
  services = []
  vi.unstubAllEnvs()
})

describe('B1 — an editor WITHOUT the job authority cannot leave an enabled job rule behind (refused, nothing written)', () => {
  it.each<[label: string, body: Record<string, unknown>]>([
    ['the editor\'s whole body (actions[] + its mirrored pair)', editorBody([job()])],
    ['the pair only (a hand-written PATCH)', { actionType: 'run_integration_job', actionConfig: JOB }],
    ['a body that brings its OWN binding (the editor\'s, another tenant)', editorBody([job({ binding: { principalId: EDITOR_PLAIN, tenantId: 'tenant_2' } })])],
  ])('(a) an action-shaped edit that retypes the creator\'s enabled schedule rule into a job rule — %s', async (label, body) => {
    const h = harness()
    h.seed(storedPlainRule())
    const before = h.stored()
    await refusedAsEditorUnauthorized(h.patch(body, EDITOR_PLAIN), UNAUTHORIZED_MESSAGE, label)
    expect(h.writes).toHaveLength(0)
    expect(h.stored()).toBe(before)
    // asked about the ACTING user in the rule's binding tenant — never about the stored creator
    expect(authority.asked).toEqual([{ principalId: EDITOR_PLAIN, tenantId: TENANT }])
    expectEveryAuthorityReadCommitted()
  })

  it('(b) switching a disabled job rule ON — setRuleEnabled(true) and the PATCH { enabled: true } alike', async () => {
    const h = harness()
    h.seed(storedJobRule({ enabled: false }))
    const before = h.stored()
    await refusedAsEditorUnauthorized(h.service.setRuleEnabled('atr_1', SHEET, true, EDITOR_PLAIN), UNAUTHORIZED_MESSAGE, 'setRuleEnabled')
    await refusedAsEditorUnauthorized(h.patch({ enabled: true }, EDITOR_PLAIN), UNAUTHORIZED_MESSAGE, 'PATCH enabled')
    expect(h.writes).toHaveLength(0)
    expect(h.stored()).toBe(before)
    expect(authority.asked).toEqual([{ principalId: EDITOR_PLAIN, tenantId: TENANT }, { principalId: EDITOR_PLAIN, tenantId: TENANT }])
  })

  it.each<[label: string, body: Record<string, unknown>]>([
    ['(c) a trigger-only edit (a new cron, same timezone)', { triggerConfig: { cron: '30 7 * * *', timezone: 'Asia/Shanghai' } }],
    ['a rename', { name: 'renamed' }],
    ['clearing the conditions', { conditions: null }],
    ['an action re-save that keeps the job (a new timeout)', editorBody([job({ timeoutMs: 20 * 60_000 })])],
    ['enabled: true sent again together with a rename', { enabled: true, name: 'renamed' }],
  ])('%s of an ENABLED job rule', async (label, body) => {
    const h = harness()
    h.seed(storedJobRule())
    const before = h.stored()
    await refusedAsEditorUnauthorized(h.patch(body, EDITOR_PLAIN), UNAUTHORIZED_MESSAGE, label)
    expect(h.writes).toHaveLength(0)
    expect(h.stored()).toBe(before)
    expect(authority.asked).toEqual([{ principalId: EDITOR_PLAIN, tenantId: TENANT }])
  })

  it('an editor who holds the job authority only in ANOTHER tenant is refused: the predicate is asked about the rule\'s binding tenant', async () => {
    const h = harness()
    h.seed(storedJobRule({ enabled: false }))
    await refusedAsEditorUnauthorized(h.service.setRuleEnabled('atr_1', SHEET, true, EDITOR_ELSEWHERE))
    expect(authority.asked).toEqual([{ principalId: EDITOR_ELSEWHERE, tenantId: TENANT }])
    expect(h.writes).toHaveLength(0)
  })

  it.each<[label: string, actor: string | null | undefined]>([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
  ])('(h) a MISSING acting user (%s) is refused — before any authority read', async (label, actor) => {
    const h = harness()
    h.seed(storedJobRule({ enabled: false }))
    await refusedAsEditorUnauthorized(h.service.setRuleEnabled('atr_1', SHEET, true, actor), UNAUTHORIZED_MESSAGE, `${label} enable`)
    await refusedAsEditorUnauthorized(h.service.updateRule('atr_1', SHEET, { name: 'renamed', enabled: true }, actor), UNAUTHORIZED_MESSAGE, `${label} rename+enable`)
    expect(h.writes).toHaveLength(0)
    expect(authority.asked).toEqual([])
    expect(authority.transactions).toEqual([])
  })

  it('(i) the authority read FAILS — the predicate answers authority_unavailable, or the transaction cannot be opened: refused (fail closed), never saved', async () => {
    const h = harness()
    h.seed(storedJobRule({ enabled: false }))
    // EDITOR_OK would pass if the read worked
    authority.unavailable.add(EDITOR_OK)
    await refusedAsEditorUnauthorized(h.service.setRuleEnabled('atr_1', SHEET, true, EDITOR_OK), UNAVAILABLE_MESSAGE, 'predicate unavailable')
    authority.unavailable.clear()
    authority.poolDown = true
    await refusedAsEditorUnauthorized(h.patch({ enabled: true }, EDITOR_OK), UNAVAILABLE_MESSAGE, 'transaction failed')
    expect(h.writes).toHaveLength(0)
    expect(h.rules.get('atr_1')!.enabled).toBe(false)
  })

  it('createRule: the creator IS the acting user — a creator without live job authority cannot create an enabled job rule', async () => {
    authority.authorized.delete(CREATOR)
    const h = harness()
    await refusedAsEditorUnauthorized(h.service.createRule(SHEET, parseCreateRuleInput(editorBody([job()]), CREATOR)))
    expect(h.writes).toHaveLength(0)
    expect(h.rules.size).toBe(0)
    expect(authority.asked).toEqual([{ principalId: CREATOR, tenantId: TENANT }])
  })
})

describe('B1 — what stays allowed', () => {
  it('(d) an editor WITHOUT the authority can switch a job rule OFF — setRuleEnabled(false) and the PATCH — with no authority read', async () => {
    const h = harness()
    h.seed(storedJobRule())
    expect((await h.service.setRuleEnabled('atr_1', SHEET, false, EDITOR_PLAIN))?.enabled).toBe(false)
    h.rules.get('atr_1')!.enabled = true
    expect((await h.patch({ enabled: false }, EDITOR_PLAIN))?.enabled).toBe(false)
    // and an edit that leaves it OFF (a rename of the disabled rule) needs nothing either
    expect((await h.patch({ name: 'renamed while off' }, EDITOR_PLAIN))?.name).toBe('renamed while off')
    expect(h.writes).toHaveLength(3)
    expect(authority.asked).toEqual([])
  })

  it('(d) an action-shaped edit that adds the job AND leaves the rule disabled in the same PATCH is saved, stamped with the creator\'s binding', async () => {
    const h = harness()
    h.seed(storedPlainRule())
    const updated = await h.patch({ ...editorBody([job({ binding: { principalId: EDITOR_PLAIN, tenantId: 'tenant_2' } })]), enabled: false }, EDITOR_PLAIN)
    expect(updated?.enabled).toBe(false)
    expect(h.writes).toHaveLength(1)
    expect(configColumn(h.writes[0].values)).toEqual(STAMPED)
    expect(actionsColumn(h.writes[0].values)).toEqual([{ type: 'run_integration_job', config: STAMPED }])
    expect(authority.asked).toEqual([])
    // … and switching it ON afterwards is the save that needs the authority
    await refusedAsEditorUnauthorized(h.service.setRuleEnabled('atr_1', SHEET, true, EDITOR_PLAIN))
  })

  it('(e) an editor WITHOUT the authority can take the job OUT of an enabled rule (the editor replaces the whole action list)', async () => {
    const h = harness()
    h.seed(storedJobRule())
    const updated = await h.patch(editorBody([other()]), EDITOR_PLAIN)
    expect(updated).toMatchObject({ enabled: true, action_type: 'record_click', actions: [other()] })
    expect(h.writes).toHaveLength(1)
    expect(authority.asked).toEqual([])
  })

  it('a rule that carries no job is never judged: any edit by any editor, no authority read', async () => {
    const h = harness()
    h.seed(storedPlainRule({ enabled: false }))
    expect(await h.service.setRuleEnabled('atr_1', SHEET, true, EDITOR_PLAIN)).not.toBeNull()
    expect(await h.patch({ name: 'renamed' }, undefined)).not.toBeNull()
    expect(await h.patch({ triggerConfig: { cron: '0 8 * * *', timezone: 'Asia/Shanghai' } }, EDITOR_PLAIN)).not.toBeNull()
    expect(h.writes).toHaveLength(3)
    expect(authority.asked).toEqual([])
  })

  it('(f) the creator WITH the authority: create, enable, a trigger edit and an action edit are saved as before — the creator is asked about, in the binding tenant', async () => {
    const h = harness()
    const created = await h.service.createRule(SHEET, parseCreateRuleInput(editorBody([job()], { enabled: false }), CREATOR))
    expect(created.enabled).toBe(false)
    expect(authority.asked).toEqual([])
    const fresh = await h.service.createRule(SHEET, parseCreateRuleInput(editorBody([job()]), CREATOR))
    expect(fresh.enabled).toBe(true)
    expect(fresh.action_config).toEqual(STAMPED)
    expect(authority.asked).toEqual([{ principalId: CREATOR, tenantId: TENANT }])

    h.seed(storedJobRule({ enabled: false }))
    expect((await h.service.setRuleEnabled('atr_1', SHEET, true, CREATOR))?.enabled).toBe(true)
    expect(await h.patch({ triggerConfig: { cron: '30 7 * * *', timezone: 'Asia/Shanghai' } }, CREATOR)).not.toBeNull()
    expect(await h.patch(editorBody([job({ timeoutMs: 20 * 60_000 })]), CREATOR)).not.toBeNull()
    expect(authority.asked).toHaveLength(4)
    expect(authority.asked.every((binding) => binding.principalId === CREATOR && binding.tenantId === TENANT)).toBe(true)
    expectEveryAuthorityReadCommitted()
  })

  it('(g) an editor WITH the authority is allowed — retype, enable, trigger edit — and the binding stays the STORED creator\'s (ADR §6.2)', async () => {
    const h = harness()
    h.seed(storedPlainRule())
    const retyped = await h.patch(editorBody([job({ binding: { principalId: EDITOR_OK, tenantId: 'tenant_2' } })]), EDITOR_OK)
    expect(retyped).toMatchObject({ enabled: true, action_type: 'run_integration_job' })
    expect(configColumn(h.writes[0].values)).toEqual(STAMPED)
    expect(actionsColumn(h.writes[0].values)).toEqual([{ type: 'run_integration_job', config: STAMPED }])
    expect(JSON.stringify(h.rules.get('atr_1'))).not.toContain(EDITOR_OK)
    expect(h.rules.get('atr_1')!.created_by).toBe(CREATOR)

    expect((await h.service.setRuleEnabled('atr_1', SHEET, false, EDITOR_PLAIN))?.enabled).toBe(false)
    expect((await h.service.setRuleEnabled('atr_1', SHEET, true, EDITOR_OK))?.enabled).toBe(true)
    expect(await h.patch({ triggerConfig: { cron: '30 7 * * *', timezone: 'Asia/Shanghai' } }, EDITOR_OK)).not.toBeNull()
    expect(h.writes).toHaveLength(4)
    expect(authority.asked).toEqual([
      { principalId: EDITOR_OK, tenantId: TENANT },
      { principalId: EDITOR_OK, tenantId: TENANT },
      { principalId: EDITOR_OK, tenantId: TENANT },
    ])
    expectEveryAuthorityReadCommitted()
  })
})

describe('B1 — the binding tenant comes from the rule\'s NEXT stored binding; a binding that cannot be read fails closed', () => {
  it('a stored job whose persisted binding does not parse (a hand-written row) cannot be saved enabled — even by an editor with the authority; switching it off still works', async () => {
    const h = harness()
    h.seed(storedJobRule({ action_config: JOB, actions: [{ type: 'run_integration_job', config: JOB }] }))
    await refusedAsEditorUnauthorized(h.patch({ name: 'renamed' }, EDITOR_OK), UNAVAILABLE_MESSAGE)
    expect(authority.asked).toEqual([])
    expect((await h.patch({ enabled: false }, EDITOR_PLAIN))?.enabled).toBe(false)
  })

  it('ONE occurrence whose binding does not parse is enough: the pair is stamped, actions[0] (what the executor runs) is not — refused, never asked', async () => {
    const h = harness()
    h.seed(storedJobRule({ actions: [{ type: 'run_integration_job', config: JOB }] }))
    await refusedAsEditorUnauthorized(h.patch({ name: 'renamed' }, EDITOR_OK), UNAVAILABLE_MESSAGE)
    expect(authority.asked).toEqual([])
    expect(h.writes).toHaveLength(0)
  })

  it('a NESTED occurrence (inside a branch: never saveable, a hand-written row) carries no binding this check reads — switching the rule on is refused, never asked, even beside a stamped top-level job', async () => {
    const h = harness()
    // a well-formed condition_branch (so no other save check refuses the switch first) whose default branch holds a job
    const nested = {
      type: 'condition_branch',
      config: {
        branches: [{ key: 'b1', conditions: { conjunction: 'AND', conditions: [] }, actions: [{ type: 'update_record', config: { fields: { fld_1: 'x' } } }] }],
        defaultBranch: { key: 'otherwise', actions: [{ type: 'run_integration_job', config: { ...JOB, binding: { principalId: CREATOR, tenantId: 'tenant_2' } } }] },
      },
    }
    h.seed(storedJobRule({ enabled: false, execution_mode: 'workflow_job_v1', actions: [{ type: 'run_integration_job', config: STAMPED }, nested] }))
    await refusedAsEditorUnauthorized(h.service.setRuleEnabled('atr_1', SHEET, true, EDITOR_OK), UNAVAILABLE_MESSAGE)
    expect(authority.asked).toEqual([])
    expect(h.rules.get('atr_1')!.enabled).toBe(false)
  })

  it('a stored row whose two occurrences name DIFFERENT tenants has no single binding tenant: refused, never asked', async () => {
    const h = harness()
    authority.authorized.set(EDITOR_OK, new Set([TENANT, 'tenant_2']))
    h.seed(storedJobRule({ actions: [{ type: 'run_integration_job', config: { ...JOB, binding: { principalId: CREATOR, tenantId: 'tenant_2' } } }] }))
    await refusedAsEditorUnauthorized(h.patch({ name: 'renamed' }, EDITOR_OK), UNAVAILABLE_MESSAGE)
    expect(authority.asked).toEqual([])
  })
})

describe('B1 — checked on EVERY attempt against that attempt\'s row (a save that lost a race is checked again)', () => {
  it('a rename that read a PLAIN rule, lost to a save that made it an enabled JOB rule, is refused on the retry; nothing of it is written', async () => {
    const h = harness({
      onRuleUpdate: (nth, rules) => {
        if (nth !== 1) return undefined
        Object.assign(rules.get('atr_1')!, { action_type: 'run_integration_job', action_config: STAMPED, actions: [{ type: 'run_integration_job', config: STAMPED }], updated_at: '2026-11-12T00:00:01.000Z' })
        return 'lost'
      },
    })
    h.seed(storedPlainRule())
    await refusedAsEditorUnauthorized(h.patch({ name: 'renamed' }, EDITOR_PLAIN))
    expect(h.writes).toHaveLength(0)
    expect(h.rules.get('atr_1')).toMatchObject({ name: 'stored', action_type: 'run_integration_job' })
    // attempt 1 judged a rule without the job (nothing to ask); attempt 2 asked once
    expect(authority.asked).toEqual([{ principalId: EDITOR_PLAIN, tenantId: TENANT }])
  })

  it('a rename that read a DISABLED job rule, lost to a save that switched it ON, is refused on the retry', async () => {
    const h = harness({
      onRuleUpdate: (nth, rules) => {
        if (nth !== 1) return undefined
        Object.assign(rules.get('atr_1')!, { enabled: true, updated_at: '2026-11-12T00:00:01.000Z' })
        return 'lost'
      },
    })
    h.seed(storedJobRule({ enabled: false }))
    await refusedAsEditorUnauthorized(h.patch({ name: 'renamed' }, EDITOR_PLAIN))
    expect(h.writes).toHaveLength(0)
    expect(h.rules.get('atr_1')).toMatchObject({ name: 'stored', enabled: true })
  })

  it('the positive control of the same race: an editor WITH the authority is checked again and written on the retry', async () => {
    const h = harness({
      onRuleUpdate: (nth, rules) => {
        if (nth !== 1) return undefined
        Object.assign(rules.get('atr_1')!, { enabled: true, updated_at: '2026-11-12T00:00:01.000Z' })
        return 'lost'
      },
    })
    h.seed(storedJobRule({ enabled: false }))
    expect((await h.patch({ name: 'renamed' }, EDITOR_OK))?.name).toBe('renamed')
    expect(h.writes).toHaveLength(1)
    expect(authority.asked).toEqual([{ principalId: EDITOR_OK, tenantId: TENANT }])
  })
})
