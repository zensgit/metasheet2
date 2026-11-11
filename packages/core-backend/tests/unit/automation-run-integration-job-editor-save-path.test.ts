/**
 * R-69 I6d — the SAVE PATH the rule editor really takes for `run_integration_job` (dry run only, default OFF; R-69 is
 * OPEN). Synthetic only: no plugin, no port implementation, no network, no real database.
 *
 * WHY THIS FILE EXISTS (I6a re-review finding H1, pre-existing since R-69 1b-ii): the editor ALWAYS posts the rule's
 * action list as `actions[]` and mirrors `actions[0]` into the legacy pair (apps/web/src/multitable/components/
 * MetaAutomationRuleEditor.vue buildPayload: `actions`, `actionType: actions[0].type`, `actionConfig:
 * actions[0].config`). The save gate decided "nested" by OBJECT IDENTITY against a list the service had already
 * copied (collectNestedAutomationActions → validateActionObject returns `{ type, config }`), so every `actions[]`
 * occurrence was refused as "must be a top-level action" — only a hand-written pair-only API body could save, and the
 * per-occurrence gate behind that refusal (closed config, binding stamp, the I6a rule-sheet guard) was unreachable
 * for the shape the executor actually runs (toExecutorRule: `actions` when non-empty, else the pair).
 *
 * WHAT IT DRIVES: the wire body the editor sends (JSON round-tripped — over HTTP `actionConfig` and
 * `actions[0].config` are DISTINCT objects), through the route's own exported chain (parseCreateRuleInput /
 * parseUpdateRuleInput → the three preflights → createRule / updateRule) on a small in-memory rule store. The
 * action config is built by the editor's own `buildRunIntegrationJobConfig`, imported LIVE across the package
 * boundary (the web module has no runtime import; precedent: automation-run-integration-job-web-parity.test.ts).
 *
 * WHAT "NESTED" MEANS (the rule this slice makes structural): the binding stamp and the per-occurrence gate cover the
 * legacy pair and the top level of `actions[]` only. An occurrence inside a branch container
 * (`config.branches[*].actions[*]`, `config.defaultBranch.actions[*]` — the two lists the executor dispatches branch
 * steps from) would run with whatever `binding` the client wrote. That binding's tenant also ROUTES the step's
 * integration.run_finished summaries (automation-executor.ts emitRunIntegrationJobSummaries), so the nested refusal
 * is what keeps Bridge 2's tenant routing server-derived. Refused by position, at any depth.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AutomationExecutor } from '../../src/multitable/automation-executor'
import type { IntegrationRunInput, IntegrationRunPort } from '../../src/core/integration-run-port'
import { EventBus } from '../../src/integration/events/event-bus'
import { collectRunIntegrationJobOccurrences, parsePersistedRunIntegrationJobConfig } from '../../src/multitable/automation-run-integration-job'
import { RUN_INTEGRATION_JOB_RULE_SHEET_SAVE_MESSAGES } from '../../src/multitable/automation-run-integration-job-rule-sheet'
import {
  AUTOMATION_RULE_CHANGED_DURING_SAVE_MESSAGE,
  AutomationRuleValidationError,
  AutomationService,
  RULE_WRITE_MAX_ATTEMPTS,
  parseCreateRuleInput,
  parseUpdateRuleInput,
  preflightAutomationConditionFields,
  preflightAutomationRuleUpdate,
  preflightAutomationWebhookTargets,
  preflightDingTalkAutomationCreate,
  toExecutorRule,
  type AutomationRule,
} from '../../src/multitable/automation-service'
import { STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV } from '../../src/multitable/stock-preparation-manual-rows-gate'
import { createFakeJobDb } from '../utils/run-integration-job-fake-db'
// LIVE import of the editor's config builder across the package boundary (relative path; apps/web is not a dependency).
// eslint-disable-next-line import/no-relative-packages
import { buildRunIntegrationJobConfig } from '../../../../apps/web/src/multitable/runIntegrationJobAuthoring'

const FLAG = 'INTEGRATION_AUTOMATION_RUN_ACTION_ENABLED'
const NESTED_MESSAGE = 'run_integration_job must be a top-level action (not inside a condition_branch / parallel_branch)'
const M = RUN_INTEGRATION_JOB_RULE_SHEET_SAVE_MESSAGES
const CREATOR = 'svc_user'
const SERVER_BINDING = { principalId: CREATOR, tenantId: 'tenant_1' }
const CLIENT_BINDING = { principalId: CREATOR, tenantId: 'tenant_foreign' }

type Action = { type: string; config: Record<string, unknown> }
type RegistryRow = { sheet_id: string; tenant_id: string; project_no: string; status: string; object_id: string }

/** The wire: what the server receives is a parsed JSON body — no object is shared between two positions. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** The action config the editor sends for one project (its own builder; 30 minutes is the editor's default). */
const editorJobConfig = (projectNosText: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...buildRunIntegrationJobConfig({ rijKind: 'stock_prep_pull', rijProjectNosText: projectNosText, rijTimeoutMinutes: 30 }),
  ...extra,
})
const rij = (projectNosText = 'P-1', extra: Record<string, unknown> = {}): Action => ({ type: 'run_integration_job', config: editorJobConfig(projectNosText, extra) })
const updateRecord = (): Action => ({ type: 'update_record', config: { fields: { fld_1: 'x' } } })

/**
 * MetaAutomationRuleEditor.vue buildPayload, for a rule whose action list is `actions`: the list itself, the legacy
 * pair mirrored from `actions[0]`, the trigger twice (flat + nested), and the execution mode (null unless a branch
 * action forces workflow_job_v1). Returned AS THE WIRE BODY.
 */
