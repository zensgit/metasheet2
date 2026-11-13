/**
 * R-69 I6d — the run_finished half of the "editor authority" finding (owner-approved 2026-11-13, item 3 of that
 * day's proposal: 「运行完成」触发器规则也有同样的口子……建议同样的规则也用到这类规则上). Synthetic only: no plugin, no
 * port, no network, no real database (the real-DB half is in tests/integration/multitable-automation-run-integration-
 * job-realdb.test.ts, the run_finished describe, on real membership / permission / admission rows).
 *
 * THE HOLE. A save of an integration.run_finished rule re-stamps its trigger binding from the rule's STORED creator,
 * and the save gate (assertIntegrationRunFinishedRuleAtSave) checks the LIVE authority of that creator only. Nothing
 * looked at the person saving. So someone who may manage the sheet's automations but cannot read integration results
 * could retype a schedule rule into a run_finished alert rule, switch one on, or change the statuses / the send action
 * of an enabled one — and it then fired under the creator's read authority.
 *
 * THE RULE (T-layer default, the owner can veto it; verbatim):
 *   "When a save (create or update, including setRuleEnabled) leaves a rule whose trigger is integration.run_finished
 *   AND that is enabled after the write, the acting user must pass the SAME live check the run_finished save gate
 *   applies to the creator (integrationRunFinishedCreatorAuthorized, or whatever that predicate is named; reuse it,
 *   with principalId = the acting user and tenantId = the rule's binding tenant). A missing acting user is refused.
 *   No check when the write leaves the rule disabled or moves the trigger away from integration.run_finished. The
 *   binding principal stays the stored creator."
 *
 * WHAT IS DRIVEN HERE: the PRODUCTION authority read — no test seam on the service. The pool and the predicate
 * (resolveIntegrationRunPrincipalOnTransaction) are module mocks that answer by (principalId, tenantId) with that
 * principal's permission codes, so the service's own integrationRunFinishedCreatorAuthorized decides (active member
 * able to manage automation AND an integration read code, or admin). A check that asked about the creator instead of
 * the acting user, about another tenant, or that used the job predicate (no read code needed) is a red here.
 * `editor_plain` is exactly that last discriminator: it resolves ok (B1's job authority) but holds no read code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authority = vi.hoisted(() => ({
  /** principalId → the tenant it is an active, automation-capable member of, and its permission codes / roles. */
  grants: new Map<string, { tenants: Set<string>; permissions: string[]; roles: string[] }>(),
  /** principals for which the predicate itself answers authority_unavailable (its own read failed). */
  unavailable: new Set<string>(),
  /** principals for which the read throws out of the transaction (a failure the predicate did not catch). */
  throws: new Set<string>(),
  /** the N-th authority transaction (1-based) and every later one cannot be opened. */
  failTransactionsFrom: Number.POSITIVE_INFINITY,
  /** every binding the predicate was asked about, in order. */
  asked: [] as Array<{ principalId: string; tenantId: string }>,
  /** the statements of every authority transaction, one list per transaction. */
  transactions: [] as string[][],
  opened: 0,
}))

