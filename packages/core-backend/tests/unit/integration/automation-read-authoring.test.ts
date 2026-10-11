import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTOMATION_READ_ACTION_TYPE, AUTOMATION_READ_OPERATION } from '../../../src/integration/automation-read-operation-policy'
import { AUTOMATION_READ_AUTHORING_INVALID, AUTOMATION_READ_EXECUTION_UNAVAILABLE,
  containsAutomationReadAction, validAutomationReadAuthoringShape } from '../../../src/integration/automation-read-authoring-policy'
import { AutomationService, parseCreateRuleInput, parseUpdateRuleInput, serializeAutomationRule } from '../../../src/multitable/automation-service'
import { AutomationExecutor, type AutomationDeps, type AutomationRule as ExecutorRule } from '../../../src/multitable/automation-executor'
import type { AutomationAction } from '../../../src/multitable/automation-actions'
import { EventBus } from '../../../src/integration/events/event-bus'
import {
  AUTOMATION_READ_ACTION_TYPE as WEB_READ_ACTION_TYPE,
  AUTOMATION_READ_OPERATION as WEB_READ_OPERATION,
  AUTOMATION_READ_TRIGGER_TYPES as WEB_READ_TRIGGERS,
  automationReadAuthoringProblems,
  buildAutomationReadConfig,
  containsAutomationReadAction as webContainsReadAction,
} from '../../../../../apps/web/src/multitable/automationReadAuthoring'

const config = () => ({ operation: AUTOMATION_READ_OPERATION, allowManual: true })
const action = (): AutomationAction => ({ type: AUTOMATION_READ_ACTION_TYPE, config: config() })
const shape = () => ({ actionType: AUTOMATION_READ_ACTION_TYPE, actionConfig: config(),
  actions: null, executionMode: null, triggerType: 'record.created' })
const create = () => ({ triggerType: 'record.created', actionType: AUTOMATION_READ_ACTION_TYPE, actionConfig: config() })
const services: AutomationService[] = []
afterEach(() => { for (const service of services.splice(0)) service.shutdown(); vi.restoreAllMocks() })

function executorRule(actions: unknown): ExecutorRule {
  return { id: 'rule', sheetId: 'sheet', name: 'Synthetic', trigger: { type: 'record.created', config: {} },
    enabled: true, createdBy: 'owner', createdAt: '2026-10-01T00:00:00Z', actions: actions as AutomationAction[] }
}

