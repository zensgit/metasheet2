/**
 * R-69 I6d, r7 adversarial review findings 1–3 (owner-approved 2026-11-13, 「按建议」: fix 1–3 locally). Synthetic only:
 * no plugin, no port, no network, no real database (the real-DB half is in tests/integration/multitable-automation-run-
 * integration-job-realdb.test.ts, on real membership / permission / admission rows and real execution rows).
 *
 * THE HOLES.
 *   1. POST /automation-executions/:id/retry is gated by requireAdminRole only (a GLOBAL admin role), and retryExecution
 *      checked only that the rule is present + enabled and that its action fingerprint is unchanged, then executeRule.
 *      A retry of an integration.run_finished execution re-sent the stored run although dispatch would refuse it: the
 *      event switch was not re-read, the binding was not compared with the creator, the creator's live authority was
 *      not re-checked — and nothing looked at the retrying admin.
 *   2. A retry of a run_integration_job execution ran the job under the creator's binding; the executor re-reads the
 *      action switch and checks the bound creator, never the retrying admin.
 *   3. PATCH { enabled: false } of a run_finished rule re-ran the run_finished save gate on the STORED creator, so a
 *      rule whose creator lost authority could not be switched off.
 *
 * THE RULES (T-layer default; direction ruled by the owner 2026-11-13; this exact wording is a T-layer elaboration the
 * owner can veto, decision register R-92, 11-13 note; verbatim):
 *   R1, retry of a run_finished execution:
 *     - re-read INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED (exact 'true');
 *     - re-check binding == stored creator and the creator's live authority, exactly as dispatch does;
 *     - the retrying actor must pass integrationRunFinishedCreatorAuthorized for the binding tenant.
 *     Any failure refuses the retry before anything is sent. Reuse the dispatch predicates; do not redefine them.
 *   R2, retry of a run_integration_job execution: the retrying actor must pass resolveIntegrationRunPrincipalOnTransaction
 *     for the binding tenant (the B1 predicate, run like B1 with the READ COMMITTED transaction). Failure refuses the
 *     retry before any intent claim, lease or port call.
 *   R3: a write whose ONLY effect is to switch an integration.run_finished rule off (enabled:false, no other field) is
 *     accepted without the save gate's creator authority check. Any other edit still runs the full gate.
 *
 * WHAT IS DRIVEN HERE: the PRODUCTION authority reads — no test seam on the service. The pool and the predicate
 * (resolveIntegrationRunPrincipalOnTransaction) are module mocks that answer by (principalId, tenantId) with that
 * principal's permission codes, so the service's own integrationRunFinishedCreatorAuthorized (R1) and its B1 read (R2)
 * decide. A check that asked about the creator instead of the retrying actor, about another tenant, or that skipped a
 * leg, is a red here. A refusal must come before the one-shot first-retry marker (a queryFn CAS, recorded below) and
 * before executeRule (spied): nothing is sent, claimed, leased or called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const authority = vi.hoisted(() => ({
  /** principalId → the tenant it is an active, automation-capable member of, and its permission codes / roles. */
  grants: new Map<string, { tenants: Set<string>; permissions: string[]; roles: string[] }>(),
  /** principals for which the predicate itself answers authority_unavailable (its own read failed). */
  unavailable: new Set<string>(),
  /** principals for which the read throws out of the transaction (a failure the predicate did not catch). */
  throws: new Set<string>(),
  /** the pool cannot open any authority transaction. */
  poolDown: false,
  /** every binding the predicate was asked about, in order. */
  asked: [] as Array<{ principalId: string; tenantId: string }>,
  /** the statements of every authority transaction, one list per transaction. */
  transactions: [] as string[][],
}))