function editorBody(actions: Action[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const triggerConfig = { cron: '0 6 * * *', timezone: 'Asia/Shanghai' }
  const needsJobMode = actions.some((action) => action.type === 'condition_branch' || action.type === 'parallel_branch')
  return wire({
    name: 'Nightly pull',
    triggerType: 'schedule.cron',
    triggerConfig,
    trigger: { type: 'schedule.cron', config: triggerConfig },
    conditions: undefined,
    actions,
    actionType: actions[0]?.type ?? 'update_record',
    actionConfig: actions[0]?.config ?? {},
    executionMode: needsJobMode ? 'workflow_job_v1' : null,
    ...overrides,
  })
}

const emptyGroup = () => ({ conjunction: 'AND', conditions: [] })
/** A condition_branch whose `where` list carries the given actions (the other list carries an ordinary action). */
function conditionBranch(where: 'branches' | 'defaultBranch', nested: Action[]): Action {
  return {
    type: 'condition_branch',
    config: {
      branches: [{ key: 'b1', conditions: emptyGroup(), actions: where === 'branches' ? nested : [updateRecord()] }],
      defaultBranch: { key: 'otherwise', actions: where === 'defaultBranch' ? nested : [updateRecord()] },
    },
  }
}

const REGISTERED = (sheetId: string, tenantId: string, projectNo: string, status = 'active'): RegistryRow =>
  ({ sheet_id: sheetId, tenant_id: tenantId, project_no: projectNo, status, object_id: `obj_${sheetId}` })

const ORGS = /FROM user_orgs/i
const REGISTRY = /FROM integration_stock_prep_project_target WHERE sheet_id = \$1/
const JSON_COLUMNS = ['trigger_config', 'action_config', 'conditions', 'actions']

/**
 * AutomationService over an in-memory `automation_rules` store (the three Kysely shapes createRule / getRule /
 * updateRule issue) and a query function that answers the creator's memberships and the project-sheet registry. The
 * registry answers by EXACT match on each row's own `sheet_id` and returns the row as stored — never an echo of the
 * query parameter.
 *
 * `onRuleUpdate` (fix round 2, F1) stands for ANOTHER save landing between an updateRule attempt's read and its write:
 * it is called when the n-th UPDATE of this service is about to run, may change the store, and by answering `'lost'`
 * makes that UPDATE match no row — what the real statement's row-version predicate does then (the predicate itself
 * is proven on the real table: tests/integration/multitable-automation-run-integration-job-realdb.test.ts).
 */
function makeService(options: {
  orgRows?: Array<{ org_id: string }>
  registry?: RegistryRow[] | Error
  onRuleUpdate?: (nth: number, rules: Map<string, Record<string, unknown>>) => 'lost' | undefined
} = {}) {
  const orgRows = options.orgRows ?? [{ org_id: 'tenant_1' }]
  const registry = options.registry ?? [REGISTERED('sheet_1', 'tenant_1', 'P-1')]
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
        for (const row of hit) Object.assign(row, asStored(state.values ?? {}))
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
    if (ORGS.test(sql)) return { rows: orgRows, rowCount: orgRows.length }
    if (REGISTRY.test(sql)) {
      if (registry instanceof Error) throw registry
      const rows = registry.filter((row) => row.sheet_id === params[0])
      return { rows, rowCount: rows.length }
    }
    return { rows: [], rowCount: 0 }
  })
  const service = new AutomationService(new EventBus(), db as never, queryFn as never)
  const registryReads = () => queryFn.mock.calls.filter(([sql]) => REGISTRY.test(String(sql))).map(([, params]) => params)
  const tenantReads = () => queryFn.mock.calls.filter(([sql]) => ORGS.test(String(sql))).length

  /** POST /sheets/:sheetId/automations after authn/authz (routes/univer-meta.ts): the same four calls, in order. */
  const post = async (sheetId: string, body: Record<string, unknown>, userId: string = CREATOR): Promise<AutomationRule> => {
    const parsed = parseCreateRuleInput(body, userId)
    preflightAutomationWebhookTargets(parsed)
    const input = await preflightDingTalkAutomationCreate(queryFn as never, sheetId, parsed)
    await preflightAutomationConditionFields(queryFn as never, sheetId, input.conditions, input)
    return service.createRule(sheetId, input)
  }
  /** PATCH /sheets/:sheetId/automations/:ruleId after authn/authz: the same calls, in order. */
  const patch = async (sheetId: string, ruleId: string, body: Record<string, unknown>, userId: string): Promise<AutomationRule | null> => {
    const parsed = parseUpdateRuleInput(body)
    if (!parsed) throw new Error('test body carries no recognised field')
    const preflight = await preflightAutomationRuleUpdate(queryFn as never, sheetId, ruleId, parsed, service)
    if (!preflight) return null
    const effective = { ...preflight.input, actionType: preflight.effectiveActionType ?? preflight.input.actionType, actionConfig: preflight.effectiveActionConfig ?? preflight.input.actionConfig }
    preflightAutomationWebhookTargets(effective)
    await preflightAutomationConditionFields(queryFn as never, sheetId, preflight.input.conditions, effective)
    return service.updateRule(ruleId, sheetId, preflight.input, userId)
  }
  /** A row that is already in the table (it never went through the save gate): what an edit finds stored. */
  const seed = (row: Record<string, unknown>) => { rules.set(String(row.id), { enabled: true, name: 'stored', conditions: null, execution_mode: null, ...row }) }
  return { service, rules, writes, queryFn, registryReads, tenantReads, post, patch, seed }
}

const refusalOf = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error as Error)
/** The save must be REFUSED as a validation error; answers its message. A save that goes through is a plain red here. */
async function refusedWith(work: Promise<unknown>): Promise<string> {
  const refusal = await refusalOf(work)
  expect(refusal, 'the save must be refused, nothing written').toBeInstanceOf(AutomationRuleValidationError)
  return (refusal as Error).message
}
const actionsColumn = (values: Record<string, unknown>) => JSON.parse(String(values.actions)) as Action[]
const configColumn = (values: Record<string, unknown>) => JSON.parse(String(values.action_config)) as Record<string, unknown>
const stamped = (projectNo = 'P-1') => ({ job: { kind: 'stock_prep_pull', projectNos: [projectNo], applyMode: 'dry_run_only' }, timeoutMs: 30 * 60_000, binding: SERVER_BINDING })