vi.mock('../../src/integration/db/connection-pool', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/integration/db/connection-pool')>()
  let pool: object | undefined
  const get = () => {
    pool ??= Object.assign(Object.create(original.poolManager.get()) as object, {
      transaction: async <T>(handler: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }) => Promise<T>): Promise<T> => {
        authority.opened += 1
        if (authority.opened >= authority.failTransactionsFrom) throw Object.assign(new Error('synthetic connect failure'), { code: 'ECONNREFUSED' })
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
      await trx.query('SELECT /* the live-authority predicate */ 1', [binding.principalId, binding.tenantId])
      authority.asked.push({ principalId: binding.principalId, tenantId: binding.tenantId })
      if (authority.throws.has(binding.principalId)) throw Object.assign(new Error('synthetic read failure'), { code: '57P01' })
      if (authority.unavailable.has(binding.principalId)) return { ok: false, reason: 'authority_unavailable' }
      const grant = authority.grants.get(binding.principalId)
      if (grant?.tenants.has(binding.tenantId)) {
        return { ok: true, user: { id: binding.principalId, permissions: [...grant.permissions], roles: [...grant.roles], role: 'user', tenantId: binding.tenantId } }
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
const CODE = 'INTEGRATION_RUN_FINISHED_EDITOR_UNAUTHORIZED'
const MESSAGE =
  'an enabled integration.run_finished rule can only be saved by a user who holds the integration read authority themself (active, a member of the rule\'s tenant, able to manage automation, holding integration:read or above or stock-prep:read); it is not held or could not be checked, so the rule was not saved'
/** B1's code (run_integration_job rules) — never this check's. */
const JOB_EDITOR_CODE = 'RUN_INTEGRATION_JOB_EDITOR_UNAUTHORIZED'
const READ_COMMITTED = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'

const SHEET = 'sheet_1'
const TENANT = 'tenant_1'
const CREATOR = 'alerter'
/** May manage automation (resolves ok — B1's job authority) but holds NO integration / stock-prep read code. */
const EDITOR_PLAIN = 'editor_plain'
/** Holds stock-prep:read in the rule's tenant (enough for run_finished). */
const EDITOR_OK = 'editor_ok'
/** Holds integration:read, but only in ANOTHER tenant. */
const EDITOR_ELSEWHERE = 'editor_elsewhere'
/** An admin (the predicate's own admin branch), no read code. */
const EDITOR_ADMIN = 'editor_admin'
/** Not a member of any tenant. */
const NOBODY = 'nobody'
const BINDING = { principalId: CREATOR, tenantId: TENANT }
const CRON = { cron: '0 6 * * *', timezone: 'Asia/Shanghai' }
const ALERT = { destinationIds: ['d1'], titleTemplate: '{{run.status}}', bodyTemplate: '{{run.job.projectNo}}' }
const RF_CONFIG = { job: { kind: 'stock_prep_pull' }, statuses: ['failed'] }
const RF_STAMPED = { ...RF_CONFIG, binding: BINDING }
const JOB = { job: { kind: 'stock_prep_pull', projectNos: ['P-1'], applyMode: 'dry_run_only' }, timeoutMs: 30 * 60_000 }
const JSON_COLUMNS = ['trigger_config', 'action_config', 'conditions', 'actions']

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** A stored, stamped run_finished alert rule (a DingTalk group message). */
const storedAlertRule = (overrides: Record<string, unknown> = {}) => ({
  id: 'atr_1', sheet_id: SHEET, created_by: CREATOR, name: 'stored', enabled: true, conditions: null, execution_mode: null,
  created_at: '2026-11-12T00:00:00.000Z', updated_at: '2026-11-12T00:00:00.000Z',
  trigger_type: 'integration.run_finished', trigger_config: RF_STAMPED,
  action_type: 'send_dingtalk_group_message', action_config: ALERT, actions: null,
  ...overrides,
})
/** The same alert action on a schedule trigger (what an editor could retype into a run_finished rule). */
const storedScheduleRule = (overrides: Record<string, unknown> = {}) => storedAlertRule({ trigger_type: 'schedule.cron', trigger_config: CRON, ...overrides })

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
    // the creator's single active membership (the binding tenant) and, for the job-rule cases, the rule sheet's registration
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
/** Refused with THE code and THE fixed message; values-free (no id, no tenant, no sheet). */
async function refusedAsRunFinishedEditor(work: Promise<unknown>, label = ''): Promise<void> {
  const refusal = await refusalOf(work)
  expect(refusal, `${label}: the save must be refused, nothing written`).toBeInstanceOf(AutomationRuleValidationError)
  // (a refusal by ANOTHER save check is a red here too, and names its message)
  expect((refusal as AutomationRuleValidationError).code, `${label}: refused by «${refusal!.message}»`).toBe(CODE)
  expect(refusal!.message, label).toBe(MESSAGE)
  for (const needle of [CREATOR, EDITOR_PLAIN, EDITOR_OK, EDITOR_ELSEWHERE, EDITOR_ADMIN, NOBODY, TENANT, SHEET, 'atr_']) expect(refusal!.message, label).not.toContain(needle)
}
const triggerColumn = (values: Record<string, unknown>) => JSON.parse(String(values.trigger_config)) as Record<string, unknown>
/** The run_finished save gate asks about the stored creator first; then this check asks about the acting user. */
const gateThenActor = (actor: string) => [{ principalId: CREATOR, tenantId: TENANT }, { principalId: actor, tenantId: TENANT }]
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
  authority.grants = new Map([
    [CREATOR, { tenants: new Set([TENANT]), permissions: ['integration:read', 'workflow:write'], roles: [] }],
    [EDITOR_PLAIN, { tenants: new Set([TENANT]), permissions: ['workflow:write'], roles: [] }],
    [EDITOR_OK, { tenants: new Set([TENANT]), permissions: ['stock-prep:read', 'workflow:write'], roles: [] }],
    [EDITOR_ELSEWHERE, { tenants: new Set(['tenant_2']), permissions: ['integration:read', 'workflow:write'], roles: [] }],
    [EDITOR_ADMIN, { tenants: new Set([TENANT]), permissions: [], roles: ['admin'] }],
  ])
  authority.unavailable = new Set()
  authority.throws = new Set()
  authority.failTransactionsFrom = Number.POSITIVE_INFINITY
  authority.asked = []
  authority.transactions = []
  authority.opened = 0
})
afterEach(() => {
  for (const h of services) for (const id of h.rules.keys()) h.service.unregisterSchedule(id)
  services = []
  vi.unstubAllEnvs()
})

describe('RF editor authority — an editor WITHOUT the integration read authority cannot leave an enabled run_finished rule behind (refused, nothing written)', () => {
  it.each<[label: string, body: Record<string, unknown>]>([
    ['the trigger pair', { triggerType: 'integration.run_finished', triggerConfig: RF_CONFIG }],
    ['the trigger pair, bringing its OWN binding (the editor\'s, another tenant)', { triggerType: 'integration.run_finished', triggerConfig: { ...RF_CONFIG, binding: { principalId: EDITOR_PLAIN, tenantId: 'tenant_2' } } }],
    ['the trigger pair together with a new send action', { triggerType: 'integration.run_finished', triggerConfig: RF_CONFIG, actionConfig: { ...ALERT, titleTemplate: '{{run.reason}}' } }],
  ])('(a) retyping the creator\'s enabled schedule rule into a run_finished rule — %s', async (label, body) => {
    const h = harness()
    h.seed(storedScheduleRule())
    const before = h.stored()
    await refusedAsRunFinishedEditor(h.patch(body, EDITOR_PLAIN), label)
    expect(h.writes).toHaveLength(0)
    expect(h.stored()).toBe(before)
    // the gate asked about the stored creator; this check about the ACTING user — both in the creator's binding tenant
    expect(authority.asked).toEqual(gateThenActor(EDITOR_PLAIN))
    expectEveryAuthorityReadCommitted()
  })

  it('(b) switching a disabled run_finished rule ON — setRuleEnabled(true) and the PATCH { enabled: true } alike', async () => {
    const h = harness()
    h.seed(storedAlertRule({ enabled: false }))
    const before = h.stored()
    await refusedAsRunFinishedEditor(h.service.setRuleEnabled('atr_1', SHEET, true, EDITOR_PLAIN), 'setRuleEnabled')
    await refusedAsRunFinishedEditor(h.patch({ enabled: true }, EDITOR_PLAIN), 'PATCH enabled')
    expect(h.writes).toHaveLength(0)
    expect(h.stored()).toBe(before)
    expect(authority.asked).toEqual([...gateThenActor(EDITOR_PLAIN), ...gateThenActor(EDITOR_PLAIN)])
  })

  it.each<[label: string, body: Record<string, unknown>]>([
    ['(c) new statuses', { triggerConfig: { job: { kind: 'stock_prep_pull' }, statuses: ['failed', 'skipped', 'held'] } }],
    ['(c) another job to listen to', { triggerConfig: { job: { kind: 'pipeline', pipelineId: 'pipe_1' } } }],
    ['(c) a new send action config', { actionConfig: { ...ALERT, titleTemplate: '{{run.reason}}', destinationIds: ['d2'] } }],
    ['(c) another send action type', { actionType: 'send_webhook', actionConfig: { url: 'https://hooks.example.test/alert' } }],
    ['a rename', { name: 'renamed' }],
    ['clearing the conditions', { conditions: null }],
    ['enabled: true sent again together with a rename', { enabled: true, name: 'renamed' }],
  ])('%s of an ENABLED run_finished rule', async (label, body) => {
    const h = harness()
    h.seed(storedAlertRule())
    const before = h.stored()
    await refusedAsRunFinishedEditor(h.patch(body, EDITOR_PLAIN), label)
    expect(h.writes).toHaveLength(0)
    expect(h.stored()).toBe(before)
    expect(authority.asked).toEqual(gateThenActor(EDITOR_PLAIN))
  })

  it.each<[label: string, actor: string]>([
    ['holds the read code only in ANOTHER tenant', EDITOR_ELSEWHERE],
    ['is no member at all', NOBODY],
  ])('an editor who %s is refused: the predicate is asked about the rule\'s binding tenant', async (label, actor) => {
    const h = harness()
    h.seed(storedAlertRule({ enabled: false }))
    await refusedAsRunFinishedEditor(h.service.setRuleEnabled('atr_1', SHEET, true, actor), label)
    expect(authority.asked).toEqual(gateThenActor(actor))
    expect(h.writes).toHaveLength(0)
  })

  it.each<[label: string, actor: string | null | undefined]>([
    ['undefined', undefined],
    ['null', null],
    ['empty', ''],
    ['blank', '   '],
  ])('(h) a MISSING acting user (%s) is refused — the acting user is never read', async (label, actor) => {
    const h = harness()
    h.seed(storedAlertRule({ enabled: false }))
    await refusedAsRunFinishedEditor(h.service.setRuleEnabled('atr_1', SHEET, true, actor), `${label} enable`)
    await refusedAsRunFinishedEditor(h.service.updateRule('atr_1', SHEET, { name: 'renamed', enabled: true }, actor), `${label} rename+enable`)
    expect(h.writes).toHaveLength(0)
    // only the gate's creator reads, one per save
    expect(authority.asked).toEqual([BINDING, BINDING])
  })

  it('(i) the acting user\'s authority read FAILS — the predicate answers authority_unavailable, the read throws, or its transaction cannot be opened: refused (fail closed), never saved', async () => {
    const h = harness()
    h.seed(storedAlertRule({ enabled: false }))
    // EDITOR_OK would pass if the read worked
    authority.unavailable.add(EDITOR_OK)
    await refusedAsRunFinishedEditor(h.service.setRuleEnabled('atr_1', SHEET, true, EDITOR_OK), 'predicate unavailable')
    authority.unavailable.clear()
    authority.throws.add(EDITOR_OK)
    await refusedAsRunFinishedEditor(h.patch({ enabled: true }, EDITOR_OK), 'read throws')
    authority.throws.clear()
    // the gate's creator read is transaction 5 here; the acting user's read (6) cannot be opened
    authority.failTransactionsFrom = authority.opened + 2
    await refusedAsRunFinishedEditor(h.patch({ enabled: true, name: 'renamed' }, EDITOR_OK), 'transaction failed')
    expect(authority.asked).toEqual([...gateThenActor(EDITOR_OK), ...gateThenActor(EDITOR_OK), BINDING])
    expect(h.writes).toHaveLength(0)
    expect(h.rules.get('atr_1')!.enabled).toBe(false)
  })
})

describe('RF editor authority — what stays allowed', () => {
  it('(d) an editor WITHOUT the authority can switch a run_finished rule OFF — setRuleEnabled(false) and the PATCH — and edit it while it is off; the acting user is never read', async () => {
    const h = harness()
    h.seed(storedAlertRule())
    expect((await h.service.setRuleEnabled('atr_1', SHEET, false, EDITOR_PLAIN))?.enabled).toBe(false)
    h.rules.get('atr_1')!.enabled = true
    expect((await h.patch({ enabled: false }, EDITOR_PLAIN))?.enabled).toBe(false)
    // an edit that leaves it OFF (new statuses on the disabled rule) needs nothing either
    expect(await h.patch({ triggerConfig: { job: { kind: 'stock_prep_pull' }, statuses: ['held'] } }, EDITOR_PLAIN)).not.toBeNull()
    expect(h.writes).toHaveLength(3)
    // the binding stays the creator's
    expect(triggerColumn(h.writes[2].values)).toEqual({ job: { kind: 'stock_prep_pull' }, statuses: ['held'], binding: BINDING })
    expect(authority.asked).toEqual([BINDING, BINDING, BINDING])
  })

  it('(d) retyping into a run_finished rule AND leaving it disabled in the same PATCH is saved, stamped with the creator\'s binding; switching it on afterwards is the save that needs the authority', async () => {
    const h = harness()
    h.seed(storedScheduleRule())
    const updated = await h.patch({ triggerType: 'integration.run_finished', triggerConfig: { ...RF_CONFIG, binding: { principalId: EDITOR_PLAIN, tenantId: 'tenant_2' } }, enabled: false }, EDITOR_PLAIN)
    expect(updated?.enabled).toBe(false)
    expect(h.writes).toHaveLength(1)
    expect(triggerColumn(h.writes[0].values)).toEqual(RF_STAMPED)
    expect(authority.asked).toEqual([BINDING])
    await refusedAsRunFinishedEditor(h.service.setRuleEnabled('atr_1', SHEET, true, EDITOR_PLAIN))
  })

  it('(e) an editor WITHOUT the authority can move the trigger AWAY from integration.run_finished (an enabled rule): nothing is read', async () => {
    const h = harness()
    h.seed(storedAlertRule())
    const updated = await h.patch({ triggerType: 'schedule.cron', triggerConfig: CRON }, EDITOR_PLAIN)
    expect(updated).toMatchObject({ enabled: true, trigger_type: 'schedule.cron' })
    expect(h.writes).toHaveLength(1)
    expect(authority.asked).toEqual([])
  })

  it('a rule whose trigger is not run_finished is never judged: any edit by any editor (none, too), no authority read', async () => {
    const h = harness()
    h.seed(storedScheduleRule({ enabled: false }))
    expect(await h.service.setRuleEnabled('atr_1', SHEET, true, EDITOR_PLAIN)).not.toBeNull()
    expect(await h.patch({ name: 'renamed' }, undefined)).not.toBeNull()
    expect(await h.patch({ actionConfig: { ...ALERT, titleTemplate: 'x' } }, EDITOR_PLAIN)).not.toBeNull()
    expect(h.writes).toHaveLength(3)
    expect(authority.asked).toEqual([])
  })

  it('(f) the creator WITH the authority: create (the gate\'s creator check IS the acting-user check there), enable, a statuses edit and an action edit are saved — asked about the creator only, in the binding tenant', async () => {
    const h = harness()
    const created = await h.service.createRule(SHEET, parseCreateRuleInput(wire({ triggerType: 'integration.run_finished', triggerConfig: RF_CONFIG, actionType: 'send_dingtalk_group_message', actionConfig: ALERT }), CREATOR))
    expect(created.enabled).toBe(true)
    expect(created.trigger_config).toEqual(RF_STAMPED)
    expect(authority.asked).toEqual([BINDING])

    h.seed(storedAlertRule({ enabled: false }))
    expect((await h.service.setRuleEnabled('atr_1', SHEET, true, CREATOR))?.enabled).toBe(true)
    expect(await h.patch({ triggerConfig: { job: { kind: 'stock_prep_pull' }, statuses: ['failed', 'skipped'] } }, CREATOR)).not.toBeNull()
    expect(await h.patch({ actionConfig: { ...ALERT, titleTemplate: '{{run.reason}}' } }, CREATOR)).not.toBeNull()
    expect(authority.asked).toHaveLength(1 + 3 * 2)
    expect(authority.asked.every((binding) => binding.principalId === CREATOR && binding.tenantId === TENANT)).toBe(true)
    expectEveryAuthorityReadCommitted()
  })

  it('createRule: the acting user IS the creator — one without the read authority is refused by the save gate\'s own creator check (its message, not this code)', async () => {
    const h = harness()
    const refusal = await refusalOf(h.service.createRule(SHEET, parseCreateRuleInput(wire({ triggerType: 'integration.run_finished', triggerConfig: RF_CONFIG, actionType: 'send_dingtalk_group_message', actionConfig: ALERT }), EDITOR_PLAIN)))
    expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
    expect(refusal!.message).toMatch(/require the creator to be active, to manage automation and to hold integration:read/)
    expect(h.rules.size).toBe(0)
    expect(authority.asked).toEqual([{ principalId: EDITOR_PLAIN, tenantId: TENANT }])
  })

  it('(g) an editor WITH the authority is allowed — retype, enable, statuses edit — and the binding stays the STORED creator\'s', async () => {
    const h = harness()
    h.seed(storedScheduleRule())
    const retyped = await h.patch({ triggerType: 'integration.run_finished', triggerConfig: { ...RF_CONFIG, binding: { principalId: EDITOR_OK, tenantId: 'tenant_2' } } }, EDITOR_OK)
    expect(retyped).toMatchObject({ enabled: true, trigger_type: 'integration.run_finished' })
    expect(triggerColumn(h.writes[0].values)).toEqual(RF_STAMPED)
    expect(JSON.stringify(h.rules.get('atr_1'))).not.toContain(EDITOR_OK)
    expect(h.rules.get('atr_1')!.created_by).toBe(CREATOR)

    expect((await h.service.setRuleEnabled('atr_1', SHEET, false, EDITOR_PLAIN))?.enabled).toBe(false)
    expect((await h.service.setRuleEnabled('atr_1', SHEET, true, EDITOR_OK))?.enabled).toBe(true)
    expect(await h.patch({ triggerConfig: { job: { kind: 'stock_prep_pull' }, statuses: ['skipped'] } }, EDITOR_OK)).not.toBeNull()
    expect(h.writes).toHaveLength(4)
    expect(triggerColumn(h.writes[3].values)).toEqual({ job: { kind: 'stock_prep_pull' }, statuses: ['skipped'], binding: BINDING })
    expect(authority.asked).toEqual([...gateThenActor(EDITOR_OK), BINDING, ...gateThenActor(EDITOR_OK), ...gateThenActor(EDITOR_OK)])
    expectEveryAuthorityReadCommitted()
  })

  it('(g) an admin editor passes the same predicate (its admin branch) without a read code', async () => {
    const h = harness()
    h.seed(storedAlertRule({ enabled: false }))
    expect((await h.service.setRuleEnabled('atr_1', SHEET, true, EDITOR_ADMIN))?.enabled).toBe(true)
    expect(authority.asked).toEqual(gateThenActor(EDITOR_ADMIN))
  })
})

describe('RF editor authority — beside B1 (run_integration_job): one rule is never both kinds, each check judges its own, neither masks the other', () => {
  it('B1\'s job authority alone (resolves ok, no read code) does not pass a run_finished save; refused with THIS code, never B1\'s', async () => {
    const h = harness()
    h.seed(storedAlertRule({ enabled: false }))
    const refusal = await refusalOf(h.service.setRuleEnabled('atr_1', SHEET, true, EDITOR_PLAIN))
    expect((refusal as AutomationRuleValidationError).code).toBe(CODE)
    expect((refusal as AutomationRuleValidationError).code).not.toBe(JOB_EDITOR_CODE)
  })

  it('retyping a run_finished rule into a schedule job rule: THIS check is off (trigger moved away), B1 judges — B1\'s authority saves it, a non-member is refused with B1\'s code', async () => {
    const body = { triggerType: 'schedule.cron', triggerConfig: CRON, actionType: 'run_integration_job', actionConfig: JOB }
    const refused = harness()
    refused.seed(storedAlertRule())
    const refusal = await refusalOf(refused.patch(body, NOBODY))
    expect((refusal as AutomationRuleValidationError).code, refusal?.message).toBe(JOB_EDITOR_CODE)
    expect(refused.writes).toHaveLength(0)
    expect(authority.asked).toEqual([{ principalId: NOBODY, tenantId: TENANT }])

    authority.asked = []
    const saved = harness()
    saved.seed(storedAlertRule())
    expect(await saved.patch(body, EDITOR_PLAIN)).toMatchObject({ enabled: true, trigger_type: 'schedule.cron', action_type: 'run_integration_job' })
    expect(saved.writes).toHaveLength(1)
    expect(authority.asked).toEqual([{ principalId: EDITOR_PLAIN, tenantId: TENANT }])
  })

  it('a STORED row that is already both kinds (a hand-written run_finished rule carrying a stamped job) is refused by the run_finished gate before either editor check reads anything — rename and switch-on alike', async () => {
    const h = harness()
    const stampedJob = { ...JOB, binding: BINDING }
    h.seed(storedAlertRule({ action_type: 'run_integration_job', action_config: stampedJob, actions: [{ type: 'run_integration_job', config: stampedJob }] }))
    const before = h.stored()
    for (const [label, work] of [
      ['rename', () => h.patch({ name: 'renamed' }, EDITOR_OK)],
      ['switch on', () => { h.rules.get('atr_1')!.enabled = false; return h.service.setRuleEnabled('atr_1', SHEET, true, EDITOR_OK) }],
    ] as const) {
      const refusal = await refusalOf(work())
      expect(refusal, label).toBeInstanceOf(AutomationRuleValidationError)
      expect(refusal!.message, label).toMatch(/action run_integration_job is not allowed on integration\.run_finished rules/)
      expect([CODE, JOB_EDITOR_CODE], label).not.toContain((refusal as AutomationRuleValidationError).code)
    }
    expect(h.writes).toHaveLength(0)
    expect(JSON.parse(h.stored())).toEqual({ ...JSON.parse(before), enabled: false })
    expect(authority.asked).toEqual([])
  })

  it('a run_finished rule cannot be given the job at all: refused by the shape gates before either editor check', async () => {
    const h = harness()
    h.seed(storedAlertRule())
    const refusal = await refusalOf(h.patch({ actionType: 'run_integration_job', actionConfig: JOB }, EDITOR_OK))
    expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
    expect([CODE, JOB_EDITOR_CODE]).not.toContain((refusal as AutomationRuleValidationError).code)
    expect(h.writes).toHaveLength(0)
  })
})

describe('RF editor authority — checked on EVERY attempt against that attempt\'s row (a save that lost a race is checked again)', () => {
  it('a rename that read a DISABLED run_finished rule, lost to a save that switched it ON, is refused on the retry', async () => {
    const h = harness({
      onRuleUpdate: (nth, rules) => {
        if (nth !== 1) return undefined
        Object.assign(rules.get('atr_1')!, { enabled: true, updated_at: '2026-11-12T00:00:01.000Z' })
        return 'lost'
      },
    })
    h.seed(storedAlertRule({ enabled: false }))
    await refusedAsRunFinishedEditor(h.patch({ name: 'renamed' }, EDITOR_PLAIN))
    expect(h.writes).toHaveLength(0)
    expect(h.rules.get('atr_1')).toMatchObject({ name: 'stored', enabled: true })
    // attempt 1 judged a disabled rule (the gate only); attempt 2 also asked about the acting user
    expect(authority.asked).toEqual([BINDING, ...gateThenActor(EDITOR_PLAIN)])
  })

  it('a rename that read a SCHEDULE rule, lost to a save that retyped it into an enabled run_finished rule, is refused on the retry', async () => {
    const h = harness({
      onRuleUpdate: (nth, rules) => {
        if (nth !== 1) return undefined
        Object.assign(rules.get('atr_1')!, { trigger_type: 'integration.run_finished', trigger_config: RF_STAMPED, updated_at: '2026-11-12T00:00:01.000Z' })
        return 'lost'
      },
    })
    h.seed(storedScheduleRule())
    await refusedAsRunFinishedEditor(h.patch({ name: 'renamed' }, EDITOR_PLAIN))
    expect(h.writes).toHaveLength(0)
    expect(h.rules.get('atr_1')).toMatchObject({ name: 'stored', trigger_type: 'integration.run_finished' })
    expect(authority.asked).toEqual(gateThenActor(EDITOR_PLAIN))
  })

  it('the positive control of the same race: an editor WITH the authority is checked again and written on the retry', async () => {
    const h = harness({
      onRuleUpdate: (nth, rules) => {
        if (nth !== 1) return undefined
        Object.assign(rules.get('atr_1')!, { enabled: true, updated_at: '2026-11-12T00:00:01.000Z' })
        return 'lost'
      },
    })
    h.seed(storedAlertRule({ enabled: false }))
    expect((await h.patch({ name: 'renamed' }, EDITOR_OK))?.name).toBe('renamed')
    expect(h.writes).toHaveLength(1)
    expect(authority.asked).toEqual([BINDING, ...gateThenActor(EDITOR_OK)])
  })
})