function serviceFixture(overrides: Record<string, unknown> = {}) {
  const stored: Record<string, unknown> = { id: 'rule', sheet_id: 'sheet', name: 'Synthetic',
    trigger_type: 'record.created', trigger_config: {}, action_type: AUTOMATION_READ_ACTION_TYPE,
    action_config: config(), actions: null, execution_mode: null, conditions: null, enabled: false,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', created_by: 'owner', ...overrides }
  const writes: Record<string, unknown>[] = []
  const chain: Record<string, unknown> = {}
  for (const key of ['selectAll', 'where', 'orderBy', 'returningAll']) chain[key] = () => chain
  chain.executeTakeFirst = async () => stored
  chain.execute = async () => [stored]
  for (const key of ['values', 'set']) chain[key] = (row: Record<string, unknown>) => { writes.push(row); return chain }
  const db = { selectFrom: () => chain, insertInto: () => chain, updateTable: () => chain }
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
  const service = new AutomationService(new EventBus(), db as never, query)
  services.push(service)
  return { service, stored, writes, query }
}

describe('Automation read authoring policy: save-only, no authority or source calls', () => {
  it.each([null, [], [action()]])('accepts one logical action represented by %j', actions => {
    expect(validAutomationReadAuthoringShape({ ...shape(), actions })).toBe(true)
  })

  it.each([
    { actionConfig: {} }, { actionConfig: null }, { actionConfig: { ...config(), source: 'synthetic-private' } },
    { actionConfig: { operation: AUTOMATION_READ_OPERATION, allowManual: 'true' } },
    { actionConfig: { ...config(), operation: 'other' } }, { executionMode: 'workflow_job_v1' },
    { triggerType: 'field.changed' }, { triggerType: 'webhook.received' },
    { actions: [action(), action()] }, { actions: [{ ...action(), next: 'private' }] },
    { actions: [{ type: 'record_click', config: {} }] },
    { actions: [{ type: AUTOMATION_READ_ACTION_TYPE, config: { ...config(), allowManual: false } }] },
  ])('rejects the whole malformed read shape %#', patch => {
    expect(validAutomationReadAuthoringShape({ ...shape(), ...patch })).toBe(false)
  })

  it('rejects accessor and hidden config keys without invoking an accessor', () => {
    const getter = vi.fn(() => AUTOMATION_READ_OPERATION)
    const accessor = { allowManual: true }
    Object.defineProperty(accessor, 'operation', { enumerable: true, get: getter })
    expect(validAutomationReadAuthoringShape({ ...shape(), actionConfig: accessor })).toBe(false)
    expect(getter).not.toHaveBeenCalled()
    const hidden = config()
    Object.defineProperty(hidden, 'private', { value: 'synthetic' })
    expect(validAutomationReadAuthoringShape({ ...shape(), actionConfig: hidden })).toBe(false)
  })

  it.each(['condition_branch', 'parallel_branch'])('rejects read nested inside %s, including a masked legacy root', type => {
    const branch = { type, config: { branches: [{ key: 'a', actions: [action()] }] } }
    expect(validAutomationReadAuthoringShape({ ...shape(), actionType: type, actionConfig: branch.config,
      actions: [{ type: 'record_click', config: {} }] })).toBe(false)
    expect(validAutomationReadAuthoringShape({ ...shape(), actionType: 'record_click', actionConfig: {},
      actions: [branch] })).toBe(false)
  })

  it('does not interpret old free text and arbitrary nested data as action nodes', () => {
    const old = { actionType: 'update_record', actionConfig: { fields: { note: AUTOMATION_READ_ACTION_TYPE,
      object: { type: AUTOMATION_READ_ACTION_TYPE, config: config() } } }, actions: null,
    executionMode: null, triggerType: 'record.created' }
    expect(containsAutomationReadAction(old.actionType, old.actionConfig, old.actions)).toBe(false)
    expect(validAutomationReadAuthoringShape(old)).toBe(true)
  })

  it.each([null, false, 'synthetic-private', [], 1])('public parsers reject explicit malformed config %j', actionConfig => {
    expect(() => parseCreateRuleInput({ ...create(), actionConfig }, 'owner')).toThrow('actionConfig must be a plain object')
    expect(() => parseUpdateRuleInput({ name: 'rename', actionConfig })).toThrow('actionConfig must be a plain object')
  })

  it.each([false, 'synthetic-private', {}, 1])('public parsers reject malformed actions %j rather than clearing', actions => {
    expect(() => parseCreateRuleInput({ ...create(), actions }, 'owner')).toThrow('actions must be an array or null')
    expect(() => parseUpdateRuleInput({ name: 'rename', actions })).toThrow('actions must be an array or null')
  })

  it('keeps explicit empty config invalid instead of borrowing actions[0].config', () => {
    expect(() => parseCreateRuleInput({ ...create(), actionConfig: {}, actions: [action()] }, 'owner'))
      .toThrow(AUTOMATION_READ_AUTHORING_INVALID)
    const parsed = parseCreateRuleInput({ triggerType: 'record.created', actions: [action()] }, 'owner')
    expect(parsed.actionConfig).toEqual(config())
    expect(parseUpdateRuleInput({ actions: null })).toEqual({ actions: null })
  })

  it('saves the parser result through real service and exposes only the two public config keys', async () => {
    const fixture = serviceFixture()
    const saved = await fixture.service.createRule('sheet', parseCreateRuleInput(create(), 'owner'))
    expect(fixture.writes).toHaveLength(1)
    expect(JSON.parse(fixture.writes[0].action_config as string)).toEqual(config())
    expect(serializeAutomationRule(saved).actionConfig).toEqual(config())
    expect(fixture.query).not.toHaveBeenCalled()
  })

  it('direct service rejects raw extra fields before any insert or SQL', async () => {
    const fixture = serviceFixture()
    await expect(fixture.service.createRule('sheet', { ...create(), actionConfig: { ...config(), private: 'synthetic' } }))
      .rejects.toMatchObject({ code: AUTOMATION_READ_AUTHORING_INVALID })
    expect(fixture.writes).toEqual([])
    expect(fixture.query).not.toHaveBeenCalled()
  })

  it.each([{ name: 'rename' }, { enabled: true }, { conditions: null }, { triggerConfig: {} },
    { actionConfig: { ...config(), extra: 'private' } }, { triggerType: 'field.changed' }])(
    'every partial edit validates the full persisted read shape %#', async patch => {
      const fixture = serviceFixture({ action_config: { ...config(), private: 'synthetic' } })
      await expect(fixture.service.updateRule('rule', 'sheet', parseUpdateRuleInput(patch)!))
        .rejects.toMatchObject({ code: AUTOMATION_READ_AUTHORING_INVALID })
      expect(fixture.writes).toEqual([])
    })
})

describe('Ordinary executor refuses read-preview without conditions, jobs, action or source IO', () => {
  it.each(['live', 'simulate'] as const)('refuses %s before all injected IO and omits raw material', async dispatchMode => {
    const deps = { eventBus: new EventBus(), queryFn: vi.fn(), transaction: vi.fn(), fetchFn: vi.fn(),
      notificationService: { send: vi.fn() }, loadConditionFields: vi.fn() } as unknown as AutomationDeps
    const executor = new AutomationExecutor(deps)
    const rule = { id: 'rule', sheetId: 'sheet', name: 'Synthetic', trigger: { type: 'record.created', config: {} },
      enabled: true, createdBy: 'owner', createdAt: '2026-10-01T00:00:00Z',
      conditions: { conjunction: 'and', conditions: [] },
      actions: [action(), { type: 'send_webhook', config: { url: 'synthetic-private' } }] } as ExecutorRule
    const lifecycle = vi.fn()
    const result = await executor.execute(rule, { data: 'synthetic-private' }, lifecycle, undefined, dispatchMode)
    expect(lifecycle).not.toHaveBeenCalled()
    for (const io of [deps.queryFn, deps.transaction, deps.fetchFn, deps.notificationService!.send, deps.loadConditionFields]) {
      expect(io).not.toHaveBeenCalled()
    }
    expect(result).toMatchObject({ status: 'failed', error: AUTOMATION_READ_EXECUTION_UNAVAILABLE })
    expect(JSON.stringify(result)).not.toContain('synthetic-private')
    const single = await executor.runSingleAction(action(), { dispatchMode } as never)
    expect(single).toMatchObject({ status: 'failed', error: AUTOMATION_READ_EXECUTION_UNAVAILABLE })
    expect(deps.queryFn).not.toHaveBeenCalled()
  })

  it.each([
    { actions: [{ type: 'send_webhook', config: { url: 'synthetic-private' } }, action()] },
    { actions: [{ type: 'update_record', config: { fields: { label: 'must not write' } } }, action()] },
    { actions: [{ type: 'condition_branch', config: { branches: [], defaultBranch: { actions: [
      { type: 'parallel_branch', config: { branches: [{ actions: [action()] }] } },
    ] } } }] },
  ])('rejects a read node anywhere before an earlier business action or nested job can run %#', async ({ actions }) => {
    const queryFn = vi.fn(), fetchFn = vi.fn(), transaction = vi.fn(), lifecycle = vi.fn(), loadConditionFields = vi.fn()
    const executor = new AutomationExecutor({ eventBus: new EventBus(), queryFn, fetchFn, transaction, loadConditionFields })
    const rule = executorRule(actions)
    for (const dispatchMode of ['live', 'simulate'] as const) {
      const result = await executor.execute(rule, {}, lifecycle, undefined, dispatchMode)
      for (const io of [queryFn, fetchFn, transaction, lifecycle, loadConditionFields]) expect(io).not.toHaveBeenCalled()
      expect(result).toMatchObject({ status: 'failed', error: AUTOMATION_READ_EXECUTION_UNAVAILABLE })
    }
    for (const io of [queryFn, fetchFn, transaction, lifecycle, loadConditionFields]) expect(io).not.toHaveBeenCalled()
  })

  it('refuses both continuation entry points before settling jobs or reading conditions', async () => {
    const queryFn = vi.fn(), loadConditionFields = vi.fn(), onSettled = vi.fn(), onStart = vi.fn()
    const executor = new AutomationExecutor({ eventBus: new EventBus(), queryFn, loadConditionFields })
    const rule = executorRule([action()])
    const execution = { id: 'existing-execution', steps: [] } as never
    const lifecycle = { onSettled, onStart } as never
    expect(await executor.continueExecution(execution, rule, {} as never, 0, lifecycle))
      .toMatchObject({ status: 'failed', error: AUTOMATION_READ_EXECUTION_UNAVAILABLE })
    expect(await executor.continueBranchExecution(execution, rule, {} as never, {} as never, lifecycle))
      .toMatchObject({ status: 'failed', error: AUTOMATION_READ_EXECUTION_UNAVAILABLE })
    for (const io of [queryFn, loadConditionFields, onSettled, onStart]) expect(io).not.toHaveBeenCalled()
  })
})

describe('Actual web authoring policy and backend save contract agree', () => {
  const allowedTriggers = ['record.created', 'record.updated', 'record.deleted', 'field.value_changed',
    'schedule.cron', 'schedule.interval', 'schedule.date_field']

  it('uses the same fixed operation and seven supported trigger kinds, not a generic HTTP action', () => {
    expect(WEB_READ_ACTION_TYPE).toBe(AUTOMATION_READ_ACTION_TYPE)
    expect(WEB_READ_OPERATION).toBe(AUTOMATION_READ_OPERATION)
    expect([...WEB_READ_TRIGGERS].sort()).toEqual([...allowedTriggers].sort())
  })

  it('accepts the full public singleton representation matrix with explicit manual opt-in', () => {
    let compared = 0
    for (const triggerType of allowedTriggers) for (const executionMode of [undefined, null, 'legacy']) {
      for (const allowManual of [false, true]) {
        const actionConfig = { operation: AUTOMATION_READ_OPERATION, allowManual }
        for (const actions of [undefined, null, [], [{ type: AUTOMATION_READ_ACTION_TYPE, config: actionConfig }]]) {
          const candidate = { actionType: AUTOMATION_READ_ACTION_TYPE, actionConfig, actions, executionMode, triggerType }
          expect(validAutomationReadAuthoringShape(candidate)).toBe(true)
          expect(automationReadAuthoringProblems(candidate)).toEqual([])
          const publicConfig = buildAutomationReadConfig(actionConfig)
          expect(publicConfig).toEqual(actionConfig)
          expect(publicConfig).not.toBe(actionConfig)
          compared++
        }
      }
    }
    expect(compared).toBe(168)
  })

  it.each([
    { actionConfig: null }, { actionConfig: {} }, { actionConfig: { ...config(), operation: 'other' } },
    { actionConfig: { ...config(), allowManual: 'true' } }, { actionConfig: { ...config(), selector: {} } },
    { actionConfig: { ...config(), sql: 'synthetic-private' } },
    { executionMode: 'workflow_job_v1' }, { executionMode: '' }, { executionMode: false },
    { triggerType: 'form.submitted' }, { triggerType: 'webhook.received' }, { triggerType: 'approval.completed' },
    { triggerType: 'approval.task_created' }, { triggerType: 'field.changed' }, { triggerType: 'manual' },
    { actions: {} }, { actions: 'synthetic' }, { actions: [action(), action()] },
    { actions: [{ ...action(), next: 'synthetic' }] },
    { actions: [{ type: 'update_record', config: {} }] },
    { actions: [{ type: AUTOMATION_READ_ACTION_TYPE, config: { ...config(), allowManual: false } }] },
    { actions: [{ type: AUTOMATION_READ_ACTION_TYPE, config: { ...config(), private: true } }] },
    { actionType: 'update_record', actionConfig: {}, actions: [action()] },
  ])('refuses a malformed or mismatched public representation at both layers %#', patch => {
    const candidate = { ...shape(), ...patch }
    expect(validAutomationReadAuthoringShape(candidate)).toBe(false)
    expect(automationReadAuthoringProblems(candidate).length).toBeGreaterThan(0)
  })

  it.each(['condition_branch', 'parallel_branch'])('finds only executable %s paths, including a hidden legacy node', type => {
    const branchConfig = { branches: [{ actions: [action()] }], defaultBranch: { actions: [action()] } }
    for (const candidate of [
      { ...shape(), actionType: type, actionConfig: branchConfig, actions: [{ type: 'update_record', config: {} }] },
      { ...shape(), actionType: 'update_record', actionConfig: {}, actions: [{ type, config: branchConfig }] },
    ]) {
      expect(containsAutomationReadAction(candidate.actionType, candidate.actionConfig, candidate.actions)).toBe(true)
      expect(webContainsReadAction(candidate)).toBe(true)
      expect(validAutomationReadAuthoringShape(candidate)).toBe(false)
      expect(automationReadAuthoringProblems(candidate).length).toBeGreaterThan(0)
    }
  })

  it('does not treat business JSON or unrelated config fields as executable read nodes', () => {
    const candidate = { actionType: 'update_record', actionConfig: { fields: {
      note: { type: AUTOMATION_READ_ACTION_TYPE, config: config() },
      label: AUTOMATION_READ_ACTION_TYPE,
    }, branches: [{ actions: [action()] }] }, actions: null, executionMode: null, triggerType: 'record.created' }
    expect(containsAutomationReadAction(candidate.actionType, candidate.actionConfig, candidate.actions)).toBe(false)
    expect(webContainsReadAction(candidate)).toBe(false)
    expect(validAutomationReadAuthoringShape(candidate)).toBe(true)
    expect(automationReadAuthoringProblems(candidate)).toEqual([])
  })

  it('does not read config accessors and rejects hidden or symbol keys in both contracts', () => {
    const getter = vi.fn(() => AUTOMATION_READ_OPERATION)
    const accessor = Object.defineProperty({ allowManual: true }, 'operation', { enumerable: true, get: getter })
    const hidden = Object.defineProperty(config(), 'hidden', { value: 'synthetic' })
    const symbol = { ...config(), [Symbol('synthetic')]: 'private' }
    for (const actionConfig of [accessor, hidden, symbol]) {
      const candidate = { ...shape(), actionConfig }
      expect(validAutomationReadAuthoringShape(candidate)).toBe(false)
      expect(automationReadAuthoringProblems(candidate).length).toBeGreaterThan(0)
      expect(() => buildAutomationReadConfig(actionConfig)).toThrow()
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it('does not interpret a parallel branch unused default or UI-only draft property as a stored executable path', () => {
    for (const actionConfig of [
      { branches: [], defaultBranch: { actions: [action()] } },
      { branches: [], parallelBranches: [{ actions: [action()] }] },
      { branches: [], parallelBranchOriginal: { branches: [{ actions: [action()] }] } },
    ]) {
      const candidate = { ...shape(), actionType: 'parallel_branch', actionConfig }
      expect(containsAutomationReadAction(candidate.actionType, candidate.actionConfig, candidate.actions)).toBe(false)
      expect(webContainsReadAction(candidate)).toBe(false)
      expect(validAutomationReadAuthoringShape(candidate)).toBe(true)
      expect(automationReadAuthoringProblems(candidate)).toEqual([])
    }
  })
})