vi.mock('../../src/integration/db/connection-pool', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/integration/db/connection-pool')>()
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
import type { AutomationExecution } from '../../src/multitable/automation-executor'
import {
  AutomationRuleValidationError,
  AutomationService,
  parseUpdateRuleInput,
  preflightAutomationRuleUpdate,
  toExecutorRule,
  type AutomationRule,
} from '../../src/multitable/automation-service'
import { STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV } from '../../src/multitable/stock-preparation-manual-rows-gate'

const ACTION_FLAG = 'INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED'
const EVENT_FLAG = 'INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED'
/** Pinned HERE, not read from the module: a renamed code or a reworded refusal is a change to review. */
const RF_DISABLED = {
  status: 409,
  code: 'INTEGRATION_RUN_EVENT_DISABLED',
  message: "integration.run_finished is disabled on this deployment (INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED is not 'true'); nothing was re-run",
}
const RF_CREATOR_REFUSED = {
  status: 409,
  code: 'INTEGRATION_RUN_FINISHED_RETRY_CREATOR_UNAUTHORIZED',
  message: 'the rule\'s integration.run_finished binding no longer names its creator and the tenant of the original run, or the creator is no longer active, able to manage automation and holding integration:read (or above) or stock-prep:read; nothing was re-run',
}
const RF_ACTOR_REFUSED = {
  status: 409,
  code: 'INTEGRATION_RUN_FINISHED_RETRY_UNAUTHORIZED',
  message: 'an integration.run_finished execution can only be re-run by a user who holds the integration read authority themself (active, a member of the rule\'s tenant, able to manage automation, holding integration:read or above or stock-prep:read); it is not held or could not be checked, so nothing was re-run',
}
const RF_KIND_CHANGED = { status: 409, code: 'RULE_CHANGED', message: 'Rule trigger changed since the original execution; cannot retry safely' }
const JOB_ACTOR_REFUSED = {
  status: 409,
  code: 'RUN_INTEGRATION_JOB_RETRY_UNAUTHORIZED',
  message: 'a run_integration_job execution can only be re-run by a user who holds the job authority themself (active, a member of the rule\'s tenant, able to manage automation); nothing was re-run',
}
const JOB_ACTOR_UNAVAILABLE = {
  status: 409,
  code: 'RUN_INTEGRATION_JOB_RETRY_UNAUTHORIZED',
  message: 'run_integration_job: the retrying user\'s job authority could not be checked; nothing was re-run',
}
/** The run_finished save gate's own creator refusal (unchanged). */
const RF_GATE_CREATOR_MESSAGE = /require the creator to be active, to manage automation and to hold integration:read/
const RF_EDITOR_CODE = 'INTEGRATION_RUN_FINISHED_EDITOR_UNAUTHORIZED'
const READ_COMMITTED = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'

const SHEET = 'sheet_1'
const TENANT = 'tenant_1'
const CREATOR = 'alerter'
/** May manage automation (resolves ok — B1's job authority) but holds NO integration / stock-prep read code. */
const EDITOR_PLAIN = 'editor_plain'
/** Holds stock-prep:read in the rule's tenant (enough for run_finished) and the job authority. */
const EDITOR_OK = 'editor_ok'
/** Holds integration:read and the job authority, but only in ANOTHER tenant. */
const EDITOR_ELSEWHERE = 'editor_elsewhere'
/** An admin (the run_finished predicate's own admin branch), no read code. */
const EDITOR_ADMIN = 'editor_admin'
/** Not a member of any tenant. */
const NOBODY = 'nobody'
const BINDING = { principalId: CREATOR, tenantId: TENANT }
const CRON = { cron: '0 6 * * *', timezone: 'Asia/Shanghai' }
const ALERT = { destinationIds: ['d1'], titleTemplate: '{{run.status}}', bodyTemplate: '{{run.job.projectNo}}' }
const RF_STAMPED = { job: { kind: 'stock_prep_pull' }, statuses: ['failed'], binding: BINDING }
const JOB = { job: { kind: 'stock_prep_pull', projectNos: ['P-1'], applyMode: 'dry_run_only' }, timeoutMs: 30 * 60_000 }
const JOB_STAMPED = { ...JOB, binding: BINDING }
const JSON_COLUMNS = ['trigger_config', 'action_config', 'conditions', 'actions']
const NEEDLES = [CREATOR, EDITOR_PLAIN, EDITOR_OK, EDITOR_ELSEWHERE, EDITOR_ADMIN, NOBODY, TENANT, SHEET, 'atr_', 'axe_']

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** A stored, stamped, ENABLED run_finished alert rule (a DingTalk group message). */
const storedAlertRule = (overrides: Record<string, unknown> = {}) => ({
  id: 'atr_1', sheet_id: SHEET, created_by: CREATOR, name: 'stored', enabled: true, conditions: null, execution_mode: null,
  created_at: '2026-11-12T00:00:00.000Z', updated_at: '2026-11-12T00:00:00.000Z',
  trigger_type: 'integration.run_finished', trigger_config: RF_STAMPED,
  action_type: 'send_dingtalk_group_message', action_config: ALERT, actions: null,
  ...overrides,
})
/** A stored, stamped, ENABLED run_integration_job rule (both columns stamped with the creator's binding). */
const storedJobRule = (overrides: Record<string, unknown> = {}) => storedAlertRule({
  trigger_type: 'schedule.cron', trigger_config: CRON,
  action_type: 'run_integration_job', action_config: JOB_STAMPED, actions: [{ type: 'run_integration_job', config: JOB_STAMPED }],
  ...overrides,
})
/** A plain schedule rule carrying neither kind. */
const storedPlainRule = (overrides: Record<string, unknown> = {}) => storedAlertRule({ trigger_type: 'schedule.cron', trigger_config: CRON, ...overrides })

/** The record-less payload dispatchIntegrationRunFinished hands to executeRule (what the execution stores). */
const RF_TRIGGER_EVENT = {
  sheetId: SHEET, recordId: '', data: {}, actorId: null, _automationDepth: 0,
  eventId: 'evt_1', eventType: 'integration.run_finished', occurredAt: '2026-11-13T00:00:00.000Z',
  run: {
    eventId: 'evt_1', occurredAt: '2026-11-13T00:00:00.000Z', job: { kind: 'stock_prep_pull', projectNo: 'P-1' }, status: 'failed',
    canApply: false, counts: { read: 0, cleaned: 0, written: 0, failed: 1, add: 0, update: 0, skip: 0, inactive: 0, manual_confirm: 0 },
    durationMs: 10, attempts: 1, triggeredBy: 'automation', errorClass: 'synthetic',
  },
}
const SCHEDULE_TRIGGER_EVENT = { sheetId: SHEET, recordId: '', data: {}, actorId: null, _triggeredBy: 'schedule' }
const snapshotOf = (row: Record<string, unknown>) => wire(toExecutorRule(row as never))
/** A FAILED execution of the stored rule, as the log service hands it back (the rule snapshot as it ran). */
const storedExecution = (rule: Record<string, unknown>, triggerEvent: unknown, overrides: Partial<AutomationExecution> = {}): AutomationExecution => ({
  id: 'axe_orig', ruleId: 'atr_1', triggeredBy: 'event', triggeredAt: new Date().toISOString(), status: 'failed',
  steps: [{ actionType: (rule.action_type as never), status: 'failed', error: 'synthetic' }],
  sheetId: SHEET, triggerEvent: wire(triggerEvent), ruleSnapshot: snapshotOf(rule) as never,
  ...overrides,
})

function makeService(options: { memberships?: Map<string, string[]> } = {}) {
  const memberships = options.memberships ?? new Map([[CREATOR, [TENANT]]])
  const rules = new Map<string, Record<string, unknown>>()
  const writes: Array<{ op: 'insert' | 'update'; values: Record<string, unknown> }> = []
  const executions = new Map<string, AutomationExecution>()
  /** every first-retry marker CAS issued (the one-shot claim on the lineage root). */
  const markerClaims: unknown[][] = []
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
    // a principal's active memberships (the run_finished / job save gates read the STORED creator's)
    if (/FROM user_orgs/i.test(sql)) {
      const tenants = memberships.get(String(params[0])) ?? []
      return { rows: tenants.map((org_id) => ({ org_id })), rowCount: tenants.length }
    }
    if (/FROM integration_stock_prep_project_target WHERE sheet_id = \$1/.test(sql)) {
      return params[0] === SHEET
        ? { rows: [{ sheet_id: SHEET, tenant_id: TENANT, project_no: 'P-1', status: 'active', object_id: 'obj_1' }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    // retryExecution's one-shot first-retry marker (claimFirstAutomationRetryAttempt)
    if (/first_retry_attempted_at/.test(sql)) {
      markerClaims.push(params)
      return { rows: [{ first_retry_attempt: true }], rowCount: 1 }
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
  // the retry lane's collaborators: the log read, the lineage approval check, the ledger sweep, the run itself
  vi.spyOn(service.logs, 'getById').mockImplementation(async (id: string) => executions.get(id) ?? null)
  const bridges = (service as unknown as { approvalBridgeService: { hasCreatedApprovalForAnyExecution: (ids: string[]) => Promise<boolean> } }).approvalBridgeService
  vi.spyOn(bridges, 'hasCreatedApprovalForAnyExecution').mockResolvedValue(false)
  ;(service as unknown as { kickAutomationRetryLedgerSweepIfDue: (nowMs: number) => void }).kickAutomationRetryLedgerSweepIfDue = () => undefined
  const retried = { id: 'axe_next', ruleId: 'atr_1', triggeredBy: 'event', triggeredAt: new Date().toISOString(), status: 'success', steps: [] } as AutomationExecution
  const executeRule = vi.spyOn(service, 'executeRule').mockResolvedValue(retried)
  const stored = () => JSON.stringify(rules.get('atr_1'))
  return { service, rules, writes, seed, patch, stored, executions, markerClaims, executeRule, retried }
}

type Harness = ReturnType<typeof makeService>
const refusalOf = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error as Error)

/** The retry was refused with exactly `expected`, values-free, and NOTHING ran: no marker CAS, no executeRule. */
async function expectRetryRefused(h: Harness, work: Promise<unknown>, expected: { status: number; code: string; message: string }, label = ''): Promise<void> {
  const result = await work
  expect(result, label).toEqual(expected)
  for (const needle of NEEDLES) expect((result as { message: string }).message, label).not.toContain(needle)
  expect(h.executeRule, `${label}: nothing may be sent`).not.toHaveBeenCalled()
  expect(h.markerClaims, `${label}: the one-shot first-retry marker must not be spent`).toEqual([])
}
/** The retry went through: executeRule once, with the CURRENT rule, the STORED event and the retrying actor. */
async function expectRetryRan(h: Harness, work: Promise<unknown>, actor: string, triggerEvent: unknown): Promise<void> {
  await expect(work).resolves.toEqual({ execution: h.retried })
  expect(h.executeRule).toHaveBeenCalledTimes(1)
  const [rule, event, meta] = h.executeRule.mock.calls[0]
  expect((rule as { id: string }).id).toBe('atr_1')
  expect(event).toEqual(wire(triggerEvent))
  expect(meta).toEqual({ rerunOfExecutionId: 'axe_orig', initiatedBy: actor, rootExecutionId: 'axe_orig' })
  expect(h.markerClaims).toHaveLength(1)
}
/** Every authority transaction went READ COMMITTED first and then ran the predicate on that same transaction. */
function expectEveryAuthorityReadCommitted(): void {
  expect(authority.transactions.length).toBeGreaterThan(0)
  for (const statements of authority.transactions) {
    expect(statements[0]).toBe(READ_COMMITTED)
    expect(statements.slice(1)).toEqual(['SELECT /* the live-authority predicate */ 1'])
  }
}
const triggerColumn = (values: Record<string, unknown>) => JSON.parse(String(values.trigger_config)) as Record<string, unknown>

let harnesses: Harness[] = []
const harness = (options: Parameters<typeof makeService>[0] = {}) => { const h = makeService(options); harnesses.push(h); return h }
/** A harness holding `rule` and a FAILED execution of it whose stored trigger event is `triggerEvent`. */
function retryHarness(rule: Record<string, unknown>, triggerEvent: unknown, overrides: Partial<AutomationExecution> = {}, snapshotRule: Record<string, unknown> = rule) {
  const h = harness()
  h.seed(rule)
  h.executions.set('axe_orig', storedExecution(snapshotRule, triggerEvent, overrides))
  return h
}

beforeEach(() => {
  vi.stubEnv(ACTION_FLAG, 'true')
  vi.stubEnv(EVENT_FLAG, 'true')
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
  authority.poolDown = false
  authority.asked = []
  authority.transactions = []
})
afterEach(() => {
  for (const h of harnesses) for (const id of h.rules.keys()) h.service.unregisterSchedule(id)
  harnesses = []
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('R1 — an admin retry of an integration.run_finished execution re-runs the dispatch checks, then judges the retrying actor', () => {
  it.each<[label: string, value: string | undefined]>([
    ['unset', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['TRUE (case)', 'TRUE'],
    ['padded', ' true'],
    ['1', '1'],
  ])('(a) INTEGRATION_AUTOMATION_RUN_EVENT_ENABLED %s → refused, re-read on the retry itself; no authority read', async (label, value) => {
    const h = retryHarness(storedAlertRule(), RF_TRIGGER_EVENT)
    // (beforeEach stubbed it 'true', so unstubAllEnvs restores the original whichever way it is changed here)
    if (value === undefined) delete process.env[EVENT_FLAG]
    else vi.stubEnv(EVENT_FLAG, value)
    await expectRetryRefused(h, h.service.retryExecution('axe_orig', EDITOR_OK), RF_DISABLED, label)
    expect(authority.asked).toEqual([])
  })

  it.each<[label: string, mutate: () => void]>([
    ['deactivated / no longer an automation-capable member (the predicate says principal_unauthorized)', () => { authority.grants.delete(CREATOR) }],
    ['lost the integration read code (still a member able to manage automation)', () => { authority.grants.get(CREATOR)!.permissions = ['workflow:write'] }],
    ['whose authority read fails (authority_unavailable)', () => { authority.unavailable.add(CREATOR) }],
    ['whose authority read throws', () => { authority.throws.add(CREATOR) }],
  ])('(b) the bound creator %s → refused before the actor is read', async (label, mutate) => {
    const h = retryHarness(storedAlertRule(), RF_TRIGGER_EVENT)
    mutate()
    await expectRetryRefused(h, h.service.retryExecution('axe_orig', EDITOR_OK), RF_CREATOR_REFUSED, label)
    // the creator, in the tenant the original run was dispatched for — never the actor
    expect(authority.asked).toEqual([BINDING])
  })

  it('(b) the creator check runs on a committed READ COMMITTED transaction; the pool being down is a refusal', async () => {
    const h = retryHarness(storedAlertRule(), RF_TRIGGER_EVENT)
    authority.poolDown = true
    await expectRetryRefused(h, h.service.retryExecution('axe_orig', EDITOR_OK), RF_CREATOR_REFUSED)
    expect(authority.asked).toEqual([])
  })

  it.each<[label: string, rule: Record<string, unknown>, snapshotRule?: Record<string, unknown>, overrides?: Partial<AutomationExecution>]>([
    ['the binding names ANOTHER principal than the stored creator', storedAlertRule({ trigger_config: { ...RF_STAMPED, binding: { principalId: EDITOR_OK, tenantId: TENANT } } })],
    ['the binding is gone from the stored trigger', storedAlertRule({ trigger_config: { job: { kind: 'stock_prep_pull' }, statuses: ['failed'] } })],
    ['the rule has no stored creator', storedAlertRule({ created_by: null })],
    ['the binding was re-stamped to ANOTHER tenant since the run', storedAlertRule({ trigger_config: { ...RF_STAMPED, binding: { principalId: CREATOR, tenantId: 'tenant_2' } } }), storedAlertRule()],
    ['the execution carries no rule snapshot (the run\'s tenant cannot be named)', storedAlertRule(), undefined, { ruleSnapshot: undefined }],
  ])('(b) %s → refused, nothing read', async (label, rule, snapshotRule, overrides) => {
    const h = retryHarness(rule, RF_TRIGGER_EVENT, overrides ?? {}, snapshotRule ?? rule)
    await expectRetryRefused(h, h.service.retryExecution('axe_orig', EDITOR_OK), RF_CREATOR_REFUSED, label)
    expect(authority.asked).toEqual([])
  })

  it.each<[label: string, actor: string]>([
    ['manages automation but holds NO integration read code (B1\'s job authority only)', EDITOR_PLAIN],
    ['holds the read code only in ANOTHER tenant', EDITOR_ELSEWHERE],
    ['is no member at all', NOBODY],
  ])('(c) a retrying admin who %s → refused: the predicate is asked about the ACTOR in the binding tenant', async (label, actor) => {
    const h = retryHarness(storedAlertRule(), RF_TRIGGER_EVENT)
    await expectRetryRefused(h, h.service.retryExecution('axe_orig', actor), RF_ACTOR_REFUSED, label)
    expect(authority.asked).toEqual([BINDING, { principalId: actor, tenantId: TENANT }])
    expectEveryAuthorityReadCommitted()
  })

  it.each<[label: string, actor: string]>([
    ['empty', ''],
    ['blank', '   '],
  ])('(c) a MISSING retrying actor (%s) → refused; the actor is never read', async (label, actor) => {
    const h = retryHarness(storedAlertRule(), RF_TRIGGER_EVENT)
    await expectRetryRefused(h, h.service.retryExecution('axe_orig', actor), RF_ACTOR_REFUSED, label)
    expect(authority.asked).toEqual([BINDING])
  })

  it('(c) the actor\'s authority read fails — authority_unavailable or a throw — refused (fail closed)', async () => {
    const h = retryHarness(storedAlertRule(), RF_TRIGGER_EVENT)
    authority.unavailable.add(EDITOR_OK)
    await expectRetryRefused(h, h.service.retryExecution('axe_orig', EDITOR_OK), RF_ACTOR_REFUSED, 'unavailable')
    authority.unavailable.clear()
    authority.throws.add(EDITOR_OK)
    await expectRetryRefused(h, h.service.retryExecution('axe_orig', EDITOR_OK), RF_ACTOR_REFUSED, 'throws')
  })

  it('the current rule and the stored event must agree: an ENABLED rule retyped away from run_finished, retried with the stored run → RULE_CHANGED', async () => {
    const h = retryHarness(storedPlainRule({ action_type: 'send_dingtalk_group_message' }), RF_TRIGGER_EVENT, {}, storedAlertRule())
    await expectRetryRefused(h, h.service.retryExecution('axe_orig', EDITOR_OK), RF_KIND_CHANGED)
    expect(authority.asked).toEqual([])
  })

  it('… and a rule retyped INTO run_finished, retried with an execution from before (no stored run) → RULE_CHANGED', async () => {
    const h = retryHarness(storedAlertRule(), SCHEDULE_TRIGGER_EVENT, {}, storedPlainRule())
    await expectRetryRefused(h, h.service.retryExecution('axe_orig', EDITOR_OK), RF_KIND_CHANGED)
    expect(authority.asked).toEqual([])
  })

  it('the switch is read before the kinds are compared (a retyped rule with the switch off is the switch refusal)', async () => {
    const h = retryHarness(storedPlainRule({ action_type: 'send_dingtalk_group_message' }), RF_TRIGGER_EVENT, {}, storedAlertRule())
    vi.stubEnv(EVENT_FLAG, 'false')
    await expectRetryRefused(h, h.service.retryExecution('axe_orig', EDITOR_OK), RF_DISABLED)
  })

  it('allowed: an admin WITH the read authority re-runs it — the creator then the actor, both in the binding tenant, READ COMMITTED', async () => {
    const h = retryHarness(storedAlertRule(), RF_TRIGGER_EVENT)
    await expectRetryRan(h, h.service.retryExecution('axe_orig', EDITOR_OK), EDITOR_OK, RF_TRIGGER_EVENT)
    expect(authority.asked).toEqual([BINDING, { principalId: EDITOR_OK, tenantId: TENANT }])
    expectEveryAuthorityReadCommitted()
  })

  it('allowed: an admin-role actor passes the same predicate (its admin branch) without a read code', async () => {
    const h = retryHarness(storedAlertRule(), RF_TRIGGER_EVENT)
    await expectRetryRan(h, h.service.retryExecution('axe_orig', EDITOR_ADMIN), EDITOR_ADMIN, RF_TRIGGER_EVENT)
    expect(authority.asked).toEqual([BINDING, { principalId: EDITOR_ADMIN, tenantId: TENANT }])
  })

  it('the existing retry gates still answer first: a DISABLED rule is RULE_MISSING_OR_DISABLED, nothing read', async () => {
    const h = retryHarness(storedAlertRule({ enabled: false }), RF_TRIGGER_EVENT)
    await expect(h.service.retryExecution('axe_orig', EDITOR_OK)).resolves.toMatchObject({ status: 409, code: 'RULE_MISSING_OR_DISABLED' })
    expect(authority.asked).toEqual([])
    expect(h.executeRule).not.toHaveBeenCalled()
  })
})

describe('R2 — an admin retry of a run_integration_job execution needs the retrying actor\'s own job authority (B1\'s predicate)', () => {
  it.each<[label: string, actor: string]>([
    ['is no member at all', NOBODY],
    ['holds the job authority only in ANOTHER tenant', EDITOR_ELSEWHERE],
  ])('(d) a retrying admin who %s → refused before any claim, lease or port call', async (label, actor) => {
    const h = retryHarness(storedJobRule(), SCHEDULE_TRIGGER_EVENT)
    await expectRetryRefused(h, h.service.retryExecution('axe_orig', actor), JOB_ACTOR_REFUSED, label)
    // the ACTOR, in the rule's stamped binding tenant — the creator is the executor's to check, not this gate's
    expect(authority.asked).toEqual([{ principalId: actor, tenantId: TENANT }])
    expectEveryAuthorityReadCommitted()
  })

  it.each<[label: string, actor: string]>([
    ['empty', ''],
    ['blank', '   '],
  ])('(d) a MISSING retrying actor (%s) → refused; nothing read', async (label, actor) => {
    const h = retryHarness(storedJobRule(), SCHEDULE_TRIGGER_EVENT)
    await expectRetryRefused(h, h.service.retryExecution('axe_orig', actor), JOB_ACTOR_REFUSED, label)
    expect(authority.asked).toEqual([])
  })

  it.each<[label: string, arrange: () => void]>([
    ['the predicate answers authority_unavailable', () => { authority.unavailable.add(EDITOR_OK) }],
    ['the read throws', () => { authority.throws.add(EDITOR_OK) }],
    ['the authority transaction cannot be opened', () => { authority.poolDown = true }],
  ])('(d) the actor\'s authority could not be checked — %s → refused (fail closed)', async (label, arrange) => {
    const h = retryHarness(storedJobRule(), SCHEDULE_TRIGGER_EVENT)
    arrange()
    await expectRetryRefused(h, h.service.retryExecution('axe_orig', EDITOR_OK), JOB_ACTOR_UNAVAILABLE, label)
  })

  it('(d) a stored job whose binding tenant cannot be read (no stamped binding) → refused as could-not-be-checked, nothing read', async () => {
    const h = retryHarness(storedJobRule({ action_config: JOB, actions: [{ type: 'run_integration_job', config: JOB }] }), SCHEDULE_TRIGGER_EVENT)
    await expectRetryRefused(h, h.service.retryExecution('axe_orig', EDITOR_OK), JOB_ACTOR_UNAVAILABLE)
    expect(authority.asked).toEqual([])
  })

  it('allowed: a retrying admin WITH the job authority (no integration read code needed) re-runs it — asked about the actor, READ COMMITTED', async () => {
    const h = retryHarness(storedJobRule(), SCHEDULE_TRIGGER_EVENT)
    await expectRetryRan(h, h.service.retryExecution('axe_orig', EDITOR_PLAIN), EDITOR_PLAIN, SCHEDULE_TRIGGER_EVENT)
    expect(authority.asked).toEqual([{ principalId: EDITOR_PLAIN, tenantId: TENANT }])
    expectEveryAuthorityReadCommitted()
  })
})

describe('the new retry gates judge only the two integration kinds', () => {
  it('a plain rule\'s retry is untouched: no authority read, an empty actor is not refused', async () => {
    const h = retryHarness(storedPlainRule({ action_type: 'send_dingtalk_group_message' }), SCHEDULE_TRIGGER_EVENT)
    await expectRetryRan(h, h.service.retryExecution('axe_orig', ''), '', SCHEDULE_TRIGGER_EVENT)
    expect(authority.asked).toEqual([])
  })
})

describe('R3 — switching an integration.run_finished rule OFF needs no creator authority; every other edit still runs the full gate', () => {
  it.each<[label: string, mutate: (memberships: Map<string, string[]>) => void]>([
    ['lost its read authority', () => { authority.grants.delete(CREATOR) }],
    ['lost its tenant membership', (memberships) => { memberships.set(CREATOR, []) }],
  ])('(e) the creator %s: PATCH { enabled: false } and setRuleEnabled(false) are saved, the trigger untouched, nothing read', async (label, mutate) => {
    const memberships = new Map([[CREATOR, [TENANT]]])
    const h = harness({ memberships })
    h.seed(storedAlertRule())
    mutate(memberships)
    expect((await h.patch({ enabled: false }, EDITOR_PLAIN))?.enabled, label).toBe(false)
    h.rules.get('atr_1')!.enabled = true
    expect((await h.service.setRuleEnabled('atr_1', SHEET, false, EDITOR_PLAIN))?.enabled, label).toBe(false)
    expect(h.writes).toHaveLength(2)
    for (const write of h.writes) expect(Object.keys(write.values).sort()).toEqual(['enabled', 'updated_at'])
    expect(h.rules.get('atr_1')!.trigger_config).toEqual(RF_STAMPED)
    expect(authority.asked).toEqual([])
  })

  it('(e) a rule that is already off can be switched off again; nothing read', async () => {
    const h = harness()
    h.seed(storedAlertRule({ enabled: false }))
    authority.grants.delete(CREATOR)
    expect((await h.patch({ enabled: false }, EDITOR_PLAIN))?.enabled).toBe(false)
    expect(authority.asked).toEqual([])
  })

  it.each<[label: string, body: Record<string, unknown>]>([
    ['enabled: false together with a rename', { enabled: false, name: 'renamed' }],
    ['enabled: false together with new statuses', { enabled: false, triggerConfig: { job: { kind: 'stock_prep_pull' }, statuses: ['held'] } }],
    ['enabled: true (switching it back on)', { enabled: true }],
    ['a rename', { name: 'renamed' }],
  ])('control: with the creator\'s authority gone, %s still runs the full gate and is refused by it', async (label, body) => {
    const h = harness()
    h.seed(storedAlertRule({ enabled: body.enabled === true ? false : true }))
    authority.grants.delete(CREATOR)
    const before = h.stored()
    const refusal = await refusalOf(h.patch(body, EDITOR_OK))
    expect(refusal, label).toBeInstanceOf(AutomationRuleValidationError)
    expect(refusal!.message, label).toMatch(RF_GATE_CREATOR_MESSAGE)
    expect(h.writes).toHaveLength(0)
    expect(h.stored()).toBe(before)
    expect(authority.asked).toEqual([BINDING])
  })

  it('control: a full edit of an ENABLED run_finished rule by an editor WITHOUT the read authority is still refused (the editor check, after the gate)', async () => {
    const h = harness()
    h.seed(storedAlertRule())
    const before = h.stored()
    const refusal = await refusalOf(h.patch({ triggerConfig: { job: { kind: 'stock_prep_pull' }, statuses: ['failed', 'skipped'] } }, EDITOR_PLAIN))
    expect((refusal as AutomationRuleValidationError).code, refusal?.message).toBe(RF_EDITOR_CODE)
    expect(h.writes).toHaveLength(0)
    expect(h.stored()).toBe(before)
    expect(authority.asked).toEqual([BINDING, { principalId: EDITOR_PLAIN, tenantId: TENANT }])
  })

  it('control: an edit that leaves the rule off still runs the gate and re-stamps the creator\'s binding', async () => {
    const h = harness()
    h.seed(storedAlertRule({ enabled: false }))
    expect(await h.patch({ triggerConfig: { job: { kind: 'stock_prep_pull' }, statuses: ['held'] } }, EDITOR_PLAIN)).not.toBeNull()
    expect(triggerColumn(h.writes[0].values)).toEqual({ job: { kind: 'stock_prep_pull' }, statuses: ['held'], binding: BINDING })
    expect(authority.asked).toEqual([BINDING])
  })
})

describe('finding 3 on run_integration_job rules — does not apply: switching a job rule off never reaches the job save gate', () => {
  it('the creator lost its tenant membership AND its job authority, the action switch is off: PATCH { enabled: false } and setRuleEnabled(false) are saved, nothing read', async () => {
    const memberships = new Map([[CREATOR, [] as string[]]])
    const h = harness({ memberships })
    h.seed(storedJobRule())
    authority.grants.delete(CREATOR)
    vi.stubEnv(ACTION_FLAG, 'false')
    expect((await h.patch({ enabled: false }, EDITOR_PLAIN))?.enabled).toBe(false)
    h.rules.get('atr_1')!.enabled = true
    expect((await h.service.setRuleEnabled('atr_1', SHEET, false, EDITOR_PLAIN))?.enabled).toBe(false)
    expect(h.writes).toHaveLength(2)
    for (const write of h.writes) expect(Object.keys(write.values).sort()).toEqual(['enabled', 'updated_at'])
    expect(authority.asked).toEqual([])
  })

  it('control: an action edit of that job rule still runs the job gate (the tenantless creator refuses it)', async () => {
    const memberships = new Map([[CREATOR, [] as string[]]])
    const h = harness({ memberships })
    h.seed(storedJobRule())
    const refusal = await refusalOf(h.patch({ actionConfig: JOB }, EDITOR_OK))
    expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
    expect(refusal!.message).toMatch(/need a creator bound to exactly one active tenant/)
    expect(h.writes).toHaveLength(0)
  })
})