beforeEach(() => {
  vi.stubEnv(FLAG, 'true')
  vi.stubEnv(STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV, 'true')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('run_integration_job occurrences are decided by POSITION, never by object identity (I6d, pure)', () => {
  const copy = (action: Action): Action => ({ type: action.type, config: action.config })

  it('a top-level actions[] occurrence is top-level even when the flattened list holds COPIES (the service always passes copies)', () => {
    const top = rij()
    const flattened = [copy(top)]
    expect(flattened[0]).not.toBe(top)
    expect(collectRunIntegrationJobOccurrences('run_integration_job', top.config, [top] as never, flattened as never)).toEqual({
      occurrences: [{ path: 'actionConfig', config: top.config }, { path: 'actions[0].config', config: top.config }],
      error: null,
    })
    expect(collectRunIntegrationJobOccurrences('update_record', {}, [updateRecord(), top] as never, [copy(updateRecord()), copy(top)] as never))
      .toEqual({ occurrences: [{ path: 'actions[1].config', config: top.config }], error: null })
  })

  it.each([
    ['actions[i] condition_branch, branches', 'update_record', {}, [conditionBranch('branches', [rij()])]],
    ['actions[i] condition_branch, defaultBranch', 'update_record', {}, [conditionBranch('defaultBranch', [rij()])]],
    ['actions[i] parallel_branch, branches', 'update_record', {}, [{ type: 'parallel_branch', config: { joinMode: 'all', branches: [{ key: 'a', actions: [rij()] }] } }]],
    ['the pair as a condition_branch, branches', 'condition_branch', conditionBranch('branches', [rij()]).config, null],
    ['the pair as a condition_branch, defaultBranch', 'condition_branch', conditionBranch('defaultBranch', [rij()]).config, null],
    ['two levels down (a branch inside a branch)', 'update_record', {}, [conditionBranch('branches', [conditionBranch('defaultBranch', [rij()])])]],
    ['a valid top-level occurrence beside a nested one', 'run_integration_job', rij().config, [rij(), conditionBranch('branches', [rij()])]],
    // The walk does not ask what TYPE carries the branch list (a superset of the two containers the executor
    // dispatches from): a list smuggled under any other action is refused all the same, at every level.
    ['an actions[i] that is NOT a branch container but carries a branch list', 'update_record', {}, [{ type: 'update_record', config: { fields: {}, branches: [{ key: 'b1', actions: [rij()] }] } }]],
    ['a pair that is NOT a branch container but carries a branch list', 'update_record', { fields: {}, defaultBranch: { key: 'otherwise', actions: [rij()] } }, null],
    ['a NESTED action that is not a branch container but carries a branch list', 'update_record', {}, [conditionBranch('branches', [{ type: 'update_record', config: { defaultBranch: { actions: [rij()] } } }])]],
  ])('the walk finds a nested occurrence WITHOUT any flattened list: %s', (_label, actionType, actionConfig, actions) => {
    // `allActions` is the top-level list itself (what the trigger-only edit passes): only the walk can see the nesting.
    const result = collectRunIntegrationJobOccurrences(actionType, actionConfig as never, actions as never, actions as never)
    expect(result.error).toBe(NESTED_MESSAGE)
    const none = collectRunIntegrationJobOccurrences(actionType, actionConfig as never, actions as never, null)
    expect(none.error).toBe(NESTED_MESSAGE)
  })

  it('the flattened-list tripwire: more occurrences in the service flattening than at the top level of actions[] is nested, wherever it sits', () => {
    // No branch container is visible in `actions` here — only the count of the flattening can tell.
    const top = rij()
    const somewhere = { type: 'update_record', config: {} } as Action
    expect(collectRunIntegrationJobOccurrences('update_record', {}, [somewhere, top] as never, [copy(rij()), copy(somewhere), copy(top)] as never).error).toBe(NESTED_MESSAGE)
    expect(collectRunIntegrationJobOccurrences('update_record', {}, [somewhere] as never, [copy(somewhere), copy(rij())] as never).error).toBe(NESTED_MESSAGE)
    // equal counts are not nested (the editor's shape), and an absent flattening leaves the walk in charge
    expect(collectRunIntegrationJobOccurrences('update_record', {}, [somewhere, top] as never, [copy(somewhere), copy(top)] as never).error).toBeNull()
    expect(collectRunIntegrationJobOccurrences('update_record', {}, [somewhere, top] as never, null).error).toBeNull()
  })

  it('branch lists that are not lists, and entries that are not actions, are ignored (nothing to run there)', () => {
    const odd = [{ type: 'condition_branch', config: { branches: 'x', defaultBranch: { actions: [null, 7, 'run_integration_job', { type: 'update_record' }] } } }]
    expect(collectRunIntegrationJobOccurrences('update_record', {}, odd as never, odd as never)).toEqual({ occurrences: [], error: null })
  })
})

describe('the editor wire shape through the real createRule (I6d)', () => {
  it('the job as the first action — actions[0] plus its mirrored pair — SAVES, and both persisted columns carry the server binding', async () => {
    const h = makeService()
    // The editor never sends a binding; a hand-edited body that does is dropped in BOTH positions.
    const body = editorBody([rij('P-1', { binding: CLIENT_BINDING })])
    expect(body.actionConfig).not.toBe((body.actions as Action[])[0].config)
    expect(body.actionConfig).toEqual((body.actions as Action[])[0].config)
    const saved = await h.post('sheet_1', body)

    expect(h.writes).toHaveLength(1)
    const row = h.writes[0].values
    expect(row.action_type).toBe('run_integration_job')
    expect(configColumn(row)).toEqual(stamped())
    expect(actionsColumn(row)).toEqual([{ type: 'run_integration_job', config: stamped() }])
    expect(JSON.stringify(row)).not.toContain('tenant_foreign')
    expect(row.created_by).toBe(CREATOR)
    // every occurrence is checked against the RULE sheet's registration (the pair and actions[0])
    expect(h.registryReads()).toEqual([['sheet_1'], ['sheet_1']])
    // what the executor runs is `actions`, and its config re-parses as the stamped shape
    const runnable = toExecutorRule(saved).actions
    expect(runnable).toHaveLength(1)
    expect(parsePersistedRunIntegrationJobConfig(runnable[0].config)).toEqual(stamped())
    h.service.unregisterSchedule(saved.id)
  })

  it('the job as a LATER action (the pair is another action) saves; only that actions[] entry is stamped', async () => {
    const h = makeService()
    const saved = await h.post('sheet_1', editorBody([updateRecord(), rij('P-1', { binding: CLIENT_BINDING })]))
    const row = h.writes[0].values
    expect(row.action_type).toBe('update_record')
    expect(configColumn(row)).toEqual(updateRecord().config)
    expect(actionsColumn(row)).toEqual([updateRecord(), { type: 'run_integration_job', config: stamped() }])
    expect(h.registryReads()).toEqual([['sheet_1']])
    expect(parsePersistedRunIntegrationJobConfig(toExecutorRule(saved).actions[1].config)).toEqual(stamped())
    h.service.unregisterSchedule(saved.id)
  })

  /**
   * The WHOLE stored rule through the real executor (`execute`, the scheduler's entry: legacy mode, a record-less
   * `_triggeredBy: 'schedule'` event) on the in-memory ledger model, with a port that answers at once.
   */
  async function runStoredRule(saved: AutomationRule) {
    vi.useFakeTimers()
    const ledger = createFakeJobDb()
    const calls: IntegrationRunInput[] = []
    const port: IntegrationRunPort = { run: async (input) => { await input.checkpoint(); calls.push(input); return { status: 'succeeded', reason: 'ready', canApply: true, counts: { add: 1 } } } }
    const executor = new AutomationExecutor({
      eventBus: new EventBus(),
      queryFn: ledger.query,
      transaction: ledger.transaction,
      integrationRunPort: () => port,
      trackIntegrationJobTask: () => undefined,
      resolveIntegrationRunPrincipal: async () => ({ ok: true, user: { id: CREATOR, permissions: ['workflow:write'], roles: [], role: 'user', tenantId: 'tenant_1' } }),
      integrationJobRuntime: { leaseTtlMs: 3_000, settleGraceMs: 500, shutdownSettleGraceMs: 300 },
    })
    const execution = await executor.execute(toExecutorRule(saved), { _triggeredBy: 'schedule' })
    return { execution, calls, ledger }
  }

  it('the saved editor shape RUNS: the executor takes the stored rule — its actions[0] — to the port exactly once, for the one project', async () => {
    const h = makeService()
    const saved = await h.post('sheet_1', editorBody([rij()]))
    h.service.unregisterSchedule(saved.id)
    const { execution, calls, ledger } = await runStoredRule(saved)
    expect(execution.status).toBe('success')
    expect(execution.steps.map((step) => [step.actionType, step.status])).toEqual([['run_integration_job', 'success']])
    expect(execution.steps[0].output).toMatchObject({ outcome: 'succeeded', reason: 'ready' })
    expect(calls).toHaveLength(1)
    expect(calls[0].job).toEqual({ kind: 'stock_prep_pull', projectNo: 'P-1' })
    expect(calls[0].context.authenticatedTenantId).toBe('tenant_1')
    expect(ledger.intentRows().map(([, row]) => row.status)).toEqual(['sent'])
  })

  it('as a LATER action it runs too: step 0 is the other action, step 1 is the job — once, under its own step position', async () => {
    const h = makeService()
    // record_click is the executor's inert action: a record-less schedule can run it, so step 1 is reached.
    const saved = await h.post('sheet_1', editorBody([{ type: 'record_click', config: {} }, rij()]))
    h.service.unregisterSchedule(saved.id)
    expect(actionsColumn(h.writes[0].values)).toEqual([{ type: 'record_click', config: {} }, { type: 'run_integration_job', config: stamped() }])
    const { execution, calls, ledger } = await runStoredRule(saved)
    expect(execution.status).toBe('success')
    expect(execution.steps.map((step) => [step.actionType, step.status])).toEqual([['record_click', 'success'], ['run_integration_job', 'success']])
    expect(calls).toHaveLength(1)
    expect(calls[0].job).toEqual({ kind: 'stock_prep_pull', projectNo: 'P-1' })
    // one intent row, keyed by the step's structural path: position 1, not 0
    const intents = ledger.intentRows()
    expect(intents.map(([, row]) => row.status)).toEqual(['sent'])
    expect(intents[0][0]).toContain(JSON.stringify(['1', 'run_integration_job']).slice(0, -1))
  })

  it.each([
    ['actions[1] is a condition_branch whose branch carries the job', () => editorBody([updateRecord(), conditionBranch('branches', [rij()])])],
    ['actions[1] is a condition_branch whose DEFAULT branch carries the job', () => editorBody([updateRecord(), conditionBranch('defaultBranch', [rij()])])],
    ['the pair alone is a condition_branch whose branch carries the job (no actions[])', () => editorBody([conditionBranch('branches', [rij()])], { actions: null })],
    ['the pair alone is a condition_branch whose DEFAULT branch carries the job (no actions[])', () => editorBody([conditionBranch('defaultBranch', [rij()])], { actions: null })],
    ['a VALID top-level job at actions[0] and a nested one inside actions[1]', () => editorBody([rij(), conditionBranch('branches', [rij()])])],
    ['a nested job that brings its OWN binding (another tenant)', () => editorBody([updateRecord(), conditionBranch('defaultBranch', [rij('P-1', { binding: CLIENT_BINDING })])])],
    // Not a branch container, so the service's flattening does not see it: only the position walk refuses this one.
    ['a branch list smuggled under an action that is NOT a branch container (actions[0])', () => editorBody([{ type: 'update_record', config: { fields: { fld_1: 'x' }, defaultBranch: { key: 'otherwise', actions: [rij('P-1', { binding: CLIENT_BINDING })] } } }])],
    // …and under a LATER action: the pair mirrors actions[0], which is clean, so only the walk of actions[1] sees it.
    ['a branch list smuggled under a LATER action that is NOT a branch container (actions[1])', () => editorBody([updateRecord(), { type: 'update_record', config: { fields: { fld_1: 'y' }, defaultBranch: { key: 'otherwise', actions: [rij('P-1', { binding: CLIENT_BINDING })] } } }])],
    ['a branch list smuggled under a pair that is NOT a branch container (no actions[])', () => editorBody([{ type: 'update_record', config: { fields: { fld_1: 'x' }, branches: [{ key: 'b1', actions: [rij('P-1', { binding: CLIENT_BINDING })] }] } }], { actions: null })],
  ])('a genuinely NESTED occurrence is refused — %s — with the fixed message, before any tenant or registry read, and nothing is written', async (_label, build) => {
    const h = makeService()
    const refusal = await refusalOf(h.post('sheet_1', build()))
    expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
    expect(refusal!.message).toBe(NESTED_MESSAGE)
    expect(h.writes).toHaveLength(0)
    expect(h.rules.size).toBe(0)
    expect(h.tenantReads()).toBe(0)
    expect(h.registryReads()).toEqual([])
  })

  it('inside a parallel_branch the job is still refused (by the branch allow-list, before this gate) and nothing is written', async () => {
    const h = makeService()
    const parallel: Action = { type: 'parallel_branch', config: { joinMode: 'all', branches: [{ key: 'a', actions: [rij()] }] } }
    const refusal = await refusalOf(h.post('sheet_1', editorBody([updateRecord(), parallel])))
    expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
    expect(refusal!.message).toMatch(/cannot contain run_integration_job/)
    expect(h.writes).toHaveLength(0)
  })

  // ── every occurrence passes the FULL gate: the executor runs `actions[]`, not the pair ──────────────────────────
  const projectOf = (projectNo: string) => ({ job: { kind: 'stock_prep_pull', projectNos: [projectNo], applyMode: 'dry_run_only' }, timeoutMs: 30 * 60_000 })

  it.each([
    ['an unregistered sheet', 'sheet_9', [REGISTERED('sheet_1', 'tenant_1', 'P-1')], M.unregistered],
    ["another tenant's registered sheet", 'sheet_2', [REGISTERED('sheet_2', 'tenant_2', 'P-1')], M.tenant_mismatch],
    ['an archived sheet', 'sheet_1', [REGISTERED('sheet_1', 'tenant_1', 'P-1', 'archived')], M.unregistered],
    ["a project that is not the sheet's", 'sheet_1', [REGISTERED('sheet_1', 'tenant_1', 'P-OTHER')], M.project_mismatch],
  ])('the editor shape on %s is refused by the I6a rule-sheet guard (values-free), nothing written', async (_label, sheetId, registry, message) => {
    const h = makeService({ registry })
    const refusal = await refusalOf(h.post(sheetId, editorBody([rij()])))
    expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
    expect(refusal!.message).toBe(message)
    expect(h.writes).toHaveLength(0)
    for (const needle of ['sheet_', 'tenant_', 'P-1', 'P-OTHER']) expect(refusal!.message).not.toContain(needle)
  })

  it('the editor shape with two projects is refused (exactly one project per rule), also when the first is the sheet\'s', async () => {
    const h = makeService()
    expect(await refusedWith(h.post('sheet_1', editorBody([rij('P-1\nP-2')])))).toBe(M.project_mismatch)
    expect(h.writes).toHaveLength(0)
  })

  it('the job ONLY at actions[1] (no pair occurrence) is still held to the guard: a wrong project, an unregistered sheet', async () => {
    const wrongProject = makeService()
    expect(await refusedWith(wrongProject.post('sheet_1', editorBody([updateRecord(), rij('P-2')])))).toBe(M.project_mismatch)
    const unregistered = makeService()
    expect(await refusedWith(unregistered.post('sheet_9', editorBody([updateRecord(), rij()])))).toBe(M.unregistered)
    expect(wrongProject.writes.length + unregistered.writes.length).toBe(0)
    expect(wrongProject.registryReads()).toEqual([['sheet_1']])
  })

  it('a VALID pair does not vouch for actions[0]: a wrong project, or a widened config, in actions[0] is refused by its own path', async () => {
    // The pair lists the sheet's project; actions[0] — the one the executor runs — does not.
    const project = makeService()
    const projectBody = wire({ ...editorBody([rij('P-2')]), actionConfig: projectOf('P-1') })
    expect(await refusedWith(project.post('sheet_1', projectBody))).toBe(M.project_mismatch)
    expect(project.registryReads()).toEqual([['sheet_1'], ['sheet_1']])
    for (const [widened, message] of [
      [{ job: { kind: 'stock_prep_pull', projectNos: ['P-1'], applyMode: 'apply_when_ready' } }, /^actions\[0\]\.config\.job\.applyMode 'apply_when_ready' is not accepted/],
      [{ ...projectOf('P-1'), retry: { maxAttempts: 2, backoffMs: 60_000 } }, /^actions\[0\]\.config\.retry is reserved/],
      [{ ...projectOf('P-1'), timeoutMs: 55 * 60_000 + 1 }, /^actions\[0\]\.config\.timeoutMs must be at most 3300000/],
      [{ job: { kind: 'pipeline', pipelineId: 'p', dryRun: true } }, /^actions\[0\]\.config\.job\.kind 'pipeline' is not deliverable/],
    ] as const) {
      const h = makeService()
      const body = wire({ ...editorBody([{ type: 'run_integration_job', config: widened as Record<string, unknown> }]), actionConfig: projectOf('P-1') })
      const refusal = await refusalOf(h.post('sheet_1', body))
      expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
      expect(refusal!.message).toMatch(message)
      expect(h.writes).toHaveLength(0)
      expect(project.writes).toHaveLength(0)
    }
  })

  it('and a valid actions[0] does not vouch for the pair: a widened pair is refused by ITS path', async () => {
    const h = makeService()
    const body = wire({ ...editorBody([rij()]), actionConfig: { job: { kind: 'stock_prep_pull', projectNos: ['P-1'], applyMode: 'apply_when_ready' } } })
    expect(await refusedWith(h.post('sheet_1', body))).toMatch(/^actionConfig\.job\.applyMode 'apply_when_ready' is not accepted/)
    expect(h.writes).toHaveLength(0)
  })

  it('the rest of the gate holds for the editor shape: the action switch, the project-sheets switch, an unreadable registry, the trigger coupling, the single tenant', async () => {
    vi.stubEnv(FLAG, 'TRUE')
    const off = makeService()
    expect(await refusalOf(off.post('sheet_1', editorBody([rij()])))).toMatchObject({ code: 'RUN_ACTION_DISABLED' })
    expect(off.tenantReads()).toBe(0)
    vi.stubEnv(FLAG, 'true')

    vi.stubEnv(STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV, '1')
    const sheetsOff = makeService()
    expect(await refusedWith(sheetsOff.post('sheet_1', editorBody([rij()])))).toBe(M.switch_off)
    expect(sheetsOff.registryReads()).toEqual([])
    vi.stubEnv(STOCK_PREP_PROJECT_SHEETS_ENABLED_ENV, 'true')

    const unreadable = makeService({ registry: Object.assign(new Error('boom'), { code: '57P01' }) })
    expect(await refusedWith(unreadable.post('sheet_1', editorBody([rij()])))).toBe(M.unreadable)

    const interval = makeService()
    expect(await refusedWith(interval.post('sheet_1', editorBody([rij()], { triggerType: 'schedule.interval', triggerConfig: { intervalMs: 900_000 } }))))
      .toMatch(/only allowed on a schedule.cron trigger/)
    const noZone = makeService()
    expect(await refusedWith(noZone.post('sheet_1', editorBody([rij()], { triggerConfig: { cron: '0 6 * * *' } }))))
      .toMatch(/must declare triggerConfig.timezone/)

    const tenantless = makeService({ orgRows: [] })
    expect(await refusedWith(tenantless.post('sheet_1', editorBody([rij()])))).toMatch(/exactly one active tenant \(none found\)/)
    const twoTenants = makeService({ orgRows: [{ org_id: 'tenant_1' }, { org_id: 'tenant_2' }] })
    expect(await refusedWith(twoTenants.post('sheet_1', editorBody([rij()])))).toMatch(/several found/)

    for (const h of [off, sheetsOff, unreadable, interval, noZone, tenantless, twoTenants]) expect(h.writes).toHaveLength(0)
  })
})

describe('the editor wire shape through the real updateRule (I6d)', () => {
  /** What createRule stored for the editor shape (both columns stamped), found by a later edit. */
  const storedEditorRule = (overrides: Record<string, unknown> = {}) => ({
    id: 'atr_1', sheet_id: 'sheet_1', created_by: CREATOR,
    trigger_type: 'schedule.cron', trigger_config: { cron: '0 6 * * *', timezone: 'Asia/Shanghai' },
    action_type: 'run_integration_job', action_config: stamped(), actions: [{ type: 'run_integration_job', config: stamped() }],
    ...overrides,
  })

  it('an edit by ANOTHER person re-saves the editor shape: both columns re-stamped from the STORED creator, the editor\'s binding dropped', async () => {
    const h = makeService()
    h.seed(storedEditorRule())
    const body = editorBody([rij('P-1', { binding: { principalId: 'editor_2', tenantId: 'tenant_foreign' }, timeoutMs: 20 * 60_000 })], { name: 'Nightly pull (renamed)' })
    const updated = await h.patch('sheet_1', 'atr_1', body, 'editor_2')

    expect(updated).not.toBeNull()
    expect(h.writes).toHaveLength(1)
    const set = h.writes[0].values
    const expected = { ...stamped(), timeoutMs: 20 * 60_000 }
    expect(set.name).toBe('Nightly pull (renamed)')
    expect(configColumn(set)).toEqual(expected)
    expect(actionsColumn(set)).toEqual([{ type: 'run_integration_job', config: expected }])
    expect(JSON.stringify(set)).not.toContain('editor_2')
    expect(JSON.stringify(set)).not.toContain('tenant_foreign')
    expect(set.created_by).toBeUndefined()
    expect(parsePersistedRunIntegrationJobConfig(toExecutorRule(updated as AutomationRule).actions[0].config)).toEqual(expected)
    // the guard ran on the rule's STORED sheet for both occurrences
    expect(h.registryReads()).toEqual([['sheet_1'], ['sheet_1']])
    h.service.unregisterSchedule('atr_1')
  })

  it('an edit that MOVES the job into a branch is refused with the fixed message; the stored row is untouched', async () => {
    const h = makeService()
    h.seed(storedEditorRule())
    const before = JSON.stringify(h.rules.get('atr_1'))
    for (const where of ['branches', 'defaultBranch'] as const) {
      const refusal = await refusalOf(h.patch('sheet_1', 'atr_1', editorBody([updateRecord(), conditionBranch(where, [rij('P-1', { binding: CLIENT_BINDING })])]), 'editor_2'))
      expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
      expect(refusal!.message).toBe(NESTED_MESSAGE)
    }
    expect(h.writes).toHaveLength(0)
    expect(JSON.stringify(h.rules.get('atr_1'))).toBe(before)
  })

  it('an edit that only replaces actions[] is still held to the guard: another project, two projects, a sheet archived since the save', async () => {
    const h = makeService()
    h.seed(storedEditorRule())
    expect(await refusedWith(h.patch('sheet_1', 'atr_1', wire({ actions: [rij('P-2')] }), 'editor_2'))).toBe(M.project_mismatch)
    expect(await refusedWith(h.patch('sheet_1', 'atr_1', wire({ actions: [rij('P-1\nP-2')] }), 'editor_2'))).toBe(M.project_mismatch)
    const archived = makeService({ registry: [REGISTERED('sheet_1', 'tenant_1', 'P-1', 'archived')] })
    archived.seed(storedEditorRule())
    expect(await refusedWith(archived.patch('sheet_1', 'atr_1', editorBody([rij()]), 'editor_2'))).toBe(M.unregistered)
    expect(h.writes.length + archived.writes.length).toBe(0)
  })

  it('a trigger-only edit sees the stored actions[] occurrence: dropping the timezone, or leaving cron, is refused', async () => {
    const h = makeService()
    h.seed(storedEditorRule({ action_type: 'update_record', action_config: updateRecord().config, actions: [updateRecord(), { type: 'run_integration_job', config: stamped() }] }))
    expect(await refusedWith(h.patch('sheet_1', 'atr_1', wire({ triggerConfig: { cron: '0 7 * * *' } }), 'editor_2')))
      .toMatch(/must declare triggerConfig.timezone/)
    expect(await refusedWith(h.patch('sheet_1', 'atr_1', wire({ triggerType: 'schedule.interval', triggerConfig: { intervalMs: 900_000 } }), 'editor_2')))
      .toMatch(/only allowed on a schedule.cron trigger/)
    expect(h.writes).toHaveLength(0)
  })

  it('a trigger-only edit of a row that carries a NESTED occurrence (never saveable; a hand-written row) is refused by the walk alone', async () => {
    const h = makeService()
    h.seed(storedEditorRule({
      action_type: 'update_record', action_config: updateRecord().config, execution_mode: 'workflow_job_v1',
      actions: [updateRecord(), conditionBranch('defaultBranch', [{ type: 'run_integration_job', config: { ...stamped(), binding: CLIENT_BINDING } }])],
    }))
    const refusal = await refusalOf(h.patch('sheet_1', 'atr_1', wire({ triggerConfig: { cron: '0 7 * * *', timezone: 'Asia/Shanghai' } }), 'editor_2'))
    expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
    expect(refusal!.message).toBe(NESTED_MESSAGE)
    expect(h.writes).toHaveLength(0)
  })
})

// ── fix round 2 (F1): a write whose stored row changed under it ─────────────────────────────────────────────────
//
// updateRule binds its UPDATE to the row version it validated. A write that matches no row at that version has
// written nothing, and the whole save is validated again on the row as it now is. These cases drive that loop on the
// in-memory store (the n-th UPDATE "loses": see makeService). That the REAL statement loses exactly when the row
// changed — and only then — is proven on the real table, two backends, in the real-DB file's F1 block.
describe('updateRule — a write whose stored row changed under it is validated again, never written as it was (fix round 2, F1)', () => {
  /** A stored rule that carries no job: schedule.cron with a timezone, and an action no save gate looks at. */
  const storedPlainRule = () => ({
    id: 'atr_1', sheet_id: 'sheet_1', created_by: CREATOR,
    trigger_type: 'schedule.cron', trigger_config: { cron: '0 6 * * *', timezone: 'Asia/Shanghai' },
    action_type: 'record_click', action_config: {}, actions: null,
  })
  /** The other save, landing between this one's read and its write: the rule now carries the (stamped) job. */
  const otherSaveMakesItAJobRule = (nth: number, rules: Map<string, Record<string, unknown>>): 'lost' | undefined => {
    if (nth !== 1) return undefined
    Object.assign(rules.get('atr_1')!, { action_type: 'run_integration_job', action_config: stamped() })
    return 'lost'
  }

  it('a trigger PATCH that lost to a save which made the rule a job rule is validated again and refused with the coupling message; nothing is written', async () => {
    const h = makeService({ onRuleUpdate: otherSaveMakesItAJobRule })
    h.seed(storedPlainRule())
    expect(await refusedWith(h.patch('sheet_1', 'atr_1', wire({ triggerType: 'record.created', triggerConfig: {} }), 'editor_2')))
      .toBe('run_integration_job (stock_prep_pull) is only allowed on a schedule.cron trigger (got record.created)')
    expect(h.writes).toHaveLength(0)
    expect(h.rules.get('atr_1')).toMatchObject({ trigger_type: 'schedule.cron', action_type: 'run_integration_job' })
  })

  it('a config PATCH that lost to the same save is validated again as the JOB config it has become, and written with the SERVER binding', async () => {
    const h = makeService({ onRuleUpdate: otherSaveMakesItAJobRule })
    h.seed(storedPlainRule())
    const updated = await h.patch('sheet_1', 'atr_1', wire({ actionConfig: editorJobConfig('P-1', { binding: CLIENT_BINDING, timeoutMs: 20 * 60_000 }) }), 'editor_2')
    expect(updated).not.toBeNull()
    expect(h.writes).toHaveLength(1)
    expect(configColumn(h.writes[0].values)).toEqual({ ...stamped(), timeoutMs: 20 * 60_000 })
    expect(JSON.stringify(h.rules.get('atr_1'))).not.toContain('tenant_foreign')
    h.service.unregisterSchedule('atr_1')
  })

  it('a save that loses every time is refused after the last attempt — VALIDATION_ERROR, one fixed values-free message — and has written nothing', async () => {
    let statements = 0
    const h = makeService({ onRuleUpdate: (nth) => { statements = nth; return 'lost' } })
    h.seed(storedPlainRule())
    const refusal = await refusalOf(h.patch('sheet_1', 'atr_1', wire({ name: 'renamed' }), 'editor_2'))
    expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
    expect((refusal as AutomationRuleValidationError).code).toBe('VALIDATION_ERROR')
    expect(refusal!.message).toBe(AUTOMATION_RULE_CHANGED_DURING_SAVE_MESSAGE)
    expect(RULE_WRITE_MAX_ATTEMPTS).toBe(3)
    expect(statements).toBe(RULE_WRITE_MAX_ATTEMPTS)
    expect(h.writes).toHaveLength(0)
    expect(h.rules.get('atr_1')!.name).toBe('stored')
    for (const needle of ['atr_1', 'sheet_1', CREATOR, 'tenant_', 'P-1']) expect(refusal!.message).not.toContain(needle)
  })

  it.each([
    ['is GONE', (rules: Map<string, Record<string, unknown>>) => { rules.delete('atr_1') }],
    ['now sits on ANOTHER sheet', (rules: Map<string, Record<string, unknown>>) => { rules.get('atr_1')!.sheet_id = 'sheet_2' }],
  ])('a rule that %s when its write finds no row answers null (not found), from the next validation\'s first read', async (_label, change) => {
    let statements = 0
    const h = makeService({ onRuleUpdate: (nth, rules) => { statements = nth; change(rules); return 'lost' } })
    h.seed(storedPlainRule())
    expect(await h.patch('sheet_1', 'atr_1', wire({ name: 'renamed' }), 'editor_2')).toBeNull()
    expect(statements).toBe(1)
    expect(h.writes).toHaveLength(0)
  })

  it('a save that does not lose reads the rule as often as it did before the fix and sends ONE statement', async () => {
    for (const [body, reads] of [
      [{ name: 'renamed' }, 1],
      [{ actionConfig: {} }, 1],
      [{ actionConfig: {}, triggerConfig: { cron: '0 7 * * *', timezone: 'Asia/Shanghai' } }, 2],
    ] as const) {
      let statements = 0
      const h = makeService({ onRuleUpdate: (nth) => { statements = nth; return undefined } })
      h.seed(storedPlainRule())
      const getRule = vi.spyOn(h.service, 'getRule')
      // the service call itself (the route's own preflight read is not part of updateRule)
      expect(await h.service.updateRule('atr_1', 'sheet_1', wire(body) as never, 'editor_2')).not.toBeNull()
      expect(getRule).toHaveBeenCalledTimes(reads)
      expect(statements).toBe(1)
      expect(h.writes).toHaveLength(1)
      h.service.unregisterSchedule('atr_1')
    }
  })
})

// ── The I5 pointer of the I6a re-review, receive side (a pin, not a fix) ─────────────────────────────────────────
//
// "Can an integration.run_finished rule on sheet X receive another tenant's summaries?" The rule's tenant is ONLY
// `trigger_config.binding.tenantId`; dispatch selects on it (loader SQL + the in-loop compare with the route tenant)
// and then re-checks the creator's live membership in the route tenant. The rule's SHEET is not part of that — a
// sheet carries no tenant, and an alert rule is not tied to a project sheet. So what must hold at save is that no
// write shape can PLANT a binding: create stamps it (pinned in automation-integration-run-finished.test.ts) and EVERY
// update shape re-stamps it from the stored creator. The update half had no test; these cases are it.
describe('integration.run_finished: no edit can plant the trigger binding — every update shape re-stamps it from the stored creator (I6d pin)', () => {
  const ALERT_ACTION = { destinationIds: ['d1'], titleTemplate: '{{run.status}}', bodyTemplate: '{{run.job.projectNo}}' }
  /** A stored alert rule whose binding names ANOTHER tenant (a planted row: it never passed the save gate). */
  const plantedAlertRule = () => ({
    id: 'atr_rf', sheet_id: 'sheet_not_a_project_sheet', created_by: CREATOR,
    trigger_type: 'integration.run_finished', trigger_config: { job: { kind: 'stock_prep_pull' }, statuses: ['failed'], binding: CLIENT_BINDING },
    action_type: 'send_dingtalk_group_message', action_config: ALERT_ACTION, actions: null,
  })
  function alertService() {
    const h = makeService()
    h.service.setIntegrationRunFinishedCreatorResolverForTest(async () => ({ ok: true, user: { id: CREATOR, permissions: ['stock-prep:read', 'workflow:write'], roles: [], role: 'user', tenantId: 'tenant_1' } }))
    return h
  }

  it.each([
    ['a trigger edit whose body names another tenant', { triggerConfig: { job: { kind: 'stock_prep_pull' }, statuses: ['failed', 'skipped'], binding: { principalId: 'editor_2', tenantId: 'tenant_foreign' } } }],
    ['a rename', { name: 'renamed' }],
    ['an on/off switch', { enabled: false }],
    ['an action edit', { actionConfig: { ...ALERT_ACTION, titleTemplate: '{{run.reason}}' } }],
    ['an execution-mode edit', { executionMode: null }],
  ])('%s: the written trigger_config carries the creator\'s single tenant, never the planted or the posted one', async (_label, body) => {
    const h = alertService()
    h.seed(plantedAlertRule())
    const updated = await h.patch('sheet_not_a_project_sheet', 'atr_rf', wire(body), 'editor_2')
    expect(updated).not.toBeNull()
    expect(h.writes).toHaveLength(1)
    expect(typeof h.writes[0].values.trigger_config, 'every update shape writes the re-stamped trigger_config').toBe('string')
    const written = JSON.parse(String(h.writes[0].values.trigger_config)) as { binding: unknown; job: unknown }
    expect(written.binding).toEqual(SERVER_BINDING)
    expect(written.job).toEqual({ kind: 'stock_prep_pull' })
    expect(JSON.stringify(h.rules.get('atr_rf'))).not.toContain('tenant_foreign')
    expect(JSON.stringify(h.rules.get('atr_rf'))).not.toContain('editor_2')
  })

  it('and a creator who is no longer bound to exactly one tenant cannot be re-stamped at all: the edit is refused, the row untouched', async () => {
    const h = makeService({ orgRows: [] })
    h.service.setIntegrationRunFinishedCreatorResolverForTest(async () => ({ ok: true, user: { id: CREATOR, permissions: ['stock-prep:read', 'workflow:write'], roles: [], role: 'user', tenantId: 'tenant_1' } }))
    h.seed(plantedAlertRule())
    const refusal = await refusalOf(h.patch('sheet_not_a_project_sheet', 'atr_rf', wire({ name: 'renamed' }), 'editor_2'))
    expect(refusal).toBeInstanceOf(AutomationRuleValidationError)
    expect(refusal!.message).toMatch(/integration\.run_finished rules need a creator bound to exactly one active tenant/)
    expect(h.writes).toHaveLength(0)
  })
})
